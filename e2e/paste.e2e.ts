import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from "playwright-core";
import sharp from "sharp";
import { drawMap } from "../client/features/grid/synthetic.ts";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, pickOption, pickTool, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Pasting images (docs/design-v1-paste.md 8.2): the real server serving the
 * production build, a DM on a desktop and a player on a phone, as
 * maps.e2e.ts sets them up. Every paste here is a synthetic
 * `ClipboardEvent("paste")` carrying a DataTransfer, which reaches the
 * page's listeners as a real paste does, or a press of a Paste button with
 * the clipboard seeded through `navigator.clipboard.write`. Headless
 * Chrome keeps one clipboard in memory, and whether contexts share it is
 * not known, so the steps run one after another in this one file.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus nineteen.
 * The other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 19;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-paste-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E paste ${new Date().toISOString().slice(0, 19)}`,
  patId: "",
  firstSceneId: "",
  pastedSceneId: "",
  thorn: { characterId: randomUUID() },
  goblin: { id: randomUUID(), at: { x: 3, y: 3 } },
};

/** A pasted file as the test hands it to the page. */
type Clip = { name: string; type: string; base64: string };

/** A grid drawn by code (client/features/grid/synthetic.ts), never art: noise with 70 px squares whose lines cross at (20, 35). */
const DRAWN = { cellPx: 70, originPx: { x: 20, y: 35 } };
let gridded: Clip;
/** A small picture in one color, for the entries that need no grid. */
let swatch: (rgb: [number, number, number], name?: string, size?: { width: number; height: number }) => Promise<Clip>;

/** Every upload a page sends, by kind. */
function uploads(page: Page): Record<string, number> {
  const counts: Record<string, number> = {};
  page.on("request", (r: Request) => {
    const kind = /\/assets\?kind=(\w+)/.exec(r.url())?.[1];
    if (r.method() === "PUT" && kind) counts[kind] = (counts[kind] ?? 0) + 1;
  });
  return counts;
}
let dmUploads: Record<string, number>;
let playerUploads: Record<string, number>;

/** The page's own globals that the in-page steps below use. The e2e files are typed without the DOM. */
type PageEl = { dispatchEvent(e: unknown): boolean; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; blur?(): void };
type PageGlobals = {
  document: { activeElement: PageEl | null; body: PageEl; querySelector(s: string): PageEl | null };
  DataTransfer: new () => { items: { add(file: File): void }; setData(type: string, value: string): void };
  ClipboardEvent: new (type: string, init: { clipboardData: unknown; bubbles: boolean; cancelable: boolean }) => { defaultPrevented: boolean };
  ClipboardItem: new (items: Record<string, Blob>) => unknown;
  navigator: { clipboard?: { read(): Promise<unknown>; write(items: unknown[]): Promise<void> } };
  __clipboardReads?: number;
  /** How the DM's page answers a read: as the browser does, refused, or held until `__releaseRead`. */
  __readMode?: "real" | "deny" | "hold";
  __releaseRead?: () => void;
};

/**
 * A paste as the system's arrives: a cancelable ClipboardEvent that
 * bubbles, aimed at the focused element (the body when nothing has focus)
 * or at `at`. Answers whether a listener cancelled it.
 */
async function paste(page: Page, input: { files?: Clip[]; text?: string; at?: Locator }): Promise<boolean> {
  if (input.at) await input.at.evaluate((el) => (el as unknown as PageEl).setAttribute("data-e2e-paste", ""));
  return page.evaluate(
    (arg) => {
      const g = globalThis as unknown as PageGlobals;
      const marked = g.document.querySelector("[data-e2e-paste]");
      marked?.removeAttribute("data-e2e-paste");
      const dt = new g.DataTransfer();
      for (const f of arg.files) dt.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      if (arg.text !== null) dt.setData("text/plain", arg.text);
      const ev = new g.ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      (marked ?? g.document.activeElement ?? g.document.body).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { files: input.files ?? [], text: input.text ?? null },
  );
}

/** Leaves focus nowhere, so a paste goes to the body as one with nothing focused does. */
function blur(page: Page): Promise<void> {
  return page.evaluate(() => (globalThis as unknown as PageGlobals).document.activeElement?.blur?.());
}

/** Puts a PNG on the page's clipboard through the async API, which the context's clipboard-write grant allows. */
async function seedClipboard(page: Page, clip: Clip): Promise<void> {
  await page.evaluate(async (base64) => {
    const g = globalThis as unknown as PageGlobals;
    const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" });
    await g.navigator.clipboard!.write([new g.ClipboardItem({ "image/png": blob })]);
  }, clip.base64);
}

/** How the DM's page answers its next reads (the init script below). */
function readMode(page: Page, mode: "real" | "deny" | "hold"): Promise<void> {
  return page.evaluate((m) => void ((globalThis as unknown as PageGlobals).__readMode = m), mode);
}

/** Lets a held read answer, from the clipboard as it is now. */
function releaseRead(page: Page): Promise<void> {
  return page.evaluate(() => (globalThis as unknown as PageGlobals).__releaseRead?.());
}

/** How many times the page has called `navigator.clipboard.read` (the init script below counts them). */
function readsOf(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as PageGlobals).__clipboardReads ?? -1);
}

const PASTED = /^Pasted image .+\.png$/;

/** A creature's numbers, enough for a token or a character. */
function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

describe("raccoon-vtt paste run", { timeout: 300_000 }, () => {
  before(async () => {
    const px = drawMap({ width: 1400, height: 1000, seed: 3, art: [{ kind: "noise", scale: 60, amp: 70 }], noise: 4, grid: { cellPx: DRAWN.cellPx, origin: DRAWN.originPx, opacity: 0.5, width: 2 } });
    const map = await sharp(Buffer.from(px.data), { raw: { width: px.width, height: px.height, channels: 1 } }).png().toBuffer();
    // The name every browser gives a pasted picture, which says nothing about it.
    gridded = { name: "image.png", type: "image/png", base64: map.toString("base64") };
    swatch = async (rgb, name = "image.png", size = { width: 320, height: 240 }) => {
      const png = await sharp({ create: { ...size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
      return { name, type: "image/png", base64: png.toString("base64") };
    };

    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await dmContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    /*
     * pa-8: every call to navigator.clipboard.read is counted, from the
     * page's first script on. pa-9 also has a read refused, or held until
     * the step lets it answer, as a slow permission prompt would.
     */
    await dmContext.addInitScript(() => {
      const g = globalThis as unknown as PageGlobals;
      const clipboard = g.navigator.clipboard;
      if (!clipboard) return;
      const real = clipboard.read.bind(clipboard);
      g.__clipboardReads = 0;
      clipboard.read = () => {
        g.__clipboardReads = (g.__clipboardReads ?? 0) + 1;
        if (g.__readMode === "deny") return Promise.reject(new DOMException("Read permission denied.", "NotAllowedError"));
        if (g.__readMode === "hold") return new Promise((resolve, reject) => (g.__releaseRead = () => void real().then(resolve, reject)));
        return real();
      };
    });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await playerContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
    dmUploads = uploads(dm);
    playerUploads = uploads(player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("pa-0. the DM creates a room, and Pat joins from a phone with a character of their own", async () => {
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
    run.firstSceneId = dmSocket.state!.meta.playerSceneId!;

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("the player's snapshot", () => playerSocket.state);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("pa-1. a map pasted into New scene's Map image is picked, named for the time, uploaded once, and its grid found", async () => {
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    await scenes.getByRole("radio", { name: "Map image" }).click();
    assert.equal(await paste(dm, { files: [gridded] }), true, "the paste was not taken");
    const picked = scenes.getByText(PASTED);
    await picked.waitFor();
    const name = (await picked.textContent()) ?? "";
    await shots.take(dm, "paste-new-scene-picked");

    // The upload waits here until a second paste has been tried, which must change nothing.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await dm.route(/\/api\/rooms\/[^/]+\/assets\?kind=map/, async (route) => {
      await gate;
      await route.continue();
    });
    const known = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
    await scenes.getByRole("button", { name: "Upload and create" }).click();
    await scenes.getByRole("button", { name: "Uploading…" }).waitFor();
    assert.equal(await paste(dm, { files: [await swatch([200, 40, 40], "second.png")] }), true, "a paste during the upload passed to another entry");
    assert.equal(await scenes.getByText("second.png").count(), 0, "a second paste replaced the picked map");
    release();
    const scene = await waitFor("the pasted map's scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.map && !known.has(s.id)), 30_000);
    await dm.unroute(/\/api\/rooms\/[^/]+\/assets\?kind=map/);
    run.pastedSceneId = scene.id;
    assert.equal(scene.name, name.replace(/\.png$/, ""), "the scene takes its name from the pasted file's");
    assert.equal(dmUploads.map, 1, "one map upload");
    await waitFor("the found grid", () => {
      const map = dmSocket.state?.scenes[run.pastedSceneId]?.map;
      return map && Math.abs(map.cellPx - DRAWN.cellPx) < 0.05 && Math.abs(map.originPx.x - DRAWN.originPx.x) < 0.5 && Math.abs(map.originPx.y - DRAWN.originPx.y) < 0.5 ? map : null;
    }, 15_000);
    await dm.getByText("Found a grid of 70 px squares.").first().waitFor();
    await shots.take(dm, "paste-new-scene-grid-found");
  });

  test("pa-2. a paste lands in Show a handout, the stamp picker, and Add a phase with focus in its row", async () => {
    await pickTool(dm, "Select");
    // Show a handout: the image is shrunk, uploaded and picked, titled for the time.
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: "DM" });
    await panel.getByRole("button", { name: "Show a handout" }).click();
    const form = dm.getByRole("group", { name: "Show a handout" });
    await form.getByRole("button", { name: "Paste an image" }).waitFor();
    await shots.take(dm, "paste-handout-form");
    assert.equal(await paste(dm, { files: [await swatch([40, 120, 200])] }), true);
    await form.getByRole("button", { name: "Change", exact: true }).waitFor({ timeout: 30_000 });
    assert.match(await form.getByLabel("Title").inputValue(), /^Pasted image /);
    assert.equal(dmUploads.handout, 1);
    await shots.take(dm, "paste-handout-picked");
    // Change lets the pick go, so the form closes with nothing picked.
    await form.getByRole("button", { name: "Change", exact: true }).click();
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    // The stamp picker: the image joins the room's images and is what the next tap places.
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Stamp");
    await dm.getByRole("button", { name: /Choose a stamp/ }).click();
    const stamps = dm.getByRole("dialog", { name: "Stamps" });
    await stamps.getByRole("button", { name: "Paste an image" }).waitFor();
    await shots.take(dm, "paste-stamp-picker");
    // With focus in the header's search box, an image alone still lands in the picker.
    await stamps.getByRole("searchbox", { name: "Search stamps" }).focus();
    assert.equal(await paste(dm, { files: [await swatch([60, 160, 60])] }), true);
    await stamps.waitFor({ state: "detached", timeout: 30_000 });
    await dm.getByRole("button", { name: "Placing Room image. Choose another stamp" }).first().waitFor();
    assert.equal(dmUploads.token, 1);
    await pickTool(dm, "Select");

    // Add a phase takes a key paste only with focus in its row.
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    await scenes.getByLabel("Add a phase from an image").focus();
    // A phase has the map's shape, 1400 by 1000.
    assert.equal(await paste(dm, { files: [await swatch([220, 90, 40], "Blazing_inferno.png", { width: 700, height: 500 })] }), true);
    const phases = await waitFor("the pasted phase", () => {
      const list = dmSocket.state?.scenes[run.pastedSceneId]?.phases;
      return list?.length === 2 ? list : null;
    }, 30_000);
    assert.equal(phases[1]!.name, "Blazing inferno", "a real name stays the phase's name");
    await shots.take(dm, "paste-phase-added");
  });

  test("pa-3. Paste an image reads the clipboard in a scene's Map image row, and on the players' scene shows only after the confirm", async () => {
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    const before = dmSocket.state!.scenes[run.pastedSceneId]!.map!.assetId;
    // The map's shape, which a map with phases keeps.
    await seedClipboard(dm, await swatch([150, 150, 60], "image.png", { width: 700, height: 500 }));
    const reads = await readsOf(dm);
    // The map row's comes before the phases' in the panel.
    assert.equal(await scenes.getByRole("button", { name: "Paste an image" }).count(), 2);
    await scenes.getByRole("button", { name: "Paste an image" }).first().click();
    await waitFor("the replaced map", () => {
      const map = dmSocket.state?.scenes[run.pastedSceneId]?.map;
      return map && map.assetId !== before ? map : null;
    }, 30_000);
    assert.equal(await readsOf(dm), reads + 1, "one press, one read");
    await shots.take(dm, "paste-map-row-pasted");

    // The players' scene asks first, and its Paste an image waits for the confirm.
    await scenes.getByRole("button", { name: new RegExp(`^${dmSocket.state!.scenes[run.firstSceneId]!.name}`) }).first().click();
    await waitFor("the DM on the players' scene", () => dmSocket.you?.sceneId === run.firstSceneId || null, 30_000);
    const arm = scenes.getByRole("button", { name: /^(Add a|Replace) map image$/ });
    await arm.waitFor();
    assert.equal(await scenes.getByRole("button", { name: "Paste an image" }).count(), 0, "the players' scene offers Paste before the confirm");
    // A key paste with focus in the row is never the row's before the confirm: it goes to the room's own offer, which asks first.
    const map = dmSocket.state!.scenes[run.firstSceneId]!.map;
    await arm.focus();
    await paste(dm, { files: [await swatch([10, 10, 10])] });
    const offer = dm.getByRole("dialog", { name: "Use the pasted image" });
    await offer.waitFor();
    await dm.keyboard.press("Escape");
    await offer.waitFor({ state: "detached" });
    assert.deepEqual(dmSocket.state!.scenes[run.firstSceneId]!.map, map, "a key paste set the players' map before the confirm");
    await arm.click();
    await scenes.getByRole("button", { name: "Paste an image" }).first().waitFor();
    await shots.take(dm, "paste-players-scene-confirmed");
    await scenes.getByRole("button", { name: "Cancel", exact: true }).first().click();
  });

  test("pa-4. a key paste over the map offers the picture, Handout opens the form with it picked, and with a token selected its picture comes first", async () => {
    // Back on the pasted scene, with Select and the map focused.
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    await scenes.getByRole("button", { name: new RegExp(`^${dmSocket.state!.scenes[run.pastedSceneId]!.name}`) }).first().click();
    await waitFor("the DM on the pasted scene", () => dmSocket.you?.sceneId === run.pastedSceneId || null, 30_000);
    await pickTool(dm, "Select");
    await blur(dm);
    assert.equal(await paste(dm, { files: [await swatch([90, 60, 160])] }), true, "the room's offer did not take the paste");
    const sheet = dm.getByRole("dialog", { name: "Use the pasted image" });
    await sheet.waitFor();
    await sheet.getByText("320 × 240 px").waitFor();
    const rows = await sheet.getByRole("group", { name: "Use it for" }).getByRole("button").allTextContents();
    assert.deepEqual(rows, ["New scene", "Stamp", "Handout"]);
    await shots.take(dm, "paste-room-offer");
    const handouts = dmUploads.handout ?? 0;
    await sheet.getByRole("button", { name: "Handout", exact: true }).click();
    const form = dm.getByRole("group", { name: "Show a handout" });
    await form.getByRole("button", { name: "Change", exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(dmUploads.handout, handouts + 1);
    assert.match(await form.getByLabel("Title").inputValue(), /^Pasted image /);
    await shots.take(dm, "paste-room-offer-handout");
    await form.getByRole("button", { name: "Change", exact: true }).click();
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    // New scene opens Map image with the picture picked, as a paste there does.
    await blur(dm);
    assert.equal(await paste(dm, { files: [await swatch([20, 140, 140])] }), true);
    await sheet.getByRole("button", { name: "New scene", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    const scenesPanel = dm.getByRole("tabpanel", { name: "Scenes" });
    await scenesPanel.getByText(PASTED).waitFor();
    assert.equal(await scenesPanel.getByRole("radio", { name: "Map image" }).isChecked(), true);
    await shots.take(dm, "paste-room-offer-new-scene");
    await scenesPanel.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await blur(dm);

    // With one token selected, its picture is the likeliest use.
    await ops.send({
      t: "token.create",
      token: { id: run.goblin.id, sceneId: run.pastedSceneId, size: "medium", visibility: "all", x: run.goblin.at.x, y: run.goblin.at.y, disposition: "hostile", kind: "monster", name: "Goblin", actor: { inline: actor() } },
    });
    await waitFor("the goblin", () => dmSocket.state?.tokens[run.goblin.id]);
    const bounds = dmSocket.state!.scenes[run.pastedSceneId]!.bounds;
    const at = await pagePoint(dm, bounds, { x: run.goblin.at.x + 0.5, y: run.goblin.at.y + 0.5 });
    await dm.mouse.click(at.x, at.y);
    await dm.getByRole("dialog", { name: "Goblin actions" }).waitFor();
    await blur(dm);
    assert.equal(await paste(dm, { files: [await swatch([200, 200, 40])] }), true);
    await sheet.waitFor();
    const first = sheet.getByRole("group", { name: "Use it for" }).getByRole("button").first();
    assert.equal(await first.textContent(), "Picture for Goblin");
    await first.click();
    const crop = dm.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor({ timeout: 30_000 });
    await shots.take(dm, "paste-room-offer-token-crop");
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("the goblin's pasted picture", () => {
      const image = dmSocket.state?.tokens[run.goblin.id]?.image;
      return image && "assetId" in image ? image : null;
    });
  });

  /** Thorn's page in the phone's Characters sheet, and its image button. */
  async function thornsPicker(): Promise<Locator> {
    const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
    if (!(await sheet.isVisible())) {
      await player.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
      await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
    }
    // A player with one character lands on its page, where the picture's buttons are in the Image group.
    await sheet.locator("[data-creature-heading]").filter({ hasText: "Thorn" }).waitFor();
    const image = sheet.getByRole("button", { name: "Image", exact: true });
    if ((await image.getAttribute("aria-expanded")) !== "true") await image.click();
    await sheet.getByRole("button", { name: /^(Add|Change) image$/ }).first().click();
    const picker = player.getByRole("dialog", { name: "Choose an image" });
    await picker.waitFor();
    await picker.getByRole("tab", { name: "Device", exact: true }).click();
    return picker;
  }

  test("pa-5. a player presses Paste from the clipboard in their character's picker and reaches the crop editor", async () => {
    await seedClipboard(player, await swatch([180, 90, 90]));
    const picker = await thornsPicker();
    await shots.take(player, "paste-player-device-tab");
    await picker.getByRole("button", { name: "Paste from the clipboard" }).click();
    const crop = player.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor({ timeout: 30_000 });
    assert.equal(playerUploads.token, 1);
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("Thorn's pasted portrait", () => {
      const image = playerSocket.state?.characters[run.thorn.characterId]?.defaultImage;
      return image && "assetId" in image ? image : null;
    });
  });

  test("pa-6. with no permission the press is refused, the paste box shows with its words, and a paste on it uploads exactly once", async () => {
    await playerContext.clearPermissions();
    const picker = await thornsPicker();
    await picker.getByRole("button", { name: "Paste from the clipboard" }).click();
    await picker.getByText("The browser did not let the app read the clipboard. Press and hold in the box, then tap Paste.").waitFor();
    const box = picker.getByRole("textbox", { name: "Press and hold here, then tap Paste." });
    await box.waitFor();
    assert.equal(await box.getAttribute("contenteditable"), "true");
    assert.equal(await box.getAttribute("inputmode"), "none");
    await shots.take(player, "paste-player-box");
    const before = playerUploads.token ?? 0;
    assert.equal(await paste(player, { files: [await swatch([90, 180, 90])], at: box }), true, "the box did not cancel its paste");
    const crop = player.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor({ timeout: 30_000 });
    await player.waitForTimeout(300);
    assert.equal(playerUploads.token, before + 1, "the box's paste uploaded other than once");
    assert.equal(await box.count(), 0, "the box stays after a paste");
    await crop.getByRole("button", { name: "Cancel", exact: true }).click();
    await crop.waitFor({ state: "detached" });
  });

  test("pa-7. a player's key paste over the map opens nothing, and a text-only paste into a picker shows the no-image words", async () => {
    const characters = player.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
    if (await characters.isVisible()) await characters.getByRole("button", { name: "Close Characters" }).click();
    await characters.waitFor({ state: "hidden" });
    await blur(player);
    const uploaded = playerUploads.token ?? 0;
    assert.equal(await paste(player, { files: [await swatch([30, 30, 30])] }), false, "a player's paste over the map was taken");
    await player.waitForTimeout(300);
    assert.equal(await player.getByRole("dialog", { name: "Use the pasted image" }).count(), 0);
    assert.equal(playerUploads.token ?? 0, uploaded);

    const picker = await thornsPicker();
    assert.equal(await paste(player, { text: "a goblin with a spear" }), true);
    await picker.getByText("The clipboard has no image in it. Copy an image first, such as with Copy image on a web page.").waitFor();
    await shots.take(player, "paste-player-no-image");
    await player.keyboard.press("Escape");
  });

  test("pa-8. nothing reads the clipboard on load, on opening an entry or on switching tabs, and one press reads it once", async () => {
    const page = await dmContext.newPage();
    const watch = new ConsoleWatch("dm second page");
    watch.attach(page);
    await page.goto(`${server.origin}/r/${run.roomId}`);
    await page.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(await readsOf(page), 0, "read on load");
    await openSideTab(page, "DM");
    await page.getByRole("tabpanel", { name: "DM" }).getByRole("button", { name: "Show a handout" }).click();
    await page.getByRole("group", { name: "Show a handout" }).getByRole("button", { name: "Paste an image" }).waitFor();
    await openSideTab(page, "Library");
    await pickTool(page, "Map builder");
    await pickOption(page, "Map builder", "Builder mode", "Stamp");
    await page.getByRole("button", { name: /Choose a stamp/ }).click();
    const stamps = page.getByRole("dialog", { name: "Stamps" });
    await stamps.getByRole("tab", { name: "Starter", exact: true }).click();
    await stamps.getByRole("tab", { name: "Stamps", exact: true }).click();
    await page.keyboard.press("Escape");
    await stamps.waitFor({ state: "detached" });
    await pickTool(page, "Select");
    await openSideTab(page, "Scenes");
    const scenes = page.getByRole("tabpanel", { name: "Scenes" });
    await scenes.getByRole("radio", { name: "Map image" }).click();
    await scenes.getByRole("button", { name: "Paste an image" }).first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await readsOf(page), 0, "read on opening an entry or switching tabs");
    await page.bringToFront();
    await seedClipboard(page, await swatch([60, 60, 200]));
    await scenes.getByRole("button", { name: "Paste an image" }).first().click();
    await scenes.getByText(PASTED).waitFor();
    assert.equal(await readsOf(page), 1);
    assert.deepEqual(watch.errors.filter((e) => e.startsWith("uncaught")), []);
    await page.close();
  });

  test("pa-9. a closed or unconfirmed entry takes nothing by any path: not its box, not a read that answers after it closed", async () => {
    // The players' Map image row: confirmed, refused, its box open, then Cancel. The box goes with the confirm.
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    await scenes.getByRole("button", { name: new RegExp(`^${dmSocket.state!.scenes[run.firstSceneId]!.name}`) }).first().click();
    await waitFor("the DM on the players' scene", () => dmSocket.you?.sceneId === run.firstSceneId || null, 30_000);
    const map = dmSocket.state!.scenes[run.firstSceneId]!.map;
    const maps = dmUploads.map ?? 0;
    const arm = scenes.getByRole("button", { name: /^(Add a|Replace) map image$/ });
    await arm.click();
    await readMode(dm, "deny");
    await scenes.getByRole("button", { name: "Paste an image" }).first().click();
    const box = scenes.getByRole("textbox", { name: /right-click here and choose Paste/ });
    await box.waitFor();
    await shots.take(dm, "paste-players-row-box");
    // The row's Cancel comes before the box's own.
    await scenes.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await arm.waitFor();
    // The box goes in the render after the one that disarmed the row.
    await box.waitFor({ state: "detached", timeout: 2_000 });
    assert.equal(await scenes.getByText("The browser did not let the app read the clipboard.", { exact: false }).count(), 0, "the refusal outlived the confirm");

    // The same row with a read still waiting when Cancel is pressed: its answer is dropped.
    await seedClipboard(dm, await swatch([250, 0, 0]));
    await readMode(dm, "hold");
    await arm.click();
    await scenes.getByRole("button", { name: "Paste an image" }).first().click();
    await scenes.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await arm.waitFor();
    await releaseRead(dm);
    await dm.waitForTimeout(800);
    assert.equal(dmUploads.map ?? 0, maps, "a read answered after Cancel uploaded a map");
    assert.deepEqual(dmSocket.state!.scenes[run.firstSceneId]!.map, map, "a read answered after Cancel replaced the players' map");

    // Show a handout cancelled while its read waits: nothing is uploaded or picked, and nothing throws.
    const handouts = dmUploads.handout ?? 0;
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: "DM" });
    await panel.getByRole("button", { name: "Show a handout" }).click();
    const form = dm.getByRole("group", { name: "Show a handout" });
    await form.getByRole("button", { name: "Paste an image" }).click();
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await form.waitFor({ state: "detached" });
    await releaseRead(dm);
    await dm.waitForTimeout(800);
    assert.equal(dmUploads.handout ?? 0, handouts, "a read answered after the form closed uploaded a handout");
    await panel.getByRole("button", { name: "Show a handout" }).click();
    await form.getByRole("button", { name: "Paste an image" }).waitFor();
    assert.equal(await form.getByRole("button", { name: "Change", exact: true }).count(), 0, "a read answered after the form closed picked an image");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    // New scene's Map image, left for Battle mat while its read waits: the answer picks nothing.
    await openSideTab(dm, "Scenes");
    await scenes.getByRole("radio", { name: "Map image" }).click();
    await scenes.getByRole("button", { name: "Paste an image" }).first().click();
    await scenes.getByRole("radio", { name: "Battle mat" }).click();
    await releaseRead(dm);
    await dm.waitForTimeout(800);
    await scenes.getByRole("radio", { name: "Map image" }).click();
    await scenes.getByText("Choose a map image", { exact: true }).waitFor();
    assert.equal(await scenes.getByText(PASTED).count(), 0, "a read answered after leaving Map image picked a map");
    await scenes.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await readMode(dm, "real");
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });

  test("pa-10. the stamp picker says why a paste gave nothing on its Starter tab too", async () => {
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Stamp");
    await dm.getByRole("button", { name: /^(Choose a stamp|Placing .*Choose another stamp)/ }).first().click();
    const stamps = dm.getByRole("dialog", { name: "Stamps" });
    await stamps.getByRole("tab", { name: "Starter", exact: true }).click();
    assert.equal(await paste(dm, { text: "a goblin with a spear" }), true);
    await stamps.getByText("The clipboard has no image in it. Copy an image first, such as with Copy image on a web page.").waitFor();
    assert.equal(await stamps.getByRole("tab", { name: "Starter", exact: true }).getAttribute("aria-selected"), "true");
    await shots.take(dm, "paste-stamp-starter-no-image");
    await dm.keyboard.press("Escape");
    await stamps.waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });

  test("pa-11. on a narrow window with a panel's sheet open, Stamp in the offer closes the sheet and the stamp picker takes the picture", async () => {
    await dm.setViewportSize({ width: 820, height: 900 });
    // Narrowed, the side panel's open panel may come over as a sheet. Otherwise Scenes opens as one from the list of panels.
    await dm.waitForTimeout(500);
    const sheets = dm.locator("dialog[data-rvtt-sheet][open]");
    if ((await sheets.count()) === 0) {
      await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
      await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Scenes", exact: true }).click();
    }
    await sheets.first().waitFor();
    await blur(dm);
    const tokens = dmUploads.token ?? 0;
    assert.equal(await paste(dm, { files: [await swatch([120, 60, 20])] }), true);
    const offer = dm.getByRole("dialog", { name: "Use the pasted image" });
    await offer.getByRole("button", { name: "Stamp", exact: true }).click();
    await offer.waitFor({ state: "detached" });
    await waitFor("the sheet closed", async () => (await sheets.count()) === 0 || null);
    await waitFor("the pasted stamp's upload", () => (dmUploads.token ?? 0) === tokens + 1 || null, 30_000);
    await dm.getByRole("button", { name: "Placing Room image. Choose another stamp" }).first().waitFor({ timeout: 30_000 });
    await shots.take(dm, "paste-narrow-stamp-chosen");
    await pickTool(dm, "Select");
    await dm.setViewportSize({ width: 1280, height: 800 });
    // The room lays the wider window out a moment after the resize (50 to 150 ms, longer on a busy runner), and pickTool goes by the toolbar as it stands: a toolbar that turns wide between its checks sends it down the narrow or the pair path. So the next test starts once the wide toolbar shows each tool's own button.
    await dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Map builder", exact: true }).waitFor();
  });

  test("lp4-stamp-tabs. the stamp picker's paste box and its note stay with Paste an image on the Stamps tab: a tab change closes them, and a read still waiting no longer counts", async () => {
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Stamp");
    await dm.getByRole("button", { name: /^(Choose a stamp|Placing .*Choose another stamp)/ }).first().click();
    const stamps = dm.getByRole("dialog", { name: "Stamps" });
    const tab = (name: string) => stamps.getByRole("tab", { name, exact: true });
    const refused = stamps.getByText("The browser did not let the app read the clipboard.", { exact: false });
    const box = stamps.getByRole("textbox", { name: /right-click here and choose Paste/ });
    await readMode(dm, "deny");
    try {
      await stamps.getByRole("button", { name: "Paste an image" }).click();
      await refused.waitFor();
      await box.waitFor();
      await shots.take(dm, "lp4-stamp-box-on-stamps");
      // The Starter tab draws no box, so its words go with it rather than point at nothing.
      await tab("Starter").click();
      await box.waitFor({ state: "detached" });
      assert.equal(await refused.count(), 0, "the refusal's words stayed on the Starter tab");
      await shots.take(dm, "lp4-stamp-starter-no-box");
      await tab("Stamps").click();
      await stamps.getByRole("button", { name: "Paste an image" }).waitFor();
      assert.equal(await box.count(), 0, "the box came back with the tab");
      assert.equal(await refused.count(), 0, "the refusal came back with the tab");

      // A read still waiting as the tab changes is dropped: nothing uploads and no stamp is chosen.
      const tokens = dmUploads.token ?? 0;
      await seedClipboard(dm, await swatch([30, 90, 200]));
      await readMode(dm, "hold");
      await stamps.getByRole("button", { name: "Paste an image" }).click();
      await tab("Starter").click();
      await releaseRead(dm);
      await dm.waitForTimeout(800);
      assert.equal(dmUploads.token ?? 0, tokens, "a read answered after the tab changed uploaded a stamp");
      assert.equal(await tab("Starter").getAttribute("aria-selected"), "true");
      assert.equal(await stamps.getByText("Uploading…").count(), 0, "a read answered after the tab changed started an upload");
    } finally {
      await readMode(dm, "real");
    }
    await dm.keyboard.press("Escape");
    await stamps.waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });

  test("pa-12. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
    assert.deepEqual(playerConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
