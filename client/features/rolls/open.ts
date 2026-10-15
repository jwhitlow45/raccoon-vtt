import { createStore } from "zustand/vanilla";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import type { AskFrom } from "./logic.ts";

/**
 * Where "Request a roll" opens the DM's sheet from: the party bar's "Ask
 * the party", or a token's action bar with its selection. The sheet itself
 * lives with the DM's roll cards in the fight alerts column, which is
 * always mounted, so any entry point only names its targets here. Per Room
 * page (client/state/scope.ts).
 */
export const askSlot = scopeSlot(() => createStore<{ asking: AskFrom | null }>(() => ({ asking: null })));

export function openAsk(scope: RoomScope, from: AskFrom): void {
  scope.get(askSlot).setState({ asking: from });
}

export function closeAsk(scope: RoomScope): void {
  scope.get(askSlot).setState({ asking: null });
}
