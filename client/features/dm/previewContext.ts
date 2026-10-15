import { createContext, useContext } from "react";

/**
 * Set while the Room page draws a "view as a player" preview. Room actions
 * are already refused inside it, but a few controls reach past the room,
 * such as leaving the room or the DM's HTTP tools, and they check this to
 * stay out of the preview.
 */
export const PreviewContext = createContext<{ memberId: string; name: string } | null>(null);

export function usePreview(): { memberId: string; name: string } | null {
  return useContext(PreviewContext);
}
