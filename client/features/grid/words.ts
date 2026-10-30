import type { CreatureSize, GridShape, RoomSettings, Scene } from "#shared/model.ts";
import { cellWord, isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { sceneHexSpan } from "#shared/rules/hex.ts";
import { SIZE_WORDS } from "../tokens/sizeWords.ts";

/*
 * The words a hex scene shows (docs/design-v1-hex-grids.md section 6's UI
 * words table and section 8). Every string that names the grid's cell
 * reads the scene's cell word through `cellWord`, the one the server's
 * refusals and undo labels read too, so a hex scene never says "square"
 * outside the Squares choices.
 */

export { cellWord };

/** The grid's cell, "square" or "hex", for a scene. `many` gives "squares" or "hexes". */
export function sceneCellWord(scene: Pick<Scene, "gridShape">, many = false): string {
  return cellWord(sceneGrid(scene), many);
}

/** The three shapes, Hex rows first among the hexes (HX-D1). "squares" stands for no stored shape. */
export type ShapeChoice = "squares" | GridShape;

export const SHAPE_CHOICES: readonly { value: ShapeChoice; label: string }[] = [
  { value: "squares", label: "Squares" },
  { value: "hexRows", label: "Hex rows" },
  { value: "hexColumns", label: "Hex columns" },
];

export const SHAPE_HELP = "Hex rows have pointed tops and run straight across. Hex columns have flat tops and run straight down.";

export const NEW_SCENES_HELP = "The grid a new battle mat or map starts with. Builder scenes and starter maps start on squares. Each new scene can pick its own.";

/** A stored shape as the choices read it. */
export function shapeChoice(shape: GridShape | undefined): ShapeChoice {
  return shape ?? "squares";
}

/** A choice as stored: squares are no shape at all, so a square scene's stored form never changes. */
export function storedShape(choice: ShapeChoice): GridShape | undefined {
  return choice === "squares" ? undefined : choice;
}

/*
 * H1's limit lines (section 6): what a hex scene leaves out until a later
 * phase, said where the DM would reach for it.
 */
export const HEX_LIMITS = {
  builder: "On hexes the builder draws wall lines, paints heights and stairs, marks difficult ground, and places lights, stamps and labels. Painted ground needs squares.",
  sizes: "On hexes a creature takes its size's hexes: Large 3, Huge 7, Gargantuan 12.",
  counting: "Counting works on squares. Use the box.",
  starter: "Starter maps are drawn on squares.",
  uvtt: "Universal VTT files make square scenes.",
} as const;

/** How many hexes a creature of a size takes on a hex scene (HX-D4), for "Large (3 hexes)". */
export const SIZE_HEXES = { tiny: 1, small: 1, medium: 1, large: 3, huge: 7, gargantuan: 12 } as const;

/** A named token size includes its footprint on either hex orientation. */
export function tokenSizeLabel(size: CreatureSize, shape?: GridShape): string {
  const name = SIZE_WORDS[size];
  if (shape === undefined || size === "custom") return name;
  const count = SIZE_HEXES[size];
  return `${name} (${count} ${count === 1 ? "hex" : "hexes"})`;
}

/**
 * Whether the room's settings speak of hexes beside squares: the room
 * holds a hex scene, or its new scenes start on hexes (section 6's table,
 * the Room settings row).
 */
export function roomHasHexes(scenes: readonly Pick<Scene, "gridShape">[], settings: Pick<RoomSettings, "newScenes">): boolean {
  return settings.newScenes !== undefined || scenes.some((s) => s.gridShape !== undefined);
}

/**
 * The Size row's words (HX-D16). On squares the size is typed in squares.
 * On hexes it reads in the room's feet-per-cell steps, since rows do not
 * fit whole cells, with a line saying how many hexes it holds.
 */
export function sizeWords(g: Grid, bounds: { w: number; h: number }, feetPerCell: number): { name: string; across: string; down: string; holds: string | null } {
  if (!isHex(g)) return { name: "Size in squares", across: "Squares across", down: "Squares down", holds: null };
  const span = sceneHexSpan(g, bounds);
  const holds =
    span.cols === 0 || span.rows === 0
      ? "Holds no whole hex. Make it larger."
      : g.orient === "rows"
        ? `Holds ${span.cols} ${span.cols === 1 ? "hex" : "hexes"} across and ${span.rows} ${span.rows === 1 ? "row" : "rows"} down.`
        : `Holds ${span.cols} ${span.cols === 1 ? "column" : "columns"} across and ${span.rows} ${span.rows === 1 ? "hex" : "hexes"} down.`;
  return { name: `Size in ${feetPerCell} ft steps`, across: "Across", down: "Down", holds };
}
