import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, openSideTab, reopenRoom, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * The Dice panel's folds (docs/design-v1-dice-pass.md 6), on the real
 * server serving the production build: how the groups start for the DM
 * at 1440 x 900 and 1024 x 768 and for a player at 390 x 844 and 440 x
 * 956, a fold this device keeps after a reload and keeps apart by kind of
 * creature, an ask that opens Saves and checks once, for Pat's Thorn and
 * for the NPC the DM lent him (a monster's fold), and never again after a
 * tab pick, Pat's creatures as tabs by tap and by arrow keys, and a
 * token's Roll landing the panel with Adv, Dis and Secret whole (8), from
 * the top, and from the panel's foot on a computer and on a phone, and
 * Recent rolls joining the last group, or standing under a lone card, as
 * the panel comes back from the group save page.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-eight, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 28;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-dicefolds-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const COMPUTER = { width: 1440, height: 900 };
const LAPTOP = { width: 1024, height: 768 };
const PHONE = { width: 390, height: 844 };
const BIG_PHONE = { width: 440, height: 956 };
const BOUNDS = { w: 20, h: 12 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E dice folds ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: "",
  thornChar: randomUUID(),
  thorn: { id: randomUUID(), x: 3, y: 3 },
  wolf: { id: randomUUID(), x: 4, y: 3 },
  /** The DM's NPC, lent to Pat: a token of its own, which folds with the monsters. */
  sildar: { id: randomUUID(), x: 5, y: 3 },
  goblin: { id: randomUUID(), x: 9, y: 3 },
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 1, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

/** Thorn's block: a weapon, a cantrip and a first-level spell, for Actions and Spells by level. */
const THORN_STATS = {
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 16, cha: 10 },
  saves: ["wis", "cha"],
  skills: { athletics: "prof" },
  spellAbility: "wis",
  adjust: {},
  defenses: {},
  rolls: [
    { id: "ls", name: "Longsword", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "slashing" }] },
    { id: "sf", name: "Sacred Flame", kind: "spell", ability: "spell", level: 0, save: { ability: "dex", onPass: "none" }, dice: [{ formula: "1d8", type: "radiant" }] },
    { id: "gb", name: "Guiding Bolt", kind: "spell", ability: "spell", level: 1, attack: { prof: true, bonus: 0 }, dice: [{ formula: "4d6", type: "radiant", upcast: "1d6" }] },
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

async function closeDiceSheet(page: Page): Promise<void> {
  const dice = diceSheet(page);
  if (!(await dice.isVisible())) return;
  await dice.getByRole("button", { name: "Close Dice" }).tap();
  await dice.waitFor({ state: "hidden" });
}

/** A group's fold row in the options, named by the group alone (components/Panel.tsx Group). */
function fold(options: Locator, name: string): Locator {
  return options.locator("[data-group-fold]").and(options.getByRole("button", { name, exact: true }));
}

/** Whether each named group shows open, waiting for the options to draw. */
async function starts(options: Locator, names: readonly string[]): Promise<Record<string, boolean>> {
  await fold(options, "Saves and checks").waitFor();
  const out: Record<string, boolean> = {};
  for (const name of names) out[name] = (await fold(options, name).getAttribute("aria-expanded")) === "true";
  return out;
}

/** The tab of one of Pat's creatures. */
function tab(options: Locator, name: string): Locator {
  return options.getByRole("tablist", { name: "Roll for" }).getByRole("tab", { name, exact: true });
}

async function pick(options: Locator, name: string): Promise<void> {
  await tab(options, name).tap();
  await options.getByRole("region", { name: `Rolls for ${name}` }).waitFor();
  await fold(options, "Saves and checks").waitFor();
}

function storedFolds(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("rvtt.diceFolds") ?? "{}") as Record<string, boolean>);
}

async function ask(id: string, target: { characterId: string } | { tokenId: string }, ability: string): Promise<void> {
  await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability }] }, dcShown: false, resultShown: true, targets: [target] } });
  await waitFor(`the ask ${id} on Pat's page`, () => patSocket.state?.rolls[id]);
}

/** A page of another device of the same member: the cookies of `from`, this device's own storage. */
async function another(from: BrowserContext, viewport: { width: number; height: number }, touch: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
  await context.addCookies(await from.cookies(server.origin));
  const page = await context.newPage();
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.locator(".konvajs-content").first().waitFor();
  return { context, page };
}

/** What the in-page code reads, typed here since the e2e files are built without the DOM's types. */
type Box = { parentElement: Box | null; scrollTop: number; scrollHeight: number; getBoundingClientRect(): { top: number; bottom: number } };
type Doc = { document: { activeElement: unknown; querySelector(selector: string): Box | null }; getComputedStyle(el: Box): { overflowY: string } };

/** Scrolls the Dice panel's own scroller, the one around `inside`, to its foot. */
async function toFoot(inside: Locator): Promise<void> {
  await inside.evaluate((el) => {
    const g = globalThis as unknown as Doc;
    let box = (el as unknown as Box).parentElement;
    while (box && g.getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  });
}

/**
 * Where a token's Roll landed the Dice panel in `within`, once any smooth
 * scroll and restored place have settled (the same box twice running):
 * the roll modes whole under the sticky line, and the card after them
 * inside the scroller (docs/design-v1-dice-pass.md 8).
 */
async function landed(page: Page, within: Locator) {
  const measure = () =>
    within.locator("[data-dice-modes]").evaluate((el) => {
      const g = globalThis as unknown as Doc;
      const modes = el as unknown as Box;
      let box = modes.parentElement;
      while (box && g.getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
      const b = box!.getBoundingClientRect();
      const last = g.document.querySelector("[data-dice-last]")!.getBoundingClientRect();
      const m = modes.getBoundingClientRect();
      const card = g.document.querySelector("[data-dice-card]")!.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), sticky: Math.round(last.bottom), modesTop: Math.round(m.top), modesBottom: Math.round(m.bottom), cardBottom: Math.round(card.bottom), scroll: box!.scrollTop };
    });
  await page.waitForTimeout(400);
  let seen = await measure();
  await waitFor("the panel and its scroll to settle", async () => {
    await page.waitForTimeout(150);
    const now = await measure();
    const still = JSON.stringify(now) === JSON.stringify(seen);
    seen = now;
    return still ? true : null;
  });
  assert.ok(seen.modesTop >= seen.sticky, `the roll modes start under the sticky line: ${JSON.stringify(seen)}`);
  assert.ok(seen.modesBottom <= seen.bottom, `the roll modes end inside the panel: ${JSON.stringify(seen)}`);
  assert.ok(seen.cardBottom <= seen.bottom, `the card follows them whole: ${JSON.stringify(seen)}`);
  return seen;
}

const DM_GROUPS = ["Saves and checks", "Skills", "Actions"] as const;
const PAT_GROUPS = ["Saves and checks", "Skills", "Actions", "Spells"] as const;

describe("raccoon-vtt dice folds", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: COMPUTER });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
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

  test("df-0. the DM's room at 1440 x 900, Pat on a phone with Thorn, his wolf and the NPC lent to him, and a goblin", async () => {
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
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(), level: 5, stats: THORN_STATS } });
    await ops.send(tokenOp(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tokenOp(run.wolf.id, { kind: "monster", name: "Wolf", x: run.wolf.x, y: run.wolf.y, disposition: "ally", ownerIds: [run.patId], companion: { of: run.thornChar, turn: "shared" }, actor: { inline: actor({ srdId: "wolf" }) } }));
    await ops.send(tokenOp(run.sildar.id, { kind: "npc", name: "Sildar", x: run.sildar.x, y: run.sildar.y, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor() } }));
    await ops.send(tokenOp(run.goblin.id, { kind: "monster", name: "Goblin", x: run.goblin.x, y: run.goblin.y, disposition: "hostile", actor: { inline: actor({ srdId: "goblin-warrior" }) } }));
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's three creatures", () => [run.thorn, run.wolf, run.sildar].every((t) => patSocket.state?.tokens[t.id]) || null);
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("df-1. at 1440 x 900 and 1024 x 768 a monster's Saves and checks and Actions start open, and its Skills folded", async () => {
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    await tapCell(dm, bounds, run.goblin);
    await openSideTab(dm, "Dice");
    const options = dm.getByRole("tabpanel", { name: sideTabName("Dice") }).locator("[data-roll-options]");
    await options.getByRole("region", { name: "Rolls for Goblin" }).waitFor();
    assert.deepEqual(await starts(options, DM_GROUPS), { "Saves and checks": true, Skills: false, Actions: true });
    await shots.take(dm, "df-1-dm-1440-goblin");

    const laptop = await another(dmContext, LAPTOP, false);
    try {
      await tapCell(laptop.page, bounds, run.goblin);
      await openSideTab(laptop.page, "Dice");
      const there = laptop.page.getByRole("tabpanel", { name: sideTabName("Dice") }).locator("[data-roll-options]");
      await there.getByRole("region", { name: "Rolls for Goblin" }).waitFor();
      assert.deepEqual(await starts(there, DM_GROUPS), { "Saves and checks": true, Skills: false, Actions: true });
      await shots.take(laptop.page, "df-1-dm-1024-goblin");
    } finally {
      await laptop.context.close();
    }
  });

  test("df-2. on a phone at 390 x 844 and 440 x 956 Thorn's Saves and checks start folded, Skills too, and Actions and Spells open", async () => {
    const dice = await openDiceSheet(pat);
    const options = dice.locator("[data-roll-options]");
    await options.getByRole("region", { name: "Rolls for Thorn" }).waitFor();
    assert.deepEqual(await starts(options, PAT_GROUPS), { "Saves and checks": false, Skills: false, Actions: true, Spells: true });
    assert.deepEqual(await storedFolds(pat), {}, "starts are never stored");
    await shots.take(pat, "df-2-pat-390-thorn");

    const big = await another(patContext, BIG_PHONE, true);
    try {
      const there = (await openDiceSheet(big.page)).locator("[data-roll-options]");
      await there.getByRole("region", { name: "Rolls for Thorn" }).waitFor();
      assert.deepEqual(await starts(there, PAT_GROUPS), { "Saves and checks": false, Skills: false, Actions: true, Spells: true });
      await shots.take(big.page, "df-2-pat-440-thorn");
    } finally {
      await big.context.close();
    }
  });

  test("df-3. Pat's creatures are tabs: a tap picks one, and Left, Right, Home and End pick and keep focus on the tab picked", async () => {
    const options = diceSheet(pat).locator("[data-roll-options]");
    // Each tab's name is its last words: its picture's initials before them are hidden decoration.
    const names = await options.getByRole("tablist", { name: "Roll for" }).getByRole("tab").evaluateAll((tabs) => tabs.map((t) => t.lastChild?.textContent ?? ""));
    assert.deepEqual(names, ["Thorn", "Wolf", "Sildar"]);
    await pick(options, "Wolf");
    assert.equal(await tab(options, "Wolf").getAttribute("aria-selected"), "true");
    assert.equal(await tab(options, "Thorn").getAttribute("tabindex"), "-1", "one Tab stop, on the tab picked");
    await shots.take(pat, "df-3-pat-390-wolf-tab");
    const focused = (name: string) => tab(options, name).evaluate((el) => el === (globalThis as unknown as Doc).document.activeElement);
    await tab(options, "Wolf").focus();
    for (const [key, name] of [["ArrowRight", "Sildar"], ["ArrowRight", "Thorn"], ["ArrowLeft", "Sildar"], ["Home", "Thorn"], ["End", "Sildar"], ["ArrowLeft", "Wolf"]] as const) {
      await pat.keyboard.press(key);
      await options.getByRole("region", { name: `Rolls for ${name}` }).waitFor();
      assert.equal(await tab(options, name).getAttribute("aria-selected"), "true", `${key} picks ${name}`);
      assert.equal(await focused(name), true, `focus stays on ${name}'s tab after ${key}, though its options drew again`);
    }
    await pick(options, "Thorn");
  });

  test("df-4. a fold Pat taps is kept after a reload, for that kind of creature only", async () => {
    let options = diceSheet(pat).locator("[data-roll-options]");
    await fold(options, "Skills").tap();
    await options.getByRole("button", { name: /^Athletics/ }).waitFor();
    assert.deepEqual(await storedFolds(pat), { "pc.skills": true });
    await reopenRoom(pat);
    options = (await openDiceSheet(pat)).locator("[data-roll-options]");
    await options.getByRole("region", { name: "Rolls for Thorn" }).waitFor();
    assert.deepEqual(await starts(options, PAT_GROUPS), { "Saves and checks": false, Skills: true, Actions: true, Spells: true }, "Thorn's Skills, kept");
    await pick(options, "Wolf");
    assert.equal(await fold(options, "Skills").getAttribute("aria-expanded"), "false", "a companion's Skills keep their own fold");
    await pick(options, "Sildar");
    assert.equal(await fold(options, "Skills").getAttribute("aria-expanded"), "false", "and so do the NPC's, a monster's");
    await pick(options, "Thorn");
    // Back as it was, so the steps after start from the phone's starts.
    await fold(options, "Skills").tap();
    assert.equal(await fold(options, "Skills").getAttribute("aria-expanded"), "false");
  });

  test("df-5. an ask opens Thorn's folded Saves and checks once, folded again it stays folded through a tab pick, and the NPC's ask opens a monster's", async () => {
    const options = diceSheet(pat).locator("[data-roll-options]");
    assert.equal(await fold(options, "Saves and checks").getAttribute("aria-expanded"), "false");
    await ask(randomUUID(), { characterId: run.thornChar }, "dex");
    await waitFor("Saves and checks opened by the ask", async () => ((await fold(options, "Saves and checks").getAttribute("aria-expanded")) === "true" ? true : null));
    await options.getByRole("button", { name: /^Dexterity save, answers the DM's request/ }).waitFor();
    await shots.take(pat, "df-5-pat-390-ask-opens");
    const before = await storedFolds(pat);
    assert.equal(before["pc.saves"], undefined, "an opening by the app is never stored");

    await fold(options, "Saves and checks").tap();
    assert.equal(await fold(options, "Saves and checks").getAttribute("aria-expanded"), "false");
    await pick(options, "Wolf");
    await pick(options, "Thorn");
    assert.equal(await fold(options, "Saves and checks").getAttribute("aria-expanded"), "false", "not opened again by a tab pick");
    assert.match((await fold(options, "Saves and checks").textContent()) ?? "", /Asked: DEX save/, "its line leads with the ask still waiting");
    await shots.take(pat, "df-5-pat-390-ask-folded");

    // The DM asks the NPC lent to Pat while Pat looks at Thorn: it opens Sildar's own group, a monster's, as Pat picks him.
    await ask(randomUUID(), { tokenId: run.sildar.id }, "wis");
    await pick(options, "Sildar");
    assert.equal(await fold(options, "Saves and checks").getAttribute("aria-expanded"), "true", "the NPC's Saves and checks opened");
    await options.getByRole("button", { name: /^Wisdom save, answers the DM's request/ }).waitFor();
    await pick(options, "Wolf");
    assert.equal(await fold(options, "Saves and checks").getAttribute("aria-expanded"), "false", "the wolf's, a companion's, did not");
    assert.deepEqual(await storedFolds(pat), { "pc.skills": false, "pc.saves": false }, "only Pat's own taps are stored");
    await pick(options, "Thorn");
  });

  test("df-6. Thorn's bar's Roll lands the panel with Adv, Dis and Secret whole under the sticky line, and the card after them", async () => {
    const dice = diceSheet(pat);
    const options = dice.locator("[data-roll-options]");
    // A roll first, so the sticky line shows, then the sheet scrolled to its foot and closed.
    await fold(options, "Actions").waitFor();
    await options.getByRole("button", { name: /^Longsword/ }).first().tap();
    await dice.locator("[data-dice-last]").getByRole("button", { name: "Show this roll in Recent rolls" }).waitFor();
    await toFoot(dice.locator("[data-roll-options]"));
    await closeDiceSheet(pat);
    await tapCell(pat, patSocket.state!.scenes[run.sceneId]!.bounds, run.thorn);
    const bar = pat.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Roll", exact: true }).tap();
    await dice.waitFor();
    await landed(pat, dice);
    await shots.take(pat, "df-6-pat-390-bar-roll");
    await closeDiceSheet(pat);
  });

  test("df-6b. at 1440 x 900, the goblin's bar's Roll lands the side panel, scrolled to its foot, on the roll modes under the sticky line", async () => {
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Dice") });
    const options = panel.locator("[data-roll-options]");
    await options.getByRole("region", { name: "Rolls for Goblin" }).waitFor();
    // A roll first, so the sticky line shows, then the panel scrolled to its foot, still open.
    await options.getByRole("button", { name: /^Scimitar/ }).first().click();
    await panel.locator("[data-dice-last]").getByRole("button", { name: "Show this roll in Recent rolls" }).waitFor();
    await toFoot(options);
    const bar = dm.getByRole("dialog", { name: "Goblin actions" });
    if (!(await bar.isVisible())) await tapCell(dm, dmSocket.state!.scenes[run.sceneId]!.bounds, run.goblin);
    await bar.getByRole("button", { name: "Roll", exact: true }).click();
    const seen = await landed(dm, panel);
    assert.ok(seen.scroll > 0, `the panel scrolled to the modes, not its top: ${JSON.stringify(seen)}`);
    await shots.take(dm, "df-6b-dm-1440-bar-roll-from-foot");
  });

  test("df-6c. on a phone, Thorn's bar's Roll lands the sheet on the roll modes though it reopens at the foot it was left at", async () => {
    const dice = diceSheet(pat);
    const bar = pat.getByRole("dialog", { name: "Thorn actions" });
    if (!(await bar.isVisible())) await tapCell(pat, patSocket.state!.scenes[run.sceneId]!.bounds, run.thorn);
    await bar.getByRole("button", { name: "Roll", exact: true }).tap();
    await landed(pat, dice);
    // Left at its foot, which the sheet keeps for Thorn when it shows again.
    await toFoot(dice.locator("[data-roll-options]"));
    await pat.waitForTimeout(300);
    await closeDiceSheet(pat);
    if (!(await bar.isVisible())) await tapCell(pat, patSocket.state!.scenes[run.sceneId]!.bounds, run.thorn);
    await bar.getByRole("button", { name: "Roll", exact: true }).tap();
    await dice.waitFor();
    await landed(pat, dice);
    await shots.take(pat, "df-6c-pat-390-bar-roll-from-foot");
    await closeDiceSheet(pat);
  });

  test("df-6d. Recent rolls joins the options' last group, and keeps its gap under a lone card, however the panel comes back from the group save page", async () => {
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Dice") });
    const rolls = panel.locator('section[aria-label="Group rolls"]');
    const notice = panel.locator("[data-open-group-save]");
    /** Recent rolls' top less the foot of the options' last group, and less the card's foot, in the panel's own px. */
    const gaps = () =>
      panel.evaluate((root) => {
        type El = { offsetHeight: number; getBoundingClientRect(): { top: number; bottom: number; height: number }; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
        const r = root as unknown as El;
        const zoom = r.getBoundingClientRect().height / r.offsetHeight;
        const recent = r.querySelector("[data-dice-recent]")!.getBoundingClientRect().top;
        const options = r.querySelector("[data-roll-options]")!;
        const groups = options.querySelectorAll("[data-panel-group]");
        const last = groups.length > 0 ? groups[groups.length - 1]!.getBoundingClientRect().bottom : null;
        const card = options.querySelector("[data-dice-card]")!.getBoundingClientRect().bottom;
        return { toGroup: last === null ? null : (recent - last) / zoom, toCard: (recent - card) / zoom };
      });
    const back = () => dm.getByRole("button", { name: "Back to Dice" }).filter({ visible: true }).first().click();
    /** Another side tab and back to Dice, so the panel mounts afresh on whatever page it shows. */
    const remount = async () => {
      await openSideTab(dm, "Token");
      await openSideTab(dm, "Dice");
    };

    // Two selected, the goblin and Sildar, and a group save set up from their card.
    const bar = dm.getByRole("dialog", { name: "Goblin actions" });
    if (!(await bar.isVisible())) await tapCell(dm, bounds, run.goblin);
    await bar.getByRole("button", { name: "Multi-select", exact: true }).click();
    await tapCell(dm, bounds, run.sildar);
    await openSideTab(dm, "Dice");
    await rolls.getByRole("heading", { name: "2 selected" }).waitFor();
    await rolls.getByRole("button", { name: "Set up a group save", exact: true }).click();

    // The panel mounts on the group save page, then steps back to two selected: Recent rolls touches their last group.
    await remount();
    await dm.getByRole("button", { name: "Back to Dice" }).filter({ visible: true }).first().waitFor();
    await back();
    await rolls.getByRole("heading", { name: "2 selected" }).waitFor();
    let seen = await gaps();
    assert.ok(seen.toGroup !== null && Math.abs(seen.toGroup) <= 1, `mounted on the page, Recent rolls joins the last group: ${JSON.stringify(seen)}`);

    // Mounted on the first page, then the group save page in place, nobody selected there, and back: the card's gap stays.
    await remount();
    await rolls.getByRole("heading", { name: "2 selected" }).waitFor();
    await notice.getByRole("button", { name: "Open", exact: true }).click();
    await dm.getByRole("button", { name: "Deselect all" }).first().click();
    const done = dm.getByRole("button", { name: "Done", exact: true });
    if (await done.isVisible()) await done.click();
    await back();
    await panel.getByText("Select a token to roll for it.").waitFor();
    seen = await gaps();
    assert.equal(seen.toGroup, null, "nobody selected draws no group");
    assert.ok(Math.abs(seen.toCard - 8) <= 1, `back with nobody selected, Recent rolls stands 8 px under the card: ${JSON.stringify(seen)}`);
    await shots.take(dm, "df-6d-dm-1440-recent-under-card");

    await notice.getByRole("button", { name: "Open", exact: true }).click();
    await panel.getByRole("button", { name: "Discard", exact: true }).first().click();
    await notice.waitFor({ state: "detached" });
  });

  test("df-7. nothing went wrong in the browsers", () => {
    assert.deepEqual(consoles.dm.errors, []);
    assert.deepEqual(consoles.pat.errors, []);
  });
});
