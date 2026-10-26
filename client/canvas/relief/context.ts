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
  /** The map labels that stand, by id, split once by the board so the ground's build and the overlay never both draw one, or neither. */
  uprightLabels: ReadonlySet<string>;
};

export const IsoGroundContext = createContext<IsoGround | null>(null);

export function useIsoGround(): IsoGround | null {
  return useContext(IsoGroundContext);
}

/**
 * Whether the drawing tree a part sits in shows. Both trees stay mounted
 * once Isometric has shown (ISO-D15), and a memo stops only renders from
 * above: a part that reads a store itself, as a ghost reads its eased spot
 * and a shadow its drag's cell, would still work each frame in the hidden
 * tree. Such a part reads nothing while this is false. True outside both
 * trees and wherever no tree says otherwise.
 */
export const TreeShownContext = createContext(true);

export function useTreeShown(): boolean {
  return useContext(TreeShownContext);
}
