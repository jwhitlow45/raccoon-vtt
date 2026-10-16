import { createStore, type StoreApi } from "zustand/vanilla";
import { FIRST_LAST_TOOL, lastToolAfter, tuckAfter, type TuckEvent } from "../pages/optionsLayout.ts";
import { scopeSlot, type RoomScope } from "./scope.ts";

/**
 * The toolbar's own state for one Room page (docs/design-v1-tool-options.md
 * 5.2, 5.4): the last tool other than Select that this page made active,
 * which the pair's second button shows, and the tool whose options are
 * tucked. Never stored: a reload starts at the Ruler, untucked. Per page,
 * as the active tool is, since "view as a player" draws a second room.
 * The rules are pages/optionsLayout.ts's.
 */
export type ToolbarState = { last: string; tucked: string | null };

export const toolbarSlot = scopeSlot<StoreApi<ToolbarState>>(() => createStore<ToolbarState>(() => ({ last: FIRST_LAST_TOOL, tucked: null })));

/** A tool became active, by any way: a button, a tile, a key or a panel. It becomes the last tool unless it is Select, and a tuck of another tool ends. */
export function toolChanged(scope: RoomScope, active: string): void {
  const store = scope.get(toolbarSlot);
  const { last, tucked } = store.getState();
  const next = { last: lastToolAfter(last, active), tucked: tuckAfter(tucked, active, { kind: "tool", tool: active }) };
  if (next.last !== last || next.tucked !== tucked) store.setState(next);
}

/** A press on the active tool's own button or tile tucks or shows its options, and its key or the "options hidden" pill shows them. */
export function tuckEvent(scope: RoomScope, active: string, e: TuckEvent): void {
  const store = scope.get(toolbarSlot);
  const tucked = tuckAfter(store.getState().tucked, active, e);
  if (tucked !== store.getState().tucked) store.setState({ tucked });
}
