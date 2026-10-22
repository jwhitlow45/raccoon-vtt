import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { inSightOfNonOwners, isPartyMember } from "#shared/project.ts";
import { MAX_ROUTE_PIECES, MAX_ROUTE_REACH, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { walkerFor } from "#shared/rules/attach.ts";
import { LEDGE_IN_THE_WAY, legBlocker, ownWalk } from "#shared/rules/movement.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import type { Point, Rect } from "#shared/rules/geom.ts";
import { routePoints, routeReach, routeStop, type RoutePiece, type RoutePoint } from "#shared/rules/route.ts";
import { DM, P1, actor, chance, effect, env, int, pick, reveal, rng, token } from "#shared/testutil.ts";
import { dragOf, groupDragOf } from "../movement/dragTesting.ts";
import { dropLanding, dropView, walkerOf } from "../movement/drop.ts";
import { world } from "../movement/testing.ts";
import { tokenStop, type RulerStop } from "../measure/ruler.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { copyFor } from "./testing.ts";

/**
 * The planner's walks of attached tokens against the server (reviews
 * AT-ASTRA-13, AT-O-26, AT-ASTRA-16 and AT-ASTRA-17, the attach side of
 * movement's drop tests): riders on a holder that straddles a step or stands
 * wholly on a plateau at its edge, a rider on a cart that straddles a step
 * among walls that send a walk off it and back over it, holders that drag
 * a creature beside them and riders that drag one, among walls and raised
 * ground, beside the holder too, under both diagonal rules. Each drag is
 * planned on the mover's own copy as the board plans it, by the board's own
 * drag stops (dragTesting.ts), and its op must pass the server's check and
 * the route check the drop runs (route.ts routeStop), apply, land where the
 * picture showed it, and store the cost the picture and the frames read.
 * The search never finds a route that check refuses. Two checks of the
 * walk's own read every sent leg apart from the rule's code: no leg's
 * straight line crosses a wall, and no piece after the walk first clears
 * the holder crosses a ledge.
 */

type Layout = "straddle" | "plateau" | "cart" | "beside";

/** `aim`, on a cart, is a drop point that lands a creature squeezed in its gap, or one it reaches only off the cart and back over it. */
type Case = { state: RoomState; mover: string; who: Viewer; walls: RoomState["buildChunks"]; layout: Layout; aim?: Point };

function grappled(id: string, over: Partial<Token>): Token {
  return token(id, { name: id, size: "small", actor: { inline: actor({ effects: [effect(`g${id}`, { key: "grappled" })] }) }, ...over });
}

/** A random case, or one of `only`'s layout: a cart's with its walls, or with a gap a Large or Huge creature squeezes through. */
function randomCase(r: () => number, only?: Layout | "gap"): Case {
  const hx = int(r, 4, 12);
  const hy = int(r, 4, 12);
  const edges: Record<string, EdgeFeature> = {};
  const heights: Record<string, number> = {};
  const picked = pick<Layout>(r, ["straddle", "straddle", "plateau", "cart", "beside"]);
  const layout = only === "gap" ? "cart" : (only ?? picked);
  const right = chance(r, 0.5);
  // The ground's 10 ft step, as far as the scene goes: under the horse's middle, at the horse's own side for a plateau, along a cart's middle.
  const step = layout === "plateau" ? (right ? hx : hx + 2) : layout === "cart" ? hx + 2 : hx + 1;
  for (let y = 0; y < 30; y++) for (let x = right ? step : 0; x < (right ? 30 : step); x++) heights[`${x},${y}`] = 10;
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
  // Beside the horse, outside its footprint, a short wall or a raised square that a leg bent at the first square clear of it would miss.
  if (layout === "beside") {
    const side = pick(r, [hx - 1, hx, hx + 2, hx + 3]);
    const along = pick(r, [hy - 2, hy + 2, hy + 3]);
    if (chance(r, 0.5)) edges[chance(r, 0.5) ? `${side},${along},w` : `${along},${side},n`] = { kind: "wall" };
    else heights[`${side},${along}`] = pick(r, [5, 20]);
  }
  if (layout === "cart") return cartCase(r, hx, hy, right, edges, heights, only === "cart" ? "walls" : only === "gap" ? "gap" : null);
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
  return roomOf(r, edges, heights, tokens, mover, layout);
}

/**
 * A 4 by 4 cart at the horse's spot, at 10 ft, along whose middle the step
 * runs, with Bree on its low half: Medium, or now and then Large or Huge,
 * so she squeezes (review AT-ASTRA-19). Now and then a Medium Bree sits on
 * its first row and the walls keep her from walking across it or down it
 * on it, so a walk to the rest of it leaves the cart and comes back over it
 * (review AT-ASTRA-16): along the step down to the first row, and under
 * the first row from beside the cart on. Now and then, below the cart, a
 * wall beside the step leaves a gap on the low ground between them, one
 * size too narrow for a Large or Huge Bree, which she squeezes through.
 * `force` asks for the walls or the gap.
 */
function cartCase(r: () => number, hx: number, hy: number, right: boolean, edges: Record<string, EdgeFeature>, heights: Record<string, number>, force: "walls" | "gap" | null): Case {
  const size = force === "walls" ? "medium" : force === "gap" ? pick(r, ["large", "huge"] as const) : pick(r, ["medium", "medium", "large", "huge"] as const);
  const side = size === "huge" ? 3 : size === "large" ? 2 : 1;
  const walled = side === 1 && (force === "walls" || (force === null && chance(r, 0.6)));
  if (walled) {
    for (let y = 0; y <= hy; y++) edges[`${hx + 2},${y},w`] = { kind: "wall" };
    for (let x = right ? hx - 1 : 0; x < (right ? 30 : hx + 5); x++) edges[`${x},${hy + 1},n`] = { kind: "wall" };
  }
  // The gap's low side starts at `gap`: past the step on the low half's side, as wide as the squeezed footprint.
  const gap = right ? hx + 2 - Math.max(1, side - 1) : hx + 2;
  const gapped = force === "gap" || (force === null && chance(r, 0.5));
  if (gapped) for (let y = hy + 4; y < 30; y++) edges[`${right ? gap : gap + Math.max(1, side - 1)},${y},w`] = { kind: "wall" };
  const wagon = token("cart", { name: "Cart", kind: "object", size: "gargantuan", x: hx, y: hy, elevation: 10 });
  // On the low half, or as much of it as she covers.
  const x = right ? hx + (side === 1 ? int(r, 0, 1) : 0) : hx + 4 - side - (side === 1 ? int(r, 0, 1) : 0);
  const bree = token("bree", { name: "Bree", kind: "pc", size, ownerIds: ["p1"], x, y: hy + (walled ? 0 : int(r, 0, 4 - side)), elevation: 10, actor: { inline: actor({ speeds: { walk: 30 } }) }, attached: { to: "cart", kind: "carry" } });
  const tokens = [wagon, bree, token("gob", { name: "Goblin", x: 25, y: 25 }), token("mate", { name: "Mate", kind: "pc", ownerIds: ["p1"], x: 25, y: 2, elevation: right ? 10 : 0 })];
  const c = roomOf(r, edges, heights, tokens, "bree", "cart");
  // Half a square inside the full footprint that is squeezed into the gap, as a finger off the squares drops it (drop.ts squeezedSpot).
  if (gapped && side > 1) return { ...c, aim: { x: gap - 1 + 0.2, y: hy + int(r, 5, 10) + 0.3 } };
  // Or past the wall under her row, on the cart's low half, which she reaches only off the cart and back over it.
  return force === "walls" ? { ...c, aim: { x, y: hy + int(r, 2, 3) } } : c;
}

function roomOf(r: () => number, edges: Record<string, EdgeFeature>, heights: Record<string, number>, tokens: Token[], mover: string, layout: Layout): Case {
  let state = world({ blockMovement: chance(r, 0.75), edges, heights, tokens });
  state.meta.settings = { ...state.meta.settings, diagonal: pick(r, ["five", "fiveTen"] as const) };
  for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: mover, value: 20 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
    const out = applyOp(state, op, DM, env(i + 1));
    assert.ok(out.ok);
    state = out.state;
  }
  return { state, mover, who: chance(r, 0.8) ? P1 : DM, walls: world({ edges }).buildChunks, layout };
}

const seenAll = (state: RoomState) => (t: { id: string }) => state.tokens[t.id] !== undefined && inSightOfNonOwners(state, state.tokens[t.id]!, {});

/** The server's own test of a plain leg (permissions.ts legCheck), walked off a holder every player sees on the ground (rules/attach.ts walkerFor). */
function plainLegStop(state: RoomState, tokenId: string, to: { x: number; y: number; elevation?: number }): string | null {
  const token = state.tokens[tokenId]!;
  const end = { x: to.x, y: to.y, elevation: to.elevation ?? token.elevation };
  if (state.scenes[token.sceneId]!.blockMovement !== true || (end.x === token.x && end.y === token.y)) return null;
  return legBlocker(state, walkerFor(state, token, seenAll(state)), end);
}

/**
 * Two reads of a walk a player sends, apart from the rule's code (reviews
 * AT-ASTRA-16 and AT-ASTRA-17), its start and then each piece's end, or
 * where null. No piece's straight line crosses a wall, judged on the walls
 * alone for the token with no holder, so no leg bends round one. And no
 * piece from the walk's first stop clear of its holder on crosses a ledge,
 * judged for the token off no holder, so a walk that comes back over the
 * holder crosses no step under it. `reentered` hears of a walk that does
 * come back over it.
 */
function walkFault(c: Case, tokenId: string, points: readonly RoutePoint[], reentered: () => void = () => {}): string | null {
  const token = c.state.tokens[tokenId]!;
  const walker = walkerFor(c.state, token, seenAll(c.state));
  const holder = walker.offHolder ? footprintRect(walker.offHolder) : null;
  const { offHolder: _holder, ...cleared } = walker;
  const wallsOnly: RoomState = { ...c.state, buildChunks: c.walls };
  let clear = false;
  let back = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const squeeze = i === 1 ? token.squeeze : undefined;
    if (legBlocker(wallsOnly, ownWalk({ ...token, attached: undefined, x: a.x, y: a.y, elevation: a.elevation, squeeze }), points[i]!) === "wall") return `piece ${i - 1} crosses a wall`;
    if (!holder) continue;
    const on = overlaps(footprintRect({ ...token, x: a.x, y: a.y, squeeze: undefined }), holder);
    back ||= clear && on;
    clear ||= !on;
    if (clear && legBlocker(c.state, { ...cleared, x: a.x, y: a.y, elevation: a.elevation, squeeze }, points[i]!) === "ledge") return `piece ${i - 1}, after the walk cleared its holder, crosses a ledge`;
  }
  const end = points[points.length - 1]!;
  if (holder && (back || (clear && overlaps(footprintRect({ ...token, x: end.x, y: end.y, squeeze: undefined }), holder)))) reentered();
  return null;
}

function overlaps(a: Rect, b: Rect): boolean {
  const EPS = 1e-9;
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/**
 * Where a drag goes: up to 5 squares off, or now and then for a rider on a
 * cart, on the cart or just past it, so a walk may leave it and come back
 * over it, and now and then off the squares, where a creature that
 * squeezes drops squeezed (drop.ts squeezedSpot).
 */
function target(r: () => number, c: Case): Point {
  const mover = c.state.tokens[c.mover]!;
  const wagon = c.state.tokens.cart;
  if (c.aim && chance(r, 0.8)) return c.aim;
  if (c.layout === "cart" && wagon && chance(r, 0.6)) {
    const off = chance(r, 0.4) ? 0.2 : 0;
    return { x: Math.min(28, wagon.x + int(r, -1, 6) + off), y: Math.min(28, wagon.y + (chance(r, 0.5) ? int(r, 1, 5) : int(r, 4, 12)) + off) };
  }
  return { x: Math.max(0, Math.min(28, mover.x + int(r, -5, 5))), y: Math.max(0, Math.min(28, mover.y + int(r, -5, 5))) };
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
    let farRoutes = 0;
    let held = 0;
    let reentered = 0;
    let squeezed = 0;
    const walked = { plateau: 0, cart: 0 };
    // Past the first 400, a rider on a cart with the walls that send her off it and back over it (review AT-ASTRA-16), then a Large or Huge one with a gap to squeeze through (review AT-ASTRA-19).
    for (let seed = 1; seed <= 550; seed++) {
      const r = rng(seed);
      const c = randomCase(r, seed > 475 ? "gap" : seed > 400 ? "cart" : undefined);
      const mover = c.state.tokens[c.mover]!;
      const raw = target(r, c);
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
      if (c.who.role === "player" && blocks && op.t === "token.move") {
        const landing = op.elevation ?? mover.elevation;
        const points = route ? routePoints(c.state.buildChunks, walkerFor(c.state, mover, seenAll(c.state)), route, landing) : [{ x: mover.x, y: mover.y, elevation: mover.elevation }, { x: op.x, y: op.y, elevation: landing }];
        assert.equal(walkFault(c, c.mover, points), null, `${where}: ${JSON.stringify(op)}`);
        if (c.layout === "plateau" || c.layout === "cart") walked[c.layout]++;
      }
      const found = drag.answer.kind === "route" ? drag.answer.route.pieces : null;
      if (blocks && found && found.length <= MAX_ROUTE_PIECES) {
        // The search finds only routes the check takes (review AT-ASTRA-16), judged on the mover's copy as the drop judges it, and the drop takes it unless it reaches too far.
        const view = dropView(copy, c.who.role);
        const end = found[found.length - 1]!;
        const at = { x: end[0], y: end[1] };
        const walking = walkerOf(view, view.tokens[c.mover]!);
        const landing = dropLanding(view, view.tokens[c.mover]!, at);
        assert.equal(routeStop(view, walking, found, landing), null, `${where}: the search found a route the check refuses, ${JSON.stringify(found)}`);
        if (c.who.role === "player") assert.equal(walkFault(c, c.mover, routePoints(c.state.buildChunks, walkerFor(c.state, mover, seenAll(c.state)), found, landing), () => reentered++), null, `${where}: the search found ${JSON.stringify(found)}`);
        if (!drag.plan.stop && !sameRoute(route, found)) {
          assert.ok(routeReach(routePoints(view.buildChunks, walking, found, landing), view.meta.settings.feetPerCell) > MAX_ROUTE_REACH, `${where}: the drop left a route the check takes, ${JSON.stringify(found)} for ${JSON.stringify(op)}`);
          farRoutes++;
        }
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
      if (mover.attached && after.squeeze) squeezed++;
    }
    // A run that never walks off a mount, along a route, held at a wall, back over a cart or squeezed off one tests nothing.
    assert.ok(moved > 200 && routed > 30 && off > 60 && held > 10 && reentered > 10 && squeezed > 20 && walked.plateau > 20 && walked.cart > 20, JSON.stringify({ moved, routed, off, held, reentered, squeezed, farRoutes, walked }));
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
      const raw = target(r, c);
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
      if (c.who.role === "player" && c.state.scenes[mover.sceneId]!.blockMovement === true) {
        for (const m of moves) {
          const from = c.state.tokens[m.tokenId]!;
          const points = [{ x: from.x, y: from.y, elevation: from.elevation }, { x: m.x, y: m.y, elevation: m.elevation ?? from.elevation }];
          assert.equal(walkFault(c, m.tokenId, points), null, `${where}: ${JSON.stringify(m)}`);
        }
      }
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

describe("a walking ruler reads each leg as the drag it stands for (reviews AT-ASTRA-25 and AT-SOL-5)", () => {
  test("random rulers of two and three legs, the DM's own on the room and a player's on their copy: each leg reads what the drag to its stop read, made from where the drags before it left the token, and a shared one reads the same on every copy", () => {
    let rulers = 0;
    let legs = 0;
    let offHolder = 0;
    let fogged = 0;
    let shared = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const drawn = randomCase(r, seed > 250 ? "cart" : undefined);
      // A ruler walks one creature and has no turn (docs/design-v1-movement.md 3.3): it leaves out the creatures a drag takes
      // along, other creatures' spaces and a dismount's half Speed. So here no one is dragged, every creature is an ally, whose
      // space costs a drag nothing, and every rider is carried, so no drag reads what a ruler leaves out.
      const tokens = Object.fromEntries(
        Object.values(drawn.state.tokens)
          .filter((t) => t!.attached?.kind !== "drag")
          .map((t) => [t!.id, { ...t!, disposition: "ally" as const, ...(t!.attached?.kind === "ride" ? { attached: { to: t!.attached.to, kind: "carry" as const } } : {}) }]),
      );
      // Every other ruler is the DM's, often of a creature outside the party, which players see only where the fog is lifted.
      const who = seed % 2 === 0 ? DM : drawn.who;
      if (who.role === "dm" && chance(r, 0.6)) tokens[drawn.mover] = { ...tokens[drawn.mover]!, kind: "npc", ownerIds: [] };
      const c: Case = { ...drawn, who, state: { ...drawn.state, tokens, scenes: { ...drawn.state.scenes }, fogTiles: { ...drawn.state.fogTiles } } };
      // Now and then fog, lifted only over a patch about the start, or over part of a cart, so later legs walk into it and out
      // of it, on the cart and off it, and a passenger the fog hides walks off as a token with no holder.
      const fog = chance(r, 0.5);
      if (fog) {
        const start = c.state.tokens[c.mover]!;
        const wagon = c.state.tokens.cart;
        c.state.scenes.s1 = { ...c.state.scenes.s1!, fogEnabled: true };
        const patch = wagon && chance(r, 0.7) ? { x: wagon.x + int(r, 0, 2), y: wagon.y + int(r, 0, 2), w: int(r, 1, 3), h: int(r, 1, 3) } : { x: Math.max(0, start.x - int(r, 0, 3)), y: Math.max(0, start.y - int(r, 0, 3)), w: int(r, 2, 6), h: int(r, 2, 6) };
        reveal(c.state, "s1", patch);
      }
      const dm = c.who.role === "dm";
      // Drags on squares only: a ruler's stop is a square's center, never a squeezed spot.
      const onSquares: Case = { ...c, aim: undefined };
      let room = c.state;
      const stops: RulerStop[] = [tokenStop(room.tokens[c.mover]!)];
      const read: number[] = [];
      for (let i = int(r, 2, 3); i > 0; i--) {
        const drag = dragOf(dm ? room : copyFor(room, c.who), c.who.role, c.mover, target(r, { ...onSquares, state: room }));
        if (!drag.op || drag.plan.stop) break;
        const applied = applyOp(room, drag.op as Op, c.who, env(10 + legs + read.length));
        if (!applied.ok) break;
        const landed = applied.state.tokens[c.mover]!;
        if (landed.squeeze) break;
        const { x, y } = tokenStop(landed);
        stops.push({ x, y });
        read.push(drag.preview.read.dragFt);
        if (room.tokens[c.mover]!.attached && !landed.attached) offHolder++;
        room = applied.state;
      }
      if (read.length < 2) continue;
      // The DM's drag of a party member keeps to ground players have seen, as a shared ruler does (walkWorld.ts publicWorld), and only
      // the DM's other drags read the DM's own map, as the DM's own ruler does.
      const everything = dm && !isPartyMember(c.state, c.state.tokens[c.mover]!);
      const ruler = measureWalk({ view: dm ? c.state : copyFor(c.state, c.who), sceneId: "s1", stops, viewer: { role: c.who.role }, everything });
      assert.deepEqual(ruler?.legs.map((leg) => leg.ft), read, `seed ${seed} (${c.who.memberId}'s ruler for ${c.mover} through ${JSON.stringify(stops.slice(1))})`);
      rulers++;
      legs += read.length;
      if (fog) fogged++;
      // Shared, the DM's ruler reads on the DM's room what it reads on a player's copy that shows the creature where it starts (review AT-SOL-5).
      const copy = copyFor(c.state, P1);
      if (!dm || !copy.tokens[c.mover]) continue;
      const theirs = measureWalk({ view: copy, sceneId: "s1", stops, viewer: { role: "player" }, everything: false });
      const ours = measureWalk({ view: c.state, sceneId: "s1", stops, viewer: { role: "dm" }, everything: false });
      assert.deepEqual(theirs?.legs.map((leg) => leg.ft), ours?.legs.map((leg) => leg.ft), `seed ${seed} (the shared ruler for ${c.mover} through ${JSON.stringify(stops.slice(1))})`);
      shared++;
    }
    assert.ok(rulers > 150 && offHolder > 40 && fogged > 60 && shared > 60, JSON.stringify({ rulers, legs, offHolder, fogged, shared }));
  });
});

describe("the server takes a walk that comes back over a cart only when no piece after it cleared the cart crosses a ledge (review AT-ASTRA-16)", () => {
  test("random routes off a cart round its walls and back over it, then on, as any client might send them", () => {
    let taken = 0;
    let refused = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const c = randomCase(r, "cart");
      if (c.state.scenes.s1!.blockMovement !== true) continue;
      const bree = c.state.tokens.bree!;
      const wagon = c.state.tokens.cart!;
      // Off the cart past the end of the wall under its first row, down past that wall, back onto the cart's low half, then anywhere near.
      const west = bree.x < wagon.x + 2;
      const out = west ? wagon.x - 2 : wagon.x + 5;
      const back = west ? wagon.x + int(r, 0, 1) : wagon.x + int(r, 2, 3);
      const row = wagon.y + int(r, 2, 3);
      const end = { x: Math.max(0, Math.min(28, wagon.x + int(r, -2, 6))), y: Math.max(0, Math.min(28, wagon.y + int(r, 1, 5))) };
      const route: [number, number, number, 0 | 1][] = [
        [out, bree.y, 0, 0],
        [out, row, 0, 0],
        [back, row, 0, 0],
      ];
      if (end.x !== back || end.y !== row) route.push([end.x, end.y, 0, 0]);
      const elevation = footprintGround(c.state.buildChunks, { ...bree, x: end.x, y: end.y, squeeze: undefined });
      const op: Op = { t: "token.move", tokenId: "bree", x: end.x, y: end.y, elevation, route };
      const answer = canApply(op, P1, c.state, { canUseAsset: () => true });
      const where = `seed ${seed}: ${JSON.stringify(op)}`;
      if (!answer.ok) {
        if (answer.message === LEDGE_IN_THE_WAY) refused++;
        continue;
      }
      assert.equal(walkFault(c, "bree", routePoints(c.state.buildChunks, walkerFor(c.state, bree, seenAll(c.state)), route, elevation)), null, where);
      taken++;
    }
    assert.ok(taken > 30 && refused > 30, JSON.stringify({ taken, refused }));
  });
});
