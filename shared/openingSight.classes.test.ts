import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER } from "./floorLinksTestutil.ts";
import type { RoomState, SceneId, SightHolder, Viewer } from "./model.ts";
import { ally, goblin, joinedGrid, levelGrid, openTower, pc, subsOf, withAll, withWall } from "./openingsTestutil.ts";
import { changedSightKeys, projectState, withheldFromViewer } from "./project.ts";
import { keys } from "./keys.ts";
import { classSight } from "./rules/held.ts";
import { visionRules, type PendingJoins, type SightClass } from "./ruleHooks.ts";
import { actor, DM } from "./testutil.ts";

/*
 * Sight joins class with class (docs/design/design-v1-floors.md phase 4,
 * 7.2, D-261119-084, 100 and 121): each row of the table, in both mixed
 * directions, so no class borrows what another class may not see. Both
 * floors are dark, and each source sees 2 cells round it by darkvision:
 * Ana's scout below and Bree's scout upstairs each see one side of the
 * hole, the shared allies see nothing of it.
 */

const HOLE = subsOf();
const DV = "Darkvision 10 ft";
const DISPLAY: Viewer = { memberId: "display:table", role: "player" };

const sources = [
  pc("anaScout", "p1", GROUND, 5, 6, {}, DV),
  pc("breeScout", "p2", UPPER, 9, 6, {}, DV),
  ally("allyBelow", GROUND, 16, 16, { actor: { inline: actor({ senses: DV }) } }),
  ally("allyAbove", UPPER, 16, 16, { actor: { inline: actor({ senses: DV }) } }),
];

/** The room, with Ana's scout on `scoutOn`, below unless told. */
function room(perPlayer: SceneId[], holders: Readonly<Record<SceneId, readonly SightHolder[]>>, scoutOn: SceneId = GROUND): RoomState {
  const state = withAll(openTower({}, { perPlayer }), sources.map((t) => (t.id === "anaScout" ? { ...t, sceneId: scoutOn } : t)));
  return { ...state, holders: Object.fromEntries(Object.entries(holders).map(([sceneId, entries]) => [sceneId, { sceneId, rev: 0, entries: [...entries] }])) };
}

/** Each floor's own answers, straight from the rules. */
const own = {
  union: (s: RoomState, f: SceneId) => visionRules.partySight(s, f),
  shared: (s: RoomState, f: SceneId) => (s.scenes[f]!.vision?.perPlayer ? visionRules.holderSight(s, f, null) : visionRules.partySight(s, f)),
  holder: (s: RoomState, f: SceneId, m: string) => visionRules.holderSight(s, f, m),
};

const other = (f: SceneId) => (f === UPPER ? GROUND : UPPER);
const grid = (s: RoomState, f: SceneId, cls: SightClass, pending?: PendingJoins) => levelGrid(visionRules.sightFor(s, f, cls, pending));
const projected = (s: RoomState, viewer: Viewer, f: SceneId) => {
  const sight = projectState(s, viewer, { sceneId: GROUND }).sight ?? {};
  return levelGrid(visionRules.sightFromTiles(sight, f));
};
const leftOfHole = (g: Uint8Array) => HOLE.filter(([sx]) => sx < 28).map(([sx, sy]) => g[sy * 80 + sx]!);
const rightOfHole = (g: Uint8Array) => HOLE.filter(([sx]) => sx >= 30).map(([sx, sy]) => g[sy * 80 + sx]!);

describe("each row of 7.2's table", () => {
  test("the DM reads the union joined with the other floor's union, on every floor and setting", () => {
    for (const perPlayer of [[], [GROUND], [UPPER], [GROUND, UPPER]]) {
      const s = room(perPlayer, { [GROUND]: [{ memberId: "p1", on: true }], [UPPER]: [{ memberId: "p2", on: true }] });
      for (const f of [GROUND, UPPER]) {
        const expected = joinedGrid(own.union(s, f), own.union(s, other(f)), HOLE);
        assert.deepEqual(grid(s, f, "union"), expected, `${f} ${perPlayer}`);
        assert.deepEqual(projected(s, DM, f), expected, `the DM's projection of ${f}`);
        assert.ok(leftOfHole(expected).some((v) => v > 0) && rightOfHole(expected).some((v) => v > 0), "both scouts' sides");
      }
    }
  });

  test("whole party over per-player: players and a display on the whole-party floor read shared with shared, so Ana's own view below is lent to no one", () => {
    const s = room([GROUND], { [GROUND]: [{ memberId: "p1", on: true }] });
    const expected = joinedGrid(own.shared(s, UPPER), own.shared(s, GROUND), HOLE);
    assert.deepEqual(grid(s, UPPER, "shared"), expected);
    for (const viewer of [ANA, BREE, DISPLAY]) assert.deepEqual(projected(s, viewer, UPPER), expected, viewer.memberId);
    assert.ok(leftOfHole(expected).every((v) => v === 0), "Ana's scout below lends nothing to the whole-party floor");
    assert.ok(rightOfHole(expected).some((v) => v > 0), "Bree's scout sees its side upstairs");
    // Below, a holder reads their own joined with the whole-party floor's shared, which is every source's there.
    const ana = joinedGrid(own.holder(s, GROUND, "p1"), own.shared(s, UPPER), HOLE);
    assert.deepEqual(grid(s, GROUND, { holder: "p1" }), ana);
    assert.deepEqual(projected(s, ANA, GROUND), ana);
    const others = joinedGrid(own.shared(s, GROUND), own.shared(s, UPPER), HOLE);
    for (const viewer of [BREE, DISPLAY]) assert.deepEqual(projected(s, viewer, GROUND), others, viewer.memberId);
    assert.ok(leftOfHole(others).every((v) => v === 0), "Bree never reads Ana's scout");
  });

  test("per-player over whole party: a holder upstairs reads their own joined with the floor below's shared, and every other player shared with shared", () => {
    const s = room([UPPER], { [UPPER]: [{ memberId: "p2", on: true }] });
    const bree = joinedGrid(own.holder(s, UPPER, "p2"), own.shared(s, GROUND), HOLE);
    assert.deepEqual(grid(s, UPPER, { holder: "p2" }), bree);
    assert.deepEqual(projected(s, BREE, UPPER), bree);
    const rest = joinedGrid(own.shared(s, UPPER), own.shared(s, GROUND), HOLE);
    for (const viewer of [ANA, DISPLAY]) assert.deepEqual(projected(s, viewer, UPPER), rest, viewer.memberId);
    assert.ok(rightOfHole(rest).every((v) => v === 0), "Bree's own scout is lent to no one else upstairs");
    assert.ok(leftOfHole(rest).some((v) => v > 0), "the whole-party floor below lends every player its sight");
  });

  test("per-player on both: a holder ticked on both reads their own on both, and their own joined with shared where they hold no enabled entry", () => {
    const both = room([GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: true }], [UPPER]: [{ memberId: "p1", on: true }] });
    const mine = joinedGrid(own.holder(both, UPPER, "p1"), own.holder(both, GROUND, "p1"), HOLE);
    assert.deepEqual(grid(both, UPPER, { holder: "p1" }), mine);
    assert.deepEqual(projected(both, ANA, UPPER), mine);
    assert.ok(leftOfHole(mine).some((v) => v > 0), "Ana's own scout below lends to Ana upstairs");
    for (const [name, below] of [
      ["unticked below", [{ memberId: "p1", on: false }]],
      ["unlisted below", []],
    ] as const) {
      const s = room([GROUND, UPPER], { [GROUND]: [...below], [UPPER]: [{ memberId: "p1", on: true }] });
      const expected = joinedGrid(own.holder(s, UPPER, "p1"), own.shared(s, GROUND), HOLE);
      assert.deepEqual(grid(s, UPPER, { holder: "p1" }), expected, name);
      assert.deepEqual(projected(s, ANA, UPPER), expected, name);
      assert.ok(leftOfHole(expected).every((v) => v === 0), `${name}: her view below is off, so it lends nothing`);
    }
  });

  test("any other player on a per-player floor reads shared with shared", () => {
    const s = room([GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: true }], [UPPER]: [{ memberId: "p1", on: true }] });
    const expected = joinedGrid(own.shared(s, UPPER), own.shared(s, GROUND), HOLE);
    for (const viewer of [BREE, DISPLAY]) assert.deepEqual(projected(s, viewer, UPPER), expected, viewer.memberId);
    assert.deepEqual(grid(s, UPPER, "shared"), expected);
    assert.ok(leftOfHole(expected).every((v) => v === 0) && rightOfHole(expected).every((v) => v === 0));
  });

  test("an exploration's pending entry lends only while it is on (D-261119-121)", () => {
    const s = room([GROUND, UPPER], { [UPPER]: [{ memberId: "p1", on: true }] });
    const theirs = joinedGrid(own.holder(s, UPPER, "p1"), own.holder(s, GROUND, "p1"), HOLE);
    const shared = joinedGrid(own.holder(s, UPPER, "p1"), own.shared(s, GROUND), HOLE);
    assert.notDeepEqual(theirs, shared);
    assert.deepEqual(grid(s, UPPER, { holder: "p1" }, { [GROUND]: [{ memberId: "p1", on: true }] }), theirs);
    assert.deepEqual(grid(s, UPPER, { holder: "p1" }, { [GROUND]: [{ memberId: "p1", on: false }] }), shared);
    assert.deepEqual(grid(s, UPPER, { holder: "p1" }, { [GROUND]: [{ memberId: "p2", on: true }] }), shared, "another member's entry lends Ana nothing");
    assert.deepEqual(grid(s, UPPER, { holder: "p1" }), shared);
  });
});

describe("only Ana's creature sees the column (O5)", () => {
  // Ana's scout stands on a per-player floor, where it lends to her alone: below, or upstairs over a whole-party floor.
  for (const [name, perPlayer, holders, scoutOn] of [
    ["per-player on both, Ana ticked on both", [GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: true }], [UPPER]: [{ memberId: "p1", on: true }] }, GROUND],
    ["Ana ticked below only", [GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: true }] }, GROUND],
    ["Ana unticked upstairs", [GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: true }], [UPPER]: [{ memberId: "p1", on: false }] }, GROUND],
    ["Ana ticked upstairs only, her scout upstairs", [GROUND, UPPER], { [UPPER]: [{ memberId: "p1", on: true }] }, UPPER],
    ["whole party over per-player", [GROUND], { [GROUND]: [{ memberId: "p1", on: true }] }, GROUND],
    ["per-player over whole party, her scout upstairs", [UPPER], { [UPPER]: [{ memberId: "p1", on: true }] }, UPPER],
  ] as const) {
    test(`${name}: a goblin under the hole or none, Bree's and the display's projections equal`, () => {
      const without = room([...perPlayer], holders, scoutOn);
      const withGoblin = withAll(without, [goblin("g1", GROUND, 6, 6)]);
      for (const viewer of [BREE, DISPLAY]) assert.deepEqual(projectState(withGoblin, viewer, { sceneId: null }), projectState(without, viewer, { sceneId: null }), viewer.memberId);
    });
  }

  test("Ana, ticked below, sees the goblin there", () => {
    const s = withAll(room([GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: true }], [UPPER]: [{ memberId: "p1", on: true }] }), [goblin("g1", GROUND, 6, 6)]);
    assert.ok("g1" in projectState(s, ANA, { sceneId: null }).tokens);
    assert.ok(!("g1" in projectState(s, BREE, { sceneId: null }).tokens));
  });
});

describe("only Ana sees the lower opening, and a wall below moves (O5b)", () => {
  const wallAt = (s: RoomState, x: number) => withWall(s, GROUND, `w${x}`, x, 4, x, 9);
  for (const [name, perPlayer, holders] of [
    ["whole party upstairs, Ana ticked below", [GROUND], { [GROUND]: [{ memberId: "p1", on: true }] }],
    ["Ana ticked upstairs and unticked below", [GROUND, UPPER], { [GROUND]: [{ memberId: "p1", on: false }], [UPPER]: [{ memberId: "p1", on: true }] }],
  ] as const) {
    test(`${name}: Bree's copy and her drag previews upstairs stay the same as Ana's sight below changes`, () => {
      // Ana's scout below sees the hole from its west, and a wall west of it cuts what else it sees, out of Bree's view.
      const s = room([...perPlayer], holders);
      const near = wallAt(s, 4.5);
      const far = wallAt(s, 3.5);
      assert.notDeepEqual(levelGrid(visionRules.holderSight(near, GROUND, "p1")), levelGrid(visionRules.holderSight(far, GROUND, "p1")), "the wall changes Ana's own view below");
      assert.deepEqual(projectState(near, BREE, { sceneId: null }), projectState(far, BREE, { sceneId: null }));
      for (const [x, y] of [
        [6, 6],
        [7, 7],
        [10, 6],
        [4, 6],
      ] as const) {
        const g = goblin("g1", UPPER, x, y, { elevation: 5 });
        assert.equal(withheldFromViewer(near, BREE, g), withheldFromViewer(far, BREE, g), `a drag preview at ${x}, ${y}`);
      }
    });
  }
});

describe("the fan-out's changed sight through a join (7.2)", () => {
  test("a whole-party floor's shared sight that changes while its union does not names its tiles", () => {
    // Ana's scout below already shows the union the hole, so the ally walking up to it changes the shared sight alone.
    const before = room([GROUND], { [GROUND]: [{ memberId: "p1", on: true }] });
    const after = withAll(before, [{ ...before.tokens.allyBelow!, x: 5, y: 6 }]);
    const holeOf = (s: RoomState, cls: SightClass) => levelGrid(visionRules.sightFor(s, UPPER, cls)).filter((_, i) => HOLE.some(([sx, sy]) => sy * 80 + sx === i));
    assert.deepEqual(holeOf(before, "union"), holeOf(after, "union"), "the union upstairs is the same");
    assert.notDeepEqual(holeOf(before, "shared"), holeOf(after, "shared"), "the players' sight upstairs is not");
    assert.ok(changedSightKeys(before, after, [UPPER]).includes(keys.sight(UPPER, 0, 0)));
  });
});

describe("the ground a class reads (rules/held.ts classSight)", () => {
  test("is the class's joined sight: a holder's own on a per-player floor, the shared class's for everyone else", () => {
    const s = room([GROUND], { [GROUND]: [{ memberId: "p1", on: true }] });
    assert.equal(classSight(s, s.scenes[GROUND]!, "p1"), visionRules.sightFor(s, GROUND, { holder: "p1" }));
    assert.equal(classSight(s, s.scenes[GROUND]!, null), visionRules.sightFor(s, GROUND, "shared"));
    assert.equal(classSight(s, s.scenes[UPPER]!, null), visionRules.sightFor(s, UPPER, "shared"));
    // On the whole-party floor every class reads the shared one, which lends nothing of Ana's scout below.
    assert.equal(classSight(s, s.scenes[UPPER]!, "p1"), visionRules.sightFor(s, UPPER, "shared"));
    assert.ok(leftOfHole(levelGrid(classSight(s, s.scenes[UPPER]!, null)!)).every((v) => v === 0));
  });
});
