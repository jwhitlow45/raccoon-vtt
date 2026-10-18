import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bonusFor, type D20Test, type NamedRoll } from "#shared/dice/bonus.ts";
import { critRuleOf } from "#shared/dice/crit.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type RoomState, type SkillKey } from "#shared/model.ts";
import { playersTypeTotals } from "#shared/permissions.ts";
import { playersToken } from "#shared/project.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { pcSlots } from "#shared/rules/pcStats.ts";
import { SKILLS } from "#shared/rules/skills.ts";
import { ABILITY_NAMES as ABILITY_SHORT } from "#shared/statBlock.ts";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Switch } from "../../components/Switch.tsx";
import { startInScrollBox } from "../../lib/reveal.ts";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { PanelProps } from "../panels.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { useOpenPcStats } from "../pcstats/open.ts";
import { parseBonus } from "../rolls/card.ts";
import { editsPcStats } from "../tokens/access.ts";
import { Note, Section, SmallButton } from "../tokens/ui.tsx";
import { sectionLabelLook } from "../../components/Panel.tsx";
import type { RollPreset } from "#shared/rules/rollReminders.ts";
import { creatureRolls, type CreatureRolls, type DiceView } from "./creature.ts";
import {
  creatureKey,
  critical,
  CRIT_WORDS,
  commonTags,
  cutLabel,
  damageRolls,
  groupNote,
  initiativeRow,
  namedRoll,
  noNumbersNote,
  playerCreatures,
  presetLine,
  presetTag,
  readUsed,
  riderToggleName,
  riderText,
  routedTest,
  rowSummary,
  routeOf,
  scoreOf,
  signedText,
  spendOnStart,
  testLabel,
  typedTap,
  typedText,
  withUsed,
  writeUsed,
  type TypedBonus,
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
            <Chip key={o.key} wrap pressed={o.key === current.key} onClick={() => store.setState({ picked: o.key })}>
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

/** Exported for its render test. */
export function OptionsList(props: { dice: DiceView; rolls: CreatureRolls; creature: ActorTarget; tokenId: string | undefined; name: string }) {
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

  // The effects that bear on a group's rolls, named once in its label rather than under each of its buttons.
  const presetOf = (test: D20Test) => presetFor(dice, creature, test, { rolls });
  const noteOf = (tests: readonly D20Test[]) => groupNote(tests.map(presetOf));
  const asks = ctx.ask ? `asks ${props.name}` : "";
  const saveTests = ABILITY_KEYS.map((a): D20Test => ({ kind: "save", ability: a }));
  const checkTests = ABILITY_KEYS.map((a): D20Test => ({ kind: "check", ability: a }));
  const saveCommon = commonTags(saveTests.map(presetOf));
  const checkCommon = commonTags(checkTests.map(presetOf));
  const attackNote = presetLine(presetOf({ kind: "attack" }));
  const spellNote = presetLine(presetOf({ kind: "attack", spell: true }));

  return (
    <section aria-label={`Rolls for ${props.name}`} style={{ display: "grid", gap: theme.space(3) }}>
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>Rolls for {props.name}</div>
        {blocked ? <Note tone="info">{blocked}</Note> : null}
        {played ? <Switch label={`Ask ${props.name} to roll saves and checks`} checked={!askOff} onChange={(on) => store.setState((s) => ({ askOff: { ...s.askOff, [key]: !on } }))} /> : null}
      </div>
      {/* While dying, its death save is the one roll it makes, so it leads (W7B-P-19). */}
      {actor?.life === "dying" ? <DeathSaveCell ctx={ctx} bonus={rolls.initBonus === null ? null : (numbers?.deathSave ?? 0)} /> : null}
      {numbers ? (
        <>
          <Grid label="Saves" note={[asks, noteOf(saveTests)].filter(Boolean).join(". ")}>
            {ABILITY_KEYS.map((a) => (
              <D20Cell key={a} ctx={ctx} test={{ kind: "save", ability: a }} bonus={numbers.abilities[a].save} text={`${ABILITY_SHORT[a]} ${signedText(numbers.abilities[a].save)}`} common={saveCommon} />
            ))}
          </Grid>
          <Grid label="Checks" note={[asks, noteOf(checkTests)].filter(Boolean).join(". ")}>
            {ABILITY_KEYS.map((a) => {
              const bonus = bonusFor(numbers, { kind: "check", ability: a }) ?? 0;
              return <D20Cell key={a} ctx={ctx} test={{ kind: "check", ability: a }} bonus={bonus} text={`${ABILITY_SHORT[a]} ${signedText(bonus)}`} common={checkCommon} />;
            })}
          </Grid>
          <Section title="Skills" fold={{ open: skillsOpen, onToggle: () => setSkillsOpen((o) => !o) }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: theme.space(1) }}>
              {SKILL_KEYS.map((s: SkillKey) => {
                const ability: AbilityKey = SKILLS[s].ability;
                const bonus = bonusFor(numbers, { kind: "check", ability, skill: s }) ?? 0;
                return <D20Cell key={s} ctx={ctx} test={{ kind: "check", ability, skill: s }} bonus={bonus} text={`${SKILLS[s].name} ${signedText(bonus)}`} common={checkCommon} />;
              })}
            </div>
          </Section>
          {rolls.initBonus !== null ? <InitiativeCell ctx={ctx} bonus={rolls.initBonus} bonusText={signedText(rolls.initBonus)} /> : null}
        </>
      ) : (
        <UnknownNumbers
          ctx={ctx}
          name={props.name}
          skillsOpen={skillsOpen}
          onSkills={() => setSkillsOpen((o) => !o)}
          addBlock={character && actor?.srdId === undefined && rolls.initBonus !== null && editsPcStats(dice.you, character) ? () => openPcStats(character.id) : null}
        />
      )}
      {ACTION_SECTIONS.map(([section, title]) => {
        const these = named.filter((r) => r.section === section);
        const multiattack = section === "actions" ? rolls.multiattack : null;
        if (these.length === 0 && multiattack === null) return null;
        return (
          <div key={section} role="group" aria-label={title} style={{ display: "grid" }}>
            <GroupLabel note={[these.some((r) => r.attack !== undefined) && attackNote ? `Attacks ${attackNote}` : "", multiattack !== null ? `Multiattack. ${multiattack}` : ""].filter(Boolean).join(". ") || undefined}>{title}</GroupLabel>
            {these.map((r) => (
              <NamedRow key={r.key} ctx={ctx} named={r} />
            ))}
          </div>
        );
      })}
      {numbers?.spellAttack !== undefined || numbers?.spellDc !== undefined || spells.length > 0 ? (
        <div role="group" aria-label="Spells" style={{ display: "grid" }}>
          <GroupLabel note={[numbers?.spellDc !== undefined ? `Save DC ${numbers.spellDc}` : "", spellNote ? `Attacks ${spellNote}` : ""].filter(Boolean).join(". ") || undefined}>Spells</GroupLabel>
          {numbers?.spellAttack !== undefined ? (
            <div style={{ ...ROW, gridTemplateColumns: "repeat(3, minmax(0, 1fr))", display: "grid", gap: theme.space(1) }}>
              <div style={{ gridColumn: "span 2" }}>
                <D20Cell ctx={ctx} test={{ kind: "attack", spell: true }} bonus={numbers.spellAttack} text={`Spell attack ${signedText(numbers.spellAttack)}`} label="Spell attack" />
              </div>
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

/**
 * A group's label in the panel's one label look (docs/design-v1-dice-ui.md 3.2), with what bears on all of its
 * rolls after it on the same line, wrapping under it where the line is full: "SAVES  +1d4: Blessed".
 */
function GroupLabel(props: { children: ReactNode; note?: string | undefined }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: theme.space(2), rowGap: 0, paddingBottom: theme.space(1) }}>
      <span style={sectionLabelLook()}>{props.children}</span>
      {props.note ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, minWidth: 0 }}>{props.note}</span> : null}
    </div>
  );
}

/** A named roll's rows sit between 1 px lines with `space(2)` above and below (3.2). */
const ROW = { paddingBlock: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}` } as const;

function Grid(props: { label: string; note?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={props.label} style={{ display: "grid" }}>
      <GroupLabel note={props.note || undefined}>{props.label}</GroupLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>{props.children}</div>
    </div>
  );
}

/**
 * One option: a 44 px button on one line, its words and a short tag for its preset ("Dis", "+1d4"), busy
 * until its line lands. Its result shows in the panel's newest-roll line at the top (the project owner,
 * 2026-10-17: "it should just be in the header"), so a row never grows when a roll lands.
 */
function OptionCell(props: { text: string; tag?: string | undefined; name: string; row: string; disabled: string | null; onTap(): void; pressed?: boolean; grow?: boolean }) {
  const { waiting } = useRowResult(props.row);
  return (
    <button
      type="button"
      aria-label={props.name}
      aria-busy={waiting ? true : undefined}
      disabled={props.disabled !== null}
      title={props.disabled ?? props.name}
      onClick={() => {
        if (waiting) return;
        props.onTap();
      }}
      style={{
        minHeight: theme.touch,
        padding: `0 ${theme.space(3)}px`,
        display: "flex",
        // The words never cut: a tag with no room beside them goes under them, and the button grows a line.
        flexWrap: "wrap",
        alignItems: "center",
        alignContent: "center",
        justifyContent: "space-between",
        columnGap: theme.space(1),
        rowGap: 0,
        // A named row's cell keeps its own width, and wraps its words rather than run past the panel's edge.
        flex: props.grow ? "1 1 auto" : "0 1 auto",
        maxWidth: "100%",
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
        background: theme.color.surfaceRaised,
        color: props.disabled !== null ? theme.color.textDisabled : theme.color.text,
        fontFamily: theme.font.body,
        cursor: props.disabled !== null || waiting ? "default" : "pointer",
        minWidth: 0,
        width: props.grow === false ? undefined : "100%",
      }}
    >
      {/* Its words wrap inside the cell, which grows a line, and never run out of it or end in "…" (the project owner, 2026-10-17). */}
      <span style={{ minWidth: 0, fontSize: theme.font.body14, fontWeight: theme.weight.strong, textAlign: "left", overflowWrap: "anywhere" }}>
        {waiting ? `${props.text}…` : props.text}
      </span>
      {props.tag ? <span style={{ flex: "none", fontSize: theme.font.tiny, fontWeight: theme.weight.strong, color: theme.color.textMuted, whiteSpace: "nowrap" }}>{props.tag}</span> : null}
    </button>
  );
}

/**
 * A save, check, skill or attack button: its bonus, its preset in words, and
 * where its tap goes. With `unknown` the creature has no numbers here, and
 * the tap goes by the bonus typed (options.ts typedTap).
 */
function D20Cell(props: { ctx: Ctx; test: D20Test; bonus: number; unknown?: { typed: TypedBonus }; text: string; label?: string; critOn?: 18 | 19; rowKey?: string; grow?: boolean; common?: readonly string[]; onLanded?(critical: boolean): void }) {
  const { ctx, test } = props;
  const option = useRollOption();
  const route = routeOf({ state: ctx.dice.view, creature: ctx.creature, test, dm: ctx.dice.you.role === "dm", played: ctx.played, ask: ctx.ask });
  const tap = props.unknown ? typedTap(route.kind, props.unknown.typed) : { bonus: props.bonus, waits: null };
  // An answer rolls the request's own test, with its `spell`, so the button shows the preset its tap sends.
  const presetOf = (t: D20Test) => presetFor(ctx.dice, ctx.creature, t, { rolls: ctx.rolls });
  const preset = presetOf(routedTest(route, test));
  const row = `${ctx.key}|${props.rowKey ?? JSON.stringify(test)}`;
  const landed = useRowResult(row);
  useActOnce(landed.tag, landed.rolls, (rolls) => props.onLanded?.(critical(rolls[0])));
  const label = props.label ?? testLabel(test);
  const words = presetLine(preset);
  const how = route.kind === "answer" ? "answers the DM's request" : route.kind === "ask" ? "asks the player" : "";
  // An attack's preset is the same for every weapon, so its group's label says it and the button stays one word.
  const said = test.kind === "attack" ? presetTag(preset).split(" ") : (props.common ?? []);
  const own = presetTag(preset)
    .split(" ")
    .filter((part) => part && !said.includes(part));
  const tag = [route.kind === "answer" ? "Asked" : "", ...own].filter(Boolean).join(" ");
  return (
    <OptionCell
      text={props.text}
      tag={tag || undefined}
      name={[label, how, words].filter(Boolean).join(", ")}
      row={row}
      disabled={ctx.blocked ?? tap.waits}
      grow={props.grow}
      onTap={() =>
        option.d20({
          creature: ctx.creature,
          test,
          bonus: tap.bonus,
          ...(props.unknown ? { typed: true } : {}),
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
 * The saves, checks, skills and initiative of a creature whose numbers this
 * viewer does not hold: one with no stat block, or a character rolled for
 * through a token lent to them, whose numbers go only to the DM and its own
 * players (docs/design-v1-pc-stats.md 4.2). Each is listed with no bonus
 * shown. A tap that asks a player needs none, and any other waits for the
 * bonus typed in the one field, which serves the roll tapped next.
 */
function UnknownNumbers(props: { ctx: Ctx; name: string; skillsOpen: boolean; onSkills(): void; addBlock: (() => void) | null }) {
  const { ctx } = props;
  const [text, setText] = useState("");
  const typed = parseBonus(text);
  const unknown = { typed };
  const init = ctx.rolls.initBonus;
  const hidden = init === null;
  const state = ctx.dice.view;
  const dm = ctx.dice.you.role === "dm";
  // The field shows where some tap rolls here. A DM's Ask on a player's creature needs none, its initiative aside.
  const rollsHere =
    hidden || TESTS.some((test) => routeOf({ state, creature: ctx.creature, test, dm, played: ctx.played, ask: ctx.ask }).kind !== "ask");
  return (
    <>
      <Note>{noNumbersNote({ name: props.name, hidden, rollsHere })}</Note>
      {props.addBlock ? (
        <div>
          <SmallButton wrap onClick={props.addBlock}>
            Add a stat block
          </SmallButton>
        </div>
      ) : null}
      {rollsHere ? (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: theme.space(2), fontWeight: theme.weight.strong }}>
            Bonus
            <Input
              value={text}
              placeholder="+0"
              enterKeyHint="done"
              autoComplete="off"
              maxLength={3}
              error={typed?.ok === false}
              onChange={(e) => setText(e.target.value)}
              style={{ width: 88, flex: "none", textAlign: "center" }}
            />
          </label>
          {typed?.ok === false ? <Note tone="error">{typed.error}</Note> : null}
        </>
      ) : null}
      <Grid label="Saves">
        {ABILITY_KEYS.map((a) => (
          <D20Cell key={a} ctx={ctx} test={{ kind: "save", ability: a }} bonus={0} unknown={unknown} text={typedText(ABILITY_SHORT[a], typed)} />
        ))}
      </Grid>
      <Grid label="Checks">
        {ABILITY_KEYS.map((a) => (
          <D20Cell key={a} ctx={ctx} test={{ kind: "check", ability: a }} bonus={0} unknown={unknown} text={typedText(ABILITY_SHORT[a], typed)} />
        ))}
      </Grid>
      <Section title="Skills" fold={{ open: props.skillsOpen, onToggle: props.onSkills }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: theme.space(1) }}>
          {SKILL_KEYS.map((s: SkillKey) => (
            <D20Cell key={s} ctx={ctx} test={{ kind: "check", ability: SKILLS[s].ability, skill: s }} bonus={0} unknown={unknown} text={typedText(SKILLS[s].name, typed)} />
          ))}
        </div>
      </Section>
      {init !== null ? (
        <InitiativeCell ctx={ctx} bonus={init} bonusText={signedText(init)} />
      ) : (
        <InitiativeCell ctx={{ ...ctx, blocked: ctx.blocked ?? typedTap("roll", typed).waits }} bonus={typed?.ok ? typed.bonus : 0} bonusText={typed?.ok ? `d20${signedText(typed.bonus)}` : "d20"} />
      )}
    </>
  );
}

/** Every save, check and skill a creature lists, for whether any tap of one rolls here. */
const TESTS: readonly D20Test[] = [
  ...ABILITY_KEYS.map((ability): D20Test => ({ kind: "save", ability })),
  ...ABILITY_KEYS.map((ability): D20Test => ({ kind: "check", ability })),
  ...SKILL_KEYS.map((skill): D20Test => ({ kind: "check", ability: SKILLS[skill].ability, skill })),
];

/**
 * Initiative (4.2, 4.3): "Initiative +2" with what its tap does to the
 * tracker as its tag ("sets row", "replaces 15"), two of the grid's three
 * columns, and a monster in a room that uses scores "Score 12" beside
 * "Roll instead". The value is written only to a row that still holds what
 * it held at the tap, by the room's listener, so the cell may close first.
 */
function InitiativeCell(props: { ctx: Ctx; bonus: number; bonusText: string }) {
  const { ctx } = props;
  const option = useRollOption();
  const watch = useWatchInitiative();
  const row = `${ctx.key}|initiative`;
  const landed = useRowResult(row);
  const changed = useInitiativeChanged(landed.tag);
  const state = ctx.dice.view;
  const entry = initiativeRow(state, ctx.creature);
  const dm = ctx.dice.you.role === "dm";
  // A score set without a roll is a typed value to the server, which a player's room may have off (shared/permissions.ts playersTypeTotals).
  const score = entry && (dm || playersTypeTotals(state.meta.settings)) ? scoreOf(state, ctx.creature) : null;
  const test: D20Test = { kind: "initiative" };
  const preset = presetFor(ctx.dice, ctx.creature, test, { rolls: ctx.rolls });
  const roll = () => {
    const sent = option.d20({ creature: ctx.creature, test, bonus: props.bonus, preset, label: "Initiative", row, played: false, ask: false });
    if (sent !== null && sent !== "asked" && entry) watch(sent, entry.id);
  };
  const bonus = props.bonusText;
  const scored = score !== null && entry !== undefined;
  const does = scored ? "replaces the score" : entry ? (entry.value === null ? "sets its row" : `replaces ${entry.value}`) : "";
  const tag = [scored ? "" : entry ? (entry.value === null ? "sets row" : `replaces ${entry.value}`) : "", presetTag(preset)].filter(Boolean).join(" ");
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>
        {scored ? (
          <SmallButton wrap disabled={ctx.blocked !== null} onClick={() => option.setInitiative(entry.id, score, dm)} label={`Score ${score}, sets its row`}>
            {`Score ${score}`}
          </SmallButton>
        ) : null}
        <div style={{ gridColumn: "span 2", minWidth: 0 }}>
          <OptionCell
            text={scored ? "Roll instead" : `Initiative ${bonus}`}
            tag={tag || undefined}
            name={["Initiative", does, presetLine(preset)].filter(Boolean).join(", ")}
            row={row}
            disabled={ctx.blocked}
            onTap={roll}
          />
        </div>
      </div>
      {changed ? <Note>{changed}</Note> : null}
    </div>
  );
}

/** The death save, rolled by the server with the creature's own numbers. Where this viewer holds none of them its bonus goes unsaid. */
function DeathSaveCell(props: { ctx: Ctx; bonus: number | null }) {
  const { ctx } = props;
  const option = useRollOption();
  const test: D20Test = { kind: "deathSave" };
  const preset = presetFor(ctx.dice, ctx.creature, test, { rolls: ctx.rolls });
  const row = `deathSave:${"tokenId" in ctx.creature ? ctx.creature.tokenId : ctx.creature.characterId}`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>
      <div style={{ gridColumn: "span 2", minWidth: 0 }}>
        <OptionCell
          text={props.bonus === null ? "Death save" : `Death save ${signedText(props.bonus)}`}
          tag={presetTag(preset) || undefined}
          name={["Death save", presetLine(preset)].filter(Boolean).join(", ")}
          row={row}
          disabled={ctx.blocked}
          onTap={() => option.deathSave(ctx.creature, preset, row)}
        />
      </div>
    </div>
  );
}

/**
 * One named roll (4.2), in two lines (docs/design-v1-dice-ui.md 4.3): its
 * header, the name with its uses and recharge, Used, and its numbers as a
 * stat block reads them ("+6 to hit, 1d8+3 slashing", "DC 14 Dex, 2d8
 * radiant"), then one line of controls that wraps only where the panel is
 * too narrow: Attack, Damage, Critical, each rider, Heal, a plain roll, a
 * group save, Recharge and a spell's slot level.
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
  const meta = [named.uses ?? null, recharge].filter(Boolean).join(", ");
  const summary = rowSummary(named);
  const damageRow = `${rowKey}|damage`;
  const healRow = `${rowKey}|heal`;
  const diceRow = `${rowKey}|dice`;
  const rechargeRow = `${rowKey}|recharge`;
  const { tag: rechargeTag, rolls: rechargeLanded } = useRowResult(rechargeRow);
  useActOnce(rechargeTag, rechargeLanded, (landed) => {
    if ((landed[0]?.total ?? 0) >= (named.recharge ?? 7)) markUsed(false);
  });
  // Only an attack roll scores a Critical Hit (SRD 5.2.1), so a save action's damage, such as Fire Breath's, never doubles (W7B-P-13).
  const canCrit = named.attack !== undefined;
  const hasDamage = named.damage.length > 0;
  return (
    <div style={{ ...ROW, display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        {/* One run of text: the name, then its uses and numbers after it on the same line, wrapping as words where the name is long. */}
        <div style={{ flex: 1, minWidth: 0, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
          <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, marginRight: theme.space(2) }}>{named.name}</span>
          {meta || summary ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{[meta, summary].filter(Boolean).join(" · ")}</span> : null}
        </div>
        {named.recharge !== undefined ? (
          <Chip pressed={used} onClick={() => markUsed(!used)} aria-label={used ? `${named.name} is used. Tap when it recharges` : `Mark ${named.name} used`}>
            Used
          </Chip>
        ) : null}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
        {named.attack !== undefined ? (
          <D20Cell
            ctx={ctx}
            test={named.section === "spells" ? { kind: "attack", spell: true } : { kind: "attack" }}
            bonus={named.attack}
            text="Attack"
            label={named.name}
            rowKey={`${props.named.key}|attack`}
            grow={false}
            {...(named.critOn ? { critOn: named.critOn } : {})}
            onLanded={(isCrit) => {
              if (isCrit) setCrit(true);
            }}
          />
        ) : null}
        {named.save && ctx.dice.you.role === "dm" ? <GroupSaveButton ctx={ctx} named={named} /> : null}
        {hasDamage ? (
          <OptionCell
            text="Damage"
            name={`${named.name} damage${canCrit && crit ? `, ${CRIT_WORDS[critRule]}` : ""}`}
            row={damageRow}
            disabled={ctx.blocked}
            grow={false}
            onTap={() => {
              const rolls = damageRolls(named, { on, critical: canCrit && crit, creature: ctx.creature });
              if (option.rolls(rolls, damageRow) !== null) {
                if (crit) setCrit(false);
                if (named.recharge !== undefined) markUsed(true);
              }
            }}
          />
        ) : null}
        {hasDamage && canCrit ? (
          <Chip pressed={crit} onClick={() => setCrit(!crit)} aria-label={`Critical hit for ${named.name}'s next damage`} title={CRIT_WORDS[critRule]}>
            Critical
          </Chip>
        ) : null}
        {named.damage.map((part, i) =>
          part.optional ? (
            <Chip key={i} wrap pressed={on.has(i)} onClick={() => toggleRider(i)} aria-label={riderToggleName(part)}>
              {cutLabel(riderText(part))}
            </Chip>
          ) : null,
        )}
        {named.heal ? (
          <OptionCell
            text="Heal"
            name={`${named.name} healing`}
            row={healRow}
            disabled={ctx.blocked}
            grow={false}
            onTap={() => option.rolls([namedRoll(named.heal!.formula, `${named.name} healing`, ctx.creature)], healRow)}
          />
        ) : null}
        {named.dice ? (
          <OptionCell text="Roll" name={`${named.name}, ${named.dice}`} row={diceRow} disabled={ctx.blocked} grow={false} onTap={() => option.rolls([namedRoll(named.dice!, named.name, ctx.creature)], diceRow)} />
        ) : null}
        {named.recharge !== undefined ? (
          <OptionCell text="Recharge" name={`${named.name} recharge, 1d6`} row={rechargeRow} disabled={ctx.blocked} grow={false} onTap={() => option.rolls([namedRoll("1d6", `${named.name} recharge`, ctx.creature)], rechargeRow)} />
        ) : null}
        {slots && slot !== null ? <SlotStepper name={named.name} value={slot} min={slots.from} onChange={(n) => store.setState((s) => ({ slots: { ...s.slots, [rowKey]: n } }))} /> : null}
      </div>
    </div>
  );
}

/**
 * A spell's slot level in the row's line (4.4): the level as words between
 * two 44 px steps, where the shared stepper's number field made it too wide
 * to share a line. Slot levels are 1 to 9, so steps alone reach any of them
 * in a few taps.
 */
function SlotStepper(props: { name: string; value: number; min: number; onChange(n: number): void }) {
  const set = (n: number) => props.onChange(Math.max(props.min, Math.min(9, n)));
  return (
    <span role="group" aria-label={`Slot level for ${props.name}`} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1) }}>
      <SmallButton icon="minus" label={`Slot level for ${props.name}, lower`} disabled={props.value <= props.min} onClick={() => set(props.value - 1)} />
      <span aria-live="polite" style={{ minWidth: 48, textAlign: "center", fontSize: theme.font.body14, fontWeight: theme.weight.strong, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        Level {props.value}
      </span>
      <SmallButton icon="plus" label={`Slot level for ${props.name}, higher`} disabled={props.value >= 9} onClick={() => set(props.value + 1)} />
    </span>
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
    <>
      <SmallButton wrap disabled={ctx.blocked !== null} onClick={() => !go(false) && setPending(true)} label={`Group save, DC ${save.dc} ${ABILITY_SHORT[save.ability]}`}>
        Group save
      </SmallButton>
      {pending ? (
        <div style={{ flexBasis: "100%" }}>
          <ReplaceConfirm onDiscard={() => go(true) && setPending(false)} onKeep={() => setPending(false)} />
        </div>
      ) : null}
    </>
  );
}
