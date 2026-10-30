import type { CSSProperties, ReactNode } from "react";
import { ABILITY_KEYS, SKILL_KEYS, type Character, type PcRoll } from "#shared/model.ts";
import { statsDefenses, pcActorNumbers, pcDerived, sortedRolls } from "#shared/rules/pcStats.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { signed } from "#shared/statBlock.ts";
import { proficiencyFor } from "#shared/rules/proficiency.ts";
import { ProficiencyLabel } from "../../components/ProficiencyMark.tsx";
import { theme } from "../../lib/theme.ts";
import { AbilityGrid } from "../monsters/AbilityGrid.tsx";
import { defenseLinesOf, rollReading, rollTitle } from "./reading.ts";

/**
 * A player character's stat block, read only (docs/design-v1-pc-stats.md
 * 7.3), in the stat block view's type: the level and proficiency, the six
 * abilities with their saves, the skills that differ from the plain
 * modifier, initiative and Passive Perception, spellcasting, defenses, and
 * one line per roll. React text, never Markdown, so a later tap to roll can
 * turn its numbers into buttons. Nothing in it rolls: rolls are made in the
 * Dice panel.
 */
export function PcStatsView(props: { character: Pick<Character, "stats" | "level"> }) {
  const stats = props.character.stats;
  if (!stats) return null;
  const level = props.character.level;
  const d = pcDerived(stats, level);
  const actorNumbers = pcActorNumbers(stats, level);
  const skills = SKILL_KEYS.filter((s) => stats.skills[s] !== undefined || (stats.adjust.skills?.[s] ?? 0) !== 0);
  const defenses = defenseLinesOf(statsDefenses(stats));
  const rolls = sortedRolls(stats.rolls);
  const group = (kind: PcRoll["kind"]) => rolls.filter((r) => r.kind === kind);
  return (
    <div data-pc-stats="" style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14, lineHeight: 1.45, overflowWrap: "anywhere" }}>
      <p style={LINE}>
        <strong>Level {level ?? "not set"}</strong>, PB {signed(d.pb)}
      </p>
      <AbilityGrid abilities={ABILITY_KEYS.map((a) => ({ key: a, score: String(stats.abilities[a]), mod: signed(d.mods[a]), save: signed(d.saves[a].total), proficient: stats.saves.includes(a) }))} />
      {skills.length > 0 ? (
        <Labeled label="Skills">{skills.map((s, i) => (
          <span key={s}>
            {i > 0 ? ", " : null}
            <ProficiencyLabel level={proficiencyFor({ kind: "check", ability: SKILLS[s].ability, skill: s }, { stats })}>
              {`${SKILLS[s].name} ${signed(d.skills[s].total)}`}
            </ProficiencyLabel>
          </span>
        ))}</Labeled>
      ) : null}
      {stats.jack ? <Labeled label="Jack of All Trades">{`${signed(Math.floor(d.pb / 2))} to skills with neither`}</Labeled> : null}
      <p style={LINE}>
        <strong>Initiative</strong> {signed(actorNumbers.initBonus)}, <strong>Passive Perception</strong> {actorNumbers.passivePerception}
      </p>
      {d.spell ? <Labeled label="Spellcasting">{`${ABILITY_NAMES[d.spell.ability]}, save DC ${d.spell.dc.total}, attack ${signed(d.spell.attack.total)}`}</Labeled> : null}
      {defenses.map((line) => (
        <Labeled key={line.label} label={line.label}>
          {line.text}
        </Labeled>
      ))}
      {stats.evasion ? <Labeled label="Evasion">A Dexterity save for half takes none on a pass, half on a fail.</Labeled> : null}
      {stats.critOn ? <Labeled label="Critical Hits">{`Weapon attacks score a Critical Hit on ${stats.critOn} or higher.`}</Labeled> : null}
      <RollList title="Weapons" rolls={group("weapon")} line={(r) => rollLine(r)} />
      <RollList title="Spells" rolls={group("spell")} line={(r) => rollLine(r)} />
      <RollList title="Other rolls" rolls={group("other")} line={(r) => rollLine(r)} />
    </div>
  );

  function rollLine(roll: PcRoll): ReactNode {
    const reading = rollReading(stats!, level, roll);
    return (
      <>
        <strong>{rollTitle(roll)}.</strong>
        {reading ? ` ${reading[0]!.toUpperCase()}${reading.slice(1)}.` : null}
      </>
    );
  }
}

const LINE: CSSProperties = { margin: 0 };

function Labeled(props: { label: string; children: ReactNode }) {
  return (
    <p style={LINE}>
      <strong>{props.label}</strong> {props.children}
    </p>
  );
}

function RollList(props: { title: string; rolls: PcRoll[]; line(roll: PcRoll): ReactNode }) {
  if (props.rolls.length === 0) return null;
  return (
    <section style={{ display: "grid", gap: theme.space(1) }}>
      <h4
        style={{
          margin: `${theme.space(2)}px 0 0`,
          paddingBottom: theme.space(0.5),
          fontSize: theme.font.input,
          fontWeight: theme.weight.bold,
          lineHeight: theme.leading.tight,
          borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
        }}
      >
        {props.title}
      </h4>
      {props.rolls.map((roll) => (
        <p key={roll.id} style={LINE}>
          {props.line(roll)}
        </p>
      ))}
    </section>
  );
}
