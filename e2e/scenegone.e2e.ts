import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { uuidv7 } from "#shared/ids.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { undoSetup } from "./helpers/undoScope.ts";
import { ConsoleWatch, OpSocket, openSideTab, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * A DM device whose scene is deleted with the players on it (live play
 * 44): the server has no players' scene to land it on, so it shows none.
 * In a room that still has scenes it asks for one from the Scenes panel,
 * where it said "Create a scene to get started.", and once Undo setup
 * brings the scene back with the players on it, the device opens it, where
 * it went on showing nothing. The words are measured at three sizes and
 * both interface sizes.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-five, one file after
 * another as the others. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 65;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-scenegone-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESKTOP = { width: 1440, height: 900 };
const PICK = "Pick a scene in the Scenes panel.";
const CREATE = "Create a scene to get started.";

let server: Server;
let browser: Browser;
let context: BrowserContext;
let dm: Page;
/** The DM's second device, as a second tab is. */
let other: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");
const otherSocket = new SocketWatch("dm other");
const otherConsole = new ConsoleWatch("dm other");

const run = {
  roomId: "",
  roomName: `E2E scene gone ${new Date().toISOString().slice(0, 19)}`,
  keep: uuidv7(),
  crypt: uuidv7(),
};

async function open(scale: number): Promise<void> {
  await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await dm.goto(`${server.origin}/r/${run.roomId}`);
  await dm.getByRole("status", { name: "Connected" }).first().waitFor();
}

describe("raccoon-vtt: a DM device whose scene was deleted with the players on it", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    context = await browser.newContext({ viewport: DESKTOP });
    dm = await context.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(context, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(`[${dmConsole.label}] errors`, dmConsole.errors, "warnings", dmConsole.warnings);
    ops?.close();
    if (run.roomId && context) {
      try {
        const res = await context.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("bugss-1. a room with the Keep, where the players are and the DM's device shows, and the Crypt", async () => {
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
    const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    for (const [id, name] of [[run.keep, "Keep"], [run.crypt, "Crypt"]] as const) await ops.send({ t: "scene.create", scene: { id, name, bounds: { w: 20, h: 14 }, fogEnabled: false } });
    await ops.send({ t: "room.setPlayerScene", sceneId: run.keep });
    // A fresh page lands on the players' scene.
    await open(1);
    await waitFor("the DM's device on the Keep", () => (dmSocket.you?.sceneId === run.keep ? true : null));
    await dm.locator(".konvajs-content").first().waitFor();
  });

  /*
   * The device that deletes the scene it shows moves to the next one (SceneMenu.tsx), so the device left on nothing is
   * another of the DM's, showing the Keep as it goes, and any DM device that opens the room while the players have no scene.
   */
  test("bugss-2. the Keep deleted from the Scenes panel: the DM's other device that showed it, and the first once reloaded, ask for a scene from the Scenes panel, and the words line up at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    other = await context.newPage();
    otherConsole.attach(other);
    await otherSocket.attach(context, other);
    await other.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("the other device on the Keep", () => (otherSocket.you?.sceneId === run.keep ? true : null));
    await other.locator(".konvajs-content").first().waitFor();
    await openSideTab(dm, "Scenes");
    await dm.getByRole("button", { name: "More for Keep", exact: true }).click();
    const menu = dm.getByRole("dialog", { name: "Keep", exact: true });
    await menu.getByRole("button", { name: /^Delete/ }).click();
    const ask = dm.getByRole("dialog", { name: /^Delete Keep/ });
    await ask.getByRole("button", { name: "Delete", exact: true }).click();
    await waitFor("the Keep deleted", () => (dmSocket.state?.scenes[run.keep] ? null : true));
    assert.equal(dmSocket.state!.meta.playerSceneId, null, "the players are on no scene");
    await other.getByText(PICK, { exact: true }).waitFor();
    assert.equal(await other.getByText(CREATE, { exact: true }).count(), 0, "a room with a scene left never asks to create one");
    await shots.take(other, "bugss-scene-gone-other-device");
    const off: string[] = [];
    try {
      for (const scale of [1, 1.3]) {
        for (const size of [DESKTOP, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
          await dm.setViewportSize(size);
          await open(scale);
          const words = dm.getByText(PICK, { exact: true });
          await words.waitFor();
          off.push(...alignmentLines(await measureAlignment(words), `the words at ${size.width} x ${size.height} at ${Math.round(scale * 100)}%`));
          await shots.take(dm, `bugss-scene-gone-${size.width}-${Math.round(scale * 100)}`);
        }
      }
    } finally {
      await dm.setViewportSize(DESKTOP);
      await open(1);
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
    await dm.getByText(PICK, { exact: true }).waitFor();
    assert.equal(dmSocket.you?.sceneId, null, "a fresh page lands on no scene while the players have none");
  });

  test("bugss-3. Undo setup brings the Keep back with the players on it, and both devices open it", async () => {
    await undoSetup(dm);
    await waitFor("the Keep back with the players on it", () => (dmSocket.state?.meta.playerSceneId === run.keep && dmSocket.state.scenes[run.keep] ? true : null));
    for (const [label, page, watch] of [["the reloaded device", dm, dmSocket], ["the other device", other, otherSocket]] as const) {
      await waitFor(`${label} on the Keep`, () => (watch.you?.sceneId === run.keep ? true : null));
      await page.locator(".konvajs-content").first().waitFor();
      assert.equal(await page.getByText(PICK, { exact: true }).count(), 0, label);
    }
    await shots.take(other, "bugss-scene-back-open");
  });

  /*
   * A phone's half open sheet covers the middle of the map, where the words stand centered in the whole stage, so with a
   * panel open (BUGSS-PHONE-SHEET) they must stand in what the bars and the sheet leave clear.
   */
  test("fu7-1. on a phone with a panel open over the map, the words ask for a scene where the sheet does not hide them, at 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const hidden: string[] = [];
    try {
      // One load of the page for each interface size and a resize for each window, since every load is one more join the server counts.
      const hall = async () => {
        const id = uuidv7();
        await ops.send({ t: "scene.create", scene: { id, name: "Hall", bounds: { w: 20, h: 14 }, fogEnabled: false } });
        await ops.send({ t: "room.setPlayerScene", sceneId: id });
        return id;
      };
      for (const scale of [1, 1.3]) {
        // A page that loads lands on the players' scene. Once that is deleted, the device on nothing opens the next one the players get.
        let scene = await hall();
        await dm.setViewportSize({ width: 390, height: 844 });
        await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await dm.goto(`${server.origin}/r/${run.roomId}`);
        await dm.getByRole("button", { name: /^Panels/ }).waitFor();
        for (const [n, size] of [{ width: 390, height: 844 }, { width: 320, height: 568 }].entries()) {
          const at = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
          await dm.setViewportSize(size);
          if (n > 0) scene = await hall();
          // Generous: the page can be reconnecting for a while after the ops before it.
          await waitFor(`the phone on the Hall at ${at}`, () => (dmSocket.you?.sceneId === scene ? true : null), 60_000);
          await dm.locator(".konvajs-content").first().waitFor();
          if ((await dm.getByText("No fight is running.").count()) === 0) {
            await dm.getByRole("button", { name: /^Panels/ }).click();
            await dm.getByRole("button", { name: "Initiative", exact: true }).click();
          }
          await dm.getByText("No fight is running.").waitFor();
          await ops.send({ t: "scene.delete", sceneId: scene, leavePlayers: true });
          const words = dm.getByText(PICK, { exact: true });
          await words.waitFor();
          // Each end of the words' own text, which is read from the text node: the element is the whole stage.
          const clear = await waitFor(
            `the words clear of the sheet at ${at}`,
            async () => {
              const hits = await words.evaluate((el) => {
                const doc = (globalThis as unknown as { document: { createRange(): { selectNodeContents(n: unknown): void; getBoundingClientRect(): { left: number; right: number; top: number; bottom: number } }; elementFromPoint(x: number, y: number): unknown } }).document;
                const range = doc.createRange();
                range.selectNodeContents(el);
                const r = range.getBoundingClientRect();
                const y = (r.top + r.bottom) / 2;
                return [r.left + 2, (r.left + r.right) / 2, r.right - 2].map((x) => doc.elementFromPoint(x, y) === el);
              });
              return hits.every(Boolean) ? true : null;
            },
            5_000,
          ).catch(() => false);
          if (!clear) {
            const r = await words.evaluate((el) => {
              const doc = (globalThis as unknown as { document: { createRange(): { selectNodeContents(n: unknown): void; getBoundingClientRect(): { top: number; bottom: number; left: number; right: number } } } }).document;
              const range = doc.createRange();
              range.selectNodeContents(el);
              const b = range.getBoundingClientRect();
              return `${b.top.toFixed(0)} to ${b.bottom.toFixed(0)}, ${b.left.toFixed(0)} to ${b.right.toFixed(0)}`;
            });
            hidden.push(`${at}: the words at ${r}`);
          }
          await shots.take(dm, `fu7-scene-gone-sheet-${size.width}-${Math.round(scale * 100)}`);
        }
      }
    } finally {
      // Best effort, so a failure above is the one the run reports.
      await ops.send({ t: "room.setPlayerScene", sceneId: run.keep }).catch(() => undefined);
      await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1")).catch(() => undefined);
      await dm.setViewportSize(DESKTOP);
    }
    assert.deepEqual(hidden, [], "the words stood under the open sheet");
  });

  test("bugss-4. no console errors", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(otherConsole.errors, []);
  });
});
