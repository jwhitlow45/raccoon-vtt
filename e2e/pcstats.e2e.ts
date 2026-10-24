import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, reopenRoom, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Stat blocks for player characters end to end (docs/design-v1-pc-stats.md
 * section 12): a player types scores and proficiencies and saves, the
 * token panel and the DM's device show the totals, another player's device
 * has none, a level change moves them, Take a shape changes the bar's
 * saves line and End the shape restores it, a Druid's known forms are
 * chosen and taken in one tap (docs/design-v1-known-forms.md 7), and a D&D
 * Beyond character's JSON pasted from a fixture fills the review.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus twenty-one.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 21;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-pcstats-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
/** Ana, who plays Bree. */
let anaContext: BrowserContext;
let ana: Page;
/** Cy, another player. */
let cyContext: BrowserContext;
let cy: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const cySocket = new SocketWatch("cy");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), cy: new ConsoleWatch("cy") };

const BOUNDS = { w: 20, h: 14 };
const run = {
  roomId: "",
  roomName: `E2E pc stats ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  anaId: "",
  bree: { characterId: randomUUID(), tokenId: randomUUID() },
};

/** An invented D&D Beyond character in the shape of the service's JSON, with only the fields the reader reads. */
const DDB_JSON = {
  success: true,
  data: {
    id: 87654321,
    name: "Wren Ashdown",
    stats: [12, 16, 14, 10, 13, 8].map((value, i) => ({ id: i + 1, value })),
    bonusStats: [],
    overrideStats: [],
    baseHitPoints: 40,
    race: { weightSpeeds: { normal: { walk: 30 } } },
    classes: [{ level: 7, definition: { name: "Rogue" }, classFeatures: [{ definition: { name: "Sneak Attack", requiredLevel: 1 } }, { definition: { name: "Evasion", requiredLevel: 7 } }] }],
    modifiers: { class: [{ type: "proficiency", subType: "dexterity-saving-throws", fixedValue: null, value: null }] },
    inventory: [{ equipped: true, definition: { id: 1, name: "Rapier", filterType: "Weapon", damage: { diceString: "1d8" }, damageType: "Piercing", attackType: 1, properties: [{ name: "Finesse" }] } }],
  },
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 24, max: 24, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

function bar(page: Page): Locator {
  return page.getByRole("dialog", { name: "Bree actions" });
}

function tokenPanel(page: Page): Locator {
  return page.getByRole("tabpanel", { name: "Token" });
}

function editor(page: Page): Locator {
  return page.getByRole("dialog", { name: "Bree's stat block" });
}

/** Bree selected and the Token tab open, with the stat block section in view. */
async function showBree(page: Page): Promise<Locator> {
  await tapCell(page, BOUNDS, { x: 5, y: 5 });
  await bar(page).waitFor();
  await openSideTab(page, "Token");
  return tokenPanel(page);
}

/** The text of the bar's saves line. */
async function savesLine(page: Page): Promise<string> {
  const line = bar(page).locator("[data-saves]");
  await line.waitFor();
  return ((await line.textContent()) ?? "").replace(/\s+/g, " ");
}

/** The known forms step row that has the keyboard's focus, by its key, or the tag of whatever else has it. */
function focusedForm(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: { tagName: string; parentElement: { dataset: Record<string, string | undefined> } | null } | null } }).document.activeElement;
    return a?.parentElement?.dataset.form ?? a?.tagName ?? null;
  });
}

/**
 * A second device of Ana's whose room socket goes through a route. While
 * `route.spoil` is on, a known forms toggle goes out with an id no SRD
 * monster has, so the server refuses it. While `route.hold` is on, the
 * frame carrying the refusal waits until `release`.
 */
async function routedAna() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(await anaContext.cookies(server.origin));
  const page = await context.newPage();
  const watch = new ConsoleWatch("ana-2");
  watch.attach(page);
  const route = { spoil: false, hold: false };
  const held: (string | Buffer)[] = [];
  let toPage: ((m: string | Buffer) => void) | null = null;
  await page.routeWebSocket(/\/ws\?room=/, (ws) => {
    const upstream = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = route.spoil && typeof m === "string" ? (JSON.parse(m) as { t?: string; op?: { t?: string; patch?: { knownForms?: string[] } } }) : null;
      if (frame?.t === "op" && frame.op?.t === "character.update" && frame.op.patch?.knownForms) {
        frame.op.patch.knownForms = [...frame.op.patch.knownForms, "Not An Id"];
        upstream.send(JSON.stringify(frame));
      } else upstream.send(m);
    });
    upstream.onMessage((m) => (route.hold && String(m).includes('"rejects"') ? held.push(m) : ws.send(m)));
    toPage = (m) => ws.send(m);
  });
  const release = () => {
    route.hold = false;
    for (const m of held.splice(0)) toPage?.(m);
  };
  return { context, page, watch, route, held: () => held.length, release };
}

/** Bree's known forms step on a page, through Take a shape's Change. */
async function openKnownFormsStep(page: Page): Promise<Locator> {
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  const panel = await showBree(page);
  await panel.getByRole("button", { name: "Take a shape" }).click();
  await page.getByRole("dialog", { name: "Take a shape" }).getByRole("button", { name: "Change", exact: true }).click();
  const step = page.getByRole("dialog", { name: "Bree's known forms" });
  await step.waitFor();
  return step;
}

describe("raccoon-vtt pc stat blocks", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    anaContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    ana = await anaContext.newPage();
    cyContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    cy = await cyContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    consoles.cy.attach(cy);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
    await cySocket.attach(cyContext, cy);
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

  test("0. a DM's room, Ana playing Bree with her token on the players' scene, and Cy", async () => {
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
    run.anaId = await join(anaContext, "Ana", "#30a46c");
    await join(cyContext, "Cy", "#3e63dd");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [run.anaId], actor: actor() } });
    await ops.send({ t: "token.create", token: { id: run.bree.tokenId, sceneId: run.sceneId, kind: "pc", name: "Bree", size: "medium", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree.characterId } } });
    await ana.goto(`${server.origin}/r/${run.roomId}`);
    await cy.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Ana's snapshot", () => anaSocket.state);
    await waitFor("Cy's snapshot", () => cySocket.state);
    await ana.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("1a. a character with no block has a fold like Combat's: None yet folded, the help and both buttons opened, and the label lines up at 390 x 844", async () => {
    const panel = await showBree(ana);
    const fold = panel.getByRole("button", { name: "Stat block", exact: true });
    // Open from 900 x 600 up, as the groups design says.
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    await panel.getByText("Add this character's stat block, or take a shape such as Wild Shape.").waitFor();
    await fold.click();
    await panel.getByText("None yet").first().waitFor();
    assert.equal(await panel.getByRole("button", { name: "Add a stat block" }).count(), 0, "folded, no buttons");
    assert.equal(await fold.getAttribute("aria-describedby") !== null, true, "the summary describes the fold");
    await fold.click();
    await panel.getByRole("button", { name: "Add a stat block" }).waitFor();
    await panel.getByRole("button", { name: "Take a shape" }).waitFor();
    await shots.take(ana, "pcstats-empty-fold");
    await panel.getByRole("button", { name: "Take a shape" }).click();
    const picker = ana.getByRole("dialog", { name: "Take a shape" });
    await picker.waitFor();
    await ana.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
    await panel.getByRole("button", { name: "Add a stat block" }).click();
    const sheet = editor(ana);
    await sheet.waitFor();
    await ana.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    await ana.setViewportSize({ width: 390, height: 844 });
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
    await tapCell(ana, BOUNDS, { x: 5, y: 5 });
    // The bar has no Stat block button until there is a block, so the sheet comes from Panels. A phone starts the fold folded.
    await ana.getByRole("button", { name: "Panels" }).click();
    await ana.getByRole("button", { name: "Token", exact: true }).click();
    const sheetPanel = ana.getByRole("region", { name: "Token", exact: true });
    const phoneFold = sheetPanel.getByRole("button", { name: "Stat block", exact: true });
    await phoneFold.waitFor();
    if ((await phoneFold.getAttribute("aria-expanded")) !== "true") await phoneFold.click();
    await sheetPanel.getByRole("button", { name: "Add a stat block" }).waitFor();
    const labelX = async (name: string) => (await sheetPanel.locator("[data-panel-group] h3 span[id]", { hasText: new RegExp(`^${name}$`) }).boundingBox())!.x;
    assert.ok(Math.abs((await labelX("Stat block")) - (await labelX("Combat"))) <= 1, "the label lines up with Combat's");
    await shots.take(ana, "pcstats-empty-fold-390");
    await ana.setViewportSize({ width: 1280, height: 800 });
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
  });

  test("1. Ana adds Bree's stat block: level 5, Dex 16 with its save, Stealth with expertise, and Save waits for the server", async () => {
    const panel = await showBree(ana);
    await panel.getByRole("button", { name: "Add a stat block" }).click();
    const sheet = editor(ana);
    await sheet.waitFor();
    await sheet.getByLabel("Level", { exact: true }).fill("5");
    await sheet.getByLabel("Dexterity score").fill("16");
    await sheet.getByRole("checkbox", { name: "Proficient in Dexterity saves" }).check();
    await sheet.getByLabel("Stealth proficiency").selectOption("expert");
    const save = sheet.getByRole("textbox", { name: "Dexterity save" });
    await waitFor("the Dex save's total", async () => ((await save.inputValue()) === "+6" ? true : null));
    await shots.take(ana, "pcstats-editor");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    const bree = await waitFor("Bree's block in Ana's view", () => anaSocket.state?.characters[run.bree.characterId]?.stats ?? null);
    assert.deepEqual(bree.saves, ["dex"]);
    assert.deepEqual(bree.skills, { stealth: "expert" });
    assert.equal(anaSocket.state!.characters[run.bree.characterId]!.level, 5);
    assert.equal(anaSocket.state!.characters[run.bree.characterId]!.actor.initBonus, 3, "initiative follows the block");
    const view = panel.locator("[data-pc-stats]");
    await view.getByText("Stealth +9 (expertise)").waitFor();
    await view.getByText("Initiative").waitFor();
    // The Dex box of the six across: its score, its modifier, and its save named as proficient (docs/design-v1-dice-ui.md 6.1).
    assert.match((await view.textContent()) ?? "", /DEX16 \+3Save \+6, proficient/);
    assert.match(await savesLine(ana), /DEX \+6/);
    await shots.take(ana, "pcstats-panel");
  });

  test("1b. at 375 x 667 at 130% each save's word and its total share a line in the editor (LP7-PC-12)", async () => {
    await ana.setViewportSize({ width: 375, height: 667 });
    await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
    await tapCell(ana, BOUNDS, { x: 5, y: 5 });
    // Stat block opens the Token sheet with the block open, which a phone starts folded.
    await bar(ana).getByRole("button", { name: "Stat block", exact: true }).click();
    const sheetPanel = ana.getByRole("region", { name: "Token", exact: true });
    await sheetPanel.locator("[data-pc-stats]").waitFor();
    await sheetPanel.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = editor(ana);
    await sheet.waitFor();
    for (const ability of ["Strength", "Dexterity", "Wisdom", "Charisma"]) {
      const total = sheet.getByRole("textbox", { name: `${ability} save`, exact: true });
      await total.scrollIntoViewIfNeeded();
      const box = (await total.boundingBox())!;
      const word = (await total.locator("xpath=preceding-sibling::span[1]").boundingBox())!;
      const middle = word.y + word.height / 2;
      assert.ok(middle > box.y && middle < box.y + box.height, `${ability}: "Save" and its total on two lines: ${JSON.stringify({ word, box })}`);
    }
    await sheet.getByRole("textbox", { name: "Dexterity save", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(ana, "pcstats-editor-375-130");
    await ana.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await ana.setViewportSize({ width: 1280, height: 800 });
    await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
  });

  test("2. the DM's device shows the totals, and Cy's has none of the block", async () => {
    const panel = await showBree(dm);
    await panel.locator("[data-pc-stats]").getByText("Stealth +9 (expertise)").waitFor();
    assert.match(await savesLine(dm), /DEX \+6/);
    await shots.take(dm, "pcstats-dm-panel");
    await waitFor("Cy's view of Bree", () => cySocket.state?.characters[run.bree.characterId] ?? null);
    assert.equal("stats" in cySocket.state!.characters[run.bree.characterId]!, false, "Cy's device never receives the block");
    assert.equal(cySocket.everSaw("expert"), false);
    await tapCell(cy, BOUNDS, { x: 5, y: 5 });
    await bar(cy).waitFor();
    assert.equal(await bar(cy).locator("[data-saves]").count(), 0, "no saves line for Cy");
    assert.equal(await bar(cy).getByRole("button", { name: "Stat block" }).count(), 0);
  });

  test("2b. lp1-page-a: at 390 x 844 Ana lands on Bree's page, whose folded Stat block row says Level 5, PB +3 and lines up with Combat's, as in the token panel", async () => {
    await ana.setViewportSize({ width: 390, height: 844 });
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
    const labelX = async (scope: Locator, name: string) => (await scope.locator("[data-panel-group] h3 span[id]", { hasText: new RegExp(`^${name}$`) }).boundingBox())!.x;
    // The token panel's labels first, for the page to match.
    await tapCell(ana, BOUNDS, { x: 5, y: 5 });
    await ana.getByRole("button", { name: "Panels" }).click();
    await ana.getByRole("button", { name: "Token", exact: true }).click();
    const token = ana.getByRole("region", { name: "Token", exact: true });
    await token.getByRole("button", { name: "Stat block", exact: true }).waitFor();
    const tokenX = await labelX(token, "Stat block");
    await ana.getByRole("button", { name: "All panels" }).click();
    await ana.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
    const sheet = ana.getByRole("region", { name: "Characters", exact: true });
    // Ana plays Bree alone, so the panel lands on Bree's page, its stat block right under the header.
    await ana.getByRole("button", { name: "Back to Characters" }).waitFor();
    const fold = sheet.getByRole("button", { name: "Stat block", exact: true });
    const wasOpen = (await fold.getAttribute("aria-expanded")) === "true";
    if (wasOpen) await fold.click();
    await sheet.getByText("Level 5, PB +3", { exact: true }).waitFor();
    const blockX = await labelX(sheet, "Stat block");
    assert.ok(Math.abs(blockX - (await labelX(sheet, "Combat"))) <= 1, "the page's Stat block lines up with its Combat");
    assert.ok(Math.abs(blockX - tokenX) <= 1, `the page's Stat block lines up with the token panel's: ${blockX} and ${tokenX}`);
    await shots.take(ana, "pcstats-lp1-page-390");
    // The fold is this device's, which the steps after read open on a computer.
    if (wasOpen) await fold.click();
    await ana.setViewportSize({ width: 1280, height: 800 });
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
  });

  test("3. a level change moves every proficient number", async () => {
    const panel = await showBree(ana);
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = editor(ana);
    await sheet.getByLabel("Level", { exact: true }).fill("9");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await panel.locator("[data-pc-stats]").getByText("Stealth +11 (expertise)").waitFor();
    assert.match(await savesLine(ana), /DEX \+7/);
    assert.match(await savesLine(dm), /DEX \+7/);
  });

  test("4. Take a shape as Wild Shape changes the bar's saves line, AC and speeds and gives the temporary HP, and End the shape restores the rest", async () => {
    const panel = await showBree(ana);
    await panel.getByRole("button", { name: "Take a shape" }).click();
    const picker = ana.getByRole("dialog", { name: "Take a shape" });
    // shapelevel-a: a Druid level keeps the forms that level may take, and Any brings the whole list back.
    await picker.getByLabel("Druid level").selectOption("4");
    await picker.getByText("Up to CR 1/2, no Fly Speed.").waitFor();
    assert.equal(await picker.getByRole("checkbox", { name: "Beasts only" }).isChecked(), true, "a level turns Beasts only on");
    await picker.getByRole("button", { name: /Black Bear/ }).first().waitFor();
    assert.equal(await picker.getByRole("button", { name: /Brown Bear/ }).count(), 0, "a CR 1 beast is gone at level 4");
    await shots.take(ana, "pcstats-shape-level");
    await picker.getByLabel("Druid level").selectOption("Any");
    await picker.getByRole("button", { name: /Brown Bear/ }).first().waitFor();
    assert.equal(await picker.getByText(/^Up to CR/).count(), 0, "Any states no limit");
    await picker.getByRole("searchbox", { name: "Search creatures" }).fill("brown bear");
    await picker.getByRole("button", { name: /Brown Bear/ }).first().click();
    const choice = ana.getByRole("dialog", { name: "Take the shape of Brown Bear" });
    assert.equal(await choice.getByRole("radio", { name: /Wild Shape/ }).isChecked(), true, "Wild Shape by default");
    // Bree is level 9 since step 3, and the Druid level Wild Shape gives reads as it (W7B-P-9).
    assert.equal(await choice.getByRole("checkbox", { name: "Gain 9 Temporary HP (Wild Shape)" }).isChecked(), true, "the temporary HP on by default");
    await shots.take(ana, "pcstats-shape-choice");
    await choice.getByRole("button", { name: "Take the shape", exact: true }).click();
    const breeActor = () => anaSocket.state?.characters[run.bree.characterId]?.actor;
    await waitFor("Bree's shape", () => (breeActor()?.wildShape ? true : null));
    await panel.getByText("In Wild Shape as Brown Bear.", { exact: false }).waitFor();
    // The bear's AC 11 and speeds take the place of Bree's AC 15 and 30 ft, and its 9 temporary HP come with it.
    assert.deepEqual([breeActor()?.ac, breeActor()?.speeds, breeActor()?.hp.temp], [11, { walk: 40, climb: 30 }, 9]);
    await bar(ana).getByRole("img", { name: "Armor Class 11" }).waitFor();
    await bar(dm).getByRole("img", { name: "Armor Class 11" }).waitFor();
    // Strength from the bear (+3, its own save), Dexterity the bear's +1 with Bree's proficiency +4.
    await waitFor("the shaped saves line", async () => ((await savesLine(ana)).includes("STR +3") && (await savesLine(ana)).includes("DEX +5") ? true : null));
    await shots.take(ana, "pcstats-wild-shape");
    await panel.getByRole("button", { name: "End the shape" }).click();
    await waitFor("the shape ended", () => (breeActor()?.srdId === undefined ? true : null));
    await waitFor("the saves line back", async () => ((await savesLine(ana)).includes("DEX +7") ? true : null));
    assert.match(await savesLine(ana), /STR \+0/);
    await bar(ana).getByRole("img", { name: "Armor Class 15" }).waitFor();
    assert.deepEqual([breeActor()?.ac, breeActor()?.speeds, breeActor()?.hp.temp], [15, { walk: 30 }, 9], "Wild Shape's temporary HP stay");
  });

  test("4b. knownforms-a: at 390 x 844 Ana chooses Bree's known forms, one tap takes Wild Shape as one, the panel changes the form, and only the DM and Ana see them (docs/design-v1-known-forms.md 7)", async () => {
    await ana.setViewportSize({ width: 390, height: 844 });
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
    await tapCell(ana, BOUNDS, { x: 5, y: 5 });
    await bar(ana).getByRole("button", { name: "Stat block", exact: true }).click();
    const sheetPanel = ana.getByRole("region", { name: "Token", exact: true });
    await sheetPanel.locator("[data-pc-stats]").waitFor();
    await sheetPanel.getByRole("button", { name: "Take a shape" }).click();
    const picker = ana.getByRole("dialog", { name: "Take a shape" });
    await picker.getByText("Bree knows no forms yet. A Druid knows 4 Beast forms at level 2, 6 at level 4 and 8 at level 8.").waitFor();
    await picker.getByRole("button", { name: "Choose known forms" }).click();

    // knownforms-a: the step toggles each form with one op, with the count read against the level picked.
    const step = ana.getByRole("dialog", { name: "Bree's known forms" });
    await step.getByLabel("Druid level").selectOption("4");
    const row = (name: RegExp) => step.getByRole("button", { name }).first();
    const breeForms = () => anaSocket.state?.characters[run.bree.characterId]?.knownForms;
    await row(/^Black Bear /).click();
    await waitFor("Black Bear known", () => (breeForms()?.includes("black-bear") ? true : null));
    await row(/^Wolf /).click();
    await step.getByText("2 of 6 known forms at Druid level 4.").waitFor();
    assert.equal(await row(/^Wolf /).getAttribute("aria-pressed"), "true");
    await step.getByLabel("Druid level").selectOption("Any");
    await step.getByRole("searchbox", { name: "Search creatures" }).fill("owl");
    await row(/^Owl /).click();
    await step.getByText("3 known forms.").waitFor();
    await step.getByRole("searchbox", { name: "Search creatures" }).fill("");
    // Back at level 4 the Owl stays listed, pressed and marked, so it can still be taken out.
    await step.getByLabel("Druid level").selectOption("4");
    await step.getByText("3 of 6 known forms at Druid level 4.").waitFor();
    assert.equal(await row(/^Owl .*Fly Speed/).getAttribute("aria-pressed"), "true");
    // In the order chosen, as the server holds them.
    await waitFor("the Owl known", () => (JSON.stringify(breeForms()) === JSON.stringify(["black-bear", "wolf", "owl"]) ? true : null));
    await shots.take(ana, "pcstats-known-forms-choose");
    await step.getByRole("button", { name: "Back to the creatures" }).click();

    // knownforms-a: the group lists them highest CR first, the Owl marked at level 4, and one tap takes the form.
    await picker.getByText("3 of 6 at Druid level 4").waitFor();
    const forms = picker.getByRole("button", { name: /^Wild Shape as / });
    assert.deepEqual(await forms.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))), ["Wild Shape as Black Bear", "Wild Shape as Wolf", "Wild Shape as Owl, has a Fly Speed"]);
    await shots.take(ana, "pcstats-known-forms");
    await picker.getByRole("button", { name: "Wild Shape as Wolf", exact: true }).click();
    await picker.waitFor({ state: "detached" });
    const breeActor = () => anaSocket.state?.characters[run.bree.characterId]?.actor;
    await waitFor("Bree as a wolf", () => (breeActor()?.srdId === "wolf" && breeActor()?.wildShape ? true : null));
    await sheetPanel.getByText("In Wild Shape as Wolf.", { exact: false }).waitFor();
    // The remembered Druid level 4 gives 4 Temporary HP, fewer than the 9 Bree holds, which stay.
    assert.deepEqual([breeActor()?.ac, breeActor()?.hp.temp], [12, 9]);

    // knownforms-a (D-261024-29): the panel draws no Known forms section, and in Wild Shape the Take a shape button stays, as the way to change the form.
    assert.equal(await sheetPanel.getByRole("heading", { name: "Known forms" }).count(), 0, "the Stat block group draws no Known forms section");
    await sheetPanel.getByRole("button", { name: "Take a shape, 3 known forms", exact: true }).click();
    const again = ana.getByRole("dialog", { name: "Take a shape" });
    await again.getByRole("button", { name: "Wild Shape as Black Bear", exact: true }).click();
    await again.waitFor({ state: "detached" });
    await waitFor("Bree as a black bear", () => (breeActor()?.srdId === "black-bear" && breeActor()?.wildShape ? true : null));
    await sheetPanel.getByText("In Wild Shape as Black Bear.", { exact: false }).waitFor();
    assert.equal(breeActor()?.ac, 11);
    await sheetPanel.getByRole("button", { name: "End the shape" }).click();
    await waitFor("the shape ended", () => (breeActor()?.srdId === undefined ? true : null));
    assert.deepEqual([breeActor()?.ac, breeActor()?.speeds, breeActor()?.hp.temp], [15, { walk: 30 }, 9], "Bree's own AC and speeds come back from the first form");

    // knownforms-a: the DM's panel shows the same row, and Cy's device never receives the list.
    const dmPanel = await showBree(dm);
    await dmPanel.getByRole("button", { name: "Take a shape, 3 known forms", exact: true }).waitFor();
    await waitFor("Cy's view of Bree", () => cySocket.state?.characters[run.bree.characterId] ?? null);
    assert.equal("knownForms" in cySocket.state!.characters[run.bree.characterId]!, false, "Cy's device never receives the known forms");

    await ana.setViewportSize({ width: 1280, height: 800 });
    await reopenRoom(ana);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await ana.locator(".konvajs-content").first().waitFor();
  });

  test("4c. knownforms-b: Enter on a form keeps the focus on its row as it moves, a form the filters drop hands it to the next row, and Any is remembered", async () => {
    const panel = await showBree(ana);
    await panel.getByRole("button", { name: "Take a shape" }).click();
    const picker = ana.getByRole("dialog", { name: "Take a shape" });
    // Druid level 4 was the last picked on this device, in 4b.
    assert.equal(await picker.getByLabel("Druid level").inputValue(), "4");
    await picker.getByRole("button", { name: "Change", exact: true }).click();
    const step = ana.getByRole("dialog", { name: "Bree's known forms" });
    const row = (name: RegExp) => step.getByRole("button", { name }).first();
    const rowKeys = () => step.locator("li[data-form] > button").evaluateAll((els) => els.map((el) => el.parentElement?.dataset.form ?? ""));
    const focused = () => focusedForm(ana);
    const pressedIs = (name: RegExp, value: string) => waitFor(`${name} pressed ${value}`, async () => ((await row(name).getAttribute("aria-pressed")) === value ? true : null));

    // knownforms-b: the Wolf leaves the known forms for the rest of the list and comes back, keeping the focus both ways.
    await row(/^Wolf /).focus();
    await ana.keyboard.press("Enter");
    await pressedIs(/^Wolf /, "false");
    assert.equal(await focused(), "wolf", "the focus stays on the Wolf taken out");
    await ana.keyboard.press("Enter");
    await pressedIs(/^Wolf /, "true");
    assert.equal(await focused(), "wolf", "the focus stays on the Wolf put back");

    // knownforms-b: the Owl, marked at level 4, leaves the list once taken out, and the row now in its place takes the focus.
    const at = (await rowKeys()).indexOf("owl");
    assert.ok(at >= 0, "the Owl is listed as a known form");
    await row(/^Owl /).focus();
    await ana.keyboard.press("Enter");
    await waitFor("the Owl out of the list", async () => ((await row(/^Owl /).count()) === 0 ? true : null));
    assert.equal(await focused(), (await rowKeys())[at], "the next row has the focus");
    await waitFor("the Owl forgotten", () => (anaSocket.state?.characters[run.bree.characterId]?.knownForms?.includes("owl") === false ? true : null));

    // knownforms-b: Any is remembered too, so Take a shape opens on Any again for Polymorph.
    await step.getByLabel("Druid level").selectOption("Any");
    await ana.keyboard.press("Escape");
    await step.waitFor({ state: "detached" });
    await panel.getByRole("button", { name: "Take a shape" }).click();
    assert.equal(await picker.getByLabel("Druid level").inputValue(), "", "Any, as picked");
    await ana.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
  });

  test("4d. knownforms-b: a toggle refused after Back shows its refusal on Take a shape's first page, and Change clears it", async () => {
    const ana2 = await routedAna();
    const { page } = ana2;
    try {
      const step = await openKnownFormsStep(page);
      const picker = page.getByRole("dialog", { name: "Take a shape" });
      ana2.route.spoil = true;
      ana2.route.hold = true;
      await step.getByRole("button", { name: /^Wolf / }).first().click();
      await waitFor("the refusal held back", () => (ana2.held() > 0 ? true : null));
      await step.getByRole("button", { name: "Back to the creatures" }).click();
      await picker.getByRole("button", { name: "Change", exact: true }).waitFor();
      ana2.release();
      // The server's words, as a toast would say them.
      await picker.getByRole("alert").getByText(/^Not saved\. /).waitFor();
      await picker.getByRole("button", { name: "Wild Shape as Wolf", exact: true }).waitFor();
      await shots.take(page, "pcstats-known-forms-refused");
      await picker.getByRole("button", { name: "Change", exact: true }).click();
      // This device remembers no level, so the step starts at Bree's level 9.
      await step.getByText("2 of 8 known forms at Druid level 9.").waitFor();
      assert.equal(await step.getByRole("alert").count(), 0, "Change clears the refusal");
      assert.deepEqual(ana2.watch.errors, []);
    } finally {
      await ana2.context.close();
    }
  });

  test("4e. knownforms-c: a refusal that comes while the step stays open moves the toggled row back, and the keyboard's focus with it", async () => {
    const ana2 = await routedAna();
    const { page } = ana2;
    try {
      const step = await openKnownFormsStep(page);
      const wolf = step.getByRole("button", { name: /^Wolf / }).first();
      const pressedIs = (value: string) => waitFor(`the Wolf pressed ${value}`, async () => ((await wolf.getAttribute("aria-pressed")) === value ? true : null));
      ana2.route.spoil = true;
      ana2.route.hold = true;
      await wolf.focus();
      await page.keyboard.press("Enter");
      await pressedIs("false");
      assert.equal(await focusedForm(page), "wolf", "the focus stays on the Wolf the prediction took out");
      await waitFor("the refusal held back", () => (ana2.held() > 0 ? true : null));
      ana2.release();
      await step.getByRole("alert").getByText(/^Not saved\. /).waitFor();
      await pressedIs("true");
      assert.equal(await focusedForm(page), "wolf", "the focus follows the Wolf back as the refusal rolls the toggle back");
      assert.deepEqual(ana2.watch.errors, []);
    } finally {
      await ana2.context.close();
    }
  });

  test("lp2-3b. in Wild Shape the Take a shape button stays: its picker changes the form, and its Change step changes the known forms, removing the last one and adding it again, without ending the shape (D-261024-29)", async () => {
    const panel = await showBree(ana);
    const breeActor = () => anaSocket.state?.characters[run.bree.characterId]?.actor;
    const breeForms = () => anaSocket.state?.characters[run.bree.characterId]?.knownForms ?? [];
    const picker = ana.getByRole("dialog", { name: "Take a shape" });
    const step = ana.getByRole("dialog", { name: "Bree's known forms" });
    const openPicker = async () => {
      if (await picker.isVisible()) return;
      await panel.getByRole("button", { name: /^Take a shape/ }).click();
      await picker.waitFor();
    };
    await openPicker();
    await picker.getByRole("button", { name: "Wild Shape as Wolf", exact: true }).click();
    await picker.waitFor({ state: "detached" });
    await waitFor("Bree as a wolf", () => (breeActor()?.srdId === "wolf" && breeActor()?.wildShape ? true : null));
    const stillWolf = () => assert.ok(breeActor()?.srdId === "wolf" && breeActor()?.wildShape, "the shape ended");
    assert.equal(await panel.getByRole("button", { name: /^Take a shape/ }).count(), 1, "Take a shape stays in Wild Shape");
    const open = async (words: string) => {
      await openPicker();
      await picker.getByRole("button", { name: words, exact: true }).click();
      await step.waitFor();
    };
    const close = async () => {
      await step.getByRole("button", { name: "Close Bree's known forms", exact: true }).click();
      await step.waitFor({ state: "detached" });
    };

    await open("Change");
    await shots.take(ana, "pcstats-lp2-3b-change-step");
    await close();
    stillWolf();

    await open("Change");
    const row = (name: RegExp) => step.getByRole("button", { name }).first();
    for (const name of [/^Black Bear /, /^Wolf /]) {
      if ((await row(name).getAttribute("aria-pressed")) === "true") await row(name).click();
    }
    await waitFor("no known forms", () => (breeForms().length === 0 ? true : null));
    await step.getByText(/^0 (of \d+ )?known forms/).waitFor();
    await close();
    stillWolf();
    await openPicker();
    await picker.getByRole("button", { name: "Choose known forms", exact: true }).waitFor();
    assert.equal(await picker.getByRole("button", { name: "Change", exact: true }).count(), 0);
    await shots.take(ana, "pcstats-lp2-3b-choose-known-forms");

    await open("Choose known forms");
    await row(/^Black Bear /).click();
    await row(/^Wolf /).click();
    await waitFor("the two forms back", () => (breeForms().length === 2 ? true : null));
    await close();
    stillWolf();
    await openPicker();
    await picker.getByRole("button", { name: "Change", exact: true }).waitFor();
    await ana.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
    await panel.getByRole("button", { name: "End the shape" }).click();
    await waitFor("the shape ended", () => (breeActor()?.srdId === undefined ? true : null));
  });

  test("5. a D&D Beyond character's JSON pasted fills the review, which lists what it replaces since Bree has no sync record, and Use it then Save keeps Ana's own block parts it did not read", async () => {
    const panel = await showBree(ana);
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = editor(ana);
    await sheet.getByRole("button", { name: "D&D Beyond" }).click();
    const step = ana.getByRole("dialog", { name: "D&D Beyond" });
    await step.getByRole("button", { name: "Paste its JSON instead" }).click();
    await step.locator("textarea").fill(JSON.stringify(DDB_JSON));
    await step.getByRole("button", { name: "Read it", exact: true }).click();
    const review = ana.getByRole("dialog", { name: "Check what was read" });
    await review.getByText("Read from D&D Beyond: Wren Ashdown, level 7.").waitFor();
    // With no record of a past sync the fill takes what it read, and lists each typed value it replaces (docs/design-v1-resync.md 3.3).
    await review.getByRole("heading", { name: /^Replaces your changes \(\d+\)$/ }).waitFor();
    assert.equal(await review.getByRole("checkbox", { name: "AC 13, now 15", exact: true }).isChecked(), true);
    await review.getByText("Worked out from the armor. Check it.", { exact: true }).waitFor();
    assert.equal(await review.getByRole("checkbox", { name: /^Name Wren Ashdown, now Bree$/ }).isChecked(), false, "the name starts off");
    assert.equal(await review.getByRole("checkbox", { name: /^Level 7, now 9$/ }).isChecked(), true);
    await shots.take(ana, "pcstats-ddb-review");
    await review.getByRole("button", { name: "Use it" }).click();
    await editor(ana).getByRole("button", { name: "Save", exact: true }).click();
    await editor(ana).waitFor({ state: "detached" });
    const after = await waitFor("the import saved", () => {
      const c = anaSocket.state?.characters[run.bree.characterId];
      return c?.stats?.rolls.some((r) => r.name === "Rapier") ? c : null;
    });
    assert.equal(after.name, "Bree", "the name stays unless ticked");
    assert.equal(after.level, 7);
    assert.equal(after.stats!.evasion, true);
    assert.equal(after.stats!.rolls.find((r) => r.name === "Rapier")?.ddb, true);
    assert.equal(after.actor.sheetUrl, "https://www.dndbeyond.com/characters/87654321");
    await panel.locator("[data-pc-stats]").getByText("Rapier.", { exact: false }).waitFor();
  });

  test("6. no page logged an error", () => {
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    assert.deepEqual(consoles.ana.errors, [], "Ana's page logged errors");
    assert.deepEqual(consoles.cy.errors, [], "Cy's page logged errors");
  });
});
