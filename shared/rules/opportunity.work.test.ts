import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, Viewer } from "../model.ts";
import { room, token } from "../testutil.ts";
import { HEX_BOX_UNITS, reachInput, reachScan, SLICE_WORK } from "./opportunity.ts";

/**
 * What a scan counts as work on hexes, where finding the hexes a creature
 * covers costs far more than a test between two boxes (D-261128-099): the
 * creatures' read yields like the walk does, and a long read hands the walk
 * a fresh slice.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };

/** Bree at the corner and this many goblins in a far block, none of them near her walk. */
function crowd(goblins: number, shape?: "hexRows"): RoomState {
  const tokens: Token[] = [token("bree", { kind: "pc", name: "Bree", disposition: "ally", x: 0, y: 0 })];
  for (let i = 0; i < goblins; i++) tokens.push(token(`g${i}`, { name: `Goblin ${i}`, x: 40 + (i % 20), y: 40 + Math.floor(i / 20) }));
  const state = room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
  state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off", ...(shape ? { gridShape: shape } : {}) };
  return state;
}

/** The work counts the scan of Bree's walk from the corner straight down this many cells yields at, one slice of SLICE_WORK at a time. */
function yields(state: RoomState, cells = 2): number[] {
  const read = reachInput(state, "bree", { turn: 1, stops: [{ x: 0, y: 0, elevation: 0 }, { x: 0, y: cells, elevation: 0 }] }, { rolls: {}, monsters: [] }, DM);
  assert.ok(read);
  const run = reachScan(read.input, { ...read.legs[0]!, provokes: true }, new Set(), SLICE_WORK);
  const out: number[] = [];
  for (let step = run.next(); !step.done; step = run.next()) out.push(step.value);
  return out;
}

describe("a scan's work on hexes", () => {
  test("120 goblins on hexes: the read yields once a slice's worth of boxes is built, and the walk starts a fresh slice", () => {
    const boxesPerSlice = Math.ceil(SLICE_WORK / HEX_BOX_UNITS);
    const seen = yields(crowd(120, "hexRows"));
    assert.equal(seen[0], boxesPerSlice * HEX_BOX_UNITS, "the first yield comes inside the creatures' read");
    assert.equal(seen[1], 120 * HEX_BOX_UNITS, "past half a slice since that yield, the walk waits for the next slice");
  });

  test("a read that ends right on a yield gives the walk that slice, with no empty one between", () => {
    const boxesPerSlice = Math.ceil(SLICE_WORK / HEX_BOX_UNITS);
    const seen = yields(crowd(2 * boxesPerSlice, "hexRows"));
    assert.deepEqual(seen.slice(0, 2), [boxesPerSlice * HEX_BOX_UNITS, 2 * boxesPerSlice * HEX_BOX_UNITS]);
    assert.ok(seen.every((n, i) => i === 0 || n > seen[i - 1]!), `every yield follows new work: ${seen.join(", ")}`);
  });

  test("the same 120 goblins on squares cost a few sums, so the scan never yields", () => {
    assert.deepEqual(yields(crowd(120)), []);
  });

  test("each spot of a long walk on hexes builds a box, so 100 cells past one goblin take more than a slice", () => {
    assert.ok(yields(crowd(1, "hexRows"), 100).length > 0);
    assert.deepEqual(yields(crowd(1), 100), [], "on squares the same walk fits in one slice");
  });
});
