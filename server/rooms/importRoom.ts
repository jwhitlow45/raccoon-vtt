import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import yauzl from "yauzl";
import { z } from "zod";
import { uuidv7 } from "#shared/ids.ts";
import { checkLimits, exploredReserve, LIMITS, NO_ROOM_TO_EXPLORE } from "#shared/limits.ts";
import { ringed } from "#shared/logRings.ts";
import { sightPiecesCheck } from "#shared/visionLimits.ts";
import { mapDiscoveryUpgrade, migrateSnapshot, needsMapDiscoveryUpgrade } from "#shared/migrate.ts";
import { assetCreditSchema } from "#shared/protocol.ts";
import { STARTER_KEY, type FoundWork, type StarterKind } from "#shared/starter.ts";
import type { Member, RoomState, SoundFacts, VideoFacts } from "#shared/model.ts";
import { withPitsCounted } from "#shared/rules/pitCount.ts";
import { splitCheck } from "#shared/rules/walls.ts";
import { animatedMapsOn, roomSoundOn } from "../config.ts";
import { isAssetError } from "../assets/errors.ts";
import { KINDS, isAssetKind, type AssetKind } from "../assets/kinds.ts";
import type { AssetService } from "../assets/service.ts";
import { StarterWorkError, isStarterKind, workForKind, type StarterCatalog } from "../assets/starter.ts";
import { SOUND_MEDIA, deleteUnreferencedFiles, isVideoContainer, roomFileKeys } from "../assets/store.ts";
import { tempFile } from "../assets/upload.ts";
import { markDmMembers } from "../auth/grants.ts";
import { HttpError } from "../auth/http.ts";
import { newRoomId } from "../auth/roomId.ts";
import { newMember, type NewRoom } from "../auth/roomRecords.ts";
import { randomToken, sha256 } from "../auth/tokens.ts";
import { withTx } from "../auth/tx.ts";
import { warnArchiveSkipped, type Logger } from "./actor.ts";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, assetFileName, withoutSound } from "./exportRoom.ts";
import type { RoomGateway } from "./gateway.ts";
import { archiveAdmitted, archiveLines } from "./persistence.ts";
import { lastLineSeq, refillMapVideos, refillSoundFacts, remapState, type ImportedAsset } from "./remap.ts";
import { layerCharge, MEMORY_CAP } from "./memorySize.ts";
import { checkWholeScenes, measuredStateBytes, MEMORY_FULL, memoryCapOf, memoryReserved, memoryReserves, sharesRoom } from "./sizeGuard.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Room import (design 16.4). Everything in the file is untrusted:
 *
 * - entries are counted and their inflated bytes are counted while reading,
 *   because central-directory sizes can lie;
 * - `room.json` goes through the snapshot migrations, the state schema and
 *   the room limits before anything is written;
 * - `assets.json` only says which file belongs to which old asset id. Each
 *   image is re-processed by the asset pipeline, which decides its kind's
 *   dimensions and variants and refuses anything that is not an image. A
 *   starter mark counts only where this server's own catalog has that work
 *   with the same bytes, and then the image comes from the shipped file.
 *   Each video goes through the same header check as an upload, and is
 *   skipped while the server's switch is off, which leaves its map's still
 *   (docs/design/design-v1-animated-maps.md 9.3). Each sound goes through
 *   the upload's frame walk against the quota, and a zip without sounds,
 *   or an import while the sound switch is off, keeps no part about sound
 *   (docs/design/design-v1-music.md 6.7). The room starts silent either way;
 * - every id is remapped, uploaders included.
 *
 * The room row is written first so asset rows have something to reference,
 * and the snapshot and the importer's grant last, so nothing can load or
 * join the room before it is whole. A failure in between deletes the row,
 * which cascades to the asset rows, and then the files nobody refers to.
 */
/*
 * An export writes every variant as an entry, two for each handout page, so
 * the entry and manifest caps leave room for a room at its handout pages
 * (docs/design/design-v1-pdf-handouts.md 3.6). What bounds an import is the body
 * cap, the inflated total and reading one entry at a time: an entry costs a
 * few hundred bytes in the entries map, so 10,000 cost a few MB.
 */
export const IMPORT_LIMITS = {
  bodyBytes: 95_000_000,
  entries: 10_000,
  /** Assets the manifest may list. */
  assets: 5_000,
  roomJsonBytes: 2 * LIMITS.stateBytes,
  manifestBytes: 2 * 1024 * 1024,
  /**
   * The newest op seq a file's log lines may name. The room's own ops count
   * on from it (lastLineSeq), so it stays far inside the integers a seq is
   * read as exactly, whatever a hand-made file says.
   */
  lineSeq: 2 ** 48,
} as const;

export type ImportForm = {
  /** Overrides the exported room name when given. */
  name?: string | undefined;
  playerPwHash: string;
  dmName: string;
  dmColor: string;
  createdIp: string | null;
};

export type ImportHooks = {
  /** Runs in the transaction that creates the room row, before any image is processed: the creation limits. */
  beforeImages?: (tx: pg.PoolClient, roomId: string) => Promise<void>;
  /** Runs in the transaction that writes the snapshot: the importer's session and DM grant. */
  afterImages?: (tx: pg.PoolClient, room: NewRoom) => Promise<void>;
};

export type ImportDeps = { pool: pg.Pool; assets: AssetService; gateway: RoomGateway; log: Logger };

/**
 * The new room, and how many of the file's sounds it left out, with their
 * places in playlists and scene sounds (docs/design/design-v1-music.md 6.7):
 * a file that failed the check or a length that did not fit its use, or
 * all of them from a zip without sounds or while the switch is off.
 */
export type ImportedRoom = NewRoom & { soundsLeftOut: number };

const manifestSchema = z.object({
  formatVersion: z.number().int(),
  assets: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        kind: z.string().max(16),
        uploaders: z.array(z.string().max(64)).max(50).optional(),
        // Checked on its own below, so a credit this server cannot read costs only the credit, never the image.
        credit: z.unknown().optional(),
        // Manifest version 2. Checked on its own below too, against this server's catalog.
        starter: z.unknown().optional(),
        // A video's container or a sound's mp3, which names its entry. The check reads the real one from the bytes.
        media: z.unknown().optional(),
        // A sound's facts from its row, never read: the walk finds the file's own.
        audio: z.unknown().optional(),
      }),
    )
    .max(IMPORT_LIMITS.assets),
});

const roomJsonSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  schemaVersion: z.number().int().min(1).max(1_000),
  state: z.unknown(),
  // Optional, because exports made before it existed lack it. See `everDmMembers` for those.
  dmMemberIds: z.array(z.string().min(1).max(64)).max(LIMITS.membersPerRoom).optional(),
});

/**
 * The most a file may inflate to: the room's quota, which bounds the assets
 * it can hold, plus room.json's and the manifest's caps
 * (docs/design/design-v1-animated-maps.md 6.3). Derived from ROOM_QUOTA_MB,
 * so the CLI's import, which has no body cap, takes a full room, where a
 * fixed 1 GiB refused one on a server with a larger quota.
 */
export function inflatedLimit(quotaBytes: number): number {
  return quotaBytes + IMPORT_LIMITS.roomJsonBytes + IMPORT_LIMITS.manifestBytes;
}

export class InflatedCounter {
  total = 0;
  readonly limit: number;

  constructor(limit: number = inflatedLimit(1024 * 1024 * 1024)) {
    this.limit = limit;
  }

  add(bytes: number): void {
    this.total += bytes;
    if (this.total > this.limit) throw new HttpError(413, "import_too_large");
  }
}

function safeName(name: string): boolean {
  return yauzl.validateFileName(name) === null && !name.includes("\\");
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number, counter: InflatedCounter): Promise<Buffer> {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    counter.add(chunk.length);
    if (size > maxBytes) {
      stream.destroy();
      throw new HttpError(413, "import_entry_too_large", { extra: { entry: entry.fileName } });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Streams one entry to a file, counting inflated bytes and hashing as it
 * goes. Returns the SHA-256.
 *
 * A pipeline listens for errors on every stream from the start. A write
 * error (a full disk, a file that cannot be opened) is an event, and one
 * with no listener ends the whole process, while a write waiting on `drain`
 * when the error comes would wait forever and keep the import slot.
 */
export async function entryToFile(zip: yauzl.ZipFile, entry: yauzl.Entry, path: string, maxBytes: number, counter: InflatedCounter): Promise<Buffer> {
  const stream: Readable = await zip.openReadStreamPromise(entry);
  const hash = createHash("sha256");
  let size = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        size += chunk.length;
        counter.add(chunk.length);
        if (size > maxBytes) throw new HttpError(413, "import_entry_too_large", { extra: { entry: entry.fileName } });
      } catch (err) {
        done(err as Error);
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(stream, measure, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  return hash.digest();
}

export async function importRoom(deps: ImportDeps, zipPath: string, form: ImportForm, hooks: ImportHooks = {}): Promise<ImportedRoom> {
  const zip = await yauzl.openPromise(zipPath, { autoClose: false }).catch(() => {
    throw new HttpError(400, "bad_zip");
  });
  try {
    if (zip.entryCount > IMPORT_LIMITS.entries) throw new HttpError(413, "too_many_entries");
    const entries = new Map<string, yauzl.Entry>();
    try {
      for await (const entry of zip.eachEntry()) {
        if (entries.size >= IMPORT_LIMITS.entries) throw new HttpError(413, "too_many_entries");
        if (!safeName(entry.fileName)) throw new HttpError(400, "bad_zip");
        entries.set(entry.fileName, entry);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "bad_zip");
    }
    const counter = new InflatedCounter(inflatedLimit(deps.assets.quota.quotaBytes));
    const roomEntry = entries.get("room.json");
    if (!roomEntry) throw new HttpError(400, "missing_room_json");
    const roomJson = parseJson(await readEntry(zip, roomEntry, IMPORT_LIMITS.roomJsonBytes, counter), "room.json");
    const header = roomJsonSchema.safeParse(roomJson);
    if (!header.success) throw new HttpError(400, "bad_room_json", { extra: { field: header.error.issues[0]?.path.join(".") ?? "" } });
    let migrated: unknown;
    try {
      migrated = migrateSnapshot(header.data.state, header.data.schemaVersion);
    } catch {
      throw new HttpError(400, "unsupported_schema_version");
    }
    const parsed = parseRoomState(migrated);
    if (!parsed.ok) throw new HttpError(400, "bad_room_json", { extra: { field: parsed.message.slice(0, 200) } });
    const dmMember = newMember(form.dmName, form.dmColor, "dm");
    const roomName = form.name ?? parsed.state.meta.name;
    // The importer joins as one more member, so the limits are checked on the
    // room as it will be stored. A full roster plus the importer would make a
    // room that refuses every op, deletions included.
    assertWithinLimits(finishState(withDiscoveryUpgrade(parsed.state, header.data.schemaVersion), dmMember, roomName));
    // Imported lines keep their ops' seqs, so the room starts at the newest of them and its own lines sort after them.
    const startSeq = lastLineSeq(parsed.state);
    if (startSeq > IMPORT_LIMITS.lineSeq) throw new HttpError(400, "bad_room_json", { extra: { field: "state.log" } });

    let manifest: z.infer<typeof manifestSchema> = { formatVersion: 1, assets: [] };
    const manifestEntry = entries.get("assets.json");
    if (manifestEntry) {
      const raw = manifestSchema.safeParse(parseJson(await readEntry(zip, manifestEntry, IMPORT_LIMITS.manifestBytes, counter), "assets.json"));
      if (!raw.success) throw new HttpError(400, "bad_manifest");
      manifest = raw.data;
    }
    // A zip without sounds, or this server's switch off: the room keeps nothing about sound. It starts silent either way.
    const keepsSounds = roomSoundOn(deps.assets.config) && manifest.assets.some((a) => a.kind === "sound");
    const incoming = silenced(keepsSounds ? parsed.state : withoutSound(parsed.state));

    const dmKey = randomToken();
    const roomId = await withTx(deps.pool, async (tx) => {
      let id = "";
      for (let attempt = 0; attempt < 5 && !id; attempt++) {
        const candidate = newRoomId();
        const { rowCount } = await tx.query(
          `insert into rooms (id, name, player_pw_hash, dm_key_hash, created_ip, imported_seq) values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
          [candidate, roomName, form.playerPwHash, sha256(dmKey), form.createdIp, startSeq],
        );
        if (rowCount === 1) id = candidate;
      }
      if (!id) throw new Error("could not find a free room id");
      if (hooks.beforeImages) await hooks.beforeImages(tx, id);
      return id;
    });

    try {
      // Members get their new ids first, because asset uploader rows are written during image processing.
      const memberIds = new Map(Object.keys(parsed.state.members).map((id) => [id, uuidv7()]));
      const assetIds = await importImages(deps, zip, entries, manifest, roomId, counter, memberIds);
      // Each video's and each sound's facts from the row its check just made, by its new id: the file's own are never trusted.
      const videoFacts = new Map([...assetIds.values()].flatMap((a) => (a.video ? [[a.id, a.video] as const] : [])));
      const soundFacts = new Map([...assetIds.values()].flatMap((a) => (a.audio ? [[a.id, a.audio] as const] : [])));
      // The remap carries the file's memory and marks under the new ids, and a file from before map discovery then takes
      // the upgrade step, so every scene it brings is marked played (docs/design/design-v1-map-discovery.md 5.5). The
      // refills then overwrite every map's and phase's video from its row (docs/design/design-v1-animated-maps.md 9.3), and
      // every sound's length from its row (docs/design/design-v1-music.md 6.7). The sound refill always runs after the remap,
      // which gives a sound whose file did not come through an id no row has, so the refill leaves it out with its places.
      const refilled = refillSoundFacts(refillMapVideos(remapState(incoming, { assets: assetIds, memberIds }), videoFacts), soundFacts);
      const remapped = finishState(withDiscoveryUpgrade(refilled.state, header.data.schemaVersion), dmMember, roomName);
      // The log's rings hold here as in any room, each ring its own newest (shared/logRings.ts), and the archive takes
      // the whole log, so Show older and a session's export reach every imported line.
      const state = { ...remapped, log: ringed(remapped.log, remapped.members) };
      // What is stored is checked as it is stored, not only as it arrived:
      // the remap and the importer's member change it.
      const final = parseRoomState(state);
      if (!final.ok) throw new HttpError(400, "bad_room_json", { extra: { field: final.message.slice(0, 200) } });
      assertWithinLimits(state);
      const room: ImportedRoom = { roomId, dmKey, dmMember, soundsLeftOut: soundsLeftOut(parsed.state, state) };
      // Every imported member arrives as a player, the old DMs too, and
      // those keep what they had as DM in the log. So they are marked like
      // any member that held a DM grant here, and nobody can continue as them.
      const oldDms = everDmMembers(parsed.state, header.data.dmMemberIds).flatMap((id) => {
        const mapped = memberIds.get(id);
        return mapped === undefined ? [] : [mapped];
      });
      // The archive takes the lines only while the shared volume is over its floor. Short of space the room still
      // comes, with the log its rings hold.
      const archive = await archiveAdmitted(() => deps.assets.archiveDiskOk());
      if (!archive) warnArchiveSkipped(deps.log, roomId, Date.now());
      await withTx(deps.pool, async (tx) => {
        await deps.gateway.createRoom(roomId, state, tx, startSeq);
        if (archive) await archiveLines(tx, roomId, remapped.log);
        await markDmMembers(tx, roomId, oldDms);
        if (hooks.afterImages) await hooks.afterImages(tx, room);
      });
      return room;
    } catch (err) {
      await discardRoom(deps, roomId).catch((cleanupErr: unknown) => {
        deps.log.error({ err: cleanupErr, roomId }, "failed import left a room row behind");
      });
      throw err;
    }
  } finally {
    zip.close();
  }
}

/** The room silent: an import never starts what the file was playing (D-261102-475). A state without the singleton keeps none. */
export function silenced(state: RoomState): RoomState {
  return "playing" in state ? { ...state, playing: null } : state;
}

/** The file's sounds the stored room does not hold: dropped by the switch, a zip without them, the walk or the use's length. */
export function soundsLeftOut(file: RoomState, stored: RoomState): number {
  return Object.keys(file.sounds ?? {}).length - Object.keys(stored.sounds ?? {}).length;
}

/**
 * A file's state with the map discovery upgrade step when the file is from
 * before it (docs/design/design-v1-map-discovery.md 5.5), after its migration, as
 * a stored room takes the step at load: the room is stored at today's
 * version, which loadRoom never upgrades. A newer file holds its own memory
 * and marks, which the remap carries, and the step would give a share mark
 * back to a scene that lost it.
 */
export function withDiscoveryUpgrade(state: RoomState, schemaVersion: number): RoomState {
  return needsMapDiscoveryUpgrade(schemaVersion) ? mapDiscoveryUpgrade(state) : state;
}

function parseJson(buffer: Buffer, name: string): unknown {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_zip", { extra: { entry: name } });
  }
}

/** The refusal of a file whose players' memory of a scene is larger than the room keeps it (docs/design/design-v1-map-discovery.md 5.5). */
export const MEMORY_TOO_LARGE = "Players' remembered map of a scene in this file is larger than a room keeps.";

/** The room limits of design 10.5 over the whole imported state. */
export function assertWithinLimits(state: RoomState): void {
  const over = (reason: string) => new HttpError(413, "over_room_limits", { extra: { reason } });
  const room = checkLimits(state);
  if (!room.ok) throw over(room.message);
  // The reducer keeps a room's waiting springings to its cap, and the size guard reserves exactly that many (docs/design/design-v1-traps.md 6.7).
  let waiting = 0;
  for (const trap of Object.values(state.traps ?? {})) waiting += trap.rig?.due?.length ?? 0;
  if (waiting > LIMITS.trapDuePerRoom) throw over(`at most ${LIMITS.trapDuePerRoom} trap springings can wait for the DM at once`);
  for (const sceneId of Object.keys(state.scenes)) {
    const scene = checkLimits(state, sceneId);
    if (!scene.ok) throw over(scene.message);
    // No op's limits step ever saw an imported scene's walls, so the split's caps are checked here
    // (docs/design/design-v1-maps-vision.md 2.1), with every pit's border counted ahead as the limits step
    // counts it, so no pit the room holds can open past them (docs/design/design-v1-traps.md 6.7).
    const counted = withPitsCounted(state, sceneId);
    const split = splitCheck(counted, sceneId);
    if (!split.ok) throw over(split.message);
    const sight = sightPiecesCheck(counted, sceneId);
    if (!sight.ok) throw over(sight.message);
  }
  const bytes = measuredStateBytes(state);
  if (bytes > LIMITS.stateBytes) throw over("the room state is over 8 MiB");
  // The player scene's explored layer must be able to grow to its full size (docs/design/design-v1-maps-vision.md 2.4).
  if (bytes + exploredReserve(state) > LIMITS.stateBytes) throw over(NO_ROOM_TO_EXPLORE);
  // And players' memory to its caps where a scene takes its whole cap: shares shrink to fit (docs/design/design-v1-map-discovery.md 5.5).
  if (bytes + exploredReserve(state) + memoryReserves(state).whole > LIMITS.stateBytes) throw over(MEMORY_FULL);
  // No measure reads memory, which counts at its caps, so each layer the file holds must lie within a whole cap, and hold
  // nothing where memory is not reserved (MD3-D-4). The layers that share the room's space count at what they hold, which
  // must fit beside the rest: not each at the share this state gives, since the import's remap grows the state a little and
  // an honest export at its share would then be refused (MD3-D-15). The load works the share out again, lower where the
  // file sits past it, and its first batch forgets what each layer holds above it (sizeGuard.ts takeShareLowered).
  const layers = new Set<string>();
  for (const c of Object.values(state.memory ?? {})) layers.add(JSON.stringify([c.sceneId, null]));
  for (const c of Object.values(state.memoryBy ?? {})) layers.add(JSON.stringify([c.sceneId, c.memberId ?? null]));
  let shared = 0;
  for (const key of [...layers].sort()) {
    const [sceneId, layer] = JSON.parse(key) as [string, string | null];
    const scene = state.scenes[sceneId];
    const charge = scene ? layerCharge(state, scene, layer) : Infinity;
    if (!scene || charge > memoryCapOf(state, scene, MEMORY_CAP, layer)) throw over(MEMORY_TOO_LARGE);
    if (memoryReserved(state, scene) && sharesRoom(state, scene, layer !== null)) shared += charge;
  }
  if (bytes + exploredReserve(state) + memoryReserves(state).whole + shared > LIMITS.stateBytes) throw over(MEMORY_TOO_LARGE);
  // Each scene as the ops on it will measure it, its sight and exploration reserved, so no imported scene refuses its first move.
  const scenes = checkWholeScenes(state);
  if (!scenes.ok) throw over(scenes.message);
}

/** An imported asset, with a video's or a sound's facts from the row its check made, for the refill after the remap. */
type ImportedMedia = ImportedAsset & { video?: VideoFacts; audio?: SoundFacts };

/**
 * Streams each image the manifest names through the asset pipeline, at the
 * back of the processing queue, under its kind's size cap, with quota
 * reserved and the free-disk guard checked before each one. Returns old
 * asset id to the new asset and its kind for everything that went through,
 * so the remap can hold each reference to the kind it takes. A video's
 * entry carries its new row's facts too, for the refill, which overwrites
 * every map's and phase's video facts from the rows the import made
 * (remap.ts refillMapVideos): the file's own are untrusted. A sound's
 * carries the facts its frame walk found, for the same reason
 * (docs/design/design-v1-music.md 6.7).
 *
 * A starter pick whose work this server ships with the same bytes comes
 * from the shipped file instead, as a pick here would
 * (docs/design/design-v1-starter-art.md 12.10). Every other image is an upload,
 * whatever its manifest says.
 */
async function importImages(
  deps: ImportDeps,
  zip: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  manifest: z.infer<typeof manifestSchema>,
  roomId: string,
  counter: InflatedCounter,
  memberIds: ReadonlyMap<string, string>,
): Promise<Map<string, ImportedMedia>> {
  const out = new Map<string, ImportedMedia>();
  const videosOn = animatedMapsOn(deps.assets.config);
  const soundsOn = roomSoundOn(deps.assets.config);
  for (const asset of manifest.assets) {
    if (out.has(asset.id) || !isAssetKind(asset.kind)) continue;
    const kind = asset.kind;
    // While the switch is off every video is skipped unread, and its map keeps the still (D-261102-510).
    if (kind === "video" && (!videosOn || !isVideoContainer(asset.media))) continue;
    // So is every sound while its own switch is off (D-261102-513).
    if (kind === "sound" && (!soundsOn || asset.media !== SOUND_MEDIA)) continue;
    const sha = asset.sha256.toLowerCase();
    // Uploaders are old member ids from the manifest: only members the room knows are kept, under their new ids.
    // Every imported member is a player here, and a player can upload no DM-only kind, so such an asset keeps
    // none: an uploader row is a player's read access (uploadedAssetIds), whatever the projection says.
    const uploaders = KINDS[kind].dmOnly
      ? []
      : (asset.uploaders ?? []).flatMap((m) => {
          const mapped = memberIds.get(m);
          return mapped === undefined ? [] : [mapped];
        });
    const entry = entries.get(assetFileName(sha, kind, "full", kind === "video" && isVideoContainer(asset.media) ? asset.media : null));
    const name = entry?.fileName ?? asset.id;
    const shipped = shippedWork(deps.assets.starter, asset.starter, sha, kind);
    const imported =
      (shipped ? await importShipped(deps, roomId, shipped, uploaders, name) : null) ??
      (entry ? await importFromZip(deps, zip, entry, roomId, counter, { kind, uploaders, credit: asset.credit }) : null);
    if (imported) out.set(asset.id, imported);
  }
  return out;
}

/**
 * Runs one image's import, skipping the image when it is refused: the
 * manifest is untrusted, so one bad image is expected input and does not
 * sink the room. Only the image's own steps run here. A room over its
 * quota, or a disk that is full, is no fault of one image, so those
 * refusals are checked before and refuse the whole import. So does the
 * quota's second look at commit, when an image's variants came out bigger
 * than its reservation and no longer fit (quota.ts commitReservation):
 * skipping that image would make a room whose scenes lost their art.
 */
async function skippingRefusals<T extends ImportedAsset>(deps: ImportDeps, roomId: string, name: string, run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (isAssetError(err) && err.code === "quota_exceeded") throw err;
    if (err instanceof Error && "status" in err && typeof (err as { status: unknown }).status === "number" && (err as { status: number }).status < 500) {
      deps.log.warn({ roomId, entry: name, err: err.message }, "import skipped an image");
      return null;
    }
    throw err;
  }
}

/**
 * The catalog's work for a manifest's starter mark, when this server ships
 * that work with the bytes the export had, as a kind among its uses. The
 * mark itself is untrusted text, so anything else is no work at all.
 */
function shippedWork(catalog: StarterCatalog, mark: unknown, sha: string, kind: AssetKind): { found: FoundWork; kind: StarterKind } | null {
  if (typeof mark !== "string" || !STARTER_KEY.test(mark) || !isStarterKind(kind)) return null;
  const found = workForKind(catalog, mark, kind);
  return found && found.work.sha256.toLowerCase() === sha ? { found, kind } : null;
}

/**
 * A starter pick copied from this server's own shipped file, with the
 * catalog's credit and its mark, outside the room's quota. A shipped work
 * that cannot be copied as the catalog describes it is logged, and the
 * image comes from the zip as an upload instead (null).
 */
async function importShipped(
  deps: ImportDeps,
  roomId: string,
  shipped: { found: FoundWork; kind: StarterKind },
  uploaders: readonly string[],
  name: string,
): Promise<ImportedAsset | null> {
  await deps.assets.assertFreeDisk();
  return skippingRefusals(deps, roomId, name, async () => {
    try {
      const result = await deps.assets.ingestStarter({ roomId, uploaderIds: uploaders, found: shipped.found, kind: shipped.kind, background: true });
      return { id: result.id, kind: result.kind };
    } catch (err) {
      if (!(err instanceof StarterWorkError)) throw err;
      deps.log.error({ err, roomId, work: shipped.found.work.key }, "import took a starter image from the zip, since its shipped work could not be copied");
      return null;
    }
  });
}

/**
 * An image or a video from the zip, as an upload of the room's, counted in
 * its quota. The quota is reserved before the asset's own steps, outside
 * the skip, so a room over its quota refuses the import, as it did before
 * starter picks.
 *
 * The reservation is the entry's checked size, not the kind's cap
 * (docs/design/design-v1-animated-maps.md 9.3, AM-ASTRA-22, AMQ-4): a 64 MiB
 * reservation for a 1 MiB video would refuse a near-full room's backup. The
 * size the central directory claims is untrusted, so an entry over its
 * kind's cap is skipped unread, the stream is cut at the claimed size, and
 * the commit's second look still holds the quota when an image's variants
 * come out bigger. No headroom applies: an import needs only the quota.
 */
async function importFromZip(
  deps: ImportDeps,
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  roomId: string,
  counter: InflatedCounter,
  asset: { kind: AssetKind; uploaders: readonly string[]; credit: unknown },
): Promise<ImportedMedia | null> {
  const cap = KINDS[asset.kind].maxUploadBytes;
  const size = entry.uncompressedSize;
  if (!Number.isSafeInteger(size) || size > cap) {
    deps.log.warn({ roomId, entry: entry.fileName }, "import skipped an entry over its kind's size cap");
    return null;
  }
  await deps.assets.assertFreeDisk();
  const reservation = await deps.assets.quota.reserve(roomId, size);
  const path = tempFile(deps.assets.tmpDir, "intake");
  try {
    return await skippingRefusals(deps, roomId, entry.fileName, async () => {
      const digest = await entryToFile(zip, entry, path, size, counter);
      const result = await deps.assets.ingest({
        roomId,
        uploaderIds: asset.uploaders,
        kind: asset.kind,
        tempPath: path,
        sha256: digest,
        reservation,
        background: true,
      });
      // An Openverse image keeps its credit (docs/design/design-v1-dm-tools.md 2.5), and so does a starter pick imported as an
      // upload, checked as bounded text like any of the file's text, since the file is untrusted. A credit that does not
      // parse is left behind with a warning.
      if (asset.credit !== undefined) {
        const credit = assetCreditSchema.safeParse(asset.credit);
        if (credit.success) await deps.pool.query("update assets set credit = $2 where id = $1", [result.id, JSON.stringify(credit.data)]);
        else deps.log.warn({ roomId, entry: entry.fileName }, "import left out an image's credit it could not read");
      }
      return { id: result.id, kind: result.kind, ...(result.video ? { video: result.video } : {}), ...(result.audio ? { audio: result.audio } : {}) };
    });
  } finally {
    reservation.release();
    await unlink(path).catch(() => undefined);
  }
}

/**
 * The exported members that ever held a DM grant: those the export lists,
 * former co-DMs included, and any still labeled DM. An export from before
 * the list existed cannot tell a former co-DM from a player, so every one
 * of its members counts as one. That costs its players a "continue as",
 * and they join as new members instead, where the other choice would hand
 * a former DM's whispers to anyone with the player password.
 */
function everDmMembers(state: RoomState, listed: readonly string[] | undefined): string[] {
  if (listed === undefined) return Object.keys(state.members);
  const ids = new Set(listed);
  for (const m of Object.values(state.members)) if (m.kind === "dm") ids.add(m.id);
  return [...ids];
}

/** The importer becomes the DM member; every imported member is a player until someone claims otherwise. */
function finishState(state: RoomState, dm: Member, name: string): RoomState {
  // Save drafts and their Undo stacks belong to the original room.
  const { saveOutcomes: _saveOutcomes, ...rest } = state;
  return { ...rest, meta: { ...state.meta, name }, members: { ...state.members, [dm.id]: dm } };
}

async function discardRoom(deps: ImportDeps, roomId: string): Promise<void> {
  const keys = await roomFileKeys(deps.pool, roomId);
  await deps.pool.query("delete from rooms where id = $1", [roomId]);
  await deleteUnreferencedFiles(deps.pool, deps.assets.assetDir, keys);
}
