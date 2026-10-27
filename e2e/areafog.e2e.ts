import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import WebSocket from "ws";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickTool, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * An area being aimed over a player's fog (lane AF): the area tool's own
 * preview and the previews other members share draw above the fog, in
 * Top-down's overlay and in Isometric's drag layer, and their shading
 * shows only on ground the player's fog reveals. On a player's device it
 * reads only the walls with a revealed sub-cell beside them, so a wall
 * wholly under the fog changes none of the preview's pixels, wherever its
 * origin lies: in the fog beside revealed ground, or across a fogged strip
 * from revealed ground beyond it. A player's copy holds the build only on
 * cells with a revealed sub-cell, and edges by either cell beside them
 * (docs/design-v1-map-discovery.md decision 1), so each hidden wall stands
 * a sub-cell or more past revealed ground that ends inside a cell: the
 * device holds it, and no revealed sub-cell lies beside it. Each check reads the page's pixels at the
 * middle of sub-cells the sphere reaches, once with the wall and once
 * without, and they must match, and over the fog this device's own
 * preview leaves the fog's color but for its outline. On revealed ground
 * the shading still shows. The DM's preview is cut by the wall as before.
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

type Rgb = [number, number, number];

/** Set before the app's first script: it installs the hook that picks and turns the view (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

const BOUNDS = { w: 16, h: 12 };
/** The first layout's revealed ground ends here, a sub-cell into column 8, so Pat's copy holds column 8 and the wall on its east side. */
const FOG_EDGE = 8.25;
/** Fireball's 20 ft sphere, centered here: its east side reaches 4 cells into the fog. */
const ORIGIN = { x: 6, y: 6 };

type Rect = { x: number; y: number; w: number; h: number };
/**
 * Where the fog's revealed ground lies, where the sphere is aimed and how
 * big, and the hidden wall, wholly under the fog: west edges of cells
 * ("x,y") or one free wall.
 */
type Layout = { name: string; reveal: readonly Rect[]; origin: { x: number; y: number }; size: number; edges?: readonly string[]; free?: { id: string; a: [number, number]; b: [number, number] } };

const column = (x: number, skip: readonly number[] = []) => Array.from({ length: BOUNDS.h }, (_, y) => y).filter((y) => !skip.includes(y)).map((y) => `${x},${y}`);

/** The first layout: the fog's edge at x = 8.25, the origin west of it, the wall along x = 9, three sub-cells into the fog. */
const PAST_EDGE: Layout = { name: "past-edge", reveal: [{ x: 0, y: 0, w: FOG_EDGE, h: BOUNDS.h }], origin: ORIGIN, size: 20, edges: column(9) };
/** The origin in the fog beside revealed ground, a wall with a doorway between them, three sub-cells past the fog's edge. */
const ORIGIN_IN_FOG: Layout = { name: "origin-in-fog", reveal: [{ x: 0, y: 0, w: 9.25, h: BOUNDS.h }], origin: { x: 11, y: 6 }, size: 30, edges: column(10, [5, 6]) };
/** A fogged strip from x = 6.25 to 9 between revealed ground, the wall in the strip. */
const ACROSS_STRIP: Layout = {
  name: "across-strip",
  reveal: [
    { x: 0, y: 0, w: 6.25, h: BOUNDS.h },
    { x: 9, y: 0, w: 7, h: BOUNDS.h },
  ],
  origin: { x: 4, y: 6 },
  size: 30,
  edges: column(7),
};
/** Revealed to x = 7.5, inside a cell, and a free wall in that cell's fogged half. */
const EDGE_IN_CELL: Layout = { name: "edge-in-cell", reveal: [{ x: 0, y: 0, w: 7.5, h: BOUNDS.h }], origin: { x: 10, y: 6 }, size: 30, free: { id: "aimfoghalf01", a: [7.75, 2], b: [7.75, 10] } };
/**
 * The origin in the fogged part of column 7, whose first sub-cell is
 * revealed, and a free wall in that fogged part between the origin and the
 * goblin. Every ray to the goblin lies on cells Pat holds, so Pat's lists
 * may name it (docs/design-v1-map-discovery.md decision 13), and the wall
 * would take every one of those rays.
 */
const ORIGIN_IN_CELL: Layout = { name: "origin-in-cell", reveal: [{ x: 0, y: 0, w: 7.25, h: BOUNDS.h }], origin: { x: 7.5, y: 6.5 }, size: 30, free: { id: "aimfogcell01", a: [7.375, 2], b: [7.375, 10] } };
/** Per channel, between two draws of the same picture. */
const TOLERANCE = 2;
/** theme.color.fog, as a player sees it: opaque. */
const FOG: Rgb = [13, 13, 18];

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

const run = { roomId: "", roomName: `E2E area over fog ${new Date().toISOString().slice(0, 19)}`, password: "", sceneId: "", goblin: randomUUID(), bree: randomUUID(), aura: randomUUID() };

const ACTOR = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

/** A goblin on revealed ground, inside ORIGIN_IN_CELL's sphere, west of its wall. */
const GOBLIN_AT = { x: 5, y: 2 };

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

/** A layout's hidden wall in place or gone, once Pat's page holds the change. */
async function setWall(on: boolean, layout: Layout = PAST_EDGE): Promise<void> {
  const edges = (layout.edges ?? []).map((key) => ({ key: `${key},w`, feature: on ? { kind: "wall" } : null }));
  if (edges.length > 0) await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });
  const free = layout.free;
  if (free) await ops.send({ t: "build.walls", sceneId: run.sceneId, ...(on ? { put: [{ ...free, f: { kind: "wall" } }] } : { remove: [{ cx: 0, cy: 0, id: free.id }] }) });
  await waitFor(`the wall ${on ? "on" : "off"} on Pat's page`, () => {
    const chunk = Object.values(patSocket.state?.buildChunks ?? {}).find((c) => c.sceneId === run.sceneId && c.cx === 0 && c.cy === 0);
    // A free wall reaches a player as the pieces the server cut from it, each with an id of its own, so it is found by where it stands.
    const has = edges.length > 0 ? Boolean(chunk?.edges[edges[0]!.key]) : Boolean(chunk?.walls?.some((w) => w.a[0] === free?.a[0] && w.b[0] === free?.b[0]));
    return has === on || null;
  });
  // The board redraws on the change, the preview's shading with it.
  await sleep(500);
}

/** What the fog reveals now, as a layout's rectangles: AF-1 reveals the first layout's. */
let revealed = JSON.stringify(PAST_EDGE.reveal);

/** The fog as a layout reveals it, once Pat's page holds it. */
async function setFog(layout: Layout): Promise<void> {
  if (JSON.stringify(layout.reveal) === revealed) return;
  revealed = JSON.stringify(layout.reveal);
  const before = JSON.stringify(patSocket.state?.fogTiles);
  const hide = { id: randomUUID(), mode: "hide", shape: { kind: "rect", x: 0, y: 0, w: BOUNDS.w, h: BOUNDS.h } };
  await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [hide, ...layout.reveal.map((r) => ({ id: randomUUID(), mode: "reveal", shape: { kind: "rect", ...r } }))] });
  await waitFor("the fog on Pat's page", () => JSON.stringify(patSocket.state?.fogTiles) !== before || null);
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

/** Aims Fireball at a layout's origin with the area tool, a click where the DM's mouse or Pat's would go, and grows it to the layout's size. */
async function aim(page: Page, layout: Layout = PAST_EDGE): Promise<void> {
  await pickTool(page, "Area");
  await spell(page, "fireball");
  const p = await pagePoint(page, BOUNDS, layout.origin);
  await page.mouse.click(p.x, p.y);
  await waitFor("the Place control", async () => (await options(page).locator('[data-rvtt-slot="place"]').count()) > 0 || null);
  for (let ft = 20; ft < layout.size; ft += 5) await options(page).getByRole("button", { name: "More size" }).click();
  // The shading refines once the pointer rests.
  await sleep(500);
}

/** A standee's middle on the page, from Konva's own box of it on Isometric's main stage (as iso.e2e.ts finds one). */
async function standeeAt(page: Page, tokenId: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((id) => {
    type Stage = { width(): number; visible(): boolean; listening(): boolean; findOne(s: string): { getClientRect(): { x: number; y: number; width: number; height: number } } | undefined; container(): { getBoundingClientRect(): { left: number; top: number } } };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const main = konva.stages.find((s) => s.width() > 0 && s.visible() && s.listening());
    const node = main?.findOne(`#${id}`);
    if (!main || !node) return null;
    const r = node.getClientRect();
    const c = main.container().getBoundingClientRect();
    return { x: c.left + r.x + r.width / 2, y: c.top + r.y + r.height / 2 };
  }, tokenId);
  assert.ok(at, `${tokenId} stands on the board`);
  return at;
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

/** The middle of every sub-cell of a layout's sphere's box inside the scene that the board's canvas holds, fogged or not. */
async function boxSpots(page: Page, at: Placement, layout: Layout): Promise<Spot[]> {
  const r = layout.size / 5;
  const spots: Spot[] = [];
  for (let sy = Math.max(0, (layout.origin.y - r) * 4); sy < Math.min(BOUNDS.h, layout.origin.y + r) * 4; sy++) {
    for (let sx = Math.max(0, (layout.origin.x - r) * 4); sx < Math.min(BOUNDS.w, layout.origin.x + r) * 4; sx++) {
      const cell = { x: (sx + 0.5) / 4, y: (sy + 0.5) / 4 };
      spots.push({ cell, page: toPage(at, cell.x, cell.y) });
    }
  }
  return onCanvas(page, spots);
}

/** The middle of every fogged sub-cell the first layout's sphere's box reaches, east of the fog's edge, that the board's canvas holds. */
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
/** Whether a point in cells lies on ground a layout reveals. */
function revealedIn(layout: Layout, p: { x: number; y: number }): boolean {
  return layout.reveal.some((r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h);
}

/**
 * The paired check: the pixels with the wall and without it, and for this
 * device's own preview, the fog's own color at every fogged spot clear of
 * the outline and the origin's grip, which draw over the fog whole.
 * Returns the spots that miss, each named.
 */
async function pairedDiff(page: Page, label: string, layout?: Layout, own = false): Promise<{ spots: number; misses: string[] }> {
  const at = await placement(page);
  const spots = layout ? await boxSpots(page, at, layout) : await foggedSpots(page, at);
  await setWall(true, layout);
  assert.deepEqual(await placement(page), at, `${label}: the camera held still`);
  const walled = await read(page, spots);
  await shots.take(page, `areafog-${label}-wall`);
  await setWall(false, layout);
  const open = await read(page, spots);
  await shots.take(page, `areafog-${label}-open`);
  const misses = spots.flatMap((s, i) => (diff(walled[i]!, open[i]!) > TOLERANCE ? [`${s.cell.x},${s.cell.y}: ${walled[i]!.join(",")} with the wall, ${open[i]!.join(",")} without`] : []));
  if (own) {
    const l = layout ?? PAST_EDGE;
    const r = l.size / 5;
    spots.forEach((s, i) => {
      const d = Math.hypot(s.cell.x - l.origin.x, s.cell.y - l.origin.y);
      if (revealedIn(l, s.cell) || Math.abs(d - r) < 0.35 || d < 0.35) return;
      for (const [got, wall] of [[walled[i]!, "with"], [open[i]!, "without"]] as const) {
        if (diff(got, FOG) > TOLERANCE) misses.push(`${s.cell.x},${s.cell.y} over the fog ${wall} the wall: ${got.join(",")}`);
      }
    });
  }
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
function shareFromDm(layout: Layout = PAST_EDGE): () => void {
  const id = randomUUID();
  const send = (e: Record<string, unknown>) => dmRaw.send(JSON.stringify({ t: "eph", sceneId: run.sceneId, e }));
  const frame = () => send({ k: "aoe", id, shape: "sphere", origin: { ...layout.origin, z: 0 }, yaw: 0, size: layout.size, shared: true });
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

  test("AF-2. Pat aims Fireball over the fog's edge in Top-down: over the fog it leaves the fog's color but for its outline, the same with the hidden wall and without it, and it shades revealed ground", async () => {
    const spot = await revealedSpot(pat);
    const [bare] = await read(pat, [spot]);
    await aim(pat);
    const [shaded] = await read(pat, [spot]);
    assert.ok(diff(bare!, shaded!) > 10, `the shading shows on revealed ground: ${bare!.join(",")} then ${shaded!.join(",")}`);
    const { spots, misses } = await pairedDiff(pat, "pat-topdown", undefined, true);
    assert.ok(spots > 100, `enough fogged spots read: ${spots}`);
    assert.deepEqual(misses, []);
  });

  test("AF-3. the same in Isometric, at two turns", async () => {
    for (const turn of [0, 1]) {
      await viewAs(pat, "isometric", turn);
      const { spots, misses } = await pairedDiff(pat, `pat-iso-turn-${turn}`, undefined, true);
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

  /**
   * Pat's own preview of a layout in Top-down and Isometric, and the DM's
   * shared one where asked: no pixel of the sphere's box changes with the
   * hidden wall.
   */
  async function layoutCase(layout: Layout, shared: boolean): Promise<void> {
    await setFog(layout);
    await viewAs(pat, "topDown");
    await aim(pat, layout);
    for (const [view, turn] of [["topDown", 0], ["isometric", 0], ["isometric", 1]] as const) {
      await viewAs(pat, view, turn);
      const { spots, misses } = await pairedDiff(pat, `pat-${layout.name}-${view}-${turn}`, layout, true);
      assert.ok(spots > 400, `${view} ${turn}: enough spots read: ${spots}`);
      assert.deepEqual(misses, [], `${view} ${turn}`);
    }
    await viewAs(pat, "topDown");
    await pressSlot(pat, "cancel");
    if (!shared) return;
    const stop = shareFromDm(layout);
    try {
      await sleep(1000);
      for (const view of ["topDown", "isometric"] as const) {
        await viewAs(pat, view);
        const { spots, misses } = await pairedDiff(pat, `pat-${layout.name}-shared-${view}`, layout);
        assert.ok(spots > 400, `shared, ${view}: enough spots read: ${spots}`);
        assert.deepEqual(misses, [], `shared, ${view}`);
      }
    } finally {
      stop();
    }
    await viewAs(pat, "topDown");
  }

  test("AF-6. Pat aims from the fog beside revealed ground, past a wall with a doorway: no pixel changes with the wall, in both views, and the DM's shared preview changes nothing either", async () => {
    await layoutCase(ORIGIN_IN_FOG, true);
  });

  test("AF-7. there a goblin on revealed ground the wall would shade from the origin: Pat's In area line lists it with the wall and without it", async () => {
    await ops.send({
      t: "token.create",
      token: {
        id: run.goblin,
        sceneId: run.sceneId,
        size: "medium",
        visibility: "all",
        kind: "monster",
        name: "Goblin",
        ...GOBLIN_AT,
        disposition: "hostile",
        actor: { inline: ACTOR },
      },
    });
    await setFog(ORIGIN_IN_CELL);
    await waitFor("the goblin on Pat's page", () => patSocket.state?.tokens[run.goblin] ?? null);
    await viewAs(pat, "topDown");
    await aim(pat, ORIGIN_IN_CELL);
    const line = async () => (await options(pat).locator("[data-options-line]").first().textContent()) ?? "";
    for (const on of [true, false]) {
      await setWall(on, ORIGIN_IN_CELL);
      assert.match(await line(), /In area \(1\): Goblin/, `the wall ${on ? "on" : "off"}`);
    }
    await shots.take(pat, "areafog-pat-goblin-listed");
    await pressSlot(pat, "cancel");
    await ops.send({ t: "token.delete", tokenId: run.goblin });
  });

  test("AF-8. Pat aims across a fogged strip at revealed ground beyond it, the wall in the strip: no pixel changes with the wall, in both views", async () => {
    await layoutCase(ACROSS_STRIP, false);
  });

  test("AF-9. revealed to the middle of a cell, a wall in its fogged half: no pixel changes with the wall, in both views", async () => {
    await layoutCase(EDGE_IN_CELL, false);
  });

  test("AF-10. Pat places Fireball from the fog beside revealed ground: no pixel of its box changes with the hidden wall, in Top-down and Isometric, and the Areas panel lists the goblin it catches either way", async () => {
    await setFog(ORIGIN_IN_CELL);
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", ...GOBLIN_AT, disposition: "hostile", actor: { inline: ACTOR } } });
    await waitFor("the goblin on Pat's page", () => patSocket.state?.tokens[run.goblin] ?? null);
    await viewAs(pat, "topDown");
    await aim(pat, ORIGIN_IN_CELL);
    const before = new Set(Object.keys(patSocket.state?.templates ?? {}));
    await pressSlot(pat, "place");
    const placed = await waitFor("the placed Fireball", () => Object.keys(patSocket.state?.templates ?? {}).find((k) => !before.has(k)) ?? null);
    // Nothing picked, so only the placed area draws, under the fog.
    await pressSlot(pat, "done");
    await sleep(500);
    for (const [view, turn] of [["topDown", 0], ["isometric", 0], ["isometric", 1]] as const) {
      await viewAs(pat, view, turn);
      const { spots, misses } = await pairedDiff(pat, `pat-placed-${view}-${turn}`, ORIGIN_IN_CELL);
      assert.ok(spots > 400, `${view} ${turn}: enough spots read: ${spots}`);
      assert.deepEqual(misses, [], `${view} ${turn}`);
    }
    await viewAs(pat, "topDown");
    await openSideTab(pat, "Areas");
    const panel = pat.getByRole("tabpanel", { name: sideTabName("Areas") });
    for (const on of [true, false]) {
      await setWall(on, ORIGIN_IN_CELL);
      assert.match((await panel.textContent()) ?? "", /In area \(1\): Goblin/, `the wall ${on ? "on" : "off"}`);
    }
    await shots.take(pat, "areafog-pat-placed-panel");
    await ops.send({ t: "template.delete", templateId: placed });
    await ops.send({ t: "token.delete", tokenId: run.goblin });
  });

  test("AF-11. Pat drags Bree, whose 30 ft aura reaches across a fogged strip to revealed ground beyond it: while the drag holds, no pixel of its box changes with the wall in the strip, in Top-down and Isometric", async () => {
    await setFog(ACROSS_STRIP);
    await pickTool(pat, "Select");
    const patId = patSocket.you!.memberId;
    const dmId = dmSocket.you!.memberId;
    await ops.send({ t: "token.create", token: { id: run.bree, sceneId: run.sceneId, kind: "monster", name: "Bree", size: "medium", x: 3, y: 5, disposition: "ally", visibility: "all", ownerIds: [patId], actor: { inline: ACTOR } } });
    await ops.send({
      t: "template.create",
      template: { id: run.aura, sceneId: run.sceneId, shape: "emanation", size: 30, origin: { x: 3.5, y: 5.5, z: 0 }, yaw: 0, attachedTo: run.bree, includeOrigin: false, color: "#e5484d", ownerId: dmId, visibility: "all" },
    });
    await waitFor("Bree's aura on Pat's page", () => patSocket.state?.templates[run.aura] ?? null);
    await sleep(500);
    // The box the aura can reach while Bree moves a cell, and the strip's wall.
    const box: Layout = { ...ACROSS_STRIP, name: "aura", origin: { x: 3.5, y: 6 }, size: 40 };
    for (const [view, turn] of [["topDown", 0], ["isometric", 0]] as const) {
      await viewAs(pat, view, turn);
      const at = view === "topDown" ? await pagePoint(pat, BOUNDS, { x: 3.5, y: 5.5 }) : await standeeAt(pat, run.bree);
      await pat.mouse.move(at.x, at.y);
      await pat.mouse.down();
      await pat.mouse.move(at.x, at.y + 10, { steps: 3 });
      await pat.mouse.move(at.x, at.y + 30, { steps: 8 });
      try {
        await sleep(500);
        const { spots, misses } = await pairedDiff(pat, `pat-aura-${view}-${turn}`, box);
        assert.ok(spots > 400, `${view}: enough spots read: ${spots}`);
        assert.deepEqual(misses, [], view);
      } finally {
        await pat.mouse.up();
      }
      await sleep(500);
    }
    await viewAs(pat, "topDown");
  });

  test("AF-12. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
