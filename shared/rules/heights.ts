import { CHUNK_CELLS, HEIGHTS_CHARS, STAIRS_CHARS, type BuildChunk, type SceneId, type StairMark } from "../model.ts";
import { occupiedRange, type CellRange, type PlacedToken } from "./footprint.ts";
import { SQUARES } from "./grid.ts";

/**
 * Raised areas and stairs (docs/design-v1-maps-vision.md section 4.2): the
 * ground under a cell or a footprint, where a token stands relative to it,
 * and which way each stair points.
 *
 * Sight reads ground heights, and sight's "seen" marks are stored facts, so
 * this file uses only +, -, *, / and comparisons plus Math.floor, min and
 * max, and imports nothing that calls more (section 4.3.4, the test in
 * segments.test.ts).
 */

/** The four ways a stair can point up. */
export type Compass = "n" | "e" | "s" | "w";

// ---------------------------------------------------------------------------
// The stored heights string

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SEXTET = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) SEXTET[ALPHABET.charCodeAt(i)] = i;
const CELLS = CHUNK_CELLS * CHUNK_CELLS;
const BYTES = CELLS * 2;

/**
 * A chunk's heights in feet, row-major over its cells, or null when it has
 * none. The model stores them as base64 of little-endian 16-bit integers
 * (model.ts `BuildChunk.heights`). A string of the wrong shape is bad data
 * and reads as no heights, as walls.ts drops a malformed key.
 */
export function decodeHeights(s: string | undefined): Int16Array | null {
  if (typeof s !== "string" || s.length !== HEIGHTS_CHARS || s.charCodeAt(HEIGHTS_CHARS - 1) !== 61) return null;
  const bytes = new Uint8Array(BYTES + 1);
  let n = 0;
  for (let i = 0; i < HEIGHTS_CHARS - 1; i += 4) {
    let group = 0;
    let chars = 0;
    for (let j = i; j < i + 4 && j < HEIGHTS_CHARS - 1; j++) {
      const c = s.charCodeAt(j);
      const v = c < 128 ? SEXTET[c]! : -1;
      if (v < 0) return null;
      group = group * 64 + v;
      chars++;
    }
    // The last group has three characters and so two bytes.
    if (chars === 3) group *= 64;
    bytes[n++] = (group - (group % 65536)) / 65536;
    bytes[n++] = ((group - (group % 256)) / 256) % 256;
    if (chars === 4) bytes[n++] = group % 256;
  }
  if (n !== BYTES) return null;
  const out = new Int16Array(CELLS);
  let any = false;
  for (let k = 0; k < CELLS; k++) {
    const u = bytes[2 * k]! + bytes[2 * k + 1]! * 256;
    const v = u >= 32768 ? u - 65536 : u;
    out[k] = v;
    if (v !== 0) any = true;
  }
  return any ? out : null;
}

/** The stored form of a chunk's heights, row-major over its 256 cells, or undefined when every one is 0. */
export function encodeHeights(feet: ArrayLike<number>): string | undefined {
  if (feet.length !== CELLS) throw new Error(`heights need ${CELLS} cells`);
  const bytes = new Uint8Array(BYTES + 1);
  let any = false;
  for (let k = 0; k < CELLS; k++) {
    const v = feet[k]!;
    if (v !== 0) any = true;
    const u = v < 0 ? v + 65536 : v;
    bytes[2 * k] = u % 256;
    bytes[2 * k + 1] = (u - (u % 256)) / 256;
  }
  if (!any) return undefined;
  let out = "";
  for (let i = 0; i < BYTES; i += 3) {
    const group = bytes[i]! * 65536 + bytes[i + 1]! * 256 + bytes[i + 2]!;
    out += ALPHABET[(group - (group % 262144)) / 262144]!;
    out += ALPHABET[((group - (group % 4096)) / 4096) % 64]!;
    out += i + 1 < BYTES ? ALPHABET[((group - (group % 64)) / 64) % 64]! : "=";
    out += i + 2 < BYTES ? ALPHABET[group % 64]! : "=";
  }
  return out;
}

const groundCache = new WeakMap<BuildChunk, Int16Array | null>();

/** A chunk's heights, decoded once for the life of the chunk object. */
export function chunkHeights(chunk: BuildChunk): Int16Array | null {
  let hit = groundCache.get(chunk);
  if (hit === undefined) groundCache.set(chunk, (hit = decodeHeights(chunk.heights)));
  return hit;
}

const MARKS = /^[.aensw]*$/;

/**
 * A chunk's stair marks, one per cell row-major, or null when it has none
 * or they are malformed. Wall derivation and the secret-door projection
 * both read marks through this, so they never disagree on a bad string.
 */
export function chunkMarks(chunk: Pick<BuildChunk, "up">): string | null {
  const up = chunk.up;
  return typeof up === "string" && up.length === STAIRS_CHARS && MARKS.test(up) ? up : null;
}

/** A cell's stair mark in its chunk, "." when it has none. */
export function markIn(chunk: Pick<BuildChunk, "up" | "cx" | "cy"> | undefined, x: number, y: number): StairMark {
  if (!chunk) return ".";
  const marks = chunkMarks(chunk);
  if (marks === null) return ".";
  return marks[(y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS)] as StairMark;
}

// ---------------------------------------------------------------------------
// Ground

type Chunks = Readonly<Record<string, BuildChunk>>;

/** A cell's ground in feet: its painted height, 0 where none is painted. */
export function groundAt(chunks: Chunks, sceneId: SceneId, x: number, y: number): number {
  const cx = Math.floor(x / CHUNK_CELLS);
  const cy = Math.floor(y / CHUNK_CELLS);
  const chunk = chunks[`${sceneId}:${cx},${cy}`];
  if (!chunk) return 0;
  const heights = chunkHeights(chunk);
  return heights ? heights[(y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS)]! : 0;
}

/** The highest ground over a range of cells. */
export function rangeGround(chunks: Chunks, sceneId: SceneId, r: CellRange): number {
  return groundOver(r, (cx, cy) => {
    const chunk = chunks[`${sceneId}:${cx},${cy}`];
    return chunk ? chunkHeights(chunk) : null;
  });
}

/**
 * `rangeGround` on one scene for a caller asking at many spots, as a trap
 * walk does at every spot over an armed square (docs/design-v1-traps.md
 * 9): it looks each chunk up once, not once a spot.
 */
export function sceneGround(chunks: Chunks, sceneId: SceneId): (r: CellRange) => number {
  const kept = new Map<number, Int16Array | null>();
  // A walk stays in one chunk for many spots in a row.
  let lastKey = NaN;
  let last: Int16Array | null = null;
  const heightsAt = (cx: number, cy: number): Int16Array | null => {
    // Unique for any chunk of a scene: one is at most a few hundred cells a side.
    const key = (cy + 32768) * 65536 + (cx + 32768);
    if (key === lastKey) return last;
    let hit = kept.get(key);
    if (hit === undefined) {
      const chunk = chunks[`${sceneId}:${cx},${cy}`];
      kept.set(key, (hit = chunk ? chunkHeights(chunk) : null));
    }
    lastKey = key;
    last = hit;
    return hit;
  };
  return (r) => groundOver(r, heightsAt);
}

/** The highest ground over a range, read chunk by chunk, a chunk with no heights counting 0. */
function groundOver(r: CellRange, heightsAt: (cx: number, cy: number) => Int16Array | null): number {
  if (r.x0 >= r.x1 || r.y0 >= r.y1) return 0;
  let top = -Infinity;
  for (let cy = Math.floor(r.y0 / CHUNK_CELLS); cy <= Math.floor((r.y1 - 1) / CHUNK_CELLS); cy++) {
    for (let cx = Math.floor(r.x0 / CHUNK_CELLS); cx <= Math.floor((r.x1 - 1) / CHUNK_CELLS); cx++) {
      const heights = heightsAt(cx, cy);
      if (!heights) {
        if (top < 0) top = 0;
        continue;
      }
      const x0 = Math.max(r.x0, cx * CHUNK_CELLS);
      const x1 = Math.min(r.x1, (cx + 1) * CHUNK_CELLS);
      const y0 = Math.max(r.y0, cy * CHUNK_CELLS);
      const y1 = Math.min(r.y1, (cy + 1) * CHUNK_CELLS);
      for (let y = y0; y < y1; y++) {
        const row = (y - cy * CHUNK_CELLS) * CHUNK_CELLS - cx * CHUNK_CELLS;
        for (let x = x0; x < x1; x++) {
          const v = heights[row + x]!;
          if (v > top) top = v;
        }
      }
    }
  }
  return top;
}

/**
 * A footprint's ground: the highest ground under the cells it stands in
 * (footprint.ts `occupiedRange`, the squeezed footprint while it squeezes).
 */
export function footprintGround(chunks: Chunks, token: PlacedToken & { sceneId: SceneId }): number {
  return rangeGround(chunks, token.sceneId, occupiedRange(SQUARES, token));
}

/**
 * Where a token is relative to the ground under it. Below it is legitimate,
 * for burrowing, and nothing raises an elevation on its own.
 */
export type Standing = "ground" | "flying" | "inside";

export function standing(elevation: number, ground: number): Standing {
  return elevation === ground ? "ground" : elevation > ground ? "flying" : "inside";
}

/**
 * How a token stands for a walk: by its height over the ground under it, or
 * on the ground where its walk off a holder says so (rules/attach.ts
 * walkerFor), which every walk rule reads alike.
 */
export function footing(chunks: Chunks, token: PlacedToken & { sceneId: SceneId; elevation: number; footing?: Standing }): Standing {
  return token.footing ?? standing(token.elevation, footprintGround(chunks, token));
}

// ---------------------------------------------------------------------------
// Stair directions

export const COMPASS: readonly Compass[] = ["n", "e", "s", "w"];
/** Each compass point as a step on the y-down grid. */
export const STEP: Readonly<Record<Compass, readonly [number, number]>> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const OPPOSITE: Readonly<Record<Compass, Compass>> = { n: "s", e: "w", s: "n", w: "e" };

/**
 * What working out stair directions reads, over a window of cells: each
 * cell's mark (`StairMark`, or "." for a cell that is not a stair, and "a"
 * for a Stairs terrain cell without a mark), its ground, and whether it lies
 * inside the scene. Cells outside the window lie outside the scene.
 */
export type StairGrid = {
  w: number;
  h: number;
  mark(k: number): StairMark;
  ground(k: number): number;
  inScene(k: number): boolean;
};

/**
 * Which way each stair cell of a window points up (section 4.2): its
 * explicit direction, else its one orthogonal neighbor in the scene with
 * higher ground, if exactly one, else, repeating until nothing changes, the
 * direction of the adjacent directed stairs that lie straight up or down
 * their own line, when they all agree. So a run of stairs passes its
 * direction down to the cells below it, and a stair between two runs
 * pointing different ways has none.
 *
 * Every repeat decides from the directions settled before it, so the
 * answer does not depend on the order cells are visited in, and each cell is
 * looked at again only when a neighbor has just been settled, so the work is
 * linear in the number of stairs.
 *
 * Returns, per cell index, 0 for a cell that is not a stair or has no
 * direction, else 1 + the index of its direction in COMPASS.
 */
export function stairDirections(g: StairGrid, stairs: readonly number[]): Uint8Array {
  const dir = new Uint8Array(g.w * g.h);
  const neighbor = (k: number, d: Compass): number => {
    const x = (k % g.w) + STEP[d][0];
    const y = (k - (k % g.w)) / g.w + STEP[d][1];
    return x < 0 || y < 0 || x >= g.w || y >= g.h ? -1 : y * g.w + x;
  };
  const stairAt = (k: number) => k >= 0 && g.mark(k) !== ".";
  let settled: number[] = [];
  for (const k of stairs) {
    const mark = g.mark(k);
    if (mark === "n" || mark === "e" || mark === "s" || mark === "w") {
      dir[k] = 1 + COMPASS.indexOf(mark);
      settled.push(k);
      continue;
    }
    const own = g.ground(k);
    let up = -1;
    let higher = 0;
    for (let d = 0; d < 4; d++) {
      const j = neighbor(k, COMPASS[d]!);
      if (j < 0 || !g.inScene(j) || !(g.ground(j) > own)) continue;
      higher++;
      up = d;
    }
    if (higher === 1) {
      dir[k] = 1 + up;
      settled.push(k);
    }
  }
  const tried = new Uint8Array(g.w * g.h);
  while (settled.length > 0) {
    const candidates: number[] = [];
    for (const k of settled) {
      for (const d of COMPASS) {
        const j = neighbor(k, d);
        if (stairAt(j) && dir[j] === 0 && tried[j] !== 1) {
          tried[j] = 1;
          candidates.push(j);
        }
      }
    }
    const next: [number, number][] = [];
    for (const k of candidates) {
      tried[k] = 0;
      let found = 0;
      let conflict = false;
      for (const d of COMPASS) {
        const j = neighbor(k, d);
        if (j < 0 || dir[j] === 0) continue;
        const theirs = COMPASS[dir[j]! - 1]!;
        // The neighbor lies on its own line through this cell only when it points toward or away from it.
        if (theirs !== d && theirs !== OPPOSITE[d]) continue;
        if (found === 0) found = dir[j]!;
        else if (found !== dir[j]) conflict = true;
      }
      if (found !== 0 && !conflict) next.push([k, found]);
    }
    for (const [k, d] of next) dir[k] = d;
    settled = next.map(([k]) => k);
  }
  return dir;
}

/** The compass point a direction code from `stairDirections` names, or null for 0. */
export function compassOf(code: number): Compass | null {
  return code === 0 ? null : COMPASS[code - 1]!;
}
