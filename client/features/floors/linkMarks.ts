import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { linkDir, rectKeys, rectsOverlap, type LinkEnd } from "#shared/rules/floorLinks.ts";
import { footprintRect, occupiedHexes, type PlacedToken } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { rectHexes } from "#shared/rules/traps.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import { viewPointOf } from "../../canvas/isoPlace.ts";
import type { IsoGround } from "../../canvas/relief/context.ts";
import type { Box } from "../../lib/boardText.ts";
import { hexOutline } from "../../lib/scene.ts";
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
export function drawnBox(p: PillSpec, scale: number, iso: DrawSpace, upright: boolean): Box {
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

/** Whether a pill's box, as it draws, meets any of the turn's markers (always upright). */
export function meetsTurnMarker(pill: PillSpec, markers: readonly PillSpec[], scale: number, iso: DrawSpace, upright: boolean): boolean {
  const mine = drawnBox(pill, scale, iso, upright);
  return markers.some((m) => {
    const b = drawnBox(m, scale, iso, true);
    return Math.min(mine.x1, b.x1) > Math.max(mine.x0, b.x0) && Math.min(mine.y1, b.y1) > Math.max(mine.y0, b.y0);
  });
}

/**
 * Where an upright pill can stand clear of the hole it names in Isometric
 * (a phone's small holes lay a pill hung from a map edge over the hole
 * itself, as the view turns): the hole's corners from the lowest on the
 * screen up for a name that hangs under its corner, or from the highest
 * down for a chip that sits over one. The first the pill stands at
 * (`fits`) wins, else null, and the caller keeps the pill's map edge.
 */
export function cornerPill(pill: PillSpec, corners: readonly { x: number; y: number }[], iso: Exclude<DrawSpace, null>, hangs: "under" | "over", fits: (p: PillSpec) => boolean): PillSpec | null {
  const sign = hangs === "under" ? -1 : 1;
  const ordered = corners
    .map((c) => ({ c, y: viewPointOf(iso, c).y }))
    .sort((a, b) => sign * (a.y - b.y));
  for (const { c } of ordered) {
    const at: PillSpec = { ...pill, x: c.x, y: c.y, above: hangs === "over", below: hangs === "under" };
    if (fits(at)) return at;
  }
  return null;
}

/**
 * An end's name pill kept off the turn's marker (FL2-POLISH): the name hangs
 * over the end's top edge, and where its box meets a marker's it hangs
 * under the bottom edge (`bottom`) instead, unless the marker meets that
 * spot too, when it keeps the first. Only the marker is read, never
 * another end's name or a trap's, so no two layers chase each other, and the
 * marker places itself from the creature alone (TurnStartLayer.tsx).
 *
 * The boxes meet or part where they draw, not on the map (B53-SOL-02): in
 * Isometric the marker always stands upright on the overlay, and the name
 * stands too where `upright` (the stand rule) or else lies flat, so two
 * pills apart on the map can cover each other on screen, and the reverse.
 */
export function clearOfMarkers(pill: PillSpec, bottom: { x: number; y: number }, markers: readonly PillSpec[], scale: number, iso: DrawSpace = null, upright = true): PillSpec {
  const meetsMarker = (p: PillSpec) => meetsTurnMarker(p, markers, scale, iso, upright);
  if (!meetsMarker(pill)) return pill;
  // Under the end can meet the marker too (Isometric on a phone), and then moving only trades one cover for another.
  const under: PillSpec = { ...pill, x: bottom.x, y: bottom.y, above: false, below: true };
  return meetsMarker(under) ? pill : under;
}

/** An end's squares as the board draws them: a box in cells, and on hexes the outline of its hexes. */
export type Outline = { x: number; y: number; w: number; h: number; loop: number[] | null };

export function outlineOf(g: Grid, rect: FloorLink["rect"]): Outline {
  if (!isHex(g)) return { ...rect, loop: null };
  const loop = hexOutline(g, rectHexes([rect]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < loop.length; i += 2) {
    x0 = Math.min(x0, loop[i]!);
    x1 = Math.max(x1, loop[i]!);
    y0 = Math.min(y0, loop[i + 1]!);
    y1 = Math.max(y1, loop[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, loop };
}

/** Where the name hangs: over the middle of the top edge, or under the bottom edge's, and on hexes the extreme point or side nearest the middle, so it never points at the notch between two hexes. */
export function nameAnchor(o: Outline, edge: "top" | "bottom" = "top"): { x: number; y: number } {
  const mid = o.x + o.w / 2;
  const y0 = edge === "top" ? o.y : o.y + o.h;
  if (!o.loop) return { x: mid, y: y0 };
  let best = { x: mid, y: y0 };
  let gap = Infinity;
  for (let i = 0; i + 1 < o.loop.length; i += 2) {
    const x = o.loop[i]!;
    const y = o.loop[i + 1]!;
    if (Math.abs(y - y0) > 1e-9) continue;
    if (Math.abs(x - mid) < gap) {
      gap = Math.abs(x - mid);
      best = { x, y };
    }
  }
  return best;
}

/** An end's corners: a box's four, and on hexes the outline's points. */
export function cornersOf(o: Outline): { x: number; y: number }[] {
  if (o.loop) {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < o.loop.length; i += 2) out.push({ x: o.loop[i]!, y: o.loop[i + 1]! });
    return out;
  }
  return [
    { x: o.x, y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x, y: o.y + o.h },
    { x: o.x + o.w, y: o.y + o.h },
  ];
}


/** The squares an end covers as they draw in Isometric: the box round its corners at the ground's height, as a flat pill's is (drawnBox). */
export function outlineBox(corners: readonly { x: number; y: number }[], iso: Exclude<DrawSpace, null>): Box {
  const seen = corners.map((c) => viewPointOf(iso, c));
  return { x0: Math.min(...seen.map((c) => c.x)), y0: Math.min(...seen.map((c) => c.y)), x1: Math.max(...seen.map((c) => c.x)), y1: Math.max(...seen.map((c) => c.y)) };
}

function boxesMeet(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

/** One end's pills before they are placed: the name and the height chip as the end would hang them alone (LinkLayer.tsx). */
export type EndPills = { id: string; o: Outline; hole: boolean; first: PillSpec | null; dropPill: PillSpec | null };

/** One end's pills where they hang: `pill` is its name, `chip` its height. */
export type PlacedPills = { pill: PillSpec | null; chip: PillSpec | null };

/**
 * Every end's pills on the floor shown, placed in order of id so each reads
 * the ones before it (LP47B-ISO-1). In Isometric a hole's pill hangs from
 * a corner of its own, and two holes a square apart let one hole's name
 * cover the other hole or its pills as the view turns. A hole's pill takes
 * the first corner where it stands (`stands`), clears the turn's marker and
 * meets neither another end's squares nor an earlier end's pill, else the
 * first that meets no earlier pill, else it keeps the end's own edge. The later end is the one that moves, so the
 * two never chase each other. Top-down hangs each pill from its fixed edge.
 */
export function placeEnds(ends: readonly EndPills[], markers: readonly PillSpec[], scale: number, iso: DrawSpace, stands: (p: PillSpec) => boolean): Map<string, PlacedPills> {
  const out = new Map<string, PlacedPills>();
  const boxes = ends.map((e) => (iso ? outlineBox(cornersOf(e.o), iso) : null));
  const pillBoxes: Box[][] = [];
  ends.forEach((e, i) => {
    const { o, hole, first, dropPill } = e;
    // Every stage decides alike, from the first place's stand, so the ground and the overlay publish the same pill.
    const placed = first ? clearOfMarkers(first, nameAnchor(o, hole ? "top" : "bottom"), markers, scale, iso, iso ? stands(first) : true) : null;
    const corners = cornersOf(o);
    const squares: Box[] = [];
    boxes.forEach((b, j) => {
      if (b && j !== i) squares.push(b);
    });
    const pills: Box[] = [];
    for (let j = 0; j < i; j++) pills.push(...pillBoxes[j]!);
    const meets = (p: PillSpec, taken: readonly Box[]) => taken.some((b) => boxesMeet(drawnBox(p, scale, iso, true), b));
    // Where no corner keeps off the other ends' squares too, as at a phone's scale where a pill is wider than the gap, keeping off the pills is what reads, and past that the corner a lone hole would take.
    const tiers = [(p: PillSpec) => !meets(p, squares) && !meets(p, pills), (p: PillSpec) => !meets(p, pills), () => true];
    const hung = (spec: PillSpec, hangs: "under" | "over", also: (p: PillSpec) => boolean) => {
      for (const tier of tiers) {
        const got = cornerPill(spec, corners, iso!, hangs, (p) => stands(p) && also(p) && tier(p));
        if (got) return got;
        // The end's own edge is a place too, and the one a lone hole keeps where no corner serves.
        if (tier !== tiers.at(-1) && stands(spec) && also(spec) && tier(spec)) return spec;
      }
      return spec;
    };
    const pill = placed && hole && iso ? hung(placed, "under", (p) => !meetsTurnMarker(p, markers, scale, iso, true)) : placed;
    const chip = dropPill && iso ? hung(dropPill, "over", () => true) : dropPill;
    pillBoxes.push([pill, chip].flatMap((p) => (p && iso ? [drawnBox(p, scale, iso, stands(p))] : [])));
    out.set(e.id, { pill, chip });
  });
  return out;
}
