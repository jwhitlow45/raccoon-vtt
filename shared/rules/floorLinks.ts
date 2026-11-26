import { LIMITS } from "../limits.ts";
import { fallsOnce } from "../migrate.ts";
import type { CellRect, FloorLink, FloorLinkId, RoomState, Scene, SceneId, Token, Viewer } from "../model.ts";
import { FLOOR_HEIGHT, STAIRS_SIDE_WORDS } from "../protocol.ts";
import { parseKey, writeEntity, type EntityKey } from "../keys.ts";
import { ownEntry } from "../records.ts";
import { isWritable } from "../writable.ts";
import { floorLinkRules, floorsOf, sameScene } from "./floors.ts";
import { canSqueeze, footprintRect, footprintSize, isSqueezed, occupiedHexes, squeezedSize, type PlacedToken } from "./footprint.ts";
import { inScene, isHex, sceneGrid, type Grid } from "./grid.ts";
import { footprintGround, groundAt } from "./heights.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexKey, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { crossesInterior, ownWalk, squeezeFits, walkEnd } from "./movement.ts";
import { orient } from "./segments.ts";
import { RAISED, sceneWalls } from "./walls.ts";

/*
 * Stairs and ladders between floors (docs/design/design-v1-floors.md phase
 * 2): the questions the reducer, permissions, the floor checks, the
 * projection and the builder's draft each ask of an end, and the words
 * every refusal of them reads.
 *
 * Every question works on the server's state and on a device's projected
 * copy. A DM's copy holds every end as stored. A player's copy holds only
 * the ends on floors they hold, cut to ProjectedFloorLink: no pair, ground
 * or seq, `to` only while they hold that floor, and `dir` in its place.
 */

/** An end as any copy holds it: the stored record, or a player's cut with `dir`. */
export type LinkEnd = Pick<FloorLink, "id" | "rev" | "sceneId" | "rect" | "kind" | "locked" | "grid"> & { to?: SceneId; dir?: "up" | "down" };

/** What `floorLink.put` names: the two ends' ids, the two floors, the squares and the kind. */
export type LinkDraft = {
  id: FloorLinkId;
  pairId: FloorLinkId;
  sceneId: SceneId;
  to: SceneId;
  rect: CellRect;
  kind: FloorLink["kind"];
  /** The far end's own squares, where stairs or a ladder on squares lie on other squares of the far floor (phase 4, 8.2). */
  pairRect?: CellRect;
};

/** Whether a creature on an end may take it (6.1): it fits, it fits only squeezed, or it is too big. */
export type Stand = "on" | "squeeze" | "tooBig";

/** "stairs", "ladder" or "opening", as the words name it. */
type Kind = FloorLink["kind"];

/**
 * How the words name each kind (phase 4, 3, D-261119-093): exhaustive, so a
 * new kind cannot fall into another's words. `bare` stands alone after a
 * verb ("place stairs"), `the` after a preposition ("block the opening"),
 * `this` names the one a creature stands on, and `them` takes its place.
 */
export const KIND_WORDS: Record<Kind, { bare: string; the: string; this: string; them: "them" | "it"; joins: string }> = {
  stairs: { bare: "stairs", the: "the stairs", this: "these stairs", them: "them", joins: "Stairs join" },
  ladder: { bare: "a ladder", the: "the ladder", this: "this ladder", them: "it", joins: "A ladder joins" },
  opening: { bare: "an opening", the: "the opening", this: "this opening", them: "it", joins: "An opening joins" },
};

const them = (kind: Kind) => KIND_WORDS[kind].them;

/** The words of every refusal of stairs, ladders and openings (docs/design/design-v1-floors.md 6.3, 7.3, 8, phase 4 3 and 5). */
export const LINK_WORDS = {
  /** An end gone, fogged, hidden, on a floor not held or not under the creature: one code, one text (4). */
  noStairs: "There are no stairs here.",
  carried: (name: string, kind: Kind) => (kind === "opening" ? `${name} is carried. Its holder goes through the opening.` : `${name} is carried. Its holder takes ${KIND_WORDS[kind].the}.`),
  locked: "It's locked.",
  tooBigSqueeze: (kind: Kind) => `Too big for ${KIND_WORDS[kind].this}. Squeeze to fit.`,
  tooBig: (kind: Kind) => `Too big for ${KIND_WORDS[kind].this}.`,
  /** A creature on the ground under or over an opening: only a flier goes through (phase 4, 5). */
  onlyInAir: "Only a creature in the air goes through an opening.",
  /** The reason a climb's undo or redo is refused, after the label the actor puts before it. */
  changed: (kind: Kind) => `${KIND_WORDS[kind].the} changed`,
  // The builder's refusals of a draft (7.3).
  wall: (floor: string) => `A wall crosses those squares on ${floor}.`,
  twoHeights: (floor: string) => `Those squares aren't one height on ${floor}.`,
  pit: (floor: string) => `A pit trap lies under those squares on ${floor}.`,
  pastEdge: (floor: string) => `${floor} ends before those squares.`,
  overEnd: (kind: Kind, to: string, on: string) => `Those squares already have ${KIND_WORDS[kind].bare} to ${to} on ${on}.`,
  tooMany: (scene: string) => `${scene} has ${LIMITS.floorLinksPerScene} stairs, ladders and openings, the most a scene can hold.`,
  notNext: "Stairs join a floor and the floor just above or below it.",
  /** notNext for any kind (phase 4, 3): "An opening joins a floor and the floor just above or below it." */
  notNextFor: (kind: Kind) => `${KIND_WORDS[kind].joins} a floor and the floor just above or below it.`,
  /** Stairs and ladders past their side (phase 4, 3), the put schema's words. Openings keep to LIMITS.openingSide, which the schema holds. */
  stairsSide: STAIRS_SIDE_WORDS,
  openingSide: `Openings are at most ${LIMITS.openingSide} squares a side.`,
  /** An opening's lock and hiding (phase 4, 3). */
  openingLocked: "Openings can't be locked.",
  openingHidden: "Openings can't be hidden. A pit trap can open to the floor below.",
  /** A change of kind to or from an opening (phase 4, 3): "Remove it and place an opening." */
  kindChange: (from: Kind, to: Kind) => `Remove ${them(from)} and place ${KIND_WORDS[to].bare}.`,
  /** Ends on their own squares (phase 4, 8.2): stairs and ladders on squares, at one size. */
  oneSize: (kind: Kind) => `Both ends of ${KIND_WORDS[kind].the} are one size.`,
  sameSquares: (kind: Kind) => (kind === "opening" ? "An opening lies on the same squares of both floors." : `On hexes both ends of ${KIND_WORDS[kind].the} lie on the same hexes.`),
  // A later edit floorProblem refuses (3), each ending in one of STAIRS_ENDINGS, which isStairsRefusal reads.
  changeGround: (kind: Kind, floor: string) => `That would change the ground under ${KIND_WORDS[kind].the} to ${floor}. ${removeFirst(kind)}`,
  block: (kind: Kind, floor: string) => `That would block ${KIND_WORDS[kind].the} to ${floor}. ${removeFirst(kind)}`,
  between: (kind: Kind, lower: string, upper: string) => `${KIND_WORDS[kind].joins} ${lower} and ${upper}. Remove ${them(kind)} before putting a floor between.`,
  /** A pit trap's create or update over an end, in the trap pane's words (3). A trapdoor reads the same (phase 4, 4.6). */
  pitUnder: (kind: Kind) => `A pit can't open under ${kind === "stairs" ? "stairs" : KIND_WORDS[kind].bare}. ${removeFirst(kind)}`,
} as const;

function removeFirst(kind: Kind): string {
  return `Remove ${them(kind)} first.`;
}

/** The sentence a restore's stairs refusal reads in place of "Remove them first." (8): true whoever placed them. */
function placerCan(kind: "them" | "it"): string {
  return kind === "them" ? "The DM who placed them can remove them." : "The DM who placed it can remove it.";
}

const STAIRS_ENDINGS = [/ Remove them first\.$/, / Remove it first\.$/, / Remove them before putting a floor between\.$/, / Remove it before putting a floor between\.$/];

/** Whether a refusal is one of floorProblem's stairs rules (8, D-261109-108), so a DM's refused undo or redo keeps its step. */
export function isStairsRefusal(message: string): boolean {
  return STAIRS_ENDINGS.some((ending) => ending.test(message));
}

/**
 * A stairs refusal in a restore's words (8): "Remove them first." becomes
 * "The DM who placed them can remove them.", and "Stairs join Ground floor
 * and Upper floor. Remove them before…" keeps its first sentence before
 * it. Any other message comes back as it is.
 */
export function restoreStairsWords(message: string): string {
  for (const ending of STAIRS_ENDINGS) {
    if (!ending.test(message)) continue;
    return `${message.replace(ending, "")} ${placerCan(/Remove them/.test(message) ? "them" : "it")}`;
  }
  return message;
}

/**
 * The label of a climb's undo step (6.3), without "Undo": "moving Thorn up
 * the stairs", and a flight's through an opening (phase 4, 5): "flying
 * Thorn down through the opening". The undo labels read it for the step
 * and its refusals.
 */
export function climbLabel(name: string, dir: "up" | "down", kind: Kind): string {
  return kind === "opening" ? `flying ${name} ${dir} through the opening` : `moving ${name} ${dir} ${KIND_WORDS[kind].the}`;
}

/** The labels of the builder's undo steps (7.2, phase 4 8.2), without "Undo": "placing stairs to Upper floor". */
export const LINK_LABELS = {
  placed: (kind: Kind, floor: string) => `placing ${KIND_WORDS[kind].bare} to ${floor}`,
  removed: (kind: Kind, floor: string) => `removing ${KIND_WORDS[kind].bare} to ${floor}`,
  lock: (kind: Kind, locked: boolean) => `${locked ? "locking" : "unlocking"} ${KIND_WORDS[kind].the}`,
  /** Only stairs and ladders change kind: an opening is removed and placed again (phase 4, 3). */
  kind: (from: Kind) => (from === "stairs" ? "changing stairs to a ladder" : "changing a ladder to stairs"),
  hide: (kind: Kind, hidden: boolean) => `${hidden ? "hiding" : "showing"} ${KIND_WORDS[kind].the}`,
  moved: (kind: Kind, floor: string) => `moving ${KIND_WORDS[kind].bare} to ${floor}`,
  resized: (kind: Kind, floor: string) => `resizing ${KIND_WORDS[kind].bare} to ${floor}`,
  /** An update that changes neither the kind nor the lock, which the pane never sends. */
  same: (kind: Kind) => `changing ${KIND_WORDS[kind].bare}`,
} as const;

/** The ends on a floor, by id order, so every reader walks them alike. */
export function linksOn(state: Pick<RoomState, "floorLinks">, sceneId: SceneId): FloorLink[] {
  return Object.values(state.floorLinks ?? {})
    .filter((link) => link.sceneId === sceneId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The way an end leads (2): up where `to` lies above its floor. A player's
 * copy carries `dir`, worked out on the server from levels it never sends.
 * Null where neither floor reads a level.
 */
export function linkDir(state: Pick<RoomState, "scenes">, link: LinkEnd): "up" | "down" | null {
  if (link.dir !== undefined) return link.dir;
  if (link.to === undefined) return null;
  const here = ownEntry(state.scenes, link.sceneId)?.floor?.level;
  const there = ownEntry(state.scenes, link.to)?.floor?.level;
  if (here === undefined || there === undefined || here === there) return null;
  return there > here ? "up" : "down";
}

/**
 * The height an end climbs (5.1, D-261109-100): the upper floor's
 * `floor.height`, FLOOR_HEIGHT.initial where it stores none, as the floor's
 * page reads it. Only the server's state and a DM's copy hold heights, so a
 * player's end carries its own as `rise` (phase 3, 4.3), read first.
 */
export function linkHeight(state: Pick<RoomState, "scenes">, link: Pick<LinkEnd, "sceneId" | "to"> & { rise?: number }): number {
  if (link.rise !== undefined) return link.rise;
  const here = ownEntry(state.scenes, link.sceneId)?.floor;
  const there = link.to === undefined ? undefined : ownEntry(state.scenes, link.to)?.floor;
  const upper = (there?.level ?? 0) > (here?.level ?? 0) ? there : here;
  return upper?.height ?? FLOOR_HEIGHT.initial;
}

// ---------------------------------------------------------------------------
// Openings (docs/design/design-v1-floors.md phase 4)

/**
 * How far a creature falls through an opening (4.2): the floor's height
 * (`rise`, linkHeight) plus the upper end's ground less the lower end's, at
 * least 0. The server reads both grounds from the pair, and a device from
 * its own build chunks with its end's `rise`.
 */
export function fallDrop(rise: number, upperGround: number, lowerGround: number): number {
  return Math.max(0, rise + upperGround - lowerGround);
}

/** A fall's d6 of Bludgeoning damage (SRD 5.2.1): one for each full 10 ft dropped, at most 20, none under 10 ft. */
export function fallDice(ft: number): number {
  return Math.min(20, Math.max(0, Math.floor(ft / 10)));
}

/** How high above the far end's ground a flight through an opening lands (phase 4, 5). */
export const FLIGHT_LANDING_FT = 5;

/**
 * Whether a flier may take an opening (5): standsOn's test with the
 * creature in the air (`elevation > footprintGround`) and its space inside
 * the squares, squeeze rules unchanged. A creature on the ground gets null,
 * as it gets no Fly up or Fly down.
 */
export function throughOpening(view: RoomState, _viewer: Viewer, token: Token, link: LinkEnd): Stand | null {
  if (link.kind !== "opening" || token.sceneId !== link.sceneId) return null;
  if (!(token.elevation > footprintGround(view.buildChunks, token))) return null;
  return standing(view, token, link);
}

/**
 * The offset a climb lands by where the far end of stairs or a ladder lies
 * on other squares (8.2): the far end's place less this end's, in cells.
 * A player's end carries it as `shift` only while the far end is projected.
 */
export function landingShift(near: Pick<FloorLink, "rect">, far: Pick<FloorLink, "rect">): { dx: number; dy: number } {
  return { dx: far.rect.x - near.rect.x, dy: far.rect.y - near.rect.y };
}

/**
 * Where a creature that goes through an end lands on the far floor (3,
 * phase 4 4.2, 5, 8.2): on the far end's ground, shifted by the far end's
 * offset, and 5 ft above that ground for a flier through an opening, which
 * is in the air where it starts, where a faller stands on the ground. The
 * move's plan (rules/moveLeg.ts) and the landing (reducer/floorLinks.ts
 * landThrough) both read it, so the two never part.
 */
export function landingOf(state: Pick<RoomState, "buildChunks">, token: Token, link: Pick<FloorLink, "rect" | "kind">, far: Pick<FloorLink, "rect" | "ground">): { x: number; y: number; elevation: number } {
  const { dx, dy } = landingShift(link, far);
  const flies = link.kind === "opening" && token.elevation > footprintGround(state.buildChunks, token);
  return { x: dx === 0 ? token.x : token.x + dx, y: dy === 0 ? token.y : token.y + dy, elevation: flies ? far.ground + FLIGHT_LANDING_FT : far.ground };
}

/** The floor just below this one in its scene, or undefined on the lowest floor or a scene without floors (phase 4, 4.6). */
export function floorBelow(state: Pick<RoomState, "scenes">, sceneId: SceneId): Scene | undefined {
  const here = ownEntry(state.scenes, sceneId)?.floor;
  if (here === undefined) return undefined;
  return floorsOf(state, sceneId).find((s) => s.floor !== undefined && s.floor.level === here.level - 1);
}

/** The most squares a side of an end of this kind (phase 4, 3): LIMITS.openingSide for an opening, LIMITS.floorLinkSide for stairs and ladders. */
export function linkSideOf(kind: Kind): number {
  return kind === "opening" ? LIMITS.openingSide : LIMITS.floorLinkSide;
}

/** Whether an end is an opening's upper end, the hole: an opening whose far floor lies below its own (phase 4, 3). */
export function isHole(state: Pick<RoomState, "scenes">, link: LinkEnd): boolean {
  return link.kind === "opening" && linkDir(state, link) === "down";
}

// ---------------------------------------------------------------------------
// Squares

/** The cell keys of an end's squares: x, y on squares, column and row on hexes, as a trap's zone keys them. */
export function rectKeys(rect: CellRect): string[] {
  const out: string[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) out.push(`${x},${y}`);
  return out;
}

/** Whether two rectangles of cells share a cell. */
export function rectsOverlap(a: CellRect, b: CellRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether every cell of the squares lies on the floor, by its grid (grid.ts inScene). */
export function rectInScene(scene: Pick<Scene, "bounds" | "gridShape">, rect: CellRect): boolean {
  const g = sceneGrid(scene);
  return rectKeys(rect).every((key) => inScene(g, scene.bounds, key));
}

/**
 * The one ground height of the squares on a floor (2, D-261109-106), or
 * null where they are not one height. Each cell's painted height, as a
 * walk reads it (heights.ts groundAt), by its key on either grid.
 */
export function rectGround(chunks: RoomState["buildChunks"], sceneId: SceneId, rect: CellRect): number | null {
  let ground: number | null = null;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const here = groundAt(chunks, sceneId, x, y);
      if (ground === null) ground = here;
      else if (here !== ground) return null;
    }
  }
  return ground;
}

/**
 * Whether a wall, door, window or pillar passes through the squares on a
 * floor (3, 7.3), not only along their outer edge: a creature on the
 * stairs would stand across it. Raised edges are the ground's rule
 * (`rectGround`), so they are left out. On hexes the squares are the hexes
 * their keys name, and a wall line counts where it enters one of them or
 * runs along a side two of them share.
 */
export function wallInside(state: Pick<RoomState, "scenes" | "buildChunks">, sceneId: SceneId, rect: CellRect): boolean {
  const scene = ownEntry(state.scenes, sceneId);
  if (scene === undefined) return false;
  const stored = sceneWalls(scene, state.buildChunks).stored;
  const { box, crosses } = endRegion(sceneGrid(scene), rect);
  const xy = stored.xy;
  for (let k = 0; k < stored.n; k++) {
    if ((stored.tags[k]! & RAISED) !== 0) continue;
    const ax = xy[4 * k]!;
    const ay = xy[4 * k + 1]!;
    const bx = xy[4 * k + 2]!;
    const by = xy[4 * k + 3]!;
    // The floor check asks this of every end on every op that names the scene's floors, a token's move too, and
    // nearly every wall lies far from the end: one whose box misses the squares' box cannot cross them, so the
    // exact test runs only for the few beside them (FL2-OPUS-3, scripts/bench-floor-links.ts).
    if ((ax < box.x0 && bx < box.x0) || (ax > box.x1 && bx > box.x1) || (ay < box.y0 && by < box.y0) || (ay > box.y1 && by > box.y1)) continue;
    if (crosses(ax, ay, bx, by)) return true;
  }
  return false;
}

/** A box in the walls' units, and the test of a wall segment against the squares inside it. */
export type EndRegion = { box: { x0: number; y0: number; x1: number; y1: number }; crosses: (ax: number, ay: number, bx: number, by: number) => boolean };

/**
 * `wallInside`'s exact test of one segment against an end's squares, and
 * a box that holds them whole: `crosses` is false for every segment with
 * both ends on one outer side of the box (floorLinks.prop.test.ts).
 */
export function endRegion(g: Grid, rect: CellRect): EndRegion {
  if (isHex(g)) return hexRegion(g, rect);
  const box = { x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h };
  return { box, crosses: (ax, ay, bx, by) => crossesInterior(box.x0, box.y0, box.x1, box.y1, ax, ay, bx, by) };
}

/** The test of `wallInside` on hexes: a segment that enters a hex of the squares, or lies along a side two of them share. */
function hexRegion(g: HexGrid, rect: CellRect): EndRegion {
  const held = new Set(rectKeys(rect));
  const hexes: Hex[] = [...held].map((key) => {
    const [col, row] = key.split(",").map(Number);
    return { col: col!, row: row! };
  });
  const polygons = hexes.map((h) => hexCorners(g, h).map((c) => cornerAt(g, c)));
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const poly of polygons) {
    for (const p of poly) {
      box.x0 = Math.min(box.x0, p.x);
      box.y0 = Math.min(box.y0, p.y);
      box.x1 = Math.max(box.x1, p.x);
      box.y1 = Math.max(box.y1, p.y);
    }
  }
  // Each side two held hexes share, once, as its two corners.
  const sides: [number, number, number, number][] = [];
  for (const [i, h] of hexes.entries()) {
    const corners = polygons[i]!;
    for (let k = 0; k < 6; k++) {
      const a = corners[k]!;
      const b = corners[(k + 1) % 6]!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const c = hexCenter(g, h);
      // Just past the side's middle, away from this hex: the neighbor across it.
      const across = hexAt(g, { x: mid.x + (mid.x - c.x) * 0.1, y: mid.y + (mid.y - c.y) * 0.1 });
      if (held.has(hexKey(across)) && hexKey(h) < hexKey(across)) sides.push([a.x, a.y, b.x, b.y]);
    }
  }
  return { box, crosses: (ax, ay, bx, by) => polygons.some((poly) => crossesConvex(poly, ax, ay, bx, by)) || sides.some(([px, py, qx, qy]) => overlapsAlong(px, py, qx, qy, ax, ay, bx, by)) };
}

/**
 * Whether the closed segment AB passes through the open convex polygon:
 * they miss exactly when the segment's line has the polygon on one side or
 * on it, or a side's line has the segment wholly outside or on it.
 */
function crossesConvex(poly: readonly { x: number; y: number }[], ax: number, ay: number, bx: number, by: number): boolean {
  let pos = false;
  let neg = false;
  for (const p of poly) {
    const o = orient(ax, ay, bx, by, p.x, p.y);
    if (o > 0) pos = true;
    else if (o < 0) neg = true;
  }
  if (!pos || !neg) return false;
  // Which way the polygon winds, by a point of it off its first side.
  const n = poly.length;
  const wind = orient(poly[0]!.x, poly[0]!.y, poly[1]!.x, poly[1]!.y, poly[2]!.x, poly[2]!.y);
  for (let k = 0; k < n; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % n]!;
    if (orient(p.x, p.y, q.x, q.y, ax, ay) !== wind && orient(p.x, p.y, q.x, q.y, bx, by) !== wind) return false;
  }
  return true;
}

/** Whether AB lies along the line of PQ over a length the two share. */
function overlapsAlong(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (orient(px, py, qx, qy, ax, ay) !== 0 || orient(px, py, qx, qy, bx, by) !== 0) return false;
  const vertical = Math.abs(qx - px) < Math.abs(qy - py);
  const along = (x: number, y: number) => (vertical ? y : x);
  const lo = Math.max(Math.min(along(px, py), along(qx, qy)), Math.min(along(ax, ay), along(bx, by)));
  const hi = Math.min(Math.max(along(px, py), along(qx, qy)), Math.max(along(ax, ay), along(bx, by)));
  return hi > lo;
}

/**
 * A trap whose rig opens a pit, or drops to the floor below, and whose
 * squares share a cell with these on the floor (3, phase 4 4.6), the first
 * by id, or null: a pit would drop the ground an end stands on.
 */
export function pitUnder(state: Pick<RoomState, "traps">, sceneId: SceneId, rect: CellRect): string | null {
  const ids = Object.keys(state.traps).sort();
  for (const id of ids) {
    const trap = state.traps[id]!;
    // A trapdoor drops what stands on it (phase 4, 4.6), so it keeps off every end as a pit does, and a landing never lies on one.
    if (trap.sceneId !== sceneId || (trap.rig?.pit === undefined && trap.rig?.below !== true) || !("cells" in trap.zone)) continue;
    if (trap.zone.cells.some((cells) => rectsOverlap(cells, rect))) return trap.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Climbs

/** Whether the creature's snapped footprint lies inside the squares, and whether it touches them at all. */
function placeOn(g: Grid, token: PlacedToken, rect: CellRect): { inside: boolean; touches: boolean } {
  if (isHex(g)) {
    const keys = occupiedHexes(g, token).map(hexKey);
    const held = new Set(rectKeys(rect));
    const on = keys.filter((key) => held.has(key)).length;
    return { inside: on === keys.length, touches: on > 0 };
  }
  const r = footprintRect(g, token);
  const E = 1e-9;
  const inside = r.x >= rect.x - E && r.y >= rect.y - E && r.x + r.w <= rect.x + rect.w + E && r.y + r.h <= rect.y + rect.h + E;
  const touches = r.x < rect.x + rect.w - E && rect.x < r.x + r.w - E && r.y < rect.y + rect.h - E && rect.y < r.y + r.h - E;
  return { inside, touches };
}

/** Whether the creature's snapped space lies inside an end's squares on its floor, whatever its height. */
export function spaceOn(state: Pick<RoomState, "scenes">, token: Token, link: Pick<LinkEnd, "sceneId" | "rect">): boolean {
  const scene = ownEntry(state.scenes, link.sceneId);
  return scene !== undefined && token.sceneId === link.sceneId && placeOn(sceneGrid(scene), token, link.rect).inside;
}

/**
 * Whether a creature stands on an end (6.1), on its snapped footprint
 * (footprint.ts footprintRect), as the copy it is asked on reads it. "on"
 * where its space lies inside the squares, on the ground. "squeeze" where
 * its space overlaps them, is too big for them, and squeezed would fit
 * and be allowed where it stands (D-261109-104). "tooBig" where it is too
 * big otherwise. Null where it is on another floor, in the air, or only
 * partly on squares it would fit, so the bar shows nothing. The ground is
 * the ground under its own space, which on the squares is theirs, so a
 * player's copy reads it from cells it holds. Who carries it is the
 * caller's: a holder the viewer receives takes the stairs instead.
 */
export function standsOn(view: RoomState, _viewer: Viewer, token: Token, link: LinkEnd): Stand | null {
  if (token.sceneId !== link.sceneId) return null;
  if (token.elevation !== footprintGround(view.buildChunks, token)) return null;
  return standing(view, token, link);
}

/** standsOn's test of the creature's space against the squares, whatever its height: throughOpening asks it of a flier. */
function standing(view: RoomState, token: Token, link: LinkEnd): Stand | null {
  const scene = ownEntry(view.scenes, token.sceneId);
  if (scene === undefined) return null;
  const g = sceneGrid(scene);
  const place = placeOn(g, token, link.rect);
  if (!place.touches) return null;
  if (place.inside) return "on";
  const now = footprintRect(g, token);
  const E = 1e-9;
  if (now.w <= link.rect.w + E && now.h <= link.rect.h + E) return null;
  if (!isSqueezed(token) && canSqueeze(token)) {
    // The plain state's squeeze test, the scene's edge on squares included, at every op version: the reducer refuses a climb on
    // "squeeze" and "tooBig" alike (reducer/floorLinks.ts tokenClimb), so which one this is changes only the words, never a state.
    const squeezed = { ...token, squeeze: true as const };
    const small = isHex(g) ? footprintRect(g, squeezed) : squeezedSize(token);
    if (small.w <= link.rect.w + E && small.h <= link.rect.h + E && placeOn(g, squeezed, link.rect).inside && squeezeFits(view, walkEnd(view, ownWalk(token), { x: token.x, y: token.y }))) return "squeeze";
  }
  return "tooBig";
}

/**
 * Whether a squeezed climber lands squeezed (3, D-261108-094): where its
 * full space would leave the squares it keeps its squeeze, else it stands
 * full size on the far floor's same squares. The end's squares are judged
 * by the snapped full space, which rounds a squeeze along the map's edge
 * back inside it, so from op version 67 (migrate.ts fallsOnce) it also
 * keeps its squeeze where its full space, unsnapped where it lands (`at`),
 * would leave the far floor (`fullLeavesFloor`, LP53-FALL-1). Ops stored
 * before landed it full size, half off the floor, and replay so.
 */
export function climbKeepsSqueeze(state: Pick<RoomState, "scenes">, token: Token, link: Pick<FloorLink, "sceneId" | "rect" | "to">, at: { x: number; y: number }, opVersion: number | undefined): boolean {
  if (!isSqueezed(token)) return false;
  const scene = ownEntry(state.scenes, link.sceneId);
  if (scene === undefined) return true;
  const { squeeze: _squeeze, ...full } = token;
  if (!placeOn(sceneGrid(scene), full, link.rect).inside) return true;
  const far = ownEntry(state.scenes, link.to);
  return fallsOnce(opVersion) && far !== undefined && fullLeavesFloor(far, { ...full, ...at });
}

/**
 * Whether a creature's full space at its stored place, never snapped, would
 * leave a floor: its box past a side of the squares, as the map draws it and
 * as Move to floor judges a landing (client moveToFloor.ts fitsOn). A stand
 * on hexes never lies off its scene, so on hexes it never does.
 */
export function fullLeavesFloor(scene: Pick<Scene, "bounds" | "gridShape">, token: PlacedToken): boolean {
  if (isHex(sceneGrid(scene))) return false;
  const { w, h } = footprintSize(token);
  const E = 1e-9;
  return token.x < -E || token.y < -E || token.x + w > scene.bounds.w + E || token.y + h > scene.bounds.h + E;
}

/** The token's actor: its own, or its character's. */
function actorOf(state: Pick<RoomState, "characters">, token: Token) {
  return "inline" in token.actor ? token.actor.inline : ownEntry(state.characters, token.actor.ref)?.actor;
}

/**
 * Whether players see the condition on the creature: one the DM hid adds
 * nothing to a climb (walkWorld.ts publicKeys reads conditions so for a
 * walk's cost). Restated here, since the reducer reads this file and walkWorld.ts
 * reads live projections the reducer must not (project.clip.test.ts).
 */
function shownCondition(state: Pick<RoomState, "characters">, token: Token, key: string): boolean {
  return (actorOf(state, token)?.effects ?? []).some((e) => e.key === key && e.hiddenFromPlayers !== true);
}

/**
 * A climb's leg (5.1): stairs move and cost the height between the two
 * floors, a ladder twice that without a Climb Speed, and Prone, as players
 * see it (shownCondition), crawling's foot more per foot. No
 * terrain, area or diagonal counts, and down costs as up.
 */
export function climbCost(state: RoomState, token: Token, link: Pick<FloorLink, "sceneId" | "to" | "kind">): { moved: number; cost: number } {
  const height = linkHeight(state, link);
  // A flight through an opening costs the height alone: no ladder's doubling, and a flier is not crawling (phase 4, 5).
  if (link.kind === "opening") return { moved: height, cost: height };
  const climbs = link.kind === "ladder" && !((actorOf(state, token)?.speeds.climb ?? 0) > 0) ? 1 : 0;
  const crawls = shownCondition(state, token, "prone") ? 1 : 0;
  return { moved: height, cost: height * (1 + climbs + crawls) };
}

// ---------------------------------------------------------------------------
// The put rules and the floor check

/** A floor's own name, for the words. */
function floorName(state: Pick<RoomState, "scenes">, sceneId: SceneId): string {
  return ownEntry(state.scenes, sceneId)?.floor?.name ?? "that floor";
}

/** The pairs of stairs and ladders on a scene's floors. */
function pairsOn(state: Pick<RoomState, "scenes" | "floorLinks">, sceneId: SceneId): number {
  const floors = new Set(floorsOf(state, sceneId).map((s) => s.id));
  return Object.values(state.floorLinks ?? {}).filter((l) => floors.has(l.sceneId)).length / 2;
}

/**
 * The first rule of section 3 a draft breaks, in the builder's words
 * (7.3), or null: the floor just above or below, squares on both floors,
 * no end on either overlapping them, fewer than LIMITS.floorLinksPerScene
 * pairs, and on each floor no wall, one height and no pit. On the server's
 * state and on a DM's copy of the scene, which holds all of it.
 */
export function linkProblem(state: RoomState, draft: LinkDraft): string | null {
  const here = ownEntry(state.scenes, draft.sceneId);
  const there = ownEntry(state.scenes, draft.to);
  if (here?.floor === undefined || there?.floor === undefined || here.id === there.id || !sameScene(state, here.id, there.id) || Math.abs(here.floor.level - there.floor.level) !== 1) {
    return draft.kind === "opening" ? LINK_WORDS.notNextFor("opening") : LINK_WORDS.notNext;
  }
  // Each floor judges its own end's squares (phase 4, 8.2): the same squares unless stairs or a ladder lie on other squares there.
  const floors: [Scene, CellRect][] = [
    [here, draft.rect],
    [there, draft.pairRect ?? draft.rect],
  ];
  const side = linkSideOf(draft.kind);
  if (floors.some(([, rect]) => rect.w > side || rect.h > side)) return draft.kind === "opening" ? LINK_WORDS.openingSide : LINK_WORDS.stairsSide;
  for (const [floor, rect] of floors) if (!rectInScene(floor, rect)) return LINK_WORDS.pastEdge(floorName(state, floor.id));
  for (const [floor, rect] of floors) {
    const over = linksOn(state, floor.id).find((l) => l.id !== draft.id && l.id !== draft.pairId && rectsOverlap(l.rect, rect));
    if (over) return LINK_WORDS.overEnd(over.kind, floorName(state, over.to), floorName(state, floor.id));
  }
  if (pairsOn(state, here.id) >= LIMITS.floorLinksPerScene) return LINK_WORDS.tooMany(here.name);
  for (const [floor, rect] of floors) {
    const name = floorName(state, floor.id);
    if (wallInside(state, floor.id, rect)) return LINK_WORDS.wall(name);
    if (rectGround(state.buildChunks, floor.id, rect) === null) return LINK_WORDS.twoHeights(name);
    if (pitUnder(state, floor.id, rect) !== null) return LINK_WORDS.pit(name);
  }
  return null;
}

/**
 * The words of a restore that stairs rules refuse where it would put back
 * stairs that are not there now (8, FL2-OPUS-2), or null where it puts
 * none back or nothing is in their way: no stairs stand to remove, so it
 * names what blocks them, in the builder's words for the first rule those
 * stairs would break as a new draft (`linkProblem`), on that end's own
 * floor. Ground of one height that is no longer the height they stood on
 * reads changeGround's first sentence.
 *
 * They are judged on the room as the restore would leave it, every entry
 * written, without the pair being asked about (FL2-OPUS-10): an undo of
 * Remove floor puts back the floor, its ground and its stairs together,
 * and on the room before it those stairs would join a floor that is not
 * there. Where nothing is in their own way the refusal is about other
 * stairs, and the caller keeps the placer's words.
 */
export function restoredLinkWords(state: RoomState, entries: readonly { key: string; value?: unknown }[]): string | null {
  const ends = entries
    .filter((entry) => parseKey(entry.key)?.kind === "floorLink")
    .map((entry) => entry.value)
    .filter((value): value is FloorLink => value !== null && typeof value === "object" && typeof (value as FloorLink).id === "string" && ownEntry(state.floorLinks, (value as FloorLink).id) === undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ends.length === 0) return null;
  let restored = state;
  for (const entry of entries) if (parseKey(entry.key) !== null) restored = writeEntity(restored, entry.key as EntityKey, entry.value ?? null);
  /** The restored room without this pair, so the pair meets neither itself nor its own count. */
  const without = (end: FloorLink): RoomState => {
    const { [end.id]: _end, [end.pair]: _pair, ...others } = restored.floorLinks ?? {};
    return { ...restored, floorLinks: others };
  };
  for (const end of ends) {
    const pair = restored.floorLinks?.[end.pair];
    const problem = linkProblem(without(end), { id: end.id, pairId: end.pair, sceneId: end.sceneId, to: end.to, rect: end.rect, kind: end.kind, ...(pair && !sameRect(pair.rect, end.rect) ? { pairRect: pair.rect } : {}) });
    if (problem !== null) return problem;
  }
  for (const end of ends) {
    if (rectGround(restored.buildChunks, end.sceneId, end.rect) !== end.ground) return withoutEnding(LINK_WORDS.changeGround(end.kind, floorName(restored, end.to)));
  }
  return null;
}

/** A stairs refusal without the sentence that says to remove them. */
function withoutEnding(message: string): string {
  for (const ending of STAIRS_ENDINGS) if (ending.test(message)) return message.replace(ending, "");
  return message;
}

/** The DM's words for stairs that no longer fit their floors in a way no later edit of one floor explains, as a broken import. */
export function brokenLinks(scene: string): string {
  return `${scene}'s stairs and ladders don't fit its floors any more.`;
}

/**
 * The stairs' half of floorProblem (rules/floors.ts, 3): the first rule an
 * end on the floor's scene, or one naming the floor, breaks, in the DM's
 * words, or null. Its pair exists and crosses back, both share their
 * squares, kind, lock, rev and `made`, the two floors are of one scene and
 * next to each other, `grid` is both floors' shape, the squares lie inside
 * both floors, no two ends on a floor overlap, at most
 * LIMITS.floorLinksPerScene pairs, and on its floor no wall, no pit and
 * the ground it stores. A one-state check, so it holds after every op,
 * undo, redo, restore and import. The edits a DM makes after placing
 * stairs read 7.3's words, ending in "Remove them first." or "Remove them
 * before putting a floor between." (isStairsRefusal), and the rest the
 * words of stairs that no longer fit.
 */
export function linksProblem(state: RoomState, sceneId: SceneId): string | null {
  const all = state.floorLinks;
  if (all === undefined) return null;
  const inputs = [all, state.scenes, state.buildChunks, state.traps] as const;
  if (inputs.some(isWritable)) return freshLinksProblem(state, sceneId);
  let kept = keptLinks.get(all);
  if (!kept || kept.scenes !== state.scenes || kept.buildChunks !== state.buildChunks || kept.traps !== state.traps) {
    keptLinks.set(all, (kept = { scenes: state.scenes, buildChunks: state.buildChunks, traps: state.traps, answers: new Map() }));
  }
  const known = kept.answers.get(sceneId);
  if (known !== undefined) return known;
  const answer = freshLinksProblem(state, sceneId);
  kept.answers.set(sceneId, answer);
  return answer;
}

/*
 * linksProblem's answers, kept per scene (D-261120-005). The actor asks it
 * of every floor an op wrote or moved a creature on, and it judges each end
 * square by square, though only the room's links, scenes, build and traps
 * decide it: a creature's move changes none of them. So the answers are
 * kept with those four collections and given again while all four are the
 * same objects. A finished op never writes into a collection again
 * (writable.ts), so the same objects hold the same contents, and a
 * collection a transaction may still write into is judged afresh.
 */
type KeptLinks = { scenes: RoomState["scenes"]; buildChunks: RoomState["buildChunks"]; traps: RoomState["traps"]; answers: Map<SceneId, string | null> };

const keptLinks = new WeakMap<object, KeptLinks>();

/** linksProblem judged from nothing, every end square by square. */
export function freshLinksProblem(state: RoomState, sceneId: SceneId): string | null {
  const all = state.floorLinks;
  if (all === undefined) return null;
  const group = new Set([sceneId, ...floorsOf(state, sceneId).map((s) => s.id)]);
  const ends = Object.values(all)
    .filter((l) => group.has(l.sceneId) || group.has(l.to))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ends.length === 0) return null;
  const sceneName = ownEntry(state.scenes, sceneId)?.name ?? ends.map((l) => ownEntry(state.scenes, l.sceneId)?.name).find((n) => n !== undefined) ?? "This scene";
  for (const end of ends) {
    const pair = ownEntry(all, end.pair);
    const here = ownEntry(state.scenes, end.sceneId);
    const there = ownEntry(state.scenes, end.to);
    if (pair === undefined || pair.id === end.id || pair.pair !== end.id || pair.sceneId !== end.to || pair.to !== end.sceneId) return brokenLinks(sceneName);
    if (pair.kind !== end.kind || pair.locked !== end.locked || pair.hidden !== end.hidden || pair.rev !== end.rev || pair.made !== end.made) return brokenLinks(sceneName);
    // An opening is never locked or hidden, and keeps one rect on both floors, as both ends on hexes do. Stairs and ladders on
    // squares may lie on other squares of the far floor at one size (phase 4, 3, 8.1, 8.2).
    if (end.kind === "opening" && (end.locked !== undefined || end.hidden !== undefined)) return brokenLinks(sceneName);
    if (end.rect.w > linkSideOf(end.kind) || end.rect.h > linkSideOf(end.kind)) return brokenLinks(sceneName);
    if (end.kind === "opening" || end.grid !== undefined ? !sameRect(pair.rect, end.rect) : pair.rect.w !== end.rect.w || pair.rect.h !== end.rect.h) return brokenLinks(sceneName);
    if (here?.floor === undefined || there?.floor === undefined || !sameScene(state, here.id, there.id)) return brokenLinks(sceneName);
    if (end.grid !== here.gridShape || end.grid !== there.gridShape) return brokenLinks(sceneName);
    if (Math.abs(here.floor.level - there.floor.level) !== 1) {
      const [lower, upper] = here.floor.level < there.floor.level ? [here, there] : [there, here];
      return LINK_WORDS.between(end.kind, lower.floor!.name, upper.floor!.name);
    }
    const far = there.floor.name;
    if (!rectInScene(here, end.rect)) return LINK_WORDS.block(end.kind, far);
    const over = linksOn(state, here.id).find((l) => l.id !== end.id && rectsOverlap(l.rect, end.rect));
    if (over) return LINK_WORDS.block(end.kind, far);
    if (wallInside(state, here.id, end.rect) || pitUnder(state, here.id, end.rect) !== null) return LINK_WORDS.block(end.kind, far);
    if (rectGround(state.buildChunks, here.id, end.rect) !== end.ground) return LINK_WORDS.changeGround(end.kind, far);
  }
  if (pairsOn(state, [...group].find((id) => ownEntry(state.scenes, id) !== undefined) ?? sceneId) > LIMITS.floorLinksPerScene) return LINK_WORDS.tooMany(sceneName);
  return null;
}

function sameRect(a: CellRect, b: CellRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// floorProblem asks the stairs' half through this, as rules/floors.ts cannot import this file (floorLinkRules).
floorLinkRules.problem = linksProblem;
