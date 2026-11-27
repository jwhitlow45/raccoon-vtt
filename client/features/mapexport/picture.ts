import type { AutoWalls, RoomState, Scene } from "#shared/model.ts";
import { api } from "../../lib/api.ts";
import { deviceMapVariant } from "../../lib/device.ts";
import type { AssetSource } from "../../state/view.ts";
import { contentEmpty, exportContent, fileImageContent, fromServer, playerViewContent, type ExportContent, type ExportView } from "./content.ts";
import { ExportError, loadMapImage, renderMapPng } from "./render.ts";
import { exportSize, mapVariantFor, type ExportLimits } from "./size.ts";

/**
 * One floor's picture, as Export as image and Export as VTT file both make
 * it: the content for the version, drawn on the floor's map and encoded
 * as a PNG. The player view of a floor with fog on is the server's to give
 * (docs/design/design-v1-map-discovery.md 4), so it is asked for, and
 * anything else comes from this device's copy.
 */

/** When the server cannot say what players get of the scene. */
export const PLAYER_VIEW_FAILED = "Could not get the players' view of this scene from the server. Check the connection, then try again.";
/** When the server says players hold nothing of a scene with no map image, so the image would be blank. */
export const PLAYERS_HOLD_NOTHING = "Players have seen none of this scene's build yet, so their view has nothing to export.";

/** A made picture, with what its notes count, and the automatic walls rule its build was drawn under, which a file's walls follow. */
export type Picture = { blob: Blob; content: ExportContent; mapMissing: boolean; rule: AutoWalls };

export type PictureInput = {
  floor: Scene;
  /** "image" draws the version as asked. "file" draws a Universal VTT file's art, as players see the map (content.ts fileImageContent). */
  purpose: "image" | "file";
  view: ExportView;
  pxPerCell: number;
  limits?: ExportLimits;
  grid: boolean;
  /** The floor is exported alone, so a blank player view is an error rather than a floor's background in a zip. */
  alone: boolean;
  room: RoomState;
  roomId: string;
  assets: AssetSource;
  /** True once the run was overtaken, which drops the picture. */
  stale(): boolean;
};

/** One floor's picture, or null once the run was overtaken. Throws an ExportError with a sentence for the DM. */
export async function floorPicture(input: PictureInput): Promise<Picture | null> {
  const { floor, view, room } = input;
  const size = exportSize(floor.bounds, input.pxPerCell, input.limits);
  let content: ExportContent;
  let rule: AutoWalls = floor.autoWalls ?? "all";
  if (fromServer(view, floor)) {
    let players: Awaited<ReturnType<typeof api.getPlayerView>>;
    try {
      players = await api.getPlayerView(input.roomId, floor.id);
    } catch {
      if (input.stale()) return null;
      throw new ExportError(PLAYER_VIEW_FAILED);
    }
    if (input.stale()) return null;
    content = playerViewContent(players, room, floor.id);
    // Every floor's file draws a floor players hold nothing of as its background, so the floors keep their places.
    if (input.alone && !floor.map && contentEmpty(content)) throw new ExportError(PLAYERS_HOLD_NOTHING);
    // Drawn by the automatic walls rule of players' copy, "off" with fog on: their chunks carry the automatic walls they hold (docs/design/design-v1-map-discovery.md 5.2).
    rule = players.scene.autoWalls ?? "off";
  } else {
    const parts = { buildChunks: room.buildChunks, labels: room.labels, fogTiles: room.fogTiles, exploredTiles: room.exploredTiles, stamps: room.stamps };
    content = input.purpose === "file" && view === "dm" ? fileImageContent({ ...parts, scene: floor }) : exportContent({ ...parts, scene: floor, view });
  }

  let map: HTMLImageElement | null = null;
  const sceneMap = floor.map;
  if (sceneMap) {
    const device = deviceMapVariant();
    const first = mapVariantFor(sceneMap, size.pxPerCell, device);
    const variants = device === "mobile" ? ["mobile" as const] : first === "full" ? (["full", "mobile"] as const) : (["mobile", "full"] as const);
    map = await loadMapImage(variants.map((v) => input.assets.url(sceneMap.assetId, v)));
    if (input.stale()) return null;
  }
  const blob = await renderMapPng({ scene: { ...floor, autoWalls: rule }, size, content, grid: input.grid, map, assets: input.assets });
  if (input.stale()) return null;
  return { blob, content, mapMissing: sceneMap !== undefined && map === null, rule };
}
