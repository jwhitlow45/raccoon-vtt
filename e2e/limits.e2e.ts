import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { idTime, uuidv7 } from "../shared/ids.ts";
import { BLOCKS_ROOM_TOO_FULL, KEPT_FOR_PLAYERS_FULL, LEAVE_PLAYERS_ASK, overNotice, ROOM_FULL, SCENE_FULL, SEAT_FULL, sizeRemedy } from "../shared/limits.ts";
import type { RoomState } from "../shared/model.ts";
import { actor } from "../shared/testutil.ts";
import { ConsoleWatch, dragCells, OpSocket, openSideTab, pickTool, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { undoSetup } from "./helpers/undoScope.ts";

/**
 * Player limits on a device (docs/design/design-v1-player-limits.md 3.4, 5.1
 * and 15), on the real server serving the production build. Ana plays
 * Bree. Her page's socket runs through a route here, which can tell it the
 * server's clock 40 minutes slow, keep it offline, hold back an answer or
 * swap an id on the way, so the page meets what a phone left open for 40
 * minutes, or one whose answer was lost, meets. A new thing's id is made
 * by the room's clock as its save goes, never as its editor opens: a stat
 * block, strokes drawn offline, a create whose answer was lost and one whose
 * refusal was lost each end as one thing, never two. The DM is told when
 * the room is over its size limit, and the DM's delete of the players' map
 * asks first, leaves them with no map on a yes, and Undo puts them back.
 * The notice, the longest limit's toast at 320 px and 130%, and the
 * delete's question at three sizes and both interface sizes are measured.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-two, one file after
 * another as the others. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 62;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-limits-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 568 };
const BOUNDS = { w: 20, h: 14 };
const MINUTE = 60_000;
/** How far behind the server's clock Ana's page is told it is, standing in for a page left open that long. */
const AWAY = 40 * MINUTE;
const MiB = 1024 * 1024;

type Json = Record<string, unknown> & { t?: string };

/**
 * A page's room socket through a route: what it sent and got, and the ways
 * a step bends it. `skew` sets the server's time in `clock` and `time`
 * frames back by that much. `offline` closes every new socket at once.
 * `toServer` and `toPage` may swap a frame or drop it (null).
 */
type Wire = {
  skew: number;
  offline: boolean;
  sent: Json[];
  got: Json[];
  toServer: ((frame: Json) => Json | null) | null;
  toPage: ((frame: Json) => Json | null) | null;
  open: { page: WebSocketRoute; server: WebSocketRoute } | null;
};

async function wire(page: Page): Promise<Wire> {
  const w: Wire = { skew: 0, offline: false, sent: [], got: [], toServer: null, toPage: null, open: null };
  await page.routeWebSocket(/\/ws\?room=/, (socket) => {
    if (w.offline) {
      void socket.close();
      return;
    }
    const server = socket.connectToServer();
    w.open = { page: socket, server };
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Json;
      const out = w.toServer ? w.toServer(frame) : frame;
      if (out === null) return;
      w.sent.push(out);
      server.send(JSON.stringify(out));
    });
    server.onMessage((message) => {
      let frame = JSON.parse(String(message)) as Json;
      if (w.skew !== 0 && frame.t === "clock") frame = { ...frame, at: new Date(Date.parse(String(frame.at)) - w.skew).toISOString() };
      if (w.skew !== 0 && frame.t === "time") frame = { ...frame, at: Number(frame.at) - w.skew };
      const out = w.toPage ? w.toPage(frame) : frame;
      if (out === null) return;
      w.got.push(out);
      socket.send(JSON.stringify(out));
    });
  });
  return w;
}

/** Closes the page's socket as a server restart does, so it comes back at once with a new snapshot, and waits for that snapshot. */
async function reconnect(w: Wire): Promise<void> {
  const before = snapshotsOf(w);
  const open = w.open;
  assert.ok(open, "a socket to close");
  await open.page.close({ code: 1012, reason: "restarting" });
  await open.server.close();
  await waitFor("the snapshot after the reconnect", () => (snapshotsOf(w) > before ? true : null), 30_000);
}

function snapshotsOf(w: Wire): number {
  return w.got.filter((f) => f.t === "snapshot").length;
}

/** The ops a page sent since `from`, by index into `sent`. */
function opsSent(w: Wire, from = 0): { n: number; op: Json }[] {
  return w.sent.slice(from).flatMap((f) => (f.t === "op" ? [{ n: f.n as number, op: f.op as Json }] : []));
}

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let anaContext: BrowserContext;
let ana: Page;
let ana_: Wire;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana") };

const run = {
  roomId: "",
  roomName: `E2E limits ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  sceneName: "",
  cryptId: "",
  anaId: "",
  bree: { characterId: "", tokenId: "" },
};

/** A stat block as a web page's copy gives it. */
const MOTH = ["Moth Spirit", "Small Fey, Unaligned", "AC 12", "HP 9 (2d6 + 2)", "Speed 10 ft., Fly 40 ft. (hover)", "STR 6 (−2) DEX 15 (+2) CON 12 (+1) INT 4 (−3) WIS 13 (+1) CHA 8 (−1)", "CR 1/4 (XP 50; PB +2)"].join("\n");

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

/** Ana's page, opened afresh, as a reload brings it: a new page store, which takes its reckoning of the server's clock from the next `clock` frame. */
async function openAna(): Promise<void> {
  const before = snapshotsOf(ana_);
  await ana.goto(`${server.origin}/r/${run.roomId}`);
  await waitFor("Ana's snapshot", () => (snapshotsOf(ana_) > before ? true : null), 30_000);
  await ana.locator(".konvajs-content").first().waitFor();
}

function drawingsOf(state: RoomState | null, ownerId: string): string[] {
  return Object.values(state?.drawings ?? {}).flatMap((d) => (d && d.ownerId === ownerId ? [d.id] : []));
}

/** Within a minute of now: an id made as it was sent, not one made 40 minutes before. */
function madeNow(id: string): boolean {
  const t = idTime(id);
  return t !== null && Math.abs(t - Date.now()) < MINUTE;
}

function toasts(page: Page): Locator {
  return page.locator("[data-toast]");
}

describe("raccoon-vtt player limits on a device", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    dm = await dmContext.newPage();
    anaContext = await browser.newContext({ viewport: DESKTOP });
    ana = await anaContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    await dmSocket.attach(dmContext, dm);
    ana_ = await wire(ana);
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

  test("lim-1. a DM's room with a second scene, and Ana playing Bree on the players' scene", async () => {
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
    run.sceneName = dmSocket.state!.scenes[run.sceneId]!.name;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.anaId = await join(anaContext, "Ana", "#30a46c");
    // Made now, as a device makes them: the room takes a new id only near its own clock, and none from before its first start.
    run.cryptId = uuidv7();
    run.bree = { characterId: uuidv7(), tokenId: uuidv7() };
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.cryptId, name: "The crypt", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [run.anaId], actor: actor({ ac: 15, hp: { cur: 24, max: 24, temp: 0 } }) } });
    await ops.send({ t: "token.create", token: { id: run.bree.tokenId, sceneId: run.sceneId, kind: "pc", name: "Bree", size: "medium", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree.characterId } } });
    await openAna();
  });

  test("lim-2. a stat block whose editor opened 40 minutes before its save goes under an id made as it was saved, as one block", async () => {
    // The page reckons the server's clock 40 minutes slow while the editor opens, and right as it does when the save goes.
    ana_.skew = AWAY;
    await openAna();
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Stat blocks \(0\)$/ }).click();
    await ana.getByRole("button", { name: "Paste a stat block" }).click();
    const editor = ana.getByRole("dialog", { name: "New stat block for Bree" });
    await editor.getByRole("textbox").first().fill(MOTH);
    await editor.getByRole("button", { name: "Read the stat block" }).click();
    ana_.skew = 0;
    await reconnect(ana_);
    const from = ana_.sent.length;
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    const block = await waitFor("the block in the DM's view", () => Object.values(dmSocket.state?.companionBlocks ?? {}).find((b) => b?.name === "Moth Spirit"));
    assert.ok(madeNow(block.id), "its id was made as the save went");
    const creates = opsSent(ana_, from).filter((s) => s.op.t === "companionBlock.create");
    assert.equal(creates.length, 1, "one create, never refused and sent again");
    assert.equal(Object.values(dmSocket.state?.companionBlocks ?? {}).length, 1, "one block");
    await ana.getByRole("button", { name: "Back to Bree" }).click();
  });

  test("lim-3. strokes drawn through 40 minutes offline go under fresh ids as the page comes back, each once", async () => {
    ana_.skew = AWAY;
    await openAna();
    await pickTool(ana, "Draw");
    ana_.offline = true;
    consoles.ana.expectSocketFailures = true;
    await ana_.open!.page.close({ code: 1012, reason: "restarting" });
    await ana_.open!.server.close();
    const before = drawingsOf(dmSocket.state, run.anaId);
    const from = ana_.sent.length;
    await dragCells(ana, BOUNDS, { x: 2, y: 2 }, { x: 6, y: 3 });
    await dragCells(ana, BOUNDS, { x: 2, y: 8 }, { x: 6, y: 9 });
    assert.deepEqual(opsSent(ana_, from), [], "nothing goes offline");
    ana_.skew = 0;
    ana_.offline = false;
    const fresh = await waitFor("both strokes in the DM's view", () => {
      const now = drawingsOf(dmSocket.state, run.anaId).filter((id) => !before.includes(id));
      return now.length === 2 ? now : null;
    }, 30_000);
    consoles.ana.expectSocketFailures = false;
    for (const id of fresh) assert.ok(madeNow(id), "each stroke's id was made as the page came back");
    const creates = opsSent(ana_, from).filter((s) => s.op.t === "drawing.create");
    assert.equal(creates.length, 2, "two creates, none refused and sent again");
    assert.equal(await toasts(ana).filter({ hasText: /^Not saved/ }).count(), 0, "no refusal");
    await shots.take(ana, "lim-3-offline-strokes");
  });

  test("lim-4. a stroke that landed as the socket dropped, its answer lost, is never sent twice", async () => {
    const before = drawingsOf(dmSocket.state, run.anaId);
    const from = ana_.sent.length;
    let dropped = false;
    ana_.toPage = (frame) => {
      if (dropped || frame.t !== "ev" || !Array.isArray(frame.acks) || frame.acks.length === 0) return frame;
      dropped = true;
      return null;
    };
    await dragCells(ana, BOUNDS, { x: 10, y: 2 }, { x: 14, y: 3 });
    await waitFor("its answer held back", () => (dropped ? true : null));
    ana_.toPage = null;
    await reconnect(ana_);
    const made = await waitFor("the stroke in the DM's view", () => {
      const now = drawingsOf(dmSocket.state, run.anaId).filter((id) => !before.includes(id));
      return now.length > 0 ? now : null;
    });
    const asks = await waitFor("the page's ask about it", () => {
      const sent = ana_.sent.slice(from).filter((f) => f.t === "ids");
      return sent.length > 0 ? sent : null;
    });
    assert.deepEqual(asks[0]!.ids, made, "it asks about its own stroke");
    await waitFor("the room's answer", () => (ana_.got.some((f) => f.t === "ids" && (f.held as string[]).includes(made[0]!)) ? true : null));
    const creates = opsSent(ana_, from).filter((s) => s.op.t === "drawing.create");
    assert.equal(creates.length, 1, "sent once");
    assert.deepEqual(drawingsOf(dmSocket.state, run.anaId).filter((id) => !before.includes(id)), made, "one stroke");
  });

  test("lim-5. a stroke the room refused, its refusal lost, goes again under a fresh id and is kept", async () => {
    const before = drawingsOf(dmSocket.state, run.anaId);
    const from = ana_.sent.length;
    let own: string | null = null;
    let refused = false;
    // The id the page made reaches the room 40 minutes old, so the room refuses it, and that answer is lost.
    ana_.toServer = (frame) => {
      const op = frame.op as Json | undefined;
      if (own !== null || frame.t !== "op" || op?.t !== "drawing.create") return frame;
      const drawing = op.drawing as Json;
      own = String(drawing.id);
      return { ...frame, op: { ...op, drawing: { ...drawing, id: uuidv7(Date.now() - AWAY) } } };
    };
    ana_.toPage = (frame) => {
      if (refused || frame.t !== "ev" || !Array.isArray(frame.rejects) || frame.rejects.length === 0) return frame;
      refused = true;
      return null;
    };
    await dragCells(ana, BOUNDS, { x: 10, y: 8 }, { x: 14, y: 9 });
    await waitFor("the refusal held back", () => (refused ? true : null));
    ana_.toServer = null;
    ana_.toPage = null;
    await reconnect(ana_);
    const kept = await waitFor("the stroke in the DM's view", () => {
      const now = drawingsOf(dmSocket.state, run.anaId).filter((id) => !before.includes(id));
      return now.length > 0 ? now : null;
    }, 30_000);
    assert.equal(kept.length, 1, "one stroke");
    assert.notEqual(kept[0], own, "under a fresh id");
    assert.ok(madeNow(kept[0]!));
    const asked = ana_.sent.slice(from).filter((f) => f.t === "ids").flatMap((f) => f.ids as string[]);
    assert.ok(own !== null && asked.includes(own), "it asked about the id it made");
    assert.ok(ana_.got.some((f) => f.t === "ids" && (f.notHeld as string[]).includes(own!)), "which the room never recorded");
  });

  test("lim-6. the longest limit's words wrap in the toast at 320 px and 130%, after Not saved.", async () => {
    const words = `Not saved. ${SEAT_FULL.tokens}`;
    const off: string[] = [];
    try {
      await ana.setViewportSize(SMALL);
      await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await openAna();
      await pickTool(ana, "Draw");
      // Only the toast is under test here: the room's answer to the stroke is swapped for a refusal in those words.
      let swapped = false;
      ana_.toPage = (frame) => {
        if (swapped || frame.t !== "ev" || !Array.isArray(frame.acks) || frame.acks.length === 0) return frame;
        swapped = true;
        return { ...frame, changes: [], acks: [], rejects: frame.acks.map((n) => ({ n, code: "quota", message: SEAT_FULL.tokens })) };
      };
      await dragCells(ana, BOUNDS, { x: 3, y: 11 }, { x: 5, y: 12 });
      const toast = toasts(ana).filter({ hasText: words });
      await toast.waitFor();
      ana_.toPage = null;
      const box = (await toast.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= SMALL.width, `the toast fits across ${SMALL.width} px: ${JSON.stringify(box)}`);
      assert.equal(await toast.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "its words wrap rather than run out");
      off.push(...alignmentLines(await measureAlignment(toast), "the limit's toast at 320 x 568 at 130%"));
      await shots.take(ana, "lim-6-limit-toast-320-130");
    } finally {
      ana_.toPage = null;
      await ana.setViewportSize(DESKTOP);
      await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await openAna();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("lim-7. the DM's page says once that the room is over its size limit, and the notice lines up", async () => {
    // A second DM device, whose snapshots carry the DM-only field a room past its far line sends.
    const page = await dmContext.newPage();
    consoles.dm.attach(page);
    const w = await wire(page);
    w.toPage = (frame) => (frame.t === "snapshot" ? { ...frame, over: { bytes: Math.round(12.4 * MiB) } } : frame);
    const off: string[] = [];
    try {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      const notice = toasts(page).filter({ hasText: overNotice(13) });
      await notice.waitFor();
      off.push(...alignmentLines(await measureAlignment(notice), "the over-limit notice at 1440 x 900"));
      await shots.take(page, "lim-7-over-limit-notice");
      // Another snapshot over by the same MiB says nothing more.
      await notice.waitFor({ state: "detached", timeout: 20_000 });
      await reconnect(w);
      await page.waitForTimeout(500);
      assert.equal(await toasts(page).filter({ hasText: overNotice(13) }).count(), 0, "said once");
    } finally {
      await page.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("lim-7b. each byte line's words, as a player and as the DM read them, fit and line up in the toast on a phone at 100% and 130%", async () => {
    const off: string[] = [];
    // What the toast says: the refusal capitalized after Not saved. (client/state/store.ts refusalText).
    const shown = (message: string) => `Not saved. ${message[0]!.toUpperCase()}${message.slice(1)}.`;
    const lines = [
      { who: "player", core: ROOM_FULL },
      { who: "player", core: SCENE_FULL },
      { who: "dm", core: ROOM_FULL },
      { who: "dm", core: KEPT_FOR_PLAYERS_FULL },
      { who: "dm", core: SCENE_FULL },
    ] as const;
    const dmPage = await dmContext.newPage();
    consoles.dm.attach(dmPage);
    const dmWire = await wire(dmPage);
    try {
      for (const scale of ["1", "1.3"]) {
        for (const page of [ana, dmPage]) await page.setViewportSize(PHONE);
        for (const { who, core } of lines) {
          const page = who === "player" ? ana : dmPage;
          const w = who === "player" ? ana_ : dmWire;
          await page.goto(`${server.origin}/r/${run.roomId}`);
          await page.evaluate((v) => localStorage.setItem("rvtt.uiScale", v), scale);
          const seen = snapshotsOf(w);
          await page.goto(`${server.origin}/r/${run.roomId}`);
          await waitFor("the snapshot", () => (snapshotsOf(w) > seen ? true : null), 30_000);
          await page.locator(".konvajs-content").first().waitFor();
          await pickTool(page, "Draw");
          // The DM's bar is longer than a phone's width and may scroll under the pick, so the tool is checked, not assumed.
          const draw = page.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Draw", exact: true });
          await waitFor("the Draw tool active", async () => {
            if ((await draw.first().getAttribute("data-active")) === "true") return true;
            await draw.first().click();
            return null;
          }, 10_000);
          const message = sizeRemedy(core, who);
          // The server never sees the op: the page is sent the refusal in its place, so only the toast is under test.
          let swapped = false;
          w.toServer = (frame) => {
            if (swapped || frame.t !== "op") return frame;
            swapped = true;
            const seq = Math.max(0, ...w.got.flatMap((f) => (typeof f.seq === "number" ? [f.seq] : [])));
            w.open!.page.send(JSON.stringify({ t: "ev", seq, changes: [], rejects: [{ n: frame.n, code: "quota", message }] }));
            return null;
          };
          await dragCells(page, BOUNDS, { x: 3, y: 11 }, { x: 5, y: 12 });
          const toast = toasts(page).filter({ hasText: shown(message) });
          await toast.waitFor();
          w.toServer = null;
          const label = `${who} ${core} at ${scale}`;
          const box = (await toast.boundingBox())!;
          assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, `${label}: the toast fits across ${PHONE.width} px: ${JSON.stringify(box)}`);
          assert.ok(box.y >= 0 && box.y + box.height <= PHONE.height, `${label}: the toast fits down ${PHONE.height} px: ${JSON.stringify(box)}`);
          assert.equal(await toast.evaluate((el) => el.scrollWidth <= el.clientWidth), true, `${label}: its words wrap rather than run out`);
          // Centered across the phone, to within a pixel.
          assert.ok(Math.abs(box.x + box.width / 2 - PHONE.width / 2) <= 1, `${label}: centered ${JSON.stringify(box)}`);
          off.push(...alignmentLines(await measureAlignment(toast), `${label} at 390 x 844`));
          await shots.take(page, `lim-7b-${who}-${core === ROOM_FULL ? "room" : core === SCENE_FULL ? "scene" : "kept"}-${scale === "1" ? "100" : "130"}`);
        }
      }
    } finally {
      ana_.toServer = null;
      await dmPage.close();
      await ana.setViewportSize(DESKTOP);
      await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await openAna();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("lim-8. deleting the players' map asks first at every size, Cancel keeps it, a yes leaves them with no map, and Undo puts them back", async () => {
    const off: string[] = [];
    const openAsk = async () => {
      // A change of size closes the scene menu but keeps the Scenes panel or sheet open, so the panel opens once.
      const more = dm.getByRole("button", { name: `More for ${run.sceneName}`, exact: true });
      if (!(await more.isVisible())) await openSideTab(dm, "Scenes");
      await more.click();
      const menu = dm.getByRole("dialog", { name: run.sceneName, exact: true });
      await menu.waitFor();
      await menu.getByRole("button", { name: /^Delete/ }).click();
      const ask = dm.getByRole("dialog", { name: `Delete ${run.sceneName}`, exact: true });
      await ask.getByText(LEAVE_PLAYERS_ASK, { exact: true }).waitFor();
      return { menu, ask };
    };
    const reopen = async (scale: number) => {
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await dm.goto(`${server.origin}/r/${run.roomId}`);
      await dm.locator(".konvajs-content").first().waitFor();
    };
    try {
      for (const scale of [1, 1.3]) {
        if (scale !== 1) await reopen(scale);
        for (const size of [DESKTOP, PHONE, SMALL]) {
          await dm.setViewportSize(size);
          const { menu, ask } = await openAsk();
          const cancel = ask.getByRole("button", { name: "Cancel", exact: true });
          await waitFor("focus on Cancel", () => cancel.evaluate((el) => el === el.ownerDocument.activeElement || null));
          const at = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
          off.push(...alignmentLines(await measureAlignment(ask), `the players' map delete question at ${at}`));
          await shots.take(dm, `lim-8-players-map-delete-${size.width}-${Math.round(scale * 100)}`);
          // Escape answers no: the question goes, the menu stays, and so does the map.
          await dm.keyboard.press("Escape");
          await ask.waitFor({ state: "detached" });
          await dm.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
        }
      }
    } finally {
      await dm.setViewportSize(DESKTOP);
      await reopen(1);
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
    assert.ok(dmSocket.state!.scenes[run.sceneId], "the map is kept");
    assert.equal(dmSocket.state!.meta.playerSceneId, run.sceneId);

    const { ask } = await openAsk();
    await ask.getByRole("button", { name: "Delete", exact: true }).click();
    await waitFor("the players' map deleted", () => (dmSocket.state!.scenes[run.sceneId] ? null : true));
    assert.equal(dmSocket.state!.meta.playerSceneId, null, "the players are on no map");
    await ana.getByText("Waiting for the DM to pick a scene.", { exact: true }).waitFor();
    await shots.take(ana, "lim-8-players-no-map");
    await undoSetup(dm);
    await waitFor("the map back", () => (dmSocket.state!.scenes[run.sceneId] ? true : null));
    await waitFor("the players on it again", () => (dmSocket.state!.meta.playerSceneId === run.sceneId ? true : null));
    await ana.locator(".konvajs-content").first().waitFor();
  });

  test("lp47fixa-1. a refused stat block Save shows its words at the top of the editor and in view, saved from the top or the foot of the form, on a computer and a phone at 100% and 130%", async () => {
    const off: string[] = [];
    // The server never sees the save: the page is sent the refusal in its place, as the room at its line answers a player.
    const refuseSaves = () => {
      ana_.toServer = (frame) => {
        if (frame.t !== "op" || (frame.op as Json | undefined)?.t !== "character.update") return frame;
        const seq = Math.max(0, ...ana_.got.flatMap((f) => (typeof f.seq === "number" ? [f.seq] : [])));
        ana_.open!.page.send(JSON.stringify({ t: "ev", seq, changes: [], rejects: [{ n: frame.n, code: "quota", message: BLOCKS_ROOM_TOO_FULL }] }));
        return null;
      };
    };
    // The editor's scrolling body is the one box in its dialog that scrolls (each evaluate finds it again, in the page).
    type Styles = { getComputedStyle(el: unknown): { overflowY: string } };
    /** Where the alert lies against the editor's scrolling body, and how far that body scrolls. */
    const placed = (alert: Locator) =>
      alert.evaluate((el) => {
        const g = globalThis as unknown as Styles;
        const body = [...el.closest("dialog")!.querySelectorAll("div")].find((d) => g.getComputedStyle(d).overflowY === "auto" && d.scrollHeight > d.clientHeight)!;
        const [a, b] = [el.getBoundingClientRect(), body.getBoundingClientRect()];
        return { top: a.top, bottom: a.bottom, bodyTop: b.top, bodyBottom: b.bottom, tall: body.scrollHeight - body.clientHeight };
      });
    try {
      for (const scale of ["1", "1.3"]) {
        for (const size of [DESKTOP, PHONE, SMALL]) {
          const phone = size.width < 900;
          const at = `${size.width} x ${size.height} at ${scale === "1" ? 100 : 130}%`;
          await ana.setViewportSize(size);
          await ana.evaluate((v) => localStorage.setItem("rvtt.uiScale", v), scale);
          await openAna();
          if (phone) {
            await ana.getByRole("button", { name: "Panels" }).click();
            await ana.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
          } else await openSideTab(ana, "Characters");
          // Ana plays Bree alone, so the panel lands on Bree's page.
          const fold = ana.getByRole("button", { name: "Stat block", exact: true });
          await fold.waitFor();
          if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
          await ana.getByRole("button", { name: "Add a stat block" }).click();
          const editor = ana.getByRole("dialog", { name: "Bree's stat block" });
          await editor.waitFor();
          await editor.getByLabel("Level", { exact: true }).fill("3");
          refuseSaves();
          for (const from of ["top", "foot"] as const) {
            // From the foot, as after adding a weapon under Rolls: the words above the fields come into view all the same.
            if (from === "foot") {
              await editor.evaluate((dialog) => {
                const g = globalThis as unknown as Styles;
                [...dialog.querySelectorAll("div")].find((d) => g.getComputedStyle(d).overflowY === "auto" && d.scrollHeight > d.clientHeight)!.scrollTo(0, 1e6);
              });
            }
            await editor.getByRole("button", { name: "Save", exact: true }).click();
            const alert = editor.getByRole("alert").filter({ hasText: `Not saved. ${BLOCKS_ROOM_TOO_FULL}` });
            await alert.waitFor();
            const label = `${at}, saved from the ${from}`;
            const box = await waitFor(`${label}: the words in view`, async () => {
              const box = await placed(alert);
              return box.top >= box.bodyTop - 1 && box.bottom <= box.bodyBottom + 1 ? box : null;
            }, 5_000);
            assert.ok(box.tall > 0, `${label}: the form scrolls, so the check means something`);
            if (from === "top") {
              // Above the fields: nothing of the form sits between the editor's top and the words.
              assert.ok(box.top - box.bodyTop < 200, `${label}: at the top of the editor ${JSON.stringify(box)}`);
              off.push(...alignmentLines(await measureAlignment(alert), `the refused save's words at ${at}`));
              await shots.take(ana, `lp47fixa-1-refused-save-${size.width}-${scale === "1" ? 100 : 130}`);
            }
          }
          ana_.toServer = null;
          await ana.keyboard.press("Escape");
          await editor.getByRole("button", { name: "Discard", exact: true }).click();
          await editor.waitFor({ state: "detached" });
        }
      }
    } finally {
      ana_.toServer = null;
      await ana.setViewportSize(DESKTOP);
      await ana.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
      await openAna();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("lim-9. the pages logged no console errors", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
