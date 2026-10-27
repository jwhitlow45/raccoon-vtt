import { chunkKey, holderChunkKey } from "#shared/keys.ts";
import { LIMITS, serializedBytes, utf8Bytes } from "#shared/limits.ts";
import { FREE_WALL_ID_LENGTH, type FreeWall, type MemoryChunk, type RememberedWall, type RoomState, type Scene } from "#shared/model.ts";
import { shownFreeWall } from "#shared/project.ts";
import { layerChunks, type Layer } from "#shared/reducer/memory.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { SPLIT_CELLS, wallSpans } from "#shared/rules/held.ts";
import { isWritable } from "#shared/writable.ts";

/*
 * What players' maps cost (docs/design-v1-map-discovery.md 5.5): a free
 * wall at the largest form a player's copy can hold of it, and each entry
 * of players' memory at the larger of its stored bytes and the most it can
 * add to a player's chunks. The map step keeps each layer's charge under
 * its cap (server/rooms/remember.ts), and the size guard reserves the caps
 * (server/rooms/sizeGuard.ts), so neither measure ever reads what a layer
 * holds.
 */

/** The cap on one layer's memory of one scene, in charged bytes. */
export const MEMORY_CAP = LIMITS.memoryBytesPerLayer;

/** A record key as JSON writes it, quotes and escapes included, with its colon and the comma after its value. */
export function keyBytes(key: string): number {
  return utf8Bytes(JSON.stringify(key)) + 2;
}

/** The biggest `rev` a stored object can reach, so a charge never grows when a chunk is written again. */
const WIDEST_REV = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// A free wall's pieces (decision 2, 5.5, LK-36)

/** How many of the lines x = 4m (or y = 4m) lie strictly between lo and hi. */
function splitLinesInside(lo: number, hi: number): number {
  const first = Math.floor(lo / SPLIT_CELLS) + 1;
  const last = Math.ceil(hi / SPLIT_CELLS) - 1;
  return Math.max(0, last - first + 1);
}

/**
 * The most pieces a player's copy can cut one free wall into (5.5): with c
 * the cells it crosses and s the split lines strictly inside its span along
 * its major axis, held runs alternate with unheld cells, so at most
 * (c + 1) / 2 of them. On squares a split line is a cell side, so a piece
 * needs a cell of its own and the wall gives (c + s + 1) / 2 rounded down.
 * On hexes a split can fall inside a hex, so each line can add a piece.
 * Read from the wall alone, whatever any player holds.
 */
export function wallPieceBound(grid: Grid, wall: Pick<FreeWall, "a" | "b">): number {
  const c = wallSpans(grid, wall).length;
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  // A run steeper than 45 degrees splits on the rows' lines, any other on the columns' (5.2).
  const steep = Math.abs(by - ay) > Math.abs(bx - ax);
  const s = steep ? splitLinesInside(Math.min(ay, by), Math.max(ay, by)) : splitLinesInside(Math.min(ax, bx), Math.max(ax, bx));
  return isHex(grid) ? Math.floor((c + 1) / 2) + s : Math.floor((c + s + 1) / 2);
}

/**
 * One piece as a player's chunk prints it, with its comma (5.5): its keys,
 * brackets, id and kind, and four coordinates, each at most the scene's
 * integer digits and 7 characters, since a cut end is a multiple of
 * 1/10000 cell (decision 2). 98 bytes for a wall on a scene under 1,000
 * cells, 100 for a window.
 */
export function pieceBytes(scene: Pick<Scene, "bounds">, kind: "wall" | "window"): number {
  const frame = serializedBytes({ id: "x".repeat(FREE_WALL_ID_LENGTH), a: [0, 0], b: [0, 0], f: { kind } }) + 1 - 4;
  const digits = String(Math.max(scene.bounds.w, scene.bounds.h)).length;
  return frame + 4 * (digits + 7);
}

/**
 * The most bytes a free wall can take in any copy of its scene, with its
 * comma (5.5, ASTRA-32): as the DM's chunk stores it, whole as players see
 * a door, or cut into its most pieces, a window's with their longer kind.
 * A secret door may show as either, so it counts at both.
 */
export function wallLargestBytes(scene: Pick<Scene, "bounds" | "gridShape">, wall: FreeWall): number {
  const stored = serializedBytes(wall) + 1;
  const whole = serializedBytes(shownFreeWall(wall)) + 1;
  const pieces = wallPieceBound(sceneGrid(scene), wall) * pieceBytes(scene, wall.f.kind === "window" ? "window" : "wall");
  return Math.max(stored, whole, pieces);
}

// ---------------------------------------------------------------------------
// Memory's charges (5.5, ASTRA-23, D-261026-29 item 14)

const FIELDS = ["cells", "edges", "walls", "heights", "up", "upDir", "rough", "labels", "stamps"] as const;
export type MemoryField = (typeof FIELDS)[number];

/**
 * A field a player's chunk carries as one string for all 256 cells, which a
 * remembered value can bring to a chunk whose live build has none: its key,
 * its quotes and its comma. `upDir` rides every position's reserve already.
 */
const WHOLE_FIELDS: Partial<Record<MemoryField, number>> = {
  heights: keyBytes("heights") + 2 + Math.ceil((2 * 256) / 3) * 4,
  up: keyBytes("up") + 2 + 256,
  rough: keyBytes("rough") + 2 + 256,
};

/**
 * The most an entry can add to a player's copy of its scene: a remembered
 * terrain, drawn edge, label or stamp as the copy prints it, a remembered
 * wall at its own largest form, and nothing for an absence, an automatic
 * wall's bit or a cell of a whole-chunk field, which the chunk counts once.
 */
function projectedBytes(scene: Pick<Scene, "bounds" | "gridShape">, field: MemoryField, key: string, value: unknown): number {
  if (value === null || value === undefined) return 0;
  switch (field) {
    case "cells":
    case "labels":
    case "stamps":
      return keyBytes(key) + serializedBytes(value);
    case "edges":
      return value === "auto" ? 0 : keyBytes(key) + serializedBytes(value);
    case "walls":
      return (value as RememberedWall[]).reduce((sum, v) => sum + (v.wall === null ? 0 : wallLargestBytes(scene, v.wall)), 0);
    default:
      return 0;
  }
}

/**
 * One entry's charge against its layer's cap: the larger of its stored
 * bytes, its key with its quotes, colon and comma and its value, and the
 * most it can add to a player's chunks (5.5). A memory of walls forgets
 * sooner for it, which fails closed.
 */
export function entryCharge(scene: Pick<Scene, "bounds" | "gridShape">, field: MemoryField, key: string, value: unknown): number {
  return Math.max(keyBytes(key) + serializedBytes(value), projectedBytes(scene, field, key, value));
}

/** The key a layer's chunk is stored under in `memory` or `memoryBy`. */
export function memoryCollectionKey(chunk: Pick<MemoryChunk, "sceneId" | "cx" | "cy" | "memberId">): string {
  return chunk.memberId === undefined ? chunkKey(chunk.sceneId, chunk.cx, chunk.cy) : holderChunkKey(chunk.sceneId, chunk.memberId, chunk.cx, chunk.cy);
}

/**
 * What a chunk of memory costs beyond its entries: its key in its
 * collection, its place, its widest `rev`, each kind it holds as an empty
 * record, and once per chunk each whole-chunk field a remembered value can
 * bring. With every entry charged at least its own bytes and a comma, a
 * chunk's charge is never below what it stores.
 */
export function envelopeCharge(chunk: MemoryChunk): number {
  const frame: Record<string, unknown> = { sceneId: chunk.sceneId, cx: chunk.cx, cy: chunk.cy, rev: WIDEST_REV };
  if (chunk.memberId !== undefined) frame.memberId = chunk.memberId;
  let extra = 0;
  for (const field of FIELDS) {
    if (chunk[field] === undefined) continue;
    frame[field] = {};
    if (Object.keys(chunk[field]!).length > 0) extra += WHOLE_FIELDS[field] ?? 0;
  }
  return keyBytes(memoryCollectionKey(chunk)) + serializedBytes(frame) + extra;
}

/** The entries of a chunk of memory in the order the map step charges them: kind by kind, each in key order. */
export function chunkEntries(chunk: MemoryChunk): { field: MemoryField; key: string; value: unknown }[] {
  const out: { field: MemoryField; key: string; value: unknown }[] = [];
  for (const field of FIELDS) {
    const record = chunk[field] as Record<string, unknown> | undefined;
    if (!record) continue;
    for (const key of Object.keys(record).sort()) out.push({ field, key, value: record[key] });
  }
  return out;
}

/*
 * A chunk's charge, kept per chunk object, which is replaced and never
 * changed, and per scene shape, which a piece's bytes read.
 */
const charges = new WeakMap<MemoryChunk, { sig: string; bytes: number }>();

function shapeOf(scene: Pick<Scene, "bounds" | "gridShape">): string {
  return `${scene.bounds.w}x${scene.bounds.h}|${scene.gridShape ?? "squares"}`;
}

/** A chunk of memory's whole charge: its envelope and every entry's. */
export function chunkCharge(scene: Pick<Scene, "bounds" | "gridShape">, chunk: MemoryChunk): number {
  const sig = shapeOf(scene);
  const hit = charges.get(chunk);
  if (hit && hit.sig === sig) return hit.bytes;
  let bytes = envelopeCharge(chunk);
  for (const e of chunkEntries(chunk)) bytes += entryCharge(scene, e.field, e.key, e.value);
  if (!isWritable(chunk)) charges.set(chunk, { sig, bytes });
  return bytes;
}

/** One layer's whole memory of a scene, charged. */
export function layerCharge(state: RoomState, scene: Scene, layer: Layer): number {
  let bytes = 0;
  for (const chunk of layerChunks(state, scene.id, layer)) bytes += chunkCharge(scene, chunk);
  return bytes;
}
