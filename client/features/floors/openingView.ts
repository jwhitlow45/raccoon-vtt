import type { BuildChunk, CellRect, RoomState, Scene, SceneId, Token } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { rectKeys, rectsOverlap } from "#shared/rules/floorLinks.ts";
import { footprintRect, occupiedHexes } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { rectHexes } from "#shared/rules/traps.ts";
import { createStore } from "zustand/vanilla";
import { hexOutline, mapWorldRect } from "../../lib/scene.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { AssetSource } from "../../state/view.ts";
import { isAssetImage } from "#shared/imageRef.ts";
import type { HoleSpec } from "./holes.ts";

/*
 * What an opening shows of the floor below it (docs/design/design-v1-floors.md
 * phase 4, 7.4): the window in each upper end on the floor shown, and the
 * height chip beside it. Every read of the far floor goes through here or
 * holes.ts, on the device's whole copy, which holds each floor the device
 * holds: the board's own readers take the floor shown's cut
 * (canvas/floorViewReads.test.ts), and this file lies outside the folders
 * that test guards.
 *
 * A player's copy holds a floor only once players reach it or the DM shows
 * it, and an end only outside full fog, so a window draws nothing of a
 * floor not held and a chip names no height a player was not sent.
 */

// The holes and their drops live apart from the window's stores, so lib/view.ts reads them without React and the stores.
export { farEnd, holeDrop, holeDrops, holesOn, type HoleSpec } from "./holes.ts";

/** The far floor's build, as the copy holds it: a player's only what they have seen there. */
export function farChunks(view: Pick<RoomState, "buildChunks">, farId: SceneId): BuildChunk[] {
  return Object.values(view.buildChunks).filter((c): c is BuildChunk => c !== undefined && c.sceneId === farId);
}

/**
 * The creatures and objects on the far floor whose space meets the hole's
 * squares, as the copy holds them, bottom first by elevation then id, so
 * the window draws them in a fixed order. A player's copy holds only those
 * the server sends them.
 */
export function farTokensIn(view: Pick<RoomState, "scenes" | "tokens">, farId: SceneId, rect: CellRect): Token[] {
  const scene = ownEntry(view.scenes, farId);
  if (scene === undefined) return [];
  const g = sceneGrid(scene);
  const held = new Set(rectKeys(rect));
  const meets = (t: Token) => (isHex(g) ? occupiedHexes(g, t).some((h) => held.has(hexKey(h))) : rectsOverlap(footprintRect(g, t), rect));
  return Object.values(view.tokens)
    .filter((t): t is Token => t !== undefined && t.sceneId === farId && meets(t))
    .sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A hole's squares where the board draws them, in cells: the box round
 * them, and on hexes the outline of their hexes, which the window and the
 * drop are clipped to.
 */
export type HoleOutline = { x: number; y: number; w: number; h: number; loop: number[] | null };

export function holeOutline(g: Grid, rect: CellRect): HoleOutline {
  if (!isHex(g)) return { ...rect, loop: null };
  const loop = hexOutline(g, rectHexes([rect]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < loop.length; i += 2) {
    x0 = Math.min(x0, loop[i]!);
    x1 = Math.max(x1, loop[i]!);
    y0 = Math.min(y0, loop[i + 1]!);
    y1 = Math.max(y1, loop[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, loop };
}

/**
 * What a far floor's crops are drawn from (OpeningCrops.tsx drawCrop) but its
 * build, which comes by its own dependency: the crops are drawn again
 * whenever it changes. The map counts by its addresses and by the rectangle
 * it is drawn in (lib/scene.ts mapWorldRect), so a map calibrated anew,
 * with the same image and bounds, moves in every window over it.
 */
export function cropKey(far: Pick<Scene, "id" | "background" | "bounds" | "grid" | "gridShape" | "autoWalls" | "map">, urls: readonly string[], outlines: readonly { id: string; o: HoleOutline }[]): string {
  const mapRect = far.map ? mapWorldRect(far.map) : null;
  return JSON.stringify([far.id, urls, mapRect, far.background, far.bounds, far.grid, far.gridShape, far.autoWalls, outlines.map((x) => [x.id, x.o.x, x.o.y, x.o.w, x.o.h])]);
}

/** A box in cells. */
type Box = { x: number; y: number; w: number; h: number };

/**
 * The parts of a hole's box that lie past the far floor's edge, as at most
 * four boxes that do not meet the floor: the floor's fog fills them, as the
 * board's own fog frames a floor.
 */
export function pastFloorEdge(o: Box, bounds: { w: number; h: number }): Box[] {
  const x0 = Math.max(0, o.x);
  const y0 = Math.max(0, o.y);
  const x1 = Math.min(bounds.w, o.x + o.w);
  const y1 = Math.min(bounds.h, o.y + o.h);
  if (x1 <= x0 || y1 <= y0) return [{ x: o.x, y: o.y, w: o.w, h: o.h }];
  const out: Box[] = [];
  if (y0 > o.y) out.push({ x: o.x, y: o.y, w: o.w, h: y0 - o.y });
  if (o.y + o.h > y1) out.push({ x: o.x, y: y1, w: o.w, h: o.y + o.h - y1 });
  if (x0 > o.x) out.push({ x: o.x, y: y0, w: x0 - o.x, h: y1 - y0 });
  if (o.x + o.w > x1) out.push({ x: x1, y: y0, w: o.x + o.w - x1, h: y1 - y0 });
  return out;
}

/** What paintFloorRaster draws with: a 2D context's own calls. */
export type RasterPainter = Pick<CanvasRenderingContext2D, "save" | "restore" | "fillRect" | "drawImage"> & { imageSmoothingEnabled: boolean; fillStyle: CanvasRenderingContext2D["fillStyle"] };

/**
 * A whole far floor's raster, one pixel a sub-cell, drawn into a hole's box
 * over what the window already drew there: its map crop, its creatures and
 * its sight. The raster composites over them and never clears, so revealed
 * fog leaves them showing. Fog (`edge`, its color) also fills the box past
 * the floor's edge, and only there.
 */
export function paintFloorRaster(g: RasterPainter, raster: CanvasImageSource & { width: number; height: number }, bounds: { w: number; h: number }, o: Box, smooth: boolean, edge: string | null): void {
  const kx = raster.width / bounds.w;
  const ky = raster.height / bounds.h;
  g.save();
  g.imageSmoothingEnabled = smooth;
  if (edge !== null) {
    g.fillStyle = edge;
    for (const r of pastFloorEdge(o, bounds)) g.fillRect(r.x, r.y, r.w, r.h);
  }
  const x0 = Math.max(0, o.x);
  const y0 = Math.max(0, o.y);
  const x1 = Math.min(bounds.w, o.x + o.w);
  const y1 = Math.min(bounds.h, o.y + o.h);
  if (x1 > x0 && y1 > y0) g.drawImage(raster, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
  g.restore();
}

/** The most pixels a window's crop takes a side (7.4, 13): at most 512 by 512, so 16 windows hold at most 16 MiB. */
export const WINDOW_MAX_PX = 512;

/** Pixels a cell in a window's crop: 64, fewer where the hole is long enough to pass WINDOW_MAX_PX. */
export function windowPxPerCell(rect: Pick<CellRect, "w" | "h">): number {
  return Math.max(1, Math.min(64, Math.floor(WINDOW_MAX_PX / Math.max(rect.w, rect.h, 1))));
}

/**
 * The far floors whose images the windows are decoding, by name, once each
 * a floor being drawn: the scene's loading notice says "Loading Ground
 * floor…" while any is (canvas/SceneLoading.tsx), so a window never sits
 * black with nothing said. One per Room page.
 */
export const windowLoadSlot = scopeSlot(() => createStore<{ loading: readonly string[] }>(() => ({ loading: [] })));

/**
 * What the windows draw that OpeningCrops makes once for both drawing
 * trees: each hole's crop of the floor below by the hole's id, and the
 * pictures of the creatures under the holes by address. One per Room page.
 */
export const windowSlot = scopeSlot(() => createStore<{ crops: ReadonlyMap<string, HTMLCanvasElement>; images: ReadonlyMap<string, HTMLImageElement> }>(() => ({ crops: new Map(), images: new Map() })));

/** The holes over floors the device holds, by far floor. */
export function byFarFloor(holes: readonly HoleSpec[]): { far: Scene; holes: HoleSpec[] }[] {
  const out = new Map<string, { far: Scene; holes: HoleSpec[] }>();
  for (const hole of holes) {
    if (hole.far === null) continue;
    const entry = out.get(hole.far.id) ?? { far: hole.far, holes: [] };
    entry.holes.push(hole);
    out.set(hole.far.id, entry);
  }
  return [...out.values()];
}

/** A creature's picture's address, where it has an uploaded one. */
export function tokenUrl(assets: AssetSource, token: Token): string | null {
  const upload = token.image && isAssetImage(token.image) ? token.image : undefined;
  return upload ? assets.url(upload.assetId, "full") : null;
}
