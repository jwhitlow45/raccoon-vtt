import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import type { RoomState, Token } from "../shared/model.ts";
import type { Op } from "../shared/protocol.ts";
import { applyOp } from "../shared/reducer.ts";
import { DRAG_WORK, SLICE_WORK } from "../shared/rules/opportunity.ts";
import { placedOnHex } from "../shared/rules/footprint.ts";
import { gridOfShape } from "../shared/rules/grid.ts";
import type { HexGrid } from "../shared/rules/hex.ts";
import { actor, customMonster, DM, env, int, rng, room, scene, token } from "../shared/testutil.ts";
import { ROOT } from "./harness.ts";

/*
 * The phone benchmark (docs/design/design-v1-opportunity-attacks.md 5,
 * D-261128-065): the drag's scan and the leg jobs' slices, as the app
 * bundles them, timed in Chromium at 390 x 844 with the CPU throttled 6x as
 * a mid-range phone's stand-in. On the 30-goblin fight and on a dense
 * fixture of 200 hostile creatures with 10 ft reach round a 50-stop walk,
 * on squares and on hexes. Targets: a drag answer's scan at most 4 ms,
 * median of 20, and every slice at most 8 ms. It runs on demand, by the
 * lane, never in CI, whose runners' speed says nothing of a phone's.
 */

const THROTTLE = 6;
const DRAG_MEDIAN_MS = 4;
const SLICE_MS = 8;
const SKIP = process.env.CI ? "the phone benchmark runs on demand, not in CI" : false;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
const measured: string[] = [];

/** A fight to time: the room after its walk, with drags on from its end, and the room at the turn's start, with first drags that skip no one. */
type Fixture = { name: string; room: RoomState; targets: { x: number; y: number }[]; start: RoomState; firstTargets: { x: number; y: number }[] };

function run(state: RoomState, op: Op, seq: number): RoomState {
  const r = applyOp(state, op, DM, env(seq));
  if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
  return r.state;
}

/** Thorn on his turn in `state`, then walking `stops` (the turn's start counts as the first). */
function walked(state: RoomState, start: { x: number; y: number }, stops: { x: number; y: number }[]): RoomState {
  let s: RoomState = { ...state, tokens: { ...state.tokens, thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], disposition: "ally", ...start }) } };
  s = run(s, { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }] } as Op, 1);
  s = run(s, { t: "encounter.next" } as Op, 2);
  stops.forEach((to, i) => (s = run(s, { t: "token.move", tokenId: "thorn", x: to.x, y: to.y } as Op, 3 + i)));
  return s;
}

/** 30 goblins round a 120 ft walk of 4 legs: a real fight's size. */
function goblins(): Fixture {
  const r = rng(30);
  const tokens: Record<string, Token> = {};
  // Round the walk, which keeps between 4 and 16 on both axes.
  for (let i = 0; i < 30; i++) tokens[`g${i}`] = token(`g${i}`, { name: "Goblin", number: i + 1, x: int(r, 2, 19), y: int(r, 2, 19) });
  const base = room({ scenes: { s1: scene("s1", { bounds: { w: 34, h: 34 }, autoWalls: "off", blockMovement: false }) }, tokens });
  const state = walked(base, { x: 4, y: 4 }, [{ x: 10, y: 4 }, { x: 10, y: 10 }, { x: 16, y: 10 }, { x: 16, y: 16 }]);
  const ring = (c: { x: number; y: number }) => Array.from({ length: 20 }, (_, i) => ({ x: c.x + (i % 5) - 2, y: c.y + Math.floor(i / 5) - 2 }));
  return { name: "30 goblins, 4 legs", room: state, targets: Array.from({ length: 20 }, (_, i) => ({ x: 16 + (i % 5), y: 22 - Math.floor(i / 5) })), start: walked(base, { x: 10, y: 10 }, []), firstTargets: ring({ x: 14, y: 14 }) };
}

/** 200 hostile creatures with a 10 ft reach round a 50-stop walk, on squares or on hexes. */
function dense(shape: "square" | "hexRows"): Fixture {
  const r = rng(shape === "square" ? 200 : 201);
  const g = shape === "hexRows" ? (gridOfShape("hexRows") as HexGrid) : null;
  const at = (x: number, y: number) => (g ? placedOnHex(g, token("t", { x: 0, y: 0 }), { col: x, row: y }) : { x, y });
  const tokens: Record<string, Token> = {};
  for (let i = 0; i < 200; i++) tokens[`m${i}`] = token(`m${i}`, { name: "Pole Lurker", number: i + 1, ...at(int(r, 2, 41), int(r, 2, 41)), actor: { inline: actor({ monsterId: "pole" }) } });
  const monsters = { pole: customMonster("pole", { name: "Pole Lurker", size: "medium", actions: [{ name: "Glaive", text: "Melee Attack Roll: +5, reach 10 ft. Hit: 8 (1d10 + 3) Slashing damage." }] }) };
  const base = room({ scenes: { s1: scene("s1", { ...(g ? { gridShape: "hexRows" as const } : {}), bounds: { w: 44, h: 44 }, autoWalls: "off", blockMovement: false }) }, tokens, monsters });
  // A winding walk through the crowd, 49 legs of up to four cells each.
  const stops: { x: number; y: number }[] = [];
  let x = 20;
  let y = 20;
  for (let i = 0; i < 49; i++) {
    x = Math.max(3, Math.min(40, x + int(r, -4, 4)));
    y = Math.max(3, Math.min(40, y + int(r, -4, 4)));
    stops.push(at(x, y));
  }
  const state = walked(base, at(20, 20), stops);
  const last = stops[stops.length - 1]!;
  // First drags from the middle of the crowd out to six cells away: no earlier leg skips anyone.
  const firstTargets = Array.from({ length: 20 }, (_, i) => at(20 + [6, -6, 0, 0, 4][i % 5]!, 20 + [0, 0, 6, -6, 4][i % 5]! + Math.floor(i / 5) - 2));
  return { name: `200 creatures with 10 ft reach, a 50-stop walk, ${g ? "hexes" : "squares"}`, room: state, targets: Array.from({ length: 20 }, (_, i) => ({ x: Math.max(3, Math.min(40, last.x + (i % 5) - 2)), y: Math.max(3, Math.min(40, last.y + Math.floor(i / 5) - 2)) })), start: walked(base, at(20, 20), []), firstTargets };
}

const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const round = (ms: number) => Math.round(ms * 100) / 100;

describe("the Opportunity Attacks phone benchmark", { skip: SKIP, timeout: 600_000 }, () => {
  before(async () => {
    const bundle = await build({
      configFile: false,
      root: ROOT,
      logLevel: "silent",
      plugins: [react()],
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: { write: false, minify: true, lib: { entry: "client/features/combat/opportunity.bench.ts", formats: ["iife"], name: "RvttBench", fileName: "bench" } },
    });
    const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((b) => ("output" in b ? b.output : []));
    const code = outputs.find((o) => o.type === "chunk")?.code;
    assert.ok(code, "the bench bundle built");
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    page = await context.newPage();
    await page.setContent("<!doctype html><title>bench</title>");
    await page.addScriptTag({ content: code });
    cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  });

  after(async () => {
    await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await browser?.close();
    console.log(`\nOpportunity Attacks phone benchmark, ${THROTTLE}x CPU throttle at 390 x 844 (drag cap ${DRAG_WORK} units, slices of ${SLICE_WORK}):\n${measured.map((l) => `  ${l}`).join("\n")}`);
  });

  for (const make of [goblins, () => dense("square"), () => dense("hexRows")]) {
    const fixture = make();
    test(`${fixture.name}: a drag answer's scan within ${DRAG_MEDIAN_MS} ms median of 20, every slice within ${SLICE_MS} ms`, async () => {
      type Bench = { sliceTimes(room: unknown, viewer: unknown): { slices: number[] }; dragTimes(room: unknown, viewer: unknown, moverId: string, targets: unknown): { ms: number[]; said: string[] } };
      const slices = await page.evaluate(([room, viewer]) => (globalThis as unknown as { RvttBench: Bench }).RvttBench.sliceTimes(room, viewer).slices, [fixture.room, DM] as const);
      const warm = await page.evaluate(([room, viewer]) => (globalThis as unknown as { RvttBench: Bench }).RvttBench.sliceTimes(room, viewer).slices, [fixture.room, DM] as const);
      const drag = await page.evaluate(([room, viewer, targets]) => (globalThis as unknown as { RvttBench: Bench }).RvttBench.dragTimes(room, viewer, "thorn", targets), [fixture.room, DM, fixture.targets] as const);
      const first = await page.evaluate(([room, viewer, targets]) => (globalThis as unknown as { RvttBench: Bench }).RvttBench.dragTimes(room, viewer, "thorn", targets), [fixture.start, DM, fixture.firstTargets] as const);
      const dragMedian = Math.max(median(drag.ms), median(first.ms));
      const sliceMax = Math.max(0, ...slices);
      const lines = (said: readonly string[]) => [...new Set(said)].join(", ");
      measured.push(
        `${fixture.name}: drags on from the walk's end median ${round(median(drag.ms))} ms, max ${round(Math.max(...drag.ms))} ms (creatures named: ${lines(drag.said)}); the turn's first drags median ${round(median(first.ms))} ms, max ${round(Math.max(...first.ms))} ms (named: ${lines(first.said)}); ${slices.length} slices on a fresh scan, median ${round(median(slices))} ms, max ${round(sliceMax)} ms, and again warm, max ${round(Math.max(0, ...warm))} ms`,
      );
      assert.equal(drag.ms.length, 20);
      assert.ok(first.said.some((s) => s !== "none" && s !== "over"), "a first drag that names someone, so the scan is timed doing its work");
      assert.ok(slices.length >= (fixture.room.tokens.thorn?.path?.stops.length ?? 1) - 1, "a slice or more for each leg");
      assert.ok(dragMedian <= DRAG_MEDIAN_MS, `a drag answer's scan took ${round(dragMedian)} ms, median of 20, over ${DRAG_MEDIAN_MS} ms`);
      assert.ok(sliceMax <= SLICE_MS, `a slice took ${round(sliceMax)} ms, over ${SLICE_MS} ms: ${JSON.stringify(slices.map(round))}`);
    });
  }
});
