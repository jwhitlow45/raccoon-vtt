import { chunkKey, holderChunkKey, holderTileKey, keys, parseKey, readEntity, tileKey, wallChunk, type EntityKey } from "../keys.ts";
import { CHUNK_CELLS, FOG_SUBCELLS, type FogTile, type Label, type MemoryChunk, type MemoryEntries, type RememberedWall, type RoomState, type Scene, type Stamp } from "../model.ts";
import { stableStringify, stampCells } from "../project.ts";
import type { MemoryEntriesInput, MemoryKeysInput } from "../protocol.ts";
import { decodeTile, getBit, labelCells, TILE_SUB } from "../rules/fog.ts";
import type { CellRange } from "../rules/footprint.ts";
import { isHex, sceneGrid } from "../rules/grid.ts";
import { hexSubcells, parseHexKey } from "../rules/hex.ts";
import { invalid, type Tx } from "./tx.ts";

/*
 * Players' memory of the build (docs/design-v1-map-discovery.md 5.3 and
 * 5.4): one memory per explored layer, the party's and each sight
 * holder's, each a diff against the build now, stored by chunk. The map
 * step on the server decides what each layer remembers and writes it in
 * `sys.remember`. Everything here is bookkeeping outside every undo step:
 * no undo brings memory back.
 */

/** Whose memory: a sight holder's member id, or null for the party's. */
export type Layer = string | null;

/** Whether a scene keeps players' memory: fog on and party vision on (5.1). Every other scene shows explored ground live. */
export function keepsMemory(scene: Pick<Scene, "fogEnabled" | "vision"> | undefined): boolean {
  return scene !== undefined && scene.fogEnabled && scene.vision?.on === true;
}

/** The entity key of one chunk of one layer's memory. */
export function memoryKey(sceneId: string, layer: Layer, cx: number, cy: number): EntityKey {
  return layer === null ? keys.memory(sceneId, cx, cy) : keys.memoryBy(sceneId, layer, cx, cy);
}

/** One layer's chunk of memory at a position, if it holds one. */
export function memoryChunkAt(state: RoomState, sceneId: string, layer: Layer, cx: number, cy: number): MemoryChunk | undefined {
  return layer === null ? state.memory?.[chunkKey(sceneId, cx, cy)] : state.memoryBy?.[holderChunkKey(sceneId, layer, cx, cy)];
}

/** One layer's chunks of a scene, in row order, as every walk here takes them so a replay writes the same keys in the same order. */
export function layerChunks(state: RoomState, sceneId: string, layer: Layer): MemoryChunk[] {
  const all = Object.values((layer === null ? state.memory : state.memoryBy) ?? {});
  return all.filter((c) => c.sceneId === sceneId && (c.memberId ?? null) === layer).sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

/** The holders with memory of a scene, in id order. */
export function memoryOwners(state: RoomState, sceneId: string): string[] {
  const out = new Set<string>();
  for (const chunk of Object.values(state.memoryBy ?? {})) if (chunk.sceneId === sceneId && chunk.memberId !== undefined) out.add(chunk.memberId);
  return [...out].sort();
}

/** Every layer with memory of a scene: the party's first, then each holder's in id order. */
function memoryLayers(state: RoomState, sceneId: string): Layer[] {
  const party = Object.values(state.memory ?? {}).some((c) => c.sceneId === sceneId);
  return [...(party ? [null] : []), ...memoryOwners(state, sceneId)];
}

const ENTRY_FIELDS = ["cells", "edges", "walls", "heights", "up", "upDir", "rough", "labels", "stamps"] as const;
type EntryField = (typeof ENTRY_FIELDS)[number];
/** The kinds keyed by a cell or an edge, whose element is that cell or the two cells beside that edge. */
const CELL_FIELDS = ["cells", "edges", "heights", "up", "upDir", "rough"] as const;
type CellField = (typeof CELL_FIELDS)[number];

/** Whether a chunk of memory holds no entry at all. */
function emptyEntries(entries: MemoryEntries): boolean {
  return ENTRY_FIELDS.every((field) => entries[field] === undefined || Object.keys(entries[field]!).length === 0);
}

/**
 * A layer's chunk with these entries, in one stored form: a kind is there
 * only while it names something, so two chunks that remember the same are
 * the same bytes. Null when nothing is left.
 */
function chunkOf(sceneId: string, layer: Layer, cx: number, cy: number, rev: number, entries: MemoryEntries): MemoryChunk | null {
  if (emptyEntries(entries)) return null;
  const out: MemoryChunk = { sceneId, cx, cy, rev };
  if (layer !== null) out.memberId = layer;
  for (const field of ENTRY_FIELDS) {
    const value = entries[field];
    if (value !== undefined && Object.keys(value).length > 0) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

/** The entries of a chunk of memory, without its place. */
function entriesOf(chunk: MemoryChunk | undefined): MemoryEntries {
  const out: MemoryEntries = {};
  if (!chunk) return out;
  for (const field of ENTRY_FIELDS) if (chunk[field] !== undefined) (out as Record<string, unknown>)[field] = chunk[field];
  return out;
}

/** Writes one layer's chunk, or removes it when it is left empty, as bookkeeping. Nothing is written when nothing changed. */
function putChunk(tx: Tx, sceneId: string, layer: Layer, cx: number, cy: number, entries: MemoryEntries): void {
  const held = memoryChunkAt(tx.state, sceneId, layer, cx, cy);
  const next = chunkOf(sceneId, layer, cx, cy, held?.rev ?? 0, entries);
  if (next === null) {
    if (held) tx.writeBookkeeping(memoryKey(sceneId, layer, cx, cy), null);
    return;
  }
  if (held && stableStringify(entriesOf(held)) === stableStringify(entriesOf(next))) return;
  tx.writeBookkeeping(memoryKey(sceneId, layer, cx, cy), next);
}

/** Takes away one layer's whole memory of a scene, as bookkeeping. */
export function forgetLayerMemory(tx: Tx, sceneId: string, layer: Layer): void {
  for (const chunk of layerChunks(tx.state, sceneId, layer)) tx.writeBookkeeping(memoryKey(sceneId, layer, chunk.cx, chunk.cy), null);
}

/** Takes away every layer's memory of a scene, as bookkeeping: its fog or vision went off, the shape switched, or it went. */
export function forgetSceneMemory(tx: Tx, sceneId: string): void {
  for (const layer of memoryLayers(tx.state, sceneId)) forgetLayerMemory(tx, sceneId, layer);
}

// What a layer holds (decision 1): a cell any of whose fog sub-cells its explored layer reveals.

/** What one layer's explored tiles reveal, decoded once per tile. */
type Held = {
  /** A cell by its key, on the scene's own grid: a hex by the sub-cells inside it (HX-D10). */
  key(cell: string): boolean;
  /** Any square cell of a range, as labels and stamps are judged on every grid (project.ts). */
  range(r: CellRange): boolean;
};

export function layerHeld(state: RoomState, scene: Scene, layer: Layer): Held {
  const decoded = new Map<string, Uint8Array | null>();
  const tile = (tx: number, ty: number): Uint8Array | null => {
    const at = `${tx},${ty}`;
    let bits = decoded.get(at);
    if (bits === undefined) {
      const t: FogTile | undefined = layer === null ? state.exploredTiles?.[tileKey(scene.id, tx, ty)] : state.exploredBy?.[holderTileKey(scene.id, layer, tx, ty)];
      bits = t ? decodeTile(t.bits) : null;
      decoded.set(at, bits);
    }
    return bits;
  };
  const subcell = (sx: number, sy: number): boolean => {
    if (sx < 0 || sy < 0) return false;
    const tx = Math.floor(sx / TILE_SUB);
    const ty = Math.floor(sy / TILE_SUB);
    const bits = tile(tx, ty);
    return bits !== null && getBit(bits, sx - tx * TILE_SUB, sy - ty * TILE_SUB);
  };
  const square = (x: number, y: number): boolean => {
    if (x < 0 || y < 0) return false;
    const bits = tile(Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS));
    if (bits === null) return false;
    const bx = (x % CHUNK_CELLS) * FOG_SUBCELLS;
    const by = (y % CHUNK_CELLS) * FOG_SUBCELLS;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) for (let sx = 0; sx < FOG_SUBCELLS; sx++) if (getBit(bits, bx + sx, by + sy)) return true;
    return false;
  };
  const grid = sceneGrid(scene);
  return {
    key(cell) {
      if (isHex(grid)) {
        const hex = parseHexKey(cell);
        return hex !== null && hexSubcells(grid, hex).some(([sx, sy]) => subcell(sx, sy));
      }
      const [x, y] = cell.split(",").map(Number) as [number, number];
      return square(x, y);
    },
    range(r) {
      // Only the tiles the layer holds need a look, so a wide label on a mostly dark scene stays cheap.
      for (let ty = Math.max(0, Math.floor(r.y0 / CHUNK_CELLS)); ty * CHUNK_CELLS < r.y1; ty++) {
        for (let tx = Math.max(0, Math.floor(r.x0 / CHUNK_CELLS)); tx * CHUNK_CELLS < r.x1; tx++) {
          if (tile(tx, ty) === null) continue;
          const y1 = Math.min(r.y1, (ty + 1) * CHUNK_CELLS);
          const x1 = Math.min(r.x1, (tx + 1) * CHUNK_CELLS);
          for (let y = Math.max(r.y0, ty * CHUNK_CELLS); y < y1; y++) for (let x = Math.max(r.x0, tx * CHUNK_CELLS); x < x1; x++) if (square(x, y)) return true;
        }
      }
      return false;
    },
  };
}

/** The cells an element keyed by a cell or an edge touches: the cell, or the two cells beside the edge. */
function cellsOf(field: CellField, key: string): string[] {
  if (field !== "edges") return [key];
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  return [`${x},${y}`, side === "n" ? `${x},${y - 1}` : `${x - 1},${y}`];
}

/** Every box a label or stamp element is judged by (5.3): each one remembered and the one it has now. */
function boxes(state: RoomState, sceneId: string, field: "labels" | "stamps", id: string, remembered: readonly (Label | Stamp | null)[]): CellRange[] {
  const out: CellRange[] = [];
  const live = field === "labels" ? state.labels[id] : state.stamps[id];
  for (const value of [...remembered, live]) {
    if (!value || value.sceneId !== sceneId) continue;
    out.push(field === "labels" ? labelCells(value as Label) : stampCells(value as Stamp));
  }
  return out;
}

/** Whether a layer holds any cell an entry's element touches. */
function holdsElement(state: RoomState, sceneId: string, held: Held, field: Exclude<EntryField, "walls">, key: string, value: unknown): boolean {
  if (field === "labels" || field === "stamps") return boxes(state, sceneId, field, key, [value as Label | Stamp | null]).some((r) => held.range(r));
  return cellsOf(field, key).some((cell) => held.key(cell));
}

/**
 * Drops, as bookkeeping, every entry of a layer's memory of a scene whose
 * element touches no cell the layer still holds, and takes the cells it no
 * longer holds off each free wall's versions (5.4): after a step's sets,
 * and after the layer loses explored ground. An element still held through
 * another cell keeps its entry, so a hide over part of a room changes
 * nothing players see of the rest.
 */
export function pruneUnheld(tx: Tx, scene: Scene, layer: Layer): void {
  const chunks = layerChunks(tx.state, scene.id, layer);
  if (chunks.length === 0) return;
  const held = layerHeld(tx.state, scene, layer);
  for (const chunk of chunks) {
    const entries = entriesOf(chunk);
    let changed = false;
    for (const field of ENTRY_FIELDS) {
      const record = entries[field] as Record<string, unknown> | undefined;
      if (!record) continue;
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (field === "walls") {
          const versions = (value as RememberedWall[]).flatMap((v) => {
            const cells = v.cells.filter((cell) => held.key(cell));
            return cells.length === 0 ? [] : [cells.length === v.cells.length ? v : { ...v, cells }];
          });
          if (versions.length > 0) kept[key] = versions;
          if (versions.length !== (value as RememberedWall[]).length || versions.some((v, i) => v !== (value as RememberedWall[])[i])) changed = true;
        } else if (holdsElement(tx.state, scene.id, held, field, key, value)) kept[key] = value;
        else changed = true;
      }
      (entries as Record<string, unknown>)[field] = kept;
    }
    if (changed) putChunk(tx, scene.id, layer, chunk.cx, chunk.cy, entries);
  }
}

/**
 * Prunes every layer whose explored ground lost a sub-cell in the op, as
 * bookkeeping (5.4). Every path that takes explored ground away comes
 * through here, whatever it is: a hide, `sys.remember` forgetting tiles, a
 * per-player scene shrinking or a scene turning per player, by an edit or
 * a restore. So memory never outlives the ground it is on. A layer that
 * only gained ground keeps all it remembers, and is not read.
 */
export function pruneLostGround(tx: Tx, before: RoomState): void {
  if (tx.state.exploredTiles === before.exploredTiles && tx.state.exploredBy === before.exploredBy) return;
  // A layer with no memory has nothing to prune, so its tiles are never decoded: most ops that explore touch no memory.
  const remembering = layersWithMemory(tx.state);
  if (remembering.size === 0) return;
  const lost = new Map<string, Set<Layer>>();
  for (const key of tx.touched()) {
    const parsed = parseKey(key);
    if (parsed?.kind !== "explored" && parsed?.kind !== "exploredBy") continue;
    const layer = parsed.kind === "explored" ? null : parsed.memberId;
    if (!remembering.has(layerId(parsed.sceneId, layer))) continue;
    const was = readEntity(before, key) as FogTile | null;
    if (!was) continue;
    const now = readEntity(tx.state, key) as FogTile | null;
    if (now && !losesBits(was.bits, now.bits)) continue;
    let layers = lost.get(parsed.sceneId);
    if (!layers) lost.set(parsed.sceneId, (layers = new Set()));
    layers.add(layer);
  }
  pruneLayers(tx, lost);
}

/** Prunes each scene's layers named, a scene in id order and its party's layer before its holders' in id order. */
function pruneLayers(tx: Tx, lost: ReadonlyMap<string, ReadonlySet<Layer>>): void {
  for (const sceneId of [...lost.keys()].sort()) {
    const scene = tx.state.scenes[sceneId];
    if (!scene) continue;
    const layers = lost.get(sceneId)!;
    const members = [...layers].filter((l): l is string => l !== null).sort();
    for (const layer of [...(layers.has(null) ? [null] : []), ...members]) pruneUnheld(tx, scene, layer);
  }
}

/** One layer of one scene, as `layersWithMemory` names it. */
function layerId(sceneId: string, layer: Layer): string {
  return JSON.stringify([sceneId, layer]);
}

/** Every layer that holds a chunk of memory, by `layerId`. */
function layersWithMemory(state: RoomState): Set<string> {
  const out = new Set<string>();
  for (const chunk of Object.values(state.memory ?? {})) out.add(layerId(chunk.sceneId, null));
  for (const chunk of Object.values(state.memoryBy ?? {})) out.add(layerId(chunk.sceneId, chunk.memberId ?? null));
  return out;
}

/** Whether a tile's bits lost any sub-cell the earlier bits held. */
function losesBits(was: string, now: string): boolean {
  if (was === now) return false;
  const a = decodeTile(was);
  const b = decodeTile(now);
  if (!a) return false;
  if (!b) return true;
  return a.some((byte, i) => (byte & ~b[i]!) !== 0);
}

/** Drops every layer's entries for a stamp, as bookkeeping: it was made DM only, so its art stops reaching players (5.4). */
export function forgetStamp(tx: Tx, sceneId: string, stampId: string): void {
  for (const layer of memoryLayers(tx.state, sceneId)) {
    for (const chunk of layerChunks(tx.state, sceneId, layer)) {
      if (!chunk.stamps || !(stampId in chunk.stamps)) continue;
      const { [stampId]: _gone, ...stamps } = chunk.stamps;
      putChunk(tx, sceneId, layer, chunk.cx, chunk.cy, { ...entriesOf(chunk), stamps });
    }
  }
}

// `sys.remember` (5.3).

/** Whether a cell or edge key lies in a chunk's cells, where the build files it. */
function inChunk(key: string, cx: number, cy: number): boolean {
  const [xs, ys] = key.split(",");
  return Math.floor(Number(xs) / CHUNK_CELLS) === cx && Math.floor(Number(ys) / CHUNK_CELLS) === cy;
}

/**
 * One chunk of a layer's memory after a step's drops and then its sets,
 * each entry checked against what the build files there: a cell or edge
 * in this chunk's cells, a free wall's versions under its own id in its
 * midpoint's chunk and covering each cell once, and a label or stamp under
 * its own id on this scene. A stamp the DM keeps to themselves is never
 * remembered, since its art would reach players (5.4).
 */
function steppedEntries(state: RoomState, sceneId: string, cx: number, cy: number, held: MemoryChunk | undefined, drop: MemoryKeysInput | undefined, set: MemoryEntriesInput | undefined): MemoryEntries {
  const entries = entriesOf(held);
  const record = (field: EntryField): Record<string, unknown> => {
    const copy = { ...((entries[field] as Record<string, unknown> | undefined) ?? {}) };
    (entries as Record<string, unknown>)[field] = copy;
    return copy;
  };
  for (const field of ENTRY_FIELDS) {
    const keys = drop?.[field];
    if (!keys) continue;
    const r = record(field);
    for (const key of keys) delete r[key];
  }
  for (const field of ENTRY_FIELDS) {
    const values = set?.[field] as Record<string, unknown> | undefined;
    if (!values) continue;
    const r = record(field);
    for (const [key, value] of Object.entries(values)) {
      if ((CELL_FIELDS as readonly string[]).includes(field) && !inChunk(key, cx, cy)) throw invalid(`remembered ${field} ${key} lies outside its chunk`);
      if (field === "walls") checkVersions(key, cx, cy, value as RememberedWall[]);
      if (field === "labels" || field === "stamps") {
        const v = value as Label | Stamp | null;
        if (v !== null && (v.id !== key || v.sceneId !== sceneId)) throw invalid(`a remembered ${field === "labels" ? "label" : "stamp"} goes under its own id on its own scene`);
        if (field === "stamps" && v !== null && state.stamps[key]?.visibility === "dm") throw invalid("a stamp the DM keeps to themselves is never remembered");
      }
      r[key] = value;
    }
  }
  return entries;
}

function checkVersions(id: string, cx: number, cy: number, versions: readonly RememberedWall[]): void {
  const seen = new Set<string>();
  for (const v of versions) {
    if (v.wall !== null) {
      const at = wallChunk(v.wall);
      if (v.wall.id !== id || at.cx !== cx || at.cy !== cy) throw invalid("a remembered free wall goes under its own id in its own chunk");
    }
    for (const cell of v.cells) {
      if (seen.has(cell)) throw invalid("a free wall's versions cover a cell twice");
      seen.add(cell);
    }
  }
}

/**
 * Applies one layer's chunks of a `sys.remember`, then checks that each
 * label and stamp it remembers lies in one chunk only. An entry whose
 * element touches no cell the layer holds would never show, so it is not
 * kept: memory stays on ground its layer explored, whatever a step sends.
 */
export function rememberLayer(tx: Tx, scene: Scene, layer: Layer, chunks: readonly { cx: number; cy: number; drop?: MemoryKeysInput | undefined; set?: MemoryEntriesInput | undefined }[]): void {
  for (const c of chunks) {
    const held = memoryChunkAt(tx.state, scene.id, layer, c.cx, c.cy);
    putChunk(tx, scene.id, layer, c.cx, c.cy, steppedEntries(tx.state, scene.id, c.cx, c.cy, held, c.drop, c.set));
  }
  pruneUnheld(tx, scene, layer);
  for (const field of ["labels", "stamps"] as const) {
    const seen = new Set<string>();
    for (const chunk of layerChunks(tx.state, scene.id, layer)) {
      for (const id of Object.keys(chunk[field] ?? {})) {
        if (seen.has(id)) throw invalid(`a remembered ${field === "labels" ? "label" : "stamp"} lies in two chunks`);
        seen.add(id);
      }
    }
  }
}

// The fold (5.4): a scene that stops being per player pools its holders' memory into the party's.

/** One layer as the fold reads it: what it holds and its chunks by position. */
type Indexed = { held: Held; at: Map<string, MemoryChunk>; byId: { labels: Map<string, MemoryChunk>; stamps: Map<string, MemoryChunk> } };

function indexed(state: RoomState, scene: Scene, layer: Layer): Indexed {
  const at = new Map<string, MemoryChunk>();
  const byId = { labels: new Map<string, MemoryChunk>(), stamps: new Map<string, MemoryChunk>() };
  for (const chunk of layerChunks(state, scene.id, layer)) {
    at.set(`${chunk.cx},${chunk.cy}`, chunk);
    for (const field of ["labels", "stamps"] as const) for (const id of Object.keys(chunk[field] ?? {})) byId[field].set(id, chunk);
  }
  return { held: layerHeld(state, scene, layer), at, byId };
}

/** Cell keys in row order, numerically, so a pooled wall's versions list their cells the same way on every replay. */
function byRow(a: string, b: string): number {
  const [ax, ay] = a.split(",").map(Number) as [number, number];
  const [bx, by] = b.split(",").map(Number) as [number, number];
  return ay - by || ax - bx;
}

/**
 * Pools, as bookkeeping, every holder's memory of a scene into the
 * party's, per element and a free wall per cell (5.4): an element that
 * touches a cell the party's layer held keeps the party's entry or none,
 * and any other takes the entry of the first holder in `order` whose own
 * layer holds it, or none, so each element reads as one layer saw it. A
 * label or stamp lies in every box a layer remembers it in and its live
 * one, so one deleted since is judged where each layer last saw it.
 * Called before the layers themselves pool, so "the party's layer" is the
 * party's alone. The holders' memory goes with their layers after.
 */
export function poolMemory(tx: Tx, scene: Scene, order: readonly string[]): void {
  if (!order.some((m) => layerChunks(tx.state, scene.id, m).length > 0)) return;
  const party = indexed(tx.state, scene, null);
  const holders = order.map((m) => indexed(tx.state, scene, m));
  const layers = [party, ...holders];
  const out = new Map<string, MemoryEntries>();
  const outAt = (pos: string): MemoryEntries => {
    let entries = out.get(pos);
    if (!entries) out.set(pos, (entries = {}));
    return entries;
  };
  const put = (pos: string, field: EntryField, key: string, value: unknown) => {
    const entries = outAt(pos) as Record<string, Record<string, unknown>>;
    (entries[field] ??= {})[key] = value;
  };
  /** The layer an element reads as: the party's where it holds it, else the first holder holding it, else none. */
  const reader = (holds: (l: Indexed) => boolean): Indexed | null => (holds(party) ? party : (holders.find(holds) ?? null));
  const positions = new Set<string>();
  for (const l of layers) for (const pos of l.at.keys()) positions.add(pos);
  for (const pos of [...positions].sort(byRow)) {
    for (const field of CELL_FIELDS) {
      const keysHere = new Set<string>();
      for (const l of layers) for (const key of Object.keys(l.at.get(pos)?.[field] ?? {})) keysHere.add(key);
      for (const key of [...keysHere].sort()) {
        const from = reader((l) => cellsOf(field, key).some((cell) => l.held.key(cell)));
        const record = from?.at.get(pos)?.[field] as Record<string, unknown> | undefined;
        if (record && key in record) put(pos, field, key, record[key]);
      }
    }
    const ids = new Set<string>();
    for (const l of layers) for (const id of Object.keys(l.at.get(pos)?.walls ?? {})) ids.add(id);
    for (const id of [...ids].sort()) {
      const cells = new Set<string>();
      for (const l of layers) for (const v of l.at.get(pos)?.walls?.[id] ?? []) for (const cell of v.cells) cells.add(cell);
      const versions = new Map<string, RememberedWall>();
      for (const cell of [...cells].sort(byRow)) {
        const from = reader((l) => l.held.key(cell));
        const version = from?.at.get(pos)?.walls?.[id]?.find((v) => v.cells.includes(cell));
        if (!version) continue;
        const same = stableStringify(version.wall);
        const kept = versions.get(same);
        if (kept) kept.cells.push(cell);
        else versions.set(same, { wall: version.wall, cells: [cell] });
      }
      if (versions.size > 0) put(pos, "walls", id, [...versions.values()]);
    }
  }
  for (const field of ["labels", "stamps"] as const) {
    const ids = new Set<string>();
    for (const l of layers) for (const id of l.byId[field].keys()) ids.add(id);
    for (const id of [...ids].sort()) {
      // Where the element lies is every box any layer remembers and the live one, found before the layer is chosen, so
      // the party's absence of an element it holds the ground of still wins over a holder's entry.
      const footprint = boxes(tx.state, scene.id, field, id, layers.map((l) => l.byId[field].get(id)?.[field]?.[id] ?? null));
      const from = reader((l) => footprint.some((r) => l.held.range(r)));
      const chunk = from?.byId[field].get(id);
      if (chunk) put(`${chunk.cx},${chunk.cy}`, field, id, chunk[field]![id]);
    }
  }
  const written = new Set<string>();
  for (const pos of [...out.keys()].sort(byRow)) {
    const [cx, cy] = pos.split(",").map(Number) as [number, number];
    putChunk(tx, scene.id, null, cx, cy, out.get(pos)!);
    written.add(pos);
  }
  for (const pos of [...party.at.keys()].sort(byRow)) {
    if (written.has(pos)) continue;
    const [cx, cy] = pos.split(",").map(Number) as [number, number];
    putChunk(tx, scene.id, null, cx, cy, {});
  }
}

// Duplicate with Fog (5.4).

/**
 * Copies every layer's memory of a scene onto its copy, as bookkeeping:
 * labels and stamps under the ids `copyId` gives them, those only memory
 * names included, so a copy's memory never names the original's things.
 * Free wall ids are only unique within their chunk, and stay.
 */
export function copyMemory(tx: Tx, from: string, to: string, copyId: (id: string) => string): void {
  const source = tx.state;
  for (const layer of memoryLayers(source, from)) {
    for (const chunk of layerChunks(source, from, layer)) {
      if (memoryChunkAt(source, to, layer, chunk.cx, chunk.cy)) throw invalid("a copied id is taken");
      const entries = entriesOf(chunk);
      if (chunk.labels) entries.labels = renamed(chunk.labels, to, copyId);
      if (chunk.stamps) entries.stamps = renamed(chunk.stamps, to, copyId);
      putChunk(tx, to, layer, chunk.cx, chunk.cy, entries);
    }
  }
}

function renamed<T extends Label | Stamp>(record: Record<string, T | null>, sceneId: string, copyId: (id: string) => string): Record<string, T | null> {
  const out: Record<string, T | null> = {};
  for (const id of Object.keys(record).sort()) {
    const value = record[id]!;
    const copy = copyId(id);
    out[copy] = value === null ? null : { ...value, id: copy, sceneId };
  }
  return out;
}
