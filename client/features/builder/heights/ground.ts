import type { BuildChunk, RoomState, Scene } from "#shared/model.ts";
import { isCellFullyFogged, isSubcellFogged } from "#shared/rules/fog.ts";
import { isHex, sceneGrid, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { facingsOf, groundAt, type Compass, type Facing } from "#shared/rules/heights.ts";
import { hexInScene, hexSubcells } from "#shared/rules/hex.ts";
import { hexFacingName } from "./facings.ts";
import type { Insets, Point, Size } from "../../../lib/camera.ts";
import { cardPlace } from "../../movement/anchor.ts";
import { regionText } from "./regions.ts";

/**
 * The ground a viewer may read (docs/design-v1-heights-readout.md section
 * 1). Every viewer of a scene holds the same heights in its chunks, under
 * the fog or not, since they are map data. What differs is the screen: the
 * fog hides the ground, and the app never says what the fog hides, even
 * from data the client holds, as a door under the fog cannot be tapped or
 * named (features/doors/doors.ts doorSeen). So the height readout and a
 * ruler stop both read the ground through `seenGround`. The readout's words
 * and where its pill sits are here too. Pure, so all of it is tested
 * without a canvas.
 */

export type Cell = { x: number; y: number };

export type GroundSource = {
  chunks: Readonly<Record<string, BuildChunk>>;
  sceneId: string;
  bounds: { w: number; h: number };
  /** The scene's grid: on hexes a cell is a hex, named by its key (docs/design-v1-hex-grids.md H3). */
  grid?: Grid;
  /** The merged fog a player's view holds on a scene with fog on, or null where the viewer sees all the ground: the DM, or a scene without fog. */
  fog: RoomState["fogTiles"] | null;
};

/**
 * A cell's ground in feet as this viewer may read it, or null when it is
 * outside the scene or the viewer's fog fully covers it. A cell with any
 * part revealed counts as seen, as doors count it, and so does ground the
 * party explored, which the merged fog shows.
 */
export function seenGround(src: GroundSource, cell: Cell): number | null {
  const g = src.grid ?? SQUARES;
  if (isHex(g)) {
    // A hex is seen where any sub-cell inside it is, as a creature on it is (HX-D10).
    const hex = { col: cell.x, row: cell.y };
    if (!hexInScene(g, src.bounds, hex)) return null;
    const fog = src.fog;
    if (fog && hexSubcells(g, hex).every(([sx, sy]) => isSubcellFogged(fog, src.sceneId, sx, sy))) return null;
    return groundAt(src.chunks, src.sceneId, cell.x, cell.y);
  }
  // A height left outside a shrunk scene raises nothing (walls.ts reliefOfGrid), so it reads as no ground at all.
  if (cell.x < 0 || cell.y < 0 || cell.x >= src.bounds.w || cell.y >= src.bounds.h) return null;
  if (src.fog && isCellFullyFogged(src.fog, src.sceneId, cell)) return null;
  return groundAt(src.chunks, src.sceneId, cell.x, cell.y);
}

/** What `seenGround` reads from this viewer's own view: a player is held to the fog on a scene with fog on, as a door tap is (features/doors/tap.ts). */
export function groundSource(
  view: Pick<RoomState, "buildChunks" | "fogTiles">,
  scene: Pick<Scene, "id" | "bounds" | "fogEnabled" | "gridShape">,
  role: "dm" | "player",
): GroundSource {
  const fogged = role === "player" && scene.fogEnabled !== false;
  return { chunks: view.buildChunks, sceneId: scene.id, bounds: scene.bounds, grid: sceneGrid(scene), fog: fogged ? view.fogTiles : null };
}

/** How the readout names a cell: the pill's text, the status line's words, and the pill's outline. */
export type ReadoutWords = { pill: string; spoken: string; edge: "raised" | "lowered" };

const COMPASS_NAME: Readonly<Record<Compass, string>> = { n: "north", e: "east", s: "south", w: "west" };

/**
 * The readout for ground at `ground` feet with a stair or not
 * (docs/design-v1-heights-readout.md section 2, the table): "↑10 ft" and
 * "Ground 10 ft up.", "Stairs · ↑5 ft" and "Stairs, 5 ft up, up to the
 * east.", or null for plain ground at 0, so the common tap to deselect
 * stays quiet on an ordinary map. The pill's height is Height mode's own
 * text (regions.ts regionText), and the arrows are never spoken. `stair`
 * is the cell's stair as movement reads it: a direction, null for a stair
 * with none, undefined for no stair. Every stair takes the light outline,
 * a stair in a pit included, since it is the way up.
 */
export function readoutOf(ground: number, stair: Facing | null | undefined, grid: Grid = SQUARES): ReadoutWords | null {
  const height = ground === 0 ? null : regionText(ground);
  const heightWords = ground > 0 ? `${ground} ft up` : `${-ground} ft down`;
  if (stair === undefined) {
    if (height === null) return null;
    return { pill: height, spoken: `Ground ${heightWords}.`, edge: ground > 0 ? "raised" : "lowered" };
  }
  const parts = ["Stairs"];
  if (height !== null) parts.push(heightWords);
  if (stair !== null) parts.push(`up to the ${isHex(grid) ? hexFacingName(grid.orient, facingsOf(grid).indexOf(stair)) : COMPASS_NAME[stair as Compass]}`);
  return { pill: height === null ? "Stairs" : `Stairs · ${height}`, spoken: `${parts.join(", ")}.`, edge: "raised" };
}

/** What the readout reads at a cell, held to what this viewer may see, or null when it says nothing there. */
export function cellReadout(src: GroundSource, walls: { stairAt(x: number, y: number): Facing | null | undefined }, cell: Cell): ReadoutWords | null {
  const ground = seenGround(src, cell);
  if (ground === null) return null;
  return readoutOf(ground, walls.stairAt(cell.x, cell.y), src.grid);
}

/** The pill's pointer, in pixels: its height and width at the base, and the pill's corner radius, which the pointer keeps clear of. */
export const POINTER_PX = 6;
const POINTER_WIDTH_PX = 10;
export const PILL_RADIUS_PX = 6;
/** Room between the pointer's tip and the cell's center, so the tip marks the center rather than covering it. */
const TIP_GAP_PX = 2;

/**
 * Where the readout's pill sits on screen, over the tapped cell's center
 * (`anchor`): the door pill's `cardPlace` puts it above, below when the
 * top inset leaves no room, and slides and clamps it inside the part of
 * the canvas the Room page's bars leave clear. `height` is the pill's body
 * without its pointer. A pointer marks the cell when the body sits wholly
 * above or below the cell's center and the center's x lies along the
 * body's straight edge, past its rounded corners. Otherwise the pill shows
 * clamped, with no pointer. While the cell's center is under a bar, after a
 * pan or a pinch, the pill hides: a pill pointing at nothing reads as
 * belonging to whatever is next to it. Null then.
 *
 * `pointer.x` is from the box's left edge. The box is the body plus the
 * pointer's height, the pointer below the body when it points down.
 */
export function readoutPlace(input: { anchor: Point; viewport: Size; insets: Insets; width: number; height: number }): {
  left: number;
  top: number;
  pointer: { side: "down" | "up"; x: number } | null;
} | null {
  const { anchor, viewport, insets, width, height } = input;
  const inView = anchor.x >= insets.left && anchor.x <= viewport.width - insets.right && anchor.y >= insets.top && anchor.y <= viewport.height - insets.bottom;
  if (!inView) return null;
  const boxHeight = height + POINTER_PX;
  const { left, top } = cardPlace({ anchor, viewport, insets, width, height: boxHeight, gap: TIP_GAP_PX, prefer: "above" });
  const reach = PILL_RADIUS_PX + POINTER_WIDTH_PX / 2;
  const alongEdge = anchor.x >= left + reach && anchor.x <= left + width - reach;
  const side = top + boxHeight <= anchor.y ? "down" : top >= anchor.y ? "up" : null;
  return { left, top, pointer: alongEdge && side !== null ? { side, x: anchor.x - left } : null };
}

/**
 * The pill's outline as an SVG path, in the box's pixels: a rounded body
 * `width` by `height` with the pointer merged into its lower or upper edge,
 * so the outline has no seam where they meet.
 */
export function pillOutline(width: number, height: number, pointer: { side: "down" | "up"; x: number } | null): string {
  const r = PILL_RADIUS_PX;
  const half = POINTER_WIDTH_PX / 2;
  const y0 = pointer?.side === "up" ? POINTER_PX : 0;
  const y1 = y0 + height;
  const top = pointer?.side === "up" ? `H ${pointer.x - half} L ${pointer.x} 0 L ${pointer.x + half} ${y0} ` : "";
  const bottom = pointer?.side === "down" ? `H ${pointer.x + half} L ${pointer.x} ${y1 + POINTER_PX} L ${pointer.x - half} ${y1} ` : "";
  return (
    `M ${r} ${y0} ${top}H ${width - r} A ${r} ${r} 0 0 1 ${width} ${y0 + r} V ${y1 - r} A ${r} ${r} 0 0 1 ${width - r} ${y1} ` +
    `${bottom}H ${r} A ${r} ${r} 0 0 1 0 ${y1 - r} V ${y0 + r} A ${r} ${r} 0 0 1 ${r} ${y0} Z`
  );
}
