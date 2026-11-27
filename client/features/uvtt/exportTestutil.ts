import { wallChunk } from "#shared/keys.ts";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type Light, type TerrainId, type WallFeature } from "#shared/model.ts";
import { convertUvtt, type ImportPlan } from "./convert.ts";
import { readUvtt } from "./schema.ts";
import { STAND_IN } from "./steps.ts";
import type { UvttHead } from "./write.ts";

/**
 * Builds and round trips for the export's tests (write.test.ts,
 * roundtrip.prop.test.ts, roundtrip.test.ts). Only the tests import this.
 */

export type BuildInput = {
  cells?: Record<string, TerrainId>;
  edges?: Record<string, EdgeFeature>;
  walls?: { a: [number, number]; b: [number, number]; f: WallFeature }[];
};

/** A scene's chunks from cells, edges and free walls, each where the reducer stores it. */
export function chunksOf(input: BuildInput, sceneId = "s"): BuildChunk[] {
  const chunks = new Map<string, BuildChunk>();
  const at = (cx: number, cy: number) => {
    const key = `${cx},${cy}`;
    let chunk = chunks.get(key);
    if (!chunk) chunks.set(key, (chunk = { sceneId, cx, cy, rev: 1, cells: {}, edges: {} }));
    return chunk;
  };
  const cellOf = (key: string) => {
    const [x, y] = key.split(",").map(Number);
    return at(Math.floor(x! / CHUNK_CELLS), Math.floor(y! / CHUNK_CELLS));
  };
  for (const [key, terrain] of Object.entries(input.cells ?? {})) cellOf(key).cells[key] = terrain;
  for (const [key, feature] of Object.entries(input.edges ?? {})) cellOf(key).edges[key] = feature;
  (input.walls ?? []).forEach((w, i) => {
    const { cx, cy } = wallChunk(w);
    const wall: FreeWall = { id: `w${String(i).padStart(11, "0")}`, a: w.a, b: w.b, f: w.f };
    (at(cx, cy).walls ??= []).push(wall);
  });
  return [...chunks.values()];
}

export function light(overrides: Partial<Light> = {}): Light {
  return { id: "l1", rev: 1, sceneId: "s", x: 2, y: 2, bright: 20, dim: 20, on: true, walls: true, ...overrides };
}

export const WALL: WallFeature = { kind: "wall" };
export const WINDOW: WallFeature = { kind: "window" };
export function door(overrides: Partial<Extract<WallFeature, { kind: "door" }>> = {}): WallFeature {
  return { kind: "door", state: "closed", secret: false, discovered: false, ...overrides };
}

/** The head as a file, through JSON, read and converted with the import dialog's defaults. */
export function importBack(head: UvttHead, feetPerCell = 5): ImportPlan {
  const text = JSON.stringify({ ...head.json, image: STAND_IN });
  const read = readUvtt(JSON.parse(text));
  if (!read.ok) throw new Error(read.error);
  const converted = convertUvtt(read.map, { objects: true, portals: "window", feetPerCell });
  if (!converted.ok) throw new Error(converted.error);
  return converted.plan;
}
