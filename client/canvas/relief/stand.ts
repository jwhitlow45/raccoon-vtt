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
  return boxStands(fog, pillReach(dragTagPill(token, at, name, scale)));
}

/** Which tokens stand as standees and which lie flat under the fog, for the board's two stages. */
export function splitTokens<T extends ViewToken>(fog: FogView, tokens: readonly T[], aboveFog: (t: T) => boolean): { standing: T[]; flat: T[] } {
  const standing: T[] = [];
  const flat: T[] = [];
  for (const t of tokens) (creatureStands(fog, t, aboveFog(t)) ? standing : flat).push(t);
  return { standing, flat };
}

/**
 * Whether a line in cells stands, a tether's: every sub-cell it crosses is
 * revealed. The walk visits each sub-cell the segment passes through,
 * corners included, so a line that grazes a fogged corner stays flat.
 */
export function lineStands(fog: FogView, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  if (fog.all) return true;
  let ok = true;
  lineSubcells(a, b, (sx, sy) => {
    if (!fog.revealed(sx, sy)) ok = false;
    return ok;
  });
  return ok;
}

/**
 * Every sub-cell whose closed square meets the segment, row by row, until
 * `visit` says stop. Closed squares fail closed: a line along a sub-cell
 * line, or through a corner, counts the sub-cells on both sides of it.
 */
export function lineSubcells(a: { x: number; y: number }, b: { x: number; y: number }, visit: (sx: number, sy: number) => boolean): void {
  const ax = a.x * FOG_SUBCELLS;
  const ay = a.y * FOG_SUBCELLS;
  const bx = b.x * FOG_SUBCELLS;
  const by = b.y * FOG_SUBCELLS;
  const yLo = Math.min(ay, by);
  const yHi = Math.max(ay, by);
  for (let row = lowCell(yLo); row <= Math.floor(yHi); row++) {
    // The segment's x over this row's closed band, y from row to row + 1.
    const t0 = ay === by ? 0 : clamp01((row - ay) / (by - ay));
    const t1 = ay === by ? 1 : clamp01((row + 1 - ay) / (by - ay));
    const xa = ax + (bx - ax) * t0;
    const xb = ax + (bx - ax) * t1;
    const x0 = Math.min(xa, xb);
    const x1 = Math.max(xa, xb);
    for (let col = lowCell(x0); col <= Math.floor(x1); col++) if (!visit(col, row)) return;
  }
}

/** The lowest sub-cell whose closed square holds `v`: the one below as well when `v` lies on a line. */
function lowCell(v: number): number {
  const f = Math.floor(v);
  return f === v ? f - 1 : f;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
