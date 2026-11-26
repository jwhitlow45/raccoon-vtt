import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import type { BuildState } from "../ruleHooks.ts";
import { ownWalk, storedBuild } from "../rules/movement.ts";
import { routeWalkers, walkSqueezes } from "../rules/route.ts";
import { AT, chance, DM, int, member, P1, pick, rng, room, scene, token, trap } from "../testutil.ts";

/**
 * Stored ops of change format 65 and 35 replay to the states they made
 * (design 16.2), whatever change format 66 (migrate.ts edgePinches) changed:
 * on square maps the scene's edge now pinches a squeeze, so a creature
 * squeezes into a corridor along it as between two walls. Each seed builds
 * a corridor one or two squares wide along one of the scene's four sides,
 * walled on its inner side only, and one move into or along it: the DM's
 * drag of a creature with a Large one in tow, a player's squeezed walk with
 * creatures in tow, a walk a stopping trap in the corridor cuts, and, at
 * change format 35, a mount walking the corridor with riders seated on it,
 * whose seats then read the narrow-space test between the walk's ends
 * (moveLeg.ts squeezedSeats). The hash covers the whole state the move
 * leaves. Write the fixture again with REPLAY_EDGE=write only for a change
 * meant to move them, from the build the stored ops were written by.
 */

const FIXTURE = new URL("./edgeSqueeze.replay.fixture.json", import.meta.url);
const SEEDS = 200;
const W = 26;
const H = 18;

type Side = "north" | "west" | "south" | "east";
type Kind = "drag" | "walk" | "stop" | "seats";
type Tail = { kind: Kind; state: RoomState; op: Op; who: Viewer; opVersion: number };

/**
 * Corridor coordinates to the scene's: `u` runs along the side, `v` in from
 * it, so one room plan stands along any side. A box of side `s` at (u, v)
 * keeps its distance from the side it is mapped to.
 */
function mapper(side: Side) {
  const box = (u: number, v: number, s: number): { x: number; y: number } =>
    side === "north" ? { x: u, y: v } : side === "west" ? { x: v, y: u } : side === "south" ? { x: u, y: H - v - s } : { x: W - v - s, y: u };
  const point = (u: number, v: number): [number, number] => {
    const p = box(u, v, 0);
    return [p.x, p.y];
  };
  const cells = (u: number, v: number, lu: number, lv: number) => {
    const a = box(u, v, side === "north" || side === "south" ? lv : lu);
    return side === "north" || side === "south" ? { x: a.x, y: a.y, w: lu, h: lv } : { x: a.x, y: a.y, w: lv, h: lu };
  };
  return { box, point, cells };
}

const SIDE_OF = { large: 2, huge: 3 } as const;

/** One seed's tail: its room, its corridor along a side, and its move. */
function tailOf(seed: number, kind: Kind): Tail {
  const r = rng(seed * 4133 + (["drag", "walk", "stop", "seats"] as const).indexOf(kind) * 97 + 5);
  const side = pick(r, ["north", "west", "south", "east"] as const);
  const m = mapper(side);
  const wide = kind === "seats" ? pick(r, [1, 2] as const) : pick(r, [1, 1, 2] as const);
  const fog = kind === "stop" ? chance(r, 0.2) : chance(r, 0.3);
  const state = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1", { bounds: { w: W, h: H }, blockMovement: kind === "drag" ? chance(r, 0.7) : true, autoWalls: "off", fogEnabled: fog }) },
  });
  state.buildChunks = {};
  // The corridor's inner wall, from u = a to u = b, in runs of at most 8 squares as the protocol takes a wall.
  const a = int(r, 5, 7);
  const b = a + int(r, 9, 12);
  for (let u = a, i = 0; u < b; u += 6, i++) wall(state, `edgesq${String(i).padStart(6, "0")}`, m.point(u, wide), m.point(Math.min(u + 6, b), wide));
  // Now and then a stub across the corridor's far end, a dead end.
  if (chance(r, 0.25)) wall(state, "edgesqend001", m.point(b, 0), m.point(b, wide));
  const size = wide === 1 ? "large" : pick(r, ["large", "huge", "huge"] as const);
  const s = SIDE_OF[size];
  // Squeezed in the corridor, a squeeze a square smaller sits half a square in from the side, its full box half past it.
  const squeezedAt = (u: number) => m.box(u - 0.5, -0.5, s);
  const outside = (du: number) => m.box(a - s - du, int(r, 0, 1), s);
  const route = (from: { x: number; y: number }, to: { x: number; y: number }): [number, number, number, 0 | 1][] => {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    return chance(r, 0.5) ? [[mid.x, mid.y, 0, 0], [to.x, to.y, 0, 0]] : [[to.x, to.y, 0, 0]];
  };
  const inside = chance(r, 0.5);
  const startU = inside ? int(r, a + 1, a + 4) + 0.5 : 0;
  const start = inside ? squeezedAt(startU) : outside(int(r, 0, 2));
  const mount: Token = { ...token("mount", { size, ...start, name: "Warhorse", kind: "npc", ownerIds: ["p1"] }), ...(inside ? { squeeze: true as const } : {}) };
  state.tokens.mount = mount;
  const toU = int(r, a + 2, b - 2) + 0.5;
  const end = squeezedAt(toU);
  if (kind === "drag") {
    // A creature dragging a Large one along the corridor, which walks its holder's way half past the side with its core inside:
    // the DM's drag through a stopping trap there, whose stop reads where the Large one stands, or a player's, which walks a
    // Large one no player sees only as far as its own leg and stand tests let it (moveLeg.ts stoppedAtWalls).
    const byDm = chance(r, 0.5);
    const holderAt = m.box(int(r, a + 3, a + 5), 0, 1);
    state.tokens.mount = token("mount", { ...holderAt, name: "Brom", kind: "pc", ownerIds: ["p1"] });
    const lag = int(r, 2, 3);
    const behind = m.box(int(r, a + 3, a + 5) - lag + 0.5 * int(r, 0, 1) - 1, -0.5, 2);
    state.tokens.ogre = token("ogre", { size: "large", x: behind.x, y: behind.y, name: "Ogre", kind: "npc", attached: { to: "mount", kind: "drag" }, ...(!byDm || chance(r, 0.3) ? { visibility: "dm" as const } : {}) });
    const to = m.box(int(r, a + 7, b - 1), 0, 1);
    if (byDm || chance(r, 0.3)) {
      const tu = int(r, a + 5, b - 2);
      state.traps.t1 = trap("t1", { zone: { cells: [m.cells(tu, 0, 1, wide)] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false } });
    }
    const op: Op = { t: "token.move", tokenId: "mount", x: to.x, y: to.y, ...(chance(r, 0.6) ? { route: route(holderAt, to) } : {}) };
    return { kind, state, op, who: byDm ? DM : P1, opVersion: 65 };
  }
  if (kind === "walk" || kind === "stop") {
    // Creatures in tow behind it, some hidden, and for a stop a trap in the corridor that stops a walker.
    for (let i = 0, n = int(r, kind === "walk" ? 1 : 0, 3); i < n; i++) {
      const at = m.box((inside ? startU : a - s) - 1 - i, chance(r, 0.5) ? 0 : -1 + int(r, 0, 1), 1);
      state.tokens[`tow${i}`] = token(`tow${i}`, { size: pick(r, ["medium", "medium", "small", "large"] as const), ...at, name: `Goblin ${i + 1}`, kind: "npc", attached: { to: i > 0 && chance(r, 0.3) ? `tow${i - 1}` : "mount", kind: "drag" }, ...(chance(r, 0.3) ? { visibility: "dm" as const } : {}) });
    }
    if (kind === "stop" || chance(r, 0.4)) {
      const tu = int(r, Math.ceil(inside ? startU : a) + 1, Math.floor(toU));
      state.traps.t1 = trap("t1", { zone: { cells: [m.cells(tu, 0, 1, wide)] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false } });
    }
    const op: Op = { t: "token.move", tokenId: "mount", x: end.x, y: end.y, squeeze: true, ...(chance(r, kind === "stop" ? 0.9 : 0.6) ? { route: route(start, end) } : {}) };
    return { kind, state, op, who: chance(r, 0.7) ? P1 : DM, opVersion: 65 };
  }
  // Riders seated on the mount as it walks the corridor, at change format 35, on squares of its box as it stands: some hidden, one
  // steering. Where the walk squeezes between its ends they sit inside the squeezed box, else at their offsets, so a trap for
  // riders that the full box reaches past the inner wall, or one in the corridor, finds them by the seats the walk gives them.
  const seatSide = inside ? s - 1 : s;
  const riders = int(r, 1, Math.min(3, seatSide * seatSide));
  for (let i = 0; i < riders; i++) {
    const at = { x: start.x + (inside ? 0.5 : 0) + (i % seatSide), y: start.y + (inside ? 0.5 : 0) + Math.floor(i / seatSide) };
    state.tokens[`rider${i}`] = token(`rider${i}`, { ...at, name: `Rider ${i + 1}`, kind: i === 0 ? "pc" : "npc", ownerIds: i === 0 ? ["p1"] : [], attached: { to: "mount", kind: "ride", ...(i === 0 ? { steer: true } : {}) }, ...(i > 0 && chance(r, 0.3) ? { visibility: "dm" as const } : {}) });
  }
  const tu = int(r, Math.ceil(inside ? startU : a) + 1, Math.floor(toU));
  state.traps.t1 = trap("t1", { zone: { cells: [chance(r, 0.6) ? m.cells(tu, wide, int(r, 1, 3), 1) : m.cells(tu, 0, 1, wide)] }, rig: { on: ["enter"], who: "any", floor: false, resets: "never", stops: chance(r, 0.5), foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false } });
  const pieces = int(r, 2, 4);
  const pts: [number, number, number, 0 | 1][] = [];
  for (let k = 1; k <= pieces; k++) {
    const u = (inside ? startU : a - s) + ((toU - (inside ? startU : a - s)) * k) / pieces;
    const p = k === pieces ? end : squeezedAt(Math.round(u * 4) / 4);
    pts.push([p.x, p.y, 0, 0]);
  }
  const op: Op = { t: "token.move", tokenId: "mount", x: end.x, y: end.y, squeeze: true, route: pts };
  return { kind, state, op, who: chance(r, 0.7) ? P1 : DM, opVersion: 35 };
}

const KINDS: readonly Kind[] = ["drag", "walk", "stop", "seats"];

function tailsOf(seed: number): Tail[] {
  return KINDS.map((k) => tailOf(seed, k));
}

function replay(t: Tail, opVersion: number | undefined): string {
  const out = applyOp(t.state, t.op, t.who, { seq: 11, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
  return hash128(stableStringify(out.ok ? { state: out.state, trapped: out.trapped ?? null } : { refused: out.code, message: out.message }));
}

describe("stored ops of change formats 65 and 35 replay to the states they made, the map's edge open (edgePinches)", () => {
  const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);

  test("a DM's drag with a Large creature in tow, a player's squeezed walk, a trap's stop and a rider's seats, in corridors along every side", () => {
    // One hash a seed over its four tails keeps the fixture small and still names the seed that moved.
    const now = { stored: seeds.map((seed) => hash128(tailsOf(seed).map((t) => replay(t, t.opVersion)).join(" "))) };
    if (process.env.REPLAY_EDGE === "write") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string[]>;
    assert.equal(now.stored.length, pinned.stored!.length, "as many seeds as pinned");
    const differ = now.stored.flatMap((h, i) => (h !== pinned.stored![i] ? [seeds[i]] : []));
    assert.deepEqual(differ, [], "these seeds' tails replay to other states");
  });

  test("the same moves as live ops end otherwise in many of each kind, so the pinned states test what change format 66 changes", () => {
    const moved: Record<Kind, number> = { drag: 0, walk: 0, stop: 0, seats: 0 };
    for (const seed of seeds) for (const t of tailsOf(seed)) if (replay(t, t.opVersion) !== replay(t, undefined)) moved[t.kind]++;
    if (process.env.REPLAY_EDGE === "count") console.log(moved);
    for (const k of KINDS) assert.ok(moved[k] >= 20, `${k}: ${moved[k]} of ${SEEDS} end otherwise`);
  });

  test("at change format 35 the mount's squeezes between its walk's ends, which seat its riders, read the walls alone where the side would pinch, in many", () => {
    // The seats' own read, as moveLeg.ts squeezedSeats makes it: the change format 66 parts from 35 in more than the edge, so this
    // pins that these tails reach the edge itself.
    let parted = 0;
    for (const seed of seeds) {
      const t = tailOf(seed, "seats");
      if (t.op.t !== "token.move" || !t.op.route) continue;
      const mount = t.state.tokens.mount!;
      const trace = routeWalkers(t.state.buildChunks, ownWalk(mount), t.op.route);
      const points = trace.map(({ x, y, elevation }) => ({ x, y, elevation }));
      const read = (build: BuildState) => walkSqueezes(build, mount, points, trace, true, 35).join();
      if (read(storedBuild(t.state, 35)) !== read(t.state)) parted++;
    }
    if (process.env.REPLAY_EDGE === "count") console.log({ parted });
    assert.ok(parted >= 20, `${parted} of ${SEEDS} walks read otherwise`);
  });
});
