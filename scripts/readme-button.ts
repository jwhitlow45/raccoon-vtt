import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { writePngText } from "./pngText.ts";

/**
 * Renders the README's Docker Hub button (docs/images/docker-hub-button.html)
 * to docs/images/docker-hub-button.png, at 3x for high-density screens, with
 * package.json's version in its chip and in the PNG's "Version" text, which
 * scripts/readme-button.test.ts checks. Run it with `pnpm readme-button` when
 * a release bumps the version (README.md, "Releasing"). It needs Chrome.
 */

const root = new URL("../", import.meta.url);
const version = (JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string }).version;
const html = fileURLToPath(new URL("docs/images/docker-hub-button.html", root));
const png = fileURLToPath(new URL("docs/images/docker-hub-button.png", root));

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 3 });
  await page.goto(`file://${html}`);
  await page.locator("#version").evaluate((el, v) => (el.textContent = `v${v}`), version);
  // The server project types scripts without the DOM library, so the page's document is reached through globalThis.
  await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
  const shot = await page.locator("#button").screenshot({ omitBackground: true });
  writeFileSync(png, writePngText(shot, "Version", version));
} finally {
  await browser.close();
}
console.log(`docs/images/docker-hub-button.png: v${version}`);
