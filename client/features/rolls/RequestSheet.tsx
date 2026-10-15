import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ABILITY_KEYS, type AbilityKey, type RollChoice } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ABILITY_NAMES, SKILLS, skillsOf, TYPICAL_DCS } from "#shared/rules/skills.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Input, NUMBER_FIELD_WIDTH } from "../../components/Field.tsx";
import { Help, Note, SectionLabel } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import {
  answerAsk,
  askOp,
  closedAskText,
  defaultTargets,
  editAsk,
  emptyDraft,
  pendingAskCloseText,
  sendLabel,
  testTitle,
  withKind,
  withSkill,
  type AskDraft,
  type AskFrom,
  type AskSheet,
} from "./logic.ts";

/**
 * The DM's "Request a roll" (docs/design-v1-dm-tools.md 3.3): a saving
 * throw or an ability check, the ability, for a check perhaps a skill,
 * "Or" for a second choice the creature picks from, the DC or none, the
 * two options for what players see, a note, and who is asked. Send asks
 * every ticked creature's player and opens the live card.
 */
export function RequestSheet(props: { from: AskFrom; onClose(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const members = useRoomView((s) => s.view?.members);
  const characters = useRoomView((s) => s.view?.characters);
  const tokens = useRoomView((s) => s.view?.tokens);
  const meta = useRoomView((s) => s.view?.meta);
  const viewing = useRoomView((s) => s.sceneId);
  const open = useRoomView((s) => Object.keys(s.view?.rolls ?? {}).length);
  // Worked out once, when the sheet opens: a creature that moves meanwhile keeps the tick the DM gave it.
  const [options] = useState(() =>
    members && characters && tokens && meta ? defaultTargets({ members, characters, tokens, meta }, props.from, viewing) : [],
  );
  const [sheet, setSheet] = useState<AskSheet>(() => ({ draft: emptyDraft(options.filter((o) => o.ticked).map((o) => o.ref)), sending: false, error: null }));
  const { draft, sending, error } = sheet;
  const connected = useRoomView((s) => s.connection === "open");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dcField = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<AskDraft>) => setSheet((s) => editAsk(s, patch));
  const setError = (problem: string) => setSheet((s) => ({ ...s, error: problem }));
  const setChoice = (i: number, choice: RollChoice) => set({ choices: draft.choices.map((c, j) => (j === i ? choice : c)) });
  const ticked = (ref: ActorTarget) => draft.ticked.some((t) => sameRef(t, ref));
  const tick = (ref: ActorTarget, on: boolean) => set({ ticked: on ? [...draft.ticked, ref] : draft.ticked.filter((t) => !sameRef(t, ref)) });
  const summary = useMemo(() => {
    const dc = draft.dc.trim() ? `, DC ${draft.dc.trim()}` : ", no DC";
    return `${testTitle({ kind: draft.kind, choices: draft.choices })}${dc}`;
  }, [draft]);

  const send = () => {
    if (sending) return;
    const check = askOp(draft, actions.newId(), open);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    // Closes on the server's answer, not at once, so a refusal keeps what the DM set up beside the reason.
    const n = actions.dispatch(check.op, {
      quiet: true,
      onAnswer: (answer, refusal) => {
        if (!mounted.current) {
          // Closed while sending: no sheet is left to show why, so a failure says so in a toast.
          const text = closedAskText(answer, refusal);
          if (text) ui.notify(text, "error");
          return;
        }
        const outcome = answerAsk(sheet, answer, refusal);
        if (outcome.close) props.onClose();
        else setSheet((s) => ({ ...s, sending: false, error: outcome.sheet.error }));
      },
    });
    if (n === null) {
      setError("That request could not be sent. Check it and try again.");
      return;
    }
    setSheet((s) => ({ ...s, sending: true, error: null }));
  };

  // A request already sent goes out whatever the sheet does, so closing then cancels nothing: a word on where it stands instead.
  const close = () => {
    if (sending) ui.notify(pendingAskCloseText(connected));
    props.onClose();
  };

  return (
    <SheetDialog
      title="Request a roll"
      onClose={close}
      width={theme.layout.dialog.md}
      status={
        error ? (
          <span role="alert" style={{ color: theme.color.dangerText }}>
            {error}
          </span>
        ) : (
          `${summary}. ${draft.ticked.length} asked.`
        )
      }
      footer={
        <>
          <Button onClick={close}>{sending ? "Close" : "Cancel"}</Button>
          <Button variant="primary" busy={sending} onClick={send}>
            {sendLabel(sending, connected)}
          </Button>
        </>
      }
    >
      {/* Locked while the request waits for the server, so nothing set after Send is lost when the sheet closes on the answer. Closing stays, outside it. */}
      <fieldset disabled={sending} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
        <div style={{ display: "grid", gap: theme.space(4) }}>
          <Group title="What to roll">
            <Segmented
              label="What to roll"
              value={draft.kind}
              disabled={sending}
              options={[
                { value: "save", label: "Saving throw" },
                { value: "check", label: "Ability check" },
              ]}
              onChange={(kind) => set(withKind(draft, kind))}
            />
          </Group>
          {draft.choices.map((choice, i) => (
            <ChoiceEditor
              key={i}
              index={i}
              two={draft.choices.length > 1}
              kind={draft.kind}
              choice={choice}
              disabled={sending}
              onChange={(next) => setChoice(i, next)}
              onRemove={() => set({ choices: draft.choices.filter((_, j) => j !== i) })}
            />
          ))}
          {draft.choices.length < LIMITS.rollChoices ? (
            <div style={{ display: "grid", justifyItems: "start", gap: theme.space(1) }}>
              <Button size="sm" onClick={() => set({ choices: [...draft.choices, nextChoice(draft.choices[0]!)] })}>
                Or…
              </Button>
              <Help>A second choice: the creature picks which one it rolls.</Help>
            </div>
          ) : null}
          <Group title="DC">
            <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
              <Input
                ref={dcField}
                aria-label="DC"
                value={draft.dc}
                inputMode="numeric"
                enterKeyHint="done"
                autoComplete="off"
                placeholder="None"
                maxLength={2}
                onChange={(e) => set({ dc: e.target.value })}
                style={{ width: NUMBER_FIELD_WIDTH, textAlign: "center" }}
              />
              {draft.dc.trim() ? (
                <Button size="sm" onClick={() => set({ dc: "" })}>
                  No DC
                </Button>
              ) : null}
            </div>
            {draft.kind === "check" ? (
              // A save's DC is the effect's (SRD 5.2.1 page 7), so only checks get the typical ones (page 6).
              <ChipRow>
                {TYPICAL_DCS.map((t) => (
                  <Chip
                    key={t.dc}
                    pressed={draft.dc.trim() === String(t.dc)}
                    disabled={sending}
                    onClick={() => set({ dc: draft.dc.trim() === String(t.dc) ? "" : String(t.dc) })}
                  >
                    {t.name} {t.dc}
                  </Chip>
                ))}
              </ChipRow>
            ) : (
              <Help>A save’s DC is set by the effect that causes it, or by you.</Help>
            )}
          </Group>
          <Group title="What players see">
            {/* Options that Send reads, so checkboxes rather than switches (docs/design-v1-visual.md 3.7). */}
            <div style={{ display: "grid" }}>
              <Checkbox label="Players see the DC" checked={draft.dcShown} disabled={sending} onChange={(dcShown) => set({ dcShown })} />
              <Checkbox label="Players see pass or fail" checked={draft.resultShown} disabled={sending} onChange={(resultShown) => set({ resultShown })} />
            </div>
            {draft.dc.trim() && !draft.dcShown && draft.resultShown ? (
              <Note>With the DC hidden, an answer is final once it passes or fails, so changed totals cannot find the DC. You can reopen one from its card.</Note>
            ) : null}
          </Group>
          <Group title="Note">
            <Input
              aria-label="Note for the players"
              value={draft.note}
              maxLength={LIMITS.rollNoteChars}
              placeholder="against the poison"
              autoComplete="off"
              enterKeyHint="done"
              onChange={(e) => set({ note: e.target.value })}
              style={{ width: "100%" }}
            />
          </Group>
          <Group title="Who rolls">
            {options.length === 0 ? <Help>No player plays a character yet.</Help> : null}
            <div style={{ display: "grid" }}>
              {options.map((o) => (
                <Checkbox
                  key={o.key}
                  checked={ticked(o.ref)}
                  disabled={o.blocked || sending}
                  onChange={(on) => tick(o.ref, on)}
                  label={o.name}
                  help={o.why}
                />
              ))}
            </div>
          </Group>
        </div>
      </fieldset>
    </SheetDialog>
  );
}

/** A second choice that differs from the first: the next ability round the six, with no skill yet. */
function nextChoice(first: RollChoice): RollChoice {
  const i = ABILITY_KEYS.indexOf(first.ability);
  return { ability: ABILITY_KEYS[(i + 1) % ABILITY_KEYS.length]! };
}

function ChoiceEditor(props: {
  index: number;
  two: boolean;
  kind: AskDraft["kind"];
  choice: RollChoice;
  disabled: boolean;
  onChange(choice: RollChoice): void;
  onRemove(): void;
}) {
  const { choice } = props;
  return (
    <Group
      title={props.two ? (props.index === 0 ? "First choice" : "Or the second") : "Ability"}
      aside={
        props.index > 0 ? (
          <Button size="sm" onClick={props.onRemove}>
            Remove
          </Button>
        ) : null
      }
    >
      <Segmented
        // Two groups both named "Ability" could not be told apart by name, so each takes its place in the pair.
        label={props.two ? (props.index === 0 ? "First ability" : "Second ability") : "Ability"}
        value={choice.ability}
        disabled={props.disabled}
        options={ABILITY_KEYS.map((a) => ({ value: a, label: ABILITY_NAMES[a] }))}
        onChange={(ability) => props.onChange({ ...choice, ability })}
        // Three across, so the six abilities line up in two even rows on a phone and a computer alike.
        style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
      />
      {props.kind === "check" ? (
        <div style={{ display: "grid", gap: theme.space(1) }}>
          <Help>Skill, if any. It fills in its usual ability, which you can still change.</Help>
          {ABILITY_KEYS.filter((a) => skillsOf(a).length > 0).map((a) => (
            <SkillRow key={a} ability={a} choice={choice} disabled={props.disabled} onPick={(skill) => props.onChange(withSkill(choice, skill))} />
          ))}
        </div>
      ) : null}
    </Group>
  );
}

function SkillRow(props: { ability: AbilityKey; choice: RollChoice; disabled: boolean; onPick(skill: RollChoice["skill"]): void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `${theme.space(9)}px minmax(0, 1fr)`, alignItems: "start", gap: theme.space(1) }}>
      <span style={{ lineHeight: `${theme.touch}px`, fontSize: theme.font.small, color: theme.color.textMuted }}>{ABILITY_NAMES[props.ability].slice(0, 3)}</span>
      <ChipRow>
        {skillsOf(props.ability).map((skill) => (
          <Chip key={skill} pressed={props.choice.skill === skill} disabled={props.disabled} onClick={() => props.onPick(skill)}>
            {SKILLS[skill].name}
          </Chip>
        ))}
      </ChipRow>
    </div>
  );
}

/** One part of the sheet under its label. */
function Group(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: theme.space(2) }}>
      <SectionLabel action={props.aside}>
        {props.title}
      </SectionLabel>
      {props.children}
    </section>
  );
}

function sameRef(a: ActorTarget, b: ActorTarget): boolean {
  return "tokenId" in a ? "tokenId" in b && a.tokenId === b.tokenId : "characterId" in b && a.characterId === b.characterId;
}
