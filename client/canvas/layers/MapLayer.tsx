import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image as KImage, Layer, Rect, Shape } from "react-konva";
import type Konva from "konva";
import type { Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { useMapVideo } from "../../features/animmap/AnimMapController.tsx";
import { phasePreloads, usePhasePreload } from "../../features/phases/preload.ts";
import { mapSwap, sameShown, type ShownMap } from "../../features/phases/swap.ts";
import type { AssetVariant } from "../../lib/api.ts";
import type { Rect as WorldRect } from "../../lib/camera.ts";
import { mapWorldRect } from "../../lib/scene.ts";
import { mapFailureText } from "../../state/sceneLoad.ts";
import { useAssets, useRoomUi, useRoomView } from "../../state/view.ts";
import { useMapProgressStore } from "../mapProgress.ts";
import { mapReadable, useMapImage, type MapSource } from "../useImage.ts";
import { hexLinesInView } from "./hexSpans.ts";
import { treeMap, type SharedMap } from "./sharedMap.ts";

/**
 * Layer 1 of 4 (design section 14.2): the scene background, the map image and
 * the grid. Nothing here takes input, so the layer skips its hit canvas
 * work entirely. Coordinates are world cells.
 *
 * This layer mounts only after the gate opens (section 13.3), so the map
 * request itself starts after the snapshot and its fog are applied.
 */
export const MapLayer = memo(MapLayerImpl, (a, b) => a.report === b.report && sameMapInputs(a, b));

/*
 * Every build op bumps the scene's walls version, which writes a new scene
 * object, and renaming or a fog toggle does too. None of those change what
 * this layer draws, so it compares only its own inputs and the map image
 * is not redrawn on every brush stroke.
 */
function sameMapInputs(a: { scene: Scene; variant: AssetVariant }, b: { scene: Scene; variant: AssetVariant }): boolean {
  return (
    a.variant === b.variant &&
    a.scene.id === b.scene.id &&
    a.scene.bounds.w === b.scene.bounds.w &&
    a.scene.bounds.h === b.scene.bounds.h &&
    a.scene.background === b.scene.background &&
    a.scene.map === b.scene.map &&
    a.scene.phases === b.scene.phases &&
    a.scene.grid === b.scene.grid &&
    a.scene.gridShape === b.scene.gridShape
  );
}

function MapLayerImpl(props: { scene: Scene; variant: AssetVariant; report: boolean }) {
  return (
    <Layer listening={false}>
      <MapContent scene={props.scene} variant={props.variant} report={props.report} video />
    </Layer>
  );
}

/** Where a scene's map image loads from: the variant this device draws, and the full copy to fall back on. Null where the map cannot be placed. */
function mapSource(assets: ReturnType<typeof useAssets>, map: NonNullable<Scene["map"]>, variant: AssetVariant): { url: string | null; fallback: string | null } {
  return { url: mapWorldRect(map) ? assets.url(map.assetId, variant) : null, fallback: variant === "full" ? null : assets.url(map.assetId, "full") };
}

const SharedMapContext = createContext<SharedMap | null>(null);

/**
 * Loads the scene's map image once for both of the board's drawing trees
 * (docs/design/design-v1-isometric-view.md 5.1, ISO-D15). A map decodes to as much
 * as 256 MiB, so each tree loading its own would hold it twice. The trees'
 * map layers read this one through context, which reaches the frozen tree
 * past its memo. A tree on another map, as a frozen one can be, draws
 * nothing of it and keeps nothing of its own (sharedMap.ts treeMap).
 */
export function SharedMapImage(props: { scene: Scene; variant: AssetVariant; children: ReactNode }) {
  const assets = useAssets();
  const map = props.scene.map;
  const source = map ? mapSource(assets, map, props.variant) : { url: null, fallback: null };
  const { image, status } = useMapImage(source.url, source.fallback);
  // The same object until the image or its status changes, so a camera render reaches no map layer.
  const shared = useMemo(() => ({ url: source.url, state: { image, status } }), [source.url, image, status]);
  return <SharedMapContext.Provider value={shared}>{props.children}</SharedMapContext.Provider>;
}

/** The image a map draws, as the board drew it last, for the isometric view's side tints (relief/looks.ts). */
export type DrawnMap = { image: MapSource; rect: WorldRect };

/** The drawn map while its pixels can still be read, else null (useImage.ts mapReadable). */
export function useReadableMap(drawn: DrawnMap | null): DrawnMap | null {
  const shared = useContext(SharedMapContext);
  return drawn && mapReadable(drawn.image, shared) ? drawn : null;
}

/**
 * The background, the map image and the grid, for a layer of their own in
 * Top-down and for the isometric view's ground stage. Only the tree on
 * screen reports the map's progress (`report`), so the loading notice and
 * a failed download's toast come once.
 *
 * `video`: this tree draws an animated map's video in the still's place
 * (docs/design/design-v1-animated-maps.md 5.1). Only Top-down's map layer
 * passes it, so the isometric tree, and the side tints its `onDrawn` feeds,
 * only ever get the still.
 */
export const MapContent = memo(function MapContent(props: { scene: Scene; variant: AssetVariant; report: boolean; video: boolean; onDrawn?: (drawn: DrawnMap | null) => void }) {
  const { scene, variant } = props;
  const { w, h } = scene.bounds;
  // Lining up the grid means finding the lines drawn in the map's art, and
  // the app's lines over them hide those. Only the DM has the tool. The
  // scene's setting is left alone, so the lines come back when it closes.
  const aligning = useRoomView((s) => s.local.tool === "grid");
  return (
    <>
      <Rect x={0} y={0} width={w} height={h} fill={scene.background || "#2b2b31"} />
      {scene.map ? <MapImage sceneId={scene.id} map={scene.map} phases={scene.phases} variant={variant} sceneName={scene.name} report={props.report} video={props.video} onDrawn={props.onDrawn} /> : null}
      {scene.grid?.show && !aligning ? <Grid scene={scene} /> : null}
    </>
  );
}, (a, b) => a.report === b.report && a.video === b.video && a.onDrawn === b.onDrawn && sameMapInputs(a, b));

const NO_PRELOADS: ReturnType<typeof phasePreloads> = [];

function MapImage(props: {
  sceneId: string;
  map: NonNullable<Scene["map"]>;
  phases: Scene["phases"];
  variant: AssetVariant;
  sceneName: string;
  report: boolean;
  video: boolean;
  onDrawn?: (drawn: DrawnMap | null) => void;
}) {
  const assets = useAssets();
  // The board's video while it may draw here, in place of the still (features/animmap/board.ts). The phase-swap keep below only ever holds the still.
  const moving = useMapVideo(props.video, props.map.video?.assetId);
  const ui = useRoomUi();
  const progress = useMapProgressStore();
  const rect = mapWorldRect(props.map);
  const source = mapSource(assets, props.map, props.variant);
  // Under the board's shared loader, this tree draws its image. Anywhere else it loads its own.
  const shared = useContext(SharedMapContext);
  const own = useMapImage(shared ? null : source.url, source.fallback);
  const { state, keepsLast } = treeMap(shared, source.url, own);
  const { image, status } = state;

  // The image last drawn stays up while a new one for the same scene loads
  // (features/phases/swap.ts). The hook frees an image only once a new one
  // has settled, after the commit that stopped drawing it, so the kept one
  // is still whole whenever it is drawn. Under the shared loader that holds
  // only for a tree on the loader's map, so a tree on another keeps nothing.
  const [kept, setKept] = useState<ShownMap<MapSource> | null>(null);
  const swap = mapSwap({ sceneId: props.sceneId, assetId: props.map.assetId, rect, status, image }, keepsLast ? kept : null);
  useEffect(() => {
    if (!sameShown(swap.keep, kept)) setKept(swap.keep);
  }, [swap.keep, kept]);

  // The DM's device fetches the other phases once this map is up (features/phases/preload.ts).
  const dm = useRoomView((s) => s.you?.role === "dm");
  const preloads = useMemo(
    () => (dm ? phasePreloads(props.phases, props.map.assetId, props.variant, assets.url) : []),
    [dm, props.phases, props.map.assetId, props.variant, assets],
  );
  // Once per device: only the tree on screen preloads.
  usePhasePreload(props.report ? preloads : NO_PRELOADS, status === "ready");

  // The loading notice over the canvas waits for this report. A map that
  // cannot be placed or will not load ends it as failed, so it never spins
  // forever, and a failed download says so once.
  const assetId = props.map.assetId;
  const placeable = rect !== null;
  const swapping = swap.swapping;
  // The name only words the toast, so a rename does not report again.
  const nameRef = useRef(props.sceneName);
  nameRef.current = props.sceneName;
  const reports = props.report;
  useEffect(() => {
    if (!reports) return;
    const report = (state: "loading" | "drawn" | "failed") => progress.setState({ progress: { assetId, state, swap: swapping } });
    if (!placeable) return report("failed");
    if (status === "loading") return report("loading");
    if (status === "failed") {
      report("failed");
      ui.notify(mapFailureText(nameRef.current), "error");
      return;
    }
    // Konva draws on the next animation frame. This callback was queued
    // after Konva's, so by the time it runs the map is on the canvas.
    const frame = requestAnimationFrame(() => report("drawn"));
    return () => cancelAnimationFrame(frame);
  }, [reports, assetId, placeable, status, swapping, progress, ui]);

  const drawn = swap.draw;
  const onDrawn = props.onDrawn;
  const drawnImage = drawn?.image ?? null;
  // The rectangle is made anew on each render, so its numbers say when it changed.
  const [rx, ry, rw, rh] = drawn ? [drawn.rect.x, drawn.rect.y, drawn.rect.width, drawn.rect.height] : [0, 0, 0, 0];
  useEffect(() => {
    if (!onDrawn) return;
    onDrawn(drawnImage ? { image: drawnImage, rect: { x: rx, y: ry, width: rw, height: rh } } : null);
  }, [onDrawn, drawnImage, rx, ry, rw, rh]);
  // A map removed from its scene unmounts this, and nothing may go on reading the image it drew.
  useEffect(() => () => onDrawn?.(null), [onDrawn]);
  if (!drawn) return null;
  // The video is stretched to the still's rectangle, the one the grid was lined up on.
  if (moving.element && rect) return <KImage ref={moving.ref} image={moving.element} x={rect.x} y={rect.y} width={rect.width} height={rect.height} />;
  // Every variant is stretched to the calibrated rectangle, so a phone's
  // 4096 px copy and a desktop's 8192 px original agree with the printed
  // grid. The image is never cache()d: a cached 8192 px map exceeds iOS
  // canvas limits.
  return <KImage ref={moving.ref} image={drawn.image} x={drawn.rect.x} y={drawn.rect.y} width={drawn.rect.width} height={drawn.rect.height} />;
}

/**
 * The whole grid is one shape with one path, so it is one draw call however
 * large the scene. Lines keep their width on screen at any zoom.
 *
 * A hex scene's lines (docs/design/design-v1-hex-grids.md HX-D18) are drawn in the
 * same redraws, but only the hexes in view and only while a hex is at
 * least HEX_LINES_MIN_PX across, so a pan costs the hexes on screen and not
 * the 46,000 of the largest scene. What is in view is read from the
 * shape's own transform as it draws, the camera's and in Isometric the
 * ground's turn and squash, so both views draw the very same hexes, each
 * through its own projection.
 */
function Grid(props: { scene: Scene }) {
  const { w, h } = props.scene.bounds;
  const { color, opacity, lineWidth } = props.scene.grid;
  const grid = sceneGrid(props.scene);
  const strokeWidth = lineWidth > 0 ? lineWidth : 1;
  // A new grid or bounds starts a new path cache. The scene keeps its grid object until the grid changes.
  const cache = useMemo<GridPath>(() => ({ key: "", path: null }), [props.scene.grid, props.scene.gridShape, w, h]);
  return (
    <Shape
      name="sceneGrid"
      stroke={color || "#ffffff"}
      strokeWidth={strokeWidth}
      strokeScaleEnabled={false}
      opacity={Number.isFinite(opacity) ? opacity : 0.25}
      perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        const path = gridPath(cache, shape, (sink) => {
          if (grid.shape === "hex") {
            const view = groundInView(shape);
            if (view) hexLinesInView(grid, props.scene.bounds, view, sink);
            return;
          }
          for (let x = 0; x <= w; x++) {
            sink.moveTo(x, 0);
            sink.lineTo(x, h);
          }
          for (let y = 0; y <= h; y++) {
            sink.moveTo(0, y);
            sink.lineTo(w, y);
          }
        });
        if (!path) return;
        // As Konva strokes a line that keeps its width on screen: in the canvas's device pixels, the path already in the stage's.
        const g = ctx._context;
        const ratio = ctx.getCanvas().getPixelRatio();
        g.save();
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        g.lineWidth = strokeWidth;
        g.strokeStyle = color || "#ffffff";
        g.stroke(path);
        g.restore();
      }}
    />
  );
}

/** A grid's lines as one path in the stage's pixels, and the transform and stage size it was built for. */
type GridPath = { key: string; path: Path2D | null };

/**
 * The grid's path, built once per camera (docs/design/design-v1-animated-maps.md
 * 5.2). An animated map redraws the map layer up to 30 times a second with
 * the camera still, and a hex scene's lines walk every hex in view
 * (hexSpans.ts), which would be the main cost of a zoomed-out hex scene. So
 * the path is kept in the stage's pixels, keyed on the shape's absolute
 * transform and the stage's size, and a draw with neither changed strokes
 * the same path. A camera move builds it afresh, as every draw did before.
 */
function gridPath(cache: GridPath, shape: Konva.Shape, build: (sink: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void }) => void): Path2D | null {
  const stage = shape.getStage();
  const m = shape.getAbsoluteTransform().getMatrix();
  const key = `${m.join(",")}|${stage?.width() ?? 0}x${stage?.height() ?? 0}`;
  if (cache.key === key) return cache.path;
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const path = new Path2D();
  build({
    moveTo: (x, y) => path.moveTo(a * x + c * y + e, b * x + d * y + f),
    lineTo: (x, y) => path.lineTo(a * x + c * y + e, b * x + d * y + f),
  });
  cache.key = key;
  cache.path = path;
  return path;
}

/**
 * Where a shape's stage shows the ground: the stage's canvas corners taken
 * back through the shape's absolute transform, and the screen pixels one
 * cell takes there, the transform's area scale, so a squashed isometric
 * ground counts by both its axes.
 */
function groundInView(shape: Konva.Shape): { corners: { x: number; y: number }[]; pxPerCell: number } | null {
  const stage = shape.getStage();
  if (!stage) return null;
  const t = shape.getAbsoluteTransform();
  const [a = 1, b = 0, c = 0, d = 1] = t.getMatrix();
  const back = t.copy().invert();
  const W = stage.width();
  const H = stage.height();
  return { corners: [back.point({ x: 0, y: 0 }), back.point({ x: W, y: 0 }), back.point({ x: W, y: H }), back.point({ x: 0, y: H })], pxPerCell: Math.sqrt(Math.abs(a * d - b * c)) };
}

