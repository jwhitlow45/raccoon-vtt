/**
 * The stamp art RaccoonVTT ships, drawn from `/stamps/<key>.webp`
 * (docs/design-v1-maps-vision.md section 3.5). Written by
 * `node scripts/stamps.ts`, so change the script, not this file.
 *
 * `w` and `h` are the footprint in cells, the size a new stamp takes. Each
 * image has its footprint's shape, so drawing it into its footprint never
 * stretches it. `source` names its credit in shared/credits.ts.
 */
import type { StampSourceId } from "./credits.ts";

export type ShippedStamp = { key: string; name: string; w: number; h: number; source: StampSourceId };

export const STAMP_ART: readonly ShippedStamp[] = [
  { key: "barrel", name: "Barrel", w: 0.5, h: 0.5, source: "wine_barrel_01" },
  { key: "chest", name: "Chest", w: 0.75, h: 0.5, source: "treasure_chest" },
  { key: "crate", name: "Crate", w: 0.75, h: 0.5, source: "wooden_crate_01" },
  { key: "table", name: "Table", w: 1.25, h: 0.5, source: "WoodenTable_01" },
  { key: "table-round", name: "Round table", w: 1, h: 1, source: "round_wooden_table_01" },
  { key: "bed", name: "Bed", w: 1, h: 1.5, source: "GothicBed_01" },
  { key: "bookshelf", name: "Bookshelf", w: 1, h: 0.5, source: "wooden_bookshelf_worn" },
  { key: "fire-pit", name: "Fire pit", w: 1, h: 1, source: "stone_fire_pit" },
  { key: "campfire", name: "Campfire", w: 1, h: 1, source: "top-down-village-elements" },
  { key: "campfire-embers", name: "Campfire, embers", w: 1, h: 1, source: "top-down-village-elements" },
  { key: "campfire-ashes", name: "Campfire, ashes", w: 1, h: 1, source: "top-down-village-elements" },
  { key: "woodpile", name: "Woodpile", w: 1, h: 1, source: "top-down-village-elements" },
  { key: "woodpile-long", name: "Woodpile, long", w: 2.25, h: 1, source: "top-down-village-elements" },
  { key: "wheel", name: "Broken wheel", w: 0.5, h: 0.5, source: "top-down-village-elements" },
  { key: "bucket", name: "Bucket", w: 0.5, h: 0.5, source: "top-down-village-elements" },
  { key: "tree-1", name: "Tree 1", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-2", name: "Tree 2", w: 2, h: 1.75, source: "trees-top-down-fake-shadow" },
  { key: "tree-3", name: "Tree 3", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-4", name: "Tree 4", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-5", name: "Tree 5", w: 1.5, h: 1.5, source: "trees-top-down-fake-shadow" },
  { key: "tree-6", name: "Tree 6", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-7", name: "Tree 7", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-8", name: "Tree 8", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-9", name: "Tree 9", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "tree-10", name: "Tree 10", w: 2, h: 2, source: "trees-top-down-fake-shadow" },
  { key: "bush-1", name: "Bush 1", w: 1, h: 1, source: "top-down-foliage-collection" },
  { key: "bush-2", name: "Bush 2", w: 1, h: 1, source: "top-down-foliage-collection" },
  { key: "bush-3", name: "Bush 3", w: 1, h: 1, source: "top-down-foliage-collection" },
  { key: "bush-4", name: "Bush 4", w: 1, h: 1, source: "top-down-foliage-collection" },
  { key: "bush-5", name: "Bush 5", w: 1, h: 1, source: "top-down-foliage-collection" },
  { key: "ferns-1", name: "Ferns 1", w: 2, h: 2, source: "top-down-foliage-collection" },
  { key: "ferns-2", name: "Ferns 2", w: 2, h: 2, source: "top-down-foliage-collection" },
  { key: "spiky-plant", name: "Spiky plant", w: 1.5, h: 1.5, source: "top-down-foliage-collection" },
  { key: "rock-1", name: "Rock 1", w: 1, h: 1, source: "simple-stones" },
  { key: "rock-2", name: "Rock 2", w: 1, h: 1, source: "simple-stones" },
  { key: "rock-3", name: "Rock 3", w: 0.75, h: 1, source: "simple-stones" },
  { key: "rock-4", name: "Rock 4", w: 1, h: 1, source: "simple-stones" },
  { key: "rock-5", name: "Rock 5", w: 1, h: 0.75, source: "simple-stones" },
  { key: "rock-6", name: "Rock 6", w: 0.5, h: 0.5, source: "simple-stones" },
  { key: "rocks-1", name: "Rocks 1", w: 0.75, h: 0.75, source: "simple-stones" },
  { key: "rocks-2", name: "Rocks 2", w: 0.75, h: 0.75, source: "simple-stones" },
  { key: "young-pine", name: "Young pine", w: 0.75, h: 0.75, source: "fir_sapling" },
  { key: "mossy-rock-1", name: "Mossy rock 1", w: 1.5, h: 2.25, source: "rock_moss_set_01" },
  { key: "mossy-rock-2", name: "Mossy rock 2", w: 1.5, h: 1.5, source: "rock_moss_set_01" },
  { key: "stone-1", name: "Stone 1", w: 0.25, h: 0.5, source: "namaqualand_boulders_01" },
  { key: "stone-2", name: "Stone 2", w: 0.25, h: 0.5, source: "namaqualand_boulders_01" },
];
