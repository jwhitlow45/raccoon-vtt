import { useEffect, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import { handoutPages } from "#shared/handouts.ts";
import type { Handout, HandoutDoc } from "#shared/model.ts";
import { ApiError, api, type AssetRow } from "../../lib/api.ts";
import { scopeSlot } from "../../state/scope.ts";

/**
 * The room's images as the server lists them for this member (design 11.2:
 * a player's own uploads and what their view shows, the DM every one), kept
 * once per room for the page. The Library tab and panel refresh it when they
 * open. A credit line in a panel reads the same list, so showing an image's
 * credit (docs/design-v1-dm-tools.md 3.13) costs no request of its own.
 */

type Entry = { rows: ReadonlyMap<string, AssetRow> | null; failed: boolean; loading: Promise<void> | null; loadedAt: number };

const rooms = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

/** A row the list does not hold yet asks the server again, but not more often than this. */
const MISSING_RETRY_MS = 20_000;

function entryFor(roomId: string): Entry {
  let entry = rooms.get(roomId);
  if (!entry) {
    entry = { rows: null, failed: false, loading: null, loadedAt: 0 };
    rooms.set(roomId, entry);
  }
  return entry;
}

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Lists the room's images again. A refresh already running is shared. */
export function refreshLibrary(roomId: string): Promise<void> {
  const entry = entryFor(roomId);
  if (entry.loading) return entry.loading;
  entry.loading = api
    .listAssets(roomId)
    .then(
      (r) => {
        entry.rows = new Map(r.assets.map((a) => [a.id, a]));
        entry.failed = false;
      },
      () => {
        entry.failed = true;
      },
    )
    .finally(() => {
      entry.loading = null;
      entry.loadedAt = Date.now();
      emit();
    });
  emit();
  return entry.loading;
}

/** A row the picker just made (an upload or an import), so its credit shows before the next listing. */
export function rememberAsset(roomId: string, row: AssetRow): void {
  const entry = entryFor(roomId);
  entry.rows = new Map(entry.rows ?? []).set(row.id, row);
  emit();
}

/** Rows the DM just deleted. */
export function forgetAssets(roomId: string, ids: readonly string[]): void {
  const entry = entryFor(roomId);
  if (!entry.rows) return;
  const rows = new Map(entry.rows);
  for (const id of ids) rows.delete(id);
  entry.rows = rows;
  emit();
}

/** `retry` lists the room's images again, for a list that failed to load. */
export type LibraryState = { rows: readonly AssetRow[] | null; loading: boolean; failed: boolean; retry(): void };

function useEntry(roomId: string): Entry {
  // The same snapshot on a server render, which only tests do.
  useSyncExternalStore(subscribe, () => version, () => version);
  return entryFor(roomId);
}

/**
 * The room's list as it stands. A list that failed and is being asked for
 * again reads as loading, not failed, so Try again shows that it is trying
 * and an empty list says nothing until the answer comes.
 */
export function libraryState(roomId: string): LibraryState {
  const entry = entryFor(roomId);
  return {
    rows: entry.rows ? [...entry.rows.values()] : null,
    loading: entry.loading !== null,
    failed: entry.failed && !entry.rows && entry.loading === null,
    retry: () => void refreshLibrary(roomId),
  };
}

/** The whole list, refreshed when the caller mounts. */
export function useLibrary(roomId: string): LibraryState {
  useEntry(roomId);
  useEffect(() => {
    void refreshLibrary(roomId);
  }, [roomId]);
  return libraryState(roomId);
}

/**
 * One image's row, for its credit. The list loads on first need, and a row
 * it lacks (an image another member just added) asks again at most every
 * 20 s, so a panel never polls.
 */
export function useAssetRow(roomId: string, assetId: string | undefined): AssetRow | undefined {
  const entry = useEntry(roomId);
  const row = assetId ? entry.rows?.get(assetId) : undefined;
  const stale = assetId !== undefined && !row && entry.loading === null && Date.now() - entry.loadedAt > MISSING_RETRY_MS;
  useEffect(() => {
    if (stale) void refreshLibrary(roomId);
  }, [stale, roomId]);
  return row;
}

/** Empties every room's list, for tests. */
export function resetLibraryForTest(): void {
  rooms.clear();
  emit();
}

// ---------------------------------------------------------------- the DM's cleanup (docs/design-v1-dm-tools.md 3.19)

/**
 * The library images the DM can delete: those the room's state does not use.
 * Scene thumbnails are cleaned up on their own. `held` names images this
 * device knows are taken though the listing may not say so yet: a
 * document's pages, which a listing fetched before the document was saved
 * still calls unused, and a running upload's (docs/design-v1-pdf-handouts.md
 * 4.1.2 and 8.1).
 */
export function notInUse(rows: readonly AssetRow[], held: ReadonlySet<string> = new Set()): AssetRow[] {
  return rows.filter((r) => r.inUse === false && r.kind !== "thumb" && !held.has(r.id));
}

/**
 * The library's images as it lists them (docs/design-v1-starter-art.md 5):
 * the room's own first, then apart the starter picks, those whose row
 * carries a starter mark, so a DM managing their own maps never wades
 * through starter art. `rowOf` finds an item's row. An item the listing
 * lacks, such as an image only seen on a token, counts as the room's own.
 */
export function apartFromStarter<T>(items: readonly T[], rowOf: (item: T) => Pick<AssetRow, "starter"> | undefined): { own: T[]; starter: T[] } {
  const own: T[] = [];
  const starter: T[] = [];
  for (const item of items) (rowOf(item)?.starter === undefined ? own : starter).push(item);
  return { own, starter };
}

/** The starter picks' fold, its count in the heading so a closed fold still says what it holds. */
export function starterFoldLabel(count: number): string {
  return `From starter packs (${count})`;
}

/** The server takes at most this many ids a request. */
export const DELETE_BATCH = 500;

export function deleteBatches(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += DELETE_BATCH) out.push(ids.slice(i, i + DELETE_BATCH));
  return out;
}

/** The size the images take, when the server sent each one's, else null so no number is guessed. */
export function totalBytes(rows: readonly AssetRow[]): number | null {
  let total = 0;
  for (const r of rows) {
    if (typeof r.bytes !== "number") return null;
    total += r.bytes;
  }
  return total;
}

/** `remaining` lists the ids the fresh list still holds: those kept as in use, or left by a failure. */
export type DeleteResult = { deleted: number; inUse: boolean; error: unknown; remaining: string[] };

/**
 * Deletes the images in batches the server accepts. An image the state
 * names again by the time the server checks is refused (`asset_in_use`).
 * The batch is then read again from a fresh list and the images still
 * unused, if any, are sent once more, so one image put back on a token
 * keeps no other from going. The list is read again at the end either way,
 * so what shows is what remains.
 */
export async function deleteImages(roomId: string, ids: readonly string[]): Promise<DeleteResult> {
  let inUse = false;
  let error: unknown = null;
  for (let batch of deleteBatches(ids)) {
    for (let attempt = 0; batch.length > 0; attempt++) {
      try {
        await api.deleteAssets(roomId, batch);
        forgetAssets(roomId, batch);
        break;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === "asset_in_use")) {
          error = err;
          break;
        }
        inUse = true;
        if (attempt > 0) break;
        await refreshLibrary(roomId);
        const rows = entryFor(roomId).rows;
        batch = batch.filter((id) => rows?.get(id)?.inUse === false);
      }
    }
    if (error) break;
  }
  await refreshLibrary(roomId);
  // Counted from the fresh list, so the count is what the server removed whatever it refused.
  const rows = entryFor(roomId).rows;
  const deleted = rows ? ids.filter((id) => !rows.has(id)).length : 0;
  // With no list at all, only the server's refusals say what stayed.
  const remaining = rows ? ids.filter((id) => rows.has(id)) : error !== null || inUse ? [...ids] : [];
  return { deleted, inUse, error, remaining };
}

// ---------------------------------------------------------------- handout documents (docs/design-v1-pdf-handouts.md 8.1)

/**
 * The images a running PDF upload on this device holds, the pages it made
 * and those it reused alike (docs/design-v1-pdf-handouts.md 4.1.2). The
 * upload job (features/handouts/pdf) writes it: it adds each page's id once
 * the page's upload answers, and empties it when the job ends, saved,
 * cancelled or dismissed. The Library reads it. Until the job ends its
 * pages are not loose on this device, so they are tagged "Uploading" and
 * kept out of "Not in use" and Clean up, where a tap could delete a page
 * the job is about to save. Another DM device has no such slot and lists
 * them as loose images, which the job's save meets as `gone`.
 */
export type Uploading = { ids: ReadonlySet<string> };

export const uploadingSlot = scopeSlot(() => createStore<Uploading>(() => ({ ids: new Set<string>() })));

/** A document's images, each once, in the order of the first page that names it. A blank page can repeat (section 3.1). */
export function docAssetIds(doc: Pick<HandoutDoc, "pages">): string[] {
  return [...new Set(doc.pages.map((p) => p.assetId))];
}

/**
 * Whether a handout showing has exactly this document's pages: the same
 * images in the same order, one image counting as the one page it is. One
 * shared page, such as a blank page two documents both hold, does not
 * count. This only describes the document. Which images may be deleted is
 * the server's question, answered from the whole state (section 3.5).
 */
export function docShowing(doc: Pick<HandoutDoc, "pages">, handouts: Iterable<Handout | undefined>): boolean {
  for (const h of handouts) {
    if (!h) continue;
    const pages = handoutPages(h);
    if (pages.length === doc.pages.length && pages.every((p, i) => p.assetId === doc.pages[i]?.assetId)) return true;
  }
  return false;
}

/** The DM's documents, newest first. */
export function docsNewestFirst(docs: Readonly<Record<string, HandoutDoc | undefined>> | undefined): HandoutDoc[] {
  return Object.values(docs ?? {})
    .filter((d): d is HandoutDoc => d !== undefined)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * The handout images listed loose, after the documents: those no document
 * names, since a document shows as one item with its pages. `hidden` takes
 * out more, such as the pages of a document being deleted, which go with it.
 */
export function looseHandouts(rows: readonly AssetRow[], docs: readonly Pick<HandoutDoc, "pages">[], hidden: ReadonlySet<string> = new Set()): AssetRow[] {
  const named = new Set(docs.flatMap((d) => d.pages.map((p) => p.assetId)));
  return rows.filter((r) => r.kind === "handout" && !named.has(r.id) && !hidden.has(r.id));
}

/** A document's size, each image counted once however many pages it fills, and null until the list holds every image with its size. */
export function docBytes(doc: Pick<HandoutDoc, "pages">, rows: ReadonlyMap<string, AssetRow> | null): number | null {
  if (!rows) return null;
  const listed: AssetRow[] = [];
  for (const id of docAssetIds(doc)) {
    const row = rows.get(id);
    if (!row) return null;
    listed.push(row);
  }
  return totalBytes(listed);
}
