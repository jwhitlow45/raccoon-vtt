/**
 * The DM guide in the app. docs/dm-guide.md is the source, read on GitHub
 * and bundled into the app by the build (pages/DmGuide.tsx), so the page at
 * GUIDE_PATH is always the guide of the build that serves it.
 */
export const GUIDE_PATH = "/docs/dm-guide";

/** The guide, or one of its sections by its heading's anchor, such as "areas". */
export function guideHref(section?: string): string {
  return section ? `${GUIDE_PATH}#${section}` : GUIDE_PATH;
}

/**
 * The guide's screenshots are 1280 by 800, a computer's window, except the
 * ones taken on a phone. The page gives each image its size before it
 * loads, so the text never moves under a reader who followed a link to a
 * section. guide.test.ts reads every file's real size against this.
 */
const DEFAULT_SIZE = { width: 1280, height: 800 };
const PHONE_SIZE = { width: 390, height: 844 };
const PHONE_SHOTS = new Set(["screen-phone.webp", "reveal-blackout.webp", "phone-strip.webp", "discovery-player.webp"]);

export function guideImageSize(fileName: string): { width: number; height: number } {
  return PHONE_SHOTS.has(fileName) ? PHONE_SIZE : DEFAULT_SIZE;
}

/** The file name an image line names, such as "fog.webp" for `dm-guide/fog.webp`. Null for a path outside the guide's folder. */
export function guideImageName(src: string): string | null {
  const m = /^dm-guide\/([A-Za-z0-9_-]+\.webp)$/.exec(src);
  return m ? m[1]! : null;
}

/** The guide without its own `# DM guide` title, which the page shows as its heading. */
export function guideBody(text: string): string {
  return text.replace(/^# DM guide\r?\n/, "");
}
