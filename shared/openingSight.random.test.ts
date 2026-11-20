import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ATTIC, GROUND, UPPER } from "./floorLinksTestutil.ts";
import type { CellRect, FloorLink, LightLevel, RoomState, SceneId, Token } from "./model.ts";
import { ally, goblin, lamp, levelGrid, openTower, pc, withAll, withWall } from "./openingsTestutil.ts";
import { coldSightFor, visionRules, type PartySight, type SightClass } from "./ruleHooks.ts";
import { playersSee } from "./rules/floors.ts";
import { SQUARES } from "./rules/grid.ts";
import { openingJoins } from "./rules/openingSight.ts";
import { rectGround } from "./rules/floorLinks.ts";
import { actor, chance, int, pick, rng } from "./testutil.ts";

/*
 * Warm equals cold through openings (docs/design/design-v1-floors.md phase
 * 4, 7.3 and 15): random rooms of three floors, Upper floor between two
 * openings, whose openings move, resize, go and come back, whose lights,
 * walls, settings, holder lists and creatures change on every floor. After
 * each step every class's warm answer on every floor equals the one
 * computed from nothing, equals 7.2's rule worked out from the floors' own
 * answers, and a state with the same inputs gets the identical object.
 */

const FLOORS = [GROUND, UPPER, ATTIC] as const;
const CLASSES: SightClass[] = ["union", "shared", { holder: "p1" }, { holder: "p2" }];
const DV = "Darkvision 10 ft";

/** The two openings: Ground floor to Upper floor (o1 upstairs, o2 below), Upper floor to Attic (a1 in the attic, a2 on Upper floor). */
const PAIRS = [
  { id: "o1", pairId: "o2", upper: UPPER, lower: GROUND },
  { id: "a1", pairId: "a2", upper: ATTIC, lower: UPPER },
] as const;

function putPair(state: RoomState, pair: (typeof PAIRS)[number], rect: CellRect, rev: number): RoomState {
  const end = (id: string, sceneId: SceneId, to: SceneId, other: string): FloorLink => ({ id, rev, sceneId, to, pair: other, rect: { ...rect }, kind: "opening", ground: rectGround(state.buildChunks, sceneId, rect) ?? 0, made: 90 });
  return { ...state, floorLinks: { ...state.floorLinks, [pair.id]: end(pair.id, pair.upper, pair.lower, pair.pairId), [pair.pairId]: end(pair.pairId, pair.lower, pair.upper, pair.id) } };
}

function dropPair(state: RoomState, pair: (typeof PAIRS)[number]): RoomState {
  const links = { ...state.floorLinks };
  delete links[pair.id];
  delete links[pair.pairId];
  return { ...state, floorLinks: links };
}

function overlaps(a: CellRect, b: CellRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function randomRect(r: () => number): CellRect {
  const w = int(r, 1, 4);
  const h = int(r, 1, 4);
  return { x: int(r, 0, 20 - w), y: int(r, 0, 20 - h), w, h };
}

const CREATURES: Token[] = [
  pc("anaScout", "p1", GROUND, 5, 6, {}, DV),
  pc("breeScout", "p2", UPPER, 9, 6, {}, DV),
  pc("caraScout", "p3", ATTIC, 3, 3, {}, DV),
  ally("allyBelow", GROUND, 12, 12, { actor: { inline: actor({ senses: DV }) } }),
  goblin("torch", UPPER, 14, 4, { light: { bright: 10, dim: 10 } }),
  goblin("g1", GROUND, 7, 7),
];

function step(r: () => number, s: RoomState): RoomState {
  const floor = pick(r, FLOORS);
  switch (int(r, 0, 9)) {
    case 0:
    case 1: {
      const pair = pick(r, PAIRS);
      if (chance(r, 0.15)) return dropPair(s, pair);
      // No two ends on Upper floor overlap: the other pair's end there keeps its squares.
      const other = PAIRS.find((p) => p !== pair)!;
      const there = s.floorLinks?.[other.id === "o1" ? "o1" : "a2"]?.rect;
      const rect = randomRect(r);
      if (there && overlaps(there, rect)) return s;
      return putPair(s, pair, rect, (s.floorLinks?.[pair.id]?.rev ?? 0) + 1);
    }
    case 2: {
      const light = pick<LightLevel>(r, ["bright", "dim", "dark", "dark"]);
      return { ...s, scenes: { ...s.scenes, [floor]: { ...s.scenes[floor]!, vision: { ...s.scenes[floor]!.vision!, light } } } };
    }
    case 3: {
      const vision = s.scenes[floor]!.vision!;
      const next = chance(r, 0.2) ? { ...vision, on: !vision.on } : vision.perPlayer ? { on: vision.on, light: vision.light } : { ...vision, perPlayer: true as const };
      return { ...s, scenes: { ...s.scenes, [floor]: { ...s.scenes[floor]!, vision: next } } };
    }
    case 4: {
      const entries = ["p1", "p2", "p3"].filter(() => chance(r, 0.6)).map((memberId) => ({ memberId, on: chance(r, 0.7) }));
      return { ...s, holders: { ...s.holders, [floor]: { sceneId: floor, rev: (s.holders[floor]?.rev ?? 0) + 1, entries } } };
    }
    case 5: {
      const t = pick(r, Object.values(s.tokens));
      const moved = { ...t, sceneId: floor, x: int(r, 0, 38) / 2, y: int(r, 0, 38) / 2, ...(chance(r, 0.1) ? { visibility: t.visibility === "dm" ? ("all" as const) : ("dm" as const) } : {}) };
      return { ...s, tokens: { ...s.tokens, [t.id]: moved } };
    }
    case 6: {
      const id = pick(r, ["l1", "l2", "l3"]);
      if (chance(r, 0.25)) {
        const lights = { ...s.lights };
        delete lights[id];
        return { ...s, lights };
      }
      return withAll(s, [], [lamp(id, floor, int(r, 0, 38) / 2, int(r, 0, 38) / 2, { bright: pick(r, [0, 5, 10, 20]), dim: pick(r, [5, 10]), walls: chance(r, 0.8) })]);
    }
    case 7: {
      if (chance(r, 0.3)) {
        const chunks = Object.fromEntries(Object.entries(s.buildChunks).filter(([, c]) => c.sceneId !== floor));
        return { ...s, buildChunks: chunks };
      }
      const x = int(r, 2, 36) / 2;
      const y = int(r, 2, 36) / 2;
      return chance(r, 0.5) ? withWall(s, floor, `w${int(r, 0, 99999)}`, x, y, Math.min(19.5, x + int(r, 1, 6)), y) : withWall(s, floor, `w${int(r, 0, 99999)}`, x, y, x, Math.min(19.5, y + int(r, 1, 6)));
    }
    case 8: {
      const marks = { ...s.openFloors };
      const id = pick(r, [UPPER, ATTIC]);
      if (marks[id]) delete marks[id];
      else marks[id] = { sceneId: id, rev: 0 };
      return { ...s, openFloors: marks };
    }
    default:
      return chance(r, 0.2) ? { ...s, meta: { ...s.meta, view: { ...s.meta.view, blackout: !s.meta.view.blackout } } } : s;
  }
}

/** 7.2's class on the other floor, restated as the oracle: a holder's own only where that floor is per-player and their entry there is on. */
function across(s: RoomState, sceneId: SceneId, cls: SightClass): SightClass {
  if (typeof cls === "string") return cls;
  return s.scenes[sceneId]!.vision?.perPlayer === true && s.holders[sceneId]?.entries.some((e) => e.on && e.memberId === cls.holder) === true ? cls : "shared";
}

function ownOf(s: RoomState, sceneId: SceneId, cls: SightClass): PartySight {
  if (cls === "union") return visionRules.partySight(s, sceneId);
  if (cls !== "shared") return visionRules.holderSight(s, sceneId, cls.holder);
  return s.scenes[sceneId]!.vision?.perPlayer === true ? visionRules.holderSight(s, sceneId, null) : visionRules.partySight(s, sceneId);
}

function expected(s: RoomState, sceneId: SceneId, cls: SightClass): Uint8Array {
  const out = levelGrid(ownOf(s, sceneId, cls));
  for (const join of openingJoins(s, sceneId)) {
    const theirs = levelGrid(ownOf(s, join.other, across(s, join.other, cls)));
    for (const [sx, sy] of join.subs) out[sy * 80 + sx] = Math.max(out[sy * 80 + sx]!, theirs[sy * 80 + sx]!);
  }
  return out;
}

/** The gate, restated: an opening end joins exactly while both its floors have vision on and players see both. */
function gateHolds(s: RoomState): void {
  for (const link of Object.values(s.floorLinks ?? {})) {
    const open = (id: SceneId) => s.scenes[id]!.vision?.on === true && playersSee(s, id);
    const joined = openingJoins(s, link.sceneId).some((j) => j.linkId === link.id);
    assert.equal(joined, open(link.sceneId) && open(link.to), `join of ${link.id}`);
  }
}

describe("warm equals cold through openings (7.3)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}`, () => {
      const r = rng(seed);
      let s = withAll(openTower({ ground: "dark", upper: "dark", attic: "dark" }), CREATURES);
      s = putPair(putPair(s, PAIRS[0], { x: 6, y: 6, w: 2, h: 2 }, 0), PAIRS[1], { x: 12, y: 12, w: 3, h: 2 }, 0);
      let joins = 0;
      for (let i = 0; i < 120; i++) {
        s = step(r, s);
        gateHolds(s);
        for (const f of FLOORS) {
          joins += openingJoins(s, f).length;
          for (const cls of CLASSES) {
            const at = `step ${i}, ${f}, ${JSON.stringify(cls)}`;
            // A cold answer asked of each creature before its tiles are drawn answers by the point query alone.
            const cold = coldSightFor(s, f, cls);
            const here = Object.values(s.tokens).filter((t) => t.sceneId === f);
            const asked = here.map((t) => cold.seesToken(t, SQUARES));
            const warm = visionRules.sightFor(s, f, cls);
            assert.deepEqual(levelGrid(warm), levelGrid(cold), `${at}: warm equals cold`);
            assert.deepEqual(levelGrid(warm), expected(s, f, cls), `${at}: 7.2's rule`);
            assert.equal(visionRules.sightFor({ ...s }, f, cls), warm, `${at}: equal inputs, the identical object`);
            const fromTiles = visionRules.sightFromTiles(Object.fromEntries([...warm.tiles].map(([k, v]) => [`${f}:${k}`, v])), f);
            assert.deepEqual(asked, here.map((t) => fromTiles.seesToken(t, SQUARES)), `${at}: the point query answers as the tiles`);
          }
        }
      }
      assert.ok(joins > 0, "some steps joined floors");
    });
  }
});
