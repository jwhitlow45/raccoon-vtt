import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { NO_ROOM_TO_EXPLORE } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { applyChanges, type ProjectedState } from "#shared/project.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The top bar's chips and their menus (docs/design/design-v1-qol.md 4 and 8,
 * qc-1 to qc-13), on the real server serving the production build. Dana the
 * DM is at a desk with a second DM, Sam, on another computer. Pat plays Thorn
 * on a phone, Ana plays Wren and Lee joins to be shown a handout and then
 * removed. The room has three more scenes beside the players' Citadel gate:
 * the Crypt of Belak (fog on, vision off, so a move asks nothing), the Open
 * field (fog off, so a move asks first) and a side chamber Sam deletes. The
 * bar's give-way, Next and the worst cases run in chips-bar.e2e.ts.
 * - qc-0: the room.
 * - qc-1: the DM menu at rest, its keys, a phase picked, and Sam's the same.
 * - qc-2: Black out from the menu, then End the blackout leads it.
 * - qc-4: Players see black by keys, and focus to the DM chip as it leaves.
 * - qc-6: Move players here from another scene: Follow me's note, the wait
 *   past 200 ms, a second press refused, and the close on acceptance.
 * - qc-3b: a move that warns asks first, by its anyway item and Cancel, and
 *   Escape sends nothing.
 * - qc-3: Show players <scene> in one Undo, the chip kept while the lift is
 *   out, and no frame of the old scene lit on Pat's socket.
 * - qc-3c: a refused move in the item, as a toast after Escape, a quota
 *   refusal's words, and Sam deleting the scene meanwhile.
 * - qc-3d: Sam moving the players between the move and the lift: the lift
 *   refused, the blackout kept, and the DM's Undo refused.
 * - qc-5: the crossed eye at 390 x 844 opens the DM menu, blackout first.
 * - qc-8: Show a handout… in a dialog, its draft kept, focus back.
 * - qc-7: recent handouts again from the menu, each to its own audience,
 *   one with nobody left not offered, and the remembered title.
 * - qc-9: the clock chip's steps at 1440, the side panel's tab kept.
 * - qc-10: the clock gone from the bar at 900 x 900, the menu's Time sheet.
 * - qc-12: Pat's You menu: his own sheet only, and the X-card sheet.
 * - qc-13: View as Pat: his You menu with its X-card off.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-seven, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 57;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-chips-"));
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
let co: Page;
let pat: Page;
let ops: OpSocket;
let coOps: OpSocket;
const dmSocket = new SocketWatch("dm");
const coSocket = new SocketWatch("co-DM");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const coConsole = new ConsoleWatch("co-DM");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E chips ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  dmKey: "",
  citadel: "",
  crypt: randomUUID(),
  field: randomUUID(),
  chamber: randomUUID(),
  phases: [randomUUID(), randomUUID()] as const,
  patId: "",
  anaId: "",
  leeId: "",
  thorn: randomUUID(),
  wren: randomUUID(),
  images: [] as string[],
};

/**
 * The DM page's room socket, routed so a step can hold back the frames it
 * sends, spoil one on its way out, or change the server's answer on its
 * way in. `out` keeps every frame the page tried to send, held or not, so
 * a second press is counted where it was made.
 */
const wire: {
  out: string[];
  hold: ((frame: string) => boolean) | null;
  held: (() => void)[];
  spoil: ((frame: string) => string) | null;
  answer: ((frame: string) => string) | null;
} = { out: [], hold: null, held: [], spoil: null, answer: null };

async function routeDmSocket(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\?room=/, (socket: WebSocketRoute) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const sent = String(message);
      wire.out.push(sent);
      const frame = wire.spoil ? wire.spoil(sent) : sent;
      if (wire.hold?.(frame)) wire.held.push(() => upstream.send(frame));
      else upstream.send(frame);
    });
    upstream.onMessage((message) => socket.send(wire.answer ? wire.answer(String(message)) : String(message)));
  });
}

function release(): void {
  wire.hold = null;
  for (const send of wire.held.splice(0)) send();
}

function clearWire(): void {
  release();
  wire.spoil = null;
  wire.answer = null;
}

/** The ops of type `t` the DM page tried to send since `from`. */
function sentOps(from: number, t: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const frame of wire.out.slice(from)) {
    let msg: { t?: string; op?: { t?: string } };
    try {
      msg = JSON.parse(frame) as typeof msg;
    } catch {
      continue;
    }
    if (msg.t === "op" && msg.op?.t === t) found.push(msg.op as Record<string, unknown>);
  }
  return found;
}

/** Each state Pat's socket held from frame `from` on, as the players' scene and whether the blackout is on, replayed from `start`. */
function patSaw(from: number, start: RoomState): { scene: string | null; blackout: boolean }[] {
  let state = structuredClone(start) as unknown as ProjectedState;
  const seen: { scene: string | null; blackout: boolean }[] = [];
  for (const frame of patSocket.received.slice(from)) {
    let msg: { t?: string; state?: unknown; changes?: unknown };
    try {
      msg = JSON.parse(frame) as typeof msg;
    } catch {
      continue;
    }
    if (msg.t === "snapshot") state = msg.state as ProjectedState;
    else if (msg.t === "ev") state = applyChanges(state, msg.changes as never);
    else continue;
    const meta = (state as unknown as RoomState).meta;
    seen.push({ scene: meta.playerSceneId, blackout: meta.view?.blackout === true });
  }
  return seen;
}

/** Pat's frames from now on, for patSaw. */
function patMark(): { from: number; start: RoomState } {
  assert.ok(patSocket.state, "Pat has a snapshot");
  return { from: patSocket.received.length, start: structuredClone(patSocket.state) };
}

/** What the page functions below read of the DOM: the e2e files compile without the DOM's types. */
type DomNode = {
  tagName: string;
  children: ArrayLike<DomNode>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): DomNode | null;
  ownerDocument: { getElementById(id: string): DomNode | null; activeElement: DomNode | null };
};

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function picture(rgb: [number, number, number], w = 400, h = 300): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

async function upload(kind: "map" | "handout", data: Buffer): Promise<{ id: string; width: number; height: number }> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  return (await res.json()) as { id: string; width: number; height: number };
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

function topBar(page: Page | Locator): Locator {
  return page.locator("header[data-rvtt-topbar]").first();
}

function chip(page: Page | Locator, kind: string): Locator {
  return topBar(page).locator(`[data-chip="${kind}"]`);
}

function menuOf(page: Page, mark: "dm" | "blackout" | "you"): Locator {
  return page.locator(`[role="menu"][data-chip-menu="${mark}"]`);
}

function item(menu: Locator, id: string): Locator {
  return menu.locator(`[data-chip-item="${id}"]`);
}

/** Opens a chip's menu with a click, after closing whatever is open. */
async function openMenu(page: Page, kind: "dm" | "blackout" | "you", mark: "dm" | "blackout" | "you" = kind, within: Page | Locator = page): Promise<Locator> {
  const menu = menuOf(page, mark);
  if (await menu.isVisible()) return menu;
  await chip(within, kind).click();
  await menu.waitFor();
  return menu;
}

async function closeMenu(page: Page, menu: Locator): Promise<void> {
  if ((await menu.count()) === 0) return;
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

/** The menu as drawn: "---" for a line, "# <heading>" for a section's name, then each item's id with every member's and scene's id put back as its name. */
async function shape(menu: Locator): Promise<string[]> {
  const raw = await menu.evaluate((node) => {
    const root = node as unknown as DomNode;
    const out: string[] = [];
    const walk = (el: DomNode) => {
      for (const child of Array.from(el.children)) {
        const role = child.getAttribute("role");
        if (role === "separator") out.push("---");
        else if (role === "group") {
          const id = child.getAttribute("aria-labelledby") ?? "";
          out.push(`# ${root.ownerDocument.getElementById(id)?.textContent ?? ""}`);
          walk(child);
        } else if (child.hasAttribute("data-chip-item")) out.push(child.getAttribute("data-chip-item") ?? "");
      }
    };
    walk(root);
    return out;
  });
  const names: [string, string][] = [
    [run.patId, "Pat"],
    [run.anaId, "Ana"],
    [run.leeId, "Lee"],
    [run.phases[0], "Day"],
    [run.phases[1], "Night"],
    [run.thorn, "Thorn"],
    [run.wren, "Wren"],
    ...run.images.map((id, i): [string, string] => [id, `image${i + 1}`]),
  ];
  return raw.map((line) => names.reduce((text, [id, name]) => (id ? text.split(id).join(name) : text), line));
}

/** An element's description, the words its aria-describedby names. */
function describedBy(el: Locator): Promise<string> {
  return el.evaluate((found) => {
    const node = found as unknown as DomNode;
    const ids = (node.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    return ids.map((id) => node.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
  });
}

/** What holds focus: its data-chip-item, else its data-chip, else its tag. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as { document: DomNode["ownerDocument"] }).document.activeElement;
    if (!el) return "none";
    return el.getAttribute("data-chip-item") ?? (el.getAttribute("data-chip") !== null ? `chip:${el.getAttribute("data-chip")}` : el.tagName.toLowerCase());
  });
}

async function focusIs(page: Page, want: string, what: string): Promise<void> {
  await waitFor(`${what}: focus on ${want}`, async () => ((await focused(page)) === want ? true : null), 5_000).catch(async (err: unknown) => {
    throw new Error(`${what}: focus is on ${await focused(page)}, not ${want} (${String(err)})`);
  });
}

/** The DM's page looks at a scene, by its row in Scenes. */
async function dmViews(sceneId: string): Promise<void> {
  if (dmSocket.you?.sceneId === sceneId) return;
  const name = dmSocket.state?.scenes[sceneId]?.name ?? "";
  assert.ok(name, `no scene ${sceneId} in the DM's copy`);
  await openSideTab(dm, "Scenes");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  await panel.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await waitFor(`the DM on ${name}`, () => dmSocket.you?.sceneId === sceneId || null, 20_000);
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

function toast(page: Page, words: string): Locator {
  return page.locator("[data-toast]").filter({ hasText: words });
}

function handoutDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Show a handout", exact: true });
}

function tile(dialog: Locator, assetId: string): Locator {
  return dialog.locator(`button[aria-label="Use this image"]:has(img[src*="${assetId}"])`);
}

/** Shows a library image from the DM menu's Show a handout…, to everyone or to the members named. */
async function showFromDialog(assetId: string, title: string, to: "all" | string[]): Promise<string> {
  const menu = await openMenu(dm, "dm");
  await item(menu, "showHandout").click();
  const dialog = handoutDialog(dm);
  await dialog.waitFor();
  const change = dialog.getByRole("button", { name: "Change", exact: true });
  if (await change.isVisible()) await change.click();
  await tile(dialog, assetId).click();
  await dialog.getByRole("textbox", { name: "Title" }).fill(title);
  if (to === "all") await dialog.getByRole("radio", { name: "Everyone" }).check();
  else {
    await dialog.getByRole("radio", { name: "Chosen players" }).check();
    const group = dialog.getByRole("group", { name: "Players to show it to" });
    for (const name of to) await group.getByRole("checkbox", { name }).check();
  }
  const before = new Set(Object.keys(dmSocket.state?.handouts ?? {}));
  await dialog.getByRole("button", { name: "Show", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  return waitFor(`${title} showing`, () => Object.values(dmSocket.state?.handouts ?? {}).find((h) => h && !before.has(h.id) && h.title === title)?.id);
}

async function hide(handoutId: string): Promise<void> {
  const menu = await openMenu(dm, "dm");
  await item(menu, `hide:${handoutId}`).click();
  await waitFor("the handout hidden", () => (dmSocket.state?.handouts[handoutId] ? null : true));
}

describe("The top bar's chips and their menus", { concurrency: false }, () => {
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
      for (const c of [dmConsole, coConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("qc-0. a DM's room with a second DM, Pat's Thorn, Ana's Wren, Lee, four scenes, two map phases and three handout pictures", async () => {
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
    run.citadel = dmSocket.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    run.patId = await join(patContext, "Pat", "#30a46c");
    run.anaId = await join(await browser.newContext(), "Ana", "#3e63dd");
    run.leeId = await join(await browser.newContext(), "Lee", "#e54666");
    // Sam, a second DM: the DM link's key, with a name of his own, makes a DM member apart from Dana.
    const claimed = await coContext.request.post(`${server.origin}/api/rooms/${run.roomId}/dm`, { headers: { Origin: server.origin, "content-type": "application/json" }, data: { key: run.dmKey, name: "Sam", color: "#8e4ec6" } });
    assert.ok(claimed.ok(), `Sam's claim answered ${claimed.status()}: ${await claimed.text()}`);
    coOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(coContext) });

    await ops.send({ t: "scene.update", sceneId: run.citadel, patch: { name: "Citadel gate" } });
    await ops.send({ t: "scene.create", scene: { id: run.crypt, name: "Crypt of Belak", bounds: { w: 12, h: 10 }, fogEnabled: true, vision: { on: false, light: "bright" } } });
    await ops.send({ t: "scene.create", scene: { id: run.field, name: "Open field", bounds: { w: 12, h: 10 }, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    await ops.send({ t: "character.create", character: { id: run.wren, name: "Wren", size: "medium", ownerIds: [run.anaId], actor: actor(18) } });

    // Two map phases on the players' scene, for the DM menu's Map phase.
    const day = await upload("map", await picture([150, 140, 120], 500, 400));
    const night = await upload("map", await picture([40, 50, 90], 500, 400));
    await ops.send({ t: "scene.setMap", sceneId: run.citadel, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: 25, originPx: { x: 0, y: 0 } } });
    await ops.send({
      t: "scene.update",
      sceneId: run.citadel,
      patch: {
        phases: [
          { id: run.phases[0], name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
          { id: run.phases[1], name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height },
        ],
      },
    });
    for (const rgb of [[200, 60, 60], [60, 160, 80], [70, 90, 200]] as [number, number, number][]) run.images.push((await upload("handout", await picture(rgb))).id);
    await waitFor("the scenes and phases in the DM's copy", () => (Object.keys(dmSocket.state?.scenes ?? {}).length === 3 && dmSocket.state?.scenes[run.citadel]?.phases?.length === 2 ? true : null));

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("qc-1. the DM menu at rest holds Handouts, Players' screens, Map phase and Preview, opens on its first item by Enter, closes back on the chip, picks a phase, and is the same on Sam's page", async () => {
    const dmChip = chip(dm, "dm");
    await dmChip.waitFor();
    assert.equal(await dmChip.getAttribute("aria-label"), "DM options");
    assert.equal(await dmChip.getAttribute("aria-haspopup"), "menu");
    assert.equal((await dmChip.innerText()).trim(), "DM", "the chip reads DM with its dot and caret");
    // No clock yet, and with one the chip shows at 1440, so the menu holds no Time.
    const want = ["# Handouts", "showHandout", "# Players' screens", "blackout", "follow", "bringEveryone", "# Map phase", "phase:Day", "phase:Night", "# Preview", "viewAs:Ana", "viewAs:Lee", "viewAs:Pat"];
    await dmChip.focus();
    await dm.keyboard.press("Enter");
    const menu = menuOf(dm, "dm");
    await menu.waitFor();
    assert.equal(await menu.getAttribute("aria-label"), "DM");
    assert.deepEqual(await shape(menu), want);
    assert.equal(await dmChip.getAttribute("aria-expanded"), "true");
    // The first item, never the checked phase.
    await focusIs(dm, "showHandout", "Enter on the DM chip");
    assert.equal(await item(menu, "blackout").getAttribute("role"), "menuitemcheckbox");
    assert.equal(await item(menu, "blackout").getAttribute("aria-checked"), "false");
    assert.equal(await item(menu, `phase:${run.phases[0]}`).getAttribute("aria-checked"), "true");
    assert.equal((await item(menu, `viewAs:${run.patId}`).innerText()).trim(), "View as Pat");
    await shots.take(dm, "qc-1-dm-menu");
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "Escape in the DM menu");

    // A phase from the menu sends what the Phase menu sends, and the menu closes.
    const from = wire.out.length;
    await (await openMenu(dm, "dm")).locator(`[data-chip-item="phase:${run.phases[1]}"]`).click();
    await waitFor("Night showing", () => (dmSocket.state?.scenes[run.citadel]?.phaseId === run.phases[1] ? true : null));
    assert.deepEqual(sentOps(from, "scene.setPhase"), [{ t: "scene.setPhase", sceneId: run.citadel, phaseId: run.phases[1] }]);
    await menu.waitFor({ state: "detached" });
    await ops.send({ t: "scene.setPhase", sceneId: run.citadel, phaseId: run.phases[0] });

    // Sam's page draws the same menu from his own copy of the room.
    co = await coContext.newPage();
    coConsole.attach(co);
    await coSocket.attach(coContext, co);
    await co.goto(`${server.origin}/r/${run.roomId}`);
    await co.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Sam's snapshot", () => coSocket.state);
    const coMenu = await openMenu(co, "dm");
    assert.deepEqual(await shape(coMenu), want, "Sam's DM menu");
    await closeMenu(co, coMenu);
    await co.close();
  });

  test("qc-2. Black out players' screens from the menu turns the blackout on, and then End the blackout leads the menu above a line, with no Black out item", async () => {
    const from = wire.out.length;
    await item(await openMenu(dm, "dm"), "blackout").click();
    await playersOn(run.citadel, true);
    assert.deepEqual(sentOps(from, "view.blackout"), [{ t: "view.blackout", blackout: true }]);
    const blackChip = chip(dm, "blackout");
    await blackChip.waitFor();
    assert.equal(await blackChip.getAttribute("aria-label"), "Players see black");
    const menu = await openMenu(dm, "dm");
    assert.deepEqual((await shape(menu)).slice(0, 6), ["endBlackout", "---", "# Handouts", "showHandout", "# Players' screens", "follow"]);
    assert.equal(await describedBy(item(menu, "endBlackout")), "Players see the map again.");
    await shots.take(dm, "qc-2-dm-menu-blackout");
    await closeMenu(dm, menu);
  });

  test("qc-4. Players see black by keys: Enter opens its menu on End the blackout, Enter ends it, and focus goes to the DM chip as the chip leaves", async () => {
    const blackChip = chip(dm, "blackout");
    await blackChip.focus();
    await dm.keyboard.press("Enter");
    const menu = menuOf(dm, "blackout");
    await menu.waitFor();
    assert.equal(await menu.getAttribute("aria-label"), "Blackout");
    // On the players' own scene there is nothing to show them, so End the blackout stands alone.
    assert.deepEqual(await shape(menu), ["endBlackout"]);
    await focusIs(dm, "endBlackout", "Enter on Players see black");
    await dm.keyboard.press("Enter");
    await playersOn(run.citadel, false);
    await blackChip.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "the blackout ended by keys");
  });

  test("qc-6. on another scene, Move players here names it and Follow me says it holds only on the players' scene; past 200 ms the move says Moving players…, a second press sends nothing, and acceptance closes the menu", async () => {
    await dmViews(run.crypt);
    let menu = await openMenu(dm, "dm");
    assert.deepEqual((await shape(menu)).slice(0, 6), ["# Handouts", "showHandout", "# Players' screens", "blackout", "follow", "movePlayers"]);
    const follow = item(menu, "follow");
    assert.equal(await follow.getAttribute("aria-disabled"), null, "Follow me stays enabled elsewhere");
    assert.match(await follow.innerText(), /only on Citadel gate/);
    assert.equal(await describedBy(follow), "Players' maps follow yours only while you look at their scene, Citadel gate.");
    const move = item(menu, "movePlayers");
    assert.match(await move.innerText(), /^Move players here\s*on Crypt of Belak$/);
    // No phases here, so no Map phase.
    assert.equal((await shape(menu)).includes("# Map phase"), false);

    const from = wire.out.length;
    wire.hold = (frame) => frame.includes('"room.setPlayerScene"');
    try {
      await move.click();
      await waitFor("the move busy", async () => ((await move.getAttribute("aria-busy")) === "true" ? true : null), 5_000);
      await move.getByText("Moving players…").waitFor();
      await shots.take(dm, "qc-6-moving-players");
      await move.click();
      await dm.waitForTimeout(200);
      assert.equal(sentOps(from, "room.setPlayerScene").length, 1, "a second press sent nothing");
      assert.equal(await menu.isVisible(), true, "the menu stays open while the move is out");
    } finally {
      release();
    }
    await playersOn(run.crypt, false);
    await menu.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "the move accepted");
    menu = await openMenu(dm, "dm");
    assert.deepEqual((await shape(menu)).slice(0, 6), ["# Handouts", "showHandout", "# Players' screens", "blackout", "follow", "bringEveryone"]);
    assert.doesNotMatch(await item(menu, "follow").innerText(), /only on/);
    await closeMenu(dm, menu);
  });

  test("qc-3b. a move to a scene with fog off asks first: Move players anyway with the warning and Cancel, focus on it, Cancel puts it back, Escape sends nothing, and the second press moves", async () => {
    await setTable(run.citadel, false);
    await dmViews(run.field);
    const warning = "Fog is off here, so players will see the whole scene.";
    const from = wire.out.length;
    let menu = await openMenu(dm, "dm");
    await item(menu, "movePlayers").click();
    const anyway = item(menu, "movePlayers:anyway");
    await anyway.waitFor();
    assert.match(await anyway.innerText(), new RegExp(`^Move players anyway\\s*${warning.replace(/[.]/g, "\\.")}$`));
    assert.equal(await describedBy(anyway), warning);
    await focusIs(dm, "movePlayers:anyway", "a move that asks");
    await item(menu, "movePlayers:cancel").waitFor();
    await shots.take(dm, "qc-3b-move-anyway");
    await item(menu, "movePlayers:cancel").click();
    await item(menu, "movePlayers").waitFor();
    assert.equal(await anyway.count(), 0);
    await focusIs(dm, "movePlayers", "Cancel");
    await item(menu, "movePlayers").click();
    await anyway.waitFor();
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(sentOps(from, "room.setPlayerScene").length, 0, "asking sent nothing");

    // The reveal asks the same, in the Blackout menu.
    await setTable(run.citadel, true);
    menu = await openMenu(dm, "blackout");
    assert.deepEqual(await shape(menu), ["endBlackout", "showPlayers"]);
    await item(menu, "showPlayers").click();
    const show = item(menu, "showPlayers:anyway");
    await show.waitFor();
    assert.match(await show.innerText(), /^Show players anyway/);
    await focusIs(dm, "showPlayers:anyway", "a reveal that asks");
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(sentOps(from, "room.setPlayerScene").length + sentOps(from, "view.blackout").length, 0, "Escape sent nothing");
    assert.equal(dmSocket.state?.meta.view.blackout, true);

    // Three presses: the chip, the item, the anyway item.
    menu = await openMenu(dm, "blackout");
    await item(menu, "showPlayers").click();
    await show.click();
    await playersOn(run.field, false);
    assert.deepEqual(sentOps(from, "view.blackout"), [{ t: "view.blackout", blackout: false, whilePlayersOn: run.field }]);
    await menu.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "the reveal accepted");
  });

  test("qc-3. Show players Crypt of Belak moves the players and ends the blackout in one step: the chip stays while the lift is out, Pat's socket never sees Citadel gate lit, and one Undo takes both back", async () => {
    await setTable(run.citadel, true);
    await dmViews(run.crypt);
    const menu = await openMenu(dm, "blackout");
    assert.deepEqual(await shape(menu), ["endBlackout", "showPlayers"]);
    const show = item(menu, "showPlayers");
    assert.equal((await show.innerText()).trim(), "Show players Crypt of Belak");
    assert.equal(await describedBy(show), "Moves the players here and ends the blackout in one step.");

    const mark = patMark();
    const from = wire.out.length;
    wire.hold = (frame) => frame.includes('"whilePlayersOn"');
    try {
      await show.click();
      // The move lands while the lift waits: the players are on the crypt, still in the dark.
      await playersOn(run.crypt, true);
      await dm.waitForTimeout(300);
      assert.equal(await chip(dm, "blackout").isVisible(), true, "Players see black stays while the lift is out");
      assert.equal(await show.getAttribute("aria-busy"), "true");
      await show.getByText("Moving players…").first().waitFor();
      await shots.take(dm, "qc-3-reveal-waiting");
    } finally {
      release();
    }
    await playersOn(run.crypt, false);
    await chip(dm, "blackout").waitFor({ state: "detached" });
    await menu.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "Players see black gone with the blackout");
    const moves = sentOps(from, "room.setPlayerScene");
    const lifts = sentOps(from, "view.blackout");
    assert.deepEqual([moves, lifts], [[{ t: "room.setPlayerScene", sceneId: run.crypt }], [{ t: "view.blackout", blackout: false, whilePlayersOn: run.crypt }]]);

    await topBar(dm).getByRole("button", { name: "Undo", exact: true }).click();
    await playersOn(run.citadel, true);
    await dm.waitForTimeout(300);
    const saw = patSaw(mark.from, mark.start);
    assert.ok(saw.some((s) => s.scene === run.crypt && !s.blackout), "Pat saw the crypt lit");
    assert.deepEqual(saw.filter((s) => s.scene === run.citadel && !s.blackout), [], "Pat's socket held Citadel gate lit");
    assert.deepEqual(saw.at(-1), { scene: run.citadel, blackout: true }, "one Undo took back the move and the lift");
  });

  test("qc-3c. a refused move leaves the blackout on: its words in the item with focus kept, a quota refusal's own words, a toast after Escape, and a scene Sam deletes meanwhile", async () => {
    await setTable(run.citadel, true);
    await dmViews(run.crypt);
    // A move to a scene that is gone, by the move's scene id spoiled on its way out.
    const spoiled = randomUUID();
    wire.spoil = (frame) => (frame.includes('"room.setPlayerScene"') ? frame.split(run.crypt).join(spoiled) : frame);
    try {
      let menu = await openMenu(dm, "blackout");
      let show = item(menu, "showPlayers");
      await show.click();
      await show.getByText("Players not moved. That scene was deleted.").first().waitFor();
      assert.equal(await describedBy(show), "Players not moved. That scene was deleted.");
      await focusIs(dm, "showPlayers", "a refused reveal");
      assert.equal(dmSocket.state?.meta.view.blackout, true);
      assert.equal(dmSocket.state?.meta.playerSceneId, run.citadel);
      await shots.take(dm, "qc-3c-refused-in-place");
      await closeMenu(dm, menu);

      // The size guard's refusal reads as its own sentence: the server's answer to the spoiled move is reworded as a full room's.
      wire.answer = (frame) => {
        if (!frame.includes('"rejects"')) return frame;
        const msg = JSON.parse(frame) as { rejects?: { code: string; message: string }[] };
        for (const r of msg.rejects ?? []) if (r.code === "gone") Object.assign(r, { code: "quota", message: NO_ROOM_TO_EXPLORE });
        return JSON.stringify(msg);
      };
      menu = await openMenu(dm, "blackout");
      show = item(menu, "showPlayers");
      await show.click();
      await show.getByText(`Players not moved. ${NO_ROOM_TO_EXPLORE}`).first().waitFor();
      assert.equal(dmSocket.state?.meta.view.blackout, true);
      await closeMenu(dm, menu);
      wire.answer = null;

      // Escape before the answer: the words come as a toast. The lift waits with the move, so the server takes them in order.
      wire.hold = (frame) => frame.includes('"room.setPlayerScene"') || frame.includes('"whilePlayersOn"');
      menu = await openMenu(dm, "blackout");
      await item(menu, "showPlayers").click();
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      release();
      await toast(dm, "Players not moved. That scene was deleted.").waitFor();
      assert.equal(dmSocket.state?.meta.view.blackout, true);
    } finally {
      clearWire();
    }

    // Sam deletes the scene the move goes to while it is out: the item has gone with its scene, so the words come as a toast.
    await ops.send({ t: "scene.create", scene: { id: run.chamber, name: "Side chamber", bounds: { w: 8, h: 8 }, fogEnabled: true, vision: { on: false, light: "bright" } } });
    await waitFor("the side chamber", () => dmSocket.state?.scenes[run.chamber]);
    await dmViews(run.chamber);
    wire.hold = (frame) => frame.includes('"room.setPlayerScene"') || frame.includes('"whilePlayersOn"');
    try {
      const menu = await openMenu(dm, "blackout");
      await item(menu, "showPlayers").click();
      await coOps.send({ t: "scene.delete", sceneId: run.chamber });
      await waitFor("the chamber gone", () => (dmSocket.state?.scenes[run.chamber] ? null : true));
    } finally {
      release();
    }
    await toast(dm, "Players not moved. That scene was deleted.").last().waitFor();
    await dm.waitForTimeout(300);
    assert.equal(dmSocket.state?.meta.view.blackout, true, "the blackout stays on");
    assert.equal(dmSocket.state?.meta.playerSceneId, run.citadel);
    await shots.take(dm, "qc-3c-refused-toast");
    await dm.keyboard.press("Escape");
  });

  test("qc-3d. Sam moves the players between the reveal's move and its lift: the lift is refused, the blackout stays on, the item says why, and the DM's Undo is refused as changed since", async () => {
    await setTable(run.citadel, true);
    await dmViews(run.crypt);
    wire.hold = (frame) => frame.includes('"whilePlayersOn"');
    const menu = await openMenu(dm, "blackout");
    const show = item(menu, "showPlayers");
    try {
      await show.click();
      await playersOn(run.crypt, true);
      await coOps.send({ t: "room.setPlayerScene", sceneId: run.field });
      await playersOn(run.field, true);
    } finally {
      release();
    }
    const words = "Not shown: the players are on another scene now. The blackout stays on.";
    await show.getByText(words).first().waitFor();
    assert.equal(await describedBy(show), words);
    await focusIs(dm, "showPlayers", "a refused lift");
    assert.equal(dmSocket.state?.meta.view.blackout, true);
    await shots.take(dm, "qc-3d-lift-refused");
    await closeMenu(dm, menu);

    // Sam changed the players' scene since, so the reveal's step cannot be taken back (Q0's finding).
    await topBar(dm).getByRole("button", { name: "Undo", exact: true }).click();
    await dm.locator("[data-toast]").filter({ hasText: /it was changed since/ }).first().waitFor();
    await dm.waitForTimeout(300);
    assert.equal(dmSocket.state?.meta.playerSceneId, run.field);
    assert.equal(dmSocket.state?.meta.view.blackout, true);
  });

  test("qc-5. at 390 x 844 in a blackout the DM chip is the crossed eye, which opens the DM menu with End the blackout first", async (t) => {
    t.after(async () => {
      await dm.setViewportSize(DESK);
    });
    await setTable(run.citadel, true);
    await dmViews(run.citadel);
    await dm.keyboard.press("Escape");
    await dm.setViewportSize(PHONE);
    const eye = topBar(dm).locator('[data-chip="dm"][data-chip-form="eye"]');
    await eye.waitFor();
    assert.equal(await eye.getAttribute("aria-label"), "DM options. Players see black");
    assert.equal(await chip(dm, "blackout").count(), 0, "Players see black folded into the eye");
    await eye.click();
    const menu = menuOf(dm, "dm");
    await menu.waitFor();
    assert.deepEqual((await shape(menu)).slice(0, 4), ["endBlackout", "---", "# Handouts", "showHandout"]);
    await shots.take(dm, "qc-5-eye-menu-390");
    await item(menu, "endBlackout").click();
    await playersOn(run.citadel, false);
    await topBar(dm).locator('[data-chip="dm"]:not([data-chip-form="eye"])').waitFor();
  });

  test("qc-8. Show a handout… opens the panel's form in a dialog with the library listed, keeps a typed draft past Cancel, shows a picture and hands focus back to the DM chip", async () => {
    await dm.setViewportSize(DESK);
    await dm.keyboard.press("Escape");
    const menu = await openMenu(dm, "dm");
    await item(menu, "showHandout").click();
    const dialog = handoutDialog(dm);
    await dialog.waitFor();
    await waitFor("the library's three pictures", async () => ((await dialog.getByRole("button", { name: "Use this image" }).count()) === 3 ? true : null));
    await dialog.getByRole("textbox", { name: "Title" }).fill("A draft title");
    await shots.take(dm, "qc-8-handout-dialog");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "the dialog's Cancel");
    // The draft is the panel's own, so it is still there.
    await item(await openMenu(dm, "dm"), "showHandout").click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("textbox", { name: "Title" }).inputValue(), "A draft title");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });

    const from = wire.out.length;
    const id = await showFromDialog(run.images[0]!, "Belak's letter", "all");
    assert.equal(sentOps(from, "handout.show").length, 1);
    assert.equal(dmSocket.state?.handouts[id]?.to, "all");
    await focusIs(dm, "chip:dm", "the dialog's Show");
    await waitFor("Pat's copy of the letter", () => patSocket.state?.handouts[id]);
  });

  test("qc-7. the DM menu shows recent handouts again, each to its own audience: to everyone, to Pat alone, and one shown to Lee alone not offered once Lee has left; a picture keeps its title", async () => {
    let menu = await openMenu(dm, "dm");
    const shown = Object.keys(dmSocket.state?.handouts ?? {});
    assert.equal(shown.length, 1);
    const letter = shown[0]!;
    assert.deepEqual((await shape(menu)).slice(0, 3), ["# Handouts", `hide:${letter}`, "showHandout"], "a handout showing is hidden from the menu, not offered again");
    assert.match(await item(menu, `hide:${letter}`).innerText(), /^Hide Belak's letter\s*Showing$/);
    await closeMenu(dm, menu);
    await hide(letter);

    menu = await openMenu(dm, "dm");
    const again = item(menu, `recent:image:${run.images[0]}`);
    assert.match(await again.innerText(), /^Show Belak's letter\s*to everyone$/);
    assert.equal(await describedBy(again), "Shows it to everyone again.");
    let before = new Set(Object.keys(dmSocket.state?.handouts ?? {}));
    await again.click();
    const reshown = await waitFor("the letter again", () => Object.values(dmSocket.state?.handouts ?? {}).find((h) => h && !before.has(h.id))?.id);
    assert.equal(dmSocket.state?.handouts[reshown]?.to, "all");
    assert.equal(dmSocket.state?.handouts[reshown]?.title, "Belak's letter");
    await hide(reshown);

    // To Pat alone, then from the menu: to Pat alone again.
    const map = await showFromDialog(run.images[1]!, "Strange map", ["Pat"]);
    assert.deepEqual(dmSocket.state?.handouts[map]?.to, [run.patId]);
    await hide(map);
    menu = await openMenu(dm, "dm");
    const toPat = item(menu, `recent:image:${run.images[1]}`);
    assert.match(await toPat.innerText(), /^Show Strange map\s*to Pat$/);
    assert.equal(await describedBy(toPat), "Shows it to Pat again.");
    assert.deepEqual((await shape(menu)).slice(0, 4), ["# Handouts", "recent:image:image2", "recent:image:image1", "showHandout"], "newest first");
    await shots.take(dm, "qc-7-recent-handouts");
    before = new Set(Object.keys(dmSocket.state?.handouts ?? {}));
    await toPat.click();
    const toPatAgain = await waitFor("the map again", () => Object.values(dmSocket.state?.handouts ?? {}).find((h) => h && !before.has(h.id))?.id);
    assert.deepEqual(dmSocket.state?.handouts[toPatAgain]?.to, [run.patId], "never widened");
    await waitFor("Pat's copy of the map", () => patSocket.state?.handouts[toPatAgain]);
    await hide(toPatAgain);

    // To Lee alone, then Lee leaves: nobody is left to show it to, so it is not offered.
    const note = await showFromDialog(run.images[2]!, "Lee's note", ["Lee"]);
    await hide(note);
    menu = await openMenu(dm, "dm");
    assert.match(await item(menu, `recent:image:${run.images[2]}`).innerText(), /^Show Lee's note\s*to Lee$/);
    await closeMenu(dm, menu);
    const removed = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}/members/${run.leeId}`, { headers: { Origin: server.origin } });
    assert.equal(removed.status(), 204, `removing Lee answered ${removed.status()}`);
    await waitFor("Lee gone from the DM's copy", () => (dmSocket.state?.members[run.leeId] ? null : true));
    menu = await openMenu(dm, "dm");
    const after = await shape(menu);
    assert.equal(after.includes(`recent:image:image3`), false, "a handout with nobody left is not offered");
    assert.equal(after.includes("viewAs:Lee"), false);
    await closeMenu(dm, menu);

    // A library picture takes the title this device last showed it with.
    await item(await openMenu(dm, "dm"), "showHandout").click();
    const dialog = handoutDialog(dm);
    await dialog.waitFor();
    const change = dialog.getByRole("button", { name: "Change", exact: true });
    if (await change.isVisible()) await change.click();
    await tile(dialog, run.images[0]!).click();
    assert.equal(await dialog.getByRole("textbox", { name: "Title" }).inputValue(), "Belak's letter");
    await dialog.getByText("This device keeps the title for the next time you show this image.").waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  });

  test("qc-9. the DM's clock chip at 1440 opens Time's four steps under it, each step one clock.advance with the popover still open and the side panel's tab kept, and Open Time opens the Time panel", async () => {
    await ops.send({ t: "clock.start", id: randomUUID(), at: 4 * 86_400 + 20 * 3_600, shown: true, calendar: { kind: "days" } });
    const clockChip = chip(dm, "clock");
    await clockChip.waitFor();
    assert.equal(await clockChip.getAttribute("aria-haspopup"), "dialog");
    const tabs = dm.getByRole("tablist", { name: "Panels" });
    const selected = () => tabs.locator('[role="tab"][aria-selected="true"]').getAttribute("data-stop");
    const tab = await selected();
    // The menu holds no Time while its chip is on the bar.
    assert.equal((await shape(await openMenu(dm, "dm"))).includes("# Time"), false);
    await dm.keyboard.press("Escape");

    await clockChip.click();
    const popover = dm.getByRole("dialog", { name: "Time", exact: true });
    await popover.waitFor();
    for (const name of ["Move the clock on 10 minutes", "Move the clock on 1 hour", "Move the clock on 8 hours"]) await popover.getByRole("button", { name }).waitFor();
    await popover.getByRole("button", { name: /^Move the clock on to dawn/ }).waitFor();
    await shots.take(dm, "qc-9-clock-popover");
    const from = wire.out.length;
    const at = dmSocket.state!.clock!;
    await popover.getByRole("button", { name: "Move the clock on 1 hour" }).click();
    await waitFor("the clock on an hour", () => (dmSocket.state?.clock !== at ? true : null));
    assert.equal(await popover.isVisible(), true, "the popover stays open for another step");
    await popover.getByRole("button", { name: "Move the clock on 10 minutes" }).click();
    await waitFor("two steps sent", () => (sentOps(from, "clock.advance").length === 2 ? true : null));
    const steps = sentOps(from, "clock.advance") as { t: string; by: number; claim?: unknown }[];
    // Each step names its own clock line by a fresh claim (calendar C2), so the device knows its lines.
    assert.deepEqual(steps.map(({ claim: _, ...op }) => op), [{ t: "clock.advance", by: 3_600 }, { t: "clock.advance", by: 600 }]);
    assert.ok(steps.every((op) => typeof op.claim === "string") && steps[0]!.claim !== steps[1]!.claim, "each step carries a claim of its own");
    assert.equal(await selected(), tab, "the side panel kept its tab");
    await popover.getByRole("button", { name: "Open Time", exact: true }).click();
    await popover.waitFor({ state: "detached" });
    await dm.getByRole("tabpanel", { name: sideTabName("Time") }).waitFor();
  });

  test("qc-10. at 900 x 900 the clock chip has given way, and the DM menu's Time opens the same steps as a sheet", async (t) => {
    t.after(async () => {
      await dm.setViewportSize(DESK);
    });
    await dm.keyboard.press("Escape");
    await dm.setViewportSize({ width: 900, height: 900 });
    await waitFor("the clock chip gone from the bar", async () => ((await chip(dm, "clock").count()) === 0 ? true : null));
    const menu = await openMenu(dm, "dm");
    const lines = await shape(menu);
    assert.deepEqual(lines.slice(lines.indexOf("# Time")), ["# Time", "time"]);
    assert.match(await item(menu, "time").innerText(), /^Day \d+/);
    await item(menu, "time").click();
    const sheet = dm.getByRole("dialog", { name: "Time", exact: true });
    await sheet.waitFor();
    await shots.take(dm, "qc-10-time-sheet-900");
    const from = wire.out.length;
    await sheet.getByRole("button", { name: "Move the clock on 8 hours" }).click();
    await waitFor("the step sent", () => (sentOps(from, "clock.advance").length === 1 ? true : null));
    assert.equal(await sheet.isVisible(), true, "the sheet stays for another step");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await focusIs(dm, "chip:dm", "the Time sheet closed");
    await dm.setViewportSize(DESK);
    await chip(dm, "clock").waitFor();
    await ops.send({ t: "clock.stop" });
  });

  test("qc-12. Pat's chip opens his You menu: Thorn's sheet and the X-card, never Ana's Wren; the sheet opens his character and the X-card sheet opens on its words", async () => {
    const you = chip(pat, "you");
    await you.waitFor();
    assert.equal(await you.getAttribute("aria-label"), "You are Pat. Your options");
    await you.focus();
    await pat.keyboard.press("Enter");
    const menu = menuOf(pat, "you");
    await menu.waitFor();
    await focusIs(pat, `sheet:${run.thorn}`, "Enter on Pat's chip");
    assert.deepEqual(await shape(menu), ["# Pat", "sheet:Thorn", "xcard"]);
    assert.equal((await item(menu, `sheet:${run.thorn}`).innerText()).trim(), "Thorn's sheet");
    assert.equal(await menu.getByText("Wren", { exact: false }).count(), 0);
    await shots.take(pat, "qc-12-you-menu");
    await item(menu, "xcard").click();
    const card = pat.getByRole("dialog", { name: "X-card", exact: true });
    await card.waitFor();
    await waitFor("focus on the card's words", () => pat.evaluate(() => {
      const el = (globalThis as unknown as { document: DomNode["ownerDocument"] }).document.activeElement;
      return (el?.tagName === "P" && el.closest("dialog") !== null) || null;
    }), 5_000);
    await pat.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });

    await chip(pat, "you").click();
    await menu.waitFor();
    await item(menu, `sheet:${run.thorn}`).click();
    const characters = pat.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
    await characters.waitFor();
    await characters.getByRole("heading", { name: "Thorn" }).first().waitFor();
    await characters.getByRole("button", { name: /^Close / }).first().click();
    await characters.waitFor({ state: "detached" });
  });

  test("qc-13. View as Pat from the DM menu draws Pat's bar, whose You menu lists Thorn's sheet with the X-card off", async () => {
    await dm.keyboard.press("Escape");
    const menu = await openMenu(dm, "dm");
    await item(menu, `viewAs:${run.patId}`).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    const you = preview.locator('[data-chip="you"]');
    await you.waitFor();
    await you.click();
    const youMenu = menuOf(dm, "you");
    await youMenu.waitFor();
    assert.deepEqual(await shape(youMenu), ["# Pat", "sheet:Thorn", "xcard"]);
    const xcard = item(youMenu, "xcard");
    assert.equal(await xcard.getAttribute("aria-disabled"), "true");
    assert.equal(await describedBy(xcard), "Not available while viewing as a player.");
    await shots.take(dm, "qc-13-preview-you-menu");
    await dm.keyboard.press("Escape");
    await youMenu.waitFor({ state: "detached" });
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
  });

  test("qc-14. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(coConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
