import type { RoomState } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { invalid, type Tx } from "./tx.ts";

/*
 * The floor ops (docs/design/design-v1-floors.md 9): the order of a scene's
 * floors and Show or Hide. Adding, renaming and removing floors ride
 * `scene.create`, `scene.update` and `scene.delete` (reducer/room.ts).
 */

/** Not built yet: the contract's stand-in, refused until the floors reducer lands. */
export const FLOORS_NOT_YET = "floors are not ready yet";

/** Reorders a scene's floors, bottom first, renumbering every level. */
export function floorOrder(_tx: Tx, _op: OpOf<"floor.order">): void {
  throw invalid(FLOORS_NOT_YET);
}

/** Shows a floor to players or hides it, its opened mark. */
export function floorOpen(_tx: Tx, _op: OpOf<"floor.open">): void {
  throw invalid(FLOORS_NOT_YET);
}

/**
 * The opened marks (9, D-261102-482), after every op's dispatch beside
 * `markPlayed`, as bookkeeping outside undo: the start floor whenever its
 * scene has floors, each floor of the players' scene where an unhidden
 * party member stands, then no mark on a scene that is gone or has no
 * `floor`. Nothing on a projected copy, which lacks what it reads.
 */
export function markOpened(_tx: Tx, _before: RoomState): void {}
