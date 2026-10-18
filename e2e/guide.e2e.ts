import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ConsoleWatch, Shots, startServer, type Server } from "./harness.ts";

/**
 * The DM guide's page at /docs/dm-guide (client/pages/DmGuide.tsx), signed
 * out, on a computer and a phone. A module test checks the guide's links
 * and images (client/features/guide/guide.test.ts). What only a browser
 * shows is here: the server answers the path with the app, and a reload
 * of a link to a section lands on that section, although the page draws
 * after the browser looked for it.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus twenty-three.
 * It creates no room.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 23;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-guide-"));
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;

/** The page's globals these checks read. The e2e files compile without the DOM's types, so each evaluate casts to this. */
type Win = {
  document: { getElementById(id: string): { getBoundingClientRect(): { top: number } } | null; documentElement: { scrollWidth: number } };
  innerWidth: number;
  location: { hash: string };
};
type Img = { complete: boolean; naturalWidth: number };

/** Where the heading sits in the window: just under its top when the page has scrolled to it. */
async function headingTop(page: Page, id: string): Promise<number> {
  const top = await page.evaluate((id) => (globalThis as unknown as Win).document.getElementById(id)?.getBoundingClientRect().top ?? null, id);
  assert.notEqual(top, null, `#${id} is on the page`);
  return top!;
}

describe("raccoon-vtt DM guide page", { timeout: 90_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
  });

  after(async () => {
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  for (const device of [
    { name: "computer", options: { viewport: { width: 1280, height: 800 } }, section: "areas" },
    { name: "phone", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, section: "the-group-save" },
  ]) {
    test(`on a ${device.name}, a link to a section opens there, and so does a reload`, async () => {
      const context = await browser.newContext(device.options);
      const page = await context.newPage();
      const watch = new ConsoleWatch(device.name);
      watch.attach(page);
      try {
        const res = await page.goto(`${server.origin}/docs/dm-guide#${device.section}`);
        assert.equal(res?.status(), 200);
        await page.locator(`#${device.section}`).waitFor();
        assert.equal(await page.title(), "RaccoonVTT · DM guide");
        const top = await headingTop(page, device.section);
        assert.ok(top >= 0 && top < 60, `#${device.section} at ${top}`);
        await shots.take(page, `guide-${device.name}-${device.section}`);

        await page.reload();
        await page.locator(`#${device.section}`).waitFor();
        // The browser may restore the old scroll after the page draws, so the check waits for the screen to settle.
        await page.waitForTimeout(500);
        const again = await headingTop(page, device.section);
        assert.ok(again >= 0 && again < 60, `after a reload, #${device.section} at ${again}`);

        // The contents list and back: an in-page jump keeps the section in the address.
        await page.getByRole("link", { name: "Contents", exact: true }).last().click();
        await page.locator('a[href="#initiative"]').first().click();
        assert.equal(await page.evaluate(() => (globalThis as unknown as Win).location.hash), "#initiative");
        const initiative = await headingTop(page, "initiative");
        assert.ok(initiative >= 0 && initiative < 60, `#initiative at ${initiative}`);

        assert.equal(await page.evaluate(() => (globalThis as unknown as Win).document.documentElement.scrollWidth - (globalThis as unknown as Win).innerWidth), 0, "no sideways scroll");
        assert.deepEqual(watch.errors, []);
      } finally {
        await context.close();
      }
    });
  }

  test("the guide's screenshots are files of the build", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${server.origin}/docs/dm-guide#initiative`);
      const image = page.locator('img[src*="/assets/initiative-"]').first();
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction((el) => (el as unknown as Img).complete && (el as unknown as Img).naturalWidth > 0, await image.elementHandle());
      assert.equal(await image.evaluate((el) => (el as unknown as Img).naturalWidth), 1280);
    } finally {
      await context.close();
    }
  });

  test("docs-a: Home links to the Docs page, which links the DM guide, and a reload of /docs stays", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const watch = new ConsoleWatch("docs-a");
    watch.attach(page);
    try {
      await page.goto(server.origin);
      const docs = page.getByRole("button", { name: "Docs", exact: true });
      await docs.waitFor();
      const box = await docs.boundingBox();
      assert.ok(box && box.height >= 44, `Docs button is ${box?.height} px tall`);
      await docs.click();
      await page.getByRole("heading", { name: "Docs", exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/docs");
      assert.equal(await page.title(), "RaccoonVTT · Docs");
      await shots.take(page, "docs-phone");

      // A hard reload and the trailing-slash form are answered with the app.
      for (const path of ["/docs", "/docs/"]) {
        const res = await page.goto(`${server.origin}${path}`);
        assert.equal(res?.status(), 200);
        await page.getByRole("heading", { name: "Docs", exact: true }).waitFor();
      }

      await page.getByRole("link", { name: /DM guide/ }).click();
      await page.locator("#contents").waitFor();
      assert.equal(new URL(page.url()).pathname, "/docs/dm-guide");
      await page.getByRole("button", { name: "All docs", exact: true }).click();
      await page.getByRole("heading", { name: "Docs", exact: true }).waitFor();
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await page.getByRole("button", { name: "Join" }).waitFor();
      assert.equal(await page.evaluate(() => (globalThis as unknown as Win).document.documentElement.scrollWidth - (globalThis as unknown as Win).innerWidth), 0, "no sideways scroll");
      assert.deepEqual(watch.errors, []);
    } finally {
      await context.close();
    }
  });
});
