import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { LIMITS } from "#shared/limits.ts";
import type { ClassResource } from "#shared/model.ts";
import { wrappedButtons } from "./helpers/wraps.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { barControl, ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Class resources (docs/design-v1-combat-controls.md 7 and 11), on the
 * real server serving the production build. Pat plays Thorn, level 5:
 * - On a phone, Pat adds Barbarian resources at level 5 from a class
 *   (Rage, 3 uses), Lay on Hands from Paladin 3, and Superiority Dice of
 *   his own.
 * - In a fight Pat uses Rage from the token panel's row, the turn card
 *   being the combat surfaces' lane, and spends and restores an amount
 *   of Lay on Hands, one too many refused in the field.
 * - A Short Rest restores one Rage and all Superiority Dice, and says
 *   so, and a Long Rest everything.
 * - A Use sent offline after the DM spent the last Rage comes back
 *   refused, its reason in the list's status line, and a pool's open
 *   field closes once the DM spends the last of it.
 * - Thorn's level rises: each class asks to update once, Barbarian's
 *   counts follow, and Paladin's stays where Pat keeps it.
 * - Edit changes a count and Remove takes one off, with a second tap.
 * - What Quin, who plays another character, receives never holds the
 *   list, only the use lines that name what Thorn used.
 * The section and the Add, Update and Edit sheets are measured with the
 * alignment check at 1440 x 900, 390 x 844 and 320 x 568, at 100% and
 * 130%.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-nine, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 29;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-classresources-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let quinContext: BrowserContext;
let dm: Page;
let pat: Page;
let quin: Page;
let dmCdp: CDPSession;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const quinSocket = new SocketWatch("quin");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");
const quinConsole = new ConsoleWatch("quin");

const run = {
  roomId: "",
  roomName: `E2E class resources ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  patId: "",
  quinId: "",
  thorn: randomUUID(),
  thornToken: randomUUID(),
  vex: randomUUID(),
  goblin: randomUUID(),
};

type View = { width: number; height: number; scale: number };

/** The few DOM shapes the page-side checks read, as e2e code has no DOM types. */
type DomNode = { textContent: string | null; getAttribute(name: string): string | null; querySelectorAll(selector: string): ArrayLike<DomNode> };
type Doc = { document: { activeElement: DomNode | null }; getComputedStyle(el: unknown): { fontSize: string } };
const DESK: View = { width: 1440, height: 900, scale: 1 };
const PHONE: View = { width: 390, height: 844, scale: 1 };
const SMALL: View = { width: 320, height: 568, scale: 1 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** Sets the window and the interface size, then opens the room again. */
async function setUp(page: Page, cdp: CDPSession, view: View): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** The Characters panel: the side panel's tab where there is a side panel, else a sheet from the tool bar's Panels list. */
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

/** Thorn's page: Pat plays him alone, so the panel lands there. The DM opens it from its row. */
async function thornsPage(page: Page): Promise<Locator> {
  const panel = await openCharacters(page);
  const heading = panel.locator("[data-creature-heading]").filter({ hasText: "Thorn" });
  const opener = panel.locator(`[data-opener="character:${run.thorn}"]`);
  // The panel opens on its list or, for a player who plays Thorn alone, on his page, a moment after it shows.
  await heading.or(opener).first().waitFor();
  if ((await heading.count()) === 0) await opener.click();
  await heading.waitFor();
  return panel;
}

/** The token's panel: the side panel's Token tab from 900 px up, the Token sheet below. */
function tokenPanel(page: Page): Locator {
  return page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true }));
}

/** Puts away a phone's open sheets, such as Characters, which would take a tap meant for the map. */
async function closeSheets(page: Page): Promise<void> {
  const open = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true });
  for (let i = 0; i < 3; i++) {
    const n = await open.count();
    if (n === 0) return;
    await open.first().getByRole("button", { name: /^Close / }).first().click();
    await waitFor("a sheet put away", async () => ((await open.count()) < n ? true : null), 5_000);
  }
  assert.equal(await open.count(), 0, "a sheet still covers the map");
}

/** Thorn's token panel, from the map: a tap on his token, then Details in its bar. */
async function thornsPanel(page: Page): Promise<Locator> {
  await closeSheets(page);
  await tapCell(page, run.bounds, { x: 5, y: 5 });
  // On a phone held upright the bar rests as a strip, and Details is behind Expand.
  await (await barControl(page.getByRole("dialog", { name: "Thorn actions" }), "Details")).click();
  const panel = tokenPanel(page);
  await panel.getByRole("heading", { name: "Thorn" }).first().waitFor();
  return panel;
}

/** Combat's Uses section in a panel, which lists, edits and adds a character's class resources (docs/design-v1-token-sections.md 3.1). */
function section(scope: Locator): Locator {
  // The section whose own heading it is, not a panel's region around it.
  return scope.locator('xpath=.//section[*[self::h3 or self::h4][normalize-space()="Uses"]]');
}

/** One resource's row in the section, by its name. */
function row(scope: Locator, name: string): Locator {
  return section(scope).getByRole("listitem").filter({ has: scope.page().getByText(name, { exact: true }) });
}

/**
 * Waits for a resource's count to read `count` ("2 of 3"): with a most of 6
 * or fewer as its pips, filled for each one left, and the same words
 * spoken after its name, else in words beside its name
 * (docs/design-v1-monster-uses.md 3.7).
 */
async function countReads(scope: Locator, name: string, count: string): Promise<void> {
  const r = row(scope, name);
  const reads = () =>
    r.evaluate((el) => {
      type E = { querySelector(s: string): E | null; querySelectorAll(s: string): ArrayLike<E>; textContent: string | null };
      const li = el as unknown as E;
      const pips = li.querySelector("[data-use-pips]");
      if (!pips) return { pips: null, text: li.textContent ?? "" };
      return { pips: `${pips.querySelectorAll('[data-pip="left"]').length} of ${pips.querySelectorAll("[data-pip]").length}`, text: li.textContent ?? "" };
    });
  const [left, most] = count.split(" of ").map(Number);
  let last = { pips: null as string | null, text: "" };
  await waitFor(
    `${name} reading ${count}`,
    async () => {
      last = await reads();
      const ok = most! <= 6 ? last.pips === count && last.text.includes(`, ${count} left`) : last.pips === null && (await r.getByText(count, { exact: true }).count()) === 1;
      return ok ? true : null;
    },
    10_000,
  ).catch(() => assert.fail(`${name} reads ${last.pips === null ? `"${last.text}"` : `pips ${last.pips}`}, not ${count} (${left} left)`));
}

/** Thorn's resources as the DM's socket holds them. */
function stored(): ClassResource[] {
  return dmSocket.state?.characters[run.thorn]?.resources ?? [];
}

/** Waits for the DM's copy to read as `want`, which an op Pat's page already shows reaches a moment later, and fails with the difference. */
async function storedReads<T>(what: string, read: (list: ClassResource[]) => T, want: T): Promise<void> {
  await waitFor(what, () => (isDeepStrictEqual(read(stored()), want) ? true : null), 10_000).catch(() => assert.deepEqual(read(stored()), want, what));
}

async function usedIs(name: string, used: number): Promise<void> {
  await waitFor(`${name} used ${used} in the DM's copy`, () => (stored().find((r) => r.name === name)?.used === used ? true : null), 10_000);
}

function sheet(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title, exact: true });
}

async function openAdd(scope: Locator): Promise<Locator> {
  await section(scope).getByRole("button", { name: "Add a class resource" }).click();
  const add = sheet(scope.page(), "Add a class resource");
  await add.waitFor();
  return add;
}

/** Each part of the alignment sweep: what it measured, and what was off. */
const sweep: string[] = [];
const measured = new Set<string>();
let restoreSeen = 0;

async function measure(page: Page, root: Locator, screen: string): Promise<void> {
  await root.first().waitFor();
  measured.add(screen.replace(/ at .*$/, ""));
  const lines = alignmentLines(await measureAlignment(root.first()), screen);
  // A Restore button reads on one line at every size (fu28): its text laid out in more than one box has wrapped.
  const wrapped = await wrappedButtons(root.first(), "Restore");
  restoreSeen += wrapped.seen;
  lines.push(...wrapped.wrapped.map((t) => `${screen}: ${t} wraps`));
  if (lines.length > 0) {
    sweep.push(...lines);
    await shots.take(page, `cr-c-align-${screen.replace(/[^a-z0-9]+/gi, "-")}`);
  }
}

describe("raccoon-vtt: class resources", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    quinContext = await browser.newContext({ viewport: PHONE });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    quin = await quinContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    quinConsole.attach(quin);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    await quinSocket.attach(quinContext, quin);
    dmCdp = await dmContext.newCDPSession(dm);
    patCdp = await patContext.newCDPSession(pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole, quinConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("cr-c-1. a DM's room with Pat's Thorn at level 5 on the map, Quin's Vex, and a goblin", async () => {
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
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(45), level: 5 } });
    await ops.send({ t: "character.create", character: { id: run.vex, name: "Vex", size: "medium", ownerIds: [run.quinId], actor: actor(30), level: 5 } });
    const token = (id: string, extra: Record<string, unknown>) => ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await token(run.thornToken, { kind: "pc", name: "Thorn", x: 5, y: 5, disposition: "ally", actor: { ref: run.thorn } });
    await token(run.goblin, { kind: "monster", name: "Goblin", x: 9, y: 5, disposition: "hostile", actor: { inline: actor(7) } });

    // A new device is answered 403 by GET /me before it joins, which Chrome logs. Pat and Quin joined by request, so this is only in case.
    for (const [page, watch, socket] of [
      [pat, patConsole, patSocket],
      [quin, quinConsole, quinSocket],
    ] as const) {
      watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor(`${watch.label}'s snapshot`, () => socket.state);
      watch.allow = [];
    }
  });

  test("cr-c-2. Pat on a phone adds Barbarian resources at level 5: Rage, 3 uses, one back on a Short Rest", async () => {
    const page = await thornsPage(pat);
    const empty = section(page);
    await empty.getByText("Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level, typed, or brought in with Re-sync from D&D Beyond.", { exact: true }).waitFor();
    const add = await openAdd(page);
    await add.getByText("Choose a class to see its resources at its level.", { exact: true }).waitFor();
    await add.getByRole("combobox", { name: "Class" }).selectOption("barbarian");
    assert.equal(await add.getByRole("combobox", { name: "Barbarian level" }).inputValue(), "5", "the level starts at Thorn's");
    const rage = add.getByRole("checkbox", { name: "Rage" });
    assert.equal(await rage.isChecked(), true, "Rage starts ticked");
    await add.getByText("3 uses. One back on a Short Rest, all on a Long Rest.", { exact: true }).waitFor();
    await shots.take(pat, "cr-c-add-barbarian-5");
    await add.getByRole("button", { name: "Add 1 resource" }).tap();
    await add.waitFor({ state: "detached" });
    await countReads(page, "Rage", "3 of 3");
    const r = await waitFor("Rage in the DM's copy", () => stored().find((x) => x.name === "Rage"));
    assert.deepEqual({ ...r, id: "" }, { id: "", name: "Rage", max: 3, used: 0, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 });
    await shots.take(pat, "cr-c-section-rage");
  });

  test("cr-c-3. Lay on Hands from Paladin 3, Channel Divinity left unticked, and Superiority Dice of Pat's own", async () => {
    const page = await thornsPage(pat);
    let add = await openAdd(page);
    assert.equal(await add.getByRole("combobox", { name: "Class" }).inputValue(), "barbarian", "the sheet starts on Thorn's class");
    await add.getByText("Already added.", { exact: true }).waitFor();
    await add.getByRole("combobox", { name: "Class" }).selectOption("paladin");
    await add.getByRole("combobox", { name: "Paladin level" }).selectOption("3");
    assert.equal(await add.getByRole("combobox", { name: "Paladin level" }).inputValue(), "3");
    await add.getByText("A pool of 15. Back on a Long Rest.", { exact: true }).waitFor();
    await add.getByRole("checkbox", { name: "Channel Divinity" }).uncheck();
    await add.getByRole("button", { name: "Add 1 resource" }).tap();
    await add.waitFor({ state: "detached" });
    await countReads(page, "Lay on Hands", "15 of 15");

    add = await openAdd(page);
    await add.getByRole("radio", { name: "Your own" }).check();
    await add.getByRole("textbox", { name: "Name" }).fill("Superiority Dice");
    await add.getByRole("textbox", { name: "Count" }).fill("4");
    await add.getByRole("combobox", { name: "Comes back on" }).selectOption("short");
    await add.getByRole("button", { name: "Add", exact: true }).tap();
    await add.waitFor({ state: "detached" });
    await countReads(page, "Superiority Dice", "4 of 4");
    await storedReads(
      "the three in the DM's copy",
      (list) => list.map((x) => [x.name, x.max, x.reset, x.pool ?? false, x.preset ?? null]),
      [
        ["Rage", 3, "shortOne", false, "barbarian-rage"],
        ["Lay on Hands", 15, "long", true, "paladin-lay-on-hands"],
        ["Superiority Dice", 4, "short", false, null],
      ],
    );
  });

  test("cr-c-4. in a fight, Pat uses Rage from the token panel's row, and it reads 2 of 3 on his phone and in the DM's copy", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: "e-thorn", tokenId: run.thornToken, value: 18 },
        { id: "e-gob", tokenId: run.goblin, value: 8 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await waitFor("Thorn's turn", () => (dmSocket.state?.encounter?.activeEntryId === "e-thorn" ? true : null));
    // The turn card is the combat surfaces' lane, so the token panel's row stands in for it here.
    const panel = await thornsPanel(pat);
    await section(panel).scrollIntoViewIfNeeded();
    await row(panel, "Rage").getByRole("button", { name: "Use Rage, 3 of 3 left" }).tap();
    await countReads(panel, "Rage", "2 of 3");
    await usedIs("Rage", 1);
    await shots.take(pat, "cr-c-rage-used");
  });

  test("cr-c-5. a pool's amount: Use… opens the field, 20 is refused there, 5 is spent, and Restore… returns 2", async () => {
    const panel = tokenPanel(pat);
    const hands = row(panel, "Lay on Hands");
    const use = hands.getByRole("button", { name: "Use Lay on Hands, 15 of 15 left" });
    await use.tap();
    assert.equal(await use.getAttribute("aria-expanded"), "true");
    const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 15" });
    await field.waitFor();
    assert.equal(await field.getAttribute("inputmode"), "numeric");
    assert.equal(await field.evaluate((el) => (globalThis as unknown as Doc).getComputedStyle(el).fontSize), "16px", "16 px, so iOS does not zoom");
    assert.equal(await field.evaluate((el) => el === (globalThis as unknown as Doc).document.activeElement), true, "the field takes focus");
    await field.fill("20");
    await hands.getByRole("button", { name: "Spend", exact: true }).tap();
    await hands.getByText("Spend 1 to 15.", { exact: true }).waitFor();
    await measure(pat, hands, "the amount field with its error at 390 x 844");
    await shots.take(pat, "cr-c-amount-refused");
    await field.fill("5");
    await hands.getByRole("button", { name: "Spend", exact: true }).tap();
    await countReads(panel, "Lay on Hands", "10 of 15");
    await field.waitFor({ state: "detached" });
    await usedIs("Lay on Hands", 5);
    await waitFor("focus back on Use…", () => pat.evaluate(() => (globalThis as unknown as Doc).document.activeElement?.getAttribute("aria-label") ?? "").then((n) => (n === "Use Lay on Hands, 10 of 15 left" ? true : null)), 5_000);
    await hands.getByRole("button", { name: "Restore Lay on Hands" }).tap();
    await hands.getByRole("textbox", { name: "Lay on Hands to restore, up to 5" }).fill("2");
    await hands.getByRole("button", { name: "Restore", exact: true }).tap();
    await countReads(panel, "Lay on Hands", "12 of 15");
    await usedIs("Lay on Hands", 3);
  });

  test("cr-c-6. a Short Rest says it restores one Rage and all Superiority Dice, and does; Lay on Hands waits for a Long Rest", async () => {
    const panel = tokenPanel(pat);
    const dice = row(panel, "Superiority Dice");
    await dice.getByRole("button", { name: "Use Superiority Dice, 4 of 4 left" }).tap();
    await countReads(panel, "Superiority Dice", "3 of 4");
    await dice.getByRole("button", { name: "Use Superiority Dice, 3 of 4 left" }).tap();
    await countReads(panel, "Superiority Dice", "2 of 4");
    await row(panel, "Rage").getByRole("button", { name: "Use Rage, 2 of 3 left" }).tap();
    await countReads(panel, "Rage", "1 of 3");
    await ops.send({ t: "encounter.end" });
    await waitFor("the fight over", () => (dmSocket.state && !dmSocket.state.encounter ? true : null));
    await panel.getByRole("radio", { name: "Short Rest" }).check();
    await panel.getByText("A Short Rest also restores one Rage and all Superiority Dice.", { exact: true }).waitFor();
    await shots.take(pat, "cr-c-short-rest-says");
    await panel.getByRole("button", { name: "Finish the Short Rest" }).tap();
    await countReads(panel, "Rage", "2 of 3");
    await countReads(panel, "Superiority Dice", "4 of 4");
    await countReads(panel, "Lay on Hands", "12 of 15");
  });

  test("cr-c-7. a Long Rest says what it restores and restores all", async () => {
    const panel = tokenPanel(pat);
    await panel.getByRole("radio", { name: "Long Rest" }).check();
    await panel.getByText("A Long Rest also restores Rage and Lay on Hands.", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Finish the Long Rest" }).tap();
    await countReads(panel, "Rage", "3 of 3");
    await countReads(panel, "Lay on Hands", "15 of 15");
    await waitFor("nothing spent in the DM's copy", () => (stored().every((x) => x.used === 0) ? true : null), 10_000);
  });

  test("cr-c-8. a Use sent offline is busy until answered, and refused once the DM spent the last Rage meanwhile, the list's status line saying why", async () => {
    for (let i = 0; i < 2; i++) await ops.send({ t: "actor.use", target: { characterId: run.thorn }, use: { kind: "resource", id: stored()[0]!.id } });
    const panel = tokenPanel(pat);
    await countReads(panel, "Rage", "1 of 3");
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    // By where it stands, since the page shows the use at once and the button's name counts it.
    const waiting = row(panel, "Rage").getByRole("button", { name: /^Use Rage, / });
    await row(panel, "Rage").getByRole("button", { name: "Use Rage, 1 of 3 left" }).tap();
    assert.equal(await waiting.getAttribute("aria-busy"), "true", "busy while the server has not answered");
    await ops.send({ t: "actor.use", target: { characterId: run.thorn }, use: { kind: "resource", id: stored()[0]!.id } });
    await patContext.setOffline(false);
    const status = section(panel).getByRole("status");
    await status.waitFor({ timeout: 20_000 });
    assert.equal((await status.textContent())?.trim(), "Rage has no uses left.");
    patConsole.expectSocketFailures = false;
    await countReads(panel, "Rage", "0 of 3");
    const use = row(panel, "Rage").getByRole("button", { name: "Use Rage, 0 of 3 left" });
    assert.equal(await use.getAttribute("aria-disabled"), "true", "off, and still in the Tab order");
    await shots.take(pat, "cr-c-refused");
    await row(panel, "Rage").getByRole("button", { name: "Restore one use of Rage" }).tap();
    await countReads(panel, "Rage", "1 of 3");
    await status.waitFor({ state: "detached" });
  });

  test("cr-c-9. Thorn reaches level 6: Barbarian and Paladin each ask once; Barbarian's Rage goes to 4, and Paladin stays at 3 by Pat's choice", async () => {
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { level: 6 } });
    const page = await thornsPage(pat);
    const asks = section(page);
    await asks.getByText("Your level went up. Update Barbarian resources?", { exact: true }).waitFor();
    await asks.getByText("Your level went up. Update Paladin resources?", { exact: true }).waitFor();
    await shots.take(pat, "cr-c-level-up");
    await asks.locator("div").filter({ hasText: /^Your level went up\. Update Barbarian resources\?Update$/ }).getByRole("button", { name: "Update" }).tap();
    let update = sheet(pat, "Update Barbarian resources");
    await update.waitFor();
    assert.equal(await update.getByRole("combobox", { name: "Barbarian level" }).inputValue(), "6");
    await update.getByText("Goes from 3 to 4.", { exact: true }).waitFor();
    await update.getByText("It was 5. Leveled another class? Keep it at 5.", { exact: true }).waitFor();
    await measure(pat, update, "the Update sheet at 390 x 844");
    await update.getByRole("button", { name: "Update", exact: true }).tap();
    await update.waitFor({ state: "detached" });
    await countReads(page, "Rage", "2 of 4");
    await asks.getByText("Your level went up. Update Barbarian resources?", { exact: true }).waitFor({ state: "detached" });

    await asks.locator("div").filter({ hasText: /^Your level went up\. Update Paladin resources\?Update$/ }).getByRole("button", { name: "Update" }).tap();
    update = sheet(pat, "Update Paladin resources");
    await update.getByRole("combobox", { name: "Paladin level" }).selectOption("3");
    await update.getByText("Stays at 15.", { exact: true }).waitFor();
    await update.getByRole("button", { name: "Update", exact: true }).tap();
    await update.waitFor({ state: "detached" });
    await asks.getByText(/^Your level went up/).waitFor({ state: "detached" });
    await storedReads(
      "the updated counts and levels in the DM's copy",
      (list) => list.map((x) => [x.name, x.max, x.level ?? null, x.atLevel ?? null]),
      [
        ["Rage", 4, 6, 6],
        ["Lay on Hands", 15, 3, 6],
        ["Superiority Dice", 4, null, null],
      ],
    );
  });

  test("cr-c-10. Edit sets Superiority Dice to 5, a count typed by hand, and Remove takes it off with a second tap", async () => {
    const page = await thornsPage(pat);
    await row(page, "Superiority Dice").getByRole("button", { name: "Edit Superiority Dice" }).tap();
    const edit = sheet(pat, "Edit Superiority Dice");
    await edit.waitFor();
    assert.equal(await edit.getByRole("textbox", { name: "Name" }).inputValue(), "Superiority Dice");
    await edit.getByRole("textbox", { name: "Count" }).fill("5");
    await measure(pat, edit, "the Edit sheet at 390 x 844");
    await edit.getByRole("button", { name: "Save", exact: true }).tap();
    await edit.waitFor({ state: "detached" });
    await countReads(page, "Superiority Dice", "5 of 5");
    await storedReads("a count typed by hand", (list) => list[2]?.edited, true);

    await row(page, "Superiority Dice").getByRole("button", { name: "Edit Superiority Dice" }).tap();
    await edit.getByRole("button", { name: "Remove Superiority Dice" }).tap();
    await edit.getByRole("button", { name: "Tap again to remove" }).tap();
    await edit.waitFor({ state: "detached" });
    await row(page, "Superiority Dice").waitFor({ state: "detached" });
    await storedReads("what is left in the DM's copy", (list) => list.map((x) => x.name), ["Rage", "Lay on Hands"]);
  });

  test("cr-c-11. a reload keeps them, the DM's token panel holds them after Rest, and Quin's copy never held them", async () => {
    await setUp(pat, patCdp, PHONE);
    const page = await thornsPage(pat);
    await countReads(page, "Rage", "2 of 4");
    await countReads(page, "Lay on Hands", "15 of 15");

    const panel = await thornsPanel(dm);
    const combat = panel.getByRole("button", { name: "Combat", exact: true });
    if ((await combat.getAttribute("aria-expanded")) === "false") await combat.click();
    await countReads(panel, "Rage", "2 of 4");
    const order = await panel.evaluate((root) => Array.from((root as unknown as DomNode).querySelectorAll("h3, h4")).map((h) => h.textContent ?? ""));
    // Out of the fight: Uses after Conditions, then the rings and Rest, and no Class resources heading (docs/design-v1-token-sections.md 3).
    const conditions = order.indexOf("Conditions");
    assert.deepEqual(order.slice(conditions, conditions + 4), ["Conditions", "Uses", "Range rings", "Rest"], `Combat's order: ${order.join(", ")}`);
    assert.equal(order.includes("Class resources"), false, `no Class resources heading: ${order.join(", ")}`);

    // A use's line names the resource to everyone who sees Thorn (docs/design-v1-combat-controls.md 8), so the list and its counts are what must never reach Quin.
    for (const words of ['"resources"', "barbarian-rage", '"atLevel"']) assert.equal(quinSocket.everSaw(words), false, `Quin's copy holds ${words}`);
    assert.ok(quinSocket.state?.characters[run.thorn], "Quin's copy holds Thorn");
    assert.equal(quinSocket.state?.characters[run.thorn]?.resources, undefined);
  });

  test("cr-c-12. the section, its level-up question, a pool's amount field and the Add, Update and Edit sheets line up at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    // Level 7 asks again for both classes, so every size measures the question and the Update sheet.
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { level: 7 } });
    const sizes: [Page, CDPSession, View][] = [
      [dm, dmCdp, DESK],
      [dm, dmCdp, { ...DESK, scale: 1.3 }],
      [pat, patCdp, PHONE],
      [pat, patCdp, { ...PHONE, scale: 1.3 }],
      [pat, patCdp, SMALL],
      [pat, patCdp, { ...SMALL, scale: 1.3 }],
    ];
    for (const [page, cdp, view] of sizes) {
      const at = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(page, cdp, view);
      const scope = page === dm ? await thornsPanel(dm) : await thornsPage(pat);
      if (page === dm) {
        const combat = scope.getByRole("button", { name: "Combat", exact: true });
        if ((await combat.getAttribute("aria-expanded")) === "false") await combat.click();
      }
      await section(scope).getByText("Your level went up. Update Barbarian resources?", { exact: true }).waitFor();
      await section(scope).scrollIntoViewIfNeeded();
      await measure(page, section(scope), `the Uses section at ${at}`);
      await shots.take(page, `cr-c-section-${view.width}-${Math.round(view.scale * 100)}`);

      await section(scope).locator("div").filter({ hasText: /^Your level went up\. Update Barbarian resources\?Update$/ }).getByRole("button", { name: "Update" }).click();
      const update = sheet(page, "Update Barbarian resources");
      await update.getByText("Stays at 4.", { exact: true }).waitFor();
      await measure(page, update, `the Update sheet at ${at}`);
      await update.getByRole("button", { name: "Cancel", exact: true }).click();
      await update.waitFor({ state: "detached" });

      const hands = row(scope, "Lay on Hands");
      await hands.getByRole("button", { name: "Use Lay on Hands, 15 of 15 left" }).click();
      await hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 15" }).fill("99");
      await hands.getByRole("button", { name: "Spend", exact: true }).click();
      await hands.getByText("Spend 1 to 15.", { exact: true }).waitFor();
      await measure(page, hands, `the amount field with its error at ${at}`);
      await hands.getByRole("button", { name: "Cancel", exact: true }).click();

      const add = await openAdd(scope);
      await add.getByRole("combobox", { name: "Class" }).selectOption("barbarian");
      const level = add.getByRole("combobox", { name: "Barbarian level" });
      await level.selectOption("14");
      await add.getByText("Path of the Berserker. 1 use. Back on a Long Rest.", { exact: true }).waitFor();
      await measure(page, add, `the Add sheet from a class at ${at}`);
      // Natural Recovery's two uses stand as two rows of a subclass, each left unticked.
      await add.getByRole("combobox", { name: "Class" }).selectOption("druid");
      await add.getByRole("combobox", { name: "Druid level" }).selectOption("6");
      const recovery = add.getByRole("checkbox", { name: /^Natural Recovery/ });
      await add.getByRole("checkbox", { name: "Natural Recovery (spell slots)", exact: true }).waitFor();
      assert.deepEqual(await Promise.all((await recovery.all()).map((box) => box.isChecked())), [false, false], "both unticked");
      assert.equal(await add.getByText("Circle of the Land. 1 use. Back on a Long Rest.", { exact: true }).count(), 2, "each says what it counts");
      await measure(page, add, `the Add sheet with a subclass's two rows at ${at}`);
      await add.getByRole("combobox", { name: "Class" }).selectOption("bard");
      await add.getByRole("textbox", { name: "Charisma modifier" }).waitFor();
      await measure(page, add, `the Add sheet asking a modifier at ${at}`);
      await add.getByRole("radio", { name: "Your own" }).check();
      await add.getByRole("checkbox", { name: "Spend an amount" }).check();
      await measure(page, add, `the Add sheet's own at ${at}`);
      await shots.take(page, `cr-c-add-own-${view.width}-${Math.round(view.scale * 100)}`);
      await add.getByRole("button", { name: "Cancel", exact: true }).click();
      await add.waitFor({ state: "detached" });

      await row(scope, "Rage").getByRole("button", { name: "Edit Rage" }).click();
      const edit = sheet(page, "Edit Rage");
      await measure(page, edit, `the Edit sheet at ${at}`);
      await edit.getByRole("button", { name: "Cancel", exact: true }).click();
      await edit.waitFor({ state: "detached" });
    }
    assert.deepEqual([...measured].sort(), [
      "the Add sheet asking a modifier",
      "the Add sheet from a class",
      "the Add sheet with a subclass's two rows",
      "the Add sheet's own",
      "the Edit sheet",
      "the Update sheet",
      "the Uses section",
      "the amount field with its error",
    ]);
    assert.deepEqual(sweep, [], "out of line by more than 1 px");
    assert.ok(restoreSeen > 0, "the sweep met a Restore button to check for wrapping");
  });

  test("cr-c-12b. a pool's open field closes when the DM spends the last of it, the status line saying why, focus back on Use…", async () => {
    await setUp(pat, patCdp, PHONE);
    const page = await thornsPage(pat);
    const hands = row(page, "Lay on Hands");
    await hands.getByRole("button", { name: "Use Lay on Hands, 15 of 15 left" }).tap();
    const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 15" });
    await field.waitFor();
    assert.equal(await field.evaluate((el) => el === (globalThis as unknown as Doc).document.activeElement), true, "the field has focus");
    const id = stored().find((x) => x.name === "Lay on Hands")!.id;
    await ops.send({ t: "actor.use", target: { characterId: run.thorn }, use: { kind: "resource", id, amount: 15 } });
    await field.waitFor({ state: "detached" });
    const status = section(page).getByRole("status");
    assert.equal((await status.textContent())?.trim(), "No Lay on Hands is left.");
    assert.equal(await hands.getByText(/to 0/).count(), 0, "nothing reads 1 to 0");
    await waitFor("focus back on Use…", () => pat.evaluate(() => (globalThis as unknown as Doc).document.activeElement?.getAttribute("aria-label") ?? "").then((n) => (n === "Use Lay on Hands, 0 of 15 left" ? true : null)), 5_000);
    await shots.take(pat, "cr-c-pool-emptied-elsewhere");
    await ops.send({ t: "actor.use", target: { characterId: run.thorn }, use: { kind: "resource", id, amount: 15 }, back: true });
    await countReads(page, "Lay on Hands", "15 of 15");
  });

  test("cr-c-12c. Pat spends the whole pool from the field and restores it all: each closes the field with no status line, offline and once answered", async () => {
    const page = await thornsPage(pat);
    const hands = row(page, "Lay on Hands");
    const status = section(page).getByRole("status");
    // Offline, the page shows the use at once and the answer waits: the window in which an emptied pool used to read as refused.
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    assert.equal((await status.textContent())?.trim(), "No Lay on Hands is left.", "the last step's reason, still standing");
    await hands.getByRole("button", { name: "Use Lay on Hands, 15 of 15 left" }).tap();
    assert.equal(await status.count(), 0, "a new tap takes the old reason away");
    await hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 15" }).fill("15");
    await hands.getByRole("button", { name: "Spend", exact: true }).tap();
    await countReads(page, "Lay on Hands", "0 of 15");
    await hands.getByRole("textbox").waitFor({ state: "detached" });
    await pat.waitForTimeout(500);
    assert.equal(await status.count(), 0, "no status line while the use waits for its answer");
    await waitFor("focus on Use…", () => pat.evaluate(() => (globalThis as unknown as Doc).document.activeElement?.getAttribute("aria-label") ?? "").then((n) => (n === "Use Lay on Hands, 0 of 15 left" ? true : null)), 5_000);
    await patContext.setOffline(false);
    await usedIs("Lay on Hands", 15);
    patConsole.expectSocketFailures = false;
    assert.equal(await status.count(), 0, "no status line once the server took it");

    await hands.getByRole("button", { name: "Restore Lay on Hands" }).tap();
    await hands.getByRole("textbox", { name: "Lay on Hands to restore, up to 15" }).fill("15");
    await hands.getByRole("button", { name: "Restore", exact: true }).tap();
    await countReads(page, "Lay on Hands", "15 of 15");
    await hands.getByRole("textbox").waitFor({ state: "detached" });
    await usedIs("Lay on Hands", 0);
    await pat.waitForTimeout(300);
    assert.equal(await status.count(), 0, "a whole restore reads as no refusal either");
  });

  test("fu26-b. the DM's Long Rest for the party says in one line that it also restores every class resource, and its card lines up at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const rage = stored().find((x) => x.name === "Rage")!;
    if (rage.used === 0) await ops.send({ t: "actor.use", target: { characterId: run.thorn }, use: { kind: "resource", id: rage.id } });
    await waitFor("a Rage spent", () => ((stored().find((x) => x.name === "Rage")?.used ?? 0) > 0 ? true : null), 10_000);
    const off: string[] = [];
    for (const view of [DESK, { ...DESK, scale: 1.3 }, PHONE, { ...PHONE, scale: 1.3 }, SMALL, { ...SMALL, scale: 1.3 }]) {
      const at = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(dm, dmCdp, view);
      const panel = await openCharacters(dm);
      await panel.getByRole("button", { name: "Long Rest for the party", exact: true }).click();
      const finish = panel.getByRole("button", { name: "Finish the Long Rest", exact: true });
      await finish.waitFor();
      await panel.getByText(/Exhaustion level\. It also restores every class resource\./).waitFor();
      // The card: the innermost box that holds both its words and its buttons.
      const card = panel.locator("div").filter({ has: dm.getByRole("button", { name: "Finish the Long Rest", exact: true }) }).filter({ hasText: "It also restores every class resource." }).last();
      await card.scrollIntoViewIfNeeded();
      const lines = alignmentLines(await measureAlignment(card), `the party's Long Rest at ${at}`);
      off.push(...lines);
      await shots.take(dm, `fu26-party-rest-${view.width}-${Math.round(view.scale * 100)}`);
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      await finish.waitFor({ state: "detached" });
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
    await setUp(dm, dmCdp, DESK);
  });

  test("s2-cr-a. Pat on Thorn's token panel: Uses holds Rage with Use, Restore and Edit, then Add, under no Class resources heading, and Add's sheet gives focus back to Add as it closes (docs/design-v1-token-sections.md 3.1)", async () => {
    await setUp(pat, patCdp, PHONE);
    const rage = stored().find((x) => x.name === "Rage")!;
    if (rage.used === 0) await ops.send({ t: "actor.use", target: { characterId: run.thorn }, use: { kind: "resource", id: rage.id } });
    const panel = await thornsPanel(pat);
    const uses = section(panel);
    await uses.scrollIntoViewIfNeeded();
    const row_ = row(panel, "Rage");
    await row_.getByRole("button", { name: /^Use Rage, / }).waitFor();
    await row_.getByRole("button", { name: "Restore one use of Rage" }).waitFor();
    await row_.getByRole("button", { name: "Edit Rage" }).waitFor();
    assert.equal(await panel.getByRole("heading", { name: "Class resources" }).count(), 0, "no Class resources heading");
    const add = uses.getByRole("button", { name: "Add a class resource" });
    // Add follows the rows (UsesSection.test.ts checks the order in the markup).
    assert.ok((await add.boundingBox())!.y > (await row_.boundingBox())!.y, "Add after the rows");
    await shots.take(pat, "s2-cr-panel-uses");
    await add.focus();
    await pat.keyboard.press("Enter");
    const opened = sheet(pat, "Add a class resource");
    await opened.waitFor();
    await opened.getByRole("button", { name: "Cancel", exact: true }).click();
    await opened.waitFor({ state: "detached" });
    await waitFor("focus back on Add", () => pat.evaluate(() => ((globalThis as unknown as Doc).document.activeElement?.textContent ?? "").trim()).then((t) => (t === "Add a class resource" ? true : null)), 5_000).catch(async () =>
      assert.fail(`focus is on "${await pat.evaluate(() => ((globalThis as unknown as Doc).document.activeElement?.textContent ?? "").trim())}"`),
    );
    await closeSheets(pat);
  });

  test("lp22-cr-a. by keyboard on Thorn's token panel, Remove from a resource's Edit sheet and an answered level-up's Update each take their opener away, and focus goes to Add, never the page", async () => {
    await setUp(pat, patCdp, PHONE);
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { resources: [...stored(), { id: randomUUID(), name: "Lucky Knack", max: 2, reset: "long" }] } });
    await storedReads("Lucky Knack added", (list) => list.some((x) => x.name === "Lucky Knack"), true);
    const panel = await thornsPanel(pat);
    const uses = section(panel);
    const focused = () =>
      pat.evaluate(() => {
        const { document } = globalThis as unknown as { document: { activeElement: (DomNode & { tagName: string }) | null } };
        const el = document.activeElement;
        return !el || el.tagName === "BODY" ? "the page" : (el.textContent ?? "").trim();
      });
    const focusOnAdd = (after: string) =>
      waitFor(`focus on Add after ${after}`, () => focused().then((t) => (t === "Add a class resource" ? true : null)), 5_000).catch(async () => assert.fail(`after ${after} focus is on "${await focused()}"`));

    await row(panel, "Lucky Knack").getByRole("button", { name: "Edit Lucky Knack" }).focus();
    await pat.keyboard.press("Enter");
    const edit = sheet(pat, "Edit Lucky Knack");
    await edit.waitFor();
    await edit.getByRole("button", { name: "Remove Lucky Knack" }).focus();
    await pat.keyboard.press("Enter");
    await edit.getByRole("button", { name: "Tap again to remove" }).focus();
    await pat.keyboard.press("Enter");
    await edit.waitFor({ state: "detached" });
    await row(panel, "Lucky Knack").waitFor({ state: "detached" });
    await focusOnAdd("Remove");

    // A level past what Rage was read at asks once, and its line goes with the answer.
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { level: 7 } });
    const line = uses.locator("div").filter({ hasText: /^Your level went up\. Update Barbarian resources\?Update$/ });
    await line.getByRole("button", { name: "Update" }).focus();
    await pat.keyboard.press("Enter");
    const update = sheet(pat, "Update Barbarian resources");
    await update.waitFor();
    await update.getByRole("button", { name: "Update", exact: true }).focus();
    await pat.keyboard.press("Enter");
    await update.waitFor({ state: "detached" });
    await line.waitFor({ state: "detached" });
    await focusOnAdd("the level-up's Update");
    await closeSheets(pat);
  });

  test("fu32-cr-a. by keyboard on Thorn's token panel, the Add sheet's Add that fills the list takes Add away for the limit's line, and focus goes to the section's first button, never the page (LP22-OPUS-5c)", async () => {
    await setUp(pat, patCdp, PHONE);
    const before = stored();
    const fill = Array.from({ length: LIMITS.resourcesPerCharacter - 1 - before.length }, (_, i) => ({ id: randomUUID(), name: `Knack ${i + 1}`, max: 1, reset: "long" as const }));
    try {
      await ops.send({ t: "character.update", characterId: run.thorn, patch: { resources: [...before, ...fill] } });
      await storedReads("one short of the limit", (list) => list.length, LIMITS.resourcesPerCharacter - 1);
      const panel = await thornsPanel(pat);
      const uses = section(panel);
      await uses.getByRole("button", { name: "Add a class resource" }).focus();
      await pat.keyboard.press("Enter");
      const add = sheet(pat, "Add a class resource");
      await add.waitFor();
      await add.getByRole("radio", { name: "Your own" }).check();
      await add.getByRole("textbox", { name: "Name" }).fill("Last Knack");
      await add.getByRole("textbox", { name: "Count" }).fill("1");
      await add.getByRole("button", { name: "Add", exact: true }).focus();
      await pat.keyboard.press("Enter");
      await add.waitFor({ state: "detached" });
      await uses.getByText(`A character holds at most ${LIMITS.resourcesPerCharacter} class resources. Remove one to add another.`, { exact: true }).waitFor();
      // With no Add left, the section's first button takes focus (UsesSection.tsx).
      const onFirst = () =>
        uses.evaluate((el) => {
          const { document } = globalThis as unknown as { document: { activeElement: unknown } };
          return (el as unknown as { querySelector(s: string): unknown }).querySelector("button") === document.activeElement;
        });
      await waitFor("focus on the section's first button", () => onFirst().then((on) => (on ? true : null)), 5_000).catch(async () =>
        assert.fail(
          `focus is on "${await pat.evaluate(() => {
            const el = (globalThis as unknown as { document: { activeElement: (DomNode & { tagName: string }) | null } }).document.activeElement;
            return !el || el.tagName === "BODY" ? "the page" : (el.textContent ?? "").trim();
          })}"`,
        ),
      );
    } finally {
      await ops.send({ t: "character.update", characterId: run.thorn, patch: { resources: before } });
      await closeSheets(pat);
    }
  });

  test("cr-c-13. no console errors on any page", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page");
    assert.deepEqual(patConsole.errors, [], "Pat's page");
    assert.deepEqual(quinConsole.errors, [], "Quin's page");
  });
});
