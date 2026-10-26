import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import type { BoardPick } from "../../canvas/boardPick.ts";
import { labelPaneAllowed, panePlacement } from "./labelEdit.ts";
import { labelScreenBox, PANE_HEIGHT_UNMEASURED } from "./labelPaneFrame.ts";
import { labelLook } from "./labelTap.ts";
import { PaneFailedFrame, PaneLoadingFrame } from "./PaneFrames.tsx";
import { builderSlot, labelPaneSlot } from "./store.ts";

const LabelPane = retryableLazy(() => import("./LabelPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts a label's edit pane, for the DM. The pane itself
 * loads only for a DM (design section 14.1). It closes on its own when it
 * no longer applies: its label is gone or on another scene, the tool or the
 * builder's mode moved on, or a token was tapped, whose bar takes its place.
 * In Isometric it stands by the label as the board shows it (`pick`,
 * docs/design-v1-isometric-view.md 6.2).
 */
export function LabelPaneHost(props: { scene: Scene; tool: string; camera: Camera; viewport: Size; insets: Insets; pick: BoardPick }) {
  const pane = useScoped(labelPaneSlot);
  const labelId = useStore(pane, (p) => p.labelId);
  const mode = useStore(useScoped(builderSlot).store, (b) => b.mode);
  const label = useRoomView((s) => (labelId ? s.view?.labels[labelId] : undefined));
  const tokenSelected = useRoomView((s) => s.local.selectedId !== null);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const open = labelId !== null && label !== undefined && label.sceneId === props.scene.id && !tokenSelected && labelPaneAllowed({ role, tool: props.tool, mode });
  const lane = useAlertsLane(props.viewport);
  useEffect(() => {
    if (labelId !== null && !open) pane.setState({ labelId: null });
  }, [labelId, open, pane]);
  if (!open || !label) return null;
  const close = () => pane.setState({ labelId: null });
  // While the pane's code downloads, and if it fails to, the shared notices take the box the pane will appear in, beside the fight's alerts as the pane will stand.
  const look = labelLook(props.pick, props.scene.id, label);
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box: labelScreenBox(label, props.camera, look), height: PANE_HEIGHT_UNMEASURED, lane });
  return (
    <LoadBoundary
      fallback={(f) => (
        <PaneFailedFrame place={place} close={close}>
          <RoomLoadNotice {...f} subject="The label editor" verb="load" compact reopen={{ tool: props.tool }} />
        </PaneFailedFrame>
      )}
    >
      <Suspense fallback={<PaneLoadingFrame text="Loading the label editor…" place={place} close={close} />}>
        <LabelPane label={label} camera={props.camera} look={look} viewport={props.viewport} insets={props.insets} onClose={close} />
      </Suspense>
    </LoadBoundary>
  );
}
