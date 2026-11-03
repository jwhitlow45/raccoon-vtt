import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type Konva from "konva";
import { useStore } from "zustand";
import type { AssetId } from "#shared/model.ts";
import { useSceneLoading } from "../../canvas/SceneLoading.tsx";
import { theme } from "../../lib/theme.ts";
import { dockSlot } from "../../pages/fold.ts";
import { useScoped, useScopedIfAny } from "../../state/scope.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { useAnimatedMaps, useLowPower, useMapVariant } from "../device/settings.ts";
import { usePreview } from "../dm/previewContext.ts";
import type { ControllerProps } from "../layers.ts";
import { topDownTool } from "../view/choice.ts";
import { useCoveredByPreview, usePageVisible, useReducedMotion } from "../weather/store.ts";
import { animMapSlot, pageSteppedDown, subscribePageStepDown, type AnimMapBoard, type BoardShown, type LayerLike, type VideoLike } from "./board.ts";
import { decodable } from "./capabilities.ts";
import { boardVideoSlot, provideVideoJudge, useServerAnimatedMaps, type StillReason } from "./status.ts";

/**
 * Animated maps' controller (docs/design/design-v1-animated-maps.md 5.2),
 * mounted once outside both drawing trees (features/layers.ts CONTROLLERS),
 * beside the weather's. It draws nothing: it tells the room's board
 * (board.ts) what decides its video, passes the board's status on to the
 * Map image row (status.ts boardVideoSlot), and answers the device's
 * playback rule for any video (status.ts provideVideoJudge).
 */
export function AnimMapController(props: ControllerProps) {
  const board = useScoped(animMapSlot);
  const status = useScoped(boardVideoSlot);
  const assets = useAssets();
  const video = props.scene.map?.video ?? null;
  const url = video ? assets.url(video.assetId, "full") : null;
  const server = useServerAnimatedMaps();
  const setting = useAnimatedMaps();
  const lowPower = useLowPower();
  const reducedMotion = useReducedMotion();
  const variant = useMapVariant();
  const pageVisible = usePageVisible();
  const tool = useRoomView((s) => s.local.tool);
  // The four tools that show Top-down show the still, so the DM lines up and paints on the frame the grid search measured (5.1). Only a DM holds them.
  const setupTool = props.role === "dm" && topDownTool(tool) !== null;
  const panelCovered = useStore(useScoped(dockSlot), (s) => s.sheetFull);
  const preview = useCoveredByPreview(usePreview() !== null);
  const loading = useSceneLoading() !== null;
  const iso = props.live.view.kind === "isometric";

  useLayoutEffect(() => {
    board.onStatus = (next) => status.set(next);
    status.set(board.status);
    return () => {
      board.onStatus = null;
    };
  }, [board, status]);
  useLayoutEffect(() => {
    board.input({ video, url, server, setting, lowPower, reducedMotion, variant, iso, setupTool, pageVisible, panelCovered, preview, loading });
  }, [board, video, url, server, setting, lowPower, reducedMotion, variant, iso, setupTool, pageVisible, panelCovered, preview, loading]);

  // The rule for a video the board is not playing: the Map image row's other phases and the Library viewer (status.ts judgeVideo).
  useEffect(() => provideVideoJudge(async (v) => board.judge(v, await decodable(v, board.variant === "mobile"))), [board]);
  return null;
}

/** The board's ground behind the canvas, #16161a. The light theme keeps it for the board, so the rebase onto it reads boardTheme.color.bg here. */
const BOARD_GROUND = theme.color.bg;

/**
 * The board's video in the page (5.2): an `aria-hidden` box at the board's
 * size, under the Konva stages, holding the room's one `<video>` and, while
 * it holds a source, an opaque cover in the board's ground. The canvas is
 * transparent outside the scene's rectangle, and the Top-down stage is 0
 * wide in Isometric, so without the cover the raw, unfogged video would
 * show there. Browsers pause muted video by viewport and CSS visibility,
 * not by what covers it, so the covered element keeps playing.
 *
 * A `pointerup` or `click` on the board tries a refused `play()` again
 * (5.3 Autoplay): the box listens on the board's container, since the
 * canvas over it takes the press.
 *
 * Test hooks: `data-animmap` says what the board does with its video, the
 * box's `animMapDraws` and `animMapCameraDraws` count the map layer's video
 * draws and camera draws apart, and `animMapDrawMs` holds the last video
 * draws' main-thread times for the bench.
 */
export function AnimMapHost() {
  const board = useScoped(animMapSlot);
  const holdsSrc = useSyncExternalStore(board.subscribe, () => board.shown.holdsSrc, () => false);
  const boxRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const slot = slotRef.current;
    if (!box || !slot) return;
    Object.defineProperty(box, "animMapDraws", { configurable: true, get: () => board.videoDraws });
    Object.defineProperty(box, "animMapCameraDraws", { configurable: true, get: () => board.cameraDraws });
    Object.defineProperty(box, "animMapDrawMs", { configurable: true, get: () => [...board.drawMs] });
    box.dataset.animmap = board.state;
    board.onState = (state) => (box.dataset.animmap = state);
    board.attachHost({
      place: (video) => {
        const el = video as unknown as HTMLVideoElement;
        if (el.parentNode !== slot) slot.appendChild(el);
      },
      remove: (video) => {
        const el = video as unknown as HTMLVideoElement;
        if (el.parentNode === slot) slot.removeChild(el);
      },
    });
    const container = box.parentElement;
    const tap = () => board.tapped();
    container?.addEventListener("pointerup", tap);
    container?.addEventListener("click", tap);
    return () => {
      container?.removeEventListener("pointerup", tap);
      container?.removeEventListener("click", tap);
      board.onState = null;
      board.attachHost(null);
    };
  }, [board]);

  return (
    <div ref={boxRef} data-animmap-board="" aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div ref={slotRef} style={{ position: "absolute", inset: 0 }} />
      {holdsSrc ? <div data-animmap-cover="" style={{ position: "absolute", inset: 0, background: BOARD_GROUND }} /> : null}
    </div>
  );
}

const NOT_SHOWN: BoardShown = { element: null, assetId: null, holdsSrc: false };
const noBoard = { subscribe: () => () => {}, shown: NOT_SHOWN };

/**
 * For Top-down's map image (canvas/layers/MapLayer.tsx): the board's
 * `<video>` while Konva may draw it in the still's place, else null, and the
 * ref its Konva image takes. Whatever the image draws is told back to the
 * board after each commit, so the board clears the element's source only
 * once Konva holds it no more.
 */
export function useMapVideo(enabled: boolean, assetId: AssetId | undefined): { element: HTMLVideoElement | null; ref: (node: Konva.Image | null) => void } {
  const board = useScopedIfAny(animMapSlot);
  const source = board ?? noBoard;
  const shown = useSyncExternalStore(source.subscribe, () => source.shown, () => NOT_SHOWN);
  const element = enabled && assetId !== undefined && shown.assetId === assetId ? (shown.element as unknown as HTMLVideoElement | null) : null;
  useLayoutEffect(() => {
    board?.konvaHolds(element as unknown as VideoLike | null);
  }, [board, element]);
  useLayoutEffect(() => () => board?.konvaHolds(null), [board]);
  const layerRef = useRef<Konva.Layer | null>(null);
  const ref = useCallback(
    (node: Konva.Image | null) => {
      const layer = node?.getLayer() ?? null;
      if (layer === layerRef.current) return;
      layerRef.current = layer;
      board?.attachLayer(layer ? konvaLayer(layer) : null);
    },
    [board],
  );
  // A map layer that goes away takes the board's draws with it.
  useEffect(() => () => board?.attachLayer(null), [board]);
  return { element, ref };
}

/** Konva's layer as the board draws it. `_waitingForDraw` is Konva's own flag for a batchDraw asked for this frame. */
function konvaLayer(layer: Konva.Layer): LayerLike {
  return {
    draw: () => void layer.draw(),
    waitingForDraw: () => (layer as Konva.Layer & { _waitingForDraw?: boolean })._waitingForDraw === true,
    onDraw(listener) {
      layer.on("draw.animmap", listener);
      return () => layer.off("draw.animmap", listener);
    },
  };
}

/**
 * Why every animated map on this device shows its still though Moving is
 * chosen, for This device's help line: Low power, reduced motion or the
 * step-down. Null when nothing device-wide keeps them still.
 */
export function useDeviceStillReason(): StillReason | null {
  const lowPower = useLowPower();
  const reducedMotion = useReducedMotion();
  const stepped = useSyncExternalStore(subscribePageStepDown, pageSteppedDown, () => null);
  if (lowPower) return "lowPower";
  if (reducedMotion) return "reducedMotion";
  return stepped;
}

export type { AnimMapBoard };
