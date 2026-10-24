import { theme } from "../../lib/theme.ts";
import { alertCard } from "../encounter/alertCard.ts";
import { CardButtons } from "../encounter/CardRoll.tsx";
import type { CardButton } from "../encounter/saveCards.ts";
import type { PromptCard } from "./alerts.ts";
import { promptOp, regeneratedWords, REGENERATION_NOTE_HELP, regenerateOp, regenerationNote, regenerationWords, type RegenerationPrompt } from "./logic.ts";
import { useAnsweredSend } from "./send.ts";

type Action = "apply" | "skip" | "dismiss" | "done";

/** The id a Regeneration card has in the alerts column and the dock's summary. */
export function regenerationAlertId(card: PromptCard<RegenerationPrompt>): string {
  return `regeneration:${card.id}`;
}

/** The card's words, which the dock's summary names it by. */
export function regenerationText(card: PromptCard<RegenerationPrompt>, revives: boolean): string {
  const settled = card.prompt.settled;
  if (settled?.state === "done") return `${card.participant.name}: ${regeneratedWords(settled)}`;
  return regenerationWords(card.participant.name, card.prompt.use.amount, card.participant.record?.life ?? "alive", revives).text;
}

/**
 * Regeneration at a turn's start (docs/design-v1-combat-controls.md 4.3),
 * before the death save card, since a troll "dies only if it starts its
 * turn with 0 Hit Points and doesn't regenerate". Apply heals by the
 * rules and settles it for every device, Skip settles it skipped, and
 * Dismiss hides it here alone. The note is advisory: Apply and Skip stay
 * whatever it says. Once applied it says what it healed, with Done.
 */
export function RegenerationCard(props: { card: PromptCard<RegenerationPrompt>; revives: boolean; onDismiss(): void }) {
  const { card } = props;
  const { participant, prompt } = card;
  const send = useAnsweredSend<Action>();
  const settled = prompt.settled;
  const words = regenerationWords(participant.name, prompt.use.amount, participant.record?.life ?? "alive", props.revives);
  const note = settled ? null : regenerationNote(participant.record?.took, prompt.use.stops);
  const buttons: CardButton<Action>[] = settled
    ? [{ action: "done", text: "Done" }]
    : [...(words.apply ? [{ action: "apply" as const, text: "Apply" }] : []), { action: "skip", text: "Skip" }, { action: "dismiss", text: "Dismiss" }];
  const tap = (action: Action) => {
    if (action === "apply") send.send("apply", regenerateOp(participant.target, prompt.use, card.record));
    else if (action === "skip") send.send("skip", promptOp(participant.target, card.record, "regeneration", "skipped"));
    else props.onDismiss();
  };
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      role="group"
      aria-label={`Regeneration for ${participant.name}`}
      tabIndex={-1}
      data-alert="notice"
      data-alert-id={regenerationAlertId(card)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      <div>
        <div style={{ fontWeight: theme.weight.bold }}>Regeneration</div>
        <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{words.text}</div>
      </div>
      {settled ? (
        <div role="status" style={{ fontSize: theme.font.body14 }}>
          {regeneratedWords(settled)}
        </div>
      ) : null}
      {note ? (
        <div style={{ display: "grid", gap: theme.space(0.5) }}>
          <div style={{ fontSize: theme.font.body14 }}>{note}</div>
          <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{REGENERATION_NOTE_HELP}</div>
        </div>
      ) : null}
      {send.refusal ? (
        <div role="status" style={{ fontSize: theme.font.body14, color: theme.color.dangerText }}>
          {send.refusal}
        </div>
      ) : null}
      <CardButtons buttons={buttons} busy={send.busy} rollBusy={false} blocked={null} onTap={tap} />
    </section>
  );
}
