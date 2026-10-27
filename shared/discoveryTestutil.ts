import { chunkKey, holderChunkKey, holderTileKey, tileKey, wallChunk } from "./keys.ts";
import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type EdgeFeature, type FreeWall, type MemoryChunk, type MemoryEntries, type PlayerChunk, type RoomState, type Scene, type TerrainId, type Viewer, type WallFeature } from "./model.ts";
import { projectState } from "./project.ts";
import { decodeTile, encodeTile, TILE_BYTES, TILE_SUB } from "./rules/fog.ts";
import { room, scene } from "./testutil.ts";

/**
 * Fixtures for the map discovery tests (docs/design-v1-map-discovery.md):
 * rooms whose build, fog layers and memory are written straight into the
 * state, so a test sets up exactly the ground each case names. Nothing
 * here runs in the app.
 */

/** A room whose scene s1 has fog on, and party vision when asked. */
export function fogRoom(opts: { vision?: boolean; perPlayer?: boolean; bounds?: { w: number; h: number }; scene?: Partial<Scene> } = {}): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", {
    fogEnabled: true,
    bounds: opts.bounds ?? { w: 48, h: 32 },
    ...(opts.vision ? { vision: { on: true, light: "bright", ...(opts.perPlayer ? { perPlayer: true } : {}) } } : {}),
    ...opts.scene,
  });
  return state;
}

/**
 * A fresh copy of the chunk holding a cell, put in its place to be changed:
 * the projection keeps players' chunks by the objects it read, which the
 * reducer replaces and never changes, so a fixture does the same.
 */
function chunkAt(state: RoomState, x: number, y: number, sceneId = "s1"): BuildChunk {
  return chunkIn(state, sceneId, Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS));
}

function chunkIn(state: RoomState, sceneId: string, cx: number, cy: number): BuildChunk {
  const key = chunkKey(sceneId, cx, cy);
  const old = state.buildChunks[key];
  const chunk: BuildChunk = old ? { ...old, cells: { ...old.cells }, edges: { ...old.edges }, ...(old.walls ? { walls: [...old.walls] } : {}) } : { sceneId, cx, cy, rev: 1, cells: {}, edges: {} };
  // The collection too, which the rules group their chunks by.
  state.buildChunks = { ...state.buildChunks, [key]: chunk };
  return chunk;
}

/** Paints a rectangle of cells. */
export function paint(state: RoomState, r: { x: number; y: number; w: number; h: number }, terrain: TerrainId = "stone"): void {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) chunkAt(state, x, y).cells[`${x},${y}`] = terrain;
}

/** Draws an edge feature, `"x,y,n"` or `"x,y,w"`. */
export function edge(state: RoomState, key: string, feature: EdgeFeature): void {
  const [x, y] = key.split(",").map(Number) as [number, number];
  chunkAt(state, x, y).edges[key] = feature;
}

/** Stores a free wall in its midpoint's chunk, as the reducer files it. */
export function wall(state: RoomState, id: string, a: [number, number], b: [number, number], f: WallFeature = { kind: "wall" }, sceneId = "s1"): FreeWall {
  const w: FreeWall = { id, a, b, f };
  const { cx, cy } = wallChunk(w);
  const chunk = chunkIn(state, sceneId, cx, cy);
  chunk.walls = [...(chunk.walls ?? []).filter((o) => o.id !== id), w];
  return w;
}

/** Sets cells' heights, writing each chunk's `heights` field. */
export function heights(state: RoomState, r: { x: number; y: number; w: number; h: number }, feet: number): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const chunk = chunkAt(state, x, y);
      const bytes = chunk.heights ? new Uint8Array(Buffer.from(chunk.heights, "base64")) : new Uint8Array(512);
      const k = (y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS);
      const u = feet < 0 ? feet + 65536 : feet;
      bytes[2 * k] = u % 256;
      bytes[2 * k + 1] = Math.floor(u / 256);
      chunk.heights = Buffer.from(bytes).toString("base64");
    }
  }
}

/** Sets cells' stair marks. */
export function stairs(state: RoomState, cells: readonly [number, number][], mark: string): void {
  for (const [x, y] of cells) {
    const chunk = chunkAt(state, x, y);
    const marks = (chunk.up ?? ".".repeat(256)).split("");
    marks[(y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS)] = mark;
    chunk.up = marks.join("");
  }
}

type Layer = "dm" | "party" | { holder: string };

/** Sets the bits of one layer over a rectangle of cells: the DM's fog, the party's explored layer or a holder's. */
export function lift(state: RoomState, layer: Layer, r: { x: number; y: number; w: number; h: number }, sceneId = "s1", on = true): void {
  const get = (tx: number, ty: number) => {
    if (layer === "dm") return state.fogTiles[tileKey(sceneId, tx, ty)];
    if (layer === "party") return state.exploredTiles[tileKey(sceneId, tx, ty)];
    return state.exploredBy![holderTileKey(sceneId, layer.holder, tx, ty)];
  };
  // New tile objects in new collections, as the reducer writes them.
  const put = (tx: number, ty: number, bits: Uint8Array) => {
    const tile = { sceneId, tx, ty, rev: 1, bits: encodeTile(bits) };
    if (layer === "dm") state.fogTiles = { ...state.fogTiles, [tileKey(sceneId, tx, ty)]: tile };
    else if (layer === "party") state.exploredTiles = { ...state.exploredTiles, [tileKey(sceneId, tx, ty)]: tile };
    else state.exploredBy = { ...state.exploredBy, [holderTileKey(sceneId, layer.holder, tx, ty)]: { ...tile, memberId: layer.holder } };
  };
  const tiles = new Map<string, Uint8Array>();
  for (let sy = r.y * FOG_SUBCELLS; sy < (r.y + r.h) * FOG_SUBCELLS; sy++) {
    for (let sx = r.x * FOG_SUBCELLS; sx < (r.x + r.w) * FOG_SUBCELLS; sx++) {
      const tx = Math.floor(sx / TILE_SUB);
      const ty = Math.floor(sy / TILE_SUB);
      const at = `${tx},${ty}`;
      let bits = tiles.get(at);
      if (!bits) {
        const t = get(tx, ty);
        tiles.set(at, (bits = (t && decodeTile(t.bits)) || new Uint8Array(TILE_BYTES)));
      }
      const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
      if (on) bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      else bits[i >> 3] = bits[i >> 3]! & ~(1 << (i & 7));
    }
  }
  for (const [at, bits] of tiles) {
    const [tx, ty] = at.split(",").map(Number) as [number, number];
    put(tx, ty, bits);
  }
}

/** Writes one layer's memory entries at a chunk position, merged into what it holds. */
export function remember(state: RoomState, layer: string | null, cx: number, cy: number, entries: MemoryEntries, sceneId = "s1"): void {
  const key = layer === null ? chunkKey(sceneId, cx, cy) : holderChunkKey(sceneId, layer, cx, cy);
  const all = (layer === null ? state.memory : state.memoryBy) ?? {};
  const held: MemoryChunk = all[key] ?? { sceneId, cx, cy, rev: 0, ...(layer === null ? {} : { memberId: layer }) };
  const out: MemoryChunk = { ...held };
  for (const [field, record] of Object.entries(entries)) (out as Record<string, unknown>)[field] = { ...((held as Record<string, unknown>)[field] as object | undefined), ...record };
  if (layer === null) state.memory = { ...all, [key]: out };
  else state.memoryBy = { ...all, [key]: out };
}

/** A player's chunks of the scene they are on, by `"cx,cy"`. */
export function chunksOf(state: RoomState, viewer: Viewer): Record<string, PlayerChunk> {
  const out: Record<string, PlayerChunk> = {};
  for (const chunk of Object.values(projectState(state, viewer, { sceneId: "s1" }).buildChunks)) out[`${chunk.cx},${chunk.cy}`] = chunk as PlayerChunk;
  return out;
}

/** Every free wall a player's chunks carry, with the position it is filed under. */
export function wallsOf(state: RoomState, viewer: Viewer): (FreeWall & { at: string })[] {
  return Object.entries(chunksOf(state, viewer)).flatMap(([at, c]) => (c.walls ?? []).map((w) => ({ ...w, at })));
}

/** A cell's bit in a player's chunk's `known`. */
export function knownAt(chunk: PlayerChunk | undefined, x: number, y: number): boolean {
  if (!chunk?.known) return false;
  const bytes = Buffer.from(chunk.known, "base64");
  const k = (y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS);
  return ((bytes[k >> 3]! >> (k & 7)) & 1) === 1;
}

/** Whether a player's chunk carries an automatic wall on a cell's north or west edge. */
export function autoAt(chunk: PlayerChunk | undefined, key: string): boolean {
  if (!chunk?.auto) return false;
  const [xs, ys, side] = key.split(",");
  const bytes = Buffer.from(chunk.auto, "base64");
  const k = (Number(ys) - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (Number(xs) - chunk.cx * CHUNK_CELLS);
  const bit = 2 * k + (side === "w" ? 1 : 0);
  return ((bytes[bit >> 3]! >> (bit & 7)) & 1) === 1;
}
