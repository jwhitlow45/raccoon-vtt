import type { Box } from "../lib/boardText.ts";
import type { ViewToken } from "../lib/scene.ts";
import type { PlacedLines, TokenText } from "./useBoardText.ts";

/**
 * Where token text sits on the board, shared by the drawing
 * (TokenNode.tsx Lines) and the boxes Stage hands to the layers under the
 * decor (features/layers.ts LayerProps `labelBoxes`), so a mark that keeps
 * clear of a box keeps clear of what is drawn there.
 */

/** A plate's padding above and below its lines, in screen pixels. Its sides need none: the plate's lines carry their own side padding. */
export const PLATE_PAD = 3;
/** The plate's outline. Konva centers a stroke on the edge, so half of it lies outside the plate's box. */
export const PLATE_STROKE = 1;

/** The box TokenNode fills and outlines behind a plate's lines. */
export function plateRect(block: Pick<PlacedLines, "x" | "y" | "width" | "height">): { x: number; y: number; width: number; height: number } {
  return { x: block.x, y: block.y - PLATE_PAD, width: block.width, height: block.height + 2 * PLATE_PAD };
}

/** All a plate covers, its outline included, in the block's own space. */
export function plateBounds(block: Pick<PlacedLines, "x" | "y" | "width" | "height">): Box {
  const rect = plateRect(block);
  const out = PLATE_STROKE / 2;
  return { x0: rect.x - out, y0: rect.y - out, x1: rect.x + rect.width + out, y1: rect.y + rect.height + out };
}

/**
 * Each token's label, or the plate drawn in its place (a plate hides the
 * label), and its marks (condition chips, the elevation badge, the HP
 * bar), in screen pixels with the world's origin at 0,0, the space
 * useBoardText places them in. A plate counts with its padding and
 * outline, as drawn. The marks draw over what sits under the decor, so a
 * height pill that kept off the names alone could still lie half under an
 * elevation badge ("↑25" over "↑25 ft") and read as neither.
 */
export function placedTextBoxes(tokens: readonly ViewToken[], text: ReadonlyMap<string, TokenText>, scale: number): Box[] {
  const out: Box[] = [];
  for (const t of tokens) {
    const placed = text.get(t.id);
    const ox = t.x * scale;
    const oy = t.y * scale;
    for (const m of placed?.marks?.boxes ?? []) out.push({ x0: ox + m.x0, y0: oy + m.y0, x1: ox + m.x1, y1: oy + m.y1 });
    if (placed?.plate) {
      const b = plateBounds(placed.plate);
      out.push({ x0: ox + b.x0, y0: oy + b.y0, x1: ox + b.x1, y1: oy + b.y1 });
    } else if (placed?.label) {
      const b = placed.label;
      // Lines in TokenNode draw a px/4 halo centered on each text edge.
      const halo = Math.max(0, ...b.lines.map((line) => line.px / 8));
      out.push({ x0: ox + b.x - halo, y0: oy + b.y - halo, x1: ox + b.x + b.width + halo, y1: oy + b.y + b.height + halo });
    }
  }
  return out;
}
