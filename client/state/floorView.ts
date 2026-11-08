import type { SceneId } from "#shared/model.ts";
import type { RoomView } from "./types.ts";

/** A room's view as the store holds it (RoomView.view), whole or cut to one floor. */
export type RoomViewState = NonNullable<RoomView["view"]>;

/**
 * The cut of the whole view that the board reads (docs/design/design-v1-floors.md
 * 10, D-261107-224): the floor-scoped collections (tokens, chunks, fog,
 * explored and sight tiles, labels, stamps, lights, pins, traps, templates,
 * drawings, the fog draft) cut to the floor shown, `sceneId`, and every
 * other part of `view` as it is. `prev` is the last cut, whose collections
 * it shares while they hold the same entries, so a layer that reads one
 * renders only when it changes.
 *
 * The contract's stand-in returns `view` itself, which is the cut on a
 * scene with one floor. FLR-D1 makes the cut.
 */
export function floorViewOf(view: RoomView["view"], _sceneId: SceneId | null, _prev?: RoomView["view"]): RoomView["view"] {
  return view;
}
