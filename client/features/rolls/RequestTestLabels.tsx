import { Fragment } from "react";
import { testOf, type D20Test } from "#shared/dice/bonus.ts";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { ABILITY_ABBR, SKILLS, testShortText } from "#shared/rules/skills.ts";
import { ProficientTest } from "../dice/ProficientTest.tsx";
import { answered, chipLine, choiceShort, dmAnswerText, targetRef } from "./logic.ts";

/** Usual skill abilities are implicit. An unusual pairing stays explicit. */
export function compactTestName(test: D20Test): string {
  if (test.kind === "save") return `${ABILITY_ABBR[test.ability]} save`;
  if (test.kind === "check") {
    if (!test.skill) return `${ABILITY_ABBR[test.ability]} check`;
    const skill = SKILLS[test.skill];
    return `${skill.name}${test.ability === skill.ability ? "" : ` (${ABILITY_ABBR[test.ability]})`}`;
  }
  return "Roll";
}

/** Until an answer records a choice, both alternatives have their own proficiency. */
export function RequestTestLabels(props: { request: Pick<RollRequest, "test">; target?: RollTarget; total?: number }) {
  const recorded = props.target?.choice;
  const indices = recorded !== undefined && props.request.test.choices[recorded] ? [recorded] : props.request.test.choices.map((_, i) => i);
  return (
    <span data-request-tests="">
      {indices.map((i, index) => {
        const test = testOf(props.request, i);
        const text = `${compactTestName(test)}${indices.length === 1 && props.total !== undefined ? ` ${props.total}` : ""}`;
        return (
          <Fragment key={i}>
            {index > 0 ? " or " : null}
            {props.target ? (
              <ProficientTest creature={targetRef(props.target)} test={test}>{text}</ProficientTest>
            ) : (
              <span data-request-test-choice={i} style={{ whiteSpace: "nowrap" }}>{text}</span>
            )}
          </Fragment>
        );
      })}
      {indices.length > 1 && props.total !== undefined ? <span style={{ whiteSpace: "nowrap" }}>{`: ${props.total}`}</span> : null}
    </span>
  );
}

/** Keep the established status words while rendering the selected test and total once. */
export function PlayerAnswerLine(props: { request: RollRequest; target: RollTarget }) {
  const { request, target } = props;
  const status = chipLine(request, target).slice(testShortText(request.test).length + 2);
  const total = target.total ?? target.dice?.total;
  if (total === undefined) return <><RequestTestLabels request={request} target={target} />: {status}</>;
  const choice = request.test.choices.length > 1 && target.choice !== undefined ? request.test.choices[target.choice] : undefined;
  const verb = target.dice ? "rolled" : "sent";
  const prefix = `${verb} ${choice ? `${choiceShort(choice)} ` : ""}${total}`;
  return <>{verb} <RequestTestLabels request={request} target={target} total={total} />{status.slice(prefix.length)}</>;
}

/** Current and previous answers keep their own selected choice, even after a reopen. */
export function DmAnswerLine(props: { request: RollRequest; target: RollTarget }) {
  const { request, target } = props;
  const previous = target.previous;
  const history = previous && answered(previous) ? { ...targetRef(target), ...previous } : null;
  return (
    <>
      <DmAnswerPart request={request} target={target} waitingAgain={history !== null} />
      {history ? <>{answered(target) && !target.changed ? ", changed from " : ", was "}<DmAnswerPart request={request} target={history} />{history.total !== undefined && history.result !== undefined && history.mark === undefined ? ` (${history.result === "pass" ? "Pass" : "Fail"})` : ""}</> : null}
    </>
  );
}

function DmAnswerPart(props: { request: RollRequest; target: RollTarget; waitingAgain?: boolean }) {
  const { request, target } = props;
  // Choice names belong to the structured label. The existing formatter keeps dice, changes and marks.
  const choices = [request.test.choices[target.choice ?? 0]!];
  const details = dmAnswerText({ ...target, previous: undefined }, { ...request.test, choices });
  const total = target.total ?? target.dice?.total;
  if (total === undefined) return <><RequestTestLabels request={request} target={target} />: {props.waitingAgain && !answered(target) ? "waiting again" : details}</>;
  const changed = target.changed;
  const verb = !target.dice ? "typed"
    : changed?.reason === "heroic-inspiration" || changed?.reason === "halfling-luck" ? "rerolled"
    : changed?.reason === "lucky" ? "used Lucky:"
    : changed?.reason === "bardic-inspiration" ? `added a d${changed.die ?? "?"}, now`
    : "rolled";
  return <>{verb} <RequestTestLabels request={request} target={target} total={total} />{details.slice(`${verb} ${total}`.length)}</>;
}
