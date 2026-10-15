/**
 * The browser tab's title (features section 17). Home, the join page and
 * every other page keep the plain app name. A room's tab adds the room's
 * name after a middle dot, so a DM with several rooms open, or a room and
 * Home, can tell the tabs apart.
 */
export const APP_TITLE = "RaccoonVTT";

/** A room's tab title. A name not known yet, or only spaces, leaves the plain title. */
export function roomTitle(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  return trimmed ? `${APP_TITLE} · ${trimmed}` : APP_TITLE;
}
