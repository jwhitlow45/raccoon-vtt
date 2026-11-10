import type { SceneVision } from "../model.ts";

/**
 * A scene's vision after a patch (docs/design/design-v1-per-player-vision.md 6.7):
 * the patch's, keeping the scene's `perPlayer` when the patch names none,
 * and stored only while true. A whole-party scene's is the patch's as sent.
 * `byClock` keeps the same way, so Players see's patches leave Time of day
 * on (docs/design/design-v1-calendar-c2c3.md 6.2). The level is stored as sent:
 * the daylight pass reads the time.
 *
 * Its own module, since a scene's settings (room.ts) and a new floor's
 * own settings (floors.ts) both apply it, and room.ts imports floors.ts.
 */
export function patchedVision(
  was: SceneVision | undefined,
  patch: { on: boolean; light: SceneVision["light"]; perPlayer?: boolean; byClock?: boolean },
): SceneVision {
  const { perPlayer, byClock, ...rest } = patch;
  return {
    ...rest,
    ...((perPlayer ?? was?.perPlayer === true) ? { perPlayer: true as const } : {}),
    ...((byClock ?? was?.byClock === true) ? { byClock: true as const } : {}),
  };
}
