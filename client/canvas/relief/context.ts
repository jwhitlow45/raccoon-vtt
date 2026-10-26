import { createContext, useContext, useRef } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Turn } from "../../lib/view.ts";
import { useRoomView, type RoomView } from "../../state/view.ts";
import type { FogView } from "./fogView.ts";

/**
 * What a renderer drawing in the isometric view needs to know
 * (docs/design-v1-isometric-view.md 5.1): the turn, this viewer's fog for
 * the stand rule, whether heights stand at this zoom (ISO-D12), the drawn
 * ground, and which of the board's places it draws in. Absent (null) in
 * Top-down, so a renderer that reads it draws exactly as it always has
 * there.
 */
export type IsoGround = {
  turn: Turn;
  fog: FogView;
  /** Whether walls, columns and pits stand at this zoom. Below the threshold everything lies flat, as Top-down draws it. */
  heights: boolean;
  /** The map labels that stand, by id, split once by the board so the ground's build and the overlay never both draw one, or neither. */
  uprightLabels: ReadonlySet<string>;
  /**
   * Where this part of the board draws (features/layers.ts IsoPlace): on
   * the ground stage or the drag layer, inside the ground plane's turned and
   * squashed groups, in cells, or on the overlay, upright in view space.
   */
  place: "ground" | "moving" | "upright";
  /** The drawn ground under a point in cells, in cells of height (lib/view.ts drawnGround): 0 outside the scene, below the threshold and on ground this viewer has not seen. */
  ground: (x: number, y: number) => number;
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

/** A read of the room that holds its last value while `shown` is false, so the store's changes reach nothing then. */
export function useShownView<T>(shown: boolean, select: (s: RoomView) => T): T {
  const last = useRef<{ value: T } | null>(null);
  const value = useRoomView((s) => (shown || !last.current ? select(s) : last.current.value));
  last.current = { value };
  return value;
}

/**
 * A read of the room held while the part's tree is hidden. A build edit
 * changes the build's chunks, and a part that rebuilds from them would
 * rebuild in the hidden tree too: the build's paths, an area's coverage.
 */
export function useTreeShownView<T>(select: (s: RoomView) => T): T {
  return useShownView(useTreeShown(), select);
}

/**
 * A read of one of the room's other stores (a scoped slot's), held while
 * the part's tree is hidden, as useTreeShownView holds the room's: the
 * frame clock, a drag's spots, a tool's state.
 */
export function useTreeShownStore<S, T>(store: StoreApi<S>, select: (s: S) => T): T {
  const shown = useTreeShown();
  const last = useRef<{ value: T } | null>(null);
  const value = useStore(store, (s) => (shown || !last.current ? select(s) : last.current.value));
  last.current = { value };
  return value;
}
