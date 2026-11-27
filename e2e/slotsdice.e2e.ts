import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { uuidv7 } from "#shared/ids.ts";
import type { Character, DiceRoll, LogEntry } from "#shared/model.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { barControl, ConsoleWatch, diceFoldsOpen, multiSelect, namedId, openSideTab, OpSocket, pickTool, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Spell slots and Hit Point Dice (docs/design/design-v1-slots.md), on the
 * real server serving the production build. Kim plays Bree on a phone held
 * upright, Pat plays Vex:
 * - Kim adds Wizard 3 and Cleric 1 in the Classes sheet, uses a level 2
 *   slot from her page, the DM's copy shows it, and Restore gives it back.
 * - In a fight on her turn, her turn card's folded slot row spends a level
 *   1 slot and Escape closes its levels, and the bar's Uses drawer gives it
 *   back with Restore a slot….
 * - A Short Rest rolls two d6 Hit Point Dice that heal by their results and
 *   spends the d8 for a typed roll. A reload keeps every count and the
 *   typed Constitution modifier, and a Long Rest gives all back.
 * - A sent ask for saves offers its casting level's slot, and its Use
 *   spends it.
 * - Pat's frames never hold Bree's classes, spent counts or use stamp, and
 *   his panel for her token draws none of the rows.
 * The turn card's folded row, the drawer and the slot offer are measured
 * with the alignment check on the phone. The rest of the screens are in
 * the alignment sweep (alignmentRoom.ts slotScreens).
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventy-two, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 72;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-slotsdice-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let kimContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let kim: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const kimSocket = new SocketWatch("kim");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const kimConsole = new ConsoleWatch("kim");
const patConsole = new ConsoleWatch("pat");

const BREE_AT = { x: 5, y: 5 };
const GOBLIN_AT = { x: 8, y: 5 };
const run = {
  roomId: "",
  roomName: `E2E slots and dice ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  kimId: "",
  patId: "",
  bree: uuidv7(),
  breeToken: uuidv7(),
  vex: uuidv7(),
  goblin: uuidv7(),
};

type View = { width: number; height: number };
const DESK: View = { width: 1440, height: 900 };
const PHONE: View = { width: 390, height: 844 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** Bree's block for the cast step: Hold Person, a save with no damage, which a slot of level 2 or more casts. */
const BREE_STATS = {
  abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
  saves: ["int", "wis"],
  skills: {},
  spellAbility: "int",
  adjust: {},
  defenses: {},
  rolls: [{ id: "hp", name: "Hold Person", kind: "spell", ability: "spell", level: 2, save: { ability: "wis" }, dice: [] }],
};

function bree(socket: SocketWatch = dmSocket): Character | undefined {
  return socket.state?.characters[run.bree];
}

async function closeSheets(page: Page): Promise<void> {
  const open = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true });
  for (let i = 0; i < 3; i++) {
    const n = await open.count();
    if (n === 0) return;
    await open.first().getByRole("button", { name: /^Close / }).first().click();
    await waitFor("a sheet put away", async () => ((await open.count()) < n ? true : null), 5_000);
  }
}

async function openCharacters(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.first().isVisible())) {
    await openSideTab(page, "Characters");
    return page.getByRole("tabpanel", { name: "Characters" });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (await sheet.isVisible()) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** Bree's page: Kim plays her alone, so the panel lands there. */
async function breesPage(page: Page): Promise<Locator> {
  const panel = await openCharacters(page);
  const heading = panel.locator("[data-creature-heading]").filter({ hasText: "Bree" });
  const opener = panel.locator(`[data-opener="character:${run.bree}"]`);
  await heading.or(opener).first().waitFor();
  if ((await heading.count()) === 0) await opener.click();
  await heading.waitFor();
  return panel;
}

function section(scope: Locator, title: string): Locator {
  return scope.locator(`xpath=.//section[*[self::h3 or self::h4][normalize-space()="${title}"]]`);
}

function alerts(page: Page, kind: string): Locator {
  return page.locator(`[data-alert="${kind}"]`);
}

/** A slot row by its name, its count read from its pips as countReads in classresources.e2e.ts does. */
async function pipsRead(row: Locator): Promise<string> {
  return row.evaluate((el) => {
    type E = { querySelector(s: string): E | null; querySelectorAll(s: string): ArrayLike<E> };
    const end = (el as unknown as E).querySelector("[data-use-pips]");
    if (!end) return "none";
    return `${end.querySelectorAll('[data-pip="left"]').length} of ${end.querySelectorAll("[data-pip]").length}`;
  });
}

async function rowReads(scope: Locator, name: string, count: string): Promise<void> {
  const row = scope.getByRole("listitem").filter({ has: scope.page().getByText(name, { exact: true }) }).first();
  let last = "";
  await waitFor(`${name} reading ${count}`, async () => ((last = await pipsRead(row)) === count ? true : null), 10_000).catch(() => assert.fail(`${name} reads ${last}, not ${count}`));
}

const sweep: string[] = [];
async function measure(page: Page, root: Locator, screen: string): Promise<void> {
  await root.first().waitFor();
  const lines = alignmentLines(await measureAlignment(root.first()), screen);
  if (lines.length > 0) {
    sweep.push(...lines);
    await shots.take(page, `sd-b-align-${screen.replace(/[^a-z0-9]+/gi, "-")}`);
  }
}

/** The newest Hit Point Die roll in the DM's log: its face and total. */
function lastDieRoll(): DiceRoll | undefined {
  const log: readonly LogEntry[] = dmSocket.state?.log ?? [];
  for (let i = log.length - 1; i >= 0; i--) {
    const data = log[i]!.data;
    if (data?.type === "dice") {
      const roll = data.rolls.find((r) => r.hitDie !== undefined);
      if (roll) return roll;
    }
  }
  return undefined;
}

describe("raccoon-vtt: spell slots and Hit Point Dice", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    kimContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    patContext = await browser.newContext({ viewport: PHONE });
    await diceFoldsOpen(kimContext);
    dm = await dmContext.newPage();
    kim = await kimContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    kimConsole.attach(kim);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await kimSocket.attach(kimContext, kim);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, kimConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("sd-b-1. a DM's room with Kim's Bree at level 4 and 20 HP, Pat's Vex, and a goblin", async () => {
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
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    const join = async (context: BrowserContext, name: string, color: string) => {
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      return ((await done.json()) as { member: { id: string } }).member.id;
    };
    run.kimId = await join(kimContext, "Kim", "#30a46c");
    run.patId = await join(patContext, "Pat", "#e5484d");

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.bree, name: "Bree", size: "medium", ownerIds: [run.kimId], actor: actor(20), level: 4 } });
    await ops.send({ t: "character.create", character: { id: run.vex, name: "Vex", size: "medium", ownerIds: [run.patId], actor: actor(30), level: 5 } });
    const token = (id: string, extra: Record<string, unknown>) => ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await token(run.breeToken, { kind: "pc", name: "Bree", ...BREE_AT, disposition: "ally", actor: { ref: run.bree } });
    await token(run.goblin, { kind: "monster", name: "Goblin", ...GOBLIN_AT, disposition: "hostile", actor: { inline: actor(7) } });

    for (const [page, watch, socket] of [
      [kim, kimConsole, kimSocket],
      [pat, patConsole, patSocket],
    ] as const) {
      watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor(`${watch.label}'s snapshot`, () => socket.state);
      watch.allow = [];
    }
  });

  test("sd-b-2. Kim adds Wizard 3 and Cleric 1 in the Classes sheet, which previews what they give", async () => {
    const page = await breesPage(kim);
    const uses = section(page, "Uses");
    await uses.getByText("Add your classes to count spell slots and Hit Point Dice.", { exact: true }).waitFor();
    await uses.getByRole("button", { name: "Add your classes" }).tap();
    const sheet = kim.getByRole("dialog", { name: "Classes", exact: true });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Add a class" }).tap();
    await sheet.getByRole("group", { name: "Barbarian" }).getByRole("combobox", { name: "Class" }).selectOption("wizard");
    const wizard = sheet.getByRole("group", { name: "Wizard" });
    for (let i = 0; i < 2; i++) await wizard.getByRole("button", { name: "Wizard level plus 1" }).tap();
    await sheet.getByRole("button", { name: "Add a class" }).tap();
    await sheet.getByRole("group", { name: "Barbarian" }).getByRole("combobox", { name: "Class" }).selectOption("cleric");
    await sheet.getByText("Spell slots: 4, 3. Hit Point Dice: 1 d8 and 3 d6.", { exact: true }).waitFor();
    await sheet.getByText("Level 4 in all.", { exact: true }).waitFor();
    await measure(kim, sheet, "the Classes sheet at 390 x 844");
    await shots.take(kim, "sd-b-classes-sheet");
    await sheet.getByRole("button", { name: "Save", exact: true }).tap();
    await sheet.waitFor({ state: "detached" });
    await uses.getByText("Classes: Wizard 3, Cleric 1", { exact: true }).waitFor();
    const saved = await waitFor("Bree's classes in the DM's copy", () => bree()?.classes);
    assert.deepEqual(saved, [{ id: "wizard", level: 3 }, { id: "cleric", level: 1 }]);
    assert.equal(bree()?.level, 4);
  });

  test("sd-b-3. Kim uses a level 2 slot from her page, the DM's copy shows it, and Restore gives it back", async () => {
    const page = await breesPage(kim);
    const uses = section(page, "Uses");
    await rowReads(uses, "Level 1 spell slots", "4 of 4");
    await rowReads(uses, "Level 2 spell slots", "3 of 3");
    await uses.getByRole("button", { name: "Use a level 2 spell slot, 3 of 3 left" }).tap();
    await rowReads(uses, "Level 2 spell slots", "2 of 3");
    await waitFor("a level 2 slot spent in the DM's copy", () => (bree()?.spent?.slots?.[1] === 1 ? true : null));
    await uses.locator("[data-slot-rows]").scrollIntoViewIfNeeded();
    await shots.take(kim, "sd-b-page-slots");
    await uses.getByRole("button", { name: "Restore a level 2 spell slot" }).tap();
    await rowReads(uses, "Level 2 spell slots", "3 of 3");
    await waitFor("nothing spent in the DM's copy", () => (bree() && bree()!.spent === undefined ? true : null));
    await closeSheets(kim);
  });

  test("sd-b-4. on her turn, the turn card's folded row spends a level 1 slot and Escape closes its levels, and the bar's drawer restores it", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: namedId("e-bree"), tokenId: run.breeToken, value: 15 },
        { id: namedId("e-gob"), tokenId: run.goblin, value: 5 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await waitFor("Bree's turn", () => (dmSocket.state?.encounter?.activeEntryId === namedId("e-bree") ? true : null));
    const turn = alerts(kim, "turn");
    await turn.getByText("Bree's turn: 1 use", { exact: true }).waitFor();
    await turn.getByRole("button", { name: "Show Bree's turn" }).tap();
    const open = alerts(kim, "turn");
    await open.getByText("Left by level: 4, 3", { exact: true }).waitFor();
    await measure(kim, open, "the turn card's folded slot row at 390 x 844");
    await open.getByRole("button", { name: "Use a slot…" }).tap();
    const levels = open.getByRole("group", { name: "Use a slot" });
    await levels.getByRole("button", { name: "Use a level 2 spell slot, 3 left" }).waitFor();
    await measure(kim, open, "the turn card's slot levels open at 390 x 844");
    await shots.take(kim, "sd-b-turn-card-slots");
    await levels.getByRole("button", { name: "Use a level 1 spell slot, 4 left" }).tap();
    await waitFor("a level 1 slot spent", () => (bree()?.spent?.slots?.[0] === 1 ? true : null));
    await open.getByText("Left by level: 3, 3", { exact: true }).waitFor();
    await levels.getByRole("button", { name: "Use a level 1 spell slot, 3 left" }).focus();
    await kim.keyboard.press("Escape");
    await levels.waitFor({ state: "detached" });
    await open.getByRole("button", { name: "Dismiss Bree's turn" }).tap();

    await closeSheets(kim);
    await tapCell(kim, run.bounds, BREE_AT);
    const bar = kim.getByRole("dialog", { name: "Bree actions" });
    await bar.waitFor();
    const usesButton = await barControl(bar, "Uses");
    await waitFor("the Uses button ready", async () => ((await usesButton.isEnabled()) ? true : null));
    if ((await usesButton.getAttribute("aria-pressed")) !== "true") await usesButton.tap();
    const drawer = bar.locator("[data-uses-drawer]");
    await drawer.waitFor();
    await drawer.getByRole("button", { name: "Restore a slot…" }).tap();
    await measure(kim, drawer, "the bar's Uses drawer with Restore a slot… open at 390 x 844");
    await shots.take(kim, "sd-b-drawer-restore");
    await drawer.getByRole("button", { name: "Restore a level 1 spell slot, 1 spent" }).tap();
    await waitFor("the slot back", () => (bree() && bree()!.spent === undefined ? true : null));
    await bar.getByRole("button", { name: "Close", exact: true }).first().click();
    await ops.send({ t: "encounter.end" });
    await waitFor("the fight over", () => (dmSocket.state && !dmSocket.state.encounter ? true : null));
  });

  test("sd-b-5. a Short Rest rolls two d6 dice that heal by their results and spends the d8 for a typed 4", async () => {
    await ops.send({ t: "actor.hp", target: { characterId: run.bree }, change: { kind: "damage", amount: 15 } });
    await waitFor("Bree at 5 HP", () => (bree()?.actor.hp.cur === 5 ? true : null));
    const page = await breesPage(kim);
    const rest = section(page, "Rest");
    await rest.getByText("Hit Point Dice: 1 of 1 d8, 3 of 3 d6", { exact: true }).waitFor();
    await rest.getByRole("radio", { name: "Short Rest" }).check();
    await rest.getByText("Spend Hit Point Dice one at a time. Each one heals at once.", { exact: true }).waitFor();
    // Bree has no stat block, so the modifier is typed, and this device keeps it.
    await rest.getByRole("textbox", { name: "Constitution modifier" }).fill("1");
    let hp = 5;
    for (const left of [3, 2]) {
      await rest.getByRole("button", { name: `Roll a d6 Hit Point Die plus 1, ${left} of 3 left` }).tap();
      await waitFor("the die spent", () => (bree()?.spent?.dice?.d6 === 4 - left ? true : null));
      const roll = await waitFor("the roll's line", () => lastDieRoll());
      const face = roll.faces[0]!;
      assert.equal(roll.total, face + 1, "the die plus the typed modifier");
      hp = Math.min(20, hp + Math.max(1, roll.total));
      await waitFor(`Bree at ${hp} HP`, () => (bree()?.actor.hp.cur === hp ? true : null));
      await rest.locator('[data-hit-die="6"]').getByText(`Rolled ${face} + 1: ${face + 1} HP back.`).first().waitFor();
    }
    await shots.take(kim, "sd-b-short-rest");
    const d8 = rest.locator('[data-hit-die="8"]');
    await d8.getByRole("button", { name: "Type a roll for a d8 Hit Point Die" }).tap();
    const field = d8.getByRole("textbox", { name: "HP from one d8, your roll plus Constitution" });
    assert.equal(await field.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { fontSize: string } }).getComputedStyle(el).fontSize), "16px");
    await field.fill("4");
    await d8.getByRole("button", { name: "Spend", exact: true }).tap();
    const typed = Math.min(20, hp + 4);
    await waitFor(`Bree at ${typed} HP`, () => (bree()?.actor.hp.cur === typed && bree()?.spent?.dice?.d8 === 1 ? true : null));
    await rest.getByRole("button", { name: "Finish the Short Rest" }).tap();
    assert.deepEqual(bree()?.spent?.dice, { d8: 1, d6: 2 }, "the rest gives no die back");
  });

  test("sd-b-6. a reload keeps every count and the typed modifier, and a Long Rest gives all back", async () => {
    await kim.reload();
    await kim.getByRole("status", { name: "Connected" }).first().waitFor();
    const page = await breesPage(kim);
    const rest = section(page, "Rest");
    await rest.getByText("Hit Point Dice: 0 of 1 d8, 1 of 3 d6", { exact: true }).waitFor();
    await ops.send({ t: "actor.hp", target: { characterId: run.bree }, change: { kind: "damage", amount: 3 } });
    await rest.getByRole("radio", { name: "Short Rest" }).check();
    assert.equal(await rest.getByRole("textbox", { name: "Constitution modifier" }).inputValue(), "1", "this device kept the modifier");
    await rest.getByRole("button", { name: "Cancel", exact: true }).tap();
    await rest.getByRole("radio", { name: "Long Rest" }).check();
    await rest.getByText("All HP back, every spent Hit Point Die back, every spell slot back, Temporary HP gone, one less Exhaustion level, and Legendary Resistance reset.", { exact: true }).waitFor();
    await rest.getByText("A Long Rest also restores 3 Hit Point Dice.", { exact: true }).waitFor();
    await rest.getByRole("button", { name: "Finish the Long Rest" }).tap();
    await waitFor("nothing spent", () => (bree() && bree()!.spent === undefined && bree()!.actor.hp.cur === 20 ? true : null));
    await rest.getByText("Hit Point Dice: 1 of 1 d8, 3 of 3 d6", { exact: true }).waitFor();
    await closeSheets(kim);
  });

  test("sd-b-7. a sent ask for saves offers its casting level's slot, and its Use spends it", async () => {
    await ops.send({ t: "character.update", characterId: run.bree, patch: { stats: BREE_STATS } });
    await waitFor("Bree's block on Kim's copy", () => (bree(kimSocket)?.stats?.rolls.length === 1 ? true : null));
    await pickTool(kim, "Select");
    await tapCell(kim, run.bounds, BREE_AT);
    await multiSelect(kim.getByRole("dialog", { name: "Bree actions" }));
    await tapCell(kim, run.bounds, GOBLIN_AT);
    await kim.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    const dice = kim.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
    if (!(await dice.isVisible())) {
      await kim.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
      await kim.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Dice/ }).tap();
      await dice.waitFor();
    }
    await dice.getByRole("button", { name: "Ask the DM for saves against Hold Person" }).tap();
    const block = dice.getByRole("group", { name: "Ask for saves: Hold Person" });
    await block.getByRole("button", { name: "Ask the DM", exact: true }).tap();
    await waitFor("Hold Person's ask", () => Object.values(dmSocket.state?.casts ?? {})[0] ?? null);
    const offer = dice.getByRole("group", { name: "Hold Person: Cast at level 2." });
    await offer.waitFor();
    await measure(kim, offer, "the slot offer at 390 x 844");
    await shots.take(kim, "sd-b-slot-offer");
    await offer.getByRole("button", { name: "Use a level 2 spell slot" }).tap();
    await waitFor("a level 2 slot spent by the offer", () => (bree()?.spent?.slots?.[1] === 1 ? true : null));
    await offer.waitFor({ state: "detached" });
    await dice.getByRole("button", { name: "Withdraw the ask for saves against Hold Person" }).first().tap().catch(() => {});
    await closeSheets(kim);
  });

  test("sd-b-8. Pat's frames never held Bree's classes, spent counts or use stamp, and his panel for her token draws none of the rows", async () => {
    for (const words of ['"classes"', '"spent"', '"useRev"']) assert.equal(patSocket.everSaw(words), false, `Pat's copy holds ${words}`);
    assert.ok(patSocket.state?.characters[run.bree], "Pat's copy holds Bree");
    await closeSheets(pat);
    await tapCell(pat, run.bounds, BREE_AT);
    const bar = pat.getByRole("dialog", { name: "Bree actions" });
    await bar.waitFor();
    await (await barControl(bar, "Details")).click();
    const panel = pat.getByRole("tabpanel", { name: "Token", exact: true }).or(pat.getByRole("region", { name: "Token", exact: true }));
    await panel.getByRole("heading", { name: "Bree" }).first().waitFor();
    assert.equal(await panel.locator("[data-slot-rows], [data-hit-dice]").count(), 0, "Pat's panel draws Bree's rows");
    assert.equal(await panel.getByText(/Hit Point Dice:/).count(), 0, "Pat's panel names Bree's dice");
  });

  test("sd-b-9. the measured screens line up within 1 px, and no console errors on any page", () => {
    assert.deepEqual(sweep, [], "alignment");
    assert.deepEqual(dmConsole.errors, [], "the DM's page");
    assert.deepEqual(kimConsole.errors, [], "Kim's page");
    assert.deepEqual(patConsole.errors, [], "Pat's page");
  });
});

