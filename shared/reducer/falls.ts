import type { FallId, FallRecord, RoomState, SceneId, TokenId } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { invalid, type Refuse, type Tx } from "./tx.ts";

/*
 * Falls through openings between floors (docs/design/design-v1-floors.md
 * phase 4, 4): the fall pass that runs from op version 64 (opensOps), the
 * cards it writes, and their settling by Dismiss or by a group save's
 * outcome. Until each piece is built, an op that reaches it is refused and
 * the passes throw, so a room behaves as before.
 */

/** The words of an op that names an opening, a trapdoor, a hidden or moved end, or a fall card, before its rule is built. */
export function notBuiltWords(what: string): string {
  return `${what} is not built yet`;
}

/** The refusal in those words. */
export function notBuilt(what: string): Refuse {
  return invalid(notBuiltWords(what));
}

/**
 * A creature's landing in the op (4.3 steps 5 to 11): a climb's or a
 * flight's, a trapdoor's drop or a fall's, intermediate ones included.
 * The arrival step reads each creature's last, `markOpened` and the
 * landing reminders read them all.
 */
export type Landing = { tokenId: TokenId; sceneId: SceneId; how: "climb" | "flight" | "drop" | "fall" };

/**
 * The fall pass (4.1, 4.3 step 5): each candidate on the ground whose
 * space lies wholly inside an opening's upper end, held up by nothing by
 * 4.1's rule, falls to the floor below (reducer/floorLinks.ts landThrough)
 * with a card. Each landing joins `landings`, and the pass returns one
 * record a root that fell. Never for a create, an undo, a redo, a
 * `sys.restore`, or on a projected copy.
 */
export function fallPass(_tx: Tx, _before: RoomState, _candidates: ReadonlySet<TokenId>, _landings: Landing[]): FallRecord[] {
  throw new Error("not built: fallPass");
}

/** `fall.settle` (4.4): the DM's Dismiss of a fall card. */
export function fallSettle(_tx: Tx, _op: OpOf<"fall.settle">): void {
  throw notBuilt("Dismissing a fall");
}

/** The card a group save's outcome settles (`actor.outcome`'s `fall`, 4.4), removed in the same op. */
export function settleFallCard(_tx: Tx, _fallId: FallId): void {
  throw notBuilt("Applying a fall");
}
