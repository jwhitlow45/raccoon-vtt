import type { ClientOp } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { CUT_TEXT, heldText, moveOpsOf, type DropPlan } from "./drop.ts";
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
 * A lone walk stopped at its first step on a scene with fog on sends the
 * move the player asked for (DropPlan `intended`,
 * docs/design-v1-map-discovery.md 5.2): the server lands it by the real
 * build, at the start where the wall stands, so the device never withholds
 * a walk that only the pieces it holds seemed to stop.
 *
 * Returns the `n` of each op it sent, so the canvas knows how many answers
 * to wait for (canvas/dragNotes.ts watchDrop).
 */
export function sendPlan(plan: DropPlan, deps: SendDeps): number[] {
  const moves = plan.moves.length === 0 && plan.intended ? [plan.intended] : plan.moves;
  const sent = dispatchGesture(deps, moveOpsOf(moves));
  if (plan.stop) {
    // A walk stopped at its first step that sent nothing has no walk for its teleport to take back.
    const n = moves.length === 1 ? (sent[0] ?? null) : null;
    deps.note({ ...plan.stop, n });
    deps.showActions(false);
  }
  const text = heldText(plan.held.map((h) => ({ name: displayName({ name: h.token.name ?? "A token", number: h.token.number }), blocker: h.blocker })));
  if (text) deps.notify(text);
  if (plan.cut) deps.notify(CUT_TEXT);
  return sent;
}
