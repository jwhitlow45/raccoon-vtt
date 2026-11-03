import { LIMITS, SOUND_LIMITS, VIDEO_LIMITS } from "#shared/limits.ts";
import type { SoundFacts, VideoFacts } from "#shared/model.ts";
import type { AssetCredit } from "#shared/protocol.ts";
import { HEX_R, HEX_S } from "#shared/rules/hex.ts";

/**
 * What each kind of asset becomes, in one table (design section 11.1). A
 * video is checked and kept as it came, never re-encoded (VIDEO_PIPELINE).
 *
 * PIPELINE is part of every file name. Any change to how a variant is made
 * (sizes, quality, encoder settings) must bump it, so a file made by an old
 * recipe is never served under a new one. Rows keep the pipeline they were
 * made with, so old files stay reachable until they are cleaned up.
 */
export const PIPELINE = 1;

/**
 * A video's pipeline, apart from the images': its one file is the upload
 * with metadata zeroed in place, named by the upload's hash, so any change
 * to what the header check keeps or zeroes must bump it
 * (docs/design/design-v1-animated-maps.md 10).
 */
export const VIDEO_PIPELINE = 1;

/**
 * A sound's pipeline (docs/design/design-v1-sound.md 7.2): its one file is
 * the upload itself, which the frame walk took whole, so any change to what
 * the walk takes must bump it.
 */
export const SOUND_PIPELINE = 1;

export const ASSET_KINDS = ["map", "token", "handout", "thumb", "video", "sound"] as const;
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
   * (docs/design/design-v1-maps-vision.md 3.3). One small variant. Players never
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
  /**
   * An animated map's video (docs/design/design-v1-animated-maps.md 9.1). One
   * variant, the checked upload itself, since nothing is ever decoded or
   * scaled. Players read it only while the phase showing names it.
   */
  video: {
    maxUploadBytes: VIDEO_LIMITS.fileBytes,
    deadlineMs: VIDEO_LIMITS.uploadDeadlineMs,
    variants: [{ name: "full", maxSide: VIDEO_LIMITS.maxSidePx }],
    dmOnly: true,
    playersRead: true,
  },
  /**
   * A sound file (docs/design/design-v1-sound.md 7.2): one variant, the
   * upload the frame walk took, never decoded. It has no sides, so its row's
   * width and height are 0. Players read it only while what plays names it.
   */
  sound: {
    maxUploadBytes: SOUND_LIMITS.fileBytes,
    deadlineMs: SOUND_LIMITS.uploadDeadlineMs,
    variants: [{ name: "full", maxSide: 0 }],
    dmOnly: true,
    playersRead: true,
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
  /** An Openverse image's or a starter pick's credit (docs/design/design-v1-dm-tools.md 3.13). */
  credit?: AssetCredit;
  /** A starter pick's work key, `<pack>/<work>` (docs/design/design-v1-starter-art.md 5). Absent for the room's own uploads. */
  starter?: string;
  /**
   * A starter pick's SHA-256 in hex, sent with `starter` only: the work a
   * key names can be rebuilt, so a client applies its catalog's grid to a
   * retained pick only when its catalog's file is this one.
   */
  sha256?: string;
  /** A DM's library only: whether the room's committed state names it (section 3.19). Absent when that cannot be known. */
  inUse?: boolean;
  /** A DM's library only: the stored size of all its variants, which deleting it frees from the room's quota, unless it is a starter pick, which never counted. */
  bytes?: number;
  /** A video's facts from its header check, so the Library shows its length and the DM's still pick checks its shape. Absent for an image. */
  video?: VideoFacts;
  /** A sound's facts from its frame walk, so the DM's browser sends `sound.create` for a length that fits its use. Absent but for a sound. */
  audio?: SoundFacts;
};

/**
 * `created`, on a handout's, a video's or a sound's answer only: whether
 * this upload made the row, rather than reusing the room's row of the same
 * bytes (docs/design/design-v1-pdf-handouts.md 3.9,
 * docs/design/design-v1-animated-maps.md 4.1).
 */
export type UploadResult = AssetView & { cellPx?: number; hexCellPx?: HexCellPx; created?: boolean };

/** A name's counts read as hexes, by the orientation they would fit (docs/design/design-v1-grid-detect.md 10.7). */
export type HexCellPx = { rows?: number; columns?: number };

/** What a file name's counts say, each as the cell size of the lattice they fit. */
export type NameGrid = { squares?: number; hexes?: HexCellPx };

/**
 * Owlbear's trick: a map file named like `crypt_30x20.jpg` is 30 cells wide
 * and 20 tall, so its cell size is known without the alignment tool. A
 * reading is kept only when both axes agree within 2%, because a name such
 * as `cave-2x3-final` is just as likely to mean something else. Counts above
 * the 200-cell scene limit are pixel sizes, not cell counts.
 *
 * The same counts are read three ways, as squares and as hexes on each
 * orientation, each by the span its own lattice gives (a hex map is as
 * wide as its columns plus the half hex its odd rows stand out, when it
 * has an odd row, and as tall as its rows' spacing plus the first hex's
 * overhang). Their shapes
 * differ by about 13%, so one reading agrees in practice, and a scene
 * takes the one for its own grid. A hex span must be the art's exact edge:
 * the scene's first hex stands at the image's corner, so a looser span
 * would claim a grid that is not lined up.
 */
export function nameGrid(name: string | undefined, width: number, height: number): NameGrid {
  if (!name) return {};
  const match = /(?:^|[^0-9])(\d{1,3})\s*[x×]\s*(\d{1,3})(?![0-9])/i.exec(name);
  if (!match) return {};
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols < 1 || rows < 1 || cols > 200 || rows > 200) return {};
  const fit = (acrossCells: number, downCells: number): number | undefined => {
    const byWidth = width / acrossCells;
    const byHeight = height / downCells;
    if (Math.abs(byWidth - byHeight) / byWidth > 0.02) return undefined;
    return Math.round(byWidth * 100) / 100;
  };
  const squares = fit(cols, rows);
  const onRows = fit(rows > 1 ? cols + 0.5 : cols, 2 * HEX_R + (rows - 1) * HEX_S);
  const onColumns = fit(2 * HEX_R + (cols - 1) * HEX_S, cols > 1 ? rows + 0.5 : rows);
  return {
    ...(squares === undefined ? {} : { squares }),
    ...(onRows === undefined && onColumns === undefined ? {} : { hexes: { ...(onRows === undefined ? {} : { rows: onRows }), ...(onColumns === undefined ? {} : { columns: onColumns }) } }),
  };
}

/** The squares reading of a name (`nameGrid`), which the upload's `cellPx` carries. */
export function cellPxHint(name: string | undefined, width: number, height: number): number | undefined {
  return nameGrid(name, width, height).squares;
}
