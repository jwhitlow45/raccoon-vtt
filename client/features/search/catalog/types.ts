import type { ProjectedActor } from "#shared/project.ts";
import type { IconName } from "../../../components/Icon.tsx";
import type { DmMenuView } from "../../../pages/chipMenus.ts";
import type { RoomView } from "../../../state/types.ts";
import type { SearchEntry } from "../entry.ts";

/**
 * The shape of the search's catalog (designs/qol/search.md 5.10): the
 * sections, settings and actions written by hand beside the features that
 * own them, the fields of a creature's panel and page, and the words for
 * the panels. Two catalogs hold them: catalog/everyone.ts, in the room's
 * chunk, with what both roles have, and catalog/dm.ts, which loads for a
 * DM alone (dmCatalog.ts), so a player's device never holds the DM's
 * entries, their other names, best bets or count (search.md 5.9). Types
 * only, in their own file, so a catalog and a feature's entries import
 * them without importing the index that reads them.
 */

export type SearchRole = "dm" | "player";

/** What a catalog entry may read when the index is built: who is searching and the room as this device holds it, a player's projection. */
export type SearchContext = {
  role: SearchRole;
  /** This device's member, or null before the room said who it is. */
  memberId: string | null;
  state: RoomView;
  /** From 900 px up, where the side panel and its row of tabs stand (index.ts IndexInput). */
  wide: boolean;
  /**
   * The DM menu's view as the menu reads it (pages/ChipMenus.tsx
   * useDmMenuView), for the DM's items: with it come the parts the room's
   * state lacks, this device's recent handouts and where the DM's camera
   * stands. Without it the DM's catalog reads what it can from `state`.
   */
  dmMenu?: DmMenuView;
};

/** A section, setting or action of the catalog. */
export type CatalogEntry = SearchEntry & {
  /** Offered only while this holds: Start a fight outside a fight, a scene's settings while it shows. Left out, always. */
  when?(ctx: SearchContext): boolean;
  /** The value its row shows now, a switch's "On" or "Off", read when the index is built. It wins over `value`. */
  valueNow?(ctx: SearchContext): string | undefined;
  /**
   * Its place on an empty field's Suggested list, lowest first (search.md
   * 5.2, index.ts SUGGEST). Left out, it is never suggested.
   */
  suggest?: number;
};

/** Where a creature's surface shows a field: the fold on the way, and the control's `data-search` id. */
export type FieldPlace = { section?: string; anchor: string };

/**
 * A field of a token's panel or a character's page (search.md 4): the
 * index makes one entry of it for the selected token and for each
 * character the viewer may search, with that creature's value.
 */
export type FieldDef = {
  /** Unique among the fields, the last part of each entry's id: "hp" gives `field:character:<id>:hp`. */
  key: string;
  title: string;
  names?: readonly string[];
  bets?: readonly string[];
  icon: IconName;
  /** Where the token panel shows it for the selection. Left out, the panel has no such field. */
  token?: FieldPlace;
  /** Where a character's page shows it. Left out, the page has no such field. */
  page?: FieldPlace;
  /**
   * One of the few a DM looks up in play, found for every character: HP,
   * AC, Passive Perception, Senses, the rests and conditions. A player
   * finds every page field of their own characters.
   */
  everyCharacter?: true;
  /**
   * The value its row shows, from the creature's actor as this device holds
   * it: "24 of 24", "Darkvision 60 ft.". A player's view may hold only the
   * public part of it, a token lent to them standing for a character they
   * do not play, so any field but `life` and `effects` may be missing.
   */
  value?(actor: ProjectedActor): string | undefined;
};

/** A panel's other names and best bets, "init" for Initiative. */
export type PanelWords = { names?: readonly string[]; bets?: readonly string[] };

export type Catalog = {
  entries: readonly CatalogEntry[];
  fields: readonly FieldDef[];
  /** By panel id (features/panels.ts). A DM-only panel's words live in the DM's catalog. */
  panels: Readonly<Record<string, PanelWords>>;
  /**
   * Entries made from the room now, each running a menu item's own function
   * (search.md 5.5): the DM menu's items from `dmMenuSections` in the DM's
   * catalog, and a player's You menu items from `youMenuSections` in
   * everyone's, gated there by role. Lane S2a writes both.
   */
  items?(ctx: SearchContext): readonly CatalogEntry[];
};
