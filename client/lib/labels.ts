import type { RoomState, Token, TokenId } from "#shared/model.ts";
import { labelParts, labelText as sharedLabelText, nameEntry, NUMBER_NAMES_MOST, numberable, numbersOf, numberScope, previewNumbers, shownName, type TokenLabel } from "#shared/numbering.ts";

/**
 * How a device names a creature (docs/design/design-v1-creature-numbers.md 5):
 * one label per token, made once per view by the store's label map
 * (state/labels.ts) and read by every screen through `displayName`.
 *
 * A label is the name this viewer reads and what follows it. `number` is
 * the table's number, the one every player reads. `preview`, on a DM's
 * device alone, is the number a creature the party has not seen would take
 * if they saw it now, drawn in brackets so it never reads as one the table
 * gave. `as` is a disguise's shown name, which the DM and the owner read
 * after the real one, with the number it carries at the table.
 */
export type Label = TokenLabel;

/** What follows a label's name: " 2", " (3)", " (as Goblin 2)", " (as Goblin (3))", or nothing. */
export function labelSuffix(label: Omit<Label, "name">): string {
  const count = countText(label);
  if (label.as !== undefined) return ` (as ${label.as}${count ? ` ${count}` : ""})`;
  return count ? ` ${count}` : "";
}

/** The number as the label writes it: "2", a preview "(3)", or empty. */
export function countText(label: Omit<Label, "name">): string {
  if (label.number !== undefined) return String(label.number);
  if (label.preview !== undefined) return `(${label.preview})`;
  return "";
}

/** The whole label: "Goblin 2", "Goblin (3)", "Orc (as Goblin 2)", as the server writes it too. */
export function labelText(label: Label): string {
  return sharedLabelText(label);
}

/**
 * What a screen reader says for a label. Brackets and "as" read badly
 * aloud, so a preview says what it means and a disguise says who reads it.
 */
export function labelSpoken(label: Label): string {
  const count = label.number !== undefined ? ` ${label.number}` : "";
  const shown = label.as !== undefined ? `, shown to players as ${label.as}${count}` : count;
  const preview = label.preview !== undefined ? `, would be ${label.preview}, not yet seen by the party` : "";
  return `${label.name}${shown}${preview}`;
}

/** Whether a label's number is a preview, which the board draws outlined. */
export function isPreview(label: Pick<Label, "preview">): boolean {
  return label.preview !== undefined;
}

/** The number a token's badge shows: the table's, or a DM's preview. */
export function badgeNumber(label: Pick<Label, "number" | "preview">): number | undefined {
  return label.number ?? label.preview;
}

/** A label without its name: what the board's layout carries beside the name it wraps and cuts. */
export type NameTag = Omit<Label, "name">;

/** Every token's label in a view, by token id (state/labels.ts). */
export type Labels = ReadonlyMap<string, Label>;

/**
 * A token's label from the map, or from the token itself when the map has
 * none, as for a token copied outside the view. A copy's `number` is the
 * table's in every copy the server sends (docs/design/design-v1-creature-numbers.md
 * 4), so the fallback can only show less than the map would: no preview
 * and no disguise.
 */
export function labelOf(labels: Labels | undefined, token: { id?: string; name: string; number?: number }): Label {
  const label = token.id === undefined ? undefined : labels?.get(token.id);
  if (label) return label;
  return token.number === undefined ? { name: token.name } : { name: token.name, number: token.number };
}

/** The view a label map is made from: a device's copy of the room. */
export type LabelView = Pick<RoomState, "tokens" | "scenes" | "members" | "characters">;

/**
 * Every token's label in a device's view. A DM's board adds previews,
 * worked out once per scene its view holds (shared/numbering.ts
 * previewNumbers), and a player's never does: the role decides, never what
 * the copy happens to hold. An entry equal to the one in `previous` keeps
 * that object, so a screen that reads one token's label redraws only when
 * it changes, and a map whose every entry is unchanged is `previous`
 * itself.
 */
export function labelsFor(view: LabelView, role: "dm" | "player", previous?: Labels): Labels {
  const labelFor = role === "dm" ? "board" : "own";
  const previews = new Map<TokenId, number>();
  if (labelFor === "board") {
    const scopes = new Set<string>();
    for (const token of Object.values(view.tokens)) scopes.add(numberScope(view, token));
    for (const scope of scopes) for (const [id, n] of previewNumbers(view, scope)) previews.set(id, n);
  }
  const out = new Map<string, Label>();
  let same = previous !== undefined;
  for (const token of Object.values(view.tokens)) {
    const made = labelParts(null, token, labelFor, previews);
    const before = previous?.get(token.id);
    if (before && sameLabel(before, made)) out.set(token.id, before);
    else {
      out.set(token.id, made);
      same = false;
    }
  }
  // The board lays every label out again when the map changes, so a change elsewhere in the room keeps the map itself.
  return same && previous !== undefined && previous.size === out.size ? previous : out;
}

function sameLabel(a: Label, b: Label): boolean {
  return a.name === b.name && a.number === b.number && a.preview === b.preview && a.as === b.as;
}

/** What a DM's token panel says under a bracketed number. */
export const PREVIEW_HELP = "Not yet seen by the party. It takes this number when they see it, if they have seen no other first.";
/** What a DM's token panel says under a creature whose scene gives no more names numbers. */
export const NAMES_FULL_HELP = `The party has met ${NUMBER_NAMES_MOST} creature names on this scene, the most it keeps numbers for. New names get no number here.`;

/**
 * The help line under a creature's name in a DM's token panel: what a
 * preview means, what players read of a disguise, or that the scene gives
 * no more names numbers (`full`, namesFull). None for anyone else.
 */
export function numberHelp(label: Label, dm: boolean, full: boolean): string | null {
  if (!dm) return null;
  if (label.preview !== undefined) return PREVIEW_HELP;
  if (label.as !== undefined && label.number !== undefined) return `Players read ${label.as} ${label.number}.`;
  return full ? NAMES_FULL_HELP : null;
}

/**
 * Whether the creature could take a number but its scene's numbers are
 * full: a creature of a name the party has not met there, on a scene that
 * has numbered the most names it keeps. Read on a DM's copy, which holds
 * the scene's numbers.
 */
export function namesFull(view: LabelView, token: Token): boolean {
  // A member's name always has its entry, so the entry alone tells a met name from a new one.
  if (!numberable(view, token)) return false;
  const scope = numberScope(view, token);
  return Object.keys(numbersOf(view, scope)).length >= NUMBER_NAMES_MOST && nameEntry(view, scope, shownName(token)) === undefined;
}
