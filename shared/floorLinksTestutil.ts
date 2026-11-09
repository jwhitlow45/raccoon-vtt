import assert from "node:assert/strict";
import type { FloorLink, RoomState, Scene, Token, Viewer } from "./model.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { DM, actor, character, env, room, scene, token } from "./testutil.ts";

/*
 * A tower of three floors for the stairs and ladders tests
 * (docs/design/design-v1-floors.md phase 2): Ground floor (s1, the players'
 * start), Upper floor (up, 10 ft above it) and Attic (at, 10 ft above
 * that), each 20 by 20 squares, and Thorn, Ana's character, on Ground
 * floor. Every lane's tests of stairs build on it, so each reads one room.
 */

export const GROUND = "s1";
export const UPPER = "up";
export const ATTIC = "at";
/** Ana, a player who owns Thorn. */
export const ANA: Viewer = { memberId: "p1", role: "player" };
/** Bree, a player who owns nothing here. */
export const BREE: Viewer = { memberId: "p2", role: "player" };

function floor(id: string, level: number, name: string, height = 10, over: Partial<Scene> = {}): Scene {
  return scene(id, { name: "Tower", order: 0, bounds: { w: 20, h: 20 }, floor: { of: GROUND, level, name, height }, ...over });
}

/** The tower, with Thorn (Ana's character, a Medium PC) at 3, 3 on Ground floor. */
export function tower(over: Partial<RoomState> = {}): RoomState {
  return room({
    scenes: {
      [GROUND]: floor(GROUND, 0, "Ground floor"),
      [UPPER]: floor(UPPER, 1, "Upper floor"),
      [ATTIC]: floor(ATTIC, 2, "Attic"),
      s2: scene("s2", { order: 1 }),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ speeds: { walk: 30 } }) }) },
    tokens: { thorn: thornToken() },
    ...over,
  });
}

/** Thorn on Ground floor, as tower() places it. */
export function thornToken(over: Partial<Token> = {}): Token {
  return token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1"], actor: { ref: "thorn" }, sceneId: GROUND, x: 3, y: 3, ...over });
}

let seq = 100;

/** The next envelope seq, so every op of a test file is a new one. */
export function nextSeq(): number {
  return seq++;
}

/** Applies an op that must succeed, schema-parsed as the server would. */
export function applied(state: RoomState, op: Op, who: Viewer = DM, opVersion?: number): Applied {
  const r = applyOp(state, opSchema.parse(op), who, { ...env(nextSeq()), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return r;
}

export function run(state: RoomState, op: Op, who: Viewer = DM, opVersion?: number): RoomState {
  return applied(state, op, who, opVersion).state;
}

/** The refusal's words of an op that must be refused. */
export function refusal(state: RoomState, op: Op, who: Viewer = DM): string {
  const r = applyOp(state, opSchema.parse(op), who, env(nextSeq()));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

/** `floorLink.put` of stairs from Ground floor up to Upper floor, 2 by 1 at 3, 3 unless told otherwise. */
export function putOp(over: Partial<{ id: string; pairId: string; sceneId: string; to: string; rect: FloorLink["rect"]; kind: FloorLink["kind"] }> = {}): Op {
  return { t: "floorLink.put", link: { id: "l1", pairId: "l2", sceneId: GROUND, to: UPPER, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs", ...over } };
}

/** The tower with stairs from Ground floor (l1) up to Upper floor (l2) under Thorn. */
export function withStairs(state: RoomState = tower(), over: Parameters<typeof putOp>[0] = {}): RoomState {
  return run(state, putOp(over));
}

/** A fight with Thorn's turn under way, so its moves write its path. */
export function onThornsTurn(state: RoomState): RoomState {
  return run(run(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }] }), { t: "encounter.next" });
}
