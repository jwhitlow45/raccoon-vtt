import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, sleep, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Roll requests on phones (docs/design-v1-visual.md 3.3.1): the real
 * server serving the production build, a DM on a phone who also asks
 * through a second socket of the same session, and a player on a phone.
 *
 * The player's card never covers an open sheet. Under one it folds,
 * mounted but out of sight and out of Tab's reach, into one summary that
 * reads "Roll asked" while a request waits. The summary is a request to
 * answer: it closes the sheet and focuses the card to answer, the one
 * already mounted first, so a typed total is never dropped. Back closes
 * the sheet, never a card folded under it. In landscape at 667 x 375 at
 * 115% the card across the screen folds the same way beside the right-hand
 * sheet. The DM's phone shows the newest two requests and a "Rolls d/a"
 * disclosure for the rest.
 *
 * In portrait the summary that stands for the folded card is the dock's on
 * the sheet's edge once Room has its dock (part 3 of the design pass), and
 * the rolls' own button in the column before that. Both start with the
 * same words, which is how these steps find it.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus three, which it shares
 * with regress.e2e.ts, one file after the other. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 3;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-rolls-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const CARD = "The DM asks for a roll";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E rolls ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: "",
  thornCharId: randomUUID(),
  thornId: randomUUID(),
  /** Requests asked and not closed yet, closed between steps so each starts clean. */
  open: [] as string[],
};

type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";

/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = { tagName: string; textContent: string | null; getAttribute(name: string): string | null; closest(selector: string): El | null };
type PageGlobals = { document: { activeElement: El | null; body: El }; __rvttVibrations?: number; navigator: object };

function actor() {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 12,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Asks Thorn for one roll, as the DM's sheet would, and waits until the player holds it. */
async function ask(kind: "save" | "check", ability: Ability, dc?: number): Promise<string> {
  const id = randomUUID();
  await ops.send({
    t: "roll.ask",
    request: { id, test: { kind, choices: [{ ability }] }, ...(dc !== undefined ? { dc } : {}), dcShown: true, resultShown: true, targets: [{ characterId: run.thornCharId }] },
  });
  run.open.push(id);
  await waitFor(`request ${id} on the player's phone`, () => playerSocket.state?.rolls[id]);
  // Requests stack by when the server took them, so two asked in one millisecond would tie.
  await sleep(20);
  return id;
}

async function closeAll(): Promise<void> {
  if (run.open.length === 0) return;
  const ids = run.open.splice(0);
  await ops.send({ t: "roll.close", rollIds: ids });
  await waitFor("the requests gone for the player", () => ids.every((id) => !playerSocket.state?.rolls[id]) || null);
}

/** How many times the player's phone vibrated, which announceTurn does with the chime. */
function vibrations(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as PageGlobals).__rvttVibrations ?? 0);
}

/** The card, hidden or not. A role query skips a hidden one, so this finds it by its markup. */
function cardElement(page: Page): Locator {
  return page.locator(`[role="dialog"][aria-label="${CARD}"]`);
}

function card(page: Page): Locator {
  return page.getByRole("dialog", { name: CARD });
}

/** The summary that stands for the folded card: the dock's in portrait once Room has one, else the rolls' own. */
function rollAsked(page: Page): Locator {
  return page.getByRole("button", { name: /^Roll asked/ }).first();
}

/** Opens a sheet as a phone does: the Panels button, then the Log. */
async function openLog(page: Page): Promise<void> {
  const picker = page.getByRole("list", { name: "Panels" });
  if (!(await picker.isVisible())) await page.locator('button[title="Panels"]').tap();
  await picker.getByRole("button", { name: /^Log( ?\d+ unread)?$/ }).tap();
  await page.getByRole("region", { name: "Log" }).waitFor();
}

/** Opens a panel's sheet on a phone: the Panels button, then the panel. */
async function openPanel(page: Page, name: string): Promise<void> {
  const picker = page.getByRole("list", { name: "Panels" });
  if (!(await picker.isVisible())) await page.locator('button[title="Panels"]').tap();
  await picker.getByRole("button", { name: new RegExp(`^${name}( ?\\d+ unread)?$`) }).tap();
}

async function logOpen(page: Page): Promise<boolean> {
  return page.getByRole("region", { name: "Log" }).isVisible();
}

/** Which part of the page has focus: the card, or the name of what has it. */
function focused(page: Page): Promise<string> {
  return page.evaluate((cardName) => {
    const { document } = globalThis as unknown as PageGlobals;
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    if (el.closest(`[aria-label="${cardName}"]`)) return el.getAttribute("aria-label") === cardName ? "card" : "inside the card";
    const dialog = el.closest('[role="dialog"]');
    return `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""}"${dialog ? ` in "${dialog.getAttribute("aria-label")}"` : ""}`;
  }, CARD);
}

/** Tabs through the whole page from where focus is, and says whether any stop lay inside the folded card. */
async function tabReachesCard(page: Page): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate((cardName) => {
      const el = (globalThis as unknown as PageGlobals).document.activeElement;
      return el !== null && el.closest(`[aria-label="${cardName}"]`) !== null;
    }, CARD);
    if (inside) return true;
  }
  return false;
}

describe("raccoon-vtt roll requests on phones", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    const phone = { viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    dmContext = await browser.newContext(phone);
    playerContext = await browser.newContext(phone);
    // Counts announceTurn's vibrations, the chime's partner on a phone.
    await playerContext.addInitScript(() => {
      const w = globalThis as unknown as PageGlobals & { __rvttVibrations: number };
      w.__rvttVibrations = 0;
      Object.defineProperty(w.navigator, "vibrate", {
        configurable: true,
        value: () => {
          w.__rvttVibrations++;
          return true;
        },
      });
    });
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

  test("1. the DM makes a room on a phone, a player joins on a phone, and Thorn stands on the map", async () => {
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

    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
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

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thornCharId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send({
      t: "token.create",
      token: { id: run.thornId, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: 5, y: 5, disposition: "ally", actor: { ref: run.thornCharId } },
    });
    await waitFor("Thorn on the player's map", () => playerSocket.state?.tokens[run.thornId]);
  });

  test("2. a request arriving under an open sheet folds, says Roll asked and chimes, stays out of Tab's reach, and Back closes the sheet, not the card", async () => {
    await openLog(player);
    const buzzes = await vibrations(player);
    await ask("check", "wis");
    await rollAsked(player).waitFor();
    assert.match((await rollAsked(player).getAttribute("aria-label")) ?? "", /^Roll asked: the DM asks for a Wisdom check/);
    await waitFor("the chime's vibration", async () => (await vibrations(player)) > buzzes || null);
    assert.equal(await cardElement(player).count(), 1, "the card stays mounted under the sheet");
    assert.ok(await cardElement(player).isHidden(), "the folded card is out of sight");
    assert.ok(await logOpen(player), "the sheet stays open");
    await shots.take(player, "rolls-folded-under-sheet");

    await player.getByRole("button", { name: "Close Log" }).focus();
    assert.equal(await tabReachesCard(player), false, "Tab reached the folded card");

    await player.goBack();
    await waitFor("the sheet closed by Back", async () => !(await logOpen(player)) || null);
    await card(player).waitFor();
    assert.equal(await player.getByRole("button", { name: /^Wis check: waiting/ }).count(), 0, "Back folded the card into a chip");
    assert.equal(await rollAsked(player).count(), 0, "the summary is gone with the sheet");
    await shots.take(player, "rolls-card-after-back");
  });

  test("3. a typed total survives a fold and an unfold, and the keyboard reopens the card with focus on it", async () => {
    await card(player).getByLabel("Total Thorn rolled").fill("14");
    await shots.take(player, "rolls-card-typed");
    await openLog(player);
    await rollAsked(player).waitFor();
    assert.ok(await cardElement(player).isHidden());
    await rollAsked(player).focus();
    await player.keyboard.press("Enter");
    await card(player).waitFor();
    await waitFor("the sheet closed by the summary", async () => !(await logOpen(player)) || null);
    assert.equal(await focused(player), "card", "focus went to the card's dialog");
    assert.equal(await card(player).getByLabel("Total Thorn rolled").inputValue(), "14");
    await card(player).getByRole("button", { name: "Send", exact: true }).tap();
    await card(player).waitFor({ state: "detached" });
    await player.getByRole("button", { name: /^Wis check: sent 14\./ }).waitFor();
    await closeAll();
  });

  test("4. a card being typed into stays when a newer request arrives under a sheet, which becomes a chip", async () => {
    await ask("save", "dex");
    await card(player).getByText("The DM asks for a Dexterity saving throw.").waitFor();
    await card(player).getByLabel("Total Thorn rolled").fill("9");
    await openLog(player);
    const buzzes = await vibrations(player);
    await ask("save", "str");
    await waitFor("the newer request's chime", async () => (await vibrations(player)) > buzzes || null);
    await rollAsked(player).waitFor();
    await player.getByRole("button", { name: "Close Log" }).tap();
    await card(player).getByText("The DM asks for a Dexterity saving throw.").waitFor();
    assert.equal(await card(player).getByLabel("Total Thorn rolled").inputValue(), "9", "the typed total is kept");
    await player.getByRole("button", { name: /^Str save: waiting for your roll\./ }).waitFor();
    await shots.take(player, "rolls-newer-request-a-chip");
    await closeAll();
  });

  test("5. with the oldest of three put off by Later, the summary opens the newest waiting card, and with all put off it brings the newest back", async () => {
    await ask("save", "str");
    await ask("save", "dex");
    await ask("save", "con");
    await card(player).getByText("The DM asks for a Constitution saving throw.").waitFor();
    // The oldest is a chip under the newest two: open it, then put it off. With no answer yet it offers no change (LPD-PLAYER-6).
    await player.getByRole("button", { name: "Str save: waiting for your roll.", exact: true }).tap();
    await card(player).getByText("The DM asks for a Strength saving throw.").waitFor();
    await card(player).getByRole("button", { name: "Fold it into a chip, to answer later" }).tap();
    await card(player).getByText("The DM asks for a Constitution saving throw.").waitFor();

    await openLog(player);
    await rollAsked(player).tap();
    await card(player).getByText("The DM asks for a Constitution saving throw.").waitFor();
    assert.equal(await focused(player), "card");

    // Every one put off: the summary undoes Later for the newest.
    for (let i = 0; i < 2; i++) {
      await card(player).getByRole("button", { name: "Fold it into a chip, to answer later" }).tap();
      await sleep(100);
    }
    await waitFor("every request put off", async () => (await cardElement(player).count()) === 0 || null);
    await openLog(player);
    await rollAsked(player).tap();
    await card(player).getByText("The DM asks for a Constitution saving throw.").waitFor();
    assert.equal(await focused(player), "card");
    await closeAll();
  });

  test("6. the older request's card, opened from its chip and typed into, comes back from the summary with its total", async () => {
    await ask("check", "wis");
    await ask("check", "cha");
    await card(player).getByText("The DM asks for a Charisma check.").waitFor();
    await player.getByRole("button", { name: /^Wis check: waiting for your roll\./ }).tap();
    await card(player).getByText("The DM asks for a Wisdom check.").waitFor();
    await card(player).getByLabel("Total Thorn rolled").fill("11");
    await openLog(player);
    // It names the card its tap brings back, not the newest request (LPD-PLAYER-6).
    assert.equal(await rollAsked(player).getAttribute("aria-label"), "Roll asked: the DM asks for a Wisdom check and 1 more roll. Close the sheet to answer.");
    await rollAsked(player).tap();
    await card(player).getByText("The DM asks for a Wisdom check.").waitFor();
    assert.equal(await card(player).getByLabel("Total Thorn rolled").inputValue(), "11");
    assert.equal(await focused(player), "card");
    await closeAll();
  });

  test("7. at 667 x 375 at 115% the card across the screen folds beside the right-hand sheet into a summary that closes it", async () => {
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.15"));
    await player.setViewportSize({ width: 667, height: 375 });
    await player.reload();
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await ask("save", "wis");
    // With its roll row the card's answer block no longer fits under the top bars here, so the card starts folded behind
    // Roll asked, whose tap brings it up over the toolbar (docs/design-v1-roll-request.md 5.7).
    await rollAsked(player).or(card(player)).first().waitFor();
    if (await cardElement(player).isHidden()) await rollAsked(player).tap();
    await card(player).waitFor();
    await card(player).getByLabel("Total Thorn rolled").fill("7");
    await openLog(player);
    const summary = rollAsked(player);
    await summary.waitFor();
    assert.ok(await cardElement(player).isHidden(), "the card across the screen folds beside the sheet");
    assert.equal(await summary.getAttribute("aria-expanded"), null, "the summary closes the sheet, so it is no disclosure");
    await shots.take(player, "rolls-landscape-folded");
    await player.getByRole("button", { name: "Close Log" }).focus();
    assert.equal(await tabReachesCard(player), false, "Tab reached the folded card");
    await summary.tap();
    await card(player).waitFor();
    await waitFor("the sheet closed by the summary", async () => !(await logOpen(player)) || null);
    assert.equal(await card(player).getByLabel("Total Thorn rolled").inputValue(), "7");
    assert.equal(await focused(player), "card");
    await closeAll();
    await player.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
    await player.setViewportSize(PHONE);
    await player.reload();
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("8. the DM's phone shows the newest two requests, then a Rolls disclosure for the rest, and folds them under a sheet", async () => {
    await ask("save", "str");
    await ask("save", "dex");
    await ask("save", "con");
    const cards = dm.getByRole("group", { name: /^Roll request: / });
    await waitFor("the newest two cards", async () => ((await cards.count()) === 2 ? true : null));
    const more = dm.getByRole("button", { name: /^Rolls 0\/1: 1 more roll request/ });
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    assert.equal(await cards.nth(0).getByText("Con save").count(), 1, "the newest on top");
    await shots.take(dm, "rolls-dm-phone-two-cards");
    await more.tap();
    await waitFor("every card", async () => ((await cards.count()) === 3 ? true : null));
    assert.equal(await more.getAttribute("aria-expanded"), "true");
    assert.equal(await more.getAttribute("aria-pressed"), null, "a disclosure, never a toggle button");
    await shots.take(dm, "rolls-dm-phone-every-card");
    await more.tap();
    await waitFor("the newest two again", async () => ((await cards.count()) === 2 ? true : null));

    await openLog(dm);
    await waitFor("the stack folded under the sheet", async () => ((await cards.count()) === 0 ? true : null));
    const folded = dm.getByRole("button", { name: /^Rolls 0\/3/ }).first();
    await folded.waitFor();
    // Three requests are them, not it (LPD-DMPHONE-8).
    assert.match((await folded.getAttribute("aria-label")) ?? "", /Close the sheet to see them\.$/);
    await shots.take(dm, "rolls-dm-phone-folded-under-sheet");
    await dm.getByRole("button", { name: "Close Log" }).tap();
    await closeAll();
  });

  // Where focus lands once a sheet closes is Room's one decision (3.2.1), which reads the card's and the token bar's ranks
  // (components/sheetFocus.ts). Room makes it once part 3 of the design pass lands, so this step waits on that part.
  test("9. a request put off with Later stays put off through Escape, and focus goes to the token bar", async () => {
    await ask("check", "str");
    await card(player).waitFor();
    await card(player).getByRole("button", { name: "Fold it into a chip, to answer later" }).tap();
    await card(player).waitFor({ state: "detached" });
    const scene = playerSocket.state!.scenes[run.sceneId]!;
    await tapCell(player, scene.bounds, { x: 5, y: 5 });
    await player.getByRole("dialog", { name: "Thorn actions" }).waitFor();
    await openLog(player);
    await player.keyboard.press("Escape");
    await waitFor("the sheet closed by Escape", async () => !(await logOpen(player)) || null);
    assert.equal(await cardElement(player).count(), 0, "Later held: no card came up");
    await player.getByRole("button", { name: /^Str check: waiting for your roll\./ }).waitFor();
    assert.match(await focused(player), /in "Thorn actions"|"Thorn actions"/, "focus went to the token bar");
    await closeAll();
  });

  test("10. the DM's sheet picks one whole roll: nothing at open, Perception then Strength sends a Strength check, and either of two choices can go", async () => {
    // The reported bug (docs/design-v1-roll-request.md 2): a skill stayed picked under the ability tapped after it.
    await openPanel(dm, "Party");
    await dm.getByRole("button", { name: "Ask the party" }).first().tap();
    const sheet = dm.getByRole("dialog", { name: "Request a roll" });
    await sheet.waitFor();
    assert.equal(await sheet.locator("input[type=radio]:checked").count(), 0, "nothing is picked at open");
    assert.equal(await sheet.getByRole("combobox", { name: "Skill check" }).inputValue(), "");
    await sheet.getByText(/^Pick what to roll\. 1 asked\.$/).waitFor();
    await sheet.getByRole("button", { name: "Send", exact: true }).tap();
    await sheet.getByRole("alert").filter({ hasText: "Pick what to roll first." }).waitFor();
    await shots.take(dm, "rolls-sheet-nothing-picked");

    await sheet.getByRole("radiogroup", { name: "Ability check" }).getByRole("radio", { name: "Dexterity" }).tap();
    await sheet.getByRole("combobox", { name: "Skill check" }).selectOption("perception");
    await sheet.getByText(/^Wisdom \(Perception\) check, no DC\. 1 asked\.$/).waitFor();
    assert.equal(await sheet.locator("input[type=radio]:checked").count(), 0, "the Check row shows nothing while a skill is picked");
    assert.equal(await sheet.getByRole("combobox", { name: "Ability for Perception" }).inputValue(), "wis");
    await sheet.getByRole("radiogroup", { name: "Ability check" }).getByRole("radio", { name: "Strength" }).tap();
    await sheet.getByText(/^Strength check, no DC\. 1 asked\.$/).waitFor();
    assert.equal(await sheet.getByRole("combobox", { name: "Skill check" }).inputValue(), "", "Perception went back to Choose a skill");
    await shots.take(dm, "rolls-sheet-strength-check");

    // Two choices: each has Remove, and removing the first makes the second the first.
    await sheet.getByRole("button", { name: "Or a second choice" }).tap();
    const second = sheet.getByRole("group", { name: "Or the second" });
    await second.getByRole("radiogroup", { name: "Ability check" }).getByRole("radio", { name: "Dexterity" }).tap();
    assert.equal(await second.getByRole("radiogroup", { name: "Saving throw" }).getByRole("radio", { name: "Dexterity" }).isDisabled(), true, "a save cannot join a check");
    assert.equal(await second.getByRole("radiogroup", { name: "Ability check" }).getByRole("radio", { name: "Strength" }).isDisabled(), true, "nor the first choice itself");
    await second.getByText("Both choices are checks. Str check is the first choice.").waitFor();
    await sheet.getByText(/^Strength or Dexterity check, no DC\. 1 asked\.$/).waitFor();
    await shots.take(dm, "rolls-sheet-two-choices");
    await sheet.getByRole("button", { name: "Remove the first choice" }).tap();
    await sheet.getByText(/^Dexterity check, no DC\. 1 asked\.$/).waitFor();
    assert.equal(await sheet.getByRole("group", { name: "Or the second" }).count(), 0);
    assert.equal(await sheet.getByRole("button", { name: /^Remove/ }).count(), 0, "one choice has no Remove");

    await sheet.getByRole("radiogroup", { name: "Ability check" }).getByRole("radio", { name: "Strength" }).tap();
    await sheet.getByRole("button", { name: "Send", exact: true }).tap();
    await sheet.waitFor({ state: "detached" });
    const sent = await waitFor("the request in the player's state", () => Object.values(playerSocket.state?.rolls ?? {})[0]);
    run.open.push(sent.id);
    assert.deepEqual(sent.test, { kind: "check", choices: [{ ability: "str" }] }, "the DM asked for a Strength check and sent one");
    await card(player).getByText("The DM asks for a Strength check.").waitFor();
    await closeAll();
  });

  test("11. a recent request is one tap, Enter in the DC field sends, and what players see folds into one line that says it", async () => {
    await openPanel(dm, "Party");
    await dm.getByRole("button", { name: "Ask the party" }).first().tap();
    const sheet = dm.getByRole("dialog", { name: "Request a roll" });
    await sheet.waitFor();
    const recent = sheet.getByRole("group", { name: "Recent requests" });
    assert.deepEqual(await recent.getByRole("button").allInnerTexts(), ["Str check"], "the request step 10 sent");
    await recent.getByRole("button", { name: "Str check" }).tap();
    await sheet.getByText(/^Strength check, no DC\. 1 asked\.$/).waitFor();
    assert.equal(await sheet.getByRole("radiogroup", { name: "Ability check" }).getByRole("radio", { name: "Strength" }).isChecked(), true, "the picker shows what the tap filled");

    const fold = sheet.getByRole("button", { name: "What players see" });
    assert.equal(await fold.getAttribute("aria-expanded"), "false", "folded at first");
    await sheet.getByText("Pass or fail shown. No note.").waitFor();
    assert.equal(await sheet.getByRole("checkbox", { name: "Players see the DC" }).count(), 0, "no DC, no switch for it");
    await sheet.getByLabel("DC", { exact: true }).fill("12");
    assert.equal(await sheet.getByRole("button", { name: "10, Easy" }).getAttribute("aria-pressed"), "false", "no typical DC is 12");
    await sheet.getByText("The DC and pass or fail. No note.").waitFor();
    await fold.tap();
    await sheet.getByRole("checkbox", { name: "Players see the DC" }).uncheck();
    await sheet.getByLabel("Note for the players").fill("to hear the guards");
    await sheet.getByText("DC hidden. Pass or fail shown. Note: to hear the guards.").waitFor();
    await shots.take(dm, "rolls-sheet-what-players-see");
    await sheet.getByLabel("DC", { exact: true }).press("Enter");
    await sheet.waitFor({ state: "detached" });
    const sent = await waitFor("the request in the player's state", () => Object.values(playerSocket.state?.rolls ?? {})[0]);
    run.open.push(sent.id);
    assert.deepEqual({ test: sent.test, dcHidden: sent.dcHidden, dcShown: sent.dcShown, note: sent.note }, { test: { kind: "check", choices: [{ ability: "str" }] }, dcHidden: true, dcShown: false, note: "to hear the guards" });
    await closeAll();

    // The newest request comes first, and the switches start as it had them. On a phone the sheet took the Party panel's place.
    await openPanel(dm, "Party");
    await dm.getByRole("button", { name: "Ask the party" }).first().tap();
    await sheet.waitFor();
    assert.deepEqual(await recent.getByRole("button").allInnerTexts(), ["Str check, DC 12", "Str check"]);
    await sheet.getByText("Pass or fail shown. No note.").waitFor();
    await recent.getByRole("button", { name: "Str check, DC 12" }).tap();
    await sheet.getByText("DC hidden. Pass or fail shown. Note: to hear the guards.").waitFor();
    await shots.take(dm, "rolls-sheet-recent");
    await sheet.getByRole("button", { name: "Cancel" }).tap();
    await sheet.waitFor({ state: "detached" });
  });

  test("12. with no stat block the card rolls d20 with a typed bonus, keeps the result until Done, and the DM allows a Heroic Inspiration reroll", async () => {
    // The DM's own card for this request, opened, since a phone's cards start folded.
    const live = dm.getByRole("group", { name: "Roll request: Dex save, DC 10" });
    const id = await ask("save", "dex", 10);
    const c = card(player);
    await c.getByText("The DM asks for a Dexterity saving throw, DC 10.").waitFor();
    assert.equal(await c.getByRole("button", { name: "Roll d20 for Thorn" }).isDisabled(), true, "no bonus is known yet");
    await c.getByText(/^Type your bonus first, such as \+5 or 0\./).waitFor();
    await c.getByLabel("Your bonus for Thorn").fill("4");
    await c.getByRole("button", { name: "Roll d20+4 for Thorn" }).tap();
    await c.getByText(/^Rolled \d+ \(1d20\+4: \d+\)\./).waitFor();
    const rolled = playerSocket.state!.rolls[id]!.targets[0]!;
    assert.ok(rolled.dice && rolled.typedBonus, "rolled on the server with the bonus typed");
    await shots.take(player, "rolls-card-rolled-in-place");
    await c.getByRole("button", { name: "Done, fold it into a chip" }).tap();
    await c.waitFor({ state: "detached" });
    const chip = player.getByRole("button", { name: new RegExp(`^Dex save: rolled ${rolled.total} \\(1d20\\+4, your bonus: \\d+\\)\\. (Pass|Fail)\\. Final\\. Open to ask the DM to change it\\.$`) });
    await chip.waitFor();

    await live.getByRole("button", { expanded: false }).first().tap();
    await live.getByText(new RegExp(`^rolled ${rolled.total} \\(1d20\\+4, your bonus: \\d+\\)`)).waitFor();

    // Heroic Inspiration, asked from the chip's card and allowed in one tap.
    await chip.tap();
    await c.getByRole("button", { name: "Ask the DM to change Thorn's answer" }).tap();
    await player.getByRole("menu", { name: "Ask the DM to change Thorn's answer" }).getByRole("menuitemradio", { name: "Reroll: Heroic Inspiration" }).tap();
    await c.getByText("Asked the DM to reroll (Heroic Inspiration).").waitFor();
    await shots.take(player, "rolls-card-asked");
    await live.getByText("Asks to reroll (Heroic Inspiration)", { exact: true }).waitFor();
    await shots.take(dm, "rolls-dm-ask");
    await live.getByRole("button", { name: "Allow Thorn's ask" }).tap();
    await live.getByText(/^rerolled \d+ \(Heroic Inspiration\), was \d+/).waitFor();
    const changed = await waitFor("the allowed reroll on the player's phone", () => playerSocket.state?.rolls[id]?.targets[0]?.changed);
    assert.equal(changed.reason, "heroic-inspiration");
    await closeAll();
  });

  test("13. with a stat block the card rolls its bonus, reads Restrained and Adv, waits for a typed total to clear, offers Fail (Stunned) first, and the DM rolls a waiting creature", async () => {
    await ops.send({
      t: "character.update",
      characterId: run.thornCharId,
      patch: { level: 1, stats: { abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 12, cha: 10 }, saves: ["dex"], skills: {}, adjust: {}, defenses: {}, rolls: [] } },
    });
    await ops.send({ t: "actor.effect.add", target: { characterId: run.thornCharId }, effect: { id: "fx-restrained", key: "restrained" } });
    await waitFor("Thorn's stat block on the player's phone", () => playerSocket.state?.characters[run.thornCharId]?.stats);
    await ask("save", "dex", 13);
    const c = card(player);
    // Dexterity 16 is +3, and a proficient save at level 1 adds 2.
    const roll = c.getByRole("button", { name: "Roll +5 for Thorn" });
    await roll.waitFor();
    await c.getByText("Rolls 1d20+5 with disadvantage (Restrained).").waitFor();
    await c.getByRole("button", { name: "Advantage", exact: true }).tap();
    await c.getByText("Rolls 1d20+5: Advantage and Restrained cancel.").waitFor();
    await shots.take(player, "rolls-card-restrained-adv");
    await c.getByLabel("Total Thorn rolled").fill("9");
    assert.equal(await roll.isDisabled(), true, "Clear the total to roll instead");
    await c.getByText(/^Clear the total to roll instead\./).waitFor();
    await c.getByLabel("Total Thorn rolled").fill("");

    // Stunned fails a Dexterity save whatever the roll: its Fail comes first.
    await ops.send({ t: "actor.effect.remove", target: { characterId: run.thornCharId }, effectId: "fx-restrained" });
    await ops.send({ t: "actor.effect.add", target: { characterId: run.thornCharId }, effect: { id: "fx-stunned", key: "stunned" } });
    await c.getByRole("button", { name: "Fail (Stunned)" }).waitFor();
    await c.getByText(/Stunned: this save fails whatever the roll\./).waitFor();
    await shots.take(player, "rolls-card-fail-stunned");

    // The DM rolls the waiting creature from the live card: its Fail is recorded with the total.
    const live = dm.getByRole("group", { name: "Roll request: Dex save, DC 13" });
    await live.getByRole("button", { expanded: false }).first().tap();
    await live.getByRole("button", { name: "Roll +5: fails (Stunned) for Thorn" }).tap();
    await live.getByText(/^rolled \d+ \(1d20\+5: \d+\)(, natural (20|1))?, fails \(Stunned\)/).waitFor();
    await c.getByText(/^Rolled \d+ \(1d20\+5: \d+\)\.( Natural (20|1)\.)? Fail \(Stunned\)\. Final\./).waitFor();
    await shots.take(dm, "rolls-dm-rolled-for-thorn");
    await closeAll();

    // A typed answer takes the roll row away.
    await ops.send({ t: "actor.effect.remove", target: { characterId: run.thornCharId }, effectId: "fx-stunned" });
    await ask("check", "wis");
    await c.getByLabel("Total Thorn rolled").fill("12");
    await c.getByRole("button", { name: "Send", exact: true }).tap();
    await c.waitFor({ state: "detached" });
    await player.getByRole("button", { name: /^Wis check: sent 12\./ }).tap();
    await c.getByLabel("Total Thorn rolled").waitFor();
    assert.equal(await c.getByRole("button", { name: /^Roll .* for Thorn$/ }).count(), 0, "no roll after a typed answer");
    await c.getByRole("button", { name: "Fold it into a chip, to answer later" }).or(c.getByRole("button", { name: "Done, fold it into a chip" })).tap();
    await closeAll();
  });

  test("14. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
  });
});
