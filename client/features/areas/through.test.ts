import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, OPENING_RECT, UPPER, run, thornToken, tower, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import type { AreaTemplate, RoomState, Scene, Token, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { AreaThrough, AreaToken } from "#shared/rules/aoe.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import type { Ground } from "#shared/rules/held.ts";
import { deepClone, reveal, template, token } from "#shared/testutil.ts";
import { areaContext, cachedCoverage, caughtTokens, contextFrom, throughLive } from "./coverage.ts";
import { liveGroundOf } from "./liveGround.ts";
import { openingsFrom, pageFloors, throughInputs } from "./through.ts";

/*
 * Areas through openings (docs/design/design-v1-floors.md phase 4, 9.2): the
 * gate every device reads alike, the floors' separation each opening adds
 * to a creature's height, and who an area's list names across an opening,
 * the DM's and a player's device's.
 */

const reached = (state: RoomState, ...ids: string[]): RoomState => ({ ...state, openFloors: { ...state.openFloors, ...Object.fromEntries(ids.map((id) => [id, { sceneId: id, rev: 1 }])) } });
const goblin = (id: string, sceneId: string, x: number, y: number, over: Partial<Token> = {}): Token => token(id, { name: "Goblin", sceneId, x, y, ...over });
const copyOf = (state: RoomState, viewer: Viewer): RoomState => projectState(state, viewer, { sceneId: state.meta.playerSceneId }) as unknown as RoomState;

/** The tower with Thorn upstairs at 2, 2, Upper floor reached, the opening o1 (Upper) over o2 (Ground) at 6, 6, and a goblin below the hole. */
function holed(over: { tokens?: Token[]; opening?: boolean } = {}): RoomState {
  const tokens = Object.fromEntries([thornToken({ sceneId: UPPER, x: 2, y: 2 }), goblin("below", GROUND, 6, 6), ...(over.tokens ?? [])].map((t) => [t.id, t]));
  const base = reached(tower({ tokens }), UPPER);
  return over.opening === false ? base : withOpening(base);
}

const DOWN: AreaThrough = { sceneId: GROUND, rect: OPENING_RECT, dz: -10 };

describe("which floors an area reaches", () => {
  test("from the hole, the floor below at minus the floor's height, and from below, the floor above at plus it", () => {
    const s = holed();
    assert.deepEqual(openingsFrom(s, UPPER), [DOWN]);
    assert.deepEqual(openingsFrom(s, GROUND), [{ sceneId: UPPER, rect: OPENING_RECT, dz: 10 }]);
    assert.deepEqual(openingsFrom(s, ATTIC), [], "no opening there");
    assert.deepEqual(pageFloors(s, UPPER), [UPPER, GROUND]);
    assert.deepEqual(pageFloors(s, ATTIC), [ATTIC]);
  });

  test("the separation is the floor's height alone, whatever the grounds under the hole", () => {
    const tall = holed();
    const raised = { ...tall, scenes: { ...tall.scenes, [UPPER]: { ...tall.scenes[UPPER]!, floor: { ...tall.scenes[UPPER]!.floor!, height: 15 } } } };
    assert.equal(openingsFrom(raised, UPPER)[0]!.dz, -15);
    // Ground floor sunk 5 ft under the hole, Upper floor raised 5 ft round it: still 10 ft.
    let s = run(holed({ opening: false }), { t: "build.height", sceneId: GROUND, cells: ["6,6", "7,6", "6,7", "7,7"], height: -5 });
    s = run(s, { t: "build.height", sceneId: UPPER, cells: ["6,6", "7,6", "6,7", "7,7"], height: 5 });
    s = withOpening(s);
    assert.deepEqual(openingsFrom(s, UPPER).map((j) => j.dz), [-10]);
    assert.deepEqual(openingsFrom(s, GROUND).map((j) => j.dz), [10]);
  });

  test("vision off still reaches: the gate is players seeing both floors", () => {
    const s = holed();
    const dark = { ...s, scenes: Object.fromEntries(Object.entries(s.scenes).map(([id, sc]) => [id, { ...sc, vision: { on: false, light: "dark" as const } }])) } as RoomState;
    assert.deepEqual(openingsFrom(dark, UPPER), [DOWN]);
  });

  test("a floor not reached, a blackout, a floor held only through a hidden creature, and stairs reach nothing", () => {
    const unreached = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: GROUND }) } }));
    assert.deepEqual(openingsFrom(unreached, GROUND), []);
    assert.deepEqual(openingsFrom(unreached, UPPER), []);
    const s = holed();
    assert.deepEqual(openingsFrom({ ...s, meta: { ...s.meta, view: { follow: false, blackout: true } } }, UPPER), []);
    const hidden = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, visibility: "dm" }) } }));
    assert.deepEqual(openingsFrom(hidden, GROUND), [], "Upper floor is held by Ana through hidden Thorn only");
    assert.deepEqual(openingsFrom(withStairs(holed({ opening: false }), { sceneId: UPPER, to: GROUND, rect: { x: 6, y: 6, w: 2, h: 1 } }), UPPER), []);
  });

  test("a player's copy reaches through the openings it was sent, alike, and none whose end lies under full fog", () => {
    const s = holed();
    assert.deepEqual(openingsFrom(copyOf(s, ANA), UPPER), openingsFrom(s, UPPER));
    assert.deepEqual(openingsFrom(copyOf(s, ANA), GROUND), openingsFrom(s, GROUND));
    const fogged = deepClone({ ...s, scenes: { ...s.scenes, [UPPER]: { ...s.scenes[UPPER]!, fogEnabled: true } } });
    reveal(fogged, UPPER, { x: 0, y: 0, w: 5, h: 5 });
    assert.deepEqual(openingsFrom(fogged, UPPER), [DOWN], "the DM reaches through it");
    assert.deepEqual(openingsFrom(copyOf(fogged, ANA), UPPER), [], "Ana's device does not know it is there");
  });
});

describe("who an area's list names across an opening", () => {
  const fireball = (over: Partial<AreaTemplate> = {}): AreaTemplate => template("f1", { sceneId: UPPER, size: 20, origin: { x: 7, y: 7, z: 0 }, ...over });
  const listOf = (view: RoomState, role: "dm" | "player", area = fireball(), live = false) => {
    const scene = view.scenes[UPPER]!;
    const ctx = live ? contextFrom({ tokens: view.tokens, buildChunks: view.buildChunks, settings: view.meta.settings, live: liveGroundOf({ scene, role, fogTiles: view.fogTiles, sight: {} }) }, scene) : areaContext(view, scene);
    return caughtTokens(area, ctx, UPPER, throughInputs(view, UPPER, role));
  };

  test("a fireball over a hole names the goblin below after those on its own floor, with vision off too", () => {
    const s = holed({ tokens: [goblin("up1", UPPER, 8, 8)] });
    assert.deepEqual(listOf(s, "dm"), ["up1", "below"]);
    const ctx = areaContext(s, s.scenes[UPPER]!);
    assert.deepEqual(caughtTokens(fireball(), ctx, UPPER), ["up1"], "a list for the board, without the openings, keeps to its floor");
    const dark = { ...s, scenes: Object.fromEntries(Object.entries(s.scenes).map(([id, sc]) => [id, { ...sc, vision: { on: false, light: "dark" as const } }])) } as RoomState;
    assert.deepEqual(listOf(dark, "dm"), ["up1", "below"]);
  });

  test("a hidden goblin below is the DM's alone, and a floor below not reached names no one", () => {
    const s = holed({ tokens: [goblin("lurker", GROUND, 7, 7, { visibility: "dm" })] });
    assert.deepEqual(listOf(s, "dm"), ["below", "lurker"]);
    assert.deepEqual(listOf(copyOf(s, ANA), "player"), ["below"]);
    const unreached = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: GROUND, x: 2, y: 2 }), up: goblin("up", UPPER, 6, 6) } }));
    const fromBelow = template("f2", { sceneId: GROUND, size: 20, origin: { x: 7, y: 7, z: 0 } });
    const scene = unreached.scenes[GROUND]!;
    assert.deepEqual(caughtTokens(fromBelow, areaContext(unreached, scene), GROUND, throughInputs(unreached, GROUND, "dm")), [], "Upper floor not reached: nothing across");
  });

  test("the same list, the same array, while nothing changes", () => {
    const s = holed();
    const ctx = areaContext(s, s.scenes[UPPER]!);
    const through = throughInputs(s, UPPER, "dm");
    assert.equal(caughtTokens(fireball(), ctx, UPPER, through), caughtTokens(fireball(), ctx, UPPER, through));
  });
});

describe("a player's device lists a creature across an opening only on live ground", () => {
  /** A ground live everywhere but `dead` cells, on a 20 by 20 square floor. */
  function ground(sceneId: string, dead: readonly string[] = []): Ground {
    const off = new Set(dead);
    const live = (x: number, y: number) => x >= 0 && y >= 0 && x < 20 && y < 20 && !off.has(`${x},${y}`);
    return { sceneId, grid: SQUARES, bounds: { w: 20, h: 20 }, fogged: true, remembers: true, holder: null, live, keyLive: (k: string) => !off.has(k) } as unknown as Ground;
  }
  const s = holed();
  const scene: Scene = s.scenes[UPPER]!;
  const ctx = areaContext(s, scene);
  // A fireball cast from the west, so its rays to the hole cross columns 4 and 5 upstairs.
  const area = template("f1", { sceneId: UPPER, size: 25, origin: { x: 3, y: 7, z: 0 } });
  const ogre: AreaToken = token("ogre", { size: "large", sceneId: GROUND, x: 5, y: 6 });

  test("every ray upstairs, and the part over the hole below, live", () => {
    assert.equal(throughLive(area, ogre, ctx, DOWN, ground(UPPER), ground(GROUND)), true);
    assert.equal(throughLive(area, ogre, ctx, DOWN, null, null), true, "fog off on both floors");
  });

  test("a dead cell on the rays upstairs, or under the part over the hole below, keeps it off the list", () => {
    assert.equal(throughLive(area, ogre, ctx, DOWN, ground(UPPER, ["5,7"]), ground(GROUND)), false);
    assert.equal(throughLive(area, ogre, ctx, DOWN, ground(UPPER), ground(GROUND, ["6,7"])), false);
    assert.equal(throughLive(area, ogre, ctx, DOWN, null, ground(GROUND, ["6,6"])), false);
  });

  test("ground outside the column below never counts: the ogre's half beside the hole may be dark", () => {
    assert.equal(throughLive(area, ogre, ctx, DOWN, ground(UPPER), ground(GROUND, ["5,6", "5,7"])), true);
    assert.equal(throughLive(area, ogre, ctx, DOWN, ground(UPPER, ["12,12"]), ground(GROUND)), true, "nor a dead cell off the rays upstairs");
  });

  test("a creature with nothing over the hole is never live across it", () => {
    assert.equal(throughLive(area, token("far", { sceneId: GROUND, x: 12, y: 12 }), ctx, DOWN, null, null), false);
  });

  test("its list drops a creature whose part below is not live", () => {
    const view = holed({ tokens: [ogre as Token] });
    const through = throughInputs(view, UPPER, "player")!;
    const live = { ...through, grounds: new Map([[GROUND, ground(GROUND, ["6,7"])]]) };
    assert.deepEqual(caughtTokens(area, { ...ctx, live: ground(UPPER) }, UPPER, through).filter((id) => id !== "thorn"), ["below", "ogre"]);
    assert.deepEqual(caughtTokens(area, { ...ctx, live: ground(UPPER) }, UPPER, live).filter((id) => id !== "thorn"), ["below"]);
    assert.deepEqual(caughtTokens(area, { ...ctx, live: ground(UPPER, ["5,7"]) }, UPPER, through).filter((id) => id !== "thorn"), []);
  });
});

describe("O10: a player's area over a hole reads nothing under fog below", () => {
  const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
  const BREE: Viewer = { memberId: "p2", role: "player" };
  /** Fog on both floors, revealed upstairs and over the hole below, and under fog below a hidden goblin, a wall or raised ground at the fireball's edge, or nothing. */
  function room(below: "hidden" | "wall" | "ground" | "none"): RoomState {
    const base = holed(below === "hidden" ? { tokens: [goblin("lurker", GROUND, 8, 6, { visibility: "dm" })] } : {});
    let s: RoomState = deepClone({ ...base, scenes: { ...base.scenes, [UPPER]: { ...base.scenes[UPPER]!, fogEnabled: true }, [GROUND]: { ...base.scenes[GROUND]!, fogEnabled: true } } });
    if (below === "wall") s = { ...s, buildChunks: { [`${GROUND}:0,0`]: { sceneId: GROUND, cx: 0, cy: 0, rev: 1, cells: {}, edges: { "9,6,w": { kind: "wall" }, "9,7,w": { kind: "wall" } } } } };
    if (below === "ground") s = run(s, { t: "build.height", sceneId: GROUND, cells: ["8,6", "8,7", "9,6"], height: 10 });
    reveal(s, UPPER, { x: 0, y: 0, w: 12, h: 12 });
    reveal(s, GROUND, { x: 6, y: 6, w: 2, h: 2 });
    return s;
  }
  // Ana's fireball upstairs over the hole, its edge at the fogged squares below.
  const area = template("f1", { sceneId: UPPER, size: 10, origin: { x: 7, y: 7, z: 0 }, ownerId: "p1" });
  function seen(state: RoomState, viewer: Viewer): { list: string[]; cells: string } {
    const copy = copyOf(state, viewer);
    const scene = copy.scenes[UPPER]!;
    const live = liveGroundOf({ scene, role: "player", fogTiles: copy.fogTiles, sight: {} });
    const ctx = contextFrom({ tokens: copy.tokens, buildChunks: copy.buildChunks, settings: copy.meta.settings, ...(live ? { live } : {}) }, scene);
    const through = throughInputs(copy, UPPER, "player");
    return { list: caughtTokens(area, ctx, UPPER, through), cells: cachedCoverage(area, ctx).cells.map((c) => `${c.x},${c.y}`).join(" ") };
  }

  for (const below of ["hidden", "wall", "ground"] as const) {
    test(`${below} or none: Ana, Bree and the display list the same across the hole`, () => {
      const [a, b] = [room(below), room("none")];
      assert.deepEqual(seen(b, ANA).list, ["below"], "the goblin below is listed");
      for (const viewer of [ANA, BREE, DISPLAY]) assert.deepEqual(seen(a, viewer), seen(b, viewer), `${viewer.memberId}`);
    });
  }
});
