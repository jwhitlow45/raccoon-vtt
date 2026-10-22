import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { inSightOfNonOwners } from "#shared/project.ts";
import { MAX_ROUTE_PIECES, MAX_ROUTE_REACH, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { walkerFor } from "#shared/rules/attach.ts";
import { legBlocker } from "#shared/rules/movement.ts";
import { routePoints, routeReach, routeStop, type RoutePiece } from "#shared/rules/route.ts";
import { DM, P1, actor, chance, effect, env, int, pick, rng, token } from "#shared/testutil.ts";
import { dragOf, groupDragOf } from "../movement/dragTesting.ts";
import { dropLanding, dropView, walkerOf } from "../movement/drop.ts";
import { world } from "../movement/testing.ts";
import { copyFor } from "./testing.ts";

/**
 * The planner's walks of attached tokens against the server (review
 * AT-ASTRA-13, the attach side of movement's drop tests): riders on a
 * holder that straddles a step, holders that drag a creature beside them
 * and riders that drag one, among walls and raised ground, under both
 * diagonal rules. Each drag is planned on the mover's own copy as the board
 * plans it, by the board's own drag stops (dragTesting.ts), and its op must
 * pass the server's check and the route check the drop runs (route.ts
 * routeStop), apply, land where the picture showed it, and store the cost
 * the picture and the frames read. A route the search found that the drop
 * did not take must be one that check refuses.
 */

type Case = { state: RoomState; mover: string; who: Viewer };

function grappled(id: string, over: Partial<Token>): Token {
  return token(id, { name: id, size: "small", actor: { inline: actor({ effects: [effect(`g${id}`, { key: "grappled" })] }) }, ...over });
}

function randomCase(r: () => number): Case {
  const hx = int(r, 4, 12);
  const hy = int(r, 4, 12);
  const edges: Record<string, EdgeFeature> = {};
  const heights: Record<string, number> = {};
  // The step under the horse, its high half on one side, the ground beyond it raised as far as the scene goes.
  const high = chance(r, 0.5) ? hx + 1 : hx;
  const right = high === hx + 1;
  for (let y = 0; y < 30; y++) for (let x = right ? high : 0; x < (right ? 30 : high + 1); x++) heights[`${x},${y}`] = 10;
  // Raised cells and walls around it.
  for (let i = int(r, 0, 4); i > 0; i--) heights[`${int(r, hx - 4, hx + 5)},${int(r, hy - 4, hy + 5)}`] = pick(r, [5, 15]);
  for (let i = int(r, 0, 3); i > 0; i--) {
    const at = int(r, hx - 4, hx + 5);
    const from = int(r, hy - 4, hy + 2);
    for (let v = from; v < from + int(r, 1, 5); v++) edges[chance(r, 0.5) ? `${at},${v},w` : `${v},${at},n`] = { kind: "wall" };
  }
  // Now and then a wall right across the scene, so a walk past it finds no way and is held at it, straight.
  if (chance(r, 0.3)) {
    const at = int(r, hx - 4, hx + 6);
    for (let v = 0; v < 30; v++) edges[`${at},${v},w`] = { kind: "wall" };
  }
  const flies = chance(r, 0.15);
  const horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: chance(r, 0.7) ? ["p1"] : [], x: hx, y: hy, elevation: flies ? 20 : 10, actor: { inline: actor({ speeds: { walk: 60 } }) } });
  // An independent ride: a drag of a controlled mount's rider moves the mount instead (Stage.tsx), so the board never walks her alone.
  const bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: hx + int(r, 0, 1), y: hy + int(r, 0, 1), elevation: horse.elevation, actor: { inline: actor({ speeds: { walk: 30 } }) }, attached: { to: "horse", kind: "ride" } });
  const shape = r();
  const tokens: Token[] = [horse];
  let mover = "bree";
  if (shape < 0.5) tokens.push(bree);
  else if (shape < 0.75) {
    // The horse drags a goblin beside it, and is the one moved.
    tokens.push(grappled("goblin", { x: hx - 1, y: hy + int(r, 0, 1), attached: { to: "horse", kind: "drag" } }));
    horse.ownerIds = ["p1"];
    mover = "horse";
  } else {
    // Bree, on the horse, drags a kobold standing beside it.
    tokens.push(bree, grappled("kobold", { x: right ? hx - 1 : hx + 2, y: bree.y, attached: { to: "bree", kind: "drag" } }));
  }
  tokens.push(token("gob", { name: "Goblin", x: 25, y: 25 }));
  // A token of the player's far off, on its own ground, to drag in a group with the mover.
  tokens.push(token("mate", { name: "Mate", kind: "pc", ownerIds: ["p1"], x: 25, y: 2, elevation: right ? 10 : 0 }));
  let state = world({ blockMovement: chance(r, 0.75), edges, heights, tokens });
  state.meta.settings = { ...state.meta.settings, diagonal: pick(r, ["five", "fiveTen"] as const) };
  for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: mover, value: 20 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
    const out = applyOp(state, op, DM, env(i + 1));
    assert.ok(out.ok);
    state = out.state;
  }
  return { state, mover, who: chance(r, 0.8) ? P1 : DM };
}

const seenAll = (state: RoomState) => (t: { id: string }) => state.tokens[t.id] !== undefined && inSightOfNonOwners(state, state.tokens[t.id]!, {});

/** The server's own test of a plain leg (permissions.ts legCheck), walked off a holder every player sees on the ground (rules/attach.ts walkerFor). */
function plainLegStop(state: RoomState, tokenId: string, to: { x: number; y: number; elevation?: number }): string | null {
  const token = state.tokens[tokenId]!;
  const end = { x: to.x, y: to.y, elevation: to.elevation ?? token.elevation };
  if (state.scenes[token.sceneId]!.blockMovement !== true || (end.x === token.x && end.y === token.y)) return null;
  return legBlocker(state, walkerFor(state, token, seenAll(state)), end);
}

/** Whether a move's route is the one the search found, piece for piece. */
function sameRoute(route: readonly RoutePiece[] | undefined, found: readonly RoutePiece[]): boolean {
  return route !== undefined && route.length === found.length && route.every((p, i) => p.every((v, k) => v === found[i]![k]));
}

describe("a drag of an attached token plans the walk the server takes and stores what the picture read (review AT-ASTRA-13)", () => {
  test("random riders, holders and draggers on straddling holders, steps and walls", () => {
    let moved = 0;
    let routed = 0;
    let off = 0;
    let refusedRoutes = 0;
    let held = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const c = randomCase(r);
      const mover = c.state.tokens[c.mover]!;
      const raw = { x: Math.max(0, Math.min(28, mover.x + int(r, -5, 5))), y: Math.max(0, Math.min(28, mover.y + int(r, -5, 5))) };
      const copy = c.who.role === "dm" ? c.state : copyFor(c.state, c.who);
      const drag = dragOf(copy, c.who.role, c.mover, raw);
      const where = `seed ${seed} (${c.who.memberId} drags ${c.mover} to ${raw.x},${raw.y}, ${drag.answer.kind})`;
      if (!drag.op) continue;
      const op = drag.op as Op;
      const allowed = canApply(op, c.who, c.state, { canUseAsset: () => true });
      assert.ok(allowed.ok, `${where}: ${allowed.ok ? "" : allowed.message} for ${JSON.stringify(op)}`);
      const blocks = c.state.scenes[mover.sceneId]!.blockMovement === true;
      const route = op.t === "token.move" ? op.route : undefined;
      if (blocks && route && op.t === "token.move") {
        // The route as the server walks it, off a holder every player sees on the ground (rules/attach.ts walkerFor).
        const walker = walkerFor(c.state, mover, seenAll(c.state));
        assert.equal(routeStop(c.state, walker, route, op.elevation ?? mover.elevation), null, `${where}: the route check refuses ${JSON.stringify(op)}`);
      }
      // And a player's plain leg as the server's own leg test walks it, not only as canApply judges it. The DM's drop goes through.
      if (c.who.role === "player" && !route && op.t === "token.move") assert.equal(plainLegStop(c.state, c.mover, op), null, `${where}: the leg test stops ${JSON.stringify(op)}`);
      const found = drag.answer.kind === "route" ? drag.answer.route.pieces : null;
      if (blocks && found && found.length <= MAX_ROUTE_PIECES && !drag.plan.stop && !sameRoute(route, found)) {
        // The drop went another way than the search found: only since the check refuses that route, judged on the mover's copy as the drop judges it.
        const view = dropView(copy, c.who.role);
        const end = found[found.length - 1]!;
        const at = { x: end[0], y: end[1] };
        const walking = walkerOf(view, view.tokens[c.mover]!);
        const landing = dropLanding(view, view.tokens[c.mover]!, at);
        const refused = routeStop(view, walking, found, landing) !== null || routeReach(routePoints(view.buildChunks, walking, found, landing), view.meta.settings.feetPerCell) > MAX_ROUTE_REACH;
        assert.ok(refused, `${where}: the drop left a route the check takes, ${JSON.stringify(found)} for ${JSON.stringify(op)}`);
        refusedRoutes++;
      }
      const applied = applyOp(c.state, op, c.who, env(10));
      assert.ok(applied.ok, `${where}: ${applied.ok ? "" : applied.message}`);
      const after = applied.state.tokens[c.mover]!;
      assert.deepEqual(drag.preview.to, { x: after.x, y: after.y }, `${where}: the picture showed another spot`);
      const before = mover.path?.stops.length ?? 1;
      const stored = (after.path?.stops ?? []).slice(before).reduce((sum, s) => sum + (s.cost ?? 0), 0);
      assert.equal(drag.preview.read.dragFt, stored, `${where}: the band read another cost than the one stored, ${JSON.stringify(op)}`);
      assert.equal(drag.frame.ft, stored, `${where}: the frames sent another cost than the one stored`);
      moved++;
      if (drag.answer.kind === "none") held++;
      if (op.t === "token.move" && op.route) routed++;
      if (mover.attached && !after.attached) off++;
    }
    // A run that never walks off a mount, along a route or held at a wall tests nothing.
    assert.ok(moved > 200 && routed > 30 && off > 60 && held > 10, JSON.stringify({ moved, routed, off, held, refusedRoutes }));
  });

  test("random group drags of the same with a token of the player's far off: each leg is one the server's leg test takes, and the label reads what it stores", () => {
    let groups = 0;
    let legs = 0;
    let heldBack = 0;
    let groupOff = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const c = randomCase(r);
      const mover = c.state.tokens[c.mover]!;
      const raw = { x: Math.max(0, Math.min(28, mover.x + int(r, -5, 5))), y: Math.max(0, Math.min(28, mover.y + int(r, -5, 5))) };
      const copy = c.who.role === "dm" ? c.state : copyFor(c.state, c.who);
      const drag = groupDragOf(copy, c.who.role, [c.mover, "mate"], raw);
      const where = `seed ${seed} (${c.who.memberId} drags ${c.mover} and mate to ${raw.x},${raw.y})`;
      heldBack += drag.plan.held.length;
      if (!drag.op) continue;
      const op = drag.op as Op;
      const allowed = canApply(op, c.who, c.state, { canUseAsset: () => true });
      assert.ok(allowed.ok, `${where}: ${allowed.ok ? "" : allowed.message} for ${JSON.stringify(op)}`);
      const moves = op.t === "token.moveMany" ? op.moves : op.t === "token.move" ? [op] : [];
      if (c.who.role === "player") for (const m of moves) assert.equal(plainLegStop(c.state, m.tokenId, m), null, `${where}: the leg test stops ${JSON.stringify(m)}`);
      const applied = applyOp(c.state, op, c.who, env(10));
      assert.ok(applied.ok, `${where}: ${applied.ok ? "" : applied.message}`);
      for (const m of moves) assert.deepEqual([applied.state.tokens[m.tokenId]!.x, applied.state.tokens[m.tokenId]!.y], [m.x, m.y], `${where}: ${m.tokenId} landed elsewhere`);
      // The mover's label and frames read the cost its leg stores, a dismount on its own turn included (review AT-ASTRA-15).
      const lead = moves.find((m) => m.tokenId === c.mover);
      if (lead) {
        const before = mover.path?.stops.length ?? 1;
        const stored = (applied.state.tokens[c.mover]!.path?.stops ?? []).slice(before).reduce((sum, s) => sum + (s.cost ?? 0), 0);
        assert.deepEqual([drag.label.dragFt, drag.frame.ft], [stored, stored], `${where}: the label and the frames read another cost than the one stored, ${JSON.stringify(op)} ${JSON.stringify({ label: drag.label.dragFt, frame: drag.frame.ft, stored, from: [mover.x, mover.y, mover.elevation], stops: applied.state.tokens[c.mover]!.path?.stops.slice(before) })}`);
        if (mover.attached && !applied.state.tokens[c.mover]!.attached) groupOff++;
      }
      groups++;
      legs += moves.length;
    }
    assert.ok(groups > 200 && heldBack > 30 && groupOff > 40, JSON.stringify({ groups, legs, heldBack, groupOff }));
  });
});
