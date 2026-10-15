import { useCallback, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { Stamp } from "#shared/model.ts";
import { useAssets, useRoomView } from "../../../state/view.ts";
import { drawStamps, stampUrl } from "./draw.ts";
import { sceneStamps } from "./rules.ts";
import { useStampStore } from "./store.ts";

const EMPTY: Record<string, Stamp> = {};

/**
 * The scene's stamps as a drawing function for the build's board
 * (BuilderLayer.tsx), which runs it over its floor and under its walls, or
 * null when the scene has none. A stamp the DM is moving, turning or
 * resizing draws where the gesture has it, and a DM sees DM-only stamps
 * dimmed. The function changes when the stamps do and when an image they
 * wait on comes in, which redraws the board.
 */
export function useStampDrawing(sceneId: string, role: "dm" | "player"): ((g: CanvasRenderingContext2D) => void) | null {
  const all = useRoomView((s) => s.view?.stamps ?? EMPTY);
  const preview = useStore(useStampStore(), (s) => s.preview);
  const assets = useAssets();
  const [loads, setLoads] = useState(0);
  const onLoad = useCallback(() => setLoads((n) => n + 1), []);
  const stamps = useMemo(() => {
    const list = sceneStamps(all, sceneId);
    if (!preview) return list;
    return list.map((s) => (s.id === preview.id ? { ...s, ...preview.pose } : s));
  }, [all, sceneId, preview]);
  return useMemo(() => {
    if (stamps.length === 0) return null;
    const urlOf = (art: Stamp["art"]) => stampUrl(art, assets);
    // `loads` only marks that an image came in, so the board draws again with it.
    void loads;
    const dimHidden = role === "dm";
    return (g: CanvasRenderingContext2D) => drawStamps(g, stamps, { urlOf, onLoad, dimHidden });
  }, [stamps, assets, onLoad, loads, role]);
}
