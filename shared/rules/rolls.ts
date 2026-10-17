import type { RollAnswer } from "../model.ts";

/**
 * An answer's pass or fail in one order (docs/design-v1-roll-request.md
 * 1.1), so the reducer, the cards and the results list always agree: the
 * DM's own mark, then for an answer written before wave 7 (no `tag`) its
 * stored result as it stands, then a condition that failed a rolled save,
 * then a save failed without rolling, then the total against the DC. With
 * none of them there is no result, as on a request with no DC.
 */
export function resultOf(answer: Pick<RollAnswer, "mark" | "tag" | "result" | "dice" | "noRoll" | "total">, dc?: number): "pass" | "fail" | undefined {
  if (answer.mark) return answer.mark;
  if (answer.tag === undefined) return answer.result;
  if (answer.dice?.fails) return "fail";
  if (answer.noRoll) return "fail";
  if (dc !== undefined && answer.total !== undefined) return answer.total >= dc ? "pass" : "fail";
  return undefined;
}
