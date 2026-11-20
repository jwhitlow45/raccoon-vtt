import type { RoomState, SceneId } from "../model.ts";
import type { Join } from "./vision.ts";

/*
 * Sight and light through openings (docs/design/design-v1-floors.md phase 4,
 * 7): which openings join a floor to the next, read by vision.ts through
 * its VisionWorld (ruleHooks.ts), so vision.ts imports neither walls.ts nor
 * the stairs' rules.
 */

/**
 * The joins of a floor (7.1): each opening on it whose two floors both have
 * party vision on and that players both see (rules/floors.ts playersSee),
 * in id order. A blackout, a floor not reached, or a floor held only
 * through a creature the DM hid makes none. Until joins are built, none.
 */
export function openingJoins(_state: RoomState, _sceneId: SceneId): Join[] {
  return [];
}
