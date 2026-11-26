import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, Token } from "../shared/model.ts";
import { ConsoleWatch, dragWorld, OpSocket, openSideTab, pagePoint, Shots, sideTabName, sleep, SocketWatch, startServer, Touches, waitFor, type Server } from "./harness.ts";

/**
 * How many tokens one drag moves, end to end, on the real server serving
 * the production build: a drag of 100 tokens moves them all and shows
 * every one to the other screens, by mouse, by touch and by a press on a
 * rider. A drag of 101 says "Drag at most 100 tokens at once." on the
 * dragging device and sends nothing at all, frame or op, through the drop,
 * Escape and a scene change. The arrow keys move 150 tokens by ops alone.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus thirty-five, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 35;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-dragcap-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESKTOP = { width: 1280, height: 800 };
const BOUNDS = { w: 47, h: 26 };
const CAP_TEXT = "Drag at most 100 tokens at once.";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let touchContext: BrowserContext;
let samContext: BrowserContext;
let dm: Page;
let tablet: Page;
let sam: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const tabletSocket = new SocketWatch("tablet");
const samSocket = new SocketWatch("sam");
const consoles = { dm: new ConsoleWatch("dm"), tablet: new ConsoleWatch("tablet"), sam: new ConsoleWatch("sam") };

/**
 * Three blocks on one scene: A, 10 by 10 at x 2 to 11 with one more under
 * it at (2, 12); C, 99 at x 16 to 25 beside a warhorse at (28, 4) with
 * Thorn riding it; D, 15 by 10 at x 31 to 45. Rows 13 to 25 stay clear for
 * the drags.
 */
const run = {
  roomId: "",
  roomName: `E2E dragcap ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  otherScene: uuidv7(),
  a: [] as { id: string; x: number; y: number }[],
  extra: { id: uuidv7(), x: 2, y: 12 },
  c: [] as { id: string; x: number; y: number }[],
  horse: { id: uuidv7(), x: 28, y: 4 },
  thorn: { id: uuidv7(), x: 28, y: 4 },
  d: [] as { id: string; x: number; y: number }[],
};
for (let y = 2; y < 12; y++) for (let x = 2; x < 12; x++) run.a.push({ id: uuidv7(), x, y });
for (let y = 2; y < 12; y++) for (let x = 16; x < 26; x++) if (run.c.length < 99) run.c.push({ id: uuidv7(), x, y });
for (let y = 2; y < 12; y++) for (let x = 31; x < 46; x++) run.d.push({ id: uuidv7(), x, y });

function actor() {
  return { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function tokenOp(id: string, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", disposition: "hostile", actor: { inline: actor() }, ...extra } };
}

function tokenOf(socket: SocketWatch, id: string): Token | undefined {
  return (socket.state as RoomState | null)?.tokens[id];
}

type Frame = { t?: string; e?: { k?: string; tokenId?: string; g?: number; with?: { tokenId: string }[] }; op?: { t?: string; moves?: unknown[] } };

function framesSince(socket: SocketWatch, mark: number): Frame[] {
  return socket.sent.slice(mark).map((text) => JSON.parse(text) as Frame);
}

const isDrag = (f: Frame) => f.t === "eph" && /^drag|^groupEnd$/.test(f.e?.k ?? "");
const isMove = (f: Frame) => f.t === "op" && /^token\.move/.test(f.op?.t ?? "");

/** Every token a page's drag frames name: each token's own, or a group frame's pressed token and roster. */
function namedByDrags(frames: Frame[]): Set<string> {
  const ids = new Set<string>();
  for (const f of frames.filter(isDrag)) {
    if (f.e?.tokenId) ids.add(f.e.tokenId);
    for (const m of f.e?.with ?? []) ids.add(m.tokenId);
  }
  return ids;
}

/** A Shift box over empty map from one world point to another, which adds the tokens under it to the selection. */
async function boxSelect(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.keyboard.down("Shift");
  try {
    await dragWorld(page, BOUNDS, from, to);
  } finally {
    await page.keyboard.up("Shift");
  }
}

async function shiftClick(page: Page, cell: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: cell.x + 0.5, y: cell.y + 0.5 });
  await page.keyboard.down("Shift");
  try {
    await page.mouse.click(p.x, p.y);
  } finally {
    await page.keyboard.up("Shift");
  }
}

/** The note as the page's toast shows it. */
function note(page: Page) {
  return page.locator("[data-toast]").filter({ hasText: CAP_TEXT }).filter({ visible: true });
}

async function selected(page: Page, n: number): Promise<void> {
  await page.getByRole("dialog", { name: `${n} selected tokens`, exact: true }).waitFor({ timeout: 10_000 });
}

async function deselect(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.locator('[role="dialog"][data-bar-mode]').count()) > 0; i++) await page.keyboard.press("Escape");
  await waitFor("nothing selected", async () => ((await page.locator('[role="dialog"][data-bar-mode]').count()) === 0 ? true : null), 5_000);
}

/** Where each token stands in a socket's copy. */
function spots(socket: SocketWatch, ids: readonly string[]): string {
  return ids.map((id) => `${tokenOf(socket, id)?.x},${tokenOf(socket, id)?.y}`).join(" ");
}

/** A drag already refused, its note seen: in the next moments nothing goes out and nothing moves. */
async function sentNothing(socket: SocketWatch, mark: number, ids: readonly string[], before: string): Promise<void> {
  await sleep(1_500);
  const frames = framesSince(socket, mark);
  assert.deepEqual(frames.filter(isDrag), [], "a refused drag sent a drag frame");
  assert.deepEqual(frames.filter(isMove), [], "a refused drag sent a move");
  assert.equal(spots(dmSocket, ids), before, "a refused drag moved a token");
}

/** A drag of `ids` sent every one of them to Sam's screen, each preview ending there, and moved each by `by`. */
async function dragShown(socket: SocketWatch, mark: number, samMark: number, ids: readonly string[], starts: Map<string, { x: number; y: number }>, by: { x: number; y: number }): Promise<void> {
  await waitFor(`all ${ids.length} moved`, () => ids.every((id) => tokenOf(dmSocket, id)?.x === starts.get(id)!.x + by.x && tokenOf(dmSocket, id)?.y === starts.get(id)!.y + by.y) || null, 30_000);
  // Each token is named by the drag's frames, its end among them, which can go after the moves land.
  let unnamed: string[] = [];
  await waitFor(
    "every token named by the drag's frames",
    () => {
      const named = namedByDrags(framesSince(socket, mark));
      unnamed = ids.filter((id) => !named.has(id));
      return unnamed.length === 0 || null;
    },
    30_000,
  ).catch((err: unknown) => {
    throw new Error(`${(err as Error).message}: ${unnamed.length} unnamed`);
  });
  await waitFor(
    `every preview's end on Sam's screen`,
    () => {
      const ended = new Set<string>();
      for (const text of samSocket.received.slice(samMark)) {
        const f = JSON.parse(text) as Frame;
        if (f.t === "eph" && (f.e?.k === "dragEnd" || f.e?.k === "dragCancel") && f.e.tokenId) ended.add(f.e.tokenId);
      }
      return ids.every((id) => ended.has(id)) || null;
    },
    30_000,
  );
}

describe("raccoon-vtt drag cap", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    samContext = await browser.newContext({ viewport: DESKTOP });
    dm = await dmContext.newPage();
    sam = await samContext.newPage();
    consoles.dm.attach(dm);
    consoles.sam.attach(sam);
    await dmSocket.attach(dmContext, dm);
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

  test("cad-0. the DM's room with 352 tokens in three blocks, Thorn riding a warhorse, Sam watching on a desktop, and the DM's tablet", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.otherScene, name: "Elsewhere", bounds: { w: 12, h: 8 }, fogEnabled: false } });
    const all = [...run.a, run.extra, ...run.c, ...run.d];
    for (let i = 0; i < all.length; i += 25) await Promise.all(all.slice(i, i + 25).map((t, j) => ops.send(tokenOp(t.id, { name: `Goblin ${i + j + 1}`, x: t.x, y: t.y }))));
    await ops.send(tokenOp(run.horse.id, { name: "Warhorse", size: "large", x: run.horse.x, y: run.horse.y, kind: "npc", disposition: "ally" }));
    await ops.send(tokenOp(run.thorn.id, { name: "Thorn", x: run.thorn.x, y: run.thorn.y, kind: "npc", disposition: "ally" }));
    await ops.send({ t: "token.attach", tokenId: run.thorn.id, to: run.horse.id, kind: "ride", steer: true, x: run.thorn.x, y: run.thorn.y, elevation: 0 });
    await waitFor("every token in the DM's copy", () => (all.every((t) => tokenOf(dmSocket, t.id)) && tokenOf(dmSocket, run.thorn.id)?.attached?.to === run.horse.id) || null, 60_000);

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await samContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await samContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Sam", color: "#e5484d" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    await sam.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Sam's copy of every token", () => all.every((t) => tokenOf(samSocket, t.id)) || null, 30_000);

    // The DM's tablet: the same DM, a touch screen.
    touchContext = await browser.newContext({ viewport: DESKTOP, hasTouch: true });
    await touchContext.addCookies(await dmContext.cookies(server.origin));
    tablet = await touchContext.newPage();
    consoles.tablet.attach(tablet);
    await tabletSocket.attach(touchContext, tablet);
    await tablet.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("the tablet's snapshot", () => tokenOf(tabletSocket, run.thorn.id));
    for (const page of [dm, sam, tablet]) await page.locator(".konvajs-content").first().waitFor();
  });

  test("cad-1. a mouse drag of 101 selected tokens says why and sends nothing through the drop, Escape and a scene change, and the selection stays; 100 move and show on Sam's screen", async () => {
    const ids = [...run.a.map((t) => t.id), run.extra.id];
    const before = spots(dmSocket, ids);
    await boxSelect(dm, { x: 1.2, y: 1.2 }, { x: 12.8, y: 12.8 });
    await selected(dm, 101);
    // Pressed, refused at once, then let go.
    let mark = dmSocket.sent.length;
    await dragWorld(dm, BOUNDS, { x: 5.5, y: 5.5 }, { x: 5.5, y: 18.5 });
    await note(dm).first().waitFor({ timeout: 5_000 });
    await sentNothing(dmSocket, mark, ids, before);
    await selected(dm, 101);
    await shots.take(dm, "cad-1-refused");
    // Held after the note, Escape, more moves, then let go, then the scene changes and comes back.
    mark = dmSocket.sent.length;
    const from = await pagePoint(dm, BOUNDS, { x: 6.5, y: 6.5 });
    const to = await pagePoint(dm, BOUNDS, { x: 6.5, y: 20.5 });
    await dm.mouse.move(from.x, from.y);
    await dm.mouse.down();
    await dm.mouse.move(from.x, from.y + (to.y - from.y) * 0.3, { steps: 6 });
    await note(dm).first().waitFor();
    await dm.keyboard.press("Escape");
    await dm.mouse.move(to.x, to.y, { steps: 8 });
    await dm.mouse.up();
    await openSideTab(dm, "Scenes");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
    await panel.getByRole("button", { name: /^Elsewhere/ }).first().click();
    await waitFor("the DM on Elsewhere", () => dmSocket.you?.sceneId === run.otherScene || null, 20_000);
    const name = dmSocket.state?.scenes[run.sceneId]?.name ?? "";
    await panel.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
    await waitFor("the DM back on the scene", () => dmSocket.you?.sceneId === run.sceneId || null, 20_000);
    await dm.keyboard.press("Escape");
    await sentNothing(dmSocket, mark, ids, before);
    await deselect(dm);

    // 100: the block without the one under it, once the note from before is gone.
    await waitFor("the note gone", async () => ((await note(dm).count()) === 0 ? true : null), 20_000);
    await boxSelect(dm, { x: 1.2, y: 1.2 }, { x: 12.8, y: 11.8 });
    await selected(dm, 100);
    mark = dmSocket.sent.length;
    const samMark = samSocket.received.length;
    const starts = new Map(run.a.map((t) => [t.id, { x: t.x, y: t.y }]));
    await dragWorld(dm, BOUNDS, { x: 5.5, y: 5.5 }, { x: 5.5, y: 18.5 });
    await dragShown(dmSocket, mark, samMark, run.a.map((t) => t.id), starts, { x: 0, y: 13 });
    assert.equal(await note(dm).count(), 0, "the note shows for a drag of 100");
    await shots.take(sam, "cad-1-sam-saw-100");
    await deselect(dm);
  });

  test("cad-2. on the DM's tablet a finger's drag of 101 says why and sends nothing, and of 100 moves them all, shown on Sam's screen", async () => {
    await deselect(tablet);
    // Block A now stands at rows 15 to 24, the one it left behind at (2, 12).
    const moved = run.a.map((t) => ({ ...t, y: t.y + 13 }));
    const ids = [...moved.map((t) => t.id), run.extra.id];
    await waitFor("the tablet's copy of the moved block", () => moved.every((t) => tokenOf(tabletSocket, t.id)?.y === t.y) || null);
    const before = spots(dmSocket, ids);
    await boxSelect(tablet, { x: 1.2, y: 14.2 }, { x: 12.8, y: 24.8 });
    await shiftClick(tablet, run.extra);
    await selected(tablet, 101);
    const touches = new Touches(await touchContext.newCDPSession(tablet));
    const finger = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const a = await pagePoint(tablet, BOUNDS, from);
      const b = await pagePoint(tablet, BOUNDS, to);
      await touches.start([{ x: a.x, y: a.y }]);
      for (let i = 1; i <= 12; i++) await touches.move([{ x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 }]);
      await touches.end();
    };
    let mark = tabletSocket.sent.length;
    await finger({ x: 5.5, y: 18.5 }, { x: 5.5, y: 6.5 });
    await note(tablet).first().waitFor({ timeout: 5_000 });
    await sentNothing(tabletSocket, mark, ids, before);
    await selected(tablet, 101);
    await shiftClick(tablet, run.extra);
    await selected(tablet, 100);
    mark = tabletSocket.sent.length;
    const samMark = samSocket.received.length;
    await finger({ x: 5.5, y: 18.5 }, { x: 5.5, y: 5.5 });
    await dragShown(tabletSocket, mark, samMark, moved.map((t) => t.id), new Map(moved.map((t) => [t.id, { x: t.x, y: t.y }])), { x: 0, y: -13 });
    await deselect(tablet);
  });

  test("cad-3. a press on Thorn, riding the warhorse, with 99 others and the horse selected, says why and sends nothing; with 98 it moves all 100", async () => {
    await deselect(dm);
    const ids = [...run.c.map((t) => t.id), run.horse.id, run.thorn.id];
    const before = spots(dmSocket, ids);
    await boxSelect(dm, { x: 15.2, y: 1.2 }, { x: 30.6, y: 12.8 });
    await selected(dm, 101);
    let mark = dmSocket.sent.length;
    await dragWorld(dm, BOUNDS, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: run.thorn.x + 0.5, y: run.thorn.y + 12.5 });
    await note(dm).first().waitFor({ timeout: 5_000 });
    await sentNothing(dmSocket, mark, ids, before);
    // One goblin out: 98, the horse and Thorn.
    const out = run.c.at(-1)!;
    await shiftClick(dm, out);
    await selected(dm, 100);
    mark = dmSocket.sent.length;
    const samMark = samSocket.received.length;
    const moving = ids.filter((id) => id !== out.id);
    const starts = new Map(moving.map((id) => [id, { x: tokenOf(dmSocket, id)!.x, y: tokenOf(dmSocket, id)!.y }]));
    await dragWorld(dm, BOUNDS, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: run.thorn.x + 0.5, y: run.thorn.y + 12.5 });
    await dragShown(dmSocket, mark, samMark, moving, starts, { x: 0, y: 12 });
    assert.equal(tokenOf(dmSocket, run.thorn.id)?.attached?.to, run.horse.id, "Thorn still rides the horse");
    await deselect(dm);
  });

  test("cad-4. the arrow key moves 150 selected tokens by ops alone, with no drag frame", async () => {
    await deselect(dm);
    await boxSelect(dm, { x: 30.2, y: 1.2 }, { x: 46.2, y: 12.8 });
    await selected(dm, 150);
    const mark = dmSocket.sent.length;
    await dm.keyboard.press("ArrowDown");
    await waitFor("all 150 a row down", () => run.d.every((t) => tokenOf(dmSocket, t.id)?.y === t.y + 1) || null, 30_000);
    const frames = framesSince(dmSocket, mark);
    assert.deepEqual(frames.filter(isDrag), [], "an arrow key sent a drag frame");
    const moves = frames.filter(isMove).reduce((n, f) => n + (f.op?.moves?.length ?? 1), 0);
    assert.equal(moves, 150);
    await deselect(dm);
  });

  test("cad-5. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
