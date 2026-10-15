import type { RoomState, Scene } from "#shared/model.ts";
import type { AssetSource } from "../../state/view.ts";
import { exportContent } from "../mapexport/content.ts";
import { loadMapImage, renderMapPng } from "../mapexport/render.ts";
import { encodeThumb, thumbMapVariants, thumbSize } from "./thumbnail.ts";

/**
 * A scene's thumbnail, drawn by the map export's renderer (design 12): the
 * background, the active map image, the build and its stamps as the DM's
 * board shows them, never tokens, drawings or fog. No grid lines, which at
 * this size would only grey the picture.
 */
export async function renderThumbnail(input: { scene: Scene; room: RoomState; assets: AssetSource }): Promise<Blob> {
  const { scene, room, assets } = input;
  const size = thumbSize(scene.bounds);
  const content = exportContent({ scene, buildChunks: room.buildChunks, labels: room.labels, stamps: room.stamps, fogTiles: room.fogTiles, view: "dm" });
  let map: HTMLImageElement | null = null;
  if (scene.map) {
    const { assetId } = scene.map;
    map = await loadMapImage(thumbMapVariants(scene.map, size.pxPerCell).map((v) => assets.url(assetId, v)));
    // A picture without its map would be worse than the map's own small copy the row shows meanwhile.
    if (!map) throw new Error("the map image did not load");
  }
  return renderMapPng({ scene, size, content, grid: false, map, assets, encode: encodeThumb });
}
