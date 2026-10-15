import { useState, type CSSProperties } from "react";
import type { Actor, HpVisibility, LifeState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Checkbox } from "../../components/Checkbox.tsx";
import { fieldStyle } from "../../components/Field.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Tag } from "../../components/Tag.tsx";
import { hpDisplay, hpLabel, hpText, type HpView } from "../../lib/tokenView.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { sendHpEntry, type HpTarget } from "./groupHp.ts";
import { hpDraftKey, useKeepHpDraft, useKeptHpDraft } from "./hpDraft.ts";
import { HP_MODES, MAX_HP_AMOUNT, modeAfterApply, parseHpInput, type HpMode } from "./hpInput.ts";
import { FieldRow, Note, NumberField, Section, SmallButton } from "./ui.tsx";

/**
 * HP, temporary HP, death saves and life state (design section 9.6). Every
 * change goes through `actor.hp`, `actor.deathSave` or `actor.life`, so the
 * shared rules decide what 0 HP means for this kind of creature.
 */

type HpActor = HpView & Partial<Pick<Actor, "deathSaves">>;

export type HpAccessLevel = "all" | "relative" | "none";

/** The HP entry's target for a single creature. */
export function oneTarget(target: ActorTarget, access: HpAccessLevel, atZero: boolean): HpTarget {
  return { holder: "tokenId" in target ? `token:${target.tokenId}` : `character:${target.characterId}`, target, name: "", access, atZero };
}

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
  onApplied?(): void;
}) {
  const actions = useRoomActions();
  // What was typed before a blackout unmounted the entry comes back with it (hpDraft.ts).
  const key = hpDraftKey(props.targets);
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
  const reach = props.targets.filter((t) => t.access !== "none").length;

  const apply = () => {
    const parsed = parseHpInput(text, mode);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (props.access === "relative" && parsed.change.kind !== "damage" && parsed.change.kind !== "heal") {
      setError("You can only deal damage to or heal this creature.");
      return;
    }
    sendHpEntry(actions, props.targets, parsed.change, crit && showCrit);
    setMode(modeAfterApply(mode));
    setText("");
    setCrit(false);
    setError(null);
    props.onApplied?.();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      style={{ display: "grid", gap: theme.space(1) }}
    >
      <Segmented<HpMode>
        label="What the number does"
        even
        value={mode}
        options={modes.map((m) => ({ value: m.mode, label: m.label, chosenStyle: modeLook(m.mode) }))}
        onChange={setMode}
      />
      <div style={{ display: "flex", gap: theme.space(1) }}>
        <input
          aria-label="HP change"
          value={text}
          inputMode="numeric"
          enterKeyHint="done"
          autoComplete="off"
          placeholder={mode === "damage" ? "7 or -7" : mode === "heal" ? "5 or +5" : mode === "set" ? "20 or =20" : "5 or t5"}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          style={{ ...fieldStyle(), flex: 1, width: 0 }}
        />
        <SmallButton type="submit" tone="primary" disabled={!text.trim()}>
          Apply
        </SmallButton>
      </div>
      {showCrit ? (
        <Checkbox checked={crit} onChange={setCrit} label="Critical hit (two failed death saves)" />
      ) : null}
      {error ? <Note tone="error">{error}</Note> : preview?.ok ? <Note>{reach > 1 ? `${preview.summary}, to each of ${reach}` : preview.summary}</Note> : null}
    </form>
  );
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
}) {
  const { actor, access, target } = props;
  const actions = useRoomActions();
  const display = hpDisplay({ actor, hpVisibility: props.hpVisibility, fullAccess: access.full });
  const hp = actor?.hp;
  const life = actor?.life ?? "alive";
  const atZero = !!hp && hp.cur === 0 && (life === "dying" || life === "stable");

  return (
    <Section title="Hit points">
      {access.full && hp ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: theme.space(2), flexWrap: "wrap" }}>
          <span style={{ fontSize: theme.font.display, fontWeight: theme.weight.bold }}>{hp.cur}</span>
          <span style={{ color: theme.color.textMuted }}>/ {hp.max}</span>
          {hp.temp > 0 ? <span style={{ color: theme.color.ally, fontWeight: theme.weight.strong }}>+{hp.temp} temp</span> : null}
          <span style={{ flex: 1 }} />
          <LifeBadge life={life} label={hpLabel({ hp, life })} />
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={{ fontSize: theme.font.heading, fontWeight: theme.weight.strong }}>{hpText(display) ?? "Hidden"}</span>
          {display.kind === "bar" ? <Bar fraction={display.fraction} /> : null}
        </div>
      )}

      {access.hp !== "none" ? <HpEntry targets={[oneTarget(target, access.hp, atZero)]} access={access.hp} /> : null}

      {access.hp === "all" && hp ? (
        <>
          <FieldRow label="Max HP">
            <NumberField
              label="Max HP"
              value={hp.max}
              min={0}
              max={MAX_HP_AMOUNT}
              onCommit={(n) => n !== null && actions.dispatch({ t: "actor.hp", target, change: { kind: "set", max: n } })}
            />
          </FieldRow>
          <FieldRow label="Temporary HP">
            <NumberField
              label="Temporary HP"
              value={hp.temp}
              min={0}
              max={MAX_HP_AMOUNT}
              onCommit={(n) => n !== null && actions.dispatch({ t: "actor.hp", target, change: { kind: "temp", amount: n } })}
            />
          </FieldRow>
        </>
      ) : null}

      {life === "dying" && actor?.deathSaves ? (
        <DeathSaves saves={actor.deathSaves} canEdit={access.deathSaves} onChange={(ok, fail) => actions.dispatch({ t: "actor.deathSave", target, ok, fail })} />
      ) : null}
      {life === "stable" ? <Note>Stable: unconscious, but no more death saves.</Note> : null}

      {access.life ? <LifeControls life={life} onLife={(next) => actions.dispatch({ t: "actor.life", target, life: next })} /> : null}
    </Section>
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
 */
export function DeathSaves(props: { saves: { ok: number; fail: number }; canEdit: boolean; onChange(ok: number, fail: number): void }) {
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
  return (
    <div style={{ display: "grid", gap: theme.space(0.5) }}>
      <Note>Death saves{props.canEdit ? ": tap to fill" : ""}</Note>
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

/** The DM's direct life changes. Reviving at 0 HP gives 1 HP, so nobody stands alive at 0. */
function LifeControls(props: { life: LifeState; onLife(life: LifeState): void }) {
  const { life } = props;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
      {life !== "alive" ? <SmallButton onClick={() => props.onLife("alive")}>Revive</SmallButton> : null}
      {life === "dying" ? <SmallButton onClick={() => props.onLife("stable")}>Stabilize</SmallButton> : null}
      {life !== "dead" ? (
        <SmallButton tone="danger" onClick={() => props.onLife("dead")}>
          Mark dead
        </SmallButton>
      ) : null}
    </div>
  );
}
