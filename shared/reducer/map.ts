import { cellIndex, decodeHeights, decodeStairs, encodeHeights, encodeStairs } from "../heightCodec.ts";
import { cellOf, chunkKey, doorChunk, keys, tileKey, wallChunk, wallMidpoint } from "../keys.ts";
import { CHUNK_CELLS, type BuildChunk, type FogDraft, type FogOp, type FreeWall, type Label, type Light, type Scene, type Stamp, type TerrainId, type Token, type WallFeature } from "../model.ts";
import { MAX_BUILD_CELLS, MAX_FOG_DRAFT_OPS, type OpOf } from "../protocol.ts";
import { allRevealedTiles, decodeTile, encodeTile, isEmptyBits, pointInPolygonFixed, rasterizeFogOps, tilesAcross } from "../rules/fog.ts";
import { occupiedCells } from "../rules/footprint.ts";
import { footprintGround } from "../rules/heights.ts";
import { boxTouchesCell, labelBox } from "../rules/labels.ts";
import { sortedById } from "./tokens.ts";
import { Refuse, gone, invalid, type Tx } from "./tx.ts";

// Fog (design 13.2).

export function fogDraft(tx: Tx, op: OpOf<"fog.draft">): void {
  tx.scene(op.sceneId);
  const draft: FogDraft = tx.state.fogDrafts[op.sceneId] ?? { sceneId: op.sceneId, rev: 0, ops: [] };
  const removing = new Set(op.remove ?? []);
  const adding = new Map((op.add ?? []).map((o) => [o.id, o]));
  const ops: FogOp[] = draft.ops.filter((o) => !removing.has(o.id) && !adding.has(o.id));
  for (const o of adding.values()) ops.push(o);
  if (ops.length > MAX_FOG_DRAFT_OPS) throw new Refuse("quota", `this scene can hold at most ${MAX_FOG_DRAFT_OPS.toLocaleString("en-US")} fog changes in its draft`);
  if (ops.length === 0) {
    if (tx.state.fogDrafts[op.sceneId]) tx.remove(keys.fogDraft(op.sceneId));
    return;
  }
  tx.write(keys.fogDraft(op.sceneId), { ...draft, ops });
}

function applyFogOps(tx: Tx, scene: Scene, ops: FogOp[]): void {
  const changes = rasterizeFogOps(tx.state.fogTiles, scene.id, scene.bounds, ops);
  for (const key of Object.keys(changes).sort()) {
    const tile = changes[key];
    if (tile === undefined) continue;
    const [tx_, ty] = key.slice(scene.id.length + 1).split(",").map(Number) as [number, number];
    if (tile === null) tx.remove(keys.fog(scene.id, tx_, ty));
    else tx.write(keys.fog(scene.id, tile.tx, tile.ty), tile);
  }
  forgetUnderHides(tx, scene, ops);
}

/**
 * A hide also makes players forget what the party explored under it
 * (docs/design-v1-maps-vision.md 4.3.3), except where the party looks now,
 * which the batch's explore records again. Reveals leave the explored layer
 * alone, and so the order of the ops does not matter to it. The clearing is
 * bookkeeping outside any undo step: undoing the hide brings back the DM's
 * fog and not what it cleared.
 */
function forgetUnderHides(tx: Tx, scene: Scene, ops: FogOp[]): void {
  const hides = ops.filter((o) => o.mode === "hide");
  if (hides.length === 0) return;
  const changes = rasterizeFogOps(tx.state.exploredTiles, scene.id, scene.bounds, hides);
  for (const key of Object.keys(changes).sort()) {
    const tile = changes[key];
    if (tile === undefined) continue;
    const [tx_, ty] = key.slice(scene.id.length + 1).split(",").map(Number) as [number, number];
    tx.writeBookkeeping(keys.explored(scene.id, tx_, ty), tile);
  }
}

/** Takes away every explored tile of the scene, as bookkeeping: a reset to hidden, or the scene going. */
export function forgetExplored(tx: Tx, sceneId: string): void {
  for (const key of Object.keys(tx.state.exploredTiles).sort()) {
    const tile = tx.state.exploredTiles[key]!;
    if (tile.sceneId === sceneId) tx.writeBookkeeping(keys.explored(sceneId, tile.tx, tile.ty), null);
  }
}

/**
 * What the party saw that the explored layer lacked (section 4.3.3). The
 * bits only ever add: each tile becomes the stored bits joined with what it
 * held, so a replay writes the same layer the live run did, and nothing
 * here ever computes sight. A tile is one of the scene's, inside its bounds.
 */
export function sysExplore(tx: Tx, op: OpOf<"sys.explore">): void {
  const scene = tx.scene(op.sceneId);
  const across = tilesAcross(scene.bounds.w);
  const down = tilesAcross(scene.bounds.h);
  for (const t of op.tiles) {
    if (t.tx >= across || t.ty >= down) throw invalid("explored tile outside the scene");
    const bits = decodeTile(t.bits);
    if (!bits) throw invalid("explored tile is not a tile of bits");
    const held = tx.state.exploredTiles[tileKey(scene.id, t.tx, t.ty)];
    const was = held ? decodeTile(held.bits) : null;
    const next = new Uint8Array(bits);
    if (was) for (let i = 0; i < next.length; i++) next[i] = next[i]! | was[i]!;
    if (isEmptyBits(next)) continue;
    const encoded = encodeTile(next);
    if (held && held.bits === encoded) continue;
    tx.write(keys.explored(scene.id, t.tx, t.ty), { sceneId: scene.id, tx: t.tx, ty: t.ty, rev: held?.rev ?? 0, bits: encoded });
  }
}

export function fogPublish(tx: Tx, op: OpOf<"fog.publish">): void {
  const scene = tx.scene(op.sceneId);
  const draft = tx.state.fogDrafts[op.sceneId];
  if (!draft) throw invalid("nothing to publish");
  applyFogOps(tx, scene, draft.ops);
  tx.remove(keys.fogDraft(op.sceneId));
}

export function fogDiscard(tx: Tx, op: OpOf<"fog.discard">): void {
  tx.scene(op.sceneId);
  if (tx.state.fogDrafts[op.sceneId]) tx.remove(keys.fogDraft(op.sceneId));
}

export function fogLive(tx: Tx, op: OpOf<"fog.live">): void {
  applyFogOps(tx, tx.scene(op.sceneId), op.ops);
}

export function fogReset(tx: Tx, op: OpOf<"fog.reset">): void {
  const scene = tx.scene(op.sceneId);
  if (op.to === "hidden") {
    for (const tile of Object.values(tx.state.fogTiles)) {
      if (tile.sceneId === scene.id) tx.remove(keys.fog(tile.sceneId, tile.tx, tile.ty));
    }
    // Players forget the whole scene too (section 4.3.3), outside the reset's undo step.
    forgetExplored(tx, scene.id);
    return;
  }
  for (const tile of allRevealedTiles(scene.id, scene.bounds)) {
    const existing = tx.state.fogTiles[tileKey(scene.id, tile.tx, tile.ty)];
    if (existing && existing.bits === tile.bits) continue;
    tx.write(keys.fog(scene.id, tile.tx, tile.ty), tile);
  }
}

// Builder (design 12).

type Cell = { x: number; y: number };

export function parseCell(key: string): Cell {
  const [xs, ys] = key.split(",");
  return { x: Number(xs), y: Number(ys) };
}

export function inBounds(scene: Scene, cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < scene.bounds.w && cell.y < scene.bounds.h;
}

export function emptyChunk(sceneId: string, cx: number, cy: number): BuildChunk {
  return { sceneId, cx, cy, rev: 0, cells: {}, edges: {} };
}

/**
 * Whether an edge key names an edge of the scene, its east and south
 * borders included (docs/design-v1-maps-vision.md 3.1): a west edge `x,y,w`
 * runs from x = 0 to the width, a north edge `x,y,n` from y = 0 to the
 * height. Every edge inside the scene was already allowed, so every stored
 * op still applies as it did.
 */
function edgeInBounds(scene: Scene, key: string): boolean {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (x < 0 || y < 0) return false;
  return side === "w" ? x <= scene.bounds.w && y < scene.bounds.h : x < scene.bounds.w && y <= scene.bounds.h;
}

/** A chunk with its free walls replaced, the field left out when none are left. */
function withWalls(chunk: BuildChunk, walls: FreeWall[]): BuildChunk {
  const { walls: _old, ...rest } = chunk;
  return walls.length > 0 ? { ...rest, walls } : rest;
}

/** Every build change can move a wall, so the rules caches keyed on the walls version drop it. */
function bumpWalls(tx: Tx, sceneId: string): void {
  tx.bumpWalls(sceneId);
}

type ChunkChange = { cx: number; cy: number; cells: Cell[]; edges: string[] };

/**
 * Groups cells by chunk and writes each chunk once. A chunk left with
 * nothing in it is removed.
 *
 * Erasing (a null terrain) clears everything in the cells, not only the
 * floor: the walls, doors, windows and "no wall" marks on all four sides of
 * each cell, and every label whose text covers part of one. Otherwise a
 * door would float in the rock, still block areas, and come back when the
 * floor is painted again. An edge on a cell's south or east side is filed
 * under the neighbor below or to the right, which may sit in another chunk.
 *
 * It also takes the free walls whose midpoint, and the stamps and lights
 * whose center, lie in an erased cell (docs/design-v1-maps-vision.md 2.2,
 * 3.5, 3.6). A free wall lives in its midpoint's chunk, which is the erased
 * cell's own.
 *
 * An edge on the scene's east or south border, which wave 3 lets the
 * builder draw, stays when the cell beside it is erased: erasing it would
 * change what a stored erase did on a scene shrunk since its edges were
 * drawn, and replay must give the same state. The wall tool and Clear
 * remove it.
 */
function setCells(tx: Tx, scene: Scene, cells: Cell[], terrain: TerrainId | null): void {
  const byChunk = new Map<string, ChunkChange>();
  const group = (x: number, y: number): ChunkChange => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const key = chunkKey(scene.id, cx, cy);
    let change = byChunk.get(key);
    if (!change) byChunk.set(key, (change = { cx, cy, cells: [], edges: [] }));
    return change;
  };
  for (const cell of cells) {
    if (!inBounds(scene, cell)) throw invalid("cell outside the scene");
    const own = group(cell.x, cell.y);
    own.cells.push(cell);
    if (terrain !== null) continue;
    own.edges.push(`${cell.x},${cell.y},n`, `${cell.x},${cell.y},w`);
    if (cell.y + 1 < scene.bounds.h) group(cell.x, cell.y + 1).edges.push(`${cell.x},${cell.y + 1},n`);
    if (cell.x + 1 < scene.bounds.w) group(cell.x + 1, cell.y).edges.push(`${cell.x + 1},${cell.y},w`);
  }
  // Erasing takes the cells' heights, so the tokens standing on that ground land on what is left (landOnGround).
  const standing = terrain === null ? standingOn(tx, scene.id, new Set(cells.map((c) => `${c.x},${c.y}`))) : [];
  for (const key of [...byChunk.keys()].sort()) {
    const change = byChunk.get(key)!;
    const chunk = tx.state.buildChunks[key] ?? emptyChunk(scene.id, change.cx, change.cy);
    const nextCells = { ...chunk.cells };
    for (const cell of change.cells) {
      const id = `${cell.x},${cell.y}`;
      if (terrain === null) delete nextCells[id];
      else nextCells[id] = terrain;
    }
    let edges = chunk.edges;
    for (const id of change.edges) {
      if (!(id in edges)) continue;
      if (edges === chunk.edges) edges = { ...chunk.edges };
      delete edges[id];
    }
    // A chunk reached only for an edge on a neighbor's side is written only when it lost one.
    if (change.cells.length === 0 && edges === chunk.edges) continue;
    let next: BuildChunk = { ...chunk, cells: nextCells, edges };
    if (terrain === null && chunk.walls) {
      const erased = new Set(change.cells.map((c) => `${c.x},${c.y}`));
      next = withWalls(next, chunk.walls.filter((w) => !erased.has(cellOf(...wallMidpoint(w)))));
    }
    if (terrain === null) next = withoutHeights(next, change.cells);
    writeChunk(tx, next);
  }
  if (terrain === null) {
    landOnGround(tx, standing);
    eraseLabels(tx, scene.id, cells);
    eraseByCenter(tx, scene.id, cells);
  }
}

/**
 * The tokens on a scene standing on the ground of some cells, all of the
 * scene's when `cells` is null: their elevation equals the ground under
 * their footprint (rules/heights.ts), the squeezed one while they squeeze.
 * Asked before an op changes the ground, so landOnGround can set them on
 * what the op leaves. A scene holds at most 500 tokens, which bounds it.
 */
export function standingOn(tx: Tx, sceneId: string, cells: ReadonlySet<string> | null): Token[] {
  const out: Token[] = [];
  for (const token of sortedById(Object.values(tx.state.tokens))) {
    if (token.sceneId !== sceneId) continue;
    if (cells && !occupiedCells(token).some((c) => cells.has(`${c.x},${c.y}`))) continue;
    if (token.elevation === footprintGround(tx.state.buildChunks, token)) out.push(token);
  }
  return out;
}

/**
 * Tokens that stood on the ground, set on the ground under them now, in
 * the same op as the change of ground (docs/design-v1-maps-vision.md 4.2):
 * a height paint, an erase or a clear. Nobody ends up inside a ledge or
 * hanging in the air over cleared ground, which would draw a flight shadow
 * and let the token pass ledges as a flier. A landing, not a move, so it
 * adds no leg to a path. The op's undo puts the tokens back with the
 * ground, and refuses if one of them changed since, as any restore does.
 */
export function landOnGround(tx: Tx, standing: readonly Token[]): void {
  for (const was of standing) {
    const token = tx.token(was.id);
    const ground = footprintGround(tx.state.buildChunks, token);
    if (ground !== token.elevation) tx.write(keys.token(token.id), { ...token, elevation: ground });
  }
}

/**
 * A chunk with the heights and stair marks of these cells cleared (wave 4,
 * section 4.2), as erase clears everything else in them. A chunk from
 * before wave 4 has neither, so a stored erase replays as it did.
 */
function withoutHeights(chunk: BuildChunk, cells: readonly Cell[]): BuildChunk {
  if (chunk.heights === undefined && chunk.up === undefined) return chunk;
  const heights = decodeHeights(chunk.heights);
  const marks = decodeStairs(chunk.up);
  for (const c of cells) {
    const i = cellIndex(chunk, c.x, c.y);
    heights[i] = 0;
    marks[i] = ".";
  }
  return withHeightFields(chunk, encodeHeights(heights), encodeStairs(marks));
}

/** A chunk with its heights and stair marks replaced, each field left out when it holds nothing. */
export function withHeightFields(chunk: BuildChunk, heights: string | undefined, up: string | undefined): BuildChunk {
  const { heights: _heights, up: _up, ...rest } = chunk;
  const out: BuildChunk = rest;
  if (heights !== undefined) out.heights = heights;
  if (up !== undefined) out.up = up;
  return out;
}

/** Removes the stamps and lights whose center lies in one of the cells. */
function eraseByCenter(tx: Tx, sceneId: string, cells: Cell[]): void {
  const erased = new Set(cells.map((c) => `${c.x},${c.y}`));
  for (const stamp of sortedById(Object.values(tx.state.stamps))) {
    if (stamp.sceneId === sceneId && erased.has(cellOf(stamp.x, stamp.y))) tx.remove(keys.stamp(stamp.id));
  }
  for (const light of sortedById(Object.values(tx.state.lights))) {
    if (light.sceneId === sceneId && erased.has(cellOf(light.x, light.y))) tx.remove(keys.light(light.id));
  }
}

/**
 * Removes the labels whose text covers any part of the cells, wherever their
 * anchor sits. Each label's box is tested against the erased cells, at most
 * 2,000 per op, so the work stays bounded however large a label is. The box
 * around all the cells first skips every label nowhere near them.
 */
function eraseLabels(tx: Tx, sceneId: string, cells: Cell[]): void {
  if (cells.length === 0) return;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const c of cells) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + 1);
    y1 = Math.max(y1, c.y + 1);
  }
  const erased: string[] = [];
  for (const [id, label] of Object.entries(tx.state.labels)) {
    if (label.sceneId !== sceneId) continue;
    const box = labelBox(label);
    if (box.x1 <= x0 || box.x0 >= x1 || box.y1 <= y0 || box.y0 >= y1) continue;
    if (cells.some((c) => boxTouchesCell(box, c.x, c.y))) erased.push(id);
  }
  for (const id of erased.sort()) tx.remove(keys.label(id));
}

/** Writes a chunk, or removes it when nothing is left in it: no floor, edges, free walls, heights or stairs. */
export function writeChunk(tx: Tx, chunk: BuildChunk): void {
  const empty =
    Object.keys(chunk.cells).length === 0 &&
    Object.keys(chunk.edges).length === 0 &&
    (chunk.walls?.length ?? 0) === 0 &&
    chunk.heights === undefined &&
    chunk.up === undefined;
  if (empty) {
    if (tx.state.buildChunks[chunkKey(chunk.sceneId, chunk.cx, chunk.cy)]) tx.remove(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy));
    return;
  }
  tx.write(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy), chunk);
}

export function buildPaint(tx: Tx, op: OpOf<"build.paint">): void {
  setCells(tx, tx.scene(op.sceneId), op.cells.map(parseCell), op.terrain);
  bumpWalls(tx, op.sceneId);
}

export function buildErase(tx: Tx, op: OpOf<"build.erase">): void {
  setCells(tx, tx.scene(op.sceneId), op.cells.map(parseCell), null);
  bumpWalls(tx, op.sceneId);
}

export function buildRect(tx: Tx, op: OpOf<"build.rect">): void {
  const scene = tx.scene(op.sceneId);
  if (op.w * op.h > MAX_BUILD_CELLS) throw new Refuse("quota", `at most ${MAX_BUILD_CELLS} cells per op`);
  const cells: Cell[] = [];
  for (let y = op.y; y < op.y + op.h; y++) for (let x = op.x; x < op.x + op.w; x++) cells.push({ x, y });
  setCells(tx, scene, cells, op.terrain);
  bumpWalls(tx, scene.id);
}

/** Cells whose centers lie inside the polygon, in the same fixed point as the fog so both agree on edges. */
export function buildPoly(tx: Tx, op: OpOf<"build.poly">): void {
  const scene = tx.scene(op.sceneId);
  const pts = op.points.map((v) => Math.round(v * 8));
  const n = Math.floor(pts.length / 2);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[2 * i]!);
    maxX = Math.max(maxX, pts[2 * i]!);
    minY = Math.min(minY, pts[2 * i + 1]!);
    maxY = Math.max(maxY, pts[2 * i + 1]!);
  }
  const x0 = Math.max(0, Math.floor(minX / 8));
  const y0 = Math.max(0, Math.floor(minY / 8));
  const x1 = Math.min(scene.bounds.w, Math.ceil(maxX / 8));
  const y1 = Math.min(scene.bounds.h, Math.ceil(maxY / 8));
  const cells: Cell[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (pointInPolygonFixed(pts, n, x * 8 + 4, y * 8 + 4)) cells.push({ x, y });
      if (cells.length > MAX_BUILD_CELLS) throw new Refuse("quota", `at most ${MAX_BUILD_CELLS} cells per op`);
    }
  }
  setCells(tx, scene, cells, op.terrain);
  bumpWalls(tx, scene.id);
}

export function buildEdge(tx: Tx, op: OpOf<"build.edge">): void {
  const scene = tx.scene(op.sceneId);
  const byChunk = new Map<string, OpOf<"build.edge">["edges"]>();
  for (const edge of op.edges) {
    if (!edgeInBounds(scene, edge.key)) throw invalid("edge outside the scene");
    const [xs, ys] = edge.key.split(",");
    const cell = { x: Number(xs), y: Number(ys) };
    const key = chunkKey(scene.id, Math.floor(cell.x / CHUNK_CELLS), Math.floor(cell.y / CHUNK_CELLS));
    const list = byChunk.get(key);
    if (list) list.push(edge);
    else byChunk.set(key, [edge]);
  }
  for (const key of [...byChunk.keys()].sort()) {
    const group = byChunk.get(key)!;
    const first = parseCell(group[0]!.key);
    const cx = Math.floor(first.x / CHUNK_CELLS);
    const cy = Math.floor(first.y / CHUNK_CELLS);
    const chunk = tx.state.buildChunks[key] ?? emptyChunk(scene.id, cx, cy);
    const edges = { ...chunk.edges };
    for (const edge of group) {
      if (edge.feature === null) delete edges[edge.key];
      else edges[edge.key] = edge.feature;
    }
    writeChunk(tx, { ...chunk, edges });
  }
  bumpWalls(tx, scene.id);
}

export function buildLabel(tx: Tx, op: OpOf<"build.label">): void {
  tx.scene(op.sceneId);
  const existing = tx.state.labels[op.labelId];
  if (op.label === null) {
    if (existing) tx.remove(keys.label(op.labelId));
    return;
  }
  if (existing && existing.sceneId !== op.sceneId) throw invalid("label belongs to another scene");
  const label: Label = { id: op.labelId, rev: existing?.rev ?? 0, sceneId: op.sceneId, ...op.label };
  tx.write(keys.label(label.id), label);
}

/** Removes the scene's whole build: floor, walls free or not, labels, stamps and lights. */
export function buildClear(tx: Tx, op: OpOf<"build.clear">): void {
  const scene = tx.scene(op.sceneId);
  const standing = standingOn(tx, scene.id, null);
  for (const key of Object.keys(tx.state.buildChunks).sort()) {
    const chunk = tx.state.buildChunks[key]!;
    if (chunk.sceneId === scene.id) tx.remove(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy));
  }
  landOnGround(tx, standing);
  for (const id of Object.keys(tx.state.labels).sort()) {
    if (tx.state.labels[id]!.sceneId === scene.id) tx.remove(keys.label(id));
  }
  for (const id of Object.keys(tx.state.stamps).sort()) {
    if (tx.state.stamps[id]!.sceneId === scene.id) tx.remove(keys.stamp(id));
  }
  for (const id of Object.keys(tx.state.lights).sort()) {
    if (tx.state.lights[id]!.sceneId === scene.id) tx.remove(keys.light(id));
  }
  bumpWalls(tx, scene.id);
}

/**
 * Free walls (docs/design-v1-maps-vision.md 2.2). Removals apply first,
 * each naming its chunk, then each put lands in its midpoint's chunk and
 * replaces a wall of the same id there. Ends must lie in the scene, its
 * border included. The protocol already holds them to the 1/64 lattice and
 * 8 cells, and the room limits count them per scene.
 */
export function buildWalls(tx: Tx, op: OpOf<"build.walls">): void {
  const scene = tx.scene(op.sceneId);
  // Only the chunks whose walls change are written.
  const lists = new Map<string, { cx: number; cy: number; walls: FreeWall[] }>();
  const listOf = (cx: number, cy: number) => {
    const key = chunkKey(scene.id, cx, cy);
    let entry = lists.get(key);
    if (!entry) lists.set(key, (entry = { cx, cy, walls: [...(tx.state.buildChunks[key]?.walls ?? [])] }));
    return entry.walls;
  };
  for (const r of op.remove ?? []) {
    if (!tx.state.buildChunks[chunkKey(scene.id, r.cx, r.cy)]?.walls?.some((w) => w.id === r.id)) continue;
    const walls = listOf(r.cx, r.cy);
    const i = walls.findIndex((w) => w.id === r.id);
    if (i >= 0) walls.splice(i, 1);
  }
  const placed = new Set<string>();
  const onScene = (p: readonly [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= scene.bounds.w && p[1] <= scene.bounds.h;
  for (const input of op.put ?? []) {
    if (!onScene(input.a) || !onScene(input.b)) throw invalid("wall outside the scene");
    const { cx, cy } = wallChunk(input);
    const where = `${cx},${cy},${input.id}`;
    if (placed.has(where)) throw invalid("a wall appears twice");
    placed.add(where);
    const wall: FreeWall = { id: input.id, a: [input.a[0], input.a[1]], b: [input.b[0], input.b[1]], f: input.f };
    const walls = listOf(cx, cy);
    const i = walls.findIndex((w) => w.id === wall.id);
    if (i >= 0) walls[i] = wall;
    else walls.push(wall);
  }
  for (const key of [...lists.keys()].sort()) {
    const { cx, cy, walls } = lists.get(key)!;
    writeChunk(tx, withWalls(tx.state.buildChunks[key] ?? emptyChunk(scene.id, cx, cy), walls));
  }
  bumpWalls(tx, scene.id);
}

/**
 * Stamps (section 3.5). Removals apply first, then each put creates a
 * stamp or replaces the one of its id. A stamp stays on its scene: an id
 * that names one elsewhere is refused, as a label's is.
 */
export function buildStamps(tx: Tx, op: OpOf<"build.stamps">): void {
  const scene = tx.scene(op.sceneId);
  for (const id of op.remove ?? []) {
    const stamp = tx.state.stamps[id];
    if (!stamp) continue;
    if (stamp.sceneId !== scene.id) throw invalid("stamp belongs to another scene");
    tx.remove(keys.stamp(id));
  }
  const seen = new Set<string>();
  for (const input of op.put ?? []) {
    if (seen.has(input.id)) throw invalid("a stamp appears twice");
    seen.add(input.id);
    const existing = tx.state.stamps[input.id];
    if (existing && existing.sceneId !== scene.id) throw invalid("stamp belongs to another scene");
    const stamp: Stamp = { ...input, rev: existing?.rev ?? 0, sceneId: scene.id };
    tx.write(keys.stamp(stamp.id), stamp);
  }
}

/**
 * Lights (section 3.6), DM only in every wave. As stamps, plus each light
 * must stand in the scene, border included, since sight places it there.
 */
export function buildLights(tx: Tx, op: OpOf<"build.lights">): void {
  const scene = tx.scene(op.sceneId);
  for (const id of op.remove ?? []) {
    const light = tx.state.lights[id];
    if (!light) continue;
    if (light.sceneId !== scene.id) throw invalid("light belongs to another scene");
    tx.remove(keys.light(id));
  }
  const seen = new Set<string>();
  for (const input of op.put ?? []) {
    if (seen.has(input.id)) throw invalid("a light appears twice");
    seen.add(input.id);
    if (input.x > scene.bounds.w || input.y > scene.bounds.h) throw invalid("light outside the scene");
    const existing = tx.state.lights[input.id];
    if (existing && existing.sceneId !== scene.id) throw invalid("light belongs to another scene");
    const light: Light = { ...input, rev: existing?.rev ?? 0, sceneId: scene.id };
    tx.write(keys.light(light.id), light);
  }
}

/**
 * One door's state (docs/design-v1-maps-vision.md 4.1): open, closed or
 * locked, and for a secret door, found or hidden again. It writes only that
 * door, in its chunk, so a player's tap and its second tap need no undo,
 * and the walls version moves as for any build change. Who may set what is
 * shared/permissions.ts's.
 */
export function doorSet(tx: Tx, op: OpOf<"door.set">): void {
  const scene = tx.scene(op.sceneId);
  const { cx, cy } = doorChunk(op.door);
  const chunk = tx.state.buildChunks[chunkKey(scene.id, cx, cy)];
  const set = (f: WallFeature): WallFeature | null => {
    if (f.kind !== "door") return null;
    const next = { ...f, state: op.state, discovered: op.found ?? f.discovered };
    return next.state === f.state && next.discovered === f.discovered ? f : next;
  };
  if ("edge" in op.door) {
    const edge = op.door.edge;
    const feature = chunk?.edges[edge];
    const next = feature && feature.kind !== "none" ? set(feature) : null;
    if (!chunk || !next) throw gone("door");
    if (next === feature) return;
    writeChunk(tx, { ...chunk, edges: { ...chunk.edges, [edge]: next } });
  } else {
    const id = op.door.id;
    const wall = chunk?.walls?.find((w) => w.id === id);
    const next = wall ? set(wall.f) : null;
    if (!chunk || !wall || !next) throw gone("door");
    if (next === wall.f) return;
    writeChunk(tx, withWalls(chunk, (chunk.walls ?? []).map((w) => (w.id === id ? { ...w, f: next } : w))));
  }
  bumpWalls(tx, scene.id);
}
