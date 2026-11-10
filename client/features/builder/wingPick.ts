import { sightOf, tileKey } from "#shared/keys.ts";
import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type CellRect, type EdgeFeature, type FreeWall, type RoomState, type Scene, type WallFeature } from "#shared/model.ts";
import { autoWallBetween, autoWallsOf, FLOOR_TERRAINS } from "#shared/rules/autoWalls.ts";
import { decodeTile, TILE_SUB } from "#shared/rules/fog.ts";
import { playersSee } from "#shared/rules/floors.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { chunkHeights, chunkMarks, groundAt, markIn } from "#shared/rules/heights.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexKey, hexNeighbors, hexSubcells, parseHexKey, sameHex, sceneHexSpan, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { seenFogBits } from "#shared/rules/vision.ts";
import { deriveWalls, floodHexRoom, indexBuild, sceneChunks } from "#shared/rules/walls.ts";
import type { JoinExpect } from "#shared/rules/wingClear.ts";
import type { WingBase } from "../dungeon/plan.ts";
import { distance, TAP_SLOP_PX } from "../../lib/gestures.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../tools.ts";
import { edgeDistance, edgeInBounds, nearestEdge, nearestFreeWall, type Bounds, type Point } from "./cells.ts";
import { builderSlot, type WingPicks } from "./store.ts";
import { ghostRoomAt } from "./wingGhost.ts";

/*
 * Add a wing's picks (docs/design: dungeon generator phase 3, 3.1 and 3.2,
 * D-261110-091 to 093, 162, 163, 179, 244 and 245): the area dragged over
 * the map and the wall the wing joins, judged as the planner and the
 * server will read them. Plain functions over the room, so node --test
 * reads them. The planner (dungeon/wing.ts) plans inside the area from the
 * join this finds, and the asks carry its `expect`.
 *
 * An area is a rectangle of the scene's own keys: cells on squares, hex
 * keys (a column and a row) on hexes, as a trap's zone is.
 */

/** An area's least and greatest side, in keys: room for two rooms, and the generator's largest map. */
export const WING_MIN_SIDE = 12;
export const WING_MAX_SIDE = 100;
/** How far from a wall a tap still picks it: half a 44 px touch target. */
export const WING_REACH_PX = 22;

export const WING_OFF = "Automatic walls are off on this scene, so a wing would stand without walls. Turn them on in Map and grid to add one.";
export const WING_TAP = "Tap the wall the wing joins.";
export const WING_HEX_COVERS = "On hexes the wing's area must not cover walls or other build.";
export const WING_SIGHT = "The party can see part of the area or the wall it joins, so they see the wing appear there.";
export const WING_REVEALED = "Part of the area or the wall it joins is revealed to players, so they see the wing there at once.";

/** Why a wall cannot take a wing, in the words the builder's line shows. */
export const JOIN_WORDS = {
  squaresFree: "On squares the wing joins a wall on the grid lines.",
  squaresNone: "Tap a wall or door between floor and empty ground.",
  window: "A wing joins a wall or door, not a window.",
  hexLong: "On hexes the wing joins a wall or door exactly one hex side long.",
  hexBeyond: "Tap a wall with empty ground beyond it.",
  hexOpen: "That room is open somewhere else, so the wing cannot tell its inside. Tap a wall of a closed room.",
  wideSquares: "On Wide the wing joins a wall two squares long.",
  wideHex: "On Wide the wing joins three hex sides of wall that open two hexes onto two.",
  floorRaised: "The floor at that wall is raised or sunk, and stairs make no walls on this scene. Tap another wall.",
} as const;

/** The first line of the row: what to drag, and how large an area may be. */
export function dragHint(g: Grid): string {
  if (!isHex(g)) return `Drag the wing's area over empty ground, up to ${WING_MAX_SIDE} by ${WING_MAX_SIDE}.`;
  return g.orient === "rows"
    ? `Drag the wing's area over empty ground, up to ${WING_MAX_SIDE} hexes across and ${WING_MAX_SIDE} rows down.`
    : `Drag the wing's area over empty ground, up to ${WING_MAX_SIDE} columns across and ${WING_MAX_SIDE} hexes down.`;
}

/** An area's size in the scene's words, as grid/words.ts sizeWords counts a hex scene: "30 by 44 squares", "30 hexes across and 50 rows down". */
export function areaSize(g: Grid, area: Pick<CellRect, "w" | "h">): string {
  if (!isHex(g)) return `${area.w} by ${area.h} squares`;
  return g.orient === "rows" ? `${area.w} hexes across and ${area.h} rows down` : `${area.w} columns across and ${area.h} hexes down`;
}

/** The row's line once both are set. */
export function readyHint(g: Grid, area: CellRect): string {
  return `Area ${areaSize(g, area)}, joined at the ringed wall.`;
}

/** The pane's area line: on squares with its feet, "Area 30 by 44 squares (150 by 220 ft)". */
export function areaLine(g: Grid, area: CellRect, feetPerCell: number): string {
  return isHex(g) ? `Area ${areaSize(g, area)}` : `Area ${areaSize(g, area)} (${area.w * feetPerCell} by ${area.h * feetPerCell} ft)`;
}

/** Whether a scene can take a wing: one whose automatic walls are off cannot, since nothing would wall the wing's rooms in. */
export function wingOff(scene: Pick<Scene, "autoWalls">): string | null {
  return autoWallsOf(scene) === "off" ? WING_OFF : null;
}

// ------------------------------------------------------------ the area

/** The keys a scene's cells run over: its cells, or on hexes the columns and rows of its hex keys. */
function keySpan(g: Grid, bounds: Bounds): Bounds {
  if (!isHex(g)) return bounds;
  const span = sceneHexSpan(g, bounds);
  return { w: span.cols, h: span.rows };
}

function keyAt(g: Grid, p: Point, span: Bounds): [number, number] {
  const [x, y] = isHex(g) ? ((h) => [h.col, h.row])(hexAt(g, p)) : [Math.floor(p.x), Math.floor(p.y)];
  return [Math.max(0, Math.min(span.w - 1, x!)), Math.max(0, Math.min(span.h - 1, y!))];
}

/**
 * One side of a dragged area: from the key the drag began on toward the
 * one it is over, at least WING_MIN_SIDE long, growing the way the drag
 * went, and at most WING_MAX_SIDE, giving up its far end, so the area
 * never jumps off the key the drag began on. Kept on the scene, a scene
 * shorter than the least side giving all it has.
 */
function side(start: number, end: number, span: number): { at: number; length: number } {
  const back = end < start;
  const want = Math.abs(end - start) + 1;
  const length = Math.min(span, Math.max(WING_MIN_SIDE, Math.min(WING_MAX_SIDE, want)));
  const from = back ? start - length + 1 : start;
  return { at: Math.max(0, Math.min(span - length, from)), length };
}

/** The area a drag from one point to another draws (3.1): a rectangle of the scene's keys, 12 to 100 a side. */
export function areaBetween(g: Grid, from: Point, to: Point, bounds: Bounds): CellRect {
  const span = keySpan(g, bounds);
  const [ax, ay] = keyAt(g, from, span);
  const [bx, by] = keyAt(g, to, span);
  const x = side(ax, bx, span.w);
  const y = side(ay, by, span.h);
  return { x: x.at, y: y.at, w: x.length, h: y.length };
}

export function inArea(area: CellRect, x: number, y: number): boolean {
  return x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h;
}

/** A cell or edge key's first two numbers: "x,y" of a cell, "x,y,n" of an edge. */
function keyXY(key: string): [number, number] {
  const [x, y] = key.split(",");
  return [Number(x), Number(y)];
}

/**
 * What a hex area may not cover (3.1, D-261110-092): any wall, door or
 * window that runs through it, a height, stair or difficult ground mark on
 * one of its hexes, or a label, light or stamp standing in one. A wall
 * along the area's edge, with the area on one side only, is not covered.
 * The planner keeps clear of everything else, as it does on squares.
 */
export function hexAreaCovers(view: Pick<RoomState, "buildChunks" | "labels" | "lights" | "stamps">, scene: Pick<Scene, "id" | "bounds" | "gridShape">, area: CellRect): boolean {
  const g = sceneGrid(scene);
  if (!isHex(g)) return false;
  const holds = (p: Point) => {
    const h = hexAt(g, p);
    return inArea(area, h.col, h.row) && hexInScene(g, scene.bounds, h);
  };
  for (const chunk of sceneChunks(view.buildChunks, scene.id)) {
    for (const wall of chunk.walls ?? []) if (wallCrosses(wall, holds)) return true;
    const heights = chunkHeights(chunk);
    const marks = chunkMarks(chunk);
    const rough = chunk.rough;
    if (!heights && !marks && !rough) continue;
    for (let k = 0; k < CHUNK_CELLS * CHUNK_CELLS; k++) {
      const set = (heights?.[k] ?? 0) !== 0 || (marks?.[k] ?? ".") !== "." || (rough?.[k] ?? ".") !== ".";
      if (set && inArea(area, chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS), chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS))) return true;
    }
  }
  const standing = (things: Readonly<Record<string, { sceneId: string; x: number; y: number } | undefined>>) =>
    Object.values(things).some((t) => t !== undefined && t.sceneId === scene.id && holds(t));
  return standing(view.labels) || standing(view.lights) || standing(view.stamps);
}

/** Whether a wall runs through the hexes `holds` takes: some point along it has those hexes on both of its sides. */
function wallCrosses(wall: Pick<FreeWall, "a" | "b">, holds: (p: Point) => boolean): boolean {
  const dx = wall.b[0] - wall.a[0];
  const dy = wall.b[1] - wall.a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return false;
  // A hair either side, well inside a hex's least width, so a side's two hexes are told apart.
  const nx = (-dy / length) * 0.05;
  const ny = (dx / length) * 0.05;
  const steps = Math.max(2, Math.ceil(length * 4));
  for (let i = 1; i < steps; i++) {
    const x = wall.a[0] + (dx * i) / steps;
    const y = wall.a[1] + (dy * i) / steps;
    if (holds({ x: x + nx, y: y + ny }) && holds({ x: x - nx, y: y - ny })) return true;
  }
  return false;
}

/**
 * The outline of a hex area as the sides between its hexes on the scene
 * and those outside it, for the dashed line around it. A rectangle of hex
 * keys is no rectangle on the map.
 */
export function hexAreaOutline(g: HexGrid, area: CellRect, bounds: Bounds): [Point, Point][] {
  const out: [Point, Point][] = [];
  const holds = (h: Hex) => inArea(area, h.col, h.row) && hexInScene(g, bounds, h);
  for (let row = area.y; row < area.y + area.h; row++) {
    for (let col = area.x; col < area.x + area.w; col++) {
      const h = { col, row };
      if (!hexInScene(g, bounds, h)) continue;
      hexNeighbors(g, h).forEach((n, d) => {
        if (!holds(n)) out.push(sideEnds(g, h, d));
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ the join

/** The wall a tap picked: a grid edge on squares, a free wall by its chunk and id on hexes. */
export type WingTap = { grid: "squares"; key: string } | { grid: "hex"; cx: number; cy: number; id: string };

/** One leaf of a join: the cell inside it and the one outside, as scene keys, and its ends on the map. */
export type JoinLeaf = { inside: string; outside: string; a: Point; b: Point };

/** A join as judged: the tap, its leaves (one, or on Wide two on squares and three on hexes), and what the asks carry for the server's check. */
export type WingJoin = { tap: WingTap; leaves: JoinLeaf[]; expect: JoinExpect };

export type Judged<T> = { ok: true; value: T } | { ok: false; problem: string };

type View = Pick<RoomState, "buildChunks">;
type JoinScene = Pick<Scene, "id" | "bounds" | "gridShape" | "autoWalls">;

/**
 * What a tap at a point picks (3.1): on squares the nearest grid edge
 * within `reach` cells, or the line saying a free wall there will not do;
 * on hexes the nearest free wall within reach. Null where nothing is near.
 */
export function tapAt(view: View, scene: JoinScene, p: Point, reach: number): Judged<WingTap> | null {
  const chunks = sceneChunks(view.buildChunks, scene.id);
  const free = nearestFreeWall(chunks, p, reach);
  if (isHex(sceneGrid(scene))) return free ? { ok: true, value: { grid: "hex", cx: free.cx, cy: free.cy, id: free.wall.id } } : null;
  const key = nearestEdge(p, scene.bounds);
  const edge = key !== null && edgeDistance(key, p) <= reach ? key : null;
  if (free && (edge === null || free.distance < edgeDistance(edge, p))) return { ok: false, problem: JOIN_WORDS.squaresFree };
  return edge === null ? null : { ok: true, value: { grid: "squares", key: edge } };
}

/**
 * Judges a tapped wall as a join (3.2) for an area, Narrow or Wide. On
 * hexes the outside is found from the area, so a hex join waits for one
 * ("area"). A tapped hex wall that is gone ("gone") is dropped by the
 * caller, as another device may have erased it.
 */
export function judgeJoin(view: View, scene: JoinScene, tap: WingTap, area: CellRect | null, wide: boolean): Judged<WingJoin> | { ok: "area" } | { ok: "gone" } {
  if (tap.grid === "squares") return squareJoin(view, scene, tap, wide);
  const g = sceneGrid(scene);
  if (!isHex(g)) return { ok: "gone" };
  return hexJoin(view, scene, g, tap, area, wide);
}

// ---------------------------------------------- squares

/** The two cells either side of a grid edge: below or right of its line, then above or left. */
function edgeCells(key: string): [[number, number], [number, number]] {
  const [xs, ys, s] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  return s === "n" ? [[x, y], [x, y - 1]] : [[x, y], [x - 1, y]];
}

function chunkAt(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, x: number, y: number): BuildChunk | undefined {
  return x < 0 || y < 0 ? undefined : chunks[`${sceneId}:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`];
}

/** A cell as a join sees it: floor (a floor terrain with no stair mark), empty, or anything else. */
function cellKind(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, x: number, y: number): "floor" | "empty" | "other" {
  const chunk = chunkAt(chunks, sceneId, x, y);
  const terrain = chunk?.cells[`${x},${y}`];
  if (terrain === undefined) return markIn(chunk, x, y) === "." ? "empty" : "other";
  return FLOOR_TERRAINS.has(terrain) && markIn(chunk, x, y) === "." ? "floor" : "other";
}

/**
 * Whether a grid edge can be a join: floor one side, unpainted ground the
 * other, and a wall there, automatic or drawn, or a door. Its leaf, or the
 * line saying why not.
 */
function squareLeaf(view: View, scene: JoinScene, key: string): Judged<{ leaf: JoinLeaf; feature: EdgeFeature | null; ground: number }> {
  if (!edgeInBounds(key, scene.bounds)) return { ok: false, problem: JOIN_WORDS.squaresNone };
  const chunks = view.buildChunks;
  const [one, two] = edgeCells(key);
  const kinds = [cellKind(chunks, scene.id, ...one), cellKind(chunks, scene.id, ...two)];
  const insideAt = kinds[0] === "floor" && kinds[1] === "empty" ? 0 : kinds[1] === "floor" && kinds[0] === "empty" ? 1 : -1;
  const [x, y] = keyXY(key);
  const feature = chunkAt(chunks, scene.id, x, y)?.edges[key] ?? null;
  if (feature?.kind === "window") return { ok: false, problem: JOIN_WORDS.window };
  if (insideAt < 0) return { ok: false, problem: JOIN_WORDS.squaresNone };
  const walled = feature === null ? autoWallBetween(autoWallsOf(scene), "floor", "empty") : feature.kind === "wall" || feature.kind === "door";
  if (!walled) return { ok: false, problem: JOIN_WORDS.squaresNone };
  const inside = insideAt === 0 ? one : two;
  const outside = insideAt === 0 ? two : one;
  const [xs, ys, s] = key.split(",");
  const a = { x: Number(xs), y: Number(ys) };
  const b = s === "n" ? { x: a.x + 1, y: a.y } : { x: a.x, y: a.y + 1 };
  return { ok: true, value: { leaf: { inside: `${inside[0]},${inside[1]}`, outside: `${outside[0]},${outside[1]}`, a, b }, feature, ground: groundAt(chunks, scene.id, inside[0], inside[1]) } };
}

/**
 * The edge beside a join's along its wall line: to the right as seen from
 * outside first, then to the left (3.2, D-261110-179). Facing a north edge
 * from below, right is east, and from above it is west.
 */
function besideEdges(key: string, insideBelowOrRight: boolean): [string, string] {
  const [xs, ys, s] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (s === "n") {
    const west = `${x - 1},${y},n`;
    const east = `${x + 1},${y},n`;
    // Inside below: the outside is above, facing south, with west on the right.
    return insideBelowOrRight ? [west, east] : [east, west];
  }
  const north = `${x},${y - 1},w`;
  const south = `${x},${y + 1},w`;
  // Inside right: the outside is left, facing east, with south on the right.
  return insideBelowOrRight ? [south, north] : [north, south];
}

function squareJoin(view: View, scene: JoinScene, tap: Extract<WingTap, { grid: "squares" }>, wide: boolean): Judged<WingJoin> {
  const first = squareLeaf(view, scene, tap.key);
  if (!first.ok) return first;
  const picked = [{ key: tap.key, ...first.value }];
  if (wide) {
    const inward = insideFirst(first.value.leaf, tap.key);
    const next = besideEdges(tap.key, inward)
      .map((key) => ({ key, judged: squareLeaf(view, scene, key) }))
      .find((e) => e.judged.ok && insideFirst(e.judged.value.leaf, e.key) === inward);
    if (!next?.judged.ok) return { ok: false, problem: JOIN_WORDS.wideSquares };
    picked.push({ key: next.key, ...next.judged.value });
  }
  // On a scene whose walls follow floor terrain a stair mark makes no wall, so a run at the join would open onto the rock (D-261110-244).
  if (autoWallsOf(scene) === "floor" && picked.some((p) => p.ground !== 0)) return { ok: false, problem: JOIN_WORDS.floorRaised };
  // Along the line, west or north first, so a join reads the same whichever edge was tapped.
  picked.sort((p, q) => (p.leaf.a.x - q.leaf.a.x) || (p.leaf.a.y - q.leaf.a.y));
  return {
    ok: true,
    value: {
      tap,
      leaves: picked.map((p) => p.leaf),
      expect: { grid: "squares", edges: picked.map((p) => ({ key: p.key, feature: p.feature, ground: p.ground })) },
    },
  };
}

/** Whether a leaf's inside is the cell below or right of its edge's line, the cell its key names, so two leaves along one line can be held to one inside. */
function insideFirst(leaf: JoinLeaf, key: string): boolean {
  const [ix, iy] = keyXY(leaf.inside);
  const [ex, ey] = keyXY(key);
  return ix === ex && iy === ey;
}

// ---------------------------------------------- hexes

/** The side of a hex toward its neighbor in direction d, from corner d+1 to d+2 (walls.ts hexSideEnds). */
export function sideEnds(g: HexGrid, h: Hex, d: number): [Point, Point] {
  const corners = hexCorners(g, h);
  return [cornerAt(g, corners[(d + 1) % 6]!), cornerAt(g, corners[(d + 2) % 6]!)];
}

const samePoint = (p: Point, q: readonly [number, number]) => p.x === q[0] && p.y === q[1];

/** The two hexes a wall exactly one hex side long lies between, or null for any other wall. Corners sit on the 1/64 lattice, as a snapped wall's ends do, so they compare exactly. */
export function sideOf(g: HexGrid, wall: Pick<FreeWall, "a" | "b">): [Hex, Hex] | null {
  const mid = { x: (wall.a[0] + wall.b[0]) / 2, y: (wall.a[1] + wall.b[1]) / 2 };
  const near = hexAt(g, mid);
  for (const h of [near, ...hexNeighbors(g, near)]) {
    const around = hexNeighbors(g, h);
    for (let d = 0; d < 6; d++) {
      const [p, q] = sideEnds(g, h, d);
      if ((samePoint(p, wall.a) && samePoint(q, wall.b)) || (samePoint(p, wall.b) && samePoint(q, wall.a))) return [h, around[d]!];
    }
  }
  return null;
}

/** The scene's one-side walls and doors, by the two hexes each lies between, both ways round. Windows are left out, as no join stands on one. */
function sideWalls(g: HexGrid, chunks: readonly BuildChunk[]): Map<string, { wall: FreeWall; cx: number; cy: number }> {
  const out = new Map<string, { wall: FreeWall; cx: number; cy: number }>();
  for (const chunk of chunks) {
    for (const wall of chunk.walls ?? []) {
      if (wall.f.kind === "window") continue;
      const pair = sideOf(g, wall);
      if (!pair) continue;
      out.set(`${hexKey(pair[0])}|${hexKey(pair[1])}`, { wall, cx: chunk.cx, cy: chunk.cy });
      out.set(`${hexKey(pair[1])}|${hexKey(pair[0])}`, { wall, cx: chunk.cx, cy: chunk.cy });
    }
  }
  return out;
}

/**
 * The planning flood's regions (3.4): `floodHexRoom`'s step rule over a
 * copy of the scene's walls with every door and window read as a wall, so
 * an open door bounds a room as a closed one does.
 */
function planningFlood(scene: JoinScene, g: HexGrid, chunks: readonly BuildChunk[]): (from: Hex) => Set<string> {
  const closed = chunks.map((c) => (c.walls ? { ...c, walls: c.walls.map((w) => (w.f.kind === "wall" ? w : { ...w, f: { kind: "wall" as const } })) } : c));
  const walls = deriveWalls(indexBuild(closed), "wing-flood", { rule: autoWallsOf(scene), bounds: scene.bounds, grid: g });
  const memo = new Map<string, Set<string>>();
  return (from) => {
    const key = hexKey(from);
    for (const region of memo.values()) if (region.has(key)) return region;
    const region = new Set(floodHexRoom(walls, g, scene.bounds, hexCenter(g, from)).cells);
    memo.set(key, region);
    return region;
  };
}

function reaches(region: ReadonlySet<string>, area: CellRect): boolean {
  for (const key of region) {
    const h = parseHexKey(key);
    if (h && inArea(area, h.col, h.row)) return true;
  }
  return false;
}

/** The two hexes next to both of two neighbors. */
function commonNeighbors(g: HexGrid, a: Hex, b: Hex): Hex[] {
  const around = hexNeighbors(g, b);
  return hexNeighbors(g, a).filter((n) => around.some((m) => sameHex(m, n)));
}

function hexJoin(view: View, scene: JoinScene, g: HexGrid, tap: Extract<WingTap, { grid: "hex" }>, area: CellRect | null, wide: boolean): Judged<WingJoin> | { ok: "area" } | { ok: "gone" } {
  const chunks = sceneChunks(view.buildChunks, scene.id);
  const tapped = chunks.find((c) => c.cx === tap.cx && c.cy === tap.cy)?.walls?.find((w) => w.id === tap.id);
  if (!tapped) return { ok: "gone" };
  if (tapped.f.kind === "window") return { ok: false, problem: JOIN_WORDS.window };
  const pair = sideOf(g, tapped);
  if (!pair) return { ok: false, problem: JOIN_WORDS.hexLong };
  if (area === null) return { ok: "area" };
  const [p, q] = pair;
  if (!hexInScene(g, scene.bounds, p) || !hexInScene(g, scene.bounds, q)) return { ok: false, problem: JOIN_WORDS.hexBeyond };
  const region = planningFlood(scene, g, chunks);
  const fromP = region(p);
  const fromQ = region(q);
  const pReaches = reaches(fromP, area);
  const qReaches = reaches(fromQ, area);
  // One region on both sides, or both sides reaching the area, leave no inside to tell (3.2).
  if (fromP.has(hexKey(q)) || (pReaches && qReaches)) return { ok: false, problem: JOIN_WORDS.hexOpen };
  if (!pReaches && !qReaches) return { ok: false, problem: JOIN_WORDS.hexBeyond };
  const [inside, outside] = pReaches ? [q, p] : [p, q];
  const insideRegion = region(inside);
  const outsideRegion = region(outside);
  const walls = sideWalls(g, chunks);
  const leafOf = (i: Hex, o: Hex): { leaf: JoinLeaf; ref: { wall: FreeWall; cx: number; cy: number } } | null => {
    const ref = walls.get(`${hexKey(i)}|${hexKey(o)}`);
    if (!ref) return null;
    return { leaf: { inside: hexKey(i), outside: hexKey(o), a: { x: ref.wall.a[0], y: ref.wall.a[1] }, b: { x: ref.wall.b[0], y: ref.wall.b[1] } }, ref };
  };
  let picked: { leaf: JoinLeaf; ref: { wall: FreeWall; cx: number; cy: number } }[] = [leafOf(inside, outside)!];
  if (wide) {
    const found = wideHexJoin(g, inside, outside, (h) => insideRegion.has(hexKey(h)), (h) => outsideRegion.has(hexKey(h)), leafOf);
    if (!found) return { ok: false, problem: JOIN_WORDS.wideHex };
    picked = found;
  }
  const ground = groundAt(view.buildChunks, scene.id, inside.col, inside.row);
  return {
    ok: true,
    value: {
      tap,
      leaves: picked.map((p) => p.leaf),
      expect: { grid: "hex", walls: picked.map(({ ref }) => ({ cx: ref.cx, cy: ref.cy, id: ref.wall.id, a: [ref.wall.a[0], ref.wall.a[1]] as [number, number], b: [ref.wall.b[0], ref.wall.b[1]] as [number, number], f: ref.wall.f as WallFeature })), ground },
    },
  };
}

/**
 * A Wide hex join (3.2, H8): three one-side walls in a row between exactly
 * two inside hexes and two outside hexes, the planner's own Wide doorway.
 * Two neighbors share exactly two neighbors of their own, so the four hexes
 * are the tapped side's two and one of those. With the tapped side in the
 * middle, its two shared neighbors are one inside and one outside. As
 * the first or last side, one shared neighbor joins the inside or the
 * outside, and the fourth hex is the one it shares with the far hex. The
 * middle is tried first, then each end in neighbor order.
 */
function wideHexJoin<L>(g: HexGrid, i: Hex, o: Hex, isIn: (h: Hex) => boolean, isOut: (h: Hex) => boolean, leafOf: (i: Hex, o: Hex) => L | null): L[] | null {
  const shared = commonNeighbors(g, i, o);
  const three = (pairs: [Hex, Hex][]): L[] | null => {
    const leaves = pairs.map(([a, b]) => leafOf(a, b));
    return leaves.every((l): l is L => l !== null) ? leaves : null;
  };
  for (const [ci, co] of [
    [shared[0], shared[1]],
    [shared[1], shared[0]],
  ] as const) {
    if (!ci || !co || !isIn(ci) || !isOut(co)) continue;
    const found = three([
      [ci, o],
      [i, o],
      [i, co],
    ]);
    if (found) return found;
  }
  for (const c of shared) {
    if (isIn(c)) {
      // c and i inside, o and the hex c and o share besides i outside: sides i|o, c|o, c|o2.
      const o2 = commonNeighbors(g, c, o).find((h) => !sameHex(h, i));
      if (o2 && isOut(o2)) {
        const found = three([
          [i, o],
          [c, o],
          [c, o2],
        ]);
        if (found) return found;
      }
    } else if (isOut(c)) {
      const i2 = commonNeighbors(g, i, c).find((h) => !sameHex(h, o));
      if (i2 && isIn(i2)) {
        const found = three([
          [i, o],
          [i, c],
          [i2, c],
        ]);
        if (found) return found;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ the warnings

/**
 * The fog sub-cells of the area and of both cells of every join leaf, since
 * an edge or wall shows players by either cell (D-261110-245). On hexes,
 * each hex's own sub-cells.
 */
export function warnedSubcells(g: Grid, bounds: Bounds, area: CellRect, join: WingJoin | null): Iterable<[number, number]> {
  const keys: string[] = [];
  for (let y = area.y; y < area.y + area.h; y++) for (let x = area.x; x < area.x + area.w; x++) keys.push(`${x},${y}`);
  for (const leaf of join?.leaves ?? []) keys.push(leaf.inside, leaf.outside);
  const out: [number, number][] = [];
  for (const key of keys) {
    const [x, y] = keyXY(key);
    if (isHex(g)) {
      const h = { col: x, row: y };
      if (hexInScene(g, bounds, h)) out.push(...hexSubcells(g, h));
      continue;
    }
    if (x < 0 || y < 0 || x >= bounds.w || y >= bounds.h) continue;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) for (let sx = 0; sx < FOG_SUBCELLS; sx++) out.push([x * FOG_SUBCELLS + sx, y * FOG_SUBCELLS + sy]);
  }
  return out;
}

/** Whether any of the sub-cells is set in the tiles `bitsOf` reads, each tile read once. */
function anySet(subcells: Iterable<[number, number]>, bitsOf: (tx: number, ty: number) => Uint8Array | null): boolean {
  const tiles = new Map<string, Uint8Array | null>();
  for (const [sx, sy] of subcells) {
    if (sx < 0 || sy < 0) continue;
    const tx = Math.floor(sx / TILE_SUB);
    const ty = Math.floor(sy / TILE_SUB);
    const at = `${tx},${ty}`;
    let bits = tiles.get(at);
    if (bits === undefined) tiles.set(at, (bits = bitsOf(tx, ty)));
    if (!bits) continue;
    const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
    if ((bits[i >> 3]! >> (i & 7)) & 1) return true;
  }
  return false;
}

/**
 * The two warnings (3.1, C15, H14, I7): the party sees part of the area or
 * the join now (inSight.ts's rule: a floor players see, with fog and party
 * vision on), and part of either is ground the DM revealed, which shows
 * players the wing at once. Ground the party only explored is left out:
 * their remembered map keeps the old ground there until they see it again
 * (LP37-A-WING-1). A scene without fog shows players everything, which the
 * pane says on its own line instead.
 */
export function wingWarnings(view: RoomState, scene: Pick<Scene, "id" | "bounds" | "gridShape" | "fogEnabled" | "vision">, area: CellRect, join: WingJoin | null): string[] {
  if (scene.fogEnabled !== true) return [];
  const subcells = [...warnedSubcells(sceneGrid(scene), scene.bounds, area, join)];
  const out: string[] = [];
  const sight = sightOf(view);
  if (scene.vision?.on === true && sight && playersSee(view, scene.id)) {
    if (anySet(subcells, (tx, ty) => ((tile) => (tile ? seenFogBits(tile) : null))(sight[tileKey(scene.id, tx, ty)]))) out.push(WING_SIGHT);
  }
  const revealed = (tx: number, ty: number) => {
    const tile = view.fogTiles[tileKey(scene.id, tx, ty)];
    return tile ? decodeTile(tile.bits) : null;
  };
  if (anySet(subcells, revealed)) out.push(WING_REVEALED);
  return out;
}

// ------------------------------------------------------------ the pointer

/**
 * A finished drag's area, or why the rules refuse it: on hexes one that
 * covers build (3.1). The scene comes with the room it is read from.
 */
export function judgeArea(view: Pick<RoomState, "buildChunks" | "labels" | "lights" | "stamps">, scene: Pick<Scene, "id" | "bounds" | "gridShape">, rect: CellRect): string | null {
  return isHex(sceneGrid(scene)) && hexAreaCovers(view, scene, rect) ? WING_HEX_COVERS : null;
}

/**
 * The picks after a new area or tap (3.1): a new drag or tap replaces its
 * own, and a tapped wall is judged against the area, Narrow, as the row
 * shows it before the pane's Corridor width is known. A refused tap keeps
 * the join before it, with the note saying why. A tapped hex wall that a
 * new area no longer takes is dropped with its line.
 */
export function nextPicks(
  view: RoomState,
  scene: Scene,
  was: WingPicks | null,
  change: { area: CellRect } | { tap: WingTap },
): { picks: WingPicks; note: string | null } {
  const kept = was?.sceneId === scene.id ? was : { sceneId: scene.id, area: null, tap: null, join: null };
  const area = "area" in change ? change.area : kept.area;
  const tap = "tap" in change ? change.tap : kept.tap;
  if (tap === null) return { picks: { ...kept, area }, note: null };
  const judged = judgeJoin(view, scene, tap, area, false);
  if (judged.ok === true) return { picks: { sceneId: scene.id, area, tap, join: judged.value }, note: null };
  if (judged.ok === "area") return { picks: { sceneId: scene.id, area, tap, join: null }, note: null };
  if (judged.ok === "gone") return { picks: { sceneId: scene.id, area, tap: null, join: null }, note: null };
  // A refused tap leaves the join it would have replaced. A new area that refuses the tapped wall drops it.
  return "tap" in change ? { picks: { ...kept, area }, note: judged.problem } : { picks: { sceneId: scene.id, area, tap: null, join: null }, note: judged.problem };
}

/**
 * The builder's pointer with Add a wing in front of it (3.1): a drag draws
 * the area, red with its reason while the rules refuse it, and a tap picks
 * the wall the wing joins, the nearest within 22 px. A gesture that began
 * in the mode ends there, whatever the mode is by the time it ends.
 */
export function withWingMode(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const inMode = (ctx: ToolContext) => ctx.scope.get(builderSlot).store.getState().mode === "wing";
  const busy = (ctx: ToolContext) => ctx.scope.get(builderSlot).gesture.wing !== null;
  return {
    ...handlers,
    down: (p, ctx) => (inMode(ctx) ? wingDown(p, ctx) : handlers.down?.(p, ctx)),
    move: (p, ctx) => (busy(ctx) ? wingMove(p, ctx) : handlers.move?.(p, ctx)),
    up: (p, ctx) => (busy(ctx) ? wingUp(p, ctx) : handlers.up?.(p, ctx)),
    cancel: (ctx) => {
      const { store, gesture } = ctx.scope.get(builderSlot);
      gesture.wing = null;
      if (store.getState().wingDraft !== null) store.setState({ wingDraft: null });
      handlers.cancel?.(ctx);
    },
  };
}

function wingDown(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const off = wingOff(ctx.scene);
  if (off !== null) {
    store.setState({ note: off });
    return;
  }
  gesture.wing = { screen: p.screen, world: p.world };
  store.setState({ wingDraft: null, note: null });
}

function wingMove(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const start = gesture.wing;
  const view = ctx.getState().floorView;
  if (!start || !view) return;
  if (store.getState().wingDraft === null && distance(start.screen, p.screen) <= TAP_SLOP_PX) return;
  const rect = areaBetween(sceneGrid(ctx.scene), start.world, p.world, ctx.scene.bounds);
  const problem = judgeArea(view, ctx.scene, rect);
  store.setState({ wingDraft: { rect, problem }, note: problem });
}

function wingUp(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const start = gesture.wing;
  gesture.wing = null;
  const drafted = store.getState().wingDraft !== null;
  store.setState({ wingDraft: null });
  const view = ctx.getState().floorView;
  if (!start || !view) return;
  const s = store.getState();
  if (drafted) {
    const rect = areaBetween(sceneGrid(ctx.scene), start.world, p.world, ctx.scene.bounds);
    const problem = judgeArea(view, ctx.scene, rect);
    if (problem !== null) {
      store.setState({ note: problem });
      return;
    }
    const next = nextPicks(view, ctx.scene, s.wing, { area: rect });
    store.setState({ wing: next.picks, note: next.note });
    return;
  }
  // With Edit rooms on, a tap on a ghost room opens its panel in the pane rather than picking a join (dungeon phase 3, 3.3).
  if (s.wingOpen && s.wingEdit && s.wingGhost) {
    const room = ghostRoomAt(s.wingGhost, p.world, WING_REACH_PX / ctx.camera().scale);
    if (room) {
      store.setState({ wingRoom: room.n });
      return;
    }
  }
  const tapped = tapAt(view, ctx.scene, p.world, WING_REACH_PX / ctx.camera().scale);
  if (tapped === null) {
    store.setState({ note: WING_TAP });
    return;
  }
  if (!tapped.ok) {
    store.setState({ note: tapped.problem });
    return;
  }
  const next = nextPicks(view, ctx.scene, s.wing, { tap: tapped.value });
  store.setState({ wing: next.picks, note: next.note });
}

// ------------------------------------------------------------ the base

type Based = Pick<RoomState, "buildChunks" | "traps" | "stamps" | "lights" | "labels" | "pins" | "tokens" | "floorLinks">;

/** FNV-1a over a string's UTF-16 units, as eight hex digits: enough to tell a changed scene from the same one, never a secret. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The scene's own entries of a collection, by id order, so a hash reads them the same way every time. */
function own<T extends { sceneId?: string }>(all: Readonly<Record<string, T | undefined>> | undefined, sceneId: string): [string, T][] {
  return Object.entries(all ?? {})
    .filter((e): e is [string, T] => e[1] !== undefined && e[1].sceneId === sceneId)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * What the wing is planned on (3.3 and 4.2, D-261110-231): the scene, the
 * parts of the room that can stand in the planner's way, the area, the
 * join as the asks carry it, and a hash of the scene, the area and the
 * tapped wall, which edits freeze, so a base posted again over a changed
 * scene drops them.
 *
 * The hash names the tapped wall rather than the join it judged, since
 * Corridor width widens or narrows that join: a change of width drops the
 * edits as any change of choice does, with Bring them back, and is no
 * changed scene (DG3 review round 1). The planner posts the base again
 * when its join changes (WingPane.tsx `wingPlanner`).
 */
export function wingBaseOf(view: Based, scene: Scene, area: CellRect, join: WingJoin): WingBase {
  const state: WingBase["state"] = {
    buildChunks: view.buildChunks,
    traps: view.traps,
    stamps: view.stamps,
    lights: view.lights,
    labels: view.labels,
    pins: view.pins,
    tokens: view.tokens,
    floorLinks: view.floorLinks,
  };
  const geometry = {
    bounds: scene.bounds,
    grid: scene.gridShape ?? "squares",
    autoWalls: autoWallsOf(scene),
    area,
    tap: join.tap,
    chunks: own(view.buildChunks, scene.id),
    traps: own(view.traps, scene.id),
    stamps: own(view.stamps, scene.id),
    lights: own(view.lights, scene.id),
    labels: own(view.labels, scene.id),
    pins: own(view.pins, scene.id),
    tokens: own(view.tokens, scene.id),
    floorLinks: own(view.floorLinks, scene.id),
  };
  return { scene, state, area, join: join.expect, hash: fnv(JSON.stringify(geometry)) };
}
