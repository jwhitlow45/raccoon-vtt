import { createStore } from "zustand/vanilla";
import type { Character } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";

/**
 * The character whose page the Characters panel shows
 * (docs/design-v1-look-pass.md 3.1), per Room page (state/scope.ts), as
 * `journalSlot` holds the open journal page: so the page survives the
 * remount a crossing of 900 px makes, a companion's "Companion of Thorn"
 * opens Thorn's page from the token panel, and "view as a player" keeps
 * its own. `undefined` until the viewer first picks a page or the list,
 * which is when a player with one character lands on its page. `null` is
 * the list.
 */
export const characterPageSlot = scopeSlot(() => createStore<{ characterId: string | null | undefined }>(() => ({ characterId: undefined })));

/** The page that shows: the one picked, while it is one of the viewer's characters, else a player's only character until they pick. */
export function shownPage(picked: string | null | undefined, mine: readonly Pick<Character, "id">[], dm: boolean): string | null {
  if (picked === undefined) return !dm && mine.length === 1 ? (mine[0]?.id ?? null) : null;
  return picked !== null && mine.some((c) => c.id === picked) ? picked : null;
}

/**
 * Where Back's focus goes from a character's page when the row pressed to
 * open it is not there (features/panels.ts PanelHeader `backTo`): its own
 * row, then the rows after it and before it, nearest first, then New
 * character, else the empty list's line. So a page the panel opened onto
 * goes back to its row, and a page deleted from inside it hands focus to
 * its neighbor.
 */
export function pageBackTo(characterId: string, mine: readonly Pick<Character, "id">[]): string[] {
  const at = mine.findIndex((c) => c.id === characterId);
  const neighbors = at < 0 ? [] : [...mine.slice(at + 1), ...mine.slice(0, at).reverse()];
  return [characterId, ...neighbors.map((c) => c.id)].map((id) => `character:${id}`).concat("new-character", "characters-empty");
}
