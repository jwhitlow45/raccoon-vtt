import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The docked token action bar (docs/design-v1-bar-dock.md section 7) on the
 * real server serving the production build: where it docks at computer and
 * tablet sizes, moving it by its header and with Move bar, what this device
 * remembers, Fit, Find and the outliner keeping tokens out from under it,
 * the right lane it shares with the fight alerts column, taps off the bar
 * with and without Select several, and "Viewing as Pat" beside the column.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven, which it shares
 * with the phone runs, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-bardock-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1280, height: 800 };
const SPOT_KEY = "rvtt.tokenBarSpot";

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

const run = {
  roomId: "",
  roomName: `E2E bar dock ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  thorn: { id: randomUUID(), characterId: randomUUID(), x: 4, y: 4 },
  goblins: [
    { id: randomUUID(), x: 6, y: 6 },
    { id: randomUUID(), x: 8, y: 4 },
    { id: randomUUID(), x: 4, y: 9 },
  ],
  /** Far in the map's bottom right, where the docked bar sits. */
  far: { id: randomUUID(), x: 27, y: 17 },
};

type Rect = { left: number; top: number; right: number; bottom: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  closest(selector: string): El | null;
  getBoundingClientRect(): Rect & { width: number; height: number };
};
type Doc = { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };

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

/** Sets the window, the interface size and the spot, then loads the room again. */
async function setUp(page: Page, view: { width: number; height: number; scale: number }, spot: string | null = null): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate(
    ([s, key, value]) => {
      const g = globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } };
      g.localStorage.setItem("rvtt.uiScale", String(s));
      if (value === null) g.localStorage.removeItem(key as string);
      else g.localStorage.setItem(key as string, value as string);
    },
    [view.scale, SPOT_KEY, spot] as const,
  );
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** The token bar's frame, whichever token or group it is for. */
function barFrame(page: Page): Locator {
  return page.locator('[role="dialog"][data-bar-mode]');
}

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

/** The bar's box once it holds still, since it settles after the column and the bars measure themselves. */
async function barRect(page: Page): Promise<Rect> {
  let last = await rectOf(barFrame(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(60);
    const next = await rectOf(barFrame(page));
    if (Math.abs(next.left - last.left) < 0.5 && Math.abs(next.top - last.top) < 0.5 && Math.abs(next.bottom - last.bottom) < 0.5) return next;
    last = next;
  }
  return last;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** The room's chrome as drawn: the top bar with its band, the toolbar, the side panel from 900 px up, and the window. */
function chrome(page: Page): Promise<{ top: number; toolbar: number; panel: number | null; width: number; height: number }> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { document: Doc; innerWidth: number; innerHeight: number };
    const header = Array.from(g.document.querySelectorAll("header")).find((h) => h.textContent !== null && h.getAttribute("style") !== null && h.closest("aside") === null);
    const nav = g.document.querySelector('nav[aria-label="Tools"]');
    const aside = g.document.querySelector("aside");
    return {
      top: header?.getBoundingClientRect().bottom ?? 0,
      toolbar: nav?.getBoundingClientRect().top ?? g.innerHeight,
      panel: aside ? aside.getBoundingClientRect().left : null,
      width: g.innerWidth,
      height: g.innerHeight,
    };
  });
}

/**
 * Every card in the fight alerts columns on the page, as drawn: the part of
 * each that its column, which scrolls, leaves in view. The rolls' cards
 * sit in a wrapper with no box of its own, so its children count instead.
 */
function cards(page: Page): Promise<Rect[]> {
  return page.evaluate(() => {
    type Node = El & { tagName: string; parentElement: Node | null };
    const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Node> } };
    const out: Rect[] = [];
    for (const el of Array.from(g.document.querySelectorAll('[data-alert]:not([data-alert="rolls"]), [data-alert="rolls"] > *'))) {
      let column: Node = el;
      while (column.parentElement && column.parentElement.tagName !== "HEADER") column = column.parentElement;
      const r = el.getBoundingClientRect();
      const c = column.getBoundingClientRect();
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, c.bottom);
      if (r.width > 0 && bottom - top > 0.5) out.push({ left: r.left, top, right: r.right, bottom });
    }
    return out;
  });
}

/** The page point at a cell's center, after checking the map takes a tap there. */
async function cellPoint(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const p = await pagePoint(page, run.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
  const tag = await page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
  assert.equal(tag, "CANVAS", `the map does not take a tap at cell ${cell.x},${cell.y}`);
  return p;
}

async function clickCell(page: Page, cell: { x: number; y: number }, modifiers: ("Shift")[] = []): Promise<void> {
  const p = await cellPoint(page, cell);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** Empty map near the top left of the scene, clear of every token and of the docked bar. */
const EMPTY = { x: 1, y: 1 };

async function selectThorn(page: Page = dm): Promise<void> {
  await clickCell(page, run.thorn);
  await page.getByRole("dialog", { name: "Thorn actions" }).waitFor();
}

/** Drags the bar by its header with the mouse, in small steps. */
async function dragHeader(page: Page, to: { x: number; y: number }, opts: { escape?: boolean } = {}): Promise<void> {
  const r = await barRect(page);
  const from = { x: r.left + 40, y: r.top + 26 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (opts.escape) await page.keyboard.press("Escape");
  await page.mouse.up();
}

/** A one-finger drag through the browser's touch input, as a phone or a tablet sends it. */
async function touchDrag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

function storedSpot(page: Page): Promise<string | null> {
  return page.evaluate((key) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(key), SPOT_KEY);
}

function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: Doc }).document.activeElement;
    return (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim();
  });
}

/** Each token's box on screen, from the camera Konva holds and the DM's view of the tokens. */
async function tokenRects(page: Page, ids: readonly string[]): Promise<Rect[]> {
  const rects: Rect[] = [];
  for (const id of ids) {
    const t = dmSocket.state?.tokens[id];
    if (!t || t.sceneId !== run.sceneId) continue;
    const a = await pagePoint(page, run.bounds, { x: t.x, y: t.y });
    const b = await pagePoint(page, run.bounds, { x: t.x + 1, y: t.y + 1 });
    rects.push({ left: a.x, top: a.y, right: b.x, bottom: b.y });
  }
  return rects;
}

/** Each goblin takes a point of damage, and with its Hex up, a concentration check comes up for the DM. */
async function damageGoblins(): Promise<void> {
  for (const g of run.goblins) await ops.send({ t: "actor.hp", target: { tokenId: g.id }, change: { kind: "damage", amount: 1 } });
}

function selectOptions(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Select options" });
}

describe("raccoon-vtt: the docked token action bar", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    // Pat on a tablet: a touch screen, for the touch drag and Find my token.
    playerContext = await browser.newContext({ viewport: { width: 900, height: 800 }, hasTouch: true });
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

  test("1. a DM's room with Pat's Thorn, three goblins and one far in the corner", async () => {
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
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    for (const [i, g] of run.goblins.entries()) {
      // Hardy goblins: each step's checks hurt them again.
      await ops.send(token(g.id, { kind: "monster", name: `Goblin ${i + 1}`, x: g.x, y: g.y, disposition: "hostile", actor: { inline: actor(40) } }));
    }
    await ops.send(token(run.far.id, { kind: "monster", name: "Far goblin", x: run.far.x, y: run.far.y, disposition: "hostile", actor: { inline: actor(7) } }));
    await waitFor("every token in the DM's view", () => [...run.goblins, run.far].every((g) => dmSocket.state?.tokens[g.id]) || null);
    await waitFor("Thorn in the DM's view", () => dmSocket.state?.tokens[run.thorn.id]);

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  for (const view of [
    { ...DESK, scale: 1 },
    { ...DESK, scale: 1.3 },
    { width: 1024, height: 768, scale: 1 },
    { width: 1024, height: 768, scale: 1.3 },
    { width: 820, height: 1180, scale: 1 },
    { width: 820, height: 1180, scale: 1.3 },
  ]) {
    const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
    test(`2. the single and group bars dock in one spot clear of the bars and the side panel, and another token's tap does not move it: ${label}`, async () => {
      await setUp(dm, view);
      await selectThorn();
      assert.equal(await barFrame(dm).getAttribute("data-bar-mode"), "dock", `${label}: the bar does not dock`);
      const one = await barRect(dm);
      const c = await chrome(dm);
      assert.ok(one.top >= c.top - 0.5, `${label}: the bar (top ${one.top}) runs under the top bar (${c.top})`);
      assert.ok(one.bottom <= c.toolbar + 0.5, `${label}: the bar (bottom ${one.bottom}) runs under the toolbar (${c.toolbar})`);
      assert.ok(one.right <= (c.panel ?? c.width) + 0.5, `${label}: the bar (right ${one.right}) runs under the side panel or off the window`);
      assert.ok(one.left >= -0.5, `${label}: the bar leaves the window`);
      // Its default spot is the free area's bottom right, 8 layout px from the bars and the side panel.
      assert.ok(Math.abs((c.panel ?? c.width) - one.right - 8 * view.scale) <= 1.5, `${label}: the bar is not at the right: ${JSON.stringify({ one, c })}`);
      assert.ok(c.toolbar - one.bottom <= 8 * view.scale + 1.5, `${label}: the bar is not at the bottom: ${JSON.stringify({ one, c })}`);

      await clickCell(dm, run.goblins[0]!);
      await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
      const other = await barRect(dm);
      assert.ok(Math.abs(other.right - one.right) <= 1 && Math.abs(other.bottom - one.bottom) <= 1, `${label}: another token's bar moved: ${JSON.stringify({ one, other })}`);
      await clickCell(dm, run.thorn, ["Shift"]);
      await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
      const group = await barRect(dm);
      assert.ok(Math.abs(group.right - one.right) <= 1 && Math.abs(group.bottom - one.bottom) <= 1, `${label}: the group's bar sits elsewhere: ${JSON.stringify({ one, group })}`);
      if (view.width === DESK.width && view.scale === 1) await shots.take(dm, "bardock-docked-group-1280");
      if (view.width === 820 && view.scale === 1) await shots.take(dm, "bardock-docked-group-820");
      await clickCell(dm, EMPTY);
      await barFrame(dm).waitFor({ state: "detached" });
    });
  }

  test("3. a mouse and a touch drag by the header move the bar, a short tap on it does nothing, the free area holds it, and a drop on the column lands under the first card", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const start = await barRect(dm);

    // A press on the header that moves under 8 px neither moves the bar nor closes it.
    await dm.mouse.move(start.left + 40, start.top + 26);
    await dm.mouse.down();
    await dm.mouse.move(start.left + 45, start.top + 28, { steps: 2 });
    await dm.mouse.up();
    const still = await barRect(dm);
    assert.ok(Math.abs(still.left - start.left) < 0.5 && Math.abs(still.top - start.top) < 0.5, "a tap on the header moved the bar");
    assert.equal(await storedSpot(dm), null, "a tap on the header stored a spot");

    await dragHeader(dm, { x: 300, y: 300 });
    const moved = await barRect(dm);
    assert.ok(moved.left < start.left - 100, `the mouse drag did not move the bar: ${JSON.stringify({ start, moved })}`);
    assert.match((await storedSpot(dm)) ?? "", /^\{"corner":"[tb][lr]","x":\d+,"y":\d+\}$/);
    await shots.take(dm, "bardock-dragged-mouse");

    // Past every edge, the bar stays in the free area: under the top bar, above the toolbar, left of the side panel.
    const c = await chrome(dm);
    await dragHeader(dm, { x: 2, y: 2 });
    const topLeft = await barRect(dm);
    assert.ok(topLeft.left >= 7.5 && topLeft.top >= c.top + 7.5, `dragged past the top left: ${JSON.stringify({ topLeft, c })}`);
    assert.equal(await storedSpot(dm), '{"corner":"tl","x":0,"y":0}');
    await dragHeader(dm, { x: c.width - 2, y: c.height - 2 });
    const bottomRight = await barRect(dm);
    assert.ok(bottomRight.right <= (c.panel ?? c.width) - 7.5 && bottomRight.bottom <= c.toolbar - 7.5, `dragged past the bottom right: ${JSON.stringify({ bottomRight, c })}`);
    assert.equal(await storedSpot(dm), null, "a drop near the bottom right is the default spot, stored as no key");

    // A touch drag, on Pat's tablet.
    await setUp(player, { width: 820, height: 1180, scale: 1 });
    await selectThorn(player);
    const touchStart = await barRect(player);
    await touchDrag(playerCdp, { x: touchStart.left + 40, y: touchStart.top + 26 }, { x: 200, y: 300 });
    const touched = await barRect(player);
    assert.ok(touched.left < touchStart.left - 100 && touched.top < touchStart.top, `the touch drag did not move the bar: ${JSON.stringify({ touchStart, touched })}`);
    assert.ok(await player.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "the touch drag closed the bar");
    await shots.take(player, "bardock-dragged-touch");
    await player.evaluate((key) => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem(key), SPOT_KEY);

    // A concentration check for a goblin the DM answers for puts a card in the column, and a drop on it lands under it.
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblins[0]!.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    await ops.send({ t: "actor.hp", target: { tokenId: run.goblins[0]!.id }, change: { kind: "damage", amount: 1 } });
    const prompt = dm.locator('[data-alert="concentration"]').first();
    await prompt.waitFor();
    const first = await rectOf(prompt);
    await dragHeader(dm, { x: first.left + 40, y: first.top + 10 });
    const dropped = await barRect(dm);
    assert.ok(dropped.top >= first.bottom + 8 - 1, `the bar dropped on the column did not move under its first card: ${JSON.stringify({ first, dropped })}`);
    assert.ok(!intersects(dropped, first), "the bar covers the first card");
    await shots.take(dm, "bardock-dropped-on-column");
    await dm.getByRole("button", { name: "Passed" }).first().click();
    await prompt.waitFor({ state: "detached" });
    await dm.getByRole("button", { name: "Reset bar position", exact: true }).click();
  });

  test("4. this device remembers the spot through a reload, a resize and a new interface size, Move bar goes round the corners, Reset brings the bar home, and Escape puts a dragged bar back", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const home = await barRect(dm);
    assert.equal(await dm.getByRole("button", { name: "Reset bar position" }).count(), 0, "Reset bar position shows at the default spot");
    const move = dm.getByRole("button", { name: "Move bar", exact: true });
    assert.equal((await move.textContent())?.trim(), "Move bar", "Move bar is not named by its text");

    const said: string[] = [];
    const stored: (string | null)[] = [];
    const places: Rect[] = [];
    for (let i = 0; i < 4; i++) {
      await move.click();
      places.push(await barRect(dm));
      stored.push(await storedSpot(dm));
      said.push((await barFrame(dm).getByRole("status").textContent())?.trim() ?? "");
      assert.equal(await focusedName(dm), "Move bar", "focus left Move bar");
    }
    assert.deepEqual(said, ["Bar at bottom left", "Bar at top left", "Bar at top right", "Bar at bottom right"]);
    assert.deepEqual(stored, ['{"corner":"bl","x":0,"y":0}', '{"corner":"tl","x":0,"y":0}', '{"corner":"tr","x":0,"y":0}', null]);
    const c = await chrome(dm);
    assert.ok(places[0]!.left <= 8.5 && places[1]!.top <= c.top + 8.5 && places[2]!.right >= (c.panel ?? c.width) - 8.5, `the corners: ${JSON.stringify(places)}`);
    assert.ok(Math.abs(places[3]!.right - home.right) < 1 && Math.abs(places[3]!.bottom - home.bottom) < 1, "the fourth press is not the default spot");

    // A reload keeps the spot, and a resize and a new interface size keep the bar in its corner.
    await move.click();
    await move.click();
    assert.equal(await storedSpot(dm), '{"corner":"tl","x":0,"y":0}');
    for (const view of [
      { ...DESK, scale: 1 },
      { width: 1024, height: 768, scale: 1 },
      { width: 1024, height: 768, scale: 1.3 },
    ]) {
      await setUp(dm, view, '{"corner":"tl","x":0,"y":0}');
      await selectThorn();
      const r = await barRect(dm);
      const ch = await chrome(dm);
      assert.ok(Math.abs(r.left - 8 * view.scale) <= 1.5 && Math.abs(r.top - ch.top - 8 * view.scale) <= 1.5, `${view.width} x ${view.height} at ${view.scale}: the bar left its corner: ${JSON.stringify({ r, ch })}`);
      assert.equal(await storedSpot(dm), '{"corner":"tl","x":0,"y":0}', "the stored spot changed");
    }
    await shots.take(dm, "bardock-top-left-1024-130");

    // Reset puts the bar home, removes the key and leaves focus on Move bar.
    await setUp(dm, { ...DESK, scale: 1 }, '{"corner":"tl","x":0,"y":0}');
    await selectThorn();
    const reset = dm.getByRole("button", { name: "Reset bar position", exact: true });
    assert.equal((await reset.textContent())?.trim(), "Reset bar position");
    await reset.click();
    await reset.waitFor({ state: "detached" });
    assert.equal(await storedSpot(dm), null);
    assert.equal(await focusedName(dm), "Move bar");
    const back = await barRect(dm);
    assert.ok(Math.abs(back.right - home.right) < 1 && Math.abs(back.bottom - home.bottom) < 1, "Reset did not bring the bar home");

    // Escape during a drag puts the bar back where it was and keeps it open.
    await dragHeader(dm, { x: 300, y: 300 }, { escape: true });
    const after = await barRect(dm);
    assert.ok(Math.abs(after.left - back.left) < 1 && Math.abs(after.top - back.top) < 1, `Escape did not put the bar back: ${JSON.stringify({ back, after })}`);
    assert.ok(await dm.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "Escape during a drag closed the bar");
    assert.equal(await storedSpot(dm), null, "a drag Escape put back stored a spot");
  });

  test("5. Fit leaves no token under the bar, and Find my token and the outliner land the token clear of it", async () => {
    // A 900 px window, whose map is 540 px wide: without the cover, the middle of the map lies under the bar.
    await setUp(dm, { width: 900, height: 800, scale: 1 });
    await selectThorn();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.waitForTimeout(300);
    const bar = await barRect(dm);
    const all = [run.thorn.id, ...run.goblins.map((g) => g.id), run.far.id];
    const under = (await tokenRects(dm, all)).filter((r) => intersects(r, bar));
    assert.deepEqual(under, [], "Fit left a token under the bar");
    await shots.take(dm, "bardock-fit-900");

    // The outliner's row for the far goblin selects it, opens its bar and frames it clear of where the bar docks.
    await dm.getByRole("tab", { name: "Outliner" }).click();
    await dm.getByRole("tabpanel").getByRole("button", { name: /^Far goblin/ }).first().click();
    await dm.getByRole("dialog", { name: "Far goblin actions" }).waitFor();
    await dm.waitForTimeout(300);
    const outlined = await barRect(dm);
    const [farRect] = await tokenRects(dm, [run.far.id]);
    assert.ok(farRect && !intersects(farRect, outlined), `the outliner framed the token under the bar: ${JSON.stringify({ farRect, outlined })}`);
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();

    // Pat's Find my token, with Thorn's bar open, lands Thorn clear of it.
    await setUp(player, { width: 900, height: 800, scale: 1 });
    await selectThorn(player);
    await player.mouse.move(200, 400);
    await player.mouse.wheel(0, 600);
    await player.getByRole("button", { name: "Find my token" }).click();
    await player.waitForTimeout(300);
    const patBar = await barRect(player);
    const p = await pagePoint(player, run.bounds, { x: run.thorn.x, y: run.thorn.y });
    const q = await pagePoint(player, run.bounds, { x: run.thorn.x + 1, y: run.thorn.y + 1 });
    assert.ok(!intersects({ left: p.x, top: p.y, right: q.x, bottom: q.y }, patBar), `Find my token landed Thorn under the bar: ${JSON.stringify({ p, q, patBar })}`);
    await shots.take(player, "bardock-find-900");
  });

  test("6. in a fight with three concentration checks and a roll card, the bar and the column never meet, and a column the bar cuts short says Scroll for more", async () => {
    await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
    for (const g of run.goblins) await ops.send({ t: "actor.effect.add", target: { tokenId: g.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    await ops.send({ t: "roll.ask", request: { id: randomUUID(), test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    for (const view of [
      { ...DESK, scale: 1 },
      { width: 1024, height: 768, scale: 1.3 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(dm, view);
      // A check comes up as the damage arrives, so a page loaded again has none until the goblins take more.
      await damageGoblins();
      await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
      await selectThorn();
      const bar = await barRect(dm);
      for (const card of await cards(dm)) assert.ok(!intersects(card, bar), `${label}: a card meets the bar: ${JSON.stringify({ card, bar })}`);
      await barFrame(dm).getByRole("button", { name: "Conditions", exact: true }).click();
      await dm.waitForTimeout(200);
      const tall = await barRect(dm);
      for (const card of await cards(dm)) assert.ok(!intersects(card, tall), `${label}: with Conditions open, a card meets the bar: ${JSON.stringify({ card, tall })}`);
      const hint = dm.locator("header").getByText("Scroll for more");
      assert.equal(await hint.count(), 1, `${label}: the column the bar cuts short does not say Scroll for more`);
      const firstCard = await rectOf(dm.locator('[data-alert="concentration"]').first());
      assert.ok(!intersects(firstCard, tall), `${label}: the first card meets the bar`);
      await shots.take(dm, `bardock-lane-${view.width}-${Math.round(view.scale * 100)}`);
    }
  });

  test("7. one token: a click on empty map closes the bar, another token switches it, and a tab, the tool, Fit, an alert card, a right-button pan, the wheel and a held press leave it open", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').first().waitFor();
    await selectThorn();
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await selectThorn();
    await clickCell(dm, run.goblins[1]!);
    await dm.getByRole("dialog", { name: "Goblin 2 actions" }).waitFor();
    const open = dm.getByRole("dialog", { name: "Goblin 2 actions" });

    await dm.getByRole("tab", { name: "Initiative" }).click();
    await dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select" }).click();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.locator('[data-alert="concentration"]').first().getByText("Concentration check").click();
    assert.ok(await open.isVisible(), "a tab, the tool, Fit or an alert card closed the bar");

    const at = await cellPoint(dm, EMPTY);
    await dm.mouse.move(at.x, at.y);
    await dm.mouse.down({ button: "right" });
    await dm.mouse.move(at.x + 120, at.y + 60, { steps: 6 });
    await dm.mouse.up({ button: "right" });
    await dm.mouse.wheel(0, -200);
    await dm.waitForTimeout(200);
    assert.ok(await open.isVisible(), "a right-button pan or the wheel closed the bar");

    // A press held until it pings: the ping goes out, and the token stays selected with its bar.
    // Pat's page hears the ping: the server sends a member's own ping to the others.
    const pings = playerSocket.received.length;
    const still = await cellPoint(dm, EMPTY);
    await dm.mouse.move(still.x, still.y);
    await dm.mouse.down();
    await dm.waitForTimeout(900);
    await dm.mouse.up();
    await waitFor("the ping at Pat's page", () => playerSocket.received.slice(pings).some((f) => f.includes('"k":"ping"')) || null, 3_000);
    assert.ok(await open.isVisible(), "a held press that pinged closed the bar");
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
  });

  test("8. Select several: a tap off hides the bar and keeps the group, Actions and Done, Escape and a token tapped out, and Details then Escape", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    // A side panel tab other than Token: with the Token tab showing the selection, Escape leaves the group alone.
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await selectThorn();
    await barFrame(dm).getByRole("button", { name: "Select several", exact: true }).click();
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();

    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await selectOptions(dm).getByText("2 selected.", { exact: true }).waitFor();
    const actions = selectOptions(dm).getByRole("button", { name: "Actions", exact: true });
    await actions.waitFor();
    // At 1280 x 800 with Actions shown, the whole hint shows and the bar stays one row.
    // The row's own text, first, before the hidden description that repeats it.
    await selectOptions(dm).getByText("Tap tokens to add or remove them, or drag a box on the map.").first().waitFor();
    const row = await rectOf(selectOptions(dm));
    assert.ok(row.bottom - row.top <= 60, `the Select several bar wrapped: ${row.bottom - row.top} px`);
    await shots.take(dm, "bardock-several-tapped-off");

    await dm.keyboard.press("Escape");
    await selectOptions(dm).waitFor({ state: "detached" });
    assert.equal(await barFrame(dm).count(), 0, "Escape left a bar");

    // Again, then Actions brings the bar back with focus on its frame.
    await selectThorn();
    await barFrame(dm).getByRole("button", { name: "Select several", exact: true }).click();
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await actions.click();
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    assert.equal(await focusedName(dm), "2 selected tokens", "Actions did not focus the bar's frame");

    // A token in the group taken out leaves the hidden bar hidden, and another added shows it.
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await clickCell(dm, run.goblins[0]!);
    await selectOptions(dm).getByText("1 selected.", { exact: true }).waitFor();
    await dm.waitForTimeout(150);
    assert.equal(await barFrame(dm).count(), 0, "taking a token out showed the bar");
    await clickCell(dm, run.goblins[1]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();

    // Done ends the mode and lets go: no bar, no group.
    await selectOptions(dm).getByRole("button", { name: "Done", exact: true }).click();
    await selectOptions(dm).waitFor({ state: "detached" });
    assert.equal(await barFrame(dm).count(), 0, "Done left a bar");

    // With the mode off, Shift and a click on empty map changes nothing.
    await selectThorn();
    await clickCell(dm, EMPTY, ["Shift"]);
    await dm.waitForTimeout(150);
    assert.ok(await dm.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "Shift and a click on empty map closed the bar");

    // One token in the group: Details, then Escape leaves the token panel showing it and the mode on.
    await barFrame(dm).getByRole("button", { name: "Select several", exact: true }).click();
    await barFrame(dm).getByRole("button", { name: "Details", exact: true }).click();
    await barFrame(dm).waitFor({ state: "detached" });
    await dm.getByRole("tab", { name: "Token", selected: true }).waitFor();
    await dm.keyboard.press("Escape");
    await dm.waitForTimeout(150);
    await selectOptions(dm).getByText("1 selected.", { exact: true }).waitFor();
    assert.ok(await dm.getByRole("tab", { name: "Token", selected: true }).isVisible(), "Escape left the token panel");
    await selectOptions(dm).getByRole("button", { name: "Done", exact: true }).click();
    await selectOptions(dm).waitFor({ state: "detached" });
    await dm.getByRole("tab", { name: "Initiative" }).click();
  });

  test("9. Viewing as Pat stays clear of the column, so Later on the previewed roll card takes the click, and Exit still works in a blackout (LPD-DESK-6)", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await dm.getByRole("tab", { name: "DM" }).click();
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    const card = preview.getByRole("dialog", { name: "The DM asks for a roll" });
    await card.waitFor();
    await dm.waitForTimeout(300);
    const notice = await rectOf(preview.getByRole("status").filter({ hasText: "Viewing as Pat." }));
    const previewCard = await rectOf(card);
    assert.ok(!intersects(previewCard, notice), `"Viewing as Pat" covers the roll card: ${JSON.stringify({ previewCard, notice })}`);
    await shots.take(dm, "bardock-viewing-as-pat");
    await card.getByRole("button", { name: "Later" }).click();
    await card.waitFor({ state: "detached" });

    await ops.send({ t: "view.blackout", blackout: true });
    await preview.getByText("The DM has paused the game.").waitFor();
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await ops.send({ t: "view.blackout", blackout: false });
  });

  test("10. a press on the header while checks arrive leaves no card on the bar, nor does a drag Escape put back, and a bar raised in its corner moves down under a tall first card", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const prompts = dm.locator('[data-alert="concentration"]');
    const meets = async () => {
      await dm.waitForTimeout(300);
      const bar = await barRect(dm);
      return (await cards(dm)).filter((c) => intersects(c, bar));
    };
    // A plain press: down on the header, the checks arrive, then up.
    let r = await barRect(dm);
    await dm.mouse.move(r.left + 40, r.top + 26);
    await dm.mouse.down();
    await damageGoblins();
    await prompts.nth(2).waitFor();
    await dm.mouse.up();
    assert.deepEqual(await meets(), [], "after a press on the header, a card covers the bar");
    // A drag put back with Escape.
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    r = await barRect(dm);
    await dm.mouse.move(r.left + 40, r.top + 26);
    await dm.mouse.down();
    await dm.mouse.move(r.left - 60, r.top + 60, { steps: 6 });
    await damageGoblins();
    await prompts.nth(2).waitFor();
    await dm.keyboard.press("Escape");
    await dm.mouse.up();
    assert.deepEqual(await meets(), [], "after a drag Escape put back, a card covers the bar");
    await shots.take(dm, "bardock-press-then-checks");

    // A spot 300 px up the bottom right corner: under the first card the bar moves down to the lane's foot rather than shrinking.
    await setUp(dm, { ...DESK, scale: 1 }, '{"corner":"br","x":0,"y":300}');
    await selectThorn();
    await damageGoblins();
    await prompts.first().waitFor();
    await dm.waitForTimeout(300);
    const bar = await barRect(dm);
    const first = await rectOf(prompts.first());
    const c = await chrome(dm);
    assert.ok(bar.top >= first.bottom + 8 - 1, `the bar meets the first card: ${JSON.stringify({ bar, first })}`);
    const clipped = (await barFrame(dm).getByText("Scroll for more").count()) > 0;
    assert.ok(!clipped || bar.bottom >= c.toolbar - 8 - 1, `the bar shrank with room left below it: ${JSON.stringify({ bar, c })}`);
    await shots.take(dm, "bardock-raised-bar-under-first-card");
  });

  test("11. at 1180 x 390, a token opened from the outliner lands clear of a bar that sits beside the alerts", async () => {
    // The roll card asked in step 6 waits at the column's head, taller than the room the bar would keep under it.
    await setUp(dm, { width: 1180, height: 390, scale: 1 });
    await dm.locator('[data-alert="rolls"] > *').first().waitFor();
    await dm.getByRole("tab", { name: "Outliner" }).click();
    await dm.getByRole("tabpanel").getByLabel("Search the scene").fill("Goblin 2");
    await dm.getByRole("tabpanel").getByRole("button", { name: /^Goblin 2/ }).first().click();
    await dm.getByRole("dialog", { name: "Goblin 2 actions" }).waitFor();
    await dm.waitForTimeout(300);
    const bar = await barRect(dm);
    const [goblin] = await tokenRects(dm, [run.goblins[1]!.id]);
    assert.ok(goblin && !intersects(goblin, bar), `the outliner landed the goblin under the bar: ${JSON.stringify({ goblin, bar })}`);
    for (const card of await cards(dm)) assert.ok(!intersects(card, bar), "the bar meets a card");
    await shots.take(dm, "bardock-outliner-beside-1180x390");
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();
    await dm.getByRole("tab", { name: "Initiative" }).click();
  });

  test("12. after Fit, turning the screen fits the map again against where the bar ends up, the turn band moving included (BD-ASTRA-03, BD-ASTRA-07)", async () => {
    const sceneRect = async (): Promise<Rect> => {
      const a = await pagePoint(dm, run.bounds, { x: 0, y: 0 });
      const b = await pagePoint(dm, run.bounds, { x: run.bounds.w, y: run.bounds.h });
      return { left: a.x, top: a.y, right: b.x, bottom: b.y };
    };
    // A tablet turned upright: the bar spans now and covers nothing for the map, so the map takes the whole width again.
    await setUp(dm, { width: 1024, height: 768, scale: 1.3 });
    await selectThorn();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.waitForTimeout(300);
    await dm.setViewportSize({ width: 768, height: 1024 });
    await barFrame(dm).waitFor();
    await dm.waitForTimeout(1200);
    assert.equal(await barFrame(dm).getAttribute("data-bar-mode"), "span");
    const upright = await sceneRect();
    assert.ok(upright.left >= -1 && upright.right <= 768 + 1, `the refit left the map off screen: ${JSON.stringify(upright)}`);
    assert.ok(Math.abs((upright.left + upright.right) / 2 - 384) <= 2, `the map keeps a cover for a bar that spans now: ${JSON.stringify(upright)}`);
    await shots.take(dm, "bardock-fit-then-upright");
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();

    /*
     * A phone in a fight turned on its side, a concentration check at the
     * column's head. Measured with the turn band still in its own row, the
     * bar would sit beside the check. Once the band moves into the top bar,
     * the free area is 48 px taller and the bar stacks under the check at
     * the right. The map keeps clear of where the bar ends up.
     */
    await setUp(dm, { width: 430, height: 932, scale: 1 });
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').first().waitFor();
    const thorn = await pagePoint(dm, run.bounds, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 });
    const free = await dm.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [thorn.x, thorn.y] as const);
    if (free === "CANVAS") {
      await dm.mouse.click(thorn.x, thorn.y);
    } else {
      await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
      await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
      const outliner = dm.locator('section[aria-label="Outliner"]');
      await outliner.getByLabel("Search the scene").fill("Thorn");
      await outliner.getByRole("button", { name: /^Thorn/ }).first().click();
    }
    await dm.getByRole("dialog", { name: "Thorn actions" }).waitFor();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.waitForTimeout(300);
    const bandBefore = (await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }))).bottom;
    await dm.setViewportSize({ width: 932, height: 420 });
    await dm.waitForTimeout(1200);
    const bandAfter = (await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }))).bottom;
    assert.ok(bandAfter < bandBefore - 20, `the turn band did not move into the top bar: ${bandBefore} then ${bandAfter}`);
    assert.equal(await barFrame(dm).getAttribute("data-bar-mode"), "dock");
    const bar = await barRect(dm);
    const map = await sceneRect();
    assert.ok(!intersects(map, bar), `the refit left the map under the bar: ${JSON.stringify({ map, bar })}`);
    for (const card of await cards(dm)) assert.ok(!intersects(card, bar), "the bar meets a card");
    await shots.take(dm, "bardock-fit-then-sideways-932x420");
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();
  });

  test("13. on a wide screen, Back with Select several's bar hidden ends the mode and stays in the room", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    await barFrame(dm).getByRole("button", { name: "Select several", exact: true }).click();
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    const url = dm.url();
    await dm.goBack();
    await selectOptions(dm).waitFor({ state: "detached" });
    assert.equal(dm.url(), url, "Back left the room");
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("14. a summary row the turn band moves down keeps the bar below it", async () => {
    await ops.send({ t: "encounter.end" });
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
    await setUp(dm, { width: 320, height: 480, scale: 1.3 });
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
    // The check's card covers most of this small map, so the outliner picks Thorn, as a DM would here.
    await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
    await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
    const outliner = dm.locator('section[aria-label="Outliner"]');
    await outliner.getByLabel("Search the scene").fill("Thorn");
    await outliner.getByRole("button", { name: /^Thorn/ }).first().click();
    await dm.getByRole("dialog", { name: "Thorn actions" }).waitFor();
    const row = dm.getByRole("button", { name: /^Concentration check/ });
    await row.waitFor();
    const below = async (label: string) => {
      await dm.waitForTimeout(300);
      const r = await rectOf(row);
      const bar = await barRect(dm);
      assert.ok(bar.top >= r.bottom + 8 * 1.3 - 1, `${label}: the bar meets the summary row: ${JSON.stringify({ r, bar })}`);
    };
    await below("before the band");
    const header = async () => (await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }))).bottom;
    const without = await header();
    await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
    await waitFor("the turn band", async () => ((await header()) > without + 20 ? true : null));
    await below("with the band");
    await shots.take(dm, "bardock-summary-row-band-320x480");
    await ops.send({ t: "encounter.end" });
    await below("after the band");
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  test("15. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
  });
});
