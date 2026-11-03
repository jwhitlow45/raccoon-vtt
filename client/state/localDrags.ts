import { createStore } from "zustand/vanilla";
import { scopeSlot } from "./scope.ts";

/**
 * Where a drag would land a token, in rules coordinates. A lone drag's lead
 * lands where its plan does, which may squeeze it into a narrow space half
 * a cell off the grid, so its spot says whether it squeezes there
 * (`squeeze`, true or false). The other tokens of a drag land at the cell
 * under them, and theirs leaves `squeeze` out: the token keeps its own.
 */
export type DragSpot = { x: number; y: number; squeeze?: boolean };

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
