import type { Catalog } from "./types.ts";

/**
 * The DM's part of the search (designs/qol/search.md 5.8 and 5.9): the DM
 * panel, Scenes, Time and Sound, Room settings, Members, the token panel's
 * DM rows, the DM-only panels' words and the adapter from the DM menu's
 * items with their twins. Only dmCatalog.ts loads it, by a dynamic import
 * behind a strict role check, so it is a chunk of its own that a player's
 * device never asks for. A static import anywhere else would fold it into
 * the room's chunk, and dmCatalog.test.ts's source scan fails on one.
 * Empty until lanes S2a and S2b write the entries.
 */
export const DM_CATALOG: Catalog = { entries: [], fields: [], panels: {} };
