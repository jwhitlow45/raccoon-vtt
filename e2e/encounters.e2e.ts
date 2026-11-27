import assert from "node:assert/strict";
import { uuidv7 } from "#shared/ids.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { blockOf, customMonster } from "#shared/testutil.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openSideTab, sideTabName, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The Encounters panel's saved encounter editor at every size: a room
 * monster's line, its "This room" tag and its "CR 2 · 450 XP each", and
 * a room monster with a long name, stay inside the panel at 1440 x 900,
 * 390 x 844 and 320 x 568, at 100% and 130%, and line up, and so does
 * each monster it offers to add. Nothing in the panel runs sideways past
 * its edge (ENC-LINE-320: at 320 x 568 at 130% the line ran past the
 * sheet, cutting its CR and Remove), even with its text fields drawn
 * twice as wide, as a platform with a wider font draws them.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-seven, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 27;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-encounters-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let context: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");

const run = {
  roomId: "",
  roomName: `E2E encounters ${new Date().toISOString().slice(0, 19)}`,
  keeper: uuidv7(),
  warden: uuidv7(),
  encounter: uuidv7(),
};

const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
];
const SCALES = [1, 1.3];

/**
 * A line for each element under `root` that reaches past its left or right
 * edge, and for a root that scrolls sideways: the overflow the alignment
 * check does not see, since it measures where things line up, not whether
 * they fit.
 */
async function sidewaysLines(root: Locator, screen: string): Promise<string[]> {
  const lines = await root.evaluate((el) => {
    type Box = { left: number; right: number; width: number; height: number };
    type El = { tagName: string; getBoundingClientRect(): Box; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null; textContent: string | null; scrollWidth: number; clientWidth: number; checkVisibility(o: { visibilityProperty: boolean }): boolean };
    const node = el as unknown as El;
    const edge = node.getBoundingClientRect();
    const out: string[] = [];
    if (node.scrollWidth > node.clientWidth + 1) out.push(`the panel scrolls sideways: ${node.scrollWidth} px of content in ${node.clientWidth}`);
    for (const child of Array.from(node.querySelectorAll("*"))) {
      const box = child.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || !child.checkVisibility({ visibilityProperty: true })) continue;
      if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) {
        const words = (child.getAttribute("aria-label") ?? child.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        out.push(`${child.tagName.toLowerCase()} "${words}" runs from ${Math.round(box.left)} to ${Math.round(box.right)}, past the panel's ${Math.round(edge.left)} to ${Math.round(edge.right)}`);
      }
    }
    return out;
  });
  return lines.map((line) => `${screen}: ${line}`);
}

/** The Encounters panel on this layout, its saved encounter "Crypt" opened, and the root it scrolls in. */
async function openCrypt(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  let panel: Locator;
  if (await tabs.isVisible()) {
    await openSideTab(page, "Encounters");
    panel = page.getByRole("tabpanel", { name: sideTabName("Encounters") });
  } else {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Encounters/ }).click();
    panel = page.locator('dialog[data-rvtt-sheet][aria-label="Encounters"]');
  }
  await panel.getByRole("button", { name: /^Crypt/ }).first().click();
  await page.getByRole("button", { name: "Remove Crypt Keeper" }).waitFor();
  return panel;
}

/** A saved encounter's line, from its Remove: the button's row, then the line. */
function lineOf(page: Page, name: string): Locator {
  return page.getByRole("button", { name: `Remove ${name}` }).locator("xpath=ancestor::div[2]");
}

describe("raccoon-vtt: the Encounters panel's lines at every size", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    dm = await context.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(context, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(`[${dmConsole.label}] errors`, dmConsole.errors, "warnings", dmConsole.warnings);
    ops?.close();
    if (run.roomId && context) {
      try {
        const res = await context.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("enc46-1. a DM's room with two monsters of its own, the Crypt Keeper and one with a long name, saved in the encounter Crypt", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "monster.create", monster: { id: run.keeper, ...blockOf(customMonster(run.keeper, { name: "Crypt Keeper" })) } });
    await ops.send({ t: "monster.create", monster: { id: run.warden, ...blockOf(customMonster(run.warden, { name: "Warden of the Drowned Ossuary Gate" })) } });
    await ops.send({ t: "savedEncounter.create", encounter: { id: run.encounter, name: "Crypt", monsters: [{ monsterId: run.keeper, count: 1 }, { monsterId: run.warden, count: 2 }] } });
    await waitFor("the saved encounter", () => dmSocket.state?.savedEncounters[run.encounter] ?? null);
  });

  test("enc46-2. each line, its tag and its CR and XP stay inside the panel and line up, at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const lines: string[] = [];
    for (const size of SIZES) {
      for (const scale of SCALES) {
        const screen = `${size.width}x${size.height}-${Math.round(scale * 100)}`;
        await dm.setViewportSize(size);
        await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await dm.goto(`${server.origin}/r/${run.roomId}`);
        await dm.getByRole("status", { name: "Connected" }).first().waitFor();
        const panel = await openCrypt(dm);
        // The sheet's body scrolls, so its own box is the edge, and in the side panel the tab panel's.
        const body = (await panel.locator("[data-pane-body]").count()) > 0 ? panel.locator("[data-pane-body]").first() : panel;
        lines.push(...(await sidewaysLines(body, screen)));
        // Each monster it offers to add keeps its name, tag and CR inside its row, which a row cut by its sheet's edge alone would not show.
        for (const row of await panel.getByRole("button", { name: /^Add one / }).all()) lines.push(...(await sidewaysLines(row, `${screen} ${await row.getAttribute("aria-label")}`)));
        for (const name of ["Crypt Keeper", "Warden of the Drowned Ossuary Gate"]) {
          const line = lineOf(dm, name);
          await line.scrollIntoViewIfNeeded();
          lines.push(...(await sidewaysLines(line, `${screen} ${name}'s line`)));
          lines.push(...alignmentLines(await measureAlignment(line), `${screen} ${name}'s line`));
        }
        await shots.take(dm, `enc46-crypt-${screen}`);
      }
    }
    assert.deepEqual(lines, [], "the encounter's lines");
  });

  /*
   * A field's own width is 20 characters of its font, and Chrome on Linux draws it about a third wider than on macOS: there the
   * name field's width alone held the editor past the sheet at 320 x 568 at 130%, which macOS never showed. Drawn at 40 characters
   * here, a field must still widen nothing, so the panel fits whatever font a platform gives its fields.
   */
  test("enc46-2b. at 320 x 568 at 130%, the editor's text fields drawn twice as wide, as a platform's wider font draws them, widen nothing past the panel", async () => {
    await dm.setViewportSize({ width: 320, height: 568 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await dm.goto(`${server.origin}/r/${run.roomId}`);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    const panel = await openCrypt(dm);
    const fields = panel.locator('input[type="text"], input[type="search"]');
    assert.ok((await fields.count()) >= 2, "the name and search fields are there");
    await fields.evaluateAll((els) => els.forEach((el) => (el as unknown as { setAttribute(n: string, v: string): void }).setAttribute("size", "40")));
    const body = panel.locator("[data-pane-body]").first();
    const lines = await sidewaysLines(body, "320x568-130 with 40-character fields");
    await shots.take(dm, "enc46-wide-fields-320x568-130");
    assert.deepEqual(lines, [], "the editor with wide fields");
  });

  test("DSTOCK-E. Edit the party moves focus to its first stepper, and Use the room's characters gives it back to Edit the party (STOCK-O-01)", async () => {
    await dm.setViewportSize({ width: 1440, height: 900 });
    const panel = await openCrypt(dm);
    const focused = () => dm.evaluate(() => {
      type El = { getAttribute(name: string): string | null; textContent: string | null };
      const at = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement;
      return at?.getAttribute("aria-label") ?? at?.textContent?.trim() ?? "";
    });
    await panel.getByRole("button", { name: "Edit the party", exact: true }).click();
    await waitFor("focus on the party's first stepper", async () => ((await focused()).startsWith("Characters") ? true : null));
    await panel.getByRole("button", { name: "Use the room's characters", exact: true }).click();
    await waitFor("focus back on Edit the party", async () => ((await focused()) === "Edit the party" ? true : null));
  });

  test("enc46-3. no console errors", () => {
    assert.deepEqual(dmConsole.errors, []);
  });
});
