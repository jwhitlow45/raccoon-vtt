/**
 * The profile and fit code both grid finders share (detect.ts for
 * squares, detectHex.ts for hexes, docs/design-v1-grid-detect.md sections
 * 2 and 10.1). A profile is the thin-line filter's responses summed along
 * one family of lines. Each finder builds its own profiles and decides
 * what its lines mean: these only find where a profile repeats and where
 * its lines lie.
 */

/** `v` modulo `m`, in [0, m) for a positive `m`. */
export function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** The value a share `q` of the way up the sorted values, sorted natively as a typed array. */
export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  if (q === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5);
}

/**
 * A profile with its slow changes taken out (a lit room beside a dark one
 * shifts the whole sum) and kept above zero: each bin less the mean of the
 * `3 * d` bins either side.
 */
export function detrended(raw: Float64Array, d: number): Float64Array {
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
  return q;
}

/** The profile summed over `w` bins either side of each position: a line's strength wherever it is centered. */
export function windowSums(q: Float64Array, w: number): Float64Array {
  const n = q.length;
  const s = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < Math.min(n, w); i++) run += q[i]!;
  for (let i = 0; i < n; i++) {
    if (i + w < n) run += q[i + w]!;
    if (i - w - 1 >= 0) run -= q[i - w - 1]!;
    s[i] = run;
  }
  return s;
}

/** Periods from `minP` to `maxP` where the profile's autocorrelation peaks, each with its height, strongest first. */
export function autocorrelationPeaks(q: Float64Array, minP: number, maxP: number): { p: number; v: number }[] {
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
  return peaks;
}

/** The profile's Fourier coefficient at frequency 1 / p, by rotating a unit phasor rather than calling sin and cos per sample. */
export function fourier(q: Float64Array, p: number): { mag: number; arg: number } {
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

/** The largest value of `s` within `r` of `x`, and where. */
export function peakNear(s: Float64Array, x: number, r: number): { at: number; v: number } {
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
export function lineCenter(q: Float64Array, around: number, d: number): number {
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

/** Least squares through (k, x): x = phase + k * period. */
export function leastSquares(points: readonly { k: number; c: number }[]): { period: number; phase: number; rms: number } {
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
 * The median and spread of a profile's line strength `s` at least `keep`
 * from every predicted line: its noise. Null with too few such bins to
 * say. A floor under the spread, so a clean image or a flat margin cannot
 * make every speck a line: a twentieth of a gray level per sample.
 */
export function noiseOf(s: Float64Array, samples: number, phase: number, period: number, keep: number, d: number): { mu: number; sigma: number } | null {
  const off: number[] = [];
  for (let i = d; i < s.length - d; i++) {
    const t = mod(i - phase, period);
    if (Math.min(t, period - t) >= keep) off.push(s[i]!);
  }
  if (off.length < 8) return null;
  const mu = median(off);
  const sigma = Math.max(1.4826 * median(off.map((v) => Math.abs(v - mu))), 0.05 * samples);
  return { mu, sigma };
}
