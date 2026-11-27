import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ModelRef } from "#shared/model.ts";
import { ModelRefusal, MODEL_WORDS, type FileAxes, type ModelMesh } from "./mesh.ts";

/**
 * Standing a model up and fitting it to its footprint
 * (docs/design/design-v1-token-models.md 5, D-261127-173, 174, 371), then
 * laying out its 8 frames on the sheet. Everything here is plain numbers,
 * so it runs and is tested without three.js.
 *
 * The drawing's axes are glTF's: Y up, the front toward +Z, a footprint
 * side 1. The camera sits at +Z, 30 degrees up, as Isometric's does (the
 * ground halves and a unit of height rises K = cos 30°, client/lib/view.ts).
 * Frame i turns the model 45 i degrees clockwise seen from above, so its
 * front faces the camera in frame 0. In view units a frame point is
 * u = x' across and v = y' cos 30° − z' sin 30° up, where (x', y', z') is
 * the turned point.
 */

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

/** A row-major 3 by 3 rotation. */
export type Rotation = readonly [number, number, number, number, number, number, number, number, number];

const I: Rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const X90: Rotation = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const X180: Rotation = [1, 0, 0, 0, -1, 0, 0, 0, -1];
const X270: Rotation = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const Z90: Rotation = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const Z270: Rotation = [0, 1, 0, -1, 0, 0, 0, 0, 1];
/** Stand it up's six ways: each turns another of the file's axes up. */
export const UPS: readonly Rotation[] = [I, X90, X180, X270, Z90, Z270];

/** A quarter turn clockwise seen from above, about Y. */
const QUARTER: Rotation = [0, 0, -1, 0, 1, 0, 1, 0, 0];

function mul(a: Rotation, b: Rotation): Rotation {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return out as unknown as Rotation;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** The file's axes to the drawing's: Z up and the front toward -Y becomes Y up and +Z, then Stand it up, then Turn its front. */
export function rotationFor(axes: FileAxes, up: number, front: number): Rotation {
  let r: Rotation = axes === "zUp" ? X270 : I;
  r = mul(UPS[mod(Math.round(up), UPS.length)]!, r);
  for (let q = 0; q < mod(Math.round(front), 4); q++) r = mul(QUARTER, r);
  return r;
}

/** Calls `each` with every vertex position of every part, in the file's own axes. */
function eachVertex(mesh: ModelMesh, each: (x: number, y: number, z: number) => void): void {
  for (const part of mesh.parts) {
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) each(p[i]!, p[i + 1]!, p[i + 2]!);
  }
}

/** Where the model sits at Size 100%: drawing = scale × (rotation × file − offset). */
export type Fit = { rotation: Rotation; scale: number; offset: [number, number, number]; base: boolean };

/** The lowest share of the height whose middle goes on the footprint's center. */
export const SLICE = 0.06;
/** A slice is a base when it is this round, its short side over its long, and this wide against the model. */
export const BASE_ROUND = 0.8;
export const BASE_WIDTH = 0.6;
/** A base fills the footprint with the height capped here, else the model fits a 1 by 1 by 1.4 box. */
export const BASE_HEIGHT_CAP = 2.5;
export const FIT_HEIGHT = 1.4;

/**
 * Stands the model on its footprint (D-261127-174): the middle of its
 * lowest 6% on the footprint's center and its lowest point on the ground.
 * A round slice at least 60% of the model's width is a base and fills the
 * footprint, the height capped at 2.5. Otherwise the model fits a box 1 by
 * 1 wide and 1.4 tall. A model with no size is refused.
 */
export function fitModel(mesh: ModelMesh, rotation: Rotation): Fit {
  const r = rotation;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  eachVertex(mesh, (x, y, z) => {
    const a = r[0] * x + r[1] * y + r[2] * z;
    const b = r[3] * x + r[4] * y + r[5] * z;
    const c = r[6] * x + r[7] * y + r[8] * z;
    if (a < min[0]!) min[0] = a;
    if (a > max[0]!) max[0] = a;
    if (b < min[1]!) min[1] = b;
    if (b > max[1]!) max[1] = b;
    if (c < min[2]!) min[2] = c;
    if (c > max[2]!) max[2] = c;
  });
  const width = Math.max(max[0]! - min[0]!, max[2]! - min[2]!);
  const height = max[1]! - min[1]!;
  if (!(Math.max(width, height) > 0) || !Number.isFinite(width + height)) throw new ModelRefusal(MODEL_WORDS.notModel);
  const top = min[1]! + SLICE * height;
  const smin = [Infinity, Infinity];
  const smax = [-Infinity, -Infinity];
  eachVertex(mesh, (x, y, z) => {
    if (r[3] * x + r[4] * y + r[5] * z > top) return;
    const a = r[0] * x + r[1] * y + r[2] * z;
    const c = r[6] * x + r[7] * y + r[8] * z;
    if (a < smin[0]!) smin[0] = a;
    if (a > smax[0]!) smax[0] = a;
    if (c < smin[1]!) smin[1] = c;
    if (c > smax[1]!) smax[1] = c;
  });
  const sx = smax[0]! - smin[0]!;
  const sz = smax[1]! - smin[1]!;
  const long = Math.max(sx, sz);
  const base = long > 0 && Math.min(sx, sz) >= BASE_ROUND * long && long >= BASE_WIDTH * width;
  const scale = base
    ? Math.min(1 / long, height > 0 ? BASE_HEIGHT_CAP / height : Infinity)
    : Math.min(max[0]! - min[0]! > 0 ? 1 / (max[0]! - min[0]!) : Infinity, max[2]! - min[2]! > 0 ? 1 / (max[2]! - min[2]!) : Infinity, height > 0 ? FIT_HEIGHT / height : Infinity);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new ModelRefusal(MODEL_WORDS.notModel);
  return { rotation, scale, offset: [(smin[0]! + smax[0]!) / 2, min[1]!, (smin[1]! + smax[1]!) / 2], base };
}

/** Frame i's turn, in radians: 45 i degrees clockwise seen from above, which is negative about Y. */
export function frameYaw(i: number): number {
  return (-i * Math.PI) / 4;
}

/** Each frame's reach at Size 100%, in view units about the anchor: [u0, u1, v0, v1] per frame. */
export type Reach = Float64Array;

/** How far the fitted model reaches in each of the 8 frames, read from every vertex. */
export function reachOf(mesh: ModelMesh, fit: Fit): Reach {
  const reach = new Float64Array(MODEL_LIMITS.frames * 4);
  for (let f = 0; f < MODEL_LIMITS.frames; f++) {
    reach[f * 4] = reach[f * 4 + 2] = Infinity;
    reach[f * 4 + 1] = reach[f * 4 + 3] = -Infinity;
  }
  const cos = Array.from({ length: MODEL_LIMITS.frames }, (_, f) => Math.cos(frameYaw(f)));
  const sin = Array.from({ length: MODEL_LIMITS.frames }, (_, f) => Math.sin(frameYaw(f)));
  const { rotation: r, scale: k, offset: o } = fit;
  eachVertex(mesh, (px, py, pz) => {
    const x = k * (r[0] * px + r[1] * py + r[2] * pz - o[0]);
    const y = k * (r[3] * px + r[4] * py + r[5] * pz - o[1]);
    const z = k * (r[6] * px + r[7] * py + r[8] * pz - o[2]);
    const lift = y * COS30;
    for (let f = 0; f < MODEL_LIMITS.frames; f++) {
      // Turned by the frame's yaw about Y: x' = x cos + z sin, z' = z cos − x sin.
      const u = x * cos[f]! + z * sin[f]!;
      const v = lift - (z * cos[f]! - x * sin[f]!) * SIN30;
      const at = f * 4;
      if (u < reach[at]!) reach[at] = u;
      if (u > reach[at + 1]!) reach[at + 1] = u;
      if (v < reach[at + 2]!) reach[at + 2] = v;
      if (v > reach[at + 3]!) reach[at + 3] = v;
    }
  });
  return reach;
}

/** The ring the board draws round the anchor, a footprint's circle seen from 30 degrees up: half its width and half its height, in view units. */
const RING_HALF_U = 0.5;
const RING_HALF_V = 0.25;

/** The share of a frame inside its gutters. */
const INNER = 1 - (2 * MODEL_LIMITS.gutterPx) / MODEL_LIMITS.framePx;
/** The outline and antialiasing round the drawn part, in frame pixels, added to each drawn box. */
const BOX_PAD_PX = 2;

/** A frame's side at a Size, before rounding: the widest and tallest of the 8 views and the ring, inside the gutters. */
function sideAt(reach: Reach, size: number): { side: number; top: number; bottom: number } {
  const k = size / 100;
  let half = RING_HALF_U;
  let top = RING_HALF_V;
  let bottom = -RING_HALF_V;
  for (let f = 0; f < MODEL_LIMITS.frames; f++) {
    half = Math.max(half, -k * reach[f * 4]!, k * reach[f * 4 + 1]!);
    bottom = Math.min(bottom, k * reach[f * 4 + 2]!);
    top = Math.max(top, k * reach[f * 4 + 3]!);
  }
  return { side: Math.max(2 * half, top - bottom) / INNER, top, bottom };
}

/** The largest Size, from 50% in 10% steps, whose frame side stays at most 4 (D-261127-371). */
export function maxSizeOf(reach: Reach): number {
  const L = MODEL_LIMITS;
  let size = L.minSizePercent;
  // The side grows with Size, so the first step past 4 ends it. 400 steps reach 4,050%, far past any model.
  for (let step = 0; step < 400 && sideAt(reach, size + L.sizeStepPercent).side <= L.maxSide; step++) size += L.sizeStepPercent;
  return size;
}

export type Layout = {
  meta: Omit<ModelRef, "assetId">;
  /** The Size drawn, the one asked clamped to 50 and `maxSize`. */
  size: number;
  maxSize: number;
  /** The camera's frame about the anchor, in view units: its side and its top. They are exactly `meta`'s. */
  side: number;
  top: number;
};

const up4 = (n: number) => Math.ceil(n * 10_000) / 10_000;
const near4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * The sheet's layout at a Size: the frame side, the anchor and each
 * frame's drawn box in whole hundredths, rounded outward so a box never
 * cuts its drawing. The content sits in the middle of the frame when its
 * width sets the side. The side is rounded up and the anchor to four places
 * first, and the camera uses exactly those, so the stored ref is the drawing.
 */
export function layoutAt(reach: Reach, askedSize: number): Layout {
  const L = MODEL_LIMITS;
  const maxSize = maxSizeOf(reach);
  const stepped = L.minSizePercent + Math.round((askedSize - L.minSizePercent) / L.sizeStepPercent) * L.sizeStepPercent;
  const size = Math.min(maxSize, Math.max(L.minSizePercent, Number.isFinite(stepped) ? stepped : 100));
  const at = sideAt(reach, size);
  const side = Math.max(L.minSide, up4(at.side));
  const anchorY = near4((at.top + (side - (at.top - at.bottom)) / 2) / side);
  const top = anchorY * side;
  const k = size / 100;
  const pad = BOX_PAD_PX / L.framePx;
  const boxes: [number, number, number, number][] = [];
  for (let f = 0; f < L.frames; f++) {
    const fx0 = (k * reach[f * 4]! + side / 2) / side - pad;
    const fx1 = (k * reach[f * 4 + 1]! + side / 2) / side + pad;
    const fy0 = (top - k * reach[f * 4 + 3]!) / side - pad;
    const fy1 = (top - k * reach[f * 4 + 2]!) / side + pad;
    boxes.push(hundredths(fx0, fx1, fy0, fy1));
  }
  return { meta: { side, anchorY, boxes }, size, maxSize, side, top };
}

/** A box in whole hundredths, rounded outward, inside 0 to 100 and at least one hundredth across each way. */
function hundredths(x0: number, x1: number, y0: number, y1: number): [number, number, number, number] {
  const M = MODEL_LIMITS.boxMax;
  const lo = (v: number) => Math.min(M - 1, Math.max(0, Math.floor(v * M)));
  const hi = (v: number, from: number) => Math.min(M, Math.max(from + 1, Math.ceil(v * M)));
  const a = lo(x0);
  const b = lo(y0);
  return [a, b, hi(x1, a), hi(y1, b)];
}
