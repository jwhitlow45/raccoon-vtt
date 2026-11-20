import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { COLUMNS, ROWS } from "../rules/hexWalls.testkit.ts";
import { AT, chance, DM, int, member, P1, pick, rng, room, scene, token, trap } from "../testutil.ts";
import { caseOf, insideCaseOf, raised, seatedMove, withImpAhead, withMouse, withOgre, withRises, withStop, type Case } from "./hexFile.testkit.ts";

/**
 * Stored ops of change format 62 replay to the states they made (design
 * 16.2), whatever change format 63 (migrate.ts DROP_SEAT_OP_VERSION) changed:
 * a rider's dropped seat, a walk in single file holding its last hex to its
 * holder's end, the straight way onto the holder's start, and a stop's step
 * apart in reach. Each tail is one move of hexFile.testkit.ts's random rooms,
 * on hex rows and columns, in a corridor or into one, flying down or not,
 * with traps that stop it, an imp ahead, a mouse or an ogre in tow, raised
 * ground, and a rider's seat on open ground, and of a square corridor a
 * mount squeezes into with creatures in tow and a stop trap, by Pat and by
 * the DM. The hash covers the whole state the move leaves. Write the fixture
 * again with REPLAY_HEXOP=write only for a change meant to move them, from
 * the build the stored ops were written by.
 */

const FIXTURE = new URL("./hexOp.replay.fixture.json", import.meta.url);
const SEEDS = 200;

type Tail = { state: RoomState; op: Op };

/** The hex tails of one seed: the room's own move, and its variants. */
function hexTails(seed: number): Tail[] {
  const out: Tail[] = [];
  for (const g of [ROWS, COLUMNS]) {
    for (const make of [caseOf, insideCaseOf]) {
      const room = make(seed, g);
      if (!room) continue;
      const variants: (Case | null)[] = [room, withStop(room, seed), withImpAhead(room, seed), withMouse(room, seed), withOgre(room, seed), withRises(room, seed), raised(room, 40, 0), withStop(raised(room, 40, 25), seed), seatedMove(g, room, seed)];
      for (const made of variants) if (made) out.push({ state: made.state, op: made.op });
    }
  }
  return out;
}

/** A square corridor one or two squares wide through rock, a Large mount squeezing in or out with creatures in tow, some hidden, and a stop trap now and then. */
function squareTail(seed: number): Tail {
  const r = rng(seed * 6271 + 21);
  const wide = pick(r, [1, 1, 2] as const);
  const top = int(r, 5, 9);
  const state = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1", { bounds: { w: 26, h: 18 }, blockMovement: true, autoWalls: "off", fogEnabled: chance(r, 0.3) }) },
  });
  state.buildChunks = {};
  const bottom = top + wide;
  for (const [i, [a, b]] of (
    [
      [[8, 0], [8, top]],
      [[8, bottom], [8, 18]],
      [[16, 0], [16, top]],
      [[16, bottom], [16, 18]],
      [[8, top], [12, top]],
      [[12, top], [16, top]],
      [[8, bottom], [12, bottom]],
      [[12, bottom], [16, bottom]],
    ] as [[number, number], [number, number]][]
  ).entries()) {
    if (Math.abs(b[1] - a[1]) <= 8) wall(state, `hexop${String(i).padStart(7, "0")}`, a, b);
    else {
      const m: [number, number] = [a[0], (a[1] + b[1]) / 2];
      wall(state, `hexop${String(i).padStart(6, "0")}a`, a, m);
      wall(state, `hexop${String(i).padStart(6, "0")}b`, m, b);
    }
  }
  const inside = chance(r, 0.5);
  const mx = inside ? int(r, 9, 13) + 0.5 : int(r, 4, 6);
  const my = inside ? top - 0.5 : top - int(r, 0, 1);
  const mount: Token = { ...token("mount", { size: "large", x: mx, y: my, name: "Warhorse", kind: "npc", ownerIds: ["p1"] }), ...(inside ? { squeeze: true as const } : {}) };
  state.tokens.mount = mount;
  if (chance(r, 0.5)) state.tokens.rider0 = token("rider0", { x: Math.floor(mx), y: Math.floor(my) + (inside ? 1 : 0), name: "Rider", kind: "pc", ownerIds: ["p1"], attached: { to: "mount", kind: "ride", steer: true } });
  for (let i = 0, n = int(r, 1, 3); i < n; i++) {
    state.tokens[`tow${i}`] = token(`tow${i}`, {
      size: pick(r, ["medium", "medium", "small"] as const),
      x: Math.floor(mx) - 1 - i,
      y: top,
      name: `Goblin ${i + 1}`,
      kind: "npc",
      attached: { to: i > 0 && chance(r, 0.3) ? `tow${i - 1}` : "mount", kind: "drag" },
      ...(chance(r, 0.3) ? { visibility: "dm" as const } : {}),
    });
  }
  if (chance(r, 0.6)) state.traps.t1 = trap("t1", { zone: { cells: [{ x: int(r, 9, 14), y: top, w: 1, h: wide }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false } });
  const to = int(r, 9, 15) + 0.5;
  const op: Op = { t: "token.move", tokenId: "mount", x: to, y: top - 0.5, squeeze: true, ...(chance(r, 0.6) ? { route: [[Math.min(mx, to) - 0.5, top - 0.5, 0, 0], [to, top - 0.5, 1, 0]] as [number, number, number, 0 | 1][] } : {}) };
  return { state, op };
}

function replay(t: Tail, who: Viewer, opVersion: number | undefined): string {
  const out = applyOp(t.state, t.op, who, { seq: 11, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
  return hash128(stableStringify(out.ok ? { state: out.state, trapped: out.trapped ?? null } : { refused: out.code, message: out.message }));
}

function tailsOf(seed: number): Tail[] {
  return [...hexTails(seed), squareTail(seed)];
}

function tails(): Tail[] {
  const out: Tail[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) out.push(...tailsOf(seed));
  return out;
}

/** The tail as a stored op of change format 62 holds it: that format had no seat. */
function stored(t: Tail): Tail {
  if (t.op.t !== "token.move" || !t.op.seat) return t;
  const { seat: _seat, ...op } = t.op;
  return { ...t, op };
}

describe("stored ops of change format 62 replay to the states they made (DROP_SEAT_OP_VERSION)", () => {
  test("hex rooms in single file, flying, stopped, with riders' seats, and square corridors, by Pat and by the DM", () => {
    // One hash a seed, over each of its tails by Pat and by the DM, keeps the fixture small and still names the seed that moved.
    const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
    const now = { "62": seeds.map((seed) => hash128(tailsOf(seed).map(stored).flatMap((t) => [replay(t, P1, 62), replay(t, DM, 62)]).join(" "))) };
    if (process.env.REPLAY_HEXOP === "write") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string[]>;
    assert.equal(now["62"].length, pinned["62"]!.length, "as many seeds as pinned");
    const differ = now["62"].flatMap((h, i) => (h !== pinned["62"]![i] ? [seeds[i]] : []));
    assert.deepEqual(differ, [], "these seeds' tails replay to other states at op 62");
  });

  test("the same moves as live ops end otherwise in many, so the pinned states test what change format 63 changes", () => {
    const all = tails();
    let moved = 0;
    for (const t of all) for (const who of [P1, DM]) if (replay(t, who, 62) !== replay(t, who, undefined)) moved++;
    assert.ok(moved >= 200, `${moved} of ${all.length * 2} moves end otherwise`);
  });

  test("a seat on an op of change format 62 changes nothing", () => {
    let seated = 0;
    for (const t of tails()) {
      if (t.op.t !== "token.move" || !t.op.seat) continue;
      seated++;
      for (const who of [P1, DM]) assert.equal(replay(t, who, 62), replay(stored(t), who, 62));
    }
    assert.ok(seated >= 40, `${seated} seated moves`);
  });
});
