import { scopeSlot } from "../state/scope.ts";

/**
 * The map's focus target, which Room draws over the map: it takes focus
 * from script only, never by Tab or a tap, for when the control that had
 * focus goes away and nothing near it is left to take it, such as the
 * DM's last roll card closing (features/rolls/DmDesk.tsx). Focus that fell
 * to the page left a screen reader nowhere and sent the next Tab back to
 * the page's start. On the map, the next Tab goes on to the top bar.
 *
 * Per Room page (state/scope.ts), since "view as a player" draws a second
 * map of its own.
 */
export const mapFocusSlot = scopeSlot(() => ({ el: null as HTMLElement | null }));

/**
 * Whether Space may hold the map for a drag (canvas/Stage.tsx): while
 * nothing has focus, or the map itself does. The map's focus target takes
 * no key press of its own, and focus lands there once the last roll card
 * closes, where Space stopped panning the map that had focus.
 */
export function spaceMovesMap(active: Element | null, body: Element | null, map: Element | null): boolean {
  return active === null || active === body || (map !== null && active === map);
}

/** Focuses the map. Returns whether focus landed there. */
export function focusMap(slot: { el: HTMLElement | null }): boolean {
  const el = slot.el;
  if (!el?.isConnected) return false;
  el.focus({ preventScroll: true });
  return el.ownerDocument.activeElement === el;
}
