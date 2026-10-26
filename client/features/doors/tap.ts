import type { BuildChunk } from "#shared/model.ts";
import type { Point } from "../../lib/camera.ts";
import { K } from "../../lib/view.ts";
import { WALL_RISE } from "../../canvas/relief/pieces.ts";
import { boardPickOf, drawnAt, screenAt, type BoardPick } from "../../canvas/boardPick.ts";
import type { ToolContext } from "../tools.ts";
import { doorSeen, doorsNear, doorUnder, segmentDistance, type DoorOnMap, type Fog } from "./doors.ts";
import { doorPillSlot } from "./store.ts";

/** Half a 44 px touch target (design.md 14.4), as the builder reaches a free wall. */
export const DOOR_SLOP_PX = 22;

/**
 * A tap on the map with the Select tool, as doors see it
 * (docs/design-v1-maps-vision.md 4.1): a tap on a door shows its pill, and
 * a tap anywhere else puts an open pill away. The canvas calls this only
 * for a tap that no token caught, so a token under the finger wins. Doors
 * are part of the map, not shapes that catch a tap of their own, as labels
 * are. Returns whether the tap was the door's: it landed on a door, or it
 * put an open pill away, as a tap closing the label pane is the pane's. So
 * the tap that closes a pill shows no height readout in its place
 * (docs/design-v1-heights-readout.md section 2), and one thing floats over
 * the map at a time.
 *
 * In Isometric a door is reached by its standing piece or its line on the
 * ground, within the slop on screen (docs/design-v1-isometric-view.md 6.2),
 * from the press itself (`screen`).
 */
export function tapDoor(ctx: Pick<ToolContext, "getState" | "scene" | "camera" | "role" | "scope">, tool: string, world: Point, selected: string | null = null, screen?: Point): boolean {
  const pill = ctx.scope.get(doorPillSlot);
  const view = ctx.getState().view;
  const fogged = ctx.role === "player" && ctx.scene.fogEnabled !== false;
  const fog = fogged && view ? view.fogTiles : null;
  const pick = boardPickOf(ctx);
  const hit =
    tool !== "select" || !view
      ? null
      : pick.view.kind === "isometric" && screen
        ? isoDoorUnder({ chunks: view.buildChunks, sceneId: ctx.scene.id, fog, pick, world, screen })
        : doorUnder({ chunks: view.buildChunks, sceneId: ctx.scene.id, at: world, slop: DOOR_SLOP_PX / ctx.camera().scale, fog });
  if (hit) {
    // The token selected when the door was tapped is who opens it (docs/design-v1-traps.md 5.3), though the tap let it go.
    pill.setState({ pill: { sceneId: ctx.scene.id, ref: hit.ref, ...(selected !== null ? { selected } : {}) } });
    return true;
  }
  if (!pill.getState().pill) return false;
  pill.setState({ pill: null });
  return true;
}

/**
 * The door a press reaches in Isometric: the nearest on screen within
 * DOOR_SLOP_PX, measured to its line on the drawn ground or, for a closed
 * door while heights stand, to the piece that stands WALL_RISE above the
 * higher ground beside it (relief/runs.ts). Among the doors the viewer can
 * see, as in Top-down.
 */
export function isoDoorUnder(input: { chunks: Readonly<Record<string, BuildChunk>>; sceneId: string; fog: Fog; pick: BoardPick; world: Point; screen: Point }): DoorOnMap | null {
  const { pick, world, screen } = input;
  // A view distance is never longer than the world distance it shows, and a press on a standing piece meets the ground behind it up to 2K·WALL_RISE further off.
  const reach = DOOR_SLOP_PX / pick.camera.scale + 2 * K * WALL_RISE + 1;
  let best: DoorOnMap | null = null;
  let bestD = Infinity;
  for (const d of doorsNear(input.chunks, input.sceneId, { x0: world.x - reach, y0: world.y - reach, x1: world.x + reach, y1: world.y + reach })) {
    const dist = doorGap(pick, d, screen);
    if (dist > DOOR_SLOP_PX || dist >= bestD) continue;
    if (!doorSeen(d, input.sceneId, input.fog)) continue;
    best = d;
    bestD = dist;
  }
  return best;
}

/** How far a press is from a door on screen, in px: 0 on its standing piece. */
export function doorGap(pick: BoardPick, d: Pick<DoorOnMap, "a" | "b" | "mid" | "door">, screen: Point): number {
  const ground = doorGround(pick, d);
  const a = screenAt(pick, d.a, ground);
  const b = screenAt(pick, d.b, ground);
  const onLine = segmentDistance(screen, a, b);
  // An open door lies flat, and below the stand threshold every wall does (ISO-D12).
  if (d.door.state === "open" || pick.src?.stand !== true) return onLine;
  return Math.min(onLine, sweepGap(screen, a, b, K * WALL_RISE * pick.camera.scale));
}

/** The higher drawn ground on either side of a door's middle, as its standing piece rises from (relief/runs.ts), in cells. */
export function doorGround(pick: BoardPick, d: Pick<DoorOnMap, "a" | "b" | "mid">): number {
  const len = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) || 1;
  const nx = (-(d.b.y - d.a.y) / len) * 0.25;
  const ny = ((d.b.x - d.a.x) / len) * 0.25;
  return Math.max(drawnAt(pick, { x: d.mid.x + nx, y: d.mid.y + ny }), drawnAt(pick, { x: d.mid.x - nx, y: d.mid.y - ny }));
}

/** The distance from `p` to the band swept from the segment a-b straight up the screen by `up` px: 0 inside it. */
export function sweepGap(p: Point, a: Point, b: Point, up: number): number {
  const dx = b.x - a.x;
  if (Math.abs(dx) > 1e-9) {
    const t = (p.x - a.x) / dx;
    if (t >= 0 && t <= 1) {
      const lineY = a.y + t * (b.y - a.y);
      if (p.y <= lineY && p.y >= lineY - up) return 0;
    }
  }
  const top = (q: Point) => ({ x: q.x, y: q.y - up });
  return Math.min(segmentDistance(p, a, b), segmentDistance(p, top(a), top(b)), segmentDistance(p, a, top(a)), segmentDistance(p, b, top(b)));
}
