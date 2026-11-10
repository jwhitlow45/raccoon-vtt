import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, pickOption, pickTool, Shots, SocketWatch, sleep, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The walking ruler over stairs (docs/design/design-v1-floors.md phase 3,
 * 4.1 to 4.4), on the real server serving the production build. Dana the
 * DM is at a desk. Ana plays Thorn on a phone, and Bree plays Bree at a
 * desk. Tower has two floors: Ground, where Thorn stands 25 ft west of
 * stairs one square wide, and Upper floor, 10 ft above, where Bree stands,
 * so both players hold both floors. Labels carry the prefix FL3R.
 * - fl3r-0: the room, its floors and the stairs.
 * - fl3r-1: Ana's walking ruler from Thorn to the stairs reads Walking 25 ft
 *   and offers Up the stairs, named for Upper floor, its icon alone on her
 *   phone, in line at 390 x 844.
 * - fl3r-2: one press shows Upper floor with the Viewing notice and reads
 *   Walking 35 ft, 35 ft before this floor, and focus stays on the ruler's row.
 * - fl3r-3: Bree on Upper reads the same total on the map, then 45 ft once
 *   Ana adds a stop, and no frame she was sent names the creatures or the
 *   stairs the ruler crossed.
 * - fl3r-4: an unexplored landing: on Upper under the fog, a stop on
 *   revealed ground the landing joins walks, and one past a wall whose way
 *   round players have not seen reads No way through.
 * - fl3r-5: the DM's private ruler carried up stays on the DM's screen, its
 *   Shared off with its reason, and a ruler shared before the stairs goes
 *   to both players, comes off when Shared is turned off and back when on.
 * - fl3r-6: the ruler's row with the stairs button in line at 1440 x 900,
 *   390 x 844 and 320 x 568, at 100% and 130%.
 * - fl3r-7: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-nine, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 69;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-ruler-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 20, h: 12 };
/** Thorn's square, 25 ft west of the stairs. */
const START = { x: 3, y: 4 };
/** The stairs' one square on Ground and Upper. */
const STAIRS = { x: 8, y: 4 };
/** Bree's square on Upper floor. */
const BREE_AT = { x: 16, y: 10 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let breeContext: BrowserContext;
let dm: Page;
let ana: Page;
let bree: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const breeSocket = new SocketWatch("bree");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), bree: new ConsoleWatch("bree") };

const run = {
  roomId: "",
  roomName: `E2E floors ruler ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: randomUUID(),
  anaId: "",
  breeId: "",
  dmId: "",
  thorn: randomUUID(),
  breeCharacter: randomUUID(),
  tThorn: randomUUID(),
  tBree: randomUUID(),
  stairsDown: `s${randomUUID().slice(0, 8)}`,
  stairsUp: `s${randomUUID().slice(0, 8)}`,
};

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

async function openRoom(page: Page, watch: ConsoleWatch, socket: SocketWatch): Promise<void> {
  // A first visit asks for the member before the session cookie is read, which answers 403 once.
  watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor(`${watch.label}'s snapshot`, () => socket.state);
  watch.allow = [];
}

const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]").first();
const said = (page: Page, words: string) => page.locator("[data-rvtt-view-status]").filter({ hasText: words }).first();
const rulerBar = (page: Page) => page.getByRole("toolbar", { name: "Ruler options" });
const rulerLine = (page: Page) => rulerBar(page).locator("[data-options-line]");
const stairsButton = (page: Page, name: string) => rulerBar(page).getByRole("button", { name, exact: true });
/** The DM's Shared, by its words in the row or its name as an icon alone. */
const sharedButton = (page: Page) => rulerBar(page).getByRole("button", { name: /^(Shared|Players see this ruler|Share it before it takes the stairs\.)$/ }).first();

/** The floor a page shows, by its Floor button's name. */
async function showsFloor(page: Page, floor: string, what = `${floor} shown`): Promise<void> {
  const name = `Floor: ${floor}. Show another floor`;
  await waitFor(what, async () => ((await topBar(page).locator('[data-floors="button"]').getAttribute("aria-label").catch(() => null)) === name ? true : null), 15_000);
}

async function keyOn(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press(key);
}

/** The texts on the map's canvas, the rulers' labels among them. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages.flatMap((s) => s.find("Text")).filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/** Whether the map shows a label with a line that starts with these words: a ruler's label names its measurer on its first line. */
async function boardSays(page: Page, start: string): Promise<boolean> {
  return (await boardTexts(page)).some((t) => t.split("\n").some((line) => line.startsWith(start)));
}

/** A ruler drag between two cells' centers, in small steps, as a finger or a mouse draws it. */
async function measureDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, BOUNDS, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(page, BOUNDS, { x: to.x + 0.5, y: to.y + 0.5 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await page.mouse.up();
}

async function tapAt(page: Page, cell: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: cell.x + 0.5, y: cell.y + 0.5 });
  await page.mouse.click(p.x, p.y);
}

/** The ruler line's words once they match. */
function lineSays(page: Page, what: string, match: RegExp): Promise<string> {
  return waitFor(what, async () => {
    const text = (await rulerLine(page).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return match.test(text) ? text : null;
  });
}

/** Ruler frames a page received from a member, raw. */
function rulerFramesFrom(socket: SocketWatch, memberId: string): string[] {
  return socket.received.filter((f) => f.includes('"t":"eph"') && f.includes(`"from":"${memberId}"`) && f.includes('"k":"ruler"'));
}

/** Clears the ruler, if the row shows one, and leaves the tool. */
async function putAway(page: Page): Promise<void> {
  const clear = rulerBar(page).getByRole("button", { name: "Clear", exact: true });
  if ((await clear.count()) > 0 && (await clear.first().isVisible()) && (await clear.first().isEnabled())) await clear.first().click();
  await pickTool(page, "Select");
}

describe("the walking ruler over stairs", { concurrency: false }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    breeContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    bree = await breeContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    consoles.bree.attach(bree);
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

  test("fl3r-0. a room with Tower's two floors, stairs from Ground up to Upper, Thorn on Ground and Bree on Upper", async () => {
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
    run.dmId = Object.values(dmSocket.state!.members).find((m) => m?.kind === "dm")!.id;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });
    run.anaId = await join(anaContext, "Ana", "#30a46c");
    run.breeId = await join(breeContext, "Bree", "#e5484d");
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower", bounds: BOUNDS } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor", height: 10 } } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.anaId], actor: actor(24) } });
    await ops.send({ t: "character.create", character: { id: run.breeCharacter, name: "Bree", size: "medium", ownerIds: [run.breeId], actor: actor(18) } });
    const at = { size: "medium", visibility: "all", disposition: "ally" } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.ground, kind: "pc", name: "Thorn", ownerIds: [run.anaId], actor: { ref: run.thorn }, ...START, ...at } });
    await ops.send({ t: "token.create", token: { id: run.tBree, sceneId: run.upper, kind: "pc", name: "Bree", ownerIds: [run.breeId], actor: { ref: run.breeCharacter }, ...BREE_AT, ...at } });
    await ops.send({ t: "floorLink.put", link: { id: run.stairsDown, pairId: run.stairsUp, sceneId: run.ground, to: run.upper, rect: { ...STAIRS, w: 1, h: 1 }, kind: "stairs" } });
    await waitFor("both ends in the DM's copy", () => (Object.keys(dmSocket.state?.floorLinks ?? {}).length === 2 ? true : null));
    await openRoom(ana, consoles.ana, anaSocket);
    await openRoom(bree, consoles.bree, breeSocket);
    await showsFloor(ana, "Ground floor", "Ana's phone on Ground, where Thorn is");
    await showsFloor(bree, "Upper floor", "Bree's desk on Upper, where Bree is");
  });

  test("fl3r-1. Ana's walking ruler from Thorn to the stairs reads Walking 25 ft and offers Up the stairs, named for Upper floor, in line", async () => {
    await pickTool(ana, "Ruler");
    await pickOption(ana, "Ruler", "Measure", "Walking");
    await measureDrag(ana, START, STAIRS);
    await lineSays(ana, "Walking 25 ft on Ana's row", /^Walking 25 ft/);
    const up = stairsButton(ana, "Measure on up the stairs to Upper floor");
    await up.waitFor();
    assert.deepEqual(alignmentLines(await measureAlignment(rulerBar(ana)), "Ana's ruler row at 390"), []);
    await shots.take(ana, "fl3r-1-ana-up-the-stairs");
  });

  test("fl3r-2. one press shows Upper floor with the Viewing notice and reads Walking 35 ft, 35 ft before this floor", async () => {
    await stairsButton(ana, "Measure on up the stairs to Upper floor").click();
    await showsFloor(ana, "Upper floor", "Ana's phone on Upper floor");
    await said(ana, "Showing Upper floor.").waitFor({ state: "attached" });
    await ana.getByText("Viewing Upper floor.").first().waitFor();
    await ana.getByRole("button", { name: "Back to Thorn" }).first().waitFor();
    const line = await lineSays(ana, "the carried reading on Ana's row", /^Walking 35 ft · 35 ft before this floor/);
    assert.match(line, /^Walking 35 ft · 35 ft before this floor/);
    // The landing offers the way back down, so focus stays on the button.
    const down = stairsButton(ana, "Measure on down the stairs to Ground floor");
    await down.waitFor();
    await waitFor("Ana's map label", async () => ((await boardSays(ana, "Walking 35 ft")) ? true : null));
    await shots.take(ana, "fl3r-2-ana-carried-reading");
  });

  test("fl3r-3. Bree on Upper reads the same total, then 45 ft once Ana adds a stop, and no frame names the creatures or stairs crossed", async () => {
    await waitFor("Bree's map reads the carried total", async () => ((await boardSays(bree, "Walking 35 ft")) ? true : null));
    assert.ok(await boardSays(bree, "35 ft before this floor"), "under it, the feet before this floor");
    await tapAt(ana, { x: STAIRS.x + 2, y: STAIRS.y });
    await lineSays(ana, "45 ft on Ana's row", /^Walking 45 ft · 35 ft before this floor/);
    await waitFor("Bree's map reads 45 ft", async () => ((await boardSays(bree, "Walking 45 ft")) ? true : null));
    await shots.take(bree, "fl3r-3-bree-reads-carried-ruler");
    const frames = rulerFramesFrom(breeSocket, run.anaId).filter((f) => f.includes('"prior"'));
    assert.ok(frames.length > 0, "Bree was sent the carried frames");
    for (const f of frames) {
      assert.ok(!f.includes('"anchors"') && !f.includes('"ends"'), "no carried frame Bree received names its creatures or ends");
      assert.ok(!f.includes(run.tThorn) && !f.includes(run.stairsDown), "nor Thorn's or the stairs' ids");
    }
    const sent = anaSocket.sent.filter((f) => f.includes('"t":"eph"') && f.includes('"prior"'));
    assert.ok(sent.some((f) => f.includes(run.tThorn) && f.includes(run.stairsDown)), "Ana's device names them for the server");
    await putAway(ana);
    await ana.getByRole("button", { name: "Back to Thorn" }).first().click();
    await showsFloor(ana, "Ground floor", "Ana back on Ground");
  });

  test("fl3r-4. an unexplored landing: a stop on revealed ground the landing joins walks, one past an unseen way round reads No way through", async () => {
    // Upper floor under the fog, revealed east of the stairs and above row 7, with a wall along x = 12 from the top to row 7.
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { fogEnabled: true, blockMovement: true } });
    await ops.send({ t: "fog.live", sceneId: run.upper, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: STAIRS.x + 1, y: 0, w: BOUNDS.w - STAIRS.x - 1, h: 7 } }] });
    await ops.send({ t: "build.edge", sceneId: run.upper, edges: Array.from({ length: 7 }, (_, y) => ({ key: `12,${y},w`, feature: { kind: "wall" as const } })) });
    await sleep(500);
    await pickTool(ana, "Ruler");
    await measureDrag(ana, START, STAIRS);
    await stairsButton(ana, "Measure on up the stairs to Upper floor").click();
    await showsFloor(ana, "Upper floor", "Ana carried to Upper");
    await tapAt(ana, { x: STAIRS.x + 2, y: STAIRS.y });
    const joined = await lineSays(ana, "the revealed stop walks", /^Walking 45 ft/);
    assert.doesNotMatch(joined, /No way through/);
    await tapAt(ana, { x: 14, y: STAIRS.y });
    await lineSays(ana, "No way through past the wall", /No way through/);
    await waitFor("the red leg's label", async () => ((await boardTexts(ana)).includes("No way through") ? true : null));
    await shots.take(ana, "fl3r-4-ana-unexplored-landing");
    await putAway(ana);
    await ana.getByRole("button", { name: "Back to Thorn" }).first().click();
    await showsFloor(ana, "Ground floor", "Ana back on Ground");
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { fogEnabled: false } });
  });

  test("fl3r-5. the DM's private ruler carried up stays on the DM's screen, and one shared before the stairs reaches both players, off and on with Shared", async () => {
    await pickTool(dm, "Ruler");
    await pickOption(dm, "Ruler", "Measure", "Walking");
    const before = { ana: rulerFramesFrom(anaSocket, run.dmId).length, bree: rulerFramesFrom(breeSocket, run.dmId).length };
    await measureDrag(dm, START, STAIRS);
    await stairsButton(dm, "Measure on up the stairs to Upper floor").click();
    await showsFloor(dm, "Upper floor", "the DM on Upper floor");
    await lineSays(dm, "the DM's carried reading", /^Walking 35 ft · 35 ft before this floor/);
    const shared = sharedButton(dm);
    await shared.waitFor();
    assert.equal(await shared.isDisabled(), true, "Shared is off on a ruler carried private");
    assert.equal(await shared.getAttribute("title"), "Share it before it takes the stairs.");
    await shots.take(dm, "fl3r-5-dm-private-carry");
    await sleep(800);
    assert.deepEqual({ ana: rulerFramesFrom(anaSocket, run.dmId).length, bree: rulerFramesFrom(breeSocket, run.dmId).length }, before, "no player was sent the DM's private ruler");
    await rulerBar(dm).getByRole("button", { name: "Clear", exact: true }).click();
    await keyOn(dm, "[");
    await showsFloor(dm, "Ground floor");
    await sharedButton(dm).click();
    await measureDrag(dm, START, STAIRS);
    await stairsButton(dm, "Measure on up the stairs to Upper floor").click();
    await showsFloor(dm, "Upper floor", "the DM's shared carry on Upper");
    await waitFor("Bree reads the DM's shared carry", async () => ((await boardSays(bree, "Walking 35 ft")) ? true : null));
    const toggle = sharedButton(dm);
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await toggle.click();
    await waitFor("the DM's ruler off Bree's map", async () => ((await boardSays(bree, "Walking 35 ft")) ? null : true));
    await toggle.click();
    await waitFor("and back", async () => ((await boardSays(bree, "Walking 35 ft")) ? true : null));
    await shots.take(bree, "fl3r-5-bree-reads-dm-shared-carry");
    await putAway(dm);
    await keyOn(dm, "[");
    await showsFloor(dm, "Ground floor");
  });

  test("fl3r-6. the ruler's row with the stairs button in line at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const lines: string[] = [];
    const sizes: [Page, { width: number; height: number }, string][] = [
      [dm, DESK, "the DM at 1440 x 900"],
      [ana, PHONE, "Ana at 390 x 844"],
      [ana, { width: 320, height: 568 }, "Ana at 320 x 568"],
    ];
    for (const [page, size, label] of sizes) {
      await page.setViewportSize(size);
      for (const scale of [1, 1.3]) {
        await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await page.reload();
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await sleep(600);
        await pickTool(page, "Ruler");
        await measureDrag(page, START, STAIRS);
        await lineSays(page, `${label} at ${scale * 100}%: the reading`, /^Walking 25 ft/);
        const bar = rulerBar(page);
        await bar.getByRole("button", { name: "Measure on up the stairs to Upper floor" }).waitFor();
        lines.push(...alignmentLines(await measureAlignment(bar), `${label} at ${scale * 100}%`));
        await shots.take(page, `fl3r-6-${label.replace(/\W+/g, "-")}-${scale * 100}`);
        await putAway(page);
      }
      await page.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    }
    await ana.setViewportSize(PHONE);
    assert.deepEqual(lines, [], "the ruler's row out of line");
  });

  test("fl3r-7. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
