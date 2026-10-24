import { uuidv7 } from "#shared/ids.ts";
import { theme } from "../../lib/theme.ts";
import type { PromptCard } from "../combat/alerts.ts";
import { abilityOp, rechargeResult, rechargeRollOp, rechargeWords, type RechargePromptState } from "../combat/logic.ts";
import { useAnsweredSend } from "../combat/send.ts";
import { useRollBlocked } from "../dice/useRollOption.ts";
import { alertCard } from "./alertCard.ts";
import { CardButtons, rollTrouble, useCardRoll } from "./CardRoll.tsx";
import type { CardButton } from "./saveCards.ts";

/** The id a recharge card has in the alerts column and the dock's summary. */
export function rechargeAlertId(card: PromptCard<RechargePromptState>): string {
  return `recharge:${card.id}`;
}

type RechargeAction = "roll" | "ready" | "dismiss" | "done";

/**
 * A recharge at its creature's turn start (docs/design-v1-combat-controls.md
 * 4.5), one card per ability its record named due: "Fire Breath can
 * recharge (5–6)." with Roll, Mark ready and Dismiss. The roll is
 * `actor.rechargeRoll`, drawn on the server once whichever device rolls
 * first, on the Dice panel's own row for that recharge, so the result
 * shows in both. The record keeps the result, so it stays after a reload:
 * "Rolled 5: Fire Breath is ready." or "Rolled 2: Fire Breath stays used.",
 * with Done. The ability's name and range are its mark's, so the card
 * needs no stat block.
 */
export function RechargeCard(props: { card: PromptCard<RechargePromptState>; onDismiss(): void }) {
  const { card } = props;
  const { participant, prompt } = card;
  const blocked = useRollBlocked();
  const roll = useCardRoll(`${participant.holder}|${prompt.key}|recharge`);
  const send = useAnsweredSend<RechargeAction>();
  const settled = prompt.settled;
  const text = rechargeWords(prompt.name, prompt.min);
  const buttons: CardButton<RechargeAction>[] = settled
    ? [{ action: "done", text: "Done" }]
    : [
        { action: "roll", text: "Roll" },
        { action: "ready", text: "Mark ready" },
        { action: "dismiss", text: "Dismiss" },
      ];
  const tap = (action: RechargeAction) => {
    if (action === "roll") {
      if (!roll.waiting && !blocked) roll.send(rechargeRollOp(uuidv7(), participant.target, prompt, card.record));
    } else if (action === "ready") send.send("ready", abilityOp(participant.target, { kind: "recharge", key: prompt.key, name: prompt.name, min: prompt.min }, { back: true }));
    else props.onDismiss();
  };
  const trouble = rollTrouble(roll.receipt, roll.unsent) ?? send.refusal;
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      role="group"
      aria-label={`${text} ${participant.name}`}
      tabIndex={-1}
      data-alert="notice"
      data-alert-id={rechargeAlertId(card)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      <div>
        <div style={{ fontWeight: theme.weight.bold }}>{text}</div>
        <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{participant.name}</div>
      </div>
      {settled || trouble ? (
        <div role="status" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
          {settled ? <span>{rechargeResult(prompt.name, settled)}</span> : null}
          {trouble ? <span style={{ color: theme.color.dangerText }}>{trouble}</span> : null}
        </div>
      ) : null}
      <CardButtons buttons={buttons} busy={send.busy} rollBusy={roll.waiting} blocked={blocked} onTap={tap} />
    </section>
  );
}
