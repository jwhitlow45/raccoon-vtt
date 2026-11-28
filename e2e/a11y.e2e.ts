import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { uuidv7 } from "#shared/ids.ts";
import { barControl, ConsoleWatch, openSideTab, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/*
 * The accessibility sweep: axe-core over the app's main surfaces, as the DM
 * and as a player, on a computer (1440 x 900) and an upright phone
 * (390 x 844). It reads what a screen reader or a keyboard depends on:
 * names, roles, labels, landmarks and the like. axe has no rule for where
 * Tab goes, so the board, the home, join and docs pages and the main
 * dialogs are also walked with Tab, each stop read from Chrome's
 * accessibility tree (TAB_RULES). axe is no screen reader, so a clean run
 * is no claim that the app works with one.
 *
 * The page's CSP allows only its own scripts, so axe goes in through
 * Playwright's evaluate, which the CSP does not govern, never as a script
 * tag. Each violation is grouped by its rule and the surfaces it shows on,
 * and saved, with each walk's stops, as a11y-violations.json in the
 * screenshot directory. The run fails on any violation KNOWN does not name
 * with its reason, so a fixed rule stays fixed, and a drawn page first
 * proves each check finds what it looks for. It runs on demand, by a lane,
 * never in CI, as opportunity-bench does: `A11Y_REPORT=1` lists every
 * violation without failing, for a sweep of new surfaces.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const SKIP = process.env.CI ? "the accessibility sweep runs on demand, not in CI" : false;
const REPORT_ONLY = process.env.A11Y_REPORT === "1";
/** While fixing one: `A11Y_ONLY=<pattern>` opens and scans only the surfaces whose names match. */
const ONLY = process.env.A11Y_ONLY ? new RegExp(process.env.A11Y_ONLY) : null;

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
/** WCAG 2.2 A and AA, and axe's best practices, which hold the landmark and heading rules. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const SIZES = [
  { name: "1440x900", width: 1440, height: 900, phone: false },
  { name: "390x844", width: 390, height: 844, phone: true },
] as const;
type Size = (typeof SIZES)[number];

/**
 * Violations left in place, each with why: a false positive says what axe
 * misreads, a choice says where it was made, and the rest wait for a
 * follow-up of their own. `surface` narrows an entry to the surfaces it
 * was seen on, and `node` to the nodes whose selector or words match.
 */
const KNOWN: { rule: string; surface?: RegExp; node?: RegExp; reason: string }[] = [
  {
    rule: "meta-viewport",
    surface: /^(dm|player) /,
    reason: "A choice (docs/design/design.md, pointer events): the room stops the page's own zoom, since a pinch zooms the map, and This device's Interface size scales the rest up to 130%. Home and the join page still zoom.",
  },
  {
    rule: "region",
    node: /touch-action: none|role=img> named "Map"|role=toolbar> named "[A-Za-z ]+ options"/,
    reason: "Follow-up: the map, its focus target and the tool options that float on it stand outside every landmark, since the room has no main. The top bar must stay the banner, so the fix is a main around the map's own layers.",
  },
  {
    rule: "heading-order",
    surface: /1440x900: /,
    reason: "Follow-up: the side panel names a panel by its tab, not a heading, so the panel's h3 sections follow the room's h1. A phone's sheet header is the h2 there.",
  },
  {
    rule: "label-content-name-mismatch",
    reason: "Follow-up, one class: a name that does not start with the words shown (Adv for Advantage, STR d20 for Strength save, a fold's summary after its name, a key hint), which speech input users say to press it.",
  },
  {
    rule: "label-title-only",
    node: /Feet per square/,
    reason: "False positive: Room settings scrolls this row below its panel's edge, and axe reads a label cut off by a scroll box as not shown. The field is named by its setting's words, which show once it is scrolled to.",
  },
  {
    rule: "scrollable-region-focusable",
    surface: /: search$/,
    reason: "False positive: the results are a listbox the search field drives with aria-activedescendant, so the arrow keys move through them and scroll the active row into view.",
  },
];

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
let work = "";

let server: Server;
let browser: Browser;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("player");
const watches: ConsoleWatch[] = [];

const run = {
  roomId: "",
  roomName: `E2E a11y ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  bounds: { w: 0, h: 0 },
  patId: "",
  thorn: { id: uuidv7(), characterId: uuidv7(), x: 0, y: 0 },
  snag: { id: uuidv7(), x: 0, y: 0 },
  grub: { id: uuidv7(), x: 0, y: 0 },
  dmState: null as StorageState | null,
  patState: null as StorageState | null,
  /** The roll asked of Thorn while its card is scanned, closed after. */
  pendingRoll: "",
};

type Node = { target: string; html: string };
type Found = { target: string; html: string; surfaces: Set<string> };
type Seen = { impact: string; help: string; nodes: Map<string, Found>; surfaces: Set<string> };
/** What the scans and walks found. The drawn page's check swaps in a map of its own. */
let seen = new Map<string, Seen>();
const scanned: string[] = [];
const unreached: string[] = [];
/** Each Tab walk's stops in order, kept in the JSON as the focus order the sweep saw. */
const walked: { surface: string; stops: string[] }[] = [];

function actor(hp: number) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 15,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 11,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Runs axe over the whole page as it stands, and files each violation under `surface`. */
async function scan(page: Page, surface: string): Promise<void> {
  await page.waitForTimeout(300);
  const has = await page.evaluate(() => typeof (globalThis as { axe?: unknown }).axe === "object");
  if (!has) await page.evaluate(AXE_SOURCE);
  const found = await page.evaluate(async (tags) => {
    type Result = { id: string; impact: string | null; help: string; nodes: { target: unknown[]; html: string }[] };
    const axe = (globalThis as unknown as { axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: Result[] }> } }).axe;
    const r = await axe.run((globalThis as unknown as { document: unknown }).document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    const doc = (globalThis as unknown as { document: { querySelector(s: string): { tagName: string; textContent: string | null; getAttribute(n: string): string | null } | null } }).document;
    // What each node says and shows, which its HTML, cut short, often leaves out.
    const words = (target: unknown[]) => {
      const el = target.length === 1 ? doc.querySelector(String(target[0])) : null;
      if (!el) return "";
      const label = el.getAttribute("aria-label") ?? (el.getAttribute("aria-labelledby") ? `by ${el.getAttribute("aria-labelledby")}: ${(el.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => doc.querySelector(`[id="${id}"]`)?.textContent ?? "(none)").join(" ")}` : null);
      return `<${el.tagName.toLowerCase()}${el.getAttribute("role") ? ` role=${el.getAttribute("role")}` : ""}>${label === null ? "" : ` named "${label}"`} showing "${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)}"`;
    };
    return r.violations.map((v) => ({ id: v.id, impact: v.impact ?? "", help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.map(String).join(" "), html: `${words(n.target)} ${n.html.slice(0, 200)}` })) }));
  }, TAGS);
  scanned.push(surface);
  for (const v of found) for (const n of v.nodes as Node[]) record(v.id, v.impact, v.help, n, surface);
}

/**
 * Files a node under its rule, keyed by its selector and its words
 * together: two nodes can share a selector, and each is judged by its own
 * words, or an exempt one would lend its exemption to the other.
 */
function record(rule: string, impact: string, help: string, n: Node, surface: string): void {
  const entry = seen.get(rule) ?? { impact, help, nodes: new Map(), surfaces: new Set<string>() };
  entry.surfaces.add(surface);
  const key = `${n.target}\n${n.html}`;
  const node = entry.nodes.get(key) ?? { target: n.target, html: n.html, surfaces: new Set<string>() };
  node.surfaces.add(surface);
  entry.nodes.set(key, node);
  seen.set(rule, entry);
}

/** The KNOWN entry that exempts a node: its rule, every surface it was seen on, and its own selector and words. */
function knownFor(rule: string, node: Found, known: readonly (typeof KNOWN)[number][] = KNOWN): (typeof KNOWN)[number] | undefined {
  return known.find((k) => k.rule === rule && (!k.surface || [...node.surfaces].every((s) => k.surface!.test(s))) && (!k.node || k.node.test(`${node.target} ${node.html}`)));
}

/**
 * The sweep's own keyboard rules, which axe has none of: where Tab takes
 * focus, read from Chrome's accessibility tree as a screen reader gets it.
 */
const TAB_RULES = {
  "tab-no-name": { impact: "serious", help: "Focus lands on something with no name" },
  "tab-in-hidden": { impact: "serious", help: "Focus lands inside content hidden from screen readers" },
  "tab-not-shown": { impact: "serious", help: "Focus lands on something that does not show" },
  "tab-leaves-dialog": { impact: "serious", help: "Tab takes focus out of an open modal dialog" },
} as const;

/** What has focus: the node itself (`id`), Chrome's role and name for it, and where it stands. */
async function focusNow(page: Page, cdp: CDPSession): Promise<{ id: number; key: string; html: string; body: boolean; ignored: boolean; name: string; hidden: boolean; shown: boolean; inModal: boolean | null } | null> {
  const { result } = await cdp.send("Runtime.evaluate", { expression: "document.activeElement" });
  if (!result.objectId) return null;
  const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId });
  const ax = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
  await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
  const a = ax.nodes[0];
  const where = await page.evaluate(() => {
    type El = { tagName: string; outerHTML: string; closest(s: string): El | null; contains(e: El): boolean; getBoundingClientRect(): { width: number; height: number }; checkVisibility(o: object): boolean };
    const d = (globalThis as unknown as { document: { activeElement: El | null; body: El; querySelector(s: string): El | null } }).document;
    const el = d.activeElement;
    if (!el || el === d.body) return { body: true, html: "", hidden: false, shown: true, inModal: null };
    const r = el.getBoundingClientRect();
    const modal = d.querySelector('[aria-modal="true"]') ?? d.querySelector("dialog:modal");
    return {
      body: false,
      html: el.outerHTML.replace(/\s+/g, " ").slice(0, 200),
      hidden: el.closest('[aria-hidden="true"], [inert]') !== null,
      // A see-through control over a card that draws its focus, as RadioCards' radios are, still shows.
      shown: r.width >= 2 && r.height >= 2 && el.checkVisibility({ visibilityProperty: true }),
      inModal: modal ? modal.contains(el) : null,
    };
  });
  const role = String(a?.role?.value ?? "none");
  const name = String(a?.name?.value ?? "");
  return { id: node.backendNodeId, key: `${role} "${name.slice(0, 60)}"`, html: where.html, body: where.body, ignored: a?.ignored === true, name, hidden: where.hidden, shown: where.shown, inModal: where.inModal };
}

/**
 * Tabs through a surface and files each stop that a keyboard or screen
 * reader user would trip on. In a modal dialog the walk goes round once,
 * since focus should cycle within it. On the page it takes `steps` stops
 * from the top.
 */
async function tabWalk(page: Page, surface: string, kind: "page" | "dialog", steps = 40): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Accessibility.enable");
    // A blur leaves Tab's starting point where focus was, so the walk starts from the body, focused for a moment.
    if (kind === "page")
      await page.evaluate(() => {
        const body = (globalThis as unknown as { document: { body: { tabIndex: number; focus(): void; removeAttribute(n: string): void } } }).document.body;
        body.tabIndex = -1;
        body.focus();
        body.removeAttribute("tabindex");
      });
    const keys: string[] = [];
    // The walk's first stop, by the node itself: two controls can share a role and a name, as a dialog's Next and one behind it do.
    let first: number | null = null;
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press("Tab");
      const f = await focusNow(page, cdp);
      if (!f || f.body) {
        if (kind === "dialog") record("tab-leaves-dialog", TAB_RULES["tab-leaves-dialog"].impact, TAB_RULES["tab-leaves-dialog"].help, { target: "the page itself", html: `after ${keys.at(-1) ?? "the start"}` }, surface);
        break;
      }
      // Every stop is filed before the walk can end on it.
      const n = { target: f.key, html: f.html };
      if (f.name.trim() === "" && !f.hidden) record("tab-no-name", TAB_RULES["tab-no-name"].impact, TAB_RULES["tab-no-name"].help, n, surface);
      if (f.hidden || f.ignored) record("tab-in-hidden", TAB_RULES["tab-in-hidden"].impact, TAB_RULES["tab-in-hidden"].help, n, surface);
      if (!f.shown) record("tab-not-shown", TAB_RULES["tab-not-shown"].impact, TAB_RULES["tab-not-shown"].help, n, surface);
      if (kind === "dialog" && f.inModal === false) record("tab-leaves-dialog", TAB_RULES["tab-leaves-dialog"].impact, TAB_RULES["tab-leaves-dialog"].help, n, surface);
      if (kind === "dialog" && f.id === first) break;
      first ??= f.id;
      keys.push(f.key);
    }
    walked.push({ surface, stops: keys });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** One surface: opened by `open`, scanned, then put away. A surface that would not open is listed, and the sweep goes on. */
async function surface(page: Page, name: string, open: () => Promise<unknown>, close?: () => Promise<unknown>, walk?: "page" | "dialog"): Promise<void> {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await open();
    await scan(page, name);
    if (walk) await tabWalk(page, name, walk);
  } catch (err) {
    unreached.push(`${name}: ${String((err as Error).message ?? err).split("\n").slice(0, process.env.A11Y_ONLY ? 12 : 1).join(" / ")}`);
    await shots.take(page, `a11y-unreached-${unreached.length}`).catch(() => undefined);
  } finally {
    try {
      if (close) await close();
    } catch {
      // The next surface starts from escapeAll.
    }
  }
}

async function visible(l: Locator): Promise<boolean> {
  return (await l.count()) > 0 && (await l.first().isVisible());
}

async function press(l: Locator, phone: boolean): Promise<void> {
  if (phone) await l.tap();
  else await l.click();
}

async function escapeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}

/** Closes a phone's open panel sheets, so the map takes the next tap. */
async function closeSheets(page: Page, phone: boolean): Promise<void> {
  if (!phone) return;
  const open = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true });
  for (let i = 0; i < 3; i++) {
    const n = await open.count();
    if (n === 0) return;
    await open.first().getByRole("button", { name: /^Close / }).first().tap();
    await waitFor("a sheet put away", async () => ((await open.count()) < n ? true : null), 5_000);
  }
}

/** A panel by its title: the side panel's tab on a computer, the Panels list's sheet on a phone. */
async function openPanel(page: Page, title: string, phone: boolean): Promise<Locator> {
  if (!phone) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel").filter({ visible: true }).first();
  }
  const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  if (await visible(sheet)) return sheet;
  const picker = page.getByRole("list", { name: "Panels" });
  const all = page.getByRole("button", { name: "All panels" });
  if (await visible(picker)) {
    // The list is open already.
  } else if (await visible(all)) await all.first().tap();
  else {
    await closeSheets(page, phone);
    await page.locator('button[title="Panels"]').first().tap();
  }
  await picker.getByRole("button", { name: new RegExp(`^${title}( ?\\d+ unread)?`) }).first().tap();
  await sheet.waitFor();
  return sheet;
}

/** A tap or a click on the map at a cell's center. */
async function hitCell(page: Page, cell: { x: number; y: number }, phone: boolean): Promise<void> {
  const fit = page.getByRole("button", { name: "Fit the map to the screen" });
  if (await visible(fit)) await press(fit.first(), phone);
  const p = await pagePoint(page, run.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
  if (phone) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

async function selectToken(page: Page, name: string, cell: { x: number; y: number }, phone: boolean): Promise<Locator> {
  await closeSheets(page, phone);
  await escapeAll(page);
  await hitCell(page, cell, phone);
  const bar = page.getByRole("dialog", { name: `${name} actions` });
  await bar.waitFor({ timeout: 5_000 });
  return bar;
}

/** Opens the room at a size from a new navigation, connected and drawn. */
async function openRoom(page: Page): Promise<void> {
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await page.waitForTimeout(500);
}

async function newPage(size: Size, state: StorageState | null, socket?: SocketWatch): Promise<{ context: BrowserContext; page: Page; watch: ConsoleWatch }> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    ...(state ? { storageState: state } : {}),
  });
  const page = await context.newPage();
  const watch = new ConsoleWatch(`${size.name}`);
  watch.attach(page);
  watches.push(watch);
  if (socket) await socket.attach(context, page);
  return { context, page, watch };
}

/** The fight for the turn card: Snag beside Thorn, then Snag walks off, which leaves Thorn's reach. */
async function snagsTurn(): Promise<void> {
  await ops.send({ t: "encounter.end" }).catch(() => undefined);
  await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { x: run.thorn.x, y: run.thorn.y } });
  await ops.send({ t: "token.update", tokenId: run.snag.id, patch: { x: run.thorn.x + 1, y: run.thorn.y } });
  await ops.send({ t: "token.update", tokenId: run.grub.id, patch: { x: run.thorn.x - 1, y: run.thorn.y } });
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: uuidv7(), tokenId: run.snag.id, value: 25 },
      { id: uuidv7(), tokenId: run.thorn.id, value: 20 },
      { id: uuidv7(), tokenId: run.grub.id, value: 10 },
    ],
  });
  await ops.send({ t: "encounter.next" });
  await ops.send({ t: "token.move", tokenId: run.snag.id, x: run.thorn.x + 4, y: run.thorn.y, elevation: 0 });
}

/** Thorn's turn after Snag's: Thorn walks away from Grub. */
async function thornsTurn(): Promise<void> {
  await snagsTurn();
  await ops.send({ t: "encounter.next" });
  await ops.send({ t: "token.move", tokenId: run.thorn.id, x: run.thorn.x, y: run.thorn.y + 3, elevation: 0 });
}

async function endFight(): Promise<void> {
  await ops.send({ t: "encounter.end" }).catch(() => undefined);
  await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { x: run.thorn.x, y: run.thorn.y } });
  await ops.send({ t: "token.update", tokenId: run.snag.id, patch: { x: run.snag.x, y: run.snag.y } });
  await ops.send({ t: "token.update", tokenId: run.grub.id, patch: { x: run.grub.x, y: run.grub.y } });
}

/** The turn card, unfolded where a phone folds it. */
async function turnCard(page: Page, name: string, phone: boolean): Promise<void> {
  const card = page.getByRole("group", { name: `${name}'s turn` }).filter({ visible: true }).first();
  const summary = page.getByRole("button", { name: /to answer\.$|to see them\.$|to see it\.$/ }).filter({ visible: true }).first();
  await card.or(summary).first().waitFor({ timeout: 10_000 });
  if (!(await visible(card))) await press(summary, phone);
  const fold = card.locator("button[aria-expanded=false]").first();
  if (await visible(fold)) await press(fold, phone);
  await card.getByRole("group", { name: "Opportunity Attacks" }).waitFor({ timeout: 10_000 });
}

const DM_PANELS = ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "DM", "Scenes", "Sound", "Time", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"];
const PLAYER_PANELS = ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "Characters", "Library", "Menu"];

/** The Menu's own list, back from any of its pages, which the side panel keeps open across a switch. */
async function menuList(page: Page, phone: boolean): Promise<Locator> {
  const menu = await openPanel(page, "Menu", phone);
  const list = page.getByRole("navigation", { name: "Room menu" });
  const back = page.getByRole("button", { name: /^Back to (Menu|This device)/ }).filter({ visible: true }).first();
  // The panel loads lazily the first time, so the list or a page's Back is waited for before either is read.
  await list.or(back).first().waitFor();
  for (let i = 0; i < 3 && !(await visible(list)); i++) {
    await press(back, phone);
    await list.or(back).first().waitFor();
  }
  await list.waitFor();
  return menu;
}

/** The Menu's page by its item. */
async function menuPage(page: Page, item: string, phone: boolean): Promise<Locator> {
  const menu = await menuList(page, phone);
  await press(menu.getByRole("button", { name: new RegExp(`^${item}`) }).first(), phone);
  return menu;
}

/** Every folded group in `root`, opened, so the scan reads what each holds. */
async function unfoldAll(root: Locator, phone: boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const folded = root.locator("button[data-group-fold][aria-expanded=false]").filter({ visible: true });
    if ((await folded.count()) === 0) return;
    await press(folded.first(), phone);
    await root.page().waitForTimeout(100);
  }
}

/** A group of a page, unfolded where a phone folds it. */
async function unfold(page: Page, name: string, phone: boolean): Promise<void> {
  const fold = page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  if ((await fold.getAttribute("aria-expanded")) === "false") await press(fold, phone);
}

/** Every surface of the room for one role at one size. */
async function sweepRoom(page: Page, role: "dm" | "player", size: Size): Promise<void> {
  const phone = size.phone;
  const at = (s: string) => `${role} ${size.name}: ${s}`;
  const reset = () => (async () => {
    await escapeAll(page);
    await closeSheets(page, phone);
  })();
  await openRoom(page);
  await surface(page, at("board"), async () => undefined, undefined, "page");

  for (const title of role === "dm" ? DM_PANELS : PLAYER_PANELS) {
    await surface(page, at(`${title} panel`), () => openPanel(page, title, phone), reset);
  }
  if (phone && role === "dm") await surface(page, at("Party panel"), () => openPanel(page, "Party", phone), reset);

  // A token's bar and its panel: Thorn, whom the player plays.
  await surface(page, at("Thorn's bar"), () => selectToken(page, "Thorn", run.thorn, phone));
  await surface(page, at("Token panel, Thorn"), async () => {
    const bar = page.getByRole("dialog", { name: "Thorn actions" });
    if (!(await visible(bar))) await selectToken(page, "Thorn", run.thorn, phone);
    await press(await barControl(bar, "Details"), phone);
    await page.getByRole("heading", { name: "Thorn" }).first().waitFor();
    await unfoldAll(await openPanel(page, "Token", phone), phone);
  }, reset);
  if (role === "dm") {
    await surface(page, at("Token panel, Snag"), async () => {
      const bar = await selectToken(page, "Snag", run.snag, phone);
      await press(await barControl(bar, "Details"), phone);
      await page.getByRole("heading", { name: "Snag" }).first().waitFor();
    }, reset);
  }

  // Thorn's character sheet in Characters.
  await surface(page, at("character sheet, Thorn"), async () => {
    const panel = await openPanel(page, "Characters", phone);
    const heading = panel.locator("[data-creature-heading]").filter({ hasText: "Thorn" });
    const opener = panel.locator(`[data-opener="character:${run.thorn.characterId}"]`);
    await heading.or(opener).first().waitFor();
    if ((await heading.count()) === 0) await press(opener.first(), phone);
    await heading.first().waitFor();
    await unfoldAll(panel, phone);
  }, reset);

  // The dice tray after a roll.
  await surface(page, at("dice tray"), async () => {
    const panel = await openPanel(page, "Dice", phone);
    const field = panel.getByLabel("Dice formula", { exact: true });
    await field.fill("1d20+3");
    await field.press("Enter");
    await page.waitForTimeout(1_500);
  }, reset);

  // The Menu's pages.
  await surface(page, at("Members"), () => menuPage(page, "Members", phone), reset);
  if (role === "dm") await surface(page, at("Room settings"), async () => unfoldAll(await menuPage(page, "Room settings", phone), phone), reset);
  await surface(page, at("This device"), async () => unfoldAll(await menuPage(page, "This device", phone), phone));
  await surface(page, at("Features"), async () => {
    const panel = page.getByRole("button", { name: /^Features/ }).filter({ visible: true });
    if (!(await visible(panel))) await menuPage(page, "This device", phone);
    await press(page.getByRole("button", { name: /^Features/ }).filter({ visible: true }).first(), phone);
    await page.getByRole("button", { name: /^Back to This device/ }).first().waitFor();
  }, reset);
  await surface(page, at("About"), () => menuPage(page, "About", phone), reset);
  await surface(page, at("X-card"), async () => {
    const menu = await menuList(page, phone);
    await press(menu.locator('[data-search="menu.xcard"]').first(), phone);
    await page.getByRole("button", { name: "Send the X-card" }).waitFor();
  }, reset);
  if (role === "dm") {
    await surface(page, at("Setup history"), async () => {
      await menuPage(page, "Setup history", phone);
      await page.getByRole("dialog").filter({ hasText: /Setup history|Undo/ }).first().waitFor();
    }, reset, "dialog");
  }

  // The shortcut sheet, from This device's button.
  await surface(page, at("shortcut sheet"), async () => {
    await menuPage(page, "This device", phone);
    await unfold(page, "Shortcuts", phone);
    await press(page.getByRole("button", { name: /^Show the shortcuts/ }).first(), phone);
    await page.getByRole("dialog", { name: "Shortcuts" }).waitFor();
  }, reset, "dialog");

  // The main dialogs.
  await surface(page, at("Export the log"), async () => {
    const panel = await openPanel(page, "Log", phone);
    await press(panel.getByRole("button", { name: "Export", exact: true }).first(), phone);
    await page.getByRole("dialog", { name: "Export the log" }).waitFor();
  }, reset, "dialog");
  if (role === "dm") {
    await surface(page, at("New page"), async () => {
      const panel = await openPanel(page, "Journal", phone);
      await press(panel.getByRole("button", { name: "New page" }).first(), phone);
      await page.getByRole("dialog", { name: "New page" }).waitFor();
    }, reset, "dialog");
    await surface(page, at("Request a roll"), async () => {
      if (phone) await openPanel(page, "Party", phone);
      await press(page.getByRole("button", { name: "Ask the party" }).first(), phone);
      await page.getByRole("dialog", { name: "Request a roll" }).waitFor();
    }, reset, "dialog");
    await surface(page, at("New monster"), async () => {
      const panel = await openPanel(page, "Monsters", phone);
      await press(panel.getByRole("button", { name: "New monster" }).first(), phone);
      await page.getByRole("dialog", { name: "New monster" }).waitFor();
    }, reset, "dialog");
    await surface(page, at("Choose an image"), async () => {
      const panel = await openPanel(page, "Characters", phone);
      const back = page.getByRole("button", { name: "Back to Characters" }).filter({ visible: true });
      if (await visible(back)) await press(back.first(), phone);
      await press(panel.getByRole("button", { name: "New character" }).first(), phone);
      await press(page.getByRole("button", { name: "Add image" }).first(), phone);
      await page.getByRole("dialog", { name: "Choose an image" }).waitFor();
    }, async () => {
      await escapeAll(page);
      const back = page.getByRole("button", { name: "Back to Characters" }).filter({ visible: true });
      if (await visible(back)) await press(back.first(), phone);
      const discard = page.getByRole("button", { name: "Discard changes?" }).filter({ visible: true });
      if (await visible(discard)) await press(discard.first(), phone);
      await closeSheets(page, phone);
    }, "dialog");
  } else {
    // The DM asks Pat for a roll: the card it brings.
    await surface(page, at("The DM asks for a roll"), async () => {
      const id = uuidv7();
      await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
      const card = page.getByRole("dialog", { name: "The DM asks for a roll" });
      const way = page.getByRole("button", { name: /^Roll asked|^WIS save: waiting/ }).filter({ visible: true });
      await card.or(way).first().waitFor({ timeout: 10_000 });
      if (!(await visible(card))) await press(way.first(), phone);
      await card.waitFor();
      run.pendingRoll = id;
    }, async () => {
      if (run.pendingRoll) await ops.send({ t: "roll.close", rollIds: [run.pendingRoll] });
      run.pendingRoll = "";
      await escapeAll(page);
    }, "dialog");
  }

  // The top bar's menus and the tools' options rows.
  await surface(page, at(role === "dm" ? "DM options menu" : "your options menu"), async () => {
    await press(page.getByRole("button", { name: role === "dm" ? "DM options" : /^You are Pat/ }).first(), phone);
    await page.getByRole("menu").filter({ visible: true }).first().waitFor();
  }, reset);
  await surface(page, at("View menu"), async () => {
    await press(page.getByRole("button", { name: /^View: / }).first(), phone);
    await page.getByRole("dialog", { name: "View" }).or(page.getByRole("menu")).filter({ visible: true }).first().waitFor();
  }, reset);
  await surface(page, at("Volume"), async () => {
    await press(page.getByRole("button", { name: /^Volume on this device/ }).first(), phone);
    await page.getByRole("dialog", { name: "Volume" }).or(page.getByRole("slider")).filter({ visible: true }).first().waitFor();
  }, reset);
  for (const [tool, options] of [["Ruler", "Ruler options"], ["Area", "Area options"], ...(role === "dm" ? [["Fog", "Fog options"]] : [])] as const) {
    await surface(page, at(`${tool} options`), async () => {
      await press(page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: tool, exact: true }).first(), phone);
      await page.getByRole("toolbar", { name: options }).waitFor();
    }, async () => {
      await press(page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Select", exact: true }).first(), phone);
      await escapeAll(page);
    });
  }
  if (role === "dm") {
    await surface(page, at(phone ? "Setup tools menu" : "Map builder options"), async () => {
      if (phone) {
        await press(page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Setup tools/ }).first(), phone);
        await page.getByRole("menu", { name: "Setup tools" }).waitFor();
      } else {
        await press(page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Map builder", exact: true }).first(), phone);
        await page.getByRole("toolbar", { name: "Map builder options" }).waitFor();
      }
    }, async () => {
      await escapeAll(page);
      const done = page.getByRole("toolbar", { name: "Map builder options" }).getByRole("button", { name: "Done", exact: true });
      if (await visible(done)) await press(done.first(), phone);
      await press(page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Select", exact: true }).first(), phone);
    });
  }
  if (!phone) {
    await surface(page, at("More panels menu"), async () => {
      await press(page.getByRole("tablist", { name: "Panels" }).locator('[aria-haspopup="menu"]').first(), phone);
      await page.getByRole("menu", { name: "More panels" }).waitFor();
    }, reset);
  }

  // The search, from the top bar, or a phone's Panels list where the bar folds it.
  await surface(page, at("search"), async () => {
    const bar = page.locator('[data-search-open="bar"]').filter({ visible: true });
    if (await visible(bar)) await press(bar.first(), phone);
    else {
      await closeSheets(page, phone);
      await page.locator('button[title="Panels"]').first().tap();
      await press(page.locator('[data-search-open="panels"]').first(), phone);
    }
    const field = page.locator("[data-search-field]").filter({ visible: true }).first();
    await field.fill("dice");
    await page.locator("[data-search-row]").first().waitFor();
  }, reset, "dialog");

  // A fight: the Initiative panel, and the turn card with its Opportunity Attacks block.
  await surface(page, at("turn card with Opportunity Attacks"), async () => {
    if (role === "dm") {
      await snagsTurn();
      await turnCard(page, "Snag", phone);
    } else {
      await thornsTurn();
      await turnCard(page, "Thorn", phone);
    }
  });
  await surface(page, at("Initiative in a fight"), () => openPanel(page, "Initiative", phone), reset);
  await endFight();
}

describe("the accessibility sweep", { skip: SKIP, timeout: 1_400_000 }, () => {
  let dmHome: { context: BrowserContext; page: Page };

  before(async () => {
    work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-a11y-"));
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
  });

  after(async () => {
    ops?.close();
    if (run.roomId && dmHome) {
      try {
        await dmHome.context.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test("0. on a drawn page, axe and the Tab walk each find the fault planted for them, so a clean run means something", async () => {
    const kept = seen;
    seen = new Map();
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html lang="en"><head><title>Drawn</title></head><body><main>
        <h1>Drawn</h1>
        <button>Named</button>
        <button></button>
        <div aria-hidden="true"><button>Hidden</button></div>
        <button style="position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden; padding: 0; border: 0">Tiny</button>
      </main></body></html>`);
      await scan(page, "drawn: page");
      await tabWalk(page, "drawn: page", "page");
      await page.setContent(`<!doctype html><html lang="en"><head><title>Drawn</title></head><body><main>
        <div role="dialog" aria-modal="true" aria-label="Drawn dialog"><button>Inside</button></div>
        <button>Outside</button>
      </main></body></html>`);
      await page.getByRole("button", { name: "Inside" }).focus();
      await tabWalk(page, "drawn: dialog", "dialog");
      // A Next inside and a Next behind the dialog share a role and a name, so only the node itself tells the walk it has not come round.
      await page.setContent(`<!doctype html><html lang="en"><head><title>Drawn</title></head><body><main>
        <div role="dialog" aria-modal="true" aria-label="Steps"><button>Back</button><button>Next</button></div>
        <button>Next</button>
      </main></body></html>`);
      await page.getByRole("button", { name: "Back" }).focus();
      await tabWalk(page, "drawn: same names", "dialog");
      const found = (rule: string) => [...new Set([...(seen.get(rule)?.nodes.values() ?? [])].map((n) => n.target))];
      assert.equal(found("button-name").length, 1, "axe found the button with no name");
      assert.deepEqual(found("tab-no-name"), ['button ""']);
      assert.deepEqual(found("tab-in-hidden"), ['button "Hidden"']);
      assert.deepEqual(found("tab-not-shown"), ['button "Tiny"']);
      // Past the last control Chrome may wrap to the first or leave the page, which files "the page itself" too, so each walk's own stop is read.
      const leftFrom = (walk: string) => [...(seen.get("tab-leaves-dialog")?.nodes.values() ?? [])].filter((n) => n.surfaces.has(walk)).map((n) => n.target);
      assert.ok(leftFrom("drawn: dialog").includes('button "Outside"'), "the walk filed Outside, behind the dialog");
      assert.ok(leftFrom("drawn: same names").includes('button "Next"'), "the walk filed the Next behind the dialog, though one inside shares its name");

      // Two nodes at one selector, the first exempt by its words: the second is judged by its own and stays unknown.
      seen = new Map();
      const exempt = [{ rule: "drawn-rule", node: /named "Exempt"/, reason: "the drawn exemption" }];
      record("drawn-rule", "minor", "drawn", { target: "div > button", html: '<button> named "Exempt"' }, "drawn: page");
      record("drawn-rule", "minor", "drawn", { target: "div > button", html: '<button> named "Other"' }, "drawn: page");
      const judged = [...(seen.get("drawn-rule")?.nodes.values() ?? [])].map((n) => [n.html, knownFor("drawn-rule", n, exempt) !== undefined]);
      assert.deepEqual(judged, [['<button> named "Exempt"', true], ['<button> named "Other"', false]], "each node at a shared selector judged by its own words");
    } finally {
      seen = kept;
      scanned.length = 0;
      walked.length = 0;
      await context.close();
    }
  });

  test("1. the home page, the DM link step and a player's join page, then the room's creatures", async () => {
    for (const size of SIZES) {
      const fresh = await newPage(size, null);
      await fresh.page.goto(`${server.origin}/`);
      await fresh.page.getByLabel("Room name").waitFor();
      await scan(fresh.page, `visitor ${size.name}: home`);
      await tabWalk(fresh.page, `visitor ${size.name}: home`, "page");
      await fresh.context.close();
    }

    dmHome = await newPage(SIZES[0], null, dmSocket);
    const dm = dmHome.page;
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    await scan(dm, "dm 1440x900: save your DM link");
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    // Pat's join page, before Pat has joined, at each size.
    for (const size of SIZES) {
      const fresh = await newPage(size, null);
      // A device that is no member asks the server who it is, and the 403 it gets is what shows the join page.
      fresh.watch.allow = [/403 \(Forbidden\) \(http:\/\/localhost:\d+\/api\/rooms\/[0-9A-Z]+\/me\)$/];
      await fresh.page.goto(`${server.origin}/r/${run.roomId}`);
      await fresh.page.getByLabel(/password/i).first().waitFor();
      await scan(fresh.page, `visitor ${size.name}: join page`);
      await tabWalk(fresh.page, `visitor ${size.name}: join page`, "page");
      await fresh.context.close();
    }

    const pat = await browser.newContext();
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await pat.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await pat.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;
    run.patState = await pat.storageState();
    await pat.close();

    const cookie = (await dmHome.context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const cx = Math.floor(run.bounds.w / 2);
    const cy = Math.floor(run.bounds.h / 2);
    run.thorn = { ...run.thorn, x: cx - 2, y: cy - 1 };
    run.snag = { ...run.snag, x: cx + 3, y: cy - 1 };
    run.grub = { ...run.grub, x: cx + 3, y: cy + 2 };
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(run.snag.id, { kind: "monster", name: "Snag", x: run.snag.x, y: run.snag.y, disposition: "hostile", actor: { inline: actor(7) } }));
    await ops.send(token(run.grub.id, { kind: "monster", name: "Grub", x: run.grub.x, y: run.grub.y, disposition: "hostile", actor: { inline: actor(7) } }));
    await waitFor("the creatures in the DM's view", () => (dmSocket.state?.tokens[run.grub.id] ? true : null));
    run.dmState = await dmHome.context.storageState();
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").waitFor();
    await scan(dm, "dm 1440x900: home with a room");
  });

  for (const size of SIZES) {
    test(`2. the DM's room at ${size.name}`, async () => {
      const { context, page } = await newPage(size, run.dmState);
      try {
        await sweepRoom(page, "dm", size);
      } finally {
        await context.close();
      }
    });
    test(`3. the player's room at ${size.name}`, async () => {
      const { context, page } = await newPage(size, run.patState, patSocket);
      try {
        await sweepRoom(page, "player", size);
      } finally {
        await context.close();
      }
    });
  }

  test("4. the Docs page and the DM guide", async () => {
    for (const size of SIZES) {
      const { context, page } = await newPage(size, null);
      try {
        await page.goto(`${server.origin}/docs`);
        await page.getByRole("heading").first().waitFor();
        await scan(page, `visitor ${size.name}: Docs`);
        await tabWalk(page, `visitor ${size.name}: Docs`, "page");
        await page.goto(`${server.origin}/docs/dm-guide`);
        await page.getByRole("heading").first().waitFor();
        await page.waitForTimeout(500);
        await scan(page, `visitor ${size.name}: DM guide`);
        await tabWalk(page, `visitor ${size.name}: DM guide`, "page");
      } finally {
        await context.close();
      }
    }
  });

  test("5. every violation is known, with its reason, every surface was reached, and no page logged an error", () => {
    const out: Record<string, unknown> = {};
    const unknown: string[] = [];
    const used = new Set<(typeof KNOWN)[number]>();
    const lines: string[] = [];
    for (const [rule, v] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[rule] = { impact: v.impact, help: v.help, surfaces: [...v.surfaces], nodes: [...v.nodes.values()].map((n) => ({ target: n.target, html: n.html, surfaces: [...n.surfaces] })) };
      lines.push(`${rule} (${v.impact}, ${v.nodes.size} nodes): ${v.help}`);
      for (const n of v.nodes.values()) {
        const target = n.target;
        const known = knownFor(rule, n);
        if (known) used.add(known);
        lines.push(`  ${known ? "known" : "NEW  "} ${target}  [${[...n.surfaces].slice(0, 4).join("; ")}${n.surfaces.size > 4 ? `; +${n.surfaces.size - 4}` : ""}]\n        ${n.html.replace(/\s+/g, " ").slice(0, 200)}`);
        if (!known) unknown.push(`${rule} at ${target} on ${[...n.surfaces][0]}`);
      }
    }
    if (SHOT_DIR !== "0") {
      mkdirSync(SHOT_DIR, { recursive: true });
      writeFileSync(path.join(SHOT_DIR, "a11y-violations.json"), JSON.stringify({ scanned, walked, unreached, violations: out }, null, 2));
    }
    console.error(`scanned ${scanned.length} surfaces, walked ${walked.length} with Tab, ${unreached.length} not reached\n${unreached.join("\n")}\n${lines.join("\n")}`);
    // A known entry nothing matched may be fixed, or the surface that showed it gone: said, not failed, since ONLY runs leave most out.
    const unused = KNOWN.filter((k) => !used.has(k)).map((k) => k.rule);
    if (unused.length > 0) console.error(`known entries no violation matched: ${unused.join(", ")}`);
    const errors = watches.flatMap((w) => w.errors.map((e) => `[${w.label}] ${e}`));
    if (REPORT_ONLY) return;
    assert.deepEqual(unreached, [], "surfaces the sweep did not reach");
    assert.deepEqual(unknown, [], "violations KNOWN does not name");
    assert.deepEqual(errors, [], "errors the pages logged");
  });
});
