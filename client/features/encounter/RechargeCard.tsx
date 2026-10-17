import { useMemo } from "react";
import type { ActorTarget } from "#shared/protocol.ts";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { creatureRolls } from "../dice/creature.ts";
import { namedRoll, readUsed, resultWords, withUsed, writeUsed } from "../dice/options.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useActOnce, useRollBlocked } from "../dice/useRollOption.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { alertCard } from "./alertCard.ts";
import { CardButtons, rollTrouble, useCardRoll } from "./CardRoll.tsx";
import { rechargePrompts, recharged, type RechargePrompt, type RechargeTurn } from "./saveCards.ts";

/**
 * The recharge prompts of the turn that just started
 * (docs/design-v1-roll-options.md 6.4): the actions of that monster this
 * device marked Used when its turn began, read from its block, which may
 * still be loading. Dismissed ones are left out.
 */
export function useRechargePrompts(turn: RechargeTurn | null, dismissed: ReadonlySet<string>): { prompts: RechargePrompt[]; loading: boolean; failed: boolean } {
  const creatures = useMemo(() => (turn ? [turn.creature] : []), [turn]);
  const { dice, failed } = useDiceView(creatures);
  if (!turn) return { prompts: [], loading: false, failed: false };
  const rolls = dice ? creatureRolls(dice, turn.creature) : null;
  const there = dice ? ("tokenId" in turn.creature ? dice.view.tokens[turn.creature.tokenId] : dice.view.characters[turn.creature.characterId]) !== undefined : true;
  const prompts = rolls ? rechargePrompts(turn, rolls.named).filter((p) => !dismissed.has(p.id)) : [];
  return { prompts, loading: !failed && there && rolls === null, failed };
}

/** The id a recharge card has in the alerts column and the dock's summary. */
export function rechargeAlertId(prompt: RechargePrompt): string {
  return `recharge:${prompt.id}`;
}

/** What shows while the monster's block loads, or did not load. */
export function RechargeWait(props: { failed: boolean }) {
  if (props.failed) {
    return (
      <div style={{ ...alertCard, display: "grid" }}>
        <SrdLoadFailed what="The recharge" inline />
      </div>
    );
  }
  return <Loading text="Loading the recharge…" style={{ ...alertCard, display: "flex" }} />;
}

type RechargeAction = "roll" | "dismiss" | "done";

/**
 * "Fire Breath can recharge (5–6). Roll", for the DM: 1d6 to the DM,
 * labelled "Fire Breath recharge", whose success clears Used on this
 * device. It shares the Dice panel's row for that recharge, so the result
 * shows in both and Used is cleared once, but reads only a roll sent since
 * its turn started: the row's roll of an earlier turn is that turn's.
 */
export function RechargeCard(props: { prompt: RechargePrompt; creature: ActorTarget; holder: string; onDone(): void }) {
  const { prompt } = props;
  const roomId = useRoomView((s) => s.roomId);
  const blocked = useRollBlocked();
  const card = useCardRoll(prompt.row, prompt.after);
  useActOnce(card.tag, card.rolls, (landed) => {
    if (recharged(landed[0]?.total ?? 0, prompt.recharge)) writeUsed(roomId, withUsed(readUsed(roomId), props.holder, prompt.key, false));
  });
  const result = card.rolls.length > 0 ? resultWords(card.rolls, "recharge", { recharge: prompt.recharge }) : null;
  const trouble = rollTrouble(card.receipt, card.unsent);
  const buttons: { action: RechargeAction; text: string }[] = result
    ? [{ action: "done", text: "Done" }]
    : [
        { action: "roll", text: "Roll" },
        { action: "dismiss", text: "Dismiss" },
      ];
  const tap = (action: RechargeAction) => {
    if (action === "roll") card.roll([namedRoll("1d6", `${prompt.name} recharge`, props.creature)], { to: "dm" });
    else props.onDone();
  };
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      role="group"
      aria-label={prompt.text}
      tabIndex={-1}
      data-alert="notice"
      data-alert-id={rechargeAlertId(prompt)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      <div style={{ fontWeight: theme.weight.bold }}>{prompt.text}</div>
      {result || trouble ? (
        <div role="status" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
          {result ? <span>{result}</span> : null}
          {trouble ? <span style={{ color: card.receipt?.state === "refused" ? theme.color.dangerText : theme.color.textMuted }}>{trouble}</span> : null}
        </div>
      ) : null}
      <CardButtons buttons={buttons} busy={null} rollBusy={card.waiting} blocked={blocked} onTap={tap} />
    </section>
  );
}
