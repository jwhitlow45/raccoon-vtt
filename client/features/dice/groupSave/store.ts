import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import type { Page } from "./chain.ts";

/**
 * The one group save of this browser tab (docs/design-v1-roll-options.md
 * 5.1 and 5.10): the page, whether it shows, and which panel it shows in.
 * It lives on the DM's device, never in the room's state, and the page
 * keeps its draft in session storage as it changes.
 */
export type GroupSaveState = {
  page: Page | null;
  /** The panel the page is open in, or null while it waits behind the first page's row. */
  shownIn: "dice" | "areas" | null;
  /** The draft was read back after a reload. */
  restored: boolean;
};

export const groupSaveSlot = scopeSlot(() => createStore<GroupSaveState>(() => ({ page: null, shownIn: null, restored: false })));

export function useGroupSaveStore() {
  return useScoped(groupSaveSlot);
}

export function useGroupSave<T>(select: (s: GroupSaveState) => T): T {
  return useStore(useScoped(groupSaveSlot), select);
}
