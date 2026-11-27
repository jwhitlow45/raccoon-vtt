import type { RoomState, Scene } from "#shared/model.ts";
import { useViewerFog } from "../../canvas/viewerFog.ts";
import { useRoomView } from "../../state/view.ts";
import { caughtTokens, contextFrom, type DeviceAreaContext } from "./coverage.ts";
import { useLiveGround } from "./liveGround.ts";
import { samplesNow } from "./store.ts";
import { useAreaThrough } from "./through.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

const EMPTY: RoomState["templates"] = {};

/** Who the areas on the scene in view catch now, as this viewer reads them. Null before the room and its scene are known. */
export type AreaCatch = {
  scene: Scene;
  ctx: DeviceAreaContext;
  through: ReturnType<typeof useAreaThrough>;
  tokens: ReturnType<typeof useLiveTokens>["tokens"];
  /** The creatures an area catches now, across its openings, which an area's group save takes its rows from until the roll. */
  caught(templateId: string): string[];
};

/**
 * Who an area catches, kept live as tokens move, here or on another device:
 * a player's read only the walls they could know (coverage.ts heldWalls)
 * and only creatures whose rays lie on their live ground (coverage.ts
 * raysLive), and every viewer's reach across the openings on its floor
 * (through.ts), by the gate every device reads alike. The Areas panel lists
 * an area's creatures from it, and an area's group save takes its rows
 * from it wherever the save shows: in Areas, or in Dice while Areas hides
 * on this device (docs/design/design-v1-features.md 8, D-261127-305).
 */
export function useAreaCatch(): AreaCatch | null {
  const view = useRoomView((s) => s.floorView);
  const sceneId = useRoomView((s) => s.sceneId);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const templates = useRoomView((s) => s.floorView?.templates ?? EMPTY);
  const live = useLiveTokens();
  const scene = sceneId ? view?.scenes[sceneId] : undefined;
  const fog = useViewerFog({ scene, role, fog: scene?.fogEnabled !== false });
  const ground = useLiveGround(scene, role);
  const through = useAreaThrough(role);
  if (!view || !scene) return null;
  const ctx = contextFrom({ tokens: live.tokens, buildChunks: view.buildChunks, settings: view.meta.settings, live: ground }, scene, samplesNow(live.moving), fog);
  return {
    scene,
    ctx,
    through,
    tokens: live.tokens,
    caught: (templateId) => {
      const t = templates[templateId];
      return t ? caughtTokens(t, ctx, t.sceneId, through(t.sceneId)) : [];
    },
  };
}
