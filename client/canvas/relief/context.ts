import { createContext, useContext } from "react";
import type { Turn } from "../../lib/view.ts";
import type { FogView } from "./fogView.ts";

/**
 * What a renderer drawing on the isometric view's ground stage needs to
 * know (docs/design-v1-isometric-view.md 5.1): the turn, this viewer's fog
 * for the stand rule, and whether heights stand at this zoom (ISO-D12).
 * Absent (null) in Top-down, so a renderer that reads it draws exactly as
 * it always has there.
 */
export type IsoGround = {
  turn: Turn;
  fog: FogView;
  /** Whether walls, columns and pits stand at this zoom. Below the threshold everything lies flat, as Top-down draws it. */
  heights: boolean;
};

export const IsoGroundContext = createContext<IsoGround | null>(null);

export function useIsoGround(): IsoGround | null {
  return useContext(IsoGroundContext);
}
