import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import { tower, UPPER } from "../floorLinksTestutil.ts";
import type { RoomState, Token, TrapRig, Viewer } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { WHOLE_SQUARES_OP_VERSION } from "../rules/traps.ts";
import { AT, chance, DM, int, member, P1, pick, rng, room, scene, token, trap } from "../testutil.ts";

/**
 * Stored ops of change format 69 and below replay to the states they made
 * (design 16.2), whatever change format 70 (traps.ts squeezeWalksWhole)
 * changed: on squares a walk that starts or ends squeezed reads, between
 * its ends, only the squares wholly inside the creature's space. Each seed
 * builds three moves, each in one of four turns of the map, either way
 * along it: a Large or Huge creature stepping from a room into a corridor
 * along the map's edge, to end squeezed beside a trapdoor, one squeezing
 * into a corridor inside the map, a custom size among them, past darts
 * behind either wall, and one that starts squeezed and walks on around a
 * bend, past darts beyond the second arm's walls. The creature is hidden
 * now and then, so the private pass reads it, and a stopping plate lies in
 * the corridor now and then.
 *
 * `stored` pins each seed's moves at their stored change format, written
 * by the build before change format 70 (REPLAY_WHOLE=stored), and `whole`
 * the same ops at change format 70, written by the build that brought it
 * (REPLAY_WHOLE=whole). The hash covers the whole state each move leaves.
 * Write a side again only for a change meant to move it, from the build
 * that side names.
 */

const FIXTURE = new URL("./wholeSquares.replay.fixture.json", import.meta.url);
const SEEDS = 200;

type Kind = "edge" | "corridor" | "bend";
type Tail = { kind: Kind; state: RoomState; op: Op; who: Viewer; opVersion: number };
type Side = "north" | "west" | "south" | "east";

const KINDS: readonly Kind[] = ["edge", "corridor", "bend"];

/**
 * Corridor coordinates to the scene's: `u` runs along a side of a W by H
 * scene, `v` in from it, and `flip` turns `u` end for end, so one plan
 * stands along any side, walked either way. A box of side `s` at (u, v)
 * keeps its distance from the side it is mapped to.
 */
function mapper(side: Side, flip: boolean, W: number, H: number) {
  const along = side === "north" || side === "south" ? W : H;
  const turned = (u: number, s: number) => (flip ? along - u - s : u);
  const place = (u: number, v: number, su: number, sv: number): { x: number; y: number } => {
    const a = turned(u, su);
    return side === "north" ? { x: a, y: v } : side === "west" ? { x: v, y: a } : side === "south" ? { x: a, y: H - v - sv } : { x: W - v - sv, y: a };
  };
  const box = (u: number, v: number, s: number) => place(u, v, s, s);
  const point = (u: number, v: number): [number, number] => {
    const p = place(u, v, 0, 0);
    return [p.x, p.y];
  };
  const cells = (u: number, v: number, lu: number, lv: number) => {
    const a = place(u, v, lu, lv);
    return side === "north" || side === "south" ? { x: a.x, y: a.y, w: lu, h: lv } : { x: a.x, y: a.y, w: lv, h: lu };
  };
  return { box, point, cells };
}

function rig(r: () => number, over: Partial<TrapRig> = {}): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: chance(r, 0.5), hits: chance(r, 0.5) ? "trigger" : "zone", actions: [], find: [], notice: false, ...over };
}

/** A wall from one point to another in pieces of at most 6 squares, as the protocol takes a wall. */
function walls(state: RoomState, tag: string, m: ReturnType<typeof mapper>, u0: number, v0: number, u1: number, v1: number, sceneId: string): void {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0)) / 6));
  for (let i = 0; i < n; i++) {
    const a = m.point(u0 + ((u1 - u0) * i) / n, v0 + ((v1 - v0) * i) / n);
    const b = m.point(u0 + ((u1 - u0) * (i + 1)) / n, v0 + ((v1 - v0) * (i + 1)) / n);
    wall(state, `${tag}${String(i).padStart(4, "0")}`, a, b, undefined, sceneId);
  }
}

function bear(r: () => number, sceneId: string, at: { x: number; y: number }, size: Pick<Token, "size" | "w" | "h">, squeezed: boolean): Token {
  const t = token("bear", { sceneId, ...size, ...at, name: "Bear", kind: "npc", ownerIds: ["p1"], ...(chance(r, 0.25) ? { visibility: "dm" as const } : {}) });
  return squeezed ? { ...t, squeeze: true } : t;
}

/** One seed's move of a kind: its room, its corridor and its op. */
function tailOf(seed: number, kind: Kind): Tail {
  const r = rng(seed * 7919 + KINDS.indexOf(kind) * 131 + 3);
  const side = pick(r, ["north", "west", "south", "east"] as const);
  const flip = chance(r, 0.5);
  const opVersion = pick(r, [66, 67, 68, 69, 69, 69]);
  const who = chance(r, 0.6) ? P1 : DM;
  if (kind === "edge") {
    // The tower's Upper floor, 20 by 20, the players' floor, with a corridor along one side walled on its inner side but for a
    // doorway, which the creature steps through from the room to end squeezed half a square off the grid both ways, its
    // squeezed space on the edge's squares from `core`. Its spots between there stand full size half a square off along the edge.
    const state = tower();
    state.meta = { ...state.meta, playerSceneId: UPPER };
    state.scenes[UPPER] = { ...state.scenes[UPPER]!, blockMovement: true, autoWalls: "off" };
    const m = mapper(side, flip, 20, 20);
    const size = pick(r, ["large", "large", "huge"] as const);
    const s = size === "large" ? 2 : 3;
    const wide = s - 1;
    const toU = int(r, 4, 13) + 0.5;
    const core = Math.floor(toU) + 1;
    walls(state, "edgewalla", m, 0, wide, core - 2, wide, UPPER);
    walls(state, "edgewallb", m, core + s, wide, 20, wide, UPPER);
    // The trapdoor beside those squares on the side snapping rounds toward, which a turn of the map end for end swaps, or under
    // the squeezed space itself.
    const tu = chance(r, 0.75) ? (flip ? core - 2 : core + wide) : core - 1;
    state.traps.td1 = trap("td1", { sceneId: UPPER, name: "Trapdoor", zone: { cells: [m.cells(tu, 0, 2, wide)] }, rig: rig(r, { stops: true, below: true }) });
    // Now and then darts in the room just past the corridor's wall too.
    if (chance(r, 0.3)) state.traps.darts = trap("darts", { sceneId: UPPER, name: "Darts", zone: { cells: [m.cells(core - 1, wide, 3, 1)] }, rig: rig(r) });
    state.tokens.bear = bear(r, UPPER, m.box(toU - 0.5 + 0.5 * int(r, 0, 2), wide + int(r, 1, 2), s), { size }, false);
    const end = m.box(toU, -0.5, s);
    const door = m.box(toU - 0.5, wide, s);
    const op: Op = { t: "token.move", tokenId: "bear", x: end.x, y: end.y, squeeze: true, ...(chance(r, 0.4) ? { route: [[door.x, door.y, 0, 0], [end.x, end.y, 0, 0]] } : {}) };
    return { kind, state, op, who, opVersion };
  }
  const W = 30;
  const H = 26;
  const state = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1", { bounds: { w: W, h: H }, blockMovement: true, autoWalls: "off", fogEnabled: chance(r, 0.2) }) },
  });
  state.buildChunks = {};
  const m = mapper(side, flip, W, H);
  const c = int(r, 5, 8);
  if (kind === "corridor") {
    const size = pick(r, [{ size: "large" as const }, { size: "large" as const }, { size: "huge" as const }, { size: "custom" as const, w: 2.5, h: 2.5 }]);
    const s = size.size === "large" ? 2 : size.size === "huge" ? 3 : 2.5;
    const wide = s - 1;
    const a = int(r, 6, 8);
    const b = a + int(r, 10, 13);
    walls(state, "nearwall", m, a, c, b, c, "s1");
    walls(state, "farwall0", m, a, c + wide, b, c + wide, "s1");
    const toU = int(r, a + 3, b - 3) + 0.5;
    // Darts behind either wall where the walk ends, which only a space read past the corridor reaches.
    const far = chance(r, 0.5);
    state.traps.darts = trap("darts", { name: "Darts", zone: { cells: [m.cells(Math.floor(toU) - int(r, 0, 2), far ? Math.ceil(c + wide) : c - 1, 3, 1)] }, rig: rig(r) });
    if (chance(r, 0.3)) state.traps.plate = trap("plate", { name: "Plate", zone: { cells: [m.cells(int(r, a + 1, Math.floor(toU)), c, 1, Math.ceil(wide))] }, rig: rig(r, { stops: true }) });
    const start = m.box(a - Math.ceil(s) - int(r, 0, 2), c - 0.5 + (chance(r, 0.5) ? 0.5 : 0), s);
    state.tokens.bear = bear(r, "s1", start, size, false);
    const end = m.box(toU - (chance(r, 0.5) ? 0.5 : 0), c - 0.5, s);
    const mouth = m.box(a - 0.5, c - 0.5, s);
    const op: Op = { t: "token.move", tokenId: "bear", x: end.x, y: end.y, squeeze: true, ...(chance(r, 0.6) ? { route: [[mouth.x, mouth.y, 0, 0], [end.x, end.y, 0, 0]] } : {}) };
    return { kind, state, op, who, opVersion };
  }
  // An L-shaped corridor: its first arm along u, its second turning in along v at u = b, the creature squeezed in the first.
  const size = pick(r, ["large", "large", "huge"] as const);
  const s = size === "large" ? 2 : 3;
  const wide = s - 1;
  const a = int(r, 3, 5);
  const b = a + int(r, 6, 9);
  const reach = int(r, 7, 10);
  walls(state, "arm1near", m, a, c, b + wide, c, "s1");
  walls(state, "arm1far0", m, a, c + wide, b, c + wide, "s1");
  walls(state, "arm2near", m, b, c + wide, b, c + reach, "s1");
  walls(state, "arm2far0", m, b + wide, c, b + wide, c + reach, "s1");
  const startU = int(r, a + 1, b - 3) + 0.5;
  state.tokens.bear = bear(r, "s1", m.box(startU - 0.5, c - 0.5, s), { size }, true);
  const tv = int(r, c + 2, c + reach - 3);
  const far = chance(r, 0.5);
  state.traps.darts = trap("darts", { name: "Darts", zone: { cells: [m.cells(far ? b + wide : b - 1, tv, 1, 3)] }, rig: rig(r) });
  const corner = m.box(b - 0.5, c - 0.5, s);
  const squeezeEnd = chance(r, 0.4);
  const end = squeezeEnd ? m.box(b - 0.5, c + reach - 2.5, s) : m.box(b - 1, c + reach, s);
  const op: Op = { t: "token.move", tokenId: "bear", x: end.x, y: end.y, ...(squeezeEnd ? { squeeze: true } : {}), route: [[corner.x, corner.y, 0, 0], [end.x, end.y, 0, 0]] };
  return { kind, state, op, who, opVersion };
}

function tailsOf(seed: number): Tail[] {
  return KINDS.map((k) => tailOf(seed, k));
}

function replay(t: Tail, opVersion: number | undefined): string {
  const out = applyOp(t.state, t.op, t.who, { seq: 11, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
  return hash128(stableStringify(out.ok ? { state: out.state, trapped: out.trapped ?? null } : { refused: out.code, message: out.message }));
}

type Fixture = { stored?: string[]; whole?: string[]; corpus?: string[] };

function pinned(): Fixture {
  try {
    return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  } catch {
    return {};
  }
}

/** Writes one side of the fixture, keeping the others, when REPLAY_WHOLE names it. */
function writeSide(side: keyof Fixture, hashes: string[]): void {
  if (process.env.REPLAY_WHOLE === side) writeFileSync(FIXTURE, `${JSON.stringify({ ...pinned(), [side]: hashes }, null, 2)}\n`);
}

function differing(now: string[], was: string[] | undefined): number[] {
  assert.ok(was, "the side is pinned");
  assert.equal(now.length, was.length, "as many seeds as pinned");
  return now.flatMap((h, i) => (h !== was[i] ? [i + 1] : []));
}

describe("stored ops of change format 69 and below replay to the states they made, and from 70 squeezing walks read whole squares (squeezeWalksWhole)", () => {
  const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

  test("each seed's moves at their stored change format replay as the build before change format 70 made them", () => {
    // One hash a seed over its three moves keeps the fixture small and still names the seed that moved.
    const now = seeds.map((seed) => hash128(tailsOf(seed).map((t) => replay(t, t.opVersion)).join(" ")));
    writeSide("stored", now);
    assert.deepEqual(differing(now, pinned().stored), [], "these seeds' moves replay to other states");
  });

  test("the same ops at change format 70 make the states pinned when it came, and a live op makes the same", () => {
    const now = seeds.map((seed) => hash128(tailsOf(seed).map((t) => replay(t, WHOLE_SQUARES_OP_VERSION)).join(" ")));
    writeSide("whole", now);
    assert.deepEqual(differing(now, pinned().whole), [], "these seeds' moves at change format 70 end otherwise");
    for (const seed of seeds.slice(0, 40)) for (const t of tailsOf(seed)) assert.equal(replay(t, undefined), replay(t, WHOLE_SQUARES_OP_VERSION), `seed ${seed}, ${t.kind}`);
  });

  test("at 69 and at 70 the same op ends otherwise in many of each kind, so both sides pin what change format 70 changed", () => {
    const moved: Record<Kind, number> = { edge: 0, corridor: 0, bend: 0 };
    for (const seed of seeds) for (const t of tailsOf(seed)) if (replay(t, WHOLE_SQUARES_OP_VERSION - 1) !== replay(t, WHOLE_SQUARES_OP_VERSION)) moved[t.kind]++;
    if (process.env.REPLAY_WHOLE === "count") console.log(moved);
    for (const k of KINDS) assert.ok(moved[k] >= 30, `${k}: ${moved[k]} of ${SEEDS} end otherwise`);
  });
});
