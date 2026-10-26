import { FOG_SUBCELLS } from "#shared/model.ts";
import { pillReach, type PillProps } from "../features/measure/pillPlace.ts";
import type { CellBox, FogView } from "./relief/fogView.ts";
import { boxStands, lineStands, lineSubcells } from "./relief/stand.ts";

/**
 * The stand rule (docs/design-v1-isometric-view.md 5.2, D-261026-5) for the
 * board's marks that Top-down draws under the fog: an area's or a trap's
 * pill and badge, a text drawing, and a moving tether or aura. A player
 * never sees more in Isometric than Top-down shows, so each stands only
 * where every fog sub-cell under its Top-down box is revealed to that
 * viewer, and otherwise lies flat on the ground stage under the fog. What
 * moves with a dragged token cannot lie under the fog, so it draws clipped
 * to the revealed sub-cells instead (5.1), which shows nothing over a
 * fogged one. Everything on the DM's device, or on a scene without fog,
 * stands (`FogView.all`).
 */

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Whether a pill stands: by the box Top-down draws it in at this zoom,
 * anywhere its slide along the screen's edge can put it (pillPlace.ts
 * pillReach). A pointed pill slides only along its edge, which its reach
 * spans. A plain pill can slide anywhere the screen's edge pushes it, so
 * it never stands over a player's fog: it fails closed.
 */
export function pillStands(fog: FogView, pill: Omit<PillProps, "color">): boolean {
  if (fog.all) return true;
  if (!pill.above && !pill.below) return false;
  return boxStands(fog, pillReach(pill));
}

/** Whether a box in cells stands: a badge's, a text drawing's. */
export function markStands(fog: FogView, box: CellBox): boolean {
  return boxStands(fog, box);
}

/** How a moving line shows: whole, or only inside the revealed sub-cells it crosses, each a rectangle in cells. */
export type LineShow = { whole: true } | { whole: false; clip: Rect[] };

/**
 * How a tether moving with a dragged token shows (5.1): whole when every
 * sub-cell it crosses is revealed (stand.ts lineStands), else clipped to
 * the revealed ones among them, so it draws nothing over a fogged sub-cell.
 */
export function tetherShows(fog: FogView, a: { x: number; y: number }, b: { x: number; y: number }): LineShow {
  if (lineStands(fog, a, b)) return { whole: true };
  const clip: Rect[] = [];
  const k = 1 / FOG_SUBCELLS;
  lineSubcells(a, b, (sx, sy) => {
    if (fog.revealed(sx, sy)) clip.push({ x: sx * k, y: sy * k, w: k, h: k });
    return true;
  });
  return { whole: false, clip };
}

/**
 * The revealed sub-cells of an aura's box, as rectangles in cells: where an
 * area moving with a dragged token shows (5.1). Null when it shows whole:
 * a viewer who sees all the ground, or a box with every sub-cell revealed.
 */
export function auraClip(fog: FogView, box: CellBox): Rect[] | null {
  if (fog.all || fog.boxClear(box)) return null;
  return fog.revealedRects(box);
}
