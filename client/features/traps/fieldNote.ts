import { parseFormula } from "#shared/dice/formula.ts";
import { LIMITS } from "#shared/limits.ts";
import { cleanLine } from "./rules.ts";

/*
 * When a trap pane field's note under it comes and goes (docs/design-v1-look-pass-2.md
 * 2.9, D13). A field is left by a press somewhere else in the pane, and the blur comes
 * while that press is still down. A note that comes or goes on that blur moves
 * everything under it before the press lifts, so the press clicks nothing: a Done, a
 * fold or a switch below takes a second tap. So a note goes as the words it explains
 * change, and comes while the field is focused: once typing has rested NOTE_REST_MS
 * (decided for review LP17-TR-2), or on Enter, never on a blur. Left before then, the
 * field goes back to its saved words in silence, which moves nothing. Rejected: a note
 * on every keystroke, which flags dice half typed, as "2d", and a line kept for the
 * note always, which costs a phone's room.
 */

/** How long typing rests before a field says what is wrong with it. */
export const NOTE_REST_MS = 600;

/** A line of text and whether it shows why an empty required line went back to its saved words. */
export type LineState = { text: string; refused: boolean };

/** Typing in the line: a refusal's note goes with the empty line it explained. */
export function lineTyped(text: string): LineState {
  return { text, refused: false };
}

/** Typing has rested in the line: a `required` line left empty says so now, while the field is still being typed in. */
export function lineRested(state: LineState, max: number, required: boolean): LineState {
  return { text: state.text, refused: required && cleanLine(state.text, max) === null };
}

/**
 * The line left, or Enter pressed: the line after, and what to send, if
 * anything. Empty sends null, unless the line is `required`: then it goes
 * back to the saved words, still saying why if it already did, and saying
 * nothing new. Left again before anything is typed, it keeps saying so.
 */
export function lineLeft(state: LineState, saved: string, max: number, required: boolean): { state: LineState; send?: string | null } {
  const clean = cleanLine(state.text, max);
  if (clean === null && required) return { state: { text: saved, refused: state.refused } };
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

/** Typing has rested in the dice: dice that do not read say so now. */
export function diceRested(state: DiceState): DiceState {
  return { text: state.text, bad: diceRead(state.text) === null };
}

/**
 * The dice left, or Enter pressed: dice that do not read keep the last good
 * ones. Already saying why, they stay as typed with their error. Left
 * before that, they go back to the last good ones in silence.
 */
export function diceLeft(state: DiceState, saved: string): { state: DiceState; send?: string } {
  const clean = diceRead(state.text);
  if (clean === null) return { state: state.bad ? state : { text: saved, bad: false } };
  return clean === saved ? { state: { text: state.text, bad: false } } : { state: { text: state.text, bad: false }, send: clean };
}
