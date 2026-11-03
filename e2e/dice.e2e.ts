import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { FORMULA_ERRORS } from "#shared/dice/formula.ts";
import { keptD20 } from "#shared/dice/roll.ts";
import type { DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import { barControl, ConsoleWatch, diceFoldsOpen, OpSocket, openSideTab, reopenRoom, Shots, sideTabName, sleep, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { alignmentLines, containmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Dice on the server (docs/design/design-v1-dice.md 13), on the real server serving
 * the production build: a player rolls 2d6+3 on a phone and the DM's
 * computer shows the same dice, as a toast while its Dice panel is closed,
 * a DM's free formula starts in the open and, hidden with one tap, reads
 * "rolled in secret" for the player, a roll
 * survives a reload, Enter and Up in the field, Advantage taken by one tap
 * and pressed again before it lands, at 375 x 667 at 100% and 130% the
 * sticky line, the field and the choices in view, Dice in the bottom
 * one of two panels, rolling there and counting as on screen, and a roll
 * of 100 dice keeping the sticky line to one line on a phone, and Roll
 * waiting in the DM's view as a player. Then Pat's Thorn with a stat block
 * (docs/design/design-v1-dice-ui.md): a weapon row's controls on one line at
 * 390 px, a result in the header line and never in its row, a save
 * spell's DC in its row, the header line inside its column at 100% and
 * 130%, and an answer's line with no Again. Last, the two faults the
 * project owner met on an iPhone: a roll option's words run past its
 * button (the Aboleth's group save), and the header line cut through a
 * die (a long critical damage with three riders), each at 390 x 844 at
 * 100% and 130%, and the header line at 320 x 568 at 130% as well.
 *
 * Then the roll animation (docs/design/design-v1-roll-animation.md 10), its steps
 * labeled `ra-`: Pat's own roll throws dice that land on the result, and
 * reduced motion, no WebGL, Low power, the switch, a tap during a throw,
 * the tracker's Roll, a secret roll, the DM's toast of Pat's attack, a
 * small phone and a roll still in the air as its sheet closes, by a tap or
 * by Escape, each do as the design says. The browser draws WebGL in
 * software (SwiftShader), as CI has no GPU, and the steps that measure the
 * header line do so once the dice have gone.
 *
 * Last, the roll header on the token screen
 * (docs/design/design-v1-token-roll-header.md 8), its steps labeled `trh-`:
 * a stat block roll puts the Dice panel's line at the top of a character's
 * page or a token's panel with nothing moving, and throws its dice from the
 * box in that panel's own tray, at 390 x 844, in a phone sheet that grows,
 * at 320 x 568 at 130% and on a computer. Then the Dice panel beside it,
 * taps, another token and Hide during a throw, a second roll, a fold, a
 * close and another page, reduced motion and the fallbacks, a keyboard pick
 * and Tab under the line, and an unknown result's words in the line's row.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty, one file after
 * another as the others. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 20;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-dice-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 375, height: 667 };

/** The dice land this long after the answer (client/features/dice/throw/store.ts). */
const LAND_MS = 1000;

/** WebGL drawn in software, so the dice throw on a CI runner, which has no GPU. */
const WEBGL_ARGS = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"];

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = { roomId: "", roomName: `E2E dice ${new Date().toISOString().slice(0, 19)}`, password: "", patId: "", dmId: "", thornId: randomUUID() };
let ops: OpSocket | undefined;

const THORN_ACTOR = { hp: { cur: 44, max: 44, temp: 0 }, life: "alive", ac: 18, speeds: { walk: 30 }, initBonus: 0, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

/** Level 5, so +3 proficiency: Longsword +6 to hit, and a spell save DC of 14 from Charisma 16. */
const THORN_STATS = {
  abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 12, cha: 16 },
  saves: ["wis", "cha"],
  skills: {},
  spellAbility: "cha",
  adjust: {},
  defenses: {},
  rolls: [
    {
      id: "r-longsword",
      name: "Longsword",
      kind: "weapon",
      ability: "str",
      attack: { prof: true, bonus: 0 },
      dice: [
        { formula: "1d8", type: "slashing", mod: true },
        { formula: "2d8", type: "radiant", optional: true, name: "Divine Smite" },
      ],
    },
    { id: "r-flame", name: "Sacred Flame", kind: "spell", ability: "spell", level: 0, save: { ability: "dex" }, dice: [{ formula: "1d8", type: "radiant", grows: true }] },
    { id: "r-hold", name: "Hold Person", kind: "spell", ability: "spell", level: 2, save: { ability: "wis" }, dice: [] },
  ],
};

type DiceLine = Extract<LogEvent, { type: "dice" }>;

function diceLines(log: readonly LogEntry[] | undefined): { id: string; data: DiceLine }[] {
  return (log ?? []).flatMap((e) => (e.data?.type === "dice" ? [{ id: e.id, data: e.data }] : []));
}

/** Opens the Dice panel on a phone: the Panels button, then Dice. */
async function openDicePhone(page: Page): Promise<void> {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
  if (await sheet.isVisible()) return;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Dice/ }).tap();
  await sheet.waitFor();
}

function field(page: Page | Locator) {
  return page.getByLabel("Dice formula", { exact: true });
}

/** Types a roll and sends it with Enter, then waits for this page's newest dice line to be a new one. */
async function rollWithEnter(page: Page, watch: SocketWatch, text: string): Promise<DiceLine> {
  const before = diceLines(watch.state?.log).length;
  await field(page).fill(text);
  await field(page).press("Enter");
  const line = await waitFor(`the line of ${text}`, () => {
    const lines = diceLines(watch.state?.log);
    return lines.length > before ? lines.at(-1)!.data : null;
  });
  return line;
}

/** Flame Tongue's long name and three riders: a critical hit with all three makes the longest header line a weapon can. */
const LONG_WEAPON = {
  id: "r-dawn",
  name: "Flame Tongue Greatsword of the Burning Dawn",
  kind: "weapon",
  ability: "str",
  attack: { prof: true, bonus: 1 },
  dice: [
    { formula: "2d6", type: "slashing", mod: true },
    { formula: "2d6", type: "fire", optional: true, name: "Flame Tongue" },
    { formula: "2d8", type: "radiant", optional: true, name: "Divine Smite" },
    { formula: "1d6", type: "force", optional: true, name: "Hunter's Mark" },
  ],
};

/**
 * What runs past its box in the roll options: a button whose words are
 * wider than it, a part of a button outside it, or a button outside the
 * options' column. Empty when nothing does.
 */
function overflowing(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    type Box = { left: number; right: number; width: number };
    type El = { getBoundingClientRect(): Box; scrollWidth: number; clientWidth: number; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null; textContent: string | null };
    const column = (root as unknown as El).getBoundingClientRect();
    const out: string[] = [];
    for (const button of Array.from((root as unknown as El).querySelectorAll("button"))) {
      const box = button.getBoundingClientRect();
      if (box.width === 0) continue;
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      if (button.scrollWidth > button.clientWidth + 1) out.push(`${name}: its words are ${button.scrollWidth} px in ${button.clientWidth}`);
      if (box.left < column.left - 1 || box.right > column.right + 1) out.push(`${name}: outside the column`);
      for (const part of Array.from(button.querySelectorAll("span"))) {
        const r = part.getBoundingClientRect();
        if (r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1)) out.push(`${name}: "${part.textContent}" outside its button`);
      }
    }
    return out;
  });
}

/**
 * The header line's faults. Each piece of words or die is judged by every
 * box above it that clips: it shows whole, or it is gone whole, never cut
 * through. Words may also end in their own "…" (the label). A die gone
 * needs a whole "+N" for it while the label shows, as the label goes
 * before it (Roller.tsx ResultRest), and each of `keep` must show whole.
 * Empty when it holds.
 */
function headerFaults(line: Locator, keep: string[]): Promise<string[]> {
  return line.evaluate((root, keep) => {
    type Box = { left: number; right: number; top: number; bottom: number; width: number };
    type El = {
      getBoundingClientRect(): Box;
      scrollWidth: number;
      clientWidth: number;
      parentElement: El | null;
      childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
      textContent: string | null;
      closest(s: string): El | null;
      matches(s: string): boolean;
      querySelectorAll(s: string): ArrayLike<El>;
      ownerDocument: { defaultView: { getComputedStyle(e: El): { overflowX: string; textOverflow: string } } };
    };
    const r = root as unknown as El;
    const style = (el: El) => el.ownerDocument.defaultView.getComputedStyle(el);
    const seen = (el: El): "whole" | "gone" | "cut" => {
      const b = el.getBoundingClientRect();
      let whole = true;
      for (let p = el.parentElement; p && p !== r.parentElement; p = p.parentElement) {
        if (style(p).overflowX === "visible") continue;
        const c = p.getBoundingClientRect();
        if (b.right <= c.left + 0.5 || b.left >= c.right - 0.5 || b.bottom <= c.top + 0.5 || b.top >= c.bottom - 0.5) return "gone";
        if (b.left < c.left - 0.5 || b.right > c.right + 0.5 || b.top < c.top - 0.5 || b.bottom > c.bottom + 0.5) whole = false;
      }
      return whole ? "whole" : "cut";
    };
    const out: string[] = [];
    const shown = new Set<string>();
    let gone = 0;
    let label = false;
    for (const el of Array.from(r.querySelectorAll("*"))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      // A screen reader's words, drawn 1 px square, are not on the line.
      if (own === "" || el.closest('[role="status"]') || el.getBoundingClientRect().width < 2) continue;
      const words = (el.textContent ?? "").trim();
      const v = seen(el);
      if (v === "cut") out.push(`"${words}" is cut through`);
      if (v === "whole" && el.scrollWidth > el.clientWidth + 1 && style(el).textOverflow !== "ellipsis") out.push(`"${words}" runs past its own box`);
      if (v === "whole") shown.add(words);
      if (v === "whole" && style(el).textOverflow === "ellipsis") label = true;
      if (v === "gone" && el.matches("[data-face]")) gone++;
    }
    if (gone > 0 && label && !shown.has(`+${gone}`)) out.push(`${gone} dice are gone with no whole "+${gone}"`);
    for (const words of keep) if (!shown.has(words)) out.push(`"${words}" does not show whole`);
    return out;
  }, keep);
}

/** Thorn's roll options in the phone's Dice sheet. */
function thornRolls(page: Page): Locator {
  return page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]').getByRole("region", { name: "Rolls for Thorn" });
}

/** A named roll's row, from one of its controls: the header line, then the controls line. */
function namedRow(control: Locator): Locator {
  return control.locator("xpath=../..");
}

/** Whether a box lies whole inside the window. */
async function inView(page: Page, selector: string): Promise<boolean> {
  const box = await page.locator(selector).first().boundingBox();
  const viewport = page.viewportSize();
  return box !== null && viewport !== null && box.y >= 0 && box.x >= 0 && box.y + box.height <= viewport.height && box.x + box.width <= viewport.width;
}

/** Runs code in the page and hands back what it returns. */
function js<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(() => { ${body} })()`) as Promise<T>;
}

/** Rolls with Enter, as `rollWithEnter`, and hands back the new line with its log id. */
async function rollLine(page: Page, watch: SocketWatch, text: string): Promise<{ id: string; data: DiceLine }> {
  const before = diceLines(watch.state?.log).length;
  await field(page).fill(text);
  await field(page).press("Enter");
  return waitFor(`the line of ${text}`, () => diceLines(watch.state?.log).slice(before).at(-1) ?? null);
}

/**
 * Whether this browser can draw the dice, with the stage's own demand of a
 * context that is not a slow fallback. A step that needs the dice fails
 * without them when CI is set, as CI launches with WEBGL_ARGS, and skips
 * on a machine that cannot.
 */
async function needsWebGL(page: Page, t: TestContext): Promise<boolean> {
  const ok = await js<boolean>(page, `return document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true }) !== null;`);
  if (ok) return true;
  assert.ok(!process.env.CI, "no WebGL2 on the CI runner, so the dice cannot be tested");
  t.skip("this browser has no WebGL2 to draw the dice");
  return false;
}

/** What `watchThrow` saw, in the page's milliseconds. */
type Watched = { canvasAt: number | null; totalAtCanvas: boolean | null; totalAt: number | null; downAt: number | null; newRowAt: number | null };

/**
 * Watches the page from now on, at every change to its DOM: when the
 * stage's canvas first shows and whether the header line held a total
 * then, when the header line shows a total again after the tap cleared it,
 * when the last pointer went down, and when a Recent rolls row first
 * appears that was not there before.
 */
function watchThrow(page: Page): Promise<void> {
  return js(
    page,
    `
    const rows = () => [...document.querySelectorAll("[data-roll-row]")].map((r) => r.getAttribute("data-roll-row"));
    const known = new Set(rows());
    const w = { canvasAt: null, totalAtCanvas: null, totalAt: null, downAt: null, newRowAt: null, cleared: false };
    globalThis.__raWatch?.stop();
    const total = () => document.querySelector('[data-dice-last] [aria-label="Show this roll in Recent rolls"]') !== null;
    const look = () => {
      const now = performance.now();
      const t = total();
      if (!t) w.cleared = true;
      if (w.canvasAt === null && [...document.querySelectorAll("[data-dice-stage]")].some((c) => c.style.display === "block")) {
        w.canvasAt = now;
        w.totalAtCanvas = t;
      }
      if (w.cleared && t && w.totalAt === null) w.totalAt = now;
      if (w.newRowAt === null && rows().some((r) => !known.has(r))) w.newRowAt = now;
    };
    const observer = new MutationObserver(look);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const down = () => { w.downAt = performance.now(); };
    document.addEventListener("pointerdown", down, true);
    globalThis.__raWatch = { w, stop: () => { observer.disconnect(); document.removeEventListener("pointerdown", down, true); } };
    `,
  );
}

function watched(page: Page): Promise<Watched> {
  return js<Watched>(page, `return globalThis.__raWatch.w;`);
}

/** Waits until `watchThrow` has seen what `ready` asks for, and hands back all it saw. */
function seen(page: Page, what: string, ready: (w: Watched) => boolean): Promise<Watched> {
  return waitFor(what, async () => {
    const w = await watched(page);
    return ready(w) ? w : null;
  });
}

/** The stage's canvas as its test hook reads it: whether it shows, its frames drawn, the faces it landed on, and its sizes. */
type StageHook = { shown: boolean; frames: string | null; landed: string | null; width: number; cssWidth: number; zoom: number; ratio: number };

function stageHook(page: Page): Promise<StageHook | null> {
  return js<StageHook | null>(
    page,
    `
    const c = document.querySelector("[data-dice-stage]");
    if (!c) return null;
    return { shown: c.style.display === "block", frames: c.dataset.frames ?? null, landed: c.dataset.landed ?? null, width: c.width, cssWidth: parseFloat(c.style.width) || 0, zoom: c.currentCSSZoom ?? 1, ratio: Math.min(devicePixelRatio || 1, 2) };
    `,
  );
}

/**
 * The face the stage's die landed on, once it has drawn its landing frame.
 * The result shows on a 1 s timer and the stage reads its landing on the
 * first animation frame past 1 s, which a slow frame can bring well after
 * the total (TRH1-FLAKE), so a read at the total can find nothing yet.
 */
function landedFace(page: Page): Promise<string> {
  return waitFor("the die's landing frame", async () => (await stageHook(page))?.landed ?? null, 3_000);
}

/**
 * Waits out a throw: its total in the header line, and the dice and their
 * scrim gone, so the header line is measured or pictured as it stays.
 */
async function settled(page: Page): Promise<void> {
  await waitFor("the throw to end", () =>
    js<boolean>(
      page,
      `
      const lines = [...document.querySelectorAll("[data-dice-last]")];
      const landed = lines.every((l) => l.querySelector('[aria-label="Show this roll in Recent rolls"]') !== null);
      const gone = [...document.querySelectorAll("[data-dice-tray]")].every((t) => t.childElementCount === 1) && [...document.querySelectorAll("[data-dice-stage]")].every((c) => c.style.display !== "block");
      return (landed && gone) || null;
      `,
    ),
  );
}

/**
 * Waits for the dice on a room just opened. Their chunk loads in the
 * background and warms up in a quiet moment, and a roll before then shows
 * its total at once, so this rolls a d20 until one throws.
 */
async function diceReady(page: Page, socket: SocketWatch): Promise<void> {
  await waitFor(
    "the dice ready",
    async () => {
      await watchThrow(page);
      await rollWithEnter(page, socket, "1d20 warm-up");
      const w = await seen(page, "the warm-up's total", (w) => w.totalAt !== null);
      await settled(page);
      if (w.canvasAt !== null) return true;
      await page.waitForTimeout(500);
      return null;
    },
    30_000,
  );
}

/** How far the nearest scroller around `selector` scrolls sideways: 0 when it never does. */
function sideways(page: Page, selector: string): Promise<number> {
  return js<number>(
    page,
    `
    let el = document.querySelector(${JSON.stringify(selector)});
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    return el ? el.scrollWidth - el.clientWidth : -1;
    `,
  );
}

/** A roll's one-roll menu (docs/design/design-v1-roll-mode-menu.md 3.3), by its source's name. */
function rollMenu(page: Page, name: RegExp): Locator {
  return page.getByRole("menu", { name });
}

/**
 * Brings `button` to its scroller's middle and focuses it, once the scroll
 * has settled, so no scroll moves the source under its menu (3.3).
 */
async function focusStill(button: Locator): Promise<void> {
  await button.evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "center" }));
  let last = "";
  await waitFor("the scroll to settle", async () => {
    await sleep(120);
    const box = JSON.stringify(await button.boundingBox());
    const still = box === last;
    last = box;
    return still || null;
  });
  await button.evaluate((el) => (el as unknown as { focus(o: object): void }).focus({ preventScroll: true }));
}

/** Opens `button`'s one-roll menu by its ContextMenu key and picks `pick`, then hands back the dice line that lands. */
async function menuRoll(page: Page, watch: SocketWatch, button: Locator, menu: RegExp, pick: string): Promise<DiceLine> {
  const before = diceLines(watch.state?.log).length;
  await focusStill(button);
  await page.keyboard.press("ContextMenu");
  await rollMenu(page, menu).getByRole("menuitem", { name: pick }).click();
  return waitFor(`the line of ${pick}`, () => diceLines(watch.state?.log).slice(before).at(-1)?.data ?? null);
}

/** Where the panel's own Adv, Dis and Secret stand, which a menu pick never changes. */
async function panelModes(page: Page): Promise<{ adv: boolean; dis: boolean; secret: boolean }> {
  const group = page.getByRole("group", { name: "For the next roll" }).filter({ visible: true });
  const pressed = async (name: RegExp) => (await group.getByRole("button", { name }).getAttribute("aria-pressed")) === "true";
  return { adv: await pressed(/^Advantage$/), dis: await pressed(/^Disadvantage$/), secret: await pressed(/^(Hide from players|Only the DM sees it)$/) };
}

async function setPanelModes(page: Page, want: { adv: boolean; secret: boolean }): Promise<void> {
  const group = page.getByRole("group", { name: "For the next roll" }).filter({ visible: true });
  const now = await panelModes(page);
  if (now.adv !== want.adv) await group.getByRole("button", { name: "Advantage", exact: true }).click();
  if (now.secret !== want.secret) await group.getByRole("button", { name: /^(Hide from players|Only the DM sees it)$/ }).click();
  await waitFor("the panel's modes", async () => {
    const m = await panelModes(page);
    return m.adv === want.adv && m.secret === want.secret ? true : null;
  });
}

/** What the sticky line's result says beside its total: the mode the server rolled, and Secret (rollMode.ts effectiveRollMode). */
async function resultWords(page: Page): Promise<string | null> {
  const result = page.locator('[data-dice-last] [aria-label="Show this roll in Recent rolls"]').filter({ visible: true });
  await result.waitFor();
  return result.getAttribute("aria-description");
}

/**
 * The roll header on the token screen (docs/design/design-v1-token-roll-header.md 8),
 * its steps labeled `trh-`: the panel's room, a monster of its own with
 * nothing but its six abilities, so its panel is short, and a second
 * character for Pat.
 */
const trh = {
  vexId: randomUUID(),
  sprite: { monster: randomUUID(), token: randomUUID(), at: { x: 12, y: 2 } },
  bramble: { token: randomUUID(), at: { x: 15, y: 2 } },
};

/** A room monster with a stat block and no lines under its six abilities, so its token's panel is short. */
const SPRITE_BLOCK = {
  size: "small", type: "Fey", alignment: "Neutral", ac: 12, initiative: 0, hp: { average: 7, formula: "2d6" }, speed: "30 ft.",
  abilities: { str: { score: 8, save: -1 }, dex: { score: 14, save: 2 }, con: { score: 10, save: 0 }, int: { score: 10, save: 0 }, wis: { score: 10, save: 0 }, cha: { score: 10, save: 0 } },
  skills: "", vulnerabilities: "", resistances: "", immunities: "", gear: "", senses: "", passivePerception: 10, languages: "", cr: "0", xp: 10,
  traits: [], actions: [], bonusActions: [], reactions: [], legendaryActions: [],
};

/** The token panel's groups folded and its stat block open, for the DM's own creatures (client/features/tokens/panelFolds.ts). */
const SHORT_PANEL = JSON.stringify({ statBlock: true, combat: false, notes: false, position: false, image: false, stats: false, settings: false });

/** What `watchHeader` saw from its start, in the page's milliseconds and screen px. */
type HeaderWatched = {
  /** When the host first held a header line. */
  lineAt: number | null;
  /** When a dice canvas first showed, where it hung ("own" for this host's tray), and whether the header showed a total then. */
  canvasAt: number | null;
  canvasIn: string | null;
  totalAtCanvas: boolean | null;
  /** When that canvas stopped showing. */
  canvasGoneAt: number | null;
  /** When the header showed a total after a moment without one. */
  totalAt: number | null;
  /** How far the watched box's top strayed from where it stood at the start, at every frame and change. */
  maxDrift: number;
  /** Whether the host set its scroller's `overflow-anchor` to `none` and took it off again. */
  anchorOff: boolean;
  /** Whether a scrim or ring showed in this host's tray, and in any other. */
  ownDecor: boolean;
  foreignDecor: boolean;
  top0: number;
  scrollTop0: number;
};

/**
 * Watches the host of `box`, the ability box a roll goes from, at every
 * frame and every change to the page's DOM, until the next watch: the
 * header line, the dice and where they hang, the box's place, and the
 * scroller's inline `overflow-anchor`.
 */
async function watchHeader(box: Locator): Promise<void> {
  await box.evaluate((el) => {
    (globalThis as unknown as { __trhBox: unknown }).__trhBox = el;
  });
  await js(
    box.page(),
    `
    const box = globalThis.__trhBox;
    globalThis.__trh?.stop();
    const scroller = box.closest("[data-pane-body]");
    const host = box.closest("[data-block-header-host]");
    const w = { lineAt: null, canvasAt: null, canvasIn: null, totalAtCanvas: null, canvasGoneAt: null, totalAt: null, maxDrift: 0, anchorOff: false, ownDecor: false, foreignDecor: false, top0: box.getBoundingClientRect().top, scrollTop0: scroller.scrollTop, cleared: false };
    const total = () => /^\\d/.test((host.querySelector("[data-block-header-row]")?.textContent ?? "").trim());
    const look = () => {
      const now = performance.now();
      if (box.isConnected) w.maxDrift = Math.max(w.maxDrift, Math.abs(box.getBoundingClientRect().top - w.top0));
      if (w.lineAt === null && host.querySelector("[data-block-header]")) w.lineAt = now;
      const t = total();
      if (!t) w.cleared = true;
      const stage = [...document.querySelectorAll("[data-dice-stage]")].find((c) => c.style.display === "block");
      if (stage && w.canvasAt === null) {
        w.canvasAt = now;
        w.totalAtCanvas = t;
        w.canvasIn = host.contains(stage) ? "own" : stage.closest("[data-block-header]") ? "another header" : stage.closest("[data-dice-last]") ? "dice" : "elsewhere";
      }
      if (!stage && w.canvasAt !== null && w.canvasGoneAt === null) w.canvasGoneAt = now;
      for (const tray of document.querySelectorAll("[data-dice-tray]")) {
        if (tray.childElementCount < 2) continue;
        if (host.contains(tray)) w.ownDecor = true;
        else w.foreignDecor = true;
      }
      if (w.cleared && t && w.totalAt === null) w.totalAt = now;
    };
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.target === scroller && r.attributeName === "style" && /overflow-anchor: none/.test(r.oldValue ?? "")) w.anchorOff = true;
      look();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
    let frame = 0;
    const tick = () => {
      look();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    globalThis.__trh = { w, stop: () => { observer.disconnect(); cancelAnimationFrame(frame); } };
    `,
  );
}

function headerWatched(page: Page): Promise<HeaderWatched> {
  return js<HeaderWatched>(page, `return globalThis.__trh.w;`);
}

/** Waits until `watchHeader` has seen what `ready` asks for, and hands back all it saw. */
function headerSeen(page: Page, what: string, ready: (w: HeaderWatched) => boolean, timeoutMs = 15_000): Promise<HeaderWatched> {
  return waitFor(
    what,
    async () => {
      const w = await headerWatched(page);
      return ready(w) ? w : null;
    },
    timeoutMs,
  );
}

/** The dice in the air: a canvas showing and the header with no total yet. */
const midThrow = (w: HeaderWatched) => w.canvasAt !== null && w.totalAt === null;

/** What a live region said, and whose region it was: a roll header's, the Dice panel's line, the toasts' or another. */
type Heard = { region: "header" | "dice" | "toast" | "other"; text: string };

/**
 * Records, from now on, every new text in the page's live regions (polite,
 * status and alert), as a screen reader would hear them, until the next
 * call. A region that empties and fills again with the same words counts
 * twice.
 */
function listenLive(page: Page): Promise<void> {
  return js(
    page,
    `
    globalThis.__live?.stop();
    const heard = [];
    const last = new Map();
    const regionOf = (el) => (el.closest("[data-rvtt-toast-status]") ? "toast" : el.closest("[data-block-header]") ? "header" : el.closest("[data-dice-last]") ? "dice" : "other");
    const look = () => {
      for (const el of document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]')) {
        const text = (el.textContent ?? "").trim();
        if (text === (last.get(el) ?? "")) continue;
        last.set(el, text);
        if (text !== "") heard.push({ region: regionOf(el), text });
      }
    };
    look();
    heard.length = 0;
    const observer = new MutationObserver(look);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    globalThis.__live = { heard, stop: () => observer.disconnect() };
    `,
  );
}

/** What the live regions said since `listenLive` that names `label`. */
async function heardOf(page: Page, label: RegExp): Promise<Heard[]> {
  return (await js<Heard[]>(page, "return globalThis.__live.heard;")).filter((h) => label.test(h.text));
}

/** The roll header of the panel around `scope`, or in it. */
function headerOf(scope: Locator): Locator {
  return scope.locator("xpath=ancestor-or-self::*[@data-block-header-host][1]//*[@data-block-header] | .//*[@data-block-header]");
}

/** An ability's box in the first rolling grid in `scope`, such as "Dexterity". */
function abilityBox(scope: Locator, ability: string): Locator {
  return scope.locator("[data-ability-grid]").first().getByRole("button", { name: new RegExp(`^${ability} `) });
}

/** A menu that slid over its box ignores a press for 350 ms after it opens (Menu.tsx, D-261101-313), so a step that taps its row waits past that. */
const MENU_SETTLE_MS = 400;

/** A tap on an ability's box and on a row of its list, as a finger picks. */
async function pickRow(page: Page, scope: Locator, ability: string, row: RegExp, how: "tap" | "click" = "tap"): Promise<void> {
  const box = abilityBox(scope, ability);
  const item = page.getByRole("menu", { name: `${ability} rolls` }).getByRole("menuitem", { name: row });
  if (how === "tap") {
    await box.tap();
    await sleep(MENU_SETTLE_MS);
    await item.tap();
  } else {
    await box.click();
    await sleep(MENU_SETTLE_MS);
    await item.click();
  }
}

/**
 * Warms the dice through the Dice panel, as `diceReady` does, and leaves
 * it: a stat block's first roll is the step's own, and it throws only
 * once the renderer is warm. The renderer stays warm while any rolling
 * surface is mounted, and for 30 s after the last goes.
 */
async function warmDice(page: Page, socket: SocketWatch): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 900) {
    await closeAll(page);
    await openDicePhone(page);
    await diceReady(page, socket);
    await closeAll(page);
  } else {
    await openSideTab(page, "Dice");
    await diceReady(page, socket);
  }
}

async function closeAll(page: Page): Promise<void> {
  // The formula field keeps Escape for itself, so focus leaves it first.
  await js(page, "document.activeElement?.blur();");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page.locator("dialog[data-rvtt-sheet][open]").first().waitFor({ state: "hidden", timeout: 1_500 }).catch(() => undefined);
}

/** Pat's Characters sheet on a phone, at a character's page with its stat block open. */
async function characterPage(page: Page, id: string, name: string): Promise<Locator> {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (!(await sheet.isVisible())) {
    await closeAll(page);
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).tap();
    await sheet.waitFor();
  }
  const heading = sheet.locator("[data-creature-heading]").filter({ hasText: name });
  const opener = sheet.locator(`[data-opener="character:${id}"]`);
  await sheet.locator("[data-creature-heading]").or(opener).first().waitFor();
  if (!(await heading.isVisible())) {
    if (!(await opener.isVisible())) await sheet.getByRole("button", { name: "Back to Characters", exact: true }).tap();
    await opener.tap();
  }
  await heading.waitFor();
  const fold = sheet.getByRole("button", { name: "Stat block", exact: true });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await sheet.locator("[data-ability-grid]").first().waitFor();
  return sheet;
}

/** The DM's token panel for a token, from its cell, with the stat block open. */
async function tokenPanel(page: Page, name: string, at: { x: number; y: number }, escapeFirst = true): Promise<Locator> {
  if (escapeFirst) await page.keyboard.press("Escape");
  const sceneId = dmSocket.state!.meta.playerSceneId!;
  await tapCell(page, dmSocket.state!.scenes[sceneId]!.bounds, at);
  const bar = page.getByRole("dialog", { name: `${name} actions` });
  await bar.waitFor();
  await (await barControl(bar, "Details")).click();
  const panel = page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true })).or(page.locator('dialog[data-rvtt-sheet][aria-label="Token"]'));
  await panel.getByRole("heading", { name, exact: true }).first().waitFor();
  const fold = panel.getByRole("button", { name: "Stat block", exact: true });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await panel.locator("[data-ability-grid]").first().waitFor();
  return panel.first();
}

/** A scroller's place and size, and its scroll, around `inside`. */
function scrollerOf(inside: Locator): Promise<{ top: number; bottom: number; scrollTop: number; scrollHeight: number; clientHeight: number; anchor: string; spacer: number }> {
  return inside.evaluate((el) => {
    type S = { getBoundingClientRect(): { top: number; bottom: number }; scrollTop: number; scrollHeight: number; clientHeight: number; querySelector(s: string): { offsetHeight: number } | null };
    const e = el as unknown as { closest(s: string): S | null; ownerDocument: { defaultView: { getComputedStyle(e: S): { overflowAnchor: string } } } };
    const s = e.closest("[data-pane-body]")!;
    const r = s.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, anchor: e.ownerDocument.defaultView.getComputedStyle(s).overflowAnchor, spacer: s.querySelector("[data-block-header-spacer]")?.offsetHeight ?? 0 };
  });
}

/** Scrolls the scroller around `el` by `by` layout px. */
function scrollPane(el: Locator, by: number): Promise<void> {
  return el.evaluate((node, by) => {
    (node as unknown as { closest(q: string): { scrollTop: number } }).closest("[data-pane-body]").scrollTop += by;
  }, by);
}

/** Brings `el`'s top to its scroller's top, so a header line put in would cover it. */
async function toPaneTop(el: Locator): Promise<void> {
  const [box, pane] = await Promise.all([el.boundingBox(), scrollerOf(el)]);
  const zoom = await el.evaluate((n) => (n as unknown as { currentCSSZoom?: number }).currentCSSZoom ?? 1);
  await scrollPane(el, (box!.y - pane.top) / zoom);
  await sleep(150);
}

/** The header's plain words: their lines, and the row's height, in layout px. */
function headerWords(header: Locator): Promise<{ lines: number; row: number; text: string }> {
  return header.evaluate((el) => {
    type E = { offsetHeight: number; textContent: string | null; querySelector(s: string): E | null };
    const h = el as unknown as E & { ownerDocument: { defaultView: { getComputedStyle(e: E): { lineHeight: string } } } };
    const words = h.querySelector("[data-block-header-row] span[title]")!;
    const line = Number.parseFloat(h.ownerDocument.defaultView.getComputedStyle(words).lineHeight);
    return { lines: Math.round(words.offsetHeight / line), row: h.querySelector("[data-block-header-row]")!.offsetHeight, text: words.textContent ?? "" };
  });
}

describe("raccoon-vtt dice", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: WEBGL_ARGS });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const context of [dmContext, playerContext]) await diceFoldsOpen(context);
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
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

  test("1. the DM makes a room on a computer and a player joins on a phone", async () => {
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
    run.dmId = dmSocket.you!.memberId;

    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).tap();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).tap();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    run.patId = playerSocket.you!.memberId;
  });

  test("2. Pat rolls 2d6+3 on the phone, the DM reads the same dice, and its toast comes while the DM's Dice panel is closed", async () => {
    await openDicePhone(player);
    await field(player).fill("2d6+3 fire");
    await player.getByText("2d6+3, fire: 5 to 15").waitFor();
    await shots.take(player, "dice-reading");
    const mine = await rollWithEnter(player, playerSocket, "2d6+3 fire");
    assert.equal(mine.by, run.patId);
    assert.equal(mine.rolls[0]?.label, "fire");
    assert.equal(mine.rolls[0]?.faces.length, 2);
    const theirs = await waitFor("the DM's line", () => diceLines(dmSocket.state?.log).find((l) => l.data.tag === mine.tag)?.data ?? null);
    assert.deepEqual(theirs.rolls[0]?.faces, mine.rolls[0]?.faces);
    assert.equal(theirs.rolls[0]?.total, mine.rolls[0]?.total);
    const total = mine.rolls[0]!.total;
    await dm.locator("[data-toast]").getByText(`Pat rolled ${total} for fire.`).waitFor();
    await shots.take(dm, "dice-toast-on-dm");
    const sticky = player.locator("[data-dice-last]");
    await sticky.getByText(String(total), { exact: true }).waitFor();
    await shots.take(player, "dice-rolled-phone");
    await openSideTab(dm, "Dice");
    await dm.getByRole("tabpanel", { name: sideTabName("Dice") }).getByText("fire", { exact: true }).first().waitFor();
    // The tab names the panel, and nothing inside it is a second region called Dice (LP7-CHROME-2).
    assert.equal(await dm.getByRole("region", { name: "Dice" }).count(), 0, "a region named Dice inside the Dice tab");
    await shots.take(dm, "dice-panel-dm");
  });

  test("3. a DM's free formula starts in the open, one tap hides it, and Pat reads only that the DM rolled in secret", async () => {
    const secret = dm.getByRole("button", { name: "Hide from players" });
    // Only a DM's roll for a monster starts secret (docs/design/design-v1-dice.md 17).
    assert.equal(await secret.getAttribute("aria-pressed"), "false", "a DM's free formula starts in the open");
    await secret.click();
    assert.equal(await secret.getAttribute("aria-pressed"), "true");
    const line = await rollWithEnter(dm, dmSocket, "1d20+4 Perception");
    assert.equal(line.to, "dm");
    const bare = await waitFor("the bare line on Pat's phone", () => diceLines(playerSocket.state?.log).find((l) => l.data.by === run.dmId)?.data ?? null);
    assert.deepEqual(bare, { type: "dice", by: run.dmId, to: "dm", rolls: [] });
    assert.ok(!playerSocket.everSaw("Perception"), "the secret roll's label never reached the phone");
    await player.getByText("Dana the DM rolled in secret.").waitFor();
    assert.equal(await secret.getAttribute("aria-pressed"), "false", "and the choice is back to its start for the next roll");
    await shots.take(player, "dice-secret-for-player");
  });

  test("4. Enter rolls the field, Up and Down walk this device's formulas, and a roll survives a reload", async () => {
    const line = await rollWithEnter(player, playerSocket, "1d8+2");
    assert.equal(line.rolls[0]?.formula, "1d8+2");
    await field(player).fill("3d4");
    await field(player).press("ArrowUp");
    assert.equal(await field(player).inputValue(), "1d8+2");
    await field(player).press("ArrowUp");
    assert.equal(await field(player).inputValue(), "2d6+3 fire");
    await field(player).press("ArrowDown");
    await field(player).press("ArrowDown");
    assert.equal(await field(player).inputValue(), "3d4", "back to what was being typed");
    await field(player).fill("");
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await openDicePhone(player);
    // The sheet's own region names the panel, once (LP7-CHROME-2).
    assert.equal(await player.getByRole("region", { name: "Dice" }).count(), 1, "the phone's Dice sheet holds a second region of its name");
    const recent = player.getByRole("region", { name: "Dice" }).locator("[data-roll-row]");
    await waitFor("Recent rolls after the reload", async () => (await recent.count()) >= 3 || null);
    await field(player).press("ArrowUp");
    assert.equal(await field(player).inputValue(), "1d8+2", "the history is this device's");
    await field(player).fill("");
  });

  test("5. Advantage goes with the one roll that took it, and a press made before that roll lands stays for the next", async () => {
    const adv = player.getByRole("button", { name: "Advantage", exact: true });
    await adv.tap();
    assert.equal(await adv.getAttribute("aria-pressed"), "true");
    const before = diceLines(playerSocket.state?.log).length;
    await field(player).fill("1d20+5 Stealth");
    await field(player).press("Enter");
    // Taken at the tap: the chip is back to its start at once, then pressed again before the roll lands.
    assert.equal(await adv.getAttribute("aria-pressed"), "false");
    await adv.tap();
    const first = await waitFor("the first roll", () => diceLines(playerSocket.state?.log).slice(before)[0]?.data ?? null);
    assert.equal(first.rolls[0]?.mode, "adv");
    assert.equal(await adv.getAttribute("aria-pressed"), "true", "a late answer never clears a newer choice");
    const second = await rollWithEnter(player, playerSocket, "1d20+5 Stealth");
    assert.equal(second.rolls[0]?.mode, "adv");
    const third = await rollWithEnter(player, playerSocket, "1d20+5 Stealth");
    assert.equal(third.rolls[0]?.mode, undefined);
    assert.equal((third.rolls[0] as DiceRoll).faces.length, 1);
  });

  test("6. at 375 x 667, at 100% and 130%, the sticky line, the field, Roll, the quick dice with the d20 first and the Next roll group's Adv, Dis and Secret are in view", async () => {
    for (const scale of [1, 1.3]) {
      await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await player.goto(`${server.origin}/r/${run.roomId}`);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      await rollWithEnter(player, playerSocket, "1d20+3");
      await settled(player);
      const modes = '[role="group"][aria-label="For the next roll"]';
      const secret = `${modes} button[aria-label="Only the DM sees it"]`;
      const sheetView = await player.locator('dialog[data-rvtt-sheet][aria-label="Dice"] [data-pane-body]').boundingBox();
      assert.ok(sheetView, "the Dice sheet's body");
      for (const selector of ["[data-dice-last]", 'input[aria-label="Dice formula"]', 'button:has-text("Roll")', '[aria-label="Quick dice"]', 'button[aria-label="Add a d20"]', `${modes} button[aria-label="Advantage"]`, `${modes} button[aria-label="Disadvantage"]`, secret]) {
        assert.ok(await inView(player, selector), `${selector} in view at ${Math.round(scale * 100)}%`);
        // Inside the sheet's first screen too, where nothing covers it. At 130% the row has no room for Secret beside the pair, so it wraps under them, one short scroll down (docs/design/design-v1-dice-pass.md 4).
        if (scale !== 1 && selector === secret) continue;
        const box = (await player.locator(selector).first().boundingBox())!;
        assert.ok(box.y >= sheetView.y - 1 && box.y + box.height <= sheetView.y + sheetView.height + 1, `${selector} inside the sheet's view at ${Math.round(scale * 100)}%: ${box.y}-${box.y + box.height} in ${sheetView.y}-${sheetView.y + sheetView.height}`);
      }
      const pair = (await player.locator(`${modes} button[aria-label="Advantage"]`).boundingBox())!;
      const own = (await player.locator(secret).boundingBox())!;
      const row = (await player.locator(modes).boundingBox())!;
      if (scale === 1) assert.ok(Math.abs(own.y - pair.y) <= 1, "at 100% Secret shares the pair's line");
      else assert.ok(own.y >= pair.y + pair.height && Math.abs(own.width - row.width) <= 1, `at 130% Secret wraps under the pair and fills its line: ${JSON.stringify({ own, row })}`);
      await shots.take(player, `dice-phone-${Math.round(scale * 100)}`);
    }
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });

  test("7. with two panels, Dice rolls in the bottom pane, and Pat's roll makes no toast while Dice shows there", async () => {
    // The bottom pane counts as on screen (docs/design/design-v1-split-panel.md 3, docs/design/design-v1-dice.md 8.5).
    await openSideTab(dm, "Initiative");
    await dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]').click();
    await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
    const bar = dm.locator("[data-pane-bar]");
    await bar.getByRole("button", { name: / below$/ }).click();
    await dm.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: sideTabName("Dice") }).click();
    const below = dm.getByRole("group", { name: "Dice below", exact: true });
    await below.waitFor();
    const mine = await rollWithEnter(dm, dmSocket, "1d20+2 Below");
    await below.locator("[data-dice-last]").getByText(String(mine.rolls[0]!.total), { exact: true }).waitFor();
    await shots.take(dm, "dice-bottom-pane");

    await openDicePhone(player);
    const quiet = await rollWithEnter(player, playerSocket, "1d6 Quiet");
    await waitFor("the DM's line", () => diceLines(dmSocket.state?.log).find((l) => l.data.tag === quiet.tag) ?? null);
    await below.getByText("Quiet", { exact: true }).first().waitFor();
    await dm.waitForTimeout(1_000);
    assert.equal(await dm.locator("[data-toast]").getByText(`Pat rolled ${quiet.rolls[0]!.total} for Quiet.`).count(), 0, "no toast while Dice shows below");

    // With the split closed and Initiative on top, Dice is off screen again, so the next roll toasts.
    await bar.getByRole("button", { name: "Close Dice", exact: true }).click();
    await bar.waitFor({ state: "detached" });
    const loud = await rollWithEnter(player, playerSocket, "1d6 Loud");
    await dm.locator("[data-toast]").getByText(`Pat rolled ${loud.rolls[0]!.total} for Loud.`).waitFor();
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });

  test("8. a roll of 100 dice with a long label keeps the sticky line to one line with Again in reach, and the panel never scrolls sideways (LP7-DICE-1)", async () => {
    await openDicePhone(player);
    await rollWithEnter(player, playerSocket, `100d1000 ${"z".repeat(60)}`);
    await settled(player);
    const sticky = player.locator("[data-dice-last]");
    await sticky.getByRole("button", { name: "Again" }).waitFor();
    const fit = await sticky.evaluate((el) => {
      type Box = { getBoundingClientRect(): { height: number }; parentElement: Box | null; scrollWidth: number; clientWidth: number; currentCSSZoom?: number };
      const g = globalThis as unknown as { getComputedStyle(el: Box): { overflowY: string; getPropertyValue(name: string): string } };
      const line = el as unknown as Box;
      let scroller = line.parentElement;
      while (scroller && g.getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement;
      return { height: line.getBoundingClientRect().height, padTop: parseFloat(g.getComputedStyle(line).getPropertyValue("--pane-pad-top")) || 0, zoom: line.currentCSSZoom ?? 1, sideways: scroller ? scroller.scrollWidth - scroller.clientWidth : -1 };
    });
    // One line: the pane's top padding, Again's 44 px touch target and the line's 1 px rule, and 3 px for rounding. A second line of words would add 20 px more (review LP2L3-OPUS-03).
    const oneLine = (fit.padTop + 44 + 1) * fit.zoom + 3;
    assert.ok(fit.padTop > 0, "the pane's top padding was read");
    assert.ok(fit.height <= oneLine, `the sticky line is ${fit.height} px tall, over one line's ${oneLine}`);
    assert.equal(fit.sideways, 0, "the Dice sheet scrolls sideways");
    assert.ok(await inView(player, '[data-dice-last] button:has-text("Again")'), "Again is on screen");
    // Again is a whole touch target, as every button is (docs/design/design-v1-look-pass-2.md D37).
    const again = (await sticky.getByRole("button", { name: "Again" }).boundingBox())!;
    assert.ok(again.height >= 44, `Again is ${again.height} px tall`);
    await shots.take(player, "dice-hundred-dice-sticky");
  });

  test("9. a tap on the sticky line opens its roll in Recent rolls with the row's head in sight below the line (LP7-DICE-5)", async () => {
    const sticky = player.locator("[data-dice-last]");
    await sticky.getByRole("button", { name: "Show this roll in Recent rolls" }).tap();
    const row = player.getByRole("region", { name: "Dice" }).locator("[data-roll-row]").first();
    // The row of 100 dice is taller than the sheet, so it scrolls to its head.
    await waitFor("the row's head below the sticky line", async () => {
      const line = await sticky.boundingBox();
      const head = await row.boundingBox();
      return line && head && head.y >= line.y + line.height - 1 && head.y < line.y + line.height + 40 ? true : null;
    });
    await shots.take(player, "dice-sticky-opens-row");
  });

  test("dp-9b. a tap on the sticky line opens a folded Recent rolls for the page with the row in view, writing nothing, and again after Pat folds it once more", async () => {
    const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
    const sticky = player.locator("[data-dice-last]");
    const fold = sheet.locator("[data-dice-recent] [data-group-fold]");
    const stored = () => player.evaluate(() => (JSON.parse(localStorage.getItem("rvtt.diceFolds") ?? "{}") as Record<string, boolean>).recent);
    for (const round of [1, 2]) {
      await fold.scrollIntoViewIfNeeded();
      await fold.tap();
      await waitFor(`Recent rolls folded (${round})`, async () => ((await fold.getAttribute("aria-expanded")) === "false" ? true : null));
      assert.equal(await sheet.locator("[data-roll-row]").count(), 0, "folded, no row is drawn");
      assert.equal(await stored(), false, "Pat's own fold is stored");
      await sheet.locator("[data-pane-body]").evaluate((el) => (el.scrollTop = 0));
      await sticky.getByRole("button", { name: "Show this roll in Recent rolls" }).tap();
      await waitFor(`Recent rolls open again (${round})`, async () => ((await fold.getAttribute("aria-expanded")) === "true" ? true : null));
      const row = sheet.locator("[data-roll-row]").first();
      // Its head under the sticky line and in sight, or the whole row in view where it fits.
      await waitFor(`the row in view (${round})`, async () => {
        const line = await sticky.boundingBox();
        const head = await row.boundingBox();
        const body = await sheet.locator("[data-pane-body]").boundingBox();
        if (!line || !head || !body) return null;
        const under = head.y >= line.y + line.height - 1;
        const shows = head.y + head.height <= body.y + body.height + 1 || head.y < line.y + line.height + 40;
        return under && shows ? true : null;
      });
      assert.equal(await stored(), false, "the app's opening writes nothing");
      await shots.take(player, `dp-dice-sticky-opens-folded-${round}`);
    }
  });

  test("10. viewing as Pat, Roll waits and says a preview sends no rolls, as the options do, not that it needs a connection (LP7-DICE-7)", async () => {
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    // At 1280 px the preview's row holds Token, Initiative and Dice once it has measured itself. Until then Dice sits in More, so wait for its tab.
    const diceTab = preview.getByRole("tablist", { name: "Panels" }).getByRole("tab", { name: sideTabName("Dice") });
    await diceTab.waitFor();
    await diceTab.click();
    await preview.getByRole("tabpanel", { name: sideTabName("Dice") }).waitFor();
    const before = diceLines(dmSocket.state?.log).length;
    await field(preview).fill("1d20 Preview");
    const roll = preview.getByRole("button", { name: "Roll", exact: true });
    assert.equal(await roll.isDisabled(), true, "Roll waits in a preview");
    await preview.getByText("Rolls are not sent from a preview.", { exact: true }).first().waitFor();
    await field(preview).press("Enter");
    await dm.waitForTimeout(500);
    assert.equal(diceLines(dmSocket.state?.log).length, before, "nothing rolled");
    await shots.take(dm, "dice-preview-waits");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
  });

  test("11. Pat's Thorn with a stat block: at 390 x 844 the Longsword row's Attack, Damage and Critical share one line under its numbers", async () => {
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thornId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: THORN_ACTOR, level: 5, stats: THORN_STATS } });
    await waitFor("Thorn on Pat's phone", () => playerSocket.state?.characters[run.thornId]?.stats ?? null);
    await player.setViewportSize({ width: 390, height: 844 });
    await openDicePhone(player);
    const rolls = thornRolls(player);
    const attack = rolls.getByRole("button", { name: "Longsword", exact: true });
    await attack.scrollIntoViewIfNeeded();
    // By their middles, since a chip and a button may differ in height on one line.
    const middles = await Promise.all(
      [attack, rolls.getByRole("button", { name: "Longsword damage", exact: true }), rolls.getByRole("button", { name: "Critical Hit for Longsword's next damage", exact: true })].map(async (l) => {
        const box = (await l.boundingBox())!;
        return box.y + box.height / 2;
      }),
    );
    assert.ok(middles.every((m) => Math.abs(m - middles[0]!) < 1), `the row's controls take more than one line: ${middles.join(", ")}`);
    // The numbers stand in the row's header, after its name, as a stat block prints them (docs/design/design-v1-dice-ui.md 4.4).
    const header = (await namedRow(attack).locator("div").first().innerText()).replace(/\s+/g, " ");
    assert.match(header, /^Longsword ?\+6 to hit, 1d8\+3 Slashing/);
    await shots.take(player, "dice-weapon-row-390");
  });

  test("12. Attack's result lands in the header line, and its row neither grows nor shows it", async () => {
    const rolls = thornRolls(player);
    const attack = rolls.getByRole("button", { name: "Longsword", exact: true });
    const row = namedRow(attack);
    const before = { box: (await row.boundingBox())!, text: await row.innerText() };
    const count = diceLines(playerSocket.state?.log).length;
    await attack.tap();
    const line = await waitFor("Longsword's roll", () => diceLines(playerSocket.state?.log).slice(count).find((l) => l.data.rolls[0]?.label === "Longsword")?.data ?? null);
    const total = String(line.rolls[0]!.total);
    const sticky = player.locator("[data-dice-last]");
    await sticky.getByText(total, { exact: true }).waitFor();
    await waitFor("the row at rest", async () => ((await attack.getAttribute("aria-busy")) === null ? true : null));
    const after = { box: (await row.boundingBox())!, text: await row.innerText() };
    assert.equal(after.box.height, before.box.height, "the row grew as the roll landed");
    assert.equal(after.text, before.text, "the row shows something of the roll");
    await shots.take(player, "dice-attack-in-header-line");
  });

  test("13. a save spell's row says its DC where an attack's bonus stands: Hold Person DC 14 Wis, Sacred Flame DC 14 Dex and its damage", async () => {
    const rolls = thornRolls(player);
    const headerOf = async (name: string) => {
      const header = rolls.locator("div").filter({ has: player.getByText(name, { exact: true }) }).last();
      return (await header.innerText()).replace(/\s+/g, " ").trim();
    };
    assert.match(await headerOf("Hold Person"), /^Hold Person ?DC 14 WIS$/);
    assert.match(await headerOf("Sacred Flame"), /^Sacred Flame ?DC 14 DEX, \dd8 Radiant/);
    await rolls.getByText("Hold Person", { exact: true }).scrollIntoViewIfNeeded();
    await shots.take(player, "dice-save-spells-dc");
  });

  test("14. the header line keeps to its column, at 100% and at 130%", async () => {
    for (const scale of [1, 1.3]) {
      if (scale !== 1) {
        await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await reopenRoom(player);
        await player.getByRole("status", { name: "Connected" }).first().waitFor();
        await openDicePhone(player);
        await rollWithEnter(player, playerSocket, "1d20+3");
        await settled(player);
      }
      const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
      const line = (await sheet.locator("[data-dice-last]").boundingBox())!;
      const column = (await sheet.locator("[data-roll-options]").boundingBox())!;
      const label = `${Math.round(scale * 100)}%`;
      assert.ok(line.x >= column.x - 0.5, `${label}: the line starts ${column.x - line.x} px left of its column`);
      assert.ok(line.x + line.width <= column.x + column.width + 0.5, `${label}: the line ends ${line.x + line.width - column.x - column.width} px right of its column`);
      await shots.take(player, `dice-header-line-column-${Math.round(scale * 100)}`);
    }
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("15. an answer sent from the panel shows in the header line with its label and no Again (LP7-DICE-10)", async () => {
    await ops!.send({ t: "roll.ask", request: { id: randomUUID(), test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thornId }] } });
    await openDicePhone(player);
    const cell = thornRolls(player).getByRole("button", { name: /^Dexterity save, answers the DM's request/ });
    await cell.scrollIntoViewIfNeeded();
    await cell.tap();
    const sticky = player.locator("[data-dice-last]");
    await sticky.locator("[data-result-label]").filter({ hasText: /^Dexterity save$/ }).waitFor();
    // Its roll has no label of its own, so what the line says takes the option's name too (LP27-A-BLOCK-3).
    await sticky.locator('[role="status"][aria-live="polite"]').filter({ hasText: /: Dexterity save/ }).waitFor({ state: "attached" });
    assert.equal(await sticky.getByRole("button", { name: "Again" }).count(), 0, "an answer cannot go again as it went");
    await shots.take(player, "dice-answer-header-line");
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });

  test("16. the DM's Aboleth at 390 x 844, at 100% and 130%: no roll option's words run past its button, the group save's among them, and none leaves the panel", async () => {
    const sceneId = dmSocket.state!.meta.playerSceneId!;
    const bounds = dmSocket.state!.scenes[sceneId]!.bounds;
    await ops!.send({ t: "token.create", token: { id: randomUUID(), sceneId, kind: "monster", name: "Aboleth", size: "large", x: 2, y: 2, visibility: "all", disposition: "hostile", actor: { inline: { ...THORN_ACTOR, srdId: "aboleth" } } } });
    for (const scale of [1, 1.3]) {
      const label = `390 x 844 at ${Math.round(scale * 100)}%`;
      await dm.setViewportSize({ width: 390, height: 844 });
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await reopenRoom(dm);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await dm.locator(".konvajs-content").first().waitFor();
      await tapCell(dm, bounds, { x: 2.5, y: 2.5 });
      const bar = dm.getByRole("dialog", { name: "Aboleth actions" });
      await bar.getByRole("button", { name: "Roll", exact: true }).click();
      const sheet = dm.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
      const options = sheet.locator("[data-roll-options]");
      const group = options.getByRole("button", { name: /^Group save, DC 16 WIS/ });
      await group.waitFor();
      assert.deepEqual(await overflowing(options), [], `${label}: words run past their buttons`);
      await group.scrollIntoViewIfNeeded();
      await shots.take(dm, `dice-aboleth-group-save-${Math.round(scale * 100)}`);
      await sheet.getByRole("button", { name: "Close Dice" }).click();
      await dm.keyboard.press("Escape");
    }
    await dm.setViewportSize({ width: 1280, height: 800 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("17. a critical Flame Tongue with its three riders under Max plus a roll: at 390 x 844 at 100% and 130% the header line keeps its total, its sum and Again whole and drops whole dice for a +N, and at 320 x 568 at 130% nothing on it is cut", async () => {
    await ops!.send({ t: "room.update", settings: { critRule: "maxPlusRoll" } });
    await ops!.send({ t: "character.update", characterId: run.thornId, patch: { stats: { ...THORN_STATS, rolls: [...THORN_STATS.rolls, LONG_WEAPON] } } });
    // 320 at 130% stands for a small iPhone with Safari's text made larger, which narrows the page as much. There the sum may go, whole.
    for (const [width, height, scale] of [[390, 844, 1], [390, 844, 1.3], [320, 568, 1.3]] as const) {
      const label = `${width} x ${height} at ${Math.round(scale * 100)}%`;
      await player.setViewportSize({ width, height });
      await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      const rolls = thornRolls(player);
      const name = LONG_WEAPON.name;
      // Longsword has a Divine Smite of its own, so the chips are found in this weapon's row.
      const row = namedRow(rolls.getByRole("button", { name, exact: true }));
      for (const rider of ["Flame Tongue", "Divine Smite", "Hunter's Mark"]) {
        const chip = row.getByRole("button", { name: new RegExp(`^${rider}: add \\d+d\\d+ to the next damage`) });
        await chip.scrollIntoViewIfNeeded();
        await chip.tap();
      }
      await rolls.getByRole("button", { name: `Critical Hit for ${name}'s next damage` }).tap();
      const count = diceLines(playerSocket.state?.log).length;
      await rolls.getByRole("button", { name: new RegExp(`^${name} damage, Critical: max plus a roll`) }).tap();
      const line = await waitFor("the critical damage's line", () => diceLines(playerSocket.state?.log).slice(count).find((l) => l.data.rolls[0]?.crit !== undefined)?.data ?? null);
      const sticky = player.locator("[data-dice-last]");
      await sticky.getByText(String(line.rolls[0]!.total), { exact: true }).waitFor();
      await settled(player);
      const sum = (await sticky.getByText(/^\(\d+ max \+ \d+\)$/).textContent())!;
      const keep = [String(line.rolls[0]!.total), "Again", ...(width === 390 ? [sum] : [])];
      assert.deepEqual(await headerFaults(sticky, keep), [], `${label}: the header line`);
      assert.deepEqual(await overflowing(player.locator('dialog[data-rvtt-sheet][aria-label="Dice"] [data-roll-options]')), [], `${label}: words run past their buttons`);
      await shots.take(player, `dice-long-crit-header-${width}-${Math.round(scale * 100)}`);
    }
    await ops!.send({ t: "room.update", settings: { critRule: "rollTwice" } });
    await player.setViewportSize({ width: 390, height: 844 });
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });

  test("18-readline. the line under the field is always held, so the quick dice never move as a reading, a refusal or nothing shows there, and no refusal is cut", async () => {
    const refusals: Record<string, string> = {
      dice: "101d6",
      sides: "1d1001",
      number: "d20+1001",
      keep: "2d6kh3",
      terms: Array.from({ length: 21 }, () => "1").join("+"),
      sign: "1d20+",
      long: `${Array.from({ length: 15 }, () => "100d1000").join("+")}`,
      label: `1d20 ${"x".repeat(61)}`,
      other: "xyz",
    };
    const blockedWords = ["Rolls are not sent from a preview.", "Rolling needs a connection.", FORMULA_ERRORS.mode];
    for (const [width, height, scale] of [[390, 844, 1], [390, 844, 1.3], [320, 568, 1.3], [320, 568, 1]] as const) {
      const label = `${width} x ${height} at ${Math.round(scale * 100)}%`;
      await player.setViewportSize({ width, height });
      await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      const d20 = player.locator('button[aria-label="Add a d20"]');
      const top = async () => (await d20.boundingBox())!.y;
      const empty = await top();
      if (width === 390 && scale === 1) await shots.take(player, "dice-readline-empty");
      await field(player).fill("4d20+2d4");
      await player.getByText(/^4d20\+2d4: [\d,]+ to [\d,]+$/).waitFor();
      assert.equal(await top(), empty, `${label}: a reading holds the quick dice`);
      if (width === 390 && scale === 1) await shots.take(player, "dice-readline-reading");
      await field(player).fill("1d20+");
      await field(player).press("Enter");
      await player.locator("[data-dice-note] [role=alert]").waitFor();
      assert.equal(await top(), empty, `${label}: a refusal holds the quick dice`);
      await field(player).fill("");
      assert.equal(await top(), empty, `${label}: an empty field holds the quick dice`);
      // Each refusal and each blocked note must fit its one line whole.
      const cut: string[] = [];
      for (const [name, text] of Object.entries(refusals)) {
        await field(player).fill(text);
        await field(player).press("Enter");
        const alert = player.locator("[data-dice-note] [role=alert]");
        await alert.waitFor();
        const sizes = await player.locator("[data-dice-note]").evaluate((el) => ({ need: (el as unknown as { scrollWidth: number }).scrollWidth, have: (el as unknown as { clientWidth: number }).clientWidth, words: el.textContent ?? "" }));
        if (sizes.need > sizes.have + 1) cut.push(`${name}: "${sizes.words}" needs ${sizes.need}, line is ${sizes.have}`);
        assert.equal(await top(), empty, `${label}: the ${name} refusal holds the quick dice`);
      }
      const noteWidths = await player.locator("[data-dice-note]").evaluate((el, words) => {
        type Box = { clientWidth: number; style: { fontSize: string; cssText: string }; textContent: string | null; getBoundingClientRect(): { width: number }; remove(): void };
        type Doc = { createElement(tag: string): Box; body: { append(e: Box): void } };
        const line = el as unknown as Box & { ownerDocument: Doc };
        const doc = line.ownerDocument;
        const probe = doc.createElement("span");
        probe.style.cssText = `position:absolute;white-space:nowrap;font-size:${line.style.fontSize}`;
        doc.body.append(probe);
        const out = words.map((w) => {
          probe.textContent = w;
          return { w, need: probe.getBoundingClientRect().width, have: line.clientWidth };
        });
        probe.remove();
        return out;
      }, blockedWords);
      for (const n of noteWidths) if (n.need > n.have + 1) cut.push(`note "${n.w}" needs ${Math.round(n.need)}, line is ${n.have}`);
      assert.deepEqual(cut, [], `${label}: words cut`);
      await field(player).fill("");
    }
    await player.setViewportSize({ width: 390, height: 844 });
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.deepEqual(playerConsole.errors, []);
  });

  test("ra-1. Pat rolls 1d20 at 390 x 844: the dice fly with no total in the header line, land on the chip's face within 1,100 ms, and no loop runs by 2.5 s", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await openDicePhone(player);
    await diceReady(player, playerSocket);
    await watchThrow(player);
    const line = await rollWithEnter(player, playerSocket, "1d20 ra-1");
    const w = await seen(player, "the total after the throw", (w) => w.totalAt !== null);
    assert.ok(w.canvasAt !== null, "the dice canvas showed");
    assert.equal(w.totalAtCanvas, false, "the header line held no total as the dice flew");
    const land = w.totalAt! - w.canvasAt!;
    assert.ok(land >= 900 && land <= 1_100, `the total showed ${Math.round(land)} ms after the dice`);
    const chip = await player.locator("[data-dice-last] [data-face]").first().textContent();
    assert.equal(chip, String(line.rolls[0]!.faces[0]));
    assert.equal(await landedFace(player), chip, "the die landed on the face its chip shows");
    // By 2.5 s the dice are gone, and the frame count stands still: no loop runs.
    await waitFor("2.5 s after the throw", () => js<boolean>(player, `return performance.now() - ${w.canvasAt} > 2_500 || null;`));
    const rest = (await stageHook(player))!;
    await player.waitForTimeout(400);
    const later = (await stageHook(player))!;
    assert.equal(rest.shown, false, "the canvas is hidden");
    assert.equal(later.frames, rest.frames, "frames were drawn after the throw ended");

    // A throw pictured as it lands: four d6 with their scrim.
    await watchThrow(player);
    await rollWithEnter(player, playerSocket, "4d6 ra-1");
    const four = await seen(player, "the four dice", (w) => w.canvasAt !== null);
    await waitFor("the landing", () => js<boolean>(player, `return performance.now() - ${four.canvasAt} > 1_150 || null;`));
    // The scrim stands until the dice fade at 1.8 s, whatever React drew in between.
    const scrim = await js<number>(player, `return Number(getComputedStyle(document.querySelector("[data-dice-tray]").firstElementChild).opacity);`);
    assert.ok(scrim > 0.9, `the scrim is at ${scrim} as the dice land`);
    // Square under the header line's straight edge, rounded at its foot (docs/design/design-v1-look-pass-2.md D37).
    const corners = await js<string[]>(player, `const s = getComputedStyle(document.querySelector("[data-dice-tray]").firstElementChild); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius];`);
    assert.deepEqual(corners.slice(0, 2), ["0px", "0px"], "the scrim rounds its top corners");
    assert.notEqual(corners[2], "0px", "the scrim's foot is rounded");
    await shots.take(player, "ra-landed-phone");
    await settled(player);
  });

  test("ra-2. under reduced motion the total shows at once and the canvas shows the landed dice, drawn once", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await player.emulateMedia({ reducedMotion: "reduce" });
    try {
      await watchThrow(player);
      const line = await rollWithEnter(player, playerSocket, "1d20 ra-2");
      const w = await seen(player, "the total", (w) => w.totalAt !== null);
      assert.ok(w.canvasAt !== null, "the landed dice showed");
      assert.ok(Math.abs(w.totalAt! - w.canvasAt!) < 100, `the total showed ${Math.round(w.totalAt! - w.canvasAt!)} ms after the dice`);
      await player.waitForTimeout(600);
      const hook = (await stageHook(player))!;
      assert.equal(hook.frames, "1", "one frame, at rest");
      assert.equal(hook.landed, String(line.rolls[0]!.faces[0]));
      await shots.take(player, "ra-reduced-motion");
      await settled(player);
    } finally {
      await player.emulateMedia({ reducedMotion: null });
    }
  });

  test("ra-3. with no WebGL, with Low power and with the switch off, the total shows at once, no canvas is made and nothing is logged", async () => {
    // No WebGL: every WebGL context refused, in a page of Pat's own.
    const page = await playerContext.newPage();
    const quiet = new ConsoleWatch("pat-no-webgl");
    quiet.attach(page);
    try {
      await page.addInitScript(() => {
        const proto = (globalThis as unknown as { HTMLCanvasElement: { prototype: { getContext(type: string, ...rest: unknown[]): unknown } } }).HTMLCanvasElement.prototype;
        const real = proto.getContext;
        proto.getContext = function (this: unknown, type: string, ...rest: unknown[]) {
          return /webgl/.test(type) ? null : real.call(this, type, ...rest);
        };
      });
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(page);
      // The dice's chunk loads in the background some seconds after the room does, so a roll after that is the real test.
      await page.waitForTimeout(3_000);
      await watchThrow(page);
      const before = diceLines(playerSocket.state?.log).length;
      await field(page).fill("1d20 ra-3 no webgl");
      await field(page).press("Enter");
      await waitFor("the no WebGL line", () => diceLines(playerSocket.state?.log).length > before || null);
      const w = await seen(page, "the total", (w) => w.totalAt !== null);
      assert.equal(w.canvasAt, null);
      assert.equal(await page.locator("[data-dice-stage]").count(), 0, "no canvas without WebGL");
      assert.deepEqual([...quiet.errors, ...quiet.warnings], [], "no console message without WebGL");
    } finally {
      await page.close();
    }

    // Low power, then the switch off: each read as the room loads, so the dice never load.
    for (const [key, value] of [["rvtt.lowPower", "on"], ["rvtt.rollAnimation", "off"]] as const) {
      await player.evaluate((kv) => localStorage.setItem(kv.key, kv.value), { key, value });
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      await player.waitForTimeout(3_000);
      const messages = playerConsole.errors.length + playerConsole.warnings.length;
      await watchThrow(player);
      await rollWithEnter(player, playerSocket, `1d20 ra-3 ${key}`);
      const w = await seen(player, "the total", (w) => w.totalAt !== null);
      assert.equal(w.canvasAt, null, `${key} ${value}: no throw`);
      assert.equal(await player.locator("[data-dice-stage]").count(), 0, `${key} ${value}: no canvas`);
      assert.equal(playerConsole.errors.length + playerConsole.warnings.length, messages, `${key} ${value}: no console message`);
      await player.evaluate((k) => localStorage.removeItem(k), key);
    }
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("ra-4. a tap during a throw: Again shows the first result at once and rolls again, Recent rolls' second row sends its own roll, and the formula field takes focus", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await openDicePhone(player);
    const sticky = player.locator("[data-dice-last]");
    const again = sticky.getByRole("button", { name: "Again" });
    await diceReady(player, playerSocket);

    // The header line's Again during a throw.
    await watchThrow(player);
    const first = await rollLine(player, playerSocket, "1d20 ra-4 first");
    await seen(player, "the throw", (w) => w.canvasAt !== null);
    assert.equal(await player.locator(`[data-roll-row~="${first.id}"]`).count(), 0, "the row waits for the dice");
    const count = diceLines(playerSocket.state?.log).length;
    await again.tap();
    const a = await seen(player, "the first result", (w) => w.newRowAt !== null && w.downAt !== null);
    assert.ok(a.downAt! - a.canvasAt! < 1_000, "the tap came while the dice flew");
    assert.ok(a.newRowAt! - a.downAt! < 400, `the first result showed ${Math.round(a.newRowAt! - a.downAt!)} ms after the tap`);
    assert.ok(a.newRowAt! < a.canvasAt! + 1_000, "before the dice would have landed");
    await player.locator(`[data-roll-row~="${first.id}"]`).waitFor({ state: "attached" });
    const rerolled = await waitFor("the roll again", () => diceLines(playerSocket.state?.log).slice(count).at(-1) ?? null);
    assert.equal(rerolled.data.rolls[0]?.label, "ra-4 first");
    await settled(player);

    // Recent rolls' second row during a throw sends that row's roll.
    await rollWithEnter(player, playerSocket, "1d6+2 ra-4 older");
    await settled(player);
    await rollWithEnter(player, playerSocket, "1d8+1 ra-4 newer");
    await settled(player);
    const rows = player.getByRole("region", { name: "Dice" }).locator("[data-roll-row]");
    await rows.nth(1).scrollIntoViewIfNeeded();
    await watchThrow(player);
    await again.tap();
    await seen(player, "the throw of the newer roll", (w) => w.canvasAt !== null);
    const second = rows.nth(1).getByRole("button", { name: /^Roll again: / });
    assert.equal(await second.getAttribute("aria-label"), "Roll again: 1d6+2 ra-4 older", "the second row is the older roll while the newer one flies");
    const before = diceLines(playerSocket.state?.log).length;
    await second.tap();
    const b = await watched(player);
    assert.ok(b.downAt! - b.canvasAt! < 1_000, "the tap came while the dice flew");
    const sent = await waitFor("the second row's roll", () => diceLines(playerSocket.state?.log).slice(before).at(-1)?.data ?? null);
    assert.equal(sent.rolls[0]?.formula, "1d6+2");
    assert.equal(sent.rolls[0]?.label, "ra-4 older");
    await settled(player);

    // The formula field during a throw.
    await watchThrow(player);
    await again.tap();
    await seen(player, "the throw", (w) => w.canvasAt !== null);
    await field(player).tap();
    const c = await seen(player, "the result", (w) => w.totalAt !== null && w.downAt !== null);
    assert.ok(c.downAt! - c.canvasAt! < 1_000, "the tap came while the dice flew");
    assert.ok(c.totalAt! - c.downAt! < 400, "the result showed at once");
    assert.equal((await stageHook(player))?.shown, false, "the dice are gone");
    assert.equal(await js<string | null>(player, `return document.activeElement?.getAttribute("aria-label") ?? null;`), "Dice formula", "the field took focus");
    await field(player).blur();
  });

  test("ra-5. the tracker's Roll throws nothing, with Dice open in the pane above it", async (t) => {
    if (!(await needsWebGL(dm, t))) return;
    await openSideTab(dm, "Dice");
    await dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]').click();
    await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
    const bar = dm.locator("[data-pane-bar]");
    await bar.getByRole("button", { name: / below$/ }).click();
    await dm.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: sideTabName("Initiative") }).click();
    const aboleth = Object.values(dmSocket.state!.tokens).find((tk) => tk.name === "Aboleth")!;
    await ops!.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: aboleth.id }] });
    // Dice above throws a roll of its own, so the pane can hold the dice.
    await diceReady(dm, dmSocket);
    await watchThrow(dm);
    const before = diceLines(dmSocket.state?.log).length;
    // Roll sits beside the value box where the row has room, else in its options (combat.e2e.ts 5b).
    const roll = dm.getByRole("button", { name: /^Roll [+−-]\d+ Initiative for Aboleth$/ }).first();
    await dm.getByRole("button", { name: "Aboleth options" }).waitFor();
    if (!(await roll.isVisible())) await dm.getByRole("button", { name: "Aboleth options" }).click();
    await roll.click();
    const line = await waitFor("the initiative line", () => diceLines(dmSocket.state?.log).slice(before).find((l) => l.data.rolls[0]?.label === "Initiative")?.data ?? null);
    assert.ok(line.rolls[0]!.total > 0);
    await dm.waitForTimeout(1_500);
    assert.equal((await watched(dm)).canvasAt, null, "the tracker's Roll threw dice");
    await shots.take(dm, "ra-tracker-roll-no-dice");
    await ops!.send({ t: "encounter.end" });
    await bar.getByRole("button", { name: "Close Initiative", exact: true }).click();
    await bar.waitFor({ state: "detached" });
  });

  test("ra-6. the DM's secret roll throws on the DM's computer, and Pat's phone makes no dice", async (t) => {
    if (!(await needsWebGL(dm, t))) return;
    await openSideTab(dm, "Dice");
    await openDicePhone(player);
    await watchThrow(dm);
    await watchThrow(player);
    const before = diceLines(playerSocket.state?.log).length;
    await dm.getByRole("button", { name: "Hide from players" }).click();
    const line = await rollWithEnter(dm, dmSocket, "1d20+4 ra-6 secret");
    assert.equal(line.to, "dm");
    await seen(dm, "the DM's throw", (w) => w.canvasAt !== null);
    await waitFor("the bare line on Pat's phone", () => diceLines(playerSocket.state?.log).slice(before).find((l) => l.data.by === run.dmId) ?? null);
    await player.waitForTimeout(1_500);
    assert.equal((await watched(player)).canvasAt, null, "Pat's phone threw the DM's secret roll");
    await settled(dm);
  });

  test("ra-7. Pat's attack makes the DM's toast lead with a d20 showing Pat's face", async () => {
    // The DM's Dice panel off screen, so Pat's roll toasts.
    await openSideTab(dm, "DM");
    await openDicePhone(player);
    const attack = thornRolls(player).getByRole("button", { name: "Longsword", exact: true });
    await attack.scrollIntoViewIfNeeded();
    const count = diceLines(playerSocket.state?.log).length;
    await attack.tap();
    const line = await waitFor("Longsword's roll", () => diceLines(playerSocket.state?.log).slice(count).find((l) => l.data.rolls[0]?.label === "Longsword")?.data ?? null);
    const face = String(keptD20(line.rolls[0]!)!.face);
    const toast = dm.locator("[data-toast]").filter({ hasText: `Pat rolled ${line.rolls[0]!.total} for` }).filter({ hasText: "Longsword" });
    await toast.waitFor();
    const die = toast.locator("[data-toast-die]");
    assert.equal(await die.getAttribute("data-toast-die"), face);
    assert.equal(await die.locator("svg text").textContent(), face, "the icon shows Pat's face");
    assert.equal(await die.locator("svg").getAttribute("aria-hidden"), "true");
    await shots.take(dm, "ra-toast-d20");
    await settled(player);
  });

  test("ra-8. at 320 x 568 at 100% and 130%, a 20d6 throw and the dice set picker never scroll sideways, the tiles are 44 px, and the canvas is drawn at its screen size", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await player.setViewportSize({ width: 320, height: 568 });
    /** The "+N" disc's number against its disc, at each size. */
    const discs: number[] = [];
    for (const scale of [1, 1.3]) {
      const label = `320 x 568 at ${Math.round(scale * 100)}%`;
      await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      await diceReady(player, playerSocket);
      await watchThrow(player);
      await rollWithEnter(player, playerSocket, "20d6 ra-8");
      await seen(player, "the throw", (w) => w.canvasAt !== null);
      const hook = (await stageHook(player))!;
      assert.equal(await sideways(player, "[data-dice-last]"), 0, `${label}: the pane scrolls sideways during the throw`);
      const backing = hook.cssWidth * hook.ratio * hook.zoom;
      assert.ok(Math.abs(hook.width - backing) <= 1, `${label}: the canvas is ${hook.width} px wide, not ${backing} (${hook.cssWidth} CSS px, ratio ${hook.ratio}, zoom ${hook.zoom})`);
      // The "+N" disc's number is in the tray's own pixels, as the disc is, so it keeps one size inside it at every interface size (docs/design/design-v1-look-pass-2.md D37).
      const disc = await js<{ font: number; box: number } | null>(player, `const d = document.querySelector("[data-dice-more]"); if (!d) return null; return { font: parseFloat(getComputedStyle(d).fontSize), box: parseFloat(getComputedStyle(d).width) };`);
      assert.ok(disc, `${label}: 20d6 shows no +N disc`);
      discs.push(disc.font / disc.box);
      await shots.take(player, `ra-20d6-${Math.round(scale * 100)}`);
      await settled(player);
      const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
      await sheet.getByRole("button", { name: "Close Dice" }).tap();
      await sheet.waitFor({ state: "detached" });
      // The closed sheet steps back off its Back entry a moment later (harness.ts openPage), which would close the next sheet too.
      await player.waitForTimeout(500);

      await player.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
      await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).tap();
      await player.getByRole("button", { name: /^This device/ }).tap();
      const tiles = player.locator("[data-dice-set]");
      await tiles.first().scrollIntoViewIfNeeded();
      assert.equal(await tiles.count(), 8);
      for (const box of await Promise.all((await tiles.all()).map((tile) => tile.boundingBox()))) {
        assert.ok(box && box.width >= 44 && box.height >= 44, `${label}: a tile is ${box?.width} x ${box?.height}`);
      }
      assert.equal(await sideways(player, "[data-dice-set]"), 0, `${label}: This device scrolls sideways`);
      await shots.take(player, `ra-dice-picker-${Math.round(scale * 100)}`);
      await player.keyboard.press("Escape");
    }
    assert.ok(Math.abs(discs[1]! / discs[0]! - 1) < 0.01, `the +N disc's number grows inside its disc: ${discs.map((d) => d.toFixed(3)).join(" at 100%, ")} at 130%`);
    await player.setViewportSize({ width: 390, height: 844 });
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });

  test("ra-9. a roll still in the air as Pat closes the Dice sheet lands as a toast", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await openDicePhone(player);
    await diceReady(player, playerSocket);
    await watchThrow(player);
    const line = await rollWithEnter(player, playerSocket, "1d20 ra-9");
    await seen(player, "the throw", (w) => w.canvasAt !== null);
    const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
    await sheet.getByRole("button", { name: "Close Dice" }).tap();
    const w = await seen(player, "the close", (w) => w.downAt !== null);
    assert.ok(w.downAt! - w.canvasAt! < LAND_MS, "the sheet closed while the dice flew");
    await sheet.waitFor({ state: "detached" });
    await player.locator("[data-toast]").getByText(`Rolled ${line.rolls[0]!.total}: ra-9.`).waitFor();
    await shots.take(player, "ra-closed-mid-throw-toast");
  });

  test("ra-10. Escape during a throw shows the result and closes the Dice sheet in one event, so the result lands as a toast", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
    let total: number | null = null;
    // The key must come while the dice fly. A slow runner tries again rather than test a roll that has landed.
    for (let attempt = 0; attempt < 3 && total === null; attempt++) {
      await openDicePhone(player);
      await watchThrow(player);
      const line = await rollWithEnter(player, playerSocket, `1d20 ra-10 ${attempt}`);
      const w = await seen(player, "the throw", (w) => w.canvasAt !== null);
      // Escape in the formula field only leaves the field, so the key goes to the header line's Again.
      await player.locator("[data-dice-last]").getByRole("button", { name: "Again" }).focus();
      const flying = await js<number>(player, `return performance.now() - ${w.canvasAt};`);
      if (flying > LAND_MS - 300) {
        await settled(player);
        continue;
      }
      await player.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      total = line.rolls[0]!.total;
      await player.locator("[data-toast]").getByText(`Rolled ${total}: ra-10 ${attempt}.`).waitFor();
    }
    assert.ok(total !== null, "Escape never came while the dice flew");
    await shots.take(player, "ra-escape-mid-throw-toast");
  });

  test("fu22b-rolling. a roll whose answer waits past 200 ms says \"Rolling…\" on the sticky line, in no live region, since the result's own says it once it lands (review LP2L3)", async () => {
    // Another of Pat's phones, whose rolls never leave it while `hold` is on, so the panel waits on an answer that never comes.
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await context.addCookies(await playerContext.cookies(server.origin));
      const page = await context.newPage();
      const route = { hold: false, held: 0 };
      await page.routeWebSocket(/\/ws\?room=/, (ws) => {
        const upstream = ws.connectToServer();
        ws.onMessage((m) => {
          if (route.hold && typeof m === "string" && m.includes('"dice.roll"')) route.held++;
          else upstream.send(m);
        });
        upstream.onMessage((m) => ws.send(m));
      });
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(page);
      route.hold = true;
      await field(page).fill("1d20 Held");
      await field(page).press("Enter");
      await waitFor("the roll held on the phone", () => (route.held === 1 ? true : null));
      const rolling = page.locator("[data-dice-last]").getByText("Rolling…", { exact: true });
      await rolling.waitFor({ timeout: 3_000 });
      const live = await rolling.evaluate((el) => (el as unknown as { closest(s: string): { outerHTML: string } | null }).closest('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')?.outerHTML.slice(0, 120) ?? null);
      assert.equal(live, null, `"Rolling…" is in a live region: ${live}`);
      await shots.take(page, "dice-rolling-held");
    } finally {
      await context.close();
    }
  });

  test("dpf1-d1. a one-roll pick sends its own mode, the result line says what the server rolled, and the panel's Adv and Secret stay pressed", async () => {
    await player.setViewportSize({ width: 390, height: 844 });
    await player.emulateMedia({ reducedMotion: "reduce" });
    try {
      await openDicePhone(player);
      await setPanelModes(player, { adv: true, secret: true });
      const roll = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"]').getByRole("button", { name: "Roll", exact: true });

      await field(player).fill("1d20+1 Normal pick");
      let line = await menuRoll(player, playerSocket, roll, /^Roll options for Dice formula$/, "Roll normally");
      assert.deepEqual([line.to, line.rolls[0]?.mode, line.rolls[0]?.cancelled], ["all", undefined, undefined], "Normal drops the pressed Adv and Secret for this roll, to a player's default, public");
      assert.equal(await resultWords(player), "Normal");
      assert.deepEqual(await panelModes(player), { adv: true, dis: false, secret: true }, "and leaves both pressed");

      await field(player).fill("1d20+2 Dis pick");
      line = await menuRoll(player, playerSocket, roll, /^Roll options for Dice formula$/, "Roll with Disadvantage");
      assert.deepEqual([line.to, line.rolls[0]?.mode], ["dm", "dis"], "Disadvantage in place of the pressed Adv, keeping the pressed Secret");
      assert.equal(await resultWords(player), "Disadvantage, Secret");
      assert.deepEqual(await panelModes(player), { adv: true, dis: false, secret: true });

      // Restrained gives Disadvantage on Dexterity saves: the menu's Advantage cancels it, and the line says so.
      const effectId = randomUUID();
      await ops!.send({ t: "actor.effect.add", target: { characterId: run.thornId }, effect: { id: effectId, key: "restrained" } });
      try {
        const save = thornRolls(player).getByRole("button", { name: /^Dexterity save/ });
        await waitFor("Restrained on Pat's Thorn", () => playerSocket.state?.characters[run.thornId]?.actor.effects.some((e) => e.id === effectId) || null);
        await sleep(300);
        line = await menuRoll(player, playerSocket, save, /^Roll options for Dexterity save/, "Roll with Advantage");
        assert.deepEqual([line.rolls[0]?.mode, line.rolls[0]?.cancelled, line.to], [undefined, true, "dm"], "Advantage and Restrained's Disadvantage cancel");
        assert.equal(await resultWords(player), "Normal: Advantage and Disadvantage cancelled, Secret");
        line = await menuRoll(player, playerSocket, save, /^Roll options for Dexterity save/, "Roll normally");
        assert.deepEqual([line.rolls[0]?.mode, line.rolls[0]?.cancelled, line.to], ["dis", undefined, "all"], "Normal drops the pressed Adv, never Restrained");
        assert.equal(await resultWords(player), "Disadvantage");
      } finally {
        await ops!.send({ t: "actor.effect.remove", target: { characterId: run.thornId }, effectId });
      }
      assert.deepEqual(await panelModes(player), { adv: true, dis: false, secret: true }, "four picks pressed nothing and used nothing up");
      await shots.take(player, "dpf1-d1-result-words");
    } finally {
      await setPanelModes(player, { adv: false, secret: false });
      await player.emulateMedia({ reducedMotion: null });
    }
  });

  test("wx-ui-3. weather presets Disadvantage on Thorn's rolls only once his token stands on the weathered scene: heavy rain on Perception, strong wind on a ranged weapon and not a melee one, nothing with Weather rules on rolls off, and a roll sent with it rolls two dice", async () => {
    await player.setViewportSize({ width: 390, height: 844 });
    const sceneId = dmSocket.state!.meta.playerSceneId!;
    const weatherOn = (id: string) => playerSocket.state?.scenes[id]?.weather;
    const longbow = { id: "r-longbow", name: "Longbow", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", type: "piercing", mod: true }] };
    const javelin = { id: "r-javelin", name: "Javelin", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", type: "piercing", mod: true }] };
    await ops!.send({ t: "character.update", characterId: run.thornId, patch: { stats: { ...THORN_STATS, rolls: [...THORN_STATS.rolls, longbow, javelin] } } });
    const tokenId = randomUUID();
    try {
      await openDicePhone(player);
      const rolls = thornRolls(player);
      const perception = rolls.getByRole("button", { name: /^Perception/ });
      const bow = rolls.getByRole("button", { name: /^Longbow(?! damage)/ });
      const sword = rolls.getByRole("button", { name: /^Longsword(?! damage)/ });
      await ops!.send({ t: "scene.update", sceneId, patch: { weather: { kind: "rain", heavy: true, wind: "strong" } } });
      await waitFor("the weather on Pat's phone", () => weatherOn(sceneId)?.kind === "rain" || null);
      await sleep(300);
      assert.doesNotMatch((await perception.getAttribute("aria-label")) ?? (await perception.innerText()), /Heavy rain/, "Thorn has no token on the scene, so the rain does not bear on him");

      await ops!.send({ t: "token.create", token: { id: tokenId, sceneId, kind: "pc", name: "Thorn", size: "medium", x: 3, y: 3, visibility: "all", disposition: "ally", actor: { ref: run.thornId } } });
      await waitFor("Thorn's token on Pat's phone", () => playerSocket.state?.tokens[tokenId] ?? null);
      await waitFor("Perception names heavy rain", async () => (/Dis: Heavy rain/.test((await perception.getAttribute("aria-label")) ?? "") ? true : null));
      const names = async (button: Locator) => (await button.getAttribute("aria-label")) ?? (await button.innerText());
      await shots.take(player, "wx-ui-3-heavy-rain-strong-wind");
      // A thrown weapon's reminder and the bow's own Disadvantage, where the weapons' group shows them (WXB-3).
      await bow.scrollIntoViewIfNeeded();
      await sleep(200);
      await shots.take(player, "wxfix-dice-strong-wind");
      const WIND_NOTE = "Strong wind: Disadvantage on ranged attack rolls with weapons.";
      assert.match(await names(bow), /Dis: Strong wind/, "a ranged weapon takes strong wind's Disadvantage");
      assert.match(await bow.innerText(), /Dis/, "and shows it on its button");
      assert.doesNotMatch(await names(sword), /Dis: Strong wind/, "a melee weapon does not");
      const jav = rolls.getByRole("button", { name: /^Javelin(?! damage)/ });
      assert.equal(await names(jav), `Javelin, ${WIND_NOTE}`, "a thrown weapon names the reminder, with no preset");
      await rolls.getByText(`Longbow Dis: Strong wind. ${WIND_NOTE}`, { exact: true }).waitFor();
      // The weapons' line and the bow's tag in line on a phone, at 100% and 130%.
      const lines: string[] = [];
      for (const scale of [1, 1.3]) {
        await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await player.goto(`${server.origin}/r/${run.roomId}`);
        await player.getByRole("status", { name: "Connected" }).first().waitFor();
        await openDicePhone(player);
        for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
          await player.setViewportSize(size);
          await sleep(200);
          const weapons = rolls.getByRole("group", { name: "Actions", exact: true });
          await bow.scrollIntoViewIfNeeded();
          await sleep(200);
          lines.push(...alignmentLines(await measureAlignment(weapons), `weapons in strong wind ${size.width}x${size.height} ${Math.round(scale * 100)}%`));
        }
      }
      await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await player.setViewportSize({ width: 390, height: 844 });
      await player.goto(`${server.origin}/r/${run.roomId}`);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      assert.deepEqual(lines, [], "the weapons' line and the bow's tag out of line");

      const before = diceLines(playerSocket.state?.log).length;
      await perception.tap();
      const sent = await waitFor("Perception's roll", () => diceLines(playerSocket.state?.log).slice(before).find((l) => /Perception/.test(l.data.rolls[0]?.label ?? ""))?.data ?? null);
      assert.equal(sent.rolls[0]?.mode, "dis", "heavy rain's Disadvantage rolled two dice");
      assert.equal(sent.rolls[0]?.faces.length, 2);

      await ops!.send({ t: "scene.update", sceneId, patch: { weather: { kind: "rain", heavy: true, wind: "strong", rules: false } } });
      await waitFor("Perception without the rule", async () => (!/Dis: Heavy rain/.test(await names(perception)) && !/Dis: Strong wind/.test(await names(bow)) ? true : null));
    } finally {
      await ops!.send({ t: "scene.update", sceneId, patch: { weather: null } });
      await ops!.send({ t: "token.delete", tokenId }).catch(() => undefined);
      await ops!.send({ t: "character.update", characterId: run.thornId, patch: { stats: THORN_STATS } });
    }
  });

  test("wxfix-r2-3. what patchy fog and Frightened remind Thorn's rolls of shows before he rolls, once under each group it bears on and under Initiative on his card, in line on a phone at 100% and 130% and at 1440 x 900", async () => {
    await player.setViewportSize({ width: 390, height: 844 });
    const sceneId = dmSocket.state!.meta.playerSceneId!;
    const bounds = dmSocket.state!.scenes[sceneId]!.bounds;
    const FOG = "Patchy fog: Lightly Obscured. Disadvantage on Perception checks that rely on sight.";
    const CHECKS = "Frightened: Disadvantage on ability checks while the source of fear is within line of sight.";
    const INITIATIVE = "Frightened: Disadvantage on Initiative, a Dexterity check, while the source of fear is within line of sight.";
    const at = { x: 3, y: 3 };
    const tokenId = randomUUID();
    const effectId = randomUUID();
    const group = (rolls: Locator, name: string) => rolls.locator("[data-panel-group]").filter({ has: rolls.page().getByRole("button", { name, exact: true }) });
    // Said where a sighted player reads it before a tap, once in each group: never only in a button's name.
    const shown = async (rolls: Locator, where: string) => {
      const card = rolls.locator("[data-dice-card]");
      const saves = group(rolls, "Saves and checks");
      const skills = group(rolls, "Skills");
      for (const [inside, text, label] of [[skills, FOG, "fog under Skills"], [saves, CHECKS, "Frightened under Saves and checks"], [skills, CHECKS, "Frightened under Skills"], [card, INITIATIVE, "Frightened under Initiative"]] as const) {
        // A group's reminders share its one line, as an attacks group's do.
        const line = inside.locator("p").filter({ hasText: text });
        await line.first().waitFor();
        assert.equal(await line.count(), 1, `${where}: ${label} said once`);
        await line.scrollIntoViewIfNeeded();
        assert.ok(await line.isVisible(), `${where}: ${label} shows`);
      }
      assert.equal(await saves.locator("p").filter({ hasText: FOG }).count(), 0, `${where}: fog bears on no save and no ability check`);
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await diceFoldsOpen(context);
    try {
      await ops!.send({ t: "token.create", token: { id: tokenId, sceneId, kind: "pc", name: "Thorn", size: "medium", ...at, visibility: "all", disposition: "ally", actor: { ref: run.thornId } } });
      await ops!.send({ t: "actor.effect.add", target: { characterId: run.thornId }, effect: { id: effectId, key: "frightened" } });
      await ops!.send({ t: "scene.update", sceneId, patch: { weather: { kind: "fog" } } });
      await waitFor("the fog on Pat's phone", () => playerSocket.state?.scenes[sceneId]?.weather?.kind === "fog" || null);
      await openDicePhone(player);
      const rolls = thornRolls(player);
      const perception = rolls.getByRole("button", { name: /^Perception/ });
      await waitFor("Perception names the fog", async () => ((await perception.getAttribute("aria-label"))?.includes(FOG) ? true : null));
      // Where the Skills start, the top of the list a player scrolls down to Perception.
      await rolls.getByRole("button", { name: /^Acrobatics/ }).scrollIntoViewIfNeeded();
      await sleep(200);
      await shots.take(player, "wxfix-r2-fog-skills");
      await rolls.getByRole("button", { name: /^Initiative/ }).scrollIntoViewIfNeeded();
      await sleep(200);
      await shots.take(player, "wxfix-r2-frightened-card");
      await shown(rolls, "390 x 844");

      // Each line in line with its group on a phone, at 100% and 130%.
      const lines: string[] = [];
      for (const scale of [1, 1.3]) {
        await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await player.goto(`${server.origin}/r/${run.roomId}`);
        await player.getByRole("status", { name: "Connected" }).first().waitFor();
        await openDicePhone(player);
        for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
          const screen = `${size.width}x${size.height} ${Math.round(scale * 100)}%`;
          await player.setViewportSize(size);
          await sleep(200);
          await shown(rolls, screen);
          for (const [name, part] of [["card", rolls.locator("[data-dice-card]")], ["Saves and checks", group(rolls, "Saves and checks")], ["Skills", group(rolls, "Skills")]] as const) {
            await part.scrollIntoViewIfNeeded();
            await sleep(200);
            lines.push(...alignmentLines(await measureAlignment(part), `${name} in fog, Frightened, ${screen}`));
          }
        }
      }
      await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await player.setViewportSize({ width: 390, height: 844 });
      await player.goto(`${server.origin}/r/${run.roomId}`);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);

      // The DM's computer at 1440 x 900, Thorn picked on the map.
      await context.addCookies(await dmContext.cookies(server.origin));
      const page = await context.newPage();
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      await tapCell(page, bounds, at);
      await openSideTab(page, "Dice");
      const there = page.getByRole("tabpanel", { name: sideTabName("Dice") }).getByRole("region", { name: "Rolls for Thorn" });
      await shown(there, "1440 x 900");
      for (const [name, part] of [["card", there.locator("[data-dice-card]")], ["Saves and checks", group(there, "Saves and checks")], ["Skills", group(there, "Skills")]] as const) {
        await part.scrollIntoViewIfNeeded();
        await sleep(200);
        lines.push(...alignmentLines(await measureAlignment(part), `${name} in fog, Frightened, 1440x900 100%`));
      }
      await there.locator("p").filter({ hasText: FOG }).scrollIntoViewIfNeeded();
      await sleep(200);
      await shots.take(page, "wxfix-r2-fog-1440");
      assert.deepEqual(lines, [], "a reminder's line out of line");
    } finally {
      await context.close();
      await ops!.send({ t: "scene.update", sceneId, patch: { weather: null } });
      await ops!.send({ t: "actor.effect.remove", target: { characterId: run.thornId }, effectId }).catch(() => undefined);
      await ops!.send({ t: "token.delete", tokenId }).catch(() => undefined);
    }
  });

  test("dpf1-d2. Again's menu repeats a secret roll's formula with the chosen mode, still secret and with its label", async () => {
    await player.emulateMedia({ reducedMotion: "reduce" });
    try {
      await openDicePhone(player);
      await setPanelModes(player, { adv: false, secret: true });
      const first = await rollWithEnter(player, playerSocket, "1d20+3 Perception");
      assert.equal(first.to, "dm");
      const again = player.locator('dialog[data-rvtt-sheet][aria-label="Dice"] [data-dice-last]').getByRole("button", { name: "Again", exact: true });
      await focusStill(again);
      await player.keyboard.press("ContextMenu");
      const menu = rollMenu(player, /^Roll options for Again$/);
      await menu.waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: "Roll secretly" }).getAttribute("aria-disabled"), "true", "a repeat keeps its recorded visibility");
      const before = diceLines(playerSocket.state?.log).length;
      await menu.getByRole("menuitem", { name: "Roll with Disadvantage" }).click();
      const line = await waitFor("the repeat", () => diceLines(playerSocket.state?.log).slice(before).at(-1)?.data ?? null);
      assert.deepEqual([line.to, line.rolls[0]?.mode, line.rolls[0]?.label], ["dm", "dis", "Perception"], "secret as recorded, Disadvantage, its own label");
      assert.match(line.rolls[0]!.formula, /^2d20kl1\+3$/, "the recorded 1d20+3 with Disadvantage");
      assert.equal(await resultWords(player), "Disadvantage, Secret");
      assert.deepEqual(await panelModes(player), { adv: false, dis: false, secret: false }, "the first roll used the pressed Secret, the repeat nothing");
    } finally {
      await setPanelModes(player, { adv: false, secret: false });
      await player.emulateMedia({ reducedMotion: null });
    }
  });

  test("dpf1-d3. the damage menu offers no Advantage, and its Secret sends a critical with its rider once, the Critical going as after a tap", async () => {
    await player.emulateMedia({ reducedMotion: "reduce" });
    try {
      await openDicePhone(player);
      const rolls = thornRolls(player);
      const critical = rolls.getByRole("button", { name: "Critical Hit for Longsword's next damage", exact: true });
      // The Longsword's own rider: the long weapon of step 17 has one of the same name.
      const smite = namedRow(rolls.getByRole("button", { name: "Longsword", exact: true })).getByRole("button", { name: "Divine Smite: add 2d8 to the next damage", exact: true });
      await critical.click();
      await smite.click();
      assert.equal(await critical.getAttribute("aria-pressed"), "true");
      assert.equal(await smite.getAttribute("aria-pressed"), "true");
      const damage = rolls.getByRole("button", { name: /^Longsword damage/ });
      await focusStill(damage);
      await player.keyboard.press("ContextMenu");
      const menu = rollMenu(player, /^Roll options for Longsword damage/);
      // No Roll normally either, with nothing pressed in the panel: a tap already rolls it so (D-261031-078).
      assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Roll secretly"], "no d20 choice for damage");
      const before = diceLines(playerSocket.state?.log).length;
      await menu.getByRole("menuitem", { name: "Roll secretly" }).click();
      const line = await waitFor("the damage", () => diceLines(playerSocket.state?.log).slice(before).at(-1)?.data ?? null);
      await sleep(400);
      assert.equal(diceLines(playerSocket.state?.log).length, before + 1, "one damage line");
      assert.equal(line.to, "dm");
      assert.deepEqual(line.rolls.map((r) => [r.type, r.crit !== undefined, r.mode]), [["slashing", true, undefined], ["radiant", true, undefined]], "the weapon's and the rider's dice, both critical, no mode");
      await waitFor("the Critical let go", async () => ((await critical.getAttribute("aria-pressed")) === "false" ? true : null));
      if ((await smite.getAttribute("aria-pressed")) === "true") await smite.click();
    } finally {
      await player.emulateMedia({ reducedMotion: null });
    }
  });

  test("dpf1-d4. a pick the server refuses, one whose answer never comes, and one lost with its socket each leave the panel's Adv pressed", async () => {
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    try {
      await context.addCookies(await playerContext.cookies(server.origin));
      const page = await context.newPage();
      const route: { spoil: boolean; hold: boolean; held: number; socket: { close(): Promise<void> } | null } = { spoil: false, hold: false, held: 0, socket: null };
      await page.routeWebSocket(/\/ws\?room=/, (ws) => {
        const upstream = ws.connectToServer();
        route.socket = ws;
        ws.onMessage((m) => {
          if (typeof m === "string" && m.includes('"dice.roll"')) {
            if (route.hold) {
              route.held++;
              return;
            }
            // A die of no sides, which the server refuses in its own words.
            if (route.spoil) return upstream.send(m.replace(/"formula":"1d20/, '"formula":"1d0'));
          }
          upstream.send(m);
        });
        upstream.onMessage((m) => ws.send(m));
      });
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(page);
      await setPanelModes(page, { adv: true, secret: false });
      const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
      const roll = sheet.getByRole("button", { name: "Roll", exact: true });
      const line = sheet.locator("[data-dice-last]");
      const pick = async (formula: string) => {
        await field(page).fill(formula);
        await focusStill(roll);
        await page.keyboard.press("ContextMenu");
        await rollMenu(page, /^Roll options for Dice formula$/).getByRole("menuitem", { name: "Roll with Disadvantage" }).click();
      };

      route.spoil = true;
      await pick("1d20+1 Refused");
      await line.getByRole("alert").waitFor();
      route.spoil = false;
      assert.deepEqual(await panelModes(page), { adv: true, dis: false, secret: false }, "a refusal left Adv pressed");

      route.hold = true;
      await pick("1d20+2 Held");
      await waitFor("the pick held", () => (route.held === 1 ? true : null));
      await line.getByText("Rolling…", { exact: true }).waitFor({ timeout: 3_000 });
      assert.deepEqual(await panelModes(page), { adv: true, dis: false, secret: false }, "a pick waiting on its answer left Adv pressed");
      // The socket goes with the pick unanswered. The page sends it again or finds it never landed, and either way takes nothing from the panel.
      await route.socket!.close();
      route.hold = false;
      await line.getByText(/^This may have happened|^\d/).first().waitFor({ timeout: 15_000 });
      assert.deepEqual(await panelModes(page), { adv: true, dis: false, secret: false }, "a pick lost with its socket left Adv pressed");
      await shots.take(page, "dpf1-d4-unknown");
    } finally {
      await context.close();
    }
  });

  test("fu42b-hidden. a group save rolled in the side panel and hidden before its answer: a toast says it, and shown again the page holds the results and says nothing more (HIDDEN-WATCHERS)", async () => {
    const sceneId = dmSocket.state!.meta.playerSceneId!;
    const bounds = dmSocket.state!.scenes[sceneId]!.bounds;
    const goblins = [{ id: randomUUID(), x: 6, y: 2 }, { id: randomUUID(), x: 8, y: 2 }];
    for (const [i, g] of goblins.entries()) {
      await ops!.send({ t: "token.create", token: { id: g.id, sceneId, kind: "monster", name: `Hidden goblin ${i + 1}`, size: "medium", x: g.x, y: g.y, visibility: "all", disposition: "hostile", actor: { inline: { ...THORN_ACTOR, srdId: "goblin-warrior" } } } });
    }
    // A second DM computer, its socket routed from the start so the save's roll can wait on the wire.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      await context.addCookies(await dmContext.cookies(server.origin));
      const page = await context.newPage();
      const wire: { hold: boolean; held: string[]; up: WebSocketRoute | null } = { hold: false, held: [], up: null };
      await page.routeWebSocket(/\/ws\?room=/, (ws) => {
        const upstream = ws.connectToServer();
        wire.up = upstream;
        ws.onMessage((m) => {
          if (wire.hold && typeof m === "string" && m.includes('"dice.roll"')) wire.held.push(m);
          else upstream.send(m);
        });
        upstream.onMessage((m) => ws.send(m));
      });
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      await tapCell(page, bounds, goblins[0]!);
      await page.keyboard.down("Shift");
      await tapCell(page, bounds, goblins[1]!);
      await page.keyboard.up("Shift");
      await page.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
      await openSideTab(page, "Dice");
      const rolls = page.locator('section[aria-label="Group rolls"]');
      await rolls.waitFor();
      const toasts = () => page.locator("[data-toast]").filter({ hasText: /^Rolled / }).count();
      const before = await toasts();
      wire.hold = true;
      await rolls.getByRole("button", { name: "DEX save for 2", exact: true }).click();
      await waitFor("the save's roll held on the wire", () => (wire.held.length > 0 ? true : null), 10_000);
      const creatures = page.getByRole("group", { name: "Creatures" });
      await creatures.waitFor();
      await page.getByRole("button", { name: "Hide panels" }).click();
      await creatures.waitFor({ state: "hidden" });
      wire.hold = false;
      for (const m of wire.held.splice(0)) wire.up?.send(m);
      // The page's rows and its watcher of the roll are mounted but hidden, so they watch nothing and the toast says it.
      await waitFor("a toast for the roll nobody sees", async () => ((await toasts()) > before ? true : null), 5_000);
      const heard = (await toasts()) - before;
      await shots.take(page, "fu42b-hidden-group-save-toast");
      await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
      await creatures.waitFor();
      // Shown again, the page takes the results it deferred.
      await waitFor("both rows rolled", async () => ((await creatures.getByText(/^Rolled \d/).count()) === 2 ? true : null), 5_000);
      await sleep(600);
      assert.equal((await toasts()) - before, heard, "no second toast once shown");
      await shots.take(page, "fu42b-hidden-group-save-shown");
    } finally {
      await context.close();
      for (const g of goblins) await ops!.send({ t: "token.delete", tokenId: g.id }).catch(() => undefined);
    }
  });

  test("trh-0. the token screen's room: Vex for Pat, a short Sprite and a goblin for the DM, and the DM's panel groups folded", async () => {
    const sceneId = dmSocket.state!.meta.playerSceneId!;
    await ops!.send({ t: "character.create", character: { id: trh.vexId, name: "Vex", size: "medium", ownerIds: [run.patId], actor: THORN_ACTOR, level: 3, stats: THORN_STATS } });
    await ops!.send({ t: "monster.create", monster: { ...SPRITE_BLOCK, id: trh.sprite.monster, name: "Sprite" } });
    const inline = { ...THORN_ACTOR, hp: { cur: 7, max: 7, temp: 0 }, ac: 12, initBonus: 2 };
    await ops!.send({ t: "token.create", token: { id: trh.sprite.token, sceneId, kind: "monster", name: "Sprite", size: "small", ...trh.sprite.at, visibility: "all", disposition: "hostile", actor: { inline: { ...inline, monsterId: trh.sprite.monster } } } });
    await ops!.send({ t: "token.create", token: { id: trh.bramble.token, sceneId, kind: "monster", name: "Bramble", size: "medium", ...trh.bramble.at, visibility: "all", disposition: "hostile", actor: { inline: { ...THORN_ACTOR, srdId: "goblin-warrior" } } } });
    await waitFor("Vex on Pat's phone", () => playerSocket.state?.characters[trh.vexId]?.stats ?? null);
    await waitFor("the Sprite on the DM's page", () => dmSocket.state?.tokens[trh.sprite.token] ?? null);
    await dm.evaluate((v) => localStorage.setItem("rvtt.tokenPanelFolds", v), SHORT_PANEL);
    await closeAll(dm);
    await dm.setViewportSize({ width: 1440, height: 900 });
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    await closeAll(player);
    await player.setViewportSize({ width: 390, height: 844 });
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("trh-1. Pat taps DEX, Check, on Thorn's page at 390 x 844: the line goes in at the pane's top with anchoring off and the box still, the dice fly from the box, and the total lands on the chip's face within 1,100 ms", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await warmDice(player, playerSocket);
    const sheet = await characterPage(player, run.thornId, "Thorn");
    assert.equal(await headerOf(sheet).count(), 0, "no header before a roll");
    const box = abilityBox(sheet, "Dexterity");
    await watchHeader(box);
    const count = diceLines(playerSocket.state?.log).length;
    await pickRow(player, sheet, "Dexterity", /^Dexterity check/);
    const line = await waitFor("the check's line", () => diceLines(playerSocket.state?.log).slice(count).at(-1)?.data ?? null);
    const mid = await headerSeen(player, "the dice in the air", (w) => w.canvasAt !== null);
    assert.equal(mid.canvasIn, "own", "the dice hang in the panel's own tray");
    assert.equal(mid.totalAtCanvas, false, "the header held no total as the dice flew");
    assert.ok(mid.anchorOff, "the host turned the scroller's anchoring off for the insert");
    const header = headerOf(sheet);
    const pane = await scrollerOf(box);
    const top = (await header.boundingBox())!;
    assert.ok(top.y <= pane.top + 1 && top.y + top.height > pane.top, `the line sits at the pane's top: ${top.y} in a pane from ${pane.top}`);
    await shots.take(player, "trh-1-thorn-mid-throw");
    const w = await headerSeen(player, "the total", (w) => w.totalAt !== null);
    const land = w.totalAt! - w.canvasAt!;
    assert.ok(land >= 700 && land <= 1_100, `the total showed ${Math.round(land)} ms after the dice`);
    assert.ok(w.canvasGoneAt === null || w.canvasGoneAt >= w.totalAt!, "the dice stayed until the total showed");
    const chip = await header.locator("[data-face]").first().textContent();
    assert.equal(chip, String(line.rolls[0]!.faces[0]));
    assert.equal(await landedFace(player), chip, "the die landed on the face its chip shows");
    await settled(player);
    const after = await headerWatched(player);
    assert.ok(after.maxDrift <= 1, `the DEX box moved ${after.maxDrift} px`);
    assert.equal((await scrollerOf(box)).anchor, "auto", "anchoring is back on after the insert");
    assert.deepEqual(alignmentLines(await measureAlignment(header), "trh-1 390 x 844"), [], "the line is aligned");
    await shots.take(player, "trh-1-thorn-landed");
  });

  test("trh-1b. a phone sheet below its cap grows upward by the line: its scroll stays 0, the box stays, and the whole throw plays", async (t) => {
    // A tall phone, since every stat block outgrows a 390 x 844 sheet's cap: here the Sprite's panel fits below it.
    const context = await browser.newContext({ viewport: { width: 390, height: 2000 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await context.addCookies(await dmContext.cookies(server.origin));
      const page = await context.newPage();
      const quiet = new ConsoleWatch("dm-phone");
      quiet.attach(page);
      const socket = new SocketWatch("dm-phone");
      await socket.attach(context, page);
      if (!(await needsWebGL(page, t))) return;
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.evaluate((v) => localStorage.setItem("rvtt.tokenPanelFolds", v), SHORT_PANEL);
      await reopenRoom(page);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      await warmDice(page, socket);
      const panel = await tokenPanel(page, "Sprite", trh.sprite.at);
      const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Token"]');
      const size = async () => ({ height: (await sheet.boundingBox())!.height });
      await sleep(400);
      const cap = await sheet.evaluate((d) => {
        // The sheet's cap: its max-height as the layout works it out, read by asking for the whole window for one synchronous layout.
        const e = d as unknown as { style: { height: string }; getBoundingClientRect(): { height: number } };
        const was = e.style.height;
        e.style.height = "100vh";
        const h = e.getBoundingClientRect().height;
        e.style.height = was;
        return h;
      });
      const before = await size();
      assert.ok(before.height < cap - 49, `the sheet stands below its cap: ${before.height} of ${cap} px`);
      const box = abilityBox(panel, "Dexterity");
      await watchHeader(box);
      await pickRow(page, panel, "Dexterity", /^Dexterity check/);
      const w = await headerSeen(page, "the total", (w) => w.totalAt !== null);
      const after = await size();
      const pane = await scrollerOf(box);
      assert.ok(after.height > before.height + 40, `the sheet grew by the line: ${before.height} then ${after.height} px`);
      assert.equal(pane.scrollTop, 0, "the content did not scroll");
      assert.ok(w.maxDrift <= 1, `the box moved ${w.maxDrift} px`);
      assert.equal(w.canvasIn, "own", "the dice threw in the sheet's tray");
      assert.ok(w.canvasGoneAt === null || w.canvasGoneAt >= w.totalAt!, "the sheet's growth did not end the throw before its total");
      assert.ok(w.totalAt! - w.canvasAt! >= 700, `the throw played to its landing: ${Math.round(w.totalAt! - w.canvasAt!)} ms`);
      await shots.take(page, "trh-1b-sheet-grew");
      assert.deepEqual(quiet.errors, []);
    } finally {
      await context.close();
    }
  });

  test("trh-2. at 320 x 568 at 130% on Thorn's page and at 1440 x 900 on a monster's panel the box stays, the line and tray stay inside the pane and nothing scrolls sideways, and on a 2560 x 1440 screen the short panel's foot spacer makes room", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    try {
      await closeAll(player);
      await player.setViewportSize({ width: 320, height: 568 });
      await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await warmDice(player, playerSocket);
      const sheet = await characterPage(player, run.thornId, "Thorn");
      const box = abilityBox(sheet, "Dexterity");
      await box.scrollIntoViewIfNeeded();
      await watchHeader(box);
      await pickRow(player, sheet, "Dexterity", /^Dexterity check/);
      await headerSeen(player, "the dice in the air", midThrow);
      const header = headerOf(sheet);
      const tray = header.locator("[data-dice-tray]");
      const inPane = [...(await containmentLines(header, "trh-2 320 line")), ...(await containmentLines(tray, "trh-2 320 tray"))];
      await shots.take(player, "trh-2-thorn-320-130-mid-throw");
      const w = await headerSeen(player, "the total", (w) => w.totalAt !== null);
      assert.equal(w.canvasIn, "own");
      await settled(player);
      assert.ok((await headerWatched(player)).maxDrift <= 1, `320 x 568 at 130%: the DEX box moved ${(await headerWatched(player)).maxDrift} px`);
      assert.deepEqual(inPane, [], "the line and the tray stay inside the pane");
      assert.equal(await sideways(player, "[data-block-header]"), 0, "the sheet never scrolls sideways");
      assert.deepEqual(alignmentLines(await measureAlignment(header), "trh-2 320 x 568 at 130%"), [], "the line is aligned");
      await shots.take(player, "trh-2-thorn-320-130-landed");
    } finally {
      await closeAll(player);
      await player.setViewportSize({ width: 390, height: 844 });
      await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
    }

    // The DM's Sprite at 1440 x 900.
    await warmDice(dm, dmSocket);
    let panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    let box = abilityBox(panel, "Dexterity");
    await box.scrollIntoViewIfNeeded();
    await watchHeader(box);
    await pickRow(dm, panel, "Dexterity", /^Dexterity check/, "click");
    await headerSeen(dm, "the dice in the air", midThrow);
    const header = headerOf(panel);
    const tray = [...(await containmentLines(header, "trh-2 1440 line")), ...(await containmentLines(header.locator("[data-dice-tray]"), "trh-2 1440 tray"))];
    const w = await headerSeen(dm, "the total", (w) => w.totalAt !== null);
    assert.equal(w.canvasIn, "own");
    await settled(dm);
    assert.ok((await headerWatched(dm)).maxDrift <= 1, `1440 x 900: the DEX box moved ${(await headerWatched(dm)).maxDrift} px`);
    assert.deepEqual(tray, [], "the line and the tray stay inside the pane");
    assert.equal(await sideways(dm, "[data-block-header]"), 0, "the panel never scrolls sideways");
    assert.deepEqual(alignmentLines(await measureAlignment(header), "trh-2 1440 x 900"), [], "the line is aligned");
    await shots.take(dm, "trh-2-sprite-1440-landed");

    // On a 2560 x 1440 screen the Sprite's folded panel is shorter than its pane, so the scroll that keeps the box still needs the foot spacer's room.
    try {
      await dm.setViewportSize({ width: 2560, height: 1440 });
      await tokenPanel(dm, "Bramble", trh.bramble.at);
      panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
      box = abilityBox(panel, "Dexterity");
      await sleep(300);
      const short = await scrollerOf(box);
      assert.ok(short.scrollHeight <= short.clientHeight, `the panel is shorter than its pane: ${JSON.stringify(short)}`);
      await watchHeader(box);
      await pickRow(dm, panel, "Dexterity", /^Dexterity save/, "click");
      await headerSeen(dm, "the total", (w) => w.totalAt !== null);
      await settled(dm);
      const after = await scrollerOf(box);
      assert.ok(after.spacer > 0, `the foot spacer took the shortfall: ${after.spacer} px`);
      assert.ok(after.scrollTop > 0, "and the pane scrolled by the line");
      assert.ok((await headerWatched(dm)).maxDrift <= 1, `2560 x 1440: the DEX box moved ${(await headerWatched(dm)).maxDrift} px`);
      await shots.take(dm, "trh-2-sprite-2560-spacer");
    } finally {
      await dm.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("trh-3. two panels on a computer, Dice below the Token panel: a block roll throws and decorates in the token panel only, a Dice panel roll in the Dice panel only, and the Dice panel's going mid-throw leaves the block's throw to land", async (t) => {
    if (!(await needsWebGL(dm, t))) return;
    await warmDice(dm, dmSocket);
    const panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    const tabs = dm.getByRole("tablist", { name: "Panels" });
    const bar = dm.locator("[data-pane-bar]");
    if ((await bar.count()) === 0) {
      await tabs.locator('[role="tab"][aria-haspopup="menu"]').click();
      await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
      await dm.getByRole("menu", { name: "More panels" }).waitFor({ state: "detached" });
    }
    const below = async (name: string) => {
      await bar.getByRole("button", { name: / below$/ }).click();
      await dm.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: sideTabName(name) }).click();
      await dm.getByRole("group", { name: `${name} below`, exact: true }).waitFor();
    };
    try {
      await below("Dice");
      const dice = dm.getByRole("group", { name: "Dice below", exact: true });
      const box = abilityBox(panel, "Dexterity");
      await box.scrollIntoViewIfNeeded();
      // A block roll: the canvas, the scrim and any ring in the token panel's tray, none in the Dice panel's.
      await watchHeader(box);
      await pickRow(dm, panel, "Dexterity", /^Dexterity save/, "click");
      const block = await headerSeen(dm, "the block's total", (w) => w.totalAt !== null);
      assert.equal(block.canvasIn, "own", "the block's dice hang in the token panel");
      assert.ok(block.ownDecor, "its scrim is in the token panel's tray");
      assert.equal(block.foreignDecor, false, "the Dice panel's tray drew nothing");
      await shots.take(dm, "trh-3-block-roll-beside-dice");
      await settled(dm);
      const headerText = await headerOf(panel).locator("[data-block-header-row]").innerText();
      // A Dice panel roll: the reverse, and the token panel's header unchanged.
      await watchHeader(box);
      const count = diceLines(dmSocket.state?.log).length;
      await field(dice).fill("1d20 trh-3");
      await field(dice).press("Enter");
      await waitFor("the Dice panel's roll", () => (diceLines(dmSocket.state?.log).length > count ? true : null));
      const panelRoll = await headerSeen(dm, "the Dice panel's dice", (w) => w.canvasAt !== null);
      assert.equal(panelRoll.canvasIn, "dice", "the Dice panel's dice hang in its own tray");
      await settled(dm);
      const seen = await headerWatched(dm);
      assert.equal(seen.ownDecor, false, "the token panel's tray drew nothing");
      assert.equal(await headerOf(panel).locator("[data-block-header-row]").innerText(), headerText, "the token panel's header is unchanged");
      // The Dice panel goes mid-throw, the pane under it swapped for another so the token pane keeps its size: the block's dice still land.
      await watchHeader(box);
      await pickRow(dm, panel, "Dexterity", /^Dexterity check/, "click");
      await headerSeen(dm, "the block's dice in the air", midThrow);
      await below("Initiative");
      await dice.waitFor({ state: "detached" });
      const landed = await headerSeen(dm, "the block's total", (w) => w.totalAt !== null);
      assert.ok(landed.canvasGoneAt === null || landed.canvasGoneAt >= landed.totalAt!, "the block's throw went on to its landing");
      assert.ok(landed.totalAt! - landed.canvasAt! >= 700, `the dice flew ${Math.round(landed.totalAt! - landed.canvasAt!)} ms`);
      await settled(dm);
    } finally {
      if ((await bar.count()) > 0) {
        for (const name of ["Close Initiative", "Close Dice"]) await dm.getByRole("button", { name, exact: true }).click({ timeout: 2_000 }).catch(() => undefined);
        await bar.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined);
      }
    }
  });

  test("trh-4. mid-throw on the DM's computer: a tap on another box shows the result and opens its list, another token selected gives one toast and a panel with no line, and Hide then show gives one toast and keeps the line, silent", async (t) => {
    if (!(await needsWebGL(dm, t))) return;
    await warmDice(dm, dmSocket);
    let panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    let box = abilityBox(panel, "Dexterity");
    await box.scrollIntoViewIfNeeded();
    // A tap on another box: the total at once, and the box's list opens.
    await watchHeader(box);
    await pickRow(dm, panel, "Dexterity", /^Dexterity check/, "click");
    const mid = await headerSeen(dm, "the dice in the air", midThrow);
    await abilityBox(panel, "Strength").click();
    const tapped = await js<number>(dm, "return performance.now();");
    await dm.getByRole("menu", { name: "Strength rolls" }).waitFor();
    const shown = await headerSeen(dm, "the total", (w) => w.totalAt !== null, 2_000);
    assert.ok(shown.totalAt! - mid.canvasAt! < 900, `the tap showed the total at once, ${Math.round(shown.totalAt! - mid.canvasAt!)} ms into the throw`);
    assert.ok(shown.totalAt! <= tapped + 50, "by the tap's click");
    await dm.keyboard.press("Escape");
    await dm.getByRole("menu", { name: "Strength rolls" }).waitFor({ state: "detached" });
    await settled(dm);

    // Another token selected mid-throw: the panel unmounts, so one toast says the roll nobody saw, and the new panel has no line.
    const toasts = (label: RegExp) => dm.locator("[data-toast]").filter({ hasText: label }).count();
    await watchHeader(box);
    await pickRow(dm, panel, "Wisdom", /^Wisdom check/, "click");
    await headerSeen(dm, "the dice in the air", midThrow);
    // No Escape first: a key in the panel would end the throw itself.
    const bramble = await tokenPanel(dm, "Bramble", trh.bramble.at, false);
    await waitFor("the unseen roll's toast", async () => ((await toasts(/Wisdom check/)) > 0 ? true : null), 5_000);
    await sleep(500);
    assert.equal(await toasts(/Wisdom check/), 1, "one own-roll toast");
    assert.equal(await headerOf(bramble).count(), 0, "the new token's panel has no line");

    // Hide mid-throw, then show: one toast, and the line kept, saying nothing more.
    panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    box = abilityBox(panel, "Dexterity");
    await box.scrollIntoViewIfNeeded();
    await watchHeader(box);
    await pickRow(dm, panel, "Charisma", /^Charisma check/, "click");
    await headerSeen(dm, "the dice in the air", midThrow);
    await dm.getByRole("button", { name: "Hide panels" }).click();
    await panel.waitFor({ state: "hidden" });
    await waitFor("the hidden roll's toast", async () => ((await toasts(/Charisma check/)) > 0 ? true : null), 5_000);
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await panel.waitFor();
    const header = headerOf(panel);
    await header.locator("[data-result-label]").filter({ hasText: /Charisma check/ }).waitFor();
    await sleep(600);
    assert.equal(await toasts(/Charisma check/), 1, "one toast, and none more once shown");
    const said = (await header.locator('[role="status"], [role="alert"]').allInnerTexts()).filter((t) => t.trim() !== "");
    assert.deepEqual(said, [], "the line shown again says nothing");
    await shots.take(dm, "trh-4-shown-again");
  });

  test("trh-5. a second roll moves nothing and throws, folding the block keeps the line, and closing the panel or going to Vex's page leaves no line", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await warmDice(player, playerSocket);
    const sheet = await characterPage(player, run.thornId, "Thorn");
    // A first roll, if the page has none, so the step's roll is a second one.
    if ((await headerOf(sheet).count()) === 0) {
      await pickRow(player, sheet, "Dexterity", /^Dexterity check/);
      await headerOf(sheet).locator("[data-result-label]").waitFor();
      await settled(player);
    }
    const box = abilityBox(sheet, "Dexterity");
    const before = await scrollerOf(box);
    await watchHeader(box);
    await pickRow(player, sheet, "Wisdom", /^Wisdom check/);
    const w = await headerSeen(player, "the second roll's total", (w) => w.totalAt !== null);
    assert.equal(w.canvasIn, "own", "the second roll throws, released by the header");
    assert.equal(w.anchorOff, false, "a later roll leaves anchoring alone");
    await settled(player);
    const after = await scrollerOf(box);
    assert.equal(after.scrollTop, before.scrollTop, "the second roll scrolled nothing");
    assert.ok((await headerWatched(player)).maxDrift <= 1, `the box moved ${(await headerWatched(player)).maxDrift} px`);
    // Folded, the block goes and the line stays.
    const fold = sheet.getByRole("button", { name: "Stat block", exact: true });
    await fold.click();
    await sheet.locator("[data-ability-grid]").waitFor({ state: "detached" });
    await headerOf(sheet).locator("[data-result-label]").filter({ hasText: /Wisdom check/ }).waitFor();
    await fold.click();
    await sheet.locator("[data-ability-grid]").first().waitFor();
    // Folded mid-throw: the fold's tap shows the total in the line that stays, so the panel closing later gives no toast (FL21-OPUS-01).
    const toasts = () => player.locator("[data-toast]").filter({ hasText: /Charisma check/ }).count();
    const quiet = await toasts();
    await watchHeader(abilityBox(sheet, "Dexterity"));
    await pickRow(player, sheet, "Charisma", /^Charisma check/);
    await headerSeen(player, "the dice in the air", midThrow);
    await fold.tap();
    await sheet.locator("[data-ability-grid]").waitFor({ state: "detached" });
    await headerOf(sheet).locator("[data-result-label]").filter({ hasText: /Charisma check/ }).waitFor();
    await sleep(600);
    await fold.click();
    await sheet.locator("[data-ability-grid]").first().waitFor();
    // Closed and opened again: no line.
    await closeAll(player);
    await sleep(800);
    assert.equal(await toasts(), quiet, "the line showed the folded roll, so its panel closing gives no toast");
    const again = await characterPage(player, run.thornId, "Thorn");
    assert.equal(await headerOf(again).count(), 0, "a panel opened again has no line");
    // A roll on Thorn's page, then Vex's page: no line (D-261101-095).
    await pickRow(player, again, "Strength", /^Strength check/);
    await headerOf(again).locator("[data-result-label]").filter({ hasText: /Strength check/ }).waitFor();
    await settled(player);
    const vex = await characterPage(player, trh.vexId, "Vex");
    assert.equal(await headerOf(vex).count(), 0, "Vex's page carries no line from Thorn's roll");
    await closeAll(player);
  });

  test("trh-5b. two panels on a computer, Dice below the Token panel: another token selected mid-throw takes the token panel's line, the Dice panel's line shows the roll, and the Dice panel's next roll gives no toast for it", async (t) => {
    if (!(await needsWebGL(dm, t))) return;
    await warmDice(dm, dmSocket);
    const panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    const tabs = dm.getByRole("tablist", { name: "Panels" });
    const bar = dm.locator("[data-pane-bar]");
    if ((await bar.count()) === 0) {
      await tabs.locator('[role="tab"][aria-haspopup="menu"]').click();
      await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
      await dm.getByRole("menu", { name: "More panels" }).waitFor({ state: "detached" });
    }
    try {
      await bar.getByRole("button", { name: / below$/ }).click();
      await dm.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: sideTabName("Dice") }).click();
      const dice = dm.getByRole("group", { name: "Dice below", exact: true });
      await dice.waitFor();
      const toasts = () => dm.locator("[data-toast]").filter({ hasText: /Intelligence check/ }).count();
      const quiet = await toasts();
      const box = abilityBox(panel, "Dexterity");
      await box.scrollIntoViewIfNeeded();
      await watchHeader(box);
      await pickRow(dm, panel, "Intelligence", /^Intelligence check/, "click");
      await headerSeen(dm, "the block's dice in the air", midThrow);
      // No Escape first: a key in the panel would end the throw itself. The Sprite's panel goes, and the Dice panel stays mounted beside.
      const bramble = await tokenPanel(dm, "Bramble", trh.bramble.at, false);
      assert.equal(await headerOf(bramble).count(), 0, "the new token's panel has no line");
      const result = dice.locator('[data-dice-last] [aria-label="Show this roll in Recent rolls"]');
      await result.filter({ hasText: /Intelligence check/ }).waitFor();
      await sleep(600);
      assert.equal(await toasts(), quiet, "the Dice panel's line shows it, so no toast");
      // The Dice panel's next roll moves its line on, and the roll it showed is still no toast.
      const count = diceLines(dmSocket.state?.log).length;
      await field(dice).fill("1d20 trh-5b");
      await field(dice).press("Enter");
      await waitFor("the Dice panel's roll", () => (diceLines(dmSocket.state?.log).length > count ? true : null));
      await result.filter({ hasText: /Intelligence check/ }).waitFor({ state: "detached" });
      await settled(dm);
      await sleep(800);
      assert.equal(await toasts(), quiet, "no late toast for the roll the line showed");
    } finally {
      if ((await bar.count()) > 0) {
        await dm.getByRole("button", { name: "Close Dice", exact: true }).click({ timeout: 2_000 }).catch(() => undefined);
        await bar.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined);
      }
    }
  });

  test("fu44a-1. one announcement per roll: a block roll's header says it at the answer, and another token selected, Hide or a Dice panel beside it mid-throw says nothing more, nor does the Dice panel's own close mid-throw on a phone (LP28-A-VOICE-1, FL21-LIVE-TWICE)", async (t) => {
    if (!(await needsWebGL(dm, t))) return;
    await warmDice(dm, dmSocket);
    const toasts = (label: RegExp) => dm.locator("[data-toast]").filter({ hasText: label }).count();
    const once = (said: Heard[], what: string) => assert.deepEqual(said.map((h) => h.region), ["header"], `${what}: said once, by the header: ${JSON.stringify(said)}`);

    // Another token selected mid-throw: a toast shows the roll, and nothing says it again.
    let panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    let box = abilityBox(panel, "Dexterity");
    await box.scrollIntoViewIfNeeded();
    await watchHeader(box);
    await listenLive(dm);
    await pickRow(dm, panel, "Intelligence", /^Intelligence save/, "click");
    await headerSeen(dm, "the dice in the air", midThrow);
    await tokenPanel(dm, "Bramble", trh.bramble.at, false);
    await waitFor("the unseen roll's toast", async () => ((await toasts(/Intelligence save/)) > 0 ? true : null), 5_000);
    await sleep(500);
    once(await heardOf(dm, /Intelligence save/), "another token");

    // Hide mid-throw: the same.
    panel = await tokenPanel(dm, "Sprite", trh.sprite.at);
    box = abilityBox(panel, "Dexterity");
    await box.scrollIntoViewIfNeeded();
    await watchHeader(box);
    await listenLive(dm);
    await pickRow(dm, panel, "Wisdom", /^Wisdom save/, "click");
    await headerSeen(dm, "the dice in the air", midThrow);
    await dm.getByRole("button", { name: "Hide panels" }).click();
    await panel.waitFor({ state: "hidden" });
    await waitFor("the hidden roll's toast", async () => ((await toasts(/Wisdom save/)) > 0 ? true : null), 5_000);
    await sleep(500);
    once(await heardOf(dm, /Wisdom save/), "Hide");
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await panel.waitFor();

    // Two panels, Dice below: the token panel goes mid-throw and the Dice panel's line shows the roll without saying it (FL21-LIVE-TWICE).
    const bar = dm.locator("[data-pane-bar]");
    if ((await bar.count()) === 0) {
      await dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]').click();
      await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
      await dm.getByRole("menu", { name: "More panels" }).waitFor({ state: "detached" });
    }
    try {
      await bar.getByRole("button", { name: / below$/ }).click();
      await dm.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: sideTabName("Dice") }).click();
      const dice = dm.getByRole("group", { name: "Dice below", exact: true });
      await dice.waitFor();
      await box.scrollIntoViewIfNeeded();
      await watchHeader(box);
      await listenLive(dm);
      await pickRow(dm, panel, "Charisma", /^Charisma save/, "click");
      await headerSeen(dm, "the dice in the air", midThrow);
      await tokenPanel(dm, "Bramble", trh.bramble.at, false);
      await dice.locator('[data-dice-last] [aria-label="Show this roll in Recent rolls"]').filter({ hasText: /Charisma save/ }).waitFor();
      await sleep(600);
      once(await heardOf(dm, /Charisma save/), "the Dice panel beside");
    } finally {
      if ((await bar.count()) > 0) {
        await dm.getByRole("button", { name: "Close Dice", exact: true }).click({ timeout: 2_000 }).catch(() => undefined);
        await bar.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined);
      }
    }

    // Pat's own Dice panel closed mid-throw: its line said the roll at the answer, so its toast shows it silent.
    await closeAll(player);
    await openDicePhone(player);
    await diceReady(player, playerSocket);
    await watchThrow(player);
    await listenLive(player);
    await rollWithEnter(player, playerSocket, "1d20 fu44a closed");
    await seen(player, "the dice in the air", (w) => w.canvasAt !== null && w.totalAt === null);
    await closeAll(player);
    await waitFor("the closed roll's toast", async () => ((await player.locator("[data-toast]").filter({ hasText: /fu44a closed/ }).count()) > 0 ? true : null), 5_000);
    await sleep(500);
    const said = await heardOf(player, /fu44a closed/);
    assert.deepEqual(said.map((h) => h.region), ["dice"], `the Dice panel's close: said once, by its line: ${JSON.stringify(said)}`);
  });

  test("trh-6. under reduced motion the total shows at once with the landed dice drawn once, and with Low power, the switch off or no WebGL the total shows at once with no canvas and nothing logged", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    await warmDice(player, playerSocket);
    await player.emulateMedia({ reducedMotion: "reduce" });
    try {
      const sheet = await characterPage(player, run.thornId, "Thorn");
      const box = abilityBox(sheet, "Dexterity");
      await watchHeader(box);
      const count = diceLines(playerSocket.state?.log).length;
      await pickRow(player, sheet, "Dexterity", /^Dexterity check/);
      const line = await waitFor("the check's line", () => diceLines(playerSocket.state?.log).slice(count).at(-1)?.data ?? null);
      const w = await headerSeen(player, "the total", (w) => w.totalAt !== null && w.canvasAt !== null);
      assert.equal(w.canvasIn, "own");
      assert.ok(Math.abs(w.totalAt! - w.canvasAt!) < 100, `the total showed ${Math.round(w.totalAt! - w.canvasAt!)} ms after the dice`);
      await player.waitForTimeout(600);
      const hook = (await stageHook(player))!;
      assert.equal(hook.frames, "1", "one frame, at rest");
      assert.equal(hook.landed, String(line.rolls[0]!.faces[0]));
      await shots.take(player, "trh-6-reduced-motion");
      await settled(player);
      await closeAll(player);
    } finally {
      await player.emulateMedia({ reducedMotion: null });
    }

    // Low power, then the switch off: each read as the room loads, so the dice never load.
    const rollsAtOnce = async (page: Page, watch: ConsoleWatch, what: string) => {
      const sheet = await characterPage(page, run.thornId, "Thorn");
      await page.waitForTimeout(2_000);
      const messages = watch.errors.length + watch.warnings.length;
      const box = abilityBox(sheet, "Dexterity");
      await watchHeader(box);
      await pickRow(page, sheet, "Dexterity", /^Dexterity check/);
      const w = await headerSeen(page, `${what}: the total`, (w) => w.totalAt !== null);
      await page.waitForTimeout(300);
      assert.equal((await headerWatched(page)).canvasAt, null, `${what}: no throw`);
      assert.equal(await page.locator("[data-dice-stage]").count(), 0, `${what}: no canvas`);
      assert.ok(w.lineAt !== null, `${what}: the header shows`);
      assert.equal(watch.errors.length + watch.warnings.length, messages, `${what}: no console message`);
      await closeAll(page);
    };
    for (const [key, value] of [["rvtt.lowPower", "on"], ["rvtt.rollAnimation", "off"]] as const) {
      await player.evaluate((kv) => localStorage.setItem(kv.key, kv.value), { key, value });
      await reopenRoom(player);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      try {
        await rollsAtOnce(player, playerConsole, `${key} ${value}`);
      } finally {
        await player.evaluate((k) => localStorage.removeItem(k), key);
      }
    }
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    // No WebGL: every WebGL context refused, in a page of Pat's own.
    const page = await playerContext.newPage();
    const quiet = new ConsoleWatch("pat-no-webgl");
    quiet.attach(page);
    try {
      await page.addInitScript(() => {
        const proto = (globalThis as unknown as { HTMLCanvasElement: { prototype: { getContext(type: string, ...rest: unknown[]): unknown } } }).HTMLCanvasElement.prototype;
        const real = proto.getContext;
        proto.getContext = function (this: unknown, type: string, ...rest: unknown[]) {
          return /webgl/.test(type) ? null : real.call(this, type, ...rest);
        };
      });
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await rollsAtOnce(page, quiet, "no WebGL");
      assert.deepEqual([...quiet.errors, ...quiet.warnings], [], "no console message without WebGL");
    } finally {
      await page.close();
    }
  });

  test("trh-7. with the box at the pane's top a pointer pick leaves it in place under the line, a keyboard pick on another page's first roll brings it clear of the line with focus on it, and Tab brings the next box clear too", async (t) => {
    if (!(await needsWebGL(player, t))) return;
    // A pointer pick: the box stays, partly under the line.
    const sheet = await characterPage(player, run.thornId, "Thorn");
    assert.equal(await headerOf(sheet).count(), 0, "a fresh page");
    const box = abilityBox(sheet, "Dexterity");
    await toPaneTop(box);
    await watchHeader(box);
    await pickRow(player, sheet, "Dexterity", /^Dexterity check/);
    await headerSeen(player, "the total", (w) => w.totalAt !== null);
    await settled(player);
    assert.ok((await headerWatched(player)).maxDrift <= 1, `the pointer pick moved the box ${(await headerWatched(player)).maxDrift} px`);
    const under = { line: (await headerOf(sheet).boundingBox())!, box: (await box.boundingBox())! };
    assert.ok(under.box.y < under.line.y + under.line.height, "the box stands partly under the line, where the finger left it");
    await shots.take(player, "trh-7-pointer-pick-under-line");

    // A keyboard pick on Vex's first roll: focus back on the box, the box wholly under the line's bottom.
    const vex = await characterPage(player, trh.vexId, "Vex");
    assert.equal(await headerOf(vex).count(), 0, "Vex's page has no line yet");
    const vexBox = abilityBox(vex, "Dexterity");
    await toPaneTop(vexBox);
    await vexBox.focus();
    await player.keyboard.press("Enter");
    const list = player.getByRole("menu", { name: "Dexterity rolls" });
    await list.waitFor();
    const check = list.getByRole("menuitem", { name: /^Dexterity check/ });
    await waitFor("focus on Check", async () => ((await check.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement)) ? true : null));
    await player.keyboard.press("Enter");
    await list.waitFor({ state: "detached" });
    const header = headerOf(vex);
    await header.locator("[data-result-label]").waitFor();
    await settled(player);
    assert.ok(await vexBox.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), "focus is back on the box");
    const line = (await header.boundingBox())!;
    const clear = (await vexBox.boundingBox())!;
    assert.ok(clear.y >= line.y + line.height - 1, `the box's top ${clear.y} is under the line's bottom ${line.y + line.height}`);
    await shots.take(player, "trh-7-keyboard-pick-clear");

    // Tab to the next box while it stands under the line: it comes clear of the line.
    const next = abilityBox(vex, "Constitution");
    await toPaneTop(next);
    await player.keyboard.press("Tab");
    await waitFor("focus on CON", async () => ((await next.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement)) ? true : null));
    await sleep(300);
    const tabbed = (await next.boundingBox())!;
    const lineNow = (await header.boundingBox())!;
    assert.ok(tabbed.y >= lineNow.y + lineNow.height - 1, `the tabbed box's top ${tabbed.y} is under the line's bottom ${lineNow.y + lineNow.height}`);
    await closeAll(player);
  });

  test("trh-8. at 320 x 568 at 130% a roll whose op the server never saw, with a snapshot that covers it, reads \"This may have happened. Check the log.\" on two lines in the 44 px row, and the boxes stay", async () => {
    const page = await playerContext.newPage();
    const quiet = new ConsoleWatch("pat-unknown");
    // The failed receipt lookup is logged as a failed resource.
    quiet.allow = [/status of 503 .*\/receipts\//];
    quiet.attach(page);
    const lost: { n: number | null; tag: string | null; snapshots: number; gets: string[] } = { n: null, tag: null, snapshots: 0, gets: [] };
    // Only the step's own roll is swallowed, not the page's ops before it.
    let armed = false;
    try {
      // The roll's op never reaches the server, its socket closes, and the snapshot on reconnect claims the op settled: the store calls it unknown with the snapshot as the cause (client/state/store.ts applySnapshot).
      await page.routeWebSocket(/\/ws\?room=/, (ws) => {
        const up = ws.connectToServer();
        ws.onMessage((m) => {
          if (armed && lost.n === null && typeof m === "string" && m.includes('"dice.roll"')) {
            const frame = JSON.parse(m) as { n: number; op: { tag: string } };
            lost.n = frame.n;
            lost.tag = frame.op.tag;
            setTimeout(() => {
              void ws.close();
              void up.close();
            }, 50);
            return;
          }
          up.send(m);
        });
        up.onMessage((m) => {
          if (lost.n !== null && typeof m === "string" && m.startsWith('{"t":"snapshot"')) {
            const frame = JSON.parse(m) as { watermark: number };
            frame.watermark = Math.max(frame.watermark, lost.n);
            lost.snapshots++;
            ws.send(JSON.stringify(frame));
            return;
          }
          ws.send(m);
        });
      });
      // The tracker then finds no line and asks the receipt lookup, which fails, so the part stays unknown (useReceipt.ts).
      await page.route(/\/api\/rooms\/[0-9A-Z]+\/receipts\//, (route) => {
        lost.gets.push(route.request().url());
        return route.fulfill({ status: 503, body: "" });
      });
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await reopenRoom(page);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      const sheet = await characterPage(page, run.thornId, "Thorn");
      const grid = sheet.locator("[data-ability-grid]").first();
      await grid.scrollIntoViewIfNeeded();
      const boxes = () => grid.getByRole("button").evaluateAll((els) => els.map((el) => Math.round((el as unknown as { getBoundingClientRect(): { top: number } }).getBoundingClientRect().top * 10) / 10));
      armed = true;
      await abilityBox(sheet, "Dexterity").tap();
      const before = await boxes();
      await sleep(MENU_SETTLE_MS);
      await page.getByRole("menu", { name: "Dexterity rolls" }).getByRole("menuitem", { name: /^Dexterity check/ }).tap();
      const header = headerOf(sheet);
      await waitFor("the receipt lookup", () => (lost.gets.length > 0 ? true : null), 20_000);
      assert.ok(lost.gets[0]!.endsWith(`/receipts/${lost.tag}`), `the lookup asked for the roll's tag: ${lost.gets[0]}`);
      assert.equal(lost.snapshots > 0, true, "the reconnect's snapshot covered the op");
      await header.getByText("This may have happened. Check the log.").waitFor();
      const words = await headerWords(header);
      assert.equal(words.lines, 2, `the words take two lines: ${JSON.stringify(words)}`);
      assert.equal(words.row, 44, "the row stays 44 px");
      const after = await boxes();
      assert.ok(after.every((top, i) => Math.abs(top - before[i]!) <= 1), `the boxes stayed: ${before.join(", ")} then ${after.join(", ")}`);
      await shots.take(page, "trh-8-unknown-320-130");
      assert.deepEqual(quiet.errors, []);
    } finally {
      await page.close();
    }
  });
});
