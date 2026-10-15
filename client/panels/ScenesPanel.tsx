import { useMemo } from "react";
import { Section } from "../components/Panel.tsx";
import type { PanelProps } from "../features/panels.ts";
import { NewScene } from "../features/scenes/NewScene.tsx";
import { SceneList } from "../features/scenes/SceneList.tsx";
import { SceneSettings } from "../features/scenes/SceneSettings.tsx";
import { UvttNewScene } from "../features/uvtt/UvttImport.tsx";
import { useRoomView } from "../state/view.ts";

/**
 * The DM's scenes (design sections 5, 12 and 13): switch the DM's view, move
 * the players, create and arrange scenes, and edit the one on screen.
 * Players never load this panel. Their projection holds only the player
 * scene, so there is nothing for them to pick.
 *
 * It is a run of sections (components/Panel.tsx): all scenes, a new one,
 * then the scene on screen's settings, each under its own label.
 */
export default function ScenesPanel(props: PanelProps) {
  const scenes = useRoomView((s) => s.view?.scenes);
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const viewingId = useRoomView((s) => s.sceneId);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const list = useMemo(() => Object.values(scenes ?? {}).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)), [scenes]);
  if (role !== "dm") return null;
  const current = list.find((s) => s.id === viewingId);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <SceneList scenes={list} viewingId={viewingId} playerSceneId={playerSceneId} />
      <Section label="New scene">
        <NewScene sceneCount={list.length} close={props.close} />
        <UvttNewScene sceneCount={list.length} />
      </Section>
      {current ? <SceneSettings key={current.id} scene={current} others={list.filter((s) => s.id !== current.id)} close={props.close} /> : null}
    </div>
  );
}
