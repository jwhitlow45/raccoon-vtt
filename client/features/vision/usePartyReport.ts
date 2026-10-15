import { useMemo } from "react";
import type { RoomState } from "#shared/model.ts";
import { useRoomView } from "../../state/view.ts";
import { partyReport, type SourceRow } from "./sources.ts";

const NONE: { rows: SourceRow[]; overCap: number } = { rows: [], overCap: 0 };

/**
 * The party report for a scene from the DM's view, or nothing when `on` is
 * false (a player, or a scene without vision). It reads only the slices the
 * report depends on, so it is worked out again when a creature, a light, the
 * build or the scene changes, not on every edit elsewhere in the room.
 */
export function usePartyReport(sceneId: string, on: boolean): { rows: SourceRow[]; overCap: number } {
  const tokens = useRoomView((s) => (on ? s.view?.tokens : undefined));
  const characters = useRoomView((s) => (on ? s.view?.characters : undefined));
  const buildChunks = useRoomView((s) => (on ? s.view?.buildChunks : undefined));
  const lights = useRoomView((s) => (on ? s.view?.lights : undefined));
  const scene = useRoomView((s) => (on ? s.view?.scenes[sceneId] : undefined));
  const meta = useRoomView((s) => (on ? s.view?.meta : undefined));
  return useMemo(() => {
    if (!tokens || !characters || !scene || !meta) return NONE;
    // The DM's projection holds every field the report reads, in the stored shape.
    const state = { meta, scenes: { [sceneId]: scene }, tokens, characters, buildChunks: buildChunks ?? {}, lights: lights ?? {} } as unknown as RoomState;
    return partyReport(state, sceneId);
  }, [tokens, characters, buildChunks, lights, scene, meta, sceneId]);
}
