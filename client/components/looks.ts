import type { CSSProperties } from "react";
import { theme } from "../lib/theme.ts";

/**
 * The colors of a control in each state, shared by Button, IconButton,
 * Chip, Segmented and the tabs (docs/design-v1-visual.md 2.2 and 2.3), so
 * "chosen" and "cannot act yet" look the same wherever they appear.
 *
 * Disabled swaps colors and keeps the shape. It never fades by opacity:
 * at half opacity a yellow fill turned olive and a green one murky, which
 * read as a broken color rather than "not yet".
 */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export type ControlState = { pressed?: boolean; disabled?: boolean; armed?: boolean };

/** Chosen, on or pressed: the accent's tint behind an accent outline and an accent label. */
export const PRESSED: CSSProperties = {
  background: theme.color.accentTint,
  border: `${theme.line.border}px solid ${theme.color.accent}`,
  color: theme.color.accent,
};

const RAISED: CSSProperties = {
  background: theme.color.surfaceRaised,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  color: theme.color.text,
};

const QUIET: CSSProperties = { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.text };

/**
 * How every destructive button looks (decided 2026-10-13): delete, remove,
 * kick, sign out, clear, end the fight, forget. At rest it is an ordinary
 * button with red text, so the danger reads without a page of red outlines.
 * A button that asks for a second tap is armed after the first, and only
 * then takes the red outline and tint, so the tap that acts looks unlike
 * the tap that asks.
 */
export function dangerLook(armed = false): CSSProperties {
  return armed ? { color: theme.color.dangerText, border: `${theme.line.border}px solid ${theme.color.danger}`, background: theme.color.dangerTint } : { color: theme.color.dangerText };
}

/** A chosen option that cannot change now keeps its place with a dim outline and no tint, so it still reads as the one chosen. */
const CHOSEN_DISABLED: CSSProperties = {
  background: "transparent",
  border: `${theme.line.border}px solid ${theme.color.textDisabled}`,
  color: theme.color.textDisabled,
};

/** Background, border and label color of a button in a state (design 2.2 and the disabled table of 2.3). */
export function buttonLook(variant: ButtonVariant, state: ControlState = {}): CSSProperties {
  const quiet = variant === "quiet";
  if (state.disabled) {
    if (state.pressed && variant !== "primary") return CHOSEN_DISABLED;
    return quiet ? { ...QUIET, color: theme.color.textDisabled } : { ...RAISED, color: theme.color.textDisabled };
  }
  switch (variant) {
    case "primary":
      return { background: theme.color.accent, border: `${theme.line.border}px solid ${theme.color.accent}`, color: theme.color.onAccent };
    case "danger":
      return { ...RAISED, ...dangerLook(state.armed) };
    case "quiet":
      return state.pressed ? PRESSED : QUIET;
    case "secondary":
      return state.pressed ? PRESSED : RAISED;
  }
}

/**
 * A choice among others (a Segmented option, a Chip, a tab): raised at
 * rest, the pressed look when chosen, and when disabled a dim label, or a
 * dim outline for the chosen one.
 */
export function choiceLook(chosen: boolean, disabled = false): CSSProperties {
  if (disabled) return chosen ? CHOSEN_DISABLED : { ...RAISED, color: theme.color.textDisabled };
  return chosen ? PRESSED : RAISED;
}
