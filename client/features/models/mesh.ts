import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ModelRef } from "#shared/model.ts";

/**
 * What the model readers hand the drawing (docs/design/design-v1-token-models.md
 * 5), the words they refuse a file with, and the worker's messages. The
 * readers (stl.ts, obj.ts, glb.ts) and the worker share it, so none of
 * them imports another's runtime code.
 */

/** A phone or a tablet (a touch screen and no fine pointer, as the sound decode budget tells them), or anything else. */
export type ModelDevice = "touch" | "computer";

/** How the file stands as it is read: STL and OBJ Z up with the front toward -Y, GLB Y up with the front toward +Z (D-261127-173). */
export type FileAxes = "zUp" | "yUp";

/** How a part draws: one matte material, with what of glTF's base color it keeps. */
export type PartMaterial = {
  /** No material of its own (every STL and OBJ, a GLB part without one): it draws in the Color option's choice. */
  plain: boolean;
  /** The base color factor, linear RGBA. */
  color: [number, number, number, number];
  /** The kept texture it reads, an index into the mesh's `textures`, or -1. */
  texture: number;
  /** The texture's wrap, as WebGL names it: 10497 repeat, 33071 clamp, 33648 mirrored. */
  wrapS: number;
  wrapT: number;
  alpha: "opaque" | "mask" | "blend";
  alphaCutoff: number;
  doubleSided: boolean;
};

/** One group of triangles: positions and unit normals, indexed (STL and OBJ) or not (GLB), with coordinates and colors where its material reads them. */
export type ModelPart = {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array | null;
  uvs: Float32Array | null;
  /** Normalized RGBA bytes, white where a primitive had no COLOR_0. */
  colors: Uint8Array | null;
  material: PartMaterial;
};

/** A GLB image to decode: its bytes in place in the file, and the size its header gave. */
export type ModelTexture = { bytes: Uint8Array; mime: string; width: number; height: number };

export type ModelMesh = {
  axes: FileAxes;
  parts: ModelPart[];
  textures: ModelTexture[];
  /** Whether a part draws in the Color option's choice, so the sheet offers Color. */
  colorable: boolean;
  /** Plain sentences about what was left out, for the sheet to show. */
  notes: string[];
  /** Triangles drawn, for the report and the tests. */
  triangles: number;
};

export const PLAIN: PartMaterial = { plain: true, color: [1, 1, 1, 1], texture: -1, wrapS: 10497, wrapT: 10497, alpha: "opaque", alphaCutoff: 0.5, doubleSided: false };

/** A file refused, with the sentence the sheet shows. Anything else thrown in the worker is a crash. */
export class ModelRefusal extends Error {}

const count = (n: number) => n.toLocaleString("en-US");

/** Every sentence the reader and the drawing refuse or note with (section 5 and 8). */
export const MODEL_WORDS = {
  notModel: "That file is not a 3D model this app reads. Use STL, OBJ or GLB.",
  gltf: "Save it as GLB (one file) and pick that.",
  tooComplex: "This model is too complex to draw here. Try a simpler file.",
  extraData: "This model's file holds more data than the app can read. Export it again without extra data.",
  outsideFiles: "This GLB names files outside it. Save it as one GLB and pick that.",
  sparse: "This model stores part of its shape as sparse data, which the app can't read. Export it again without it.",
  instancing: "This model uses instancing, which the app can't read. Export it with the instances applied.",
  draco: "This model uses Draco compression, which the app can't read. Export it again without compression.",
  meshopt: "This model uses meshopt compression, which the app can't read. Export it again without compression.",
  groups: `This model has more than ${MODEL_LIMITS.glbGroups} materials. Merge some and export it again.`,
  brokenSkeleton: "This model's skeleton is broken. Export it again with the skin applied.",
  duplicateJoints: "This model's skeleton names one bone twice. Export it again with the skin applied.",
  skinJoints: `This model's skeleton has more than ${count(MODEL_LIMITS.skinJoints)} bones. Export it again with the skin applied.`,
  drawnJoints: `This model's skeletons have more than ${count(MODEL_LIMITS.drawnJoints)} bones in all. Export it again with the skins applied.`,
  ktx2Note: "Some of its textures use a compressed format the app can't read, so it draws without them.",
  uriNote: "Its textures are separate files, so it draws without them. Export one GLB to keep them.",
  tooLong: "Drawing the model took too long on this device. Try a smaller file, or add it from a computer.",
  noWebgl: "This browser can't draw 3D models. Recent Chrome, Edge, Firefox and Safari can.",
  crashed: "The model could not be read. It may be damaged, or too large for this device.",
  changed: "The file changed while it was read. Choose it again.",
} as const;

/** The triangle cap's refusal (D-261127-473, 520): a phone or tablet is told a computer takes more, where it does. */
export function trianglesWords(triangles: number, device: ModelDevice): string {
  const L = MODEL_LIMITS;
  if (device === "touch" && triangles <= L.glbComputerTriangles) {
    return `This model draws ${count(triangles)} triangles. A phone or tablet can take up to ${count(L.glbTouchTriangles)}, and a computer up to ${count(L.glbComputerTriangles)}. Add it from a computer, or export a lighter one.`;
  }
  return `This model draws ${count(triangles)} triangles. A computer can take up to ${count(L.glbComputerTriangles)}. Export a lighter one.`;
}

/** Why a file of this format is too large to read on this device, or null. */
export function fileSizeWords(format: "stl" | "obj" | "glb", bytes: number, device: ModelDevice): string | null {
  const L = MODEL_LIMITS;
  const mb = (b: number) => `${Math.round(b / (1024 * 1024))} MB`;
  if (format === "stl" && bytes > L.stlBytes) return `This STL is over ${mb(L.stlBytes)}, the largest the app reads. Export a lighter one.`;
  if (format === "obj" && bytes > L.objBytes) return `This OBJ is over ${mb(L.objBytes)}, the largest the app reads. Export a lighter one, or save it as STL.`;
  if (format === "glb" && device === "touch" && bytes > L.glbTouchBytes) {
    return `This GLB is over ${mb(L.glbTouchBytes)}, the largest a phone or tablet reads. Add it from a computer, or export a lighter one.`;
  }
  if (format === "glb" && bytes > L.glbComputerBytes) return `This GLB is over ${mb(L.glbComputerBytes)}, the largest the app reads. Export a lighter one.`;
  return null;
}

/** A finite coordinate, or the file is refused as not a model. */
export function finite(v: number): number {
  if (!Number.isFinite(v)) throw new ModelRefusal(MODEL_WORDS.notModel);
  return v;
}

/**
 * Calls `each` with the file's bytes in slices of at most `sliceBytes`, each
 * one released before the next is read, so a file of any size costs one
 * slice of memory. `align` keeps each slice a whole number of records.
 */
export async function eachSlice(file: Blob, from: number, to: number, each: (bytes: Uint8Array, at: number) => void, align = 1, sliceBytes: number = MODEL_LIMITS.sliceBytes): Promise<void> {
  const step = Math.max(align, sliceBytes - (sliceBytes % align));
  for (let at = from; at < to; at += step) {
    const end = Math.min(to, at + step);
    const buffer = await file.slice(at, end).arrayBuffer();
    if (buffer.byteLength !== end - at) throw new ModelRefusal(MODEL_WORDS.changed);
    each(new Uint8Array(buffer), at);
  }
}

/**
 * Calls `line` for each line of a text file, as a byte range of a slice,
 * reading the file a slice at a time. A line split between two slices is
 * carried into the next. Any line past `lineBytes`, carried or whole in one
 * slice, means the file is no model text (a model's lines are short), and
 * refusing keeps the carry bounded.
 */
export async function eachLine(file: Blob, line: (bytes: Uint8Array, start: number, end: number) => void, sliceBytes: number = MODEL_LIMITS.sliceBytes): Promise<void> {
  const held: { carry: Uint8Array | null } = { carry: null };
  await eachSlice(
    file,
    0,
    file.size,
    (bytes) => {
      let start = 0;
      const carry = held.carry;
      if (carry) {
        const nl = bytes.indexOf(10);
        const head = nl < 0 ? bytes.length : nl;
        if (carry.length + head > MODEL_LIMITS.lineBytes) throw new ModelRefusal(MODEL_WORDS.notModel);
        const joined = new Uint8Array(carry.length + head);
        joined.set(carry);
        joined.set(bytes.subarray(0, head), carry.length);
        if (nl < 0) {
          held.carry = joined;
          return;
        }
        held.carry = null;
        line(joined, 0, joined.length);
        start = nl + 1;
      }
      for (let nl = bytes.indexOf(10, start); nl >= 0; nl = bytes.indexOf(10, start)) {
        if (nl - start > MODEL_LIMITS.lineBytes) throw new ModelRefusal(MODEL_WORDS.notModel);
        line(bytes, start, nl);
        start = nl + 1;
      }
      if (start < bytes.length) {
        if (bytes.length - start > MODEL_LIMITS.lineBytes) throw new ModelRefusal(MODEL_WORDS.notModel);
        held.carry = bytes.slice(start);
      }
    },
    1,
    sliceBytes,
  );
  if (held.carry) line(held.carry, 0, held.carry.length);
}

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i);

/**
 * Parses a decimal number from bytes, without making a string of it: ASCII
 * STL and OBJ hold millions. Returns the index after it in `next[0]`, or
 * NaN when no number starts at `i`. Up to 17 digits are exact and the rest
 * only scale, so a value is within a few units in its last place of
 * `Number()`'s, far below a model's precision.
 */
export function numberAt(bytes: Uint8Array, i: number, end: number, next: Int32Array): number {
  let sign = 1;
  let c = bytes[i];
  if (c === 45 || c === 43) {
    if (c === 45) sign = -1;
    c = bytes[++i];
  }
  let mantissa = 0;
  let digits = 0;
  let scale = 0;
  let any = false;
  while (i < end && c! >= 48 && c! <= 57) {
    if (digits < 17) {
      mantissa = mantissa * 10 + (c! - 48);
      if (mantissa !== 0) digits++;
    } else scale++;
    any = true;
    c = bytes[++i];
  }
  if (i < end && c === 46) {
    c = bytes[++i];
    while (i < end && c! >= 48 && c! <= 57) {
      if (digits < 17) {
        mantissa = mantissa * 10 + (c! - 48);
        if (mantissa !== 0) digits++;
        scale--;
      }
      any = true;
      c = bytes[++i];
    }
  }
  if (!any) {
    next[0] = i;
    return NaN;
  }
  if (i < end && (c === 101 || c === 69)) {
    let j = i + 1;
    let esign = 1;
    let e = bytes[j];
    if (e === 45 || e === 43) {
      if (e === 45) esign = -1;
      e = bytes[++j];
    }
    let exp = 0;
    let expDigits = false;
    while (j < end && e! >= 48 && e! <= 57) {
      if (exp < 10_000) exp = exp * 10 + (e! - 48);
      expDigits = true;
      e = bytes[++j];
    }
    if (expDigits) {
      scale += esign * exp;
      i = j;
    }
  }
  next[0] = i;
  let value: number;
  if (scale === 0) value = mantissa;
  else if (scale > 0) value = scale < POW10.length ? mantissa * POW10[scale]! : mantissa * 10 ** scale;
  else value = -scale < POW10.length ? mantissa / POW10[-scale]! : mantissa / 10 ** -scale;
  return sign * value;
}

/** The index of the first byte at or after `i` that is not a space or a tab (or a carriage return, which ends a Windows line). */
export function skipSpace(bytes: Uint8Array, i: number, end: number): number {
  while (i < end) {
    const c = bytes[i]!;
    if (c !== 32 && c !== 9 && c !== 13) break;
    i++;
  }
  return i;
}

/** Whether `word` starts at `i`, followed by a space, a tab or the line's end. */
export function wordAt(bytes: Uint8Array, i: number, end: number, word: string): boolean {
  if (i + word.length > end) return false;
  for (let k = 0; k < word.length; k++) if ((bytes[i + k]! | 0x20) !== word.charCodeAt(k)) return false;
  const after = i + word.length;
  if (after === end) return true;
  const c = bytes[after]!;
  return c === 32 || c === 9 || c === 13;
}

/** The colors a plain part may draw in (D-261127-175): a material, or the picture's own color as `#rrggbb`. */
export type ModelColor = "stone" | "bronze" | "bone" | "iron" | `#${string}`;

/** The options a sheet is drawn with (section 3.1). */
export type ModelOptions = {
  color: ModelColor;
  /** Stand it up: which of the six ways is up, 0 as the file stands. */
  up: number;
  /** Turn its front: quarter turns clockwise, seen from above. */
  front: number;
  /** Size in percent, from 50 in 10% steps up to the draw's `maxSize`. */
  size: number;
};

export type ModelStage = "reading" | "drawing";

/** A drawn model: the sheet, its ref without the asset, the front view for a token with no picture, and the largest Size allowed. */
export type DrawnSheet = {
  sheet: Blob;
  meta: Omit<ModelRef, "assetId">;
  front: Blob;
  maxSize: number;
  colorable: boolean;
  notes: string[];
};

export type ToModelWorker = { t: "draw"; id: number; file: File | null; device: ModelDevice; options: ModelOptions };

export type FromModelWorker =
  | { t: "stage"; id: number; stage: ModelStage }
  | ({ t: "drawn"; id: number } & DrawnSheet)
  | { t: "refused"; id: number; message: string };
