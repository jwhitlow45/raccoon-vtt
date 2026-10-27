import { chunkKey, holderChunkKey, holderTileKey, tileKey, wallChunk } from "./keys.ts";
import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type EdgeFeature, type FreeWall, type MemoryChunk, type MemoryEntries, type PlayerChunk, type RoomState, type Scene, type TerrainId, type Viewer, type WallFeature } from "./model.ts";
import { projectState } from "./project.ts";
import { decodeTile, encodeTile, TILE_BYTES, TILE_SUB } from "./rules/fog.ts";
import { sceneGrid } from "./rules/grid.ts";
import { hexSubcells, parseHexKey, type HexGrid } from "./rules/hex.ts";
import { perPlayerOp, perPlayerState } from "./perPlayerTestutil.ts";
import type { Op } from "./protocol.ts";
import { chance, int, pick, room, scene } from "./testutil.ts";

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
  const subs: [number, number][] = [];
  for (let sy = r.y * FOG_SUBCELLS; sy < (r.y + r.h) * FOG_SUBCELLS; sy++) for (let sx = r.x * FOG_SUBCELLS; sx < (r.x + r.w) * FOG_SUBCELLS; sx++) subs.push([sx, sy]);
  liftSubs(state, layer, subs, sceneId, on);
}

/** Reveals the whole of a hex scene in one layer but the sub-cells of the hexes named, `"col,row"`, which stay under fog. */
export function liftAllBut(state: RoomState, layer: Layer, hidden: readonly string[], sceneId = "s1"): void {
  const scene = state.scenes[sceneId]!;
  const grid = sceneGrid(scene) as HexGrid;
  const out = new Set(hidden.flatMap((key) => hexSubcells(grid, parseHexKey(key)!).map(([sx, sy]) => `${sx},${sy}`)));
  const subs: [number, number][] = [];
  for (let sy = 0; sy < scene.bounds.h * FOG_SUBCELLS; sy++) for (let sx = 0; sx < scene.bounds.w * FOG_SUBCELLS; sx++) if (!out.has(`${sx},${sy}`)) subs.push([sx, sy]);
  liftSubs(state, layer, subs, sceneId);
}

/** Sets the bits of one layer at fog sub-cells, by their scene-wide raster index, as a hex's are (hex.ts hexSubcells). */
export function liftSubs(state: RoomState, layer: Layer, subs: readonly (readonly [number, number])[], sceneId = "s1", on = true): void {
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
  for (const [sx, sy] of subs) {
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

// ---------------------------------------------------------------------------
// Random rooms and ops for the property tests (shared/discovery.random.test.ts, server/rooms/fanout.discovery.test.ts)

export const TERRAINS: TerrainId[] = ["stone", "wood", "grass"];

/** A random build on a scene: rooms on and across chunk borders, their walls and doors, free walls, heights, stairs and rough ground. */
export function randomBuild(r: () => number, state: RoomState, sceneId: string): void {
  const scene = state.scenes[sceneId]!;
  const { w, h } = scene.bounds;
  if (chance(r, 0.5)) scene.autoWalls = pick(r, ["floor", "off"] as const);
  const at = (s: RoomState) => s;
  for (let i = 0; i < int(r, 2, 6); i++) {
    // Rooms often straddle the chunk line at 16, so a stub or a neighbor holds their far wall.
    const x = chance(r, 0.5) ? CHUNK_CELLS - int(r, 1, 4) : int(r, 0, w - 4);
    const y = chance(r, 0.5) ? CHUNK_CELLS - int(r, 1, 4) : int(r, 0, h - 4);
    const rw = Math.min(int(r, 2, 7), w - x);
    const rh = Math.min(int(r, 2, 7), h - y);
    paintIn(at(state), sceneId, { x, y, w: rw, h: rh }, pick(r, TERRAINS));
    for (let k = x; k < x + rw; k++) {
      edgeIn(state, sceneId, `${k},${y},n`, randomFeature(r));
      if (y + rh < h) edgeIn(state, sceneId, `${k},${y + rh},n`, randomFeature(r));
    }
    for (let k = y; k < y + rh; k++) {
      edgeIn(state, sceneId, `${x},${k},w`, randomFeature(r));
      if (x + rw < w) edgeIn(state, sceneId, `${x + rw},${k},w`, randomFeature(r));
    }
  }
  for (let i = 0; i < int(r, 1, 8); i++) {
    const ax = int(r, 0, (w - 1) * 64) / 64;
    const ay = int(r, 0, (h - 1) * 64) / 64;
    const len = int(r, 32, 7 * 64) / 64;
    const angle = r() * 2 * Math.PI;
    const bx = Math.min(w, Math.max(0, Math.round((ax + len * Math.cos(angle)) * 64) / 64));
    const by = Math.min(h, Math.max(0, Math.round((ay + len * Math.sin(angle)) * 64) / 64));
    if (bx === ax && by === ay) continue;
    wall(state, `w${i}${int(r, 0, 1e6)}`.padEnd(12, "x").slice(0, 12), [ax, ay], [bx, by], randomWallFeature(r), sceneId);
  }
  if (sceneId === "s1") {
    for (let i = 0; i < int(r, 0, 3); i++) heights(state, { x: int(r, 0, w - 3), y: int(r, 0, h - 3), w: int(r, 1, 3), h: int(r, 1, 3) }, pick(r, [5, 10, -5]));
    if (chance(r, 0.5)) {
      const x = int(r, 1, w - 6);
      const y = int(r, 1, h - 2);
      stairs(state, [0, 1, 2, 3].map((k): [number, number] => [x + k, y]), "a");
    }
  }
}

export function randomFeature(r: () => number): BuildChunk["edges"][string] {
  const roll = r();
  if (roll < 0.6) return { kind: "wall" };
  if (roll < 0.85) return { kind: "door", state: pick(r, ["open", "closed", "locked"] as const), secret: chance(r, 0.3), discovered: chance(r, 0.5) };
  return { kind: "window" };
}

export function randomWallFeature(r: () => number): WallFeature {
  return randomFeature(r) as WallFeature;
}

/* The fixtures write scene s1 by default: these take the scene. */
function paintIn(state: RoomState, sceneId: string, rect: { x: number; y: number; w: number; h: number }, terrain: TerrainId): void {
  if (sceneId === "s1") paint(state, rect, terrain);
  else for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) chunkOf(state, sceneId, x, y).cells[`${x},${y}`] = terrain;
}

function edgeIn(state: RoomState, sceneId: string, key: string, feature: BuildChunk["edges"][string]): void {
  if (sceneId === "s1") return edge(state, key, feature);
  const [x, y] = key.split(",").map(Number) as [number, number];
  chunkOf(state, sceneId, x, y).edges[key] = feature;
}

export function chunkOf(state: RoomState, sceneId: string, x: number, y: number): BuildChunk {
  const cx = Math.floor(x / CHUNK_CELLS);
  const cy = Math.floor(y / CHUNK_CELLS);
  const key = `${sceneId}:${cx},${cy}`;
  const old = state.buildChunks[key];
  const chunk: BuildChunk = old ? { ...old, cells: { ...old.cells }, edges: { ...old.edges } } : { sceneId, cx, cy, rev: 1, cells: {}, edges: {} };
  state.buildChunks = { ...state.buildChunks, [key]: chunk };
  return chunk;
}

/** A random room for map discovery: perPlayerState's, its scenes per player or whole party, fog on most often, walls stopping moves, and a build. */
export function discoveryState(r: () => number): RoomState {
  const state = perPlayerState(r);
  for (const scene of Object.values(state.scenes)) {
    scene.fogEnabled = chance(r, 0.8);
    scene.blockMovement = chance(r, 0.7);
    if (scene.vision && chance(r, 0.4)) scene.vision = { on: scene.vision.on, light: scene.vision.light };
    else if (!scene.vision && chance(r, 0.6)) scene.vision = { on: true, light: pick(r, ["bright", "dim", "dark"] as const) };
    randomBuild(r, state, scene.id);
  }
  // Ground the DM revealed and the party explored, beside what perPlayerState left.
  for (let i = 0; i < int(r, 0, 3); i++) lift(state, pick(r, ["dm", "party"] as const), { x: int(r, 0, 28), y: int(r, 0, 28), w: int(r, 1, 8), h: int(r, 1, 8) });
  return state;
}

/**
 * A random op: perPlayerOp's, or by the DM a build edit on and across the
 * chunk lines at 16, in sight or out of it: free walls whose held pieces
 * are filed in a neighbor's position, border edges and cells, heights, and
 * labels moved.
 */
export function discoveryOp(r: () => number, state: RoomState, who: Viewer): Op {
  if (who.role !== "dm" || chance(r, 0.6)) return perPlayerOp(r, state, who);
  const sceneId = pick(r, ["s1", "s1", "s2"]);
  const scene = state.scenes[sceneId];
  if (!scene) return perPlayerOp(r, state, who);
  const near = (n: number) => Math.min(n - 1, Math.max(0, CHUNK_CELLS + int(r, -3, 3)));
  switch (int(r, 0, 5)) {
    case 0:
    case 1: {
      // Across a chunk line, its midpoint on either side.
      const vertical = chance(r, 0.5);
      const at = int(r, 1, Math.min(scene.bounds.w, scene.bounds.h) - 2);
      const a = CHUNK_CELLS * 64 - int(r, 8, 200);
      const b = CHUNK_CELLS * 64 + int(r, 8, 200);
      const off = int(r, -40, 40);
      const p = (u: number, v: number): [number, number] => (vertical ? [Math.min(scene.bounds.w, u / 64), Math.min(scene.bounds.h, v)] : [Math.min(scene.bounds.w, v), Math.min(scene.bounds.h, u / 64)]);
      const w: FreeWall = { id: `cw${int(r, 0, 1e6)}`.padEnd(12, "c").slice(0, 12), a: p(a, at + 0.25), b: p(b, at + 0.25 + off / 64), f: randomWallFeature(r) };
      const existing = Object.values(state.buildChunks).flatMap((c) => (c.sceneId === sceneId ? (c.walls ?? []).map((x) => ({ cx: c.cx, cy: c.cy, id: x.id })) : []));
      return chance(r, 0.25) && existing.length > 0 ? { t: "build.walls", sceneId, remove: [pick(r, existing)] } : { t: "build.walls", sceneId, put: [w] };
    }
    case 2:
      return { t: "build.edge", sceneId, edges: [{ key: `${near(scene.bounds.w)},${int(r, 0, scene.bounds.h - 1)},${pick(r, ["n", "w"])}`, feature: chance(r, 0.2) ? null : randomFeature(r) }] };
    case 3:
      return { t: "build.paint", sceneId, terrain: pick(r, TERRAINS), cells: [`${near(scene.bounds.w)},${near(scene.bounds.h)}`, `${int(r, 0, scene.bounds.w - 1)},${int(r, 0, scene.bounds.h - 1)}`] };
    case 4:
      return { t: "build.height", sceneId, cells: [`${near(scene.bounds.w)},${int(r, 0, scene.bounds.h - 1)}`], height: pick(r, [0, 5, 10]) };
    default: {
      const ids = Object.values(state.labels).filter((l) => l.sceneId === sceneId).map((l) => l.id);
      const id = ids.length > 0 && chance(r, 0.7) ? pick(r, ids) : `lb${int(r, 0, 1e6)}`;
      return { t: "build.label", sceneId, labelId: id, label: chance(r, 0.85) ? { x: int(r, 0, scene.bounds.w - 1) + 0.5, y: int(r, 0, scene.bounds.h - 1) + 0.5, text: "Here", size: 1 } : null };
    }
  }
}
