import { useLayoutEffect, useSyncExternalStore } from "react";
import { panelIsOpen, scenesFoldsSlot, type ScenesSection } from "../../lib/folds.ts";
import { scopeSlot, useScoped, type RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { PanelHow, RoomView } from "../../state/types.ts";
import { useRoomView, type RoomViewStore } from "../../state/view.ts";

/** The Scenes panel's id in the registry (features/panels.ts). */
export const SCENES_PANEL = "scenes";

/** What a press elsewhere asks Scenes to show: the scene's weather, or its own sound. */
export type SceneTarget = "weather" | "sound";

/** The settings group each target lives in (docs/design/design-v1-scenes-reorg.md 3): Light and weather, or Scene sound. */
export const SCENE_TARGET_GROUPS: Readonly<Record<SceneTarget, ScenesSection>> = { weather: "light", sound: "sound" };

/**
 * A request to show part of the settings of the scene in view
 * (docs/design/design-v1-scenes-reorg.md 7): the settings take it once, as they
 * draw or on a new `seq`, scroll its group into view and move focus there,
 * the Weather select for weather and Scene sound's fold for sound. `seq`
 * tells one press from the next, so a second press acts again.
 */
export type SceneRequest = { readonly target: SceneTarget | null; readonly seq: number };

export type SceneRequestStore = {
  get(): SceneRequest;
  subscribe(listener: () => void): () => void;
  /** Sets the target with a new `seq`. openSceneSettings's alone, which asks only with a scene in view. */
  ask(target: SceneTarget): void;
  /** The settings' part: the waiting target, cleared as it is read, so it acts once. Null when none waits. */
  take(): SceneTarget | null;
  /**
   * Room's part (useEndSceneRequestOnClose): whether Scenes is open. Its
   * change from open to closed clears a target no settings took, so it can
   * never act on a later opening the press did not ask for. A target asked
   * while Scenes is closed waits for the opening it asked for.
   */
  follow(open: boolean): void;
};

export function createSceneRequest(): SceneRequestStore {
  let state: SceneRequest = { target: null, seq: 0 };
  let wasOpen = false;
  const listeners = new Set<() => void>();
  const set = (next: SceneRequest) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ask(target) {
      set({ target, seq: state.seq + 1 });
    },
    take() {
      const { target } = state;
      if (target !== null) set({ target: null, seq: state.seq });
      return target;
    },
    follow(open) {
      const was = wasOpen;
      wasOpen = open;
      if (was && !open && state.target !== null) set({ target: null, seq: state.seq });
    },
  };
}

/** Per Room page (state/scope.ts), so a press in "view as a player" never reaches the DM's own Scenes. */
export const sceneRequestSlot = scopeSlot(() => createSceneRequest());

/** The request's `seq`, for the settings' layout effect to run on each new press. */
export function useSceneRequestSeq(): number {
  const request = useScoped(sceneRequestSlot);
  const read = () => request.get().seq;
  return useSyncExternalStore(request.subscribe, read, read);
}

/**
 * Whether the settings of the scene the DM is looking at draw: Scenes
 * draws them only for a scene in view that the room holds
 * (panels/ScenesPanel.tsx).
 */
export function sceneInView(room: Pick<RoomView, "sceneId" | "view">): boolean {
  return room.sceneId !== null && room.view?.scenes[room.sceneId] !== undefined;
}

/**
 * The one way into a scene's settings from elsewhere (7): Ambiance's
 * Weather row asks for weather, its Scene sound row for sound. With a scene
 * in view it reveals the target's group, open for now and never written
 * (lib/folds.ts), so a DM who folded it finds it folded again once Scenes
 * closes, and sets the target. Then it opens Scenes, by the panel the press
 * was in (`from`), so with two panels Scenes opens in the other pane.
 *
 * With no scene in view it only opens Scenes: no target and no reveal
 * (D-261102-934). The settings mount only for a scene in view, so a target
 * set then would wait, and the first scene the DM makes would scroll and
 * pull focus to its Weather select. `room` is the room's store, read at the
 * press.
 */
export function openSceneSettings(scope: RoomScope, ui: Pick<RoomUi, "openPanel">, target: SceneTarget, how: { from?: string | null; room: Pick<RoomViewStore, "getState"> }): void {
  if (sceneInView(how.room.getState())) {
    scope.get(scenesFoldsSlot).reveal(SCENE_TARGET_GROUPS[target]);
    scope.get(sceneRequestSlot).ask(target);
  }
  const opens: PanelHow | undefined = how.from ? { from: how.from } : undefined;
  ui.openPanel(SCENES_PANEL, opens);
}

/**
 * Room's part (7): clears a target no settings took when Scenes goes from
 * open to closed, beside Scenes' reveals (lib/folds.ts useEndRevealsOnClose),
 * and for the same reason in Room: the panel remounts when the layout
 * crosses 900 px. `wide` is Room's own.
 */
export function useEndSceneRequestOnClose(wide: boolean): void {
  const request = useScoped(sceneRequestSlot);
  const open = useRoomView((s) => panelIsOpen(s.local, SCENES_PANEL, wide));
  useLayoutEffect(() => request.follow(open), [request, open]);
}
