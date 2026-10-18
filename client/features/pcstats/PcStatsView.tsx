import type { CSSProperties, ReactNode } from "react";
import { ABILITY_KEYS, SKILL_KEYS, type Character, type PcRoll } from "#shared/model.ts";
import { statsDefenses, pcActorNumbers, pcDerived, sortedRolls } from "#shared/rules/pcStats.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { ABILITY_NAMES as ABILITY_SHORT, signed } from "#shared/statBlock.ts";
import { theme } from "../../lib/theme.ts";
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
        <strong>Level {level ?? "not set"}</strong>, proficiency {signed(d.pb)}
      </p>
      {/* The six abilities three across, as the 2024 block prints them: about a third of the height of a seven-row table (docs/design-v1-dice-ui.md 6.1). */}
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>
        {ABILITY_KEYS.map((a) => {
          const proficient = stats.saves.includes(a);
          return (
            <div key={a} style={{ padding: `${theme.space(1)}px ${theme.space(2)}px`, borderRadius: theme.radius.sm, background: theme.color.surfaceRaised, lineHeight: theme.leading.tight }}>
              <dt style={{ fontSize: theme.font.tiny, fontWeight: theme.weight.bold, letterSpacing: theme.caps, textTransform: "uppercase", color: theme.color.textMuted }}>
                <abbr title={ABILITY_NAMES[a]} style={{ textDecoration: "none" }}>
                  {ABILITY_SHORT[a]}
                </abbr>
              </dt>
              <dd style={{ margin: 0, whiteSpace: "nowrap" }}>
                <strong style={{ fontSize: theme.font.input }}>{stats.abilities[a]}</strong> <span style={{ color: theme.color.textMuted }}>{signed(d.mods[a])}</span>
              </dd>
              <dd style={{ margin: 0, fontSize: theme.font.small, whiteSpace: "nowrap", fontWeight: proficient ? theme.weight.bold : theme.weight.regular }}>
                <span style={{ color: theme.color.textMuted, fontWeight: theme.weight.regular }}>Save </span>
                {signed(d.saves[a].total)}
                {proficient ? <span style={HIDDEN}>, proficient</span> : null}
              </dd>
            </div>
          );
        })}
      </dl>
      {skills.length > 0 ? (
        <Labeled label="Skills">{skills.map((s) => `${SKILLS[s].name} ${signed(d.skills[s].total)}${stats.skills[s] === "expert" ? " (expertise)" : ""}`).join(", ")}</Labeled>
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
      {stats.critOn ? <Labeled label="Critical hits">{`Weapon attacks score a critical hit on ${stats.critOn} or higher.`}</Labeled> : null}
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
const HIDDEN: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

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
