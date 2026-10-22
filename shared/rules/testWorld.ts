import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type EdgeFeature, type FreeWall, type Scene, type StairMark, type TerrainId, type WallFeature } from "../model.ts";
import type { BuildState } from "../ruleHooks.ts";
import { encodeHeights } from "./heights.ts";
import { ownWalk, type MovingToken, type Walker } from "./movement.ts";

/**
 * Small built scenes for the route and walk tests, split into stored chunks
 * as the reducer stores them. Not a test file itself: node --test runs only
 * `*.test.ts`.
 */

export type WorldSpec = {
  w?: number;
  h?: number;
  autoWalls?: AutoWalls;
  blockMovement?: boolean;
  cells?: Record<string, TerrainId>;
  edges?: Record<string, EdgeFeature>;
  walls?: FreeWall[];
  heights?: Record<string, number>;
  marks?: Record<string, StairMark>;
  /** Cells marked Difficult ground. */
  rough?: readonly string[];
};

let sceneSerial = 0;

export function world(spec: WorldSpec): BuildState & { sceneId: string } {
  const sceneId = `walk-${sceneSerial++}`;
  const chunks: Record<string, BuildChunk> = {};
  const feet = new Map<string, number[]>();
  const ups = new Map<string, string[]>();
  const roughs = new Map<string, string[]>();
  const at = (x: number, y: number) => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const key = `${sceneId}:${cx},${cy}`;
    return { key, chunk: (chunks[key] ??= { sceneId, cx, cy, rev: 1, cells: {}, edges: {} }), k: (y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS) };
  };
  const split = (key: string) => key.split(",").map(Number) as [number, number];
  for (const [key, t] of Object.entries(spec.cells ?? {})) at(...split(key)).chunk.cells[key] = t;
  for (const [key, f] of Object.entries(spec.edges ?? {})) {
    const [x, y] = split(key);
    at(Math.min(x, (spec.w ?? 30) - 1), Math.min(y, (spec.h ?? 30) - 1)).chunk.edges[key] = f;
  }
  for (const wall of spec.walls ?? []) (at(Math.floor((wall.a[0] + wall.b[0]) / 2), Math.floor((wall.a[1] + wall.b[1]) / 2)).chunk.walls ??= []).push(wall);
  for (const [key, v] of Object.entries(spec.heights ?? {})) {
    const c = at(...split(key));
    if (!feet.has(c.key)) feet.set(c.key, new Array(256).fill(0));
    feet.get(c.key)![c.k] = v;
  }
  for (const [key, m] of Object.entries(spec.marks ?? {})) {
    const c = at(...split(key));
    if (!ups.has(c.key)) ups.set(c.key, new Array(256).fill("."));
    ups.get(c.key)![c.k] = m;
  }
  for (const key of spec.rough ?? []) {
    const c = at(...split(key));
    if (!roughs.has(c.key)) roughs.set(c.key, new Array(256).fill("."));
    roughs.get(c.key)![c.k] = "d";
  }
  for (const [key, f] of feet) chunks[key]!.heights = encodeHeights(f);
  for (const [key, u] of ups) chunks[key]!.up = u.join("");
  for (const [key, r] of roughs) (chunks[key] as BuildChunk & { rough?: string }).rough = r.join("");
  const scene = { id: sceneId, bounds: { w: spec.w ?? 30, h: spec.h ?? 30 }, autoWalls: spec.autoWalls ?? "off", blockMovement: spec.blockMovement ?? true } as Scene;
  return { sceneId, scenes: { [sceneId]: scene }, buildChunks: chunks };
}

/** A token on the test world's scene, walking as itself (movement.ts ownWalk). */
export function tok(state: { sceneId: string }, over: Partial<MovingToken> = {}): Walker {
  return ownWalk({ sceneId: state.sceneId, size: "medium", x: 0, y: 0, elevation: 0, ...over });
}

/** Edge walls along a line of cells: "n" edges from (x0, y) to (x1, y), or "w" edges from (x, y0) to (x, y1). */
export function line(side: "n" | "w", fixed: number, from: number, to: number, feature: WallFeature = { kind: "wall" }): Record<string, EdgeFeature> {
  const out: Record<string, EdgeFeature> = {};
  for (let v = from; v < to; v++) out[side === "n" ? `${v},${fixed},n` : `${fixed},${v},w`] = feature;
  return out;
}

export function free(id: string, ax: number, ay: number, bx: number, by: number, f: FreeWall["f"] = { kind: "wall" }): FreeWall {
  return { id, a: [ax, ay], b: [bx, by], f };
}

export const OPEN_DOOR: WallFeature = { kind: "door", state: "open", secret: false, discovered: false };
export const CLOSED_DOOR: WallFeature = { kind: "door", state: "closed", secret: false, discovered: false };
export const SECRET_DOOR: WallFeature = { kind: "door", state: "open", secret: true, discovered: false };
