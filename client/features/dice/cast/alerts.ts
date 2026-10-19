import { useEffect, useRef, useSyncExternalStore } from "react";
import { uuidv7 } from "#shared/ids.ts";
import { compareLogIds } from "#shared/keys.ts";
import { api } from "../../../lib/api.ts";
import { useScoped } from "../../../state/scope.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import { castReceiptsSlot, castSendsSlot, closedText, readCastDraft, restoreSends, writeCastDraft, type CastEnv } from "./cast.ts";

/*
 * A player's asks for saves outside the Dice panel (docs/design-v1-player-save-spell.md
 * 3.2), kept apart from the panel's own code, since the alerts column that
 * mounts it loads with every room.
 */

/** The asks' receipts, bound to this room's lookup. An ask writes no dice line, so its log is never read for one. */
function useBoundTracker() {
  const tracker = useScoped(castReceiptsSlot);
  const roomId = useRoomView((s) => s.roomId);
  tracker.env ??= { lookup: (tag) => api.getReceipts(roomId, tag), log: () => [] };
  return tracker;
}

/** The asks' receipts for a surface that shows them, drawn again as each settles. */
export function useCastTracker() {
  const tracker = useBoundTracker();
  useSyncExternalStore(tracker.subscribe, tracker.version, tracker.version);
  return tracker;
}

/**
 * A player's asks outside the Dice panel (3.2): a reload's unsettled sends
 * settled by their receipts, once, and a toast when an ask's closing line
 * arrives, the same for an Apply and a close with nothing to apply.
 * Mounted with the alerts column, which every room page keeps.
 */
export function useCastAlerts(): void {
  const player = useRoomView((s) => s.you?.role === "player");
  const roomId = useRoomView((s) => s.roomId);
  const log = useRoomView((s) => s.view?.log);
  const loaded = useRoomView((s) => s.view !== null);
  const store = useScoped(castSendsSlot);
  const tracker = useBoundTracker();
  const room = useRoomStore();
  const ui = useRoomUi();
  const restored = useRef(false);
  const read = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!player || !loaded || restored.current) return;
    restored.current = true;
    const env: CastEnv = {
      store,
      tracker,
      connected: () => room.getState().connection === "open",
      dispatch: () => null,
      rollDamage: () => null,
      newId: uuidv7,
      view: () => room.getState().view,
      save: (sends) => writeCastDraft(roomId, sends),
      notify: (text) => ui.notify(text, "info"),
    };
    restoreSends(env, readCastDraft(roomId));
  }, [player, loaded, roomId, store, tracker, room, ui]);
  useEffect(() => {
    if (!player || !log) return;
    const latest = log.at(-1)?.id ?? null;
    if (read.current === undefined) {
      // The first snapshot's lines are history, not news.
      read.current = latest;
      return;
    }
    const since = read.current;
    read.current = latest;
    const fresh = since === null ? log : log.filter((e) => compareLogIds(e.id, since) > 0);
    for (const entry of fresh) {
      const text = entry.data?.type === "cast" ? closedText(entry.data) : null;
      if (text) ui.notify(text, "info");
    }
  }, [player, log, ui]);
}
