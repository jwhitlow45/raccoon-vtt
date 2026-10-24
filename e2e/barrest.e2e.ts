import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { barControl, ConsoleWatch, expandBar, multiSelect, OpSocket, pagePoint, pickTool, readCamera, reopenRoom, Shots, sleep, SocketWatch, startServer, Touches, touchSwipe, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * The token action bar at rest on a phone held upright
 * (docs/design-v1-bar-compact.md): a strip at the foot of the map that
 * stays put as the map pans and keeps every token in reach, and Expand,
 * which shows the whole bar.
 *
 * The room is the design's measuring room (section 1): a 30 x 20 map
 * with Pat's Thorn in its middle, goblins below and right of him, and a
 * token of each size at the edges and corners. The DM and Pat each play
 * from a phone. Frame steps carry `br-f-` and content steps `br-c-`.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven, which it shares
 * with the phone files, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-barrest-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** The map, in cells. */
const BOUNDS = { w: 30, h: 20 };
/** An upright phone, the size the 2 s probes run at. */
const PHONE = { width: 390, height: 844 };
/** The four phones the design measures, by their window and interface size. */
const PHONES = [
  { width: 390, height: 844, scale: 1 },
  { width: 375, height: 667, scale: 1 },
  { width: 440, height: 956, scale: 1 },
  { width: 320, height: 568, scale: 1.3 },
] as const;

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let patContext: BrowserContext;
let pat: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

/** A token placed in the room: its id, name, cell and side in cells. */
type Placed = { id: string; name: string; x: number; y: number; cells: number };
const placed = (name: string, x: number, y: number, cells = 1): Placed => ({ id: randomUUID(), name, x, y, cells });

const run = {
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
const EDGE_TOKENS = [run.darkmantle, run.allosaurus, run.dragon, run.ancient, run.goblinTop, run.goblinBottom, run.goblinLeft, run.goblinRight];

function actor(hp: number, ac = 14) {
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
async function setUp(page: Page, view: { width: number; height: number; scale: number }): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Opens a panel as a sheet from the toolbar's list of panels, as a phone shows them. */
async function openPanel(page: Page, name: string): Promise<Locator> {
  await page.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true }).click();
  const sheet = page.locator(`section[aria-label="${name}"]`);
  await sheet.waitFor();
  return sheet;
}

describe("raccoon-vtt: the token bar rests on an upright phone (docs/design-v1-bar-compact.md)", { timeout: 900_000 }, () => {
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

  // ------------------------------------------------------------ br-f: the frame (lane F)

  describe("br-f: the strip's place, reach and the clearing move", () => {
    // Close zoom, Thorn in the middle, for every frame step, and the room's own view again after them.
    before(() => ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { defaultView: { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5, zoom: 44 } } }));
    after(() => ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { defaultView: null } }));
    /** A box as the page drew it, in CSS px from the page's top. */
    type Drawn = { top: number; bottom: number; left: number; right: number };
    type ProbeWin = {
      rvttProbe?: { boxes: (Drawn | null)[]; stop: boolean };
      requestAnimationFrame(fn: () => void): number;
      document: { querySelector(s: string): { getBoundingClientRect(): Drawn } | null };
    };
    /** Starts reading the bar's box on every animation frame, each new box once, and null while no bar shows. */
    async function startProbe(page: Page): Promise<void> {
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
    async function stopProbe(page: Page, ms = 2_000): Promise<(Drawn | null)[]> {
      await sleep(ms);
      return page.evaluate(() => {
        const w = globalThis as unknown as ProbeWin;
        const probe = w.rvttProbe!;
        probe.stop = true;
        return probe.boxes;
      });
    }
    /** The map's camera once it has held still for 120 ms, and the canvas's place on the page. */
    async function view(page: Page): Promise<{ cam: { x: number; y: number; scale: number }; box: { x: number; y: number } }> {
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
    const onPage = (v: Awaited<ReturnType<typeof view>>, w: { x: number; y: number }) => ({ x: v.box.x + v.cam.x + w.x * v.cam.scale, y: v.box.y + v.cam.y + w.y * v.cam.scale });
    /** The page point of a token's middle. */
    async function middle(page: Page, t: Placed): Promise<{ x: number; y: number }> {
      return onPage(await view(page), { x: t.x + t.cells / 2, y: t.y + t.cells / 2 });
    }
    type Rect = { left: number; top: number; right: number; bottom: number };
    async function rectOf(l: Locator): Promise<Rect> {
      const b = await l.boundingBox();
      assert.ok(b, "not on the page");
      return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
    }
    /** The bar's frame, whatever it shows. */
    const frame = (page: Page) => page.locator('[role="dialog"][data-bar-mode]');
    /** A token's box on screen, from the camera. */
    async function tokenRect(page: Page, t: Placed): Promise<Rect> {
      const v = await view(page);
      const a = onPage(v, { x: t.x, y: t.y });
      const b = onPage(v, { x: t.x + t.cells, y: t.y + t.cells });
      return { left: a.x, top: a.y, right: b.x, bottom: b.y };
    }
    /** What takes a tap at a point: the map's canvas, or the tag of whatever covers it. */
    function hitAt(page: Page, p: { x: number; y: number }): Promise<string | null> {
      return page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
    }
    /** The first of these screen points that falls on an empty cell of the map, clear of every token by a fifth of a cell, or null. */
    async function firstEmpty(page: Page, v: Awaited<ReturnType<typeof view>>, points: readonly { x: number; y: number }[]): Promise<{ x: number; y: number } | null> {
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
    async function emptyAt(page: Page, p: { x: number; y: number }): Promise<boolean> {
      return (await firstEmpty(page, await view(page), [p])) !== null;
    }
    /**
     * Pans the map with one finger so the world point `w` lands on screen at
     * `to`, in swipes slow enough that no fling follows, each starting on an
     * empty cell so it drags no token. Returns where the point landed, since
     * the camera's bounds may stop it short.
     */
    async function panTo(page: Page, cdp: CDPSession, w: { x: number; y: number }, to: { x: number; y: number }): Promise<{ x: number; y: number }> {
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
    async function panTwo(page: Page, cdp: CDPSession, dy: number, floor: number): Promise<void> {
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
    const bar = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });
    /** Puts every token back on its own cell, as a step that dragged one may have left it. */
    async function homeTokens(): Promise<void> {
      for (const t of [run.thorn, ...EDGE_TOKENS, run.goblin1, run.goblin2, run.barrel, run.lantern]) {
        const now = dmSocket.state?.tokens[t.id];
        if (now && (now.x !== t.x || now.y !== t.y)) await ops.send({ t: "token.update", tokenId: t.id, patch: { x: t.x, y: t.y } });
      }
      await waitFor("every token home", () => [run.thorn, ...EDGE_TOKENS].every((t) => patSocket.state?.tokens[t.id]?.x === t.x && patSocket.state?.tokens[t.id]?.y === t.y) || null);
    }
    /** Taps a token where the map takes the tap, its middle first, and waits for its bar, then gives the bar's box once it holds still. */
    async function openOn(page: Page, t: Placed): Promise<Rect> {
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
    async function openClear(page: Page, tokens: readonly Placed[]): Promise<Rect> {
      for (const t of tokens) if ((await hitAt(page, await middle(page, t))) === "CANVAS") return openOn(page, t);
      throw new Error(`none of ${tokens.map((t) => t.name).join(", ")} takes a tap`);
    }
    /** The bar's box once it has held still for 300 ms. */
    async function steady(page: Page): Promise<Rect> {
      let last = await rectOf(frame(page));
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        const now = await rectOf(frame(page));
        if (Math.abs(now.top - last.top) < 0.5 && Math.abs(now.bottom - last.bottom) < 0.5 && i >= 2) return now;
        last = now;
      }
      return last;
    }
    type Cam = { x: number; y: number; scale: number };
    type CamWin = { rvttCams?: { cams: Cam[]; stop: boolean }; Konva?: { stages: { x(): number; y(): number; scaleX(): number }[] }; requestAnimationFrame(fn: () => void): number };
    /** Starts reading the camera on every animation frame, each new one once. */
    async function startCams(page: Page): Promise<void> {
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
    async function stopCams(page: Page, ms = 1_500): Promise<Cam[]> {
      await sleep(ms);
      return page.evaluate(() => {
        const w = globalThis as unknown as CamWin;
        w.rvttCams!.stop = true;
        return w.rvttCams!.cams;
      });
    }
    /** Whether the map moved one way only, along y, and then held: one clearing move. */
    function oneMoveUp(cams: Cam[]): boolean {
      if (cams.length < 2) return false;
      for (let i = 1; i < cams.length; i++) if (cams[i]!.y > cams[i - 1]!.y + 0.05 || Math.abs(cams[i]!.x - cams[0]!.x) > 0.5 || cams[i]!.scale !== cams[0]!.scale) return false;
      return true;
    }
    /** The points of a box, every `step` px, where something other than the map's canvas takes a tap. */
    function coveredIn(page: Page, box: Rect, step = 6): Promise<{ x: number; y: number; tag: string }[]> {
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
    function columnOver(page: Page, box: Rect): Promise<{ what: string; top: number; bottom: number }[]> {
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
    async function patOps(): Promise<OpSocket> {
      const cookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      return OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    }
    /** Brings up a concentration check for each of these goblins, which concentrate on Hex from the first call. */
    const hexed = new Set<string>();
    async function checks(goblins: Placed[]): Promise<void> {
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
    async function freeTop(page: Page, scale: number): Promise<number> {
      const top = await rectOf(page.locator("header").first());
      return top.bottom + 8 * scale;
    }

    test("br-f-1. at 390 x 844 the strip opens at 662 to 776 on its first frame, and pans, a pinch and a tap on another token leave its box", async () => {
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { defaultView: { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5, zoom: 44 } } });
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = { top: 662, bottom: 776, left: 8, right: 382 };
      // The swipes and the pinch start on the column right of every token in view, so none drags a token.
      const free = 370;
      const at = await middle(pat, run.thorn);
      const before = await readCamera(pat);
      await startProbe(pat);
      await pat.touchscreen.tap(at.x, at.y);
      await bar(pat, "Thorn").waitFor();
      assert.deepEqual(await stopProbe(pat), [strip], "the strip opened at its place, on its first frame, and stayed");
      assert.deepEqual(await readCamera(pat), before, "Thorn mid-screen: no map move");
      assert.equal(await bar(pat, "Thorn").getAttribute("data-bar-state"), "rest");
      await shots.take(pat, "br-f-1-rest-390");
      // Pans of 120 and 240 px, up and down, and a pinch: the box on every frame is the strip's.
      for (const dy of [-120, 240, -120]) {
        await startProbe(pat);
        await touchSwipe(patCdp, { x: free, y: 300 }, { x: free, y: 300 + dy }, { steps: 12 });
        assert.deepEqual(await stopProbe(pat, 600), [strip], `a pan of ${dy} px moved the strip`);
      }
      await startProbe(pat);
      const touches = new Touches(patCdp);
      await touches.start([
        { x: free, y: 260, id: 1 },
        { x: free, y: 340, id: 2 },
      ]);
      for (let i = 1; i <= 8; i++)
        await touches.move([
          { x: free, y: 260 - i * 6, id: 1 },
          { x: free, y: 340 + i * 6, id: 2 },
        ]);
      await touches.end();
      assert.deepEqual(await stopProbe(pat, 600), [strip], "a pinch moved the strip");
      // A tap on another token shows it in the same strip.
      await setUp(pat, { ...PHONE, scale: 1 });
      const again = await middle(pat, run.thorn);
      await pat.touchscreen.tap(again.x, again.y);
      await bar(pat, "Thorn").waitFor();
      const goblin = await middle(pat, run.goblin1);
      await startProbe(pat);
      await pat.touchscreen.tap(goblin.x, goblin.y);
      await bar(pat, "Goblin 1").waitFor();
      assert.deepEqual(await stopProbe(pat), [strip], "another token's strip stands where Thorn's did");
    });

    test("br-f-3. a whisper keeps above the strip, a stack placed low under the column's card takes its place anew above it as the strip opens, and the column stacks over the strip only where its cards leave the band whole, nothing drawn over the band", async () => {
      await homeTokens();
      // Pat's strip rests, and a whisper keeps above it, 60 px clear of its top.
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      await ops.send({ t: "log.whisper", to: [run.patId], text: "You hear chanting." });
      const whisper = pat.locator("[data-toast]").filter({ hasText: "You hear chanting." }).first();
      await whisper.waitFor();
      const w = await rectOf(whisper);
      assert.ok(w.bottom <= strip.top - 60 + 0.5, `the whisper reaches down to ${w.bottom}, under the strip's top less 60 (${strip.top - 60})`);
      assert.deepEqual(await rectOf(frame(pat)), strip, "the whisper moved the strip");
      await shots.take(pat, "br-f-3-whisper");

      const pats = await patOps();
      try {
        // At 320 x 568 at 130% a toast under the DM's concentration card stands low, past the strip's top less 60, so it takes its place anew as the strip opens.
        const z = 1.3;
        await setUp(dm, { width: 320, height: 568, scale: z });
        await checks([run.goblin1]);
        await dm.locator('[data-alert="concentration"]').first().waitFor();
        await pats.send({ t: "log.whisper", to: [dmSocket.you!.memberId], text: "Behind the altar." });
        const low = dm.locator("[data-toast]").filter({ hasText: "Behind the altar." }).first();
        await low.waitFor();
        const before = await rectOf(low);
        const small = await openClear(dm, [run.thorn, run.lantern, run.goblin2, run.barrel]);
        const floor = small.top - 60 * z;
        assert.ok(before.bottom > floor, `the toast stood at ${before.bottom}, not low: the step tests nothing (floor ${floor})`);
        await sleep(300);
        const after = await rectOf(low);
        assert.ok(after.bottom <= floor + 0.5, `the low toast stays at ${after.bottom}, under the strip's top less 60 (${floor})`);
        await shots.take(dm, "br-f-3-low-anew");
      } finally {
        pats.close();
      }

      // The DM's strip at 390 x 844, then a concentration check: the strip stays, the card stacks over it with the band left, or the summary row stands for it.
      await setUp(dm, { ...PHONE, scale: 1 });
      const dmStrip = await openOn(dm, run.thorn);
      await checks([run.goblin1]);
      await dm.locator('[data-alert="concentration"]').first().waitFor();
      await sleep(300);
      assert.deepEqual(await rectOf(frame(dm)), dmStrip, "a concentration card moved the strip");
      for (const [view, cards] of [
        [{ ...PHONE, scale: 1 }, [run.goblin1, run.goblin2]],
        [{ width: 320, height: 568, scale: 1.3 }, [run.goblin1, run.goblin2]],
      ] as const) {
        const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        await setUp(dm, view);
        await checks([...cards]);
        await dm.locator('[data-alert="concentration"]').nth(1).waitFor({ state: "attached" });
        // With no bar the two cards may stand over Thorn: the first token clear of them opens the strip.
        const s = await openClear(dm, [run.thorn, run.goblin2, run.lantern, run.goblin1, run.barrel]);
        await sleep(300);
        // The band: the 44 px above the strip's own 8 px gap, across the strip.
        const bottom = s.top - 8 * view.scale;
        const band = { left: s.left, right: s.right, top: bottom - 44 * view.scale, bottom };
        assert.deepEqual(await coveredIn(dm, band), [], `${label}: something takes a tap in the band`);
        assert.deepEqual(await columnOver(dm, band), [], `${label}: the column draws over the band`);
        await shots.take(dm, `br-f-3-band-${view.width}`);
      }
    });

    test("br-f-5. every edge and corner token pans in above the strip and takes a tap, at four phones, for Pat and the DM, and for the DM with a concentration card standing", async () => {
      const missed: string[] = [];
      for (const who of ["Pat", "DM", "DM with a card"] as const) {
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
      }
      assert.deepEqual(missed, []);
    });

    test("br-f-6. Fit, Find my token, a tracker row, the party panel and the outliner after Ruler each land their token above the strip, with one clearing move at most", async () => {
      await homeTokens();
      // Pat's Find my token, with Thorn panned under his own strip.
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 195, y: strip.top + 40 });
      await pat.getByRole("button", { name: "Find my token" }).click();
      await sleep(600);
      const found = await tokenRect(pat, run.thorn);
      assert.ok(found.bottom <= strip.top, `Find my token left Thorn under the strip: ${JSON.stringify({ found, strip })}`);

      // The DM's Fit, with Goblin 2's strip open: no token under the strip.
      await setUp(dm, { ...PHONE, scale: 1 });
      const dmStrip = await openOn(dm, run.goblin2);
      await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
      await sleep(600);
      for (const t of [run.thorn, run.goblin1, run.goblin2, ...EDGE_TOKENS]) {
        const r = await tokenRect(dm, t);
        assert.ok(r.bottom <= dmStrip.top + 0.5, `Fit left ${t.name} under the strip: ${JSON.stringify({ r, dmStrip })}`);
      }
      await shots.take(dm, "br-f-6-fit");

      // A tracker row, the party panel and the outliner, each with its token first panned under the strip.
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.goblin1.id, value: 15 },
          { id: randomUUID(), tokenId: run.goblin2.id, value: 12 },
          { id: randomUUID(), tokenId: run.thorn.id, value: 5 },
        ],
      });
      try {
        const opens: { name: string; t: Placed; open(): Promise<void> }[] = [
          {
            name: "a tracker row",
            t: run.goblin2,
            open: async () => {
              const sheet = await openPanel(dm, "Initiative");
              await sheet.getByRole("button", { name: /^Goblin 2/ }).first().click();
            },
          },
          {
            name: "the party panel",
            t: run.thorn,
            open: async () => {
              const sheet = await openPanel(dm, "Party");
              await sheet.getByRole("button", { name: /^Thorn/ }).first().click();
            },
          },
          {
            name: "the outliner after Ruler",
            t: run.goblin1,
            open: async () => {
              await pickTool(dm, "Ruler");
              const sheet = await openPanel(dm, "Outliner");
              await sheet.getByLabel("Search the scene").fill("Goblin 1");
              await sheet.getByRole("button", { name: /^Goblin 1/ }).first().click();
            },
          },
        ];
        for (const o of opens) {
          await setUp(dm, { ...PHONE, scale: 1 });
          const s = await openOn(dm, run.barrel);
          await panTo(dm, dmCdp, { x: o.t.x + 0.5, y: o.t.y + 0.5 }, { x: 195, y: s.top + 40 });
          await o.open();
          await bar(dm, o.t.name).waitFor();
          await sleep(800);
          await startCams(dm);
          const cams = await stopCams(dm, 1_000);
          assert.equal(cams.length, 1, `${o.name}: the map still moves after it landed: ${JSON.stringify(cams)}`);
          const r = await tokenRect(dm, o.t);
          const now = await rectOf(frame(dm));
          assert.ok(r.bottom <= now.top, `${o.name} left ${o.t.name} under the strip: ${JSON.stringify({ r, now })}`);
          await shots.take(dm, `br-f-6-${o.name.replaceAll(" ", "-")}`);
        }
      } finally {
        await ops.send({ t: "encounter.end" });
      }
    });

    test("br-f-7. Expand grows the bar up from the strip's foot and Collapse brings the strip back with focus on Expand, it lasts through another token and a drag, Close ends it, a turn of the phone and back rests, Expand shows only from F = 294, and a stored Larger is removed", async () => {
      await homeTokens();
      await dm.evaluate(() => localStorage.setItem("rvtt.tokenBarLarger", "1"));
      await setUp(dm, { ...PHONE, scale: 1 });
      assert.equal(await dm.evaluate(() => localStorage.getItem("rvtt.tokenBarLarger")), null, "the stored Larger was kept");
      const strip = await openOn(dm, run.thorn);
      const thorn = bar(dm, "Thorn");
      assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "a stored Larger opened the bar expanded");
      await startCams(dm);
      await thorn.getByRole("button", { name: "Expand", exact: true }).click();
      await waitFor("the bar to expand", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
      const big = await steady(dm);
      const cams = await stopCams(dm, 600);
      assert.ok(cams.length <= 2, `Expand moved the map more than once: ${JSON.stringify(cams)}`);
      assert.equal(big.bottom, strip.bottom, "the expanded bar left the strip's foot");
      const h = big.bottom - big.top;
      // Two thirds of 843, the layout's height, caps it: 562 (docs/design-v1-bar-compact.md 5.1).
      assert.ok(h > 114 && h <= 563, `expanded ${h} px`);
      const t = await tokenRect(dm, run.thorn);
      assert.ok(t.bottom <= big.top, `the expanded bar covers Thorn: ${JSON.stringify({ t, big })}`);
      await shots.take(dm, "br-f-7-expanded");

      // A pinch leaves the height.
      const touches = new Touches(dmCdp);
      await touches.start([
        { x: 30, y: 120, id: 1 },
        { x: 30, y: 180, id: 2 },
      ]);
      for (let i = 1; i <= 6; i++)
        await touches.move([
          { x: 30, y: 120 - i * 5, id: 1 },
          { x: 30, y: 180 + i * 5, id: 2 },
        ]);
      await touches.end();
      await sleep(400);
      assert.deepEqual(await rectOf(frame(dm)), big, "a pinch changed the expanded bar");

      // Another token keeps it expanded.
      const goblin = await middle(dm, run.goblin1);
      if (goblin.y < big.top) {
        await dm.touchscreen.tap(goblin.x, goblin.y);
        await bar(dm, "Goblin 1").waitFor();
        assert.equal(await bar(dm, "Goblin 1").getAttribute("data-bar-state"), "expanded", "another token rested the bar");
        await dm.touchscreen.tap((await middle(dm, run.thorn)).x, (await middle(dm, run.thorn)).y);
        await thorn.waitFor();
      }

      // Collapse: the strip, the map unmoved, focus on Expand.
      const before = await readCamera(dm);
      await thorn.getByRole("button", { name: "Collapse", exact: true }).click();
      await waitFor("the bar to rest", async () => ((await thorn.getAttribute("data-bar-state")) === "rest" ? true : null));
      assert.deepEqual(await steady(dm), strip, "Collapse left another box than the strip");
      assert.deepEqual(await readCamera(dm), before, "Collapse moved the map");
      assert.equal(await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute("aria-label") ?? null), "Expand", "focus after Collapse");

      // Close ends it: the next bar rests.
      await thorn.getByRole("button", { name: "Expand", exact: true }).click();
      await waitFor("the bar to expand", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
      await thorn.getByRole("button", { name: /^Close/ }).first().click();
      await thorn.waitFor({ state: "detached" });
      await openOn(dm, run.thorn);
      assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar opened expanded after Close");

      // A turn of the phone with the strip held docks the bar, and back upright it rests again.
      await dm.setViewportSize({ width: 844, height: 390 });
      await sleep(600);
      assert.notEqual(await thorn.getAttribute("data-bar-mode"), "span", "on its side the bar still spans");
      await dm.setViewportSize({ width: 390, height: 844 });
      await waitFor("the strip again", async () => ((await thorn.getAttribute("data-bar-mode")) === "span" && (await thorn.getAttribute("data-bar-state")) === "rest" ? true : null), 5_000);
      assert.equal(await dm.evaluate(() => localStorage.getItem("rvtt.tokenBarLarger")), null, "Expand wrote the stored Larger");

      // Expand is drawn from F = 294, the free area's height, and not at 293. F 210, a 320 x 440 window at 130%, scrolls instead.
      const offered: string[] = [];
      for (const view of [...[418, 419, 420, 421, 422, 423, 424, 425].map((height) => ({ width: 390, height, scale: 1 })), { width: 320, height: 440, scale: 1.3 }]) {
        await setUp(dm, view);
        const s = await openOn(dm, run.thorn);
        const f = Math.round((s.bottom - (await freeTop(dm, view.scale))) / view.scale);
        const expand = await thorn.getByRole("button", { name: "Expand", exact: true }).count();
        const more = await thorn.getByRole("button", { name: "Scroll for more", exact: true }).count();
        offered.push(`F ${f}: ${expand ? "Expand" : more ? "Scroll for more" : "neither"}`);
        assert.equal(expand > 0, f >= 294, `at F ${f} Expand is ${expand ? "" : "not "}drawn`);
        if (view.scale !== 1) assert.ok(more > 0, `at F ${f} the strip offers no Scroll for more`);
        if (f < 294) assert.equal(await thorn.getAttribute("data-bar-state"), more ? "scrolls" : "rest", `at F ${f} the bar is ${await thorn.getAttribute("data-bar-mode")}, ${await thorn.getAttribute("data-bar-state")}`);
      }
      console.log(offered.join(", "));
    });

    test("br-f-8. the clearing move: a token whose label meets the strip moves up once, a Gargantuan as far as its top allows, a drop in the band once, and Ruler then Select, a gathering tap and a Multi-select removal never; a plain tap from a group counts", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      const free = await freeTop(pat, 1);

      // Goblin 2's foot 10 px above the strip: its label meets it, so the tap moves the map up once.
      await panTo(pat, patCdp, { x: run.goblin2.x + 0.5, y: run.goblin2.y + 1 }, { x: 195, y: strip.top - 10 });
      await startCams(pat);
      const g = await middle(pat, run.goblin2);
      await pat.touchscreen.tap(g.x, g.y);
      await bar(pat, "Goblin 2").waitFor();
      const moved = await stopCams(pat);
      assert.ok(oneMoveUp(moved), `not one move up: ${JSON.stringify(moved)}`);
      const cleared = await tokenRect(pat, run.goblin2);
      assert.ok(cleared.bottom + 30 <= strip.top + 0.5, `Goblin 2's label still meets the strip: ${JSON.stringify({ cleared, strip })}`);
      assert.deepEqual(await rectOf(frame(pat)), strip, "the clearing move moved the strip");

      // The Gargantuan low on the screen clears as far as its top stays in the free area.
      await panTo(pat, patCdp, { x: run.ancient.x + 2, y: run.ancient.y + 2 }, { x: 195, y: strip.top - 20 });
      const a = await middle(pat, run.ancient);
      await pat.touchscreen.tap(a.x, Math.min(a.y, strip.top - 10));
      await bar(pat, "Ancient Black Dragon").waitFor();
      await sleep(800);
      const ancient = await tokenRect(pat, run.ancient);
      assert.ok(ancient.top >= free - 1, `the clearing move took the Gargantuan's top out of the free area: ${JSON.stringify({ ancient, free })}`);
      assert.ok(ancient.bottom + 30 <= strip.top + 0.5 || ancient.top <= free + 1, `the Gargantuan neither clears nor stops at its top: ${JSON.stringify(ancient)}`);

      // Ruler, then Select, with the bar open: it comes back with no map move.
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      await openOn(pat, run.thorn);
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 1 }, { x: 195, y: strip.top - 10 });
      const still = await readCamera(pat);
      await pickTool(pat, "Ruler");
      await pickTool(pat, "Select");
      await bar(pat, "Thorn").waitFor();
      await sleep(600);
      assert.deepEqual(await readCamera(pat), still, "Ruler then Select moved the map");
      // A blackout's end with the selection kept: the map comes back at the scene's view, as always, and the bar with it, with no clearing move, though Thorn stands under the strip there.
      await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { x: run.thorn.x, y: run.thorn.y + 5 } });
      await waitFor("Thorn five cells down", () => (patSocket.state?.tokens[run.thorn.id]?.y === run.thorn.y + 5 ? true : null));
      await ops.send({ t: "view.blackout", blackout: true });
      await pat.getByText("The DM has paused the game.").waitFor();
      await ops.send({ t: "view.blackout", blackout: false });
      await bar(pat, "Thorn").waitFor();
      const back = (await view(pat)).cam;
      await sleep(1_000);
      assert.deepEqual((await view(pat)).cam, back, "the map moved after the blackout's end");
      const under = await tokenRect(pat, { ...run.thorn, y: run.thorn.y + 5 });
      assert.ok(under.bottom + 30 > strip.top, `Thorn stood clear of the strip at the scene's view, so the step tests nothing: ${JSON.stringify({ under, strip })}`);
      await homeTokens();

      // A drop in the band: the bar hides for the drag, comes back, and the map moves once to clear it.
      const from = await middle(pat, run.thorn);
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 195, y: 300 });
      const start = await middle(pat, run.thorn);
      await startCams(pat);
      await touchSwipe(patCdp, start, { x: start.x, y: strip.top - 14 }, { steps: 20, everyMs: 24 });
      await bar(pat, "Thorn").waitFor();
      const dropped = await stopCams(pat, 1_500);
      assert.ok(oneMoveUp(dropped), `the drop did not move the map once: ${JSON.stringify(dropped)}`);
      const landed = await tokenRect(pat, run.thorn);
      assert.ok(landed.bottom + 30 <= strip.top + 0.5, `the dropped token's label meets the strip: ${JSON.stringify({ landed, strip, from })}`);
      await homeTokens();

      // The DM's Multi-select: a gathering tap and a removal never move the map, and a plain tap from the group does (review BC-OPUS-37).
      await setUp(dm, { ...PHONE, scale: 1 });
      await openOn(dm, run.thorn);
      // Multi-select is behind Expand on the DM's strip at 390 x 844, and the strip rests again after, lifted by Multi-select's options row.
      await multiSelect(bar(dm, "Thorn"));
      const lifted = await steady(dm);
      // Two fingers pan Goblin 2 just above the strip, its label meeting it.
      await panTwo(dm, dmCdp, lifted.top - 12 - (await middle(dm, run.goblin2)).y, lifted.top);
      const gathered = await readCamera(dm);
      const g2 = await middle(dm, run.goblin2);
      assert.ok(g2.y < lifted.top - 4 && g2.y + 30 > lifted.top, `Goblin 2 does not stand just above the lifted strip, so the taps test nothing: ${JSON.stringify({ g2, lifted })}`);
      await dm.touchscreen.tap(g2.x, g2.y);
      const group = dm.getByRole("dialog", { name: "2 selected tokens" });
      await group.waitFor();
      await sleep(800);
      assert.deepEqual(await readCamera(dm), gathered, "a gathering tap moved the map");
      await dm.touchscreen.tap(g2.x, g2.y);
      await bar(dm, "Thorn").waitFor();
      await sleep(800);
      assert.deepEqual(await readCamera(dm), gathered, "a removal moved the map");
      await dm.touchscreen.tap(g2.x, g2.y);
      await group.waitFor();
      await (await barControl(group, "Multi-select")).click();
      // Its label meeting the bar again, which an Expand for Multi-select may have moved.
      const over = await steady(dm);
      await panTo(dm, dmCdp, { x: run.goblin2.x + 0.5, y: run.goblin2.y + 1 }, { x: 195, y: over.top - 10 });
      const g3 = await middle(dm, run.goblin2);
      await startCams(dm);
      await dm.touchscreen.tap(g3.x, g3.y);
      await bar(dm, "Goblin 2").waitFor();
      const plain = await stopCams(dm);
      assert.ok(oneMoveUp(plain), `a plain tap from the group did not move the map once: ${JSON.stringify(plain)}`);

      // A duplicate with the bar open opens its copy's bar, one request: the map moves once at most.
      const known = new Set(Object.keys(dmSocket.state?.tokens ?? {}));
      await startCams(dm);
      await (await barControl(bar(dm, "Goblin 2"), "Duplicate")).click();
      const copy = await waitFor("the copy", () => Object.keys(dmSocket.state?.tokens ?? {}).find((id) => !known.has(id)) ?? null);
      try {
        await waitFor("the copy's bar", async () => ((await frame(dm).getAttribute("aria-label")) !== "Goblin 2 actions" ? true : null));
        const copied = await stopCams(dm);
        assert.ok(copied.length === 1 || oneMoveUp(copied), `the duplicate moved the map more than once: ${JSON.stringify(copied)}`);
      } finally {
        await ops.send({ t: "token.delete", tokenId: copy });
        // The copy numbered Goblin 2 as its sibling, a number deleting the copy leaves, so the steps after read its name as it was.
        await ops.send({ t: "token.update", tokenId: run.goblin2.id, patch: { number: null } });
      }
      await shots.take(dm, "br-f-8-group-to-token");
    });

    test("br-f-9. a roll card at the foot lifts the strip by its height and back; in a fight with Multi-select at 320 x 568 at 130% it folds into Roll asked under the strip; Roll asked hides the bar and Actions brings it back; a card while expanded scrolls the strip and it expands again after", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const rollAsked = pat.getByRole("button", { name: /^Roll asked/ });
      const asked: string[] = [];
      const ask = async (): Promise<string> => {
        const id = randomUUID();
        asked.push(id);
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        return id;
      };
      const close = (id: string) => ops.send({ t: "roll.close", rollIds: [id] });
      try {
        // 390 x 844: the strip rises by the card's height, stays 114 tall, and comes back down as it goes.
        await setUp(pat, { ...PHONE, scale: 1 });
        const strip = await openOn(pat, run.thorn);
        let id = await ask();
        await card.waitFor();
        const lifted = await steady(pat);
        const c = await rectOf(card);
        assert.equal(Math.round(lifted.bottom - lifted.top), 114, "the strip's height over the card");
        assert.ok(lifted.bottom <= c.top + 0.5, `the strip meets the card: ${JSON.stringify({ lifted, c })}`);
        assert.ok(Math.abs(strip.bottom - lifted.bottom - (c.bottom - c.top)) <= 2, `the strip rose ${strip.bottom - lifted.bottom}, the card is ${c.bottom - c.top} tall`);
        await shots.take(pat, "br-f-9-card-390");
        await close(id);
        await card.waitFor({ state: "detached" });
        assert.deepEqual(await steady(pat), strip, "the strip did not come back down");

        // 320 x 568 at 130%, in a fight with Multi-select on: the card folds into Roll asked, the strip stays and never turns compact, and both come back.
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.goblin1.id, value: 15 },
            { id: randomUUID(), tokenId: run.thorn.id, value: 5 },
          ],
        });
        // The first Next starts the fight, and its turn band shows.
        await ops.send({ t: "encounter.next" });
        try {
          await setUp(pat, { width: 320, height: 568, scale: 1.3 });
          const small = await openOn(pat, run.thorn);
          await (await barControl(bar(pat, "Thorn"), "Multi-select")).click();
          const several = await steady(pat);
          id = await ask();
          await rollAsked.waitFor();
          assert.equal(await card.isVisible(), false, "the card stands under the held strip");
          assert.equal(await frame(pat).getAttribute("data-bar-mode"), "span", "the bar turned compact for the card");
          assert.deepEqual(await steady(pat), several, "the card moved the strip");
          await shots.take(pat, "br-f-9-roll-asked-320");
          await close(id);
          await rollAsked.waitFor({ state: "detached" });
          assert.deepEqual(await steady(pat), several, "the strip moved as the card went");
          assert.ok(small.bottom >= several.bottom, "Multi-select's row lowered the strip");
        } finally {
          await ops.send({ t: "encounter.end" });
        }

        // With no bar the card stands. Thorn's tap then gives the strip, the card folding into Roll asked. The card stands over all but the map's top few px here, so Thorn goes there first, his middle just under the top bar.
        await setUp(pat, { width: 320, height: 568, scale: 1.3 });
        await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 160, y: (await freeTop(pat, 1.3)) + 4 });
        id = await ask();
        await card.waitFor();
        await pat.getByRole("dialog", { name: "The DM asks for a roll" }).getByRole("button", { name: "Later" }).waitFor();
        const m = await middle(pat, run.thorn);
        if (m.y < (await rectOf(card)).top) {
          await pat.touchscreen.tap(m.x, m.y);
          await bar(pat, "Thorn").waitFor();
          assert.equal(await frame(pat).getAttribute("data-bar-mode"), "span", "a card standing opened the bar compact");
          await rollAsked.waitFor();
          // Roll asked hides the bar and keeps Thorn: the card is answered, and Actions brings the strip back.
          await rollAsked.click();
          await card.waitFor();
          await frame(pat).waitFor({ state: "detached" });
          await card.getByLabel("Total Thorn rolled").fill("14");
          await card.getByRole("button", { name: "Send", exact: true }).click();
          await card.waitFor({ state: "detached" });
          // Thorn again, out from under the answer's chip at the top, brings the strip back, the held strip's mode kept.
          await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 160, y: 300 });
          await openOn(pat, run.thorn);
          assert.equal(await frame(pat).getAttribute("data-bar-mode"), "span");
        } else {
          assert.fail(`the card covers Thorn at 320 x 568 at 130%: ${JSON.stringify(m)}`);
        }
        await close(id);

        // 375 x 667, expanded: a card scrolls the strip and keeps expanded, then it expands again, the map unmoved.
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.thorn);
        const thorn = bar(pat, "Thorn");
        await thorn.getByRole("button", { name: "Expand", exact: true }).click();
        await waitFor("the bar to expand", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
        const big = await steady(pat);
        const cam = await readCamera(pat);
        id = await ask();
        await card.waitFor();
        await waitFor("the strip to scroll", async () => ((await thorn.getAttribute("data-bar-state")) === "scrolls" ? true : null));
        await shots.take(pat, "br-f-9-expanded-card-375");
        await close(id);
        await card.waitFor({ state: "detached" });
        await waitFor("the bar to expand again", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
        assert.deepEqual(await steady(pat), big, "the bar came back at another height");
        assert.deepEqual(await readCamera(pat), cam, "the map moved");
      } finally {
        if (asked.length > 0) await ops.send({ t: "roll.close", rollIds: asked });
      }
    });

    test("br-f-10. a compact bar turns into the strip as F reaches 148 and never back, the strip 96 px with its header and quick row whole over a 44 px band, and edge tokens with the summary row showing are panned into the band and tapped", async () => {
      await homeTokens();
      const z = 1.3;
      // 349 px at 130% opens compact, F about 140, and F reaches 148 just past 360 (docs/design-v1-bar-compact.md 3.1, a 320 x 360 window).
      await setUp(pat, { width: 320, height: 349, scale: z });
      await openOn(pat, run.thorn);
      const thorn = bar(pat, "Thorn");
      assert.equal(await thorn.getAttribute("data-bar-mode"), "compact", "F 140 opens compact");
      const cam = await readCamera(pat);
      // The window grows a pixel at a time until F reaches 148, at 360 here, the bars measured as drawn.
      let grown = 360;
      for (; grown <= 368; grown++) {
        await pat.setViewportSize({ width: 320, height: grown });
        await sleep(300);
        if ((await thorn.getAttribute("data-bar-mode")) === "span") break;
      }
      console.log(`br-f-10: the compact bar turned into the strip at 320 x ${grown} at 130%`);
      await waitFor("the strip", async () => ((await thorn.getAttribute("data-bar-mode")) === "span" ? true : null), 3_000);
      const strip = await steady(pat);
      // The map keeps its middle as the window grows, as it always has, and moves no further: no clearing move.
      const now = await readCamera(pat);
      assert.ok(cam && now && now.x === cam.x && Math.abs(now.y - (cam.y + (grown - 349) / 2)) <= 0.5 && now.scale === cam.scale, `turning into the strip moved the map: ${JSON.stringify({ cam, now })}`);
      const free = await freeTop(pat, z);
      const f = (strip.bottom - free) / z;
      assert.ok(f >= 148 && f < 149, `F is ${f}`);
      assert.ok(Math.abs((strip.bottom - strip.top) / z - (f - 52)) <= 1, `the strip is ${(strip.bottom - strip.top) / z} tall at F ${f}`);
      assert.ok(Math.abs((strip.top - 8 * z - free) / z - 44) <= 1.5, `the band is ${(strip.top - 8 * z - free) / z}`);
      // The quick row is the strip's content, checked wherever the strip draws one.
      if ((await thorn.locator("[data-rest-row]").count()) > 0) {
        const row = await rectOf(thorn.locator("[data-rest-row]"));
        assert.ok(row.top >= strip.top && row.bottom <= strip.bottom + 0.5, `the quick row is cut: ${JSON.stringify({ row, strip })}`);
      }
      assert.ok(await wholeInReach(thorn.getByRole("button", { name: /^Close/ }).first()), "the header's Close is cut");
      await shots.take(pat, "br-f-10-strip-148");
      await pat.setViewportSize({ width: 320, height: 349 });
      await sleep(600);
      assert.equal(await thorn.getAttribute("data-bar-mode"), "span", "the strip turned back compact");

      // The DM, a check standing, the summary row in its place: the edge tokens pan into the band and take a tap.
      await setUp(dm, { width: 320, height: grown, scale: z });
      await checks([run.goblin1]);
      await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      // With no bar the card may stand over Thorn: the first token clear of it opens the strip.
      await openClear(dm, [run.thorn, run.goblin2, run.lantern, run.goblin1, run.barrel]);
      for (let h = grown; h <= grown + 8 && (await frame(dm).getAttribute("data-bar-mode")) !== "span"; h++) {
        await dm.setViewportSize({ width: 320, height: h });
        await sleep(300);
      }
      assert.equal(await frame(dm).getAttribute("data-bar-mode"), "span", "the DM's bar never rests as the strip near F 148");
      const s = await steady(dm);
      const target = { x: (s.left + s.right) / 2, y: s.top - 8 * z - 22 * z };
      const missed: string[] = [];
      for (const t of EDGE_TOKENS) {
        await panTo(dm, dmCdp, { x: t.x + t.cells / 2, y: t.y + t.cells / 2 }, target);
        const r = await tokenRect(dm, t);
        const p = { x: Math.max(r.left + 4, Math.min(r.right - 4, target.x)), y: Math.max(r.top + 4, Math.min(r.bottom - 4, target.y)) };
        if ((await hitAt(dm, p)) !== "CANVAS") {
          missed.push(`${t.name}: ${JSON.stringify(p)} is covered`);
          continue;
        }
        await dm.touchscreen.tap(p.x, p.y);
        try {
          await bar(dm, t.name).waitFor({ timeout: 3_000 });
        } catch {
          missed.push(`${t.name}: the tap at ${JSON.stringify(p)} opened nothing`);
        }
      }
      await shots.take(dm, "br-f-10-summary-row-148");
      assert.deepEqual(missed, []);
    });

    test("br-f-11. where the band is under 96, a toast is one 44 px row over the top bar's row clear of End turn and the band; a tap shows it whole with its time held, Close or Escape shrinks it with what it had left, one waiting meanwhile gets its whole time once drawn, and a blackout leaves none stopped. The DM's trap toast takes the row with an error waiting behind it, and both forms, the note and the summary line up within 1 px", async () => {
      await homeTokens();
      const z = 1.3;
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.thorn.id, value: 20 },
          { id: randomUUID(), tokenId: run.goblin1.id, value: 5 },
        ],
      });
      // The first Next starts the fight on Thorn's turn, so End turn stands in the band.
      await ops.send({ t: "encounter.next" });
      try {
        await setUp(pat, { width: 320, height: 440, scale: z });
        const strip = await openOn(pat, run.thorn);
        const rowOf = (text: string | RegExp) => pat.locator('[data-toast-form="row"]').filter({ hasText: text });
        const wholeOf = (text: string | RegExp) => pat.locator('[data-toast-form="whole"]').filter({ hasText: text });
        await ops.send({ t: "log.whisper", to: [run.patId], text: "First whisper." });
        const first = rowOf("First whisper.");
        try {
          await first.waitFor({ timeout: 8_000 });
        } catch (err) {
          await shots.take(pat, "br-f-11-no-row");
          throw err;
        }
        const r = await rectOf(first);
        assert.ok(Math.abs(r.bottom - r.top - 44 * z) <= 1, `the row is ${r.bottom - r.top} tall`);
        const end = await rectOf(pat.getByRole("button", { name: "End turn" }));
        assert.ok(r.bottom <= end.top || r.top >= end.bottom || r.right <= end.left || r.left >= end.right, `the row covers End turn: ${JSON.stringify({ r, end })}`);
        const bottom = strip.top - 8 * z;
        assert.deepEqual(await coveredIn(pat, { left: strip.left, right: strip.right, top: bottom - 44 * z, bottom }), [], "something stands in the band");
        await shots.take(pat, "br-f-11-row");

        // Shown whole, its time stops: it outlasts its 5 s, and a whisper that comes meanwhile waits undrawn.
        await first.getByRole("button").first().click();
        await wholeOf("First whisper.").waitFor();
        await ops.send({ t: "log.whisper", to: [run.patId], text: "Second whisper." });
        await sleep(6_000);
        assert.equal(await wholeOf("First whisper.").count(), 1, "the whole toast ran out while shown whole");
        const second = rowOf("Second whisper.");
        assert.equal(await pat.locator("[data-toast]").filter({ hasText: "Second whisper." }).count(), 0, "the whisper that came meanwhile was drawn");
        await shots.take(pat, "br-f-11-whole");
        // Escape shrinks it, and the one that waited takes the row, its time starting as it draws (docs/design-v1-bar-compact.md 3.5).
        await pat.keyboard.press("Escape");
        await second.waitFor({ timeout: 2_000 });
        await sleep(3_500);
        assert.equal(await second.count(), 1, "the waiting whisper ran out before its time");
        // Close shrinks it as Escape does, its time held while whole and running on after.
        await second.getByRole("button").first().click();
        await wholeOf("Second whisper.").getByRole("button", { name: "Close", exact: true }).click();
        await second.waitFor();
        await second.waitFor({ state: "detached", timeout: 6_000 });
        // A blackout while one shows whole leaves nothing stopped after it (review BARBUILD-ASTRA-04): an error, which no fit drops, Pat's undo of a nudge to Thorn, whom the DM has moved since.
        await pat.keyboard.press("ArrowRight");
        await waitFor("Thorn a square right", () => (patSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x + 1 ? true : null));
        await ops.send({ t: "token.move", tokenId: run.thorn.id, x: run.thorn.x, y: run.thorn.y });
        await waitFor("Thorn back on his square", () => (patSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x ? true : null));
        await pat.keyboard.press("Control+z");
        const refused = rowOf(/ since\./);
        await refused.waitFor({ timeout: 4_000 });
        await refused.getByRole("button").first().click();
        await wholeOf(/ since\./).waitFor();
        await ops.send({ t: "view.blackout", blackout: true });
        await pat.getByText("The DM has paused the game.").waitFor();
        await ops.send({ t: "view.blackout", blackout: false });
        await pat.getByText("The DM has paused the game.").waitFor({ state: "detached" });
        await pat.locator("[data-toast]").filter({ hasText: / since\./ }).waitFor({ state: "detached", timeout: 8_000 });

        // The DM at the same size on Thorn's turn: an error waits behind a trap's toast, which takes the row with Save and damage, and each form, the strip's note and the alerts' summary line up within 1 px (review BB-OPUS-5).
        await setUp(dm, { width: 320, height: 440, scale: z });
        await openOn(dm, run.thorn);
        const dmRow = (text: string | RegExp) => dm.locator('[data-toast-form="row"]').filter({ hasText: text });
        const lined = async (root: Locator, what: string) => assert.deepEqual(alignmentLines(await measureAlignment(root), `${what} at 320 x 440 at 130%`), []);
        // The error: the DM's undo of a nudge to Thorn, whom Pat has moved since, is refused, and the log never sees it.
        await dm.keyboard.press("ArrowRight");
        await waitFor("Thorn a square right", () => (dmSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x + 1 ? true : null));
        const pats = await patOps();
        try {
          await pats.send({ t: "token.move", tokenId: run.thorn.id, x: run.thorn.x, y: run.thorn.y });
        } finally {
          pats.close();
        }
        await waitFor("Thorn back on his square", () => (dmSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x ? true : null));
        await dm.keyboard.press("Control+z");
        const error = dmRow(/ since\./);
        await error.waitFor({ timeout: 4_000 });
        const trapId = randomUUID();
        const walker = randomUUID();
        const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
        await ops.send({ t: "token.create", token: { id: walker, sceneId: run.sceneId, kind: "monster", name: "Scout", x: 1, y: 4, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: actor(7, 15) } } });
        await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Needle Plate", zone: { cells: [{ x: 1, y: 1, w: 1, h: 1 }] }, rig } });
        try {
          await waitFor("the scout and the trap in the DM's view", () => (dmSocket.state?.tokens[walker] && dmSocket.state.traps[trapId] ? true : null));
          await ops.send({ t: "token.move", tokenId: walker, x: 1, y: 1 });
          const trap = dmRow("Needle Plate went off: Scout.");
          await trap.waitFor();
          assert.equal(await dm.locator("[data-toast]").filter({ hasText: / since\./ }).count(), 0, "the error showed beside the trap's toast");
          assert.ok(await wholeInReach(trap.getByRole("button", { name: "Save and damage", exact: true })), "the row's Save and damage is out of reach");
          await lined(trap, "the trap's toast as the row");
          await shots.take(dm, "br-f-11-dm-trap-row");
          await trap.getByRole("button").first().click();
          const whole = dm.locator('[data-toast-form="whole"]').filter({ hasText: "Needle Plate went off: Scout." });
          await whole.waitFor();
          await lined(whole, "the trap's toast whole");
          await shots.take(dm, "br-f-11-dm-trap-whole");
          // Its words dismiss it, and the error that waited takes the row.
          await whole.getByRole("button", { name: "Needle Plate went off: Scout.", exact: true }).click();
          await whole.waitFor({ state: "detached" });
          await error.waitFor({ timeout: 2_000 });
          await lined(error, "the error as the row");
          await shots.take(dm, "br-f-11-dm-error-row");
          // The trap's card stands as the alerts' summary, risen or in the strip's header.
          const header = frame(dm).locator("[data-rest-summary]");
          if ((await header.count()) > 0) await lined(header, "the header's summary button");
          else await lined(dm.getByRole("button", { name: /^Needle Plate/ }).first(), "the risen summary row");
          // The strip's note: a dead goblin's heal line, too long for the title here (3.3).
          await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "dead" });
          await ops.send({ t: "room.update", settings: { healRevives: false } });
          try {
            await bar(dm, "Thorn").getByRole("button", { name: "Close", exact: true }).first().click();
            await panTo(dm, dmCdp, { x: run.goblin2.x + 0.5, y: run.goblin2.y + 0.5 }, { x: 160, y: (await freeTop(dm, z)) + 70 });
            await openOn(dm, run.goblin2);
            const goblin = bar(dm, "Goblin 2");
            await goblin.locator("[data-rest-row] [data-rest-mode]").click();
            const note = goblin.locator("[data-rest-note]");
            await note.waitFor();
            await lined(note, "the strip's note");
            await shots.take(dm, "br-f-11-dm-note");
          } finally {
            await ops.send({ t: "room.update", settings: { healRevives: true } });
            await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "alive" });
          }
        } finally {
          for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
          await ops.send({ t: "trap.delete", trapId });
          await ops.send({ t: "token.delete", tokenId: walker });
          await waitFor("the scout and the trap gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] && !dmSocket.state.tokens[walker] ? true : null));
        }
      } finally {
        await ops.send({ t: "encounter.end" });
      }
    });
    test("br-f-12. nothing clips a quick row control's focus ring, the 4 px past it that its 2 px outline and 2 px offset take, the row runs out of nothing sideways, and it lines up within 1 px, at 390 x 844 and 320 x 568 at 130%", async (t) => {
      await homeTokens();
      for (const view of [
        { ...PHONE, scale: 1 },
        { width: 320, height: 568, scale: 1.3 },
      ]) {
        const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        await setUp(pat, view);
        await openOn(pat, run.thorn);
        const row = frame(pat).locator("[data-rest-row]");
        if ((await row.count()) === 0) {
          // The quick row is the strip's content (the content lane's), drawn once it stands on this frame.
          t.skip("no quick row in the strip");
          return;
        }
        const cut = await row.evaluate((el, ring) => {
          type R = { left: number; top: number; right: number; bottom: number };
          type S = { overflowX: string; overflowY: string; clipPath: string };
          type E = {
            getBoundingClientRect(): R & { width: number };
            offsetWidth: number;
            scrollWidth: number;
            clientWidth: number;
            parentElement: E | null;
            matches(s: string): boolean;
            querySelectorAll(s: string): ArrayLike<E>;
            getAttribute(n: string): string | null;
            textContent: string | null;
          };
          const view = globalThis as unknown as { getComputedStyle(e: E): S };
          const box = el as unknown as E;
          const zoom = box.offsetWidth > 0 ? box.getBoundingClientRect().width / box.offsetWidth : 1;
          const reach = ring * zoom;
          // What clips the row's controls, from the row up to the bar's frame: a box that clips what overflows it, and a clip path, grown by its inset.
          const clips: { by: string; r: R }[] = [];
          for (let a: E | null = box; a && !a.matches('[role="dialog"]'); a = a.parentElement) {
            const cs = view.getComputedStyle(a);
            const r = a.getBoundingClientRect();
            if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clips.push({ by: "overflow", r });
            const inset = /^inset\((-?[\d.]+)px\)$/.exec(cs.clipPath);
            const grow = inset ? -Number(inset[1]) * zoom : 0;
            if (cs.clipPath !== "none") clips.push({ by: `clip path ${cs.clipPath}`, r: { left: r.left - grow, top: r.top - grow, right: r.right + grow, bottom: r.bottom + grow } });
          }
          const out: string[] = [];
          for (const c of Array.from(box.querySelectorAll("[data-rest-shown] :is(button, input, a[href], [tabindex]:not([tabindex='-1']))"))) {
            const b = c.getBoundingClientRect();
            if (b.width === 0) continue;
            for (const { by, r } of clips) {
              if (b.left - reach < r.left - 0.5 || b.right + reach > r.right + 0.5 || b.top - reach < r.top - 0.5 || b.bottom + reach > r.bottom + 0.5)
                out.push(`${c.getAttribute("aria-label") ?? c.textContent ?? "?"}: ${JSON.stringify(b)} cut by the ${by} of ${JSON.stringify(r)}`);
            }
          }
          // Nor does the row run out of its parent sideways, which a box that scrolls would show.
          const parent = box.parentElement;
          if (parent && parent.scrollWidth > parent.clientWidth + 1) out.push(`the row's parent runs over: ${parent.scrollWidth} > ${parent.clientWidth}`);
          return out;
        }, 4);
        assert.deepEqual(cut, [], `${label}: the row clips these controls' focus rings`);
        assert.deepEqual(alignmentLines(await measureAlignment(row), `${label} the quick row`), []);
        await shots.take(pat, `br-f-12-row-${view.width}`);
      }
    });

    test("br-f-13. a toast showing as a turn starts goes under the card the turn brings, a death save card here, so none of the card is under it (review LP20-CC-2)", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const thorn = { characterId: run.thorn.characterId };
      await ops.send({ t: "actor.hp", target: thorn, change: { kind: "damage", amount: 30 } });
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.goblin1.id, value: 15 },
          { id: randomUUID(), tokenId: run.thorn.id, value: 5 },
        ],
      });
      // The first Next starts the fight on the goblin's turn, where Pat's column shows no card.
      await ops.send({ t: "encounter.next" });
      try {
        await ops.send({ t: "log.whisper", to: [run.patId], text: "A cold draft." });
        const toast = pat.locator("[data-toast]").filter({ hasText: "A cold draft." }).first();
        await toast.waitFor();
        await ops.send({ t: "encounter.next" });
        const card = pat.getByRole("group", { name: "Death save for Thorn", exact: true }).first();
        await card.waitFor();
        await sleep(800);
        assert.ok(await toast.isVisible(), "the toast went before the card came");
        const t = await rectOf(toast);
        const c = await rectOf(card);
        assert.ok(t.top >= c.bottom - 0.5, `the toast lies over the death save card: ${JSON.stringify({ toast: t, card: c })}`);
        await shots.take(pat, "br-f-13-toast-under-card");
      } finally {
        await ops.send({ t: "encounter.end" });
        await ops.send({ t: "actor.hp", target: thorn, change: { kind: "heal", amount: 30 } });
      }
    });

    test("br-f-14. Multi-select turned on in an expanded bar rests it with no map move, so the map under it is free, and turned off in a group's expanded bar leaves it expanded (D-261024-22)", async () => {
      await homeTokens();
      await setUp(dm, { ...PHONE, scale: 1 });
      await openOn(dm, run.thorn);
      const thorn = bar(dm, "Thorn");
      await expandBar(thorn);
      assert.equal(await thorn.getAttribute("data-bar-state"), "expanded", "Thorn's bar did not expand");
      const cam = await readCamera(dm);
      await thorn.getByRole("button", { name: "Multi-select", exact: true }).click();
      await dm.getByRole("toolbar", { name: "Select options" }).waitFor();
      await waitFor("Thorn's bar to rest", async () => ((await thorn.getAttribute("data-bar-state")) === "rest" ? true : null), 3_000);
      await sleep(400);
      assert.deepEqual(await readCamera(dm), cam, "the rest moved the map");
      await shots.take(dm, "br-f-14-token-rests");

      // Goblin 1 gathered where the map shows it, then the group's bar expanded and Multi-select turned off there.
      const strip = await steady(dm);
      await panTwo(dm, dmCdp, strip.top - 150 - (await middle(dm, run.goblin1)).y, strip.top);
      const g1 = await middle(dm, run.goblin1);
      await dm.touchscreen.tap(g1.x, g1.y);
      const group = dm.getByRole("dialog", { name: "2 selected tokens" });
      await group.waitFor();
      assert.equal(await group.getAttribute("data-bar-state"), "rest", "the group's bar opened expanded");
      await expandBar(group);
      assert.equal(await group.getAttribute("data-bar-state"), "expanded", "the group's bar did not expand");
      await group.getByRole("button", { name: "Multi-select", exact: true }).click();
      await waitFor("Multi-select off", async () => ((await dm.getByRole("toolbar", { name: "Select options" }).count()) === 0 ? true : null), 3_000);
      await sleep(400);
      assert.equal(await group.getAttribute("data-bar-state"), "expanded", "turning Multi-select off rested the group's bar");
      await shots.take(dm, "br-f-14-group-stays");
      await group.getByRole("button", { name: "Deselect all", exact: true }).first().click();
    });

    test("br-f-15. with the bar expanded over its token, Ruler then Select, a blackout's end and a fold's return move no map (D-261024-22)", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      await openOn(pat, run.thorn);
      const thorn = bar(pat, "Thorn");
      // Expanded, with Thorn panned under its cover, so a clearing move would show.
      const underCover = async (): Promise<{ x: number; y: number; scale: number }> => {
        await expandBar(thorn);
        const big = await steady(pat);
        await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 195, y: big.top + 40 });
        assert.equal(await thorn.getAttribute("data-bar-state"), "expanded", "the bar is not expanded");
        return (await view(pat)).cam;
      };

      // Ruler, then Select: the bar closes and comes back resting, with no map move.
      const ruled = await underCover();
      await pickTool(pat, "Ruler");
      await pickTool(pat, "Select");
      await thorn.waitFor();
      await sleep(600);
      assert.deepEqual((await view(pat)).cam, ruled, "Ruler then Select moved the map");

      // A blackout's end: the map comes back at the scene's view, as always, and nothing moves it after.
      await underCover();
      await ops.send({ t: "view.blackout", blackout: true });
      await pat.getByText("The DM has paused the game.").waitFor();
      await ops.send({ t: "view.blackout", blackout: false });
      await thorn.waitFor();
      const back = (await view(pat)).cam;
      await sleep(1_000);
      assert.deepEqual((await view(pat)).cam, back, "the map moved after the blackout's end");

      // A fold's return: Panels folds the bar onto its sheet's top edge, and as the sheet closes the bar comes back expanded, the map where it stood.
      const folded = await underCover();
      await pat.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
      await pat.getByRole("region", { name: "Panels" }).waitFor();
      await pat.keyboard.press("Escape");
      await pat.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
      await thorn.waitFor();
      await sleep(600);
      assert.equal(await thorn.getAttribute("data-bar-state"), "expanded", "the fold's return rested the bar");
      assert.deepEqual((await view(pat)).cam, folded, "the fold's return moved the map");
      await shots.take(pat, "br-f-15-fold-return");
      await thorn.getByRole("button", { name: /^Close/ }).first().click();
    });

    test("br-f-16. a refusal in the scrolling strip brings its header and quick row into view as it comes, and a scroll down after it holds (5.4, review BB-OPUS-1)", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const id = randomUUID();
      const refusal = "You can only deal damage to or heal this creature.";
      await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
      try {
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.goblin1);
        const goblin = bar(pat, "Goblin 1");
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await card.waitFor();
        await waitFor("the strip to scroll", async () => ((await goblin.getAttribute("data-bar-state")) === "scrolls" ? true : null));
        const scroller = goblin.locator("[data-bar-scroll]");
        const field = goblin.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" });
        await field.fill("=20");
        await waitFor("the refusal", async () => ((await goblin.locator("[data-rest-status]").first().getAttribute("data-rest-sentence")) === refusal ? true : null));
        assert.equal(await scroller.evaluate((el) => el.scrollTop), 0, "the strip is not at its top as the refusal shows");
        // The viewer scrolls down with the refusal still showing, and the strip stays where they put it through the renders that follow.
        const down = await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollTop;
        });
        assert.ok(down > 0, "the strip has nothing to scroll");
        await sleep(800);
        assert.equal(await scroller.evaluate((el) => el.scrollTop), down, "the strip went back to its top while the refusal showed");
        await shots.take(pat, "br-f-16-refusal-scrolled");
        await field.fill("");
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
      }
    });

    test("br-f-17. a drawer opened from the strip stays open as a roll card turns the expanded bar into the scrolling strip and back, and closed meanwhile, by either button, it rests the bar once the card goes (5.3, 5.4, review BB-OPUS-4)", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const asked: string[] = [];
      const ask = async () => {
        const id = randomUUID();
        asked.push(id);
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await card.waitFor();
      };
      const answered = async () => {
        await ops.send({ t: "roll.close", rollIds: [asked[asked.length - 1]!] });
        await card.waitFor({ state: "detached" });
      };
      const thorn = bar(pat, "Thorn");
      const state = (s: string) => waitFor(`the bar's state ${s}`, async () => ((await thorn.getAttribute("data-bar-state")) === s ? true : null), 5_000);
      const drawer = thorn.getByRole("group", { name: "Conditions" });
      const fromRest = thorn.locator("[data-rest-row]").getByRole("button", { name: "Conditions", exact: true });
      try {
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.thorn);
        await fromRest.tap();
        await drawer.waitFor();
        await state("expanded");
        // The card turns the expanded bar into the scrolling strip with its state kept, the drawer open, and the bar expands again as the card goes.
        await ask();
        await state("scrolls");
        assert.equal(await drawer.count(), 1, "the card closed the drawer");
        await answered();
        await state("expanded");
        assert.equal(await drawer.count(), 1, "the drawer closed as the bar expanded again");
        // Closed during the card by the last Conditions the strip draws, the body's where it shows one: the bar rests once the card goes.
        await ask();
        await state("scrolls");
        await thorn.getByRole("button", { name: "Conditions", exact: true }).last().tap();
        await drawer.waitFor({ state: "detached" });
        await answered();
        await sleep(600);
        assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar expanded again with its drawer closed");
        // And by the strip's own Conditions.
        await fromRest.tap();
        await drawer.waitFor();
        await state("expanded");
        await ask();
        await state("scrolls");
        await fromRest.tap();
        await drawer.waitFor({ state: "detached" });
        await answered();
        await sleep(600);
        assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar expanded again after the strip's Conditions closed its drawer");
        await shots.take(pat, "br-f-17-drawer-closed-rests");
      } finally {
        if (asked.length > 0) await ops.send({ t: "roll.close", rollIds: asked });
      }
    });

    test("br-f-18. an arrow-key nudge under the strip moves no map, and a finger down on the map before the bar clears its token cancels the clearing move (3.6, review BB-OPUS-5)", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      const cam = (await view(pat)).cam;
      // Each press moves Thorn a square down as a drop does, until his label meets the strip, and the map stays.
      const home = await tokenRect(pat, run.thorn);
      const squares = Math.ceil((strip.top - (home.bottom + 34)) / cam.scale) + 1;
      for (let i = 1; i <= squares; i++) {
        await pat.keyboard.press("ArrowDown");
        await waitFor(`Thorn ${i} squares down`, () => (patSocket.state?.tokens[run.thorn.id]?.y === run.thorn.y + i ? true : null));
      }
      await sleep(800);
      assert.deepEqual((await view(pat)).cam, cam, "a nudge moved the map");
      const nudged = await tokenRect(pat, { ...run.thorn, y: run.thorn.y + squares });
      assert.ok(nudged.bottom + 34 > strip.top, `the nudges left Thorn's label clear of the strip: ${JSON.stringify({ nudged, strip })}`);
      await shots.take(pat, "br-f-18-nudged-under");
      await bar(pat, "Thorn").getByRole("button", { name: "Close", exact: true }).first().click();
      await bar(pat, "Thorn").waitFor({ state: "detached" });
      await homeTokens();

      // The frame holds the opening's request 2.5 s by the run's hook, and a pan's first touch, sideways above the strip, cancels it there.
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: PHONE.width / 2, y: strip.top + 30 });
      await pat.evaluate(() => {
        (globalThis as { rvttClearWaitMs?: number }).rvttClearWaitMs = 2_500;
      });
      try {
        const m = await middle(pat, run.thorn);
        assert.equal(await hitAt(pat, m), "CANVAS", "Thorn is under something");
        const v = await view(pat);
        const starts: { x: number; y: number }[] = [];
        for (let y = 200; y <= strip.top - 120; y += 24) for (let x = 24; x <= 140; x += 24) starts.push({ x, y });
        const start = await firstEmpty(pat, v, starts);
        assert.ok(start, "no empty cell to start the pan on");
        await pat.touchscreen.tap(m.x, m.y);
        await bar(pat, "Thorn").waitFor();
        const opened = await readCamera(pat);
        await touchSwipe(patCdp, start, { x: start.x + 80, y: start.y }, { steps: 10, everyMs: 16 });
        const panned = (await view(pat)).cam;
        assert.notDeepEqual(panned, opened, "the pan moved nothing");
        await sleep(3_000);
        assert.deepEqual((await view(pat)).cam, panned, "the clearing move ran after the viewer's own pan");
        assert.equal(await frame(pat).getAttribute("data-bar-state"), "rest");
        await shots.take(pat, "br-f-18-pan-cancels");
      } finally {
        await pat.evaluate(() => {
          delete (globalThis as { rvttClearWaitMs?: number }).rvttClearWaitMs;
        });
      }
    });

    test("br-f-19. a strip opened before a turn band and Multi-select's row take F under 146 at 320 x 480 at 130% stays a strip, 94 px (3.1, review BB-OPUS-6)", async () => {
      await homeTokens();
      const z = 1.3;
      const thorn = bar(pat, "Thorn");
      await patCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
      try {
        await setUp(pat, { width: 320, height: 480, scale: z });
        const opened = await openOn(pat, run.thorn);
        assert.equal(await thorn.getAttribute("data-bar-mode"), "span", "no strip opened before the band");
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.thorn.id, value: 20 },
            { id: randomUUID(), tokenId: run.goblin1.id, value: 5 },
          ],
        });
        // The first Next starts the fight on Thorn's turn, so End turn stands in the band.
        await ops.send({ t: "encounter.next" });
        try {
          await pat.getByRole("button", { name: "End turn" }).waitFor();
          await (await barControl(thorn, "Multi-select")).click();
          await pat.getByRole("toolbar", { name: "Select options" }).waitFor();
          const held = await steady(pat);
          assert.equal(await thorn.getAttribute("data-bar-mode"), "span", "the strip turned compact");
          const tall = (held.bottom - held.top) / z;
          assert.ok(Math.abs(tall - 94) <= 0.5, `the held strip is ${tall} tall, opened at ${(opened.bottom - opened.top) / z}`);
          await shots.take(pat, "br-f-19-held-94");
          await pat.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Done", exact: true }).click();
        } finally {
          await ops.send({ t: "encounter.end" });
        }
      } finally {
        await patCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
      }
    });
  });

  // ------------------------------------------------------------ br-c: the content (the content lane)

  describe("br-c: the strip's header, HP entry and quick row", () => {
    // Imported here, so the content's steps touch no line of the file's own setup.
    type Locator = import("playwright-core").Locator;
    const harness = () => import("./harness.ts");
    // The fit rule itself, by a path the server's typecheck does not follow: it covers e2e and stops at the client's JSX.
    const STRIP: string = "../client/canvas/barButtons.ts";
    const strip = async () => (await import(STRIP)) as { restFit(widths: Readonly<Record<string, number>>, room: number, gap: number, fieldMin: number): string[] };
    const alignment = () => import("./helpers/alignment.ts");

    /** The little of the page's DOM the in-page measures use, since e2e has no DOM types. */
    type PageBox = { left: number; right: number; width: number };
    type PageEl = {
      dataset: Record<string, string | undefined>;
      firstElementChild: PageEl | null;
      style: { flex: string; cssText: string };
      offsetWidth: number;
      textContent: string | null;
      cloneNode(deep: boolean): PageEl;
      querySelector(selector: string): PageEl | null;
      querySelectorAll(selector: string): Iterable<PageEl>;
      closest(selector: string): PageEl | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): PageBox;
      append(node: PageEl): void;
      replaceChildren(...nodes: PageEl[]): void;
      remove(): void;
    };
    type PageGlobals = { document: { createElement(tag: string): PageEl; activeElement: PageEl | null }; getComputedStyle(el: PageEl): { columnGap: string; visibility: string; paddingLeft: string; paddingRight: string } };

    /** A token's bar, by its frame's name. */
    const barOf = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });
    const socketOf = (page: Page) => (page === dm ? dmSocket : patSocket);

    /** Closes whatever bar is open, so the next tap lands on the map. */
    async function closeBars(page: Page): Promise<void> {
      for (const name of ["Close", "Deselect all"]) {
        const close = page.locator('[role="dialog"]').getByRole("button", { name, exact: true });
        if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().tap();
      }
      await waitFor("no bar open", async () => (await page.locator('[role="dialog"][aria-label$="actions"], [role="dialog"][aria-label$="selected tokens"]').count()) === 0);
    }

    /** Taps a token's middle on the map, where it stands now, and waits for a bar named `bar`. */
    async function tapToken(page: Page, t: Placed, bar = `${t.name} actions`): Promise<Locator> {
      const { pagePoint } = await harness();
      const now = socketOf(page).state!.tokens[t.id]!;
      const cells = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 }[now.size as string] ?? 1;
      const p = await pagePoint(page, BOUNDS, { x: now.x + cells / 2, y: now.y + cells / 2 });
      await page.touchscreen.tap(p.x, p.y);
      const frame = page.getByRole("dialog", { name: bar });
      await frame.waitFor();
      return frame;
    }

    /** Opens a token's bar afresh, as a viewer's tap does. */
    async function openBar(page: Page, t: Placed): Promise<Locator> {
      await closeBars(page);
      return tapToken(page, t);
    }

    /** The strip's state: the frame's Expand, by today's or the strip's name, and whether it rests. */
    const expandButton = (bar: Locator) => bar.getByRole("button", { name: /^(Expand|Larger)$/ });
    const collapseButton = (bar: Locator) => bar.getByRole("button", { name: /^(Collapse|Smaller)$/ });

    /**
     * Presses a control, in the quick row where it shows there, and else
     * behind Expand (the design's barControl), resting the bar again after,
     * so the map the expanded bar covered takes the next tap.
     */
    async function press(bar: Locator, name: string): Promise<void> {
      const inRow = bar.locator("[data-rest-row]").getByRole("button", { name, exact: true });
      if ((await inRow.count()) > 0 && (await inRow.first().isVisible())) {
        await inRow.first().tap();
        return;
      }
      const expanded = (await expandButton(bar).count()) > 0;
      if (expanded) await expandButton(bar).tap();
      await bar.getByRole("button", { name, exact: true }).first().tap();
      if (expanded && (await collapseButton(bar).count()) > 0) await collapseButton(bar).tap();
    }

    /**
     * The quick row as drawn: every candidate's id in order, those drawn,
     * each one's own width as the fit counts it (a copy laid out at its
     * natural width inside the row, so the font, the interface size and a
     * candidate the row skipped all count), the row's room and gap, and
     * the field's least width, all in the screen's px.
     */
    async function quickRow(bar: Locator) {
      return bar.locator("[data-rest-row]").first().evaluate((el) => {
        const row = el as unknown as PageEl;
        const { document, getComputedStyle } = globalThis as unknown as PageGlobals;
        const items = [...row.querySelectorAll(":scope > [data-rest-item]")];
        const box = row.getBoundingClientRect();
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;display:flex;width:max-content";
        row.append(probe);
        const widths: Record<string, number> = {};
        let fieldMin = 0;
        for (const item of items) {
          const id = item.dataset.restItem!;
          const node = item.firstElementChild;
          if (!node) {
            widths[id] = 0;
            continue;
          }
          const copy = node.cloneNode(true);
          copy.style.flex = "none";
          probe.replaceChildren(copy);
          const field = copy.querySelector("[data-rest-field]");
          const fieldWidth = field ? field.getBoundingClientRect().width : 0;
          if (field) fieldMin = fieldWidth;
          widths[id] = copy.getBoundingClientRect().width - fieldWidth;
        }
        probe.remove();
        // The field's least width is 56 layout px, so it gives the chrome's zoom for the gap, which CSS states unzoomed.
        const zoom = fieldMin > 0 ? fieldMin / 56 : box.width / Math.max(1, row.offsetWidth);
        const style = getComputedStyle(row);
        const gap = (Number.parseFloat(style.columnGap) || 0) * zoom;
        // The row reaches past its edges by a focus ring's width, as padding, which is no room for a control.
        const padding = ((Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)) * zoom;
        const shown = items
          .filter((item) => {
            const r = item.getBoundingClientRect();
            return r.width > 0.5 && getComputedStyle(item).visibility !== "hidden" && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
          })
          .map((item) => item.dataset.restItem!);
        return { ids: items.map((item) => item.dataset.restItem!), shown, widths, room: box.width - padding, gap, fieldMin: fieldMin || 56 * zoom };
      });
    }

    /** Asserts the row draws what restFit gives for its drawn widths (3.3), and returns it. */
    async function fitsByWidth(bar: Locator, label: string) {
      const { restFit } = await strip();
      const row = await quickRow(bar);
      const want = restFit(row.widths, row.room, row.gap, row.fieldMin);
      assert.deepEqual(row.shown, want, `${label}: the row draws ${row.shown.join(", ")}, the fit gives ${want.join(", ")} for ${JSON.stringify(row)}`);
      return row;
    }

    /** What the status line says, wherever it says it: the sentence that needs more room, else the line. */
    async function said(bar: Locator): Promise<string> {
      const status = bar.locator("[data-rest-status]").first();
      return (await status.getAttribute("data-rest-sentence")) ?? (await status.getAttribute("data-rest-line")) ?? "";
    }

    async function alignmentOf(page: Page, root: Locator, screen: string): Promise<string[]> {
      const { alignmentLines, measureAlignment } = await alignment();
      return alignmentLines(await measureAlignment(root), screen);
    }

    test("br-c-1. the quick row per role and token, the group's, Undo move in Roll's place and Conditions from rest, fitted by drawn widths, once more with wider letters", async () => {
      await setUp(dm, PHONES[0]);
      await setUp(pat, PHONES[0]);
      const cases: { page: Page; who: string; token: Placed; ids: string[] }[] = [
        { page: dm, who: "the DM", token: run.thorn, ids: ["mode", "conditions", "roll", "multiSelect", "hidden"] },
        // A player's own token offers the door's button, which draws nothing with no door in reach, so the fit leaves it out.
        { page: pat, who: "Pat", token: run.thorn, ids: ["mode", "conditions", "door", "roll", "multiSelect"] },
        { page: pat, who: "Pat", token: run.goblin1, ids: ["multiSelect", "details"] },
        { page: dm, who: "the DM", token: run.barrel, ids: ["conditions", "roll", "multiSelect", "hidden", "details"] },
        { page: pat, who: "Pat", token: run.lantern, ids: ["conditions", "door", "roll", "multiSelect", "details"] },
      ];
      for (const c of cases) {
        const bar = await openBar(c.page, c.token);
        const label = `${c.who} on ${c.token.name} at 390 x 844`;
        const row = await fitsByWidth(bar, label);
        assert.deepEqual(row.ids, c.ids, `${label}: the candidates`);
        if (c.ids.includes("mode")) assert.equal(await said(bar), "AC 14 · HP 24/24", `${label}: the vitals in the status line`);
        await shots.take(c.page, `br-c-1-${c.page === dm ? "dm" : "pat"}-${c.token.name.toLowerCase().replace(/ /g, "-")}`);
      }

      // Undo move after a drag takes Roll's place where it fits, Conditions kept (D-261024-12), at 390 and 375.
      const { pagePoint, touchSwipe } = await harness();
      for (const view of [PHONES[0], PHONES[1]]) {
        await setUp(pat, view);
        const label = `Pat at ${view.width} x ${view.height}`;
        await openBar(pat, run.thorn);
        const before = patSocket.state!.tokens[run.thorn.id]!;
        const from = await pagePoint(pat, BOUNDS, { x: before.x + 0.5, y: before.y + 0.5 });
        const to = await pagePoint(pat, BOUNDS, { x: before.x + 1.5, y: before.y + 0.5 });
        await touchSwipe(patCdp, from, to, { steps: 10, everyMs: 20 });
        await waitFor(`${label}: Thorn one cell east`, () => patSocket.state?.tokens[run.thorn.id]?.x === before.x + 1);
        const bar = barOf(pat, "Thorn");
        await bar.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true }).waitFor({ state: "attached" });
        const row = await fitsByWidth(bar, `${label}, Undo move`);
        assert.ok(row.ids.includes("undoMove") && row.ids.includes("roll"), `${label}: Undo move and Roll are both candidates`);
        assert.ok(row.shown.includes("undoMove") && !row.shown.includes("roll") && row.shown.includes("conditions"), `${label}: Undo move in Roll's place, Conditions kept: ${row.shown.join(", ")}`);
        await shots.take(pat, `br-c-1-undo-${view.width}`);
        await bar.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true }).tap();
        await waitFor(`${label}: Thorn back`, () => patSocket.state?.tokens[run.thorn.id]?.x === before.x);
      }

      // Conditions from rest: the bar expands with the drawer, focus on Conditions there, and closing the drawer rests it again.
      await setUp(pat, PHONES[0]);
      const thorn = await openBar(pat, run.thorn);
      await thorn.locator("[data-rest-row]").getByRole("button", { name: "Conditions", exact: true }).tap();
      await thorn.getByRole("group", { name: "Conditions" }).waitFor();
      await collapseButton(thorn).waitFor();
      const focused = () =>
        pat.evaluate(() => {
          const el = (globalThis as unknown as PageGlobals).document.activeElement;
          return { name: el?.textContent?.trim() ?? "", pressed: el?.getAttribute("aria-pressed") ?? null, inRow: el?.closest("[data-rest-row]") !== null };
        });
      assert.deepEqual(await focused(), { name: "Conditions", pressed: "true", inRow: false }, "focus on the expanded bar's Conditions, pressed");
      await shots.take(pat, "br-c-1-conditions-from-rest");
      await thorn.getByRole("button", { name: "Conditions", exact: true }).tap();
      await expandButton(thorn).waitFor();
      assert.equal(await thorn.getByRole("group", { name: "Conditions" }).count(), 0, "the drawer closed");
      assert.deepEqual(await focused(), { name: "Conditions", pressed: "false", inRow: true }, "focus back on the strip's Conditions");

      // The group's strip: "3 selected", the group's entry as the lead, then Conditions, Roll, Multi-select and Hidden for the DM.
      await setUp(dm, PHONES[0]);
      const goblin = await openBar(dm, run.goblin1);
      await press(goblin, "Multi-select");
      await tapToken(dm, run.goblin2, "2 selected tokens");
      const group = await tapToken(dm, run.thorn, "3 selected tokens");
      if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
      // The header's title: its first line names the group, the status line under it.
      assert.equal(((await group.locator("strong > span").first().textContent()) ?? "").trim(), "3 selected");
      const groupRow = await fitsByWidth(group, "the DM's group at 390 x 844");
      assert.deepEqual(groupRow.ids, ["mode", "conditions", "roll", "multiSelect", "hidden"]);
      assert.equal(await said(group), "Goblin 1, Goblin 2, Thorn");
      await shots.take(dm, "br-c-1-group-dm");
      assert.deepEqual(await alignmentOf(dm, group, "the DM's group strip at 390 x 844"), []);
      await closeBars(dm);
      // Pat's group leaves out the goblins, and the status line says so.
      const patThorn = await openBar(pat, run.thorn);
      await press(patThorn, "Multi-select");
      await tapToken(pat, run.goblin1, "2 selected tokens");
      const patGroup = await tapToken(pat, run.goblin2, "3 selected tokens");
      if ((await collapseButton(patGroup).count()) > 0) await collapseButton(patGroup).tap();
      assert.deepEqual((await quickRow(patGroup)).ids, ["mode", "multiSelect"]);
      assert.equal(await said(patGroup), "Leaves out Goblin 1, Goblin 2: you cannot change their HP.");
      await shots.take(pat, "br-c-1-group-pat");
      await closeBars(pat);
      await press(await openBar(pat, run.thorn), "Multi-select");
      await closeBars(pat);

      // At 375 x 667 the row fits by drawn widths, and with the strip's letters drawn wider, Roll drops and Conditions stays.
      await setUp(pat, PHONES[1]);
      await fitsByWidth(await openBar(pat, run.thorn), "Pat at 375 x 667");
      const wide = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true, storageState: await patContext.storageState() });
      try {
        const page = await wide.newPage();
        await page.goto(`${server.origin}/r/${run.roomId}`);
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await page.addStyleTag({ content: "[data-rest-row] button { letter-spacing: 1.5px !important; }" });
        const { pagePoint: point } = await harness();
        const t = patSocket.state!.tokens[run.thorn.id]!;
        const p = await point(page, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
        await page.touchscreen.tap(p.x, p.y);
        const bar = barOf(page, "Thorn");
        await bar.waitFor();
        const row = await fitsByWidth(bar, "Pat at 375 x 667 with wider letters");
        assert.ok(row.shown.includes("conditions") && !row.shown.includes("roll"), `Roll drops by the drawn widths, Conditions kept: ${row.shown.join(", ")}`);
        await shots.take(page, "br-c-1-wider-letters-375");
      } finally {
        await wide.close();
      }

      // Alignment of Pat's strip on Thorn at the alignment sizes.
      for (const view of [PHONES[0], { width: 390, height: 844, scale: 1.3 }, { width: 320, height: 568, scale: 1 }, PHONES[3]]) {
        await setUp(pat, view);
        const bar = await openBar(pat, run.thorn);
        assert.deepEqual(await alignmentOf(pat, bar, `Pat's strip on Thorn at ${view.width} x ${view.height} at ${view.scale * 100}%`), []);
      }
      await closeBars(pat);
    });

    /** Thorn's HP and death saves as the DM's copy holds them. */
    const thornHp = () => dmSocket.state?.characters[run.thorn.characterId]?.actor;

    /** Thorn at 0 HP, dying, his saves cleared, or whole again at 24. */
    async function thornAt(cur: 0 | 24): Promise<void> {
      if (cur === 24) await ops.send({ t: "actor.life", target: { tokenId: run.thorn.id }, life: "alive" });
      await ops.send({ t: "actor.hp", target: { tokenId: run.thorn.id }, change: { kind: "set", cur } });
      if (cur === 0) await ops.send({ t: "actor.deathSave", target: { tokenId: run.thorn.id }, ok: 0, fail: 0 });
      await waitFor(`Thorn at ${cur}`, () => thornHp()?.hp?.cur === cur && (cur > 0 || thornHp()?.life === "dying"));
    }

    test("br-c-2. the HP entry in the strip: the toggle, a mode kept from the expanded bar, invalid input, a refusal, Crit on a dying creature, a kept Crit at 320 x 568 at 130%, a group's left-out creatures and a dead line", async () => {
      await setUp(dm, PHONES[0]);
      let thorn = await openBar(dm, run.thorn);
      const row = () => thorn.locator("[data-rest-row]");
      const field = () => row().getByRole("textbox", { name: "HP change" });
      const toggle = () => row().locator("[data-rest-mode]");
      const apply = () => row().getByRole("button", { name: "Apply", exact: true });
      const mode = async () => ({ name: await toggle().getAttribute("aria-label"), sign: ((await toggle().textContent()) ?? "").trim() });

      // The toggle names its mode and draws its sign, and a tap switches Damage and Heal (D-261024-10).
      assert.deepEqual(await mode(), { name: "Damage", sign: "−" });
      await toggle().tap();
      assert.deepEqual(await mode(), { name: "Heal", sign: "+" });
      await toggle().tap();
      await field().fill("10");
      assert.equal(await said(thorn), "10 damage");
      await apply().tap();
      await waitFor("Thorn at 14", () => thornHp()?.hp?.cur === 14);
      assert.equal(await said(thorn), "AC 14 · HP 14/24");

      // Heal picked in the expanded bar is kept as the bar rests: the toggle shows +, and Apply heals.
      await expandButton(thorn).tap();
      await thorn.getByRole("radiogroup", { name: "What the number does" }).getByRole("radio", { name: "Heal" }).check({ force: true });
      await collapseButton(thorn).tap();
      assert.deepEqual(await mode(), { name: "Heal", sign: "+" });
      await field().fill("7");
      assert.equal(await said(thorn), "Heal 7");
      await apply().tap();
      await waitFor("Thorn at 21", () => thornHp()?.hp?.cur === 21);
      await shots.take(dm, "br-c-2-heal-kept");

      // Invalid input: the error in the status line, in the error tone and said once, and focus kept in the field.
      await field().fill("abc");
      await field().press("Enter");
      assert.equal(await said(thorn), "Use a number, such as -7, +5, =20 or t5.");
      assert.equal(((await thorn.locator('[role="status"]').filter({ hasText: "Use a number" }).count()) > 0), true, "the error is said");
      assert.equal(await field().evaluate((el) => (globalThis as unknown as PageGlobals).document.activeElement === (el as unknown as PageEl)), true, "focus stays in the field");
      await shots.take(dm, "br-c-2-error");
      await field().fill("");

      // Crit on a dying creature: in the row where it fits, pressed, and the damage counts two failed saves.
      await thornAt(0);
      thorn = await openBar(dm, run.thorn);
      const dying = await fitsByWidth(thorn, "the DM on a dying Thorn at 390 x 844");
      assert.ok(dying.ids.includes("crit"), "Crit is a candidate at 0 HP");
      assert.ok(dying.shown.includes("crit"), `Crit fits at 390 x 844: ${dying.shown.join(", ")}`);
      const crit = row().getByRole("button", { name: "Critical Hit (two failed Death Saves)" });
      await crit.tap();
      assert.equal(await crit.getAttribute("aria-pressed"), "true");
      await field().fill("7");
      // Its own control shows it, so the line does not name it.
      assert.equal(await said(thorn), "7 damage");
      await apply().tap();
      await waitFor("two failed saves", () => thornHp()?.deathSaves?.fail === 2);
      await shots.take(dm, "br-c-2-crit-dying");

      // A kept Crit with valid text at 320 x 568 at 130%, where Crit does not fit: the status line names it, and Apply counts it.
      await thornAt(0);
      await setUp(dm, PHONES[3]);
      thorn = await openBar(dm, run.thorn);
      const small = await fitsByWidth(thorn, "the DM on a dying Thorn at 320 x 568 at 130%");
      assert.deepEqual(small.shown, ["mode"], "the lead alone");
      await expandButton(thorn).tap();
      await thorn.getByRole("checkbox", { name: "Critical Hit (two failed Death Saves)" }).check({ force: true });
      await collapseButton(thorn).tap();
      assert.equal(await said(thorn), "Critical Hit");
      await field().fill("7");
      assert.equal(await said(thorn), "7 damage, Critical Hit");
      await shots.take(dm, "br-c-2-crit-kept-320");
      await apply().tap();
      await waitFor("two failed saves", () => thornHp()?.deathSaves?.fail === 2);
      // Kept into Heal, it is never sent, so never named.
      await thornAt(0);
      thorn = await openBar(dm, run.thorn);
      await expandButton(thorn).tap();
      await thorn.getByRole("checkbox", { name: "Critical Hit (two failed Death Saves)" }).check({ force: true });
      await collapseButton(thorn).tap();
      await toggle().tap();
      await field().fill("5");
      assert.equal(await said(thorn), "Heal 5");
      await field().fill("");
      await thornAt(24);

      // A refusal: with "players apply damage", Pat's =20 on a goblin, Apply disabled.
      await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
      try {
        await setUp(pat, PHONES[0]);
        const goblin = await openBar(pat, run.goblin1);
        const goblinField = goblin.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" });
        await goblinField.fill("=20");
        assert.equal(await said(goblin), "You can only deal damage to or heal this creature.");
        assert.equal(await goblin.locator("[data-rest-row]").getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
        await shots.take(pat, "br-c-2-refusal");
        await goblinField.fill("");
      } finally {
        await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
      }

      // A group's left-out creatures: Pat's Thorn and two goblins, 7 typed, at 390 x 844 and in the note at 320 x 568 at 130%.
      for (const view of [PHONES[0], PHONES[3]]) {
        await setUp(pat, view);
        await press(await openBar(pat, run.thorn), "Multi-select");
        await tapToken(pat, run.goblin1, "2 selected tokens");
        const group = await tapToken(pat, run.goblin2, "3 selected tokens");
        if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
        await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("7");
        assert.equal(await said(group), "7 damage, not Goblin 1, Goblin 2", `${view.width} x ${view.height}`);
        // One line holds it at 390, and at 320 x 568 at 130% it needs the title's two lines or the note, by its drawn width.
        const place = await group.locator("[data-rest-status]").getAttribute("data-rest-place");
        if (view.scale > 1) assert.ok(place === "title" || place === "note", `the sentence needs more than the line: ${place}`);
        else assert.equal(place, null, "the line holds it");
        await shots.take(pat, `br-c-2-group-left-out-${view.width}`);
        await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("");
        await closeBars(pat);
        await press(await openBar(pat, run.thorn), "Multi-select");
        await closeBars(pat);
      }

      // A dead line: the DM heals a dead goblin, with healing bringing back the dead and without.
      await setUp(dm, PHONES[0]);
      await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "dead" });
      try {
        const goblin = await openBar(dm, run.goblin2);
        const goblinToggle = goblin.locator("[data-rest-row] [data-rest-mode]");
        await goblinToggle.tap();
        assert.equal(await goblinToggle.getAttribute("aria-label"), "Heal");
        assert.equal(await said(goblin), "Brings back 1 dead creature.");
        await ops.send({ t: "room.update", settings: { healRevives: false } });
        await waitFor("the dead line", async () => (await said(goblin)) === "Healing does nothing while Goblin 2 is dead. Revive first.");
        await shots.take(dm, "br-c-2-dead-line");
      } finally {
        await ops.send({ t: "room.update", settings: { healRevives: true } });
        await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "alive" });
      }
      await closeBars(dm);
    });

    test("br-c-3. the scrolling strip at F of 210 and 148 and at 375 x 667 with a roll card: every control whole and on top when scrolled to, Scroll for more, and the DM's alerts back up at its header", async () => {
      /** Every control below the header, each scrolled into view: whole in the scroller, and the top thing at its middle and 2 px in from each corner. */
      const sweep = (bar: Locator) =>
        bar.evaluate((el) => {
          type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
          type Node = {
            getBoundingClientRect(): Rect;
            scrollIntoView(o: { block: string }): void;
            contains(n: unknown): boolean;
            getAttribute(n: string): string | null;
            textContent: string | null;
            parentElement: Node | null;
            scrollHeight: number;
            clientHeight: number;
            scrollTop: number;
            querySelector(s: string): Node | null;
            querySelectorAll(s: string): Iterable<Node>;
          };
          const frame = el as unknown as Node;
          const { document, getComputedStyle } = globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null }; getComputedStyle(n: Node): { overflowY: string; visibility: string } };
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
          if (!scroller) return { scrolls: false, misses: ["no scroller"], count: 0 };
          // The header, the row the title stands in, scrolls too: its own controls are the frame's, not the content's.
          const header = scroller.querySelector("strong")?.parentElement ?? null;
          const misses: string[] = [];
          // What the strip draws: a candidate the quick row skipped is no control of the strip's.
          const controls = [...scroller.querySelectorAll("button, input, select, textarea, [role='checkbox'], [role='radio']")].filter(
            (c) => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== "hidden" && !(header?.contains(c) ?? false),
          );
          for (const c of controls) {
            c.scrollIntoView({ block: "nearest" });
            const r = c.getBoundingClientRect();
            const s = scroller.getBoundingClientRect();
            const name = c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "?";
            if (r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) misses.push(`${name}: not whole`);
            for (const [x, y] of [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]] as const) {
              const top = document.elementFromPoint(x, y);
              if (!top || !(c.contains(top) || top.contains(c))) misses.push(`${name}: covered at ${Math.round(x)},${Math.round(y)}`);
            }
          }
          scroller.scrollTop = 0;
          return { scrolls: true, misses, count: controls.length };
        });
      const scrollerTop = (bar: Locator) =>
        bar.evaluate((el) => {
          type Node = { scrollHeight: number; clientHeight: number; scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          const { getComputedStyle } = globalThis as unknown as { getComputedStyle(n: Node): { overflowY: string } };
          const frame = el as unknown as Node;
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
          return scroller ? { top: scroller.scrollTop, window: scroller.clientHeight } : null;
        });

      const windows = [
        { view: { width: 320, height: 440, scale: 1.3 }, page: dm, label: "320 x 440 at 130%, F = 210" },
        { view: { width: 320, height: 360, scale: 1.3 }, page: dm, label: "320 x 360 at 130%, F = 148" },
        { view: PHONES[1], page: pat, label: "375 x 667 with a roll card, F = 237" },
      ];
      const card = randomUUID();
      try {
        for (const w of windows) {
          await setUp(w.page, w.view);
          if (w.page === pat) {
            await ops.send({ t: "roll.ask", request: { id: card, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
            await pat.getByText("The DM asks for a Dexterity saving throw.").first().waitFor();
            // The card stands over the map's foot, so Thorn is panned above it first, as a player would.
            const { pagePoint, touchSwipe } = await harness();
            const cardTop = (await pat.getByRole("dialog", { name: "The DM asks for a roll" }).boundingBox())!.y;
            const t = patSocket.state!.tokens[run.thorn.id]!;
            const at = await pagePoint(pat, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
            if (at.y > cardTop - 60) await touchSwipe(patCdp, { x: 24, y: cardTop - 8 }, { x: 24, y: cardTop - 8 - (at.y - cardTop + 120) }, { steps: 12, everyMs: 20 });
          }
          const bar = await openBar(w.page, run.thorn);
          assert.equal(await expandButton(bar).count(), 0, `${w.label}: Expand is not offered`);
          const more = bar.getByRole("button", { name: "Scroll for more", exact: true });
          await more.waitFor();
          const swept = await sweep(bar);
          assert.ok(swept.scrolls && swept.count > 0, `${w.label}: the strip scrolls`);
          assert.deepEqual(swept.misses, [], `${w.label}`);
          assert.deepEqual(await alignmentOf(w.page, bar, `the scrolling strip at ${w.label}, top`), []);
          // "Scroll for more" moves one window less 44, so the row at its foot comes to its top.
          const before = (await scrollerTop(bar))!;
          await more.tap();
          await waitFor(`${w.label}: scrolled one window less 44`, async () => Math.abs((await scrollerTop(bar))!.top - (before.top + before.window - 44)) <= 1);
          assert.deepEqual(await alignmentOf(w.page, bar, `the scrolling strip at ${w.label}, middle`), []);
          await shots.take(w.page, `br-c-3-${w.view.width}x${w.view.height}`);
          await closeBars(w.page);
        }
      } finally {
        await ops.send({ t: "roll.close", rollIds: [card] });
      }

      // The DM's alerts from the strip's foot: a concentration check stands, its summary in the header, reached by scrolling back up.
      const caster = run.goblinLeft.id;
      await ops.send({ t: "actor.effect.add", target: { tokenId: caster }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
      await setUp(dm, { width: 320, height: 360, scale: 1.3 });
      await ops.send({ t: "actor.hp", target: { tokenId: caster }, change: { kind: "damage", amount: 1 } });
      await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      {
        // The check's card stands over the map's top at this size, Thorn under it, so he is panned below it first, as the DM would.
        const { pagePoint, touchSwipe } = await harness();
        const card = (await dm.locator('[data-alert="concentration"]').first().boundingBox())!;
        const t = dmSocket.state!.tokens[run.thorn.id]!;
        const at = await pagePoint(dm, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
        const below = card.y + card.height + 16;
        if (at.y < below) await touchSwipe(dmCdp, { x: 12, y: below }, { x: 12, y: below + (below - at.y) }, { steps: 12, everyMs: 20 });
      }
      const bar = await openBar(dm, run.thorn);
      const summary = bar.getByRole("button", { name: /^Concentration save/ });
      if ((await summary.count()) === 0) {
        // The DM's top bar leaves a gap left of Undo here, which takes the summary row (3.5), so the header holds none to scroll away: the row stays in reach.
        const row = dm.getByRole("button", { name: /^Concentration save/ }).first();
        assert.ok(await (await harness()).wholeInReach(row), "the summary row risen over the top bar is out of reach");
      } else {
        await bar.evaluate((el) => {
          type Node = { scrollHeight: number; clientHeight: number; scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          const { getComputedStyle } = globalThis as unknown as { getComputedStyle(n: Node): { overflowY: string } };
          const frame = el as unknown as Node;
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY));
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
        assert.equal(await summary.isVisible() && (await (await harness()).wholeInReach(summary)), false, "the header's summary scrolled away at the strip's foot");
        await bar.evaluate((el) => {
          type Node = { scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          for (const n of [el as unknown as Node, ...(el as unknown as Node).querySelectorAll("*")]) n.scrollTop = 0;
        });
        assert.ok(await (await harness()).wholeInReach(summary), "a scroll back up brings the summary's button in the header");
      }
      await shots.take(dm, "br-c-3-alerts-back-up");
      await closeBars(dm);
    });
  });
});
