import { LIMITS } from "#shared/limits.ts";
import type { Scene, SceneMap } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { AssetVariant } from "../../lib/api.ts";
import type { ExportSize } from "../mapexport/size.ts";

/**
 * Scene thumbnails for the Scenes panel (docs/design-v1-maps-vision.md
 * section 3.3): the rules, kept pure so they are tested without a canvas.
 * The map export's renderer draws them, and thumbs.ts decides when.
 */

/** The size a thumbnail is drawn at: at most 320 px on its long side, as the server stores it. */
export function thumbSize(bounds: { w: number; h: number }): ExportSize {
  const long = Math.max(1, bounds.w, bounds.h);
  const pxPerCell = LIMITS.thumbMaxPx / long;
  return {
    pxPerCell,
    requested: pxPerCell,
    width: Math.max(1, Math.min(LIMITS.thumbMaxPx, Math.round(bounds.w * pxPerCell))),
    height: Math.max(1, Math.min(LIMITS.thumbMaxPx, Math.round(bounds.h * pxPerCell))),
  };
}

/** A map asset's own `thumb` copy is at most this many pixels on its long side (server/assets/kinds.ts). */
const MAP_THUMB_SIDE = 512;

/**
 * Which copies of the map art to draw a thumbnail from, best first. The
 * map's small copy is enough unless the scene shows only part of a large
 * image, and then the phone copy has the pixels. Either one is a fallback
 * for the other.
 */
export function thumbMapVariants(map: Pick<SceneMap, "widthPx" | "heightPx" | "cellPx">, pxPerCell: number): AssetVariant[] {
  const shrink = Math.min(1, MAP_THUMB_SIDE / Math.max(map.widthPx, map.heightPx));
  return map.cellPx * shrink >= pxPerCell ? ["thumb", "mobile"] : ["mobile", "thumb"];
}

/** The scene edits a thumbnail shows: a fog, grid or name change looks the same in it. */
const LOOK: ReadonlySet<string> = new Set(["bounds", "background", "autoWalls", "phases"]);

/**
 * The scene whose thumbnail an op from this device changes, or null.
 * Undo and redo take back something on the scene the DM is looking at, as
 * nearly every DM step is. A thumbnail edit itself is not a change, or
 * every thumbnail would ask for another.
 */
export function thumbSceneOf(op: ClientOp, viewingSceneId: string | null): string | null {
  switch (op.t) {
    case "build.paint":
    case "build.erase":
    case "build.rect":
    case "build.poly":
    case "build.edge":
    case "build.label":
    case "build.clear":
    case "build.walls":
    case "build.stamps":
    case "build.lights":
    case "build.height":
    case "build.stairs":
    case "scene.setMap":
    case "scene.setGrid":
    case "scene.setPhase":
      return op.sceneId;
    case "scene.update":
      return Object.keys(op.patch).some((k) => LOOK.has(k)) ? op.sceneId : null;
    case "undo":
    case "redo":
      return viewingSceneId;
    default:
      return null;
  }
}

/** What a thumbnail row shows until it has its own: the map's small copy, or the background for a blank mat. */
export function thumbSources(scene: Pick<Scene, "thumb" | "map">): { assetId: string; variant: AssetVariant }[] {
  const out: { assetId: string; variant: AssetVariant }[] = [];
  if (scene.thumb) out.push({ assetId: scene.thumb, variant: "full" });
  if (scene.map) out.push({ assetId: scene.map.assetId, variant: "thumb" });
  return out;
}

type Encodable = { toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void };

const toBlob = (canvas: Encodable, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * WebP where the browser can encode it, else JPEG. Safari cannot make WebP
 * from a canvas and quietly hands back a PNG instead, several times larger,
 * so the type that came back decides.
 */
export async function encodeThumb(canvas: Encodable): Promise<Blob | null> {
  const webp = await toBlob(canvas, "image/webp", 0.8);
  if (webp?.type === "image/webp") return webp;
  return toBlob(canvas, "image/jpeg", 0.85);
}
