import { scenesFoldsSlot, type ScenesSection } from "../../lib/folds.ts";
import type { RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { PanelHow, RoomView } from "../../state/types.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { SCENES_PANEL } from "./ids.ts";

/*
 * What is left of the way into a scene's settings from elsewhere
 * (docs/design/design-v1-scenes-reorg.md 7) once the request that scrolled
 * a group into view and focused it went with Ambiance's rows
 * (docs/design/design-v1-sound-layout.md 6.2). Its one caller is the Sound
 * panel's Scene sound row (features/sound/panel/NowPlaying.tsx). That row
 * goes too (6.2), and this file with it.
 */

/** What a press elsewhere asks Scenes to show: the scene's weather, or its own sound. */
export type SceneTarget = "weather" | "sound";

/** The settings group each target lives in (docs/design/design-v1-scenes-reorg.md 3): Light and weather, or Scene sound. */
export const SCENE_TARGET_GROUPS: Readonly<Record<SceneTarget, ScenesSection>> = { weather: "light", sound: "sound" };

/**
 * Whether the settings of the scene the DM is looking at draw: Scenes
 * draws them only for a scene in view that the room holds
 * (panels/ScenesPanel.tsx).
 */
export function sceneInView(room: Pick<RoomView, "sceneId" | "view">): boolean {
  return room.sceneId !== null && room.view?.scenes[room.sceneId] !== undefined;
}

/**
 * Opens Scenes by the panel the press was in (`from`), so with two panels
 * it opens in the other pane. With a scene in view the target's group is
 * revealed first, open for now and never written (lib/folds.ts), so a DM
 * who folded it finds it folded again once Scenes closes. With no scene in
 * view nothing is revealed (D-261102-934): the settings mount only for a
 * scene in view, so a reveal then would wait for the first scene the DM
 * makes. `room` is the room's store, read at the press.
 */
export function openSceneSettings(scope: RoomScope, ui: Pick<RoomUi, "openPanel">, target: SceneTarget, how: { from?: string | null; room: Pick<RoomViewStore, "getState"> }): void {
  if (sceneInView(how.room.getState())) scope.get(scenesFoldsSlot).reveal(SCENE_TARGET_GROUPS[target]);
  const opens: PanelHow | undefined = how.from ? { from: how.from } : undefined;
  ui.openPanel(SCENES_PANEL, opens);
}
