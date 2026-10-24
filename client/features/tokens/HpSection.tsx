import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { healRevivesDead } from "#shared/migrate.ts";
import type { Actor, HpVisibility, LifeState, TokenKind } from "#shared/model.ts";
import { hpLess } from "#shared/rules/hp.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { fieldStyle, NUMBER_FIELD_WIDTH } from "../../components/Field.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Tag } from "../../components/Tag.tsx";
import { useTooltip } from "../../components/Tooltip.tsx";
import { critSent, nextRestMode, REST_FIELD_MIN, restDead, type EntryStatus } from "../../canvas/barButtons.ts";
import { RestRow, type RestItem } from "../../canvas/RestRow.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { handFocusOn } from "../../lib/handFocus.ts";
import { hpDisplay, hpLabel, hpText, type HpView } from "../../lib/tokenView.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { useHpChips, useMarkChipApplied } from "../dice/hpChips.ts";
import { resultWords, type HpChip } from "../dice/options.ts";
import { presetFor } from "../dice/presets.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useRollBlocked, useRollOption, useRowResult } from "../dice/useRollOption.ts";
import { actorOf, openRecord } from "../combat/logic.ts";
import { useDeathSaveWaits, WAITS_FOR_REGENERATION } from "../combat/state.ts";
import { deadLines, entryOperation, entryRefusal, sendHpEntry, untouchedTypes, type HpTarget } from "./groupHp.ts";
import { hpDraftKey, useKeepHpDraft, useKeptHpDraft, type HpPlace } from "./hpDraft.ts";
import { HP_MODES, MAX_HP_AMOUNT, modeAfterApply, parseHpInput, type HpMode } from "./hpInput.ts";
import { FieldRow, Note, NumberField, Section, SmallButton } from "./ui.tsx";

/**
 * HP, temporary HP, death saves and life state (design section 9.6). Every
 * change goes through `actor.hp`, `actor.deathSave` or `actor.life`, so the
 * shared rules decide what 0 HP means for this kind of creature.
 */

type HpActor = HpView & Partial<Pick<Actor, "deathSaves">>;

export type HpAccessLevel = "all" | "relative" | "none";

/** The HP entry's target for a single creature: its name, life and maximum feed the entry's lines on the dead (groupHp.ts deadLines). */
export function oneTarget(target: ActorTarget, access: HpAccessLevel, atZero: boolean, vitals: Pick<HpTarget, "name" | "dead" | "max">): HpTarget {
  return { holder: "tokenId" in target ? `token:${target.tokenId}` : `character:${target.characterId}`, target, access, atZero, ...vitals };
}

/**
 * An upright phone's bar around the entry (docs/design-v1-bar-compact.md
 * 3.3 and 5.3), while it rests as the strip or is expanded from it. The
 * field row stands in the strip's quick row (canvas/RestRow.tsx) in both,
 * so the same field, with its text, caret, focus and the phone's keyboard,
 * carries over as the bar expands and rests.
 */
export type HpRest = {
  /** The strip shows: the mode toggle in the modes' place, Crit and the newest rolled amount in the quick row, and the feedback in the status line. False while expanded. */
  resting: boolean;
  /** The strip scrolls (5.4), holding under its quick row whatever the row leaves out. */
  scrolls: boolean;
  /** The bar's own candidates, after the entry's in the quick row. */
  items: readonly RestItem[];
  /** The ids the quick row drew (RestRow's fit), or null while it draws every one. */
  shown: readonly string[] | null;
  /** What the entry has to say, for the status line (canvas/barButtons.ts restStatus). */
  onStatus(status: EntryStatus): void;
};

/**
 * The quick entry: a mode, then a number, or math typed straight in
 * (`-7`, `+5`, `=20`, `t5`). `relative` access is the room's "players can
 * apply damage" setting, which allows damage and healing only. With several
 * creatures selected, one entry applies to each of them (groupHp.ts).
 */
export function HpEntry(props: {
  /** One creature, or each of a multi-selection. */
  targets: readonly HpTarget[];
  access: Exclude<HpAccessLevel, "none">;
  /** Where it stands, so the token bar and a panel showing the same creature each keep their own typing through a blackout (hpDraft.ts). */
  place: HpPlace;
  onApplied?(): void;
  /**
   * The field and Apply above the mode buttons, for a short bar, so Apply
   * shows without a scroll on a phone held sideways
   * (docs/design-v1-token-panel.md 3.3). Typed math works from the field alone.
   */
  fieldFirst?: boolean;
  rest?: HpRest;
  /** A group's standing note, which the status line shows while the field is empty. */
  standing?: string | null;
  /** More of the field's description, such as a group's notes while the strip rests. */
  describedBy?: string;
}) {
  const actions = useRoomActions();
  // What was typed before a blackout unmounted the entry comes back with it (hpDraft.ts).
  const key = hpDraftKey(props.place, props.targets);
  const kept = useKeptHpDraft(key);
  const [mode, setMode] = useState<HpMode>(kept?.mode ?? "damage");
  const [text, setText] = useState(kept?.text ?? "");
  const [crit, setCrit] = useState(kept?.crit ?? false);
  useKeepHpDraft(key, { mode, text, crit });
  const [error, setError] = useState<string | null>(null);
  const modes = props.access === "all" ? HP_MODES : HP_MODES.filter((m) => m.mode === "damage" || m.mode === "heal");
  const preview = text.trim() ? parseHpInput(text, mode) : null;
  // At 0 HP and dying or stable, damage can be a critical hit: two failed death saves.
  const atZero = props.targets.some((t) => t.atZero);
  const showCrit = atZero && (preview?.ok ? preview.change.kind === "damage" : mode === "damage");
  const sendsCrit = critSent({ crit, atZero, mode, preview });
  const reach = props.targets.filter((t) => t.access !== "none").length;
  // Typed math such as =12 may ask for what this viewer cannot send, which shows at once in the summary's place.
  const refusal = preview?.ok ? entryRefusal(props.access, preview.change, props.targets.length) : null;
  // What will be sent decides the lines on the dead: the typed text once it parses and may go, the chosen mode otherwise.
  const revives = useRoomView((s) => healRevivesDead(s.view?.meta.settings ?? {}));
  const dm = useRoomView((s) => s.you?.role === "dm");
  const operation = entryOperation(props.access, mode, preview);
  const lines = deadLines(props.targets, operation, { revives, dm });
  // The newest rolled damage or healing, offered under Damage and Heal (docs/design-v1-roll-options.md 4.3).
  const chips = useHpChips(mode === "damage" || mode === "heal" ? mode : null);
  const markApplied = useMarkChipApplied();
  // The chip whose amount the field holds, so Apply takes that chip away and sends its rolled damage types. Once the viewer types or picks another mode, the amount is their own, and carries no types.
  const [filled, setFilled] = useState<HpChip | null>(null);
  const rest = props.rest;
  const resting = rest?.resting === true;
  const descriptionId = useId();

  const fillFrom = (chip: HpChip) => {
    setText(String(chip.amount));
    setError(null);
    setFilled(chip);
    // A bare amount parses as damage in Damage mode, so this is when the critical box shows for it.
    if (chip.critical && atZero && mode === "damage") setCrit(true);
    // The previous chip's tick goes with it, so picking another chip never carries its critical hit over.
    else if (filled?.critical) setCrit(false);
  };

  const pickMode = (next: HpMode) => {
    setMode(next);
    setFilled(null);
  };

  const apply = () => {
    const parsed = parseHpInput(text, mode);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const refused = entryRefusal(props.access, parsed.change, props.targets.length);
    if (refused) {
      setError(refused);
      return;
    }
    sendHpEntry(actions, props.targets, parsed.change, sendsCrit, untouchedTypes(filled, text));
    if (filled) markApplied(filled.lineIds);
    setFilled(null);
    setMode(modeAfterApply(mode));
    setText("");
    setCrit(false);
    setError(null);
    props.onApplied?.();
  };

  /*
   * The status line reads what the entry would say (canvas/barButtons.ts
   * restStatus), handed up before paint, so the strip's header never
   * draws a frame behind the field. The primitives key it, since a new
   * object each render would hand it up on every render.
   */
  const left = props.targets.filter((t) => t.access === "none").map((t) => t.name);
  const said = {
    error: error ?? refusal,
    dead: restDead(props.targets, operation, { revives, dm }),
    preview: preview?.ok && refusal === null ? preview.summary : null,
    typed: text.trim() !== "",
    crit: sendsCrit,
    reach,
    left,
    standing: props.standing ?? null,
  };
  const saidKey = JSON.stringify(said);
  const onStatus = rest?.onStatus;
  useLayoutEffect(() => {
    if (onStatus) onStatus(JSON.parse(saidKey) as EntryStatus);
  }, [onStatus, saidKey]);

  /*
   * Tab and a screen reader follow what shows: the field first in the
   * short layout, the modes first otherwise, in the page's own order. A
   * flip while focus is inside the entry, as the window is resized or alert
   * cards come and go, keeps that order and shows the new one by CSS order
   * alone, since moving the focused element would drop its focus
   * (docs/design-v1-token-window.md 5.8). Once focus leaves, the order
   * follows what shows again.
   */
  const fieldFirst = props.fieldFirst === true;
  const formRef = useRef<HTMLFormElement>(null);
  const [fieldFirstInPage, setFieldFirstInPage] = useState(fieldFirst);
  useLayoutEffect(() => {
    if (fieldFirstInPage === fieldFirst) return;
    const active = document.activeElement;
    if (active && formRef.current?.contains(active)) return;
    setFieldFirstInPage(fieldFirst);
  }, [fieldFirst, fieldFirstInPage]);
  const modeButtons = (
    <Segmented<HpMode>
      key="modes"
      label="What the number does"
      even
      value={mode}
      options={modes.map((m) => ({ value: m.mode, label: m.label, chosenStyle: modeLook(m.mode) }))}
      onChange={pickMode}
      style={{ order: fieldFirst ? 1 : 0 }}
    />
  );
  // The strip's own sentences show in its header, so the field is described by the entry's whole ones (3.3).
  const describedBy = [resting ? descriptionId : null, props.describedBy ?? null].filter((id) => id !== null).join(" ") || undefined;
  // The toggle's slot stays in place while it is empty, so the field after it is never mounted afresh.
  const leadParts = (
    <>
      {resting ? <ModeToggle mode={mode} onPick={() => pickMode(nextRestMode(mode))} /> : null}
      <input
        aria-label="HP change"
        aria-describedby={describedBy}
        data-rest-field=""
        value={text}
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        // The toggle names the mode in the strip, so its sample alone is enough there.
        placeholder={resting ? MODE_SAMPLE[mode] : mode === "damage" ? "7 or -7" : mode === "heal" ? "5 or +5" : mode === "set" ? "20 or =20" : "5 or t5"}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
          setFilled(null);
        }}
        style={{ ...fieldStyle(), flex: 1, width: 0, minWidth: resting ? REST_FIELD_MIN : undefined }}
      />
      <SmallButton type="submit" tone="primary" disabled={!text.trim() || refusal !== null}>
        Apply
      </SmallButton>
    </>
  );
  const lead = <div style={{ display: "flex", gap: theme.space(1), flex: "1 1 auto", minWidth: 0 }}>{leadParts}</div>;
  // The newest rolled amount for the mode, the one the strip offers (3.3).
  const newest = useNewestChip(chips);
  const shown = (id: string) => rest?.shown == null || rest.shown.includes(id);
  const restItems: RestItem[] = resting
    ? [
        { id: "mode", node: lead },
        ...(showCrit
          ? [
              {
                id: "crit",
                node: (
                  <Button size="sm" pressed={crit} aria-label={CRIT_WORDS} title={CRIT_WORDS} onClick={() => setCrit(!crit)}>
                    Crit
                  </Button>
                ),
              },
            ]
          : []),
        ...(newest
          ? [
              {
                id: "useRoll",
                node: (
                  <Button size="sm" aria-label={newest.text} title={newest.text} onClick={() => fillFrom(newest)}>
                    {`Use ${newest.amount}`}
                  </Button>
                ),
              },
            ]
          : []),
        ...rest!.items,
      ]
    : [{ id: "mode", node: lead }];
  // The same wrapper in both states of an upright bar, so the field under it is never mounted afresh.
  const fieldRow = rest ? (
    <div key="field" style={{ order: !resting && fieldFirst ? 0 : 1, minWidth: 0 }}>
      <RestRow items={restItems} />
    </div>
  ) : (
    <div key="field" style={{ display: "flex", gap: theme.space(1), order: fieldFirst ? 0 : 1 }}>
      {leadParts}
    </div>
  );
  // The strip's quick row stands in the modes' place, and the scrolling strip holds what the row leaves out under it (5.4).
  const rows = resting ? [fieldRow] : fieldFirstInPage ? [fieldRow, modeButtons] : [modeButtons, fieldRow];
  const chipRow = resting && !rest!.scrolls ? [] : chips.filter((chip) => !(resting && chip === newest && shown("useRoll")));
  const critBox = showCrit && (!resting || (rest!.scrolls && !shown("crit")));
  const feedback =
    error || refusal ? (
      <Note tone="error">{error ?? refusal}</Note>
    ) : preview?.ok ? (
      <Note>{reach > 1 ? `${preview.summary}, to each of ${reach}` : preview.summary}</Note>
    ) : null;

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setFieldFirstInPage(fieldFirst);
      }}
      style={{ display: "grid", gap: theme.space(1) }}
    >
      <div style={{ display: "grid", gap: theme.space(1) }}>{rows}</div>
      {chipRow.length > 0 ? (
        <ChipRow label="Rolled amounts">
          {chipRow.map((chip) => (
            // A long label wraps inside its chip rather than pushing the entry wider than a phone.
            <span key={chip.lineId} style={{ display: "grid", maxWidth: "100%" }}>
              <Chip onClick={() => fillFrom(chip)}>
                <span style={{ whiteSpace: "normal", textAlign: "center" }}>{chip.text}</span>
              </Chip>
            </span>
          ))}
        </ChipRow>
      ) : null}
      {critBox ? <Checkbox checked={crit} onChange={setCrit} label={CRIT_WORDS} /> : null}
      {resting ? (
        <>
          <div id={descriptionId} style={VISUALLY_HIDDEN}>
            {feedback}
            {lines.map((line) => (
              <Note key={line}>{line}</Note>
            ))}
          </div>
          {/* Said once as it comes, since the strip shows it in its header, away from the field (3.3). */}
          <span role="status" style={VISUALLY_HIDDEN}>
            {error ?? refusal ?? ""}
          </span>
        </>
      ) : (
        <>
          {feedback}
          {lines.map((line) => (
            <Note key={line}>{line}</Note>
          ))}
        </>
      )}
    </form>
  );
}

/** The Crit toggle's and box's words: what a critical hit at 0 HP does. */
const CRIT_WORDS = "Critical Hit (two failed Death Saves)";

/** Each mode's sample, the strip's placeholder, since its toggle names the mode. */
const MODE_SAMPLE: Record<HpMode, string> = { damage: "7", heal: "5", set: "20", temp: "5" };

/** Each mode as the strip's toggle draws it, a sign in the mode's color. */
const MODE_SIGN: Record<HpMode, string> = { damage: "\u2212", heal: "+", set: "=", temp: "T" };

/**
 * The strip's mode toggle (3.3, D-261024-10 and 13): one 44 px button that
 * draws the entry's mode as its sign, named and tipped by the mode, and a
 * tap switches Damage and Heal, so an iPhone's number pad, which has no
 * plus key, can heal.
 */
function ModeToggle(props: { mode: HpMode; onPick(): void }) {
  const name = HP_MODES.find((m) => m.mode === props.mode)?.label ?? props.mode;
  const tooltip = useTooltip(name);
  return (
    <>
      <button
        type="button"
        aria-label={name}
        data-rest-mode={props.mode}
        {...tooltip.anchor()}
        onClick={props.onPick}
        style={{
          flex: "none",
          width: theme.touch,
          height: theme.touch,
          display: "grid",
          placeItems: "center",
          padding: 0,
          borderRadius: theme.radius.md,
          ...modeLook(props.mode),
          color: modeColor(props.mode),
          fontFamily: theme.font.body,
          fontSize: theme.font.heading,
          fontWeight: theme.weight.bold,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        <span aria-hidden>{MODE_SIGN[props.mode]}</span>
      </button>
      {tooltip.tip}
    </>
  );
}

/** The newest of the entry's rolled amounts, by its place in the log: this viewer's own or another's. */
function useNewestChip(chips: readonly HpChip[]): HpChip | null {
  const log = useRoomView((s) => s.view?.log);
  if (chips.length <= 1) return chips[0] ?? null;
  const at = (chip: HpChip) => log?.findLastIndex((e) => e.id === chip.lineId) ?? -1;
  return chips.reduce((a, b) => (at(b) > at(a) ? b : a));
}

function modeColor(mode: HpMode): string {
  switch (mode) {
    case "damage":
      return theme.color.danger;
    case "heal":
      return theme.color.success;
    case "set":
      return theme.color.accent;
    case "temp":
      return theme.color.ally;
  }
}

/** The chosen mode's faint fill. Set takes the accent's own tint: the accent is a CSS variable, so no alpha can be appended to it. */
function modeFill(mode: HpMode): string {
  return mode === "set" ? theme.color.accentTint : `${modeColor(mode)}33`;
}

/** The chosen mode in its own color rather than the accent: red for damage and green for healing carry meaning (docs/design-v1-visual.md 2.3). */
function modeLook(mode: HpMode): CSSProperties {
  return { border: `${theme.line.border}px solid ${modeColor(mode)}`, background: modeFill(mode), color: theme.color.text };
}

const LIFE_TEXT: Record<LifeState, string> = { alive: "", dying: "Dying", stable: "Stable", dead: "Dead" };

export function HpSection(props: {
  actor: HpActor | undefined;
  hpVisibility: HpVisibility | undefined;
  target: ActorTarget;
  access: { full: boolean; hp: HpAccessLevel; deathSaves: boolean; life: boolean };
  /** The creature's name, for the entry's lines on the dead. */
  name?: string;
  /** The token, when there is one: an effect companion and every object have no life controls (docs/design-v1-combat-flow.md 3.6.6). */
  token?: { kind: TokenKind; companion?: unknown };
}) {
  const { actor, access, target } = props;
  const actions = useRoomActions();
  const display = hpDisplay({ actor, hpVisibility: props.hpVisibility, fullAccess: access.full });
  const hp = actor?.hp;
  const life = actor?.life ?? "alive";
  const atZero = !!hp && hp.cur === 0 && (life === "dying" || life === "stable");

  // No HP to show (hpLess): one line, and for a maximum of 0 the field that gives it HP, and nothing else.
  if (hpLess(actor, props.token)) {
    const effect = props.token?.companion !== undefined && props.token.kind === "object";
    return (
      <Section title="Hit Points">
        <Note>{effect ? "No HP: it is an effect." : "No HP yet."}</Note>
        {!effect && access.hp === "all" ? (
          <FieldRow label="Max HP">
            <NumberField
              label="Max HP"
              value={0}
              min={0}
              max={MAX_HP_AMOUNT}
              onCommit={(n) => n !== null && actions.dispatch({ t: "actor.hp", target, change: { kind: "set", max: n } })}
            />
          </FieldRow>
        ) : null}
      </Section>
    );
  }

  return (
    <Section title="Hit Points">
      {access.full && hp ? (
        // Focusable from script alone: where focus goes once a life button takes itself away (LifeControls).
        <div data-hp-vitals="" tabIndex={-1} style={{ display: "flex", alignItems: "baseline", gap: theme.space(2), flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
          <span style={{ fontSize: theme.font.display, fontWeight: theme.weight.bold }}>{hp.cur}</span>
          <span style={{ color: theme.color.textMuted }}>/ {hp.max}</span>
          {hp.temp > 0 ? <span style={{ color: theme.color.ally, fontWeight: theme.weight.strong }}>+{hp.temp} temp</span> : null}
          <span style={{ flex: 1 }} />
          <LifeBadge life={life} label={hpLabel({ hp, life })} />
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={{ fontSize: theme.font.heading, fontWeight: theme.weight.strong, fontVariantNumeric: "tabular-nums" }}>{hpText(display) ?? "Hidden"}</span>
          {display.kind === "bar" ? <Bar fraction={display.fraction} /> : null}
        </div>
      )}

      {access.hp !== "none" ? (
        <HpEntry targets={[oneTarget(target, access.hp, atZero, { name: props.name ?? "it", dead: life === "dead", max: hp?.max })]} access={access.hp} place="panel" />
      ) : null}

      {access.hp === "all" && hp ? (
        // Side by side at every width (docs/design-v1-token-panel.md 3.7): two equal columns, and where a column cannot hold a
        // label beside its field, both labels go above their fields together (globals.css), so the pair never staggers.
        <div
          role="group"
          aria-label="Maximum and Temporary HP"
          data-rvtt-hp-pair=""
          style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: theme.space(4), containerType: "inline-size" }}
        >
          <LabeledNumber label="Max HP">
            <NumberField
              label="Max HP"
              width="100%"
              value={hp.max}
              min={0}
              max={MAX_HP_AMOUNT}
              onCommit={(n) => n !== null && actions.dispatch({ t: "actor.hp", target, change: { kind: "set", max: n } })}
            />
          </LabeledNumber>
          <LabeledNumber label="Temp HP">
            <NumberField
              label="Temporary HP"
              width="100%"
              value={hp.temp}
              min={0}
              max={MAX_HP_AMOUNT}
              onCommit={(n) => n !== null && actions.dispatch({ t: "actor.hp", target, change: { kind: "temp", amount: n } })}
            />
          </LabeledNumber>
        </div>
      ) : null}

      {life === "dying" && actor?.deathSaves ? (
        <DeathSaves
          saves={actor.deathSaves}
          canEdit={access.deathSaves}
          target={target}
          onChange={(ok, fail) => actions.dispatch({ t: "actor.deathSave", target, ok, fail })}
        />
      ) : null}
      {life === "stable" ? <Note>Stable: Unconscious, but no more Death Saving Throws.</Note> : null}

      {/* No HP rule kills an object, so its life controls would only ever mark one dead by hand (3.6.6). */}
      {access.life && props.token?.kind !== "object" ? <LifeControls life={life} onLife={(next) => actions.dispatch({ t: "actor.life", target, life: next })} /> : null}
    </Section>
  );
}

/**
 * A number field with its short visible label beside it, one column of the
 * HP pair. The field keeps its own accessible name ("Temporary HP" under
 * the visible "Temp HP"). Its box gives up a few pixels before the label
 * would push it out of its column, for a font whose label runs wider than
 * the pair's switch to labels above allows for.
 */
function LabeledNumber(props: { label: string; children: ReactNode }) {
  return (
    <div data-rvtt-labeled="" style={{ display: "flex", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1), minHeight: theme.touch, minWidth: 0 }}>
      <span aria-hidden style={{ fontSize: theme.font.body14, color: theme.color.text, whiteSpace: "nowrap" }}>
        {props.label}
      </span>
      <span style={{ display: "flex", width: NUMBER_FIELD_WIDTH, maxWidth: "100%", minWidth: 0, flexShrink: 1 }}>{props.children}</span>
    </div>
  );
}

function LifeBadge(props: { life: LifeState; label: string }) {
  const text = LIFE_TEXT[props.life] || props.label;
  const tone = props.life === "dead" || props.life === "dying" ? "danger" : props.label === "Bloodied" ? "warning" : "success";
  return <Tag tone={tone}>{text}</Tag>;
}

function Bar(props: { fraction: number }) {
  const color = props.fraction > 0.5 ? theme.color.success : props.fraction > 0.25 ? theme.color.warning : theme.color.danger;
  return (
    <span style={{ flex: 1, height: 8, borderRadius: theme.radius.xs, background: theme.color.surfaceRaised, overflow: "hidden" }}>
      <span style={{ display: "block", width: `${Math.round(props.fraction * 100)}%`, height: "100%", background: color }} />
    </span>
  );
}

/**
 * Three success and three failure pips. Tapping the third pip of a row
 * fills three, tapping a filled last pip empties it again, so a mistap is
 * one more tap to undo. The rules turn three of either into stable or dead.
 * With the creature as `target`, whoever may change the counts also gets
 * Roll (DeathRoll).
 */
export function DeathSaves(props: { saves: { ok: number; fail: number }; canEdit: boolean; target?: ActorTarget; onChange(ok: number, fail: number): void }) {
  const { ok, fail } = props.saves;
  const pip = (kind: "ok" | "fail", i: number) => {
    const count = kind === "ok" ? ok : fail;
    const filled = i < count;
    const next = filled && i === count - 1 ? i : i + 1;
    const color = kind === "ok" ? theme.color.success : theme.color.danger;
    return (
      <button
        key={`${kind}${i}`}
        type="button"
        disabled={!props.canEdit}
        aria-label={`${kind === "ok" ? "Successes" : "Failures"}: set to ${next}`}
        onClick={() => (kind === "ok" ? props.onChange(next, fail) : props.onChange(ok, next))}
        style={{
          width: theme.touch,
          height: theme.touch,
          display: "grid",
          placeItems: "center",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: props.canEdit ? "pointer" : "default",
        }}
      >
        <span style={{ width: 24, height: 24, borderRadius: theme.radius.round, border: `${theme.line.strong}px solid ${color}`, background: filled ? color : "transparent" }} />
      </button>
    );
  };
  const note = <Note>Death Saves{props.canEdit ? ": tap to fill" : ""}</Note>;
  return (
    <div style={{ display: "grid", gap: theme.space(0.5) }}>
      {props.canEdit && props.target ? <DeathRoll target={props.target}>{note}</DeathRoll> : note}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ width: 72, fontSize: theme.font.small, color: theme.color.textMuted }}>Successes</span>
        {[0, 1, 2].map((i) => pip("ok", i))}
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ width: 72, fontSize: theme.font.small, color: theme.color.textMuted }}>Failures</span>
        {[0, 1, 2].map((i) => pip("fail", i))}
      </div>
    </div>
  );
}

/**
 * The death save row's Roll (docs/design-v1-roll-options.md 4.5), beside
 * the row's note, with its result on one line under it. It sends
 * `actor.deathRoll`, which the server rolls and counts from the state
 * then, so nothing follows once the line lands and a heal meanwhile is
 * never overwritten. The row key is the Dice panel's own, so both show
 * the same newest result. It waits, saying why, while this device shows
 * the creature's Regeneration open (docs/design-v1-combat-controls.md 2.3).
 */
function DeathRoll(props: { target: ActorTarget; children: ReactNode }) {
  const { target } = props;
  const option = useRollOption();
  const waits = useDeathSaveWaits(target);
  const blocked = useRollBlocked() ?? (waits ? WAITS_FOR_REGENERATION : null);
  const { dice } = useDiceView([target]);
  const row = `deathSave:${"tokenId" in target ? target.tokenId : target.characterId}`;
  const { receipt, rolls, waiting } = useRowResult(row);
  const blockedId = useId();
  const roll = () => {
    if (waiting || blocked || !dice) return;
    // The preset is read at the tap, from the creature's effects then (presets.ts). While its turn's death save is open, the roll settles it (docs/design-v1-combat-controls.md 2.3).
    option.deathSave(target, presetFor(dice, target, { kind: "deathSave" }), row, openRecord(dice.view.encounter, actorOf(dice.view, target), "deathSave"));
  };
  const said = blocked
    ? null
    : receipt?.state === "refused"
      ? receipt.text || receipt.message
      : receipt?.state === "unknown"
        ? "This may have happened. Check the log."
        : rolls.length > 0
          ? resultWords(rolls, "d20")
          : null;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2) }}>
        {props.children}
        <Button
          size="sm"
          busy={waiting}
          disabled={blocked !== null || !dice}
          aria-label={waiting ? "Rolling a Death Save" : "Roll a Death Save"}
          aria-describedby={blocked ? blockedId : undefined}
          onClick={roll}
          style={{ flex: "none", whiteSpace: "nowrap" }}
        >
          {waiting ? "Rolling…" : "Roll"}
        </Button>
      </div>
      {blocked ? (
        <span id={blockedId} style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
          {blocked}
        </span>
      ) : said ? (
        <span role="status" style={{ fontSize: theme.font.small, color: receipt?.state === "refused" ? theme.color.dangerText : theme.color.textMuted, overflowWrap: "anywhere" }}>
          {said}
        </span>
      ) : null}
    </>
  );
}

/**
 * The DM's direct life changes. Reviving at 0 HP gives 1 HP, so nobody
 * stands alive at 0. Each button goes with the state it changes, so focus
 * moves to the section's HP line, which reads the new state. Not the HP
 * field, where Ctrl+Z would not reach the room's undo, and not the button
 * that comes in its place, where a second Enter would undo the change.
 */
function LifeControls(props: { life: LifeState; onLife(life: LifeState): void }) {
  const { life } = props;
  const root = useRef<HTMLDivElement>(null);
  const press = (next: LifeState) => {
    props.onLife(next);
    handFocusOn(root.current?.closest("section") ?? root.current?.parentElement, ["[data-hp-vitals]"]);
  };
  return (
    <div ref={root} data-life-controls="" style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
      {life !== "alive" ? <SmallButton onClick={() => press("alive")}>Revive</SmallButton> : null}
      {life === "dying" ? <SmallButton onClick={() => press("stable")}>Stabilize</SmallButton> : null}
      {life !== "dead" ? (
        <SmallButton tone="danger" onClick={() => press("dead")}>
          Mark dead
        </SmallButton>
      ) : null}
    </div>
  );
}
