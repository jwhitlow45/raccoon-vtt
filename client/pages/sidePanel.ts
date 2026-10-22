import { SHORT_LANDSCAPE_MAX } from "../features/encounter/band.ts";

/*
 * Whether the side panel shows from 900 px up (docs/design-v1-layout-hierarchy.md
 * 4.1), as this device remembers it: "hidden" or "shown", one value for every
 * room and both roles. Hide panels, Panels and the S key write it. Opening a
 * panel from anywhere shows a hidden side panel and leaves the stored choice
 * alone, so a reload brings back what the viewer chose.
 */

export const SIDE_PANEL_KEY = "rvtt.sidePanel";

export type SidePanelChoice = "hidden" | "shown";

/** The stored choice, or null for anything else: no key, or a value this version does not know. */
export function parseSidePanel(raw: string | null): SidePanelChoice | null {
  return raw === "hidden" || raw === "shown" ? raw : null;
}

/** The choice this device stored. Storage can throw (a private window, blocked site data), which reads as no choice. */
export function readSidePanel(storage?: Pick<Storage, "getItem">): SidePanelChoice | null {
  try {
    const from = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return parseSidePanel(from?.getItem(SIDE_PANEL_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * Stores the viewer's choice. A DM's "view as a player" reads the key and
 * never writes it, as it treats the token bar's spot: what the DM tries in
 * the preview stays there.
 */
export function writeSidePanel(choice: SidePanelChoice, options: { preview: boolean; storage?: Pick<Storage, "setItem"> }): void {
  if (options.preview) return;
  try {
    const to = options.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    to?.setItem(SIDE_PANEL_KEY, choice);
  } catch {
    // The choice then lasts as long as the page, which is all a blocked storage allows.
  }
}

/**
 * The side panel's first state on a Room page: null until the layout is
 * first wide, then fixed for the page. A phone's sheet open as the layout
 * turns wide (`sheet`) starts it shown, so the panel it held stays in view
 * beside the map and comes back as a sheet on the turn back, as opening a
 * panel from anywhere shows a hidden side panel. Otherwise the stored
 * choice wins. With none, a short layout (under 500 px tall, a large phone
 * held sideways) starts with it hidden, since the map needs the width
 * there. Worked out once, so a resize or a rotation never hides or shows
 * the panel by itself, and a window dragged shorter keeps its panel.
 */
export function firstSidePanel(decided: boolean | null, input: { wide: boolean; height: number; stored: SidePanelChoice | null; sheet?: boolean }): boolean | null {
  if (decided !== null || !input.wide) return decided;
  if (input.sheet === true) return false;
  return input.stored === "hidden" || (input.stored === null && input.height < SHORT_LANDSCAPE_MAX);
}
