import { MAX_DRAG_TOKENS } from "#shared/protocol.ts";
import type { DragMove } from "../state/socket.ts";

/** What a drag of more tokens than one drag may move says, on the dragging device, which sends nothing for it. */
export const DRAG_CAP_TEXT = "Drag at most 100 tokens at once.";

/**
 * Each token a drag moves beside the tokens it names, in the order it
 * moves them: each named token, then every token it carries, each with
 * the named token it goes by (`rootId`).
 */
export function draggedIds(named: readonly string[], carriedBy: (id: string) => readonly string[]): { id: string; rootId: string }[] {
  const out: { id: string; rootId: string }[] = [];
  for (const rootId of named) for (const id of [rootId, ...carriedBy(rootId)]) out.push({ id, rootId });
  return out;
}

/**
 * The note for a drag that moves more tokens than one drag may, or null:
 * the pressed token and every token `draggedIds` lists, each counted once,
 * whether or not this board draws it, so a drag's members never pass what
 * its frames can name.
 */
export function dragCapRefusal(pressedId: string, moved: readonly { id: string }[]): string | null {
  const all = new Set([pressedId]);
  for (const m of moved) all.add(m.id);
  return all.size > MAX_DRAG_TOKENS ? DRAG_CAP_TEXT : null;
}

/** What a token's frame carries besides its point: its route's corners, its cost, and where a walk stops short of the point. */
export type FrameFields = { x?: number; y?: number; path?: number[]; ft?: number; squeeze?: true };

/**
 * One step of a drag for all its tokens (state/socket.ts DragMove), from
 * what each token's own frame would carry: the pressed token's (`own`),
 * and each member's in member order. The pressed token's point is the
 * point every member moves by, so where its own walk stops short, at a
 * wall or a ledge, the members move by that stop. A member that leads the
 * movement (`lead`, as the mount a press on its rider moves) keeps its
 * route and its own stop. Every other member carries only its cost, and
 * `free` stays on the pressed token's frame.
 */
export function groupMove(input: { at: { x: number; y: number }; free: boolean; own: FrameFields; members: readonly FrameFields[]; lead: number }): DragMove {
  const { own } = input;
  const move: DragMove = {
    x: own.x ?? input.at.x,
    y: own.y ?? input.at.y,
    ...(own.path !== undefined ? { path: own.path } : {}),
    ...(own.ft !== undefined ? { ft: own.ft } : {}),
    ...(own.squeeze ? { squeeze: true as const } : {}),
    ...(input.free ? { free: true as const } : {}),
  };
  const fts = input.members.map((m, i) => (i === input.lead || m.ft === undefined ? null : m.ft));
  if (fts.some((ft) => ft !== null)) move.fts = fts;
  const lead = input.members[input.lead];
  if (lead) {
    const fields = {
      ...(lead.x !== undefined ? { x: lead.x } : {}),
      ...(lead.y !== undefined ? { y: lead.y } : {}),
      ...(lead.path !== undefined ? { path: lead.path } : {}),
      ...(lead.ft !== undefined ? { ft: lead.ft } : {}),
      ...(lead.squeeze ? { squeeze: true as const } : {}),
    };
    if (Object.keys(fields).length > 0) move.lead = { i: input.lead, ...fields };
  }
  return move;
}
