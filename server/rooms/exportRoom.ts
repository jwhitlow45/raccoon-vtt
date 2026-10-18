import { existsSync } from "node:fs";
import type pg from "pg";
import yazl from "yazl";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { assetCreditSchema, type AssetCredit } from "#shared/protocol.ts";
import { STARTER_KEY } from "#shared/starter.ts";
import { isAssetKind, isVariant, type AssetKind, type Variant } from "../assets/kinds.ts";
import { variantPath } from "../assets/store.ts";

/**
 * The room export file (design 16.4): `room.json` with the committed state,
 * `assets.json` with a manifest, and every image variant under `assets/`.
 * Only the log is filtered: whispers the exporting DM may not read are left
 * out. Import treats the manifest as untrusted and re-processes each image.
 */
export const EXPORT_FORMAT = "raccoon-vtt-room";
export const EXPORT_FORMAT_VERSION = 1;
/**
 * 2 adds `starter` to an asset (docs/design-v1-starter-art.md 12.10). Import
 * reads 1 and 2 alike, a version 1 asset being an upload. A server from
 * before 2 ignores the field it does not know, and drops only the credit
 * of a pick, whose `changes` its strict credit schema refuses.
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
  /** An Openverse image's or a starter pick's credit (docs/design-v1-dm-tools.md 3.13), which the import keeps after checking it. */
  credit?: AssetCredit;
  /** A starter pick's work key. The import keeps it only where its own catalog has that work with these bytes. */
  starter?: string;
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

export function assetFileName(sha256: string, kind: AssetKind, variant: Variant): string {
  return `assets/${sha256}-${kind}-${variant}.webp`;
}

/** The state as the export carries it: everything, with whispers the DM is not party to removed. */
export function exportableState(state: RoomState, dm: Viewer): RoomState {
  const log = state.log.filter((e) => e.kind !== "whisper" || e.from === dm.memberId || e.to?.includes(dm.memberId) === true);
  return { ...state, log };
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
};

export async function roomManifest(pool: pg.Pool, roomId: string): Promise<{ manifest: ExportManifest; rows: AssetRow[] }> {
  const { rows } = await pool.query<AssetRow>(
    `select a.id, a.sha256, a.kind, a.pipeline, a.width, a.height, a.variants, a.credit, a.starter,
       array(select u.member_id from asset_uploaders u where u.asset_id = a.id order by u.member_id) as uploaders
     from assets a where a.room_id = $1 order by a.created_at, a.id`,
    [roomId],
  );
  const assets: ManifestAsset[] = rows
    .filter((r) => isAssetKind(r.kind))
    .map((r) => {
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
    const hex = row.sha256.toString("hex");
    for (const variant of row.variants) {
      if (!isVariant(variant)) continue;
      const path = variantPath(assetDir, hex, row.kind, variant, row.pipeline);
      if (!existsSync(path)) continue;
      // Already WebP: compressing again only costs CPU.
      zip.addFile(path, assetFileName(hex, row.kind, variant), { compress: false, mtime });
    }
  }
  zip.end();
  return zip;
}

export function roomExport(roomId: string, seq: number, state: RoomState, dmMemberIds: Iterable<string>, now: Date = new Date()): RoomExport {
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
