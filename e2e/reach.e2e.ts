import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * Short-screen reach: one sweep over the phone sizes, at 100% and 130%,
 * with and without a fight, a lasting notice, a tool's options and a
 * waiting alert, checking that what a phone must reach takes a tap as it
 * stands, nothing scrolled first:
 *
 * - the way back to an alert: the roll's chip, the alerts column's row, or
 *   the card itself where it shows;
 * - once tapped, the card's own controls (what to roll, Later, the total
 *   and Send; a check's Passed and Failed);
 * - End turn when it shows;
 * - the tool's buttons (the Ruler's, scrolled to the foot of its capped
 *   list of kept rulers, or Select several's Actions and Done);
 * - the token bar's Close when the bar shows.
 *
 * One page per side, resized and changed between steps rather than set up
 * again, so the whole matrix runs in minutes. Every miss is collected, so
 * one run names all of them. The player answers a roll and the DM a
 * concentration check: a player has no checks of their own here, and only
 * the DM frames a starting view. What cannot happen is skipped and listed
 * below.
 *
 * Skipped:
 * - the DM's own turn: the DM's band has no End turn;
 * - the Starting view notice for the player, who cannot frame one, and the
 *   reconnecting notice for the DM, whose sweep keeps the server up so the
 *   checks keep coming (the player's sweep covers that notice);
 * - a roll for the DM and a check for the player, as above;
 * - Select several, and the bar's Close, where the bars and a notice leave
 *   no map to select the token on, which a viewer could not do either.
 *
 * A target under a lasting notice is a miss like any other: on a short
 * screen the notices that last keep to one line (components/Notice.tsx
 * `compact`), so none stands over the tool's buttons or the toolbar.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 8;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-reach-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

type Insets = { top?: number; side?: number; bottom?: number };
type Size = { width: number; height: number; insets: Insets };

/** The phones, with the notch and home bar each holds that way up. */
const SIZES: Size[] = [
  { width: 390, height: 844, insets: { top: 47, bottom: 34 } },
  { width: 844, height: 390, insets: { side: 47, bottom: 21 } },
  { width: 667, height: 375, insets: {} },
  { width: 480, height: 320, insets: { side: 47, bottom: 21 } },
  { width: 320, height: 480, insets: { top: 44, bottom: 34 } },
];
const SCALES = [1, 1.3] as const;
/**
 * While fixing a miss: `REACH_ONLY=player` or `dm` runs one side's sweep,
 * `REACH_SIZES=480x320,844x390` and `REACH_SCALES=1.3` narrow it, and
 * `REACH_SHOTS=1` keeps a screenshot of each miss.
 */
const ONLY = process.env.REACH_ONLY ?? "";
const ONLY_SIZES = process.env.REACH_SIZES?.split(",") ?? null;
const ONLY_SCALES = process.env.REACH_SCALES?.split(",").map(Number) ?? null;
const MISS_SHOTS = process.env.REACH_SHOTS === "1";
const sizes = (): Size[] => (ONLY_SIZES ? SIZES.filter((s) => ONLY_SIZES.includes(`${s.width}x${s.height}`)) : SIZES);
/** Steps skipped because the bars and notices leave no map to select a token on, which a viewer could not do either. */
const skipped: string[] = [];
const FIGHTS = ["none", "fight", "own turn"] as const;
const TOOLS = ["none", "Ruler", "Select several"] as const;
type Fight = (typeof FIGHTS)[number];
type Tool = (typeof TOOLS)[number];

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
let cookie = "";
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");

const run = {
  roomId: "",
  roomName: `E2E reach ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID(), entryId: randomUUID() },
  goblin: { id: randomUUID(), entryId: randomUUID() },
  hag: { id: randomUUID(), entryId: randomUUID() },
  kept: Array.from({ length: 10 }, () => randomUUID()),
};

function actor(hp: number) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 15,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 9,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Each miss, named by the step that found it, so one run lists them all. */
const misses: string[] = [];
let shotPage: Page | null = null;
async function miss(text: string): Promise<void> {
  misses.push(text);
  if (MISS_SHOTS && shotPage) await shots.take(shotPage, `reach-miss-${misses.length}`);
  if (MISS_SHOTS) console.error(`MISS ${misses.length}: ${text}`);
  if (MISS_SHOTS && shotPage)
    console.error(
      "  state",
      JSON.stringify(
        await shotPage.evaluate(() => {
          const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null; hidden?: boolean }> } }).document;
          return {
            bars: Array.from(d.querySelectorAll("[data-bar-mode]")).map((b) => [b.getAttribute("aria-label"), b.getAttribute("data-bar-mode"), b.hidden]),
            rows: Array.from(d.querySelectorAll("header button")).map((b) => b.getAttribute("aria-label")).filter((n) => n && /^(Roll asked|Concentration|Rolls)/.test(n)),
            dialogs: Array.from(d.querySelectorAll('[role="dialog"]')).map((b) => b.getAttribute("aria-label")),
          };
        }),
      ),
    );
}
async function expectReach(label: string, what: string, target: Locator): Promise<void> {
  if (await wholeInReach(target)) return;
  await miss(`${label}: ${what} is cut off or takes no tap`);
}

async function view(page: Page, cdp: CDPSession, size: Size): Promise<void> {
  const i = size.insets;
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: i.top ?? 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(250);
}

async function reloadAt(page: Page, scale: number): Promise<void> {
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

function sizeLabel(size: Size, scale: number): string {
  return `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
}

/** Whether the map takes a tap at a point. */
function canvasAt(page: Page, p: { x: number; y: number }): Promise<boolean> {
  return page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName === "CANVAS", [p.x, p.y] as const);
}

/** A point of empty map that takes a tap, or null where the bars leave none. */
function emptyPoint(page: Page, taken: { x: number; y: number }[]): Promise<{ x: number; y: number } | null> {
  return page.evaluate((taken) => {
    const g = globalThis as unknown as {
      innerWidth: number;
      innerHeight: number;
      Konva: { stages: { x(): number; y(): number; scaleX(): number; container(): { getBoundingClientRect(): { left: number; top: number } } }[] };
      document: { elementFromPoint(x: number, y: number): { tagName: string } | null };
    };
    const stage = g.Konva.stages[0]!;
    const box = stage.container().getBoundingClientRect();
    for (let y = 2; y < g.innerHeight; y += 4) {
      for (let x = 2; x < g.innerWidth; x += 4) {
        const cell = { x: (x - box.left - stage.x()) / stage.scaleX(), y: (y - box.top - stage.y()) / stage.scaleX() };
        if (taken.some((t) => Math.abs(t.x + 0.5 - cell.x) < 2 && Math.abs(t.y + 0.5 - cell.y) < 2)) continue;
        if (g.document.elementFromPoint(x, y)?.tagName === "CANVAS") return { x, y };
      }
    }
    return null;
  }, taken);
}

function barFrame(page: Page): Locator {
  return page.locator('[role="dialog"][data-bar-mode]');
}

function alertsOverlay(page: Page): Locator {
  return page.getByRole("dialog", { name: "Alerts" });
}

/** Puts the alerts over the screen away, where they are open, so the next step starts from the row. */
async function closeOverlay(page: Page): Promise<void> {
  if ((await alertsOverlay(page).count()) > 0) {
    await alertsOverlay(page).getByRole("button", { name: "Close", exact: true }).tap();
    await alertsOverlay(page).waitFor({ state: "detached" });
  }
}

/** The tool's buttons whole in reach: the Ruler's with its capped list scrolled to its foot, or Select several's. */
async function expectTool(page: Page, tool: Tool, label: string): Promise<void> {
  if (tool === "none") return;
  const options = page.getByRole("toolbar", { name: tool === "Ruler" ? "Ruler options" : "Select options" });
  if (!(await options.isVisible())) {
    await miss(`${label}: the ${tool} options are gone`);
    return;
  }
  if (tool === "Ruler") {
    await options.evaluate((el) => {
      const box = el as unknown as { scrollTop: number; scrollHeight: number };
      box.scrollTop = box.scrollHeight;
    });
    await page.waitForTimeout(150);
  }
  const bar = await options.boundingBox();
  if (!bar) return;
  const buttons = options.getByRole("button");
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = buttons.nth(i);
    const r = await b.boundingBox();
    // Only what the bar shows whole: it clips the rest itself, and they scroll into reach.
    if (!r || r.y < bar.y + 1 || r.y + r.height > bar.y + bar.height - 1) continue;
    await expectReach(label, `the ${tool} button "${(await b.getAttribute("aria-label")) ?? (await b.textContent())?.trim()}"`, b);
  }
}

async function expectEndTurn(page: Page, label: string): Promise<void> {
  const endTurn = page.locator("header").getByRole("button", { name: "End turn", exact: true });
  if ((await endTurn.count()) > 0 && (await endTurn.isVisible())) await expectReach(label, "End turn", endTurn);
}

async function expectBarClose(page: Page, label: string): Promise<void> {
  const frame = barFrame(page);
  if ((await frame.count()) === 0 || !(await frame.isVisible())) return;
  await expectReach(label, "the bar's Close", frame.getByRole("button", { name: "Close", exact: true }).first());
}

/**
 * Sets the tool: nothing, the Ruler, or Select several with its bar
 * hidden by a tap off (or by its Close where the bars leave no map). With
 * nothing, the token's bar is opened, so its Close is checked too.
 */
async function setTool(page: Page, tool: Tool, label: string, select: () => Promise<boolean>): Promise<boolean> {
  const tools = page.locator('nav[aria-label="Tools"]');
  // The toolbar's tools always take a tap: nothing waiting may stand over them.
  for (const name of ["Select", "Ruler"]) {
    await expectReach(label, `the ${name} tool`, tools.getByRole("button", { name }).first());
  }
  if (tool === "Ruler") {
    await tools.getByRole("button", { name: "Ruler" }).tap();
    await page.getByRole("toolbar", { name: "Ruler options" }).waitFor();
    return true;
  }
  await tools.getByRole("button", { name: "Select" }).first().tap({ force: true });
  if (!(await select())) {
    skipped.push(`${label}: no map left to select the token on`);
    // With nothing to select, the step still runs without the bar. Select several has nothing to hold.
    return tool === "none";
  }
  if (tool === "none") return true;
  await barFrame(page).getByRole("button", { name: "Select several", exact: true }).tap();
  await page.getByRole("toolbar", { name: "Select options" }).waitFor();
  const off = await emptyPoint(page, []);
  if (off) await page.touchscreen.tap(off.x, off.y);
  else await barFrame(page).getByRole("button", { name: "Close", exact: true }).first().tap();
  await barFrame(page).waitFor({ state: "detached" });
  return true;
}

/** Back to the plain Select tool with nothing selected. */
async function clearTool(page: Page): Promise<void> {
  const done = page.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Done", exact: true });
  if ((await done.count()) > 0 && (await done.isVisible())) await done.tap();
  const close = barFrame(page).getByRole("button", { name: "Close", exact: true }).first();
  if ((await close.count()) > 0 && (await close.isVisible())) await close.tap();
  await page.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select" }).first().tap();
}

async function setFight(fight: Fight): Promise<void> {
  // Ending a fight that is not running is refused, which is fine here.
  await ops.send({ t: "encounter.end" }).catch(() => undefined);
  if (fight === "none") return;
  // The DM's goblin acts first in a plain fight; Thorn first on the player's own turn.
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: run.goblin.entryId, tokenId: run.goblin.id, value: fight === "own turn" ? 10 : 18 },
      { id: run.thorn.entryId, tokenId: run.thorn.id, value: fight === "own turn" ? 18 : 15 },
      { id: run.hag.entryId, tokenId: run.hag.id, value: 5 },
    ],
  });
  await ops.send({ t: "encounter.next" });
}

// ------------------------------------------------ the player: a roll asked of Thorn

const ROLL_CARD = "The DM asks for a roll";
const CHIP = /^Wis save: waiting for your roll\./;

async function selectThorn(): Promise<boolean> {
  const find = player.getByRole("button", { name: "Find my token" });
  if ((await find.count()) > 0 && (await find.isVisible())) await find.tap();
  await player.waitForTimeout(300);
  const p = await pagePoint(player, playerSocket.state!.scenes[run.sceneId]!.bounds, { x: 8.5, y: 6.5 });
  if (!(await canvasAt(player, p))) return false;
  await player.touchscreen.tap(p.x, p.y);
  await player.getByRole("dialog", { name: "Thorn actions" }).waitFor({ timeout: 3000 }).catch(() => undefined);
  return (await player.getByRole("dialog", { name: "Thorn actions" }).count()) > 0;
}

/** The way back to the roll put off: the overlay's chip, the column's row, or the chip. */
async function playerWayBack(): Promise<Locator | null> {
  const row = player.getByRole("button", { name: /^Roll asked/ });
  if ((await row.count()) > 0 && (await row.first().isVisible())) return row.first();
  const chip = player.getByRole("button", { name: CHIP });
  if ((await chip.count()) > 0 && (await chip.first().isVisible())) return chip.first();
  return null;
}

async function expectRollCard(label: string): Promise<void> {
  const card = player.getByRole("dialog", { name: ROLL_CARD });
  await expectReach(label, "what to roll", card.getByText(/^The DM asks for/).first());
  await expectReach(label, "Later", card.getByRole("button", { name: "Later" }));
  await expectReach(label, "the total", card.getByLabel(/^Total /).first());
  await expectReach(label, "Send", card.getByRole("button", { name: "Send", exact: true }).first());
}

async function playerStep(label: string, tool: Tool): Promise<void> {
  const card = player.getByRole("dialog", { name: ROLL_CARD });
  await player.waitForTimeout(300);
  await expectBarClose(player, `${label}, with the bar open`);
  await expectEndTurn(player, `${label}, with the bar open`);
  // The card, where it shows; else the way back to it.
  if (!(await card.isVisible())) {
    const way = await playerWayBack();
    if (!way) {
      await miss(`${label}: neither the card nor a way back to it shows`);
      return;
    }
    await expectReach(label, "the way back to the card", way);
    await way.tap();
    await card.waitFor({ timeout: 3000 }).catch(() => undefined);
    await player.waitForTimeout(250);
  }
  if (!(await card.isVisible())) {
    await miss(`${label}: the way back opened no card`);
    return;
  }
  await expectRollCard(label);
  await card.getByRole("button", { name: "Later" }).tap();
  await card.waitFor({ state: "detached" });
  await player.waitForTimeout(300);
  // Put off: the way back, End turn and the tool's buttons, all at once.
  const way = await playerWayBack();
  if (!way) {
    await miss(`${label}: after Later, no way back to the card shows`);
    await closeOverlay(player);
    return;
  }
  await expectReach(label, "the way back after Later", way);
  // The alerts over the screen are modal and close with one tap, so they may stand over End turn and the tool.
  if ((await alertsOverlay(player).count()) === 0) {
    await expectEndTurn(player, `${label}, after Later`);
    await expectTool(player, tool, `${label}, after Later`);
  }
  await way.tap();
  await card.waitFor({ timeout: 3000 }).catch(() => undefined);
  await player.waitForTimeout(250);
  if (!(await card.isVisible())) {
    await miss(`${label}: the way back after Later opened no card`);
    return;
  }
  await expectRollCard(`${label}, opened again`);
  await card.getByRole("button", { name: "Later" }).tap();
  await card.waitFor({ state: "detached" });
  await closeOverlay(player);
}

// ------------------------------------------------ the DM: a concentration check for the Hag

async function selectHag(): Promise<boolean> {
  const fit = dm.getByRole("button", { name: "Fit the map to the screen" });
  if ((await fit.count()) > 0 && (await wholeInReach(fit))) await fit.tap();
  await dm.waitForTimeout(300);
  const p = await pagePoint(dm, dmSocket.state!.scenes[run.sceneId]!.bounds, { x: 3.5, y: 14.5 });
  if (!(await canvasAt(dm, p))) return false;
  await dm.touchscreen.tap(p.x, p.y);
  await dm.getByRole("dialog", { name: "Hag actions" }).waitFor({ timeout: 3000 }).catch(() => undefined);
  return (await dm.getByRole("dialog", { name: "Hag actions" }).count()) > 0;
}

async function dmStep(label: string, tool: Tool): Promise<void> {
  const checks = dm.locator('[data-alert="concentration"]');
  const before = await checks.count();
  await ops.send({ t: "actor.hp", target: { tokenId: run.hag.id }, change: { kind: "damage", amount: 1 } });
  await waitFor(`a new check, ${label}`, async () => ((await checks.count()) > before ? true : null));
  await dm.waitForTimeout(350);
  await expectBarClose(dm, `${label}, with the bar open`);
  const check = checks.first();
  const passed = check.getByRole("button", { name: "Passed", exact: true });
  if (!(await wholeInReach(passed))) {
    // Not whole where it is: the row stands for it, and its tap shows it.
    const row = dm.getByRole("button", { name: /^Concentration check/ });
    if ((await row.count()) === 0 || !(await row.first().isVisible())) {
      await miss(`${label}: the check is cut off and no row stands for it`);
      return;
    }
    await expectReach(label, "the row standing for the check", row.first());
    await expectTool(dm, tool, `${label}, with the row`);
    await row.first().tap();
    await dm.waitForTimeout(300);
  }
  await expectReach(label, "Passed", passed);
  await expectReach(label, "Failed", check.getByRole("button", { name: "Failed", exact: true }));
  if (await wholeInReach(passed)) await passed.tap();
  await closeOverlay(dm);
}

describe("raccoon-vtt short-screen reach", { timeout: 1_800_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    player = await playerContext.newPage();
    await playerSocket.attach(playerContext, player);
    playerCdp = await playerContext.newCDPSession(player);
  });

  after(async () => {
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("1. a DM's room with Pat's Thorn, a goblin, a concentrating Hag and ten of Pat's kept rulers", async () => {
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

    cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: 8, y: 6, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(run.goblin.id, { kind: "monster", name: "Goblin 1", x: 12, y: 9, disposition: "hostile", actor: { inline: actor(7) } }));
    await ops.send(token(run.hag.id, { kind: "monster", name: "Hag", x: 3, y: 14, disposition: "hostile", actor: { inline: actor(900) } }));
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.hag.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    for (const [i, id] of run.kept.entries()) {
      await ops.send({
        t: "drawing.create",
        drawing: { id, sceneId: run.sceneId, kind: "ruler", points: [1, 1, 2 + i, 1], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: run.patId, visibility: "all", anchors: [null, null] },
      });
    }

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Thorn on the player's map", () => playerSocket.state?.tokens[run.thorn.id]);
  });

  // The player: a Wisdom save asked of Thorn, with no notice and then with the server gone, which leaves "Reconnecting…" up.
  for (const scale of SCALES.filter((sc) => !ONLY_SCALES || ONLY_SCALES.includes(sc))) {
    test(`2. the player's roll, at ${Math.round(scale * 100)}%: every size, fight, notice and tool`, { skip: ONLY === "dm" }, async () => {
      await reloadAt(player, scale);
      shotPage = player;
      const before = misses.length;
      let steps = 0;
      for (const fight of FIGHTS) {
        await setFight(fight);
        const id = randomUUID();
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await waitFor("the roll on the player's side", () => playerSocket.state?.rolls[id]);
        for (const notice of ["none", "reconnecting"] as const) {
          if (notice === "reconnecting") {
            await server.stop();
            await player.getByText(/^Reconnecting…/).first().waitFor({ timeout: 15_000 });
          }
          for (const size of sizes()) {
            await view(player, playerCdp, size);
            for (const tool of TOOLS) {
              const label = `player, ${sizeLabel(size, scale)}, ${fight === "none" ? "no fight" : fight}, ${notice === "none" ? "no notice" : "reconnecting"}, tool ${tool}`;
              if (await setTool(player, tool, label, selectThorn)) await playerStep(label, tool);
              await clearTool(player);
              steps += 1;
            }
            if (scale === 1.3 && size.width === 480) await shots.take(player, `reach-player-480x320-130-${fight.replace(" ", "-")}-${notice}`);
          }
          if (notice === "reconnecting") {
            server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
            await player.evaluate(() => (globalThis as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event("online")));
            await player.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 30_000 });
            ops.close();
            ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
            await dm.evaluate(() => (globalThis as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event("online")));
          }
        }
        await ops.send({ t: "roll.close", rollIds: [id] });
      }
      await setFight("none");
      console.error(`player at ${scale}: ${steps} steps, ${misses.length - before} misses`);
    });
  }

  // The DM: a concentration check for the Hag, with no notice and then under the Starting view notice.
  for (const scale of SCALES.filter((sc) => !ONLY_SCALES || ONLY_SCALES.includes(sc))) {
    test(`3. the DM's check, at ${Math.round(scale * 100)}%: every size, fight, notice and tool`, { skip: ONLY === "player" }, async () => {
      await reloadAt(dm, scale);
      shotPage = dm;
      const before = misses.length;
      let steps = 0;
      for (const notice of ["none", "Starting view"] as const) {
        for (const size of sizes()) {
          await view(dm, dmCdp, size);
          if (notice === "Starting view" && (await dm.getByRole("group", { name: "Starting view" }).count()) === 0) {
            await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
            await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Scenes", exact: true }).click();
            await dm.locator('section[aria-label="Scenes"]').getByRole("button", { name: "Save current view" }).tap();
            await dm.getByRole("group", { name: "Starting view" }).waitFor();
          }
          for (const fight of ["none", "fight"] as const) {
            await setFight(fight);
            for (const tool of TOOLS) {
              const label = `DM, ${sizeLabel(size, scale)}, ${fight === "none" ? "no fight" : "fight"}, ${notice === "none" ? "no notice" : "Starting view"}, tool ${tool}`;
              if (await setTool(dm, tool, label, selectHag)) await dmStep(label, tool);
              await clearTool(dm);
              steps += 1;
            }
          }
          if (scale === 1.3 && size.width === 480) await shots.take(dm, `reach-dm-480x320-130-${notice.replace(" ", "-")}`);
        }
        if (notice === "Starting view") await dm.getByRole("group", { name: "Starting view" }).getByRole("button", { name: "Cancel" }).tap();
      }
      await setFight("none");
      console.error(`DM at ${scale}: ${steps} steps, ${misses.length - before} misses`);
    });
  }

  test("4. nothing is out of reach", () => {
    if (skipped.length > 0) console.error(`skipped ${skipped.length} steps with no map left to select on:\n${skipped.join("\n")}`);
    assert.deepEqual(misses, []);
  });
});
