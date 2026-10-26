import { CHUNK_CELLS, MIN_HEIGHT_FT, type BuildChunk, type CellRect, type RoomState, type Token, type Trap, type TrapDoorRef, type TrapHow, type TrapRig, type TrapZone, type Viewer } from "../model.ts";
import { chunkKey, wallMidpoint } from "../keys.ts";
import { playersToken, seenByNonOwners } from "../project.ts";
import type { Op } from "../protocol.ts";
import { stopsOnTrap } from "../migrate.ts";
import { isWritable } from "../writable.ts";
import { creaturesInArea, type AreaToken } from "./aoe.ts";
import { holderOf, insideHolder, onHolder, walkerFor } from "./attach.ts";
import { footprintRect, footprintSize, isSqueezed, occupiedRange, rangeAtInto, sizeCategory, type CellRange, type PlacedToken } from "./footprint.ts";
import { footing, footprintGround, groundAt, sceneGround, standing } from "./heights.ts";
import { planMove, type MovedToken } from "./moveLeg.ts";
import { groundUnder } from "./movement.ts";
import { onTrace, routeLattice, routeStands, routeWalk, type RoutePiece, type RoutePoint, type RouteSpot, type WalkSpot } from "./route.ts";
import { APART, contact, orient } from "./segments.ts";
import { sceneWalls } from "./walls.ts";
import { SQUARES } from "./grid.ts";

/**
 * Triggers and traps (docs/design-v1-traps.md section 5): which creatures
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

/** The scene where traps go off by themselves (5.1): the players', while no blackout is on. */
export function liveTrapScene(state: Pick<RoomState, "meta">): string | null {
  return state.meta.view.blackout ? null : state.meta.playerSceneId;
}

// ---------------------------------------------------------------------------
// Zones

/** A zone's squares, or null for a wire or a door. */
export function zoneRects(zone: TrapZone): readonly CellRect[] | null {
  return "cells" in zone ? zone.cells : null;
}

/** Whether a cell is one of the rectangles'. */
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
 * has no cells.
 */
export function zoneRanges(state: Pick<RoomState, "buildChunks">, sceneId: string, zone: TrapZone): CellRange[] {
  if ("cells" in zone) return zone.cells.map((r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  if ("wire" in zone) return wireCells(zone.wire).map(({ x, y }) => ({ x0: x, y0: y, x1: x + 1, y1: y + 1 }));
  return doorCells(state, sceneId, zone.door).map(({ x, y }) => ({ x0: x, y0: y, x1: x + 1, y1: y + 1 }));
}

/**
 * The cells a wire passes over: every cell whose closed square its segment
 * meets, so a point of it on a grid line belongs to the cells on both
 * sides, and a corner to all four. Exact: a wire's ends lie on the
 * half-cell lattice, so in half cells every test is on integers. A cell
 * meets the segment when their boxes overlap and the segment's line does
 * not leave all four of its corners strictly on one side.
 */
export function wireCells(wire: { a: readonly [number, number]; b: readonly [number, number] }): { x: number; y: number }[] {
  const ax = wire.a[0] * 2;
  const ay = wire.a[1] * 2;
  const dx = wire.b[0] * 2 - ax;
  const dy = wire.b[1] * 2 - ay;
  const side = (px: number, py: number) => Math.sign(dx * (py - ay) - dy * (px - ax));
  const out: { x: number; y: number }[] = [];
  const x0 = Math.max(0, Math.ceil(Math.min(wire.a[0], wire.b[0])) - 1);
  const y0 = Math.max(0, Math.ceil(Math.min(wire.a[1], wire.b[1])) - 1);
  const x1 = Math.floor(Math.max(wire.a[0], wire.b[0]));
  const y1 = Math.floor(Math.max(wire.a[1], wire.b[1]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sides = side(2 * x, 2 * y) + side(2 * x + 2, 2 * y) + side(2 * x, 2 * y + 2) + side(2 * x + 2, 2 * y + 2);
      if (sides !== 4 && sides !== -4) out.push({ x, y });
    }
  }
  return out;
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
  const wall = state.buildChunks[chunkKey(sceneId, ref.cx, ref.cy)]?.walls?.find((w) => w.id === ref.id);
  if (!wall) return [];
  const [mx, my] = wallMidpoint(wall);
  const nx = -(wall.b[1] - wall.a[1]);
  const ny = wall.b[0] - wall.a[0];
  const scale = Math.max(Math.abs(nx), Math.abs(ny)) * 256;
  const cell = (sign: number) => ({ x: Math.floor(mx + (sign * nx) / scale), y: Math.floor(my + (sign * ny) / scale) });
  const a = cell(1);
  const b = cell(-1);
  return a.x === b.x && a.y === b.y ? [a] : [a, b];
}

/** Whether a door zone's door is still there, on the grid or free. */
export function doorExists(state: Pick<RoomState, "buildChunks">, sceneId: string, ref: TrapDoorRef): boolean {
  if ("edge" in ref) {
    const [xs, ys] = ref.edge.split(",");
    const chunk = state.buildChunks[chunkKey(sceneId, Math.floor(Number(xs) / CHUNK_CELLS), Math.floor(Number(ys) / CHUNK_CELLS))];
    return chunk?.edges[ref.edge]?.kind === "door";
  }
  return state.buildChunks[chunkKey(sceneId, ref.cx, ref.cy)]?.walls?.find((w) => w.id === ref.id)?.f.kind === "door";
}

// ---------------------------------------------------------------------------
// Who sets a trap off (5.2)

/** A creature a trap can catch or hit: not an object and not dead, which every player's projection holds. */
export function trapCreature(state: Pick<RoomState, "characters">, token: Pick<Token, "kind" | "actor">): boolean {
  if (token.kind === "object") return false;
  const actor = "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
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
  const scene = state.scenes[sceneId];
  const index = armed.length === 0 || !scene ? EMPTY_INDEX : buildIndex(armed, scene.bounds);
  if (!isWritable(traps)) {
    let byScene = indexes.get(traps);
    if (!byScene) indexes.set(traps, (byScene = new Map()));
    byScene.set(sceneId, index);
  }
  return index;
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
  /** Its elevation at each spot, worked out only where a trap needs it. */
  elevation: (j: number) => number;
};

/** Whether every player sees a token as the op finds the room: on the players' scene and received by a player who owns nothing (5.3). */
function seenByAll(state: RoomState, env: { opVersion?: number }): (id: string) => boolean {
  const cache = new Map<string, boolean>();
  return (id) => {
    let hit = cache.get(id);
    if (hit === undefined) {
      const token = state.tokens[id];
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
type Walks = { all: Walk[]; byId: Map<string, Walk>; groups: Map<string, Group>; stands: Map<Walk, Stands>; opVersion: number | undefined };

/** A walk's spots, and each with `stand` as asked (route.ts routeStands). */
type Stands = { walk: readonly { progress: Progress }[]; spot: (i: number) => RouteSpot };

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
  for (const [named, members] of byGroup(entries)) {
    const head = members[0]!;
    if (head.how !== "walk" && head.how !== "teleport") continue;
    const headToken = before.tokens[head.tokenId]!;
    const cache = new Map<number, readonly WalkSpot[]>();
    const base = (s: number): readonly WalkSpot[] => {
      let hit = cache.get(s);
      if (!hit) cache.set(s, (hit = head.how === "teleport" ? twoSpots(head.route) : routeWalk(head.trace, build, s)));
      return hit;
    };
    // The public members: every member seen by all. One under a holder players cannot see walks as itself (listed reveal 2).
    const step = Math.min(1, ...members.filter((e) => seen(e.tokenId)).map((e) => routeLattice(before.tokens[e.tokenId]!)));
    const group: Group = { named, head, base, step };
    groups.set(named, group);
    const squeeze = op.t === "token.move" && op.tokenId === head.tokenId && op.squeeze === true;
    for (const e of members) {
      const token = before.tokens[e.tokenId]!;
      const holder = e.carriedBy !== undefined ? byId.get(e.carriedBy) : undefined;
      const kind = holder ? token.attached?.kind : undefined;
      const pub = seen(e.tokenId);
      const linkSeen = holder !== undefined && pub && holder.isPublic;
      const mine = pub ? step : routeLattice(token);
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
        spots: shared ? base(mine) : e.how === "teleport" ? twoSpots(e.route) : routeWalk(e.trace, build, mine),
        ox: shared ? ox : 0,
        oy: shared ? oy : 0,
        step: mine,
        teleport: e.how === "teleport",
        squeezeAtEnd: e === head && squeeze,
        squeezedAt: () => false,
        size: footprintSize(token),
        elevation: () => 0,
      };
      walk.squeezedAt = squeezeRule(walk, endsAs(op, token, e === head && squeeze));
      walk.elevation = elevationRule(walk, before, shared);
      all.push(walk);
      byId.set(e.tokenId, walk);
    }
  }
  return { all, byId, groups, stands: new Map(), opVersion };
}

/**
 * Each spot's elevation by attach's rule (docs/design-v1-attach.md 5.1):
 * the group's own walk for the named token, the holder's change for what
 * rides, and for a dragged creature its own ground behind a holder on the
 * ground, else the holder's change but never below the ground. The holder
 * is read at the same spot of the same step's walk, so a member on its own
 * step reads its holder there too. A member walking a route of its own
 * takes that walk's elevations as they are.
 *
 * What is carried or rides all the way up adds its holders' changes to the
 * group's walk, in the order `elevationOnStep` adds them, so a walk of 500
 * reads each spot in a few additions. Only a dragged link reads the ground,
 * and remembers what it read.
 */
function elevationRule(walk: Walk, before: RoomState, shared: boolean): (j: number) => number {
  const last = walk.spots.length - 1;
  const own = walk.spots;
  if (!shared) return (j) => (j === 0 ? walk.token.elevation : j === last ? walk.entry.to.elevation : own[j]!.elevation);
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
 * `ends`, the token as the move leaves it.
 */
function squeezeRule(walk: Walk, ends: PlacedToken): (j: number) => boolean {
  const last = walk.spots.length - 1;
  return (j) => {
    if (j === last) return isSqueezed(ends);
    const [piece, k, n] = walk.spots[j]!.progress;
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

/** The cells a walk's footprint covers at spot `j` (lightAt), written into `out` where it walks full size between its ends. */
function cellsAt(walk: Walk, j: number, out: CellRange): CellRange {
  // Only a token squeezed where it stands walks squeezed anywhere between (route.ts onTrace).
  if (j === 0 || j === walk.spots.length - 1 || (walk.token.squeeze === true && walk.squeezedAt(j))) return occupiedRange(SQUARES, lightAt(walk, j));
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

function centerOf(at: Light): { x: number; y: number } {
  const r = footprintRect(SQUARES, at);
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
    if (holder && insideHolder(lightAt(walk, j), holder)) return false;
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
  /** What a footprint over these cells reads, on the floor and off it, and whether the floor rule tells them apart. */
  const mixOf = (x0: number, y0: number, x1: number, y1: number): Mix => {
    const sq = squares!;
    // The distinct square sets under the footprint: one under a creature of a square or less, a few under a larger one.
    let first = 0;
    let more: number[] | null = null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x = sq.runEnd[y * sq.w + x]!) {
        const id = sq.cells[y * sq.w + x]!;
        if (id === 0 || id === first) continue;
        if (first === 0) first = id;
        else if (!more) {
          // One buffer for every spot, which only this call reads.
          more = buffer;
          more.length = 0;
          more.push(id);
        } else if (!more.includes(id)) more.push(id);
      }
    }
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
  const onAt = (j: number): readonly number[] => {
    if (!squares) return NONE;
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
      const a = centerOf(lightAt(walk, j - 1));
      const b = centerOf(lightAt(walk, j));
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
 * version 17 the event that stopped it (migrate.ts stopsOnTrap).
 */
type Stop = { until: Progress; s: Progress };

/**
 * The trap step's plan of a move (13.2 step 1): both passes, their events,
 * the stops, and who each springing hits at its moment. Reads only the op
 * and the room before it, so replay plans the same. `op` is the op with
 * each stopped group's landing and route cut, which dispatch then moves.
 */
export function planTrapMove(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }, pitOpens?: (trap: Trap) => boolean): MovePlan {
  const none: MovePlan = { springings: [], op };
  const sceneId = liveTrapScene(before);
  if (sceneId === null || !walkOp(op)) return none;
  const index = trapIndex(before, sceneId);
  if (index.traps.length === 0) return none;
  const onScene = (e: MovedToken) => e.from.sceneId === sceneId && e.to.sceneId === sceneId;
  const entries = planMove(op, before, actor, env).filter(onScene);
  if (entries.length === 0) return none;
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
        stops.set(group.named, { until: forward ? s : event.at, s });
      }
    }
    springings.push(springingIn(trap, event.how, "public", together, momentAt(before, walks.byId, event.at, stops), env));
  }

  // The private pass (5.5): every other creature, on the walks the public pass left, each on its own step. It never stops.
  const cut = stops.size > 0 ? cutOp(op, walks, stops, before, seen) : op;
  // A move with no walk players cannot see has no private pass, so its cut op needs no walks of its own.
  if (!walks.all.some((w) => !w.isPublic)) return { springings, op: cut };
  const rest = cut === op ? walks : walksOf(cut, before, planMove(cut, before, actor, env).filter(onScene), seen, env.opVersion);
  const priv = passCache(before, sceneId);
  const hidden = byTrap(rest.all.filter((w) => !w.isPublic), (walk) => walkEvents(walk, index, before, seen, spent, priv));
  const never = () => false;
  const nextPrivate = picker(hidden, spent, () => true, () => 0);
  for (let event = nextPrivate(); event !== null; event = nextPrivate()) {
    const together = sameMoment(hidden.get(event.trap)!, event, never);
    spent.add(event.trap);
    springings.push(springingIn(index.traps[event.trap]!, event.how, "private", together, momentAt(before, rest.byId, event.at, new Map()), env));
  }
  return { springings, op: cut };
}

/**
 * What the trap step reads of a move, token by token: which pass it walks
 * in, whether it is a walker, its step, and the spots it passes, the start
 * first, for the tests. The drag label reads which traps a drag crosses on
 * its own (client/features/traps/rules.ts crossedTraps).
 */
export function trapWalks(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }): { tokenId: string; isPublic: boolean; walker: boolean; step: number; spots: { x: number; y: number; progress: Progress }[] }[] {
  const sceneId = liveTrapScene(before);
  if (sceneId === null || !walkOp(op)) return [];
  const entries = planMove(op, before, actor, env).filter((e) => e.from.sceneId === sceneId && e.to.sceneId === sceneId);
  const walks = walksOf(op, before, entries, seenByAll(before, env), env.opVersion);
  return walks.all
    .map((w) => ({ tokenId: w.token.id, isPublic: w.isPublic, walker: w.walker, step: w.step, spots: w.spots.map((_, j) => spotAt(w, j)) }))
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
 * walk's end, the group walks to its end, which is no stop.
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
 * covers, squeezed where it squeezes, is one of them.
 */
function opening(trap: Trap, before: RoomState, opens?: (trap: Trap) => boolean): ((spot: RouteSpot, walk: Walk) => boolean) | null {
  const pit = trap.rig?.pit;
  if (!pit || !("cells" in trap.zone) || pitOpen(before.buildChunks, trap.sceneId, trap.zone.cells, pit)) return null;
  // The action's own test of whether the pit opens (reducer/traps.ts pitOpens): one the caps keep shut moves no walker over it.
  if (opens && !opens(trap)) return null;
  const squares = new Set<string>();
  for (const r of trap.zone.cells) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) squares.add(`${x},${y}`);
  return (spot, walk) => {
    const r = footprintRect(SQUARES, { ...walk.token, x: spot.x, y: spot.y, squeeze: spot.squeezed ? true : undefined });
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
    stands = routeStands(before, walk.entry.route, token, walk.group.step, walk.holder ? {} : { squeeze: walk.squeezeAtEnd }, head ? walk.group.base(walk.group.step) : undefined);
  }
  walks.stands.set(walk, stands);
  return stands;
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
  return latestIndex(walk.spots, stop && compareProgress(m.p, stop.until) > 0 ? stop.s : m.p);
}

function tokenAt(m: Moment, id: string): Token | undefined {
  const walk = m.walks.get(id);
  return walk ? placedAt(walk, spotIn(m, walk)) : m.before.tokens[id];
}

function roomAt(m: Moment): RoomState {
  if (!m.room) {
    const tokens = { ...m.before.tokens };
    for (const walk of m.walks.values()) tokens[walk.token.id] = placedAt(walk, spotIn(m, walk));
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
    const stands = walk.holder ? routeStands(before, group.head.route, token, group.step, { squeeze }) : standSpots(walks, walk, before, seen);
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
      return pieces.length > 0 ? { ...next, route: pieces as [number, number, number, 0 | 1][] } : next;
    }
    case "token.moveMany":
      return {
        ...op,
        moves: op.moves.map((m) => {
          const at = landing(m.tokenId);
          return at ? { ...m, x: at.x, y: at.y, elevation: at.elevation } : m;
        }),
      };
    default:
      return op;
  }
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
  const sightRoom = m.before.scenes[trap.sceneId]?.vision?.on === true ? roomAt(m) : m.before;
  const seen = new Set<string>();
  const party = new Set<string>();
  for (const id of by) {
    const token = tokenAt(m, id);
    if (!token) continue;
    if (seenByNonOwners(sightRoom, token, env)) seen.add(id);
    if (playersToken(m.before, token)) party.add(id);
  }
  return { trap, how, pass, by, hits: hitsIn(trap, m, by), perceived: pass === "public" && seen.size > 0, seen, party };
}

/** `trapHits` at a walk's moment: on squares, each creature of the op read from its spot, never placed whole. */
function hitsIn(trap: Trap, m: Moment, by: readonly string[]): string[] {
  const hits = trap.rig?.hits;
  if (hits === undefined) return [];
  const rects = hits === "zone" ? zoneRects(trap.zone) : typeof hits === "object" && "cells" in hits ? hits.cells : null;
  if (hits === "trigger" || (hits === "zone" && !rects)) {
    return by.filter((id) => {
      const t = tokenAt(m, id);
      return t !== undefined && t.sceneId === trap.sceneId && trapCreature(m.before, t);
    });
  }
  if (!rects) return trapHits(trap, roomAt(m), by);
  const box = rectsBox(rects);
  const scratch: CellRange = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const out: string[] = [];
  for (const t of Object.values(m.before.tokens)) {
    if (t.sceneId !== trap.sceneId || !trapCreature(m.before, t)) continue;
    const walk = m.walks.get(t.id);
    if (onRects(walk ? cellsAt(walk, spotIn(m, walk), scratch) : occupiedRange(SQUARES, t), rects, box)) out.push(t.id);
  }
  return out.sort(cmp);
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
    const token = moment.tokens[id];
    if (!token) continue;
    if (seenByNonOwners(moment, token, env)) seen.add(id);
    if (playersToken(moment, token)) party.add(id);
  }
  return { trap, how, pass, by, hits: trapHits(trap, moment, by), perceived: pass === "public" && seen.size > 0, seen, party };
}

/**
 * Who a springing hits at its moment (5.6): the creatures that set it off,
 * every creature with an occupied cell on its squares (for a wire or a
 * door, those that set it off), every creature in drawn squares, or every
 * creature in an area by the room's inclusion rule and the scene's walls.
 * Only creatures, never the dead, by id. `who`, the floor and size decide
 * who sets it off, never who it hits.
 */
export function trapHits(trap: Trap, moment: RoomState, by: readonly string[]): string[] {
  const rig = trap.rig;
  if (!rig) return [];
  const isCreature = (t: Token | undefined): t is Token => t !== undefined && t.sceneId === trap.sceneId && trapCreature(moment, t);
  const named = () => by.filter((id) => isCreature(moment.tokens[id]));
  const onCells = (rects: readonly CellRect[]) => {
    const box = rectsBox(rects);
    const out: string[] = [];
    for (const t of Object.values(moment.tokens)) if (isCreature(t) && onRects(occupiedRange(SQUARES, t), rects, box)) out.push(t.id);
    return out.sort(cmp);
  };
  const hits = rig.hits;
  if (hits === "trigger") return named();
  if (hits === "zone") {
    const rects = zoneRects(trap.zone);
    return rects ? onCells(rects) : named();
  }
  if ("cells" in hits) return onCells(hits.cells);
  const scene = moment.scenes[trap.sceneId];
  if (!scene) return [];
  const creatures = Object.values(moment.tokens)
    .filter(isCreature)
    .sort((a, b) => cmp(a.id, b.id));
  const template = { id: `trap:${trap.id}`, rev: 0, sceneId: trap.sceneId, ...hits.area };
  const ctx = { settings: moment.meta.settings, bounds: scene.bounds, walls: sceneWalls(scene, moment.buildChunks), tokens: moment.tokens as Readonly<Record<string, AreaToken>> };
  return creaturesInArea(template, creatures, ctx).sort(cmp);
}

// ---------------------------------------------------------------------------
// Turns, doors and the DM's hand

/** Whether a creature standing where it is now is on a squares trap, by its occupied cells and the floor rule. */
export function standsOn(state: RoomState, trap: Trap, token: Token, seen: (id: string) => boolean): boolean {
  const rects = zoneRects(trap.zone);
  if (!rects || !trap.rig) return false;
  const r = occupiedRange(SQUARES, token);
  let on = false;
  for (let y = r.y0; y < r.y1 && !on; y++) for (let x = r.x0; x < r.x1 && !on; x++) on = inRects(rects, x, y);
  if (!on) return false;
  if (!trap.rig.floor) return true;
  return onFloor(state, token, carriedSeen(state, token, seen));
}

/** Whether a creature standing still rides or sits on a holder, within its footprint, by a link every player sees (5.2). */
function carriedSeen(state: Pick<RoomState, "tokens">, token: Token, seen: (id: string) => boolean): boolean {
  const link = token.attached;
  const holder = link && onHolder(link.kind) ? (holderOf(state.tokens, token) as Token | undefined) : undefined;
  return holder !== undefined && seen(token.id) && seen(holder.id) && insideHolder(token, holder);
}

/**
 * A turn starting or ending (5.1, 5.3): the creature whose turn it is
 * stands on a squares trap that goes off then. Public when every player
 * sees it, private otherwise. Two traps go off in trap id order. `room` is
 * the moment: the room before `encounter.next` for the turn that ends, the
 * room after the turn started for the one that starts.
 */
export function planTurn(room: TrapRoom, tokenId: string, how: "turnStart" | "turnEnd", env: { opVersion?: number }, spent: ReadonlySet<string> = new Set()): Springing[] {
  const sceneId = liveTrapScene(room);
  const token = room.tokens[tokenId];
  if (sceneId === null || !token || token.sceneId !== sceneId) return [];
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
  if (liveTrapScene(room) !== sceneId) return [];
  const token = before.tokens[by];
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
    const t = room.tokens[id];
    return t?.sceneId === trap.sceneId && trapCreature(room, t);
  });
  return { ...springingAt(trap, "hand", "public", by, room, env), perceived: true };
}
