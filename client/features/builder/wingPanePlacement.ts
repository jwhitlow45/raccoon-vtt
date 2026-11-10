import type { CellRect, Scene } from "#shared/model.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexCenter } from "#shared/rules/hex.ts";
import type { PaneLaneBox } from "../../canvas/barDock.ts";
import { fitRect, viewToScreen, type Camera, type Insets, type Size } from "../../lib/camera.ts";
import { TOP_DOWN, toView, type ViewBox, type ViewPoint } from "../../lib/view.ts";
import { PANE_MIN_HEIGHT, PANE_WIDTH, sheetPaneRoom, SHEET_BELOW_PX } from "./labelEdit.ts";

/*
 * Where the wing pane stands (docs/design: dungeon generator phase 3, 3.3,
 * D-261110-236). Not panePlacement's card by its target: a wing's area can
 * fill most of the map, and a card hung beside it would cover it. From 600
 * px wide the pane is a 296 px card docked at the map's left or right
 * edge, the one farther from the area's middle, running the map's height
 * between the bars with its rows scrolling. Below that it is a bottom
 * sheet of at most 60% of the map's height between the bars, so the ghost
 * keeps the rest above it. The camera fits the area and the way to the
 * join into the rest of the map once, as the pane opens.
 */

const MARGIN = 8;
/** The most of the map's height between the bars the pane takes as a bottom sheet: at 320 by 568 a share of the whole screen's would leave no map to show the ghost on. */
export const WING_SHEET_SHARE = 0.6;

/** A docked card names its side, so the camera's fit keeps to the other. A sheet's height is fixed, the pane's rows scrolling inside it. */
export type WingPlacement =
  | { kind: "sheet"; bottom: number; maxHeight: number; height: number }
  | { kind: "card"; side: "left" | "right"; left: number; top: number; width: number; maxHeight: number; height: number };

/**
 * The pane's place over the canvas. `areaX` is the area's middle across
 * the canvas, in pixels from its left. A card keeps left of the fight's
 * alerts while their column shows cards (`lane`), as the other map panes
 * do, so docking on the right stops at the lane.
 */
export function wingPanePlacement(input: { viewport: Size; insets: Insets; areaX: number; lane: PaneLaneBox | null }): WingPlacement {
  const { viewport, insets, areaX, lane } = input;
  if (viewport.width < SHEET_BELOW_PX) {
    const room = viewport.height - insets.top - insets.bottom;
    const height = Math.max(Math.min(PANE_MIN_HEIGHT, viewport.height - insets.bottom), Math.min(Math.round(room * WING_SHEET_SHARE), sheetPaneRoom(input)));
    return { kind: "sheet", bottom: insets.bottom, maxHeight: height, height };
  }
  const leftEdge = insets.left + MARGIN;
  const rightEdge = Math.min(viewport.width - insets.right, lane ? lane.left : Infinity) - MARGIN;
  const width = Math.max(0, Math.min(PANE_WIDTH, rightEdge - leftEdge));
  const top = insets.top + MARGIN;
  const height = Math.max(PANE_MIN_HEIGHT, viewport.height - insets.bottom - MARGIN - top);
  // The edge farther from the area's middle, so the pane covers as little of the area as it can.
  const side = areaX - leftEdge >= rightEdge - areaX ? "left" : "right";
  return { kind: "card", side, left: side === "left" ? leftEdge : rightEdge - width, top, width, maxHeight: height, height };
}

/** The canvas the pane leaves: the bars' insets, grown by the docked card on its side or the sheet below. */
export function insetsBeside(place: WingPlacement, viewport: Size, insets: Insets): Insets {
  if (place.kind === "sheet") return { ...insets, bottom: place.bottom + place.height };
  return place.side === "left" ? { ...insets, left: place.left + place.width + MARGIN } : { ...insets, right: viewport.width - place.left + MARGIN };
}

/**
 * The fit of `box` (the area with the join, in view units) into the canvas
 * the pane leaves: the camera fitRect gives, and where the box's middle
 * lands as fractions of the canvas, which a pan request takes.
 */
export function wingFit(input: { viewport: Size; insets: Insets; place: WingPlacement; box: ViewBox }): { scale: number; anchor: { x: number; y: number } } {
  const clear = insetsBeside(input.place, input.viewport, input.insets);
  const camera = fitRect(input.viewport, input.box, 24, clear);
  const middle = viewToScreen(camera, { x: input.box.x + input.box.width / 2, y: input.box.y + input.box.height / 2 } as ViewPoint);
  return { scale: camera.scale, anchor: { x: middle.x / input.viewport.width, y: middle.y / input.viewport.height } };
}

/** The area with the join's leaves, as a box in cells: on hexes the hexes' middles less and more half a cell, as near as a box gets. */
export function wingBox(g: Grid, area: CellRect, join: { leaves: readonly { a: { x: number; y: number }; b: { x: number; y: number } }[] } | null): { x0: number; y0: number; x1: number; y1: number } {
  const corners = isHex(g)
    ? [hexCenter(g, { col: area.x, row: area.y }), hexCenter(g, { col: area.x + area.w - 1, row: area.y + area.h - 1 }), hexCenter(g, { col: area.x + area.w - 1, row: area.y }), hexCenter(g, { col: area.x, row: area.y + area.h - 1 })].flatMap((c) => [
        { x: c.x - 0.5, y: c.y - 0.5 },
        { x: c.x + 0.5, y: c.y + 0.5 },
      ])
    : [
        { x: area.x, y: area.y },
        { x: area.x + area.w, y: area.y + area.h },
      ];
  const points = [...corners, ...(join?.leaves.flatMap((l) => [l.a, l.b]) ?? [])];
  return { x0: Math.min(...points.map((p) => p.x)), y0: Math.min(...points.map((p) => p.y)), x1: Math.max(...points.map((p) => p.x)), y1: Math.max(...points.map((p) => p.y)) };
}

/** Where the pane stands for the camera it opened at: by the area's middle on screen. */
export function wingPlace(input: { scene: Pick<Scene, "gridShape">; area: CellRect; camera: Camera; viewport: Size; insets: Insets; lane: PaneLaneBox | null }): WingPlacement {
  const box = wingBox(sceneGrid(input.scene), input.area, null);
  const middle = viewToScreen(input.camera, toView(TOP_DOWN, { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }));
  return wingPanePlacement({ viewport: input.viewport, insets: input.insets, areaX: middle.x, lane: input.lane });
}
