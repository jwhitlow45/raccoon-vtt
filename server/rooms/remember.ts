import { chunkKey, doorChunk, holderTileKey, parseKey, tileKey, type EntityKey } from "#shared/keys.ts";
import { CHUNK_CELLS, type BuildChunk, type FreeWall, type Label, type MemoryChunk, type MemoryEntries, type RememberedWall, type RoomState, type Scene, type Stamp } from "#shared/model.ts";
import { chunkPositions, shownEdge, shownFreeWall, shownUpDir, sightHolders, stableStringify, stampCells } from "#shared/project.ts";
import type { OpOf } from "#shared/protocol.ts";
import { keepsMemory, layerHeld, type Layer } from "#shared/reducer/memory.ts";
import { autoWallsOf } from "#shared/rules/autoWalls.ts";
import { encodeTile, labelCells, TILE_CELLS, TILE_SUB } from "#shared/rules/fog.ts";
import type { CellRange } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { classSight, groundOf, holdsOwnSight, wallSpans, type Ground } from "#shared/rules/held.ts";
import { chunkHeights, chunkMarks } from "#shared/rules/heights.ts";
import { hexSubcells, parseHexKey } from "#shared/rules/hex.ts";
import { seenFogBits } from "#shared/rules/vision.ts";
import { sceneWalls, type WallSet } from "#shared/rules/walls.ts";
import { chunkCharge, chunkEntries, entryCharge, envelopeCharge, type MemoryField } from "./memorySize.ts";

/*
 * The map step (docs/design-v1-map-discovery.md 5.3): after every batch,
 * after its `sys.explore`, what each layer of players' memory now
 * remembers of the build, as one `sys.remember` per scene, which the actor
 * appends to the batch. Replay applies the stored op and never computes
 * sight.
 *
 * A layer is the party's explored layer, or a sight holder's own on a
 * per-player scene. Its remembered ground is what that explored layer
 * holds where neither the layer's sight nor the DM's reveals reach. Its
 * sight is the shared sight for the party and the holder's own for a
 * holder, on the players' scene only and none behind a blackout, which is
 * what groundOf's live ground reads (shared/rules/held.ts).
 *
 * - An element of the build that the batch changed, on a layer's
 *   remembered ground, gets that layer's entry: what the layer showed
 *   before, its entry if it had one, else the build before where the layer
 *   held it, else nothing. An entry equal to the build now drops, so an
 *   undo leaves none.
 * - An entry whose element touches the layer's sight or the DM's reveals
 *   drops, a free wall's cell by cell. Only entries near the tiles whose
 *   sight or fog object the batch replaced are read.
 * - A door a player touched (5.3, MD-O-6) drops its entries in every layer
 *   the sender reads, so they then see it as it is.
 * - A layer whose charge passes its cap forgets whole fog tiles, keeping
 *   the sub-cells in its sight now (5.3).
 */

/** A door a player's `door.set` touched: accepted, written or not, or refused as gone once its reach passed (6). */
export type DoorTouch = { sceneId: string; door: { edge: string } | { cx: number; cy: number; id: string }; memberId: string };

export type MapStepInput = {
  /** The state the batch started from. */
  before: RoomState;
  /** The state after the batch's ops and its explore. */
  after: RoomState;
  /** Every key the batch wrote. */
  touched: readonly EntityKey[];
  doors?: readonly DoorTouch[];
  /** A layer's cap on a scene in charged bytes (server/rooms/memorySize.ts): 64 KiB, its share of a full room, or 0 where memory is not reserved. */
  cap: (scene: Scene) => number;
  /** Measure every layer against its cap, not only those the batch wrote: a share was lowered. */
  everyLayer?: boolean;
};

type CellField = "cells" | "edges" | "heights" | "up" | "upDir" | "rough";
type MarkField = "labels" | "stamps";
type Mark = Label | Stamp;

/** What an element is with nothing there: no terrain, no wall, no height, no stair, smooth ground. */
const ABSENT: Record<CellField, unknown> = { cells: null, edges: null, heights: 0, up: ".", upDir: ".", rough: false };

/** An element filed by a cell or an edge, as players see it before and after the batch. */
type CellElement = { field: CellField; key: string; cx: number; cy: number; cells: readonly string[]; was: unknown; now: unknown };
/** A free wall by its real chunk and id, flattened as players see it, or null where none stands. */
type WallElement = { cx: number; cy: number; id: string; was: FreeWall | null; now: FreeWall | null };
/** A label or stamp by id, as players could see it: a stamp the DM keeps to themselves counts as none. */
type MarkElement = { field: MarkField; id: string; was: Mark | null; now: Mark | null };

type Changed = { cells: CellElement[]; walls: WallElement[]; marks: MarkElement[] };

/** Every `sys.remember` the batch needs, one per scene, in scene id order. */
export function mapStepOps(input: MapStepInput): OpOf<"sys.remember">[] {
  const out: OpOf<"sys.remember">[] = [];
  const touched = touchedByScene(input.before, input.after, input.touched);
  const memory = memoryIndex(input.after);
  const memoryBefore = input.before.memory === input.after.memory && input.before.memoryBy === input.after.memoryBy ? memory : memoryIndex(input.before);
  for (const sceneId of Object.keys(input.after.scenes).sort()) {
    const scene = input.after.scenes[sceneId]!;
    if (!keepsMemory(scene)) continue;
    const touch = touched.get(sceneId) ?? NOTHING_TOUCHED;
    const doors = (input.doors ?? []).filter((d) => d.sceneId === sceneId);
    // Most batches move a creature: a scene they wrote nothing on, whose live ground cannot have grown, has nothing to do.
    const quiet = touch.chunks.size === 0 && touch.marks.length === 0 && touch.memory.size === 0 && doors.length === 0;
    if (quiet && !input.everyLayer && (!memory.scenes.has(sceneId) || !liveMayGrow(input.before, input.after, sceneId))) continue;
    const op = sceneStep(input, scene, touch, doors, memory, memoryBefore);
    if (op) out.push(op);
  }
  return out;
}

/**
 * Fail closed (rule 9), for a batch whose map step could not run: every
 * layer of each scene that keeps memory and that the batch wrote on forgets
 * every tile it holds but the sub-cells in its sight now, so no edit out of
 * sight shows as live, and nothing it wrote is remembered wrongly.
 */
export function forgetAllOps(input: Pick<MapStepInput, "before" | "after" | "touched">): OpOf<"sys.remember">[] {
  const out: OpOf<"sys.remember">[] = [];
  const touched = touchedByScene(input.before, input.after, input.touched);
  for (const sceneId of [...touched.keys()].sort()) {
    const scene = input.after.scenes[sceneId];
    if (!scene || !keepsMemory(scene)) continue;
    const forget: NonNullable<OpOf<"sys.remember">["forget"]> = [];
    for (const layer of layersOf(input.after, scene)) {
      const sight = classSight(input.after, scene, layer);
      const held = layer === null ? Object.values(input.after.exploredTiles) : Object.values(input.after.exploredBy ?? {}).filter((t) => t.memberId === layer);
      const tiles = held
        .filter((t) => t.sceneId === sceneId)
        .sort((a, b) => a.ty - b.ty || a.tx - b.tx)
        .map(({ tx, ty }) => {
          const seen = sight?.tiles.get(`${tx},${ty}`);
          const keep = seen ? seenFogBits(seen) : null;
          return { tx, ty, ...(keep && keep.some((b) => b !== 0) ? { keep: encodeTile(keep) } : {}) };
        });
      if (tiles.length > 0) forget.push({ ...(layer === null ? {} : { memberId: layer }), tiles });
    }
    if (forget.length > 0) out.push({ t: "sys.remember", sceneId, layers: [], forget });
  }
  return out;
}

/** Each layer's chunks of memory, by layerKey, in row order, and the scenes that have any, read once per step. */
type MemoryIndex = { scenes: Set<string>; byLayer: Map<string, MemoryChunk[]> };

function memoryIndex(state: RoomState): MemoryIndex {
  const out: MemoryIndex = { scenes: new Set(), byLayer: new Map() };
  for (const all of [state.memory, state.memoryBy]) {
    for (const chunk of Object.values(all ?? {})) {
      out.scenes.add(chunk.sceneId);
      const key = layerKey(chunk.sceneId, chunk.memberId ?? null);
      let list = out.byLayer.get(key);
      if (!list) out.byLayer.set(key, (list = []));
      list.push(chunk);
    }
  }
  for (const list of out.byLayer.values()) list.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return out;
}

/** Whether a scene's live ground can have grown in the batch: the DM's fog changed, or it is the players' scene before or after, where sight moves. */
function liveMayGrow(before: RoomState, after: RoomState, sceneId: string): boolean {
  return before.fogTiles !== after.fogTiles || before.meta.playerSceneId === sceneId || after.meta.playerSceneId === sceneId;
}

// ---------------------------------------------------------------------------
// What the batch changed

/** What the batch wrote on one scene: chunk positions, labels and stamps, and the layers whose memory it wrote. */
type SceneTouch = { chunks: Set<string>; marks: { field: MarkField; id: string }[]; memory: Set<Layer> };
const NOTHING_TOUCHED: SceneTouch = { chunks: new Set(), marks: [], memory: new Set() };

function touchedByScene(before: RoomState, after: RoomState, touched: readonly EntityKey[]): Map<string, SceneTouch> {
  const out = new Map<string, SceneTouch>();
  const of = (sceneId: string) => {
    let t = out.get(sceneId);
    if (!t) out.set(sceneId, (t = { chunks: new Set(), marks: [], memory: new Set() }));
    return t;
  };
  const marks = new Set<string>();
  for (const key of touched) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (parsed.kind === "chunk") of(parsed.sceneId).chunks.add(`${parsed.cx},${parsed.cy}`);
    else if (parsed.kind === "memory") of(parsed.sceneId).memory.add(null);
    else if (parsed.kind === "memoryBy") of(parsed.sceneId).memory.add(parsed.memberId);
    else if (parsed.kind === "label" || parsed.kind === "stamp") marks.add(key);
  }
  for (const key of [...marks].sort()) {
    const field: MarkField = key.startsWith("label:") ? "labels" : "stamps";
    const id = key.slice(key.indexOf(":") + 1);
    // A label or stamp never changes scene, but one made or taken away stands on one side only.
    const sceneId = after[field][id]?.sceneId ?? before[field][id]?.sceneId;
    if (sceneId !== undefined) of(sceneId).marks.push({ field, id });
  }
  return out;
}

/** A cell key's neighbor across an edge: the cell north of a north edge, west of a west edge. */
function edgeCells(key: string): [string, string] {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  return [`${x},${y}`, side === "n" ? `${x},${y - 1}` : `${x - 1},${y}`];
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || stableStringify(a) === stableStringify(b);
}

/** Whether two labels or stamps show the same: a `rev` alone says nothing players see. */
function sameMark(a: Mark | null, b: Mark | null): boolean {
  if (a === null || b === null) return a === b;
  return stableStringify({ ...a, rev: 0 }) === stableStringify({ ...b, rev: 0 });
}

function sameWall(a: FreeWall | null, b: FreeWall | null): boolean {
  if (a === null || b === null) return a === b;
  return a === b || stableStringify(a) === stableStringify(b);
}

/** A label or stamp as players could see it, or null: one on another scene, or one the DM keeps to themselves. */
function dmOnlyStamp(state: RoomState, id: string, sceneId: string): boolean {
  const stamp = state.stamps[id];
  return stamp !== undefined && stamp.sceneId === sceneId && stamp.visibility === "dm";
}

function shownMark(state: RoomState, field: MarkField, id: string, sceneId: string): Mark | null {
  const value = state[field][id];
  if (!value || value.sceneId !== sceneId) return null;
  if (field === "stamps" && (value as Stamp).visibility === "dm") return null;
  return value;
}

/**
 * The positions whose elements the batch may have changed (5.3): each
 * touched chunk with its east and south neighbors, whose west and north
 * edges read its cells, every position where an automatic wall's rule or
 * the bounds changed, and the stairs' positions where the stair map did.
 */
function changedOn(before: RoomState, after: RoomState, scene: Scene, touch: SceneTouch): Changed {
  const sceneId = scene.id;
  const was = before.scenes[sceneId];
  const grid = sceneGrid(scene);
  const hex = isHex(grid);
  const positions = new Set<string>();
  if (!was || autoWallsOf(was) !== autoWallsOf(scene) || was.bounds.w !== scene.bounds.w || was.bounds.h !== scene.bounds.h) {
    for (const { cx, cy } of chunkPositions(scene)) positions.add(`${cx},${cy}`);
  }
  for (const at of touch.chunks) {
    const [cx, cy] = at.split(",").map(Number) as [number, number];
    positions.add(at);
    positions.add(`${cx + 1},${cy}`);
    positions.add(`${cx},${cy + 1}`);
  }
  const out: Changed = { cells: [], walls: [], marks: [] };
  const ruleB = autoWallsOf(was);
  const ruleA = autoWallsOf(scene);
  for (const at of [...positions].sort(byRow)) {
    const [cx, cy] = at.split(",").map(Number) as [number, number];
    const cb = before.buildChunks[chunkKey(sceneId, cx, cy)];
    const ca = after.buildChunks[chunkKey(sceneId, cx, cy)];
    if (cb !== ca) cellsChanged(out, sceneId, cx, cy, cb, ca);
    if (!hex && edgesMayDiffer(before, after, sceneId, cx, cy, ruleB !== ruleA)) {
      for (let k = 0; k < CELLS; k++) {
        const x = cx * CHUNK_CELLS + (k % CHUNK_CELLS);
        const y = cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
        for (const side of ["n", "w"] as const) {
          const key = `${x},${y},${side}`;
          const b = was ? shownEdge(before.buildChunks, sceneId, ruleB, key) : null;
          const a = shownEdge(after.buildChunks, sceneId, ruleA, key);
          if (!sameValue(b, a)) out.cells.push({ field: "edges", key, cx, cy, cells: edgeCells(key), was: b, now: a });
        }
      }
    }
  }
  if (!hex && touch.chunks.size > 0) stairsChanged(out, before, after, scene);
  for (const { field, id } of touch.marks) {
    const b = shownMark(before, field, id, sceneId);
    const a = shownMark(after, field, id, sceneId);
    if (!sameMark(b, a)) out.marks.push({ field, id, was: b, now: a });
  }
  return out;
}

const CELLS = CHUNK_CELLS * CHUNK_CELLS;

/** Whether a position's north and west edges can read differently: its own chunk or those west and north of it were replaced, or the rule changed. */
function edgesMayDiffer(before: RoomState, after: RoomState, sceneId: string, cx: number, cy: number, ruleChanged: boolean): boolean {
  if (ruleChanged) return true;
  const here = (s: RoomState) => s.buildChunks[chunkKey(sceneId, cx, cy)];
  const b = here(before);
  const a = here(after);
  if (b?.cells !== a?.cells || b?.edges !== a?.edges) return true;
  for (const [dx, dy] of [
    [-1, 0],
    [0, -1],
  ] as const) {
    if (before.buildChunks[chunkKey(sceneId, cx + dx, cy + dy)]?.cells !== after.buildChunks[chunkKey(sceneId, cx + dx, cy + dy)]?.cells) return true;
  }
  return false;
}

/** The cell-keyed elements and the free walls of one position whose chunk the batch replaced. */
function cellsChanged(out: Changed, sceneId: string, cx: number, cy: number, cb: BuildChunk | undefined, ca: BuildChunk | undefined): void {
  if (cb?.cells !== ca?.cells) {
    const keys = new Set([...Object.keys(cb?.cells ?? {}), ...Object.keys(ca?.cells ?? {})]);
    for (const key of [...keys].sort()) {
      const b = cb?.cells[key] ?? null;
      const a = ca?.cells[key] ?? null;
      if (b !== a) out.cells.push({ field: "cells", key, cx, cy, cells: [key], was: b, now: a });
    }
  }
  const hb = cb ? chunkHeights(cb) : null;
  const ha = ca ? chunkHeights(ca) : null;
  const mb = cb ? chunkMarks(cb) : null;
  const ma = ca ? chunkMarks(ca) : null;
  const rb = cb?.rough;
  const ra = ca?.rough;
  if (hb !== ha || mb !== ma || rb !== ra) {
    for (let k = 0; k < CELLS; k++) {
      const key = `${cx * CHUNK_CELLS + (k % CHUNK_CELLS)},${cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS)}`;
      const h0 = hb ? hb[k]! : 0;
      const h1 = ha ? ha[k]! : 0;
      if (h0 !== h1) out.cells.push({ field: "heights", key, cx, cy, cells: [key], was: h0, now: h1 });
      const m0 = mb ? mb[k]! : ".";
      const m1 = ma ? ma[k]! : ".";
      if (m0 !== m1) out.cells.push({ field: "up", key, cx, cy, cells: [key], was: m0, now: m1 });
      const r0 = rb?.[k] === "d";
      const r1 = ra?.[k] === "d";
      if (r0 !== r1) out.cells.push({ field: "rough", key, cx, cy, cells: [key], was: r0, now: r1 });
    }
  }
  if (cb?.walls !== ca?.walls) {
    const walls = new Map<string, { was: FreeWall | null; now: FreeWall | null }>();
    for (const w of cb?.walls ?? []) walls.set(w.id, { was: shownFreeWall(w), now: null });
    for (const w of ca?.walls ?? []) {
      const e = walls.get(w.id);
      if (e) e.now = shownFreeWall(w);
      else walls.set(w.id, { was: null, now: shownFreeWall(w) });
    }
    for (const id of [...walls.keys()].sort()) {
      const e = walls.get(id)!;
      if (!sameWall(e.was, e.now)) out.walls.push({ cx, cy, id, was: e.was, now: e.now });
    }
  }
}

/** Whether a chunk can hold a stair: a mark or stairs terrain. */
function hasStairs(chunk: BuildChunk | undefined): boolean {
  return chunk !== undefined && (chunkMarks(chunk) !== null || Object.values(chunk.cells).includes("stairs"));
}

/**
 * Stair directions, which read the scene's whole stair map, so an edit
 * chunks away can turn a stair players remember (ASTRA-4): every stair cell
 * whose direction differs between the maps before and after.
 */
function stairsChanged(out: Changed, before: RoomState, after: RoomState, scene: Scene): void {
  const was = before.scenes[scene.id];
  const mapB: WallSet | null = was ? sceneWalls(was, before.buildChunks) : null;
  const mapA = sceneWalls(scene, after.buildChunks);
  if (mapB === mapA) return;
  const positions = new Set<string>();
  for (const all of [before.buildChunks, after.buildChunks]) {
    for (const chunk of Object.values(all)) if (chunk && chunk.sceneId === scene.id && hasStairs(chunk)) positions.add(`${chunk.cx},${chunk.cy}`);
  }
  for (const at of [...positions].sort(byRow)) {
    const [cx, cy] = at.split(",").map(Number) as [number, number];
    const cb = before.buildChunks[chunkKey(scene.id, cx, cy)];
    const ca = after.buildChunks[chunkKey(scene.id, cx, cy)];
    const marksB = cb ? chunkMarks(cb) : null;
    const marksA = ca ? chunkMarks(ca) : null;
    for (let k = 0; k < CELLS; k++) {
      const x = cx * CHUNK_CELLS + (k % CHUNK_CELLS);
      const y = cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
      const key = `${x},${y}`;
      const stairB = (marksB !== null && marksB[k] !== ".") || cb?.cells[key] === "stairs";
      const stairA = (marksA !== null && marksA[k] !== ".") || ca?.cells[key] === "stairs";
      if (!stairB && !stairA) continue;
      const b = stairB && mapB ? shownUpDir(mapB, x, y) : ".";
      const a = stairA ? shownUpDir(mapA, x, y) : ".";
      if (b !== a) out.cells.push({ field: "upDir", key, cx, cy, cells: [key], was: b, now: a });
    }
  }
}

// ---------------------------------------------------------------------------
// One layer

/** Cell keys in row order, numerically. */
function byRow(a: string, b: string): number {
  const [ax, ay] = a.split(",").map(Number) as [number, number];
  const [bx, by] = b.split(",").map(Number) as [number, number];
  return ay - by || ax - bx;
}

/** What the step decides for one entry: drop it, or set it to a value. */
type Want = { drop: true } | { drop: false; value: unknown };

/** One layer of one scene as the step reads it. */
class LayerStep {
  readonly layer: Layer;
  readonly scene: Scene;
  readonly grid: Grid;
  /** What the layer's explored layer holds after the batch: its remembered ground and its sight. */
  readonly held: ReturnType<typeof layerHeld>;
  /** What it held before the batch, where it showed the build as it was. */
  readonly heldBefore: ReturnType<typeof layerHeld> | null;
  /** The layer's live ground after the batch: its sight and the DM's reveals. */
  readonly ground: Ground;
  /** Its chunks of memory after the batch's ops, by position, and where each label or stamp it remembers is filed. */
  readonly chunks = new Map<string, MemoryChunk>();
  readonly marksAt = new Map<string, string>();
  /**
   * Its chunks before the batch, which say what it showed then: an op's
   * bookkeeping can drop an entry whose element left the layer's ground,
   * and one put back must come back as the layer last saw it (MD2-LK-8).
   */
  readonly chunksBefore = new Map<string, MemoryChunk>();
  readonly marksBefore = new Map<string, string>();
  /** The step's decisions, by position, then `field|key`. */
  readonly wants = new Map<string, Map<string, { field: MemoryField; key: string; want: Want }>>();

  /** Whether the layer's explored layer holds a tile at all, which forgetting it can take away. */
  readonly tiles: (tx: number, ty: number) => boolean;
  /** Whether a stamp on the scene is one the DM keeps to themselves now, which no memory holds (5.4). */
  readonly dmOnly: (id: string) => boolean;

  constructor(input: MapStepInput, scene: Scene, layer: Layer, ground: Ground, chunks: readonly MemoryChunk[], before: readonly MemoryChunk[]) {
    this.layer = layer;
    this.scene = scene;
    this.grid = sceneGrid(scene);
    this.held = layerHeld(input.after, scene, layer);
    const was = input.before.scenes[scene.id];
    this.heldBefore = was ? layerHeld(input.before, was, layer) : null;
    this.ground = ground;
    this.tiles = layer === null ? (tx, ty) => input.after.exploredTiles[tileKey(scene.id, tx, ty)] !== undefined : (tx, ty) => input.after.exploredBy?.[holderTileKey(scene.id, layer, tx, ty)] !== undefined;
    this.dmOnly = (id) => dmOnlyStamp(input.after, id, scene.id);
    const index = (list: readonly MemoryChunk[], at: Map<string, MemoryChunk>, marks: Map<string, string>) => {
      for (const chunk of list) {
        at.set(`${chunk.cx},${chunk.cy}`, chunk);
        for (const field of ["labels", "stamps"] as const) for (const id of Object.keys(chunk[field] ?? {})) marks.set(`${field}|${id}`, `${chunk.cx},${chunk.cy}`);
      }
    };
    index(chunks, this.chunks, this.marksAt);
    index(before, this.chunksBefore, this.marksBefore);
  }

  /**
   * What the layer showed of an element by its entry: the entry before the
   * batch, else one the batch's bookkeeping wrote, as the fold pools a
   * holder's into the party's. Undefined for none, where it showed the build.
   */
  prior(at: string, field: MemoryField, key: string): { value: unknown } | undefined {
    const record = this.chunksBefore.get(at)?.[field] as Record<string, unknown> | undefined;
    if (record && Object.hasOwn(record, key)) return { value: record[key] };
    return this.entry(at, field, key);
  }

  /** An entry as the batch's ops left it, or undefined for none. */
  entry(at: string, field: MemoryField, key: string): { value: unknown } | undefined {
    const record = this.chunks.get(at)?.[field] as Record<string, unknown> | undefined;
    return record && Object.hasOwn(record, key) ? { value: record[key] } : undefined;
  }

  want(at: string, field: MemoryField, key: string, want: Want): void {
    const existing = this.entry(at, field, key);
    if (want.drop && !existing) {
      this.wants.get(at)?.delete(`${field}|${key}`);
      return;
    }
    if (!want.drop && existing && sameValue(existing.value, want.value)) {
      this.wants.get(at)?.delete(`${field}|${key}`);
      return;
    }
    let here = this.wants.get(at);
    if (!here) this.wants.set(at, (here = new Map()));
    here.set(`${field}|${key}`, { field, key, want });
  }

  heldAny(cells: readonly string[]): boolean {
    return cells.some((c) => this.held.key(c));
  }

  liveAny(cells: readonly string[]): boolean {
    return cells.some((c) => this.ground.keyLive(c));
  }

  /**
   * An element keyed by a cell or an edge. Changed by the batch, it takes
   * what the layer showed before wherever it is remembered. Unchanged, its
   * entry only drops: on live ground, or once the build equals it again.
   */
  cell(e: CellElement, changed: boolean): void {
    const at = `${e.cx},${e.cy}`;
    if (!this.heldAny(e.cells)) return;
    if (this.liveAny(e.cells)) {
      this.want(at, e.field, e.key, { drop: true });
      return;
    }
    if (!changed) {
      const existing = this.entry(at, e.field, e.key);
      if (existing && sameValue(existing.value, e.now)) this.want(at, e.field, e.key, { drop: true });
      return;
    }
    const prior = this.prior(at, e.field, e.key);
    const shown = prior ? prior.value : this.heldBefore && e.cells.some((c) => this.heldBefore!.key(c)) ? e.was : ABSENT[e.field];
    this.want(at, e.field, e.key, sameValue(shown, e.now) ? { drop: true } : { drop: false, value: shown });
  }

  /**
   * A free wall, cell by cell (5.2, D-261026-29 item 11): on each cell the
   * layer remembers, the version it showed there, kept where it differs
   * from the wall now. A cell it showed no version on showed the build
   * before. An unchanged wall only loses cells to live ground and versions
   * the build equals again.
   */
  wall(e: WallElement, changed: boolean): void {
    const at = `${e.cx},${e.cy}`;
    const existing = (changed ? this.prior(at, "walls", e.id) : this.entry(at, "walls", e.id))?.value as RememberedWall[] | undefined;
    const cells = new Set<string>();
    for (const w of [e.was, e.now]) if (w) for (const s of wallSpans(this.grid, w)) cells.add(s.cell);
    for (const v of existing ?? []) for (const c of v.cells) cells.add(c);
    const versions = new Map<string, RememberedWall>();
    for (const cell of [...cells].sort(byRow)) {
      if (!this.held.key(cell) || this.ground.keyLive(cell)) continue;
      const version = existing?.find((v) => v.cells.includes(cell));
      if (!version && !changed) continue;
      let shown: FreeWall | null = version ? version.wall : this.heldBefore?.key(cell) ? e.was : null;
      // A wall that does not cross a cell shows nothing of itself there.
      if (shown && !crosses(this.grid, shown, cell)) shown = null;
      const now = e.now && crosses(this.grid, e.now, cell) ? e.now : null;
      if (sameWall(shown, now)) continue;
      const same = stableStringify(shown);
      const kept = versions.get(same);
      if (kept) kept.cells.push(cell);
      else versions.set(same, { wall: shown, cells: [cell] });
    }
    const list = [...versions.values()].sort((a, b) => byRow(a.cells[0]!, b.cells[0]!));
    if (list.length === 0) this.want(at, "walls", e.id, { drop: true });
    else this.want(at, "walls", e.id, { drop: false, value: list });
  }

  /**
   * A label or stamp by id (MD-O-9): judged by both boxes. Its entry drops
   * once the live box touches live ground, and turns absent where only the
   * remembered box does, since they see it is gone from there. Without an
   * entry, it showed where the layer held its box before, and nothing
   * otherwise, so one put back onto remembered ground out of sight comes
   * back as absent there (MD1's undo case).
   */
  mark(e: MarkElement, changed: boolean): void {
    const box = (v: Mark) => (e.field === "labels" ? labelCells(v as Label) : stampCells(v as Stamp));
    const key = `${e.field}|${e.id}`;
    const filed = this.marksAt.get(key);
    const existing = filed === undefined ? undefined : this.entry(filed, e.field, e.id);
    const filedBefore = this.marksBefore.get(key);
    const prior = changed && filedBefore !== undefined ? this.prior(filedBefore, e.field, e.id) : existing;
    const nowBox = e.now ? box(e.now) : null;
    const drop = () => {
      if (filed !== undefined) this.want(filed, e.field, e.id, { drop: true });
    };
    // A stamp the DM keeps to themselves leaves every memory as the op's bookkeeping dropped it, and the step never writes it back.
    if (e.field === "stamps" && this.dmOnly(e.id)) return drop();
    if (nowBox && this.ground.rangeLive(nowBox)) return drop();
    if (!prior && !changed) return;
    let shown = prior ? (prior.value as Mark | null) : e.was && this.heldBefore?.range(box(e.was)) ? e.was : null;
    if (shown && this.ground.rangeLive(box(shown))) shown = null;
    if (sameMark(shown, e.now)) return drop();
    // The reducer keeps an entry only while a box of it lies on the layer's ground.
    if (!((shown && this.held.range(box(shown))) || (nowBox && this.held.range(nowBox)))) return drop();
    const at = filed ?? filedBefore ?? anchor(shown ?? e.now!);
    this.want(at, e.field, e.id, { drop: false, value: shown });
  }
}

/** The chunk of memory a label or stamp is filed in when it has none yet: the one its anchor stands in. */
function anchor(value: Mark): string {
  const clamp = (v: number) => Math.min(MEMORY_CHUNK_MOST, Math.max(0, Math.floor(v / CHUNK_CELLS)));
  return `${clamp(value.x)},${clamp(value.y)}`;
}

/** The highest chunk index memory takes (shared/protocol.ts MEMORY_CHUNK_MOST): the widest hex span of the largest scene. */
const MEMORY_CHUNK_MOST = 14;

const crossing = new WeakMap<object, Map<string, Set<string>>>();

function crosses(grid: Grid, wall: FreeWall, cell: string): boolean {
  let byGrid = crossing.get(wall);
  if (!byGrid) crossing.set(wall, (byGrid = new Map()));
  const g = isHex(grid) ? grid.orient : "squares";
  let cells = byGrid.get(g);
  if (!cells) byGrid.set(g, (cells = new Set(wallSpans(grid, wall).map((s) => s.cell))));
  return cells.has(cell);
}

// ---------------------------------------------------------------------------
// One scene

/** The layers that keep memory of a scene after the batch: the party's, and on a per-player scene each sight holder's. */
function layersOf(state: RoomState, scene: Scene): Layer[] {
  const out: Layer[] = [null];
  if (scene.vision?.perPlayer === true) for (const id of [...sightHolders(state, scene.id)].sort()) if (holdsOwnSight(state, scene.id, id)) out.push(id);
  return out;
}

function sceneStep(input: MapStepInput, scene: Scene, touch: SceneTouch, doors: readonly DoorTouch[], memory: MemoryIndex, memoryBefore: MemoryIndex): OpOf<"sys.remember"> | null {
  const { after } = input;
  const changed = changedOn(input.before, after, scene, touch);
  const layers: OpOf<"sys.remember">["layers"] = [];
  const forget: NonNullable<OpOf<"sys.remember">["forget"]> = [];
  for (const layer of layersOf(after, scene)) {
    const ground = groundOf(after, scene.id, layer);
    if (!ground) continue;
    const key = layerKey(scene.id, layer);
    const step = new LayerStep(input, scene, layer, ground, memory.byLayer.get(key) ?? [], memoryBefore.byLayer.get(key) ?? []);
    const anything = changed.cells.length + changed.walls.length + changed.marks.length > 0;
    const hasMemory = step.chunks.size > 0 || step.chunksBefore.size > 0;
    if (!anything && !hasMemory && doors.length === 0) continue;
    const done = new Set<string>();
    for (const e of changed.cells) {
      step.cell(e, true);
      done.add(`${e.cx},${e.cy}|${e.field}|${e.key}`);
    }
    for (const e of changed.walls) {
      step.wall(e, true);
      done.add(`${e.cx},${e.cy}|walls|${e.id}`);
    }
    for (const e of changed.marks) {
      step.mark(e, true);
      done.add(`${e.field}|${e.id}`);
    }
    if (hasMemory) liveSweep(input, step, done);
    for (const d of doors) {
      if (layer !== null && d.memberId !== layer) continue;
      const { cx, cy } = doorChunk(d.door);
      if ("edge" in d.door) step.want(`${cx},${cy}`, "edges", d.door.edge, { drop: true });
      else step.want(`${cx},${cy}`, "walls", d.door.id, { drop: true });
    }
    const chunks = chunksOf(step);
    if (chunks.length > 0) layers.push({ ...(layer === null ? {} : { memberId: layer }), chunks });
    if (input.everyLayer || chunks.length > 0 || touch.memory.has(layer)) {
      const tiles = forgetting(after, step, input.cap(scene));
      if (tiles.length > 0) forget.push({ ...(layer === null ? {} : { memberId: layer }), tiles });
    }
  }
  if (layers.length === 0 && forget.length === 0) return null;
  return { t: "sys.remember", sceneId: scene.id, layers, ...(forget.length > 0 ? { forget } : {}) };
}

/**
 * Drops what sight or a reveal now reaches (5.3): every entry near a tile
 * whose sight or fog object the batch replaced, read as an unchanged
 * element against the build now. Labels and stamps, few and filed by
 * anchor, are read wherever they are filed.
 */
function liveSweep(input: MapStepInput, step: LayerStep, done: ReadonlySet<string>): void {
  const { before, after } = input;
  const scene = step.scene;
  const tiles = newlyLiveTiles(before, after, scene, step.layer);
  if (tiles.size === 0) return;
  const hex = isHex(step.grid);
  const near = (cx: number, cy: number) => {
    if (hex) return true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (tiles.has(`${cx + dx},${cy + dy}`)) return true;
    return false;
  };
  for (const [at, chunk] of [...step.chunks].sort(([a], [b]) => byRow(a, b))) {
    const [cx, cy] = at.split(",").map(Number) as [number, number];
    const build = after.buildChunks[chunkKey(scene.id, cx, cy)];
    for (const field of ["labels", "stamps"] as const) {
      for (const id of Object.keys(chunk[field] ?? {}).sort()) {
        if (done.has(`${field}|${id}`)) continue;
        const now = shownMark(after, field, id, scene.id);
        step.mark({ field, id, was: now, now }, false);
      }
    }
    if (!near(cx, cy)) continue;
    for (const field of ["cells", "edges", "heights", "up", "upDir", "rough"] as const) {
      for (const key of Object.keys(chunk[field] ?? {}).sort()) {
        if (done.has(`${at}|${field}|${key}`)) continue;
        const now = liveValue(after, scene, field, key, build);
        step.cell({ field, key, cx, cy, cells: field === "edges" ? edgeCells(key) : [key], was: now, now }, false);
      }
    }
    for (const id of Object.keys(chunk.walls ?? {}).sort()) {
      if (done.has(`${at}|walls|${id}`)) continue;
      const live = build?.walls?.find((w) => w.id === id);
      const now = live ? shownFreeWall(live) : null;
      step.wall({ cx, cy, id, was: now, now }, false);
    }
  }
}

/** One element's value as players see the build now. */
function liveValue(state: RoomState, scene: Scene, field: CellField, key: string, chunk: BuildChunk | undefined): unknown {
  if (field === "edges") return shownEdge(state.buildChunks, scene.id, autoWallsOf(scene), key);
  if (field === "cells") return chunk?.cells[key] ?? null;
  const [x, y] = key.split(",").map(Number) as [number, number];
  const k = (y - (chunk?.cy ?? 0) * CHUNK_CELLS) * CHUNK_CELLS + (x - (chunk?.cx ?? 0) * CHUNK_CELLS);
  switch (field) {
    case "heights":
      return chunk ? (chunkHeights(chunk)?.[k] ?? 0) : 0;
    case "up":
      return chunk ? (chunkMarks(chunk)?.[k] ?? ".") : ".";
    case "rough":
      return chunk?.rough?.[k] === "d";
    case "upDir":
      return isHex(sceneGrid(scene)) ? "." : shownUpDir(sceneWalls(scene, state.buildChunks), x, y);
  }
}

/**
 * The tiles of a scene where a layer's live ground may have grown in the
 * batch: those whose sight tile, for the layer's sight, or whose DM fog
 * tile is another object after it than before. Compared by object, as the
 * explore step's answers are kept (server/rooms/explore.ts).
 */
function newlyLiveTiles(before: RoomState, after: RoomState, scene: Scene, layer: Layer): Set<string> {
  const out = new Set<string>();
  const sightA = classSight(after, scene, layer);
  const was = before.scenes[scene.id];
  const sightB = was ? classSight(before, was, layer) : null;
  if (sightA) for (const [at, tile] of sightA.tiles) if (sightB?.tiles.get(at) !== tile) out.add(at);
  if (before.fogTiles !== after.fogTiles) {
    for (const [key, tile] of Object.entries(after.fogTiles)) {
      if (tile.sceneId !== scene.id || before.fogTiles[key] === tile) continue;
      out.add(`${tile.tx},${tile.ty}`);
    }
  }
  return out;
}

/** The step's chunks for one layer, in row order, each with the keys it drops and the entries it sets, in key order. */
function chunksOf(step: LayerStep): { cx: number; cy: number; drop?: Record<string, string[]>; set?: Record<string, Record<string, unknown>> }[] {
  const out: { cx: number; cy: number; drop?: Record<string, string[]>; set?: Record<string, Record<string, unknown>> }[] = [];
  for (const at of [...step.wants.keys()].sort(byRow)) {
    const wants = step.wants.get(at)!;
    if (wants.size === 0) continue;
    const [cx, cy] = at.split(",").map(Number) as [number, number];
    const drop: Record<string, string[]> = {};
    const set: Record<string, Record<string, unknown>> = {};
    for (const { field, key, want } of [...wants.values()].sort((a, b) => (a.field === b.field ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.field < b.field ? -1 : 1))) {
      if (want.drop) (drop[field] ??= []).push(key);
      else (set[field] ??= {})[key] = want.value;
    }
    out.push({ cx, cy, ...(Object.keys(drop).length > 0 ? { drop } : {}), ...(Object.keys(set).length > 0 ? { set } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The cap (5.3, forgetting by tiles)

/** A layer's chunks once the step's decisions apply, by position, in the form the reducer stores. */
function chunksAfter(step: LayerStep): Map<string, MemoryChunk> {
  const out = new Map(step.chunks);
  for (const [at, wants] of step.wants) {
    if (wants.size === 0) continue;
    const [cx, cy] = at.split(",").map(Number) as [number, number];
    const held = step.chunks.get(at);
    const next: MemoryChunk = { sceneId: step.scene.id, cx, cy, rev: held?.rev ?? 0, ...(step.layer === null ? {} : { memberId: step.layer }) };
    const entries: Record<string, Record<string, unknown>> = {};
    for (const field of FIELDS) {
      const record = held?.[field] as Record<string, unknown> | undefined;
      if (record) entries[field] = { ...record };
    }
    for (const { field, key, want } of wants.values()) {
      const record = (entries[field] ??= {});
      if (want.drop) delete record[key];
      else record[key] = want.value;
    }
    let any = false;
    for (const field of FIELDS) {
      const record = entries[field];
      if (record && Object.keys(record).length > 0) {
        (next as Record<string, unknown>)[field] = record;
        any = true;
      }
    }
    if (any) out.set(at, next);
    else out.delete(at);
  }
  return out;
}

const FIELDS = ["cells", "edges", "walls", "heights", "up", "upDir", "rough", "labels", "stamps"] as const satisfies readonly (keyof MemoryEntries)[];

/**
 * The fog tiles a layer forgets so its charge stays within its cap (5.3):
 * taking its entries in chunk and key order, every tile an entry that does
 * not fit touches, which also takes every later entry held only through
 * those tiles. Each tile keeps the sub-cells in the layer's sight now
 * (MD-R2-5), so forgetting never hides what players see.
 */
function forgetting(state: RoomState, step: LayerStep, cap: number): { tx: number; ty: number; keep?: string }[] {
  const chunks = chunksAfter(step);
  const scene = step.scene;
  let total = 0;
  for (const chunk of chunks.values()) total += chunkCharge(scene, chunk);
  if (total <= cap) return [];
  const forgotten = new Set<string>();
  let used = 0;
  for (const at of [...chunks.keys()].sort(byRow)) {
    const chunk = chunks.get(at)!;
    let opened = false;
    for (const e of chunkEntries(chunk)) {
      const tiles = entryTiles(state, step, e.field, e.key, e.value).filter((t) => {
        const [tx, ty] = t.split(",").map(Number) as [number, number];
        return step.tiles(tx, ty);
      });
      if (tiles.length === 0 || tiles.every((t) => forgotten.has(t))) continue;
      const charge = entryCharge(scene, e.field, e.key, e.value) + (opened ? 0 : envelopeCharge(chunk));
      if (used + charge <= cap) {
        used += charge;
        opened = true;
      } else for (const t of tiles) forgotten.add(t);
    }
  }
  const sight = classSight(state, scene, step.layer);
  return [...forgotten].sort(byRow).map((at) => {
    const [tx, ty] = at.split(",").map(Number) as [number, number];
    const seen = sight?.tiles.get(at);
    const keep = seen ? seenFogBits(seen) : null;
    return { tx, ty, ...(keep && keep.some((b) => b !== 0) ? { keep: encodeTile(keep) } : {}) };
  });
}

/** The fog tiles an entry's element touches, as `"tx,ty"`: a cell's, both of an edge's, each of a wall version's cells', or a label's or stamp's boxes'. */
function entryTiles(state: RoomState, step: LayerStep, field: MemoryField, key: string, value: unknown): string[] {
  const out = new Set<string>();
  const cell = (c: string) => {
    if (isHex(step.grid)) {
      const hex = parseHexKey(c);
      if (hex) for (const [sx, sy] of hexSubcells(step.grid, hex)) out.add(`${Math.floor(sx / TILE_SUB)},${Math.floor(sy / TILE_SUB)}`);
      return;
    }
    const [x, y] = c.split(",").map(Number) as [number, number];
    if (x >= 0 && y >= 0) out.add(`${Math.floor(x / TILE_CELLS)},${Math.floor(y / TILE_CELLS)}`);
  };
  const range = (r: CellRange) => {
    for (let ty = Math.max(0, Math.floor(r.y0 / TILE_CELLS)); ty * TILE_CELLS < r.y1; ty++) for (let tx = Math.max(0, Math.floor(r.x0 / TILE_CELLS)); tx * TILE_CELLS < r.x1; tx++) out.add(`${tx},${ty}`);
  };
  if (field === "walls") for (const v of value as RememberedWall[]) for (const c of v.cells) cell(c);
  else if (field === "edges") for (const c of edgeCells(key)) cell(c);
  else if (field === "labels" || field === "stamps") {
    const live = shownMark(state, field, key, step.scene.id);
    for (const v of [value as Mark | null, live]) if (v) range(field === "labels" ? labelCells(v as Label) : stampCells(v as Stamp));
  } else cell(key);
  return [...out].sort(byRow);
}

// ---------------------------------------------------------------------------
// The estimate (5.3, the ask)

/** A layer of a scene, as the estimate keys it. */
export function layerKey(sceneId: string, layer: Layer): string {
  return JSON.stringify([sceneId, layer]);
}

/**
 * The most an op can add to each layer's memory (5.3): every element it
 * changed on a layer's remembered ground counts as out of sight, at the
 * charge of the entry the step would write from what the build was, so
 * the estimate is never low. Keyed by layerKey.
 */
export function memoryGrowth(before: RoomState, after: RoomState, touched: readonly EntityKey[]): Map<string, number> {
  const out = new Map<string, number>();
  const byScene = touchedByScene(before, after, touched);
  for (const [sceneId, touch] of byScene) {
    const scene = after.scenes[sceneId];
    if (!scene || !keepsMemory(scene) || (touch.chunks.size === 0 && touch.marks.length === 0)) continue;
    const changed = changedOn(before, after, scene, touch);
    if (changed.cells.length + changed.walls.length + changed.marks.length === 0) continue;
    const grid = sceneGrid(scene);
    for (const layer of layersOf(after, scene)) {
      const held = layerHeld(after, scene, layer);
      // The entries the step could write, filed as it would file them, so each chunk's envelope and whole-chunk fields count once.
      const chunks = new Map<string, Record<string, Record<string, unknown>>>();
      const put = (at: string, field: MemoryField, key: string, value: unknown) => {
        let entries = chunks.get(at);
        if (!entries) chunks.set(at, (entries = {}));
        (entries[field] ??= {})[key] = value;
      };
      for (const e of changed.cells) if (e.cells.some((c) => held.key(c))) put(`${e.cx},${e.cy}`, e.field, e.key, e.was);
      for (const e of changed.walls) {
        const cells = new Set<string>();
        for (const w of [e.was, e.now]) if (w) for (const s of wallSpans(grid, w)) if (held.key(s.cell)) cells.add(s.cell);
        if (cells.size > 0) put(`${e.cx},${e.cy}`, "walls", e.id, [{ wall: e.was, cells: [...cells] }]);
      }
      for (const e of changed.marks) {
        if (e.field === "stamps" && dmOnlyStamp(after, e.id, sceneId)) continue;
        const boxes = [e.was, e.now].filter((v): v is Mark => v !== null).map((v) => (e.field === "labels" ? labelCells(v as Label) : stampCells(v as Stamp)));
        if (boxes.some((r) => held.range(r))) put(anchor(e.was ?? e.now!), e.field, e.id, e.was);
      }
      let bytes = 0;
      for (const [at, entries] of chunks) {
        const [cx, cy] = at.split(",").map(Number) as [number, number];
        bytes += chunkCharge(scene, { sceneId, cx, cy, rev: 0, ...(layer === null ? {} : { memberId: layer }), ...entries });
      }
      if (bytes > 0) out.set(layerKey(sceneId, layer), bytes);
    }
  }
  return out;
}

/** Every layer that keeps memory of a scene, as layerKey names them, for the estimate's start. */
export function memoryLayers(state: RoomState, scene: Scene): Layer[] {
  return keepsMemory(scene) ? layersOf(state, scene) : [];
}
