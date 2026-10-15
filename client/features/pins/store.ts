import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";

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

/**
 * Puts a label-only pin's popover away. A tap anywhere on the map but the
 * pin does, so the popover never floats beside a door's pill or a height
 * reading (canvas/emptyTap.ts, docs/design-v1-heights-readout.md section 2).
 */
export function closePinPopover(scope: RoomScope): void {
  const store = scope.get(pinSlot).store;
  if (store.getState().popover) store.setState({ popover: null });
}

/**
 * A tap that selects a token puts a pin's popover away too: the token is on
 * the map, and its bar now floats there. A token takes its tap itself, so
 * no tap on empty map (canvas/emptyTap.ts) hears it, and this watches the
 * selection instead. Returns the way to stop.
 */
export function closePopoverOnSelect(room: Pick<StoreApi<{ local: { selectedIds: readonly string[] } }>, "subscribe">, scope: RoomScope): () => void {
  return room.subscribe((s, prev) => {
    if (s.local.selectedIds !== prev.local.selectedIds && s.local.selectedIds.length > 0) closePinPopover(scope);
  });
}
