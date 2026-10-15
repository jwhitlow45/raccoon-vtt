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
async function ask(kind: "save" | "check", ability: Ability): Promise<string> {
  const id = randomUUID();
  await ops.send({ t: "roll.ask", request: { id, test: { kind, choices: [{ ability }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thornCharId }] } });
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

  test("10. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
  });
});
