import { chunkKey } from "../keys.ts";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type RoomState, type SceneId, type Trap } from "../model.ts";
import { isWritable } from "../writable.ts";
import { chunkHeights, chunkMarks, encodeHeights, groundAt, stepper } from "./heights.ts";
import { gridOfShape, isHex } from "./grid.ts";
import { hexInScene, type HexGrid } from "./hex.ts";

/*
 * The pit border counted ahead (docs/design-v1-traps.md 6.7). A pit's walls
 * count from the moment its trap exists, as doors count whatever their
 * state: the split's counting pass and the potential sight pieces read the
 * scene with every edge a pit can raise or flatten counted as a piece of
 * its own. So any set of opened pits, in any order, is within what was
 * counted, and opening one never raises a count.
 *
 * Opening pits changes only the ground of their squares, so the only grid
 * edges that can read otherwise are those between two squares of different
 * sets of pits (a pit's border, and between two pits), those inside one set
 * that are raised while it is shut, and the edges of stairs whose direction
 * a pit's ground can change, which flows along their whole flight. Counting
 * each as a raised edge, as the design words it, is not enough: raised
 * edges alike merge into one piece, so an opened pit whose rim meets ground
 * of several heights splits runs the shut one kept whole. Every such edge
 * is read as a closed door instead, which stays one piece whatever is next
 * to it, and so is every grid edge that meets one of them across a corner,
 * where an opened pit's ledge running straight through could cut a run in
 * two. Any opened layout then splits into no more pieces, and no more pairs
 * with free walls, than this reading has.
 *
 * On a hex scene (H3) no grid line runs raised sides together: each is a
 * piece of its own, raised wherever the two hexes' ground differs, and a
 * stair's direction only says whether it is a ledge, which no count reads.
 * So the reading raises every side an opened layout could: each pit hex
 * is given ground unlike that of every neighbor outside its set of pits,
 * and unlike that of each neighbor of its set whose ground differs from its
 * own now. Sides only get added, and a count only grows with them.
 */

/** The pit traps of a scene, in id order so every server counts them alike. */
export function pitTraps(state: Pick<RoomState, "traps">, sceneId: SceneId): Trap[] {
  const out: Trap[] = [];
  for (const trap of Object.values(state.traps ?? {})) if (trap.sceneId === sceneId && trap.rig?.pit && "cells" in trap.zone) out.push(trap);
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type Counted = Pick<RoomState, "scenes" | "buildChunks" | "traps">;

/**
 * The scenes and build chunks as the split's counting pass and the sight
 * cap read one scene: as stored when it has no pit trap, else with the
 * edges its pits can change read as closed doors. Only that scene's chunks
 * differ.
 */
export function withPitsCounted(state: Counted, sceneId: SceneId): Pick<RoomState, "scenes" | "buildChunks"> {
  // Most ops change neither the traps nor the build, so their checks reuse the last read whole.
  const cacheable = state.traps !== undefined && !isWritable(state.traps) && !isWritable(state.buildChunks);
  const byTraps = cacheable ? (readCache.get(state.traps) ?? new WeakMap()) : null;
  const hit = byTraps?.get(state.buildChunks)?.get(sceneId);
  if (hit && hit.scene === state.scenes[sceneId]) return { scenes: state.scenes, buildChunks: hit.chunks };
  const chunks = countedChunks(state, sceneId);
  if (byTraps) {
    readCache.set(state.traps, byTraps);
    let scenes = byTraps.get(state.buildChunks);
    if (!scenes) byTraps.set(state.buildChunks, (scenes = new Map()));
    scenes.set(sceneId, { scene: state.scenes[sceneId], chunks });
  }
  return { scenes: state.scenes, buildChunks: chunks };
}

const readCache = new WeakMap<object, WeakMap<object, Map<SceneId, { scene: unknown; chunks: Readonly<Record<string, BuildChunk>> }>>>();

/** The last read per scene, so repeated checks on an unchanged scene reuse its chunks, and with them its derived walls (walls.ts caches by chunk). */
const lastRead = new Map<SceneId, { traps: readonly Trap[]; chunks: readonly BuildChunk[]; bounds: unknown; out: Record<string, BuildChunk> }>();
const MAX_KEPT = 16;

const CLOSED_DOOR: EdgeFeature = { kind: "door", state: "closed", secret: false, discovered: false };
const STEPS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** The edge between two cells beside each other, as the build keys it. */
function between(x: number, y: number, nx: number, ny: number): string {
  return nx === x ? `${x},${Math.max(y, ny)},n` : `${Math.max(x, nx)},${y},w`;
}

function cellOf(at: string): [number, number] {
  const comma = at.indexOf(",");
  return [Number(at.slice(0, comma)), Number(at.slice(comma + 1))];
}

function countedChunks(state: Counted, sceneId: SceneId): Readonly<Record<string, BuildChunk>> {
  const traps = pitTraps(state, sceneId);
  const scene = state.scenes[sceneId];
  if (traps.length === 0 || !scene) return state.buildChunks;
  const own = Object.values(state.buildChunks).filter((c) => c.sceneId === sceneId);
  const last = lastRead.get(sceneId);
  if (last && last.bounds === scene.bounds && sameList(last.traps, traps) && sameList(last.chunks, own)) return { ...state.buildChunks, ...last.out };

  const grid = gridOfShape(scene.gridShape);
  if (isHex(grid)) {
    const out = hexCounted(state, sceneId, grid, traps, scene.bounds);
    lastRead.delete(sceneId);
    lastRead.set(sceneId, { traps, chunks: own, bounds: scene.bounds, out });
    if (lastRead.size > MAX_KEPT) lastRead.delete(lastRead.keys().next().value!);
    return { ...state.buildChunks, ...out };
  }
  const { w, h } = scene.bounds;
  const inScene = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  // Each pit square's set of pits.
  const sets = new Map<string, string>();
  for (const trap of traps) {
    if (!("cells" in trap.zone)) continue;
    const mine = new Set<string>();
    for (const r of trap.zone.cells) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const at = `${x},${y}`;
          if (mine.has(at) || !inScene(x, y)) continue;
          mine.add(at);
          const set = sets.get(at);
          sets.set(at, set === undefined ? trap.id : `${set} ${trap.id}`);
        }
      }
    }
  }
  const ground = (x: number, y: number) => groundAt(state.buildChunks, sceneId, x, y);
  const edges = new Set<string>();
  for (const [at, set] of sets) {
    const [x, y] = cellOf(at);
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inScene(nx, ny)) continue;
      if (sets.get(`${nx},${ny}`) !== set || ground(x, y) !== ground(nx, ny)) edges.add(between(x, y, nx, ny));
    }
  }
  // A stair's direction can follow its neighbors' ground, and passes along its flight: every flight a pit touches.
  const stairs = stairCells(own);
  const flight: string[] = [];
  const reached = new Set<string>();
  for (const at of stairs) {
    const [x, y] = cellOf(at);
    if (reached.has(at) || !(sets.has(at) || STEPS.some(([dx, dy]) => sets.has(`${x + dx},${y + dy}`)))) continue;
    reached.add(at);
    flight.push(at);
  }
  while (flight.length > 0) {
    const [x, y] = cellOf(flight.pop()!);
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inScene(nx, ny)) continue;
      edges.add(between(x, y, nx, ny));
      const next = `${nx},${ny}`;
      if (stairs.has(next) && !reached.has(next)) {
        reached.add(next);
        flight.push(next);
      }
    }
  }
  // A ledge running straight through a corner cuts the grid line across it there (walls.ts gridCandidates), so the edges
  // meeting a vertical one at its corners stand alone too.
  for (const key of [...edges]) {
    if (!key.endsWith(",w")) continue;
    const [x, y] = cellOf(key.slice(0, -2));
    for (const cy of [y, y + 1]) for (const cx of [x - 1, x]) if (cx >= 0 && cx < w && cy > 0 && cy < h) edges.add(`${cx},${cy},n`);
  }

  const out: Record<string, BuildChunk> = {};
  for (const key of [...edges].sort()) {
    const [x, y] = cellOf(key.slice(0, -2));
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const at = chunkKey(sceneId, cx, cy);
    const chunk = out[at] ?? state.buildChunks[at] ?? { sceneId, cx, cy, rev: 0, cells: {}, edges: {} };
    const feature = chunk.edges[key];
    // A door is one piece that counts already. A window counts only once raised, so it is read as a door too.
    if (feature?.kind === "door") continue;
    out[at] = { ...chunk, edges: { ...chunk.edges, [key]: CLOSED_DOOR } };
  }
  lastRead.delete(sceneId);
  lastRead.set(sceneId, { traps, chunks: own, bounds: scene.bounds, out });
  if (lastRead.size > MAX_KEPT) lastRead.delete(lastRead.keys().next().value!);
  return { ...state.buildChunks, ...out };
}

/** A hex scene's chunks under its pits with the ground the count reads (the file's note): every side an opened layout could raise, raised. */
function hexCounted(state: Counted, sceneId: SceneId, g: HexGrid, traps: readonly Trap[], bounds: { w: number; h: number }): Record<string, BuildChunk> {
  const sets = new Map<string, string>();
  for (const trap of traps) {
    if (!("cells" in trap.zone)) continue;
    const mine = new Set<string>();
    for (const r of trap.zone.cells) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const at = `${x},${y}`;
          if (mine.has(at) || !hexInScene(g, bounds, { col: x, row: y })) continue;
          mine.add(at);
          const set = sets.get(at);
          sets.set(at, set === undefined ? trap.id : `${set} ${trap.id}`);
        }
      }
    }
  }
  const step = stepper(g);
  const ground = (x: number, y: number) => groundAt(state.buildChunks, sceneId, x, y);
  const given = new Map<string, number>();
  for (const at of [...sets.keys()].sort(byKey)) {
    const [x, y] = cellOf(at);
    const set = sets.get(at)!;
    const own = ground(x, y);
    const unlike = new Set<number>();
    for (let d = 0; d < 6; d++) {
      const [nx, ny] = step(x, y, d);
      if (!hexInScene(g, bounds, { col: nx, row: ny })) continue;
      const next = `${nx},${ny}`;
      const theirs = sets.get(next);
      if (theirs === undefined) unlike.add(ground(nx, ny));
      else if (given.has(next) && (theirs !== set || ground(nx, ny) !== own)) unlike.add(given.get(next)!);
    }
    let v = own;
    while (unlike.has(v)) v++;
    given.set(at, v);
  }
  const out: Record<string, BuildChunk> = {};
  const feet = new Map<string, Int16Array>();
  for (const [at, v] of given) {
    const [x, y] = cellOf(at);
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const key = chunkKey(sceneId, cx, cy);
    let heights = feet.get(key);
    if (!heights) {
      const stored = state.buildChunks[key];
      feet.set(key, (heights = stored ? Int16Array.from(chunkHeights(stored) ?? new Int16Array(CHUNK_CELLS * CHUNK_CELLS)) : new Int16Array(CHUNK_CELLS * CHUNK_CELLS)));
      out[key] = stored ?? { sceneId, cx, cy, rev: 0, cells: {}, edges: {}, grid: g.orient === "rows" ? "hexRows" : "hexColumns" };
    }
    heights[(y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS)] = v;
  }
  for (const [key, heights] of feet) {
    const encoded = encodeHeights(heights);
    const { heights: _heights, ...rest } = out[key]!;
    out[key] = encoded === undefined ? rest : { ...rest, heights: encoded };
  }
  return out;
}

function byKey(a: string, b: string): number {
  const [ax, ay] = cellOf(a);
  const [bx, by] = cellOf(b);
  return ay - by || ax - bx;
}

/** The scene's stair cells, by terrain or by mark, as `x,y`. */
function stairCells(chunks: readonly BuildChunk[]): Set<string> {
  const out = new Set<string>();
  for (const chunk of chunks) {
    for (const [at, terrain] of Object.entries(chunk.cells)) if (terrain === "stairs") out.add(at);
    const marks = chunkMarks(chunk);
    if (marks === null) continue;
    for (let k = 0; k < marks.length; k++) {
      if (marks[k] === ".") continue;
      out.add(`${chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS)},${chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS)}`);
    }
  }
  return out;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The scenes whose counted pits an op changed: a pit trap made, deleted, moved, or its pit set or cleared. */
export function pitsMoved(before: Pick<RoomState, "traps">, after: Pick<RoomState, "traps">, trapIds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const id of trapIds) {
    const was = before.traps?.[id];
    const now = after.traps?.[id];
    if (was === now) continue;
    const pitOf = (t: Trap | undefined) => (t?.rig?.pit && "cells" in t.zone ? t : undefined);
    const a = pitOf(was);
    const b = pitOf(now);
    if (!a && !b) continue;
    if (a && b && a.sceneId === b.sceneId && JSON.stringify(a.zone) === JSON.stringify(b.zone)) continue;
    if (a) out.add(a.sceneId);
    if (b) out.add(b.sceneId);
  }
  return [...out];
}
