import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type RoomState, type Token, type WallFeature } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { room, scene, token } from "#shared/testutil.ts";

/**
 * A room for the movement and door tests: one scene, `s1`, 30 by 30 with no
 * automatic walls, built from global cell and edge keys split into chunks
 * the way the reducer stores them. Never imported by production code.
 */
export type Spec = {
  blockMovement?: boolean;
  edges?: Record<string, EdgeFeature>;
  walls?: FreeWall[];
  /** Ground heights in feet by cell key. */
  heights?: Record<string, number>;
  tokens?: Token[];
};

export function world(spec: Spec): RoomState {
  const chunks: Record<string, BuildChunk> = {};
  const feet = new Map<string, number[]>();
  const at = (x: number, y: number) => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const key = `s1:${cx},${cy}`;
    return { key, chunk: (chunks[key] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} }), k: (y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS) };
  };
  const cell = (key: string) => key.split(",").map(Number) as [number, number];
  for (const [key, f] of Object.entries(spec.edges ?? {})) at(...cell(key)).chunk.edges[key] = f;
  for (const wall of spec.walls ?? []) (at(Math.floor((wall.a[0] + wall.b[0]) / 2), Math.floor((wall.a[1] + wall.b[1]) / 2)).chunk.walls ??= []).push(wall);
  for (const [key, v] of Object.entries(spec.heights ?? {})) {
    const c = at(...cell(key));
    if (!feet.has(c.key)) feet.set(c.key, new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0));
    feet.get(c.key)![c.k] = v;
  }
  for (const [key, f] of feet) chunks[key]!.heights = encodeHeights(f);
  return room({
    scenes: { s1: scene("s1", { bounds: { w: 30, h: 30 }, autoWalls: "off", blockMovement: spec.blockMovement ?? true }) },
    buildChunks: chunks,
    tokens: Object.fromEntries((spec.tokens ?? []).map((t) => [t.id, t])),
  });
}

/** Edge walls along a grid line: north edges from (from, fixed) to (to, fixed), or west edges from (fixed, from) to (fixed, to). */
export function line(side: "n" | "w", fixed: number, from: number, to: number, feature: WallFeature = { kind: "wall" }): Record<string, EdgeFeature> {
  const out: Record<string, EdgeFeature> = {};
  for (let v = from; v < to; v++) out[side === "n" ? `${v},${fixed},n` : `${fixed},${v},w`] = feature;
  return out;
}

type Door = Extract<WallFeature, { kind: "door" }>;
export const CLOSED: Door = { kind: "door", state: "closed", secret: false, discovered: false };
export const OPEN: Door = { kind: "door", state: "open", secret: false, discovered: false };

/** Heights over a rectangle of cells, `[x0, x1)` by `[y0, y1)`. */
export function raised(x0: number, y0: number, x1: number, y1: number, feet: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[`${x},${y}`] = feet;
  return out;
}

/** A player's token on s1, owned by p1. */
export function thorn(over: Partial<Token> = {}): Token {
  return token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], disposition: "ally", ...over });
}
