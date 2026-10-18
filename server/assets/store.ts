import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pg from "pg";
import { LIMITS } from "#shared/limits.ts";
import { assetCreditSchema, type AssetCredit } from "#shared/protocol.ts";
import { PLAYER_UPLOAD_KINDS, VARIANTS, isAssetKind, isVariant, type AssetKind, type AssetView, type Variant } from "./kinds.ts";
import { KeyedMutex } from "./locks.ts";
import type { ProcessedVariant } from "./process.ts";

/**
 * Asset files on disk and asset rows in Postgres.
 *
 * Files are named by content, kind and pipeline, so rooms that upload the
 * same bytes share files, and a file may be deleted only when no row in any
 * room still refers to it. Placing files and deleting them both run under a
 * per-file lock, so a deletion can never slip between another room placing a
 * file and writing the row that refers to it.
 *
 * A deleted file is never unlinked at once. It moves into the trash on the
 * same volume and waits there 48 hours (docs/design-v1-dm-tools.md 3.17):
 * the nightly backup dumps the database and copies the images it names
 * minutes apart, from another container the app's locks cannot reach, so a
 * file deleted between the two must still be there to copy.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function variantFileName(sha256Hex: string, kind: AssetKind, variant: Variant, pipeline: number): string {
  // Every part is checked even though callers pass values from our own rows:
  // this string becomes a path, and a path is the wrong place to trust input.
  if (!SHA256_HEX.test(sha256Hex) || !isAssetKind(kind) || !isVariant(variant) || !Number.isInteger(pipeline) || pipeline < 1) {
    throw new Error("invalid asset file name parts");
  }
  return `${sha256Hex}-${kind}-${variant}-v${pipeline}.webp`;
}

/** `<assetDir>/<first two hex chars>/<sha256>-<kind>-<variant>-v<pipeline>.webp` */
export function variantPath(assetDir: string, sha256Hex: string, kind: AssetKind, variant: Variant, pipeline: number): string {
  return join(assetDir, sha256Hex.slice(0, 2), variantFileName(sha256Hex, kind, variant, pipeline));
}

/**
 * Folders on the image volume that hold no live images: temporary uploads,
 * room exports copied in for the CLI's import, and the trash. Cleanup's
 * walk and the backup both leave them alone as sources of images.
 */
export const NON_IMAGE_DIRS = ["tmp", "import", "trash"] as const;

/** The day a deletion files a file under, in UTC, so the purge's arithmetic never meets a clock change. */
export function trashDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * `<assetDir>/trash/<YYYY-MM-DD>/<first two hex chars>/<file>`: a deleted
 * file keeps its own path below its day, so the backup finds it under any
 * day folder from the very line its list holds (docker/backup.sh).
 */
export function trashPath(assetDir: string, at: Date, sha256Hex: string, kind: AssetKind, variant: Variant, pipeline: number): string {
  return join(assetDir, "trash", trashDay(at), sha256Hex.slice(0, 2), variantFileName(sha256Hex, kind, variant, pipeline));
}

/** When deletions happen, for tests that need a deletion filed under another day. */
let trashClock: () => Date = () => new Date();

export function setTrashClockForTests(clock: (() => Date) | null): void {
  trashClock = clock ?? (() => new Date());
}

const TRASH_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes each trash day whose last moment is more than 48 hours past, so
 * every file waits at least that long, whichever moment of its day it was
 * deleted. Anything in the trash that is not a day folder is left alone.
 */
export async function purgeTrash(assetDir: string, now: number = Date.now()): Promise<string[]> {
  const root = join(assetDir, "trash");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const purged: string[] = [];
  for (const name of names.sort()) {
    if (!TRASH_DAY.test(name)) continue;
    const dayEnds = Date.parse(`${name}T00:00:00Z`) + DAY_MS;
    if (Number.isNaN(dayEnds) || now - dayEnds < LIMITS.trashHours * 3600_000) continue;
    await rm(join(root, name), { recursive: true, force: true });
    purged.push(name);
  }
  return purged;
}

export type FileKey = { sha256: Buffer; kind: AssetKind; pipeline: number };

function lockKey(key: FileKey): string {
  return `${key.sha256.toString("hex")}-${key.kind}-v${key.pipeline}`;
}

/** Shared by every caller in the process, so room deletion and uploads see the same locks. */
const fileLocks = new KeyedMutex();

export type AssetRow = {
  id: string;
  room_id: string;
  sha256: Buffer;
  kind: AssetKind;
  pipeline: number;
  width: number;
  height: number;
  variants: Variant[];
};

export function toView(row: Pick<AssetRow, "id" | "kind" | "width" | "height" | "variants">): AssetView {
  return { id: row.id, kind: row.kind, width: row.width, height: row.height, variants: row.variants };
}

const ROW_COLUMNS = "id, room_id, sha256, kind, pipeline, width, height, variants";

export async function getAsset(db: pg.Pool | pg.PoolClient, assetId: string): Promise<AssetRow | null> {
  const { rows } = await db.query<AssetRow>(`select ${ROW_COLUMNS} from assets where id = $1`, [assetId]);
  return rows[0] ?? null;
}

export async function findRoomAsset(
  db: pg.Pool | pg.PoolClient,
  roomId: string,
  sha256: Buffer,
  kind: AssetKind,
): Promise<AssetRow | null> {
  const { rows } = await db.query<AssetRow>(
    `select ${ROW_COLUMNS} from assets where room_id = $1 and sha256 = $2 and kind = $3`,
    [roomId, sha256, kind],
  );
  return rows[0] ?? null;
}

export async function addUploaders(db: pg.Pool | pg.PoolClient, assetId: string, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) return;
  await db.query(
    `insert into asset_uploaders (asset_id, member_id) select $1, unnest($2::text[]) on conflict do nothing`,
    [assetId, [...memberIds]],
  );
}

/**
 * Every asset of the room, or only those in `ids`. Newest first. An
 * Openverse image or a starter pick carries its credit, which everyone who
 * may see the image may read (docs/design-v1-dm-tools.md 3.13). A starter
 * pick carries its work's key too, for players as for the DM: it names
 * only a work every server ships (docs/design-v1-starter-art.md 5).
 */
export async function listRoomAssets(pool: pg.Pool, roomId: string, ids?: ReadonlySet<string>): Promise<AssetView[]> {
  if (ids && ids.size === 0) return [];
  type Listed = AssetRow & { credit: unknown; starter: string | null };
  const { rows } = ids
    ? await pool.query<Listed>(
        `select ${ROW_COLUMNS}, credit, starter from assets where room_id = $1 and id = any($2::uuid[]) order by created_at desc, id`,
        [roomId, [...ids]],
      )
    : await pool.query<Listed>(`select ${ROW_COLUMNS}, credit, starter from assets where room_id = $1 order by created_at desc, id`, [
        roomId,
      ]);
  return rows.map((row) => {
    const view: AssetView = toView(row);
    const credit = row.credit === null ? undefined : assetCreditSchema.safeParse(row.credit);
    if (credit?.success) view.credit = credit.data;
    if (row.starter !== null) {
      view.starter = row.starter;
      view.sha256 = row.sha256.toString("hex");
    }
    return view;
  });
}

/**
 * Gives an image the credit an Openverse import found for it, unless it
 * has one: the same bytes picked again, or first added another way, are
 * still that work under that license.
 */
export async function addCredit(db: pg.Pool | pg.PoolClient, assetId: string, credit: AssetCredit): Promise<void> {
  await db.query(`update assets set credit = $2 where id = $1 and credit is null`, [assetId, JSON.stringify(credit)]);
}

/**
 * Assets this member uploaded in this room (a row in asset_uploaders names
 * them), of the kinds a player may upload. A player's read of anything else
 * rests on the projection alone, so an uploader row a room import or an old
 * grant left on a DM-only kind gives a player nothing.
 */
export async function uploadedAssetIds(pool: pg.Pool, roomId: string, memberId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(
    `select a.id from assets a join asset_uploaders u on u.asset_id = a.id
     where a.room_id = $1 and u.member_id = $2 and a.kind = any($3::text[])`,
    [roomId, memberId, [...PLAYER_UPLOAD_KINDS]],
  );
  return new Set(rows.map((r) => r.id));
}

export type NewAsset = {
  roomId: string;
  sha256: Buffer;
  kind: AssetKind;
  uploaderIds: readonly string[];
  variants: ProcessedVariant[];
  /** An Openverse image's or a starter pick's credit, found by the server (docs/design-v1-dm-tools.md 3.13). */
  credit?: AssetCredit;
  /** A starter pick's work key, which keeps the row out of the room's quota (docs/design-v1-starter-art.md 5). */
  starter?: string;
};

/**
 * Moves processed variants to their content names and writes the row and its
 * uploaders, all under the file lock.
 *
 * A file that already exists (another room uploaded the same bytes as the
 * same kind) is kept and the new copy dropped, so a URL that was served once
 * never changes bytes. If an identical upload to the same room won the race
 * to write the row, that row is returned and this uploader is added to it,
 * exactly as if the reuse had been found up front. `created` says which:
 * whether this call wrote the row.
 */
export async function placeAndInsert(pool: pg.Pool, assetDir: string, asset: NewAsset, pipeline: number): Promise<{ view: AssetView; created: boolean }> {
  const key: FileKey = { sha256: asset.sha256, kind: asset.kind, pipeline };
  return fileLocks.run(lockKey(key), async () => {
    let inserted: { view: AssetView; lostRace: boolean };
    try {
      await placeFiles(assetDir, asset, pipeline);
      inserted = await insertRow(pool, asset, pipeline);
    } catch (err) {
      // Whatever was placed before the failure may now belong to no row.
      await deleteIfUnreferenced(pool, assetDir, key).catch(() => undefined);
      throw err;
    }
    // The row that won may come from an older pipeline, in which case the
    // files just placed belong to nobody.
    if (inserted.lostRace) await deleteIfUnreferenced(pool, assetDir, key);
    return { view: inserted.view, created: !inserted.lostRace };
  });
}

async function placeFiles(assetDir: string, asset: NewAsset, pipeline: number): Promise<void> {
  const hex = asset.sha256.toString("hex");
  for (const v of asset.variants) {
    const target = variantPath(assetDir, hex, asset.kind, v.name, pipeline);
    await mkdir(dirname(target), { recursive: true });
    if (await exists(target)) {
      await unlink(v.path).catch(() => undefined);
    } else {
      await rename(v.path, target);
    }
  }
}

async function insertRow(pool: pg.Pool, asset: NewAsset, pipeline: number): Promise<{ view: AssetView; lostRace: boolean }> {
  const full = asset.variants.find((v) => v.name === "full");
  if (!full) throw new Error("processed asset has no full variant");
  const bytes = asset.variants.reduce((sum, v) => sum + v.bytes, 0);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<AssetRow>(
      `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants, credit, starter)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (room_id, sha256, kind) do nothing
       returning ${ROW_COLUMNS}`,
      [
        randomUUID(),
        asset.roomId,
        asset.sha256,
        asset.kind,
        pipeline,
        full.width,
        full.height,
        bytes,
        asset.variants.map((v) => v.name),
        asset.credit ? JSON.stringify(asset.credit) : null,
        asset.starter ?? null,
      ],
    );
    let row = inserted.rows[0];
    const lostRace = !row;
    row ??= (await findRoomAsset(client, asset.roomId, asset.sha256, asset.kind)) ?? undefined;
    if (!row) throw new Error("asset row vanished during insert");
    await addUploaders(client, row.id, asset.uploaderIds);
    if (lostRace && asset.credit) await addCredit(client, row.id, asset.credit);
    await client.query("commit");
    return { view: toView(row), lostRace };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Moves the files of each key that no assets row in any room refers to into
 * the trash, and answers how many it moved. Room deletion calls this with
 * the keys it collected (roomFileKeys) before the rows cascaded away, and
 * cleanup with the keys of the rows it deleted.
 */
export async function deleteUnreferencedFiles(pool: pg.Pool, assetDir: string, keys: readonly FileKey[]): Promise<number> {
  let deleted = 0;
  for (const key of keys) {
    deleted += await fileLocks.run(lockKey(key), () => deleteIfUnreferenced(pool, assetDir, key));
  }
  return deleted;
}

/** The distinct files a room's rows refer to. Collect before deleting the room. */
export async function roomFileKeys(pool: pg.Pool, roomId: string): Promise<FileKey[]> {
  const { rows } = await pool.query<{ sha256: Buffer; kind: string; pipeline: number }>(
    `select distinct sha256, kind, pipeline from assets where room_id = $1`,
    [roomId],
  );
  return rows.filter((r): r is FileKey => isAssetKind(r.kind));
}

/** Caller holds the file lock for `key`. */
async function deleteIfUnreferenced(pool: pg.Pool, assetDir: string, key: FileKey): Promise<number> {
  const { rowCount } = await pool.query(`select 1 from assets where sha256 = $1 and kind = $2 and pipeline = $3 limit 1`, [
    key.sha256,
    key.kind,
    key.pipeline,
  ]);
  if (rowCount) return 0;
  const hex = key.sha256.toString("hex");
  const at = trashClock();
  let deleted = 0;
  // Every variant name, not only this kind's current list, so files from a
  // recipe with a different variant set are cleaned up too.
  for (const variant of VARIANTS) {
    if (await moveToTrash(assetDir, at, hex, key.kind, variant, key.pipeline)) deleted++;
  }
  return deleted;
}

/** A rename on the same volume. False when there was no such file. */
async function moveToTrash(assetDir: string, at: Date, hex: string, kind: AssetKind, variant: Variant, pipeline: number): Promise<boolean> {
  const from = variantPath(assetDir, hex, kind, variant, pipeline);
  try {
    await stat(from);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const to = trashPath(assetDir, at, hex, kind, variant, pipeline);
  await mkdir(dirname(to), { recursive: true });
  // The same name twice in one day holds the same bytes, so replacing it loses nothing.
  await rename(from, to);
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
