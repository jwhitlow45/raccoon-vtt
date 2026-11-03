import type { GridShape, LightLevel, MapVideo, RoomState, Scene, SceneMap, ScenePreset } from "#shared/model.ts";
import { PLAYERS_SEE_WORDS } from "#shared/playersSee.ts";
import { MAX_NAME, MAX_SCENE_CELLS, type OpOf } from "#shared/protocol.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { fitBounds, MAX_CELL_PX, MIN_CELL_PX, type KeptGrid } from "../grid/calibrate.ts";
import { groundAtMiddle, type Live } from "../../lib/view.ts";
import { lightOf } from "../vision/settings.ts";

/**
 * Building the scene ops the Scenes panel sends (design sections 5, 6 and
 * 13.2). Pure, so the choices it makes for a new scene are tested.
 */

export type SceneInput = OpOf<"scene.create">["scene"];

/**
 * What an upload answers with for a map: its canonical size and, from a name
 * like `crypt_30x20.jpg`, a cellPx for squares and a `hexCellPx` for each hex
 * orientation the counts fit. An animated map's still carries its video
 * (docs/design/design-v1-animated-maps.md 4.1), which the map it makes keeps.
 */
export type MapAsset = { id: string; width: number; height: number; cellPx?: number; hexCellPx?: { rows?: number; columns?: number }; video?: MapVideo };

/** The video a map made from this asset carries: its own, so an image in place of an animated map drops the old one (4.2). */
function videoOf(asset: MapAsset): { video?: MapVideo } {
  return asset.video ? { video: asset.video } : {};
}

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
 * ledges (`blockMovement`, docs/design/design-v1-maps-vision.md 4.1). Scenes from
 * before keep moving freely until the DM turns it on, so nothing changes
 * mid-campaign without the DM choosing it.
 */
export const BLOCKS_MOVES = { blockMovement: true } as const;

/** A scene's shape as `scene.create` takes it: squares send none, so a square scene's op is as it was before hex grids. */
function shaped(gridShape: GridShape | undefined): { gridShape?: GridShape } {
  return gridShape ? { gridShape } : {};
}

/**
 * The grid a new scene of a kind starts on (docs/design/design-v1-hex-grids.md
 * HX-D19): a Battle mat or a Map image on the room's New scenes setting,
 * a Builder scene, a starter map and a Universal VTT import on squares,
 * since the builder's core tools, the starter art and the file's walls are
 * square. Only the form reads the setting, so replay never does.
 */
export function newSceneShape(setting: GridShape | undefined, kind: NewSceneKind | "starter"): GridShape | undefined {
  return kind === "mat" || kind === "map" ? setting : undefined;
}

/** A blank battle mat: a background color and the app's grid, with fog off since there is nothing to hide. */
export function matScene(input: { id: string; name: string; w: number; h: number; background?: string; gridShape?: GridShape }): SceneInput {
  return {
    id: input.id,
    ...shaped(input.gridShape),
    name: cleanName(input.name, "Battle mat"),
    bounds: { w: clampCells(input.w), h: clampCells(input.h) },
    background: input.background ?? MAT_BACKGROUND,
    grid: DEFAULT_GRID,
    fogEnabled: false,
    ...BLOCKS_MOVES,
  };
}

/** A scene for the map builder. Fog starts on: a dungeon has rooms to reveal (design 13.2). */
export function builderScene(input: { id: string; name: string; w: number; h: number; gridShape?: GridShape }): SceneInput {
  return {
    id: input.id,
    ...shaped(input.gridShape),
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

/** The scale a file name gives a scene of this grid: the counts read as its own lattice, or none. */
export function nameCellPx(asset: Pick<MapAsset, "cellPx" | "hexCellPx">, gridShape?: GridShape): number | undefined {
  const px = gridShape === undefined ? asset.cellPx : gridShape === "hexRows" ? asset.hexCellPx?.rows : asset.hexCellPx?.columns;
  return validHint(px) ? px : undefined;
}

/** The map placement for a fresh upload: the file name's scale for the scene's grid, otherwise a guess. */
export function initialMap(asset: MapAsset, gridShape?: GridShape): { map: SceneMap; hinted: boolean } {
  const named = nameCellPx(asset, gridShape);
  const hinted = named !== undefined;
  const cellPx = named ?? guessCellPx(asset.width, asset.height);
  return {
    map: { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, cellPx, originPx: { x: 0, y: 0 }, ...videoOf(asset) },
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
 * the art and must not wall themselves in (docs/design/design-v1-maps-vision.md
 * section 2.1). The reducer never infers the rule, so this op says it. A
 * blank mat or a builder scene says nothing and keeps the older rule.
 */
export function mapScene(input: { id: string; name: string; asset: MapAsset; gridShape?: GridShape }): { scene: SceneInput; hinted: boolean } {
  const { map, hinted } = initialMap(input.asset, input.gridShape);
  return {
    scene: {
      id: input.id,
      ...shaped(input.gridShape),
      name: cleanName(input.name, "Map"),
      bounds: fitBounds(map, gridOfShape(input.gridShape)),
      background: MAP_BACKGROUND,
      grid: DEFAULT_GRID,
      map,
      autoWalls: "floor",
      ...BLOCKS_MOVES,
    },
    hinted,
  };
}

/** What the new scene form and the Universal VTT dialog make. A starter map is a map image. */
export type NewSceneKind = "mat" | "map" | "builder" | "uvtt";

/**
 * What players see on a new scene until the DM picks otherwise
 * (docs/design/design-v1-map-discovery.md 8.2): the room's default, except that a
 * map image or starter map steps down from Explore to Reveal by hand, since
 * sight with no walls reaches all its art. A room that never set one keeps
 * each kind's older start: maps and the builder under fog, mats without.
 */
export function newScenePreset(setting: ScenePreset | undefined, kind: NewSceneKind): ScenePreset {
  if (setting === undefined) return kind === "mat" ? "all" : "reveal";
  return setting === "explore" && kind === "map" ? "reveal" : setting;
}

/** Whether the room's default stepped down for this kind, which the form then says. */
export function stepsDown(setting: ScenePreset | undefined, kind: NewSceneKind): boolean {
  return setting === "explore" && newScenePreset(setting, kind) !== "explore";
}

/** The scene "Like <scene>" copies from, as much of it as the copy reads. */
export type LikeSource = Pick<Scene, "fogEnabled" | "vision" | "blockMovement">;

/** The DM's pick in the form: a preset, or Like the scene on the DM's screen. */
export type NewScenePick = { preset: ScenePreset } | { like: LikeSource };

/**
 * What a scene is made with for the form's choice: Like copies the scene
 * it names, and the kind's start once that scene is gone.
 */
export function newScenePick(value: ScenePreset | "like", like: LikeSource | undefined, setting: ScenePreset | undefined, kind: NewSceneKind): NewScenePick {
  if (value !== "like") return { preset: value };
  return like ? { like } : { preset: newScenePreset(setting, kind) };
}

/**
 * The form's choice as the DM made it, held through an upload or a copy:
 * the preset shown, or Like with the scene it named then. The scene itself
 * is read only as the new one is made (`pickNow`).
 */
export type NewSceneIntent = { value: ScenePreset | "like"; like?: { id: string; name: string } };

export function newSceneIntent(value: ScenePreset | "like", like: Pick<Scene, "id" | "name"> | undefined): NewSceneIntent {
  return value === "like" && like ? { value, like: { id: like.id, name: like.name } } : { value };
}

/**
 * The pick a scene is made with, from the room as it is when it is made,
 * so a change to the Like scene while an upload ran comes with it. A Like
 * scene deleted meanwhile leaves the kind's start, and `gone` says so.
 */
export function pickNow(intent: NewSceneIntent, room: Pick<RoomState, "scenes" | "meta"> | null | undefined, kind: NewSceneKind): { pick: NewScenePick; gone: string | null } {
  const setting = room?.meta.settings.newScenePlayers;
  const source = intent.like ? room?.scenes[intent.like.id] : undefined;
  const pick = newScenePick(intent.value, source, setting, kind);
  const gone = intent.value === "like" && intent.like && "preset" in pick ? likeGoneText(intent.like.name, pick.preset) : null;
  return { pick, gone };
}

export function likeGoneText(name: string, preset: ScenePreset): string {
  return `${name} was deleted before the new scene was made, so the new scene starts on ${PLAYERS_SEE_WORDS[preset]}.`;
}

type PlayersSeeFields = Pick<SceneInput, "fogEnabled" | "vision" | "blockMovement">;

/**
 * The fields a new scene takes from Players see (8.1, 8.2). A preset sets
 * fog and party vision. Like copies fog, party vision with its light and
 * Sight, and whether walls stop players' moves, and leaves automatic walls
 * to the kind of scene (D-261026-29), so a map image keeps "floor" and an
 * import "off". `light` is the Universal VTT dialog's own pick, which
 * stands over the copy's. The holder list is never copied: a scene starts
 * with none, so a per-player copy starts empty.
 */
export function playersSeeFields(pick: NewScenePick, light?: LightLevel): PlayersSeeFields {
  if ("like" in pick) {
    const source = pick.like;
    const fields: PlayersSeeFields = { fogEnabled: source.fogEnabled, blockMovement: source.blockMovement === true };
    if (source.vision || light) fields.vision = { on: source.vision?.on === true, light: light ?? lightOf(source), ...(source.vision?.perPlayer ? { perPlayer: true as const } : {}) };
    return fields;
  }
  const { preset } = pick;
  if (preset === "explore") return { fogEnabled: true, vision: { on: true, light: light ?? "bright" } };
  // Without a light to keep, Reveal by hand and Everything send no vision, as a new scene always did.
  return { fogEnabled: preset === "reveal", ...(light ? { vision: { on: false, light } } : {}) };
}

/** A new scene with Players see applied over what its kind starts with. */
export function withPlayersSee(scene: SceneInput, pick: NewScenePick, light?: LightLevel): SceneInput {
  const { vision: _kind, ...rest } = scene;
  return { ...rest, ...playersSeeFields(pick, light) };
}

/**
 * A new image for a scene that already has one. If it has the old image's
 * shape, the old alignment still fits once scaled by the width ratio, so
 * tokens and builds stay on their squares.
 */
export function replaceMap(old: SceneMap | undefined, asset: MapAsset, gridShape?: GridShape): SceneMap {
  if (!old || !sameImageShape(old, asset)) return initialMap(asset, gridShape).map;
  const k = asset.width / old.widthPx;
  return {
    assetId: asset.id,
    widthPx: asset.width,
    heightPx: asset.height,
    cellPx: Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, old.cellPx * k)),
    originPx: { x: old.originPx.x * k, y: old.originPx.y * k },
    ...videoOf(asset),
  };
}

/**
 * Whether a new image has the old one's shape, to 1%, so the old grid
 * still fits it once scaled. It may be the old art at another size, or
 * other art: exporters write many maps at one size. Anything else starts
 * over from the upload, as a first image does.
 */
export function sameImageShape(old: SceneMap, asset: MapAsset): boolean {
  return Math.abs(asset.height / old.heightPx - asset.width / old.widthPx) < 0.01;
}

/**
 * What a scene's new image does with the grid once its upload answers
 * (D-261029-50). The same file is the same art, since a room stores a
 * file once, so it keeps the grid and nothing is searched. An image of the
 * old one's shape keeps the grid, scaled, and is searched all the same,
 * but a find that differs from that grid is only offered (`kept`): the DM
 * may have lined it up by hand. Other art starts over, as a first image
 * does. A size in the file name wins on every grid (D-261101-190), so
 * such a file is not searched, and other art takes the name's scale
 * unless the kept grid already has it: a kept grid that disagrees would
 * stand unsearched with nothing left to correct it.
 */
export function replacement(old: SceneMap | undefined, asset: MapAsset, gridShape?: GridShape): { map: SceneMap; search: boolean; kept: KeptGrid | null } {
  const sameFile = old?.assetId === asset.id;
  const named = sameFile ? undefined : nameCellPx(asset, gridShape);
  const scaled = replaceMap(old, asset, gridShape);
  if (named !== undefined) {
    const agrees = Math.abs(scaled.cellPx - named) <= NAME_AGREES * named;
    return { map: agrees ? scaled : initialMap(asset, gridShape).map, search: false, kept: null };
  }
  const kept = old && !sameFile && sameImageShape(old, asset) ? { cellPx: scaled.cellPx, originPx: scaled.originPx, scale: asset.width / old.widthPx } : null;
  return { map: scaled, search: !sameFile, kept };
}

/**
 * Whether a new image that takes its file name's scale refits the scene's
 * bounds to itself. A first image always does. Over an old map it does only
 * when the bounds are still the old map's fit: a grid that restarts at the
 * name's scale (other art, or a kept grid that disagreed) leaves bounds
 * fitted to the old cells, but bounds the DM set by hand are left alone.
 * A kept grid that agrees with the name refits to the same cells, so
 * nothing changes there either. On hexes the bounds follow the old map by
 * either count, the hexes' or the squares' that scenes made before the
 * hex fit hold.
 */
export function refitsToNamedMap(old: SceneMap | undefined, next: SceneMap, named: number | undefined, bounds: { w: number; h: number }, gridShape?: GridShape): boolean {
  if (named === undefined || next.cellPx !== named) return false;
  if (!old) return true;
  // A hex scene made before the fit counted hexes holds the square count, and its bounds still follow its map.
  return [fitBounds(old, gridOfShape(gridShape)), fitBounds(old)].some((fit) => fit.w === bounds.w && fit.h === bounds.h);
}

/** A kept grid within 1% of a name's scale is that grid, lined up by hand, so it keeps its origin. */
const NAME_AGREES = 0.01;

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
