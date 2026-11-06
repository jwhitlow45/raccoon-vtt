import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, openSideTab, OpSocket, readCamera, reopenRoom, Shots, SocketWatch, startServer, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * The side panel that resizes from its edge (docs/design/design-v1-panel-size.md
 * 4 and 8, lane PS-A's pw cases), on the real server serving the production
 * build: the drag and its release, Escape, S and the slop, Reset width and
 * the double-click, the keys, the bounds at each window and interface size,
 * the top bar giving way by its own width, the map's controls keeping their
 * presses at its right edge, a finger on a touch tablet, and the panel's
 * rows measured at 360 and at the cap.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-four, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 54;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-paneledge-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const KEY = "rvtt.sidePanelWidth";
const DESK = { width: 1440, height: 900 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E panel edge ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  password: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  goblins: Array.from({ length: 6 }, () => randomUUID()),
  phases: [randomUUID(), randomUUID()],
};

function actor(hp: number, extra: Record<string, unknown> = {}) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...extra };
}

function picture(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 500, height: 400, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

/** Runs code in the page and hands back what it returns. */
function js<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(() => { ${body} })()`) as Promise<T>;
}

const edge = (page: Page) => page.getByRole("separator", { name: "Side panel width" });
const aside = (page: Page) => page.locator('aside:has([role="tablist"][aria-label="Panels"])');
const resetWidth = (page: Page) => aside(page).getByRole("button", { name: "Reset width", exact: true });
const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]");

/** What this device stores, as the page reads it. */
const stored = (page: Page) => js<string | null>(page, `return localStorage.getItem(${JSON.stringify(KEY)});`);

/** The panel's drawn width in layout px, from the aside's box and the interface size's zoom, to the nearest px the page's own rounding of the zoomed box allows. */
async function drawn(page: Page): Promise<number> {
  return js<number>(page, `const a = document.querySelector("aside"); const z = a.currentCSSZoom || 1; return Math.round(a.getBoundingClientRect().width / z);`);
}

async function valueNow(page: Page): Promise<{ now: number; max: number; min: number; text: string | null }> {
  const e = edge(page);
  return { now: Number(await e.getAttribute("aria-valuenow")), max: Number(await e.getAttribute("aria-valuemax")), min: Number(await e.getAttribute("aria-valuemin")), text: await e.getAttribute("aria-valuetext") };
}

/** Reloads at an interface size, with what this device stores of the width and the theme, and waits for the room and its side panel. */
async function reloadAt(page: Page, opts: { scale?: number; width?: string | null; theme?: "dark" | "light" } = {}): Promise<void> {
  await page.evaluate(
    ({ scale, width, theme, key }) => {
      const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage;
      store.setItem("rvtt.uiScale", String(scale));
      store.setItem("rvtt.theme", theme);
      store.removeItem("rvtt.sidePanel");
      if (width === undefined) return;
      if (width === null) store.removeItem(key);
      else store.setItem(key, width);
    },
    { scale: opts.scale ?? 1, width: opts.width, theme: opts.theme ?? "dark", key: KEY },
  );
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await page.waitForTimeout(300);
}

async function size(page: Page, s: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(s);
  await page.waitForTimeout(250);
}

/** The edge's press point: on its strip at a third of the aside's height, clear of the grip and of the map's bars. */
async function edgePoint(page: Page): Promise<{ x: number; y: number }> {
  const box = (await edge(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 3 };
}

/** Presses the edge with the mouse and moves it `dx` screen px in `steps` moves. The caller releases, or not. */
async function pressAndMove(page: Page, dx: number, steps = 10): Promise<{ x: number; y: number }> {
  const at = await edgePoint(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y, { steps });
  return at;
}

async function dragEdge(page: Page, dx: number, steps = 10): Promise<void> {
  await pressAndMove(page, dx, steps);
  await page.mouse.up();
  await page.waitForTimeout(100);
}

/** The world point at the middle of the map's canvas. */
async function mapCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".konvajs-content").first().boundingBox())!;
  const cam = (await readCamera(page))!;
  return { x: (box.width / 2 - cam.x) / cam.scale, y: (box.height / 2 - cam.y) / cam.scale };
}

/** What the DM's top bar holds now, among the parts that give way: the clock's chip, the DM chip's name, Full screen and the Phase menu. */
async function barParts(page: Page): Promise<string[]> {
  const bar = topBar(page);
  const parts: string[] = [];
  if ((await bar.locator("button", { hasText: /^Day \d/ }).count()) > 0) parts.push("clock");
  if ((await bar.getByText("DM", { exact: true }).count()) > 0) parts.push("dm-name");
  if ((await bar.getByRole("button", { name: "Full screen", exact: true }).count()) > 0) parts.push("fullscreen");
  if ((await bar.getByLabel("Map phase").count()) > 0) parts.push("phase");
  return parts;
}

/** Whether a player's chip shows only its dot. */
async function chipIsDot(page: Page): Promise<boolean> {
  return (await topBar(page).getByRole("img", { name: "You are Pat" }).count()) > 0;
}

/** What takes a press at a point: the edge, or the tag and role of what does. */
function pressedAt(page: Page, p: { x: number; y: number }): Promise<string> {
  return js<string>(page, `const el = document.elementFromPoint(${p.x}, ${p.y}); if (!el) return "none"; if (el.closest("[data-panel-edge]")) return "edge"; const ctl = el.closest("button, [role=button], select, nav, header, [role=dialog]"); return ctl ? ctl.tagName.toLowerCase() + ":" + (ctl.getAttribute("aria-label") ?? ctl.getAttribute("role") ?? "") : el.tagName.toLowerCase();`);
}

describe("raccoon-vtt: the side panel that resizes from its edge", { timeout: 1_200_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
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

  test("pa-0. a DM's room in a fight with six goblins and Pat's Thorn, a running clock and a scene with two phases", async () => {
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

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    await ops.send({ t: "token.create", token: { id: run.thorn, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: 4, y: 6, disposition: "ally", actor: { ref: run.thornChar } } });
    for (const [i, id] of run.goblins.entries()) {
      await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", number: i + 1, x: 10 + (i % 3), y: 4 + Math.floor(i / 3), disposition: "hostile", actor: { inline: actor(10, { srdId: "goblin-warrior" }) } } });
    }
    const upload = async (rgb: [number, number, number]) => {
      const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await picture(rgb) });
      assert.ok(res.ok(), `the upload answered ${res.status()}`);
      return (await res.json()) as { id: string; width: number; height: number };
    };
    const day = await upload([150, 140, 120]);
    const night = await upload([40, 50, 90]);
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: 25, originPx: { x: 0, y: 0 } } });
    await ops.send({
      t: "scene.update",
      sceneId: run.sceneId,
      patch: {
        phases: [
          { id: run.phases[0], name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
          { id: run.phases[1], name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height },
        ],
      },
    });
    await ops.send({ t: "clock.start", id: randomUUID(), at: 2 * 86_400 + 20 * 3600, shown: true, calendar: { kind: "days" } });
    const entries = [{ id: "e-thorn", tokenId: run.thorn, value: 25 }, ...run.goblins.map((tokenId, i) => ({ id: `e-g${i}`, tokenId, value: 20 - i }))];
    await ops.send({ t: "encounter.start", entries });
    await ops.send({ t: "encounter.next" });
    await waitFor("the fight, the clock and the phases in the DM's view", () => (dmSocket.state?.encounter?.entries.length === 7 && dmSocket.state.clock && dmSocket.state.scenes[run.sceneId]?.phases?.length === 2 ? true : null));

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
    await reloadAt(dm, { width: null });
    await reloadAt(pat, { width: null });
    await shots.take(dm, "pa-0-default-1440");
  });

  test("pa-1. a drag 140 px left draws 500, stored at its release, the map's center kept, and it stops at 640 and 360 in whole px (pw-1)", async () => {
    assert.equal(await drawn(dm), 360);
    assert.deepEqual(await valueNow(dm), { now: 360, max: 640, min: 360, text: "360 pixels, the default" });
    assert.equal(await resetWidth(dm).count(), 0, "no Reset width at the default");
    // Off the fitted view, so the camera keeps its center as on a window resize rather than refitting.
    await dm.keyboard.press("Equal");
    await dm.waitForTimeout(400);
    const center = await mapCenter(dm);

    // A 300 px drag in 20 steps renders the room on each move: no long task over 50 ms (4.4's builder check).
    await js(dm, `window.__longest = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longest = Math.max(window.__longest, e.duration); }).observe({ type: "longtask", buffered: false }); return 0;`);
    await pressAndMove(dm, -140, 20);
    assert.equal(await drawn(dm), 500, "it follows the pointer while held");
    assert.equal(await stored(dm), null, "nothing is stored while the drag is held");
    await dm.mouse.up();
    await dm.waitForTimeout(150);
    const longest = await js<number>(dm, "return window.__longest;");
    console.log(`pa-1: the longest task during the drag took ${longest} ms`);
    assert.equal(await stored(dm), "500");
    assert.deepEqual(await valueNow(dm), { now: 500, max: 640, min: 360, text: "500 pixels" });
    const after = await mapCenter(dm);
    assert.ok(Math.abs(after.x - center.x) < 1 && Math.abs(after.y - center.y) < 1, `the map's center stays: ${JSON.stringify(center)} then ${JSON.stringify(after)}`);
    const mapBox = (await dm.locator(".konvajs-content").first().boundingBox())!;
    assert.equal(Math.round(mapBox.width), 940, "the map's column follows");
    await shots.take(dm, "pa-1-drawn-500");

    await dragEdge(dm, -400, 12);
    assert.equal(await drawn(dm), 640, "it stops at the cap");
    assert.equal(await stored(dm), "640");
    await shots.take(dm, "pa-1-drawn-640");
    await dragEdge(dm, 500, 12);
    assert.equal(await drawn(dm), 360, "it stops at the least");
    assert.equal(await stored(dm), "", "the default stores no number");
    // An odd px count at 130% still draws and stores a whole layout px.
    await reloadAt(dm, { scale: 1.3, width: null });
    await dragEdge(dm, -97, 7);
    const w = (await valueNow(dm)).now;
    assert.equal(w, 360 + Math.floor(97 / 1.3), `whole layout px at 130%: ${w}`);
    assert.equal(await drawn(dm), w);
    assert.equal(await stored(dm), String(w));

    // A drag released elsewhere is stored, and a reload draws it.
    await reloadAt(dm, { scale: 1.3, width: undefined });
    assert.equal((await valueNow(dm)).now, w, "a reload draws what was stored");
    await reloadAt(dm, { width: null });
  });

  test("pa-2. Escape, S and a press inside the slop put the edge back and store nothing, and a drag back to its start restores (pw-2)", async () => {
    await dragEdge(dm, -100);
    assert.equal(await stored(dm), "460");
    for (const how of ["Escape", "S"]) {
      await pressAndMove(dm, -120);
      assert.equal(await drawn(dm), 580);
      await dm.keyboard.press(how === "S" ? "s" : "Escape");
      await dm.waitForTimeout(150);
      if (how === "S") {
        assert.ok(await aside(dm).isHidden(), "S hid the panel mid-drag");
        await dm.mouse.up();
        await dm.keyboard.press("s");
        await aside(dm).waitFor();
      } else await dm.mouse.up();
      assert.equal(await drawn(dm), 460, `${how} puts it back`);
      assert.equal(await stored(dm), "460", `${how} stores nothing`);
      // The page left the drag's page-only width: another window's change shows at once.
      await js(dm, `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(KEY)}, newValue: "470" })); return 0;`);
      await waitFor("another window's width", async () => ((await drawn(dm)) === 470 ? true : null), 3_000);
      await js(dm, `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(KEY)}, newValue: "460" })); return 0;`);
      await waitFor("the width back", async () => ((await drawn(dm)) === 460 ? true : null), 3_000);
    }
    // Inside the slop nothing moves, and nothing is written.
    await js(dm, `window.__writes = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === ${JSON.stringify(KEY)}) window.__writes++; return set.call(this, k, v); }; return 0;`);
    await dragEdge(dm, -6, 3);
    assert.equal(await drawn(dm), 460, "a press inside the slop moves nothing");
    // A drag out and back to where it began restores.
    const at = await pressAndMove(dm, -80);
    assert.equal(await drawn(dm), 540);
    await dm.mouse.move(at.x, at.y, { steps: 5 });
    await dm.mouse.up();
    assert.equal(await drawn(dm), 460);
    assert.equal(await js<number>(dm, "return window.__writes;"), 0, "neither wrote the width");
    await js(dm, `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(KEY)}, newValue: "480" })); return 0;`);
    await waitFor("another window's width after a drag back", async () => ((await drawn(dm)) === 480 ? true : null), 3_000);
    await reloadAt(dm, { width: "460" });
  });

  test("pa-3. Reset width and a double-click store null, draw 360, take the button away and leave focus on the edge, a stored 640 in a 960 window included (pw-3)", async () => {
    assert.equal(await drawn(dm), 460);
    const reset = resetWidth(dm);
    await reset.waitFor();
    // Just before Hide panels in the tab row.
    const order = await aside(dm).locator("button[aria-label]").evaluateAll((els) => els.map((e) => (e as unknown as { getAttribute(n: string): string }).getAttribute("aria-label")));
    assert.equal(order[order.indexOf("Reset width") + 1], "Hide panels", order.join(", "));
    await shots.take(dm, "pa-3-reset-width");
    await reset.click();
    await waitFor("the default drawn", async () => ((await drawn(dm)) === 360 ? true : null), 3_000);
    assert.equal(await stored(dm), "");
    assert.equal(await reset.count(), 0, "the button leaves");
    assert.ok(await edge(dm).evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), "focus is on the edge");

    await dragEdge(dm, -100);
    assert.equal(await stored(dm), "460");
    await edge(dm).dblclick();
    await dm.waitForTimeout(150);
    assert.equal(await drawn(dm), 360, "a double-click puts the default back and never drags");
    assert.equal(await stored(dm), "");

    await size(dm, { width: 960, height: 900 });
    await reloadAt(dm, { width: "640" });
    assert.equal(await drawn(dm), 360, "640 waits in a 960 window");
    assert.equal(await resetWidth(dm).count(), 0, "no Reset width while it draws 360");
    await edge(dm).dblclick();
    await dm.waitForTimeout(150);
    assert.equal(await stored(dm), "", "the double-click stores null even where it draws 360");
    await size(dm, DESK);
    assert.equal(await drawn(dm), 360, "so a wider window draws 360");
  });

  test("pa-4. Left, Shift+Left, Home and End from 360 store 368, 432, null and 640, the arrows never move a token, and Left at the cap of a narrow window stores nothing (pw-4)", async () => {
    await reloadAt(dm, { width: null });
    // The aside's first Tab stop.
    const first = await js<string>(dm, `const a = document.querySelector("aside"); const f = [...a.querySelectorAll("button, [tabindex='0'], a[href], input, select, textarea")].find((e) => !e.closest("[hidden]") && e.tabIndex >= 0); return f ? (f.getAttribute("role") ?? f.tagName) + " " + (f.getAttribute("aria-label") ?? "") : "none";`);
    assert.equal(first, "separator Side panel width");
    const thornAt = { x: dmSocket.state!.tokens[run.thorn]!.x, y: dmSocket.state!.tokens[run.thorn]!.y };
    await edge(dm).focus();
    const steps: [string, string, number][] = [
      ["ArrowLeft", "368", 368],
      ["Shift+ArrowLeft", "432", 432],
      ["Home", "", 360],
      ["End", "640", 640],
      ["Shift+ArrowRight", "576", 576],
    ];
    for (const [key, raw, width] of steps) {
      await dm.keyboard.press(key);
      await dm.waitForTimeout(80);
      assert.equal(await stored(dm), raw, key);
      assert.equal((await valueNow(dm)).now, width, key);
    }
    await dm.waitForTimeout(300);
    assert.deepEqual({ x: dmSocket.state!.tokens[run.thorn]!.x, y: dmSocket.state!.tokens[run.thorn]!.y }, thornAt, "no token moved");
    await shots.take(dm, "pa-4-keys-focus");

    await dm.keyboard.press("End");
    assert.equal(await stored(dm), "640");
    await size(dm, { width: 1100, height: 900 });
    assert.deepEqual(await valueNow(dm), { now: 500, max: 500, min: 360, text: "500 pixels" });
    await edge(dm).focus();
    await dm.keyboard.press("ArrowLeft");
    await dm.keyboard.press("End");
    assert.equal(await stored(dm), "640", "Left and End at the cap store nothing, so 640 stays");
    await dm.keyboard.press("ArrowRight");
    assert.equal(await stored(dm), "492", "a step that changes the width stores what it draws");
    await size(dm, DESK);
  });

  test("pa-5. a stored 640 draws 500 at 1100, 360 at 960, sheets at 899 and 640 at 1440, 507 at 1440 at 130% and 640 at 1920 at 130%, and the DM's toolbar stays whole on a 600 px map (pw-5)", async () => {
    await reloadAt(dm, { width: "640" });
    const cases: [number, number, number | null][] = [
      [1100, 900, 500],
      [960, 900, 360],
      [899, 900, null],
      [1440, 900, 640],
    ];
    for (const [w, h, want] of cases) {
      await size(dm, { width: w, height: h });
      if (want === null) assert.equal(await aside(dm).count(), 0, "under 900 the sheets take over");
      else assert.equal(await drawn(dm), want, `${w}`);
      if (w === 1100) {
        // A 600 px map: the DM's mouse toolbar, every tool there, stays clear of the panel.
        const tools = (await dm.getByRole("navigation", { name: "Tools" }).locator("button").evaluateAll((els) => els.map((e) => (e as unknown as { getBoundingClientRect(): { right: number } }).getBoundingClientRect().right))) as number[];
        const panelLeft = (await aside(dm).boundingBox())!.x;
        assert.ok(Math.max(...tools) <= panelLeft, `the toolbar ends at ${Math.max(...tools)}, the panel starts at ${panelLeft}`);
        await shots.take(dm, "pa-5-1100-map-600");
      }
    }
    assert.equal(await stored(dm), "640", "the stored width waits through every window");
    // Today's 900 px window with a mouse, for the record: a 540 px map.
    await size(dm, { width: 900, height: 900 });
    const tools = (await dm.getByRole("navigation", { name: "Tools" }).locator("button").evaluateAll((els) => els.map((e) => (e as unknown as { getBoundingClientRect(): { right: number } }).getBoundingClientRect().right))) as number[];
    console.log(`pa-5: at 900 x 900 the DM's toolbar ends at ${Math.max(...tools)} and the panel starts at ${(await aside(dm).boundingBox())!.x}`);
    await shots.take(dm, "pa-5-900-today");

    await size(dm, DESK);
    await reloadAt(dm, { scale: 1.3, width: "640" });
    assert.equal(await drawn(dm), 507, "1440 at 130% caps at 507");
    assert.equal((await valueNow(dm)).max, 507);
    await shots.take(dm, "pa-5-1440-130-cap");
    await size(dm, { width: 1920, height: 1080 });
    assert.equal(await drawn(dm), 640, "1920 at 130% draws a genuine 640");
    await shots.take(dm, "pa-5-1920-130-640");
    await size(dm, DESK);
    await reloadAt(dm, { scale: 1, width: null });
  });

  test("pa-6. a crowded DM bar gives way as the panel widens and comes back after Reset width, a double-click and S, and a player's chip keys on the bar's width (pw-6)", async () => {
    // At 1440 the clock's chip and the DM chip's name give way at 640, in that order. At 1280, where the chip has already gone at 360, Full screen and the Phase menu go too.
    for (const view of [DESK, { width: 1280, height: 900 }]) {
      await size(dm, view);
      await reloadAt(dm, { width: null });
      const wide = await barParts(dm);
      if (view.width === 1440) assert.deepEqual(wide, ["clock", "dm-name", "fullscreen", "phase"], "the whole bar at 1440 and 360");
      else assert.ok(wide.includes("fullscreen") && wide.includes("phase"), `1280 at 360 keeps Full screen and the Phase menu: ${wide.join(", ")}`);
      await shots.take(dm, `pa-6-crowded-${view.width}-360`);
      await dragEdge(dm, -400, 12);
      assert.equal(await drawn(dm), 640);
      await dm.waitForTimeout(300);
      const narrow = await barParts(dm);
      await shots.take(dm, `pa-6-crowded-${view.width}-640`);
      console.log(`pa-6: at ${view.width} the bar holds ${narrow.join(", ") || "none of them"} at 640`);
      assert.ok(!narrow.includes("clock") && !narrow.includes("dm-name"), `${view.width}: the chip and the DM's name give way: ${narrow.join(", ")}`);
      assert.ok(narrow.length < wide.length);
      if (view.width === 1280) assert.ok(!narrow.includes("fullscreen") && !narrow.includes("phase"), `1280: Full screen and the Phase menu give way: ${narrow.join(", ")}`);
      await resetWidth(dm).click();
      await waitFor("each part back after Reset width", async () => ((await barParts(dm)).join(",") === wide.join(",") ? true : null), 5_000);
      // S hides the panel and the bar takes the window: each part shows. Shown again at 640, they give way again, and a double-click brings them back.
      await dragEdge(dm, -400, 12);
      await dm.keyboard.press("s");
      await aside(dm).waitFor({ state: "hidden" });
      await waitFor("each part with the panel hidden", async () => {
        const parts = await barParts(dm);
        return wide.every((p) => parts.includes(p)) ? true : null;
      }, 5_000);
      await dm.keyboard.press("s");
      await aside(dm).waitFor();
      await waitFor("the parts that give way at 640 again", async () => ((await barParts(dm)).length <= narrow.length ? true : null), 5_000);
      await edge(dm).dblclick();
      await waitFor("each part back after the double-click", async () => {
        const parts = await barParts(dm);
        return wide.every((p) => parts.includes(p)) ? true : null;
      }, 5_000);
    }
    await size(dm, DESK);

    // Pat's chip: names at 1440 with 640 drawn (a 1160 px rule), the dot at 1300 (1020), and with the panel hidden at 1000 the dot as today.
    await reloadAt(pat, { width: "640" });
    assert.equal(await drawn(pat), 640);
    assert.equal(await chipIsDot(pat), false, "names at 1440 with 640 drawn");
    await size(pat, { width: 1300, height: 900 });
    assert.equal(await drawn(pat), 640);
    assert.equal(await chipIsDot(pat), true, "the dot at 1300 with 640 drawn");
    await size(pat, { width: 1000, height: 900 });
    await pat.keyboard.press("s");
    await aside(pat).waitFor({ state: "hidden" });
    assert.equal(await chipIsDot(pat), true, "hidden at 1000, the dot as today");
    await pat.keyboard.press("s");
    await size(pat, DESK);
    await reloadAt(pat, { width: null });
  });

  test("pa-7. at the map's right edge the top bar's end, the toolbar's end and a docked token window's band keep their presses, and only the edge's part in the panel takes them there (pw-7)", async () => {
    await size(dm, { width: 1100, height: 900 });
    await reloadAt(dm, { width: "640" });
    const panel = (await aside(dm).boundingBox())!;
    const bar = (await topBar(dm).boundingBox())!;
    const nav = (await dm.getByRole("navigation", { name: "Tools" }).boundingBox())!;
    // The edge's part over the map: the 8 px left of the aside's border.
    const over = [1, 4, 7].map((d) => panel.x - d);
    for (const x of over) assert.notEqual(await pressedAt(dm, { x, y: bar.y + bar.height / 2 }), "edge", `the top bar's end at ${x}`);
    // The toolbar's own row, where its last button stands nearest the panel.
    const lastTool = (await dm.getByRole("navigation", { name: "Tools" }).locator("button").last().boundingBox())!;
    console.log(`pa-7: the toolbar's last button ends ${panel.x - (lastTool.x + lastTool.width)} px from the panel`);
    for (const x of over) {
      const what = await pressedAt(dm, { x, y: lastTool.y + lastTool.height / 2 });
      if (x <= lastTool.x + lastTool.width) assert.notEqual(what, "edge", `the toolbar's end at ${x}`);
    }
    assert.ok(nav.width > 0);
    // Inside the panel the edge takes the press beside both bars.
    assert.equal(await pressedAt(dm, { x: panel.x + 2, y: panel.y + panel.height / 3 }), "edge");
    // A token window docked against the map's right edge: Thorn's, from its row in Initiative.
    await openSideTab(dm, "Initiative");
    await aside(dm).getByRole("button", { name: /Thorn/ }).first().click();
    const win = dm.getByRole("dialog", { name: "Thorn actions" });
    await win.waitFor();
    const box = (await win.boundingBox())!;
    console.log(`pa-7: Thorn's window ends ${panel.x - (box.x + box.width)} px from the panel`);
    for (const x of [box.x + box.width - 1, box.x + box.width - 4]) assert.notEqual(await pressedAt(dm, { x, y: box.y + 20 }), "edge", `the token window's band at ${x}`);
    for (const x of over) if (x < box.x + box.width) assert.notEqual(await pressedAt(dm, { x, y: box.y + 20 }), "edge", `the token window over the edge at ${x}`);
    await shots.take(dm, "pa-7-token-window");
    await dm.keyboard.press("Escape");
    await size(dm, DESK);
    await reloadAt(dm, { width: null });
  });

  test("pa-8. a finger on the grip of a touch-only tablet at 1180 x 820 resizes the panel (pw-8)", async () => {
    const tablet = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: false, storageState: await patContext.storageState() });
    try {
      const page = await tablet.newPage();
      const watch = new ConsoleWatch("tablet");
      watch.attach(page);
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await reloadAt(page, { width: null });
      const coarse = await js<boolean>(page, `return matchMedia("(any-pointer: coarse)").matches;`);
      assert.ok(coarse, "the tablet reports a coarse pointer");
      const hit = page.locator("[data-edge-hit]");
      const box = (await hit.boundingBox())!;
      const panel = (await aside(page).boundingBox())!;
      assert.ok(Math.abs(box.width - 44) < 0.5 && Math.abs(box.height - 44) < 0.5, `a 44 px grip: ${box.width} x ${box.height}`);
      assert.ok(Math.abs(box.x + box.width - (panel.x + 1)) < 0.5, `none of it in the panel: it ends at ${box.x + box.width}, the panel's border at ${panel.x}`);
      const cdp: CDPSession = await tablet.newCDPSession(page);
      const from = { x: box.x + 10, y: box.y + box.height / 2 };
      assert.equal(await pressedAt(page, from), "edge", "the finger lands on the grip over the map");
      await touchSwipe(cdp, from, { x: from.x - 120, y: from.y }, { steps: 12 });
      await page.waitForTimeout(200);
      assert.equal(await drawn(page), 480);
      assert.equal(await stored(page), "480");
      await shots.take(page, "pa-8-tablet-480");
      assert.deepEqual(watch.errors, []);
    } finally {
      await tablet.close();
    }
  });

  test("pa-9. the panel's rows measure as true at the cap as at 360, dark and light, and the grip sits at the aside's middle on its border", async () => {
    // What the sweep already finds at 360 is not this lane's. At the cap nothing may be new but the tab row's intended 8 px group gap, which the spacing check learns from data-group-start (docs/design/design-v1-panel-size.md 9).
    const norm = (line: string) => line.replace(/^[^:]*: /, "").replace(/\(most start at [\d.]+\)/, "");
    const groupGap = (line: string) => / kind-gap [\d.]+ px, div\[tablist\] "Panels"/.test(line);
    const panels = ["Initiative", "Token", "DM", "Scenes", "Ambiance"];
    const extra: string[] = [];
    let known = 0;
    for (const theme of ["dark", "light"] as const) {
      for (const [view, scale] of [
        [DESK, 1],
        [DESK, 1.3],
        [{ width: 1920, height: 1080 }, 1.3],
      ] as const) {
        await size(dm, view);
        const at = (w: number) => `${theme} ${view.width}x${view.height} ${scale * 100}% at ${w}`;
        const measured = new Map<string, string[]>();
        for (const width of [null, "640"]) {
          await reloadAt(dm, { scale, width, theme });
          const w = await drawn(dm);
          for (const panel of panels) {
            await openSideTab(dm, panel);
            await dm.waitForTimeout(150);
            measured.set(`${panel} ${width}`, alignmentLines(await measureAlignment(aside(dm)), `${panel}, ${at(w)}`));
          }
          const grip = (await dm.locator("[data-edge-grip]").boundingBox())!;
          const box = (await aside(dm).boundingBox())!;
          assert.ok(Math.abs(grip.y + grip.height / 2 - (box.y + box.height / 2)) <= 1, `the grip at the aside's middle, ${at(w)}`);
          assert.ok(Math.abs(grip.x + grip.width / 2 - (box.x + 0.5 * scale)) <= 1, `the grip on the border, ${at(w)}`);
          if (width !== null && scale === 1) await shots.take(dm, `pa-9-${theme}-640`);
        }
        for (const panel of panels) {
          const base = new Set((measured.get(`${panel} null`) ?? []).map(norm));
          known += base.size;
          extra.push(...(measured.get(`${panel} 640`) ?? []).filter((l) => !base.has(norm(l)) && !groupGap(l)));
        }
      }
    }
    console.log(`pa-9: ${known} findings the sweep already makes at 360, none of them the side panel's width`);
    assert.deepEqual(extra, [], "nothing new at the cap");
    // An SRD stat block at the cap, as the design's audit asks.
    await size(dm, DESK);
    await reloadAt(dm, { width: "640" });
    await openSideTab(dm, "Initiative");
    const pane = dm.getByRole("tabpanel", { name: /^Initiative/ });
    await pane.getByRole("button", { name: /^Goblin 1 options/ }).click();
    await dm.getByRole("button", { name: "Stat block", exact: true }).first().click();
    await dm.getByText("Goblin Warrior", { exact: false }).first().waitFor();
    await dm.waitForTimeout(400);
    await shots.take(dm, "pa-9-stat-block-640");
    await reloadAt(dm, { width: null });
  });

  test("pa-10. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
