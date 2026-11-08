import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { versionChar } from "../client/features/dungeon/seed.ts";
import { GENERATOR_VERSION } from "../client/features/dungeon/settings.ts";
import { CHUNK_CELLS, type BuildChunk, type RoomState } from "../shared/model.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { undoSetup } from "./helpers/undoScope.ts";
import { ConsoleWatch, openSceneGroup, openSideTab, OpSocket, pagePoint, pickTool, readCamera, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

// The landing's hold on secret doors (ops.ts `SECRET_DOORS_HELD`), read from its source: importing ops.ts would pull the client's interface modules into the server's typecheck.
const SECRET_DOORS_HELD = /^export const SECRET_DOORS_HELD = true;$/m.test(readFileSync(new URL("../client/features/dungeon/ops.ts", import.meta.url), "utf8"));

/**
 * The dungeon generator end to end (docs/design/design-v1-dungeon-generator.md
 * 14, prefix DG), on the real server serving the production build: the DM
 * on a desktop and Pat on a phone. New scene's Builder form offers Generate
 * a dungeon, off on hexes with its note. The dialog draws a fixed seed's
 * preview with its status line, reads a bad seed and another version's,
 * rerolls, and drops a late preview when closed. Make sends every op in
 * one Setup group, the scene opens framed on its entrance with no starting
 * view stored, one Undo setup takes it back and Redo setup brings it back,
 * a generated door opens from the map, and Pat on Explore gets only what
 * the party saw. Make's main-thread time is measured under Chrome's 4x CPU
 * slowdown, with a DM who hides the dialog and opens the scene mid-send.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty-three. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 43;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-dungeon-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
/** A seed of this generator's version, so its dungeon is the same on every run. */
const SEED = `${versionChar()}K7Q-H2MX-A9F0-TW15`;
/** The same seed as a DM might type it: lower case, spaces, O for 0 and L for 1. */
const SEED_TYPED = `${versionChar().toLowerCase()}k7q h2mx a9fo twl5`;
/** The words for a seed that does not read, its example a seed of this version. */
const SEED_BAD = `A seed is 16 letters and digits, like ${versionChar()}K7Q-H2MX-A9F3-TWQ5.`;
/** A seed whose version character is not this generator's. */
const OTHER_VERSION = `${versionChar(GENERATOR_VERSION + 1)}K7Q-H2MX-A9F3-TWQ5`;
/** Main-thread limits under the 4x slowdown (design section 8). */
const TASK_LIMIT_MS = 100;

/**
 * The reference task's time at 4x on a quiet computer of the kind the 100 ms
 * limit was set on (23 to 24 ms), where Make's dispatch task reads under
 * 70 ms. A slower machine, such as a CI runner with two shared CPUs, stretches
 * both alike, so the limit grows with the reference task there and never
 * shrinks below 100 ms. A fixed limit failed on the runner (106 and 118 ms),
 * and none at all would let any regression through.
 */
const REFERENCE_QUIET_MS = 25;

/** The design's limit, scaled by how much slower this machine runs the reference task than the quiet one. */
function taskLimit(referenceMs: number): number {
  return Math.round(TASK_LIMIT_MS * Math.max(1, referenceMs / REFERENCE_QUIET_MS));
}

/**
 * A fixed piece of main-thread work shaped like Make's dispatch (objects
 * built, written as JSON and read back, and filed in a Map), timed in the
 * page as one task. The least of five, since a busy machine only ever adds.
 */
async function referenceTaskMs(page: Page): Promise<number> {
  let least = Infinity;
  for (let k = 0; k < 5; k++) {
    least = Math.min(least, await page.evaluate(() => {
      const perf = (globalThis as unknown as { performance: { now(): number } }).performance;
      const start = perf.now();
      const cells: { id: string; x: number; y: number; terrain: Record<string, number> }[] = [];
      for (let i = 0; i < 20_000; i++) cells.push({ id: `c${i}`, x: i % 97, y: (i * 7) % 89, terrain: { [`t${i % 13}`]: i } });
      const back = JSON.parse(JSON.stringify(cells)) as typeof cells;
      const byId = new Map<string, (typeof cells)[number]>();
      for (const c of back) byId.set(c.id, c);
      if (byId.size !== cells.length) throw new Error("the reference task lost a cell");
      return perf.now() - start;
    }));
  }
  return least;
}

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let dmCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E dungeon ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  firstSceneId: "",
  patId: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  sceneId: "",
  /** What each measure found, for the report. */
  measured: [] as string[],
};

function state(socket: SocketWatch): RoomState | null {
  return socket.state;
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

async function scenesPanel(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.isVisible())) {
    await openSideTab(page, "Scenes");
    return page.getByRole("tabpanel", { name: sideTabName("Scenes") });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
  if ((await sheet.count()) > 0 && (await sheet.isVisible())) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Scenes/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** New scene's form, opened first where it is folded, as a phone folds it once the room has a scene (docs/design/design-v1-panel-groups.md 6.2). */
function newSceneForm(panel: Locator): Promise<Locator> {
  return openSceneGroup(panel, "New scene");
}

function dialogOf(page: Page): Locator {
  return page.getByRole("dialog", { name: "Generate a dungeon" });
}

/** The status line at the dialog's foot once a preview stands, read when it holds still. It keeps the old dungeon's counts, busy, while the next one draws. */
async function statusText(dialog: Locator, timeout = 30_000): Promise<string> {
  const line = dialog.locator("footer [aria-live=polite]:not([aria-busy=true])");
  await line.waitFor({ timeout });
  let last = "";
  await waitFor("the status line to hold still", async () => {
    const now = (await line.innerText()).trim();
    const still = now === last && now !== "";
    last = now;
    return still ? now : null;
  });
  return last;
}

async function previewImg(dialog: Locator): Promise<Locator> {
  const img = dialog.getByRole("img", { name: /^Preview of the dungeon: \d+ rooms?(, \d+ secret doors?)?(, \d+ lit rooms?)?, entrance on the (west|north|east|south) side\.$/ });
  await img.waitFor({ timeout: 30_000 });
  return img;
}

/** New scene's Builder form, then Generate a dungeon, once its preview has drawn. */
async function openDialog(page: Page): Promise<Locator> {
  const form = await newSceneForm(await scenesPanel(page));
  if ((await form.getByRole("button", { name: "Generate a dungeon", exact: true }).count()) === 0) await form.getByRole("radio", { name: "Builder", exact: true }).click();
  await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();
  const dialog = dialogOf(page);
  await previewImg(dialog);
  return dialog;
}

/** A named mark under one of the dialog's sliders. */
function mark(dialog: Locator, slider: string, name: string): Locator {
  return dialog.getByRole("group", { name: `${slider} marks`, exact: true }).getByRole("button", { name, exact: true });
}

async function seedField(dialog: Locator): Promise<Locator> {
  return dialog.getByRole("textbox", { name: "Seed", exact: true });
}

/**
 * Holds or fails the page's canvas encoding, which the preview's picture
 * waits on after the worker has answered: "hold" queues each encode until
 * `releaseEncodes`, "fail" answers it with no image, "pass" lets it run.
 * The dialog sends nothing while open, so no other picture is drawn then.
 */
async function encodes(page: Page, mode: "hold" | "fail" | "pass"): Promise<void> {
  await page.evaluate((m) => {
    type Cb = (blob: Blob | null) => void;
    type Proto = { toBlob(this: unknown, cb: Cb, ...rest: unknown[]): void };
    const g = globalThis as unknown as { __dgEncode?: { mode: string; held: (() => void)[] }; HTMLCanvasElement: { prototype: Proto } };
    if (!g.__dgEncode) {
      const gate = { mode: "pass", held: [] as (() => void)[] };
      g.__dgEncode = gate;
      const proto = g.HTMLCanvasElement.prototype;
      const own = proto.toBlob;
      proto.toBlob = function (this: unknown, cb: Cb, ...rest: unknown[]) {
        if (gate.mode === "fail") return void cb(null);
        if (gate.mode === "hold") return void gate.held.push(() => own.call(this, cb, ...rest));
        own.call(this, cb, ...rest);
      };
    }
    g.__dgEncode.mode = m;
  }, mode);
}

/** How many encodes wait on the hold, each one a picture whose answer is in. */
function heldEncodes(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __dgEncode?: { held: unknown[] } }).__dgEncode?.held.length ?? 0);
}

/** Lets every held encode run, and later ones pass. */
async function releaseEncodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (globalThis as unknown as { __dgEncode?: { mode: string; held: (() => void)[] } }).__dgEncode;
    if (!gate) return;
    gate.mode = "pass";
    for (const run of gate.held.splice(0)) run();
  });
}

/** The ops this page sent since `from`, as the frames carry them. */
function opsSent(socket: SocketWatch, from: number): { op: { t: string; scene?: { id: string; defaultView?: unknown } }; g?: string; groupScope?: string }[] {
  return socket.sent
    .slice(from)
    .map((f) => JSON.parse(f) as { t: string })
    .filter((m): m is { t: "op"; op: { t: string }; g?: string; groupScope?: string } => m.t === "op") as never;
}

/**
 * Presses Make under Chrome's 4x CPU slowdown and waits for the dialog to
 * close. `dispatchMs` is the task the press ran in, where every op is
 * dispatched (0 when it was no long task). `makeMs` is the main thread's
 * task time from the press to the dialog closing (CDP's TaskDuration), the
 * answers and the new scene's first drawing included, and `tasks` every
 * long task (over 50 ms) in that span. `limitMs` is the dispatch task's
 * limit on this machine, from the reference task timed just before.
 */
async function makeMeasured(dialog: Locator): Promise<{ makeMs: number; dispatchMs: number; tasks: number[]; limitMs: number; referenceMs: number }> {
  await dmCdp.send("Performance.enable");
  await dmCdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    const referenceMs = await referenceTaskMs(dm);
    await watchLongTasks(dm);
    await dm.evaluate(() => {
      const g = globalThis as unknown as { __dgPressAt: number | null; addEventListener(t: string, f: () => void, o: unknown): void; performance: { now(): number } };
      g.__dgPressAt = null;
      g.addEventListener("click", () => (g.__dgPressAt ??= g.performance.now()), { capture: true, once: true });
    });
    const taskSeconds = (m: { metrics: { name: string; value: number }[] }) => m.metrics.find((x) => x.name === "TaskDuration")?.value ?? 0;
    const before = taskSeconds(await dmCdp.send("Performance.getMetrics"));
    await dialog.getByRole("button", { name: "Make the scene", exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: 60_000 });
    const after = taskSeconds(await dmCdp.send("Performance.getMetrics"));
    const read = await dm.evaluate(() => {
      const g = globalThis as unknown as { __dgTasks: { start: number; duration: number }[]; __dgPressAt: number | null };
      return { tasks: g.__dgTasks, pressAt: g.__dgPressAt };
    });
    assert.ok(read.pressAt !== null, "the press reached the page");
    const press = read.tasks.find((t) => read.pressAt !== null && t.start <= read.pressAt && read.pressAt <= t.start + t.duration);
    return { makeMs: Math.round((after - before) * 1000), dispatchMs: Math.round(press?.duration ?? 0), tasks: read.tasks.map((t) => Math.round(t.duration)), limitMs: taskLimit(referenceMs), referenceMs: Math.round(referenceMs) };
  } finally {
    await dmCdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
}

/** Whether the map's canvas is what a tap at `p` and a little round it would reach. */
function canvasOnTop(page: Page, p: { x: number; y: number }): Promise<boolean> {
  return page.evaluate((at) => {
    type El = { closest(s: string): El | null };
    const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): El | null } }).document;
    return [[0, 0], [-12, 0], [12, 0], [0, -12], [0, 12]].every(([dx, dy]) => doc.elementFromPoint(at.x + dx!, at.y + dy!)?.closest(".konvajs-content") != null);
  }, p);
}

/** Starts keeping the page's long tasks (over 50 ms), each with its start, in `__dgTasks`, afresh. */
function watchLongTasks(page: Page): Promise<void> {
  return page.evaluate(() => {
    type Observer = { observe(o: unknown): void; disconnect(): void };
    const g = globalThis as unknown as { __dgTasks: { start: number; duration: number }[]; __dgObserver?: Observer; PerformanceObserver: new (cb: (l: { getEntries(): { startTime: number; duration: number }[] }) => void) => Observer };
    g.__dgObserver?.disconnect();
    g.__dgTasks = [];
    g.__dgObserver = new g.PerformanceObserver((list) => {
      for (const e of list.getEntries()) g.__dgTasks.push({ start: e.startTime, duration: e.duration });
    });
    g.__dgObserver.observe({ type: "longtask", buffered: false });
  });
}

function sceneChunks(s: RoomState | null, sceneId: string): BuildChunk[] {
  return Object.values(s?.buildChunks ?? {}).filter((c): c is BuildChunk => !!c && c.sceneId === sceneId);
}

function paintedCells(s: RoomState | null, sceneId: string): number {
  let n = 0;
  for (const c of sceneChunks(s, sceneId)) n += Object.keys(c.cells).length;
  return n;
}

describe("dungeon generator", { concurrency: false }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await dmContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmCdp = await dmContext.newCDPSession(dm);
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (run.measured.length > 0) console.log(`DG measured:\n${run.measured.join("\n")}`);
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

  test("DG-0. the DM's room on a desktop, and Pat with Thorn on a phone", async () => {
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
    await waitFor("the DM's snapshot", () => state(dmSocket));
    run.firstSceneId = state(dmSocket)!.meta.playerSceneId!;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.patId = await join(patContext, "Pat", "#30a46c");
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } });
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => state(patSocket));
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("DG-1. on hexes Generate a dungeon is off with its note, and on squares it opens the dialog with focus on Theme", async () => {
    const form = await newSceneForm(await scenesPanel(dm));
    await form.getByRole("radio", { name: "Builder", exact: true }).click();
    await form.getByText("Or start from a generated dungeon", { exact: true }).waitFor();
    const button = form.getByRole("button", { name: "Generate a dungeon", exact: true });
    await form.getByRole("radiogroup", { name: "Grid", exact: true }).getByRole("radio", { name: "Hex rows", exact: true }).check();
    await form.getByText("Generated dungeons are squares for now. Pick Squares above to make one.", { exact: true }).waitFor();
    assert.equal(await button.isDisabled(), true, "off on hexes");
    await shots.take(dm, "DG-1-hex-note");
    await form.getByRole("radiogroup", { name: "Grid", exact: true }).getByRole("radio", { name: "Squares", exact: true }).check();
    assert.equal(await button.isDisabled(), false);
    await form.getByLabel("Scene name").fill("Crypt of the north road");
    await button.click();
    const dialog = dialogOf(dm);
    await dialog.waitFor();
    await previewImg(dialog);
    const focused = await dm.evaluate(() => {
      const a = (globalThis as unknown as { document: { activeElement: { type?: string; value?: string } | null } }).document.activeElement;
      return { type: a?.type ?? null, value: a?.value ?? null };
    });
    assert.deepEqual(focused, { type: "radio", value: "dungeon" }, "focus opens on Theme");
    // DGOPTS: Party level says what it changes.
    const band = dialog.getByRole("radiogroup", { name: "Party level", exact: true });
    const helpId = await band.getAttribute("aria-describedby");
    assert.ok(helpId, "Party level has its help");
    assert.equal(await dialog.locator(`[id="${helpId}"]`).textContent(), "How strong the traps are: their save DCs, damage and pit depths follow the SRD for a party of these levels.");
  });

  test("DG-2. a fixed seed draws the same dungeon each time, read case-blind with O as 0 and L as 1, a bad seed keeps the old preview with Make off, and another version's says so", async () => {
    const dialog = dialogOf(dm);
    const seed = await seedField(dialog);
    const make = dialog.getByRole("button", { name: "Make the scene", exact: true });
    await seed.fill(SEED);
    const first = await statusText(dialog);
    assert.match(first, /^\d+ rooms, \d+ doors?( \(\d+ locked\))?, (no traps|\d+ traps?)\.$/);
    const name = await (await previewImg(dialog)).getAttribute("alt");
    await dialog.getByRole("button", { name: "Reroll", exact: true }).click();
    await waitFor("a new seed", async () => ((await seed.inputValue()) !== SEED ? true : null));
    assert.match(await seed.inputValue(), /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await statusText(dialog);
    await seed.fill(SEED_TYPED);
    await waitFor("the typed seed's status", async () => ((await statusText(dialog)) === first ? true : null));
    assert.equal(await (await previewImg(dialog)).getAttribute("alt"), name, "the same dungeon from the typed seed");
    await shots.take(dm, "DG-2-fixed-seed");

    await seed.fill(SEED.slice(0, 9));
    await dialog.getByText(SEED_BAD, { exact: true }).waitFor();
    assert.equal(await make.isDisabled(), true, "Make is off for a bad seed");
    assert.equal(await (await previewImg(dialog)).getAttribute("alt"), name, "the old preview stays");
    await shots.take(dm, "DG-2-bad-seed");

    await seed.fill(OTHER_VERSION);
    await dialog.getByText("This seed is from another version of the generator, so it makes a different dungeon now.", { exact: true }).waitFor();
    await statusText(dialog);
    await seed.fill(SEED);
    assert.equal(await statusText(dialog), first);
    assert.equal(await make.isDisabled(), false);

    // DG-R1-09: Copy seed copies the seed as read, in its usual form, not the text as typed.
    await seed.fill(SEED_TYPED);
    await waitFor("the typed seed's status", async () => ((await statusText(dialog)) === first ? true : null));
    await dialog.getByRole("button", { name: "Copy seed", exact: true }).click();
    const copied = await waitFor("the copied seed", () => dm.evaluate(() => (globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }).navigator.clipboard.readText()).then((t) => (t ? t : null)));
    assert.equal(copied, SEED);
    await seed.fill(SEED);
    await statusText(dialog);
  });

  test("DGFIX-1. Make waits for the picture: answered previews still drawing keep Make off with Drawing the dungeon on, a newer answer mid-drawing too, and a picture that fails says so", async () => {
    const dialog = dialogOf(dm);
    const make = dialog.getByRole("button", { name: "Make the scene", exact: true });
    const reroll = dialog.getByRole("button", { name: "Reroll", exact: true });
    const drawing = dialog.getByText("Drawing the dungeon…", { exact: true });
    const status = dialog.locator("footer [aria-live=polite]");
    const counts = await statusText(dialog);
    const was = await (await previewImg(dialog)).getAttribute("alt");
    await encodes(dm, "hold");
    try {
      await reroll.click();
      await waitFor("the first answer's picture held", async () => ((await heldEncodes(dm)) >= 1 ? true : null));
      await drawing.waitFor();
      assert.equal(await make.isDisabled(), true, "answered, its picture not in: Make off");
      assert.deepEqual([(await status.innerText()).trim(), await status.getAttribute("aria-busy")], [counts, "true"], "the counts of the dungeon still shown, busy, never of one not shown");
      assert.equal(await (await previewImg(dialog)).getAttribute("alt"), was, "the old picture stays while the new one draws");
      // A newer answer arrives while the first is still drawing.
      await reroll.click();
      await waitFor("the newer answer's picture held", async () => ((await heldEncodes(dm)) >= 2 ? true : null));
      assert.equal(await make.isDisabled(), true, "a newer answer mid-drawing: Make still off");
      assert.equal(await drawing.isVisible(), true, "and still drawing");
      await shots.take(dm, "DGFIX-1-drawing-held");
    } finally {
      await releaseEncodes(dm);
    }
    await statusText(dialog);
    await waitFor("Make on once the newest picture shows", async () => ((await make.isDisabled()) ? null : true));
    assert.equal(await drawing.count(), 0, "the indicator goes once the picture is in");

    await encodes(dm, "fail");
    try {
      await reroll.click();
      await dialog.getByText("This device could not draw the preview, so Make is off. Reroll or change a choice to try again.", { exact: true }).waitFor();
      assert.equal(await make.isDisabled(), true, "a failed picture: Make off");
      assert.equal(await dialog.getByRole("img", { name: /^Preview of the dungeon/ }).count(), 0, "no older picture stands for it");
      assert.equal(await status.count(), 0, "nor its counts");
      assert.equal(await drawing.count(), 0, "nothing still drawing");
      await shots.take(dm, "DGFIX-1-picture-failed");
    } finally {
      await encodes(dm, "pass");
    }
    await reroll.click();
    await statusText(dialog);
    await waitFor("Make back on", async () => ((await make.isDisabled()) ? null : true));
  });

  test("DG-3. quick choice changes then Cancel while drawing send nothing, and the dialog opens again on the same choices with a new seed", async () => {
    const dialog = dialogOf(dm);
    const sent = dmSocket.sent.length;
    const scenes = Object.keys(state(dmSocket)!.scenes).length;
    await dialog.getByRole("radio", { name: "Crypt", exact: true }).check();
    await dialog.getByRole("radio", { name: "Small", exact: true }).check();
    await dialog.getByRole("radio", { name: "Wide", exact: true }).check();
    // DGOPTS: Page Up jumps Heights to its next mark, a tap on a Traps mark sets it, the arrows step between, and each reads in words.
    const heights = dialog.getByRole("slider", { name: "Heights", exact: true });
    const traps = dialog.getByRole("slider", { name: "Traps", exact: true });
    await heights.focus();
    await heights.press("PageUp");
    assert.equal(await heights.inputValue(), "50", "Page Up from Some to Many");
    assert.equal(await heights.getAttribute("aria-valuetext"), "About 3 rooms of 6 off flat ground");
    await mark(dialog, "Traps", "Many").click();
    assert.equal(await traps.inputValue(), "6");
    assert.equal(await mark(dialog, "Traps", "Many").getAttribute("aria-pressed"), "true");
    assert.equal(await traps.getAttribute("aria-valuetext"), "About 3 traps");
    await traps.press("ArrowLeft");
    assert.equal(await traps.getAttribute("aria-valuetext"), "About 2 traps");
    assert.equal(await mark(dialog, "Traps", "Many").getAttribute("aria-pressed"), "false", "between marks");
    await traps.press("End");
    await shots.take(dm, "DGOPTS-sliders");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await dm.waitForTimeout(1_000);
    assert.equal(opsSent(dmSocket, sent).length, 0, "nothing sent before Make");
    assert.equal(Object.keys(state(dmSocket)!.scenes).length, scenes);
    assert.deepEqual(consoles.dm.errors, [], "a late preview after closing logged nothing");

    const form = await newSceneForm(await scenesPanel(dm));
    await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("radio", { name: "Crypt", exact: true }).isChecked(), true, "remembered theme");
    assert.equal(await dialog.getByRole("radio", { name: "Small", exact: true }).isChecked(), true, "remembered size");
    assert.notEqual((await (await seedField(dialog)).inputValue()).replace(/-/g, ""), SEED.replace(/-/g, ""), "never a remembered seed");
    const stored = await dm.evaluate((id) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(`rvtt.dungeon.${id}`), run.roomId);
    assert.ok(stored && !/seed/i.test(stored), `stored choices: ${stored}`);
    assert.equal(await dialog.getByRole("slider", { name: "Heights", exact: true }).inputValue(), "50", "remembered Heights");
    assert.equal(await dialog.getByRole("slider", { name: "Traps", exact: true }).inputValue(), "6", "remembered Traps");
    // Back to the defaults this run measures.
    await mark(dialog, "Heights", "Some").click();
    await mark(dialog, "Traps", "Few").click();
    await dialog.getByRole("radio", { name: "Dungeon", exact: true }).check();
    await dialog.getByRole("radio", { name: "Medium", exact: true }).check();
    await dialog.getByRole("radio", { name: "Narrow", exact: true }).check();
  });

  test("DG2C-1. the new rows: five themes, Dead ends, Secret doors held on Cave and back, Lit rooms with its light line, Dressing and DM key", async () => {
    const dialog = dialogOf(dm);
    for (const theme of ["Dungeon", "Crypt", "Cave", "Mine", "Sewer"]) assert.equal(await dialog.getByRole("radio", { name: theme, exact: true }).count(), 1, theme);
    const deadEnds = dialog.getByRole("switch", { name: "Dead ends", exact: true });
    assert.equal(await deadEnds.getAttribute("aria-checked"), "true", "Dead ends start on");
    assert.equal(await dialog.getByRole("switch", { name: "DM key", exact: true }).getAttribute("aria-checked"), "true", "DM key starts on");
    assert.equal(await dialog.getByRole("radio", { name: "Some", exact: true }).first().isVisible(), true, "Dressing");

    // Secret doors: a mark sets it, Cave holds it at None with its line, and the DM's pick comes back with the next theme.
    // While the landing holds secret doors (ops.ts `SECRET_DOORS_HELD`), every theme holds the row at None with its own line.
    const secrets = dialog.getByRole("slider", { name: "Secret doors", exact: true });
    if (SECRET_DOORS_HELD) {
      assert.equal(await secrets.isDisabled(), true, "held while the landing holds them");
      assert.equal(await secrets.inputValue(), "0");
      await dialog.getByText("Secret doors come in a later version of the app.", { exact: true }).waitFor();
      await statusText(dialog);
      await secrets.scrollIntoViewIfNeeded();
      await shots.take(dm, "DG2M-secrets-held");
    } else {
      await mark(dialog, "Secret doors", "Many").click();
      assert.equal(await secrets.inputValue(), "4");
    }
    await dialog.getByRole("radio", { name: "Cave", exact: true }).check();
    assert.equal(await secrets.isDisabled(), true, "held on Cave");
    assert.equal(await secrets.inputValue(), "0");
    assert.equal(await secrets.getAttribute("aria-valuetext"), "No secret doors");
    await dialog.getByText("Caves have no doors, so none are secret.", { exact: true }).waitFor();
    await statusText(dialog);
    await shots.take(dm, "DG2C-1-cave-secrets-held");
    await dialog.getByRole("radio", { name: "Mine", exact: true }).check();
    if (SECRET_DOORS_HELD) {
      assert.equal(await secrets.isDisabled(), true, "still held off Cave");
      await dialog.getByText("Secret doors come in a later version of the app.", { exact: true }).waitFor();
    } else {
      assert.equal(await secrets.isDisabled(), false, "free again off Cave");
      assert.equal(await secrets.inputValue(), "4", "the DM's pick came back");
      await mark(dialog, "Secret doors", "Few").click();
    }

    // Lit rooms: Page Up jumps to the next mark, and its words and help follow the theme.
    const lit = dialog.getByRole("slider", { name: "Lit rooms", exact: true });
    assert.equal(await lit.inputValue(), "25");
    await lit.focus();
    await lit.press("PageUp");
    assert.equal(await lit.inputValue(), "50");
    assert.match((await lit.getAttribute("aria-valuetext")) ?? "", /^About \d+ of \d+ rooms lit$/);
    await dialog.getByText("Each lit room has a lantern that lights it as a hooded lantern does.", { exact: true }).waitFor();
    await mark(dialog, "Lit rooms", "Few").click();

    // The light line swaps in place with focus on the button, and a Lit rooms change keeps the tap.
    await dialog.getByText("The scene starts dark with party vision on, so its lights light it for the party.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Keep it lit", exact: true }).click();
    const startDark = dialog.getByRole("button", { name: "Start it dark", exact: true });
    await startDark.waitFor();
    await dialog.getByText("Start the scene dark with party vision on, so its lights light it for the party.", { exact: true }).waitFor();
    assert.equal(await startDark.evaluate((el) => el === el.ownerDocument.activeElement), true, "focus stays on the button");
    await mark(dialog, "Lit rooms", "Half").click();
    await startDark.waitFor();
    await mark(dialog, "Lit rooms", "None").click();
    assert.equal(await dialog.getByRole("button", { name: /^(Keep it lit|Start it dark)$/ }).count(), 0, "no lights, no light line");
    await mark(dialog, "Lit rooms", "Few").click();
    await startDark.waitFor();
    await statusText(dialog);
    await shots.take(dm, "DG2C-1-lit-rooms");
  });

  test("DG2C-2. Look closer opens the DM view in the viewer, zooms with the + key, and closing returns focus to its button", async () => {
    const dialog = dialogOf(dm);
    await statusText(dialog);
    const look = dialog.getByRole("button", { name: "Look closer", exact: true });
    assert.equal(await look.isEnabled(), true);
    await look.click();
    const picture = dm.getByRole("img", { name: /, the DM view$/ });
    await picture.waitFor({ timeout: 30_000 });
    const viewer = dm.getByRole("dialog").filter({ has: picture });
    await viewer.getByText("The DM view: secret doors, traps and room numbers show only here.", { exact: true }).waitFor();
    const before = await picture.boundingBox();
    await dm.keyboard.press("+");
    await waitFor("the picture grown", async () => (((await picture.boundingBox())?.width ?? 0) > (before?.width ?? 0) ? true : null), 5_000);
    await shots.take(dm, "DG2C-2-look-closer");
    await dm.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    assert.equal(await look.evaluate((el) => el === el.ownerDocument.activeElement), true, "focus is back on Look closer");
    assert.equal(await dialog.count(), 1, "the dialog stays");
  });

  test("DG-4. Make sends every op in one Setup group, its dispatch task under 100 ms at the 4x slowdown, and the scene opens framed on its entrance with no starting view", async () => {
    const dialog = dialogOf(dm);
    await (await seedField(dialog)).fill(SEED);
    await statusText(dialog);
    // DG2C-1 left Keep it lit tapped: the scene starts as the form says, which later cases rely on.
    const sent = dmSocket.sent.length;
    const known = new Set(Object.keys(state(dmSocket)!.scenes));
    const { makeMs, dispatchMs, tasks, limitMs, referenceMs } = await makeMeasured(dialog);
    run.measured.push(`Make at 4x, default choices: the dispatch task ${dispatchMs} ms (limit ${limitMs} ms, the reference task ${referenceMs} ms), ${makeMs} ms of main-thread tasks from the press to the dialog closing (the answers and the new scene's first drawing included), long tasks ${JSON.stringify(tasks)}`);

    const frames = opsSent(dmSocket, sent);
    assert.ok(frames.length >= 2 && frames.length <= 100, `${frames.length} ops`);
    assert.equal(frames[0]!.op.t, "scene.create", "the scene first");
    assert.equal(new Set(frames.map((f) => f.g)).size, 1, "one group");
    assert.ok(frames.every((f) => f.g && f.groupScope === "setup"), "a Setup group");
    assert.ok(frames.every((f) => ["scene.create", "build.paint", "build.edge", "build.height", "build.stairs", "build.stamps", "build.lights", "token.create", "trap.create", "journal.create", "pin.put"].includes(f.op.t)), frames.map((f) => f.op.t).join(", "));
    assert.equal(frames[0]!.op.scene?.defaultView, undefined, "no starting view sent");
    run.sceneId = frames[0]!.op.scene!.id;
    assert.ok(!known.has(run.sceneId), "a fresh scene id");

    await waitFor("the DM on the new scene", () => (dmSocket.you?.sceneId === run.sceneId ? true : null), 30_000);
    const scene = await waitFor("the new scene stored", () => state(dmSocket)?.scenes[run.sceneId]);
    assert.equal(scene.defaultView, undefined, "no starting view stored");
    assert.equal(scene.name, "Crypt of the north road");
    await waitFor("the build on the DM's page", () => (paintedCells(state(dmSocket), run.sceneId) > 0 ? true : null));
    // Framed on the entrance: zoomed well past a fit of the whole scene, and centered inside it.
    const cam = await waitFor("the camera", () => readCamera(dm));
    const box = (await dm.locator(".konvajs-content").first().boundingBox())!;
    const whole = Math.min(box.width / scene.bounds.w, box.height / scene.bounds.h);
    assert.ok(cam.scale > whole * 1.5, `zoom ${cam.scale} against a whole fit of ${whole}`);
    const center = { x: (box.width / 2 - cam.x) / cam.scale, y: (box.height / 2 - cam.y) / cam.scale };
    assert.ok(center.x > 0 && center.y > 0 && center.x < scene.bounds.w && center.y < scene.bounds.h, `center ${JSON.stringify(center)}`);
    await shots.take(dm, "DG-4-framed-entrance");
    assert.ok(dispatchMs <= limitMs, `Make's dispatch task took ${dispatchMs} ms at 4x, over ${limitMs} ms here (the reference task ${referenceMs} ms)`);
  });

  test("DG-5. one Undo setup takes the whole dungeon back, and Redo setup brings it back", async () => {
    await undoSetup(dm);
    await waitFor("the dungeon gone", () => (state(dmSocket)?.scenes[run.sceneId] ? null : true), 30_000);
    const { setupHistory } = await import("./helpers/undoScope.ts");
    const { sheet } = await setupHistory(dm);
    const redo = sheet.getByRole("button", { name: "Redo setup", exact: true });
    await redo.click();
    await sheet.locator("[data-history-result]").filter({ hasText: /^Redid setup: / }).waitFor();
    await dm.keyboard.press("Escape");
    await waitFor("the dungeon back", () => state(dmSocket)?.scenes[run.sceneId], 30_000);
  });

  test("DG-6. a generated door opens from the map", async () => {
    await scenesPanel(dm).then((panel) => panel.getByRole("button", { name: /^Crypt of the north road/ }).first().click());
    await waitFor("the DM on the dungeon", () => (dmSocket.you?.sceneId === run.sceneId && paintedCells(state(dmSocket), run.sceneId) > 0 ? true : null), 30_000);
    await dm.keyboard.press("Escape");
    await pickTool(dm, "Select");
    // A closed door the map shows clear of the bars and panes over it, so the tap lands on the canvas.
    const scene = state(dmSocket)!.scenes[run.sceneId]!;
    let door: { key: string; at: { x: number; y: number } } | null = null;
    for (const chunk of sceneChunks(state(dmSocket), run.sceneId)) {
      for (const [key, f] of Object.entries(chunk.edges)) {
        if (door || f.kind !== "door" || f.state !== "closed") continue;
        const [x, y, side] = key.split(",") as [string, string, string];
        const mid = side === "n" ? { x: Number(x) + 0.5, y: Number(y) } : { x: Number(x), y: Number(y) + 0.5 };
        const at = await pagePoint(dm, scene.bounds, mid);
        if (await canvasOnTop(dm, at)) door = { key, at };
      }
    }
    assert.ok(door, "a closed door of the dungeon on screen");
    await dm.mouse.click(door.at.x, door.at.y);
    const pill = dm.getByRole("group", { name: "Closed door" });
    await pill.getByRole("button", { name: "Open", exact: true }).click();
    await waitFor("the door open", () => {
      for (const c of sceneChunks(state(dmSocket), run.sceneId)) if (c.edges[door!.key]?.kind === "door" && (c.edges[door!.key] as { state?: string }).state === "open") return true;
      return null;
    });
    await shots.take(dm, "DG-6-door-open");
  });

  test("DG-7. Pat on Explore sees no starting view, no unseen room, no trap, and locked doors as closed", async () => {
    const before = state(patSocket);
    assert.equal(before?.scenes[run.sceneId], undefined, "nothing of the new scene while it is not the players' scene");
    // Thorn at the foot of the entrance's stairs: the stub's stair at the map's edge.
    const stairs: { x: number; y: number }[] = [];
    const scene = state(dmSocket)!.scenes[run.sceneId]!;
    for (const c of sceneChunks(state(dmSocket), run.sceneId)) {
      const up = c.up;
      if (!up) continue;
      for (let i = 0; i < up.length; i++) {
        if (up[i] === ".") continue;
        const x = c.cx * CHUNK_CELLS + (i % CHUNK_CELLS);
        const y = c.cy * CHUNK_CELLS + Math.floor(i / CHUNK_CELLS);
        if (x === 0 || y === 0 || x === scene.bounds.w - 1 || y === scene.bounds.h - 1) stairs.push({ x, y });
      }
    }
    assert.ok(stairs.length > 0, "the entrance stub's stairs at the map edge");
    await ops.send({ t: "token.create", token: { id: run.thorn, sceneId: run.sceneId, kind: "pc", name: "Thorn", size: "medium", visibility: "all", x: stairs[0]!.x, y: stairs[0]!.y, disposition: "ally", actor: { ref: run.thornChar } } });
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    const seen = await waitFor("the dungeon in Pat's copy", () => state(patSocket)?.scenes[run.sceneId], 30_000);
    assert.equal(seen.defaultView, undefined, "no starting view");
    await waitFor("Thorn's ground in Pat's copy", () => (paintedCells(state(patSocket), run.sceneId) > 0 ? true : null), 30_000);
    const theirs = paintedCells(state(patSocket), run.sceneId);
    const ours = paintedCells(state(dmSocket), run.sceneId);
    assert.ok(theirs < ours, `Pat holds ${theirs} of ${ours} painted squares`);
    assert.deepEqual(Object.values(state(patSocket)?.traps ?? {}).filter((t) => t?.sceneId === run.sceneId), [], "no unfound trap");
    for (const c of sceneChunks(state(patSocket), run.sceneId)) {
      for (const f of Object.values(c.edges)) if (f.kind === "door") assert.notEqual((f as { state?: string }).state, "locked", "a locked door reads closed");
    }
    assert.ok(!patSocket.everSaw(SEED.slice(0, 4)) && !patSocket.everSaw(SEED.replace(/-/g, "").slice(4, 12)), "the seed never reaches a player");
    await shots.take(pat, "DG-7-pat-explore");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.firstSceneId });
  });

  test("DG-8. a DM who hides the dialog offline and opens the new scene mid-send: measured at 4x, and the dungeon lands", async () => {
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    const form = await newSceneForm(await scenesPanel(dm));
    await form.getByRole("radio", { name: "Builder", exact: true }).click();
    await form.getByLabel("Scene name").fill("Second dungeon");
    await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();
    const dialog = dialogOf(dm);
    // Custom, so Across and Down show and are checked held with Rooms.
    await dialog.getByRole("radio", { name: "Custom", exact: true }).check();
    await (await seedField(dialog)).fill(SEED);
    await statusText(dialog);
    const sent = dmSocket.sent.length;
    consoles.dm.expectSocketFailures = true;
    await dmContext.setOffline(true);
    try {
      await dialog.getByRole("button", { name: "Make the scene", exact: true }).click();
      await dialog.getByText("Waiting for the server…").first().waitFor({ timeout: 15_000 });
      await shots.take(dm, "DG-8-waiting");
      // DG-R1-02, DGBUILD-ASTRA-3: every choice is held while the send waits, the number fields too, so none draws a preview the queued ops are not.
      for (const name of ["Across", "Down", "Rooms", "Seed"]) assert.equal(await dialog.getByRole("textbox", { name, exact: true }).isDisabled(), true, `${name} held`);
      for (const name of ["Crypt", "Small", "Dense", "Winding", "Wide"]) assert.equal(await dialog.getByRole("radio", { name, exact: true }).first().isDisabled(), true, `${name} held`);
      assert.equal(await dialog.getByRole("switch", { name: "Extra ways around" }).isDisabled(), true, "Extra ways around held");
      for (const name of ["Heights", "Traps"]) {
        assert.equal(await dialog.getByRole("slider", { name, exact: true }).isDisabled(), true, `${name} held`);
        assert.equal(await mark(dialog, name, name === "Heights" ? "Most" : "Many").isDisabled(), true, `${name}'s marks held`);
      }
      assert.equal(await dialog.getByRole("button", { name: "Reroll", exact: true }).isDisabled(), true, "Reroll held");
      assert.equal(await dialog.getByRole("button", { name: "Copy seed", exact: true }).isDisabled(), false, "Copy seed stays");
      await dialog.getByRole("button", { name: "Hide", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      // DG-R1-10: a dungeon is on its way, so New scene starts over and a Create there makes no second scene.
      const name = (await newSceneForm(await scenesPanel(dm))).getByLabel("Scene name");
      assert.ok((await name.count()) === 0 || (await name.inputValue()) === "", "the form starts over once a hidden Make is sent");
      await dmCdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await watchLongTasks(dm);
      // scene.create is predicted, so the panel lists the scene while its build waits in the queue.
      const panel = await scenesPanel(dm);
      await panel.getByRole("button", { name: /^Second dungeon/ }).first().click();
      await dmContext.setOffline(false);
      await waitFor("the second dungeon on the DM's page", () => {
        const id = Object.values(state(dmSocket)?.scenes ?? {}).find((s) => s?.name === "Second dungeon")?.id;
        return id && dmSocket.you?.sceneId === id && paintedCells(state(dmSocket), id) > 0 ? id : null;
      }, 60_000);
    } finally {
      await dmContext.setOffline(false);
      await dmCdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      consoles.dm.expectSocketFailures = false;
    }
    const tasks = await dm.evaluate(() => (globalThis as unknown as { __dgTasks?: { duration: number }[] }).__dgTasks?.map((t) => Math.round(t.duration)) ?? []);
    run.measured.push(`Opening the scene mid-send at 4x: long tasks ${JSON.stringify(tasks)}`);
    const frames = opsSent(dmSocket, sent);
    assert.ok(frames.length >= 2 && new Set(frames.map((f) => f.g)).size === 1, "one group, sent on reconnect");
  });

  test("DG-8b. the largest choices: Make's one dispatch task stays under 100 ms at 4x, and its main-thread time is measured", async () => {
    const form = await newSceneForm(await scenesPanel(dm));
    if ((await form.getByRole("button", { name: "Generate a dungeon", exact: true }).count()) === 0) await form.getByRole("radio", { name: "Builder", exact: true }).click();
    await form.getByLabel("Scene name").fill("Largest dungeon");
    await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();
    const dialog = dialogOf(dm);
    const was = await statusText(dialog);
    await dialog.getByRole("radio", { name: "Custom", exact: true }).check();
    for (const [name, value] of [["Across", "100"], ["Down", "100"], ["Rooms", "40"]] as const) {
      const field = dialog.getByRole("textbox", { name, exact: true });
      await field.fill(value);
      await field.press("Enter");
    }
    for (const name of ["Dense", "Winding", "Wide"]) await dialog.getByRole("radio", { name, exact: true }).first().check();
    // The sliders' tops: the most rooms off flat ground and the most traps.
    await mark(dialog, "Heights", "Most").click();
    await mark(dialog, "Traps", "Many").click();
    await (await seedField(dialog)).fill(SEED);
    const status = await waitFor("the largest dungeon's status", async () => {
      const now = await statusText(dialog, 60_000);
      return now !== was ? now : null;
    }, 60_000);
    const { makeMs, dispatchMs, tasks, limitMs, referenceMs } = await makeMeasured(dialog);
    run.measured.push(`Make at 4x, the largest choices (${status}): the dispatch task ${dispatchMs} ms (limit ${limitMs} ms, the reference task ${referenceMs} ms), ${makeMs} ms of main-thread tasks from the press to the dialog closing (the answers and the new scene's first drawing included), long tasks ${JSON.stringify(tasks)} (the dispatch task is held to the design's ${TASK_LIMIT_MS} ms, scaled by the reference task on a slower machine. The span to the dialog closing also holds the new scene's first drawing, so it is reported, not held to the 300 ms of Make's own work)`);
    assert.ok(dispatchMs <= limitMs, `Make's dispatch task took ${dispatchMs} ms at 4x, over ${limitMs} ms here (the reference task ${referenceMs} ms)`);
    await shots.take(dm, "DG-8b-largest");
  });

  test("DG-9. the dialog within 1 px at the desktop and the phone", async () => {
    // Only a DM opens the dialog, so the phone is a second page of the DM's, loaded at a phone's width.
    const phone = await dmContext.newPage();
    const lines: string[] = [];
    try {
      await phone.setViewportSize(PHONE);
      await phone.goto(dm.url());
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      for (const [label, page] of [["desktop", dm], ["phone", phone]] as const) {
        const dialog = await openDialog(page);
        lines.push(...alignmentLines(await measureAlignment(dialog), `DG-9 dialog, ${label}`));
        await shots.take(page, `DG-9-${label}`);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
      }
    } finally {
      await phone.close();
    }
    assert.deepEqual(lines, []);
  });

  test("dmfix2-1. on a phone a dungeon drawing leaves the preview, Reroll and the foot where they stand, the foot counting the dungeon still shown until the next picture lands", async () => {
    const phone = await dmContext.newPage();
    try {
      await phone.setViewportSize(PHONE);
      await phone.goto(dm.url());
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      const dialog = await openDialog(phone);
      const counts = await statusText(dialog);
      const reroll = dialog.getByRole("button", { name: "Reroll", exact: true });
      const picture = dialog.getByRole("img", { name: /^Preview of the dungeon/ });
      const where = async () => ({ reroll: await reroll.boundingBox(), picture: await picture.boundingBox(), foot: await dialog.locator("footer").boundingBox() });
      const before = await where();
      await encodes(phone, "hold");
      try {
        await reroll.click();
        await waitFor("the answer's picture held", async () => ((await heldEncodes(phone)) >= 1 ? true : null));
        await dialog.getByText("Drawing the dungeon…", { exact: true }).waitFor();
        await shots.take(phone, "dmfix2-1-drawing");
        // The preview's height follows the body's, so a foot that loses its status line grows it and moves Reroll under the finger.
        assert.deepEqual(await where(), before, "drawing: Reroll, the picture and the foot hold still");
        const line = dialog.locator("footer [aria-live=polite]");
        assert.deepEqual([(await line.innerText()).trim(), await line.getAttribute("aria-busy")], [counts, "true"], "the foot counts the dungeon still shown, busy");
        assert.deepEqual(alignmentLines(await measureAlignment(dialog.locator("footer")), "dmfix2-1 foot while drawing"), []);
      } finally {
        await releaseEncodes(phone);
      }
      await statusText(dialog);
      await shots.take(phone, "dmfix2-1-drawn");
      assert.deepEqual(await where(), before, "the picture in: all three where they stood");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    } finally {
      await phone.close();
    }
  });

  test("DGOPTS-1. the Heights and Traps sliders whole within 1 px at 1440 x 900, 390 x 844 and 320 x 568 at 130%, dark and light: the marks on one row where they fit, else two shared evenly, no word cut", async () => {
    const page = await dmContext.newPage();
    const lines: string[] = [];
    try {
      for (const [label, size, scale] of [["computer", { width: 1440, height: 900 }, 1], ["phone", PHONE, 1], ["smallest", { width: 320, height: 568 }, 1.3]] as const) {
        for (const scheme of ["dark", "light"] as const) {
          await page.setViewportSize(size);
          if (!page.url().startsWith(server.origin)) await page.goto(server.origin);
          await page.evaluate((kv) => {
            for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
          }, { "rvtt.uiScale": String(scale), "rvtt.theme": scheme });
          await page.goto(dm.url());
          await page.getByRole("status", { name: "Connected" }).first().waitFor();
          const dialog = await openDialog(page);
          const at = `${label} ${scheme}`;
          for (const name of ["Heights", "Traps"]) {
            const slider = dialog.getByRole("slider", { name, exact: true });
            await slider.scrollIntoViewIfNeeded();
            const box = slider.locator("xpath=..");
            lines.push(...alignmentLines(await measureAlignment(box), `DGOPTS-1 ${name}, ${at}`));
            const read = await box.evaluate((el) => {
              type E = { getBoundingClientRect(): { top: number; left: number; right: number }; scrollWidth: number; clientWidth: number; textContent: string | null };
              const root = el as unknown as E & { querySelectorAll(s: string): ArrayLike<E> };
              const marks = Array.from(root.querySelectorAll("button"));
              const words = Array.from(root.querySelectorAll("span, label, p"));
              const edge = root.getBoundingClientRect();
              const tops = marks.map((m) => Math.round(m.getBoundingClientRect().top));
              return {
                count: marks.length,
                tops: [...new Set(tops)],
                firstRow: tops.filter((t) => t === tops[0]).length,
                narrowest: Math.min(...marks.map((m) => Math.round((m.getBoundingClientRect() as unknown as { width: number }).width))),
                cut: [...marks, ...words].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
                outside: [...marks, ...words].filter((e) => e.getBoundingClientRect().right > edge.right + 1 || e.getBoundingClientRect().left < edge.left - 1).map((e) => e.textContent),
              };
            });
            // Every mark keeps its 44 px: one row where they fit, else two shared evenly, and only on the smallest phone.
            if (read.tops.length !== (label === "smallest" && read.count > 4 ? 2 : 1) || read.firstRow < read.count / 2) lines.push(`DGOPTS-1 ${name}, ${at}: the marks stand on ${read.tops.length} rows, ${read.firstRow} on the first`);
            if (read.narrowest < 44) lines.push(`DGOPTS-1 ${name}, ${at}: a mark ${read.narrowest} px wide`);
            if (read.cut.length > 0) lines.push(`DGOPTS-1 ${name}, ${at}: cut ${JSON.stringify(read.cut)}`);
            if (read.outside.length > 0) lines.push(`DGOPTS-1 ${name}, ${at}: past the edge ${JSON.stringify(read.outside)}`);
          }
          // The sliders whole in the shot, their names clear of the preview that stays at the top on a phone.
          await dialog.getByRole("slider", { name: "Heights", exact: true }).evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "center" }));
          await shots.take(page, `DGOPTS-1-form-${label}-${scheme}`);
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
        }
      }
    } finally {
      // The size and theme are this device's, so the other pages of the run open as they did.
      await page.evaluate(() => {
        localStorage.removeItem("rvtt.uiScale");
        localStorage.removeItem("rvtt.theme");
      });
      await page.close();
    }
    assert.deepEqual(lines, []);
  });

  test("pe1-1. on a computer the dialog is xl and the preview fills its column, the choices keeping a side panel's width from a body of 736 px and splitting evenly below it, at 100% and 130%, within 1 px (docs/design/design-v1-polish-pass.md 3.4)", async () => {
    // The design's measured table, in layout px: the card, the preview's side and the choices' width, either side of the 802 px window where the choices reach 360.
    const WANT = [
      { scale: 1, width: 1440, height: 900, card: 1040, preview: 601, choices: 389 },
      { scale: 1, width: 1280, height: 720, card: 1040, preview: 529, choices: 461 },
      { scale: 1, width: 806, height: 900, card: 774, preview: 364, choices: 360 },
      { scale: 1, width: 794, height: 900, card: 762, preview: 356, choices: 356 },
      { scale: 1.3, width: 1440, height: 900, card: 1040, preview: 502, choices: 488 },
      { scale: 1.3, width: 1048, height: 900, card: 774, preview: 365, choices: 360 },
      { scale: 1.3, width: 1032, height: 900, card: 762, preview: 356, choices: 356 },
    ] as const;
    type Layout = { card: number; preview: number; previewHeight: number; choices: number };
    /** The card, the preview and the choices beside it, in layout px: the dialog is zoomed by the interface size. */
    const layoutOf = (dialog: Locator): Promise<Layout | null> =>
      dialog.evaluate((d) => {
        type El = { parentElement: El | null; children: ArrayLike<El>; currentCSSZoom?: number; querySelector(s: string): El | null; getBoundingClientRect(): { width: number; height: number } };
        const css = (e: El) => (globalThis as unknown as { getComputedStyle(e: El): { position: string } }).getComputedStyle(e);
        const el = d as unknown as El;
        const card = el.querySelector("section");
        const img = el.querySelector('img[alt^="Preview of the dungeon"]');
        // The picture sits in a box of its own size, inside the preview's box (Preview.tsx).
        const preview = img?.parentElement?.parentElement ?? null;
        let column: El | null = preview;
        while (column && css(column).position !== "absolute") column = column.parentElement;
        const choices = column?.parentElement ? (Array.from(column.parentElement.children).find((c) => c !== column && css(c).position === "static") ?? null) : null;
        if (!card || !preview || !choices) return null;
        const zoom = card.currentCSSZoom ?? 1;
        return { card: card.getBoundingClientRect().width / zoom, preview: preview.getBoundingClientRect().width / zoom, previewHeight: preview.getBoundingClientRect().height / zoom, choices: choices.getBoundingClientRect().width / zoom };
      });
    const near = (got: Layout | null, want: (typeof WANT)[number]) => got !== null && [got.card - want.card, got.preview - want.preview, got.previewHeight - want.preview, got.choices - want.choices].every((d) => Math.abs(d) <= 1);
    const page = await dmContext.newPage();
    const lines: string[] = [];
    try {
      for (const scale of [1, 1.3]) {
        await page.setViewportSize({ width: 1440, height: 900 });
        if (!page.url().startsWith(server.origin)) await page.goto(server.origin);
        await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", s), String(scale));
        await page.goto(dm.url());
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        for (const want of WANT.filter((w) => w.scale === scale)) {
          const at = `${want.width} x ${want.height} at ${scale * 100}%`;
          // Opened at each size: under 900 px of layout the Scenes panel moves from the side panel into a sheet, and the dialog with it.
          await page.setViewportSize({ width: want.width, height: want.height });
          const sidePanel = want.width / scale >= 900;
          await waitFor(`the side panel ${sidePanel ? "shown" : "put away"} at ${at}`, async () => ((await page.getByRole("tablist", { name: "Panels" }).isVisible()) === sidePanel ? true : null), 5_000);
          const dialog = await openDialog(page);
          // The body is measured as it lays out, so the preview follows it a frame or two later.
          const got = await waitFor(`the dialog laid out at ${at}`, async () => {
            const g = await layoutOf(dialog);
            return near(g, want) ? g : null;
          }, 3_000).catch(() => layoutOf(dialog));
          if (!near(got, want)) lines.push(`pe1-1 ${at}: ${JSON.stringify(got)}, wanted card ${want.card}, a ${want.preview} px square and choices ${want.choices}`);
          lines.push(...alignmentLines(await measureAlignment(dialog), `pe1-1 dialog, ${at}`));
          await shots.take(page, `pe1-1-dialog-${want.width}x${want.height}-${scale * 100}`);
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
        }
      }
    } finally {
      await page.evaluate(() => localStorage.removeItem("rvtt.uiScale")).catch(() => {});
      await page.close();
    }
    assert.deepEqual(lines, []);
  });

  test("FU49-1. the pinned error block and the foot within 1 px at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    // A picture the device cannot draw is the error line that is easy to raise here, and it pins in the same block as a no-fit one.
    const page = await dmContext.newPage();
    const lines: string[] = [];
    const shotDir = process.env.DG_ALIGN_SHOTS;
    try {
      for (const scale of [1, 1.3]) {
        for (const size of [{ width: 1440, height: 900 }, PHONE, { width: 320, height: 568 }]) {
          await page.setViewportSize(size);
          if (!page.url().startsWith(server.origin)) await page.goto(server.origin);
          await page.evaluate((v) => localStorage.setItem("rvtt.uiScale", v), String(scale));
          await page.goto(dm.url());
          await page.getByRole("status", { name: "Connected" }).first().waitFor();
          const dialog = await openDialog(page);
          await statusText(dialog);
          await encodes(page, "fail");
          await dialog.getByRole("button", { name: "Reroll", exact: true }).click();
          await dialog.getByText("This device could not draw the preview, so Make is off. Reroll or change a choice to try again.", { exact: true }).waitFor();
          const at = `${size.width} x ${size.height} at ${scale * 100}%`;
          // The pinned block and the foot. The whole dialog also holds Reroll in the preview's corner, which sits off a short preview's middle by design and reads 40 px off at 320 x 568 and 130% on main too.
          const off = [
            ...alignmentLines(await measureAlignment(dialog.getByRole("alert").first().locator("xpath=..")), `FU49-1 pinned errors, ${at}`),
            ...alignmentLines(await measureAlignment(dialog.locator("footer")), `FU49-1 foot, ${at}`),
          ];
          run.measured.push(`FU49-1 ${at}: ${off.length === 0 ? "all within 1 px" : off.join(" | ")}`);
          lines.push(...off);
          if (shotDir) await page.screenshot({ path: path.join(shotDir, `error-${size.width}x${size.height}-${scale * 100}.png`) });
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
        }
      }
    } finally {
      await page.evaluate(() => localStorage.removeItem("rvtt.uiScale")).catch(() => {});
      await page.close();
    }
    assert.deepEqual(lines, []);
  });

  test("DG-10. no page logged an error", () => {
    assert.deepEqual(consoles.dm.errors, []);
    assert.deepEqual(consoles.pat.errors, []);
  });
});
