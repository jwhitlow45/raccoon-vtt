import type { Scene, SceneMap } from "#shared/model.ts";
import { MAX_NAME, MAX_SCENE_CELLS, type OpOf } from "#shared/protocol.ts";
import { fitBounds, MAX_CELL_PX, MIN_CELL_PX } from "../grid/calibrate.ts";
import { groundAtMiddle, type Live } from "../../lib/view.ts";

/**
 * Building the scene ops the Scenes panel sends (design sections 5, 6 and
 * 13.2). Pure, so the choices it makes for a new scene are tested.
 */

export type SceneInput = OpOf<"scene.create">["scene"];

/** What an upload answers with for a map: its canonical size and, from a name like `crypt_30x20.jpg`, a cellPx. */
export type MapAsset = { id: string; width: number; height: number; cellPx?: number };

export const DEFAULT_GRID: Scene["grid"] = { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 };
export const MAT_BACKGROUND = "#2b2b31";
/** Unbuilt space in a builder scene reads as solid rock. */
export const BUILDER_BACKGROUND = "#141418";
/** Behind a scene made from a map image. Stored on each such scene, so it is part of saved rooms. */
export const MAP_BACKGROUND = "#1b1b20";

export function clampCells(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_SCENE_CELLS, Math.max(1, Math.round(n))) : 1;
}

export function cleanName(name: string, fallback: string): string {
  const trimmed = name.trim().slice(0, MAX_NAME);
  return trimmed.length > 0 ? trimmed : fallback;
}

/** "crypt_30x20-final.webp" becomes "crypt 30x20 final", a starting name the DM can change. */
export function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return cleanName(base, "Map");
}

/**
 * Every scene made from wave 4 on stops players' moves at its walls and
 * ledges (`blockMovement`, docs/design-v1-maps-vision.md 4.1). Scenes from
 * before keep moving freely until the DM turns it on, so nothing changes
 * mid-campaign without the DM choosing it.
 */
export const BLOCKS_MOVES = { blockMovement: true } as const;

/** A blank battle mat: a background color and the app's grid, with fog off since there is nothing to hide. */
export function matScene(input: { id: string; name: string; w: number; h: number; background?: string }): SceneInput {
  return {
    id: input.id,
    name: cleanName(input.name, "Battle mat"),
    bounds: { w: clampCells(input.w), h: clampCells(input.h) },
    background: input.background ?? MAT_BACKGROUND,
    grid: DEFAULT_GRID,
    fogEnabled: false,
    ...BLOCKS_MOVES,
  };
}

/** A scene for the map builder. Fog starts on: a dungeon has rooms to reveal (design 13.2). */
export function builderScene(input: { id: string; name: string; w: number; h: number }): SceneInput {
  return {
    id: input.id,
    name: cleanName(input.name, "Dungeon"),
    bounds: { w: clampCells(input.w), h: clampCells(input.h) },
    background: BUILDER_BACKGROUND,
    grid: { ...DEFAULT_GRID, opacity: 0.15 },
    fogEnabled: true,
    ...BLOCKS_MOVES,
  };
}

/**
 * A first cellPx for a map with no hint in its name: about 30 squares
 * across the long side, a common battle map size, and never so small that
 * the scene would pass 200 cells. The DM aligns it next.
 */
export function guessCellPx(width: number, height: number): number {
  const long = Math.max(width, height);
  return Math.max(Math.ceil(long / MAX_SCENE_CELLS), Math.round(long / 30), MIN_CELL_PX);
}

function validHint(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_CELL_PX && v <= MAX_CELL_PX;
}

/** The map placement for a fresh upload: the hint or a guess, the grid's first line at the image's corner. */
export function initialMap(asset: MapAsset): { map: SceneMap; hinted: boolean } {
  const hinted = validHint(asset.cellPx);
  const cellPx = hinted ? asset.cellPx! : guessCellPx(asset.width, asset.height);
  return {
    map: { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, cellPx, originPx: { x: 0, y: 0 } },
    hinted,
  };
}

/**
 * A scene for an uploaded map, sized to the squares the map covers. Fog
 * starts on (the reducer's default for a map), and the app's grid shows
 * until the DM says the art has its own.
 *
 * Automatic walls go around floor only: on a map image the art is the
 * floor, so water, stairs or difficult ground painted over it are notes on
 * the art and must not wall themselves in (docs/design-v1-maps-vision.md
 * section 2.1). The reducer never infers the rule, so this op says it. A
 * blank mat or a builder scene says nothing and keeps the older rule.
 */
export function mapScene(input: { id: string; name: string; asset: MapAsset }): { scene: SceneInput; hinted: boolean } {
  const { map, hinted } = initialMap(input.asset);
  return {
    scene: {
      id: input.id,
      name: cleanName(input.name, "Map"),
      bounds: fitBounds(map),
      background: MAP_BACKGROUND,
      grid: DEFAULT_GRID,
      map,
      autoWalls: "floor",
      ...BLOCKS_MOVES,
    },
    hinted,
  };
}

/**
 * A new image for a scene that already has one. If it is the same art at
 * another size, the old alignment still fits once scaled by the width
 * ratio, so tokens and builds stay on their squares.
 */
export function replaceMap(old: SceneMap | undefined, asset: MapAsset): SceneMap {
  if (!old || !sameArt(old, asset)) return initialMap(asset).map;
  const k = asset.width / old.widthPx;
  return {
    assetId: asset.id,
    widthPx: asset.width,
    heightPx: asset.height,
    cellPx: Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, old.cellPx * k)),
    originPx: { x: old.originPx.x * k, y: old.originPx.y * k },
  };
}

/**
 * Whether a new image is taken for the old art at another size: the same
 * shape, to 1%. Anything else starts over from the upload, as a first
 * image does.
 */
export function sameArt(old: SceneMap, asset: MapAsset): boolean {
  return Math.abs(asset.height / old.heightPx - asset.width / old.widthPx) < 0.01;
}

/**
 * Whether a scene's first map image should turn its fog on. Design 13.2
 * starts map and build scenes fogged and a blank battle mat open. A mat
 * that gets its first map has become a map scene, so it takes the map
 * scene's default, as if it had been made from the image. A scene that
 * already had a map or a build keeps whatever fog the DM chose for it.
 */
export function fogsWithFirstMap(scene: { map?: unknown; fogEnabled: boolean }, hasBuild: boolean): boolean {
  return scene.map === undefined && !scene.fogEnabled && !hasBuild;
}

/** The schema's bounds for a default view (shared/protocol.ts). */
const VIEW_COORD = 1_000;
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 100;

/**
 * A scene's starting view from the camera on screen: the ground at the
 * middle of the canvas (lib/view.ts groundAtMiddle) and the zoom, the shape
 * Stage.tsx opens a scene at. The schema caps zoom at 100 pixels per cell,
 * so a closer camera saves at that zoom.
 */
export function viewFromCamera(live: Live): { x: number; y: number; zoom: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const round = (v: number) => Math.round(v * 100) / 100;
  const middle = groundAtMiddle(live);
  return {
    x: round(clamp(middle.x, -VIEW_COORD, VIEW_COORD)),
    y: round(clamp(middle.y, -VIEW_COORD, VIEW_COORD)),
    zoom: round(clamp(live.camera.scale, MIN_ZOOM, MAX_ZOOM)),
  };
}
