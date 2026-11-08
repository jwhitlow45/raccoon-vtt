import { useCallback, useMemo, useState } from "react";
import type { Scene } from "#shared/model.ts";
import { mainFloorId, sameScene } from "#shared/rules/floors.ts";
import { Group } from "../components/Panel.tsx";
import type { PanelProps } from "../features/panels.ts";
import { NewScene } from "../features/scenes/NewScene.tsx";
import { SceneList } from "../features/scenes/SceneList.tsx";
import { SceneSettings } from "../features/scenes/SceneSettings.tsx";
import { useSceneFolds } from "../features/scenes/settingsFolds.ts";
import { recordId, useRouteRequest } from "../features/search/route.ts";
import { UvttNewScene } from "../features/uvtt/UvttImport.tsx";
import { useRoomView } from "../state/view.ts";

/**
 * The DM's scenes (design sections 5, 12 and 13): switch the DM's view, move
 * the players, create and arrange scenes, and edit the one on screen.
 * Players never load this panel. Their projection holds only the player
 * scene, so there is nothing for them to pick.
 *
 * It is a run of sections and groups (components/Panel.tsx): all scenes,
 * then New scene, a group that folds as the settings' setup groups do,
 * folded on a phone and open from 900 px, and open while the room has no
 * scene (lib/folds.ts SCENES_FOLDS), then the scene on screen's settings.
 * New scene wears no icon, since none of the set reads as a new scene and
 * `plus` read as an Add button, so it keeps the icon's space and its name
 * lines up with the groups under it (docs/design/design-v1-panel-groups.md
 * 6.2). It stays mounted while folded, so a map upload in its form, or a
 * picture a paste hands it, is never cut short.
 */
export default function ScenesPanel(props: PanelProps) {
  const scenes = useRoomView((s) => s.view?.scenes);
  const startId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const shownId = useRoomView((s) => s.sceneId);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const fold = useSceneFolds();
  /*
   * A scene is one row, by its main floor (docs/design/design-v1-floors.md 7.1,
   * D-261107-225): "you are here" and "players here" hold on any floor of
   * it, while the settings under the list set the floor shown, `shownId`.
   */
  const list = useMemo(
    () =>
      Object.values(scenes ?? {})
        .filter((s) => s.floor === undefined || s.floor.of === s.id)
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)),
    [scenes],
  );
  const viewingId = useMemo(() => (shownId && scenes ? mainFloorId({ scenes }, shownId) : null), [scenes, shownId]);
  const playerSceneId = useMemo(() => (startId && scenes ? mainFloorId({ scenes }, startId) : null), [scenes, startId]);
  /** Move players here starts them on the floor the DM shows, or on the main floor of a scene the DM is not on. */
  const moveTarget = useCallback(
    (row: Scene): Scene => {
      const shown = shownId && scenes ? scenes[shownId] : undefined;
      return shown && scenes && sameScene({ scenes }, shown.id, row.id) ? shown : row;
    },
    [scenes, shownId],
  );
  /*
   * The search's route to a scene (features/search/route.ts) opens Scenes
   * at its row, never moving the DM's view or the players, and opens the
   * row's folder for now if this device folded it.
   */
  const [shownFolder, setShownFolder] = useState<string | null>(null);
  // A control on a floor's page (scenes.floor.*, not the Floors group's own) needs the page open to land on.
  const [floorsAsk, setFloorsAsk] = useState(0);
  useRouteRequest("scenes", (request) => {
    const id = recordId("scene", request.page);
    setShownFolder((id !== null ? scenes?.[id]?.folder : undefined) ?? null);
    if (request.anchor?.startsWith("scenes.floor.")) setFloorsAsk((n) => n + 1);
  });
  if (role !== "dm") return null;
  const current = shownId ? scenes?.[shownId] : undefined;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <SceneList scenes={list} viewingId={viewingId} playerSceneId={playerSceneId} moveTarget={moveTarget} shownFolder={shownFolder} onShownFolderTap={() => setShownFolder(null)} />
      <Group label="New scene" reserve="icon" search="scenes.new" {...fold("new")} keep>
        <NewScene sceneCount={list.length} close={props.close} />
        <UvttNewScene sceneCount={list.length} />
      </Group>
      {current ? <SceneSettings key={viewingId ?? current.id} scene={current} others={list.filter((s) => s.id !== viewingId)} close={props.close} floorsAsk={floorsAsk} /> : null}
    </div>
  );
}
