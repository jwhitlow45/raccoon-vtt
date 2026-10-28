import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "./keys.ts";
import { CHUNK_CELLS, type EdgeFeature, type RoomState, type Token } from "./model.ts";
import { ROUTE_OFF_LATTICE, ROUTE_TOO_LONG, WALL_IN_THE_WAY, WALL_IN_THE_WAY_BACK, canApply, type PermissionDeps } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { encodeHeights } from "./rules/heights.ts";
import { DM, P1, room, token } from "./testutil.ts";

/**
 * Routes on moves (docs/design-v1-movement.md 7.1 and 7.4), on the real
 * movement rules: the route's shape for every role, each piece's leg test
 * for a player on a scene that blocks moves, never for the DM, and a redo
 * meeting the walls along each kept piece.
 */
const deps: PermissionDeps = { canUseAsset: () => true };

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const DOOR: EdgeFeature = { kind: "door", state: "open", secret: false, discovered: false };

/** A wall along x = 3 from y = 0 to 3, and a wall along x = 8 with a door at y = 4. P1's familiar stands at 1, 1. */
function setup(door: EdgeFeature = DOOR): RoomState {
  const state = room();
  state.scenes.s1!.blockMovement = true;
  state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 1, y: 1 });
  const edges: Record<string, EdgeFeature> = { "3,0,w": { kind: "wall" }, "3,1,w": { kind: "wall" }, "3,2,w": { kind: "wall" } };
  for (let y = 0; y < 16; y++) edges[`8,${y},w`] = y === 4 ? door : { kind: "wall" };
  state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges };
  return state;
}

const around: [number, number, number, 0 | 1][] = [
  [1, 3, 0, 0],
  [4, 3, 0, 0],
  [5, 1, 0, 0],
];

describe("a move's route (7.1)", () => {
  test("a player's walk around a wall passes, and a piece through it is refused in today's words", () => {
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: around }), "ok");
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1 }), `forbidden: ${WALL_IN_THE_WAY}`, "the straight leg is stopped");
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: [[1, 2, 0, 0], [5, 1, 0, 0]] }), `forbidden: ${WALL_IN_THE_WAY}`);
  });

  test("the DM's pieces are never tested, but the shape is, for every role", () => {
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: [[1, 2, 0, 0], [5, 1, 0, 0]] }, DM), "ok");
    for (const who of [DM, P1]) {
      assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: [[1.25, 3, 0, 0], [5, 1, 0, 0]] }, who), `invalid: ${ROUTE_OFF_LATTICE}`);
      assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: [[1, -1, 0, 0], [5, 1, 0, 0]] }, who), `invalid: ${ROUTE_OFF_LATTICE}`);
      assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: [[1, 1, 0, 0], [5, 1, 0, 0]] }, who), `invalid: ${ROUTE_OFF_LATTICE}`, "a first piece that goes nowhere");
      assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: [[2, 1, 0, 0], [2, 1, 0, 0], [5, 1, 0, 0]] }, who), `invalid: ${ROUTE_OFF_LATTICE}`);
    }
    // 64 pieces back and forth across the room: far past 300 squares.
    const long = Array.from({ length: 64 }, (_, i): [number, number, number, 0 | 1] => (i === 63 ? [5, 1, 0, 0] : [i % 2 === 0 ? 7 : 1, 10, 0, 0]));
    const state = setup();
    state.buildChunks = {};
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 5, y: 1, route: long }, DM, state), `invalid: ${ROUTE_TOO_LONG}`);
  });

  test("an unsnapped token's route keeps to the lattice from where it stands", () => {
    const state = setup();
    state.buildChunks = {};
    state.tokens.own = { ...state.tokens.own!, x: 1.3 };
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 3.3, y: 2, route: [[2.3, 2, 0, 0], [3.3, 2, 0, 0]] }, P1, state), "ok");
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 3, y: 2, route: [[2, 2, 0, 0], [3, 2, 0, 0]] }, P1, state), `invalid: ${ROUTE_OFF_LATTICE}`);
  });
});

describe("the 300-square cap reads the public members a walk takes along (section 10, review R7-OPUS-1)", () => {
  /** Thorn (P1's) at 2, 2 on flat ground, dragging a goblin at 2, 3 whose row rises to 200 ft and falls to -100 ft a square east of it. */
  function dragging(thorn: Partial<Token> = {}, goblin: Partial<Token> = {}): RoomState {
    const state = room();
    const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
    for (let x = 3; x <= 8; x++) feet[3 * CHUNK_CELLS + x] = x % 2 === 1 ? 200 : -100;
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
    state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 2, y: 2, ...thorn });
    state.tokens.gob = token("gob", { name: "Goblin", x: 2, y: 3, attached: { to: "thorn", kind: "drag" }, ...goblin });
    return state;
  }
  const east = (to: number): Op => ({ t: "token.move", tokenId: "thorn", x: to, y: 2, route: Array.from({ length: to - 2 }, (_, i): [number, number, number, 0 | 1] => [3 + i, 2, 0, 0]) });

  test("a goblin dragged over its own climbs and falls past 300 squares refuses the route for every role, though the holder's own walk reaches 6", () => {
    for (const who of [DM, P1]) {
      // 40 squares up, then five falls and climbs of 60.
      assert.equal(decide(east(8), who, dragging()), `invalid: ${ROUTE_TOO_LONG}`);
      // Four pieces reach 220.
      assert.equal(decide(east(6), who, dragging()), "ok");
    }
  });

  test("a player's route on a scene with fog on counts no climbs, so heights they never touched refuse nothing (MD2-O-13)", () => {
    // Thorn's own row rises and falls as the goblin's does, on ground no player has seen.
    const climbing = (fog: boolean): RoomState => {
      const state = dragging();
      const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
      for (let x = 3; x <= 8; x++) feet[2 * CHUNK_CELLS + x] = x % 2 === 1 ? 200 : -100;
      state.buildChunks[chunkKey("s1", 0, 0)]!.heights = encodeHeights(feet);
      state.scenes.s1!.fogEnabled = fog;
      return state;
    };
    assert.equal(decide(east(8), P1, climbing(true)), "ok");
    assert.equal(decide(east(8), DM, climbing(true)), `invalid: ${ROUTE_TOO_LONG}`, "the DM's cap still counts them");
    assert.equal(decide(east(8), P1, climbing(false)), `invalid: ${ROUTE_TOO_LONG}`, "with fog off nothing is withheld");
  });

  test("a creature no player sees, or one on a holder no player sees, never decides the cap (L3-SOL-39)", () => {
    for (const who of [DM, P1]) {
      assert.equal(decide(east(8), who, dragging({}, { visibility: "dm" })), "ok", "a hidden goblin");
      assert.equal(decide(east(8), who, dragging({ visibility: "dm" })), "ok", "a visible goblin dragged by a hidden Thorn");
    }
  });
});

describe("a player's redo of a walk (7.4)", () => {
  const moved = (state: RoomState, x: number, y: number): Token => ({ ...state.tokens.own!, x, y });
  // Through the door at y = 4 in the wall along x = 8.
  const through: [number, number, number, 0 | 1][] = [
    [1, 4, 0, 0],
    [10, 4, 0, 0],
  ];

  test("passes along its kept route while the walls stay, and is refused once the door closes", () => {
    const open = setup();
    const redo = (state: RoomState): Op => ({ t: "sys.restore", entries: [{ key: "token:own", value: moved(state, 10, 4) }], from: "redo", deps: true, routes: { own: [through] } });
    assert.equal(decide(redo(open), P1, open), "ok");
    const shut = setup({ kind: "door", state: "closed", secret: false, discovered: false });
    assert.equal(decide(redo(shut), P1, shut), `forbidden: ${WALL_IN_THE_WAY_BACK}`);
    // Without its route, the straight leg would meet the wall.
    assert.equal(decide({ t: "sys.restore", entries: [{ key: "token:own", value: moved(open, 10, 4) }], from: "redo", deps: true }, P1, open), `forbidden: ${WALL_IN_THE_WAY_BACK}`);
  });

  test("a step that merged two walks redoes both in order, and the DM's redo is not tested", () => {
    const open = setup();
    const value = moved(open, 10, 4);
    const two: Op = { t: "sys.restore", entries: [{ key: "token:own", value }], from: "redo", deps: true, routes: { own: [around, [[5, 4, 0, 0], [10, 4, 0, 0]]] } };
    assert.equal(decide(two, P1, open), "ok");
    const wrongOrder: Op = { ...two, routes: { own: [[[5, 4, 0, 0], [10, 4, 0, 0]], around] } } as Op;
    assert.notEqual(decide(wrongOrder, P1, open), "ok");
    assert.equal(decide(wrongOrder, DM, open), "ok");
  });
});
