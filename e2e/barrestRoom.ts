import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, readCamera, reopenRoom, Shots, sleep, SocketWatch, startServer, Touches, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * The resting token bar's room (docs/design-v1-bar-compact.md section 1)
 * and the frame steps' helpers, shared by barrest.e2e.ts and the files
 * that run br-f-5's edge and corner sweep, one pass each, so the CI
 * shards can run them side by side: barrest-edges-pat.e2e.ts,
 * barrest-edges-dm.e2e.ts and barrest-edges-dm-card.e2e.ts. Each file
 * builds its own room in br-0.
 *
 * The room is a 30 x 20 map with Pat's Thorn in its middle, goblins below
 * and right of him, and a token of each size at the edges and corners.
 * The DM and Pat each play from a phone.
 *
 * Every file runs with `pnpm test:e2e` on E2E_PORT plus seven, which it
 * shares with the phone files, since the runs go one after another. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

export const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
export const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

export const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-barrest-"));
export const assetDir = path.join(work, "assets");
export const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** The map, in cells. */
export const BOUNDS = { w: 30, h: 20 };
/** An upright phone, the size the 2 s probes run at. */
export const PHONE = { width: 390, height: 844 };
/** The four phones the design measures, by their window and interface size. */
export const PHONES = [
  { width: 390, height: 844, scale: 1 },
  { width: 375, height: 667, scale: 1 },
  { width: 440, height: 956, scale: 1 },
  { width: 320, height: 568, scale: 1.3 },
] as const;

export let server: Server;
export let browser: Browser;
export let dmContext: BrowserContext;
export let dm: Page;
export let dmCdp: CDPSession;
export let patContext: BrowserContext;
export let pat: Page;
export let patCdp: CDPSession;
export let ops: OpSocket;
export const dmSocket = new SocketWatch("dm");
export const patSocket = new SocketWatch("pat");
export const dmConsole = new ConsoleWatch("dm");
export const patConsole = new ConsoleWatch("pat");

/** A token placed in the room: its id, name, cell and side in cells. */
export type Placed = { id: string; name: string; x: number; y: number; cells: number };
export const placed = (name: string, x: number, y: number, cells = 1): Placed => ({ id: randomUUID(), name, x, y, cells });

export const run = {
  roomId: "",
  roomName: `E2E resting bar ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thorn: { ...placed("Thorn", 15, 10), characterId: randomUUID(), entryId: randomUUID() },
  /** Below and right of Thorn. */
  goblin1: placed("Goblin 1", 17, 12),
  goblin2: placed("Goblin 2", 16, 13),
  /** A token of each size at the map's edges and corners. */
  darkmantle: placed("Darkmantle", 0, 0),
  allosaurus: placed("Allosaurus", 28, 0, 2),
  dragon: placed("Adult Black Dragon", 0, 17, 3),
  ancient: placed("Ancient Black Dragon", 26, 16, 4),
  goblinTop: placed("Goblin Top", 15, 0),
  goblinBottom: placed("Goblin Bottom", 15, 19),
  goblinLeft: placed("Goblin Left", 0, 10),
  goblinRight: placed("Goblin Right", 29, 10),
  /** Objects with no HP: the DM's barrel and Pat's lantern. */
  barrel: placed("Barrel", 12, 8),
  lantern: placed("Lantern", 13, 12),
};

/** The tokens at the edges and corners, which a reach sweep pans into the band above the strip. */
export const EDGE_TOKENS = [run.darkmantle, run.allosaurus, run.dragon, run.ancient, run.goblinTop, run.goblinBottom, run.goblinLeft, run.goblinRight];

export function actor(hp: number, ac = 14) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac,
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

/** Sets a phone's window and interface size, then loads the room again. */
export async function setUp(page: Page, view: { width: number; height: number; scale: number }): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Opens a panel as a sheet from the toolbar's list of panels, as a phone shows them. */
export async function openPanel(page: Page, name: string): Promise<Locator> {
  await page.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true }).click();
  const sheet = page.locator(`section[aria-label="${name}"]`);
  await sheet.waitFor();
  return sheet;
}

/**
 * One file of the resting bar's steps: the server, the DM's and Pat's
 * phones, the room br-0 builds, and then what `steps` registers. A
 * `part` names the file's share after the suite's own name.
 */
export function restFile(part: string | null, steps: () => void): void {
  describe(`raccoon-vtt: the token bar rests on an upright phone (docs/design-v1-bar-compact.md)${part === null ? "" : `: ${part}`}`, { timeout: 900_000 }, () => {
    before(async () => {
      server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
      browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
      dmContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      dm = await dmContext.newPage();
      dmConsole.attach(dm);
      await dmSocket.attach(dmContext, dm);
      dmCdp = await dmContext.newCDPSession(dm);
      patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      pat = await patContext.newPage();
      patConsole.attach(pat);
      await patSocket.attach(patContext, pat);
      patCdp = await patContext.newCDPSession(pat);
    });

    after(async () => {
      if (process.env.E2E_DEBUG === "1") {
        for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

    test("br-0. the DM's room on a 30 x 20 map, Pat's Thorn in its middle, goblins by him and a token of each size at the edges, the DM and Pat on phones", async () => {
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

      // Pat joins from his phone, whose cookies the request shares.
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      run.patId = ((await done.json()) as { member: { id: string } }).member.id;

      const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
      await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
      const token = (t: Placed, extra: Record<string, unknown>) => ({ t: "token.create", token: { id: t.id, sceneId: run.sceneId, name: t.name, x: t.x, y: t.y, size: "medium", visibility: "all", ...extra } });
      const monster = (t: Placed, size: string, hp: number) => ops.send(token(t, { kind: "monster", size, disposition: "hostile", actor: { inline: actor(hp, 15) } }));
      await ops.send(token(run.thorn, { kind: "pc", disposition: "ally", actor: { ref: run.thorn.characterId } }));
      await monster(run.goblin1, "medium", 7);
      await monster(run.goblin2, "medium", 7);
      await monster(run.darkmantle, "small", 22);
      await monster(run.allosaurus, "large", 51);
      await monster(run.dragon, "huge", 195);
      await monster(run.ancient, "gargantuan", 367);
      for (const t of [run.goblinTop, run.goblinBottom, run.goblinLeft, run.goblinRight]) await monster(t, "medium", 7);
      await ops.send(token(run.barrel, { kind: "object", disposition: "neutral", actor: { inline: actor(0, 10) } }));
      await ops.send(token(run.lantern, { kind: "object", size: "small", disposition: "ally", ownerIds: [run.patId], actor: { inline: actor(0, 10) } }));

      await pat.goto(`${server.origin}/r/${run.roomId}`);
      await pat.getByRole("status", { name: "Connected" }).first().waitFor();
      for (const t of [run.thorn, ...EDGE_TOKENS, run.goblin1, run.goblin2, run.barrel, run.lantern]) {
        await waitFor(`${t.name} on Pat's map`, () => patSocket.state?.tokens[t.id]);
        await waitFor(`${t.name} on the DM's map`, () => dmSocket.state?.tokens[t.id]);
      }
      await shots.take(pat, "barrest-room-pat");
    });

    steps();
  });
}

/** The frame steps, br-f: close zoom with Thorn in the middle for each, and the room's own view again after them. */
export function frameSteps(steps: () => void): void {
  describe("br-f: the strip's place, reach and the clearing move", () => {
    before(() => ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { defaultView: { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5, zoom: 44 } } }));
    after(() => ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { defaultView: null } }));
    steps();
  });
}

/** A box as the page drew it, in CSS px from the page's top. */
export type Drawn = { top: number; bottom: number; left: number; right: number };
export type ProbeWin = {
  rvttProbe?: { boxes: (Drawn | null)[]; stop: boolean };
  requestAnimationFrame(fn: () => void): number;
  document: { querySelector(s: string): { getBoundingClientRect(): Drawn } | null };
};
/** Starts reading the bar's box on every animation frame, each new box once, and null while no bar shows. */
export async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as ProbeWin;
    const probe = { boxes: [] as (Drawn | null)[], stop: false, started: false };
    w.rvttProbe = probe;
    const read = () => {
      if (probe.stop) return;
      const r = w.document.querySelector('[role="dialog"][data-bar-mode]')?.getBoundingClientRect();
      const box = r ? { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 } : null;
      const last = probe.boxes[probe.boxes.length - 1];
      // Nothing shown before the bar first draws is the opening's wait, not a gap.
      if (box) probe.started = true;
      const same = last === undefined ? box === null : last === null ? box === null : box !== null && last.top === box.top && last.bottom === box.bottom && last.left === box.left && last.right === box.right;
      if (probe.started && !same) probe.boxes.push(box);
      w.requestAnimationFrame(read);
    };
    read();
  });
}
/** The boxes the probe saw, after it ran `ms` more. */
export async function stopProbe(page: Page, ms = 2_000): Promise<(Drawn | null)[]> {
  await sleep(ms);
  return page.evaluate(() => {
    const w = globalThis as unknown as ProbeWin;
    const probe = w.rvttProbe!;
    probe.stop = true;
    return probe.boxes;
  });
}
/** The map's camera once it has held still for 120 ms, and the canvas's place on the page. */
export async function view(page: Page): Promise<{ cam: { x: number; y: number; scale: number }; box: { x: number; y: number } }> {
  const box = await page.locator(".konvajs-content").first().boundingBox();
  assert.ok(box, "the map canvas is not on the page");
  let cam = await readCamera(page);
  for (let still = 0, i = 0; still < 2 && i < 50; i++) {
    await sleep(60);
    const next = await readCamera(page);
    still = cam && next && next.x === cam.x && next.y === cam.y && next.scale === cam.scale ? still + 1 : 0;
    cam = next;
  }
  assert.ok(cam, "the map stage has no camera");
  return { cam, box };
}
/** A world point, in cells, on the page as the camera stands. */
export const onPage = (v: Awaited<ReturnType<typeof view>>, w: { x: number; y: number }) => ({ x: v.box.x + v.cam.x + w.x * v.cam.scale, y: v.box.y + v.cam.y + w.y * v.cam.scale });
/** The page point of a token's middle. */
export async function middle(page: Page, t: Placed): Promise<{ x: number; y: number }> {
  return onPage(await view(page), { x: t.x + t.cells / 2, y: t.y + t.cells / 2 });
}
export type Rect = { left: number; top: number; right: number; bottom: number };
export async function rectOf(l: Locator): Promise<Rect> {
  const b = await l.boundingBox();
  assert.ok(b, "not on the page");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}
/** The bar's frame, whatever it shows. */
export const frame = (page: Page) => page.locator('[role="dialog"][data-bar-mode]');
/** A token's box on screen, from the camera. */
export async function tokenRect(page: Page, t: Placed): Promise<Rect> {
  const v = await view(page);
  const a = onPage(v, { x: t.x, y: t.y });
  const b = onPage(v, { x: t.x + t.cells, y: t.y + t.cells });
  return { left: a.x, top: a.y, right: b.x, bottom: b.y };
}
/** What takes a tap at a point: the map's canvas, or the tag of whatever covers it. */
export function hitAt(page: Page, p: { x: number; y: number }): Promise<string | null> {
  return page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
}
/** The first of these screen points that falls on an empty cell of the map, clear of every token by a fifth of a cell, or null. */
export async function firstEmpty(page: Page, v: Awaited<ReturnType<typeof view>>, points: readonly { x: number; y: number }[]): Promise<{ x: number; y: number } | null> {
  const all = [run.thorn, run.goblin1, run.goblin2, run.barrel, run.lantern, ...EDGE_TOKENS];
  const clear = points.filter((p) => {
    const w = { x: (p.x - v.box.x - v.cam.x) / v.cam.scale, y: (p.y - v.box.y - v.cam.y) / v.cam.scale };
    return !all.some((t) => w.x > t.x - 0.2 && w.x < t.x + t.cells + 0.2 && w.y > t.y - 0.2 && w.y < t.y + t.cells + 0.6);
  });
  const hits = await page.evaluate(
    (ps) => ps.map((p) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    clear,
  );
  const i = hits.indexOf("CANVAS");
  return i < 0 ? null : clear[i]!;
}
/** Whether a screen point falls on an empty cell of the map, clear of every token by a fifth of a cell. */
export async function emptyAt(page: Page, p: { x: number; y: number }): Promise<boolean> {
  return (await firstEmpty(page, await view(page), [p])) !== null;
}
/**
 * Pans the map with one finger so the world point `w` lands on screen at
 * `to`, in swipes slow enough that no fling follows, each starting on an
 * empty cell so it drags no token. Returns where the point landed, since
 * the camera's bounds may stop it short.
 */
export async function panTo(page: Page, cdp: CDPSession, w: { x: number; y: number }, to: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const size = page.viewportSize()!;
  for (let tries = 0; tries < 8; tries++) {
    const v = await view(page);
    const now = onPage(v, w);
    if (Math.abs(to.x - now.x) < 2 && Math.abs(to.y - now.y) < 2) return now;
    // Each swipe at most 300 px, and on a short screen at most what leaves the finger room to start on the map.
    const reach = { x: Math.min(300, size.width / 2 - 20), y: Math.min(300, size.height / 2 - 40) };
    const d = { x: Math.max(-reach.x, Math.min(reach.x, to.x - now.x)), y: Math.max(-reach.y, Math.min(reach.y, to.y - now.y)) };
    // The finger starts where the move keeps it on the screen, on an empty cell, nearest the middle first.
    const grid: { x: number; y: number }[] = [];
    for (let y = 60; y <= size.height - 60; y += 24) for (let x = 12; x <= size.width - 12; x += 24) if (y + d.y >= 8 && y + d.y <= size.height - 8 && x + d.x >= 8 && x + d.x <= size.width - 8) grid.push({ x, y });
    const mid = { x: size.width / 2 - d.x / 2, y: size.height * 0.45 - d.y / 2 };
    grid.sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y));
    const start = await firstEmpty(page, v, grid);
    assert.ok(start, `no empty cell to start a pan on toward ${JSON.stringify(to)}`);
    const steps = Math.max(12, Math.ceil(Math.hypot(d.x, d.y) / 12));
    await touchSwipe(cdp, start, { x: start.x + d.x, y: start.y + d.y }, { steps, everyMs: 24 });
    const after = await view(page);
    // The camera's bounds stopped it: it lands as near as a pan can.
    if (Math.abs(v.cam.x - after.cam.x) < 1 && Math.abs(v.cam.y - after.cam.y) < 1) return onPage(after, w);
  }
  return onPage(await view(page), w);
}
/**
 * Pans the map by `dy` with two fingers at the window's sides, from a
 * height that keeps them above `floor` the whole way: in Multi-select
 * one finger on the map draws a box that gathers.
 */
export async function panTwo(page: Page, cdp: CDPSession, dy: number, floor: number): Promise<void> {
  const width = page.viewportSize()!.width;
  const y0 = Math.min(floor - 40, floor - 40 - dy);
  const fingers = new Touches(cdp);
  await fingers.start([
    { x: 12, y: y0, id: 1 },
    { x: width - 12, y: y0, id: 2 },
  ]);
  for (let i = 1; i <= 12; i++)
    await fingers.move([
      { x: 12, y: y0 + (dy * i) / 12, id: 1 },
      { x: width - 12, y: y0 + (dy * i) / 12, id: 2 },
    ]);
  await fingers.end();
  await sleep(600);
}
export const bar = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });
/** Puts every token back on its own cell, as a step that dragged one may have left it. */
export async function homeTokens(): Promise<void> {
  for (const t of [run.thorn, ...EDGE_TOKENS, run.goblin1, run.goblin2, run.barrel, run.lantern]) {
    const now = dmSocket.state?.tokens[t.id];
    if (now && (now.x !== t.x || now.y !== t.y)) await ops.send({ t: "token.update", tokenId: t.id, patch: { x: t.x, y: t.y } });
  }
  await waitFor("every token home", () => [run.thorn, ...EDGE_TOKENS].every((t) => patSocket.state?.tokens[t.id]?.x === t.x && patSocket.state?.tokens[t.id]?.y === t.y) || null);
}
/** Taps a token where the map takes the tap, its middle first, and waits for its bar, then gives the bar's box once it holds still. */
export async function openOn(page: Page, t: Placed): Promise<Rect> {
  const r = await tokenRect(page, t);
  const inset = Math.min(6, (r.bottom - r.top) / 4);
  const mid = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  const points = [mid, { x: mid.x, y: r.top + inset }, { x: mid.x, y: r.bottom - inset }, { x: r.left + inset, y: mid.y }, { x: r.right - inset, y: mid.y }];
  let at = mid;
  for (const p of points) {
    if ((await hitAt(page, p)) === "CANVAS") {
      at = p;
      break;
    }
  }
  await page.touchscreen.tap(at.x, at.y);
  try {
    await bar(page, t.name).waitFor({ timeout: 8_000 });
  } catch (err) {
    await shots.take(page, `br-f-open-failed-${t.name.replaceAll(" ", "-")}`);
    throw err;
  }
  return steady(page);
}
/** Opens the first of these tokens whose middle the map takes, so a tap meant for the map never dismisses a toast over a token. */
export async function openClear(page: Page, tokens: readonly Placed[]): Promise<Rect> {
  for (const t of tokens) if ((await hitAt(page, await middle(page, t))) === "CANVAS") return openOn(page, t);
  throw new Error(`none of ${tokens.map((t) => t.name).join(", ")} takes a tap`);
}
/** The bar's box once it has held still for 300 ms. */
export async function steady(page: Page): Promise<Rect> {
  let last = await rectOf(frame(page));
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const now = await rectOf(frame(page));
    if (Math.abs(now.top - last.top) < 0.5 && Math.abs(now.bottom - last.bottom) < 0.5 && i >= 2) return now;
    last = now;
  }
  return last;
}
export type Cam = { x: number; y: number; scale: number };
export type CamWin = { rvttCams?: { cams: Cam[]; stop: boolean }; Konva?: { stages: { x(): number; y(): number; scaleX(): number }[] }; requestAnimationFrame(fn: () => void): number };
/** Starts reading the camera on every animation frame, each new one once. */
export async function startCams(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as CamWin;
    const probe = { cams: [] as Cam[], stop: false };
    w.rvttCams = probe;
    const read = () => {
      if (probe.stop) return;
      const s = w.Konva?.stages[0];
      if (s) {
        const cam = { x: Math.round(s.x() * 10) / 10, y: Math.round(s.y() * 10) / 10, scale: Math.round(s.scaleX() * 1000) / 1000 };
        const last = probe.cams[probe.cams.length - 1];
        if (!last || last.x !== cam.x || last.y !== cam.y || last.scale !== cam.scale) probe.cams.push(cam);
      }
      w.requestAnimationFrame(read);
    };
    read();
  });
}
/** The cameras seen, first the one as it started, after `ms` more. */
export async function stopCams(page: Page, ms = 1_500): Promise<Cam[]> {
  await sleep(ms);
  return page.evaluate(() => {
    const w = globalThis as unknown as CamWin;
    w.rvttCams!.stop = true;
    return w.rvttCams!.cams;
  });
}
/** Whether the map moved one way only, along y, and then held: one clearing move. */
export function oneMoveUp(cams: Cam[]): boolean {
  if (cams.length < 2) return false;
  for (let i = 1; i < cams.length; i++) if (cams[i]!.y > cams[i - 1]!.y + 0.05 || Math.abs(cams[i]!.x - cams[0]!.x) > 0.5 || cams[i]!.scale !== cams[0]!.scale) return false;
  return true;
}
/** The points of a box, every `step` px, where something other than the map's canvas takes a tap. */
export function coveredIn(page: Page, box: Rect, step = 6): Promise<{ x: number; y: number; tag: string }[]> {
  return page.evaluate(
    ([b, s]) => {
      const d = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document;
      const out: { x: number; y: number; tag: string }[] = [];
      for (let y = b.top + 1; y <= b.bottom - 1; y += s)
        for (let x = b.left + 1; x <= b.right - 1; x += s) {
          const tag = d.elementFromPoint(x, y)?.tagName ?? "none";
          if (tag !== "CANVAS") out.push({ x, y, tag });
        }
      return out;
    },
    [box, step] as const,
  );
}
/**
 * What the alerts column draws over a box, though it takes no tap
 * there: each card's part the column's box leaves in view, and the
 * "Scroll for more" fade, whose pointer events are off.
 */
export function columnOver(page: Page, box: Rect): Promise<{ what: string; top: number; bottom: number }[]> {
  return page.evaluate((b) => {
    type El = { tagName: string; textContent: string | null; parentElement: El | null; getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number }; getAttribute(n: string): string | null };
    const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<El> } }).document;
    const out: { what: string; top: number; bottom: number }[] = [];
    const clipOf = (el: El) => {
      let col: El = el;
      while (col.parentElement && col.parentElement.tagName !== "HEADER") col = col.parentElement;
      return col.getBoundingClientRect();
    };
    const meets = (r: { left: number; top: number; right: number; bottom: number }) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
    for (const el of Array.from(d.querySelectorAll("header [data-alert]"))) {
      const r = el.getBoundingClientRect();
      const c = clipOf(el);
      const seen = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
      if (r.width > 0 && seen.bottom - seen.top > 0.5 && meets(seen)) out.push({ what: `card ${el.getAttribute("data-alert")}`, top: seen.top, bottom: seen.bottom });
    }
    for (const el of Array.from(d.querySelectorAll("header div"))) {
      if (el.textContent !== "Scroll for more") continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && meets(r)) out.push({ what: "fade", top: r.top, bottom: r.bottom });
    }
    return out;
  }, box);
}
/** A second socket, Pat's, for what Pat sends while the DM's page is watched. */
export async function patOps(): Promise<OpSocket> {
  const cookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  return OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
}
/** Brings up a concentration check for each of these goblins, which concentrate on Hex from the first call. */
export const hexed = new Set<string>();
export async function checks(goblins: Placed[]): Promise<void> {
  for (const g of goblins) {
    if (!hexed.has(g.id)) {
      await ops.send({ t: "actor.effect.add", target: { tokenId: g.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
      hexed.add(g.id);
    }
    await ops.send({ t: "actor.hp", target: { tokenId: g.id }, change: { kind: "damage", amount: 1 } });
    await ops.send({ t: "actor.hp", target: { tokenId: g.id }, change: { kind: "heal", amount: 1 } });
  }
}
/** The free area's top on a page: 8 px under the top bar, in the page's px. */
export async function freeTop(page: Page, scale: number): Promise<number> {
  const top = await rectOf(page.locator("header").first());
  return top.bottom + 8 * scale;
}

export type EdgePass = "Pat" | "DM" | "DM with a card";

/**
 * br-f-5, one of its passes in a file of its own: every edge and corner
 * token, panned into the band above the strip and tapped, at the four
 * phones, as Pat, as the DM, or as the DM with a concentration card
 * standing.
 */
export function edgeSweepTest(who: EdgePass): void {
  const whom = { Pat: "Pat", DM: "the DM", "DM with a card": "the DM with a concentration card standing" }[who];
  test(`br-f-5. every edge and corner token pans in above the strip and takes a tap, at four phones, for ${whom}`, async () => {
    const missed: string[] = [];
    const page = who === "Pat" ? pat : dm;
    const cdp = who === "Pat" ? patCdp : dmCdp;
    for (const view of PHONES) {
      const label = `${who} at ${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await homeTokens();
      await setUp(page, view);
      if (who === "DM with a card") {
        await checks([run.goblin1]);
        await page.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      }
      const strip = await openOn(page, run.thorn);
      // The middle of the band over the strip, where a token near the map's foot must come to be seen whole.
      const target = { x: (strip.left + strip.right) / 2, y: strip.top - 8 * view.scale - 22 * view.scale };
      for (const t of EDGE_TOKENS) {
        await panTo(page, cdp, { x: t.x + t.cells / 2, y: t.y + t.cells / 2 }, target);
        // A tap anywhere on the token's own cells that the map takes: its middle first.
        const r = await tokenRect(page, t);
        const inset = Math.min(8, (r.bottom - r.top) / 4);
        const points = [
          { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 },
          { x: (r.left + r.right) / 2, y: r.top + inset },
          { x: (r.left + r.right) / 2, y: r.bottom - inset },
          { x: r.left + inset, y: (r.top + r.bottom) / 2 },
          { x: r.right - inset, y: (r.top + r.bottom) / 2 },
        ];
        let at: { x: number; y: number } | null = null;
        for (const p of points) if (p.y < strip.top && (await hitAt(page, p)) === "CANVAS") at = at ?? p;
        if (!at) {
          missed.push(`${label}: ${t.name} at ${JSON.stringify(r)}, nothing of it takes a tap above the strip`);
          continue;
        }
        await page.touchscreen.tap(at.x, at.y);
        try {
          await bar(page, t.name).waitFor({ timeout: 3_000 });
        } catch {
          missed.push(`${label}: a tap at ${JSON.stringify(at)} did not open ${t.name}'s bar`);
          continue;
        }
        const now = await steady(page);
        if (Math.abs(now.top - strip.top) > 0.5 || Math.abs(now.bottom - strip.bottom) > 0.5) missed.push(`${label}: ${t.name}'s strip stands at ${JSON.stringify(now)}, not ${JSON.stringify(strip)}`);
      }
      await shots.take(page, `br-f-5-${who === "Pat" ? "pat" : who === "DM" ? "dm" : "dm-card"}-${view.width}`);
    }
    assert.deepEqual(missed, []);
  });
}
