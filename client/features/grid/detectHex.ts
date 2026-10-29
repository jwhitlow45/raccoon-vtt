/**
 * Finding a hex grid drawn on a map image (docs/design-v1-grid-detect.md,
 * Hex grids). The square finder's method, turned to hexes: a drawn hex
 * grid is thin lines in three directions, each family of sides on lines
 * half a cell apart, each line drawn for one third of its length.
 *
 * The work is done on hex rows, pointed tops. Hex columns are the same
 * picture with x and y swapped, so their image is read transposed.
 *
 * 1. The thin-line filter of the square finder, across x for the upright
 *    sides and across y for the two sloped ones (a side 30 degrees off
 *    level is nearly level, and the filter reaches far enough to clear it).
 * 2. Three profiles, each the responses summed along one family's lines:
 *    by x for the upright sides, and by the distance along each sloped
 *    family's normal for the others, shared between the two nearest bins
 *    so a line keeps its place to a fraction of a pixel.
 * 3. A period and phase for each profile, as the square finder fits an
 *    axis. All three must be the same, half a cell, and their phases must
 *    meet at the corners and centers of one hex lattice: the phase of the
 *    upright sides is the difference of the sloped ones'.
 * 4. Those meeting points are hex centers and both kinds of corner, three
 *    lattices each a corner's distance from the next. Which is which
 *    shows along the lines: the sides are drawn between corners and
 *    nothing runs through a center. Each side of the hexes each choice
 *    predicts is looked at, and the choice whose sides are drawn wins.
 *    Lines that run on through the other two (a triangle grid, a square
 *    grid, ruled hatching) are not hexes, and that is the guard against
 *    squares.
 * 5. The upright sides must sit in the same place in the top and bottom
 *    halves of the image, or the grid is turned, which the app cannot
 *    follow. A map with no grid found gets a second look at half size,
 *    where lines too wide for the filter fit inside it, and a third at a
 *    quarter for lines wider still.
 *
 * Pure and synchronous, like `detectGrid`, with the same input.
 */
import type { HexOrient } from "#shared/rules/hex.ts";
import { HEX_R, HEX_S } from "#shared/rules/hex.ts";
import { boxSides, type CalBox } from "./calibrate.ts";
import { defaultStep, lineReach, MIN_CONFIDENCE, type GridDetection, type Pixels } from "./detect.ts";
import { autocorrelationPeaks, detrended, fourier, leastSquares, lineCenter, median, mod, noiseOf, peakNear, quantile, windowSums } from "./profile.ts";

type Point = { x: number; y: number };
type Polarity = "dark" | "light";

/** One family of hex sides: the upright ones, then the two sloped ones. */
export type HexFamily = {
  /** The distance between this family's lines, along their normal, px. Half a cell. */
  period: number;
  /** Where the lines fall along the normal, in [0, period). */
  phase: number;
  /** Lines found, and the lines the fit predicts from the first found to the last. */
  found: number;
  expected: number;
  /** Median line strength over the profile's noise between lines. */
  snr: number;
  /** Strength halfway or a third of the way between lines, against the lines beside them. */
  between: number;
  /** Root mean square distance of the lines found from the fitted ones, px. */
  rms: number;
};

export type HexFound = {
  found: true;
  orient: HexOrient;
  /** The distance between neighboring hex centers across the flats: the app's cell, px. */
  cellPx: number;
  /** The hex center nearest the image's middle, px. */
  center: Point;
  /** Line up grid's box on that hex and its six neighbors (HX-D12): 3 by 2.89 cells on hex rows, 2.89 by 3 on columns. */
  box: CalBox;
  /** 0 to 1, as the square finder's. */
  confidence: number;
  polarity: Polarity;
  /** The sides' strength against the same lines through the hexes: 1 for drawn hexes, 0 for lines that run on. */
  broken: number;
  /** The share of the hexes' sides that show: how much of the map the grid covers. Reported, not a check: a grid on the floors of a few rooms is still the grid. */
  coverage: number;
  /**
   * Whether every family's lean could be measured, so the turn and the
   * shape were checked. When a family shows too few lines in both halves
   * of the image (large hexes on a small map), they were not, and the
   * confidence is held to `UNCHECKED_MAX`: offered, never applied.
   */
  checked: boolean;
  families: [HexFamily, HexFamily, HexFamily];
};

export type HexNoGridReason =
  /** Too small to hold a hex grid this can see. */
  | "small"
  /** No repeating lines in the three directions at all. */
  | "none"
  /** The nearest fit failed a check. `failed` says which. */
  | "weak";

export type HexNoGrid = { found: false; reason: HexNoGridReason; failed?: string };

export type HexDetection = HexFound | HexNoGrid;

export type HexDetectOptions = {
  /** The scene's hexes: rows (pointed tops) or columns (flat tops). */
  orient: HexOrient;
  /** Every `step`th row feeds the profiles. */
  step?: number;
  /** Each fit looked at along its lines and how it fared, for the tests and the evaluation script. */
  onCandidate?: (c: { cellPx: number; confidence: number; failed: string | null }) => void;
  /** Each look as it starts, by how many times smaller than the image it reads it, for the tests. */
  onLook?: (k: 1 | 2 | 4) => void;
};

/** The smallest hex this looks for, px across the flats. The upright sides of one hex are a cell apart and must clear the line filter. */
export const MIN_HEX_CELL_PX = 12;
/** The app's largest scene side in cells: a finer grid could not be a scene. */
const MAX_CELLS = 200;
const MIN_LINES = 4;
const CAP = 64;
const LINE_SIGMA = 4;
const MIN_SNR = 5;
const MIN_FOUND = 0.6;
const HALF = 0.6;
/**
 * The three families' periods may differ by this fraction: lines of
 * three sizes are not one grid of hexes. Hexes out of shape are judged
 * by how their sides lean (MAX_STRETCH), which a profile's period only
 * blurs: a sloped line that leans moves along its normal as it crosses
 * the map, and its period over the whole map depends on the map's shape.
 */
const SAME_SIZE = 0.01;
/**
 * Hexes stretched or squeezed this much, across or down, answer no grid.
 * The app's hexes are regular, and a regular grid over hexes 1% out of
 * shape misses their lines by pixels across a map.
 */
const MAX_STRETCH = 0.01;
/**
 * The most confidence a find gets when its turn or its shape could not be
 * measured: medium, under findGrid.ts's HIGH_CONFIDENCE (0.6), so it is
 * only offered. Hexes 1.1% out of shape passed as 0.92 so before.
 */
export const UNCHECKED_MAX = 0.5;
/**
 * How far the three families' lines nearest the image's middle may miss
 * one crossing point, px, or this share of the period if larger. Measured
 * at the middle, so a slight difference in period cannot add up to a miss.
 */
const MEET_PX = 1.5;
const MEET_SHARE = 0.05;
const MAX_DRIFT_PX = 3;
const MAX_DRIFT_SHARE = 0.01;
/**
 * The drawn sides against the lines' other two thirds. Under 0.5 the
 * lines run on through the hexes, a pattern of three line directions
 * that is not hexes.
 */
const MIN_BROKEN = 0.5;
/**
 * How far off a third look's half measure may read a line's place, in its
 * frame's pixels. The lean compares lines in the frame's top and bottom
 * halves, half its height apart, so the stretch it gives is that far off
 * by this over half the height. Drawn thick-lined hexes squeezed 1 to 1.5%
 * on 760 to 1520 px maps read up to 1.2 / H under their stretch there,
 * and no regular grid came within 2 / H of the limit.
 */
const STRETCH_ERROR_PX = 1;
/**
 * The same margin from the lines themselves: this many standard errors
 * of the stretch, as the scatter of the lines' own leans gives it
 * (`leanOf`), when that is wider than STRETCH_ERROR_PX's (D-261029-151).
 */
const STRETCH_ERROR_SE = 2;
/**
 * The shortest half frame, px down, whose measure lets a third look's
 * find apply by itself (D-261029-151). On a shorter frame the half
 * measure can misread a stretch by more than its lines' scatter shows:
 * shifted hex columns 1.1% too tall read 0.2% on a 380 px frame. A find
 * there is only offered.
 */
const HALF_MEASURE_MIN_PX = 600;

/**
 * `q` is the detrended profile's positive part. `sums` holds it summed
 * over a line's width around each position, by the width's reach.
 * `offset` turns a bin into a distance along the family's normal, px.
 */
type Profile = {
  q: Float64Array;
  samples: number;
  offset: number;
  sums: Map<number, Float64Array>;
  /** The responses as summed, and each times its row's y: where down the frame a line's response lies. */
  raw: Float64Array;
  ys?: Float64Array;
};
/** One polarity's three profiles, over the whole image and over its top and bottom halves. */
type Profiles = { full: Profile[]; top: Profile[]; bottom: Profile[] };
/** Gray levels on hex rows, and how many of the image's pixels one of its pixels spans. */
/** `margin`: the frame measures a third look's find again, so a stretch near the limit is held as not measured (STRETCH_ERROR_PX, STRETCH_ERROR_SE). */
type Frame = { L: Uint8Array; W: number; H: number; d: number; dv: number; step: number; k: number; margin: boolean };
type Fit = { fams: [HexFamily, HexFamily, HexFamily]; polarity: Polarity; failed: string | null; score: number };

/**
 * The hex grid drawn on a map, or why none was found, for the scene's
 * orientation. A grid of the other orientation, or of squares, answers no
 * grid: its sides do not run in these three directions.
 */
export function detectHex(px: Pixels, options: HexDetectOptions): HexDetection {
  const rows = options.orient === "rows";
  const W = rows ? px.width : px.height;
  const H = rows ? px.height : px.width;
  if (!holdsHexes(W, H)) return { found: false, reason: "small" };
  const L = grayFrame(px, rows);
  options.onLook?.(1);
  const full = search(L, W, H, options.step, 1, options.onCandidate);
  if (full.found) return placed(full, 1, options.orient);
  // Lines wider than the line filter's reach show only as their two
  // edges. Half the size, they fit inside it, and a quarter of the size
  // lines wider still do (D-261029-51). Each look is a quarter of the work
  // of the one before, and comes only when every look before it found
  // nothing. A grid seen whole but turned or out of shape is given no
  // coarser chance.
  if (seenWhole(full)) return full;
  let frame = { L, w: W, h: H };
  let last = full;
  for (const k of [2, 4] as const) {
    const w = Math.floor(frame.w / 2);
    const h = Math.floor(frame.h / 2);
    if (!holdsHexes(w, h)) break;
    // Sides of different sizes at full and at half size is a grid drawn
    // out of shape, measured twice. A quarter of the size measures it less
    // finely, and a real map 3.6% too wide passed there. Thick lines can
    // read so once (the Trebia map does at full size), not at both sizes.
    if (k === 4 && differentSizes(full) && differentSizes(last)) break;
    const half = frame;
    frame = { L: halved(frame.L, frame.w, w, h), w, h };
    options.onLook?.(k);
    const look = search(frame.L, w, h, undefined, k, options.onCandidate);
    if (look.found) return k === 2 ? placed(look, 2, options.orient) : measuredAtHalf(half, look, lineReach(w, h), options.orient);
    if (seenWhole(look)) break;
    last = look;
  }
  return full;
}

/**
 * A third look's find, measured again at half size on its own lattice
 * (D-261029-55). A quarter of the size cannot measure a stretch of 1%,
 * so hexes 1.1% out of shape passed there as sure. At half size, with the
 * line filter's reach doubled to hold the lines the quarter saw, the
 * three families' sizes and the sides' lean are measured as finely as
 * the second look measures them, and only that period is tried, so the
 * wider reach finds nothing new. Measured so, the find stands as that
 * measure says, out of shape refused, and on a frame under
 * HALF_MEASURE_MIN_PX down only offered. A find the half size cannot see
 * is held to medium too: offered, never applied.
 */
function measuredAtHalf(half: { L: Uint8Array; w: number; h: number }, quarter: HexFound, quarterReach: number, orient: HexOrient): HexDetection {
  const again = search(half.L, half.w, half.h, undefined, 2, undefined, { reach: 2 * quarterReach, period: quarter.cellPx });
  if (again.found) return placed(half.h >= HALF_MEASURE_MIN_PX ? again : unchecked(again), 2, orient);
  if (seenWhole(again) || differentSizes(again)) return again;
  return placed(unchecked(quarter), 4, orient);
}

/** A find held to medium, as one whose turn or shape could not be measured. */
function unchecked(found: HexFound): HexFound {
  return { ...found, confidence: Math.min(found.confidence, UNCHECKED_MAX), checked: false };
}

function differentSizes(d: HexDetection): boolean {
  return !d.found && d.failed === "sides of different sizes";
}

function seenWhole(d: HexDetection): boolean {
  return !d.found && (d.failed === "lines turned" || d.failed === "hexes out of shape");
}

function holdsHexes(W: number, H: number): boolean {
  return Math.min(W, H) >= 64 && Math.min(W, H) / 3 >= Math.max(MIN_HEX_CELL_PX, Math.max(W, H) / MAX_CELLS);
}

/** Gray levels at half size, each pixel the mean of four. */
function halved(L: Uint8Array, W: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * W + 2 * x;
      out[y * w + x] = (L[i]! + L[i + 1]! + L[i + W]! + L[i + W + 1]! + 2) >> 2;
    }
  }
  return out;
}

/** A find on the frame, read `k` times larger and turned back to the image's own x and y. */
function placed(found: HexFound, k: number, orient: HexOrient): HexFound {
  const c = { x: found.center.x * k, y: found.center.y * k };
  const center = orient === "rows" ? c : { x: c.y, y: c.x };
  const cellPx = found.cellPx * k;
  const families = found.families.map((f) => ({ ...f, period: f.period * k, phase: f.phase * k, rms: f.rms * k })) as HexFound["families"];
  return { ...found, orient, cellPx, center, box: boxOf(center, cellPx, orient), families };
}

/**
 * One look at a frame of gray levels, hex rows: the find in the frame's
 * pixels, or why none. Limits in pixels are the image's, so on a frame `k`
 * times smaller they are `k` times tighter.
 */
function search(L: Uint8Array, W: number, H: number, stepOption: number | undefined, k: number, onCandidate: HexDetectOptions["onCandidate"], only?: { reach: number; period: number }): HexDetection {
  const minC = Math.max(MIN_HEX_CELL_PX, Math.max(W, H) / MAX_CELLS);
  const maxC = Math.min(W, H) / 3;
  const d = only?.reach ?? lineReach(W, H);
  // A side 30 degrees off level is 1 / cos 30 thicker down than across.
  const dv = Math.ceil(d / HEX_S);
  const step = Math.max(1, Math.floor(stepOption ?? defaultStep(W, H)));
  const frame: Frame = { L, W, H, d, dv, step, k, margin: only !== undefined };
  const all = profilesOf(frame);
  const minP = minC / 2;
  const maxP = maxC / 2;

  const middle = { x: W / 2, y: H / 2 };
  const pool: Fit[] = [];
  let nearest: Fit | null = null;
  let any = false;
  const tryAt = (p: number, pol: Polarity): Fit | null => {
    if (p < minP || p > maxP) return null;
    const fit = fitAt(all[pol].full, p, d, pol, k, middle);
    if (!fit) return null;
    any = true;
    if (fit.failed === null && fit.score >= MIN_CONFIDENCE) pool.push(fit);
    else if (!nearest || closeness(fit) > closeness(nearest)) nearest = fit;
    return fit;
  };
  for (const pol of ["dark", "light"] as const) {
    if (only) {
      tryAt(only.period, pol);
      continue;
    }
    const tried: number[] = [];
    for (const prof of all[pol].full) {
      for (const p of candidatePeriods(prof.q, minP, maxP, 6)) {
        if (tried.some((t) => Math.abs(t - p) / p < 0.01)) continue;
        tried.push(p);
        const fit = tryAt(p, pol);
        if (fit?.failed === "lines between the lines") for (const parts of [2, 3]) tryAt(fit.fams[0].period / parts, pol);
      }
    }
  }
  // Every fit that passed is looked at along its lines, since the look
  // lowers the confidence by how cleanly the sides break at the corners:
  // the surest before it need not be the surest after.
  let best: HexFound | null = null;
  let seenWhole: string | null = null;
  for (const fit of pool) {
    const found = confirm(frame, all[fit.polarity], fit);
    if (found === "lines turned" || found === "hexes out of shape") seenWhole ??= found;
    onCandidate?.(typeof found === "string" ? { cellPx: 2 * fit.fams[0].period * k, confidence: 0, failed: found } : { cellPx: found.cellPx * k, confidence: found.confidence, failed: null });
    if (typeof found !== "string") {
      if (!best || found.confidence > best.confidence) best = found;
    } else if (!nearest || closeness(fit) > closeness(nearest)) nearest = { ...fit, failed: found };
  }
  if (best) return best;
  if (seenWhole) return { found: false, reason: "weak", failed: seenWhole };
  if (!any) return { found: false, reason: "none" };
  const shown = nearest as Fit | null;
  return { found: false, reason: "weak", ...(shown ? { failed: shown.failed ?? "low confidence" } : {}) };
}

/** The image's gray levels, transposed for hex columns so the rest reads hex rows. */
function grayFrame(px: Pixels, rows: boolean): Uint8Array {
  const { width, height, data, channels: ch } = px;
  const out = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const p = i * ch;
      // Rec. 601 weights in fixed point, as the square finder reads them.
      const v = ch === 1 ? data[i]! : (77 * data[p]! + 150 * data[p + 1]! + 29 * data[p + 2]!) >> 8;
      out[rows ? i : x * height + y] = v;
    }
  }
  return out;
}

/**
 * The thin-line responses summed into each family's profile. Sloped
 * sides are binned by their distance along the family's normal, which
 * falls between whole pixels, so each response is shared between the two
 * bins either side and a line's centroid stays where it is.
 */
function profilesOf(f: Frame): Record<Polarity, Profiles> {
  const { L, W, H, d, dv, step } = f;
  const n1 = Math.ceil(0.5 * W + HEX_S * H) + 3;
  const half = () => [new Float64Array(W), new Float64Array(n1), new Float64Array(n1)] as const;
  const sums = () => [half(), half()] as const;
  const downs = () => [[new Float64Array(n1), new Float64Array(n1)], [new Float64Array(n1), new Float64Array(n1)]] as const;
  const ys = { dark: downs(), light: downs() };
  const raw = { dark: sums(), light: sums() };
  const add = (bins: Float64Array, u: number, v: number) => {
    const b = Math.floor(u);
    const t = u - b;
    bins[b]! += v * (1 - t);
    bins[b + 1]! += v * t;
  };
  const up = dv * W;
  for (let y = dv; y < H - dv; y += step) {
    const row = y * W;
    const lower = y < H / 2 ? 0 : 1;
    const sy = HEX_S * (y + 0.5);
    for (let x = d; x < W - d; x++) {
      const c = L[row + x]!;
      const a = L[row + x - d]! - c;
      const b = L[row + x + d]! - c;
      if (a > 0 && b > 0) raw.dark[lower][0][x]! += Math.min(a, b, CAP);
      else if (a < 0 && b < 0) raw.light[lower][0][x]! += Math.min(-a, -b, CAP);
      const e = L[row + x - up]! - c;
      const g = L[row + x + up]! - c;
      let v = 0;
      let pol: Polarity = "dark";
      if (e > 0 && g > 0) v = Math.min(e, g, CAP);
      else if (e < 0 && g < 0) {
        v = Math.min(-e, -g, CAP);
        pol = "light";
      }
      if (v === 0) continue;
      const hx = 0.5 * (x + 0.5);
      const to = raw[pol][lower];
      const down = ys[pol][lower];
      add(to[1], sy - hx + 0.5 * W, v);
      add(to[2], sy + hx, v);
      add(down[0], sy - hx + 0.5 * W, v * (y + 0.5));
      add(down[1], sy + hx, v * (y + 0.5));
    }
  }
  const rowsSampled = Math.ceil((H - 2 * dv) / step);
  // A sloped line's bin takes two pixels a row, from the rows its chord crosses.
  const sloped = (2 * Math.min(H, W / (2 * HEX_S))) / step;
  const samples = [rowsSampled, sloped, sloped];
  const offsets = [0.5, -0.5 * W, 0];
  const build = ([top, bottom]: ReturnType<typeof sums>, [topYs, bottomYs]: ReturnType<typeof downs>): Profiles => {
    const each = (k: number, bins: Float64Array, share: number) => prepare(bins, d, samples[k]! * share, offsets[k]!);
    const withYs = (prof: Profile, k: number, down: readonly Float64Array[]) => (k === 0 ? prof : { ...prof, ys: down[k - 1]! });
    return {
      full: [0, 1, 2].map((k) => each(k, top[k]!.map((v, i) => v + bottom[k]![i]!), 1)),
      top: [0, 1, 2].map((k) => withYs(each(k, top[k]!, 0.5), k, topYs)),
      bottom: [0, 1, 2].map((k) => withYs(each(k, bottom[k]!, 0.5), k, bottomYs)),
    };
  };
  return { dark: build(raw.dark, ys.dark), light: build(raw.light, ys.light) };
}

/** A profile detrended (profile.ts), with room for its sums over each line reach it is read at. */
function prepare(raw: Float64Array, d: number, samples: number, offset: number): Profile {
  return { q: detrended(raw, d), samples, offset, sums: new Map(), raw };
}

/** The profile summed over `w` bins either side of each position: a line's strength wherever it is centered. */
function summed(prof: Profile, w: number): Float64Array {
  const cached = prof.sums.get(w);
  if (cached) return cached;
  const s = windowSums(prof.q, w);
  prof.sums.set(w, s);
  return s;
}

/**
 * How far a line's response is looked for around it, by the period. The
 * profiles of hexes hold a line every half cell, so on small hexes the
 * line filter's reach would run one line into the next and leave no
 * space between them to measure the noise in.
 */
function reachFor(period: number, d: number): number {
  return Math.min(d, Math.max(1, Math.floor(period / 6)));
}

/** Periods where the profile's autocorrelation peaks, strongest first. */
function candidatePeriods(q: Float64Array, minP: number, maxP: number, keep: number): number[] {
  const peaks = autocorrelationPeaks(q, minP, maxP);
  // Every whole multiple of a period peaks about as high as the period
  // itself, so the strongest few can all be multiples. The shortest peaks
  // nearly as strong are kept too: the hexes' own size is among them.
  const top = peaks[0]?.v ?? 0;
  const shortest = peaks.filter((x) => x.v >= 0.5 * top).sort((x, y) => x.p - y.p).slice(0, 4);
  return [...new Set([...shortest, ...peaks.slice(0, keep)])].map((x) => x.p);
}

/** The signed distance from `v` to the nearest multiple of `m`. */
function wrap(v: number, m: number): number {
  return v - m * Math.round(v / m);
}

/** Theil-Sen, then least squares on the lines within a few median deviations of it. */
function lineFit(points: { k: number; c: number }[]): { period: number; phase: number; rms: number } {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) slopes.push((points[j]!.c - points[i]!.c) / (points[j]!.k - points[i]!.k));
  }
  const rough = median(slopes);
  const base = median(points.map((p) => p.c - rough * p.k));
  const residual = points.map((p) => Math.abs(p.c - base - rough * p.k));
  const limit = Math.max(1, 3 * 1.4826 * median(residual));
  const kept = points.filter((_, i) => residual[i]! <= limit);
  return leastSquares(kept.length >= MIN_LINES ? kept : points);
}

/** One family's lines near period `p0`, as the square finder fits an axis, or null when no line pattern is there. */
function fitFamily(prof: Profile, p0: number, reach: number): HexFamily | null {
  const { q } = prof;
  const d = reachFor(p0, reach);
  const s = summed(prof, d);
  const n = q.length;
  const span = Math.max(1, 0.006 * p0);
  const stride = Math.max(1e-4, (p0 * p0) / n / 4);
  let best = { p: p0, mag: -1, arg: 0 };
  for (let p = Math.max(2, p0 - span); p <= p0 + span; p += stride) {
    const f = fourier(q, p);
    if (f.mag > best.mag) best = { p, mag: f.mag, arg: f.arg };
  }
  if (best.mag <= 0) return null;
  let period = best.p;
  let phase = mod((-best.arg / (2 * Math.PI)) * period, period);
  const r = Math.max(1, Math.min(2 * d, Math.floor(0.15 * period)));
  let found: { k: number; c: number }[] = [];
  let strengths: { k: number; v: number }[] = [];
  let sigma = 0;
  let mu = 0;
  let rms = 0;
  for (let round = 0; round < 3; round++) {
    const k0 = Math.ceil((d - phase) / period);
    const k1 = Math.floor((n - 1 - d - phase) / period);
    if (k1 - k0 + 1 < MIN_LINES) return null;
    const noise = noiseOf(s, prof.samples, phase, period, r + d + 1, d);
    if (!noise) return null;
    ({ mu, sigma } = noise);
    strengths = [];
    found = [];
    for (let k = k0; k <= k1; k++) {
      const peak = peakNear(s, phase + k * period, r);
      const v = peak.v - mu;
      strengths.push({ k, v });
      if (v >= LINE_SIGMA * sigma) found.push({ k, c: lineCenter(q, peak.at, d) });
    }
    if (found.length < MIN_LINES) return null;
    const fit = lineFit(found);
    if (!(fit.period > 2)) return null;
    period = fit.period;
    phase = mod(fit.phase, period);
    rms = fit.rms;
  }
  const first = found[0]!.k;
  const last = found[found.length - 1]!.k;
  const inSpan = strengths.filter((x) => x.k >= first && x.k <= last);
  const strength = new Map(inSpan.map((x) => [x.k, Math.max(0, x.v)]));
  let between = 0;
  for (const parts of [2, 3]) {
    if (parts === 3 && period / 3 < 2 * (r + d)) continue;
    for (let j = 1; j < parts; j++) {
      const ratios: number[] = [];
      for (const x of inSpan) {
        const beside = (strength.get(x.k)! + (strength.get(x.k + 1) ?? 0)) / 2;
        if (!strength.has(x.k + 1) || beside < LINE_SIGMA * sigma) continue;
        ratios.push(Math.max(0, peakNear(s, phase + (x.k + j / parts) * period, r).v - mu) / beside);
      }
      if (ratios.length > 0) between = Math.max(between, quantile(ratios, 0.25));
    }
  }
  return {
    period,
    phase: mod(phase + prof.offset, period),
    found: found.length,
    expected: last - first + 1,
    snr: Math.min(1000, median(inSpan.map((x) => x.v)) / sigma),
    between,
    rms,
  };
}

/** Why one family fails, by the square finder's pass marks. `k` is how many image pixels a frame pixel spans. */
function familyFailure(f: HexFamily, k: number): string | null {
  if (f.snr < MIN_SNR) return "lines too faint";
  if (f.found / f.expected < MIN_FOUND) return "too many lines missing";
  if (f.between >= HALF) return "lines between the lines";
  if (f.rms > Math.max(1 / k, 0.03 * f.period)) return "lines not evenly spaced";
  return null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The square finder's confidence (`confidenceOf`), over the three families: the weakest family decides. */
function confidenceOf(fams: HexFamily[]): number {
  const snr = Math.min(...fams.map((f) => f.snr));
  const share = Math.min(...fams.map((f) => f.found / f.expected));
  const between = Math.max(...fams.map((f) => f.between));
  const rms = Math.max(...fams.map((f) => f.rms / f.period));
  const lines = Math.min(...fams.map((f) => f.found));
  return (
    clamp01((snr - MIN_SNR / 2) / 10) *
    clamp01((share - MIN_FOUND / 2) / (1 - MIN_FOUND / 2)) *
    clamp01((HALF - between) / (HALF - 0.2)) *
    clamp01(1 - rms / 0.03) *
    clamp01(lines / 8)
  );
}

/** Where each family's line nearest a point falls, along the family's normal, by its own period. */
function linesNear(fams: [HexFamily, HexFamily, HexFamily], at: Point): [number, number, number] {
  const [up, a, b] = fams;
  const near = (f: HexFamily, u: number) => f.phase + f.period * Math.round((u - f.phase) / f.period);
  const x0 = near(up, at.x);
  const u1 = near(a, HEX_S * at.y - 0.5 * x0);
  return [x0, u1, near(b, u1 + x0)];
}

/** The three families fitted at one period, and whether they make one hex lattice. */
function fitAt(full: Profile[], p: number, d: number, polarity: Polarity, k: number, middle: Point): Fit | null {
  const fams = full.map((prof) => fitFamily(prof, p, d));
  if (fams.some((f) => f === null)) return null;
  const [up, a, b] = fams as [HexFamily, HexFamily, HexFamily];
  const mean = (up.period + a.period + b.period) / 3;
  const same = Math.max(up.period, a.period, b.period) - Math.min(up.period, a.period, b.period) <= SAME_SIZE * mean;
  // The upright sides sit at x, and the sloped ones at y cos 30 -/+ x / 2:
  // the second less the first is x again. Lines that do not agree so do
  // not cross at the corners of one set of hexes.
  const [x0, u1, u2] = linesNear([up, a, b], middle);
  const meet = Math.abs(wrap(u2 - u1 - x0, mean)) <= Math.max(MEET_PX / k, MEET_SHARE * mean);
  const failed = !same ? "sides of different sizes" : !meet ? "sides do not meet as hexes" : (familyFailure(up, k) ?? familyFailure(a, k) ?? familyFailure(b, k));
  return { fams: [up, a, b], polarity, failed, score: failed ? 0 : confidenceOf([up, a, b]) };
}

function closeness(f: Fit): number {
  return Math.min(...f.fams.map((x) => x.snr)) * Math.min(...f.fams.map((x) => x.found / x.expected));
}

/**
 * How much one family's lines lean: for each line found in both the top
 * and the bottom half of the image, how far it moves along the family's
 * normal from one half to the other, over how far apart its two parts lie
 * down the image, px per px. The median over lines. Each line is compared
 * with itself, so an error in the fitted period cannot pass for a lean.
 * A sloped line's parts lie where its responses do, measured: a line is
 * drawn a third of its length, and where its sides fall in each half is
 * the art's, not the geometry's. Upright lines run the frame's height, so
 * their parts are half of it apart. Null when fewer than MIN_LINES lines
 * say. `se` is the median's standard error, from the lines' scatter
 * about it (1.4826 times their median deviation, over the root of their
 * count).
 */
function leanOf(first: Profile, second: Profile, fam: HexFamily, reach: number, H: number): { lean: number; se: number } | null {
  const d = reachFor(fam.period, reach);
  const r = Math.max(1, Math.min(2 * d, Math.floor(0.15 * fam.period)));
  const phase = fam.phase - first.offset;
  const lines = (half: Profile) => {
    const s = summed(half, d);
    const noise = noiseOf(s, half.samples, phase, fam.period, r + d + 1, d);
    const at = new Map<number, { c: number; y: number | null }>();
    if (!noise) return at;
    for (let k = Math.ceil((d - phase) / fam.period); phase + k * fam.period < s.length - d; k++) {
      const peak = peakNear(s, phase + k * fam.period, r);
      if (peak.v - noise.mu < LINE_SIGMA * noise.sigma) continue;
      const y = half.ys ? downOf(half.raw, half.ys, peak.at, d) : null;
      at.set(k, { c: lineCenter(half.q, peak.at, d), y });
    }
    return at;
  };
  const top = lines(first);
  const bottom = lines(second);
  const leans: number[] = [];
  for (const [k, above] of top) {
    const below = bottom.get(k);
    if (!below) continue;
    const apart = above.y === null || below.y === null ? H / 2 : below.y - above.y;
    // A line that barely reaches one half cannot say how it leans.
    if (apart >= 0.1 * H) leans.push((below.c - above.c) / apart);
  }
  if (leans.length < MIN_LINES) return null;
  const lean = median(leans);
  return { lean, se: (1.4826 * median(leans.map((l) => Math.abs(l - lean)))) / Math.sqrt(leans.length) };
}

/**
 * Where down the frame a line's responses lie, from the responses and
 * the responses times their rows' y: their mean over the line's width,
 * less the art's, which the bins either side of the line give.
 */
function downOf(raw: Float64Array, ys: Float64Array, at: number, d: number): number | null {
  let w = 0;
  let wy = 0;
  let bw = 0;
  let by = 0;
  let side = 0;
  for (let i = Math.max(0, at - 3 * d); i <= Math.min(raw.length - 1, at + 3 * d); i++) {
    if (Math.abs(i - at) <= d) {
      w += raw[i]!;
      wy += ys[i]!;
    } else if (Math.abs(i - at) > d + 1) {
      bw += raw[i]!;
      by += ys[i]!;
      side++;
    }
  }
  const scale = side > 0 ? (2 * d + 1) / side : 0;
  const lineW = w - bw * scale;
  return lineW > 0 ? (wy - by * scale) / lineW : null;
}

/**
 * A fit that passed, looked at along its lines: which of the three
 * lattices its phases allow holds the hex centers, and whether its sides
 * are drawn as hexes' are.
 */
function confirm(f: Frame, prof: Profiles, fit: Fit): HexFound | string {
  const [up, a, b] = fit.fams;
  const p = (up.period + a.period + b.period) / 3;
  const cell = 2 * p;
  // How each family's lines lean, px along the normal per px down. A turn
  // by an angle leans the upright sides by that angle, and the two sloped
  // families by twice it, opposite ways. Hexes stretched or squeezed,
  // across or down, leave the upright sides upright and lean both sloped
  // families the same way, by cos 30 times the stretch: half their sum,
  // over cos 30, is the stretch, whatever the turn.
  const upLean = leanOf(prof.top[0]!, prof.bottom[0]!, up, f.d, f.H);
  if (upLean !== null && Math.abs(upLean.lean) * f.H > Math.max(MAX_DRIFT_PX / f.k, MAX_DRIFT_SHARE * cell)) return "lines turned";
  const aLean = leanOf(prof.top[1]!, prof.bottom[1]!, a, f.d, f.H);
  const bLean = leanOf(prof.top[2]!, prof.bottom[2]!, b, f.d, f.H);
  const shape = aLean !== null && bLean !== null ? { stretch: Math.abs(aLean.lean + bLean.lean) / (2 * HEX_S), se: Math.hypot(aLean.se, bLean.se) / (2 * HEX_S) } : null;
  if (shape !== null && shape.stretch >= MAX_STRETCH) return "hexes out of shape";
  // The half measure of a third look's find reads thick lines' places less
  // finely than a look at their own size: hexes squeezed 1.1% read as 0.64%
  // on a 300 px frame. A stretch within that measure's error of the limit,
  // by the frame's pixels or by the lines' own scatter, is not measured.
  const nearLimit = f.margin && shape !== null && shape.stretch + Math.max(STRETCH_ERROR_PX / (f.H / 2), STRETCH_ERROR_SE * shape.se) >= MAX_STRETCH;
  // A point where all three families cross, near the middle: x from the
  // upright sides and from the sloped ones' difference, y cos 30 from the
  // sloped ones' mean.
  const [x0, u1, u2] = linesNear(fit.fams, { x: f.W / 2, y: f.H / 2 });
  const cross = { x: (x0 + u2 - u1) / 2, y: (u1 + u2) / (2 * HEX_S) };
  const corner = HEX_R * cell;
  const looks = [0, 1, 2].map((m) => sidesOf(f, { x: cross.x, y: cross.y + m * corner }, cell, fit.polarity));
  const best = looks.reduce((x, y) => (y.mean > x.mean ? y : x));
  const others = looks.filter((l) => l !== best).map((l) => l.mean);
  if (best.values.length === 0 || !(best.mean > 0)) return "no sides drawn";
  const broken = clamp01(1 - Math.max(0, ...others) / best.mean);
  if (broken < MIN_BROKEN) return "lines run on through the hexes";
  const threshold = Math.max(0.5, 0.3 * quantile(best.values, 0.9));
  const coverage = best.values.filter((v) => v > threshold).length / best.values.length;
  // Sides that barely break at the corners lower the confidence, which
  // may fall under the cutoff here, after the profiles passed it.
  const checked = upLean !== null && aLean !== null && bLean !== null && !nearLimit;
  const measured = fit.score * clamp01((broken - MIN_BROKEN) / 0.3);
  if (measured < MIN_CONFIDENCE) return "low confidence";
  const confidence = checked ? measured : Math.min(measured, UNCHECKED_MAX);
  const center = nearestCenter(best.center, cell, { x: f.W / 2, y: f.H / 2 });
  return {
    found: true,
    orient: "rows",
    cellPx: cell,
    center,
    box: boxOf(center, cell, "rows"),
    confidence,
    polarity: fit.polarity,
    broken,
    coverage,
    checked,
    families: fit.fams,
  };
}

/**
 * The hex center nearest `to`, on the lattice of hex rows with a center
 * at `c`. Rows are staggered, so the nearest center may be in the row
 * above or below the nearest row: all three are compared.
 */
function nearestCenter(c: Point, cell: number, to: Point): Point {
  const rowPx = HEX_S * cell;
  const row = Math.round((to.y - c.y) / rowPx);
  let best = c;
  let far = Infinity;
  for (let j = row - 1; j <= row + 1; j++) {
    const shift = mod(j, 2) * (cell / 2);
    const i = Math.round((to.x - c.x - shift) / cell);
    const at = { x: c.x + shift + i * cell, y: c.y + j * rowPx };
    const dist = Math.hypot(at.x - to.x, at.y - to.y);
    if (dist < far) {
      far = dist;
      best = at;
    }
  }
  return best;
}

/** HX-D12's box around a hex center: its middle is the center, and it holds that hex and its six neighbors. */
function boxOf(center: Point, cell: number, orient: HexOrient): CalBox {
  const size = 3 * cell;
  const { w, h } = boxSides({ x: 0, y: 0, size }, { shape: "hex", orient });
  return { x: center.x - w / 2, y: center.y - h / 2, size };
}

/** At most this many hexes are looked at, spread over the map. */
const MAX_HEXES = 3000;

/**
 * Each side of the hexes centered on `c`'s lattice, its middle 60%: the
 * line response along it less the response along the parallel line a
 * quarter of a cell in, toward the hex's center, where no side is drawn.
 * Each hex owns its upright right side and its two lower sloped sides,
 * so every side is looked at once.
 */
function sidesOf(f: Frame, c: Point, cell: number, pol: Polarity): { mean: number; values: number[]; center: Point } {
  const { L, W, H, d, dv } = f;
  const rowPx = HEX_S * cell;
  const corner = HEX_R * cell;
  const ridgeX = (x: number, y: number) => {
    const i = y * W + x;
    const v = L[i]!;
    const a = L[i - d]! - v;
    const b = L[i + d]! - v;
    return pol === "dark" ? (a > 0 && b > 0 ? Math.min(a, b, CAP) : 0) : a < 0 && b < 0 ? Math.min(-a, -b, CAP) : 0;
  };
  const ridgeY = (x: number, y: number) => {
    const i = y * W + x;
    const v = L[i]!;
    const a = L[i - dv * W]! - v;
    const b = L[i + dv * W]! - v;
    return pol === "dark" ? (a > 0 && b > 0 ? Math.min(a, b, CAP) : 0) : a < 0 && b < 0 ? Math.min(-a, -b, CAP) : 0;
  };
  const inside = (x: number, y: number) => x >= d + 1 && x < W - d - 1 && y >= dv + 1 && y < H - dv - 1;
  // A line may fall between pixels: the strongest response a pixel either side of it.
  const nearX = (x: number, y: number) => Math.max(ridgeX(x - 1, y), ridgeX(x, y), ridgeX(x + 1, y));
  const nearY = (x: number, y: number) => Math.max(ridgeY(x, y - 1), ridgeY(x, y), ridgeY(x, y + 1));
  const samples = Math.max(3, Math.min(12, Math.round(0.6 * corner)));
  const inward = cell / 4;
  const side = (from: Point, to: Point, normal: Point, upright: boolean): number | null => {
    let on = 0;
    let off = 0;
    for (let k = 0; k < samples; k++) {
      const t = 0.2 + (0.6 * (k + 0.5)) / samples;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xo = Math.floor(x - normal.x * inward);
      const yo = Math.floor(y - normal.y * inward);
      if (!inside(xi, yi) || !inside(xo, yo)) return null;
      on += upright ? nearX(xi, yi) : nearY(xi, yi);
      off += upright ? nearX(xo, yo) : nearY(xo, yo);
    }
    return (on - off) / samples;
  };
  const j0 = Math.floor(-c.y / rowPx) - 1;
  const j1 = Math.ceil((H - c.y) / rowPx) + 1;
  const i0 = Math.floor(-c.x / cell) - 2;
  const i1 = Math.ceil((W - c.x) / cell) + 1;
  const thin = Math.max(1, Math.ceil(Math.sqrt(((j1 - j0) * (i1 - i0)) / MAX_HEXES)));
  const values: number[] = [];
  for (let j = j0; j <= j1; j += thin) {
    const shift = mod(j, 2) * (cell / 2);
    for (let i = i0; i <= i1; i += thin) {
      const cx = c.x + shift + i * cell;
      const cy = c.y + j * rowPx;
      const right = cx + cell / 2;
      const sides = [
        side({ x: right, y: cy - corner / 2 }, { x: right, y: cy + corner / 2 }, { x: 1, y: 0 }, true),
        side({ x: right, y: cy + corner / 2 }, { x: cx, y: cy + corner }, { x: 0.5, y: HEX_S }, false),
        side({ x: cx, y: cy + corner }, { x: cx - cell / 2, y: cy + corner / 2 }, { x: -0.5, y: HEX_S }, false),
      ];
      for (const v of sides) if (v !== null) values.push(v);
    }
  }
  const mean = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  return { mean, values, center: c };
}

export type MapShape = "squares" | "hexRows" | "hexColumns";

export type ShapeFind = {
  shape: MapShape;
  confidence: number;
  /**
   * Another shape was found too, such as squares drawn over a floor of
   * hex tiles, or hexes over square tiles. The map holds both, so the find
   * is only offered: it never applies or switches the scene's shape by
   * itself, however sure. In the evaluation a find of tiles beat the drawn
   * grid's at 0.69 against 0.57, so a sure winner over a doubtful other
   * is no safer.
   */
  contested: boolean;
};

/**
 * Which shape a map's drawn grid is, from the square finder and the hex
 * finder run both ways on the same pixels (docs/design-v1-grid-detect.md
 * section 10.7), so the DM never picks it. The most confident find wins.
 * Neither finder has the last word: each reads the other's tiles as a
 * grid. Null when nothing was found.
 */
export function pickShape(squares: GridDetection, rows: HexDetection, columns: HexDetection): ShapeFind | null {
  const finds: { shape: MapShape; confidence: number }[] = [];
  if (squares.found) finds.push({ shape: "squares", confidence: squares.confidence });
  if (rows.found) finds.push({ shape: "hexRows", confidence: rows.confidence });
  if (columns.found) finds.push({ shape: "hexColumns", confidence: columns.confidence });
  if (finds.length === 0) return null;
  finds.sort((a, b) => b.confidence - a.confidence);
  const [best, next] = finds as [(typeof finds)[number], ...(typeof finds)];
  return { ...best, contested: next !== undefined };
}
