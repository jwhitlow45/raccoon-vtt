import type { TerrainId } from "#shared/model.ts";
import { STAMP_ART } from "#shared/stamps.ts";
import { STARTER_STAMPS } from "#shared/starterStamps.ts";
import type { Theme } from "./settings.ts";

/*
 * The props a generated room is dressed with (phase 2, 5.5, D-261107-201):
 * keys from the shipped stamps and the starter props only, so nothing is
 * copied and every picture already carries its credit. None reads as a
 * rule it is not: no hole, pit, stair, bridge, crack, slime or pond, no
 * light source without its light, and no boulder big enough to look like
 * it blocks the way.
 */

export const PROPS: Readonly<Record<Theme, readonly string[]>> = {
  dungeon: ["crate", "barrel", "gb-sack", "gb-crate", "gb-chest", "gb-pot", "wg-scattered-bones", "ph-statue"],
  crypt: ["wg-skeleton", "wg-scattered-bones", "gb-pot", "gb-chest-dark", "ph-candlestick", "ph-goblets", "ph-statue", "gb-ritual-star"],
  cave: ["rock-6", "rocks-1", "rocks-2", "stone-1", "stone-2", "gb-mushrooms", "wg-scattered-bones", "wg-skeleton"],
  mine: ["crate", "barrel", "ph-long-crate", "gb-open-crate", "gb-sack", "gb-sack-2", "wheel", "woodpile", "woodpile-long", "bucket", "ph-broken-barrel"],
  sewer: ["barrel", "ph-broken-barrel", "crate", "gb-sack", "wg-scattered-bones", "wg-skeleton", "bucket"],
};

/** A Dungeon's wood-floored rooms are furnished rather than stored in. */
export const DUNGEON_WOOD_PROPS: readonly string[] = ["gb-table", "gb-long-table", "ph-bench", "gb-bed", "gb-bookcase", "gb-dresser", "chest", "barrel", "gb-woven-rug", "gb-bordered-rug"];

/** Pieces that stand with a long side against a wall: beds, bookcases, benches and long tables. */
export const WALL_PIECES: ReadonlySet<string> = new Set(["gb-bed", "gb-bookcase", "ph-bench", "gb-long-table"]);

/** Stamps never placed as props, because each reads as a rule or a light it is not. */
export const BANNED_PROPS: readonly string[] = [
  "gb-hole",
  "gb-chasm",
  "gb-round-pit",
  "gb-square-pit",
  "gb-stairs-down",
  "gb-spiral-stairs",
  "gb-plank-bridge",
  "gb-floor-crack",
  "gb-slime-pool",
  "wg-pond",
  "fire-pit",
  "campfire",
  "gb-campfire",
  "ph-lantern",
  "ph-candelabra",
  "gb-large-rock",
  "ph-boulder",
  "ph-large-boulder-1",
  "ph-large-boulder-2",
  "mossy-rock-1",
  "mossy-rock-2",
];

/** The props a room of the theme draws from, by its floor. */
export function propsFor(theme: Theme, floor: TerrainId): readonly string[] {
  return theme === "dungeon" && floor === "wood" ? DUNGEON_WOOD_PROPS : PROPS[theme];
}

const SIZES = new Map<string, { w: number; h: number }>([...STAMP_ART, ...STARTER_STAMPS].map((s) => [s.key, { w: s.w, h: s.h }]));

/** A stamp's footprint in cells, as the catalog gives it, or null for a key no catalog holds. */
export function stampSize(key: string): { w: number; h: number } | null {
  return SIZES.get(key) ?? null;
}
