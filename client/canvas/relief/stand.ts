import { FOG_SUBCELLS } from "#shared/model.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { footprint, type ViewToken } from "../../lib/scene.ts";
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

/**
 * The box a token covers in Top-down: the body as it is drawn, at its
 * stored corner, joined with the footprint the rules read (snapped, and
 * squeezed while it squeezes). Joining both fails closed whichever of the
 * two a later change draws.
 */
export function tokenBox(token: Pick<ViewToken, "x" | "y" | "size" | "w" | "h" | "squeeze">, at: { x: number; y: number } = token): CellBox {
  const fp = footprint(token);
  const rule = footprintRect({ ...token, x: at.x, y: at.y });
  return {
    x0: Math.min(at.x, rule.x),
    y0: Math.min(at.y, rule.y),
    x1: Math.max(at.x + fp.w, rule.x + rule.w),
    y1: Math.max(at.y + fp.h, rule.y + rule.h),
  };
}

/**
 * Whether a creature stands up as a standee. Party members and tokens every
 * player sees (`aboveFog`, lib/scene.ts drawsAboveFog) draw above the fog
 * in Top-down, so they stand wherever they are.
 */
export function creatureStands(fog: FogView, token: ViewToken, aboveFog: boolean): boolean {
  if (fog.all || aboveFog) return true;
  return boxStands(fog, tokenBox(token));
}

/**
 * Whether another member's drag ghost stands at one eased frame, judged at
 * that frame's spot, so a ghost whose path crosses fog lies flat on every
 * frame it is over fog. Its name tag is judged by its own box.
 */
export function ghostStands(fog: FogView, token: ViewToken, at: { x: number; y: number }): boolean {
  if (fog.all) return true;
  return boxStands(fog, tokenBox(token, at));
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
