import { createStore } from "zustand/vanilla";
import { scopeSlot } from "./scope.ts";

/**
 * Where this device's own token drags would land right now, by token, in
 * cells. Konva moves a dragged token itself and the room store hears of it
 * only on the drop, so the canvas (Stage.tsx) writes the cell under each
 * dragged token here, and what follows a token, such as an aura attached to
 * it and the "In area" lists, reads it. It changes only when a token
 * crosses into another cell, never on every pointer frame.
 */
export type LocalDrags = { spots: Readonly<Record<string, { x: number; y: number }>> };

export const localDragSlot = scopeSlot(() => createStore<LocalDrags>(() => ({ spots: {} })));
