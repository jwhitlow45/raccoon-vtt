import { useSelectionWatch } from "./store.ts";
import { useAreaReminders } from "./useAreaReminders.ts";

/**
 * What areas do besides drawing (TemplateLayer.tsx), as one of the board's
 * controllers (features/layers.ts CONTROLLERS), mounted once outside both
 * drawing trees, so each reminder toasts once whichever view shows
 * (docs/design-v1-isometric-view.md 5.1): the reminders that an area hits a
 * creature again (useAreaReminders.ts), and the count of the room's
 * selection changes for the area tool's From control (store.ts
 * useSelectionWatch), since the board is always on screen in a room.
 */
export function AreaController(): null {
  useAreaReminders();
  useSelectionWatch();
  return null;
}
