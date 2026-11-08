import data from "./trinkets.json" with { type: "json" };

/**
 * The Trinkets table from SRD 5.2.1's Character Creation (CC-BY-4.0, see
 * NOTICE.md), generated into trinkets.json by scripts/srd-import.ts. The
 * SRD says the d100 table "can help stock a room in a dungeon", which is what
 * the dungeon generator's key uses it for. Entry i is the roll i + 1, so the
 * table's 00 is the last. The list is empty if the file ever has no text, and
 * the key then leaves the trinket out.
 */
export const TRINKETS: readonly string[] = data as readonly string[];
