import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ModelDevice } from "./mesh.ts";

/**
 * The GLB JSON chunk's pre-scan (docs/design/design-v1-token-models.md 5,
 * D-261127-510). `JSON.parse` builds every container and value in the
 * chunk, extras and unknown extensions included, before the reader can
 * ignore one: a 4 MB chunk of empty objects holds 85 MB of heap. So one
 * linear walk of the bytes counts nesting, containers and values first,
 * and refuses past the caps without allocating anything. It is not a
 * validator: malformed JSON passes here and `JSON.parse` refuses it.
 *
 * It reads bytes, not text. Every structural character is ASCII, and in
 * UTF-8 no byte of a multi-byte character is below 0x80, so a quote or a
 * bracket is always itself. Strings are skipped with their escapes, so an
 * escaped quote or a bracket inside a string never counts.
 */

export type JsonCaps = { bytes: number; depth: number; containers: number; values: number };

export function jsonCaps(device: ModelDevice): JsonCaps {
  const L = MODEL_LIMITS;
  return device === "touch"
    ? { bytes: L.glbJsonTouchBytes, depth: L.glbJsonDepth, containers: L.glbJsonTouchContainers, values: L.glbJsonTouchValues }
    : { bytes: L.glbJsonComputerBytes, depth: L.glbJsonDepth, containers: L.glbJsonComputerContainers, values: L.glbJsonComputerValues };
}

export type JsonPastCap = "bytes" | "depth" | "containers" | "values";

/** Which cap the chunk passes first, or null within them all. Keys count as values, as `JSON.parse` makes a string of each. */
export function prescanJson(bytes: Uint8Array, caps: JsonCaps): JsonPastCap | null {
  if (bytes.length > caps.bytes) return "bytes";
  const n = bytes.length;
  let depth = 0;
  let containers = 0;
  let values = 0;
  let i = 0;
  while (i < n) {
    const c = bytes[i]!;
    if (c === 0x22) {
      // A string, a key or a value: skip to its closing quote, past every escape.
      if (++values > caps.values) return "values";
      i++;
      while (i < n) {
        const s = bytes[i]!;
        if (s === 0x5c) i += 2;
        else if (s === 0x22) break;
        else i++;
      }
      i++;
    } else if (c === 0x7b || c === 0x5b) {
      if (++depth > caps.depth) return "depth";
      if (++containers > caps.containers) return "containers";
      if (++values > caps.values) return "values";
      i++;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
      i++;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39) || c === 0x74 || c === 0x66 || c === 0x6e) {
      // A number, true, false or null: one value, up to the next separator.
      if (++values > caps.values) return "values";
      i++;
      while (i < n) {
        const s = bytes[i]!;
        if (s === 0x2c || s === 0x5d || s === 0x7d || s === 0x3a || s === 0x20 || s === 0x0a || s === 0x0d || s === 0x09 || s === 0x22 || s === 0x7b || s === 0x5b) break;
        i++;
      }
    } else i++;
  }
  return null;
}
