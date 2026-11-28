import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type PathStop, type RoomSettings, type RoomState, type Token, type Viewer } from "../model.ts";
import { MAX_PATH_STOPS } from "../protocol.ts";
import { loadMonsters, type SrdMonster } from "../srd/monsters.ts";
import { loadSrdRolls } from "../srd/rolls.ts";
import type { SrdRolls } from "../dice/bonus.ts";
import { actor, character, companionBlock, customMonster, effect, entry, room, token } from "../testutil.ts";
import { withStop } from "./path.ts";
import {
  avoidTrait,
  chunksNeeded,
  extraReactions,
  opportunityNoticesOn,
  reachInput,
  reachOf,
  reachScan,
  reachWords,
  reconcileLegs,
  rowStands,
  turnReach,
  type Chunks,
  type LegRecord,
  type ReachLeave,
} from "./opportunity.ts";

/**
 * Opportunity Attack notices' scan (docs/design/design-v1-opportunity-attacks.md
 * 4 and 8): which enemies' reach a move leaves, distance first, with cover
 * and sight as gates at the departure spot, and the occurrences legs keep
 * through the reducer's rewrites.
 */

const DM: Viewer = { memberId: "dm1", role: "dm" };
const NONE: Chunks = { rolls: {}, monsters: [] };

let monsters: readonly SrdMonster[] = [];
let rolls: SrdRolls = {};
before(async () => {
  monsters = await loadMonsters();
  rolls = await loadSrdRolls();
});

const bree = (more: Partial<Token> = {}) => token("bree", { kind: "pc", name: "Bree", disposition: "ally", x: 2, y: 2, ...more });
const gob = (id: string, x: number, y: number, more: Partial<Token> = {}) => token(id, { name: id, x, y, ...more });

type Spec = { edges?: Record<string, EdgeFeature>; walls?: FreeWall[]; settings?: Partial<RoomSettings>; held?: true; shape?: "hexRows" | "hexColumns" };

/** A room on scene s1 with no automatic walls: these tokens, drawn edges by absolute key, and free walls. */
function world(tokens: readonly Token[], spec: Spec = {}): RoomState {
  const state = room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
  state.meta.settings = { ...state.meta.settings, ...spec.settings };
  state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off", ...(spec.shape ? { gridShape: spec.shape } : {}) };
  const at = (x: number, y: number): BuildChunk => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    return (state.buildChunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {}, ...(spec.held ? { known: "" } : {}) } as BuildChunk);
  };
  for (const [key, f] of Object.entries(spec.edges ?? {})) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    at(x, y).edges[key] = f;
  }
  for (const wall of spec.walls ?? []) (at(Math.floor((wall.a[0] + wall.b[0]) / 2), Math.floor((wall.a[1] + wall.b[1]) / 2)).walls ??= []).push(wall);
  return state;
}

let wallIds = 0;
function free(ax: number, ay: number, bx: number, by: number, f: FreeWall["f"] = { kind: "wall" }): FreeWall {
  return { id: `w${String(wallIds++).padStart(11, "0")}`, a: [ax, ay], b: [bx, by], f };
}

const stop = (x: number, y: number, elevation = 0, more: Partial<PathStop> = {}): PathStop => ({ x, y, elevation, ...more });

/** The leaves of each leg of a walk through these stops, the turn's scan, by creature id. */
function walk(state: RoomState, moverId: string, stops: readonly PathStop[], chunks: Chunks = NONE, viewer: Viewer = DM): string[][] {
  const read = reachInput(state, moverId, { turn: 1, stops: [...stops] }, chunks, viewer);
  assert.ok(read);
  return turnReach(read.input, read.legs).map((l) => (l.leaves === "over" ? ["over"] : l.leaves.map((x) => x.id)));
}

const left = (state: RoomState, moverId: string, stops: readonly PathStop[], chunks?: Chunks, viewer?: Viewer) => walk(state, moverId, stops, chunks, viewer).flat();

function leavesOf(state: RoomState, moverId: string, stops: readonly PathStop[], chunks: Chunks = NONE): ReachLeave[] {
  const read = reachInput(state, moverId, { turn: 1, stops: [...stops] }, chunks, DM);
  assert.ok(read);
  return turnReach(read.input, read.legs).flatMap((l) => (l.leaves === "over" ? [] : l.leaves));
}

describe("a leave is a step from within a reach to beyond it", () => {
  test("Bree walks from beside Goblin 2 to 15 ft away", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), ["g2"]);
    const [leave] = leavesOf(state, "bree", [stop(2, 2), stop(2, 5)]);
    assert.deepEqual(leave, { id: "g2", spot: 2, reach: 5 }, "the first spot beyond 5 ft, two squares down");
  });

  test("walking past Goblin 2 without stopping beside it gives one row, the leave mid-leg", () => {
    const state = world([bree({ x: 0, y: 5 }), gob("g2", 4, 4)]);
    const leaves = leavesOf(state, "bree", [stop(0, 5), stop(9, 5)]);
    assert.deepEqual(leaves, [{ id: "g2", spot: 6, reach: 5 }]);
  });

  test("leaving, coming back and leaving again is one row a turn", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    assert.deepEqual(walk(state, "bree", [stop(2, 2), stop(2, 5), stop(2, 2), stop(2, 5)]), [["g2"], [], []]);
  });

  test("walking up to a creature and staying beside it is no leave, and neither is walking around it", () => {
    const state = world([bree({ x: 0, y: 2 }), gob("g2", 3, 2)]);
    assert.deepEqual(left(state, "bree", [stop(0, 2), stop(2, 2)]), []);
    assert.deepEqual(left(state, "bree", [stop(2, 1), stop(4, 1), stop(4, 3), stop(2, 3)]), []);
  });

  test("a teleport, or a leg marked Doesn't count, gives no row, and a carried leg none", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5, 0, { uncounted: true })]), []);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5, 0, { uncounted: true, carried: true })]), []);
    const read = reachInput(state, "bree", { turn: 1, stops: [stop(2, 2), stop(2, 5, 0, { uncounted: true })] }, NONE, DM)!;
    const leg = read.legs[0]!;
    assert.equal(leg.provokes, false);
    const scan = reachScan(read.input, leg, new Set());
    assert.deepEqual(scan.next(), { done: true, value: [] });
  });

  test("a fall past a goblin on the same floor is a counted leg until the DM presses Doesn't count", () => {
    const state = world([bree({ elevation: 10 }), gob("g2", 3, 2, { elevation: 10 })]);
    assert.deepEqual(left(state, "bree", [stop(2, 2, 10), stop(2, 2, 0)]), ["g2"]);
    assert.deepEqual(left(state, "bree", [stop(2, 2, 10), stop(2, 2, 0, { uncounted: true })]), []);
  });

  test("a trapdoor fall folds its leg into prior, so the floor below starts with no leg", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    const read = reachInput(state, "bree", { turn: 1, prior: { moved: 10, cost: 10, seenDiag: [0, 0] }, stops: [stop(2, 2)] }, NONE, DM)!;
    assert.deepEqual(read.legs, []);
  });

  test("a flier rising 10 ft straight up from beside a goblin leaves its reach", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 2, 10)]), ["g2"]);
  });

  test("a resize where the creature stands, which the reducer stores as not counting, is no move", () => {
    // Large, Bree stood beside the goblin. Medium now, her square is 10 ft from it, yet she never moved.
    const shrunk = world([bree(), gob("g2", 4, 2)]);
    assert.deepEqual(left(shrunk, "bree", [stop(2, 2, 0, { footprint: { w: 2, h: 2 } }), stop(2, 2, 0, { uncounted: true })]), []);
    // Legs joined across a resize once the path is full are movement, and provoke.
    const read = reachInput(shrunk, "bree", { turn: 1, stops: [stop(2, 2, 0, { footprint: { w: 2, h: 2 } }), stop(2, 6)] }, NONE, DM)!;
    assert.equal(read.legs[0]!.provokes, true);
    assert.deepEqual(left(shrunk, "bree", [stop(2, 2, 0, { footprint: { w: 2, h: 2 } }), stop(2, 6)]), ["g2"]);
  });
});

describe("who can make one", () => {
  test("a dragged goblin following Bree is never listed, and nor is the mount she rides", () => {
    const state = world([bree({ x: 2, y: 2 }), gob("g2", 3, 2, { attached: { to: "bree", kind: "drag" } }), gob("g3", 2, 3)]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 0)]), ["g3"]);
    const mounted = world([bree({ attached: { to: "horse", kind: "ride", steer: true } }), gob("horse", 2, 2, { disposition: "hostile", size: "large" })]);
    assert.deepEqual(left(mounted, "bree", [stop(2, 2), stop(2, 0)]), []);
  });

  test("a rider on a controlled Warhorse: rows under the Warhorse, none under the rider, whose legs are carried", () => {
    const state = world([bree({ attached: { to: "horse", kind: "ride", steer: true } }), token("horse", { name: "Warhorse", disposition: "ally", size: "large", x: 2, y: 2 }), gob("g2", 4, 2)]);
    assert.deepEqual(left(state, "horse", [stop(2, 2), stop(2, 6)]), ["g2"]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 6, 0, { uncounted: true, carried: true })]), []);
  });

  test("an Unconscious, Stunned, dead, dying or Incapacitated goblin gives no row", () => {
    for (const more of [{ effects: [effect("e", { key: "unconscious" })] }, { effects: [effect("e", { key: "stunned" })] }, { effects: [effect("e", { key: "paralyzed" })] }, { life: "dead" as const }, { life: "dying" as const }, { life: "stable" as const }]) {
      const state = world([bree(), gob("g2", 3, 2, { actor: { inline: actor(more) } })]);
      assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), [], JSON.stringify(more));
    }
    const prone = world([bree(), gob("g2", 3, 2, { actor: { inline: actor({ effects: [effect("e", { key: "prone" })] }) } })]);
    assert.deepEqual(left(prone, "bree", [stop(2, 2), stop(2, 5)]), ["g2"], "Prone changes nothing");
  });

  test("a goblin whose Reaction is used gives no row, and its row leaves once the Reaction is marked", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    state.encounter = { rev: 0, round: 1, activeEntryId: "rb", started: true, entries: [entry("rb", { tokenId: "bree" }), entry("rg", { tokenId: "g2", reactionUsed: true })] };
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), []);
    state.encounter.entries[1]!.reactionUsed = false;
    const [leave] = leavesOf(state, "bree", [stop(2, 2), stop(2, 5)]);
    assert.ok(leave);
    assert.equal(rowStands(state, leave, DM), true);
    state.encounter.entries[1]!.reactionUsed = true;
    assert.equal(rowStands(state, leave, DM), false, "the row leaves on the press");
    assert.equal(rowStands({ ...state, tokens: { bree: state.tokens.bree! } }, leave, DM), false, "and when the creature leaves the copy");
    state.encounter.entries[1]!.reactionUsed = false;
    const g2 = state.tokens.g2!;
    for (const more of [{ life: "dead" as const }, { life: "dying" as const }, { effects: [effect("s", { key: "stunned" })] }]) {
      const later = { ...state, tokens: { ...state.tokens, g2: { ...g2, actor: { inline: actor(more) } } } };
      assert.equal(rowStands(later, leave, DM), false, `and when it is ${JSON.stringify(more)}`);
    }
  });

  test("a companion sharing its character's turn counts its own Reaction, by its mark", () => {
    const wolf = token("wolf", { name: "Wolf", disposition: "hostile", x: 3, y: 2, companion: { of: "c1", turn: "shared", reactionUsed: true } });
    const state = world([bree(), wolf]);
    state.encounter = { rev: 0, round: 1, activeEntryId: "rb", started: true, entries: [entry("rb", { tokenId: "bree" })] };
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), []);
    state.tokens.wolf = { ...wolf, companion: { of: "c1", turn: "shared" } };
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), ["wolf"]);
  });

  test("a Hydra with its Reaction used keeps its row on the DM's card, naming Reactive Heads", () => {
    const state = world([bree(), gob("hydra", 3, 2, { size: "huge", actor: { inline: actor({ srdId: "hydra" }) } })]);
    state.encounter = { rev: 0, round: 1, activeEntryId: "rb", started: true, entries: [entry("rb", { tokenId: "bree" }), entry("rh", { tokenId: "hydra", reactionUsed: true })] };
    const chunks: Chunks = { rolls, monsters };
    const leaves = leavesOf(state, "bree", [stop(2, 2), stop(2, 8)], chunks);
    assert.deepEqual(leaves, [{ id: "hydra", spot: 5, reach: 10, extra: "Reactive Heads" }], "its Bite reaches 10 ft, past its three squares");
    assert.equal(rowStands(state, leaves[0]!, DM), true);
    assert.deepEqual(leavesOf(state, "bree", [stop(2, 2), stop(2, 8)], { rolls, monsters: "failed" }), [], "a failed block reads no trait");
  });

  test("a Blinded goblin needs Blindsight to the distance: Truesight alone gives no row", () => {
    const blind = (senses: string) => world([bree(), gob("g2", 3, 2, { actor: { inline: actor({ senses, effects: [effect("e", { key: "blinded" })] }) } })]);
    assert.deepEqual(left(blind("Truesight 120 ft."), "bree", [stop(2, 2), stop(2, 5)]), []);
    assert.deepEqual(left(blind("Blindsight 10 ft."), "bree", [stop(2, 2), stop(2, 5)]), ["g2"]);
    assert.deepEqual(left(blind(""), "bree", [stop(2, 2), stop(2, 5)]), []);
  });

  test("an Invisible or Hidden Bree is seen only by Blindsight or Truesight to the distance", () => {
    for (const key of ["invisible", "hidden"] as const) {
      const unseen = (senses: string) => world([bree({ actor: { inline: actor({ effects: [effect("e", { key })] }) } }), gob("g2", 3, 2, { actor: { inline: actor({ senses }) } })]);
      assert.deepEqual(left(unseen("Truesight 30 ft."), "bree", [stop(2, 2), stop(2, 5)]), ["g2"], key);
      assert.deepEqual(left(unseen("Blindsight 5 ft."), "bree", [stop(2, 2), stop(2, 5)]), ["g2"], key);
      assert.deepEqual(left(unseen("Darkvision 60 ft."), "bree", [stop(2, 2), stop(2, 5)]), [], key);
    }
  });

  test("a Neutral creature, or an ally beside an ally, gives no row, and a Neutral mover provokes no one", () => {
    const state = world([bree(), gob("n", 3, 2, { disposition: "neutral" }), gob("a", 2, 3, { disposition: "ally" })]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(0, 0)]), []);
    const neutral = world([bree({ disposition: "neutral" }), gob("g2", 3, 2)]);
    assert.deepEqual(left(neutral, "bree", [stop(2, 2), stop(2, 5)]), []);
  });

  test("objects and creatures on another scene never count", () => {
    const state = world([bree(), gob("box", 3, 2, { kind: "object" }), gob("far", 3, 2, { sceneId: "s2" })]);
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), []);
  });

  test("the mover's own rows come from what is passed: a hostile mover leaves an ally Bree's reach", () => {
    const state = world([bree({ x: 3, y: 2 }), gob("g2", 2, 2)]);
    assert.deepEqual(left(state, "g2", [stop(2, 2), stop(2, 5)]), ["bree"]);
  });
});

describe("distance first, with a neighbor one cell's feet (D-261128-056)", () => {
  test("a diagonal neighbor under true distance on the default grid is 5 ft, within a 5 ft reach", () => {
    const state = world([bree({ x: 2, y: 3 }), gob("g2", 3, 3)], { settings: { diagonal: "euclid" } });
    assert.deepEqual(leavesOf(state, "bree", [stop(2, 3), stop(2, 0)]), [{ id: "g2", spot: 2, reach: 5 }], "not at the diagonal, a spot early");
  });

  test("a neighbor on 10 ft squares is 10 ft, beyond a 5 ft reach, so stepping away is no leave", () => {
    const state = world([bree(), gob("g2", 3, 2)], { settings: { feetPerCell: 10 } });
    assert.deepEqual(left(state, "bree", [stop(2, 2), stop(2, 5)]), []);
  });

  const ogre = () => customMonster("ogre", { name: "Ogre", actions: [{ name: "Greatclub", text: "Melee Attack Roll: +6, reach 10 ft. Hit: 13 (2d8 + 4) Bludgeoning damage." }] });

  test("an Ogre with 10 ft two diagonals away: beyond reach under 5-10-5 (15 ft), within it when every square is 5 ft", () => {
    const tokens = [bree({ x: 2, y: 2 }), gob("o", 4, 4, { actor: { inline: actor({ monsterId: "ogre" }) } })];
    const fiveTen = world(tokens, { settings: { diagonal: "fiveTen" } });
    fiveTen.monsters = { ogre: ogre() };
    assert.deepEqual(left(fiveTen, "bree", [stop(2, 2), stop(0, 0)]), [], "never within its reach");
    const five = world(tokens, { settings: { diagonal: "five" } });
    five.monsters = { ogre: ogre() };
    assert.deepEqual(leavesOf(five, "bree", [stop(2, 2), stop(0, 0)]), [{ id: "o", spot: 1, reach: 10 }]);
  });

  test("SOL-01: a 10 ft reactor at (0,0), the mover from (2,0) to (2,1), every square 5 ft, a wall on y=1: no crossing, no row", () => {
    const state = world([bree({ x: 2, y: 0 }), gob("o", 0, 0, { actor: { inline: actor({ monsterId: "ogre" }) } })], { edges: { "0,1,n": { kind: "wall" }, "1,1,n": { kind: "wall" } } });
    state.monsters = { ogre: ogre() };
    assert.deepEqual(left(state, "bree", [stop(2, 0), stop(2, 1)]), []);
  });

  test("a character with a Dagger and a Whip stepping a goblin from 5 ft to 10 ft: a row at the 5 ft boundary", () => {
    const stats = { abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 }, saves: [], skills: {}, adjust: {}, defenses: {}, rolls: [{ id: "r1", name: "Dagger", kind: "weapon" as const, dice: [] }, { id: "r2", name: "Whip", kind: "weapon" as const, dice: [] }] };
    const state = world([token("hero", { kind: "pc", disposition: "ally", x: 2, y: 2, actor: { ref: "c1" } }), gob("g2", 3, 2)]);
    state.characters = { c1: character("c1", { stats }) };
    assert.deepEqual(reachOf(state, state.tokens.hero!, NONE), { reaches: [5, 10], known: true });
    assert.deepEqual(leavesOf(state, "g2", [stop(3, 2), stop(4, 2)]), [{ id: "hero", spot: 1, reach: 5 }]);
  });

  test("a Barbed Devil's 5 ft Claw and 10 ft Tail give one row, however many boundaries", () => {
    const state = world([bree(), gob("devil", 3, 2, { actor: { inline: actor({ srdId: "barbed-devil" }) } })]);
    const chunks: Chunks = { rolls, monsters };
    assert.deepEqual(leavesOf(state, "bree", [stop(2, 2), stop(2, 9)], chunks), [{ id: "devil", spot: 2, reach: 5 }]);
    assert.deepEqual(leavesOf(state, "bree", [stop(2, 2, 0), stop(2, 2, 30)], chunks), [{ id: "devil", spot: 1, reach: 5 }], "both crossed in one step");
  });

  test("Large and Huge movers and reactors are measured edge to edge, a squeezed stop at its own size", () => {
    const state = world([bree({ size: "large", x: 2, y: 2 }), gob("h", 4, 2, { size: "huge" })]);
    assert.deepEqual(leavesOf(state, "bree", [stop(2, 2), stop(2, 8)]), [{ id: "h", spot: 7, reach: 5 }], "a Large creature can squeeze, so it walks half squares");
    // Stops made while Bree was Medium are walked at that size: her one square at (2,2) was 10 ft from the Huge creature.
    assert.deepEqual(leavesOf(state, "bree", [stop(2, 2, 0, { footprint: { w: 1, h: 1 } }), stop(2, 8, 0, { footprint: { w: 1, h: 1 } })]), []);
    const squeezed = leavesOf(state, "bree", [stop(2, 2, 0, { footprint: { w: 2, h: 2, squeeze: true } }), stop(2, 8, 0, { footprint: { w: 2, h: 2, squeeze: true } })]);
    assert.deepEqual(squeezed.map((l) => l.id), ["h"], "squeezed, by the squares its squeezed space covers");
  });
});

describe("cover at the departure spot (D-261128-056)", () => {
  const away = [stop(2, 2), stop(2, 0)];

  test("OPUS-02: Bree beside a goblin across the joint of a drawn wall: no row", () => {
    const state = world([bree(), gob("g2", 3, 3)], { edges: { "2,3,n": { kind: "wall" }, "3,3,n": { kind: "wall" } } });
    assert.deepEqual(left(state, "bree", away), []);
  });

  test("a diagonal across a drawn wall, a room corner from inside to outside and a wall beside a closed door: no row", () => {
    const across = world([bree(), gob("g2", 3, 3)], { edges: { "1,3,n": { kind: "wall" }, "2,3,n": { kind: "wall" }, "3,3,n": { kind: "wall" }, "4,3,n": { kind: "wall" } } });
    assert.deepEqual(left(across, "bree", away), []);
    const corner = world([bree(), gob("g2", 3, 3)], { edges: { "0,3,n": { kind: "wall" }, "1,3,n": { kind: "wall" }, "2,3,n": { kind: "wall" }, "3,0,w": { kind: "wall" }, "3,1,w": { kind: "wall" }, "3,2,w": { kind: "wall" } } });
    assert.deepEqual(left(corner, "bree", away), []);
    const door = world([bree(), gob("g2", 3, 3)], { edges: { "2,3,n": { kind: "wall" }, "3,3,n": { kind: "door", state: "closed", secret: false, discovered: false } } });
    assert.deepEqual(left(door, "bree", away), []);
    const freeJoint = world([bree(), gob("g2", 3, 3)], { walls: [free(1, 3, 3, 3), free(3, 3, 5, 3)] });
    assert.deepEqual(left(freeJoint, "bree", away), [], "two free walls meeting straight");
  });

  test("a diagonal past a free wall's end, an open door and a window's lack of reach: the end and the door pass, the window stops", () => {
    assert.deepEqual(left(world([bree(), gob("g2", 3, 3)], { walls: [free(3, 3, 6, 3)] }), "bree", away), ["g2"]);
    assert.deepEqual(left(world([bree(), gob("g2", 3, 3)], { edges: { "2,3,n": { kind: "door", state: "open", secret: false, discovered: false } } }), "bree", [stop(2, 2), stop(0, 0)]), ["g2"]);
    assert.deepEqual(left(world([bree(), gob("g2", 2, 3)], { edges: { "2,3,n": { kind: "door", state: "open", secret: false, discovered: false } } }), "bree", away), ["g2"], "straight through an open door");
    assert.deepEqual(left(world([bree(), gob("g2", 2, 3)], { edges: { "2,3,n": { kind: "window" } } }), "bree", away), []);
  });

  test("R2-01: an L corridor's bend, wall mass in the cell beside both: the inner corner passes", () => {
    const state = world([bree(), gob("g2", 3, 3)], { edges: { "2,3,n": { kind: "wall" }, "3,3,w": { kind: "wall" } } });
    assert.deepEqual(left(state, "bree", away), ["g2"]);
  });

  test("a room's outer corner seen from outside passes", () => {
    const state = world([bree({ x: 2, y: 3 }), gob("g2", 3, 2)], { edges: { "3,3,n": { kind: "wall" }, "4,3,n": { kind: "wall" }, "3,3,w": { kind: "wall" }, "3,4,w": { kind: "wall" } } });
    assert.deepEqual(left(state, "bree", [stop(2, 3), stop(0, 3)]), ["g2"]);
  });

  test("a wall between the creatures along a side stops it, and a wall behind the walk never makes a leave", () => {
    assert.deepEqual(left(world([bree(), gob("g2", 3, 2)], { edges: { "3,2,w": { kind: "wall" } } }), "bree", [stop(2, 2), stop(0, 2)]), []);
    // Walking along a wall past a goblin: the leave is judged by distance, the wall only gates it.
    assert.deepEqual(left(world([bree({ x: 0, y: 2 }), gob("g2", 3, 3)], { edges: { "5,0,w": { kind: "wall" } } }), "bree", [stop(0, 2), stop(8, 2)]), ["g2"]);
  });

  test("a Large reactor behind a wall on one of its squares is seen past it from another", () => {
    const state = world([bree({ x: 2, y: 4 }), gob("o", 2, 2, { size: "large" })], { edges: { "2,4,n": { kind: "wall" } } });
    assert.deepEqual(left(state, "bree", [stop(2, 4), stop(2, 7)]), ["o"], "the square at (3,3) sees (2,4) past the wall's end");
  });

  test("R2-07: the DM's stored free walls read exactly, a player's held pieces by pieceTouches", () => {
    const dm = world([bree(), gob("g2", 3, 3)], { walls: [free(3, 3, 4, 2)] });
    assert.deepEqual(left(dm, "bree", away), ["g2"], "the line meets the wall at its free end");
    const held = world([bree(), gob("g2", 3, 3)], { walls: [free(3.00005, 2.99995, 4, 2)], held: true });
    assert.deepEqual(left(held, "bree", away), [], "within the piece's band, a held copy stops it");
  });
});

describe("words, traits and the room switch", () => {
  test("reachWords names up to the cap, then counts", () => {
    assert.equal(reachWords(["Goblin 2"], "Leaves", false, 3), "Leaves Goblin 2's reach");
    assert.equal(reachWords(["Goblin 2", "Goblin 3"], "Leaves", false, 3), "Leaves the reach of Goblin 2 and Goblin 3");
    assert.equal(reachWords(["Goblin 2", "Goblin 3", "Goblin 4"], "Leaves", false, 3), "Leaves the reach of Goblin 2, Goblin 3 and Goblin 4");
    assert.equal(reachWords(["Goblin 2", "Goblin 3", "Goblin 4", "Goblin 5"], "Leaves", false, 3), "Leaves the reach of Goblin 2, Goblin 3 and 2 more");
    assert.equal(reachWords(["Goblin 2"], "left", false, 3), "left Goblin 2's reach");
    assert.equal(reachWords(["Goblin 2", "Goblin 3", "Goblin 4"], "left", false, 1), "left 3 creatures' reach");
    assert.equal(reachWords(["Goblin 2"], "left", false, 1), "left Goblin 2's reach");
    assert.equal(reachWords(["Goblin 2"], "Leaves", true, 3), "Leaves 5 ft of Goblin 2");
    assert.equal(reachWords([], "Leaves", false, 3), "");
  });

  test("an Owl's Flyby is the trait that may avoid them, on any section, and Reactive Heads and Reactive grant more Reactions", () => {
    const block = (id: string) => monsters.find((m) => m.srdId === id)!;
    assert.equal(avoidTrait(block("owl")), "Flyby");
    assert.equal(avoidTrait(block("gelatinous-cube")), "Engulf");
    assert.equal(avoidTrait(block("centaur-trooper")), "Trampling Charge", "its recharge left off");
    assert.equal(avoidTrait(block("goblin-warrior")), null);
    assert.equal(extraReactions(block("hydra")), "Reactive Heads");
    assert.equal(extraReactions(block("marilith")), "Reactive");
    assert.equal(extraReactions(block("goblin-warrior")), null);
  });

  test("the room switch reads on when absent", () => {
    assert.equal(opportunityNoticesOn({}), true);
    assert.equal(opportunityNoticesOn({ opportunityNotices: true }), true);
    assert.equal(opportunityNoticesOn({ opportunityNotices: false }), false);
  });
});

describe("reaches and the chunks they wait for", () => {
  test("an SRD monster reads the rolls table, a failed or missing one 5 ft unknown, a room block and a companion block live", () => {
    const state = world([gob("devil", 3, 2, { actor: { inline: actor({ srdId: "barbed-devil" }) } }), gob("plain", 4, 4), gob("room", 5, 5, { actor: { inline: actor({ monsterId: "m1" }) } }), gob("pet", 6, 6, { actor: { inline: actor({ blockId: "b1" }) } })]);
    state.monsters = { m1: customMonster("m1", { actions: [{ name: "Tail", text: "Melee Attack Roll: +6, reach 15 ft. Hit: 9." }] }) };
    state.companionBlocks = { b1: companionBlock("b1", "c1", { actions: [{ name: "Glaive", text: "Melee Weapon Attack: +5 to hit, reach 200 ft., one target." }] }) };
    assert.deepEqual(reachOf(state, state.tokens.devil!, { rolls, monsters: "failed" }), { reaches: [5, 10], known: true });
    assert.deepEqual(reachOf(state, state.tokens.devil!, { rolls: "failed", monsters: "failed" }), { reaches: [5], known: false });
    assert.deepEqual(reachOf(state, state.tokens.plain!, NONE), { reaches: [5], known: false });
    assert.deepEqual(reachOf(state, state.tokens.room!, NONE), { reaches: [15], known: true });
    assert.deepEqual(reachOf(state, state.tokens.pet!, NONE), { reaches: [120], known: true }, "capped at 120 ft");
  });

  test("a scan waits for the SRD chunks only when a creature it could name links an SRD block", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    assert.deepEqual(chunksNeeded(state, "bree"), { rolls: false, monsters: false });
    state.tokens.ogre = gob("ogre", 5, 5, { actor: { inline: actor({ srdId: "ogre" }) } });
    assert.deepEqual(chunksNeeded(state, "bree"), { rolls: true, monsters: true });
    state.tokens.ogre = gob("ogre", 5, 5, { disposition: "ally", actor: { inline: actor({ srdId: "ogre" }) } });
    assert.deepEqual(chunksNeeded(state, "bree"), { rolls: false, monsters: false }, "an ally of the mover names nothing");
    assert.deepEqual(chunksNeeded(state, "gone"), { rolls: false, monsters: false });
  });

  test("takes the stairs mid-turn: only this floor's legs are scanned", () => {
    const state = world([bree(), gob("g2", 3, 2)]);
    const read = reachInput(state, "bree", { turn: 1, prior: { moved: 30, cost: 30, seenDiag: [0, 0] }, stops: [stop(2, 2), stop(2, 5)] }, NONE, DM)!;
    assert.equal(read.legs.length, 1);
    assert.equal(reachInput(state, "bree", null, NONE, DM), null);
    assert.equal(reachInput(state, "gone", { turn: 1, stops: [stop(0, 0)] }, NONE, DM), null);
  });
});

describe("slices and caps (section 5)", () => {
  test("a scan yields its work between slices and gives what one run gives", () => {
    const tokens = [bree({ x: 0, y: 10 })];
    for (let i = 0; i < 30; i++) tokens.push(gob(`g${i}`, 1 + i, 9 + (i % 3)));
    const state = world(tokens, { settings: {} });
    const read = reachInput(state, "bree", { turn: 1, stops: [stop(0, 10), stop(39, 10)] }, NONE, DM)!;
    const whole = turnReach(read.input, read.legs)[0]!.leaves;
    const scan = reachScan(read.input, read.legs[0]!, new Set(), 50);
    let yields = 0;
    let step = scan.next();
    while (!step.done) {
      yields++;
      step = scan.next();
    }
    assert.ok(yields > 1);
    assert.deepEqual(step.value, whole);
    assert.equal((whole as ReachLeave[]).length, 30);
  });
});

describe("occurrences: reconcileLegs (D-261128-057)", () => {
  const legsOf = (stops: readonly PathStop[]) => stops.slice(1).map((to, i) => ({ from: stops[i]!, to }));
  const ids = () => {
    let n = 100;
    return () => ++n;
  };
  const flat = (records: readonly LegRecord[]): number[] => records.flatMap((r) => (r.parts ? flat(r.parts) : [r.id]));

  test("a stop appended is one new leg, and the last leg undone removes its record", () => {
    const next = ids();
    const a = reconcileLegs([], legsOf([stop(0, 0), stop(1, 0)]), next);
    assert.deepEqual([a.legs.map((l) => l.id), a.added.length, a.removed.length], [[101], 1, 0]);
    const b = reconcileLegs(a.legs, legsOf([stop(0, 0), stop(1, 0), stop(2, 0), stop(3, 0)]), next);
    assert.deepEqual([b.legs.map((l) => l.id), b.added.map((l) => l.id)], [[101, 102, 103], [102, 103]], "a gap stop and the new stop together");
    const c = reconcileLegs(b.legs, legsOf([stop(0, 0), stop(1, 0), stop(2, 0)]), next);
    assert.deepEqual([c.legs.map((l) => l.id), c.removed.map((l) => l.id), c.added], [[101, 102], [103], []]);
  });

  test("A to B to A to B holds two A to B legs, the second a new occurrence (SOL-09)", () => {
    const next = ids();
    const first = reconcileLegs([], legsOf([stop(0, 0), stop(3, 0)]), next);
    const back = reconcileLegs(first.legs, legsOf([stop(0, 0), stop(3, 0), stop(0, 0)]), next);
    const again = reconcileLegs(back.legs, legsOf([stop(0, 0), stop(3, 0), stop(0, 0), stop(3, 0)]), next);
    assert.deepEqual(again.legs.map((l) => l.id), [101, 102, 103]);
    assert.deepEqual(again.added.map((l) => l.id), [103]);
  });

  test("footprints filled on a reshape, corners dropped and marks changed keep every id (R3-01)", () => {
    const next = ids();
    const stops = [stop(0, 0), stop(2, 0, 0, { via: [1, 1] }), stop(4, 0)];
    const a = reconcileLegs([], legsOf(stops), next);
    const reshaped = [stop(0, 0, 0, { footprint: { w: 2, h: 2 } }), stop(2, 0, 0, { footprint: { w: 2, h: 2 }, uncounted: true }), stop(4, 0, 0, { footprint: { w: 2, h: 2 } }), stop(4, 0, 0, { footprint: { w: 2, h: 2, squeeze: true } })];
    const b = reconcileLegs(a.legs, legsOf(reshaped), next);
    assert.deepEqual(b.legs.slice(0, 2).map((l) => l.id), [101, 102]);
    assert.deepEqual([b.removed, b.added.length], [[], 1], "the squeeze where it stands is its own leg");
  });

  test("withStop past 50 stops joins the oldest pair into one record holding both, with no new occurrence, and an Undo splits it back", () => {
    const next = ids();
    let path = { turn: 1, stops: [stop(0, 0)] };
    for (let i = 1; i < MAX_PATH_STOPS; i++) path = withStop(path, stop(i % 2 === 0 ? 0 : 1, i));
    const full = reconcileLegs([], legsOf(path.stops), next);
    assert.equal(full.legs.length, MAX_PATH_STOPS - 1);
    const joinedPath = withStop(path, stop(5, 5));
    const joined = reconcileLegs(full.legs, legsOf(joinedPath.stops), next);
    assert.deepEqual(joined.legs[0]!.parts?.map((p) => p.id), [101, 102]);
    assert.deepEqual([joined.added.length, joined.removed.length], [1, 0], "only the appended leg is new");
    assert.deepEqual(flat(joined.legs).slice(0, 3), [101, 102, 103]);
    const undone = reconcileLegs(joined.legs, legsOf(path.stops), next);
    assert.deepEqual(undone.legs.map((l) => l.id), full.legs.map((l) => l.id), "both legs back with their ids");
    assert.deepEqual(undone.removed.map((l) => l.id), [joined.added[0]!.id]);
  });

  test("two joins in one update, and a join of a join, nest two records each", () => {
    const next = ids();
    let path = { turn: 1, stops: [stop(0, 0)] };
    for (let i = 1; i < MAX_PATH_STOPS; i++) path = withStop(path, stop(i % 2 === 0 ? 0 : 1, i));
    const full = reconcileLegs([], legsOf(path.stops), next);
    // A gap stop and a new stop in one update join twice.
    const twice = withStop(withStop(path, stop(5, 5)), stop(6, 5));
    const r = reconcileLegs(full.legs, legsOf(twice.stops), next);
    const first = r.legs[0]!;
    assert.equal(first.parts?.length, 2);
    const inner = first.parts!.find((p) => p.parts);
    assert.ok(inner, "the second join holds the first");
    assert.deepEqual(flat([first]), [101, 102, 103]);
    assert.equal(r.added.length, 2);
  });

  test("a path short of full never joins: A to B to C read as A to C is a new leg", () => {
    const next = ids();
    const a = reconcileLegs([], legsOf([stop(0, 0), stop(1, 0), stop(2, 0)]), next);
    const b = reconcileLegs(a.legs, legsOf([stop(0, 0), stop(2, 0)]), next);
    assert.deepEqual([b.removed.map((l) => l.id), b.added.length, b.legs[0]!.parts], [[101, 102], 1, undefined]);
  });

  test("a join that holds as it was keeps its id through later updates", () => {
    const next = ids();
    let path = { turn: 1, stops: [stop(0, 0)] };
    for (let i = 1; i < MAX_PATH_STOPS; i++) path = withStop(path, stop(i % 2 === 0 ? 0 : 1, i));
    const full = reconcileLegs([], legsOf(path.stops), next);
    path = withStop(path, stop(5, 5));
    const joined = reconcileLegs(full.legs, legsOf(path.stops), next);
    const join = joined.legs[0]!;
    // A resize's footprints filled in, and a mark changed: the join stands, its id with it.
    const marked = reconcileLegs(joined.legs, legsOf(path.stops.map((s) => ({ ...s, footprint: { w: 1, h: 1 } }))), next);
    assert.equal(marked.legs[0], join);
    assert.deepEqual([marked.added, marked.removed], [[], []]);
  });

  test("a path past 100 corners drops the oldest corners and keeps every id", () => {
    const next = ids();
    const stops = [stop(0, 0)];
    for (let i = 1; i < 30; i++) stops.push(stop(i, 0, 0, { via: [i - 0.5, 1, i - 0.5, 2, i - 0.5, 1, i - 0.5, 0] }));
    const a = reconcileLegs([], legsOf(stops), next);
    const capped = stops.map((s, i) => (i < 10 ? { x: s.x, y: s.y, elevation: s.elevation } : s));
    const b = reconcileLegs(a.legs, legsOf(capped), next);
    assert.deepEqual(b.legs.map((l) => l.id), a.legs.map((l) => l.id));
    assert.deepEqual([b.added, b.removed], [[], []]);
  });

  test("a rewrite it cannot match removes those records and scans the new legs, keeping the legs it can", () => {
    const next = ids();
    const a = reconcileLegs([], legsOf([stop(0, 0), stop(1, 0), stop(2, 0), stop(3, 0)]), next);
    const b = reconcileLegs(a.legs, legsOf([stop(0, 0), stop(1, 0), stop(2, 1), stop(3, 0)]), next);
    assert.deepEqual(b.legs[0]!.id, 101);
    assert.deepEqual(b.removed.map((l) => l.id), [102, 103]);
    assert.equal(b.added.length, 2);
    const floor = reconcileLegs(b.legs, [], next);
    assert.deepEqual(floor.legs, []);
    assert.equal(floor.removed.length, 3, "a change of floor removes the floor's records");
  });
});
