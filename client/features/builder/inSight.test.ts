import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tileKey } from "#shared/keys.ts";
import type { RoomState, SightTile } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";
import { gestureCells, partySeesAny } from "./inSight.ts";

/*
 * The builder's note on the players' scene while the party's sight meets a
 * cell being built (docs/design-v1-map-discovery.md 9 and decision 15).
 */

const NONE = { unsent: [], rect: null, run: [], poly: [], labelMove: null } as const;

/** The DM's copy: s1 the players' scene with vision on, the party's sight over tile (0, 0) where `lit`. */
function dmCopy(opts: { lit: boolean; vision?: boolean; fog?: boolean; players?: string; blackout?: boolean }): RoomState {
  const state = room({ scenes: { s1: scene("s1", { fogEnabled: opts.fog !== false, ...(opts.vision === false ? {} : { vision: { on: true, light: "bright" } }) }), s2: scene("s2", { order: 1 }) } });
  state.meta = { ...state.meta, playerSceneId: opts.players ?? "s1", view: { follow: false, blackout: opts.blackout === true } };
  const sight: Record<string, SightTile> = opts.lit ? { [tileKey("s1", 0, 0)]: { f: 1 } } : {};
  return { ...state, sight } as RoomState;
}

describe("the builder's note while the party sees where the DM builds", () => {
  test("a gesture's cells: a stroke, a rectangle, a wall run's cells either side, a shape's corners' box and a dragged label", () => {
    assert.deepEqual(gestureCells({ ...NONE, unsent: ["1,1"] }), ["1,1"]);
    assert.deepEqual(gestureCells({ ...NONE, rect: { a: { x: 2.5, y: 3.5 }, b: { x: 3.2, y: 3.9 } } }), ["2,3", "3,3"]);
    assert.deepEqual(gestureCells({ ...NONE, run: ["4,5,n", "6,7,w"] }), ["4,5", "4,4", "6,7", "5,7"]);
    assert.deepEqual(gestureCells({ ...NONE, poly: [{ x: 1, y: 1 }, { x: 3, y: 2 }] }), ["1,1", "2,1"]);
    assert.deepEqual(gestureCells({ ...NONE, labelMove: { id: "l", x: 7.4, y: 2.6 } }), ["7,2"]);
  });

  test("on the players' scene with vision on, a cell in the party's sight shows it", () => {
    const s1 = dmCopy({ lit: true }).scenes.s1!;
    assert.equal(partySeesAny(dmCopy({ lit: true }), s1, ["3,3"]), true);
    assert.equal(partySeesAny(dmCopy({ lit: true }), s1, ["20,3"]), false, "a cell out of sight");
    assert.equal(partySeesAny(dmCopy({ lit: false }), s1, ["3,3"]), false);
  });

  test("not on another scene than the players', with vision or fog off, behind a blackout or with nothing being built", () => {
    assert.equal(partySeesAny(dmCopy({ lit: true, players: "s2" }), dmCopy({ lit: true }).scenes.s1!, ["3,3"]), false);
    const off = dmCopy({ lit: true, vision: false });
    assert.equal(partySeesAny(off, off.scenes.s1!, ["3,3"]), false);
    // With fog off players hold the whole build, sight or none.
    const noFog = dmCopy({ lit: true, fog: false });
    assert.equal(partySeesAny(noFog, noFog.scenes.s1!, ["3,3"]), false);
    assert.equal(partySeesAny(dmCopy({ lit: true, blackout: true }), dmCopy({ lit: true }).scenes.s1!, ["3,3"]), false);
    assert.equal(partySeesAny(dmCopy({ lit: true }), dmCopy({ lit: true }).scenes.s1!, []), false);
  });
});
