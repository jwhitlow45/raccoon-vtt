import type { CreatureSize, Scene } from "../model.ts";
import type { BuildState } from "../ruleHooks.ts";
import { anchorOfHex, footprintSize, hexAnchor, occupiedHexes, placedOnHex, sizeCategory, storedCenter, tokenRefHex, type PlacedToken } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { sceneGrid } from "./grid.ts";
import { footprintHexes, hexDistance, hexInScene, hexKey, sameHex, type Hex, type HexGrid } from "./hex.ts";
import { LEDGE_IN_THE_WAY, resizeLegStop, resizeStands, WALL_IN_THE_WAY, type MovingToken } from "./movement.ts";

/**
 * Where a resized creature stands (docs/design-v1-token-window.md 8.2 to
 * 8.6). One rule for every place that changes a size: the device finds the
 * spot with `resizeSpot` before it sends the patch, and the permission
 * judges the spot it is sent with `resizeRefusal`. Both read the same
 * candidates and the same two tests, so a device with the server's view
 * always sends a spot the server takes.
 *
 * The footprint keeps its middle: the base spot is the new size's footprint
 * whose middle is nearest the old one. An owner's resize on a scene that
 * blocks moves is judged like a move by the move rules' own tests
 * (movement.ts): a growth must stand where a move could end, and no resize
 * may carry the middle across a wall. A growth also covers every square the
 * creature filled, so its undo and the device's remembered return always
 * land inside the grown footprint. The DM's resizes are never checked.
 *
 * It reads the move rules directly, not through shared/ruleHooks.ts, whose
 * indirection serves the core built before those rules existed: the resize
 * came after them, and nothing swaps them out for it.
 *
 * On a hex scene (docs/design-v1-hex-grids.md 4.2) a resize keeps the
 * reference hex where it was: a Medium growing Large keeps its hex as the
 * top one, and a Large shrinking Medium keeps its top hex. That spot is the
 * base, and an owner's growth that would leave the scene tries the other
 * footprints covering the old one (`hexCandidates`). A hex scene has no
 * walls until phase H2, so rule 5 reads nothing there.
 */

export { LEDGE_IN_THE_WAY, WALL_IN_THE_WAY };

/** What an owner hears when no spot around the creature has room for its new size. */
export const NO_ROOM_TO_GROW = "No room to grow here.";
/** The refusal of a resize patch whose spot is not one a resize may take (8.6, rule 4). */
export const RESIZE_KEEPS_PLACE = "a resize keeps the creature where it stands";
/** The refusal of an owner's Custom size, or a patch with more than the size and place (8.6, rule 3). */
export const OWNER_SIZES = "owners pick one of the six sizes";

/** The sizes an owner picks from, smallest first. Custom is the DM's. */
export const SIX_SIZES: readonly Exclude<CreatureSize, "custom">[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];

/** A size to resize to: Custom's `w` and `h` are in cells, as on a token. */
export type NextSize = { size: CreatureSize; w?: number; h?: number };

/** Where a resize puts the creature, and whether it moved off the base spot or the remembered square to clear a wall, or why it cannot. */
export type ResizeSpot = { x: number; y: number; shifted: boolean } | { refused: string };

export type SizeChange = "same" | "grow" | "shrink";

/** How a resize changes the footprint. Small and Medium are one footprint, so between them the size is kept. */
export function sizeChange(token: PlacedToken, next: NextSize): SizeChange {
  const from = footprintSize(token);
  const to = footprintSize(sized(next, 0, 0));
  if (to.w === from.w && to.h === from.h) return "same";
  // A Custom size wider but shorter (the DM's alone) counts as a growth, which no footprint can be: it covers no old one.
  return to.w <= from.w && to.h <= from.h ? "shrink" : "grow";
}

/**
 * The base spot (8.2): of the new size's footprints on its snap grid, the
 * one whose middle is nearest the old footprint's stored middle, ties to
 * the one whose top-left corner is nearest the old one, then moved the
 * least to lie inside the scene on each axis the scene is big enough for.
 * Each axis is decided on its own, which is the same as the nearest middle
 * by straight line.
 */
export function resizeBase(token: PlacedToken, next: NextSize, scene: Pick<Scene, "bounds" | "gridShape">): Point {
  const g = sceneGrid(scene);
  if (g.shape === "hex") return placedOnHex(g, sized(next, 0, 0), tokenRefHex(g, token));
  const c = storedCenter(token);
  const { w, h } = footprintSize(sized(next, 0, 0));
  const step = stepFor(w, h);
  return {
    x: inside(nearest(c.x - w / 2, step, token.x), w, scene.bounds.w, step),
    y: inside(nearest(c.y - h / 2, step, token.y), h, scene.bounds.h, step),
  };
}

/**
 * Where the resized creature stands (8.2 to 8.4). `checked` is true for
 * anyone but the DM: on a scene that blocks moves the spot is searched by
 * 8.3, and anywhere the spot is one the permission's rule 4 allows. The DM
 * takes the base spot, unchecked. `remembered` is the device's remembered
 * square for a shrink (8.2), taken where it is a spot the shrink may take.
 *
 * A growth tries every footprint that covers the old one and lies inside
 * the scene, a shrink every one inside the old footprint: the remembered
 * square or the base spot first, then by distance from the creature's
 * middle now, with 8.3's ties.
 */
export function resizeSpot(state: BuildState, token: MovingToken, next: NextSize, opts: { checked: boolean; remembered?: Point }): ResizeSpot {
  const scene = state.scenes[token.sceneId];
  const change = sizeChange(token, next);
  if (change === "same" || !scene) return { x: token.x, y: token.y, shifted: false };
  const candidates = resizeCandidates(token, next, scene);
  const grid = sceneGrid(scene);
  // On hexes a spot is a candidate by the hexes it stands on, wherever in its anchor's reach it was stored (4.2).
  const isCandidate = (p: Point) => (grid.shape === "hex" ? hexSpotAllowed(grid, next, p, candidates) : candidates.some((q) => q.x === p.x && q.y === p.y));
  const remembered = change === "shrink" && opts.remembered && isCandidate(opts.remembered) ? { x: opts.remembered.x, y: opts.remembered.y } : undefined;
  const first = remembered ?? resizeBase(token, next, scene);
  if (!opts.checked) return { ...first, shifted: false };
  // A hex scene has no walls until phase H2.
  const passes = (p: Point) => scene.blockMovement !== true || grid.shape === "hex" || wallRefusal(state, token, sized(next, p.x, p.y), change) === null;
  if (isCandidate(first) && passes(first)) return { ...first, shifted: false };
  for (const p of candidates) {
    if ((p.x !== first.x || p.y !== first.y) && passes(p)) return { x: p.x, y: p.y, shifted: true };
  }
  if (change === "grow") return { refused: NO_ROOM_TO_GROW };
  return { refused: legWords(resizeLegStop(state, token, sized(next, first.x, first.y))) };
}

/**
 * The spots an owner's resize may take by rule 4, in 8.3's order: a
 * growth's footprints that cover the old one and lie inside the scene, or
 * a shrink's inside the old one, on the new size's snap grid. Nearest
 * middle to the creature's middle now first, in cells, straight line, then
 * the base spot, the smaller vertical shift from it, the smaller horizontal
 * shift, up before down and left before right, so no two spots tie.
 * Keeping its size, there are none: it keeps its place.
 */
export function resizeCandidates(token: PlacedToken, next: NextSize, scene: Pick<Scene, "bounds" | "gridShape">): Point[] {
  const change = sizeChange(token, next);
  if (change === "same") return [];
  const g = sceneGrid(scene);
  if (g.shape === "hex") return hexCandidates(g, token, next, scene, change);
  const from = footprintSize(token);
  const { w, h } = footprintSize(sized(next, 0, 0));
  const step = stepFor(w, h);
  // Every grid spot within a new footprint's reach of the old one, kept where rule 4 allows it.
  const axis = (start: number, side: number, newSide: number) => {
    const out: number[] = [];
    for (let v = Math.floor((start - newSide) / step) * step; v <= start + side; v += step) out.push(v + 0);
    return out;
  };
  const spots: Point[] = [];
  for (const y of axis(token.y, from.h, h)) {
    for (const x of axis(token.x, from.w, w)) if (allowedSpot(token, sized(next, x, y), scene, change)) spots.push({ x, y });
  }
  // Middles and shifts are multiples of a quarter cell for the six sizes, so the squared distances compare exactly.
  const c = storedCenter(token);
  const base = resizeBase(token, next, scene);
  const key = (p: Point) => {
    const dx = p.x + w / 2 - c.x;
    const dy = p.y + h / 2 - c.y;
    return [dx * dx + dy * dy, p.x === base.x && p.y === base.y ? 0 : 1, Math.abs(p.y - base.y), Math.abs(p.x - base.x), p.y < base.y ? 0 : 1, p.x < base.x ? 0 : 1];
  };
  const keyed = spots.map((p) => ({ p, k: key(p) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i]! - b.k[i]!;
    return 0;
  });
  return keyed.map((e) => e.p);
}

/**
 * Rules 4 and 5 of 8.6 for a spot sent with a new size, as the permission
 * judges a player's resize patch and a player's undo or redo of one: the
 * refusal's words, or null when the spot may be taken. The place is on the
 * new size's snap grid. Keeping its size, it is the current place. Growing,
 * the new footprint lies inside the scene and covers the current one.
 * Shrinking, it lies inside the current one. Then, on a scene that blocks
 * moves, a growth stands clear and its middle crosses nothing, and a shrink's
 * middle crosses nothing.
 */
export function resizeRefusal(state: BuildState, token: MovingToken, next: NextSize & Point): string | null {
  const change = sizeChange(token, next);
  if (change === "same") return next.x === token.x && next.y === token.y ? null : RESIZE_KEEPS_PLACE;
  const scene = state.scenes[token.sceneId];
  const to = sized(next, next.x, next.y);
  if (!scene) return RESIZE_KEEPS_PLACE;
  const g = sceneGrid(scene);
  if (g.shape === "hex") return hexSpotAllowed(g, next, next, hexCandidates(g, token, next, scene, change)) ? null : RESIZE_KEEPS_PLACE;
  if (!allowedSpot(token, to, scene, change)) return RESIZE_KEEPS_PLACE;
  return scene.blockMovement === true ? wallRefusal(state, token, to, change) : null;
}

/*
 * A hex resize's spots by rule 4 (4.2): a growth's footprints that cover
 * every hex the creature stood on and lie inside the scene, a shrink's
 * inside them, the one keeping the reference hex first, then by how far
 * the new anchor is from the old one, ties to the smaller row, then the
 * smaller column. Every footprint holds its reference hex and lies within
 * 2 steps of it, so the references within 2 steps of the old one hold all
 * the footprints that can cover it or lie inside it.
 */
function hexCandidates(g: HexGrid, token: PlacedToken, next: NextSize, scene: Pick<Scene, "bounds">, change: "grow" | "shrink"): Point[] {
  const size = sizeCategory(sized(next, 0, 0));
  const old = occupiedHexes(g, token);
  const ref = tokenRefHex(g, token);
  const from = hexAnchor(g, token);
  const held = new Set(old.map(hexKey));
  const fits = (r: Hex) => {
    const hexes = footprintHexes(g, size, anchorOfHex(g, size, r));
    if (change === "shrink") return hexes.every((h) => held.has(hexKey(h)));
    const keys = new Set(hexes.map(hexKey));
    return old.every((h) => keys.has(hexKey(h))) && hexes.every((h) => hexInScene(g, scene.bounds, h));
  };
  const refs: Hex[] = [];
  for (let row = ref.row - 2; row <= ref.row + 2; row++) {
    for (let col = ref.col - 2; col <= ref.col + 2; col++) {
      const r = { col, row };
      if (hexDistance(g, r, ref) <= 2 && fits(r)) refs.push(r);
    }
  }
  const away = (r: Hex) => {
    const a = anchorOfHex(g, size, r);
    const dx = a.x - from.x;
    const dy = a.y - from.y;
    return dx * dx + dy * dy;
  };
  refs.sort((a, b) => (sameHex(a, ref) ? -1 : sameHex(b, ref) ? 1 : away(a) - away(b) || a.row - b.row || a.col - b.col));
  return refs.map((r) => placedOnHex(g, sized(next, 0, 0), r));
}

/* Whether a spot sent with a new size stands on one of the candidates' footprints: its reference hex is theirs. */
function hexSpotAllowed(g: HexGrid, next: NextSize, spot: Point, candidates: readonly Point[]): boolean {
  const at = tokenRefHex(g, sized(next, spot.x, spot.y));
  return candidates.some((p) => sameHex(tokenRefHex(g, sized(next, p.x, p.y)), at));
}

/* The new size's footprint at a spot, as the footprint rules read a token. */
function sized(next: NextSize, x: number, y: number): PlacedToken {
  return next.size === "custom" ? { size: "custom", w: next.w, h: next.h, x, y } : { size: next.size, x, y };
}

/* The snap grid's step for a footprint (footprint.ts snapStep): half cells under a cell, whole cells otherwise. */
function stepFor(w: number, h: number): number {
  return Math.min(w, h) < 1 ? 0.5 : 1;
}

/* The grid value nearest `v`, ties to the one nearest `prefer`, then the lower. Adding 0 turns a -0 into 0. */
function nearest(v: number, step: number, prefer: number): number {
  const lo = Math.floor(v / step) * step;
  const hi = lo + step;
  const below = v - lo;
  const above = hi - v;
  if (below !== above) return (below < above ? lo : hi) + 0;
  return (Math.abs(hi - prefer) < Math.abs(lo - prefer) ? hi : lo) + 0;
}

/* `v` moved the least to put a side of `side` inside `bound` on the grid, or left alone where the bound is smaller than the side. */
function inside(v: number, side: number, bound: number, step: number): number {
  if (side > bound) return v;
  return Math.min(Math.max(v, 0), Math.floor((bound - side) / step) * step) + 0;
}

/*
 * Rule 4's spots: on the new size's snap grid, and for a growth inside the
 * scene and covering the old footprint, for a shrink inside the old
 * footprint. The old footprint is the full one at the stored position,
 * whose middle a resize keeps, even while squeezed.
 */
function allowedSpot(token: PlacedToken, to: PlacedToken, scene: Pick<Scene, "bounds">, change: "grow" | "shrink"): boolean {
  const from = footprintSize(token);
  const { w, h } = footprintSize(to);
  const step = stepFor(w, h);
  if (!Number.isInteger(to.x / step) || !Number.isInteger(to.y / step)) return false;
  if (change === "shrink") return to.x >= token.x && to.y >= token.y && to.x + w <= token.x + from.w && to.y + h <= token.y + from.h;
  const covers = to.x <= token.x && to.y <= token.y && to.x + w >= token.x + from.w && to.y + h >= token.y + from.h;
  return covers && to.x >= 0 && to.y >= 0 && to.x + w <= scene.bounds.w && to.y + h <= scene.bounds.h;
}

/* Rule 5 at a spot rule 4 allows: a growth stands clear and crosses nothing, a shrink crosses nothing. */
function wallRefusal(state: BuildState, token: MovingToken, to: PlacedToken, change: "grow" | "shrink"): string | null {
  if (change === "grow") return resizeStands(state, token, to) && resizeLegStop(state, token, to) === null ? null : NO_ROOM_TO_GROW;
  const stop = resizeLegStop(state, token, to);
  return stop === null ? null : legWords(stop);
}

/* A shrink stopped answers in a move's words, by what the straight leg meets first. */
function legWords(stop: "wall" | "ledge" | null): string {
  return stop === "ledge" ? LEDGE_IN_THE_WAY : WALL_IN_THE_WAY;
}
