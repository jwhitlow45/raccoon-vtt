import type { AssetId, HandoutPage, RoomState } from "./model.ts";

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

/**
 * The handout pages a room holds against its limit (shared/limits.ts): every
 * page of every document and of every handout showing, one image as one
 * page. A document shown counts its pages again while it shows, and a page
 * two documents share counts in each (docs/design-v1-pdf-handouts.md 3.7).
 */
export function roomHandoutPages(state: Pick<RoomState, "handouts" | "handoutDocs">): number {
  let pages = 0;
  for (const handout of Object.values(state.handouts)) pages += handout.pages?.length ?? 1;
  for (const doc of Object.values(state.handoutDocs)) pages += doc.pages.length;
  return pages;
}
