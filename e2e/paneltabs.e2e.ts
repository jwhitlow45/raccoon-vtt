import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * The side panel's tabs in one row with a grouped More menu
 * (docs/design-v1-panel-tabs.md 11.2), on the real server serving the
 * production build: the row at every size a computer or a tablet lays out,
 * nothing moving as panels open from More or from anywhere else, More's
 * keys and its menu's, badges on More, the side panel hidden and shown,
 * a reach sweep, a wider font that cuts a name, and the shared popover
 * base's rules for More's menu (docs/design-v1-tool-options.md 7.1).
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus thirteen, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 13;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-paneltabs-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let dmCdp: CDPSession;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E panel tabs ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  patId: "",
  password: "",
  goblin: randomUUID(),
  lore: randomUUID(),
  pinPage: randomUUID(),
  pin: randomUUID(),
};

const DM_PANELS = ["Token", "Initiative", "Log", "Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"];
const PLAYER_PANELS = ["Token", "Initiative", "Log", "Journal", "Areas", "Characters", "Library", "Menu"];
const DM_MENU = ["#In play", "Journal", "Areas", "DM", "Scenes", "#Prepare", "Monsters", "Encounters", "Characters", "Outliner", "Library", "---", "Menu"];
const PLAYER_MENU = ["Journal", "Areas", "Characters", "Library", "Menu"];

type Box = { x: number; y: number; width: number; height: number };
type Insets = { side?: number; bottom?: number };

/** The page's document as code run in the browser reads it: the e2e files compile without the DOM's types. */
type DomEl = {
  tagName: string;
  textContent: string | null;
  firstChild: { textContent: string | null } | null;
  scrollWidth: number;
  clientWidth: number;
  children: ArrayLike<DomEl>;
  ownerDocument: { activeElement: unknown; getElementById(id: string): DomEl | null; elementFromPoint(x: number, y: number): unknown };
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): ArrayLike<DomEl>;
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number; width: number; height: number };
  contains(other: unknown): boolean;
};

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 1, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The window, its safe areas and the interface size, as the layout and reach runs set them. */
async function view(page: Page, cdp: CDPSession, size: { width: number; height: number }, insets: Insets = {}): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: insets.bottom ?? 0, left: insets.side ?? 0, right: insets.side ?? 0 } });
  await page.setViewportSize(size);
  await page.waitForTimeout(250);
}

async function reloadAt(page: Page, scale: number, sidePanel: "keep" | "clear" = "keep"): Promise<void> {
  await page.evaluate(
    ({ s, clear }) => {
      const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage;
      store.setItem("rvtt.uiScale", String(s));
      if (clear) store.removeItem("rvtt.sidePanel");
    },
    { s: scale, clear: sidePanel === "clear" },
  );
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await page.waitForTimeout(300);
}

async function box(target: Locator): Promise<Box> {
  const b = await target.boundingBox();
  assert.ok(b, "the element has no box");
  return b;
}

function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;
}

const tablist = (page: Page) => page.getByRole("tablist", { name: "Panels" });
const more = (page: Page) => tablist(page).locator('[role="tab"][aria-haspopup="menu"]');
const menu = (page: Page) => page.getByRole("menu", { name: "More panels" });
const sidePanel = (page: Page) => page.locator('aside:has([role="tablist"][aria-label="Panels"])');
const hidePanels = (page: Page) => page.getByRole("button", { name: "Hide panels" });
const panelsButton = (page: Page) => page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ });

function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el === (el as unknown as DomEl).ownerDocument.activeElement);
}

/** The titles of the tabs in the row, More left out: each tab's first text, before its corner badge. */
function rowTitles(page: Page): Promise<string[]> {
  return tablist(page)
    .locator('[role="tab"]:not([aria-haspopup])')
    .evaluateAll((els) => els.map((el) => ((el as unknown as DomEl).firstChild?.textContent ?? "").trim()));
}

/** More's menu as it reads: "#" and a group's label, "---" for the line, an item's title. */
function menuShape(page: Page): Promise<string[]> {
  return menu(page).evaluate((root) => {
    const out: string[] = [];
    const walk = (el: DomEl) => {
      const role = el.getAttribute("role");
      if (role === "menuitemradio") out.push((el.querySelector("span")?.textContent ?? "").trim());
      else if (role === "separator") out.push("---");
      else {
        if (role === "group") out.push(`#${el.ownerDocument.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent ?? ""}`);
        for (const child of Array.from(el.children)) if (child.getAttribute("aria-hidden") !== "true") walk(child);
      }
    };
    for (const child of Array.from((root as unknown as DomEl).children)) walk(child);
    return out;
  });
}

/** More's description, which carries its count. */
function moreDescription(page: Page): Promise<string> {
  return more(page).evaluate((el) => {
    const e = el as unknown as DomEl;
    return e.ownerDocument.getElementById(e.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
  });
}

/** Every tab in the row, More and Hide panels, by their boxes. */
async function rowBoxes(page: Page): Promise<Box[]> {
  const tabs = await tablist(page).locator('[role="tab"]:not([aria-haspopup])').all();
  return [...(await Promise.all(tabs.map(box))), await box(hidePanels(page))];
}

/** The row is one line: every tab and More share one top, and the list never scrolls. */
async function oneLine(page: Page): Promise<{ tops: number; scrolls: boolean }> {
  return tablist(page).evaluate((el) => {
    const e = el as unknown as DomEl;
    const tops = new Set(Array.from(e.querySelectorAll('[role="tab"]'), (t) => Math.round(t.getBoundingClientRect().top)));
    return { tops: tops.size, scrolls: e.scrollWidth > e.clientWidth };
  });
}

function circleFilled(page: Page, color: string): Promise<boolean> {
  return page.evaluate((c) => {
    type Node = { fill(): unknown };
    const konva = (globalThis as unknown as { Konva?: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva?.stages.some((stage) => stage.find("Circle").some((n) => n.fill() === c)) ?? false;
  }, color);
}

describe("raccoon-vtt: the side panel's tabs in one row with a grouped More menu", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    // After the sockets' sessions: the safe area override holds only from the page's latest DevTools session.
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

  test("0. a DM's room with a goblin, a journal page Pat can read, a pin on a page, and Pat at a computer", async () => {
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
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", x: 8, y: 6, disposition: "hostile", actor: { inline: actor(7) } } });
    await ops.send({ t: "journal.create", page: { id: run.lore, title: "Lore", access: "all", blocks: [{ id: randomUUID().replace(/-/g, "").slice(0, 12), text: "The citadel fell." }] } });
    await ops.send({ t: "journal.create", page: { id: run.pinPage, title: "Old well", access: "dm", blocks: [] } });
    await ops.send({ t: "pin.put", pin: { id: run.pin, sceneId: run.sceneId, x: 14.5, y: 9.5, color: "#f7df00", label: "Old well", pageId: run.pinPage, visibility: "dm" } });
    await waitFor("the goblin and the pin in the DM's view", () => (dmSocket.state?.tokens[run.goblin] && dmSocket.state?.pins?.[run.pin] ? true : null));

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("1. one row at every computer and tablet size, the role's panels in order across the row and More, and More's groups", async () => {
    const sizes = [
      { width: 1280, height: 800, scales: [0.85, 1, 1.3] },
      { width: 900, height: 800, scales: [1] },
      { width: 1180, height: 820, scales: [1, 1.3] },
    ];
    for (const [page, cdp, panels, shape] of [
      [dm, dmCdp, DM_PANELS, DM_MENU],
      [pat, patCdp, PLAYER_PANELS, PLAYER_MENU],
    ] as const) {
      for (const size of sizes) {
        for (const scale of size.scales) {
          const at = `${page === dm ? "DM" : "Pat"} at ${size.width} x ${size.height} at ${scale * 100}%`;
          await view(page, cdp, size);
          await reloadAt(page, scale);
          await tablist(page).getByRole("tab").first().waitFor();
          assert.deepEqual(await oneLine(page), { tops: 1, scrolls: false }, `${at}: one line`);
          const row = await rowTitles(page);
          const rowBox = await box(tablist(page).locator(".."));
          assert.ok(rowBox.height <= (44 + 16 + 1) * scale + 1, `${at}: the row is one tab tall with its padding, ${rowBox.height} px`);
          if (size.width === 1280) assert.deepEqual(row, ["Token", "Initiative", "Log"], `${at}: the row`);
          await more(page).click();
          await menu(page).waitFor();
          const items = (await menuShape(page)).filter((s) => !s.startsWith("#") && s !== "---");
          assert.deepEqual([...row, ...items], panels, `${at}: the row and More hold the panels in order, each once`);
          if (size.width === 1280 && scale === 1) {
            assert.deepEqual(await menuShape(page), shape, `${at}: More's groups`);
            await shots.take(page, `paneltabs-${page === dm ? "dm" : "player"}-1280x800-menu`);
          }
          await page.keyboard.press("Escape");
          await menu(page).waitFor({ state: "detached" });
        }
      }
      await view(page, cdp, { width: 1280, height: 800 });
      await reloadAt(page, 1);
    }
  });

  test("2. a panel opened from More names More and moves nothing, and a badge never widens a tab", async () => {
    await openSideTab(dm, "Initiative");
    const before = await rowBoxes(dm);
    for (const title of DM_PANELS.slice(3)) {
      await more(dm).click();
      await menu(dm).getByRole("menuitemradio", { name: sideTabName(title) }).click();
      await dm.getByRole("tabpanel", { name: sideTabName(title) }).waitFor();
      assert.ok(await tablist(dm).getByRole("tab", { name: sideTabName(title), selected: true }).isVisible(), `More is named ${title} and chosen`);
      assert.ok(await isFocused(more(dm)), `focus is on More after picking ${title}`);
      assert.equal(await menu(dm).count(), 0, "the menu is gone");
      const now = await rowBoxes(dm);
      assert.ok(
        now.every((b, i) => sameBox(b, before[i]!)),
        `picking ${title} moved a tab or Hide panels: ${JSON.stringify(before)} to ${JSON.stringify(now)}`,
      );
    }
    await shots.take(dm, "paneltabs-dm-menu-chosen-in-more");
    await tablist(dm).getByRole("tab", { name: "Initiative", exact: true }).click();
    assert.ok(await tablist(dm).getByRole("tab", { name: "More panels" }).isVisible(), "More is More panels again");

    const log = tablist(dm).getByRole("tab", { name: sideTabName("Log") });
    const logBefore = await box(log);
    const patCookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: patCookie });
    try {
      await patOps.send({ t: "log.chat", text: "Are we there yet?" });
    } finally {
      patOps.close();
    }
    await tablist(dm).getByRole("tab", { name: "Log 1 unread" }).waitFor();
    assert.ok(sameBox(await box(log), logBefore), "the badge sits on the corner and leaves Log's box");
    await shots.take(dm, "paneltabs-dm-log-badge");
    await log.click();
  });

  test("3. More's keys and its menu's, with a goblin selected and the Select tool", async () => {
    const p = await pagePoint(dm, run.bounds, { x: 8.5, y: 6.5 });
    await dm.mouse.click(p.x, p.y);
    await dm.getByRole("dialog", { name: "Goblin actions" }).waitFor();
    const goblinAt = () => {
      const t = dmSocket.state?.tokens[run.goblin];
      return t ? { x: t.x, y: t.y } : null;
    };
    const at = goblinAt();
    const log = tablist(dm).getByRole("tab", { name: sideTabName("Log") });
    const item = (title: string) => menu(dm).getByRole("menuitemradio", { name: sideTabName(title) });
    const on = async (title: string, why: string) => waitFor(why, async () => ((await isFocused(item(title))) ? true : null), 2_000);

    await openSideTab(dm, "Log");
    await log.focus();
    await dm.keyboard.press("ArrowRight");
    assert.ok(await isFocused(more(dm)), "Right from Log goes to More");
    assert.equal(await log.getAttribute("aria-selected"), "true", "and Log stays chosen");
    await dm.keyboard.press("Enter");
    await on("Journal", "Enter opens the menu at its first item");
    await dm.keyboard.press("ArrowDown");
    await on("Areas", "Down");
    await dm.keyboard.press("ArrowUp");
    await on("Journal", "Up");
    await dm.keyboard.press("End");
    await on("Menu", "End");
    await dm.keyboard.press("Home");
    await on("Journal", "Home");
    await dm.keyboard.press("m");
    await on("Monsters", "m");
    await dm.keyboard.press("m");
    await on("Menu", "m again");
    await dm.waitForTimeout(600);
    await dm.keyboard.press("c");
    await on("Characters", "c");
    // In the menu, the arrows and a tool's letter leave the goblin and the tool as they were.
    await dm.keyboard.press("ArrowLeft");
    await dm.keyboard.press("ArrowRight");
    await dm.keyboard.press("r");
    await dm.waitForTimeout(600);
    await on("Characters", "Left, Right and r");
    assert.equal(await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Select", exact: true }).getAttribute("aria-pressed"), "true", "the tool is still Select");
    await dm.keyboard.press("Enter");
    await dm.getByRole("tabpanel", { name: "Characters" }).waitFor();
    assert.ok(await isFocused(tablist(dm).getByRole("tab", { name: "Characters", selected: true })), "Enter picks: focus on More named Characters");
    assert.equal(await menu(dm).count(), 0);

    await dm.keyboard.press("ArrowDown");
    await on("Characters", "Down opens the menu on the open panel");
    await dm.keyboard.press("Escape");
    await menu(dm).waitFor({ state: "detached" });
    assert.ok(await isFocused(more(dm)), "Escape: focus back on More");

    await dm.keyboard.press("Enter");
    await on("Characters", "opened again by a key");
    await dm.keyboard.press("Tab");
    await menu(dm).waitFor({ state: "detached" });
    assert.ok(await isFocused(hidePanels(dm)), "Tab closes it and goes on to Hide panels");

    await more(dm).focus();
    await dm.keyboard.press("Enter");
    await on("Characters", "opened again by a key");
    await dm.keyboard.press("Shift+Tab");
    await menu(dm).waitFor({ state: "detached" });
    assert.ok(await isFocused(more(dm)), "Shift+Tab closes it and goes back to More");

    await more(dm).click();
    await menu(dm).waitFor();
    assert.ok(await isFocused(more(dm)), "opened by a click, focus stays on More");
    await dm.keyboard.press("ArrowDown");
    await on("Characters", "Down moves focus into the open menu");
    await dm.keyboard.press("Escape");
    await menu(dm).waitFor({ state: "detached" });

    // Left from Token goes round to More and chooses nothing.
    await tablist(dm).getByRole("tab", { name: "Token", exact: true }).click();
    await dm.keyboard.press("ArrowLeft");
    assert.ok(await isFocused(more(dm)), "Left from Token wraps to More");
    assert.equal(await more(dm).getAttribute("aria-selected"), "false", "More chooses nothing");
    assert.equal(await menu(dm).count(), 0, "and opens nothing");

    // With the Journal showing a page, picking the Journal by keyboard leaves focus on More, not on the page's title.
    await openSideTab(dm, "Journal");
    await dm.getByRole("tabpanel", { name: sideTabName("Journal") }).getByRole("button", { name: /^Lore/ }).click();
    await dm.getByRole("heading", { name: "Lore" }).waitFor();
    await tablist(dm).getByRole("tab", { name: "Token", exact: true }).click();
    await dm.keyboard.press("ArrowLeft");
    await dm.keyboard.press("Enter");
    await on("Journal", "Enter on More");
    await dm.keyboard.press("Enter");
    await dm.getByRole("heading", { name: "Lore" }).waitFor();
    assert.ok(await isFocused(more(dm)), "focus stays on More");
    await dm.getByRole("button", { name: "Back to Journal" }).click();

    await dm.waitForTimeout(500);
    assert.deepEqual(goblinAt(), at, "the goblin stayed where it was");
    await dm.keyboard.press("Escape");
    await dm.getByRole("dialog", { name: "Goblin actions" }).waitFor({ state: "detached" });
  });

  test("4. a panel in More opened from elsewhere: /, Add token's Monsters, a pin's page, and Details opens Token in the row", async () => {
    await openSideTab(dm, "Initiative");
    const before = await rowBoxes(dm);
    const unmoved = async (why: string) => {
      const now = await rowBoxes(dm);
      assert.ok(
        now.every((b, i) => sameBox(b, before[i]!)),
        `${why} moved a tab`,
      );
      assert.equal(await menu(dm).count(), 0, `${why} opened the menu`);
    };

    await dm.keyboard.press("/");
    await tablist(dm).getByRole("tab", { name: "Outliner", selected: true }).waitFor();
    await waitFor("focus in the Outliner's search", async () => ((await isFocused(dm.getByRole("searchbox", { name: "Search the scene" }).or(dm.getByLabel("Search the scene")))) ? true : null), 3_000);
    await unmoved("/");

    await dm.keyboard.press("Escape");
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Add token", exact: true }).click();
    await dm.getByRole("button", { name: "Monster…", exact: true }).click();
    await tablist(dm).getByRole("tab", { name: "Monsters", selected: true }).waitFor();
    await unmoved("Add token's Monsters");
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Select", exact: true }).click();

    await tapCell(dm, run.bounds, { x: 14, y: 9 });
    await tablist(dm).getByRole("tab", { name: sideTabName("Journal"), selected: true }).waitFor();
    await dm.getByRole("heading", { name: "Old well" }).waitFor();
    await unmoved("a pin's page");
    await shots.take(dm, "paneltabs-dm-pin-page-in-more");
    await dm.getByRole("button", { name: "Back to Journal" }).click();

    const p = await pagePoint(dm, run.bounds, { x: 8.5, y: 6.5 });
    await dm.mouse.click(p.x, p.y);
    await dm.getByRole("dialog", { name: "Goblin actions" }).getByRole("button", { name: "Details", exact: true }).click();
    await tablist(dm).getByRole("tab", { name: "Token", exact: true, selected: true }).waitFor();
    await unmoved("Details");
    await dm.keyboard.press("Escape");
    await openSideTab(dm, "Initiative");
  });

  test("5. a count on a panel in More shows on More's corner, in its description and on the item, never in its name", async () => {
    await openSideTab(pat, "Initiative");
    await ops.send({ t: "journal.update", pageId: run.lore, patch: { blocks: [{ id: randomUUID().replace(/-/g, "").slice(0, 12), text: "The citadel fell at dawn." }] } });
    await waitFor("More's description says 1 unread", async () => ((await moreDescription(pat)) === "1 unread" ? true : null));
    assert.equal(await tablist(pat).getByRole("tab", { name: "More panels", exact: true }).count(), 1, "More's name has no unread");
    assert.equal(((await more(pat).textContent()) ?? "").includes("1"), true, "More's corner badge shows 1");
    await more(pat).click();
    await menu(pat).getByRole("menuitemradio", { name: "Journal 1 unread" }).waitFor();
    await shots.take(pat, "paneltabs-player-more-badge");
    await pat.keyboard.press("Escape");
  });

  test("6. hidden and shown: focus on More, the menu closed, and a large phone held sideways cuts a name and names it above the panel", async () => {
    await openSideTab(dm, "Monsters");
    await hidePanels(dm).click();
    await sidePanel(dm).waitFor({ state: "hidden" });
    await panelsButton(dm).click();
    await sidePanel(dm).waitFor();
    assert.ok(await isFocused(tablist(dm).getByRole("tab", { name: "Monsters", selected: true })), "Panels gives focus to More named Monsters");

    await more(dm).click();
    await menu(dm).waitFor();
    await hidePanels(dm).click();
    await sidePanel(dm).waitFor({ state: "hidden" });
    assert.equal(await menu(dm).count(), 0, "Hide panels closed the menu");
    await panelsButton(dm).click();
    await sidePanel(dm).waitFor();
    assert.equal(await menu(dm).count(), 0, "and it stays closed when the side panel shows");

    await view(dm, dmCdp, { width: 932, height: 430 }, { side: 59, bottom: 21 });
    await reloadAt(dm, 1, "clear");
    assert.equal(await sidePanel(dm).isHidden(), true, "a short layout with no stored choice starts hidden");
    await panelsButton(dm).click();
    await sidePanel(dm).waitFor();
    assert.ok(await isFocused(tablist(dm).getByRole("tab", { name: "Initiative", exact: true })), "Panels gives focus to the Initiative tab");
    assert.deepEqual(await rowTitles(dm), ["Token", "Initiative"]);
    await openSideTab(dm, "Encounters");
    const span = more(dm).locator("span").first();
    assert.ok(await span.evaluate((el) => (el as unknown as DomEl).scrollWidth > (el as unknown as DomEl).clientWidth), "More's title is cut");
    assert.ok(await tablist(dm).getByRole("tab", { name: "Encounters", exact: true, selected: true }).isVisible(), "More's name is the whole title");
    await sidePanel(dm).getByRole("heading", { name: "Encounters", exact: true }).waitFor();
    await shots.take(dm, "paneltabs-dm-932x430-encounters-cut");
    await openSideTab(dm, "Initiative");

    await view(dm, dmCdp, { width: 1280, height: 800 });
    await reloadAt(dm, 1);
    await openSideTab(dm, "Log");
    await tablist(dm).getByRole("tab", { name: sideTabName("Log") }).focus();
    await view(dm, dmCdp, { width: 932, height: 430 }, { side: 59, bottom: 21 });
    await waitFor("Log in More, and focus on More", async () => ((await isFocused(more(dm))) ? true : null), 3_000);
    assert.ok(await tablist(dm).getByRole("tab", { name: sideTabName("Log"), selected: true }).isVisible(), "More names the Log");
    await view(dm, dmCdp, { width: 1280, height: 800 });
    await openSideTab(dm, "Initiative");
  });

  test("7. every panel opens with at most two taps, and every tab, More and item is whole, in the side panel and takes a tap", async () => {
    const sizes: { width: number; height: number; scales: number[]; insets?: Insets }[] = [
      { width: 900, height: 800, scales: [1] },
      { width: 1280, height: 800, scales: [0.85, 1, 1.15, 1.3] },
      { width: 1180, height: 820, scales: [1, 1.3] },
      { width: 844, height: 390, scales: [0.85], insets: { side: 47, bottom: 21 } },
      { width: 932, height: 430, scales: [1], insets: { side: 59, bottom: 21 } },
    ];
    const misses: string[] = [];
    for (const [page, cdp, panels] of [
      [dm, dmCdp, DM_PANELS],
      [pat, patCdp, PLAYER_PANELS],
    ] as const) {
      for (const size of sizes) {
        for (const scale of size.scales) {
          const at = `${page === dm ? "DM" : "Pat"} ${size.width}x${size.height}@${scale}`;
          await view(page, cdp, size, size.insets);
          await reloadAt(page, scale);
          if (await sidePanel(page).isHidden()) await panelsButton(page).click();
          await sidePanel(page).waitFor();
          const reach = async (target: Locator, what: string) => {
            const r = await target.evaluate((el, s) => {
              const e = el as unknown as DomEl;
              const b = e.getBoundingClientRect();
              const aside = (e as unknown as { closest(sel: string): DomEl | null }).closest("aside")!.getBoundingClientRect();
              const win = globalThis as unknown as { innerWidth: number; innerHeight: number };
              const top = e.ownerDocument.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return {
                w: b.width / s,
                h: b.height / s,
                inside: b.left >= aside.left - 0.5 && b.right <= aside.right + 0.5 && b.top >= aside.top - 0.5 && b.bottom <= aside.bottom + 0.5,
                screen: b.left >= -0.5 && b.top >= -0.5 && b.right <= win.innerWidth + 0.5 && b.bottom <= win.innerHeight + 0.5,
                tap: top !== null && e.contains(top),
              };
            }, scale);
            if (r.w < 43.5 || r.h < 43.5) misses.push(`${at}: ${what} is ${r.w.toFixed(1)} x ${r.h.toFixed(1)}`);
            if (!r.inside) misses.push(`${at}: ${what} is not inside the side panel`);
            if (!r.screen) misses.push(`${at}: ${what} is off the screen`);
            if (!r.tap) misses.push(`${at}: ${what} takes no tap at its center`);
          };
          const line = await oneLine(page);
          if (line.tops !== 1 || line.scrolls) misses.push(`${at}: the row is not one line ${JSON.stringify(line)}`);
          const row = await rowTitles(page);
          for (const title of row) await reach(tablist(page).getByRole("tab", { name: sideTabName(title) }), title);
          if (row.length < panels.length) {
            await reach(more(page), "More");
            await more(page).click();
            await menu(page).waitFor();
            const inner = await sidePanel(page).evaluate((el) => {
              const r = (el as unknown as DomEl).getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            });
            const mb = await box(menu(page).locator(".."));
            if (mb.x < inner.left - 0.5 || mb.x + mb.width > inner.right + 0.5 || mb.y < inner.top - 0.5 || mb.y + mb.height > inner.bottom + 0.5) misses.push(`${at}: the menu leaves the side panel`);
            for (const title of panels.slice(row.length)) {
              const item = menu(page).getByRole("menuitemradio", { name: sideTabName(title) });
              await item.scrollIntoViewIfNeeded();
              await reach(item, `${title} in More`);
            }
            await page.keyboard.press("Escape");
            await menu(page).waitFor({ state: "detached" });
          }
          // At most two taps: its tab, or More then its item.
          for (const title of panels) {
            await openSideTab(page, title);
            if (!(await tablist(page).getByRole("tab", { name: sideTabName(title), selected: true }).isVisible())) misses.push(`${at}: ${title} did not open`);
          }
          await openSideTab(page, "Initiative");
          if (size.width === 844) await shots.take(page, `paneltabs-${page === dm ? "dm" : "player"}-844x390-85`);
        }
      }
      await view(page, cdp, { width: 1280, height: 800 });
      await reloadAt(page, 1);
      if (await sidePanel(page).isHidden()) await panelsButton(page).click();
    }
    assert.deepEqual(misses, []);
  });

  test("8. a font as wide as DejaVu Sans keeps Token, Initiative and Log, cuts Encounters on More and names it above the panel", async () => {
    // Verdana, which macOS has, draws these titles within a few px of DejaVu Sans (3.2). The room's CSP refuses a page's own style element, so this DM's second window lets the test add one.
    const wide = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true, storageState: await dmContext.storageState() });
    try {
      const page = await wide.newPage();
      const watch = new ConsoleWatch("dm, Verdana");
      watch.attach(page);
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await tablist(page).getByRole("tab").first().waitFor();
      await page.addStyleTag({ content: 'aside, aside * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
      await page.waitForTimeout(300);
      await openSideTab(page, "Initiative");
      assert.deepEqual(await rowTitles(page), ["Token", "Initiative", "Log"]);
      const before = await rowBoxes(page);
      await openSideTab(page, "Encounters");
      const span = more(page).locator("span").first();
      assert.ok(await span.evaluate((el) => (el as unknown as DomEl).scrollWidth > (el as unknown as DomEl).clientWidth), "More's title is cut");
      assert.ok(await tablist(page).getByRole("tab", { name: "Encounters", exact: true, selected: true }).isVisible(), "More's name is the whole title");
      await page.getByRole("tabpanel", { name: "Encounters", exact: true }).waitFor();
      await sidePanel(page).getByRole("heading", { name: "Encounters", exact: true }).waitFor();
      await shots.take(page, "paneltabs-dm-wide-font-encounters");
      assert.ok((await rowBoxes(page)).every((b, i) => sameBox(b, before[i]!)), "Encounters moved a tab");
      await openSideTab(page, "Journal");
      assert.equal(await sidePanel(page).getByRole("heading", { name: "Journal", exact: true }).count(), 0, "a whole name gets no header");
      assert.ok((await rowBoxes(page)).every((b, i) => sameBox(b, before[i]!)), "Journal moved a tab");
      await openSideTab(page, "Initiative");
      assert.deepEqual(watch.errors, [], "the page logged errors");
    } finally {
      await wide.close();
    }
  });

  test("9. the shared popover base: Back closes the menu and stays in the room, and on a touch screen a tap on the map only closes it while a pinch keeps it open", async () => {
    await openSideTab(dm, "Initiative");
    const room = dm.url();
    await more(dm).click();
    await menu(dm).waitFor();
    await dm.goBack();
    await menu(dm).waitFor({ state: "detached" });
    assert.equal(dm.url(), room, "Back closed the menu, not the room");
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();

    const touch = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
    try {
      const page = await touch.newPage();
      const watch = new ConsoleWatch("touch");
      watch.attach(page);
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await touch.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
      const { ticket } = (await joined.json()) as { ticket: string };
      await touch.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Quin", color: "#e93d82" } });
      watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      const cdp = await touch.newCDPSession(page);
      const fingers = (type: "touchStart" | "touchMove" | "touchEnd", points: [number, number][]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
      await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Ping", exact: true }).tap();
      const pink = "#e93d82";
      const spot = await pagePoint(page, run.bounds, { x: 4.5, y: 12.5 });

      await more(page).tap();
      await menu(page).waitFor();
      await fingers("touchStart", [[spot.x, spot.y]]);
      await page.waitForTimeout(50);
      await fingers("touchStart", [
        [spot.x, spot.y],
        [spot.x + 120, spot.y + 60],
      ]);
      await fingers("touchMove", [
        [spot.x - 10, spot.y - 10],
        [spot.x + 140, spot.y + 80],
      ]);
      await fingers("touchEnd", [[spot.x + 140, spot.y + 80]]);
      await fingers("touchEnd", []);
      await page.waitForTimeout(300);
      assert.equal(await menu(page).count(), 1, "a pinch with fingers 50 ms apart leaves the menu open");
      assert.equal(await circleFilled(page, pink), false, "and pings nothing");

      await fingers("touchStart", [[spot.x, spot.y]]);
      await page.waitForTimeout(80);
      assert.equal(await menu(page).count(), 1, "one finger down: still open");
      await fingers("touchEnd", []);
      await menu(page).waitFor({ state: "detached" });
      await page.waitForTimeout(400);
      assert.equal(await circleFilled(page, pink), false, "the tap that closed the menu pinged nothing");
      await shots.take(page, "paneltabs-touch-menu-closed-no-ping");

      await fingers("touchStart", [[spot.x, spot.y]]);
      await fingers("touchEnd", []);
      await waitFor("the next tap pings", async () => ((await circleFilled(page, pink)) ? true : null), 2_500);
      assert.deepEqual(watch.errors, [], "the touch page logged errors");
    } finally {
      await touch.close();
    }
  });

  test("10. no page logged an error or a warning", () => {
    for (const c of [dmConsole, patConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
