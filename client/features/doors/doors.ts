import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FogTile, type FreeWall, type RoomState, type Token } from "#shared/model.ts";
import { chunkKey, doorChunk } from "#shared/keys.ts";
import { reachesDoor } from "#shared/permissions.ts";
import type { DoorRef, OpOf } from "#shared/protocol.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";

/**
 * Doors in play (docs/design-v1-maps-vision.md 4.1), as plain functions for
 * node --test: finding the door under a tap, the doors a token reaches, and
 * what a door's pill offers. They read the viewer's own projection, where a
 * secret door not yet found is the wall players see and a locked door is
 * closed, so a player is only ever offered what the server would show them.
 */

export type Point = { x: number; y: number };
type Door = Extract<EdgeFeature, { kind: "door" }>;

/** A door on the map: how ops name it, where it runs, and its state as this viewer sees it. */
export type DoorOnMap = { ref: DoorRef; a: Point; b: Point; mid: Point; door: Door; chunk: BuildChunk };

/** A free wall reaches at most 4 cells past the chunk holding its midpoint (section 2.2). */
const FREE_WALL_REACH = 4;

/** Every door of the scene's chunks that may lie in the box, in a fixed order: by chunk, edges, then free doors. */
export function doorsNear(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, box: { x0: number; y0: number; x1: number; y1: number }): DoorOnMap[] {
  const out: DoorOnMap[] = [];
  const cx0 = Math.floor((box.x0 - FREE_WALL_REACH) / CHUNK_CELLS);
  const cx1 = Math.floor((box.x1 + FREE_WALL_REACH) / CHUNK_CELLS);
  const cy0 = Math.floor((box.y0 - FREE_WALL_REACH) / CHUNK_CELLS);
  const cy1 = Math.floor((box.y1 + FREE_WALL_REACH) / CHUNK_CELLS);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const chunk = chunks[chunkKey(sceneId, cx, cy)];
      if (!chunk) continue;
      for (const [edge, feature] of Object.entries(chunk.edges)) {
        const door = feature.kind === "door" ? edgeDoor(chunk, edge, feature) : null;
        if (door) out.push(door);
      }
      for (const wall of chunk.walls ?? []) if (wall.f.kind === "door") out.push(freeDoor(chunk, wall, wall.f));
    }
  }
  return out;
}

/** An edge door, or null for a malformed key, which walls.ts drops as bad data too. */
function edgeDoor(chunk: BuildChunk, edge: string, door: Door): DoorOnMap | null {
  const [xs, ys, side] = edge.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y) || (side !== "n" && side !== "w")) return null;
  const b = side === "n" ? { x: x + 1, y } : { x, y: y + 1 };
  return { ref: { edge }, a: { x, y }, b, mid: { x: (x + b.x) / 2, y: (y + b.y) / 2 }, door, chunk };
}

function freeDoor(chunk: BuildChunk, wall: FreeWall, door: Door): DoorOnMap {
  const a = { x: wall.a[0], y: wall.a[1] };
  const b = { x: wall.b[0], y: wall.b[1] };
  return { ref: { cx: chunk.cx, cy: chunk.cy, id: wall.id }, a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, door, chunk };
}

/** The distance from a point to a segment, in cells. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The cells on each side of a door's middle: what fog hides of it. */
function sideCells(d: DoorOnMap): Point[] {
  if ("edge" in d.ref) {
    const vertical = d.a.x === d.b.x;
    return vertical ? [{ x: d.a.x, y: d.a.y }, { x: d.a.x - 1, y: d.a.y }] : [{ x: d.a.x, y: d.a.y }, { x: d.a.x, y: d.a.y - 1 }];
  }
  // A step of 1/256 cell along the normal, as the server's reach rule takes it (shared/permissions.ts doorPlace).
  const nx = -(d.b.y - d.a.y);
  const ny = d.b.x - d.a.x;
  const scale = Math.max(Math.abs(nx), Math.abs(ny)) * 256;
  return [1, -1].map((s) => ({ x: Math.floor(d.mid.x + (s * nx) / scale), y: Math.floor(d.mid.y + (s * ny) / scale) }));
}

/** The fog a viewer is held to, null when nothing is hidden from them (the DM, or a scene with fog off). */
export type Fog = Readonly<Record<string, FogTile>> | null;

/**
 * Whether a viewer can see a door: one with ground on either side of it out
 * of the fog. A player is offered only a door they can see, by a tap or by
 * the token bar alike, so a token standing on ground the party never saw
 * finds no door there.
 */
export function doorSeen(d: DoorOnMap, sceneId: string, fog: Fog): boolean {
  return fog === null || sideCells(d).some((cell) => !isCellFullyFogged(fog, sceneId, cell));
}

/**
 * The door a tap reaches: the nearest whose line lies within `slop` cells
 * of the tap (22 px on screen, half a 44 px target, design.md 14.4), among
 * the doors the viewer can see (`doorSeen`).
 */
export function doorUnder(input: {
  chunks: Readonly<Record<string, BuildChunk>>;
  sceneId: string;
  at: Point;
  slop: number;
  fog: Fog;
}): DoorOnMap | null {
  const { at, slop } = input;
  let best: DoorOnMap | null = null;
  let bestD = Infinity;
  for (const d of doorsNear(input.chunks, input.sceneId, { x0: at.x - slop, y0: at.y - slop, x1: at.x + slop, y1: at.y + slop })) {
    const dist = segmentDistance(at, d.a, d.b);
    if (dist > slop || dist >= bestD) continue;
    if (!doorSeen(d, input.sceneId, input.fog)) continue;
    best = d;
    bestD = dist;
  }
  return best;
}

/** The same door, by how ops name it. */
export function sameDoor(a: DoorRef, b: DoorRef): boolean {
  if ("edge" in a) return "edge" in b && a.edge === b.edge;
  return !("edge" in b) && a.cx === b.cx && a.cy === b.cy && a.id === b.id;
}

/** A door by its name in this view, or null when the view holds no door there (a player's secret door not yet found included). */
export function findDoor(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, ref: DoorRef): DoorOnMap | null {
  const { cx, cy } = doorChunk(ref);
  const chunk = chunks[chunkKey(sceneId, cx, cy)];
  if (!chunk) return null;
  if ("edge" in ref) {
    const feature = chunk.edges[ref.edge];
    return feature?.kind === "door" ? edgeDoor(chunk, ref.edge, feature) : null;
  }
  const wall = chunk.walls?.find((w) => w.id === ref.id);
  return wall?.f.kind === "door" ? freeDoor(chunk, wall, wall.f) : null;
}

/**
 * A door by its name in this view while the viewer can see it (`doorSeen`),
 * else null. An open pill reads its door through this as the view changes,
 * so it goes when the door does and when the DM's fog covers it again, as a
 * tap there would find no door (`doorUnder`).
 */
export function seenDoor(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, ref: DoorRef, fog: Fog): DoorOnMap | null {
  const d = findDoor(chunks, sceneId, ref);
  return d !== null && doorSeen(d, sceneId, fog) ? d : null;
}

/**
 * The door a stopped walk's note may name ("A door is in the way. Tap it to
 * open."): only one the viewer can see (`doorSeen`). A door under the fog
 * takes no tap and is offered on no bar, so naming it would send the player
 * looking for a door they cannot open, and would say what the fog hides.
 */
export function noteDoor(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, ref: DoorRef | null, fog: Fog): DoorRef | null {
  if (ref === null) return null;
  const d = findDoor(chunks, sceneId, ref);
  return d !== null && doorSeen(d, sceneId, fog) ? ref : null;
}

/**
 * The doors a token reaches by the server's own rule (shared/permissions.ts
 * reachesDoor: 5 ft or one cell, whichever is more, in three dimensions,
 * with a clear line), nearest first, among those the viewer can see
 * (`doorSeen`). An owned token that lends the party no sight, hidden, down
 * or inside the ground, can stand on ground the party never saw, and a
 * door there stays as hidden from the bar as it is from a tap.
 */
export function doorsInReach(state: RoomState, token: Token, fog: Fog): DoorOnMap[] {
  const fp = footprintRect(token);
  const fpc = state.meta.settings.feetPerCell;
  // Reach is at least one cell, and 5 ft is more cells only where a cell is under 5 ft.
  const cells = Math.ceil(Math.max(5, fpc) / Math.max(fpc, 1e-9)) + 1;
  const box = { x0: fp.x - cells, y0: fp.y - cells, x1: fp.x + fp.w + cells, y1: fp.y + fp.h + cells };
  const center = { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2 };
  return doorsNear(state.buildChunks, token.sceneId, box)
    .filter((d) => doorSeen(d, token.sceneId, fog) && reachesDoor(state, token, d.ref, d.chunk))
    .map((d) => ({ d, dist: Math.hypot(d.mid.x - center.x, d.mid.y - center.y) }))
    .sort((p, q) => p.dist - q.dist)
    .map((p) => p.d);
}

/** One button of a door's pill: its label and the op it sends. */
export type DoorAction = { label: string; op: OpOf<"door.set"> };

/**
 * What a door's pill offers (section 4.1): Open or Close to everyone, and
 * to the DM also Lock or Unlock, and for a secret door Mark found or Hide.
 * A player sees a locked door as closed, so a player's Open on one is
 * answered "It's locked." by the server, which is how players learn of locks.
 */
export function doorActions(sceneId: string, d: Pick<DoorOnMap, "ref" | "door">, role: "dm" | "player"): DoorAction[] {
  const set = (state: Door["state"], found?: boolean): OpOf<"door.set"> => ({ t: "door.set", sceneId, door: d.ref, state, ...(found === undefined ? {} : { found }) });
  const open = d.door.state === "open";
  const out: DoorAction[] = [{ label: open ? "Close" : "Open", op: set(open ? "closed" : "open") }];
  if (role !== "dm") return out;
  out.push(d.door.state === "locked" ? { label: "Unlock", op: set("closed") } : { label: "Lock", op: set("locked") });
  if (d.door.secret) out.push(d.door.discovered ? { label: "Hide", op: set(d.door.state, false) } : { label: "Mark found", op: set(d.door.state, true) });
  return out;
}

/** What a door is, for the pill's name and a screen reader. */
export function doorName(d: Pick<DoorOnMap, "door">, role: "dm" | "player"): string {
  const state = d.door.state === "open" ? "Open" : d.door.state === "locked" && role === "dm" ? "Locked" : "Closed";
  if (role === "dm" && d.door.secret) return `${state} secret door, ${d.door.discovered ? "found" : "hidden"}`;
  return `${state} door`;
}
