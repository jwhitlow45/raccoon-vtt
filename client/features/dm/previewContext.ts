import { createContext, useContext } from "react";

/**
 * "Viewing as Pat" as the previewed page sees it: its height, in window
 * pixels, and how the page tells it where to go (`place`), centered left
 * of the lane the token bar and the alerts column share, or null for its
 * own place, spanning under the top bar (docs/design-v1-bar-dock.md 1.3).
 * The notice stays in PlayerPreview, outside the previewed page, so a
 * blackout and the ended screen keep its Exit.
 */
export type PreviewNotice = {
  height: number;
  place(box: { left: number; width: number } | null): void;
  /**
   * A place inside the previewed page's very short sheet while it shows,
   * or null (docs/design-v1-layout-hierarchy.md 4.2). That sheet is modal
   * over the preview, so the notice renders first in it, above the
   * sheet's content, and its Exit stays one tap away.
   */
  slot(el: HTMLElement | null): void;
};

/**
 * Set while the Room page draws a "view as a player" preview. Room actions
 * are already refused inside it, but a few controls reach past the room,
 * such as leaving the room or the DM's HTTP tools, and they check this to
 * stay out of the preview.
 */
export const PreviewContext = createContext<{ memberId: string; name: string; notice?: PreviewNotice } | null>(null);

export function usePreview(): { memberId: string; name: string; notice?: PreviewNotice } | null {
  return useContext(PreviewContext);
}
