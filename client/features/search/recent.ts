import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot } from "../../state/scope.ts";
import type { SearchEntry } from "./entry.ts";

/**
 * This device's recent search picks (designs/qol/search.md 5.2 and 5.9),
 * apart from the handouts' own recent showings (features/handouts/recent.ts).
 * Kept per room and member, as result ids only, the last five newest
 * first, so a DM's picks on a shared device are never a player's. An id
 * shows on an empty field only while the index built now holds it, so a
 * token hidden since, or anything a viewer may no longer reach, is never
 * shown. Recent is its own section: it never reorders a typed list
 * (D-261106-175).
 */

export const RECENT_PICKS = 5;

/** The longest id kept. Entry ids are a kind and a record's or an anchor's id. */
const MAX_ID = 200;

export function recentPicksKey(roomId: string, memberId: string): string {
  return `rvtt.searchRecent.${roomId}.${memberId}`;
}

function isPickId(v: unknown): v is string {
  // Printable characters only: anything could have written to storage.
  return typeof v === "string" && v.length >= 1 && v.length <= MAX_ID && !/[\u0000-\u001f\u007f]/.test(v);
}

/** The list with this pick first, an earlier pick of it dropped. */
export function recordPick(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((other) => other !== id)].slice(0, RECENT_PICKS);
}

/** What storage held: ids, newest first, each once, five at most. Anything unreadable counts as nothing. */
export function parseRecentPicks(raw: string | null): string[] {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const v of data.slice(0, 50)) {
    if (isPickId(v) && !out.includes(v)) out.push(v);
    if (out.length === RECENT_PICKS) break;
  }
  return out;
}

export function encodeRecentPicks(ids: readonly string[]): string {
  return JSON.stringify(ids.slice(0, RECENT_PICKS));
}

/** The recent picks the index built now still holds, newest first, as its entries. */
export function recentEntries(ids: readonly string[], byId: ReadonlyMap<string, { entry: SearchEntry }>): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) out.push(found.entry);
  }
  return out;
}

// ---------------------------------------------------------------- device storage

export type PickStorage = Pick<Storage, "getItem" | "setItem">;

function deviceStorage(): PickStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The picks of the room and member this page searches as, `key` naming them, or null before the room said who this is. */
export type RecentPicks = { key: string | null; ids: readonly string[] };

export const recentPicksSlot = scopeSlot(() => createStore<RecentPicks>(() => ({ key: null, ids: [] })));

/** Reads the member's picks for the room, once for each room and member. Storage that is blocked reads as none. */
export function loadRecentPicks(store: StoreApi<RecentPicks>, roomId: string, memberId: string, storage: PickStorage | null = deviceStorage()): void {
  const key = recentPicksKey(roomId, memberId);
  if (store.getState().key === key) return;
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    // Blocked: the list starts empty and lasts for this page load.
  }
  store.setState({ key, ids: parseRecentPicks(raw) });
}

/**
 * Remembers a pick of an entry from the index. Storage that is blocked or
 * full keeps it for this page load only. Before the room said who this is,
 * nothing is kept, since it would be kept for no one.
 */
export function rememberPick(store: StoreApi<RecentPicks>, id: string, storage: PickStorage | null = deviceStorage()): void {
  const { key, ids } = store.getState();
  if (key === null || !isPickId(id)) return;
  const next = recordPick(ids, id);
  store.setState({ ids: next });
  try {
    storage?.setItem(key, encodeRecentPicks(next));
  } catch {
    // As above.
  }
}
