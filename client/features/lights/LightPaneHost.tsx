import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { Loading } from "../../components/Loading.tsx";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { theme } from "../../lib/theme.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { lightSlot } from "../builder/lightTap.ts";
import { builderSlot } from "../builder/store.ts";
import { panePlacement } from "../builder/labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { lightScreenBox } from "./paneBox.ts";
import { lightModeSlot } from "./store.ts";

const LightPane = retryableLazy(() => import("./LightPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts the pane of the light tapped in the builder's
 * Light mode (docs/design-v1-maps-vision.md section 4.3.1), for the DM.
 * Its code loads only for a DM. It closes on its own when it no longer
 * applies: the light is gone or on another scene, or the tool or the
 * builder's mode moved on.
 */
export function LightPaneHost(props: { scene: Scene; camera: Camera; viewport: Size; insets: Insets }) {
  const modeStore = useScoped(lightModeSlot).store;
  const paneOpen = useStore(modeStore, (s) => s.paneOpen);
  const lightId = useStore(useScoped(lightSlot), (s) => s.lightId);
  const lightMode = useStore(useScoped(builderSlot).store, (b) => b.mode === "light");
  const building = useRoomView((s) => s.local.tool === "build");
  const role = useRoomView((s) => s.you?.role ?? "player");
  const light = useRoomView((s) => (lightId ? s.view?.lights[lightId] : undefined));
  const open = paneOpen && role === "dm" && building && lightMode && light !== undefined && light.sceneId === props.scene.id;
  // The frames shown while the pane loads or failed to stand where the pane will, beside the fight's alerts.
  const lane = useAlertsLane(props.viewport);
  useEffect(() => {
    if (paneOpen && !open) modeStore.setState({ paneOpen: false });
  }, [paneOpen, open, modeStore]);
  if (!open || !light) return null;
  const close = () => modeStore.setState({ paneOpen: false });
  return (
    <LoadBoundary
      fallback={(f) => (
        <div style={{ ...labelPaneFrame(panePlacement({ viewport: props.viewport, insets: props.insets, box: lightScreenBox(light, props.camera), height: PANE_HEIGHT_UNMEASURED, lane })), padding: theme.space(3) }}>
          <RoomLoadNotice {...f} subject="The light editor" verb="load" compact reopen={{ tool: "build" }} />
        </div>
      )}
    >
      <Suspense
        fallback={
          <Loading
            text="Loading the light editor…"
            // Even padding: the pane's slight top padding is for its header, which a loading notice does not have.
            style={{ ...labelPaneFrame(panePlacement({ viewport: props.viewport, insets: props.insets, box: lightScreenBox(light, props.camera), height: PANE_HEIGHT_UNMEASURED, lane })), padding: theme.space(3) }}
          />
        }
      >
        <LightPane light={light} camera={props.camera} viewport={props.viewport} insets={props.insets} onClose={close} />
      </Suspense>
    </LoadBoundary>
  );
}
