import { useState } from "react";
import { SETTLED_MEANWHILE } from "#shared/permissions.ts";
import type { RollChange, RollRequest, RollTarget } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { theme } from "../../lib/theme.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi } from "../../state/view.ts";
import { NEEDS_CONNECTION, sendRoll, useRollSender } from "../dice/send.ts";
import { askRowText } from "./card.ts";
import { targetRef } from "./logic.ts";

/**
 * A player's ask to change a roll (docs/design-v1-roll-request.md 6):
 * "Asks to reroll (Heroic Inspiration)" with Allow and Keep, one tap each,
 * both naming the ask. Allow rolls on the server (`roll.dice` with
 * `change`), or for "Fix my total" reopens the answer for typing alone
 * (`roll.reopen` with `change`). Keep clears the ask. An ask replaced,
 * withdrawn or settled meanwhile is refused before any draw, "It was
 * settled meanwhile.", and the row then shows the ask that stands.
 */
export function AskRow(props: {
  request: RollRequest;
  target: RollTarget;
  change: RollChange;
  name: string;
  /** Leaves out "Asks to reroll (…)", for a card whose own status already says it, as the save-ends card's does. */
  words?: boolean;
}) {
  const { request, target, change, name } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const sender = useRollSender();
  const store = useRoomStore();
  const ref = targetRef(target);
  const [busy, setBusy] = useState<"allow" | "keep" | null>(null);
  const done = (answer: OpAnswer, refusal?: OpRefusal) => {
    setBusy(null);
    if (answer === "refused") ui.notify(refusal?.text ?? SETTLED_MEANWHILE, "error");
  };
  const allow = () => {
    if (busy) return;
    if (change.reason === "fix-total") {
      if (actions.dispatch({ t: "roll.reopen", rollId: request.id, target: ref, change: change.id }, { quiet: true, onAnswer: done }) !== null) setBusy("allow");
      return;
    }
    const tag = actions.newId();
    const n = sendRoll(sender, { t: "roll.dice", tag, rollId: request.id, target: ref, change: change.id }, {
      onAnswer: (answer, refusal) => {
        if (store.getState().view?.rolls[request.id]) sender.receipts.announced(tag);
        done(answer, refusal);
      },
    });
    if (n === null) ui.notify(NEEDS_CONNECTION, "error");
    else setBusy("allow");
  };
  const keep = () => {
    if (busy) return;
    if (actions.dispatch({ t: "roll.change", rollId: request.id, target: ref, clear: change.id }, { quiet: true, onAnswer: done }) !== null) setBusy("keep");
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
      {props.words === false ? null : <span style={{ fontSize: theme.font.small, flex: "1 1 120px" }}>{askRowText(change)}</span>}
      <Button size="sm" variant="primary" busy={busy === "allow"} disabled={busy === "keep"} aria-label={`Allow ${name}'s ask`} onClick={allow}>
        Allow
      </Button>
      <Button size="sm" busy={busy === "keep"} disabled={busy === "allow"} aria-label={`Keep ${name}'s roll`} onClick={keep}>
        Keep
      </Button>
    </div>
  );
}
