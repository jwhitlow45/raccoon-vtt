import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, expandBar, OpSocket, Shots, SocketWatch, sleep, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { alignmentLines, disabledLookLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Go up and Go down, and the stairs and ladders on the board
 * (docs/design/design-v1-floors.md phase 2, 6, 10, 11, 13), on the real
 * server serving the production build. Dana the DM is at a desk. Ana
 * plays Thorn on a phone, and Bree plays Bree at a desk. Tower has three
 * floors: Ground (where the players start), Upper, 10 ft above it, and
 * Attic. Stairs lead from Ground up to Upper, and a ladder from Upper up
 * to Attic. Labels carry the prefix FLRL.
 * - flrl-0: the room, its floors, the stairs and the ladder.
 * - flrl-1: the DM's board names each end by its far floor, with "Not
 *   reached yet" where players have not reached it.
 * - flrl-2: on Thorn's turn Ana walks him 25 ft onto the stairs, and the
 *   DM's bar leads its passing row with Go up, named for Upper floor and
 *   tipped with its key, in line at 100% and 130%.
 * - flrl-3: Ana's strip offers Go up as its icon. One press climbs: busy
 *   at once, one climb sent, her phone follows Thorn to Upper floor and
 *   says so, the marker reads Moved 35 ft, and focus lands on Go down.
 * - flrl-4: two quick presses of Go down send one climb.
 * - flrl-5: Bree, who holds Ground and Upper, reads the ladder up to Attic
 *   as "Ladder up", and no frame she was sent names Attic.
 * - flrl-6: the DM's keys: { on stairs that lead up says so, } climbs and
 *   { climbs back, and with two selected neither does anything. Bree's }
 *   off the stairs says she is on none.
 * - flrl-7: locked stairs: Go up stays, dim, with "It's locked." under
 *   the row, named by it, in line, and a press says it again.
 * - flrl-8: Ana's Undo takes the climb back down and her Redo up again,
 *   twice, the marker as it was each time.
 * - flrl-9: Ana's Go up in line at 1440 x 900, 390 x 844 and 320 x 568 at
 *   100% and 130%: the bar's words, the strip's icon, and behind Expand at
 *   320 x 568 at 130%.
 * - flrl-10: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-seven, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 67;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-links-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 24, h: 14 };
/** Thorn's square at the start, 25 ft west of the stairs. */
const START = { x: 3, y: 4 };
/** The stairs' one square on Ground and Upper. */
const STAIRS = { x: 8, y: 4 };
/** The ladder's one square on Upper and Attic. */
const LADDER = { x: 14, y: 4 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let breeContext: BrowserContext;
let dm: Page;
let ana: Page;
let bree: Page;
let ops: OpSocket;
let anaOps: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const breeSocket = new SocketWatch("bree");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), bree: new ConsoleWatch("bree") };

const run = {
  roomId: "",
  roomName: `E2E floors links ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: randomUUID(),
  attic: randomUUID(),
  anaId: "",
  breeId: "",
  thorn: randomUUID(),
  breeCharacter: randomUUID(),
  tThorn: randomUUID(),
  tBree: randomUUID(),
  // An end's id is plain, as a trap's.
  stairsDown: `s${randomUUID().slice(0, 8)}`,
  stairsUp: `s${randomUUID().slice(0, 8)}`,
  ladderDown: `l${randomUUID().slice(0, 8)}`,
  ladderUp: `l${randomUUID().slice(0, 8)}`,
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
const toast = (page: Page, words: string) => page.locator("[data-toast]").filter({ hasText: words }).first();
const barOf = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions`, exact: true });
/** Go up or Go down where it is drawn: the strip keeps its other form mounted and hidden. */
const climbButton = (scope: Page | Locator, dir: "up" | "down") => scope.locator(`[data-climb="${dir}"]:visible`).first();

/** The floor a page shows, by its Floor button's name, or for a player who holds one floor, by the board alone. */
async function showsFloor(page: Page, floor: string, what = `${floor} shown`): Promise<void> {
  const name = `Floor: ${floor}. Show another floor`;
  await waitFor(what, async () => ((await topBar(page).locator('[data-floors="button"]').getAttribute("aria-label").catch(() => null)) === name ? true : null), 15_000);
}

async function keyOn(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press(key);
}

/** Each end the board draws on the floor shown, by id, with its name pill's words (LinkLayer.tsx), "" where it shows none. */
function boardLinks(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    type Node = { getAttr(name: string): unknown; isVisible(): boolean };
    type Stage = { width(): number; find(match: (n: Node) => boolean): Node[] };
    const stages = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.filter((s) => s.width() > 0);
    const out: Record<string, string> = {};
    for (const stage of stages) for (const n of stage.find((node) => node.getAttr("data-floor-link") !== undefined)) out[String(n.getAttr("data-floor-link"))] = String(n.getAttr("data-floor-link-name") ?? "");
    return out;
  });
}

/** The texts on the map's canvas, the movement pill among them. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages.flatMap((s) => s.find("Text")).filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/** The way of the climb button that has focus, or null. */
function focusedClimb(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute("data-climb") ?? null);
}

/** The climbs a page sent, as frames on its room socket. */
function climbsSent(socket: SocketWatch): number {
  return socket.sent.filter((f) => f.includes('"t":"token.climb"')).length;
}

const thornAt = (socket: SocketWatch) => socket.state?.tokens[run.tThorn];

/** A creature's bar after a reload: the page may bring the selection back by itself, and a tap then would let go of it. */
async function barAfterReload(page: Page, name: string, cell: { x: number; y: number }): Promise<Locator> {
  const bar = barOf(page, name);
  const back = await bar.waitFor({ timeout: 3_000 }).then(
    () => true,
    () => false,
  );
  if (!back) {
    await tapCell(page, BOUNDS, cell);
    await bar.waitFor();
  }
  return bar;
}

/** Lets go of whatever a page has selected, by Escape on the map. */
async function deselect(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.getByRole("dialog", { name: /actions$/ }).count()) > 0; i++) await keyOn(page, "Escape");
}

describe("Go up and Go down, and the stairs on the board", { concurrency: false }, () => {
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
    anaOps?.close();
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

  test("flrl-0. a room with Tower's three floors, stairs from Ground up to Upper and a ladder from Upper up to Attic", async () => {
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
    anaOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(anaContext) });
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower", bounds: BOUNDS } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.create", scene: { id: run.attic, name: "Tower", bounds: BOUNDS }, floor: { beside: run.upper, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor", height: 10 } } });
    await ops.send({ t: "scene.update", sceneId: run.attic, patch: { floor: { name: "Attic" } } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.anaId], actor: actor(24) } });
    await ops.send({ t: "character.create", character: { id: run.breeCharacter, name: "Bree", size: "medium", ownerIds: [run.breeId], actor: actor(18) } });
    const at = { size: "medium", visibility: "all", disposition: "ally" } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.ground, kind: "pc", name: "Thorn", ownerIds: [run.anaId], actor: { ref: run.thorn }, ...START, ...at } });
    await ops.send({ t: "token.create", token: { id: run.tBree, sceneId: run.ground, kind: "pc", name: "Bree", ownerIds: [run.breeId], actor: { ref: run.breeCharacter }, x: 3, y: 8, ...at } });
    const one = (p: { x: number; y: number }) => ({ x: p.x, y: p.y, w: 1, h: 1 });
    await ops.send({ t: "floorLink.put", link: { id: run.stairsDown, pairId: run.stairsUp, sceneId: run.ground, to: run.upper, rect: one(STAIRS), kind: "stairs" } });
    await ops.send({ t: "floorLink.put", link: { id: run.ladderDown, pairId: run.ladderUp, sceneId: run.upper, to: run.attic, rect: one(LADDER), kind: "ladder" } });
    await waitFor("four ends in the DM's copy", () => (Object.keys(dmSocket.state?.floorLinks ?? {}).length === 4 ? true : null));
    await openRoom(ana, consoles.ana, anaSocket);
    await openRoom(bree, consoles.bree, breeSocket);
  });

  test("flrl-1. the DM's board names each end by its far floor, with Not reached yet where players have not been", async () => {
    await showsFloor(dm, "Ground floor");
    await waitFor("the stairs on Ground", async () => ((await boardLinks(dm))[run.stairsDown] === "Up to Upper floor · Not reached yet" ? true : null));
    await shots.take(dm, "flrl-1-dm-stairs-not-reached");
    await keyOn(dm, "]");
    await showsFloor(dm, "Upper floor");
    await waitFor("both ends on Upper", async () => {
      const links = await boardLinks(dm);
      return links[run.stairsUp] === "Down to Ground floor" && links[run.ladderDown] === "Up to Attic · Not reached yet" ? true : null;
    });
    await shots.take(dm, "flrl-1-dm-upper-stairs-and-ladder");
    await keyOn(dm, "[");
    await showsFloor(dm, "Ground floor");
  });

  test("flrl-2. Ana walks Thorn 25 ft onto the stairs on his turn, and the DM's bar leads with Go up, named for Upper floor, in line", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.tThorn, value: 20 }, { id: randomUUID(), tokenId: run.tBree, value: 10 }] });
    await ops.send({ t: "encounter.next" });
    await anaOps.send({ t: "token.move", tokenId: run.tThorn, ...STAIRS });
    await waitFor("Thorn on the stairs", () => (thornAt(dmSocket)?.x === STAIRS.x ? true : null));
    await tapCell(dm, BOUNDS, STAIRS);
    const bar = barOf(dm, "Thorn");
    await bar.waitFor();
    const up = climbButton(bar, "up");
    await up.waitFor();
    const passing = bar.locator('[data-bar-row="passing"]');
    assert.equal(await passing.locator("button").first().getAttribute("data-climb"), "up", "Go up leads the passing row");
    assert.equal(await up.getAttribute("aria-label"), "Go up the stairs to Upper floor");
    assert.equal(await up.getAttribute("title"), "Go up the stairs (})");
    assert.equal(await up.getAttribute("aria-keyshortcuts"), "}");
    const lines: string[] = [];
    for (const scale of [1, 1.3]) {
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await dm.reload();
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await sleep(600);
      await barAfterReload(dm, "Thorn", STAIRS);
      await climbButton(bar, "up").waitFor();
      lines.push(...alignmentLines(await measureAlignment(passing), `DM bar 1440 at ${scale * 100}%`));
      await shots.take(dm, `flrl-2-dm-bar-go-up-${scale * 100}`);
    }
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.deepEqual(lines, [], "the DM's passing row out of line");
  });

  test("flrl-3. Ana's strip offers Go up as its icon: one press climbs, her phone follows Thorn to Upper floor, the marker reads Moved 35 ft, and focus lands on Go down", async () => {
    await tapCell(ana, BOUNDS, STAIRS);
    const bar = barOf(ana, "Thorn");
    await bar.waitFor();
    const up = climbButton(bar, "up");
    await up.waitFor();
    assert.equal(await up.getAttribute("aria-label"), "Go up the stairs", "Ana does not hold Upper floor yet, so no floor is named");
    assert.deepEqual(alignmentLines(await measureAlignment(bar), "Ana's strip at 390"), []);
    await shots.take(ana, "flrl-3-ana-strip-go-up");
    const before = climbsSent(anaSocket);
    await up.click();
    await waitFor("Thorn upstairs in Ana's copy", () => (thornAt(anaSocket)?.sceneId === run.upper ? true : null));
    assert.equal(climbsSent(anaSocket) - before, 1, "one climb sent");
    await said(ana, "Thorn is on Upper floor. Showing Upper floor.").waitFor({ state: "attached" });
    await showsFloor(ana, "Upper floor", "Ana's phone on Upper floor");
    await waitFor("Moved 35 ft on Ana's marker", async () => ((await boardTexts(ana)).some((t) => t.startsWith("Moved 35 ft")) ? true : null));
    await climbButton(bar, "down").waitFor();
    await waitFor("focus on Go down", async () => ((await focusedClimb(ana)) === "down" ? true : null), 5_000);
    // The landing's name gives way to the marker, which hangs in its place (picture 07).
    assert.equal((await boardLinks(ana))[run.stairsUp], "", "the landing's name hidden under the marker");
    await shots.take(ana, "flrl-3-ana-landed-moved-35");
  });

  test("flrl-4. two quick presses of Go down send one climb, and focus goes back to Go up", async () => {
    const bar = barOf(ana, "Thorn");
    const down = climbButton(bar, "down");
    const before = climbsSent(anaSocket);
    // Both presses before any answer can arrive.
    await down.evaluate((el) => {
      const button = el as unknown as { click(): void };
      button.click();
      button.click();
    });
    await waitFor("Thorn back on Ground in Ana's copy", () => (thornAt(anaSocket)?.sceneId === run.ground ? true : null));
    await sleep(500);
    assert.equal(climbsSent(anaSocket) - before, 1, "one climb for two presses");
    await climbButton(bar, "up").waitFor();
    await waitFor("focus on Go up", async () => ((await focusedClimb(ana)) === "up" ? true : null), 5_000);
  });

  test("flrl-5. Bree, holding Ground and Upper, reads the ladder up to Attic as Ladder up, and no frame she was sent names Attic", async () => {
    await keyOn(bree, "]");
    await showsFloor(bree, "Upper floor");
    await waitFor("Bree's ends on Upper", async () => {
      const links = await boardLinks(bree);
      return links[run.ladderDown] === "Ladder up" && links[run.stairsUp] === "Down to Ground floor" ? true : null;
    });
    await shots.take(bree, "flrl-5-bree-ladder-up");
    const seen = breeSocket.received.join("\n");
    for (const secret of [run.attic, run.ladderUp, '"Attic"']) assert.ok(!seen.includes(secret), `a frame Bree received holds ${secret}`);
    await keyOn(bree, "[");
    await showsFloor(bree, "Ground floor");
  });

  test("flrl-6. the DM's keys: { on stairs up says so, } climbs and { climbs back, two selected do nothing, and Bree's } off the stairs says she is on none", async () => {
    await deselect(dm);
    await tapCell(dm, BOUNDS, STAIRS);
    await barOf(dm, "Thorn").waitFor();
    await keyOn(dm, "{");
    await toast(dm, "Thorn isn't on stairs or a ladder going down.").waitFor();
    await keyOn(dm, "}");
    await waitFor("Thorn upstairs", () => (thornAt(dmSocket)?.sceneId === run.upper ? true : null));
    await showsFloor(dm, "Upper floor", "the DM's view follows the selected creature");
    await keyOn(dm, "{");
    await waitFor("Thorn back down", () => (thornAt(dmSocket)?.sceneId === run.ground ? true : null));
    await showsFloor(dm, "Ground floor");
    // Thorn and Bree both selected: neither key is anyone's.
    await barOf(dm, "Thorn").waitFor();
    await dm.keyboard.down("Shift");
    await tapCell(dm, BOUNDS, { x: 3, y: 8 });
    await dm.keyboard.up("Shift");
    await dm.getByRole("dialog", { name: "2 selected tokens", exact: true }).waitFor();
    const before = climbsSent(dmSocket);
    await keyOn(dm, "}");
    await sleep(500);
    assert.equal(climbsSent(dmSocket), before, "no climb with two selected");
    await deselect(dm);
    // Bree's own } off the stairs.
    await tapCell(bree, BOUNDS, { x: 3, y: 8 });
    await barOf(bree, "Bree").waitFor();
    await keyOn(bree, "}");
    await toast(bree, "Bree isn't on stairs or a ladder.").waitFor();
    await deselect(bree);
  });

  test("flrl-7. locked stairs: Go up stays dim with It's locked. under the row, named by it, in line, and a press says it again", async () => {
    await ops.send({ t: "floorLink.update", linkId: run.stairsDown, patch: { locked: true } });
    await deselect(dm);
    await tapCell(dm, BOUNDS, STAIRS);
    const bar = barOf(dm, "Thorn");
    await bar.waitFor();
    const up = climbButton(bar, "up");
    await waitFor("Go up off", async () => ((await up.getAttribute("aria-disabled")) === "true" ? true : null));
    const noteId = await up.getAttribute("aria-describedby");
    assert.ok(noteId, "named by its note");
    assert.equal((await dm.locator(`[id="${noteId}"]`).innerText()).trim(), "It's locked.");
    const lines = [...alignmentLines(await measureAlignment(bar), "the locked Go up"), ...(await disabledLookLines(bar.locator('[data-bar-row="passing"]'), "the locked Go up"))];
    assert.deepEqual(lines, [], "the locked Go up out of line or not dim");
    await shots.take(dm, "flrl-7-dm-locked");
    const before = climbsSent(dmSocket);
    await up.click();
    await toast(dm, "It's locked.").waitFor();
    assert.equal(climbsSent(dmSocket), before, "a press sends nothing");
    await ops.send({ t: "floorLink.update", linkId: run.stairsDown, patch: { locked: false } });
    await deselect(dm);
  });

  test("flrl-8. Ana's Undo takes the climb back down the stairs and her Redo up again, twice, the marker as it was each time", async () => {
    await deselect(ana);
    await tapCell(ana, BOUNDS, STAIRS);
    const bar = barOf(ana, "Thorn");
    await climbButton(bar, "up").click();
    await waitFor("Thorn upstairs", () => (thornAt(anaSocket)?.sceneId === run.upper ? true : null));
    const moved = await waitFor("the marker upstairs", async () => (await boardTexts(ana)).find((t) => t.startsWith("Moved ")));
    for (let i = 0; i < 2; i++) {
      await anaOps.step("undo");
      await waitFor(`undo ${i + 1}: Thorn back on Ground`, () => (thornAt(anaSocket)?.sceneId === run.ground ? true : null));
      await anaOps.step("redo");
      await waitFor(`redo ${i + 1}: Thorn upstairs`, () => (thornAt(anaSocket)?.sceneId === run.upper ? true : null));
      await showsFloor(ana, "Upper floor");
      await waitFor(`redo ${i + 1}: the marker as it was`, async () => ((await boardTexts(ana)).includes(moved) ? true : null));
    }
    await shots.take(ana, "flrl-8-ana-after-undo-redo");
    // Back down for the sweep, by the stairs.
    await climbButton(bar, "down").click();
    await waitFor("Thorn back on Ground", () => (thornAt(anaSocket)?.sceneId === run.ground ? true : null));
  });

  test("flrl-9. Ana's Go up in line at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%: words, the icon, and behind Expand at 320 x 568 at 130%", async () => {
    const lines: string[] = [];
    const forms: string[] = [];
    try {
      for (const size of [DESK, PHONE, { width: 320, height: 568 }]) {
        for (const scale of [1, 1.3]) {
          const at = `${size.width}x${size.height}${scale === 1 ? "" : "-130"}`;
          await ana.setViewportSize(size);
          await ana.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
          await ana.reload();
          await ana.getByRole("status", { name: "Connected" }).first().waitFor();
          await sleep(800);
          const bar = await barAfterReload(ana, "Thorn", STAIRS);
          await sleep(300);
          let up = climbButton(bar, "up");
          if ((await up.count()) === 0) {
            forms.push(`${at}: behind Expand`);
            await expandBar(bar);
            up = climbButton(bar, "up");
          } else forms.push(`${at}: ${(await up.innerText()).trim() === "" ? "icon" : "words"}`);
          await up.waitFor();
          lines.push(...alignmentLines(await measureAlignment(bar), `${at} Thorn's bar`));
          await shots.take(ana, `flrl-9-ana-go-up-${at}`);
          await deselect(ana);
        }
      }
    } finally {
      await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await ana.setViewportSize(PHONE);
      await ana.reload();
      await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    }
    console.log(`flrl-9: ${forms.join(", ")}`);
    assert.ok(forms.includes("390x844: icon"), `390 x 844 draws the icon: ${forms.join(", ")}`);
    assert.ok(forms.includes("320x568-130: behind Expand"), `320 x 568 at 130% keeps it behind Expand: ${forms.join(", ")}`);
    assert.deepEqual(lines, [], "Go up out of line");
  });

  test("flrl-10. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
