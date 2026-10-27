import type { ClientOp } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";
import type { OnAnswer } from "../../state/types.ts";
import { CUT_TEXT, GROUP_BLOCKED_TEXT, heldText, moveOpsOf, type DropPlan, type Point } from "./drop.ts";
import type { StopNote } from "./teleport.ts";

/** What sending a drop needs from the room and the page. */
export type SendDeps = {
  dispatch(op: ClientOp, opts?: { group?: string; onAnswer?: OnAnswer }): number | null;
  newId(): string;
  /** Shows the note after a stopped walk. */
  note(note: StopNote): void;
  /** The note shown now, which a walk's answer may change. */
  shownNote(): StopNote | null;
  /**
   * Where a token stands in the copy the server confirmed, which holds a
   * walk's answer once it is answered. Never the predicted view, where a
   * later walk still on its way may already stand.
   */
  standing(tokenId: string): (Point & { sceneId: string }) | null;
  /**
   * The `n` of the newest walk this device sent of each token, kept by
   * sendPlan for as long as these deps live, so an answer is heard only by
   * the walk it answers and one overtaken by a later walk is dropped.
   */
  attempts: Map<string, number>;
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
 * A walk stopped at its first step sends nothing (D-261027-05): the
 * device's gate stops it only where the exact wall surely does
 * (docs/design-v1-map-discovery.md 5.2), so the token never leaves its
 * square and the note keeps the words the device worked out.
 *
 * The server lands a walk the real build stops short where the player's
 * device let it go, as into the dark, and says it was `blocked` (6): the
 * walk then gets the note at the spot it landed, naming no kind
 * ("Something blocks the way."), and its teleport takes that walk back. A
 * note the device already showed for the walk stays when the walk landed
 * where it said. A group's blocked move says only that some stopped short.
 * An answer counts only for the newest walk of its token: one that a later
 * walk overtook says nothing, since where it landed is no longer known.
 *
 * Returns the `n` of each op it sent, so the canvas knows how many answers
 * to wait for (canvas/dragNotes.ts watchDrop).
 */
export function sendPlan(plan: DropPlan, deps: SendDeps): number[] {
  const ops = moveOpsOf(plan.moves);
  // A lone op is one step anyway, so only a gesture of several ops takes a group (state/actions.ts dispatchGesture).
  const group = ops.length > 1 ? deps.newId() : undefined;
  const sent: number[] = [];
  // An answer heard before its dispatch returned waits for the note this plan shows.
  const early: (() => void)[] = [];
  let sending = true;
  for (const op of ops) {
    let n: number | null = null;
    const onAnswer: OnAnswer = (answer, _refusal, _unknown, _stamped, blocked) => {
      const run = () => {
        if (n === null) return;
        if (answer === "taken" && blocked) heardBlocked(op, n, deps);
        else if (answer === "refused") walkRefused(n, deps);
      };
      if (sending) early.push(run);
      else run();
    };
    n = deps.dispatch(op, { ...(group !== undefined ? { group } : {}), onAnswer });
    if (n === null) continue;
    sent.push(n);
    for (const tokenId of movedBy(op)) deps.attempts.set(tokenId, n);
  }
  if (plan.stop) {
    // A walk stopped at its first step that sent nothing has no walk for its teleport to take back.
    const n = plan.moves.length === 1 ? (sent[0] ?? null) : null;
    deps.note({ ...plan.stop, n });
    deps.showActions(false);
  }
  const text = heldText(plan.held.map((h) => ({ name: displayName({ name: h.token.name ?? "A token", number: h.token.number }), blocker: h.blocker })));
  if (text) deps.notify(text);
  if (plan.cut) deps.notify(CUT_TEXT);
  sending = false;
  for (const run of early) run();
  return sent;
}

/** The tokens a move op walks. */
function movedBy(op: ClientOp): string[] {
  if (op.t === "token.move") return [op.tokenId];
  if (op.t === "token.moveMany") return op.moves.map((m) => m.tokenId);
  return [];
}

/** A walk the server landed short of where this device let it go (`blocked`): its note, at the spot it landed. */
function heardBlocked(op: ClientOp, n: number, deps: SendDeps): void {
  // Overtaken by a later walk of the token, whose own answer says where it stands.
  const current = movedBy(op).filter((tokenId) => deps.attempts.get(tokenId) === n);
  if (current.length === 0) return;
  if (op.t === "token.moveMany") {
    deps.notify(GROUP_BLOCKED_TEXT);
    return;
  }
  if (op.t !== "token.move") return;
  const now = deps.standing(op.tokenId);
  if (!now) return;
  const shown = deps.shownNote();
  const ours = shown !== null && shown.n === n ? shown : null;
  if (ours && ours.sceneId === now.sceneId && ours.at.x === now.x && ours.at.y === now.y) return;
  const ghost = ours ? ours.ghost : { x: op.x, y: op.y };
  const aim = ours ? ours.aim : ghost;
  deps.note({ tokenId: op.tokenId, sceneId: now.sceneId, blocker: "unknown", door: null, ghost, aim, at: { x: now.x, y: now.y }, n });
  deps.showActions(false);
}

/** A walk the server refused: its note stays while the token stands where it said, with no walk for a teleport to take back. */
function walkRefused(n: number, deps: SendDeps): void {
  const shown = deps.shownNote();
  if (shown && shown.n === n) deps.note({ ...shown, n: null });
}
