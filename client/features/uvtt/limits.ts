import { isCoarsePointer } from "../../lib/device.ts";

/**
 * The bounds of a Universal VTT import (docs/design-v1-maps-vision.md
 * section 3.1). The file comes from the DM's own disk and is untrusted, so
 * every size is checked before the work it would cost: the file's bytes
 * before it is read, the counts before the schema walks them, and the
 * image's pixels before it is decoded.
 */

const MiB = 1024 * 1024;

/** The largest file a computer reads. Real exports run 50 to 150 MB, almost all of it the image. */
export const MAX_FILE_BYTES = 150 * MiB;
/** A phone tab may not have the memory for more, and iOS cannot draw a big image to resize it. */
export const MAX_PHONE_FILE_BYTES = 40 * MiB;

export const MAX_POLYLINES = 20_000;
/** Points in all the polylines together, walls and objects. */
export const MAX_POINTS = 200_000;
export const MAX_PORTALS = 2_000;
export const MAX_FILE_LIGHTS = 500;
/** How far outside its map a file may put geometry, in squares. Past that the file is broken. */
export const SLACK_SQUARES = 1;

/** What the server keeps as a map's full size, and the most it takes in one upload (server/assets/kinds.ts). */
export const MAX_MAP_SIDE = 8192;
export const MAX_MAP_UPLOAD_BYTES = 32 * MiB;
/** iOS draws no canvas over this many pixels, so a phone or an iPad cannot resize an image bigger than this. */
export const PHONE_CANVAS_PIXELS = 16_777_216;
/**
 * The largest image any browser here decodes onto a canvas. Chrome's canvas
 * stops at 32,767 pixels a side and 268 million pixels in all. Past that a
 * resize would fail anyway, after allocating gigabytes on the way.
 */
export const MAX_SOURCE_SIDE = 32_767;
export const MAX_SOURCE_PIXELS = 268_435_456;
/** Quality for a resized map. JPEG is only for Safari, which cannot encode WebP from a canvas. */
export const RESIZE_QUALITY = 0.92;

/** Walls and lights (section 3.1 steps 4 and 7), in squares. */
export const MERGE_SQUARES = 0.1;
export const SIMPLIFY_STEPS = [0.05, 0.1, 0.2] as const;
export const WELD_SQUARES = 0.1;
export const GRID_SNAP_SQUARES = 0.1;
export const LIGHT_NEAR_WALL = 0.05;
export const LIGHT_STEP_OFF = 0.1;

export type Device = "computer" | "phone" | "iPad";

/**
 * What the import's limits take this device for. A phone is a touch-first
 * device whose shorter screen side is under the 900 px tablet layout
 * breakpoint, the same line the map variant draws (client/lib/device.ts),
 * and it reads files up to the phone's size. Any other iOS device is an
 * iPad: it reads files as a computer does, but iOS draws no canvas over
 * PHONE_CANVAS_PIXELS whatever the screen's size, so it resizes only what
 * a phone can. A 12.9 inch iPad's short side is 1,024 px, past the line.
 */
export function deviceFrom(input: { coarsePointer: boolean; shortSidePx: number; ios: boolean }): Device {
  if (input.coarsePointer && input.shortSidePx < 900) return "phone";
  return input.ios ? "iPad" : "computer";
}

/** This browser's device, read from its screen, pointer and platform. The import and the grid search on a picked map both go by it. */
export function thisDevice(): Device {
  const short = typeof screen === "undefined" ? 1024 : Math.min(screen.width, screen.height);
  const ios = typeof navigator !== "undefined" && isIos({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints });
  return deviceFrom({ coarsePointer: isCoarsePointer(), shortSidePx: short, ios });
}

/**
 * Whether the browser runs on iOS or iPadOS. An iPad asks for desktop pages
 * and calls itself a Mac (`MacIntel`), so a "Mac" with a touch screen is an
 * iPad: no Mac has one.
 */
export function isIos(input: { userAgent: string; platform: string; maxTouchPoints: number }): boolean {
  return /iP(hone|ad|od)/.test(input.userAgent) || (input.platform === "MacIntel" && input.maxTouchPoints > 1);
}

/** The three names of the one format. A computer's file picker offers only these. */
export const EXTENSIONS = [".dd2vtt", ".uvtt", ".df2vtt"] as const;

function mb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / MiB))} MB`;
}

/** Why a file is too big to read on this device, or null. Checked from File.size, before any byte is read. */
export function fileSizeProblem(bytes: number, device: Device): string | null {
  if (device === "phone" && bytes > MAX_PHONE_FILE_BYTES) {
    return `This file is ${mb(bytes)}. On a phone, import files up to ${mb(MAX_PHONE_FILE_BYTES)}, or import it on a computer.`;
  }
  if (bytes > MAX_FILE_BYTES) return `This file is ${mb(bytes)}. Universal VTT files can be at most ${mb(MAX_FILE_BYTES)}.`;
  if (bytes === 0) return "This file is empty.";
  return null;
}

export const NOT_UVTT = "This is not a Universal VTT map file.";
export const NO_IMAGE = "This file has no map image.";
export const GRID_PROBLEM = "This map's grid is too fine or too coarse for a scene to store.";

/** A whole number with thousands separators, the way the summary and the errors write counts. */
export function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
