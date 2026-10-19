import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type SkillKey } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ABILITY_ABBR, ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Input, NUMBER_FIELD_WIDTH, Select } from "../../components/Field.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { UnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import {
  addChoice,
  allSaves,
  answerAsk,
  askOp,
  askStatus,
  closedAskText,
  dcChips,
  defaultTargets,
  draftInput,
  editAsk,
  emptyDraft,
  fillDraft,
  pendingAskCloseText,
  pickerSteps,
  pickerView,
  readRecent,
  recentLabel,
  recentOf,
  removeChoice,
  seenSummary,
  sendLabel,
  switchesOf,
  tapDc,
  withRecent,
  writeRecent,
  type AskDraft,
  type AskFrom,
  type AskSheet,
} from "./logic.ts";

/**
 * The DM's "Request a roll" (docs/design-v1-dm-tools.md 3.3,
 * docs/design-v1-roll-request.md 4): what to roll, picked whole in one of
 * three rows (a save, a check, or a skill), "Or a second choice" for one
 * the creature picks from, the DC or none, the two options for what
 * players see, a note, and who is asked. Send asks every ticked
 * creature's player and opens the live card.
 */
export function RequestSheet(props: { from: AskFrom; onClose(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
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
  const [recent] = useState(() => readRecent(roomId));
  const [sheet, setSheet] = useState<AskSheet>(() => {
    const draft = emptyDraft(
      options.filter((o) => o.ticked).map((o) => o.ref),
      switchesOf(recent),
    );
    return { draft: props.from.fill ? fillDraft(draft, props.from.fill) : draft, sending: false, error: null };
  });
  const { draft, sending, error } = sheet;
  // What the DM set up, as it was when the sheet opened: a swipe springs back once that has changed, until Send has it (docs/design-v1-sheet-swipe.md 4.5).
  const [opened] = useState(() => JSON.stringify(sheet.draft));
  const unsaved = !sending && JSON.stringify(draft) !== opened;
  const connected = useRoomView((s) => s.connection === "open");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const formId = useId();
  const set = (patch: Partial<AskDraft>) => setSheet((s) => editAsk(s, patch));
  const setError = (problem: string) => setSheet((s) => ({ ...s, error: problem }));
  // Every change to a choice goes through the draft's own rules (logic.ts), so a pick a rule refuses changes nothing here either.
  const change = (next: (d: AskDraft) => AskDraft) => setSheet((s) => (s.sending ? s : { ...s, draft: next(s.draft), error: null }));
  const pickers = useRef<HTMLDivElement>(null);
  const orButton = useRef<HTMLButtonElement>(null);
  // Or and Remove each take their own button away, so focus goes to what stands in its place rather than falling to the page.
  const [focusAfter, setFocusAfter] = useState<"second" | "or" | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    if (focusAfter === "or") orButton.current?.focus();
    else pickers.current?.querySelector<HTMLElement>('[data-choice="1"] :is(input, select):not(:disabled)')?.focus();
  }, [focusAfter]);
  const [seenOpen, setSeenOpen] = useState(false);
  const ticked = (ref: ActorTarget) => draft.ticked.some((t) => sameRef(t, ref));
  const tick = (ref: ActorTarget, on: boolean) => set({ ticked: on ? [...draft.ticked, ref] : draft.ticked.filter((t) => !sameRef(t, ref)) });
  const status = useMemo(() => askStatus(draft), [draft]);
  const seen = useMemo(() => seenSummary(draft), [draft]);
  const hasDc = draft.dc.trim() !== "";
  const chips = dcChips(draft);
  const saves = allSaves(draft);

  const send = () => {
    if (sending) return;
    const input = draftInput(draft);
    if (!input.ok) {
      setError(input.error);
      return;
    }
    const check = askOp(input.input, actions.newId(), open);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    // Closes on the server's answer, not at once, so a refusal keeps what the DM set up beside the reason.
    const n = actions.dispatch(check.op, {
      quiet: true,
      onAnswer: (answer, refusal) => {
        // Kept once the server takes it, whether or not the sheet is still open, so a repeat is one tap next time (4.7).
        if (answer === "taken") writeRecent(roomId, withRecent(readRecent(roomId), recentOf(input.input)));
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
          status
        )
      }
      footer={
        <>
          <Button onClick={close}>{sending ? "Close" : "Cancel"}</Button>
          {/* The form's submit, so Enter in the DC or the note sends (section 8). */}
          <Button variant="primary" type="submit" form={formId} busy={sending}>
            {sendLabel(sending, connected)}
          </Button>
        </>
      }
    >
      <UnsavedInput unsaved={unsaved} />
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onKeyDown={(e) => {
          // Enter sends from the DC and the note alone: on a radio or a checkbox a browser would submit the form too.
          const target = e.target as HTMLElement;
          if (e.key === "Enter" && target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) e.preventDefault();
        }}
      >
        {/* Locked while the request waits for the server, so nothing set after Send is lost when the sheet closes on the answer. Closing stays, outside it. */}
        <fieldset disabled={sending} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
          <div style={{ display: "grid", gap: theme.space(4) }}>
            {recent.length > 0 ? (
              <Section label="Recent" divider={false} style={STACKED}>
                <div role="group" aria-label="Recent requests" style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), minWidth: 0 }}>
                  {recent.map((entry) => {
                    const label = recentLabel(entry);
                    return (
                      <Button
                        key={label}
                        size="sm"
                        title={entry.note ? `${label}: ${entry.note}` : label}
                        onClick={() => change((d) => fillDraft(d, entry))}
                        style={{ maxWidth: "100%", minWidth: 0 }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{label}</span>
                      </Button>
                    );
                  })}
                </div>
              </Section>
            ) : null}
            <div ref={pickers} style={{ display: "grid", gap: theme.space(4) }}>
              {draft.choices.map((_, i) => (
                <ChoicePicker
                  key={i}
                  draft={draft}
                  index={i}
                  disabled={sending}
                  onStep={(step) => change((d) => step(d, i))}
                  onRemove={() => {
                    change((d) => removeChoice(d, i));
                    setFocusAfter("or");
                  }}
                />
              ))}
            </div>
            {draft.choices.length < LIMITS.rollChoices ? (
              <div style={{ display: "grid", justifyItems: "start", gap: theme.space(1) }}>
                <Button
                  ref={orButton}
                  size="sm"
                  onClick={() => {
                    change(addChoice);
                    setFocusAfter("second");
                  }}
                >
                  Or a second choice
                </Button>
                <Help>The creature picks which one it rolls.</Help>
              </div>
            ) : null}
            {/* The DC and, for a check, its typical values on one row (4.4). An empty field is no DC. */}
            <div style={{ containerType: "inline-size", minWidth: 0 }}>
              <PickRow label="DC">
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
                  <Input
                    aria-label="DC"
                    value={draft.dc}
                    inputMode="numeric"
                    enterKeyHint="send"
                    autoComplete="off"
                    placeholder="None"
                    maxLength={2}
                    onChange={(e) => set({ dc: e.target.value })}
                    style={{ width: NUMBER_FIELD_WIDTH, textAlign: "center", marginRight: theme.space(1) }}
                  />
                  {/* A save's DC is the effect's (SRD 5.2.1 page 7), so only checks get the typical ones (page 6). */}
                  {chips?.map((t) => (
                    <Chip key={t.dc} circle aria-label={`${t.dc}, ${t.name}`} title={t.name} pressed={t.pressed} disabled={sending} onClick={() => change((d) => tapDc(d, t.dc))}>
                      {t.dc}
                    </Chip>
                  ))}
                </div>
              </PickRow>
            </div>
            <Section label="Who rolls" divider={false} style={STACKED}>
              {options.length === 0 ? <Help>No player plays a character yet.</Help> : null}
              <ChipRow label="Who rolls">
                {options.map((o) => (
                  <Chip key={o.key} pressed={ticked(o.ref)} unavailable={o.blocked} disabled={sending} onClick={() => tick(o.ref, !ticked(o.ref))}>
                    {o.why ? `${o.name}, ${o.why}` : o.name}
                  </Chip>
                ))}
              </ChipRow>
            </Section>
            <Section label="What players see" divider={false} fold={{ open: seenOpen, onToggle: () => setSeenOpen((v) => !v), summary: <span style={{ color: theme.color.textMuted }}>{seen}</span> }}>
              {/* Options that Send reads, so checkboxes rather than switches (docs/design-v1-visual.md 3.7). Each shows only while it applies (4.6). */}
              <div style={{ display: "grid" }}>
                {hasDc ? <Checkbox label="Players see the DC" checked={draft.dcShown} disabled={sending} onChange={(dcShown) => set({ dcShown })} /> : null}
                <Checkbox label="Players see pass or fail" checked={draft.resultShown} disabled={sending} onChange={(resultShown) => set({ resultShown })} />
              </div>
              {hasDc && !draft.dcShown && draft.resultShown ? (
                <Note>With the DC hidden, a typed answer is final once it passes or fails, and a rolled one at once, so changed totals cannot find the DC. You can reopen one from its card.</Note>
              ) : null}
              {saves ? <Checkbox label="Against a spell" checked={draft.spell} disabled={sending} onChange={(spell) => set({ spell })} /> : null}
              <Input
                aria-label="Note for the players"
                value={draft.note}
                maxLength={LIMITS.rollNoteChars}
                placeholder="Note, such as against the poison"
                autoComplete="off"
                enterKeyHint="send"
                onChange={(e) => set({ note: e.target.value })}
                style={{ width: "100%" }}
              />
            </Section>
          </div>
        </fieldset>
      </form>
    </SheetDialog>
  );
}

/** The 18 skills by name, each with its usual ability: "Perception (WIS)". */
const SKILLS_BY_NAME: readonly SkillKey[] = [...SKILL_KEYS].sort((a, b) => SKILLS[a].name.localeCompare(SKILLS[b].name));

/**
 * One choice's picker (docs/design-v1-roll-request.md 4.2): Save, Check and
 * Skill, each a view of the choice's one pick (`pickerView`), so a tap in
 * any row replaces the whole pick. With two choices each is a named group
 * with Remove.
 */
function ChoicePicker(props: { draft: AskDraft; index: number; disabled: boolean; onStep(step: (draft: AskDraft, i: number) => AskDraft): void; onRemove(): void }) {
  const two = props.draft.choices.length > 1;
  const view = pickerView(props.draft, props.index);
  const whyId = useId();
  const title = two ? (props.index === 0 ? "First choice" : "Or the second") : "What to roll";
  const abilities = (disabled: readonly AbilityKey[]) =>
    ABILITY_KEYS.map((a) => ({ value: a, label: ABILITY_ABBR[a], title: ABILITY_NAMES[a], disabled: disabled.includes(a) }));
  return (
    <div role={two ? "group" : undefined} aria-label={two ? title : undefined} aria-describedby={view.why ? whyId : undefined} data-choice={props.index}>
      <Section
        label={title}
        divider={false}
        style={STACKED}
        action={
          two ? (
            <Button size="sm" aria-label={`Remove the ${props.index === 0 ? "first" : "second"} choice`} onClick={props.onRemove}>
              Remove
            </Button>
          ) : null
        }
      >
        {/* The rows measure the room they share, so each label stands beside its options or above them (globals.css .rvtt-pick-row). */}
        <div style={{ containerType: "inline-size", minWidth: 0, display: "grid", gap: theme.space(2) }}>
          <PickRow label="Save">
            <Segmented
              label="Saving throw"
              even
              value={view.save.value}
              disabled={props.disabled}
              options={abilities(view.save.disabled)}
              onChange={(ability) => props.onStep((d, i) => pickerSteps.save(d, i, ability))}
            />
          </PickRow>
          <PickRow label="Check">
            <Segmented
              label="Ability check"
              even
              value={view.check.value}
              disabled={props.disabled}
              options={abilities(view.check.disabled)}
              onChange={(ability) => props.onStep((d, i) => pickerSteps.check(d, i, ability))}
            />
          </PickRow>
          <PickRow label="Skill">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
              <Select
                aria-label="Skill check"
                value={view.skill.value ?? ""}
                disabled={props.disabled}
                onChange={(e) => {
                  const skill = e.target.value === "" ? null : (e.target.value as SkillKey);
                  props.onStep((d, i) => pickerSteps.skill(d, i, skill));
                }}
                style={{ flex: "1 1 160px", minWidth: 0 }}
              >
                <option value="">Choose a skill</option>
                {SKILLS_BY_NAME.map((s) => (
                  <option key={s} value={s} disabled={view.skill.disabled.includes(s)}>
                    {SKILLS[s].name} ({ABILITY_ABBR[SKILLS[s].ability]})
                  </option>
                ))}
              </Select>
              {view.with ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2) }}>
                  <span aria-hidden="true">with</span>
                  <Select
                    aria-label={`Ability for ${SKILLS[view.with.skill].name}`}
                    value={view.with.value}
                    disabled={props.disabled}
                    onChange={(e) => {
                      const ability = e.target.value as AbilityKey;
                      props.onStep((d, i) => pickerSteps.with(d, i, ability));
                    }}
                  >
                    {ABILITY_KEYS.map((a) => (
                      <option key={a} value={a} disabled={view.with!.disabled.includes(a)}>
                        {ABILITY_NAMES[a]}
                      </option>
                    ))}
                  </Select>
                </span>
              ) : null}
            </div>
          </PickRow>
        </div>
        {view.why ? <Help id={whyId}>{view.why}</Help> : null}
      </Section>
    </div>
  );
}

/** One row of a picker: its label at the start while six options fit beside it, else above them (globals.css). */
function PickRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="rvtt-pick-row">
      <span aria-hidden="true" className="rvtt-pick-label" style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/** The sheet's parts are sections with no line between, spaced by the form's own gap, so none adds the space a panel's section leaves under it. */
const STACKED: CSSProperties = { paddingBottom: 0 };

function sameRef(a: ActorTarget, b: ActorTarget): boolean {
  return "tokenId" in a ? "tokenId" in b && a.tokenId === b.tokenId : "characterId" in b && a.characterId === b.characterId;
}
