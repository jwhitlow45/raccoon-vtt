import type { CSSProperties } from "react";

/**
 * The accessible name of a button with a short visible label and a longer
 * title. The visible words are the name, so a screen reader announces what
 * is on screen and voice control finds the button by what it says ("Undo"
 * was announced as "Take back the last draft edit"). The title stays as
 * the tooltip. A title that repeats the label and adds to it ("Move
 * players to the Cave", for one of several "Move players") is still the
 * better name. A label with no letters (an arrow, a minus sign, a number)
 * says nothing by itself, and then the title is the name.
 */
export function accessibleName(label: unknown, title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  if (typeof label !== "string" || !/\p{L}/u.test(label)) return title;
  return title.toLowerCase().includes(label.trim().toLowerCase()) ? title : undefined;
}

/**
 * Hides text from sight but not from screen readers: the start of a name
 * the screen shows only in part, a count a badge shows as a number, a
 * status line the page speaks.
 */
export const VISUALLY_HIDDEN: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
