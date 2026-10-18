import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import { ConsoleWatch, OpSocket, openSideTab, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

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
 * 130%, and an answer's line with no Again.
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

describe("raccoon-vtt dice", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
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
    const sticky = player.locator("[data-dice-last]");
    await sticky.getByRole("button", { name: "Again" }).waitFor();
    const fit = await sticky.evaluate((el) => {
      type Box = { getBoundingClientRect(): { height: number }; parentElement: Box | null; scrollWidth: number; clientWidth: number };
      const g = globalThis as unknown as { getComputedStyle(el: Box): { overflowY: string } };
      let scroller = (el as unknown as Box).parentElement;
      while (scroller && g.getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement;
      return { height: (el as unknown as Box).getBoundingClientRect().height, sideways: scroller ? scroller.scrollWidth - scroller.clientWidth : -1 };
    });
    assert.ok(fit.height <= 60, `the sticky line is ${fit.height} px tall`);
    assert.equal(fit.sideways, 0, "the Dice sheet scrolls sideways");
    assert.ok(await inView(player, '[data-dice-last] button:has-text("Again")'), "Again is on screen");
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
      [attack, rolls.getByRole("button", { name: "Longsword damage", exact: true }), rolls.getByRole("button", { name: "Critical hit for Longsword's next damage", exact: true })].map(async (l) => {
        const box = (await l.boundingBox())!;
        return box.y + box.height / 2;
      }),
    );
    assert.ok(middles.every((m) => Math.abs(m - middles[0]!) < 1), `the row's controls take more than one line: ${middles.join(", ")}`);
    // The numbers stand in the row's header, after its name, as a stat block prints them (docs/design-v1-dice-ui.md 4.4).
    const header = (await namedRow(attack).locator("div").first().innerText()).replace(/\s+/g, " ");
    assert.match(header, /^Longsword ?\+6 to hit, 1d8\+3 slashing/);
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
    assert.match(await headerOf("Hold Person"), /^Hold Person ?DC 14 Wis$/);
    assert.match(await headerOf("Sacred Flame"), /^Sacred Flame ?DC 14 Dex, \dd8 radiant/);
    await rolls.getByText("Hold Person", { exact: true }).scrollIntoViewIfNeeded();
    await shots.take(player, "dice-save-spells-dc");
  });

  test("14. the header line keeps to its column, at 100% and at 130%", async () => {
    for (const scale of [1, 1.3]) {
      if (scale !== 1) {
        await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await player.reload();
        await player.getByRole("status", { name: "Connected" }).first().waitFor();
        await openDicePhone(player);
        await rollWithEnter(player, playerSocket, "1d20+3");
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
    await player.reload();
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
});
