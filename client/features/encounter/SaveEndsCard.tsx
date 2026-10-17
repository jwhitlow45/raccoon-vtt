import { useMemo, useState } from "react";
import { bonusFor } from "#shared/dice/bonus.ts";
import { pendingSaves, type PendingSave } from "#shared/rules/saveEnds.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { creatureRolls } from "../dice/creature.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { creatureKey } from "../dice/options.ts";
import { presetFor } from "../dice/presets.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useActOnce, useRollBlocked } from "../dice/useRollOption.ts";
import { alertCard } from "./alertCard.ts";
import { CardButtons, CardChips, rollTrouble, useCardRoll, useCardSend } from "./CardRoll.tsx";
import { AskRow } from "../rolls/AskRow.tsx";
import {
  askSaveOp,
  cardRoll,
  failOp,
  landedOp,
  landedWords,
  passOp,
  resistOp,
  saveCard,
  saveEndsRollTo,
  saveEndsTest,
  saveFacts,
  settleOp,
  waitingRollOp,
  type CardChip,
  type SaveAction,
} from "./saveCards.ts";

/**
 * The DM's pending save-ends occurrences (docs/design-v1-roll-options.md
 * 6.1), oldest first, one card each in the fight alerts. Read from the
 * effects in the DM's view, which alone holds `due` and the DC, so a
 * reload brings back exactly the unsettled ones. Players get none.
 */
export function usePendingSaves(): PendingSave[] {
  const dm = useRoomView((s) => s.you?.role === "dm");
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const rolls = useRoomView((s) => s.view?.rolls);
  return useMemo(() => (dm && tokens && characters && rolls ? pendingSaves({ tokens, characters, rolls }) : []), [dm, tokens, characters, rolls]);
}

/** The id a save-ends card has in the alerts column and the dock's summary. */
export function saveAlertId(pending: PendingSave): string {
  return `saveEnds:${pending.effect.due.id}`;
}

/**
 * One save-ends card: "Goblin 2 ended its turn Frightened. Wisdom save,
 * DC 15, ends it." with Ask for a creature a player plays, Roll, Passed,
 * Failed and Dismiss, then the fail's choices (saveCards.ts saveCard).
 * Its own roll goes to the DM and is acted on once as it lands. A request
 * the card sent decides it on the server: a pass ends the effect there,
 * and a fail waits here for Accept failure or Legendary Resistance.
 * `onResult` takes the words of a roll that decided it, since the card
 * goes as its op lands.
 */
export function SaveEndsCard(props: { pending: PendingSave; onResult(text: string): void }) {
  const { pending } = props;
  const actions = useRoomActions();
  const room = useRoomStore();
  const view = useRoomView((s) => s.view);
  const blocked = useRollBlocked();
  const test = saveEndsTest(pending.effect);
  const creatures = useMemo(() => [pending.target], [pending.target]);
  const { dice, failed } = useDiceView(creatures);
  const rolls = dice ? creatureRolls(dice, pending.target) : null;
  const loading = !failed && rolls === null;
  const bonus = rolls?.numbers ? bonusFor(rolls.numbers, test) : null;
  // Whether it has Magic Resistance comes with its block, so the preset waits for creatureRolls (presets.ts).
  const preset = dice && rolls ? presetFor(dice, pending.target, test, { rolls }) : null;
  const [chip, setChip] = useState<CardChip>(null);
  const [failTapped, setFailTapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = `${view ? creatureKey(view, pending.target) : ""}|saveEnds:${pending.effect.due.id}`;
  const card = useCardRoll(row);
  const send = useCardSend<SaveAction>();

  // Only the card's own roll is acted on here. A request's answer the server rolled is the request's, settled there.
  const own = pending.request ? null : card.tag;
  useActOnce(own, card.rolls, (landed) => {
    const total = landed[0]?.total;
    const state = room.getState().view;
    if (total === undefined || !state) return;
    // Settled or asked meanwhile, from this device or another: the card that rolled no longer decides it.
    const now = pendingSaves(state).find((p) => p.effect.due.id === pending.effect.due.id);
    if (!now || now.request) return;
    const nowFacts = saveFacts(state, now.target);
    const op = landedOp(now, total, nowFacts.legendaryLeft);
    if (!op) return;
    send.send(total >= now.effect.save.dc ? "pass" : "fail", [op]);
    // The card goes as the op lands, so its result stays a moment as a notice.
    const words = landedWords(now, nowFacts.name, total, nowFacts.legendaryLeft);
    if (words) props.onResult(words);
  });

  if (!view) return null;
  const facts = saveFacts(view, pending.target);
  const rolled = !pending.request && card.rolls[0] ? card.rolls[0].total : null;
  const model = saveCard({ pending, facts, bonus, loading, preset, failTapped, rolled });
  const trouble = error ?? rollTrouble(card.receipt, card.unsent);
  const rolling = model.buttons.some((b) => b.action === "roll");

  const tap = (action: SaveAction) => {
    setError(null);
    switch (action) {
      case "ask": {
        const check = askSaveOp(pending, actions.newId(), Object.keys(view.rolls).length);
        if (!check.ok) setError(check.error);
        else send.send("ask", [check.op]);
        return;
      }
      case "roll": {
        if (bonus === null || !preset) return;
        if (pending.request) {
          const op = waitingRollOp(pending, preset, chip, actions.newId());
          if (op) card.send(op);
        } else card.roll([cardRoll(pending.target, bonus, preset, test, chip)], saveEndsRollTo(view, pending));
        return;
      }
      case "pass":
        send.send("pass", [passOp(pending, actions.newId())]);
        return;
      case "fail": {
        const op = failOp(pending, facts.legendaryLeft, actions.newId());
        if (op) send.send("fail", [op]);
        else setFailTapped(true);
        return;
      }
      case "resist":
        send.send("resist", [resistOp(pending, actions.newId())]);
        return;
      case "accept":
        send.send("accept", [settleOp(pending, "resolved")]);
        return;
      case "dismiss":
        send.send("dismiss", [settleOp(pending, "dismissed")]);
        return;
    }
  };

  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      role="group"
      aria-label={`${model.head} ${model.save}`}
      tabIndex={-1}
      data-alert="notice"
      data-alert-id={saveAlertId(pending)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      <div>
        <div style={{ fontWeight: theme.weight.bold }}>{model.head}</div>
        <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{model.save}</div>
      </div>
      {model.status || trouble ? (
        <div role="status" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
          {model.status ? <span>{model.status}</span> : null}
          {trouble ? <span style={{ color: error || card.receipt?.state === "refused" ? theme.color.dangerText : theme.color.textMuted }}>{trouble}</span> : null}
        </div>
      ) : null}
      {/* A player's ask on the linked request's answer, with the live card's Allow and Keep, so it is settled here too (docs/design-v1-roll-request.md 1.1). */}
      {pending.request && pending.request.targets[0]?.change ? (
        <AskRow request={pending.request} target={pending.request.targets[0]} change={pending.request.targets[0].change} name={facts.name} words={false} />
      ) : null}
      {failed ? <SrdLoadFailed what="The save bonus" inline /> : null}
      {model.rollNote ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{model.rollNote}</div> : null}
      {rolling ? <CardChips chip={chip} onChange={setChip} name={facts.name} /> : null}
      <CardButtons
        buttons={model.buttons}
        busy={send.busy}
        rollBusy={card.waiting || model.rollLoading}
        blocked={blocked}
        onTap={tap}
      />
    </section>
  );
}
