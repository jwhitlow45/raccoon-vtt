import type { StairDirection } from "#shared/model.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";

/** Height mode's stairs choice (store.ts StairChoice), named here so the readout's words need no store. */
type StairChoice = StairDirection | "remove";

/**
 * A hex stair's six facings in words and arrows (docs/design-v1-hex-grids.md
 * H3), in hexNeighbors' order: clockwise from east on hex rows, and on hex
 * columns the same order mirrored, counterclockwise from south. The arrows
 * point up each stair, so they stay text.
 */
export const HEX_FACING_ARROWS = {
  rows: [
    ["→", "east"],
    ["↘", "south-east"],
    ["↙", "south-west"],
    ["←", "west"],
    ["↖", "north-west"],
    ["↗", "north-east"],
  ],
  columns: [
    ["↓", "south"],
    ["↘", "south-east"],
    ["↗", "north-east"],
    ["↑", "north"],
    ["↖", "north-west"],
    ["↙", "south-west"],
  ],
} as const;

/** What a hex facing is called in words, as in "up to the south-east". */
export function hexFacingName(orient: "rows" | "columns", facing: number): string {
  return HEX_FACING_ARROWS[orient][facing]![1];
}

const SQUARE_CHOICES: readonly StairChoice[] = ["a", "n", "e", "s", "w", "remove"];
const HEX_CHOICES: readonly StairChoice[] = ["a", "0", "1", "2", "3", "4", "5", "remove"];

/** The stairs choices a grid takes: Auto, its facings, and Remove. */
export function stairChoiceValues(g: Grid): readonly StairChoice[] {
  return isHex(g) ? HEX_CHOICES : SQUARE_CHOICES;
}

/** The stairs choice as the grid takes it: a facing of the other grid's reads as Auto, so a mark never takes a facing its scene cannot hold. */
export function stairChoiceOn(g: Grid, choice: StairChoice): StairChoice {
  return stairChoiceValues(g).includes(choice) ? choice : "a";
}
