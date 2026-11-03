import type { Point } from "../../lib/camera.ts";
import type { View } from "../../lib/view.ts";
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
  readonly look: Look;
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
};

export type FieldOptions = { width: number; height: number; view: View; seed?: number; half?: boolean };

/** Particles for a screen of this size at full density, capped (5.3). */
export function particleCount(look: Look, width: number, height: number): number {
  void look;
  void width;
  void height;
  return 0;
}

export function createField(look: Look, options: FieldOptions): Field {
  return {
    look,
    view: options.view,
    width: options.width,
    height: options.height,
    boxW: options.width + 2 * WRAP_MARGIN,
    boxH: options.height + 2 * WRAP_MARGIN,
    count: 0,
    active: 0,
    half: options.half ?? false,
    x: new Float64Array(0),
    y: new Float64Array(0),
    speed: new Float64Array(0),
    size: new Float64Array(0),
    phase: new Float64Array(0),
    spin: new Float64Array(0),
    shade: new Uint8Array(0),
    vx: 0,
    vy: 1,
    t: 0,
    sheets: new Float64Array(0),
    rings: new Float64Array(0),
    seed: options.seed ?? 1,
  };
}

/** Moves the field by `ms`, clamped to STEP_CLAMP_MS. The only thing that moves it. */
export function stepField(field: Field, ms: number): void {
  void field;
  void ms;
}

/**
 * A new screen size: recounts by area and keeps the first particles where
 * they show at `pan`, the stage's position now, so none jump.
 */
export function resizeField(field: Field, width: number, height: number, pan: Point): void {
  void field;
  void width;
  void height;
  void pan;
}

/** Top-down or Isometric at a turn: the wind's direction on screen changes, the particles stay. */
export function setFieldView(field: Field, view: View): void {
  void field;
  void view;
}

/** Half the particles, the step-down's first step (6.3), or all again for a new field. */
export function setHalf(field: Field, half: boolean): void {
  void field;
  void half;
}

/** Where particle `i` shows on screen at this pan, before sway: its drift plus the pan, wrapped into the box. */
export function spotOf(field: Field, i: number, pan: Point): Point {
  void field;
  void i;
  void pan;
  return { x: 0, y: 0 };
}
