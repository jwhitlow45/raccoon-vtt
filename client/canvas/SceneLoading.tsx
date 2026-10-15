import { useMemo } from "react";
import { useStore } from "zustand";
import { Spinner, useDelayed } from "../components/Loading.tsx";
import { Notice } from "../components/Notice.tsx";
import type { Insets } from "../lib/camera.ts";
import { theme } from "../lib/theme.ts";
import { sceneLoadView, type SceneLoadNotice } from "../state/sceneLoad.ts";
import { useRoomView } from "../state/view.ts";
import { useMapProgressStore } from "./mapProgress.ts";

/**
 * Which scene is loading and what to say about it (state/sceneLoad.ts), or
 * null. The Scenes panel marks that scene's row with it too, since a phone's
 * sheet can cover the middle of the map.
 */
export function useSceneLoading(): SceneLoadNotice | null {
  const load = useRoomView((s) => s.sceneLoad);
  const sceneId = useRoomView((s) => s.sceneId);
  const scenes = useRoomView((s) => s.view?.scenes);
  const progress = useStore(useMapProgressStore(), (s) => s.progress);
  return useMemo(() => {
    const scene = sceneId ? scenes?.[sceneId] : undefined;
    const shown = scene ? { id: scene.id, name: scene.name, mapAssetId: scene.map?.assetId ?? null } : null;
    return sceneLoadView({ load, shown, map: progress, nameOf: (id) => scenes?.[id]?.name });
  }, [load, sceneId, scenes, progress]);
}

/**
 * Over the canvas while a scene loads: the scene on screen stays in view,
 * dimmed with the light scrim, under a spinner and "Loading Crypt…" in an
 * info Notice. It takes no input, so the bars, the panels and the map
 * itself keep working, and it appears only after a short delay, so a
 * quick switch does not flash it.
 */
export function SceneLoadingOverlay(props: { insets: Insets }) {
  const notice = useSceneLoading();
  const shown = useDelayed(notice !== null);
  if (!notice || !shown) return null;
  const { top, bottom } = props.insets;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: theme.z.pane,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: `${top}px ${theme.space(4)}px ${bottom}px`,
        background: theme.color.scrimLight,
        pointerEvents: "none",
      }}
    >
      <Notice role="status" float leading={<Spinner size={theme.icon.md} />} style={{ maxWidth: "100%" }}>
        <span style={{ display: "block", minWidth: 0, overflowWrap: "anywhere" }}>
          <span style={{ display: "block", fontWeight: theme.weight.strong }}>{notice.text}</span>
          {notice.detail ? <span style={{ display: "block", color: theme.color.textMuted, fontSize: theme.font.small }}>{notice.detail}</span> : null}
        </span>
      </Notice>
    </div>
  );
}
