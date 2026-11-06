import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pg from "pg";
import { z } from "zod";
import { MP3_BITRATES } from "#shared/audio/mp3.ts";
import { LIMITS, SOUND_LIMITS, VIDEO_LIMITS } from "#shared/limits.ts";
import type { SoundFacts, VideoContainer, VideoFacts } from "#shared/model.ts";
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
 * same volume and waits there 48 hours (docs/design/design-v1-dm-tools.md 3.17):
 * the nightly backup dumps the database and copies the files it names
 * minutes apart, from another container the app's locks cannot reach, so a
 * file deleted between the two must still be there to copy.
 *
 * Images are WebP. A video keeps its real extension, `.webm` or `.mp4`,
 * from its row's `media` (D-261102-454), so every tool and operator reads
 * it as what it is, and a sound is `.mp3` (docs/design/design-v1-music.md 7.2).
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const VIDEO_CONTAINERS = ["webm", "mp4"] as const satisfies readonly VideoContainer[];

export function isVideoContainer(value: unknown): value is VideoContainer {
  return typeof value === "string" && (VIDEO_CONTAINERS as readonly string[]).includes(value);
}

/** A sound's one container, the only file a sound row names (docs/design/design-v1-music.md 7.2). */
export const SOUND_MEDIA = "mp3";

/** What a row's `media` column may hold: a video's container or a sound's. Null for an image. */
export type AssetMedia = VideoContainer | typeof SOUND_MEDIA;

/** The extensions each kind's files take, the only ones cleanup, deletion and the backup look for. */
export function kindExtensions(kind: AssetKind): readonly ("webp" | AssetMedia)[] {
  if (kind === "video") return VIDEO_CONTAINERS;
  if (kind === "sound") return [SOUND_MEDIA];
  return ["webp"];
}

/** A file's extension: WebP for every image, a video's own container, which a video must name, and a sound's `mp3`. */
export function fileExtension(kind: AssetKind, media?: AssetMedia | null): "webp" | AssetMedia {
  if (kind === "sound") {
    if (media !== SOUND_MEDIA) throw new Error("a sound is stored as mp3");
    return media;
  }
  if (kind !== "video") {
    if (media) throw new Error("an image has no container of its own");
    return "webp";
  }
  if (!isVideoContainer(media)) throw new Error("a video is stored as webm or mp4");
  return media;
}

export function variantFileName(sha256Hex: string, kind: AssetKind, variant: Variant, pipeline: number, media?: AssetMedia | null): string {
  // Every part is checked even though callers pass values from our own rows:
  // this string becomes a path, and a path is the wrong place to trust input.
  if (!SHA256_HEX.test(sha256Hex) || !isAssetKind(kind) || !isVariant(variant) || !Number.isInteger(pipeline) || pipeline < 1) {
    throw new Error("invalid asset file name parts");
  }
  return `${sha256Hex}-${kind}-${variant}-v${pipeline}.${fileExtension(kind, media)}`;
}

/** `<assetDir>/<first two hex chars>/<sha256>-<kind>-<variant>-v<pipeline>.<webp, webm, mp4 or mp3>` */
export function variantPath(assetDir: string, sha256Hex: string, kind: AssetKind, variant: Variant, pipeline: number, media?: AssetMedia | null): string {
  return join(assetDir, sha256Hex.slice(0, 2), variantFileName(sha256Hex, kind, variant, pipeline, media));
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
export function trashPath(assetDir: string, at: Date, sha256Hex: string, kind: AssetKind, variant: Variant, pipeline: number, media?: AssetMedia | null): string {
  return join(assetDir, "trash", trashDay(at), sha256Hex.slice(0, 2), variantFileName(sha256Hex, kind, variant, pipeline, media));
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
  /** A video's container or a sound's `mp3`, which names its file and its Content-Type. Null for an image. */
  media: AssetMedia | null;
  /** A video's facts from its header check, without its size and container (`StoredVideo`). Null for an image and a sound. */
  video: unknown;
  /** A sound's facts from its frame walk (`storedSoundSchema`). Null for anything else. */
  audio: unknown;
};

/**
 * The `video` column: what the header check found
 * (docs/design/design-v1-animated-maps.md 9.1), apart from the size, which
 * is the row's own, and the container, which is `media`. Read back through
 * this schema, so a row that somehow holds anything else gives no facts.
 */
export const storedVideoSchema = z.strictObject({
  video: z.string().min(1).max(64),
  audio: z.string().min(1).max(64).optional(),
  fps: z.number().int().min(1).max(1000),
  durationMs: z.number().int().min(1),
  kbps: z.number().int().min(1),
  audioChannels: z.number().int().min(1).max(255).optional(),
  audioHz: z.number().int().min(1).optional(),
  // How the file showed its picture before the check made it plain (docs/design/design-v1-video-turns.md 6.1), bounded
  // as the protocol's mapVideo bounds them. Without them here the upload's answer and the Library would lose the video.
  turn: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
  mirror: z.literal(true).optional(),
  displayWidthPx: z.number().int().min(VIDEO_LIMITS.minSidePx).max(VIDEO_LIMITS.maxSidePx).optional(),
});

export type StoredVideo = z.infer<typeof storedVideoSchema>;

/** The `video` column's value for a video's facts. */
export function storedVideo(facts: VideoFacts): StoredVideo {
  const { widthPx: _w, heightPx: _h, container: _c, ...rest } = facts;
  return rest;
}

/** The bitrates a stored sound may have: MPEG-1 Layer III's within the sound limits. */
const SOUND_KBPS: readonly number[] = MP3_BITRATES.filter((kbps) => kbps >= SOUND_LIMITS.minKbps && kbps <= SOUND_LIMITS.maxKbps);

/**
 * The `audio` column: what the frame walk found (docs/design/design-v1-music.md
 * 7.2), held to the walk's own bounds. The intake parses a file's facts
 * through it before the row is written, and every read of a row goes
 * through it again, so a stored row is never one a reader refuses.
 */
export const storedSoundSchema = z.strictObject({
  ms: z.number().int().min(SOUND_LIMITS.fileMinMs).max(SOUND_LIMITS.fileMaxMs),
  channels: z.union([z.literal(1), z.literal(2)]),
  kbps: z.number().int().refine((kbps) => SOUND_KBPS.includes(kbps), "a bitrate a stored sound may have"),
});

/** A row's sound facts, or undefined for anything but a sound whose columns read as one. */
export function soundFactsOfRow(row: Pick<AssetRow, "kind" | "media" | "audio">): SoundFacts | undefined {
  if (row.kind !== "sound" || row.media !== SOUND_MEDIA) return undefined;
  const parsed = storedSoundSchema.safeParse(row.audio);
  return parsed.success ? parsed.data : undefined;
}

/** A row's video facts, or undefined for an image or a row whose columns do not read as a video's. */
export function videoFactsOf(row: Pick<AssetRow, "kind" | "width" | "height" | "media" | "video">): VideoFacts | undefined {
  if (row.kind !== "video" || !isVideoContainer(row.media)) return undefined;
  const parsed = storedVideoSchema.safeParse(row.video);
  if (!parsed.success) return undefined;
  return { widthPx: row.width, heightPx: row.height, container: row.media, ...parsed.data };
}

export function toView(row: Pick<AssetRow, "id" | "kind" | "width" | "height" | "variants"> & Partial<Pick<AssetRow, "media" | "video" | "audio">>): AssetView {
  const view: AssetView = { id: row.id, kind: row.kind, width: row.width, height: row.height, variants: row.variants };
  const video = videoFactsOf({ kind: row.kind, width: row.width, height: row.height, media: row.media ?? null, video: row.video ?? null });
  if (video) view.video = video;
  const audio = soundFactsOfRow({ kind: row.kind, media: row.media ?? null, audio: row.audio ?? null });
  if (audio) view.audio = audio;
  return view;
}

const ROW_COLUMNS = "id, room_id, sha256, kind, pipeline, width, height, variants, media, video, audio";

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
 * may see the image may read (docs/design/design-v1-dm-tools.md 3.13). A starter
 * pick carries its work's key too, for players as for the DM: it names
 * only a work every server ships (docs/design/design-v1-starter-art.md 5).
 *
 * A player's list (`ids` with `memberId`) puts what they added by when
 * they added it (asset_uploaders.added_at), so an upload or a pick the
 * room already held lists as a new one does (design 11.1). What they see
 * without having added it lists by when the room did. The DM's list keeps
 * the room's order.
 *
 * Sounds are no images, so no library lists them
 * (docs/design/design-v1-music.md 7.2): Ambiance's Sound reads the room's
 * sounds from its state, and their bytes from the storage route.
 */
export async function listRoomAssets(pool: pg.Pool, roomId: string, ids?: ReadonlySet<string>, memberId?: string): Promise<AssetView[]> {
  if (ids && ids.size === 0) return [];
  type Listed = AssetRow & { credit: unknown; starter: string | null };
  const { rows } = ids
    ? await pool.query<Listed>(
        `select ${ROW_COLUMNS}, credit, starter from assets a
         left join asset_uploaders u on u.asset_id = a.id and u.member_id = $3
         where a.room_id = $1 and a.id = any($2::uuid[]) and a.kind <> 'sound'
         order by coalesce(u.added_at, a.created_at) desc, a.id`,
        [roomId, [...ids], memberId ?? null],
      )
    : await pool.query<Listed>(`select ${ROW_COLUMNS}, credit, starter from assets where room_id = $1 and kind <> 'sound' order by created_at desc, id`, [
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
  /** An Openverse image's or a starter pick's credit, found by the server (docs/design/design-v1-dm-tools.md 3.13). */
  credit?: AssetCredit;
  /** A starter pick's work key, which keeps the row out of the room's quota (docs/design/design-v1-starter-art.md 5). */
  starter?: string;
  /** A video's facts, which name its file's container and fill its row's `media` and `video`. */
  video?: VideoFacts;
  /** A sound's facts, which fill its row's `audio`, its `media` being `mp3`. */
  audio?: SoundFacts;
};

/** The `media` a new row takes: a video's container, a sound's mp3, or none for an image. */
function mediaOf(asset: Pick<NewAsset, "kind" | "video">): AssetMedia | null {
  if (asset.kind === "sound") return SOUND_MEDIA;
  return asset.video?.container ?? null;
}

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
    const target = variantPath(assetDir, hex, asset.kind, v.name, pipeline, mediaOf(asset));
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
      `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants, credit, starter, media, video, audio)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        mediaOf(asset),
        asset.video ? JSON.stringify(storedVideo(asset.video)) : null,
        asset.kind === "sound" ? JSON.stringify(storedSoundSchema.parse(asset.audio)) : null,
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
  // recipe with a different variant set are cleaned up too. A video's bytes
  // decide its container, so its key names no extension and both are tried.
  const extensions: readonly (AssetMedia | null)[] = key.kind === "video" ? VIDEO_CONTAINERS : key.kind === "sound" ? [SOUND_MEDIA] : [null];
  for (const variant of VARIANTS) {
    for (const media of extensions) {
      if (await moveToTrash(assetDir, at, hex, key.kind, variant, key.pipeline, media)) deleted++;
    }
  }
  return deleted;
}

/** A rename on the same volume. False when there was no such file. */
async function moveToTrash(assetDir: string, at: Date, hex: string, kind: AssetKind, variant: Variant, pipeline: number, media: AssetMedia | null): Promise<boolean> {
  const from = variantPath(assetDir, hex, kind, variant, pipeline, media);
  try {
    await stat(from);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const to = trashPath(assetDir, at, hex, kind, variant, pipeline, media);
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
