import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Route } from "playwright-core";
import { INTER_FAMILY } from "../client/lib/interFont.ts";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";
import { assetRow, chooseStarterWork, starterCounts, starterWork } from "./starterPick.ts";

/**
 * The token panel, the stat summary and AC on tokens
 * (docs/design-v1-token-panel.md section 7) on the real server serving the
 * production build: the bar's summary and its two rows of buttons, "Stat
 * block" opening the block in the panel beside the bar, Escape after it,
 * the panel's order and folds and what this device remembers of them, the
 * compact image and HP rows, the AC shield on the map, no horizontal
 * overflow for the longest stats, the short bar on a phone held sideways,
 * and what a player's device shows and holds.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus ten. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 *
 * The very short sideways sheet (docs/design-v1-layout-hierarchy.md 4.2)
 * is checked at 480 x 320 at 130%, where it always applies (steps 5 and
 * 7c). With the turn band it applies at larger sizes only where the strip
 * cannot stay in the top bar, which that design's own e2e reaches.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 10;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-tokenpanel-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const FOLDS_KEY = "rvtt.tokenPanelFolds";
const BOUNDS = { w: 16, h: 10 };
const ICON = { icon: "lorc/wolf-head", color: "#336699" };
const SHEET = "https://www.dndbeyond.com/characters/1";
/** A room monster's Immunities as long as a DM may type, to clamp in the bar. */
const LONG_IMMUNITIES = `Poison, Psychic; ${Array.from({ length: 30 }, (_, i) => `Charmed by the ${i + 1}th moon`).join(", ")}`.slice(0, 480);

type Insets = { side?: number; bottom?: number };
type View = { width: number; height: number; scale: number; insets?: Insets };
const DESK: View = { width: 1280, height: 800, scale: 1 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const cell = (x: number, y: number) => ({ x, y });
const run = {
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

function actor(over: Record<string, unknown> = {}) {
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
function bogThing(id: string) {
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

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type El = {
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
type Doc = { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };

/** Sets the safe areas, the window and the interface size, and loads the room again. Storage is left as the run set it, unless `folds` says. */
/**
 * Fails the SRD monsters' data and nothing else. The bundler can name a
 * shared code chunk "monsters" too, after shared/srd/monsters.ts, and the
 * room cannot load without that one, so a route by the name alone took
 * the whole page down.
 */
async function failSrdData(route: Route): Promise<void> {
  const response = await route.fetch();
  const body = await response.text();
  if (body.includes('"srdId":"aboleth"')) await route.abort();
  else await route.fulfill({ response, body });
}

async function setUp(page: Page, cdp: CDPSession, view: View, folds?: string | null): Promise<void> {
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
async function resize(page: Page, cdp: CDPSession, view: Omit<View, "scale">): Promise<void> {
  const i = view.insets ?? {};
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.waitForTimeout(400);
}

function storedFolds(page: Page): Promise<string | null> {
  return page.evaluate((key) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(key), FOLDS_KEY);
}

/** Taps a token by the middle of its footprint, after checking the map takes the tap there. */
async function tapToken(page: Page, at: { x: number; y: number }, size = 1): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: at.x + size / 2, y: at.y + size / 2 });
  const tag = await page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
  assert.equal(tag, "CANVAS", `the map does not take a tap at ${at.x},${at.y}`);
  await page.mouse.click(p.x, p.y);
}

function bar(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `${name} actions` });
}

/** The token's panel: the side panel's Token tab from 900 px up, the Token sheet below. */
function tokenPanel(page: Page): Locator {
  // Exact, since the panel's Token settings group is a region of its own.
  return page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true }));
}

/** Opens one of the panel's groups (docs/design-v1-token-panel-groups.md), which Image, Notes and Position start folded. */
async function openGroup(panel: Locator, name: string): Promise<void> {
  const fold = panel.getByRole("button", { name, exact: true });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await waitFor(`${name} open`, async () => ((await fold.getAttribute("aria-expanded")) === "true" ? true : null), 3000);
}

/**
 * Whether the HP field comes before the mode buttons in the page, the order
 * Tab and a screen reader follow: in the short layout, which draws the
 * field first (docs/design-v1-token-window.md 5.8, W5B-P-5).
 */
function fieldBeforeModes(b: Locator): Promise<boolean> {
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
async function applyInView(b: Locator, label: string): Promise<void> {
  // The window scrolls inside its frame, in its scroller (docs/design-v1-token-window.md 5.7).
  assert.equal(await b.locator("[data-bar-scroll]").evaluate((el) => (el as unknown as El).scrollTop), 0, `${label}: the bar opened scrolled`);
  const frame = await rectOf(b);
  const apply = await rectOf(b.getByRole("button", { name: "Apply", exact: true }));
  assert.ok(apply.top >= frame.top && apply.bottom <= frame.bottom + 1, `${label}: Apply is out of the bar's view: ${JSON.stringify({ apply, frame })}`);
}

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
}

/** The font family the page computes for an element, which its text draws in. */
function familyOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => (el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { fontFamily: string } } } }).ownerDocument.defaultView.getComputedStyle(el).fontFamily);
}

/**
 * Where a button's label ends below the words "Scroll for more", each read
 * from its own line of text, so neither the fade's padding nor the
 * button's counts. Null while the label is clear or nothing fades.
 */
function labelUnderFade(b: Locator, name: string): Promise<{ label: number; wordsTop: number } | null> {
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
async function steadyAboveSize(b: Locator, label: string): Promise<void> {
  const steady = await rectOf(b.locator('[data-bar-row="play"]'));
  const size = await rectOf(b.getByRole("group", { name: "Size", exact: true }));
  assert.ok(steady.bottom <= size.top + 1, `${label}: Size stands above Conditions and Multi-select`);
}

/** Range rings in one block (docs/design-v1-token-panel.md 3.8): circle presets with their digits centered, and the field for another distance ending their row. */
async function ringsCompact(panel: Locator, where: string): Promise<void> {
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
async function hpPairSideBySide(panel: Locator, where: string, labels: "beside" | "above"): Promise<void> {
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
async function ringsFull(panel: Locator, where: string): Promise<void> {
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

function focused(page: Page): Promise<{ name: string; expanded: string | null; role: string | null }> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: Doc }).document.activeElement;
    return { name: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim(), expanded: a?.getAttribute("aria-expanded") ?? null, role: a?.getAttribute("role") ?? null };
  });
}

/** The AC shields on the map, each with its number and its box on the page. */
function mapBadges(page: Page): Promise<{ text: string; rect: Rect; textWidth: number }[]> {
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
function mapLocks(page: Page): Promise<Rect[]> {
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
async function settle(scope: Locator): Promise<void> {
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
async function footprintRect(page: Page, at: { x: number; y: number }, size = 1): Promise<Rect> {
  const a = await pagePoint(page, BOUNDS, at);
  const b = await pagePoint(page, BOUNDS, { x: at.x + size, y: at.y + size });
  return { left: a.x, top: a.y, right: b.x, bottom: b.y, width: b.x - a.x, height: b.y - a.y };
}

const inside = (r: Rect, box: Rect) => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;

/**
 * Nothing in the scope runs out of its box sideways: the scope and every
 * box in it fits its content to its width. A box built to scroll or clip
 * sideways, such as a stat block's ability table, which scrolls inside its
 * own frame, is left out, and so is text kept for screen readers alone.
 */
async function noSideScroll(scope: Locator, label: string): Promise<void> {
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
async function speedUnitsWhole(scope: Locator, label: string): Promise<void> {
  const units = scope.locator('[data-unit="speed"]');
  const n = await units.count();
  assert.ok(n > 0, `${label}: no speed shows`);
  for (let i = 0; i < n; i++) {
    const r = await rectOf(units.nth(i));
    assert.ok(r.height < 30, `${label}: speed unit ${i} broke inside (${r.height} px tall)`);
  }
}

describe("raccoon-vtt: the token panel, the stat summary and AC on tokens", { timeout: 1_200_000 }, () => {
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

  test("1. the DM's bar on an SRD goblin: the summary, the HP entry after it, the saves, Stat block and Details, and the buttons in two rows; the shield on the map", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor();
    const vitals = goblin.locator("[data-vitals]");
    const text = await vitals.innerText();
    for (const words of ["HP 10/10", "Speed 30 ft", "Passive Perception 9"]) assert.ok(text.replace(/\s+/g, " ").includes(words), `the vitals lack "${words}": ${text}`);
    const saves = goblin.locator("[data-saves]");
    await saves.waitFor();
    assert.equal((await saves.innerText()).replace(/\s+/g, " ").trim(), "Saves STR −1 DEX +2 CON +0 INT +0 WIS −1 CHA −1");
    const entry = goblin.getByRole("textbox", { name: "HP change" });
    assert.equal(await fieldBeforeModes(goblin), false, "the full layout's modes come first in Tab order, as it draws them");
    const statBlock = goblin.getByRole("button", { name: "Stat block", exact: true });
    const details = goblin.getByRole("button", { name: "Details", exact: true });
    const tops = await Promise.all([vitals, entry, saves, statBlock].map(async (l) => (await rectOf(l)).top));
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i]! > tops[i - 1]!, `the bar's parts out of order: ${tops.join(", ")}`);
    assert.ok(Math.abs((await rectOf(details)).top - tops[3]!) < 2, "Details sits beside Stat block");

    // The two rows: play first, then setup and Delete apart, starting a line of their own.
    // By name, since Hidden, Locked and Duplicate show their icon alone to a mouse (docs/design-v1-icons.md 4).
    const names = async (row: string) => goblin.locator(`[data-bar-row="${row}"] button`).evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim()));
    // Roll opens the Dice panel's options for the goblin (docs/design-v1-roll-options.md 4.5).
    assert.deepEqual(await names("play"), ["Conditions", "Hidden", "Multi-select", "Roll"]);
    assert.deepEqual(await names("less"), ["Locked", "Duplicate", "Delete"]);
    const multiSelect = await rectOf(goblin.getByRole("button", { name: "Multi-select", exact: true }));
    assert.ok(Math.abs(multiSelect.top - (await rectOf(goblin.getByRole("button", { name: "Conditions", exact: true }))).top) < 1, "Multi-select left Conditions' line");
    const locked = await rectOf(goblin.getByRole("button", { name: "Locked", exact: true }));
    assert.ok(locked.top >= multiSelect.bottom, "Locked starts a line of its own");
    assert.ok(Math.abs(locked.left - (await rectOf(goblin.locator('[data-bar-row="less"]'))).left) < 1);
    await steadyAboveSize(goblin, "a docked window");
    assert.ok((await rectOf(goblin.getByRole("group", { name: "Size", exact: true }))).bottom <= locked.top + 1, "Size stands under the less-used buttons");
    await shots.take(dm, "tokenpanel-dm-goblin-bar");

    // Buttons whose style names no family draw in Inter as the page does, not in the browser's control font (client/globals.css): a toolbar tool and the Conditions grid.
    const conditions = goblin.getByRole("button", { name: "Conditions", exact: true });
    await conditions.click();
    const grid = goblin.getByRole("group", { name: "Conditions", exact: true });
    const tool = dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select", exact: true });
    for (const [what, control] of [["the Select tool", tool], ["a condition", grid.getByRole("button").first()]] as const) {
      const family = await familyOf(control);
      assert.ok(family.startsWith(`${INTER_FAMILY},`), `${what} draws in ${family}`);
    }
    await conditions.click();
    await grid.waitFor({ state: "detached" });

    // The shield on the goblin's token, in its bottom left corner, and none on the chest.
    const goblinBox = await footprintRect(dm, run.goblin.at);
    const badges = await mapBadges(dm);
    const onGoblin = badges.find((b) => inside(b.rect, goblinBox));
    assert.ok(onGoblin, `no shield on the goblin: ${JSON.stringify(badges)}`);
    assert.equal(onGoblin.text, "15");
    assert.ok(Math.abs(onGoblin.rect.left - goblinBox.left) < 2 && Math.abs(onGoblin.rect.bottom - goblinBox.bottom) < 2, "the shield sits in the bottom left corner");
    const chestBox = await footprintRect(dm, run.chest.at);
    assert.equal(badges.filter((b) => inside(b.rect, chestBox)).length, 0, "an object shows no shield");

    // Damage that kills the goblin takes its shield off the vitals line and the map.
    await entry.fill("10");
    await goblin.getByRole("button", { name: "Apply", exact: true }).click();
    await waitFor("the goblin dead", () => (dmSocket.state?.tokens[run.goblin.id]?.actor as { inline?: { life?: string } }).inline?.life === "dead");
    await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor({ state: "detached" });
    await waitFor("no shield on the dead goblin", async () => (await mapBadges(dm)).every((b) => !inside(b.rect, goblinBox)));
    assert.ok((await vitals.innerText()).includes("Dead"));
    await shots.take(dm, "tokenpanel-dm-goblin-dead");
    await ops.send({ t: "actor.life", target: { tokenId: run.goblin.id }, life: "alive" });
    await ops.send({ t: "actor.hp", target: { tokenId: run.goblin.id }, change: { kind: "set", cur: 10 } });
    await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor();
  });

  test("1z. at 130% on a desk, an icon's name shows beside it and inside the window: Duplicate in the action bar near the bottom, the window's resize handle, and Hide panels at the right edge (docs/design-v1-icons.md 3.2)", async () => {
    await setUp(dm, dmCdp, { ...DESK, scale: 1.3 }, null);
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    const view = dm.viewportSize()!;
    const zoom = 1.3;
    // The resize handle takes the shared tooltip too, never a native title (LP8-UI-9).
    const handle = goblin.getByRole("button", { name: "Resize window", exact: true });
    assert.equal(await handle.getAttribute("title"), null, "the resize handle keeps a native title");
    for (const control of [goblin.getByRole("button", { name: "Duplicate", exact: true }), handle, dm.getByRole("button", { name: "Hide panels", exact: true })]) {
      await dm.mouse.move(1, 1);
      await control.hover();
      const tip = dm.locator('[role="tooltip"]:popover-open');
      await tip.waitFor();
      const at = await rectOf(control);
      const box = await rectOf(tip);
      const label = `${await control.getAttribute("aria-label")}: ${JSON.stringify({ at, box })}`;
      assert.ok(box.left >= -0.5 && box.top >= -0.5 && box.right <= view.width + 0.5 && box.bottom <= view.height + 0.5, `the tip leaves the window: ${label}`);
      const above = Math.abs(at.top - box.bottom - 6 * zoom) < 2;
      const below = Math.abs(box.top - at.bottom - 6 * zoom) < 2;
      assert.ok(above || below, `the tip is not beside its control: ${label}`);
      const centered = Math.abs(box.left + box.width / 2 - (at.left + at.width / 2)) < 2;
      const atRightEdge = Math.abs(box.right - (view.width - 8 * zoom)) < 2;
      assert.ok(centered || atRightEdge, `the tip is neither centered on its control nor kept inside the right edge: ${label}`);
      await shots.take(dm, `tokenpanel-tip-130-${(await control.getAttribute("aria-label"))!.toLowerCase().replace(/\s+/g, "-")}`);
    }
    await dm.mouse.move(1, 1);
    await dm.keyboard.press("Escape");
    await setUp(dm, dmCdp, DESK, null);
  });

  test("1b. a flip to the short layout while the HP field has focus keeps its focus and what was typed, and the page's order follows what shows once focus leaves", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    const field = goblin.getByRole("textbox", { name: "HP change" });
    await field.click();
    await field.fill("3");
    // A shorter window leaves the docked bar under 300 px: the short layout.
    await resize(dm, dmCdp, { width: DESK.width, height: 430 });
    const modes = goblin.getByRole("radiogroup", { name: "What the number does" });
    assert.ok((await rectOf(field)).top < (await rectOf(modes)).top, "the short layout does not draw the field first");
    assert.equal(await field.evaluate((el) => (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement === el), true, "the flip dropped the field's focus");
    assert.equal(await field.inputValue(), "3");
    assert.equal(await fieldBeforeModes(goblin), false, "the page moved the focused field");
    // Focus leaves the entry: the page's order follows what shows.
    await goblin.focus();
    await waitFor("the field first in the page", async () => ((await fieldBeforeModes(goblin)) ? true : null), 3000);
    await resize(dm, dmCdp, { width: DESK.width, height: DESK.height });
    await waitFor("the modes first in the page again", async () => ((await fieldBeforeModes(goblin)) ? null : true), 3000);
    await field.fill("");
  });

  test("2. Stat block keeps the bar beside the Token tab at the block, with focus on its disclosure; Escape hides the bar, a second lets go", async () => {
    const before = await storedFolds(dm);
    const goblin = bar(dm, "Goblin 4");
    await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
    await dm.getByRole("tab", { name: "Token", selected: true }).waitFor();
    const panel = tokenPanel(dm);
    await waitFor("focus on the stat block's disclosure", async () => {
      const f = await focused(dm);
      return f.name === "Stat block" && f.expanded === "true";
    });
    assert.ok(await goblin.isVisible(), "Stat block closed the bar");
    await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
    await dm.waitForTimeout(600);
    assert.ok(await panel.getByRole("heading", { name: "Goblin Warrior" }).isVisible());
    await shots.take(dm, "tokenpanel-dm-stat-block-beside-bar");

    // From the panel's top, the block's disclosure is within 240 px, with the quick numbers above it under the name (docs/design-v1-token-panel-groups.md 3).
    await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await settle(panel);
    await dm.waitForTimeout(100);
    const top = (await rectOf(panel)).top;
    const disclosure = await rectOf(panel.getByRole("button", { name: "Stat block", exact: true }));
    assert.ok(disclosure.top - top <= 240, `the stat block starts ${disclosure.top - top} px down the panel`);
    const numbers = panel.locator("[data-quick-numbers]");
    assert.ok((await rectOf(numbers)).bottom <= disclosure.top + 1, "the quick numbers sit under the name, above the block");
    await numbers.getByRole("img", { name: "Passive Perception 9" }).waitFor();
    assert.equal(await storedFolds(dm), before, "the request wrote the folds");

    // Escape hides the bar and keeps the goblin in the panel, focus on the tab. A second lets go.
    await dm.keyboard.press("Escape");
    await goblin.waitFor({ state: "detached" });
    assert.ok(await panel.getByRole("heading", { name: "Goblin 4" }).isVisible(), "the panel let go of the goblin");
    assert.deepEqual(await focused(dm).then((f) => [f.name, f.role]), ["Token", "tab"]);
    await dm.keyboard.press("Escape");
    await panel.getByText("Tap a token to see it here.").waitFor();
    assert.equal(await storedFolds(dm), before);
  });

  test("3. the panel's order and folds, what this device keeps of them, and the compact image and HP rows", async () => {
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Goblin 4" }).waitFor();
    // A folded group's heading holds its summary after its name, so each is read by its first line. A group's sections are h4s under its h3.
    const headings = (await panel.locator("h3, h4").allInnerTexts()).map((h) => h.trim().toLowerCase().split("\n")[0]!.trim());
    const order = ["goblin 4", "stat block", "combat", "hit points", "conditions", "range rings", "rest", "notes", "position", "image", "stats", "token settings", "owners", "remove"];
    const at = order.map((h) => headings.indexOf(h));
    assert.ok(at.every((i) => i >= 0), `missing headings: ${JSON.stringify({ headings })}`);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! > at[i - 1]!, `out of order: ${headings.join(" | ")}`);
    assert.equal(headings.includes("companion"), false);
    assert.equal(await panel.getByRole("heading", { name: "Combat", level: 3 }).count(), 1, "a group is an h3");
    for (const name of ["Hit Points", "Conditions", "Range rings", "Rest"]) assert.equal(await panel.getByRole("heading", { name, level: 4, exact: true }).count(), 1, `${name} is an h4 inside Combat`);
    assert.equal(await panel.getByRole("region").count(), 0, "no group is a landmark");
    for (const name of ["Notes", "Position", "Image", "Stats", "Token settings", "Owners"]) assert.equal(await panel.getByRole("button", { name, exact: true }).getAttribute("aria-expanded"), "false", `${name} starts open`);
    assert.equal(await panel.getByRole("button", { name: "Combat", exact: true }).getAttribute("aria-expanded"), "true", "Combat starts folded");
    // A folded group says what it holds on its row, and only while folded.
    const rowText = async (name: string) => ((await panel.getByRole("button", { name, exact: true }).innerText()) ?? "").replace(/\s+/g, " ").trim();
    assert.equal(await rowText("Notes"), "Notes None yet");
    assert.equal(await rowText("Position"), "Position On the ground");
    assert.equal(await rowText("Combat"), "Combat", "an open group's row has a summary");
    await panel.getByRole("button", { name: "Combat", exact: true }).click();
    await panel.getByRole("heading", { name: "Hit Points" }).waitFor({ state: "detached" });
    assert.match(await rowText("Combat"), /^Combat HP 10\/10/);
    await shots.take(dm, "tokenpanel-dm-combat-folded");
    await panel.getByRole("button", { name: "Combat", exact: true }).click();
    await panel.getByRole("heading", { name: "Hit Points" }).waitFor();
    await openGroup(panel, "Image");

    // The image row: the preview, then "Change image" and "Add another image" on one line beside it.
    const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
    const another = panel.getByRole("button", { name: "Add another image", exact: true });
    const anotherBox = await rectOf(another);
    assert.ok(Math.abs(change.top - anotherBox.top) <= 2, "Change image and Add another image share a line");
    const panelLeft = (await rectOf(panel)).left;
    assert.ok(change.left - panelLeft >= 48 + 16, "the pair sits beside the preview");
    await hpPairSideBySide(panel, "the side panel", "beside");
    await ringsCompact(panel, "the side panel");
    await ringsFull(panel, "the side panel");
    await panel.getByRole("group", { name: "Maximum and Temporary HP", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(dm, "tokenpanel-dm-hp-pair");
    await panel.getByRole("group", { name: "Range rings in feet", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(dm, "tokenpanel-dm-range-rings");
    const purpose = "Another image this token can wear, for Wild Shape or a disguise. A tap on it here or in the token's bar puts it on.";
    const describedBy = await another.getAttribute("aria-describedby");
    assert.ok(describedBy);
    assert.equal((await dm.locator(`[id="${describedBy}"]`).textContent())?.trim(), purpose);
    assert.equal(await another.getAttribute("title"), purpose);
    await another.click();
    const picker = dm.getByRole("dialog", { name: "Choose an image" });
    await picker.getByText(purpose).waitFor();
    await shots.take(dm, "tokenpanel-dm-other-image-picker");
    await picker.getByRole("button", { name: /^Close/ }).first().click();
    await picker.waitFor({ state: "detached" });
    await shots.take(dm, "tokenpanel-dm-panel-top");

    // Token settings opened stays open through a reload, and storage holds it.
    await panel.getByRole("button", { name: "Token settings", exact: true }).click();
    await panel.getByRole("textbox", { name: "Height", exact: true }).waitFor();
    assert.equal(JSON.parse((await storedFolds(dm)) ?? "{}").settings, true);
    await dm.goto(`${server.origin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").getByRole("button", { name: "Details", exact: true }).click();
    await tokenPanel(dm).getByRole("heading", { name: "Goblin 4" }).waitFor();
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Token settings", exact: true }).getAttribute("aria-expanded"), "true");

    // A fold activated while a changed field still holds focus, as an assistive technology's click is, with no press to move focus first: the field's draft is kept, and focus lands on the disclosure.
    const settings = tokenPanel(dm).getByRole("button", { name: "Token settings", exact: true });
    const height = tokenPanel(dm).getByRole("textbox", { name: "Height", exact: true });
    await height.click();
    await height.fill("25");
    await settings.dispatchEvent("click");
    await height.waitFor({ state: "detached" });
    await waitFor("the height typed before the fold", () => dmSocket.state?.tokens[run.goblin.id]?.height === 25);
    assert.deepEqual(await focused(dm).then((f) => [f.name, f.expanded]), ["Token settings", "false"]);
    assert.equal(JSON.parse((await storedFolds(dm)) ?? "{}").settings, false);

    // A character with no stat block: the summary line under the image with the sheet link, and a Stat block fold that holds the buttons to add one.
    await tapToken(dm, run.thorn.at);
    await bar(dm, "Thorn").getByRole("button", { name: "Details", exact: true }).click();
    const thorn = tokenPanel(dm);
    await thorn.getByRole("heading", { name: "Thorn" }).first().waitFor();
    assert.equal(await thorn.getByRole("button", { name: "Stat block", exact: true }).count(), 1);
    const summary = thorn.locator("[data-quick-numbers]").first();
    await summary.getByRole("img", { name: "Armor Class 16" }).waitFor();
    assert.equal(await summary.getByRole("link", { name: "Open the sheet" }).getAttribute("href"), SHEET);
    assert.ok((await rectOf(summary)).top < (await rectOf(thorn.getByRole("heading", { name: "Hit Points" }))).top, "the summary line sits above Hit Points");
    await shots.take(dm, "tokenpanel-dm-thorn-summary-line");
    await dm.keyboard.press("Escape");
  });

  test("3b. the DM's Make a companion in Token settings starts with no character and the turn listed under it, waits for a character, and Cancel starts it again", async () => {
    await tapToken(dm, run.villager.at);
    await bar(dm, "Villager").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Villager" }).first().waitFor();
    await panel.getByRole("button", { name: "Token settings", exact: true }).click();
    const chosen = (name: string) => panel.getByRole("combobox", { name, exact: true }).locator("option:checked").textContent();
    await panel.getByRole("button", { name: "Make a companion", exact: true }).click();
    assert.equal(await chosen("Belongs to"), "Choose a character");
    assert.match((await chosen("Turn")) ?? "", /listed under/);
    const confirm = panel.getByRole("button", { name: "Make a companion", exact: true });
    assert.equal(await confirm.isDisabled(), true, "the confirm waits for a character");
    await panel.getByRole("combobox", { name: "Belongs to", exact: true }).selectOption({ label: "Thorn" });
    assert.equal(await chosen("Turn"), "On Thorn's turn, listed under Thorn");
    assert.equal(await confirm.isDisabled(), false);
    await shots.take(dm, "tokenpanel-dm-make-a-companion");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("button", { name: "Make a companion", exact: true }).click();
    assert.equal(await chosen("Belongs to"), "Choose a character", "Cancel starts the form again");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(dmSocket.state!.tokens[run.villager.id]!.companion, undefined, "nothing was sent");
    await panel.getByRole("button", { name: "Token settings", exact: true }).click();
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
  });

  test("3c. a character's card folded while a changed field holds focus keeps what was typed", async () => {
    await openSideTab(dm, "Characters");
    const list = dm.getByRole("tabpanel", { name: "Characters" });
    const card = list.getByRole("button", { name: /^Thorn/ }).and(list.locator("[aria-expanded]"));
    await card.click();
    const level = list.getByRole("textbox", { name: "Character level", exact: true });
    await level.click();
    await level.fill("5");
    await card.dispatchEvent("click");
    await level.waitFor({ state: "detached" });
    await waitFor("the level typed before the card folded", () => dmSocket.state?.characters[run.thorn.characterId]?.level === 5);
    assert.equal(await card.getAttribute("aria-expanded"), "false");
    const after = await focused(dm);
    assert.ok(after.expanded === "false" && after.name.includes("Thorn"), `focus stays on the card's row, not ${JSON.stringify(after)}`);
    await dm.getByRole("tab", { name: "Initiative" }).click();
  });

  test("4. a long Immunities line clamps in the bar and shows whole in the block; an unlinked NPC offers Attach; the lock stands above the shield; AC 9 and 100 fit their shields", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await tapToken(dm, run.bog.at);
    const bog = bar(dm, "Bog Thing");
    const line = bog.locator('[data-defense="Immunities"]');
    await line.waitFor();
    const clamp = await line.evaluate((el) => ({ client: (el as unknown as El).clientHeight, scroll: (el as unknown as El).scrollHeight }));
    // "Vulnerabilities Fire" is one line, the measure of a line.
    const oneLine = (await rectOf(bog.locator('[data-defense="Vulnerabilities"]'))).height;
    assert.ok(clamp.scroll > clamp.client, "the long line is not cut");
    assert.ok(clamp.client <= oneLine * 3 + 2 && clamp.client >= oneLine * 3 - 2, `not three lines: ${JSON.stringify({ ...clamp, oneLine })}`);
    const vulnerabilities = await rectOf(bog.locator('[data-defense="Vulnerabilities"]'));
    assert.ok(vulnerabilities.top < (await rectOf(line)).top, "Vulnerabilities come first");
    await shots.take(dm, "tokenpanel-dm-long-immunities");
    await bog.getByRole("button", { name: "Stat block", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByText(LONG_IMMUNITIES.slice(-40)).waitFor();
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");

    await tapToken(dm, run.villager.at);
    const villager = bar(dm, "Villager");
    await villager.waitFor();
    assert.equal(await villager.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    await villager.getByRole("button", { name: "Details", exact: true }).click();
    await tokenPanel(dm).getByRole("button", { name: "Attach a stat block", exact: true }).waitFor();
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).count(), 0, "a block with no link has no fold");
    await dm.keyboard.press("Escape");

    // A room monster deleted since: no saves and no Stat block in the bar, the note and Detach with the summary in the panel.
    await tapToken(dm, run.mire.at);
    const mire = bar(dm, "Mire Thing");
    await mire.getByRole("img", { name: "Armor Class 13" }).waitFor();
    assert.equal(await mire.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    assert.equal(await mire.locator("[data-saves]").count(), 0);
    await mire.getByRole("button", { name: "Details", exact: true }).click();
    const mirePanel = tokenPanel(dm).locator("[data-stat-block]");
    await mirePanel.getByText("This token’s stat block was deleted from this room.").waitFor();
    await mirePanel.getByRole("button", { name: "Detach", exact: true }).waitFor();
    await tokenPanel(dm).locator("[data-quick-numbers]").getByRole("img", { name: "Armor Class 13" }).waitFor();
    await dm.keyboard.press("Escape");

    // An HP-less token: no vitals, no HP entry, no shield.
    await tapToken(dm, run.weapon.at);
    const weapon = bar(dm, "Spiritual Weapon");
    await weapon.waitFor();
    assert.equal(await weapon.locator("[data-vitals]").count(), 0);
    assert.equal(await weapon.getByRole("textbox", { name: "HP change" }).count(), 0);
    await weapon.getByRole("button", { name: "Details", exact: true }).waitFor();
    await shots.take(dm, "tokenpanel-dm-hp-less-bar");
    await dm.keyboard.press("Escape");

    // The locked ogre: its lock stands above its shield on the left edge.
    const ogreBox = await footprintRect(dm, run.ogre.at, 2);
    const shield = (await mapBadges(dm)).find((b) => inside(b.rect, ogreBox));
    const lock = (await mapLocks(dm)).find((r) => inside(r, ogreBox));
    assert.ok(shield && lock, `the ogre's shield and lock: ${JSON.stringify({ shield, lock })}`);
    assert.ok(lock.bottom <= shield.rect.top + 1, "the lock stands above the shield");
    assert.ok(Math.abs(lock.left - ogreBox.left) < 2, "on the left edge");

    // AC 9 and 100: every digit inside the shield, on the map, in the bar and in the panel.
    for (const [at, name, ac] of [
      [run.soft.at, "Soft", "9"],
      [run.swift.at, "Swift", "100"],
    ] as const) {
      const box = await footprintRect(dm, at);
      const badge = (await mapBadges(dm)).find((b) => inside(b.rect, box));
      assert.ok(badge && badge.text === ac, `${name}'s shield on the map`);
      assert.ok(badge.textWidth <= badge.rect.width, `${name}'s number runs out of its shield on the map`);
      await tapToken(dm, at);
      const b = bar(dm, name);
      const img = b.getByRole("img", { name: `Armor Class ${ac}` });
      await img.waitFor();
      const fits = (l: Locator) => l.evaluate((el) => (el as unknown as El).scrollWidth <= (el as unknown as El).clientWidth + 1 && (el.querySelector("span[aria-hidden]") as unknown as El).getBoundingClientRect().width <= (el as unknown as El).getBoundingClientRect().width);
      assert.ok(await fits(img), `${name}'s number runs out of its shield in the bar`);
      await b.getByRole("button", { name: "Details", exact: true }).click();
      const inPanel = tokenPanel(dm).getByRole("img", { name: `Armor Class ${ac}` });
      await inPanel.waitFor();
      assert.ok(await fits(inPanel), `${name}'s number runs out of its shield in the panel`);
      await dm.keyboard.press("Escape");
    }
    await shots.take(dm, "tokenpanel-dm-shields");
  });

  test("5. the dragon's and the five-speed token's bars and panels run out of nothing, and their speeds break only between modes", async () => {
    const sizes: (View & { label: string })[] = [
      { ...DESK, label: "1280 x 800" },
      { width: 390, height: 844, scale: 1, label: "390 x 844" },
      { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 }, label: "480 x 320 at 130%" },
    ];
    for (const size of sizes) {
      await setUp(dm, dmCdp, size, null);
      for (const [t, name, span] of [
        [run.dragon, "Adult White Dragon", 3],
        [run.swift, "Swift", 1],
      ] as const) {
        await tapToken(dm, t.at, span);
        const b = bar(dm, name);
        await b.waitFor();
        await noSideScroll(b, `${size.label}, ${name}'s bar`);
        // A short bar keeps speed in More stats.
        const more = b.getByRole("button", { name: "More stats", exact: true });
        if ((await more.count()) > 0) await more.click();
        await speedUnitsWhole(b, `${size.label}, ${name}'s bar`);
        await noSideScroll(b, `${size.label}, ${name}'s bar opened`);
        await shots.take(dm, `tokenpanel-${size.width}x${size.height}-${name.split(" ")[0]!.toLowerCase()}-bar`);
        await b.getByRole("button", { name: "Details", exact: true }).click();
        const panel = tokenPanel(dm);
        await panel.getByRole("heading", { name, exact: true }).first().waitFor();
        // At 480 x 320 at 130% the panel takes the very short mode, over the whole screen with 243 px inside (docs/design-v1-layout-hierarchy.md 4.2).
        if (size.width === 480) assert.equal(await dm.locator('dialog[data-rvtt-sheet][aria-modal="true"]').count(), 1, `${size.label}: the panel opens over the whole screen`);
        await noSideScroll(panel, `${size.label}, ${name}'s panel`);
        await speedUnitsWhole(panel, `${size.label}, ${name}'s panel`);
        await shots.take(dm, `tokenpanel-${size.width}x${size.height}-${name.split(" ")[0]!.toLowerCase()}-panel`);
        // Let go, and on a phone close the sheet first.
        for (let i = 0; i < 3 && (await panel.count()) > 0 && (await panel.getByText("Tap a token to see it here.").count()) === 0; i++) await dm.keyboard.press("Escape");
        await dm.keyboard.press("Escape");
        await dm.waitForTimeout(200);
      }
    }
  });

  test("5b. an 80-character name: two lines in the bar's header, whole and wrapping in the panel, at a desk and on a phone", async () => {
    for (const size of [DESK, { width: 390, height: 844, scale: 1 }]) {
      await setUp(dm, dmCdp, size, null);
      await tapToken(dm, run.herald.at);
      const herald = bar(dm, run.herald.name);
      await herald.waitFor();
      await noSideScroll(herald, `${size.width}: the herald's bar`);
      const title = herald.locator("strong").filter({ hasText: run.herald.name.slice(0, 20) }).first();
      const clamp = await title.evaluate((el) => {
        const e = el as unknown as El & { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { lineHeight: string; fontSize: string } } } };
        const cs = e.ownerDocument.defaultView.getComputedStyle(e);
        return { client: e.clientHeight, scroll: e.scrollHeight, line: Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.25 };
      });
      assert.ok(clamp.client <= clamp.line * 2 + 2, `the bar's header shows more than two lines: ${JSON.stringify(clamp)}`);
      await herald.getByRole("button", { name: "Details", exact: true }).click();
      const heading = tokenPanel(dm).getByRole("heading", { name: run.herald.name });
      await heading.waitFor();
      assert.equal((await heading.innerText()).trim(), run.herald.name, "the panel shows the whole name");
      await noSideScroll(tokenPanel(dm), `${size.width}: the herald's panel`);
      await shots.take(dm, `tokenpanel-${size.width}-long-name`);
    }
  });

  test("6. a phone held upright: one line of vitals; the block folds, opens and is remembered; Stat block hides the bar and opens the sheet at it; the override lasts across 900 px", async () => {
    await setUp(dm, dmCdp, { width: 390, height: 844, scale: 1 }, null);
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    const vitals = await rectOf(goblin.locator("[data-vitals]"));
    assert.ok(vitals.height < 30, `the vitals take more than one line spanning: ${vitals.height} px`);
    const saves = await rectOf(goblin.locator("[data-saves]"));
    assert.ok(saves.height < 30, `the saves take more than one line spanning: ${saves.height} px`);
    // At 100% the full layout's Apply shows wherever the bar hangs (barButtons.ts SPAN_SHORT_BAR_PX).
    await applyInView(goblin, "390 x 844, Goblin 4 mid-screen");
    // A token at the scene's foot gets the same layout: the field under the mode buttons, no More stats.
    for (const [t, name] of [
      [run.herald, run.herald.name],
      [run.thorn, "Thorn"],
    ] as const) {
      // A spanning bar covers the map under it: put it away before the next tap.
      await dm.keyboard.press("Escape");
      await tapToken(dm, t.at);
      const other = bar(dm, name);
      await other.waitFor();
      assert.equal(await other.getByRole("button", { name: "More stats", exact: true }).count(), 0, `${name}: the layout changed with the token's place`);
      await applyInView(other, `390 x 844, ${name}`);
      const modes = await rectOf(other.getByRole("radiogroup", { name: "What the number does" }));
      assert.ok(modes.bottom <= (await rectOf(other.getByRole("textbox", { name: "HP change" }))).top + 1, `${name}: the mode buttons moved under the field`);
    }
    await dm.keyboard.press("Escape");
    await tapToken(dm, run.goblin.at);
    await goblin.waitFor();
    await goblin.getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    const fold = panel.getByRole("button", { name: "Stat block", exact: true });
    await fold.waitFor();
    // 356 px inside: the preview and both first buttons on one line, and Max and Temp HP on one row.
    await openGroup(panel, "Image");
    const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
    const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
    assert.ok(Math.abs(change.top - another.top) <= 2 && change.left - (await rectOf(panel)).left >= 48, "the image row takes one line on a phone held upright");
    await hpPairSideBySide(panel, "356 px", "beside");
    await ringsCompact(panel, "356 px");
    await panel.getByRole("group", { name: "Range rings in feet", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(dm, "tokenpanel-390-range-rings");
    assert.equal(await fold.getAttribute("aria-expanded"), "false", "the block starts folded on a phone");
    await fold.click();
    await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
    await dm.getByRole("region", { name: "Token", exact: true }).getByRole("button", { name: "Close Token" }).click();
    await panel.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
    await tapToken(dm, run.dragon.at, 3);
    await bar(dm, "Adult White Dragon").getByRole("button", { name: "Details", exact: true }).click();
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "true", "the fold is remembered for the next monster");
    await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).click();
    await dm.getByRole("region", { name: "Token", exact: true }).getByRole("button", { name: "Close Token" }).click();
    await dm.keyboard.press("Escape");

    // From the bar, Stat block hides it, opens the Token sheet at the block and focuses its disclosure.
    await tapToken(dm, run.goblin.at);
    await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
    await goblin.waitFor({ state: "hidden" });
    await waitFor("focus on the stat block's disclosure", async () => {
      const f = await focused(dm);
      return f.name === "Stat block" && f.expanded === "true";
    });
    // The sheet scrolls the block to its top.
    await waitFor("the block at the sheet's top", async () => {
      const body = await rectOf(tokenPanel(dm));
      const block = await rectOf(tokenPanel(dm).locator("[data-stat-block]"));
      return block.top - body.top < 120;
    }, 3_000);
    await shots.take(dm, "tokenpanel-390x844-stat-block-sheet");
    await resize(dm, dmCdp, { width: 844, height: 390 });
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "true", "a rotation folded the block");

    // A fresh room with nothing stored: at 899 the block is folded, the request opens it, and 900 keeps it open.
    for (const [from, to, stored] of [
      [899, 900, null],
      [900, 899, JSON.stringify({ statBlock: false })],
    ] as const) {
      await setUp(dm, dmCdp, { width: from, height: 844, scale: 1 }, stored);
      if (from >= 900) await dm.getByRole("tab", { name: "Initiative" }).click();
      await tapToken(dm, run.goblin.at);
      await bar(dm, "Goblin 4").getByRole("button", { name: "Stat block", exact: true }).click();
      await tokenPanel(dm).getByRole("heading", { name: "Goblin Warrior" }).waitFor();
      await resize(dm, dmCdp, { width: to, height: 844 });
      const disclosure = tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true });
      await disclosure.waitFor();
      assert.equal(await disclosure.getAttribute("aria-expanded"), "true", `${from} then ${to}: the block folded`);
      await shots.take(dm, `tokenpanel-${from}-to-${to}-stat-block`);
      // Another monster's block shows folded, as the device keeps it.
      await tapToken(dm, run.dragon.at, 3);
      const dragonBar = bar(dm, "Adult White Dragon");
      if (await dragonBar.isVisible()) await dragonBar.getByRole("button", { name: "Details", exact: true }).click();
      await tokenPanel(dm).getByRole("heading", { name: "Adult White Dragon" }).first().waitFor();
      assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "false", `${from} then ${to}: another monster's block`);
      assert.equal(await storedFolds(dm), stored, "the request wrote the folds");
    }
  });

  test("7. a phone held sideways and a large one in the wide layout: a short bar with Apply in view, More stats, Stat block beside the sheet, and the image row wrapping with Max and Temp HP side by side", async () => {
    const sizes: (View & { label: string })[] = [
      { width: 844, height: 390, scale: 1, insets: { side: 47, bottom: 21 }, label: "844 x 390" },
      { width: 844, height: 390, scale: 1.3, insets: { side: 47, bottom: 21 }, label: "844 x 390 at 130%" },
      { width: 932, height: 430, scale: 1, insets: { side: 59, bottom: 21 }, label: "932 x 430" },
    ];
    for (const size of sizes) {
      await setUp(dm, dmCdp, size, null);
      // A short wide layout starts with its side panel hidden (docs/design-v1-layout-hierarchy.md 4.1), and Stat block shows it below.
      if (size.width >= 900) assert.equal(await dm.getByRole("tab", { name: "Token" }).count(), 0, `${size.label}: the side panel starts shown`);
      await tapToken(dm, run.goblin.at);
      const goblin = bar(dm, "Goblin 4");
      await goblin.waitFor();
      const frame = await rectOf(goblin);
      const apply = await rectOf(goblin.getByRole("button", { name: "Apply", exact: true }));
      assert.ok(apply.bottom <= frame.bottom + 1 && apply.top >= frame.top, `${size.label}: Apply is out of the bar's box`);
      assert.equal(await goblin.locator("[data-bar-scroll]").evaluate((el) => (el as unknown as El).scrollTop), 0);
      const more = goblin.getByRole("button", { name: "More stats", exact: true });
      assert.equal(await more.getAttribute("aria-expanded"), "false", `${size.label}: More stats starts open`);
      assert.ok((await rectOf(more)).top > apply.bottom, "More stats sits under the HP entry");
      assert.equal(await goblin.locator("[data-saves]").count(), 0);
      assert.equal(await fieldBeforeModes(goblin), true, `${size.label}: the short layout's field and Apply come after its modes in Tab order`);
      await steadyAboveSize(goblin, `${size.label}, short`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-short-bar`);
      await more.click();
      const opened = (await goblin.innerText()).replace(/\s+/g, " ");
      for (const words of ["Speed 30 ft", "Passive Perception 9", "Saves STR −1"]) assert.ok(opened.includes(words), `${size.label}: More stats lacks ${words}`);
      await noSideScroll(goblin, `${size.label}, the short bar`);

      // Stat block keeps the bar open beside the sheet or side panel, which opens at the block.
      await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
      const panel = tokenPanel(dm);
      await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
      assert.ok(await goblin.isVisible(), `${size.label}: Stat block hid the bar`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-stat-block-beside`);

      // The image row under the preview, the pair sharing a line exactly where the column holds both.
      await openGroup(panel, "Image");
      await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
      await settle(panel);
      const pair = panel.locator("[data-image-pair]");
      const column = await pair.evaluate((el) => (el.parentElement as unknown as El).getBoundingClientRect().width);
      const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
      const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
      const preview = await pair.evaluate((el) => ((el.parentElement!.parentElement!.firstElementChild as unknown as El).getBoundingClientRect()));
      assert.ok(change.top >= preview.bottom - 1, `${size.label}: the buttons sit beside the preview`);
      const holds = column >= change.width + another.width + 4 - 0.5;
      assert.equal(Math.abs(change.top - another.top) <= 2, holds, `${size.label}: the pair's lines with a ${column} px column`);
      // Each of these panels is under 320 px wide: 259, 259 and 268 (docs/design-v1-token-panel.md, the size table).
      await hpPairSideBySide(panel, size.label, "above");
      await noSideScroll(panel, `${size.label}, the panel`);
      const pageWide = await dm.evaluate(() => (globalThis as unknown as { document: { documentElement: El } }).document.documentElement.scrollWidth > (globalThis as unknown as { innerWidth: number }).innerWidth);
      assert.equal(pageWide, false, `${size.label}: the page scrolls sideways`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-panel-rows`);
    }
  });

  test("7b. a phone upright at 130%, short with Apply in view wherever its token stands, and an upright tablet, full: Stat block hiding the bar for the sheet at the block, and the image and HP rows", async () => {
    const sizes: (View & { label: string; hpLabels: "beside" | "above" })[] = [
      { width: 390, height: 844, scale: 1.3, label: "390 x 844 at 130%", hpLabels: "above" },
      { width: 820, height: 1180, scale: 1, label: "820 x 1180", hpLabels: "beside" },
    ];
    for (const size of sizes) {
      await setUp(dm, dmCdp, size, null);
      await tapToken(dm, run.goblin.at);
      const goblin = bar(dm, "Goblin 4");
      await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor();
      /*
       * A spanning bar's layout is the screen's, wherever the token stands,
       * from the least room any token leaves it (barButtons.ts barCapacity).
       * An upright phone at 130% leaves its full layout's Apply out of view
       * there, so its bar is short for every token, with Apply in view. The
       * tablet docks, full.
       */
      const short = size.width < 600;
      assert.equal(await goblin.getByRole("button", { name: "More stats", exact: true }).count(), short ? 1 : 0, `${size.label}: the bar is ${short ? "full" : "short"}`);
      if (short) {
        await applyInView(goblin, `${size.label}, Goblin 4 mid-screen`);
        for (const [t, name] of [
          [run.thorn, "Thorn"],
          [run.herald, run.herald.name],
        ] as const) {
          await dm.keyboard.press("Escape");
          await tapToken(dm, t.at);
          const other = bar(dm, name);
          await other.waitFor();
          assert.equal(await other.getByRole("button", { name: "More stats", exact: true }).count(), 1, `${size.label}, ${name}: the layout changed with the token's place`);
          await applyInView(other, `${size.label}, ${name}`);
        }
        await dm.keyboard.press("Escape");
        await tapToken(dm, run.goblin.at);
        await goblin.getByRole("button", { name: "More stats", exact: true }).click();
      }
      await goblin.locator("[data-saves]").waitFor();
      await noSideScroll(goblin, `${size.label}, the bar`);
      await steadyAboveSize(goblin, size.label);
      await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
      const panel = tokenPanel(dm);
      await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
      await goblin.waitFor({ state: "hidden" });
      await openGroup(panel, "Image");
      await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
      await settle(panel);
      const pair = panel.locator("[data-image-pair]");
      const column = await pair.evaluate((el) => (el.parentElement as unknown as El).getBoundingClientRect().width);
      const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
      const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
      const gap = await pair.evaluate((el) => Number.parseFloat((el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { columnGap: string } } } }).ownerDocument.defaultView.getComputedStyle(el).columnGap));
      const zoom = size.scale;
      assert.equal(Math.abs(change.top - another.top) <= 2, column >= change.width + another.width + gap * zoom - 0.5, `${size.label}: the pair's lines with a ${column} px column for ${change.width} + ${another.width} + ${gap * zoom}`);
      await hpPairSideBySide(panel, size.label, size.hpLabels);
      await noSideScroll(panel, `${size.label}, the panel`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-stat-block-sheet`);
    }
  });

  test("7c. the very short mode at 480 x 320 at 130%: Stat block opens the whole-screen sheet at the block with focus on its disclosure, the bar put away, and the image row wrapping at 243 px with Max and Temp HP side by side", async () => {
    await setUp(dm, dmCdp, { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 } }, null);
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    await steadyAboveSize(goblin, "480 x 320 at 130%, very short");
    await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
    const sheet = dm.locator('dialog[data-rvtt-sheet][aria-modal="true"]');
    await sheet.waitFor();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
    await waitFor("focus on the stat block's disclosure", async () => {
      const f = await focused(dm);
      return f.name === "Stat block" && f.expanded === "true";
    });
    // The bar cannot stand beside a panel that covers the screen, so Stat block puts it away (docs/design-v1-token-panel.md 3.4).
    assert.equal(await goblin.isVisible(), false, "the bar still shows");
    await shots.take(dm, "tokenpanel-480x320at130-very-short-stat-block");
    await openGroup(panel, "Image");
    await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await settle(panel);
    const pair = panel.locator("[data-image-pair]");
    const column = await pair.evaluate((el) => (el.parentElement as unknown as El).getBoundingClientRect().width);
    const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
    const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
    const gap = await pair.evaluate((el) => Number.parseFloat((el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { columnGap: string } } } }).ownerDocument.defaultView.getComputedStyle(el).columnGap));
    assert.equal(Math.abs(change.top - another.top) <= 2, column >= change.width + another.width + gap * 1.3 - 0.5, `the pair's lines with a ${column} px column`);
    await hpPairSideBySide(panel, "243 px", "above");
    await panel.getByRole("group", { name: "Maximum and Temporary HP", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(dm, "tokenpanel-480x320at130-hp-pair");
    await noSideScroll(panel, "480 x 320 at 130%, the very short panel");
    // Escape is the modal's own: it closes the sheet.
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
  });

  test("8. Pat on a phone: their character's summary and sheet link, Bree's HP alone, the goblin's label, the HP entry when the room allows it, and the Wild Shape's saves after loading", async () => {
    // At a desk first, where tokens are big enough for shields: Thorn's shows, Bree's and the goblin's never do.
    await setUp(player, playerCdp, DESK, null);
    await waitFor("Pat's snapshot", () => playerSocket.state?.tokens[run.goblin.id]);
    const shields = await mapBadges(player);
    const thornBox = await footprintRect(player, run.thorn.at);
    assert.ok(shields.some((b) => inside(b.rect, thornBox) && b.text === "16"), `no shield on Thorn: ${JSON.stringify(shields)}`);
    const bearBox = await footprintRect(player, run.bear.at);
    assert.ok(shields.some((b) => inside(b.rect, bearBox) && b.text === "11"), "no shield on Pat's Wild Shape");
    for (const t of [run.bree, run.goblin, run.dragon]) {
      const box = await footprintRect(player, t.at, t === run.dragon ? 3 : 1);
      assert.equal(shields.filter((b) => inside(b.rect, box)).length, 0, "a shield Pat may not see");
    }
    const goblinState = playerSocket.state!.tokens[run.goblin.id]!;
    assert.equal("ac" in ((goblinState.actor as { inline: Record<string, unknown> }).inline ?? {}), false, "the goblin's AC reached Pat");

    // A failed load says so and offers the reload, the one try that can work: Chrome keeps a failed module for the life of the page.
    await player.route(/\/assets\/monsters-[^/]*\.js$/, failSrdData);
    await setUp(player, playerCdp, DESK, null);
    await tapToken(player, run.bear.at);
    await bar(player, "Brown Bear").getByText("Saves did not load. Reload to try again.").waitFor();
    assert.equal(await bar(player, "Brown Bear").getByRole("button", { name: "Try again" }).count(), 0, "a retry that cannot work");
    await shots.take(player, "tokenpanel-pat-bear-saves-failed");
    await player.unroute(/\/assets\/monsters-[^/]*\.js$/);
    const reloaded = player.waitForEvent("load");
    await bar(player, "Brown Bear").getByRole("button", { name: "Reload", exact: true }).click();
    await reloaded;
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await player.locator(".konvajs-content").first().waitFor();
    await tapToken(player, run.bear.at);
    await bar(player, "Brown Bear").locator("[data-saves]").waitFor();

    // The SRD chunk waits 600 ms, so Loading saves shows.
    await player.route(/\/assets\/monsters-[^/]*\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await setUp(player, playerCdp, { width: 390, height: 844, scale: 1 }, null);
    await tapToken(player, run.thorn.at);
    const thorn = bar(player, "Thorn");
    await thorn.getByRole("img", { name: "Armor Class 16" }).waitFor();
    const text = (await thorn.innerText()).replace(/\s+/g, " ");
    for (const words of ["HP 31/38", "+5", "Speed 30 ft", "Passive Perception 14"]) assert.ok(text.includes(words), `Thorn's bar lacks ${words}`);
    assert.equal(await thorn.getByRole("link", { name: "Open the sheet" }).getAttribute("href"), SHEET);
    await thorn.getByRole("button", { name: "Details", exact: true }).waitFor();
    assert.equal(await thorn.locator("[data-saves]").count(), 0);
    // Conditions and Multi-select in view as the bar opens, with Size under them (the project owner's answer to W5B-P-2).
    const spanning = await rectOf(thorn.locator("[data-bar-scroll]"));
    for (const name of ["Conditions", "Multi-select"]) {
      const button = await rectOf(thorn.getByRole("button", { name, exact: true }));
      assert.ok(button.top >= spanning.top && button.bottom <= spanning.bottom + 1, `an upright phone: Pat's ${name} needs a scroll: ${JSON.stringify({ spanning, button })}`);
      assert.equal(await labelUnderFade(thorn, name), null, `an upright phone: Pat's ${name} runs under "Scroll for more"`);
    }
    await steadyAboveSize(thorn, "390 x 844, spanning");
    await shots.take(player, "tokenpanel-pat-thorn-bar");
    await player.keyboard.press("Escape");

    await tapToken(player, run.bree.at);
    const bree = bar(player, "Bree");
    await bree.waitFor();
    assert.equal(await bree.getByRole("img").count(), 0, "Bree's AC shows to Pat");
    assert.ok((await bree.locator("[data-vitals]").innerText()).includes("HP 12/24"), "Bree's HP as the party's rule sends it");
    assert.equal((await bree.innerText()).includes("Passive Perception"), false);
    await player.keyboard.press("Escape");

    await tapToken(player, run.goblin.at);
    const goblin = bar(player, "Goblin 4");
    await goblin.waitFor();
    assert.equal((await goblin.locator("[data-vitals]").innerText()).trim(), "Healthy");
    assert.equal(await goblin.getByRole("textbox", { name: "HP change" }).count(), 0);
    await goblin.getByRole("button", { name: "Details", exact: true }).waitFor();
    assert.equal(await goblin.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
    await goblin.getByRole("textbox", { name: "HP change" }).waitFor();
    const modes = goblin.getByRole("radiogroup", { name: "What the number does" });
    assert.equal(await modes.getByRole("radio").count(), 2);
    await modes.getByRole("radio", { name: "Damage" }).waitFor({ state: "attached" });
    await modes.getByRole("radio", { name: "Heal" }).waitFor({ state: "attached" });
    await shots.take(player, "tokenpanel-pat-goblin-bar");
    await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
    await player.keyboard.press("Escape");

    await tapToken(player, run.bear.at);
    const bear = bar(player, "Brown Bear");
    await bear.getByText("Loading saves…").waitFor();
    await shots.take(player, "tokenpanel-pat-bear-loading-saves");
    await bear.locator("[data-saves]").waitFor();
    await bear.getByRole("button", { name: "Stat block", exact: true }).click();
    await tokenPanel(player).getByRole("heading", { name: "Brown Bear" }).last().waitFor();
    await tokenPanel(player).getByText("Stat blocks from the System Reference Document 5.2.1").waitFor();
    await shots.take(player, "tokenpanel-pat-bear-stat-block");
    await player.unroute(/\/assets\/monsters-[^/]*\.js$/);
  });

  test("8c. the DM's SRD lists and blocks that did not load offer the reload, which brings them", async () => {
    await dm.route(/\/assets\/monsters-[^/]*\.js$/, failSrdData);
    dmConsole.allow = [/monsters-/, /dynamically imported module/, /ERR_FAILED|net::/];
    await setUp(dm, dmCdp, DESK, null);
    await openSideTab(dm, "Monsters");
    const monsters = dm.getByRole("tabpanel", { name: "Monsters" });
    await monsters.getByText("The monster list did not load. Reload to try again.").waitFor();
    assert.equal(await monsters.getByRole("button", { name: "Try again" }).count(), 0);
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").getByRole("button", { name: "Stat block", exact: true }).click();
    const block = tokenPanel(dm).locator("[data-stat-block]");
    await block.getByText("The stat block did not load. Reload to try again.").waitFor();
    await shots.take(dm, "tokenpanel-dm-srd-failed");
    await dm.unroute(/\/assets\/monsters-[^/]*\.js$/);
    const reloaded = dm.waitForEvent("load");
    await block.getByRole("button", { name: "Reload", exact: true }).click();
    await reloaded;
    dmConsole.allow = [];
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await openSideTab(dm, "Monsters");
    await dm.getByRole("tabpanel", { name: "Monsters" }).getByText("SRD 5.2.1 (330)", { exact: true }).waitFor();
  });

  test("8b. viewing as Pat: Stat block opens the preview's own panel at the SRD block, and nothing there writes the folds", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    await preview.locator(".konvajs-content").first().waitFor();
    await dm.waitForTimeout(600);
    // The preview draws a stage of its own, the page's second: tap the bear on it.
    const p = await dm.evaluate((id) => {
      type Node = { getClientRect(): { x: number; y: number; width: number; height: number } };
      const g = globalThis as unknown as { Konva: { stages: { findOne(s: string): Node | undefined; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } };
      const stage = g.Konva.stages[g.Konva.stages.length - 1]!;
      const node = stage.findOne(`#${id}`);
      if (!node) return null;
      const r = node.getClientRect();
      const box = stage.container().getBoundingClientRect();
      return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2 };
    }, run.bear.id);
    assert.ok(p, "the bear is not on the preview's map");
    await dm.mouse.click(p.x, p.y);
    const bear = preview.getByRole("dialog", { name: "Brown Bear actions" });
    await bear.locator("[data-saves]").waitFor();
    await bear.getByRole("button", { name: "Stat block", exact: true }).click();
    const panel = preview.getByRole("tabpanel", { name: "Token" });
    await panel.getByRole("button", { name: "Stat block", exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "true");
    await panel.getByText("Stat blocks from the System Reference Document 5.2.1").waitFor();
    // The DM's own panel, under the preview, did not move.
    assert.equal(await dm.getByRole("tab", { name: "DM", selected: true }).count(), 1);
    await shots.take(dm, "tokenpanel-viewing-as-pat-stat-block");
    await panel.getByRole("button", { name: "Stats", exact: true }).click();
    assert.equal(await storedFolds(dm), null, "the preview wrote the folds");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
  });

  test("9. several selected: the group bar has no Stat block and no saves", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").waitFor();
    await dm.keyboard.down("Shift");
    await tapToken(dm, run.dragon.at, 3);
    await dm.keyboard.up("Shift");
    const group = dm.getByRole("dialog", { name: "2 selected tokens" });
    await group.waitFor();
    assert.equal(await group.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    assert.equal(await group.locator("[data-saves]").count(), 0);
    assert.equal((await group.innerText()).includes("Saves"), false);
    await shots.take(dm, "tokenpanel-dm-group-bar");
  });

  test("9c. sizes on the fly (docs/design-v1-token-window.md 8): the DM's steps and Stats, Pat's growth away from walls and back, no room in a corridor, undo keeping damage, an unchecked scene, a locked and a Custom token, a turn's trail kept through a resize, and the row on phones", async () => {
    const SIZES = { w: 20, h: 14 };
    const sizes = { sceneId: randomUUID(), thorn: randomUUID(), goblin: randomUUID(), owl: randomUUID() };
    const wall = { kind: "wall" } as const;
    const edges: { key: string; feature: typeof wall }[] = [];
    // A corner at (4, 4): walls down the west side of column 4 and along the north side of row 4.
    for (let i = 4; i <= 9; i++) edges.push({ key: `4,${i},w`, feature: wall }, { key: `${i},4,n`, feature: wall });
    // A 5 ft corridor along row 11.
    for (let x = 10; x <= 17; x++) edges.push({ key: `${x},11,n`, feature: wall }, { key: `${x},12,n`, feature: wall });
    await ops.send({ t: "scene.create", scene: { id: sizes.sceneId, name: "Sizes", bounds: SIZES, background: "#2b2b31", fogEnabled: false, autoWalls: "off", blockMovement: true } });
    await ops.send({ t: "build.edge", sceneId: sizes.sceneId, edges });
    const token = (id: string, at: { x: number; y: number }, extra: Record<string, unknown>) => ({
      t: "token.create",
      token: { id, sceneId: sizes.sceneId, size: "medium", visibility: "all", x: at.x, y: at.y, disposition: "ally", kind: "monster", ...extra },
    });
    await ops.send(token(sizes.thorn, { x: 4, y: 4 }, { kind: "pc", name: "Thorn", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(sizes.goblin, { x: 12, y: 4 }, { name: "Sizes goblin", disposition: "hostile", actor: { inline: actor({ ac: 15, srdId: "goblin-warrior" }) } }));
    await ops.send(token(sizes.owl, { x: 15, y: 7 }, { kind: "npc", name: "Owl", size: "tiny", ownerIds: [run.patId], actor: { inline: actor({ ac: 11, speeds: { walk: 5, fly: 60 } }) } }));
    const dmToken = (id: string) => dmSocket.state?.tokens[id];
    const pose = (id: string) => {
      const t = dmToken(id);
      return t ? { x: t.x, y: t.y, size: t.size } : null;
    };
    const until = (what: string, id: string, want: { x: number; y: number; size: string }) =>
      waitFor(what, () => {
        const p = pose(id);
        return p && p.x === want.x && p.y === want.y && p.size === want.size ? true : null;
      });
    const tapAt = async (page: Page, at: { x: number; y: number }, size = 1) => {
      const p = await pagePoint(page, SIZES, { x: at.x + size / 2, y: at.y + size / 2 });
      await page.mouse.click(p.x, p.y);
    };
    const boardTexts = (page: Page) =>
      page.evaluate(() => {
        const k = (globalThis as unknown as { Konva?: { stages: { find(s: string): { text(): string }[] }[] } }).Konva;
        return (k?.stages ?? []).flatMap((st) => st.find("Text").map((t) => t.text())).join("\n");
      });
    const sizeRow = (b: Locator) => b.getByRole("group", { name: "Size", exact: true });
    const openStats = async (page: Page) => {
      if ((await page.getByRole("tab", { name: "Token" }).count()) > 0) await page.getByRole("tab", { name: "Token" }).click();
      const stats = tokenPanel(page).getByRole("button", { name: "Stats", exact: true });
      await stats.waitFor();
      if ((await stats.getAttribute("aria-expanded")) === "false") await stats.click();
    };

    // The DM on the new scene, and the players with them.
    await setUp(dm, dmCdp, DESK, null);
    await openSideTab(dm, "Scenes");
    await dm.getByRole("button", { name: /^Sizes/ }).first().click();
    await waitFor("the DM on the sizes scene", () => dmSocket.you?.sceneId === sizes.sceneId || null, 30_000);
    await ops.send({ t: "room.setPlayerScene", sceneId: sizes.sceneId });
    await waitFor("the players on the sizes scene", () => (dmSocket.state?.meta.playerSceneId === sizes.sceneId ? true : null));

    // The DM steps the goblin up twice from its window, keeping its middle, and back down to its own square.
    await tapAt(dm, { x: 12, y: 4 });
    const goblin = bar(dm, "Sizes goblin");
    await goblin.waitFor();
    await sizeRow(goblin).getByRole("button", { name: "One size larger" }).click();
    await until("a Large goblin", sizes.goblin, { x: 12, y: 4, size: "large" });
    await sizeRow(goblin).getByRole("button", { name: "One size larger" }).click();
    // The Large's middle (13, 5) sits on a grid line for a Huge, so the tie keeps its top-left corner, over the Large's squares.
    await until("a Huge goblin, its middle kept", sizes.goblin, { x: 12, y: 4, size: "huge" });
    await shots.take(dm, "token-window-size-huge-goblin");
    await sizeRow(goblin).getByRole("button", { name: "One size smaller" }).click();
    await sizeRow(goblin).getByRole("button", { name: "One size smaller" }).click();
    await until("the goblin back on its own square", sizes.goblin, { x: 12, y: 4, size: "medium" });
    // Stats holds Size with Custom, and Back to its block's size, Small, for a Large goblin. Token settings has none.
    await sizeRow(goblin).getByRole("button", { name: "One size larger" }).click();
    await until("a Large goblin again", sizes.goblin, { x: 12, y: 4, size: "large" });
    await openStats(dm);
    const sizeSelect = tokenPanel(dm).getByRole("combobox", { name: "Size", exact: true });
    await sizeSelect.waitFor();
    assert.ok((await sizeSelect.locator("option").allInnerTexts()).includes("Custom"), "the DM's Size has no Custom");
    await tokenPanel(dm).getByRole("button", { name: "Back to Small", exact: true }).click();
    await until("the goblin back to Small", sizes.goblin, { x: 12, y: 4, size: "small" });
    const settings = tokenPanel(dm).getByRole("button", { name: "Token settings", exact: true });
    if ((await settings.getAttribute("aria-expanded")) === "false") await settings.click();
    assert.equal(await tokenPanel(dm).getByRole("combobox", { name: "Size", exact: true }).count(), 1, "Size is in Token settings as well as Stats");
    await ops.send({ t: "token.update", tokenId: sizes.goblin, patch: { size: "custom", w: 2, h: 3 } });
    await goblin.getByText("Custom, 2 by 3 squares", { exact: true }).waitFor();
    await ops.send({ t: "token.update", tokenId: sizes.goblin, patch: { size: "medium", w: null, h: null } });
    await goblin.getByRole("button", { name: "Close", exact: true }).click();

    // Pat grows Thorn in the walled corner: right and down, away from both walls, and shrunk back to his own square.
    await setUp(player, playerCdp, DESK, null);
    await waitFor("Thorn in Pat's view", () => playerSocket.state?.tokens[sizes.thorn]);
    await tapAt(player, { x: 4, y: 4 });
    const thorn = bar(player, "Thorn");
    await thorn.waitFor();
    const larger = sizeRow(thorn).getByRole("button", { name: "One size larger" });
    const smaller = sizeRow(thorn).getByRole("button", { name: "One size smaller" });
    await larger.click();
    await until("Thorn Large", sizes.thorn, { x: 4, y: 4, size: "large" });
    await larger.click();
    await until("Thorn Huge, grown right and down", sizes.thorn, { x: 4, y: 4, size: "huge" });
    await shots.take(player, "token-window-size-huge-in-a-corner");
    await smaller.click();
    await smaller.click();
    await until("Thorn back to Medium on his square", sizes.thorn, { x: 4, y: 4, size: "medium" });

    // In a 5 ft corridor a Large has no room: the words, and nothing changes.
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { x: 12, y: 11 } });
    await waitFor("Thorn in the corridor for Pat", () => (playerSocket.state?.tokens[sizes.thorn]?.y === 11 ? true : null));
    await larger.click();
    await player.getByText("No room to grow here.").first().waitFor();
    await player.waitForTimeout(300);
    assert.deepEqual(pose(sizes.thorn), { x: 12, y: 11, size: "medium" }, "a refused growth changed Thorn");
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { x: 4, y: 4 } });
    await waitFor("Thorn back in the corner for Pat", () => (playerSocket.state?.tokens[sizes.thorn]?.y === 4 ? true : null));

    // Ctrl+Z after a growth and a hit from the DM: back to Medium where he stood, the damage kept.
    // Temporary HP goes first, so the hit counts on both.
    const hpNow = () => {
      const hp = dmSocket.state?.characters[run.thorn.characterId]?.actor.hp;
      return (hp?.cur ?? 0) + (hp?.temp ?? 0);
    };
    const hpBefore = hpNow();
    await larger.click();
    await until("Thorn Large to undo", sizes.thorn, { x: 4, y: 4, size: "large" });
    await ops.send({ t: "actor.hp", target: { tokenId: sizes.thorn }, change: { kind: "damage", amount: 3 } });
    await waitFor("the hit", () => (hpNow() < hpBefore ? true : null));
    await player.keyboard.press("Control+z");
    await until("Thorn's growth undone", sizes.thorn, { x: 4, y: 4, size: "medium" });
    assert.equal(hpNow(), hpBefore - 3, "the undo took the damage back");

    // On a scene that does not block moves, Huge takes the base spot, centered on his square.
    await ops.send({ t: "scene.update", sceneId: sizes.sceneId, patch: { blockMovement: false } });
    await tapAt(player, { x: 4, y: 4 });
    await thorn.waitFor();
    await larger.click();
    await until("Thorn Large, unchecked", sizes.thorn, { x: 4, y: 4, size: "large" });
    await larger.click();
    await until("Thorn Huge at the base spot", sizes.thorn, { x: 4, y: 4, size: "huge" });
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { size: "medium", x: 4, y: 4 } });
    await until("Thorn Medium", sizes.thorn, { x: 4, y: 4, size: "medium" });
    // Straight from Medium in Stats: the base spot is centered on his square, over both walls.
    await openStats(player);
    await tokenPanel(player).getByRole("combobox", { name: "Size", exact: true }).selectOption("huge");
    await until("Thorn Huge from Medium at the base spot", sizes.thorn, { x: 3, y: 3, size: "huge" });
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { size: "medium", x: 4, y: 4 } });
    await ops.send({ t: "scene.update", sceneId: sizes.sceneId, patch: { blockMovement: true } });
    await until("Thorn Medium again", sizes.thorn, { x: 4, y: 4, size: "medium" });

    // Locked: no Size row for Pat, and Stats reads it. Custom: read-only in both, set by the DM.
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { locked: true } });
    await waitFor("Thorn locked for Pat", () => (playerSocket.state?.tokens[sizes.thorn]?.locked ? true : null));
    await thorn.waitFor();
    assert.equal(await sizeRow(thorn).count(), 0, "a locked token shows its players a Size row");
    await openStats(player);
    await tokenPanel(player).getByText("Medium (5 ft), locked by the DM", { exact: true }).waitFor();
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { locked: false, size: "custom", w: 2, h: 3 } });
    await thorn.getByText("Custom, 2 by 3 squares, set by the DM", { exact: true }).waitFor();
    await tokenPanel(player).getByText("Custom, 2 by 3 squares, set by the DM", { exact: true }).waitFor();
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { size: "medium", w: null, h: null } });
    await until("Thorn Medium after Custom", sizes.thorn, { x: 4, y: 4, size: "medium" });

    // In a fight on his turn: 15 ft moved, then Huge, and the trail still reads 15 ft for Pat, the DM, and Pat again after a reload.
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: sizes.thorn, value: 20 }, { id: randomUUID(), tokenId: sizes.owl, value: 10 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("Thorn's turn for Pat", () => (playerSocket.state?.encounter?.activeEntryId ? true : null));
    const from = await pagePoint(player, SIZES, { x: 4.5, y: 4.5 });
    const to = await pagePoint(player, SIZES, { x: 7.5, y: 4.5 });
    await player.mouse.move(from.x, from.y);
    await player.mouse.down();
    await player.mouse.move(to.x, to.y, { steps: 12 });
    await player.mouse.up();
    await until("Thorn moved 15 ft", sizes.thorn, { x: 7, y: 4, size: "medium" });
    await waitFor("Moved 15 ft for Pat", async () => ((await boardTexts(player)).includes("Moved 15 ft") ? true : null));
    await tapAt(player, { x: 7, y: 4 });
    await thorn.waitFor();
    await larger.click();
    await waitFor("Thorn Large on his turn", () => (pose(sizes.thorn)?.size === "large" ? true : null));
    await larger.click();
    await waitFor("Thorn Huge on his turn", () => (pose(sizes.thorn)?.size === "huge" ? true : null));
    await player.waitForTimeout(500);
    assert.ok((await boardTexts(player)).includes("Moved 15 ft"), `after the resize Pat reads: ${await boardTexts(player)}`);
    assert.ok((await boardTexts(dm)).includes("Moved 15 ft"), `after the resize the DM reads: ${await boardTexts(dm)}`);
    await shots.take(player, "token-window-size-trail-kept");
    await setUp(player, playerCdp, DESK, null);
    await waitFor("Moved 15 ft after a reload", async () => ((await boardTexts(player)).includes("Moved 15 ft") ? true : null));

    // The owl's turn: a half-square move, then a growth to Small, still 2.5 ft.
    await ops.send({ t: "encounter.next" });
    await waitFor("the owl's turn", () => {
      const e = playerSocket.state?.encounter;
      return e && e.entries.find((x) => x.id === e.activeEntryId)?.tokenId === sizes.owl ? true : null;
    });
    const owlFrom = await pagePoint(player, SIZES, { x: 15.25, y: 7.25 });
    const owlTo = await pagePoint(player, SIZES, { x: 15.75, y: 7.25 });
    await player.mouse.move(owlFrom.x, owlFrom.y);
    await player.mouse.down();
    await player.mouse.move(owlFrom.x + 12, owlFrom.y, { steps: 3 });
    await player.mouse.move(owlTo.x, owlTo.y, { steps: 8 });
    await player.mouse.up();
    await until("the owl moved half a square", sizes.owl, { x: 15.5, y: 7, size: "tiny" });
    await waitFor("Moved 2.5 ft for Pat", async () => ((await boardTexts(player)).includes("Moved 2.5 ft") ? true : null));
    await tapAt(player, { x: 15.5, y: 7 }, 0.5);
    const owl = bar(player, "Owl");
    await owl.waitFor();
    await sizeRow(owl).getByRole("button", { name: "One size larger" }).click();
    await waitFor("the owl Small", () => (pose(sizes.owl)?.size === "small" ? true : null));
    await player.waitForTimeout(500);
    assert.ok((await boardTexts(player)).includes("Moved 2.5 ft"), `after the owl grew Pat reads: ${await boardTexts(player)}`);
    assert.ok((await boardTexts(dm)).includes("Moved 2.5 ft"), `after the owl grew the DM reads: ${await boardTexts(dm)}`);
    await ops.send({ t: "encounter.end" });
    await ops.send({ t: "token.update", tokenId: sizes.thorn, patch: { size: "medium", x: 4, y: 4 } });

    // On phones: the row's buttons take a tap with no sideways scroll, and the stepper stays on its label's line or wraps under it, right-aligned (docs/design-v1-token-window.md 8, the stepper row). Whether it wraps at 320 px and 130% depends on the font's widths, so either holds there.
    for (const view of [
      { width: 844, height: 390, scale: 1, insets: { side: 47, bottom: 21 } },
      { width: 320, height: 480, scale: 1.3 },
    ] as View[]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(player, playerCdp, view, null);
      await tapAt(player, { x: 4, y: 4 });
      await thorn.waitFor();
      const row = sizeRow(thorn);
      await steadyAboveSize(thorn, label);
      await row.scrollIntoViewIfNeeded();
      for (const name of ["One size smaller", "One size larger"]) {
        const button = row.getByRole("button", { name });
        await button.scrollIntoViewIfNeeded();
        assert.ok(await wholeInReach(button), `${label}: ${name} is cut off or takes no tap`);
      }
      const wide = await thorn.locator("[data-bar-scroll]").evaluate((el) => (el as unknown as El).scrollWidth > (el as unknown as El).clientWidth + 1);
      assert.equal(wide, false, `${label}: the window scrolls sideways`);
      const words = await rectOf(row.getByText("Size", { exact: true }));
      const stepper = await rectOf(row.getByRole("button", { name: "One size larger" }));
      const onLine = Math.abs(stepper.top + (stepper.bottom - stepper.top) / 2 - (words.top + (words.bottom - words.top) / 2)) < 12;
      const under = stepper.top >= words.bottom - 1;
      if (view.width === 320) {
        assert.ok(onLine || under, `${label}: the stepper is neither on its label's line nor under it`);
        if (under) {
          const end = await rectOf(row);
          assert.ok(Math.abs(stepper.right - end.right) <= 1, `${label}: the wrapped stepper is not right-aligned`);
        }
      } else assert.ok(onLine, `${label}: the stepper left its label's line`);
      await shots.take(player, `token-window-size-row-${view.width}x${view.height}-${Math.round(view.scale * 100)}`);
      await thorn.getByRole("button", { name: "Close", exact: true }).first().click();
    }
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  test("sa-a-1. token image from a starter pack: the Starter tab copies a work in, the crop editor opens on it, and the token wears it with the catalog's credit", async () => {
    const found = starterWork("token");
    await setUp(dm, dmCdp, DESK, null);
    const sceneId = dmSocket.you?.sceneId ?? run.sceneId;
    const bounds = dmSocket.state!.scenes[sceneId]!.bounds;
    const id = randomUUID();
    await ops.send({ t: "token.create", token: { id, sceneId, size: "medium", visibility: "all", x: 1, y: 1, disposition: "hostile", kind: "monster", name: "Starter wolf", actor: { inline: actor() } } });
    await waitFor("the token in the DM's view", () => dmSocket.state?.tokens[id]);
    const at = await pagePoint(dm, bounds, { x: 1.5, y: 1.5 });
    await dm.mouse.click(at.x, at.y);
    await bar(dm, "Starter wolf").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Starter wolf" }).waitFor();
    await openGroup(panel, "Image");
    await panel.getByRole("button", { name: "Add image", exact: true }).click();
    const picker = dm.getByRole("dialog", { name: "Choose an image" });
    await picker.getByRole("tab", { name: "Starter", exact: true }).click();
    const { packs, works } = starterCounts("token");
    await picker.getByText(`${packs} ${packs === 1 ? "pack" : "packs"}, ${works} works.`).waitFor();
    await chooseStarterWork(picker, found, "search", false);
    await shots.take(dm, "sa-a-1-token-starter-tab");
    await picker.getByRole("button", { name: "Use", exact: true }).click();
    // Use goes on as a library pick does: the crop editor, then the token wears the image.
    const crop = dm.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor();
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    const image = await waitFor("the token's starter image", () => {
      const img = dmSocket.state?.tokens[id]?.image;
      return img && "assetId" in img ? img : null;
    });
    const row = await assetRow(dmContext.request, server.origin, run.roomId, image.assetId);
    assert.equal(row?.kind, "token");
    assert.equal(row?.starter, found.work.key, "the row names the work it was copied from");
    assert.equal(row?.credit?.creator, found.work.credit.author, "the credit is the catalog's");
    await shots.take(dm, "sa-a-1-token-wears-starter-image");
    // The library lists the pick apart from the room's own images, in the starter packs' fold.
    await openSideTab(dm, "Library");
    const library = dm.getByRole("tabpanel", { name: "Library" });
    await library.getByRole("button", { name: /^From starter packs \(\d+\)$/ }).click();
    await library.getByRole("list", { name: "Token images from starter packs" }).locator(`img[src*="${image.assetId}"]`).first().waitFor();
    assert.equal(await library.getByRole("list", { name: "Token images in this room" }).locator(`img[src*="${image.assetId}"]`).count(), 0, "the pick is listed with the room's own images");
    await shots.take(dm, "sa-a-1-library-starter-fold");
    await ops.send({ t: "token.delete", tokenId: id });
  });

  test("sa-a-5. a player sees the Starter tab in their own character's image picker, with the token art alone, and picks a portrait from it", async () => {
    const found = starterWork("token");
    await setUp(player, playerCdp, { width: 390, height: 844, scale: 1 }, null);
    // On a phone the Characters panel is a sheet from the tool bar's Panels list.
    await player.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
    const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
    const opener = sheet.locator(`[data-opener="character:${run.thorn.characterId}"]`);
    if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
    await sheet.getByRole("button", { name: /^(Add|Change) image$/ }).first().click();
    const picker = player.getByRole("dialog", { name: "Choose an image" });
    await picker.getByRole("tab", { name: "Starter", exact: true }).click();
    const { packs, works } = starterCounts("token");
    await picker.getByText(`${packs} ${packs === 1 ? "pack" : "packs"}, ${works} works.`).waitFor();
    // No map, handout or stamp of the catalog's shows here.
    const map = starterWork("map");
    await picker.getByRole("searchbox", { name: "Search the starter packs" }).fill(map.work.name);
    assert.equal(await picker.getByRole("list", { name: map.pack.title, exact: true }).count(), 0, "a starter map shows in a player's picker");
    await chooseStarterWork(picker, found, "search", false);
    await shots.take(player, "sa-a-5-player-starter-tab");
    await picker.getByRole("button", { name: "Use", exact: true }).click();
    // A player's pick answers no sooner than 400 ms (server/assets/starter.ts PLAYER_PICK_FLOOR_MS), which the picker shows as under way, never hung.
    const adding = picker.getByRole("button", { name: "Adding…", exact: true });
    await adding.waitFor();
    assert.equal(await adding.getAttribute("aria-busy"), "true", "Use is not busy while the pick waits");
    await picker.getByRole("status").filter({ hasText: "Adding to the room…" }).waitFor();
    await shots.take(player, "sa-a-5-player-pick-adding");
    const crop = player.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor();
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    const image = await waitFor("Thorn's starter portrait", () => {
      const img = playerSocket.state?.characters[run.thorn.characterId]?.defaultImage;
      return img && "assetId" in img ? img : null;
    });
    const row = await assetRow(playerContext.request, server.origin, run.roomId, image.assetId);
    assert.equal(row?.starter, found.work.key);
    // Nowhere else: the places for maps, handouts and stamps are the DM's alone.
    assert.equal(await player.getByRole("button", { name: "From starter packs" }).count(), 0);
    assert.equal(await player.getByRole("button", { name: "Map builder" }).count(), 0);
    await player.keyboard.press("Escape");
  });

  test("10. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
    assert.deepEqual(playerConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
