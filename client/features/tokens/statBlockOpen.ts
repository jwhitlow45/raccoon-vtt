import { createStore } from "zustand/vanilla";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";

/**
 * A tracker row's "Stat block" (docs/design-v1-dm-tools.md 3.6) opens the
 * token's panel at its stat block: the row names the token here, and the
 * token panel's stat block section, once it shows that token, unfolds,
 * scrolls itself into view and clears the request. Per Room page, so a
 * row in "view as a player" never reaches the DM's own panel.
 */
export const statBlockRequest = scopeSlot(() => createStore<{ tokenId: string | null }>(() => ({ tokenId: null })));

export function requestStatBlock(scope: RoomScope, tokenId: string): void {
  scope.get(statBlockRequest).setState({ tokenId });
}
