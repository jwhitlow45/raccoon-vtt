import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { RoomState, Viewer } from "#shared/model.ts";
import { creatureName } from "#shared/logText.ts";
import { scopeSlot, useScoped, useScopedIfAny } from "../../state/scope.ts";
import { useRoomStore } from "../../state/view.ts";
import { ownsToken } from "../tokens/access.ts";

/** The most of a player's own creatures' names a device keeps, far past what one player plays. */
const KEPT = 200;

export type OwnNames = ReadonlyMap<string, string>;

const NONE: OwnNames = new Map();

/**
 * The names this device last read off a player's own creatures, by token
 * id, so a log line that names one on another scene still names it, as a
 * player's own ask for saves does once the party has moved on
 * (shared/logText.ts creatureName). A player's copy holds the tokens of the
 * scene shown alone, and the line keeps only the token's id. Only the
 * player's own creatures are kept, which they know whatever they see. After
 * a reload such a line reads "A creature" until the device reads the token
 * again, as a fall card's names do (features/traps/desk.ts FallNames).
 * Returns `known` itself when no name changed.
 */
export function keptOwnNames(known: OwnNames, view: Pick<RoomState, "tokens" | "characters" | "members" | "handouts" | "encounter"> | null | undefined, you: Viewer | null | undefined): OwnNames {
  if (!view || you?.role !== "player") return known;
  let out: Map<string, string> | null = null;
  for (const token of Object.values(view.tokens)) {
    if (!token || !ownsToken(view, you.memberId, token)) continue;
    const name = creatureName(view, { tokenId: token.id });
    if (known.get(token.id) === name) continue;
    out ??= new Map(known);
    // Kept newest last, so the oldest goes first past the cap.
    out.delete(token.id);
    out.set(token.id, name);
    if (out.size > KEPT) out.delete(out.keys().next().value!);
  }
  return out ?? known;
}

/** One Room page's kept names (state/scope.ts), so "view as a player" keeps its own. */
export const ownNamesSlot = scopeSlot(() => createStore<{ names: OwnNames }>(() => ({ names: NONE })));

/** Keeps the names as the view changes, whatever panel is open, so the log reads them however late it opens. */
export function useKeepOwnNames(): void {
  const room = useRoomStore();
  const kept = useScoped(ownNamesSlot);
  useEffect(() => {
    const read = (s: ReturnType<typeof room.getState>) => {
      const names = keptOwnNames(kept.getState().names, s.view, s.you);
      if (names !== kept.getState().names) kept.setState({ names });
    };
    read(room.getState());
    return room.subscribe((now, prev) => {
      if (now.view?.tokens !== prev.view?.tokens || now.view?.characters !== prev.view?.characters || now.you !== prev.you) read(now);
    });
  }, [room, kept]);
}

/** Outside a Room, as a panel draws in a unit test, nothing is kept. */
const NO_ROOM = createStore<{ names: OwnNames }>(() => ({ names: NONE }));

/** The kept names, for the log's lines. */
export function useOwnNames(): OwnNames {
  return useStore(useScopedIfAny(ownNamesSlot) ?? NO_ROOM, (s) => s.names);
}
