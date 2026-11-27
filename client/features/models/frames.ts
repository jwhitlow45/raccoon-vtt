import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ModelRef } from "#shared/model.ts";
import type { Turn } from "../../lib/view.ts";

/**
 * Which of a model's 8 pictures Isometric shows, and where it draws
 * (docs/design/design-v1-token-models.md 4.4, D-261127-167). Frame i is the
 * model turned 45 i degrees clockwise from facing the camera, so the frame
 * a creature shows is the angle from the camera to its front. Facing 0
 * faces north, as the ring's tick shows. With the stepper's 45 degree
 * presses that angle is always a whole frame, and a typed or imported
 * facing shows the nearest one.
 *
 * The camera is Isometric's own: orthographic and 30 degrees above the
 * ground, so the ground halves and a cell of height rises K = cos 30°, as
 * lib/view.ts toView draws. A frame is then a square of view units, a
 * footprint across at side 1, and the board places it by its anchor: the
 * footprint's center at its base.
 */

/** A box in view units. */
export type FrameBox = { x0: number; y0: number; x1: number; y1: number };

/** The camera's azimuth at a turn, in degrees clockwise from north: at turn 0 it looks from the south east. */
export function cameraAzimuth(turn: Turn): number {
  return 135 - 90 * turn;
}

/** The frame for a facing seen at a turn: the angle from the camera to the creature's front, in 45 degree steps. A facing that is no number faces north, as the ring's tick reads it. */
export function frameFor(turn: Turn, facing: number): number {
  const f = Number.isFinite(facing) ? facing : 0;
  return mod(Math.round(mod(f - cameraAzimuth(turn), 360) / 45), MODEL_LIMITS.frames);
}

/**
 * A model's art box: its frame's whole square, `side` footprints across,
 * hung from its anchor `anchorY` of the way down. `fp` is the footprint's
 * longer side (a custom w by h footprint draws the model at it, centered,
 * D-261127-383), and `at` the ring's middle at the drawn base, in view units.
 */
export function modelArtBox(model: Pick<ModelRef, "side" | "anchorY">, fp: number, at: { x: number; y: number }): FrameBox {
  const size = model.side * fp;
  const y0 = at.y - model.anchorY * size;
  return { x0: at.x - size / 2, y0, x1: at.x + size / 2, y1: y0 + size };
}

/** The part of a frame that draws, `box` its [x0, y0, x1, y1] in hundredths of the frame (ModelRef.boxes), scaled into its art box. */
export function modelDrawnBox(art: FrameBox, box: readonly [number, number, number, number]): FrameBox {
  const kx = (art.x1 - art.x0) / MODEL_LIMITS.boxMax;
  const ky = (art.y1 - art.y0) / MODEL_LIMITS.boxMax;
  return { x0: art.x0 + box[0] * kx, y0: art.y0 + box[1] * ky, x1: art.x0 + box[2] * kx, y1: art.y0 + box[3] * ky };
}

/**
 * Where frame i lies on a sheet, in the sheet's own pixels: 4 by 2 squares,
 * frames 0 to 3 along the top. Read from the image's size, so the full and
 * mobile copies crop alike.
 */
export function frameCrop(frame: number, sheet: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const side = sheet.width / MODEL_LIMITS.sheetColumns;
  const f = mod(Math.trunc(frame), MODEL_LIMITS.frames);
  return { x: (f % MODEL_LIMITS.sheetColumns) * side, y: Math.floor(f / MODEL_LIMITS.sheetColumns) * side, width: side, height: side };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
