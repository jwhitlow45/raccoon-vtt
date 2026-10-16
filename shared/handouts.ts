import type { AssetId, HandoutPage } from "./model.ts";

/**
 * A handout's pages as every reader takes them (docs/design-v1-pdf-handouts.md
 * 3.1): the references, the visible set, the remap, the popup, the display
 * and download. The size is known for a handout of pages, and unknown for
 * one image, whose reader waits for the image itself.
 */
export type HandoutPageRef = { assetId: AssetId; width?: number; height?: number };

/** A stored handout, or a show op's input in either shape. */
type PagesOf = { assetId: AssetId; pages?: HandoutPage[] } | { pages: HandoutPage[] };

/** Every page in order: `pages`, or the one image of a handout without them. */
export function handoutPages(handout: PagesOf): HandoutPageRef[] {
  if (handout.pages) return handout.pages;
  return "assetId" in handout ? [{ assetId: handout.assetId }] : [];
}
