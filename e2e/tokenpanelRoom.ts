import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Route } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { barControl, ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * The token panel's room and helpers (docs/design-v1-token-panel.md
 * section 7), shared by tokenpanel.e2e.ts and the lines, summaries and
 * words files, so the CI shards can run the four side by side. Each file builds its own
 * room in step 0 and checks the pages' errors in step 10.
 *
 * Every file runs with `pnpm test:e2e` on E2E_PORT plus ten. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

export const PORT = Number(process.env.E2E_PORT ?? 3100) + 10;
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
export const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

export const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-tokenpanel-"));
export const assetDir = path.join(work, "assets");
export const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

export const FOLDS_KEY = "rvtt.tokenPanelFolds";
export const BOUNDS = { w: 16, h: 10 };
export const ICON = { icon: "lorc/wolf-head", color: "#336699" };
export const SHEET = "https://www.dndbeyond.com/characters/1";
/** A room monster's Immunities as long as a DM may type, to clamp in the bar. */
export const LONG_IMMUNITIES = `Poison, Psychic; ${Array.from({ length: 30 }, (_, i) => `Charmed by the ${i + 1}th moon`).join(", ")}`.slice(0, 480);

export type Insets = { side?: number; bottom?: number };
export type View = { width: number; height: number; scale: number; insets?: Insets };
export const DESK: View = { width: 1280, height: 800, scale: 1 };

export let server: Server;
export let browser: Browser;
export let dmContext: BrowserContext;
export let dm: Page;
export let dmCdp: CDPSession;
export let playerContext: BrowserContext;
export let player: Page;
export let playerCdp: CDPSession;
export let ops: OpSocket;
export const dmSocket = new SocketWatch("dm");
export const playerSocket = new SocketWatch("player");
export const dmConsole = new ConsoleWatch("dm");
export const playerConsole = new ConsoleWatch("player");

export const cell = (x: number, y: number) => ({ x, y });
export const run = {
  roomId: "",
  roomName: `E2E token panel ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID(), at: cell(0, 1) },
  bear: { id: randomUUID(), at: cell(2, 1) },
  bree: { id: randomUUID(), characterId: randomUUID(), at: cell(4, 1) },
  dragon: { id: randomUUID(), at: cell(6, 1) },
  goblin: { id: randomUUID(), at: cell(0, 4) },
  bog: { id: randomUUID(), monsterId: randomUUID(), at: cell(2, 4) },
  swift: { id: randomUUID(), at: cell(4, 4) },
  soft: { id: randomUUID(), at: cell(0, 7) },
  villager: { id: randomUUID(), at: cell(2, 7) },
  chest: { id: randomUUID(), at: cell(4, 7) },
  ogre: { id: randomUUID(), at: cell(6, 6) },
  /** Linked to a room monster deleted since. */
  mire: { id: randomUUID(), monsterId: randomUUID(), at: cell(8, 4) },
  /** At 0 of 0 HP, like Spiritual Weapon: HP-less. */
  weapon: { id: randomUUID(), at: cell(8, 8) },
  /** A name of 80 characters. */
  herald: { id: randomUUID(), at: cell(0, 9), name: "Herald of the Ninefold Crown and Keeper of the Long Night's Unbroken Silver Seal".slice(0, 80) },
};

export function actor(over: Record<string, unknown> = {}) {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
    life: "alive",
    ac: 12,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
    ...over,
  };
}

/** A homebrew monster written for this run, so no book's text is in the repository. */
export function bogThing(id: string) {
  const a = (score: number, save: number) => ({ score, save });
  return {
    id,
    name: "Bog Thing",
    size: "medium",
    type: "Plant",
    alignment: "Unaligned",
    ac: 13,
    initiative: 0,
    hp: { average: 30, formula: "4d8 + 12" },
    speed: "20 ft., Swim 20 ft.",
    abilities: { str: a(16, 3), dex: a(8, -1), con: a(16, 3), int: a(4, -3), wis: a(10, 0), cha: a(5, -3) },
    skills: "",
    vulnerabilities: "Fire",
    resistances: "",
    immunities: LONG_IMMUNITIES,
    gear: "",
    senses: "Blindsight 30 ft.",
    passivePerception: 10,
    languages: "None",
    cr: "2",
    xp: 450,
    traits: [{ name: "Peat Body", text: "The bog thing smells of a swamp in late summer." }],
    actions: [{ name: "Slam", text: "Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d8 + 3) Bludgeoning damage." }],
    bonusActions: [],
    reactions: [],
    legendaryActions: [],
  };
}

export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type El = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  getBoundingClientRect(): Rect;
  querySelectorAll(s: string): ArrayLike<El>;
};
export type Doc = { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };

/** Sets the safe areas, the window and the interface size, and loads the room again. Storage is left as the run set it, unless `folds` says. */
/**
 * Fails the SRD monsters' data and nothing else. The bundler can name a
 * shared code chunk "monsters" too, after shared/srd/monsters.ts, and the
 * room cannot load without that one, so a route by the name alone took
 * the whole page down.
 */
export async function failSrdData(route: Route): Promise<void> {
  const response = await route.fetch();
  const body = await response.text();
  if (body.includes('"srdId":"aboleth"')) await route.abort();
  else await route.fulfill({ response, body });
}

/**
 * When each page last loaded the room. The server's snapshot budget allows a
 * session 20 a minute and an address 40 (server/rooms/budgets.ts), and a
 * session kept over it for 30 s has every socket closed, the op socket's
 * too, which left the ops after fu31-i unanswered (FU31 review round 1). So
 * a page loads at most once every 3.5 s: 17 a minute, and 34 for the DM's
 * page and Pat's together.
 */
export const lastLoad = new Map<Page, number>();
export const LOAD_GAP_MS = 3_500;

export async function setUp(page: Page, cdp: CDPSession, view: View, folds?: string | null): Promise<void> {
  const since = Date.now() - (lastLoad.get(page) ?? 0);
  if (since < LOAD_GAP_MS) await page.waitForTimeout(LOAD_GAP_MS - since);
  lastLoad.set(page, Date.now());
  const i = view.insets ?? {};
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate(
    ([s, key, value]) => {
      const g = globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } };
      g.localStorage.setItem("rvtt.uiScale", String(s));
      if (value === null) g.localStorage.removeItem(key as string);
      else if (value !== undefined) g.localStorage.setItem(key as string, value as string);
    },
    [view.scale, FOLDS_KEY, folds] as const,
  );
  // A reload that meets a navigation the page started itself is aborted, so it gets one more try.
  /*
   * A fresh load of the room's address rather than a reload: a page
   * reloaded with a sheet open finds the sheet's history entry on top and
   * steps back off it (lib/backClose.ts), which a run that reloads often
   * can catch mid-navigation, landing on the page before the room.
   */
  await page.goto(`${server.origin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Resizes without a reload, as a rotation or a dragged window does. */
export async function resize(page: Page, cdp: CDPSession, view: Omit<View, "scale">): Promise<void> {
  const i = view.insets ?? {};
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.waitForTimeout(400);
}

export function storedFolds(page: Page): Promise<string | null> {
  return page.evaluate((key) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(key), FOLDS_KEY);
}

/** Taps a token by the middle of its footprint, after checking the map takes the tap there. */
export async function tapToken(page: Page, at: { x: number; y: number }, size = 1): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: at.x + size / 2, y: at.y + size / 2 });
  const tag = await page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
  assert.equal(tag, "CANVAS", `the map does not take a tap at ${at.x},${at.y}`);
  await page.mouse.click(p.x, p.y);
}

/**
 * Fits the map to the screen, so a token stands where the scene puts it
 * again after an expanded bar's clearing move panned the map
 * (docs/design-v1-bar-compact.md 5.3).
 */
export async function fitMap(page: Page): Promise<void> {
  const fit = page.getByRole("button", { name: "Fit the map to the screen" });
  if ((await fit.count()) === 0 || !(await wholeInReach(fit))) return;
  await fit.click();
  await page.waitForTimeout(300);
}

export function bar(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `${name} actions` });
}

/** The token's panel: the side panel's Token tab from 900 px up, the Token sheet below. */
export function tokenPanel(page: Page): Locator {
  // Exact, since the panel's Token settings group is a region of its own.
  return page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true }));
}

/** Opens one of the panel's groups (docs/design-v1-token-panel-groups.md), which Image, Notes and Position start folded. */
export async function openGroup(panel: Locator, name: string): Promise<void> {
  const fold = panel.getByRole("button", { name, exact: true });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await waitFor(`${name} open`, async () => ((await fold.getAttribute("aria-expanded")) === "true" ? true : null), 3000);
}

/** A token's panel from a tap on it and Details in its bar, Combat open. */
export async function panelOf(page: Page, at: { x: number; y: number }, name: string): Promise<Locator> {
  await page.keyboard.press("Escape");
  await tapToken(page, at);
  const b = bar(page, name);
  await b.waitFor();
  await (await barControl(b, "Details")).click();
  const panel = tokenPanel(page);
  await panel.getByRole("heading", { name, exact: true }).first().waitFor();
  await openGroup(panel, "Combat");
  return panel;
}

/** A section of a panel by its own heading. */
export function sectionIn(scope: Locator, heading: string): Locator {
  return scope.locator(`xpath=.//section[*[self::h3 or self::h4][normalize-space()="${heading}"] or *[not(self::section)]/*[self::h3 or self::h4][normalize-space()="${heading}"]]`);
}

/**
 * A FieldRow's label and its stepper (components/Field.tsx, `fixed`), by
 * the label's words: the words' width, the row's gap, the stepper's width
 * and the row's, in the page's pixels, whether the three fit in the row,
 * and whether the stepper stands on the label's line, at its right, or
 * under it.
 */
export function stepperRows(scope: Locator, labels: readonly string[]): Promise<{ label: string; words: number; gap: number; controls: number; width: number; fits: boolean; beside: boolean; under: boolean }[]> {
  return scope.evaluate((el, labels) => {
    type R = { left: number; right: number; top: number; bottom: number; width: number };
    type E = { textContent: string | null; offsetWidth: number; parentElement: E | null; nextElementSibling: E | null; firstElementChild: E | null; getBoundingClientRect(): R };
    const root = el as unknown as E & { querySelectorAll(s: string): ArrayLike<E>; ownerDocument: { createRange(): { selectNodeContents(n: E): void; getBoundingClientRect(): R }; defaultView: { getComputedStyle(e: E): { columnGap: string } } } };
    const doc = root.ownerDocument;
    return labels.map((label) => {
      const name = Array.from(root.querySelectorAll("label")).find((l) => l.textContent?.trim() === label);
      const row = name?.parentElement;
      const stepper = name?.nextElementSibling?.firstElementChild?.firstElementChild;
      if (!name || !row || !stepper) throw new Error(`no ${label} row with a stepper`);
      const range = doc.createRange();
      range.selectNodeContents(name);
      const words = range.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const s = stepper.getBoundingClientRect();
      // The page's pixels per CSS pixel, so the row's gap compares with the boxes at 130% too.
      const gap = parseFloat(doc.defaultView.getComputedStyle(row).columnGap) * (box.width / row.offsetWidth);
      const mid = (r: R) => (r.top + r.bottom) / 2;
      return {
        label,
        words: words.width,
        gap,
        controls: s.width,
        width: box.width,
        fits: words.width + gap + s.width <= box.width + 0.5,
        beside: Math.abs(mid(s) - mid(words)) <= 1 && s.left >= words.right + gap - 0.5,
        under: s.top >= words.bottom - 0.5,
      };
    });
  }, labels);
}

/** What has focus: its tag, its aria-label in quotes when it has one, and the start of its words. */
export function focusedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: { tagName: string; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
    return a ? `${a.tagName.toLowerCase()}${a.getAttribute("aria-label") ? ` "${a.getAttribute("aria-label")}"` : ""} ${(a.textContent ?? "").trim().slice(0, 40)}` : "nothing";
  });
}

/** measureAlignment's lines for a root, scrolled into view first. */
export async function measureIn(root: Locator, screen: string): Promise<string[]> {
  await root.first().scrollIntoViewIfNeeded();
  return alignmentLines(await measureAlignment(root.first()), screen);
}

/** The alignment sweep's tablet, held upright (alignmentRoom.ts SIZES). */
export const TABLET = { width: 820, height: 1180 };

/**
 * Runs `step` at the sizes live play 22 measured the panel at, 1440 x 900,
 * 1280 x 800, 430 x 932, 390 x 844 and 320 x 568, and any `also`, at 100%
 * and 130%, for the DM and with `withPlayer` for Pat too, and gathers its
 * lines. Each size loads the room again, so no sheet or panned map is left
 * from the last one: about ten loads a minute, under the server's 20 a
 * session.
 */
export async function atLp22Sizes(step: (at: string) => Promise<string[]>, withPlayer = false, also: { width: number; height: number }[] = []): Promise<string[]> {
  const off: string[] = [];
  const pages: [Page, CDPSession][] = [[dm, dmCdp], ...(withPlayer ? [[player, playerCdp] as [Page, CDPSession]] : [])];
  try {
    for (const scale of [1, 1.3]) {
      for (const size of [
        { width: 1440, height: 900 },
        { width: 1280, height: 800 },
        { width: 430, height: 932 },
        { width: 390, height: 844 },
        { width: 320, height: 568 },
        ...also,
      ]) {
        for (const [page, cdp] of pages) await setUp(page, cdp, { ...size, scale }, null);
        off.push(...(await step(`${size.width} x ${size.height} at ${Math.round(scale * 100)}%`)));
      }
    }
  } finally {
    for (const [page, cdp] of pages) await setUp(page, cdp, DESK, null);
  }
  return off;
}

/**
 * In each line of quick numbers or summary units: the item after Passive
 * Perception (Init, the elevation, the Sheet link) stands on Passive
 * Perception's line wherever it fits there, 12 px after it, as the units
 * stand apart (FU31 review F1). The item is the next element after
 * Passive Perception's box or the first of its boxes that has one.
 */
export function afterPpLines(lines: Locator, at: string): Promise<string[]> {
  return lines.evaluateAll(
    (els, at) => {
      type R = { left: number; right: number; top: number; bottom: number; width: number };
      type E = { offsetWidth: number; textContent: string | null; parentElement: E | null; nextElementSibling: E | null; firstElementChild: E | null; getBoundingClientRect(): R; querySelector(s: string): E | null };
      const g = globalThis as unknown as { getComputedStyle(e: E): { marginRight: string } };
      const out: string[] = [];
      for (const line of els as unknown as E[]) {
        const pp = line.querySelector('[role="img"][aria-label^="Passive Perception"]');
        if (!pp) continue;
        let next: E | null = null;
        for (let x: E | null = pp; x && x !== line && !next; x = x.parentElement) next = x.nextElementSibling;
        // A box drawn as its contents has no box of its own: its first item stands for it.
        while (next && next.getBoundingClientRect().width === 0 && next.firstElementChild) next = next.firstElementChild;
        if (!next) continue;
        const box = line.getBoundingClientRect();
        const zoom = box.width / line.offsetWidth;
        const p = pp.getBoundingClientRect();
        const n = next.getBoundingClientRect();
        const mid = (r: R) => (r.top + r.bottom) / 2;
        const beside = Math.abs(mid(p) - mid(n)) < 2;
        // With the margin it takes when another unit follows it, which wraps it as its width does.
        const fits = p.right + (12 + (parseFloat(g.getComputedStyle(next).marginRight) || 0)) * zoom + n.width <= box.right + 0.5;
        if (!beside && fits) out.push(`${at}: "${(next.textContent ?? "").trim()}" stands on a line of its own after PP, where it fits beside PP (${(box.right - p.right).toFixed(1)} px left for ${n.width.toFixed(1)})`);
      }
      return out;
    },
    at,
  );
}

/**
 * Each line of a button row that grows its buttons ends at the row's end,
 * so no button keeps its own width where the others fill theirs (FU31
 * review F9). `button` names one button in the row.
 */
export function unfilledLines(button: Locator, at: string): Promise<string[]> {
  return button.locator("xpath=..").evaluate((row, at) => {
    type R = { top: number; bottom: number; right: number };
    type E = { textContent: string | null; getBoundingClientRect(): R };
    const box = (row as unknown as E).getBoundingClientRect();
    const buttons = Array.from((row as unknown as { children: ArrayLike<E> }).children);
    const out: string[] = [];
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      const later = buttons.filter((o) => o !== b && Math.abs(o.getBoundingClientRect().top - r.top) < 1 && o.getBoundingClientRect().right > r.right);
      if (later.length === 0 && box.right - r.right > 1) out.push(`${at}: "${(b.textContent ?? "").trim()}" ends its line ${(box.right - r.right).toFixed(1)} px short of the row's end`);
    }
    return out;
  }, at);
}

/**
 * Units in each line, the panel header's quick numbers or a summary line,
 * whose box runs past the line's end: AC, the speed and its modes, PP,
 * Init, the elevation and the sheet link (FU31 review F10).
 */
export function pastLineEnd(lines: Locator, at: string): Promise<string[]> {
  return lines.evaluateAll(
    (els, at) => {
      type E = { textContent: string | null; getBoundingClientRect(): { right: number; width: number }; querySelectorAll(s: string): ArrayLike<E> };
      const out = new Set<string>();
      for (const line of els as unknown as E[]) {
        const end = line.getBoundingClientRect().right;
        for (const unit of Array.from(line.querySelectorAll('[role="img"], [data-unit], a'))) {
          const r = unit.getBoundingClientRect();
          if (r.width > 0 && r.right > end + 0.5) out.add(`${at}: "${(unit.textContent ?? "").trim()}" runs ${(r.right - end).toFixed(1)} px past its line's end`);
        }
      }
      return [...out];
    },
    at,
  );
}

/** A panel's group by the name on its fold (components/Panel.tsx Group). */
export function groupIn(scope: Locator, name: string): Locator {
  return scope.locator("[data-panel-group]").filter({ has: scope.page().getByRole("button", { name, exact: true }) });
}

/** The headings of Combat's sections, in order. */
export function combatSections(panel: Locator): Promise<string[]> {
  return groupIn(panel, "Combat").evaluate((el) => Array.from((el as unknown as El).querySelectorAll("h4")).map((h) => (h.textContent ?? "").trim()));
}

/** A folded group's row and its summary: the row's height, the summary's words, its width and the width its words need, whether they are cut, and its 4em floor (docs/design-v1-icons-2.md 3.3). */
export function foldedSummary(panel: Locator, name: string): Promise<{ text: string; width: number; needs: number; cut: boolean; floor: number; row: number }> {
  return panel.getByRole("button", { name, exact: true }).evaluate((el) => {
    type Q = El & { querySelector(s: string): El | null };
    const button = el as unknown as Q;
    const summary = button.querySelector("[id$='-summary']");
    if (!summary) throw new Error("no summary on the folded row");
    const fontSize = parseFloat((globalThis as unknown as { getComputedStyle(e: El): { fontSize: string } }).getComputedStyle(summary).fontSize);
    return { text: summary.textContent ?? "", width: summary.clientWidth, needs: summary.scrollWidth, cut: summary.scrollWidth > summary.clientWidth + 1, floor: fontSize * 4, row: button.getBoundingClientRect().height };
  });
}

/**
 * Whether the HP field comes before the mode buttons in the page, the order
 * Tab and a screen reader follow: in the short layout, which draws the
 * field first (docs/design-v1-token-window.md 5.8, W5B-P-5).
 */
export function fieldBeforeModes(b: Locator): Promise<boolean> {
  return b.evaluate((el) => {
    type N = { querySelector(s: string): N | null; compareDocumentPosition(o: N): number };
    const root = el as unknown as N;
    const field = root.querySelector('input[aria-label="HP change"]');
    const modes = root.querySelector('[role="radiogroup"][aria-label="What the number does"]');
    // DOCUMENT_POSITION_FOLLOWING: the modes follow the field.
    return field !== null && modes !== null && (field.compareDocumentPosition(modes) & 4) !== 0;
  });
}

/** Apply shows whole inside the bar's box with the bar at its top, so an HP change needs no scroll. */
export async function applyInView(b: Locator, label: string): Promise<void> {
  // The window scrolls inside its frame, in its scroller (docs/design-v1-token-window.md 5.7).
  assert.equal(await b.locator("[data-bar-scroll]").evaluate((el) => (el as unknown as El).scrollTop), 0, `${label}: the bar opened scrolled`);
  const frame = await rectOf(b);
  const apply = await rectOf(b.getByRole("button", { name: "Apply", exact: true }));
  assert.ok(apply.top >= frame.top && apply.bottom <= frame.bottom + 1, `${label}: Apply is out of the bar's view: ${JSON.stringify({ apply, frame })}`);
}

export async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
}

/** The font family the page computes for an element, which its text draws in. */
export function familyOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => (el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { fontFamily: string } } } }).ownerDocument.defaultView.getComputedStyle(el).fontFamily);
}

/**
 * Where a button's label ends below the words "Scroll for more", each read
 * from its own line of text, so neither the fade's padding nor the
 * button's counts. Null while the label is clear or nothing fades.
 */
export function labelUnderFade(b: Locator, name: string): Promise<{ label: number; wordsTop: number } | null> {
  return b.evaluate((el, name) => {
    type Rect = { top: number; bottom: number };
    type Node = { tagName: string; textContent: string | null; ownerDocument: { createRange(): { selectNodeContents(n: unknown): void; getBoundingClientRect(): Rect } } };
    const nodes = Array.from((el as unknown as { querySelectorAll(s: string): ArrayLike<Node> }).querySelectorAll("button, div"));
    const button = nodes.find((n) => n.tagName === "BUTTON" && n.textContent?.trim() === name);
    // The innermost box that holds the words: the fade's sticky holder holds them too.
    const words = nodes.filter((n) => n.tagName === "DIV" && n.textContent === "Scroll for more").pop();
    if (!button || !words) return null;
    const text = (n: Node) => {
      const range = n.ownerDocument.createRange();
      range.selectNodeContents(n);
      return range.getBoundingClientRect();
    };
    const label = text(button).bottom;
    const wordsTop = text(words).top;
    return label > wordsTop + 0.5 ? { label, wordsTop } : null;
  }, name);
}

/** Size stands under the steady line in every layout, so it never pushes Conditions or Multi-select down (the project owner's answer to W5B-P-2). */
export async function steadyAboveSize(b: Locator, label: string): Promise<void> {
  const steady = await rectOf(b.locator('[data-bar-row="play"]'));
  const size = await rectOf(b.getByRole("group", { name: "Size", exact: true }));
  assert.ok(steady.bottom <= size.top + 1, `${label}: Size stands above Conditions and Multi-select`);
}

/** Range rings in one block (docs/design-v1-token-panel.md 3.8): circle presets with their digits centered, and the field for another distance ending their row. */
export async function ringsCompact(panel: Locator, where: string): Promise<void> {
  const group = panel.getByRole("group", { name: "Range rings in feet", exact: true });
  const chips = await group.getByRole("button").evaluateAll((els) =>
    els.map((el) => {
      const box = (el as unknown as El).getBoundingClientRect();
      const doc = (el as unknown as { ownerDocument: { createRange(): { selectNodeContents(n: unknown): void; getBoundingClientRect(): Rect } } }).ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      return { box, text };
    }),
  );
  assert.equal(chips.length, 8, `${where}: the eight presets`);
  for (const { box, text } of chips) {
    assert.ok(Math.abs(box.width - box.height) <= 1, `${where}: a preset is a circle, ${box.width} x ${box.height}`);
    assert.ok(Math.abs(text.left + text.width / 2 - (box.left + box.width / 2)) <= 1, `${where}: a preset's digits sit in its middle`);
  }
  const last = chips[chips.length - 1]!.box;
  const fieldBox = group.getByRole("textbox", { name: "Custom ring distance in feet", exact: true });
  assert.equal(await fieldBox.getAttribute("placeholder"), "Custom ft", `${where}: the field's placeholder`);
  const room = await fieldBox.evaluate((el) => {
    type Input = { placeholder: string; clientWidth: number; ownerDocument: Doc & { createElement(t: string): { getContext(k: string): { font: string; measureText(t: string): { width: number } } } }; };
    const input = el as unknown as Input;
    const view = (input.ownerDocument as unknown as { defaultView: { getComputedStyle(e: unknown): Record<string, string> } }).defaultView;
    const cs = view.getComputedStyle(el);
    const pen = input.ownerDocument.createElement("canvas").getContext("2d");
    pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return { inside: input.clientWidth - Number.parseFloat(cs.paddingLeft!) - Number.parseFloat(cs.paddingRight!), text: pen.measureText(input.placeholder).width };
  });
  assert.ok(room.inside >= room.text, `${where}: the placeholder is cut, ${room.text} px in ${room.inside}`);
  const field = await rectOf(fieldBox);
  assert.ok(Math.abs(field.top + field.height / 2 - (last.top + last.height / 2)) <= 2 && field.left >= last.right, `${where}: the field ends the presets' row`);
  assert.equal(await panel.getByText("Another distance", { exact: true }).count(), 0, `${where}: no label or help under the rings`);
}

/**
 * Max HP and Temp HP side by side at every width (docs/design-v1-token-panel.md 3.7): the fields share a line, and both
 * labels stand beside or above alike, the way the doc's size table says for this width.
 */
export async function hpPairSideBySide(panel: Locator, where: string, labels: "beside" | "above"): Promise<void> {
  const maxHp = await rectOf(panel.getByRole("textbox", { name: "Max HP", exact: true }));
  const tempHp = await rectOf(panel.getByRole("textbox", { name: "Temporary HP", exact: true }));
  assert.ok(Math.abs(maxHp.top - tempHp.top) <= 2, `${where}: Max HP and Temp HP share a line`);
  assert.ok(tempHp.left >= maxHp.right, `${where}: Temp HP stands right of Max HP`);
  const shown = await panel
    .locator("[data-rvtt-hp-pair] > [data-rvtt-labeled] > span:first-child")
    .evaluateAll((els) => els.map((el) => (el as unknown as El).getBoundingClientRect()));
  assert.equal(shown.length, 2, `${where}: two labels`);
  assert.ok(Math.abs(shown[0]!.top - shown[1]!.top) <= 2, `${where}: the labels stand alike`);
  const width = (await rectOf(panel.locator("[data-rvtt-hp-pair]"))).width;
  for (const [label, field] of [
    [shown[0]!, maxHp],
    [shown[1]!, tempHp],
  ] as const) {
    if (labels === "above") {
      // Above its field, a label starts where the field starts, as labels do down the rest of the panel.
      assert.ok(label.bottom <= field.top + 1 && Math.abs(label.left - field.left) <= 1, `${where}: a label above its field at a ${width} px pair`);
    } else {
      const middle = label.top + label.height / 2;
      assert.ok(label.right <= field.left + 1 && middle > field.top && middle < field.bottom, `${where}: a label beside its field at a ${width} px pair`);
    }
  }
}

/**
 * With four rings on (docs/design-v1-token-panel.md 3.8), one muted line says so, and the presets that are off and the
 * field stay in the tab order, aria-disabled and described by that line, doing nothing when pressed. Clear empties it again.
 */
export async function ringsFull(panel: Locator, where: string): Promise<void> {
  const group = panel.getByRole("group", { name: "Range rings in feet", exact: true });
  for (const ft of ["5", "10", "15", "30"]) await group.getByRole("button", { name: ft, exact: true }).click();
  const line = panel.getByText("At most 4 rings. Turn one off to add another.", { exact: true });
  await line.waitFor();
  const lineId = await line.getAttribute("id");
  assert.ok(lineId, `${where}: the line has an id`);
  const off = group.getByRole("button", { name: "60", exact: true });
  const field = group.getByRole("textbox", { name: "Custom ring distance in feet", exact: true });
  for (const control of [off, field]) {
    assert.equal(await control.getAttribute("aria-disabled"), "true", `${where}: aria-disabled`);
    assert.equal(await control.getAttribute("aria-describedby"), lineId, `${where}: described by the line`);
    // Not the `disabled` attribute, which would take it out of the tab order. Playwright's isDisabled counts aria-disabled too.
    assert.equal(await control.evaluate((el) => (el as unknown as { disabled: boolean }).disabled), false, `${where}: still in the tab order`);
    await control.focus();
    assert.ok(await control.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), `${where}: takes focus`);
  }
  assert.equal(await field.evaluate((el) => (el as unknown as { readOnly: boolean }).readOnly), true, `${where}: the field takes no typing`);
  // By keyboard, as the person who found them would try them: neither adds a fifth ring.
  const keyboard = panel.page().keyboard;
  await off.focus();
  await keyboard.press("Enter");
  await field.focus();
  await keyboard.type("45");
  await keyboard.press("Enter");
  await settle(panel);
  assert.equal(await off.getAttribute("aria-pressed"), "false", `${where}: a fifth ring stays off`);
  assert.equal(await field.inputValue(), "", `${where}: the field took no distance`);
  assert.equal(await group.getByRole("button", { pressed: true }).count(), 4, `${where}: still four rings`);
  await group.scrollIntoViewIfNeeded();
  await shots.take(panel.page(), "tokenpanel-range-rings-full");
  await panel.getByRole("button", { name: "Remove every range ring", exact: true }).click();
  await line.waitFor({ state: "detached" });
}

export function focused(page: Page): Promise<{ name: string; expanded: string | null; role: string | null }> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: Doc }).document.activeElement;
    return { name: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim(), expanded: a?.getAttribute("aria-expanded") ?? null, role: a?.getAttribute("role") ?? null };
  });
}

/** The AC shields on the map, each with its number and its box on the page. */
export function mapBadges(page: Page): Promise<{ text: string; rect: Rect; textWidth: number }[]> {
  return page.evaluate(() => {
    type Node = { getClientRect(): { x: number; y: number; width: number; height: number }; findOne(s: string): { text(): string; getTextWidth(): number } | undefined };
    const g = globalThis as unknown as { Konva: { stages: { find(s: string): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } };
    const stage = g.Konva.stages[0]!;
    const box = stage.container().getBoundingClientRect();
    return stage.find(".ac-badge").map((n) => {
      const r = n.getClientRect();
      const t = n.findOne("Text");
      const left = box.left + r.x;
      const top = box.top + r.y;
      return { text: t?.text() ?? "", textWidth: t?.getTextWidth() ?? 0, rect: { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height } };
    });
  });
}

/** The padlocks on the map, by their boxes on the page. */
export function mapLocks(page: Page): Promise<Rect[]> {
  return page.evaluate(() => {
    type Node = { getClientRect(): { x: number; y: number; width: number; height: number } };
    const g = globalThis as unknown as { Konva: { stages: { find(s: string): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } };
    const stage = g.Konva.stages[0]!;
    const box = stage.container().getBoundingClientRect();
    return stage.find(".lock-mark").map((n) => {
      const r = n.getClientRect();
      return { left: box.left + r.x, top: box.top + r.y, right: box.left + r.x + r.width, bottom: box.top + r.y + r.height, width: r.width, height: r.height };
    });
  });
}

/** Waits for every scroller in the scope to hold still, so boxes read one after another come from one scroll position. */
export async function settle(scope: Locator): Promise<void> {
  const read = () =>
    scope.evaluate((root) => {
      const all = [root as unknown as El, ...Array.from((root as unknown as El).querySelectorAll("*"))];
      return all.map((el) => el.scrollTop).join(",");
    });
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const next = await read();
    if (next === last) return;
    last = next;
  }
}

/** A token's footprint on the page. */
export async function footprintRect(page: Page, at: { x: number; y: number }, size = 1): Promise<Rect> {
  const a = await pagePoint(page, BOUNDS, at);
  const b = await pagePoint(page, BOUNDS, { x: at.x + size, y: at.y + size });
  return { left: a.x, top: a.y, right: b.x, bottom: b.y, width: b.x - a.x, height: b.y - a.y };
}

export const inside = (r: Rect, box: Rect) => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;

/**
 * Nothing in the scope runs out of its box sideways: the scope and every
 * box in it fits its content to its width. A box built to scroll or clip
 * sideways, such as a stat block's ability table, which scrolls inside its
 * own frame, is left out, and so is text kept for screen readers alone.
 */
export async function noSideScroll(scope: Locator, label: string): Promise<void> {
  const wide = await scope.evaluate((root) => {
    type Styled = El & { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { overflowX: string } } } };
    const all = [root as unknown as Styled, ...(Array.from((root as unknown as El).querySelectorAll("*")) as Styled[])];
    return all
      .filter((el) => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1)
      .filter((el) => el === (root as unknown) || el.ownerDocument.defaultView.getComputedStyle(el).overflowX === "visible")
      .map((el) => `${el.getAttribute("data-unit") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").slice(0, 30)}: ${el.scrollWidth} > ${el.clientWidth}`);
  });
  assert.deepEqual(wide, [], `${label}: content wider than its box`);
}

/** Each speed unit on one line: a line breaks only between modes. */
export async function speedUnitsWhole(scope: Locator, label: string): Promise<void> {
  const units = scope.locator('[data-unit="speed"]');
  const n = await units.count();
  assert.ok(n > 0, `${label}: no speed shows`);
  for (let i = 0; i < n; i++) {
    const r = await rectOf(units.nth(i));
    assert.ok(r.height < 30, `${label}: speed unit ${i} broke inside (${r.height} px tall)`);
  }
}

/**
 * One file of the token panel's steps: the server, the DM's and Pat's
 * pages, the room step 0 builds, what `steps` registers, and step 10. A
 * `part` names the file's share after the suite's own name.
 */
export function panelFile(part: string | null, steps: () => void): void {
  describe(`raccoon-vtt: the token panel, the stat summary and AC on tokens${part === null ? "" : `: ${part}`}`, { timeout: 900_000 }, () => {
    before(async () => {
      server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
      browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
      dmContext = await browser.newContext({ viewport: { width: DESK.width, height: DESK.height } });
      dm = await dmContext.newPage();
      dmConsole.attach(dm);
      await dmSocket.attach(dmContext, dm);
      dmCdp = await dmContext.newCDPSession(dm);
      playerContext = await browser.newContext({ viewport: { width: DESK.width, height: DESK.height } });
      player = await playerContext.newPage();
      playerConsole.attach(player);
      await playerSocket.attach(playerContext, player);
      playerCdp = await playerContext.newCDPSession(player);
    });

    after(async () => {
      if (process.env.E2E_DEBUG === "1") {
        for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

    test("0. a DM's room with Pat's Thorn and Wild Shape, Bree's token Pat holds, and a monster of every kind the summary reads", async () => {
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

      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      run.patId = ((await done.json()) as { member: { id: string } }).member.id;

      const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
      // A small scene, so a medium creature is big enough for its shield at the window's fit.
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
      await ops.send({ t: "monster.create", monster: bogThing(run.bog.monsterId) });
      await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor({ ac: 16, hp: { cur: 31, max: 38, temp: 5 }, passivePerception: 14, sheetUrl: SHEET }) } });
      // Bree is the DM's: Pat holds her token, as a charmed ally, without her sheet.
      await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [], actor: actor({ ac: 17, hp: { cur: 12, max: 24, temp: 0 }, passivePerception: 15 }) } });
      const token = (id: string, at: { x: number; y: number }, extra: Record<string, unknown>) => ({
        t: "token.create",
        token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", x: at.x, y: at.y, disposition: "hostile", kind: "monster", ...extra },
      });
      await ops.send(token(run.thorn.id, run.thorn.at, { kind: "pc", name: "Thorn", disposition: "ally", actor: { ref: run.thorn.characterId } }));
      await ops.send(token(run.bear.id, run.bear.at, { kind: "npc", name: "Brown Bear", disposition: "ally", ownerIds: [run.patId], actor: { inline: actor({ ac: 11, srdId: "brown-bear", speeds: { walk: 40, climb: 30 }, passivePerception: 13, hp: { cur: 22, max: 22, temp: 0 } }) } }));
      await ops.send(token(run.bree.id, run.bree.at, { kind: "pc", name: "Bree", disposition: "ally", ownerIds: [run.patId], actor: { ref: run.bree.characterId } }));
      await ops.send(token(run.dragon.id, run.dragon.at, { name: "Adult White Dragon", size: "huge", hpVisibility: "label", actor: { inline: actor({ ac: 18, srdId: "adult-white-dragon", speeds: { walk: 40, burrow: 30, fly: 80, swim: 40 }, passivePerception: 21, hp: { cur: 200, max: 200, temp: 0 } }) } }));
      await ops.send(token(run.goblin.id, run.goblin.at, { name: "Goblin", number: 4, image: ICON, hpVisibility: "label", actor: { inline: actor({ ac: 15, srdId: "goblin-warrior", passivePerception: 9, hp: { cur: 10, max: 10, temp: 0 } }) } }));
      await ops.send(token(run.bog.id, run.bog.at, { name: "Bog Thing", hpVisibility: "label", actor: { inline: actor({ ac: 13, monsterId: run.bog.monsterId, speeds: { walk: 20, swim: 20 }, hp: { cur: 30, max: 30, temp: 0 } }) } }));
      await ops.send(token(run.swift.id, run.swift.at, { kind: "npc", name: "Swift", hpVisibility: "label", actor: { inline: actor({ ac: 100, speeds: { walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: true }, passivePerception: 60, hp: { cur: 100000, max: 100000, temp: 0 } }) } }));
      await ops.send(token(run.soft.id, run.soft.at, { kind: "npc", name: "Soft", hpVisibility: "label", actor: { inline: actor({ ac: 9 }) } }));
      await ops.send(token(run.villager.id, run.villager.at, { kind: "npc", name: "Villager", disposition: "neutral", hpVisibility: "label", actor: { inline: actor({ ac: 10 }) } }));
      await ops.send(token(run.chest.id, run.chest.at, { kind: "object", layer: "object", name: "Chest", disposition: "neutral", hpVisibility: "hidden", actor: { inline: actor({ ac: 15 }) } }));
      await ops.send(token(run.ogre.id, run.ogre.at, { name: "Ogre", size: "large", locked: true, hpVisibility: "label", actor: { inline: actor({ ac: 11, srdId: "ogre", speeds: { walk: 40 }, passivePerception: 8, hp: { cur: 68, max: 68, temp: 0 } }) } }));
      await ops.send({ t: "monster.create", monster: { ...bogThing(run.mire.monsterId), name: "Mire Thing" } });
      await ops.send(token(run.mire.id, run.mire.at, { name: "Mire Thing", hpVisibility: "label", actor: { inline: actor({ ac: 13, monsterId: run.mire.monsterId }) } }));
      await ops.send({ t: "monster.delete", monsterId: run.mire.monsterId });
      await ops.send(token(run.weapon.id, run.weapon.at, { kind: "object", name: "Spiritual Weapon", disposition: "ally", hpVisibility: "hidden", actor: { inline: actor({ ac: 0, hp: { cur: 0, max: 0, temp: 0 } }) } }));
      await ops.send(token(run.herald.id, run.herald.at, { kind: "npc", name: run.herald.name, disposition: "neutral", hpVisibility: "label", actor: { inline: actor({ ac: 14 }) } }));
      await waitFor("every token in the DM's view", () => [run.thorn, run.bear, run.bree, run.dragon, run.goblin, run.bog, run.swift, run.soft, run.villager, run.chest, run.ogre, run.mire, run.weapon, run.herald].every((t) => dmSocket.state?.tokens[t.id]) || null);

      await player.goto(`${server.origin}/r/${run.roomId}`);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
    });

    steps();

    test("10. no page errors along the way", () => {
      assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
      assert.deepEqual(playerConsole.errors.filter((e) => e.startsWith("uncaught")), []);
    });
  });
}
