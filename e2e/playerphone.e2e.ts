import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

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
 *   The Select several bar stays one row, and on screens too short for the
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
  await player.reload();
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
  await playerCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first.x, y: first.y }] });
  if (holdMs > 0) await player.waitForTimeout(holdMs);
  for (const p of rest) await playerCdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x, y: p.y }] });
  await playerCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
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

/**
 * Whether `target` shows whole and takes a tap as things stand, with
 * nothing scrolled first: a tap at its middle, and one just inside the
 * middle of each edge, lands on it. A control cut off by its card's foot
 * can still take a tap at its middle.
 */
async function wholeInReach(target: Locator): Promise<boolean> {
  const r = await rectOf(target);
  const x = (r.left + r.right) / 2;
  const y = (r.top + r.bottom) / 2;
  const points = [
    [x, y],
    [x, r.top + 3],
    [x, r.bottom - 3],
    [r.left + 3, y],
    [r.right - 3, y],
  ] as const;
  return target.evaluate(
    (el, at) =>
      at.every(([px, py]) => {
        const top = el.ownerDocument.elementFromPoint(px, py);
        return top !== null && el.contains(top);
      }),
    points,
  );
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
  const t = await rectOf(title);
  assert.ok(t.top >= box.top - 0.5 && t.bottom <= box.bottom + 0.5, `${label}: what to roll is cut off: ${JSON.stringify({ t, box })}`);
  for (const [name, part] of [
    ["what to roll", title],
    ["Later", card(player).getByRole("button", { name: "Later" })],
    ["the total", card(player).getByLabel(/^Total /).first()],
    ["Send", card(player).getByRole("button", { name: "Send", exact: true }).first()],
  ] as const) {
    assert.ok(await wholeInReach(part), `${label}: ${name} is cut off or takes no tap`);
  }
  await shots.take(player, shot);
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
      await waitFor(`time up in the band, ${label}`, async () => /Time’s up\s*\+/.test((await band(player)).timerText) || null, 15_000);
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
      await waitFor(`time up in the band, ${label}`, async () => /Time’s up\s*\+/.test((await band(player)).timerText) || null, 15_000);
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
      await waitFor(`${label}: the card in its new place`, async () => {
        const top = await card(player).evaluate((el) => (el as unknown as { parentElement: unknown }).parentElement === (globalThis as unknown as { document: { body: unknown } }).document.body);
        return top === portaled;
      });
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
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
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
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "con" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    await card(player).waitFor();
    const thorn = await cellPoint({ x: 8, y: 6 });
    await touch([thorn]);
    const bar = player.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();

    try {
      const empty = await emptyPoint(player);
      await touch(along(empty, { x: empty.x + 20, y: empty.y + 10 }));
      await playerCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: empty.x, y: empty.y, id: 1 }, { x: empty.x + 40, y: empty.y, id: 2 }] });
      for (let i = 1; i <= 6; i++) await playerCdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: empty.x - i * 4, y: empty.y, id: 1 }, { x: empty.x + 40 + i * 4, y: empty.y, id: 2 }] });
      await playerCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await player.waitForTimeout(150);
      assert.ok(await bar.isVisible(), "a pan or a pinch closed the bar");
      // The DM's page hears the ping: the server sends a member's own ping to the others.
      const pings = dmSocket.received.length;
      await touch([await emptyPoint(player)], 900);
      await waitFor("the ping at the DM's page", () => dmSocket.received.slice(pings).some((f) => f.includes('"k":"ping"')) || null, 3_000);
      assert.ok(await bar.isVisible(), "a held press that pinged closed the bar");

      await player.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select" }).tap();
      await player.locator("header h1").tap();
      await card(player).getByText(/asks for a Constitution saving throw/).tap();
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
    }
  });

  test("9. Select several by touch: a tap that moves under 8 px hides the bar and keeps the group, a box drag adds and shows it, and Back then ends the mode and stays in the room", async () => {
    const extra = randomUUID();
    await ops.send({ t: "token.create", token: { id: extra, sceneId: run.sceneId, kind: "monster", name: "Goblin 2", x: 3, y: 4, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: actor(7) } } });
    await waitFor("Goblin 2 on the player's map", () => playerSocket.state?.tokens[extra]);
    await setUp({ ...LANDSCAPE, scale: 1 });
    await touch([await cellPoint({ x: 8, y: 6 })]);
    await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Select several", exact: true }).tap();
    await touch([await cellPoint({ x: 12, y: 9 })]);
    await player.getByRole("dialog", { name: "2 selected tokens" }).waitFor();

    const off = await emptyPoint(player);
    await touch([off, { x: off.x + 3, y: off.y + 2 }, { x: off.x + 4, y: off.y + 3 }]);
    await barFrame(player).waitFor({ state: "detached" });
    await player.getByRole("toolbar", { name: "Select options" }).getByText("2 selected.", { exact: true }).waitFor();

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
    test(`10. the Select several bar is one row with Actions shown: ${label}`, async () => {
      await insets(view.insets);
      await setUp(view);
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Select several", exact: true }).tap();
      // Off the bar, where the map shows: on an upright phone, whose overlay spans the screen, only the strip under the top bar.
      await player.waitForTimeout(200);
      await touch([await emptyPoint(player)]);
      await barFrame(player).waitFor({ state: "detached" });
      const options = player.getByRole("toolbar", { name: "Select options" });
      await options.getByRole("button", { name: "Actions", exact: true }).waitFor();
      const r = await rectOf(options);
      assert.ok(r.bottom - r.top <= (44 + 8 + 2) * view.scale + 2, `${label}: the Select several bar wrapped to ${r.bottom - r.top} px`);
      await shots.take(player, `playerphone-several-row-${view.width}x${view.height}`);
      await options.getByRole("button", { name: "Done", exact: true }).tap();
      await insets({});
    });
  }

  test("11. on screens too short for the bar, with Select several, the turn band and a roll waiting, it opens compact: the roll stays in sight, every button takes a tap, and Panels comes back after Close", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: randomUUID(), tokenId: run.goblin.id, value: 18 },
        { id: randomUUID(), tokenId: run.thorn.id, value: 15 },
      ],
    });
    for (const view of [
      { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 } },
      { width: 844, height: 390, scale: 1.3, insets: { side: 47, bottom: 21 } },
      { width: 320, height: 480, scale: 1.3, insets: { top: 44, bottom: 34 } },
    ]) {
      const label = `${view.width} x ${view.height} at 130%`;
      await insets(view.insets);
      await setUp(view);
      await touch([await cellPoint({ x: 8, y: 6 })]);
      const bar = player.getByRole("dialog", { name: "Thorn actions" });
      await bar.getByRole("button", { name: "Select several", exact: true }).tap();
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

      // The summary row's tap hides the bar and shows the roll card.
      if (await row.isVisible()) {
        await row.tap();
        await bar.waitFor({ state: "detached" });
        await card(player).waitFor();
        await card(player).getByRole("button", { name: "Later" }).tap();
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
    test(`12. with a roll card waiting at the screen's foot, Select several's Actions takes a tap after a tap off, and the card's title, Later, total and Send show whole and take a tap, or the summary row stands in and opens it so: ${label}`, async () => {
      await insets(view.insets);
      await setUp(view);
      await touch([await cellPoint({ x: 8, y: 6 })]);
      await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Select several", exact: true }).tap();
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
        if (await card(player).isVisible()) assert.ok(!intersects(await rectOf(card(player)), await rectOf(options)), `${label}: the roll card covers the Select several bar`);
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
    test(`14. ${label}, a long roll question opened from the Roll asked row shows its question, Later, total and Send at once, each taking a tap, and is answered`, async () => {
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

  test("15. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
  });
});
