import { decodeHeights, decodeRough, decodeStairs, encodeHeights, encodeRough, encodeStairs } from "#shared/heightCodec.ts";
import type { BuildChunk, CellRect, FreeWall, RoomState, Scene } from "#shared/model.ts";

/*
 * The wing's ghost (docs/design: dungeon generator phase 3, 3.3,
 * D-261110-161 and 170): the planned wing on the DM's board only, drawn as
 * the builder draws a gesture not yet sent. It comes from the scratch room
 * the wing's ops landed in, so it shows exactly what Add the wing would
 * land, less what the scene already holds: the build the wing adds, its
 * traps' squares, its lights' reach and its rooms' numbers.
 */

export type GhostLight = { x: number; y: number; reach: number };
/** A room: its number, where the number shows, and its rectangle, all in the ghost's own cells. */
export type GhostRoom = { n: number; x: number; y: number; rect: CellRect };

export type WingGhost = {
  /** The scene the ghost stands on. */
  sceneId: string;
  area: CellRect;
  /**
   * Where the ghost's own cells stand on the scene, in cells: none where
   * the wing landed in a copy of the scene itself, else the area's corner,
   * for a wing landed on a scene of its own.
   */
  offset: { x: number; y: number };
  /** The build the wing adds, as chunks holding only that, with what derives its walls. */
  chunks: BuildChunk[];
  walls: Pick<Scene, "autoWalls" | "gridShape" | "bounds">;
  /** Each trap's squares. */
  traps: CellRect[];
  lights: GhostLight[];
  /** Each room's number at its middle, shown with Edit rooms on, "W1" and on. */
  rooms: GhostRoom[];
};

const sameWall = (a: FreeWall, b: FreeWall) => a.a[0] === b.a[0] && a.a[1] === b.a[1] && a.b[0] === b.b[0] && a.b[1] === b.b[1] && JSON.stringify(a.f) === JSON.stringify(b.f);

/**
 * What a chunk of the scratch room adds to the same chunk of the scene:
 * its cells, edges, free walls, heights, stair and difficult ground marks
 * that differ, or null where it adds nothing. Free walls compare by their
 * ends and feature, since the wing's carry fresh ids.
 */
export function addedChunk(scratch: BuildChunk, base: BuildChunk | undefined): BuildChunk | null {
  const cells: BuildChunk["cells"] = {};
  for (const [key, t] of Object.entries(scratch.cells)) if (base?.cells[key] !== t) cells[key] = t;
  const edges: BuildChunk["edges"] = {};
  for (const [key, f] of Object.entries(scratch.edges)) if (JSON.stringify(base?.edges[key]) !== JSON.stringify(f)) edges[key] = f;
  const walls = (scratch.walls ?? []).filter((w) => !(base?.walls ?? []).some((b) => sameWall(w, b)));
  const was = decodeHeights(base?.heights);
  const now = decodeHeights(scratch.heights);
  const heights = encodeHeights(now.map((ft, k) => (ft !== was[k] ? ft : 0)));
  const wasUp = decodeStairs(base?.up);
  const up = encodeStairs(decodeStairs(scratch.up).map((m, k) => (m !== wasUp[k] ? m : ".")));
  const wasRough = decodeRough(base?.rough);
  const rough = encodeRough(decodeRough(scratch.rough).map((d, k) => d && !wasRough[k]));
  const empty = Object.keys(cells).length === 0 && Object.keys(edges).length === 0 && walls.length === 0 && !heights && !up && !rough;
  if (empty) return null;
  return {
    sceneId: scratch.sceneId,
    cx: scratch.cx,
    cy: scratch.cy,
    rev: scratch.rev,
    cells,
    edges,
    ...(walls.length > 0 ? { walls } : {}),
    ...(heights ? { heights } : {}),
    ...(up ? { up } : {}),
    ...(rough ? { rough } : {}),
    ...(scratch.grid ? { grid: scratch.grid } : {}),
  };
}

type Ghosted = Pick<RoomState, "buildChunks" | "traps" | "lights">;

/**
 * The ghost of a wing landed in `scratch` on its scene `scratchScene`,
 * against the scene `base` holds as `sceneId`. Where the scratch scene is
 * the scene itself (an offset of none) each chunk is compared with the
 * scene's own, and only what differs is drawn. Traps and lights are the
 * scratch room's that the scene lacks, by id. `rooms` and the feet per
 * cell come from the plan's caller, which knows the rooms' numbers.
 */
export function ghostOf(input: {
  base: Ghosted;
  sceneId: string;
  scratch: Ghosted;
  scratchScene: Pick<Scene, "id" | "autoWalls" | "gridShape" | "bounds">;
  area: CellRect;
  offset: { x: number; y: number };
  feetPerCell: number;
  rooms: GhostRoom[];
}): WingGhost {
  const { base, scratch, scratchScene, offset } = input;
  const same = offset.x === 0 && offset.y === 0 && scratchScene.id === input.sceneId;
  const chunks: BuildChunk[] = [];
  for (const chunk of Object.values(scratch.buildChunks)) {
    if (!chunk || chunk.sceneId !== scratchScene.id) continue;
    const added = addedChunk(chunk, same ? base.buildChunks[`${input.sceneId}:${chunk.cx},${chunk.cy}`] : undefined);
    if (added) chunks.push(added);
  }
  const traps: CellRect[] = [];
  for (const trap of Object.values(scratch.traps ?? {})) {
    if (!trap || trap.sceneId !== scratchScene.id || (same && base.traps?.[trap.id])) continue;
    if ("cells" in trap.zone) traps.push(...trap.zone.cells);
  }
  const lights: GhostLight[] = [];
  for (const light of Object.values(scratch.lights ?? {})) {
    if (!light || light.sceneId !== scratchScene.id || (same && base.lights?.[light.id])) continue;
    lights.push({ x: light.x, y: light.y, reach: (light.bright + light.dim) / Math.max(1, input.feetPerCell) });
  }
  return {
    sceneId: input.sceneId,
    area: input.area,
    offset,
    chunks,
    walls: { autoWalls: scratchScene.autoWalls ?? "all", bounds: scratchScene.bounds, ...(scratchScene.gridShape ? { gridShape: scratchScene.gridShape } : {}) },
    traps,
    lights,
    rooms: input.rooms,
  };
}

/** The room nearest a point, inside it or within `reach` cells of its edge, for a tap on the ghost with Edit rooms on (3.3). */
export function ghostRoomAt(ghost: WingGhost, p: { x: number; y: number }, reach: number): GhostRoom | null {
  let best: GhostRoom | null = null;
  let bestD = reach;
  for (const room of ghost.rooms) {
    const x0 = room.rect.x + ghost.offset.x;
    const y0 = room.rect.y + ghost.offset.y;
    const dx = Math.max(x0 - p.x, 0, p.x - (x0 + room.rect.w));
    const dy = Math.max(y0 - p.y, 0, p.y - (y0 + room.rect.h));
    const d = Math.hypot(dx, dy);
    if (d <= bestD) {
      best = room;
      bestD = d;
    }
  }
  return best;
}
