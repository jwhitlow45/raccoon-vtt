/**
 * The keys of a menu on the shared popover base (components/Menu.tsx,
 * docs/design-v1-panel-tabs.md 4.4 and 5.2): the side panel's More, and
 * Setup and Tools in the toolbar (docs/design-v1-tool-options.md 5.1 and
 * 5.2), so every pick list in the room takes the same keys. Pure, so the
 * rules are tested without a page.
 *
 * Escape, Tab and Shift+Tab are the base's (components/popoverRules.ts),
 * the same for every popover and menu, so none of them is handled here.
 */

/** The parts of a keydown a menu reads. `letter` is the Latin letter the key types, or null (state/shortcuts.ts letterOf). */
export type MenuKey = { key: string; letter: string | null; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

export type MenuAction =
  | { type: "focus"; index: number }
  | { type: "pick"; index: number }
  /** Typeahead, which needs the time and the titles (typeahead). */
  | { type: "type"; letter: string }
  /** A key the menu leaves alone, such as Ctrl+Z, which acts as anywhere. */
  | { type: "none" };

/**
 * What a key does on the focused item (`index`, -1 when no item has
 * focus) of `count` items. Down and Up move to the next and the previous
 * item, wrapping, and in a menu of tiles, which stand in a grid, Right and
 * Left do the same. In a list, Left and Right do nothing. Home and End go
 * to the first and the last. Enter and Space pick. A letter types ahead.
 * Every action but "none" is marked used (preventDefault), so no room
 * shortcut runs while focus is in a menu: a letter goes to an item rather
 * than picking a tool, and S does not hide the side panel.
 *
 * A disabled item (`disabled`) takes focus, so its description is heard
 * and the keys move past it as past any other, but Enter and Space on it
 * pick nothing: focus stays on it, and the keys are still marked used.
 */
export function menuAction(e: MenuKey, index: number, count: number, tiles: boolean, disabled: (index: number) => boolean = () => false): MenuAction {
  if (e.ctrlKey || e.metaKey || e.altKey || count === 0) return { type: "none" };
  const next = (index + 1) % count;
  const previous = index <= 0 ? count - 1 : index - 1;
  switch (e.key) {
    case "ArrowDown":
      return { type: "focus", index: next };
    case "ArrowUp":
      return { type: "focus", index: previous };
    case "ArrowRight":
      return tiles ? { type: "focus", index: next } : { type: "none" };
    case "ArrowLeft":
      return tiles ? { type: "focus", index: previous } : { type: "none" };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: count - 1 };
    case "Enter":
    case " ":
      if (index < 0) return { type: "none" };
      return disabled(index) ? { type: "focus", index } : { type: "pick", index };
  }
  return e.letter !== null ? { type: "type", letter: e.letter } : { type: "none" };
}

/** What the opening item is chosen by: whether an item is one of the menu's one choice ("radio", the default) and whether it is checked. */
export type OpeningItem = { kind?: "radio" | "checkbox"; checked?: boolean };

/**
 * The item a key open focuses: the checked one, else the first, or with
 * Up ("last") the last. Only radio items count, so a checkbox at the top
 * of the menu, such as More's "Two panels" (docs/design-v1-split-panel.md
 * 6), never takes the place a key open lands on, checked or not. A menu
 * of checkboxes alone opens at its first or last.
 */
export function openingIndex(items: readonly OpeningItem[], from: "first" | "last"): number {
  if (items.length === 0) return -1;
  const radio = items.flatMap((item, i) => ((item.kind ?? "radio") === "radio" ? [i] : []));
  const checked = radio.find((i) => items[i]!.checked === true);
  if (checked !== undefined) return checked;
  if (radio.length === 0) return from === "last" ? items.length - 1 : 0;
  return from === "last" ? radio[radio.length - 1]! : radio[0]!;
}

/** How long typed letters run together into one prefix. */
export const TYPEAHEAD_MS = 500;

export type Typed = { readonly text: string; readonly at: number };

/**
 * Typeahead: the next item, from the focused one and wrapping, whose title
 * starts with what was typed in the last 500 ms. A letter alone, or the
 * same letter again, starts after the focused item, so it steps through
 * the items that start with it ("m": Monsters, then Menu). Two different
 * letters in time are one prefix, which may stay on the focused item
 * ("mo" on Monsters). With no match, focus stays where it is (index null).
 */
export function typeahead(before: Typed | null, letter: string, now: number, titles: readonly string[], focused: number): { typed: Typed; index: number | null } {
  const text = (before !== null && now - before.at <= TYPEAHEAD_MS ? before.text : "") + letter.toLowerCase();
  const typed = { text, at: now };
  const first = text[0]!;
  const repeated = [...text].every((c) => c === first);
  const prefix = repeated ? first : text;
  const start = repeated ? focused + 1 : Math.max(focused, 0);
  for (let k = 0; k < titles.length; k++) {
    const i = (start + k) % titles.length;
    if (titles[i]!.toLowerCase().startsWith(prefix)) return { typed, index: i };
  }
  return { typed, index: null };
}
