import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, BREE, GROUND, UPPER, withOpening } from "./floorLinksTestutil.ts";
import type { FloorLink, RoomState, Token, Viewer } from "./model.ts";
import { goblin, lamp, levelsAt, openTower, pc, subsOf, withAll } from "./openingsTestutil.ts";
import { changedSightKeys, projectState } from "./project.ts";
import { visionRules } from "./ruleHooks.ts";
import { openingJoins } from "./rules/openingSight.ts";
import { BRIGHT } from "./rules/vision.ts";

/*
 * The sight twins (docs/design/design-v1-floors.md phase 4, 10.5) at the
 * projection: each pair differs only in hidden state, and every player's
 * and the display's copy of the room is the same for both. The wire twins
 * (frames, ticks, reconnects) are openings.wire.itest.ts's.
 */

const DISPLAY: Viewer = { memberId: "display:table", role: "player" };
const copies = (s: RoomState, viewers: readonly Viewer[]) => viewers.map((v) => projectState(s, v, { sceneId: null }));
const equalFor = (a: RoomState, b: RoomState, viewers: readonly Viewer[], why: string) => assert.deepEqual(copies(a, viewers), copies(b, viewers), why);

describe("O1: both floors open and lit, a hidden goblin in the column or none", () => {
  test("every copy is the same, and its 20 walks there change no sight", () => {
    const base = withAll(openTower({ ground: "bright", upper: "bright" }), [pc("thorn", "p1", UPPER, 3, 3), pc("bree", "p2", GROUND, 14, 3)]);
    let hidden = withAll(base, [goblin("g1", GROUND, 6, 6, { visibility: "dm" })]);
    equalFor(hidden, base, [ANA, BREE, DISPLAY], "a hidden goblin or none");
    for (let i = 0; i < 20; i++) {
      const next = withAll(hidden, [{ ...hidden.tokens.g1!, x: 6 + (i % 2), y: 6 + ((i >> 1) % 2) }]);
      assert.deepEqual(changedSightKeys(hidden, next, [GROUND, UPPER]), [], `walk ${i}`);
      equalFor(next, base, [ANA, BREE, DISPLAY], `walk ${i}`);
      hidden = next;
    }
  });
});

describe("O2: the floor below open and dark, no darkvision", () => {
  test("a visible goblin in the column or none, a lamp below that cannot reach the opening or none: every copy the same", () => {
    // Thorn looks down the hole from a dark floor upstairs, so nothing lights the column.
    const base = withAll(openTower({ ground: "dark", upper: "dark" }), [pc("thorn", "p1", UPPER, 3, 3)]);
    const variants = [withAll(base, [goblin("g1", GROUND, 6, 6)]), withAll(base, [], [lamp("l1", GROUND, 17, 17)]), withAll(base, [goblin("g1", GROUND, 7, 7)], [lamp("l1", GROUND, 17, 2)])];
    for (const v of variants) equalFor(v, base, [ANA, BREE, DISPLAY], "a twin");
  });
});

describe("O3: the floor over the hole not reached", () => {
  // An opening from Attic down to Upper floor, the party upstairs, the attic never reached.
  const base = withAll(withOpening(openTower({ upper: "bright", attic: "bright" }, { opening: false }), { id: "a1", pairId: "a2", upper: ATTIC, lower: UPPER }), [pc("thorn", "p1", UPPER, 3, 3)]);
  const attic = (s: RoomState, over: Partial<RoomState["scenes"][string]>): RoomState => ({ ...s, scenes: { ...s.scenes, [ATTIC]: { ...s.scenes[ATTIC]!, ...over } } });
  const hiddenStairs = (s: RoomState): RoomState => {
    const end = (id: string, sceneId: string, to: string, pair: string): FloorLink => ({ id, rev: 0, sceneId, to, pair, rect: { x: 14, y: 14, w: 1, h: 1 }, kind: "stairs", hidden: true, ground: 0, made: 91 });
    return { ...s, floorLinks: { ...s.floorLinks, h1: end("h1", ATTIC, UPPER, "h2"), h2: end("h2", UPPER, ATTIC, "h1") } };
  };

  test("no join, and a lamp under the hole, goblins, a hidden stair, a name or an empty attic change no copy", () => {
    assert.deepEqual(openingJoins(base, UPPER), []);
    const variants: [string, RoomState][] = [
      ["a lamp over the hole", withAll(base, [], [lamp("l1", ATTIC, 7, 7)])],
      ["goblins", withAll(base, [goblin("g1", ATTIC, 6, 6), goblin("g2", ATTIC, 10, 10)])],
      ["a hidden stair", hiddenStairs(base)],
      ["Crypt", attic(base, { name: "Crypt", floor: { ...base.scenes[ATTIC]!.floor!, name: "Crypt" }, background: "#000000" })],
      ["a dark attic", attic(base, { vision: { on: true, light: "dark" } })],
    ];
    for (const [name, v] of variants) equalFor(v, base, [ANA, BREE, DISPLAY], name);
    const column = levelsAt(visionRules.sightFor(base, UPPER, "shared"), subsOf());
    assert.deepEqual(column, levelsAt(visionRules.partySight(base, UPPER), subsOf()), "the column is its floor's own");
  });
});

describe("O4: Ana holds the floor below only through a creature the DM hid", () => {
  // The party starts upstairs, so the floor below opens only by a party member the DM has not hidden.
  const start = (s: RoomState): RoomState => ({ ...s, meta: { ...s.meta, playerSceneId: UPPER }, openFloors: {} });
  const base = start(withAll(openTower({ ground: "bright", upper: "dark" }), [pc("thorn", "p1", UPPER, 3, 3), pc("bree", "p2", UPPER, 12, 3)]));
  const scout = (x: number, y: number): Token => pc("scout", "p1", GROUND, x, y, { visibility: "dm" });

  test("no join for anyone, and Bree's and the display's copies equal whatever the hidden creature and lamps do", () => {
    const variants: [string, RoomState][] = [
      ["in the column", withAll(base, [scout(6, 6)])],
      ["elsewhere", withAll(base, [scout(15, 15)])],
      ["in the column, a lamp below", withAll(base, [scout(6, 6)], [lamp("l1", GROUND, 7, 7)])],
    ];
    for (const [name, v] of variants) {
      assert.deepEqual(openingJoins(v, UPPER), [], name);
      equalFor(v, base, [BREE, DISPLAY], name);
      assert.deepEqual(levelsAt(visionRules.sightFor(v, UPPER, "union"), subsOf()), levelsAt(visionRules.sightFor(base, UPPER, "union"), subsOf()), `${name}: no light from below`);
    }
  });
});

describe("O9: a blackout over a join", () => {
  test("every copy equals a room without the far floor", () => {
    const dark = (s: RoomState): RoomState => ({ ...s, meta: { ...s.meta, view: { ...s.meta.view, blackout: true } } });
    const joined = dark(withAll(openTower({ ground: "bright", upper: "bright" }), [pc("thorn", "p1", GROUND, 3, 3), goblin("g1", UPPER, 6, 6)]));
    const scenes = { ...joined.scenes };
    delete scenes[UPPER];
    const without: RoomState = { ...joined, scenes, floorLinks: {}, openFloors: {}, tokens: { thorn: joined.tokens.thorn! } };
    equalFor(joined, without, [ANA, BREE, DISPLAY], "behind a blackout");
    assert.deepEqual(openingJoins(joined, GROUND), []);
  });
});

describe("O16: two floors seen, equal light at the join from different lamps below", () => {
  test("every copy is the same", () => {
    const base = withAll(openTower(), [pc("thorn", "p1", UPPER, 3, 3)]);
    const west = withAll(base, [], [lamp("l1", GROUND, 3.5, 7, { bright: 30, dim: 0 })]);
    const east = withAll(base, [], [lamp("l2", GROUND, 11.5, 7, { bright: 30, dim: 0 })]);
    assert.ok(levelsAt(visionRules.sightFor(west, UPPER, "shared"), subsOf()).every((v) => v === BRIGHT));
    equalFor(west, east, [ANA, BREE, DISPLAY], "a lamp to the west or to the east");
  });
});
