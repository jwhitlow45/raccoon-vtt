import type { Point } from "../../lib/camera.ts";
import { turnAxes, type View } from "../../lib/view.ts";
import type { Look } from "./looks.ts";

/**
 * The weather's particles in screen space (the weather design note, 5.2 and
 * 5.3). Each particle keeps its own drift inside a wrap box the size of the
 * screen plus a margin, and shows at its drift plus the stage's pan, wrapped
 * into that box, so a pan carries the weather with the ground. Only the
 * controller's tick steps a field. A draw reads it.
 */

/** A tick never moves the field by more than this, so a tab back after a minute does not throw it. */
export const STEP_CLAMP_MS = 50;

/** How far past each screen edge the wrap box reaches, so a mark never pops in or out at an edge. */
export const WRAP_MARGIN = 64;

export type Field = {
  /** What it draws. Only a look of the same key replaces it (setFieldLook), so the particles it made still fit. */
  look: Look;
  view: View;
  /** The screen in CSS px. */
  width: number;
  height: number;
  /** The wrap box: the screen plus WRAP_MARGIN on every side. */
  boxW: number;
  boxH: number;
  /** Particles for the whole screen, and how many draw (half after a step-down). */
  count: number;
  active: number;
  half: boolean;
  /** Each particle's drift in the wrap box, and what it was made with. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly speed: Float64Array;
  readonly size: Float64Array;
  readonly phase: Float64Array;
  readonly spin: Float64Array;
  readonly shade: Uint8Array;
  /** The screen direction a particle moves per unit of its speed (5.2's wind on screen). */
  vx: number;
  vy: number;
  /** Ms the field has run, for sway and spin. */
  t: number;
  /** Each sheet's drift, x then y. */
  readonly sheets: Float64Array;
  /** Splash rings: drift x, drift y and age in ms, for heavy rain in Top-down. */
  readonly rings: Float64Array;
  readonly seed: number;
  /** Drops landed so far, for the one in `splashEvery` that rings. */
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

/** A 32-bit mix of the seed, the particle and which of its numbers, in [0, 1). Per index, so a particle made again after a resize is the same particle. */
function hash01(seed: number, i: number, k: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function wrap(v: number, size: number): number {
  return v - size * Math.floor(v / size);
}

function between(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/** Particles for a screen of this size at full density, capped (5.3). */
export function particleCount(look: Look, width: number, height: number): number {
  const p = look.particles;
  if (!p || width <= 0 || height <= 0) return 0;
  return Math.min(p.cap, Math.round((p.perArea * width * height) / 100_000));
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
  field.x[i] = r(0) * field.boxW;
  field.y[i] = r(1) * field.boxH;
  field.speed[i] = between(p.speed, r(2));
  field.size[i] = between(p.size, r(3));
  field.phase[i] = r(4) * Math.PI * 2;
  field.spin[i] = p.spin ? between(p.spin, r(5)) * (r(6) < 0.5 ? -1 : 1) : 0;
  field.shade[i] = Math.floor(r(7) * (p.shape === "leaf" ? 6 : p.colors.length));
}

function activeOf(count: number, half: boolean): number {
  return half ? Math.ceil(count / 2) : count;
}

export function createField(look: Look, options: FieldOptions): Field {
  const cap = look.particles?.cap ?? 0;
  const motion = motionOf(look, options.view);
  const field: Field = {
    look,
    view: options.view,
    width: options.width,
    height: options.height,
    boxW: options.width + 2 * WRAP_MARGIN,
    boxH: options.height + 2 * WRAP_MARGIN,
    count: 0,
    active: 0,
    half: options.half ?? false,
    x: new Float64Array(cap),
    y: new Float64Array(cap),
    speed: new Float64Array(cap),
    size: new Float64Array(cap),
    phase: new Float64Array(cap),
    spin: new Float64Array(cap),
    shade: new Uint8Array(cap),
    vx: motion.x,
    vy: motion.y,
    t: 0,
    sheets: new Float64Array(look.sheets.length * 2),
    rings: new Float64Array(look.particles?.splashEvery ? RING_SLOTS * 3 : 0).fill(-1),
    seed: (options.seed ?? 1) >>> 0,
    landed: 0,
  };
  field.count = particleCount(look, field.width, field.height);
  field.active = activeOf(field.count, field.half);
  for (let i = 0; i < field.count; i++) makeParticle(field, i);
  for (let j = 0; j < look.sheets.length; j++) {
    field.sheets[j * 2] = hash01(field.seed, 10_000 + j, 0) * 256;
    field.sheets[j * 2 + 1] = hash01(field.seed, 10_000 + j, 1) * 256;
  }
  return field;
}

/** Moves the field by `ms`, clamped to STEP_CLAMP_MS. The only thing that moves it. */
export function stepField(field: Field, ms: number): void {
  const dt = Math.min(STEP_CLAMP_MS, Math.max(0, ms)) / 1000;
  if (dt === 0) return;
  field.t += dt * 1000;
  const { boxW, boxH, vx, vy, x, y, speed } = field;
  const splashEvery = field.view.kind === "topDown" ? (field.look.particles?.splashEvery ?? 0) : 0;
  for (let i = 0; i < field.active; i++) {
    const d = speed[i]! * dt;
    const nx = x[i]! + vx * d;
    const ny = y[i]! + vy * d;
    x[i] = nx >= 0 && nx < boxW ? nx : wrap(nx, boxW);
    if (ny >= 0 && ny < boxH) y[i] = ny;
    else {
      y[i] = wrap(ny, boxH);
      // A drop that leaves the box has landed. One in `splashEvery` of them rings somewhere on the ground.
      if (splashEvery && ++field.landed % splashEvery === 0) ring(field);
    }
  }
  for (let r = 2; r < field.rings.length; r += 3) if (field.rings[r]! >= 0) field.rings[r] = field.rings[r]! + dt * 1000 >= RING_MS ? -1 : field.rings[r]! + dt * 1000;
  const sheetMove = windOnScreen(field.look.toward, field.view);
  for (let j = 0; j < field.look.sheets.length; j++) {
    const v = field.look.sheets[j]!.speed * dt;
    field.sheets[j * 2] = field.sheets[j * 2]! + sheetMove.x * v;
    field.sheets[j * 2 + 1] = field.sheets[j * 2 + 1]! + sheetMove.y * v;
  }
}

function ring(field: Field): void {
  const rings = field.rings;
  let slot = -1;
  for (let s = 0; s < RING_SLOTS; s++) if (rings[s * 3 + 2]! < 0) { slot = s; break; }
  if (slot < 0) return;
  const n = field.landed;
  rings[slot * 3] = hash01(field.seed, n, 20) * field.boxW;
  rings[slot * 3 + 1] = hash01(field.seed, n, 21) * field.boxH;
  rings[slot * 3 + 2] = 0;
}

/**
 * A new screen size: recounts by area and keeps the first particles where
 * they show at `pan`, the stage's position now, so none jump.
 */
export function resizeField(field: Field, width: number, height: number, pan: Point): void {
  const oldW = field.boxW;
  const oldH = field.boxH;
  const boxW = width + 2 * WRAP_MARGIN;
  const boxH = height + 2 * WRAP_MARGIN;
  const count = particleCount(field.look, width, height);
  const kept = Math.min(field.count, count);
  // Where a mark shows is its drift plus the pan, wrapped into the box, so a new box needs each drift rebased to keep that spot.
  const rebase = (v: number, p: number, oldSize: number, size: number) => wrap(wrap(v + p, oldSize) - p, size);
  for (let i = 0; i < kept; i++) {
    field.x[i] = rebase(field.x[i]!, pan.x, oldW, boxW);
    field.y[i] = rebase(field.y[i]!, pan.y, oldH, boxH);
  }
  for (let r = 0; r < field.rings.length; r += 3) {
    field.rings[r] = rebase(field.rings[r]!, pan.x, oldW, boxW);
    field.rings[r + 1] = rebase(field.rings[r + 1]!, pan.y, oldH, boxH);
  }
  field.width = width;
  field.height = height;
  field.boxW = boxW;
  field.boxH = boxH;
  for (let i = kept; i < count; i++) makeParticle(field, i);
  field.count = count;
  field.active = activeOf(count, field.half);
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

/** Where particle `i` shows on screen at this pan, before sway: its drift plus the pan, wrapped into the box. */
export function spotOf(field: Field, i: number, pan: Point): Point {
  return { x: wrap(field.x[i]! + pan.x, field.boxW) - WRAP_MARGIN, y: wrap(field.y[i]! + pan.y, field.boxH) - WRAP_MARGIN };
}
