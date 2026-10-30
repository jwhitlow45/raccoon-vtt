import { useMemo, type ReactNode } from "react";
import { ABILITY_KEYS, SKILL_KEYS } from "#shared/model.ts";
import type { D20Test, RollNumbers } from "#shared/dice/bonus.ts";
import { ABILITY_ABBR, ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { numbersFromStatBlock, proficiencyFor } from "#shared/rules/proficiency.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { Help } from "../../components/Panel.tsx";
import { ProficiencyLabel } from "../../components/ProficiencyMark.tsx";
import { theme } from "../../lib/theme.ts";
import { AbilityGrid } from "./AbilityGrid.tsx";
import { splitAbilityTable } from "./abilityTable.ts";
import { useSrdBlocks } from "./srdBlocks.ts";

/** The SRD's credit, which CC BY 4.0 asks for wherever its text is shown. */
export const SRD_CREDIT = "Stat blocks from the System Reference Document 5.2.1 by Wizards of the Coast, licensed under CC-BY-4.0.";

/**
 * A full 2024 stat block, read only: what the Monsters panel shows for a
 * monster it lists, and what the token panel shows for a token linked to
 * one (docs/design-v1-dm-tools.md 3.6). Nothing in it rolls.
 */
export function StatBlockView(props: { view: StatBlockMonster; source: "srd" | "room"; credit?: boolean }) {
  const split = useMemo(() => splitAbilityTable(props.view.statBlock), [props.view.statBlock]);
  const numbers = useMemo(() => numbersFromStatBlock(props.view), [props.view]);
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {split ? (
        // The ability table three across, the text on either side drawn as written. The margins are the Markdown table's own, so the block keeps its rhythm.
        <div>
          <BlockText text={split.before} view={props.view} numbers={numbers} />
          <div style={{ margin: `${theme.space(2)}px 0` }}>
            <AbilityGrid abilities={split.abilities} />
          </div>
          <BlockText text={split.after} view={props.view} numbers={numbers} />
        </div>
      ) : (
        <BlockText text={props.view.statBlock} view={props.view} numbers={numbers} />
      )}
      {props.source === "srd" && props.credit ? <SrdCredit /> : null}
    </div>
  );
}

/** Keep listed bonuses structured while the rest of a stat block remains Markdown. */
function BlockText(props: { text: string; view: StatBlockMonster; numbers: RollNumbers | null }) {
  const parts: ReactNode[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length) parts.push(<Markdown key={`text-${parts.length}`} text={plain.join("\n")} />);
    plain = [];
  };
  for (const line of props.text.split("\n")) {
    const listed = /^(?:\*\*)?(Skills|Saving Throws)(?:\*\*)?\s+(.+)$/i.exec(line);
    if (!listed) {
      plain.push(line);
      continue;
    }
    flush();
    const skills = listed[1]!.toLowerCase() === "skills";
    parts.push(
      <p key={`bonuses-${parts.length}`} style={{ margin: `${theme.space(1)}px 0`, fontSize: theme.font.body14, lineHeight: 1.45 }}>
        <strong>{skills ? "Skills" : "Saving Throws"}</strong>{" "}
        {listed[2]!.split(",").map((part, i) => {
          const text = part.trim().replace(/\\([+\-])/g, "$1");
          const match = /^(.+?)\s+([+−–-]\s*\d+)$/.exec(text);
          const name = match?.[1]?.toLowerCase();
          const skill = skills ? SKILL_KEYS.find((key) => SKILLS[key].name.toLowerCase() === name) : undefined;
          const ability = skills ? undefined : ABILITY_KEYS.find((key) => ABILITY_ABBR[key].toLowerCase() === name || ABILITY_NAMES[key].toLowerCase() === name);
          const test: D20Test | null = skill ? { kind: "check", ability: SKILLS[skill].ability, skill } : ability ? { kind: "save", ability } : null;
          const level = test && props.numbers ? proficiencyFor(test, { monster: { numbers: props.numbers, cr: props.view.cr } }) : "none";
          return (
            <span key={i}>
              {i > 0 ? ", " : null}
              {test ? <ProficiencyLabel level={level}>{text}</ProficiencyLabel> : text}
            </span>
          );
        })}
      </p>,
    );
  }
  flush();
  return <>{parts}</>;
}

export function SrdCredit() {
  return <Help style={{ marginTop: theme.space(2) }}>{SRD_CREDIT}</Help>;
}

/**
 * The SRD's 330 stat blocks, loaded on first use in their own chunk
 * (shared/srd/monsters.ts): null until they arrive, and `failed` when the
 * load did not work, so a caller can say so and offer the reload
 * (SrdLoadFailed.tsx) instead of looking stuck.
 */
export function useSrdMonsters(): { monsters: readonly SrdMonster[] | null; failed: boolean } {
  const { list, failed } = useSrdBlocks();
  return { monsters: list, failed };
}
