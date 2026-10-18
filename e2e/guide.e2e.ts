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
 * after the browser looked for it. The guide's look
 * (docs/design-v1-guide-look.md) too: the outline beside the text on a
 * computer, which marks the section being read, the Contents sheet on a
 * phone, and the numbers, steps, keys and callouts the page draws.
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
  document: {
    getElementById(id: string): { getBoundingClientRect(): { top: number }; scrollIntoView(): void } | null;
    documentElement: { scrollWidth: number };
    activeElement: { id: string } | null;
    querySelector(selector: string): { textContent: string | null } | null;
  };
  innerWidth: number;
  location: { hash: string };
};
type Img = { complete: boolean; naturalWidth: number };

/** The row an outline marks as the place being read, by its text ("2.5Initiative"), once it reads `text`. */
async function waitForMarked(page: Page, within: string, text: string): Promise<void> {
  await page
    .waitForFunction(
      ([within, text]) => (globalThis as unknown as Win).document.querySelector(`${within} [aria-current="location"]`)?.textContent === text,
      [within, text] as const,
      { timeout: 5_000 },
    )
    .catch(async () => {
      const marked = await page.evaluate((within) => (globalThis as unknown as Win).document.querySelector(`${within} [aria-current="location"]`)?.textContent ?? null, within);
      assert.fail(`the outline marks ${marked}, not ${text}`);
    });
}

const OUTLINE = 'nav[aria-label="Guide outline"]';

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
    { name: "computer", options: { viewport: { width: 1280, height: 800 } }, section: "areas", marked: "2.8Areas" },
    { name: "phone", options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, section: "the-group-save", marked: "2.9The group save" },
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

        if (device.name === "computer") {
          // guidelook-a: the outline beside the text marks the section, and its Contents link goes to the contents, where a section's link jumps and keeps the section in the address.
          await waitForMarked(page, OUTLINE, device.marked);
          await page.locator(OUTLINE).getByRole("link", { name: "Contents", exact: true }).click();
          const contents = await headingTop(page, "contents");
          assert.ok(contents >= 0 && contents < 60, `#contents at ${contents}`);
          await page.getByRole("navigation", { name: "Contents", exact: true }).locator('a[href="#initiative"]').click();
          await waitForMarked(page, OUTLINE, "2.5Initiative");
        } else {
          // guidelook-b: on a phone the Contents button opens the outline as a sheet, marked where the reader is, and a row closes it and lands on its heading.
          assert.equal(await page.locator(OUTLINE).count(), 0, "no outline beside the text on a phone");
          const button = page.getByRole("button", { name: "Contents", exact: true });
          const box = await button.boundingBox();
          assert.ok(box && box.height >= 44, `the Contents button is ${box?.height} px tall`);
          await button.click();
          const sheet = page.getByRole("dialog", { name: "Contents" });
          await sheet.waitFor();
          await waitForMarked(page, `dialog ${OUTLINE}`, device.marked);
          const heights = await sheet.locator(`${OUTLINE} a`).evaluateAll((rows) => rows.map((r) => (r as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect().height));
          assert.ok(heights.length > 30 && heights.every((h) => h >= 44), `the sheet's rows: ${Math.min(...heights)} px at the least`);
          await shots.take(page, "guidelook-b-phone-sheet");
          await sheet.locator('a[href="#initiative"]').click();
          await sheet.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => (globalThis as unknown as Win).document.activeElement?.id), "initiative", "focus lands on the heading");
        }
        assert.equal(await page.evaluate(() => (globalThis as unknown as Win).location.hash), "#initiative");
        const initiative = await headingTop(page, "initiative");
        assert.ok(initiative >= 0 && initiative < 60, `#initiative at ${initiative}`);
        if (device.name === "phone") {
          // The sheet's jump is an entry in the history, as a link's is, so Back returns to where the reader was.
          await page.goBack();
          await page.waitForFunction((hash) => (globalThis as unknown as Win).location.hash === hash, `#${device.section}`);
        }

        assert.equal(await page.evaluate(() => (globalThis as unknown as Win).document.documentElement.scrollWidth - (globalThis as unknown as Win).innerWidth), 0, "no sideways scroll");
        assert.deepEqual(watch.errors, []);
      } finally {
        await context.close();
      }
    });
  }

  test("guidelook-c: the page numbers the parts and sections, and draws steps, keys, callouts and examples", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const watch = new ConsoleWatch("guidelook-c");
    watch.attach(page);
    try {
      await page.goto(`${server.origin}/docs/dm-guide`);
      const contents = page.getByRole("navigation", { name: "Contents", exact: true });
      await contents.waitFor();

      // The contents: a card per part in order, its sections numbered within it.
      const parts = await contents.locator(":scope > ol > li > a").evaluateAll((links) => links.map((a) => (a as unknown as { getAttribute(n: string): string | null }).getAttribute("href")));
      assert.deepEqual(parts, ["#making-maps", "#running-fights", "#deeper-tools", "#scenarios", "#reference"]);
      assert.equal(await contents.locator('a[href="#initiative"]').textContent(), "2.5Initiative");
      await shots.take(page, "guidelook-c-contents");

      // The numbers are for the eye: each heading's name is its own words.
      const part = page.getByRole("heading", { level: 2, name: "Running fights", exact: true });
      assert.equal(await part.getAttribute("id"), "running-fights");
      assert.equal(await part.textContent(), "Part 2Running fights");
      const section = page.getByRole("heading", { level: 3, name: "Initiative", exact: true });
      assert.equal(await section.textContent(), "2.5Initiative");
      const example = page.getByRole("heading", { level: 3, name: "A forest road ambush", exact: true });
      assert.equal(await example.textContent(), "Example 4.1A forest road ambush");

      // Steps keep their list role, keys are keycaps, and the guide's asides are callouts with their label.
      assert.ok((await page.locator('article ol[role="list"]').count()) >= 10, "the procedures are steps");
      assert.ok((await page.locator("article kbd", { hasText: /^N$/ }).count()) >= 1, "the Next key is a keycap");
      const notes = page.getByRole("note");
      const labels = await notes.evaluateAll((els) => els.map((el) => (el as unknown as { firstElementChild: { textContent: string | null } | null }).firstElementChild?.textContent ?? ""));
      assert.ok(labels.includes("Tip") && labels.includes("Note"), `callouts: ${labels.join(", ")}`);
      await notes.first().scrollIntoViewIfNeeded();
      await shots.take(page, "guidelook-c-callout");

      // Reading on moves the outline's mark, and the part being read opens in it.
      await page.evaluate(() => (globalThis as unknown as Win).document.getElementById("dice")?.scrollIntoView());
      await waitForMarked(page, OUTLINE, "2.6Dice");
      assert.ok(await page.locator(OUTLINE).locator('a[href="#the-group-save"]').isVisible(), "Running fights is open in the outline");
      assert.equal(await page.locator(OUTLINE).locator('a[href="#fog"]').count(), 0, "Making maps is folded");
      await page.evaluate(() => (globalThis as unknown as Win).document.getElementById("a-forest-road-ambush")?.scrollIntoView());
      await waitForMarked(page, OUTLINE, "4.1A forest road ambush");
      await shots.take(page, "guidelook-c-example");
      assert.deepEqual(watch.errors, []);
    } finally {
      await context.close();
    }
  });

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
