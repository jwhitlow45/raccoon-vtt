import { existsSync } from "node:fs";
import type pg from "pg";
import yazl from "yazl";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { saveOutcomeLedgerSchema } from "#shared/saveOutcomeContract.ts";
import type { RoomState, Scene, SoundFacts, Viewer } from "#shared/model.ts";
import { assetCreditSchema, type AssetCredit } from "#shared/protocol.ts";
import { STARTER_KEY } from "#shared/starter.ts";
import { videoGeometryOf, type VideoGeometry } from "#shared/videoGeometry.ts";
import { isAssetKind, isVariant, type AssetKind, type Variant } from "../assets/kinds.ts";
import { SOUND_MEDIA, isVideoContainer, soundFactsOfRow, variantPath, videoFactsOf, type AssetMedia } from "../assets/store.ts";

/**
 * The room export file (design 16.4): `room.json` with the committed state,
 * `assets.json` with a manifest, and every image variant, video and sound
 * under `assets/`. Only the log is filtered: whispers the exporting DM may
 * not read are left out. Import treats the manifest as untrusted and
 * re-processes each image and checks each video and sound again.
 *
 * Sounds go in unless the DM leaves them out (docs/design/design-v1-music.md
 * 6.7, D-261102-475), and never while the server's switch is off, since it
 * then serves no sound bytes: without them the zip holds no sound file and
 * no part of the state about sound.
 */
export const EXPORT_FORMAT = "raccoon-vtt-room";
export const EXPORT_FORMAT_VERSION = 1;
/**
 * 2 adds `starter` to an asset (docs/design/design-v1-starter-art.md 12.10). Import
 * reads 1 and 2 alike, a version 1 asset being an upload. A server from
 * before 2 ignores the field it does not know, and drops only the credit
 * of a pick, whose `changes` its strict credit schema refuses.
 *
 * The `video` kind and its `media`, the container its file is named by
 * (docs/design/design-v1-animated-maps.md 9.3), need no new version: a
 * server that does not know the kind skips it, so its import keeps the
 * stills. Nor do the `sound` kind, its `mp3` and its `audio`: a state that
 * holds sounds is a newer snapshot version, which an older server refuses.
 */
export const MANIFEST_VERSION = 2;

export type ManifestAsset = {
  id: string;
  sha256: string;
  kind: AssetKind;
  width: number;
  height: number;
  variants: Variant[];
  uploaders: string[];
  /** An Openverse image's or a starter pick's credit (docs/design/design-v1-dm-tools.md 3.13), which the import keeps after checking it. */
  credit?: AssetCredit;
  /** A starter pick's work key. The import keeps it only where its own catalog has that work with these bytes. */
  starter?: string;
  /** A video's container or a sound's mp3, which names its file: `assets/<sha256>-video-full.webm`, `.mp4` or `assets/<sha256>-sound-full.mp3`. */
  media?: AssetMedia;
  /** A sound's facts from its row. The import walks the file again and trusts its own. */
  audio?: SoundFacts;
  /**
   * How to draw a video's plain stored file, from its row: `{}` for a plain
   * one (docs/design/design-v1-video-turns.md 9). The import checks its
   * shape before reading the entry, and against the parsed coded size after.
   * A build from before turns ignores it, which no backup of then needed.
   */
  geometry?: VideoGeometry;
};

export type ExportManifest = { formatVersion: number; assets: ManifestAsset[] };

export type RoomExport = {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  roomId: string;
  seq: number;
  state: RoomState;
  /**
   * Members that ever held a DM grant (`room_dm_members`), which the state
   * does not carry: a co-DM that was removed as DM is a plain player there.
   * Import marks them again, or the restored room would let anyone with the
   * player password continue as one and read the whispers it had as DM.
   */
  dmMemberIds: string[];
};

/** An entry's name: WebP for an image, a video's own container (D-261102-454), and mp3 for a sound. */
export function assetFileName(sha256: string, kind: AssetKind, variant: Variant, media?: AssetMedia | null): string {
  const ext = kind === "sound" ? SOUND_MEDIA : kind === "video" && isVideoContainer(media) ? media : "webp";
  return `assets/${sha256}-${kind}-${variant}.${ext}`;
}

/**
 * The state with no part about sound (docs/design/design-v1-music.md 6.7):
 * an empty library, no playlist, silence, no scene's sound and the names
 * switch off. A collection the state does not hold stays absent, as it is
 * in a room from before sound, so this never adds one. Only DM devices play
 * stays as it was (docs/design/design-v1-sound-dm-only.md 7): it holds no
 * file and nothing hidden, and it still keeps the built-in effects off
 * players' devices in a room without sound files, so no backup or import
 * drops the DM's choice.
 */
export function withoutSound(state: RoomState): RoomState {
  const { soundNames: _names, ...settings } = state.meta.settings;
  const scenes: Record<string, Scene> = {};
  for (const [id, scene] of Object.entries(state.scenes)) {
    const { sound: _sound, ...kept } = scene;
    scenes[id] = kept;
  }
  return {
    ...state,
    ...("sounds" in state ? { sounds: {} } : {}),
    ...("playlists" in state ? { playlists: {} } : {}),
    ...("playing" in state ? { playing: null } : {}),
    meta: { ...state.meta, settings },
    scenes,
  };
}

/** Whether an export carries sounds: the DM's choice, and never while the server's switch is off. */
export type ExportChoice = { sounds: boolean };

/**
 * The state as the export carries it: everything, with whispers the DM is
 * not party to removed, and without the record of the running turn's
 * reminders (RoomState.reminded), which belongs to that turn and which the
 * import would leave behind anyway. Without sounds, nothing about sound.
 */
export function exportableState(state: RoomState, dm: Viewer, choice: ExportChoice = { sounds: true }): RoomState {
  const log = state.log.filter((e) => e.kind !== "whisper" || e.from === dm.memberId || e.to?.includes(dm.memberId) === true);
  const { reminded: _reminded, ...rest } = state;
  const kept = { ...rest, log };
  return choice.sounds ? kept : withoutSound(kept);
}

type AssetRow = {
  id: string;
  sha256: Buffer;
  kind: string;
  pipeline: number;
  width: number;
  height: number;
  variants: string[];
  uploaders: string[] | null;
  credit: unknown;
  starter: string | null;
  media: string | null;
  video: unknown;
  audio: unknown;
};

/** Whether a row goes in the zip: a kind this server knows, a video with its container, and a sound with its facts when sounds go. */
function exported(r: AssetRow, choice: ExportChoice): boolean {
  if (!isAssetKind(r.kind)) return false;
  if (r.kind === "video") return isVideoContainer(r.media);
  if (r.kind === "sound") return choice.sounds && soundFactsOfRow({ kind: r.kind, media: r.media as AssetMedia | null, audio: r.audio }) !== undefined;
  return true;
}

export async function roomManifest(pool: pg.Pool, roomId: string, choice: ExportChoice = { sounds: true }): Promise<{ manifest: ExportManifest; rows: AssetRow[] }> {
  const { rows: all } = await pool.query<AssetRow>(
    `select a.id, a.sha256, a.kind, a.pipeline, a.width, a.height, a.variants, a.credit, a.starter, a.media, a.video, a.audio,
       array(select u.member_id from asset_uploaders u where u.asset_id = a.id order by u.member_id) as uploaders
     from assets a where a.room_id = $1 order by a.created_at, a.id`,
    [roomId],
  );
  // The zip's files come from these rows too, so a row left out here leaves its file out.
  const rows = all.filter((r) => exported(r, choice));
  const assets: ManifestAsset[] = rows.map((r) => {
      const asset: ManifestAsset = {
        id: r.id,
        sha256: r.sha256.toString("hex"),
        kind: r.kind as AssetKind,
        width: r.width,
        height: r.height,
        variants: r.variants.filter(isVariant),
        uploaders: r.uploaders ?? [],
      };
      // The row's credit as stored, which only the server wrote. One that does not parse stays behind rather than travel unchecked.
      const credit = assetCreditSchema.safeParse(r.credit);
      if (r.credit !== null && credit.success) asset.credit = credit.data;
      if (r.starter !== null && STARTER_KEY.test(r.starter)) asset.starter = r.starter;
      if (r.kind === "video" && isVideoContainer(r.media)) {
        asset.media = r.media;
        // The stored file is plain, so how to draw it lives only in the row (docs/design/design-v1-video-turns.md 9, D-261102-856).
        const facts = videoFactsOf({ kind: r.kind, width: r.width, height: r.height, media: r.media, video: r.video });
        if (facts) asset.geometry = videoGeometryOf(facts);
      }
      if (r.kind === "sound") {
        asset.media = SOUND_MEDIA;
        const audio = soundFactsOfRow({ kind: r.kind, media: SOUND_MEDIA, audio: r.audio });
        if (audio) asset.audio = audio;
      }
      return asset;
    });
  return { manifest: { formatVersion: MANIFEST_VERSION, assets }, rows };
}

/**
 * Builds the zip. Files are added by path and read only as the output is
 * consumed, so a slow reader never makes the server hold the whole export.
 * A variant whose file is missing on disk is left out rather than failing
 * the whole export.
 */
export function buildExportZip(assetDir: string, data: { room: RoomExport; manifest: ExportManifest; rows: AssetRow[] }): yazl.ZipFile {
  const zip = new yazl.ZipFile();
  const mtime = new Date(data.room.exportedAt);
  zip.addBuffer(Buffer.from(JSON.stringify(data.room)), "room.json", { mtime });
  zip.addBuffer(Buffer.from(JSON.stringify(data.manifest)), "assets.json", { mtime });
  for (const row of data.rows) {
    if (!isAssetKind(row.kind)) continue;
    const media: AssetMedia | null = row.kind === "video" && isVideoContainer(row.media) ? row.media : row.kind === "sound" ? SOUND_MEDIA : null;
    if (row.kind === "video" && media === null) continue;
    const hex = row.sha256.toString("hex");
    for (const variant of row.variants) {
      if (!isVariant(variant)) continue;
      const path = variantPath(assetDir, hex, row.kind, variant, row.pipeline, media);
      if (!existsSync(path)) continue;
      // Already WebP, WebM, MP4 or MP3: compressing again only costs CPU.
      zip.addFile(path, assetFileName(hex, row.kind, variant, media), { compress: false, mtime });
    }
  }
  zip.end();
  return zip;
}

export function roomExport(roomId: string, seq: number, state: RoomState, dmMemberIds: Iterable<string>, now: Date = new Date()): RoomExport {
  if (state.saveOutcomes !== undefined) saveOutcomeLedgerSchema.parse(state.saveOutcomes);
  // Only members the state still holds: import could not map the others anyway.
  const marked = [...dmMemberIds].filter((id) => state.members[id] !== undefined).sort();
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: SNAPSHOT_VERSION,
    exportedAt: now.toISOString(),
    roomId,
    seq,
    state,
    dmMemberIds: marked,
  };
}
