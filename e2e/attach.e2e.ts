import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { RoomState, Token } from "../shared/model.ts";
import { barControl, ConsoleWatch, dragCells, dragWorld, expandBar, OpSocket, pagePoint, Shots, SocketWatch, startServer, tapCell, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * Attached tokens end to end (docs/design-v1-attach.md 13), on the real
 * server serving the production build: the DM on a desktop, Pat on a phone
 * at 390 x 844 and Sam on a desktop. In a fight, on Thorn's turn, Pat gets
 * Thorn on the warhorse, Controlled, from the bar's Attach sheet, moves the
 * horse by dragging Thorn, with the costs on Thorn's and the horse's paths,
 * and gets off. The DM perches a hidden imp on the cult fanatic from the
 * Attach popover and moves the fanatic: no frame Pat's or Sam's page
 * receives ever names the imp. The DM marks Goblin Grappled, and Sam drags
 * it with Bree.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-four, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 24;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-attach-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const BOUNDS = { w: 16, h: 12 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let samContext: BrowserContext;
let dm: Page;
let pat: Page;
let sam: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const samSocket = new SocketWatch("sam");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), sam: new ConsoleWatch("sam") };

const run = {
  roomId: "",
  roomName: `E2E attach ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  samId: "",
  thornChar: randomUUID(),
  breeChar: randomUUID(),
  thorn: randomUUID(),
  horse: randomUUID(),
  bree: randomUUID(),
  goblin: randomUUID(),
  fanatic: randomUUID(),
  imp: randomUUID(),
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
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

function tokenOp(id: string, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } };
}

function token(socket: SocketWatch, id: string): Token | undefined {
  return (socket.state as RoomState | null)?.tokens[id];
}

/** The token's bar, a dialog named for it. */
function bar(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `${name} actions` });
}

/** Selects a token by a tap or a click on it: on its cell's center, or for a Tiny one at its own middle. */
async function select(page: Page, name: string, cell: { x: number; y: number }, tiny = false): Promise<Locator> {
  // An expanded bar lasts through a drag and covers the map under it, which a drop never moves (docs/design-v1-bar-compact.md 5.3): it rests first, as a player would.
  const expanded = page.locator('[role="dialog"][data-bar-state="expanded"]');
  if ((await expanded.count()) > 0) await expanded.getByRole("button", { name: "Collapse", exact: true }).first().click();
  if (tiny) {
    const p = await pagePoint(page, BOUNDS, { x: cell.x + 0.25, y: cell.y + 0.25 });
    await page.mouse.click(p.x, p.y);
  } else await tapCell(page, BOUNDS, cell);
  const b = bar(page, name);
  await b.waitFor();
  return b;
}

/** The texts on the map's canvas, the movement pill among them. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages[0]!.find("Text").filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/**
 * Another of Pat's devices, at its own size and interface size, signed in
 * as Pat. While `route.hold` is on, an attach the page sends never leaves
 * it, so the list waits on an answer that never comes, and the server
 * never hears of it.
 */
async function patDevice(viewport: { width: number; height: number }, scale = 1, touch = true) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
  await context.addCookies(await patContext.cookies(server.origin));
  const page = await context.newPage();
  const route = { hold: false, held: 0 };
  await page.routeWebSocket(/\/ws\?room=/, (ws) => {
    const upstream = ws.connectToServer();
    ws.onMessage((m) => {
      if (route.hold && typeof m === "string" && m.includes('"token.attach"')) route.held++;
      else upstream.send(m);
    });
    upstream.onMessage((m) => ws.send(m));
  });
  if (scale !== 1) {
    await page.goto(`${server.origin}/`);
    await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  }
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  return { context, page, route };
}

/** The little of an element a measure in the page reads, since e2e has no DOM types. */
type Elem = {
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number };
  querySelector(selector: string): Elem | null;
  getAttribute(name: string): string | null;
  children: ArrayLike<Elem>;
  textContent: string | null;
};

/** The DM on a phone of their own at its size and interface size, signed in as the DM. */
async function dmPhone(viewport: { width: number; height: number }, scale: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addCookies(await dmContext.cookies(server.origin));
  const page = await context.newPage();
  if (scale !== 1) {
    await page.goto(`${server.origin}/`);
    await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  }
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.locator(".konvajs-content").first().waitFor();
  return { context, page };
}

/** Which of the Attach list's rows has the focus, by its place among them, or -1. */
function focusedRow(list: Locator): Promise<number> {
  return list.evaluate((el) => {
    const root = el as unknown as { querySelectorAll(selector: string): ArrayLike<unknown> };
    const active = (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement;
    return Array.from(root.querySelectorAll("[data-attach-row]")).indexOf(active);
  });
}

/** Whether any frame a page received names the token. */
function everNamed(socket: SocketWatch, id: string): boolean {
  return socket.received.some((frame) => frame.includes(id));
}

describe("raccoon-vtt attached tokens", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    samContext = await browser.newContext({ viewport: DESKTOP });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    sam = await samContext.newPage();
    patCdp = await patContext.newCDPSession(pat);
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    consoles.sam.attach(sam);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    await samSocket.attach(samContext, sam);
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

  test("at-0. the DM's room on a desktop, Pat with Thorn and his warhorse on a phone, Sam with Bree on a desktop, a goblin, a cult fanatic and a hidden imp, in a fight on Thorn's turn", async () => {
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
    run.patId = await join(patContext, "Pat", "#30a46c");
    run.samId = await join(samContext, "Sam", "#e5484d");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send({ t: "character.create", character: { id: run.breeChar, name: "Bree", size: "medium", ownerIds: [run.samId], actor: actor() } });
    await ops.send(tokenOp(run.thorn, { kind: "pc", name: "Thorn", x: 3, y: 5, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tokenOp(run.horse, { kind: "npc", name: "Warhorse", size: "large", x: 4, y: 3, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor({ speeds: { walk: 60 } }) } }));
    await ops.send(tokenOp(run.bree, { kind: "pc", name: "Bree", x: 9, y: 8, disposition: "ally", actor: { ref: run.breeChar } }));
    await ops.send(tokenOp(run.goblin, { kind: "monster", name: "Goblin", x: 10, y: 8, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tokenOp(run.fanatic, { kind: "monster", name: "Cult Fanatic", x: 12, y: 3, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tokenOp(run.imp, { kind: "monster", name: "Imp", size: "tiny", x: 14, y: 3, visibility: "dm", disposition: "hostile", actor: { inline: actor() } }));
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: randomUUID(), tokenId: run.thorn, value: 18 },
        { id: randomUUID(), tokenId: run.goblin, value: 14 },
        { id: randomUUID(), tokenId: run.horse, value: 12 },
        { id: randomUUID(), tokenId: run.bree, value: 6 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    for (const [page, socket] of [
      [pat, patSocket],
      [sam, samSocket],
    ] as const) {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await waitFor("the player's snapshot", () => token(socket, run.goblin));
      await page.locator(".konvajs-content").first().waitFor();
    }
    await dm.locator(".konvajs-content").first().waitFor();
    assert.equal(token(patSocket, run.imp), undefined, "the hidden imp reached Pat");
  });

  test("lp2-3a. Pat's Attach list on a 430 px phone, an upright tablet's card and a 320 px phone at 130%: its rows span the list, and Ride asks Controlled or Independent side by side, under them a line saying what the chosen one does (docs/design-v1-look-pass-2.md 2.5 and 2.7)", async () => {
    for (const view of [
      { name: "p430", viewport: { width: 430, height: 932 }, scale: 1 },
      { name: "t820", viewport: { width: 820, height: 1180 }, scale: 1 },
      { name: "p320-130", viewport: { width: 320, height: 568 }, scale: 1.3 },
    ]) {
      const device = await patDevice(view.viewport, view.scale);
      try {
        const thorn = await select(device.page, "Thorn", { x: 3, y: 5 });
        await (await barControl(thorn, "Attach")).tap();
        const sheet = device.page.getByRole("dialog", { name: "Attach Thorn" });
        await sheet.waitFor();
        const row = sheet.getByRole("button", { name: "Ride Warhorse" });
        await row.waitFor();
        const card = (await sheet.locator(":scope > section").boundingBox())!;
        const box = (await row.boundingBox())!;
        const left = box.x - card.x;
        const right = card.x + card.width - (box.x + box.width);
        assert.ok(Math.abs(left - right) <= 1.5, `${view.name}: the row stops short of the card's right edge (${left.toFixed(1)} px at its left, ${right.toFixed(1)} at its right)`);
        await row.tap();
        assert.equal(await row.getAttribute("aria-expanded"), "true");
        const controlled = sheet.getByRole("radio", { name: "Controlled", exact: true });
        const independent = sheet.getByRole("radio", { name: "Independent", exact: true });
        await controlled.waitFor();
        const a = (await controlled.boundingBox())!;
        const b = (await independent.boundingBox())!;
        assert.ok(Math.abs(a.y - b.y) <= 1 && b.x >= a.x + a.width - 1, `${view.name}: the two words stack (${JSON.stringify([a, b])})`);
        const group = sheet.getByRole("radiogroup", { name: "How Warhorse moves" });
        const described = async () => {
          const id = await group.getAttribute("aria-describedby");
          return id ? device.page.locator(`[id="${id}"]`).innerText() : null;
        };
        assert.equal(await described(), "Warhorse moves on Thorn's turn.");
        await shots.take(device.page, `attach-lp2-3a-${view.name}-ride`);
        await independent.tap();
        await waitFor("the line for Independent", async () => ((await described()) === "Warhorse keeps its own turn." ? true : null));
        const scrolls = await sheet.locator(":scope > section > div").first().evaluate((el) => {
          const body = el as unknown as { scrollWidth: number; clientWidth: number };
          return body.scrollWidth > body.clientWidth + 1;
        });
        assert.equal(scrolls, false, `${view.name}: the sheet scrolls sideways`);
      } finally {
        await device.context.close();
      }
    }
  });

  test("lp2-3c-busy. in the fight, on another of Pat's phones, Ride Warhorse, Controlled, waits on the server: after 200 ms its row and its Ride show busy, and a second tap sends nothing (docs/design-v1-look-pass-2.md 2.5)", async () => {
    const device = await patDevice(PHONE);
    try {
      const thorn = await select(device.page, "Thorn", { x: 3, y: 5 });
      await (await barControl(thorn, "Attach")).tap();
      const sheet = device.page.getByRole("dialog", { name: "Attach Thorn" });
      await sheet.waitFor();
      const row = sheet.getByRole("button", { name: "Ride Warhorse" });
      await row.tap();
      device.route.hold = true;
      const ride = sheet.getByRole("button", { name: "Ride", exact: true });
      await ride.tap();
      await waitFor("the attach held on the device", () => (device.route.held === 1 ? true : null));
      await waitFor("Ride busy", async () => ((await ride.getAttribute("aria-busy")) === "true" ? true : null));
      assert.equal(await row.getAttribute("aria-busy"), "true", "the row waits with its Ride");
      assert.equal(await row.getAttribute("data-attach-row"), "", "the busy row keeps its key hook");
      await shots.take(device.page, "attach-lp2-3c-ride-busy");
      await ride.tap();
      await device.page.waitForTimeout(300);
      assert.equal(device.route.held, 1, "a second tap sent another attach");
      assert.equal(token(patSocket, run.thorn)?.attached, undefined, "the held ride reached the server");
    } finally {
      await device.context.close();
    }
  });

  test("at-1. on Thorn's turn Pat opens Attach on Thorn's bar, picks Ride Warhorse, Controlled, and pays half Thorn's Speed", async () => {
    const thorn = await select(pat, "Thorn", { x: 3, y: 5 });
    await (await barControl(thorn, "Attach")).tap();
    const sheet = pat.getByRole("dialog", { name: "Attach Thorn" });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Ride Warhorse" }).tap();
    await sheet.getByRole("radio", { name: "Controlled", exact: true }).waitFor();
    await shots.take(pat, "attach-ride-sheet");
    await sheet.getByRole("button", { name: "Ride", exact: true }).tap();
    const rider = await waitFor("Thorn on the warhorse", () => (token(patSocket, run.thorn)?.attached?.to === run.horse ? token(patSocket, run.thorn) : null));
    assert.deepEqual(rider.attached, { to: run.horse, kind: "ride", steer: true });
    const stops = rider.path?.stops ?? [];
    assert.equal(stops[stops.length - 1]?.cost, 15, "getting on costs half Thorn's 30 ft");
    const encounter = patSocket.state!.encounter!;
    const horseRow = encounter.entries.find((e) => e.tokenId === run.horse);
    assert.equal(horseRow?.value, 18, "the controlled mount's row takes its rider's value");
    assert.deepEqual(encounter.turnStart?.mounts, [run.horse], "the horse shares Thorn's turn");
  });

  test("at-2. Pat drags Thorn and the warhorse goes, Thorn riding: the horse's path holds the walk, Thorn's the carried leg", async () => {
    const horse = token(patSocket, run.horse)!;
    const rider = token(patSocket, run.thorn)!;
    const from = await pagePoint(pat, BOUNDS, { x: rider.x + 0.5, y: rider.y + 0.5 });
    const to = await pagePoint(pat, BOUNDS, { x: rider.x + 4.5, y: rider.y + 0.5 });
    await touchSwipe(patCdp, from, to, { steps: 14, everyMs: 20 });
    const moved = await waitFor("the warhorse 4 squares east", () => (token(patSocket, run.horse)?.x === horse.x + 4 ? token(patSocket, run.horse) : null));
    assert.equal(token(patSocket, run.thorn)?.x, rider.x + 4, "Thorn rode along");
    assert.equal(moved.path?.stops.length, 2, "the horse's own leg, on Thorn's turn");
    assert.equal(moved.path?.stops[1]?.moved, 20);
    const thornStops = token(patSocket, run.thorn)!.path!.stops;
    assert.equal(thornStops[thornStops.length - 1]?.uncounted, true, "Thorn's carried leg does not count");
    // One pill, on the horse: its walk against its own 60 ft, and Thorn's own movement, the half Speed he paid to get on, under it.
    const pill = await waitFor("the pill on the warhorse", async () => (await boardTexts(pat)).find((t) => t.startsWith("Moved 20 ft")));
    assert.equal(pill, "Moved 20 ft\n40 ft left\nThorn: 5 ft, used 15 ft");
    await shots.take(pat, "attach-ride-moved");
  });

  test("at-3. Pat taps Get off on Thorn's bar: Thorn stands beside the warhorse, paying half his Speed, and the horse shares the turn no more", async () => {
    const rider = token(patSocket, run.thorn)!;
    const thorn = await select(pat, "Thorn", { x: rider.x, y: rider.y });
    await (await barControl(thorn, "Get off")).tap();
    const off = await waitFor("Thorn off the warhorse", () => (token(patSocket, run.thorn)?.attached === undefined ? token(patSocket, run.thorn) : null));
    const horse = token(patSocket, run.horse)!;
    const inside = off.x >= horse.x && off.x < horse.x + 2 && off.y >= horse.y && off.y < horse.y + 2;
    assert.ok(!inside, "Thorn stands clear of the horse");
    const costs = off.path!.stops.map((s) => s.cost ?? 0);
    assert.ok(costs.includes(15), `getting off costs half Thorn's Speed: ${JSON.stringify(costs)}`);
    assert.equal(patSocket.state!.encounter!.turnStart?.mounts, undefined);
    await shots.take(pat, "attach-got-off");
  });

  test("at-3b. Pat taps Undo move on Thorn's bar: Thorn is back in the saddle, and the horse shares the turn again", async () => {
    const rider = token(patSocket, run.thorn)!;
    const thorn = await select(pat, "Thorn", { x: rider.x, y: rider.y });
    await (await barControl(thorn, "Undo move")).tap();
    const back = await waitFor("Thorn on the warhorse again", () => (token(patSocket, run.thorn)?.attached?.to === run.horse ? token(patSocket, run.thorn) : null));
    assert.deepEqual(back.attached, { to: run.horse, kind: "ride", steer: true });
    await waitFor("the horse on the turn's list", () => (patSocket.state!.encounter!.turnStart?.mounts?.includes(run.horse) ? true : null));
  });

  test("fu22b-at. with a creature on every spot beside the warhorse, Thorn's Get off is unavailable but keeps its focus, and Enter on it sends nothing (review LP2L3)", async () => {
    const horse = token(patSocket, run.horse)!;
    // The ring of cells around the horse's 2 x 2, each taken by a goblin, so Thorn has nowhere to get off to.
    const ring: { x: number; y: number }[] = [];
    for (let x = horse.x - 1; x <= horse.x + 2; x++) for (let y = horse.y - 1; y <= horse.y + 2; y++) if (x < horse.x || x > horse.x + 1 || y < horse.y || y > horse.y + 1) ring.push({ x, y });
    const crowd = ring.map(() => randomUUID());
    for (const [i, at] of ring.entries()) await ops.send(tokenOp(crowd[i]!, { kind: "monster", name: `Crowd ${i + 1}`, x: at.x, y: at.y, disposition: "hostile", actor: { inline: actor() } }));
    try {
      await waitFor("the crowd on Pat's phone", () => (crowd.every((id) => token(patSocket, id)) ? true : null));
      const rider = token(patSocket, run.thorn)!;
      const thorn = await select(pat, "Thorn", { x: rider.x, y: rider.y });
      const getOff = await barControl(thorn, "Get off");
      await waitFor("Get off unavailable", async () => ((await getOff.getAttribute("aria-disabled")) === "true" ? true : null));
      await thorn.getByText("No room to get off.", { exact: true }).waitFor();
      // Unavailable, not disabled: it takes focus and keeps its place in the keys' order.
      await getOff.focus();
      assert.equal(await getOff.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, "Get off does not take focus");
      // An unguarded press would send a get off the server refuses, with no spot to stand on.
      const heard = patSocket.received.length;
      await pat.keyboard.press("Enter");
      await pat.waitForTimeout(500);
      assert.equal(token(patSocket, run.thorn)?.attached?.to, run.horse, "Enter on an unavailable Get off took Thorn off the horse");
      assert.deepEqual(
        patSocket.received.slice(heard).filter((f) => f.includes('"rejects"')),
        [],
        "Enter on an unavailable Get off sent a get off",
      );
      assert.equal(await getOff.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, "Enter took Get off's focus away");
      await shots.take(pat, "attach-fu22b-no-room-to-get-off");
    } finally {
      for (const id of crowd) await ops.send({ t: "token.delete", tokenId: id });
      await waitFor("the crowd gone", () => (crowd.every((id) => !token(patSocket, id)) ? true : null));
    }
  });

  test("at-4. the DM perches the hidden imp on the cult fanatic from the Attach popover and moves the fanatic: the imp follows, and no frame to Pat or Sam names it", async () => {
    await select(dm, "Imp", { x: 14, y: 3 }, true);
    await (await barControl(bar(dm, "Imp"), "Attach")).click();
    const popover = dm.getByRole("dialog", { name: "Attach" });
    await popover.waitFor();
    await popover.getByRole("button", { name: "Perch on Cult Fanatic" }).click();
    await waitFor("the imp on the fanatic", () => token(dmSocket, run.imp)?.attached?.to === run.fanatic || null);
    await shots.take(dm, "attach-dm-imp");
    await dm.keyboard.press("Escape");
    await dragCells(dm, BOUNDS, { x: 12, y: 3 }, { x: 12, y: 6 });
    const fanatic = await waitFor("the fanatic moved", () => (token(dmSocket, run.fanatic)?.y === 6 ? token(dmSocket, run.fanatic) : null));
    const imp = token(dmSocket, run.imp)!;
    assert.ok(imp.y >= fanatic.y && imp.y < fanatic.y + 1, "the imp rode along");
    await waitFor("Pat's copy of the moved fanatic", () => token(patSocket, run.fanatic)?.y === 6 || null);
    await waitFor("Sam's copy of the moved fanatic", () => token(samSocket, run.fanatic)?.y === 6 || null);
    for (const socket of [patSocket, samSocket]) assert.equal(everNamed(socket, run.imp), false, `a frame to ${socket.label} named the imp`);
  });

  test("at-5. the DM marks the goblin Grappled, and Sam on a desktop drags it with Bree from the Attach popover", async () => {
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblin }, effect: { id: randomUUID(), key: "grappled" } });
    await waitFor("Sam's copy of the Grappled goblin", () => {
      const g = token(samSocket, run.goblin);
      return g && "inline" in g.actor && g.actor.inline.effects.some((e) => e.key === "grappled");
    });
    await select(sam, "Bree", { x: 9, y: 8 });
    await (await barControl(bar(sam, "Bree"), "Attach")).click();
    const popover = sam.getByRole("dialog", { name: "Attach" });
    await popover.waitFor();
    await popover.getByRole("button", { name: "Drag Goblin" }).click();
    await waitFor("the goblin dragged by Bree", () => token(samSocket, run.goblin)?.attached?.kind === "drag" || null);
    await shots.take(sam, "attach-drag-goblin");
    await sam.keyboard.press("Escape");
    await dragCells(sam, BOUNDS, { x: 9, y: 8 }, { x: 6, y: 8 });
    await waitFor("Bree 3 squares west", () => token(samSocket, run.bree)?.x === 6 || null);
    const goblin = await waitFor("the goblin along", () => (token(samSocket, run.goblin)?.x === 7 ? token(samSocket, run.goblin) : null));
    assert.equal(goblin.attached?.to, run.bree, "the goblin stays dragged within reach");
    for (const socket of [patSocket, samSocket]) assert.equal(everNamed(socket, run.imp), false, `a frame to ${socket.label} named the imp`);
  });

  test("at-6-fu20a. the DM drags a mule by its middle while it carries a lamp and a chest and an owl perches on it: all four go, and a press near the mule's edge on the lamp takes the lamp alone (review LP12-AT-3)", async () => {
    const mule = randomUUID();
    const lamp = randomUUID();
    const chest = randomUUID();
    const owl = randomUUID();
    await ops.send(tokenOp(mule, { kind: "npc", name: "Mule", x: 2, y: 9, disposition: "ally", actor: { inline: actor() } }));
    // Three of the mule's four quarters, as the live play's carrier had them.
    await ops.send(tokenOp(lamp, { kind: "object", name: "Lamp", size: "tiny", x: 2.5, y: 9, actor: { inline: actor() } }));
    await ops.send(tokenOp(chest, { kind: "object", name: "Chest", size: "tiny", x: 2.5, y: 9.5, actor: { inline: actor() } }));
    await ops.send(tokenOp(owl, { kind: "npc", name: "Owl", size: "tiny", x: 2, y: 9, disposition: "ally", actor: { inline: actor() } }));
    await ops.send({ t: "token.attach", tokenId: lamp, to: mule, kind: "carry", x: 2.5, y: 9, elevation: 0 });
    await ops.send({ t: "token.attach", tokenId: chest, to: mule, kind: "carry", x: 2.5, y: 9.5, elevation: 0 });
    await ops.send({ t: "token.attach", tokenId: owl, to: mule, kind: "perch", x: 2, y: 9, elevation: 0 });
    await waitFor("the mule's load", () => [lamp, chest, owl].every((id) => token(dmSocket, id)?.attached?.to === mule) || null);
    // A press a little off the mule's center, on the lamp, which draws over the mule.
    await dragWorld(dm, BOUNDS, { x: 2.55, y: 9.45 }, { x: 2.55, y: 10.45 });
    await waitFor("the mule moved", () => token(dmSocket, mule)?.y === 10 || null);
    for (const [id, x, y] of [[lamp, 2.5, 10], [chest, 2.5, 10.5], [owl, 2, 10]] as const) {
      const t = await waitFor("its load along", () => (token(dmSocket, id)?.y === y ? token(dmSocket, id) : null));
      assert.deepEqual([t.x, t.attached?.to], [x, mule]);
    }
    await shots.take(dm, "attach-fu20a-mule-middle");
    // Near the mule's edge the lamp is on top, and a drag of it alone off the mule lets it go.
    await dragWorld(dm, BOUNDS, { x: 2.9, y: 10.1 }, { x: 4.9, y: 10.1 });
    const dropped = await waitFor("the lamp put down", () => (token(dmSocket, lamp)?.attached === undefined ? token(dmSocket, lamp) : null));
    assert.ok(dropped.x >= 4, `the lamp at ${dropped.x}, ${dropped.y}`);
    assert.deepEqual([token(dmSocket, mule)?.x, token(dmSocket, mule)?.y], [2, 10], "the mule stays");
  });

  test("lp15-at-1. Sam drags Bree into a closet whose 5 ft opening the goblin beside her cannot follow through: the note after the drop names the goblin (review LP15-FU-1)", async () => {
    // A closet at x 12 to 14, y 7 to 9, open only at its south wall's west square, so Bree alone fits through and the goblin a square east of her meets the wall.
    const wall = { kind: "wall" };
    const edges: { key: string; feature: unknown }[] = [];
    for (let x = 12; x <= 14; x++) edges.push({ key: `${x},7,n`, feature: wall });
    for (const x of [13, 14]) edges.push({ key: `${x},10,n`, feature: wall });
    for (let y = 7; y <= 9; y++) edges.push({ key: `12,${y},w`, feature: wall }, { key: `15,${y},w`, feature: wall });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });
    await ops.send({ t: "token.update", tokenId: run.bree, patch: { x: 9, y: 10, elevation: 0 } });
    await waitFor("Bree and the goblin by the closet", () => (token(samSocket, run.bree)?.y === 10 && token(samSocket, run.goblin)?.x === 10 && token(samSocket, run.goblin)?.y === 10) || null);
    await dragCells(sam, BOUNDS, { x: 9, y: 10 }, { x: 12, y: 8 });
    const note = sam.getByRole("status").filter({ hasText: /through there|Stopped at a wall/ });
    await note.first().waitFor();
    await shots.take(sam, "attach-lp15-follower-note");
    assert.equal((await note.first().innerText()).split("\n")[0], "Goblin can't follow through there.");
    assert.ok((token(samSocket, run.bree)?.y ?? 0) >= 10, "Bree is held outside the closet");
    assert.equal(token(samSocket, run.goblin)?.attached?.to, run.bree, "the goblin is still in Bree's tow");
  });

  test("lp15-at-2. the DM taps a Ride row at the foot of an Attach pop-up longer than its box: the question and its Ride scroll into view, clear of \"Scroll for more\" (review LP15-FU-5)", async () => {
    const scout = randomUUID();
    await ops.send(tokenOp(scout, { kind: "npc", name: "Scout", x: 1, y: 1, disposition: "ally", actor: { inline: actor() } }));
    // Mules all round her, near and farther away, so the DM's list outgrows the pop-up.
    for (const [i, [x, y]] of [[2, 0], [2, 2], [0, 2], [4, 0], [4, 2], [6, 0], [6, 2], [0, 4]].entries()) {
      await ops.send(tokenOp(randomUUID(), { kind: "npc", name: `Mule ${i + 1}`, size: "large", x, y, disposition: "ally", actor: { inline: actor() } }));
    }
    await waitFor("the scout on the DM's map", () => token(dmSocket, scout));
    await dm.keyboard.press("Escape");
    const b = await select(dm, "Scout", { x: 1, y: 1 });
    await (await barControl(b, "Attach")).click();
    const popover = dm.getByRole("dialog", { name: "Attach" });
    await popover.waitFor();
    const more = popover.getByText("Scroll for more");
    await more.waitFor();
    const box = (await popover.boundingBox())!;
    // The lowest Ride row whose top shows above the fade at the foot.
    const rides = popover.getByRole("button", { name: /^Ride / });
    let pick = -1;
    for (let i = 0; i < (await rides.count()); i++) {
      const r = await rides.nth(i).boundingBox();
      if (r && r.y + 8 < box.y + box.height - 48) pick = i;
    }
    assert.ok(pick >= 0, "no Ride row shows");
    await rides.nth(pick).click();
    const ride = popover.getByRole("button", { name: "Ride", exact: true });
    await ride.waitFor();
    await dm.waitForTimeout(300);
    await shots.take(dm, "attach-lp15-ride-in-view");
    const r = (await ride.boundingBox())!;
    const now = (await popover.boundingBox())!;
    assert.ok(r.y >= now.y && r.y + r.height <= now.y + now.height, `Ride (${r.y} to ${r.y + r.height}) is cut by the pop-up (${now.y} to ${now.y + now.height})`);
    if (await more.isVisible()) {
      const fade = (await more.boundingBox())!;
      assert.ok(r.y + r.height <= fade.y + 1, `Ride (foot ${r.y + r.height}) sits under "Scroll for more" (top ${fade.y})`);
    }
    await dm.keyboard.press("Escape");
  });

  test("lp2-3c-keys. in the DM's pop-up for the scout, Down, Up, Home and End move through the near rows and Farther away as one list, wrapping at the ends (docs/design-v1-look-pass-2.md 3, lane 3)", async () => {
    const b = await select(dm, "Scout", { x: 1, y: 1 });
    await (await barControl(b, "Attach")).click();
    const popover = dm.getByRole("dialog", { name: "Attach Scout" });
    await popover.waitFor();
    const farther = popover.getByRole("group", { name: "Farther away" });
    await farther.waitFor();
    const rows = popover.locator("[data-attach-row]");
    const count = await rows.count();
    const near = count - (await farther.locator("[data-attach-row]").count());
    assert.ok(near >= 1 && near < count, `near ${near} of ${count}`);
    await rows.first().focus();
    const list = popover;
    for (let i = 1; i < near; i++) await dm.keyboard.press("ArrowDown");
    assert.equal(await focusedRow(list), near - 1, "Down walks the near rows");
    await dm.keyboard.press("ArrowDown");
    assert.equal(await focusedRow(list), near, "Down from the last near row goes on to Farther away's first");
    await dm.keyboard.press("ArrowUp");
    assert.equal(await focusedRow(list), near - 1, "Up goes back across the heading");
    await dm.keyboard.press("End");
    assert.equal(await focusedRow(list), count - 1, "End goes to the last row, in Farther away");
    await dm.keyboard.press("ArrowDown");
    assert.equal(await focusedRow(list), 0, "Down from the last row wraps to the first");
    await dm.keyboard.press("ArrowUp");
    assert.equal(await focusedRow(list), count - 1, "Up from the first row wraps to the last");
    await dm.keyboard.press("Home");
    assert.equal(await focusedRow(list), 0, "Home goes to the first row");
    await shots.take(dm, "attach-lp2-3c-keys");
    await dm.keyboard.press("Escape");
  });

  test("pl2-a. on the DM's phone at 390 and 360 px, and 390 at 130%, a hobgoblin carrying a lantern and dragging a prisoner: its window's line gives each kind a row, the word first and its names beside it on the word's line (docs/design-v1-polish.md R5)", async () => {
    const hobgoblin = randomUUID();
    const lantern = randomUUID();
    const prisoner = randomUUID();
    await ops.send(tokenOp(hobgoblin, { kind: "monster", name: "Hobgoblin", x: 9, y: 1, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tokenOp(lantern, { kind: "object", name: "Lantern", size: "tiny", x: 9, y: 1.5, actor: { inline: actor({ hp: { cur: 1, max: 1, temp: 0 } }) } }));
    await ops.send(tokenOp(prisoner, { kind: "npc", name: "Prisoner", x: 10, y: 1, disposition: "neutral", actor: { inline: actor() } }));
    await ops.send({ t: "actor.effect.add", target: { tokenId: prisoner }, effect: { id: randomUUID(), key: "grappled" } });
    await ops.send({ t: "token.attach", tokenId: lantern, to: hobgoblin, kind: "carry", x: 9, y: 1.5, elevation: 0 });
    await ops.send({ t: "token.attach", tokenId: prisoner, to: hobgoblin, kind: "drag", x: 10, y: 1, elevation: 0 });
    await waitFor("the hobgoblin's load", () => (token(dmSocket, lantern)?.attached?.to === hobgoblin && token(dmSocket, prisoner)?.attached?.to === hobgoblin) || null);
    for (const [viewport, scale] of [
      [PHONE, 1],
      [{ width: 360, height: 740 }, 1],
      [PHONE, 1.3],
    ] as const) {
      const { context, page } = await dmPhone(viewport, scale);
      try {
        // The hobgoblin's top-right quarter, clear of the lantern in its bottom-left one.
        const b = await select(page, "Hobgoblin", { x: 9.25, y: 0.75 });
        // An upright phone's strip shows the holder's line once expanded (docs/design-v1-bar-compact.md 5).
        await expandBar(b);
        const line = b.getByRole("group", { name: "Attached tokens" });
        await line.scrollIntoViewIfNeeded();
        const where = `at ${viewport.width} px and ${Math.round(scale * 100)}%`;
        await shots.take(page, `attach-pl2-a-holder-line-${viewport.width}-${Math.round(scale * 100)}`);
        const rows = await line.evaluate((node) => {
          const el = node as unknown as Elem;
          const box = (e: Elem) => {
            const r = e.getBoundingClientRect();
            return { left: r.left, top: r.top, bottom: r.bottom, middle: (r.top + r.bottom) / 2 };
          };
          return (["carrying", "dragging"] as const).map((kind) => {
            const word = el.querySelector(`[data-hold-word="${kind}"]`);
            const names = el.querySelector(`[data-hold-names="${kind}"]`);
            return {
              kind,
              word: word ? { ...box(word), text: word.textContent } : null,
              names: names ? box(names) : null,
              items: names ? Array.from(names.children).map((c) => ({ ...box(c), text: c.textContent })) : [],
            };
          });
        });
        const [carrying, dragging] = rows;
        for (const row of rows) {
          assert.ok(row.word && row.names && row.items.length > 0, `${where}: the ${row.kind} row is missing`);
          // The word starts its row, and its first name stands on the word's line.
          assert.ok(Math.abs(row.word.middle - row.items[0]!.middle) <= 1, `${where}: "${row.word.text}" stands ${(row.word.middle - row.items[0]!.middle).toFixed(1)} px off its first name's middle`);
          assert.ok(row.items[0]!.left > row.word.left, `${where}: "${row.items[0]!.text}" is not beside "${row.word.text}"`);
        }
        assert.ok(Math.abs(carrying!.word!.left - dragging!.word!.left) <= 1, `${where}: the words start at ${carrying!.word!.left} and ${dragging!.word!.left}`);
        assert.ok(Math.abs(carrying!.names!.left - dragging!.names!.left) <= 1, `${where}: the names start at ${carrying!.names!.left} and ${dragging!.names!.left}`);
        assert.deepEqual(carrying!.items.map((i) => i.text), ["Lantern", "Put down"], `${where}: the carrying row`);
        assert.deepEqual(dragging!.items.map((i) => i.text), ["Prisoner", "Let go"], `${where}: the dragging row`);
        const carriedFoot = Math.max(...carrying!.items.map((i) => i.bottom));
        assert.ok(dragging!.word!.top >= carriedFoot - 0.5, `${where}: "Dragging" starts at ${dragging!.word!.top}, inside the carrying row (foot ${carriedFoot})`);
      } finally {
        await context.close();
      }
    }
  });

  test("pl2-c. the hobgoblin's window on the DM's phone at 320 px and 390 px at 130%, and at 360 px: every row of its buttons fills each line it wraps onto, so Attach or Delete never stands alone (docs/design-v1-polish.md R6)", async () => {
    for (const [viewport, scale] of [
      [{ width: 320, height: 568 }, 1.3],
      [PHONE, 1.3],
      [{ width: 360, height: 740 }, 1],
    ] as const) {
      const { context, page } = await dmPhone(viewport, scale);
      try {
        const b = await select(page, "Hobgoblin", { x: 9.25, y: 0.75 });
        const where = `at ${viewport.width} px and ${Math.round(scale * 100)}%`;
        // An upright phone's strip shows its rows of buttons once expanded (docs/design-v1-bar-compact.md 5).
        await expandBar(b);
        await b.locator('[data-bar-row="less"]').scrollIntoViewIfNeeded();
        await shots.take(page, `attach-pl2-c-rows-${viewport.width}-${Math.round(scale * 100)}`);
        const rows = await b.locator("[data-bar-row]").evaluateAll((nodes) =>
          nodes.map((node) => {
            const el = node as unknown as Elem;
            const row = el.getBoundingClientRect();
            // Its buttons by line.
            const lines = new Map<number, { left: number; right: number; text: string }[]>();
            for (const child of Array.from(el.children)) {
              const r = child.getBoundingClientRect();
              if (r.width === 0) continue;
              const key = Math.round(r.top);
              lines.set(key, [...(lines.get(key) ?? []), { left: r.left, right: r.right, text: child.textContent || child.getAttribute("aria-label") || "" }]);
            }
            return { row: el.getAttribute("data-bar-row"), left: row.left, right: row.right, lines: [...lines.values()] };
          }),
        );
        assert.ok(rows.some((r) => r.row === "play" && r.lines.length > 0), `${where}: no play row`);
        let wrapped = false;
        for (const r of rows) {
          if (r.lines.length > 1) wrapped = true;
          for (const line of r.lines) {
            const items = [...line].sort((a, z) => a.left - z.left);
            const names = items.map((i) => i.text).join(", ");
            assert.ok(Math.abs(items[0]!.left - r.left) <= 1, `${where}: the ${r.row} row's line "${names}" starts ${(items[0]!.left - r.left).toFixed(1)} px in`);
            assert.ok(Math.abs(items[items.length - 1]!.right - r.right) <= 1, `${where}: the ${r.row} row's line "${names}" stops ${(r.right - items[items.length - 1]!.right).toFixed(1)} px short of the row's end`);
          }
        }
        if (viewport.width === 320) assert.ok(wrapped, `${where}: no row wrapped, so the check saw no line but the first`);
      } finally {
        await context.close();
      }
    }
  });

  test("pl2-d. an ogre carrying a chest with a long name and dragging a creature named in one long word, on the DM's phone at 320 px at 130% and at 360 px: each name and action keeps inside its cell, its words wrapping there, and each word stands on its first name's first line (PL2-ASTRA-03)", async () => {
    const ogre = randomUUID();
    const chest = randomUUID();
    const captive = randomUUID();
    await ops.send(tokenOp(ogre, { kind: "monster", name: "Ogre", size: "large", x: 12, y: 0, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tokenOp(chest, { kind: "object", name: "Chest of the Drowned Archduke", size: "tiny", x: 12, y: 1.5, actor: { inline: actor({ hp: { cur: 5, max: 5, temp: 0 } }) } }));
    await ops.send(tokenOp(captive, { kind: "npc", name: "Bogglethwaitesonofgrimblethorn", x: 14, y: 0, disposition: "neutral", actor: { inline: actor() } }));
    await ops.send({ t: "actor.effect.add", target: { tokenId: captive }, effect: { id: randomUUID(), key: "grappled" } });
    await ops.send({ t: "token.attach", tokenId: chest, to: ogre, kind: "carry", x: 12, y: 1.5, elevation: 0 });
    await ops.send({ t: "token.attach", tokenId: captive, to: ogre, kind: "drag", x: 14, y: 0, elevation: 0 });
    await waitFor("the ogre's load", () => (token(dmSocket, chest)?.attached?.to === ogre && token(dmSocket, captive)?.attached?.to === ogre) || null);
    for (const [viewport, scale] of [
      [{ width: 320, height: 568 }, 1.3],
      [{ width: 360, height: 740 }, 1],
    ] as const) {
      const { context, page } = await dmPhone(viewport, scale);
      try {
        // The ogre's top-right square, clear of the chest in its bottom-left corner.
        const b = await select(page, "Ogre", { x: 13, y: 0 });
        // An upright phone's strip shows the holder's line once expanded (docs/design-v1-bar-compact.md 5).
        await expandBar(b);
        const line = b.getByRole("group", { name: "Attached tokens" });
        await line.scrollIntoViewIfNeeded();
        const where = `at ${viewport.width} px and ${Math.round(scale * 100)}%`;
        await shots.take(page, `attach-pl2-d-long-names-${viewport.width}-${Math.round(scale * 100)}`);
        const rows = await line.evaluate((node) => {
          type Rect = { left: number; top: number; right: number; bottom: number };
          type Range = { selectNodeContents(n: unknown): void; getClientRects(): ArrayLike<Rect> };
          const doc = (globalThis as unknown as { document: { createRange(): Range } }).document;
          const el = node as unknown as Elem;
          return (["carrying", "dragging"] as const).map((kind) => {
            const word = el.querySelector(`[data-hold-word="${kind}"]`)!;
            const cell = el.querySelector(`[data-hold-names="${kind}"]`)!;
            const items = Array.from(cell.children).map((c) => {
              const r = c.getBoundingClientRect();
              return { text: c.textContent, left: r.left, right: r.right };
            });
            // The first name's first line of words.
            const range = doc.createRange();
            range.selectNodeContents(cell.children[0]);
            const first = range.getClientRects()[0]!;
            const w = word.getBoundingClientRect();
            const c = cell.getBoundingClientRect();
            return { kind, cell: { left: c.left, right: c.right }, items, wordMiddle: (w.top + w.bottom) / 2, firstLineMiddle: (first.top + first.bottom) / 2, lines: range.getClientRects().length };
          });
        });
        for (const row of rows) {
          for (const item of row.items) {
            assert.ok(item.left >= row.cell.left - 0.5 && item.right <= row.cell.right + 0.5, `${where}: "${item.text}" (${item.left.toFixed(1)} to ${item.right.toFixed(1)}) runs out of its cell (${row.cell.left.toFixed(1)} to ${row.cell.right.toFixed(1)})`);
          }
          assert.ok(Math.abs(row.wordMiddle - row.firstLineMiddle) <= 1, `${where}: the ${row.kind} word stands ${(row.wordMiddle - row.firstLineMiddle).toFixed(1)} px off its first name's first line`);
        }
        // At 320 px at 130% the names wrap. At 360 px they fit, and the check is that they still sit as before.
        if (viewport.width === 320) assert.ok(rows.some((r) => r.lines > 1), `${where}: no name wrapped, so this tests nothing`);
      } finally {
        await context.close();
      }
    }
  });
});
