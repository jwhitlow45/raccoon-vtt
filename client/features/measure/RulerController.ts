import type Konva from "konva";
import { useEffect } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { ControllerProps } from "../layers.ts";

/** This device's own token drag as the ruler layer measures it: the pressed token and where Konva holds it now, in cells, not snapped. */
export type LocalMeasure = { tokenId: string; x: number; y: number } | null;

export const localMeasureSlot = scopeSlot((): StoreApi<{ drag: LocalMeasure }> => createStore(() => ({ drag: null as LocalMeasure })));

/**
 * Konva moves a dragged token's node without a React render, and the
 * canvas sends no local echo of drags, so the ruler layer (RulerLayer.tsx)
 * learns where this device's own drag is from the stage's drag events,
 * which bubble up from the token's group (named "token", with the token's
 * id). This listens on the stage on screen, as one of the board's
 * controllers (features/layers.ts CONTROLLERS), mounted once outside both
 * drawing trees, so one listener writes one store whichever view shows
 * (docs/design-v1-isometric-view.md 5.1).
 */
export function RulerController(props: ControllerProps): null {
  const store = useScoped(localMeasureSlot);
  useLocalDrag(props.stage, store);
  return null;
}

function useLocalDrag(stage: Konva.Stage | null, store: StoreApi<{ drag: LocalMeasure }>): void {
  useEffect(() => {
    if (!stage) return;
    const onMove = (e: Konva.KonvaEventObject<DragEvent>) => {
      const node = e.target;
      if (node.name() !== "token") return;
      store.setState({ drag: { tokenId: node.id(), x: node.x(), y: node.y() } });
    };
    const onEnd = () => store.setState({ drag: null });
    stage.on("dragmove.rulerlayer", onMove);
    stage.on("dragend.rulerlayer", onEnd);
    return () => {
      stage.off("dragmove.rulerlayer");
      stage.off("dragend.rulerlayer");
      // A stage that goes mid-drag ends that drag for the ruler too.
      store.setState({ drag: null });
    };
  }, [stage, store]);
}
