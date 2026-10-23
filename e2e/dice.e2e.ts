import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { FORMULA_ERRORS } from "#shared/dice/formula.ts";
import { keptD20 } from "#shared/dice/roll.ts";
import type { DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import { ConsoleWatch, OpSocket, openSideTab, reopenRoom, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Dice on the server (docs/design-v1-dice.md 13), on the real server serving
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
 * (docs/design-v1-dice-ui.md): a weapon row's controls on one line at
 * 390 px, a result in the header line and never in its row, a save
 * spell's DC in its row, the header line inside its column at 100% and
 * 130%, and an answer's line with no Again. Last, the two faults the
 * project owner met on an iPhone: a roll option's words run past its
 * button (the Aboleth's group save), and the header line cut through a
 * die (a long critical damage with three riders), each at 390 x 844 at
 * 100% and 130%, and the header line at 320 x 568 at 130% as well.
 *
 * Then the roll animation (docs/design-v1-roll-animation.md 10), its steps
 * labeled `ra-`: Pat's own roll throws dice that land on the result, and
 * reduced motion, no WebGL, Low power, the switch, a tap during a throw,
 * the tracker's Roll, a secret roll, the DM's toast of Pat's attack, a
 * small phone and a roll still in the air as its sheet closes, by a tap or
 * by Escape, each do as the design says. The browser draws WebGL in
 * software (SwiftShader), as CI has no GPU, and the steps that measure the
 * header line do so once the dice have gone.
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

describe("raccoon-vtt dice", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: WEBGL_ARGS });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
    await dm.getByText(`Pat rolled ${total} for fire.`).waitFor();
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
    // Only a DM's roll for a monster starts secret (docs/design-v1-dice.md 17).
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

  test("6. at 375 x 667, at 100% and 130%, the sticky line, the field, Roll, the quick dice with the d20 first and the choices are in view", async () => {
    for (const scale of [1, 1.3]) {
      await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await player.goto(`${server.origin}/r/${run.roomId}`);
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openDicePhone(player);
      await rollWithEnter(player, playerSocket, "1d20+3");
      await settled(player);
      for (const selector of ["[data-dice-last]", 'input[aria-label="Dice formula"]', 'button:has-text("Roll")', '[aria-label="Quick dice"]', 'button[aria-label="Add a d20"]', '[role="group"][aria-label="For the next roll"]']) {
        assert.ok(await inView(player, selector), `${selector} in view at ${Math.round(scale * 100)}%`);
      }
      await shots.take(player, `dice-phone-${Math.round(scale * 100)}`);
    }
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });

  test("7. with two panels, Dice rolls in the bottom pane, and Pat's roll makes no toast while Dice shows there", async () => {
    // The bottom pane counts as on screen (docs/design-v1-split-panel.md 3, docs/design-v1-dice.md 8.5).
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
    assert.equal(await dm.getByText(`Pat rolled ${quiet.rolls[0]!.total} for Quiet.`).count(), 0, "no toast while Dice shows below");

    // With the split closed and Initiative on top, Dice is off screen again, so the next roll toasts.
    await bar.getByRole("button", { name: "Close Dice", exact: true }).click();
    await bar.waitFor({ state: "detached" });
    const loud = await rollWithEnter(player, playerSocket, "1d6 Loud");
    await dm.getByText(`Pat rolled ${loud.rolls[0]!.total} for Loud.`).waitFor();
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
    // Again is a whole touch target, as every button is (docs/design-v1-look-pass-2.md D37).
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
    // The numbers stand in the row's header, after its name, as a stat block prints them (docs/design-v1-dice-ui.md 4.4).
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
    await sticky.getByText("Dexterity save").waitFor();
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
    assert.equal((await stageHook(player))?.landed, chip, "the die landed on the face its chip shows");
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
    // Square under the header line's straight edge, rounded at its foot (docs/design-v1-look-pass-2.md D37).
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
    const toast = dm.locator('button[role="status"]').filter({ hasText: `Pat rolled ${line.rolls[0]!.total} for` }).filter({ hasText: "Longsword" });
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
      // The "+N" disc's number is in the tray's own pixels, as the disc is, so it keeps one size inside it at every interface size (docs/design-v1-look-pass-2.md D37).
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
    await player.getByText(`Rolled ${line.rolls[0]!.total}: ra-9.`).waitFor();
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
      await player.getByText(`Rolled ${total}: ra-10 ${attempt}.`).waitFor();
    }
    assert.ok(total !== null, "Escape never came while the dice flew");
    await shots.take(player, "ra-escape-mid-throw-toast");
  });
});
