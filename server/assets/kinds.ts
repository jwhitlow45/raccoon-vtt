import { LIMITS } from "#shared/limits.ts";
import type { AssetCredit } from "#shared/protocol.ts";

/**
 * What each kind of image becomes, in one table (design section 11.1).
 *
 * PIPELINE is part of every file name. Any change to how a variant is made
 * (sizes, quality, encoder settings) must bump it, so a file made by an old
 * recipe is never served under a new one. Rows keep the pipeline they were
 * made with, so old files stay reachable until they are cleaned up.
 */
export const PIPELINE = 1;

export const ASSET_KINDS = ["map", "token", "handout", "thumb"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const VARIANTS = ["full", "mobile", "thumb"] as const;
export type Variant = (typeof VARIANTS)[number];

export type KindSpec = {
  /** Largest accepted upload body. */
  maxUploadBytes: number;
  /** How long the whole upload body may take to arrive. */
  deadlineMs: number;
  /** Longest side of each variant, in pixels. Order matters: `full` first, it is the canonical size. */
  variants: ReadonlyArray<{ name: Variant; maxSide: number }>;
  /**
   * Only DMs may add this kind. So only a DM can be its uploader, and a
   * player's own uploads never grant a player this kind (`uploadedAssetIds`).
   */
  dmOnly: boolean;
  /**
   * Whether a player may ever read this kind, when the room's projection
   * shows it to them. A thumbnail is the DM's alone, whatever names it.
   */
  playersRead: boolean;
};

const MiB = 1024 * 1024;

export const KINDS: Record<AssetKind, KindSpec> = {
  map: {
    maxUploadBytes: 32 * MiB,
    deadlineMs: 180_000,
    variants: [
      { name: "full", maxSide: 8192 },
      { name: "mobile", maxSide: 4096 },
      { name: "thumb", maxSide: 512 },
    ],
    dmOnly: true,
    playersRead: true,
  },
  token: {
    maxUploadBytes: 10 * MiB,
    deadlineMs: 60_000,
    variants: [
      { name: "full", maxSide: 512 },
      { name: "thumb", maxSide: 128 },
    ],
    dmOnly: false,
    playersRead: true,
  },
  handout: {
    maxUploadBytes: 10 * MiB,
    deadlineMs: 60_000,
    variants: [
      { name: "full", maxSide: 2048 },
      { name: "thumb", maxSide: 512 },
    ],
    dmOnly: true,
    playersRead: true,
  },
  /**
   * A scene's picture for the DM's Scenes panel, which a DM device renders
   * (docs/design-v1-maps-vision.md 3.3). One small variant. Players never
   * read one: no scene projection or other entity gives them its id, so it
   * is never in their visible set.
   */
  thumb: {
    maxUploadBytes: LIMITS.thumbUploadBytes,
    deadlineMs: 30_000,
    variants: [{ name: "full", maxSide: LIMITS.thumbMaxPx }],
    dmOnly: true,
    playersRead: false,
  },
};

/** The kinds a player may upload, and so the only kinds a player can be the uploader of. */
export const PLAYER_UPLOAD_KINDS: readonly AssetKind[] = ASSET_KINDS.filter((kind) => !KINDS[kind].dmOnly);

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

export function isVariant(value: unknown): value is Variant {
  return typeof value === "string" && (VARIANTS as readonly string[]).includes(value);
}

/** What the client learns about an asset. Never who uploaded it or when. */
export type AssetView = {
  id: string;
  kind: AssetKind;
  width: number;
  height: number;
  variants: Variant[];
  /** An Openverse image's credit (docs/design-v1-dm-tools.md 3.13). */
  credit?: AssetCredit;
  /** A DM's library only: whether the room's committed state names it (section 3.19). Absent when that cannot be known. */
  inUse?: boolean;
  /** A DM's library only: the stored size of all its variants, which deleting it frees from the room's quota. */
  bytes?: number;
};

export type UploadResult = AssetView & { cellPx?: number };

/**
 * Owlbear's trick: a map file named like `crypt_30x20.jpg` is 30 cells wide
 * and 20 tall, so its cell size is known without the alignment tool. The
 * suggestion is kept only when both axes agree within 2%, because a name such
 * as `cave-2x3-final` is just as likely to mean something else. Counts above
 * the 200-cell scene limit are pixel sizes, not cell counts.
 */
export function cellPxHint(name: string | undefined, width: number, height: number): number | undefined {
  if (!name) return undefined;
  const match = /(?:^|[^0-9])(\d{1,3})\s*[x×]\s*(\d{1,3})(?![0-9])/i.exec(name);
  if (!match) return undefined;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols < 1 || rows < 1 || cols > 200 || rows > 200) return undefined;
  const byWidth = width / cols;
  const byHeight = height / rows;
  if (Math.abs(byWidth - byHeight) / byWidth > 0.02) return undefined;
  return Math.round(byWidth * 100) / 100;
}
