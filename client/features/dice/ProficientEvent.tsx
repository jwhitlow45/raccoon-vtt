import { Fragment } from "react";
import { testOf, type D20Test } from "#shared/dice/bonus.ts";
import { describeEvent, labelText, type LogNames } from "#shared/logText.ts";
import type { LogEvent } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { ProficientTest } from "./ProficientTest.tsx";
import { rollTarget, rollTest } from "./proficiencyPresentation.ts";

/** Split an identified label, never a creature name that happens to contain the same words. */
export function ProficientText(props: { text: string; label: string; creature: ActorTarget; test: D20Test }) {
  const at = props.text.lastIndexOf(props.label);
  if (at < 0) return <>{props.text}</>;
  return <>{props.text.slice(0, at)}<ProficientTest creature={props.creature} test={props.test}>{props.label}</ProficientTest>{props.text.slice(at + props.label.length)}</>;
}

function RequestWords(props: { text: string; data: Extract<LogEvent, { type: "roll" }>; creature: ActorTarget }) {
  const { data } = props;
  const parts = data.test.choices.flatMap((choice, i) => {
    if (data.choice !== undefined && data.choice !== i) return [];
    const label = choice.skill ? SKILLS[choice.skill].name : `${ABILITY_NAMES[choice.ability]}${data.test.choices.length === 1 || data.choice !== undefined ? " saving throw" : ""}`;
    const at = props.text.lastIndexOf(label);
    return at < 0 ? [] : [{ label, at, test: testOf(data, i) }];
  }).sort((a, b) => a.at - b.at);
  let from = 0;
  return <>{parts.map((part, i) => {
    const before = props.text.slice(from, part.at);
    from = part.at + part.label.length;
    return <Fragment key={i}>{before}<ProficientTest creature={props.creature} test={part.test}>{part.label}</ProficientTest></Fragment>;
  })}{props.text.slice(from)}</>;
}

export function ProficientEvent(props: { data: LogEvent; names: LogNames; dm: boolean }) {
  const { data, names, dm } = props;
  const text = describeEvent(data, names, dm);
  if (data.type === "dice") {
    const lines = text.split("\n");
    const start = data.rolls.length > 1 ? 1 : 0;
    return <>{lines.map((line, i) => {
      const roll = data.rolls[i - start];
      const target = roll ? rollTarget(roll) : null;
      const test = roll ? rollTest(roll) : null;
      return <Fragment key={i}>{i > 0 ? "\n" : ""}{roll?.label && target && test ? <ProficientText text={line} label={labelText(roll.label)} creature={target} test={test} /> : line}</Fragment>;
    })}</>;
  }
  if (data.type === "roll") {
    const target = rollTarget(data);
    return target ? <RequestWords text={text} data={data} creature={target} /> : <>{text}</>;
  }
  if (data.type === "saveEnds") {
    const target = rollTarget(data);
    if (target) return <ProficientText text={text} label={`DC ${data.dc} ${ABILITY_NAMES[data.ability]} save`} creature={target} test={{ kind: "save", ability: data.ability }} />;
  }
  return <>{text}</>;
}
