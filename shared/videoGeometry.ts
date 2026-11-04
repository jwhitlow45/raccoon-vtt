import type { VideoFacts, VideoTurn } from "./model.ts";

/**
 * How a video's picture is turned, mirrored and stretched
 * (docs/design/design-v1-video-turns.md 4.1, 4.2 and 6). The header check
 * reads a file's geometry with these rules and rewrites the file plain, and
 * the facts keep what the file asked for, so the app draws it the same way
 * in every browser. Every rule is exact and in integers: anything outside
 * them is refused, never clamped (section 10).
 *
 * This module imports nothing at run time, so shared/limits.ts can read
 * `drawnSize` without a cycle. The rule that also needs the caps,
 * `videoGeometryProblem`, lives there for the same reason.
 */

/** What a video's facts carry beyond its coded size. Absent fields are plain. */
export type VideoGeometry = Pick<VideoFacts, "turn" | "mirror" | "displayWidthPx">;

/** The fields `drawnSize` and the shape rule read. */
export type VideoShape = Pick<VideoFacts, "widthPx" | "heightPx" | "turn" | "displayWidthPx">;

/** One of the eight square orientations: a clockwise turn, then a left-to-right mirror. */
export type VideoOrientation = { turn: 0 | VideoTurn; mirror: boolean };

/** A term of a matrix row's translation: zero, or `tkhd`'s own width or height. */
export type ShiftTerm = "0" | "W" | "H";

/**
 * One row of 4.1's table. A display point is (a·x + c·y + tx, b·x + d·y + ty)
 * (ISO 14496-12 8.3.2), with a to d in units of 0x10000. `shift` is the one
 * translation other than (0, 0) the row may carry: the one that keeps the
 * picture in the positive quadrant, as Apple writes it. Android writes
 * (0, 0), which browsers read the same way since they ignore translation.
 */
export type VideoMatrixRow = VideoOrientation & { a: -1 | 0 | 1; b: -1 | 0 | 1; c: -1 | 0 | 1; d: -1 | 0 | 1; shift: readonly [ShiftTerm, ShiftTerm] | null };

export const VIDEO_MATRIX_ROWS: readonly VideoMatrixRow[] = [
  { a: 1, b: 0, c: 0, d: 1, turn: 0, mirror: false, shift: null },
  { a: 0, b: 1, c: -1, d: 0, turn: 90, mirror: false, shift: ["H", "0"] },
  { a: -1, b: 0, c: 0, d: -1, turn: 180, mirror: false, shift: ["W", "H"] },
  { a: 0, b: -1, c: 1, d: 0, turn: 270, mirror: false, shift: ["0", "W"] },
  { a: -1, b: 0, c: 0, d: 1, turn: 0, mirror: true, shift: ["W", "0"] },
  { a: 0, b: 1, c: 1, d: 0, turn: 90, mirror: true, shift: null },
  { a: 1, b: 0, c: 0, d: -1, turn: 180, mirror: true, shift: ["0", "H"] },
  { a: 0, b: -1, c: -1, d: 0, turn: 270, mirror: true, shift: ["H", "W"] },
];

const UNIT = 0x10000;
const W_ONE = 0x40000000;

/** A 32-bit field as a parser reads it, signed or unsigned, so the bit tricks below cannot wrap a larger number onto a row. */
function isWord(n: number): boolean {
  return Number.isInteger(n) && n >= -0x8000_0000 && n < 0x1_0000_0000;
}

/** The row that draws an orientation. */
export function matrixRow(orientation: VideoOrientation): VideoMatrixRow {
  return VIDEO_MATRIX_ROWS.find((row) => row.turn === orientation.turn && row.mirror === orientation.mirror)!;
}

/** The orientation a video's facts ask for: plain when they carry none. */
export function orientationOf(facts: Pick<VideoFacts, "turn" | "mirror">): VideoOrientation {
  return { turn: facts.turn ?? 0, mirror: facts.mirror === true };
}

/** An orientation as the facts' fields, with the plain parts left out. */
export function orientationFacts(orientation: VideoOrientation): Pick<VideoFacts, "turn" | "mirror"> {
  return { ...(orientation.turn !== 0 ? { turn: orientation.turn } : {}), ...(orientation.mirror ? { mirror: true as const } : {}) };
}

/** A row's positive-quadrant translation for a picture `w` by `h` before the turn, in whatever unit `w` and `h` are given. */
export function rowShift(row: VideoMatrixRow, w: number, h: number): [number, number] {
  const term = (t: ShiftTerm) => (t === "W" ? w : t === "H" ? h : 0);
  return row.shift ? [term(row.shift[0]), term(row.shift[1])] : [0, 0];
}

/**
 * 4.1's matrix rule. `matrix` is the video `tkhd`'s nine values in file
 * order (a, b, u, c, d, v, tx, ty, w), signed or unsigned 32-bit as read,
 * and `tkhdWidth` and `tkhdHeight` its size in raw 16.16. The orientation,
 * or undefined for `video_geometry`.
 */
export function mp4Orientation(matrix: readonly number[], tkhdWidth: number, tkhdHeight: number): VideoOrientation | undefined {
  if (matrix.length !== 9 || ![...matrix, tkhdWidth, tkhdHeight].every(isWord)) return undefined;
  const [a, b, u, c, d, v, tx, ty, w] = matrix.map((value) => value | 0) as [number, number, number, number, number, number, number, number, number];
  if (u !== 0 || v !== 0 || w !== W_ONE) return undefined;
  const row = VIDEO_MATRIX_ROWS.find((r) => r.a * UNIT === a && r.b * UNIT === b && r.c * UNIT === c && r.d * UNIT === d);
  if (!row) return undefined;
  const at = [tx >>> 0, ty >>> 0];
  const shift = rowShift(row, tkhdWidth >>> 0, tkhdHeight >>> 0);
  const zero = at[0] === 0 && at[1] === 0;
  if (!zero && !(row.shift && at[0] === shift[0] && at[1] === shift[1])) return undefined;
  return { turn: row.turn, mirror: row.mirror };
}

/** Whether facts ask for nothing but the coded size, as every video stored before turns did. */
export function isPlainGeometry(geometry: VideoGeometry): boolean {
  return geometry.turn === undefined && geometry.mirror === undefined && geometry.displayWidthPx === undefined;
}

/** The geometry fields of a video's facts, in a fixed order, the plain ones left out. */
export function videoGeometryOf(facts: VideoGeometry): VideoGeometry {
  return {
    ...(facts.turn !== undefined ? { turn: facts.turn } : {}),
    ...(facts.mirror !== undefined ? { mirror: facts.mirror } : {}),
    ...(facts.displayWidthPx !== undefined ? { displayWidthPx: facts.displayWidthPx } : {}),
  };
}

/**
 * The size a video is drawn at, as it shows (6.2): its stretched width, or
 * its coded width, by its coded height, swapped for a quarter turn. The
 * still, the shape rule and every word naming the size read this.
 */
export function drawnSize(facts: VideoShape): { widthPx: number; heightPx: number } {
  const widthPx = facts.displayWidthPx ?? facts.widthPx;
  return facts.turn === 90 || facts.turn === 270 ? { widthPx: facts.heightPx, heightPx: widthPx } : { widthPx, heightPx: facts.heightPx };
}

/** The largest term a pixel shape or a WebM display size may hold (D-261102-899). */
export const GEOMETRY_TERM_MAX = 65_535;

function isTerm(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= GEOMETRY_TERM_MAX;
}

/**
 * The drawn width of a picture `codedWidthPx` wide whose pixels are `num`
 * to `den` (wide to tall), rounded half up, or undefined when the shape is
 * past 1:2 or 2:1 (4.1). In integers, so large terms stay exact. A result
 * equal to the coded width is square.
 */
export function stretchedWidthPx(codedWidthPx: number, num: number, den: number): number | undefined {
  if (![codedWidthPx, num, den].every((n) => Number.isSafeInteger(n) && n >= 1)) return undefined;
  const [w, n, d] = [BigInt(codedWidthPx), BigInt(num), BigInt(den)];
  if (2n * n < d || n > 2n * d) return undefined;
  return Number((2n * w * n + d) / (2n * d));
}

/** What 4.1's size rule reads from an MP4's video track. */
export type Mp4SizeFields = {
  /** The sample entry's size. */
  codedWidthPx: number;
  codedHeightPx: number;
  /** `tkhd`'s size in raw 16.16. */
  tkhdWidth: number;
  tkhdHeight: number;
  /** The sample entry's `pasp`, h:v as read, when it has one. */
  pasp?: { h: number; v: number } | undefined;
  /** `tkhd`'s size-as-aspect-ratio flag (0x8). */
  sizeIsAspectRatio: boolean;
};

/**
 * 4.1's size rule: the picture's drawn width before the turn (the coded
 * width when its pixels are square), or undefined for `video_geometry`.
 * `tkhd`'s height is the coded height exactly, since its size is before the
 * matrix. A non-square `pasp` takes `tkhd` at the coded width or within a
 * pixel of the stretched one (FFmpeg's MOV and MP4 modes). A square one
 * takes it only at the coded width, which Chromium would show square and
 * Gecko stretched. With no `pasp` the stretch is `tkhd`'s own.
 */
export function mp4DrawnWidth(f: Mp4SizeFields): number | undefined {
  const coded = f.codedWidthPx;
  if (!Number.isSafeInteger(coded) || coded < 1 || f.codedHeightPx < 1) return undefined;
  const plainWidth = coded * UNIT;
  if (f.tkhdHeight !== f.codedHeightPx * UNIT) return undefined;
  if (f.sizeIsAspectRatio && (f.tkhdWidth !== plainWidth || (f.pasp !== undefined && f.pasp.h !== f.pasp.v))) return undefined;
  if (f.pasp === undefined) return stretchedWidthPx(coded, f.tkhdWidth, plainWidth);
  const { h, v } = f.pasp;
  if (h === v) return f.tkhdWidth === plainWidth ? coded : undefined;
  if (!isTerm(h) || !isTerm(v)) return undefined;
  // Within a pixel of coded × h / v, in 16.16 and in integers: |tkhd·v − coded·h·0x10000| ≤ 0x10000·v.
  const off = BigInt(f.tkhdWidth) * BigInt(v) - BigInt(coded) * BigInt(h) * BigInt(UNIT);
  if (f.tkhdWidth !== plainWidth && (off < 0n ? -off : off) > BigInt(UNIT) * BigInt(v)) return undefined;
  return stretchedWidthPx(coded, h, v);
}

/** What 4.2's rule reads from a WebM's video track. A display element is absent when undefined. */
export type WebmSizeFields = { pixelWidth: number; pixelHeight: number; displayWidth?: number | undefined; displayHeight?: number | undefined };

/**
 * 4.2's rule: the picture's drawn width at its pixel height (the pixel
 * width when square, as a pure scale such as 5120 x 2880 for 2560 x 1440
 * is), or undefined for `video_geometry`. An absent display element takes
 * the pixel size.
 */
export function webmDrawnWidth(f: WebmSizeFields): number | undefined {
  const { pixelWidth: pw, pixelHeight: ph } = f;
  if (![pw, ph].every((n) => Number.isSafeInteger(n) && n >= 1)) return undefined;
  if ((f.displayWidth !== undefined && !isTerm(f.displayWidth)) || (f.displayHeight !== undefined && !isTerm(f.displayHeight))) return undefined;
  const dw = f.displayWidth ?? pw;
  const dh = f.displayHeight ?? ph;
  return stretchedWidthPx(pw, dw * ph, dh * pw);
}

/**
 * A backup manifest entry's `geometry`, checked before the entry is read
 * (section 9, stage 1): the geometry when its shape is one this build
 * writes, or undefined, which skips the entry unread. Only the three fields,
 * `turn` one of the three, `mirror` true only and `displayWidthPx` a whole
 * number from 1 to 65535. Whether it suits the video is stage 2's to check,
 * against the parsed coded size (shared/limits.ts `videoGeometryProblem`).
 */
export function parseVideoGeometry(value: unknown): VideoGeometry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "turn" && key !== "mirror" && key !== "displayWidthPx")) return undefined;
  const { turn, mirror, displayWidthPx } = fields;
  if (turn !== undefined && turn !== 90 && turn !== 180 && turn !== 270) return undefined;
  if (mirror !== undefined && mirror !== true) return undefined;
  if (displayWidthPx !== undefined && !(typeof displayWidthPx === "number" && isTerm(displayWidthPx))) return undefined;
  return videoGeometryOf({ turn, mirror, displayWidthPx } as VideoGeometry);
}
