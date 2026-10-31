import { useMemo, useRef } from "react";
import { resolveRollMode, type RollModeOverride } from "../dice/rollMode.ts";
import { uuidv7 } from "#shared/ids.ts";
import { RollResultLine } from "../rolls/card.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import { alertCard } from "../encounter/alertCard.ts";
import { CardButtons, rollTrouble, useCardRoll } from "../encounter/CardRoll.tsx";
import type { CardButton } from "../encounter/saveCards.ts";
import { presetFor } from "../dice/presets.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useRollBlocked } from "../dice/useRollOption.ts";
import type { PromptCard } from "./alerts.ts";
import { actorOf, openRecord, deathSaveResult, deathSaveWords, promptOp, type DeathSavePrompt } from "./logic.ts";
import { useAnsweredSend } from "./send.ts";
import { WAITS_FOR_REGENERATION } from "./state.ts";

type Action = "roll" | "skip" | "dismiss" | "done";

/** The id a death save card has in the alerts column and the dock's summary. */
export function deathSaveAlertId(card: PromptCard<DeathSavePrompt>): string {
  return `deathSave:${card.id}`;
}

/** The row in the roll options' store a creature's death save Roll keeps its newest tag on, the token panel's and the Dice panel's own. */
export function deathSaveRow(target: { tokenId: string } | { characterId: string }): string {
  return `deathSave:${"tokenId" in target ? target.tokenId : target.characterId}`;
}

/**
 * A death save at a dying creature's turn start (docs/design-v1-combat-controls.md
 * 4.4): "Thorn is dying. Death save: 1 success, 2 failures." with its pips
 * to read, Roll, Skip and Dismiss. Roll goes as the Dice panel's does, on
 * the server, and names the turn's record, so the first roll from any
 * surface settles it and a second is refused before its die. While the
 * creature's Regeneration waits on this device, Roll waits too. Once
 * settled the card says how, from the stored outcome, with Done, and
 * alone: the dying line and the pips would read the counts after it, as a
 * natural 20 that brought it back, a third success or a third failure.
 */
export function DeathSaveCard(props: { card: PromptCard<DeathSavePrompt>; waits: boolean; onDismiss(): void }) {
  const { card } = props;
  const root = useRef<HTMLElement>(null);
  const room = useRoomStore();
  const dm = useRoomView((s) => s.you?.role === "dm");
  const { participant, prompt } = card;
  const target = participant.target;
  const saves = useRoomView((s) => (s.view ? actorOf(s.view, target)?.deathSaves : undefined));
  const creatures = useMemo(() => [target], [target]);
  const { dice } = useDiceView(creatures);
  const blocked = useRollBlocked();
  const roll = useCardRoll(deathSaveRow(target), card.record);
  const send = useAnsweredSend<Action>();
  const settled = prompt.settled;
  const buttons: CardButton<Action>[] = settled
    ? [{ action: "done", text: "Done" }]
    : [
        { action: "roll", text: "Roll" },
        { action: "skip", text: "Skip" },
        { action: "dismiss", text: "Dismiss" },
      ];
  const valid = () => {
    const state = room.getState();
    return state.connection === "open" && !!state.view && openRecord(state.view.encounter, actorOf(state.view, target), "deathSave") === card.record;
  };
  const tap = (action: Action, override?: RollModeOverride) => {
    if (action === "roll") {
      if (props.waits || blocked || !dice || roll.waiting) return;
      if (override && (send.busy || settled || !valid())) return;
      // Its preset is read at the tap, from the creature's effects then, with none of the Dice panel's choices (docs/design-v1-roll-options.md 6.3).
      const preset = presetFor(dice, target, { kind: "deathSave" });
      const extra = preset.extra.join("").replace(/^\+/, "");
      roll.send({ t: "actor.deathRoll", tag: uuidv7(), target, ...resolveRollMode(preset.sources, [], override), ...(extra ? { extra } : {}), record: card.record });
    } else if (action === "skip") send.send("skip", promptOp(target, card.record, "deathSave", "skipped"));
    else props.onDismiss();
  };
  const trouble = rollTrouble(roll.receipt, roll.unsent) ?? send.refusal;
  const status = settled ? deathSaveResult(participant.name, settled) : props.waits ? WAITS_FOR_REGENERATION : null;
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      ref={root}
      role="group"
      aria-label={`Death save for ${participant.name}`}
      tabIndex={-1}
      data-alert="deathSave"
      data-alert-id={deathSaveAlertId(card)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      <div>
        <div style={{ fontWeight: theme.weight.bold }}>Death save</div>
        {settled ? null : <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{deathSaveWords(participant.name, saves)}</div>}
      </div>
      {saves && !settled ? <Pips ok={saves.ok} fail={saves.fail} /> : null}
      {status || trouble ? (
        <div role="status" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
          {status ? <RollResultLine text={status} suffix={settled && roll.mode ? ` ${roll.mode}.` : ""} /> : null}
          {trouble ? <span style={{ color: theme.color.dangerText }}>{trouble}</span> : null}
        </div>
      ) : null}
      <CardButtons buttons={buttons} busy={send.busy} rollBusy={roll.waiting} blocked={props.waits ? WAITS_FOR_REGENERATION : blocked} onTap={tap} rollMenu={{
        source: JSON.stringify([card, target, props.waits, dice && actorOf(dice.view, target), dice && openRecord(dice.view.encounter, actorOf(dice.view, target), "deathSave"), blocked]),
        name: `Death Save for ${participant.name}`, capability: { d20: !settled, visibility: "creature" }, dm,
        disabled: props.waits || !!blocked || !dice || roll.waiting,
        valid: () => send.busy === null && !settled && valid(), fallbackFocus: () => root.current,
        onTap: () => tap("roll"), onRoll: (override) => tap("roll", override),
      }} />
    </section>
  );
}

/** The counts as pips, to read only: the words above say them, so a reader skips these. */
function Pips(props: { ok: number; fail: number }) {
  const pip = (filled: boolean, color: string, key: string) => (
    <span key={key} style={{ width: 16, height: 16, borderRadius: theme.radius.round, border: `${theme.line.strong}px solid ${color}`, background: filled ? color : "transparent" }} />
  );
  return (
    <div aria-hidden style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(3) }}>
      <span style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>{[0, 1, 2].map((i) => pip(i < props.ok, theme.color.success, `ok${i}`))}</span>
      <span style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>{[0, 1, 2].map((i) => pip(i < props.fail, theme.color.danger, `fail${i}`))}</span>
    </div>
  );
}
