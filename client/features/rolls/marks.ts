import { testOf, type D20Test } from "#shared/dice/bonus.ts";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { choiceLabels, findMarks, marksTest, type TextMark } from "../dice/proficiencyPresentation.ts";
import { choiceShort, targetRef } from "./logic.ts";

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

/** An answer's words that name its recorded choice of two ("DEX: typed 17", "Sent DEX 13"), that choice marked. */
export function answerChoiceMarks(text: string, request: Pick<RollRequest, "test" | "spell">, target: RollTarget, levelOf: LevelOf, from = 0): TextMark[] {
  const choice = request.test.choices.length > 1 && target.choice !== undefined ? request.test.choices[target.choice] : undefined;
  const test = choice ? testOf(request, target.choice) : null;
  if (!choice || !marksTest(test)) return [];
  return findMarks(text, [{ label: choiceShort(choice), level: levelOf(targetRef(target), test) }], from);
}
