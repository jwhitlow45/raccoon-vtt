import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pg from "pg";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { assetCreditSchema, type AssetCredit } from "#shared/protocol.ts";
import { starterAssetCredit, type FoundWork, type StarterKind } from "#shared/starter.ts";
import { animatedMapsOn, roomSoundOn, type Config } from "../config.ts";
import { checkSound, type SoundCheckOptions } from "./audio/check.ts";
import { createEgress, type Egress } from "./egress.ts";
import { AssetError } from "./errors.ts";
import { KINDS, PIPELINE, SOUND_PIPELINE, VIDEO_PIPELINE, nameGrid, type AssetKind, type UploadResult } from "./kinds.ts";
import { WindowLimiter, hourlyChecks, starterHourlyChecks } from "./limits.ts";
import { ProcessingQueue, configureSharp, processImage, removeFiles, sniffImage } from "./process.ts";
import { ROOM_QUOTA_BYTES_SQL, RoomQuota, assertFreeDisk, hasFreeDisk, roomStoredBytes, type Reservation } from "./quota.ts";
import { OpenverseSearch, openverseHttp, type OpenverseHttp } from "./openverse.ts";
import { ImageSearch, httpJson, type HttpJson } from "./serpapi.ts";
import { IntakeSlots, Semaphore, type SlotLimits } from "./slots.ts";
import { REAL_FLOOR_CLOCK, StarterWorkError, copyHashing, starterCatalog, starterFilePath, starterGrid, type FloorClock, type StarterCatalog, type StarterOptions } from "./starter.ts";
import { addCredit, addUploaders, findRoomAsset, placeAndInsert, toView, uploadedAssetIds, type AssetRow } from "./store.ts";
import { tempFile } from "./upload.ts";
import { checkVideo } from "./video/check.ts";

/**
 * Which assets of a room a player may see. The real answer comes from the
 * room's projection (design section 11.2): the player's own uploads plus
 * every asset referenced by what the player can currently see. Until the
 * room actor exists, the default is the player's own uploads, which is
 * strictly narrower, so nothing leaks in the meantime. Replace it with
 * `setVisibleAssets` (or the route option) once projection is wired up.
 */
export type VisibleAssetsFn = (roomId: string, memberId: string) => Promise<Set<string>>;

export type RoomInfo = { pinned: boolean; createdAt: Date; readOnly: boolean };

export type AssetServiceOptions = {
  pool: pg.Pool;
  config: Config;
  visibleAssets?: VisibleAssetsFn;
  /** Refuse new images below this much free space on the asset volume. */
  minFreeBytes?: number;
  /**
   * Where uploads and variants are made before they move into place, on the
   * image volume so that move is a rename. The server's is `tmp` there. The
   * CLI's import passes a folder of its own, so its startup never clears the
   * running server's temporary files (docs/design/design-v1-dm-tools.md 3.19).
   */
  tmpDir?: string;
  slotLimits?: SlotLimits;
  maxOutboundFetches?: number;
  maxQueuedJobs?: number;
  egress?: Egress;
  /** SerpApi transport, for tests. Defaults to the strict egress port. */
  serpApiHttp?: HttpJson;
  /** Openverse's transport and clock, for tests. The transport defaults to the strict egress port. */
  openverse?: { http?: OpenverseHttp; now?: () => number };
  /** Body timing, for tests. Defaults follow design section 11.1. */
  bodyTiming?: { minBytesPerSec?: number; graceMs?: number; checkEveryMs?: number; deadlineMs?: number };
  /** The starter catalog and the folder its files are read from, for tests. Defaults to the shipped ones (starter.ts). */
  starter?: StarterOptions;
  /** The clock a player's starter pick waits out its floor on (starter.ts PLAYER_PICK_FLOOR_MS), for tests. */
  pickClock?: FloorClock;
  /** The sound check's budget, deadline and worker, for tests (audio/check.ts). */
  soundCheck?: SoundCheckOptions;
  now?: () => number;
};

/**
 * What ingest is asked to store. How the row is paid for comes in one of
 * two ways: a reservation on the room's quota (design 11.1), or a starter
 * mark, the work's key, for a pick that never counts toward the quota
 * (docs/design/design-v1-starter-art.md 5). Nothing else skips the quota.
 */
export type IngestInput = {
  roomId: string;
  uploaderIds: readonly string[];
  kind: AssetKind;
  tempPath: string;
  sha256: Buffer;
  nameHint?: string;
  background?: boolean;
  /** An Openverse image's credit, from the server's own search cache (openverse.ts creditForImport), or a starter work's, from the catalog. */
  credit?: AssetCredit;
} & ({ reservation: Reservation; starter?: undefined } | { reservation?: undefined; starter: string });

/** A starter pick's answer: an upload's, with the catalog's credit, the work's key, and a map's cell size. */
export type StarterResult = UploadResult & { credit: AssetCredit; starter: string; sha256: string; originPx?: { x: number; y: number } };

export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** A room's storage line (docs/design/design-v1-sound.md 7.2): what its quota counts, the quota (0 for none) and what its sounds take, in bytes. */
export type RoomStorage = { used: number; quota: number; sounds: number };

/** Rooms whose storage is remembered at once. Past it the oldest are forgotten, so the memory is bounded. */
const STORAGE_ROOMS = 512;

export class AssetService {
  readonly pool: pg.Pool;
  readonly config: Config;
  readonly assetDir: string;
  /** The folder whose disk the log archive's floor checks: DATABASE_DISK_DIR, else the asset folder. */
  readonly databaseDiskDir: string;
  readonly tmpDir: string;
  readonly minFreeBytes: number;
  readonly quota: RoomQuota;
  readonly slots: IntakeSlots;
  readonly outbound: Semaphore;
  readonly queue: ProcessingQueue;
  readonly hourly: WindowLimiter;
  readonly egress: Egress;
  readonly search: ImageSearch | null;
  /** Always there: Openverse needs no key (docs/design/design-v1-dm-tools.md 3.13). */
  readonly openverse: OpenverseSearch;
  readonly bodyTiming: AssetServiceOptions["bodyTiming"];
  readonly starter: StarterCatalog;
  readonly pickClock: FloorClock;
  readonly soundCheck: SoundCheckOptions;
  #visibleAssets: VisibleAssetsFn;
  #now: () => number;
  /** Each room's storage line and when it was read, or the read in flight, so concurrent asks share one query. */
  #storage = new Map<string, { at: number; value: Promise<RoomStorage> }>();

  constructor(opts: AssetServiceOptions) {
    this.pool = opts.pool;
    this.config = opts.config;
    this.assetDir = resolve(opts.config.ASSET_DIR);
    this.databaseDiskDir = opts.config.DATABASE_DISK_DIR === undefined ? this.assetDir : resolve(opts.config.DATABASE_DISK_DIR);
    this.tmpDir = opts.tmpDir ?? join(this.assetDir, "tmp");
    this.minFreeBytes = opts.minFreeBytes ?? MIN_FREE_BYTES;
    this.quota = new RoomQuota(opts.config.ROOM_QUOTA_MB * 1024 * 1024, (roomId) => roomStoredBytes(opts.pool, roomId));
    this.slots = new IntakeSlots(opts.slotLimits);
    this.outbound = new Semaphore(opts.maxOutboundFetches ?? 4);
    this.queue = new ProcessingQueue(opts.maxQueuedJobs ?? 8);
    this.hourly = new WindowLimiter(3600_000, opts.now);
    this.egress = opts.egress ?? createEgress(opts.config);
    this.bodyTiming = opts.bodyTiming;
    this.starter = starterCatalog(opts.starter, opts.config.production);
    this.pickClock = opts.pickClock ?? REAL_FLOOR_CLOCK;
    this.soundCheck = opts.soundCheck ?? {};
    this.#now = opts.now ?? Date.now;
    const key = opts.config.SERPAPI_KEY;
    this.search = key
      ? new ImageSearch({ pool: opts.pool, apiKey: key, http: opts.serpApiHttp ?? httpJson(this.egress.strict), now: opts.now })
      : null;
    this.openverse = new OpenverseSearch({
      pool: opts.pool,
      http: opts.openverse?.http ?? openverseHttp(this.egress.strict),
      clientId: opts.config.OPENVERSE_CLIENT_ID,
      clientSecret: opts.config.OPENVERSE_CLIENT_SECRET,
      now: opts.openverse?.now ?? opts.now,
    });
    this.#visibleAssets = opts.visibleAssets ?? ((roomId, memberId) => uploadedAssetIds(opts.pool, roomId, memberId));
  }

  /**
   * Creates the directories and clears temporary files a crash left behind.
   * Only names this module creates are removed, so anything else kept in
   * tmp (a retained room import, say) is left alone.
   */
  async init(): Promise<void> {
    configureSharp();
    await mkdir(this.tmpDir, { recursive: true });
    for (const name of await readdir(this.tmpDir)) {
      if (/^(intake|fetch|variant)-/.test(name)) await unlink(join(this.tmpDir, name)).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.egress.close();
  }

  visibleAssets(roomId: string, memberId: string): Promise<Set<string>> {
    return this.#visibleAssets(roomId, memberId);
  }

  setVisibleAssets(fn: VisibleAssetsFn): void {
    this.#visibleAssets = fn;
  }

  /**
   * The room's storage line, read again at most every
   * SOUND_LIMITS.storageRecheckMs, or sooner after `forgetStorage`. A read
   * that fails is forgotten at once, so the next ask tries again.
   */
  storage(roomId: string): Promise<RoomStorage> {
    const now = this.#now();
    const kept = this.#storage.get(roomId);
    if (kept && now - kept.at < SOUND_LIMITS.storageRecheckMs) return kept.value;
    const value = this.#readStorage(roomId);
    this.#storage.delete(roomId);
    this.#storage.set(roomId, { at: now, value });
    if (this.#storage.size > STORAGE_ROOMS) this.#storage.delete(this.#storage.keys().next().value!);
    value.catch(() => {
      if (this.#storage.get(roomId)?.value === value) this.#storage.delete(roomId);
    });
    return value;
  }

  /** After an upload or a delete in the room: its next storage line is read afresh. */
  forgetStorage(roomId: string): void {
    this.#storage.delete(roomId);
  }

  async #readStorage(roomId: string): Promise<RoomStorage> {
    const { rows } = await this.pool.query<{ used: string; sounds: string }>(
      `select ${ROOM_QUOTA_BYTES_SQL} as used,
         coalesce((select sum(bytes) from assets where room_id = $1 and kind = 'sound' and starter is null), 0) as sounds`,
      [roomId],
    );
    return { used: Number(rows[0]?.used ?? 0), quota: this.quota.quotaBytes, sounds: Number(rows[0]?.sounds ?? 0) };
  }

  async roomInfo(roomId: string): Promise<RoomInfo | null> {
    const { rows } = await this.pool.query<{ pinned: boolean; created_at: Date; read_only: boolean }>(
      `select pinned, created_at, read_only from rooms where id = $1`,
      [roomId],
    );
    const row = rows[0];
    return row ? { pinned: row.pinned, createdAt: row.created_at, readOnly: row.read_only } : null;
  }

  assertFreeDisk(): Promise<void> {
    return assertFreeDisk(this.assetDir, this.minFreeBytes);
  }

  /** The log archive's guard (persistence.ts ArchiveGuard): the uploads' floor, on the database's disk. */
  archiveDiskOk(): Promise<boolean> {
    return hasFreeDisk(this.databaseDiskDir, this.minFreeBytes);
  }

  /** The hourly budgets an upload spends (limits.ts hourlyChecks). */
  hourlyChecks(sessionId: string, ip: string, roomId: string, kind?: AssetKind): Array<{ key: string; limit: number }> {
    return hourlyChecks(sessionId, ip, roomId, kind);
  }

  /** The hourly budgets a starter pick spends (limits.ts starterHourlyChecks). */
  starterHourlyChecks(sessionId: string, ip: string, roomId: string): Array<{ key: string; limit: number }> {
    return starterHourlyChecks(sessionId, ip, roomId);
  }

  /** Whether the room already holds this starter work as this kind, so a pick of it makes no new image. */
  async holdsStarter(roomId: string, found: FoundWork, kind: StarterKind): Promise<boolean> {
    return (await findRoomAsset(this.pool, roomId, Buffer.from(found.work.sha256, "hex"), kind)) !== null;
  }

  assertHourly(checks: Array<{ key: string; limit: number }>): void {
    const wait = this.hourly.retryAfter(checks);
    if (wait > 0) throw new AssetError(429, "rate_limited", { retryAfter: wait, closeConnection: true });
  }

  bodyLimits(kind: AssetKind) {
    const t = this.bodyTiming ?? {};
    return {
      maxBytes: KINDS[kind].maxUploadBytes,
      deadlineMs: t.deadlineMs ?? KINDS[kind].deadlineMs,
      minBytesPerSec: t.minBytesPerSec ?? 32 * 1024,
      graceMs: t.graceMs ?? 10_000,
      checkEveryMs: t.checkEveryMs,
    };
  }

  /**
   * Turns a received file into an asset of the room. The caller holds an
   * intake or outbound slot and a quota reservation (or, for a starter
   * pick, the work's key), and deletes `tempPath`.
   *
   * The same bytes as the same kind in the same room reuse the row: the
   * uploader is added to it, and the answer is built exactly as for a fresh
   * upload, so it shows neither who uploaded first nor when. A handout's
   * answer alone says `created`, whether this request made the row, so a
   * PDF upload deletes only the pages it made (docs/design/design-v1-pdf-handouts.md
   * 3.9). Only a DM uploads one, and a DM's library lists every handout
   * image already, so it tells the DM nothing new. Every other kind keeps
   * the answer that never shows a reuse (design 11.1).
   *
   * A reused row keeps its starter mark as it was: a starter pick of bytes
   * the room already holds as an upload leaves that row counted, as the
   * room paid for it, and an upload of a picked work's bytes leaves the
   * pick outside the quota.
   *
   * A video takes its own branch (#ingestVideo), and so does a sound (#ingestSound).
   */
  async ingest(input: IngestInput): Promise<UploadResult> {
    const { reservation, starter } = input;
    // The types already require one. Checked here too, since a row stored with neither would escape the quota unmarked.
    if (!reservation && !starter) throw new Error("an image is stored against a reservation or as a starter pick");
    if (input.kind === "video") return this.#ingestVideo(input);
    if (input.kind === "sound") return this.#ingestSound(input);
    const existing = await findRoomAsset(this.pool, input.roomId, input.sha256, input.kind);
    if (existing) return this.#reuse(existing, input);

    await sniffImage(input.tempPath);
    await this.assertFreeDisk();
    const variants = await this.queue.run(() => processImage(input.tempPath, input.kind, this.tmpDir), {
      background: input.background,
    });
    try {
      const total = variants.reduce((sum, v) => sum + v.bytes, 0);
      const write = () =>
        placeAndInsert(
          this.pool,
          this.assetDir,
          { roomId: input.roomId, sha256: input.sha256, kind: input.kind, uploaderIds: input.uploaderIds, variants, credit: input.credit, starter },
          PIPELINE,
        );
      const placed = reservation ? await reservation.commit(total, write) : await write();
      return withCreated(withHint(placed.view, input.nameHint), placed.created);
    } finally {
      // Placed variants were renamed away, so this only removes leftovers
      // (a refused commit, or copies dropped because the file existed).
      await removeFiles(variants.map((v) => v.path));
    }
  }

  /**
   * A video (docs/design/design-v1-animated-maps.md 10, Ingest): no sniff
   * for images and no sharp. The header check runs in the processing queue,
   * zeroing the temporary file in place, and that one file is placed as the
   * row's `full` variant. The row's hash is the upload's, and the zeroing is
   * deterministic, so the same bytes make the same file under one
   * VIDEO_PIPELINE. Refused whole while the server's switch is off, so no
   * upload or import stores one (D-261102-510).
   */
  async #ingestVideo(input: IngestInput): Promise<UploadResult> {
    if (!animatedMapsOn(this.config)) throw new AssetError(403, "video_off");
    if (input.starter) throw new Error("no starter work is a video");
    const existing = await findRoomAsset(this.pool, input.roomId, input.sha256, input.kind);
    if (existing) return this.#reuse(existing, input);

    await this.assertFreeDisk();
    const facts = await this.queue.run(() => checkVideo(input.tempPath), { background: input.background });
    const { size } = await stat(input.tempPath);
    const variants = [{ name: "full" as const, path: input.tempPath, width: facts.widthPx, height: facts.heightPx, bytes: size }];
    const write = () =>
      placeAndInsert(this.pool, this.assetDir, { roomId: input.roomId, sha256: input.sha256, kind: "video", uploaderIds: input.uploaderIds, variants, video: facts }, VIDEO_PIPELINE);
    const placed = await input.reservation!.commit(size, write);
    return withCreated(placed.view, placed.created);
  }

  /**
   * A sound (docs/design/design-v1-sound.md 7.2): no sharp and no decoder.
   * The frame walk runs in a worker from the processing queue (audio/check.ts),
   * and the upload itself is placed as the row's one `full` variant, so the
   * same bytes make the same file under one SOUND_PIPELINE and reuse the
   * row, and two sounds may name one file. The commit checks the quota's
   * headroom again (quota.ts). Refused whole while the server's switch is
   * off, so no upload or import stores one (D-261102-513).
   */
  async #ingestSound(input: IngestInput): Promise<UploadResult> {
    if (!roomSoundOn(this.config)) throw new AssetError(403, "sound_off");
    if (input.starter) throw new Error("no starter work is a sound");
    const existing = await findRoomAsset(this.pool, input.roomId, input.sha256, input.kind);
    if (existing) return this.#reuse(existing, input);

    await this.assertFreeDisk();
    const audio = await this.queue.run(() => checkSound(input.tempPath, this.soundCheck), { background: input.background });
    const { size } = await stat(input.tempPath);
    const variants = [{ name: "full" as const, path: input.tempPath, width: 0, height: 0, bytes: size }];
    const write = () =>
      placeAndInsert(this.pool, this.assetDir, { roomId: input.roomId, sha256: input.sha256, kind: "sound", uploaderIds: input.uploaderIds, variants, audio }, SOUND_PIPELINE);
    const placed = await input.reservation!.commit(size, write);
    return withCreated(placed.view, placed.created);
  }

  /**
   * Copies a starter work's shipped file into the room as an image of
   * `kind` (docs/design/design-v1-starter-art.md 5), with the catalog's credit and
   * the work's key as the row's starter mark, outside the room's quota. The
   * caller has checked the kind is among the work's uses and holds an
   * intake slot, or is a room import.
   *
   * The copy is hashed as it is made and must be the catalog's SHA-256: a
   * shipped file that changed must never be stored under its work's mark,
   * where an export would vouch for it. A work the room already holds as
   * this kind is answered from its row, with no copy: its bytes are the
   * catalog's by their hash, and a DM's such pick spends no hourly budget,
   * so it must cost the server no file read either. The answer describes
   * the pick whether the row was made now or reused, so it never shows a
   * reuse (design 11.1).
   *
   * `queueWhenHeld`, for a player's pick: a held work still takes a turn in
   * the processing queue, as a fresh copy's encode does, so it waits behind
   * the same jobs and meets the same full queue's refusal, and neither
   * tells the player the room held it.
   */
  async ingestStarter(input: { roomId: string; uploaderIds: readonly string[]; found: FoundWork; kind: StarterKind; background?: boolean; queueWhenHeld?: boolean }): Promise<StarterResult> {
    const { work } = input.found;
    // A credit the listing could not read would be stored and then never shown, and the license asks for it.
    const credit = assetCreditSchema.safeParse(starterAssetCredit(input.found));
    if (!credit.success) throw new StarterWorkError(`the credit of starter work ${work.key} does not read as an asset credit`);
    const sha256 = Buffer.from(work.sha256, "hex");
    // A work the room holds as this kind already: the row is these bytes, so the shipped file is neither read nor hashed again.
    const existing = await findRoomAsset(this.pool, input.roomId, sha256, input.kind);
    if (existing && input.queueWhenHeld) await this.queue.run(async () => undefined, { background: input.background });
    const result = existing
      ? await this.#reuse(existing, { uploaderIds: input.uploaderIds, credit: credit.data })
      : await this.#copyStarter(input, credit.data);
    const grid = result.kind === "map" ? starterGrid(work, result.width) : undefined;
    return { ...result, ...grid, credit: credit.data, starter: work.key, sha256: work.sha256.toLowerCase() };
  }

  /** A shipped work's file copied to the side, checked against the catalog's hash as it is copied, then ingested as a starter pick. */
  async #copyStarter(input: { roomId: string; uploaderIds: readonly string[]; found: FoundWork; kind: StarterKind; background?: boolean }, credit: AssetCredit): Promise<UploadResult> {
    const { work } = input.found;
    const source = starterFilePath(this.starter.root, work.file);
    const temp = tempFile(this.tmpDir, "intake");
    try {
      const digest = await copyHashing(source, temp);
      if (digest.toString("hex") !== work.sha256.toLowerCase()) throw new StarterWorkError(`the shipped file of starter work ${work.key} is not the one the catalog pins`);
      return await this.ingest({
        roomId: input.roomId,
        uploaderIds: input.uploaderIds,
        kind: input.kind,
        tempPath: temp,
        sha256: digest,
        starter: work.key,
        credit,
        background: input.background,
      });
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  /**
   * The answer for bytes the room holds as this kind already: the uploader
   * gains the row, so a player keeps read access to what they added, a
   * credit fills a row that had none, and the answer is built as a new
   * row's, so it never shows the reuse (design 11.1).
   */
  async #reuse(existing: AssetRow, input: { uploaderIds: readonly string[]; credit?: AssetCredit; nameHint?: string }): Promise<UploadResult> {
    await addUploaders(this.pool, existing.id, input.uploaderIds);
    if (input.credit) await addCredit(this.pool, existing.id, input.credit);
    return withCreated(withHint(toView(existing), input.nameHint), false);
  }
}

/**
 * `created` on a handout's, a video's or a sound's answer only
 * (AssetService.ingest): a failed PDF or map upload deletes only what it
 * made (docs/design/design-v1-animated-maps.md 4.1). Each is a DM-only kind,
 * whose rows the DM's library or the room's sounds name already.
 */
function withCreated(result: UploadResult, created: boolean): UploadResult {
  return result.kind === "handout" || result.kind === "video" || result.kind === "sound" ? { ...result, created } : result;
}

function withHint(view: ReturnType<typeof toView>, nameHint: string | undefined): UploadResult {
  if (view.kind !== "map") return view;
  const { squares, hexes } = nameGrid(nameHint, view.width, view.height);
  if (squares === undefined && hexes === undefined) return view;
  return { ...view, ...(squares === undefined ? {} : { cellPx: squares }), ...(hexes === undefined ? {} : { hexCellPx: hexes }) };
}
