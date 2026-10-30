import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { AreaTemplate, LogEntry, LogEvent } from "../shared/model.ts";
import { ConsoleWatch, diceFoldsOpen, dragCells, LoadWatch, multiSelect, OpSocket, pagePoint, pickTool, Shots, SocketWatch, startServer, tapCell, waitFor, wholeInReach, type Server } from "./harness.ts";
import { toastOverlapLines } from "./helpers/alignment.ts";

/**
 * A player's save spell end to end (docs/design-v1-player-save-spell.md 8),
 * on the real server serving the production build, with the DM and Pat
 * each on a phone at 390 x 844. Pat plays Thorn, whose block holds
 * Fireball and Hold Person, and Bree. Two goblins stand near, Goblin 2
 * hidden from players. Pat places Fireball and asks for saves from the
 * area, rolling its damage at level 4 in the tap that asks. The DM's card
 * opens the group save filled from Thorn's DC and roll, with a row for the
 * hidden goblin, rolls, Pat answers for Bree, and Apply resolves the ask.
 * Then Hold Person at level 3 goes from its row with both goblins selected,
 * and the DM sets it aside. An asked area offers Pat no move, size or
 * Delete until Pat withdraws. A reload of the DM's phone keeps the group
 * save that holds an ask, so its card stays away until Discard. Hold
 * Person's block takes the focus for its opening only, not when its group
 * reopens or Thorn's tab is picked back, and an ask sent as Spells folds
 * closes the block and leaves the folded line once the DM sets it aside.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-three, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 23;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-savespell-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 16, h: 12 };
const HP = 60;
/** Thorn's spell save DC: 8, proficiency 3 at level 5, Intelligence 4. */
const DC = 15;
/** Bree's typed total, a fail against the DC. */
const BREE_TOTAL = 5;

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
  roomName: `E2E save spell ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thornChar: randomUUID(),
  breeChar: randomUUID(),
  thorn: { id: randomUUID(), x: 2, y: 5 },
  bree: { id: randomUUID(), x: 9, y: 5 },
  goblins: [
    { id: randomUUID(), name: "Goblin 1", number: 1, x: 10, y: 6, visibility: "all" },
    { id: randomUUID(), name: "Goblin 2", number: 2, x: 10, y: 4, visibility: "dm" },
  ],
  /** Thorn's damage roll, as its line landed. */
  fire: 0,
};

type DiceLine = Extract<LogEvent, { type: "dice" }>;
type HpLine = Extract<LogEvent, { type: "hp" }>;

function diceLines(log: readonly LogEntry[] | undefined): DiceLine[] {
  return (log ?? []).flatMap((e) => (e.data?.type === "dice" ? [e.data] : []));
}

function hpLines(log: readonly LogEntry[] | undefined): HpLine[] {
  return (log ?? []).flatMap((e) => (e.data?.type === "hp" ? [e.data] : []));
}

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: HP, max: HP, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

/** Thorn's block: Fireball, which scales by its slot, and Hold Person, a save with no damage. */
const THORN_STATS = {
  abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
  saves: ["int", "wis"],
  skills: {},
  spellAbility: "int",
  adjust: {},
  defenses: {},
  rolls: [
    { id: "fb", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] },
    { id: "hp", name: "Hold Person", kind: "spell", ability: "spell", level: 2, save: { ability: "wis" }, dice: [] },
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

function sheet(page: Page, name: string): Locator {
  return page.locator(`dialog[data-rvtt-sheet][aria-label="${name}"]`);
}

async function openDice(page: Page): Promise<Locator> {
  const dice = sheet(page, "Dice");
  if (await dice.isVisible()) return dice;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Dice/ }).tap();
  await dice.waitFor();
  return dice;
}

async function closeSheet(page: Page, name: string): Promise<void> {
  const s = sheet(page, name);
  if (!(await s.isVisible())) return;
  await s.getByRole("button", { name: `Close ${name}` }).tap();
  await s.waitFor({ state: "hidden" });
}

/** Taps away the toasts the steps before left over the map, as groupsave.e2e.ts does, so a tap on a cell under them reaches the map. */
async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const toast = page.locator("button[data-toast], div[data-toast] > button").filter({ visible: true });
    if ((await toast.count()) === 0) return;
    await toast.first().tap({ timeout: 1000 }).catch(() => {});
  }
}

function areaOptions(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Area options" });
}

/** A slot's control in the area's row, inline or in ⋯, or null where the row has no such slot. */
async function slotControl(page: Page, id: string): Promise<Locator | null> {
  const inline = areaOptions(page).locator(`[data-options-row] > [data-rvtt-slot="${id}"] button`).first();
  if ((await inline.count()) > 0 && (await inline.isVisible())) return inline;
  const more = areaOptions(page).getByRole("button", { name: "More options" });
  if ((await more.count()) === 0 || !(await more.isVisible())) return null;
  await more.tap();
  const menu = page.getByRole("dialog", { name: "More Area options" });
  await menu.waitFor();
  const inMenu = menu.locator(`[data-rvtt-slot="${id}"] button`).first();
  if ((await inMenu.count()) > 0) return inMenu;
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  return null;
}

async function pressSlot(page: Page, id: string): Promise<void> {
  const control = await slotControl(page, id);
  assert.ok(control, `the area's row has no ${id}`);
  await control.tap();
}

async function hasSlot(page: Page, id: string): Promise<boolean> {
  const control = await slotControl(page, id);
  const menu = page.getByRole("dialog", { name: "More Area options" });
  if (await menu.isVisible()) {
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  }
  return control !== null;
}

async function tapWorld(page: Page, world: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, BOUNDS, world);
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(200);
}

/** Pat aims Fireball at a cell from Thorn and places it, then returns it as Pat's socket holds it. */
async function placeFireball(at: { x: number; y: number }): Promise<AreaTemplate> {
  // Pat plays two creatures, so Thorn selected first is the one the area casts from.
  await pickTool(pat, "Select");
  await tapCell(pat, BOUNDS, run.thorn);
  await pat.getByRole("dialog", { name: "Thorn actions" }).waitFor();
  await pickTool(pat, "Area");
  const inRow = areaOptions(pat).locator("[data-options-row]").getByRole("combobox", { name: "Spell" });
  if ((await inRow.count()) > 0 && (await inRow.isVisible())) {
    await inRow.fill("fireball");
    await inRow.press("Enter");
  } else {
    await areaOptions(pat).getByRole("button", { name: /^Shape:/ }).tap();
    const field = pat.getByRole("dialog", { name: "Shape" }).getByRole("textbox", { name: "Spell" });
    await field.fill("fireball");
    await field.press("Enter");
  }
  await pat.waitForTimeout(200);
  await tapWorld(pat, { x: at.x + 0.5, y: at.y + 0.5 });
  const before = new Set(Object.keys(patSocket.state?.templates ?? {}));
  await pressSlot(pat, "place");
  const id = await waitFor("the placed Fireball", () => Object.keys(patSocket.state?.templates ?? {}).find((k) => !before.has(k)) ?? null);
  return patSocket.state!.templates[id]!;
}

/** The DM's card for an ask, opened if a phone folded it. */
async function dmCard(short: string): Promise<Locator> {
  const card = dm.getByRole("group", { name: short });
  await card.waitFor();
  const toggle = card.locator("button[aria-expanded]").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
  return card;
}

describe("raccoon-vtt a player's save spell", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const context of [dmContext, patContext]) await diceFoldsOpen(context);
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

  test("ss-0. the DM's room on a phone, Pat with Thorn and Bree on another, and two goblins, one hidden", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).tap();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).tap();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.patId = await join(patContext, "Pat", "#30a46c");
    await ops.send({ t: "room.update", settings: { playersDraw: "all" } });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(), level: 5, stats: THORN_STATS } });
    await ops.send({ t: "character.create", character: { id: run.breeChar, name: "Bree", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send(tokenOp(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tokenOp(run.bree.id, { kind: "pc", name: "Bree", x: run.bree.x, y: run.bree.y, disposition: "ally", actor: { ref: run.breeChar } }));
    // Goblins linked to the SRD's Goblin Warrior, for its Dexterity save, hardy enough that 9d6 never takes one to 0.
    for (const g of run.goblins) {
      await ops.send(tokenOp(g.id, { kind: "monster", name: "Goblin", number: g.number, x: g.x, y: g.y, visibility: g.visibility, disposition: "hostile", actor: { inline: actor({ srdId: "goblin-warrior" }) } }));
    }
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state?.tokens[run.goblins[0]!.id]);
    assert.equal(patSocket.state!.tokens[run.goblins[1]!.id], undefined, "the hidden goblin reached Pat");
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("ss-1. Pat places Fireball and taps the area's Ask for saves: the block lists the goblin Pat sees and Bree", async () => {
    const area = await placeFireball({ x: 10, y: 5 });
    assert.equal(area.casterId, run.thorn.id, "cast from Thorn");
    await pressSlot(pat, "damage");
    const dice = sheet(pat, "Dice");
    await dice.waitFor();
    const block = dice.getByRole("group", { name: "Ask for saves: Fireball" });
    await block.waitFor();
    await block.getByText("Goblin 1").waitFor();
    await block.getByText("Bree").first().waitFor();
    assert.equal(await block.getByText("Goblin 2").count(), 0, "the hidden goblin shows in Pat's block");
    await block.getByText(`Dexterity save, DC ${DC}, against Fireball`, { exact: false }).waitFor();
    // The sheet opens on the block, its first button focused and in a finger's reach (6, Accessibility).
    const send = block.getByRole("button", { name: "Roll 8d6 Fire and ask" });
    await waitFor("the block in view", async () => ((await wholeInReach(send)) ? true : null));
    await waitFor("focus on the block's first button", () => send.evaluate((el) => el.ownerDocument.activeElement === el || null));
    await shots.take(pat, "savespell-block");
  });

  test("ss-2. at level 4, Roll 9d6 Fire and ask throws the dice and asks, and the waiting line shows", async () => {
    const dice = sheet(pat, "Dice");
    await dice.getByRole("button", { name: "Slot level for Fireball, higher" }).tap();
    const block = dice.getByRole("group", { name: "Ask for saves: Fireball" });
    const send = block.getByRole("button", { name: "Roll 9d6 Fire and ask" });
    await send.waitFor();
    const before = diceLines(patSocket.state?.log).length;
    await send.tap();
    const line = await waitFor("Thorn's damage line", () => diceLines(patSocket.state?.log).slice(before).find((l) => l.rolls.some((r) => r.formula === "9d6")) ?? null);
    run.fire = line.rolls[0]!.total;
    const ask = await waitFor("the ask in the DM's view", () => Object.values(dmSocket.state?.casts ?? {})[0] ?? null);
    assert.deepEqual([ask.spell, ask.slot, ask.area !== undefined, ask.caster], ["Fireball", 4, true, run.thorn.id]);
    assert.deepEqual(ask.rolled, [{ formula: "9d6", total: run.fire, type: "fire" }], "the server copied Thorn's roll");
    await dice.getByText(/asked the DM for saves\. Waiting\./i).first().waitFor();
    await dice.getByRole("button", { name: "Withdraw the ask for saves against Fireball" }).first().waitFor();
    await shots.take(pat, "savespell-waiting");
    await closeSheet(pat, "Dice");
  });

  test("ss-3. the DM's card and Open: the page filled with Thorn's DC and roll, and a row for the hidden goblin", async () => {
    const card = await dmCard("Thorn asks for saves: Fireball");
    await card.getByText("Thorn asks for saves: Fireball, level 4").waitFor();
    await card.getByText(`Thorn rolled ${run.fire} Fire`).waitFor();
    // The DM's count holds the hidden goblin too.
    await card.getByText("In the area: 3").waitFor();
    await shots.take(dm, "savespell-card");
    await card.getByRole("button", { name: "Open the group save for Thorn's Fireball" }).tap();
    const areas = sheet(dm, "Areas");
    await areas.waitFor();
    await areas.getByText(`From Thorn's Fireball at level 4: Dexterity save, DC ${DC} (Thorn's spell save DC), 9d6 Fire, rolled ${run.fire} (Thorn's roll), half on a pass.`).waitFor();
    const creatures = areas.getByRole("group", { name: "Creatures" });
    for (const name of ["Goblin 1", "Goblin 2", "Bree"]) await creatures.getByText(name, { exact: true }).first().waitFor();
    // The page holds the ask, so its card is gone until a Discard.
    await dm.getByRole("group", { name: "Thorn asks for saves: Fireball" }).waitFor({ state: "detached" });
    await shots.take(dm, "savespell-page");
  });

  test("ss-4. Roll, Bree's answer, Apply: the HP lines, the toast, and the waiting line gone", async () => {
    const areas = sheet(dm, "Areas");
    await areas.getByRole("button", { name: /^Roll 2 saves and ask 1 player/ }).tap();
    const request = await waitFor("Bree's request", () => Object.values(dmSocket.state?.rolls ?? {}).find((r) => r.targets.some((t) => t.characterId === run.breeChar || t.tokenId === run.bree.id)) ?? null);
    const card = pat.locator('[aria-label="The DM asks for a roll"]').first();
    await card.waitFor();
    const total = card.getByLabel("Total Bree rolled");
    await total.fill(String(BREE_TOTAL));
    await total.press("Enter");
    await waitFor("Bree's answer on the DM's page", () => (dmSocket.state?.rolls[request.id]?.targets.some((t) => t.total === BREE_TOTAL) ? true : null));

    const hpBefore = hpLines(patSocket.state?.log).length;
    const apply = areas.getByRole("button", { name: /^Apply: / });
    await apply.waitFor();
    await apply.tap();
    await areas.getByText("Applied to 3. Undo takes it all back.").waitFor();
    await waitFor("the ask closed", () => (Object.keys(dmSocket.state?.casts ?? {}).length === 0 && Object.keys(patSocket.state?.casts ?? {}).length === 0 ? true : null));
    const end = (dmSocket.state?.log ?? []).flatMap((e) => (e.data?.type === "cast" ? [e.data] : [])).at(-1);
    assert.equal(end?.end, "done");
    await waitFor(`Bree at ${HP - run.fire}`, () => (dmSocket.state?.characters[run.breeChar]?.actor.hp?.cur === HP - run.fire ? true : null));
    // Pat sees the HP lines of the creatures Pat can see, never the hidden goblin's.
    const seen = await waitFor("the HP lines on Pat's phone", () => {
      const lines = hpLines(patSocket.state?.log).slice(hpBefore);
      return lines.length >= 2 ? lines : null;
    });
    assert.ok(seen.every((l) => l.tokenId !== run.goblins[1]!.id), "the hidden goblin's HP line reached Pat");
    await pat.getByText("The DM resolved Fireball.").first().waitFor();
    await dm.waitForTimeout(300);
    const dice = await openDice(pat);
    await dice.getByText(/asked the DM for saves\. Waiting\./i).waitFor({ state: "detached" });
    await shots.take(pat, "savespell-resolved");
    await closeSheet(pat, "Dice");
    await areas.getByRole("button", { name: "Done", exact: true }).tap();
    await closeSheet(dm, "Areas");
  });

  test("ss-5. Hold Person at level 3 from its row with two goblins selected, then Dismiss and its toast", async () => {
    await ops.send({ t: "token.update", tokenId: run.goblins[1]!.id, patch: { visibility: "all" } });
    await waitFor("Goblin 2 on Pat's map", () => patSocket.state?.tokens[run.goblins[1]!.id]);
    await pickTool(pat, "Select");
    await tapCell(pat, BOUNDS, run.thorn);
    await multiSelect(pat.getByRole("dialog", { name: "Thorn actions" }));
    for (const g of run.goblins) await tapCell(pat, BOUNDS, g);
    await pat.getByRole("dialog", { name: "3 selected tokens" }).waitFor();
    const dice = await openDice(pat);
    await dice.getByRole("button", { name: "Ask the DM for saves against Hold Person" }).tap();
    const block = dice.getByRole("group", { name: "Ask for saves: Hold Person" });
    await block.getByText("Targets (2): Goblin 1, Goblin 2").waitFor();
    await block.getByRole("button", { name: "Casting level for Hold Person, higher" }).tap();
    await block.getByText(`Wisdom save, DC ${DC}, against Hold Person at level 3`).waitFor();
    await shots.take(pat, "savespell-hold-person");
    await block.getByRole("button", { name: "Ask the DM", exact: true }).tap();
    const ask = await waitFor("Hold Person's ask", () => Object.values(dmSocket.state?.casts ?? {})[0] ?? null);
    assert.deepEqual([ask.spell, ask.slot, ask.targets], ["Hold Person", 3, run.goblins.map((g) => g.id)]);

    const card = await dmCard("Thorn asks for saves: Hold Person");
    await card.getByText("Thorn asks for saves: Hold Person, level 3").waitFor();
    await card.getByText("No damage rolled").waitFor();
    await card.getByText("Targets: Goblin 1, Goblin 2").waitFor();
    await shots.take(dm, "savespell-card-targets");
    await card.getByRole("button", { name: "Dismiss Thorn's Hold Person" }).tap();
    await waitFor("the ask set aside", () => (Object.keys(patSocket.state?.casts ?? {}).length === 0 ? true : null));
    await pat.getByText("The DM set Hold Person aside.").first().waitFor();
    await closeSheet(pat, "Dice");
    const done = pat.getByRole("button", { name: "Done", exact: true });
    if (await done.isVisible()) await done.tap();
  });

  test("ss-6. the asked area offers Pat no move, size or Delete until Pat withdraws", async () => {
    const area = await placeFireball({ x: 5, y: 9 });
    assert.ok(await hasSlot(pat, "size"), "a new area has no size");
    await pressSlot(pat, "damage");
    const dice = sheet(pat, "Dice");
    const block = dice.getByRole("group", { name: "Ask for saves: Fireball" });
    await block.getByRole("button", { name: "Ask, the DM rolls" }).tap();
    await waitFor("the area's ask", () => Object.values(patSocket.state?.casts ?? {}).find((a) => a.area === area.id) ?? null);
    await closeSheet(pat, "Dice");

    // Still picked in the Area tool, the area reads as asked and has no control that changes it.
    await areaOptions(pat).getByText("Saves asked", { exact: false }).first().waitFor();
    for (const id of ["size", "delete"]) assert.equal(await hasSlot(pat, id), false, `the asked area offers ${id}`);
    assert.ok(await pat.locator("[data-toast]:visible").count() >= 2, "HF-41: the asked area must exercise multiple toasts");
    assert.deepEqual(await toastOverlapLines(pat, "HF-41 asked area"), [], "visible toasts must never overlap");
    await shots.take(pat, "savespell-asked-area");
    await dragCells(pat, BOUNDS, { x: 5, y: 9 }, { x: 7, y: 9 });
    await pat.waitForTimeout(400);
    const now = dmSocket.state!.templates[area.id]!;
    assert.deepEqual(now.origin, area.origin, "the asked area moved");

    const open = await openDice(pat);
    await open.getByRole("button", { name: "Withdraw the ask for saves against Fireball" }).first().tap();
    await waitFor("the ask withdrawn", () => (Object.keys(dmSocket.state?.casts ?? {}).length === 0 ? true : null));
    await closeSheet(pat, "Dice");
    await waitFor("the area's size back", async () => ((await hasSlot(pat, "size")) ? true : null));
  });

  test("ss-7. the DM's phone reloads with an ask's group save open: the card stays away until Discard", async () => {
    await pickTool(pat, "Select");
    await tapCell(pat, BOUNDS, run.thorn);
    await multiSelect(pat.getByRole("dialog", { name: "Thorn actions" }));
    for (const g of run.goblins) await tapCell(pat, BOUNDS, g);
    await pat.getByRole("dialog", { name: "3 selected tokens" }).waitFor();
    const dice = await openDice(pat);
    await dice.getByRole("button", { name: "Ask the DM for saves against Hold Person" }).tap();
    await dice.getByRole("group", { name: "Ask for saves: Hold Person" }).getByRole("button", { name: "Ask the DM", exact: true }).tap();
    await waitFor("Hold Person's ask", () => Object.values(dmSocket.state?.casts ?? {})[0] ?? null);
    await closeSheet(pat, "Dice");
    const done = pat.getByRole("button", { name: "Done", exact: true });
    if (await done.isVisible()) await done.tap();

    const card = await dmCard("Thorn asks for saves: Hold Person");
    await card.getByRole("button", { name: "Open the group save for Thorn's Hold Person" }).tap();
    await dm.getByText("From Thorn's Hold Person", { exact: false }).first().waitFor();
    // A phone that drops a background tab reloads it. The page comes back from its draft, so the ask has no card to start a second page from.
    const loads = new LoadWatch();
    loads.attach(dm);
    await dm.reload();
    await dm.locator(".konvajs-content").first().waitFor();
    await loads.preloaded();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(await dm.getByRole("group", { name: "Thorn asks for saves: Hold Person" }).count(), 0, "the held ask showed its card after a reload");
    const dmDice = await openDice(dm);
    await dmDice.getByText("Hold Person's save", { exact: false }).first().waitFor();
    await shots.take(dm, "savespell-reloaded-page");
    await dmDice.getByRole("button", { name: "Open", exact: true }).first().tap();
    await dmDice.getByRole("button", { name: "Discard", exact: true }).tap();
    // Over a sheet the card folds into the alerts summary, so the sheet closes first.
    await closeSheet(dm, "Dice");
    const back = await dmCard("Thorn asks for saves: Hold Person");
    await back.getByRole("button", { name: "Dismiss Thorn's Hold Person" }).tap();
    await waitFor("the ask set aside", () => (Object.keys(dmSocket.state?.casts ?? {}).length === 0 ? true : null));
  });

  test("ss-7b. Hold Person's block takes the focus for its opening only, and folded, its ask still closes it and the DM's Dismiss clears the folded line", async () => {
    await pickTool(pat, "Select");
    // ss-7's ask and the DM's Dismiss leave two notes over Pat's map, the first with about a second of its 5 s left, and Thorn's cell lies under the second.
    await dismissToasts(pat);
    await tapCell(pat, BOUNDS, run.thorn);
    await multiSelect(pat.getByRole("dialog", { name: "Thorn actions" }));
    for (const g of run.goblins) await tapCell(pat, BOUNDS, g);
    await pat.getByRole("dialog", { name: "3 selected tokens" }).waitFor();
    const dice = await openDice(pat);
    const spells = dice.locator("[data-group-fold]").and(dice.getByRole("button", { name: "Spells", exact: true }));
    const block = dice.getByRole("group", { name: "Ask for saves: Hold Person" });
    const focused = (at: Locator) => at.evaluate((el) => el.ownerDocument.activeElement === el);
    /** The Dice sheet's own scroll offset. */
    const place = () =>
      spells.evaluate((el) => {
        type Box = { parentElement: Box | null; scrollTop: number };
        const g = globalThis as unknown as { getComputedStyle(el: Box): { overflowY: string } };
        let box = (el as unknown as Box).parentElement;
        while (box && g.getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        return box?.scrollTop ?? -1;
      });
    await dice.getByRole("button", { name: "Ask the DM for saves against Hold Person" }).tap();
    await waitFor("the opening's focus in its block", () => block.evaluate((el) => el.contains(el.ownerDocument.activeElement) || null));

    // Folded and opened again by keys: the block draws again, and the focus and the panel's place stay.
    await spells.focus();
    await pat.keyboard.press("Enter");
    await waitFor("Spells folded", async () => ((await spells.getAttribute("aria-expanded")) === "false" ? true : null));
    const top = await place();
    await pat.keyboard.press("Enter");
    await block.waitFor();
    await pat.waitForTimeout(300);
    assert.equal(await focused(spells), true, "the focus stays on the fold row");
    assert.ok(Math.abs((await place()) - top) <= 1, "the panel keeps its place");

    // Bree's tab and back by arrow keys: Thorn's block draws again, and the focus stays on his tab.
    const thorn = dice.getByRole("tablist", { name: "Roll for" }).getByRole("tab", { name: "Thorn", exact: true });
    await thorn.focus();
    await pat.keyboard.press("ArrowRight");
    await dice.getByRole("region", { name: "Rolls for Bree" }).waitFor();
    await pat.keyboard.press("ArrowLeft");
    await block.waitFor();
    await pat.waitForTimeout(300);
    assert.equal(await focused(thorn), true, "the focus stays on Thorn's tab");
    await shots.take(pat, "savespell-block-focus-kept");

    // Asked, then folded on the next task, before the server's answer can land: the open block's send is marked seen as Thorn's groups render with it, so it opens nothing and the fold stays.
    await block.getByRole("button", { name: "Ask the DM", exact: true }).evaluate(async (button) => {
      type El = { click(): void; textContent: string | null; closest(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
      const root = (button as unknown as El).closest("[data-roll-options]")!;
      (button as unknown as El).click();
      await new Promise((done) => setTimeout(done, 0));
      Array.from(root.querySelectorAll("[data-group-fold]"))
        .find((f) => f.textContent?.startsWith("Spells"))!
        .click();
    });
    assert.equal(await spells.getAttribute("aria-expanded"), "false", "folded before the answer");
    await waitFor("Hold Person's ask", () => Object.values(dmSocket.state?.casts ?? {})[0] ?? null);
    await dice.getByRole("group", { name: "Asks for saves" }).getByText("Asked the DM for saves. Waiting.").waitFor();
    await spells.getByText("Ask for saves waiting: Hold Person", { exact: false }).waitFor();
    await shots.take(pat, "savespell-folded-asked");

    // The DM sets it aside while Pat's Spells stays folded: the folded line lets it go, and no block comes back.
    const card = await dmCard("Thorn asks for saves: Hold Person");
    await card.getByRole("button", { name: "Dismiss Thorn's Hold Person" }).tap();
    await waitFor("the ask set aside", () => (Object.keys(patSocket.state?.casts ?? {}).length === 0 ? true : null));
    await waitFor("the folded line without the ask", async () => (/Ask for saves waiting/.test((await spells.textContent()) ?? "") ? null : true));
    await spells.tap();
    await dice.getByRole("button", { name: "Ask the DM for saves against Hold Person" }).waitFor();
    assert.equal(await block.count(), 0, "the settled ask's block came back");
    await closeSheet(pat, "Dice");
    const done = pat.getByRole("button", { name: "Done", exact: true });
    if (await done.isVisible()) await done.tap();
  });

  test("ss-8. nothing went wrong in the browsers", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
