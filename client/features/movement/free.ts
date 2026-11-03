import type { ClientOp, EphEvent } from "#shared/protocol.ts";
import { footprintSize, isSqueezed } from "#shared/rules/footprint.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";
import { drawnSpot, freeDrawnAt } from "#shared/rules/nudge.ts";
import { drawnAt, snapPosition } from "../../lib/scene.ts";
import type { DropPlan, DropToken, Landed, Point } from "./drop.ts";

/*
 * Snap off for a drag (docs/design/design-v1-snap-off.md 6.4): what a drop
 * adds to its plan so a token stays drawn where it was let go, or keeps the
 * placement it had. The plan itself is built as every drop's is, and the
 * rules read only it. The reducer keeps a placement only where a move lands
 * where it was aimed (shared/rules/nudge.ts), so every `drawnAt` here is
 * absolute and a rewritten landing drops it there.
 */

/** The words the drag label and the screen reader say (design section 4). */
export const PLACING_FREELY = "Placing freely";
export const HEX_KEEPS = "Hex scenes keep creatures on a hex.";
export const GROUP_KEEPS = "A group keeps to the grid.";
export const PLACED_TEXT = "Placed between squares.";

/**
 * Where a token landing at `landing` is drawn for a release at `release`:
 * the shared rounding and clamp of rules/nudge.ts, so the client aims at
 * exactly the point the reducer will keep. Null where that is the landing
 * itself, so nothing is drawn off the grid.
 */
export function placement(token: DropToken, landing: Point, release: Point): Point | null {
  const at = freeDrawnAt({ ...token, x: landing.x, y: landing.y }, release);
  return at.x === landing.x && at.y === landing.y ? null : at;
}

/**
 * A move that keeps its token's placement: `drawnAt` its landing plus its
 * nudge, which the reducer keeps where the move lands as aimed. A squeezed
 * landing or a hex scene keeps none, as the pass would drop it.
 */
function keeping(grid: Grid, move: Landed, token: DropToken | undefined): Landed {
  const nudge = token?.nudge;
  if (!nudge || move.squeeze || isHex(grid)) return move;
  return { ...move, drawnAt: drawnSpot(grid, { x: move.x, y: move.y, nudge }) };
}

/**
 * Every move of a plan keeping its token's placement: a group's members, a
 * group plan's one survivor sent as `token.move`, an arrow step, and a mount
 * moved by a drag pressed on its rider (6.4, 6.5).
 */
export function keepPlacements(grid: Grid, plan: DropPlan, tokens: readonly DropToken[]): DropPlan {
  if (!plan.moves.some((m) => tokens.some((t) => t.id === m.tokenId && t.nudge))) return plan;
  return { ...plan, moves: plan.moves.map((m) => keeping(grid, m, tokens.find((t) => t.id === m.tokenId))) };
}

/**
 * A drag frame of a token drawn at `at`, which carries the drawn point
 * (5.6). A free one says so, since a receiver reads a free drag's point as
 * the box under it and an ordinary one's less the nudge, as this device's
 * own drag reads it (lib/scene.ts dragAim, framedToken).
 */
export function moveFrame(tokenId: string, at: Point, free: boolean, fields: Omit<MoveFrame, "k" | "tokenId" | "x" | "y" | "free">): MoveFrame {
  return { k: "dragMove", tokenId, x: at.x, y: at.y, ...fields, ...(free ? { free: true as const } : {}) };
}

type MoveFrame = Extract<EphEvent, { k: "dragMove" }>;

/** The part of a dragged node the drop reads and moves. */
export type NodeAt = { x(): number; y(): number; position(p: Point): void };

/**
 * The lead's node while the finger drags another token of its group, as a
 * rider's drag moves its mount: the pressed node at the same offset, between
 * where each is drawn. Each node sits where its own token is drawn, its own
 * nudge off its stored spot, so reads and writes both go through the drawn
 * spots (6.3), and a held preview or a cancel puts each where it belongs.
 */
export function leadNode(node: NodeAt, pressed: DropToken, lead: DropToken): NodeAt {
  const from = drawnAt(null, pressed);
  const to = drawnAt(null, lead);
  return {
    x: () => node.x() - from.x + to.x,
    y: () => node.y() - from.y + to.y,
    position: (p) => node.position({ x: p.x - to.x + from.x, y: p.y - to.y + from.y }),
  };
}

export type FreeInput = {
  grid: Grid;
  /** The drag's lead, as the room has it, with its nudge. */
  lead: DropToken;
  /** The token the drag was pressed on: the lead, or a rider whose drag moves it. */
  pressedId: string;
  /** Every token the drop names, the lead first. */
  named: readonly DropToken[];
  plan: DropPlan;
  /** Where the lead's node was let go: its drawn top-left, in cells. */
  release: Point;
  /** Alt held at the drop, or the token bar's Place freely on. A group drag is never free. */
  free: boolean;
  /** The viewer may change where the lead is drawn in place: the DM, or an owner who may move it (5.4). */
  inPlace: boolean;
};

/** The plan to send, the in-place update to send with it, and whether either places the lead between squares. */
export type FreeDrop = { plan: DropPlan; place: ClientOp | null; placed: boolean };

/**
 * What a drop sends for snap off (6.4). A free lone drop that lands on the
 * box under the release draws the token where it was let go. One let go on
 * its own box sends a `token.update` of `drawnAt` instead, for the DM or an
 * owner, as nothing moves. An ordinary drop of a placed token on its own box
 * puts it back on the grid, but only past 1/8 square from where it is
 * drawn, so a finger's jitter never undoes a careful placement. An ordinary
 * lone drop to another box sends no `drawnAt`, so the placement goes. Group
 * drags, and a mount moved by its rider's drag, keep each placement.
 */
export function freeDrop(input: FreeInput): FreeDrop {
  const { grid, lead, plan, release } = input;
  const plain: FreeDrop = { plan, place: null, placed: false };
  if (isHex(grid)) return plain;
  if (input.named.length > 1 || input.pressedId !== lead.id) return { plan: keepPlacements(grid, plan, input.named), place: null, placed: false };
  const move = plan.moves.find((m) => m.tokenId === lead.id);
  const under = snapPosition(grid, release.x, release.y, footprintSize(lead));
  if (input.free) {
    if (move) {
      const at = move.x === under.x && move.y === under.y && !move.squeeze ? placement(lead, move, release) : null;
      if (at) return { plan: { ...plan, moves: plan.moves.map((m) => (m === move ? { ...m, drawnAt: at } : m)) }, place: null, placed: true };
      return { plan: noted(lead, plan, release), place: null, placed: false };
    }
    if (plan.stop) return { plan: noted(lead, plan, release), place: null, placed: false };
    if (under.x !== lead.x || under.y !== lead.y || !input.inPlace || isSqueezed(lead)) return plain;
    const at = placement(lead, lead, release);
    const now = drawnAt(grid, lead);
    if ((at ?? lead).x === now.x && (at ?? lead).y === now.y) return plain;
    return { plan, place: { t: "token.update", tokenId: lead.id, patch: { drawnAt: at } }, placed: at !== null };
  }
  if (move || plan.stop || !lead.nudge || !input.inPlace) return plain;
  const now = drawnAt(grid, lead);
  if (Math.abs(release.x - now.x) < 1 / 8 && Math.abs(release.y - now.y) < 1 / 8) return plain;
  return { plan, place: { t: "token.update", tokenId: lead.id, patch: { drawnAt: null } }, placed: false };
}

/** A free drop held short of its box: its note keeps where it was let go, so "Teleport here" lands it placed (teleport.ts). */
function noted(lead: DropToken, plan: DropPlan, release: Point): DropPlan {
  if (!plan.stop) return plan;
  const at = placement(lead, plan.stop.ghost, release);
  return at ? { ...plan, stop: { ...plan.stop, drawnAt: at } } : plan;
}
