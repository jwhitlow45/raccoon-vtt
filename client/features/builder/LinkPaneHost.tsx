import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useChromeCamera, type ChromeCamera } from "../../state/liveCamera.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { trapScreenBox } from "../traps/paneBox.ts";
import { panePlacement } from "./labelEdit.ts";
import { PANE_HEIGHT_UNMEASURED } from "./labelPaneFrame.ts";
import { paneEnd } from "./linkTap.ts";
import { PaneFailedFrame, PaneLoadingFrame } from "./PaneFrames.tsx";
import { builderSlot, linkPaneSlot } from "./store.ts";

const LinkPane = retryableLazy(() => import("./LinkPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts an end's pane, for the DM (LinkPane.tsx), beside
 * the label pane (LabelPaneHost.tsx). The pane loads only for a DM. It closes
 * on its own once it no longer applies: its end is gone or on a floor not
 * shown, or the builder's mode moved on from Between floors.
 */
export function LinkPaneHost(props: { scene: Scene; tool: string; chrome: ChromeCamera; viewport: Size; insets: Insets }) {
  const pane = useScoped(linkPaneSlot);
  const linkId = useStore(pane, (p) => p.linkId);
  const linking = useStore(useScoped(builderSlot).store, (b) => b.mode === "link");
  const link = useRoomView((s) => paneEnd(s.floorView, linkId));
  const role = useRoomView((s) => s.you?.role ?? "player");
  const open = linkId !== null && link !== null && link.sceneId === props.scene.id && props.tool === "build" && linking && role === "dm";
  const lane = useAlertsLane(props.viewport);
  useEffect(() => {
    if (linkId !== null && !open) pane.setState({ linkId: null });
  }, [linkId, open, pane]);
  const at = useChromeCamera(props.chrome, open);
  if (!open || !link || !at) return null;
  const close = () => pane.setState({ linkId: null });
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box: trapScreenBox(sceneGrid(props.scene), { zone: { cells: [link.rect] }, sceneId: link.sceneId }, {}, at.camera), height: PANE_HEIGHT_UNMEASURED, lane });
  return (
    <LoadBoundary
      fallback={(f) => (
        <PaneFailedFrame place={place} close={close}>
          <RoomLoadNotice {...f} subject="The stairs editor" verb="load" compact reopen={{ tool: props.tool }} />
        </PaneFailedFrame>
      )}
    >
      <Suspense fallback={<PaneLoadingFrame text="Loading the stairs editor…" place={place} close={close} />}>
        <LinkPane link={link} camera={at.camera} viewport={props.viewport} insets={props.insets} onClose={close} />
      </Suspense>
    </LoadBoundary>
  );
}
