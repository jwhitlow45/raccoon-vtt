import { useEffect, useSyncExternalStore } from "react";
import { ApiError, api, type AssetRow } from "../../lib/api.ts";

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

export type LibraryState = { rows: readonly AssetRow[] | null; loading: boolean; failed: boolean };

function useEntry(roomId: string): Entry {
  useSyncExternalStore(subscribe, () => version);
  return entryFor(roomId);
}

/** The whole list, refreshed when the caller mounts. */
export function useLibrary(roomId: string): LibraryState {
  const entry = useEntry(roomId);
  useEffect(() => {
    void refreshLibrary(roomId);
  }, [roomId]);
  return { rows: entry.rows ? [...entry.rows.values()] : null, loading: entry.loading !== null, failed: entry.failed && !entry.rows };
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

/** The library images the DM can delete: those the room's state does not use. Scene thumbnails are cleaned up on their own. */
export function notInUse(rows: readonly AssetRow[]): AssetRow[] {
  return rows.filter((r) => r.inUse === false && r.kind !== "thumb");
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

export type DeleteResult = { deleted: number; inUse: boolean; error: unknown };

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
  return { deleted, inUse, error };
}
