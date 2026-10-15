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
