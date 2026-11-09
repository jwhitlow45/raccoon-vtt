import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER, onThornsTurn, run, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState } from "#shared/model.ts";
import { linkLabel, notReachedLinks, quietLinks } from "./linkMarks.ts";

/*
 * The board's marks of stairs and ladders (docs/design/design-v1-floors.md
 * phase 2, 10, 11): each end's name by what the viewer holds, the DM's
 * "Not reached yet", and the name giving way to the turn's marker.
 */

const end = (s: RoomState, id: string): FloorLink => s.floorLinks![id]!;
/** A player's cut of an end (4): `to` only where they hold that floor, and its way. */
const cut = (link: FloorLink, dir: "up" | "down", holds: boolean) => {
  const { pair: _p, to, ground: _g, made: _m, ...rest } = link;
  return { ...rest, ...(holds ? { to } : {}), dir };
};

describe("an end's name (11)", () => {
  test("names the far floor where the copy holds it, else the kind and the way", () => {
    const s = withStairs();
    assert.equal(linkLabel(s, end(s, "l1")), "Up to Upper floor");
    assert.equal(linkLabel(s, end(s, "l2")), "Down to Ground floor");
    assert.equal(linkLabel(s, cut(end(s, "l1"), "up", false)), "Stairs up");
    const ladder = withStairs(tower(), { kind: "ladder" });
    assert.equal(linkLabel(ladder, cut(end(ladder, "l2"), "down", false)), "Ladder down");
    // A player's `to` of a floor their copy holds names it.
    assert.equal(linkLabel(s, cut(end(s, "l1"), "up", true)), "Up to Upper floor");
  });
});

describe("the DM's Not reached yet (10)", () => {
  test("marks an end whose far floor players have not reached, and not once a party member stands there or the DM opens it", () => {
    const s = withStairs(withStairs(tower(), { id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: { x: 8, y: 8, w: 1, h: 1 } }));
    assert.deepEqual(notReachedLinks(s, GROUND), ["l1"]);
    assert.deepEqual(notReachedLinks(s, UPPER), ["l3"], "Upper's stairs down to Ground lead where players are");
    const opened = run(s, { t: "floor.open", sceneId: UPPER, open: true });
    assert.deepEqual(notReachedLinks(opened, GROUND), []);
  });
});

describe("the name gives way to the turn's marker (6.4, picture 07)", () => {
  test("while the turn's creature stands where its moves on this floor began, on the end, and not once it walks off", () => {
    const s = onThornsTurn(withStairs());
    assert.deepEqual(quietLinks(s, GROUND, "dm"), [], "no moves yet: no marker");
    const climbed = run(s, { t: "token.climb", tokenId: "thorn", linkId: "l1" });
    assert.deepEqual(quietLinks(climbed, UPPER, "dm"), ["l2"]);
    assert.deepEqual(quietLinks(climbed, GROUND, "dm"), [], "the floor it left");
    const off = run(climbed, { t: "token.move", tokenId: "thorn", x: 8, y: 8 });
    assert.deepEqual(quietLinks(off, UPPER, "dm"), [], "walked off the stairs");
    // Off its turn there is no marker, so the name shows.
    const after = run(climbed, { t: "encounter.end" });
    assert.deepEqual(quietLinks(after, UPPER, "dm"), []);
  });
});
