import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sleep, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

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
 * 80-character names, spaced and unbroken, fit the card at 327, 356 and
 * 243 px.
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
let dm: Page;
let pat: Page;
let dmCdp: CDPSession;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

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

/** Opens a character's card from its row, unless it is open. */
async function openCard(panel: Locator, characterId: string): Promise<Locator> {
  const row = panel.locator(`[data-opener="character:${characterId}"]`);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  return row;
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
  const on = `button [character:${characterId}]`;
  await waitFor(what, async () => ((await focusedOn(page)).startsWith(on) ? true : null), 5_000).catch(async () => assert.fail(`${what}: focus is on "${await focusedOn(page)}"`));
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

/** A shared character's card at this width: the note saying why there is no Delete stays inside the panel, its long name broken. */
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

/** A long name's card in a panel this wide: Delete and its line inside the panel, nothing scrolling sideways, the name whole. */
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

  test("2. Bree's card says what goes before Delete, which a screen reader hears as Delete's description in both states; Cyra's says why it has none, and Quin's Dax offers nothing", async () => {
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
    await sheet.getByText("Dax", { exact: true }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: /Dax/ }).count(), 0, "another player's character offers nothing");
    assert.equal(patSocket.everSaw(run.breeOnTheRoad), false, "the token on the road never reached Pat");
  });

  test("3. 80-character names, spaced and unbroken, keep Delete and its line inside the card at 356 and 243 px", async () => {
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
    // Pat's list in order: Bree, the unbroken long name, Cyra, ... So the next row is the long name's.
    await focusLands(pat, run.unbroken, "focus on the next row after the late answer");
    await shots.take(pat, "characters-player-after-delete");

    // The DM's log, and no player's, says who deleted what.
    const said = "Pat deleted Bree, with 2 tokens, 1 companion and its place in the fight.";
    assert.ok(state.log.some((e) => e.data?.type === "characterDeleted"), "the DM's log holds the line");
    await dm.getByRole("tab", { name: "Log" }).click();
    await dm.getByRole("tabpanel", { name: "Log" }).getByText(said, { exact: true }).waitFor();
    await shots.take(dm, "characters-dm-log-player-delete");
    assert.equal(patSocket.everSaw("characterDeleted"), false, "the line never reached Pat");
    patConsole.expectSocketFailures = false;
  });

  test("5. a delete the server refuses, since the DM shared the character meanwhile, keeps focus on its row and says why", async () => {
    const sheet = await openCharacters(pat);
    await openCard(sheet, run.wren);
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    await sheet.getByRole("button", { name: "Delete Wren", exact: true }).tap();
    await sheet.getByRole("button", { name: "Tap again to delete", exact: true }).tap();
    await sheet.getByRole("button", { name: "Deleting…", exact: true }).waitFor();
    await ops.send({ t: "character.update", characterId: run.wren, patch: { ownerIds: [run.patId, run.quinId] } });
    await patContext.setOffline(false);
    await pat.getByText("Someone else plays that character too. Ask the DM to delete it.", { exact: true }).waitFor({ timeout: 30_000 });
    await focusLands(pat, run.wren, "focus on Wren's row after the refusal");
    await sheet.getByText("You and Quin both play Wren, so only the DM can delete it.", { exact: true }).waitFor();
    assert.ok(dmSocket.state!.characters[run.wren], "Wren stays");
    await shots.take(pat, "characters-player-delete-refused");
    patConsole.expectSocketFailures = false;
  });

  test("6. focus Pat moves elsewhere while the delete waits stays there", async () => {
    const sheet = await openCharacters(pat);
    await openCard(sheet, run.zed);
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    await sheet.getByRole("button", { name: "Delete Zed", exact: true }).tap();
    await sheet.getByRole("button", { name: "Tap again to delete", exact: true }).tap();
    await sheet.getByRole("button", { name: "Deleting…", exact: true }).waitFor();
    // Zed's row is the last, so the hand-off would go to the one before, Wren's. Cyra's is not where it would go.
    await sheet.locator(`[data-opener="character:${run.cyra}"]`).focus();
    await patContext.setOffline(false);
    await waitFor("Zed gone for the DM", () => (dmSocket.state && !dmSocket.state.characters[run.zed] ? true : null), 30_000);
    await sheet.locator(`[data-opener="character:${run.zed}"]`).waitFor({ state: "detached" });
    await sleep(300);
    await focusLands(pat, run.cyra, "focus stays on Cyra's row");
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

  test("8. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(patConsole.errors, [], "Pat's page logged errors");
  });
});
