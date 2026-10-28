import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, Trap, TrapRig, Viewer } from "../model.ts";
import { opSchema, type Op, type TrapInput } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { placedOnHex } from "../rules/footprint.ts";
import { cornerAt, hexCorners, sceneHexes, sceneHexSpan, type Hex, type HexGrid } from "../rules/hex.ts";
import { actor, character, DM, env, P1, room, scene, token, trap as trapOf } from "../testutil.ts";
import { findRouteOn } from "../rules/hexWalk.ts";
import { ownWalk } from "../rules/movement.ts";
import { hexWallRoom, onHex, wallsRound } from "../rules/hexWalls.testkit.ts";

/**
 * Traps on a hex scene in the reducer (docs/design-v1-hex-grids.md phase
 * H2): a new trap is stamped with its scene's shape, its rectangles keep to
 * the scene's hex keys, a wire's ends may lie on hex corners, a square
 * scene's wire keeps to corners and edge midpoints, a walk sets a trap off
 * by hexes, and the Passive Perception hint counts hex steps.
 */
const ROWS: HexGrid = { shape: "hex", orient: "rows" };

function input(id: string, overrides: Partial<TrapInput> = {}): TrapInput {
  const { rev: _rev, state: _state, rig, ...rest } = trapOf(id);
  return { ...rest, rig: rig!, ...overrides } as TrapInput;
}

let seq = 1;
function run(state: RoomState, op: Op, who: Viewer = DM): RoomState {
  const r = applyOp(state, opSchema.parse(op), who, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r.state;
}

function refusal(state: RoomState, op: Op): string {
  const r = applyOp(state, opSchema.parse(op), DM, env(seq++));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

function hexRoom(shape: "hexRows" | "hexColumns" = "hexRows"): RoomState {
  return room({ scenes: { s1: scene("s1", { gridShape: shape }) } });
}

function on(id: string, ref: Hex, over: Partial<Token> = {}): Token {
  const base = token(id, { name: id, x: 0, y: 0, ...over });
  return { ...base, ...placedOnHex(ROWS, base, ref) };
}

describe("making a trap on a hex scene", () => {
  test("it is stamped with the scene's shape, and a square scene's trap carries none", () => {
    assert.equal(run(hexRoom(), { t: "trap.create", trap: input("t1") }).traps.t1?.grid, "hexRows");
    assert.equal(run(hexRoom("hexColumns"), { t: "trap.create", trap: input("t1") }).traps.t1?.grid, "hexColumns");
    assert.equal("grid" in run(room(), { t: "trap.create", trap: input("t1") }).traps.t1!, false);
    // An edit keeps the stamp.
    const made = run(hexRoom(), { t: "trap.create", trap: input("t1") });
    assert.equal(run(made, { t: "trap.update", trapId: "t1", patch: { name: "Spikes" } }).traps.t1?.grid, "hexRows");
  });

  test("its rectangles keep to the hex keys the scene's hexes run over, in the scene's cell word", () => {
    const state = hexRoom();
    const span = sceneHexSpan(ROWS, state.scenes.s1!.bounds);
    const end = sceneHexes(ROWS, state.scenes.s1!.bounds).at(-1)!;
    const last = { x: end.col, y: end.row, w: 1, h: 1 };
    assert.deepEqual(run(state, { t: "trap.create", trap: input("t1", { zone: { cells: [last] } }) }).traps.t1?.zone, { cells: [last] });
    assert.equal(refusal(state, { t: "trap.create", trap: input("t1", { zone: { cells: [{ ...last, y: span.rows }] } }) }), "a trap's hexes lie inside its scene");
  });

  test("a rectangle or a rectangle it hits holding a short row's last key, off the scene's hexes, is refused", () => {
    // On a 30 by 20 hex rows scene the keys run over 30 columns, but row 1 holds 29 hexes, so its key 29 lies off the scene.
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 30, h: 20 } }) } });
    const rig = { ...input("t1").rig, hits: "trigger" as const };
    assert.equal(refusal(state, { t: "trap.create", trap: input("t1", { zone: { cells: [{ x: 29, y: 1, w: 1, h: 1 }] }, rig }) }), "a trap's hexes lie inside its scene");
    assert.equal(refusal(state, { t: "trap.create", trap: input("t1", { zone: { cells: [{ x: 27, y: 0, w: 3, h: 2 }] }, rig }) }), "a trap's hexes lie inside its scene");
    assert.deepEqual(run(state, { t: "trap.create", trap: input("t1", { zone: { cells: [{ x: 29, y: 0, w: 1, h: 1 }] }, rig }) }).traps.t1?.zone, { cells: [{ x: 29, y: 0, w: 1, h: 1 }] });
    const hits = { ...rig, hits: { cells: [{ x: 28, y: 1, w: 2, h: 1 }] } };
    assert.equal(refusal(state, { t: "trap.create", trap: input("t1", { zone: { cells: [{ x: 2, y: 2, w: 1, h: 1 }] }, rig: hits }) }), "the hexes it hits lie inside its scene");
  });

  test("a 200 by 200 hex rows scene takes a trap on its last row, past where squares stop", () => {
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 200, h: 200 } }) } });
    const made = run(state, { t: "trap.create", trap: input("t1", { zone: { cells: [{ x: 10, y: 229, w: 1, h: 1 }] } }) });
    assert.deepEqual(made.traps.t1?.zone, { cells: [{ x: 10, y: 229, w: 1, h: 1 }] });
    const square = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }) } });
    assert.equal(refusal(square, { t: "trap.create", trap: input("t1", { zone: { cells: [{ x: 10, y: 229, w: 1, h: 1 }] } }) }), "a trap's squares lie inside its scene");
  });

  test("a wire may end on hex corners, off the half-cell lattice, while a square scene's keeps to corners and edge midpoints", () => {
    const a = cornerAt(ROWS, hexCorners(ROWS, { col: 3, row: 3 })[0]!);
    const b = cornerAt(ROWS, hexCorners(ROWS, { col: 6, row: 3 })[3]!);
    const wire = { wire: { a: [a.x, a.y] as [number, number], b: [b.x, b.y] as [number, number] } };
    assert.ok(!Number.isInteger(a.y * 2), "the corner is off the half lattice");
    const rig = { ...input("t1").rig, on: [] };
    assert.deepEqual(run(hexRoom(), { t: "trap.create", trap: input("t1", { zone: wire, rig }) }).traps.t1?.zone, wire);
    assert.equal(refusal(room(), { t: "trap.create", trap: input("t1", { zone: wire, rig }) }), "a wire's ends are on cell corners and edge midpoints");
    const half = { wire: { a: [1, 1] as [number, number], b: [3.5, 1] as [number, number] } };
    assert.deepEqual(run(room(), { t: "trap.create", trap: input("t1", { zone: half, rig }) }).traps.t1?.zone, half, "squares keep their wires");
  });
});

describe("a walk on a hex scene", () => {
  function hall(): RoomState {
    const state = hexRoom();
    state.characters.thorn = character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ passivePerception: 16 }) });
    state.tokens.thorn = on("thorn", { col: 2, row: 5 }, { kind: "pc", ownerIds: ["p1"], actor: { ref: "thorn" } });
    return state;
  }
  const rig = (over: Partial<TrapRig> = {}): TrapRig => ({ ...trapOf("x").rig!, stops: false, ...over });

  test("Thorn's walk across a plate's hex sets it off, logged for the DM", () => {
    const state = run(hall(), { t: "trap.create", trap: input("plate", { zone: { cells: [{ x: 6, y: 5, w: 1, h: 1 }] }, rig: rig() }) });
    const to = placedOnHex(ROWS, state.tokens.thorn!, { col: 9, row: 5 });
    const after = run(state, { t: "token.move", tokenId: "thorn", ...to }, P1);
    assert.equal(after.traps.plate?.state, "sprung");
    assert.equal(after.traps.plate?.found, true);
    // A walk along the next row, beside the plate's hex, sets nothing off.
    const beside = run(hall(), { t: "trap.create", trap: input("plate", { zone: { cells: [{ x: 6, y: 5, w: 1, h: 1 }] }, rig: rig() }) });
    beside.tokens.thorn = on("thorn", { col: 2, row: 6 }, { kind: "pc", ownerIds: ["p1"], actor: { ref: "thorn" } });
    const passed = run(beside, { t: "token.move", tokenId: "thorn", ...placedOnHex(ROWS, beside.tokens.thorn, { col: 10, row: 6 }) }, P1);
    assert.equal(passed.traps.plate?.state, "armed");
  });

  test("the Passive Perception hint comes within 10 ft of the zone's nearest hex, by hex steps", () => {
    const notice: Partial<TrapRig> = { who: "party", notice: true, find: [{ ability: "wis", skill: "perception", dc: 15, what: "the plate" }] };
    const state = run(hall(), { t: "trap.create", trap: input("plate", { zone: { cells: [{ x: 9, y: 5, w: 1, h: 1 }] }, rig: rig(notice) }) });
    const walk = (to: Hex) => run(state, { t: "token.move", tokenId: "thorn", ...placedOnHex(ROWS, state.tokens.thorn!, to) }, P1);
    assert.equal(walk({ col: 7, row: 5 }).traps.plate?.rig?.noticedBy, "thorn", "two hexes off");
    assert.equal(walk({ col: 6, row: 5 }).traps.plate?.rig?.noticedBy, undefined, "three hexes off");
  });
});

describe("a trap's text in the protocol on hexes", () => {
  test("a wire's ends are on the 1/64 lattice, and a rectangle's keys reach a hex scene's last row", () => {
    const parses = (zone: Trap["zone"]) => opSchema.safeParse({ t: "trap.create", trap: input("t", { zone, rig: { ...input("t").rig, on: "wire" in zone ? [] : ["enter"] } }) }).success;
    assert.equal(parses({ wire: { a: [1 + 1 / 64, 1], b: [3, 1] } }), true);
    assert.equal(parses({ wire: { a: [1.3, 1], b: [3, 1] } }), false);
    assert.equal(parses({ cells: [{ x: 0, y: 229, w: 1, h: 1 }] }), true);
    assert.equal(parses({ cells: [{ x: 0, y: 230, w: 1, h: 1 }] }), false);
  });
});

describe("a squeezed walk on a hex scene", () => {
  /** A Large ogre at 2,5 west of rock in columns 6 to 12, with a one-row corridor along row 6, and a plate on `plate`. */
  function corridor(plate: Hex): RoomState {
    const s = hexWallRoom("hexRows", 22, 16, wallsRound(ROWS, { w: 22, h: 16 }, (h) => h.col >= 6 && h.col <= 12 && h.row !== 6));
    s.tokens.ogre = onHex(ROWS, "ogre", "large", { col: 2, row: 5 }, { name: "Ogre" });
    return run(s, { t: "trap.create", trap: input("plate", { zone: { cells: [{ x: plate.col, y: plate.row, w: 1, h: 1 }] }, rig: { ...trapOf("x").rig!, stops: false } }) });
  }

  function walkThrough(state: RoomState): RoomState {
    const to = placedOnHex(ROWS, state.tokens.ogre!, { col: 16, row: 6 });
    const route = findRouteOn({ build: state, token: ownWalk(state.tokens.ogre!), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, to);
    assert.ok(route && route !== "none", "a way through the corridor");
    assert.ok(route.pieces.some(([, , extra]) => extra === 1), "squeezed on the way");
    return run(state, { t: "token.move", tokenId: "ogre", ...to, route: route.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim]) });
  }

  test("a move that stores no squeeze, ending on a squeezed size's anchor, walks full size and meets a plate under its full footprint", () => {
    // On open ground a Large ogre from 2,5 to a Medium anchor: the move leaves it unsqueezed, so every spot of its walk is too.
    const end = { x: 8.5, y: 4.773502691896258 };
    const open = () => {
      const s = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 22, h: 16 } }) } });
      s.tokens.ogre = onHex(ROWS, "ogre", "large", { col: 2, row: 5 }, { name: "Ogre" });
      return run(s, { t: "trap.create", trap: input("plate", { zone: { cells: [{ x: 7, y: 7, w: 1, h: 1 }] }, rig: { ...trapOf("x").rig!, stops: false } }) });
    };
    const many = run(open(), { t: "token.moveMany", moves: [{ tokenId: "ogre", ...end }] });
    assert.equal(many.tokens.ogre?.squeeze, undefined);
    assert.equal(many.traps.plate?.state, "sprung", "a group move");
    const one = run(open(), { t: "token.move", tokenId: "ogre", ...end });
    assert.equal(one.tokens.ogre?.squeeze, undefined);
    assert.equal(one.traps.plate?.state, "sprung", "a move of its own");
  });

  test("the ogre squeezed along the corridor sets off a plate in the corridor and none in the rock beside it", () => {
    assert.equal(walkThrough(corridor({ col: 9, row: 6 })).traps.plate?.state, "sprung", "in the corridor");
    for (let col = 7; col <= 11; col++) assert.equal(walkThrough(corridor({ col, row: 7 })).traps.plate?.state, "armed", `beside it at ${col},7`);
  });
});
