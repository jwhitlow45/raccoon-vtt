import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import type { BuildChunk, Scene, Trap } from "#shared/model.ts";
import type { PaneLaneBox } from "../../canvas/barDock.ts";
import { Loading } from "../../components/Loading.tsx";
import { LoadBoundary } from "../../components/LoadBoundary.tsx";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { theme } from "../../lib/theme.ts";
import { useAlertsLane } from "../../pages/fold.ts";
import { RoomLoadNotice } from "../../panels/Panels.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { panePlacement } from "../builder/labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { trapScreenBox } from "./paneBox.ts";
import { trapSlot } from "./store.ts";

const TrapPane = retryableLazy(() => import("./TrapPane.tsx"), { roles: ["dm"] });

const NO_CHUNKS: Readonly<Record<string, BuildChunk>> = {};

/**
 * Where the canvas mounts a trap's pane, for the DM (docs/design-v1-traps.md
 * 4.1), as it mounts a pin's: a bottom sheet on a map under 600 px wide, a
 * card beside the trap from 600 px. The pane loads only for a DM, and
 * closes on its own once it no longer applies: its trap is gone or on
 * another scene, or the Trap tool was put down. A selection stays, since
 * Set it off and the asks for rolls take the selected creatures, and no
 * token's bar shows while a tool takes the map's taps. While the map picks
 * something for the trap, the pane hides with its folds kept.
 */
export function TrapPaneHost(props: { scene: Scene; tool: string; camera: Camera; viewport: Size; insets: Insets }) {
  const store = useScoped(trapSlot).store;
  const paneId = useStore(store, (s) => s.paneId);
  const picking = useStore(store, (s) => s.picking !== null);
  const trap = useRoomView((s) => (paneId ? s.view?.traps[paneId] : undefined));
  const chunks = useRoomView((s) => s.view?.buildChunks ?? NO_CHUNKS);
  const open = paneId !== null && trap !== undefined && trap.sceneId === props.scene.id && props.tool === "trap";
  // The frames shown while the pane loads or failed to stand where the pane will, beside the fight's alerts.
  const lane = useAlertsLane(props.viewport);
  useEffect(() => {
    if (paneId !== null && !open) store.setState({ paneId: null, picking: null });
  }, [paneId, open, store]);
  if (!open || !trap) return null;
  return (
    <LoadBoundary
      fallback={(f) => (
        <div style={{ ...labelPaneFrame(panePlacement({ viewport: props.viewport, insets: props.insets, box: trapScreenBox(trap, chunks, props.camera), height: PANE_HEIGHT_UNMEASURED, lane })), padding: theme.space(3) }}>
          <RoomLoadNotice {...f} subject="The trap editor" verb="load" compact reopen={{ tool: props.tool }} />
        </div>
      )}
    >
      <Suspense fallback={<PaneLoading trap={trap} chunks={chunks} camera={props.camera} viewport={props.viewport} insets={props.insets} lane={lane} />}>
        <TrapPane trap={trap} hidden={picking} camera={props.camera} viewport={props.viewport} insets={props.insets} onClose={() => store.setState({ paneId: null })} />
      </Suspense>
    </LoadBoundary>
  );
}

/** While the pane's code downloads, the shared loading notice takes the box the pane will appear in. */
function PaneLoading(props: { trap: Trap; chunks: Readonly<Record<string, BuildChunk>>; camera: Camera; viewport: Size; insets: Insets; lane: PaneLaneBox | null }) {
  const place = panePlacement({ viewport: props.viewport, insets: props.insets, box: trapScreenBox(props.trap, props.chunks, props.camera), height: PANE_HEIGHT_UNMEASURED, lane: props.lane });
  // Even padding: the pane's slight top padding is for its header, which a loading notice does not have.
  return <Loading text="Loading the trap editor…" style={{ ...labelPaneFrame(place), padding: theme.space(3) }} />;
}
