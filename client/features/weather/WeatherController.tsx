import { Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { useSceneLoading } from "../../canvas/SceneLoading.tsx";
import { LoadBoundary, type FallbackProps } from "../../components/LoadBoundary.tsx";
import { reportQuietFailure } from "../../lib/quietFailures.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import type { View } from "../../lib/view.ts";
import { dockSlot } from "../../pages/fold.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { useLowPower, useWeatherMode } from "../device/settings.ts";
import { usePreview } from "../dm/previewContext.ts";
import type { ControllerProps } from "../layers.ts";
import { topDownTool } from "../view/choice.ts";
import { lookOf } from "./looks.ts";
import { useCoveredByPreview, usePageVisible, useReducedMotion, weatherSlot, type WeatherRoom } from "./store.ts";

/**
 * The weather's controller (docs/design/design-v1-weather.md 5.2), mounted
 * once outside both drawing trees (features/layers.ts CONTROLLERS). It draws
 * nothing: it tells the room's clock (store.ts) what decides the mode, and
 * the clock ticks the layer that shows. The camera is not among its inputs,
 * since each layer reads its own stage's camera as it draws, and a camera
 * change draws through that stage's own batchDraw.
 */
export function WeatherController(props: ControllerProps) {
  const room = useScoped(weatherSlot);
  const weather = props.scene.weather;
  // A scene edit anywhere sends the whole scene, so this is a new weather object each time. The room keeps its look and particles while they draw the same (store.ts setLook).
  const look = useMemo(() => lookOf(weather), [weather]);
  const setting = useWeatherMode();
  const reducedMotion = useReducedMotion();
  const lowPower = useLowPower();
  const pageVisible = usePageVisible();
  const tool = useRoomView((s) => s.local.tool);
  // The four tools that show Top-down need the map clear (4.4). Only a DM holds them.
  const setupTool = props.role === "dm" && topDownTool(tool) !== null;
  const covered = useStore(useScoped(dockSlot), (s) => s.sheetFull);
  const preview = useCoveredByPreview(usePreview() !== null);
  const loading = useSceneLoading() !== null;

  useLayoutEffect(() => room.setLook(look), [room, look]);
  useLayoutEffect(() => {
    room.input({ setting, reducedMotion, lowPower, pageVisible, setupTool, covered, preview, loading });
  }, [room, setting, reducedMotion, lowPower, pageVisible, setupTool, covered, preview, loading]);
  const wasLoading = useRef(loading);
  useLayoutEffect(() => {
    // A scene's map decoding is one long stall, so its end restarts the warm-up (6.3).
    if (wasLoading.current && !loading) room.sceneLoaded();
    wasLoading.current = loading;
  }, [room, loading]);
  return null;
}

/**
 * The drawing code, fetched the first time a scene with weather shows and
 * never preloaded: no roles (lib/retryableLazy.ts). Until it loads nothing
 * draws.
 */
const WeatherLayer = retryableLazy<WeatherLayerProps>(() => import("./WeatherLayer.tsx"));

export type WeatherLayerProps = {
  room: WeatherRoom;
  bounds: Scene["bounds"];
  view: View;
  /** The stage's size in CSS px. */
  width: number;
  height: number;
};

/**
 * Where the weather draws in one tree (5.1): a line in Top-down's stage,
 * between the board and the tokens, and one in the isometric main stage,
 * between the relief and the drag layer. It mounts a layer only while the
 * scene has weather and this device draws it, so a clear scene has no
 * fifth canvas.
 */
export function WeatherMount(props: { scene: Scene; view: View; width: number; height: number }) {
  const room = useScoped(weatherSlot);
  const mounted = useStore(room.state, (s) => s.mounted);
  if (!mounted) return null;
  return (
    // As lib/quietLazy.tsx: a failed load draws nothing on the map and reports to the room's one notice.
    <LoadBoundary fallback={(f) => <Report {...f} />}>
      <Suspense fallback={null}>
        <WeatherLayer room={room} bounds={props.scene.bounds} view={props.view} width={props.width} height={props.height} />
      </Suspense>
    </LoadBoundary>
  );
}

function Report(props: FallbackProps) {
  const { failure, retry } = props;
  const id = useId();
  useEffect(() => {
    reportQuietFailure(id, { subject: "The weather", failure, retry });
    return () => reportQuietFailure(id, null);
  }, [id, failure, retry]);
  return null;
}
