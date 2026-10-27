import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, dragWorld, openSceneGroup, pickOption, pickTool, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { imageAssetId } from "../shared/imageRef.ts";

/**
 * Table basics that a live play review found broken (LP3-TABLE): the DM on
 * a phone, the way the group starts a session.
 *
 * It runs with `pnpm test:e2e`, after the smoke and maps runs, on its own
 * port. The environment variables are the smoke run's (smoke.e2e.ts), and
 * E2E_PORT plus two is this run's port.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 2;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-table-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");

const run = {
  roomId: "",
  roomName: `E2E table ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  mapSceneId: "",
};

/**
 * Map art with its own grid that does not start at the image's corner: 24 by
 * 16 squares of 70 px, the first line 20 px in and 12 px down, and a 15 px
 * and a 9 px margin after the last. Drawn here, so no art is downloaded.
 */
const CRYPT = { cols: 24, rows: 16, cellPx: 70, origin: { x: 20, y: 12 }, width: 20 + 24 * 70 + 15, height: 12 + 16 * 70 + 9 };

async function makeCrypt(file: string): Promise<void> {
  const { width, height, cellPx, origin } = CRYPT;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const gx = x - origin.x;
      const gy = y - origin.y;
      const inside = gx >= 0 && gy >= 0 && gx < CRYPT.cols * cellPx && gy < CRYPT.rows * cellPx;
      const grout = inside && (gx % cellPx < 3 || gy % cellPx < 3);
      const shade = inside ? ((Math.floor(gx / cellPx) + Math.floor(gy / cellPx)) % 2 === 0 ? 120 : 105) : 60;
      const v = grout ? 20 : shade;
      pixels[i] = v;
      pixels[i + 1] = v - 10;
      pixels[i + 2] = v - 20;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

/** A plain portrait in one color, for a token image. */
function portrait(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

/** Opens a panel as a phone does: the Panels button, then the panel's name. */
async function openPanel(page: Page, name: string): Promise<void> {
  const all = page.getByRole("button", { name: "All panels" });
  if (await all.isVisible()) await all.tap();
  else {
    // A sheet on a subpage, such as the page a new character opens on, has Back where All panels was, and Panels would only close it.
    const close = page.locator("dialog[data-rvtt-sheet]").getByRole("button", { name: /^Close / }).filter({ visible: true });
    if ((await close.count()) > 0) await close.first().tap();
    await page.getByRole("button", { name: "Panels", exact: true }).tap();
  }
  await page.getByRole("button", { name, exact: true }).tap();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("raccoon-vtt table basics", { timeout: 120_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      console.error(`[${dmConsole.label}] errors`, dmConsole.errors, "warnings", dmConsole.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
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

  test("1. a reload on the DM link screen still finds the new room from Home (LP3-TABLE-1)", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).tap();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");

    // The DM switches to a password manager to save the link, and the phone
    // drops the tab meanwhile. The link is shown only once, so Home is all
    // that is left, and this device is still the room's DM.
    await dm.reload();
    const row = dm.getByRole("button", { name: new RegExp(`^${escapeRegExp(run.roomName)}`) });
    await row.waitFor();
    assert.match((await row.textContent()) ?? "", new RegExp(`${match[1]} · DM, as Dana the DM`));
    await shots.take(dm, "table-home-after-reveal-reload");

    await row.tap();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(dmSocket.you?.role, "dm");
    // GET /me answers 403 only for a device without a grant, which this one has.
    assert.deepEqual(dmConsole.errors, []);
  });

  test("2. after lining up a map's grid, the squares to count are the grid's own, with no warning until one is edited (LP3-TABLE-3)", async () => {
    const file = path.join(work, "crypt.png");
    await makeCrypt(file);
    await openPanel(dm, "Scenes");
    await dm.getByRole("radio", { name: "Map image", exact: true }).tap();
    await dm.locator('input[type="file"][accept="image/*"]').first().setInputFiles(file);
    await dm.getByRole("button", { name: "Upload and create" }).tap();
    const created = await waitFor("the map scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.map !== undefined), 30_000);
    run.mapSceneId = created.id;
    await waitFor("the DM on the map scene", () => dmSocket.you?.sceneId === created.id || null);
    // The crypt's grout is a drawn grid, found and applied on upload. Use
    // default puts back the first guess, so the squares are lined up by hand.
    await dm.getByText("Found a grid of 70 px squares.").waitFor();
    await dm.getByRole("toolbar", { name: "Line up grid options" }).getByRole("button", { name: "Use default", exact: true }).tap();
    await dm.getByText("Drag a box over 3 by 3 squares of the art").waitFor();
    const guessed = await waitFor("the first guess back", () => {
      const s = dmSocket.state?.scenes[created.id];
      return s?.map && s.map.cellPx !== CRYPT.cellPx ? s : null;
    });
    const guess = guessed.map!;
    const world = (px: number, py: number) => ({ x: (px - guess.originPx.x) / guess.cellPx, y: (py - guess.originPx.y) / guess.cellPx });
    // A box over the art's squares (2, 2) to (5, 5), clear of the box the tool starts with in the middle.
    const corner = (n: number) => world(CRYPT.origin.x + n * CRYPT.cellPx, CRYPT.origin.y + n * CRYPT.cellPx);
    await dragWorld(dm, guessed.bounds, corner(2), corner(5));
    await dm.getByRole("button", { name: "Apply", exact: true }).tap();
    const map = await waitFor("the lined-up grid", () => {
      const m = dmSocket.state?.scenes[created.id]?.map;
      return m && m.cellPx !== guess.cellPx ? m : null;
    });
    assert.deepEqual({ cellPx: map.cellPx, originPx: map.originPx }, { cellPx: CRYPT.cellPx, originPx: CRYPT.origin });

    await openPanel(dm, "Scenes");
    // A phone starts Map image and grid folded (docs/design-v1-map-discovery.md 8.4).
    await openSceneGroup(dm.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]'), "Map image and grid");
    const across = dm.getByLabel("Squares across the image");
    const down = dm.getByLabel("Squares down the image");
    assert.deepEqual([await across.inputValue(), await down.inputValue()], [String(CRYPT.cols), String(CRYPT.rows)]);
    const warning = dm.getByText(/make squares that are not square/);
    assert.equal(await warning.count(), 0, "the counts filled in are the grid's own, so nothing to warn about");
    await across.fill("30");
    await across.press("Enter");
    await warning.waitFor();
    await shots.take(dm, "table-count-squares-edited");
    await dm.getByRole("button", { name: /^Close/ }).first().tap();
  });

  test("3. the Library panel shows the picker's images, each role what it may see (LP3-TABLE-2)", async () => {
    const upload = async (rgb: [number, number, number]) => {
      const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=token`, {
        headers: { Origin: server.origin, "content-type": "image/png" },
        data: await portrait(rgb),
      });
      assert.ok(res.ok(), `uploading a token image answered ${res.status()}`);
      return ((await res.json()) as { id: string }).id;
    };
    // One image goes on a character every player sees, and one is only uploaded.
    const shown = await upload([200, 180, 60]);
    const unused = await upload([120, 120, 130]);

    await openPanel(dm, "Characters");
    await dm.getByRole("button", { name: "New character" }).tap();
    await dm.getByRole("button", { name: "Add image" }).tap();
    await dm.getByRole("tab", { name: "Library" }).tap();
    await dm.locator(`button[aria-label="Use this image"]:has(img[src*="${shown}"])`).tap();
    await dm.getByRole("button", { name: "Save", exact: true }).tap();
    await dm.getByLabel("Name", { exact: true }).fill("Thorn");
    await dm.getByRole("button", { name: "Create", exact: true }).tap();
    await waitFor("Thorn's portrait", () => Object.values(dmSocket.state?.characters ?? {}).some((c) => imageAssetId(c?.defaultImage) === shown) || null);

    const libraryImages = async (page: Page) => {
      const list = page.getByRole("list", { name: "Token images in this room" });
      await list.locator("img").first().waitFor();
      const srcs = await list.locator("img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src") ?? ""));
      return { shown: srcs.some((s) => s.includes(shown)), unused: srcs.some((s) => s.includes(unused)), count: srcs.length };
    };
    await openPanel(dm, "Library");
    assert.deepEqual(await libraryImages(dm), { shown: true, unused: true, count: 2 }, "the DM's library has every token image");
    await shots.take(dm, "table-library-dm");
    await dm.getByRole("button", { name: /^Close/ }).first().tap();

    const playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      const player = await playerContext.newPage();
      await player.goto(`${server.origin}/r/${run.roomId}`);
      await player.getByLabel("Player password").fill(run.password);
      await player.getByRole("button", { name: "Next" }).tap();
      await player.getByLabel("Your name").fill("Pip");
      await player.getByRole("button", { name: "Join", exact: true }).tap();
      await player.getByRole("status", { name: "Connected" }).first().waitFor();
      await openPanel(player, "Library");
      assert.deepEqual(await libraryImages(player), { shown: true, unused: false, count: 1 }, "a player's library has only what they may see");
      await shots.take(player, "table-library-player");
    } finally {
      await playerContext.close();
    }
  });

  test("4. on a phone, Back closes a token's action bar instead of leaving the room (LP3-TABLE-4)", async () => {
    // Escape closes a sheet an earlier step may have left open, so the map takes the taps.
    await dm.keyboard.press("Escape");
    await pickTool(dm, "Add token");
    await pickOption(dm, "Add token", "Blank token kind", "Blank object");
    const scene = dmSocket.state!.scenes[run.mapSceneId]!;
    await tapCell(dm, scene.bounds, { x: 3, y: 3 });
    const token = await waitFor("the object", () => Object.values(dmSocket.state?.tokens ?? {}).find((t) => t?.kind === "object"));
    await dm.getByRole("button", { name: "Select", exact: true }).tap();
    await tapCell(dm, scene.bounds, { x: token.x, y: token.y });
    const bar = dm.getByRole("dialog", { name: / actions$/ });
    await bar.waitFor();
    const room = dm.url();
    await dm.goBack();
    await bar.waitFor({ state: "detached" });
    assert.equal(dm.url(), room, "still in the room");
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("5. after a reload with a sheet open, Back leaves the room at once", async () => {
    if (!new URL(dm.url()).pathname.startsWith("/r/")) {
      await dm.goto(`${server.origin}/r/${run.roomId}`);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    }
    await openPanel(dm, "Log");
    const snapshots = dmSocket.snapshotBytes.length;
    await dm.reload();
    await waitFor("the snapshot after the reload", () => dmSocket.snapshotBytes.length > snapshots || null);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.goBack();
    await dm.getByRole("heading", { name: "RaccoonVTT" }).waitFor();
    assert.equal(new URL(dm.url()).pathname, "/", "the first Back went to Home");
  });
});
