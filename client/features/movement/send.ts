import type { ClientOp } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { heldText, moveOpsOf, type DropPlan } from "./drop.ts";
import type { StopNote } from "./teleport.ts";

/** What sending a drop needs from the room and the page. */
export type SendDeps = {
  dispatch(op: ClientOp, opts?: { group?: string }): number | null;
  newId(): string;
  /** Shows the note after a stopped walk. */
  note(note: StopNote): void;
  notify(text: string): void;
  /** Opens or closes the selection's action bar. The selection stays either way. */
  showActions(open: boolean): void;
};

/**
 * Sends a drop's moves as one undo step, and says what stopped any of them
 * (docs/design-v1-maps-vision.md 4.1).
 *
 * A stopped walk's note, with "Teleport here", wins over the token's action
 * bar (the owner's decision in the wave 4 review, W4-O-1). On a phone a
 * player taps their token and then drags it, so the bar would come back
 * over the map on the drop, and the note steps aside for an open bar
 * (StopNote.tsx). So the drop closes the bar and keeps the selection: a tap
 * on the token opens the bar again, and the note steps aside for it.
 *
 * Returns the `n` of each op it sent, so the canvas knows how many answers
 * to wait for (canvas/dragNotes.ts watchDrop).
 */
export function sendPlan(plan: DropPlan, deps: SendDeps): number[] {
  const sent = dispatchGesture(deps, moveOpsOf(plan.moves));
  if (plan.stop) {
    // A walk stopped at its first step sent nothing, so its teleport has no walk to take back.
    const n = plan.moves.length === 1 ? (sent[0] ?? null) : null;
    deps.note({ ...plan.stop, n });
    deps.showActions(false);
  }
  const text = heldText(plan.held.map((h) => ({ name: displayName({ name: h.token.name ?? "A token", number: h.token.number }), blocker: h.blocker })));
  if (text) deps.notify(text);
  return sent;
}
