import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image as KImage, Layer, Rect, Shape } from "react-konva";
import type { Scene } from "#shared/model.ts";
import { phasePreloads, usePhasePreload } from "../../features/phases/preload.ts";
import { mapSwap, sameShown, type ShownMap } from "../../features/phases/swap.ts";
import type { AssetVariant } from "../../lib/api.ts";
import type { Rect as WorldRect } from "../../lib/camera.ts";
import { mapWorldRect } from "../../lib/scene.ts";
import { mapFailureText } from "../../state/sceneLoad.ts";
import { useAssets, useRoomUi, useRoomView } from "../../state/view.ts";
import { useMapProgressStore } from "../mapProgress.ts";
import { useMapImage, type MapImageState, type MapSource } from "../useImage.ts";

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
    a.scene.grid === b.scene.grid
  );
}

function MapLayerImpl(props: { scene: Scene; variant: AssetVariant; report: boolean }) {
  return (
    <Layer listening={false}>
      <MapContent scene={props.scene} variant={props.variant} report={props.report} />
    </Layer>
  );
}

/** Where a scene's map image loads from: the variant this device draws, and the full copy to fall back on. Null where the map cannot be placed. */
function mapSource(assets: ReturnType<typeof useAssets>, map: NonNullable<Scene["map"]>, variant: AssetVariant): { url: string | null; fallback: string | null } {
  return { url: mapWorldRect(map) ? assets.url(map.assetId, variant) : null, fallback: variant === "full" ? null : assets.url(map.assetId, "full") };
}

/** The map image the board's trees share: what it loads from, and how far it got. */
type SharedMap = { url: string | null; state: MapImageState };

const SharedMapContext = createContext<SharedMap | null>(null);

const LOADING: MapImageState = { image: null, status: "loading" };

/**
 * Loads the scene's map image once for both of the board's drawing trees
 * (docs/design-v1-isometric-view.md 5.1, ISO-D15). A map decodes to as much
 * as 256 MiB, so each tree loading its own would hold it twice. The trees'
 * map layers read this one through context, which reaches the frozen tree
 * past its memo. A tree on another scene's map, as a frozen one can be,
 * sees it loading and draws nothing of it.
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

/**
 * The background, the map image and the grid, for a layer of their own in
 * Top-down and for the isometric view's ground stage. Only the tree on
 * screen reports the map's progress (`report`), so the loading notice and
 * a failed download's toast come once.
 */
export const MapContent = memo(function MapContent(props: { scene: Scene; variant: AssetVariant; report: boolean; onDrawn?: (drawn: DrawnMap | null) => void }) {
  const { scene, variant } = props;
  const { w, h } = scene.bounds;
  return (
    <>
      <Rect x={0} y={0} width={w} height={h} fill={scene.background || "#2b2b31"} />
      {scene.map ? <MapImage sceneId={scene.id} map={scene.map} phases={scene.phases} variant={variant} sceneName={scene.name} report={props.report} onDrawn={props.onDrawn} /> : null}
      {scene.grid?.show ? <Grid scene={scene} /> : null}
    </>
  );
}, (a, b) => a.report === b.report && a.onDrawn === b.onDrawn && sameMapInputs(a, b));

const NO_PRELOADS: ReturnType<typeof phasePreloads> = [];

function MapImage(props: {
  sceneId: string;
  map: NonNullable<Scene["map"]>;
  phases: Scene["phases"];
  variant: AssetVariant;
  sceneName: string;
  report: boolean;
  onDrawn?: (drawn: DrawnMap | null) => void;
}) {
  const assets = useAssets();
  const ui = useRoomUi();
  const progress = useMapProgressStore();
  const rect = mapWorldRect(props.map);
  const source = mapSource(assets, props.map, props.variant);
  // Under the board's shared loader, this tree draws its image. Anywhere else it loads its own.
  const shared = useContext(SharedMapContext);
  const own = useMapImage(shared ? null : source.url, source.fallback);
  const { image, status } = shared ? (shared.url === source.url ? shared.state : LOADING) : own;

  // The image last drawn stays up while a new one for the same scene loads
  // (features/phases/swap.ts). The hook frees an image only once a new one
  // has settled, after the commit that stopped drawing it, so the kept one
  // is still whole whenever it is drawn.
  const [kept, setKept] = useState<ShownMap<MapSource> | null>(null);
  const swap = mapSwap({ sceneId: props.sceneId, assetId: props.map.assetId, rect, status, image }, kept);
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
  if (!drawn) return null;
  // Every variant is stretched to the calibrated rectangle, so a phone's
  // 4096 px copy and a desktop's 8192 px original agree with the printed
  // grid. The image is never cache()d: a cached 8192 px map exceeds iOS
  // canvas limits.
  return <KImage image={drawn.image} x={drawn.rect.x} y={drawn.rect.y} width={drawn.rect.width} height={drawn.rect.height} />;
}

/**
 * The whole grid is one shape with one path, so it is one draw call however
 * large the scene. Lines keep their width on screen at any zoom.
 */
function Grid(props: { scene: Scene }) {
  const { w, h } = props.scene.bounds;
  const { color, opacity, lineWidth } = props.scene.grid;
  return (
    <Shape
      stroke={color || "#ffffff"}
      strokeWidth={lineWidth > 0 ? lineWidth : 1}
      strokeScaleEnabled={false}
      opacity={Number.isFinite(opacity) ? opacity : 0.25}
      perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        for (let x = 0; x <= w; x++) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
        for (let y = 0; y <= h; y++) {
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.strokeShape(shape);
      }}
    />
  );
}

