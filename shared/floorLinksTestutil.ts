import assert from "node:assert/strict";
import type { Fall, FallRecord, FloorLink, RoomState, Scene, Token, Trap, Viewer } from "./model.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { DM, actor, character, env, room, scene, token, trap } from "./testutil.ts";
import { rectGround } from "./rules/floorLinks.ts";

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

/*
 * Phase 4's fixtures (docs/design/design-v1-floors.md phase 4): an opening,
 * hidden stairs, a trapdoor, a fall card and its record, on the same tower.
 * Each writes the room as the reducer stores it, so a test reads one shape
 * whichever op made it.
 */

/** Where the tower's opening lies unless told otherwise: 2 by 2 at 6, 6, clear of Thorn at 3, 3. */
export const OPENING_RECT: FloorLink["rect"] = { x: 6, y: 6, w: 2, h: 2 };

/** `floorLink.put` of an opening from Upper floor (o1, the hole) down to Ground floor (o2), at OPENING_RECT unless told otherwise. */
export function putOpeningOp(over: Parameters<typeof putOp>[0] = {}): Op {
  return putOp({ id: "o1", pairId: "o2", sceneId: UPPER, to: GROUND, rect: OPENING_RECT, kind: "opening", ...over });
}

/**
 * The tower with an opening as the reducer stores one: its upper end `id`
 * on `upper`, its lower end `pairId` on the floor below, one rect, each
 * end on its floor's ground there, made by the op at `made`.
 */
export function withOpening(state: RoomState = tower(), over: Partial<{ id: string; pairId: string; upper: string; lower: string; rect: FloorLink["rect"]; made: number }> = {}): RoomState {
  const { id = "o1", pairId = "o2", upper = UPPER, lower = GROUND, rect = OPENING_RECT, made = 90 } = over;
  const end = (endId: string, sceneId: string, to: string, pair: string): FloorLink => ({ id: endId, rev: 0, sceneId, to, pair, rect: { ...rect }, kind: "opening", ground: rectGround(state.buildChunks, sceneId, rect) ?? 0, made });
  return { ...state, floorLinks: { ...state.floorLinks, [id]: end(id, upper, lower, pairId), [pairId]: end(pairId, lower, upper, id) } };
}

/** The tower's stairs (withStairs) hidden from players on both ends (phase 4, 8.1). */
export function withHiddenStairs(state: RoomState = tower(), over: Parameters<typeof putOp>[0] = {}): RoomState {
  const placed = withStairs(state, over);
  const links = Object.fromEntries(Object.entries(placed.floorLinks ?? {}).map(([id, link]) => [id, { ...link, hidden: true as const }]));
  return { ...placed, floorLinks: links };
}

/** A trapdoor (TrapRig.below, phase 4, 4.6) on Upper floor's squares at 10, 10 unless told otherwise, armed, public and stopping. */
export function trapdoor(id = "td1", over: Partial<Trap> = {}): Trap {
  const base = trap(id, { sceneId: UPPER, name: "Trapdoor", zone: { cells: [{ x: 10, y: 10, w: 2, h: 2 }] } });
  return { ...base, ...over, rig: { ...base.rig!, below: true, ...over.rig } };
}

/** The tower with a trapdoor. */
export function withTrapdoor(state: RoomState = tower(), made: Trap = trapdoor()): RoomState {
  return { ...state, traps: { ...state.traps, [made.id]: made } };
}

/** A fall card (phase 4, 4.4): Thorn fell 10 ft from Upper floor to Ground floor in the op at seq 120. */
export function fallCard(over: Partial<Fall> = {}): Fall {
  const made = over.made ?? 120;
  return { id: `${made}:0`, rev: 0, tokenId: "thorn", sceneId: GROUND, from: UPPER, ft: 10, made, ...over };
}

/** The tower with fall cards. */
export function withFalls(state: RoomState = tower(), ...cards: Fall[]): RoomState {
  return { ...state, falls: { ...state.falls, ...Object.fromEntries(cards.map((c) => [c.id, c])) } };
}

/** A fall's record (phase 4, 4.5): Thorn fell through the tower's opening, its upper end as withOpening stores it, into the card fallCard() makes. */
export function fallRecord(over: Partial<FallRecord> = {}): FallRecord {
  return { tokenId: "thorn", linkId: "o1", rev: 0, made: 90, from: UPPER, to: GROUND, fallId: "120:0", ...over };
}
