import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { chunkMarks, STEP, type Compass, type Facing } from "#shared/rules/heights.ts";
import type { Point } from "./camera.ts";

/**
 * Stairs as steps (docs/design/design-v1-iso-depth.md 5.2): which stairs of a
 * square scene climb in treads, and how high. A run is a straight chain of
 * stairs all pointing one way up, each the next one's neighbor below it. Its
 * foot is the square before its lowest stair and its head the square past its
 * top one, and it climbs evenly from the foot's drawn ground to the head's,
 * each stair taking an equal span and five treads in it. A run steps only when
 * its foot, its head and its stairs are in the scene and seen, its head is
 * higher than its foot, neither end is another stair (a turn in the stairs,
 * which keeps today's look), and each stair's own ground lies inside its span,
 * so treads never stray from the rules' ground by more than a span. The
 * drawing, the picks, a standee's base and the drag all read one index, built
 * with the drawn heights (view.ts drawnHeights), so they always agree.
 */

/** Treads a stair climbs in, as many as its Top-down symbol shows (builder/heights/relief.ts TREADS). */
export const TREADS = 5;

/** A stepping stair: the way it climbs, and its span in cells of height, from `lo` at its foot side to `hi` at its head side. */
export type StairStep = { readonly d: Compass; readonly lo: number; readonly hi: number };

/** The stepping stairs of a scene, by cell. */
export type StairRuns = {
  at(x: number, y: number): StairStep | undefined;
  /**
   * The entries of one 16 by 16 chunk, `x,y,d,lo,hi;` each, as one string,
   * so a bucket's signature compares them by value: an edit anywhere along a
   * run changes the strings of exactly the chunks whose stairs it changes.
   */
  chunkSig(cx: number, cy: number): string;
  /** Every tread's height, each once: what a drag's levels add (canvas/isoDrag.ts levelsOf). */
  readonly treads: readonly number[];
  /** Every stepping stair's cell, "x,y;" each in row order: the same string while the same stairs step, whatever their spans. */
  readonly cells: string;
  readonly size: number;
};

export const NO_RUNS: StairRuns = { at: () => undefined, chunkSig: () => "", treads: [], cells: "", size: 0 };

/** Each cell's key as one number, as groundCells.ts cellId keys a cell. */
function idOf(x: number, y: number): number {
  return (y + 4096) * 8192 + (x + 4096);
}

/** A span's ends may be a float's hair off a stair's whole-foot ground. */
const EPS = 1e-9;

function isCompass(f: Facing | null | undefined): f is Compass {
  return f === "n" || f === "e" || f === "s" || f === "w";
}

/** A stair's direction reader: the walls' rule (shared/rules/walls.ts WallSet), whose identity says when its stairs changed. */
export type StairReader = { stairAt(x: number, y: number): Facing | null | undefined };

/**
 * Finds every run among `cells`, the stairs of the scene, walking each run
 * once from its lowest stair, so the cost is linear in its stairs.
 * `stairAt` is the walls' rule (shared/rules/walls.ts WallSet.stairAt): a
 * player's directions are the ones the server projects (`upDir`). `ground` is
 * a cell's drawn ground in cells of height, and `seen` whether the cell is in
 * the scene and seen by this viewer (heights/ground.ts seenGround not null).
 */
export function stairRuns(cells: Iterable<Point>, stairAt: (x: number, y: number) => Facing | null | undefined, ground: (x: number, y: number) => number, seen: (x: number, y: number) => boolean): StairRuns {
  const steps = new Map<number, StairStep>();
  const found: (Point & { s: StairStep })[] = [];
  for (const c of cells) {
    const d = stairAt(c.x, c.y);
    if (!isCompass(d)) continue;
    const [dx, dy] = STEP[d];
    // Walked from its lowest stair only.
    if (stairAt(c.x - dx, c.y - dy) === d) continue;
    const run: Point[] = [c];
    let x = c.x + dx;
    let y = c.y + dy;
    while (stairAt(x, y) === d) {
      run.push({ x, y });
      x += dx;
      y += dy;
    }
    const foot = { x: c.x - dx, y: c.y - dy };
    const head = { x, y };
    if (stairAt(foot.x, foot.y) !== undefined || stairAt(head.x, head.y) !== undefined) continue;
    if (!seen(foot.x, foot.y) || !seen(head.x, head.y) || !run.every((s) => seen(s.x, s.y))) continue;
    const f = ground(foot.x, foot.y);
    const h = ground(head.x, head.y);
    if (!(h > f)) continue;
    const n = run.length;
    const lo = (i: number) => f + (i * (h - f)) / n;
    if (!run.every((s, i) => ground(s.x, s.y) >= lo(i) - EPS && ground(s.x, s.y) <= lo(i + 1) + EPS)) continue;
    run.forEach((c, i) => {
      const s: StairStep = { d, lo: lo(i), hi: lo(i + 1) };
      steps.set(idOf(c.x, c.y), s);
      found.push({ x: c.x, y: c.y, s });
    });
  }
  if (steps.size === 0) return NO_RUNS;
  const byChunk = new Map<string, string>();
  let all = "";
  for (const { x, y, s } of found.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const key = `${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`;
    byChunk.set(key, `${byChunk.get(key) ?? ""}${x},${y},${s.d},${s.lo},${s.hi};`);
    all += `${x},${y};`;
  }
  const treads = new Set<number>();
  for (const s of steps.values()) for (let k = 0; k < TREADS; k++) treads.add(treadHeight(s, k));
  return {
    at: (x, y) => steps.get(idOf(x, y)),
    chunkSig: (cx, cy) => byChunk.get(`${cx},${cy}`) ?? "",
    treads: [...treads],
    cells: all,
    size: steps.size,
  };
}

/** Tread `k`'s height in cells, from 0 at the foot side: its span's low end and `k` fifths of the span. */
export function treadHeight(s: StairStep, k: number): number {
  return s.lo + (k * (s.hi - s.lo)) / TREADS;
}

/** How far a world point lies up a stair's square at x, y along its climb, 0 at its foot side and 1 at its head side, the point held to the square. */
export function alongStair(s: Pick<StairStep, "d">, x: number, y: number, p: Point): number {
  const u = Math.min(1, Math.max(0, p.x - x));
  const v = Math.min(1, Math.max(0, p.y - y));
  switch (s.d) {
    case "e":
      return u;
    case "w":
      return 1 - u;
    case "s":
      return v;
    default:
      return 1 - v;
  }
}

/** The tread under a world point of a stair's square at x, y, the point held to the square: on a line between two, the higher. */
export function treadAt(s: StairStep, x: number, y: number, p: Point): number {
  return Math.min(TREADS - 1, Math.floor(alongStair(s, x, y, p) * TREADS));
}

/** The height of the tread under a world point of a stair's square, in cells. */
export function treadUnder(s: StairStep, x: number, y: number, p: Point): number {
  return treadHeight(s, treadAt(s, x, y, p));
}

/** Each chunk's stair cells (its stair marks and its Stairs terrain), kept with the chunk, which the store replaces on any change. */
const chunkStairs = new WeakMap<BuildChunk, readonly Point[]>();

/** The cells of a chunk that may hold a stair: a stair mark, or Stairs terrain. */
export function stairCandidates(chunk: BuildChunk): readonly Point[] {
  let kept = chunkStairs.get(chunk);
  if (kept) return kept;
  const out: Point[] = [];
  const marks = chunkMarks(chunk);
  const x0 = chunk.cx * CHUNK_CELLS;
  const y0 = chunk.cy * CHUNK_CELLS;
  if (marks !== null) for (let k = 0; k < marks.length; k++) if (marks[k] !== ".") out.push({ x: x0 + (k % CHUNK_CELLS), y: y0 + Math.floor(k / CHUNK_CELLS) });
  for (const key in chunk.cells) {
    if (chunk.cells[key] !== "stairs") continue;
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (Number.isInteger(x) && Number.isInteger(y) && (marks === null || marks[(y - y0) * CHUNK_CELLS + (x - x0)] === ".")) out.push({ x, y });
  }
  chunkStairs.set(chunk, (kept = out));
  return kept;
}
