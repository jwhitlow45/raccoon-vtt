import { createStore } from "zustand/vanilla";
import type { Rect } from "../../lib/camera.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";

/**
 * An outline that flashes on the map for a moment (docs/design-v1-dm-tools.md
 * 3.2): what the outliner frames when the item has no selection of its own,
 * a drawing, a door or a window. One at a time, per Room page.
 */
export type Flash = { id: number; sceneId: string; rect: Rect; segment?: { a: { x: number; y: number }; b: { x: number; y: number } } };

/** How long a flash shows. */
export const FLASH_MS = 1_500;

export const flashSlot = scopeSlot(
  () => ({ store: createStore<{ flash: Flash | null }>(() => ({ flash: null })), timer: null as ReturnType<typeof setTimeout> | null, seq: 0 }),
  (slot) => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
  },
);

export function flash(scope: RoomScope, what: Omit<Flash, "id">): void {
  const slot = scope.get(flashSlot);
  if (slot.timer) clearTimeout(slot.timer);
  const id = ++slot.seq;
  slot.store.setState({ flash: { ...what, id } });
  slot.timer = setTimeout(() => {
    slot.timer = null;
    if (slot.store.getState().flash?.id === id) slot.store.setState({ flash: null });
  }, FLASH_MS);
}
