import { testOf, type D20Test } from "#shared/dice/bonus.ts";
import type { RollAnswer, RollRequest, RollTarget } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { choiceLabels, findMarks, marksTest, type TextMark } from "../dice/proficiencyPresentation.ts";
import { answered, choiceShort, targetRef } from "./logic.ts";

/*
 * Where a request's words name its test for one creature, and how
 * proficient that creature is (FL-7). A line for several creatures, such
 * as a card's question or the desk's title with more than one target,
 * stays neutral, and each creature's own row carries its mark instead
 * (D-261029-415). The words are always the ones the line had.
 */

export type LevelOf = (creature: ActorTarget, test: D20Test) => Proficiency;

/** Every choice the test names in `text`, testText's words or, `short`, testShortText's, marked with this creature's level. */
export function requestMarks(text: string, request: Pick<RollRequest, "test" | "spell">, target: RollTarget, levelOf: LevelOf, opts: { short?: boolean; from?: number } = {}): TextMark[] {
  const ref = targetRef(target);
  const labels = choiceLabels(request.test, request.test.choices.map((_, i) => i), opts.short).map(({ index, label }) => ({ label, level: levelOf(ref, testOf(request, index)) }));
  return findMarks(text, labels, opts.from ?? 0);
}

/** The test a creature's row stands for: the request's one choice, or the one its answer recorded. Null while it may still pick between two. */
export function rowTest(request: Pick<RollRequest, "test" | "spell">, target: RollTarget): D20Test | null {
  const index = request.test.choices.length === 1 ? 0 : target.choice;
  const test = index !== undefined && request.test.choices[index] ? testOf(request, index) : null;
  return marksTest(test) ? test : null;
}

/**
 * An answer's words that name a recorded choice of two, each marked with
 * the choice its own answer recorded: the answer now, which leads the line
 * at `from` ("DEX: typed 17", "Sent DEX 13"), and on the DM's line the
 * answer it replaced or a reopen set aside, after "changed from " or
 * "was " (logic.ts dmAnswerText, FL7-SOL-02).
 */
export function answerChoiceMarks(text: string, request: Pick<RollRequest, "test" | "spell">, target: RollTarget, levelOf: LevelOf, from = 0): TextMark[] {
  const ref = targetRef(target);
  const labelOf = (answer: RollAnswer, after: string) => {
    const choice = request.test.choices.length > 1 && answer.choice !== undefined && answered(answer) ? request.test.choices[answer.choice] : undefined;
    const test = choice ? testOf(request, answer.choice) : null;
    return choice && marksTest(test) ? [{ label: choiceShort(choice), level: levelOf(ref, test), after }] : [];
  };
  // A bare mark ("marked Pass") names no choice, so the answer now is marked only where the line starts with it.
  const now = labelOf(target, "").filter(({ label }) => text.startsWith(label, from));
  const was = target.previous ? labelOf(target.previous, answered(target) ? "changed from " : "was ") : [];
  return findMarks(text, [...now, ...was], from);
}
