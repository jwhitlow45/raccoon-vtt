import type { BuildChunk, FogDraft, GridShape, RoomState, Scene, Token, Trap } from "../model.ts";
import { hexInScene, hexKey, parseHexKey, sceneHexSpan, type HexGrid } from "./hex.ts";

/**
 * A scene's grid (docs/design-v1-hex-grids.md section 7). Rule functions
 * take it as a required parameter, so the typecheck lists every caller.
 * Their square path is the code from before hex grids.
 */
export type Grid = { shape: "squares" } | HexGrid;

export const SQUARES: Grid = { shape: "squares" };
const HEX_ROWS: Grid = { shape: "hex", orient: "rows" };
const HEX_COLUMNS: Grid = { shape: "hex", orient: "columns" };

/** The grid of a stored shape. Absent reads as squares, the shape of every scene from before hex grids. */
export function gridOfShape(shape: GridShape | undefined): Grid {
  return shape === "hexRows" ? HEX_ROWS : shape === "hexColumns" ? HEX_COLUMNS : SQUARES;
}

/** A scene's grid. Not `gridOf`, which reducer/phases.ts already names. */
export function sceneGrid(scene: Pick<Scene, "gridShape">): Grid {
  return gridOfShape(scene.gridShape);
}

/** The stored shape of a grid: absent for squares, so a square scene's stored form never changes. */
export function shapeOfGrid(g: Grid): GridShape | undefined {
  return g.shape === "squares" ? undefined : g.orient === "rows" ? "hexRows" : "hexColumns";
}

export function isHex(g: Grid): g is HexGrid {
  return g.shape === "hex";
}

/** What a scene calls its cell in words shown, the server's included (section 8): "square" or "hex". */
export function cellWord(g: Grid, many = false): string {
  if (g.shape === "squares") return many ? "squares" : "square";
  return many ? "hexes" : "hex";
}

/**
 * Whether a cell key names a cell of the scene (section 4.3): on squares a
 * cell inside the bounds, as every builder check reads it today, and on
 * hexes a hex wholly inside the scene's rectangle, by its one key, so
 * "01,1" or "-0,1" never stands for hex 1,1 or 0,1 beside it.
 */
export function inScene(g: Grid, bounds: { w: number; h: number }, key: string): boolean {
  if (g.shape === "squares") {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    return x >= 0 && y >= 0 && x < bounds.w && y < bounds.h;
  }
  const hex = parseHexKey(key);
  return hex !== null && hexKey(hex) === key && hexInScene(g, bounds, hex);
}

/**
 * The highest index a cell key takes on either axis, on any grid, on a
 * scene of at most `side` cells a side (section 4.3): 229 for the largest
 * scene of 200, the last row of hex rows and the last column of hex
 * columns, where squares stop at 199. A function of the side rather than a
 * constant, so shared/protocol.ts can pass its MAX_SCENE_CELLS without this
 * file importing it back.
 */
export function cellIndexMost(side: number): number {
  const bounds = { w: side, h: side };
  const spans = (["rows", "columns"] as const).flatMap((orient) => Object.values(sceneHexSpan({ shape: "hex", orient }, bounds)));
  return Math.max(side, ...spans) - 1;
}

/**
 * Whether a scene came with its own grid, exact, from a Universal VTT file
 * (HX-D13): the import's mark, or for an import from before the mark a
 * first grid line before the image. Its walls stand in that file's
 * squares, so it never changes shape. The same test as Find the grid's
 * (client/features/grid/findGrid.ts).
 */
export function cameWithGrid(scene: Pick<Scene, "gridFromFile" | "map">): boolean {
  return scene.gridFromFile === true || (scene.map !== undefined && (scene.map.originPx.x < 0 || scene.map.originPx.y < 0));
}

/*
 * The shape's invariant (HX-D14). Cell data belongs to the exact shape it
 * was written under, Hex rows and Hex columns being different shapes, since
 * one key names different places on each. A scene holds only cell data of
 * its own shape, and on hexes only what its phase supports.
 */

/** What can keep a scene from a shape, in the order the words name them. */
export type ShapeHolding = "ground" | "walls" | "heights" | "stairs" | "rough" | "trap" | "roomFog" | "squeeze" | "link";
export type ShapeHeld = { what: ShapeHolding; count: number };

const HOLDING_ORDER: readonly ShapeHolding[] = ["ground", "walls", "heights", "stairs", "rough", "trap", "roomFog", "squeeze", "link"];

/** The stored shape a stamp names: absent is squares, every stamp from before hex grids. */
function stampShape(grid: GridShape | undefined): GridShape | "squares" {
  return grid ?? "squares";
}

function shapeName(g: Grid): GridShape | "squares" {
  return shapeOfGrid(g) ?? "squares";
}

/** The grid-keyed parts of a chunk that hold anything (HX-D14): its cells, edges, heights, stairs and difficult ground. */
function chunkKeyed(chunk: BuildChunk): ShapeHolding[] {
  const out: ShapeHolding[] = [];
  if (Object.keys(chunk.cells).length > 0) out.push("ground");
  if (Object.keys(chunk.edges).length > 0) out.push("walls");
  if (chunk.heights !== undefined) out.push("heights");
  if (chunk.up !== undefined) out.push("stairs");
  if (chunk.rough !== undefined) out.push("rough");
  return out;
}

/** Whether a fog draft holds a shape of cell keys, as Reveal room makes. Its other shapes are in world units and fit every grid. */
function draftKeyed(draft: FogDraft): boolean {
  return draft.ops.some((op) => op.shape.kind === "cells");
}

/**
 * The chunks' grid-keyed content a hex scene may hold (section 6), by hex
 * under hex keys: difficult ground from H2, and heights and stairs from
 * H3. Painted ground and grid-line walls stay square in every phase.
 */
const HEX_KEYED: ReadonlySet<ShapeHolding> = new Set<ShapeHolding>(["rough", "heights", "stairs"]);

function tally(found: ShapeHolding[]): ShapeHeld[] {
  return HOLDING_ORDER.filter((what) => found.includes(what)).map((what) => ({ what, count: found.filter((f) => f === what).length }));
}

type Holds = Pick<RoomState, "buildChunks" | "fogDrafts" | "tokens" | "traps">;

function sceneTokens(state: Holds, sceneId: string): Token[] {
  return Object.values(state.tokens).filter((t) => t.sceneId === sceneId);
}

/**
 * What a scene holds that a switch to `to` cannot keep (HX-D14): any cell
 * data at all, since all of it is of the scene's shape now (painted ground,
 * walls and "no wall" marks on the grid lines, heights, stairs, difficult
 * ground, traps, Reveal room's fog shapes and squeezed tokens). Free walls
 * are in world units and stand on every shape from H2, and so do attach
 * links, whose tokens every rule reads at their nearest anchors. Nothing
 * when the shape stays.
 */
export function switchHolds(state: Holds, scene: Pick<Scene, "id" | "gridShape">, to: Grid): ShapeHeld[] {
  if (shapeName(sceneGrid(scene)) === shapeName(to)) return [];
  const found: ShapeHolding[] = [];
  for (const chunk of Object.values(state.buildChunks)) {
    if (chunk.sceneId !== scene.id) continue;
    found.push(...chunkKeyed(chunk));
  }
  for (const trap of Object.values(state.traps ?? {})) if (trap.sceneId === scene.id) found.push("trap");
  const draft = state.fogDrafts[scene.id];
  if (draft && draftKeyed(draft)) found.push("roomFog");
  for (const token of sceneTokens(state, scene.id)) {
    if (token.squeeze === true) found.push("squeeze");
  }
  return dedupe(tally(found));
}

/** Kinds that read as one in the words count once: a chunk's walls and its free walls are both "walls and doors". */
function dedupe(held: ShapeHeld[]): ShapeHeld[] {
  return held.map((h) => (h.what === "trap" || h.what === "squeeze" || h.what === "link" ? h : { what: h.what, count: 1 }));
}

/**
 * What a value a restore writes brings that its scene's shape cannot take
 * (HX-D14), by the two checks the design keeps apart:
 *
 * - The stamp check, only on a value that holds grid-keyed content (a
 *   chunk's cells, edges, heights, stairs or difficult ground, a fog
 *   draft's Reveal room shapes, any trap): its stamp must be the scene's
 *   shape. A value with none, such as a draft of rects or a chunk of free
 *   walls only, means the same on every grid and is never compared.
 * - The phase check, on everything written onto a hex scene, whatever its
 *   stamp (D-261026-8). In H3 a hex scene holds difficult ground, heights,
 *   stairs and Reveal room's cells of its own shape and no other
 *   grid-keyed content: painted ground and grid-line walls never (they
 *   stay square in every phase). Free walls, squeezed creatures, attach
 *   links and traps stand on hexes from H2, and pits from H3. A hand-made
 *   backup could stamp the rest with the scene's own shape, and no phase
 *   has hex rules to read them by.
 *
 * `from` is the shape the value's data stands on, for the words: its stamp.
 */
export function restoredHolds(
  state: Holds,
  kind: "chunk" | "fogDraft" | "trap" | "token",
  value: BuildChunk | FogDraft | Trap | Token,
  scene: Pick<Scene, "gridShape">,
): { held: ShapeHeld[]; from: GridShape | "squares" } | null {
  const g = sceneGrid(scene);
  const shape = shapeName(g);
  const stamp = (keyed: ShapeHolding[], grid: GridShape | undefined) =>
    keyed.length > 0 && stampShape(grid) !== shape ? { held: dedupe(tally(keyed)), from: stampShape(grid) } : null;
  if (kind === "chunk") {
    const chunk = value as BuildChunk;
    const keyed = chunkKeyed(chunk);
    const stamped = stamp(keyed, chunk.grid);
    if (stamped) return stamped;
    if (!isHex(g)) return null;
    const held = keyed.filter((what) => !HEX_KEYED.has(what));
    return held.length > 0 ? { held: dedupe(tally(held)), from: stampShape(chunk.grid) } : null;
  }
  if (kind === "fogDraft") {
    const draft = value as FogDraft;
    // From H3 Reveal room's hex keys stand on the hex shape they were stamped with, so the stamp check is the whole test.
    return stamp(draftKeyed(draft) ? ["roomFog"] : [], draft.grid);
  }
  if (kind === "trap") {
    const trap = value as Trap;
    // A hex scene holds traps of its own shape from H2, and from H3 their pits, which open by writing heights of its hexes.
    return stamp(["trap"], trap.grid);
  }
  // A token's squeeze and its links stand on hexes from H2, read by the hex rules of squeezing and attaching.
  return null;
}

/**
 * What a scene holds that its own shape cannot (HX-D14): grid-keyed
 * content stamped with another shape, and on hexes what the phase leaves
 * out. Empty for every scene the reducer leaves. A restore that changes a
 * scene's shape asks it of the scene as the restore leaves it, and the
 * room import of every scene, so neither two DMs, a long history nor a
 * hand-made backup puts cell data on a shape it was not written for.
 */
export function sceneHolds(state: Holds, scene: Pick<Scene, "id" | "gridShape">): { held: ShapeHeld[]; from: GridShape | "squares" } | null {
  for (const chunk of Object.values(state.buildChunks)) {
    if (chunk.sceneId !== scene.id) continue;
    const found = restoredHolds(state, "chunk", chunk, scene);
    if (found) return found;
  }
  const draft = state.fogDrafts[scene.id];
  if (draft) {
    const found = restoredHolds(state, "fogDraft", draft, scene);
    if (found) return found;
  }
  for (const trap of Object.values(state.traps ?? {})) {
    if (trap.sceneId !== scene.id) continue;
    const found = restoredHolds(state, "trap", trap, scene);
    if (found) return found;
  }
  for (const token of sceneTokens(state, scene.id)) {
    const found = restoredHolds(state, "token", token, scene);
    if (found) return found;
  }
  return null;
}

function holdingWords(h: ShapeHeld): string {
  switch (h.what) {
    case "ground":
      return "painted ground";
    case "walls":
      return "walls and doors";
    case "heights":
      return "heights";
    case "stairs":
      return "stairs";
    case "rough":
      return "difficult ground";
    case "trap":
      return h.count === 1 ? "a trap" : `${h.count} traps`;
    case "roomFog":
      return "Reveal room in its fog draft";
    case "squeeze":
      return h.count === 1 ? "a squeezing creature" : `${h.count} squeezing creatures`;
    case "link":
      return h.count === 1 ? "an attached creature" : `${h.count} attached creatures`;
  }
}

/** "a, b and c": the list the refusals name. */
export function heldList(held: readonly ShapeHeld[]): string {
  const words = held.map(holdingWords);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A shape in words, as a refusal names where data stands: "squares", "hexes", or the orientation when both sides are hexes. */
function shapeWords(shape: GridShape | "squares", other: GridShape | "squares"): string {
  if (shape === "squares") return "squares";
  if (other === "squares") return "hexes";
  return shape === "hexRows" ? "hex rows" : "hex columns";
}

/** The refusal of a scene from Universal VTT asked to leave squares (section 8). */
export const OWN_SQUARE_GRID = "This scene came with its own square grid from its file.";

/**
 * The refusal of a map whose first grid line lies before the image on a
 * hex scene (D-261026-8): Line up grid reduces the origin into the image
 * (section 4.1), so a negative one stays the mark of a file's own grid.
 */
export const HEX_ORIGIN = "On hexes the map's grid starts at or after the image's top-left corner.";

/** Whether a scene is on hexes with a map whose origin lies before the image, which no hex scene may have. */
export function hexOriginBefore(scene: Pick<Scene, "gridShape" | "map">): boolean {
  return isHex(sceneGrid(scene)) && scene.map !== undefined && (scene.map.originPx.x < 0 || scene.map.originPx.y < 0);
}

/**
 * Why a scene cannot switch to `to`, in the words the Grid settings show
 * (section 7): "This scene has difficult ground and 2 traps on its
 * squares, which can't stand on hexes. Remove them to change the grid."
 * Null when it can.
 */
export function switchRefusal(state: Holds, scene: Pick<Scene, "id" | "gridShape" | "gridFromFile" | "map">, to: Grid): string | null {
  const from = shapeName(sceneGrid(scene));
  const target = shapeName(to);
  if (from === target) return null;
  if (from === "squares" && cameWithGrid(scene)) return OWN_SQUARE_GRID;
  const held = switchHolds(state, scene, to);
  if (held.length === 0) return null;
  return `This scene has ${heldList(held)} on its ${shapeWords(from, target)}, which can't stand on ${shapeWords(target, from)}. Remove them to change the grid.`;
}

/**
 * A restore's refusal in the switch's words (section 7): "Can't undo that:
 * difficult ground on squares can't stand on this scene's hexes."
 */
export function restoreRefusal(from: "undo" | "redo", found: { held: ShapeHeld[]; from: GridShape | "squares" }, scene: Pick<Scene, "gridShape">): string {
  return `Can't ${from} that: ${standsWords(found, scene)}.`;
}

/**
 * "difficult ground on squares can't stand on this scene's hexes": what
 * holds where, as the restore and the import say it. Data stamped with the
 * scene's own shape that the phase leaves out says only that it can't stand
 * on the scene's hexes.
 */
export function standsWords(found: { held: ShapeHeld[]; from: GridShape | "squares" }, scene: Pick<Scene, "gridShape">): string {
  const g = sceneGrid(scene);
  const shape = shapeName(g);
  if (found.from === shape) return `${heldList(found.held)} can't stand on this scene's ${cellWord(g, true)}`;
  return `${heldList(found.held)} on ${shapeWords(found.from, shape)} can't stand on this scene's ${shapeWords(shape, found.from)}`;
}
