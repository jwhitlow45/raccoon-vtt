import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import WebSocket from "ws";
import { uuidv7 } from "#shared/ids.ts";
import { ConsoleWatch, OpSocket, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * A 3D model's sheet asked for by a ghost (docs/design/design-v1-token-models.md
 * 6, D-261127-700). Another of the DM's devices drags a creature that wears
 * a model from far past the DM's screen onto it. Nothing on the DM's board
 * has asked for the sheet before, so only the ghost can ask, and the ghost
 * stands as the model once its sheet comes.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventy-eight, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 78;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-modelghost-"));
const assetDir = path.join(work, "assets");

/** Set before the app's first script: it installs the hook that picks the view (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

/** Where the DM's board opens, and where the drag brings the creature. */
const HOME = { x: 10, y: 10 };
/**
 * Where the creature stands, 40 cells down each axis at 40 px a cell: past
 * the board's cull box, and inside the one Top-down's camera would give the
 * render that switches to Isometric, which asks for nothing (D-261127-707).
 */
const FAR = { x: 50, y: 50 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
let device: WebSocket | null = null;
const dmSocket = new SocketWatch("dm");
const console_ = new ConsoleWatch("dm");

const run = { roomId: "", roomName: `E2E model ghost ${new Date().toISOString().slice(0, 19)}`, sceneId: "", tokenId: uuidv7(), sheetId: "" };
/** Every request the DM's page makes for the sheet, at either copy. */
const sheetRequests: string[] = [];

async function upload(kind: "token" | "model", data: Buffer): Promise<string> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the ${kind} upload answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
}

/** A sheet of 8 frames of 512 px, each a figure inside its drawn box [30, 20, 70, 90]. */
function sheet(): Promise<Buffer> {
  const parts: string[] = [];
  for (let f = 0; f < 8; f++) parts.push(`<rect x="${(f % 4) * 512 + 154}" y="${Math.floor(f / 4) * 512 + 102}" width="204" height="358" fill="hsl(${f * 45},60%,45%)"/>`);
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024">${parts.join("")}</svg>`)).png().toBuffer();
}

/** How many models the DM's isometric board draws, its standees' and its ghosts' alike. */
function modelsDrawn(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Stage = { width(): number; visible(): boolean; find(selector: string): unknown[] };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    return (konva?.stages ?? []).filter((s) => s.width() > 0 && s.visible()).reduce((n, s) => n + s.find(".standeeModel").length, 0);
  });
}

/** Another device of the DM's, a socket of its own on the same session, which sends drag frames as a page does. */
async function otherDevice(): Promise<WebSocket> {
  const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
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

describe("raccoon-vtt a ghost's model", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await dmContext.addInitScript(HOOK_FLAG);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(server?.output().split("\n").slice(-40).join("\n"));
    device?.close();
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

  test("MG-1. a DM's room with a wolf wearing a model 40 cells down each axis from where the board opens, fog off", async () => {
    dm = await dmContext.newPage();
    await dmSocket.attach(dmContext, dm);
    console_.attach(dm);
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
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
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: { w: 60, h: 60 }, fogEnabled: false, defaultView: { ...HOME, zoom: 40 } } });
    const picture = await upload("token", await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 150, g: 90, b: 60 } } }).png().toBuffer());
    run.sheetId = await upload("model", await sheet());
    const model = { assetId: run.sheetId, side: 1.6, anchorY: 0.8, boxes: Array.from({ length: 8 }, () => [30, 20, 70, 90]) };
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 2, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({
      t: "token.create",
      token: { id: run.tokenId, sceneId: run.sceneId, kind: "monster", name: "Wolf", size: "medium", ...FAR, disposition: "hostile", visibility: "all", actor: { inline: actor }, image: { assetId: picture, crop: { cx: 0.5, cy: 0.5, zoom: 1 }, model } },
    });
    await dm.close();
  });

  test("MG-2. the DM's isometric board opens away from the wolf and asks for no sheet, the render that switches to it included", async () => {
    dm = await dmContext.newPage();
    console_.attach(dm);
    dm.on("request", (r) => {
      if (r.url().includes(run.sheetId)) sheetRequests.push(r.url());
    });
    await dm.goto(`${server.origin}/r/${run.roomId}`);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("the test hook", () => dm.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
    await dm.evaluate(() => {
      const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
      hook.pick("isometric");
      hook.turn(0);
    });
    await waitFor("the isometric board laid out", () => dm.evaluate(() => (globalThis as unknown as { __rvttIsoHook: { layout?(): unknown } }).__rvttIsoHook.layout?.() ?? null));
    await dm.waitForTimeout(1_500);
    assert.deepEqual(sheetRequests, [], "no request for the sheet");
    assert.equal(await modelsDrawn(dm), 0, "no model drawn");
  });

  test("MG-3. another of the DM's devices drags the wolf onto the screen: its ghost asks for the sheet and stands as the model, and goes when the drag is cancelled", async () => {
    device = await otherDevice();
    const send = (e: Record<string, unknown>) => device!.send(JSON.stringify({ t: "eph", sceneId: run.sceneId, e }));
    send({ k: "dragStart", tokenId: run.tokenId, ...FAR });
    // A preview with no frame for 3 s is dropped (state/ephemeral.ts PREVIEW_IDLE_MS), so the drag keeps moving, a little each time.
    let step = 0;
    const moving = setInterval(() => send({ k: "dragMove", tokenId: run.tokenId, x: HOME.x + (step++ % 2) * 0.1, y: HOME.y }), 300);
    try {
      await waitFor("the ghost standing as the wolf's model", async () => ((await modelsDrawn(dm)) > 0 ? true : null), 20_000);
      assert.ok(sheetRequests.length > 0, "the page asked for the sheet");
    } finally {
      clearInterval(moving);
    }
    send({ k: "dragCancel", tokenId: run.tokenId });
    await waitFor("the ghost gone", async () => ((await modelsDrawn(dm)) === 0 ? true : null), 10_000);
  });

  test("MG-4. the page logged no error", () => {
    assert.deepEqual(console_.errors, [], "the DM's page logged errors");
  });
});
