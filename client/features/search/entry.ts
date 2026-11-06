import type { IconName } from "../../components/Icon.tsx";

/**
 * The room search's entry and its anchors (designs/qol/search.md 5.10),
 * fixed first (lane Q0) so the lanes that fill the search read one shape:
 * S0 the matcher, the index and the empty catalogs, S1 the route, S2 the
 * entries and the controls' `search` ids, S3 the sheet. Types and the id
 * rule only. What matches, ranks and acts is theirs.
 */

/**
 * What a result is, as its row names it ("Setting", "Token"). A DM menu
 * item is an `action` that runs the menu's own function (`item` below).
 * Playlists and tracks are the sound library's, a `page` the Journal's.
 */
export type SearchKind =
  | "action"
  | "key"
  | "panel"
  | "dice"
  | "field"
  | "token"
  | "character"
  | "condition"
  | "section"
  | "scene"
  | "playlist"
  | "track"
  | "page"
  | "handout"
  | "setting"
  | "monster";

/**
 * Where a result goes (search.md 5.5, D-261106-150): a panel, perhaps one
 * of its pages, a fold on the way to open for now, and the control there by
 * its anchor id, pressed or only focused. S1's `openAt` takes it as is.
 */
export type SearchRoute = {
  /** A panel's id, as `PANELS` names it (features/panels.ts). */
  panel: string;
  /** A page of a panel that has pages: Menu's Room settings, a character's sheet, a scene. */
  page?: string;
  /** The fold (lib/folds.ts) to open on the way, never written to the fold's store. */
  section?: string;
  /** The `data-search` id of the control to focus and ring (SEARCH_ATTR). */
  anchor?: string;
  /** An action presses the control once it is focused, and so meets its own confirm. A setting or a section only goes there. */
  press?: boolean;
};

/**
 * What Enter does, and Shift+Enter where it differs (search.md 5.5). Each
 * kind runs what its own surface runs: a press goes through the real
 * control, a condition through the picker's op, and a DM menu item or a
 * You menu item through the item's own run function, found by its id in
 * `dmMenuSections` or `youMenuSections` (pages/chipMenus.ts, lane QC-A).
 */
export type SearchAct =
  | { t: "open"; route: SearchRoute }
  | { t: "key"; shortcut: string }
  | { t: "token"; tokenId: string }
  | { t: "character"; characterId: string; route?: SearchRoute }
  | { t: "condition"; condition: string; remove: boolean }
  /** `twin` is the panel control that does the same, which Shift+Enter goes to without pressing (search.md 5.5's twins). */
  | { t: "item"; itemId: string; twin: SearchRoute }
  | { t: "roll"; formula: string };

/** One result the search can find, for one viewer, built from the catalog or from the view this device holds. */
export type SearchEntry = {
  /**
   * Unique in one index and the same in every index built for the same
   * thing, so a recent pick, kept as its id alone, finds its entry again:
   * the kind and the thing's own id, such as `token:<id>` or `setting:<anchor>`.
   */
  id: string;
  kind: SearchKind;
  /** The row's title. A DM menu item's is the menu's own label, its audience included ("Show Belak's letter to Pat"). */
  title: string;
  /** Other names typed for it, each a little weaker than the title (search.md 5.3). */
  names?: readonly string[];
  /** The words it is meant by most often, which put it first whatever else matches. A DM entry's ship in the DM's chunk with it. */
  bets?: readonly string[];
  /** Where it lives, the row's second line after its kind: "Menu · Room settings · Combat". */
  where: string;
  icon: IconName;
  /** The key that does the same, as the shortcut sheet writes it. */
  keys?: string;
  /** A word beside the title, the DM's "Hidden". */
  mark?: string;
  /** A field's value or a switch's state on the second line: "24 of 24", "Darkvision 60 ft.", "On". */
  value?: string;
  /** Said in place of where it lives, for an item whose description matters more (Follow me while the DM looks elsewhere). */
  description?: string;
  /** Ranks above the others of its tier: the selection's fields and conditions, a player's own character (search.md 5.4). */
  near?: boolean;
  act: SearchAct;
};

/**
 * The attribute an anchor carries. The kit's Group, Switch, Checkbox,
 * Segmented, Field and Button, and features/tokens/ui.tsx's fields, take
 * an optional `search` prop that sets it (lane S2a). The route finds the
 * control by it alone, never by its words, which broke on rows that start
 * with initials or headers that carry a summary.
 */
export const SEARCH_ATTR = "data-search";

/**
 * An anchor id: lowercase words joined by hyphens, in dotted parts from
 * the panel down to the control, "dm.screens.blackout" or
 * "menu.room-settings.combat.crit-rule". Each is written whole as a string
 * literal at its one `search=` prop, so a source scan pairs every catalog
 * entry with exactly one control and the reverse (search.md 5.10). A
 * control drawn once per panel names no record: the token panel's HP field
 * is "token.hp" whatever token it shows.
 */
export const SEARCH_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export function isSearchId(id: string): boolean {
  return id.length <= 100 && SEARCH_ID.test(id);
}

/** The selector that finds an anchor in the opened panel. Ids are checked, so none needs escaping. */
export function searchSelector(id: string): string {
  return `[${SEARCH_ATTR}="${id}"]`;
}
