import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, ROOT, Shots, SocketWatch, sleep, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Which floor each device shows (docs/design/design-v1-floors.md 7.2, 7.3), on
 * the real server serving the production build. Dana the DM is at a desk.
 * Ana plays Thorn on a phone, and Bree plays Bree at a desk. A table display
 * shows the party. Tower has three floors, Ground (where the players
 * start), Upper, with a map and Heavy rain, and Attic. Labels carry the
 * prefix FLRV.
 * - flrv-0: the room, and the top bars before Tower has floors.
 * - flrv-1: Tower's floors. Bree's page was sent nothing of Upper or Attic.
 * - flrv-2: the DM's [ and ] step through the floors and say when there is
 *   none, and a switch sends nothing.
 * - flrv-3: the DM's Floors menu: the rows top first with their marks, a
 *   pick by a key or a click that closes it, and focus back on Floor.
 * - flrv-4: the DM moves Thorn to Upper. Ana's phone follows and says so,
 *   and Bree's desk stays on Ground.
 * - flrv-5: Ana picks Ground: the Viewing notice, its Back to Thorn, and
 *   Floor, its menu and the notice in line at 1440 x 900, 390 x 844 and
 *   320 x 568 at 100% and 130%.
 * - flrv-6: Thorn's turn while the DM shows Ground: the turn chip's name
 *   ends "on Upper floor".
 * - flrv-7: Bree joins Thorn, and the display follows the party to Upper,
 *   saying the floor and its weather.
 * - flrv-8: Ana's JS heap across 20 switches among 8 floors, one with a
 *   video and one with Heavy rain.
 * - flrv-9: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-six, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 66;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-view-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
const FIXTURES = path.join(ROOT, "e2e", "fixtures");

const DESK = { width: 1440, height: 900 };
const BREE_DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const TV = { width: 1280, height: 720 };
const BOUNDS = { w: 32, h: 18 };
const HEAVY_RAIN = { kind: "rain", heavy: true, wind: "strong" } as const;

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let breeContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let ana: Page;
let bree: Page;
let tv: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const breeSocket = new SocketWatch("bree");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), bree: new ConsoleWatch("bree"), tv: new ConsoleWatch("tv") };

const run = {
  roomId: "",
  roomName: `E2E floors view ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: randomUUID(),
  attic: randomUUID(),
  upperMap: "",
  anaId: "",
  breeId: "",
  thorn: randomUUID(),
  breeCharacter: randomUUID(),
  tThorn: randomUUID(),
  tBree: randomUUID(),
};

type DomNode = { getAttribute(name: string): string | null };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
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

function cookieOf(context: BrowserContext): Promise<string> {
  return context.cookies(server.origin).then((list) => list.map((c) => `${c.name}=${c.value}`).join("; "));
}

/** A plain map image of the room's, `w` by `h` px in one color, through the asset route. */
async function uploadImage(w: number, h: number, background: { r: number; g: number; b: number }): Promise<{ id: string; width: number; height: number }> {
  const data = await sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the image upload answered ${res.status()}`);
  return (await res.json()) as { id: string; width: number; height: number };
}

/** The animated maps' WebM fixture as a video of the room's (animmap.e2e.ts). */
async function uploadVideo(): Promise<{ id: string; width: number; height: number; video?: Record<string, unknown> }> {
  const file = path.join(FIXTURES, "map-loop.webm");
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=video`, { headers: { Origin: server.origin, "content-type": "video/webm", "x-name": "map-loop.webm" }, data: readFileSync(file) });
  assert.ok(res.ok(), `the video upload answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as { id: string; width: number; height: number; video?: Record<string, unknown> };
}

/** A map spread over the floor's width. A new floor takes the size of the floor beside it, so the size is read from the DM's copy. */
function imageMap(image: { id: string; width: number; height: number }, sceneId: string) {
  const w = dmSocket.state?.scenes[sceneId]?.bounds.w ?? BOUNDS.w;
  return { assetId: image.id, widthPx: image.width, heightPx: image.height, cellPx: image.width / w, originPx: { x: 0, y: 0 } };
}

const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]").first();
const floorButton = (page: Page) => topBar(page).locator('[data-floors="button"]');
const floorsMenu = (page: Page) => page.locator('[data-floors="menu"]');
const notice = (page: Page) => page.locator('[data-floors="notice"]');
const said = (page: Page, words: string) => page.locator("[data-rvtt-view-status]").filter({ hasText: words }).first();

/** The floor a page shows, by its Floor button's name. */
async function showsFloor(page: Page, floor: string, what = `${floor} shown`): Promise<void> {
  const name = `Floor: ${floor}. Show another floor`;
  await waitFor(what, async () => ((await floorButton(page).getAttribute("aria-label").catch(() => null)) === name ? true : null), 15_000);
}

async function keyOn(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press(key);
}

/** Whether focus stands on the top bar's Floor button. */
function focusOnFloor(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { activeElement: (DomNode & { closest(s: string): unknown }) | null } }).document;
    return doc.activeElement?.getAttribute("data-floors") === "button" && doc.activeElement.closest("header[data-rvtt-topbar]") !== null;
  });
}

/** Whether focus is on the map's focus target (pages/mapFocus.ts), where it goes when the control that had it leaves with nothing near. */
function focusOnMap(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { activeElement: DomNode | null } }).document;
    return doc.activeElement?.getAttribute("role") === "img" && doc.activeElement.getAttribute("aria-label") === "Map";
  });
}

/** What has focus, for a failure line. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as { document: { activeElement: (DomNode & { tagName: string; textContent: string | null }) | null } }).document.activeElement;
    return el ? `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}"` : "nothing";
  });
}

/** The rows of the Floors menu, top first, by floor id. */
function rowIds(menu: Locator): Promise<string[]> {
  return menu.locator("[data-floor-row]").evaluateAll((els) => els.map((e) => (e as unknown as DomNode).getAttribute("data-floor-row") ?? ""));
}

/** A floor row's radio name: the floor's name and its marks. */
function rowName(menu: Locator, floorId: string): Promise<string | null> {
  return menu.locator(`[data-floor-row="${floorId}"] input[type="radio"]`).getAttribute("aria-label");
}

/** Opens Floors from the top bar, or from the Menu panel's Floor row where the bar folded it. */
async function openFloors(page: Page): Promise<Locator> {
  if (await floorButton(page).isVisible()) await floorButton(page).click();
  else {
    if ((await page.getByRole("tablist", { name: "Panels" }).count()) > 0) await page.getByRole("tablist", { name: "Panels" }).getByRole("tab", { name: /^Menu/ }).click();
    else {
      await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
      await page.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    }
    await page.locator('[data-floors="menu-row"]').getByRole("button").first().click();
  }
  const menu = floorsMenu(page).first();
  await menu.waitFor();
  return menu;
}

async function closeFloors(page: Page): Promise<void> {
  if ((await floorsMenu(page).count()) === 0) return;
  await page.keyboard.press("Escape");
  await floorsMenu(page).first().waitFor({ state: "detached" });
}

async function openRoom(page: Page, watch: ConsoleWatch, socket: SocketWatch): Promise<void> {
  // A first visit asks for the member before the session cookie is read, which answers 403 once.
  watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor(`${watch.label}'s snapshot`, () => socket.state);
  watch.allow = [];
}

describe("Which floor each device shows on a scene of several floors", { concurrency: false }, () => {
  before(async () => {
    // flrv-8's floor with a video needs the server's animated maps on.
    process.env.ANIMATED_MAPS = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    breeContext = await browser.newContext({ viewport: BREE_DESK });
    tvContext = await browser.newContext({ viewport: TV });
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    bree = await breeContext.newPage();
    tv = await tvContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    consoles.bree.attach(bree);
    consoles.tv.attach(tv);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
    await breeSocket.attach(breeContext, bree);
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

  test("flrv-0. a room with Ana's Thorn and Bree on Tower, and the top bars before Tower has floors", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=(.+)$/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.ground = dmSocket.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    run.anaId = await join(anaContext, "Ana", "#30a46c");
    run.breeId = await join(breeContext, "Bree", "#e5484d");
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower" } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.anaId], actor: actor(24) } });
    await ops.send({ t: "character.create", character: { id: run.breeCharacter, name: "Bree", size: "medium", ownerIds: [run.breeId], actor: actor(18) } });
    const at = { size: "medium", visibility: "all", disposition: "ally" } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.ground, kind: "pc", name: "Thorn", ownerIds: [run.anaId], actor: { ref: run.thorn }, x: 4, y: 4, ...at } });
    await ops.send({ t: "token.create", token: { id: run.tBree, sceneId: run.ground, kind: "pc", name: "Bree", ownerIds: [run.breeId], actor: { ref: run.breeCharacter }, x: 6, y: 4, ...at } });

    await openRoom(ana, consoles.ana, anaSocket);
    await openRoom(bree, consoles.bree, breeSocket);
    for (const page of [dm, ana, bree]) assert.equal(await floorButton(page).count(), 0, "no Floor on a scene of one floor");
    await shots.take(dm, "flrv-0-before-dm-desk");
    await shots.take(ana, "flrv-0-before-ana-phone");
  });

  test("flrv-1. Tower's Upper floor, with a map and Heavy rain, and its Attic: Bree's page was sent none of their ids, names or the map", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.create", scene: { id: run.attic, name: "Tower", bounds: BOUNDS }, floor: { beside: run.upper, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor" }, weather: HEAVY_RAIN } });
    await ops.send({ t: "scene.update", sceneId: run.attic, patch: { floor: { name: "Attic" } } });
    const map = await uploadImage(640, 360, { r: 72, g: 96, b: 120 });
    run.upperMap = map.id;
    await waitFor("Upper in the DM's copy", () => dmSocket.state?.scenes[run.upper]);
    await ops.send({ t: "scene.setMap", sceneId: run.upper, map: imageMap(map, run.upper) });
    await waitFor("three floors in the DM's copy", () => (Object.values(dmSocket.state?.scenes ?? {}).filter((s) => s.floor !== undefined).length === 3 ? true : null));
    await showsFloor(dm, "Ground floor", "the DM's Floor on Ground");
    // The players hold Ground alone, so neither has a Floor, and a frame Bree was sent names nothing above it.
    await bree.waitForTimeout(500);
    for (const page of [ana, bree]) assert.equal(await floorButton(page).count(), 0, "a player holding one floor has no Floor");
    const seen = breeSocket.received.join("\n");
    for (const secret of [run.upper, run.attic, run.upperMap, "Upper floor", "Attic"]) assert.ok(!seen.includes(secret), `a frame Bree received holds ${secret}`);
  });

  test("flrv-2. the DM's ] and [ step through the floors with nothing sent, and say there is no floor above Attic or below Ground", async () => {
    const from = dmSocket.sent.length;
    await keyOn(dm, "]");
    await showsFloor(dm, "Upper floor");
    await dm.waitForTimeout(500);
    await shots.take(dm, "flrv-2-dm-upper-floor");
    await keyOn(dm, "]");
    await showsFloor(dm, "Attic");
    await keyOn(dm, "]");
    await dm.locator("[data-toast]").filter({ hasText: "No floor above Attic." }).first().waitFor();
    await keyOn(dm, "[");
    await keyOn(dm, "[");
    await showsFloor(dm, "Ground floor");
    await keyOn(dm, "[");
    await dm.locator("[data-toast]").filter({ hasText: "No floor below Ground floor." }).first().waitFor();
    // A floor of the scene projected is the DM's own choice: no hello and no scene frame (7.3).
    const frames = dmSocket.sent.slice(from).filter((f) => f.startsWith('{"t":"scene"') || f.startsWith('{"t":"hello"'));
    assert.deepEqual(frames, []);
  });

  test("flrv-3. the DM's Floors menu lists the floors top first with their marks, a pick by a key or a click shows it and closes the menu, and focus comes back to Floor", async () => {
    const menu = await openFloors(dm);
    assert.deepEqual(await rowIds(menu), [run.attic, run.upper, run.ground], "top first");
    assert.match((await rowName(menu, run.ground)) ?? "", /^Ground floor, Players here, /);
    assert.equal(await rowName(menu, run.upper), "Upper floor, Not reached yet");
    assert.equal(await rowName(menu, run.attic), "Attic, Not reached yet");
    await waitFor("focus on the floor shown", async () => ((await menu.locator("input:checked").evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement)) ? true : null));
    await shots.take(dm, "flrv-3-dm-floors-menu");
    // Up picks the row above, and a switch of floors closes the open pop-up as a switch of scenes does.
    await dm.keyboard.press("ArrowUp");
    await showsFloor(dm, "Upper floor", "ArrowUp shows Upper floor");
    await floorsMenu(dm).first().waitFor({ state: "detached" });
    await waitFor("focus back on Floor", async () => ((await focusOnFloor(dm)) ? true : null));
    const again = await openFloors(dm);
    await again.locator(`[data-floor-row="${run.ground}"]`).click();
    await floorsMenu(dm).first().waitFor({ state: "detached" });
    await showsFloor(dm, "Ground floor");
    await waitFor("focus back on Floor after a click", async () => ((await focusOnFloor(dm)) ? true : null));
  });

  test("flrv-4. the DM moves Thorn to Upper: Ana's phone follows and says so, Bree's desk stays on Ground, and the DM's menu marks Upper", async () => {
    await ops.send({ t: "token.update", tokenId: run.tThorn, patch: { sceneId: run.upper } });
    await showsFloor(ana, "Upper floor", "Ana's phone on Upper floor");
    await said(ana, "Thorn is on Upper floor. Showing Upper floor.").waitFor({ state: "attached" });
    await showsFloor(bree, "Ground floor", "Bree's desk on Ground floor");
    await ana.waitForTimeout(500);
    await shots.take(ana, "flrv-4-ana-follows-thorn");
    await shots.take(bree, "flrv-4-bree-stays");
    const menu = await openFloors(dm);
    assert.match((await rowName(menu, run.upper)) ?? "", /^Upper floor, Players here, /);
    await closeFloors(dm);
  });

  test("flrv-5. Ana picks Ground: the Viewing notice with Back to Thorn, which shows Upper again with focus on Floor, and Floor, Floors and the notice in line at every size", async () => {
    const pickGround = async (page: Page) => {
      const menu = await openFloors(page);
      await menu.locator(`[data-floor-row="${run.ground}"]`).click();
      await floorsMenu(page).first().waitFor({ state: "detached" });
      await notice(page).waitFor();
    };
    await pickGround(ana);
    await showsFloor(ana, "Ground floor");
    assert.match(await notice(ana).innerText(), /Viewing Ground floor\./);
    const back = notice(ana).getByRole("button", { name: "Back to Thorn" });
    await back.waitFor();
    await shots.take(ana, "flrv-5-ana-viewing-ground");
    await back.click();
    await showsFloor(ana, "Upper floor", "Back to Thorn shows Upper floor");
    await notice(ana).waitFor({ state: "detached" });
    await waitFor("focus on Floor after Back", async () => ((await focusOnFloor(ana)) ? true : null));

    const lines: string[] = [];
    try {
      for (const size of [{ width: 1440, height: 900 }, PHONE, { width: 320, height: 568 }]) {
        for (const scale of [1, 1.3]) {
          const at = `${size.width}x${size.height}${scale === 1 ? "" : "-130"}`;
          await ana.setViewportSize(size);
          await ana.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(s)), scale);
          await ana.reload();
          await ana.getByRole("status", { name: "Connected" }).first().waitFor();
          // The bar settles its give-way after the first frames, Floor in it or folded into the Menu panel.
          await topBar(ana).waitFor();
          await sleep(800);
          if (await floorButton(ana).isVisible()) lines.push(...alignmentLines(await measureAlignment(floorButton(ana)), `${at} floor button`));
          const menu = await openFloors(ana);
          lines.push(...alignmentLines(await measureAlignment(menu), `${at} floors menu`));
          await shots.take(ana, `flrv-5-ana-floors-menu-${at}`);
          await menu.locator(`[data-floor-row="${run.ground}"]`).click();
          await floorsMenu(ana).first().waitFor({ state: "detached" });
          await notice(ana).waitFor();
          lines.push(...alignmentLines(await measureAlignment(notice(ana)), `${at} viewing notice`));
          await shots.take(ana, `flrv-5-ana-viewing-${at}`);
          const folded = !(await floorButton(ana).isVisible());
          await notice(ana).getByRole("button", { name: "Back to Thorn" }).click();
          await notice(ana).waitFor({ state: "detached" });
          // Where the bar folded Floor into the Menu panel, Back has no Floor to focus, and focus goes to the map rather than the page.
          if (folded && !(await focusOnMap(ana))) lines.push(`${at} Back to Thorn left focus on ${await focusedName(ana)}, not the map, with Floor folded`);
          if (!folded && !(await focusOnFloor(ana))) lines.push(`${at} Back to Thorn left focus on ${await focusedName(ana)}, not Floor`);
        }
      }
    } finally {
      await ana.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", "1"));
      await ana.setViewportSize(PHONE);
      await ana.reload();
      await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    }
    assert.deepEqual(lines, [], "Floor, Floors or the Viewing notice out of line");
  });

  test("flrv-6. on Thorn's turn while the DM shows Ground, the turn chip's name ends on Upper floor", async () => {
    await showsFloor(dm, "Ground floor");
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.tThorn, value: 20 }, { id: randomUUID(), tokenId: run.tBree, value: 10 }] });
    await ops.send({ t: "encounter.next" });
    const turn = topBar(dm).locator('button[aria-label^="Initiative, round"]').first();
    await waitFor("the turn chip names Upper floor", async () => ((await turn.getAttribute("aria-label").catch(() => null))?.includes("Thorn's turn on Upper floor. Open the tracker.") ? true : null));
    await shots.take(dm, "flrv-6-dm-turn-on-upper");
    await ops.send({ t: "encounter.end" });
  });

  test("flrv-7. the table display shows the party's floor: Ground while the party is split, then Upper once Bree joins Thorn, saying the floor and its weather", async () => {
    const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
    assert.equal(res.status(), 201, await res.text());
    const { code } = (await res.json()) as { code: string };
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await tv.locator(".konvajs-content").first().waitFor();
    await sleep(500);
    await ops.send({ t: "token.update", tokenId: run.tBree, patch: { sceneId: run.upper } });
    await said(tv, "Showing Upper floor. Weather here: Heavy rain, Strong wind.").waitFor({ state: "attached" });
    await showsFloor(bree, "Upper floor", "Bree's desk follows her to Upper floor");
    await tv.waitForTimeout(500);
    await shots.take(tv, "flrv-7-display-upper-heavy-rain");
  });

  test("flrv-8. Ana's JS heap over the last 10 of 20 switches among 8 floors, one with a video and one with Heavy rain, stays within 10% of the tenth's", async () => {
    // Five floors more above Attic, every one shown to the players, the second with a video map.
    let below = run.attic;
    const more: string[] = [];
    for (let i = 4; i <= 8; i++) {
      const id = randomUUID();
      await ops.send({ t: "scene.create", scene: { id, name: "Tower", bounds: BOUNDS }, floor: { beside: below, side: "above" } });
      await ops.send({ t: "scene.update", sceneId: id, patch: { floor: { name: `Floor ${i}` } } });
      more.push(id);
      below = id;
    }
    await waitFor("the five floors in the DM's copy", () => (more.every((id) => dmSocket.state?.scenes[id]) ? true : null));
    const video = await uploadVideo();
    const still = await uploadImage(video.width, video.height, { r: 96, g: 64, b: 128 });
    await ops.send({
      t: "scene.setMap",
      sceneId: more[1]!,
      map: { ...imageMap(still, more[1]!), video: { container: "webm", video: "vp8", fps: 30, durationMs: 2000, kbps: 1, ...video.video, assetId: video.id, widthPx: video.width, heightPx: video.height } },
    });
    for (const id of [run.attic, ...more]) await ops.send({ t: "floor.open", sceneId: id, open: true });
    await waitFor("Ana holds 8 floors", async () => (Object.values(anaSocket.state?.scenes ?? {}).filter((s) => s.floor !== undefined).length === 8 ? true : null), 20_000);

    const cdp = await anaContext.newCDPSession(ana);
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      return (await cdp.send("Runtime.getHeapUsage")).usedSize;
    };
    const names = ["Ground floor", "Upper floor", "Attic", ...more.map((_, i) => `Floor ${i + 4}`)];
    // From Upper, where Ana follows Thorn: down to Ground, up to the top, down again and up, 20 switches in all.
    const steps: ("[" | "]")[] = ["[", ...Array<"]">(7).fill("]"), ...Array<"[">(7).fill("["), ...Array<"]">(5).fill("]")];
    let at = 1;
    const sent = anaSocket.sent.length;
    const used: number[] = [];
    for (const key of steps) {
      await keyOn(ana, key);
      at += key === "]" ? 1 : -1;
      await showsFloor(ana, names[at]!, `switch ${used.length + 1} to ${names[at]}`);
      await ana.waitForTimeout(400);
      used.push(await heap());
    }
    assert.equal(used.length, 20);
    const tenth = used[9]!;
    const worst = Math.max(...used.slice(10));
    console.log(`flrv-8: heap after each switch, MB: ${used.map((u) => (u / 1e6).toFixed(1)).join(" ")}`);
    assert.ok(worst <= tenth * 1.1, `the heap grew to ${(worst / 1e6).toFixed(1)} MB over the last 10, past 10% above the tenth's ${(tenth / 1e6).toFixed(1)} MB`);
    const frames = anaSocket.sent.slice(sent).filter((f) => f.startsWith('{"t":"scene"') || f.startsWith('{"t":"hello"'));
    assert.deepEqual(frames, [], "a switch of floors sends nothing");
  });

  test("flrv-9. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
