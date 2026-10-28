import { CHUNK_CELLS } from "#shared/model.ts";
import type { CellRange } from "#shared/rules/footprint.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";
import { chunkHeights, heightsGrid } from "#shared/rules/heights.ts";
import { seenGround, type Cell, type GroundSource } from "../features/builder/heights/ground.ts";
import { cameraOfStage, screenToView, type Camera, type Insets, type Point, type Rect, type Size } from "./camera.ts";

/**
 * The board's two views (docs/design-v1-isometric-view.md section 4).
 *
 * World units are cells, x right and y down the map, and a height z is in
 * cells too: feet over the room's feet per cell. View space is the stage's
 * coordinates before the camera (lib/camera.ts), and in Top-down it is the
 * world itself. Isometric is the 2:1 dimetric projection: the ground turns
 * 45 degrees and halves in height, heights rise K view units a cell, and the
 * view turns in four steps. It is a view, never a change to the map: no rule
 * reads it, so a press becomes a world point once and everything after runs
 * as in Top-down.
 */

export type ViewKind = "topDown" | "isometric";

/** Turning right adds 1 mod 4: the map turns clockwise. */
export type Turn = 0 | 1 | 2 | 3;

export type View = { readonly kind: "topDown" } | { readonly kind: "isometric"; readonly turn: Turn };

export const TOP_DOWN: View = { kind: "topDown" };

const ISOMETRIC: readonly View[] = [
  { kind: "isometric", turn: 0 },
  { kind: "isometric", turn: 1 },
  { kind: "isometric", turn: 2 },
  { kind: "isometric", turn: 3 },
];

export function isometric(turn: Turn): View {
  return ISOMETRIC[turn]!;
}

export function turned(turn: Turn, by: 1 | -1): Turn {
  return ((turn + by + 4) % 4) as Turn;
}

// A brand that exists only in the types, so a world point can never reach the camera without going through toView.
declare const viewSpace: unique symbol;

/** A point in view space: what the camera turns into a screen point. */
export type ViewPoint = Point & { readonly [viewSpace]: true };

/** A rectangle in view space, such as the box a fit frames. */
export type ViewBox = Rect & { readonly [viewSpace]: true };

/** View units a cell of height lifts: the camera tilt that halves the ground (ISO-D1). A literal, so every build agrees on it. */
export const K = 0.8660254037844386;

const R = Math.SQRT1_2;

/** Each turn's c and s (section 4.1's table): at turn 0 the map's top edge faces up and to the right. */
const AXES: readonly { readonly c: number; readonly s: number }[] = [
  { c: R, s: R },
  { c: -R, s: R },
  { c: -R, s: -R },
  { c: R, s: -R },
];

export function turnAxes(turn: Turn): { readonly c: number; readonly s: number } {
  return AXES[turn]!;
}

/** A world point at height `z` in view space. Top-down draws every height flat. */
export function toView(view: View, p: Point, z = 0): ViewPoint {
  if (view.kind === "topDown") return { x: p.x, y: p.y } as ViewPoint;
  const { c, s } = AXES[view.turn]!;
  return { x: c * p.x - s * p.y, y: (s * p.x + c * p.y) / 2 - K * z } as ViewPoint;
}

/** The world point at height `z` that shows at `v`: toView's inverse. */
export function toWorld(view: View, v: ViewPoint, z = 0): Point {
  if (view.kind === "topDown") return { x: v.x, y: v.y };
  const { c, s } = AXES[view.turn]!;
  const w = 2 * (v.y + K * z);
  return { x: c * v.x + s * w, y: c * w - s * v.x };
}

/** How near a world point lies to the viewer at a turn, larger nearer: the key Isometric's pieces sort by (section 5.6). */
export function depth(turn: Turn, x: number, y: number): number {
  const { c, s } = AXES[turn]!;
  return s * x + c * y;
}

/**
 * A world rectangle's box in view space: its four corners through toView
 * at 0, the top raised by `lift` cells of height, the highest drawn lift
 * inside it (section 4.2's Fit). In Top-down it is the rectangle itself.
 */
export function viewBox(view: View, rect: Rect, lift = 0): ViewBox {
  if (view.kind === "topDown") return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } as ViewBox;
  const corners = [
    toView(view, { x: rect.x, y: rect.y }),
    toView(view, { x: rect.x + rect.width, y: rect.y }),
    toView(view, { x: rect.x, y: rect.y + rect.height }),
    toView(view, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys) - K * Math.max(0, lift);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 } as ViewBox;
}

/**
 * Konva's attributes for the ground's two groups, outside first: the
 * ground turns, then halves in height. A node inside keeps world cells as
 * its x and y. `upright` undoes both for the parts that stand up inside.
 */
export function groundGroups(turn: Turn): { outer: { scaleY: number }; inner: { rotation: number }; upright: { rotation: number; scaleY: number } } {
  const rotation = 45 + 90 * turn;
  return { outer: { scaleY: 0.5 }, inner: { rotation }, upright: { rotation: -rotation, scaleY: 2 } };
}

/**
 * Arrow keys move by the screen (ISO-D11): Up toward the map edge that faces
 * up and to the right, Right toward the one down and to the right, and so
 * round, so Up is north at turn 0, west at 1, south at 2 and east at 3.
 * Top-down's arrows are turn 0's. Null for any other key.
 */
export function arrowStep(view: View, key: string): readonly [number, number] | null {
  const k = ARROWS.indexOf(key);
  if (k < 0) return null;
  const turn = view.kind === "isometric" ? view.turn : 0;
  return COMPASS_STEPS[(k - turn + 4) % 4]!;
}

const ARROWS = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];
/** North, east, south and west, clockwise. */
const COMPASS_STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

// ---------------------------------------------------------------- the middle

/** What a device knows of its own camera: the canvas, the camera on it, and the view it shows. */
export type Live = { camera: Camera; viewport: Size; view: View };

/**
 * The world point at height 0 under the middle of the canvas, or of the
 * part `insets` leave clear. It reads no heights, so no point a device
 * sends another (a spawn, a starting view, Follow me, the table display's
 * camera) depends on terrain another viewer cannot see (section 4.1).
 */
export function groundAtMiddle(live: Live, insets?: Insets): Point {
  const { viewport } = live;
  const middle = insets
    ? { x: insets.left + (viewport.width - insets.left - insets.right) / 2, y: insets.top + (viewport.height - insets.top - insets.bottom) / 2 }
    : { x: viewport.width / 2, y: viewport.height / 2 };
  return toWorld(live.view, screenToView(live.camera, middle));
}

/** A Konva stage's camera and size, for a layer that reads them where the stage stands rather than through the Stage's own state. */
export function liveOfStage(stage: { x(): number; y(): number; scaleX(): number; width(): number; height(): number }, view: View): Live {
  return { camera: cameraOfStage(stage), viewport: { width: stage.width(), height: stage.height() }, view };
}

// ---------------------------------------------------------------- drawn heights

/**
 * Below this many screen pixels a cell, twice it in Low power, every drawn
 * height is 0 (ISO-D12): walls, columns and pits lie flat as Top-down draws
 * them, and picking and standees read the same flat ground.
 */
export const STAND_MIN_PX = 12;

export function heightsStand(scale: number, lowPower: boolean): boolean {
  return scale >= standScale(lowPower);
}

/** The zoom in screen pixels a cell from which heights stand: STAND_MIN_PX, twice it in Low power. */
export function standScale(lowPower: boolean): number {
  return (lowPower ? 2 : 1) * STAND_MIN_PX;
}

/** What drawn heights read: the ground this viewer may see (heights/ground.ts), and whether heights stand at this zoom. */
export type DrawnSource = GroundSource & { stand: boolean };

/**
 * A cell's drawn ground in feet: its seen ground while heights stand, and 0
 * below the threshold and wherever this viewer has not seen the cell
 * (section 4.3). Every drawn height reads it, so the same visible state
 * over different hidden heights draws the same pixels. Rules keep reading
 * real heights.
 */
export function drawnGround(src: DrawnSource, cell: Cell): number {
  if (!src.stand || flatOnHexes(src)) return 0;
  return seenGround(src, cell) ?? 0;
}

/**
 * Whether the scene's heights are keyed by hexes (heights.ts heightsGrid),
 * which this view's square cells cannot read: there it draws the ground
 * flat, each creature standing at its elevation over it, until raised hexes
 * stand in the isometric view (docs/design-v1-hex-grids.md H3, As built).
 */
function flatOnHexes(src: Pick<DrawnSource, "chunks" | "sceneId">): boolean {
  return isHex(heightsGrid(src.chunks, src.sceneId));
}

/** The highest seen ground in feet under a footprint's cells (footprint.ts occupiedRange), a cell this viewer has not seen counting 0. */
export function seenFootprintGround(src: GroundSource, range: CellRange): number {
  if (flatOnHexes(src)) return 0;
  return highestOver(range, (cell) => seenGround(src, cell) ?? 0);
}

/** `seenFootprintGround` through `drawnGround`. */
export function drawnFootprintGround(src: DrawnSource, range: CellRange): number {
  return highestOver(range, (cell) => drawnGround(src, cell));
}

/**
 * Where a standee's base stands, in feet: its lift over the seen ground
 * under it, set on the drawn ground there (section 4.3). Above the
 * threshold that is its elevation, below it the lift alone. Hidden terrain
 * never enters, so a token over fogged ground draws the same whatever lies
 * under the fog.
 */
export function drawnBase(src: DrawnSource, range: CellRange, elevation: number): number {
  return drawnFootprintGround(src, range) + elevation - seenFootprintGround(src, range);
}

function highestOver(r: CellRange, groundOf: (cell: Cell) => number): number {
  if (r.x0 >= r.x1 || r.y0 >= r.y1) return 0;
  let top = -Infinity;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) top = Math.max(top, groundOf({ x, y }));
  return top;
}

/** A scene's drawn ground as a pick reads it, in cells of height. */
export type DrawnHeights = {
  /** The scene's size in cells. Cells outside it count as 0. */
  readonly bounds: { w: number; h: number };
  /** The lowest and the highest drawn ground in the scene, in cells of height, each with 0 among them. */
  readonly low: number;
  readonly high: number;
  /** The drawn ground of a cell inside the scene, in cells of height. */
  at(x: number, y: number): number;
};

/** Flat ground: what a pick reads below the threshold, on a scene without heights, and in tests. */
export function flatHeights(bounds: { w: number; h: number }): DrawnHeights {
  return { bounds, low: 0, high: 0, at: () => 0 };
}

/** The drawn heights of a viewer's scene, read once per pick or per change of the ground. */
export function drawnHeights(src: DrawnSource, feetPerCell: number): DrawnHeights {
  if (!src.stand || flatOnHexes(src)) return flatHeights(src.bounds);
  let low = 0;
  let high = 0;
  const prefix = `${src.sceneId}:`;
  for (const [key, chunk] of Object.entries(src.chunks)) {
    if (!key.startsWith(prefix)) continue;
    const heights = chunkHeights(chunk);
    if (!heights) continue;
    for (let i = 0; i < heights.length; i++) {
      const feet = heights[i]!;
      if (feet === 0 || (feet >= low && feet <= high)) continue;
      const cell = { x: chunk.cx * CHUNK_CELLS + (i % CHUNK_CELLS), y: chunk.cy * CHUNK_CELLS + Math.floor(i / CHUNK_CELLS) };
      if (cell.x < 0 || cell.y < 0 || cell.x >= src.bounds.w || cell.y >= src.bounds.h) continue;
      if (src.fog && isCellFullyFogged(src.fog, src.sceneId, cell)) continue;
      low = Math.min(low, feet);
      high = Math.max(high, feet);
    }
  }
  return { bounds: src.bounds, low: low / feetPerCell, high: high / feetPerCell, at: (x, y) => drawnGround(src, { x, y }) / feetPerCell };
}

// ---------------------------------------------------------------- picking

/** What a pick reads: the camera, the view, the scene's grid and its drawn heights. */
export type PickSource = { camera: Camera; view: View; grid: Grid; heights: DrawnHeights };

/** How far a pick on a cell's near face lands inside that cell, so the point names the cell it hit and not its neighbor. */
export const FACE_NUDGE = 1e-6;

/**
 * The world point a press at `screen` means (section 4.3): in Top-down the
 * point under it, in Isometric the first drawn ground its ray meets.
 */
export function pickGround(src: PickSource, screen: Point): Point {
  return pickWalk(src, screen).point;
}

/**
 * `pickGround` with the height, in cells, where the ray met the ground, and
 * how many cells the walk visited. In Isometric the ray's trace on the
 * ground, toWorld(v, z), runs from near the viewer to far as z falls from
 * the highest drawn ground to the lowest, 2K cells of trace per cell of
 * height. The walk visits the scene's cells the trace crosses, in that
 * order. A cell entered at or below its ground is hit on its near face, and
 * one whose ground lies between entry and exit on its top. Outside the
 * scene the ground is 0, so the walk covers only the stretch of the trace
 * over the scene: at most 2√2·K·Δz + 3 cells, since a stretch crosses at
 * most one more cell line on each axis than its length along it, and never
 * more than the scene's w + h.
 */
export function pickWalk(src: PickSource, screen: Point): { point: Point; z: number; visited: number } {
  const { view, heights } = src;
  const v = screenToView(src.camera, screen);
  // Hex scenes hold no heights before the hex grids' H3, which brings the hex walk (section 4.4).
  if (view.kind === "topDown" || isHex(src.grid)) return { point: toWorld(view, v), z: 0, visited: 0 };
  const top = Math.max(heights.high, 0);
  const bottom = Math.min(heights.low, 0);
  if (top === bottom) return { point: toWorld(view, v), z: 0, visited: 0 };
  const { c, s } = AXES[view.turn]!;
  const a = toWorld(view, v);
  // The trace is a + z·(dx, dy). Neither is ever 0, since the ground is turned 45 degrees.
  const dx = 2 * K * s;
  const dy = 2 * K * c;
  const at = (z: number): Point => ({ x: a.x + z * dx, y: a.y + z * dy });
  const { w, h } = heights.bounds;
  const zx = [-a.x / dx, (w - a.x) / dx].sort((p, q) => p - q) as [number, number];
  const zy = [-a.y / dy, (h - a.y) / dy].sort((p, q) => p - q) as [number, number];
  const enter = Math.min(top, zx[1], zy[1]);
  const leave = Math.max(bottom, zx[0], zy[0]);
  // The trace meets the ground outside the scene at 0 before it reaches the scene, or misses the scene.
  if (enter <= leave || enter < 0) return { point: at(0), z: 0, visited: 0 };
  const stepX = dx > 0 ? -1 : 1;
  const stepY = dy > 0 ? -1 : 1;
  const start = at(enter);
  let cx = cellOf(start.x, stepX, w);
  let cy = cellOf(start.y, stepY, h);
  let z = enter;
  let visited = 0;
  while (visited <= w + h) {
    visited++;
    const ground = heights.at(cx, cy);
    if (z <= ground) return { point: inCell(at(z), cx, cy), z, visited };
    const exitX = ((stepX > 0 ? cx + 1 : cx) - a.x) / dx;
    const exitY = ((stepY > 0 ? cy + 1 : cy) - a.y) / dy;
    const out = Math.max(exitX, exitY, leave);
    if (ground >= out) return { point: inCell(at(ground), cx, cy), z: ground, visited };
    z = out;
    if (out === leave) break;
    if (exitX >= exitY) cx += stepX;
    if (exitY >= exitX) cy += stepY;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) break;
  }
  // Past the scene's far edge the ground is 0: its near face when the trace leaves at or below 0, else its top.
  if (z > 0) return { point: at(0), z: 0, visited };
  const past = at(z);
  return { point: { x: past.x + stepX * FACE_NUDGE, y: past.y + stepY * FACE_NUDGE }, z, visited };
}

/** The cell a trace moving by `step` along an axis is in at `x`: on a cell line, the cell it moves into. */
function cellOf(x: number, step: number, n: number): number {
  const cell = step > 0 ? Math.floor(x) : Math.ceil(x) - 1;
  return Math.min(n - 1, Math.max(0, cell));
}

function inCell(p: Point, cx: number, cy: number): Point {
  const clamp = (v: number, c: number) => Math.min(c + 1 - FACE_NUDGE, Math.max(c + FACE_NUDGE, v));
  return { x: clamp(p.x, cx), y: clamp(p.y, cy) };
}
