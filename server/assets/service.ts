import { mkdir, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pg from "pg";
import type { AssetCredit } from "#shared/protocol.ts";
import type { Config } from "../config.ts";
import { createEgress, type Egress } from "./egress.ts";
import { AssetError } from "./errors.ts";
import { KINDS, PIPELINE, cellPxHint, type AssetKind, type UploadResult } from "./kinds.ts";
import { WindowLimiter, hourlyChecks } from "./limits.ts";
import { ProcessingQueue, configureSharp, processImage, removeFiles, sniffImage } from "./process.ts";
import { RoomQuota, assertFreeDisk, roomStoredBytes, type Reservation } from "./quota.ts";
import { OpenverseSearch, openverseHttp, type OpenverseHttp } from "./openverse.ts";
import { ImageSearch, httpJson, type HttpJson } from "./serpapi.ts";
import { IntakeSlots, Semaphore, type SlotLimits } from "./slots.ts";
import { addCredit, addUploaders, findRoomAsset, placeAndInsert, toView, uploadedAssetIds } from "./store.ts";

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
   * running server's temporary files (docs/design-v1-dm-tools.md 3.19).
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
  now?: () => number;
};

export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export class AssetService {
  readonly pool: pg.Pool;
  readonly config: Config;
  readonly assetDir: string;
  readonly tmpDir: string;
  readonly minFreeBytes: number;
  readonly quota: RoomQuota;
  readonly slots: IntakeSlots;
  readonly outbound: Semaphore;
  readonly queue: ProcessingQueue;
  readonly hourly: WindowLimiter;
  readonly egress: Egress;
  readonly search: ImageSearch | null;
  /** Always there: Openverse needs no key (docs/design-v1-dm-tools.md 3.13). */
  readonly openverse: OpenverseSearch;
  readonly bodyTiming: AssetServiceOptions["bodyTiming"];
  #visibleAssets: VisibleAssetsFn;

  constructor(opts: AssetServiceOptions) {
    this.pool = opts.pool;
    this.config = opts.config;
    this.assetDir = resolve(opts.config.ASSET_DIR);
    this.tmpDir = opts.tmpDir ?? join(this.assetDir, "tmp");
    this.minFreeBytes = opts.minFreeBytes ?? MIN_FREE_BYTES;
    this.quota = new RoomQuota(opts.config.ROOM_QUOTA_MB * 1024 * 1024, (roomId) => roomStoredBytes(opts.pool, roomId));
    this.slots = new IntakeSlots(opts.slotLimits);
    this.outbound = new Semaphore(opts.maxOutboundFetches ?? 4);
    this.queue = new ProcessingQueue(opts.maxQueuedJobs ?? 8);
    this.hourly = new WindowLimiter(3600_000, opts.now);
    this.egress = opts.egress ?? createEgress(opts.config);
    this.bodyTiming = opts.bodyTiming;
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

  /** The hourly budgets an upload spends (limits.ts hourlyChecks). */
  hourlyChecks(sessionId: string, ip: string, roomId: string, kind?: AssetKind): Array<{ key: string; limit: number }> {
    return hourlyChecks(sessionId, ip, roomId, kind);
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
   * intake or outbound slot and a quota reservation, and deletes `tempPath`.
   *
   * The same bytes as the same kind in the same room reuse the row: the
   * uploader is added to it, and the answer is built exactly as for a fresh
   * upload, so it shows neither who uploaded first nor when. A handout's
   * answer alone says `created`, whether this request made the row, so a
   * PDF upload deletes only the pages it made (docs/design-v1-pdf-handouts.md
   * 3.9). Only a DM uploads one, and a DM's library lists every handout
   * image already, so it tells the DM nothing new. Every other kind keeps
   * the answer that never shows a reuse (design 11.1).
   */
  async ingest(input: {
    roomId: string;
    uploaderIds: readonly string[];
    kind: AssetKind;
    tempPath: string;
    sha256: Buffer;
    reservation: Reservation;
    nameHint?: string;
    background?: boolean;
    /** An Openverse image's credit, from the server's own search cache (openverse.ts creditForImport). */
    credit?: AssetCredit;
  }): Promise<UploadResult> {
    const existing = await findRoomAsset(this.pool, input.roomId, input.sha256, input.kind);
    if (existing) {
      await addUploaders(this.pool, existing.id, input.uploaderIds);
      if (input.credit) await addCredit(this.pool, existing.id, input.credit);
      return withCreated(withHint(toView(existing), input.nameHint), false);
    }

    await sniffImage(input.tempPath);
    await this.assertFreeDisk();
    const variants = await this.queue.run(() => processImage(input.tempPath, input.kind, this.tmpDir), {
      background: input.background,
    });
    try {
      const total = variants.reduce((sum, v) => sum + v.bytes, 0);
      const placed = await input.reservation.commit(total, () =>
        placeAndInsert(
          this.pool,
          this.assetDir,
          { roomId: input.roomId, sha256: input.sha256, kind: input.kind, uploaderIds: input.uploaderIds, variants, credit: input.credit },
          PIPELINE,
        ),
      );
      return withCreated(withHint(placed.view, input.nameHint), placed.created);
    } finally {
      // Placed variants were renamed away, so this only removes leftovers
      // (a refused commit, or copies dropped because the file existed).
      await removeFiles(variants.map((v) => v.path));
    }
  }
}

/** `created` on a handout's answer only (AssetService.ingest). */
function withCreated(result: UploadResult, created: boolean): UploadResult {
  return result.kind === "handout" ? { ...result, created } : result;
}

function withHint(view: ReturnType<typeof toView>, nameHint: string | undefined): UploadResult {
  if (view.kind !== "map") return view;
  const cellPx = cellPxHint(nameHint, view.width, view.height);
  return cellPx === undefined ? view : { ...view, cellPx };
}
