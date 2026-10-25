import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, sleep, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Deleting characters (features section 15), on the real server serving
 * the production build. Pat on a phone deletes Bree, whom Pat plays alone,
 * with a token on the map, another on a scene Pat cannot see, a companion
 * and a row in the fight:
 * - Pat reads what goes with it first, and a screen reader hears the same
 *   as the button's description.
 * - The button is busy while the delete waits, offline for longer than a
 *   frame-by-frame focus hand-off would wait, and focus still moves on.
 * - The DM's view loses all of it, the open token panel included, and the
 *   DM's log says who deleted what.
 * A character Pat shares says why it has no Delete, and another player's
 * offers none. A delete the server refuses, since the DM shared the
 * character meanwhile, keeps focus on its row. Focus Pat moved elsewhere
 * stays there. The DM's own delete is busy and then moves focus on too.
 * 80-character names, spaced and unbroken, fit the page at 327, 356 and
 * 243 px.
 *
 * A character's row opens its page, a subpage of the panel named by the
 * character with Back to Characters (docs/design-v1-look-pass.md 3.1):
 * focus goes to its title and Back brings it to the row. Rue, who plays
 * one character, lands on its page, which scrolls nowhere sideways at 320
 * px or at 130%. New character, Add a companion and the stat blocks page
 * stay open with what was typed when the window turns across 900 px.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twelve, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 12;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-characters-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let quinContext: BrowserContext;
let rueContext: BrowserContext;
let rue: Page;
let dm: Page;
let pat: Page;
let dmCdp: CDPSession;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");
const rueConsole = new ConsoleWatch("rue");

/** Two names at the 80-character limit: one with spaces to wrap at, and one word with none. */
const SPACED = "Sir Aldric Brightwater of the Northern Marches, Warden of the Old Oak and Stones";
const UNBROKEN = "Brightwaterhollow".repeat(5).slice(0, 80);
/** A shared character with an unbroken 80-character name: its card explains why it has no Delete. */
const SHARED_LONG = "Stonemarrowdeep".repeat(6).slice(0, 80);

const run = {
  roomId: "",
  roomName: `E2E characters ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  roadId: randomUUID(),
  bounds: { w: 30, h: 20 },
  patId: "",
  quinId: "",
  bree: randomUUID(),
  breeToken: randomUUID(),
  breeOnTheRoad: randomUUID(),
  wisp: randomUUID(),
  cyra: randomUUID(),
  cyraToken: randomUUID(),
  dax: randomUUID(),
  wren: randomUUID(),
  zed: randomUUID(),
  spaced: randomUUID(),
  unbroken: randomUUID(),
  sharedLong: randomUUID(),
  rueId: "",
  yew: randomUUID(),
  goblin: randomUUID(),
};

const WARNING = "Deleting Bree also removes its token here, 1 companion and its place in the fight, and any other token, companion or place in the fight it has. This cannot be undone.";

const PHONE = { width: 390, height: 844, scale: 1 };
const DESK = { width: 1280, height: 800, scale: 1 };
const VERY_SHORT = { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 };

function actor(hp: number) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 1,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Sets the window, the safe areas and the interface size, then loads the room again. */
async function setUp(page: Page, cdp: CDPSession, view: { width: number; height: number; scale: number; side?: number; bottom?: number }): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: view.bottom ?? 0, left: view.side ?? 0, right: view.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** The Characters panel: the side panel's tab or More's item where there is a side panel, else a sheet from the tool bar's Panels list. */
async function openCharacters(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.first().isVisible())) {
    await openSideTab(page, "Characters");
    return page.getByRole("tabpanel", { name: "Characters" });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** The open page's own heading, the character's name under the panel's header (CreatureHeader.tsx). */
const pageHeading = (panel: Locator) => panel.locator("[data-creature-heading]");

/** Opens a character's page from its row, unless it is open: from another character's page, Back to Characters first. */
async function openCard(panel: Locator, characterId: string): Promise<void> {
  const name = dmSocket.state!.characters[characterId]!.name;
  const heading = pageHeading(panel);
  if ((await heading.count()) > 0 && (await heading.textContent()) === name) return;
  const back = panel.page().getByRole("button", { name: "Back to Characters" });
  if (await back.isVisible()) await back.click();
  await panel.locator(`[data-opener="character:${characterId}"]`).click();
  await heading.filter({ hasText: name }).waitFor();
}

/** Back from a page to the panel's list. */
async function backToList(panel: Locator): Promise<void> {
  await panel.page().getByRole("button", { name: "Back to Characters" }).click();
  await panel.page().getByRole("button", { name: "Back to Characters" }).waitFor({ state: "detached" });
}

/** What has focus: its tag, the `data-opener` id it carries, and its name or text. */
function focusedOn(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: { tagName: string; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
    if (!a) return "none";
    return `${a.tagName.toLowerCase()} [${a.getAttribute("data-opener") ?? ""}] ${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim()}`;
  });
}

async function focusLands(page: Page, characterId: string, what: string): Promise<void> {
  await focusStartsWith(page, `button [character:${characterId}]`, what);
}

async function focusStartsWith(page: Page, on: string, what: string): Promise<void> {
  await waitFor(what, async () => ((await focusedOn(page)).startsWith(on) ? true : null), 5_000).catch(async () => assert.fail(`${what}: focus is on "${await focusedOn(page)}"`));
}

/** Nothing in the panel runs out of its box sideways: a scroller that scrolls sideways, or a box its content spills out of. Text fields scroll their own text. */
async function noSideScroll(panel: Locator, where: string): Promise<void> {
  const wide = await panel.evaluate((root) => {
    type El = { scrollWidth: number; clientWidth: number; tagName: string; textContent: string | null; ownerDocument: { defaultView: { getComputedStyle(e: unknown): { overflowX: string } } } };
    const all = [root as unknown as El, ...(Array.from((root as unknown as { querySelectorAll(s: string): ArrayLike<unknown> }).querySelectorAll("*")) as El[])];
    return all
      .filter((el) => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1 && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")
      .filter((el) => el === (root as unknown) || el.ownerDocument.defaultView.getComputedStyle(el).overflowX !== "hidden")
      .map((el) => `${el.tagName} ${(el.textContent ?? "").slice(0, 30)}: ${el.scrollWidth} > ${el.clientWidth}`);
  });
  assert.deepEqual(wide, [], `${where}: content wider than its box`);
}

/** The accessible description Chrome gives the button of this exact name, from its accessibility tree. */
async function description(cdp: CDPSession, name: string): Promise<string | null> {
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { role?: { value: string }; name?: { value: string }; description?: { value: string } }[] };
  const node = nodes.find((n) => n.role?.value === "button" && n.name?.value === name);
  return node ? (node.description?.value ?? "").replace(/\s+/g, " ").trim() : null;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

async function boxOf(target: Locator): Promise<Box> {
  const b = await target.boundingBox();
  assert.ok(b, "not on the page");
  return { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height, width: b.width, height: b.height };
}

/** A shared character's page at this width: the note saying why there is no Delete stays inside the panel, its long name broken. */
async function sharedNoteFits(page: Page, panel: Locator, where: string): Promise<void> {
  await openCard(panel, run.sharedLong);
  const note = panel.getByText(`You and Quin both play ${SHARED_LONG}`);
  await note.scrollIntoViewIfNeeded();
  const frame = await boxOf(panel);
  const b = await boxOf(note);
  assert.ok(b.left >= frame.left - 0.5 && b.right <= frame.right + 0.5, `${where}: the shared note runs out of the ${Math.round(frame.width)} px panel (${Math.round(b.left)} to ${Math.round(b.right)})`);
  const spills = await note.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (el as unknown as { clientWidth: number }).clientWidth + 1);
  assert.equal(spills, false, `${where}: the shared note's text spills out of its box`);
  await shots.take(page, `characters-shared-long-name-${where.replace(/[^a-z0-9]+/gi, "-")}`);
}

/** A long name's page in a panel this wide: Delete and its line inside the panel, nothing scrolling sideways, the name whole. */
async function longNameFits(page: Page, panel: Locator, characterId: string, name: string, where: string): Promise<void> {
  await openCard(panel, characterId);
  const button = panel.getByRole("button", { name: `Delete ${name}`, exact: true });
  await button.scrollIntoViewIfNeeded();
  const line = panel.getByText(`Deleting ${name} also removes`);
  const frame = await boxOf(panel);
  for (const [what, target] of [
    ["Delete", button],
    ["its line", line],
  ] as const) {
    const b = await boxOf(target);
    assert.ok(b.left >= frame.left - 0.5 && b.right <= frame.right + 0.5, `${where}: ${what} runs out of the ${Math.round(frame.width)} px panel (${Math.round(b.left)} to ${Math.round(b.right)})`);
  }
  // The label wraps inside the button: its text takes more than one line.
  const lines = await button.evaluate((el) => {
    const doc = (el as unknown as { ownerDocument: { createRange(): { selectNodeContents(n: unknown): void; getClientRects(): ArrayLike<{ top: number }> } } }).ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
  });
  assert.ok(lines > 1, `${where}: the long name wraps inside Delete, ${lines} line`);
  // Content wider than its box: a scroller that scrolls sideways, or a box its content spills out of. A name cut with an
  // ellipsis is neither, and neither is a text field, which scrolls its own text.
  const wide = await panel.evaluate((root) => {
    type El = { scrollWidth: number; clientWidth: number; tagName: string; textContent: string | null; ownerDocument: { defaultView: { getComputedStyle(e: unknown): { overflowX: string } } } };
    const all = [root as unknown as El, ...(Array.from((root as unknown as { querySelectorAll(s: string): ArrayLike<unknown> }).querySelectorAll("*")) as El[])];
    return all
      .filter((el) => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1 && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")
      .filter((el) => el === (root as unknown) || el.ownerDocument.defaultView.getComputedStyle(el).overflowX !== "hidden")
      .map((el) => `${el.tagName} ${(el.textContent ?? "").slice(0, 30)}: ${el.scrollWidth} > ${el.clientWidth}`);
  });
  assert.deepEqual(wide, [], `${where}: content wider than its box`);
  await shots.take(page, `characters-long-name-${where.replace(/[^a-z0-9]+/gi, "-")}`);
}

describe("raccoon-vtt: deleting characters", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    quinContext = await browser.newContext();
    rueContext = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    dmCdp = await dmContext.newCDPSession(dm);
    patCdp = await patContext.newCDPSession(pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
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

  test("1. a DM's room with Pat's Bree on two scenes with a companion and in the fight, Cyra whom Pat shares with Quin, Quin's Dax, and four more of Pat's", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    const password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    const join = async (context: BrowserContext, name: string, color: string) => {
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      return ((await done.json()) as { member: { id: string } }).member.id;
    };
    run.patId = await join(patContext, "Pat", "#30a46c");
    run.quinId = await join(quinContext, "Quin", "#e5484d");
    run.rueId = await join(rueContext, "Rue", "#8e4ec6");

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.create", scene: { id: run.roadId, name: "The road", bounds: { w: 30, h: 20 } } });
    const character = (id: string, name: string, ownerIds: string[]) => ops.send({ t: "character.create", character: { id, name, size: "medium", ownerIds, actor: actor(24) } });
    await character(run.bree, "Bree", [run.patId]);
    await character(run.cyra, "Cyra", [run.patId, run.quinId]);
    await character(run.dax, "Dax", [run.quinId]);
    await character(run.wren, "Wren", [run.patId]);
    await character(run.zed, "Zed", [run.patId]);
    await character(run.spaced, SPACED, [run.patId]);
    await character(run.unbroken, UNBROKEN, [run.patId]);
    await character(run.sharedLong, SHARED_LONG, [run.patId, run.quinId]);
    await character(run.yew, "Yew", [run.rueId]);
    const token = (id: string, extra: Record<string, unknown>) => ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await token(run.breeToken, { kind: "pc", name: "Bree", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree } });
    await token(run.breeOnTheRoad, { kind: "pc", name: "Bree", sceneId: run.roadId, x: 4, y: 4, disposition: "ally", actor: { ref: run.bree } });
    await token(run.wisp, { kind: "npc", name: "Wisp", x: 6, y: 5, size: "small", disposition: "ally", actor: { inline: actor(8) }, companion: { of: run.bree, turn: "shared" } });
    await token(run.cyraToken, { kind: "pc", name: "Cyra", x: 9, y: 5, disposition: "ally", actor: { ref: run.cyra } });
    await token(run.goblin, { kind: "monster", name: "Goblin", x: 14, y: 5, disposition: "hostile", actor: { inline: actor(7) } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: "e-bree", tokenId: run.breeToken, value: 18 },
        { id: "e-cyra", tokenId: run.cyraToken, value: 12 },
        { id: "e-gob", tokenId: run.goblin, value: 8 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await waitFor("the fight in the DM's view, Bree acting", () => (dmSocket.state?.encounter?.activeEntryId === "e-bree" ? true : null));

    // A new device is answered 403 by GET /me before it joins, which Chrome logs. Pat joined by request, so this is only in case.
    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("2. Bree's page says what goes before Delete, which a screen reader hears as Delete's description in both states; Cyra's says why it has none, and Quin's Dax offers nothing", async () => {
    const sheet = await openCharacters(pat);
    await openCard(sheet, run.bree);
    await sheet.getByText(WARNING, { exact: true }).waitFor();
    const remove = sheet.getByRole("button", { name: "Delete Bree", exact: true });
    assert.equal(await description(patCdp, "Delete Bree"), WARNING, "Delete's description");
    await shots.take(pat, "characters-player-delete-warning");
    await remove.tap();
    await sheet.getByRole("button", { name: "Tap again to delete", exact: true }).waitFor();
    assert.equal(await description(patCdp, "Tap again to delete"), WARNING, "the armed button's description");
    // Left alone, the button disarms after four seconds.
    await sheet.getByRole("button", { name: "Delete Bree", exact: true }).waitFor({ timeout: 8_000 });

    await openCard(sheet, run.cyra);
    await sheet.getByText(WARNING, { exact: true }).waitFor({ state: "detached" });
    await sheet.getByText("You and Quin both play Cyra, so only the DM can delete it.", { exact: true }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: /^Delete/ }).count(), 0, "a character Pat shares offers no Delete");
    await shots.take(pat, "characters-player-shared-no-delete");
    // Quin's Dax is in the party list, a row with nothing to press.
    await backToList(sheet);
    await sheet.getByText("Dax", { exact: true }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: /Dax/ }).count(), 0, "another player's character offers nothing");
    assert.equal(patSocket.everSaw(run.breeOnTheRoad), false, "the token on the road never reached Pat");
  });

  test("3. 80-character names, spaced and unbroken, keep Delete and its line inside the page at 356 and 243 px", async () => {
    let sheet = await openCharacters(pat);
    await longNameFits(pat, sheet, run.spaced, SPACED, "356 px spaced");
    await longNameFits(pat, sheet, run.unbroken, UNBROKEN, "356 px unbroken");
    await sharedNoteFits(pat, sheet, "356 px");
    await setUp(pat, patCdp, VERY_SHORT);
    sheet = await openCharacters(pat);
    await longNameFits(pat, sheet, run.spaced, SPACED, "243 px spaced");
    await longNameFits(pat, sheet, run.unbroken, UNBROKEN, "243 px unbroken");
    await sharedNoteFits(pat, sheet, "243 px");
    await setUp(pat, patCdp, PHONE);
  });

  test("4. offline for longer than a frame-by-frame hand-off waits, the delete stays busy; once answered it takes every token, the companion and the row, the DM's panel lets go, the DM's log says so, and focus moves on", async () => {
    // The DM has Bree's token open in its panel.
    await tapCell(dm, run.bounds, { x: 5, y: 5 });
    await dm.getByRole("dialog", { name: "Bree actions" }).getByRole("button", { name: "Details", exact: true }).click();
    const panel = dm.getByRole("tabpanel", { name: "Token" });
    await panel.getByRole("heading", { name: "Bree" }).waitFor();

    const sheet = await openCharacters(pat);
    await openCard(sheet, run.bree);
    await sheet.getByRole("button", { name: "Delete Bree", exact: true }).tap();
    const confirm = sheet.getByRole("button", { name: "Tap again to delete", exact: true });
    await confirm.waitFor();
    await shots.take(pat, "characters-player-delete-armed");

    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    await confirm.tap();
    const busy = sheet.getByRole("button", { name: "Deleting…", exact: true });
    await busy.waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    assert.equal(await description(patCdp, "Deleting…"), WARNING, "the busy button keeps its description");
    await shots.take(pat, "characters-player-delete-busy");
    // Past lib/handFocus.ts's 10 s wait, which this hand-off must not depend on.
    await sleep(11_000);
    assert.ok(await busy.isVisible(), "still busy while offline");
    assert.ok(dmSocket.state!.characters[run.bree], "nothing went while Pat was offline");
    await patContext.setOffline(false);

    await waitFor("Bree gone for the DM", () => (dmSocket.state && !dmSocket.state.characters[run.bree] ? true : null), 30_000);
    const state = dmSocket.state!;
    for (const id of [run.breeToken, run.breeOnTheRoad, run.wisp]) assert.equal(state.tokens[id], undefined, `token ${id} went with Bree`);
    assert.deepEqual(
      state.encounter?.entries.map((e) => e.id),
      ["e-cyra", "e-gob"],
    );
    assert.equal(state.encounter?.activeEntryId, "e-cyra", "the turn passed on");
    await panel.getByText("Tap a token to see it here.").waitFor();
    // Bree's page went with Bree, back to the list. Pat's list in order: Bree, the unbroken long name, Cyra, ... So the next row is the long name's.
    await focusLands(pat, run.unbroken, "focus on the next row after the late answer");
    assert.equal(await pat.getByRole("button", { name: "Back to Characters" }).count(), 0, "the page went with Bree");
    await shots.take(pat, "characters-player-after-delete");

    // The DM's log, and no player's, says who deleted what.
    const said = "Pat deleted Bree, with 2 tokens, 1 companion and its place in the fight.";
    assert.ok(state.log.some((e) => e.data?.type === "characterDeleted"), "the DM's log holds the line");
    // The Log is in More since Dice joined the row (docs/design-v1-dice.md 8.1).
    await openSideTab(dm, "Log");
    await dm.getByRole("tabpanel", { name: sideTabName("Log") }).getByText(said, { exact: true }).waitFor();
    await shots.take(dm, "characters-dm-log-player-delete");
    assert.equal(patSocket.everSaw("characterDeleted"), false, "the line never reached Pat");
    patConsole.expectSocketFailures = false;
  });

  test("5. a delete the server refuses, since the DM shared the character meanwhile, leaves the page open with focus on its heading, and says why", async () => {
    const sheet = await openCharacters(pat);
    await openCard(sheet, run.wren);
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    await sheet.getByRole("button", { name: "Delete Wren", exact: true }).tap();
    await sheet.getByRole("button", { name: "Tap again to delete", exact: true }).tap();
    await sheet.getByRole("button", { name: "Deleting…", exact: true }).waitFor();
    await ops.send({ t: "character.update", characterId: run.wren, patch: { ownerIds: [run.patId, run.quinId] } });
    await patContext.setOffline(false);
    await pat.locator("[data-toast]").getByText("Someone else plays that character too. Ask the DM to delete it.", { exact: true }).waitFor({ timeout: 30_000 });
    await focusStartsWith(pat, "h3 [] Wren", "focus on Wren's heading after the refusal");
    await sheet.getByText("You and Quin both play Wren, so only the DM can delete it.", { exact: true }).waitFor();
    assert.ok(dmSocket.state!.characters[run.wren], "Wren stays");
    await shots.take(pat, "characters-player-delete-refused");
    patConsole.expectSocketFailures = false;
  });

  test("6. focus Pat moves out of the sheet while the delete waits stays there", async () => {
    const sheet = await openCharacters(pat);
    await openCard(sheet, run.zed);
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    await sheet.getByRole("button", { name: "Delete Zed", exact: true }).tap();
    await sheet.getByRole("button", { name: "Tap again to delete", exact: true }).tap();
    await sheet.getByRole("button", { name: "Deleting…", exact: true }).waitFor();
    // Zed's row is the last, so the hand-off would go to the one before, Wren's. The tool bar's Panels is outside the sheet.
    const panels = pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ });
    await panels.focus();
    await patContext.setOffline(false);
    await waitFor("Zed gone for the DM", () => (dmSocket.state && !dmSocket.state.characters[run.zed] ? true : null), 30_000);
    await sheet.locator("[data-creature-heading]").filter({ hasText: "Zed" }).waitFor({ state: "detached" });
    await sleep(300);
    assert.equal(await panels.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, `focus stays on Panels, not "${await focusedOn(pat)}"`);
    patConsole.expectSocketFailures = false;
  });

  test("7. the DM's own delete: the line as Delete's description, busy while it waits, then focus on the next character; long names fit at 327 px", async () => {
    await dm.keyboard.press("Escape");
    const panel = await openCharacters(dm);
    await longNameFits(dm, panel, run.spaced, SPACED, "327 px spaced");
    await longNameFits(dm, panel, run.unbroken, UNBROKEN, "327 px unbroken");

    await openCard(panel, run.dax);
    const remove = panel.getByRole("button", { name: "Delete Dax", exact: true });
    const said = await description(dmCdp, "Delete Dax");
    assert.ok(said?.startsWith("Deleting Dax also removes") && !said.includes("cannot be undone"), `the DM's description: ${said}`);
    dmConsole.expectSocketFailures = true;
    await dmContext.setOffline(true);
    await remove.focus();
    await dm.keyboard.press("Enter");
    await dm.keyboard.press("Enter");
    const busy = panel.getByRole("button", { name: "Deleting…", exact: true });
    await busy.waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    await shots.take(dm, "characters-dm-delete-busy");
    await dmContext.setOffline(false);
    await waitFor("Dax gone", () => (dmSocket.state && !dmSocket.state.characters[run.dax] ? true : null), 30_000);
    // The DM's list in order: Cyra, Dax, the spaced long name, ...
    await focusLands(dm, run.spaced, "the DM's focus on the next character");
    await shots.take(dm, "characters-dm-after-delete");
    dmConsole.expectSocketFailures = false;
  });

  test("lp1-page-a. the DM's row opens the character's page under the panel's header, focus on its title, and Back brings focus to the row", async () => {
    const panel = await openCharacters(dm);
    const row = panel.locator(`[data-opener="character:${run.cyra}"]`);
    assert.equal(await row.getAttribute("aria-expanded"), null, "a row that opens a page is no disclosure");
    await row.focus();
    await dm.keyboard.press("Enter");
    await pageHeading(panel).filter({ hasText: "Cyra" }).waitFor();
    await focusStartsWith(dm, "h2 [] Cyra", "focus on the page's title");
    // The page names what it is, and holds nothing of a token on a map.
    await panel.getByText("Character · Medium (5 ft)", { exact: true }).waitFor();
    for (const name of ["Stat block", "Combat", "Companions", "Notes", "Image", "Stats", "Played by"]) await panel.getByRole("button", { name, exact: true }).waitFor();
    for (const name of ["Position", "Token settings"]) assert.equal(await panel.getByRole("button", { name, exact: true }).count(), 0, `${name} is a token's`);
    await shots.take(dm, "characters-lp1-dm-page");
    await dm.getByRole("button", { name: "Back to Characters" }).click();
    await focusLands(dm, run.cyra, "Back brings focus to Cyra's row");
  });

  test("lp1-page-b. Rue, who plays one character, lands on its page, which scrolls nowhere sideways at 320 px or at 130%, and Back shows the list", async () => {
    rueConsole.attach((rue = await rueContext.newPage()));
    const cdp = await rueContext.newCDPSession(rue);
    // On the app's origin first, where setUp keeps the interface size.
    await rue.goto(`${server.origin}/`);
    // As for Pat: a new device is answered 403 by GET /me before it joins, which Chrome logs. Rue joined by request, so this is only in case.
    rueConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    for (const view of [{ width: 320, height: 568, scale: 1 }, { width: 390, height: 844, scale: 1.3 }]) {
      const where = `${view.width} px at ${Math.round(view.scale * 100)}%`;
      await setUp(rue, cdp, view);
      rueConsole.allow = [];
      const sheet = await openCharacters(rue);
      await rue.getByRole("button", { name: "Back to Characters" }).waitFor();
      await pageHeading(sheet).filter({ hasText: "Yew" }).waitFor();
      await noSideScroll(sheet, where);
      await shots.take(rue, `characters-lp1-landed-${view.width}-${Math.round(view.scale * 100)}`);
    }
    const sheet = await openCharacters(rue);
    await backToList(sheet);
    await sheet.locator(`[data-opener="character:${run.yew}"]`).waitFor();
    await sheet.getByRole("heading", { name: "The party" }).waitFor();
    // No row was pressed to open the page Rue landed on, so Back finds Yew's row by the page's header.
    await focusLands(rue, run.yew, "Back brings focus to Yew's row");
    await noSideScroll(sheet, "the list at 130%");
  });

  test("lp1-page-c. New character counts a number still being typed: Back and Cancel pressed without moving focus ask first, a number changed after they ask takes the question back, and the second press leaves", async () => {
    const panel = await openCharacters(dm);
    const back = dm.getByRole("button", { name: "Back to Characters" });
    if (await back.isVisible()) await backToList(panel);
    await panel.locator('[data-opener="new-character"]').click();
    await dm.getByRole("heading", { name: "New character" }).waitFor();
    const hp = panel.getByRole("textbox", { name: "Max HP", exact: true });
    const asks = dm.getByRole("button", { name: "Discard changes?" });
    // A click sent to the button alone takes no focus, as a press may not: the field keeps it, and its number is not yet committed.
    await hp.fill("20");
    await back.dispatchEvent("click");
    await asks.first().waitFor();
    assert.equal(await asks.count(), 2, "Back and Cancel both ask");
    await focusStartsWith(dm, "input [] Max HP", "the field kept focus");
    await hp.fill("30");
    await back.waitFor();
    assert.equal(await asks.count(), 0, "a number changed after the question takes it back");
    await panel.getByRole("button", { name: "Cancel", exact: true }).dispatchEvent("click");
    await asks.first().waitFor();
    await asks.first().dispatchEvent("click");
    await panel.locator('[data-opener="new-character"]').waitFor();
    assert.equal(await dm.getByRole("heading", { name: "New character" }).count(), 0, "the second press left");
  });

  test("lp10-a. a tablet turned across 900 px keeps New character, Add a companion and the stat blocks page, with what was typed, a number still being typed included", async () => {
    const TABLET = { width: 820, height: 1180 };
    /** Turns the DM's window across 900 px and back, so the panel moves from the side panel to a sheet and back, and checks each time. */
    const turn = async (check: (panel: Locator, where: string) => Promise<void>) => {
      for (const [size, where] of [[TABLET, "upright at 820"], [DESK, "back at 1280"]] as const) {
        await dm.setViewportSize({ width: size.width, height: size.height });
        // The panel stays open across the turn, as a sheet below 900 px and in the side panel above.
        const shown = size.width < 900 ? dm.locator('dialog[data-rvtt-sheet][aria-label="Characters"]') : dm.getByRole("tabpanel", { name: "Characters" });
        await shown.waitFor();
        await check(shown, where);
      }
    };
    const value = async (panel: Locator, name: string) => panel.getByRole("textbox", { name, exact: true }).inputValue();

    let panel = await openCharacters(dm);
    if (await dm.getByRole("button", { name: "Back to Characters" }).isVisible()) await backToList(panel);
    await panel.locator('[data-opener="new-character"]').click();
    await dm.getByRole("heading", { name: "New character" }).waitFor();
    await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Ilsa");
    await panel.getByRole("textbox", { name: "Armor Class", exact: true }).fill("15");
    // Max HP keeps focus, so its number is still being typed when the window turns.
    await panel.getByRole("textbox", { name: "Max HP", exact: true }).fill("31");
    let typed = ["Ilsa", "15", "31"];
    await turn(async (p, where) => {
      await dm.getByRole("heading", { name: "New character" }).waitFor();
      assert.deepEqual([await value(p, "Name"), await value(p, "Armor Class"), await value(p, "Max HP")], typed, `New character ${where}`);
      // A change made on the tablet comes back on the computer too.
      await p.getByRole("textbox", { name: "Max HP", exact: true }).fill("32");
      typed = ["Ilsa", "15", "32"];
    });
    // What was typed before the turn still asks before it goes.
    await dm.getByRole("button", { name: "Back to Characters" }).click();
    await dm.getByRole("button", { name: "Discard changes?" }).first().click();
    await dm.getByRole("heading", { name: "New character" }).waitFor({ state: "detached" });

    panel = await openCharacters(dm);
    await openCard(panel, run.cyra);
    await panel.getByRole("button", { name: "Add a companion" }).click();
    await dm.getByRole("heading", { name: "Add a companion for Cyra" }).waitFor();
    await panel.getByRole("textbox", { name: "Name", exact: true }).fill("Pip");
    await panel.getByRole("textbox", { name: "HP", exact: true }).fill("9");
    await turn(async (p, where) => {
      await dm.getByRole("heading", { name: "Add a companion for Cyra" }).waitFor();
      assert.deepEqual([await value(p, "Name"), await value(p, "HP")], ["Pip", "9"], `Add a companion ${where}`);
    });
    await dm.getByRole("button", { name: "Back to Cyra" }).click();
    await dm.getByRole("button", { name: "Discard changes?" }).first().click();
    await dm.getByRole("heading", { name: "Add a companion for Cyra" }).waitFor({ state: "detached" });

    panel = await openCharacters(dm);
    await panel.getByRole("button", { name: /^Stat blocks \(/ }).click();
    const blocks = dm.getByRole("heading", { name: /^Cyra.s stat blocks$/ });
    await blocks.waitFor();
    await turn(async () => {
      await blocks.waitFor();
    });
    await dm.getByRole("button", { name: "Back to Cyra" }).click();
    await blocks.waitFor({ state: "detached" });
  });

  test("s2-ch-a. Cyra's page in the fight: Combat runs Hit Points, Conditions, Uses with what it is for and Add, Reaction and Rest, for the DM and for Pat, whose Reaction used reaches the row and the folded summary; it lines up at 320 x 568 and 390 x 844 at 130% and 1280 x 800 (docs/design-v1-token-sections.md 3)", async () => {
    if (!dmSocket.state?.encounter?.entries.some((e) => e.tokenId === run.cyraToken)) {
      await ops.send({ t: "encounter.start", entries: [{ id: "e-cyra-s2", tokenId: run.cyraToken, value: 12 }] });
    }
    const entry = await waitFor("Cyra's row", () => dmSocket.state?.encounter?.entries.find((e) => e.tokenId === run.cyraToken));
    const sectionIn = (scope: Locator, heading: string) => scope.locator(`xpath=.//section[*[self::h3 or self::h4][normalize-space()="${heading}"] or *[not(self::section)]/*[self::h3 or self::h4][normalize-space()="${heading}"]]`);
    const combat = (scope: Locator) => scope.locator("[data-panel-group]").filter({ has: scope.page().getByRole("button", { name: "Combat", exact: true }) });
    const sections = (scope: Locator) => combat(scope).evaluate((el) => Array.from((el as unknown as { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> }).querySelectorAll("h4")).map((h) => (h.textContent ?? "").trim()));
    const open = async (scope: Locator) => {
      const fold = scope.getByRole("button", { name: "Combat", exact: true });
      if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
    };
    const { alignmentLines, measureAlignment } = await import("./helpers/alignment.ts");
    const off: string[] = [];
    const heights: string[] = [];
    try {
      for (const page of [dm, pat]) {
        const panel = await openCharacters(page);
        await openCard(panel, run.cyra);
        await open(panel);
        assert.deepEqual(await sections(panel), ["Hit Points", "Conditions", "Uses", "Reaction", "Rest"], page === dm ? "the DM" : "Pat");
        const uses = sectionIn(panel, "Uses");
        await uses.getByText("Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level, typed, or brought in with Re-sync from D&D Beyond.", { exact: true }).waitFor();
        await uses.getByRole("button", { name: "Add a class resource" }).waitFor();
        assert.equal(await panel.getByRole("heading", { name: "Class resources" }).count(), 0);
        await shots.take(page, `s2-ch-cyra-combat-${page === dm ? "dm" : "pat"}`);
      }
      const panel = await openCharacters(pat);
      const reaction = sectionIn(panel, "Reaction");
      await reaction.getByText("Clears at the start of your turn", { exact: true }).waitFor();
      await reaction.getByRole("switch", { name: /^Reaction used/ }).click();
      await waitFor("Cyra's row's Reaction used", () => (dmSocket.state?.encounter?.entries.find((e) => e.id === entry.id)?.reactionUsed ? true : null));
      await panel.getByRole("button", { name: "Combat", exact: true }).click();
      const summary = await panel.getByRole("button", { name: "Combat", exact: true }).innerText();
      assert.match(summary.replace(/\s+/g, " "), /^Combat HP \d+\/\d+ · Reaction used$/);
      await panel.getByRole("button", { name: "Combat", exact: true }).click();
      for (const view of [{ width: 320, height: 568, scale: 1.3 }, { width: 390, height: 844, scale: 1.3 }, DESK]) {
        const at = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        await setUp(pat, patCdp, view);
        const page = await openCharacters(pat);
        await openCard(page, run.cyra);
        await open(page);
        await sectionIn(page, "Reaction").waitFor();
        const box = combat(page);
        await box.scrollIntoViewIfNeeded();
        heights.push(`${at}: Cyra's Combat ${Math.round((await box.boundingBox())!.height)} px`);
        off.push(...alignmentLines(await measureAlignment(box), `Cyra's page Combat at ${at}`));
        await shots.take(pat, `s2-ch-cyra-page-${view.width}-${Math.round(view.scale * 100)}`);
      }
    } finally {
      await setUp(pat, patCdp, PHONE);
      await ops.send({ t: "encounter.update", entryId: entry.id, patch: { reactionUsed: false } });
    }
    console.log(`s2-ch heights:\n${heights.join("\n")}`);
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("8. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(patConsole.errors, [], "Pat's page logged errors");
    assert.deepEqual(rueConsole.errors, [], "Rue's page logged errors");
  });
});
