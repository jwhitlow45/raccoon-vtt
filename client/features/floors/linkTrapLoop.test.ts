import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { trap as makeTrap } from "#shared/testutil.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import { viewPill } from "../../canvas/relief/isoText.ts";
import type { Box } from "../../lib/boardText.ts";
import { isometric, type Turn } from "../../lib/view.ts";
import { pillInkReach } from "../measure/pillPlace.ts";
import { nameAnchor, outlineOf, placeEnds, type EndPills } from "./linkMarks.ts";

const { isoTrapNamePill, trapNamePill } = await import("../traps/TrapLayer.tsx");

before(() => {
  const context = { font: "", measureText: (text: string) => ({ width: text.length * 7 }) };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ getContext: () => context }) };
});

/*
 * In Isometric the layers read each other in one direction: token text keeps
 * off a floor link's pills, a trap's name keeps off token text, and so a link
 * pill that kept off the trap's nudged name would close a loop. A floor link
 * keeps off the name as trapNamePill places it instead.
 */

const SCALE = 40;
const meet = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

function hole(): EndPills {
  const o = outlineOf(SQUARES, { x: 8, y: 4, w: 2, h: 1 });
  const at = nameAnchor(o, "bottom");
  const top = nameAnchor(o, "top");
  return {
    id: "h",
    o,
    hole: true,
    first: { name: "Down to Ground floor", x: at.x, y: at.y, below: true, size: "map", small: true, maxLines: 1, stack: true },
    dropPill: { value: "10 ft down", x: top.x, y: top.y, above: true, size: "map", small: true },
  };
}

/** One round of the three layers, from the link pills the token text last kept off. Returns the link pills it ends on. */
function round(turn: Turn, seed: { trapX: number; trapY: number; textX: number; textY: number }, linkPills: readonly PillSpec[], read: "fixed" | "nudged"): PillSpec[] {
  const view = isometric(turn);
  const ground = () => 0;
  const trap = makeTrap("t", { zone: { cells: [{ x: seed.trapX, y: seed.trapY, w: 2, h: 1 }] } });
  const original = trapNamePill(SQUARES, trap, {}, SCALE, true)!;
  // Token text starts where its creature puts it and steps over any link pill it meets, as the label layout does.
  const base: Box = { x0: seed.textX, y0: seed.textY, x1: seed.textX + 2.4, y1: seed.textY + 0.5 };
  const pills = linkPills.map((p) => pillInkReach({ ...viewPill(p, view, ground), scale: SCALE }));
  const hit = pills.some((b) => meet(b, base));
  const text: Box = hit ? { ...base, y0: base.y0 - 1.2, y1: base.y1 - 1.2 } : base;
  const nudged = isoTrapNamePill(original, SQUARES, trap, {}, { view, ground, boxes: [text] }, SCALE, () => true);
  // What the link layer reads (isoTrapNameMarkers): the pick with no token text to keep off.
  const markers = read === "fixed" ? [isoTrapNamePill(original, SQUARES, trap, {}, { view, ground, boxes: [] }, SCALE, () => true)] : [nudged];
  const placed = placeEnds([hole()], markers, SCALE, { turn, ground }, () => true);
  return [placed.get("h")!.pill!, placed.get("h")!.chip!];
}

/** Whether the rounds reach a fixed point, as the layers' JSON-keyed memos need to stop publishing. */
function settles(turn: Turn, seed: Parameters<typeof round>[1], read: "fixed" | "nudged"): boolean {
  let pills: PillSpec[] = [];
  let last = "";
  for (let i = 0; i < 12; i++) {
    pills = round(turn, seed, pills, read);
    const key = JSON.stringify(pills);
    if (key === last) return true;
    last = key;
  }
  return false;
}

const seeds = () => {
  let s = 11;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: 240 }, () => ({ trapX: 4 + Math.floor(rand() * 8), trapY: 2 + Math.floor(rand() * 6), textX: 5 + rand() * 6, textY: 3 + rand() * 4 }));
};

test("a hole, a trap name and token text close together in Isometric settle at every turn when the hole's pills read the trap name before the nudge (F11-1)", () => {
  for (const turn of [0, 1, 2, 3] as const) for (const seed of seeds()) assert.equal(settles(turn, seed, "fixed"), true, `turn ${turn} ${JSON.stringify(seed)}`);
});

test("reading the nudged name instead would not always settle, so the test above can fail (F11-1)", () => {
  const loops = [0, 1, 2, 3].flatMap((turn) => seeds().filter((seed) => !settles(turn as Turn, seed, "nudged")));
  assert.ok(loops.length > 0, "no layout in the search loops when the nudged name is read");
});

test("the floor link layer never reads the published trap names (F11-1)", () => {
  const source = readFileSync(new URL("./LinkLayer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["'`]trap:/);
});
