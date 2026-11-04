import type { VideoFacts } from "#shared/model.ts";
import { matrixRow, orientationOf, rowShift } from "#shared/videoGeometry.ts";

/**
 * Where a video's frame draws so it shows the way its file asked
 * (docs/design/design-v1-video-turns.md 7). The stored file is plain, so
 * every browser decodes the same upright, square-pixel frame at its coded
 * size, and the turn and the mirror ride in the facts. Top-down's map
 * image, the Library viewer and the still read from the stored copy all
 * place the frame through here, so they never disagree. A stretch needs
 * nothing here: the frame fills a box of the drawn shape.
 */

export type PlaceRect = { x: number; y: number; width: number; height: number };

type Turned = Pick<VideoFacts, "turn" | "mirror">;

/** Konva attributes for the image that draws the frame. */
export type VideoPlacement = { x: number; y: number; width: number; height: number; offsetX: number; offsetY: number; rotation: number; scaleX: number; scaleY: number };

/** The frame's box before the turn: the rectangle, its sides swapped for a quarter turn. */
function boxBeforeTurn(rect: PlaceRect, turn: 0 | 90 | 180 | 270): { width: number; height: number } {
  return turn === 90 || turn === 270 ? { width: rect.height, height: rect.width } : { width: rect.width, height: rect.height };
}

/**
 * The Konva attributes that draw the plain frame onto `rect`, the still's
 * rectangle: the box before the turn, centered there and turned about its
 * center. A plain video gets the rectangle itself, as before turns.
 */
export function videoPlacement(rect: PlaceRect, facts: Turned): VideoPlacement {
  const { turn, mirror } = orientationOf(facts);
  if (turn === 0 && !mirror) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  const box = boxBeforeTurn(rect, turn);
  const quarter = turn === 90 || turn === 270;
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width: box.width,
    height: box.height,
    offsetX: box.width / 2,
    offsetY: box.height / 2,
    rotation: turn,
    // Konva scales before it turns, so a left-to-right mirror after a quarter turn flips the box's height.
    scaleX: mirror && !quarter ? -1 : 1,
    scaleY: mirror && quarter ? -1 : 1,
  };
}

/** The same placement for a canvas and for CSS. */
export type PlacementTransform = {
  /** The box the frame fills before the turn. */
  box: { width: number; height: number };
  /** Takes the box's points, from (0, 0), onto the rectangle, as a canvas's setTransform does: (a·x + c·y + e, b·x + d·y + f). */
  matrix: [number, number, number, number, number, number];
  /** Where an element of the box's size sits, centered on the rectangle, before its CSS transform. */
  element: PlaceRect;
  /** That element's CSS transform, about its center, or "none" for a plain video. */
  css: string;
};

/**
 * The placement as the table's matrix row (shared/videoGeometry.ts 4.1),
 * moved into the positive quadrant as the row's own shift does, then onto
 * the rectangle. The still drawn from the stored copy takes the matrix, and
 * the Library viewer's `<video>` the element and the CSS.
 */
export function placementTransform(rect: PlaceRect, facts: Turned): PlacementTransform {
  const row = matrixRow(orientationOf(facts));
  const box = boxBeforeTurn(rect, row.turn);
  const [tx, ty] = rowShift(row, box.width, box.height);
  const plain = row.turn === 0 && !row.mirror;
  return {
    box,
    matrix: [row.a, row.b, row.c, row.d, rect.x + tx, rect.y + ty],
    element: { x: rect.x + (rect.width - box.width) / 2, y: rect.y + (rect.height - box.height) / 2, width: box.width, height: box.height },
    css: plain ? "none" : `matrix(${row.a}, ${row.b}, ${row.c}, ${row.d}, 0, 0)`,
  };
}
