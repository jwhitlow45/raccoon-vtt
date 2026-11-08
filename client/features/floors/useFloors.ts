import { useEffect, useMemo, useRef } from "react";
import type { Scene } from "#shared/model.ts";
import { sayJoined } from "../view/choice.ts";
import { displayName } from "../../lib/scene.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { heldHere } from "./follow.ts";
import { followedLine, showingLine } from "./words.ts";

/*
 * What the floors controls read (docs/design/design-v1-floors.md 7.2, 7.3):
 * the floors this device holds of the scene projected, and the polite
 * status's line for each switch.
 */

/** The floors this device holds of the scene projected, bottom first: one or none on a scene of one floor. */
export function useHeldFloors(): readonly Scene[] {
  const scenes = useRoomView((s) => s.view?.scenes);
  const anchor = useRoomView((s) => s.projectedSceneId);
  return useMemo(() => (scenes ? heldHere({ scenes }, anchor) : []), [scenes, anchor]);
}

/** The floor shown, while this device holds more than one, else null. */
export function useShownFloor(): Scene | null {
  const held = useHeldFloors();
  const sceneId = useRoomView((s) => s.sceneId);
  return held.length > 1 ? (held.find((f) => f.id === sceneId) ?? null) : null;
}

/**
 * Says each switch of floors in the polite status (7.3), beside the view's
 * and the weather's lines (view/choice.ts sayJoined): "Showing Upper
 * floor.", or "Thorn is on Upper floor. Showing Upper floor." when the
 * device followed a creature there. The Room page's top bar and the table
 * display each run it, and the weather's own line joins it.
 */
export function useFloorVoice(): void {
  const scope = useRoomScope();
  const shift = useRoomView((s) => s.floorShift);
  const words = useRoomView((s) => {
    const floor = s.sceneId ? s.view?.scenes[s.sceneId]?.floor?.name : undefined;
    if (floor === undefined || !s.floorShift) return null;
    const token = s.floorShift.tokenId ? s.view?.tokens[s.floorShift.tokenId] : undefined;
    return token ? followedLine(displayName(token), floor) : showingLine(floor);
  });
  const heard = useRef(shift?.n ?? 0);
  useEffect(() => {
    if (!shift || shift.n === heard.current) return;
    heard.current = shift.n;
    if (words) sayJoined(scope, "floor", words);
  }, [scope, shift, words]);
}
