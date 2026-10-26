import { FOG_SUBCELLS } from "#shared/model.ts";
import { pillReach, type PillProps } from "../features/measure/pillPlace.ts";
import { liftInPlane } from "./isoPlace.ts";
import type { IsoGround } from "./relief/context.ts";
import type { CellBox, FogView } from "./relief/fogView.ts";
import { boxStands, lineStands, strokeSubcells } from "./relief/stand.ts";

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
 * pillReach), its outline included. A pointed pill slides only along its
 * edge, which its reach spans. A plain pill can slide anywhere the screen's edge pushes it, so
 * it never stands over a player's fog: it fails closed.
 */
export function pillStands(fog: FogView, pill: Omit<PillProps, "color">): boolean {
  if (fog.all) return true;
  if (!pill.above && !pill.below) return false;
  // Its outline, 1.5 px wide, is centered on the box's edge.
  const edge = 1 / pill.scale;
  const r = pillReach(pill);
  return boxStands(fog, { x0: r.x0 - edge, y0: r.y0 - edge, x1: r.x1 + edge, y1: r.y1 + edge });
}

/** Whether a box in cells stands: a badge's, a text drawing's. */
export function markStands(fog: FogView, box: CellBox): boolean {
  return boxStands(fog, box);
}

/** How a moving line shows: whole, or only inside the revealed sub-cells it crosses, each a rectangle in cells. */
export type LineShow = { whole: true } | { whole: false; clip: Rect[] };

/**
 * How a tether moving with a dragged token shows (5.1): whole when every
 * sub-cell its stroke can paint is revealed, its half width `r` in cells
 * and its round caps included (stand.ts lineStands), else clipped to the
 * revealed ones among them, so it draws nothing over a fogged sub-cell.
 */
export function tetherShows(fog: FogView, a: { x: number; y: number }, b: { x: number; y: number }, r: number): LineShow {
  if (lineStands(fog, a, b, r)) return { whole: true };
  const clip: Rect[] = [];
  const k = 1 / FOG_SUBCELLS;
  strokeSubcells(a, b, r, (sx, sy) => {
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

/**
 * The clip for a mark drawn point by point at its drawn height in the drag
 * layer (a stroke being drawn): the revealed sub-cells its box touches, in
 * the ground plane's units, each row's run cut where the drawn ground
 * changes and lifted by it, so the mark draws only on the tops of revealed
 * ground. Null when it shows whole: a viewer who sees all the ground, or a
 * box with every sub-cell revealed on one ground, where the mark lies on
 * one plane inside its box.
 */
export function liftedClip(iso: Pick<IsoGround, "fog" | "turn" | "ground">, box: CellBox): Rect[] | null {
  const { fog } = iso;
  if (fog.all) return null;
  const cellAt = (x: number, y: number) => iso.ground(x + 0.5, y + 0.5);
  if (fog.boxClear(box)) {
    const first = cellAt(Math.floor(box.x0), Math.floor(box.y0));
    let flat = true;
    for (let y = Math.floor(box.y0); flat && y < Math.max(Math.floor(box.y0) + 1, Math.ceil(box.y1)); y++) {
      for (let x = Math.floor(box.x0); flat && x < Math.max(Math.floor(box.x0) + 1, Math.ceil(box.x1)); x++) flat = cellAt(x, y) === first;
    }
    if (flat) return null;
  }
  const out: Rect[] = [];
  for (const r of fog.revealedRects(box)) {
    const cy = Math.floor(r.y);
    const end = r.x + r.w;
    let a = r.x;
    while (a < end) {
      const g = cellAt(Math.floor(a), cy);
      let b = Math.min(end, Math.floor(a) + 1);
      while (b < end && cellAt(b, cy) === g) b = Math.min(end, b + 1);
      const d = liftInPlane(iso.turn, g);
      out.push({ x: a + d.x, y: r.y + d.y, w: b - a, h: r.h });
      a = b;
    }
  }
  return out;
}

