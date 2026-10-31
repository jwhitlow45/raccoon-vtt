import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { barControl, ConsoleWatch, diceFoldsOpen, OpSocket, openSideTab, pickTool, reopenRoom, resultLine, resultLines, Shots, sideTabName, sleep, SocketWatch, startServer, tapCell, Touches, waitFor, type ResultLine, type Server, type TouchAt } from "./harness.ts";

/**
 * The one-roll mode menu (docs/design-v1-roll-mode-menu.md), its steps
 * labeled `dpf1-`, on the real server serving the production build: each
 * roll the Dice panel makes for one creature, its free formula, its two
 * Again buttons, a save, an ability check, a skill, Initiative and Roll
 * instead, a death save, an attack, its damage, a heal and two plain
 * rolls, opened by a held finger on Pat's phone and by a right-click,
 * ContextMenu and Shift+F10 on the DM's computer, each sending the one
 * roll its pick names and leaving the panel's Adv, Dis and Secret as they
 * were. Then the press itself (3.2): 499 ms is a tap and 500 ms a menu on
 * the page's own clock, 8 px of travel holds and 9 px cancels, as do a
 * scroll and a second finger, a fired hold's finger never scrolls the
 * sheet, a duplicate touch context menu leaves the one menu open, the
 * release and its click after a hold pick nothing, a press on the open
 * source closes it and rolls nothing, a reader's click and Enter still
 * roll, a mouse's held left button is only a click, and the routes with
 * no menu (an ask, a recharge, the quick dice, a group save, a non-d20
 * Again) answer no hold, right-click or key with one.
 *
 * Every context runs under reduced motion, so a result shows at once and
 * no dice are in the air to take the next tap (docs/design-v1-roll-animation.md 3.5).
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus thirty-nine, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 39;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-rollmodes-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const COMPUTER = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 20, h: 12 };
/** Past the 500 ms hold (lib/gestures.ts LONG_PRESS_MS), with room for a slow runner. */
const HELD_MS = 700;
/** How long a step waits to be sure a gesture sent nothing. */
const QUIET_MS = 600;

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E roll modes ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: "",
  thornChar: randomUUID(),
  thorn: { id: randomUUID(), x: 3, y: 3 },
  goblin: { id: randomUUID(), x: 9, y: 3 },
  goblin2: { id: randomUUID(), x: 11, y: 3 },
  dragon: { id: randomUUID(), x: 14, y: 6 },
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 1, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

/** Thorn's block: a weapon, a healing spell and two plain rolls, a d20 and a d8, so each kind of named roll shows. */
const THORN_STATS = {
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 16, cha: 10 },
  saves: ["wis", "cha"],
  skills: { athletics: "prof" },
  spellAbility: "wis",
  adjust: {},
  defenses: {},
  rolls: [
    { id: "ls", name: "Longsword", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "slashing" }] },
    { id: "cw", name: "Cure Wounds", kind: "spell", ability: "spell", level: 1, dice: [{ formula: "1d8", mod: true, type: "healing" }] },
    { id: "luck", name: "Luck", kind: "other", dice: [{ formula: "1d20" }] },
    { id: "bi", name: "Bardic Inspiration", kind: "other", dice: [{ formula: "1d8" }] },
  ],
};

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

function tokenOp(id: string, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } };
}

type SentRoll = { formula: string; mode?: string; cancelled?: true; label?: string };
type Op = { t: string; to?: string; mode?: string; cancelled?: true; rolls?: SentRoll[] } & Record<string, unknown>;
const ROLL_OPS = new Set(["dice.roll", "roll.dice", "actor.deathRoll", "actor.rechargeRoll"]);

/** Every op a page sent on its room socket, in order, so a step reads exactly what a gesture sent. */
class OpsSent {
  readonly ops: Op[] = [];
  attach(page: Page): void {
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws?room=")) return;
      ws.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8")) as { t?: string; op?: Op };
          if (frame.t === "op" && frame.op) this.ops.push(frame.op);
        } catch {
          // Not JSON: nothing this file reads.
        }
      });
    });
  }
  rolls(from: number): Op[] {
    return this.ops.slice(from).filter((op) => ROLL_OPS.has(op.t));
  }
}
const dmSent = new OpsSent();
const patSent = new OpsSent();

/**
 * Exactly one roll op sent since `from`: waits for it, then a little longer
 * for any second one, then for a dice line to land in the sender's log, so
 * the panel's sticky line has grown before the next step. The panel's
 * scroll anchoring moves its scroller as the line grows, which a step
 * that measures or presses must not race.
 */
async function oneRoll(sent: OpsSent, from: number, what: string): Promise<Op> {
  await waitFor(`${what} sent`, () => sent.rolls(from).length > 0 || null);
  await sleep(300);
  const rolls = sent.rolls(from);
  assert.equal(rolls.length, 1, `${what} sent one roll: ${JSON.stringify(rolls)}`);
  const op = rolls[0]!;
  const socket = sent === dmSent ? dmSocket : sent === patSent ? patSocket : null;
  if (socket && op.t === "dice.roll") await waitFor(`${what} landed`, () => socket.state?.log.some((e) => e.data?.type === "dice" && e.data.tag === op.tag) || null);
  await sleep(150);
  return op;
}

async function noRoll(sent: OpsSent, from: number, what: string): Promise<void> {
  await sleep(QUIET_MS);
  assert.deepEqual(sent.rolls(from), [], `${what} sent no roll`);
}

/** The roll's mode and visibility as sent: a dice.roll's from its first roll, a request answer's or death save's from the op. */
function sentMode(op: Op): { t: string; mode: string | null; cancelled: boolean; to: string | null } {
  const roll = op.rolls?.[0];
  return { t: op.t, mode: (roll ? roll.mode : op.mode) ?? null, cancelled: (roll ? roll.cancelled : op.cancelled) === true, to: op.to ?? null };
}

function diceSheet(page: Page): Locator {
  return page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
}

async function openDiceSheet(page: Page): Promise<Locator> {
  const dice = diceSheet(page);
  if (await dice.isVisible()) return dice;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Dice/ }).tap();
  await dice.waitFor();
  return dice;
}

function dmDice(): Locator {
  return dm.getByRole("tabpanel", { name: sideTabName("Dice") });
}

/** The DM's Dice panel for one token, selected alone by a click on its cell. */
async function dmDiceFor(cell: { x: number; y: number }, name: string): Promise<Locator> {
  await dm.keyboard.press("Escape");
  await tapCell(dm, BOUNDS, cell);
  await openSideTab(dm, "Dice");
  const panel = dmDice();
  try {
    await panel.getByRole("region", { name: `Rolls for ${name}` }).waitFor({ timeout: 10_000 });
  } catch (err) {
    await shots.take(dm, `missing-dice-for-${name}`);
    throw err;
  }
  return panel;
}

function rollMenu(page: Page, name: string | RegExp): Locator {
  return page.getByRole("menu", { name: typeof name === "string" ? `Roll options for ${name}` : name });
}

type Item = { title: string; disabled: boolean };

const D20: Item[] = [
  { title: "Roll with Advantage", disabled: false },
  { title: "Roll with Disadvantage", disabled: false },
  { title: "Roll secretly", disabled: false },
  { title: "Roll normally", disabled: false },
];
/** A d20 roll whose visibility the route fixes: a request's answer, a death save, an Again. */
const D20_FIXED: Item[] = [
  { title: "Roll with Advantage", disabled: false },
  { title: "Roll with Disadvantage", disabled: false },
  { title: "Roll secretly", disabled: true },
  { title: "Roll normally", disabled: false },
];
const PLAIN: Item[] = [
  { title: "Roll secretly", disabled: false },
  { title: "Roll normally", disabled: false },
];

const HINT = {
  d20: "Hold, right-click or Shift+F10 for Advantage, Disadvantage, Secret or Normal.",
  fixed: "Hold, right-click or Shift+F10 for Advantage, Disadvantage or Normal.",
  plain: "Hold, right-click or Shift+F10 for Secret or Normal.",
} as const;

const NORMAL_HELP = "Roll normally: ignores Adv, Dis and Secret pressed for this roll. Conditions and usual visibility still apply.";

async function itemsOf(menu: Locator): Promise<Item[]> {
  await menu.waitFor();
  return menu.getByRole("menuitem").evaluateAll((els) => els.map((el) => ({ title: (el as unknown as { innerText: string }).innerText.trim(), disabled: el.getAttribute("aria-disabled") === "true" })));
}

/** The visible help above the menu's rows (RollModeMenu.tsx). */
function helpOf(page: Page, menu: Locator): Promise<string[]> {
  return page.locator("div[data-roll-mode-menu]").filter({ has: menu }).locator("p").allInnerTexts();
}

/** What a button's description reads: each id in aria-describedby, by its text. */
function describedBy(button: Locator): Promise<string> {
  return button.evaluate((el) => {
    const doc = (el as unknown as { ownerDocument: { getElementById(id: string): { textContent: string | null } | null } }).ownerDocument;
    return (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id: string) => doc.getElementById(id)?.textContent ?? `(no ${id})`).join(" | ");
  });
}

/** Where the panel's own Adv, Dis and Secret stand. */
async function modes(scope: Locator): Promise<{ adv: boolean; dis: boolean; secret: boolean }> {
  const group = scope.getByRole("group", { name: "For the next roll" });
  const pressed = async (name: RegExp) => (await group.getByRole("button", { name }).getAttribute("aria-pressed")) === "true";
  return { adv: await pressed(/^Advantage$/), dis: await pressed(/^Disadvantage$/), secret: await pressed(/^(Hide from players|Only the DM sees it)$/) };
}

async function pressMode(scope: Locator, name: "Advantage" | "Disadvantage"): Promise<void> {
  const button = scope.getByRole("group", { name: "For the next roll" }).getByRole("button", { name, exact: true });
  const was = await button.getAttribute("aria-pressed");
  await button.click();
  await waitFor(`${name} switched`, async () => ((await button.getAttribute("aria-pressed")) !== was ? true : null));
}

/** The middle of a control, scrolled to the middle of its scroller, clear of the sticky line, in the viewport's CSS px, where a finger lands. */
async function middle(control: Locator): Promise<TouchAt> {
  await control.evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "center", inline: "nearest" }));
  await sleep(100);
  const box = await control.boundingBox();
  assert.ok(box, "the control has a box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One finger held on `control` past the hold, then lifted where it is. */
async function hold(cdp: CDPSession, control: Locator, ms = HELD_MS): Promise<void> {
  const at = await middle(control);
  const touches = new Touches(cdp);
  await touches.start([at]);
  await sleep(ms);
  await touches.end([], 16);
}

/** The nearest scroller around `inside`, by its scroll offset. */
function scrollTopAround(inside: Locator): Promise<number> {
  return inside.evaluate((el) => {
    type Box = { parentElement: Box | null; scrollTop: number; scrollHeight: number; clientHeight: number };
    const view = (el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: Box): { overflowY: string } } } }).ownerDocument.defaultView;
    let box = (el as unknown as Box).parentElement;
    while (box && !/(auto|scroll)/.test(view.getComputedStyle(box).overflowY)) box = box.parentElement;
    return box ? box.scrollTop : -1;
  });
}

function nudgeScroll(inside: Locator, by: number): Promise<void> {
  return inside.evaluate((el, by) => {
    type Box = { parentElement: Box | null; scrollTop: number };
    const view = (el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: Box): { overflowY: string } } } }).ownerDocument.defaultView;
    let box = (el as unknown as Box).parentElement;
    while (box && !/(auto|scroll)/.test(view.getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop += by;
  }, by);
}

/** The context menu Android sends for a long press of its own, a touch's. */
function touchContextMenu(control: Locator): Promise<void> {
  return control.evaluate((el) => {
    const g = globalThis as unknown as { PointerEvent: new (type: string, init: Record<string, unknown>) => unknown };
    (el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(new g.PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch" }));
  });
}

/** The click Safari sends where a held finger lifts, a pointer's, with detail 1. */
function liftClick(control: Locator): Promise<void> {
  return control.evaluate((el) => {
    const g = globalThis as unknown as { MouseEvent: new (type: string, init: Record<string, unknown>) => unknown };
    (el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(new g.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

/**
 * A Mac's Ctrl+click on `control`, as its browser sends it: a left press
 * with Ctrl, its contextmenu from the mouse, the lift, and the click Safari
 * adds. Whether the page prevented the contextmenu comes back.
 */
function ctrlClick(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    type Target = { dispatchEvent(e: unknown): boolean; getBoundingClientRect(): { left: number; top: number; width: number; height: number } };
    const g = globalThis as unknown as { PointerEvent: new (type: string, init: Record<string, unknown>) => { defaultPrevented: boolean }; MouseEvent: new (type: string, init: Record<string, unknown>) => unknown };
    const target = el as unknown as Target;
    const box = target.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, ctrlKey: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    const pointer = { ...at, pointerType: "mouse", pointerId: 1, isPrimary: true };
    target.dispatchEvent(new g.PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    target.dispatchEvent(new g.MouseEvent("mousedown", { ...at, buttons: 1, detail: 1 }));
    const menu = new g.PointerEvent("contextmenu", { ...pointer, buttons: 1, detail: 0 });
    target.dispatchEvent(menu);
    target.dispatchEvent(new g.PointerEvent("pointerup", { ...pointer, buttons: 0 }));
    target.dispatchEvent(new g.MouseEvent("mouseup", { ...at, buttons: 0, detail: 1 }));
    target.dispatchEvent(new g.MouseEvent("click", { ...at, buttons: 0, detail: 1 }));
    return menu.defaultPrevented;
  });
}

/** Counts every contextmenu event that reaches the window, and whether the page prevented it, so a step sees the browser's own too. */
async function watchContextMenus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { rvttMenus?: boolean[]; addEventListener(t: string, f: (e: { defaultPrevented: boolean }) => void): void };
    if (w.rvttMenus) {
      w.rvttMenus.length = 0;
      return;
    }
    w.rvttMenus = [];
    // Bubbling ends at the window, after the roll button's own handler had its say.
    w.addEventListener("contextmenu", (e) => w.rvttMenus!.push(e.defaultPrevented));
  });
}

function contextMenus(page: Page): Promise<boolean[]> {
  return page.evaluate(() => [...((globalThis as unknown as { rvttMenus?: boolean[] }).rvttMenus ?? [])]);
}

function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null; innerText?: string; tagName: string } | null } }).document.activeElement;
    return el ? `${el.tagName.toLowerCase()} ${el.getAttribute("role") ?? ""} ${el.getAttribute("aria-label") ?? (el.innerText ?? "").trim().slice(0, 40)}` : "none";
  });
}

async function isFocused(control: Locator): Promise<boolean> {
  return control.evaluate((el) => (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement === el);
}

/** One roll control of the Dice panel, the menu it opens, what that menu lists, and a pick with the roll it sends. */
type Family = {
  what: string;
  button(scope: Locator): Locator;
  menu: RegExp;
  items: Item[];
  hint: string;
  /** Help above the rows, as each line reads. */
  help?: string[];
  pick: string;
  sends: { t: string; mode: string | null; cancelled?: boolean; to: string | null };
};

/** Thorn's controls as Pat rolls them: his own creature, so every roll starts public. */
function patFamilies(): Family[] {
  const player = ["Roll secretly: you and the DM see the result.", NORMAL_HELP];
  return [
    { what: "a save", button: (s) => s.getByRole("button", { name: /^Wisdom save/ }), menu: /^Roll options for Wisdom save/, items: D20, hint: HINT.d20, help: player, pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "all" } },
    { what: "an ability check", button: (s) => s.getByRole("button", { name: /^Strength check/ }), menu: /^Roll options for Strength check/, items: D20, hint: HINT.d20, pick: "Roll secretly", sends: { t: "dice.roll", mode: null, to: "dm" } },
    { what: "a skill", button: (s) => s.getByRole("button", { name: /^Athletics check/ }), menu: /^Roll options for Athletics check, proficient/, items: D20, hint: HINT.d20, pick: "Roll normally", sends: { t: "dice.roll", mode: null, to: "all" } },
    { what: "Initiative", button: (s) => s.getByRole("button", { name: /^Initiative/ }), menu: /^Roll options for Initiative/, items: D20, hint: HINT.d20, pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "all" } },
    { what: "an attack", button: (s) => s.getByRole("button", { name: "Longsword", exact: true }), menu: /^Roll options for Longsword$/, items: D20, hint: HINT.d20, pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "all" } },
    // A natural 20 on the attack before it presses Critical Hit, which the damage's name then carries.
    { what: "its damage", button: (s) => s.getByRole("button", { name: /^Longsword damage(, .+)?$/ }), menu: /^Roll options for Longsword damage(, .+)?$/, items: PLAIN, hint: HINT.plain, pick: "Roll secretly", sends: { t: "dice.roll", mode: null, to: "dm" } },
    { what: "a heal", button: (s) => s.getByRole("button", { name: "Cure Wounds healing", exact: true }), menu: /^Roll options for Cure Wounds healing$/, items: PLAIN, hint: HINT.plain, pick: "Roll normally", sends: { t: "dice.roll", mode: null, to: "all" } },
    { what: "a plain d20", button: (s) => s.getByRole("button", { name: "Luck, 1d20", exact: true }), menu: /^Roll options for Luck, 1d20$/, items: D20, hint: HINT.d20, pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "all" } },
    { what: "a plain d8", button: (s) => s.getByRole("button", { name: "Bardic Inspiration, 1d8", exact: true }), menu: /^Roll options for Bardic Inspiration, 1d8$/, items: PLAIN, hint: HINT.plain, pick: "Roll secretly", sends: { t: "dice.roll", mode: null, to: "dm" } },
  ];
}

const DEATH_SAVE: Family = {
  what: "a death save",
  button: (s) => s.getByRole("button", { name: /^Death Save/ }),
  menu: /^Roll options for Death Save/,
  items: D20_FIXED,
  hint: HINT.fixed,
  help: ["Roll secretly: this roll's visibility is set by the creature.", NORMAL_HELP],
  pick: "Roll with Advantage",
  sends: { t: "actor.deathRoll", mode: "adv", to: null },
};

/** The sticky line's Again and Recent rolls' Again for a public d20 roll: the recorded visibility, and the recorded formula. */
function againFamilies(formula: string): Family[] {
  const help = ["Roll secretly: this repeat keeps its recorded visibility.", "Roll normally: ignores the recorded mode and keeps the formula and visibility.", "All repeat choices: use the recorded formula. Current effects are not rebuilt."];
  const escaped = formula.replace(/[+]/g, "\\+");
  return [
    { what: "the sticky line's Again", button: (s) => s.locator("[data-dice-last]").getByRole("button", { name: "Again", exact: true }), menu: /^Roll options for Again$/, items: D20_FIXED, hint: HINT.fixed, help, pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "all" } },
    { what: "Recent rolls' Again", button: (s) => s.locator("[data-dice-recent]").getByRole("button", { name: new RegExp(`^Roll again: ${escaped}`) }).first(), menu: /^Roll options for Again$/, items: D20_FIXED, hint: HINT.fixed, help, pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "all" } },
  ];
}

/** The ARIA a menu's source carries, and what its description reads. */
async function sourceAria(button: Locator, family: Family): Promise<void> {
  assert.equal(await button.getAttribute("aria-haspopup"), "menu", `${family.what} says it opens a menu: ${await button.evaluate((el) => (el as unknown as { outerHTML: string }).outerHTML.replace(/style="[^"]*"/g, "").slice(0, 300))}`);
  assert.equal(await button.getAttribute("aria-keyshortcuts"), "ContextMenu Shift+F10", `${family.what} names its keys`);
  assert.equal(await button.getAttribute("aria-expanded"), "false", `${family.what} starts closed`);
  assert.ok((await describedBy(button)).endsWith(family.hint), `${family.what}'s description ends with its hint: ${await describedBy(button)}`);
}

/** A menu just opened from `button`: open, listing its items, with its help, and tied to its source. */
async function opened(page: Page, button: Locator, family: Family): Promise<Locator> {
  const menu = rollMenu(page, family.menu);
  try {
    await menu.waitFor({ timeout: 5_000 });
  } catch (err) {
    await shots.take(page, `missing-menu-${family.what.replace(/\W+/g, "-")}`);
    const box = await button.boundingBox();
    const open = await page.getByRole("menu").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    throw new Error(`${family.what}: no menu (button at ${JSON.stringify(box)}, expanded ${await button.getAttribute("aria-expanded")}, menus ${JSON.stringify(open)}): ${String(err)}`);
  }
  assert.deepEqual(await itemsOf(menu), family.items, `${family.what}'s menu`);
  if (family.help) assert.deepEqual(await helpOf(page, menu), family.help, `${family.what}'s help`);
  assert.equal(await button.getAttribute("aria-expanded"), "true", `${family.what} says it is open`);
  assert.equal(await button.getAttribute("aria-controls"), await menu.getAttribute("id"), `${family.what} controls its menu`);
  return menu;
}

/**
 * Opens `button`'s menu by `how`: a held finger on Pat's phone, a
 * right-click or the ContextMenu key on the DM's computer, checks its
 * family (items, help, ARIA, nothing sent), then picks and hands back the
 * one roll op the pick sent.
 */
async function pickFrom(page: Page, sent: OpsSent, button: Locator, family: Family, how: "hold" | "right" | "key"): Promise<Op> {
  await button.waitFor();
  await sourceAria(button, family);
  await middle(button);
  const from = sent.ops.length;
  if (how === "hold") await hold(page === pat ? patCdp : await page.context().newCDPSession(page), button);
  else if (how === "right") await button.click({ button: "right" });
  else {
    await button.focus();
    await page.keyboard.press("ContextMenu");
  }
  const menu = await opened(page, button, family);
  await noRoll(sent, from, `opening ${family.what}`);
  if (how === "hold") await menu.getByRole("menuitem", { name: family.pick }).tap();
  else await menu.getByRole("menuitem", { name: family.pick }).click();
  const op = await oneRoll(sent, from, `${family.pick} on ${family.what}`);
  const got = sentMode(op);
  assert.deepEqual({ ...got, cancelled: got.cancelled }, { cancelled: false, ...family.sends }, `${family.what}: ${family.pick}`);
  await menu.waitFor({ state: "detached" });
  return op;
}

/** Pat's Dice sheet, Thorn's card in it. */
async function patDice(): Promise<Locator> {
  const sheet = await openDiceSheet(pat);
  await sheet.getByRole("region", { name: "Rolls for Thorn" }).waitFor();
  return sheet;
}

async function closeMenus(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator("div[data-roll-mode-menu]").first().waitFor({ state: "detached" }).catch(() => undefined);
}

async function setDying(on: boolean): Promise<void> {
  await ops.send({ t: "actor.hp", target: { characterId: run.thornChar }, change: { kind: on ? "damage" : "heal", amount: 30 } });
  await waitFor(`Thorn ${on ? "dying" : "up again"}`, () => ((dmSocket.state?.characters[run.thornChar]?.actor.life === "dying") === on ? true : null));
}

describe("raccoon-vtt one-roll mode menu", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: COMPUTER, reducedMotion: "reduce" });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await diceFoldsOpen(dmContext);
    await diceFoldsOpen(patContext);
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    dmSent.attach(dm);
    patSent.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    patCdp = await patContext.newCDPSession(pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("dpf1-0. the DM's room at 1440 x 900, Pat on a phone with Thorn, a goblin and a dragon", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.patId = await join(patContext, "Pat", "#30a46c");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "room.update", settings: { monsterInitScore: true } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(), level: 5, stats: THORN_STATS } });
    await ops.send(tokenOp(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tokenOp(run.goblin.id, { kind: "monster", name: "Goblin", x: run.goblin.x, y: run.goblin.y, disposition: "hostile", actor: { inline: actor({ srdId: "goblin-warrior", initScore: 12 }) } }));
    await ops.send(tokenOp(run.goblin2.id, { kind: "monster", name: "Goblin 2", x: run.goblin2.x, y: run.goblin2.y, disposition: "hostile", actor: { inline: actor({ srdId: "goblin-warrior" }) } }));
    await ops.send(tokenOp(run.dragon.id, { kind: "monster", name: "Dragon", x: run.dragon.x, y: run.dragon.y, disposition: "hostile", actor: { inline: actor({ srdId: "adult-black-dragon" }) } }));
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Thorn on Pat's page", () => patSocket.state?.tokens[run.thorn.id]);
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("dpf1-1. Pat holds the formula's Roll: the menu opens with no roll, its release sends nothing, Advantage rolls once, and Dis stays pressed for the next roll", async () => {
    const sheet = await patDice();
    await pressMode(sheet, "Disadvantage");
    const before = await modes(sheet);
    assert.deepEqual(before, { adv: false, dis: true, secret: false });
    await sheet.getByLabel("Dice formula", { exact: true }).fill("1d20+3");
    const roll = sheet.getByRole("button", { name: "Roll", exact: true });
    const family: Family = { what: "the formula's Roll", button: () => roll, menu: /^Roll options for Dice formula$/, items: D20, hint: HINT.d20, help: ["Roll secretly: you and the DM see the result.", NORMAL_HELP], pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "all" } };
    await sourceAria(roll, family);
    const from = patSent.ops.length;
    const at = await middle(roll);
    const touches = new Touches(patCdp);
    await touches.start([at]);
    await sleep(350);
    // After 200 ms of a still hold, a static inset outline says the press is held (3.2 step 4).
    assert.match(await roll.evaluate((el) => (el as unknown as { style: { boxShadow: string } }).style.boxShadow), /inset/, "the held press shows its outline");
    assert.equal(await rollMenu(pat, family.menu).count(), 0, "no menu before 500 ms");
    await sleep(HELD_MS - 350);
    const menu = await opened(pat, roll, family);
    assert.doesNotMatch(await roll.evaluate((el) => (el as unknown as { style: { boxShadow: string } }).style.boxShadow), /inset/, "the outline goes once the menu opens");
    await touches.end([], 16);
    await noRoll(patSent, from, "the hold and its release");
    assert.ok(await menu.isVisible(), "the menu stays open after the release");
    await shots.take(pat, "dpf1-1-formula-menu");
    await menu.getByRole("menuitem", { name: "Roll with Advantage" }).tap();
    const op = await oneRoll(patSent, from, "Roll with Advantage");
    assert.deepEqual(sentMode(op), { t: "dice.roll", mode: "adv", cancelled: false, to: "all" });
    assert.equal(op.rolls?.[0]?.formula, "1d20+3");
    await menu.waitFor({ state: "detached" });
    assert.deepEqual(await modes(sheet), before, "the menu roll leaves Dis pressed");

    const next = patSent.ops.length;
    await sheet.getByLabel("Dice formula", { exact: true }).fill("1d20+1");
    await roll.tap();
    assert.deepEqual(sentMode(await oneRoll(patSent, next, "the next ordinary roll")), { t: "dice.roll", mode: "dis", cancelled: false, to: "all" }, "the ordinary roll takes the Dis still pressed");
    assert.deepEqual(await modes(sheet), { adv: false, dis: false, secret: false }, "and uses it up, as before");
  });

  test("dpf1-2. on the page's own clock, a press lifted at 499 ms is one ordinary roll, and one held 500 ms opens the menu and its release rolls nothing", async () => {
    const page = await patContext.newPage();
    const sent = new OpsSent();
    sent.attach(page);
    const watch = new ConsoleWatch("pat-clock");
    watch.attach(page);
    try {
      await page.clock.install();
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      const cdp = await patContext.newCDPSession(page);
      const sheet = await openDiceSheet(page);
      const field = sheet.getByLabel("Dice formula", { exact: true });
      const roll = sheet.getByRole("button", { name: "Roll", exact: true });
      const outlined = () => roll.evaluate((el) => /inset/.test((el as unknown as { style: { boxShadow: string } }).style.boxShadow));

      await field.fill("1d20+4");
      const at = await middle(roll);
      let from = sent.ops.length;
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 50);
      const touches = new Touches(cdp);
      await touches.start([at]);
      await page.clock.runFor(199);
      assert.equal(await outlined(), false, "no outline at 199 ms");
      await page.clock.runFor(300);
      assert.equal(await outlined(), true, "the outline from 200 ms");
      assert.equal(await roll.getAttribute("aria-expanded"), "false", "no menu at 499 ms");
      await touches.end([], 16);
      await page.clock.resume();
      assert.deepEqual(sentMode(await oneRoll(sent, from, "the 499 ms press")), { t: "dice.roll", mode: null, cancelled: false, to: "all" });
      assert.equal(await outlined(), false, "the outline goes with the release");
      assert.equal(await rollMenu(page, "Dice formula").count(), 0, "and no menu came");

      await field.fill("1d20+4");
      from = sent.ops.length;
      // The first roll's sticky line moved the button down.
      const again = await middle(roll);
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 50);
      await touches.start([again]);
      await page.clock.runFor(500);
      await waitFor("the menu at 500 ms", async () => ((await roll.getAttribute("aria-expanded")) === "true" ? true : null));
      await touches.end([], 16);
      await page.clock.resume();
      await rollMenu(page, "Dice formula").waitFor();
      await noRoll(sent, from, "the 500 ms hold and its release");
      await closeMenus(page);
      assert.deepEqual(watch.errors, []);
    } finally {
      await page.close();
      // A page behind another is hidden, and Chrome slows its timers to a second.
      await pat.bringToFront();
    }
  });

  test("dpf1-3. 8 px of travel still holds, 9 px, out and back, a scroll and a second finger each cancel the press, and none of those lifts rolls", async () => {
    const sheet = await patDice();
    const field = sheet.getByLabel("Dice formula", { exact: true });
    const roll = sheet.getByRole("button", { name: "Roll", exact: true });
    await field.fill("1d20+5");
    const at = await middle(roll);
    const touches = new Touches(patCdp);

    let from = patSent.ops.length;
    await touches.start([at]);
    await touches.move([{ x: at.x + 8, y: at.y }], 40);
    await sleep(HELD_MS);
    await rollMenu(pat, "Dice formula").waitFor({ timeout: 2_000 });
    await touches.end([], 16);
    await noRoll(patSent, from, "an 8 px hold");
    await closeMenus(pat);

    const cancelled: [string, () => Promise<void>][] = [
      ["9 px of travel", async () => {
        await touches.start([at]);
        await touches.move([{ x: at.x + 9, y: at.y }], 40);
        await sleep(HELD_MS);
        await touches.end([], 16);
      }],
      ["20 px out and back", async () => {
        await touches.start([at]);
        await touches.move([{ x: at.x + 20, y: at.y }], 40);
        await touches.move([at], 40);
        await sleep(HELD_MS);
        await touches.end([], 16);
      }],
      ["a scroll of the sheet", async () => {
        await touches.start([at]);
        await sleep(100);
        await nudgeScroll(roll, 30);
        await sleep(HELD_MS);
        await touches.end([], 16);
        await nudgeScroll(roll, -30);
      }],
      ["a second finger", async () => {
        const other = await middle(sheet.locator("[data-roll-mode-help]"));
        await touches.start([at]);
        await touches.start([at, { ...other, id: 2 }], 100);
        await sleep(HELD_MS);
        await touches.end([at], 16);
        await touches.end([], 16);
      }],
    ];
    for (const [what, gesture] of cancelled) {
      from = patSent.ops.length;
      const before = await modes(sheet);
      await gesture();
      assert.equal(await rollMenu(pat, "Dice formula").count(), 0, `${what} opened no menu`);
      await noRoll(patSent, from, what);
      assert.deepEqual(await modes(sheet), before, `${what} changed no mode`);
      assert.equal(await field.inputValue(), "1d20+5", `${what} left the formula to roll`);
    }
    // The next press is a tap again.
    from = patSent.ops.length;
    await roll.tap();
    await oneRoll(patSent, from, "the tap after them");
  });

  test("dpf1-4. a fired hold owns its still-down finger: its drift scrolls nothing and keeps the menu, a duplicate touch context menu leaves the one menu, the lift's click picks nothing, and a new tap picks", async () => {
    const sheet = await patDice();
    const save = sheet.getByRole("button", { name: /^Wisdom save/ });
    const at = await middle(save);
    const scrolled = await scrollTopAround(save);
    await watchContextMenus(pat);
    const from = patSent.ops.length;
    const touches = new Touches(patCdp);
    await touches.start([at]);
    await sleep(HELD_MS);
    const menu = rollMenu(pat, /^Roll options for Wisdom save/);
    await menu.waitFor();
    for (let i = 1; i <= 6; i++) await touches.move([{ x: at.x, y: at.y - i * 12 }], 16);
    await sleep(200);
    assert.equal(await scrollTopAround(save), scrolled, "the held finger's drift scrolled the sheet");
    assert.ok(await menu.isVisible(), "the drift closed the menu");
    // Android's own long-press context menu for the same press, which must neither close nor reopen the menu.
    await touchContextMenu(save);
    await sleep(200);
    assert.ok(await menu.isVisible(), "a duplicate touch context menu closed the menu");
    assert.deepEqual(await contextMenus(pat), [true], "and its default was prevented");
    await touches.end([], 16);
    // Safari's click after a held press lands on the row under the finger: it must pick nothing.
    await liftClick(menu.getByRole("menuitem", { name: "Roll with Advantage" }));
    await noRoll(patSent, from, "the drift, the duplicate and the lift's click");
    assert.ok(await menu.isVisible(), "the menu waits for a pick");
    await menu.getByRole("menuitem", { name: "Roll with Advantage" }).tap();
    assert.deepEqual(sentMode(await oneRoll(patSent, from, "a new tap on Advantage")), { t: "dice.roll", mode: "adv", cancelled: false, to: "all" });
    // Once cancelled, a late touch context menu opens nothing.
    const late = patSent.ops.length;
    await touches.start([at]);
    await touches.move([{ x: at.x + 20, y: at.y }], 40);
    await touchContextMenu(save);
    await touches.end([], 16);
    await sleep(200);
    assert.equal(await menu.count(), 0, "a late touch context menu opened the menu");
    await noRoll(patSent, late, "the cancelled press and its late context menu");
  });

  test("dpf1-5. a press on the open menu's source closes it and rolls nothing, a hold there does not rearm, and a reader's click and Enter after it each roll once", async () => {
    const sheet = await patDice();
    const field = sheet.getByLabel("Dice formula", { exact: true });
    const roll = sheet.getByRole("button", { name: "Roll", exact: true });
    await pressMode(sheet, "Advantage");
    const before = await modes(sheet);
    await field.fill("1d20+6");
    const menu = rollMenu(pat, "Dice formula");
    let from = patSent.ops.length;

    await hold(patCdp, roll);
    await menu.waitFor();
    await roll.tap();
    await menu.waitFor({ state: "detached" });
    await noRoll(patSent, from, "a tap on the open source");

    await hold(patCdp, roll);
    await menu.waitFor();
    await hold(patCdp, roll, HELD_MS + 300);
    assert.equal(await menu.count(), 0, "a hold on the open source closed it, and did not open it again");
    await noRoll(patSent, from, "a hold on the open source");
    assert.deepEqual(await modes(sheet), before, "the source's presses used no mode");
    assert.equal(await field.inputValue(), "1d20+6");

    await hold(patCdp, roll);
    await menu.waitFor();
    await closeMenus(pat);
    // A reader's double-tap clicks with detail 0, which a hold before it must never swallow.
    from = patSent.ops.length;
    await roll.evaluate((el) => (el as unknown as { click(): void }).click());
    assert.deepEqual(sentMode(await oneRoll(patSent, from, "a reader's click")), { t: "dice.roll", mode: "adv", cancelled: false, to: "all" }, "an ordinary roll, taking Adv");
    await field.fill("1d20+7");
    from = patSent.ops.length;
    await roll.focus();
    await pat.keyboard.press("Enter");
    await oneRoll(patSent, from, "Enter on the Roll button");
  });

  test("dpf1-6. Pat holds each of Thorn's rolls: the menu lists its choices, and its pick sends one roll so, with the panel untouched", async () => {
    const sheet = await patDice();
    for (const family of patFamilies()) {
      const button = family.button(sheet);
      await sourceAria(button, family);
      // A skill's Normal clears a manual press for this roll only.
      if (family.pick === "Roll normally" && family.items === D20) await pressMode(sheet, "Advantage");
      const before = await modes(sheet);
      const from = patSent.ops.length;
      await hold(patCdp, button);
      const menu = await opened(pat, button, family);
      await noRoll(patSent, from, `holding ${family.what}`);
      await menu.getByRole("menuitem", { name: family.pick }).tap();
      const op = await oneRoll(patSent, from, `${family.pick} on ${family.what}`);
      assert.deepEqual(sentMode(op), { cancelled: false, ...family.sends }, `${family.what}: ${family.pick}`);
      await menu.waitFor({ state: "detached" });
      assert.deepEqual(await modes(sheet), before, `${family.what}'s pick changed no mode`);
      if (before.adv) await pressMode(sheet, "Advantage");
    }
  });

  test("dpf1-7. both Agains of a public d20 roll keep its formula and visibility with Secret shown off, and a 2d6 Again has no menu", async () => {
    const sheet = await patDice();
    const field = sheet.getByLabel("Dice formula", { exact: true });
    await field.fill("1d20+2 Stealth");
    let from = patSent.ops.length;
    await field.press("Enter");
    await oneRoll(patSent, from, "Stealth");
    await field.fill("1d20+2 Stealth");
    from = patSent.ops.length;
    await field.press("Enter");
    await oneRoll(patSent, from, "Stealth again, for a second row");
    for (const family of againFamilies("1d20+2")) {
      const button = family.button(sheet);
      await sourceAria(button, family);
      from = patSent.ops.length;
      await hold(patCdp, button);
      const menu = await opened(pat, button, family);
      await menu.getByRole("menuitem", { name: family.pick }).tap();
      const op = await oneRoll(patSent, from, `${family.pick} on ${family.what}`);
      assert.deepEqual(sentMode(op), { cancelled: false, ...family.sends });
      assert.equal(op.rolls?.[0]?.formula, "1d20+2", `${family.what} repeats the formula`);
      assert.equal(op.rolls?.[0]?.label, "Repeated roll", `${family.what}'s public repeat says only that it is one`);
    }
    await field.fill("2d6");
    from = patSent.ops.length;
    await field.press("Enter");
    await oneRoll(patSent, from, "2d6");
    const again = sheet.locator("[data-dice-last]").getByRole("button", { name: "Again", exact: true });
    await again.waitFor();
    assert.equal(await again.getAttribute("aria-haspopup"), null, "a 2d6 Again has no menu");
    assert.equal(await again.getAttribute("aria-keyshortcuts"), null);
    const plain = sheet.locator("[data-dice-recent]").getByRole("button", { name: /^Roll again: 2d6/ }).first();
    assert.equal(await plain.getAttribute("aria-haspopup"), null, "nor has its row in Recent rolls");
  });

  test("dpf1-8. Thorn dying: his Death Save's menu shows Secret off with the creature's reason, and Advantage sends the server's death roll with it", async () => {
    await setDying(true);
    try {
      const sheet = await patDice();
      const button = DEATH_SAVE.button(sheet);
      await button.waitFor();
      await sourceAria(button, DEATH_SAVE);
      const from = patSent.ops.length;
      await hold(patCdp, button);
      const menu = await opened(pat, button, DEATH_SAVE);
      await shots.take(pat, "dpf1-8-death-save-menu");
      // A disabled choice takes no tap.
      await menu.getByRole("menuitem", { name: "Roll secretly" }).tap({ force: true });
      await noRoll(patSent, from, "a tap on the disabled Secret");
      await menu.getByRole("menuitem", { name: DEATH_SAVE.pick }).tap();
      assert.deepEqual(sentMode(await oneRoll(patSent, from, "the death save")), { cancelled: false, ...DEATH_SAVE.sends });
    } finally {
      await setDying(false);
    }
  });

  test("dpf1-9. a request's answer keeps the request's visibility: Secret shows off with its reason, and Advantage answers once", async () => {
    const id = randomUUID();
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, targets: [{ characterId: run.thornChar }] } });
    await waitFor("the ask on Pat's page", () => patSocket.state?.rolls[id]);
    const sheet = await patDice();
    const family: Family = {
      what: "the request's answer",
      button: (s) => s.getByRole("button", { name: /^Dexterity save, answers the DM's request/ }),
      menu: /^Roll options for Dexterity save, answers the DM's request/,
      items: D20_FIXED,
      hint: HINT.fixed,
      help: ["Roll secretly: request answers keep the request's visibility.", NORMAL_HELP],
      pick: "Roll with Advantage",
      sends: { t: "roll.dice", mode: "adv", to: null },
    };
    const button = family.button(sheet);
    await button.waitFor();
    await sourceAria(button, family);
    const from = patSent.ops.length;
    await hold(patCdp, button);
    const menu = await opened(pat, button, family);
    await menu.getByRole("menuitem", { name: family.pick }).tap();
    const op = await oneRoll(patSent, from, "the answer");
    assert.deepEqual(sentMode(op), { cancelled: false, ...family.sends });
    assert.equal(op.rollId, id);
    await waitFor("the answer on the request", () => (dmSocket.state?.rolls[id]?.targets[0]?.total !== undefined ? true : null));
    // Closed, so its card leaves the DM's alert stack, which would stand over the dragon's cell for dpf1-24's tap.
    await ops.send({ t: "roll.close", rollIds: [id] });
    await waitFor("the request closed", () => (dmSocket.state?.rolls[id] ? null : true));
  });

  test("dpf1-10. the DM's computer: with Ask on, Thorn's save has no menu, and with it off each roll opens by right-click, ContextMenu and Shift+F10, closes by a right-click on its source and by Escape, Enter still rolls, and a Mac's Ctrl+click opens as a right-click does", async () => {
    const panel = await dmDiceFor(run.thorn, "Thorn");
    await watchContextMenus(dm);
    const ask = panel.getByRole("switch", { name: "Ask Thorn to roll saves and checks" });
    assert.equal(await ask.getAttribute("aria-checked"), "true");
    const asked = panel.getByRole("button", { name: /^Wisdom save, .*asks the player/ });
    assert.equal(await asked.getAttribute("aria-haspopup"), null, "an ask has no menu");
    assert.equal(await asked.getAttribute("aria-keyshortcuts"), null);
    let from = dmSent.ops.length;
    await asked.click({ button: "right" });
    await asked.focus();
    await dm.keyboard.press("Shift+F10");
    await sleep(300);
    assert.equal(await dm.getByRole("menu", { name: /^Roll options/ }).count(), 0, "neither a right-click nor Shift+F10 opens one on an ask");
    const native = await contextMenus(dm);
    assert.ok(native.length >= 1 && native.every((prevented) => !prevented), `the browser keeps its own menu outside roll controls: ${JSON.stringify(native)}`);
    await noRoll(dmSent, from, "the right-click and key on an ask");
    await ask.click();
    assert.equal(await ask.getAttribute("aria-checked"), "false");

    const dmHelp = ["Roll secretly: hide the dice from players.", NORMAL_HELP];
    for (const family of patFamilies()) {
      const button = family.button(panel);
      const f = { ...family, help: family.help ? dmHelp : undefined };
      await sourceAria(button, f);
      await watchContextMenus(dm);
      // Centered first, so no click below scrolls the panel under an open menu.
      await middle(button);
      from = dmSent.ops.length;

      await button.click({ button: "right" });
      const menu = await opened(dm, button, f);
      assert.ok(await isFocused(button), `a right-click on ${f.what} leaves focus on it: ${await focusedName(dm)}`);
      await button.click({ button: "right" });
      await menu.waitFor({ state: "detached" });
      assert.deepEqual(await contextMenus(dm), [true, true], `${f.what}: both right-clicks kept the browser's menu away`);

      await button.focus();
      await dm.keyboard.press("ContextMenu");
      await opened(dm, button, f);
      assert.equal(await focusedName(dm), `div menuitem ${f.items.find((i) => !i.disabled)!.title}`, `ContextMenu on ${f.what} focuses its first choice`);
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      assert.ok(await isFocused(button), `Escape returns focus to ${f.what}`);
      await noRoll(dmSent, from, `opening and closing ${f.what}`);

      await dm.keyboard.press("Shift+F10");
      await opened(dm, button, f);
      await dm.keyboard.press("End");
      assert.equal(await focusedName(dm), "div menuitem Roll normally");
      await dm.keyboard.press("Enter");
      const op = await oneRoll(dmSent, from, `Roll normally on ${f.what}`);
      assert.deepEqual(sentMode(op), { t: "dice.roll", mode: null, cancelled: false, to: "all" }, `${f.what}: Roll normally`);
      await menu.waitFor({ state: "detached" });
      assert.ok(await isFocused(button), `the pick returns focus to ${f.what}: ${await focusedName(dm)}`);

      from = dmSent.ops.length;
      await dm.keyboard.press("Enter");
      await oneRoll(dmSent, from, `Enter on ${f.what}`);
    }

    // A Mac's Ctrl+click: a left button's contextmenu from a mouse, which opens the menu as a right-click does, focus kept on the source,
    // and the click some browsers send after it closes nothing (DPF1B-OPUS-09). Dispatched, since only a Mac's browser turns the press into a contextmenu.
    const save = patFamilies()[0]!;
    const source = save.button(panel);
    await middle(source);
    from = dmSent.ops.length;
    const prevented = await ctrlClick(source);
    assert.ok(prevented, "the Ctrl+click's contextmenu keeps the browser's menu away");
    const ctrlMenu = await opened(dm, source, { ...save, help: save.help ? dmHelp : undefined });
    assert.ok(await isFocused(source), `a Ctrl+click opens as a mouse does, focus kept on the source: ${await focusedName(dm)}`);
    await sleep(300);
    assert.ok(await ctrlMenu.isVisible(), "the click after the Ctrl+click closes nothing");
    await noRoll(dmSent, from, "a Ctrl+click and its click");
    await dm.keyboard.press("Escape");
    await ctrlMenu.waitFor({ state: "detached" });
    await ask.click();
    assert.equal(await ask.getAttribute("aria-checked"), "true");
  });

  test("dpf1-10b. on the DM's computer the keys open the sticky Again and a death save too, a disabled Secret takes focus and Enter does nothing there, and Tab closes the menu and moves on", async () => {
    const panel = await dmDiceFor(run.thorn, "Thorn");
    const field = panel.getByLabel("Dice formula", { exact: true });
    await field.fill("1d20+2 Keys");
    let from = dmSent.ops.length;
    await field.press("Enter");
    await oneRoll(dmSent, from, "the DM's roll");
    const again = panel.locator("[data-dice-last]").getByRole("button", { name: "Again", exact: true });
    await middle(again);
    await again.focus();
    await dm.keyboard.press("Shift+F10");
    const menu = rollMenu(dm, /^Roll options for Again$/);
    assert.deepEqual(await itemsOf(menu), D20_FIXED);
    assert.equal(await focusedName(dm), "div menuitem Roll with Advantage");
    await dm.keyboard.press("End");
    await dm.keyboard.press("ArrowUp");
    assert.equal(await focusedName(dm), "div menuitem Roll secretly", "a disabled choice takes focus, so its reason is heard");
    from = dmSent.ops.length;
    await dm.keyboard.press("Enter");
    await noRoll(dmSent, from, "Enter on the disabled Secret");
    assert.ok(await menu.isVisible(), "Enter on a disabled choice keeps the menu open");
    await dm.keyboard.press("Tab");
    await menu.waitFor({ state: "detached" });
    assert.doesNotMatch(await focusedName(dm), /menuitem|^body/, "Tab moved on from the menu");
    await noRoll(dmSent, from, "Tab out of the menu");

    await setDying(true);
    try {
      const death = DEATH_SAVE.button(panel);
      await death.waitFor();
      await middle(death);
      await death.focus();
      from = dmSent.ops.length;
      await dm.keyboard.press("ContextMenu");
      await opened(dm, death, DEATH_SAVE);
      await dm.keyboard.press("Enter");
      assert.deepEqual(sentMode(await oneRoll(dmSent, from, "the DM's death save")), { cancelled: false, ...DEATH_SAVE.sends });
    } finally {
      await setDying(false);
    }
  });

  test("dpf1-11. the DM's goblin: Normal keeps a monster's dice secret by default though the panel's Secret is off, Roll instead offers the menu, and a held left button is only a click", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: "e-goblin", tokenId: run.goblin.id, value: 12 }] });
    await waitFor("the goblin's row", () => dmSocket.state?.encounter?.entries.some((e) => e.id === "e-goblin") || null);
    try {
    const panel = await dmDiceFor(run.goblin, "Goblin");
    const secret = panel.getByRole("group", { name: "For the next roll" }).getByRole("button", { name: "Hide from players" });
    assert.equal(await secret.getAttribute("aria-pressed"), "true", "a monster's roll starts secret");
    await secret.click();
    assert.equal(await secret.getAttribute("aria-pressed"), "false");
    const save = panel.getByRole("button", { name: /^Dexterity save/ });
    let from = dmSent.ops.length;
    await save.click({ button: "right" });
    const menu = rollMenu(dm, /^Roll options for Dexterity save/);
    assert.deepEqual(await itemsOf(menu), D20);
    await menu.getByRole("menuitem", { name: "Roll normally" }).click();
    assert.deepEqual(sentMode(await oneRoll(dmSent, from, "Normal on the goblin's save")), { t: "dice.roll", mode: null, cancelled: false, to: "dm" }, "Normal uses the monster's default, secret");
    assert.equal(await secret.getAttribute("aria-pressed"), "false", "and leaves the panel's Secret off");
    from = dmSent.ops.length;
    await save.click();
    assert.deepEqual(sentMode(await oneRoll(dmSent, from, "the ordinary save")), { t: "dice.roll", mode: null, cancelled: false, to: "all" }, "the ordinary tap still takes the panel's public choice");

    const instead = panel.getByRole("button", { name: /^Initiative/ }).filter({ hasText: "Roll instead" });
    await instead.waitFor();
    from = dmSent.ops.length;
    await instead.focus();
    await dm.keyboard.press("ContextMenu");
    const menuInit = rollMenu(dm, /^Roll options for Initiative/);
    assert.deepEqual(await itemsOf(menuInit), D20);
    await dm.keyboard.press("Enter");
    assert.deepEqual(sentMode(await oneRoll(dmSent, from, "Roll instead with Advantage")), { t: "dice.roll", mode: "adv", cancelled: false, to: "dm" });

    // A mouse's left button held past 500 ms never arms the menu: its release is an ordinary click.
    from = dmSent.ops.length;
    const box = (await save.boundingBox())!;
    await dm.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await dm.mouse.down();
    await sleep(HELD_MS + 200);
    assert.equal(await menu.count(), 0, "a held left button opened the menu");
    await dm.mouse.up();
    await oneRoll(dmSent, from, "the held left button's click");
    } finally {
      await ops.send({ t: "encounter.end" });
    }
  });

  test("dpf1-12. no menu on what is not a roll of one creature: a recharge, a group save, the quick dice and the bar's Roll", async () => {
    const panel = await dmDiceFor(run.dragon, "Dragon");
    await watchContextMenus(dm);
    const recharge = panel.getByRole("button", { name: /recharge, 1d6$/ }).first();
    const group = panel.getByRole("button", { name: /^Group save, DC/ }).first();
    const quick = panel.getByRole("button", { name: "Add a d20", exact: true });
    for (const [what, control] of [["a recharge", recharge], ["a group save", group], ["a quick die", quick]] as const) {
      await control.waitFor();
      assert.equal(await control.getAttribute("aria-haspopup"), null, `${what} says it opens no menu`);
      assert.equal(await control.getAttribute("aria-keyshortcuts"), null, `${what} names no menu keys`);
      const from = dmSent.ops.length;
      await control.click({ button: "right" });
      await control.focus();
      await dm.keyboard.press("Shift+F10");
      await sleep(200);
      assert.equal(await dm.getByRole("menu", { name: /^Roll options/ }).count(), 0, `${what} opened a roll menu`);
      await noRoll(dmSent, from, `a right-click and Shift+F10 on ${what}`);
    }
    assert.ok((await contextMenus(dm)).every((prevented) => !prevented), "the browser keeps its own menu there");
    const bar = dm.getByRole("dialog", { name: "Dragon actions" });
    if (await bar.isVisible()) {
      const opener = bar.getByRole("button", { name: /^Roll/ }).first();
      assert.equal(await opener.getAttribute("aria-haspopup"), null, "the bar's Roll opens Dice, not a roll menu");
    }
    await dm.keyboard.press("Escape");
  });

  test("dpf1-20. a request's Roll on Pat's card and on the DM's live card: Secret shown off for the request's visibility, and the pick answers once, the DM's still guarded as unanswered", async () => {
    const first = randomUUID();
    await ops.send({ t: "roll.ask", request: { id: first, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, targets: [{ characterId: run.thornChar }] } });
    await waitFor("the ask on Pat's page", () => patSocket.state?.rolls[first]);
    const fixed = (what: string, menu: RegExp, pick: string, mode: string | null): Family => ({ what, button: () => pat.locator("x"), menu, items: D20_FIXED, hint: HINT.fixed, help: ["Roll secretly: request answers keep the request's visibility.", NORMAL_HELP], pick, sends: { t: "roll.dice", mode, to: null } });
    const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
    if (!(await card.isVisible())) await pat.getByRole("button", { name: /^Roll asked/ }).first().tap();
    const roll = card.getByRole("button", { name: "Roll +1 for Thorn", exact: true });
    let op = await pickFrom(pat, patSent, roll, fixed("Pat's request card", /^Roll options for Roll \+1 for Thorn$/, "Roll with Disadvantage", "dis"), "hold");
    assert.equal(op.rollId, first);
    await waitFor("Pat's answer", () => (dmSocket.state?.rolls[first]?.targets[0]?.total !== undefined ? true : null));
    await ops.send({ t: "roll.close", rollIds: [first] });

    const second = randomUUID();
    await ops.send({ t: "roll.ask", request: { id: second, test: { kind: "save", choices: [{ ability: "wis" }] }, dc: 13, dcShown: true, resultShown: true, targets: [{ characterId: run.thornChar }] } });
    const live = dm.getByRole("group", { name: "Roll request: WIS save, DC 13" }).filter({ visible: true }).first();
    await live.waitFor();
    const dmRoll = live.getByRole("button", { name: /^Roll \+6 for Thorn$/ });
    // The card's own fold, never the Roll: a roll with a menu says aria-expanded too.
    if (!(await dmRoll.isVisible())) await live.locator('button[aria-expanded="false"]:not([aria-haspopup])').first().click();
    op = await pickFrom(dm, dmSent, dmRoll, fixed("the DM's live request card", /^Roll options for Roll \+6 for Thorn$/, "Roll normally", null), "right");
    assert.equal(op.rollId, second);
    assert.equal(op.unanswered, true, "the DM's roll still only lands on an unanswered row");
    await waitFor("the DM's answer", () => (dmSocket.state?.rolls[second]?.targets[0]?.total !== undefined ? true : null));
    await ops.send({ t: "roll.close", rollIds: [second] });
    await closeMenus(pat);
  });

  test("dpf1-21. the tracker: a row's Roll offers every choice, Auto Initiative and a row's Roll Initiative show Secret off and stay secret, and the rows take the totals", async () => {
    await ops.send({ t: "room.update", settings: { monsterInitScore: false } });
    await ops.send({ t: "encounter.start", entries: [{ id: "e-thorn", tokenId: run.thorn.id, value: null }, { id: "e-goblin", tokenId: run.goblin.id, value: null }, { id: "e-dragon", tokenId: run.dragon.id, value: null }] });
    await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.length === 3 ? true : null));
    try {
      const value = (entryId: string) => dmSocket.state?.encounter?.entries.find((e) => e.id === entryId)?.value ?? null;
      await openSideTab(dm, "Initiative");
      const tracker = dm.getByRole("tabpanel", { name: sideTabName("Initiative") });
      const creature = ["Roll secretly: this roll's visibility is set by the creature.", NORMAL_HELP];
      // The goblin's own Roll, beside its value box or in its options.
      const rowRoll = tracker.getByRole("button", { name: /^Roll [+−-]\d+ Initiative for Goblin$/ }).first();
      if (!(await rowRoll.isVisible())) await tracker.getByRole("button", { name: "Goblin options" }).click();
      let op = await pickFrom(dm, dmSent, rowRoll, { what: "the goblin's row Roll", button: () => rowRoll, menu: /^Roll options for Roll [+−-]\d+ Initiative for Goblin$/, items: D20, hint: HINT.d20, help: ["Roll secretly: hide the dice from players.", NORMAL_HELP], pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "dm" } }, "right");
      const line = await waitFor("the goblin's initiative line", () => dmSocket.state?.log.find((e) => e.data?.type === "dice" && e.data.tag === op.tag)?.data ?? null);
      const total = line.type === "dice" ? line.rolls[0]!.total : null;
      await waitFor(`the goblin's row set to ${total}`, () => (value("e-goblin") === total ? true : null));

      // The DM's Roll Initiative in the dragon's options, beside its modifier: fixed secret.
      const options = tracker.getByRole("button", { name: "Dragon options" });
      if ((await options.getAttribute("aria-expanded")) !== "true") await options.click();
      const rowTool = tracker.getByRole("button", { name: "Roll Initiative", exact: true }).first();
      op = await pickFrom(dm, dmSent, rowTool, { what: "the dragon's Roll Initiative", button: () => rowTool, menu: /^Roll options for Initiative$/, items: D20_FIXED, hint: HINT.fixed, help: creature, pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "dm" } }, "key");
      await waitFor("the dragon's row set", () => (value("e-dragon") !== null ? true : null));
      // Its result in Auto Initiative's card keeps the badge it always had, Dis, and says no more (D-261030-584).
      const results = tracker.getByRole("region", { name: "Auto Initiative results" });
      await results.getByText("Dis", { exact: true }).first().waitFor();

      // Auto Initiative with every monster's value set: Re-roll gives it dice to roll again, always secret.
      const reroll = tracker.getByRole("checkbox", { name: "Re-roll monsters that have a value" });
      if (!(await reroll.isChecked())) await reroll.check();
      const auto = tracker.getByRole("button", { name: /^Auto Initiative \(\d+\)/ });
      op = await pickFrom(dm, dmSent, auto, { what: "Auto Initiative", button: () => auto, menu: /^Roll options for Initiative$/, items: D20_FIXED, hint: HINT.fixed, help: creature, pick: "Roll normally", sends: { t: "dice.roll", mode: null, to: "dm" } }, "right");
      assert.ok(op.rolls!.every((r) => r.mode === undefined), "Normal on every die of the plan");
      // Normal is no news, and the tracker already says the dice are the DM's: the settled results read as before DP-F1, with no badge, "Normal" or "Secret".
      const plain = await waitFor("Auto's settled results", async () => {
        const text = (await results.innerText().catch(() => "")) ?? "";
        return /Total|\d/.test(text) && !/\bDis\b/.test(text) ? text : null;
      });
      assert.ok(!/\b(Adv|Dis|Normal|Secret)\b/.test(plain), `a plain result names no mode: ${plain}`);
      await reroll.uncheck();

      // Pat's own row on his phone: a hold, public as his rolls are.
      const pTracker = await (async () => {
        await closeMenus(pat);
        const dice = diceSheet(pat);
        if (await dice.isVisible()) await dice.getByRole("button", { name: "Close Dice" }).tap();
        await pat.getByRole("button", { name: /^Initiative, round/ }).first().tap();
        await pat.locator("[data-round-header]").first().waitFor();
        return pat.locator("[data-round-section]").first();
      })();
      const mine = pTracker.getByRole("button", { name: /^Roll [+−-]\d+ Initiative for Thorn$/ }).first();
      if (!(await mine.isVisible())) await pTracker.getByRole("button", { name: "Thorn options" }).tap();
      await pickFrom(pat, patSent, mine, { what: "Pat's row Roll", button: () => mine, menu: /^Roll options for Roll [+−-]\d+ Initiative for Thorn$/, items: D20, hint: HINT.d20, help: ["Roll secretly: you and the DM see the result.", NORMAL_HELP], pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "all" } }, "hold");
      await waitFor("Thorn's row set", () => (value("e-thorn") !== null ? true : null));
      await shots.take(pat, "dpf1-21-pat-tracker");
      await pat.keyboard.press("Escape");
    } finally {
      await ops.send({ t: "encounter.end" });
      await ops.send({ t: "room.update", settings: { monsterInitScore: true } });
    }
  });

  test("dpf1-22. HP's Death Save Roll in the DM's token window and Pat's token bar: Secret shown off for the creature, Advantage sends the death roll", async () => {
    await setDying(true);
    try {
      const death: Family = { what: "HP's Death Save Roll", button: () => dm.locator("x"), menu: /^Roll options for Death Save$/, items: D20_FIXED, hint: HINT.fixed, help: ["Roll secretly: this roll's visibility is set by the creature.", NORMAL_HELP], pick: "Roll with Advantage", sends: { t: "actor.deathRoll", mode: "adv", to: null } };
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, run.thorn);
      const bar = dm.getByRole("dialog", { name: "Thorn actions" });
      await bar.waitFor();
      await pickFrom(dm, dmSent, await barControl(bar, "Roll a Death Save"), death, "right");
      await dm.keyboard.press("Escape");
      // A natural 20 brings Thorn back with 1 HP: he goes down again, so Pat's bar has its Roll too.
      const actor = () => dmSocket.state?.characters[run.thornChar]?.actor;
      /** Thorn dying with no saves yet, whatever the last roll left: back from the dead too, which a heal is not. */
      const freshDying = async () => {
        const target = { characterId: run.thornChar };
        if (actor()?.life !== "alive") await ops.send({ t: "actor.life", target, life: "alive" });
        await ops.send({ t: "actor.hp", target, change: { kind: "set", cur: 30 } });
        await waitFor("Thorn whole", () => (actor()?.life === "alive" && actor()?.hp.cur === 30 ? true : null));
        await setDying(true);
      };
      await waitFor("the DM's death save landed", () => (actor()?.life !== "dying" || (actor()?.deathSaves?.ok ?? 0) + (actor()?.deathSaves?.fail ?? 0) > 0 ? true : null));
      if (actor()?.life !== "dying") await freshDying();

      await closeMenus(pat);
      await tapCell(pat, BOUNDS, run.thorn);
      const patBar = pat.getByRole("dialog", { name: "Thorn actions" });
      await patBar.waitFor();
      await pickFrom(pat, patSent, await barControl(patBar, "Roll a Death Save"), { ...death, sends: { ...death.sends, mode: "dis" }, pick: "Roll with Disadvantage" }, "hold");
      await shots.take(pat, "dpf1-22-pat-hp-death-save");
      await pat.keyboard.press("Escape");

      // A plain roll, a tap with no menu, reads its result alone: no mode and no stray ". ." (DPF1B-OPUS-01).
      await waitFor("Pat's death save landed", () => (actor()?.life !== "dying" || (actor()?.deathSaves?.ok ?? 0) + (actor()?.deathSaves?.fail ?? 0) > 0 ? true : null));
      if (actor()?.life !== "dying") await freshDying();
      // From no saves yet, so the earlier fails cannot add up to his death, and again if a natural 20 brings him back,
      // since HP's death save row and its result go with his dying.
      let plain: ResultLine | null = null;
      for (let tries = 0; tries < 3 && !plain; tries++) {
        await freshDying();
        await dm.keyboard.press("Escape");
        await tapCell(dm, BOUNDS, run.thorn);
        await bar.waitFor();
        const plainRoll = await barControl(bar, "Roll a Death Save");
        await middle(plainRoll);
        const from = dmSent.ops.length;
        await plainRoll.click();
        await oneRoll(dmSent, from, "a plain death save");
        const settled = await waitFor("the plain death save's words", async () => {
          if (actor()?.life !== "dying") return "revived" as const;
          const lines = await resultLines(bar);
          return lines.length === 1 && !/Advantage/.test(lines[0]!.readable) && /\d/.test(lines[0]!.readable) ? lines[0]! : null;
        });
        if (settled !== "revived") plain = settled;
      }
      assert.ok(plain, "a plain death save that left Thorn dying, in three tries");
      assert.ok(!plain.hasDetail && !/\.\s*\.|Normal|Secret/.test(plain.readable), `a plain death save reads its words alone: ${JSON.stringify(plain)}`);
      await dm.keyboard.press("Escape");
    } finally {
      // Up and whole for the tests after, from the dead too.
      const target = { characterId: run.thornChar };
      if (dmSocket.state?.characters[run.thornChar]?.actor.life === "dead") await ops.send({ t: "actor.life", target, life: "alive" });
      await ops.send({ t: "actor.hp", target, change: { kind: "set", cur: 30 } });
      await waitFor("Thorn up again", () => (dmSocket.state?.characters[run.thornChar]?.actor.life === "alive" ? true : null));
    }
  });

  test("dpf1-23. a fight's cards: Thorn's turn death save, the goblin's concentration and its save-ends each open a menu with Secret shown off, and the recharge card and Uses' recharge have none", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: "e-thorn", tokenId: run.thorn.id, value: 20 }, { id: "e-goblin", tokenId: run.goblin.id, value: 15 }, { id: "e-dragon", tokenId: run.dragon.id, value: 10 }] });
    await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.length === 3 ? true : null));
    const creature = ["Roll secretly: this roll's visibility is set by the creature.", NORMAL_HELP];
    // Taken off after: a failed save leaves the goblin Frightened, and each later end of its turn would bring a save-ends card of its own.
    const hex = randomUUID();
    const fear = randomUUID();
    const turnTo = async (entryId: string) => {
      for (let i = 0; i < 6 && dmSocket.state?.encounter?.activeEntryId !== entryId; i++) {
        const e = dmSocket.state!.encounter!;
        await ops.send({ t: "encounter.next", from: { entry: e.activeEntryId, round: e.round } });
        await waitFor("the turn moved", () => (dmSocket.state?.encounter?.activeEntryId !== e.activeEntryId || dmSocket.state?.encounter?.round !== e.round ? true : null));
      }
    };
    try {
      // Thorn dying as his turn starts: Pat's card.
      await setDying(true);
      await turnTo("e-goblin");
      await turnTo("e-thorn");
      const deathCard = pat.getByRole("group", { name: "Death save for Thorn" }).filter({ visible: true }).first();
      if (!(await deathCard.isVisible().catch(() => false))) {
        const summary = pat.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ }).first();
        if (await summary.isVisible()) await summary.tap();
      }
      await deathCard.waitFor();
      await pickFrom(pat, patSent, deathCard.getByRole("button", { name: "Roll", exact: true }), { what: "the turn's death save card", button: () => deathCard, menu: /^Roll options for Death Save for Thorn$/, items: D20_FIXED, hint: HINT.fixed, help: creature, pick: "Roll with Advantage", sends: { t: "actor.deathRoll", mode: "adv", to: null } }, "hold");
      await setDying(false);

      // The goblin concentrating, then hurt: the DM's concentration card.
      await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblin.id }, effect: { id: hex, key: "concentrating", spell: "Hex" } });
      await ops.send({ t: "actor.hp", target: { tokenId: run.goblin.id }, change: { kind: "damage", amount: 1 } });
      const conc = dm.getByRole("group", { name: "Concentration save for Goblin" }).filter({ visible: true }).first();
      await conc.waitFor();
      await pickFrom(dm, dmSent, conc.getByRole("button", { name: /^Roll [+−-]\d+$/ }), { what: "the concentration card", button: () => conc, menu: /^Roll options for Concentration save for Goblin$/, items: D20_FIXED, hint: HINT.fixed, help: creature, pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "dm" } }, "right");

      // Frightened with a save that ends it, then the goblin's turn ends: the DM's save-ends card.
      await turnTo("e-goblin");
      await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblin.id }, effect: { id: fear, key: "frightened", save: { ability: "str", dc: 14 } } });
      await turnTo("e-dragon");
      const ends = dm.locator('[data-alert-id^="saveEnds:"]').filter({ visible: true }).first();
      await ends.waitFor();
      await pickFrom(dm, dmSent, ends.getByRole("button", { name: /^Roll [+−-]\d+$/ }), { what: "the save-ends card", button: () => ends, menu: /^Roll options for Strength save, DC 14, ends it\. for Goblin$/, items: D20_FIXED, hint: HINT.fixed, help: creature, pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "dm" } }, "key");

      // The dragon's breath used: its recharge card at its turn and Uses' Roll recharge take no menu.
      await ops.send({ t: "actor.use", target: { tokenId: run.dragon.id }, use: { kind: "ability", key: "actions:acid-breath", name: "Acid Breath", limit: "recharge", max: 1, min: 5, ifReady: true } });
      await turnTo("e-thorn");
      await turnTo("e-dragon");
      const recharge = dm.getByRole("group", { name: /^Acid Breath can recharge/ }).filter({ visible: true }).first();
      await recharge.waitFor();
      await watchContextMenus(dm);
      for (const control of [recharge.getByRole("button", { name: "Roll", exact: true })]) {
        assert.equal(await control.getAttribute("aria-haspopup"), null, "a recharge card's Roll has no menu");
        assert.equal(await control.getAttribute("aria-keyshortcuts"), null);
        const from = dmSent.ops.length;
        await control.click({ button: "right" });
        await sleep(200);
        assert.equal(await dm.getByRole("menu", { name: /^Roll options/ }).count(), 0);
        await noRoll(dmSent, from, "a right-click on the recharge card's Roll");
      }
      await openSideTab(dm, "Initiative");
      const tracker = dm.getByRole("tabpanel", { name: sideTabName("Initiative") });
      const options = tracker.getByRole("button", { name: "Dragon options" });
      if ((await options.getAttribute("aria-expanded")) !== "true") await options.click();
      const uses = tracker.getByRole("button", { name: "Roll the recharge of Acid Breath, 1d6" }).first();
      await uses.waitFor();
      assert.equal(await uses.getAttribute("aria-haspopup"), null, "Uses' Roll recharge has no menu");
      assert.ok((await contextMenus(dm)).every((prevented) => !prevented), "the browser keeps its menu on recharges");
    } finally {
      await ops.send({ t: "encounter.end" });
      if (dmSocket.state?.characters[run.thornChar]?.actor.life === "dying") await setDying(false);
      // A save or a broken concentration may have ended either already.
      for (const effectId of [hex, fear]) {
        await ops.send({ t: "actor.effect.remove", target: { tokenId: run.goblin.id }, effectId }).catch((err: Error) => {
          if (!/gone|not here/.test(err.message)) throw err;
        });
      }
    }
  });

  test("dpf1-24. several selected on the DM's computer: the shared attack and its hits' damage, a save for both, the group save page's damage, and a fresh page's Roll each open a menu, a batch saying it rolls the server's dice only", async () => {
    const selectGoblins = async () => {
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, run.goblin);
      await dm.keyboard.down("Shift");
      await tapCell(dm, BOUNDS, run.goblin2);
      await dm.keyboard.up("Shift");
      await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    };
    /** The page's Discard, then the question's own Discard. */
    const discardPage = async () => {
      const panel = dmDice();
      await panel.getByRole("button", { name: "Discard", exact: true }).first().click();
      await panel.getByText(/^Discard the .*\?$/).waitFor();
      await panel.getByRole("button", { name: "Discard", exact: true }).last().click();
      await panel.getByText(/^Discard the .*\?$/).waitFor({ state: "detached" });
    };
    const buttonsOf = async (scope: Locator) => JSON.stringify(await scope.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? (e as unknown as { innerText: string }).innerText)));
    const batch = ["Roll secretly: hide the dice from players.", NORMAL_HELP, "All choices: apply to server rolls only. Players choose their own modes."];
    await selectGoblins();
    await openSideTab(dm, "Dice");
    const group = dmDice().locator('section[aria-label="Group rolls"]');
    await group.getByRole("heading", { name: /^2 selected$/ }).waitFor();

    const attack = group.getByRole("button", { name: "Scimitar for 2", exact: true });
    if (!(await attack.isVisible().catch(() => false))) {
      await shots.take(dm, "dpf1-24-no-attack");
      throw new Error(`no shared attack: ${await buttonsOf(group)}`);
    }
    await attack.locator("xpath=../..").getByLabel("Target's AC").fill("1");
    let op = await pickFrom(dm, dmSent, attack, { what: "the shared attack", button: () => attack, menu: /^Roll options for Scimitar for 2$/, items: D20, hint: HINT.d20, pick: "Roll with Disadvantage", sends: { t: "dice.roll", mode: "dis", to: "dm" } }, "key");
    assert.ok(op.rolls!.length === 2 && op.rolls!.every((r) => r.mode === "dis"), "both attacks with Disadvantage");
    // The results name Disadvantage: shown where that adds no line, else kept for screen readers alone (D-261030-584).
    const disResults = await resultLine(group, /^\d+ (hit|miss|Critical Hit)\b.*Disadvantage/);
    assert.ok(disResults.hasDetail, `the attacks' results have words for their mode: ${JSON.stringify(disResults)}`);
    assert.match(disResults.showsDetail ? disResults.shown : disResults.missing, disResults.showsDetail ? /^\d+ (hit|miss|Critical Hit) \(Disadvantage(, Secret)?\), \d+ (hit|miss|Critical Hit) \(Disadvantage(, Secret)?\)$/ : /^, Disadvantage(, Secret)?$/, `the attacks' modes, a shared one said once: ${JSON.stringify(disResults)}`);
    assert.equal(disResults.height, disResults.compactHeight, `the attacks' results add no line: ${JSON.stringify(disResults)}`);

    // Rolled secretly from the menu with the panel's Secret off, so each result names Secret, then the panel's Secret turned on,
    // which makes the word no news: the results stay in view, now without it (DPF1BUILD-ASTRA-01).
    const secret = dmDice().getByRole("group", { name: "For the next roll" }).getByRole("button", { name: /^(Hide from players|Only the DM sees it)$/ });
    const setSecret = async (on: boolean) => {
      if (((await secret.getAttribute("aria-pressed")) === "true") !== on) await secret.click();
      await waitFor(`the panel's Secret ${on ? "on" : "off"}`, async () => (((await secret.getAttribute("aria-pressed")) === "true") === on ? true : null));
    };
    await setSecret(false);
    await pickFrom(dm, dmSent, attack, { what: "the shared attack, secretly", button: () => attack, menu: /^Roll options for Scimitar for 2$/, items: D20, hint: HINT.d20, pick: "Roll secretly", sends: { t: "dice.roll", mode: null, to: "dm" } }, "right");
    const named = await resultLine(group, /^\d+ (hit|miss|Critical Hit)\b.*Secret/);
    assert.ok(named.hasDetail, `the secret results name Secret: ${JSON.stringify(named)}`);
    await setSecret(true);
    const plain = await waitFor("the results without Secret", async () => (await resultLines(group)).find((l) => !/Secret/.test(l.readable) && /\d+ (hit|miss|Critical Hit)/.test(`${l.shown}${l.readable}`)) ?? null).catch(async () => resultLines(group));
    assert.ok(!Array.isArray(plain) && plain.visible && !plain.hasDetail && /^\d+ (hit|miss|Critical Hit), \d+ (hit|miss|Critical Hit)$/.test(plain.readable), `the results stay in view with the panel's Secret on: ${JSON.stringify(plain)}`);
    const hits = group.getByRole("button", { name: /^Roll damage for \d+ hits?$/ });
    // A natural 1 misses whatever the AC, so both may miss: then there is no damage to roll.
    if (await hits.isVisible().catch(() => false)) await pickFrom(dm, dmSent, hits, { what: "the hits' damage", button: () => hits, menu: /^Roll options for Roll damage for \d+ hits?$/, items: PLAIN, hint: HINT.plain, pick: "Roll normally", sends: { t: "dice.roll", mode: null, to: "dm" } }, "right");

    op = await pickFrom(dm, dmSent, group.getByRole("button", { name: "DEX save for 2", exact: true }), { what: "a save for both", button: () => group, menu: /^Roll options for DEX save for 2$/, items: D20, hint: HINT.d20, help: batch, pick: "Roll with Advantage", sends: { t: "dice.roll", mode: "adv", to: "dm" } }, "right");
    assert.ok(op.rolls!.length === 2 && op.rolls!.every((r) => r.mode === "adv"), `both goblins' saves rolled with Advantage: ${JSON.stringify(op.rolls)}`);

    // The quick save opened its group save page: its damage.
    const panel = dmDice();
    const outcome = panel.getByRole("group", { name: "Outcome" });
    if ((await outcome.count()) === 0) await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await panel.getByLabel("Damage", { exact: true }).fill("2d6 fire");
    const damage = outcome.getByRole("button", { name: /^Roll( again)?$/ }).first();
    await pickFrom(dm, dmSent, damage, { what: "the group damage", button: () => damage, menu: /^Roll options for Group damage$/, items: PLAIN, hint: HINT.plain, pick: "Roll secretly", sends: { t: "dice.roll", mode: null, to: "dm" } }, "right");
    await shots.take(dm, "dpf1-24-group-damage");
    await discardPage();

    // A fresh page from the dragon's breath, its rows the goblins selected after it: its Roll.
    await dm.keyboard.press("Escape");
    const dragon = await dmDiceFor(run.dragon, "Dragon");
    await dragon.getByRole("button", { name: /^Group save, DC \d+ DEX$/ }).first().click();
    await panel.getByText(/^From Acid Breath: Dexterity save, DC \d+/).first().waitFor();
    await selectGoblins();
    const main = panel.getByRole("button", { name: /^Roll 2 saves$/ });
    if (!(await main.isVisible().catch(() => false))) await openSideTab(dm, "Dice");
    if (!(await main.isVisible().catch(() => false))) {
      await shots.take(dm, "dpf1-24-no-main-roll");
      throw new Error(`no Roll 2 saves: ${await buttonsOf(panel)}`);
    }
    await pickFrom(dm, dmSent, main, { what: "the group save page's Roll", button: () => main, menu: /^Roll options for Roll 2 saves$/, items: D20, hint: HINT.d20, help: batch, pick: "Roll normally", sends: { t: "dice.roll", mode: null, to: "dm" } }, "key");
    await discardPage();
    await dm.keyboard.press("Escape");
  });

  test("dpf1-25. an open menu stays open as an unrelated change lands", async () => {
    // Thorn dying: HP's Death Save menu in the DM's window stays open as another fight row changes (DPF1B-OPUS-03).
    // Its source once took in the whole fight. A request can only ask creatures players play, and Thorn is the only one here.
    try {
      await ops.send({ t: "encounter.start", entries: [{ id: "e-thorn", tokenId: run.thorn.id, value: 20 }, { id: "e-goblin", tokenId: run.goblin.id, value: 15 }] });
      await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.length === 2 ? true : null));
      await setDying(true);
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, run.thorn);
      const bar = dm.getByRole("dialog", { name: "Thorn actions" });
      await bar.waitFor();
      const death = await barControl(bar, "Roll a Death Save");
      await middle(death);
      const from = dmSent.ops.length;
      await death.click({ button: "right" });
      const deathMenu = rollMenu(dm, /^Roll options for Death Save$/);
      await deathMenu.waitFor();
      await ops.send({ t: "encounter.setValues", values: [{ entryId: "e-goblin", value: 3 }] });
      await waitFor("the goblin's new value", () => (dmSocket.state?.encounter?.entries.find((e) => e.id === "e-goblin")?.value === 3 ? true : null));
      await sleep(QUIET_MS);
      assert.ok(await deathMenu.isVisible(), "another row's value leaves the death save's menu open");
      await noRoll(dmSent, from, "the open death save menu while the fight changed");
      await dm.keyboard.press("Escape");
      await deathMenu.waitFor({ state: "detached" });
    } finally {
      if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
      if (dmSocket.state?.characters[run.thornChar]?.actor.life === "dying") await setDying(false);
    }
  });

  test("dpf1-25b. offline, either Again's open menu closes, and a plain tap on it says a roll needs a connection", async () => {
    // Said in the newest roll's line (DPF1B-OPUS-02). That line then holds the words, not the roll, so each Again has a roll of its own.
    // A menu open as the connection goes closes, since none of its picks could roll (DPF1-ASTRA-06).
    const panel = await dmDiceFor(run.thorn, "Thorn");
    const field = panel.getByLabel("Dice formula", { exact: true });
    const last = panel.locator("[data-dice-last]");
    for (const which of ["the sticky Again", "Recent rolls' Again"] as const) {
      let from = dmSent.ops.length;
      await field.fill("1d20+1 Offline");
      await field.press("Enter");
      await oneRoll(dmSent, from, `a roll for ${which}`);
      const again = which === "the sticky Again" ? last.getByRole("button", { name: "Again" }) : panel.locator("[data-dice-recent]").getByRole("button", { name: /^Roll again: 1d20\+1 Offline/ }).first();
      await again.waitFor();
      await middle(again);
      await again.click({ button: "right" });
      const againMenu = rollMenu(dm, /^Roll options for Again$/);
      await againMenu.waitFor();
      consoles.dm.expectSocketFailures = true;
      await dmContext.setOffline(true);
      try {
        await waitFor("the DM offline", async () => ((await dm.getByRole("status", { name: "Connected" }).count()) === 0 ? true : null));
        await againMenu.waitFor({ state: "detached", timeout: 3_000 }).catch(() => assert.fail(`${which}'s open menu stays open offline`));
        await middle(again);
        from = dmSent.ops.length;
        await again.click();
        await last.getByRole("alert").filter({ hasText: "Rolling needs a connection." }).waitFor({ timeout: 5_000 }).catch(() => assert.fail(`${which}'s tap offline says nothing`));
        await noRoll(dmSent, from, `${which} offline`);
      } finally {
        await dmContext.setOffline(false);
        await dm.getByRole("status", { name: "Connected" }).first().waitFor();
        consoles.dm.expectSocketFailures = false;
      }
    }
  });

  test("dpf1-26. on a phone at 390 x 844 and 320 x 568, at 100% and 130%, the death save card's and HP's settled result add no line for the mode the menu added, and a concentration card closes as it settles (D-261030-584)", async () => {
    const turnTo = async (entryId: string) => {
      for (let i = 0; i < 4 && dmSocket.state?.encounter?.activeEntryId !== entryId; i++) {
        const e = dmSocket.state!.encounter!;
        await ops.send({ t: "encounter.next", from: { entry: e.activeEntryId, round: e.round } });
        await waitFor("the turn moved", () => (dmSocket.state?.encounter?.activeEntryId !== e.activeEntryId || dmSocket.state?.encounter?.round !== e.round ? true : null));
      }
    };
    const faults: string[] = [];
    const closed = new Set<string>();
    /** Thorn up and whole again, whatever the last roll left: a natural 20 brings him back, three fails or a hit at 0 kill him. */
    const freshThorn = async () => {
      const target = { characterId: run.thornChar };
      if (dmSocket.state?.characters[run.thornChar]?.actor.life !== "alive") await ops.send({ t: "actor.life", target, life: "alive" });
      await ops.send({ t: "actor.hp", target, change: { kind: "set", cur: 30 } });
      await waitFor("Thorn whole", () => {
        const a = dmSocket.state?.characters[run.thornChar]?.actor;
        return a?.life === "alive" && a.hp.cur === 30 ? true : null;
      });
    };
    try {
      for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
        for (const scale of [1, 1.3]) {
          const at = `${size.width}x${size.height} at ${scale * 100}%`;
          const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
          try {
            // A fight of its own each time, since a turn takes one death save.
            await ops.send({ t: "encounter.start", entries: [{ id: "e-thorn", tokenId: run.thorn.id, value: 20 }, { id: "e-goblin", tokenId: run.goblin.id, value: 15 }] });
            await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.length === 2 ? true : null));
            await freshThorn();
            await context.addCookies(await patContext.cookies(server.origin));
            await context.addInitScript((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            await page.goto(`${server.origin}/r/${run.roomId}`);
            await page.getByRole("status", { name: "Connected" }).first().waitFor();
            await page.locator(".konvajs-content").first().waitFor();
            /** A card for Pat, opened from its summary where the phone folds the cards. */
            const card = async (name: string | RegExp) => {
              const found = page.getByRole("group", { name }).filter({ visible: true }).first();
              if (!(await found.isVisible().catch(() => false))) {
                const summary = page.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ }).first();
                if (await summary.isVisible().catch(() => false)) await summary.tap();
              }
              await found.waitFor();
              return found;
            };
            /** Holds `button`, picks Advantage, and checks the result `scope` settles to: the added mode is read, and shown only if it costs no line. */
            const settle = async (what: string, scope: Locator, button: Locator): Promise<"revived" | void> => {
              await middle(button);
              await hold(cdp, button);
              const menu = page.getByRole("menu", { name: /^Roll options/ });
              await menu.waitFor();
              await menu.getByRole("menuitem", { name: "Roll with Advantage" }).tap();
              await menu.waitFor({ state: "detached" });
              // A card its roll settles may close at once, with no settled result left to measure.
              const settled = await waitFor(`${at} ${what} settled`, async () => {
                const line = (await resultLines(scope)).find((l) => /Advantage/.test(l.readable));
                if (line) return line;
                // A natural 20 brings Thorn back with 1 HP, and HP's death save row goes with his dying.
                if (what === "HP's death save" && dmSocket.state?.characters[run.thornChar]?.actor.life !== "dying") return "revived" as const;
                return (await scope.isVisible().catch(() => false)) ? null : "closed";
              }).catch(async (err: Error) => {
                await shots.take(page, `dpf1-26-${what.replace(/\W+/g, "-")}-missing`);
                throw new Error(`${at} ${what}: ${err.message}, results ${JSON.stringify(await resultLines(scope).catch(() => []))}`);
              });
              if (settled === "revived") return settled;
              if (settled === "closed") {
                closed.add(what);
                return;
              }
              const line = settled;
              if (!line.hasDetail) faults.push(`${at} ${what}: no added words to fit: ${JSON.stringify(line)}`);
              else if (line.height > line.compactHeight + 1) faults.push(`${at} ${what}: the added mode adds a line: ${JSON.stringify(line)}`);
            };

            // Concentration on a Hex, broken into by damage.
            const hex = randomUUID();
            await ops.send({ t: "actor.effect.add", target: { characterId: run.thornChar }, effect: { id: hex, key: "concentrating", spell: "Hex" } });
            await ops.send({ t: "actor.hp", target: { characterId: run.thornChar }, change: { kind: "damage", amount: 1 } });
            const concentration = await card("Concentration save for Thorn");
            await settle("the concentration card", concentration, concentration.getByRole("button", { name: /^Roll [+−-]\d+/ }).first());
            // A failed save may have ended the concentration already, which the server says is gone.
            await ops.send({ t: "actor.effect.remove", target: { characterId: run.thornChar }, effectId: hex }).catch((err: Error) => {
              if (!/gone/.test(err.message)) throw err;
            });
            await ops.send({ t: "actor.hp", target: { characterId: run.thornChar }, change: { kind: "heal", amount: 1 } });

            // A save-ends card is the DM's alone and goes as its roll lands, its result a passing notice (SaveEndsCard.tsx), so it has no settled result here.
            await turnTo("e-goblin");

            // Dying as his turn starts: the death save card.
            await freshThorn();
            await setDying(true);
            await turnTo("e-thorn");
            const death = await card("Death save for Thorn");
            await settle("the death save card", death, death.getByRole("button", { name: "Roll", exact: true }));
            await setDying(false);

            // HP's Death Save in his token's bar, out of the fight, since his turn has had its death save.
            await ops.send({ t: "encounter.end" });
            await waitFor("the fight over", () => (dmSocket.state?.encounter ? null : true));
            for (let tries = 0; tries < 3; tries++) {
              await freshThorn();
              await setDying(true);
              await page.keyboard.press("Escape");
              await tapCell(page, BOUNDS, run.thorn);
              const bar = page.getByRole("dialog", { name: "Thorn actions" });
              await bar.waitFor();
              const deathRoll = await barControl(bar, "Roll a Death Save");
              if (!(await deathRoll.isVisible().catch(() => false))) {
                await shots.take(page, "dpf1-26-hp-roll-missing");
                const actorNow = dmSocket.state?.characters[run.thornChar]?.actor;
                throw new Error(`${at}: no Death Save Roll in Thorn's bar (${await bar.getAttribute("data-bar-state")}), Thorn ${actorNow?.life} at ${JSON.stringify(actorNow?.hp)}: ${await bar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? (e as unknown as { innerText: string }).innerText).join(" | "))}`);
              }
              if ((await settle("HP's death save", bar, deathRoll)) !== "revived") break;
            }
            await freshThorn();
            if (size.width === 320 && scale === 1.3) await shots.take(page, "dpf1-26-hp-320-130");
          } finally {
            await context.close();
            if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
          }
        }
      }
    } finally {
      await freshThorn();
    }
    assert.deepEqual(faults, [], "the menu's added mode words on settled results");
    // The death save card and HP keep their settled result, so those two are always measured. The concentration card goes as its roll lands.
    assert.ok(!closed.has("the death save card") && !closed.has("HP's death save"), `settled results measured: closed at once were ${[...closed].join(", ")}`);
    assert.ok(closed.has("the concentration card"), "a concentration card that stays would have its settled result measured here");
    if (closed.size) console.log(`dpf1-26: closed as their roll settled, so nothing to measure: ${[...closed].join(", ")}`);
  });

  test("dpf1-26b. on the DM's phone at 390 x 844 and 320 x 568, at 100% and 130%, a save-ends save failed with Legendary Resistance left stays on its card with its result, and the mode the menu added adds no line", async () => {
    // The dragon's Frightened ends on a Strength save it cannot make, so each roll fails, and with Legendary Resistance left
    // the card waits on Use Legendary Resistance or Accept failure (saveCards.ts landedOp), its settled result in view.
    // An op's answer comes before the DM's page hears of it, so each fight has entry ids of its own and waits for its end to land:
    // the last fight's late end can then neither pass for the next one's start nor take it away mid-turn.
    let fights = 0;
    const startFight = async () => {
      fights += 1;
      const ids = { dragon: `e-dragon-${fights}`, goblin: `e-goblin-${fights}` };
      await ops.send({ t: "encounter.start", entries: [{ id: ids.dragon, tokenId: run.dragon.id, value: 20 }, { id: ids.goblin, tokenId: run.goblin.id, value: 15 }] });
      await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.some((e) => e.id === ids.dragon) ? true : null));
      return ids;
    };
    const endFight = async () => {
      if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
      await waitFor("the fight over", () => (dmSocket.state?.encounter ? null : true));
    };
    const turnTo = async (entryId: string) => {
      for (let i = 0; i < 4; i++) {
        const e = await waitFor("a fight on the DM's page", () => dmSocket.state?.encounter ?? null);
        if (e.activeEntryId === entryId) return;
        await ops.send({ t: "encounter.next", from: { entry: e.activeEntryId, round: e.round } });
        await waitFor("the turn moved", () => (dmSocket.state?.encounter?.activeEntryId !== e.activeEntryId || dmSocket.state?.encounter?.round !== e.round ? true : null));
      }
      assert.equal(dmSocket.state?.encounter?.activeEntryId, entryId, `the turn reached ${entryId}`);
    };
    const faults: string[] = [];
    const room = new URL(dm.url()).pathname;
    await endFight();
    await ops.send({ t: "token.update", tokenId: run.dragon.id, patch: { actor: { legendary: { resistMax: 3, resistUsed: 0, actionsMax: 3, actionsUsed: 0 } } } });
    await waitFor("the dragon's Legendary Resistance", () => {
      const ref = dmSocket.state?.tokens[run.dragon.id]?.actor;
      return ref && "inline" in ref && ref.inline.legendary?.resistMax === 3 ? true : null;
    });
    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
      for (const scale of [1, 1.3]) {
        const at = `${size.width}x${size.height} at ${scale * 100}%`;
        const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
        const fear = randomUUID();
        try {
          const entries = await startFight();
          await turnTo(entries.dragon);
          await ops.send({ t: "actor.effect.add", target: { tokenId: run.dragon.id }, effect: { id: fear, key: "frightened", save: { ability: "str", dc: 30 } } });
          await context.addCookies(await dmContext.cookies(server.origin));
          await context.addInitScript((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          const phoneSent = new OpsSent();
          phoneSent.attach(page);
          await page.goto(`${server.origin}${room}`);
          await page.getByRole("status", { name: "Connected" }).first().waitFor();
          await page.locator(".konvajs-content").first().waitFor();
          // The dragon's turn ends: its save, on a card the phone may fold behind its summary.
          await turnTo(entries.goblin);
          // The dragon's own card, by name: another creature's pending save would stand first.
          const ends = page.locator('[data-alert-id^="saveEnds:"]').filter({ visible: true }).filter({ has: page.getByText("Dragon ended its turn Frightened.", { exact: true }) }).first();
          if (!(await ends.isVisible().catch(() => false))) {
            const summary = page.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ }).first();
            await summary.waitFor({ timeout: 5_000 }).catch(() => undefined);
            if (await summary.isVisible().catch(() => false)) await summary.tap();
          }
          await ends.waitFor();
          const roll = ends.getByRole("button", { name: /^Roll [+−-]\d+/ }).first();
          await middle(roll);
          const from = phoneSent.ops.length;
          await hold(cdp, roll);
          const menu = page.getByRole("menu", { name: /^Roll options for Strength save, DC 30, ends it\. for Dragon$/ });
          await menu.waitFor();
          await menu.getByRole("menuitem", { name: "Roll with Advantage" }).tap();
          await menu.waitFor({ state: "detached" });
          // The roll is sent and lands before the card is read, so a card without its result is the card's doing.
          const sent = await waitFor(`${at} the pick's roll sent`, () => phoneSent.rolls(from)[0] ?? null, 5_000);
          assert.equal(phoneSent.rolls(from).length, 1, `${at}: the pick sent one roll`);
          assert.equal(sentMode(sent).mode, "adv", `${at}: the pick rolled with Advantage`);
          await waitFor(`${at} the roll landed`, () => dmSocket.state?.log.some((e) => e.data?.type === "dice" && e.data.tag === sent.tag) || null);
          const failed = () => resultLines(ends).then((lines) => lines.find((l) => /^Rolled \d+: a fail\./.test(l.readable)) ?? null);
          await waitFor(`${at} the failed save's result`, failed).catch(async (err: Error) => {
            await shots.take(page, `dpf1-26b-${size.width}-${scale * 100}-missing`);
            throw new Error(`${at}: ${err.message}, results ${JSON.stringify(await resultLines(ends).catch(() => []))}`);
          });
          // Still pending after its roll landed: the card, its result and both choices stay.
          await sleep(QUIET_MS);
          await ends.getByRole("button", { name: /^Use Legendary Resistance \(\d+ left\)$/ }).waitFor({ timeout: 2_000 });
          await ends.getByRole("button", { name: "Accept failure", exact: true }).waitFor({ timeout: 2_000 });
          const line = await failed();
          if (!line) faults.push(`${at}: the failed save's result went from its waiting card`);
          else {
            if (!/^Rolled \d+: a fail\. Advantage\.$/.test(line.readable)) faults.push(`${at}: the result's words: ${JSON.stringify(line)}`);
            if (!line.hasDetail) faults.push(`${at}: no added words to fit: ${JSON.stringify(line)}`);
            else if (line.height > line.compactHeight + 1) faults.push(`${at}: the added mode adds a line: ${JSON.stringify(line)}`);
          }
          if (size.width === 320 && scale === 1.3) await shots.take(page, "dpf1-26b-320-130");
        } finally {
          await context.close();
          await ops.send({ t: "actor.effect.remove", target: { tokenId: run.dragon.id }, effectId: fear }).catch((err: Error) => {
            if (!/gone/.test(err.message)) throw err;
          });
          await endFight();
        }
      }
    }
    assert.deepEqual(faults, [], "a failed save's result while Legendary Resistance is left");
  });

  test("dpf1-14. on a phone at 320 x 568 and 390 x 844, at 100% and 130%, Recent rolls shows no mode word on a plain d20 row, and a cancelled row's words take no room (design 4, 6: one result location, no new wrapping)", async () => {
    const faults: string[] = [];
    for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
      for (const scale of [1, 1.3]) {
        const at = `${size.width}x${size.height} at ${scale * 100}%`;
        const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
        try {
          await context.addCookies(await dmContext.cookies(server.origin));
          await context.addInitScript((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
          await diceFoldsOpen(context);
          const page = await context.newPage();
          await page.goto(`${server.origin}/r/${run.roomId}`);
          await page.getByRole("status", { name: "Connected" }).first().waitFor();
          await page.locator(".konvajs-content").first().waitFor();
          const sheet = await openDiceSheet(page);
          const field = sheet.getByLabel("Dice formula", { exact: true });
          // A plain d20, and one whose typed Advantage and Disadvantage cancel.
          const row = (label: string) => sheet.locator("[data-dice-recent] ol > li").filter({ hasText: label }).first();
          for (const [formula, label] of [["1d20+5 Plain", "Plain"], ["1d20+5 adv dis Cancelled", "Cancelled"]] as const) {
            await field.fill(formula);
            await field.press("Enter");
            // One at a time: the field takes no second roll while the first waits on its answer.
            await row(label).waitFor();
          }
          await row("Plain").waitFor();
          await row("Cancelled").waitFor();
          const plain = await row("Plain").innerText();
          if (/\b(Normal|Advantage|Disadvantage)\b/.test(plain)) faults.push(`${at}: the plain row shows a mode word: ${plain.replace(/\s+/g, " ")}`);
          // Hide and compare: the cancelled row's words, which must be found, take no room.
          const words = await row("Cancelled").evaluate((el) => {
            type El = { getBoundingClientRect(): { width: number; height: number }; querySelectorAll(s: string): ArrayLike<El>; textContent: string | null; style: { display: string } };
            const li = el as unknown as El;
            const span = Array.from(li.querySelectorAll("span")).find((s) => s.textContent === "Normal: Advantage and Disadvantage cancelled");
            if (!span) return null;
            const box = span.getBoundingClientRect();
            const shown = li.getBoundingClientRect().height;
            span.style.display = "none";
            const hidden = li.getBoundingClientRect().height;
            span.style.display = "";
            return { width: box.width, height: box.height, shown, hidden };
          });
          if (!words) faults.push(`${at}: the cancelled row says nothing of its cancelled modes`);
          // A visually hidden box is 1 px, drawn larger by the interface size.
          else if (words.width > scale + 0.5 || words.height > scale + 0.5 || Math.abs(words.shown - words.hidden) > 1) faults.push(`${at}: the cancelled row's words take ${Math.round(words.width)} x ${Math.round(words.height)} px, the row ${Math.round(words.shown * 10) / 10} px with them and ${Math.round(words.hidden * 10) / 10} px without`);
          if (faults.some((f) => f.startsWith(at))) await shots.take(page, `dpf1-14-recent-rows-${size.width}-${scale * 100}`);
        } finally {
          await context.close();
        }
      }
    }
    assert.deepEqual(faults, [], "Recent rolls' mode words take room");
  });

  test("dpf1-27. a waiting request Roll keeps its menu open while a sibling row is answered: the DM's live card as another player answers, and Pat's Dice and card as his other creature is answered from his other device", async () => {
    // A request's revision and its other rows are bookkeeping to one row's roll, so their change leaves that roll's menu be (DPF1-ASTRA-05).
    // A player gets only their own rows, with rev 0 (shared/project.ts projectRollCtx), so another player's answer reaches Pat as nothing.
    // On his page the sibling is his own second creature, answered from his other device.
    const breeContext = await browser.newContext();
    let breeOps: OpSocket | null = null;
    let patOps: OpSocket | null = null;
    const wren = randomUUID();
    const ash = randomUUID();
    const asks: string[] = [];
    const cookieOf = async (context: BrowserContext) => (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const help = ["Roll secretly: request answers keep the request's visibility.", NORMAL_HELP];
    /** Asks a DEX save of Thorn and `sibling`, and waits until `page`'s state has it. */
    const ask = async (sibling: string, socket: SocketWatch) => {
      const id = randomUUID();
      asks.push(id);
      await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, targets: [{ characterId: run.thornChar }, { characterId: sibling }] } });
      await waitFor("the ask", () => socket.state?.rolls[id]);
      return id;
    };
    const faults: string[] = [];
    /** With `menu` open on `page`, `answer` lands on the sibling's row: the menu stays, sends nothing, and its pick answers Thorn's row once. */
    const answeredBeside = async (page: Page, sent: OpsSent, socket: SocketWatch, id: string, sibling: string, menu: Locator, family: Family, answer: () => Promise<unknown>, from: number) => {
      const before = JSON.stringify(socket.state?.rolls[id]);
      await answer();
      await waitFor(`the sibling's answer on ${family.what}'s page`, () => (socket.state?.rolls[id]?.targets.find((t) => t.characterId === sibling)?.total !== undefined ? true : null));
      assert.notEqual(JSON.stringify(socket.state?.rolls[id]), before, "the answer changed the request the menu came from");
      await sleep(QUIET_MS);
      await noRoll(sent, from, `${family.what}'s open menu while a sibling was answered`);
      // Noted and closed, so the surfaces after it are still tried.
      if (!(await menu.isVisible())) {
        faults.push(`${family.what}: a sibling's answer closed the menu, focus now on ${await focusedName(page)}`);
        await ops.send({ t: "roll.close", rollIds: [id] });
        await waitFor("the request closed", () => (dmSocket.state?.rolls[id] ? null : true));
        return;
      }
      await menu.getByRole("menuitem", { name: family.pick }).click();
      const op = await oneRoll(sent, from, `${family.pick} on ${family.what}`);
      assert.deepEqual(sentMode(op), { cancelled: false, ...family.sends }, `${family.what}: ${family.pick}`);
      assert.equal(op.rollId, id);
      await waitFor("Thorn's answer", () => (dmSocket.state?.rolls[id]?.targets.find((t) => t.characterId === run.thornChar)?.total !== undefined ? true : null));
      await menu.waitFor({ state: "detached" });
      await ops.send({ t: "roll.close", rollIds: [id] });
      await waitFor("the request closed", () => (dmSocket.state?.rolls[id] ? null : true));
    };
    try {
      const breeId = await join(breeContext, "Bree", "#3e63dd");
      breeOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(breeContext) });
      patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(patContext) });
      await ops.send({ t: "character.create", character: { id: wren, name: "Wren", size: "medium", ownerIds: [breeId], actor: actor(), level: 3, stats: THORN_STATS } });
      await ops.send({ t: "character.create", character: { id: ash, name: "Ash", size: "medium", ownerIds: [run.patId], actor: actor(), level: 3, stats: THORN_STATS } });
      await waitFor("Ash on Pat's page", () => patSocket.state?.characters[ash]);

      // The DM's live card: Thorn's row still waits as Bree answers Wren's.
      let id = await ask(wren, dmSocket);
      const live = dm.getByRole("group", { name: /^Roll request: DEX save/ }).filter({ visible: true }).first();
      await live.waitFor();
      const dmRoll = live.getByRole("button", { name: /^Roll \+1 for Thorn$/ });
      // The card's own fold, never the Roll: a roll with a menu says aria-expanded too.
      if (!(await dmRoll.isVisible())) await live.locator('button[aria-expanded="false"]:not([aria-haspopup])').first().click();
      const dmFamily: Family = { what: "the DM's live request card", button: () => dmRoll, menu: /^Roll options for Roll \+1 for Thorn$/, items: D20_FIXED, hint: HINT.fixed, help, pick: "Roll normally", sends: { t: "roll.dice", mode: null, to: null } };
      await middle(dmRoll);
      let from = dmSent.ops.length;
      await dmRoll.click({ button: "right" });
      let menu = await opened(dm, dmRoll, dmFamily);
      await answeredBeside(dm, dmSent, dmSocket, id, wren, menu, dmFamily, () => breeOps!.send({ t: "roll.dice", tag: randomUUID(), rollId: id, target: { characterId: wren } }), from);

      // Pat's Dice and his card: Ash's row answered from his other device.
      for (const where of ["Dice", "card"] as const) {
        id = await ask(ash, patSocket);
        let button: Locator;
        let family: Family;
        if (where === "Dice") {
          // Ash gives Pat a tab per creature.
          const sheet = await openDiceSheet(pat);
          await sheet.getByRole("tab", { name: /Thorn$/ }).first().click();
          await sheet.getByRole("region", { name: "Rolls for Thorn" }).waitFor();
          button = sheet.getByRole("button", { name: /^Dexterity save, answers the DM's request/ });
          family = { what: "Pat's answer in Dice", button: () => button, menu: /^Roll options for Dexterity save, answers the DM's request/, items: D20_FIXED, hint: HINT.fixed, help, pick: "Roll with Advantage", sends: { t: "roll.dice", mode: "adv", to: null } };
        } else {
          await closeMenus(pat);
          const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
          if (!(await card.isVisible())) await pat.getByRole("button", { name: /^Roll asked/ }).first().tap();
          button = card.getByRole("button", { name: "Roll +1 for Thorn", exact: true });
          family = { what: "Pat's request card", button: () => button, menu: /^Roll options for Roll \+1 for Thorn$/, items: D20_FIXED, hint: HINT.fixed, help, pick: "Roll with Disadvantage", sends: { t: "roll.dice", mode: "dis", to: null } };
        }
        await button.waitFor();
        await middle(button);
        from = patSent.ops.length;
        await hold(patCdp, button);
        menu = await opened(pat, button, family);
        const answerId = id;
        await answeredBeside(pat, patSent, patSocket, answerId, ash, menu, family, () => patOps!.send({ t: "roll.dice", tag: randomUUID(), rollId: answerId, target: { characterId: ash } }), from);
      }
    } finally {
      const open = asks.filter((id) => dmSocket.state?.rolls[id]);
      if (open.length) await ops.send({ t: "roll.close", rollIds: open });
      for (const character of [wren, ash]) if (dmSocket.state?.characters[character]) await ops.send({ t: "character.delete", characterId: character });
      breeOps?.close();
      patOps?.close();
      await breeContext.close();
      await closeMenus(pat);
    }
    assert.deepEqual(faults, [], "open menus beside a sibling's answer");
  });

  test("fu41-b-escape. Escape closes a focused or pointer-opened menu before an expanded toast", async () => {
    if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.thorn.id, value: 20 }, { id: randomUUID(), tokenId: run.goblin.id, value: 5 }] });
    await ops.send({ t: "encounter.next" });
    let whisperer: OpSocket | null = null;
    try {
      const dmId = await waitFor("the DM member", () => dmSocket.you?.memberId ?? null);
      const cookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      whisperer = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
      await dm.setViewportSize({ width: 320, height: 440 });
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem("rvtt.uiScale", "1.3"));
      await dm.goto(`${server.origin}/r/${run.roomId}`);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await dm.locator(".konvajs-content").first().waitFor();
      await pickTool(dm, "Select");
      await tapCell(dm, BOUNDS, run.thorn);
      await dm.getByRole("dialog", { name: "Thorn actions" }).waitFor();
      for (const { toastFirst, pointer } of [{ toastFirst: true, pointer: false }, { toastFirst: false, pointer: false }, { toastFirst: true, pointer: true }]) {
        const text = `FU41 Escape ${pointer ? "pointer" : toastFirst ? "toast first" : "menu first"}.`;
        await whisperer.send({ t: "log.whisper", to: [dmId], text });
        const row = dm.locator('[data-toast-form="row"]').filter({ hasText: text });
        const whole = dm.locator('[data-toast-form="whole"]').filter({ hasText: text });
        await row.waitFor();
        if (toastFirst) {
          await row.getByRole("button").first().click();
          await whole.waitFor();
        }
        // A player has no toolbar menu here. The DM's grouped toolbar always offers Setup tools.
        const opener = dm.getByRole("navigation", { name: "Tools", exact: true }).getByRole("button", { name: "Setup tools", exact: true });
        if (pointer) await opener.click();
        else {
          await opener.focus();
          await opener.press("Enter");
        }
        const menu = dm.getByRole("menu", { name: "Setup tools", exact: true });
        await menu.waitFor();
        if (!toastFirst) {
          // A native click without a pointerdown keeps the menu open while installing the toast's later listener.
          await row.getByRole("button").first().dispatchEvent("click");
          await whole.waitFor();
        }
        if (pointer) assert.ok(await opener.evaluate((button) => button === button.ownerDocument.activeElement), "a pointer open leaves focus on the anchor");
        else await menu.getByRole("menuitemradio").first().focus();
        await dm.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        assert.equal(await whole.count(), 1, "the menu's Escape leaves the expanded toast alone");
        await dm.keyboard.press("Escape");
        await whole.waitFor({ state: "detached" });
        await row.waitFor();
      }
    } finally {
      whisperer?.close();
      await ops.send({ t: "encounter.end" });
      await dm.setViewportSize(COMPUTER);
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem("rvtt.uiScale", "1"));
      await dm.goto(`${server.origin}/r/${run.roomId}`);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    }
  });

  test("dpf1-13. nothing went wrong in the browsers", () => {
    for (const c of Object.values(consoles)) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
