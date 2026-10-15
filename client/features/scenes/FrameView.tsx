import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Button } from "../../components/Button.tsx";
import { Notice } from "../../components/Notice.tsx";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { viewFromCamera } from "./create.ts";
import { currentStageCamera } from "./stageCamera.ts";

/**
 * Saving a scene's starting view from a phone (UD-23). The Scenes sheet
 * covers most of the map, so "Save current view" there saved a view the
 * DM could not see. Instead the sheet closes and this bar asks the DM to
 * frame the map, with the whole map in sight, and then save it.
 */
export const frameViewSlot = scopeSlot(() => createStore<{ sceneId: string | null }>(() => ({ sceneId: null })));

/** Starts framing the starting view of this scene. */
export function useStartFraming(): (sceneId: string) => void {
  const store = useScoped(frameViewSlot);
  return (sceneId) => store.setState({ sceneId });
}

/** The bar under the top bar while the DM frames a starting view, a floating Notice. Mounted once by the Room page. */
export function FrameViewBar() {
  const store = useScoped(frameViewSlot);
  const framing = useStore(store, (s) => s.sceneId);
  const sceneId = useRoomView((s) => s.sceneId);
  const scope = useRoomScope();
  const actions = useRoomActions();
  const ui = useRoomUi();
  // Switching scenes, or losing the DM role, ends it.
  if (!framing || framing !== sceneId) return null;
  const stop = () => store.setState({ sceneId: null });
  const save = () => {
    const live = currentStageCamera(scope);
    if (live) {
      actions.dispatch({ t: "scene.update", sceneId: framing, patch: { defaultView: viewFromCamera(live.camera, live.viewport) } });
      ui.notify("Starting view saved.");
    }
    stop();
  };
  return (
    <div role="group" aria-label="Starting view" style={{ pointerEvents: "auto", width: "100%", maxWidth: 520 }}>
      <Notice float>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <span style={{ flex: "1 1 100%" }}>Frame the map as players should first see it, then save.</span>
          <Button size="sm" onClick={stop}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={save}>
            Save view
          </Button>
        </div>
      </Notice>
    </div>
  );
}
