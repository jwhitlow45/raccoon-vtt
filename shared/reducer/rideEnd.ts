import { keys } from "../keys.ts";
import type { OpOf } from "../protocol.ts";
import { ownEntry } from "../records.ts";
import type { Tx } from "./tx.ts";

/**
 * `sys.rideEnd`: each named area and kept ruler removed alone, as a
 * creature's delete removes them (tokens.ts deleteToken), so an ask that
 * named the area stays without it. One already gone is skipped: the op
 * replays as stored, and a later op in its batch may have removed one.
 */
export function sysRideEnd(tx: Tx, op: OpOf<"sys.rideEnd">): void {
  for (const id of op.templates) if (ownEntry(tx.state.templates, id)) tx.remove(keys.template(id));
  for (const id of op.drawings) if (ownEntry(tx.state.drawings, id)) tx.remove(keys.drawing(id));
}
