import { wallChunk } from "#shared/keys.ts";
import { LIMITS } from "#shared/limits.ts";
import { CHUNK_CELLS, FREE_WALL_ID_LENGTH, FREE_WALL_LATTICE, type AutoWalls, type BuildChunk, type WallFeature } from "#shared/model.ts";
import { MAX_SCENE_CELLS, type FreeWallInput } from "#shared/protocol.ts";
import { countChunksSplit } from "#shared/rules/walls.ts";
import { count, GRID_SNAP_SQUARES, MERGE_SQUARES, SIMPLIFY_STEPS, WELD_SQUARES } from "./limits.ts";
import { placeLights, type LightPlan, type SightSegment } from "./lights.ts";
import { doorsOf } from "./outlines.ts";
import type { Point, UvttMap, UvttPortal } from "./schema.ts";
import { clipLine, clipSegment, simplifyLine, snap } from "./simplify.ts";
import { cutLong, WallGraph, type LatticeSegment, type SegKind } from "./snap.ts";

/**
 * A checked Universal VTT map turned into what the scene will store
 * (docs/design-v1-maps-vision.md section 3.1 steps 3 to 7): the scene's
 * size and where the image sits in it, edge walls, free walls and lights,
 * and the counts the summary shows. Pure, so the worker runs it and the
 * tests run it on synthetic files.
 */

const L = FREE_WALL_LATTICE;

export type ImportOptions = {
  /** "Objects block sight and movement": whether `objects_line_of_sight` becomes walls. */
  objects: boolean;
  /** What a portal that does not block light becomes (question 8): a window, or an open door. */
  portals: "window" | "open";
  feetPerCell: number;
};

/** The split's counting pass on chunks that would be stored. countChunksSplit (shared/rules/walls.ts) unless a test passes another. */
export type SplitCounter = (chunks: Iterable<BuildChunk>, rule: AutoWalls) => { pairs: number; pieces: number; over: "pairs" | "pieces" | null };

/**
 * Where the file's squares land in the scene. World 0 is the grid line at
 * or before the image's start on each axis (`floor` of the origin), so
 * nothing inside the image is below 0 and the image starts at `image`,
 * never negative. The scene covers the image from 0 to `ceil(image +
 * size)`, the leading partial square included.
 */
export type Frame = { shift: Point; image: Point; w: number; h: number };

export type FrameResult = { ok: true; frame: Frame } | { ok: false; error: string };

/** Part of a square lost to rounding in `origin - floor(origin) + size` must not add a whole column. */
const ROUNDING = 1e-9;

export function frameOf(map: Pick<UvttMap, "origin" | "size">): FrameResult {
  const shift = { x: Math.floor(map.origin.x), y: Math.floor(map.origin.y) };
  const image = { x: map.origin.x - shift.x, y: map.origin.y - shift.y };
  const w = Math.max(1, Math.ceil(image.x + map.size.x - ROUNDING));
  const h = Math.max(1, Math.ceil(image.y + map.size.y - ROUNDING));
  if (w > MAX_SCENE_CELLS) return { ok: false, error: `This map is ${count(w)} squares wide. Scenes can be at most ${MAX_SCENE_CELLS}.` };
  if (h > MAX_SCENE_CELLS) return { ok: false, error: `This map is ${count(h)} squares tall. Scenes can be at most ${MAX_SCENE_CELLS}.` };
  return { ok: true, frame: { shift, image, w, h } };
}

export type EdgePut = { key: string; feature: WallFeature };

export type Summary = {
  /** Wall edges on the grid, and free walls, each as stored. */
  gridWalls: number;
  freeWalls: number;
  doors: number;
  windows: number;
  lights: number;
  /** Over the 100 a scene holds, the smallest by range, and those far outside the map. */
  lightsLeftOut: number;
  /** Of `lightsLeftOut`, those the file put far outside its map (schema.ts), so the summary gives each its reason. */
  lightsFarOutside: number;
  lightsMoved: number;
  /** Wall ends joined within a tenth of a square. */
  welded: number;
  /** Walls, doors and lights cut or dropped where they passed the scene's edge. */
  clipped: number;
  /** The Douglas-Peucker tolerance that brought the free walls under the scene's limit, in squares. */
  tolerance: number;
};

export type ImportPlan = {
  frame: Frame;
  pixelsPerGrid: number;
  edges: EdgePut[];
  walls: FreeWallInput[];
  lights: LightPlan[];
  summary: Summary;
};

export type ConvertResult = { ok: true; plan: ImportPlan } | { ok: false; error: string };

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A free wall's id: random characters that say nothing about the wall (section 2.2). */
export function randomWallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(FREE_WALL_ID_LENGTH));
  let id = "";
  // 64 characters, so the low six bits of a byte pick one evenly.
  for (const b of bytes) id += ID_CHARS[b & 63];
  return id;
}

export function featureOf(kind: SegKind): WallFeature {
  if (kind === "wall") return { kind: "wall" };
  if (kind === "window") return { kind: "window" };
  return { kind: "door", state: kind === "open" ? "open" : "closed", secret: false, discovered: false };
}

const RANK: Record<WallFeature["kind"], number> = { wall: 0, window: 1, door: 2 };

/** The cell edges a grid segment covers, one key per edge, `x,y,n` along a row and `x,y,w` down a column. */
export function edgeKeys(seg: LatticeSegment): string[] {
  const keys: string[] = [];
  if (seg.ay === seg.by) {
    const y = seg.ay / L;
    for (let x = Math.min(seg.ax, seg.bx) / L; x < Math.max(seg.ax, seg.bx) / L; x++) keys.push(`${x},${y},n`);
  } else {
    const x = seg.ax / L;
    for (let y = Math.min(seg.ay, seg.by) / L; y < Math.max(seg.ay, seg.by) / L; y++) keys.push(`${x},${y},w`);
  }
  return keys;
}

function lattice(p: Point): [number, number] {
  return [Math.round(p.x * L), Math.round(p.y * L)];
}

type Walls = { edges: Map<string, WallFeature>; free: { a: [number, number]; b: [number, number]; f: WallFeature }[]; welded: number; clipped: number };

function buildWalls(map: UvttMap, portals: readonly UvttPortal[], frame: Frame, options: ImportOptions, tolerance: number): Walls {
  const graph = new WallGraph();
  const world = (p: Point): Point => ({ x: p.x - frame.shift.x, y: p.y - frame.shift.y });
  let clipped = 0;
  const lines = options.objects ? [...map.walls, ...map.objects] : map.walls;
  for (const line of lines) {
    const cut = clipLine(line.map(world), frame.w, frame.h);
    if (cut.clipped) clipped++;
    for (const part of cut.parts) {
      const points = simplifyLine(part, tolerance, MERGE_SQUARES);
      for (let i = 0; i + 1 < points.length; i++) {
        const [ax, ay] = lattice(points[i]!);
        const [bx, by] = lattice(points[i + 1]!);
        graph.add(ax, ay, bx, by, "wall", false);
      }
    }
  }
  for (const portal of portals) {
    const seg = clipSegment(world(portal.a), world(portal.b), frame.w, frame.h);
    if (!seg || seg[2] || seg[3]) clipped++;
    if (!seg) continue;
    const [ax, ay] = lattice({ x: snap(seg[0].x), y: snap(seg[0].y) });
    const [bx, by] = lattice({ x: snap(seg[1].x), y: snap(seg[1].y) });
    graph.add(ax, ay, bx, by, portal.closed ? "door" : options.portals, true);
  }
  graph.pinGrid(GRID_SNAP_SQUARES * L);
  graph.cutAtPortals(WELD_SQUARES * L);
  graph.weld(WELD_SQUARES * L);

  const edges = new Map<string, WallFeature>();
  const free: Walls["free"] = [];
  for (const seg of graph.result()) {
    const f = featureOf(seg.kind);
    if (graph.gridAt(seg)) {
      for (const key of edgeKeys(seg)) {
        const prev = edges.get(key);
        if (!prev || RANK[prev.kind] < RANK[f.kind]) edges.set(key, f);
      }
      continue;
    }
    for (const [ax, ay, bx, by] of cutLong(seg.ax, seg.ay, seg.bx, seg.by)) free.push({ a: [ax / L, ay / L], b: [bx / L, by / L], f });
  }
  return { edges, free, welded: graph.welded, clipped };
}

/** The segments that stop light from a torch: walls and closed doors, not windows or open doors. */
function sightSegments(walls: Walls): SightSegment[] {
  const blocks = (f: WallFeature) => f.kind === "wall" || (f.kind === "door" && f.state !== "open");
  const out: SightSegment[] = [];
  for (const [key, f] of walls.edges) {
    if (!blocks(f)) continue;
    const [xs, ys, side] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    out.push(side === "n" ? { a: { x, y }, b: { x: x + 1, y } } : { a: { x, y }, b: { x, y: y + 1 } });
  }
  for (const w of walls.free) if (blocks(w.f)) out.push({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] } });
  return out;
}

/**
 * The chunks the import would store, placed as the reducer places them:
 * an edge in the chunk of its cell, a free wall in the chunk of its
 * midpoint (shared/reducer/map.ts). The split's counting pass reads these.
 */
export function chunksOf(sceneId: string, edges: readonly EdgePut[], walls: readonly FreeWallInput[]): BuildChunk[] {
  const chunks = new Map<string, BuildChunk>();
  const at = (cx: number, cy: number) => {
    const key = `${cx},${cy}`;
    let chunk = chunks.get(key);
    if (!chunk) chunks.set(key, (chunk = { sceneId, cx, cy, rev: 0, cells: {}, edges: {} }));
    return chunk;
  };
  for (const e of edges) {
    const [xs, ys] = e.key.split(",");
    at(Math.floor(Number(xs) / CHUNK_CELLS), Math.floor(Number(ys) / CHUNK_CELLS)).edges[e.key] = e.feature;
  }
  for (const w of walls) {
    const { cx, cy } = wallChunk(w);
    const chunk = at(cx, cy);
    (chunk.walls ??= []).push({ id: w.id, a: [w.a[0], w.a[1]], b: [w.b[0], w.b[1]], f: w.f });
  }
  return [...chunks.values()];
}

/** Why the split's counting pass refuses the walls, in the DM's words. */
export function splitProblem(over: "pairs" | "pieces"): string {
  return over === "pairs"
    ? `This map's walls cross and meet too often for one scene: more than ${count(LIMITS.splitPairsPerScene)} pairs of walls to check.`
    : `This map's walls cross too often for one scene: they would split into more than ${count(LIMITS.splitPiecesPerScene)} extra pieces.`;
}

/**
 * The whole conversion. Free walls over the scene's limit are simplified
 * again at a coarser tolerance, twice at most. Past that, or over the
 * split's caps or the caps on grid edges and on doors and windows, the
 * import is refused with the counts.
 */
export function convertUvtt(map: UvttMap, options: ImportOptions, deps: { newWallId?: () => string; countSplit?: SplitCounter } = {}): ConvertResult {
  const framed = frameOf(map);
  if (!framed.ok) return framed;
  const { frame } = framed;
  const portals = doorsOf(map.portals);
  let walls: Walls | null = null;
  let tolerance: number = SIMPLIFY_STEPS[0];
  for (const step of SIMPLIFY_STEPS) {
    tolerance = step;
    walls = buildWalls(map, portals, frame, options, step);
    if (walls.free.length <= LIMITS.freeWallsPerScene) break;
  }
  if (!walls) return { ok: false, error: "This file has no map." };
  if (walls.free.length > LIMITS.freeWallsPerScene) {
    return {
      ok: false,
      error: `This map has ${count(walls.free.length)} walls off the grid even simplified, more than a scene holds (${count(LIMITS.freeWallsPerScene)}).`,
    };
  }

  const newId = deps.newWallId ?? randomWallId;
  const used = new Set<string>();
  const freeWalls: FreeWallInput[] = walls.free.map((w) => {
    let id = newId();
    while (used.has(id)) id = newId();
    used.add(id);
    return { id, a: w.a, b: w.b, f: w.f };
  });
  const edges: EdgePut[] = [...walls.edges].map(([key, feature]) => ({ key, feature })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // The limits step counts every grid edge the import stores, a portal along a grid line making one per cell. Checked before sending, as the caps below are.
  if (edges.length > LIMITS.drawnEdgesPerScene) {
    return { ok: false, error: `This map has ${count(edges.length)} walls, doors and windows on the grid, more than a scene holds (${count(LIMITS.drawnEdgesPerScene)}).` };
  }
  // The server runs the same pass on every op, so an import over a cap would fail partway. Checked here, before anything is sent.
  const split = (deps.countSplit ?? countChunksSplit)(chunksOf("import", edges, freeWalls), "off");
  if (split.over) return { ok: false, error: splitProblem(split.over) };

  const world = map.lights.map((l) => ({ ...l, at: { x: l.at.x - frame.shift.x, y: l.at.y - frame.shift.y } }));
  const placed = placeLights(world, sightSegments(walls), { w: frame.w, h: frame.h }, options.feetPerCell);

  let gridWalls = 0;
  let doors = 0;
  let windows = 0;
  let freeCount = 0;
  const tally = (f: WallFeature, grid: boolean) => {
    if (f.kind === "door") doors++;
    else if (f.kind === "window") windows++;
    else if (grid) gridWalls++;
    else freeCount++;
  };
  for (const e of edges) tally(e.feature, true);
  for (const w of freeWalls) tally(w.f, false);
  // The limits step counts doors and windows the same way, so a map over the cap is refused here rather than partway through sending.
  if (doors + windows > LIMITS.doorsAndWindowsPerScene) {
    return { ok: false, error: `This map has ${count(doors + windows)} doors and windows, more than a scene holds (${count(LIMITS.doorsAndWindowsPerScene)}).` };
  }

  return {
    ok: true,
    plan: {
      frame,
      pixelsPerGrid: map.pixelsPerGrid,
      edges,
      walls: freeWalls,
      lights: placed.lights,
      summary: {
        gridWalls,
        freeWalls: freeCount,
        doors,
        windows,
        lights: placed.lights.length,
        lightsLeftOut: placed.leftOut + map.lightsFarOutside,
        lightsFarOutside: map.lightsFarOutside,
        lightsMoved: placed.moved,
        welded: walls.welded,
        clipped: walls.clipped + placed.outside,
        tolerance,
      },
    },
  };
}
