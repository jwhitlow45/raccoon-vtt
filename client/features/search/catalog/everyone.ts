import type { Catalog } from "./types.ts";

/**
 * What both roles' searches find beyond the panels, keys and the room's own
 * things (designs/qol/search.md 5.10): This device, Initiative's and the
 * Dice panel's own rows, the Log's Chat only, the fields of a creature's
 * panel and page, and a player's You menu items. It ships in the room's
 * chunk, so it holds nothing only a DM may know: the DM's entries live in
 * catalog/dm.ts. Empty until lanes S2a and S2b write the entries.
 */
export const EVERYONE: Catalog = { entries: [], fields: [], panels: {} };
