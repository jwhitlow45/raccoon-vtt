import { useEffect, useMemo, useRef, useState } from "react";
import { CONDITION_KEYS, STATUS_KEYS, type ConditionKey, type Effect, type StatusKey } from "#shared/model.ts";
import { MAX_EFFECT_LEVEL, type ActorTarget, type ClientOp, type EffectInput } from "#shared/protocol.ts";
import { CONDITIONS, EXHAUSTION_MAX_LEVEL } from "#shared/srd/conditions.ts";
import type { RulesTextEntry } from "#shared/srd/rules-text.ts";
import { STATUSES } from "#shared/srd/statuses.ts";
import { Checkbox } from "../../components/Checkbox.tsx";
import { fieldStyle, Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { dispatchGesture } from "../../state/actions.ts";
import { fireOps, MAX_TRIGGER, reactionTarget } from "../encounter/ready.ts";
import { pressedControl } from "../../lib/handFocus.ts";
import { effectChip, effectCount } from "../../lib/tokenView.ts";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import {
  DURATION_MODES,
  MAX_ROUNDS,
  SELF_KEY,
  anchorOptions,
  describeDuration,
  durationInput,
  emptyForm,
  type DurationForm,
  type DurationMode,
  type SelfRef,
} from "./durations.ts";
import { EffectIcon } from "./EffectIcon.tsx";
import { SaveEndsFields, sameSave, saveEndsForm, saveEndsText, saveOf } from "./SaveEndsFields.tsx";
import { FieldRow, Note, NumberField, Section, Select, SmallButton, Stepper } from "./ui.tsx";

/**
 * Conditions and statuses on a creature (features section 7): the list with
 * durations, a picker with the icons, the SRD 5.2.1 rules text on tap, and
 * the forms for exhaustion levels, the concentration spell, custom statuses
 * and durations (design 9.5).
 */

type EffectKey = Effect["key"];

type Info = { name: string; summary: string; rules?: RulesTextEntry };

function infoOf(key: EffectKey): Info {
  if (key === "custom") return { name: "Custom status", summary: "Your own marker: an emoji or a few letters, a color and a label." };
  if ((CONDITION_KEYS as readonly string[]).includes(key)) {
    const c = CONDITIONS[key as ConditionKey];
    return { name: c.name, summary: c.summary, rules: c.rules };
  }
  const s = STATUSES[key as StatusKey];
  return { name: s.label, summary: s.summary, ...(s.rules ? { rules: s.rules } : {}) };
}

const CUSTOM_COLORS = ["#0f766e", "#1d4ed8", "#7e22ce", "#be123c", "#b45309", "#4d7c0f", "#374151", "#0e7490"];

type Detail = { mode: "add"; key: EffectKey } | { mode: "edit"; effectId: string };

export function EffectsSection(props: {
  effects: Effect[];
  target: ActorTarget;
  self: SelfRef;
  selfLabel: string;
  canEdit: boolean;
  title?: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [picking, setPicking] = useState(false);
  const view = useRoomView((s) => s.view);
  const editing = detail?.mode === "edit" ? props.effects.find((e) => e.id === detail.effectId) : undefined;
  const box = useRef<HTMLDivElement>(null);
  const before = useRef(detail);
  /*
   * Opening an effect takes its row away, and Back, Add, Save, Remove and
   * It fired take the form away, so a keyboard's focus would fall to the
   * page. It moves to the form's first control, Back, as the form opens,
   * and as it closes to the row it was opened from, else Add, the
   * section's first control. Only when focus fell to the page, never on
   * the first draw, and only after a press on a control that had focus,
   * as lib/handFocus.ts's hand-offs do: a tap on a phone focuses nothing,
   * and the hand-off moves nothing then.
   */
  const pressFocused = useRef(false);
  const notePress = () => {
    pressFocused.current = pressedControl() !== null;
  };
  useEffect(() => {
    if (before.current === detail) return;
    const was = before.current;
    before.current = detail;
    const pressed = pressFocused.current;
    pressFocused.current = false;
    const at = box.current;
    const active = document.activeElement;
    if (!at || !pressed || (active !== null && active !== document.body)) return;
    // An effect's id may hold any character, a quote among them, so it goes into the selector escaped.
    const row = detail === null && was?.mode === "edit" ? at.querySelector<HTMLElement>(`[data-effect-row="${CSS.escape(was.effectId)}"]`) : null;
    (row ?? at.querySelector<HTMLElement>("button"))?.focus();
  }, [detail]);

  if (detail && (detail.mode === "add" || editing)) {
    return (
      // No box of its own: a hold for the focus hand-off above and the presses it follows, around the section in both of its looks.
      <div ref={box} onClickCapture={notePress} style={{ display: "contents" }}>
        <Section title={props.title ?? "Conditions"}>
          <EffectDetail
            key={detail.mode === "add" ? `add:${detail.key}` : `edit:${detail.effectId}`}
            effectKey={detail.mode === "add" ? detail.key : editing!.key}
            existing={editing}
            target={props.target}
            self={props.self}
            selfLabel={props.selfLabel}
            canEdit={props.canEdit}
            onDone={() => {
              setDetail(null);
              setPicking(false);
            }}
          />
        </Section>
      </div>
    );
  }

  return (
    <div ref={box} onClickCapture={notePress} style={{ display: "contents" }}>
      <Section
        title={props.title ?? "Conditions"}
        aside={
          props.canEdit ? (
            <SmallButton pressed={picking} onClick={() => setPicking((p) => !p)}>
              {picking ? "Done" : "Add"}
            </SmallButton>
          ) : null
        }
      >
        {props.effects.length === 0 && !picking ? <Note>None.</Note> : null}
        {props.effects.length > 0 ? (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(1) }}>
            {props.effects.map((effect) => (
              <li key={effect.id} style={{ display: "flex", gap: theme.space(1) }}>
                <button
                  type="button"
                  data-effect-row={effect.id}
                  onClick={() => setDetail({ mode: "edit", effectId: effect.id })}
                  style={rowButton}
                >
                  <EffectIcon effect={effect} />
                  <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                    <span style={{ display: "block", fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, fontVariantNumeric: "tabular-nums" }}>{effectChip(effect).label}</span>
                    {effect.duration ? (
                      <span style={{ display: "block", fontSize: theme.font.small, color: theme.color.textMuted }}>
                        {describeDuration(view, effect.duration)}
                      </span>
                    ) : null}
                    {effect.hiddenFromPlayers ? (
                      <span style={{ display: "block", fontSize: theme.font.small, color: theme.color.warning }}>Hidden from players</span>
                    ) : null}
                  </span>
                  <span style={{ color: theme.color.textMuted }}>
                    <Icon name="chevronRight" />
                  </span>
                </button>
                {props.canEdit && effectCount(effect) !== null ? <CountSteps effect={effect} target={props.target} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {picking ? (
          <EffectPicker
            present={props.effects}
            onPick={(key) => {
              const existing = key === "custom" ? undefined : props.effects.find((e) => e.key === key);
              setDetail(existing ? { mode: "edit", effectId: existing.id } : { mode: "add", key });
            }}
          />
        ) : null}
      </Section>
    </div>
  );
}

/**
 * One tap to count a number on an effect up or down, such as rounds or
 * charges left, without opening it. An exhaustion level stays within 1 to 6.
 */
function CountSteps(props: { effect: Effect; target: ActorTarget }) {
  const actions = useRoomActions();
  const count = effectCount(props.effect) ?? 0;
  const exhaustion = props.effect.key === "exhaustion";
  const min = exhaustion ? 1 : 0;
  const max = exhaustion ? EXHAUSTION_MAX_LEVEL : MAX_EFFECT_LEVEL;
  const set = (level: number) => actions.dispatch({ t: "actor.effect.update", target: props.target, effectId: props.effect.id, patch: { level } });
  const name = effectChip({ ...props.effect, level: undefined }).label;
  return (
    <span style={{ flex: "none", display: "flex", gap: theme.space(1) }}>
      <SmallButton icon="minus" label={`${name}: one less`} disabled={count <= min} onClick={() => set(count - 1)} />
      <SmallButton icon="plus" label={`${name}: one more`} disabled={count >= max} onClick={() => set(count + 1)} />
    </span>
  );
}

/** An effect's row is itself a button, so it takes the card look (docs/design-v1-visual.md 2.3, Rows). */
const rowButton = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(3),
  flex: 1,
  minWidth: 0,
  width: "100%",
  minHeight: theme.touch,
  padding: `${theme.space(1)}px ${theme.space(2)}px`,
  borderRadius: theme.radius.md,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
  color: theme.color.text,
  fontSize: theme.font.body14,
  fontFamily: theme.font.body,
  cursor: "pointer",
} as const;

/** Every condition and status as an icon tile. A tap opens its rules text and the form to add it. */
export function EffectPicker(props: { present: Effect[]; onPick(key: EffectKey): void }) {
  const has = new Set(props.present.map((e) => e.key));
  const tile = (key: EffectKey) => {
    const info = infoOf(key);
    const on = has.has(key) && key !== "custom";
    return (
      <button
        key={key}
        type="button"
        onClick={() => props.onPick(key)}
        aria-pressed={on}
        title={info.summary}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: theme.space(1),
          minHeight: 64,
          padding: theme.space(1),
          borderRadius: theme.radius.md,
          ...buttonLook("secondary", { pressed: on }),
          fontSize: theme.font.tiny,
          fontFamily: theme.font.body,
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {/* With no color of its own, the custom tile takes the custom status's default from the effect palette (lib/tokenView.ts). */}
        <EffectIcon effect={{ key, ...(key === "custom" ? { glyph: "+", label: "Custom" } : {}) }} size={26} />
        <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.name}</span>
      </button>
    );
  };
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", gap: theme.space(1) } as const;
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Note>Conditions</Note>
      <div style={grid}>{CONDITION_KEYS.map(tile)}</div>
      <Note>Statuses</Note>
      <div style={grid}>
        {STATUS_KEYS.map(tile)}
        {tile("custom")}
      </div>
    </div>
  );
}

function EffectDetail(props: {
  effectKey: EffectKey;
  existing: Effect | undefined;
  target: ActorTarget;
  self: SelfRef;
  selfLabel: string;
  canEdit: boolean;
  onDone(): void;
}) {
  const { effectKey: key, existing, target, canEdit } = props;
  const actions = useRoomActions();
  const view = useRoomView((s) => s.view);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const info = infoOf(key);
  const options = useMemo(() => anchorOptions(view, props.self, props.selfLabel), [view, props.self, props.selfLabel]);

  const [level, setLevel] = useState(existing?.level ?? 1);
  /** Any other effect's counter, or null for none. */
  const [counter, setCounter] = useState<number | null>(key === "exhaustion" ? null : (existing?.level ?? null));
  const [spell, setSpell] = useState(existing?.spell ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [glyph, setGlyph] = useState(existing?.glyph ?? "");
  const [color, setColor] = useState(existing?.color ?? CUSTOM_COLORS[0]!);
  const [hidden, setHidden] = useState(existing?.hiddenFromPlayers ?? false);
  const [triggerShown, setTriggerShown] = useState(existing?.triggerShown ?? false);
  const [saveForm, setSaveForm] = useState(() => saveEndsForm(existing?.save));
  // A Ready action holds until the start of the creature's own next turn (SRD 5.2.1, "Ready").
  const [form, setForm] = useState<DurationForm>(() =>
    key === "readied" && !existing ? { ...emptyForm(view, options), mode: "turnStart", anchorKey: SELF_KEY } : emptyForm(view, options),
  );
  /** An existing duration is only re-resolved when the form is touched, because resolving restarts its count. */
  const [durationTouched, setDurationTouched] = useState(!existing);
  const [rulesOpen, setRulesOpen] = useState(!canEdit);
  const [error, setError] = useState<string | null>(null);
  // Only its button sends the effect, so a sheet's swipe springs back once anything in the form changed (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince({ level, counter, spell, label, glyph, color, hidden, triggerShown, form, saveForm });

  const shownLevel = key === "exhaustion" ? level : (counter ?? undefined);
  const chip = effectChip({ key, label: label || undefined, glyph: glyph || undefined, color, level: shownLevel, spell: spell || undefined });

  const submit = () => {
    if (key === "custom" && !label.trim() && !glyph.trim()) {
      setError("Give the status a label or a glyph.");
      return;
    }
    const duration = durationInput(form, options);
    const save = saveOf(saveForm);
    if (dm && !save.ok) {
      setError(save.error);
      return;
    }
    const saveValue = save.ok ? save.save : null;
    if (!existing) {
      const effect: EffectInput = { id: actions.newId(), key };
      if (key === "exhaustion") effect.level = level;
      else if (counter !== null) effect.level = counter;
      if (key === "concentrating" && spell.trim()) effect.spell = spell.trim();
      if (key === "readied" && label.trim()) effect.label = label.trim();
      if (key === "custom") {
        if (label.trim()) effect.label = label.trim();
        if (glyph.trim()) effect.glyph = glyph.trim();
        effect.color = color;
      }
      if (duration) effect.duration = duration;
      if (dm && hidden) effect.hiddenFromPlayers = true;
      if (dm && key === "readied" && triggerShown) effect.triggerShown = true;
      if (dm && saveValue) effect.save = saveValue;
      actions.dispatch({ t: "actor.effect.add", target, effect });
    } else {
      const patch: Extract<ClientOp, { t: "actor.effect.update" }>["patch"] = {};
      if (key === "exhaustion" && level !== existing.level) patch.level = level;
      if (key !== "exhaustion" && counter !== (existing.level ?? null)) patch.level = counter;
      if (key === "concentrating" && spell.trim() !== (existing.spell ?? "")) patch.spell = spell.trim() || null;
      if (key === "readied" && label.trim() !== (existing.label ?? "")) patch.label = label.trim() || null;
      if (key === "custom") {
        if (label.trim() !== (existing.label ?? "")) patch.label = label.trim() || null;
        if (glyph.trim() !== (existing.glyph ?? "")) patch.glyph = glyph.trim() || null;
        if (color !== existing.color) patch.color = color;
      }
      if (durationTouched) {
        if (duration) patch.duration = duration;
        else if (existing.duration) patch.duration = null;
      }
      if (dm && hidden !== (existing.hiddenFromPlayers ?? false)) patch.hiddenFromPlayers = hidden;
      if (dm && key === "readied" && triggerShown !== (existing.triggerShown ?? false)) patch.triggerShown = triggerShown;
      if (dm && !sameSave(saveValue, existing.save)) patch.save = saveValue;
      if (Object.keys(patch).length > 0) {
        actions.dispatch({ t: "actor.effect.update", target, effectId: existing.id, patch });
      }
    }
    props.onDone();
  };

  const remove = () => {
    if (existing) actions.dispatch({ t: "actor.effect.remove", target, effectId: existing.id });
    props.onDone();
  };

  // A readied action that fires spends the creature's Reaction, which lives on its initiative row.
  // Whose Reaction it spends: a companion listed under its character spends its own, never Bree's (docs/design-v1-combat-flow.md 3.6.8).
  const answer = key === "readied" && existing ? reactionTarget(view, props.self) : null;
  const fire = () => {
    if (existing && answer) dispatchGesture(actions, fireOps({ target, effectId: existing.id, answer }));
    props.onDone();
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
        <EffectIcon effect={{ key, label: chip.label, glyph: chip.glyph, color: chip.color, level: shownLevel }} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight }}>{key === "custom" ? chip.label : info.name}</div>
          {info.rules ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>SRD 5.2.1, {info.rules.source}</div> : null}
        </div>
        <SmallButton onClick={props.onDone}>Back</SmallButton>
      </div>
      <p style={{ margin: 0, fontSize: theme.font.body14 }}>{info.summary}</p>
      {info.rules ? (
        <div>
          <SmallButton pressed={rulesOpen} onClick={() => setRulesOpen((o) => !o)}>
            {rulesOpen ? "Hide rules text" : `Rules text: ${info.rules.title}`}
          </SmallButton>
          {rulesOpen ? (
            <div
              style={{
                marginTop: theme.space(2),
                padding: `0 ${theme.space(3)}px`,
                borderLeft: `${theme.line.stripe}px solid ${theme.color.border}`,
                color: theme.color.text,
              }}
            >
              <Markdown text={info.rules.text} />
            </div>
          ) : null}
        </div>
      ) : null}
      {existing?.duration ? <Note tone="info">{describeDuration(view, existing.duration)}</Note> : null}
      {existing?.save && !(dm && canEdit) ? <Note tone="info">{saveEndsText(existing.save)}</Note> : null}

      {canEdit ? (
        <>
          {key === "exhaustion" ? (
            <FieldRow label="Exhaustion level" hint={level >= EXHAUSTION_MAX_LEVEL ? "Level 6 is death." : `−${2 * level} to D20 Tests, −${5 * level} ft Speed`}>
              <Stepper label="Exhaustion level" value={level} step={1} min={1} max={EXHAUSTION_MAX_LEVEL} onChange={setLevel} />
            </FieldRow>
          ) : null}
          {key !== "exhaustion" ? (
            <FieldRow label="Counter" hint="A number on its icon, such as rounds or charges left. Empty for none.">
              <NumberField label="Counter" value={counter ?? undefined} min={0} max={MAX_EFFECT_LEVEL} nullable placeholder="None" onCommit={setCounter} width={88} />
            </FieldRow>
          ) : null}
          {key === "readied" ? (
            <FieldRow label="Trigger" fill hint="What it waits for, such as “if the door opens”.">
              <Input aria-label="Trigger" value={label} maxLength={MAX_TRIGGER} onChange={(e) => setLabel(e.target.value)} style={{ flex: 1 }} />
            </FieldRow>
          ) : null}
          {key === "concentrating" ? (
            <FieldRow label="Spell" fill>
              <input
                aria-label="Spell"
                value={spell}
                maxLength={80}
                placeholder="Bless"
                onChange={(e) => setSpell(e.target.value)}
                style={{ ...fieldStyle(), flex: 1 }}
              />
            </FieldRow>
          ) : null}
          {key === "custom" ? (
            <>
              <FieldRow label="Label" fill>
                <input aria-label="Label" value={label} maxLength={80} placeholder="Marked by Vex" onChange={(e) => setLabel(e.target.value)} style={{ ...fieldStyle(), flex: 1 }} />
              </FieldRow>
              <FieldRow label="Emoji or letters" hint="Up to 2 characters show on the token.">
                <Input aria-label="Emoji or letters" value={glyph} maxLength={8} placeholder="MV" onChange={(e) => setGlyph(e.target.value)} style={{ width: 100, textAlign: "center" }} />
              </FieldRow>
              <FieldRow label="Color">
                <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), justifyContent: "flex-end" }}>
                  {CUSTOM_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                      style={{
                        width: theme.touch,
                        height: theme.touch,
                        borderRadius: theme.radius.sm,
                        border: `${theme.line.strong}px solid ${color === c ? theme.color.text : "transparent"}`,
                        background: c,
                        cursor: "pointer",
                      }}
                    />
                  ))}
                  <input
                    type="color"
                    aria-label="Any color"
                    value={color.slice(0, 7)}
                    onChange={(e) => setColor(e.target.value)}
                    style={{ width: theme.touch, height: theme.touch, padding: 0, border: "none", background: "transparent" }}
                  />
                </div>
              </FieldRow>
            </>
          ) : null}
          {dm && key === "readied" ? (
            <Checkbox
              checked={triggerShown}
              onChange={setTriggerShown}
              label="Show the trigger to players"
              help="On a creature no player owns, players otherwise see only that it readied."
            />
          ) : null}
          {dm ? <SaveEndsFields form={saveForm} onChange={setSaveForm} /> : null}
          {dm ? (
            <Checkbox
              checked={hidden}
              onChange={setHidden}
              label="Hidden from players"
              help="Players never see it, the creature's owner included, and the log keeps it to the DM."
            />
          ) : null}
          <DurationFields
            form={form}
            options={options}
            onChange={(f) => {
              setForm(f);
              setDurationTouched(true);
            }}
            hint={existing?.duration && !durationTouched ? "Leave as is to keep the current count." : undefined}
          />
          {error ? <Note tone="error">{error}</Note> : null}
          <div style={{ display: "flex", gap: theme.space(2) }}>
            <SmallButton tone="primary" grow onClick={submit}>
              {existing ? "Save" : "Add"}
            </SmallButton>
            {answer ? <SmallButton onClick={fire}>It fired: Reaction used</SmallButton> : null}
            {existing ? (
              <SmallButton tone="danger" onClick={remove}>
                Remove
              </SmallButton>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

const MODE_OPTIONS = DURATION_MODES.map((m) => ({ value: m.mode, label: m.label }));

export function DurationFields(props: {
  form: DurationForm;
  options: { key: string; label: string }[];
  onChange(form: DurationForm): void;
  hint?: string;
}) {
  const { form } = props;
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <FieldRow label="Duration" fill hint={props.hint}>
        <Select<DurationMode> label="Duration" value={form.mode} options={MODE_OPTIONS} onChange={(mode) => props.onChange({ ...form, mode })} />
      </FieldRow>
      {form.mode !== "none" ? (
        <FieldRow label={form.mode === "rounds" ? "Counted on" : "X is"} fill>
          <Select<string>
            label={form.mode === "rounds" ? "Counted on whose turns" : "Whose turn"}
            value={form.anchorKey}
            options={props.options.map((o) => ({ value: o.key, label: o.label }))}
            onChange={(anchorKey) => props.onChange({ ...form, anchorKey })}
          />
        </FieldRow>
      ) : null}
      {form.mode === "rounds" ? (
        <FieldRow label="Rounds">
          <NumberField label="Rounds" value={form.rounds} min={1} max={MAX_ROUNDS} onCommit={(n) => n !== null && props.onChange({ ...form, rounds: n })} />
        </FieldRow>
      ) : null}
    </div>
  );
}
