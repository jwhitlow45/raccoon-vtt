import { viewToScreen, type Camera } from "../../lib/camera.ts";
import { toView, type View, type ViewPoint } from "../../lib/view.ts";
import type { Field } from "./sim.ts";
import { eachMark, RING_MS, WRAP_MARGIN } from "./sim.ts";
import { LEAF_CELL, NOISE_SIZE, type TextureSource } from "./textures.ts";

/**
 * Draws a weather field into a 2D context (the weather design note, 5.2,
 * and the zoom note design-v1-weather-zoom.md): in CSS px from an identity
 * transform, clipped to the scene on screen. Marks are batched to one path
 * for each color and fade third, and fog to a pattern fill for each sheet
 * and octave. It reads the field and never steps it, so a camera draw
 * shows the same moment a tick drew.
 */

/**
 * What the e2e hooks read of a draw (WeatherLayer.tsx), filled only when a
 * test asks. Both count only marks seen: their center before sway inside
 * the scene's outline on screen (the clip, the Isometric diamond too) and
 * on the screen itself.
 */
export type DrawProbe = {
  /** Up to `limit` marks by "level particle cx cy": the center before sway, then the drawn center. */
  spots: Record<string, [number, number, number, number]>;
  limit: number;
  /** The marks seen, each by the alpha it draws at: its third, or a leaf's fade. */
  marks: number;
};

export type DrawFrame = {
  /** The weather layer's own stage as it draws: x, y and scaleX. */
  camera: Camera;
  /** The scene on screen as a polygon, x and y pairs in CSS px, or null for the whole screen. */
  clip: ArrayLike<number> | null;
  /** The weather is held still (Still, reduced motion, Low power, stepped down), so nothing falls to hide a streak that appears. */
  held?: boolean;
  probe?: DrawProbe;
};

/**
 * The zoom at which a noise sheet draws at its own size. A sheet is drawn
 * at two octaves, as particles are at two levels (sim.ts levelsAt): the
 * coarse one at once to twice its size, the fine one at half to once,
 * their alphas crossfading by where the zoom stands in its octave. So fog
 * keeps its place on the ground at every zoom, with no clamp.
 */
export const SHEET_SCALE_AT = 50;

/**
 * A mark's fade drawn in thirds, so a batched kind keeps a few paths a
 * color: 0 draws nothing. Rounded, so the thirds average the fade.
 */
export function tierOf(alpha: number): number {
  return Math.round(alpha * 3);
}

/**
 * Moving streaks fall or blow at 250 px a second and more, so one that
 * appears where a share grows reads as one more falling in: they draw
 * whole or not at all, at the fade's midpoint, and keep one path a color.
 * Held still nothing falls, so they fade in thirds like the slow kinds.
 */
function streakTier(alpha: number, held: boolean): number {
  if (held) return tierOf(alpha);
  return alpha >= 0.5 ? 3 : 0;
}

/** Leaves are one drawImage each, so they fade exactly and need no third. */
function leafTier(alpha: number): number {
  return alpha > 0 ? 3 : 0;
}

/** Marks collected for one draw, reused between draws: a draw writes here, never to the field. */
const marks = {
  x: new Float64Array(0),
  y: new Float64Array(0),
  i: new Uint32Array(0),
  alpha: new Float64Array(0),
  turn: new Float64Array(0),
  /** Color times 4 plus fade third: the batch a mark draws in. */
  bucket: new Uint8Array(0),
  /** The marks sorted by bucket, and where each bucket starts (24 buckets, six leaf shapes at most, plus one). */
  order: new Uint32Array(0),
  starts: new Uint32Array(26),
  n: 0,
};

/** A probe's key for each mark, while a draw fills a probe. */
const probeKeys: (string | undefined)[] = [];

function room(n: number): void {
  if (marks.x.length >= n) return;
  const size = Math.max(n, marks.x.length * 2, 256);
  const grow = <T extends Float64Array | Uint32Array | Uint8Array>(a: T, make: (k: number) => T): T => {
    const b = make(size);
    b.set(a as never);
    return b;
  };
  marks.x = grow(marks.x, (k) => new Float64Array(k));
  marks.y = grow(marks.y, (k) => new Float64Array(k));
  marks.i = grow(marks.i, (k) => new Uint32Array(k));
  marks.alpha = grow(marks.alpha, (k) => new Float64Array(k));
  marks.turn = grow(marks.turn, (k) => new Float64Array(k));
  marks.bucket = grow(marks.bucket, (k) => new Uint8Array(k));
  marks.order = new Uint32Array(size);
}

/** Whether (x, y) is inside a polygon of x and y pairs, by the even-odd rule. */
export function insidePolygon(poly: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = poly.length >> 1;
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const ax = poly[a * 2]!;
    const ay = poly[a * 2 + 1]!;
    const bx = poly[b * 2]!;
    const by = poly[b * 2 + 1]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/**
 * Gathers the marks of one draw and sorts them by bucket in one counting
 * pass, so each color and third is one walk over its own marks, however
 * many colors a kind has.
 */
function collect(field: Field, camera: Camera, box: readonly [number, number, number, number], colors: number, tierFor: (alpha: number) => number, exact: boolean, probe: DrawProbe | undefined, clip: ArrayLike<number> | null): void {
  marks.n = 0;
  probeKeys.length = 0;
  const shade = field.shade;
  let probed = 0;
  eachMark(field, camera, box[0], box[1], box[2], box[3], (i, x, y, alpha, turn, level, cx, cy) => {
    const tier = tierFor(alpha);
    if (tier === 0) return;
    room(marks.n + 1);
    const k = marks.n++;
    marks.x[k] = x;
    marks.y[k] = y;
    marks.i[k] = i;
    marks.alpha[k] = alpha;
    marks.turn[k] = turn;
    marks.bucket[k] = (colors > 1 ? shade[i]! : 0) * 4 + tier;
    if (probe && x >= 0 && y >= 0 && x <= field.width && y <= field.height && (!clip || clip.length < 6 || insidePolygon(clip, x, y))) {
      probe.marks += exact ? alpha : tier / 3;
      if (probed < probe.limit) {
        const key = `${level} ${i} ${cx} ${cy}`;
        probe.spots[key] = [x, y, x, y];
        probeKeys[k] = key;
        probed++;
      }
    }
  });
  const starts = marks.starts;
  starts.fill(0);
  for (let k = 0; k < marks.n; k++) starts[marks.bucket[k]! + 1]!++;
  for (let b = 1; b < starts.length; b++) starts[b] = starts[b]! + starts[b - 1]!;
  const at = starts.slice();
  for (let k = 0; k < marks.n; k++) marks.order[at[marks.bucket[k]!]!++] = k;
}

/** A probe's record of mark k as drawn: its drawn center. */
function probeDrawn(probe: DrawProbe, k: number, x: number, y: number): void {
  const key = probeKeys[k];
  const spot = key === undefined ? undefined : probe.spots[key];
  if (spot) {
    spot[2] = x;
    spot[3] = y;
  }
}

/** The scene's outline on screen: its bounds through the view's turn and squash, then the camera. */
export function sceneClip(view: View, bounds: { w: number; h: number }, camera: Camera): Float64Array {
  const out = new Float64Array(8);
  const corners = [
    [0, 0],
    [bounds.w, 0],
    [bounds.w, bounds.h],
    [0, bounds.h],
  ] as const;
  for (let k = 0; k < 4; k++) {
    const p = viewToScreen(camera, toView(view, { x: corners[k]![0], y: corners[k]![1] }));
    out[k * 2] = p.x;
    out[k * 2 + 1] = p.y;
  }
  return out;
}

function wrap(v: number, size: number): number {
  return v - size * Math.floor(v / size);
}

/** A pattern per context and image, made once: a pattern belongs to the context that made it. */
const patterns = new WeakMap<object, Map<CanvasImageSource, CanvasPattern | null>>();

function patternOf(g: CanvasRenderingContext2D, image: CanvasImageSource): CanvasPattern | null {
  let mine = patterns.get(g);
  if (!mine) patterns.set(g, (mine = new Map()));
  if (!mine.has(image)) mine.set(image, g.createPattern(image, "repeat"));
  return mine.get(image) ?? null;
}

export function drawWeather(g: CanvasRenderingContext2D, field: Field, frame: DrawFrame, textures: TextureSource | null): void {
  const { look, width, height } = field;
  const { camera, clip, probe } = frame;
  const held = frame.held === true;
  // What of the screen the scene covers: marks outside it are skipped rather than drawn into the clip.
  let x0 = 0;
  let y0 = 0;
  let x1 = width;
  let y1 = height;
  if (clip && clip.length >= 6) {
    x0 = Infinity;
    y0 = Infinity;
    x1 = -Infinity;
    y1 = -Infinity;
    for (let k = 0; k + 1 < clip.length; k += 2) {
      x0 = Math.min(x0, clip[k]!);
      x1 = Math.max(x1, clip[k]!);
      y0 = Math.min(y0, clip[k + 1]!);
      y1 = Math.max(y1, clip[k + 1]!);
    }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(width, x1);
    y1 = Math.min(height, y1);
  }
  if (x1 <= x0 || y1 <= y0) return;

  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.beginPath();
  if (clip && clip.length >= 6) {
    g.moveTo(clip[0]!, clip[1]!);
    for (let k = 2; k + 1 < clip.length; k += 2) g.lineTo(clip[k]!, clip[k + 1]!);
    g.closePath();
  } else g.rect(0, 0, width, height);
  g.clip();

  if (look.veil) {
    g.globalAlpha = look.veil.alpha;
    g.fillStyle = look.veil.color;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  if (look.sheets.length && textures) {
    const octave = Math.log2(camera.scale / SHEET_SCALE_AT);
    const u = octave - Math.floor(octave);
    // The coarse octave grows from once to twice the sheet's size while it hands over to the fine one, which then stands alone at once its size.
    const blend = u * u * (3 - 2 * u);
    for (let j = 0; j < look.sheets.length; j++) {
      const sheet = look.sheets[j]!;
      const image = textures.noise(sheet.color);
      const pattern = image && patternOf(g, image);
      if (!pattern) continue;
      // The bank's anchor on screen: its drift in view units through the camera.
      const anchor = viewToScreen(camera, { x: field.sheets[j * 2]!, y: field.sheets[j * 2 + 1]! } as ViewPoint);
      for (const [k, weight] of [[0, 1 - blend], [-1, blend]] as const) {
        if (weight < 0.02) continue;
        const scale = sheet.scale * 2 ** (u + k);
        const period = NOISE_SIZE * scale;
        // The pattern repeats from the transform's origin, so an origin a whole number of periods from the anchor holds the banks to the ground.
        const ox = wrap(anchor.x, period) - period;
        const oy = wrap(anchor.y, period) - period;
        g.setTransform(scale, 0, 0, scale, ox, oy);
        g.globalAlpha = sheet.alpha * weight;
        g.fillStyle = pattern;
        g.fillRect((x0 - ox) / scale, (y0 - oy) / scale, (x1 - x0) / scale, (y1 - y0) / scale);
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  const p = look.particles;
  if (p && field.active > 0) {
    const speed = Math.hypot(field.vx, field.vy) || 1;
    const ux = field.vx / speed;
    const uy = field.vy / speed;
    // Sway runs across the motion, in screen px, as part of a mark's look (D-261106-297).
    const sx = -uy;
    const sy = ux;
    const seconds = field.t / 1000;
    const swayTurn = Math.PI * 2 * p.swayHz * seconds;
    const reach = WRAP_MARGIN;
    const box = [x0 - reach, y0 - reach, x1 + reach, y1 + reach] as const;
    const { size, shade } = field;
    const leaf = p.shape === "leaf";
    const streak = p.shape === "streak";
    const colors = leaf ? 1 : p.colors.length;
    collect(field, camera, box, colors, streak ? (a) => streakTier(a, held) : leaf ? leafTier : tierOf, leaf, probe, clip);
    const { x: mxs, y: mys, i: mis, alpha: mas, turn: mts, order, starts } = marks;

    if (leaf) {
      const atlas = textures?.leaves() ?? null;
      if (atlas) {
        const { spin } = field;
        for (let o = 0; o < marks.n; o++) {
          const k = order[o]!;
          const i = mis[k]!;
          const phase = mts[k]! * Math.PI * 2;
          const s = p.sway * Math.sin(phase + swayTurn);
          const mx = mxs[k]! + sx * s;
          const my = mys[k]! + sy * s;
          const turn = phase + Math.PI * 2 * spin[i]! * seconds;
          // The leaf also tumbles: its width narrows and widens as it turns over, slower than it spins.
          const flip = 0.5 + 0.5 * Math.abs(Math.cos(turn * 0.6));
          // The atlas draws each leaf 20 px long in its 24 px cell, so a leaf of `size` is that long on screen.
          const kk = size[i]! / (LEAF_CELL - 4);
          const cos = Math.cos(turn) * kk;
          const sin = Math.sin(turn) * kk;
          g.globalAlpha = p.alpha * mas[k]!;
          g.setTransform(cos * flip, sin * flip, -sin, cos, mx, my);
          g.drawImage(atlas, shade[i]! * LEAF_CELL, 0, LEAF_CELL, LEAF_CELL, -LEAF_CELL / 2, -LEAF_CELL / 2, LEAF_CELL, LEAF_CELL);
          if (probe) probeDrawn(probe, k, mx, my);
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
      }
    } else {
      // A streak is as long as it travels: faster marks blur further, as a strong wind's rain does.
      const stretch = Math.max(1, speed);
      if (streak) {
        g.lineWidth = p.width;
        g.lineCap = "butt";
      }
      for (let c = 0; c < colors; c++) {
        for (let tier = 3; tier >= 1; tier--) {
          const b = c * 4 + tier;
          const from = starts[b]!;
          const to = starts[b + 1]!;
          if (from === to) continue;
          g.beginPath();
          for (let o = from; o < to; o++) {
            const k = order[o]!;
            const i = mis[k]!;
            let mx = mxs[k]!;
            let my = mys[k]!;
            if (streak) {
              // Each copy of a particle is its own length, within 15% of the particle's, so two copies on a big screen are not twins.
              const len = size[i]! * stretch * (0.85 + 0.3 * mts[k]!);
              g.moveTo(mx, my);
              g.lineTo(mx - ux * len, my - uy * len);
            } else {
              const s = p.sway * Math.sin(mts[k]! * Math.PI * 2 + swayTurn);
              mx += sx * s;
              my += sy * s;
              const r = size[i]!;
              if (p.shape === "disc") {
                g.moveTo(mx + r, my);
                g.arc(mx, my, r, 0, Math.PI * 2);
              } else g.rect(mx - r / 2, my - r / 3, r, (r * 2) / 3);
            }
            if (probe) probeDrawn(probe, k, mx, my);
          }
          g.globalAlpha = (p.alpha * tier) / 3;
          if (streak) {
            g.strokeStyle = p.colors[c]!;
            g.stroke();
          } else {
            g.fillStyle = p.colors[c]!;
            g.fill();
          }
        }
      }
    }

    if (field.rings.length && field.view.kind === "topDown") {
      let any = false;
      g.beginPath();
      for (let r = 0; r < field.rings.length; r += 3) {
        const age = field.rings[r + 2]!;
        if (age < 0) continue;
        const { x: mx, y: my } = viewToScreen(camera, { x: field.rings[r]!, y: field.rings[r + 1]! } as ViewPoint);
        const radius = 2 + 4 * (age / RING_MS);
        g.moveTo(mx + radius, my);
        g.arc(mx, my, radius, 0, Math.PI * 2);
        any = true;
      }
      if (any) {
        g.globalAlpha = p.alpha;
        g.lineWidth = 1;
        g.strokeStyle = p.colors[0]!;
        g.stroke();
      }
    }
  }
  g.restore();
}
