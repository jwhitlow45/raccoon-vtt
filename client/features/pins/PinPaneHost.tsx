import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Insets, Size } from "../../lib/camera.ts";
import { useChromeCamera, type ChromeCamera } from "../../state/liveCamera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { panePlacement } from "../builder/labelEdit.ts";
import { PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { PaneFailedFrame, PaneLoadingFrame } from "../builder/PaneFrames.tsx";
import { pinScreenBox, type PinView } from "./rules.ts";
import { pinSlot } from "./store.ts";

const PinPane = retryableLazy(() => import("./PinPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts a pin's pane, for the DM, as it mounts a label's
 * (builder/LabelPaneHost.tsx): a bottom sheet on a phone, a card by the pin
 * on a wide screen, by the pin where the board stands it (`shown`). The
 * pane loads only for a DM, and closes on its own once
 * it no longer applies: its pin is gone or on another scene, the Pin tool
 * was put down, or a token was tapped, whose bar takes its place.
 */
export function PinPaneHost(props: { scene: Scene; tool: string; chrome: ChromeCamera; viewport: Size; insets: Insets; shown?: PinView }) {
  const store = useScoped(pinSlot).store;
  const paneId = useStore(store, (s) => s.paneId);
  const pin = useRoomView((s) => (paneId ? s.view?.pins[paneId] : undefined));
  const tokenSelected = useRoomView((s) => s.local.selectedId !== null);
  const open = paneId !== null && pin !== undefined && pin.sceneId === props.scene.id && props.tool === "pin" && !tokenSelected;
  const lane = useAlertsLane(props.viewport);
  useEffect(() => {
    if (paneId !== null && !open) store.setState({ paneId: null });
  }, [paneId, open, store]);
  // At the camera the canvas last drew, subscribed only while it shows (docs/design-v1-relief-pan.md 6.3).
  const at = useChromeCamera(props.chrome, open);
  if (!open || !pin || !at) return null;
  const close = () => store.setState({ paneId: null });
  // While the pane's code downloads, and if it fails to, the shared notices take the box the pane will appear in, beside the fight's alerts as the pane will stand.
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box: pinScreenBox(pin, at.camera, props.shown), height: PANE_HEIGHT_UNMEASURED, lane });
  return (
    <LoadBoundary
      fallback={(f) => (
        <PaneFailedFrame place={place} close={close}>
          <RoomLoadNotice {...f} subject="The pin editor" verb="load" compact reopen={{ tool: props.tool }} />
        </PaneFailedFrame>
      )}
    >
      <Suspense fallback={<PaneLoadingFrame text="Loading the pin editor…" place={place} close={close} />}>
        <PinPane pin={pin} camera={at.camera} viewport={props.viewport} insets={props.insets} {...(props.shown ? { shown: props.shown } : {})} onClose={close} />
      </Suspense>
    </LoadBoundary>
  );
}
