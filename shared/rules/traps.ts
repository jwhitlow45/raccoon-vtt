import { CHUNK_CELLS, type CellRect, type RoomState, type Token, type Trap, type TrapDoorRef, type TrapHow, type TrapRig, type TrapZone, type Viewer } from "../model.ts";
import { chunkKey, wallMidpoint } from "../keys.ts";
import { playersToken, seenByNonOwners } from "../project.ts";
import type { Op } from "../protocol.ts";
import { isWritable } from "../writable.ts";
import { creaturesInArea, type AreaToken } from "./aoe.ts";
import { holderOf, insideHolder, onHolder, walkerFor } from "./attach.ts";
import { footprintRect, footprintSize, isSqueezed, occupiedRange, rangeAt, sizeCategory, type CellRange, type PlacedToken } from "./footprint.ts";
import { footing, footprintGround, sceneGround, standing } from "./heights.ts";
import { planMove, type MovedToken } from "./moveLeg.ts";
import { groundUnder } from "./movement.ts";
import { onTrace, routeLattice, routeSpots, routeWalk, type RoutePiece, type RoutePoint, type RouteSpot, type WalkSpot } from "./route.ts";
import { APART, contact, orient } from "./segments.ts";
import { sceneWalls } from "./walls.ts";

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
 * The cells a wire passes over: those its segment runs through, a point
 * of it on a grid line belonging to the cells on both sides. Sampled every
 * eighth of a cell, which finds every cell of a segment whose ends lie on
 * the half-cell lattice.
 */
export function wireCells(wire: { a: readonly [number, number]; b: readonly [number, number] }): { x: number; y: number }[] {
  const steps = Math.max(1, Math.ceil(wireLength(wire) * 8));
  const seen = new Map<string, { x: number; y: number }>();
  const add = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (!seen.has(key)) seen.set(key, { x, y });
  };
  for (let i = 0; i <= steps; i++) {
    const px = wire.a[0] + ((wire.b[0] - wire.a[0]) * i) / steps;
    const py = wire.a[1] + ((wire.b[1] - wire.a[1]) * i) / steps;
    const xs = Number.isInteger(px) ? [px - 1, px] : [Math.floor(px)];
    const ys = Number.isInteger(py) ? [py - 1, py] : [Math.floor(py)];
    for (const x of xs) for (const y of ys) if (x >= 0 && y >= 0) add(x, y);
  }
  return [...seen.values()];
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
type SquareIndex = { w: number; h: number; sum: Int32Array; cells: Uint16Array; sets: readonly (readonly number[])[] };

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
    squares = { w, h, sum, cells, sets };
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

type Walks = { all: Walk[]; byId: Map<string, Walk>; groups: Map<string, Group> };

/**
 * The walks of an op's move. A group's public members share one step, the
 * finest of theirs (half a square when one steps by halves), so they share
 * `n` on every piece and are judged at one moment (5.3). Every other member
 * walks on its own step. A member whose route is its group's walk offset by
 * its place reads that walk's spots, so a group of 500 builds one walk per
 * step it takes.
 */
function walksOf(op: Op, before: RoomState, entries: readonly MovedToken[], seen: (id: string) => boolean): Walks {
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
        elevation: () => 0,
      };
      walk.squeezedAt = squeezeRule(walk, endsAs(op, token, e === head && squeeze));
      walk.elevation = elevationRule(walk, before, shared);
      all.push(walk);
      byId.set(e.tokenId, walk);
    }
  }
  return { all, byId, groups };
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

/** The token as it stands at spot `j`, for a moment. */
function placedAt(walk: Walk, j: number): Token {
  const at = lightAt(walk, j);
  const out: Token = { ...walk.token, x: at.x, y: at.y, elevation: walk.elevation(j) };
  if (at.squeeze) out.squeeze = true;
  else delete out.squeeze;
  return out;
}

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
  const r = footprintRect(at);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** A trap's flags for one walk: the walk can set it off, it takes only creatures on the floor, it goes off on entering, on leaving. */
const CAN = 1;
const FLOOR = 2;
const ENTER = 4;
const LEAVE = 8;

/** One square set of the index as a walk reads it: the traps it can set off there on the floor, and off the floor. */
type SetReading = { floor: readonly number[]; off: readonly number[] };

/** The traps a walk can set off, as flags by trap, and each square set read by them, shared by the walks of a pass with the same flags. */
type Reading = { flags: Uint8Array; sets: (SetReading | undefined)[] };

/** What the walks of one pass share: their readings and the scene's ground. */
type PassCache = { readings: Map<string, Reading>; ground: (r: CellRange) => number };

function passCache(before: RoomState, sceneId: string): PassCache {
  return { readings: new Map(), ground: sceneGround(before.buildChunks, sceneId) };
}

function readingOf(walk: Walk, index: TrapIndex, before: RoomState, spent: ReadonlySet<number>, cache: PassCache): Reading | null {
  const traps = index.traps;
  const flags = new Uint8Array(traps.length);
  let any = false;
  for (let i = 0; i < traps.length; i++) {
    const rig = traps[i]!.rig!;
    if (spent.has(i) || !setsOff(rig, before, walk.token)) continue;
    flags[i] = CAN | (rig.floor ? FLOOR : 0) | (rig.on.includes("enter") ? ENTER : 0) | (rig.on.includes("leave") ? LEAVE : 0);
    any = true;
  }
  if (!any) return null;
  const key = flags.join("");
  let hit = cache.readings.get(key);
  if (!hit) cache.readings.set(key, (hit = { flags, sets: [] }));
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
    reading.sets[id] = hit = { floor, off: off.length === floor.length ? floor : off };
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
  if (!reading) return out;
  const { flags } = reading;
  const traps = index.traps;
  const squares = index.squares;
  const spots = walk.spots;
  const last = spots.length - 1;
  const { w, h } = footprintSize(walk.token);
  const holder = leaving(walk, before, seen);
  // Only a token squeezed where it stands walks squeezed anywhere between (route.ts onTrace).
  const rangeOf = (j: number): CellRange => (j === 0 || j === last || (walk.token.squeeze === true && walk.squeezedAt(j)) ? occupiedRange(lightAt(walk, j)) : rangeAt(w, h, spots[j]!.x + walk.ox, spots[j]!.y + walk.oy));
  const floorAt = (j: number, r: CellRange): boolean => {
    if (walk.carriedOn) return false;
    if (holder && insideHolder(lightAt(walk, j), holder)) return false;
    return standing(walk.elevation(j), cache.ground(r)) === "ground";
  };
  const marks = new Int32Array(traps.length);
  let stamp = 0;
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
    if (sum[y1 * W + x1]! - sum[y0 * W + x1]! - sum[y1 * W + x0]! + sum[y0 * W + x0]! === 0) return NONE;
    // The distinct square sets under the footprint: one under a creature of a square or less, a few under a larger one.
    let first = 0;
    let more: number[] | null = null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const id = squares.cells[y * squares.w + x]!;
        if (id === 0 || id === first) continue;
        if (first === 0) first = id;
        else if (!more) more = [id];
        else if (!more.includes(id)) more.push(id);
      }
    }
    const a = setReading(reading, squares, first);
    let needs = a.off !== a.floor;
    if (more && !needs) {
      for (const id of more) {
        const b = setReading(reading, squares, id);
        if (b.off !== b.floor) needs = true;
      }
    }
    const floor = needs && floorAt(j, r);
    let one = floor ? a.floor : a.off;
    if (!more) return one;
    let union: number[] | null = null;
    for (const id of more) {
      const b = setReading(reading, squares, id);
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
    return union ?? one;
  };
  const wires = walk.teleport ? [] : index.wires.filter((wire) => flags[wire.i]! & CAN);
  // Which spot each trap was last on, so a step tells what it entered and left in one pass over both lists.
  const lastOn = new Int32Array(traps.length).fill(-1);
  let prevOn = onAt(0);
  for (const i of prevOn) lastOn[i] = 0;
  for (let j = 1; j <= last; j++) {
    const on = onAt(j);
    if (on === prevOn) {
      for (const i of on) lastOn[i] = j;
    } else {
      const progress = spots[j]!.progress;
      for (const i of on) {
        if (lastOn[i] !== j - 1 && flags[i]! & ENTER) out.push({ trap: i, how: "enter", at: progress, tokenId: walk.token.id, walk });
        lastOn[i] = j;
      }
      for (const i of prevOn) if (lastOn[i] !== j && flags[i]! & LEAVE) out.push({ trap: i, how: "leave", at: progress, tokenId: walk.token.id, walk });
    }
    if (wires.length > 0) {
      const a = centerOf(lightAt(walk, j - 1));
      const b = centerOf(lightAt(walk, j));
      for (const wire of wires) {
        if (Math.max(a.x, b.x) < wire.x0 || Math.min(a.x, b.x) > wire.x1 || Math.max(a.y, b.y) < wire.y0 || Math.min(a.y, b.y) > wire.y1) continue;
        const { a: wa, b: wb } = (traps[wire.i]!.zone as { wire: { a: [number, number]; b: [number, number] } }).wire;
        if (orient(wa[0], wa[1], wb[0], wb[1], a.x, a.y) === 0) continue;
        if (contact(a.x, a.y, b.x, b.y, wa[0], wa[1], wb[0], wb[1]) === APART) continue;
        if (flags[wire.i]! & FLOOR && !floorAt(j - 1, rangeOf(j - 1))) continue;
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
  /** It stopped its walkers' group (5.5). */
  stopped: boolean;
};

/** What the trap step found in a move: what went off, in order, and the op with its stopped landings (13.2 step 1). */
export type MovePlan = { springings: Springing[]; op: Op };

type Stop = { t: Progress; s: Progress };

/**
 * The trap step's plan of a move (13.2 step 1): both passes, their events,
 * the stops, and who each springing hits at its moment. Reads only the op
 * and the room before it, so replay plans the same. `op` is the op with
 * each stopped group's landing and route cut, which dispatch then moves.
 */
export function planTrapMove(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }): MovePlan {
  const none: MovePlan = { springings: [], op };
  const sceneId = liveTrapScene(before);
  if (sceneId === null || !walkOp(op)) return none;
  const index = trapIndex(before, sceneId);
  if (index.traps.length === 0) return none;
  const onScene = (e: MovedToken) => e.from.sceneId === sceneId && e.to.sceneId === sceneId;
  const entries = planMove(op, before, actor, env).filter(onScene);
  if (entries.length === 0) return none;
  const seen = seenByAll(before, env);
  const walks = walksOf(op, before, entries, seen);
  const spent = new Set<number>();
  const springings: Springing[] = [];

  // The public pass (5.5): only creatures and links seen by all decide what other viewers observe.
  const events: TrapEvent[] = [];
  const pub = passCache(before, sceneId);
  for (const walk of walks.all) if (walk.isPublic) events.push(...walkEvents(walk, index, before, seen, spent, pub));
  events.sort(compareEvents);
  const stops = new Map<string, Stop>();
  const after = (e: TrapEvent) => {
    const stop = stops.get(e.walk.group.named);
    return stop !== undefined && compareProgress(e.at, stop.t) > 0;
  };
  for (let e = 0; e < events.length; e++) {
    const event = events[e]!;
    if (spent.has(event.trap) || after(event)) continue;
    // Every creature whose event for this trap falls at this same progress sets it off with it (5.4).
    const together = sameMoment(events, e, (other) => other.trap === event.trap && !after(other));
    spent.add(event.trap);
    const trap = index.traps[event.trap]!;
    let stopped = false;
    if (trap.rig!.stops) {
      for (const hit of together) {
        if (!hit.walk.walker || stops.has(hit.walk.group.named)) continue;
        stops.set(hit.walk.group.named, { t: event.at, s: stopAt(walks, hit.walk.group, event.at, before, seen) });
        stopped = true;
      }
    }
    springings.push(springingAt(trap, event.how, "public", together, momentAt(before, walks.all, event.at, stops), env, stopped));
  }

  // The private pass (5.5): every other creature, on the walks the public pass left, each on its own step. It never stops.
  const cut = stops.size > 0 ? cutOp(op, walks, stops, before, seen) : op;
  const rest = cut === op ? walks : walksOf(cut, before, planMove(cut, before, actor, env).filter(onScene), seen);
  const hidden: TrapEvent[] = [];
  const priv = passCache(before, sceneId);
  for (const walk of rest.all) if (!walk.isPublic) hidden.push(...walkEvents(walk, index, before, seen, spent, priv));
  hidden.sort(compareEvents);
  for (let e = 0; e < hidden.length; e++) {
    const event = hidden[e]!;
    if (spent.has(event.trap)) continue;
    const together = sameMoment(hidden, e, (other) => other.trap === event.trap);
    spent.add(event.trap);
    springings.push(springingAt(index.traps[event.trap]!, event.how, "private", together, momentAt(before, rest.all, event.at, new Map()), env, false));
  }
  return { springings, op: cut };
}

/**
 * What the trap step reads of a move, token by token: which pass it walks
 * in, whether it is a walker, its step, and the spots it passes, the start
 * first. The DM's drag label reads which traps a drag crosses from these,
 * and the tests read the steps.
 */
export function trapWalks(op: Op, before: TrapRoom, actor: Viewer, env: { opVersion?: number }): { tokenId: string; isPublic: boolean; walker: boolean; step: number; spots: { x: number; y: number; progress: Progress }[] }[] {
  const sceneId = liveTrapScene(before);
  if (sceneId === null || !walkOp(op)) return [];
  const entries = planMove(op, before, actor, env).filter((e) => e.from.sceneId === sceneId && e.to.sceneId === sceneId);
  const walks = walksOf(op, before, entries, seenByAll(before, env));
  return walks.all
    .map((w) => ({ tokenId: w.token.id, isPublic: w.isPublic, walker: w.walker, step: w.step, spots: w.spots.map((_, j) => spotAt(w, j)) }))
    .sort((a, b) => cmp(a.tokenId, b.tokenId));
}

function spotAt(walk: Walk, j: number): { x: number; y: number; progress: Progress } {
  const s = walk.spots[j]!;
  return { x: s.x + walk.ox, y: s.y + walk.oy, progress: s.progress };
}

/** The events at the same progress as `events[from]` that `take` keeps, one per creature. */
function sameMoment(events: readonly TrapEvent[], from: number, take: (e: TrapEvent) => boolean): TrapEvent[] {
  const at = events[from]!.at;
  const out: TrapEvent[] = [];
  for (let f = from; f < events.length && compareProgress(events[f]!.at, at) === 0; f++) {
    const other = events[f]!;
    if (take(other) && !out.some((t) => t.tokenId === other.tokenId)) out.push(other);
  }
  return out;
}

/**
 * Where a group stops (5.5): the latest progress at or before `t` where
 * every walker of the group stands on a spot with `stand`, movement's rule
 * that it may stop there, each walker on its own offset route at the
 * group's step. Progress 0, where the group stood, is a stand by
 * definition, so a stop never refuses the op.
 */
function stopAt(walks: Walks, group: Group, t: Progress, before: RoomState, seen: (id: string) => boolean): Progress {
  const stands = walks.all.filter((w) => w.group === group && w.walker).map((w) => standSpots(w, before, group.step, seen));
  const candidates: Progress[] = [START];
  for (const spots of stands) for (const s of spots) if (compareProgress(s.progress, t) <= 0) candidates.push(s.progress);
  candidates.sort((a, b) => compareProgress(b, a));
  for (const s of candidates) if (stands.every((spots) => latestAt(spots, s)?.stand !== false)) return s;
  return START;
}

/** A walk's spots with `stand` (route.ts routeSpots), on its own route at `step`. A teleport's landing is the op's own. */
function standSpots(walk: Walk, before: RoomState, step: number, seen: (id: string) => boolean): RouteSpot[] {
  if (walk.teleport) return walk.spots.map((s, j) => ({ ...s, x: s.x + walk.ox, y: s.y + walk.oy, squeezed: walk.squeezedAt(j), stand: true }));
  // A walker with a holder in the op walks as its trace has it, as itself and never squeezed (route.ts followerTrace): a creature
  // its holder drags beside it, or one on a holder some player cannot see.
  const token = walk.holder ? walk.entry.trace[0]! : walkerFor(before, walk.token, (t) => seen(t.id));
  return routeSpots(before, walk.entry.route, token, step, walk.holder ? {} : { squeeze: walk.squeezeAtEnd });
}

/** The latest spot at or before `p`. */
function latestAt<T extends { progress: Progress }>(spots: readonly T[], p: Progress): T | undefined {
  let found: T | undefined;
  for (const s of spots) {
    if (compareProgress(s.progress, p) > 0) break;
    found = s;
  }
  return found;
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
 * stop, everything else as before the op. Built only for a springing, so a
 * walk builds no room copy per spot.
 */
function momentAt(before: RoomState, walks: readonly Walk[], p: Progress, stops: ReadonlyMap<string, Stop>): RoomState {
  const tokens = { ...before.tokens };
  for (const walk of walks) {
    const stop = stops.get(walk.group.named);
    const at = stop && compareProgress(p, stop.t) > 0 ? stop.s : p;
    tokens[walk.token.id] = placedAt(walk, latestIndex(walk.spots, at));
  }
  return { ...before, tokens };
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
    const token = walkerFor(before, walk.token, (t) => seen(t.id));
    const squeeze = op.t === "token.move" && op.tokenId === named && op.squeeze === true;
    const spots = routeSpots(before, group.head.route, token, group.step, { squeeze });
    const at = latestAt(spots, stop.s) ?? spots[0]!;
    // A walk on the ground reads the ground under the footprint its trace has there (route.ts routeWalk), and a stop squeezed there lands on the ground under the squeezed one, as every landing does (movement's landedElevation).
    if (!at.squeezed || at === spots[spots.length - 1] || footing(before.buildChunks, token) !== "ground") return at;
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

/** A springing's record, frozen at its moment (5.6). */
function springingAt(trap: Trap, how: TrapHow, pass: "public" | "private", together: readonly TrapEvent[] | readonly string[], moment: RoomState, env: { opVersion?: number }, stopped: boolean): Springing {
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
  return { trap, how, pass, by, hits: trapHits(trap, moment, by), perceived: pass === "public" && seen.size > 0, seen, party, stopped };
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
  const creatures = Object.values(moment.tokens)
    .filter((t) => t.sceneId === trap.sceneId && trapCreature(moment, t))
    .sort((a, b) => cmp(a.id, b.id));
  const alive = new Set(creatures.map((t) => t.id));
  const onCells = (rects: readonly CellRect[]) =>
    creatures
      .filter((t) => {
        const r = occupiedRange(t);
        for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (inRects(rects, x, y)) return true;
        return false;
      })
      .map((t) => t.id);
  const hits = rig.hits;
  if (hits === "trigger") return by.filter((id) => alive.has(id));
  if (hits === "zone") {
    const rects = zoneRects(trap.zone);
    return rects ? onCells(rects) : by.filter((id) => alive.has(id));
  }
  if ("cells" in hits) return onCells(hits.cells);
  const scene = moment.scenes[trap.sceneId];
  if (!scene) return [];
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
  const r = occupiedRange(token);
  let on = false;
  for (let y = r.y0; y < r.y1 && !on; y++) for (let x = r.x0; x < r.x1 && !on; x++) on = inRects(rects, x, y);
  if (!on) return false;
  if (!trap.rig.floor) return true;
  const link = token.attached;
  const holder = link && onHolder(link.kind) ? (holderOf(state.tokens, token) as Token | undefined) : undefined;
  const carried = holder !== undefined && seen(token.id) && seen(holder.id) && insideHolder(token, holder);
  return onFloor(state, token, carried);
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
    out.push(springingAt(trap, how, seen(token.id) ? "public" : "private", [token.id], room, env, false));
  }
  return out;
}

/** A door opened by a creature (5.3): the door traps on it go off for the opener, in trap id order. `room` is the room after the door opened. */
export function planDoor(room: TrapRoom, sceneId: string, door: TrapDoorRef, by: string, env: { opVersion?: number }): Springing[] {
  if (liveTrapScene(room) !== sceneId) return [];
  const token = room.tokens[by];
  if (!token || token.sceneId !== sceneId) return [];
  const index = trapIndex(room, sceneId);
  const list = index.doors.get(doorKey(door));
  if (!list) return [];
  const seen = seenByAll(room, env);
  const out: Springing[] = [];
  for (const i of list) {
    const trap = index.traps[i]!;
    if (!setsOff(trap.rig!, room, token)) continue;
    if (trap.rig!.floor && !onFloor(room, token, false)) continue;
    out.push(springingAt(trap, "open", seen(token.id) ? "public" : "private", [token.id], room, env, false));
  }
  return out;
}

/** The DM's Set it off (6.2): whatever its state, for the creatures named, stopping nothing, at the room as it stands. */
export function planHand(room: TrapRoom, trap: Trap, tokenIds: readonly string[], env: { opVersion?: number }): Springing {
  const by = tokenIds.filter((id) => room.tokens[id]?.sceneId === trap.sceneId);
  return { ...springingAt(trap, "hand", "public", by, room, env, false), perceived: true };
}
