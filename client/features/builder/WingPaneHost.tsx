import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useChromeCamera, type ChromeCamera } from "../../state/liveCamera.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { Choices } from "../dungeon/Choices.tsx";
import { PaneFailedFrame, PaneLoadingFrame } from "./PaneFrames.tsx";
import { builderSlot } from "./store.ts";
import { wingPlace } from "./wingPanePlacement.ts";

const WingPane = retryableLazy(() => import("./WingPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts the wing pane (WingPane.tsx), for the DM, beside
 * the label and stairs panes (LabelPaneHost.tsx). The pane loads only for
 * a DM. It closes on its own once it no longer applies: the tool or mode
 * moved on, or the area or join it opened for is gone, on this scene.
 */
export function WingPaneHost(props: { scene: Scene; tool: string; chrome: ChromeCamera; viewport: Size; insets: Insets }) {
  const { store } = useScoped(builderSlot);
  const wingOpen = useStore(store, (b) => b.wingOpen);
  const mode = useStore(store, (b) => b.mode);
  const picks = useStore(store, (b) => b.wing);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const area = picks?.sceneId === props.scene.id ? picks.area : null;
  const join = picks?.sceneId === props.scene.id ? picks.join : null;
  const open = wingOpen && props.tool === "build" && mode === "wing" && role === "dm" && area !== null && join !== null;
  const lane = useAlertsLane(props.viewport);
  useEffect(() => {
    if (wingOpen && !open) store.setState({ wingOpen: false, wingGhost: null, wingEdit: false, wingRoom: null });
  }, [wingOpen, open, store]);
  const at = useChromeCamera(props.chrome, open);
  if (!open || !picks || !area || !join || !at) return null;
  const close = () => store.setState({ wingOpen: false, wingGhost: null, wingEdit: false, wingRoom: null });
  const place = wingPlace({ scene: props.scene, area, camera: at.camera, viewport: props.viewport, insets: props.insets, lane });
  return (
    <LoadBoundary
      fallback={(f) => (
        <PaneFailedFrame place={place} close={close}>
          <RoomLoadNotice {...f} subject="The wing pane" verb="load" compact reopen={{ tool: props.tool }} />
        </PaneFailedFrame>
      )}
    >
      <Suspense fallback={<PaneLoadingFrame text="Loading the wing pane…" place={place} close={close} />}>
        <WingPane
          scene={props.scene}
          picks={{ ...picks, area, join }}
          camera={at.camera}
          viewport={props.viewport}
          insets={props.insets}
          onClose={close}
          choices={Choices}
        />
      </Suspense>
    </LoadBoundary>
  );
}
