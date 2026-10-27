import assert from "node:assert/strict";
import type { AreaShape, BuildChunk, EdgeFeature, FreeWall } from "#shared/model.ts";
import { defaultIncludeOrigin, hexStackPrisms, type AreaContext, type AreaTemplateInput, type AreaToken, type ResolvedArea } from "#shared/rules/aoe.ts";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import { hexAt, hexKey } from "#shared/rules/hex.ts";
import { deriveWalls, indexBuild, pointInPolygon, type WallSet } from "#shared/rules/walls.ts";
import type { Turn } from "../../lib/view.ts";
import { bandAt, volumeInternals, type Volume, type VolumeJob, type VolumeLine, type VolumePlane, type VolumePoly } from "./volume.ts";

/**
 * What the tests of an area's solid share (volume.test.ts and
 * volume.promise.test.ts): random scenes and areas, and reading the mesh
 * back as the heights it holds over a map point.
 */

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TURNS: readonly Turn[] = [0, 1, 2, 3];
export const SHAPES: readonly AreaShape[] = ["sphere", "cylinder", "cone", "cube", "line", "emanation"];

export function tok(id: string, over: Partial<AreaToken> = {}): AreaToken {
  return { id, rev: 1, size: "medium", x: 10, y: 10, elevation: 0, ...over };
}

export function ctxOf(bounds: { w: number; h: number }, walls: WallSet | null, tokens: Record<string, AreaToken> = {}, grid: Grid = SQUARES): AreaContext {
  return { settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell", diagonal: "five" }, bounds, grid, walls, tokens };
}

/** Drawn ground in cells of height, row-major over the scene. */
export type Ground = { w: number; h: number; z: Float64Array; at(x: number, y: number): number };

export function flatGround(w: number, h: number): Ground {
  const z = new Float64Array(w * h);
  return { w, h, z, at: (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? z[y * w + x]! : 0) };
}

export function rect(x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push(`${i},${j}`);
  return out;
}

/** A random build: rooms with their automatic walls, walls and doors on grid lines, and free walls at angles. */
export function randomWalls(rand: () => number, w: number, h: number): WallSet {
  const cells: string[] = [];
  for (let r = 0; r < 3; r++) {
    const rw = 4 + Math.floor(rand() * 10);
    const rh = 4 + Math.floor(rand() * 10);
    cells.push(...rect(Math.floor(rand() * (w - rw)), Math.floor(rand() * (h - rh)), rw, rh));
  }
  const edges: Record<string, EdgeFeature> = {};
  for (let e = 0; e < 12; e++) {
    const key = `${Math.floor(rand() * w)},${Math.floor(rand() * h)},${rand() < 0.5 ? "n" : "w"}`;
    edges[key] = rand() < 0.6 ? { kind: "wall" } : { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: false, discovered: false };
  }
  const walls: FreeWall[] = [];
  for (let f = 0; f < 3; f++) {
    const ax = Math.round((2 + rand() * (w - 4)) * 64) / 64;
    const ay = Math.round((2 + rand() * (h - 4)) * 64) / 64;
    const len = 1 + rand() * 6;
    const t = rand() * 2 * Math.PI;
    const bx = Math.round(Math.min(w - 0.5, Math.max(0.5, ax + len * Math.cos(t))) * 64) / 64;
    const by = Math.round(Math.min(h - 0.5, Math.max(0.5, ay + len * Math.sin(t))) * 64) / 64;
    walls.push({ id: `wall${String(f).padStart(8, "0")}`, a: [ax, ay], b: [bx, by], f: { kind: "wall" } });
  }
  const chunk: BuildChunk = { sceneId: "s", cx: 0, cy: 0, rev: 1, cells: Object.fromEntries(cells.map((k) => [k, "stone" as const])), edges, walls };
  return deriveWalls(indexBuild([chunk]), `v${rand()}`);
}

/** Walls filed in the 16 by 16 chunks they lie in, as a built scene stores them. */
function wallsOf(cells: readonly string[], edges: Record<string, EdgeFeature>, walls: readonly FreeWall[], version: string): WallSet {
  const chunks = new Map<string, BuildChunk>();
  const at = (x: number, y: number) => {
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const key = `${cx},${cy}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { sceneId: "s", cx, cy, rev: 1, cells: {}, edges: {}, walls: [] }));
    return c;
  };
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    at(x!, y!).cells[k] = "stone";
  }
  for (const [k, f] of Object.entries(edges)) {
    const [x, y] = k.split(",").map(Number);
    at(x!, y!).edges[k] = f;
  }
  for (const wall of walls) at((wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2).walls!.push(wall);
  return deriveWalls(indexBuild([...chunks.values()]), version);
}

/** A free wall from a point, its ends on the 1/64 cell lattice walls snap to. */
function freeWall(n: number, ax: number, ay: number, len: number, t: number, w: number, h: number): FreeWall {
  const snap = (v: number, max: number) => Math.round(Math.min(max - 0.5, Math.max(0.5, v)) * 64) / 64;
  return { id: `wall${String(n).padStart(8, "0")}`, a: [snap(ax, w), snap(ay, h)], b: [snap(ax + len * Math.cos(t), w), snap(ay + len * Math.sin(t), h)], f: { kind: "wall" } };
}

/** A dense dungeon (review ISOA1-F-3): rooms, loose wall edges and short free walls strewn over the scene. */
export function dungeonWalls(rand: () => number, w: number, h: number, rooms = 40, edgeCount = 200, free = 30): WallSet {
  const cells: string[] = [];
  for (let r = 0; r < rooms; r++) {
    const rw = 4 + Math.floor(rand() * 10);
    const rh = 4 + Math.floor(rand() * 10);
    cells.push(...rect(Math.floor(rand() * (w - rw)), Math.floor(rand() * (h - rh)), rw, rh));
  }
  const edges: Record<string, EdgeFeature> = {};
  for (let e = 0; e < edgeCount; e++) edges[`${Math.floor(rand() * w)},${Math.floor(rand() * h)},${rand() < 0.5 ? "n" : "w"}`] = { kind: "wall" };
  const walls: FreeWall[] = [];
  for (let f = 0; f < free; f++) walls.push(freeWall(f, 2 + rand() * (w - 4), 2 + rand() * (h - 4), 1 + rand() * 6, rand() * 2 * Math.PI, w, h));
  return wallsOf([...new Set(cells)], edges, walls, `dungeon-${rand()}`);
}

/** Short free walls strewn round a point, as pillars and rubble round a caster (review ISOA1-ASTRA-01). */
export function wallsAround(rand: () => number, cx: number, cy: number, w: number, h: number, count = 32): WallSet {
  const walls: FreeWall[] = [];
  for (let f = 0; f < count; f++) {
    const t = (2 * Math.PI * f) / count;
    const r = 3 + rand() * 9;
    walls.push(freeWall(f, cx + r * Math.cos(t), cy + r * Math.sin(t), 0.5 + rand() * 1.5, rand() * 2 * Math.PI, w, h));
  }
  return wallsOf([], {}, walls, `around-${rand()}`);
}

/** Random platforms and pits, some at heights that are not whole cells. */
export function randomGround(rand: () => number, w: number, h: number): Ground {
  const g = flatGround(w, h);
  for (let k = 0; k < 6; k++) {
    const rw = 1 + Math.floor(rand() * 6);
    const rh = 1 + Math.floor(rand() * 6);
    const x0 = Math.floor(rand() * (w - rw));
    const y0 = Math.floor(rand() * (h - rh));
    const z = [1, 2, 3, 0.4, 1.6, -1, -2, -4, -0.6][Math.floor(rand() * 9)]!;
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) g.z[y * w + x] = z;
  }
  return g;
}

export function randomTemplate(rand: () => number, w: number, h: number, tokens: Record<string, AreaToken>, i: number): AreaTemplateInput {
  const shape = SHAPES[i % SHAPES.length]!;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const origin = { x: 3 + rand() * (w - 6), y: 3 + rand() * (h - 6), z: pick([0, 5, -10, 12.5, 20]) };
  const base: AreaTemplateInput = {
    id: `t${i}`,
    rev: 1,
    shape,
    size: rand() < 0.7 ? pick([5, 10, 15, 20, 30]) : 5 + rand() * 40,
    origin,
    yaw: pick([0, 90, 45, 180, rand() * 360]),
    includeOrigin: defaultIncludeOrigin(shape),
    pitch: pick([0, 90, -90, 40, -30, rand() * 180 - 90]),
    width: pick([5, 10]),
    height: pick([10, 20, 40]),
    anchor: pick(["bottom", "top"] as const),
    faceOffset: { u: rand() - 0.5, v: rand() - 0.5 },
  };
  if (shape !== "emanation" || rand() < 0.3) return base;
  const id = `k${i}`;
  tokens[id] = tok(id, { size: pick(["tiny", "medium", "large", "huge"] as const), x: Math.floor(origin.x), y: Math.floor(origin.y), elevation: pick([0, 5, 10]) });
  return { ...base, attachedTo: id };
}

/** The clip lines' test: within a hair of a polygon edge or a scene edge. */
export function onClipLine(area: ResolvedArea, bounds: { w: number; h: number }, x: number, y: number): boolean {
  const near = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    return len > 0 && Math.abs(((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len) <= 1e-7;
  };
  if (Math.abs(x) <= 1e-7 || Math.abs(y) <= 1e-7 || Math.abs(x - bounds.w) <= 1e-7 || Math.abs(y - bounds.h) <= 1e-7) return true;
  for (const p of area.polygons) {
    const k = p.length >> 1;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      if (near(p[2 * i]!, p[2 * i + 1]!, p[2 * j]!, p[2 * j + 1]!)) return true;
    }
  }
  return false;
}

export function inClip(area: ResolvedArea, bounds: { w: number; h: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= bounds.w && y <= bounds.h && (area.polygons.length === 0 || area.polygons.some((p) => pointInPolygon(p, x, y)));
}

/** How far the mesh may stray inside the true surface: a facet's middle is nearer the center than its corners. */
export function chordTolerance(vol: Volume): number {
  const n = vol.segments;
  const s = vol.solid;
  const off = n > 0 ? 1 - Math.cos(Math.PI / n) : 0;
  switch (s.kind) {
    case "sphere":
      return 2 * s.r * off;
    case "rounded":
      return 2 * s.D * off;
    case "cylinder":
      return s.r * off;
    case "cone":
      return (s.L / 2) * off;
    default:
      return 0;
  }
}

/**
 * Every directed edge is matched by the opposite one as often as it is
 * used, but those on the drawn ground. Twice each way is a pinch: a
 * sliver the clip leaves touching the rest of the solid along one upright
 * line, where a ray from a probe nudged off a wall's end runs a hair from
 * a face (the rules' polygons, aoe.ts `nudged`).
 */
export function assertClosed(vol: Volume, label: string): void {
  const edges = new Map<string, number>();
  for (const f of vol.faces()) {
    for (let k = 0; k < f.v.length; k++) {
      const key = `${f.v[k]},${f.v[(k + 1) % f.v.length]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split(",").map(Number) as [number, number];
    const back = edges.get(`${b},${a}`) ?? 0;
    if (back === 0) {
      assert.equal(count, 1, `${label}: open edge ${key} is used ${count} times the same way`);
      assert.ok(vol.onGround(a, b), `${label}: edge ${key} from ${vol.vertex(a)} to ${vol.vertex(b)} is open off the ground`);
      continue;
    }
    assert.equal(back, count, `${label}: edge ${key} is used ${count} times one way and ${back} the other`);
  }
  // The links the faces keep agree.
  for (const f of vol.faces()) {
    for (let k = 0; k < f.v.length; k++) {
      const twin = edges.has(`${f.v[(k + 1) % f.v.length]},${f.v[k]}`);
      assert.equal(f.nb[k]! >= 0, twin, `${label}: a face's link at edge ${f.v[k]},${f.v[(k + 1) % f.v.length]}`);
    }
  }
}

/** Lines that run in closed loops: each end meets an even number of them. */
export function assertLoops(lines: readonly VolumeLine[], label: string): void {
  const ends = new Map<string, number>();
  const key = (x: number, y: number, z: number) => [x, y, z].map((v) => v.toFixed(6)).join(",");
  for (const l of lines) for (const k of [key(l.ax, l.ay, l.az), key(l.bx, l.by, l.bz)]) ends.set(k, (ends.get(k) ?? 0) + 1);
  assert.ok(lines.length > 0, `${label}: no lines`);
  for (const [k, n] of ends) assert.equal(n % 2, 0, `${label}: ${n} lines end at ${k}`);
}

/** Each face lies in one band at every turn. */
export function assertBanded(vol: Volume, label: string): void {
  for (const turn of TURNS) {
    for (const f of vol.faces()) {
      let x = 0;
      let y = 0;
      for (const i of f.v) {
        const p = vol.vertex(i);
        x += p[0];
        y += p[1];
      }
      const band = bandAt(turn, x / f.v.length, y / f.v.length);
      for (const i of f.v) {
        const [vx, vy] = vol.vertex(i);
        const { c, s } = turnAxesOf(turn);
        const d = s * vx + c * vy;
        assert.ok(d >= band - 1e-9 && d <= band + 1 + 1e-9, `${label}: turn ${turn}, a vertex at depth ${d} in band ${band}`);
      }
    }
  }
}

export function turnAxesOf(turn: Turn): { c: number; s: number } {
  const R = Math.SQRT1_2;
  return [
    { c: R, s: R },
    { c: -R, s: R },
    { c: -R, s: -R },
    { c: R, s: -R },
  ][turn]!;
}

/**
 * The heights the mesh holds over a map point: the faces over it in height
 * order, each entered from below and left from above. Where the solid
 * sits on the drawn ground its bottom is open (a ground omission), and the
 * ground there closes it.
 */
export function meshIntervals(vol: Volume, faces: readonly number[], x: number, y: number, ground: number, label: string): [number, number][] {
  const hits: { z: number; up: boolean }[] = [];
  const all = vol.faces();
  for (const id of faces) {
    const f = all[id]!;
    if (Math.abs(f.nz) < 1e-9) continue;
    let inside = false;
    for (let i = 0, j = f.v.length - 1; i < f.v.length; j = i++) {
      const [xi, yi] = vol.vertex(f.v[i]!);
      const [xj, yj] = vol.vertex(f.v[j]!);
      if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
    if (!inside) continue;
    const [px, py, pz] = vol.vertex(f.v[0]!);
    hits.push({ z: pz - (f.nx * (x - px) + f.ny * (y - py)) / f.nz, up: f.nz > 0 });
  }
  hits.sort((a, b) => a.z - b.z || (a.up ? 1 : -1));
  if (hits[0]?.up) hits.unshift({ z: ground, up: false });
  const out: [number, number][] = [];
  for (let k = 0; k < hits.length; k += 2) {
    assert.ok(!hits[k]!.up && hits[k + 1]?.up === true, `${label}: crossings over ${x}, ${y} do not alternate: ${JSON.stringify(hits)}`);
    out.push([hits[k]!.z, hits[k + 1]!.z]);
  }
  return out;
}

/** The faces whose plan boxes hold a point, by a grid of cells. */
export function faceIndex(vol: Volume): (x: number, y: number) => number[] {
  const grid = new Map<string, number[]>();
  vol.faces().forEach((f, id) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of f.v) {
      const [x, y] = vol.vertex(i);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    for (let j = Math.floor(y0); j <= Math.floor(y1); j++) {
      for (let i = Math.floor(x0); i <= Math.floor(x1); i++) {
        const key = `${i},${j}`;
        const list = grid.get(key);
        if (list) list.push(id);
        else grid.set(key, [id]);
      }
    }
  });
  return (x, y) => grid.get(`${Math.floor(x)},${Math.floor(y)}`) ?? [];
}

/**
 * The solid the rules catch with, cut as the drawing cuts it: in the
 * clip, inside the shape (on hexes the prism of the hex there) and above
 * the drawn ground. Undefined within a hair of a boundary, where rounding
 * or the chords may fall either way.
 */
export function truth(area: ResolvedArea, bounds: { w: number; h: number }, ground: Ground, tol: number, x: number, y: number, z: number): boolean | undefined {
  if (!inClip(area, bounds, x, y)) return false;
  const g = ground.at(Math.floor(x), Math.floor(y));
  if (Math.abs(z - g) < 1e-6) return undefined;
  if (z < g) return false;
  if (area.solid.kind === "hexStack") {
    const hex = hexAt(area.solid.reach.g, { x, y });
    const p = hexStackPrisms(area.solid).find((q) => hexKey(q.hex) === hexKey(hex));
    if (!p) return false;
    if (Math.abs(z - p.lo) < 1e-6 || Math.abs(z - p.hi) < 1e-6) return undefined;
    return z > p.lo && z < p.hi;
  }
  const sd = area.shape.sd(x, y, z);
  if (sd > 1e-9) return false;
  if (sd < -tol - 1e-7) return true;
  return undefined;
}

// ---------------------------------------------------------------- the build's loops, one at a time

const { Budget, Store, loopsOnLine, earClip, LineIndex, NearLines, lineThrough } = volumeInternals;
type Budget = InstanceType<typeof Budget>;
type Store = InstanceType<typeof Store>;

/** A budget that keeps its last charge, for `sliced`. */
class WatchedBudget extends Budget {
  last = 0;

  spend(c: number): boolean {
    this.last = c;
    return super.spend(c);
  }
}

/**
 * A job run to its end with its deadline already past at every call, and
 * the most work one call charged before the charge it stopped at. That
 * stays under CHECK while every loop stops when told, however long it
 * runs: for the tests of loops that random scenes never make long enough
 * to show a missing stop.
 */
function sliced<T>(job: (budget: Budget) => VolumeJob<T>): { value: T; carried: number } {
  const budget = new WatchedBudget();
  budget.deadline = -Infinity;
  const run = job(budget);
  let carried = 0;
  for (;;) {
    const before = budget.total;
    const step = run.next();
    carried = Math.max(carried, budget.total - before - (step.done ? 0 : budget.last));
    if (step.done) return { value: step.value, carried };
  }
}

/** A store of these points, each its index's vertex. */
function storeOf(points: readonly (readonly [number, number, number])[]): Store {
  const st = new Store();
  for (const [x, y, z] of points) st.add(x, y, z);
  return st;
}

/**
 * The loops one vertical plane's open edges close into, by the walk the
 * caps take: for the tests of the corner pairing and the turn at a pinch,
 * which random scenes seldom reach. Points are `[x, y, z]` in cells and
 * edges `[from, to]` by point index, all on the side `out` of the plane.
 * `carried` is `sliced`'s, the walk run in slices.
 */
export function capLoops(points: readonly (readonly [number, number, number])[], edges: readonly (readonly [number, number])[], plane: { a: number; b: number; e: number }, out = 1): { loops: number[][]; carried: number } {
  const st = storeOf(points);
  const pl: VolumePlane = { id: 0, a: plane.a, b: plane.b, c: 0, e: plane.e, snap: 0 };
  const { value, carried } = sliced((budget) => loopsOnLine(st, pl, edges.map(([from, to]) => ({ from, to, out })), budget));
  return { loops: value.loops.map((l) => l.v), carried };
}

/** The triangles a cap loop on a vertical plane is cut into, as a hex stack's caps are, by point index, and `sliced`'s `carried`. */
export function capTriangles(points: readonly (readonly [number, number, number])[], plane: { a: number; b: number; e: number }, out = 1): { triangles: number[][]; carried: number } {
  const st = storeOf(points);
  const pl: VolumePlane = { id: 0, a: plane.a, b: plane.b, c: 0, e: plane.e, snap: 0 };
  const { value, carried } = sliced((budget) => earClip(st, pl, points.map((_, i) => i), out, budget));
  return { triangles: value, carried };
}

/**
 * The clip lines a face reads, each `[ax, ay, bx, by]` through two plan
 * points, filed over `region`, by their index in order, and `sliced`'s
 * `carried`. The face is a plan polygon.
 */
export function linesNear(lines: readonly (readonly [number, number, number, number])[], face: readonly (readonly [number, number])[], region: { x0: number; y0: number; x1: number; y1: number }): { lines: number[]; carried: number } {
  const planes = lines.map(([ax, ay, bx, by], i) => lineThrough(i, ax, ay, bx, by)!);
  const index = new LineIndex(planes, region);
  for (let li = 0; li < planes.length; li++) index.file(li);
  const st = storeOf(face.map(([x, y]) => [x, y, 0]));
  const poly: VolumePoly = { v: face.map((_, i) => i), nx: 0, ny: 0, nz: 1, cap: false };
  const out = new NearLines();
  const { carried } = sliced((budget) => index.near(st, poly, budget, out));
  return { lines: [...out.pool.subarray(0, out.size)], carried };
}
