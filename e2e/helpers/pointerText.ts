import type { Page } from "playwright-core";
import { pointerWordsFor } from "../../client/lib/pointerRules.ts";

/**
 * The words the app shows this page for a line written with "Tap": a page whose main pointer is a mouse
 * reads "Click" (client/lib/pointerWords.ts), a touch page keeps "Tap". Asked of the page itself, so a
 * check that runs on both kinds of page names what each one shows.
 */
export async function pointerText(page: Page, text: string): Promise<string> {
  const coarse = await page.evaluate(() => (globalThis as unknown as { matchMedia(q: string): { matches: boolean } }).matchMedia("(pointer: coarse)").matches);
  return pointerWordsFor(text, {}, coarse);
}
