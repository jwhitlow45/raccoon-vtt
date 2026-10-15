import { createStore } from "zustand/vanilla";
import { scopeSlot } from "../../state/scope.ts";

export type PinToolState = {
  /** The pin whose pane is open. */
  paneId: string | null;
  /** "Pin to the map" from a journal page waits for a tap on the map. */
  placing: { pageId: string; title: string } | null;
  /** A pin being dragged with the Pin tool, drawn here until the move lands. */
  drag: { id: string; x: number; y: number } | null;
  /** A new pin's color: null for the DM's own member color. */
  color: string | null;
  /**
   * Whether a pin placed with the tool starts DM only. On by default, so a
   * pin reaches players only once the DM says so. A pin from "Pin to the
   * map" starts visible instead, since its page already decides who sees it.
   */
  dmOnly: boolean;
  /** A label-only pin tapped with the Select tool, shown in a small popover. */
  popover: { id: string; at: number } | null;
};

/** One Room page's pin tool, pane and popover (state/scope.ts), so "view as a player" keeps its own. */
export const pinSlot = scopeSlot(() => ({
  store: createStore<PinToolState>(() => ({ paneId: null, placing: null, drag: null, color: null, dmOnly: true, popover: null })),
  /** The pointer gesture in progress with the Pin tool. */
  gesture: null as { start: { x: number; y: number }; hit: string | null; grab: { dx: number; dy: number } | null; moved: boolean } | null,
}));
