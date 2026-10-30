import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, LoadWatch, openSideTab, OpSocket, pagePoint, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Notes and map pins on a wave 5 build that the live play review after
 * wave 5 found broken (LP5-NOTES): a DM on a desktop and a player on a
 * phone. Then where focus goes on Back from a journal page whose row
 * changed while it was open (review DATA-01).
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus six. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 6;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-notes-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
/** A second socket of the DM's session, standing in for the DM's other device. */
let otherDevice: OpSocket | undefined;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");
const dmLoads = new LoadWatch();

const run = {
  roomId: "",
  roomName: `E2E notes ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  bounds: { w: 30, h: 20 },
  pinId: "",
  patId: "",
};

/** What closing the pin pane says while its Done is still pending, online or not (journal/pendingSave.ts). */
const PENDING_NOTICE = /^The pin (is still saving|will save when the connection is back)\.$/;

/**
 * Takes the DM's browser off the network, so a Done stays pending until it
 * comes back. Only once the room's background loads are done, since one
 * cut off would leave its panel unable to open (harness.ts LoadWatch).
 */
async function dmOffline(offline: boolean): Promise<void> {
  if (offline) await dmLoads.preloaded();
  dmConsole.expectSocketFailures = offline || dmConsole.expectSocketFailures;
  await dmContext.setOffline(offline);
}

/** Opens a panel from the phone's panel list, which holds the panels that have no toolbar button of their own. */
async function openPhonePanel(page: Page, name: string): Promise<void> {
  const picker = page.getByRole("list", { name: "Panels" });
  const all = page.getByRole("button", { name: "All panels" });
  if (await picker.isVisible()) {
    // The list is already open.
  } else if (await all.isVisible()) await all.tap();
  // By its title: with a count on it, the button's name is the count.
  else await page.locator('button[title="Panels"]').tap();
  // A panel with unread pages or lines carries its count after its name.
  await picker.getByRole("button", { name: new RegExp(`^${name}( ?\\d+ unread)?$`) }).tap();
}

type Focused = { tag: string; role: string | null; opener: string | null; name: string };

/** What has focus: its tag, its role, the `data-opener` id it carries, and its name or text. */
function focusedOn(page: Page): Promise<Focused> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as { document: { activeElement: { tagName: string; textContent: string | null; getAttribute(name: string): string | null } | null } }).document.activeElement;
    if (!el) return { tag: "", role: null, opener: null, name: "" };
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), opener: el.getAttribute("data-opener"), name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() };
  });
}

function hasFocus(el: Locator): Promise<boolean> {
  return el.evaluate((node) => node === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement);
}

/** Opens a journal page from its row and goes Back by keyboard, as the kit's tests do, and tells what has focus then. */
async function openAndBack(page: Page, row: Locator): Promise<Focused> {
  await row.focus();
  await page.keyboard.press("Enter");
  const back = page.getByRole("button", { name: "Back to Journal" });
  await back.waitFor();
  await back.focus();
  await page.keyboard.press("Enter");
  await back.waitFor({ state: "detached" });
  return focusedOn(page);
}

/** The Journal's tab on a computer, named with its unread count when it has one. */
const JOURNAL_TAB = /^Journal( ?\d+ unread)?$/;

describe("raccoon-vtt notes and pins on a wave 5 build", { timeout: 180_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    dmLoads.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    otherDevice?.close();
    if (run.roomId && dmContext) {
      try {
        await dmContext.setOffline(false);
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("1. the DM creates a room and a player joins from a phone", async () => {
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

    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).click();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).click();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    run.patId = playerSocket.you!.memberId;
  });

  test("2. Escape on the pin pane while Done is pending says the pin is still saving, as × does (W5-ASTRA-07)", async () => {
    await dm.getByRole("button", { name: "Pin", exact: true }).click();
    await dm.getByRole("button", { name: "Pin", exact: true, pressed: true }).waitFor();
    await tapCell(dm, run.bounds, { x: 8, y: 6 });
    const pane = dm.getByRole("dialog", { name: "Edit pin" });
    await pane.waitFor();
    run.pinId = await waitFor("the new pin in the DM's state", () => Object.keys(dmSocket.state?.pins ?? {})[0]);

    await pane.getByLabel("Pin label").fill("Old well");
    await pane.getByRole("checkbox", { name: "DM only" }).uncheck();
    await dmOffline(true);
    await pane.getByRole("button", { name: "Done" }).click();
    await pane.getByRole("button", { name: "Saving…" }).waitFor();
    await dm.keyboard.press("Escape");
    await pane.waitFor({ state: "detached" });
    await dm.getByRole("status").filter({ hasText: PENDING_NOTICE }).waitFor();
    await shots.take(dm, "notes-pin-escape-pending");

    await dmOffline(false);
    await waitFor("the pin's label for the player", () => playerSocket.state?.pins[run.pinId]?.label === "Old well" || null, 30_000);
  });

  test("3. Back on the pin pane while Done is pending says so too, and stays in the room (W5-ASTRA-07)", async () => {
    await waitFor("the DM's socket back", () => dmSocket.state?.pins[run.pinId]?.label === "Old well" || null, 30_000);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 30_000 });
    // The same notice still showing from step 2 would be kept, not said again, and since then "Saved. Undo in Setup history." was said last. Let it pass first.
    await dm.locator("[data-toast]").filter({ hasText: PENDING_NOTICE }).waitFor({ state: "detached", timeout: 15_000 });
    // The pin's marker is a 28 px pin over its point, so its middle is 14 px above it.
    const tip = await pagePoint(dm, run.bounds, { x: 8.5, y: 6.5 });
    await dm.mouse.click(tip.x, tip.y - 14);
    const pane = dm.getByRole("dialog", { name: "Edit pin" });
    await pane.waitFor();
    const room = dm.url();

    await pane.getByLabel("Pin label").fill("Older well");
    await dmOffline(true);
    await pane.getByRole("button", { name: "Done" }).click();
    await pane.getByRole("button", { name: "Saving…" }).waitFor();
    await dm.goBack();
    await pane.waitFor({ state: "detached" });
    await dm.getByRole("status").filter({ hasText: PENDING_NOTICE }).waitFor();
    assert.equal(dm.url(), room, "Back left the room");

    await dmOffline(false);
    await waitFor("the new label for the player", () => playerSocket.state?.pins[run.pinId]?.label === "Older well" || null, 30_000);
    dmConsole.expectSocketFailures = false;
  });

  test("4. a pin's page deleted on the DM's other device while its pane is open leaves the pane with no page and DM only on (LP5-NOTES-1)", async () => {
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    otherDevice = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const pageId = randomUUID();
    await otherDevice.send({ t: "journal.create", page: { id: pageId, title: "Pat's dream", access: { member: run.patId }, blocks: [{ id: "dreamblock01", text: "You dream of a well." }] } });
    const pin = dmSocket.state!.pins[run.pinId]!;
    await otherDevice.send({ t: "pin.put", pin: { id: pin.id, sceneId: pin.sceneId, x: pin.x, y: pin.y, color: pin.color, label: "Older well", pageId, visibility: "all" } });
    await waitFor("the linked pin for the player", () => playerSocket.state?.pins[run.pinId]?.pageId === pageId || null);

    const tip = await pagePoint(dm, run.bounds, { x: 8.5, y: 6.5 });
    await dm.mouse.click(tip.x, tip.y - 14);
    const pane = dm.getByRole("dialog", { name: "Edit pin" });
    await pane.waitFor();
    assert.equal(await pane.getByLabel("Linked page").inputValue(), pageId);
    await pane.getByLabel("Pin label").fill("Well of echoes");

    await otherDevice.send({ t: "journal.delete", pageId });
    await waitFor("DM only on in the pane", async () => (await pane.getByRole("checkbox", { name: "DM only" }).isChecked()) || null);
    assert.equal(await pane.getByLabel("Linked page").inputValue(), "");
    await pane.getByText("Who will see it: Only the DM").waitFor();
    assert.equal(await pane.getByLabel("Pin label").inputValue(), "Well of echoes", "the label typed is kept");
    await shots.take(dm, "notes-pin-page-deleted");

    await pane.getByRole("button", { name: "Done" }).click();
    await pane.waitFor({ state: "detached" });
    const saved = await waitFor("the label saved on the DM-only pin", () => (dmSocket.state?.pins[run.pinId]?.label === "Well of echoes" ? dmSocket.state.pins[run.pinId] : null));
    assert.equal(saved.visibility, "dm");
    assert.equal(saved.pageId, undefined);
    await waitFor("the pin gone from the player", () => (playerSocket.state?.pins[run.pinId] ? null : true));
    assert.equal(playerSocket.everSaw("Well of echoes"), false, "the player received the DM-only pin's label");
  });

  test("5. Back from a page the player had not read returns focus to its row, which no longer says New (DATA-01)", async () => {
    const pageId = randomUUID();
    await otherDevice!.send({ t: "journal.create", page: { id: pageId, title: "Town crier", access: "all", blocks: [{ id: "crierblock01", text: "The ferry is shut until the flood goes down." }] } });
    await waitFor("the new page for the player", () => playerSocket.state?.journal[pageId] ?? null);
    await openPhonePanel(player, "Journal");
    const row = player.getByRole("button", { name: /^Town crier/ });
    await row.getByText("New", { exact: true }).waitFor();

    const f = await openAndBack(player, row);
    assert.deepEqual([f.tag, f.opener, f.name], ["button", `journal-${pageId}`, "Town crier"], "focus is on the page's row, its New tag gone");
    await shots.take(player, "notes-back-to-read-row");
  });

  test("6. of two pages with one title, Back returns focus to the one the player opened (DATA-01)", async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      await otherDevice!.send({ t: "journal.create", page: { id, title: "Rumors", access: "all", blocks: [{ id: `rumorblock0${i}`, text: `Rumor number ${i + 1}.` }] } });
    }
    await waitFor("both pages for the player", () => ids.every((id) => playerSocket.state?.journal[id]) || null);
    const rows = player.getByRole("button", { name: /^Rumors/ });
    await rows.nth(1).waitFor();

    let f = await openAndBack(player, rows.nth(0));
    assert.equal(await hasFocus(rows.nth(0)), true, `the first row has focus, not ${f.opener ?? `<${f.tag}> ${f.name}`}`);
    // Only the second still says New now. Found by name and place, Back from it went to the first, since both read "Rumors" once it is read.
    await rows.nth(1).getByText("New", { exact: true }).waitFor();
    f = await openAndBack(player, rows.nth(1));
    assert.equal(await hasFocus(rows.nth(1)), true, `the second row has focus, not ${f.opener ?? `<${f.tag}> ${f.name}`}`);
    assert.ok(ids.some((id) => f.opener === `journal-${id}`), "it carries its page's id");
  });

  test("7. Back from a page the DM renamed returns focus to its row under the new title, moved in the list (DATA-01)", async () => {
    const pageId = randomUUID();
    await otherDevice!.send({ t: "journal.create", page: { id: pageId, title: "Ferry toll", access: "dm", blocks: [] } });
    await waitFor("the page in the DM's state", () => dmSocket.state?.journal[pageId] ?? null);
    await openSideTab(dm, "Journal");
    // Where a row stands in the Journal, by the start of its text.
    const place = async (title: string) => (await dm.getByRole("tabpanel").getByRole("button").evaluateAll((els) => els.map((el) => el.textContent ?? ""))).findIndex((text) => text.startsWith(title));
    const row = dm.getByRole("button", { name: /^Ferry toll/ });
    await row.waitFor();
    assert.ok((await place("Ferry toll")) < (await place("Rumors")), "Ferry toll comes before the Rumors");

    await row.focus();
    await dm.keyboard.press("Enter");
    await dm.getByRole("heading", { name: "Ferry toll", exact: true }).waitFor();
    await dm.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = dm.getByRole("dialog", { name: "Edit Ferry toll" });
    await editor.getByLabel("Title", { exact: true }).fill("Toll at the ferry");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await dm.getByRole("heading", { name: "Toll at the ferry", exact: true }).waitFor();

    const back = dm.getByRole("button", { name: "Back to Journal" });
    await back.focus();
    await dm.keyboard.press("Enter");
    await back.waitFor({ state: "detached" });
    const f = await focusedOn(dm);
    assert.ok(f.tag === "button" && f.name.startsWith("Toll at the ferry"), `the renamed row has focus, not <${f.tag}> ${f.name}`);
    assert.equal(f.opener, `journal-${pageId}`, "it carries its page's id");
    assert.ok((await place("Toll at the ferry")) > (await place("Rumors")), "the rename moved the row past the Rumors");
    await shots.take(dm, "notes-back-to-renamed-row");
  });

  test("8. on a computer, a page deleted from inside it gives focus to the Journal tab, not the page body (DATA-01)", async () => {
    const pageId = randomUUID();
    await otherDevice!.send({ t: "journal.create", page: { id: pageId, title: "Lost letter", access: "dm", blocks: [] } });
    await waitFor("the page in the DM's state", () => dmSocket.state?.journal[pageId] ?? null);
    await openSideTab(dm, "Journal");
    await dm.getByRole("button", { name: /^Lost letter/ }).focus();
    await dm.keyboard.press("Enter");
    await dm.getByRole("heading", { name: "Lost letter", exact: true }).waitFor();
    await dm.getByRole("button", { name: "Delete page" }).click();
    await dm.getByRole("button", { name: "Delete the page?" }).click();
    await dm.getByRole("button", { name: "Back to Journal" }).waitFor({ state: "detached" });
    await waitFor("the page gone from the DM's state", () => (dmSocket.state?.journal[pageId] ? null : true));
    const f = await focusedOn(dm);
    assert.equal(f.role, "tab", `focus is on a tab, not <${f.tag}>`);
    assert.match(f.name, JOURNAL_TAB);
  });

  test("9. no page logged an error or a warning", () => {
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
