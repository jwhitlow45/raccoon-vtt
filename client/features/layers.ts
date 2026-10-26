import type { ComponentType } from "react";
import type { Scene } from "#shared/model.ts";
import type { Box } from "../lib/boardText.ts";
import type { Live } from "../lib/view.ts";
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
import { CameraController } from "./dm/CameraLayer.tsx";
import { ThumbnailLayer } from "./scenes/ThumbnailLayer.tsx";
import { MoveLayer } from "./movement/MoveLayer.tsx";
import { FlashLayer } from "./outliner/FlashLayer.tsx";
import { PinLayer } from "./pins/PinLayer.tsx";
import { TetherLayer } from "./attach/TetherLayer.tsx";
import { TrapLayer } from "./traps/TrapLayer.tsx";
import { TrapAlerts } from "./traps/useTrapAlerts.ts";
import { TeleportToasts } from "./movement/toasts.ts";
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
 * and here: `{ id: "pings", layer: "overlay", order: 20, iso: "off", Component: PingLayer },` in LAYERS.
 *
 * The isometric view (docs/design-v1-isometric-view.md 5.1) draws the board
 * in a second tree, and `iso` says where each renderer goes there. A
 * renderer that runs effects (sounds, reminders, listeners, its own frame
 * clock) must not draw in both trees, or its effects run twice once
 * Isometric has shown. Such a renderer stays "off" until its effects move
 * into a controller (CONTROLLERS, mounted once outside both trees).
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

/**
 * Where a renderer draws in the isometric view:
 *
 * - `ground`: on the ground stage, under the fog where Top-down draws it
 *   under the fog and over it where Top-down draws it over, lifted onto
 *   raised ground with the tops that copy it. Nothing that moves each frame.
 * - `moving`: on the overlay, on the ground plane, for marks that move
 *   each frame (rulers, the laser, previews). Shows through the fog, as
 *   Top-down's overlay does.
 * - `upright`: on the overlay in view space, standing up.
 * - `off`: not drawn in Isometric: its tool shows Top-down while in use, or
 *   its effects have not moved into a controller yet.
 */
export type IsoPlace = "ground" | "moving" | "upright" | "off";

export type LayerDef = {
  id: string;
  layer: "board" | "underDecor" | "overlay";
  /** Draw order within the layer, lowest first. */
  order: number;
  iso: IsoPlace;
  Component: ComponentType<LayerProps>;
};

/**
 * What a controller reads: the layer props, and the camera, canvas and view
 * the board shows. A controller draws nothing and mounts once, outside both
 * drawing trees, whichever view shows (design 5.1, ISO-D15). It renders on
 * every camera change, as the board does.
 */
export type ControllerProps = LayerProps & { live: Live };

export type ControllerDef = { id: string; Component: ComponentType<ControllerProps> };

/** Every canvas renderer, one per line. */
export const LAYERS: readonly LayerDef[] = [
  { id: "drawings", layer: "board", order: 20, iso: "ground", Component: DrawingLayer },
  // Its reminder toasts run in the component, so it waits for its controller (ISO-3).
  { id: "templates", layer: "board", order: 30, iso: "off", Component: TemplateLayer },
  { id: "rangeRings", layer: "overlay", order: 6, iso: "ground", Component: RangeRingLayer },
  { id: "turnStart", layer: "overlay", order: 8, iso: "ground", Component: TurnStartLayer },
  // It listens to the dragged node, once per tree.
  { id: "rulers", layer: "overlay", order: 10, iso: "off", Component: RulerLayer },
  // Its sound, vibration and hold run in the component, so it waits for its controller (ISO-3).
  { id: "pings", layer: "overlay", order: 20, iso: "off", Component: PingLayer },
  // Its frame clock runs in the component, so it waits for its controller (ISO-3).
  { id: "laser", layer: "overlay", order: 30, iso: "off", Component: LaserLayer },
  { id: "aoePreviews", layer: "overlay", order: 40, iso: "moving", Component: AreaPreviewLayer },
  { id: "builder", layer: "board", order: 10, iso: "ground", Component: BuilderLayer },
  { id: "lightReach", layer: "overlay", order: 45, iso: "off", Component: LightReachLayer },
  { id: "stampHandles", layer: "overlay", order: 48, iso: "off", Component: StampHandles },
  { id: "heightMarks", layer: "underDecor", order: 46, iso: "off", Component: HeightLayer },
  { id: "fogDraft", layer: "overlay", order: 5, iso: "off", Component: FogLayer },
  { id: "gridAlign", layer: "overlay", order: 90, iso: "off", Component: GridLayer },
  { id: "exploredEdge", layer: "overlay", order: 2, iso: "ground", Component: ExploredEdgeLayer },
  { id: "movement", layer: "overlay", order: 9, iso: "moving", Component: MoveLayer },
  { id: "outlinerFlash", layer: "overlay", order: 95, iso: "moving", Component: FlashLayer },
  // Its pane and tap effects run in the component, so it waits for ISO-3.
  { id: "pins", layer: "overlay", order: 15, iso: "off", Component: PinLayer },
  // Its falling off reminder listens from the component, so it waits for its controller (ISO-3).
  { id: "tethers", layer: "board", order: 40, iso: "off", Component: TetherLayer },
  { id: "traps", layer: "board", order: 35, iso: "ground", Component: TrapLayer },
];

/** Everything that runs effects for the board and draws nothing, mounted once outside both drawing trees. */
export const CONTROLLERS: readonly ControllerDef[] = [
  { id: "dm-camera", Component: CameraController },
  { id: "scene-thumbnails", Component: ThumbnailLayer },
  { id: "trap-alerts", Component: TrapAlerts },
  { id: "teleport-toasts", Component: TeleportToasts },
];

export function layersOf(layer: LayerDef["layer"]): LayerDef[] {
  return LAYERS.filter((l) => l.layer === layer).sort((a, b) => a.order - b.order);
}

/** The renderers drawn in one place of the isometric view, in Top-down's layer order and then their own. */
export function isoLayersOf(place: IsoPlace, layer?: LayerDef["layer"]): LayerDef[] {
  const rank = { board: 0, underDecor: 1, overlay: 2 } as const;
  return LAYERS.filter((l) => l.iso === place && (layer === undefined || l.layer === layer)).sort((a, b) => rank[a.layer] - rank[b.layer] || a.order - b.order);
}
