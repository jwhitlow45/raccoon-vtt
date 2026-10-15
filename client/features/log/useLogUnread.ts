import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "#shared/model.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { latestLogId, newWhispersTo, unreadCount, whisperToastText } from "./unread.ts";

const EMPTY_LOG: LogEntry[] = [];

/** The last entry this member saw in the Log on this device, so a reload keeps what is unread. */
function seenKey(roomId: string, memberId: string): string {
  return `rvtt.logSeen.${roomId}.${memberId}`;
}

function readSeen(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSeen(key: string, id: string | null): void {
  if (id === null) return;
  try {
    localStorage.setItem(key, id);
  } catch {
    // Storage blocked: the count still works for this page load.
  }
}

/**
 * The Log's unread count for the Room page's buttons, and a toast for each
 * whisper to this member that arrives while the Log is not showing
 * (unread.ts). `logVisible` is whether the Log is on screen now: a phone's
 * Log sheet, or the side panel's Log tab.
 */
export function useLogUnread(logVisible: boolean): number {
  const log = useRoomView((s) => s.view?.log ?? EMPTY_LOG);
  const loaded = useRoomView((s) => s.view !== null);
  const me = useRoomView((s) => s.you?.memberId ?? null);
  const roomId = useRoomView((s) => s.roomId);
  const members = useRoomView((s) => s.view?.members);
  const ui = useRoomUi();
  const latest = latestLogId(log);
  const key = me ? seenKey(roomId, me) : null;
  const [seen, setSeen] = useState<{ key: string; id: string | null } | null>(null);
  /** The newest entry already checked for whispers. Undefined until the first snapshot. */
  const checked = useRef<string | null | undefined>(undefined);

  // The first look with the state loaded: everything before it counts as
  // seen, unless this device remembers reading less.
  useEffect(() => {
    if (!loaded || !key || seen?.key === key) return;
    setSeen({ key, id: readSeen(key) ?? latest });
    checked.current = latest;
  }, [loaded, key, seen, latest]);

  useEffect(() => {
    if (!logVisible || !key || !seen || seen.id === latest) return;
    setSeen({ key, id: latest });
    writeSeen(key, latest);
  }, [logVisible, key, seen, latest]);

  // Only a new log toasts, never the Log closing or a member's rename, so
  // the rest is read through a ref.
  const now = useRef({ me, logVisible, members, ui });
  now.current = { me, logVisible, members, ui };
  useEffect(() => {
    const { me, logVisible, members, ui } = now.current;
    if (!me || checked.current === undefined) return;
    const fresh = newWhispersTo(log, checked.current, me);
    checked.current = latestLogId(log);
    if (logVisible) return;
    for (const entry of fresh) ui.notify(whisperToastText(entry, members ?? {}));
  }, [log]);

  return seen && me && !logVisible ? unreadCount(log, seen.id, me) : 0;
}
