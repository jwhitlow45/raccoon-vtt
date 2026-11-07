import { MAX_SCALE, MIN_SCALE, screenToView, viewToScreen, type Camera, type Point } from "../../lib/camera.ts";
import { turnAxes, type View, type ViewPoint } from "../../lib/view.ts";
import type { Look } from "./looks.ts";

/**
 * The weather's particles (the weather design note, 5.2 and 5.3, and the
 * zoom note design-v1-weather-zoom.md). Particles live in the stage's own
 * plane, the view space the camera maps to the screen, in square tiles
 * that repeat across it. So a pan and a zoom move every mark's center
 * exactly as they move the ground, and a camera draw needs nothing but the
 * field and the camera.
 *
 * A zoom changes how big a tile is on screen, so the field keeps one set of
 * particles per power-of-two level of the zoom, and a draw mixes the two
 * levels whose tiles stand nearest the field's tile size (levelsAt): the
 * coarse level's tile is one to two tile sizes across on screen, the fine
 * one's half that, and their shares hold the marks per screen area
 * constant at every zoom. Marks keep their screen size, speed and sway.
 * Only the controller's tick steps a field.
 */

/**
 * A tick never moves the field by more than this, so a tab back after a
 * minute does not throw it: the mode's longest step, the one after a held
 * frame (mode.ts HELD_STEP_MS). Every other step the mode clamps to 50 ms.
 */
export const STEP_CLAMP_MS = 100;

/** How far past each screen edge marks still draw, so a mark never pops in or out at an edge. */
export const WRAP_MARGIN = 64;

/** The smallest tile, in CSS px: a phone's wrap box fits inside it. */
export const MIN_TILE = 1024;
/** Tiles grow in steps of this, so a window dragged wider makes a new field a few times, not on every frame. */
const TILE_STEP = 256;
/** The coarsest and the finest level any camera draws, from the camera's own range: the coarse level at MIN_SCALE, and the fine one at MAX_SCALE. */
export const LEVEL_MIN = Math.floor(Math.log2(MIN_SCALE));
export const LEVEL_MAX = Math.floor(Math.log2(MAX_SCALE)) + 1;
const LEVELS = LEVEL_MAX - LEVEL_MIN + 1;

/**
 * The tile for a screen: at least the wrap box's long side, so the coarse
 * level never shows a particle twice across it.
 */
export function tileFor(width: number, height: number): number {
  const long = Math.max(width, height) + 2 * WRAP_MARGIN;
  return Math.max(MIN_TILE, Math.ceil(long / TILE_STEP) * TILE_STEP);
}

/**
 * Whether a field's tile still fits a screen of this size: the wrap box's
 * long side fits inside it, and is not under half of it, where the walk
 * would visit four times the particles it needs. A tile that no longer
 * fits makes a new field, which reshuffles the weather once.
 */
export function tileFits(tile: number, width: number, height: number): boolean {
  const want = tileFor(width, height);
  return want <= tile && (tile === MIN_TILE || want * 2 > tile);
}

export type Field = {
  /** What it draws. Only a look of the same key replaces it (setFieldLook), so the particles it made still fit. */
  look: Look;
  view: View;
  /** The screen in CSS px. */
  width: number;
  height: number;
  /** The tile's size on screen, in CSS px, at the zoom where its level is the coarse one and its share is whole (tileFor). Fixed for the field's life. */
  readonly tile: number;
  /** Particles each level's tile holds at full density, so a draw shows the screen's count (particleCount), and how many draw (half after a step-down). */
  count: number;
  active: number;
  half: boolean;
  /** Each level's particles as fractions of its tile, in [0, 1), LEVEL_MIN first. Grown in place when a resize needs more (resizeField). */
  x: Float64Array[];
  y: Float64Array[];
  /**
   * How many times each level's particle has wrapped across its tile, each
   * way, written by the step. A copy of a particle on screen is the copy in
   * tile (mx, my), so mx − wraps names the same moving copy before and
   * after it crosses a tile's edge: its phase and offset come from that.
   */
  wx: Int32Array[];
  wy: Int32Array[];
  /** What each particle was made with, shared by every level. */
  speed: Float32Array;
  size: Float32Array;
  spin: Float32Array;
  shade: Uint8Array;
  /** The screen direction a particle moves per unit of its speed (5.2's wind on screen). */
  vx: number;
  vy: number;
  /** Ms the field has run, for sway and spin. */
  t: number;
  /** Each sheet's drift in view units, x then y. */
  readonly sheets: Float64Array;
  /** Splash rings: view x, view y and age in ms, for heavy rain in Top-down. */
  readonly rings: Float64Array;
  readonly seed: number;
  /** Drops landed on screen so far, as a running total, for the one in `splashEvery` that rings. */
  landed: number;
};

export type FieldOptions = { width: number; height: number; view: View; seed?: number; half?: boolean };

/** Rings alive at once, and how long each lives. */
export const RING_SLOTS = 8;
export const RING_MS = 400;

/** Calm falling marks lean this far off vertical in Top-down, so rain seen from above still reads as falling. */
const TILT = (15 * Math.PI) / 180;
/** In Top-down with a wind, the screen-down part's share of a falling mark's speed: the wind leads, the fall still shows. */
const WINDY_FALL = 0.35;
/** In Isometric the wind drifts at half its Top-down rate, so a wind away from the viewer never stops the fall. */
const ISO_DRIFT = 0.5;
/** A calm blowing sand still moves, slowly, toward the default direction. */
const CALM_ALONG = 0.5;

/** A 32-bit mix of the seed, the particle and which of its numbers, in [0, 1). Per index, so a particle made again is the same particle. */
function hash01(seed: number, i: number, k: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A copy's own number in [0, 1), from its particle, level and copy, the same at every zoom and for the copy's whole life. */
function copyHash(seed: number, i: number, level: number, cx: number, cy: number, k: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(level + 1, 0x632be5ab) ^ Math.imul(cx | 0, 0x85ebca77) ^ Math.imul(cy | 0, 0xc2b2ae3d) ^ Math.imul(k + 1, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function between(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/** Marks on a screen of this size at full density, capped (5.3). */
export function particleCount(look: Look, width: number, height: number): number {
  const p = look.particles;
  if (!p || width <= 0 || height <= 0) return 0;
  return Math.min(p.cap, Math.round((p.perArea * width * height) / 100_000));
}

/**
 * Particles a tile holds for a screen of this size. The screen's count
 * (particleCount) was always spread over the wrap box, the screen and
 * WRAP_MARGIN a side, so a screen showed that share of it. A tile holds
 * the same density, so the weather looks as dense as it did.
 */
export function tileCount(look: Look, width: number, height: number, tile: number): number {
  const marks = particleCount(look, width, height);
  if (marks === 0) return 0;
  return Math.round((marks * tile * tile) / ((width + 2 * WRAP_MARGIN) * (height + 2 * WRAP_MARGIN)));
}

/**
 * The two levels a camera at `scale` draws and their shares. The coarse
 * level's tile is the tile size times 2^u px across and the fine one's
 * half that. Shares of (4 - 4^u) / 3 and (4^u - 1) / 3 keep the marks per
 * screen area the same at every u, and each level's share runs smoothly to
 * 0 at the zoom where it stops being drawn, so nothing jumps at a level's
 * edge.
 */
export function levelsAt(scale: number): { coarse: number; u: number; coarseShare: number; fineShare: number } {
  const l = Math.log2(Math.max(scale, 1e-9));
  const coarse = Math.min(LEVEL_MAX - 1, Math.max(LEVEL_MIN, Math.floor(l)));
  const u = Math.min(1, Math.max(0, l - coarse));
  const p = 4 ** u;
  return { coarse, u, coarseShare: (4 - p) / 3, fineShare: (p - 1) / 3 };
}

/** A level's tile on screen, in CSS px, at `scale`. */
export function tileOnScreen(field: Field, level: number, scale: number): number {
  return (field.tile * scale) / 2 ** level;
}

/** The map's wind as a screen direction: Top-down as it is, Isometric turned and halved as the ground is. */
export function windOnScreen(toward: number, view: View): Point {
  const a = (toward * Math.PI) / 180;
  const wx = Math.sin(a);
  const wy = -Math.cos(a);
  if (view.kind === "topDown") return { x: wx, y: wy };
  const { c, s } = turnAxes(view.turn);
  return { x: c * wx - s * wy, y: (s * wx + c * wy) / 2 };
}

/** The screen direction a mark moves per unit of its speed (5.2's wind on screen). */
export function motionOf(look: Look, view: View): Point {
  const w = windOnScreen(look.toward, view);
  const p = look.particles;
  if (!p || !p.falls) {
    // Fog's sheets and the kinds that blow along the wind.
    const along = look.wind === 0 && p ? CALM_ALONG : 1;
    return { x: w.x * along, y: w.y * along };
  }
  if (view.kind === "topDown") {
    const fall = p.drift === 0 ? 1 : WINDY_FALL;
    return { x: Math.sin(TILT) * fall + w.x * p.drift, y: Math.cos(TILT) * fall + w.y * p.drift };
  }
  return { x: w.x * p.drift * ISO_DRIFT, y: 1 + w.y * p.drift * ISO_DRIFT };
}

function makeParticle(field: Field, i: number): void {
  const p = field.look.particles!;
  const r = (k: number) => hash01(field.seed, i, k);
  for (let l = 0; l < LEVELS; l++) {
    field.x[l]![i] = hash01(field.seed, i, 100 + 2 * l);
    field.y[l]![i] = hash01(field.seed, i, 101 + 2 * l);
    field.wx[l]![i] = 0;
    field.wy[l]![i] = 0;
  }
  field.speed[i] = between(p.speed, r(2));
  field.size[i] = between(p.size, r(3));
  field.spin[i] = p.spin ? between(p.spin, r(5)) * (r(6) < 0.5 ? -1 : 1) : 0;
  field.shade[i] = Math.floor(r(7) * (p.shape === "leaf" ? 6 : p.colors.length));
}

function activeOf(count: number, half: boolean): number {
  return half ? Math.ceil(count / 2) : count;
}

/** Room for `n` particles a level, keeping every particle already made where it was. */
function ensureRoom(field: Field, n: number): void {
  if (field.speed.length >= n) return;
  const old = field.speed.length;
  const grow = <T extends Float64Array | Float32Array | Int32Array | Uint8Array>(a: T, make: (k: number) => T): T => {
    const b = make(n);
    b.set(a as never);
    return b;
  };
  field.x = field.x.map((a) => grow(a, (k) => new Float64Array(k)));
  field.y = field.y.map((a) => grow(a, (k) => new Float64Array(k)));
  field.wx = field.wx.map((a) => grow(a, (k) => new Int32Array(k)));
  field.wy = field.wy.map((a) => grow(a, (k) => new Int32Array(k)));
  field.speed = grow(field.speed, (k) => new Float32Array(k));
  field.size = grow(field.size, (k) => new Float32Array(k));
  field.spin = grow(field.spin, (k) => new Float32Array(k));
  field.shade = grow(field.shade, (k) => new Uint8Array(k));
  for (let i = old; i < n; i++) makeParticle(field, i);
}

export function createField(look: Look, options: FieldOptions): Field {
  const motion = motionOf(look, options.view);
  const tile = tileFor(options.width, options.height);
  const field: Field = {
    look,
    view: options.view,
    width: options.width,
    height: options.height,
    tile,
    count: 0,
    active: 0,
    half: options.half ?? false,
    x: Array.from({ length: LEVELS }, () => new Float64Array(0)),
    y: Array.from({ length: LEVELS }, () => new Float64Array(0)),
    wx: Array.from({ length: LEVELS }, () => new Int32Array(0)),
    wy: Array.from({ length: LEVELS }, () => new Int32Array(0)),
    speed: new Float32Array(0),
    size: new Float32Array(0),
    spin: new Float32Array(0),
    shade: new Uint8Array(0),
    vx: motion.x,
    vy: motion.y,
    t: 0,
    sheets: new Float64Array(look.sheets.length * 2),
    rings: new Float64Array(look.particles?.splashEvery ? RING_SLOTS * 3 : 0).fill(-1),
    seed: (options.seed ?? 1) >>> 0,
    landed: 0,
  };
  field.count = tileCount(look, field.width, field.height, tile);
  field.active = activeOf(field.count, field.half);
  if (look.particles) ensureRoom(field, field.count);
  for (let j = 0; j < look.sheets.length; j++) {
    field.sheets[j * 2] = hash01(field.seed, 10_000 + j, 0) * 256;
    field.sheets[j * 2 + 1] = hash01(field.seed, 10_000 + j, 1) * 256;
  }
  return field;
}

/**
 * Moves the field by `ms`, clamped to STEP_CLAMP_MS, at the camera its
 * layer's stage holds now: the only thing that moves it. Marks move at
 * their screen speed, so each level's step in tile fractions reads the
 * zoom. Only the particles this zoom's shares draw move. The others hold,
 * which no one can see.
 */
export function stepField(field: Field, ms: number, camera: Camera): void {
  const dt = Math.min(STEP_CLAMP_MS, Math.max(0, ms)) / 1000;
  if (dt === 0) return;
  field.t += dt * 1000;
  const scale = camera.scale;
  const { coarse, coarseShare, fineShare } = levelsAt(scale);
  const { vx, vy, speed } = field;
  for (let level = coarse; level <= coarse + 1; level++) {
    const tile = tileOnScreen(field, level, scale);
    const ax = vx / tile;
    const ay = vy / tile;
    const l = level - LEVEL_MIN;
    const xs = field.x[l]!;
    const ys = field.y[l]!;
    const wxs = field.wx[l]!;
    const wys = field.wy[l]!;
    // One a share takes in later starts where it was left, which no one saw.
    const end = shareEnd(field, level === coarse ? coarseShare : fineShare).last;
    for (let i = 0; i < end; i++) {
      const d = speed[i]! * dt;
      const nx = xs[i]! + ax * d;
      const ny = ys[i]! + ay * d;
      if (nx >= 0 && nx < 1) xs[i] = nx;
      else {
        const w = Math.floor(nx);
        xs[i] = nx - w;
        wxs[i] = wxs[i]! + w;
      }
      if (ny >= 0 && ny < 1) ys[i] = ny;
      else {
        const w = Math.floor(ny);
        ys[i] = ny - w;
        wys[i] = wys[i]! + w;
      }
    }
  }
  for (let r = 2; r < field.rings.length; r += 3) if (field.rings[r]! >= 0) field.rings[r] = field.rings[r]! + dt * 1000 >= RING_MS ? -1 : field.rings[r]! + dt * 1000;
  const p = field.look.particles;
  const splashEvery = field.view.kind === "topDown" ? (p?.splashEvery ?? 0) : 0;
  if (p && splashEvery) {
    // Drops land at the rate the screen's marks fall through it, the rate today's wrap box counted.
    const marks = activeOf(particleCount(field.look, field.width, field.height), field.half);
    const before = Math.floor(field.landed / splashEvery);
    field.landed += (marks * ((p.speed[0] + p.speed[1]) / 2) * Math.abs(vy) * dt) / (field.height + 2 * WRAP_MARGIN);
    for (let n = before; n < Math.floor(field.landed / splashEvery); n++) ring(field, n, camera);
  }
  const sheetMove = windOnScreen(field.look.toward, field.view);
  for (let j = 0; j < field.look.sheets.length; j++) {
    // In view units, so a bank keeps its place on the ground through a zoom and drifts at its screen speed.
    const v = (field.look.sheets[j]!.speed * dt) / scale;
    field.sheets[j * 2] = field.sheets[j * 2]! + sheetMove.x * v;
    field.sheets[j * 2 + 1] = field.sheets[j * 2 + 1]! + sheetMove.y * v;
  }
}

/** A ring somewhere on the screen, kept where it fell on the ground. */
function ring(field: Field, n: number, camera: Camera): void {
  const rings = field.rings;
  let slot = -1;
  for (let s = 0; s < RING_SLOTS; s++) if (rings[s * 3 + 2]! < 0) { slot = s; break; }
  if (slot < 0) return;
  const at = screenToView(camera, { x: hash01(field.seed, n, 20) * field.width, y: hash01(field.seed, n, 21) * field.height });
  rings[slot * 3] = at.x;
  rings[slot * 3 + 1] = at.y;
  rings[slot * 3 + 2] = 0;
}

/**
 * A new screen size that the field's tile still fits (tileFits): recounts
 * by area, making the particles it needs past the ones it has. Particles
 * stay on the ground where they were, so none jump.
 */
export function resizeField(field: Field, width: number, height: number): void {
  field.width = width;
  field.height = height;
  field.count = tileCount(field.look, width, height, field.tile);
  field.active = activeOf(field.count, field.half);
  if (field.look.particles) ensureRoom(field, field.count);
}

/**
 * The same weather blowing another way: the particles stay where they are
 * and move along the new direction from the next step. Only a look of the
 * same key, since a new kind, strength or wind makes particles of its own.
 */
export function setFieldLook(field: Field, look: Look): void {
  if (look.key !== field.look.key) throw new Error(`a field of ${field.look.key} cannot draw ${look.key}`);
  field.look = look;
  const m = motionOf(look, field.view);
  field.vx = m.x;
  field.vy = m.y;
}

/** Top-down or Isometric at a turn: the wind's direction on screen changes, the particles stay. */
export function setFieldView(field: Field, view: View): void {
  field.view = view;
  const m = motionOf(field.look, view);
  field.vx = m.x;
  field.vy = m.y;
  if (view.kind !== "topDown") field.rings.fill(-1);
}

/** Half the particles, the step-down's first step (6.3), or all again for a new field. */
export function setHalf(field: Field, half: boolean): void {
  field.half = half;
  field.active = activeOf(field.count, half);
}

const VIEW_ORIGIN = { x: 0, y: 0 } as ViewPoint;

/** The fade band: 15% of a tile's active particles, centered on the end of a level's share, so a zoom never pops a slow mark. */
export const FADE = 0.15;

/**
 * Where a level's share of the particles ends: each mark's alpha runs from
 * 1 to 0 over the `fade` particles centered on the share's end, `edge` past
 * which nothing draws, and runs smoothly to nothing as a share nears 0. The
 * alphas sum to about the share, short by at most an eighth of the band at
 * either end: near a share's start, and where a full share cuts the band
 * at the active count. `last` particles draw.
 */
function shareEnd(field: Field, share: number): { edge: number; fade: number; last: number } {
  const fade = Math.max(1, FADE * field.active);
  const n = share * field.active;
  const edge = n < fade / 2 ? 2 * n : n + fade / 2;
  return { edge, fade, last: edge > 0 ? Math.min(field.active, Math.ceil(edge)) : 0 };
}

/**
 * Every mark a camera draws inside the box, before sway, as `visit(i, x,
 * y, alpha, turn, level, cx, cy)`: each copy of particle i of the coarse
 * and the fine level on screen, one copy a tile. `alpha` is the share's
 * fade. (cx, cy) names the copy for its whole life, across tile edges (the
 * tile it stands in less the particle's wraps), and `turn`, a number in
 * [0, 1) from that name, sets the copy's sway and spin phase and a streak's
 * length, so copies of one particle never move in step, and a copy keeps
 * its phase as it crosses a tile's edge and at every zoom. It reads the
 * field only.
 */
export function eachMark(
  field: Field,
  camera: Camera,
  left: number,
  top: number,
  right: number,
  bottom: number,
  visit: (i: number, x: number, y: number, alpha: number, turn: number, level: number, cx: number, cy: number) => void,
): void {
  // A stage not yet scaled reads as 1 (cameraOfStage), under MIN_SCALE: its tiles would be a few px and repeat thousands of times.
  if (camera.scale < 2 ** LEVEL_MIN) return;
  const { coarse, coarseShare, fineShare } = levelsAt(camera.scale);
  // Where the plane's origin stands on screen: each tile's corner is a whole number of tiles from it.
  const origin = viewToScreen(camera, VIEW_ORIGIN);
  for (let level = coarse; level <= coarse + 1; level++) {
    const { edge, fade, last } = shareEnd(field, level === coarse ? coarseShare : fineShare);
    if (last <= 0) continue;
    const tile = tileOnScreen(field, level, camera.scale);
    const l = level - LEVEL_MIN;
    const xs = field.x[l]!;
    const ys = field.y[l]!;
    const wxs = field.wx[l]!;
    const wys = field.wy[l]!;
    for (let i = 0; i < last; i++) {
      const alpha = Math.min(1, (edge - i) / fade);
      if (alpha <= 0) continue;
      const bx = origin.x + xs[i]! * tile;
      const by = origin.y + ys[i]! * tile;
      const mx0 = Math.ceil((left - bx) / tile);
      const my0 = Math.ceil((top - by) / tile);
      for (let my = my0; by + my * tile <= bottom; my++) {
        for (let mx = mx0; bx + mx * tile <= right; mx++) {
          const cx = mx - wxs[i]!;
          const cy = my - wys[i]!;
          visit(i, bx + mx * tile, by + my * tile, alpha, copyHash(field.seed, i, level, cx, cy, 2), level, cx, cy);
        }
      }
    }
  }
}
