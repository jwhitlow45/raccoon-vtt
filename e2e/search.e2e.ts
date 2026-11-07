import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, OpSocket, readCamera, ROOT, Shots, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { addSound } from "./soundRoom.ts";

/**
 * The room search (designs/qol/search.md 5 to 8), on the real server
 * serving the production build with ROOM_SOUND on, in a room of three
 * scenes, two characters, goblins seen and hidden, a hooded figure whose
 * true name is hidden, a DM's journal page, a playlist and handouts:
 * - se-1: the ways in at a desk, Escape, a click outside, Close and Ctrl+K
 *   again, Suggested, the ranked list, the highlight, No match and the count.
 * - se-2: Ctrl+K and Cmd+K in a field on Windows and on a Mac, while a
 *   dialog is open, and in View as a player.
 * - se-3: Ctrl+K while a select box has focus.
 * - se-4 to se-7: the DM menu's items, their twins, a move's warning and
 *   wait, a reveal's refusal in the row and as a toast, and a recent
 *   showing named by its audience.
 * - se-8 to se-14: what a pick does by kind: the party's rest, a setting,
 *   an action that is off, a token off screen, a condition, a key, a dialog
 *   an item opens, and Shift+Enter on each kind.
 * - se-15 and se-16: the landings of Sound, Monsters, handouts, Dice and a
 *   map phase.
 * - se-17 to se-19: a phone's Search, its Panels field and its sheet, a
 *   landing whose panel's code comes late, and the DM's results loading,
 *   failed and tried again.
 * - se-20 to se-22: what a player can and cannot reach, the canaries of
 *   section 8, recent picks per member, and the DM's chunk.
 * - se-23: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-five. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

/**
 * What the run reads of the search's two catalogs (client/features/search/catalog),
 * loaded by a path the typecheck does not follow: the server's typecheck,
 * which these files are part of, has no DOM types for the client code
 * the catalogs import.
 */
type CatalogRoute = { panel: string; anchor?: string };
type CatalogEntry = { id: string; kind: string; title: string; names?: readonly string[]; bets?: readonly string[]; act: { t: string; route?: CatalogRoute } };
type Catalog = { entries: readonly CatalogEntry[]; fields: readonly { names?: readonly string[]; bets?: readonly string[] }[] };
const CATALOG_DIR = "../client/features/search/catalog";
const { DM_CATALOG } = (await import(`${CATALOG_DIR}/dm.ts`)) as { DM_CATALOG: Catalog };
const { EVERYONE } = (await import(`${CATALOG_DIR}/everyone.ts`)) as { EVERYONE: Catalog };

const PORT = Number(process.env.E2E_PORT ?? 3100) + 55;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-search-"));
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/**
 * Which keys a device takes as Ctrl is read from its platform (lib/device.ts
 * isAppleDevice), so each page here names its own, and the run means the
 * same on a Mac and on a Linux runner.
 */
const WINDOWS = "Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' });";
const MAC = "Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });";

let server: Server;
let browser: Browser;
let desk: BrowserContext;
let dm: Page;
let ops: OpSocket;
/** Pat's phone, where Pat joined. */
let patPhone: BrowserContext;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
/** What Pat's page asked the server for, and the body of each of the build's scripts it was sent (se-20, se-22). */
const patLoads = { urls: [] as string[], scripts: new Map<string, Promise<string>>() };
const watches: ConsoleWatch[] = [];

const run = {
  roomId: "",
  roomName: `E2E search ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  dmKey: "",
  mat: "",
  cave: randomUUID(),
  crypt: randomUUID(),
  day: randomUUID(),
  night: randomUUID(),
  bree: randomUUID(),
  thorn: randomUUID(),
  tBree: randomUUID(),
  g1: randomUUID(),
  g2: randomUUID(),
  g3: randomUUID(),
  boss: randomUUID(),
  varo: randomUUID(),
  villain: randomUUID(),
  lore: randomUUID(),
  drums: randomUUID(),
  song: randomUUID(),
  letter: "",
  cryptMap: "",
  townMap: "",
  townShown: randomUUID(),
  patId: "",
  leeId: "",
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

async function upload(kind: "handout" | "map", color: { r: number; g: number; b: number }, size = { w: 60, h: 80 }): Promise<string> {
  const data = await sharp({ create: { width: size.w, height: size.h, channels: 3, background: color } }).png().toBuffer();
  const res = await desk.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the ${kind} upload answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
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

/** The room of the cases: what each case's canary or landing needs. */
async function createRoom(): Promise<void> {
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
  run.dmKey = link.split("#dm=")[1] ?? "";
  sessions.set(desk, "desk");
  await spend(desk);
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();
  await waitFor("the DM's snapshot", () => dmSocket.state);
  const cookie = (await desk.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  await spend(desk);
  ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

  run.mat = dmSocket.state!.meta.playerSceneId!;
  await ops.send({ t: "scene.update", sceneId: run.mat, patch: { name: "Battle mat", bounds: { w: 60, h: 40 }, fogEnabled: false } });
  await ops.send({ t: "scene.create", scene: { id: run.cave, name: "Goblin cave", bounds: { w: 20, h: 14 }, fogEnabled: false } });
  await ops.send({ t: "scene.create", scene: { id: run.crypt, name: "Crypt of bones", bounds: { w: 20, h: 14 }, fogEnabled: true } });
  patPhone = await browser.newContext(PHONE);
  sessions.set(patPhone, "pat");
  await patPhone.addInitScript(WINDOWS);
  run.patId = await join(patPhone, "Pat", "#3e63dd");
  run.leeId = await join(await browser.newContext(), "Lee", "#30a46c");
  await ops.send({ t: "character.create", character: { id: run.bree, name: "Bree", size: "medium", ownerIds: [run.patId], actor: actor({ senses: "Darkvision 60 ft.", hp: { cur: 24, max: 24, temp: 0 }, ac: 15 }) } });
  await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [], actor: actor() } });
  const token = (id: string, name: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    ops.send({ t: "token.create", token: { id, sceneId: run.mat, name, kind: "monster", x, y, size: "medium", visibility: "all", ownerIds: [], actor: { inline: actor() }, ...extra } });
  await token(run.g1, "Goblin", 6, 6, { number: 1 });
  await token(run.g2, "Goblin", 8, 6, { number: 2 });
  await token(run.g3, "Goblin", 56, 36, { number: 3 });
  await token(run.boss, "Goblin Boss", 10, 8, { visibility: "dm" });
  await token(run.varo, "Count Varo", 12, 8, { kind: "npc", nameHidden: true, publicName: "Hooded figure" });
  await token(run.tBree, "Bree", 4, 4, { kind: "pc", ownerIds: [run.patId], actor: { ref: run.bree } });
  await ops.send({ t: "journal.create", page: { id: run.villain, title: "Villain's plans", access: "dm", blocks: [{ id: "villain00001", text: "The count waits below." }] } });
  await ops.send({ t: "journal.create", page: { id: run.lore, title: "Town lore", access: "all", blocks: [{ id: "lore00000001", text: "The town sleeps." }] } });
  await addSound({ context: desk, origin: server.origin, roomId: run.roomId, ops, id: run.song, name: "Tavern song", use: "music", ms: 31_000 });
  await ops.send({ t: "playlist.create", id: run.drums, name: "Goblin war drums", sounds: [run.song], repeat: "all", fade: 0 });
  await ops.send({ t: "scene.update", sceneId: run.cave, patch: { sound: { music: { playlistId: run.drums, repeat: "all", fade: 0 }, loops: [] } } });
  run.letter = await upload("handout", { r: 120, g: 80, b: 40 });
  run.cryptMap = await upload("handout", { r: 40, g: 80, b: 120 });
  run.townMap = await upload("handout", { r: 80, g: 120, b: 40 });
  // The crypt's two phases, whose DM menu items have Show a phase as their twin.
  const day = await upload("map", { r: 200, g: 190, b: 160 }, { w: 200, h: 140 });
  const night = await upload("map", { r: 30, g: 30, b: 60 }, { w: 200, h: 140 });
  await ops.send({ t: "scene.setMap", sceneId: run.crypt, map: { assetId: day, widthPx: 200, heightPx: 140, cellPx: 10, originPx: { x: 0, y: 0 } } });
  await ops.send({
    t: "scene.update",
    sceneId: run.crypt,
    patch: {
      phases: [
        { id: run.day, name: "Daylight", assetId: day, widthPx: 200, heightPx: 140 },
        { id: run.night, name: "Moonlit", assetId: night, widthPx: 200, heightPx: 140 },
      ],
    },
  });
  await ops.send({ t: "scene.setPhase", sceneId: run.crypt, phaseId: run.day });
  await waitFor("the room in the DM's copy", () => (Object.keys(dmSocket.state?.scenes ?? {}).length === 3 && dmSocket.state?.playlists?.[run.drums] ? true : null));
}

// ---------------------------------------------------------------- pages

/**
 * The server counts each snapshot it builds, a page's load and a DM's look
 * at another scene alike, against its session and its IP: 20 a minute a
 * session and 40 an IP, every page here sharing one (server/rooms/budgets.ts).
 * One over is delayed, and a session over for 30 s has its sockets closed
 * as abuse. So each is noted as it is asked for, and a step waits out the
 * window rather than run over, and the DM's other pages sign in on sessions
 * of their own (dmContext).
 */
const sessions = new WeakMap<BrowserContext, string>();
const spent: { at: number; session: string }[] = [];
const WINDOW_MS = 61_000;

async function spend(context: BrowserContext): Promise<void> {
  const session = sessions.get(context) ?? "other";
  for (;;) {
    const now = Date.now();
    const live = spent.filter((s) => now - s.at < WINDOW_MS);
    const mine = live.filter((s) => s.session === session);
    if (live.length < 36 && mine.length < 18) break;
    const oldest = (mine.length >= 18 ? mine : live)[0]!.at;
    await sleep(oldest + WINDOW_MS - now);
  }
  spent.push({ at: Date.now(), session });
}

/** A browser context signed in as the DM by the DM link, on a session of its own, with this platform's keys. */
async function dmContext(options: Parameters<Browser["newContext"]>[0], platform = WINDOWS, label = "dm"): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.addInitScript(platform);
  const res = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/dm`, { headers: { Origin: server.origin }, data: { key: run.dmKey, memberId: dmSocket.you?.memberId } });
  assert.ok(res.ok(), `the DM link answered ${res.status()}`);
  sessions.set(context, `${label}-${randomUUID()}`);
  return context;
}

/** A page of the room as `context` holds it, reloaded until it shows the room. */
async function openRoom(page: Page): Promise<void> {
  await spend(page.context());
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator('[data-search-open], [data-rvtt-topbar]').first().waitFor();
}

/** The DM's desk page afresh, so a step that failed leaves nothing open for the next. */
async function fresh(page: Page = dm): Promise<void> {
  if (page === dm) await dm.setViewportSize(DESK);
  await openRoom(page);
  await settle(page);
}

function watchConsole(page: Page, label: string): ConsoleWatch {
  const watch = new ConsoleWatch(label);
  watch.attach(page);
  watches.push(watch);
  return watch;
}

/**
 * The few shapes of the DOM the code run in a page reads, since the e2e
 * files compile without the DOM's types.
 */
type Box = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number };
type DomEl = {
  tagName: string;
  textContent: string | null;
  checked?: boolean;
  value?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): DomEl | null;
  matches(selector: string): boolean;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): Iterable<DomEl>;
  getAnimations(): unknown[];
  getBoundingClientRect(): Box;
  contains(other: DomEl | null): boolean;
  ownerDocument: { activeElement: DomEl | null; body: DomEl; querySelectorAll(selector: string): Iterable<DomEl> };
};
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raf = (globalThis as unknown as { requestAnimationFrame(cb: () => void): void }).requestAnimationFrame;
    return new Promise((resolve) => raf(() => raf(() => resolve(null))));
  });
}

const sheet = (page: Page) => page.locator("dialog[data-search-sheet]");
const field = (page: Page) => page.locator("[data-search-field]");
const rows = (page: Page) => page.locator("[data-search-row]");
const row = (page: Page, id: string) => page.locator(`[data-search-row="${id}"]`);
const barSearch = (page: Page) => page.locator('[data-search-open="bar"]');

async function rowIds(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((els) => els.map((e) => (e as unknown as DomEl).getAttribute("data-search-row") ?? ""));
}

/** What has focus: its tag, its name, the anchor it is or sits in, the panel it sits in, and whether it is the search's field. */
type Focus = { tag: string; role: string | null; name: string; anchor: string | null; record: string | null; pane: string | null; sheet: boolean; field: boolean; open: string | null; checked: boolean | null; disabled: boolean };

function focused(page: Page): Promise<Focus | null> {
  return page.locator(":root").evaluate((node) => {
    const root = node as unknown as DomEl;
    const el = root.ownerDocument.activeElement;
    if (!el || el === root.ownerDocument.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80),
      anchor: el.closest("[data-search]")?.getAttribute("data-search") ?? null,
      record: el.closest("[data-search-page]")?.getAttribute("data-search-page") ?? null,
      pane: el.closest("[data-pane-panel]")?.getAttribute("data-pane-panel") ?? null,
      sheet: el.closest("dialog[data-rvtt-sheet]") !== null,
      field: el.hasAttribute("data-search-field"),
      open: el.getAttribute("data-search-open"),
      checked: "checked" in el ? Boolean(el.checked) : null,
      disabled: el.matches(":disabled") || el.getAttribute("aria-disabled") === "true",
    };
  });
}

/** Opens the search by Ctrl+K, a Windows page's key here, from wherever focus is. */
async function openSearch(page: Page, key = "Control+k"): Promise<void> {
  if ((await sheet(page).count()) === 0) await page.keyboard.press(key);
  await sheet(page).waitFor();
}

/** Types `text` and waits until `id` is listed. Returns its place in the list. */
async function typeFor(page: Page, text: string, id: string): Promise<number> {
  await field(page).fill(text);
  return waitFor(`"${text}" lists ${id}`, async () => {
    const ids = await rowIds(page);
    const at = ids.indexOf(id);
    return at >= 0 ? at + 1 : null;
  }, 8_000).then((n) => n - 1);
}

/** Types `text` in the open search, moves the highlight to `id` and picks it with Enter, or Shift+Enter when `only`. */
async function pick(page: Page, text: string, id: string, only = false): Promise<void> {
  await openSearch(page);
  const at = await typeFor(page, text, id);
  for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
  assert.equal(await row(page, id).getAttribute("aria-selected"), "true", `${id} is highlighted`);
  await page.keyboard.press(only ? "Shift+Enter" : "Enter");
}

/** Waits until focus sits on, or in, the control with this `data-search` id, and returns it. */
async function landedOn(page: Page, anchor: string): Promise<Focus> {
  return waitFor(`focus on ${anchor}`, async () => {
    const f = await focused(page);
    return f?.anchor === anchor ? f : null;
  }, 8_000).catch(async (err: unknown) => {
    throw new Error(`${String(err)}: focus is on ${JSON.stringify(await focused(page))}`);
  });
}

/** Whether the anchor wears the landing's ring now (route.ts ring, a WAAPI outline). */
function ringed(page: Page, anchor: string): Promise<boolean> {
  return page.locator(`[data-search="${anchor}"]`).first().evaluate((el) => (el as unknown as DomEl).getAnimations().length > 0);
}

/** The ops this page sent since `from`, by type. */
function sentOps(watch: SocketWatch, from: number, type?: string): Record<string, unknown>[] {
  return watch.sent.slice(from).flatMap((f) => {
    try {
      const m = JSON.parse(f) as { t: string; op?: Record<string, unknown> };
      return m.t === "op" && m.op && (type === undefined || m.op.t === type) ? [m.op] : [];
    } catch {
      return [];
    }
  });
}

/** The side panel's chosen tab, by its name. */
function chosenTab(page: Page): Promise<string | null> {
  return page.getByRole("tablist", { name: "Panels" }).getByRole("tab", { selected: true }).first().getAttribute("aria-label").then(
    async (label) => label ?? (await page.getByRole("tablist", { name: "Panels" }).getByRole("tab", { selected: true }).first().textContent()),
    () => null,
  );
}

/** Puts the DM's camera on a scene by its row in Scenes, as a tap there does. */
async function viewScene(page: Page, sceneId: string): Promise<void> {
  const name = await waitFor(`scene ${sceneId} in the DM's copy`, () => dmSocket.state?.scenes[sceneId]?.name);
  await pick(page, name.toLowerCase(), `scene:${sceneId}`);
  const rowButton = page.locator(`[data-search-page="scene:${sceneId}"] button`).first();
  await rowButton.waitFor();
  await spend(page.context());
  await rowButton.click();
  await waitFor(`the DM's camera on ${sceneId}`, async () => ((await viewing(page)) === sceneId ? true : null));
}

/** The scene this page's DM looks at, from the Scenes row it marks. */
function viewing(page: Page): Promise<string | null> {
  return page.locator(":root").evaluate((node) => {
    const rows = [...(node as unknown as DomEl).ownerDocument.querySelectorAll("[data-search-page^='scene:']")];
    const on = rows.find((r) => r.querySelector('[aria-current="true"], [aria-current="page"]'));
    return on ? (on.getAttribute("data-search-page") ?? "").slice("scene:".length) : null;
  });
}


/** A second desk page of the DM's whose room socket goes through a route, so the server's frames can wait and a move's scene can be spoiled on its way out. */
type Routed = { page: Page; context: BrowserContext; holding: boolean; spoil: boolean; held: (string | Buffer)[]; sent: string[]; release(): void };

async function routedDm(): Promise<Routed> {
  const context = await dmContext({ viewport: DESK }, WINDOWS, "routed");
  const page = await context.newPage();
  watchConsole(page, "dm-routed");
  let toPage: ((m: string | Buffer) => void) | null = null;
  const routed: Routed = {
    page,
    context,
    holding: false,
    spoil: false,
    held: [],
    sent: [],
    release() {
      routed.holding = false;
      for (const m of routed.held.splice(0)) toPage?.(m);
    },
  };
  await page.routeWebSocket(/\/ws\?room=/, (ws) => {
    const upstream = ws.connectToServer();
    upstream.onMessage((m) => (routed.holding ? routed.held.push(m) : ws.send(m)));
    ws.onMessage((m) => {
      if (typeof m === "string") routed.sent.push(m);
      if (routed.spoil && typeof m === "string") {
        const msg = JSON.parse(m) as { t?: string; op?: { t?: string; sceneId?: string } };
        // A scene the server has never had, as one a co-DM deleted is to it: the move is refused `gone`.
        if (msg.t === "op" && msg.op?.t === "room.setPlayerScene") {
          msg.op.sceneId = randomUUID();
          upstream.send(JSON.stringify(msg));
          return;
        }
      }
      upstream.send(m);
    });
    toPage = (m) => ws.send(m);
  });
  await openRoom(page);
  await settle(page);
  return routed;
}

/** The ops a routed page sent, of one type. */
function sentOpsOf(routed: Routed, type: string): Record<string, unknown>[] {
  return routed.sent.flatMap((f) => {
    const m = JSON.parse(f) as { t: string; op?: Record<string, unknown> };
    return m.t === "op" && m.op?.t === type ? [m.op] : [];
  });
}

/** A catalog entry's id by its title, so a case names the setting as the DM sees it. */
function entryId(title: string, kind: string): string {
  const found = [...DM_CATALOG.entries, ...EVERYONE.entries].find((e) => e.title === title && e.kind === kind);
  assert.ok(found, `no ${kind} titled ${title}`);
  return found.id;
}

/** A page of the DM's on a phone, sharing the desk's sign-in. `scale` is the interface size. */
async function dmPhone(size = PHONE.viewport, scale = 1): Promise<{ context: BrowserContext; page: Page }> {
  const context = await dmContext({ ...PHONE, viewport: size }, WINDOWS, "phone");
  await context.addInitScript((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", s), String(scale));
  const page = await context.newPage();
  watchConsole(page, `dm-phone-${size.width}`);
  await openRoom(page);
  await settle(page);
  return { context, page };
}

/** Opens the search from a phone's top bar, or its Panels list where the bar has folded it there. */
async function tapSearch(page: Page): Promise<void> {
  if ((await sheet(page).count()) > 0) return;
  if (await barSearch(page).isVisible().catch(() => false)) await barSearch(page).tap();
  else {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
    await page.locator('[data-search-open="panels"]').tap();
  }
  await sheet(page).waitFor();
}

/** On a phone: types `text`, and taps the row `id`, or presses Shift+Enter on it for `only`. */
async function tapPick(page: Page, text: string, id: string, only = false): Promise<void> {
  await tapSearch(page);
  const at = await typeFor(page, text, id);
  if (only) {
    for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+Enter");
  } else await row(page, id).tap();
}

/** The DM's blackout as the server has it now. */
const blackout = () => dmSocket.state?.meta.view.blackout === true;

async function setBlackout(on: boolean): Promise<void> {
  if (blackout() !== on) await ops.send({ t: "view.blackout", blackout: on });
  await waitFor(`the blackout ${on ? "on" : "off"}`, () => (blackout() === on ? true : null));
}

async function movePlayersTo(sceneId: string): Promise<void> {
  if (dmSocket.state?.meta.playerSceneId !== sceneId) await ops.send({ t: "room.setPlayerScene", sceneId });
  await waitFor("the players' scene", () => (dmSocket.state?.meta.playerSceneId === sceneId ? true : null));
}

describe("the room search", { concurrency: false }, () => {
  before(async () => {
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    desk = await browser.newContext({ viewport: DESK });
    await desk.addInitScript(WINDOWS);
    dm = await desk.newPage();
    watchConsole(dm, "dm");
    await dmSocket.attach(desk, dm);
    await createRoom();
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") for (const w of watches) console.error(`[${w.label}] errors`, w.errors);
    ops?.close();
    if (run.roomId && desk) await desk.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } }).catch(() => {});
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("se-1. at a desk: the top bar's Search after the chips, Ctrl+K from the map, Suggested, a ranked list with the hidden boss marked, the highlight, the count, No match, and Escape, a click outside, Close and Ctrl+K again each closing with focus back", async () => {
    await fresh();
    const bar = barSearch(dm);
    assert.equal(await bar.getAttribute("data-search-form"), "field", "the field form at 1440");
    assert.equal(await bar.getAttribute("aria-keyshortcuts"), "Control+K Meta+K");
    assert.match((await bar.textContent()) ?? "", /Search\s*Ctrl K/, "its words and its key");
    const barBox = (await bar.boundingBox())!;
    const chip = (await dm.locator('[data-chip="dm"]').boundingBox())!;
    assert.ok(barBox.x > chip.x + chip.width - 1, "after the DM chip");
    await shots.take(dm, "se-1-topbar");

    // From the map: focus there, then the key.
    await dm.mouse.click(700, 500);
    const opener = await focused(dm);
    await openSearch(dm);
    let f = await focused(dm);
    assert.ok(f?.field, "the field takes focus");
    assert.equal(await sheet(dm).getAttribute("data-search-sheet"), "dialog", "a dialog at a desk");
    assert.equal(await field(dm).getAttribute("placeholder"), "Search panels, settings, actions, tokens…");
    const card = (await sheet(dm).locator("section").boundingBox())!;
    assert.ok(Math.abs(card.width - 640) < 1, `640 px wide, is ${card.width}`);
    // Suggested, outside a fight: Start a fight first.
    await waitFor("Suggested", async () => ((await rowIds(dm)).includes("action:tracker.new-fight") ? true : null));
    assert.equal((await rowIds(dm))[0], "action:tracker.new-fight", "Start a fight leads Suggested outside a fight");
    await dm.getByText("Suggested", { exact: true }).waitFor();
    await shots.take(dm, "se-1-suggested");

    // Typed: the goblins on the scene in view, the hidden one marked, then the SRD's once their chunk is in.
    await field(dm).fill("goblin");
    await waitFor("the SRD goblins", async () => ((await rowIds(dm)).some((id) => id.startsWith("monster:srd:")) ? true : null));
    const goblins = await rowIds(dm);
    assert.deepEqual(goblins.slice(0, 4), [`token:${run.g1}`, `token:${run.g2}`, `token:${run.g3}`, `token:${run.boss}`], "Goblin 1, 2 and 3, then Goblin Boss");
    assert.equal(await row(dm, `token:${run.boss}`).getByText("Hidden", { exact: true }).count(), 1, "the boss says Hidden");
    assert.match((await row(dm, `token:${run.g1}`).textContent()) ?? "", /Token · Monster on Battle mat/, "the row says its kind and where it is");
    assert.equal(await row(dm, `token:${run.g1}`).locator("b, strong").first().textContent(), "Goblin", "the typed word's start in bold");
    assert.equal(await rows(dm).first().getAttribute("aria-selected"), "true", "the first row highlighted");
    await dm.keyboard.press("ArrowDown");
    assert.equal(await rows(dm).nth(1).getAttribute("aria-selected"), "true", "Down moves the highlight");
    assert.equal(await field(dm).getAttribute("aria-activedescendant"), await rows(dm).nth(1).getAttribute("id"), "the field names the highlighted row");
    assert.ok((await focused(dm))?.field, "the field keeps focus");
    const status = sheet(dm).locator('[role="status"]');
    await waitFor("the count", async () => (/^\d+ results$/.test(((await status.textContent()) ?? "").trim()) ? true : null));
    await shots.take(dm, "se-1-goblin");
    await field(dm).fill("xyzzy");
    await dm.locator("[data-search-none]").waitFor();
    assert.equal((await dm.locator("[data-search-none]").textContent())?.trim(), "No match for “xyzzy”.");
    await waitFor("No match said", async () => (((await status.textContent()) ?? "").trim() === "No match" ? true : null));

    // Escape: closed, focus back where it was.
    await dm.keyboard.press("Escape");
    await sheet(dm).waitFor({ state: "detached" });
    f = await focused(dm);
    // A tap on the map leaves focus on the page itself, so it goes to the map's focus target (search.md 6).
    assert.equal(opener, null, "the tap on the map put focus nowhere");
    assert.deepEqual([f?.role, f?.name], ["img", "Map"], "focus on the map's focus target");
    // A click outside, from the top bar's Search.
    await bar.click();
    await sheet(dm).waitFor();
    assert.ok((await focused(dm))?.field);
    await dm.mouse.click(20, 880);
    await sheet(dm).waitFor({ state: "detached" });
    assert.equal((await focused(dm))?.open, "bar", "a click outside: focus back on Search");
    // Close.
    await bar.click();
    await sheet(dm).waitFor();
    await sheet(dm).getByRole("button", { name: "Close search" }).click();
    await sheet(dm).waitFor({ state: "detached" });
    assert.equal((await focused(dm))?.open, "bar", "Close: focus back on Search");
    // Ctrl+K again.
    await dm.keyboard.press("Control+k");
    await sheet(dm).waitFor();
    await dm.keyboard.press("Control+k");
    await sheet(dm).waitFor({ state: "detached" });
    assert.equal((await focused(dm))?.open, "bar", "Ctrl+K again: focus back on Search");
  });

  test("se-2. Ctrl+K in the Dice formula field opens the search on Windows, a Mac's Ctrl+K stays the field's and its Cmd+K opens it, and nothing opens while a dialog is open or in View as a player", async () => {
    await fresh();
    await pick(dm, "roll dice", "action:dice.formula");
    await sheet(dm).waitFor({ state: "detached" });
    const formula = dm.locator('[data-search="dice.formula"]');
    await landedOn(dm, "dice.formula");
    await formula.fill("2d6");
    await dm.keyboard.press("Control+k");
    await sheet(dm).waitFor();
    assert.ok((await focused(dm))?.field, "Ctrl+K in the field opens the search");
    await dm.keyboard.press("Escape");
    await sheet(dm).waitFor({ state: "detached" });
    assert.equal((await focused(dm))?.anchor, "dice.formula", "Escape: focus back in the formula field");
    assert.equal(await formula.inputValue(), "2d6", "the field keeps what was typed");

    // A Mac: Ctrl+K stays the field's, so the key goes on to the field, and Cmd+K opens the search.
    const mac = await dmContext({ viewport: DESK }, MAC, "mac");
    try {
      const page = await mac.newPage();
      watchConsole(page, "dm-mac");
      await openRoom(page);
      assert.match((await barSearch(page).textContent()) ?? "", /⌘K/, "a Mac's keycap");
      await pick(page, "roll dice", "action:dice.formula");
      await landedOn(page, "dice.formula");
      await page.locator('[data-search="dice.formula"]').fill("2d6");
      // After the room's own listener, which the page added first, whether the key was taken from the field.
      await page.locator(":root").evaluate((node) => {
        const win = (node as unknown as DomEl & { ownerDocument: { defaultView: { addEventListener(t: string, f: (e: { key: string; defaultPrevented: boolean }) => void): void } } }).ownerDocument.defaultView;
        (globalThis as unknown as { keptK: boolean[] }).keptK = [];
        win.addEventListener("keydown", (e) => {
          if (e.key === "k") (globalThis as unknown as { keptK: boolean[] }).keptK.push(!e.defaultPrevented);
        });
      });
      await page.keyboard.press("Control+k");
      await settle(page);
      assert.equal(await sheet(page).count(), 0, "a Mac's Ctrl+K in a field opens nothing");
      assert.deepEqual(await page.evaluate(() => (globalThis as unknown as { keptK: boolean[] }).keptK), [true], "and the key goes on to the field");
      await page.keyboard.press("Meta+k");
      await sheet(page).waitFor();
      assert.ok((await focused(page))?.field, "Cmd+K opens it");
      await page.keyboard.press("Meta+k");
      await sheet(page).waitFor({ state: "detached" });
      assert.equal((await focused(page))?.anchor, "dice.formula", "Cmd+K again closes it, focus back in the field");
    } finally {
      await mac.close();
    }

    // A dialog open: the DM menu's Show a handout…
    await dm.locator('[data-chip="dm"]').click();
    await dm.locator('[data-chip-item="showHandout"]').click();
    const dialog = dm.getByRole("dialog", { name: "Show a handout" });
    await dialog.waitFor();
    await dm.keyboard.press("Control+k");
    await settle(dm);
    assert.equal(await sheet(dm).count(), 0, "Ctrl+K opens nothing over a dialog");
    await dm.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // View as Pat: no Search, and neither key opens one.
    await dm.locator('[data-chip="dm"]').click();
    await spend(desk);
    await dm.locator(`[data-chip-item="viewAs:${run.patId}"]`).click();
    const preview = dm.locator("dialog[open]").filter({ has: dm.locator("header[data-rvtt-topbar]") });
    await preview.locator("header[data-rvtt-topbar]").waitFor();
    await settle(dm);
    assert.equal(await preview.locator("[data-search-open]").count(), 0, "View as a player has no Search");
    await dm.keyboard.press("Control+k");
    await dm.keyboard.press("Meta+k");
    await settle(dm);
    assert.equal(await sheet(dm).count(), 0, "in View as a player Ctrl+K and Cmd+K open nothing");
    await dm.keyboard.press("Escape");
  });

  test("se-3. Ctrl+K while a select box has focus opens the search, as anywhere outside a dialog (search.md 5.1)", async () => {
    await fresh();
    await pick(dm, "automatic walls", "setting:scenes.walls.auto");
    const f = await landedOn(dm, "scenes.walls.auto");
    assert.equal(f.tag, "select", "the landing focuses the Automatic walls list");
    await dm.keyboard.press("Control+k");
    await settle(dm);
    assert.equal(await sheet(dm).count(), 1, "Ctrl+K with the list focused opens the search");
  });

  test("se-4. Black out players' screens: Enter in the search and the DM menu's item send the same one op, the side panel keeps its tab, one Undo takes it back, and Shift+Enter goes to the DM panel's switch without pressing it", async () => {
    await fresh();
    await setBlackout(false);
    const tab = await chosenTab(dm);
    await openSearch(dm);
    await field(dm).fill("pause");
    await waitFor("pause's best bet", async () => ((await rowIds(dm))[0] === "item:blackout" ? true : null));
    assert.match((await row(dm, "item:blackout").textContent()) ?? "", /Action · DM menu · Players' screens/);
    await dm.keyboard.press("Escape");
    let from = dmSocket.sent.length;
    await pick(dm, "black out", "item:blackout");
    await sheet(dm).waitFor({ state: "detached" });
    await waitFor("the blackout", () => (blackout() ? true : null));
    const bySearch = sentOps(dmSocket, from);
    assert.deepEqual(bySearch, [{ t: "view.blackout", blackout: true }], "one op");
    assert.equal(await chosenTab(dm), tab, "the side panel keeps its tab");
    await dm.keyboard.press("Control+z");
    await waitFor("one Undo ends it", () => (blackout() ? null : true));

    from = dmSocket.sent.length;
    await dm.locator('[data-chip="dm"]').click();
    await dm.locator('[data-chip-item="blackout"]').click();
    await waitFor("the blackout from the menu", () => (blackout() ? true : null));
    assert.deepEqual(sentOps(dmSocket, from), bySearch, "the DM menu's item sends the same op");
    // In a blackout the search finds its end.
    await openSearch(dm);
    await typeFor(dm, "blackout", "item:endBlackout");
    assert.equal(await row(dm, "item:blackout").count(), 0, "Black out is not offered during one");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Control+z");
    await waitFor("Undo ends it", () => (blackout() ? null : true));

    await pick(dm, "black out", "item:blackout", true);
    const f = await landedOn(dm, "dm.screens.blackout");
    assert.equal(f.pane, "dm", "the DM panel's switch");
    await settle(dm);
    assert.equal(blackout(), false, "Shift+Enter presses nothing");
    await shots.take(dm, "se-4-blackout-twin");
  });

  test("se-5. Move players here onto a scene with fog off: the row turns into the warning and Move players anyway, a second Enter moves them with the scene's sound and says Moving players… until the answer, and Shift+Enter goes to the scene's row in Scenes, moving nobody", async () => {
    await movePlayersTo(run.mat);
    await ops.send({ t: "music.stop" }).catch(() => {});
    const routed = await routedDm();
    const page = routed.page;
    try {
      await viewScene(page, run.cave);
      await pick(page, "move players", "item:movePlayers");
      const r = row(page, "item:movePlayers");
      await r.getByText("Move players anyway").waitFor();
      await r.getByText("Fog is off here, so players will see the whole scene.").waitFor();
      assert.equal(await sheet(page).count(), 1, "the search stays open with the warning");
      assert.equal(await r.getAttribute("aria-selected"), "true");
      await waitFor("the warning said", async () => ((await sheet(page).locator('[role="status"]').textContent())?.includes("Fog is off here") ? true : null));
      await shots.take(page, "se-5-move-warning");
      routed.holding = true;
      await page.keyboard.press("Enter");
      await r.getByText("Moving players…").waitFor();
      await waitFor("the players on the cave", () => (dmSocket.state?.meta.playerSceneId === run.cave ? true : null));
      await waitFor("the cave's music", () => (dmSocket.state?.playing?.music?.playlistId === run.drums ? true : null));
      assert.equal(await sheet(page).count(), 1, "open while the answer waits");
      await page.keyboard.press("Enter");
      await settle(page);
      assert.equal(sentOpsOf(routed, "room.setPlayerScene").length, 1, "a second Enter while it waits sends nothing more");
      routed.release();
      await sheet(page).waitFor({ state: "detached" });

      await movePlayersTo(run.mat);
      await pick(page, "move players", "item:movePlayers", true);
      await sheet(page).waitFor({ state: "detached" });
      const f = await waitFor("focus on the cave's row", async () => {
        const now = await focused(page);
        return now?.record === `scene:${run.cave}` ? now : null;
      });
      assert.equal(f.pane, "scenes");
      await settle(page);
      assert.equal(dmSocket.state?.meta.playerSceneId, run.mat, "Shift+Enter moves nobody");
    } finally {
      routed.release();
      await routed.context.close();
    }
  });

  test("se-6. Show players <scene> refused: the row says why and the blackout stays on, a refusal after Escape is the room's toast, and a co-DM deleting the scene meanwhile leaves the blackout on", async () => {
    await movePlayersTo(run.mat);
    const routed = await routedDm();
    const page = routed.page;
    try {
      await setBlackout(true);
      await viewScene(page, run.crypt);
      // Refused in the row: the move's scene spoiled on its way out, as one deleted on the server is.
      await openSearch(page);
      await typeFor(page, "show players", "item:showPlayers");
      assert.match((await row(page, "item:showPlayers").textContent()) ?? "", /Show players Crypt of bones/, "titled as the menu titles it");
      assert.match((await row(page, "item:showPlayers").textContent()) ?? "", /Moves the players here and ends the blackout in one step\./, "its description in place of where it lives");
      routed.spoil = true;
      await page.keyboard.press("Enter");
      const said = row(page, "item:showPlayers").getByText("Players not moved. That scene was deleted.");
      await said.waitFor();
      assert.equal(await sheet(page).count(), 1, "the search stays open with the refusal");
      assert.ok((await focused(page))?.field, "focus stays in the field");
      await waitFor("the refusal said", async () => ((await sheet(page).locator('[role="status"]').textContent())?.includes("Players not moved") ? true : null));
      assert.equal(blackout(), true, "the blackout stays on");
      assert.equal(dmSocket.state?.meta.playerSceneId, run.mat, "nobody moved");
      await shots.take(page, "se-6-refused-in-row");

      // Refused once the search has closed: the room's toast says it.
      routed.holding = true;
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await sheet(page).waitFor({ state: "detached" });
      routed.release();
      await page.getByText("Players not moved. That scene was deleted.").first().waitFor();
      assert.equal(blackout(), true, "the blackout stays on");
      routed.spoil = false;
      await fresh(page);

      // A co-DM deletes the scene while the DM's Show players is on its way.
      const doomed = randomUUID();
      await ops.send({ t: "scene.create", scene: { id: doomed, name: "Doomed hall", bounds: { w: 10, h: 10 }, fogEnabled: true } });
      await viewScene(page, doomed);
      await openSearch(page);
      await typeFor(page, "show players", "item:showPlayers");
      routed.holding = true;
      await ops.send({ t: "scene.delete", sceneId: doomed });
      const from = routed.sent.length;
      await page.keyboard.press("Enter");
      await waitFor("the move sent", () => (routed.sent.slice(from).some((f) => f.includes("room.setPlayerScene")) ? true : null));
      routed.release();
      await waitFor("the move's answer", async () => ((await page.locator('[data-search-row="item:showPlayers"]').count()) === 0 || (await page.getByText("Players not moved").count()) > 0 ? true : null));
      await settle(page);
      assert.equal(blackout(), true, "the blackout stays on");
      assert.equal(dmSocket.state?.meta.playerSceneId, run.mat, "nobody moved");
      await waitFor("the refusal said, in the row or as the room's toast", async () => ((await page.getByText(/Players not moved\./).count()) > 0 ? true : null), 3_000);
    } finally {
      routed.release();
      await routed.context.close();
      await setBlackout(false);
    }
  });

  test("se-7. a recent showing for Pat alone is the row Show Belak's letter to Pat and goes to Pat only, one for a player who left is not offered, nor one whose image was deleted", async () => {
    const now = Date.now();
    const entries = [
      { kind: "image", assetId: run.letter, title: "Belak's letter", to: [run.patId], at: now - 1_000 },
      { kind: "image", assetId: run.cryptMap, title: "Crypt map", to: [run.leeId], at: now - 2_000 },
    ];
    await fresh();
    await dm.evaluate(([key, value]) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(key!, value!), [`rvtt.handoutsRecent.${run.roomId}`, JSON.stringify(entries)]);
    await fresh();
    const letterRow = `item:recent:image:${run.letter}`;
    const mapRow = `item:recent:image:${run.cryptMap}`;
    await openSearch(dm);
    await typeFor(dm, "belak", letterRow);
    const text = (await row(dm, letterRow).textContent()) ?? "";
    assert.match(text, /Show Belak's letter to Pat/, "the row names Pat as the menu does");
    assert.match(text, /Action · Shows it to Pat again\./, "its description in place of where it lives");
    await typeFor(dm, "crypt map", mapRow);
    assert.match((await row(dm, mapRow).textContent()) ?? "", /Show Crypt map to Lee/);
    await dm.keyboard.press("Escape");
    const from = dmSocket.sent.length;
    await pick(dm, "belak", letterRow);
    await sheet(dm).waitFor({ state: "detached" });
    const shown = sentOps(dmSocket, from, "handout.show");
    assert.equal(shown.length, 1, "one show");
    assert.deepEqual((shown[0]!.handout as { to: unknown }).to, [run.patId], "to Pat only");
    assert.equal((shown[0]!.handout as { assetId: unknown }).assetId, run.letter);
    const handoutId = (shown[0]!.handout as { id: string }).id;
    await waitFor("the showing", () => (dmSocket.state?.handouts[handoutId] ? true : null));
    await ops.send({ t: "handout.close", handoutId });

    // Lee leaves: the crypt map, shown to Lee alone, has nobody to go to.
    const left = await desk.request.delete(`${server.origin}/api/rooms/${run.roomId}/members/${run.leeId}`, { headers: { Origin: server.origin } });
    assert.ok(left.ok(), `removing Lee answered ${left.status()}`);
    await waitFor("Lee gone", () => (dmSocket.state?.members[run.leeId] ? null : true));
    await openSearch(dm);
    await typeFor(dm, "belak", letterRow);
    await field(dm).fill("crypt map");
    await settle(dm);
    assert.equal(await row(dm, mapRow).count(), 0, "a showing whose players all left is not offered");
    await dm.keyboard.press("Escape");

    // Belak's letter's image deleted from the library: gone from the search and the menu alike.
    const gone = await desk.request.post(`${server.origin}/api/rooms/${run.roomId}/assets/delete`, { headers: { Origin: server.origin, "content-type": "application/json" }, data: { ids: [run.letter] } });
    assert.ok(gone.ok(), `the delete answered ${gone.status()}`);
    await fresh();
    await openSearch(dm);
    await field(dm).fill("belak");
    await waitFor("the library listed", async () => ((await row(dm, letterRow).count()) === 0 ? true : null));
    await dm.keyboard.press("Escape");
    await dm.locator('[data-chip="dm"]').click();
    await dm.locator('[data-chip-item="showHandout"]').waitFor();
    assert.equal(await dm.locator(`[data-chip-item="recent:image:${run.letter}"]`).count(), 0, "nor in the DM menu");
    await dm.keyboard.press("Escape");
  });

  test("se-8. Enter on Long Rest for the party: Characters opens with the party's card and Finish focused, and nobody rests until Finish is pressed", async () => {
    await fresh();
    await ops.send({ t: "actor.hp", target: { characterId: run.bree }, change: { kind: "damage", amount: 14 } });
    await waitFor("Bree hurt", () => (dmSocket.state?.characters[run.bree]?.actor.hp.cur === 10 ? true : null));
    await openSearch(dm);
    await field(dm).fill("rest");
    await waitFor("rest's best bet", async () => ((await rowIds(dm))[0] === "action:characters.party-long-rest" ? true : null));
    await dm.keyboard.press("Escape");
    const from = dmSocket.sent.length;
    await pick(dm, "rest", "action:characters.party-long-rest");
    const f = await waitFor("Finish focused", async () => {
      const now = await focused(dm);
      return now?.name === "Finish the Long Rest" ? now : null;
    });
    assert.equal(f.pane, "characters", "in Characters");
    await settle(dm);
    await sleep(300);
    assert.deepEqual(sentOps(dmSocket, from), [], "nothing sent: nobody rested");
    assert.equal(dmSocket.state?.characters[run.bree]?.actor.hp.cur, 10);
    await shots.take(dm, "se-8-party-rest");
    await dm.keyboard.press("Enter");
    await waitFor("the party rested once Finish was pressed", () => (dmSocket.state?.characters[run.bree]?.actor.hp.cur === 24 ? true : null));
  });

  test("se-9. Enter on a setting focuses and rings it unchanged, and a fold the DM folded opens for now, its choice focused, and folds again once Menu closes", async () => {
    await fresh();
    await pick(dm, "turn sound", "setting:menu.this-device.sounds.turn");
    const sw = dm.locator('[data-search="menu.this-device.sounds.turn"]');
    const before = await sw.getAttribute("aria-checked");
    const f = await landedOn(dm, "menu.this-device.sounds.turn");
    assert.equal(f.pane, "menu");
    assert.ok(await ringed(dm, "menu.this-device.sounds.turn"), "ringed");
    await sleep(1_700);
    assert.equal(await ringed(dm, "menu.this-device.sounds.turn"), false, "the ring ends by itself");
    assert.equal(await sw.getAttribute("aria-checked"), before, "unchanged");

    // The DM folds Theme on purpose.
    const themeFold = dm.locator('[data-search="menu.this-device.theme"] button[aria-expanded]');
    if ((await themeFold.getAttribute("aria-expanded")) === "true") await themeFold.click();
    assert.equal(await themeFold.getAttribute("aria-expanded"), "false");
    const kept = () => dm.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("rvtt.thisDeviceFolds"));
    const stored = await kept();
    await pick(dm, "dice", "panel:dice");
    await sheet(dm).waitFor({ state: "detached" });
    await pick(dm, "theme", "setting:menu.this-device.theme.choice");
    const theme = await landedOn(dm, "menu.this-device.theme.choice");
    assert.equal(theme.checked, true, "the chosen theme's option");
    assert.equal(await themeFold.getAttribute("aria-expanded"), "true", "open for now");
    assert.equal(await kept(), stored, "the fold's store is not written");
    // Menu closes, then opens again on This device: Theme folded as the DM left it.
    await pick(dm, "dice", "panel:dice");
    await sheet(dm).waitFor({ state: "detached" });
    await pick(dm, "this device", "section:menu.this-device");
    await sheet(dm).waitFor({ state: "detached" });
    await themeFold.waitFor();
    assert.equal(await themeFold.getAttribute("aria-expanded"), "false", "folded again");
    await themeFold.click();
  });

  test("se-10. Enter presses an action's control, so its own picker, confirm or code shows, and an action whose control is off lands on the field that turns it on, ringed and not pressed", async () => {
    await fresh();
    await pick(dm, "change your color", "action:menu.members.color");
    await landedOn(dm, "menu.members.color");
    await waitFor("the color picker", async () => ((await dm.locator('[data-search="menu.members.color"]').getAttribute("aria-expanded")) === "true" ? true : null));
    await dm.keyboard.press("Escape");
    await pick(dm, "change the password", "action:menu.members.password.change");
    await dm.getByText(/Every player is signed out now/).first().waitFor();
    await dm.getByRole("button", { name: "Cancel", exact: true }).first().click();
    assert.equal(dmSocket.state?.members[run.patId] !== undefined, true, "nobody signed out");
    await pick(dm, "add a tv", "action:dm.display.add");
    await waitFor("a display code", async () => ((await dm.locator('[data-search="dm.display.add"]').count()) === 0 ? true : null));

    // Change the password is off while the new password is empty.
    await pick(dm, "new player password", "setting:menu.members.password.new");
    await landedOn(dm, "menu.members.password.new");
    await dm.locator('[data-search="menu.members.password.new"] input').fill("");
    const change = dm.locator('[data-search="menu.members.password.change"]');
    assert.equal(await change.isDisabled(), true, "Change the password is off");
    // Out of the field first, so focus that comes back to it is the landing's, not the search's opener's.
    await dm.locator('[data-search="menu.members.password.new"] input').blur();
    assert.equal((await focused(dm))?.anchor ?? null, null, "focus out of the field");
    await pick(dm, "change the password", "action:menu.members.password.change");
    await sheet(dm).waitFor({ state: "detached" });
    // A control that is off takes no focus, so the landing puts it on the field that turns it on, and rings the control (D-261106-362).
    const f = await landedOn(dm, "menu.members.password.new");
    assert.equal(f.tag, "input", "the new password's field");
    assert.ok(await ringed(dm, "menu.members.password.change"), "Change the password ringed");
    await settle(dm);
    assert.equal(await dm.getByText(/Every player is signed out now/).count(), 0, "not pressed: no confirm");
  });

  test("se-11. Enter on a token off screen selects it, frames it and opens its action bar", async () => {
    await fresh();
    const canvas = (await dm.locator(".konvajs-content").first().boundingBox())!;
    const onScreen = async (x: number, y: number) => {
      const cam = (await readCamera(dm))!;
      const px = cam.x + x * cam.scale;
      const py = cam.y + y * cam.scale;
      return px >= 0 && py >= 0 && px <= canvas.width && py <= canvas.height;
    };
    // Close in on the battle mat's top left, so Goblin 3 at its far corner is off screen.
    await dm.mouse.move(canvas.x + 200, canvas.y + 150);
    for (let i = 0; i < 6 && (await onScreen(56.5, 36.5)); i++) {
      await dm.mouse.wheel(0, -600);
      await sleep(250);
    }
    assert.equal(await onScreen(56.5, 36.5), false, "Goblin 3 starts off screen");
    await pick(dm, "goblin 3", `token:${run.g3}`);
    await sheet(dm).waitFor({ state: "detached" });
    const bar = dm.locator('[role="dialog"][data-bar-mode]');
    await bar.first().waitFor();
    assert.match((await bar.first().getAttribute("aria-label")) ?? "", /Goblin 3/, "its action bar");
    await waitFor("Goblin 3 framed", async () => ((await onScreen(56.5, 36.5)) ? true : null));
    await shots.take(dm, "se-11-token-framed");
  });

  test("se-12. a condition goes on the selected token and comes off it through the picker's own op, and Undo takes it back", async () => {
    await fresh();
    await pick(dm, "goblin 1", `token:${run.g1}`);
    await dm.locator('[role="dialog"][data-bar-mode]').first().waitFor();
    const effects = () => dmSocket.state?.tokens[run.g1]?.actor && "inline" in dmSocket.state.tokens[run.g1]!.actor ? (dmSocket.state.tokens[run.g1]!.actor as { inline: { effects: { key: string }[] } }).inline.effects.map((e) => e.key) : [];
    await openSearch(dm);
    await typeFor(dm, "prone", "condition:prone");
    assert.match((await row(dm, "condition:prone").textContent()) ?? "", /Condition · Add to Goblin 1/);
    await dm.keyboard.press("Escape");
    const from = dmSocket.sent.length;
    await pick(dm, "prone", "condition:prone");
    await waitFor("Prone on", () => (effects().includes("prone") ? true : null));
    assert.deepEqual(sentOps(dmSocket, from).map((o) => o.t), ["actor.effect.add"], "the picker's op");
    await openSearch(dm);
    await typeFor(dm, "prone", "condition:prone");
    assert.match((await row(dm, "condition:prone").textContent()) ?? "", /Condition · Remove from Goblin 1/);
    await dm.keyboard.press("Enter");
    await waitFor("Prone off", () => (effects().includes("prone") ? null : true));
    await dm.keyboard.press("Control+z");
    await waitFor("Undo puts it back", () => (effects().includes("prone") ? true : null));
    await ops.send({ t: "actor.effect.remove", target: { tokenId: run.g1 }, effectId: (dmSocket.state!.tokens[run.g1]!.actor as { inline: { effects: { id: string }[] } }).inline.effects[0]!.id });
  });

  test("se-13. a key's row runs it as the key would, and an item that opens a dialog hands focus back to the search's opener when it closes", async () => {
    await fresh();
    await openSearch(dm);
    await typeFor(dm, "fog tool", "key:tool:fog");
    assert.equal((await rowIds(dm))[0], "key:tool:fog");
    assert.equal(await row(dm, "key:tool:fog").locator("kbd").textContent(), "F", "its key shows");
    await dm.keyboard.press("Enter");
    await sheet(dm).waitFor({ state: "detached" });
    const fog = dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Fog", exact: true });
    await waitFor("the Fog tool", async () => ((await fog.getAttribute("data-active")) === "true" ? true : null));
    await dm.keyboard.press("v");

    await barSearch(dm).click();
    await sheet(dm).waitFor();
    await typeFor(dm, "show a handout", "item:showHandout");
    await dm.keyboard.press("Enter");
    const dialog = dm.getByRole("dialog", { name: "Show a handout" });
    await dialog.waitFor();
    assert.equal(await sheet(dm).count(), 0, "the search closed first");
    await waitFor("focus in the dialog", async () => ((await dialog.evaluate((node) => {
      const el = node as unknown as DomEl;
      return el.contains(el.ownerDocument.activeElement);
    })) ? true : null));
    await dm.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal((await focused(dm))?.open, "bar", "focus back on the search's opener");
  });

  test("se-14. Shift+Enter only goes: an action unpressed, a token's panel, a condition's Conditions, a dice formula into the Dice field unrolled, and a panel and a key as Enter", async () => {
    await fresh();
    await pick(dm, "add a tv", "action:dm.display.add", true);
    await landedOn(dm, "dm.display.add");
    await settle(dm);
    await sleep(300);
    assert.equal(await dm.locator('[data-search="dm.display.add"]').count(), 1, "Add a TV still shows: no code made");

    await pick(dm, "goblin 2", `token:${run.g2}`, true);
    const tokenPane = dm.locator('[data-pane-panel="token"]');
    await tokenPane.waitFor();
    await tokenPane.getByText("Goblin 2").first().waitFor();
    assert.equal(await dm.locator('[role="dialog"][data-bar-mode]').count(), 0, "its panel, not its bar");

    await pick(dm, "blinded", "condition:blinded", true);
    await sheet(dm).waitFor({ state: "detached" });
    await waitFor("Combat open in the token panel", async () => ((await tokenPane.locator('[data-search="token.combat"] button[aria-expanded="true"]').count()) > 0 ? true : null));
    await settle(dm);
    assert.ok(!JSON.stringify(dmSocket.state?.tokens[run.g2]?.actor).includes("blinded"), "nothing added");

    const from = dmSocket.sent.length;
    await pick(dm, "2d6+3", "dice:2d6+3", true);
    await landedOn(dm, "dice.formula");
    assert.equal(await dm.locator('[data-search="dice.formula"]').inputValue(), "2d6+3", "the formula in the field");
    await settle(dm);
    assert.deepEqual(sentOps(dmSocket, from, "dice.roll"), [], "nothing rolled");
    await dm.locator('[data-search="dice.formula"]').fill("");
    // Enter rolls it as the Dice panel's Roll does.
    await pick(dm, "1d20+2", "dice:1d20+2");
    await waitFor("the roll", () => (sentOps(dmSocket, from, "dice.roll").length === 1 ? true : null));

    await pick(dm, "log", "panel:log", true);
    await waitFor("the Log's tab focused", async () => ((await focused(dm))?.role === "tab" && /Log/.test((await focused(dm))?.name ?? "") ? true : null));
    await pick(dm, "fog tool", "key:tool:fog", true);
    const fog = dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Fog", exact: true });
    await waitFor("the Fog tool", async () => ((await fog.getAttribute("data-active")) === "true" ? true : null));
    await dm.keyboard.press("v");
  });

  test("se-15. records land where they live: a playlist's row and a track's Play in Sound's Library, also with Library open, Play <playlist> playing it and hidden while it plays, Now playing, a character's and a token's group, a scene in a folded folder, a monster's card at Place, and a showing's and a document's viewer", async () => {
    await fresh();
    await ops.send({ t: "music.stop" }).catch(() => {});
    await pick(dm, "goblin war drums", `playlist:${run.drums}`);
    await landedOn(dm, "sound.playlist");
    await shots.take(dm, "se-15-playlist");
    await pick(dm, "tavern song", `track:${run.song}`);
    await landedOn(dm, "sound.track");
    // Library already open: the anchor moves to the named record within the same view.
    await pick(dm, "goblin war drums", `playlist:${run.drums}`);
    await landedOn(dm, "sound.playlist");
    await pick(dm, "play goblin war drums", `action:play:${run.drums}`);
    await landedOn(dm, "sound.playlist.play");
    await waitFor("the drums playing", () => (dmSocket.state?.playing?.music?.playlistId === run.drums ? true : null));
    await openSearch(dm);
    await typeFor(dm, "goblin war drums", `playlist:${run.drums}`);
    assert.equal(await row(dm, `action:play:${run.drums}`).count(), 0, "Play <playlist> is not offered while it plays");
    await dm.keyboard.press("Escape");
    await ops.send({ t: "music.stop" }).catch(() => {});

    // Now playing: Sound at its top, focus on Sound's tab, as the chip's Open Sound leaves it.
    await pick(dm, "music", "section:sound.now");
    await waitFor("Sound's tab focused", async () => {
      const f = await focused(dm);
      return f?.role === "tab" && /Sound/.test(f.name) ? true : null;
    });
    await dm.locator('[data-pane-panel="sound"] [data-sound-view="now"]').waitFor();

    // A character's group from its page, and the selected token's from the token panel.
    await pick(dm, "armor class bree", `field:character:${run.bree}:ac`);
    const ac = await landedOn(dm, "character.ac");
    assert.equal(ac.pane, "characters", "on Bree's page");
    await pick(dm, "goblin 1", `token:${run.g1}`);
    await dm.locator('[role="dialog"][data-bar-mode]').first().waitFor();
    await pick(dm, "stats goblin", `field:token:${run.g1}:stats`);
    assert.equal((await landedOn(dm, "token.stats")).pane, "token");

    // A scene in a folder this device folded: its row, the folder open for now, the DM's camera where it was.
    await ops.send({ t: "scene.update", sceneId: run.crypt, patch: { folder: "Dungeons" } });
    await pick(dm, "scenes", "panel:scenes");
    const folder = dm.locator('[data-pane-panel="scenes"] button[aria-expanded]').filter({ hasText: "Dungeons" });
    await folder.waitFor();
    if ((await folder.getAttribute("aria-expanded")) === "true") await folder.click();
    assert.equal(await dm.locator(`[data-search-page="scene:${run.crypt}"]`).count(), 0, "the folder folded");
    const viewed = await viewing(dm);
    await pick(dm, "crypt of bones", `scene:${run.crypt}`);
    await waitFor("focus on the crypt's row", async () => ((await focused(dm))?.record === `scene:${run.crypt}` ? true : null));
    assert.equal(await folder.getAttribute("aria-expanded"), "true", "open for now");
    assert.equal(await viewing(dm), viewed, "the DM's camera did not move");
    await folder.click();
    assert.equal(await folder.getAttribute("aria-expanded"), "false", "a tap folds it again");
    await ops.send({ t: "scene.update", sceneId: run.crypt, patch: { folder: null } });

    await pick(dm, "goblin boss", "monster:srd:goblin-boss");
    await landedOn(dm, "monsters.card.place");
    await shots.take(dm, "se-15-monster");

    // A handout showing to everyone, and a document in the library: each opens its viewer.
    await ops.send({ t: "handout.show", handout: { id: run.townShown, assetId: run.townMap, title: "Town map", to: "all" } });
    await waitFor("the town map showing", () => (dmSocket.state?.handouts[run.townShown] ? true : null));
    await pick(dm, "town map", `handout:${run.townShown}`);
    const viewer = dm.locator("dialog[open]").filter({ hasText: "Town map" });
    await viewer.first().waitFor();
    await dm.keyboard.press("Escape");
    await viewer.first().waitFor({ state: "detached" });
    const docId = randomUUID();
    await ops.send({ t: "handoutDoc.create", doc: { id: docId, title: "Ship manifest", pages: [{ assetId: run.cryptMap, width: 60, height: 80 }] } });
    await waitFor("the document", () => (dmSocket.state?.handoutDocs?.[docId] ? true : null));
    await pick(dm, "ship manifest", `handout:doc:${docId}`);
    await dm.locator("dialog[open]").filter({ hasText: "Ship manifest" }).first().waitFor();
    await dm.keyboard.press("Escape");
  });

  test("se-16. a Dice fold the route opened folds again when Dice closes, and a map phase's item sets the phase on Enter and goes to Show a phase on Shift+Enter", async () => {
    await fresh();
    await pick(dm, "goblin 1", `token:${run.g1}`);
    await dm.locator('[role="dialog"][data-bar-mode]').first().waitFor();
    await pick(dm, "dice", "panel:dice");
    const saves = dm.locator('[data-search="dice.saves"] button[aria-expanded]');
    await saves.waitFor();
    if ((await saves.getAttribute("aria-expanded")) === "true") await saves.click();
    assert.equal(await saves.getAttribute("aria-expanded"), "false", "the DM folds Saves and checks");
    await pick(dm, "log", "panel:log");
    await sheet(dm).waitFor({ state: "detached" });
    await pick(dm, "saves", "section:dice.saves");
    await landedOn(dm, "dice.saves");
    assert.equal(await saves.getAttribute("aria-expanded"), "true", "opened for now");
    await pick(dm, "log", "panel:log");
    await sheet(dm).waitFor({ state: "detached" });
    await pick(dm, "dice", "panel:dice");
    await saves.waitFor();
    assert.equal(await saves.getAttribute("aria-expanded"), "false", "folded again once Dice closed");

    await viewScene(dm, run.crypt);
    await openSearch(dm);
    await typeFor(dm, "moonlit", `item:phase:${run.night}`);
    assert.match((await row(dm, `item:phase:${run.night}`).textContent()) ?? "", /DM menu · Map phase/);
    await dm.keyboard.press("Escape");
    await pick(dm, "moonlit", `item:phase:${run.night}`, true);
    await landedOn(dm, "scenes.map.phases");
    assert.equal(dmSocket.state?.scenes[run.crypt]?.phaseId, run.day, "Shift+Enter sets nothing");
    await pick(dm, "moonlit", `item:phase:${run.night}`);
    await waitFor("the night phase", () => (dmSocket.state?.scenes[run.crypt]?.phaseId === run.night ? true : null));
    await ops.send({ t: "scene.setPhase", sceneId: run.crypt, phaseId: run.day });
    await viewScene(dm, run.mat);
  });

  test("se-17. a DM's phone: the top bar's Search icon and Cancel, the Panels list's field, landings inside the panel's sheet, a token picked with the sheet closed first, and at 320 x 568 at 130% Search folded into the Panels field with nothing overflowing", async () => {
    let phone = await dmPhone();
    try {
      const page = phone.page;
      assert.equal(await barSearch(page).getAttribute("data-search-form"), "icon", "the icon at 390");
      await barSearch(page).tap();
      await sheet(page).waitFor();
      assert.equal(await sheet(page).getAttribute("data-search-sheet"), "sheet", "a sheet over the whole screen");
      assert.ok((await focused(page))?.field, "the field takes focus");
      await shots.take(page, "se-17-phone-empty");
      await sheet(page).getByRole("button", { name: "Cancel", exact: true }).tap();
      await sheet(page).waitFor({ state: "detached" });
      assert.equal((await focused(page))?.open, "bar", "Cancel: focus back on the icon");

      // The Panels list's field, always atop the list.
      await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
      const panelsField = page.locator('[data-search-open="panels"]');
      await panelsField.waitFor();
      assert.match((await panelsField.textContent()) ?? (await panelsField.getAttribute("aria-label")) ?? "", /Search panels, settings and the room/);
      await panelsField.tap();
      await sheet(page).waitFor();
      assert.ok((await focused(page))?.field, "the Panels field opens it with focus in the field");
      await sheet(page).getByRole("button", { name: "Cancel", exact: true }).tap();
      await sheet(page).waitFor({ state: "detached" });

      // Landings in the panel's sheet: a setting, one in a fold the phone keeps folded, and an action only gone to.
      for (const [text, id, anchor, only] of [
        ["turn timer", entryId("Turn timer", "setting"), entryId("Turn timer", "setting").slice("setting:".length), false],
        ["low power", "setting:menu.this-device.battery.low-power", "menu.this-device.battery.low-power", false],
        ["show the player link", "action:dm.link.show", "dm.link.show", true],
      ] as const) {
        await tapPick(page, text, id, only);
        const f = await landedOn(page, anchor);
        assert.ok(f.sheet, `${text}: in the panel's sheet`);
      }
      await shots.take(page, "se-17-phone-landed");

      // A token: the sheet goes first, so it is not under it.
      await tapPick(page, "goblin 1", `token:${run.g1}`);
      await page.locator('[role="dialog"][data-bar-mode]').first().waitFor();
      assert.equal(await page.locator("dialog[data-rvtt-sheet][open]").count(), 0, "no panel's sheet over the map");
      await phone.context.close();

      phone = await dmPhone({ width: 320, height: 568 }, 1.3);
      assert.equal(await barSearch(phone.page).count(), 0, "320 at 130%: no Search in the top bar");
      // As the top bar measures itself (pages/topBarFit.ts): the last button's tuck into the bar's padding is room the row has.
      const overflow = await phone.page.locator("header[data-rvtt-topbar] > div").first().evaluate((node) => {
        const row = node as unknown as { scrollWidth: number; clientWidth: number; lastElementChild: unknown };
        const style = (globalThis as unknown as { getComputedStyle(e: unknown): { marginRight: string } }).getComputedStyle;
        const tuck = row.lastElementChild ? Math.max(0, -parseFloat(style(row.lastElementChild).marginRight) || 0) : 0;
        return row.scrollWidth - row.clientWidth - tuck;
      });
      assert.ok(overflow <= 0, `the top bar overflows by ${overflow} px`);
      await tapSearch(phone.page);
      assert.equal(await sheet(phone.page).getAttribute("data-search-sheet"), "sheet");
      await shots.take(phone.page, "se-17-phone-320-130");
    } finally {
      await phone.context.close();
    }
  });

  test("se-18. a landing whose panel's code comes late lands once it draws, the newer of two, and a key pressed before then ends it", async () => {
    const holdMenu = async (context: BrowserContext) => {
      const held: (() => void)[] = [];
      let holding = true;
      await context.route(/\/assets\/MenuPanel-[^/]*\.js$/, async (route) => {
        if (!holding) return route.continue();
        held.push(() => void route.continue());
      });
      return () => {
        holding = false;
        for (const go of held.splice(0)) go();
      };
    };
    const context = await dmContext(PHONE, WINDOWS, "late");
    try {
      const release = await holdMenu(context);
      const page = await context.newPage();
      watchConsole(page, "dm-late-menu");
      await openRoom(page);
      await tapPick(page, "turn sound", "setting:menu.this-device.sounds.turn");
      await sheet(page).waitFor({ state: "detached" });
      await sleep(500);
      assert.notEqual((await focused(page))?.anchor, "menu.this-device.sounds.turn", "nothing lands while Menu's code waits");
      // A second route before the first landed takes its place.
      await tapPick(page, "ping sound", "setting:menu.this-device.sounds.ping");
      await sheet(page).waitFor({ state: "detached" });
      release();
      const f = await landedOn(page, "menu.this-device.sounds.ping");
      assert.ok(f.sheet, "the newer lands in Menu's sheet once drawn");
    } finally {
      await context.close();
    }

    const second = await dmContext(PHONE, WINDOWS, "late");
    try {
      const release = await holdMenu(second);
      const page = await second.newPage();
      watchConsole(page, "dm-late-menu-key");
      await openRoom(page);
      await tapPick(page, "turn sound", "setting:menu.this-device.sounds.turn");
      await sheet(page).waitFor({ state: "detached" });
      await page.keyboard.press("Shift");
      release();
      await page.locator('[data-search="menu.this-device.sounds.turn"]').waitFor();
      await sleep(500);
      assert.notEqual((await focused(page))?.anchor, "menu.this-device.sounds.turn", "the viewer's key ended the landing");
    } finally {
      await second.close();
    }
  });

  test("se-19. the DM's results while their chunk loads, Loading the DM's results… after the shared delay with the rest listed, then failed with Try again, and Reload once Chrome keeps the failed module", async () => {
    const context = await dmContext({ viewport: DESK }, WINDOWS, "failed");
    try {
      const held: (() => void)[] = [];
      let fail = false;
      await context.route(/\/assets\/dm-[^/]*\.js$/, (route) => {
        if (fail) return void route.abort();
        held.push(() => void route.abort());
      });
      const page = await context.newPage();
      const watch = watchConsole(page, "dm-catalog-failed");
      // The DM's catalog cut off on purpose: its load fails, and Chrome says so.
      watch.allow.push(/Failed to load resource|Failed to fetch dynamically imported module|net::ERR_FAILED/);
      await openRoom(page);
      await barSearch(page).click();
      await sheet(page).waitFor();
      assert.equal(await page.locator("[data-search-loading]").count(), 1, "the DM's part loading");
      await page.getByText("Loading the DM's results…").waitFor();
      assert.ok((await rowIds(page)).length > 0, "the rest still listed");
      await shots.take(page, "se-19-loading");
      fail = true;
      for (const h of held.splice(0)) h();
      await page.getByText("Some results could not load.").waitFor();
      await sheet(page).getByRole("button", { name: "Try again" }).click();
      await sheet(page).getByRole("button", { name: "Reload" }).waitFor();
      assert.ok((await focused(page))?.field, "Try again hands focus to the field as its line goes");
      await shots.take(page, "se-19-reload");
    } finally {
      await context.close();
    }
  });

  test("se-20. a player's search holds only what the player may reach: no hidden token, no hidden true name, no DM page, no music, no DM setting and no DM menu item, the goblins Pat's map draws, Pat's own fields first, the pages and handouts Pat holds, and the DM's chunk never asked for", async () => {
    await movePlayersTo(run.mat);
    const page = await patPhone.newPage();
    watchConsole(page, "pat");
    await patSocket.attach(patPhone, page);
    page.on("request", (r) => patLoads.urls.push(r.url()));
    page.on("response", (r) => {
      if (/\/assets\/[^/]+\.js$/.test(new URL(r.url()).pathname)) patLoads.scripts.set(r.url(), r.text().catch(() => ""));
    });
    await openRoom(page);
    await waitFor("Pat's projection", () => patSocket.state);
    const dmChunk = () => patLoads.urls.filter((u) => /\/assets\/dm-[^/]*\.js$/.test(u));
    assert.deepEqual(dmChunk(), [], "the DM's catalog never asked for before the search opens");
    await tapSearch(page);
    assert.equal(await field(page).getAttribute("placeholder"), "Search panels, settings, your character…");
    await waitFor("Pat's Suggested", async () => ((await rowIds(page)).includes(`character:${run.bree}`) ? true : null));

    // The goblins Pat's map draws, and no other.
    const drawn = Object.values(patSocket.state!.tokens).filter((t) => t?.sceneId === run.mat && /goblin/i.test(t.name)).map((t) => `token:${t!.id}`).sort();
    assert.ok(drawn.length >= 2 && !drawn.includes(`token:${run.boss}`), "the projection holds the seen goblins only");
    await field(page).fill("goblin");
    await waitFor("the goblins", async () => ((await rowIds(page)).length > 0 ? true : null));
    assert.deepEqual((await rowIds(page)).filter((id) => id.startsWith("token:")).sort(), drawn, "only the goblins Pat's map draws");
    assert.ok(!(await rowIds(page)).some((id) => id.startsWith("monster:")), "no monsters for a player");
    await shots.take(page, "se-20-player-goblin");

    // The canaries of search.md 7 and 8: each finds nothing at all.
    for (const canary of ["goblin boss", "count varo", "villain's plans", "goblin war drums", "tavern song", "Monsters die at 0 HP", "house rules", "send players here"]) {
      await field(page).fill(canary);
      await page.locator("[data-search-none]").waitFor().catch(() => {});
      assert.deepEqual(await rowIds(page), [], `"${canary}" finds nothing for Pat`);
      assert.equal((await page.locator("[data-search-none]").textContent())?.trim(), `No match for “${canary}”.`);
    }
    for (const word of ["pause", "black out", "move players", "view as", "show a handout"]) {
      await field(page).fill(word);
      await settle(page);
      assert.ok(!(await rowIds(page)).some((id) => id.startsWith("item:") && id !== "item:xcard"), `"${word}" finds no DM menu item`);
    }
    await field(page).fill("music");
    await waitFor("music's rows", async () => ((await rowIds(page)).length > 0 ? true : null));
    // Pat's own Sound panel, where the room plays, is this device's sound too.
    for (const id of await rowIds(page)) assert.match(id, /^((setting|section):menu\.this-device\.|panel:sound$)/, `music finds only This device's sound for Pat, not ${id}`);
    // The true name is never typed into a match: the hooded figure by the name Pat's map gives it.
    await typeFor(page, "hooded", `token:${run.varo}`);
    assert.match((await row(page, `token:${run.varo}`).textContent()) ?? "", /Hooded figure/);
    assert.doesNotMatch((await sheet(page).locator("section").textContent()) ?? "", /\bhidden\b|for the DM|\bmore\b/i, "no mark or count of what is left out");

    // What Pat reaches: their own character's fields first, their pages, the X-card, their keys, dice, a handout showing to them.
    await field(page).fill("long rest");
    await waitFor("Bree's Long Rest first", async () => ((await rowIds(page))[0] === `field:character:${run.bree}:long-rest` ? true : null));
    await field(page).fill("darkvision");
    await waitFor("Bree's Senses", async () => ((await rowIds(page))[0] === `field:character:${run.bree}:senses` ? true : null));
    assert.match((await rows(page).first().textContent()) ?? "", /Field · Bree: Darkvision 60 ft\./, "its value shown");
    await typeFor(page, "town lore", `page:${run.lore}`);
    await typeFor(page, "x-card", "item:xcard");
    await typeFor(page, "ruler", "key:tool:ruler");
    await field(page).fill("2d6");
    await waitFor("the formula's row", async () => ((await rowIds(page))[0] === "dice:2d6" ? true : null));
    await row(page, `field:character:${run.bree}:senses`).count();
    await page.keyboard.press("Escape").catch(() => {});
    await tapPick(page, "darkvision", `field:character:${run.bree}:senses`);
    const f = await landedOn(page, "character.senses");
    assert.equal(f.tag, "input", "Bree's Senses field focused");
    await tapPick(page, "town map", `handout:${run.townShown}`);
    await page.locator("dialog[open]").filter({ hasText: "Town map" }).first().waitFor();
    await page.keyboard.press("Escape");
    assert.deepEqual(dmChunk(), [], "nor after the search opened");
    await page.close();
  });

  test("se-21. recent picks are this device's per member: a player's never show the DM's, and a token hidden since leaves Recent", async () => {
    const page = await patPhone.newPage();
    watchConsole(page, "pat-recent");
    await patSocket.attach(patPhone, page);
    try {
      // The DM used this device before: their picks are under their own member.
      const dmMember = dmSocket.you!.memberId;
      await openRoom(page);
      await page.evaluate(([key, ids]) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(key!, ids!), [`rvtt.searchRecent.${run.roomId}.${dmMember}`, JSON.stringify(["item:blackout", `token:${run.boss}`, "panel:dm"])]);
      await openRoom(page);
      await tapPick(page, "goblin 2", `token:${run.g2}`);
      await page.locator('[role="dialog"][data-bar-mode]').first().waitFor();
      await tapSearch(page);
      await page.getByText("Recent", { exact: true }).waitFor();
      const recent = await rowIds(page);
      assert.equal(recent[0], `token:${run.g2}`, "Pat's own pick first under Recent");
      for (const id of ["item:blackout", `token:${run.boss}`, "panel:dm"]) assert.ok(!recent.includes(id), `the DM's ${id} is not Pat's`);
      await page.keyboard.press("Escape");
      await sheet(page).waitFor({ state: "detached" });
      // The DM hides Goblin 2: gone from Pat's projection, so from Recent.
      await ops.send({ t: "token.update", tokenId: run.g2, patch: { visibility: "dm" } });
      await waitFor("Goblin 2 gone for Pat", () => (patSocket.state?.tokens[run.g2] ? null : true));
      await tapSearch(page);
      await settle(page);
      assert.ok(!(await rowIds(page)).includes(`token:${run.g2}`), "a token hidden since is not shown");
      await page.keyboard.press("Escape");
    } finally {
      await ops.send({ t: "token.update", tokenId: run.g2, patch: { visibility: "all" } });
      await page.close();
    }
  });

  test("se-22. the built DM chunk holds the DM's words and none of everyone's, and no script Pat's page was sent holds a word only the DM's catalog has", async () => {
    const dir = path.join(ROOT, "dist", "assets");
    const scripts = readdirSync(dir).filter((f) => f.endsWith(".js"));
    const dmFiles = scripts.filter((f) => /^dm-[^.]+\.js$/.test(f));
    assert.equal(dmFiles.length, 1, `one DM catalog chunk: ${dmFiles.join(" ")}`);
    const dmChunk = readFileSync(path.join(dir, dmFiles[0]!), "utf8");
    const others = scripts.filter((f) => f !== dmFiles[0]).map((f) => readFileSync(path.join(dir, f), "utf8"));
    // The DM catalog's own words: its entries' other names and best bets that no other script holds.
    const words = [...new Set([...DM_CATALOG.entries, ...DM_CATALOG.fields].flatMap((e) => [...(e.names ?? []), ...(e.bets ?? [])]))];
    const own = words.filter((w) => dmChunk.includes(w) && !others.some((o) => o.includes(w)));
    assert.ok(own.length >= 30, `the DM chunk holds the catalog's own words: ${own.length} of ${words.length}`);
    // Everyone's entries ship in the room's chunk, never in the DM's: their anchors, and the index's own.
    for (const e of EVERYONE.entries) {
      const anchor = e.act.route?.anchor ?? e.id;
      assert.ok(!dmChunk.includes(`"${anchor}"`), `everyone's ${anchor} is in the DM chunk`);
    }
    assert.ok(!dmChunk.includes("sound.playlist.play"), "the index is not in the DM chunk");
    // Pat's page was sent none of them.
    assert.ok(patLoads.scripts.size > 5, "se-20 kept Pat's scripts");
    for (const [url, body] of patLoads.scripts) {
      const text = await body;
      const leaked = own.filter((w) => text.includes(w));
      assert.deepEqual(leaked, [], `${url} holds the DM's words`);
    }
  });

  test("se-23. no page logged an error", () => {
    for (const w of watches) assert.deepEqual(w.errors, [], `${w.label} logged errors`);
  });
});
