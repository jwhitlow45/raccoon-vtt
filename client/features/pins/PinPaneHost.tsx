import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Pin, Scene } from "#shared/model.ts";
import { Loading } from "../../components/Loading.tsx";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { theme } from "../../lib/theme.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { panePlacement } from "../builder/labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { pinScreenBox } from "./rules.ts";
import { pinSlot } from "./store.ts";

const PinPane = retryableLazy(() => import("./PinPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts a pin's pane, for the DM, as it mounts a label's
 * (builder/LabelPaneHost.tsx): a bottom sheet on a phone, a card by the pin
 * on a wide screen. The pane loads only for a DM, and closes on its own once
 * it no longer applies: its pin is gone or on another scene, the Pin tool
 * was put down, or a token was tapped, whose bar takes its place.
 */
export function PinPaneHost(props: { scene: Scene; tool: string; camera: Camera; viewport: Size; insets: Insets }) {
  const store = useScoped(pinSlot).store;
  const paneId = useStore(store, (s) => s.paneId);
  const pin = useRoomView((s) => (paneId ? s.view?.pins[paneId] : undefined));
  const tokenSelected = useRoomView((s) => s.local.selectedId !== null);
  const open = paneId !== null && pin !== undefined && pin.sceneId === props.scene.id && props.tool === "pin" && !tokenSelected;
  useEffect(() => {
    if (paneId !== null && !open) store.setState({ paneId: null });
  }, [paneId, open, store]);
  if (!open || !pin) return null;
  return (
    <LoadBoundary
      fallback={(f) => (
        <div
          style={{
            position: "absolute",
            left: theme.space(2),
            right: theme.space(2),
            bottom: props.insets.bottom + theme.space(2),
            zIndex: theme.z.pane,
            padding: theme.space(3),
            background: theme.color.surface,
            border: `${theme.line.border}px solid ${theme.color.border}`,
            borderRadius: theme.radius.lg,
            boxShadow: theme.shadow.pane,
            color: theme.color.text,
          }}
        >
          <RoomLoadNotice {...f} subject="The pin editor" verb="load" compact reopen={{ tool: props.tool }} />
        </div>
      )}
    >
      <Suspense fallback={<PaneLoading pin={pin} camera={props.camera} viewport={props.viewport} insets={props.insets} />}>
        <PinPane pin={pin} camera={props.camera} viewport={props.viewport} insets={props.insets} onClose={() => store.setState({ paneId: null })} />
      </Suspense>
    </LoadBoundary>
  );
}

/** While the pane's code downloads, the shared loading notice takes the box the pane will appear in. */
function PaneLoading(props: { pin: Pin; camera: Camera; viewport: Size; insets: Insets }) {
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box: pinScreenBox(props.pin, props.camera), height: PANE_HEIGHT_UNMEASURED });
  // Even padding: the pane's slight top padding is for its header, which a loading notice does not have.
  return <Loading text="Loading the pin editor…" style={{ ...labelPaneFrame(place), padding: theme.space(3) }} />;
}
