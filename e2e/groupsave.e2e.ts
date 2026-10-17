import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, tapCell, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * Roll options and the group save (docs/design-v1-roll-options.md 11), on
 * the real server serving the production build, with the DM and a player
 * each on a phone at 375 x 667 and the DM's interface at 130%: one
 * goblin's options from its bar's Roll, a tap on an option scrolled to
 * the foot of the sheet showing its result in view, then three goblins and
 * Bree selected for a DC 13 Dexterity save. The goblins roll on the
 * server, Bree's player answers on her card, 5d6 fire + 5d6 radiant rolls
 * in one line, and Apply hurts each by its save in one step, which the
 * players see as HP lines and one Ctrl+Z takes back whole.
 *
 * The player's card has no Roll of its own in this tree, so Bree's player
 * types her total, the card's other way to answer.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-two, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 22;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-groupsave-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 375, height: 667 };
const HP = 60;
const DC = 13;
/** Bree's typed total, a fail against the DC. */
const BREE_TOTAL = 8;

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
  roomName: `E2E group save ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: "",
  bounds: { w: 30, h: 20 },
  bree: { characterId: randomUUID(), id: randomUUID(), x: 4, y: 3 },
  goblins: [6, 8, 10].map((x, i) => ({ id: randomUUID(), name: `Goblin ${i + 1}`, x, y: 3 })),
  /** A red dragon wyrmling, whose Fire Breath is a save action with its own Group save. */
  dragon: { id: randomUUID(), name: "Wyrmling", x: 13, y: 3 },
  /** A wolf Pat owns that is neither her character nor a companion. */
  wolf: { id: randomUUID(), name: "Wolf", x: 16, y: 3 },
  /** The goblins' save line and the damage line, read once each lands. */
  saves: [] as DiceRoll[],
  fire: 0,
  radiant: 0,
};

type DiceLine = Extract<LogEvent, { type: "dice" }>;
type HpLine = Extract<LogEvent, { type: "hp" }>;

function diceLines(log: readonly LogEntry[] | undefined): DiceLine[] {
  return (log ?? []).flatMap((e) => (e.data?.type === "dice" ? [e.data] : []));
}

function hpLines(log: readonly LogEntry[] | undefined): HpLine[] {
  return (log ?? []).flatMap((e) => (e.data?.type === "hp" ? [e.data] : []));
}

function actor(hp: number, extra: Record<string, unknown> = {}) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...extra };
}

function goblinHp(id: string): number | undefined {
  const t = dmSocket.state?.tokens[id];
  return t && "inline" in t.actor ? t.actor.inline.hp?.cur : undefined;
}

function breeHp(): number | undefined {
  return dmSocket.state?.characters[run.bree.characterId]?.actor.hp?.cur;
}

/** The Dice sheet on a phone. */
function diceSheet(page: Page): Locator {
  return page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
}

/** The sheet's scrolling body as it shows on screen. */
function sheetView(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    type El = { getBoundingClientRect(): { top: number; bottom: number }; querySelectorAll(s: string): ArrayLike<El> };
    const g = globalThis as unknown as { document: { querySelector(s: string): El | null }; getComputedStyle(el: El): { overflowY: string } };
    const sheet = g.document.querySelector('dialog[data-rvtt-sheet][aria-label="Dice"]');
    const body = Array.from(sheet?.querySelectorAll("div") ?? []).find((el) => g.getComputedStyle(el).overflowY === "auto");
    if (!body) throw new Error("The Dice sheet has no scrolling body");
    const r = body.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
}

/** The damage a creature takes from this save's parts: each part halved on its own on a pass, as 5.4 has it. */
function expected(pass: boolean): number {
  return pass ? Math.floor(run.fire / 2) + Math.floor(run.radiant / 2) : run.fire + run.radiant;
}

describe("raccoon-vtt group save", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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

  test("1. the DM makes a room on a phone at 130%, a player joins on a phone, and three goblins and Bree stand on the map", async () => {
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
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

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
    // Hardy goblins linked to the SRD's Goblin Warrior, for its Dexterity save +2: the damage never takes one to 0.
    await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [run.patId], actor: actor(HP) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.bree.id, { kind: "pc", name: "Bree", x: run.bree.x, y: run.bree.y, disposition: "ally", actor: { ref: run.bree.characterId } }));
    for (const g of run.goblins) await ops.send(token(g.id, { kind: "monster", name: g.name, x: g.x, y: g.y, disposition: "hostile", actor: { inline: actor(HP, { srdId: "goblin-warrior" }) } }));
    await ops.send(token(run.dragon.id, { kind: "monster", name: run.dragon.name, x: run.dragon.x, y: run.dragon.y, disposition: "hostile", actor: { inline: actor(HP, { srdId: "red-dragon-wyrmling" }) } }));
    await waitFor("every token on the player's map", () => [run.bree, ...run.goblins, run.dragon].every((t) => playerSocket.state?.tokens[t.id]) || null);

    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("2. a goblin's Roll opens its options, shot at 375 x 667 at 130%, and a tap on a save scrolled to the sheet's foot shows its result in view", async () => {
    const goblin = run.goblins[0]!;
    await tapCell(dm, run.bounds, goblin);
    const bar = dm.getByRole("dialog", { name: `${goblin.name} actions` });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Roll", exact: true }).tap();
    const sheet = diceSheet(dm);
    await sheet.waitFor();
    const options = sheet.locator("[data-roll-options]");
    await options.getByRole("group", { name: "Saves" }).waitFor();
    // The bar's Roll scrolls the panel to the options (4.1).
    const view = await sheetView(dm);
    const top = await options.boundingBox();
    assert.ok(top && top.y >= view.top - 1 && top.y < view.bottom, `the options start at ${top?.y}, outside the sheet's view ${view.top}-${view.bottom}`);
    await shots.take(dm, "groupsave-options-130");

    const save = options.getByRole("button", { name: /^Charisma save/ });
    await save.evaluate((el) => (el as unknown as { scrollIntoView(o: { block: string }): void }).scrollIntoView({ block: "end" }));
    const before = diceLines(dmSocket.state?.log).length;
    await save.tap();
    await waitFor("the Cha save's line", () => diceLines(dmSocket.state?.log).length > before || null);
    const result = save.locator("xpath=..").getByRole("status");
    await result.waitFor();
    // The cell comes into view on its own once its line lands, after any smooth scroll the tap began.
    await waitFor("the result inside the sheet's view", async () => {
      const box = await result.boundingBox();
      const shown = await sheetView(dm);
      return box !== null && box.y >= shown.top - 1 && box.y + box.height <= shown.bottom + 1 ? true : null;
    });
    await shots.take(dm, "groupsave-option-result-130");
    await sheet.getByRole("button", { name: "Close Dice" }).tap();
    await sheet.waitFor({ state: "hidden" });
  });

  test("3. with three goblins and Bree selected, Dex save for 4 against DC 13 rolls the goblins on the server and asks Bree's player", async () => {
    const first = run.goblins[0]!;
    await tapCell(dm, run.bounds, first);
    const bar = dm.getByRole("dialog", { name: `${first.name} actions` });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Multi-select", exact: true }).tap();
    for (const t of [...run.goblins.slice(1), run.bree]) await tapCell(dm, run.bounds, t);
    const group = dm.locator('[role="dialog"][data-bar-mode]');
    await group.getByRole("button", { name: "Roll", exact: true }).tap();
    const sheet = diceSheet(dm);
    await sheet.waitFor();
    const groupRolls = sheet.getByRole("region", { name: "Group rolls" }).or(sheet.locator('section[aria-label="Group rolls"]'));
    await groupRolls.getByText("4 selected").waitFor();

    const dcField = groupRolls.getByLabel("DC for the group");
    await dcField.fill(String(DC));
    await dcField.press("Enter");
    const asksBefore = Object.keys(dmSocket.state?.rolls ?? {}).length;
    const linesBefore = diceLines(dmSocket.state?.log).length;
    await groupRolls.getByRole("button", { name: "Dex save for 4" }).tap();

    // The page opens with the results coming in: one line of three goblin saves, one request for Bree.
    const line = await waitFor("the goblins' saves", () => diceLines(dmSocket.state?.log).slice(linesBefore).find((l) => l.rolls.length === 3) ?? null);
    assert.deepEqual(new Set(line.rolls.map((r) => r.tokenId)), new Set(run.goblins.map((g) => g.id)));
    assert.equal(line.dc, DC);
    run.saves = line.rolls;
    const isBree = (t: { tokenId?: string; characterId?: string }) => t.characterId === run.bree.characterId || t.tokenId === run.bree.id;
    const request = await waitFor("Bree's request", () => Object.values(dmSocket.state?.rolls ?? {}).find((r) => r.targets.some(isBree)) ?? null);
    assert.equal(request.targets.length, 1, "the request asks Bree alone");
    assert.equal(Object.keys(dmSocket.state!.rolls).length, asksBefore + 1, "one request");
    await sheet.getByRole("group", { name: "Creatures" }).waitFor();

    // Bree's player answers on her card.
    const card = player.getByRole("dialog", { name: "The DM asks for a roll" }).or(player.locator('[aria-label="The DM asks for a roll"]'));
    await card.first().waitFor();
    const total = card.first().getByLabel("Total Bree rolled");
    await total.fill(String(BREE_TOTAL));
    await total.press("Enter");
    await waitFor("Bree's answer on the DM's page", () => {
      const r = dmSocket.state?.rolls[request.id];
      return r?.targets.some((t) => t.total === BREE_TOTAL) ? true : null;
    });
    await sheet.getByRole("radiogroup", { name: "Bree: fail, pass or skip" }).getByRole("radio", { name: "Fail", checked: true }).waitFor();
  });

  test("4. 5d6 fire + 5d6 radiant rolls in one line, the rolled page shows Apply in view at 130%, and Apply hurts each by its save in one step that the players see", async () => {
    const sheet = diceSheet(dm);
    const outcome = sheet.getByRole("group", { name: "Outcome" });
    if ((await outcome.count()) === 0) await sheet.getByRole("button", { name: "Edit", exact: true }).tap();
    const damage = sheet.getByLabel("Damage", { exact: true });
    await damage.fill("5d6 fire + 5d6 radiant");
    const before = diceLines(dmSocket.state?.log).length;
    // Enter in the damage field rolls the parts (the shortcut sheet's Dice row).
    await damage.press("Enter");
    const line = await waitFor("the damage line", () => diceLines(dmSocket.state?.log).slice(before).find((l) => l.rolls.length === 2) ?? null);
    const byType = Object.fromEntries(line.rolls.map((r) => [(r.label ?? "").split(", ").at(-1), r]));
    assert.equal(byType.fire?.formula, "5d6");
    assert.equal(byType.radiant?.formula, "5d6");
    run.fire = byType.fire!.total;
    run.radiant = byType.radiant!.total;

    const apply = sheet.getByRole("button", { name: /^Apply: / });
    await apply.waitFor();
    await damage.blur();
    // With the sheet at its top, the rows' count, the first row's name and Apply in the foot show with no scroll (5.8).
    const creatures = sheet.getByRole("group", { name: "Creatures" });
    await creatures.evaluate((el) => (el as unknown as { scrollIntoView(o: { block: string }): void }).scrollIntoView({ block: "start" }));
    const shown = await sheetView(dm);
    for (const [what, part] of [
      ["the count", creatures.getByText(/\d+ (pass|fail)/).first()],
      ["the first row's name", creatures.getByText(run.goblins[0]!.name, { exact: true }).or(creatures.getByText("Bree", { exact: true })).first()],
    ] as const) {
      const box = await part.boundingBox();
      assert.ok(box && box.y >= shown.top - 1 && box.y + box.height <= shown.bottom + 1, `${what} lies at ${box?.y}, outside the sheet's view ${shown.top}-${shown.bottom}`);
    }
    assert.ok(await wholeInReach(apply), "Apply is not in view on the rolled page");
    await shots.take(dm, "groupsave-rolled-130");

    const hpBefore = hpLines(playerSocket.state?.log).length;
    await apply.tap();
    await sheet.getByText("Applied to 4. Undo takes it all back.").waitFor();
    for (const g of run.goblins) {
      const roll = run.saves.find((r) => r.tokenId === g.id)!;
      const want = HP - expected(roll.total >= DC);
      await waitFor(`${g.name} at ${want}`, () => (goblinHp(g.id) === want ? true : null));
    }
    await waitFor(`Bree at ${HP - expected(false)}`, () => (breeHp() === HP - expected(false) ? true : null));

    // The players see the HP lines of the creatures they can see, Bree's with its amount.
    const seen = await waitFor("the HP lines on the player's phone", () => {
      const lines = hpLines(playerSocket.state?.log).slice(hpBefore);
      return lines.length >= 4 ? lines : null;
    });
    const breeLine = seen.find((l) => l.characterId === run.bree.characterId || l.tokenId === run.bree.id);
    assert.equal(breeLine?.amount, expected(false), `Bree's line: ${JSON.stringify(breeLine)}`);
    const goblinIds = new Set<string>(run.goblins.map((g) => g.id));
    assert.deepEqual(new Set(seen.flatMap((l) => (l.tokenId && goblinIds.has(l.tokenId) ? [l.tokenId] : []))), goblinIds);
    // Apply closed the request it asked, so the player's card goes.
    await waitFor("Bree's request closed", () => (Object.keys(dmSocket.state?.rolls ?? {}).length === 0 ? true : null));
    await player.locator('[aria-label="The DM asks for a roll"]').waitFor({ state: "detached" });
    await shots.take(dm, "groupsave-applied-130");
  });

  test("5. one Ctrl+Z takes the whole outcome back", async () => {
    await dm.keyboard.press("Control+z");
    for (const g of run.goblins) await waitFor(`${g.name} back at ${HP}`, () => (goblinHp(g.id) === HP ? true : null));
    await waitFor(`Bree back at ${HP}`, () => (breeHp() === HP ? true : null));
  });

  test("6. the wyrmling's Fire Breath Group save opens on no creature, and the goblins selected after it become its rows (W7B-P-1)", async () => {
    // The applied page and the group of four from the steps before give way first.
    if (await diceSheet(dm).isVisible()) await diceSheet(dm).getByRole("button", { name: "Close Dice" }).tap();
    await dm.getByRole("button", { name: "Let go of all of them" }).first().tap();
    await waitFor("the group let go", async () => ((await dm.getByRole("button", { name: "Let go of all of them" }).count()) === 0 ? true : null));
    // Multi-select from step 3 ends, so a tap selects one token again.
    const done = dm.getByRole("button", { name: "Done", exact: true });
    if (await done.isVisible()) await done.tap();
    await tapCell(dm, run.bounds, run.dragon);
    const bar = dm.getByRole("dialog", { name: `${run.dragon.name} actions` });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Roll", exact: true }).tap();
    const sheet = diceSheet(dm);
    await sheet.waitFor();
    const groupSave = sheet.locator("[data-roll-options]").getByRole("button", { name: "Group save, DC 13 Dex" });
    await groupSave.scrollIntoViewIfNeeded();
    await groupSave.tap();
    await sheet.getByText("Select the creatures it hits, or place an area from it.").waitFor();
    await sheet.getByText("From Fire Breath: Dexterity save, DC 13", { exact: false }).waitFor();
    await sheet.getByRole("button", { name: "Close Dice" }).tap();
    await sheet.waitFor({ state: "hidden" });

    // The goblins selected now are the page's rows: it follows the selection until the roll, and never holds the wyrmling.
    const first = run.goblins[0]!;
    await tapCell(dm, run.bounds, first);
    const goblinBar = dm.getByRole("dialog", { name: `${first.name} actions` });
    await goblinBar.waitFor();
    await goblinBar.getByRole("button", { name: "Multi-select", exact: true }).tap();
    for (const g of run.goblins.slice(1)) await tapCell(dm, run.bounds, g);
    // The group's Roll opens the Dice panel's first page, where the open group save's row opens it again.
    await dm.locator('[role="dialog"][data-bar-mode]').getByRole("button", { name: "Roll", exact: true }).tap();
    await sheet.waitFor();
    await sheet.getByText("Fire Breath's save: set up.").locator("xpath=..").getByRole("button", { name: "Open" }).tap();
    const creatures = sheet.getByRole("group", { name: "Creatures" });
    await creatures.getByText("3 creatures").waitFor();
    for (const g of run.goblins) await creatures.getByText(g.name, { exact: true }).waitFor();
    assert.equal(await creatures.getByText(run.dragon.name, { exact: true }).count(), 0, "the wyrmling is not its own target");
    await shots.take(dm, "groupsave-fire-breath-rows-130");
    await sheet.getByRole("button", { name: "Discard", exact: true }).tap();
    await sheet.getByRole("button", { name: "Close Dice" }).tap();
  });

  test("7. Pat's own wolf, neither her character nor a companion, gets its options from its bar's Roll (W7B-P-7)", async () => {
    await ops.send({ t: "token.create", token: { id: run.wolf.id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: run.wolf.name, x: run.wolf.x, y: run.wolf.y, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor(11, { srdId: "wolf" }) } } });
    await waitFor("the wolf on Pat's map", () => playerSocket.state?.tokens[run.wolf.id]);
    await tapCell(player, run.bounds, run.wolf);
    const bar = player.getByRole("dialog", { name: `${run.wolf.name} actions` });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Roll", exact: true }).tap();
    const sheet = diceSheet(player);
    await sheet.waitFor();
    const options = sheet.locator("[data-roll-options]");
    await options.getByText(`Rolls for ${run.wolf.name}`).waitFor();
    await options.getByRole("button", { name: /^Bite/ }).first().waitFor();
    await shots.take(player, "groupsave-player-wolf-options");
    await sheet.getByRole("button", { name: "Close Dice" }).tap();
  });

  test("8. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });
});
