import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ddbCharacterId, ddbSheetUrl } from "../shared/ddb/link.ts";
import { readDdbCharacter } from "../shared/ddb/read.ts";
import type { PcStats } from "../shared/model.ts";
import { barControl, ConsoleWatch, openSideTab, OpSocket, reopenRoom, Shots, sleep, SocketWatch, startServer, tapCell, waitFor, wholeInReach, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Re-sync from D&D Beyond end to end (docs/design-v1-resync.md 5), on the
 * real server serving the production build. D&D Beyond is never asked:
 * each page routes the import request to an invented character built
 * here in the service's JSON shape and read by the app's own reader, or
 * to a refusal with the route's error code. Ana plays Bree, a druid the
 * DM typed in as a Charisma caster. The editor's fill keeps her
 * Charisma, a re-sync after a level-up keeps it and her own roll edits
 * with Overwrite, Undo takes it back exactly, and Cy's device never
 * receives the block or its record. Another device's change rebuilds an
 * open review, each fetch error shows its words under the prefilled
 * field, a sheet link to another number is a new source, the DM's
 * re-sync runs by keys alone on Bree's page with the toolbar's Undo
 * naming it, and a 46-roll character folds its rolls on a phone.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-six, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 26;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-resync-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const BOUNDS = { w: 20, h: 14 };
/** Bree's D&D Beyond number, and another character's, for the sheet link that moves (rs-9). */
const NUMBER = "12345678";
const OTHER = "87654321";
const SHEET = ddbSheetUrl(NUMBER);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
/** Ana, who plays Bree. */
let anaContext: BrowserContext;
let ana: Page;
/** Cy, another player, who must never receive Bree's block or its record. */
let cyContext: BrowserContext;
let cy: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const cySocket = new SocketWatch("cy");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), cy: new ConsoleWatch("cy") };
/** Every op frame Ana's page sent, so a step can show that Done sent none. */
const anaOps: string[] = [];

const run = {
  roomId: "",
  roomName: `E2E re-sync ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  anaId: "",
  bree: { characterId: randomUUID(), tokenId: randomUUID() },
};

/* Invented D&D Beyond characters, in the service's JSON shape, with only the paths the reader reads (shared/ddb/read.ts). */

type Json = Record<string, unknown>;

const proficiency = (subType: string): Json => ({ type: "proficiency", subType, fixedValue: null, value: null });

function weapon(id: number, name: string, dice: string, damageType: string, attackType: 1 | 2): Json {
  return { equipped: true, definition: { id, name, filterType: "Weapon", damage: { diceString: dice }, damageType, attackType, properties: [] } };
}

/** A prepared cantrip with an attack roll and one damage die that adds the casting modifier. */
function cantrip(name: string, dice: string, type: string): Json {
  return { prepared: true, definition: { name, level: 0, requiresAttackRoll: true, modifiers: [{ type: "damage", subType: type, die: { diceString: dice }, usePrimaryStat: true }] } };
}

const SHORTBOW = weapon(101, "Shortbow", "1d6", "Piercing", 2);
const MOONBEAM: Json = { prepared: true, definition: { name: "Moonbeam", level: 2, requiresSavingThrow: true, saveDcAbilityId: 3, modifiers: [{ type: "damage", subType: "radiant", die: { diceString: "2d10" } }] } };

/**
 * Bree Tallow, a druid: Wisdom her casting ability, Con 14, and with no
 * armor AC 10 plus her Dexterity modifier, 12. Her max HP is the base plus
 * +2 a level: 38 at level 5 from a base of 28.
 */
function bree(o: { id?: number; name?: string; level?: number; scores?: number[]; baseHp?: number; inventory?: Json[]; spells?: Json[]; caster?: number; saves?: string[]; skills?: string[] } = {}): Json {
  return {
    success: true,
    data: {
      id: o.id ?? Number(NUMBER),
      name: o.name ?? "Bree Tallow",
      stats: (o.scores ?? [10, 14, 14, 12, 16, 8]).map((value, i) => ({ id: i + 1, value })),
      bonusStats: [],
      overrideStats: [],
      baseHitPoints: o.baseHp ?? 28,
      race: { weightSpeeds: { normal: { walk: 30 } } },
      classes: [{ level: o.level ?? 5, definition: { name: "Druid", spellCastingAbilityId: o.caster ?? 5 }, classFeatures: [] }],
      modifiers: {
        race: [],
        class: (o.saves ?? ["intelligence", "wisdom"]).map((a) => proficiency(`${a}-saving-throws`)),
        background: (o.skills ?? ["nature", "perception"]).map(proficiency),
        feat: [],
        item: [],
        condition: [],
      },
      inventory: o.inventory ?? [SHORTBOW],
      classSpells: [{ spells: o.spells ?? [cantrip("Shillelagh", "1d8", "bludgeoning")] }],
      spells: { race: [], class: [], item: [], feat: [] },
      actions: { race: [], class: [], feat: [] },
    },
  };
}

/** Fixture A: Bree as the DM typed her, but casting with Wisdom. */
const fixtureA = () => bree();
/** Fixture B: after a level-up, level 6 with Wisdom 18, 45 max HP, Moonbeam learned and Shillelagh's die grown. */
const fixtureB = () => bree({ level: 6, scores: [10, 14, 14, 12, 18, 8], baseHp: 33, spells: [cantrip("Shillelagh", "1d10", "bludgeoning"), MOONBEAM] });
/** Another D&D Beyond character, for a sheet link moved to another number (rs-9). */
const fixtureOther = () =>
  bree({ id: Number(OTHER), name: "Corin Vale", scores: [15, 13, 14, 10, 14, 11], baseHp: 24, saves: ["strength", "dexterity"], skills: ["athletics", "survival"], inventory: [weapon(201, "Longsword", "1d8", "Slashing", 1)], spells: [] });
/** 46 rolls, a Longsword first: the reader keeps 40 and warns of the 6 more (rs-11). */
const fixtureMany = () => bree({ inventory: [weapon(202, "Longsword", "1d8", "Slashing", 1)], spells: Array.from({ length: 45 }, (_, i) => cantrip(`Ember ${i + 1}`, "1d10", "fire")) });

/** The block the DM types for Bree in rs-0: fixture A's numbers and rolls, but Charisma as her casting ability. */
const TYPED: PcStats = {
  abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 16, cha: 8 },
  saves: ["int", "wis"],
  skills: { nature: "prof", perception: "prof" },
  spellAbility: "cha",
  adjust: {},
  defenses: {},
  rolls: [
    { id: "typed-shortbow", name: "Shortbow", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", mod: true, type: "piercing" }] },
    { id: "typed-shillelagh", name: "Shillelagh", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "bludgeoning" }] },
  ],
};

type DdbAnswer = { fixture: () => Json; delayMs?: number } | { status: number; error: string; retryAfterSeconds?: number };

/**
 * A page's D&D Beyond import route, answered here: each request takes the
 * next planned answer, a fixture read fresh, so every read has new roll
 * ids as D&D Beyond's do, or a refusal in the route's own JSON. A request
 * with nothing planned is kept as unexpected, which the last step checks.
 */
class DdbRoute {
  /** The D&D Beyond number each request asked for, in order. */
  readonly numbers: (string | null)[] = [];
  readonly unexpected: string[] = [];
  readonly #answers: DdbAnswer[] = [];

  next(...answers: DdbAnswer[]): void {
    this.#answers.push(...answers);
  }

  last(): string | null | undefined {
    return this.numbers[this.numbers.length - 1];
  }

  async attach(page: Page): Promise<void> {
    await page.route("**/api/rooms/*/ddb-import", async (route) => {
      const link = (route.request().postDataJSON() as { link?: unknown } | null)?.link;
      this.numbers.push(typeof link === "string" ? ddbCharacterId(link) : null);
      const answer = this.#answers.shift();
      try {
        if (!answer) {
          this.unexpected.push(String(link));
          await route.fulfill({ status: 502, json: { error: "fetch_failed" } });
        } else if ("fixture" in answer) {
          if (answer.delayMs) await sleep(answer.delayMs);
          await route.fulfill({ status: 200, json: { fill: readDdbCharacter(answer.fixture()) } });
        } else {
          await route.fulfill({ status: answer.status, headers: answer.retryAfterSeconds ? { "retry-after": String(answer.retryAfterSeconds) } : {}, json: { error: answer.error } });
        }
      } catch {
        // A dialog closed while its answer was delayed aborted the request, and the route can no longer be answered.
      }
    });
  }
}

const anaDdb = new DdbRoute();
const dmDdb = new DdbRoute();

/** A failed import is a failed request, which Chrome logs as an error with the request's address. */
const IMPORT_REFUSED = /Failed to load resource: the server responded with a status of (403|404|429)\b.*\/ddb-import/;

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 20, max: 38, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
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

function breeIn(watch: SocketWatch) {
  return watch.state?.characters[run.bree.characterId];
}

function bar(page: Page): Locator {
  return page.getByRole("dialog", { name: "Bree actions" });
}

function editor(page: Page): Locator {
  return page.getByRole("dialog", { name: "Bree's stat block" });
}

async function reopen(page: Page, size: { width: number; height: number }, scale = 1): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/**
 * Bree's Stat block group with its buttons: from 900 px the Token tab of
 * the side panel, below that the Token sheet, which the bar's Stat block
 * opens with the group open (behind Expand on an upright phone's strip).
 * A panel already showing it is used as it is.
 */
async function breeBlock(page: Page): Promise<Locator> {
  const wide = (page.viewportSize()?.width ?? 0) >= 900;
  const panel = wide ? page.getByRole("tabpanel", { name: "Token" }) : page.getByRole("region", { name: "Token", exact: true });
  const edit = panel.getByRole("button", { name: "Edit", exact: true });
  if ((await edit.count()) > 0 && (await edit.isVisible())) return panel;
  await tapCell(page, BOUNDS, { x: 5, y: 5 });
  await bar(page).waitFor();
  if (wide) await openSideTab(page, "Token");
  else await (await barControl(bar(page), "Stat block")).click();
  await edit.waitFor();
  return panel;
}

/** Opens the re-sync dialog from the Stat block group, and returns the review once it arrives. */
async function openResync(page: Page): Promise<Locator> {
  const panel = await breeBlock(page);
  const button = panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const review = page.getByRole("dialog", { name: "Check what changes" });
  await review.waitFor();
  return review;
}

/** A kept or different row, a group named by its first line. */
function row(scope: Locator, name: string | RegExp): Locator {
  return scope.getByRole("group", { name, exact: typeof name === "string" });
}

/** The review's first line: what was read. */
async function readLine(review: Locator): Promise<string> {
  const line = review.getByText(/^Read from D&D Beyond: /);
  await line.waitFor();
  return (await line.textContent()) ?? "";
}

/** What has focus: its tag and its text or name, trimmed. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: { tagName: string; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
    if (!a) return "none";
    return `${a.tagName.toLowerCase()} ${(a.getAttribute("aria-label") ?? a.textContent ?? "").replace(/\s+/g, " ").trim()}`;
  });
}

/** Tabs forward until `want` has focus, as a keyboard reaches it. */
async function tabTo(page: Page, want: string, back = false): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await focused(page)) === want) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  throw new Error(`Tab never reached ${want}, last on ${await focused(page)}`);
}

/** The Characters panel, in the side panel from 900 px up (characters.e2e.ts openCharacters). */
async function openCharacters(page: Page): Promise<Locator> {
  await openSideTab(page, "Characters");
  return page.getByRole("tabpanel", { name: "Characters" });
}

/** Opens a character's page from its row, unless it is open (characters.e2e.ts openCard). */
async function openCard(panel: Locator, characterId: string): Promise<void> {
  const name = dmSocket.state!.characters[characterId]!.name;
  const heading = panel.locator("[data-creature-heading]");
  if ((await heading.count()) > 0 && (await heading.textContent()) === name) return;
  const back = panel.page().getByRole("button", { name: "Back to Characters" });
  if (await back.isVisible()) await back.click();
  await panel.locator(`[data-opener="character:${characterId}"]`).click();
  await heading.filter({ hasText: name }).waitFor();
}

describe("raccoon-vtt re-sync from d&d beyond", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    dm = await dmContext.newPage();
    anaContext = await browser.newContext({ viewport: DESKTOP });
    ana = await anaContext.newPage();
    cyContext = await browser.newContext({ viewport: DESKTOP });
    cy = await cyContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    consoles.cy.attach(cy);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
    await cySocket.attach(cyContext, cy);
    ana.on("websocket", (ws) => {
      if (!ws.url().includes("/ws?room=")) return;
      ws.on("framesent", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString("utf8");
        try {
          if ((JSON.parse(text) as { t?: unknown }).t === "op") anaOps.push(text);
        } catch {
          // Not JSON, so not an op.
        }
      });
    });
    await anaDdb.attach(ana);
    await dmDdb.attach(dm);
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

  test("rs-0. a DM's room, Ana playing Bree with a typed block that casts with Charisma, a D&D Beyond sheet link and 20 of 38 HP, and Cy", async () => {
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
    await ops.send({ t: "character.update", characterId: run.bree.characterId, patch: { stats: TYPED, level: 5, actor: { sheetUrl: SHEET } } });
    await ops.send({ t: "token.create", token: { id: run.bree.tokenId, sceneId: run.sceneId, kind: "pc", name: "Bree", size: "medium", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree.characterId } } });
    await ana.goto(`${server.origin}/r/${run.roomId}`);
    await cy.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Ana's snapshot", () => anaSocket.state);
    await waitFor("Cy's snapshot", () => cySocket.state);
    await ana.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    const bree = await waitFor("Bree's typed block in Ana's view", () => breeIn(anaSocket)?.stats ?? null);
    assert.equal(bree.spellAbility, "cha");
    assert.deepEqual(breeIn(anaSocket)!.actor.hp, { cur: 20, max: 38, temp: 0 });
    assert.equal(breeIn(anaSocket)!.ddbSync, undefined, "no record before the first sync");
  });

  test("rs-1. at 390 x 844 the editor's D&D Beyond step reads fixture A as Check what was read, lists Charisma under Replaces your changes, keeps it and the typed AC, and Last synced shows after Save", async () => {
    await reopen(ana, PHONE);
    const panel = await breeBlock(ana);
    assert.equal(await panel.getByText(/^Last synced from D&D Beyond/).count(), 0, "no line before a sync");
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = editor(ana);
    await sheet.waitFor();
    anaDdb.next({ fixture: fixtureA });
    await sheet.getByRole("button", { name: "D&D Beyond" }).click();
    const step = ana.getByRole("dialog", { name: "D&D Beyond" });
    assert.equal(await step.getByLabel("Share link or character number").inputValue(), SHEET, "the field starts with the sheet link");
    await step.getByRole("button", { name: "Get it", exact: true }).click();
    const review = ana.getByRole("dialog", { name: "Check what was read" });
    assert.equal(await readLine(review), "Read from D&D Beyond: Bree Tallow, level 5.");
    assert.equal(anaDdb.last(), NUMBER);
    // Its header's Back says where it goes, as the re-sync's review does (docs/design-v1-look-pass-2.md 3, lane 3).
    await review.getByRole("button", { name: "Back to the D&D Beyond link", exact: true }).waitFor();
    // With no record the editor fills, and lists each value of the block it would replace.
    await review.getByRole("heading", { name: "Replaces your changes (1)", exact: true }).waitFor();
    const spell = row(review, "Spellcasting ability: Charisma, becomes Wisdom");
    const keep = spell.getByRole("checkbox", { name: "Keep mine", exact: true });
    assert.equal(await keep.isChecked(), false, "Keep mine starts unticked");
    await keep.check();
    const ac = review.getByRole("checkbox", { name: "AC 12, now 15", exact: true });
    assert.equal(await ac.isChecked(), true, "the AC line starts ticked");
    await review.getByText("Worked out from the armor. Check it.", { exact: true }).waitFor();
    await ac.uncheck();
    assert.equal(await review.getByRole("checkbox", { name: "Name Bree Tallow, now Bree", exact: true }).isChecked(), false, "the name starts off");
    // The review in line (e2e/helpers/alignment.ts), checked once the step is done so a drift fails only this step.
    const aligned = alignmentLines(await measureAlignment(review), "the editor's review at 390 x 844");
    await shots.take(ana, "resync-editor-review-390");
    await review.getByRole("button", { name: "Use it", exact: true }).click();
    await editor(ana).getByRole("button", { name: "Save", exact: true }).click();
    await editor(ana).waitFor({ state: "detached" });
    const record = await waitFor("Bree's sync record", () => breeIn(anaSocket)?.ddbSync ?? null);
    assert.equal(record.from, NUMBER);
    assert.equal(record.base.spellAbility, "wis", "the base is what D&D Beyond said");
    assert.equal(record.base.ac, 12);
    assert.equal(Object.keys(record.rolls).length, 2, "the typed Shortbow and Shillelagh are linked by name");
    assert.equal(breeIn(anaSocket)!.stats!.spellAbility, "cha", "Keep mine kept Charisma");
    assert.equal(breeIn(anaSocket)!.actor.ac, 15, "the unticked AC stays");
    await panel.getByText(/^Last synced from D&D Beyond on [A-Z][a-z]{2} \d{1,2}\.$/).waitFor();
    await shots.take(ana, "resync-last-synced-390");
    assert.deepEqual(aligned, [], "the editor's review is out of line");
  });

  test("rs-2. Ana deletes Shortbow and edits Shillelagh in the editor, then saves", async () => {
    await reopen(ana, DESKTOP);
    const panel = await breeBlock(ana);
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = editor(ana);
    await sheet.waitFor();
    await sheet.getByRole("button", { name: /^Shortbow/ }).click();
    await sheet.getByRole("button", { name: "Remove Shortbow", exact: true }).click();
    await sheet.getByRole("button", { name: /^Shillelagh/ }).click();
    const bonus = sheet.getByLabel("Other bonus", { exact: true });
    await bonus.fill("1");
    await bonus.press("Tab");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    const rolls = await waitFor("Ana's roll edits saved", () => {
      const r = breeIn(anaSocket)?.stats?.rolls;
      return r && r.length === 1 && r[0]!.attack?.bonus === 1 ? r : null;
    });
    assert.equal(rolls[0]!.name, "Shillelagh");
    assert.ok(breeIn(anaSocket)!.ddbSync, "a plain Save keeps the record");
  });

  test("rs-3. fixture B, after a level-up: Re-sync shows the loading line, then Changes, the ticked Level and Max HP lines and Ana's four kept changes", async () => {
    const panel = await breeBlock(ana);
    anaDdb.next({ fixture: fixtureB, delayMs: 700 });
    await panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true }).click();
    const fetching = ana.getByRole("dialog", { name: "Re-sync Bree" });
    await fetching.getByText("Getting Bree from D&D Beyond…", { exact: true }).waitFor();
    assert.equal(await fetching.getByRole("button", { name: "Getting it…", exact: true }).count(), 1, "the primary is busy");
    await shots.take(ana, "resync-fetching");
    const review = ana.getByRole("dialog", { name: "Check what changes" });
    await review.waitFor();
    assert.match(await readLine(review), /^Read from D&D Beyond: Bree Tallow, level 6\. Last synced on [A-Z][a-z]{2} \d{1,2}\.$/);
    assert.equal(anaDdb.last(), NUMBER, "the sheet link's number is fetched");
    await review.getByRole("heading", { name: "Changes from D&D Beyond (2)", exact: true }).waitFor();
    await review.getByText("Wisdom 18, now 16", { exact: true }).waitFor();
    await review.getByText(/^Adds Moonbeam \(level 2\): /).waitFor();
    assert.equal(await review.getByRole("checkbox", { name: "Level 6, now 5", exact: true }).isChecked(), true);
    assert.equal(await review.getByRole("checkbox", { name: "Max HP 45, now 38", exact: true }).isChecked(), true);
    await review.getByText("Bree keeps 20 HP, now out of 45.", { exact: true }).waitFor();
    await review.getByRole("heading", { name: "Your changes, kept (4)", exact: true }).waitFor();
    // Conflicts first, then the groups in Changes' order: Spellcasting, then Features (AC), then Rolls.
    const kept = await review.locator("[data-sync-row]").evaluateAll((els) => els.map((el) => el.querySelector("p")?.textContent ?? ""));
    assert.equal(kept.length, 4, `kept rows: ${JSON.stringify(kept)}`);
    assert.match(kept[0]!, /^Shillelagh \(cantrip\), as you changed it: /);
    assert.deepEqual(kept.slice(1), ["Spellcasting ability: Charisma", "AC 15", "Shortbow: you removed it."]);
    const shillelagh = row(review, /^Shillelagh \(cantrip\), as you changed it: /);
    await shillelagh.getByText("Also changed in D&D Beyond", { exact: true }).waitFor();
    assert.equal(await shillelagh.getByRole("checkbox", { name: "Overwrite with D&D Beyond's", exact: true }).isChecked(), false);
    await row(review, "Spellcasting ability: Charisma").getByText("D&D Beyond says Wisdom.", { exact: true }).waitFor();
    assert.equal(await row(review, "Spellcasting ability: Charisma").getByRole("checkbox", { name: "Overwrite with Wisdom", exact: true }).isChecked(), false);
    await row(review, "AC 15").getByText("D&D Beyond says 12.", { exact: true }).waitFor();
    await row(review, "Shortbow: you removed it.").getByRole("checkbox", { name: "Add it back", exact: true }).waitFor();
    await shots.take(ana, "resync-review");
    assert.deepEqual(alignmentLines(await measureAlignment(review), "the re-sync review at 1280 x 800"), [], "the re-sync review is out of line");
  });

  test("rs-4. Apply shows the done line, the panel and the DM's device show level 6 and Charisma, and Cy's device has neither the block nor the record", async () => {
    const review = ana.getByRole("dialog", { name: "Check what changes" });
    await review.getByRole("button", { name: "Apply", exact: true }).click();
    const done = ana.getByRole("dialog", { name: "Bree is re-synced" });
    const line = done.getByRole("status").filter({ hasText: "4 changes came in, and 5 of your changes stayed." });
    await line.waitFor();
    // A plain status line: the check mark means chosen, never done (docs/design-v1-look-pass-2.md 2.3).
    assert.equal(await line.locator("svg").count(), 0, "the done line wears the check");
    await shots.take(ana, "resync-done");
    const bree = await waitFor("level 6 in Ana's view", () => (breeIn(anaSocket)?.level === 6 ? breeIn(anaSocket)! : null));
    assert.equal(bree.stats!.spellAbility, "cha");
    assert.equal(bree.stats!.abilities.wis, 18);
    assert.deepEqual([bree.actor.hp.cur, bree.actor.hp.max], [20, 45], "a hurt Bree keeps her HP under the new maximum");
    const panel = ana.getByRole("tabpanel", { name: "Token" });
    await panel.getByText(/Level 6 character/).first().waitFor();
    await panel.locator("[data-pc-stats]").getByText(/^Spellcasting Charisma, save DC \d+, attack [+−-]\d+$/).waitFor();

    await waitFor("level 6 on the DM's device", () => (breeIn(dmSocket)?.level === 6 ? true : null));
    assert.equal(breeIn(dmSocket)!.stats!.spellAbility, "cha");
    await tapCell(dm, BOUNDS, { x: 5, y: 5 });
    await bar(dm).waitFor();
    await openSideTab(dm, "Token");
    const dmPanel = dm.getByRole("tabpanel", { name: "Token" });
    await dmPanel.getByText(/Level 6 character/).first().waitFor();
    await dmPanel.locator("[data-pc-stats]").getByText(/^Spellcasting Charisma, save DC \d+/).waitFor();

    await waitFor("Cy's view of Bree", () => breeIn(cySocket) ?? null);
    assert.equal("stats" in breeIn(cySocket)!, false, "Cy's device never receives the block");
    assert.equal("ddbSync" in breeIn(cySocket)!, false, "Cy's device never receives the record");
    assert.equal(cySocket.everSaw("ddbSync"), false, "no frame to Cy names the record");
  });

  test("rs-5. Undo the re-sync gives back level 5, Wisdom 16 and 20 of 38 HP", async () => {
    const done = ana.getByRole("dialog", { name: "Bree is re-synced" });
    await done.getByRole("button", { name: "Undo the re-sync", exact: true }).click();
    const undone = ana.getByRole("dialog", { name: "Re-sync undone" });
    await undone.getByText("Bree is as before the re-sync.", { exact: true }).waitFor();
    const bree = await waitFor("level 5 again", () => (breeIn(anaSocket)?.level === 5 ? breeIn(anaSocket)! : null));
    assert.equal(bree.stats!.abilities.wis, 16);
    assert.deepEqual([bree.actor.hp.cur, bree.actor.hp.max], [20, 38], "the exact HP from before");
    assert.equal(bree.stats!.rolls.some((r) => r.name === "Moonbeam"), false);
    await shots.take(ana, "resync-undone");
    await undone.getByRole("button", { name: "Done", exact: true }).click();
    await undone.waitFor({ state: "detached" });
  });

  test("rs-6. Overwrite all with Level unticked brings back Wisdom and Shortbow at level 5, and a re-sync right after lists Level as kept, has nothing new and offers only Done, which sends nothing", async () => {
    anaDdb.next({ fixture: fixtureB });
    let review = await openResync(ana);
    const all = review.getByRole("button", { name: "Overwrite all", exact: true });
    assert.equal(await all.getAttribute("aria-pressed"), "false");
    await all.click();
    assert.equal(await all.getAttribute("aria-pressed"), "true", "pressed while every kept row is ticked");
    await review.getByRole("checkbox", { name: "Level 6, now 5", exact: true }).uncheck();
    await review.getByRole("button", { name: "Apply", exact: true }).click();
    let done = ana.getByRole("dialog", { name: "Bree is re-synced" });
    await done.getByRole("status").filter({ hasText: "6 changes came in, 1 roll came back, and 2 of your changes stayed." }).waitFor();
    const bree = await waitFor("Wisdom casting again", () => (breeIn(anaSocket)?.stats?.spellAbility === "wis" ? breeIn(anaSocket)! : null));
    assert.equal(bree.level, 5, "the unticked level stays");
    assert.deepEqual(bree.stats!.rolls.map((r) => r.name), ["Shillelagh", "Shortbow", "Moonbeam"]);
    assert.equal(bree.actor.ac, 12, "AC overwritten");
    await done.getByRole("button", { name: "Done", exact: true }).click();
    await done.waitFor({ state: "detached" });

    anaDdb.next({ fixture: fixtureB });
    review = await openResync(ana);
    await review.getByText("Nothing new from D&D Beyond.", { exact: true }).waitFor();
    await review.getByRole("heading", { name: "Your changes, kept (1)", exact: true }).waitFor();
    const level = row(review, "Level 5");
    await level.getByText("D&D Beyond says 6.", { exact: true }).waitFor();
    assert.equal(await review.getByRole("button", { name: "Cancel", exact: true }).count(), 0, "Cancel goes");
    assert.equal(await review.getByRole("button", { name: "Apply", exact: true }).count(), 0);
    // A tick makes it Apply, and taking it back makes it Done again.
    await level.getByRole("checkbox", { name: "Overwrite with level 6", exact: true }).check();
    await review.getByRole("button", { name: "Apply", exact: true }).waitFor();
    await level.getByRole("checkbox", { name: "Overwrite with level 6", exact: true }).uncheck();
    await shots.take(ana, "resync-nothing-new");
    const sent = anaOps.length;
    const before = JSON.stringify(breeIn(anaSocket));
    await review.getByRole("button", { name: "Done", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await sleep(500);
    assert.equal(anaOps.length, sent, "Done sent no op");
    assert.equal(JSON.stringify(breeIn(anaSocket)), before, "Bree did not change");
    done = ana.getByRole("dialog", { name: "Bree is re-synced" });
    assert.equal(await done.count(), 0);
  });

  test("rs-7. the DM changes Bree's AC while Ana's review is open: the status says Bree changed, and the AC row updates", async () => {
    anaDdb.next({ fixture: fixtureB });
    const review = await openResync(ana);
    await row(review, "Level 5").waitFor();
    assert.equal(await review.getByRole("group", { name: /^AC / }).count(), 0, "AC is D&D Beyond's, so no row");
    await ops.send({ t: "character.update", characterId: run.bree.characterId, patch: { actor: { ac: 16 } } });
    await review.getByText("Bree changed on another device. The lists show the latest.", { exact: true }).waitFor();
    await row(review, "AC 16").getByText("D&D Beyond says 12.", { exact: true }).waitFor();
    await ops.send({ t: "character.update", characterId: run.bree.characterId, patch: { actor: { ac: 17 } } });
    await row(review, "AC 17").waitFor();
    assert.equal(await row(review, "AC 16").count(), 0, "the row follows the latest AC");
    await shots.take(ana, "resync-live-change");
    // Nothing is ticked and nothing new came, so Done is the one button.
    await review.getByRole("button", { name: "Done", exact: true }).click();
    await review.waitFor({ state: "detached" });
  });

  test("rs-8. each fetch error shows its words under the prefilled field: private, then pasted JSON reaching the review, then busy and quota_member", async () => {
    consoles.ana.allow = [IMPORT_REFUSED];
    anaDdb.next({ status: 403, error: "private" });
    const panel = await breeBlock(ana);
    await panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true }).click();
    const dialog = ana.getByRole("dialog", { name: "Re-sync Bree" });
    const field = dialog.getByLabel("Share link or character number");
    await dialog.getByRole("alert").getByText("D&D Beyond would not share that character. Set its privacy to Public in D&D Beyond, then try again, or paste its JSON.", { exact: true }).waitFor();
    assert.equal(await field.inputValue(), SHEET, "the field holds the link fetched");
    const below = async (words: string) => {
      const alert = dialog.getByRole("alert").filter({ hasText: words });
      await alert.waitFor();
      assert.ok((await alert.boundingBox())!.y > (await field.boundingBox())!.y, "the error sits under the field");
    };
    await below("D&D Beyond would not share that character.");
    await shots.take(ana, "resync-private");

    await dialog.getByRole("button", { name: "Paste its JSON instead", exact: true }).click();
    await dialog.locator("textarea").fill(JSON.stringify(fixtureB()));
    // With the JSON box open, the footer's Get it stays the one primary, and Read it is secondary (docs/design-v1-look-pass-2.md 2.2).
    const looks = await dialog.getByRole("button").evaluateAll((buttons) =>
      buttons.map((b) => {
        const el = b as unknown as { textContent: string | null };
        const view = (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(b);
        return { text: (el.textContent ?? "").trim(), background: view.backgroundColor };
      }),
    );
    const primary = looks.find((l) => l.text === "Get it")?.background;
    assert.ok(primary);
    assert.deepEqual(looks.filter((l) => l.background === primary).map((l) => l.text), ["Get it"], "one primary in the step");
    await dialog.getByRole("button", { name: "Read it", exact: true }).click();
    const review = ana.getByRole("dialog", { name: "Check what changes" });
    assert.match(await readLine(review), /^Read from D&D Beyond: Bree Tallow, level 6\./);
    await row(review, "Level 5").waitFor();
    await review.getByRole("button", { name: "Back to the D&D Beyond link", exact: true }).click();

    anaDdb.next({ status: 429, error: "busy" });
    await dialog.getByRole("button", { name: "Get it", exact: true }).click();
    await below("Another import is running. Try again in a moment, or paste the character's JSON.");
    anaDdb.next({ status: 429, error: "quota_member", retryAfterSeconds: 720 });
    await dialog.getByRole("button", { name: "Get it", exact: true }).click();
    await below("Too many imports this hour. Try again in 12 minutes, or paste the character's JSON.");
    assert.equal(await field.inputValue(), SHEET);
    await shots.take(ana, "resync-quota");
    assert.deepEqual(anaDdb.numbers.slice(-3), [NUMBER, NUMBER, NUMBER]);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  });

  test("rs-9. a sheet link moved to another number is a new source whose Take these ticks a group, and a number typed after not_found offers the sheet link, which the next Re-sync fetches three ways", async () => {
    await ops.send({ t: "character.update", characterId: run.bree.characterId, patch: { actor: { sheetUrl: ddbSheetUrl(OTHER) } } });
    await waitFor("the moved sheet link", () => (breeIn(anaSocket)?.actor.sheetUrl === ddbSheetUrl(OTHER) ? true : null));
    anaDdb.next({ fixture: fixtureOther });
    let review = await openResync(ana);
    assert.equal(anaDdb.last(), OTHER, "Re-sync fetches what the sheet link names");
    assert.equal(await readLine(review), "Read from D&D Beyond: Corin Vale, level 5. This is a different character from the last sync, so nothing is compared with it.");
    await review.getByText("This is a different D&D Beyond character from the last sync, so a change of yours cannot be told from one there. What differs stays as it is unless you overwrite it.", { exact: true }).waitFor();
    const take = review.getByRole("button", { name: "Take these: Ability scores", exact: true });
    assert.equal(await take.getAttribute("aria-pressed"), "false");
    await take.click();
    assert.equal(await take.getAttribute("aria-pressed"), "true");
    assert.equal(await review.getByRole("button", { name: "Take these: Saves and skills", exact: true }).getAttribute("aria-pressed"), "false", "another group stays as it was");
    // Past 10 rows every group starts folded, so the scores open to show their ticks.
    const scores = review.getByRole("button", { name: "Ability scores", exact: true });
    if ((await scores.getAttribute("aria-expanded")) === "false") await scores.click();
    const ticks = review.locator('[data-sync-row^="field:abilities."]').getByRole("checkbox");
    assert.ok((await ticks.count()) >= 4, "the scores that differ are listed");
    assert.deepEqual([...new Set(await ticks.evaluateAll((els) => els.map((el) => (el as unknown as { checked: boolean }).checked)))], [true], "every score in the group is ticked");
    await shots.take(ana, "resync-relinked");
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await review.waitFor({ state: "detached" });

    consoles.ana.allow = [IMPORT_REFUSED];
    anaDdb.next({ status: 404, error: "not_found" });
    const panel = await breeBlock(ana);
    await panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true }).click();
    const dialog = ana.getByRole("dialog", { name: "Re-sync Bree" });
    await dialog.getByRole("alert").getByText("D&D Beyond has no character with that number.", { exact: true }).waitFor();
    const field = dialog.getByLabel("Share link or character number");
    assert.equal(await field.inputValue(), ddbSheetUrl(OTHER));
    await field.fill(NUMBER);
    anaDdb.next({ fixture: fixtureB });
    await dialog.getByRole("button", { name: "Get it", exact: true }).click();
    review = ana.getByRole("dialog", { name: "Check what changes" });
    assert.match(await readLine(review), /^Read from D&D Beyond: Bree Tallow, level 6\. Last synced on /, "the record's number, so three ways");
    assert.equal(anaDdb.last(), NUMBER, "the number typed is fetched");
    const sheetLine = review.getByRole("checkbox", { name: `Sheet link ${SHEET}, now ${ddbSheetUrl(OTHER)}`, exact: true });
    assert.equal(await sheetLine.isChecked(), true, "the sheet link line starts ticked");
    await review.getByText("So the next re-sync gets this character.", { exact: true }).waitFor();
    await shots.take(ana, "resync-sheet-link");
    await review.getByRole("button", { name: "Apply", exact: true }).click();
    const done = ana.getByRole("dialog", { name: "Bree is re-synced" });
    await done.getByRole("status").waitFor();
    await waitFor("the sheet link back on Bree's number", () => (breeIn(anaSocket)?.actor.sheetUrl === SHEET ? true : null));
    await done.getByRole("button", { name: "Done", exact: true }).click();
    await done.waitFor({ state: "detached" });
    consoles.ana.allow = [];

    anaDdb.next({ fixture: fixtureB });
    review = await openResync(ana);
    assert.equal(anaDdb.last(), NUMBER, "the next Re-sync fetches that number");
    assert.match(await readLine(review), /^Read from D&D Beyond: Bree Tallow, level 6\. Last synced on [A-Z][a-z]{2} \d{1,2}\.$/);
    assert.equal(await review.getByText(/^This is a different/).count(), 0);
    await row(review, "Level 5").waitFor();
    await review.getByRole("button", { name: "Done", exact: true }).click();
    await review.waitFor({ state: "detached" });
  });

  test("rs-10. the DM at 1440 x 900 on Bree's page, by keys alone: focus moves to the review's first line, Overwrite all reports aria-pressed, Apply by Enter keeps focus on the primary, Escape returns it to Re-sync, and the toolbar's Undo names the re-sync and the dialog's Undo", async () => {
    await reopen(dm, { width: 1440, height: 900 });
    const panel = await openCharacters(dm);
    await openCard(panel, run.bree.characterId);
    const resync = panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true });
    const toolbarUndo = dm.locator("header:has(h1)").first().getByRole("button", { name: "Undo", exact: true });

    /** Re-sync by Enter, Overwrite all by Space, and Apply by Enter, leaving the done state open. */
    const syncByKeys = async () => {
      dmDdb.next({ fixture: fixtureB, delayMs: 700 });
      await resync.focus();
      await dm.keyboard.press("Enter");
      const review = dm.getByRole("dialog", { name: "Check what changes" });
      await review.waitFor();
      await waitFor("focus on the review's first line", async () => ((await focused(dm)).startsWith("p Read from D&D Beyond: Bree Tallow, level 6.") ? true : null));
      await tabTo(dm, "button Overwrite all");
      await dm.keyboard.press("Space");
      assert.equal(await review.getByRole("button", { name: "Overwrite all", exact: true }).getAttribute("aria-pressed"), "true");
      await tabTo(dm, "button Apply");
      await dm.keyboard.press("Enter");
      const done = dm.getByRole("dialog", { name: "Bree is re-synced" });
      await done.getByRole("status").filter({ hasText: /came in/ }).waitFor();
      return done;
    };

    let done = await syncByKeys();
    assert.equal(await focused(dm), "button Done", "focus stays on the surviving primary");
    await shots.take(dm, "resync-dm-done-1440");
    await dm.keyboard.press("Escape");
    await done.waitFor({ state: "detached" });
    await waitFor("focus back on Re-sync", async () => ((await focused(dm)) === "button Re-sync from D&D Beyond" ? true : null));
    assert.equal(breeIn(dmSocket)!.level, 6);
    await toolbarUndo.focus();
    await dm.keyboard.press("Enter");
    await dm.getByText("Undid re-syncing Bree from D&D Beyond.", { exact: true }).first().waitFor();
    await waitFor("the toolbar's Undo took the re-sync back", () => (breeIn(dmSocket)?.level === 5 && breeIn(dmSocket)?.actor.ac === 17 ? true : null));

    done = await syncByKeys();
    await tabTo(dm, "button Undo the re-sync", true);
    await dm.keyboard.press("Enter");
    const undone = dm.getByRole("dialog", { name: "Re-sync undone" });
    await undone.getByText("Bree is as before the re-sync.", { exact: true }).waitFor();
    await waitFor("the dialog's Undo took it back", () => (breeIn(dmSocket)?.level === 5 && breeIn(dmSocket)?.actor.ac === 17 ? true : null));
    await dm.keyboard.press("Escape");
    await undone.waitFor({ state: "detached" });
    await waitFor("focus back on Re-sync", async () => ((await focused(dm)) === "button Re-sync from D&D Beyond" ? true : null));
    await toolbarUndo.focus();
    await dm.keyboard.press("Enter");
    await dm.getByText("Undid undoing Bree's re-sync.", { exact: true }).first().waitFor();
    await waitFor("the re-sync back", () => (breeIn(dmSocket)?.level === 6 ? true : null));
    await reopen(dm, DESKTOP);
  });

  test("rs-11. a 46-roll character at 360 x 780, at 390 x 844 at 130% and at 844 x 390: no sideways scroll, the cut warning, Rolls folded as 40 additions, h3 only for the sections, and Apply in view", async () => {
    // A fresh start at fixture A's level with no record and no rolls, so all 40 rolls read come in as additions and nothing reads as a loss.
    await ops.send({ t: "character.update", characterId: run.bree.characterId, patch: { level: 5, stats: { rolls: [] }, ddbSync: null } });
    await waitFor("Bree with no rolls or record", () => (breeIn(anaSocket)?.stats?.rolls.length === 0 && breeIn(anaSocket)?.ddbSync === undefined && breeIn(anaSocket)?.level === 5 ? true : null));
    const aligned: string[] = [];
    const sizes = [
      { size: { width: 360, height: 780 }, scale: 1, shot: "resync-46-360" },
      { size: PHONE, scale: 1.3, shot: "resync-46-390-130" },
      { size: { width: 844, height: 390 }, scale: 1, shot: "resync-46-844" },
    ];
    for (const { size, scale, shot } of sizes) {
      const at = `${size.width} x ${size.height} at ${scale * 100}%`;
      await reopen(ana, size, scale);
      anaDdb.next({ fixture: fixtureMany });
      const review = await openResync(ana);
      await review.getByText("D&D Beyond has 6 more rolls for Bree Tallow than the 40 that are read, so those were not read. Rolls here that they would change stay as they are.", { exact: true }).waitFor();
      const rolls = review.getByRole("button", { name: "Rolls", exact: true });
      assert.equal(await rolls.getAttribute("aria-expanded"), "false", `${at}: Rolls starts folded`);
      const summary = await rolls.evaluate((el) => el.ownerDocument.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
      assert.equal(summary, "40: Adds Longsword, and 39 more", `${at}: the summary describes the row`);
      const headings = await review.evaluate((dialog) => [...dialog.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")].map((h) => `${h.tagName.toLowerCase()} ${(h.textContent ?? "").trim()}`));
      assert.deepEqual(headings.filter((h) => !h.startsWith("h3 ")), ["h2 Check what changes"], `${at}: the title and the sections' h3s are the only headings: ${JSON.stringify(headings)}`);
      for (const h of headings.filter((x) => x.startsWith("h3 "))) {
        assert.match(h, /^h3 (Check these|Changes from D&D Beyond( \(\d+\))?|Also set|Your changes, kept \(\d+\)|Different from D&D Beyond \(\d+\))$/, `${at}: ${h} is a section`);
      }
      const sideways = await review.evaluate((dialog) => {
        const doc = dialog.ownerDocument;
        const page = doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
        const scrollers = [...dialog.querySelectorAll("*")].filter((el) => el.scrollWidth - el.clientWidth > 1 && ["auto", "scroll"].includes(doc.defaultView.getComputedStyle(el).overflowX)).map((el) => `${el.tagName} ${el.scrollWidth} > ${el.clientWidth}`);
        const past = [...dialog.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > doc.documentElement.clientWidth + 1).map((el) => `${el.tagName} ${(el.textContent ?? "").slice(0, 40)}`);
        return { page, scrollers, past: past.slice(0, 5) };
      });
      assert.deepEqual(sideways, { page: 0, scrollers: [], past: [] }, `${at}: nothing scrolls sideways`);
      assert.ok(await wholeInReach(review.getByRole("button", { name: "Apply", exact: true })), `${at}: Apply in view`);
      aligned.push(...alignmentLines(await measureAlignment(review), `the 46-roll review at ${at}`));
      await shots.take(ana, shot);
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await review.waitFor({ state: "detached" });
    }
    await reopen(ana, DESKTOP, 1);
    assert.deepEqual(aligned, [], "the 46-roll review is out of line");
  });

  test("lp14-rs-a. the DM takes Bree from Ana while her re-sync review, then her editor's D&D Beyond review, is open: each keeps its review, says Bree is no longer hers, the re-sync review rebuilds when she comes back, and the room stays up", async () => {
    const crashed = ana.getByText("Something went wrong in the room.", { exact: true });
    const playedBy = (ownerIds: string[]) => ops.send({ t: "character.update", characterId: run.bree.characterId, patch: { ownerIds } });
    // A new Speed, so the review has a Speed line, which reads the actor's speeds that another player's copy lacks.
    const faster = () => {
      const json = fixtureB() as { data: Json };
      json.data.race = { weightSpeeds: { normal: { walk: 35 } } };
      return json;
    };
    anaDdb.next({ fixture: faster });
    const review = await openResync(ana);
    await review.getByRole("checkbox", { name: "Speed 35 ft, now 30 ft", exact: true }).waitFor();
    await playedBy([]);
    await review.getByText("This character was deleted or is no longer yours, so it cannot be re-synced.", { exact: true }).waitFor();
    assert.equal(await crashed.count(), 0, "the room stays up");
    assert.equal(await review.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true, "Apply is off");
    // Given back while the review is open, Bree is reviewed from her fresh copy again.
    await playedBy([run.anaId]);
    await review.getByText("Bree changed on another device. The lists show the latest.", { exact: true }).waitFor();
    assert.equal(await review.getByText("This character was deleted or is no longer yours, so it cannot be re-synced.", { exact: true }).count(), 0, "the notice goes");
    assert.equal(await review.getByRole("button", { name: "Apply", exact: true }).isEnabled(), true, "Apply is on again");
    await review.getByRole("checkbox", { name: "Speed 35 ft, now 30 ft", exact: true }).waitFor();
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await waitFor("Bree's block back in Ana's view", () => breeIn(anaSocket)?.stats ?? null);

    const panel = await breeBlock(ana);
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const sheet = editor(ana);
    await sheet.waitFor();
    anaDdb.next({ fixture: faster });
    await sheet.getByRole("button", { name: "D&D Beyond", exact: true }).click();
    await ana.getByRole("dialog", { name: "D&D Beyond" }).getByRole("button", { name: "Get it", exact: true }).click();
    const read = ana.getByRole("dialog", { name: "Check what was read" });
    await read.getByText(/^Read from D&D Beyond: Bree Tallow, level 6\./).waitFor();
    await playedBy([]);
    await waitFor("Bree's block gone from Ana's view", () => (breeIn(anaSocket) && breeIn(anaSocket)!.stats === undefined ? true : null));
    await sleep(300);
    assert.equal(await crashed.count(), 0, "the room stays up");
    // The review reads against Bree as Ana last saw her, and the editor then says it cannot save.
    await read.getByText(/^Read from D&D Beyond: Bree Tallow, level 6\./).waitFor();
    await read.getByRole("button", { name: "Use it", exact: true }).click();
    await sheet.getByText("This stat block was deleted or is no longer yours, so it cannot be saved.", { exact: true }).waitFor();
    await shots.take(ana, "resync-lp14-taken");
    await playedBy([run.anaId]);
    await waitFor("Bree's block back in Ana's view", () => breeIn(anaSocket)?.stats ?? null);
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = ana.getByRole("button", { name: /^Discard/ });
    if (await discard.count()) await discard.first().click();
    await sheet.waitFor({ state: "detached" });
  });

  test("rs-12. no page logged an error, and every import request was planned", () => {
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    assert.deepEqual(consoles.ana.errors, [], "Ana's page logged errors");
    assert.deepEqual(consoles.cy.errors, [], "Cy's page logged errors");
    assert.deepEqual([...anaDdb.unexpected, ...dmDdb.unexpected], [], "an import request nothing planned for");
  });
});
