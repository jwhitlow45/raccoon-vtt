import type { ImageRef, Token } from "#shared/model.ts";
import { MAX_ALT_IMAGES, type TokenPatch } from "#shared/protocol.ts";
import { sameImage as sameImageRef } from "#shared/imageRef.ts";

/**
 * A token's other images (features section 5): a druid's Wild Shape forms,
 * a disguise, a creature on fire. Each change is one `token.update` of the
 * image and the list together, so a swap is one op and one undo, and two
 * devices swapping at once never leave the token wearing one image twice.
 */
type Images = Pick<Token, "image" | "altImages">;

function sameImage(a: ImageRef, b: ImageRef): boolean {
  return sameImageRef(a, b);
}

/**
 * Wears alternate `index`, and keeps the image the token wore in its place,
 * so swapping back is the same tap. A token with no image just takes it.
 */
export function swapPatch(token: Images, index: number): TokenPatch | null {
  const alts = token.altImages ?? [];
  const next = alts[index];
  if (!next) return null;
  const rest = token.image ? alts.map((image, i) => (i === index ? token.image! : image)) : alts.filter((_, i) => i !== index);
  return { image: next, altImages: rest };
}

/** Adds an image to the list, unless the list is full or the token already has that exact image. */
export function addPatch(token: Images, image: ImageRef): TokenPatch | null {
  const alts = token.altImages ?? [];
  if (!canAdd(token)) return null;
  if ((token.image && sameImage(token.image, image)) || alts.some((a) => sameImage(a, image))) return null;
  return { altImages: [...alts, image] };
}

export function canAdd(token: Images): boolean {
  return (token.altImages?.length ?? 0) < MAX_ALT_IMAGES;
}

export function removePatch(token: Images, index: number): TokenPatch | null {
  const alts = token.altImages ?? [];
  if (index < 0 || index >= alts.length) return null;
  const rest = alts.filter((_, i) => i !== index);
  return { altImages: rest.length > 0 ? rest : null };
}
