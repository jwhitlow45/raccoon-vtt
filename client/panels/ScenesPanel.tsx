import { useMemo } from "react";
import { Group } from "../components/Panel.tsx";
import type { PanelProps } from "../features/panels.ts";
import { NewScene } from "../features/scenes/NewScene.tsx";
import { SceneList } from "../features/scenes/SceneList.tsx";
import { SceneSettings } from "../features/scenes/SceneSettings.tsx";
import { useSceneFolds } from "../features/scenes/settingsFolds.ts";
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
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const viewingId = useRoomView((s) => s.sceneId);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const fold = useSceneFolds();
  const list = useMemo(() => Object.values(scenes ?? {}).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)), [scenes]);
  if (role !== "dm") return null;
  const current = list.find((s) => s.id === viewingId);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <SceneList scenes={list} viewingId={viewingId} playerSceneId={playerSceneId} />
      <Group label="New scene" reserve="icon" {...fold("new")} keep>
        <NewScene sceneCount={list.length} close={props.close} />
        <UvttNewScene sceneCount={list.length} />
      </Group>
      {current ? <SceneSettings key={current.id} scene={current} others={list.filter((s) => s.id !== current.id)} close={props.close} /> : null}
    </div>
  );
}
