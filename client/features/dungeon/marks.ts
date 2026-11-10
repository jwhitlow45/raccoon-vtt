import type { RoomState, Trap } from "#shared/model.ts";
import { boardTheme } from "../../lib/theme.ts";
import { findDoor } from "../doors/doors.ts";
import { latticeFor } from "./lattice.ts";
import type { RoomFacts } from "./edits.ts";
import type { DungeonPlan, PlanRoom } from "./plan.ts";
import { isHexGrid } from "./settings.ts";

/*
 * The DM marks over the dungeon preview and inside Look closer's picture
 * (docs/design/design-v1-dungeon-generator.md phase 2, 4.2): a ring on each
 * light and, with DM key on, each room's number at its pin. Traps and the
 * entrance ring are the preview's own marks, drawn here too so the larger
 * picture carries the same ones. The data is plain, so the SVG overlay and
 * the canvas draw the same places.
 */

/** The crest yellow with a black outline: 3:1 over floor and rock alike (section 13). Tokens, so the drift test keeps them. */
export const LIGHT_RING = boardTheme.color.crest;
export const RING_OUTLINE = boardTheme.color.textHalo;

export type LightMark = { x: number; y: number };
export type NumberMark = { n: number; x: number; y: number };
/** A room's box in the scene, in cells, by its board index. */
export type RoomBox = { room: number; x: number; y: number; w: number; h: number };
/** A room's number, board index and place in `plan.rooms`, as the key numbers it (edits.ts `RoomFacts`). */
export type Numbered = Pick<RoomFacts, "n" | "room" | "at">;

type Placed = Pick<DungeonPlan, "w" | "h" | "grid">;

/**
 * Where a lattice cell's middle stands in the scene. Rooms, their pins and
 * the entrance are on the plan's lattice, which on hexes is the rows
 * lattice (phase 3, 2.1), so each goes through `pointOf`. On squares that
 * is the square's middle, as it always was.
 */
function pointer(plan: Placed): (x: number, y: number) => [number, number] {
  if (!isHexGrid(plan.grid)) return (x, y) => [x + 0.5, y + 0.5];
  const lattice = latticeFor(plan.grid, { w: plan.w, h: plan.h });
  return (x, y) => lattice.pointOf(x, y);
}

/**
 * A room's box in the scene: its rectangle on squares, and on hexes the
 * box round its hexes' centers grown by a hex's radius, near enough for a
 * ring and a tap.
 */
export function roomBox(plan: Placed, r: Pick<PlanRoom, "x" | "y" | "w" | "h">, room = 0): RoomBox {
  if (!isHexGrid(plan.grid)) return { room, x: r.x, y: r.y, w: r.w, h: r.h };
  const lattice = latticeFor(plan.grid, { w: plan.w, h: plan.h });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!lattice.inMap(x, y)) continue;
      const [px, py] = lattice.pointOf(x, y);
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  if (x0 > x1) return { room, x: 0, y: 0, w: 0, h: 0 };
  // A hex's corner past the outer centers: neighbors along a lattice row stand √3 radii apart, on either hex grid.
  const [ax, ay] = lattice.pointOf(0, 0);
  const [bx, by] = lattice.pointOf(1, 0);
  const pad = Math.hypot(bx - ax, by - ay) / Math.sqrt(3);
  return { room, x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Each of the given rooms' boxes, found by its place in the plan and named by its board index. */
export function roomBoxes(plan: Placed & Pick<DungeonPlan, "rooms">, rooms: readonly Numbered[]): RoomBox[] {
  return rooms.flatMap((f) => {
    const r = plan.rooms[f.at];
    return r ? [roomBox(plan, r, f.room)] : [];
  });
}

/**
 * The room a tap picks (phase 3, 4.1): the nearest box within `slop`
 * pixels of the point, inside one counting as 0, ties to the smaller box.
 * `point` is in cells and `px` the pixels a cell takes on screen. Only the
 * rooms given count, so a room gone from the plan is never picked.
 */
export function pickRoom(boxes: readonly RoomBox[], point: { x: number; y: number }, px: number, slop = 22): number | null {
  let best: { room: number; d: number; area: number } | null = null;
  for (const b of boxes) {
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.w));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.h));
    const d = Math.hypot(dx, dy) * px;
    if (d > slop) continue;
    const area = b.w * b.h;
    if (!best || d < best.d || (d === best.d && area < best.area)) best = { room: b.room, d, area };
  }
  return best?.room ?? null;
}

/** Where each light stands, in squares. */
export function lightMarks(plan: Pick<DungeonPlan, "lights">): LightMark[] {
  return plan.lights.map((l) => ({ x: l.x, y: l.y }));
}

/**
 * Each room's number at its pin's middle, which is where the landing puts
 * the pin. None with DM key off, unless `numbered` gives the rooms' numbers,
 * as Edit rooms does whatever DM key says (phase 3, 4.1). A key room names
 * its place in `plan.rooms` (keyRooms.ts), a numbered one by `at`.
 */
export function numberMarks(plan: Placed & Pick<DungeonPlan, "key" | "rooms">, numbered?: readonly Numbered[]): NumberMark[] {
  const rooms = numbered?.map((f) => ({ n: f.n, at: f.at })) ?? plan.key?.map((k) => ({ n: k.n, at: k.room }));
  if (!rooms) return [];
  const point = pointer(plan);
  return rooms.flatMap((k) => {
    const room = plan.rooms[k.at];
    if (!room) return [];
    const [x, y] = point(room.pin[0], room.pin[1]);
    return [{ n: k.n, x, y }];
  });
}

/** A light ring's radius and a number's text size, in squares. */
export const RING_RADIUS = 0.4;
export const NUMBER_SIZE = 1.1;

/**
 * Draws every mark on a canvas whose context is scaled to squares, so
 * Look closer's picture shows what the preview's overlay does. Strokes are
 * in pixels: `px` is the pixels a square takes.
 */
export function drawMarks(g: CanvasRenderingContext2D, plan: DungeonPlan, room: RoomState, sceneId: string, px: number, numbered?: readonly Numbered[]): void {
  g.save();
  g.setTransform(px, 0, 0, px, 0, 0);
  const stroke = (width: number, color: string) => {
    g.lineWidth = width / px;
    g.strokeStyle = color;
  };
  for (const trap of Object.values(room.traps ?? {})) if (trap) drawTrap(g, trap, room, sceneId, stroke);
  const e = roomBox(plan, plan.entrance);
  g.beginPath();
  g.roundRect(e.x - 0.5, e.y - 0.5, e.w + 1, e.h + 1, 0.8);
  stroke(4, boardTheme.color.textHalo);
  g.stroke();
  stroke(2, boardTheme.color.white);
  g.stroke();
  for (const m of lightMarks(plan)) {
    g.beginPath();
    g.arc(m.x, m.y, RING_RADIUS, 0, Math.PI * 2);
    stroke(4, RING_OUTLINE);
    g.stroke();
    stroke(2, LIGHT_RING);
    g.stroke();
  }
  g.font = `700 ${NUMBER_SIZE}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const m of numberMarks(plan, numbered)) {
    stroke(4, RING_OUTLINE);
    g.strokeText(String(m.n), m.x, m.y);
    g.fillStyle = boardTheme.color.white;
    g.fillText(String(m.n), m.x, m.y);
  }
  g.restore();
}

function drawTrap(g: CanvasRenderingContext2D, trap: Trap, room: RoomState, sceneId: string, stroke: (width: number, color: string) => void): void {
  const { zone } = trap;
  const danger = boardTheme.color.danger;
  g.fillStyle = danger;
  if ("cells" in zone) {
    for (const r of zone.cells) {
      g.globalAlpha = 0.35;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.globalAlpha = 1;
      stroke(1, danger);
      g.strokeRect(r.x, r.y, r.w, r.h);
    }
  } else if ("wire" in zone) {
    g.beginPath();
    g.moveTo(zone.wire.a[0], zone.wire.a[1]);
    g.lineTo(zone.wire.b[0], zone.wire.b[1]);
    stroke(4, boardTheme.color.textHalo);
    g.stroke();
    stroke(2, danger);
    g.stroke();
  } else {
    const door = findDoor(room.buildChunks, sceneId, zone.door);
    if (!door) return;
    g.globalAlpha = 0.35;
    g.fillRect(door.mid.x - 0.35, door.mid.y - 0.35, 0.7, 0.7);
    g.globalAlpha = 1;
    stroke(1, danger);
    g.strokeRect(door.mid.x - 0.35, door.mid.y - 0.35, 0.7, 0.7);
  }
}
