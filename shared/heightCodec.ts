import { CHUNK_CELLS, type BuildChunk, type StairMark } from "./model.ts";
import { decodeHeights as storedHeights, encodeHeights as storeHeights, groundAt, markIn } from "./rules/heights.ts";
import { chunkKey } from "./keys.ts";

/**
 * Editing a chunk's heights and stair marks (docs/design-v1-maps-vision.md
 * 4.2), BuildChunk.heights and BuildChunk.up, for the reducer that paints
 * them. The stored form is read and written by shared/rules/heights.ts, as
 * every rule reads it, so the reducer and the rules can never read a cell
 * differently: this only gives the reducer lists it may change.
 */

const CELLS = CHUNK_CELLS * CHUNK_CELLS;

/** A cell's place in its chunk's row-major lists. */
export function cellIndex(chunk: Pick<BuildChunk, "cx" | "cy">, x: number, y: number): number {
  return (y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS);
}

/** Each cell's height in feet, a fresh list to change, all 0 when the chunk has none or holds something unreadable. */
export function decodeHeights(text: string | undefined): Int16Array {
  return storedHeights(text) ?? new Int16Array(CELLS);
}

/** The stored form of the heights, or undefined when every cell is at 0, which a chunk stores as no field. */
export function encodeHeights(heights: Int16Array): string | undefined {
  return storeHeights(heights);
}

/** Each cell's stair mark, all "." when the chunk has none. */
export function decodeStairs(text: string | undefined): StairMark[] {
  if (text === undefined || text.length !== CELLS) return Array.from({ length: CELLS }, () => ".");
  return Array.from(text, (c) => (c === "a" || c === "n" || c === "e" || c === "s" || c === "w" ? c : "."));
}

/** The stored form of the marks, or undefined when no cell is a stair. */
export function encodeStairs(marks: readonly StairMark[]): string | undefined {
  return marks.every((m) => m === ".") ? undefined : marks.join("");
}

/** Each cell's difficult ground mark, true where it has one, all false when the chunk has none (docs/design-v1-movement.md 6.3). */
export function decodeRough(text: string | undefined): boolean[] {
  if (text === undefined || text.length !== CELLS) return Array.from({ length: CELLS }, () => false);
  return Array.from(text, (c) => c === "d");
}

/** The stored form of the marks, or undefined when no cell has one. */
export function encodeRough(marks: readonly boolean[]): string | undefined {
  return marks.some((m) => m) ? marks.map((m) => (m ? "d" : ".")).join("") : undefined;
}

type Chunks = Readonly<Record<string, BuildChunk>>;

/** One cell's ground in feet: its painted height, 0 where nothing is painted. */
export function heightAt(chunks: Chunks, sceneId: string, x: number, y: number): number {
  return groundAt(chunks, sceneId, x, y);
}

/** One cell's stair mark, "." where there is none. */
export function stairMarkAt(chunks: Chunks, sceneId: string, x: number, y: number): StairMark {
  return markIn(chunks[chunkKey(sceneId, Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS))], x, y);
}
