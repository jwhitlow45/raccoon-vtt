import { createStore } from "zustand/vanilla";
import type { Grid } from "#shared/rules/grid.ts";
import { footprint, snapPosition } from "../lib/scene.ts";
import { scopeSlot } from "./scope.ts";

/**
 * Where a drag would land a token, in rules coordinates. A lone drag's lead
 * lands where its plan does, which may squeeze it into a narrow space half
 * a cell off the grid, so its spot says whether it squeezes there
 * (`squeeze`, true or false). The other tokens of a drag land at the cell
 * under them and name `squeeze` false too (`groupSpot`), since a group move
 * and a carry land every token unsqueezed.
 */
export type DragSpot = { x: number; y: number; squeeze?: boolean };

/**
 * The spot of a token that lands at the cell under it: a member of a group
 * drag or a token carried along. token.moveMany and a carry both drop the
 * squeeze, so a squeezed token's aura and areas must read it unsqueezed
 * mid-drag, as the lone lead's spot does. Leaving `squeeze` out would make
 * them read the stored squeeze the drop will not keep.
 */
export function groupSpot(grid: Grid, token: Parameters<typeof footprint>[0], x: number, y: number): DragSpot & { squeeze: false } {
  return { ...snapPosition(grid, x, y, footprint(token)), squeeze: false };
}

/**
 * Where this device's own token drags would land right now, by token, in
 * cells. Konva moves a dragged token itself and the room store hears of it
 * only on the drop, so the drag writes where each dragged token would land
 * here, and what follows a token, such as an aura attached to it, its rules
 * outline and the "In area" lists, reads it. The canvas (Stage.tsx) writes
 * the cell under each token of a group or carried along, and the drag's
 * stops (movement/stageHooks.ts) the landing of a lone drag's lead, as its
 * line and label show it. It changes only when a token crosses into another
 * cell or its landing changes, never on every pointer frame.
 */
export type LocalDrags = { spots: Readonly<Record<string, DragSpot>> };

export const localDragSlot = scopeSlot(() => createStore<LocalDrags>(() => ({ spots: {} })));
