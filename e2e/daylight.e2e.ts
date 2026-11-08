import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSceneGroup, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { playControl } from "./helpers/undoScope.ts";

/**
 * Time of day light and dawn and dusk (docs/design/design-v1-calendar-c2c3.md
 * 5 and 10), on the real server serving the production build. Dana the DM is
 * at a desk and Pat on a phone, both on the room's first scene:
 * - dl-1: Light gains Time of day. A step past dusk relights the scene in the
 *   same op, Pat's copy carries the level and no flag, and Undo takes the
 *   light back. Picking Bright by hand turns Time of day off.
 * - dl-2: Dawn and dusk saved from Time, with its refusal under the field,
 *   Undo setup's label, and a scene on Time of day following the new times.
 * - dl-3: dawn at 5:30 AM moves the part of the day, the chip's name, To dawn
 *   and Pat's Time panel.
 * - dl-4: with the clock hidden, Pat's scene still carries the level and
 *   never the flag, and his copy holds no clock or dawn and dusk.
 *
 * Steps dl-1 to dl-4 need the daylight model (the pass that rewrites the
 * level and the clock's `daylight`), so they read as failures until that
 * lane's commits are under it. The design's map phase case (a Night phase with
 * its own light turns Time of day off) is covered by the reducer's tests: a
 * phase needs an uploaded map image, which this file does not build.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-one, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 61;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-daylight-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

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

const run = { roomId: "", roomName: `E2E daylight ${new Date().toISOString().slice(0, 19)}`, patId: "", sceneId: "", clockId: randomUUID() };

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const HOUR = 3_600;
const MINUTE = 60;
/** Day 1, 4:00 PM: an hour before the room's default dusk. */
const START = 16 * HOUR;

const sceneOf = (socket: SocketWatch) => socket.state?.scenes[run.sceneId];
const lightOf = (socket: SocketWatch) => sceneOf(socket)?.vision?.light;
const clockT = (socket: SocketWatch, t: number) => waitFor(`the clock at ${t} in ${socket.label}'s copy`, () => (socket.state?.clock?.t === t ? true : null));

/** The DM's Time panel, to step and to change dawn and dusk from. */
async function timePanel(): Promise<Locator> {
  await openSideTab(dm, "Time");
  return dm.getByRole("tabpanel", { name: sideTabName("Time") });
}

async function step(label: string): Promise<void> {
  const panel = await timePanel();
  await panel.getByRole("group", { name: "Move the clock on" }).getByRole("button", { name: `Move the clock on ${label}`, exact: true }).click();
}

/** The scene's Light group in the DM's Scenes panel, unfolded. */
async function lightGroup(): Promise<Locator> {
  await openSideTab(dm, "Scenes");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  await openSceneGroup(panel, "Light and weather");
  // The group lays its choices out as a grid of its own, so it has no box to wait for: its first choice does.
  await panel.getByRole("radiogroup", { name: "Light level" }).getByRole("radio", { name: "Bright", exact: true }).waitFor();
  return panel;
}

describe("time of day light and dawn and dusk", () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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

  test("dl-0. a DM's room with Pat on a phone, party vision on the first scene and a running clock at 4:00 PM", async () => {
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

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];

    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true, vision: { on: true, light: "bright" } } });
    await ops.send({ t: "clock.start", id: run.clockId, at: START, shown: true, calendar: { kind: "days" } });
    await clockT(patSocket, START);
    await waitFor("party vision on in Pat's copy", () => (sceneOf(patSocket)?.vision?.on === true ? true : null));
  });

  test("dl-1. a step past dusk relights a Time of day scene in the same op, Pat sees the level and no flag, Undo takes it back, and Bright by hand turns it off", async () => {
    const panel = await lightGroup();
    const level = panel.getByRole("radiogroup", { name: "Light level" });
    assert.deepEqual(await level.getByRole("radio").evaluateAll((els) => els.map((el) => (el.closest("label")?.textContent ?? "").trim())), ["Bright", "Dim", "Dark", "Time of day"]);
    await level.getByRole("radio", { name: "Time of day", exact: true }).check();
    await waitFor("Time of day stored", () => (sceneOf(dmSocket)?.vision?.byClock === true ? true : null));
    assert.equal(lightOf(dmSocket), "bright", "4:00 PM is the afternoon");
    await panel.getByText("Follows the time of day: Bright by day, Dim at dawn and dusk, Dark at night. It is Bright now.", { exact: true }).waitFor();
    await level.scrollIntoViewIfNeeded();
    await shots.take(dm, "dl-1-time-of-day");

    await step("1 hour");
    await clockT(dmSocket, START + HOUR);
    assert.equal(lightOf(dmSocket), "bright", "5:00 PM is still the afternoon");
    await step("1 hour");
    await clockT(dmSocket, START + 2 * HOUR);
    await waitFor("the scene dim at dusk", () => (lightOf(dmSocket) === "dim" ? true : null));
    await waitFor("Pat's scene dim", () => (lightOf(patSocket) === "dim" ? true : null));
    assert.equal(sceneOf(patSocket)?.vision && "byClock" in sceneOf(patSocket)!.vision!, false, "the flag is the DM's alone");
    await shots.take(pat, "dl-1-pat-dusk");

    await playControl(dm, "undo").click();
    await clockT(dmSocket, START + HOUR);
    await waitFor("the light back to bright in the same undo", () => (lightOf(dmSocket) === "bright" && lightOf(patSocket) === "bright" ? true : null));
    assert.equal(sceneOf(dmSocket)?.vision?.byClock, true, "Undo keeps Time of day");

    await step("1 hour");
    await waitFor("dim again", () => (lightOf(dmSocket) === "dim" ? true : null));
    const group = await lightGroup();
    await group.getByRole("radiogroup", { name: "Light level" }).getByRole("radio", { name: "Bright", exact: true }).check();
    await waitFor("Bright by hand and the flag gone", () => (lightOf(dmSocket) === "bright" && sceneOf(dmSocket)?.vision?.byClock === undefined ? true : null));
    await step("10 minutes");
    await clockT(dmSocket, START + 2 * HOUR + 10 * MINUTE);
    assert.equal(lightOf(dmSocket), "bright", "a scene off Time of day does not follow the clock");
    // Stepping opened the Time tab, so the Scenes panel is opened again.
    await (await lightGroup()).getByRole("radiogroup", { name: "Light level" }).getByRole("radio", { name: "Time of day", exact: true }).check();
    await waitFor("Time of day reads the time at once", () => (lightOf(dmSocket) === "dim" ? true : null));
  });

  test("dl-2. Dawn and dusk saved from Time: the refusal under the field, one setup step, and the scene follows the new dusk", async () => {
    const panel = await timePanel();
    const row = panel.getByRole("heading", { name: "Dawn and dusk", exact: true }).locator("xpath=ancestor::section[1]");
    await row.getByText("6:00 AM and 6:00 PM", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Change", exact: true }).click();
    const dawn = row.getByLabel("Dawn", { exact: true });
    const dusk = row.getByLabel("Dusk", { exact: true });
    assert.equal(await dawn.evaluate((el) => el === el.ownerDocument.activeElement), true, "Change focuses Dawn");
    await dawn.fill("11:01");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await row.getByText("Pick a dawn from 12:00 AM to 11:00 AM.", { exact: true }).waitFor();
    assert.equal(dmSocket.state?.clock?.daylight, undefined, "nothing was sent");
    await dawn.fill("06:00");
    await dusk.fill("23:01");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await row.getByText("Pick a dusk from 12:00 PM to 11:00 PM.", { exact: true }).waitFor();

    // Dusk at 8:00 PM, so 6:10 PM is the afternoon and the scene goes bright.
    await dusk.fill("20:00");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("daylight in the DM's copy", () => (dmSocket.state?.clock?.daylight?.dusk === 20 * HOUR ? true : null));
    await row.getByText("6:00 AM and 8:00 PM", { exact: true }).waitFor();
    assert.equal(await row.getByRole("button", { name: "Change", exact: true }).evaluate((el) => el === el.ownerDocument.activeElement), true, "Save gives focus back to Change");
    await waitFor("the scene bright under the later dusk", () => (lightOf(dmSocket) === "bright" ? true : null));
    await waitFor("Pat's copy of the times", () => (patSocket.state?.clock?.daylight?.dusk === 20 * HOUR ? true : null));
    await row.scrollIntoViewIfNeeded();
    await shots.take(dm, "dl-2-dawn-and-dusk");
    await dm.getByRole("button", { name: "Undo", exact: true }).first().waitFor();
  });

  test("dl-3. dawn at 5:30 AM moves the part of the day, the chip's name, To dawn and Pat's Time panel", async () => {
    const panel = await timePanel();
    const row = panel.getByRole("heading", { name: "Dawn and dusk", exact: true }).locator("xpath=ancestor::section[1]");
    await row.getByRole("button", { name: "Change", exact: true }).click();
    await row.getByLabel("Dawn", { exact: true }).fill("05:30");
    await row.getByLabel("Dusk", { exact: true }).fill("18:00");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("dawn at 5:30 in the DM's copy", () => (dmSocket.state?.clock?.daylight?.dawn === 5 * HOUR + 30 * MINUTE ? true : null));
    await ops.send({ t: "clock.set", at: 24 * HOUR + 5 * HOUR + 40 * MINUTE });
    await clockT(dmSocket, 24 * HOUR + 5 * HOUR + 40 * MINUTE);
    await dm.getByRole("button", { name: "Time: Day 2, 5:40 AM, Dawn", exact: true }).waitFor();
    await panel.getByText("5:40 AM, Dawn", { exact: true }).waitFor();
    await waitFor("the scene dim at dawn", () => (lightOf(dmSocket) === "dim" ? true : null));
    await panel.getByRole("button", { name: "Move the clock on to dawn, 5:30 AM", exact: true }).waitFor();

    // A phone has no side panel: Time is a sheet from the tool bar's Panels list.
    await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await pat.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Time/ }).click();
    await pat.getByText("5:40 AM, Dawn", { exact: true }).waitFor();
    await shots.take(pat, "dl-3-pat-time");
    await shots.take(dm, "dl-3-dm-dawn");
  });

  test("dl-4. with the clock hidden, Pat's scene still carries the level and no flag, and his copy holds no clock", async () => {
    await ops.send({ t: "clock.update", shown: false });
    await waitFor("no clock in Pat's copy", () => (patSocket.state?.clock == null ? true : null));
    const leaked = JSON.stringify(patSocket.state).match(/.{60}daylight.{60}/)?.[0];
    assert.equal(leaked, undefined, "no dawn or dusk in Pat's copy");
    const frames = patSocket.received.length;
    await ops.send({ t: "clock.set", at: 24 * HOUR + 12 * HOUR });
    await waitFor("the scene bright at noon", () => (lightOf(dmSocket) === "bright" ? true : null));
    await waitFor("Pat's scene bright", () => (lightOf(patSocket) === "bright" ? true : null));
    await ops.send({ t: "clock.set", at: 24 * HOUR + 22 * HOUR });
    await waitFor("the scene dark at 10:00 PM", () => (lightOf(dmSocket) === "dark" ? true : null));
    await waitFor("Pat's scene dark with no clock", () => (lightOf(patSocket) === "dark" ? true : null));
    assert.equal(sceneOf(patSocket)?.vision && "byClock" in sceneOf(patSocket)!.vision!, false);
    assert.equal(patSocket.state?.clock, undefined);
    const text = patSocket.received.slice(frames).join("");
    assert.equal(text.includes(run.clockId) || text.includes("byClock") || text.includes("daylight"), false, "no frame Pat got names the hidden clock, the flag or the times");
    const panel = await lightGroup();
    await panel.getByText("Players don't see the date and time, but they see the light change.").waitFor();
    await shots.take(dm, "dl-4-hidden-clock-help");
    await ops.send({ t: "clock.update", shown: true });
  });
});
