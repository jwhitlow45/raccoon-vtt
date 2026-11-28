import type { AssetImage, IconImage, ImageRef, ModelRef } from "./model.ts";

/**
 * Reading an image either way (docs/design/design-v1-dm-tools.md 3.12): an upload
 * from the room's library, or a shipped game-icons.net icon on a colored
 * disk. Every reader of a token's, a portrait's or a monster's image goes
 * through these, so an icon is never taken for an asset that is missing.
 *
 * Either may carry a 3D model (docs/design/design-v1-token-models.md 3.4).
 * Every write that builds an image from another must go through
 * `copyImage` or `keepModel`, so no new picture, crop, icon, paste or copy
 * drops the model on the way (D-261127-375). Only Remove takes it off, with
 * `withoutModel`.
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

/** The upload an image shows, or undefined for an icon or no image. Its model's sheet is `imageModelId`'s. */
export function imageAssetId(image: ImageRef | null | undefined): string | undefined {
  return image && "assetId" in image ? image.assetId : undefined;
}

/** The sheet an image's model names, or undefined for an image without a model or no image. */
export function imageModelId(image: ImageRef | null | undefined): string | undefined {
  return image?.model?.assetId;
}

/** Every asset an image names: the upload it shows, then its model's sheet. An icon without a model names none. */
export function imageAssetIds(image: ImageRef | null | undefined): string[] {
  const ids: string[] = [];
  const picture = imageAssetId(image);
  if (picture !== undefined) ids.push(picture);
  const model = imageModelId(image);
  if (model !== undefined) ids.push(model);
  return ids;
}

/**
 * Whether two images are the same picture: an upload by its asset and crop,
 * an icon by its key and color, and either by its whole model. The store
 * keeps one sheet for identical bytes, so one sheet can carry other sizes
 * and boxes, and those are other images (D-261127-414).
 */
export function sameImage(a: ImageRef | null | undefined, b: ImageRef | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (!sameModel(a.model, b.model)) return false;
  if ("icon" in a || "icon" in b) return "icon" in a && "icon" in b && a.icon === b.icon && a.color === b.color;
  return a.assetId === b.assetId && a.crop.cx === b.crop.cx && a.crop.cy === b.crop.cy && a.crop.zoom === b.crop.zoom;
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.assetId !== b.assetId || a.side !== b.side || a.anchorY !== b.anchorY || a.boxes.length !== b.boxes.length) return false;
  return a.boxes.every((box, i) => {
    const other = b.boxes[i]!;
    return box.length === other.length && box.every((edge, j) => edge === other[j]);
  });
}

function copyModel(model: ModelRef): ModelRef {
  return { assetId: model.assetId, side: model.side, anchorY: model.anchorY, boxes: model.boxes.map(([x0, y0, x1, y1]) => [x0, y0, x1, y1]) };
}

/**
 * A deep copy of an image, model included, so no two places share one
 * crop or model object. Built from the known fields, as the copies it
 * replaces were.
 */
export function copyImage<T extends ImageRef>(image: T): T;
export function copyImage(image: ImageRef): ImageRef {
  const picture: ImageRef = "icon" in image ? { icon: image.icon, color: image.color } : { assetId: image.assetId, crop: { ...image.crop } };
  if (image.model) picture.model = copyModel(image.model);
  return picture;
}

/**
 * `next`, a new picture, crop or icon for a place that wears `current`,
 * carrying `current`'s model where `next` has none of its own, since every
 * change of picture keeps the model (docs/design/design-v1-token-models.md
 * 3.4). A model `next` carries wins, as the newer one.
 */
export function keepModel<T extends ImageRef>(next: T, current: ImageRef | null | undefined): T;
export function keepModel(next: ImageRef, current: ImageRef | null | undefined): ImageRef {
  const out = copyImage(next);
  if (!out.model && current?.model) out.model = copyModel(current.model);
  return out;
}

/** A copy of an image without its model: what Remove model leaves. */
export function withoutModel<T extends ImageRef>(image: T): T;
export function withoutModel(image: ImageRef): ImageRef {
  const out = copyImage(image);
  delete out.model;
  return out;
}
