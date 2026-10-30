import { testOf, type D20Test } from "#shared/dice/bonus.ts";
import { creatureName, describeEvent, labelText, memberName, type LogNames } from "#shared/logText.ts";
import type { LogEvent } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { ABILITY_NAMES } from "#shared/rules/skills.ts";
import { MarkedText } from "../../components/ProficiencyMark.tsx";
import { choiceLabels, findMarks, marksTest, rollTarget, rollTest, type TextMark } from "./proficiencyPresentation.ts";

export type LevelOf = (creature: ActorTarget, test: D20Test) => Proficiency;

/**
 * A log line's words, exactly as describeEvent writes them, and the tests
 * in them to mark. Each label is found after the name the line starts
 * with, so a creature or member named like a skill is never marked.
 */
export function eventMarks(data: LogEvent, names: LogNames, dm: boolean, levelOf: LevelOf): { text: string; marks: TextMark[] } {
  const text = describeEvent(data, names, dm);
  if (data.type === "dice") {
    const labels = data.rolls.flatMap((roll) => {
      const target = rollTarget(roll);
      const test = rollTest(roll);
      // A creature's roll reads "for Thorn, Perception check: " (shared/logText.ts rollSubject).
      return target && roll.label !== undefined && marksTest(test) ? [{ label: labelText(roll.label), level: levelOf(target, test), after: ", " }] : [];
    });
    return { text, marks: findMarks(text, labels, memberName(names, data.by).length) };
  }
  const target = data.type === "roll" || data.type === "saveEnds" ? rollTarget(data) : null;
  if (data.type === "roll" && target) {
    // rollText names the recorded choice alone, else every choice.
    const shown = data.choice !== undefined && data.test.choices[data.choice] ? [data.choice] : data.test.choices.map((_, i) => i);
    const labels = choiceLabels(data.test, shown).map(({ index, label }) => ({ label, level: levelOf(target, testOf(data, index)) }));
    return { text, marks: findMarks(text, labels, creatureName(names, data).length) };
  }
  if (data.type === "saveEnds" && target) {
    // The save, never the DC before it (FL7-R1-13): "a DC 15 Wisdom save ends it".
    const labels = [{ label: `${ABILITY_NAMES[data.ability]} save`, level: levelOf(target, { kind: "save", ability: data.ability }), after: `DC ${data.dc} ` }];
    return { text, marks: findMarks(text, labels, creatureName(names, data).length) };
  }
  return { text, marks: [] };
}

/** A log line with its tests marked, its words unchanged. */
export function ProficientEvent(props: { data: LogEvent; names: LogNames; dm: boolean; levelOf: LevelOf }) {
  const { text, marks } = eventMarks(props.data, props.names, props.dm, props.levelOf);
  return <MarkedText text={text} marks={marks} />;
}
