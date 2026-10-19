import type { ClientOp } from "#shared/protocol.ts";
import { MAX_MOVES } from "#shared/protocol.ts";
import { footprint, snapPosition } from "./scene.ts";

/**
 * Moving several selected tokens as one (features section 5), as plain
 * functions for node --test. The canvas drags the token under the finger,
 * and the rest of the group follow by the same offset. On the drop each one
 * snaps to the grid by its own footprint, so a Tiny token keeps its half
 * cells beside a Medium one, and the whole move goes out as one
 * `token.moveMany`: one op, one undo step.
 */

type Placed = { id: string; x: number; y: number; size: Parameters<typeof footprint>[0]["size"]; w?: number; h?: number };
export type Move = { tokenId: string; x: number; y: number };

/**
 * The other tokens that move with the one being dragged: the rest of the
 * selection that is on this scene and that this member may move. The lead
 * moves the group only when it is part of the selection itself.
 *
 * With `holderOf`, the links of this viewer's copy (docs/design-v1-attach.md
 * 4.2): a token whose holder, or any holder above it, moves too is left
 * out, since it goes with that holder, so a rider and its mount both
 * selected move once, as the mount's group. `alsoMoving` names what moves
 * besides the lead and the selection, such as the mount a rider's drag
 * moves.
 */
export function groupFollowers<T extends { id: string }>(
  selectedIds: readonly string[],
  leadId: string,
  onScene: ReadonlyMap<string, T>,
  canMove: (token: T) => boolean,
  holderOf?: (token: T) => T | undefined,
  alsoMoving: readonly string[] = [],
): T[] {
  if (!selectedIds.includes(leadId)) return [];
  const out: T[] = [];
  for (const id of selectedIds) {
    const t = onScene.get(id);
    if (id !== leadId && !alsoMoving.includes(id) && t && canMove(t)) out.push(t);
  }
  if (!holderOf) return out;
  const moving = new Set([leadId, ...alsoMoving, ...out.map((t) => t.id)]);
  const ridesOnMoving = (t: T): boolean => {
    const seen = new Set<string>([t.id]);
    for (let up = holderOf(t); up && !seen.has(up.id); up = holderOf(up)) {
      if (moving.has(up.id)) return true;
      seen.add(up.id);
    }
    return false;
  };
  return out.filter((t) => !ridesOnMoving(t));
}

/** Where each token lands after the group moved by (dx, dy), snapped by its own footprint. Tokens that end where they began are left out. */
export function groupDrop(tokens: readonly Placed[], dx: number, dy: number): Move[] {
  const moves: Move[] = [];
  for (const t of tokens) {
    const at = snapPosition(t.x + dx, t.y + dy, footprint(t));
    if (at.x !== t.x || at.y !== t.y) moves.push({ tokenId: t.id, x: at.x, y: at.y });
  }
  return moves;
}

/** The ops for a set of moves: one `token.move` for a single token, else `token.moveMany` in batches the protocol takes. */
export function moveOps(moves: readonly Move[]): ClientOp[] {
  if (moves.length === 0) return [];
  if (moves.length === 1) return [{ t: "token.move", ...moves[0]! }];
  const ops: ClientOp[] = [];
  for (let i = 0; i < moves.length; i += MAX_MOVES) ops.push({ t: "token.moveMany", moves: moves.slice(i, i + MAX_MOVES) });
  return ops;
}

/** The tokens whose footprints overlap a box dragged on the map, in world cells. */
export function tokensInBox<T extends Placed>(tokens: Iterable<T>, a: { x: number; y: number }, b: { x: number; y: number }): T[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const out: T[] = [];
  for (const t of tokens) {
    const fp = footprint(t);
    if (t.x < x1 && t.x + fp.w > x0 && t.y < y1 && t.y + fp.h > y0) out.push(t);
  }
  return out;
}
