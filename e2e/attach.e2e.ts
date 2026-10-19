import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { RoomState, Token } from "../shared/model.ts";
import { ConsoleWatch, dragCells, OpSocket, pagePoint, Shots, SocketWatch, startServer, tapCell, touchSwipe, waitFor, type Server } from "./harness.ts";

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

  test("at-1. on Thorn's turn Pat opens Attach on Thorn's bar, picks Ride Warhorse, Controlled, and pays half Thorn's Speed", async () => {
    const thorn = await select(pat, "Thorn", { x: 3, y: 5 });
    await thorn.getByRole("button", { name: "Attach", exact: true }).tap();
    const sheet = pat.getByRole("dialog", { name: "Attach Thorn" });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Ride Warhorse" }).tap();
    await sheet.getByRole("radio", { name: "Controlled: moves on Thorn's turn" }).waitFor();
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
    await thorn.getByRole("button", { name: "Get off", exact: true }).tap();
    const off = await waitFor("Thorn off the warhorse", () => (token(patSocket, run.thorn)?.attached === undefined ? token(patSocket, run.thorn) : null));
    const horse = token(patSocket, run.horse)!;
    const inside = off.x >= horse.x && off.x < horse.x + 2 && off.y >= horse.y && off.y < horse.y + 2;
    assert.ok(!inside, "Thorn stands clear of the horse");
    const costs = off.path!.stops.map((s) => s.cost ?? 0);
    assert.ok(costs.includes(15), `getting off costs half Thorn's Speed: ${JSON.stringify(costs)}`);
    assert.equal(patSocket.state!.encounter!.turnStart?.mounts, undefined);
    await shots.take(pat, "attach-got-off");
  });

  test("at-4. the DM perches the hidden imp on the cult fanatic from the Attach popover and moves the fanatic: the imp follows, and no frame to Pat or Sam names it", async () => {
    await select(dm, "Imp", { x: 14, y: 3 }, true);
    await bar(dm, "Imp").getByRole("button", { name: "Attach", exact: true }).click();
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
    await bar(sam, "Bree").getByRole("button", { name: "Attach", exact: true }).click();
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
});
