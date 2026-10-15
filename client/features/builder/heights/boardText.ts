import { boardSizes } from "../../../lib/boardScale.ts";
import type { Box } from "../../../lib/boardText.ts";
import { theme } from "../../../lib/theme.ts";
import { regionText, type HeightRegion } from "./regions.ts";

/**
 * The text Height mode writes on the board: a region's height in a pill and
 * a "?" on a stair the rule cannot point. Both follow the map like the rest
 * of the board's text (lib/boardScale.ts, docs/design.md 14.2): the pill at
 * the size of every other board pill, the "?" at a chip's letters. Kept in
 * this one helper so a change to how the board draws text changes one place.
 */

/** The board pill's design size, at 40 px a cell. The pill's padding and height below are for this size. */
const DESIGN_PX = 12;
const PAD_X = 6;
const PILL_H = 20;
/** The pill's outline, the same 1.5 screen px as the board's other pills (measure/Pill.tsx). */
const EDGE_PX = 1.5;
/**
 * A raised region's outline is light and a lowered one's grey, so the two
 * read apart before the arrow does. The height readout's pill takes the
 * same outlines (ReadoutHost.tsx).
 */
export const RAISED_EDGE = "rgba(255, 255, 255, 0.7)";
export const LOWERED_EDGE = "rgba(160, 160, 170, 0.7)";

export type HeightPillSize = { fontPx: number; padX: number; heightPx: number };

/**
 * Height mode's text sizes at a zoom of `cellPx` screen pixels a cell, for
 * this device's interface size unless `ui` names one. The pill's padding
 * and height grow with its text, as a board pill's do (measure/Pill.tsx
 * pillGeometry), so it keeps its shape at every size.
 */
export function heightTextSizes(cellPx: number, ui?: number): { pill: HeightPillSize; markPx: number } {
  const sizes = boardSizes(cellPx, ui);
  const k = sizes.pillPx / DESIGN_PX;
  return { pill: { fontPx: sizes.pillPx, padX: Math.round(PAD_X * k), heightPx: PILL_H * k }, markPx: sizes.chipTextPx };
}

/** A pill placed for one zoom, in screen pixels with the world's origin at 0,0, the space of LayerProps `labelBoxes`. */
export type PlacedPill = { text: string; box: Box; raised: boolean; fontPx: number };

/** A text's width on screen in the pill's font at `px`: canvas/measureText.ts measurePill on the board. */
export type MeasurePill = (text: string, px: number) => number;

/**
 * The canvas calls the height marks make. A shape of its own rather than
 * the DOM's CanvasRenderingContext2D, which fits it, so this file also
 * loads where there is no DOM: scripts/bench-height-pills.ts times the
 * placement in Node, and the scripts' typecheck leaves the DOM out.
 */
export type MarkCanvas = {
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  roundRect(x: number, y: number, w: number, h: number, radius: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
};

/**
 * Where each region's pill goes at this zoom: the first of its spots whose
 * pill clears every pill placed before it and every token label, plate,
 * chip row, elevation badge and HP bar (`labels`, features/layers.ts
 * LayerProps `labelBoxes`). A region with no
 * such spot gets no pill at this zoom, since a pill half under a name reads
 * no better than none, and a zoom that gives it room brings it back.
 *
 * The labels are only read. The pills are not obstacles of the label
 * placement, which reruns on every zoom step of a pinch, so up to 300 of
 * them would slow every frame of it (docs/design-v1-visual.md 3.4).
 * Regions place in the order given.
 */
export function placeHeightPills(regions: readonly HeightRegion[], labels: readonly Box[], cellPx: number, size: HeightPillSize, measure: MeasurePill): PlacedPill[] {
  const placed: PlacedPill[] = [];
  const taken = boxIndex();
  for (const l of labels) taken.add(l);
  const halfH = size.heightPx / 2;
  const halfWs = new Map<string, number>();
  for (const r of regions) {
    const text = regionText(r.ground);
    let halfW = halfWs.get(text);
    if (halfW === undefined) halfWs.set(text, (halfW = measure(text, size.fontPx) / 2 + size.padX));
    for (const spot of r.spots) {
      const x = spot.x * cellPx;
      const y = spot.y * cellPx;
      const box = { x0: x - halfW, y0: y - halfH, x1: x + halfW, y1: y + halfH };
      if (taken.hits(box)) continue;
      taken.add(box);
      placed.push({ text, box, raised: r.ground > 0, fontPx: size.fontPx });
      break;
    }
  }
  return placed;
}

/** The side of the squares boxIndex files boxes by, in screen pixels: about a pill's width, a name's height. */
const BUCKET_PX = 64;
/** Spaces the columns of buckets apart in a bucket's key. A scene at the closest zoom spans far fewer than half this many buckets down. */
const KEY_ROW = 1 << 20;

/**
 * Boxes filed by the squares they touch, so a spot is checked against the
 * few names and pills near it rather than all of them. A pinch places every
 * pill again on each step, and checking each spot against every pill placed
 * before it was most of the layer's time in a frame.
 */
function boxIndex(): { add(box: Box): void; hits(box: Box): boolean } {
  const buckets = new Map<number, Box[]>();
  return {
    add(box) {
      const x1 = Math.floor(box.x1 / BUCKET_PX);
      const y1 = Math.floor(box.y1 / BUCKET_PX);
      for (let bx = Math.floor(box.x0 / BUCKET_PX); bx <= x1; bx++) {
        for (let by = Math.floor(box.y0 / BUCKET_PX); by <= y1; by++) {
          const list = buckets.get(bx * KEY_ROW + by);
          if (list) list.push(box);
          else buckets.set(bx * KEY_ROW + by, [box]);
        }
      }
    },
    hits(box) {
      const x1 = Math.floor(box.x1 / BUCKET_PX);
      const y1 = Math.floor(box.y1 / BUCKET_PX);
      for (let bx = Math.floor(box.x0 / BUCKET_PX); bx <= x1; bx++) {
        for (let by = Math.floor(box.y0 / BUCKET_PX); by <= y1; by++) {
          for (const other of buckets.get(bx * KEY_ROW + by) ?? []) if (overlaps(other, box)) return true;
        }
      }
      return false;
    },
  };
}

function font(px: number): string {
  return `700 ${px}px ${theme.font.body}`;
}

/**
 * Draws the pills that show in `view` (cells, the part of the scene on
 * screen, or every pill when null) on a context in world cells, at `cellPx`
 * screen pixels a cell. A pinch draws every frame, so the pills share their
 * canvas state: the pills of each edge color make one path, filled and
 * outlined once, then every text draws in one font. They never overlap, so
 * the order does not show.
 */
export function drawPills(g: MarkCanvas, pills: readonly PlacedPill[], cellPx: number, view: Box | null): void {
  const onScreen = view ? { x0: view.x0 * cellPx, y0: view.y0 * cellPx, x1: view.x1 * cellPx, y1: view.y1 * cellPx } : null;
  const shown = onScreen ? pills.filter((p) => overlaps(p.box, onScreen)) : pills;
  if (shown.length === 0) return;
  g.save();
  g.scale(1 / cellPx, 1 / cellPx);
  g.fillStyle = theme.color.overlay;
  g.lineWidth = EDGE_PX;
  for (const raised of [true, false]) {
    g.beginPath();
    for (const p of shown) {
      if (p.raised !== raised) continue;
      const h = p.box.y1 - p.box.y0;
      g.roundRect(p.box.x0, p.box.y0, p.box.x1 - p.box.x0, h, h / 2);
    }
    g.fill();
    g.strokeStyle = raised ? RAISED_EDGE : LOWERED_EDGE;
    g.stroke();
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = theme.color.text;
  let px = 0;
  for (const p of shown) {
    if (p.fontPx !== px) g.font = font((px = p.fontPx));
    // A middle baseline sits these digits a little high, so the text drops a twelfth of its size.
    g.fillText(p.text, (p.box.x0 + p.box.x1) / 2, (p.box.y0 + p.box.y1) / 2 + p.fontPx / DESIGN_PX);
  }
  g.restore();
}

/** A short mark, such as "?", centered on a point, in a color with a dark halo. */
export function drawMark(g: MarkCanvas, text: string, x: number, y: number, scale: number, px: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.scale(1 / scale, 1 / scale);
  g.font = font(px);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.lineWidth = 4;
  g.strokeStyle = theme.color.textHalo;
  g.strokeText(text, 0, 1);
  g.fillStyle = color;
  g.fillText(text, 0, 1);
  g.restore();
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
