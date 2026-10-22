import assert from "node:assert/strict";
import type { PathStop, RoomState, Token, Viewer } from "./model.ts";
import { canApply, mayMoveToken } from "./permissions.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { moveGroups, walkerFor } from "./rules/attach.ts";
import { pathThisTurn } from "./rules/path.ts";
import { findRoute } from "./rules/walk.ts";
import { groupWalkWorld, publicToken } from "./rules/walkWorld.ts";
import { env } from "./testutil.ts";

/**
 * The shared differential test of public determinism
 * (contract section 5, as docs/design-v1-movement.md 5.5 cites it, and 12):
 * pairs of rooms that differ only in state players cannot see, the same
 * drags made in both, and everything a player can observe compared. Each
 * feature adds its generators (movement's are in differential.test.ts).
 * Not a test file itself: node --test runs only `*.test.ts`.
 *
 * A drag is searched as the device that makes it searches: a player's on
 * their own copy of the room, the DM's on the whole room, both in the
 * public world. Its route's geometry, the op it sends, the answer, the drag
 * frame as each player receives it, and each player's copy of the room
 * afterward, its log included, must be the same in both rooms for every
 * player whose copy was the same before.
 */

export type Drag = { who: Viewer; tokenId: string; to: { x: number; y: number } };

export type Pair = {
  name: string;
  /** Two rooms that differ only in what players cannot see. */
  a: RoomState;
  b: RoomState;
  drags: readonly Drag[];
  /**
   * Parts of a player's copy left out of the comparison: data the copy
   * holds but the client never shows, such as the map's terrain under the
   * fog (docs/design-v1-heights-readout.md 1), which projections carry.
   */
  unshown?: readonly (keyof RoomState)[];
};

/** The players a pair is judged for: every player member. */
function players(state: RoomState): Viewer[] {
  return Object.values(state.members).flatMap((m) => (m && m.kind === "player" ? [{ memberId: m.id, role: "player" as const }] : []));
}

/** The room as this viewer's device holds it. */
function deviceView(state: RoomState, who: Viewer, sceneId: string): RoomState {
  return who.role === "dm" ? state : (projectState(state, who, { sceneId }) as unknown as RoomState);
}

/** The creature's stops this turn as a device holds them (client/features/measure/movement.ts pathNow). */
function stopsNow(view: RoomState, token: Token, role: Viewer["role"]): readonly PathStop[] {
  const e = view.encounter;
  if (!e || !token.path || e.activeEntryId === null) return [];
  if (e.turnStart?.entryId === e.activeEntryId) return pathThisTurn(e, token)?.stops ?? [];
  if (role === "dm") return [];
  return e.entries.find((x) => x.id === e.activeEntryId)?.tokenId === token.id ? token.path.stops : [];
}

/**
 * What one drag sends from one room: the route its device finds, the op,
 * and the search's inputs, which must match too, so a hidden fact that
 * happens not to bend this route still fails. Null when the device holds
 * no such token.
 */
function dragged(state: RoomState, drag: Drag): { route: unknown; op: Op; inputs: unknown } | null {
  const token = state.tokens[drag.tokenId];
  if (!token) return null;
  const view = deviceView(state, drag.who, token.sceneId);
  const mine = view.tokens[drag.tokenId];
  if (!mine) return null;
  // The world a device's drag searches, with what the token carries, walked as it walks off a holder every player sees (client/features/movement/press.ts worldFor).
  const byAll = (t: { id: string }) => view.tokens[t.id] !== undefined && publicToken(view, view.tokens[t.id]!, { role: drag.who.role });
  const world = groupWalkWorld(view, walkerFor(view, mine, byAll), { role: drag.who.role }, stopsNow(view, mine, drag.who.role));
  const found = findRoute(world.input, drag.to);
  const route = found === null || found === "none" ? found : found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]);
  const op: Op = { t: "token.move", tokenId: drag.tokenId, x: drag.to.x, y: drag.to.y, ...(Array.isArray(route) ? { route } : {}) };
  const { input } = world;
  const bounds = state.scenes[mine.sceneId]?.bounds ?? { w: 0, h: 0 };
  const seen: string[] = [];
  if (input.seen) for (let y = 0; y < bounds.h; y++) for (let x = 0; x < bounds.w; x++) if (input.seen(x, y)) seen.push(`${x},${y}`);
  const inputs = { counter: input.counter, creatures: input.creatures, areas: input.areas, prone: input.prone, seen: input.seen ? seen : null, spaces: world.spaces, halfSpeed: world.halfSpeed.map((t) => t.id) };
  return { route, op, inputs };
}

/** The drag frame a player receives (server/rooms/ephemeral.ts forPlayer): corners only where the scene has no fog or vision, and no cost. */
function frameFor(state: RoomState, op: Op): unknown {
  if (op.t !== "token.move") return null;
  const token = state.tokens[op.tokenId];
  const scene = token ? state.scenes[token.sceneId] : undefined;
  const corners = op.route ? op.route.slice(0, -1).flatMap(([x, y]) => [x, y]) : [];
  return scene?.fogEnabled || scene?.vision?.on === true ? null : corners;
}

export function checkPair(pair: Pair, seq = 3): void {
  for (const [i, drag] of pair.drags.entries()) {
    const where = `${pair.name}, drag ${i + 1} by ${drag.who.role}`;
    const sceneId = pair.a.tokens[drag.tokenId]?.sceneId ?? "s1";
    const seen = (state: RoomState, p: Viewer) => shown(projectState(state, p, { sceneId }), pair.unshown);
    const same = players(pair.a).filter((p) => isDeepEqual(seen(pair.a, p), seen(pair.b, p)));
    assert.ok(same.length > 0, `${where}: the rooms differ for every player, so the pair tests nothing`);
    if (drag.who.role === "player") assert.ok(same.some((p) => p.memberId === drag.who.memberId), `${where}: the acting player's copies differ, so the pair tests nothing`);
    const da = dragged(pair.a, drag);
    const db = dragged(pair.b, drag);
    assert.deepEqual(da?.route, db?.route, `${where}: the route differs`);
    if (!da || !db) continue;
    assert.deepEqual(da.inputs, db.inputs, `${where}: the search's inputs differ`);
    assert.deepEqual(da.op, db.op, `${where}: the op differs`);
    assert.deepEqual(frameFor(pair.a, da.op), frameFor(pair.b, db.op), `${where}: the drag frame differs`);
    const ra = applyOp(pair.a, da.op, drag.who, env(seq));
    const rb = applyOp(pair.b, db.op, drag.who, env(seq));
    assert.deepEqual(ra.ok ? "ok" : `${ra.code}: ${ra.message}`, rb.ok ? "ok" : `${rb.code}: ${rb.message}`, `${where}: the answer differs`);
    if (!ra.ok || !rb.ok) continue;
    for (const p of same) {
      assert.deepEqual(seen(ra.state, p), seen(rb.state, p), `${where}: ${p.memberId} sees the rooms differ after it`);
    }
  }
}

/**
 * One step of a sequence the rooms of a pair go through together: an op by
 * a viewer, fixed, or made from that viewer's device copy (as the bar or a
 * drop makes it). A step may also stand for the server's own op, such as
 * an undo it builds, by `build` from the room as it stands.
 */
export type Step = { who: Viewer; op: Op | ((view: RoomState, state: RoomState) => Op | null); note?: string };

/** A pair of rooms differing only in what players cannot see, and the steps both go through (attached tokens, docs/design-v1-attach.md 8.0). */
export type OpPair = Omit<Pair, "drags"> & { steps: readonly Step[] };

/**
 * How a step is checked and applied: by default as the server does,
 * permissions then the reducer. `mark` is what the server keeps beside the
 * room, such as whether a player's undo step is trapped
 * (docs/design-v1-traps.md 6.5), which must be the same in both rooms too.
 */
export type Applier = (state: RoomState, op: Op, who: Viewer, seq: number) => { ok: true; state: RoomState; mark?: string } | { ok: false; code: string; message: string };

const deps = { canUseAsset: () => true };

export const serverApply: Applier = (state, op, who, seq) => {
  const decision = canApply(op, who, state, deps);
  if (!decision.ok) return decision;
  const r = applyOp(state, op, who, env(seq));
  return r.ok ? { ok: true, state: r.state, ...(r.trapped ? { mark: "trapped" } : {}) } : r;
};

/**
 * Runs a pair's steps in both rooms and compares everything a player can
 * observe (contract section 5): for each step, the op the device makes,
 * the answer and its words, whether each token the acting player's device
 * moves may send drag frames (server/rooms/ephemeral.ts), and each
 * player's copy after it, its log and so its `ev` stream included, for
 * every player whose copy was the same before the sequence began. The
 * steps go on from where each room's last step left it.
 */
export function checkOps(pair: OpPair, applier: Applier = serverApply, firstSeq = 3): { a: RoomState; b: RoomState } {
  const sceneId = pair.a.meta.playerSceneId ?? "s1";
  const seen = (state: RoomState, p: Viewer) => shown(projectState(state, p, { sceneId }), pair.unshown);
  const same = players(pair.a).filter((p) => isDeepEqual(seen(pair.a, p), seen(pair.b, p)));
  assert.ok(same.length > 0, `${pair.name}: the rooms differ for every player, so the pair tests nothing`);
  let a = pair.a;
  let b = pair.b;
  for (const [i, step] of pair.steps.entries()) {
    const where = `${pair.name}, step ${i + 1}${step.note ? ` (${step.note})` : ""} by ${step.who.memberId}`;
    if (step.who.role === "player") assert.ok(same.some((p) => p.memberId === step.who.memberId), `${where}: the acting player's copies differ, so the step tests nothing`);
    const make = (state: RoomState) => (typeof step.op === "function" ? step.op(deviceView(state, step.who, sceneId), state) : step.op);
    const oa = make(a);
    const ob = make(b);
    assert.deepEqual(step.who.role === "player" ? oa : oa === null, step.who.role === "player" ? ob : ob === null, `${where}: the op differs`);
    if (oa === null || ob === null) continue;
    if (step.who.role === "player") {
      const frames = (state: RoomState, op: Op) => framesOf(state, op, step.who, sceneId);
      assert.deepEqual(frames(a, oa), frames(b, ob), `${where}: the drag frames differ`);
    }
    const ra = applier(a, oa, step.who, firstSeq + i);
    const rb = applier(b, ob, step.who, firstSeq + i);
    assert.deepEqual(ra.ok ? "ok" : `${ra.code}: ${ra.message}`, rb.ok ? "ok" : `${rb.code}: ${rb.message}`, `${where}: the answer differs`);
    if (ra.ok && rb.ok) {
      assert.equal(ra.mark, rb.mark, `${where}: what the server keeps of the step differs`);
      a = ra.state;
      b = rb.state;
    }
    for (const p of same) assert.deepEqual(seen(a, p), seen(b, p), `${where}: ${p.memberId} sees the rooms differ after it`);
  }
  return { a, b };
}

/** The drag frames a player's device sends for a move: each token of the group its copy holds, and whether the server passes it on. */
function framesOf(state: RoomState, op: Op, who: Viewer, sceneId: string): [string, boolean][] {
  if (op.t !== "token.move" && op.t !== "token.moveMany") return [];
  const view = deviceView(state, who, sceneId);
  const named = op.t === "token.move" ? [op.tokenId] : op.moves.map((m) => m.tokenId);
  const out: [string, boolean][] = [];
  for (const ids of moveGroups(view.tokens, named).values()) for (const id of ids) out.push([id, mayMoveToken(state, who, id).ok]);
  return out;
}

function shown(copy: object, unshown: readonly string[] | undefined): object {
  if (!unshown) return copy;
  const out: Record<string, unknown> = { ...copy };
  for (const key of unshown) delete out[key];
  return out;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}
