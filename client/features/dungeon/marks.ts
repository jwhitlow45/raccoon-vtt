import type { RoomState, Trap } from "#shared/model.ts";
import { boardTheme } from "../../lib/theme.ts";
import { findDoor } from "../doors/doors.ts";
import type { DungeonPlan } from "./plan.ts";

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

/** Where each light stands, in squares. */
export function lightMarks(plan: Pick<DungeonPlan, "lights">): LightMark[] {
  return plan.lights.map((l) => ({ x: l.x, y: l.y }));
}

/** Each room's number at its pin's middle, which is where the landing puts the pin. None with DM key off. */
export function numberMarks(plan: Pick<DungeonPlan, "key" | "rooms">): NumberMark[] {
  if (!plan.key) return [];
  return plan.key.flatMap((k) => {
    const room = plan.rooms[k.room];
    return room ? [{ n: k.n, x: room.pin[0] + 0.5, y: room.pin[1] + 0.5 }] : [];
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
export function drawMarks(g: CanvasRenderingContext2D, plan: DungeonPlan, room: RoomState, sceneId: string, px: number): void {
  g.save();
  g.setTransform(px, 0, 0, px, 0, 0);
  const stroke = (width: number, color: string) => {
    g.lineWidth = width / px;
    g.strokeStyle = color;
  };
  for (const trap of Object.values(room.traps ?? {})) if (trap) drawTrap(g, trap, room, sceneId, stroke);
  const e = plan.entrance;
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
  for (const m of numberMarks(plan)) {
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
