/**
 * Finding the square grid drawn on a map image (docs/design-v1-grid-detect.md).
 *
 * A drawn grid is thin lines, all the same distance apart, running the
 * length of the map. The method looks for exactly that and nothing looser:
 *
 * 1. A thin-line filter along each axis. A pixel counts toward a vertical
 *    line when it is darker (or lighter) than both pixels `d` to its left
 *    and right, by the smaller of the two differences. A step edge, such as
 *    a wall's side or a shadow, has one side level with the pixel and
 *    counts for nothing, so most of a map's art drops out here.
 * 2. Those responses summed down every column and along every row: two
 *    profiles per polarity (dark lines and light lines). A line that runs
 *    the map's length adds up over thousands of rows, and art that does
 *    not line up from row to row averages away.
 * 3. Candidate periods from each profile's autocorrelation, then for each
 *    one the period refined by the profile's Fourier magnitude near it, the
 *    phase from the Fourier argument, every predicted line looked for, and
 *    a least-squares fit through the lines found, which gives the square
 *    size to a small fraction of a pixel.
 * 4. Checks that each fit must pass on both axes, at the same square size,
 *    before it is believed: enough lines, strong against the profile's
 *    noise, few of them missing, evenly spaced, and nothing as strong
 *    halfway or a third of the way between them (or the squares are
 *    really smaller). Odd lines weaker than even ones on both axes mean
 *    the squares are really twice as big. Of sizes that pass, a pattern
 *    and its whole multiples are one family, judged by its smallest.
 * 5. A last look at the image itself along the fitted lines: a drawn line
 *    runs on from one square to the next, where the joints of staggered
 *    bricks or planks stop at every course, and it sits in the same place
 *    in both halves of the image, where a turned grid's lines move.
 *
 * Pure and synchronous: it takes decoded pixels and returns a result, so
 * the same code runs in a browser Worker, in Node and in the tests.
 */

/** Decoded image samples, row by row, `channels` per pixel. Alpha, when present, is ignored. */
export type Pixels = {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  channels: 1 | 3 | 4;
};

/** One axis's grid: lines at `phase + k * period`, in pixel coordinates (pixel i spans [i, i + 1)). */
export type AxisFit = {
  period: number;
  /** In [0, period). */
  phase: number;
  /** Lines found, and the lines the fit predicts from the first found to the last. */
  found: number;
  expected: number;
  /** Where the first and last lines found sit, so a margin without lines shows. */
  from: number;
  to: number;
  /** Median line strength over the profile's noise between lines. */
  snr: number;
  /** Strength halfway or a third of the way between lines, against the lines beside it. Near 1 means smaller squares. */
  between: number;
  /** Odd lines against their even neighbors, or even against odd, whichever is lower. Low means squares twice the size. */
  parity: number;
  /** Root mean square distance of the lines found from the fitted ones, px. */
  rms: number;
};

/** What the image shows along one axis's fitted lines (step 5). */
export type LineLook = {
  /** Of square sides that show, the share whose next side along the line shows too. */
  continuity: number;
  /** Of square sides that do not show, the share whose next side does. */
  restart: number;
  /** The share of square sides that show at all: how much of the map the grid covers. */
  coverage: number;
  /** How far the lines move from one half of the image to the other, across the whole image, px. */
  drift: number;
};

export type GridFound = {
  found: true;
  /** The mean of the two axes' periods: the app's squares are square. */
  cellPx: number;
  /** Where a pair of lines cross, in [0, cellPx) on each axis. */
  originPx: { x: number; y: number };
  /** 0 to 1. See `confidenceOf`. */
  confidence: number;
  polarity: "dark" | "light";
  across: AxisFit & LineLook;
  down: AxisFit & LineLook;
  /** Present when a square size was given as a hint (a file name like `crypt_30x20.jpg`). */
  hint?: "agrees" | "differs";
};

export type NoGridReason =
  /** Too small to hold a grid this can see. */
  | "small"
  /** No repeating lines at all. */
  | "none"
  /** Lines repeat across and down, but at different sizes: not square. */
  | "unsquare"
  /** The nearest fit failed a check. `best` says which. */
  | "weak";

export type NoGrid = { found: false; reason: NoGridReason; best?: { across: AxisFit; down: AxisFit; failed: string } };

export type GridDetection = GridFound | NoGrid;

export type DetectOptions = {
  /** A square size from the file name, in px. Tried first, and kept when the image bears it out. */
  hintCellPx?: number;
  /** Every `step`th row feeds the column profile, and every `step`th column the row profile. */
  step?: number;
  /** Each candidate tried and how it fared, for the evaluation script's failure notes. */
  onCandidate?: (c: { seed: number; polarity: Polarity; across: AxisFit; down: AxisFit; failed: string | null; score: number }) => void;
};

/** The smallest square this looks for, px. Smaller grids are rare and the line filter cannot hold their lines apart. */
export const MIN_DETECT_CELL_PX = 10;
/** The app's largest scene side in squares (design 10.5): a finer grid could not be a scene. */
const MAX_CELLS = 200;
/** Lines of either axis needed before a fit counts. */
const MIN_LINES = 4;
/** A thin-line response above this many gray levels counts as this many, so one stark line of art cannot outvote a faint grid. */
const CAP = 64;
/** A line is found when its strength passes this many noise deviations. */
const LINE_SIGMA = 4;
/** Fits under this signal to noise are not believed. */
const MIN_SNR = 5;
/** Of the lines predicted between the first and last found, at least this share must be found. */
const MIN_FOUND = 0.6;
/**
 * Halfway lines this strong, against the lines beside them, mean the
 * squares are half the size. Odd lines this much weaker than their even
 * neighbors, across and down, mean they are twice the size (`explain`).
 */
const HALF = 0.6;
/**
 * Of square sides that show, at least this share must have the next side
 * along the line show too. A drawn line runs on. Stray marks that happen
 * to fall on a fitted line, or the crossings of a grid turned 45 degrees,
 * show in scattered sides.
 */
const MIN_CONTINUITY = 0.3;
/** Lines that move more than this from one side of the map to the other, px, belong to a turned grid. */
const MAX_DRIFT_PX = 3;
/** Lines that move more than this share of a square across the map, on a large grid. */
const MAX_DRIFT_SHARE = 0.01;
/** The two axes' periods may differ by this fraction, from an image resized a hair out of proportion. */
const SQUARE_TOLERANCE = 0.015;
/** Below this confidence the result is "no grid". */
export const MIN_CONFIDENCE = 0.3;

type Polarity = "dark" | "light";
type Profile = {
  /** The detrended profile's positive part, for the autocorrelation and the Fourier sums. */
  q: Float64Array;
  /** `q` summed over a line's width around each position: a line's strength wherever it is centered. */
  s: Float64Array;
  /** How many samples went into each position, for a floor under the noise. */
  samples: number;
};

/**
 * The line filter's reach, from the image's size. It must be at least the
 * width of a line with its antialiased edges, or a line that falls across
 * two pixels reads weaker than one centered on a pixel, and a grid of
 * 72.5 px squares would look like every other line is fainter.
 */
export function lineReach(width: number, height: number): number {
  return Math.min(6, Math.max(3, Math.round(Math.max(width, height) / 1300)));
}

/** The default sampling step: every row and column up to 1,500 px on the short side, then thinner. */
export function defaultStep(width: number, height: number): number {
  return Math.max(1, Math.floor(Math.min(width, height) / 1500));
}

/**
 * Sums of the thin-line response down each column (vertical lines) and
 * along each row (horizontal lines), for dark and light lines apart. The
 * row sums need the pixels `d` above and below, kept in a ring of rows, so
 * nothing larger than a few rows is ever allocated. The column sums are
 * kept per half of the image, top and bottom, and the row sums per half,
 * left and right: a grid turned on the image has its lines in different
 * places in the two halves.
 */
export function lineProfiles(px: Pixels, d: number, step: number) {
  const { width: W, height: H, data, channels: ch } = px;
  const top = { dark: new Float64Array(W), light: new Float64Array(W) };
  const bottom = { dark: new Float64Array(W), light: new Float64Array(W) };
  const left = { dark: new Float64Array(H), light: new Float64Array(H) };
  const right = { dark: new Float64Array(H), light: new Float64Array(H) };
  const row = new Int32Array(W);
  for (let y = 0; y < H; y += step) {
    luma(data, ch, y * W, W, 1, row);
    const half = y < H / 2 ? top : bottom;
    const dark = half.dark;
    const light = half.light;
    for (let x = d; x < W - d; x++) {
      const c = row[x]!;
      const a = row[x - d]! - c;
      const b = row[x + d]! - c;
      if (a > 0 && b > 0) dark[x]! += a < b ? (a < CAP ? a : CAP) : b < CAP ? b : CAP;
      else if (a < 0 && b < 0) light[x]! += a > b ? (-a < CAP ? -a : CAP) : -b < CAP ? -b : CAP;
    }
  }
  const nx = Math.ceil(W / step);
  const mid = Math.ceil(nx / 2);
  const span = 2 * d + 1;
  const ring = new Int32Array(span * nx);
  for (let y = 0; y < H; y++) {
    const slot = (y % span) * nx;
    luma(data, ch, y * W, nx, step, ring.subarray(slot, slot + nx));
    if (y < 2 * d) continue;
    const above = ((y - 2 * d) % span) * nx;
    const center = ((y - d) % span) * nx;
    for (let side = 0; side < 2; side++) {
      let dark = 0;
      let light = 0;
      for (let i = side ? mid : 0, end = side ? nx : mid; i < end; i++) {
        const c = ring[center + i]!;
        const a = ring[above + i]! - c;
        const b = ring[slot + i]! - c;
        if (a > 0 && b > 0) dark += a < b ? (a < CAP ? a : CAP) : b < CAP ? b : CAP;
        else if (a < 0 && b < 0) light += a > b ? (-a < CAP ? -a : CAP) : -b < CAP ? -b : CAP;
      }
      const half = side ? right : left;
      half.dark[y - d] = dark;
      half.light[y - d] = light;
    }
  }
  const sum = (a: Float64Array, b: Float64Array) => a.map((v, i) => v + b[i]!);
  return {
    cols: { dark: sum(top.dark, bottom.dark), light: sum(top.light, bottom.light) },
    rows: { dark: sum(left.dark, right.dark), light: sum(left.light, right.light) },
    top,
    bottom,
    left,
    right,
    colSamples: Math.ceil(H / step),
    rowSamples: nx,
  };
}

/** Gray levels of `count` pixels from pixel `start`, `stride` pixels apart, into `out`. */
function luma(data: Pixels["data"], ch: number, start: number, count: number, stride: number, out: Int32Array): void {
  if (ch === 1) {
    for (let i = 0, p = start; i < count; i++, p += stride) out[i] = data[p]!;
    return;
  }
  for (let i = 0, p = start * ch; i < count; i++, p += stride * ch) {
    // Rec. 601 weights in fixed point, for RGB and RGBA alike.
    out[i] = (77 * data[p]! + 150 * data[p + 1]! + 29 * data[p + 2]!) >> 8;
  }
}

function lumaAt(px: Pixels, x: number, y: number): number {
  const i = y * px.width + x;
  if (px.channels === 1) return px.data[i]!;
  const p = i * px.channels;
  return (77 * px.data[p]! + 150 * px.data[p + 1]! + 29 * px.data[p + 2]!) >> 8;
}

/**
 * A profile with its slow changes taken out (a lit room beside a dark one
 * shifts the whole sum), kept above zero, and summed over a line's width.
 */
function prepare(raw: Float64Array, d: number, samples: number): Profile {
  const n = raw.length;
  const m = 3 * d;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + raw[i]!;
  const q = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - m);
    const hi = Math.min(n, i + m + 1);
    const v = raw[i]! - (prefix[hi]! - prefix[lo]!) / (hi - lo);
    q[i] = v > 0 ? v : 0;
  }
  const s = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < Math.min(n, d); i++) run += q[i]!;
  for (let i = 0; i < n; i++) {
    if (i + d < n) run += q[i + d]!;
    if (i - d - 1 >= 0) run -= q[i - d - 1]!;
    s[i] = run;
  }
  return { q, s, samples };
}

/** Periods where the profile's autocorrelation peaks, strongest first. */
function candidatePeriods(q: Float64Array, minP: number, maxP: number, keep: number): number[] {
  const n = q.length;
  const lo = Math.max(1, Math.floor(minP) - 1);
  const hi = Math.min(n - 2, Math.ceil(maxP) + 1);
  if (hi - lo < 2) return [];
  const ac = new Float64Array(hi + 2);
  for (let lag = lo; lag <= hi + 1; lag++) {
    let sum = 0;
    for (let i = 0, j = lag; j < n; i++, j++) sum += q[i]! * q[j]!;
    ac[lag] = sum / (n - lag);
  }
  const peaks: { p: number; v: number }[] = [];
  for (let lag = lo + 1; lag <= hi; lag++) {
    const a = ac[lag - 1]!;
    const b = ac[lag]!;
    const c = ac[lag + 1]!;
    if (b <= 0 || b < a || b < c) continue;
    const curve = a - 2 * b + c;
    const shift = curve < 0 ? (0.5 * (a - c)) / curve : 0;
    const p = lag + Math.max(-0.5, Math.min(0.5, shift));
    if (p >= minP && p <= maxP) peaks.push({ p, v: b });
  }
  peaks.sort((x, y) => y.v - x.v);
  return peaks.slice(0, keep).map((x) => x.p);
}

/** The profile's Fourier coefficient at frequency 1 / p, by rotating a unit phasor rather than calling sin and cos per sample. */
function fourier(q: Float64Array, p: number): { mag: number; arg: number } {
  const w = (2 * Math.PI) / p;
  const cr = Math.cos(w);
  const ci = -Math.sin(w);
  let zr = 1;
  let zi = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < q.length; i++) {
    const v = q[i]!;
    if (v !== 0) {
      re += v * zr;
      im += v * zi;
    }
    const t = zr * cr - zi * ci;
    zi = zr * ci + zi * cr;
    zr = t;
  }
  return { mag: Math.hypot(re, im), arg: Math.atan2(im, re) };
}

function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5);
}

/** The value a share `q` of the way up the sorted values, sorted natively as a typed array. */
function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  if (q === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** The largest value of `s` within `r` of `x`, and where. */
function peakNear(s: Float64Array, x: number, r: number): { at: number; v: number } {
  const lo = Math.max(0, Math.round(x - r));
  const hi = Math.min(s.length - 1, Math.round(x + r));
  let at = lo;
  let v = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (s[i]! > v) {
      v = s[i]!;
      at = i;
    }
  }
  return { at, v };
}

/**
 * A line's center: the centroid of the response's run around its
 * strongest point, out to where it falls under a third of that. A run
 * rather than a fixed window, so a seam of art a few pixels off, with a
 * dip between, does not pull the line toward it.
 */
function center(q: Float64Array, around: number, d: number): number {
  const lo = Math.max(0, around - d);
  const hi = Math.min(q.length - 1, around + d);
  let top = around;
  for (let i = lo; i <= hi; i++) if (q[i]! > q[top]!) top = i;
  const floor = q[top]! / 3;
  let a = top;
  let b = top;
  while (a > lo && q[a - 1]! > floor && q[a - 1]! <= q[a]! * 1.05) a--;
  while (b < hi && q[b + 1]! > floor && q[b + 1]! <= q[b]! * 1.05) b++;
  let w = 0;
  let wx = 0;
  for (let i = a; i <= b; i++) {
    w += q[i]!;
    wx += q[i]! * i;
  }
  return w > 0 ? wx / w : top;
}

/**
 * A line through (k, x), x = phase + k * period, by the Theil-Sen method:
 * the median of the slopes between every two points. A line of art taken
 * for a grid line, or a missing line's place filled by a stray mark,
 * moves a least-squares fit, but nearly three in ten such points leave a
 * median where it was.
 */
function robustFit(points: { k: number; c: number }[]): { period: number; phase: number } {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      if (b.k !== a.k) slopes.push((b.c - a.c) / (b.k - a.k));
    }
  }
  const period = median(slopes);
  return { period, phase: median(points.map((p) => p.c - period * p.k)) };
}

/** Least squares through (k, x): x = phase + k * period. */
function lineFit(points: { k: number; c: number }[]): { period: number; phase: number; rms: number } {
  const n = points.length;
  let mk = 0;
  let mx = 0;
  for (const p of points) {
    mk += p.k / n;
    mx += p.c / n;
  }
  let skk = 0;
  let skx = 0;
  for (const p of points) {
    skk += (p.k - mk) ** 2;
    skx += (p.k - mk) * (p.c - mx);
  }
  const period = skk > 0 ? skx / skk : 0;
  const phase = mx - period * mk;
  let ss = 0;
  for (const p of points) ss += (p.c - phase - period * p.k) ** 2;
  return { period, phase, rms: Math.sqrt(ss / Math.max(1, n)) };
}

/**
 * The grid along one axis near period `p0`, or null when no line pattern
 * is there at all. The fit is returned with its measures whether or not it
 * passes, so the caller decides and can say why.
 */
function fitAxis(prof: Profile, p0: number, d: number): AxisFit | null {
  const { q, s } = prof;
  const n = q.length;
  // The autocorrelation is good to about a pixel, a little more on large
  // squares. The Fourier magnitude's peak is p0^2 / n wide, so steps of a
  // quarter of that cannot miss it. A wider search lets busy art on a map
  // of few squares pull the period off the grid's own.
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
  let mu = 0;
  let sigma = 0;
  let rms = 0;
  // Lines looked for at the Fourier estimate, then twice more at the
  // least-squares fit, whose windows sit truer at the far ends.
  for (let round = 0; round < 3; round++) {
    const k0 = Math.ceil((d - phase) / period);
    const k1 = Math.floor((n - 1 - d - phase) / period);
    if (k1 - k0 + 1 < MIN_LINES) return null;
    const noise = noiseOf(prof, phase, period, r + d + 1, d);
    if (!noise) return null;
    ({ mu, sigma } = noise);
    strengths = [];
    found = [];
    for (let k = k0; k <= k1; k++) {
      const peak = peakNear(s, phase + k * period, r);
      const v = peak.v - mu;
      strengths.push({ k, v });
      if (v < LINE_SIGMA * sigma) continue;
      found.push({ k, c: center(q, peak.at, d) });
    }
    if (found.length < MIN_LINES) return null;
    // Lines further from a robust fit than a few median deviations are
    // art near a predicted line, or a stray mark where a line is missing.
    // The rest get a least-squares fit, the more precise of the two.
    const rough = robustFit(found);
    const residual = found.map((f) => Math.abs(f.c - rough.phase - rough.period * f.k));
    const limit = Math.max(1, 3 * 1.4826 * median(residual));
    const inliers = found.filter((_, i) => residual[i]! <= limit);
    if (inliers.length >= MIN_LINES) found = inliers;
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
  const on = median(inSpan.map((x) => x.v));
  // Each measure is local, against the lines beside it: on a grid drawn
  // over part of the map, lines that cross more of it are stronger, and a
  // ratio to the median line would read that as a pattern. The space
  // between lines is judged by its clearer quarter: floor tiles half a
  // square wide fill it in one room, but where the art is plain it stays
  // empty, which squares of half the size could not do.
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
  const byParity: [number[], number[]] = [[], []];
  for (const x of inSpan) {
    const prev = strength.get(x.k - 1);
    const next = strength.get(x.k + 1);
    if (prev === undefined || next === undefined || prev + next < 2 * LINE_SIGMA * sigma) continue;
    byParity[mod(x.k, 2)]!.push(strength.get(x.k)! / ((prev + next) / 2));
  }
  const parity = byParity[0].length && byParity[1].length ? Math.min(1, median(byParity[0]), median(byParity[1])) : 1;
  return {
    period,
    // Index coordinates to pixel coordinates: pixel i's center is i + 0.5.
    phase: mod(phase + 0.5, period),
    found: found.length,
    expected: last - first + 1,
    from: phase + first * period + 0.5,
    to: phase + last * period + 0.5,
    snr: Math.min(1000, on / sigma),
    between,
    parity,
    rms,
  };
}

/** Why a fit fails, or null when it passes. Odd lines weaker than even ones is not a failure here: see `explain`. */
function failure(a: AxisFit): string | null {
  if (a.found < MIN_LINES) return "too few lines";
  if (a.snr < MIN_SNR) return "lines too faint";
  if (a.found / a.expected < MIN_FOUND) return "too many lines missing";
  if (a.between >= HALF) return "lines between the lines";
  if (a.rms > Math.max(1, 0.03 * a.period)) return "lines not evenly spaced";
  return null;
}

/**
 * Step 5: the image along each fitted line, one square side at a time.
 * A side shows when the line response along it, less the response along
 * the parallel line halfway to the next, passes a share of the strongest
 * sides. The ends of each side are skipped, so the crossing lines do not
 * count toward it.
 */
function lookAlong(px: Pixels, line: AxisFit, cross: AxisFit, vertical: boolean, pol: Polarity, d: number, step: number): Omit<LineLook, "drift"> {
  const len = vertical ? px.height : px.width;
  const wide = vertical ? px.width : px.height;
  const at = (u: number, v: number) => (vertical ? lumaAt(px, u, v) : lumaAt(px, v, u));
  const ridge = (u: number, v: number) => {
    const c = at(u, v);
    const a = at(u - d, v) - c;
    const b = at(u + d, v) - c;
    if (pol === "dark") return a > 0 && b > 0 ? Math.min(a, b, CAP) : 0;
    return a < 0 && b < 0 ? Math.min(-a, -b, CAP) : 0;
  };
  // The response a pixel either side of the line's center, which may fall between pixels.
  const near = (u: number, v: number) => Math.max(ridge(u - 1, v), ridge(u, v), ridge(u + 1, v));
  const sides: number[][] = [];
  const lo = d + 2;
  const hi = wide - d - 3;
  const kFirst = Math.ceil((line.from - line.phase) / line.period - 1e-6);
  const kLast = Math.floor((line.to - line.phase) / line.period + 1e-6);
  for (let k = kFirst; k <= kLast; k++) {
    const u = Math.round(line.phase + k * line.period - 0.5);
    const mid = Math.round(line.phase + (k + 0.5) * line.period - 0.5);
    if (u < lo || u > hi || mid < lo || mid > hi) continue;
    const row: number[] = [];
    for (let j = Math.floor(-cross.phase / cross.period); cross.phase + j * cross.period < len; j++) {
      const a = Math.max(0, Math.ceil(cross.phase + (j + 0.2) * cross.period));
      const b = Math.min(len - 1, Math.floor(cross.phase + (j + 0.8) * cross.period));
      let sum = 0;
      let count = 0;
      for (let v = a; v <= b; v += step) {
        sum += near(u, v) - near(mid, v);
        count++;
      }
      row.push(count > 0 ? sum / count : 0);
    }
    sides.push(row);
  }
  const all = sides.flat();
  if (all.length === 0) return { continuity: 0, restart: 0, coverage: 0 };
  const threshold = Math.max(0.5, 0.3 * quantile(all, 0.9));
  // Neighboring sides along a line: [shown then shown, shown then not, not then shown, not then not].
  const runs = [0, 0, 0, 0];
  let shown = 0;
  for (const row of sides) {
    for (let j = 0; j < row.length; j++) {
      const here = row[j]! > threshold;
      if (here) shown++;
      if (j + 1 < row.length) runs[(here ? 0 : 2) + (row[j + 1]! > threshold ? 0 : 1)]!++;
    }
  }
  const [ss, sn, ns, nn] = runs as [number, number, number, number];
  return {
    continuity: ss + sn > 0 ? ss / (ss + sn) : 0,
    restart: ns + nn > 0 ? ns / (ns + nn) : 0,
    coverage: shown / all.length,
  };
}

/** The median and spread of a profile's line strength away from every predicted line: its noise. */
function noiseOf(prof: Profile, phase: number, period: number, keep: number, d: number): { mu: number; sigma: number } | null {
  const { s } = prof;
  const off: number[] = [];
  for (let i = d; i < s.length - d; i++) {
    const t = mod(i - phase, period);
    if (Math.min(t, period - t) >= keep) off.push(s[i]!);
  }
  if (off.length < 8) return null;
  const mu = median(off);
  // A floor under the noise, so a clean image or a flat margin cannot
  // make every speck a line: a twentieth of a gray level per sample.
  const sigma = Math.max(1.4826 * median(off.map((v) => Math.abs(v - mu))), 0.05 * prof.samples);
  return { mu, sigma };
}

/**
 * How far one axis's lines move between the two halves of the image, as
 * a drift across the whole image, in px: the median offset of each half's
 * line centers from the fitted lines, the second half's less the first's,
 * doubled because the halves' centers are half the image apart. Null
 * when either half shows too few lines to say.
 */
function driftOf(first: Profile, second: Profile, fit: AxisFit, d: number): number | null {
  const shift = (half: Profile) => {
    const phase = fit.phase - 0.5;
    const r = Math.max(1, Math.min(2 * d, Math.floor(0.15 * fit.period)));
    const noise = noiseOf(half, phase, fit.period, r + d + 1, d);
    if (!noise) return null;
    const offsets: number[] = [];
    for (let k = Math.ceil((fit.from - fit.phase) / fit.period - 1e-6); k <= Math.floor((fit.to - fit.phase) / fit.period + 1e-6); k++) {
      const x = phase + k * fit.period;
      const peak = peakNear(half.s, x, r);
      if (peak.v - noise.mu >= LINE_SIGMA * noise.sigma) offsets.push(center(half.q, peak.at, d) - x);
    }
    return offsets.length >= MIN_LINES ? median(offsets) : null;
  };
  const a = shift(first);
  const b = shift(second);
  return a === null || b === null ? null : 2 * Math.abs(b - a);
}

/**
 * Whether a line's sides take turns: where one shows the next does not,
 * and where one does not the next does. That is the joints of staggered
 * bricks or planks, never a drawn line, which runs on wherever it shows.
 * A grid hidden in places under art only loses sides at random.
 */
function alternates(look: LineLook): boolean {
  return look.restart > 0.3 && look.continuity < 0.5 * look.restart;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * How sure a pair of passing fits is, 0 to 1: the weaker axis's signal
 * to noise, the share of its lines found, how clear the space between
 * lines is, how evenly they sit, and how many there are, each scaled from
 * its pass mark up to a value where it no longer adds doubt. A product,
 * so one weak measure is enough to doubt the whole.
 */
export function confidenceOf(across: AxisFit, down: AxisFit): number {
  const snr = Math.min(across.snr, down.snr);
  const share = Math.min(across.found / across.expected, down.found / down.expected);
  const between = Math.max(across.between, down.between);
  const rms = Math.max(across.rms / across.period, down.rms / down.period);
  const lines = Math.min(across.found, down.found);
  return (
    clamp01((snr - MIN_SNR / 2) / 10) *
    clamp01((share - MIN_FOUND / 2) / (1 - MIN_FOUND / 2)) *
    clamp01((HALF - between) / (HALF - 0.2)) *
    clamp01(1 - rms / 0.03) *
    clamp01(lines / 8)
  );
}

type Pair = { across: AxisFit; down: AxisFit; polarity: Polarity; failed: string | null; score: number };

function pairAt(x: Profile, y: Profile, p: number, d: number, polarity: Polarity): Pair | null {
  const across = fitAxis(x, p, d);
  const down = fitAxis(y, p, d);
  if (!across || !down) return null;
  const mean = (across.period + down.period) / 2;
  const square = Math.abs(across.period - down.period) / mean <= SQUARE_TOLERANCE;
  const failed = !square ? "not square" : (failure(across) ?? failure(down));
  return { across, down, polarity, failed, score: failed ? 0 : confidenceOf(across, down) };
}

const passes = (p: Pair | null): p is Pair => p !== null && p.failed === null && p.score >= MIN_CONFIDENCE;

/** Whether `a`'s lines are every few of `root`'s: a whole multiple of its size, with lines where its lines are. */
function multipleOf(a: Pair, root: Pair): boolean {
  const axis = (x: AxisFit, r: AxisFit) => {
    const m = Math.round(x.period / r.period);
    if (m < 2 || Math.abs(x.period - m * r.period) > Math.max(1.5, 0.01 * x.period)) return false;
    const t = mod(x.phase - r.phase, r.period);
    return Math.min(t, r.period - t) <= Math.max(2, 0.05 * r.period);
  };
  return a.polarity === root.polarity && axis(a.across, root.across) && axis(a.down, root.down);
}

/** A passing pair, looked at along its lines (step 5): the result, or why it fails there. */
function confirm(px: Pixels, pair: Pair, halves: Halves, d: number, step: number, hint?: "agrees" | "differs"): GridFound | string {
  const cellPx = (pair.across.period + pair.down.period) / 2;
  const driftX = driftOf(halves.top, halves.bottom, pair.across, d);
  const driftY = driftOf(halves.left, halves.right, pair.down, d);
  // A turned grid cannot be lined up: the app's grid is square to the map.
  if (Math.max(driftX ?? 0, driftY ?? 0) > Math.max(MAX_DRIFT_PX, MAX_DRIFT_SHARE * cellPx)) return "lines turned";
  const lookX = { ...lookAlong(px, pair.across, pair.down, true, pair.polarity, d, step), drift: driftX ?? 0 };
  const lookY = { ...lookAlong(px, pair.down, pair.across, false, pair.polarity, d, step), drift: driftY ?? 0 };
  if (alternates(lookX) || alternates(lookY)) return "lines stop at every other square";
  if (Math.min(lookX.continuity, lookY.continuity) < MIN_CONTINUITY) return "lines broken";
  return {
    found: true,
    cellPx,
    originPx: { x: mod(pair.across.phase, cellPx), y: mod(pair.down.phase, cellPx) },
    confidence: pair.score,
    polarity: pair.polarity,
    across: { ...pair.across, ...lookX },
    down: { ...pair.down, ...lookY },
    ...(hint ? { hint } : {}),
  };
}

/** One polarity's profiles of each half of the image: vertical lines in the top and bottom, horizontal in the left and right. */
type Halves = { top: Profile; bottom: Profile; left: Profile; right: Profile };

/**
 * The square grid drawn on a map, or why none was found. With a hint, the
 * hint's size is tried first: a file name says the size but not where the
 * lines fall, which the image can still tell.
 */
export function detectGrid(px: Pixels, options: DetectOptions = {}): GridDetection {
  const { width: W, height: H } = px;
  const minP = Math.max(MIN_DETECT_CELL_PX, Math.max(W, H) / MAX_CELLS);
  const maxP = Math.min(W, H) / 3;
  if (maxP < minP || Math.min(W, H) < 64) return { found: false, reason: "small" };
  const d = lineReach(W, H);
  const step = Math.max(1, Math.floor(options.step ?? defaultStep(W, H)));
  const raw = lineProfiles(px, d, step);
  const profiles: Record<Polarity, { x: Profile; y: Profile }> = {
    dark: { x: prepare(raw.cols.dark, d, raw.colSamples), y: prepare(raw.rows.dark, d, raw.rowSamples) },
    light: { x: prepare(raw.cols.light, d, raw.colSamples), y: prepare(raw.rows.light, d, raw.rowSamples) },
  };
  const halvesOf = (pol: Polarity): Halves => ({
    top: prepare(raw.top[pol], d, raw.colSamples / 2),
    bottom: prepare(raw.bottom[pol], d, raw.colSamples / 2),
    left: prepare(raw.left[pol], d, raw.rowSamples / 2),
    right: prepare(raw.right[pol], d, raw.rowSamples / 2),
  });
  const halves = { dark: halvesOf("dark"), light: halvesOf("light") };
  const tryAt = (p: number, pol: Polarity) => {
    if (p < minP || p > maxP) return null;
    const pair = pairAt(profiles[pol].x, profiles[pol].y, p, d, pol);
    if (pair) options.onCandidate?.({ seed: p, ...pair });
    return pair;
  };

  const hint = options.hintCellPx;
  if (hint !== undefined) {
    const atHint = (["dark", "light"] as const)
      .map((pol) => tryAt(hint, pol))
      .filter(passes)
      .filter((p) => Math.abs((p.across.period + p.down.period) / 2 - hint) / hint < 0.01)
      .sort((a, b) => b.score - a.score);
    for (const pair of atHint) {
      const found = confirm(px, pair, halves[pair.polarity], d, step, "agrees");
      if (typeof found !== "string") return found;
    }
  }

  const pool: Pair[] = [];
  let nearest: Pair | null = null;
  let unsquare = false;
  let any = false;
  const consider = (pair: Pair | null) => {
    if (!pair) return;
    any = true;
    if (pair.failed === "not square" && failure(pair.across) === null && failure(pair.down) === null) unsquare = true;
    if (passes(pair)) pool.push(pair);
    else if (!nearest || closeness(pair) > closeness(nearest)) nearest = pair;
  };
  for (const pol of ["dark", "light"] as const) {
    const { x, y } = profiles[pol];
    const tried: number[] = [];
    for (const p of [...candidatePeriods(x.q, minP, maxP, 6), ...candidatePeriods(y.q, minP, maxP, 6)]) {
      if (tried.some((t) => Math.abs(t - p) / p < 0.01)) continue;
      tried.push(p);
      const pair = tryAt(p, pol);
      consider(pair);
      // Lines halfway between as strong as the lines: the squares may be a half or a third this size, if no candidate said so.
      if (pair?.failed === "lines between the lines") for (const parts of [2, 3]) consider(tryAt(pair.across.period / parts, pol));
    }
  }
  explain(pool, tryAt);

  // Families of sizes, each a pattern and its whole multiples, strongest
  // family first. Each family is judged by its smallest size: if that is
  // the joints of bricks, every multiple of it is the same joints.
  const families: { root: Pair; score: number }[] = [];
  for (const pair of [...pool].sort((a, b) => a.across.period + a.down.period - b.across.period - b.down.period)) {
    const family = families.find((f) => multipleOf(pair, f.root));
    if (family) family.score = Math.max(family.score, pair.score);
    else families.push({ root: pair, score: pair.score });
  }
  families.sort((a, b) => b.score - a.score);
  for (const { root } of families) {
    const cell = (root.across.period + root.down.period) / 2;
    const found = confirm(px, root, halves[root.polarity], d, step, hint === undefined ? undefined : Math.abs(cell - hint) / hint < 0.01 ? "agrees" : "differs");
    if (typeof found !== "string") return found;
    if (!nearest || closeness(root) > closeness(nearest)) nearest = { ...root, failed: found };
  }
  if (!any) return { found: false, reason: "none" };
  const shown = nearest as Pair | null;
  const best = shown ? { best: { across: shown.across, down: shown.down, failed: shown.failed ?? "low confidence" } } : {};
  if (unsquare && pool.length === 0) return { found: false, reason: "unsquare", ...best };
  return { found: false, reason: "weak", ...best };
}

/**
 * Odd lines much weaker than the even ones beside them, across and down:
 * a grid twice this size with fainter art halfway, such as tiles half a
 * square wide. If the doubled size passes on its own, it replaces this
 * one. If not, this one stands. Walls over a grid also leave weak lines,
 * but on one axis or the other, not every other line on both.
 */
function explain(pool: Pair[], tryAt: (p: number, pol: Polarity) => Pair | null): void {
  for (const pair of [...pool]) {
    if (Math.max(pair.across.parity, pair.down.parity) >= HALF) continue;
    const doubled = tryAt(pair.across.period + pair.down.period, pair.polarity);
    if (!passes(doubled)) continue;
    pool.splice(pool.indexOf(pair), 1);
    pool.push(doubled);
  }
}

/** For reporting the nearest miss: the pair that came closest to passing. */
function closeness(p: Pair): number {
  return Math.min(p.across.snr, p.down.snr) * Math.min(p.across.found / p.across.expected, p.down.found / p.down.expected);
}
