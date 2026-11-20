import assert from "node:assert/strict";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, openSideTab, sideTabName, Shots, SocketWatch, sleep, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Areas through an opening (docs/design/design-v1-floors.md phase 4, 9.2),
 * on the real server serving the production build. Dana the DM and Ana,
 * who plays Thorn, are at desks. Tower has Ground floor (the players'
 * start) and Upper floor, 10 ft above it, with a 2 by 2 opening between
 * them. Labels carry the prefix FL4A.
 * - fl4a-0: the room: Thorn and a kobold on Upper floor, a goblin on
 *   Ground floor under the hole, and the DM's fireball over the hole.
 * - fl4a-1: the DM's Areas panel on Upper floor names the goblin below
 *   among those in the fireball, and Ana's, who holds both floors, the same.
 * - fl4a-2: the DM's Save and damage opens the group save with a row for
 *   the goblin below, the page holds both floors, and as No save its Apply
 *   hurts the goblin below and the kobold beside the hole alike.
 * - fl4a-3: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventy-five, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 75;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-areas-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const BOUNDS = { w: 24, h: 14 };
/** The hole on Upper floor and its lower end on Ground floor: 2 by 2. */
const HOLE = { x: 8, y: 4, w: 2, h: 2 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let dm: Page;
let ana: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana") };

const run = {
  roomId: "",
  roomName: `E2E floors areas ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: uuidv7(),
  anaId: "",
  thorn: uuidv7(),
  tThorn: uuidv7(),
  goblin: uuidv7(),
  kobold: uuidv7(),
  fireball: uuidv7(),
};

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 1, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
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

function cookieOf(context: BrowserContext): Promise<string> {
  return context.cookies(server.origin).then((list) => list.map((c) => `${c.name}=${c.value}`).join("; "));
}

async function openRoom(page: Page, watch: ConsoleWatch, socket: SocketWatch): Promise<void> {
  // A first visit asks for the member before the session cookie is read, which answers 403 once.
  watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor(`${watch.label}'s snapshot`, () => socket.state);
  watch.allow = [];
}

const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]").first();

/** Shows a page Upper floor by its floor key, from whichever floor it shows. */
async function showUpper(page: Page): Promise<void> {
  const shown = async () => ((await topBar(page).locator('[data-floors="button"]').getAttribute("aria-label").catch(() => null)) ?? "").startsWith("Floor: Upper floor.");
  await sleep(300);
  if (await shown()) return;
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press("]");
  await waitFor("Upper floor shown", async () => ((await shown()) ? true : null));
}

/** The fireball's row in a page's Areas panel. */
function fireballRow(page: Page) {
  return page.getByRole("tabpanel", { name: sideTabName("Areas") }).locator("li").filter({ hasText: "Fireball" }).first();
}

describe("areas through an opening", { concurrency: false, timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    anaContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
  });

  after(async () => {
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

  test("fl4a-0. a room with Tower's two floors and an opening, Thorn and a kobold on Upper floor, a goblin under the hole on Ground floor, and the DM's fireball over the hole", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=(.+)$/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.ground = dmSocket.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });
    run.anaId = await join(anaContext, "Ana", "#30a46c");

    // Fog off on both floors, so every list reads the room whole, and party vision off, since areas reach through an opening without it.
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor", height: 10 }, fogEnabled: false } });
    await ops.send({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: run.upper, to: run.ground, rect: HOLE, kind: "opening" } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.anaId], actor: actor(30) } });
    const shown = { size: "medium", visibility: "all" } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.upper, kind: "pc", name: "Thorn", ownerIds: [run.anaId], actor: { ref: run.thorn }, disposition: "ally", x: 2, y: 2, ...shown } });
    await ops.send({ t: "token.create", token: { id: run.kobold, sceneId: run.upper, kind: "monster", name: "Kobold", disposition: "hostile", actor: { inline: actor(20) }, x: HOLE.x + 2, y: HOLE.y, ...shown } });
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.ground, kind: "monster", name: "Goblin", disposition: "hostile", actor: { inline: actor(20) }, x: HOLE.x, y: HOLE.y, ...shown } });
    const dmId = dmSocket.you!.memberId;
    await ops.send({ t: "template.create", template: { id: run.fireball, sceneId: run.upper, shape: "sphere", size: 20, origin: { x: HOLE.x + 1, y: HOLE.y + 1, z: 0 }, yaw: 0, includeOrigin: true, color: "#e5484d", ownerId: dmId, visibility: "all", spell: "Fireball" } });
    await ops.send({ t: "floor.open", sceneId: run.upper, open: true });
    await waitFor("three creatures in the DM's copy", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 3 ? true : null));
    await openRoom(ana, consoles.ana, anaSocket);
    await waitFor("both floors in Ana's copy", () => ((anaSocket.state as RoomState | null)?.tokens[run.goblin] && (anaSocket.state as RoomState | null)?.templates[run.fireball] ? true : null));
  });

  test("fl4a-1. the Areas panel on Upper floor names the goblin below among those in the fireball, the DM's and Ana's alike", async () => {
    for (const [page, who] of [[dm, "dm"], [ana, "ana"]] as const) {
      await showUpper(page);
      await openSideTab(page, "Areas");
      const row = fireballRow(page);
      await waitFor(`${who}'s fireball row`, async () => (/In area \(2\): Goblin, Kobold/.test((await row.textContent()) ?? "") ? true : null), 15_000);
      await shots.take(page, `fl4a-1-${who}-areas-panel`);
    }
  });

  test("fl4a-2. Save and damage opens the group save with the goblin below among its rows, its page holding both floors, and its Apply hurts it", async () => {
    await fireballRow(dm).getByRole("button", { name: "Save and damage" }).click();
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Areas") });
    await waitFor("the group save's rows", async () => {
      const text = (await panel.textContent()) ?? "";
      return text.includes("Goblin") && text.includes("Kobold") ? true : null;
    }, 15_000);
    const source = await waitFor("the page's draft", async () => {
      const raw = await dm.evaluate((key) => sessionStorage.getItem(key), `rvtt.groupSave.${run.roomId}`);
      return raw ? (JSON.parse(raw) as { page: { sceneId: string; source: unknown } }).page : null;
    });
    assert.equal(source.sceneId, run.upper);
    assert.deepEqual(source.source, { kind: "area", templateId: run.fireball, floors: [run.upper, run.ground] });
    await shots.take(dm, "fl4a-2-dm-group-save");

    await panel.getByRole("radiogroup", { name: "What they roll" }).getByRole("radio", { name: "No save" }).check({ force: true });
    const damage = panel.getByLabel("Damage", { exact: true });
    await damage.fill("10");
    await damage.blur();
    await panel.getByRole("button", { name: /^Apply: / }).click();
    await panel.getByText("Applied to 2. Undo takes it all back.").waitFor();
    const hp = (id: string) => {
      const a = dmSocket.state?.tokens[id]?.actor;
      return a && "inline" in a ? a.inline.hp?.cur : undefined;
    };
    for (const [id, name] of [[run.goblin, "the goblin below"], [run.kobold, "the kobold"]] as const) await waitFor(`${name} at 10`, () => (hp(id) === 10 ? true : null));
    await shots.take(dm, "fl4a-2-dm-applied");
  });

  test("fl4a-3. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
