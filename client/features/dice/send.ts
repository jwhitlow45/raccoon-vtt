import { useMemo } from "react";
import type { ClientOp } from "#shared/protocol.ts";
import type { OnAnswer, RoomActions } from "../../state/types.ts";
import { useRoomActions, useRoomStore } from "../../state/view.ts";
import { useReceipts, type ReceiptTracker } from "./useReceipt.ts";

/**
 * Sending an op that rolls or applies (docs/design-v1-dice.md 4.5 and 8.7):
 * only while the socket is open, since a roll needs the server, and with
 * its tag tracked from the tap, so the surface that sent it shows its
 * answer in place. The store shows no toast for it: the surface does, and
 * a result whose surface closed first goes to a toast of its own
 * (useRollToasts).
 */
export type RollSender = {
  dispatch: RoomActions["dispatch"];
  /** The socket is open. A roll sent before it dropped stays pending and is resent, and its receipt settles it. */
  connected(): boolean;
  receipts: ReceiptTracker;
};

/** An op that carries a tag: the dice ops, and every other op that rolls or applies. */
export type TaggedOp = Extract<ClientOp, { tag?: string }> & { tag: string };

export function useRollSender(): RollSender {
  const actions = useRoomActions();
  const store = useRoomStore();
  const receipts = useReceipts();
  return useMemo(() => ({ dispatch: actions.dispatch, connected: () => store.getState().connection === "open", receipts }), [actions, store, receipts]);
}

/** The words of a roll that cannot go out, shown on every control that rolls while it cannot. */
export const NEEDS_CONNECTION = "Rolling needs a connection.";

/**
 * Sends one tagged op. Returns its `n`, or null when nothing was sent: the
 * socket is not open, or the op could not be queued (a preview as a player
 * refuses every op).
 */
export function sendRoll(sender: RollSender, op: TaggedOp, opts: { onAnswer?: OnAnswer } = {}): number | null {
  if (!sender.connected()) return null;
  const part = "part" in op && typeof op.part === "number" ? op.part : 0;
  sender.receipts.sending(op.tag, part);
  const n = sender.dispatch(op, {
    quiet: true,
    onAnswer: (answer, refusal, cause) => {
      sender.receipts.answer(op.tag, part, answer, refusal, cause);
      opts.onAnswer?.(answer, refusal, cause);
    },
  });
  if (n === null) sender.receipts.forget(op.tag, part);
  return n;
}
