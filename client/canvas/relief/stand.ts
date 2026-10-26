import { FOG_SUBCELLS } from "#shared/model.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
import { pillReach } from "../../features/measure/pillPlace.ts";
import { dragTagPill } from "../dragTag.ts";
import type { CellBox, FogView } from "./fogView.ts";

/**
 * The stand rule (docs/design-v1-isometric-view.md 5.2, D-261026-5), the
 * security rule of the isometric view: for a player on a scene with fog,
 * a thing that stands up stands only when every fog sub-cell under its
 * Top-down footprint is revealed to that viewer. Anything else lies flat
 * on the ground stage under the fog, as Top-down draws it, so Isometric
 * never shows a player more than Top-down does. Everything on the DM's
 * device, or on a scene without fog, stands (`FogView.all`).
 *
 * Every caller that stands something up asks here, and the board routes
 * whatever is refused to the ground stage (`splitTokens`), so no upright
 * path can skip the test.
 */

/** Whether a box in cells stands for this viewer: every sub-cell it touches is revealed. */
export function boxStands(fog: FogView, box: CellBox): boolean {
  return fog.boxClear(box);
}

type BoxToken = Pick<ViewToken, "x" | "y" | "size" | "w" | "h" | "squeeze" | "rotation" | "kind">;

/**
 * The two boxes a token covers in Top-down: the body as it is drawn,
 * turned by its rotation about its middle as TokenNode.tsx's TokenBody
 * turns the art and its clip, and the footprint the rules read (snapped,
 * and squeezed while it squeezes). Testing both fails closed whichever of
 * the two a later change draws.
 */
export function tokenBoxes(token: BoxToken, at: { x: number; y: number } = token): [CellBox, CellBox] {
  const rule = footprintRect({ ...token, x: at.x, y: at.y });
  return [turnedBody(at, footprint(token), token.rotation, token.kind === "object"), { x0: rule.x, y0: rule.y, x1: rule.x + rule.w, y1: rule.y + rule.h }];
}

/** One box around both of a token's boxes, for a flat ghost's clip and the DM's dimming. */
export function tokenBox(token: BoxToken, at: { x: number; y: number } = token): CellBox {
  const [body, rule] = tokenBoxes(token, at);
  return { x0: Math.min(body.x0, rule.x0), y0: Math.min(body.y0, rule.y0), x1: Math.max(body.x1, rule.x1), y1: Math.max(body.y1, rule.y1) };
}

/** Whether both of a token's boxes stand. */
function tokenStands(fog: FogView, token: BoxToken, at: { x: number; y: number } = token): boolean {
  const [body, rule] = tokenBoxes(token, at);
  return boxStands(fog, body) && boxStands(fog, rule);
}

/** How far from a right angle a turn may be and still be drawn as one, so a stored 90 reads as exactly 90. */
const RIGHT_ANGLE_EPS = 1e-12;

/**
 * The box of a body w by h with its corner at `at`, turned by `rotation`
 * degrees about its middle: the rectangle's corners for an object, whose
 * clip is square, and the ellipse's extent for anything else. A turn that
 * is not finite draws unturned, as Top-down draws it. A circle, and any
 * body at a right angle, gets an exact box, so a token on a sub-cell line
 * touches no sub-cell past it: rounding in the general form would push its
 * edge a hair over the line.
 */
export function turnedBody(at: { x: number; y: number }, size: { w: number; h: number }, rotation: number, square: boolean): CellBox {
  const rad = ((Number.isFinite(rotation) ? rotation : 0) * Math.PI) / 180;
  const c = snapUnit(Math.abs(Math.cos(rad)));
  const s = snapUnit(Math.abs(Math.sin(rad)));
  if (s === 0 || (!square && size.w === size.h)) return { x0: at.x, y0: at.y, x1: at.x + size.w, y1: at.y + size.h };
  const cx = at.x + size.w / 2;
  const cy = at.y + size.h / 2;
  const a = size.w / 2;
  const b = size.h / 2;
  if (c === 0) return { x0: cx - b, y0: cy - a, x1: cx + b, y1: cy + a };
  const hx = square ? a * c + b * s : Math.sqrt(a * a * c * c + b * b * s * s);
  const hy = square ? a * s + b * c : Math.sqrt(a * a * s * s + b * b * c * c);
  return { x0: cx - hx, y0: cy - hy, x1: cx + hx, y1: cy + hy };
}

function snapUnit(v: number): number {
  return v < RIGHT_ANGLE_EPS ? 0 : v > 1 - RIGHT_ANGLE_EPS ? 1 : v;
}

/**
 * Whether a creature stands up as a standee. Party members and tokens every
 * player sees (`aboveFog`, lib/scene.ts drawsAboveFog) draw above the fog
 * in Top-down, so they stand wherever they are.
 */
export function creatureStands(fog: FogView, token: ViewToken, aboveFog: boolean): boolean {
  if (fog.all || aboveFog) return true;
  return tokenStands(fog, token);
}

/**
 * Whether another member's drag ghost stands at one eased frame, judged at
 * that frame's spot, so a ghost whose path crosses fog lies flat on every
 * frame it is over fog. Its name tag is judged by its own box.
 */
export function ghostStands(fog: FogView, token: ViewToken, at: { x: number; y: number }): boolean {
  if (fog.all) return true;
  return tokenStands(fog, token, at);
}

/**
 * Whether a standing ghost's name tag stands too: by the box of the pill
 * Top-down draws for it at this zoom (dragTag.ts dragTagPill), anywhere its
 * slide along the screen's edge can put it (pillPlace.ts pillReach). At low
 * zoom that pill covers many cells, all of which must be revealed, since
 * Top-down draws it under the fog.
 */
export function ghostTagStands(fog: FogView, token: Pick<ViewToken, "size" | "w" | "h">, at: { x: number; y: number }, name: string, scale: number): boolean {
  if (fog.all) return true;
  // Its outline, 1.5 px wide, is centered on the pill's edge, so half of it lies outside the box.
  const edge = 1 / scale;
  const r = pillReach(dragTagPill(token, at, name, scale));
  return boxStands(fog, { x0: r.x0 - edge, y0: r.y0 - edge, x1: r.x1 + edge, y1: r.y1 + edge });
}

/** Which tokens stand as standees and which lie flat under the fog, for the board's two stages. */
export function splitTokens<T extends ViewToken>(fog: FogView, tokens: readonly T[], aboveFog: (t: T) => boolean): { standing: T[]; flat: T[] } {
  const standing: T[] = [];
  const flat: T[] = [];
  for (const t of tokens) (creatureStands(fog, t, aboveFog(t)) ? standing : flat).push(t);
  return { standing, flat };
}

/**
 * Whether a line in cells stands, a tether's: every sub-cell it can paint
 * is revealed, by its stroke's half width `r` in cells with round caps
 * (strokeSubcells). With no width, every sub-cell the segment passes
 * through, corners included, so a line that grazes a fogged corner stays
 * flat.
 */
export function lineStands(fog: FogView, a: { x: number; y: number }, b: { x: number; y: number }, r = 0): boolean {
  if (fog.all) return true;
  let ok = true;
  strokeSubcells(a, b, r, (sx, sy) => {
    if (!fog.revealed(sx, sy)) ok = false;
    return ok;
  });
  return ok;
}

type P = { x: number; y: number };

/**
 * Every sub-cell whose closed square lies within `r` cells of the segment,
 * row by row, until `visit` says stop: what a stroke of half width r with
 * round caps can paint. Closed squares fail closed: a line along a
 * sub-cell line, or through a corner, counts the sub-cells on both sides
 * of it, and a stroke whose edge only touches a square counts it.
 */
export function strokeSubcells(a: P, b: P, r: number, visit: (sx: number, sy: number) => boolean): void {
  const k = FOG_SUBCELLS;
  const s = 1 / k;
  // Float slack, so a square the stroke's edge touches is never missed.
  const near = Math.max(0, r) + 1e-9;
  const x0 = Math.floor((Math.min(a.x, b.x) - near) * k) - 1;
  const x1 = Math.floor((Math.max(a.x, b.x) + near) * k);
  const y0 = Math.floor((Math.min(a.y, b.y) - near) * k) - 1;
  const y1 = Math.floor((Math.max(a.y, b.y) + near) * k);
  for (let sy = y0; sy <= y1; sy++) {
    for (let sx = x0; sx <= x1; sx++) if (squareGap(a, b, sx * s, sy * s, s) <= near && !visit(sx, sy)) return;
  }
}

/** The distance from the segment a to b to the closed square at x, y of side s: 0 where they meet. */
function squareGap(a: P, b: P, x: number, y: number, s: number): number {
  if (segmentMeetsBox(a, b, x, y, x + s, y + s)) return 0;
  let d = Math.min(boxGap(a, x, y, s), boxGap(b, x, y, s));
  for (const c of [{ x, y }, { x: x + s, y }, { x, y: y + s }, { x: x + s, y: y + s }]) d = Math.min(d, segmentGap(c, a, b));
  return d;
}

/** Whether the segment meets the closed box: Liang and Barsky's clip, which keeps a part of it. */
function segmentMeetsBox(a: P, b: P, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let lo = 0;
  let hi = 1;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

function boxGap(p: P, x: number, y: number, s: number): number {
  return Math.hypot(Math.max(x - p.x, 0, p.x - x - s), Math.max(y - p.y, 0, p.y - y - s));
}

function segmentGap(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
