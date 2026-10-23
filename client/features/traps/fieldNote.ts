import { parseFormula } from "#shared/dice/formula.ts";
import { LIMITS } from "#shared/limits.ts";
import { cleanLine } from "./rules.ts";

/*
 * When a trap pane field's note under it comes and goes (docs/design-v1-look-pass-2.md
 * 2.9, D13). A field is left by a press somewhere else in the pane, and the blur comes
 * while that press is still down. A note that goes on that blur moves everything under
 * it before the press lifts, so the press clicks nothing: a Done, a fold or a switch
 * below takes a second tap. So a note goes as the words it explains change, never on
 * a blur that leaves those words as they were.
 */

/** A line of text and whether it shows why an empty required line went back to its saved words. */
export type LineState = { text: string; refused: boolean };

/** Typing in the line: a refusal's note goes with the empty line it explained. */
export function lineTyped(text: string): LineState {
  return { text, refused: false };
}

/**
 * The line left, or Enter pressed: the line after, and what to send, if
 * anything. Empty sends null, unless the line is `required`: then it goes
 * back to the saved words and says why. Left again before anything is
 * typed, it keeps saying so.
 */
export function lineLeft(state: LineState, saved: string, max: number, required: boolean): { state: LineState; send?: string | null } {
  const clean = cleanLine(state.text, max);
  if (clean === null && required) return { state: { text: saved, refused: true } };
  if ((clean ?? "") !== saved) return { state, send: clean };
  return { state: { text: saved, refused: state.refused } };
}

/** A damage part's typed dice and whether they show that they do not read. */
export type DiceState = { text: string; bad: boolean };

/** Dice as they would be sent, or null when they do not read as a formula. */
export function diceRead(text: string): string | null {
  const clean = cleanLine(text, LIMITS.diceFormulaChars);
  return clean && parseFormula(clean).ok ? clean : null;
}

/** Typing dice: their error goes once they read, so leaving the field then moves nothing under it. */
export function diceTyped(state: DiceState, text: string): DiceState {
  return { text, bad: state.bad && diceRead(text) === null };
}

/** The dice left, or Enter pressed: dice that do not read keep the last good ones and say why. */
export function diceLeft(state: DiceState, saved: string): { state: DiceState; send?: string } {
  const clean = diceRead(state.text);
  if (clean === null) return { state: { text: state.text, bad: true } };
  return clean === saved ? { state: { text: state.text, bad: false } } : { state: { text: state.text, bad: false }, send: clean };
}
