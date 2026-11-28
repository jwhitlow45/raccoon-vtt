import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type PathStop, type RoomState, type Token, type Viewer } from "../model.ts";
import { room, token } from "../testutil.ts";
import { footprintRect, occupiedRange, placedOnHex } from "./footprint.ts";
import { bucketRange, DRAG_WORK, HEX_BOX_UNITS, LEG_WORK_CAP, reachInput, reachScan, SLICE_WORK, type ReachLeave } from "./opportunity.ts";

/**
 * What a scan counts as work on hexes, where finding the hexes a creature
 * covers costs far more than a test between two boxes (D-261128-099): a
 * creature's box and a spot's are each built and counted once, where the two
 * come near each other, so a creature the walk never comes near costs
 * nothing, and a spot near many of them builds their boxes over several
 * slices.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };

type Spot = { x: number; y: number };

/** Bree at `at` and goblins on `cells`, on squares or hex rows. */
function crowd(at: Spot, cells: readonly Spot[], shape?: "hexRows"): RoomState {
  const tokens: Token[] = [token("bree", { kind: "pc", name: "Bree", disposition: "ally", ...at })];
  cells.forEach((c, i) => tokens.push(token(`g${i}`, { name: `Goblin ${i}`, ...c })));
  const state = room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
  state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off", ...(shape ? { gridShape: shape } : {}) };
  return state;
}

/** A block of cells, `w` by `h` from `x0, y0`, less any listed. */
function block(x0: number, y0: number, w: number, h: number, less: readonly Spot[] = []): Spot[] {
  const out: Spot[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (!less.some((l) => l.x === x && l.y === y)) out.push({ x, y });
  return out;
}

/** The work counts Bree's walk from `at` straight down `cells` cells yields at, `slice` units at a time. */
function yields(state: RoomState, at: Spot, cells: number, slice = SLICE_WORK): number[] {
  const read = reachInput(state, "bree", { turn: 1, stops: [{ ...at, elevation: 0 }, { x: at.x, y: at.y + cells, elevation: 0 }] }, { rolls: {}, monsters: [] }, DM);
  assert.ok(read);
  const run = reachScan(read.input, { ...read.legs[0]!, provokes: true }, new Set(), slice);
  const out: number[] = [];
  for (let step = run.next(); !step.done; step = run.next()) out.push(step.value);
  return out;
}

/** All the work a scan does, read by yielding at every chance. */
const workOf = (state: RoomState, at: Spot, cells: number) => yields(state, at, cells, 1).at(-1) ?? 0;

describe("a scan's work on hexes", () => {
  const start = { x: 2, y: 2 };

  test("120 goblins on hexes far from the walk cost nothing: neither their hexes nor the walk's are found", () => {
    assert.equal(workOf(crowd(start, block(40, 40, 20, 6), "hexRows"), start, 2), 0);
  });

  test("each goblin near the walk on hexes costs HEX_BOX_UNITS once, and the same goblins on squares a few tests", () => {
    // A column beside a walk 8 cells down, so every spot has a goblin near it either way, and a second column one cell further.
    const beside = block(3, 2, 1, 8);
    const more = [...beside, ...block(4, 2, 1, 8)];
    const hexes = workOf(crowd(start, more, "hexRows"), start, 8) - workOf(crowd(start, beside, "hexRows"), start, 8);
    assert.ok(hexes >= 8 * HEX_BOX_UNITS && hexes < 9 * HEX_BOX_UNITS, `8 more boxes, each built once: ${hexes} units`);
    const squares = workOf(crowd(start, more), start, 8) - workOf(crowd(start, beside), start, 8);
    assert.ok(squares > 0 && squares < HEX_BOX_UNITS, `distance tests alone: ${squares} units`);
  });

  test("a spot first near 63 goblins on hexes builds their boxes over several slices, none of them running a box past its slice", () => {
    const at = { x: 10, y: 10 };
    const slice = 5_000;
    const seen = yields(crowd(at, block(6, 6, 8, 8, [at]), "hexRows"), at, 1, slice);
    assert.ok(seen.length >= 3, `the first spot's boxes in ${seen.length} slices`);
    seen.forEach((n, i) => assert.ok(n - (seen[i - 1] ?? 0) < slice + 2 * HEX_BOX_UNITS, `a slice ran to ${n - (seen[i - 1] ?? 0)} units: ${seen.join(", ")}`));
  });

  test("a walk on hexes past 30 goblins builds a box for each and for each spot near them, which together take more than a slice", () => {
    const beside = block(3, 2, 1, 30);
    // Past the yield that starts the walk on hexes, which comes before any work.
    assert.ok(yields(crowd(start, beside, "hexRows"), start, 100).some((n) => n > 0));
    assert.deepEqual(yields(crowd(start, beside), start, 100), [], "on squares the same walk fits in one slice");
  });

  test("on hexes the walk starts a slice of its own, before any of its work, and on squares it runs on", () => {
    const one = [{ x: 3, y: 2 }];
    assert.equal(yields(crowd(start, one, "hexRows"), start, 2)[0], 0);
    assert.deepEqual(yields(crowd(start, one), start, 2), []);
  });

  test("a creature's bucket bound holds every cell its hexes reach, at every size and on both hex grids", () => {
    for (const orient of ["rows", "columns"] as const) {
      const g = { shape: "hex", orient } as const;
      for (const size of ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const) {
        for (let col = -3; col < 9; col++) {
          for (let row = -3; row < 9; row++) {
            const placed = { size, ...placedOnHex(g, { size, x: 0, y: 0 }, { col, row }) };
            const r = occupiedRange(g, placed);
            const b = bucketRange(g, placed);
            assert.ok(b.x0 <= r.x0 && b.y0 <= r.y0 && b.x1 >= r.x1 && b.y1 >= r.y1, `${orient} ${size} at ${col},${row}: ${JSON.stringify({ r, b, rect: footprintRect(g, placed) })}`);
          }
        }
      }
    }
  });
});

describe("the cover gate's work between big custom creatures (section 5)", () => {
  /**
   * Bree, 20 by 20 squares, beside `count` creatures of 20 by 20 standing
   * on one another, with a wall the length of the side between them, so no
   * line between their squares is clear and the gate tries every pair it
   * may. Each reaches `reach` feet.
   */
  function giants(count: number, reach: number): { state: RoomState; reaches: number[] } {
    const tokens: Token[] = [token("bree", { kind: "pc", name: "Bree", disposition: "ally", size: "custom", w: 20, h: 20, x: 10, y: 0 })];
    for (let i = 0; i < count; i++) tokens.push(token(`g${i}`, { name: `Giant ${i}`, size: "custom", w: 20, h: 20, x: 30, y: 0 }));
    const state = room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
    state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off" };
    // Free walls are at most 8 squares long, so the side's wall is three, each stored in the chunk its middle falls in.
    [0, 8, 16].forEach((y0, i) => {
      const y1 = Math.min(y0 + 8, 20);
      const cx = Math.floor(30 / CHUNK_CELLS);
      const cy = Math.floor((y0 + y1) / 2 / CHUNK_CELLS);
      const chunk: BuildChunk = (state.buildChunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
      (chunk.walls ??= []).push({ id: `w0000000000${i}`, a: [30, y0], b: [30, y1], f: { kind: "wall" } });
    });
    return { state, reaches: [reach] };
  }

  /** The work Bree's walk through `stops` yields at, `slice` units at a time, and what it gives. */
  function scan(world: { state: RoomState; reaches: number[] }, stops: PathStop[], slice: number): { yields: number[]; out: ReachLeave[] | "over" } {
    const read = reachInput(world.state, "bree", { turn: 1, stops }, { rolls: {}, monsters: [] }, DM);
    assert.ok(read);
    const input = { ...read.input, reactors: read.input.reactors.map((r) => ({ ...r, reaches: world.reaches })) };
    const run = reachScan(input, { ...read.legs[0]!, provokes: true }, new Set(), slice);
    const yields: number[] = [];
    for (let step = run.next(); ; step = run.next()) {
      if (step.done) return { yields, out: step.value };
      yields.push(step.value);
    }
  }

  /** The most one step of the gate adds past its check: a test between two squares and the one wall a line meets. */
  const STEP = 64;
  const gaps = (yields: readonly number[]) => yields.map((n, i) => n - (yields[i - 1] ?? 0));

  test("stepping away from one beside it, the gate tries only the squares on the sides that face each other, well inside a slice", () => {
    const { yields, out } = scan(giants(1, 5), [{ x: 10, y: 0, elevation: 0 }, { x: 5, y: 0, elevation: 0 }], SLICE_WORK);
    assert.deepEqual(out, [], "the wall stops every line");
    assert.deepEqual(yields, [], `20 squares a side, not 400 by 400 pairs in one step: ${yields.join(", ")}`);
  });

  test("rising straight up beside one with a 120 ft reach, where every square of each is within reach, the gate yields inside its pairs for a slice and for the drag's cap", () => {
    for (const slice of [SLICE_WORK, DRAG_WORK]) {
      const { yields, out } = scan(giants(1, 120), [{ x: 10, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 500 }], slice);
      assert.deepEqual(out, [], "the wall stops every line");
      assert.ok(yields.length >= 5, `the gate's pairs took ${yields.length} slices`);
      for (const gap of gaps(yields)) assert.ok(gap <= slice + STEP, `a slice ran to ${gap} units past its ${slice}: ${yields.join(", ")}`);
    }
    // The drag stops at its first yield past DRAG_WORK, so no drag frame runs further.
    assert.ok(scan(giants(1, 120), [{ x: 10, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 500 }], DRAG_WORK).yields[0]! <= DRAG_WORK + STEP);
  });

  test("ten of them stop the scan at LEG_WORK_CAP, inside a gate, never yielding past it", () => {
    const { yields, out } = scan(giants(10, 120), [{ x: 10, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 500 }], SLICE_WORK);
    assert.equal(out, "over");
    assert.ok(Math.max(...yields) <= LEG_WORK_CAP + STEP, `yielded at ${Math.max(...yields)}`);
    for (const gap of gaps(yields)) assert.ok(gap <= SLICE_WORK + STEP, `a slice ran to ${gap} units`);
  });
});
