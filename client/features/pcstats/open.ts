import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useRoomScope, type RoomScope } from "../../state/scope.ts";

/**
 * The player character stat block editors open on this page
 * (docs/design-v1-pc-stats.md 7.2), held apart from whatever opened them,
 * as the companion block editors are (monsters/openEditors.ts): a token
 * panel that shows another token, a card that folds, or the character
 * leaving the viewer's view never takes a draft with it. PcStatsHost
 * draws them.
 */

type OpenPcStats = { list: readonly { characterId: string; key: number }[]; next: number };

/** Per page (state/scope.ts): a "view as a player" preview has its own room, and its own editors. */
export const openPcStatsSlot = scopeSlot(() => createStore<OpenPcStats>(() => ({ list: [], next: 1 })));

/** Opens a character's stat block editor over the room, for the DM and the character's players. One per character: a second press leaves the open one. */
export function openPcStats(scope: RoomScope, characterId: string): void {
  const store = scope.get(openPcStatsSlot);
  if (store.getState().list.some((e) => e.characterId === characterId)) return;
  store.setState((s) => ({ list: [...s.list, { characterId, key: s.next }], next: s.next + 1 }));
}

export function closePcStats(store: StoreApi<OpenPcStats>, key: number): void {
  store.setState((s) => ({ list: s.list.filter((e) => e.key !== key) }));
}

/** `openPcStats(characterId)` for a component (docs/design-v1-pc-stats.md 5), with this page's scope. */
export function useOpenPcStats(): (characterId: string) => void {
  const scope = useRoomScope();
  return (characterId) => openPcStats(scope, characterId);
}
