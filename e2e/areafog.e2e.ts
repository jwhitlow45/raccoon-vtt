import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import WebSocket from "ws";
import { ConsoleWatch, OpSocket, pagePoint, pickTool, Shots, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * An area being aimed over a player's fog (lane AF): the area tool's own
 * preview and the previews other members share draw above the fog, in
 * Top-down's overlay and in Isometric's drag layer, and their shading
 * shows only on ground the player's fog reveals. So a wall on fogged
 * ground changes none of the preview's pixels over the fog. Each check
 * reads the page's pixels at the middle of every fogged sub-cell the
 * sphere reaches, once with the wall and once without, and they must match.
 * On revealed ground the shading still shows. The DM's preview is cut by
 * the wall as before.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus thirty-two,
 * as other files do, since the runs never overlap. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 32;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-areafog-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script: it installs the hook that picks and turns the view (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

const BOUNDS = { w: 16, h: 12 };
/** Every column west of this one is revealed to the players, the rest is fogged. */
const FOG_EDGE = 8;
/** Fireball's 20 ft sphere, centered here: its east side reaches 4 cells into the fog. */
const ORIGIN = { x: 6, y: 6 };
/** The hidden wall: the west edge of column 9, all the way down, a cell east of the fog's edge. */
const WALL_X = 9;
/** Per channel, between two draws of the same picture. */
const TOLERANCE = 2;

type Rgb = [number, number, number];
type View = "topDown" | "isometric";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
let dmRaw: WebSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = { roomId: "", roomName: `E2E area over fog ${new Date().toISOString().slice(0, 19)}`, password: "", sceneId: "" };

async function join(context: BrowserContext, name: string, color: string): Promise<void> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
}

/** A second socket of the DM's, for ephemeral events: OpSocket sends only ops. */
async function openRaw(cookie: string): Promise<WebSocket> {
  const ws = new WebSocket(`${server.origin.replace(/^http/, "ws")}/ws?room=${run.roomId}`, { headers: { Origin: server.origin, Cookie: cookie } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No snapshot within 10 s")), 10_000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", clientId: randomUUID(), resumeFrom: 1 })));
    ws.on("message", function first(data) {
      if ((JSON.parse(String(data)) as { t?: unknown }).t !== "snapshot") return;
      clearTimeout(timer);
      ws.off("message", first);
      resolve();
    });
    ws.on("error", reject);
  });
  return ws;
}

/** The hidden wall in place or gone, once Pat's page holds the change. */
async function setWall(on: boolean): Promise<void> {
  const edges = Array.from({ length: BOUNDS.h }, (_, y) => ({ key: `${WALL_X},${y},w`, feature: on ? { kind: "wall" } : null }));
  await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });
  await waitFor(`the wall ${on ? "on" : "off"} on Pat's page`, () => {
    const chunk = Object.values(patSocket.state?.buildChunks ?? {}).find((c) => c.sceneId === run.sceneId && c.cx === 0 && c.cy === 0);
    return Boolean(chunk?.edges[`${WALL_X},5,w`]) === on || null;
  });
  // The board redraws on the change, the preview's shading with it.
  await sleep(500);
}

function options(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Area options" });
}

/** A spell from the search, wherever the field stands: in the row, or in the shape chip's popover (as areas.e2e.ts picks one). */
async function spell(page: Page, name: string): Promise<void> {
  const inRow = options(page).locator("[data-options-row]").getByRole("combobox", { name: "Spell" });
  if ((await inRow.count()) > 0 && (await inRow.isVisible())) {
    await inRow.fill(name);
    await inRow.press("Enter");
  } else {
    await options(page).getByRole("button", { name: /^Shape:/ }).click();
    const field = page.getByRole("dialog", { name: "Shape" }).getByRole("textbox", { name: "Spell" });
    await field.fill(name);
    await field.press("Enter");
  }
  await page.waitForTimeout(200);
}

/** Presses a slot's control wherever it stands: inline, or in ⋯. */
async function pressSlot(page: Page, id: string): Promise<void> {
  const inline = options(page).locator(`[data-options-row] > [data-rvtt-slot="${id}"] button`).first();
  if ((await inline.count()) > 0 && (await inline.isVisible())) {
    await inline.click();
    return;
  }
  await options(page).getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: "More Area options" });
  await more.locator(`[data-rvtt-slot="${id}"] button`).first().click();
  if (await more.isVisible()) await page.keyboard.press("Escape");
  await more.waitFor({ state: "detached" });
}

/** Aims Fireball at ORIGIN with the area tool, a click where the DM's mouse or Pat's would go. */
async function aim(page: Page): Promise<void> {
  await pickTool(page, "Area");
  await spell(page, "fireball");
  const p = await pagePoint(page, BOUNDS, ORIGIN);
  await page.mouse.click(p.x, p.y);
  await waitFor("the Place control", async () => (await options(page).locator('[data-rvtt-slot="place"]').count()) > 0 || null);
  // The shading refines once the pointer rests.
  await sleep(500);
}

/** Picks Isometric at a turn through the test hook, as the View menu does, or Top-down. */
async function viewAs(page: Page, view: View, turn = 0): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate(
    ([v, t]) => {
      const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
      hook.pick(v);
      if (v === "isometric") hook.turn(t);
    },
    [view, turn] as const,
  );
  await waitFor(`the ${view} board with its fog`, () =>
    page.evaluate((iso) => {
      type Node = { getAttr(name: string): unknown };
      type Stage = { width(): number; visible(): boolean; listening(): boolean; find(f: (n: Node) => boolean): Node[] };
      const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
      const shown = konva?.stages.filter((s) => s.width() > 0 && s.visible()) ?? [];
      const stage = iso ? shown.find((s) => !s.listening()) : shown.length === 1 ? shown[0] : undefined;
      return stage && stage.find((n) => n.getAttr("fogVersion") !== undefined).length > 0 ? true : null;
    }, view === "isometric"),
  );
  await sleep(500);
}

/** The fog shape's transform from cells to CSS px on the page: the ground plane's in Isometric, where the preview lies too. */
type Placement = { m: number[]; left: number; top: number };

async function placement(page: Page): Promise<Placement> {
  return page.evaluate(() => {
    type Transform = { m: number[] };
    type Node = { getAttr(name: string): unknown; getAbsoluteTransform(): Transform };
    type Stage = { width(): number; visible(): boolean; find(f: (n: Node) => boolean): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const isFog = (n: Node) => n.getAttr("fogVersion") !== undefined;
    const holder = konva.stages.filter((s) => s.width() > 0 && s.visible()).find((s) => s.find(isFog).length > 0);
    if (!holder) throw new Error("no fog on screen");
    const box = holder.container().getBoundingClientRect();
    return { m: [...holder.find(isFog)[0]!.getAbsoluteTransform().m], left: box.left, top: box.top };
  });
}

function toPage(p: Placement, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = p.m as [number, number, number, number, number, number];
  return { x: p.left + a * x + c * y + e, y: p.top + b * x + d * y + f };
}

/** A place read, in cells, and where it lies on the page. */
type Spot = { cell: { x: number; y: number }; page: { x: number; y: number } };

/** The middle of every fogged sub-cell the sphere's box reaches, east of the fog's edge, that the board's canvas holds. */
async function foggedSpots(page: Page, at: Placement): Promise<Spot[]> {
  const spots: Spot[] = [];
  for (let sy = (ORIGIN.y - 4) * 4; sy < (ORIGIN.y + 4) * 4; sy++) {
    for (let sx = FOG_EDGE * 4; sx < (ORIGIN.x + 4) * 4; sx++) {
      const cell = { x: (sx + 0.5) / 4, y: (sy + 0.5) / 4 };
      spots.push({ cell, page: toPage(at, cell.x, cell.y) });
    }
  }
  return onCanvas(page, spots);
}

/** The spots no bar or panel covers. */
async function onCanvas(page: Page, spots: Spot[]): Promise<Spot[]> {
  const tags = await page.evaluate(
    (at) => at.map(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? ""),
    spots.map((s) => [s.page.x, s.page.y] as const),
  );
  return spots.filter((_, i) => tags[i] === "CANVAS");
}

/** The page's pixel under each spot, the device pixel ratio 1. */
async function read(page: Page, spots: readonly Spot[]): Promise<Rgb[]> {
  const png = await page.screenshot({ scale: "css" });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return spots.map((s) => {
    const i = (Math.floor(s.page.y) * info.width + Math.floor(s.page.x)) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  });
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/**
 * The paired check: the pixels over the fog with the wall and without it.
 * Returns the spots that differ by more than TOLERANCE, each named.
 */
async function pairedDiff(page: Page, label: string): Promise<{ spots: number; misses: string[] }> {
  const at = await placement(page);
  const spots = await foggedSpots(page, at);
  await setWall(true);
  assert.deepEqual(await placement(page), at, `${label}: the camera held still`);
  const walled = await read(page, spots);
  await shots.take(page, `areafog-${label}-wall`);
  await setWall(false);
  const open = await read(page, spots);
  await shots.take(page, `areafog-${label}-open`);
  const misses = spots.flatMap((s, i) => (diff(walled[i]!, open[i]!) > TOLERANCE ? [`${s.cell.x},${s.cell.y}: ${walled[i]!.join(",")} with the wall, ${open[i]!.join(",")} without`] : []));
  return { spots: spots.length, misses };
}

/** Whether the shading shows on revealed ground: a revealed cell inside the sphere reads other than it did before the preview. */
async function revealedSpot(page: Page): Promise<Spot> {
  const at = await placement(page);
  const cell = { x: ORIGIN.x - 2.3, y: ORIGIN.y + 0.4 };
  const [spot] = await onCanvas(page, [{ cell, page: toPage(at, cell.x, cell.y) }]);
  assert.ok(spot, "the revealed spot lies on the canvas");
  return spot;
}

/** Sends a shared Fireball from the DM every 400 ms until stopped, as a resting preview keeps itself alive. */
function shareFromDm(): () => void {
  const id = randomUUID();
  const send = (e: Record<string, unknown>) => dmRaw.send(JSON.stringify({ t: "eph", sceneId: run.sceneId, e }));
  const frame = () => send({ k: "aoe", id, shape: "sphere", origin: { ...ORIGIN, z: 0 }, yaw: 0, size: 20, shared: true });
  frame();
  const timer = setInterval(frame, 400);
  return () => {
    clearInterval(timer);
    send({ k: "aoeEnd", id });
  };
}

describe("raccoon-vtt an area aimed over a player's fog", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await patContext.addInitScript(HOOK_FLAG);
    await dmContext.addInitScript(HOOK_FLAG);
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(server?.output().split("\n").slice(-40).join("\n"));
    ops?.close();
    dmRaw?.close();
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

  test("AF-1. a DM's room whose 16 by 12 scene has fog on, its west half revealed, and Pat", async () => {
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
    dmRaw = await openRaw(cookie);
    await ops.send({ t: "room.update", settings: { playersDraw: "all" } });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: true } });
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: FOG_EDGE, h: BOUNDS.h } }] });
    await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state?.scenes[run.sceneId]?.fogEnabled || null);
    await pat.locator(".konvajs-content").first().waitFor();
    await viewAs(pat, "topDown");
  });

  test("AF-2. Pat aims Fireball over the fog's edge in Top-down: its pixels over the fog are the same with the hidden wall and without it, and it shades revealed ground", async () => {
    const spot = await revealedSpot(pat);
    const [bare] = await read(pat, [spot]);
    await aim(pat);
    const [shaded] = await read(pat, [spot]);
    assert.ok(diff(bare!, shaded!) > 10, `the shading shows on revealed ground: ${bare!.join(",")} then ${shaded!.join(",")}`);
    const { spots, misses } = await pairedDiff(pat, "pat-topdown");
    assert.ok(spots > 100, `enough fogged spots read: ${spots}`);
    assert.deepEqual(misses, []);
  });

  test("AF-3. the same in Isometric, at two turns", async () => {
    for (const turn of [0, 1]) {
      await viewAs(pat, "isometric", turn);
      const { spots, misses } = await pairedDiff(pat, `pat-iso-turn-${turn}`);
      assert.ok(spots > 100, `turn ${turn}: enough fogged spots read: ${spots}`);
      assert.deepEqual(misses, [], `turn ${turn}`);
    }
    await viewAs(pat, "topDown");
    await pressSlot(pat, "cancel");
  });

  test("AF-4. a Fireball the DM shares: Pat's pixels over the fog are the same with the hidden wall and without it, in both views, and it shades revealed ground", async () => {
    const spot = await revealedSpot(pat);
    const [bare] = await read(pat, [spot]);
    const stop = shareFromDm();
    try {
      await waitFor("the DM's shared preview on Pat's board", async () => {
        const [now] = await read(pat, [spot]);
        return diff(bare!, now!) > 6 || null;
      });
      for (const view of ["topDown", "isometric"] as const) {
        await viewAs(pat, view);
        const { spots, misses } = await pairedDiff(pat, `pat-shared-${view}`);
        assert.ok(spots > 100, `${view}: enough fogged spots read: ${spots}`);
        assert.deepEqual(misses, [], view);
      }
    } finally {
      stop();
    }
    await viewAs(pat, "topDown");
  });

  test("AF-5. the DM's own Fireball is still cut by the wall, in both views", async () => {
    await dm.locator(".konvajs-content").first().waitFor();
    await viewAs(dm, "topDown");
    await aim(dm);
    // East of the wall's line, clear of its stroke and the grid's lines: cells the wall takes the shading from.
    const cells = [9.3, 9.55, 9.8].flatMap((x) => [5.3, 5.7, 6.3, 6.7].map((y) => ({ x, y })));
    /** The spots at those cells as the DM's board stands now: closing the area's options moves a fitted board. */
    const spotsNow = async (view: View) => {
      const at = await placement(dm);
      const spots = await onCanvas(dm, cells.map((cell) => ({ cell, page: toPage(at, cell.x, cell.y) })));
      assert.equal(spots.length, cells.length, `${view}: every spot lies on the canvas`);
      return spots;
    };
    /** Each spot's pixels with the wall and without it. */
    const both = async (view: View, name: string) => {
      const spots = await spotsNow(view);
      await setWall(true);
      const walled = await read(dm, spots);
      await shots.take(dm, `areafog-dm-${view}-${name}-wall`);
      await setWall(false);
      return { walled, open: await read(dm, spots) };
    };
    const shown = new Map<View, { walled: Rgb[]; open: Rgb[] }>();
    for (const view of ["topDown", "isometric"] as const) {
      await viewAs(dm, view);
      shown.set(view, await both(view, "preview"));
    }
    await viewAs(dm, "topDown");
    await pressSlot(dm, "cancel");
    for (const view of ["topDown", "isometric"] as const) {
      await viewAs(dm, view);
      const bare = await both(view, "none");
      const r = shown.get(view)!;
      const shows = cells.filter((_, i) => diff(r.open[i]!, bare.open[i]!) > 10).length;
      const cut = cells.filter((_, i) => diff(r.walled[i]!, bare.walled[i]!) <= TOLERANCE).length;
      assert.equal(shows, cells.length, `${view}: without the wall the shading shows at every spot`);
      assert.equal(cut, cells.length, `${view}: with it the shading shows at none`);
    }
    await viewAs(dm, "topDown");
  });

  test("AF-6. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
