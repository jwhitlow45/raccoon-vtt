import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Companion stat blocks end to end (docs/design-v1-companion-stat-blocks.md
 * section 10): a player's companion added from the SRD's owl, a block
 * pasted from a book into the character's stat blocks, attaching with the
 * numbers step and its size through the token window's resize, Change and
 * Detach, what another player and the DM see, a room monster's link, a
 * growth beside a wall and in a corridor, the saves budget, a deleted
 * block, view as a player, and every screen size.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus sixteen.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 16;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-companions-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
/** Ana, who plays Bree, at a computer. */
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

const run = {
  roomId: "",
  roomName: `E2E companions ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  anaId: "",
  cyId: "",
  bree: { characterId: randomUUID(), tokenId: randomUUID() },
};

/** A stat block made up for this test, as a web page's copy gives it. */
const MOTH = [
  "Moth Spirit",
  "Small Fey, Unaligned",
  "AC 12",
  "Initiative +2 (12)",
  "HP 9 (2d6 + 2)",
  "Speed 10 ft., Fly 40 ft. (hover)",
  "\tMOD\tSAVE",
  "STR\t6\t−2\t−2",
  "DEX\t15\t+2\t+2",
  "CON\t12\t+1\t+1",
  "\tMOD\tSAVE",
  "INT\t4\t−3\t−3",
  "WIS\t13\t+1\t+1",
  "CHA\t8\t−1\t−1",
  "Resistances Cold",
  "Senses Darkvision 60 ft.; Passive Perception 11",
  "Languages None",
  "CR 1/4 (XP 50; PB +2)",
  "Traits",
  "Lantern Wings. It sheds dim light in a 10-foot radius.",
  "Actions",
  "Dust. Constitution Saving Throw: DC 11, one creature within 5 feet. Failure: The target has the Poisoned condition until the end of its next turn.",
].join("\n");

function actor(over: Record<string, unknown> = {}) {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
    life: "alive",
    ac: 12,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
    ...over,
  };
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

function bar(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `${name} actions` });
}

function tokenPanel(page: Page): Locator {
  // Exact, since the panel's Token settings group is a region of its own.
  return page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true }));
}

function companionOf(name: string) {
  return Object.values(dmSocket.state?.tokens ?? {}).find((t) => t?.name === name && t.companion !== undefined);
}

function inline(name: string) {
  const t = companionOf(name);
  return t && "inline" in t.actor ? t.actor.inline : undefined;
}

/** A field's value, once its draft has caught up with the form. */
async function valueIs(field: Locator, value: string): Promise<void> {
  let seen = "";
  await waitFor(`the value "${value}"`, async () => {
    seen = await field.inputValue();
    return seen === value;
  }).catch((err: Error) => {
    throw new Error(`${err.message}, it read "${seen}"`);
  });
}

type View = { width: number; height: number; scale: number };
type El = { clientWidth: number; scrollWidth: number; getAttribute(n: string): string | null; textContent: string | null; querySelectorAll(s: string): ArrayLike<El> };

/** A viewport and interface size, on a fresh load of the room. */
async function setUp(page: Page, cdp: CDPSession, view: View): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  // A fresh load of the room's address, once more when it meets a navigation the page started itself.
  const address = `${server.origin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`;
  await page.goto(address).catch(() => page.goto(address));
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Opens a panel: from the side panel's tabs from 900 layout px up, else from the Panels sheet's list, as size.e2e.ts does. */
async function openPanel(page: Page, title: string): Promise<void> {
  if (await page.getByRole("tablist", { name: "Panels" }).isVisible()) return openSideTab(page, title);
  // Already open: a sheet on a subpage, such as a character's page, has Back where All panels was, and the tool bar's Panels would close it.
  if (await page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`).isVisible()) return;
  const picker = page.getByRole("list", { name: "Panels" });
  const all = page.getByRole("button", { name: "All panels" });
  if (await picker.isVisible()) {
    // The list is already open.
  } else if (await all.isVisible()) await all.click();
  else await page.locator('button[title="Panels"]').click();
  await picker.getByRole("button", { name: new RegExp(`^${title}( ?\\d+ unread)?$`) }).click();
}

/** Nothing in the scope runs out of its box sideways, as tokenpanel.e2e.ts checks it: a box built to scroll sideways is left out. */
async function noSideScroll(scope: Locator, label: string): Promise<void> {
  const wide = await scope.evaluate((root) => {
    type Styled = El & { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { overflowX: string } } } };
    const all = [root as unknown as Styled, ...(Array.from((root as unknown as El).querySelectorAll("*")) as Styled[])];
    return all
      .filter((el) => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1)
      .filter((el) => el === (root as unknown) || el.ownerDocument.defaultView.getComputedStyle(el).overflowX === "visible")
      .map((el) => `${el.getAttribute("aria-label") ?? (el.textContent ?? "").slice(0, 30)}: ${el.scrollWidth} > ${el.clientWidth}`);
  });
  assert.deepEqual(wide, [], `${label}: content wider than its box`);
}

/** A button lies inside the window, so it can be pressed without scrolling the page. */
async function inReach(page: Page, button: Locator, label: string): Promise<void> {
  const box = await button.boundingBox();
  const size = page.viewportSize()!;
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `${label}: out of reach ${JSON.stringify(box)}`);
}

/** Opens Bree's page in the Characters tab and a companion's bar from its row. */
async function showCompanion(page: Page, name: string, characterId: string = run.bree.characterId): Promise<void> {
  await openCard(page, characterId);
  await page.getByRole("button", { name: new RegExp(`^${name}\\. Show it on the map`) }).click();
  await bar(page, name).waitFor();
}

/** A character's page in the Characters panel, open. One page shows at a time, so from another's this goes Back to Characters first. */
async function openCard(page: Page, characterId: string): Promise<void> {
  await openPanel(page, "Characters");
  const blocks = page.locator(`[data-opener="blocks:${characterId}"]`);
  if (!(await blocks.isVisible())) {
    const back = page.getByRole("button", { name: "Back to Characters" });
    if (await back.isVisible()) await back.click();
    await page.locator(`[data-opener="character:${characterId}"]`).click();
  }
  await blocks.waitFor();
}

/** Leaves the add form, whose block or fields were changed, by its Cancel and then Discard changes? (docs/design-v1-look-pass.md 3.1). */
async function discardForm(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  // The header's Back asks the same question: the form's own button is the last.
  await page.getByRole("button", { name: "Discard changes?" }).last().click();
  await page.getByRole("button", { name: "Add and place" }).waitFor({ state: "detached" });
}

/** A stat block's lines, for blocks the DM makes by op. */
const LINES = {
  size: "small",
  type: "Fey",
  alignment: "Unaligned",
  ac: 12,
  initiative: 2,
  hp: { average: 9, formula: "2d6 + 2" },
  speed: "10 ft., Fly 40 ft. (hover)",
  abilities: { str: { score: 6, save: -2 }, dex: { score: 15, save: 2 }, con: { score: 12, save: 1 }, int: { score: 4, save: -3 }, wis: { score: 13, save: 1 }, cha: { score: 8, save: -1 } },
  skills: "",
  vulnerabilities: "",
  resistances: "",
  immunities: "",
  gear: "",
  senses: "",
  passivePerception: 11,
  languages: "",
  cr: "1/4",
  xp: 50,
  traits: [],
  actions: [],
  bonusActions: [],
  reactions: [],
  legendaryActions: [],
};

/**
 * A character of Ana's with a companion on the players' scene and stat
 * blocks of its own, made by the DM's ops. Returns their ids.
 */
async function charactersCompanion(name: string, companion: string, at: { x: number; y: number }, blocks: string[]): Promise<{ characterId: string; tokenId: string; blockIds: string[] }> {
  const characterId = randomUUID();
  const tokenId = randomUUID();
  const blockIds = blocks.map(() => randomUUID());
  await ops.send({ t: "character.create", character: { id: characterId, name, size: "medium", ownerIds: [run.anaId], actor: actor() } });
  for (const [i, blockName] of blocks.entries()) await ops.send({ t: "companionBlock.create", block: { ...LINES, id: blockIds[i]!, characterId, name: blockName } });
  await ops.send({
    t: "token.create",
    token: { id: tokenId, sceneId: run.sceneId, kind: "npc", name: companion, size: "small", x: at.x, y: at.y, disposition: "ally", companion: { of: characterId, turn: "shared" }, actor: { inline: actor(blockIds[0] ? { blockId: blockIds[0] } : {}) } },
  });
  await waitFor(`${companion} for Ana`, () => (anaSocket.state?.tokens[tokenId] && blockIds.every((id) => anaSocket.state?.companionBlocks[id]) ? true : null));
  return { characterId, tokenId, blockIds };
}

/** The open editor's notice that its block cannot be saved, with its draft kept and Save off. */
async function cannotSave(editor: Locator, field: Locator, value: string, label: string): Promise<void> {
  await editor.getByText("This stat block was deleted or is no longer yours, so it cannot be saved.", { exact: true }).waitFor();
  assert.ok(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(), `${label}: Save is off`);
  assert.equal(await field.inputValue(), value, `${label}: the draft stays`);
}

/** Cancel, then Discard: the only way a draft goes without being saved. */
async function discard(editor: Locator): Promise<void> {
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await editor.getByRole("button", { name: "Discard" }).click();
  await editor.waitFor({ state: "detached" });
}

describe("raccoon-vtt companion stat blocks", { timeout: 900_000 }, () => {
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
    run.cyId = await join(cyContext, "Cy", "#3e63dd");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: { w: 20, h: 14 }, fogEnabled: false } });
    // New rooms let players create characters. This file checks companions work without that.
    await ops.send({ t: "room.update", settings: { playersCreateCharacters: false } });
    await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [run.anaId], actor: actor({ ac: 15, hp: { cur: 24, max: 24, temp: 0 } }) } });
    await ops.send({ t: "token.create", token: { id: run.bree.tokenId, sceneId: run.sceneId, kind: "pc", name: "Bree", size: "medium", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree.characterId } } });
    await ana.goto(`${server.origin}/r/${run.roomId}`);
    await cy.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Ana's snapshot", () => anaSocket.state);
    await waitFor("Cy's snapshot", () => cySocket.state);
    assert.equal(dmSocket.state!.meta.settings.playersCreateCharacters, false, "no setting is needed");
  });

  test("1. Ana adds Owl from the SRD: the form fills, and its bar shows the owl's numbers, saves and Stat block, which opens the block with the SRD's credit", async () => {
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: "Add a companion" }).click();
    await ana.getByRole("button", { name: "Choose a stat block" }).click();
    const picker = ana.getByRole("dialog", { name: "Choose a stat block" });
    await picker.getByText("SRD 5.2.1 (330)").waitFor();
    await picker.getByRole("searchbox", { name: "Search monsters" }).fill("owl");
    await picker.getByText(/^SRD 5\.2\.1 \(\d+ of 330\)$/).waitFor();
    await shots.take(ana, "companions-choose-owl");
    await picker.getByRole("button", { name: /^Owl\b/ }).first().click();
    await picker.waitFor({ state: "detached" });
    await valueIs(ana.getByRole("textbox", { name: "Name" }), "Owl");
    await valueIs(ana.getByRole("combobox", { name: "Size" }), "tiny");
    await valueIs(ana.getByRole("textbox", { name: "HP" }), "1");
    await valueIs(ana.getByRole("textbox", { name: "AC" }), "11");
    await ana.getByText("From the block: Speed 5 ft, Fly 60 ft. Darkvision 120 ft. Passive Perception 15. Initiative +1.").waitFor();
    await ana.getByText("The block’s average, 1 (1d4 − 1). Type another for a higher-level casting.").waitFor();
    await shots.take(ana, "companions-form-owl");
    await ana.getByRole("button", { name: "Add and place" }).click();
    const owl = await waitFor("Owl in the DM's view", () => companionOf("Owl"));
    assert.ok("inline" in owl.actor);
    assert.deepEqual([owl.size, owl.actor.inline.srdId, owl.actor.inline.ac, owl.actor.inline.hp.max, owl.actor.inline.passivePerception, owl.actor.inline.initBonus], ["tiny", "owl", 11, 1, 15, 1]);
    assert.deepEqual(owl.actor.inline.speeds, { walk: 5, fly: 60 });
    const b = bar(ana, "Owl");
    await b.waitFor();
    await b.getByText(/STR −4/).waitFor();
    await shots.take(ana, "companions-owl-bar");
    await b.getByRole("button", { name: "Stat block", exact: true }).click();
    const panel = tokenPanel(ana);
    await panel.getByText("Stat blocks from the System Reference Document 5.2.1").first().waitFor();
    await panel.getByRole("button", { name: "Copy to Bree’s stat blocks and edit" }).waitFor();
    await shots.take(ana, "companions-owl-panel");
    await ana.keyboard.press("Escape");
  });

  test("2. Ana pastes a block into Bree's stat blocks, and a companion added from it is dismissed and added again from the same block", async () => {
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Stat blocks \(0\)$/ }).click();
    await ana.getByRole("heading", { name: "Bree’s stat blocks" }).waitFor();
    await ana.getByText("Bree’s companions’ stat blocks go here.", { exact: false }).waitFor();
    await ana.getByRole("button", { name: "Paste a stat block" }).click();
    const editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await editor.getByRole("textbox").first().fill(MOTH);
    await editor.getByRole("button", { name: "Read the stat block" }).click();
    await editor.getByRole("heading", { name: "Picture" }).or(editor.getByText("Picture", { exact: true })).first().waitFor();
    await shots.take(ana, "companions-paste-editor");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    const moth = await waitFor("the block in the DM's view", () => Object.values(dmSocket.state?.companionBlocks ?? {}).find((b) => b?.name === "Moth Spirit"));
    assert.equal(moth.characterId, run.bree.characterId);
    assert.equal(moth.resistances, "Cold");
    await ana.getByRole("button", { name: /^Moth Spirit/ }).waitFor();
    await shots.take(ana, "companions-blocks-page");
    await ana.getByRole("button", { name: "Back to Bree" }).click();
    await ana.getByRole("button", { name: /^Stat blocks \(1\)$/ }).waitFor();
  });

  test("3. attaching to Hoot, added with typed numbers: the numbers step, Use, the HP it keeps, and the size as a second op that Ctrl+Z alone takes back", async () => {
    await ana.getByRole("button", { name: "Add a companion" }).click();
    await ana.getByRole("textbox", { name: "Name" }).fill("Hoot");
    await ana.getByRole("textbox", { name: "HP" }).fill("6");
    await ana.getByRole("textbox", { name: "AC" }).fill("10");
    await ana.getByRole("button", { name: "Add and place" }).click();
    await waitFor("Hoot", () => companionOf("Hoot"));
    await bar(ana, "Hoot").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(ana);
    await panel.getByRole("button", { name: "Attach a stat block" }).click();
    const dialog = ana.getByRole("dialog", { name: "Attach a stat block" });
    await dialog.getByText("Bree’s players and the DM read it. Next you choose whether it sets Hoot’s numbers.").waitFor();
    await dialog.getByText(/^Bree’s stat blocks \(1\)$/).waitFor();
    await dialog.getByRole("searchbox", { name: "Search monsters" }).fill("owl");
    await shots.take(ana, "companions-attach-pick");
    await dialog.getByRole("button", { name: /^Owl\b/ }).first().click();
    const step = ana.getByRole("dialog", { name: "Attach Owl" });
    for (const line of ["AC 11, now 10", "Speed 5 ft, Fly 60 ft, now 30 ft", "Darkvision 120 ft, now none", "Passive Perception 15, now 10", "Initiative +1, now +0"]) await step.getByText(line, { exact: true }).waitFor();
    await step.getByText("Hoot is unhurt, so it stays at full HP: 1 of 1.").waitFor();
    await shots.take(ana, "companions-numbers-step");
    // Back keeps the search.
    await step.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await dialog.getByRole("searchbox", { name: "Search monsters" }).inputValue(), "owl");
    await dialog.getByRole("button", { name: /^Owl\b/ }).first().click();
    await step.getByRole("radio", { name: "Type one" }).check();
    await step.getByRole("textbox", { name: "Max HP" }).fill("7");
    await step.getByRole("textbox", { name: "Max HP" }).press("Tab");
    await step.getByText("Hoot is unhurt, so it stays at full HP: 7 of 7.").waitFor();
    // Shrinking needs no room, so the Size line says nothing more.
    await step.getByText("Size Tiny, now Small", { exact: true }).waitFor();
    const at = { x: companionOf("Hoot")!.x, y: companionOf("Hoot")!.y };
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.waitFor({ state: "detached" });
    const hoot = await waitFor("Hoot's numbers", () => (inline("Hoot")?.srdId === "owl" ? inline("Hoot") : null));
    assert.deepEqual([hoot.ac, hoot.hp.cur, hoot.hp.max, hoot.passivePerception, hoot.initBonus, hoot.senses], [11, 7, 7, 15, 1, "Darkvision 120 ft."]);
    await waitFor("Hoot Tiny, by its own op", () => (companionOf("Hoot")?.size === "tiny" ? true : null));
    await panel.getByText("Stat blocks from the System Reference Document 5.2.1").first().waitFor();
    await shots.take(ana, "companions-attached-panel");
    // Ctrl+Z right after takes back the size alone: Small where it stood, with the owl's block and numbers kept.
    await ana.keyboard.press("Control+z");
    await waitFor("Hoot Small again", () => {
      const t = companionOf("Hoot");
      return t?.size === "small" && t.x === at.x && t.y === at.y ? true : null;
    });
    assert.deepEqual([inline("Hoot")!.srdId, inline("Hoot")!.ac, inline("Hoot")!.hp.max], ["owl", 11, 7]);
  });

  test("4. Change swaps the block in one step, Keep sends the link alone, and Detach keeps the numbers", async () => {
    const panel = tokenPanel(ana);
    await panel.getByRole("button", { name: "Change", exact: true }).click();
    const dialog = ana.getByRole("dialog", { name: "Attach a stat block" });
    await dialog.getByRole("button", { name: /^Moth Spirit/ }).first().click();
    const step = ana.getByRole("dialog", { name: "Attach Moth Spirit" });
    await step.getByRole("radio", { name: "Keep Hoot’s numbers" }).check();
    await step.getByText("Only the stat block is attached.", { exact: false }).waitFor();
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.waitFor({ state: "detached" });
    const hoot = await waitFor("Hoot's block", () => (inline("Hoot")?.blockId ? inline("Hoot") : null));
    assert.equal(hoot.srdId, undefined, "one link");
    assert.deepEqual([hoot.ac, hoot.hp.max], [11, 7], "Keep leaves the numbers");
    await panel.getByText("Lantern Wings", { exact: false }).waitFor();
    await panel.getByRole("button", { name: "Edit", exact: true }).waitFor();
    await shots.take(ana, "companions-block-panel");
    // The bar reads its saves and defenses from the block.
    await showCompanion(ana, "Hoot");
    await bar(ana, "Hoot").getByText("Cold", { exact: false }).first().waitFor();
    await bar(ana, "Hoot").getByText(/STR −2/).waitFor();
    await shots.take(ana, "companions-block-bar");
    await bar(ana, "Hoot").getByRole("button", { name: "Stat block", exact: true }).click();
    await panel.getByRole("button", { name: "Detach", exact: true }).click();
    await waitFor("no link", () => (inline("Hoot")?.blockId === undefined ? true : null));
    assert.equal(inline("Hoot")!.ac, 11);
    await panel.getByRole("button", { name: "Attach a stat block" }).waitFor();
  });

  test("5. Cy sees the companions' tokens, names and HP, with no stat block, link or block in what Cy receives", async () => {
    await waitFor("Hoot in Cy's view", () => Object.values(cySocket.state?.tokens ?? {}).find((t) => t?.name === "Hoot"));
    assert.deepEqual(cySocket.state!.companionBlocks, {});
    for (const frame of cySocket.received) assert.ok(!frame.includes("Lantern Wings"), "a block's text reached Cy");
    const owl = Object.values(cySocket.state!.tokens).find((t) => t?.name === "Owl")!;
    assert.ok("inline" in owl.actor && !("srdId" in owl.actor.inline) && !("blockId" in owl.actor.inline));
  });

  test("6. a room monster made Bree's companion: the DM reads its block with the line that her players do not, and Ana's panel offers Attach", async () => {
    const monsterId = randomUUID();
    const hound = {
      id: monsterId,
      name: "Moon Hound",
      size: "medium",
      type: "Fey",
      alignment: "Unaligned",
      ac: 13,
      initiative: 2,
      hp: { average: 22, formula: "4d8 + 4" },
      speed: "40 ft.",
      abilities: { str: { score: 14, save: 2 }, dex: { score: 14, save: 2 }, con: { score: 12, save: 1 }, int: { score: 6, save: -2 }, wis: { score: 12, save: 1 }, cha: { score: 8, save: -1 } },
      skills: "",
      vulnerabilities: "",
      resistances: "",
      immunities: "",
      gear: "",
      senses: "Darkvision 60 ft.",
      passivePerception: 14,
      languages: "",
      cr: "1",
      xp: 200,
      traits: [{ name: "Moonlit Coat", text: "Its coat glows faintly under the moon." }],
      actions: [],
      bonusActions: [],
      reactions: [],
      legendaryActions: [],
    };
    await ops.send({ t: "monster.create", monster: hound });
    const id = randomUUID();
    await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, kind: "monster", name: "Moon Hound", size: "medium", x: 9, y: 5, actor: { inline: actor({ ac: 13, monsterId }) } } });
    await ops.send({ t: "token.update", tokenId: id, patch: { companion: { of: run.bree.characterId, turn: "shared" }, disposition: "ally" } });
    await openSideTab(dm, "Characters");
    await dm.getByRole("tabpanel", { name: "Characters" }).getByRole("button", { name: /^Bree/ }).first().click();
    await dm.getByRole("button", { name: /^Moon Hound\. Show it on the map/ }).click();
    await bar(dm, "Moon Hound").getByRole("button", { name: "Stat block", exact: true }).click();
    const dmPanel = tokenPanel(dm);
    await dmPanel.getByText("Bree’s players do not see this block: it is one of this room’s own monsters.", { exact: false }).waitFor();
    assert.equal(await dmPanel.getByRole("button", { name: /^Copy to/ }).count(), 0, "no way to copy it");
    await shots.take(dm, "companions-dm-room-monster");
    await dmPanel.getByRole("button", { name: "Change", exact: true }).click();
    const dmPicker = dm.getByRole("dialog", { name: "Attach a stat block" });
    await dmPicker.getByText("SRD 5.2.1 (330)").waitFor();
    assert.equal(await dmPicker.getByText("This room").count(), 0, "no room monster in the companion picker");
    await dm.keyboard.press("Escape");
    await showCompanion(ana, "Moon Hound");
    await bar(ana, "Moon Hound").getByRole("button", { name: "Details", exact: true }).click();
    await tokenPanel(ana).getByRole("button", { name: "Attach a stat block" }).waitFor();
    assert.equal(await tokenPanel(ana).getByText("Moonlit Coat").count(), 0);
    await shots.take(ana, "companions-player-room-monster");
  });

  test("7. beside a wall Hoot grows into the room it has, in a corridor it keeps its size with its numbers applied, locked it keeps its size, and the DM's growth is unchecked", async () => {
    const hoot = companionOf("Hoot")!;
    const wall = { kind: "wall" } as const;
    const edges: { key: string; feature: typeof wall }[] = [];
    // A wall along the right side of (12, 2), open floor to its left.
    for (let y = 0; y <= 5; y++) edges.push({ key: `13,${y},w`, feature: wall });
    // A 5 ft corridor along row 9.
    for (let x = 0; x <= 19; x++) edges.push({ key: `${x},9,n`, feature: wall }, { key: `${x},10,n`, feature: wall });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { autoWalls: "off", blockMovement: true } });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });
    await ops.send({ t: "token.update", tokenId: hoot.id, patch: { x: 12, y: 2 } });
    await waitFor("Hoot beside the wall", () => (companionOf("Hoot")?.x === 12 ? true : null));
    const attachDireWolf = async (page: Page) => {
      await openSideTab(page, "Characters");
      const row = page.getByRole("button", { name: /^Hoot\. Show it on the map/ });
      if (!(await row.isVisible())) await page.getByRole("tabpanel", { name: "Characters" }).getByRole("button", { name: /^Bree/ }).first().click();
      await row.click();
      await bar(page, "Hoot").getByRole("button", { name: /^(Details|Stat block)$/ }).first().click();
      await tokenPanel(page).getByRole("button", { name: /^(Change|Attach a stat block)$/ }).first().click();
      const dialog = page.getByRole("dialog", { name: "Attach a stat block" });
      await dialog.getByRole("searchbox", { name: "Search monsters" }).fill("dire wolf");
      await dialog.getByRole("button", { name: /^Dire Wolf\b/ }).first().click();
      return page.getByRole("dialog", { name: "Attach Dire Wolf" });
    };

    // Beside the wall: the Size line says it moves, and after Attach it is Large over the square it stood on, clear of the wall.
    let step = await attachDireWolf(ana);
    await step.getByText("Size Large, now Small. It moves a little to clear the wall.", { exact: true }).waitFor();
    await shots.take(ana, "companions-size-shift");
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.waitFor({ state: "detached" });
    await waitFor("Hoot Large to the left", () => {
      const t = companionOf("Hoot");
      return t?.size === "large" && t.x === 11 && t.y <= 2 && t.y + 2 > 2 ? true : null;
    });

    // In the corridor, hurt, with temporary HP and a condition: no room, so it stays Small, the numbers apply, and the rest stays.
    await ops.send({ t: "token.update", tokenId: hoot.id, patch: { size: "small", x: 5, y: 9, actor: { ac: 9 } } });
    await ops.send({ t: "actor.hp", target: { tokenId: hoot.id }, change: { kind: "set", cur: 5, max: 10 } });
    await ops.send({ t: "actor.hp", target: { tokenId: hoot.id }, change: { kind: "temp", amount: 3 } });
    await ops.send({ t: "actor.effect.add", target: { tokenId: hoot.id }, effect: { id: randomUUID(), key: "frightened" } });
    await waitFor("Hoot hurt in the corridor", () => {
      const t = companionOf("Hoot");
      return t?.y === 9 && t.size === "small" && inline("Hoot")?.effects.length ? true : null;
    });
    step = await attachDireWolf(ana);
    await step.getByText("Size Large, now Small. No room to grow here: Hoot keeps its size.", { exact: true }).waitFor();
    await step.getByText("Hoot keeps its 5 HP, now of 22.").waitFor();
    await shots.take(ana, "companions-size-no-room");
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.waitFor({ state: "detached" });
    await waitFor("the numbers applied", () => (inline("Hoot")?.hp.max === 22 ? true : null));
    const after = inline("Hoot")!;
    assert.deepEqual([companionOf("Hoot")!.size, after.srdId, after.hp.cur, after.hp.temp, after.ac], ["small", "dire-wolf", 5, 3, 14]);
    assert.ok(after.effects.some((e) => e.key === "frightened"), "the condition stays");

    // Locked: the lock's line, and the link and numbers still apply.
    await ops.send({ t: "token.update", tokenId: hoot.id, patch: { locked: true, actor: { ac: 9 } } });
    await waitFor("Hoot locked for Ana", () => (anaSocket.state?.tokens[hoot.id]?.locked ? true : null));
    step = await attachDireWolf(ana);
    await step.getByText("Size Large: Hoot is locked, so its size stays. Ask the DM.", { exact: true }).waitFor();
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.waitFor({ state: "detached" });
    await waitFor("its AC again", () => (inline("Hoot")?.ac === 14 ? true : null));
    assert.equal(companionOf("Hoot")!.size, "small");
    await ops.send({ t: "token.update", tokenId: hoot.id, patch: { locked: false } });

    // The DM's attach in the same corridor grows at the base spot, unchecked.
    step = await attachDireWolf(dm);
    await step.getByText("Size Large, now Small", { exact: true }).waitFor();
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.waitFor({ state: "detached" });
    await waitFor("Hoot Large in the corridor", () => {
      const t = companionOf("Hoot");
      return t?.size === "large" && t.x === 5 && t.y === 9 ? true : null;
    });
    // Put back as it was, for the steps after.
    await ops.send({ t: "token.update", tokenId: hoot.id, patch: { size: "small", x: hoot.x, y: hoot.y } });
    await ops.send({ t: "actor.hp", target: { tokenId: hoot.id }, change: { kind: "set", temp: 0 } });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges: edges.map((e) => ({ key: e.key, feature: null })) });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { blockMovement: false } });
    await dm.keyboard.press("Escape");
  });

  test("7b. the DM's Copy to Bree's stat blocks and edit of the Owl, whose SRD image the DM chose, saves Bree's block with no picture and the SRD's credit, and the Owl follows it", async () => {
    await ops.send({ t: "monster.setSrdImage", srdId: "owl", image: { icon: "lorc/wolf-head", color: "#336699" } });
    await openSideTab(dm, "Characters");
    const row = dm.getByRole("button", { name: /^Owl\. Show it on the map/ });
    // A DM's list of characters starts folded.
    if (!(await row.isVisible())) await dm.getByRole("tabpanel", { name: "Characters" }).getByRole("button", { name: /^Bree/ }).first().click();
    await row.click();
    await bar(dm, "Owl").getByRole("button", { name: "Stat block", exact: true }).click();
    await tokenPanel(dm).getByRole("button", { name: "Copy to Bree’s stat blocks and edit" }).click();
    const editor = dm.getByRole("dialog", { name: "New stat block for Bree" });
    assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Owl");
    await shots.take(dm, "companions-dm-copy-editor");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    const copy = await waitFor("the copy", () => Object.values(dmSocket.state?.companionBlocks ?? {}).find((b) => b?.name === "Owl"));
    assert.equal(copy.fromSrd, "owl");
    assert.equal(copy.defaultImage, undefined, "the DM's image for the SRD owl stays the DM's");
    await waitFor("the Owl linked to the copy", () => (inline("Owl")?.blockId === copy.id && inline("Owl")?.srdId === undefined ? true : null));
    await tokenPanel(dm).getByText("Stat blocks from the System Reference Document 5.2.1").first().waitFor();
    await dm.keyboard.press("Escape");
  });

  test("7c. in a fight, the Owl's sub-row under Bree and then its own row offer Ana its stat block", async () => {
    const owl = companionOf("Owl")!;
    await ops.send({ t: "encounter.start", entries: [{ id: "e-bree", tokenId: run.bree.tokenId, value: 15 }] });
    await openSideTab(ana, "Initiative");
    await ana.getByRole("button", { name: "Owl options" }).click();
    await ana.getByRole("button", { name: "Stat block", exact: true }).first().click();
    await tokenPanel(ana).getByText("Stat blocks from the System Reference Document 5.2.1").first().waitFor();
    await shots.take(ana, "companions-sub-row-stat-block");
    await ops.send({ t: "token.update", tokenId: owl.id, patch: { companion: { of: run.bree.characterId, turn: "own" } } });
    await ops.send({ t: "encounter.add", entries: [{ id: "e-owl", tokenId: owl.id, value: 12 }] });
    await openSideTab(ana, "Initiative");
    await ana.getByRole("button", { name: "Owl options" }).click();
    await ana.getByRole("button", { name: "Stat block", exact: true }).first().click();
    await tokenPanel(ana).getByText("Stat blocks from the System Reference Document 5.2.1").first().waitFor();
    await ops.send({ t: "encounter.end" });
    await ops.send({ t: "token.update", tokenId: owl.id, patch: { companion: { of: run.bree.characterId, turn: "shared" } } });
  });

  test("7d. a companion Ana adds with its own turn while Bree fights joins the fight in a row of its own, its initiative still to roll", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: "e-bree-7d", tokenId: run.bree.tokenId, value: 15 }] });
    try {
      await openCard(ana, run.bree.characterId);
      await ana.locator(`[data-opener="companion:${run.bree.characterId}"]`).click();
      await ana.getByRole("textbox", { name: "Name", exact: true }).fill("Kestrel");
      await ana.getByRole("textbox", { name: "HP", exact: true }).fill("4");
      await ana.getByRole("combobox", { name: "Turn" }).selectOption("own");
      await ana.getByRole("button", { name: "Add and place" }).click();
      const kestrel = await waitFor("Kestrel", () => companionOf("Kestrel"));
      const row = await waitFor("Kestrel's row", () => dmSocket.state?.encounter?.entries.find((e) => e.tokenId === kestrel.id));
      assert.equal(row.value, null, "its player rolls it");
      await openSideTab(ana, "Initiative");
      const tracker = ana.getByRole("tabpanel", { name: /^Initiative/ });
      await tracker.getByText("Kestrel", { exact: true }).first().waitFor();
      assert.equal(await tracker.getByRole("button", { name: "Add Kestrel" }).count(), 0, "nothing left to join");
      await shots.take(ana, "companions-own-turn-joins");
    } finally {
      // The steps after this one start out of a fight and without Kestrel, whatever happened here.
      await ops.send({ t: "encounter.end" });
      const kestrel = companionOf("Kestrel");
      if (kestrel) await ops.send({ t: "token.delete", tokenId: kestrel.id });
    }
  });

  test("8. a block deleted while linked leaves its companion reading so, with its numbers", async () => {
    const ac = inline("Hoot")!.ac;
    await ops.send({ t: "token.update", tokenId: companionOf("Hoot")!.id, patch: { actor: { blockId: Object.values(dmSocket.state!.companionBlocks).find((b) => b?.name === "Moth Spirit")!.id } } });
    await openSideTab(ana, "Characters");
    await ana.getByText("Moth Spirit · On Bree's turn, listed").waitFor();
    await ana.getByRole("button", { name: /^Stat blocks \(2\)$/ }).click();
    await ana.getByRole("button", { name: /^Moth Spirit/ }).click();
    await ana.getByRole("button", { name: "Delete", exact: true }).click();
    await ana.getByRole("button", { name: "Tap again to delete" }).click();
    await waitFor("the block gone", () => (Object.values(dmSocket.state?.companionBlocks ?? {}).some((b) => b?.name === "Moth Spirit") ? null : true));
    await ana.getByRole("button", { name: "Back to Bree" }).click();
    await ana.getByText("Stat block deleted · On Bree's turn, listed").waitFor();
    await showCompanion(ana, "Hoot");
    await bar(ana, "Hoot").getByRole("button", { name: "Details", exact: true }).click();
    await tokenPanel(ana).getByText("This companion’s stat block was deleted.").waitFor();
    assert.equal(inline("Hoot")!.ac, ac);
    await shots.take(ana, "companions-deleted-block");
  });

  test("lp1-comp-a. Hoot's header names Bree in its kind line, a link to Bree's page; the add form's Back asks before it throws typing away, Cancel with nothing typed leaves at once, and each hands focus back to its opener", async () => {
    const focused = () =>
      ana.evaluate(() => {
        const a = (globalThis as unknown as { document: { activeElement: { tagName: string; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
        return a ? `${a.tagName.toLowerCase()} ${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim()}` : "none";
      });
    const lands = (on: string, what: string) => waitFor(what, async () => ((await focused()) === on ? true : null), 5_000).catch(async () => assert.fail(`${what}: focus is on "${await focused()}"`));
    await showCompanion(ana, "Hoot");
    await bar(ana, "Hoot").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(ana);
    const line = panel.locator("[data-kind-line]");
    assert.match((await line.textContent()) ?? "", /^Companion of Bree · \w+ \([\d.]+ ft\)$/, "the kind line says what Hoot is, then its size");
    await shots.take(ana, "companions-lp1-kind-line");
    await line.getByRole("button", { name: "Companion of Bree" }).click();
    // Bree's page, in the Characters panel, with focus on its title.
    await ana.getByRole("button", { name: "Back to Characters" }).waitFor();
    await ana.locator("[data-creature-heading]").filter({ hasText: "Bree" }).waitFor();
    await lands("h2 Bree", "focus on Bree's page's title");
    // Typed, the add form's Back asks first, and any change takes the question back.
    const add = ana.locator(`[data-opener="companion:${run.bree.characterId}"]`);
    await add.click();
    await lands("h2 Add a companion for Bree", "focus on the form's title");
    await ana.getByRole("textbox", { name: "Name", exact: true }).fill("Ferret");
    await ana.getByRole("button", { name: "Back to Bree" }).click();
    await ana.getByRole("button", { name: "Discard changes?" }).first().waitFor();
    await shots.take(ana, "companions-lp1-form-asks");
    await ana.getByRole("textbox", { name: "Name", exact: true }).fill("Ferrets");
    await ana.getByRole("button", { name: "Back to Bree" }).waitFor();
    assert.equal(await ana.getByRole("button", { name: "Discard changes?" }).count(), 0, "a change takes the question back");
    await ana.getByRole("button", { name: "Back to Bree" }).click();
    await ana.getByRole("button", { name: "Discard changes?" }).first().click();
    await lands("button Add a companion", "Back hands focus to Add a companion");
    assert.equal(companionOf("Ferrets"), undefined, "nothing was added");
    // Untouched, Cancel at the form's foot leaves at once.
    await add.click();
    await ana.getByRole("button", { name: "Cancel", exact: true }).click();
    await lands("button Add a companion", "Cancel hands focus to Add a companion");
    // The stat blocks page is a list: Back alone, which hands focus to its opener.
    const blocks = ana.locator(`[data-opener="blocks:${run.bree.characterId}"]`);
    await blocks.click();
    await ana.getByRole("heading", { name: "Bree’s stat blocks" }).waitFor();
    assert.equal(await ana.getByRole("button", { name: "Done", exact: true }).count(), 0, "no Done");
    await ana.getByRole("button", { name: "Back to Bree" }).click();
    await lands(`button ${(await blocks.textContent())?.trim()}`, "Back hands focus to Stat blocks");
  });

  test("8b. a block saved from either picker is the pick: New and Paste, in Attach and in Choose", async () => {
    const save = async (editor: Locator) => {
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await editor.waitFor({ state: "detached" });
    };
    const paste = async (editor: Locator, name: string) => {
      await editor.getByRole("textbox").first().fill(MOTH.replace("Moth Spirit", name));
      await editor.getByRole("button", { name: "Read the stat block" }).click();
      await valueIs(editor.getByRole("textbox", { name: "Name", exact: true }), name);
    };
    // Attach, from Hoot's panel: New, then Paste. Each saved block goes straight to its numbers step.
    await showCompanion(ana, "Hoot");
    await bar(ana, "Hoot").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(ana);
    await panel.getByRole("button", { name: "Attach a stat block" }).click();
    await ana.getByRole("dialog", { name: "Attach a stat block" }).getByRole("button", { name: "New stat block" }).click();
    let editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Gale Spirit");
    await save(editor);
    await ana.getByRole("dialog", { name: "Attach Gale Spirit" }).waitFor();
    await shots.take(ana, "companions-new-block-picked");
    await ana.keyboard.press("Escape");
    await panel.getByRole("button", { name: "Attach a stat block" }).click();
    await ana.getByRole("dialog", { name: "Attach a stat block" }).getByRole("button", { name: "Paste a stat block" }).click();
    editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await paste(editor, "Dusk Moth");
    await save(editor);
    await ana.getByRole("dialog", { name: "Attach Dusk Moth" }).waitFor();
    await ana.keyboard.press("Escape");
    assert.equal(inline("Hoot")!.blockId !== undefined && dmSocket.state!.companionBlocks[inline("Hoot")!.blockId!] !== undefined, false, "nothing attached");

    // Choose, from the add form: New fills the form, then Change and Paste fills the block field.
    await openCard(ana, run.bree.characterId);
    await ana.locator(`[data-opener="companion:${run.bree.characterId}"]`).click();
    await ana.getByRole("button", { name: "Choose a stat block" }).click();
    let choose = ana.getByRole("dialog", { name: "Choose a stat block" });
    await choose.getByRole("button", { name: "New stat block" }).click();
    editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Cinder Imp");
    await save(editor);
    await choose.waitFor({ state: "detached" });
    await valueIs(ana.getByRole("textbox", { name: "Name", exact: true }), "Cinder Imp");
    await ana.getByText("Cinder Imp", { exact: true }).first().waitFor();
    await ana.getByRole("button", { name: "Change", exact: true }).click();
    choose = ana.getByRole("dialog", { name: "Choose a stat block" });
    await choose.getByRole("button", { name: "Paste a stat block" }).click();
    editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await paste(editor, "Ash Wisp");
    await save(editor);
    await choose.waitFor({ state: "detached" });
    await ana.locator("strong").getByText("Ash Wisp", { exact: true }).waitFor();
    await shots.take(ana, "companions-pasted-block-chosen");
    await discardForm(ana);
    for (const name of ["Gale Spirit", "Dusk Moth", "Cinder Imp", "Ash Wisp"]) assert.ok(Object.values(dmSocket.state!.companionBlocks).some((b) => b?.name === name && b.characterId === run.bree.characterId), `${name} saved`);
  });

  test("8c. while a block's save or an attach waits, what was sent holds still: the fields and the numbers step's choices", async () => {
    const cass = await charactersCompanion("Cass", "Pip", { x: 14, y: 11 }, ["Lamp Moth"]);
    await showCompanion(ana, "Pip", cass.characterId);
    await bar(ana, "Pip").getByRole("button", { name: "Stat block", exact: true }).click();
    const section = ana.locator("[data-stat-block]");
    await section.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = ana.getByRole("dialog", { name: "Edit Lamp Moth" });
    await editor.getByLabel("AC", { exact: true }).fill("15");
    consoles.ana.expectSocketFailures = true;
    await anaContext.setOffline(true);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.getByRole("button", { name: "Saving…", exact: true }).waitFor();
    assert.ok(await editor.getByRole("textbox", { name: "Name", exact: true }).isDisabled(), "the fields hold while the save waits");
    assert.ok(await editor.getByLabel("AC", { exact: true }).isDisabled());
    await shots.take(ana, "companions-editor-saving");
    await anaContext.setOffline(false);
    await editor.waitFor({ state: "detached", timeout: 30_000 });
    await waitFor("AC 15 stored", () => (dmSocket.state?.companionBlocks[cass.blockIds[0]!]?.ac === 15 ? true : null));

    // The attach: Use and Keep and Max HP hold while the link waits, and the Size line after.
    await section.getByRole("button", { name: "Change", exact: true }).click();
    const dialog = ana.getByRole("dialog", { name: "Attach a stat block" });
    await dialog.getByRole("searchbox", { name: "Search monsters" }).fill("wolf");
    await dialog.getByRole("button", { name: /^Wolf\b/ }).first().click();
    const step = ana.getByRole("dialog", { name: "Attach Wolf" });
    await anaContext.setOffline(true);
    await step.getByRole("button", { name: "Attach", exact: true }).click();
    await step.getByRole("button", { name: "Attaching…", exact: true }).waitFor();
    assert.ok(await step.getByRole("radio", { name: "Keep Pip’s numbers" }).isDisabled(), "Use and Keep hold while the link waits");
    assert.ok(await step.getByRole("radio", { name: /^Average/ }).isDisabled());
    await shots.take(ana, "companions-attach-waiting");
    await anaContext.setOffline(false);
    await step.waitFor({ state: "detached", timeout: 30_000 });
    await waitFor("Pip a wolf", () => (anaSocket.state?.tokens[cass.tokenId]?.actor && "inline" in anaSocket.state.tokens[cass.tokenId]!.actor && (anaSocket.state.tokens[cass.tokenId]!.actor as { inline: { srdId?: string } }).inline.srdId === "wolf" ? true : null));
    consoles.ana.expectSocketFailures = false;
    await ops.send({ t: "character.delete", characterId: cass.characterId });
    await waitFor("Cass gone for Ana", () => (anaSocket.state?.characters[cass.characterId] ? null : true));
  });

  test("8d. an editor opened from a companion's panel keeps its block and its draft: the link moved to another block, the block deleted, the character no longer Ana's, the character deleted", async () => {
    const cass = await charactersCompanion("Cass", "Pip", { x: 14, y: 11 }, ["Lamp Moth", "Reed Moth"]);
    const [lamp, reed] = cass.blockIds as [string, string];
    const editFromPanel = async (companion: string, characterId: string, block: string) => {
      await showCompanion(ana, companion, characterId);
      await bar(ana, companion).getByRole("button", { name: "Stat block", exact: true }).click();
      await ana.locator("[data-stat-block]").getByRole("button", { name: "Edit", exact: true }).click();
      return ana.getByRole("dialog", { name: `Edit ${block}` });
    };

    // The link moves to Reed Moth while Lamp Moth's editor is open: it still edits Lamp Moth, and Save changes Lamp Moth alone.
    let editor = await editFromPanel("Pip", cass.characterId, "Lamp Moth");
    await editor.getByLabel("AC", { exact: true }).fill("17");
    await ops.send({ t: "token.update", tokenId: cass.tokenId, patch: { actor: { blockId: reed } } });
    await waitFor("Pip on Reed Moth for Ana", () => ((anaSocket.state?.tokens[cass.tokenId]?.actor as { inline?: { blockId?: string } })?.inline?.blockId === reed ? true : null));
    await tokenPanel(ana).getByText("Reed Moth", { exact: false }).first().waitFor();
    assert.equal(await editor.getByLabel("AC", { exact: true }).inputValue(), "17", "the draft stays");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await waitFor("Lamp Moth AC 17", () => (dmSocket.state?.companionBlocks[lamp]?.ac === 17 ? true : null));
    assert.equal(dmSocket.state!.companionBlocks[reed]!.ac, 12, "the block the link moved to is untouched");

    // Reed Moth deleted while its editor is open.
    editor = await editFromPanel("Pip", cass.characterId, "Reed Moth");
    let name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Reed Moth, mended");
    await ops.send({ t: "companionBlock.delete", blockId: reed });
    await cannotSave(editor, name, "Reed Moth, mended", "deleted from the panel");
    await shots.take(ana, "companions-editor-block-deleted");
    await discard(editor);

    // Cass no longer Ana's: the section goes, the editor stays.
    await ops.send({ t: "token.update", tokenId: cass.tokenId, patch: { actor: { blockId: lamp } } });
    editor = await editFromPanel("Pip", cass.characterId, "Lamp Moth");
    name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Lamp Moth, mine");
    await ops.send({ t: "character.update", characterId: cass.characterId, patch: { ownerIds: [] } });
    await cannotSave(editor, name, "Lamp Moth, mine", "no longer Ana's, from the panel");
    await discard(editor);
    await ops.send({ t: "character.update", characterId: cass.characterId, patch: { ownerIds: [run.anaId] } });
    await waitFor("Lamp Moth back for Ana", () => (anaSocket.state?.companionBlocks[lamp] ? true : null));

    // Cass deleted, and Pip with her: the panel goes, the editor stays.
    editor = await editFromPanel("Pip", cass.characterId, "Lamp Moth");
    name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Lamp Moth, last");
    await ops.send({ t: "character.delete", characterId: cass.characterId });
    await waitFor("Pip gone for Ana", () => (anaSocket.state?.tokens[cass.tokenId] ? null : true));
    await cannotSave(editor, name, "Lamp Moth, last", "character deleted, from the panel");
    await shots.take(ana, "companions-editor-character-deleted");
    await discard(editor);
  });

  test("8e. an editor opened from a character's stat blocks page keeps its draft: a co-owner's edit then Cancel, the block deleted, the character no longer Ana's, the character deleted", async () => {
    const dov = await charactersCompanion("Dov", "Nib", { x: 16, y: 11 }, ["Ash Moth", "Fern Moth", "Dew Moth"]);
    const [ash, fern, dew] = dov.blockIds as [string, string, string];
    const editFromPage = async (block: string) => {
      const heading = ana.getByRole("heading", { name: "Dov’s stat blocks" });
      if (!(await heading.isVisible())) {
        await openCard(ana, dov.characterId);
        await ana.locator(`[data-opener="blocks:${dov.characterId}"]`).click();
        await heading.waitFor();
      }
      // A row stays open as it was left, so a second edit of the same block finds it open.
      const row = ana.getByRole("button", { name: new RegExp(`^${block}`) });
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
      await ana.getByRole("button", { name: "Edit", exact: true }).click();
      return ana.getByRole("dialog", { name: `Edit ${block}` });
    };

    // A co-owner's edit arriving while the draft is untouched leaves it untouched: Cancel closes at once.
    let editor = await editFromPage("Ash Moth");
    await ops.send({ t: "companionBlock.update", blockId: ash, patch: { ac: 14 } });
    await waitFor("AC 14 for Ana", () => (anaSocket.state?.companionBlocks[ash]?.ac === 14 ? true : null));
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "detached" });

    // Deleted while open.
    editor = await editFromPage("Fern Moth");
    let name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Fern Moth, mended");
    await ops.send({ t: "companionBlock.delete", blockId: fern });
    await cannotSave(editor, name, "Fern Moth, mended", "deleted from the page");
    await discard(editor);

    // No longer Ana's.
    editor = await editFromPage("Dew Moth");
    name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Dew Moth, mine");
    await ops.send({ t: "character.update", characterId: dov.characterId, patch: { ownerIds: [] } });
    await cannotSave(editor, name, "Dew Moth, mine", "no longer Ana's, from the page");
    await discard(editor);
    await ops.send({ t: "character.update", characterId: dov.characterId, patch: { ownerIds: [run.anaId] } });
    await waitFor("Dew Moth back for Ana", () => (anaSocket.state?.companionBlocks[dew] ? true : null));

    // Deleted with the character: the page goes, the editor stays.
    editor = await editFromPage("Dew Moth");
    name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Dew Moth, last");
    await ops.send({ t: "character.delete", characterId: dov.characterId });
    await waitFor("Dov gone for Ana", () => (anaSocket.state?.characters[dov.characterId] ? null : true));
    await cannotSave(editor, name, "Dew Moth, last", "character deleted, from the page");
    await discard(editor);
    // Bree's card open again, as the steps after expect.
    await openCard(ana, run.bree.characterId);
  });

  test("9. viewing as Ana, Save in the editor flashes refused and the editor stays open", async () => {
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).first().click();
    const preview = dm.getByRole("dialog", { name: /^Viewing as / });
    await preview.waitFor();
    await openSideTab(preview, "Characters");
    await preview.getByRole("button", { name: /^Stat blocks \(\d+\)$/ }).click();
    await preview.getByRole("button", { name: "New stat block" }).click();
    const editor = dm.getByRole("dialog", { name: "New stat block for Bree" });
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Wisp");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await dm.getByText("Read-only: nothing you do here is saved.").waitFor();
    assert.ok(await editor.isVisible(), "the editor stays open");
    assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Wisp");
    await shots.take(dm, "companions-viewing-as-save");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.getByRole("button", { name: "Discard" }).click();
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    assert.equal(Object.values(dmSocket.state!.companionBlocks).some((b) => b?.name === "Wisp"), false);
  });

  test("9b. past the saves budget Ana's editor keeps the draft and offers Save again after a few seconds, while her HP change goes through at once", async () => {
    // Deletes from another device of Ana's use her budget up, until one is refused for it: a delete counts, refused or not.
    const cookie = (await anaContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const anaOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    let spent = false;
    for (let i = 0; i < 20 && !spent; i++) {
      await anaOps.send({ t: "companionBlock.delete", blockId: randomUUID() }).catch((err: Error) => (spent = /Too many stat block saves/.test(err.message)));
    }
    assert.ok(spent, "the budget ran out");
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Stat blocks \(\d+\)$/ }).click();
    await ana.getByRole("button", { name: "New stat block" }).click();
    const editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Ember Spirit");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.getByText("Too many stat block saves at once. Wait a few seconds, then save again.").waitFor();
    await editor.getByText("You can save again in a few seconds.").waitFor();
    assert.ok(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled());
    assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Ember Spirit", "the draft stays");
    await shots.take(ana, "companions-saves-budget");
    // Her other ops go on meanwhile: a refusal, never busy, holds nothing behind it.
    const hoot = companionOf("Hoot")!;
    const before = inline("Hoot")!.hp.cur;
    await anaOps.send({ t: "actor.hp", target: { tokenId: hoot.id }, change: { kind: "damage", amount: 1 } });
    await waitFor("Hoot hurt", () => (inline("Hoot")!.hp.cur === before - 1 ? true : null));
    anaOps.close();
    await waitFor("Save offered again", async () => !(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled()), 10_000);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await waitFor("Ember Spirit saved", () => Object.values(dmSocket.state?.companionBlocks ?? {}).find((b) => b?.name === "Ember Spirit"));
    await ana.getByRole("button", { name: "Back to Bree" }).click();
  });

  test("10. at 390 x 844, 844 x 390 and 1280 x 800, at 100% and 130%: the add form, both picker steps and the stat blocks page fit, with Attach and Save in reach", async () => {
    const cdp = await anaContext.newCDPSession(ana);
    for (const view of [
      { width: 390, height: 844, scale: 1 },
      { width: 390, height: 844, scale: 1.3 },
      { width: 844, height: 390, scale: 1 },
      { width: 844, height: 390, scale: 1.3 },
      { width: 1280, height: 800, scale: 1 },
      { width: 1280, height: 800, scale: 1.3 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      const tag = `${view.width}x${view.height}-${Math.round(view.scale * 100)}`;
      await setUp(ana, cdp, view);
      await openPanel(ana, "Characters");
      const add = ana.getByRole("button", { name: "Add a companion" });
      await add.click();
      await ana.getByRole("button", { name: "Choose a stat block" }).click();
      const choose = ana.getByRole("dialog", { name: "Choose a stat block" });
      await choose.getByText("SRD 5.2.1 (330)").waitFor();
      await noSideScroll(choose.locator("section").first(), `${label}: choose`);
      await choose.getByRole("searchbox", { name: "Search monsters" }).fill("owl");
      await choose.getByRole("button", { name: /^Owl\b/ }).first().click();
      await choose.waitFor({ state: "detached" });
      const form = ana.getByRole("button", { name: "Add and place" });
      await form.waitFor();
      const pane = ana.locator("[data-pane-body]").filter({ has: form }).first();
      await noSideScroll(pane, `${label}: the add form`);
      await shots.take(ana, `companions-form-${tag}`);
      await discardForm(ana);
      // The stat blocks page, named in the panel's header, outside the pane's body.
      await ana.getByRole("button", { name: /^Stat blocks \(\d+\)$/ }).click();
      await ana.getByRole("heading", { name: "Bree’s stat blocks" }).waitFor();
      const page = ana.locator("[data-pane-body]").filter({ has: ana.getByRole("button", { name: "New stat block" }) }).first();
      await noSideScroll(page, `${label}: the stat blocks page`);
      await shots.take(ana, `companions-blocks-page-${tag}`);
      await ana.getByRole("button", { name: "New stat block" }).click();
      const editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
      await inReach(ana, editor.getByRole("button", { name: "Save", exact: true }), `${label}: Save`);
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await ana.getByRole("button", { name: "Back to Bree" }).click();
      // Both picker steps, from Hoot's panel.
      await ana.getByRole("button", { name: /^Hoot\. Show it on the map/ }).click();
      await bar(ana, "Hoot").getByRole("button", { name: "Details", exact: true }).click();
      await tokenPanel(ana).getByRole("button", { name: "Attach a stat block" }).click();
      const dialog = ana.getByRole("dialog", { name: "Attach a stat block" });
      await dialog.getByText("SRD 5.2.1 (330)").waitFor();
      await noSideScroll(dialog.locator("section").first(), `${label}: attach, the lists`);
      await shots.take(ana, `companions-attach-lists-${tag}`);
      await dialog.getByRole("searchbox", { name: "Search monsters" }).fill("wolf");
      await dialog.getByRole("button", { name: /^Wolf\b/ }).first().click();
      const step = ana.getByRole("dialog", { name: "Attach Wolf" });
      await step.getByText("Temporary HP, conditions and effects stay.").waitFor();
      await noSideScroll(step.locator("section").first(), `${label}: attach, the numbers`);
      await inReach(ana, step.getByRole("button", { name: "Attach", exact: true }), `${label}: Attach`);
      await shots.take(ana, `companions-attach-numbers-${tag}`);
      await ana.keyboard.press("Escape");
      await step.waitFor({ state: "detached" });
    }
  });

  test("10a. characters with an 80 character name, with spaces and unbroken, at 390 x 844 and 130%: the tags, labels and lines that name them stay inside the picker, the add form, the stat blocks page and the panel", async () => {
    const cdp = await anaContext.newCDPSession(ana);
    const spaced = "Bree the Wandering Hedge Witch of the Far Northern Marches and the Old Salt Road".slice(0, 80);
    const unbroken = "Q".repeat(80);
    const made: { id: string; name: string; companion: string }[] = [];
    for (const [i, name] of [spaced, unbroken].entries()) {
      const c = await charactersCompanion(name, `Kit${i}`, { x: 2 + i * 2, y: 12 }, [`Ember Moth ${i}`]);
      // The companion starts with no block, so its panel offers Attach.
      await ops.send({ t: "token.update", tokenId: c.tokenId, patch: { actor: { blockId: null } } });
      made.push({ id: c.characterId, name, companion: `Kit${i}` });
    }
    await setUp(ana, cdp, { width: 390, height: 844, scale: 1.3 });
    for (const [i, c] of made.entries()) {
      const label = i === 0 ? "the spaced name" : "the unbroken name";
      // The stat blocks page.
      await openCard(ana, c.id);
      await noSideScroll(ana.locator("[data-pane-body]").first(), `${label}: the page`);
      await ana.locator(`[data-opener="blocks:${c.id}"]`).click();
      await ana.getByRole("heading", { name: `${c.name}’s stat blocks` }).waitFor();
      const page = ana.locator("[data-pane-body]").filter({ has: ana.getByRole("button", { name: "New stat block" }) }).first();
      await page.waitFor();
      await noSideScroll(page, `${label}: the stat blocks page`);
      await shots.take(ana, `companions-long-name-${i}-blocks-page`);
      await ana.getByRole("button", { name: `Back to ${c.name}`, exact: true }).click();
      // The add form's picker and the form with the block chosen.
      await ana.locator(`[data-opener="companion:${c.id}"]`).click();
      await ana.getByRole("button", { name: "Choose a stat block" }).click();
      const choose = ana.getByRole("dialog", { name: "Choose a stat block" });
      await choose.getByText(`${c.name}’s stat blocks (1)`).waitFor();
      await noSideScroll(choose.locator("section").first(), `${label}: choose`);
      await shots.take(ana, `companions-long-name-${i}-choose`);
      await choose.getByRole("button", { name: new RegExp(`^Ember Moth ${i}`) }).click();
      await choose.waitFor({ state: "detached" });
      const form = ana.locator("[data-pane-body]").filter({ has: ana.getByRole("button", { name: "Add and place" }) }).first();
      await noSideScroll(form, `${label}: the add form`);
      await shots.take(ana, `companions-long-name-${i}-form`);
      await discardForm(ana);
      // The companion's panel and its picker.
      await ana.getByRole("button", { name: new RegExp(`^${c.companion}\\. Show it on the map`) }).click();
      await bar(ana, c.companion).getByRole("button", { name: "Details", exact: true }).click();
      const panel = tokenPanel(ana);
      await panel.getByRole("button", { name: "Attach a stat block" }).waitFor();
      await noSideScroll(panel, `${label}: the token panel`);
      await shots.take(ana, `companions-long-name-${i}-panel`);
      await panel.getByRole("button", { name: "Attach a stat block" }).click();
      const dialog = ana.getByRole("dialog", { name: "Attach a stat block" });
      await dialog.getByText(`${c.name}’s stat blocks (1)`).waitFor();
      await noSideScroll(dialog.locator("section").first(), `${label}: attach, the lists`);
      await shots.take(ana, `companions-long-name-${i}-attach`);
      await ana.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await openPanel(ana, "Characters");
    }
    for (const c of made) await ops.send({ t: "character.delete", characterId: c.id });
  });

  test("10b. no page errors along the way", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} page errors`);
  });
});
