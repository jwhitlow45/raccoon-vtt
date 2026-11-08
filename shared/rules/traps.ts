import { CHUNK_CELLS, FOG_SUBCELLS, MIN_HEIGHT_FT, type BuildChunk, type CellRect, type RoomState, type Token, type Trap, type TrapDoorRef, type TrapHow, type TrapRig, type TrapZone, type Viewer } from "../model.ts";
import { chunkKey, wallMidpoint } from "../keys.ts";
import { gridOfScene, playersToken, seenByNonOwners } from "../project.ts";
import type { Op } from "../protocol.ts";
import { fileStandsSnapped, followsInSingleFileOnHexes, stopsByCoveredSquares, stopsFileApart, stopsOnPublicGround, stopsOnTrap, stopsStandClear, stopsStandFullSize } from "../migrate.ts";
import { isWritable } from "../writable.ts";
import { creaturesInArea, type AreaToken } from "./aoe.ts";
import { holderOf, insideHolder, linkHolds, onHolder, seatHolds, walkerFor } from "./attach.ts";
import type { Rect } from "./geom.ts";
import { footprintRect, footprintSize, isSqueezed, occupiedHexes, occupiedRange, placedOnHex, rangeAtInto, sizeCategory, tokenRefHex, type CellRange, type PlacedToken } from "./footprint.ts";
import { footing, footprintGround, groundAt, sceneGround, standing } from "./heights.ts";
import { pendingGround } from "./held.ts";
import { planWalks, walkedIn, withTrapCut, type MovedToken } from "./moveLeg.ts";
import { groundUnder, hexStandHexes, storedBuild, type HexWalls } from "./movement.ts";
import { fileOrder, onTrace, routeLattice, routeStands, routeWalk, type PublicGround, type RoutePiece, type RoutePoint, type RouteSpot, type StandGroup, type StandRule, type WalkSpot } from "./route.ts";
import { APART, contact, orient } from "./segments.ts";
import { sceneWalls } from "./walls.ts";
import { isHex, sceneGrid, SQUARES, type Grid } from "./grid.ts";
import { cornerAt, hexAt, hexCorners, hexInScene, hexKey, hexNeighbors, hexSubcells, sceneHexSpan, type Hex, type HexGrid } from "./hex.ts";
import { ownEntry } from "../records.ts";
import { playersSee } from "./floors.ts";

/**
 * Triggers and traps (docs/design/design-v1-traps.md section 5): which creatures
 * set a trap off, where along a move, in what order, where a stopped group
 * lands, and who a springing hits. Pure, so the reducer runs the same rule
 * on replay and the DM's device runs it to predict its own ops. Players'
 * devices hold no rig (shared/project.ts), so nothing here ever runs on a
 * player's copy.
 *
 * Every input another viewer can observe reads only creatures and links
 * *seen by all*: what a player who owns nothing would receive before the op
 * (section 5.3, the shared contract's public members). Those walk in the
 * public pass, which decides stops, every springing players perceive, the
 * trap's state and its effects. Everything else walks in the private pass
 * after it, on its own step, and never stops anything (5.5).
 */

/** The ids the app makes. A trap's own id is one, and only these go into the lists the reducer writes, so each stays within its reserve (6.1). */
export const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isPlainId(id: string): boolean {
  return PLAIN_ID.test(id);
}

/** The scene where traps go off by themselves (5.1): the players', while no blackout is on. On a scene with floors, its start floor. */
export function liveTrapScene(state: Pick<RoomState, "meta">): string | null {
  return state.meta.view.blackout ? null : state.meta.playerSceneId;
}

/**
 * Whether traps go off by themselves on a floor (5.1,
 * docs/design/design-v1-floors.md 7.7, D-261102-490): one players see now,
 * an open floor outside a blackout, so a floor not reached is a safe place
 * to prepare. On a scene without floors, the players' scene.
 */
export function trapsLiveOn(state: RoomState, sceneId: string): boolean {
  return playersSee(state, sceneId);
}

/**
 * The floor a walk op's traps go off on: on a players' scene without
 * floors exactly `liveTrapScene`, so stored walks replay as they were
 * made, and on one with floors the floor of the first token the op names
 * that stands on a live floor. A board shows one floor, so a gesture
 * walks one.
 */
function walkScene(op: Op, state: TrapRoom): string | null {
  const today = liveTrapScene(state);
  if (today === null || ownEntry(state.scenes, today)?.floor === undefined) return today;
  const named = op.t === "token.moveMany" ? op.moves.map((m) => m.tokenId) : "tokenId" in op ? [op.tokenId] : [];
  for (const id of named) {
    const sceneId = ownEntry(state.tokens, id)?.sceneId;
    if (sceneId !== undefined && trapsLiveOn(state, sceneId)) return sceneId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zones

/** A zone's squares, or null for a wire or a door. */
export function zoneRects(zone: TrapZone): readonly CellRect[] | null {
  return "cells" in zone ? zone.cells : null;
}

/** Whether a cell is one of the rectangles', or on hexes a hex whose key is (`x` its column, `y` its row). */
export function inRects(rects: readonly CellRect[], x: number, y: number): boolean {
  return rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

/** How many cells the rectangles cover, a cell two rectangles share counted once. */
export function rectCellCount(rects: readonly CellRect[]): number {
  const seen = new Set<string>();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) seen.add(`${x},${y}`);
  return seen.size;
}

/** A door's key, the same for the two ways an op and a trap name it. */
export function doorKey(ref: TrapDoorRef): string {
  return "edge" in ref ? `e:${ref.edge}` : `w:${ref.cx},${ref.cy}:${ref.id}`;
}

export function sameDoor(a: TrapDoorRef, b: TrapDoorRef): boolean {
  return doorKey(a) === doorKey(b);
}

/** A wire's length in cells. */
export function wireLength(wire: { a: readonly [number, number]; b: readonly [number, number] }): number {
  return Math.sqrt((wire.b[0] - wire.a[0]) ** 2 + (wire.b[1] - wire.a[1]) ** 2);
}

/**
 * The cells the fog rule reads for a zone (6.4): its squares, the cells a
 * wire passes over, a door's two cells. Each is a range of one or more
 * whole cells. A free door names its chunk's wall, so a door that is gone
 * has no cells. On a hex scene each of the zone's hexes (zoneHexes) gives
 * the cells its fog sub-cells lie in, which find the tiles a reprojection
 * reads (project.ts tileDependents). Whether the zone is under the fog reads
 * the sub-cells themselves (zoneFogged).
 */
export function zoneRanges(state: Pick<RoomState, "buildChunks" | "scenes">, sceneId: string, zone: TrapZone): CellRange[] {
  const g = gridOfScene(state, sceneId);
  if (isHex(g)) return zoneHexes(g, state, sceneId, zone).map((h) => subcellCells(hexSubcells(g, h)));
  if ("cells" in zone) return zone.cells.map((r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  if ("wire" in zone) return wireCells(zone.wire).map(({ x, y }) => ({ x0: x, y0: y, x1: x + 1, y1: y + 1 }));
  return doorCells(state, sceneId, zone.door).map(({ x, y }) => ({ x0: x, y0: y, x1: x + 1, y1: y + 1 }));
}

/**
 * The cells a wire passes over: every cell whose closed square its segment
 * meets, so a point of it on a grid line belongs to the cells on both
 * sides, and a corner to all four. Exact: a wire's ends lie on the 1/64
 * lattice (half cells on squares), so in 64ths every test is on integers
 * well inside a double's exact range. A cell meets the segment when their
 * boxes overlap and the segment's line does not leave all four of its
 * corners strictly on one side.
 */
export function wireCells(wire: { a: readonly [number, number]; b: readonly [number, number] }): { x: number; y: number }[] {
  const L = WIRE_LATTICE;
  const ax = Math.round(wire.a[0] * L);
  const ay = Math.round(wire.a[1] * L);
  const dx = Math.round(wire.b[0] * L) - ax;
  const dy = Math.round(wire.b[1] * L) - ay;
  const side = (px: number, py: number) => Math.sign(dx * (py - ay) - dy * (px - ax));
  const out: { x: number; y: number }[] = [];
  const x0 = Math.max(0, Math.ceil(Math.min(wire.a[0], wire.b[0])) - 1);
  const y0 = Math.max(0, Math.ceil(Math.min(wire.a[1], wire.b[1])) - 1);
  const x1 = Math.floor(Math.max(wire.a[0], wire.b[0]));
  const y1 = Math.floor(Math.max(wire.a[1], wire.b[1]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sides = side(L * x, L * y) + side(L * x + L, L * y) + side(L * x, L * y + L) + side(L * x + L, L * y + L);
      if (sides !== 4 && sides !== -4) out.push({ x, y });
    }
  }
  return out;
}

/** A wire's ends are multiples of 1 / 64 cell, the free walls' lattice (protocol.ts trapWire): half cells on squares. */
const WIRE_LATTICE = 64;

// ---------------------------------------------------------------------------
// Zones on hexes (docs/design/design-v1-hex-grids.md phase H2)

/**
 * A zone's hexes on a hex scene: the hexes its rectangles of keys name (`x`
 * a column, `y` a row), the hexes a wire meets, or the hexes beside a free
 * door. Each once, in the order found.
 */
export function zoneHexes(g: HexGrid, state: Pick<RoomState, "buildChunks">, sceneId: string, zone: TrapZone): Hex[] {
  if ("cells" in zone) return rectHexes(zone.cells);
  if ("wire" in zone) return wireHexes(g, zone.wire);
  return doorHexes(g, state, sceneId, zone.door);
}

/** The hexes rectangles of keys name, a hex two share once. */
export function rectHexes(rects: readonly CellRect[]): Hex[] {
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const r of rects) {
    for (let row = r.y; row < r.y + r.h; row++) {
      for (let col = r.x; col < r.x + r.w; col++) {
        const key = `${col},${row}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ col, row });
      }
    }
  }
  return out;
}

/**
 * The hexes a wire meets: every hex whose closed outline, its corners as
 * rounded onto the 1/64 lattice (hex.ts cornerAt), the wire touches or
 * lies inside. Neighbors share their rounded corners, so the outlines tile
 * the plane and the test is exact (segments.ts orient and contact). The
 * hexes a segment meets are connected, so the search grows from the hex
 * holding its first end and that hex's neighbors.
 */
export function wireHexes(g: HexGrid, wire: { a: readonly [number, number]; b: readonly [number, number] }): Hex[] {
  const [ax, ay] = wire.a;
  const [bx, by] = wire.b;
  const meets = (h: Hex): boolean => {
    const corners = hexCorners(g, h).map((c) => cornerAt(g, c));
    let turn = 0;
    let inside = true;
    for (let i = 0; i < corners.length; i++) {
      const p = corners[i]!;
      const q = corners[(i + 1) % corners.length]!;
      if (contact(ax, ay, bx, by, p.x, p.y, q.x, q.y) !== APART) return true;
      const o = orient(p.x, p.y, q.x, q.y, ax, ay);
      if (o === 0 || (turn !== 0 && o !== turn)) inside = false;
      turn = o;
    }
    return inside;
  };
  const start = hexAt(g, { x: ax, y: ay });
  const seen = new Set<string>();
  const out: Hex[] = [];
  const queue: Hex[] = [start, ...hexNeighbors(g, start)];
  for (const h of queue) seen.add(hexKey(h));
  for (let i = 0; i < queue.length; i++) {
    const h = queue[i]!;
    if (!meets(h)) continue;
    out.push(h);
    for (const n of hexNeighbors(g, h)) {
      const key = hexKey(n);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return out;
}

/**
 * The hexes beside a free door on a hex scene, one on each side of its
 * middle (permissions.ts doorPlace), or none for a door that is gone. A
 * hex scene has no grid edges, so an edge door names nothing there.
 */
function doorHexes(g: HexGrid, state: Pick<RoomState, "buildChunks">, sceneId: string, ref: TrapDoorRef): Hex[] {
  if ("edge" in ref) return [];
  const beside = doorSides(state, sceneId, ref);
  if (!beside) return [];
  const a = hexAt(g, beside[0]);
  const b = hexAt(g, beside[1]);
  return a.col === b.col && a.row === b.row ? [a] : [a, b];
}

/** The cells some fog sub-cells lie in. A hex always holds some, so the range is never empty. */
function subcellCells(subs: readonly (readonly [number, number])[]): CellRange {
  let sx0 = Infinity;
  let sy0 = Infinity;
  let sx1 = -Infinity;
  let sy1 = -Infinity;
  for (const [sx, sy] of subs) {
    sx0 = Math.min(sx0, sx);
    sy0 = Math.min(sy0, sy);
    sx1 = Math.max(sx1, sx);
    sy1 = Math.max(sy1, sy);
  }
  return { x0: Math.floor(sx0 / FOG_SUBCELLS), y0: Math.floor(sy0 / FOG_SUBCELLS), x1: Math.floor(sx1 / FOG_SUBCELLS) + 1, y1: Math.floor(sy1 / FOG_SUBCELLS) + 1 };
}

/**
 * Whether a zone lies wholly under the fog (6.4), the rule a player's copy
 * of a found trap reads (project.ts projectTrapCtx). On squares every range
 * of zoneRanges is fogged. On hexes every fog sub-cell inside each of its
 * hexes is (docs/design/design-v1-hex-grids.md H2), so ground revealed beside a
 * hex, even in a cell the hex shares, never shows the trap. A zone with no
 * hexes, a door that is gone, counts as fogged, as on squares.
 */
export function zoneFogged(
  state: Pick<RoomState, "buildChunks" | "scenes">,
  sceneId: string,
  zone: TrapZone,
  rangeFogged: (r: CellRange) => boolean,
  subFogged: (sx: number, sy: number) => boolean,
): boolean {
  const g = gridOfScene(state, sceneId);
  if (!isHex(g)) return zoneRanges(state, sceneId, zone).every(rangeFogged);
  return zoneHexes(g, state, sceneId, zone).every((h) => hexSubcells(g, h).every(([sx, sy]) => subFogged(sx, sy)));
}

/** Where a pit's squares go when it opens (5.7): its stored floor, at least the height rules' lowest. */
export function pitFloorOf(pit: { floor: number }): number {
  return Math.max(MIN_HEIGHT_FT, pit.floor);
}

/** Whether a pit is open: every square of its zone stands at its floor, so opening it again changes nothing. */
export function pitOpen(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, cells: readonly CellRect[], pit: { floor: number }): boolean {
  const floor = pitFloorOf(pit);
  for (const r of cells) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (groundAt(chunks, sceneId, x, y) !== floor) return false;
  return true;
}

/** A door's two cells, one on each side (permissions.ts doorPlace), or none for a free door that is gone. */
export function doorCells(state: Pick<RoomState, "buildChunks">, sceneId: string, ref: TrapDoorRef): { x: number; y: number }[] {
  if ("edge" in ref) {
    const [xs, ys, side] = ref.edge.split(",");
    const x = Number(xs);
    const y = Number(ys);
    return side === "n" ? [{ x, y }, { x, y: y - 1 }] : [{ x, y }, { x: x - 1, y }];
  }
  const beside = doorSides(state, sceneId, ref);
  if (!beside) return [];
  const a = { x: Math.floor(beside[0].x), y: Math.floor(beside[0].y) };
  const b = { x: Math.floor(beside[1].x), y: Math.floor(beside[1].y) };
  return a.x === b.x && a.y === b.y ? [a] : [a, b];
}

/** The two points a 256th of a cell off a free door's middle, one on each side of it, or null for a door that is gone. */
function doorSides(state: Pick<RoomState, "buildChunks">, sceneId: string, ref: { cx: number; cy: number; id: string }): [{ x: number; y: number }, { x: number; y: number }] | null {
  const wall = ownEntry(state.buildChunks, chunkKey(sceneId, ref.cx, ref.cy))?.walls?.find((w) => w.id === ref.id);
  if (!wall) return null;
  const [mx, my] = wallMidpoint(wall);
  const nx = -(wall.b[1] - wall.a[1]);
  const ny = wall.b[0] - wall.a[0];
  const scale = Math.max(Math.abs(nx), Math.abs(ny)) * 256;
  const side = (sign: number) => ({ x: mx + (sign * nx) / scale, y: my + (sign * ny) / scale });
  return [side(1), side(-1)];
}

/** Whether a door zone's door is still there, on the grid or free. */
export function doorExists(state: Pick<RoomState, "buildChunks">, sceneId: string, ref: TrapDoorRef): boolean {
  if ("edge" in ref) {
    const [xs, ys] = ref.edge.split(",");
    const chunk = ownEntry(state.buildChunks, chunkKey(sceneId, Math.floor(Number(xs) / CHUNK_CELLS), Math.floor(Number(ys) / CHUNK_CELLS)));
    return chunk?.edges[ref.edge]?.kind === "door";
  }
  return ownEntry(state.buildChunks, chunkKey(sceneId, ref.cx, ref.cy))?.walls?.find((w) => w.id === ref.id)?.f.kind === "door";
}

// ---------------------------------------------------------------------------
// Who sets a trap off (5.2)

/** A creature a trap can catch or hit: not an object and not dead, which every player's projection holds. */
export function trapCreature(state: Pick<RoomState, "characters">, token: Pick<Token, "kind" | "actor">): boolean {
  if (token.kind === "object") return false;
  const actor = "inline" in token.actor ? token.actor.inline : ownEntry(state.characters, token.actor.ref)?.actor;
  return actor?.life !== "dead";
}

/**
 * Whether a creature is one the rig lets set the trap off, wherever it
 * stands: `who` by the projected party flag (a member of kind player owns
 * the token or its character), never the DM's `partyVision`, and
 * `minSize` by movement's size categories, so a custom size counts by its
 * longer side. The floor is judged at each spot (`onFloor`).
 */
export function setsOff(rig: TrapRig, state: Pick<RoomState, "members" | "characters">, token: Token): boolean {
  if (!trapCreature(state, token)) return false;
  if (rig.minSize === "small" && sizeCategory(token) === "tiny") return false;
  if (rig.who === "any") return true;
  const party = playersToken(state, token);
  return rig.who === "party" ? party : !party;
}

/** A token as it stands at one spot of a walk: where, how high, squeezed or not. */
export type Placed = Token & { footing?: "ground" };

/** Whether a creature at a spot is on the floor (5.2): on its own ground, and not carried on another by a link every player sees there. */
export function onFloor(state: Pick<RoomState, "buildChunks">, at: Placed, carriedOn: boolean): boolean {
  if (carriedOn) return false;
  return standing(at.elevation, footprintGround(state.buildChunks, at)) === "ground";
}

// ---------------------------------------------------------------------------
// The index of a scene's armed traps (section 9)

/**
 * A scene's armed traps with their rigs, as the step reads them: a count
 * table of armed squares that says in four reads whether a footprint covers
 * any, the traps on each such square, the wires with their boxes, and the
 * door traps by door. Kept per traps collection once no transaction can
 * write into it, so a scene with no armed trap costs one lookup an op.
 */
export type TrapIndex = {
  traps: readonly Trap[];
  squares: SquareIndex | null;
  wires: readonly { i: number; x0: number; y0: number; x1: number; y1: number }[];
  doors: ReadonlyMap<string, readonly number[]>;
  /** Traps going off at a turn's start or end, which read the squares. */
  turns: readonly number[];
};

/**
 * The armed squares (section 9): a summed-area table that counts them in
 * any rectangle in four reads, and per square the set of its traps, as an
 * index into `sets` (0 for none), so a footprint over armed squares reads
 * one number a square and joins the few distinct sets it meets.
 */
/** Each square's set of traps by id (0 none), with where each run of one set ends along its row, and the armed squares summed. */
type SquareIndex = { w: number; h: number; sum: Int32Array; cells: Uint16Array; runEnd: Uint16Array; sets: readonly (readonly number[])[] };

const EMPTY_INDEX: TrapIndex = { traps: [], squares: null, wires: [], doors: new Map(), turns: [] };

const indexes = new WeakMap<object, Map<string, TrapIndex>>();

/** Armed traps with rigs on a scene, by id. */
export function armedTraps(traps: Readonly<Record<string, Trap>>, sceneId: string): Trap[] {
  return Object.values(traps)
    .filter((t) => t.sceneId === sceneId && t.state === "armed" && t.rig !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const NO_TRAPS: Readonly<Record<string, Trap>> = Object.freeze({});

/** A room with its traps (RoomState.traps). */
export type TrapRoom = RoomState & { traps: Readonly<Record<string, Trap>> };

export function trapIndex(state: Pick<TrapRoom, "traps" | "scenes">, sceneId: string): TrapIndex {
  // A room from before traps, as old tests and fixtures hold, has none.
  const traps = state.traps ?? NO_TRAPS;
  const cached = indexes.get(traps)?.get(sceneId);
  if (cached) return cached;
  const armed = armedTraps(traps, sceneId);
  const scene = ownEntry(state.scenes, sceneId);
  const index = armed.length === 0 || !scene ? EMPTY_INDEX : buildIndex(armed, keySpan(sceneGrid(scene), scene.bounds));
  if (!isWritable(traps)) {
    let byScene = indexes.get(traps);
    if (!byScene) indexes.set(traps, (byScene = new Map()));
    byScene.set(sceneId, index);
  }
  return index;
}

/**
 * The keys a scene's squares run over: its cells, or on hexes the columns
 * and rows its hex keys take (hex.ts sceneHexSpan), so the index reads a
 * hex by its key as it reads a square (docs/design/design-v1-hex-grids.md H2).
 * A scene's grid cannot change while it holds a trap (grid.ts switchHolds),
 * so the index kept for its traps keeps its grid too.
 */
function keySpan(g: Grid, bounds: { w: number; h: number }): { w: number; h: number } {
  if (!isHex(g)) return bounds;
  const span = sceneHexSpan(g, bounds);
  return { w: span.cols, h: span.rows };
}

function buildIndex(traps: readonly Trap[], bounds: { w: number; h: number }): TrapIndex {
  const w = bounds.w;
  const h = bounds.h;
  const at = new Map<number, number[]>();
  const wires: { i: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const doors = new Map<string, number[]>();
  const turns: number[] = [];
  traps.forEach((trap, i) => {
    const zone = trap.zone;
    if ("cells" in zone) {
      for (const r of zone.cells) {
        for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
          for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) {
            const k = y * w + x;
            const list = at.get(k);
            if (!list) at.set(k, [i]);
            else if (list[list.length - 1] !== i) list.push(i);
          }
        }
      }
      if (trap.rig!.on.includes("turnStart") || trap.rig!.on.includes("turnEnd")) turns.push(i);
    } else if ("wire" in zone) {
      const { a, b } = zone.wire;
      wires.push({ i, x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) });
    } else {
      const key = doorKey(zone.door);
      const list = doors.get(key);
      if (list) list.push(i);
      else doors.set(key, [i]);
    }
  });
  let squares: SquareIndex | null = null;
  if (at.size > 0) {
    // A summed-area table: the armed squares in any rectangle in four reads.
    const sum = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        if (at.has(y * w + x)) row++;
        sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1]! + row;
      }
    }
    // Each square's traps as one of the distinct sets, which a scene of 50 traps keeps few.
    const cells = new Uint16Array(w * h);
    const sets: (readonly number[])[] = [[]];
    const ids = new Map<string, number>();
    for (const [k, list] of at) {
      const key = list.join(",");
      let id = ids.get(key);
      if (id === undefined) {
        id = sets.length;
        ids.set(key, id);
        sets.push(list);
      }
      cells[k] = id;
    }
    // Where each run of one set ends, so a footprint reads a row's sets a run at a time.
    const runEnd = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = w - 1; x >= 0; x--) {
        const k = y * w + x;
        runEnd[k] = x + 1 < w && cells[k + 1] === cells[k] ? runEnd[k + 1]! : x + 1;
      }
    }
    squares = { w, h, sum, cells, runEnd, sets };
  }
  return { traps, squares, wires, doors, turns };
}

/** How many armed squares a range of cells covers, clipped to the scene. */
function squaresIn(s: SquareIndex, r: CellRange): number {
  const x0 = Math.max(0, r.x0);
  const y0 = Math.max(0, r.y0);
  const x1 = Math.min(s.w, r.x1);
  const y1 = Math.min(s.h, r.y1);
  if (x0 >= x1 || y0 >= y1) return 0;
  const W = s.w + 1;
  return s.sum[y1 * W + x1]! - s.sum[y0 * W + x1]! - s.sum[y1 * W + x0]! + s.sum[y0 * W + x0]!;
}

const NONE: readonly number[] = [];

// ---------------------------------------------------------------------------
// Progress (5.3, 5.4)

/** How far along a walk: step `k` of piece `piece`'s `n`, the shared coordinate of movement's route spots. */
export type Progress = readonly [piece: number, k: number, n: number];

export const START: Progress = [0, 0, 1];

/** Orders progress exactly: piece first, then `k / n` by cross-multiplying. */
export function compareProgress(a: Progress, b: Progress): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  const an = a[2] === 0 ? 1 : a[2];
  const bn = b[2] === 0 ? 1 : b[2];
  return a[1] * bn - b[1] * an;
}

// ---------------------------------------------------------------------------
// Walks

/** A footprint at one spot, as the cells and the floor rule read it: no more than that, so a walk of 500 tokens copies none. */
type Light = { sceneId: string; size: Token["size"]; w?: number; h?: number; x: number; y: number; squeeze?: true; elevation: number };

/** One named token's group in a move: its own walk at each step its members take, which each member offsets by its place. */
type Group = {
  named: string;
  head: MovedToken;
  /** The head's spots at a step, with its walk's elevations. */
  base: (step: number) => readonly WalkSpot[];
  /** The finest step of the group's public members (5.3). */
  step: number;
};

/** What the trap step reads of an op's move: the walk of every token it moves, public and private (5.3). */
type Walk = {
  token: Token;
  entry: MovedToken;
  group: Group;
  /** Seen by all, with the link to its holder seen by all or none in this op. */
  isPublic: boolean;
  /** A walker of its public group: a public root (a named token, or one whose holder players cannot see), or a public dragged creature. Never what rides. */
  walker: boolean;
  /** Carried on its holder in this op by a link every player sees, so never on the floor. */
  carriedOn: boolean;
  /** The direct holder's walk in this op, when it moves only because its holder does. */
  holder?: Walk;
  /** Its spots: the group's own at its step plus this offset, or its own walk's with none. */
  spots: readonly WalkSpot[];
  /** Whether it walks a route of its own, not its group's walk offset by its place. */
  own: boolean;
  /** Whether players cannot see it and it seats, up a chain of seats, one they all see (`seatsOfSeen`). */
  seatsSeen: boolean;
  ox: number;
  oy: number;
  step: number;
  /** A teleport crosses nothing and is tested only where it lands. */
  teleport: boolean;
  /** The named token's `squeeze`, where a stop lands it (cutOp). */
  squeezeAtEnd: boolean;
  /** Whether its footprint is squeezed at spot `j`, as its walk's trace has it there (route.ts onTrace). */
  squeezedAt: (j: number) => boolean;
  /** Its full footprint's size in cells (footprintSize). */
  size: { w: number; h: number };
  /** The scene's grid, which the footprint at each spot is read on. */
  grid: Grid;
  /** Its elevation at each spot, worked out only where a trap needs it. */
  elevation: (j: number) => number;
};

/** Whether every player sees a token as the op finds the room: on the players' scene and received by a player who owns nothing (5.3). */
function seenByAll(state: RoomState, env: { opVersion?: number }): (id: string) => boolean {
  const cache = new Map<string, boolean>();
  return (id) => {
    let hit = cache.get(id);
    if (hit === undefined) {
      const token = ownEntry(state.tokens, id);
      cache.set(id, (hit = token !== undefined && seenByNonOwners(state, token, env)));
    }
    return hit;
  };
}

/** Whether an op is a walk the trap step tests (5.1): a move, a landing from the height controls, or a Get off. Never a setup placement or a seat step. */
export function walkOp(op: Op): boolean {
  switch (op.t) {
    case "token.move":
    case "token.moveMany":
      return true;
    case "token.detach":
      return op.x !== undefined && op.y !== undefined;
    case "token.update":
      return op.patch.elevation !== undefined && Object.keys(op.patch).every((f) => f === "elevation" || f === "rotation");
    default:
      return false;
  }
}

/** The tokens of each named token's group the plan moved, top down and by id, the named token first. */
function byGroup(entries: readonly MovedToken[]): Map<string, MovedToken[]> {
  const byId = new Map(entries.map((e) => [e.tokenId, e]));
  const chain = (e: MovedToken): MovedToken[] => {
    const out = [e];
    const seen = new Set([e.tokenId]);
    let at = e;
    while (at.carriedBy !== undefined) {
      const up = byId.get(at.carriedBy);
      if (!up || seen.has(up.tokenId)) break;
      seen.add(up.tokenId);
      out.push(up);
      at = up;
    }
    return out;
  };
  const info = entries.map((e) => {
    const up = chain(e);
    return { e, depth: up.length - 1, root: up[up.length - 1]!.tokenId };
  });
  info.sort((a, b) => a.depth - b.depth || cmp(a.e.tokenId, b.e.tokenId));
  const out = new Map<string, MovedToken[]>();
  for (const { e, root } of info) {
    let list = out.get(root);
    if (!list) out.set(root, (list = []));
    list.push(e);
  }
  return out;
}

function sameRoute(a: readonly RoutePoint[], b: readonly RoutePoint[], ox: number, oy: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.x !== b[i]!.x + ox || a[i]!.y !== b[i]!.y + oy) return false;
  return true;
}

function twoSpots(route: readonly RoutePoint[]): WalkSpot[] {
  const a = route[0]!;
  const b = route[route.length - 1]!;
  return [
    { x: a.x, y: a.y, elevation: a.elevation, progress: [0, 0, 1] },
    { x: b.x, y: b.y, elevation: b.elevation, progress: [0, 1, 1] },
  ];
}

/** An op's walks, by token and by group, and each walker's spots with `stand` once a stop has read them (standSpots). */
/** `opVersion` is the op's, which a walk off a holder starts by (attach.ts walkerFor). */
/** `grounds` is the ground every player sees on each scene, built once an op where a stop reads it (stopGround). */
type Walks = { all: Walk[]; byId: Map<string, Walk>; groups: Map<string, Group>; stands: Map<Walk, Stands>; opVersion: number | undefined; grounds: Map<string, PublicGround> };

/** A walk's spots, and each with `stand` as asked (route.ts routeStands). */
type Stands = { walk: readonly { progress: Progress }[]; spot: (i: number) => RouteSpot };

/**
 * The members of a group players cannot see that seat one they all see,
 * up a chain of seats from it to the first that walks or is seen
 * (review FU45B-ASTRA-11): from op version 38 (migrate.ts stopsStandClear).
 * Where the seen one walks as itself, as under a holder players cannot see,
 * the trap step judges its stand on its own walk, so each such holder
 * walks at its step and a cut keeps its walk too (`keepsOwn`), stopped
 * where the seen one is still on its seat (`seatingWalk`).
 */
function seatsOfSeen(before: RoomState, members: readonly MovedToken[], seen: (id: string) => boolean, opVersion: number | undefined): Set<string> {
  const out = new Set<string>();
  if (!stopsStandClear(opVersion)) return out;
  const byId = new Map(members.map((e) => [e.tokenId, e]));
  for (const e of members) {
    if (!seen(e.tokenId)) continue;
    for (let at: MovedToken | undefined = e; at?.carriedBy !== undefined; at = byId.get(at.carriedBy)) {
      const kind = ownEntry(before.tokens, at.tokenId)?.attached?.kind;
      if (kind === undefined || !onHolder(kind) || seen(at.carriedBy) || out.has(at.carriedBy)) break;
      out.add(at.carriedBy);
    }
  }
  return out;
}

/**
 * The walks of an op's move. A group's public members share one step, the
 * finest of theirs (half a square when one steps by halves), so they share
 * `n` on every piece and are judged at one moment (5.3). Every other member
 * walks on its own step. A member whose route is its group's walk offset by
 * its place reads that walk's spots, so a group of 500 builds one walk per
 * step it takes.
 */
function walksOf(op: Op, before: RoomState, entries: readonly MovedToken[], seen: (id: string) => boolean, opVersion: number | undefined): Walks {
  const all: Walk[] = [];
  const byId = new Map<string, Walk>();
  const groups = new Map<string, Group>();
  const build = { buildChunks: before.buildChunks };
  const grid = entries.length > 0 ? gridOfScene(before, entries[0]!.from.sceneId) : SQUARES;
  for (const [named, members] of byGroup(entries)) {
    const head = members[0]!;
    if (head.how !== "walk" && head.how !== "teleport") continue;
    const headToken = ownEntry(before.tokens, head.tokenId)!;
    const squeeze = op.t === "token.move" && op.tokenId === head.tokenId && op.squeeze === true;
    // The head's walk on hexes ends squeezed as the move leaves it, so its spots squeeze as the stored move does (squeezeRule).
    const ending = { endSqueezed: isSqueezed(endsAs(op, headToken, squeeze)) };
    const cache = new Map<number, readonly WalkSpot[]>();
    const base = (s: number): readonly WalkSpot[] => {
      let hit = cache.get(s);
      if (!hit) cache.set(s, (hit = head.how === "teleport" ? twoSpots(head.route) : routeWalk(grid, head.trace, build, s, ending)));
      return hit;
    };
    // The public members: every member seen by all. One under a holder players cannot see walks as itself (listed reveal 2).
    const step = Math.min(1, ...members.filter((e) => seen(e.tokenId)).map((e) => routeLattice(ownEntry(before.tokens, e.tokenId)!)));
    const group: Group = { named, head, base, step };
    groups.set(named, group);
    const seats = seatsOfSeen(before, members, seen, opVersion);
    for (const e of members) {
      const token = ownEntry(before.tokens, e.tokenId)!;
      const holder = e.carriedBy !== undefined ? byId.get(e.carriedBy) : undefined;
      const kind = holder ? token.attached?.kind : undefined;
      const pub = seen(e.tokenId);
      const linkSeen = holder !== undefined && pub && holder.isPublic;
      // A walk in single file goes at its group's step, seen or not, so what it carries every player sees stops where it does on a
      // cut (moveLeg.ts withTrapCut), and so does one that seats a creature every player sees (`seatsOfSeen`).
      const mine = pub || e.file === true || seats.has(e.tokenId) ? step : routeLattice(token);
      const ox = token.x - headToken.x;
      const oy = token.y - headToken.y;
      const shared = e === head || sameRoute(e.route, head.route, ox, oy);
      const walk: Walk = {
        token,
        entry: e,
        group,
        isPublic: pub,
        walker: pub && (!linkSeen || kind === "drag"),
        carriedOn: linkSeen && kind !== undefined && onHolder(kind),
        ...(holder ? { holder } : {}),
        // A member on a route of its own is a creature its holder drags beside it, which walks as itself (moveLeg.ts stoppedAtWalls).
        spots: shared ? base(mine) : e.how === "teleport" ? twoSpots(e.route) : routeWalk(grid, e.trace, build, mine),
        own: !shared,
        seatsSeen: seats.has(e.tokenId),
        ox: shared ? ox : 0,
        oy: shared ? oy : 0,
        step: mine,
        teleport: e.how === "teleport",
        squeezeAtEnd: e === head && squeeze,
        squeezedAt: () => false,
        size: footprintSize(token),
        grid,
        elevation: () => 0,
      };
      walk.squeezedAt = squeezeRule(walk, endsAs(op, token, e === head && squeeze));
      walk.elevation = elevationRule(walk, before, shared);
      all.push(walk);
      byId.set(e.tokenId, walk);
    }
  }
  return { all, byId, groups, stands: new Map(), opVersion, grounds: new Map() };
}

/**
 * Each spot's elevation by attach's rule (docs/design/design-v1-attach.md 5.1):
 * the group's own walk for the named token, the holder's change for what
 * rides, and for a dragged creature its own ground behind a holder on the
 * ground, else the holder's change but never below the ground. The holder
 * is read at the same spot of the same step's walk, so a member on its own
 * step reads its holder there too. A member walking a route of its own
 * takes that walk's elevations as they are, but one in single file, which
 * walks a route of its own, is judged by the same rule at its own spots,
 * its holder read at the same moment (`fileElevation`), so the trap step
 * reads it at the height the move takes it along at (review
 * FU45B-ASTRA-06).
 *
 * What is carried or rides all the way up adds its holders' changes to the
 * group's walk, in the order `elevationOnStep` adds them, so a walk of 500
 * reads each spot in a few additions. Only a dragged link reads the ground,
 * and remembers what it read.
 */
function elevationRule(walk: Walk, before: RoomState, shared: boolean): (j: number) => number {
  const last = walk.spots.length - 1;
  const own = walk.spots;
  if (!shared) {
    const holder = walk.holder;
    if (!holder || !inFile(walk)) return (j) => (j === 0 ? walk.token.elevation : j === last ? walk.entry.to.elevation : own[j]!.elevation);
    const memo = new Map<number, number>();
    return (j) => {
      if (j === 0) return walk.token.elevation;
      if (j === last) return walk.entry.to.elevation;
      let hit = memo.get(j);
      if (hit === undefined) memo.set(j, (hit = fileElevation(walk, holder, before, j)));
      return hit;
    };
  }
  const rises: number[] = [];
  for (let at: Walk = walk; at.holder; at = at.holder) {
    const kind = at.token.attached?.kind;
    if (kind === undefined || !onHolder(kind)) {
      const memo = new Map<number, number>();
      return (j) => {
        if (j === 0) return walk.token.elevation;
        if (j === last) return walk.entry.to.elevation;
        let hit = memo.get(j);
        if (hit === undefined) memo.set(j, (hit = elevationOnStep(walk, before, walk.step, j)));
        return hit;
      };
    }
    rises.unshift(at.token.elevation - at.holder.token.elevation);
  }
  return (j) => {
    if (j === 0) return walk.token.elevation;
    if (j === last) return walk.entry.to.elevation;
    let up = own[j]!.elevation;
    for (const rise of rises) up = up + rise;
    return up;
  };
}

/** Whether a walk is one in single file (moveLeg.ts singleFile), or rides on one all the way up to it. */
function inFile(walk: Walk): boolean {
  for (let at: Walk | undefined = walk; at; at = at.holder) {
    if (at.entry.file === true) return true;
    const kind = at.token.attached?.kind;
    if (kind === undefined || !onHolder(kind)) return false;
  }
  return false;
}

/**
 * A walk in single file's elevation at its own spot `j`, by attach's rule
 * as `elevationOnStep` reads a shared walk: what rides takes its holder's
 * change, and a dragged creature its own ground behind a holder on the
 * ground, else the holder's change but never below the ground. The holder
 * is read at its latest spot at the same progress. `at` is where it stands
 * there, its spot but where a stop snaps it to its grid (`stopPose`).
 */
function fileElevation(walk: Walk, holder: Walk, before: RoomState, j: number, at: { x: number; y: number } = walk.spots[j]!): number {
  const s = walk.spots[j]!;
  const up = holder.elevation(latestIndex(holder.spots, s.progress));
  const kind = walk.token.attached?.kind;
  if (kind !== undefined && onHolder(kind)) return up + (walk.token.elevation - holder.token.elevation);
  const ground = groundUnder(before.buildChunks, walk.entry.trace[s.progress[0]]!, { x: at.x, y: at.y });
  const grounded = footing(before.buildChunks, holder.entry.trace[0]!) === "ground";
  return grounded ? ground : Math.max(walk.token.elevation + (up - holder.token.elevation), ground);
}

/** A walk's elevation at spot `j` of its group's own walk at `step`, by attach's rule, its holder read at the same spot. */
function elevationOnStep(walk: Walk, before: RoomState, step: number, j: number): number {
  const spots = walk.group.base(step);
  if (j === 0) return walk.token.elevation;
  if (j === spots.length - 1) return walk.entry.to.elevation;
  const holder = walk.holder;
  if (!holder) return spots[j]!.elevation;
  const kind = walk.token.attached?.kind;
  const up = elevationOnStep(holder, before, step, j);
  if (kind !== undefined && onHolder(kind)) return up + (walk.token.elevation - holder.token.elevation);
  const s = spots[j]!;
  const ox = walk.token.x - walk.group.head.from.x;
  const oy = walk.token.y - walk.group.head.from.y;
  // Under its own footprint as its holder takes it along, and behind a holder whose walk starts on the ground (moveLeg.ts follow).
  const ground = groundUnder(before.buildChunks, walk.entry.trace[s.progress[0]]!, { x: s.x + ox, y: s.y + oy });
  const holderToken = holder.token;
  const grounded = footing(before.buildChunks, holder.entry.trace[0]!) === "ground";
  return grounded ? ground : Math.max(walk.token.elevation + (up - holderToken.elevation), ground);
}

/**
 * The token's footprint as the move leaves it, as dispatch writes its
 * squeeze: a `token.move` squeezes its named token where it asks to, a
 * landing from the height controls keeps the squeeze it has, and every
 * other move, and every carried token, ends full size.
 */
function endsAs(op: Op, token: Token, squeezes: boolean): PlacedToken {
  const { squeeze: _squeeze, ...rest } = token;
  const keeps = op.t === "token.update" && op.tokenId === token.id && token.squeeze === true;
  return squeezes || keeps ? { ...rest, squeeze: true } : rest;
}

/**
 * The walk's squeeze at each spot as its trace has it there, the rule an
 * area's sweep reads (route.ts onTrace): on a piece its walker where the
 * piece starts, at a piece's end the walker there, and where the walk ends
 * `ends`, the token as the move leaves it. On hexes the group's head reads
 * its own walk's squeeze at each spot instead (route.ts hexPiece), its
 * route's corners included, since a hex route squeezes partway along a
 * piece. Every other member keeps the trace's rule, as it walks as itself
 * or is carried.
 */
function squeezeRule(walk: Walk, ends: PlacedToken): (j: number) => boolean {
  const last = walk.spots.length - 1;
  const own = isHex(walk.grid) && walk.entry === walk.group.head;
  return (j) => {
    if (j === last) return isSqueezed(ends);
    const spot = walk.spots[j]!;
    if (own && spot.squeezed !== undefined) return spot.squeezed;
    const [piece, k, n] = spot.progress;
    return isSqueezed(onTrace(walk.entry.trace, piece, k === n, ends));
  };
}

/** The footprint at spot `j`, squeezed as its walk has it there (squeezeRule). */
function lightAt(walk: Walk, j: number): Light {
  const s = walk.spots[j]!;
  const t = walk.token;
  const out: Light = { sceneId: t.sceneId, size: t.size, x: s.x + walk.ox, y: s.y + walk.oy, elevation: 0 };
  if (t.w !== undefined) out.w = t.w;
  if (t.h !== undefined) out.h = t.h;
  if (walk.squeezedAt(j)) out.squeeze = true;
  return out;
}

/** The cells a walk's footprint covers at spot `j` (lightAt), written into `out` where it walks full size between its ends. On hexes, the cells its hexes' sub-cells lie in. */
function cellsAt(walk: Walk, j: number, out: CellRange): CellRange {
  // Only a token squeezed where it stands walks squeezed anywhere between (route.ts onTrace).
  if (isHex(walk.grid) || j === 0 || j === walk.spots.length - 1 || (walk.token.squeeze === true && walk.squeezedAt(j))) return occupiedRange(walk.grid, lightAt(walk, j));
  return rangeAtInto(out, walk.size.w, walk.size.h, walk.spots[j]!.x + walk.ox, walk.spots[j]!.y + walk.oy);
}

/** The token as it stands at spot `j`, for a moment. */
function placedAt(walk: Walk, j: number): Token {
  const last = placed.get(walk);
  if (last?.j === j) return last.token;
  const at = lightAt(walk, j);
  const out: Token = { ...walk.token, x: at.x, y: at.y, elevation: walk.elevation(j) };
  if (at.squeeze) out.squeeze = true;
  else if (out.squeeze !== undefined) delete out.squeeze;
  placed.set(walk, { j, token: out });
  return out;
}

/** Each walk's token as the last moment placed it, which a walk stopped or ended stands at for every moment after. */
const placed = new WeakMap<Walk, { j: number; token: Token }>();

/** The holder a named token is getting off, which carries it while the token stays inside it, by a link every player sees (5.2). */
function leaving(walk: Walk, before: RoomState, seen: (id: string) => boolean): Token | null {
  if (walk.holder) return null;
  const link = walk.token.attached;
  if (!link || !onHolder(link.kind) || !seen(walk.token.id)) return null;
  const holder = holderOf(before.tokens, walk.token) as Token | undefined;
  return holder && seen(holder.id) ? holder : null;
}

// ---------------------------------------------------------------------------
// Events (5.3, 5.4)

/** A member reaching a spot that sets a trap off. */
type TrapEvent = { trap: number; how: TrapHow; at: Progress; tokenId: string; walk: Walk };

function compareEvents(a: TrapEvent, b: TrapEvent): number {
  return compareProgress(a.at, b.at) || cmp(a.walk.group.named, b.walk.group.named) || cmp(a.tokenId, b.tokenId) || a.trap - b.trap;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A footprint's middle, where a wire is crossed from: on hexes its anchor (footprint.ts footprintRect). */
function centerOf(g: Grid, at: Light): { x: number; y: number } {
  const r = footprintRect(g, at);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** A trap's flags for one walk: the walk can set it off, it takes only creatures on the floor, it goes off on entering, on leaving. */
const CAN = 1;
const FLOOR = 2;
const ENTER = 4;
const LEAVE = 8;

/** One square set of the index as a walk reads it: the traps it can set off there on the floor, and off the floor, and whether they differ. */
type SetReading = Mix;

/**
 * The traps a walk can set off, as flags by trap, each square set read by
 * them, and the union of each mix of sets a footprint covers, shared by
 * the walks of a pass with the same flags. One list a mix, so a walk over
 * the same mix as its last spot steps onto and off nothing. `offFloor`
 * says whether any of them takes creatures off the floor.
 */
type Reading = { flags: Uint8Array; offFloor: boolean; sets: (SetReading | undefined)[]; unions: Map<number | string, readonly number[]>; mixes: Map<number, Mix>; members: Map<readonly number[], Uint8Array> };

/** What a footprint over some cells reads (walkEvents): the traps there on the floor and off it, and whether the floor rule tells them apart. */
type Mix = { off: readonly number[]; floor: readonly number[]; needs: boolean };

/** What the walks of one pass share: their readings, by flags and by what of a creature `setsOff` reads, and the scene's ground. */
type PassCache = { readings: Map<string, Reading>; byKind: Map<number, Reading | null>; ground: (r: CellRange) => number };

function passCache(before: RoomState, sceneId: string): PassCache {
  return { readings: new Map(), byKind: new Map(), ground: sceneGround(before.buildChunks, sceneId) };
}

/**
 * A walk's reading. `setsOff` reads only whether it is a creature, whether
 * it is Tiny and whether a player plays it, and the pass's spent traps stay
 * as they are while it reads its walks, so walks alike in those read alike.
 */
function readingOf(walk: Walk, index: TrapIndex, before: RoomState, spent: ReadonlySet<number>, cache: PassCache): Reading | null {
  const token = walk.token;
  const kind = (trapCreature(before, token) ? 1 : 0) | (sizeCategory(token) === "tiny" ? 2 : 0) | (playersToken(before, token) ? 4 : 0);
  const known = cache.byKind.get(kind);
  if (known !== undefined) return known;
  const read = readingFor(walk, index, before, spent, cache);
  cache.byKind.set(kind, read);
  return read;
}

function readingFor(walk: Walk, index: TrapIndex, before: RoomState, spent: ReadonlySet<number>, cache: PassCache): Reading | null {
  const traps = index.traps;
  const flags = new Uint8Array(traps.length);
  let any = false;
  let offFloor = false;
  for (let i = 0; i < traps.length; i++) {
    const rig = traps[i]!.rig!;
    if (spent.has(i) || !setsOff(rig, before, walk.token)) continue;
    flags[i] = CAN | (rig.floor ? FLOOR : 0) | (rig.on.includes("enter") ? ENTER : 0) | (rig.on.includes("leave") ? LEAVE : 0);
    any = true;
    if (!rig.floor) offFloor = true;
  }
  if (!any) return null;
  const key = flags.join("");
  let hit = cache.readings.get(key);
  if (!hit) cache.readings.set(key, (hit = { flags, offFloor, sets: [], unions: new Map(), mixes: new Map(), members: new Map() }));
  return hit;
}

/** Which traps a list of a reading holds, by trap. */
function membersOf(reading: Reading, list: readonly number[]): Uint8Array {
  let hit = reading.members.get(list);
  if (!hit) {
    hit = new Uint8Array(reading.flags.length);
    for (const i of list) hit[i] = 1;
    reading.members.set(list, hit);
  }
  return hit;
}

function setReading(reading: Reading, squares: SquareIndex, id: number): SetReading {
  let hit = reading.sets[id];
  if (!hit) {
    const floor: number[] = [];
    const off: number[] = [];
    for (const i of squares.sets[id]!) {
      const f = reading.flags[i]!;
      if (!(f & CAN)) continue;
      floor.push(i);
      if (!(f & FLOOR)) off.push(i);
    }
    // The same list when the floor changes nothing, which tells a spot it need not read its ground.
    reading.sets[id] = hit = { floor, off: off.length === floor.length ? floor : off, needs: off.length !== floor.length };
  }
  return hit;
}

/**
 * Every event of one walk against the scene's armed traps, in spot order.
 * Squares: a spot on the trap after one off it steps onto it, the reverse
 * steps off, a member being on it at a spot when one of its occupied cells
 * is a square of the zone and it passes the floor rule there. Wires:
 * crossed between two spots when the segment joining the footprint's
 * centers meets the wire and the first center is not on the wire's line,
 * by the exact orientation test, with the floor rule at the first spot.
 *
 * Only a spot over an armed square reads its cells, and its ground only
 * when a trap there takes creatures on the floor alone. A spot over the
 * same square set as the one before, on the same footing, yields the same
 * list, which steps onto and off nothing.
 */
function walkEvents(walk: Walk, index: TrapIndex, before: RoomState, seen: (id: string) => boolean, spent: ReadonlySet<number>, cache: PassCache): TrapEvent[] {
  const out: TrapEvent[] = [];
  const reading = readingOf(walk, index, before, spent, cache);
  // What its holder carries is never on the floor, so it sets off nothing where every trap it could takes only the floor.
  if (!reading || (walk.carriedOn && !reading.offFloor)) return out;
  const { flags } = reading;
  const traps = index.traps;
  const squares = index.squares;
  const spots = walk.spots;
  const last = spots.length - 1;
  const holder = leaving(walk, before, seen);
  // One range for every spot between the ends, which no reader keeps past the spot.
  const scratch: CellRange = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const rangeOf = (j: number): CellRange => cellsAt(walk, j, scratch);
  const floorAt = (j: number, r: CellRange): boolean => {
    if (walk.carriedOn) return false;
    if (holder && insideHolder(walk.grid, lightAt(walk, j), holder)) return false;
    // On hexes a footprint is its hexes, whose ground no range of cells reads (H3).
    if (isHex(walk.grid)) return standing(walk.elevation(j), footprintGround(before.buildChunks, lightAt(walk, j))) === "ground";
    return standing(walk.elevation(j), cache.ground(r)) === "ground";
  };
  const marks = new Int32Array(traps.length);
  let stamp = 0;
  const buffer: number[] = [];
  /** The union of the lists one side of these sets reads, one list a mix of sets (Reading.unions). */
  const unionOf = (first: number, more: readonly number[], floor: boolean, one: readonly number[]): readonly number[] => {
    const key = more.length === 1 ? (floor ? -1 : 1) * (first * 65536 + more[0]!) : `${floor ? "f" : "o"}${first},${more.join(",")}`;
    const known = reading.unions.get(key);
    if (known) return known;
    let union: number[] | null = null;
    for (const id of more) {
      const b = setReading(reading, squares!, id);
      const list = floor ? b.floor : b.off;
      if (list.length === 0 || list === one) continue;
      if (one.length === 0) {
        one = list;
        continue;
      }
      if (!union) {
        union = [...one];
        stamp++;
        for (const i of one) marks[i] = stamp;
      }
      for (const i of list) {
        if (marks[i] === stamp) continue;
        marks[i] = stamp;
        union.push(i);
      }
    }
    const out = union ?? one;
    reading.unions.set(key, out);
    return out;
  };
  // The distinct square sets under a footprint, gathered one key at a time: one under a creature of a square or less, a few under a larger one.
  let first = 0;
  let more: number[] | null = null;
  const gather = (id: number) => {
    if (id === 0 || id === first) return;
    if (first === 0) first = id;
    else if (!more) {
      // One buffer for every spot, which only this call reads.
      more = buffer;
      more.length = 0;
      more.push(id);
    } else if (!more.includes(id)) more.push(id);
  };
  /** What a footprint over these cells reads, on the floor and off it, and whether the floor rule tells them apart. */
  const mixOf = (x0: number, y0: number, x1: number, y1: number): Mix => {
    const sq = squares!;
    first = 0;
    more = null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x = sq.runEnd[y * sq.w + x]!) gather(sq.cells[y * sq.w + x]!);
    }
    return mixOfSets(first, more);
  };
  /** The mix of the sets a footprint gathered. */
  const mixOfSets = (first: number, more: number[] | null): Mix => {
    const sq = squares!;
    const a = setReading(reading, sq, first);
    if (!more) return a;
    let needs = a.needs;
    more.sort((p, q) => p - q);
    for (const id of more) if (!needs && setReading(reading, sq, id).needs) needs = true;
    const off = unionOf(first, more, false, a.off);
    return { off, floor: needs ? unionOf(first, more, true, a.floor) : off, needs };
  };
  let lx0 = -1;
  let ly0 = -1;
  let lx1 = -1;
  let ly1 = -1;
  let lastMix: Mix | null = null;
  /** On hexes a footprint reads each of its hexes by its key, at most 12 (docs/design/design-v1-hex-grids.md H2). */
  const onHexes = (j: number): readonly number[] => {
    const sq = squares!;
    const light = lightAt(walk, j);
    first = 0;
    more = null;
    for (const h of occupiedHexes(walk.grid as HexGrid, light)) if (h.col >= 0 && h.row >= 0 && h.col < sq.w && h.row < sq.h) gather(sq.cells[h.row * sq.w + h.col]!);
    if (first === 0) return NONE;
    const mix = mixOfSets(first, more);
    return mix.needs && floorAt(j, occupiedRange(walk.grid, light)) ? mix.floor : mix.off;
  };
  const onAt = (j: number): readonly number[] => {
    if (!squares) return NONE;
    if (isHex(walk.grid)) return onHexes(j);
    const r = rangeOf(j);
    const x0 = Math.max(0, r.x0);
    const y0 = Math.max(0, r.y0);
    const x1 = Math.min(squares.w, r.x1);
    const y1 = Math.min(squares.h, r.y1);
    if (x0 >= x1 || y0 >= y1) return NONE;
    const W = squares.w + 1;
    const sum = squares.sum;
    // The same cells as the spot before, as a small creature's half steps often are, read the same.
    if (x0 === lx0 && y0 === ly0 && x1 === lx1 && y1 === ly1) return lastMix!.needs && floorAt(j, r) ? lastMix!.floor : lastMix!.off;
    if (sum[y1 * W + x1]! - sum[y0 * W + x1]! - sum[y1 * W + x0]! + sum[y0 * W + x0]! === 0) return NONE;
    let mix: Mix;
    // A footprint of more than one square reads the same mix wherever the same cells lie under it, as walkers on one lane do, so its read is kept.
    // A scene is at most 200 squares a side, so the cells pack into one small integer.
    if ((x1 - x0 > 1 || y1 - y0 > 1) && x1 - x0 < 32 && y1 - y0 < 32 && x0 < 256 && y0 < 256) {
      const key = (x0 << 18) | (y0 << 10) | ((x1 - x0) << 5) | (y1 - y0);
      const known = reading.mixes.get(key);
      if (known) mix = known;
      else reading.mixes.set(key, (mix = mixOf(x0, y0, x1, y1)));
    } else mix = mixOf(x0, y0, x1, y1);
    lx0 = x0;
    ly0 = y0;
    lx1 = x1;
    ly1 = y1;
    lastMix = mix;
    return mix.needs && floorAt(j, r) ? mix.floor : mix.off;
  };
  const wires = walk.teleport ? [] : index.wires.filter((wire) => flags[wire.i]! & CAN);
  // Only a walk's first event for a trap can set it off: by any later one the trap has gone off, or the walk's group has stopped.
  const done = new Uint8Array(traps.length);
  let prevOn = onAt(0);
  for (let j = 1; j <= last; j++) {
    const on = onAt(j);
    // A spot over the same list as the one before steps onto and off nothing.
    if (on !== prevOn) {
      const was = membersOf(reading, prevOn);
      const now = membersOf(reading, on);
      const progress = spots[j]!.progress;
      for (const i of on) {
        if (was[i] || done[i] || !(flags[i]! & ENTER)) continue;
        done[i] = 1;
        out.push({ trap: i, how: "enter", at: progress, tokenId: walk.token.id, walk });
      }
      for (const i of prevOn) {
        if (now[i] || done[i] || !(flags[i]! & LEAVE)) continue;
        done[i] = 1;
        out.push({ trap: i, how: "leave", at: progress, tokenId: walk.token.id, walk });
      }
    }
    if (wires.length > 0) {
      const a = centerOf(walk.grid, lightAt(walk, j - 1));
      const b = centerOf(walk.grid, lightAt(walk, j));
      for (const wire of wires) {
        if (Math.max(a.x, b.x) < wire.x0 || Math.min(a.x, b.x) > wire.x1 || Math.max(a.y, b.y) < wire.y0 || Math.min(a.y, b.y) > wire.y1) continue;
        const { a: wa, b: wb } = (traps[wire.i]!.zone as { wire: { a: [number, number]; b: [number, number] } }).wire;
        if (orient(wa[0], wa[1], wb[0], wb[1], a.x, a.y) === 0) continue;
        if (contact(a.x, a.y, b.x, b.y, wa[0], wa[1], wb[0], wb[1]) === APART) continue;
        if (done[wire.i] || (flags[wire.i]! & FLOOR && !floorAt(j - 1, rangeOf(j - 1)))) continue;
        done[wire.i] = 1;
        out.push({ trap: wire.i, how: "cross", at: spots[j]!.progress, tokenId: walk.token.id, walk });
      }
    }
    prevOn = on;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Springings

/** One trap going off (5.4), with everything the reducer writes for it, frozen at its moment (5.6). */
export type Springing = {
  trap: Trap;
  how: TrapHow;
  /** The public pass, or the private one (5.5). The DM's Set it off goes off as a public one. */
  pass: "public" | "private";
  /** Every creature that set it off at that moment, by id. */
  by: string[];
  /** Who it hits, every creature at the moment, by id. */
  hits: string[];
  /** A public springing any creature that set it off was seen at by players who do not own it (6.4). */
  perceived: boolean;
  /** Of `by`, those players who do not own them could see at the moment. */
  seen: ReadonlySet<string>;
  /** Of `by`, those a player plays, whom players always see. */
  party: ReadonlySet<string>;
};

/** What the trap step found in a move: what went off, in order, and the op with its stopped landings (13.2 step 1). */
export type MovePlan = { springings: Springing[]; op: Op };

/**
 * Where a stopped group stops, as progress along its walk (`s`), and the
 * progress past which what it meets no longer counts and the moments read
 * it at its stop (`until`): the stop itself, or for an op stored before
 * version 17 the event that stopped it (migrate.ts stopsOnTrap). `back`
 * holds the spot each walk stepped back to off the creatures ahead of it
 * in single file, and what rides on those (`fileApart`). `at` holds where
 * a walk stands at its spot there where that is not the spot itself: one
 * in single file on its snapped stand, and what rides on it (`stopPose`).
 */
type Stop = { until: Progress; s: Progress; back?: ReadonlyMap<Walk, number>; at?: ReadonlyMap<Walk, Token> };

/**
 * The trap step's plan of a move (13.2 step 1): both passes, their events,
 * the stops, and who each springing hits at its moment. Reads only the op
 * and the room before it, so replay plans the same. `op` is the op with
 * each stopped group's landing and route cut, which dispatch then moves.
 */
export function planTrapMove(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }, pitOpens?: (trap: Trap) => boolean): MovePlan {
  const parts = trapMoveParts(op, before, actor, env, pitOpens);
  return parts ? { springings: parts.springings, op: parts.op } : { springings: [], op };
}

/**
 * Where the trap step's walks leave each token a move walks (5.6): a
 * stopped group at its stop, every other walk at its end, the public
 * walks on the op's own and the rest on the walks its cut leaves. Dispatch
 * puts each token there, which the tests check. Empty where no trap is on
 * the scene, as the trap step then reads no walk.
 */
export function trapLandings(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }): Map<string, { x: number; y: number; elevation: number }> {
  const out = new Map<string, { x: number; y: number; elevation: number }>();
  const parts = trapMoveParts(op, before, actor, env);
  if (!parts) return out;
  const pose = (walk: Walk, j: number) => {
    const t = placedAt(walk, j);
    out.set(walk.token.id, { x: t.x, y: t.y, elevation: t.elevation });
  };
  for (const walk of parts.walks.all) {
    if (!walk.isPublic) continue;
    const stop = parts.stops.get(walk.group.named);
    const moved = stop?.at?.get(walk);
    if (moved) out.set(walk.token.id, { x: moved.x, y: moved.y, elevation: moved.elevation });
    else pose(walk, stop ? stopIndex(walk, stop) : walk.spots.length - 1);
  }
  for (const walk of (parts.rest ?? parts.walks).all) if (!walk.isPublic) pose(walk, walk.spots.length - 1);
  // A stop that stands the named token squeezed short of its walk's end lands it on the ground under its squeezed footprint, as
  // every landing does (cutOp), where its walk read the ground under its full one. No moment reads it there after its stop.
  const cut = parts.op;
  const named = cut.t === "token.move" && cut.squeeze === true && cut.elevation !== undefined && parts.stops.has(cut.tokenId) ? out.get(cut.tokenId) : undefined;
  if (named && cut.t === "token.move" && cut.elevation !== undefined) out.set(cut.tokenId, { ...named, elevation: cut.elevation });
  return out;
}

/** The trap step's plan of a move with the walks it read and its stops, or null where it reads none. `rest` is null with no private pass. */
function trapMoveParts(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }, pitOpens?: (trap: Trap) => boolean): { springings: Springing[]; op: Op; walks: Walks; stops: Map<string, Stop>; rest: Walks | null } | null {
  const sceneId = walkScene(op, before);
  if (sceneId === null || !walkOp(op)) return null;
  const index = trapIndex(before, sceneId);
  if (index.traps.length === 0) return null;
  const onScene = (e: MovedToken) => e.from.sceneId === sceneId && e.to.sceneId === sceneId;
  const entries = trapPlan(op, before, actor, env).filter(onScene);
  if (entries.length === 0) return null;
  const seen = seenByAll(before, env);
  const walks = walksOf(op, before, entries, seen, env.opVersion);
  const spent = new Set<number>();
  const springings: Springing[] = [];

  // The public pass (5.5): only creatures and links seen by all decide what other viewers observe.
  const pub = passCache(before, sceneId);
  const events = byTrap(walks.all.filter((w) => w.isPublic), (walk) => walkEvents(walk, index, before, seen, spent, pub));
  const stops = new Map<string, Stop>();
  const forward = stopsOnTrap(env.opVersion);
  // A stopped group walks on to its stop, so what it meets up to there counts, and nothing after.
  const after = (e: TrapEvent) => {
    const stop = stops.get(e.walk.group.named);
    return stop !== undefined && compareProgress(e.at, stop.until) > 0;
  };
  const nextPublic = picker(events, spent, (e) => !after(e), () => stops.size);
  for (let event = nextPublic(); event !== null; event = nextPublic()) {
    // Every creature whose event for this trap falls at this same progress sets it off with it (5.4).
    const together = sameMoment(events.get(event.trap)!, event, after);
    spent.add(event.trap);
    const trap = index.traps[event.trap]!;
    if (trap.rig!.stops) {
      const pit = forward ? opening(trap, before, pitOpens) : null;
      for (const hit of together) {
        const group = hit.walk.group;
        if (!hit.walk.walker || stops.has(group.named) || !cuts(op, walks, group)) continue;
        const s = forward ? stopAt(walks, group, event.at, before, seen, pit ? { walk: hit.walk, over: pit } : null) : stopBefore(walks, group, event.at, before, seen);
        // A stop where the group was going anyway changes nothing, so it is no stop (6.5).
        if (compareProgress(s, endOf(group)) >= 0) continue;
        const back = fileApart(walks, group, s, before, seen);
        const stop: Stop = { until: forward ? s : event.at, s, ...(back ? { back } : {}) };
        const at = stopPoses(walks, group, stop, before, seen);
        stops.set(group.named, at ? { ...stop, at } : stop);
      }
    }
    springings.push(springingIn(trap, event.how, "public", together, momentAt(before, walks.byId, event.at, stops), env));
  }

  // The private pass (5.5): every other creature, on the walks the public pass left, each on its own step. It never stops.
  const cut = stops.size > 0 ? cutOp(op, walks, stops, before, seen) : op;
  // A move with no walk players cannot see has no private pass, so its cut op needs no walks of its own.
  if (!walks.all.some((w) => !w.isPublic)) return { springings, op: cut, walks, stops, rest: null };
  const rest = cut === op ? walks : walksOf(cut, before, trapPlan(cut, before, actor, env).filter(onScene), seen, env.opVersion);
  const priv = passCache(before, sceneId);
  const hidden = byTrap(rest.all.filter((w) => !w.isPublic), (walk) => walkEvents(walk, index, before, seen, spent, priv));
  const never = () => false;
  const nextPrivate = picker(hidden, spent, () => true, () => 0);
  for (let event = nextPrivate(); event !== null; event = nextPrivate()) {
    const together = sameMoment(hidden.get(event.trap)!, event, never);
    spent.add(event.trap);
    springings.push(springingIn(index.traps[event.trap]!, event.how, "private", together, momentAt(before, rest.byId, event.at, new Map()), env));
  }
  return { springings, op: cut, walks, stops, rest };
}

/**
 * The walks of a move the trap step reads (moveLeg.ts walkedIn): each
 * token the move writes, and from op version 38 each in single file and
 * what carries it, though its walk ends where it started, since it walks
 * its holder's line on the way, a stop between the ends leaves it there,
 * and the trap group is the lead's whatever moved. By its place such a
 * walk keeps its holder's loop, which ends where it started, as before.
 */
function trapPlan(op: Op, before: RoomState, actor: Viewer, env: { opVersion?: number }): MovedToken[] {
  const plan = planWalks(op, before, actor, env);
  return plan.filter(walkedIn(plan));
}

/**
 * What the trap step reads of a move, token by token: which pass it walks
 * in, whether it is a walker, its step, and the spots it passes, the start
 * first, for the tests. The drag label reads which traps a drag crosses on
 * its own (client/features/traps/rules.ts crossedTraps).
 */
export function trapWalks(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }): { tokenId: string; group: string; isPublic: boolean; walker: boolean; step: number; spots: { x: number; y: number; progress: Progress }[] }[] {
  const sceneId = walkScene(op, before);
  if (sceneId === null || !walkOp(op)) return [];
  const entries = trapPlan(op, before, actor, env).filter((e) => e.from.sceneId === sceneId && e.to.sceneId === sceneId);
  const walks = walksOf(op, before, entries, seenByAll(before, env), env.opVersion);
  return walks.all
    .map((w) => ({ tokenId: w.token.id, group: w.group.named, isPublic: w.isPublic, walker: w.walker, step: w.step, spots: w.spots.map((_, j) => spotAt(w, j)) }))
    .sort((a, b) => cmp(a.tokenId, b.tokenId));
}

function spotAt(walk: Walk, j: number): { x: number; y: number; progress: Progress } {
  const s = walk.spots[j]!;
  return { x: s.x + walk.ox, y: s.y + walk.oy, progress: s.progress };
}

/** The events at the same progress as `events[from]` that `take` keeps, one per creature. */
function sameMoment(list: readonly TrapEvent[], event: TrapEvent, after: (e: TrapEvent) => boolean): TrapEvent[] {
  const at = list.filter((e) => compareProgress(e.at, event.at) === 0 && !after(e)).sort(compareEvents);
  const out: TrapEvent[] = [];
  const ids = new Set<string>();
  for (const e of at) {
    if (ids.has(e.tokenId)) continue;
    ids.add(e.tokenId);
    out.push(e);
  }
  return out;
}

/** Each trap's events, in the order the walks gave them. */
function byTrap(walks: readonly Walk[], eventsOf: (walk: Walk) => TrapEvent[]): Map<number, TrapEvent[]> {
  const out = new Map<number, TrapEvent[]>();
  for (const walk of walks) {
    for (const e of eventsOf(walk)) {
      let list = out.get(e.trap);
      if (!list) out.set(e.trap, (list = []));
      list.push(e);
    }
  }
  return out;
}

/**
 * The event that sets the next trap off (5.4): of the traps not spent, the
 * earliest event that still counts, by compareEvents, so the order a sort
 * of every event would give without sorting them. Each trap's earliest is
 * kept until `version` moves, as a new stop moves it, the only thing that
 * makes an event stop counting.
 */
function picker(events: ReadonlyMap<number, readonly TrapEvent[]>, spent: ReadonlySet<number>, counts: (e: TrapEvent) => boolean, version: () => number): () => TrapEvent | null {
  const first = new Map<number, TrapEvent | null>();
  let known = version();
  return () => {
    if (version() !== known) {
      first.clear();
      known = version();
    }
    let best: TrapEvent | null = null;
    for (const [trap, list] of events) {
      if (spent.has(trap)) continue;
      let e = first.get(trap);
      if (e === undefined) {
        e = null;
        for (const x of list) if (counts(x) && (e === null || compareEvents(x, e) < 0)) e = x;
        first.set(trap, e);
      }
      if (e !== null && (best === null || compareEvents(e, best) < 0)) best = e;
    }
    return best;
  };
}

/**
 * Where a group stops (5.5): the first progress at or after `t` where
 * every walker of the group stands on a spot with `stand`, movement's rule
 * that it may stop there, each walker on its own offset route at the
 * group's step. So a walker that sets a trap off on a spot it may not stop
 * at, a Large creature's half step onto a stopping trap, goes on to the
 * next it may stop at (review LP13-TR-2). With no such spot before the
 * walk's end, the group walks to its end, which is no stop. From op
 * version 36 a walker stands there between its walk's ends only full
 * size, never on a squeeze, even along the first piece of a walk that
 * starts squeezed, where its trace keeps the squeeze, since walls under
 * the fog decide where a narrow space lets it squeeze (D-261101-181,
 * migrate.ts stopsStandFullSize). So a Large creature on a stopping trap
 * in a corridor narrower than it walks on to where it stands full size.
 *
 * A pit that opens (`pit`) first asks for the first such progress where
 * the walker that set it off lies wholly over the opening, so a creature
 * that fits in it falls to the bottom with what it carries (review
 * FU20A-OP-2). One too big for the opening, or whose walk never covers it
 * whole, stops at the first spot it may stand, and stays at the rim.
 */
function stopAt(walks: Walks, group: Group, t: Progress, before: RoomState, seen: (id: string) => boolean, pit: { walk: Walk; over: (spot: RouteSpot, walk: Walk) => boolean } | null): Progress {
  const stands = walks.all.filter((w) => w.group === group && w.walker).map((w) => standSpots(walks, w, before, seen));
  const end = endOf(group);
  const trigger = pit ? standSpots(walks, pit.walk, before, seen) : null;
  const overAt = (p: Progress) => trigger === null || (trigger.walk.length > 0 && pit!.over(trigger.spot(latestIndex(trigger.walk, p)), pit!.walk));
  const first = (fits: (p: Progress) => boolean): Progress | null => {
    // One walker, as most groups are: its own spots on from the event, each asked whether it stands only as the search reaches it.
    if (stands.length === 1) {
      const one = stands[0]!;
      for (let i = firstIndex(one.walk, t); i < one.walk.length; i++) if (one.spot(i).stand && fits(one.walk[i]!.progress)) return one.walk[i]!.progress;
      return null;
    }
    const candidates: Progress[] = [];
    for (const one of stands) for (const w of one.walk) if (compareProgress(w.progress, t) >= 0) candidates.push(w.progress);
    candidates.sort(compareProgress);
    for (const s of candidates) if (stands.every((one) => standsAt(one, s)) && fits(s)) return s;
    return null;
  };
  return (trigger ? first(overAt) : null) ?? first(() => true) ?? end;
}

/**
 * The squares a stopping trap's pit opens on (5.7), when it opens: a pit on
 * squares not yet at its floor, which `opens`, the action's own test, says
 * the caps let open. A spot lies over it when every square its footprint
 * covers, squeezed where it squeezes, is one of them, and on a hex scene
 * every hex (H3).
 */
function opening(trap: Trap, before: RoomState, opens?: (trap: Trap) => boolean): ((spot: RouteSpot, walk: Walk) => boolean) | null {
  const pit = trap.rig?.pit;
  if (!pit || !("cells" in trap.zone) || pitOpen(before.buildChunks, trap.sceneId, trap.zone.cells, pit)) return null;
  // The action's own test of whether the pit opens (reducer/traps.ts pitOpens): one the caps keep shut moves no walker over it.
  if (opens && !opens(trap)) return null;
  const squares = new Set<string>();
  for (const r of trap.zone.cells) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) squares.add(`${x},${y}`);
  const g = gridOfScene(before, trap.sceneId);
  return (spot, walk) => {
    const { squeeze: _squeeze, ...token } = walk.token;
    // Where it would stand there: a creature in single file stands on its snapped spot (route.ts StandRule.snaps).
    const where = spot.snapped ?? spot;
    const at: PlacedToken = { ...token, x: where.x, y: where.y, ...(spot.squeezed ? { squeeze: true } : {}) };
    if (isHex(g)) return occupiedHexes(g, at).every((h) => squares.has(hexKey(h)));
    const r = footprintRect(SQUARES, at);
    for (let y = Math.floor(r.y + 1e-9); y < Math.ceil(r.y + r.h - 1e-9); y++) for (let x = Math.floor(r.x + 1e-9); x < Math.ceil(r.x + r.w - 1e-9); x++) if (!squares.has(`${x},${y}`)) return false;
    return true;
  };
}

/**
 * Where a group stopped by an op stored before version 17 stops
 * (migrate.ts stopsOnTrap): the latest progress at or before `t` where
 * every walker of the group stands on a spot with `stand`, progress 0,
 * where the group stood, a stand by definition.
 */
function stopBefore(walks: Walks, group: Group, t: Progress, before: RoomState, seen: (id: string) => boolean): Progress {
  const stands = walks.all.filter((w) => w.group === group && w.walker).map((w) => standSpots(walks, w, before, seen));
  if (stands.length === 1) {
    const one = stands[0]!;
    for (let i = latestIndex(one.walk, t); i > 0; i--) if (compareProgress(one.walk[i]!.progress, t) <= 0 && one.spot(i).stand) return one.walk[i]!.progress;
    return START;
  }
  const candidates: Progress[] = [START];
  for (const one of stands) for (const w of one.walk) if (compareProgress(w.progress, t) <= 0) candidates.push(w.progress);
  candidates.sort((a, b) => compareProgress(b, a));
  for (const s of candidates) if (stands.every((one) => standsAt(one, s))) return s;
  return START;
}

/** The index of the first spot at or after `p`, past the last when none is. */
function firstIndex(spots: readonly { progress: Progress }[], p: Progress): number {
  if (spots.length === 0) return 0;
  const i = latestIndex(spots, p);
  return compareProgress(spots[i]!.progress, p) < 0 ? i + 1 : i;
}

/** Whether a walk's latest spot at or before `p` is one it may stop at, or it has none there. */
function standsAt(one: Stands, p: Progress): boolean {
  if (one.walk.length === 0 || compareProgress(one.walk[0]!.progress, p) > 0) return true;
  return one.spot(latestIndex(one.walk, p)).stand;
}

/** Whether a stop can cut this group's move (cutOp): a walk a move or a group move names. A teleport, a Get off and a landing land where they asked. */
function cuts(op: Op, walks: Walks, group: Group): boolean {
  if (op.t !== "token.move" && op.t !== "token.moveMany") return false;
  return walks.byId.get(group.named)?.teleport === false;
}

/** Where a group's walk ends, as its stops count along it. */
function endOf(group: Group): Progress {
  return group.base(group.step).at(-1)?.progress ?? START;
}

/**
 * A walk's spots with `stand` (route.ts routeStands), on its own route at
 * its group's step, worked out once a walk: a stop's search and its cut
 * read the same. A teleport's landing is the op's own.
 */
function standSpots(walks: Walks, walk: Walk, before: RoomState, seen: (id: string) => boolean): Stands {
  const known = walks.stands.get(walk);
  if (known) return known;
  let stands: Stands;
  if (walk.teleport) {
    const spots: RouteSpot[] = walk.spots.map((s, j) => ({ ...s, x: s.x + walk.ox, y: s.y + walk.oy, squeezed: walk.squeezedAt(j), stand: true }));
    stands = { walk: spots, spot: (i) => spots[i]! };
  } else {
    // A walker with a holder in the op walks as its trace has it, as itself and never squeezed (route.ts followerTrace): a creature
    // its holder drags beside it, or one on a holder some player cannot see.
    const token = walk.holder ? walk.entry.trace[0]! : walkerFor(before, walk.token, (t) => seen(t.id), { opVersion: walks.opVersion, to: walk.entry.to });
    // The group's head walks its group's own walk at its step, so its spots are already there.
    const head = walk.entry === walk.group.head && walk.step === walk.group.step;
    const full = standRule(walks, before, walk.token.sceneId);
    // A creature in single file walks its holder's middle, off its own grid behind a larger holder, so it is judged on its grid beside it.
    const own = walk.holder ? (snapsInFile(walks, walk) ? { ...full, snaps: true } : full) : { ...full, squeeze: walk.squeezeAtEnd };
    stands = routeStands(storedBuild(before, walks.opVersion), walk.entry.route, token, walk.group.step, own, head ? walk.group.base(walk.group.step) : undefined);
  }
  walks.stands.set(walk, stands);
  return stands;
}

/**
 * How a stop judges a walk's spots between its ends, by the op's version:
 * from 36 only full size, from 37 by the ground every player sees
 * (route.ts StandRule, migrate.ts stopsOnPublicGround), and from 52 a
 * point core by the squares it covers there (migrate.ts
 * stopsByCoveredSquares).
 */
function standRule(walks: Walks, before: RoomState, sceneId: string): StandRule {
  const rule: StandRule = { fullBetween: stopsStandFullSize(walks.opVersion), ...(stopsStandClear(walks.opVersion) ? { fullStand: true } : {}) };
  if (!stopsOnPublicGround(walks.opVersion)) return rule;
  let ground = walks.grounds.get(sceneId);
  if (!ground) walks.grounds.set(sceneId, (ground = groundMaker(before, sceneId)));
  return { ...rule, publicGround: ground, ...(stopsByCoveredSquares(walks.opVersion) ? { covers: true } : {}) };
}

/** Whether a walk is one in single file on squares that a stop judges on its own grid's spots, from op version 52 (migrate.ts fileStandsSnapped). */
function snapsInFile(walks: Walks, walk: Walk): boolean {
  return inSingleFile(walk) && !isHex(walk.grid) && fileStandsSnapped(walks.opVersion);
}

/**
 * The index of the latest spot at or before `p`, the start when none is.
 * Spots run in progress order, so it halves its way there: a moment reads
 * every walk of the op, 500 walks of up to 664 spots at 50 springings.
 */
function latestIndex(spots: readonly { progress: Progress }[], p: Progress): number {
  let lo = 0;
  let hi = spots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (compareProgress(spots[mid]!.progress, p) <= 0) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The room as an event saw it (5.6): every token of the op on its latest
 * spot at or before the event's progress, a group stopped earlier at its
 * stop, everything else as before the op. Read only as far as a springing
 * needs: a token asked for is placed alone, and the whole room is built
 * only for what reads other tokens, the party's sight on a vision scene
 * and an area's hits. So a walk builds no room copy per spot, and most
 * springings none at all.
 */
type Moment = { before: RoomState; walks: ReadonlyMap<string, Walk>; p: Progress; stops: ReadonlyMap<string, Stop>; room?: RoomState };

function momentAt(before: RoomState, walks: ReadonlyMap<string, Walk>, p: Progress, stops: ReadonlyMap<string, Stop>): Moment {
  return { before, walks, p, stops };
}

/** The spot a walk is on at the moment. */
function spotIn(m: Moment, walk: Walk): number {
  const stop = m.stops.get(walk.group.named);
  return stop && compareProgress(m.p, stop.until) > 0 ? stopIndex(walk, stop) : latestIndex(walk.spots, m.p);
}

/** Where a walk stands at the moment off its spot, as its group's stop leaves it there (`Stop.at`). */
function movedIn(m: Moment, walk: Walk): Token | undefined {
  const stop = m.stops.get(walk.group.named);
  return stop?.at && compareProgress(m.p, stop.until) > 0 ? stop.at.get(walk) : undefined;
}

function tokenAt(m: Moment, id: string): Token | undefined {
  const walk = m.walks.get(id);
  return walk ? (movedIn(m, walk) ?? placedAt(walk, spotIn(m, walk))) : ownEntry(m.before.tokens, id);
}

function roomAt(m: Moment): RoomState {
  if (!m.room) {
    const tokens = { ...m.before.tokens };
    for (const walk of m.walks.values()) tokens[walk.token.id] = movedIn(m, walk) ?? placedAt(walk, spotIn(m, walk));
    m.room = { ...m.before, tokens };
  }
  return m.room;
}

/**
 * The op with each stopped group's named token landing at its stop, its
 * route cut there, squeezed where that spot is (5.5): the named token's own
 * walk at its group's step, where every walker's stand was judged. A Get off
 * and a landing from the height controls take one step, so neither is cut.
 */
function cutOp(op: Op, walks: Walks, stops: ReadonlyMap<string, Stop>, before: RoomState, seen: (id: string) => boolean): Op {
  const landing = (named: string): (RouteSpot & { elevation: number }) | null => {
    const stop = stops.get(named);
    const group = walks.groups.get(named);
    const walk = walks.byId.get(named);
    if (!stop || !group || !walk || walk.teleport) return null;
    const token = walkerFor(before, walk.token, (t) => seen(t.id), { opVersion: walks.opVersion, to: walk.entry.to });
    const squeeze = op.t === "token.move" && op.tokenId === named && op.squeeze === true;
    // The named token's own walk, as its stop's search read it when it walks as the group's head.
    const stands = walk.holder ? routeStands(storedBuild(before, walks.opVersion), group.head.route, token, group.step, { squeeze, ...standRule(walks, before, walk.token.sceneId) }) : standSpots(walks, walk, before, seen);
    if (stands.walk.length === 0) return null;
    const i = latestIndex(stands.walk, stop.s);
    const at = stands.spot(i);
    // A walk on the ground reads the ground under the footprint its trace has there (route.ts routeWalk), and a stop squeezed there lands on the ground under the squeezed one, as every landing does (movement's landedElevation).
    if (!at.squeezed || i === stands.walk.length - 1 || footing(before.buildChunks, token) !== "ground") return at;
    return { ...at, elevation: footprintGround(before.buildChunks, { ...token, x: at.x, y: at.y, squeeze: true }) };
  };
  switch (op.t) {
    case "token.move": {
      const at = landing(op.tokenId);
      if (!at) return op;
      const { route, squeeze: _squeeze, ...rest } = op;
      const next = { ...rest, x: at.x, y: at.y, elevation: at.elevation, ...(at.squeezed ? { squeeze: true as const } : {}) };
      const pieces = route ? cutRoute(route, at.progress, at) : [];
      const cut = pieces.length > 0 ? { ...next, route: pieces as [number, number, number, 0 | 1][] } : next;
      // A walk with no route is one straight piece, so the cut walk has a point more than its pieces, and two at the least.
      const points = Math.max(pieces.length, 1) + 1;
      const kept = cutWalks(walks, op.tokenId, stops.get(op.tokenId)!, points, before);
      return withTrapCut(cut, new Set(stops.keys()), kept.file, kept.own);
    }
    case "token.moveMany": {
      // Each named token of a group move walks one straight piece, so each cut walk has two points, and none walks in single file.
      const own = new Map<string, RoutePoint[]>();
      for (const [named, stop] of stops) for (const [id, route] of cutWalks(walks, named, stop, 2, before).own ?? []) own.set(id, route);
      return withTrapCut(
        {
          ...op,
          moves: op.moves.map((m) => {
            const at = landing(m.tokenId);
            return at ? { ...m, x: at.x, y: at.y, elevation: at.elevation } : m;
          }),
        },
        new Set(stops.keys()),
        null,
        own.size > 0 ? own : null,
      );
    }
    default:
      return op;
  }
}

/** Whether a walk is one in single file (moveLeg.ts singleFile). */
function inSingleFile(walk: Walk): boolean {
  return walk.entry.file === true;
}

/**
 * Whether a trap's cut keeps a walk of its own beside those in single file
 * (moveLeg.ts withTrapCut, review FU45B-ASTRA-10): from op version 38 (migrate.ts
 * stopsStandClear), each walker every player sees on a route of its own,
 * as one a holder they cannot see drags or carries, and each such walker
 * under a holder they cannot see whatever its route. The stop judged its
 * stand there, so the cut lands it there, never by its holder's cut and its
 * place, where no stand test judged it and the private pass may stop the
 * holder short. What seats one of them that players cannot see keeps its
 * walk too, at the same step (`seatsOfSeen`, review FU45B-ASTRA-11).
 */
function keepsOwn(walk: Walk): boolean {
  if (inSingleFile(walk)) return false;
  // One every player sees under a holder they cannot see keeps its walk even where it is its group's walk offset by its place, so
  // no wall the private pass reads where its holder stops moves it (review FU45B-ASTRA-12).
  if (walk.isPublic && walk.walker) return walk.own || (walk.holder !== undefined && !walk.holder.isPublic);
  return walk.seatsSeen && walk.own;
}

/**
 * The walks a trap's cut keeps for a stopped group (moveLeg.ts withTrapCut):
 * those in single file (review FU45B-ASTRA-01), and from op version 38
 * the walks of their own (`keepsOwn`). Each is its own walk to its latest
 * spot at or before the stop, where the stop judged it stands and the
 * springings read it, so the cut moves them where the trap step had them,
 * never by their places, each at the height the trap step had it at there,
 * so one that has not moved yet keeps its own (review FU45B-ASTRA-06). A
 * holder players cannot see that seats a creature stops where every seat
 * on it holds (`seatingWalk`). Each takes `points` points, index by index
 * with its holder's cut walk, holding at its spot once there. Null where
 * none walks so.
 */
function cutWalks(walks: Walks, named: string, stop: Stop, points: number, before: RoomState): { file: Map<string, RoutePoint[]> | null; own: Map<string, RoutePoint[]> | null } {
  const group = walks.groups.get(named);
  const own = stopsStandClear(walks.opVersion);
  const file = new Map<string, RoutePoint[]>();
  const kept = new Map<string, RoutePoint[]>();
  const routes = new Map<Walk, RoutePoint[]>();
  for (const walk of walks.all) {
    if (walk.group !== group) continue;
    const into = inSingleFile(walk) ? file : own && keepsOwn(walk) ? kept : null;
    if (!into) continue;
    const route = walkToStop(walk, stop);
    into.set(walk.token.id, route);
    routes.set(walk, route);
  }
  if (routes.size === 0) return { file: null, own: null };
  // What sits on each token, walked or not: one that ended where it started rides on too where a cut moves its holder.
  const seated = new Map<string, Token[]>();
  for (const t of Object.values(before.tokens)) if (t?.attached && onHolder(t.attached.kind)) seated.set(t.attached.to, [...(seated.get(t.attached.to) ?? []), t]);
  const landed = new Map([...routes].map(([w, route]) => [w.token.id, route]));
  // From the bottom up, so a holder seats what it carries where that has landed. One every player sees stands where the stop
  // judged it, and what rides on it with no walk of its own rides on wherever it stops.
  for (const walk of [...routes.keys()].reverse()) {
    const riders = seated.get(walk.token.id);
    if (walk.isPublic || !riders) continue;
    const on = riders.flatMap((t) => (landed.has(t.id) ? [{ token: t, at: landed.get(t.id)!.at(-1)! }] : []));
    const route = seatingWalk(walk, stopIndex(walk, stop), on, isHex(walk.grid) && followsInSingleFileOnHexes(walks.opVersion));
    routes.set(walk, route);
    (inSingleFile(walk) ? file : kept).set(walk.token.id, route);
    landed.set(walk.token.id, route);
  }
  for (const route of routes.values()) {
    while (route.length < points) route.push(route[route.length - 1]!);
    route.length = points;
  }
  return { file: file.size > 0 ? file : null, own: kept.size > 0 ? kept : null };
}

/** A walk's own route to its spot at the stop (`stopIndex`), that spot where and as high as the trap step had it there (`Stop.at`). */
function walkToStop(walk: Walk, stop: Stop): RoutePoint[] {
  return walkTo(walk, stopIndex(walk, stop), stop.at?.get(walk));
}

/** A walk's spot at its group's stop: its latest at or before it, or the one it stepped back to (`fileApart`). */
function stopIndex(walk: Walk, stop: Stop): number {
  return stop.back?.get(walk) ?? latestIndex(walk.spots, stop.s);
}

/**
 * Where a stop between a walk's ends leaves each creature in single file
 * (TRAP-STOP-STACK, D-261101-399, migrate.ts stopsFileApart). Between
 * corners the file walks its holder's own line at the same progress, so at
 * the stop each stood on its holder's square. From op version 41 each, in
 * the file's order (route.ts fileOrder), steps back along its own walk,
 * whose spots the trap step already walked, to the latest one where it may
 * stop (`standsAt`, the stop's own test) and its box clears the boxes of
 * the stopped holder and of those ahead of it, on hexes where it shares no
 * hex with them (D-261107-172). With none, it keeps the stop's spot. What
 * rides on one comes back with it, at the same progress.
 *
 * Each class of the file is worked out by itself, those every player sees
 * first, so none of their spots reads a walk they cannot see. Where its
 * steps leave a drag of the class out of reach (attach.ts linkHolds), none
 * of the class steps back, as before. Each one players cannot see then
 * takes the latest spot it may stop at in its holder's reach instead, since
 * a public holder ahead of it may have stepped back, and lets go only where
 * none is. One every player sees that a hidden creature in the file
 * carries steps back with the public class on its own kept walk
 * (`keepsOwn`), and the hidden holders under it stop at the same progress,
 * where `seatingWalk` holds its seat as at any stop.
 *
 * The moments after the stop, the cut and the landing read these spots,
 * and the private pass walks the cut, so it finds a hidden one there too.
 * What one met on the way up to the stop still counts, since it walked
 * there before it stepped back. Undefined where nothing steps back.
 */
function fileApart(walks: Walks, group: Group, s: Progress, before: RoomState, seen: (id: string) => boolean): Map<Walk, number> | undefined {
  if (!stopsFileApart(walks.opVersion)) return undefined;
  const lead = walks.byId.get(group.named);
  const file = walks.all.filter((w) => w.group === group && inSingleFile(w));
  if (!lead || file.length === 0) return undefined;
  // One every player sees that a hidden creature in the file carries walks a kept walk of its own on that one's line (keepsOwn).
  const aboard = (w: Walk) => {
    if (!w.isPublic || !w.walker || !keepsOwn(w) || !w.holder || w.holder.isPublic) return false;
    for (let at: Walk | undefined = w.holder; at; at = at.holder) if (inSingleFile(at)) return true;
    return false;
  };
  const seenAboard = walks.all.filter((w) => w.group === group && aboard(w));
  const byId = new Map([...file, ...seenAboard].map((w) => [w.token.id, w]));
  const classes = [[...file.filter((w) => w.entry.pass === "public"), ...seenAboard], file.filter((w) => w.entry.pass !== "public")].map((c) => fileOrder(lead.token, c.map((w) => w.token)).map((t) => byId.get(t.id)!));
  const back = new Map<Walk, number>();
  // The hidden holders up to the file under one every player sees, which stop where it does so it keeps its seat (seatingWalk).
  const following = new Set<Walk>();
  const latest = (w: Walk) => latestIndex(w.spots, s);
  const rides = (w: Walk) => {
    const kind = w.token.attached?.kind;
    return w.holder !== undefined && !inSingleFile(w) && !keepsOwn(w) && kind !== undefined && onHolder(kind);
  };
  // The spot a walk stands on at the stop: what rides on one that stepped back comes with it, at the same progress.
  const indexOf = (w: Walk): number => {
    const own = back.get(w);
    if (own !== undefined) return own;
    if (rides(w)) {
      const h = indexOf(w.holder!);
      if (h !== latest(w.holder!)) return latestIndex(w.spots, w.holder!.spots[h]!.progress);
    }
    return latest(w);
  };
  const settings = before.meta.settings;
  // Where each stands at its spot, on its snapped stand in the file (`stopPose`).
  const poseAt = (w: Walk, j: number) => stopPose(walks, w, j, indexOf, before, seen) ?? placedAt(w, j);
  const drags = (w: Walk) => !inSingleFile(w) || !w.holder || linkHolds(w.grid, settings, "drag", poseAt(w, indexOf(w)), poseAt(w.holder, indexOf(w.holder)));
  // The latest spot of its walk at or before the stop that it may stop at in its holder's reach, the stop's spot without one.
  const inReach = (w: Walk) => {
    const stands = standSpots(walks, w, before, seen);
    for (let i = latest(w); i >= 0; i--) {
      back.set(w, i);
      if (standsAt(stands, w.spots[i]!.progress) && drags(w)) break;
    }
    if (!drags(w) || back.get(w) === latest(w)) back.delete(w);
  };
  // What a walk takes at spot `j`: on squares its box, on hexes its hexes, which a box round an anchor overlaps where no hex is shared.
  const g = lead.grid;
  const boxAt = (walk: Walk, j: number): Rect | ReadonlySet<string> => (isHex(g) ? new Set(occupiedHexes(g, placedAt(walk, j)).map(hexKey)) : footprintRect(walk.grid, poseAt(walk, j)));
  const ahead: (Rect | ReadonlySet<string>)[] = [boxAt(lead, latest(lead))];
  // A class at a time, those every player sees first, so a hidden one never decides where a public one stands.
  for (const order of classes) {
    const was = ahead.length;
    for (const walk of order) {
      const j = latest(walk);
      let k = back.get(walk) ?? j;
      if (!following.has(walk)) {
        const stands = standSpots(walks, walk, before, seen);
        for (let i = j; i >= 0; i--) {
          const box = boxAt(walk, i);
          if (standsAt(stands, walk.spots[i]!.progress) && ahead.every((a) => !boxesOverlap(a, box))) {
            k = i;
            break;
          }
        }
      }
      if (k !== j) back.set(walk, k);
      ahead.push(boxAt(walk, k));
    }
    // A step back can leave a drag of the class out of reach, its holder's or one that found no spot of its own behind it: then none
    // of the class steps back, as before. Those players cannot see come after a public holder that may have, so each of them then
    // takes, holders first, the latest spot it may stop at in its holder's reach, clear or not, and lets go unread only with none.
    if (order.some((w) => !drags(w))) {
      ahead.length = was;
      for (const w of order) {
        if (!following.has(w)) back.delete(w);
        ahead.push(boxAt(w, indexOf(w)));
      }
      if (order === classes[1]) for (const w of walks.all) if (order.includes(w) && !following.has(w)) inReach(w);
    }
    // Each hidden holder under one every player sees that stepped back stops at the same progress of its walk, up to the file.
    for (const p of order) {
      const at = back.get(p);
      if (at === undefined || !aboard(p)) continue;
      for (let h: Walk | undefined = p.holder; h && !h.isPublic; h = inSingleFile(h) ? undefined : h.holder) {
        back.set(h, latestIndex(h.spots, p.spots[at]!.progress));
        following.add(h);
      }
    }
  }
  if (back.size === 0) return undefined;
  for (const walk of walks.all) {
    if (walk.group !== group || !rides(walk)) continue;
    const at = indexOf(walk);
    if (at !== latest(walk)) back.set(walk, at);
  }
  return back;
}

/**
 * Where a walk stands at its spot `j` where a stop leaves it there, or
 * undefined on the spot itself (TRAP-FILE-HALF-OFF, D-261107-178). One in
 * single file whose spot there is a stand only on its snapped spot
 * (route.ts StandRule.snaps) stands on that, at the height its rule gives
 * it there (`fileElevation`), and what rides on it, all the way up, moves
 * with it. `index` is the spot the stop leaves each holder on.
 */
function stopPose(walks: Walks, walk: Walk, j: number, index: (w: Walk) => number, before: RoomState, seen: (id: string) => boolean): Token | undefined {
  const holder = walk.holder;
  if (!holder) return undefined;
  if (inSingleFile(walk)) {
    if (!snapsInFile(walks, walk)) return undefined;
    const stands = standSpots(walks, walk, before, seen);
    const snapped = stands.spot(latestIndex(stands.walk, walk.spots[j]!.progress)).snapped;
    if (!snapped) return undefined;
    return { ...placedAt(walk, j), x: snapped.x, y: snapped.y, elevation: fileElevation(walk, holder, before, j, snapped) };
  }
  const kind = walk.token.attached?.kind;
  if (keepsOwn(walk) || kind === undefined || !onHolder(kind)) return undefined;
  const h = index(holder);
  const up = stopPose(walks, holder, h, index, before, seen);
  if (!up) return undefined;
  const was = placedAt(holder, h);
  const own = placedAt(walk, j);
  return { ...own, x: own.x + (up.x - was.x), y: own.y + (up.y - was.y), elevation: own.elevation + (up.elevation - was.elevation) };
}

/** Where a stop leaves each walk of its group off its spot (`stopPose`), or undefined where it leaves each on its spot. */
function stopPoses(walks: Walks, group: Group, stop: Stop, before: RoomState, seen: (id: string) => boolean): Map<Walk, Token> | undefined {
  if (!fileStandsSnapped(walks.opVersion)) return undefined;
  const index = (w: Walk) => stopIndex(w, stop);
  const out = new Map<Walk, Token>();
  for (const walk of walks.all) {
    if (walk.group !== group) continue;
    const moved = stopPose(walks, walk, index(walk), index, before, seen);
    if (moved) out.set(walk, moved);
  }
  return out.size > 0 ? out : undefined;
}

/** Whether two boxes share more than an edge, or two sets of hexes a hex. */
function boxesOverlap(a: Rect | ReadonlySet<string>, b: Rect | ReadonlySet<string>): boolean {
  if (!("x" in a) || !("x" in b)) {
    if ("x" in a || "x" in b) return true;
    for (const k of a) if (b.has(k)) return true;
    return false;
  }
  const e = 1e-9;
  return a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
}

/** A walk's own route to its spot `j`, that spot at the height the trap step had it at there, or to `moved` where a stop moves it off that spot. */
function walkTo(walk: Walk, j: number, moved?: Token): RoutePoint[] {
  const spot = spotAt(walk, j);
  const [piece, k] = spot.progress;
  const route = walk.entry.route.slice(0, piece + 1).map(({ x, y, elevation }) => ({ x, y, elevation }));
  // Its spot where the stop leaves it, as high as the trap step had it there.
  if (k > 0) route.push(moved ? { x: moved.x, y: moved.y, elevation: moved.elevation } : { x: spot.x, y: spot.y, elevation: walk.elevation(j) });
  else route[route.length - 1] = { ...route[route.length - 1]!, elevation: walk.elevation(j) };
  return route;
}

/**
 * The cut walk of a holder players cannot see that seats a creature, where
 * every seat on it holds (attach.ts seatHolds, review FU45B-ASTRA-11): its
 * walk to its spot at the stop `j`, else to the nearest spot of its own walk
 * within a square of it, else to a pose half a square off its spot, on its
 * own lattice first each time, back along its walk before on. `on` are
 * those on it with walks of their own, where they land, and what rides on
 * it with none rides on wherever it stops. It walks at its group's step, a
 * Tiny passenger's half square, so a Medium holder's spot can lie half a
 * square off its grid, where its footprint snaps away from a seat on it. A
 * spot of its own walk keeps every leg one its walk already took. A pose
 * off it is a new leg, which the private pass may stop short, but no token
 * players see moves for that: one with a walk of its own walks it whole
 * (moveLeg.ts follow, review FU45B-ASTRA-12), and the seat lets go
 * (D-261101-403). With `hexes`, from op version 51 on hexes, its own
 * lattice is its own anchors and a pose off its spot stands on a
 * neighboring hex, since a box half a square off an anchor snaps back.
 */
function seatingWalk(walk: Walk, j: number, on: readonly { token: Token; at: RoutePoint }[], hexes = false): RoutePoint[] {
  const lattice = routeLattice(walk.token);
  // From op version 51 a holder on hexes stands on its own anchors, and a pose off its spot is a neighboring hex's (D-261107-172).
  const g = walk.grid;
  const anchored = (p: { x: number; y: number }) => {
    if (!isHex(g)) return p;
    return placedOnHex(g, walk.token, tokenRefHex(g, { ...walk.token, x: p.x, y: p.y }));
  };
  const onLattice = hexes
    ? (p: { x: number; y: number }) => {
        const a = anchored(p);
        return Math.abs(a.x - p.x) < 1e-9 && Math.abs(a.y - p.y) < 1e-9;
      }
    : (p: { x: number; y: number }) => [p.x - walk.token.x, p.y - walk.token.y].every((v) => Math.abs(v / lattice - Math.round(v / lattice)) < 1e-9);
  const holds = (p: { x: number; y: number }) => on.every((s) => seatHolds(walk.grid, s.token.attached!.kind, { ...s.token, x: s.at.x, y: s.at.y }, { ...walk.token, x: p.x, y: p.y }));
  const seats = (p: { x: number; y: number }) => holds(p) && (on.length > 0 || onLattice(p));
  // Its spot, then back before on within a square of the stop at its step, nearest first.
  const reach = Math.max(1, Math.round(1 / walk.step));
  const near: number[] = [j];
  for (let d = 1; d <= reach; d++) near.push(j - d, j + d);
  const fits = near.filter((k) => k >= 0 && k < walk.spots.length && seats(spotAt(walk, k)));
  const k = fits.find((i) => onLattice(spotAt(walk, i))) ?? fits[0];
  if (k !== undefined) return walkTo(walk, k);
  const route = walkTo(walk, j);
  const at = route[route.length - 1]!;
  const off: { x: number; y: number }[] = [];
  // Along one axis before both, or on hexes each neighboring hex in the lattice's order.
  if (hexes && isHex(g)) for (const n of hexNeighbors(g, tokenRefHex(g, { ...walk.token, x: at.x, y: at.y }))) off.push(placedOnHex(g, walk.token, n));
  else for (const [dx, dy] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5], [-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5]] as const) off.push({ x: at.x + dx, y: at.y + dy });
  const pose = off.filter(seats).sort((a, b) => Number(!onLattice(a)) - Number(!onLattice(b)))[0];
  if (pose) route[route.length - 1] = { ...at, ...pose };
  return route;
}

/** A route cut at a spot of piece `progress[0]`: the pieces before it whole, then that piece to the spot, its extra kept. */
function cutRoute(route: readonly RoutePiece[], progress: Progress, at: { x: number; y: number }): RoutePiece[] {
  const [piece, k, n] = progress;
  const kept: RoutePiece[] = route.slice(0, piece).map((p) => [p[0], p[1], p[2], p[3]]);
  const own = route[piece];
  if (own && k > 0) kept.push(k === n ? [own[0], own[1], own[2], own[3]] : [at.x, at.y, own[2], own[3]]);
  return kept;
}

/**
 * A springing of a walk's, frozen at its moment (5.6), as `springingAt`
 * reads it. Off a vision scene whether players see a creature reads only
 * the creature where it stands, never the other tokens (project.ts
 * withheldFromPlayers), so the moment places each one alone.
 */
function springingIn(trap: Trap, how: TrapHow, pass: "public" | "private", together: readonly TrapEvent[], m: Moment, env: { opVersion?: number }): Springing {
  const by = [...new Set(together.map((t) => t.tokenId))].sort(cmp);
  const sightRoom = ownEntry(m.before.scenes, trap.sceneId)?.vision?.on === true ? roomAt(m) : m.before;
  const seen = new Set<string>();
  const party = new Set<string>();
  for (const id of by) {
    const token = tokenAt(m, id);
    if (!token) continue;
    if (seenByNonOwners(sightRoom, token, env)) seen.add(id);
    if (playersToken(m.before, token)) party.add(id);
  }
  return { trap, how, pass, by, hits: hitsIn(trap, m, by, env.opVersion), perceived: pass === "public" && seen.size > 0, seen, party };
}

/** `trapHits` at a walk's moment: on squares, each creature of the op read from its spot, never placed whole. */
function hitsIn(trap: Trap, m: Moment, by: readonly string[], opVersion?: number): string[] {
  const hits = trap.rig?.hits;
  if (hits === undefined) return [];
  const rects = hits === "zone" ? zoneRects(trap.zone) : typeof hits === "object" && "cells" in hits ? hits.cells : null;
  if (hits === "trigger" || (hits === "zone" && !rects)) {
    return by.filter((id) => {
      const t = tokenAt(m, id);
      return t !== undefined && t.sceneId === trap.sceneId && trapCreature(m.before, t);
    });
  }
  if (!rects) return trapHits(trap, roomAt(m), by, opVersion);
  const g = gridOfScene(m.before, trap.sceneId);
  const box = rectsBox(rects);
  const scratch: CellRange = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const out: string[] = [];
  for (const t of Object.values(m.before.tokens)) {
    if (t.sceneId !== trap.sceneId || !trapCreature(m.before, t)) continue;
    const walk = m.walks.get(t.id);
    const moved = walk ? movedIn(m, walk) : undefined;
    const on = isHex(g) ? hexesOnRects(g, walk ? lightAt(walk, spotIn(m, walk)) : t, rects) : onRects(moved ? occupiedRange(g, moved) : walk ? cellsAt(walk, spotIn(m, walk), scratch) : occupiedRange(g, t), rects, box);
    if (on) out.push(t.id);
  }
  return out.sort(cmp);
}

/** Whether any hex a footprint stands on is a key of the rectangles (docs/design/design-v1-hex-grids.md H2). */
function hexesOnRects(g: HexGrid, at: PlacedToken, rects: readonly CellRect[]): boolean {
  return occupiedHexes(g, at).some((h) => inRects(rects, h.col, h.row));
}

/** The box around some rectangles of cells. */
function rectsBox(rects: readonly CellRect[]): CellRange {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const r of rects) {
    box.x0 = Math.min(box.x0, r.x);
    box.y0 = Math.min(box.y0, r.y);
    box.x1 = Math.max(box.x1, r.x + r.w);
    box.y1 = Math.max(box.y1, r.y + r.h);
  }
  return box;
}

/** Whether any cell of a range is a cell of the rectangles, `box` around them. */
function onRects(r: CellRange, rects: readonly CellRect[], box: CellRange): boolean {
  if (r.x1 <= box.x0 || r.x0 >= box.x1 || r.y1 <= box.y0 || r.y0 >= box.y1) return false;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (inRects(rects, x, y)) return true;
  return false;
}

/** A springing's record, frozen at its moment (5.6). */
function springingAt(trap: Trap, how: TrapHow, pass: "public" | "private", together: readonly TrapEvent[] | readonly string[], moment: RoomState, env: { opVersion?: number }): Springing {
  const ids = together.map((t) => (typeof t === "string" ? t : t.tokenId));
  const by = [...new Set(ids)].sort(cmp);
  const seen = new Set<string>();
  const party = new Set<string>();
  for (const id of by) {
    const token = ownEntry(moment.tokens, id);
    if (!token) continue;
    if (seenByNonOwners(moment, token, env)) seen.add(id);
    if (playersToken(moment, token)) party.add(id);
  }
  return { trap, how, pass, by, hits: trapHits(trap, moment, by, env.opVersion), perceived: pass === "public" && seen.size > 0, seen, party };
}

/**
 * Who a springing hits at its moment (5.6): the creatures that set it off,
 * every creature with an occupied cell on its squares (for a wire or a
 * door, those that set it off), every creature in drawn squares, or every
 * creature in an area by the room's inclusion rule and the scene's walls.
 * Only creatures, never the dead, by id. `who`, the floor and size decide
 * who sets it off, never who it hits.
 */
export function trapHits(trap: Trap, moment: RoomState, by: readonly string[], opVersion?: number): string[] {
  const rig = trap.rig;
  if (!rig) return [];
  const isCreature = (t: Token | undefined): t is Token => t !== undefined && t.sceneId === trap.sceneId && trapCreature(moment, t);
  const named = () => by.filter((id) => isCreature(ownEntry(moment.tokens, id)));
  const g = gridOfScene(moment, trap.sceneId);
  const onCells = (rects: readonly CellRect[]) => {
    const box = rectsBox(rects);
    const out: string[] = [];
    for (const t of Object.values(moment.tokens)) if (isCreature(t) && (isHex(g) ? hexesOnRects(g, t, rects) : onRects(occupiedRange(g, t), rects, box))) out.push(t.id);
    return out.sort(cmp);
  };
  const hits = rig.hits;
  if (hits === "trigger") return named();
  if (hits === "zone") {
    const rects = zoneRects(trap.zone);
    return rects ? onCells(rects) : named();
  }
  if ("cells" in hits) return onCells(hits.cells);
  const scene = ownEntry(moment.scenes, trap.sceneId);
  if (!scene) return [];
  const creatures = Object.values(moment.tokens)
    .filter(isCreature)
    .sort((a, b) => cmp(a.id, b.id));
  const template = { id: `trap:${trap.id}`, rev: 0, sceneId: trap.sceneId, ...hits.area };
  const ctx = { opVersion, settings: moment.meta.settings, bounds: scene.bounds, grid: g, walls: sceneWalls(scene, moment.buildChunks), tokens: moment.tokens as Readonly<Record<string, AreaToken>> };
  return creaturesInArea(template, creatures, ctx).sort(cmp);
}

// ---------------------------------------------------------------------------
// Turns, doors and the DM's hand

/** Whether a creature standing where it is now is on a squares trap, by its occupied cells and the floor rule. */
export function standsOn(state: RoomState, trap: Trap, token: Token, seen: (id: string) => boolean): boolean {
  const rects = zoneRects(trap.zone);
  if (!rects || !trap.rig) return false;
  const g = gridOfScene(state, trap.sceneId);
  let on = false;
  if (isHex(g)) on = hexesOnRects(g, token, rects);
  else {
    const r = occupiedRange(g, token);
    for (let y = r.y0; y < r.y1 && !on; y++) for (let x = r.x0; x < r.x1 && !on; x++) on = inRects(rects, x, y);
  }
  if (!on) return false;
  if (!trap.rig.floor) return true;
  return onFloor(state, token, carriedSeen(state, token, seen));
}

/** Whether a creature standing still rides or sits on a holder, within its footprint, by a link every player sees (5.2). */
function carriedSeen(state: Pick<RoomState, "tokens" | "scenes">, token: Token, seen: (id: string) => boolean): boolean {
  const link = token.attached;
  const holder = link && onHolder(link.kind) ? (holderOf(state.tokens, token) as Token | undefined) : undefined;
  return holder !== undefined && seen(token.id) && seen(holder.id) && insideHolder(gridOfScene(state, token.sceneId), token, holder);
}

/**
 * A turn starting or ending (5.1, 5.3): the creature whose turn it is
 * stands on a squares trap that goes off then. Public when every player
 * sees it, private otherwise. Two traps go off in trap id order. `room` is
 * the moment: the room before `encounter.next` for the turn that ends, the
 * room after the turn started for the one that starts.
 */
export function planTurn(room: TrapRoom, tokenId: string, how: "turnStart" | "turnEnd", env: { opVersion?: number }, spent: ReadonlySet<string> = new Set()): Springing[] {
  const token = ownEntry(room.tokens, tokenId);
  if (!token || !trapsLiveOn(room, token.sceneId)) return [];
  const sceneId = token.sceneId;
  const index = trapIndex(room, sceneId);
  if (index.turns.length === 0) return [];
  const seen = seenByAll(room, env);
  const out: Springing[] = [];
  for (const i of index.turns) {
    const trap = index.traps[i]!;
    if (spent.has(trap.id) || !trap.rig!.on.includes(how) || !setsOff(trap.rig!, room, token) || !standsOn(room, trap, token, seen)) continue;
    out.push(springingAt(trap, how, seen(token.id) ? "public" : "private", [token.id], room, env));
  }
  return out;
}

/**
 * A door opened by a creature (5.3): the door traps on it go off for the
 * opener, in trap id order. `room` is the room after the door opened, the
 * springing's moment. Who sees the opener, and whether it rides a holder
 * every player sees, are read on `before`, as for a walk (5.5).
 */
export function planDoor(before: RoomState, room: TrapRoom, sceneId: string, door: TrapDoorRef, by: string, env: { opVersion?: number }): Springing[] {
  if (!trapsLiveOn(room, sceneId)) return [];
  const token = ownEntry(before.tokens, by);
  if (!token || token.sceneId !== sceneId) return [];
  const index = trapIndex(room, sceneId);
  const list = index.doors.get(doorKey(door));
  if (!list) return [];
  const seen = seenByAll(before, env);
  const out: Springing[] = [];
  for (const i of list) {
    const trap = index.traps[i]!;
    if (!setsOff(trap.rig!, before, token)) continue;
    if (trap.rig!.floor && !onFloor(before, token, carriedSeen(before, token, seen))) continue;
    out.push(springingAt(trap, "open", seen(token.id) ? "public" : "private", [token.id], room, env));
  }
  return out;
}

/** The DM's Set it off (6.2): whatever its state, for the creatures named, never an object or the dead, stopping nothing, at the room as it stands. */
export function planHand(room: TrapRoom, trap: Trap, tokenIds: readonly string[], env: { opVersion?: number }): Springing {
  const by = tokenIds.filter((id) => {
    const t = ownEntry(room.tokens, id);
    return t?.sceneId === trap.sceneId && trapCreature(room, t);
  });
  return { ...springingAt(trap, "hand", "public", by, room, env), perceived: true };
}

/**
 * The ground every player sees on a scene before an op, as a stop between
 * a walk's ends reads it from op version 37 (route.ts PublicGround): the
 * shared class's live ground (held.ts pendingGround), the shared sight and
 * the DM's reveals, and every cell where the scene's fog is off. Made once
 * an op. Each cell, hex and stand is asked once for the op under a numeric
 * key, since a walk's cut legs share most of what they read.
 */
export function stopGround(before: RoomState, sceneId: string): PublicGround {
  const ground = pendingGround(before, sceneId, null);
  if (!ground) return { hull: () => false, stands: () => false };
  if (!ground.fogged) return { hull: () => true, stands: () => true };
  const { w, h } = ground.bounds;
  // -1 unknown, then 0 or 1.
  const cells = new Int8Array(w * h).fill(-1);
  const cellLive = (x: number, y: number): boolean => {
    const i = y * w + x;
    let v = cells[i]!;
    if (v < 0) cells[i] = v = ground.live(x, y) ? 1 : 0;
    return v === 1;
  };
  // A scene is at most 200 cells a side, so a hex's offset column and row each fit under KEY_SPAN with room for stands past its edge.
  const hexes = new Map<number, boolean>();
  const hexLive = (g: HexGrid, hx: Hex): boolean => {
    const key = (hx.col + KEY_OFFSET) * KEY_SPAN + hx.row + KEY_OFFSET;
    let v = hexes.get(key);
    if (v === undefined) hexes.set(key, (v = !hexInScene(g, ground.bounds, hx) || ground.keyLive(hexKey(hx))));
    return v;
  };
  const stands = new Map<number, boolean>();
  const standLive = (t: Pick<HexWalls, "g" | "walls">, size: StandGroup["size"], ref: Hex): boolean => {
    const key = (SIZE_KEYS[size] * KEY_SPAN + ref.col + KEY_OFFSET) * KEY_SPAN + ref.row + KEY_OFFSET;
    let v = stands.get(key);
    if (v !== undefined) return v;
    const own = hexStandHexes(t.g, { size, ref });
    v = own.every((hx) => hexLive(t.g, hx));
    for (let j = 0; v && j < own.length; j++) {
      const hx = own[j]!;
      const facing = t.walls.stairAt(hx.col, hx.row);
      if (facing !== undefined && facing !== null) v = hexNeighbors(t.g, hx).every((n) => hexLive(t.g, n));
    }
    stands.set(key, v);
    return v;
  };
  return {
    hull: (points) => rowHullLive(cellLive, w, h, points),
    stands: (t, groups) => {
      for (const { size, refs } of groups) for (const ref of refs) if (!standLive(t, size, ref)) return false;
      return true;
    },
  };
}

const KEY_OFFSET = 4096;
const KEY_SPAN = 8192;
const SIZE_KEYS: Record<StandGroup["size"], number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4, gargantuan: 5 };

/** What builds a stop's ground for an op: `stopGround`, or a test's own to hold it against. */
let groundMaker: (before: RoomState, sceneId: string) => PublicGround = stopGround;

/** For tests: plans read `make`'s ground in place of `stopGround`'s, until set back with null. */
export function setStopGroundForTests(make: ((before: RoomState, sceneId: string) => PublicGround) | null): void {
  groundMaker = make ?? stopGround;
}

/**
 * Whether every square cell inside a w by h scene that a closed convex
 * hull touches is live, a hair past touching included (held.ts
 * convexLive), asked a row at a time: a closed convex hull meets a row's
 * cells exactly where its part inside the row's band, grown a hair,
 * spans them, so each row asks only the cells in that span.
 */
export function rowHullLive(live: (x: number, y: number) => boolean, w: number, h: number, hull: readonly { x: number; y: number }[]): boolean {
  const E = 1e-9;
  const n = hull.length;
  if (n === 0) return true;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const p of hull) {
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  }
  const r0 = Math.max(0, Math.floor(ymin - E));
  const r1 = Math.min(h - 1, Math.floor(ymax + E));
  for (let y = r0; y <= r1; y++) {
    const lo = y - E;
    const hi = y + 1 + E;
    let xmin = Infinity;
    let xmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = hull[i]!;
      const b = hull[(i + 1) % n]!;
      if (a.y >= lo && a.y <= hi) {
        if (a.x < xmin) xmin = a.x;
        if (a.x > xmax) xmax = a.x;
      }
      for (const edge of [lo, hi]) {
        if ((a.y - edge) * (b.y - edge) >= 0) continue;
        const x = a.x + ((b.x - a.x) * (edge - a.y)) / (b.y - a.y);
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
      }
    }
    if (xmin > xmax) continue;
    const c0 = Math.max(0, Math.floor(xmin - E));
    const c1 = Math.min(w - 1, Math.floor(xmax + E));
    for (let x = c0; x <= c1; x++) if (!live(x, y)) return false;
  }
  return true;
}
