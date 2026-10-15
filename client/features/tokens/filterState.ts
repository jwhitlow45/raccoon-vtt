import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { NO_FILTERS, readStoredFilters, storeFilters, type MonsterFilters } from "./monsterFilters.ts";

/**
 * The DM's monster filters on this device, remembered per room in
 * localStorage as the auto initiative choice is. One store per Room page,
 * so the monster browser and the encounter builder show the same filters
 * and a change in one shows in the other at once. Reading and writing
 * storage, blocked storage included, is in monsterFilters.ts, where the
 * tests reach it.
 */

type FilterState = {
  /** The room the filters below were read for, or null before the first read. */
  roomId: string | null;
  filters: MonsterFilters;
};

const filterSlot = scopeSlot(() => createStore<FilterState>(() => ({ roomId: null, filters: NO_FILTERS })));

const browserStorage = () => localStorage;

export function useMonsterFilters(): { filters: MonsterFilters; setFilters(next: MonsterFilters): void } {
  const store = useScoped(filterSlot);
  const roomId = useRoomView((s) => s.roomId);
  const state = useStore(store);
  // Reads storage once per room, and meanwhile answers from it directly so the first frame already shows the remembered filters.
  const filters = state.roomId === roomId ? state.filters : readStoredFilters(browserStorage, roomId);
  useEffect(() => {
    if (store.getState().roomId !== roomId) store.setState({ roomId, filters: readStoredFilters(browserStorage, roomId) });
  }, [store, roomId]);
  const setFilters = useCallback(
    (next: MonsterFilters) => {
      store.setState({ roomId, filters: next });
      storeFilters(browserStorage, roomId, next);
    },
    [store, roomId],
  );
  return { filters, setFilters };
}
