import { useMemo } from "react";
import type { D20Test } from "#shared/dice/bonus.ts";
import { ABILITY_KEYS, SKILL_KEYS } from "#shared/model.ts";
import { numbersFromStatBlock, proficiencyFor } from "#shared/rules/proficiency.ts";
import { ABILITY_ABBR, ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { Markdown, type MarkdownTexts } from "../../components/Markdown.tsx";
import { Help } from "../../components/Panel.tsx";
import { MarkedText } from "../../components/ProficiencyMark.tsx";
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
  const texts = useMemo(() => listedMarks(props.view), [props.view]);
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {split ? (
        // The ability table three across, the text on either side drawn as written. The margins are the Markdown table's own, so the block keeps its rhythm.
        <div>
          <Markdown text={split.before} texts={texts} />
          <div style={{ margin: `${theme.space(2)}px 0` }}>
            <AbilityGrid abilities={split.abilities} />
          </div>
          <Markdown text={split.after} texts={texts} />
        </div>
      ) : (
        <Markdown text={props.view.statBlock} texts={texts} />
      )}
      {props.source === "srd" && props.credit ? <SrdCredit /> : null}
    </div>
  );
}

/** The test a listed name stands for: a skill on the Skills line, an ability by name or abbreviation on the Saving Throws line. */
function listedTest(lead: string, name: string): D20Test | null {
  const lower = name.toLowerCase();
  if (lead === "Skills") {
    const skill = SKILL_KEYS.find((key) => SKILLS[key].name.toLowerCase() === lower);
    return skill ? { kind: "check", ability: SKILLS[skill].ability, skill } : null;
  }
  const ability = ABILITY_KEYS.find((key) => ABILITY_ABBR[key].toLowerCase() === lower || ABILITY_NAMES[key].toLowerCase() === lower);
  return ability ? { kind: "save", ability } : null;
}

/**
 * Marks each name the Skills and Saving Throws lines list ("Perception
 * +11"), read from the block's own numbers as the dice read them, and
 * leaves every other line, and the bonus after each name, as written.
 */
function listedMarks(view: StatBlockMonster): MarkdownTexts | undefined {
  const numbers = numbersFromStatBlock(view);
  if (!numbers) return undefined;
  return (text, lead) => {
    if (lead !== "Skills" && lead !== "Saving Throws") return text;
    const marks = [...text.matchAll(/([A-Za-z][A-Za-z ]*?)\s*[+−–-]\s*\d+/g)].flatMap((match) => {
      const name = match[1]!.trim();
      const test = listedTest(lead, name);
      return test ? [{ at: match.index + match[0].indexOf(name), length: name.length, level: proficiencyFor(test, { monster: { numbers, cr: view.cr } }) }] : [];
    });
    return <MarkedText text={text} marks={marks} />;
  };
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
