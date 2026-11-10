import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { builderScene } from "../scenes/create.ts";
import { editLayout } from "./edits.ts";
import { generate, planFitted, type WingBase } from "./plan.ts";
import { landAll, scratchRoom } from "./scratch.ts";
import { clampSettings, DEFAULT_CONTEXT, GENERATOR_VERSION, type DungeonSettings, type GridKind } from "./settings.ts";
import { wingHash } from "./wing.ts";

/*
 * Plans pinned by hash (docs/design/design-v1-dungeon-generator.md
 * 5.1), every theme among them, at the default 5 ft a square. Replay never runs the generator, so it may change, but a change
 * that moves any plan bumps GENERATOR_VERSION and this fixture together:
 * an old seed then says it is from another version. UPDATE_FIXTURES=1
 * rewrites the fixture, but never moves a plan under the version it was
 * pinned at, so a rewrite cannot stand in for the bump.
 */

const FIXTURE = new URL("./plan.golden.fixture.json", import.meta.url);

/** A pinned plan. Phase 3's cases name what else made them: a hex grid, a wing on the fixture scene, edits. */
type Golden = { version: number; plans: { name: string; settings: DungeonSettings; seed: string; grid?: GridKind; wing?: true; edits?: true; sha256: string }[] };

const CASES: { name: string; settings: Partial<DungeonSettings>; seed: string }[] = [
  { name: "the defaults", settings: {}, seed: "1K7QH2MXA9F3TWQ5" },
  { name: "Small", settings: { w: 30, h: 30, rooms: 6 }, seed: "1Q8V2DR4HJ0Y7ZB3" },
  { name: "Large", settings: { w: 80, h: 80, rooms: 20 }, seed: "1M3T9WCEX5PK2AGN" },
  { name: "a Crypt, Dense, Winding and Wide", settings: { theme: "crypt", density: "dense", corridors: "winding", wide: true }, seed: "1A0B1C2D3E4F5G6H" },
  { name: "Sparse and Straight, flat, no loops or traps", settings: { density: "sparse", corridors: "straight", loops: false, heights: 0, traps: 0 }, seed: "1ZZZZZZZZZZZZZZZ" },
  { name: "a Dense Winding Crypt with many traps", settings: { theme: "crypt", density: "dense", corridors: "winding", traps: 4, band: "11-16" }, seed: "1000000000000001" },
  { name: "the largest Wide", settings: { w: 100, h: 100, rooms: 40, density: "dense", corridors: "winding", wide: true, heights: 75, traps: 6 }, seed: "1VVVVWWWWXXXXYYY" },
  { name: "the largest Narrow", settings: { w: 100, h: 100, rooms: 40, density: "sparse", corridors: "winding", heights: 50, traps: 4 }, seed: "1RS7TV8WX9YZ0123" },
  { name: "the smallest", settings: { w: 20, h: 20, rooms: 2 }, seed: "1HJKMNPQRST45678" },
  { name: "Custom and Wide", settings: { w: 37, h: 63, rooms: 11, wide: true, heights: 10, traps: 3, band: "17-20" }, seed: "1D6E7F8G9H0J1K2M" },
  { name: "a Large Straight Wide Crypt", settings: { w: 80, h: 80, rooms: 20, theme: "crypt", corridors: "straight", wide: true, loops: false }, seed: "1N3P4Q5R6S7T8V9W" },
  { name: "Bending with traps at 5 to 10", settings: { traps: 4, band: "5-10" }, seed: "1X0Y1Z2A3B4C5D6E" },
  { name: "a Cave with dead ends", settings: { theme: "cave", w: 60, h: 60, rooms: 16 }, seed: "1C4V3D3AD3ND5000" },
  { name: "a Wide Mine with secret doors", settings: { theme: "mine", wide: true, secrets: 4, heights: 50 }, seed: "1M1N3S7AF7Y0DEEP" },
  { name: "a Narrow Sewer with secret doors and no dead ends", settings: { theme: "sewer", secrets: 6, deadEnds: false, traps: 6 }, seed: "1SEWER0RAT5N0SE5" },
];

/*
 * Phase 3's cases (5): each made as the dialog or the wing pane makes it,
 * through `planFitted`. None moves a case above, whose plans carry none of
 * phase 3's fields.
 */
const PHASE3: { name: string; settings: Partial<DungeonSettings>; seed: string; grid?: GridKind; wing?: true; edits?: true }[] = [
  { name: "a hex Medium", settings: { traps: 4, secrets: 2, lit: 50, dressing: "full" }, seed: "1HEX0MED1VM0R0WS", grid: "hexRows" },
  { name: "a hex Wide Crypt on columns", settings: { theme: "crypt", wide: true, heights: 50, traps: 4 }, seed: "1HEX0W1DE0CRYPT0", grid: "hexColumns" },
  { name: "a wing on a square scene", settings: { w: 30, h: 30, rooms: 6, traps: 4, lit: 50 }, seed: "1W1NG0ADDED0EAST", wing: true },
  { name: "an edited plan", settings: { traps: 4, lit: 25, dressing: "some" }, seed: "1K7QH2MXA9F3TWQ5", edits: true },
];

/** The wing case's scene: a 70 by 40 square scene holding one painted room, joined on its east wall. */
function wingBase(s: DungeonSettings): WingBase {
  const cells: string[] = [];
  for (let y = 14; y < 24; y++) for (let x = 8; x < 18; x++) cells.push(`${x},${y}`);
  const landed = landAll(scratchRoom(), [
    { t: "scene.create", scene: builderScene({ id: "s", name: "Old", w: 70, h: 40 }) },
    { t: "build.paint", sceneId: "s", terrain: "stone", cells },
  ]);
  if (!landed.ok) throw new Error(landed.why);
  const state: RoomState = landed.room;
  const base = { scene: state.scenes.s!, state, area: { x: 28, y: 2, w: 40, h: 36 }, join: { grid: "squares" as const, edges: [{ key: "18,18,w", feature: null, ground: 0 }] } };
  return { ...base, hash: wingHash(base, s) };
}

/** A phase 3 case's plan, as the dialog or the pane plans it. */
function phase3Plan(c: (typeof PHASE3)[number], s: DungeonSettings): ReturnType<typeof generate> {
  const context = c.grid ? { ...DEFAULT_CONTEXT, grid: c.grid } : DEFAULT_CONTEXT;
  if (c.wing) return planFitted(s, c.seed, context, { wing: wingBase(s) }).plan;
  if (c.edits) {
    const base = planFitted(s, c.seed, context);
    const [a, b] = base.kept.filter((i) => i !== base.entrance);
    const door = base.facts.find((f) => f.room === a)!.doors[0]!;
    const rooms = { [a!]: { trap: "spiked-pit", lit: true, dressing: "full" as const, propsDraw: 3, doors: { [door.key]: "locked" as const } }, [b!]: { ground: 10, lit: false, trap: null } };
    return planFitted(s, c.seed, context, { edits: { layout: editLayout(s, c.seed, base.fitted, null), rooms } }).plan;
  }
  return planFitted(s, c.seed, context).plan;
}

/**
 * Why a rewrite would hide a moved plan, or null when it may go ahead: a
 * plan kept under the same name, settings and seed whose hash changed
 * while the version did not. New cases and a bumped version may be written.
 */
export function rewriteRefused(old: Golden | null, now: Golden): string | null {
  if (!old || old.version !== now.version) return null;
  const pinned = new Map(old.plans.map((p) => [p.name, p]));
  const moved = now.plans.filter((p) => {
    const was = pinned.get(p.name);
    return was && was.seed === p.seed && JSON.stringify(was.settings) === JSON.stringify(p.settings) && was.sha256 !== p.sha256;
  });
  return moved.length === 0 ? null : `${moved.map((p) => p.name).join(", ")} moved at version ${now.version}: bump GENERATOR_VERSION, then rerun with UPDATE_FIXTURES=1`;
}

/** The whole plan, the key's traps in corridors (LP33-B-KEY-1) too, as the rooms' traps are (D-261109-157). */
const hash = (plan: ReturnType<typeof generate>) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

function today(): Golden {
  return {
    version: GENERATOR_VERSION,
    plans: [
      ...CASES.map(({ name, settings, seed }) => {
        const s = clampSettings(settings);
        return { name, settings: s, seed, sha256: hash(generate(s, seed, DEFAULT_CONTEXT)) };
      }),
      ...PHASE3.map((c) => {
        const s = clampSettings(c.settings, c.grid);
        const { name, seed, grid, wing, edits } = c;
        return { name, settings: s, seed, ...(grid ? { grid } : {}), ...(wing ? { wing } : {}), ...(edits ? { edits } : {}), sha256: hash(phase3Plan(c, s)) };
      }),
    ],
  };
}

describe("golden dungeon plans", () => {
  test("DG-R1-04: a rewrite never moves a pinned plan under its version, and takes new cases or a bumped version", () => {
    const plan = (name: string, sha256: string) => ({ name, settings: clampSettings({}), seed: "1K7QH2MXA9F3TWQ5", sha256 });
    const old: Golden = { version: 1, plans: [plan("a", "x"), plan("b", "y")] };
    assert.match(rewriteRefused(old, { version: 1, plans: [plan("a", "x"), plan("b", "z")] }) ?? "", /^b moved at version 1: bump GENERATOR_VERSION/);
    assert.equal(rewriteRefused(old, { version: 2, plans: [plan("a", "q"), plan("b", "z")] }), null, "a bumped version rewrites");
    assert.equal(rewriteRefused(old, { version: 1, plans: [plan("a", "x"), plan("b", "y"), plan("c", "w")] }), null, "a new case is written");
    assert.equal(rewriteRefused(old, { version: 1, plans: [plan("a", "x"), { ...plan("b", "z"), seed: "1ZZZZZZZZZZZZZZZ" }] }), null, "a case given another seed is a new pin");
    assert.equal(rewriteRefused(null, { version: 1, plans: [plan("a", "x")] }), null, "no fixture yet");
  });

  test("the fixture's version is the generator's", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
    assert.equal(fixture.version, GENERATOR_VERSION);
  });

  test("fixed seeds and choices, one or more of each theme, make the plans they made", () => {
    const now = today();
    if (process.env.UPDATE_FIXTURES === "1") {
      const refused = rewriteRefused(JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden, now);
      assert.equal(refused, null, "the fixture is not rewritten");
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Golden;
    assert.equal(fixture.plans.length, CASES.length + PHASE3.length);
    assert.deepEqual(now, fixture, "a plan moved: bump GENERATOR_VERSION and rerun with UPDATE_FIXTURES=1");
  });
});
