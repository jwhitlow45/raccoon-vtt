import type { RoomState } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { invalid, type Tx } from "./tx.ts";

/*
 * Stairs and ladders between floors (docs/design/design-v1-floors.md phase
 * 2, 3): placing, changing and removing a pair, a creature's climb, and the
 * pairs that go with their floors.
 */

/** `floorLink.put`: both ends of stairs or a ladder. FL2-A's reducer commit builds it. */
export function floorLinkPut(_tx: Tx, _op: OpOf<"floorLink.put">): void {
  throw invalid("stairs and ladders are not built yet");
}

/** `floorLink.update`: both ends' kind or lock. FL2-A's reducer commit builds it. */
export function floorLinkUpdate(_tx: Tx, _op: OpOf<"floorLink.update">): void {
  throw invalid("stairs and ladders are not built yet");
}

/** `floorLink.delete`: both ends. FL2-A's reducer commit builds it. */
export function floorLinkDelete(_tx: Tx, _op: OpOf<"floorLink.delete">): void {
  throw invalid("stairs and ladders are not built yet");
}

/** `token.climb`: Go up or Go down. FL2-A's reducer commit builds it. */
export function tokenClimb(_tx: Tx, _op: OpOf<"token.climb">): void {
  throw invalid("stairs and ladders are not built yet");
}

/** The ends whose floor or far floor stopped being a floor of one scene in this op, after every op's dispatch. FL2-A's reducer commit builds it. */
export function dropFloorLinks(_tx: Tx, _before: RoomState): void {}
