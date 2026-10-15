import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { Label, Scene } from "#shared/model.ts";
import { Loading } from "../../components/Loading.tsx";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { theme } from "../../lib/theme.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { labelPaneAllowed, panePlacement } from "./labelEdit.ts";
import { labelPaneFrame, labelScreenBox, PANE_HEIGHT_UNMEASURED } from "./labelPaneFrame.ts";
import { builderSlot, labelPaneSlot } from "./store.ts";

const LabelPane = retryableLazy(() => import("./LabelPane.tsx"), { roles: ["dm"] });

/**
 * Where the canvas mounts a label's edit pane, for the DM. The pane itself
 * loads only for a DM (design section 14.1). It closes on its own when it
 * no longer applies: its label is gone or on another scene, the tool or the
 * builder's mode moved on, or a token was tapped, whose bar takes its place.
 */
export function LabelPaneHost(props: { scene: Scene; tool: string; camera: Camera; viewport: Size; insets: Insets }) {
  const pane = useScoped(labelPaneSlot);
  const labelId = useStore(pane, (p) => p.labelId);
  const mode = useStore(useScoped(builderSlot).store, (b) => b.mode);
  const label = useRoomView((s) => (labelId ? s.view?.labels[labelId] : undefined));
  const tokenSelected = useRoomView((s) => s.local.selectedId !== null);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const open = labelId !== null && label !== undefined && label.sceneId === props.scene.id && !tokenSelected && labelPaneAllowed({ role, tool: props.tool, mode });
  useEffect(() => {
    if (labelId !== null && !open) pane.setState({ labelId: null });
  }, [labelId, open, pane]);
  if (!open || !label) return null;
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
          <RoomLoadNotice {...f} subject="The label editor" verb="load" compact reopen={{ tool: props.tool }} />
        </div>
      )}
    >
      <Suspense fallback={<PaneLoading label={label} camera={props.camera} viewport={props.viewport} insets={props.insets} />}>
        <LabelPane label={label} camera={props.camera} viewport={props.viewport} insets={props.insets} onClose={() => pane.setState({ labelId: null })} />
      </Suspense>
    </LoadBoundary>
  );
}

/** While the pane's code downloads, the shared loading notice takes the box the pane will appear in. */
function PaneLoading(props: { label: Label; camera: Camera; viewport: Size; insets: Insets }) {
  const box = labelScreenBox(props.label, props.camera);
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box, height: PANE_HEIGHT_UNMEASURED });
  // Even padding: the pane's slight top padding is for its header, which a loading notice does not have.
  return <Loading text="Loading the label editor…" style={{ ...labelPaneFrame(place), padding: theme.space(3) }} />;
}
