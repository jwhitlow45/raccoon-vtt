import { useMemo, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import type { JournalPage } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { markSeen, parseSeen, seenKey, unreadPageIds, type SeenPages } from "./unread.ts";

/**
 * The page the Journal panel shows, per Room page (state/scope.ts), so a
 * tap on a map pin can open its page in the panel (features/pins), and
 * "view as a player" keeps its own.
 */
export const journalSlot = scopeSlot(() => createStore<{ pageId: string | null }>(() => ({ pageId: null })));

/*
 * Which pages this device has read, shared by the panel's buttons and the
 * panel itself so a page read in one clears the dot in the other at once.
 * Local storage can be blocked or full, and a dot that comes back after a
 * reload is a small loss, so every read and write may fail.
 */
const seenCache = new Map<string, SeenPages>();
const listeners = new Set<() => void>();

function readSeen(key: string): SeenPages {
  let seen = seenCache.get(key);
  if (seen) return seen;
  try {
    seen = parseSeen(localStorage.getItem(key));
  } catch {
    seen = {};
  }
  seenCache.set(key, seen);
  return seen;
}

function writeSeen(key: string, seen: SeenPages): void {
  seenCache.set(key, seen);
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    // Remembered for this page load only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: Readonly<Record<string, JournalPage>> = {};
const NONE: SeenPages = {};

/**
 * A player's unread pages and a way to mark one read. A DM writes the pages
 * and has nothing to catch up on, so a DM's set is always empty.
 */
export function useJournalSeen(): { unread: ReadonlySet<string>; seen: SeenPages; markRead(page: JournalPage): void } {
  const roomId = useRoomView((s) => s.roomId);
  const you = useRoomView((s) => s.you);
  const pages = useRoomView((s) => s.view?.journal ?? EMPTY);
  const key = you && you.role === "player" ? seenKey(roomId, you.memberId) : null;
  const seen = useSyncExternalStore(subscribe, () => (key ? readSeen(key) : NONE));
  const unread = useMemo(() => (key ? unreadPageIds(pages, seen) : new Set<string>()), [key, pages, seen]);
  return {
    unread,
    seen,
    markRead(page) {
      if (!key) return;
      const before = readSeen(key);
      const next = markSeen(before, page, pages);
      if (JSON.stringify(next) !== JSON.stringify(before)) writeSeen(key, next);
    },
  };
}

/** How many pages a player has not read, for the Journal's button. */
export function useJournalUnread(): number {
  return useJournalSeen().unread.size;
}

/** Folded folders in the Journal, remembered per room on this device only, as the Scenes panel remembers its own. */
function collapsedKey(roomId: string): string {
  return `rvtt.journalFoldersCollapsed.${roomId}`;
}

export function readCollapsedFolders(roomId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(collapsedKey(roomId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedFolders(roomId: string, folders: ReadonlySet<string>): void {
  try {
    localStorage.setItem(collapsedKey(roomId), JSON.stringify([...folders]));
  } catch {
    // Remembered for this page load only.
  }
}
