import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Two panels in the side panel (docs/design-v1-split-panel.md 12.2), on
 * the real server serving the production build: "Two panels" on and off,
 * the tabs picking the top panel, the bar's name picking the bottom one,
 * links landing in the other pane, the bar's drag and keys, a side panel
 * too short for two, crossing 900 px, O and the panes' names, the bar's
 * reach at every wide size, and "view as a player".
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventeen, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 17;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-splitpanel-"));
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

const GOBLINS = 9;

const run = {
  roomId: "",
  roomName: `E2E split panel ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  patId: "",
  password: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  goblins: Array.from({ length: GOBLINS }, () => randomUUID()),
  lore: randomUUID(),
  pinPage: randomUUID(),
  pin: randomUUID(),
};

/** Where Goblin 1 stands, and where to tap it. */
const GOBLIN_AT = { x: 8, y: 6 };

type Insets = { side?: number; bottom?: number };

/** The page's document as code run in the browser reads it: the e2e files compile without the DOM's types. */
type DomEl = {
  ownerDocument: { activeElement: unknown; getElementById(id: string): DomEl | null };
  textContent: string | null;
  scrollTop: number;
  scrollLeft: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { top: number; left: number; right: number; bottom: number; width: number; height: number };
};

function actor(hp: number, extra: Record<string, unknown> = {}) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...extra };
}

/** Runs code in the page and hands back what it returns. */
function js<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(() => { ${body} })()`) as Promise<T>;
}

async function view(page: Page, cdp: CDPSession, size: { width: number; height: number }, insets: Insets = {}): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: insets.bottom ?? 0, left: insets.side ?? 0, right: insets.side ?? 0 } });
  await page.setViewportSize(size);
  await page.waitForTimeout(250);
}

/** Reloads at an interface size. `fresh` clears what this device remembers of the side panel and its split. */
async function reloadAt(page: Page, scale: number, fresh = false): Promise<void> {
  await page.evaluate(
    ({ s, clear }) => {
      const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage;
      store.setItem("rvtt.uiScale", String(s));
      if (clear) {
        store.removeItem("rvtt.sidePanel");
        store.removeItem("rvtt.sidePanelSplit");
      }
    },
    { s: scale, clear: fresh },
  );
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await page.waitForTimeout(300);
  await showSide(page);
}

/** Shows the side panel where a short screen started it hidden, and waits for its tabs. */
async function showSide(page: Page): Promise<void> {
  if (await sidePanel(page).isHidden()) await panelsButton(page).click();
  await tablist(page).getByRole("tab").first().waitFor();
}

const tablist = (page: Page | Locator) => page.getByRole("tablist", { name: "Panels" });
const more = (page: Page | Locator) => tablist(page).locator('[role="tab"][aria-haspopup="menu"]');
const moreMenu = (page: Page | Locator) => page.getByRole("menu", { name: "More panels" });
const belowMenu = (page: Page | Locator) => page.getByRole("menu", { name: "Panel below" });
const twoPanels = (page: Page | Locator) => moreMenu(page).getByRole("menuitemcheckbox", { name: "Two panels" });
const sidePanel = (page: Page) => page.locator('aside:has([role="tablist"][aria-label="Panels"])');
const bar = (page: Page | Locator) => page.locator("[data-pane-bar]");
const grip = (page: Page | Locator) => page.getByRole("separator", { name: "Resize the two panels" });
const belowName = (page: Page | Locator, title: string) => bar(page).getByRole("button", { name: `${title} below`, exact: true });
const swapButton = (page: Page | Locator) => page.getByRole("button", { name: "Swap panels", exact: true });
const closeButton = (page: Page | Locator, title: string) => page.getByRole("button", { name: `Close ${title}`, exact: true });
const tab = (page: Page | Locator, title: string) => tablist(page).getByRole("tab", { name: sideTabName(title) });
const topPane = (page: Page | Locator, title: string) => page.getByRole("tabpanel", { name: sideTabName(title) });
const bottomPane = (page: Page | Locator, title: string) => page.getByRole("group", { name: `${title} below`, exact: true });
const hidePanels = (page: Page) => page.getByRole("button", { name: "Hide panels" });
const panelsButton = (page: Page) => page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ });
const tokenBar = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });

function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el === (el as unknown as DomEl).ownerDocument.activeElement);
}

async function focusOn(target: Locator, why: string): Promise<void> {
  await waitFor(why, async () => ((await isFocused(target)) ? true : null), 3_000);
}

/** What the page's focus is on: its tag, role and name, for a failure message. */
function focusedText(page: Page): Promise<string> {
  return js<string>(page, `const a = document.activeElement; return a ? a.tagName + " " + (a.getAttribute("role") ?? "") + " " + (a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 40) : "none";`);
}

/** A described element's description, from the ids its aria-describedby names. */
function described(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const e = el as unknown as DomEl;
    return (e.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => e.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  });
}

/** The room under the tab row and its parts, in the page's px: the panes and the bar as drawn, null where hidden or gone. */
type Room = { room: number; top: number; bar: number | null; barTop: number | null; below: number | null };

function roomOf(page: Page): Promise<Room> {
  return js<Room>(
    page,
    `
    const room = document.querySelector("[data-split-room]");
    const [top, bar, below] = [...room.children];
    const h = (el) => (el && !el.hidden ? el.getBoundingClientRect().height : null);
    return { room: room.getBoundingClientRect().height, top: h(top), bar: h(bar), barTop: bar && !bar.hidden ? bar.getBoundingClientRect().top : null, below: h(below) };
  `,
  );
}

/** The status the side panel says what moved in. */
function statusText(page: Page): Promise<string> {
  return js<string>(page, `return document.querySelector("aside [data-split-room] ~ [role=status]")?.textContent ?? "";`);
}

async function moreOpen(page: Page): Promise<void> {
  await more(page).click();
  await moreMenu(page).waitFor();
}

/** "Two panels" in More's menu. */
async function toggleSplit(page: Page): Promise<void> {
  await moreOpen(page);
  await twoPanels(page).click();
  await moreMenu(page).waitFor({ state: "detached" });
}

async function splitWith(page: Page, top: string, below: string): Promise<void> {
  if ((await bar(page).count()) === 0) {
    await openSideTab(page, top);
    await toggleSplit(page);
  } else await openSideTab(page, top);
  if ((await belowName(page, below).count()) === 0) {
    await bar(page).getByRole("button", { name: / below$/ }).click();
    await belowMenu(page).getByRole("menuitemradio", { name: sideTabName(below) }).click();
    await belowMenu(page).waitFor({ state: "detached" });
  }
  await topPane(page, top).waitFor();
  await bottomPane(page, below).waitFor();
}

/** Ends the split, if any, with the bar's Close, or with Two panels where the bar is hidden, and puts Initiative on top. */
async function oneOnly(page: Page): Promise<void> {
  if ((await bar(page).count()) > 0) {
    if (await bar(page).isVisible()) {
      const title = ((await bar(page).getByRole("button", { name: / below$/ }).textContent()) ?? "").replace(/ below$/, "").trim();
      await closeButton(page, title).click();
    } else await toggleSplit(page);
    await bar(page).waitFor({ state: "detached" });
  }
  await openSideTab(page, "Initiative");
}

/** A tracker row's Stat block, its options opened first unless they are. */
async function rowStatBlock(pane: Locator): Promise<void> {
  const button = pane.getByRole("button", { name: "Stat block", exact: true });
  if ((await button.count()) === 0) await pane.getByRole("button", { name: "Goblin 1 options" }).click();
  await button.click();
}

/** The stored split, as this device keeps it. */
function stored(page: Page): Promise<Record<string, { share?: number; top?: string; below?: string }> | null> {
  return js(page, `const raw = localStorage.getItem("rvtt.sidePanelSplit"); return raw ? JSON.parse(raw) : null;`);
}

async function tapGoblin(page: Page): Promise<void> {
  const p = await pagePoint(page, run.bounds, { x: GOBLIN_AT.x + 0.5, y: GOBLIN_AT.y + 0.5 });
  await page.mouse.click(p.x, p.y);
  await tokenBar(page, "Goblin 1").waitFor();
}

describe("raccoon-vtt: two panels in the side panel", { timeout: 1_200_000 }, () => {
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

  test("0. a DM's room in a fight with nine goblins and Pat's Thorn, a long journal page with a wide table, and a pin on a page", async () => {
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
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    await ops.send({ t: "token.create", token: { id: run.thorn, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: 4, y: 6, disposition: "ally", actor: { ref: run.thornChar } } });
    for (const [i, id] of run.goblins.entries()) {
      const at = i === 0 ? GOBLIN_AT : { x: 14 + (i % 4), y: 2 + Math.floor(i / 4) * 2 };
      await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", number: i + 1, ...at, disposition: "hostile", actor: { inline: actor(10, { srdId: "goblin-warrior" }) } } });
    }
    // Words with no break in them, so the table is wider than any pane and scrolls sideways.
    const columns = Array.from({ length: 14 }, (_, i) => `Columnnumber${i + 1}withalongname`);
    const table = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((_, i) => `cell ${i + 1}`).join(" | ")} |`].join("\n");
    const prose = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: the citadel fell at dawn, and the river ran red for a week.`).join("\n\n");
    const block = (text: string) => ({ id: randomUUID().replace(/-/g, "").slice(0, 12), text });
    await ops.send({ t: "journal.create", page: { id: run.lore, title: "Lore", access: "all", blocks: [block(`${prose}\n\n${table}\n\nThe end.`)] } });
    await ops.send({ t: "journal.create", page: { id: run.pinPage, title: "Old well", access: "dm", blocks: [] } });
    await ops.send({ t: "pin.put", pin: { id: run.pin, sceneId: run.sceneId, x: 22.5, y: 14.5, color: "#f7df00", label: "Old well", pageId: run.pinPage, visibility: "dm" } });
    const entries = [{ id: "e-thorn", tokenId: run.thorn, value: 25 }, ...run.goblins.map((tokenId, i) => ({ id: `e-g${i}`, tokenId, value: 20 - i }))];
    await ops.send({ t: "encounter.start", entries });
    await ops.send({ t: "encounter.next" });
    for (let i = 0; i < 40; i++) await ops.send({ t: "log.chat", text: `Message ${i + 1} about the goblins and the citadel.` });
    await waitFor("the fight in the DM's view", () => (dmSocket.state?.encounter?.entries.length === GOBLINS + 1 && dmSocket.state.pins?.[run.pin] ? true : null));

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
    await reloadAt(dm, 1, true);
    await reloadAt(pat, 1, true);
  });

  test("1. on and off: Two panels heads More, starts Token below for the DM and Characters for a player, closes to the tab, and comes back on a reload", async () => {
    // 130% first, with nothing stored: the DM's default keeps Initiative's round header stuck.
    await reloadAt(dm, 1.3, true);
    await openSideTab(dm, "Initiative");
    await toggleSplit(dm);
    await bottomPane(dm, "Token").waitFor();
    // The room depends on the party bar's height, so the expected panes are worked out from it by the rule of 3.2: even, with Initiative given 193 own px as far as the other keeps 145.
    const at130 = await roomOf(dm);
    const space = at130.room / 1.3 - 46;
    const expected = Math.max(Math.floor(space / 2), Math.min(193, space - 145));
    assert.ok(Math.abs(at130.top / 1.3 - expected) <= 1 && at130.top / 1.3 >= 192.5, `Initiative's pane at 130%: ${JSON.stringify(at130)}, expected ${expected} own px`);
    assert.equal(await topPane(dm, "Initiative").locator("[data-round-header]").getAttribute("data-form"), "full", "Initiative's round header is full and stuck");
    // A pane's panel draws after its first load, so a picture waits for it (W6B-P-7).
    await bottomPane(dm, "Token").getByText("Tap a token to see it here.").waitFor();
    await shots.take(dm, "splitpanel-dm-1280x800-130-default");

    await reloadAt(dm, 1, true);
    await openSideTab(dm, "Initiative");
    await moreOpen(dm);
    const first = moreMenu(dm).locator('[role^="menuitem"]').first();
    assert.equal(await first.getAttribute("role"), "menuitemcheckbox", "Two panels is More's first item");
    assert.equal(((await first.textContent()) ?? "").trim(), "Two panels");
    assert.equal(await twoPanels(dm).getAttribute("aria-checked"), "false");
    await shots.take(dm, "splitpanel-dm-more-two-panels");
    await twoPanels(dm).click();
    await moreMenu(dm).waitFor({ state: "detached" });
    await topPane(dm, "Initiative").waitFor();
    await bottomPane(dm, "Token").waitFor();
    assert.ok(await isFocused(more(dm)), `focus on More, not ${await focusedText(dm)}`);
    assert.equal(await statusText(dm), "Two panels, Token below");
    assert.equal(await grip(dm).getAttribute("aria-valuenow"), "50", "the default's even split");
    assert.equal(await grip(dm).getAttribute("aria-valuetext"), "Initiative 50 percent");
    const split = await roomOf(dm);
    assert.ok(split.top >= 145 && (split.below ?? 0) >= 145, `each pane at least 145 px: ${JSON.stringify(split)}`);
    assert.equal(await described(tab(dm, "Token")), "Shown below");
    await bottomPane(dm, "Token").getByText("Tap a token to see it here.").waitFor();
    await shots.take(dm, "splitpanel-dm-initiative-over-token");

    // Each pane scrolls on its own.
    const topBody = topPane(dm, "Initiative");
    await topBody.evaluate((el) => ((el as unknown as DomEl).scrollTop = 200));
    const scrolled = await topBody.evaluate((el) => (el as unknown as DomEl).scrollTop);
    assert.ok(scrolled > 0, "Initiative scrolls in its pane");
    assert.deepEqual(await roomOf(dm), split, "scrolling one pane moved nothing else");
    await topBody.evaluate((el) => ((el as unknown as DomEl).scrollTop = 0));

    await closeButton(dm, "Token").click();
    await bar(dm).waitFor({ state: "detached" });
    assert.equal(await bottomPane(dm, "Token").count(), 0, "one pane");
    await focusOn(tab(dm, "Initiative"), "Close puts focus on the Initiative tab");
    const one = await roomOf(dm);
    assert.equal(one.bar, null);
    assert.ok(Math.abs(one.top - one.room) <= 0.5, "the top pane fills the room");

    await toggleSplit(dm);
    await grip(dm).focus();
    await dm.keyboard.press("Shift+ArrowDown");
    const kept = await roomOf(dm);
    await reloadAt(dm, 1);
    await bottomPane(dm, "Token").waitFor();
    assert.deepEqual(await roomOf(dm), kept, "the panels and the bar's place come back");
    assert.equal(await statusText(dm).then((s) => s === "" || s === "Two panels, Token below"), true);

    await openSideTab(pat, "Initiative");
    await toggleSplit(pat);
    const card = bottomPane(pat, "Characters");
    await card.waitFor();
    await waitFor("Thorn's card open below", async () => ((await card.getByLabel("Character name").inputValue().catch(() => "")) === "Thorn" ? true : null), 5_000);
    await shots.take(pat, "splitpanel-player-initiative-over-characters");
    await oneOnly(pat);
  });

  test("2. the tabs pick the top panel, its bottom one's tab swaps, a swap keeps scroll and focus, and the row never moves", async () => {
    await oneOnly(dm);

    // Tab changes without a swap, each panel scrolled, keep no panel that left in memory (W6B-ASTRA-04): the page's DOM nodes after a collection do not grow with them.
    const nodes = async () => {
      await dmCdp.send("HeapProfiler.collectGarbage");
      return ((await dmCdp.send("Memory.getDOMCounters")) as { nodes: number }).nodes;
    };
    const cycle = async () => {
      for (const title of ["Log", "Journal", "Library", "Initiative"]) {
        await openSideTab(dm, title);
        await js(dm, `document.querySelector("[role=tabpanel]").scrollTop = 80; return null;`);
        await dm.waitForTimeout(60);
      }
    };
    await cycle();
    await cycle();
    const settled = await nodes();
    for (let i = 0; i < 6; i++) await cycle();
    const grown = (await nodes()) - settled;
    assert.ok(grown < 400, `24 more tab changes kept ${grown} DOM nodes`);

    const oneRow = await Promise.all([...(await tablist(dm).getByRole("tab").all()), hidePanels(dm)].map((t) => t.boundingBox()));
    await toggleSplit(dm);
    await tab(dm, "Log").click();
    await topPane(dm, "Log").waitFor();
    await bottomPane(dm, "Token").waitFor();

    await tab(dm, "Token").click();
    await topPane(dm, "Token").waitFor();
    await bottomPane(dm, "Log").waitFor();
    assert.equal(await statusText(dm), "Token on top, Log below");
    assert.ok(await isFocused(tab(dm, "Token")), "focus on the tab pressed");

    // Initiative on top, scrolled, and the Lore page below, scrolled down to its table and the table scrolled sideways.
    await openSideTab(dm, "Initiative");
    await belowName(dm, "Log").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
    const journal = bottomPane(dm, "Journal");
    await journal.getByRole("button", { name: /^Lore/ }).click();
    await journal.getByRole("heading", { name: "Lore" }).waitFor();
    await journal.locator("table").scrollIntoViewIfNeeded();
    // The nearest box that scrolls the table sideways, whichever it is, marked so it is found again after the swap.
    await js(
      dm,
      `let el = document.querySelector("[data-split-room] table").parentElement;
      while (el && !(el.scrollWidth > el.clientWidth + 1)) el = el.parentElement;
      el.dataset.e2eWide = "";
      el.scrollLeft = 150;
      return null;`,
    );
    const wide = dm.locator("[data-e2e-wide]");
    // Offsets both pane heights hold, since a swap gives each panel the other's height and a shorter scroll range.
    await js(dm, `document.querySelectorAll("[data-split-room] [data-pane-body]")[1].scrollTop = 300; return null;`);
    await topPane(dm, "Initiative").evaluate((el) => ((el as unknown as DomEl).scrollTop = 120));
    await dm.waitForTimeout(200);
    const offsets = async () => ({
      top: await topPane(dm, "Initiative").evaluate((el) => (el as unknown as DomEl).scrollTop),
      body: await js<number>(dm, `return document.querySelectorAll("[data-split-room] [data-pane-body]")[1].scrollTop;`),
      table: await wide.evaluate((el) => (el as unknown as DomEl).scrollLeft),
    });
    const before = await offsets();
    assert.ok(before.top > 0 && before.body > 0 && before.table > 0, `everything scrolled: ${JSON.stringify(before)}`);
    await swapButton(dm).focus();
    await dm.keyboard.press("Enter");
    await topPane(dm, "Journal").waitFor();
    await bottomPane(dm, "Initiative").waitFor();
    assert.ok(await isFocused(swapButton(dm)), `Enter on Swap keeps focus on Swap, not ${await focusedText(dm)}`);
    const after = {
      top: await js<number>(dm, `return document.querySelectorAll("[data-split-room] [data-pane-body]")[1].scrollTop;`),
      body: await topPane(dm, "Journal").evaluate((el) => (el as unknown as DomEl).scrollTop),
      table: await wide.evaluate((el) => (el as unknown as DomEl).scrollLeft),
    };
    assert.deepEqual(after, before, "each pane's offset and the table's are as they were");
    await shots.take(dm, "splitpanel-dm-swapped-journal-over-initiative");

    // As Safari does it: focus on the page, and Swap pressed without focusing it.
    await belowName(dm, "Initiative").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    const message = bottomPane(dm, "Log").getByLabel("Message");
    await message.focus();
    await js(dm, `document.activeElement.blur(); return null;`);
    await js(dm, `[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Swap panels").click(); return null;`);
    await topPane(dm, "Log").waitFor();
    assert.equal(await js<string>(dm, `return document.activeElement === document.body ? "body" : document.activeElement?.tagName;`), "body", "focus stays on the page, never back in the composer");

    // A tab press elsewhere replaces the top, and the arrows pass the bottom panel's tab without a swap.
    await openSideTab(dm, "Initiative");
    await belowName(dm, "Journal").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    await bottomPane(dm, "Log").waitFor();
    await moreOpen(dm);
    await moreMenu(dm).getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
    await topPane(dm, "Journal").waitFor();
    await bottomPane(dm, "Log").waitFor();
    await tab(dm, "Token").click();
    await bottomPane(dm, "Log").waitFor();
    await dm.keyboard.press("ArrowRight");
    await dm.keyboard.press("ArrowRight");
    assert.ok(await isFocused(tab(dm, "Log")), "Right twice from Token rests on Log, the bottom panel's tab");
    await dm.waitForTimeout(150);
    assert.equal(await bottomPane(dm, "Log").count(), 1, "passing over it swapped nothing");
    await dm.keyboard.press("ArrowLeft");
    await topPane(dm, "Initiative").waitFor();
    await bottomPane(dm, "Log").waitFor();

    const twoRow = await Promise.all([...(await tablist(dm).getByRole("tab").all()), hidePanels(dm)].map((t) => t.boundingBox()));
    assert.equal(twoRow.length, oneRow.length);
    for (const [i, b] of twoRow.entries()) {
      const a = oneRow[i]!;
      assert.ok(a && b && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5, `box ${i} moved: ${JSON.stringify(a)} to ${JSON.stringify(b)}`);
    }

    // Each panel keeps its scroll as it leaves and shows again, by the row, More, a link, in either pane, and after a swap (the project owner, after wave 6).
    const scrollOfPane = (pane: Locator) => pane.evaluate((el) => (el as unknown as DomEl).scrollTop);
    const scrollPane = async (pane: Locator, top: number) => {
      await pane.evaluate((el, t) => ((el as unknown as DomEl).scrollTop = t), top);
      // The scroll event that records it comes with the next frame.
      await dm.waitForTimeout(120);
    };
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    await oneOnly(dm);
    await openSideTab(dm, "Log");
    await scrollPane(topPane(dm, "Log"), 300);
    await openSideTab(dm, "Initiative");
    await openSideTab(dm, "Log");
    assert.ok(near(await scrollOfPane(topPane(dm, "Log")), 300), "back by its tab, the Log is where it was");

    await openSideTab(dm, "Journal");
    // The Journal remembers the page it showed.
    if ((await topPane(dm, "Journal").getByRole("button", { name: /^Lore/ }).count()) > 0) await topPane(dm, "Journal").getByRole("button", { name: /^Lore/ }).click();
    await sidePanel(dm).getByRole("heading", { name: "Lore", exact: true }).waitFor();
    await scrollPane(topPane(dm, "Journal"), 400);
    await openSideTab(dm, "Initiative");
    await openSideTab(dm, "Journal");
    await sidePanel(dm).getByRole("heading", { name: "Lore", exact: true }).waitFor();
    assert.ok(near(await scrollOfPane(topPane(dm, "Journal")), 400), "back through More, the journal page is where it was");
    await dm.getByRole("button", { name: "Back to Journal" }).click();

    await openSideTab(dm, "Initiative");
    await scrollPane(topPane(dm, "Initiative"), 150);
    await tapGoblin(dm);
    await tokenBar(dm, "Goblin 1").getByRole("button", { name: "Details", exact: true }).click();
    await topPane(dm, "Token").waitFor();
    await dm.getByRole("button", { name: /Open the tracker\.$/ }).first().click();
    await topPane(dm, "Initiative").waitFor();
    assert.ok(near(await scrollOfPane(topPane(dm, "Initiative")), 150), "back by a link, Initiative is where it was");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");

    // Monsters fills in its list after it draws, and still comes back where it was (GR-P-1).
    await openSideTab(dm, "Monsters");
    await topPane(dm, "Monsters").getByText(/^SRD 5\.2\.1 \(\d+\)$/).waitFor();
    await scrollPane(topPane(dm, "Monsters"), 800);
    await openSideTab(dm, "Initiative");
    await openSideTab(dm, "Monsters");
    await waitFor("Monsters back at 800", async () => (near(await scrollOfPane(topPane(dm, "Monsters")), 800) ? true : null), 2_500);
    await openSideTab(dm, "Initiative");

    await toggleSplit(dm);
    await belowName(dm, "Token").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    const logBelow = bottomPane(dm, "Log").locator("[data-pane-body]");
    await scrollPane(logBelow, 200);
    await belowName(dm, "Log").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
    await bottomPane(dm, "Journal").waitFor();
    await belowName(dm, "Journal").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    assert.ok(near(await scrollOfPane(bottomPane(dm, "Log").locator("[data-pane-body]")), 200), "below, the Log is where it was");

    await swapButton(dm).click();
    await topPane(dm, "Log").waitFor();
    assert.ok(near(await scrollOfPane(topPane(dm, "Log")), 200), "a swap keeps it");
    await openSideTab(dm, "Journal");
    await openSideTab(dm, "Log");
    assert.ok(near(await scrollOfPane(topPane(dm, "Log")), 200), "after a swap, back by its tab, the Log is where it was");
  });

  test("3. the bar's name lists every panel: the bottom one checked, the top one noted, a pick lands below with focus on its name", async () => {
    await splitWith(dm, "Initiative", "Log");
    await belowName(dm, "Log").click();
    const list = belowMenu(dm);
    await list.waitFor();
    const items = await list.getByRole("menuitemradio").evaluateAll((els) => els.map((el) => ((el as unknown as { firstChild: DomEl | null }).firstChild?.textContent ?? "").trim()));
    assert.deepEqual(items, ["Token", "Initiative", "Log", "Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"]);
    assert.equal(await list.getByRole("menuitemradio", { name: sideTabName("Log") }).getAttribute("aria-checked"), "true");
    assert.equal(await described(list.getByRole("menuitemradio", { name: "Initiative" })), "Shown on top");
    assert.ok(((await list.getByRole("menuitemradio", { name: "Initiative" }).textContent()) ?? "").includes("on top"));
    await shots.take(dm, "splitpanel-dm-panel-below-menu");
    await list.getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
    await bottomPane(dm, "Journal").waitFor();
    await focusOn(belowName(dm, "Journal"), "a pick ends on the bar's name");

    // The Log below counts as on screen, so a message there marks no unread.
    await belowName(dm, "Journal").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    await bottomPane(dm, "Log").waitFor();
    const patCookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: patCookie });
    try {
      await patOps.send({ t: "log.chat", text: "Is anyone reading this?" });
    } finally {
      patOps.close();
    }
    await bottomPane(dm, "Log").getByText("Is anyone reading this?").waitFor();
    await dm.waitForTimeout(300);
    assert.equal(await tablist(dm).getByRole("tab", { name: /unread/ }).count(), 0, "the Log below marks nothing unread");
    await belowName(dm, "Log").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
    await bottomPane(dm, "Journal").waitFor();
    await belowName(dm, "Journal").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: "Initiative" }).click();
    await topPane(dm, "Journal").waitFor();
    await bottomPane(dm, "Initiative").waitFor();
  });

  test("4. links: Stat block, Details, /, a pin's page and the turn strip, with two panels and with one", async () => {
    await splitWith(dm, "Initiative", "Log");
    await rowStatBlock(topPane(dm, "Initiative"));
    await bottomPane(dm, "Token").waitFor();
    assert.equal(await topPane(dm, "Initiative").count(), 1, "Initiative stays on top");
    await waitFor("focus on the stat block's disclosure, below", async () => {
      const ok = await js<boolean>(dm, `const a = document.activeElement; return !!a && a.getAttribute("aria-expanded") === "true" && (a.textContent ?? "").trim() === "Stat block" && !!a.closest("[role=group]");`);
      return ok ? true : null;
    });
    await dm.keyboard.press("Escape");

    await belowName(dm, "Token").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    await bottomPane(dm, "Log").waitFor();
    await tapGoblin(dm);
    await tokenBar(dm, "Goblin 1").getByRole("button", { name: "Details", exact: true }).click();
    await bottomPane(dm, "Token").waitFor();
    await focusOn(belowName(dm, "Token"), "Details sends focus to the bar's name");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");

    await belowName(dm, "Token").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    await bottomPane(dm, "Log").waitFor();
    await js(dm, `document.activeElement?.blur(); return null;`);
    await dm.keyboard.press("/");
    await bottomPane(dm, "Outliner").waitFor();
    await focusOn(dm.getByLabel("Search the scene"), "/ puts focus in the Outliner's search");
    await dm.keyboard.press("Escape");

    await tapCell(dm, run.bounds, { x: 22, y: 14 });
    await bottomPane(dm, "Journal").waitFor();
    await bottomPane(dm, "Journal").getByRole("heading", { name: "Old well" }).waitFor();
    await dm.getByRole("button", { name: "Back to Journal" }).click();

    const strip = dm.getByRole("button", { name: /Open the tracker\.$/ }).first();
    await strip.click();
    await dm.waitForTimeout(200);
    assert.equal(await topPane(dm, "Initiative").count(), 1, "the turn strip moves nothing");
    assert.equal(await bottomPane(dm, "Journal").count(), 1);

    await oneOnly(dm);
    await rowStatBlock(topPane(dm, "Initiative"));
    await topPane(dm, "Token").waitFor();
    assert.equal(await bar(dm).count(), 0, "with one panel, Token replaces Initiative as before");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
    await openSideTab(dm, "Initiative");
  });

  test("5. the bar moves by a drag, clamps, stays on a reload, goes back on Escape, ignores a wobble, and steps by keys without moving a token", async () => {
    await reloadAt(dm, 1, true);
    await splitWith(dm, "Initiative", "Token");
    const g = await grip(dm).boundingBox();
    assert.ok(g);
    const x = g.x + g.width / 2;
    const y = g.y + g.height / 2;
    const start = await roomOf(dm);
    const drag = async (dy: number, end: "up" | "escape" = "up") => {
      await dm.mouse.move(x, y);
      await dm.mouse.down();
      await dm.mouse.move(x, y + dy / 2, { steps: 4 });
      await dm.mouse.move(x, y + dy, { steps: 4 });
      if (end === "escape") await dm.keyboard.press("Escape");
      await dm.mouse.up();
      await dm.waitForTimeout(150);
    };
    await drag(100);
    const moved = await roomOf(dm);
    assert.ok(Math.abs((moved.barTop ?? 0) - (start.barTop ?? 0) - 100) <= 1, `a 100 px drag moved the bar ${(moved.barTop ?? 0) - (start.barTop ?? 0)} px`);
    await reloadAt(dm, 1);
    await bottomPane(dm, "Token").waitFor();
    assert.ok(Math.abs(((await roomOf(dm)).barTop ?? 0) - (moved.barTop ?? 0)) <= 1, "a reload keeps it");

    await dm.mouse.move(x, y + 100);
    await dm.mouse.down();
    await dm.mouse.move(x, y + 40, { steps: 4 });
    const during = await roomOf(dm);
    assert.ok(Math.abs((during.barTop ?? 0) - (moved.barTop ?? 0) + 60) <= 1, "the bar follows the pointer");
    await dm.keyboard.press("Escape");
    await dm.mouse.up();
    await dm.waitForTimeout(150);
    assert.ok(Math.abs(((await roomOf(dm)).barTop ?? 0) - (moved.barTop ?? 0)) <= 1, "Escape put it back");

    const atRest = await roomOf(dm);
    await dm.mouse.move(x, (atRest.barTop ?? 0) + 23);
    await dm.mouse.down();
    await dm.mouse.move(x, (atRest.barTop ?? 0) + 29, { steps: 3 });
    await dm.mouse.up();
    assert.deepEqual(await roomOf(dm), atRest, "a 6 px wobble moves nothing");

    const gripNow = async () => {
      const b = await grip(dm).boundingBox();
      assert.ok(b);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    let p = await gripNow();
    await dm.mouse.move(p.x, p.y);
    await dm.mouse.down();
    await dm.mouse.move(p.x, p.y - 1000, { steps: 6 });
    await dm.mouse.up();
    const high = await roomOf(dm);
    assert.ok(Math.abs(high.top - 145) <= 1, `clamped at the top pane's minimum: ${high.top}`);
    p = await gripNow();
    await dm.mouse.move(p.x, p.y);
    await dm.mouse.down();
    await dm.mouse.move(p.x, p.y + 1000, { steps: 6 });
    await dm.mouse.up();
    const low = await roomOf(dm);
    assert.ok(Math.abs((low.below ?? 0) - 145) <= 1, `clamped at the bottom pane's minimum: ${low.below}`);

    // Keys, with a goblin selected: the grip owns the arrows.
    await tapGoblin(dm);
    const goblinAt = () => {
      const t = dmSocket.state?.tokens[run.goblins[0]!];
      return t ? { x: t.x, y: t.y } : null;
    };
    const was = goblinAt();
    await grip(dm).focus();
    const k0 = await roomOf(dm);
    await dm.keyboard.press("ArrowUp");
    const k1 = await roomOf(dm);
    assert.ok(Math.abs(k0.top - k1.top - 8) <= 1, `Up moved the bar ${k0.top - k1.top} px`);
    await dm.keyboard.press("Shift+ArrowUp");
    const k2 = await roomOf(dm);
    assert.ok(Math.abs(k1.top - k2.top - 64) <= 1, `Shift+Up moved the bar ${k1.top - k2.top} px`);
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowDown", "PageUp", "PageDown"]) await dm.keyboard.press(key);
    await dm.waitForTimeout(500);
    assert.deepEqual(goblinAt(), was, "no arrow on the grip moved the goblin");
    assert.equal(dmSocket.state?.tokens[run.goblins[0]!]?.elevation ?? 0, 0, "and no Page key raised it");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");

    // A tablet drags the bar with a finger.
    const tablet = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, storageState: await dmContext.storageState() });
    try {
      const page = await tablet.newPage();
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await tablist(page).getByRole("tab").first().waitFor();
      if ((await bar(page).count()) === 0) await toggleSplit(page);
      await bar(page).waitFor();
      const cdp = await tablet.newCDPSession(page);
      const b = await grip(page).boundingBox();
      assert.ok(b);
      const before = await roomOf(page);
      const tx = b.x + b.width / 2;
      const ty = b.y + b.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tx, y: ty, id: 1 }] });
      for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: tx, y: ty + i * 10, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(200);
      const after = await roomOf(page);
      assert.ok(Math.abs((after.barTop ?? 0) - (before.barTop ?? 0) - 60) <= 1.5, `a finger moved the bar ${(after.barTop ?? 0) - (before.barTop ?? 0)} px`);
      await shots.take(page, "splitpanel-tablet-dragged");
    } finally {
      await tablet.close();
    }

    // Monsters in a short bottom pane: its list fills in after the pane draws, and it still comes back where it was, three times over (GR-P-1).
    await belowName(dm, "Token").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Monsters") }).click();
    await grip(dm).focus();
    for (let i = 0; i < 8; i++) await dm.keyboard.press("Shift+ArrowDown");
    assert.ok(Math.abs(((await roomOf(dm)).below ?? 0) - 145) <= 1, "the bottom pane at its least height");
    const monsters = () => bottomPane(dm, "Monsters").locator("[data-pane-body]");
    await bottomPane(dm, "Monsters").getByText(/^SRD 5\.2\.1 \(\d+\)$/).waitFor();
    await monsters().evaluate((el) => ((el as unknown as DomEl).scrollTop = 800));
    await dm.waitForTimeout(120);
    for (const round of [1, 2, 3]) {
      await belowName(dm, "Monsters").click();
      await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
      await bottomPane(dm, "Journal").waitFor();
      await belowName(dm, "Journal").click();
      await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Monsters") }).click();
      await waitFor(`Monsters below back at 800, return ${round}`, async () => (Math.abs((await monsters().evaluate((el) => (el as unknown as DomEl).scrollTop)) - 800) <= 1 ? true : null), 2_500);
    }
    await reloadAt(dm, 1, true);
  });

  test("6. a side panel too short for two: disabled where it never fits, the bottom pane hidden and kept, and a link placed once the room is known", async () => {
    await view(dm, dmCdp, { width: 932, height: 430 }, { side: 59, bottom: 21 });
    await reloadAt(dm, 1);
    await oneOnly(dm);
    await moreOpen(dm);
    assert.equal(await twoPanels(dm).getAttribute("aria-disabled"), "true");
    assert.equal(await described(twoPanels(dm)), "The side panel is too short for two panels.");
    assert.ok(((await twoPanels(dm).textContent()) ?? "").includes("too short"));
    await shots.take(dm, "splitpanel-dm-932x430-too-short");
    await twoPanels(dm).click({ force: true });
    await dm.waitForTimeout(150);
    assert.equal(await moreMenu(dm).count(), 1, "a disabled item picks nothing");
    assert.equal(await bar(dm).count(), 0);
    await dm.keyboard.press("Escape");

    await view(pat, patCdp, { width: 932, height: 430 }, { side: 59, bottom: 21 });
    await reloadAt(pat, 1);
    await openSideTab(pat, "Initiative");
    await toggleSplit(pat);
    await bottomPane(pat, "Characters").waitFor();
    await waitFor("Thorn's card drawn below", async () => ((await bottomPane(pat, "Characters").getByLabel("Character name").inputValue().catch(() => "")) === "Thorn" ? true : null), 5_000);
    await shots.take(pat, "splitpanel-player-932x430-split");
    await oneOnly(pat);
    await view(pat, patCdp, { width: 1280, height: 800 });

    await view(dm, dmCdp, { width: 1280, height: 800 });
    await reloadAt(dm, 1);
    await splitWith(dm, "Initiative", "Log");
    await bottomPane(dm, "Log").getByLabel("Message").fill("Half a thought");
    await belowName(dm, "Log").click();
    await belowMenu(dm).waitFor();
    await view(dm, dmCdp, { width: 1280, height: 480 });
    await belowMenu(dm).waitFor({ state: "detached" });
    await bar(dm).waitFor({ state: "hidden" });
    assert.equal(await bottomPane(dm, "Log").count(), 0, "the bottom pane is hidden");
    const tall = await roomOf(dm);
    assert.ok(Math.abs(tall.top - tall.room) <= 0.5, "the top pane fills the room");
    await moreOpen(dm);
    assert.equal(await twoPanels(dm).getAttribute("aria-checked"), "true", "Two panels stays checked");
    assert.equal(await twoPanels(dm).getAttribute("aria-disabled"), null, "and enabled");
    assert.equal(await described(twoPanels(dm)), "Too short for two now. They come back when the side panel is taller.");
    await dm.keyboard.press("Escape");
    await view(dm, dmCdp, { width: 1280, height: 800 });
    await bottomPane(dm, "Log").waitFor();
    assert.equal(await bottomPane(dm, "Log").getByLabel("Message").inputValue(), "Half a thought", "the half-typed message survived");
    await bottomPane(dm, "Log").getByLabel("Message").fill("");

    // Details with the side panel hidden: placed once the room is measured.
    await hidePanels(dm).click();
    await sidePanel(dm).waitFor({ state: "hidden" });
    await view(dm, dmCdp, { width: 1280, height: 480 });
    await tapGoblin(dm);
    await tokenBar(dm, "Goblin 1").getByRole("button", { name: "Details", exact: true }).click();
    await topPane(dm, "Token").waitFor();
    assert.equal(await bar(dm).isVisible(), false, "too short for two: Token on top, in sight");
    await focusOn(tab(dm, "Token"), "focus on the Token tab");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
    await view(dm, dmCdp, { width: 1280, height: 800 });
    await splitWith(dm, "Initiative", "Log");
    await hidePanels(dm).click();
    await sidePanel(dm).waitFor({ state: "hidden" });
    await tapGoblin(dm);
    await tokenBar(dm, "Goblin 1").getByRole("button", { name: "Details", exact: true }).click();
    await bottomPane(dm, "Token").waitFor();
    assert.equal(await topPane(dm, "Initiative").count(), 1, "at 1280 x 800 Token goes below");
    await focusOn(belowName(dm, "Token"), "focus on the bar's name");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
  });

  test("7. narrow: one panel at a time, the pair kept for the next wide layout, and Party never in it", async () => {
    await splitWith(dm, "Initiative", "Token");
    // The phone's list of panels, once any sheet the crossing opened is closed.
    const list = async (title: string) => {
      const sheet = dm.getByRole("region").filter({ has: dm.getByRole("button", { name: "All panels" }) });
      if ((await sheet.count()) > 0) {
        await dm.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached" });
      }
      await panelsButton(dm).click();
      await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
      await dm.getByRole("region", { name: title }).first().waitFor();
    };
    await view(dm, dmCdp, { width: 800, height: 800 });
    await sidePanel(dm).waitFor({ state: "detached" });
    await list("Journal");
    await view(dm, dmCdp, { width: 1280, height: 800 });
    await topPane(dm, "Journal").waitFor();
    await bottomPane(dm, "Token").waitFor();
    await view(dm, dmCdp, { width: 800, height: 800 });
    await list("Party");

    await view(dm, dmCdp, { width: 1280, height: 800 });
    await topPane(dm, "Journal").waitFor();
    await bottomPane(dm, "Token").waitFor();
    const entry = (await stored(dm))?.dm;
    assert.deepEqual([entry?.top, entry?.below], ["journal", "token"]);
    assert.ok(!JSON.stringify(entry).includes("party"), "the stored entry has no Party");

    await view(dm, dmCdp, { width: 800, height: 800 });
    // One sheet's panel replaced by another keeps no subpage header behind (W6-SOL-02): Menu on Members, the turn strip opens Initiative in the same sheet, then Menu again shows its first page.
    await list("Menu");
    const menu = dm.getByRole("region", { name: "Menu" });
    await menu.getByRole("button", { name: /^Members/ }).click();
    await menu.getByRole("button", { name: "Back to Menu" }).waitFor();
    await dm.getByRole("button", { name: /Open the tracker\.$/ }).first().click();
    await dm.getByRole("region", { name: "Initiative" }).waitFor();
    assert.equal(await dm.getByRole("button", { name: "Back to Menu" }).count(), 0, "Initiative shows no Back to Menu");
    await list("Menu");
    await menu.getByRole("button", { name: /^Members/ }).waitFor();
    assert.equal(await menu.getByRole("button", { name: "Back to Menu" }).count(), 0, "Menu opens on its first page, under its own name, with no Members header left over");

    // A phone's sheet keeps each panel's scroll the same way.
    await list("Log");
    const logSheet = dm.getByRole("region", { name: "Log" }).locator("[data-pane-body]");
    await logSheet.evaluate((el) => ((el as unknown as DomEl).scrollTop = 300));
    await dm.waitForTimeout(120);
    await list("Party");
    await list("Log");
    assert.ok(Math.abs((await logSheet.evaluate((el) => (el as unknown as DomEl).scrollTop)) - 300) <= 1, "the Log's sheet opens where it was");
    await list("Party");

    await view(dm, dmCdp, { width: 1280, height: 800 });
    await openSideTab(dm, "Initiative");
  });

  test("8. O goes between the panes, the names hold, a subpage below keeps its focus rules, and / reaches a hidden Outliner", async () => {
    await splitWith(dm, "Initiative", "Journal");
    await js(dm, `document.activeElement?.blur(); return null;`);
    await dm.keyboard.press("o");
    await focusOn(tab(dm, "Initiative"), "O from the map goes to the chosen tab");
    await topPane(dm, "Initiative").getByRole("button", { name: "Goblin 1 options" }).focus();
    await dm.keyboard.press("o");
    await focusOn(belowName(dm, "Journal"), "O from the top pane goes to the bottom panel's name");
    await bottomPane(dm, "Journal").getByRole("button", { name: /^Lore/ }).focus();
    await dm.keyboard.press("o");
    await focusOn(tab(dm, "Initiative"), "O from the bottom pane goes to the chosen tab");

    await belowName(dm, "Journal").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    const message = bottomPane(dm, "Log").getByLabel("Message");
    await message.focus();
    await dm.keyboard.type("Hello o");
    assert.equal(await message.inputValue(), "Hello o", "O in a text field types");
    await message.fill("");

    // The names a screen reader hears, and every id the side panel points to exists.
    const names = await js<{ missing: string[]; dupes: string[] }>(
      dm,
      `
      const aside = document.querySelector("aside:has([role=tablist][aria-label=Panels])");
      const missing = [];
      for (const el of aside.querySelectorAll("[aria-labelledby], [aria-describedby], [aria-controls]")) {
        for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls"]) {
          for (const id of (el.getAttribute(attr) ?? "").split(" ").filter(Boolean)) if (!document.getElementById(id)) missing.push(attr + " " + id);
        }
      }
      const ids = [...aside.querySelectorAll("[id]")].map((el) => el.id);
      return { missing, dupes: ids.filter((id, i) => ids.indexOf(id) !== i) };
    `,
    );
    assert.deepEqual(names, { missing: [], dupes: [] });
    assert.equal(await dm.getByRole("tabpanel").count(), 1, "one tab panel");
    assert.equal(await grip(dm).getAttribute("aria-orientation"), "horizontal");
    const roles = await js<(string | null)[]>(dm, `return [...document.querySelector("[data-split-room]").children].map((el) => el.getAttribute("role"));`);
    assert.deepEqual(roles, [null, null, "group"], "the panes add a group and no landmark");

    // A journal page in the bottom pane: its header under the bar, Back to its row.
    await belowName(dm, "Log").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Journal") }).click();
    const journal = bottomPane(dm, "Journal");
    await journal.getByRole("button", { name: /^Lore/ }).click();
    await journal.getByRole("heading", { name: "Lore" }).waitFor();
    const header = await journal.getByRole("heading", { name: "Lore" }).boundingBox();
    const barBox = await bar(dm).boundingBox();
    assert.ok(header && barBox && header.y >= barBox.y + barBox.height - 1, "the subpage's header sits under the bar");
    await journal.getByRole("button", { name: "Back to Journal" }).click();
    await focusOn(journal.getByRole("button", { name: /^Lore/ }), "Back returns focus to its row");

    // The journal editor from the bottom pane returns focus to its opener.
    const edit = journal.getByRole("button", { name: /^Lore/ });
    await edit.click();
    const editButton = journal.getByRole("button", { name: "Edit", exact: true });
    if ((await editButton.count()) > 0) {
      await editButton.click();
      await dm.getByRole("dialog").first().waitFor();
      await dm.keyboard.press("Escape");
      await dm.getByRole("dialog").first().waitFor({ state: "detached" }).catch(() => {});
      await focusOn(editButton, "the editor returns focus to its opener");
    }
    await journal.getByRole("button", { name: "Back to Journal" }).click();

    // / with the Outliner in a hidden bottom pane.
    await belowName(dm, "Journal").click();
    await belowMenu(dm).getByRole("menuitemradio", { name: sideTabName("Outliner") }).click();
    await bottomPane(dm, "Outliner").waitFor();
    await view(dm, dmCdp, { width: 1280, height: 480 });
    await bar(dm).waitFor({ state: "hidden" });
    await js(dm, `document.activeElement?.blur(); return null;`);
    await dm.keyboard.press("/");
    await topPane(dm, "Outliner").waitFor();
    await focusOn(dm.getByLabel("Search the scene"), "/ puts focus in the search once its pane shows");
    await dm.keyboard.press("Escape");
    await view(dm, dmCdp, { width: 1280, height: 800 });
    await oneOnly(dm);
  });

  test("9. the bar's controls and both menus' items are whole, inside the side panel and take a tap, at every wide size for both roles", async () => {
    const sizes: { width: number; height: number; scales: number[]; insets?: Insets }[] = [
      { width: 1280, height: 800, scales: [1, 1.3] },
      { width: 1920, height: 1080, scales: [1, 1.3] },
      { width: 1024, height: 768, scales: [1] },
      { width: 1366, height: 768, scales: [1.3] },
      { width: 900, height: 800, scales: [1] },
      { width: 1180, height: 820, scales: [1, 1.3] },
      { width: 932, height: 430, scales: [1], insets: { side: 59, bottom: 21 } },
      { width: 844, height: 390, scales: [0.85], insets: { side: 47, bottom: 21 } },
    ];
    const misses: string[] = [];
    for (const [page, cdp] of [
      [dm, dmCdp],
      [pat, patCdp],
    ] as const) {
      for (const size of sizes) {
        for (const scale of size.scales) {
          const at = `${page === dm ? "DM" : "Pat"} ${size.width}x${size.height}@${scale}`;
          await view(page, cdp, size, size.insets);
          await reloadAt(page, scale);
          if ((await bar(page).count()) > 0 && !(await bar(page).isVisible())) continue;
          if ((await bar(page).count()) === 0) {
            await moreOpen(page);
            const disabled = (await twoPanels(page).getAttribute("aria-disabled")) === "true";
            if (disabled) {
              await page.keyboard.press("Escape");
              await moreMenu(page).waitFor({ state: "detached" });
              continue;
            }
            await twoPanels(page).click();
            await moreMenu(page).waitFor({ state: "detached" });
          }
          await bar(page).waitFor();
          const reach = async (target: Locator, what: string) => {
            const r = await target.evaluate((el, s) => {
              const e = el as unknown as DomEl & { closest(sel: string): DomEl | null; contains(o: unknown): boolean; ownerDocument: { elementFromPoint(x: number, y: number): unknown } };
              const b = e.getBoundingClientRect();
              const aside = e.closest("aside")!.getBoundingClientRect();
              const top = e.ownerDocument.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return {
                w: b.width / s,
                h: b.height / s,
                inside: b.left >= aside.left - 0.5 && b.right <= aside.right + 0.5 && b.top >= aside.top - 0.5 && b.bottom <= aside.bottom + 0.5,
                tap: top !== null && e.contains(top),
              };
            }, scale);
            if (r.w < 43.5 || r.h < 43.5) misses.push(`${at}: ${what} is ${r.w.toFixed(1)} x ${r.h.toFixed(1)}`);
            if (!r.inside) misses.push(`${at}: ${what} is not inside the side panel`);
            if (!r.tap) misses.push(`${at}: ${what} takes no tap at its center`);
          };
          const name = bar(page).getByRole("button", { name: / below$/ });
          await reach(grip(page), "the grip");
          await reach(name, "the bar's name");
          await reach(swapButton(page), "Swap");
          await reach(bar(page).getByRole("button", { name: /^Close / }), "Close");
          await name.click();
          await belowMenu(page).waitFor();
          for (const item of await belowMenu(page).getByRole("menuitemradio").all()) {
            await item.scrollIntoViewIfNeeded();
            await reach(item, `"${((await item.textContent()) ?? "").trim()}" in Panel below`);
          }
          await page.keyboard.press("Escape");
          await belowMenu(page).waitFor({ state: "detached" });
          await moreOpen(page);
          await twoPanels(page).scrollIntoViewIfNeeded();
          await reach(twoPanels(page), "Two panels in More");
          await page.keyboard.press("Escape");
          await moreMenu(page).waitFor({ state: "detached" });
          if (size.width === 1920 && scale === 1) await shots.take(page, `splitpanel-${page === dm ? "dm" : "player"}-1920x1080`);
        }
      }
      await view(page, cdp, { width: 1280, height: 800 });
      await reloadAt(page, 1);
      await oneOnly(page);
    }
    assert.deepEqual(misses, []);
  });

  test("10. view as a player splits its own side panel, and neither stored entry changes", async () => {
    await reloadAt(dm, 1);
    await splitWith(dm, "Initiative", "Token");
    await reloadAt(pat, 1);
    await openSideTab(pat, "Initiative");
    await openSideTab(dm, "DM");
    const before = await stored(dm);
    await dm.getByRole("button", { name: "View", exact: true }).first().click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    await tablist(preview).getByRole("tab").first().waitFor();
    await more(preview).click();
    await preview.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
    await preview.getByRole("group", { name: "Characters below", exact: true }).waitFor();
    await shots.take(dm, "splitpanel-preview-split");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    assert.deepEqual(await stored(dm), before, "neither the DM's entry nor the player's changed");
    await oneOnly(dm);
  });

  test("11. no page logged an error or a warning", () => {
    for (const c of [dmConsole, patConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
