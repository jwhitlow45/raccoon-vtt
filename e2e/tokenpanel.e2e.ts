import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The token panel, the stat summary and AC on tokens
 * (docs/design-v1-token-panel.md section 7) on the real server serving the
 * production build: the bar's summary and its two rows of buttons, "Stat
 * block" opening the block in the panel beside the bar, Escape after it,
 * the panel's order and folds and what this device remembers of them, the
 * compact image and HP rows, the AC shield on the map, no horizontal
 * overflow for the longest stats, the short bar on a phone held sideways,
 * and what a player's device shows and holds.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus ten. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 *
 * The very short sideways sheet (docs/design-v1-layout-hierarchy.md 4.2)
 * is checked at 480 x 320 at 130%, where it always applies (steps 5 and
 * 7c). With the turn band it applies at larger sizes only where the strip
 * cannot stay in the top bar, which that design's own e2e reaches.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 10;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-tokenpanel-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const FOLDS_KEY = "rvtt.tokenPanelFolds";
const BOUNDS = { w: 16, h: 10 };
const ICON = { icon: "lorc/wolf-head", color: "#336699" };
const SHEET = "https://www.dndbeyond.com/characters/1";
/** A room monster's Immunities as long as a DM may type, to clamp in the bar. */
const LONG_IMMUNITIES = `Poison, Psychic; ${Array.from({ length: 30 }, (_, i) => `Charmed by the ${i + 1}th moon`).join(", ")}`.slice(0, 480);

type Insets = { side?: number; bottom?: number };
type View = { width: number; height: number; scale: number; insets?: Insets };
const DESK: View = { width: 1280, height: 800, scale: 1 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const cell = (x: number, y: number) => ({ x, y });
const run = {
  roomId: "",
  roomName: `E2E token panel ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID(), at: cell(0, 1) },
  bear: { id: randomUUID(), at: cell(2, 1) },
  bree: { id: randomUUID(), characterId: randomUUID(), at: cell(4, 1) },
  dragon: { id: randomUUID(), at: cell(6, 1) },
  goblin: { id: randomUUID(), at: cell(0, 4) },
  bog: { id: randomUUID(), monsterId: randomUUID(), at: cell(2, 4) },
  swift: { id: randomUUID(), at: cell(4, 4) },
  soft: { id: randomUUID(), at: cell(0, 7) },
  villager: { id: randomUUID(), at: cell(2, 7) },
  chest: { id: randomUUID(), at: cell(4, 7) },
  ogre: { id: randomUUID(), at: cell(6, 6) },
  /** Linked to a room monster deleted since. */
  mire: { id: randomUUID(), monsterId: randomUUID(), at: cell(8, 4) },
  /** At 0 of 0 HP, like Spiritual Weapon: HP-less. */
  weapon: { id: randomUUID(), at: cell(8, 8) },
  /** A name of 80 characters. */
  herald: { id: randomUUID(), at: cell(0, 9), name: "Herald of the Ninefold Crown and Keeper of the Long Night's Unbroken Silver Seal".slice(0, 80) },
};

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

/** A homebrew monster written for this run, so no book's text is in the repository. */
function bogThing(id: string) {
  const a = (score: number, save: number) => ({ score, save });
  return {
    id,
    name: "Bog Thing",
    size: "medium",
    type: "Plant",
    alignment: "Unaligned",
    ac: 13,
    initiative: 0,
    hp: { average: 30, formula: "4d8 + 12" },
    speed: "20 ft., Swim 20 ft.",
    abilities: { str: a(16, 3), dex: a(8, -1), con: a(16, 3), int: a(4, -3), wis: a(10, 0), cha: a(5, -3) },
    skills: "",
    vulnerabilities: "Fire",
    resistances: "",
    immunities: LONG_IMMUNITIES,
    gear: "",
    senses: "Blindsight 30 ft.",
    passivePerception: 10,
    languages: "None",
    cr: "2",
    xp: 450,
    traits: [{ name: "Peat Body", text: "The bog thing smells of a swamp in late summer." }],
    actions: [{ name: "Slam", text: "Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d8 + 3) Bludgeoning damage." }],
    bonusActions: [],
    reactions: [],
    legendaryActions: [],
  };
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type El = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  getBoundingClientRect(): Rect;
  querySelectorAll(s: string): ArrayLike<El>;
};
type Doc = { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };

/** Sets the safe areas, the window and the interface size, and loads the room again. Storage is left as the run set it, unless `folds` says. */
async function setUp(page: Page, cdp: CDPSession, view: View, folds?: string | null): Promise<void> {
  const i = view.insets ?? {};
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate(
    ([s, key, value]) => {
      const g = globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } };
      g.localStorage.setItem("rvtt.uiScale", String(s));
      if (value === null) g.localStorage.removeItem(key as string);
      else if (value !== undefined) g.localStorage.setItem(key as string, value as string);
    },
    [view.scale, FOLDS_KEY, folds] as const,
  );
  // A reload that meets a navigation the page started itself is aborted, so it gets one more try.
  /*
   * A fresh load of the room's address rather than a reload: a page
   * reloaded with a sheet open finds the sheet's history entry on top and
   * steps back off it (lib/backClose.ts), which a run that reloads often
   * can catch mid-navigation, landing on the page before the room.
   */
  await page.goto(`${server.origin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Resizes without a reload, as a rotation or a dragged window does. */
async function resize(page: Page, cdp: CDPSession, view: Omit<View, "scale">): Promise<void> {
  const i = view.insets ?? {};
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.waitForTimeout(400);
}

function storedFolds(page: Page): Promise<string | null> {
  return page.evaluate((key) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(key), FOLDS_KEY);
}

/** Taps a token by the middle of its footprint, after checking the map takes the tap there. */
async function tapToken(page: Page, at: { x: number; y: number }, size = 1): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: at.x + size / 2, y: at.y + size / 2 });
  const tag = await page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
  assert.equal(tag, "CANVAS", `the map does not take a tap at ${at.x},${at.y}`);
  await page.mouse.click(p.x, p.y);
}

function bar(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `${name} actions` });
}

/** The token's panel: the side panel's Token tab from 900 px up, the Token sheet below. */
function tokenPanel(page: Page): Locator {
  return page.getByRole("tabpanel", { name: "Token" }).or(page.getByRole("region", { name: "Token" }));
}

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
}

function focused(page: Page): Promise<{ name: string; expanded: string | null; role: string | null }> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: Doc }).document.activeElement;
    return { name: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim(), expanded: a?.getAttribute("aria-expanded") ?? null, role: a?.getAttribute("role") ?? null };
  });
}

/** The AC shields on the map, each with its number and its box on the page. */
function mapBadges(page: Page): Promise<{ text: string; rect: Rect; textWidth: number }[]> {
  return page.evaluate(() => {
    type Node = { getClientRect(): { x: number; y: number; width: number; height: number }; findOne(s: string): { text(): string; getTextWidth(): number } | undefined };
    const g = globalThis as unknown as { Konva: { stages: { find(s: string): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } };
    const stage = g.Konva.stages[0]!;
    const box = stage.container().getBoundingClientRect();
    return stage.find(".ac-badge").map((n) => {
      const r = n.getClientRect();
      const t = n.findOne("Text");
      const left = box.left + r.x;
      const top = box.top + r.y;
      return { text: t?.text() ?? "", textWidth: t?.getTextWidth() ?? 0, rect: { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height } };
    });
  });
}

/** The padlocks on the map, by their boxes on the page. */
function mapLocks(page: Page): Promise<Rect[]> {
  return page.evaluate(() => {
    type Node = { getClientRect(): { x: number; y: number; width: number; height: number } };
    const g = globalThis as unknown as { Konva: { stages: { find(s: string): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } };
    const stage = g.Konva.stages[0]!;
    const box = stage.container().getBoundingClientRect();
    return stage.find(".lock-mark").map((n) => {
      const r = n.getClientRect();
      return { left: box.left + r.x, top: box.top + r.y, right: box.left + r.x + r.width, bottom: box.top + r.y + r.height, width: r.width, height: r.height };
    });
  });
}

/** Waits for every scroller in the scope to hold still, so boxes read one after another come from one scroll position. */
async function settle(scope: Locator): Promise<void> {
  const read = () =>
    scope.evaluate((root) => {
      const all = [root as unknown as El, ...Array.from((root as unknown as El).querySelectorAll("*"))];
      return all.map((el) => el.scrollTop).join(",");
    });
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const next = await read();
    if (next === last) return;
    last = next;
  }
}

/** A token's footprint on the page. */
async function footprintRect(page: Page, at: { x: number; y: number }, size = 1): Promise<Rect> {
  const a = await pagePoint(page, BOUNDS, at);
  const b = await pagePoint(page, BOUNDS, { x: at.x + size, y: at.y + size });
  return { left: a.x, top: a.y, right: b.x, bottom: b.y, width: b.x - a.x, height: b.y - a.y };
}

const inside = (r: Rect, box: Rect) => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;

/**
 * Nothing in the scope runs out of its box sideways: the scope and every
 * box in it fits its content to its width. A box built to scroll or clip
 * sideways, such as a stat block's ability table, which scrolls inside its
 * own frame, is left out, and so is text kept for screen readers alone.
 */
async function noSideScroll(scope: Locator, label: string): Promise<void> {
  const wide = await scope.evaluate((root) => {
    type Styled = El & { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { overflowX: string } } } };
    const all = [root as unknown as Styled, ...(Array.from((root as unknown as El).querySelectorAll("*")) as Styled[])];
    return all
      .filter((el) => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1)
      .filter((el) => el === (root as unknown) || el.ownerDocument.defaultView.getComputedStyle(el).overflowX === "visible")
      .map((el) => `${el.getAttribute("data-unit") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").slice(0, 30)}: ${el.scrollWidth} > ${el.clientWidth}`);
  });
  assert.deepEqual(wide, [], `${label}: content wider than its box`);
}

/** Each speed unit on one line: a line breaks only between modes. */
async function speedUnitsWhole(scope: Locator, label: string): Promise<void> {
  const units = scope.locator('[data-unit="speed"]');
  const n = await units.count();
  assert.ok(n > 0, `${label}: no speed shows`);
  for (let i = 0; i < n; i++) {
    const r = await rectOf(units.nth(i));
    assert.ok(r.height < 30, `${label}: speed unit ${i} broke inside (${r.height} px tall)`);
  }
}

describe("raccoon-vtt: the token panel, the stat summary and AC on tokens", { timeout: 1_200_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: DESK.width, height: DESK.height } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    playerContext = await browser.newContext({ viewport: { width: DESK.width, height: DESK.height } });
    player = await playerContext.newPage();
    playerConsole.attach(player);
    await playerSocket.attach(playerContext, player);
    playerCdp = await playerContext.newCDPSession(player);
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

  test("0. a DM's room with Pat's Thorn and Wild Shape, Bree's token Pat holds, and a monster of every kind the summary reads", async () => {
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

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    // A small scene, so a medium creature is big enough for its shield at the window's fit.
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "monster.create", monster: bogThing(run.bog.monsterId) });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor({ ac: 16, hp: { cur: 31, max: 38, temp: 5 }, passivePerception: 14, sheetUrl: SHEET }) } });
    // Bree is the DM's: Pat holds her token, as a charmed ally, without her sheet.
    await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [], actor: actor({ ac: 17, hp: { cur: 12, max: 24, temp: 0 }, passivePerception: 15 }) } });
    const token = (id: string, at: { x: number; y: number }, extra: Record<string, unknown>) => ({
      t: "token.create",
      token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", x: at.x, y: at.y, disposition: "hostile", kind: "monster", ...extra },
    });
    await ops.send(token(run.thorn.id, run.thorn.at, { kind: "pc", name: "Thorn", disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(run.bear.id, run.bear.at, { kind: "npc", name: "Brown Bear", disposition: "ally", ownerIds: [run.patId], actor: { inline: actor({ ac: 11, srdId: "brown-bear", speeds: { walk: 40, climb: 30 }, passivePerception: 13, hp: { cur: 22, max: 22, temp: 0 } }) } }));
    await ops.send(token(run.bree.id, run.bree.at, { kind: "pc", name: "Bree", disposition: "ally", ownerIds: [run.patId], actor: { ref: run.bree.characterId } }));
    await ops.send(token(run.dragon.id, run.dragon.at, { name: "Adult White Dragon", size: "huge", hpVisibility: "label", actor: { inline: actor({ ac: 18, srdId: "adult-white-dragon", speeds: { walk: 40, burrow: 30, fly: 80, swim: 40 }, passivePerception: 21, hp: { cur: 200, max: 200, temp: 0 } }) } }));
    await ops.send(token(run.goblin.id, run.goblin.at, { name: "Goblin", number: 4, image: ICON, hpVisibility: "label", actor: { inline: actor({ ac: 15, srdId: "goblin-warrior", passivePerception: 9, hp: { cur: 10, max: 10, temp: 0 } }) } }));
    await ops.send(token(run.bog.id, run.bog.at, { name: "Bog Thing", hpVisibility: "label", actor: { inline: actor({ ac: 13, monsterId: run.bog.monsterId, speeds: { walk: 20, swim: 20 }, hp: { cur: 30, max: 30, temp: 0 } }) } }));
    await ops.send(token(run.swift.id, run.swift.at, { kind: "npc", name: "Swift", hpVisibility: "label", actor: { inline: actor({ ac: 100, speeds: { walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: true }, passivePerception: 60, hp: { cur: 100000, max: 100000, temp: 0 } }) } }));
    await ops.send(token(run.soft.id, run.soft.at, { kind: "npc", name: "Soft", hpVisibility: "label", actor: { inline: actor({ ac: 9 }) } }));
    await ops.send(token(run.villager.id, run.villager.at, { kind: "npc", name: "Villager", disposition: "neutral", hpVisibility: "label", actor: { inline: actor({ ac: 10 }) } }));
    await ops.send(token(run.chest.id, run.chest.at, { kind: "object", layer: "object", name: "Chest", disposition: "neutral", hpVisibility: "hidden", actor: { inline: actor({ ac: 15 }) } }));
    await ops.send(token(run.ogre.id, run.ogre.at, { name: "Ogre", size: "large", locked: true, hpVisibility: "label", actor: { inline: actor({ ac: 11, srdId: "ogre", speeds: { walk: 40 }, passivePerception: 8, hp: { cur: 68, max: 68, temp: 0 } }) } }));
    await ops.send({ t: "monster.create", monster: { ...bogThing(run.mire.monsterId), name: "Mire Thing" } });
    await ops.send(token(run.mire.id, run.mire.at, { name: "Mire Thing", hpVisibility: "label", actor: { inline: actor({ ac: 13, monsterId: run.mire.monsterId }) } }));
    await ops.send({ t: "monster.delete", monsterId: run.mire.monsterId });
    await ops.send(token(run.weapon.id, run.weapon.at, { kind: "object", name: "Spiritual Weapon", disposition: "ally", hpVisibility: "hidden", actor: { inline: actor({ ac: 0, hp: { cur: 0, max: 0, temp: 0 } }) } }));
    await ops.send(token(run.herald.id, run.herald.at, { kind: "npc", name: run.herald.name, disposition: "neutral", hpVisibility: "label", actor: { inline: actor({ ac: 14 }) } }));
    await waitFor("every token in the DM's view", () => [run.thorn, run.bear, run.bree, run.dragon, run.goblin, run.bog, run.swift, run.soft, run.villager, run.chest, run.ogre, run.mire, run.weapon, run.herald].every((t) => dmSocket.state?.tokens[t.id]) || null);

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("1. the DM's bar on an SRD goblin: the summary, the HP entry after it, the saves, Stat block and Details, and the buttons in two rows; the shield on the map", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor();
    const vitals = goblin.locator("[data-vitals]");
    const text = await vitals.innerText();
    for (const words of ["HP 10/10", "Speed 30 ft", "Passive Perception 9"]) assert.ok(text.replace(/\s+/g, " ").includes(words), `the vitals lack "${words}": ${text}`);
    const saves = goblin.locator("[data-saves]");
    await saves.waitFor();
    assert.equal((await saves.innerText()).replace(/\s+/g, " ").trim(), "Saves Str −1 Dex +2 Con +0 Int +0 Wis −1 Cha −1");
    const entry = goblin.getByRole("textbox", { name: "HP change" });
    const statBlock = goblin.getByRole("button", { name: "Stat block", exact: true });
    const details = goblin.getByRole("button", { name: "Details", exact: true });
    const tops = await Promise.all([vitals, entry, saves, statBlock].map(async (l) => (await rectOf(l)).top));
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i]! > tops[i - 1]!, `the bar's parts out of order: ${tops.join(", ")}`);
    assert.ok(Math.abs((await rectOf(details)).top - tops[3]!) < 2, "Details sits beside Stat block");

    // The two rows: play first, then setup and Delete apart, starting a line of their own.
    const names = async (row: string) => (await goblin.locator(`[data-bar-row="${row}"] button`).allInnerTexts()).map((t) => t.trim());
    assert.deepEqual(await names("play"), ["Conditions", "Hidden", "Select several"]);
    assert.deepEqual(await names("less"), ["Locked", "Duplicate", "Delete", "Move bar"]);
    const selectSeveral = await rectOf(goblin.getByRole("button", { name: "Select several", exact: true }));
    const locked = await rectOf(goblin.getByRole("button", { name: "Locked", exact: true }));
    assert.ok(locked.top >= selectSeveral.bottom, "Locked starts a line of its own");
    assert.ok(Math.abs(locked.left - (await rectOf(goblin.locator('[data-bar-row="less"]'))).left) < 1);
    await shots.take(dm, "tokenpanel-dm-goblin-bar");

    // The shield on the goblin's token, in its bottom left corner, and none on the chest.
    const goblinBox = await footprintRect(dm, run.goblin.at);
    const badges = await mapBadges(dm);
    const onGoblin = badges.find((b) => inside(b.rect, goblinBox));
    assert.ok(onGoblin, `no shield on the goblin: ${JSON.stringify(badges)}`);
    assert.equal(onGoblin.text, "15");
    assert.ok(Math.abs(onGoblin.rect.left - goblinBox.left) < 2 && Math.abs(onGoblin.rect.bottom - goblinBox.bottom) < 2, "the shield sits in the bottom left corner");
    const chestBox = await footprintRect(dm, run.chest.at);
    assert.equal(badges.filter((b) => inside(b.rect, chestBox)).length, 0, "an object shows no shield");

    // Damage that kills the goblin takes its shield off the vitals line and the map.
    await entry.fill("10");
    await goblin.getByRole("button", { name: "Apply", exact: true }).click();
    await waitFor("the goblin dead", () => (dmSocket.state?.tokens[run.goblin.id]?.actor as { inline?: { life?: string } }).inline?.life === "dead");
    await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor({ state: "detached" });
    await waitFor("no shield on the dead goblin", async () => (await mapBadges(dm)).every((b) => !inside(b.rect, goblinBox)));
    assert.ok((await vitals.innerText()).includes("Dead"));
    await shots.take(dm, "tokenpanel-dm-goblin-dead");
    await ops.send({ t: "actor.life", target: { tokenId: run.goblin.id }, life: "alive" });
    await ops.send({ t: "actor.hp", target: { tokenId: run.goblin.id }, change: { kind: "set", cur: 10 } });
    await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor();
  });

  test("2. Stat block keeps the bar beside the Token tab at the block, with focus on its disclosure; Escape hides the bar, a second lets go", async () => {
    const before = await storedFolds(dm);
    const goblin = bar(dm, "Goblin 4");
    await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
    await dm.getByRole("tab", { name: "Token", selected: true }).waitFor();
    const panel = tokenPanel(dm);
    await waitFor("focus on the stat block's disclosure", async () => {
      const f = await focused(dm);
      return f.name === "Stat block" && f.expanded === "true";
    });
    assert.ok(await goblin.isVisible(), "Stat block closed the bar");
    await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
    await dm.waitForTimeout(600);
    assert.ok(await panel.getByRole("heading", { name: "Goblin Warrior" }).isVisible());
    await shots.take(dm, "tokenpanel-dm-stat-block-beside-bar");

    // From the panel's top, the block's disclosure is within 240 px, with the summary line under it.
    await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await settle(panel);
    await dm.waitForTimeout(100);
    const top = (await rectOf(panel)).top;
    const disclosure = await rectOf(panel.getByRole("button", { name: "Stat block", exact: true }));
    assert.ok(disclosure.top - top <= 240, `the stat block starts ${disclosure.top - top} px down the panel`);
    const summary = await rectOf(panel.locator("[data-stat-block] [data-vitals]"));
    assert.ok(summary.top >= disclosure.bottom - 1, "the summary line sits under the disclosure");
    assert.ok((await panel.locator("[data-stat-block] [data-vitals]").innerText()).includes("Passive Perception 9"));
    assert.equal(await storedFolds(dm), before, "the request wrote the folds");

    // Escape hides the bar and keeps the goblin in the panel, focus on the tab. A second lets go.
    await dm.keyboard.press("Escape");
    await goblin.waitFor({ state: "detached" });
    assert.ok(await panel.getByRole("heading", { name: "Goblin 4" }).isVisible(), "the panel let go of the goblin");
    assert.deepEqual(await focused(dm).then((f) => [f.name, f.role]), ["Token", "tab"]);
    await dm.keyboard.press("Escape");
    await panel.getByText("Tap a token to see it here.").waitFor();
    assert.equal(await storedFolds(dm), before);
  });

  test("3. the panel's order and folds, what this device keeps of them, and the compact image and HP rows", async () => {
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Goblin 4" }).waitFor();
    const headings = (await panel.locator("h3").allInnerTexts()).map((h) => h.trim().toLowerCase());
    const order = ["goblin 4", "stat block", "hit points", "conditions", "position", "range rings", "notes", "rest", "stats", "token settings", "owners", "remove"];
    const at = order.map((h) => headings.indexOf(h));
    assert.ok(at.every((i) => i >= 0), `missing headings: ${JSON.stringify({ headings })}`);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! > at[i - 1]!, `out of order: ${headings.join(" | ")}`);
    assert.equal(headings.includes("companion"), false);
    for (const name of ["Stats", "Token settings", "Owners"]) assert.equal(await panel.getByRole("button", { name, exact: true }).getAttribute("aria-expanded"), "false", `${name} starts open`);

    // The image row: the preview, then "Change image" and "Add another image" on one line beside it.
    const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
    const another = panel.getByRole("button", { name: "Add another image", exact: true });
    const anotherBox = await rectOf(another);
    assert.ok(Math.abs(change.top - anotherBox.top) <= 2, "Change image and Add another image share a line");
    const panelLeft = (await rectOf(panel)).left;
    assert.ok(change.left - panelLeft >= 48 + 16, "the pair sits beside the preview");
    const maxHp = await rectOf(panel.getByRole("textbox", { name: "Max HP", exact: true }));
    const tempHp = await rectOf(panel.getByRole("textbox", { name: "Temporary HP", exact: true }));
    assert.ok(Math.abs(maxHp.top - tempHp.top) <= 2, "Max HP and Temporary HP share a row");
    const purpose = "Another image this token can wear, for Wild Shape or a disguise. A tap on it here or in the token's bar puts it on.";
    const describedBy = await another.getAttribute("aria-describedby");
    assert.ok(describedBy);
    assert.equal((await dm.locator(`[id="${describedBy}"]`).textContent())?.trim(), purpose);
    assert.equal(await another.getAttribute("title"), purpose);
    await another.click();
    const picker = dm.getByRole("dialog", { name: "Choose an image" });
    await picker.getByText(purpose).waitFor();
    await shots.take(dm, "tokenpanel-dm-other-image-picker");
    await picker.getByRole("button", { name: /^Close/ }).first().click();
    await picker.waitFor({ state: "detached" });
    await shots.take(dm, "tokenpanel-dm-panel-top");

    // Token settings opened stays open through a reload, and storage holds it.
    await panel.getByRole("button", { name: "Token settings", exact: true }).click();
    await panel.getByRole("textbox", { name: "Height", exact: true }).waitFor();
    assert.equal(JSON.parse((await storedFolds(dm)) ?? "{}").settings, true);
    await dm.goto(`${server.origin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").getByRole("button", { name: "Details", exact: true }).click();
    await tokenPanel(dm).getByRole("heading", { name: "Goblin 4" }).waitFor();
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Token settings", exact: true }).getAttribute("aria-expanded"), "true");
    await tokenPanel(dm).getByRole("button", { name: "Token settings", exact: true }).click();
    assert.equal(JSON.parse((await storedFolds(dm)) ?? "{}").settings, false);

    // A character: no stat block, the summary line alone under the image, with the sheet link.
    await tapToken(dm, run.thorn.at);
    await bar(dm, "Thorn").getByRole("button", { name: "Details", exact: true }).click();
    const thorn = tokenPanel(dm);
    await thorn.getByRole("heading", { name: "Thorn" }).first().waitFor();
    assert.equal(await thorn.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    const summary = thorn.locator("[data-vitals]").first();
    await summary.getByRole("img", { name: "Armor Class 16" }).waitFor();
    assert.equal(await summary.getByRole("link", { name: "Open the sheet ↗" }).getAttribute("href"), SHEET);
    assert.ok((await rectOf(summary)).top < (await rectOf(thorn.getByRole("heading", { name: "Hit points" }))).top, "the summary line sits above Hit points");
    await shots.take(dm, "tokenpanel-dm-thorn-summary-line");
    await dm.keyboard.press("Escape");
  });

  test("3b. the DM's Make a companion in Token settings starts with no character and the turn listed under it, waits for a character, and Cancel starts it again", async () => {
    await tapToken(dm, run.villager.at);
    await bar(dm, "Villager").getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Villager" }).first().waitFor();
    await panel.getByRole("button", { name: "Token settings", exact: true }).click();
    const chosen = (name: string) => panel.getByRole("combobox", { name, exact: true }).locator("option:checked").textContent();
    await panel.getByRole("button", { name: "Make a companion", exact: true }).click();
    assert.equal(await chosen("Belongs to"), "Choose a character");
    assert.match((await chosen("Turn")) ?? "", /listed under/);
    const confirm = panel.getByRole("button", { name: "Make a companion", exact: true });
    assert.equal(await confirm.isDisabled(), true, "the confirm waits for a character");
    await panel.getByRole("combobox", { name: "Belongs to", exact: true }).selectOption({ label: "Thorn" });
    assert.equal(await chosen("Turn"), "On Thorn's turn, listed under Thorn");
    assert.equal(await confirm.isDisabled(), false);
    await shots.take(dm, "tokenpanel-dm-make-a-companion");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("button", { name: "Make a companion", exact: true }).click();
    assert.equal(await chosen("Belongs to"), "Choose a character", "Cancel starts the form again");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(dmSocket.state!.tokens[run.villager.id]!.companion, undefined, "nothing was sent");
    await panel.getByRole("button", { name: "Token settings", exact: true }).click();
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
  });

  test("4. a long Immunities line clamps in the bar and shows whole in the block; an unlinked NPC offers Attach; the lock stands above the shield; AC 9 and 100 fit their shields", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await tapToken(dm, run.bog.at);
    const bog = bar(dm, "Bog Thing");
    const line = bog.locator('[data-defense="Immunities"]');
    await line.waitFor();
    const clamp = await line.evaluate((el) => ({ client: (el as unknown as El).clientHeight, scroll: (el as unknown as El).scrollHeight }));
    // "Vulnerabilities Fire" is one line, the measure of a line.
    const oneLine = (await rectOf(bog.locator('[data-defense="Vulnerabilities"]'))).height;
    assert.ok(clamp.scroll > clamp.client, "the long line is not cut");
    assert.ok(clamp.client <= oneLine * 3 + 2 && clamp.client >= oneLine * 3 - 2, `not three lines: ${JSON.stringify({ ...clamp, oneLine })}`);
    const vulnerabilities = await rectOf(bog.locator('[data-defense="Vulnerabilities"]'));
    assert.ok(vulnerabilities.top < (await rectOf(line)).top, "Vulnerabilities come first");
    await shots.take(dm, "tokenpanel-dm-long-immunities");
    await bog.getByRole("button", { name: "Stat block", exact: true }).click();
    const panel = tokenPanel(dm);
    await panel.getByText(LONG_IMMUNITIES.slice(-40)).waitFor();
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");

    await tapToken(dm, run.villager.at);
    const villager = bar(dm, "Villager");
    await villager.waitFor();
    assert.equal(await villager.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    await villager.getByRole("button", { name: "Details", exact: true }).click();
    await tokenPanel(dm).getByRole("button", { name: "Attach a stat block", exact: true }).waitFor();
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).count(), 0, "a block with no link has no fold");
    await dm.keyboard.press("Escape");

    // A room monster deleted since: no saves and no Stat block in the bar, the note and Detach with the summary in the panel.
    await tapToken(dm, run.mire.at);
    const mire = bar(dm, "Mire Thing");
    await mire.getByRole("img", { name: "Armor Class 13" }).waitFor();
    assert.equal(await mire.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    assert.equal(await mire.locator("[data-saves]").count(), 0);
    await mire.getByRole("button", { name: "Details", exact: true }).click();
    const mirePanel = tokenPanel(dm).locator("[data-stat-block]");
    await mirePanel.getByText("This token’s stat block was deleted from this room.").waitFor();
    await mirePanel.getByRole("button", { name: "Detach", exact: true }).waitFor();
    await mirePanel.getByRole("img", { name: "Armor Class 13" }).waitFor();
    await dm.keyboard.press("Escape");

    // An HP-less token: no vitals, no HP entry, no shield.
    await tapToken(dm, run.weapon.at);
    const weapon = bar(dm, "Spiritual Weapon");
    await weapon.waitFor();
    assert.equal(await weapon.locator("[data-vitals]").count(), 0);
    assert.equal(await weapon.getByRole("textbox", { name: "HP change" }).count(), 0);
    await weapon.getByRole("button", { name: "Details", exact: true }).waitFor();
    await shots.take(dm, "tokenpanel-dm-hp-less-bar");
    await dm.keyboard.press("Escape");

    // The locked ogre: its lock stands above its shield on the left edge.
    const ogreBox = await footprintRect(dm, run.ogre.at, 2);
    const shield = (await mapBadges(dm)).find((b) => inside(b.rect, ogreBox));
    const lock = (await mapLocks(dm)).find((r) => inside(r, ogreBox));
    assert.ok(shield && lock, `the ogre's shield and lock: ${JSON.stringify({ shield, lock })}`);
    assert.ok(lock.bottom <= shield.rect.top + 1, "the lock stands above the shield");
    assert.ok(Math.abs(lock.left - ogreBox.left) < 2, "on the left edge");

    // AC 9 and 100: every digit inside the shield, on the map, in the bar and in the panel.
    for (const [at, name, ac] of [
      [run.soft.at, "Soft", "9"],
      [run.swift.at, "Swift", "100"],
    ] as const) {
      const box = await footprintRect(dm, at);
      const badge = (await mapBadges(dm)).find((b) => inside(b.rect, box));
      assert.ok(badge && badge.text === ac, `${name}'s shield on the map`);
      assert.ok(badge.textWidth <= badge.rect.width, `${name}'s number runs out of its shield on the map`);
      await tapToken(dm, at);
      const b = bar(dm, name);
      const img = b.getByRole("img", { name: `Armor Class ${ac}` });
      await img.waitFor();
      const fits = (l: Locator) => l.evaluate((el) => (el as unknown as El).scrollWidth <= (el as unknown as El).clientWidth + 1 && (el.querySelector("span[aria-hidden]") as unknown as El).getBoundingClientRect().width <= (el as unknown as El).getBoundingClientRect().width);
      assert.ok(await fits(img), `${name}'s number runs out of its shield in the bar`);
      await b.getByRole("button", { name: "Details", exact: true }).click();
      const inPanel = tokenPanel(dm).getByRole("img", { name: `Armor Class ${ac}` });
      await inPanel.waitFor();
      assert.ok(await fits(inPanel), `${name}'s number runs out of its shield in the panel`);
      await dm.keyboard.press("Escape");
    }
    await shots.take(dm, "tokenpanel-dm-shields");
  });

  test("5. the dragon's and the five-speed token's bars and panels run out of nothing, and their speeds break only between modes", async () => {
    const sizes: (View & { label: string })[] = [
      { ...DESK, label: "1280 x 800" },
      { width: 390, height: 844, scale: 1, label: "390 x 844" },
      { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 }, label: "480 x 320 at 130%" },
    ];
    for (const size of sizes) {
      await setUp(dm, dmCdp, size, null);
      for (const [t, name, span] of [
        [run.dragon, "Adult White Dragon", 3],
        [run.swift, "Swift", 1],
      ] as const) {
        await tapToken(dm, t.at, span);
        const b = bar(dm, name);
        await b.waitFor();
        await noSideScroll(b, `${size.label}, ${name}'s bar`);
        // A short bar keeps speed in More stats.
        const more = b.getByRole("button", { name: "More stats", exact: true });
        if ((await more.count()) > 0) await more.click();
        await speedUnitsWhole(b, `${size.label}, ${name}'s bar`);
        await noSideScroll(b, `${size.label}, ${name}'s bar opened`);
        await shots.take(dm, `tokenpanel-${size.width}x${size.height}-${name.split(" ")[0]!.toLowerCase()}-bar`);
        await b.getByRole("button", { name: "Details", exact: true }).click();
        const panel = tokenPanel(dm);
        await panel.getByRole("heading", { name, exact: true }).first().waitFor();
        // At 480 x 320 at 130% the panel takes the very short mode, over the whole screen with 241 px inside (docs/design-v1-layout-hierarchy.md 4.2).
        if (size.width === 480) assert.equal(await dm.locator('dialog[data-rvtt-sheet][aria-modal="true"]').count(), 1, `${size.label}: the panel opens over the whole screen`);
        await noSideScroll(panel, `${size.label}, ${name}'s panel`);
        await speedUnitsWhole(panel, `${size.label}, ${name}'s panel`);
        await shots.take(dm, `tokenpanel-${size.width}x${size.height}-${name.split(" ")[0]!.toLowerCase()}-panel`);
        // Let go, and on a phone close the sheet first.
        for (let i = 0; i < 3 && (await panel.count()) > 0 && (await panel.getByText("Tap a token to see it here.").count()) === 0; i++) await dm.keyboard.press("Escape");
        await dm.keyboard.press("Escape");
        await dm.waitForTimeout(200);
      }
    }
  });

  test("5b. an 80-character name: two lines in the bar's header, whole and wrapping in the panel, at a desk and on a phone", async () => {
    for (const size of [DESK, { width: 390, height: 844, scale: 1 }]) {
      await setUp(dm, dmCdp, size, null);
      await tapToken(dm, run.herald.at);
      const herald = bar(dm, run.herald.name);
      await herald.waitFor();
      await noSideScroll(herald, `${size.width}: the herald's bar`);
      const title = herald.locator("strong").filter({ hasText: run.herald.name.slice(0, 20) }).first();
      const clamp = await title.evaluate((el) => {
        const e = el as unknown as El & { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { lineHeight: string; fontSize: string } } } };
        const cs = e.ownerDocument.defaultView.getComputedStyle(e);
        return { client: e.clientHeight, scroll: e.scrollHeight, line: Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.25 };
      });
      assert.ok(clamp.client <= clamp.line * 2 + 2, `the bar's header shows more than two lines: ${JSON.stringify(clamp)}`);
      await herald.getByRole("button", { name: "Details", exact: true }).click();
      const heading = tokenPanel(dm).getByRole("heading", { name: run.herald.name });
      await heading.waitFor();
      assert.equal((await heading.innerText()).trim(), run.herald.name, "the panel shows the whole name");
      await noSideScroll(tokenPanel(dm), `${size.width}: the herald's panel`);
      await shots.take(dm, `tokenpanel-${size.width}-long-name`);
    }
  });

  test("6. a phone held upright: one line of vitals; the block folds, opens and is remembered; Stat block hides the bar and opens the sheet at it; the override lasts across 900 px", async () => {
    await setUp(dm, dmCdp, { width: 390, height: 844, scale: 1 }, null);
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    const vitals = await rectOf(goblin.locator("[data-vitals]"));
    assert.ok(vitals.height < 30, `the vitals take more than one line spanning: ${vitals.height} px`);
    const saves = await rectOf(goblin.locator("[data-saves]"));
    assert.ok(saves.height < 30, `the saves take more than one line spanning: ${saves.height} px`);
    await goblin.getByRole("button", { name: "Details", exact: true }).click();
    const panel = tokenPanel(dm);
    const fold = panel.getByRole("button", { name: "Stat block", exact: true });
    await fold.waitFor();
    // 356 px inside: the preview and both first buttons on one line, and Max and Temp HP on one row.
    const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
    const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
    assert.ok(Math.abs(change.top - another.top) <= 2 && change.left - (await rectOf(panel)).left >= 48, "the image row takes one line on a phone held upright");
    const maxHp = await rectOf(panel.getByRole("textbox", { name: "Max HP", exact: true }));
    assert.ok(Math.abs(maxHp.top - (await rectOf(panel.getByRole("textbox", { name: "Temporary HP", exact: true }))).top) <= 2, "Max and Temp HP share a row at 356 px");
    assert.equal(await fold.getAttribute("aria-expanded"), "false", "the block starts folded on a phone");
    await fold.click();
    await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
    await dm.getByRole("region", { name: "Token" }).getByRole("button", { name: "Close Token" }).click();
    await panel.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
    await tapToken(dm, run.dragon.at, 3);
    await bar(dm, "Adult White Dragon").getByRole("button", { name: "Details", exact: true }).click();
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "true", "the fold is remembered for the next monster");
    await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).click();
    await dm.getByRole("region", { name: "Token" }).getByRole("button", { name: "Close Token" }).click();
    await dm.keyboard.press("Escape");

    // From the bar, Stat block hides it, opens the Token sheet at the block and focuses its disclosure.
    await tapToken(dm, run.goblin.at);
    await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
    await goblin.waitFor({ state: "hidden" });
    await waitFor("focus on the stat block's disclosure", async () => {
      const f = await focused(dm);
      return f.name === "Stat block" && f.expanded === "true";
    });
    // The sheet scrolls the block to its top.
    await waitFor("the block at the sheet's top", async () => {
      const body = await rectOf(tokenPanel(dm));
      const block = await rectOf(tokenPanel(dm).locator("[data-stat-block]"));
      return block.top - body.top < 120;
    }, 3_000);
    await shots.take(dm, "tokenpanel-390x844-stat-block-sheet");
    await resize(dm, dmCdp, { width: 844, height: 390 });
    assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "true", "a rotation folded the block");

    // A fresh room with nothing stored: at 899 the block is folded, the request opens it, and 900 keeps it open.
    for (const [from, to, stored] of [
      [899, 900, null],
      [900, 899, JSON.stringify({ statBlock: false })],
    ] as const) {
      await setUp(dm, dmCdp, { width: from, height: 844, scale: 1 }, stored);
      if (from >= 900) await dm.getByRole("tab", { name: "Initiative" }).click();
      await tapToken(dm, run.goblin.at);
      await bar(dm, "Goblin 4").getByRole("button", { name: "Stat block", exact: true }).click();
      await tokenPanel(dm).getByRole("heading", { name: "Goblin Warrior" }).waitFor();
      await resize(dm, dmCdp, { width: to, height: 844 });
      const disclosure = tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true });
      await disclosure.waitFor();
      assert.equal(await disclosure.getAttribute("aria-expanded"), "true", `${from} then ${to}: the block folded`);
      await shots.take(dm, `tokenpanel-${from}-to-${to}-stat-block`);
      // Another monster's block shows folded, as the device keeps it.
      await tapToken(dm, run.dragon.at, 3);
      const dragonBar = bar(dm, "Adult White Dragon");
      if (await dragonBar.isVisible()) await dragonBar.getByRole("button", { name: "Details", exact: true }).click();
      await tokenPanel(dm).getByRole("heading", { name: "Adult White Dragon" }).first().waitFor();
      assert.equal(await tokenPanel(dm).getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "false", `${from} then ${to}: another monster's block`);
      assert.equal(await storedFolds(dm), stored, "the request wrote the folds");
    }
  });

  test("7. a phone held sideways and a large one in the wide layout: a short bar with Apply in view, More stats, Stat block beside the sheet, and the image and HP rows wrapping", async () => {
    const sizes: (View & { label: string })[] = [
      { width: 844, height: 390, scale: 1, insets: { side: 47, bottom: 21 }, label: "844 x 390" },
      { width: 844, height: 390, scale: 1.3, insets: { side: 47, bottom: 21 }, label: "844 x 390 at 130%" },
      { width: 932, height: 430, scale: 1, insets: { side: 59, bottom: 21 }, label: "932 x 430" },
    ];
    for (const size of sizes) {
      await setUp(dm, dmCdp, size, null);
      // A short wide layout starts with its side panel hidden (docs/design-v1-layout-hierarchy.md 4.1), and Stat block shows it below.
      if (size.width >= 900) assert.equal(await dm.getByRole("tab", { name: "Token" }).count(), 0, `${size.label}: the side panel starts shown`);
      await tapToken(dm, run.goblin.at);
      const goblin = bar(dm, "Goblin 4");
      await goblin.waitFor();
      const frame = await rectOf(goblin);
      const apply = await rectOf(goblin.getByRole("button", { name: "Apply", exact: true }));
      assert.ok(apply.bottom <= frame.bottom + 1 && apply.top >= frame.top, `${size.label}: Apply is out of the bar's box`);
      assert.equal(await goblin.evaluate((el) => (el as unknown as El).scrollTop), 0);
      const more = goblin.getByRole("button", { name: "More stats", exact: true });
      assert.equal(await more.getAttribute("aria-expanded"), "false", `${size.label}: More stats starts open`);
      assert.ok((await rectOf(more)).top > apply.bottom, "More stats sits under the HP entry");
      assert.equal(await goblin.locator("[data-saves]").count(), 0);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-short-bar`);
      await more.click();
      const opened = (await goblin.innerText()).replace(/\s+/g, " ");
      for (const words of ["Speed 30 ft", "Passive Perception 9", "Saves Str −1"]) assert.ok(opened.includes(words), `${size.label}: More stats lacks ${words}`);
      await noSideScroll(goblin, `${size.label}, the short bar`);

      // Stat block keeps the bar open beside the sheet or side panel, which opens at the block.
      await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
      const panel = tokenPanel(dm);
      await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
      assert.ok(await goblin.isVisible(), `${size.label}: Stat block hid the bar`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-stat-block-beside`);

      // The image row under the preview, the pair sharing a line exactly where the column holds both.
      await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
      await settle(panel);
      const pair = panel.locator("[data-image-pair]");
      const column = await pair.evaluate((el) => (el.parentElement as unknown as El).getBoundingClientRect().width);
      const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
      const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
      const preview = await pair.evaluate((el) => ((el.parentElement!.parentElement!.firstElementChild as unknown as El).getBoundingClientRect()));
      assert.ok(change.top >= preview.bottom - 1, `${size.label}: the buttons sit beside the preview`);
      const holds = column >= change.width + another.width + 4 - 0.5;
      assert.equal(Math.abs(change.top - another.top) <= 2, holds, `${size.label}: the pair's lines with a ${column} px column`);
      const maxHp = await rectOf(panel.getByRole("textbox", { name: "Max HP", exact: true }));
      const tempHp = await rectOf(panel.getByRole("textbox", { name: "Temporary HP", exact: true }));
      assert.ok(tempHp.top > maxHp.bottom - 1, `${size.label}: Max HP and Temp HP on one row`);
      await noSideScroll(panel, `${size.label}, the panel`);
      const pageWide = await dm.evaluate(() => (globalThis as unknown as { document: { documentElement: El } }).document.documentElement.scrollWidth > (globalThis as unknown as { innerWidth: number }).innerWidth);
      assert.equal(pageWide, false, `${size.label}: the page scrolls sideways`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-panel-rows`);
    }
  });

  test("7b. a phone upright at 130% and an upright tablet: the full layout, Stat block hiding the bar for the sheet at the block, and the image and HP rows", async () => {
    const sizes: (View & { label: string; hpRow: boolean })[] = [
      { width: 390, height: 844, scale: 1.3, label: "390 x 844 at 130%", hpRow: false },
      { width: 820, height: 1180, scale: 1, label: "820 x 1180", hpRow: true },
    ];
    for (const size of sizes) {
      await setUp(dm, dmCdp, size, null);
      await tapToken(dm, run.goblin.at);
      const goblin = bar(dm, "Goblin 4");
      await goblin.getByRole("img", { name: "Armor Class 15" }).waitFor();
      // A spanning bar is short where the side of its token it takes has under 300 px (barButtons.ts barShort), as at 130% with the goblin mid-screen.
      const more = goblin.getByRole("button", { name: "More stats", exact: true });
      if (size.width >= 600) assert.equal(await more.count(), 0, `${size.label}: a short bar`);
      if ((await more.count()) > 0) await more.click();
      await goblin.locator("[data-saves]").waitFor();
      await noSideScroll(goblin, `${size.label}, the bar`);
      await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
      const panel = tokenPanel(dm);
      await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
      await goblin.waitFor({ state: "hidden" });
      await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
      await settle(panel);
      const pair = panel.locator("[data-image-pair]");
      const column = await pair.evaluate((el) => (el.parentElement as unknown as El).getBoundingClientRect().width);
      const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
      const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
      const gap = await pair.evaluate((el) => Number.parseFloat((el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { columnGap: string } } } }).ownerDocument.defaultView.getComputedStyle(el).columnGap));
      const zoom = size.scale;
      assert.equal(Math.abs(change.top - another.top) <= 2, column >= change.width + another.width + gap * zoom - 0.5, `${size.label}: the pair's lines with a ${column} px column for ${change.width} + ${another.width} + ${gap * zoom}`);
      const maxHp = await rectOf(panel.getByRole("textbox", { name: "Max HP", exact: true }));
      const tempHp = await rectOf(panel.getByRole("textbox", { name: "Temporary HP", exact: true }));
      assert.equal(Math.abs(maxHp.top - tempHp.top) <= 2, size.hpRow, `${size.label}: Max and Temp HP's rows`);
      await noSideScroll(panel, `${size.label}, the panel`);
      await shots.take(dm, `tokenpanel-${size.label.replace(/ /g, "")}-stat-block-sheet`);
    }
  });

  test("7c. the very short mode at 480 x 320 at 130%: Stat block opens the whole-screen sheet at the block with focus on its disclosure, the bar put away, and the image and HP rows wrapping at 241 px", async () => {
    await setUp(dm, dmCdp, { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 } }, null);
    await tapToken(dm, run.goblin.at);
    const goblin = bar(dm, "Goblin 4");
    await goblin.waitFor();
    await goblin.getByRole("button", { name: "Stat block", exact: true }).click();
    const sheet = dm.locator('dialog[data-rvtt-sheet][aria-modal="true"]');
    await sheet.waitFor();
    const panel = tokenPanel(dm);
    await panel.getByRole("heading", { name: "Goblin Warrior" }).waitFor();
    await waitFor("focus on the stat block's disclosure", async () => {
      const f = await focused(dm);
      return f.name === "Stat block" && f.expanded === "true";
    });
    // The bar cannot stand beside a panel that covers the screen, so Stat block puts it away (docs/design-v1-token-panel.md 3.4).
    assert.equal(await goblin.isVisible(), false, "the bar still shows");
    await shots.take(dm, "tokenpanel-480x320at130-very-short-stat-block");
    await panel.evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await settle(panel);
    const pair = panel.locator("[data-image-pair]");
    const column = await pair.evaluate((el) => (el.parentElement as unknown as El).getBoundingClientRect().width);
    const change = await rectOf(panel.getByRole("button", { name: "Change image", exact: true }));
    const another = await rectOf(panel.getByRole("button", { name: "Add another image", exact: true }));
    const gap = await pair.evaluate((el) => Number.parseFloat((el as unknown as { ownerDocument: { defaultView: { getComputedStyle(e: unknown): { columnGap: string } } } }).ownerDocument.defaultView.getComputedStyle(el).columnGap));
    assert.equal(Math.abs(change.top - another.top) <= 2, column >= change.width + another.width + gap * 1.3 - 0.5, `the pair's lines with a ${column} px column`);
    const maxHp = await rectOf(panel.getByRole("textbox", { name: "Max HP", exact: true }));
    const tempHp = await rectOf(panel.getByRole("textbox", { name: "Temporary HP", exact: true }));
    assert.ok(tempHp.top > maxHp.bottom - 1, "Max HP and Temp HP take two lines at 241 px");
    await noSideScroll(panel, "480 x 320 at 130%, the very short panel");
    // Escape is the modal's own: it closes the sheet.
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
  });

  test("8. Pat on a phone: their character's summary and sheet link, Bree's HP alone, the goblin's label, the HP entry when the room allows it, and the Wild Shape's saves after loading", async () => {
    // At a desk first, where tokens are big enough for shields: Thorn's shows, Bree's and the goblin's never do.
    await setUp(player, playerCdp, DESK, null);
    await waitFor("Pat's snapshot", () => playerSocket.state?.tokens[run.goblin.id]);
    const shields = await mapBadges(player);
    const thornBox = await footprintRect(player, run.thorn.at);
    assert.ok(shields.some((b) => inside(b.rect, thornBox) && b.text === "16"), `no shield on Thorn: ${JSON.stringify(shields)}`);
    const bearBox = await footprintRect(player, run.bear.at);
    assert.ok(shields.some((b) => inside(b.rect, bearBox) && b.text === "11"), "no shield on Pat's Wild Shape");
    for (const t of [run.bree, run.goblin, run.dragon]) {
      const box = await footprintRect(player, t.at, t === run.dragon ? 3 : 1);
      assert.equal(shields.filter((b) => inside(b.rect, box)).length, 0, "a shield Pat may not see");
    }
    const goblinState = playerSocket.state!.tokens[run.goblin.id]!;
    assert.equal("ac" in ((goblinState.actor as { inline: Record<string, unknown> }).inline ?? {}), false, "the goblin's AC reached Pat");

    // A failed load says so and offers another try. Chrome keeps a failed module for the page, so the run reloads before the next load.
    await player.route(/\/assets\/monsters-[^/]*\.js$/, (route) => route.abort());
    await setUp(player, playerCdp, DESK, null);
    await tapToken(player, run.bear.at);
    await bar(player, "Brown Bear").getByText("Saves did not load.").waitFor();
    await bar(player, "Brown Bear").getByRole("button", { name: "Try again", exact: true }).waitFor();
    await shots.take(player, "tokenpanel-pat-bear-saves-failed");
    await player.unroute(/\/assets\/monsters-[^/]*\.js$/);

    // The SRD chunk waits 600 ms, so Loading saves shows.
    await player.route(/\/assets\/monsters-[^/]*\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await setUp(player, playerCdp, { width: 390, height: 844, scale: 1 }, null);
    await tapToken(player, run.thorn.at);
    const thorn = bar(player, "Thorn");
    await thorn.getByRole("img", { name: "Armor Class 16" }).waitFor();
    const text = (await thorn.innerText()).replace(/\s+/g, " ");
    for (const words of ["HP 31/38", "+5", "Speed 30 ft", "Passive Perception 14"]) assert.ok(text.includes(words), `Thorn's bar lacks ${words}`);
    assert.equal(await thorn.getByRole("link", { name: "Open the sheet ↗" }).getAttribute("href"), SHEET);
    await thorn.getByRole("button", { name: "Details", exact: true }).waitFor();
    assert.equal(await thorn.locator("[data-saves]").count(), 0);
    await shots.take(player, "tokenpanel-pat-thorn-bar");
    await player.keyboard.press("Escape");

    await tapToken(player, run.bree.at);
    const bree = bar(player, "Bree");
    await bree.waitFor();
    assert.equal(await bree.getByRole("img").count(), 0, "Bree's AC shows to Pat");
    assert.ok((await bree.locator("[data-vitals]").innerText()).includes("HP 12/24"), "Bree's HP as the party's rule sends it");
    assert.equal((await bree.innerText()).includes("Passive Perception"), false);
    await player.keyboard.press("Escape");

    await tapToken(player, run.goblin.at);
    const goblin = bar(player, "Goblin 4");
    await goblin.waitFor();
    assert.equal((await goblin.locator("[data-vitals]").innerText()).trim(), "Healthy");
    assert.equal(await goblin.getByRole("textbox", { name: "HP change" }).count(), 0);
    await goblin.getByRole("button", { name: "Details", exact: true }).waitFor();
    assert.equal(await goblin.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
    await goblin.getByRole("textbox", { name: "HP change" }).waitFor();
    const modes = goblin.getByRole("radiogroup", { name: "What the number does" });
    assert.equal(await modes.getByRole("radio").count(), 2);
    await modes.getByRole("radio", { name: "Damage" }).waitFor({ state: "attached" });
    await modes.getByRole("radio", { name: "Heal" }).waitFor({ state: "attached" });
    await shots.take(player, "tokenpanel-pat-goblin-bar");
    await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
    await player.keyboard.press("Escape");

    await tapToken(player, run.bear.at);
    const bear = bar(player, "Brown Bear");
    await bear.getByText("Loading saves…").waitFor();
    await shots.take(player, "tokenpanel-pat-bear-loading-saves");
    await bear.locator("[data-saves]").waitFor();
    await bear.getByRole("button", { name: "Stat block", exact: true }).click();
    await tokenPanel(player).getByRole("heading", { name: "Brown Bear" }).last().waitFor();
    await tokenPanel(player).getByText("Stat blocks from the System Reference Document 5.2.1").waitFor();
    await shots.take(player, "tokenpanel-pat-bear-stat-block");
    await player.unroute(/\/assets\/monsters-[^/]*\.js$/);
  });

  test("8b. viewing as Pat: Stat block opens the preview's own panel at the SRD block, and nothing there writes the folds", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await dm.getByRole("tab", { name: "DM" }).click();
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    await preview.locator(".konvajs-content").first().waitFor();
    await dm.waitForTimeout(600);
    // The preview draws a stage of its own, the page's second: tap the bear on it.
    const p = await dm.evaluate((id) => {
      type Node = { getClientRect(): { x: number; y: number; width: number; height: number } };
      const g = globalThis as unknown as { Konva: { stages: { findOne(s: string): Node | undefined; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } };
      const stage = g.Konva.stages[g.Konva.stages.length - 1]!;
      const node = stage.findOne(`#${id}`);
      if (!node) return null;
      const r = node.getClientRect();
      const box = stage.container().getBoundingClientRect();
      return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2 };
    }, run.bear.id);
    assert.ok(p, "the bear is not on the preview's map");
    await dm.mouse.click(p.x, p.y);
    const bear = preview.getByRole("dialog", { name: "Brown Bear actions" });
    await bear.locator("[data-saves]").waitFor();
    await bear.getByRole("button", { name: "Stat block", exact: true }).click();
    const panel = preview.getByRole("tabpanel", { name: "Token" });
    await panel.getByRole("button", { name: "Stat block", exact: true }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Stat block", exact: true }).getAttribute("aria-expanded"), "true");
    await panel.getByText("Stat blocks from the System Reference Document 5.2.1").waitFor();
    // The DM's own panel, under the preview, did not move.
    assert.equal(await dm.getByRole("tab", { name: "DM", selected: true }).count(), 1);
    await shots.take(dm, "tokenpanel-viewing-as-pat-stat-block");
    await panel.getByRole("button", { name: "Stats", exact: true }).click();
    assert.equal(await storedFolds(dm), null, "the preview wrote the folds");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
  });

  test("9. several selected: the group bar has no Stat block and no saves", async () => {
    await setUp(dm, dmCdp, DESK, null);
    await tapToken(dm, run.goblin.at);
    await bar(dm, "Goblin 4").waitFor();
    await dm.keyboard.down("Shift");
    await tapToken(dm, run.dragon.at, 3);
    await dm.keyboard.up("Shift");
    const group = dm.getByRole("dialog", { name: "2 selected tokens" });
    await group.waitFor();
    assert.equal(await group.getByRole("button", { name: "Stat block", exact: true }).count(), 0);
    assert.equal(await group.locator("[data-saves]").count(), 0);
    assert.equal((await group.innerText()).includes("Saves"), false);
    await shots.take(dm, "tokenpanel-dm-group-bar");
  });

  test("10. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
    assert.deepEqual(playerConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
