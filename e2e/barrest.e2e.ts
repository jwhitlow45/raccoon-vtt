import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

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

/** A token placed in the room: its id, name and cell. */
type Placed = { id: string; name: string; x: number; y: number };
const placed = (name: string, x: number, y: number): Placed => ({ id: randomUUID(), name, x, y });

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
  allosaurus: placed("Allosaurus", 28, 0),
  dragon: placed("Adult Black Dragon", 0, 17),
  ancient: placed("Ancient Black Dragon", 26, 16),
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

  describe("br-f: the strip's place, reach and the clearing move", () => {});

  // ------------------------------------------------------------ br-c: the content (the content lane)

  describe("br-c: the strip's header, HP entry and quick row", () => {});
});
