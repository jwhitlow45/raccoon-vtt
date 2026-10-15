import type { JournalPage } from "#shared/model.ts";

/**
 * Which journal pages a player has not read since they last changed
 * (docs/design-v1-dm-tools.md 3.7), tracked per device. A page counts as
 * read once the player opens it, and as unread again when what they read
 * changes: a new page shared with them, a block edited, a secret revealed.
 *
 * Each page is remembered by a hash of its title and its blocks as the
 * player receives them, so a secret the DM has not revealed (which the
 * player never receives) cannot mark anything, and a page moved to another
 * folder is not news. Plain functions, so they run under node --test.
 */

export type SeenPages = Readonly<Record<string, string>>;

/** FNV-1a over the page's readable content, as 8 hex digits. A collision only hides one dot. */
export function pageHash(page: Pick<JournalPage, "title" | "blocks">): string {
  const text = JSON.stringify([page.title, page.blocks.map((b) => [b.id, b.text])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/*
 * A page object is replaced on every change and never edited, so its hash is
 * kept for its life: a room of 200 long pages is hashed once, not on every
 * render of the buttons that show the dot.
 */
const hashes = new WeakMap<Pick<JournalPage, "title" | "blocks">, string>();

function hashOf(page: Pick<JournalPage, "title" | "blocks">): string {
  let hash = hashes.get(page);
  if (hash === undefined) hashes.set(page, (hash = pageHash(page)));
  return hash;
}

/** The ids of pages whose content differs from the last time this device saw them. */
export function unreadPageIds(pages: Readonly<Record<string, JournalPage>>, seen: SeenPages): Set<string> {
  const out = new Set<string>();
  for (const page of Object.values(pages)) if (seen[page.id] !== hashOf(page)) out.add(page.id);
  return out;
}

/** The record after reading `page`, keeping only pages the player still has, so it never grows past the room's pages. */
export function markSeen(seen: SeenPages, page: JournalPage, pages: Readonly<Record<string, JournalPage>>): SeenPages {
  const next: Record<string, string> = {};
  for (const [id, hash] of Object.entries(seen)) if (pages[id]) next[id] = hash;
  next[page.id] = hashOf(page);
  return next;
}

export function seenKey(roomId: string, memberId: string): string {
  return `rvtt.journalSeen.${roomId}.${memberId}`;
}

/** A stored record, or an empty one when it is missing or not a record of strings. */
export function parseSeen(raw: string | null): SeenPages {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}
