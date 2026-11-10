import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { linkDir, rectKeys, rectsOverlap, type LinkEnd } from "#shared/rules/floorLinks.ts";
import { footprintRect, occupiedHexes, type PlacedToken } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexKey } from "#shared/rules/hex.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import { viewPointOf } from "../../canvas/isoPlace.ts";
import type { IsoGround } from "../../canvas/relief/context.ts";
import type { Box } from "../../lib/boardText.ts";
import { isometric, toView } from "../../lib/view.ts";
import { pillReach } from "../measure/pillPlace.ts";
import { turnMoverId } from "../attach/turns.ts";
import { pathNow } from "../measure/movement.ts";
import { FLOOR_MARKS } from "../scenes/floorWords.ts";
import { floorStatus } from "./words.ts";
import { linkName } from "./linkWords.ts";

/*
 * What the board draws for each stairs or ladder end on the floor shown
 * (docs/design/design-v1-floors.md phase 2, 10, 11), as plain functions
 * for node --test: its name, the DM's mark of a far floor players have not
 * reached, and which names give way to the turn's marker.
 */

/**
 * An end's name pill (11): "Up to Upper floor" where the viewer's copy
 * holds that floor, else "Stairs up" or "Ladder down", which names none.
 * Null where the copy cannot tell the way.
 */
export function linkLabel(view: Pick<RoomState, "scenes">, link: LinkEnd): string | null {
  const dir = linkDir(view, link);
  if (dir === null) return null;
  const far = link.to === undefined ? undefined : ownEntry(view.scenes, link.to)?.floor?.name;
  return linkName(dir, link.kind, far ?? null);
}

/**
 * The ends on a floor whose far floor players have not reached, by id, as
 * the DM's Floors menu marks a floor (words.ts floorStatus): the DM's pill
 * adds "Not reached yet" there (10, picture 08). Only the DM's copy holds
 * the marks, so a player's reads none.
 */
export function notReachedLinks(view: Pick<RoomState, "meta" | "tokens" | "scenes" | "openFloors" | "characters" | "floorLinks">, sceneId: string): string[] {
  return Object.values(view.floorLinks ?? {})
    .filter((l) => l.sceneId === sceneId && l.to !== undefined && ownEntry(view.scenes, l.to) !== undefined && floorStatus(view, l.to) === FLOOR_MARKS.not)
    .map((l) => l.id)
    .sort();
}

/** Whether a creature placed so has any of its space on the squares: its hexes on a hex floor, its box on squares. */
function touches(g: Grid, placed: PlacedToken, rect: FloorLink["rect"]): boolean {
  if (isHex(g)) {
    const held = new Set(rectKeys(rect));
    return occupiedHexes(g, placed).some((h) => held.has(hexKey(h)));
  }
  const r = footprintRect(g, placed);
  const E = 1e-9;
  return rectsOverlap({ x: r.x + E, y: r.y + E, w: r.w - 2 * E, h: r.h - 2 * E }, rect);
}

/**
 * The ends whose names give way to the turn's marker (6.4, picture 07):
 * the turn's mover stands on the end, and its moves on this floor began
 * there, where the marker's ring hangs, as after it climbed onto it. Read
 * on the board's copy of the floor shown, as the marker reads it.
 */
export function quietLinks(view: Pick<RoomState, "tokens" | "encounter" | "scenes" | "floorLinks"> | null | undefined, sceneId: string, role: "dm" | "player"): string[] {
  if (!view) return [];
  const moverId = turnMoverId(view);
  const mover: Token | undefined = moverId === undefined ? undefined : ownEntry(view.tokens, moverId);
  const scene = ownEntry(view.scenes, sceneId);
  if (!mover || mover.sceneId !== sceneId || !scene) return [];
  const first = pathNow(view.encounter, mover, role)?.stops[0];
  if (!first) return [];
  const g = sceneGrid(scene);
  const began = { ...mover, x: first.x, y: first.y };
  return Object.values(view.floorLinks ?? {})
    .filter((l) => l.sceneId === sceneId && touches(g, mover, l.rect) && touches(g, began, l.rect))
    .map((l) => l.id)
    .sort();
}

/** What places a pill in Isometric: the view's turn and the drawn ground. Null in Top-down. */
export type DrawSpace = Pick<IsoGround, "turn" | "ground"> | null;

/**
 * A pill's box where it draws: in cells in Top-down, and in Isometric's view
 * units otherwise. An upright pill stands at its point's drawn height, as
 * MarkPill puts it. One lying flat on the ground under the fog covers the
 * view's box round its corners at the ground's height, as the ground plane
 * turns and squashes it.
 */
function drawnBox(p: PillSpec, scale: number, iso: DrawSpace, upright: boolean): Box {
  if (!iso) return pillReach({ ...p, scale });
  if (upright) {
    const v = viewPointOf(iso, p);
    return pillReach({ ...p, x: v.x, y: v.y, scale });
  }
  const b = pillReach({ ...p, scale });
  const view = isometric(iso.turn);
  const z = iso.ground(p.x, p.y);
  const corners = [toView(view, { x: b.x0, y: b.y0 }, z), toView(view, { x: b.x1, y: b.y0 }, z), toView(view, { x: b.x0, y: b.y1 }, z), toView(view, { x: b.x1, y: b.y1 }, z)];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * An end's name pill kept off the turn's marker (FL2-POLISH): the name hangs
 * over the end's top edge, and where its box meets a marker's it hangs
 * under the bottom edge (`bottom`) instead. Only the marker is read, never
 * another end's name or a trap's, so no two layers chase each other, and the
 * marker places itself from the creature alone (TurnStartLayer.tsx).
 *
 * The boxes meet or part where they draw, not on the map (B53-SOL-02): in
 * Isometric the marker always stands upright on the overlay, and the name
 * stands too where `upright` (the stand rule) or else lies flat, so two
 * pills apart on the map can cover each other on screen, and the reverse.
 */
export function clearOfMarkers(pill: PillSpec, bottom: { x: number; y: number }, markers: readonly PillSpec[], scale: number, iso: DrawSpace = null, upright = true): PillSpec {
  const mine = drawnBox(pill, scale, iso, upright);
  const meets = markers.some((m) => {
    const b = drawnBox(m, scale, iso, true);
    return Math.min(mine.x1, b.x1) > Math.max(mine.x0, b.x0) && Math.min(mine.y1, b.y1) > Math.max(mine.y0, b.y0);
  });
  return meets ? { ...pill, x: bottom.x, y: bottom.y, above: false, below: true } : pill;
}
