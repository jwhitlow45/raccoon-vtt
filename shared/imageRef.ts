import type { AssetImage, IconImage, ImageRef } from "./model.ts";

/**
 * Reading an image either way (docs/design-v1-dm-tools.md 3.12): an upload
 * from the room's library, or a shipped game-icons.net icon on a colored
 * disk. Every reader of a token's, a portrait's or a monster's image goes
 * through these, so an icon is never taken for an asset that is missing.
 */

/**
 * An icon's key, `"<author>/<name>"`: the folder and file name of its SVG
 * under public/game-icons/, as slugs, never a path that could climb out.
 */
export const ICON_KEY_RE = /^[a-z0-9-]{1,40}\/[a-z0-9-]{1,60}$/;

export function isIconImage(image: ImageRef): image is IconImage {
  return "icon" in image;
}

export function isAssetImage(image: ImageRef): image is AssetImage {
  return "assetId" in image;
}

/** The asset an image names, or undefined for an icon or no image. */
export function imageAssetId(image: ImageRef | null | undefined): string | undefined {
  return image && "assetId" in image ? image.assetId : undefined;
}

/** Whether two images are the same picture: an upload by its asset and crop, an icon by its key and color. */
export function sameImage(a: ImageRef | null | undefined, b: ImageRef | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if ("icon" in a || "icon" in b) return "icon" in a && "icon" in b && a.icon === b.icon && a.color === b.color;
  return a.assetId === b.assetId && a.crop.cx === b.crop.cx && a.crop.cy === b.crop.cy && a.crop.zoom === b.crop.zoom;
}
