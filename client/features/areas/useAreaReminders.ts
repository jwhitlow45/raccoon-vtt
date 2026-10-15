import { useEffect, useRef } from "react";
import { useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { useConfirmedSeq } from "../encounter/hooks.ts";
import { creatureName } from "../log/format.ts";
import { areaReminderText, arrivals, remindsYou } from "./reminders.ts";

/**
 * Toasts the reminders that an area hits a creature again, as they arrive
 * (reminders.ts says who gets one). The log keeps every line this viewer
 * may read, toast or not.
 */
export function useAreaReminders(): void {
  const log = useRoomView((s) => s.view?.log);
  const you = useRoomView((s) => s.you);
  const confirmedSeq = useConfirmedSeq();
  const ui = useRoomUi();
  const store = useRoomStore();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!log) return;
    const { seen: next, fresh } = arrivals(seen.current, log, confirmedSeq);
    seen.current = next;
    const view = store.getState().view;
    if (!view || !you) return;
    for (const entry of fresh) {
      const data = entry.data;
      if (data?.type === "area" && remindsYou(data, you, view)) ui.notify(areaReminderText(data, creatureName(view, data)), "info");
    }
  }, [log, confirmedSeq, you, ui, store]);
}
