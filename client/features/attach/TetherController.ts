import { useFallReminders } from "./useFallReminders.ts";

/**
 * The DM's falling off reminder (docs/design-v1-attach.md 4.5), as one of
 * the board's controllers (features/layers.ts CONTROLLERS), mounted once
 * outside both drawing trees, so it toasts once whichever view shows
 * (docs/design-v1-isometric-view.md 5.1). The tethers themselves draw in
 * TetherLayer.tsx.
 */
export function TetherController(): null {
  useFallReminders();
  return null;
}
