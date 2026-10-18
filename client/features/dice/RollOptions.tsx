import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bonusFor, type D20Test, type NamedRoll } from "#shared/dice/bonus.ts";
import { critRuleOf } from "#shared/dice/crit.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type RoomState, type SkillKey } from "#shared/model.ts";
import { playersToken } from "#shared/project.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { pcSlots } from "#shared/rules/pcStats.ts";
import { SKILLS } from "#shared/rules/skills.ts";
import { ABILITY_NAMES as ABILITY_SHORT } from "#shared/statBlock.ts";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Switch } from "../../components/Switch.tsx";
import { startInScrollBox } from "../../lib/reveal.ts";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { PanelProps } from "../panels.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { useOpenPcStats } from "../pcstats/open.ts";
import { editsPcStats } from "../tokens/access.ts";
import { Note, Section, SmallButton, Stepper } from "../tokens/ui.tsx";
import { creatureRolls, type CreatureRolls, type DiceView } from "./creature.ts";
import {
  creatureKey,
  critical,
  CRIT_WORDS,
  cutLabel,
  damageRolls,
  initiativeRow,
  namedRoll,
  partToggleText,
  playerCreatures,
  presetLine,
  readUsed,
  resultWords,
  routedTest,
  routeOf,
  scoreOf,
  signedText,
  spendOnStart,
  testLabel,
  withUsed,
  writeUsed,
} from "./options.ts";
import { useOption, useOptionStore } from "./optionState.ts";
import { presetFor } from "./presets.ts";
import { useDiceView } from "./useDiceView.ts";
import { GroupOptions } from "./groupSave/GroupOptions.tsx";
import { useStartGroupSave } from "./groupSave/start.ts";
import { ReplaceConfirm } from "./groupSave/ReplaceConfirm.tsx";
import { actionFill } from "./groupSave/fills.ts";
import { useActOnce, useInitiativeChanged, useRollBlocked, useRollOption, useRowResult, useWatchInitiative } from "./useRollOption.ts";

/** Room above the options when the panel opens on them: the sticky line's height and a little. */
const OPTIONS_MARGIN = 48;

/**
 * A creature's roll options, between the roller and Recent rolls
 * (docs/design-v1-roll-options.md 4): the DM's selected token, or the
 * character or companion a player picks. Every button is 44 px and rolls on
 * the server at once, shows busy until its line lands, and its row then
 * shows the newest result in place. The stat block views stay text.
 */
export function RollOptions(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role ?? null);
  const selected = useRoomView((s) => s.local.selectedIds);
  const view = useRoomView((s) => s.view);
  const focus = useOption((s) => s.focus);
  const options = useOptionStore();
  const ref = useRef<HTMLDivElement>(null);
  // A bar's Roll opens the panel on its tokens and scrolls to here (4.1), after the render that lists them, once per tap.
  // Only the panel's own scroller moves, just under the sticky line: scrollIntoView also scrolled the sheet's frame and hid its header (LP7-DICE-6).
  useEffect(() => {
    if (focus === 0 || options.getState().focused === focus) return;
    options.setState({ focused: focus });
    requestAnimationFrame(() => {
      const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (ref.current) startInScrollBox(ref.current, OPTIONS_MARGIN, !still);
    });
  }, [focus, options]);
  if (!view || !role) return null;
  let body: ReactNode;
  if (role === "dm") {
    const id = selected.length === 1 ? selected[0] : undefined;
    const token = id !== undefined ? view.tokens[id] : undefined;
    if (selected.length === 0) body = <Note>Select a token to roll for it.</Note>;
    else if (selected.length > 1) body = <GroupOptions tokenIds={selected} />;
    else if (!token) body = <Note>Select a token to roll for it.</Note>;
    else body = <CreatureOptions key={token.id} creature={{ tokenId: token.id }} tokenId={token.id} name={displayName(token)} />;
  } else body = <PlayerOptions view={view} selected={selected} />;
  return (
    <div ref={ref} data-roll-options="" style={{ display: "grid", gap: theme.space(2), scrollMarginTop: OPTIONS_MARGIN }}>
      {body}
    </div>
  );
}

/**
 * A player's creatures (4.1, `playerCreatures`) by chips: their
 * characters, those characters' companions, and every other token they
 * own on the scene. The first pick is the selected token when it is
 * theirs, so a bar's Roll lands on it, else their character, and a tap
 * keeps its pick for the page. Other creatures are never offered, since
 * the server refuses them.
 */
function PlayerOptions(props: { view: RoomState; selected: readonly string[] }) {
  const me = useRoomView((s) => s.you?.memberId ?? "");
  const sceneId = useRoomView((s) => s.sceneId);
  const picked = useOption((s) => s.picked);
  const store = useOptionStore();
  const { view } = props;
  const options = useMemo(() => playerCreatures(view, me, sceneId, displayName), [view, me, sceneId]);
  const last = props.selected[props.selected.length - 1];
  const selectedKey = last !== undefined ? creatureKey(view, { tokenId: last }) : null;
  const current = options.find((o) => o.key === picked) ?? options.find((o) => o.key === selectedKey) ?? options[0];
  if (!current) return <Note>Your character's rolls show here once you play one.</Note>;
  return (
    <>
      {options.length > 1 ? (
        <ChipRow label="Roll for">
          {options.map((o) => (
            <Chip key={o.key} pressed={o.key === current.key} onClick={() => store.setState({ picked: o.key })}>
              {o.name}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      <CreatureOptions key={current.key} creature={current.creature} tokenId={current.tokenId} name={current.name} />
    </>
  );
}

function CreatureOptions(props: { creature: ActorTarget; tokenId?: string | undefined; name: string }) {
  const { creature } = props;
  const creatures = useMemo(() => [creature], [creature]);
  const { dice, failed } = useDiceView(creatures);
  const rolls = dice ? creatureRolls(dice, creature) : null;
  if (failed) return <SrdLoadFailed what="The roll options" inline />;
  if (!dice || !rolls) return <Loading text="Loading the roll options…" />;
  return <OptionsList dice={dice} rolls={rolls} creature={creature} tokenId={props.tokenId} name={props.name} />;
}

type Ctx = {
  dice: DiceView;
  rolls: CreatureRolls;
  creature: ActorTarget;
  tokenId: string | undefined;
  key: string;
  played: boolean;
  ask: boolean;
  blocked: string | null;
};

function OptionsList(props: { dice: DiceView; rolls: CreatureRolls; creature: ActorTarget; tokenId: string | undefined; name: string }) {
  const { dice, rolls, creature } = props;
  const state = dice.view;
  const dm = dice.you.role === "dm";
  const key = creatureKey(state, creature);
  const token = props.tokenId !== undefined ? state.tokens[props.tokenId] : undefined;
  const characterId = "characterId" in creature ? creature.characterId : token && "ref" in token.actor ? token.actor.ref : undefined;
  const character = characterId !== undefined ? state.characters[characterId] : undefined;
  const played = dm && (token ? playersToken(state, token) : character !== undefined && character.ownerIds.some((id) => state.members[id]?.kind === "player"));
  const askOff = useOption((s) => s.askOff[key] === true);
  const store = useOptionStore();
  const blocked = useRollBlocked();
  const openPcStats = useOpenPcStats();
  const ctx: Ctx = { dice, rolls, creature, tokenId: props.tokenId, key, played, ask: played && !askOff, blocked };
  const [skillsOpen, setSkillsOpen] = useState(false);
  const actor = token && "inline" in token.actor ? token.actor.inline : character?.actor;
  const numbers = rolls.numbers;
  const named = rolls.named.filter((r) => r.section !== "spells");
  const spells = rolls.named.filter((r) => r.section === "spells");

  return (
    <section aria-label={`Rolls for ${props.name}`} style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>Rolls for {props.name}</div>
      {blocked ? <Note tone="info">{blocked}</Note> : null}
      {played ? (
        <Switch
          label={`Ask ${props.name} to roll`}
          help="A save or check tap opens Request a roll. Off, it rolls here."
          checked={!askOff}
          onChange={(on) => store.setState((s) => ({ askOff: { ...s.askOff, [key]: !on } }))}
        />
      ) : null}
      {/* While dying, its death save is the one roll it makes, so it leads (W7B-P-19). */}
      {actor?.life === "dying" ? <DeathSaveCell ctx={ctx} bonus={numbers?.deathSave ?? 0} /> : null}
      {numbers ? (
        <>
          <Grid label="Saves">
            {ABILITY_KEYS.map((a) => (
              <D20Cell key={a} ctx={ctx} test={{ kind: "save", ability: a }} bonus={numbers.abilities[a].save} text={`${ABILITY_SHORT[a]} ${signedText(numbers.abilities[a].save)}`} />
            ))}
          </Grid>
          <Grid label="Checks">
            {ABILITY_KEYS.map((a) => {
              const bonus = bonusFor(numbers, { kind: "check", ability: a }) ?? 0;
              return <D20Cell key={a} ctx={ctx} test={{ kind: "check", ability: a }} bonus={bonus} text={`${ABILITY_SHORT[a]} ${signedText(bonus)}`} />;
            })}
          </Grid>
          <Section title="Skills" fold={{ open: skillsOpen, onToggle: () => setSkillsOpen((o) => !o) }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: theme.space(1) }}>
              {SKILL_KEYS.map((s: SkillKey) => {
                const ability: AbilityKey = SKILLS[s].ability;
                const bonus = bonusFor(numbers, { kind: "check", ability, skill: s }) ?? 0;
                return <D20Cell key={s} ctx={ctx} test={{ kind: "check", ability, skill: s }} bonus={bonus} text={`${SKILLS[s].name} ${signedText(bonus)}`} />;
              })}
            </div>
          </Section>
        </>
      ) : null}
      <InitiativeCell ctx={ctx} />
      {!numbers ? (
        <>
          <Note>No stat block. Roll from the field above.</Note>
          {character && actor?.srdId === undefined && editsPcStats(dice.you, character) ? (
            <div>
              <SmallButton onClick={() => openPcStats(character.id)}>Add a stat block</SmallButton>
            </div>
          ) : null}
        </>
      ) : null}
      {ACTION_SECTIONS.map(([section, title]) => {
        const these = named.filter((r) => r.section === section);
        const multiattack = section === "actions" ? rolls.multiattack : null;
        if (these.length === 0 && multiattack === null) return null;
        return (
          <div key={section} role="group" aria-label={title} style={{ display: "grid", gap: theme.space(2) }}>
            <GroupLabel>{title}</GroupLabel>
            {multiattack !== null ? <Note>Multiattack. {multiattack}</Note> : null}
            {these.map((r) => (
              <NamedRow key={r.key} ctx={ctx} named={r} />
            ))}
          </div>
        );
      })}
      {numbers?.spellAttack !== undefined || numbers?.spellDc !== undefined || spells.length > 0 ? (
        <div role="group" aria-label="Spells" style={{ display: "grid", gap: theme.space(2) }}>
          <GroupLabel>Spells</GroupLabel>
          {numbers?.spellDc !== undefined ? <Note>Spell save DC {numbers.spellDc}</Note> : null}
          {numbers?.spellAttack !== undefined ? (
            <div style={{ maxWidth: 200 }}>
              <D20Cell ctx={ctx} test={{ kind: "attack", spell: true }} bonus={numbers.spellAttack} text={`Spell attack ${signedText(numbers.spellAttack)}`} label="Spell attack" />
            </div>
          ) : null}
          {spells.map((r) => (
            <NamedRow key={r.key} ctx={ctx} named={r} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A block's named rolls under the heading of the section they come from, so
 * a dragon's legendary Fiery Rays never reads as an action of its own turn
 * (W7B-P-14). Spells have their own group below.
 */
const ACTION_SECTIONS: readonly (readonly [Exclude<NamedRoll["section"], "spells">, string])[] = [
  ["traits", "Traits"],
  ["actions", "Actions"],
  ["bonusActions", "Bonus actions"],
  ["reactions", "Reactions"],
  ["legendaryActions", "Legendary actions"],
];

function GroupLabel(props: { children: ReactNode }) {
  return <div style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>{props.children}</div>;
}

function Grid(props: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={props.label} style={{ display: "grid", gap: theme.space(1) }}>
      <GroupLabel>{props.label}</GroupLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>{props.children}</div>
    </div>
  );
}

/** One option: a 44 px button with the preset's few words under its label, busy until its line lands, then its result under it. */
function OptionCell(props: { text: string; sub?: string | undefined; name: string; row: string; disabled: string | null; onTap(): void; result: string | null }) {
  const { receipt, waiting } = useRowResult(props.row);
  const said = receipt?.state === "refused" ? receipt.text || receipt.message : receipt?.state === "unknown" ? "This may have happened. Check the log." : props.result;
  const cell = useRef<HTMLDivElement>(null);
  const tapped = useRef(false);
  // A button tapped at the foot of the sheet gets its result under it, out of view, so the cell comes into view once, when the line lands.
  useEffect(() => {
    if (!tapped.current || waiting || !said) return;
    tapped.current = false;
    cell.current?.scrollIntoView({ block: "nearest" });
  }, [said, waiting]);
  return (
    <div ref={cell} style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <button
        type="button"
        aria-label={props.sub ? `${props.name}, ${props.sub}` : props.name}
        aria-busy={waiting ? true : undefined}
        disabled={props.disabled !== null}
        title={props.disabled ?? undefined}
        onClick={() => {
          if (waiting) return;
          tapped.current = true;
          props.onTap();
        }}
        style={{
          minHeight: theme.touch,
          padding: `${theme.space(1)}px ${theme.space(2)}px`,
          display: "grid",
          alignContent: "center",
          justifyItems: "start",
          textAlign: "left",
          borderRadius: theme.radius.md,
          border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
          background: theme.color.surfaceRaised,
          color: props.disabled !== null ? theme.color.textDisabled : theme.color.text,
          fontFamily: theme.font.body,
          cursor: props.disabled !== null || waiting ? "default" : "pointer",
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
          {waiting ? `${props.text}…` : props.text}
        </span>
        {props.sub ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, overflowWrap: "anywhere" }}>{props.sub}</span> : null}
      </button>
      {said ? (
        <span role="status" style={{ fontSize: theme.font.small, color: receipt?.state === "refused" ? theme.color.dangerText : theme.color.textMuted, overflowWrap: "anywhere" }}>
          {said}
        </span>
      ) : null}
    </div>
  );
}

/** A save, check, skill or attack button: its bonus, its preset in words, and where its tap goes. */
function D20Cell(props: { ctx: Ctx; test: D20Test; bonus: number; text: string; label?: string; critOn?: 18 | 19; rowKey?: string; onLanded?(critical: boolean): void }) {
  const { ctx, test } = props;
  const option = useRollOption();
  const route = routeOf({ state: ctx.dice.view, creature: ctx.creature, test, dm: ctx.dice.you.role === "dm", played: ctx.played, ask: ctx.ask });
  // An answer rolls the request's own test, with its `spell`, so the button shows the preset its tap sends.
  const presetOf = (t: D20Test) => presetFor(ctx.dice, ctx.creature, t, { rolls: ctx.rolls });
  const preset = presetOf(routedTest(route, test));
  const row = `${ctx.key}|${props.rowKey ?? JSON.stringify(test)}`;
  const { tag, rolls } = useRowResult(row);
  useActOnce(tag, rolls, (landed) => props.onLanded?.(critical(landed[0])));
  const label = props.label ?? testLabel(test);
  const words = presetLine(preset);
  const how = route.kind === "answer" ? "answers the DM's request" : route.kind === "ask" ? "asks the player" : "";
  const sub = [how, words].filter(Boolean).join(". ");
  return (
    <OptionCell
      text={props.text}
      sub={sub || undefined}
      name={label}
      row={row}
      disabled={ctx.blocked}
      result={rolls.length > 0 ? resultWords(rolls, test.kind === "attack" ? "attack" : "d20") : null}
      onTap={() =>
        option.d20({
          creature: ctx.creature,
          test,
          bonus: props.bonus,
          preset,
          presetOf,
          label,
          row,
          played: ctx.played,
          ask: ctx.ask,
          ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}),
          ...(props.critOn ? { critOn: props.critOn } : {}),
        })
      }
    />
  );
}

/**
 * Initiative (4.2, 4.3): "+2", in a fight "Initiative +2, sets its row",
 * and a monster in a room that uses scores "Score 12, sets its row", with
 * "Roll instead". The value is written only to a row that still holds what
 * it held at the tap, by the room's listener, so the cell may close first.
 */
function InitiativeCell(props: { ctx: Ctx }) {
  const { ctx } = props;
  const option = useRollOption();
  const watch = useWatchInitiative();
  const row = `${ctx.key}|initiative`;
  const { tag, rolls } = useRowResult(row);
  const changed = useInitiativeChanged(tag);
  const state = ctx.dice.view;
  const entry = initiativeRow(state, ctx.creature);
  const score = entry ? scoreOf(state, ctx.creature) : null;
  const dm = ctx.dice.you.role === "dm";
  const test: D20Test = { kind: "initiative" };
  const preset = presetFor(ctx.dice, ctx.creature, test, { rolls: ctx.rolls });
  const roll = () => {
    const sent = option.d20({ creature: ctx.creature, test, bonus: ctx.rolls.initBonus, preset, label: "Initiative", row, played: false, ask: false });
    if (sent !== null && sent !== "asked" && entry) watch(sent, entry.id);
  };
  const bonus = signedText(ctx.rolls.initBonus);
  const scored = score !== null && entry !== undefined;
  return (
    <div style={{ display: "grid", gap: theme.space(1), maxWidth: 320 }}>
      {scored ? (
        <SmallButton disabled={ctx.blocked !== null} onClick={() => option.setInitiative(entry.id, score, dm)}>
          {`Score ${score}, sets its row`}
        </SmallButton>
      ) : null}
      <OptionCell
        text={scored ? "Roll instead" : entry ? (entry.value === null ? `Initiative ${bonus}, sets its row` : `Initiative ${bonus}, replaces ${entry.value}`) : `Initiative ${bonus}`}
        sub={[scored ? "replaces the score" : null, presetLine(preset) || null].filter(Boolean).join(". ") || undefined}
        name="Initiative"
        row={row}
        disabled={ctx.blocked}
        result={rolls.length > 0 ? [resultWords(rolls, "d20"), changed].filter(Boolean).join(". ") : null}
        onTap={roll}
      />
    </div>
  );
}

function DeathSaveCell(props: { ctx: Ctx; bonus: number }) {
  const { ctx } = props;
  const option = useRollOption();
  const test: D20Test = { kind: "deathSave" };
  const preset = presetFor(ctx.dice, ctx.creature, test, { rolls: ctx.rolls });
  const row = `deathSave:${"tokenId" in ctx.creature ? ctx.creature.tokenId : ctx.creature.characterId}`;
  const { rolls } = useRowResult(row);
  return (
    <div style={{ maxWidth: 240 }}>
      <OptionCell
        text={`Death save ${signedText(props.bonus)}`}
        sub={presetLine(preset) || undefined}
        name="Death save"
        row={row}
        disabled={ctx.blocked}
        result={rolls.length > 0 ? resultWords(rolls, "d20") : null}
        onTap={() => option.deathSave(ctx.creature, preset, row)}
      />
    </div>
  );
}

/**
 * One named roll (4.2): its name with uses, recharge and Used, then its
 * Attack, Damage with each optional part as a toggle and Critical, Heal, a
 * plain roll, a slot level for a spell that scales, and Recharge.
 */
function NamedRow(props: { ctx: Ctx; named: NamedRoll }) {
  const { ctx } = props;
  const option = useRollOption();
  const store = useOptionStore();
  const roomId = useRoomView((s) => s.roomId);
  const rowKey = `${ctx.key}|${props.named.key}`;
  const crit = useOption((s) => s.critical[rowKey] === true);
  const critRule = useRoomView((s) => critRuleOf(s.view?.meta.settings ?? {}));
  const riders = useOption((s) => s.riders[rowKey]);
  const slotPicked = useOption((s) => s.slots[rowKey]);
  const holder = ctx.key;
  // Read on every render, since a recharge card may clear it while this row shows (6.4). The tick redraws after this row's own change.
  const [, setTick] = useState(0);
  const used = readUsed(roomId)[holder]?.includes(props.named.key) ?? false;
  const character = "characterId" in ctx.creature ? ctx.dice.view.characters[ctx.creature.characterId] : undefined;
  const slots = character && props.named.section === "spells" ? pcSlots(character, props.named.key) : null;
  const slot = slots ? Math.max(slots.from, Math.min(9, slotPicked ?? slots.from)) : null;
  const named = slots && slot !== null ? slots.at(slot) : props.named;
  const on = useMemo(() => new Set(riders ?? []), [riders]);
  const markUsed = (value: boolean) => {
    writeUsed(roomId, withUsed(readUsed(roomId), holder, props.named.key, value));
    setTick((n) => n + 1);
  };
  const toggleRider = (i: number) =>
    store.setState((s) => {
      const list = s.riders[rowKey] ?? [];
      return { riders: { ...s.riders, [rowKey]: list.includes(i) ? list.filter((x) => x !== i) : [...list, i] } };
    });
  const setCrit = (value: boolean) => store.setState((s) => ({ critical: { ...s.critical, [rowKey]: value } }));

  const recharge = named.recharge === undefined ? null : named.recharge === 6 ? "Recharge 6" : `Recharge ${named.recharge}–6`;
  const head = [named.name, named.uses ?? null, recharge].filter(Boolean).join(", ");
  const damageRow = `${rowKey}|damage`;
  const { rolls: damageLanded } = useRowResult(damageRow);
  const healRow = `${rowKey}|heal`;
  const { rolls: healLanded } = useRowResult(healRow);
  const diceRow = `${rowKey}|dice`;
  const { rolls: diceLanded } = useRowResult(diceRow);
  const rechargeRow = `${rowKey}|recharge`;
  const { tag: rechargeTag, rolls: rechargeLanded } = useRowResult(rechargeRow);
  useActOnce(rechargeTag, rechargeLanded, (landed) => {
    if ((landed[0]?.total ?? 0) >= (named.recharge ?? 7)) markUsed(false);
  });
  // Only an attack roll scores a Critical Hit (SRD 5.2.1), so a save action's damage, such as Fire Breath's, never doubles (W7B-P-13).
  const canCrit = named.attack !== undefined;
  const fixed = named.damage.filter((p) => !p.optional);
  const hasDamage = named.damage.length > 0;
  const formulaText = (fixed.length > 0 ? fixed : named.damage).map((p) => p.formula).join(" + ");
  return (
    <div style={{ display: "grid", gap: theme.space(1), paddingTop: theme.space(1), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <span style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>{head}</span>
        {named.recharge !== undefined ? (
          <SmallButton pressed={used} onClick={() => markUsed(!used)} label={used ? `${named.name} is used. Tap when it recharges` : `Mark ${named.name} used`}>
            Used
          </SmallButton>
        ) : null}
      </div>
      {slots && slot !== null ? (
        <Stepper label={`Slot level for ${named.name}`} value={slot} step={1} min={slots.from} max={9} onChange={(n) => store.setState((s) => ({ slots: { ...s.slots, [rowKey]: n } }))} />
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: theme.space(1) }}>
        {named.attack !== undefined ? (
          <D20Cell
            ctx={ctx}
            test={named.section === "spells" ? { kind: "attack", spell: true } : { kind: "attack" }}
            bonus={named.attack}
            text={`Attack ${signedText(named.attack)}`}
            label={named.name}
            rowKey={`${props.named.key}|attack`}
            {...(named.critOn ? { critOn: named.critOn } : {})}
            onLanded={(isCrit) => {
              if (isCrit) setCrit(true);
            }}
          />
        ) : null}
        {hasDamage ? (
          <OptionCell
            text={`Damage ${formulaText}`}
            sub={canCrit && crit ? CRIT_WORDS[critRule] : undefined}
            name={`${named.name} damage`}
            row={damageRow}
            disabled={ctx.blocked}
            result={damageLanded.length > 0 ? resultWords(damageLanded, "damage") : null}
            onTap={() => {
              const rolls = damageRolls(named, { on, critical: canCrit && crit, creature: ctx.creature });
              if (option.rolls(rolls, damageRow) !== null) {
                if (crit) setCrit(false);
                if (named.recharge !== undefined) markUsed(true);
              }
            }}
          />
        ) : null}
        {named.heal ? (
          <OptionCell
            text={`Heal ${named.heal.formula}`}
            name={`${named.name} healing`}
            row={healRow}
            disabled={ctx.blocked}
            result={healLanded.length > 0 ? resultWords(healLanded, "plain") : null}
            onTap={() => option.rolls([namedRoll(named.heal!.formula, `${named.name} healing`, ctx.creature)], healRow)}
          />
        ) : null}
        {named.dice ? (
          <OptionCell
            text={named.dice}
            name={named.name}
            row={diceRow}
            disabled={ctx.blocked}
            result={diceLanded.length > 0 ? resultWords(diceLanded, "plain") : null}
            onTap={() => option.rolls([namedRoll(named.dice!, named.name, ctx.creature)], diceRow)}
          />
        ) : null}
        {named.save && ctx.dice.you.role === "dm" ? <GroupSaveButton ctx={ctx} named={named} /> : null}
        {named.recharge !== undefined ? (
          <OptionCell
            text="Recharge 1d6"
            name={`${named.name} recharge`}
            row={rechargeRow}
            disabled={ctx.blocked}
            result={rechargeLanded.length > 0 ? resultWords(rechargeLanded, "recharge", { recharge: named.recharge }) : null}
            onTap={() => option.rolls([namedRoll("1d6", `${named.name} recharge`, ctx.creature)], rechargeRow)}
          />
        ) : null}
      </div>
      {hasDamage && (canCrit || named.damage.some((p) => p.optional)) ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
          {named.damage.map((part, i) =>
            part.optional ? (
              <Chip key={i} pressed={on.has(i)} onClick={() => toggleRider(i)}>
                {cutLabel(partToggleText(part))}
              </Chip>
            ) : null,
          )}
          {canCrit ? (
            <Chip pressed={crit} onClick={() => setCrit(!crit)} aria-label={`Critical hit for ${named.name}'s next damage`}>
              Critical
            </Chip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A save action's "Group save, DC 21 Dex" (5.6): the group save's setup
 * filled from the action, its rows the selection less the acting creature
 * as it changes until the roll (5.1). The button shows with one creature
 * selected, so the page opens saying to select the creatures it hits, and
 * the DM's next selection fills it.
 */
function GroupSaveButton(props: { ctx: Ctx; named: NamedRoll }) {
  const { ctx, named } = props;
  const save = named.save!;
  const start = useStartGroupSave();
  const selected = useRoomView((s) => s.local.selectedIds);
  const roomId = useRoomView((s) => s.roomId);
  const [pending, setPending] = useState(false);
  const others = selected.filter((id) => id !== ctx.tokenId);
  const filled = actionFill(ctx.dice, named, { key: ctx.key, ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}) })!;
  const source = { kind: "selection" as const, tokenIds: others, live: true as const, ...(ctx.tokenId ? { except: ctx.tokenId } : {}) };
  const input = { source, ...filled, panel: "dice" as const };
  // A recharge action is spent once its group save starts, as its Damage tap is once its roll goes, and not when the DM keeps the open one instead.
  const go = (replace: boolean) => spendOnStart(() => start(input, { replace }), named.recharge !== undefined ? () => writeUsed(roomId, withUsed(readUsed(roomId), ctx.key, named.key, true)) : null);
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <SmallButton disabled={ctx.blocked !== null} onClick={() => !go(false) && setPending(true)}>
        {`Group save, DC ${save.dc} ${ABILITY_SHORT[save.ability]}`}
      </SmallButton>
      {pending ? <ReplaceConfirm onDiscard={() => go(true) && setPending(false)} onKeep={() => setPending(false)} /> : null}
    </div>
  );
}
