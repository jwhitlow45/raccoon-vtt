import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, readCamera, reopenRoom, Shots, SocketWatch, startServer, tapCell, Touches, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * A player on a phone after the visual design pass, from the live play
 * review of that pass (LPD-PLAYER), on the real server serving the
 * production build:
 *
 * - The Log fits a narrow phone at a large interface size: Send, Export,
 *   the recipient picker and the times stay on screen (LPD-PLAYER-3).
 * - On the player's own turn with the turn timer over, the phone's turn
 *   band keeps End Turn on screen and the name and "Your turn" clear of
 *   the timer, at 130% on 390 and 360 px phones (LPD-PLAYER-4), and on a
 *   320 px phone too, where the name still keeps a few letters
 *   (LPD-DMPHONE-2).
 * - A total typed into a roll card, and the choice picked in it, survive
 *   turning the phone between portrait and landscape, which moves the card
 *   between the screen's foot and the alerts column (LPD-PLAYER-1). Focus
 *   stays in the Total field being typed in.
 * - A panel picked from the list of panels starts at its sheet's heading,
 *   and "All panels" goes back to its tile (LPD-PLAYER-5). The token
 *   bar's Details starts at the token's sheet too (LPD-DESK-7).
 * - A DM's blackout keeps the player's selection and the HP typed into the
 *   token bar, which hides behind the pause and comes back after it
 *   (LPD-PLAYER-7).
 * - The docked token action bar (docs/design-v1-bar-dock.md section 7): on
 *   its side the phone docks the bar at the bottom right, left of a sheet,
 *   and a roll card never meets it (LPD-PLAYER-2). Pans, pinches and a
 *   held press leave it open and a quick tap off closes it. Select
 *   several's tap off hides it and keeps the group, and Back then lets go.
 *   The Multi-select bar stays one row, and on screens too short for the
 *   bar it opens compact, where every button still takes a tap.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-playerphone-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PORTRAIT = { width: 390, height: 844 };
/** The layout px the band's name always keeps (client/features/encounter/band.ts BAND_NAME_MIN_PX). */
const BAND_NAME_MIN_PX = 36;
const LANDSCAPE = { width: 844, height: 390 };
const CARD = "The DM asks for a roll";
/** A plain stat block for Thorn, so a card knows its bonus and draws no bonus field (docs/design-v1-roll-request.md 5.2). */
const THORN_STATS = { abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 12, cha: 10 }, saves: [], skills: {}, adjust: {}, defenses: {}, rolls: [] };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E player phone ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  thorn: { id: randomUUID(), characterId: randomUUID(), entryId: randomUUID() },
  goblin: { id: randomUUID(), entryId: randomUUID() },
  patId: "",
};

/** A box as the page measured it, in CSS pixels. */
type Box = { left: number; right: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = { tagName: string; textContent: string | null; getAttribute(name: string): string | null; getBoundingClientRect(): Box };
type PageGlobals = {
  innerWidth: number;
  document: { querySelector(selector: string): (El & { querySelectorAll(selector: string): ArrayLike<El> }) | null };
};

function actor(hp = 20) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
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

/** Sets the window and the interface size, then loads the room again. */
async function setUp(view: { width: number; height: number; scale: number }): Promise<void> {
  await player.setViewportSize({ width: view.width, height: view.height });
  await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await reopenRoom(player);
  await player.getByRole("status", { name: "Connected" }).first().waitFor();
  await player.locator(".konvajs-content").first().waitFor();
}

/** The phone's notch and home bar, as the browser reports them to `env()`. */
async function insets(sides: { top?: number; side?: number; bottom?: number }): Promise<void> {
  await playerCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: sides.top ?? 0, bottom: sides.bottom ?? 0, left: sides.side ?? 0, right: sides.side ?? 0 } });
}

type Rect = { left: number; top: number; right: number; bottom: number };

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** The token bar's frame, whichever token or group it is for. */
function barFrame(page: Page): Locator {
  return page.locator('[role="dialog"][data-bar-mode]');
}

/** The page point at a cell's center, after checking the map takes a tap there. */
async function cellPoint(cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const p = await pagePoint(player, playerSocket.state!.scenes[run.sceneId]!.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
  const at = await hit(p);
  assert.equal(at, "CANVAS", `the map does not take a tap at cell ${cell.x},${cell.y}, at ${Math.round(p.x)},${Math.round(p.y)}: ${at} does`);
  return p;
}

/**
 * A point of empty map that takes a tap: the first, scanning the window
 * from the top left in 4 px steps, that the canvas holds, two cells or
 * more from every token. A docked bar may sit beside the alerts column,
 * over the map's middle, and a compact one leaves an upright phone only
 * the strip under the top bar, so no fixed cell is sure to be clear.
 */
function emptyPoint(page: Page): Promise<{ x: number; y: number }> {
  const taken = Object.values(playerSocket.state?.tokens ?? {}).map((t) => ({ x: t.x, y: t.y }));
  return page.evaluate((taken) => {
    type Node = { tagName: string };
    const g = globalThis as unknown as {
      innerWidth: number;
      innerHeight: number;
      Konva: { stages: { x(): number; y(): number; scaleX(): number; container(): { getBoundingClientRect(): { left: number; top: number } } }[] };
      document: { elementFromPoint(x: number, y: number): Node | null };
    };
    const stage = g.Konva.stages[0]!;
    const box = stage.container().getBoundingClientRect();
    for (let y = 2; y < g.innerHeight; y += 4) {
      for (let x = 2; x < g.innerWidth; x += 4) {
        // Past the scene's edge is empty map too, which a tap reaches as one inside it.
        const cell = { x: (x - box.left - stage.x()) / stage.scaleX(), y: (y - box.top - stage.y()) / stage.scaleX() };
        if (taken.some((t) => Math.abs(t.x + 0.5 - cell.x) < 2 && Math.abs(t.y + 0.5 - cell.y) < 2)) continue;
        if (g.document.elementFromPoint(x, y)?.tagName === "CANVAS") return { x, y };
      }
    }
    throw new Error("no empty map takes a tap");
  }, taken);
}

/** What takes a tap at a point: the tag, or "bar" when the token bar does. */
function hit(p: { x: number; y: number }): Promise<string | null> {
  return player.evaluate(([x, y]) => {
    type Node = { tagName: string; closest(s: string): Node | null };
    const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null } }).document.elementFromPoint(x, y);
    return el ? (el.closest('[role="dialog"][data-bar-mode]') ? "bar" : el.tagName) : null;
  }, [p.x, p.y] as const);
}

/** One finger through the browser's touch input: down, along the points given, and up, with a pause where asked. */
async function touch(points: { x: number; y: number }[], holdMs = 0): Promise<void> {
  const [first, ...rest] = points;
  assert.ok(first);
  const touches = new Touches(playerCdp);
  await touches.start([first]);
  // The first event after the landing comes once the hold is over, by the page's clock too.
  let after = Math.max(holdMs, 16);
  for (const p of rest) {
    await touches.move([p], after);
    after = 16;
  }
  await touches.end([], after);
}

/** A line of points from one to the other, as a finger moves. */
function along(from: { x: number; y: number }, to: { x: number; y: number }, steps = 10): { x: number; y: number }[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));
}

/** What takes a tap at a control's middle: the words of the button there, or the tag of whatever else is. */
async function buttonAt(control: Locator): Promise<string | null> {
  const r = await rectOf(control);
  return player.evaluate(([x, y]) => {
    type Node = { tagName: string; textContent: string | null; closest(s: string): Node | null };
    const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null } }).document.elementFromPoint(x, y);
    return el?.closest("button")?.textContent?.trim() ?? el?.tagName ?? null;
  }, [(r.left + r.right) / 2, (r.top + r.bottom) / 2] as const);
}

/** Whether the turn band shows under the top bar's row: the turn strip's name stands below the room's name. */
async function bandShows(): Promise<boolean> {
  const strip = player.locator("header [data-rvtt-strip-name]").first();
  if ((await strip.count()) === 0) return false;
  return (await rectOf(strip)).top >= (await rectOf(player.locator("header h1"))).bottom - 0.5;
}

/**
 * A roll card at the screen's foot keeps what to roll, its Later, and its
 * first total and Send whole on screen and taking taps, or, on a screen
 * too short for that, it folds and the alerts column's "Roll asked" row
 * stands in, whose tap opens it with all four in reach at once.
 */
async function cardInReach(label: string, shot: string): Promise<void> {
  if (!(await card(player).isVisible())) {
    const row = player.getByRole("button", { name: /^Roll asked/ });
    await row.waitFor();
    await shots.take(player, `${shot}-row`);
    await row.tap();
    await card(player).waitFor();
    await player.waitForTimeout(200);
  }
  const box = await rectOf(card(player));
  const height = player.viewportSize()!.height;
  assert.ok(box.top >= -0.5 && box.bottom <= height + 0.5, `${label}: the roll card runs off the screen: ${JSON.stringify(box)}`);
  const title = card(player).getByText(/^The DM asks for/);
  // Roll is the card's primary while the creature waits (docs/design-v1-roll-request.md 5.2), so it is in reach too (W7B-P-8).
  const roll = card(player).getByRole("button", { name: /^Roll .* for / }).first();
  const parts: (readonly [string, Locator])[] = [
    ["what to roll", title],
    ["Later", card(player).getByRole("button", { name: "Later" })],
    ...((await roll.count()) > 0 ? [["Roll", roll] as const] : []),
    ["the total", card(player).getByLabel(/^Total /).first()],
    ["Send", card(player).getByRole("button", { name: "Send", exact: true }).first()],
  ];
  const t = await rectOf(title);
  if (t.top >= box.top - 0.5 && t.bottom <= box.bottom + 0.5) {
    for (const [name, part] of parts) assert.ok(await wholeInReach(part), `${label}: ${name} is cut off or takes no tap`);
  } else {
    // The last step (docs/design-v1-roll-request.md 5.7): where even the screen's top cannot hold the question, Later and the
    // answer block with its roll row at once, the header stops sticking and the whole card scrolls, so each is read and tapped in turn.
    const scrolls = await card(player).evaluate((el) => {
      // Only the card at the screen's foot, portaled to the body, has that step.
      const node = el as unknown as { parentElement: unknown; firstElementChild: { style: { position: string } } | null };
      return node.parentElement === (globalThis as unknown as { document: { body: unknown } }).document.body && node.firstElementChild?.style.position !== "sticky";
    });
    assert.equal(scrolls, true, `${label}: what to roll is cut off, and the card is not at its last step: ${JSON.stringify({ t, box })}`);
    for (const [name, part] of parts) {
      await part.scrollIntoViewIfNeeded();
      assert.ok(await wholeInReach(part), `${label}: ${name}, scrolled to, is cut off or takes no tap`);
    }
  }
  await shots.take(player, shot);
}

/**
 * The way back to a roll card put off with Later: its chip, or the alerts
 * column's "Roll asked" row that stands for the chip where the column has
 * no room for it. It must show whole and take a tap as things stand:
 * `.tap()` scrolls the column first, which once hid a chip cut to a strip.
 */
async function wayBack(label: string, chip: RegExp): Promise<Locator> {
  const row = player.getByRole("button", { name: /^Roll asked/ });
  const way = (await row.isVisible()) ? row : player.getByRole("button", { name: chip });
  assert.ok(await wholeInReach(way), `${label}: the way back to the card is cut off or takes no tap`);
  return way;
}

/** Each button in the bar, scrolled into view, takes a tap at its middle: the names of those that do not. */
async function unreachable(): Promise<string[]> {
  const buttons = barFrame(player).locator("button");
  const missed: string[] = [];
  for (let i = 0; i < (await buttons.count()); i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible())) continue;
    await b.scrollIntoViewIfNeeded();
    const r = await rectOf(b);
    const at = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    if ((await hit(at)) !== "bar") missed.push((await b.getAttribute("aria-label")) ?? (await b.textContent()) ?? "?");
  }
  return missed;
}

/** Every control in a panel's sheet that runs past the window's edges, by its name. */
function offScreen(page: Page, region: string): Promise<string[]> {
  return page.evaluate((name) => {
    const g = globalThis as unknown as PageGlobals;
    const sheet = g.document.querySelector(`section[aria-label="${name}"]`);
    if (!sheet) return [`no sheet named ${name}`];
    return Array.from(sheet.querySelectorAll("button, input, select, time"))
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent ?? el.tagName, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.right - r.left > 0 && (r.left < -0.5 || r.right > g.innerWidth + 0.5))
      .map(({ name, r }) => `${name} at ${Math.round(r.left)}-${Math.round(r.right)}`);
  }, region);
}

/**
 * The turn band's parts on the player's turn: the name and "Your turn",
 * the timer, End Turn, and the window's width. Each text's own box is
 * read, not its column's, since a column too narrow for its text lets the
 * text run over what stands beside it.
 */
function band(page: Page) {
  return page.evaluate(() => {
    const g = globalThis as unknown as PageGlobals;
    const header = g.document.querySelector("header");
    if (!header) throw new Error("no top bar");
    const box = (el: El | undefined) => (el ? { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right } : null);
    const all = Array.from(header.querySelectorAll("*"));
    return {
      width: g.innerWidth,
      name: box(all.find((el) => el.getAttribute("data-rvtt-strip-name") !== null)),
      yourTurn: box(all.find((el) => el.textContent === "Your turn" && el.tagName === "SPAN")),
      timer: box(all.find((el) => el.getAttribute("role") === "timer")),
      endTurn: box(all.find((el) => el.tagName === "BUTTON" && el.textContent === "End turn")),
      timerText: all.find((el) => el.getAttribute("role") === "timer")?.textContent ?? "",
    };
  });
}

function card(page: Page) {
  return page.getByRole("dialog", { name: CARD });
}

/** What has focus: its tag, and its name by its aria-label or its text. */
function focused(page: Page): Promise<{ tag: string; name: string }> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement;
    return { tag: a?.tagName.toLowerCase() ?? "", name: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim() };
  });
}

describe("raccoon-vtt player on a phone after the design pass", { timeout: 240_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    playerContext = await browser.newContext({ viewport: PORTRAIT, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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

  test("1. a DM's room with Pat's Thorn and a goblin, Pat on a phone", async () => {
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

    // Pat joins from the phone, whose cookies the request shares.
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    const patId = ((await done.json()) as { member: { id: string } }).member.id;
    run.patId = patId;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: 8, y: 6, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(run.goblin.id, { kind: "monster", name: "Goblin 1", x: 12, y: 9, disposition: "hostile", actor: { inline: actor(7) } }));

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Thorn on the player's map", () => playerSocket.state?.tokens[run.thorn.id]);
  });

  for (const view of [
    { width: 360, height: 740, scale: 1.3 },
    { width: 320, height: 568, scale: 1.15 },
  ]) {
    const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
    test(`2. the Log keeps Send, Export, the recipient and the times on screen: ${label} (LPD-PLAYER-3)`, async () => {
      await setUp(view);
      await player.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
      await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Log/ }).tap();
      await player.getByRole("region", { name: "Log" }).waitFor();
      const log = player.getByRole("region", { name: "Log" });
      await log.getByRole("textbox", { name: "Message" }).fill(`Hello from ${label}`);
      assert.deepEqual(await offScreen(player, "Log"), [], "the Log ran past the window");
      await log.getByRole("button", { name: "Send", exact: true }).tap();
      await log.getByText(`Hello from ${label}`).waitFor();
      if (view.width === 360) await shots.take(player, "playerphone-log-360-130");
      await player.getByRole("button", { name: "Close Log" }).tap();
    });
  }

  test("3. time is up on the player's turn: End turn stays on screen at 130% and the name keeps a few letters (LPD-PLAYER-4, LPD-DMPHONE-2)", async () => {
    await ops.send({ t: "room.update", settings: { turnTimerSec: 4 } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.goblin.entryId, tokenId: run.goblin.id, value: 18 },
        { id: run.thorn.entryId, tokenId: run.thorn.id, value: 15 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await ops.send({ t: "encounter.next" });
    for (const view of [
      { width: 390, height: 844, scale: 1.3 },
      { width: 360, height: 740, scale: 1.3 },
      { width: 320, height: 568, scale: 1.3 },
      { width: 390, height: 844, scale: 1 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(view);
      await player.getByRole("button", { name: "End turn" }).waitFor();
      // The time past the turn needs room of its own: "Time’s up +0:05" and the like.
      await waitFor(`time up in the band, ${label}`, async () => /Time's up\s*\+/.test((await band(player)).timerText) || null, 15_000);
      const b = await band(player);
      assert.ok(b.name && b.yourTurn && b.timer && b.endTurn, `${label}: the band is missing a part: ${JSON.stringify(b)}`);
      assert.ok(b.endTurn.right <= b.width + 0.5 && b.endTurn.left >= -0.5, `${label}: End turn runs off the screen: ${JSON.stringify(b)}`);
      assert.ok(b.name.right <= b.timer.left + 0.5, `${label}: the name runs over the timer: ${JSON.stringify(b)}`);
      assert.ok(b.yourTurn.right <= b.timer.left + 0.5, `${label}: "Your turn" runs over the timer: ${JSON.stringify(b)}`);
      assert.ok(b.timer.right <= b.endTurn.left + 0.5, `${label}: the timer runs under End turn: ${JSON.stringify(b)}`);
      // The band is zoomed by the interface size, so its layout px are this many screen px.
      assert.ok(b.name.right - b.name.left >= BAND_NAME_MIN_PX * view.scale - 0.5, `${label}: the name keeps too little: ${JSON.stringify(b)}`);
      if (view.width === 360) await shots.take(player, "playerphone-band-time-up-360-130");
      if (view.width === 320) await shots.take(player, "playerphone-band-time-up-320-130");
    }

    // End turn keeps to the screen while it waits on the server too: stacked at 320 px at 130%, on one line at 360 px
    // at 115% (P3-ASTRA-02, P3R-5). Offline, the op waits for a socket: Chrome's offline mode stalls the open one, which
    // the client gives up on after its heartbeat goes unanswered (smoke.e2e.ts), and the answer waits until the page is
    // back online.
    for (const view of [
      { width: 320, height: 568, scale: 1.3 },
      { width: 360, height: 740, scale: 1.15 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      // The last check ended Thorn's turn: the goblin's turn passes back to Thorn.
      if (dmSocket.state?.encounter?.activeEntryId !== run.thorn.entryId) {
        await waitFor("the goblin's turn", () => dmSocket.state?.encounter?.activeEntryId === run.goblin.entryId || null);
        await ops.send({ t: "encounter.next" });
      }
      await setUp(view);
      await player.getByRole("button", { name: "End turn" }).waitFor();
      await waitFor(`time up in the band, ${label}`, async () => /Time's up\s*\+/.test((await band(player)).timerText) || null, 15_000);
      playerConsole.expectSocketFailures = true;
      const closesBefore = playerSocket.closes;
      await playerContext.setOffline(true);
      await waitFor("the player's socket to drop", () => playerSocket.closes > closesBefore || null, 45_000);
      const endTurn = player.getByRole("button", { name: /End turn$/ });
      await endTurn.tap();
      await waitFor("End turn waiting on the server", async () => ((await endTurn.getAttribute("aria-busy")) === "true" ? true : null));
      const held = await band(player);
      assert.ok(held.endTurn && held.endTurn.right <= held.width + 0.5 && held.endTurn.left >= -0.5, `${label}: End turn runs off the screen while it waits: ${JSON.stringify(held)}`);
      await shots.take(player, `playerphone-end-turn-waiting-${view.width}-${Math.round(view.scale * 100)}`);
      await playerContext.setOffline(false);
      await endTurn.waitFor({ state: "detached", timeout: 45_000 });
      await player.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 30_000 });
      playerConsole.expectSocketFailures = false;
    }
    await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
    await ops.send({ t: "encounter.end" });
  });

  test("4. a total typed into the roll card, the choice picked and focus in the field survive turning the phone (LPD-PLAYER-1)", async () => {
    await setUp({ ...PORTRAIT, scale: 1 });
    const id = randomUUID();
    await ops.send({
      t: "roll.ask",
      request: { id, test: { kind: "save", choices: [{ ability: "dex" }, { ability: "str" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] },
    });
    await card(player).getByText("The DM asks for a Dexterity or Strength saving throw.").waitFor();
    await card(player).getByRole("radiogroup", { name: "Which one you rolled" }).locator("label").filter({ hasText: "Strength" }).tap();
    await card(player).getByLabel("Total Thorn rolled").fill("16");

    for (const [view, label] of [
      [LANDSCAPE, "turned to landscape"],
      [PORTRAIT, "turned back to portrait"],
    ] as const) {
      await player.setViewportSize(view);
      // Across the screen's foot in portrait, portaled to the body, and in the alerts column in landscape: a card mounted afresh.
      const portaled = view === PORTRAIT;
      const markup = player.locator(`[role="dialog"][aria-label="${CARD}"]`);
      await waitFor(`${label}: the card in its new place`, async () => {
        const top = await markup.evaluate((el) => (el as unknown as { parentElement: unknown }).parentElement === (globalThis as unknown as { document: { body: unknown } }).document.body);
        return top === portaled;
      });
      if (!portaled && !(await card(player).isVisible())) {
        // With its roll row the card no longer fits the column on its side, so it folds behind the Roll asked row, mounted with
        // what was typed (docs/design-v1-roll-request.md 5.7). The row's tap brings it up, and the field takes focus again.
        assert.equal(await markup.locator('input[aria-label="Total Thorn rolled"]').inputValue(), "16", `${label}: the folded card lost the total`);
        await player.getByRole("button", { name: /^Roll asked/ }).tap();
        await card(player).waitFor();
        await card(player).getByLabel("Total Thorn rolled").focus();
      }
      assert.equal(await card(player).getByLabel("Total Thorn rolled").inputValue(), "16", `${label}: the typed total is gone`);
      assert.ok(await card(player).getByRole("radio", { name: "Strength" }).isChecked(), `${label}: the chosen roll is gone`);
      const focus = await player.evaluate(() => (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement?.getAttribute("aria-label") ?? null);
      assert.equal(focus, "Total Thorn rolled", `${label}: focus left the Total field`);
    }
    await shots.take(player, "playerphone-card-after-turning");
    await card(player).getByRole("button", { name: "Send", exact: true }).tap();
    await waitFor("Thorn's answer at the server", () => {
      const target = dmSocket.state?.rolls[id]?.targets[0];
      return target?.total === 16 ? target : null;
    });
    assert.equal(dmSocket.state?.rolls[id]?.targets[0]?.choice, 1, "Strength was sent");
    await ops.send({ t: "roll.close", rollIds: [id] });
  });

  test("5. a panel picked from the list starts at its sheet's heading, All panels goes back to its tile, and Details starts at the token's sheet (LPD-PLAYER-5)", async () => {
    await setUp({ ...PORTRAIT, scale: 1 });
    await player.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: "Menu", exact: true }).tap();
    await waitFor("the Menu sheet's heading focused", async () => {
      const f = await focused(player);
      return f.tag === "h2" && f.name === "Menu";
    });
    await player.getByRole("button", { name: "All panels" }).tap();
    await player.getByRole("list", { name: "Panels" }).waitFor();
    await waitFor("Menu's tile focused", async () => {
      const f = await focused(player);
      return f.tag === "button" && f.name === "Menu";
    });
    await shots.take(player, "playerphone-panels-tile-focused");
    await player.getByRole("button", { name: "Close Panels" }).tap();

    // The token bar's Details gives way to the token's sheet, which takes focus at its heading (LPD-DESK-7).
    const thorn = playerSocket.state!.tokens[run.thorn.id]!;
    await tapCell(player, dmSocket.state!.scenes[run.sceneId]!.bounds, { x: thorn.x, y: thorn.y });
    await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Details" }).tap();
    await waitFor("the Token sheet's heading focused", async () => {
      const f = await focused(player);
      return f.tag === "h2" && f.name === "Token";
    });
    await player.getByRole("button", { name: "Close Token" }).tap();
  });

  test("6. a DM's blackout keeps the player's selection and typed HP: the bar hides behind the pause and comes back after (LPD-PLAYER-7)", async () => {
    await setUp({ ...PORTRAIT, scale: 1 });
    const bounds = playerSocket.state!.scenes[run.sceneId]!.bounds;
    await tapCell(player, bounds, { x: 8, y: 6 });
    const bar = player.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    await bar.getByRole("radiogroup", { name: "What the number does" }).locator("label").filter({ hasText: "Heal" }).tap();
    await bar.getByRole("textbox", { name: "HP change" }).fill("5");

    await ops.send({ t: "view.blackout", blackout: true });
    await player.getByText("The DM has paused the game.").waitFor();
    assert.equal(await bar.count(), 0, "the bar hides behind the pause");
    await ops.send({ t: "view.blackout", blackout: false });

    await bar.waitFor();
    assert.equal(await bar.getByRole("textbox", { name: "HP change" }).inputValue(), "5", "the typed HP came back");
    assert.ok(await bar.getByRole("radio", { name: "Heal" }).isChecked(), "the mode chosen came back");
    await shots.take(player, "playerphone-bar-after-blackout");
    await bar.getByRole("button", { name: "Apply" }).tap();
    await waitFor("no HP typed after Apply", async () => ((await bar.getByRole("textbox", { name: "HP change" }).inputValue()) === "" ? true : null));

    // A bar closed and opened again outside a blackout starts empty, as it always has.
    await bar.getByRole("textbox", { name: "HP change" }).fill("3");
    await bar.getByRole("button", { name: "Close", exact: true }).tap();
    await bar.waitFor({ state: "detached" });
    await tapCell(player, bounds, { x: 8, y: 6 });
    await bar.waitFor();
    assert.equal(await bar.getByRole("textbox", { name: "HP change" }).inputValue(), "");

    // The Token sheet open over the folded bar: each keeps its own typing through a blackout (P3-ASTRA-01).
    await bar.getByRole("textbox", { name: "HP change" }).fill("4");
    await player.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: "Token", exact: true }).tap();
    const sheet = player.getByRole("region", { name: "Token" });
    await sheet.getByRole("textbox", { name: "HP change" }).fill("2");
    await ops.send({ t: "view.blackout", blackout: true });
    await player.getByText("The DM has paused the game.").waitFor();
    await ops.send({ t: "view.blackout", blackout: false });
    await sheet.getByRole("textbox", { name: "HP change" }).waitFor();
    assert.equal(await sheet.getByRole("textbox", { name: "HP change" }).inputValue(), "2", "the sheet's typing came back");
    await player.getByRole("button", { name: "Close Token" }).tap();
    await bar.waitFor();
    assert.equal(await bar.getByRole("textbox", { name: "HP change" }).inputValue(), "4", "the bar's typing came back under the sheet");
    await shots.take(player, "playerphone-bar-and-sheet-after-blackout");
    await bar.getByRole("button", { name: "Close", exact: true }).tap();
  });

  test("fu22b-pp. two whispers are said once, the DM's blackout drops them as it drops every toast, and back from it nothing is said again while a new whisper is said once (reviews FU22B-OP-3, FU22B-OP-8)", async () => {
    await setUp({ ...PORTRAIT, scale: 1 });
    for (const text of ["First whisper.", "Second whisper."]) await ops.send({ t: "log.whisper", to: [run.patId], text });
    const toasts = player.locator("[data-toast]").filter({ hasText: /First whisper\.|Second whisper\.|After the pause\./ });
    await waitFor("both whispers", async () => ((await toasts.count()) === 2 ? true : null));
    const region = player.locator("[data-rvtt-toast-status]");
    const said = () => region.evaluate((el) => el.textContent ?? "");
    await waitFor("both whispers said", async () => ((await said()).includes("Second whisper.") ? true : null));
    const times = (text: string, words: string) => text.split(words).length - 1;
    const both = await said();
    assert.ok(times(both, "First whisper.") <= 1 && times(both, "Second whisper.") === 1, `a whisper was said twice: "${both}"`);
    await ops.send({ t: "view.blackout", blackout: true });
    await player.getByText("The DM has paused the game.").waitFor();
    await ops.send({ t: "view.blackout", blackout: false });
    await player.locator(".konvajs-content").first().waitFor();
    await player.waitForTimeout(400);
    // The pause screen drops every toast, so nothing from before the pause shows after it (docs/design-v1-dm-tools.md 3.11).
    assert.equal(await toasts.count(), 0, "a whisper from before the pause came back");
    assert.equal(await said(), "", "the toasts' status region said something again after the blackout");
    await ops.send({ t: "log.whisper", to: [run.patId], text: "After the pause." });
    // Said as its toast reads, with who whispered it.
    await waitFor("the new whisper said", async () => ((await said()).includes("After the pause.") ? true : null));
    assert.equal(times(await said(), "After the pause."), 1, `the new whisper was said more than once: "${await said()}"`);
    assert.equal(await toasts.count(), 1);
    await shots.take(player, "playerphone-fu22b-whisper-after-blackout");
    await toasts.first().tap();
  });

  test("7. on its side the bar docks at the bottom right, left of an open sheet, and the roll card never meets it, on its side or upright after Show (LPD-PLAYER-2)", async () => {
    await setUp({ ...LANDSCAPE, scale: 1 });
    const bounds = playerSocket.state!.scenes[run.sceneId]!.bounds;
    await tapCell(player, bounds, { x: 8, y: 6 });
    const bar = player.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    assert.equal(await barFrame(player).getAttribute("data-bar-mode"), "dock");
    const docked = await rectOf(bar);
    const toolbar = await rectOf(player.locator('nav[aria-label="Tools"]'));
    assert.ok(Math.abs(docked.right - (LANDSCAPE.width - 8)) <= 1.5 && Math.abs(docked.bottom - (toolbar.top - 8)) <= 1.5, `the bar is not at the bottom right: ${JSON.stringify({ docked, toolbar })}`);
    await player.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    const sheet = await rectOf(player.getByRole("region", { name: "Panels" }));
    await player.waitForTimeout(150);
    const beside = await rectOf(bar);
    assert.ok(beside.right <= sheet.left - 8 + 1.5, `the bar runs under the sheet: ${JSON.stringify({ beside, sheet })}`);
    await shots.take(player, "playerphone-bar-left-of-sheet");
    await player.getByRole("button", { name: "Close Panels" }).tap();

    const id = randomUUID();
    // A check for a Thorn with a stat block: a card with its roll row, a typed bonus or Fail without rolling no longer fits the
    // column on its side and folds behind the Roll asked row (docs/design-v1-roll-request.md 5.7), and this step is about the
    // card beside the bar. Step 8 takes the block away again.
    await ops.send({ t: "character.update", characterId: run.thorn.characterId, patch: { level: 1, stats: THORN_STATS } });
    await waitFor("Thorn's stat block on the player's phone", () => playerSocket.state?.characters[run.thorn.characterId]?.stats);
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "check", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    await card(player).waitFor();
    await player.waitForTimeout(200);
    assert.ok(!intersects(await rectOf(card(player)), await rectOf(bar)), "on its side, the roll card meets the bar");
    await shots.take(player, "playerphone-card-and-bar-landscape");

    // Upright, the card stands at the screen's foot, and the bar keeps above it.
    await player.setViewportSize(PORTRAIT);
    await player.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await player.getByRole("button", { name: "Show Thorn actions" }).tap();
    await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
    await bar.waitFor();
    await card(player).waitFor();
    await player.waitForTimeout(200);
    assert.ok(!intersects(await rectOf(card(player)), await rectOf(bar)), "upright after Show, the roll card meets the bar");
    await shots.take(player, "playerphone-card-and-bar-portrait");
    await card(player).getByRole("button", { name: "Later" }).tap();
    await ops.send({ t: "roll.close", rollIds: [id] });
  });

  test("8. by touch: a pan, a pinch and a held press leave the bar open, a quick tap off closes it, a token switches it, and the toolbar, the top bar and an alert card leave it", async () => {
    await setUp({ ...LANDSCAPE, scale: 1 });
    const id = randomUUID();
    // A check, whose card fits the column on its side (step 7).
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "check", choices: [{ ability: "con" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    await card(player).waitFor();
    const thorn = await cellPoint({ x: 8, y: 6 });
    await touch([thorn]);
    const bar = player.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();

    try {
      const empty = await emptyPoint(player);
      await touch(along(empty, { x: empty.x + 20, y: empty.y + 10 }));
      const pinch = new Touches(playerCdp);
      await pinch.start([{ x: empty.x, y: empty.y, id: 1 }, { x: empty.x + 40, y: empty.y, id: 2 }]);
      for (let i = 1; i <= 6; i++) await pinch.move([{ x: empty.x - i * 4, y: empty.y, id: 1 }, { x: empty.x + 40 + i * 4, y: empty.y, id: 2 }]);
      await pinch.end();
      await player.waitForTimeout(150);
      assert.ok(await bar.isVisible(), "a pan or a pinch closed the bar");
      // The DM's page hears the ping: the server sends a member's own ping to the others.
      const pings = dmSocket.received.length;
      await touch([await emptyPoint(player)], 900);
      await waitFor("the ping at the DM's page", () => dmSocket.received.slice(pings).some((f) => f.includes('"k":"ping"')) || null, 3_000);
      assert.ok(await bar.isVisible(), "a held press that pinged closed the bar");

      await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select" }).tap();
      await player.locator("header h1").tap();
      await card(player).getByText(/asks for a Constitution check/).tap();
      await player.waitForTimeout(150);
      assert.ok(await bar.isVisible(), "a tap on the toolbar, the top bar or an alert card closed the bar");

      // With the card put off, the bar docks in its corner again, clear of the goblin.
      await card(player).getByRole("button", { name: "Later" }).tap();
      await touch([await emptyPoint(player)]);
      await bar.waitFor({ state: "detached" });
      await player.getByRole("button", { name: "Fit the map to the screen" }).tap();
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await bar.waitFor();
      await touch([await cellPoint({ x: 12, y: 9 })]);
      await player.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
      await touch([await emptyPoint(player)]);
      await barFrame(player).waitFor({ state: "detached" });
    } finally {
      await ops.send({ t: "roll.close", rollIds: [id] });
      await ops.send({ t: "character.update", characterId: run.thorn.characterId, patch: { stats: null } });
    }
  });

  test("9. Multi-select by touch: a tap that moves under 8 px hides the bar and keeps the group, a box drag adds and shows it, and Back then ends the mode and stays in the room", async () => {
    const extra = randomUUID();
    await ops.send({ t: "token.create", token: { id: extra, sceneId: run.sceneId, kind: "monster", name: "Goblin 2", x: 3, y: 4, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: actor(7) } } });
    await waitFor("Goblin 2 on the player's map", () => playerSocket.state?.tokens[extra]);
    await setUp({ ...LANDSCAPE, scale: 1 });
    await touch([await cellPoint({ x: 8, y: 6 })]);
    await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
    await touch([await cellPoint({ x: 12, y: 9 })]);
    await player.getByRole("dialog", { name: "2 selected tokens" }).waitFor();

    const off = await emptyPoint(player);
    await touch([off, { x: off.x + 3, y: off.y + 2 }, { x: off.x + 4, y: off.y + 3 }]);
    await barFrame(player).waitFor({ state: "detached" });
    await player.getByRole("toolbar", { name: "Select options" }).getByText("2 selected.", { exact: true }).filter({ visible: true }).waitFor();

    // A box drawn over Goblin 2 adds it and shows the bar again.
    const from = await cellPoint({ x: 1, y: 3 });
    const to = await cellPoint({ x: 5, y: 6 });
    await touch(along(from, to));
    await player.getByRole("dialog", { name: "3 selected tokens" }).waitFor();

    await touch([await emptyPoint(player)]);
    await barFrame(player).waitFor({ state: "detached" });
    const url = player.url();
    await player.goBack();
    await player.getByRole("toolbar", { name: "Select options" }).waitFor({ state: "detached" });
    assert.equal(await barFrame(player).count(), 0, "Back left a bar");
    assert.equal(player.url(), url, "Back left the room");
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await ops.send({ t: "token.delete", tokenId: extra });
  });

  for (const view of [
    { width: 320, height: 480, scale: 1.3, insets: { top: 44, bottom: 34 } },
    { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 } },
    { width: 844, height: 390, scale: 1.3, insets: { side: 47, bottom: 21 } },
  ]) {
    const label = `${view.width} x ${view.height} at 130%`;
    test(`10. the Multi-select row stands on one line with Actions and Done in it: ${label}`, async () => {
      await insets(view.insets);
      await setUp(view);
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
      // Off the bar, where the map shows: on an upright phone, whose overlay spans the screen, only the strip under the top bar.
      await player.waitForTimeout(200);
      await touch([await emptyPoint(player)]);
      await barFrame(player).waitFor({ state: "detached" });
      const options = player.getByRole("toolbar", { name: "Select options" });
      await options.getByRole("button", { name: "Actions", exact: true }).waitFor();
      // Actions and Done stay in the row at every size, and its controls stand on one line (docs/design-v1-tool-options.md 9.1).
      const row = options.locator("[data-options-row]");
      for (const name of ["Actions", "Done"]) assert.equal(await row.getByRole("button", { name, exact: true }).count(), 1, `${label}: ${name} left the row`);
      const middles = await row.locator(":scope > [data-rvtt-slot]").evaluateAll((slots) =>
        slots.map((el) => {
          const r = (el as unknown as { getBoundingClientRect(): { top: number; bottom: number } }).getBoundingClientRect();
          return (r.top + r.bottom) / 2;
        }),
      );
      assert.ok(Math.max(...middles) - Math.min(...middles) <= 1, `${label}: the Multi-select row stands on more than one line`);
      await shots.take(player, `playerphone-several-row-${view.width}x${view.height}`);
      await options.getByRole("button", { name: "Done", exact: true }).tap();
      await insets({});
    });
  }

  test("11. on screens too short for the bar, with Multi-select, the turn band and a roll waiting, it opens compact: the roll stays in sight, every button takes a tap, and Panels comes back after Close", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: randomUUID(), tokenId: run.goblin.id, value: 18 },
        { id: randomUUID(), tokenId: run.thorn.id, value: 15 },
      ],
    });
    // At 844 x 390 at 130% Multi-select's row stands in the toolbar's own row, so the bar has its 151 px and docks (docs/design-v1-tool-options.md 10.3).
    {
      await insets({ side: 47, bottom: 21 });
      await setUp({ width: 844, height: 390, scale: 1.3 });
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
      await player.getByRole("toolbar", { name: "Select options" }).waitFor();
      assert.equal(await player.getByRole("toolbar", { name: "Select options" }).getAttribute("data-rvtt-arrangement"), "pair");
      assert.equal(await barFrame(player).getAttribute("data-bar-mode"), "dock", "844 x 390 at 130%: the bar does not dock");
      await player.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Done", exact: true }).tap();
    }
    for (const view of [
      { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 } },
      { width: 320, height: 480, scale: 1.3, insets: { top: 44, bottom: 34 } },
    ]) {
      const label = `${view.width} x ${view.height} at 130%`;
      await insets(view.insets);
      await setUp(view);
      await touch([await cellPoint({ x: 8, y: 6 })]);
      const bar = player.getByRole("dialog", { name: "Thorn actions" });
      await bar.getByRole("button", { name: "Multi-select", exact: true }).tap();
      const id = randomUUID();
      await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
      // The roll's card yields to the compact bar at the screen's foot, or waits in the column, and either way the summary row stands for it.
      const row = player.getByRole("button", { name: /^Roll asked/ });
      await row.waitFor();
      assert.equal(await barFrame(player).getAttribute("data-bar-mode"), "compact", `${label}: the bar is not compact`);
      assert.ok(!intersects(await rectOf(row), await rectOf(bar)), `${label}: the summary row meets the bar`);
      assert.equal(await card(player).isVisible(), false, `${label}: the roll card shows under the bar`);
      await shots.take(player, `playerphone-compact-${view.width}x${view.height}`);
      assert.deepEqual(await unreachable(), [], `${label}: bar buttons that take no tap`);

      // Where the overlay covers the toolbar, it takes what would have reached Panels, and on an upright phone a tool too.
      const panels = player.locator('nav[aria-label="Tools"] button[title="Panels"]');
      const p = await rectOf(panels);
      const over = await rectOf(bar);
      const centre = { x: (p.left + p.right) / 2, y: (p.top + p.bottom) / 2 };
      if (intersects(p, over)) {
        assert.equal(await hit(centre), "bar", `${label}: Panels shows through the overlay`);
        if (view.width < view.height) {
          const tool = await rectOf(player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select" }));
          assert.equal(await hit({ x: (tool.left + tool.right) / 2, y: (tool.top + tool.bottom) / 2 }), "bar", `${label}: a tool shows through the overlay`);
        }
      }

      // The summary row's tap hides the bar and shows the roll card: at its foot, in the column, or with the alerts over the screen where the column has no room, which Close puts away.
      if (await row.isVisible()) {
        await row.tap();
        await bar.waitFor({ state: "detached" });
        await card(player).waitFor();
        await card(player).getByRole("button", { name: "Later" }).tap();
        const alerts = player.getByRole("dialog", { name: "Alerts" });
        if ((await alerts.count()) > 0) await alerts.getByRole("button", { name: "Close", exact: true }).tap();
        await player.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Actions", exact: true }).tap();
        await bar.waitFor();
      }
      await bar.getByRole("button", { name: "Close", exact: true }).tap();
      await bar.waitFor({ state: "detached" });
      assert.notEqual(await hit(centre), "bar", `${label}: the closed bar still covers Panels`);
      await panels.tap();
      await player.getByRole("region", { name: "Panels" }).waitFor();
      await player.getByRole("button", { name: "Close Panels" }).tap();
      await ops.send({ t: "roll.close", rollIds: [id] });
      await player.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.uiScale"));
    }
    await insets({});
    await ops.send({ t: "encounter.end" });
  });

  for (const view of [
    { width: 390, height: 844, scale: 1, insets: {} },
    { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 } },
    { width: 320, height: 480, scale: 1.3, insets: { top: 44, bottom: 34 } },
  ]) {
    const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
    test(`12. with a roll card waiting at the screen's foot, Multi-select's Actions takes a tap after a tap off, and the card's title, Later, total and Send show whole and take a tap, or the summary row stands in and opens it so: ${label}`, async () => {
      await insets(view.insets);
      await setUp(view);
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
      const id = randomUUID();
      try {
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.waitForTimeout(300);
        await touch([await emptyPoint(player)]);
        await barFrame(player).waitFor({ state: "detached" });
        await player.waitForTimeout(300);
        const options = player.getByRole("toolbar", { name: "Select options" });
        const actions = options.getByRole("button", { name: "Actions", exact: true });
        assert.equal(await buttonAt(actions), "Actions", `${label}: something covers Actions while the roll waits`);
        if (await card(player).isVisible()) assert.ok(!intersects(await rectOf(card(player)), await rectOf(options)), `${label}: the roll card covers the Multi-select bar`);
        await cardInReach(label, `playerphone-card-in-reach-several-${view.width}x${view.height}`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
        await actions.tap();
        await player.getByRole("dialog", { name: "Thorn actions" }).waitFor();
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        await insets({});
      }
    });

    test(`13. with the Ruler's options showing, a roll card at the screen's foot keeps its title, Later, total and Send whole in reach, or the summary row stands in and opens it so: ${label}`, async () => {
      await insets(view.insets);
      await setUp(view);
      await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
      await player.getByRole("toolbar", { name: "Ruler options" }).waitFor();
      const id = randomUUID();
      try {
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.waitForTimeout(400);
        await cardInReach(label, `playerphone-card-in-reach-ruler-${view.width}x${view.height}`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        await insets({});
      }
    });
  }

  for (const fight of [false, true]) {
    const label = `480 x 320 at 130% ${fight ? "in a fight, under the turn band" : "with no fight"}`;
    test(`14. ${label}, a long roll question opened from the Roll asked row shows its question, Later, total and Send, at once or in turn as the card scrolls, each taking a tap, and is answered`, async () => {
      if (fight) {
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.goblin.id, value: 18 },
            { id: randomUUID(), tokenId: run.thorn.id, value: 15 },
          ],
        });
      }
      await insets({ side: 47, bottom: 21 });
      const id = randomUUID();
      try {
        await setUp({ width: 480, height: 320, scale: 1.3 });
        await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
        await player.getByRole("toolbar", { name: "Ruler options" }).waitFor();
        assert.equal(await bandShows(), fight, `${label}: the turn band ${fight ? "is missing" : "shows"}`);
        // Two saves to choose from: a question of three lines at this size, and a choice above the total.
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }, { ability: "str" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.getByRole("button", { name: /^Roll asked/ }).waitFor();
        await player.waitForTimeout(400);
        assert.equal(await card(player).isVisible(), false, `${label}: the card shows on a screen too short for it`);
        await cardInReach(label, `playerphone-card-in-reach-${fight ? "fight" : "no-fight"}-480x320`);
        const answer = card(player);
        const total = answer.getByLabel("Total Thorn rolled");
        const send = answer.getByRole("button", { name: "Send", exact: true });
        await answer.getByRole("radiogroup", { name: "Which one you rolled" }).locator("label").filter({ hasText: "Strength" }).tap();
        await total.fill("13");
        // With its roll row the card may scroll here (docs/design-v1-roll-request.md 5.7), so Send is scrolled to first.
        await send.scrollIntoViewIfNeeded();
        assert.ok(await wholeInReach(send), `${label}: Send is cut off or takes no tap once the total is in`);
        await send.tap();
        await waitFor(`Thorn's answer at the server, ${label}`, () => (dmSocket.state?.rolls[id]?.targets[0]?.total === 13 ? true : null));
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        if (fight) await ops.send({ t: "encounter.end" });
        await insets({});
      }
    });
  }

  for (const view of [
    { width: 480, height: 320, insets: { side: 47, bottom: 21 }, fight: false },
    { width: 480, height: 320, insets: { side: 47, bottom: 21 }, fight: true },
    { width: 320, height: 480, insets: { top: 44, bottom: 34 }, fight: true },
  ]) {
    const label = `${view.width} x ${view.height} at 130%${view.fight ? " in a fight" : ""}`;
    const shot = `${view.width}x${view.height}${view.fight ? "-fight" : ""}`;
    test(`15. with the Ruler on a screen too short for a roll card, after Later the chip, or the row that stands for it, shows whole and takes a tap, which opens the card at once: ${label}`, async () => {
      if (view.fight) {
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.goblin.id, value: 18 },
            { id: randomUUID(), tokenId: run.thorn.id, value: 15 },
          ],
        });
      }
      await insets(view.insets);
      const id = randomUUID();
      try {
        await setUp({ width: view.width, height: view.height, scale: 1.3 });
        await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
        await player.getByRole("toolbar", { name: "Ruler options" }).waitFor();
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.waitForTimeout(400);
        await cardInReach(label, `playerphone-card-before-later-${shot}`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
        await player.waitForTimeout(300);
        const way = await wayBack(label, /^WIS save: waiting for your roll\./);
        await shots.take(player, `playerphone-way-back-${shot}`);
        await way.tap();
        await player.waitForTimeout(400);
        assert.ok(await card(player).isVisible(), `${label}: the tap left the card folded`);
        await cardInReach(`${label}, after Later`, `playerphone-card-back-${shot}`);
        await waitFor(`focus on the card, ${label}`, async () => ((await focused(player)).name === "The DM asks for a roll" ? true : null));
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        if (view.fight) await ops.send({ t: "encounter.end" });
        await insets({});
      }
    });
  }

  for (const scale of [1, 1.3]) {
    const label = `480 x 320 at ${Math.round(scale * 100)}%`;
    // No insets: with a landscape phone's, the narrower column folds the chip into its summary row, which already puts the bar away.
    test(`16. with Multi-select's bar open over a roll chip, the chip's tap puts the bar away, keeping the group, and opens the card in reach with focus: ${label}`, async () => {
      const id = randomUUID();
      try {
        await setUp({ width: 480, height: 320, scale });
        await touch([await cellPoint({ x: 8, y: 6 })]);
        await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.waitForTimeout(400);
        await cardInReach(label, `playerphone-several-card-before-later-480x320-${Math.round(scale * 100)}`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
        const options = player.getByRole("toolbar", { name: "Select options" });
        await options.getByRole("button", { name: "Actions", exact: true }).tap();
        await barFrame(player).waitFor();
        const chip = player.getByRole("button", { name: /^WIS save: waiting for your roll\./ });
        assert.ok(await wholeInReach(chip), `${label}: the chip is out of reach with the bar open`);
        await shots.take(player, `playerphone-several-bar-over-chip-480x320-${Math.round(scale * 100)}`);

        await chip.tap();
        await player.waitForTimeout(400);
        assert.ok(await card(player).isVisible(), `${label}: the chip's tap left the card folded behind the bar`);
        assert.equal(await barFrame(player).count(), 0, `${label}: the bar stayed open over the card`);
        await cardInReach(`${label}, after a chip`, `playerphone-several-card-from-chip-480x320-${Math.round(scale * 100)}`);
        await waitFor(`focus on the card, ${label}`, async () => ((await focused(player)).name === "The DM asks for a roll" ? true : null));
        // The group is still held: Multi-select still counts Thorn, and once the card is put off, Actions brings his bar back.
        assert.equal(await options.getByText("1 selected.", { exact: true }).filter({ visible: true }).count(), 1, `${label}: Multi-select let go of the group`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
        await options.getByRole("button", { name: "Actions", exact: true }).tap();
        await player.getByRole("dialog", { name: "Thorn actions" }).waitFor();
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
      }
    });
  }

  test("17. in a fight at 480 x 320 at 130% with Multi-select, after Later the chip, or the row that stands for it, shows whole and takes a tap without covering Actions, and opens the card", async () => {
    const label = "480 x 320 at 130% in a fight with Multi-select";
    await insets({ side: 47, bottom: 21 });
    const id = randomUUID();
    try {
      await setUp({ width: 480, height: 320, scale: 1.3 });
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
      // The tap off hides the bar and keeps the group, before the turn band takes the map's last room.
      await touch([await emptyPoint(player)]);
      await barFrame(player).waitFor({ state: "detached" });
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.goblin.id, value: 18 },
          { id: randomUUID(), tokenId: run.thorn.id, value: 15 },
        ],
      });
      await player.waitForTimeout(300);
      assert.equal(await bandShows(), true, `${label}: the turn band is missing`);
      await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
      await player.waitForTimeout(400);
      await cardInReach(label, "playerphone-several-fight-card-before-later-480x320");
      await card(player).getByRole("button", { name: "Later" }).tap();
      await card(player).waitFor({ state: "detached" });
      await player.waitForTimeout(300);
      const options = player.getByRole("toolbar", { name: "Select options" });
      const actions = options.getByRole("button", { name: "Actions", exact: true });
      assert.ok(await wholeInReach(actions), `${label}: something covers Actions after Later`);
      const way = await wayBack(label, /^WIS save: waiting for your roll\./);
      await shots.take(player, "playerphone-several-fight-way-back-480x320");
      await way.tap();
      await player.waitForTimeout(400);
      assert.ok(await card(player).isVisible(), `${label}: the tap left the card folded`);
      await cardInReach(`${label}, after Later`, "playerphone-several-fight-card-back-480x320");
      await waitFor(`focus on the card, ${label}`, async () => ((await focused(player)).name === "The DM asks for a roll" ? true : null));
      assert.equal(await options.getByText("1 selected.", { exact: true }).filter({ visible: true }).count(), 1, `${label}: Multi-select let go of the group`);
      await card(player).getByRole("button", { name: "Later" }).tap();
      await card(player).waitFor({ state: "detached" });
      assert.ok(await wholeInReach(actions), `${label}: something covers Actions after the second Later`);
    } finally {
      await ops.send({ t: "roll.close", rollIds: [id] });
      await ops.send({ t: "encounter.end" });
      await insets({});
    }
  });

  for (const tool of ["Multi-select", "Ruler"] as const) {
    const label = `480 x 320 at 130% on Thorn's turn with ${tool}`;
    const shot = tool === "Ruler" ? "ruler" : "several";
    test(`18. on the player's own turn in a fight at 480 x 320 at 130%, with a roll put off with Later, End turn and the way back to the card are both whole in reach: ${tool}`, async () => {
      await insets({ side: 47, bottom: 21 });
      const id = randomUUID();
      try {
        await setUp({ width: 480, height: 320, scale: 1.3 });
        if (tool === "Ruler") {
          await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
          await player.getByRole("toolbar", { name: "Ruler options" }).waitFor();
        } else {
          await touch([await cellPoint({ x: 8, y: 6 })]);
          await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
          await touch([await emptyPoint(player)]);
          await barFrame(player).waitFor({ state: "detached" });
        }
        // Thorn acts first, so once the fight starts End turn stands in the band.
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.thorn.id, value: 18 },
            { id: randomUUID(), tokenId: run.goblin.id, value: 15 },
          ],
        });
        await ops.send({ t: "encounter.next" });
        const endTurn = player.locator("header").getByRole("button", { name: "End turn", exact: true });
        await endTurn.waitFor();
        await player.waitForTimeout(300);
        assert.equal(await bandShows(), true, `${label}: the turn band is missing`);
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.waitForTimeout(400);
        await cardInReach(label, `playerphone-own-turn-card-before-later-${shot}-480x320`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
        await player.waitForTimeout(300);
        const way = await wayBack(label, /^WIS save: waiting for your roll\./);
        assert.ok(await wholeInReach(endTurn), `${label}: End turn is covered with the way back showing`);
        const options = player.getByRole("toolbar", { name: `${tool === "Ruler" ? "Ruler" : "Select"} options` });
        for (const name of tool === "Ruler" ? ["Keep this ruler on the map", "Clear"] : ["Actions", "Done"]) {
          assert.ok(await wholeInReach(options.getByRole("button", { name, exact: true })), `${label}: ${name} is covered with the way back showing`);
        }
        await shots.take(player, `playerphone-own-turn-way-back-${shot}-480x320`);
        await way.tap();
        await player.waitForTimeout(400);
        assert.ok(await card(player).isVisible(), `${label}: the tap left the card folded`);
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        await ops.send({ t: "encounter.end" });
        await insets({});
      }
    });
  }

  for (const scale of [1, 1.3]) {
    const label = `480 x 320 at ${Math.round(scale * 100)}% with kept rulers`;
    const shot = `480x320-${Math.round(scale * 100)}`;
    test(`19. with the kept rulers behind their chip and a roll put off with Later, the way back covers no control in the row nor ⋯, and the kept rulers in their pop-up are in reach: ${label}`, async () => {
      await insets({ side: 47, bottom: 21 });
      const id = randomUUID();
      const kept = Array.from({ length: 10 }, () => randomUUID());
      try {
        for (const [i, drawingId] of kept.entries()) {
          await ops.send({
            t: "drawing.create",
            drawing: { id: drawingId, sceneId: run.sceneId, kind: "ruler", points: [1, 1, 2 + i, 1], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: run.patId, visibility: "all", anchors: [null, null] },
          });
        }
        await setUp({ width: 480, height: 320, scale });
        await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
        const options = player.getByRole("toolbar", { name: "Ruler options" });
        await options.waitFor();
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await player.waitForTimeout(400);
        await cardInReach(label, `playerphone-kept-rulers-card-before-later-${shot}`);
        await card(player).getByRole("button", { name: "Later" }).tap();
        await card(player).waitFor({ state: "detached" });
        await player.waitForTimeout(300);
        await wayBack(label, /^WIS save: waiting for your roll\./);
        await shots.take(player, `playerphone-kept-rulers-way-back-${shot}`);
        // Every control in the row, and ⋯, takes a tap with the way back showing.
        const controls = options.locator("[data-options-row] > [data-rvtt-slot] button, [data-rvtt-more] button");
        assert.ok((await controls.count()) > 0, `${label}: the row shows no control`);
        for (let i = 0; i < (await controls.count()); i++) {
          const b = controls.nth(i);
          assert.ok(await wholeInReach(b), `${label}: the way back covers ${(await b.getAttribute("aria-label")) ?? (await b.textContent())}`);
        }
        // The kept rulers in their chip's pop-up, or in ⋯ where the chip waits there, each in reach once the pop-up scrolls to it.
        const chip = options.locator("[data-options-row]").getByRole("button", { name: /^Kept/ });
        if ((await chip.count()) > 0) await chip.tap();
        else await options.getByRole("button", { name: "More options" }).tap();
        const remove = player.getByRole("dialog").getByRole("button", { name: /^Remove the kept ruler/ });
        assert.equal(await remove.count(), kept.length, `${label}: the pop-up lists every kept ruler`);
        for (let i = 0; i < (await remove.count()); i++) {
          const b = remove.nth(i);
          await b.evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "nearest" }));
          assert.ok(await wholeInReach(b), `${label}: kept ruler ${i + 1} is out of reach in the pop-up`);
        }
        await player.keyboard.press("Escape");
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        for (const drawingId of kept) await ops.send({ t: "drawing.delete", drawingId });
        await insets({});
      }
    });
  }

  /** The token bar as drawn: its mode, box, whether it cuts its content short, and how many of its buttons show whole in its scroller. */
  function barFacts(bar: Locator): Promise<{ mode: string | null; top: number; height: number; clipped: boolean; whole: number }> {
    return bar.evaluate((el) => {
      type Box = { top: number; bottom: number; height: number };
      type Node = { getBoundingClientRect(): Box; scrollHeight: number; clientHeight: number; scrollTop: number };
      const frame = el as unknown as Node & { getAttribute(name: string): string | null; querySelector(s: string): Node; querySelectorAll(s: string): ArrayLike<Node> };
      const scroller = frame.querySelector("[data-bar-scroll]");
      const view = scroller.getBoundingClientRect();
      const whole = Array.from(frame.querySelectorAll("button")).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.height > 0 && r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5;
      }).length;
      const r = frame.getBoundingClientRect();
      return { mode: frame.getAttribute("data-bar-mode"), top: r.top, height: r.height, clipped: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 4, whole };
    });
  }

  /** Conditions enough to make Thorn's bar taller than its smaller size anywhere on a phone. */
  const MANY = ["blinded", "charmed", "deafened", "frightened", "poisoned", "prone", "restrained", "stunned"] as const;

  /**
   * Pans the map so Thorn stands at the window's middle, where his bar gets
   * the least room on either side, and opens it.
   */
  async function openThornAtMiddle(view: { width: number; height: number }): Promise<Locator> {
    const thorn = await cellPoint({ x: 8, y: 6 });
    const from = await emptyPoint(player);
    await touch(along(from, { x: from.x, y: from.y + (view.height / 2 - thorn.y) }, 20));
    await touch([await cellPoint({ x: 8, y: 6 })]);
    const bar = player.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    await player.waitForTimeout(300);
    return bar;
  }

  for (const view of [
    { width: 390, height: 844 },
    { width: 440, height: 956 },
  ]) {
    const label = `${view.width} x ${view.height}`;
    test(`bs-1. at ${label} Larger, just left of Close, grows the bar under Thorn to show more of it with Thorn still on the map, Smaller puts it back, and a reload keeps Larger (docs/design-v1-bar-dock.md 1.5)`, async () => {
      const KEY = "rvtt.tokenBarLarger";
      const target = { characterId: run.thorn.characterId };
      const effects = MANY.map((key) => ({ id: randomUUID(), key }));
      for (const effect of effects) await ops.send({ t: "actor.effect.add", target, effect });
      await player.evaluate((key) => localStorage.removeItem(key), KEY);
      await setUp({ ...view, scale: 1 });
      let bar = player.getByRole("dialog", { name: "Thorn actions" });
      try {
        bar = await openThornAtMiddle(view);
        const before = await barFacts(bar);
        assert.equal(before.mode, "span", `${label}: the bar does not span`);
        assert.ok(before.clipped, `${label}: the bar shows all it holds already (${before.height} px), so Larger has nothing to show`);

        // Its button keeps the 44 px target and stands just left of Close, in its row.
        const larger = bar.getByRole("button", { name: "Larger", exact: true });
        const close = bar.getByRole("button", { name: "Close", exact: true });
        const [l, c] = [await rectOf(larger), await rectOf(close)];
        assert.ok(l.right - l.left >= 44 - 0.5 && l.bottom - l.top >= 44 - 0.5, `${label}: Larger is under 44 px: ${JSON.stringify(l)}`);
        assert.ok(l.right <= c.left + 0.5 && c.left - l.right <= 8.5, `${label}: Larger is not just left of Close: ${JSON.stringify({ l, c })}`);
        assert.ok(Math.abs(l.top - c.top) <= 1 && Math.abs(l.bottom - c.bottom) <= 1, `${label}: Larger is out of Close's row`);

        await larger.tap();
        await bar.getByRole("button", { name: "Smaller", exact: true }).waitFor();
        await player.waitForTimeout(300);
        const grown = await barFacts(bar);
        assert.ok(grown.height >= before.height + 80, `${label}: Larger grew the bar from ${before.height} to only ${grown.height} px`);
        assert.ok(grown.whole > before.whole, `${label}: Larger shows no more of the bar: ${before.whole} buttons whole, then ${grown.whole}`);
        assert.ok(grown.height <= (view.height * 2) / 3 + 2, `${label}: the bar took more than two thirds of the screen: ${grown.height} px`);
        // Thorn stays on the map, clear of the bar, the top bars and the toolbar.
        assert.equal(await hit(await pagePoint(player, playerSocket.state!.scenes[run.sceneId]!.bounds, { x: 8.5, y: 6.5 })), "CANVAS", `${label}: Thorn is out of view`);
        await shots.take(player, `playerphone-bs1-larger-${view.width}`);

        await bar.getByRole("button", { name: "Smaller", exact: true }).tap();
        await bar.getByRole("button", { name: "Larger", exact: true }).waitFor();
        await player.waitForTimeout(300);
        const back = await barFacts(bar);
        assert.ok(Math.abs(back.top - before.top) <= 1 && Math.abs(back.height - before.height) <= 1, `${label}: Smaller left the bar at ${back.top} + ${back.height}, not ${before.top} + ${before.height}`);

        // The device keeps Larger for the next bar, through a reload.
        await bar.getByRole("button", { name: "Larger", exact: true }).tap();
        await bar.getByRole("button", { name: "Smaller", exact: true }).waitFor();
        assert.equal(await player.evaluate((key) => localStorage.getItem(key), KEY), "1");
        await setUp({ ...view, scale: 1 });
        bar = await openThornAtMiddle(view);
        assert.equal(await bar.getByRole("button", { name: "Smaller", exact: true }).count(), 1, `${label}: after the reload the bar offers Larger again`);
        const reloaded = await barFacts(bar);
        assert.ok(Math.abs(reloaded.height - grown.height) <= 1, `${label}: after the reload the bar opened at ${reloaded.height} px, not its larger ${grown.height}`);
        await shots.take(player, `playerphone-bs1-reloaded-${view.width}`);
      } finally {
        await player.evaluate((key) => localStorage.removeItem(key), KEY);
        if (await bar.isVisible()) await bar.getByRole("button", { name: "Close", exact: true }).tap();
        for (const effect of effects) await ops.send({ t: "actor.effect.remove", target, effectId: effect.id });
      }
    });
  }

  test("bs-2. at 390 x 844 with Larger on, a drag of Thorn one cell down hides his bar and shows it again where the drop leaves it, a cell shorter, and the map does not move a second time (review BS-O2)", async () => {
    const view = { width: 390, height: 844 };
    const KEY = "rvtt.tokenBarLarger";
    const target = { characterId: run.thorn.characterId };
    const effects = MANY.map((key) => ({ id: randomUUID(), key }));
    for (const effect of effects) await ops.send({ t: "actor.effect.add", target, effect });
    await player.evaluate((key) => localStorage.removeItem(key), KEY);
    await setUp({ ...view, scale: 1 });
    let bar = player.getByRole("dialog", { name: "Thorn actions" });
    try {
      bar = await openThornAtMiddle(view);
      await bar.getByRole("button", { name: "Larger", exact: true }).tap();
      await bar.getByRole("button", { name: "Smaller", exact: true }).waitFor();
      await player.waitForTimeout(300);
      const cam = await readCamera(player);
      assert.ok(cam, "the map has no camera");
      const before = await barFacts(bar);

      // Down, so the bar under him loses a cell of room, which a second move of the map would give back.
      await touch(along(await cellPoint({ x: 8, y: 6 }), await pagePoint(player, playerSocket.state!.scenes[run.sceneId]!.bounds, { x: 8.5, y: 7.5 }), 10));
      await waitFor("Thorn one cell down", () => playerSocket.state?.tokens[run.thorn.id]?.y === 7 || null);
      await bar.waitFor();
      await player.waitForTimeout(500);
      // The map stays where the drop left it, and the bar hangs a cell lower under Thorn, still Larger.
      const now = await readCamera(player);
      assert.ok(now && Math.abs(now.x - cam.x) <= 0.5 && Math.abs(now.y - cam.y) <= 0.5 && now.scale === cam.scale, `the map moved after the drop: ${JSON.stringify({ cam, now })}`);
      const dropped = await barFacts(bar);
      assert.ok(Math.abs(dropped.top - (before.top + cam.scale)) <= 1.5, `the bar's top went from ${before.top} to ${dropped.top}, not a cell of ${cam.scale} px down`);
      assert.ok(Math.abs(dropped.height - (before.height - cam.scale)) <= 1.5, `the bar went from ${before.height} to ${dropped.height} px tall, not a cell shorter`);
      assert.equal(await bar.getByRole("button", { name: "Smaller", exact: true }).count(), 1, "the bar came back Smaller-labelled no more");
      await player.waitForTimeout(500);
      const later = await readCamera(player);
      assert.ok(later && later.y === now.y && Math.abs((await barFacts(bar)).top - dropped.top) <= 0.5, "the map or the bar moved after the drop settled");
    } finally {
      await player.evaluate((key) => localStorage.removeItem(key), KEY);
      if (await bar.isVisible()) await bar.getByRole("button", { name: "Close", exact: true }).tap();
      for (const effect of effects) await ops.send({ t: "actor.effect.remove", target, effectId: effect.id });
      await ops.send({ t: "token.move", tokenId: run.thorn.id, x: 8, y: 6 });
    }
  });

  test("bs-3. at 390 x 844 with Larger on, a tap on another token while Thorn's bar is open opens its bar larger, and its Smaller puts the bar and the map back as they were before Thorn's Larger, as does the group's bar as Multi-select gathers the other token and Thorn's as it lets go of it (reviews LP19-BS-1 and LP19-OPUS-4)", async () => {
    const view = { width: 390, height: 844 };
    const KEY = "rvtt.tokenBarLarger";
    const target = { characterId: run.thorn.characterId };
    const effects = MANY.map((key) => ({ id: randomUUID(), key }));
    // A second token of Thorn's, a cell east of him, with his conditions and so his tall bar.
    const echo = randomUUID();
    for (const effect of effects) await ops.send({ t: "actor.effect.add", target, effect });
    await ops.send({ t: "token.create", token: { id: echo, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Echo", x: 9, y: 6, disposition: "ally", actor: { ref: run.thorn.characterId } } });
    await player.evaluate((key) => localStorage.removeItem(key), KEY);
    await setUp({ ...view, scale: 1 });
    let bar = player.getByRole("dialog", { name: "Thorn actions" });
    const echoBar = player.getByRole("dialog", { name: "Echo actions" });
    const groupBar = player.getByRole("dialog", { name: "2 selected tokens" });
    const done = player.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Done", exact: true });
    try {
      bar = await openThornAtMiddle(view);
      const cam = await readCamera(player);
      assert.ok(cam, "the map has no camera");
      const before = await barFacts(bar);
      await bar.getByRole("button", { name: "Larger", exact: true }).tap();
      await bar.getByRole("button", { name: "Smaller", exact: true }).waitFor();
      await player.waitForTimeout(300);
      const grown = await barFacts(bar);
      assert.ok(grown.height >= before.height + 80, `Larger grew Thorn's bar from ${before.height} to only ${grown.height} px`);

      // Echo, beside him, opens on the map Thorn's Larger moved, as large as his bar was.
      await touch([await cellPoint({ x: 9, y: 6 })]);
      await echoBar.waitFor();
      await player.waitForTimeout(500);
      assert.equal(await echoBar.getByRole("button", { name: "Smaller", exact: true }).count(), 1, "Echo's bar did not open Larger");
      const opened = await barFacts(echoBar);
      assert.ok(Math.abs(opened.height - grown.height) <= 1, `Echo's bar opened at ${opened.height} px, not Thorn's larger ${grown.height}`);
      await shots.take(player, "playerphone-bs3-echo-larger");

      // Its Smaller undoes Thorn's move too: the bar and the map are back as they were before Larger.
      await echoBar.getByRole("button", { name: "Smaller", exact: true }).tap();
      await echoBar.getByRole("button", { name: "Larger", exact: true }).waitFor();
      await player.waitForTimeout(300);
      const now = await readCamera(player);
      assert.ok(now && Math.abs(now.y - cam.y) <= 0.5, `Smaller on Echo's bar left the map at ${now?.y}, not ${cam.y} where it stood before Thorn's Larger`);
      const back = await barFacts(echoBar);
      assert.ok(Math.abs(back.height - before.height) <= 1, `Smaller left Echo's bar at ${back.height} px, not ${before.height}`);
      await shots.take(player, "playerphone-bs3-echo-smaller");

      // Thorn again, Larger, then Multi-select gathers Echo: the group's bar opens on the map Thorn's Larger moved, and its Smaller undoes that move too (review LP19-OPUS-4).
      const sizeTo = async (frame: Locator, press: "Larger" | "Smaller") => {
        await frame.getByRole("button", { name: press, exact: true }).tap();
        await frame.getByRole("button", { name: press === "Larger" ? "Smaller" : "Larger", exact: true }).waitFor();
        await player.waitForTimeout(300);
      };
      const mapBack = async (what: string) => {
        const at = await readCamera(player);
        assert.ok(at && Math.abs(at.y - cam.y) <= 0.5, `Smaller on ${what} left the map at ${at?.y}, not ${cam.y} where it stood before Larger`);
      };
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await bar.waitFor();
      await player.waitForTimeout(500);
      await sizeTo(bar, "Larger");
      const moved = await readCamera(player);
      assert.ok(moved && Math.abs(moved.y - cam.y) > 20, `Larger on Thorn's bar moved the map from ${cam.y} only to ${moved?.y}`);
      await bar.getByRole("button", { name: "Multi-select", exact: true }).tap();
      await touch([await cellPoint({ x: 9, y: 6 })]);
      await groupBar.waitFor();
      await player.waitForTimeout(500);
      assert.equal(await groupBar.getByRole("button", { name: "Smaller", exact: true }).count(), 1, "the group's bar did not open Larger");
      await shots.take(player, "playerphone-bs3-group-larger");
      await sizeTo(groupBar, "Smaller");
      await mapBack("the group's bar");

      // Larger on the group, then Multi-select lets go of Echo: Thorn's bar takes over, and its Smaller undoes the group's move.
      await sizeTo(groupBar, "Larger");
      await touch([await cellPoint({ x: 9, y: 6 })]);
      await groupBar.waitFor({ state: "detached" });
      await bar.getByRole("button", { name: "Smaller", exact: true }).waitFor();
      await player.waitForTimeout(500);
      await shots.take(player, "playerphone-bs3-let-go-larger");
      await sizeTo(bar, "Smaller");
      await mapBack("Thorn's bar after the group");
    } finally {
      await player.evaluate((key) => localStorage.removeItem(key), KEY);
      for (const b of [bar, echoBar, groupBar]) if (await b.isVisible()) await b.getByRole("button", { name: /^(Close|Deselect all)$/ }).tap();
      if (await done.isVisible()) await done.tap();
      await ops.send({ t: "token.delete", tokenId: echo });
      for (const effect of effects) await ops.send({ t: "actor.effect.remove", target, effectId: effect.id });
    }
  });

  test("bc-a1. a reload whose sheet mark sits on the room's own history entry, with Home behind it, keeps the room and shows Connected, and the mark is gone (lib/backClose.ts)", async () => {
    // The race on purpose: a sheet's Back entry written over the room's own entry as a reload begins.
    const room = `${server.origin}/r/${run.roomId}`;
    await player.goto(`${server.origin}/`);
    await player.goto(room);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await player.evaluate(() => {
      const h = (globalThis as unknown as { history: { state: unknown; replaceState(data: unknown, unused: string): void } }).history;
      h.replaceState({ ...((h.state as object | null) ?? {}), rvttOverlay: true }, "");
    });
    await player.reload();
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(new URL(player.url()).pathname.replace("-", ""), `/r/${run.roomId}`, "the reload left the room");
    const mark = await player.evaluate(() => ((globalThis as unknown as { history: { state: Record<string, unknown> | null } }).history.state ?? {}).rvttOverlay ?? null);
    assert.equal(mark, null, "the mark stayed");
    // With the mark gone, Back leaves the room at once, for Home.
    await player.goBack();
    await player.getByRole("button", { name: "Create room" }).waitFor();
    await player.goto(room);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("20. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
  });
});
