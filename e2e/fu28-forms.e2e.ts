import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { textLines } from "./helpers/wraps.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Take a shape on a Druid's folded Stat block row (D-261024-26 and
 * D-261024-27): the summary never counts known forms, the button reads
 * "4 shapes" with the name "4 shapes, take a shape", and the row
 * stays on one line and in line at 320 x 568 and 390 x 844, at 130%.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT itself, its own file after the
 * pc stats file's lane.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-fu28-forms-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let anaContext: BrowserContext;
let ana: Page;
let anaCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana") };

const run = { roomId: "", roomName: `E2E fu28 forms ${new Date().toISOString().slice(0, 19)}`, password: "", anaId: "", bree: randomUUID() };
const ABILITIES = { str: 10, dex: 14, con: 14, int: 10, wis: 16, cha: 8 };
const FORMS = ["wolf", "brown-bear", "black-bear", "giant-eagle"];
const SIZES = [
  { width: 390, height: 844, scale: 1.3 },
  { width: 320, height: 568, scale: 1.3 },
];

function actor() {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

async function closeSheets(page: Page): Promise<void> {
  const open = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true });
  for (let i = 0; i < 3; i++) {
    if ((await open.count()) === 0) return;
    await open.first().getByRole("button", { name: /^Close / }).first().click();
  }
}

async function openCharacters(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.first().isVisible())) {
    await openSideTab(page, "Characters");
    return page.getByRole("tabpanel", { name: "Characters" });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (await sheet.isVisible()) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  await sheet.waitFor();
  return sheet;
}

async function breesPage(page: Page): Promise<Locator> {
  const panel = await openCharacters(page);
  const heading = panel.locator("[data-creature-heading]").filter({ hasText: "Bree" });
  const opener = panel.locator(`[data-opener="character:${run.bree}"]`);
  await heading.or(opener).first().waitFor();
  if ((await heading.count()) === 0) await opener.click();
  await heading.waitFor();
  return panel;
}

async function checkRow(summary: string, label: string): Promise<void> {
  for (const view of SIZES) {
    const at = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
    await anaCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
    await ana.setViewportSize({ width: view.width, height: view.height });
    await ana.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
    await ana.goto(`${server.origin}/r/${run.roomId}`);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
    const panel = await breesPage(ana);
    const fold = panel.getByRole("button", { name: "Stat block", exact: true });
    if ((await fold.getAttribute("aria-expanded")) === "true") await fold.click();
    const take = panel.getByRole("button", { name: "4 shapes, take a shape", exact: true });
    await take.waitFor();
    assert.equal((await take.textContent())?.trim(), "4 shapes");
    assert.equal(await panel.getByText(/known forms?$/).count(), 0, `${at}: the summary counts no forms`);
    await panel.getByText(summary, { exact: true }).waitFor();
    assert.equal(await textLines(take), 1, `${at}: 4 shapes stays on one line`);
    assert.equal(await panel.getByRole("heading", { name: "Known forms" }).count(), 0, `${at}: no Known forms section`);
    const row = take.locator(`xpath=ancestor::*[.//button[normalize-space()="Stat block"]][1]`);
    assert.deepEqual(alignmentLines(await measureAlignment(row), `the folded Stat block row ${label} at ${at}`), [], "out of line by more than 1 px");
    await shots.take(ana, `fu28-forms-${label}-${view.width}-130`);
  }
}

describe("raccoon-vtt: a Druid's Take a shape row", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    anaContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    ana = await anaContext.newPage();
    anaCdp = await anaContext.newCDPSession(ana);
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
  });

  after(async () => {
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("fu28-forms-0. a room with Ana playing Bree, a level 5 Druid with a block and four known forms", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await anaContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await anaContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Ana", color: "#30a46c" } });
    run.anaId = ((await done.json()) as { member: { id: string } }).member.id;
    await ops.send({ t: "character.create", character: { id: run.bree, name: "Bree", size: "medium", ownerIds: [run.anaId], actor: actor() } });
    await ops.send({
      t: "character.update",
      characterId: run.bree,
      patch: { level: 5, knownForms: FORMS, stats: { abilities: ABILITIES, saves: ["int", "wis"], skills: {}, adjust: {}, defenses: {}, rolls: [] } },
    });
    await ana.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Ana's snapshot", () => anaSocket.state?.characters[run.bree]?.knownForms?.length === 4);
  });

  test("fu28-forms-1. the folded row says Level 5, PB +3 with no known forms, and Take a shape reads 4 shapes on one line, in line, at 390 x 844 and 320 x 568 at 130%", async () => {
    await checkRow("Level 5, PB +3", "block");
  });

  test("fu28-forms-1b. in Wild Shape as a Giant Constrictor Snake the button stays on the row as 4 shapes, on one line and in line, at the same sizes", async () => {
    await ops.send({ t: "character.update", characterId: run.bree, patch: { actor: { srdId: "giant-constrictor-snake", wildShape: true } } });
    await waitFor("the shape", () => (anaSocket.state?.characters[run.bree]?.actor.srdId === "giant-constrictor-snake" ? true : null));
    await checkRow("Wild Shape: Giant Constrictor Snake", "wild");
  });

  test("fu28-forms-2. no console errors", () => {
    assert.deepEqual(consoles.ana.errors, []);
    assert.deepEqual(consoles.dm.errors, []);
  });
});
