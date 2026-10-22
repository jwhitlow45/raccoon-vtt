import type { ComponentType } from "react";
import type { Scene } from "#shared/model.ts";
import type { Box } from "../lib/boardText.ts";
import { AreaPreviewLayer } from "./areas/AreaPreviewLayer.tsx";
import { TemplateLayer } from "./areas/TemplateLayer.tsx";
import { DrawingLayer } from "./drawings/DrawingLayer.tsx";
import { RangeRingLayer } from "./measure/RangeRingLayer.tsx";
import { RulerLayer } from "./measure/RulerLayer.tsx";
import { TurnStartLayer } from "./measure/TurnStartLayer.tsx";
import { LaserLayer } from "./pings/LaserLayer.tsx";
import { PingLayer } from "./pings/PingLayer.tsx";
import { BuilderLayer, LightReachLayer } from "./builder/BuilderLayer.tsx";
import { StampHandles } from "./builder/stamps/StampHandles.tsx";
import { FogLayer } from "./fog/FogLayer.tsx";
import { GridLayer } from "./grid/GridLayer.tsx";
import { CameraLayer } from "./dm/CameraLayer.tsx";
import { ThumbnailLayer } from "./scenes/ThumbnailLayer.tsx";
import { MoveLayer } from "./movement/MoveLayer.tsx";
import { FlashLayer } from "./outliner/FlashLayer.tsx";
import { PinLayer } from "./pins/PinLayer.tsx";
import { TetherLayer } from "./attach/TetherLayer.tsx";
import { TrapLayer } from "./traps/TrapLayer.tsx";
import { quietLazy } from "../lib/quietLazy.tsx";

/* The DM's height marks and explored outline, loaded after the room opens (lib/quietLazy.tsx). */
const HeightLayer = quietLazy<LayerProps>(() => import("./builder/heights/HeightLayer.tsx").then((m) => m.HeightLayer), ["dm"], "The height marks");
const ExploredEdgeLayer = quietLazy<LayerProps>(() => import("./vision/ExploredEdgeLayer.tsx").then((m) => m.ExploredEdgeLayer), ["dm"], "The explored outline");

/**
 * What features draw on the map canvas (design sections 13.3 and 14.2).
 *
 * Why a registry: the canvas has at most four Konva layers (map, board,
 * tokens, overlay), and several features share each one. Each feature owns
 * its renderer in its own files and adds one line here. Stage.tsx renders
 * every entry in its layer, in `order`, and never needs to know the feature.
 *
 * - `board`: between the map and the tokens. Builder cells and walls,
 *   drawings, area templates and their shading. Below the fog for players,
 *   because the fog sits on the overlay layer.
 * - `underDecor`: on the overlay layer too, but before the tokens' chips,
 *   labels and plates, so token text always reads on top of it. For marks
 *   that would otherwise cover a name, such as the height pills
 *   (docs/design-v1-visual.md 3.4). The same fog rule as `overlay` holds.
 * - `overlay`: above the fog image and the party's tokens. Rulers, pings,
 *   the laser and AoE previews. Anything drawn here shows through the fog,
 *   so draw only what every viewer of the scene may see.
 *
 * A renderer is a React component that returns Konva nodes (react-konva) in
 * world cells, and reads the room with useRoomView. It must not animate at
 * rest: run a requestAnimationFrame loop only while something moves, then
 * stop (design 14.2). `scale` is screen pixels per cell, for strokes and
 * labels that keep one size on screen (or use strokeScaleEnabled={false}).
 *
 * A minimal renderer, in client/features/ping/PingLayer.tsx:
 *
 *   export function PingLayer(props: LayerProps) {
 *     const pings = useRoomView((s) => s.ephemeral.pings);
 *     return <>{pings.map((p) => <Circle key={p.id} x={p.x} y={p.y} radius={12 / props.scale} stroke="#f7df00" />)}</>;
 *   }
 *
 * and here: `{ id: "pings", layer: "overlay", order: 20, Component: PingLayer },` in LAYERS.
 */

export type LayerProps = {
  scene: Scene;
  role: "dm" | "player";
  /** Screen pixels per cell at the current zoom. */
  scale: number;
  /** Whether the scene draws fog. */
  fog: boolean;
  /**
   * Every token label and plate on the board as drawn for this zoom, and
   * every token's chips, elevation badge and HP bar (canvas/textBoxes.ts),
   * in screen pixels with the world's origin at 0,0: a cell box
   * `{ x0, y0, x1, y1 }` is at `x0 * scale` and so on.
   *
   * The camera's pan is left out, so the array stays the same object while
   * the map pans, and a layer can memoize its work on it. The layer itself
   * still renders on every pan, since Stage does. A layer under the decor
   * reads the boxes to keep what it draws clear of the names and marks, and only
   * reads them: nothing goes back into the label placement
   * (lib/boardText.ts placeLabels), which reruns on every zoom step.
   */
  labelBoxes: readonly Box[];
};

export type LayerDef = {
  id: string;
  layer: "board" | "underDecor" | "overlay";
  /** Draw order within the layer, lowest first. */
  order: number;
  Component: ComponentType<LayerProps>;
};

/** Every canvas renderer, one per line. */
export const LAYERS: readonly LayerDef[] = [
  { id: "drawings", layer: "board", order: 20, Component: DrawingLayer },
  { id: "templates", layer: "board", order: 30, Component: TemplateLayer },
  { id: "rangeRings", layer: "overlay", order: 6, Component: RangeRingLayer },
  { id: "turnStart", layer: "overlay", order: 8, Component: TurnStartLayer },
  { id: "rulers", layer: "overlay", order: 10, Component: RulerLayer },
  { id: "pings", layer: "overlay", order: 20, Component: PingLayer },
  { id: "laser", layer: "overlay", order: 30, Component: LaserLayer },
  { id: "aoePreviews", layer: "overlay", order: 40, Component: AreaPreviewLayer },
  { id: "builder", layer: "board", order: 10, Component: BuilderLayer },
  { id: "lightReach", layer: "overlay", order: 45, Component: LightReachLayer },
  { id: "stampHandles", layer: "overlay", order: 48, Component: StampHandles },
  { id: "heightMarks", layer: "underDecor", order: 46, Component: HeightLayer },
  { id: "fogDraft", layer: "overlay", order: 5, Component: FogLayer },
  { id: "gridAlign", layer: "overlay", order: 90, Component: GridLayer },
  { id: "dm-camera", layer: "overlay", order: 0, Component: CameraLayer },
  { id: "scene-thumbnails", layer: "overlay", order: 1, Component: ThumbnailLayer },
  { id: "exploredEdge", layer: "overlay", order: 2, Component: ExploredEdgeLayer },
  { id: "movement", layer: "overlay", order: 9, Component: MoveLayer },
  { id: "outlinerFlash", layer: "overlay", order: 95, Component: FlashLayer },
  { id: "pins", layer: "overlay", order: 15, Component: PinLayer },
  { id: "tethers", layer: "board", order: 40, Component: TetherLayer },
  { id: "traps", layer: "board", order: 35, Component: TrapLayer },
];

export function layersOf(layer: LayerDef["layer"]): LayerDef[] {
  return LAYERS.filter((l) => l.layer === layer).sort((a, b) => a.order - b.order);
}
