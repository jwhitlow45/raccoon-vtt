import { useState } from "react";
import type { ClientOp } from "#shared/protocol.ts";
import type { OnAnswer } from "../../state/types.ts";
import { useRoomActions } from "../../state/view.ts";
import { useAnyPending } from "../encounter/hooks.ts";
import { reasonText } from "../resources/logic.ts";

/**
 * A card's or a list's op other than a roll (docs/design-v1-combat-controls.md
 * 4.1): its button busy until the server answers, deaf to a second tap
 * meanwhile, and a refusal kept for the card's status line, in the
 * server's words, since the toast would show far from the tap.
 */
export function useAnsweredSend<A extends string>(): { busy: A | null; refusal: string | null; send(action: A, op: ClientOp): boolean } {
  const actions = useRoomActions();
  const [sent, setSent] = useState<{ action: A; n: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useAnyPending(sent === null ? [] : [sent.n]);
  return {
    busy: pending ? (sent?.action ?? null) : null,
    refusal,
    send(action, op) {
      if (pending) return false;
      const onAnswer: OnAnswer = (answer, refused) => setRefusal(answer === "refused" ? reasonText(refused) : null);
      const n = actions.dispatch(op, { quiet: true, onAnswer });
      if (n === null) {
        setRefusal("That could not be sent.");
        return false;
      }
      setRefusal(null);
      setSent({ action, n });
      return true;
    },
  };
}
