import assert from "node:assert/strict";
import type { PathStop, RoomState, Token, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { pathThisTurn } from "./rules/path.ts";
import { findRoute } from "./rules/walk.ts";
import { publicWorld } from "./rules/walkWorld.ts";
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
  const world = publicWorld(view, mine, { role: drag.who.role }, stopsNow(view, mine, drag.who.role));
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
