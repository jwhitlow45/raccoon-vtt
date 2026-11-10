import { LIMITS } from "../limits.ts";
import type { CellRect, FloorLink, FloorLinkId, RoomState, Scene, SceneId, Token, Viewer } from "../model.ts";
import { FLOOR_HEIGHT } from "../protocol.ts";
import { ownEntry } from "../records.ts";
import { floorLinkRules, floorsOf, sameScene } from "./floors.ts";
import { canSqueeze, footprintRect, isSqueezed, occupiedHexes, squeezedSize, type PlacedToken } from "./footprint.ts";
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
export type LinkDraft = { id: FloorLinkId; pairId: FloorLinkId; sceneId: SceneId; to: SceneId; rect: CellRect; kind: FloorLink["kind"] };

/** Whether a creature on an end may take it (6.1): it fits, it fits only squeezed, or it is too big. */
export type Stand = "on" | "squeeze" | "tooBig";

/** "stairs" or "ladder", as the words name it. */
type Kind = FloorLink["kind"];

const them = (kind: Kind) => (kind === "stairs" ? "them" : "it");

/** The words of every refusal of stairs and ladders (docs/design/design-v1-floors.md 6.3, 7.3, 8). */
export const LINK_WORDS = {
  /** An end gone, fogged, on a floor not held or not under the creature: one code, one text (4). */
  noStairs: "There are no stairs here.",
  carried: (name: string, kind: Kind) => `${name} is carried. Its holder takes the ${kind === "stairs" ? "stairs" : "ladder"}.`,
  locked: "It's locked.",
  tooBigSqueeze: (kind: Kind) => `Too big for ${kind === "stairs" ? "these stairs" : "this ladder"}. Squeeze to fit.`,
  tooBig: (kind: Kind) => `Too big for ${kind === "stairs" ? "these stairs" : "this ladder"}.`,
  /** The reason a climb's undo or redo is refused, after the label the actor puts before it. */
  changed: (kind: Kind) => (kind === "stairs" ? "the stairs changed" : "the ladder changed"),
  // The builder's refusals of a draft (7.3).
  wall: (floor: string) => `A wall crosses those squares on ${floor}.`,
  twoHeights: (floor: string) => `Those squares aren't one height on ${floor}.`,
  pit: (floor: string) => `A pit trap lies under those squares on ${floor}.`,
  pastEdge: (floor: string) => `${floor} ends before those squares.`,
  overEnd: (kind: Kind, floor: string) => `Those squares already have ${kind === "stairs" ? "stairs" : "a ladder"} to ${floor}.`,
  tooMany: (scene: string) => `${scene} has ${LIMITS.floorLinksPerScene} stairs and ladders, the most a scene can hold.`,
  notNext: "Stairs join a floor and the floor just above or below it.",
  // A later edit floorProblem refuses (3), each ending in one of STAIRS_ENDINGS, which isStairsRefusal reads.
  changeGround: (kind: Kind, floor: string) => `That would change the ground under the ${kind === "stairs" ? "stairs" : "ladder"} to ${floor}. ${removeFirst(kind)}`,
  block: (kind: Kind, floor: string) => `That would block the ${kind === "stairs" ? "stairs" : "ladder"} to ${floor}. ${removeFirst(kind)}`,
  between: (kind: Kind, lower: string, upper: string) =>
    `${kind === "stairs" ? "Stairs join" : "A ladder joins"} ${lower} and ${upper}. ${kind === "stairs" ? "Remove them" : "Remove it"} before putting a floor between.`,
  /** A pit trap's create or update over an end, in the trap pane's words (3). */
  pitUnder: (kind: Kind) => `A pit can't open under ${kind === "stairs" ? "stairs" : "a ladder"}. ${removeFirst(kind)}`,
} as const;

function removeFirst(kind: Kind): string {
  return `Remove ${them(kind)} first.`;
}

/** The sentence a restore's stairs refusal reads in place of "Remove them first." (8): true whoever placed them. */
function placerCan(kind: Kind): string {
  return kind === "stairs" ? "The DM who placed them can remove them." : "The DM who placed it can remove it.";
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
    const kind: Kind = /Remove them/.test(message) ? "stairs" : "ladder";
    return `${message.replace(ending, "")} ${placerCan(kind)}`;
  }
  return message;
}

/**
 * The label of a climb's undo step (6.3), without "Undo": "moving Thorn up
 * the stairs". The undo labels read it for the step and its refusals.
 */
export function climbLabel(name: string, dir: "up" | "down", kind: Kind): string {
  return `moving ${name} ${dir} the ${kind === "stairs" ? "stairs" : "ladder"}`;
}

/** The labels of the builder's undo steps (7.2), without "Undo": "placing stairs to Upper floor". */
export const LINK_LABELS = {
  placed: (kind: Kind, floor: string) => `placing ${kind === "stairs" ? "stairs" : "a ladder"} to ${floor}`,
  removed: (kind: Kind, floor: string) => `removing ${kind === "stairs" ? "stairs" : "a ladder"} to ${floor}`,
  lock: (kind: Kind, locked: boolean) => `${locked ? "locking" : "unlocking"} the ${kind === "stairs" ? "stairs" : "ladder"}`,
  kind: (from: Kind) => (from === "stairs" ? "changing stairs to a ladder" : "changing a ladder to stairs"),
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
 * page reads it. Only the server's state and a DM's copy hold heights.
 */
export function linkHeight(state: Pick<RoomState, "scenes">, link: Pick<FloorLink, "sceneId" | "to">): number {
  const here = ownEntry(state.scenes, link.sceneId)?.floor;
  const there = ownEntry(state.scenes, link.to)?.floor;
  const upper = (there?.level ?? 0) > (here?.level ?? 0) ? there : here;
  return upper?.height ?? FLOOR_HEIGHT.initial;
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
 * A trap whose rig opens a pit and whose squares share a cell with these on
 * the floor (3), the first by id, or null: a pit would drop the ground an
 * end stands on.
 */
export function pitUnder(state: Pick<RoomState, "traps">, sceneId: SceneId, rect: CellRect): string | null {
  const ids = Object.keys(state.traps).sort();
  for (const id of ids) {
    const trap = state.traps[id]!;
    if (trap.sceneId !== sceneId || trap.rig?.pit === undefined || !("cells" in trap.zone)) continue;
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
  const scene = ownEntry(view.scenes, token.sceneId);
  if (scene === undefined) return null;
  const g = sceneGrid(scene);
  const place = placeOn(g, token, link.rect);
  if (!place.touches) return null;
  if (token.elevation !== footprintGround(view.buildChunks, token)) return null;
  if (place.inside) return "on";
  const now = footprintRect(g, token);
  const E = 1e-9;
  if (now.w <= link.rect.w + E && now.h <= link.rect.h + E) return null;
  if (!isSqueezed(token) && canSqueeze(token)) {
    const squeezed = { ...token, squeeze: true as const };
    const small = isHex(g) ? footprintRect(g, squeezed) : squeezedSize(token);
    if (small.w <= link.rect.w + E && small.h <= link.rect.h + E && placeOn(g, squeezed, link.rect).inside && squeezeFits(view, walkEnd(view, ownWalk(token), { x: token.x, y: token.y }))) return "squeeze";
  }
  return "tooBig";
}

/**
 * Whether a squeezed climber lands squeezed (3, D-261108-094): where its
 * full space would leave the squares it keeps its squeeze, else it stands
 * full size on the far floor's same squares.
 */
export function climbKeepsSqueeze(state: Pick<RoomState, "scenes">, token: Token, link: Pick<FloorLink, "sceneId" | "rect">): boolean {
  if (!isSqueezed(token)) return false;
  const scene = ownEntry(state.scenes, link.sceneId);
  if (scene === undefined) return true;
  const { squeeze: _squeeze, ...full } = token;
  return !placeOn(sceneGrid(scene), full, link.rect).inside;
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
  if (here?.floor === undefined || there?.floor === undefined || here.id === there.id || !sameScene(state, here.id, there.id) || Math.abs(here.floor.level - there.floor.level) !== 1) return LINK_WORDS.notNext;
  const floors = [here, there];
  for (const floor of floors) if (!rectInScene(floor, draft.rect)) return LINK_WORDS.pastEdge(floorName(state, floor.id));
  for (const floor of floors) {
    const over = linksOn(state, floor.id).find((l) => l.id !== draft.id && l.id !== draft.pairId && rectsOverlap(l.rect, draft.rect));
    if (over) return LINK_WORDS.overEnd(over.kind, floorName(state, over.to));
  }
  if (pairsOn(state, here.id) >= LIMITS.floorLinksPerScene) return LINK_WORDS.tooMany(here.name);
  for (const floor of floors) {
    const name = floorName(state, floor.id);
    if (wallInside(state, floor.id, draft.rect)) return LINK_WORDS.wall(name);
    if (rectGround(state.buildChunks, floor.id, draft.rect) === null) return LINK_WORDS.twoHeights(name);
    if (pitUnder(state, floor.id, draft.rect) !== null) return LINK_WORDS.pit(name);
  }
  return null;
}

/**
 * The words of a restore that stairs rules refuse where it would put back
 * stairs that are not there now (8, FL2-OPUS-2), or null where it puts
 * none back: no stairs stand to remove, so it names what is in their way,
 * in the builder's words for the first rule those stairs would break as a
 * new draft on the room as it is (`linkProblem`), on that end's own floor.
 * Ground of one height that is no longer the height they stood on reads
 * changeGround's first sentence. `restored` holds the values the restore
 * writes under `floorLink:` keys.
 */
export function restoredLinkWords(state: RoomState, restored: readonly unknown[]): string | null {
  const ends = restored
    .filter((value): value is FloorLink => value !== null && typeof value === "object" && typeof (value as FloorLink).id === "string" && ownEntry(state.floorLinks, (value as FloorLink).id) === undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const end of ends) {
    const problem = linkProblem(state, { id: end.id, pairId: end.pair, sceneId: end.sceneId, to: end.to, rect: end.rect, kind: end.kind });
    if (problem !== null) return problem;
  }
  for (const end of ends) {
    if (rectGround(state.buildChunks, end.sceneId, end.rect) !== end.ground) return withoutEnding(LINK_WORDS.changeGround(end.kind, floorName(state, end.to)));
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
    if (!sameRect(pair.rect, end.rect) || pair.kind !== end.kind || pair.locked !== end.locked || pair.rev !== end.rev || pair.made !== end.made) return brokenLinks(sceneName);
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
