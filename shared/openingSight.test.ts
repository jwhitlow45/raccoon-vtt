import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER } from "./floorLinksTestutil.ts";
import type { RoomState, Token } from "./model.ts";
import { goblin, lamp, levelsAt, openTower, pc, subsOf, tilesOf, withAll, withWall } from "./openingsTestutil.ts";
import { projectState } from "./project.ts";
import { coldSightFor, visionRules } from "./ruleHooks.ts";
import { SQUARES } from "./rules/grid.ts";
import { openingJoins } from "./rules/openingSight.ts";
import { BRIGHT, NOT_SEEN } from "./rules/vision.ts";

/*
 * Sight and light through an opening (docs/design/design-v1-floors.md
 * phase 4, 7.1): while players see both floors and both use party vision,
 * the hole's sub-cells are lit at the brighter of the two floors' own light
 * there, and each class sees them at the better of its own level and the
 * other floor's. The tower's opening is 2 by 2 at 6, 6 between Upper floor
 * and Ground floor.
 */

const HOLE = subsOf();
const shared = (state: RoomState, sceneId: string) => visionRules.sightFor(state, sceneId, "shared");
const union = (state: RoomState, sceneId: string) => visionRules.sightFor(state, sceneId, "union");
const tokenIds = (state: RoomState, who = ANA) => Object.keys(projectState(state, who, { sceneId: null }).tokens).sort();
const every = (levels: number[], level: number) => levels.every((v) => v === level);

describe("a dark upper floor over a lit hall, both open, whole party (7.1)", () => {
  const thorn = pc("thorn", "p1", UPPER, 3, 3);
  const under = goblin("g1", GROUND, 6, 6);
  const away = goblin("g2", GROUND, 14, 14);
  const room = withAll(openTower({ ground: "bright", upper: "dark" }), [thorn, under, away]);
  const plain = withAll(openTower({ ground: "bright", upper: "dark" }, { opening: false }), [thorn, under, away]);

  test("the opening joins each floor to the other", () => {
    assert.deepEqual(
      openingJoins(room, UPPER).map((j) => [j.linkId, j.other, j.subs.length]),
      [["o1", GROUND, HOLE.length]],
    );
    assert.deepEqual(
      openingJoins(room, GROUND).map((j) => [j.linkId, j.other]),
      [["o2", UPPER]],
    );
  });

  test("the hall's light lights the hole upstairs, so Thorn sees it bright without darkvision", () => {
    assert.ok(every(levelsAt(shared(room, UPPER), HOLE), BRIGHT));
    assert.ok(every(levelsAt(shared(plain, UPPER), HOLE), NOT_SEEN), "without the opening the hole is dark");
    assert.ok(every(levelsAt(union(room, UPPER), HOLE), BRIGHT));
  });

  test("the goblin under the hole is seen from above, and one elsewhere below is not", () => {
    assert.equal(shared(room, GROUND).seesToken(under, SQUARES), true);
    assert.equal(shared(room, GROUND).seesToken(away, SQUARES), false);
    assert.equal(shared(plain, GROUND).seesToken(under, SQUARES), false);
    assert.deepEqual(tokenIds(room), ["g1", "thorn"]);
    assert.deepEqual(tokenIds(room, BREE), ["g1", "thorn"]);
    assert.deepEqual(tokenIds(plain), ["thorn"]);
  });

  test("the point query answers as the tiles do", () => {
    const sight = shared(room, GROUND);
    const fresh = (t: Token) => visionRules.sightFromTiles(Object.fromEntries([...sight.tiles].map(([at, tile]) => [`${GROUND}:${at}`, tile])), GROUND).seesToken(t, SQUARES);
    for (const t of [under, away, goblin("g3", GROUND, 7.5, 7.5), goblin("g4", GROUND, 8, 8), goblin("g5", GROUND, 5.2, 5.2, { size: "large" })]) {
      assert.equal(shared(room, GROUND).seesToken(t, SQUARES), fresh(t), t.id);
    }
  });
});

describe("a lit upper floor over a dark hall (7.1)", () => {
  const thorn = pc("thorn", "p1", GROUND, 3, 3);
  const under = goblin("g1", GROUND, 7, 7);
  const away = goblin("g2", GROUND, 12, 3);
  const bat = goblin("bat", UPPER, 6, 6, { elevation: 5 });
  const batAway = goblin("bat2", UPPER, 14, 14, { elevation: 5 });
  const room = withAll(openTower({ ground: "dark", upper: "bright" }), [thorn, under, away, bat, batAway]);

  test("the hole below is lit by the floor above, and what stands in it is seen", () => {
    assert.ok(every(levelsAt(shared(room, GROUND), HOLE), BRIGHT));
    assert.equal(shared(room, GROUND).seesToken(under, SQUARES), true);
    assert.equal(shared(room, GROUND).seesToken(away, SQUARES), false);
  });

  test("the floor above sees the column through the party below", () => {
    assert.ok(every(levelsAt(shared(room, UPPER), HOLE), BRIGHT));
    assert.equal(shared(room, UPPER).seesToken(bat, SQUARES), true);
    assert.equal(shared(room, UPPER).seesToken(batAway, SQUARES), false);
    assert.deepEqual(tokenIds(room), ["bat", "g1", "thorn"]);
  });
});

describe("no join (7.1): a floor not reached, vision off on one, a blackout, a floor held only through a hidden creature", () => {
  const twins = (make: (opening: boolean) => RoomState) => [make(true), make(false)] as const;
  const cases: [string, (opening: boolean) => RoomState][] = [
    ["Upper floor not reached", (opening) => withAll(openTower({ ground: "dark", upper: "bright" }, { opening, reached: false }), [pc("thorn", "p1", GROUND, 3, 3), goblin("g1", GROUND, 7, 7)])],
    [
      "vision off upstairs",
      (opening) => {
        const s = withAll(openTower({ ground: "dark", upper: "bright" }, { opening }), [pc("thorn", "p1", GROUND, 3, 3), goblin("g1", GROUND, 7, 7)]);
        return { ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, vision: { on: false, light: "bright" } } } };
      },
    ],
    [
      "a blackout",
      (opening) => {
        const s = withAll(openTower({ ground: "dark", upper: "bright" }, { opening }), [pc("thorn", "p1", GROUND, 3, 3), goblin("g1", GROUND, 7, 7)]);
        return { ...s, meta: { ...s.meta, view: { ...s.meta.view, blackout: true } } };
      },
    ],
    [
      "Upper floor held only through a creature the DM hid",
      (opening) => withAll(openTower({ ground: "dark", upper: "bright" }, { opening, reached: false }), [pc("thorn", "p1", GROUND, 3, 3), pc("scout", "p1", UPPER, 6, 6, { visibility: "dm" }), goblin("g1", GROUND, 7, 7)]),
    ],
  ];
  for (const [name, make] of cases) {
    test(name, () => {
      const [room, plain] = twins(make);
      assert.deepEqual(openingJoins(room, UPPER), [], "no join upstairs");
      assert.deepEqual(openingJoins(room, GROUND), [], "no join below");
      for (const sceneId of [GROUND, UPPER]) {
        for (const cls of ["shared", "union", { holder: "p1" }] as const) {
          assert.deepEqual(tilesOf(visionRules.sightFor(room, sceneId, cls)), tilesOf(visionRules.sightFor(plain, sceneId, cls)), `${sceneId} ${JSON.stringify(cls)}`);
        }
      }
      assert.equal(shared(room, GROUND).seesToken(room.tokens.g1!, SQUARES), false, "the hole below stays dark");
    });
  }
});

describe("light crosses only where it reaches the hole, by its own floor's walls (7.1, 10.4)", () => {
  const thorn = pc("thorn", "p1", UPPER, 3, 3);
  const dark = withAll(openTower(), [thorn]);
  const hole = (state: RoomState) => levelsAt(shared(state, UPPER), HOLE);

  test("a lamp under the hole lights it upstairs, one far away does not and changes nothing", () => {
    assert.ok(every(hole(dark), NOT_SEEN));
    assert.ok(hole(withAll(dark, [], [lamp("l1", GROUND, 7, 7)])).every((v) => v > NOT_SEEN));
    const far = withAll(dark, [], [lamp("l1", GROUND, 16, 16)]);
    assert.deepEqual(tilesOf(shared(far, UPPER)), tilesOf(shared(dark, UPPER)));
    // Only the lights whose reach meets the hole enter the floor's inputs, so one moving elsewhere below costs nothing upstairs.
    const lit = withAll(dark, [], [lamp("l1", GROUND, 7, 7)]);
    const farther = withAll(lit, [], [lamp("l2", GROUND, 16, 16)]);
    assert.equal(visionRules.partySight(withAll(farther, [], [lamp("l2", GROUND, 17, 3)]), UPPER), visionRules.partySight(farther, UPPER));
  });

  test("a wall below between the lamp and the hole keeps it dark, and the same wall upstairs does not", () => {
    const lit = withAll(dark, [], [lamp("l1", GROUND, 7, 11, { bright: 20, dim: 10 })]);
    assert.ok(hole(lit).some((v) => v > NOT_SEEN), "the lamp reaches the hole");
    assert.ok(every(hole(withWall(lit, GROUND, "w1", 3, 9.5, 11, 9.5)), NOT_SEEN), "its own floor's wall stops it");
    assert.deepEqual(hole(withWall(lit, UPPER, "w1", 3, 9.5, 11, 9.5)), hole(lit), "the other floor's walls never stop it");
  });

  test("a hidden creature's torch below lends no light (10.2)", () => {
    const torch = { bright: 20, dim: 20 };
    const hidden = withAll(dark, [goblin("g1", GROUND, 7, 7, { visibility: "dm", light: torch })]);
    const none = withAll(dark, [goblin("g1", GROUND, 7, 7, { visibility: "dm" })]);
    assert.deepEqual(tilesOf(shared(hidden, UPPER)), tilesOf(shared(none, UPPER)));
    assert.ok(hole(withAll(dark, [goblin("g1", GROUND, 7, 7, { light: torch })])).some((v) => v > NOT_SEEN), "a shown one's torch lights it");
  });

  test("a dim floor lends its dim light, and a bright floor borrows nothing", () => {
    const dim = withAll(openTower({ ground: "dim" }), [thorn]);
    assert.ok(hole(dim).every((v) => v === 2));
    const bright = withAll(openTower({ upper: "bright" }), [thorn]);
    assert.ok(every(hole(bright), BRIGHT));
  });
});

describe("a wall moved below with a source only upstairs (D-261119-101)", () => {
  test("changes the column, and the warm answer equals the cold one", () => {
    const thorn = pc("thorn", "p1", UPPER, 3, 3);
    const lit = withAll(openTower(), [thorn], [lamp("l1", GROUND, 7, 11, { bright: 20, dim: 10 })]);
    const hole = (state: RoomState) => levelsAt(shared(state, UPPER), HOLE);
    assert.ok(hole(lit).some((v) => v > NOT_SEEN));
    const walled = withWall(lit, GROUND, "w1", 3, 9.5, 11, 9.5);
    assert.ok(every(hole(walled), NOT_SEEN), "the warm answer reads the wall below");
    assert.deepEqual(tilesOf(shared(walled, UPPER)), tilesOf(coldSightFor(walled, UPPER, "shared")));
    const elsewhere = withWall(lit, GROUND, "w2", 14, 2, 14, 6);
    assert.deepEqual(hole(elsewhere), hole(lit), "a wall away from the lamp's reach changes nothing");
    assert.deepEqual(tilesOf(shared(elsewhere, UPPER)), tilesOf(coldSightFor(elsewhere, UPPER, "shared")));
    assert.ok(hole(lit).some((v) => v > NOT_SEEN), "back to the first room, lit again");
  });
});
