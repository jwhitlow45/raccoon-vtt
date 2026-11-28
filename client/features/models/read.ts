import { readGlb } from "./glb.ts";
import { fileSizeWords, ModelRefusal, MODEL_WORDS, type ModelDevice, type ModelMesh } from "./mesh.ts";
import { readObj } from "./obj.ts";
import { readStl } from "./stl.ts";

/**
 * Which model a file is, from its bytes and never its name
 * (docs/design/design-v1-token-models.md 5, D-261127-171, 372), and the
 * reader for it. A binary STL is checked first, since its free 80-byte
 * header often begins with `solid` too.
 */

export type ModelFormat = "stl-binary" | "stl-ascii" | "obj" | "glb";

/** How much of a file's start the sniffer reads. */
export const SNIFF_BYTES = 64 * 1024;

const text = (head: Uint8Array) => new TextDecoder().decode(head);

/**
 * Whether a binary file is a binary STL cut short: its count promises more
 * facets than its size holds, and every whole facet in its head reads as
 * one, a normal no longer than a unit one and finite corners. Any binary
 * file has some count at byte 80, so the facets are what tell a cut STL
 * from a picture or an archive, which stay "not a 3D model" (D-261127-717).
 */
function cutStl(view: DataView, size: number): boolean {
  if (view.byteLength < 84) return false;
  const promised = view.getUint32(80, true);
  const whole = Math.min(promised, Math.floor((Math.min(view.byteLength, size) - 84) / 50));
  if (84 + promised * 50 <= size || whole < 1) return false;
  for (let i = 0; i < whole; i++) {
    const at = 84 + 50 * i;
    const f = (k: number) => view.getFloat32(at + 4 * k, true);
    if (Math.hypot(f(0), f(1), f(2)) > 1.1) return false;
    for (let k = 3; k < 12; k++) if (!(Math.abs(f(k)) < 1e9)) return false;
  }
  return true;
}

/**
 * The file's format from its first bytes and its size, "gltf" for a glTF
 * JSON file, "damaged" for a binary STL cut short, or null for anything else.
 */
export function sniffModel(head: Uint8Array, size: number): ModelFormat | "gltf" | "damaged" | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length >= 4 && view.getUint32(0, true) === 0x46546c67) return "glb";
  if (head.length >= 84 && 84 + view.getUint32(80, true) * 50 === size) return "stl-binary";
  // Text formats hold no NUL byte. A binary file nearly always has one in its first 64 KiB.
  if (head.includes(0)) return cutStl(view, size) ? "damaged" : null;
  const start = text(head);
  if (/^\s*solid\b/i.test(start) && /\bfacet\b/i.test(start)) return "stl-ascii";
  if (/^﻿?\s*\{/.test(start) && /"asset"\s*:/.test(start)) return "gltf";
  if (/^[ \t]*v[ \t]+[-+.\d]/m.test(start)) return "obj";
  return null;
}

/** Reads a model file within the caps of its format and this device. Refuses in words. */
export async function readModel(file: Blob, device: ModelDevice): Promise<ModelMesh> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const format = sniffModel(head, file.size);
  if (format === "gltf") throw new ModelRefusal(MODEL_WORDS.gltf);
  if (format === "damaged") throw new ModelRefusal(MODEL_WORDS.crashed);
  if (format === null) throw new ModelRefusal(MODEL_WORDS.notModel);
  const tooBig = fileSizeWords(format === "glb" ? "glb" : format === "obj" ? "obj" : "stl", file.size, device);
  if (tooBig) throw new ModelRefusal(tooBig);
  if (format === "glb") return readGlb(new Uint8Array(await file.arrayBuffer()), device);
  if (format === "obj") return readObj(file);
  return readStl(file, format === "stl-binary");
}
