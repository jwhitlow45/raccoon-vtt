import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The DM menu and the search on a scene of several floors (docs/design/design-v1-floors.md
 * 7.3, 18.6, 18.7), on the real server serving the production build. Dana the DM is at a
 * desk with a second DM, Sam, on another computer. Pat plays Thorn on a phone. Tower has
 * three floors, Ground (where the players start), Upper and Attic, with a goblin on Upper
 * and a bat on Attic. Labels carry the prefix FLRM.
 * - flrm-0: the room, its floors and its tokens.
 * - flrm-1: the search's Floor rows show a floor, and on Upper, which the players have not
 *   reached, Move players here names the floor and Bring everyone here is off with its line.
 * - flrm-2: Pat, who holds Ground alone, finds nothing of Upper or Attic, has no Floor row
 *   and was sent none of their ids or names. It runs before any step reaches Upper to the players.
 * - flrm-3: Show on Upper, and Bring everyone here is on.
 * - flrm-4: a guarded reveal that another DM overtakes with a move to Ground: the refusal
 *   names a floor.
 * - flrm-5: the search finds a token on another floor of the scene, tagged by its floor,
 *   and picking it shows its floor.
 * - flrm-6: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty, one file after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 60;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-menus-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let coContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
let coOps: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E floors menus ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  dmKey: "",
  ground: "",
  upper: randomUUID(),
  attic: randomUUID(),
  patId: "",
  thorn: randomUUID(),
  tThorn: randomUUID(),
  goblin: randomUUID(),
  bat: randomUUID(),
};

/** The DM page's room socket, routed so a step can hold back the frames it sends. */
const wire: { hold: ((frame: string) => boolean) | null; held: (() => void)[] } = { hold: null, held: [] };

async function routeDmSocket(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\?room=/, (socket: WebSocketRoute) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const sent = String(message);
      if (wire.hold?.(sent)) wire.held.push(() => upstream.send(sent));
      else upstream.send(sent);
    });
    upstream.onMessage((message) => socket.send(String(message)));
  });
}

function release(): void {
  wire.hold = null;
  for (const send of wire.held.splice(0)) send();
}

type DomNode = { getAttribute(name: string): string | null };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
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

const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]").first();
const chip = (page: Page, kind: string) => topBar(page).locator(`[data-chip="${kind}"]`);
const menuOf = (page: Page, mark: "dm" | "blackout") => page.locator(`[role="menu"][data-chip-menu="${mark}"]`);
const item = (menu: Locator, id: string) => menu.locator(`[data-chip-item="${id}"]`);
const sheet = (page: Page) => page.locator("dialog[data-search-sheet]");
const field = (page: Page) => page.locator("[data-search-field]");
const row = (page: Page, id: string) => page.locator(`[data-search-row="${id}"]`);

async function openMenu(page: Page, kind: "dm" | "blackout", mark: "dm" | "blackout" = kind): Promise<Locator> {
  const menu = menuOf(page, mark);
  if (await menu.isVisible()) return menu;
  await chip(page, kind).click();
  await menu.waitFor();
  return menu;
}

async function closeMenu(page: Page, menu: Locator): Promise<void> {
  if ((await menu.count()) === 0) return;
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

/** An element's description, the words its aria-describedby names. */
function describedBy(el: Locator): Promise<string> {
  return el.evaluate((found) => {
    const node = found as unknown as DomNode & { ownerDocument: { getElementById(id: string): { textContent: string | null } | null } };
    const ids = (node.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    return ids.map((id) => node.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
  });
}

/** Types into the search and waits until `id` is listed, or until nothing is when `id` is null. */
async function searchFor(page: Page, text: string, id: string | null): Promise<string[]> {
  if ((await sheet(page).count()) === 0) await page.keyboard.press("Control+k");
  await sheet(page).waitFor();
  await field(page).fill(text);
  return waitFor(`"${text}" lists ${id ?? "nothing of floors"}`, async () => {
    const ids = await page.locator("[data-search-row]").evaluateAll((els) => els.map((e) => (e as unknown as DomNode).getAttribute("data-search-row") ?? ""));
    return id === null || ids.includes(id) ? ids : null;
  }, 8_000);
}

async function pickRow(page: Page, text: string, id: string): Promise<void> {
  const ids = await searchFor(page, text, id);
  for (let i = 0; i < ids.indexOf(id); i++) await page.keyboard.press("ArrowDown");
  assert.equal(await row(page, id).getAttribute("aria-selected"), "true", `${id} is highlighted`);
  await page.keyboard.press("Enter");
  await sheet(page).waitFor({ state: "detached" });
}

/** The DM looks at a floor, by its Floor row in the search. */
async function dmShows(floorId: string, typed: string): Promise<void> {
  if (dmSocket.you?.sceneId === floorId) return;
  await pickRow(dm, typed, `floor:${floorId}`);
  await waitFor(`the DM on ${typed}`, () => (dmSocket.you?.sceneId === floorId ? true : null), 20_000);
}

async function playersOn(sceneId: string, blackout: boolean): Promise<void> {
  await waitFor(`the players on ${sceneId} with the blackout ${blackout ? "on" : "off"}`, () => {
    const meta = dmSocket.state?.meta;
    return meta && meta.playerSceneId === sceneId && meta.view.blackout === blackout ? true : null;
  });
}

/** Puts the players and the blackout as a step starts, from Sam's socket, so the DM's own Undo history stays the DM's. */
async function setTable(sceneId: string, blackout: boolean): Promise<void> {
  if (dmSocket.state?.meta.playerSceneId !== sceneId) await coOps.send({ t: "room.setPlayerScene", sceneId });
  if (dmSocket.state?.meta.view.blackout !== blackout) await coOps.send({ t: "view.blackout", blackout });
  await playersOn(sceneId, blackout);
}

describe("The DM menu and the search on a scene of several floors", { concurrency: false }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    coContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await routeDmSocket(dm);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    coOps?.close();
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

  test("flrm-0. a room with a second DM, Pat's Thorn on Ground, and Tower's three floors with a goblin on Upper and a bat on Attic", async () => {
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
    run.dmKey = match[2]!;
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.ground = dmSocket.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    run.patId = await join(patContext, "Pat", "#30a46c");
    const claimed = await coContext.request.post(`${server.origin}/api/rooms/${run.roomId}/dm`, { headers: { Origin: server.origin, "content-type": "application/json" }, data: { key: run.dmKey, name: "Sam", color: "#8e4ec6" } });
    assert.ok(claimed.ok(), `Sam's claim answered ${claimed.status()}: ${await claimed.text()}`);
    coOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(coContext) });

    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower" } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: { w: 12, h: 10 } }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.create", scene: { id: run.attic, name: "Tower", bounds: { w: 12, h: 10 } }, floor: { beside: run.upper, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor" } } });
    await ops.send({ t: "scene.update", sceneId: run.attic, patch: { floor: { name: "Attic" } } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const at = { size: "medium", visibility: "all", x: 4, y: 4 } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.ground, kind: "pc", name: "Thorn", ownerIds: [run.patId], actor: { ref: run.thorn }, disposition: "ally", ...at } });
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.upper, kind: "monster", name: "Goblin", disposition: "hostile", actor: { inline: actor(7) }, ...at } });
    await ops.send({ t: "token.create", token: { id: run.bat, sceneId: run.attic, kind: "monster", name: "Bat", disposition: "hostile", actor: { inline: actor(4) }, ...at } });
    await waitFor("three floors in the DM's copy", () => (Object.values(dmSocket.state?.scenes ?? {}).filter((s) => s.floor !== undefined).length === 3 ? true : null));

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("flrm-1. the search shows a floor, then on Upper, which the players have not reached, Move players here names the floor and Bring everyone here is off with its line", async () => {
    await dmShows(run.upper, "upper floor");
    const menu = await openMenu(dm, "dm");
    const move = item(menu, "movePlayers");
    await move.waitFor();
    assert.match(await move.innerText(), /on Tower · Upper floor/);
    const bring = item(menu, "bringEveryone");
    assert.equal(await bring.getAttribute("aria-disabled"), "true");
    assert.equal(await describedBy(bring), "Players haven't reached Upper floor, so their maps stay.");
    assert.equal(await describedBy(item(menu, "follow")), "Players haven't reached Upper floor, so their maps stay.");
    await shots.take(dm, "flrm-1-dm-menu-unreached");
    await closeMenu(dm, menu);
  });

  test("flrm-2. Pat, who holds Ground alone, finds nothing of Upper or Attic, has no Floor row, and was sent none of their ids or names", async () => {
    for (const word of ["goblin", "bat", "upper floor", "attic"]) {
      await searchFor(pat, word, null);
      await pat.waitForTimeout(300);
      const ids = await pat.locator("[data-search-row]").evaluateAll((els) => els.map((e) => (e as unknown as DomNode).getAttribute("data-search-row") ?? ""));
      assert.ok(!ids.some((id) => id.startsWith("floor:") || id === `token:${run.goblin}` || id === `token:${run.bat}`), `Pat's "${word}": ${ids.join(", ")}`);
      await pat.keyboard.press("Escape");
      await sheet(pat).waitFor({ state: "detached" });
    }
    const seen = patSocket.received.join("\n");
    for (const secret of [run.upper, run.attic, run.goblin, run.bat, "Upper floor", "Attic"]) assert.ok(!seen.includes(secret), `a frame Pat received holds ${secret}`);
  });

  test("flrm-3. once Upper is shown to the players, Bring everyone here is on and sends the camera", async () => {
    await ops.send({ t: "floor.open", sceneId: run.upper, open: true });
    const menu = await openMenu(dm, "dm");
    const bring = item(menu, "bringEveryone");
    await waitFor("Bring everyone here on", async () => ((await bring.getAttribute("aria-disabled")) === "true" ? null : true));
    assert.equal(await describedBy(bring), "");
    const from = dmSocket.sent.length;
    await bring.click();
    // The camera goes out as an ephemeral event for the floor in view, which only players holding it are sent.
    await waitFor("the camera sent", () => (dmSocket.sent.slice(from).some((f) => f.startsWith('{"t":"eph"') && f.includes(run.upper)) ? true : null));
    await dm.locator("[data-toast]").filter({ hasText: "Players' maps moved to what you see now." }).first().waitFor();
    assert.equal(dmSocket.state?.meta.playerSceneId, run.ground, "Bring everyone here moves no one");
  });

  test("flrm-4. Sam moves the players to Ground between a reveal's move and its lift: the lift is refused with the words for a floor", async () => {
    await setTable(run.ground, true);
    await dmShows(run.upper, "upper floor");
    wire.hold = (frame) => frame.includes('"whilePlayersOn"');
    const menu = await openMenu(dm, "blackout");
    const show = item(menu, "showPlayers");
    assert.match(await show.innerText(), /Show players Tower · Upper floor/);
    try {
      await show.click();
      await playersOn(run.upper, true);
      await coOps.send({ t: "room.setPlayerScene", sceneId: run.ground });
      await playersOn(run.ground, true);
    } finally {
      release();
    }
    const words = "Not shown: the players are on another floor now. The blackout stays on.";
    await show.getByText(words).first().waitFor();
    assert.equal(dmSocket.state?.meta.view.blackout, true);
    await shots.take(dm, "flrm-4-lift-refused-floor");
    await closeMenu(dm, menu);
    await setTable(run.ground, false);
  });

  test("flrm-5. the search finds the goblin on Upper while the DM looks at Ground, tagged by its floor, and picking it shows Upper and selects him", async () => {
    await dmShows(run.ground, "ground floor");
    const ids = await searchFor(dm, "goblin", `token:${run.goblin}`);
    assert.ok(ids.includes(`token:${run.goblin}`));
    assert.match(await row(dm, `token:${run.goblin}`).innerText(), /Monster on Tower · Upper floor/);
    await searchFor(dm, "attic", `floor:${run.attic}`);
    assert.match(await row(dm, `floor:${run.attic}`).innerText(), /Floor · Tower/);
    await field(dm).fill("goblin");
    await row(dm, `token:${run.goblin}`).click();
    await sheet(dm).waitFor({ state: "detached" });
    await waitFor("the DM on Upper", () => (dmSocket.you?.sceneId === run.upper ? true : null), 20_000);
    await dm.locator("[data-token-bar], [data-action-bar]").first().waitFor({ timeout: 8_000 }).catch(() => undefined);
    await shots.take(dm, "flrm-5-token-on-another-floor");
  });

  test("flrm-6. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
