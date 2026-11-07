import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, OpSocket, Shots, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { addSound, roomSoundScript } from "./soundRoom.ts";

/**
 * The room search's sweep (designs/qol/search.md 5.10, the test that keeps
 * it current), on the real server serving the production build with
 * ROOM_SOUND on:
 * - se-s1 and se-s2: as the DM and as a player at a desk, every surface the
 *   search catalogs opened, every fold unfolded, and each fold header,
 *   switch, checkbox, radio group, select, slider and labeled field there
 *   carrying a `data-search` anchor, on it or on its group, short of the
 *   rows that are the room's own things, and each anchor drawn there
 *   routed to by an entry, so an entry dropped fails.
 * - se-s3 to se-s6: every entry of the catalogs and every field of a
 *   creature, as the DM in a room at rest and in a fight, and as a player,
 *   each at a desk and on a phone: its title typed finds it among the first
 *   three, Enter lands focus on its control in view, and a section's
 *   heading still leads with its title, so a heading renamed without its
 *   entry fails. An action goes there by Shift+Enter, which presses
 *   nothing, and a DM menu item goes to its twin. Each entry lands in at
 *   least one of the room's states.
 * - se-s7: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-six. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

/**
 * What the sweep reads of the search (client/features/search), loaded by a
 * path the typecheck does not follow: the server's typecheck, which these
 * files are part of, has no DOM types for the client code the catalogs
 * import.
 */
type CatalogRoute = { panel: string; anchor?: string; press?: boolean };
type CatalogEntry = { id: string; kind: string; title: string; act: { t: string; route?: CatalogRoute } };
type FieldDef = { key: string; kind?: "section"; title: string; everyCharacter?: true; token?: { anchor: string }; page?: { anchor: string } };
type Catalog = { entries: readonly CatalogEntry[]; fields: readonly FieldDef[] };
const SEARCH_DIR = "../client/features/search";
const { DM_CATALOG, dmMenuViewOf, TWINS } = (await import(`${SEARCH_DIR}/catalog/dm.ts`)) as {
  DM_CATALOG: Catalog;
  dmMenuViewOf(state: { view: null; sceneId: null }): unknown;
  TWINS: Record<string, (view: unknown) => CatalogRoute>;
};
const { EVERYONE } = (await import(`${SEARCH_DIR}/catalog/everyone.ts`)) as { EVERYONE: Catalog };
const { VIEW_ANCHORS } = (await import(`${SEARCH_DIR}/index.ts`)) as { VIEW_ANCHORS: readonly string[] };

const PORT = Number(process.env.E2E_PORT ?? 3100) + 56;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-search-sweep-"));
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
/** Ctrl, not Cmd, takes the search's key here, on a Mac as on a Linux runner (lib/device.ts isAppleDevice). */
const WINDOWS = "Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' });";

let server: Server;
let browser: Browser;
let desk: BrowserContext;
let dm: Page;
let ops: OpSocket;
let patContext: BrowserContext;
const dmSocket = new SocketWatch("dm");
const watches: ConsoleWatch[] = [];

const run = {
  roomId: "",
  roomName: `E2E search sweep ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  dmKey: "",
  mat: "",
  cave: randomUUID(),
  day: randomUUID(),
  night: randomUUID(),
  bree: randomUUID(),
  thorn: randomUUID(),
  tBree: randomUUID(),
  goblin: randomUUID(),
  drums: randomUUID(),
  song: randomUUID(),
  letter: "",
  shown: randomUUID(),
  patId: "",
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

// ---------------------------------------------------------------- the snapshot budget

/**
 * The server counts each snapshot it builds, a page's load and a DM's look
 * at another scene alike, against its session and its IP: 20 a minute a
 * session and 40 an IP (server/rooms/budgets.ts). A session over for 30 s
 * has its sockets closed as abuse, so each is noted as it is asked for and
 * a step waits out the window rather than run over.
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

/** A context signed in as the DM by the DM link, on a session of its own. */
async function dmContext(options: Parameters<Browser["newContext"]>[0]): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.addInitScript(WINDOWS);
  const res = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/dm`, { headers: { Origin: server.origin }, data: { key: run.dmKey, memberId: dmSocket.you?.memberId } });
  assert.ok(res.ok(), `the DM link answered ${res.status()}`);
  sessions.set(context, randomUUID());
  return context;
}

// ---------------------------------------------------------------- the room

async function upload(kind: "handout" | "map", color: { r: number; g: number; b: number }, size = { w: 60, h: 80 }): Promise<string> {
  const data = await sharp({ create: { width: size.w, height: size.h, channels: 3, background: color } }).png().toBuffer();
  const res = await desk.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the ${kind} upload answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A room where every catalog entry the room's state gates has its state at
 * rest: a scene in view with party vision and two map phases, chosen
 * players who move any token and draw, characters for both, a selected
 * goblin, music playing from a playlist, and a handout showing. A fight,
 * a clock and a blackout come later (se-s4).
 */
async function createRoom(): Promise<void> {
  await spend(desk);
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
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();
  await waitFor("the DM's snapshot", () => dmSocket.state);
  const cookie = (await desk.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  await spend(desk);
  ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

  run.mat = dmSocket.state!.meta.playerSceneId!;
  await ops.send({ t: "scene.update", sceneId: run.mat, patch: { name: "Battle mat", bounds: { w: 20, h: 14 }, vision: { on: true, light: "bright" } } });
  await ops.send({ t: "scene.create", scene: { id: run.cave, name: "Goblin cave", bounds: { w: 20, h: 14 }, fogEnabled: false } });
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#3e63dd" } });
  run.patId = ((await done.json()) as { member: { id: string } }).member.id;
  await ops.send({ t: "room.update", settings: { playersMoveAny: [run.patId], playersDraw: [run.patId] } });
  await ops.send({ t: "character.create", character: { id: run.bree, name: "Bree", size: "medium", ownerIds: [run.patId], actor: actor({ senses: "Darkvision 60 ft." }) } });
  await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [], actor: actor() } });
  await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.mat, name: "Goblin", kind: "monster", x: 6, y: 6, size: "medium", visibility: "all", ownerIds: [], actor: { inline: actor() } } });
  await ops.send({ t: "token.create", token: { id: run.tBree, sceneId: run.mat, name: "Bree", kind: "pc", x: 4, y: 4, size: "medium", visibility: "all", ownerIds: [run.patId], actor: { ref: run.bree } } });
  await addSound({ context: desk, origin: server.origin, roomId: run.roomId, ops, id: run.song, name: "Tavern song", use: "music", ms: 31_000 });
  await ops.send({ t: "playlist.create", id: run.drums, name: "Goblin war drums", sounds: [run.song], repeat: "all", fade: 0 });
  await ops.send({ t: "music.play", run: randomUUID(), playlistId: run.drums, order: [run.song], index: 0, repeat: "all", fade: 0 });
  const day = await upload("map", { r: 200, g: 190, b: 160 }, { w: 200, h: 140 });
  const night = await upload("map", { r: 30, g: 30, b: 60 }, { w: 200, h: 140 });
  await ops.send({ t: "scene.setMap", sceneId: run.mat, map: { assetId: day, widthPx: 200, heightPx: 140, cellPx: 10, originPx: { x: 0, y: 0 } } });
  await ops.send({
    t: "scene.update",
    sceneId: run.mat,
    patch: {
      phases: [
        { id: run.day, name: "Daylight", assetId: day, widthPx: 200, heightPx: 140 },
        { id: run.night, name: "Moonlit", assetId: night, widthPx: 200, heightPx: 140 },
      ],
    },
  });
  run.letter = await upload("handout", { r: 120, g: 80, b: 40 });
  await ops.send({ t: "handout.show", handout: { id: run.shown, assetId: run.letter, title: "Belak's letter", to: "all" } });
  await waitFor("the room in the DM's copy", () => (dmSocket.state?.handouts[run.shown] && dmSocket.state.playing?.music ? true : null));
}

// ---------------------------------------------------------------- pages

/** The few shapes of the DOM the code run in a page reads, since the e2e files compile without the DOM's types. */
type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };
type DomEl = {
  tagName: string;
  textContent: string | null;
  checked?: boolean;
  type?: string;
  id: string;
  parentElement: DomEl | null;
  scrollHeight: number;
  clientHeight: number;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): DomEl | null;
  matches(selector: string): boolean;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): Iterable<DomEl>;
  getBoundingClientRect(): Box;
  contains(other: DomEl | null): boolean;
  ownerDocument: { activeElement: DomEl | null; body: DomEl; querySelector(selector: string): DomEl | null; defaultView: { innerWidth: number; innerHeight: number; getComputedStyle(el: DomEl): { overflowY: string; visibility: string; display: string } } };
};

async function openRoom(page: Page): Promise<void> {
  await spend(page.context());
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator("[data-rvtt-topbar]").first().waitFor();
}

function watchConsole(page: Page, label: string): ConsoleWatch {
  const watch = new ConsoleWatch(label);
  watch.attach(page);
  watches.push(watch);
  return watch;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raf = (globalThis as unknown as { requestAnimationFrame(cb: () => void): void }).requestAnimationFrame;
    return new Promise((resolve) => raf(() => raf(() => resolve(null))));
  });
}

const sheet = (page: Page) => page.locator("dialog[data-search-sheet]");
const field = (page: Page) => page.locator("[data-search-field]");

async function rowIds(page: Page): Promise<string[]> {
  return page.locator("[data-search-row]").evaluateAll((els) => els.map((e) => (e as unknown as DomEl).getAttribute("data-search-row") ?? ""));
}

async function openSearch(page: Page): Promise<void> {
  if ((await sheet(page).count()) === 0) {
    // A landing on a select box leaves focus there, where Ctrl+K opens nothing today: search.e2e.ts se-3 holds that case, so the sweep steps out of it.
    await page.locator(":root").evaluate((node) => {
      const active = (node as unknown as DomEl).ownerDocument.activeElement as (DomEl & { blur(): void }) | null;
      if (active?.tagName === "SELECT") active.blur();
    });
    await page.keyboard.press("Control+k");
  }
  await sheet(page).waitFor();
}

/** What has focus: the anchor it is or sits in, the panel's pane or sheet it sits in, a tab's name, and whether it is in view. */
type Focus = { anchor: string | null; heading: string | null; pane: string | null; sheet: string | null; tab: string | null; name: string; inView: boolean };

function focused(page: Page): Promise<Focus | null> {
  return page.locator(":root").evaluate((node) => {
    const doc = (node as unknown as DomEl).ownerDocument;
    const el = doc.activeElement;
    if (!el || el === doc.body) return null;
    const anchored = el.closest("[data-search]");
    // In view: inside the window and inside each scroller it sits in.
    const r = (anchored ?? el).getBoundingClientRect();
    const win = doc.defaultView;
    let inView = r.height > 0 && r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth;
    for (let box = (anchored ?? el).parentElement; box && inView; box = box.parentElement) {
      if (box.scrollHeight <= box.clientHeight + 1 || !/auto|scroll/.test(win.getComputedStyle(box).overflowY)) continue;
      const b = box.getBoundingClientRect();
      inView = r.bottom > b.top && r.top < b.bottom;
    }
    return {
      anchor: anchored?.getAttribute("data-search") ?? null,
      // A section's anchor is its header's heading, whose words lead with its name, then any summary it carries.
      heading: anchored?.matches('h1, h2, h3, h4, h5, h6, [role="heading"]') ? (anchored.textContent ?? "").trim() : null,
      pane: el.closest("[data-pane-panel]")?.getAttribute("data-pane-panel") ?? null,
      sheet: el.closest("dialog[data-rvtt-sheet]")?.getAttribute("aria-label") ?? null,
      tab: el.getAttribute("role") === "tab" ? (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() : null,
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60),
      inView,
    };
  });
}

// ---------------------------------------------------------------- the entries

/** One entry the sweep finds and lands: its row's id, the words typed, and where Enter must put focus. */
type Case = {
  id: string;
  typed: string;
  /** The entry's title, which a section's heading must still lead with. */
  title: string;
  /** A section, which lands on its header's heading. */
  section?: boolean;
  /** The `data-search` id focus lands on, or null for a page with no control of its own, where the panel takes focus. */
  anchor: string | null;
  /** Its panel's id and title, for a landing on the panel. */
  panel: string;
  /** Shift+Enter: an action that would press its control, and a DM menu item, which goes to its twin. */
  only: boolean;
};

/** The panels' titles, as their tabs and sheets name them (features/panels.ts). */
const PANEL_TITLES: Record<string, string> = { token: "Token", tracker: "Initiative", dice: "Dice", scenes: "Scenes", library: "Library", log: "Log", journal: "Journal", characters: "Characters", monsters: "Monsters", dm: "DM", menu: "Menu", sound: "Sound", time: "Time" };

/** The catalogs' sections, settings and actions for a role, each a case. Which hold in a room's state now is the search's to say. */
function catalogCases(catalogs: readonly Catalog[]): Case[] {
  return catalogs.flatMap((c) =>
    c.entries.flatMap((e): Case[] => {
      const route = e.act.t === "open" ? e.act.route : undefined;
      if (!route) return [];
      return [{ id: e.id, typed: e.title, title: e.title, section: e.kind === "section", anchor: route.anchor ?? null, panel: route.panel, only: route.press === true }];
    }),
  );
}

/** A creature's fields as the index makes them (search/index.ts): the selected token's, and each character's the role finds. */
function fieldCases(catalogs: readonly Catalog[], role: "dm" | "player", selected: { id: string; name: string } | null): Case[] {
  const fields = catalogs.flatMap((c) => c.fields);
  const out: Case[] = [];
  if (selected) {
    for (const f of fields) if (f.token) out.push({ id: `field:token:${selected.id}:${f.key}`, typed: `${f.title} ${selected.name}`, title: f.title, section: f.kind === "section", anchor: f.token.anchor, panel: "token", only: false });
  }
  const characters = role === "dm" ? [{ id: run.bree, name: "Bree" }, { id: run.thorn, name: "Thorn" }] : [{ id: run.bree, name: "Bree" }];
  for (const ch of characters) {
    for (const f of fields) {
      if (!f.page || (role === "dm" && !f.everyCharacter)) continue;
      out.push({ id: `field:character:${ch.id}:${f.key}`, typed: `${f.title} ${ch.name}`, title: f.title, section: f.kind === "section", anchor: f.page.anchor, panel: "characters", only: false });
    }
  }
  return out;
}

/** The DM menu's items the room's state offers now, each going to its twin by Shift+Enter (catalog/dm.ts TWINS). */
function itemCases(state: "rest" | "fight"): Case[] {
  const shown = run.shown;
  const viewAs: Case = { id: `item:viewAs:${run.patId}`, typed: "View as Pat", title: "View as Pat", anchor: "dm.preview.view-as", panel: "dm", only: true };
  const handout: Case = { id: "item:showHandout", typed: "Show a handout", title: "Show a handout", anchor: "dm.handouts.show", panel: "dm", only: true };
  const follow: Case = { id: "item:follow", typed: "Follow me", title: "Follow me", anchor: "dm.screens.follow", panel: "dm", only: true };
  if (state === "rest") {
    return [
      { id: "item:blackout", typed: "Black out players' screens", title: "Black out players' screens", anchor: "dm.screens.blackout", panel: "dm", only: true },
      follow,
      { id: "item:bringEveryone", typed: "Bring everyone here", title: "Bring everyone here", anchor: "dm.screens.bring", panel: "dm", only: true },
      { id: `item:hide:${shown}`, typed: "Hide Belak's letter", title: "Hide Belak's letter", anchor: "dm.handouts", panel: "dm", only: true },
      { id: `item:phase:${run.night}`, typed: "Moonlit", title: "Moonlit", anchor: "scenes.map.phases", panel: "scenes", only: true },
      handout,
      viewAs,
    ];
  }
  return [
    { id: "item:endBlackout", typed: "End the blackout", title: "End the blackout", anchor: "dm.screens.blackout", panel: "dm", only: true },
    // A move's twin is the scene's row in Scenes, which the route marks rather than anchors.
    { id: "item:showPlayers", typed: "Show players Goblin cave", title: "Show players Goblin cave", anchor: null, panel: "scenes", only: true },
    { id: "item:movePlayers", typed: "Move players here", title: "Move players here", anchor: null, panel: "scenes", only: true },
    { id: `item:recent:image:${run.letter}`, typed: "Show Belak's letter", title: "Show Belak's letter", anchor: "dm.handouts.recent", panel: "dm", only: true },
    follow,
    handout,
    viewAs,
  ];
}

/** What a landing found, for the run's report: one line for each case that did not land. */
type Outcome = { landed: Set<string>; offered: Set<string>; problems: string[] };

function newOutcome(): Outcome {
  return { landed: new Set(), offered: new Set(), problems: [] };
}

/** Entries no room offers at a size, each with its reason. */
const NOT_OFFERED_HERE: { desk: ReadonlyMap<string, string>; phone: ReadonlyMap<string, string> } = {
  desk: new Map(),
  phone: new Map([
    ["section:menu.this-device.tab-row", "the side panel's row of tabs is a wide screen's alone"],
    ["setting:menu.this-device.tab-row.panels", "the side panel's row of tabs is a wide screen's alone"],
  ]),
};

/**
 * Types each case's words, and when the search offers it, checks it is
 * among the first three rows and that Enter, or Shift+Enter, lands focus
 * on its control in view, or on its panel for a page with none. A case the
 * search does not offer in this state is left for another.
 */
async function land(page: Page, cases: readonly Case[], where: string, out: Outcome): Promise<void> {
  for (const c of cases) {
    await openSearch(page);
    await field(page).fill(c.typed);
    await settle(page);
    let ids = await rowIds(page);
    if (!ids.includes(c.id)) {
      await sleep(250);
      ids = await rowIds(page);
    }
    const at = ids.indexOf(c.id);
    if (at < 0) continue;
    out.offered.add(c.id);
    if (at > 2) {
      out.problems.push(`${where}: "${c.typed}" lists ${c.id} at ${at + 1}, after ${ids.slice(0, 3).join(", ")}`);
      continue;
    }
    for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press(c.only ? "Shift+Enter" : "Enter");
    const landed = await waitFor(
      `${c.id} landed`,
      async () => {
        const f = await focused(page);
        if (!f) return null;
        if (c.anchor !== null) return f.anchor === c.anchor ? f : null;
        // A page with no control of its own: the panel takes focus, its tab at a desk, its sheet on a phone.
        return f.tab?.startsWith(PANEL_TITLES[c.panel] ?? "?") || f.sheet === PANEL_TITLES[c.panel] || f.pane === c.panel ? f : null;
      },
      6_000,
    ).catch(() => null);
    if (!landed) {
      out.problems.push(`${where}: ${c.id} ("${c.typed}") did not land on ${c.anchor ?? `the ${c.panel} panel`}: focus is on ${JSON.stringify(await focused(page))}`);
      await shots.take(page, `se-sweep-missed-${c.id.replace(/[^a-z0-9.-]+/gi, "-").slice(0, 60)}`);
      await page.keyboard.press("Escape");
      continue;
    }
    if (!landed.inView) {
      out.problems.push(`${where}: ${c.id} landed on ${c.anchor} out of view`);
      continue;
    }
    // A heading renamed without its entry: the search would still land, under words the DM no longer sees.
    if (c.section && landed.heading !== null && !landed.heading.startsWith(c.title)) {
      out.problems.push(`${where}: ${c.id} is titled "${c.title}", but its heading reads "${landed.heading.slice(0, 60)}"`);
      continue;
    }
    out.landed.add(c.id);
  }
  if ((await sheet(page).count()) > 0) await page.keyboard.press("Escape");
}

// ---------------------------------------------------------------- the anchors

/** The surfaces the search catalogs (search.md 4), each opened by its own entry. */
/** `ready` is what shows once the panel's code is in, an anchor unless it draws none. */
type Surface = { name: string; open: Case; panel: string; ready?: string };

const dmSurfaces = (): Surface[] => [
  { name: "the DM panel", panel: "dm", open: { id: "panel:dm", typed: "DM", title: "DM", anchor: null, panel: "dm", only: false } },
  { name: "This device", panel: "menu", open: { id: "section:menu.this-device", typed: "This device", title: "This device", anchor: null, panel: "menu", only: false } },
  { name: "Room settings", panel: "menu", open: { id: "section:menu.room-settings", typed: "Room settings", title: "Room settings", anchor: null, panel: "menu", only: false } },
  { name: "Members", panel: "menu", open: { id: "section:menu.members", typed: "Members", title: "Members", anchor: null, panel: "menu", only: false } },
  { name: "Scenes", panel: "scenes", open: { id: "panel:scenes", typed: "Scenes", title: "Scenes", anchor: null, panel: "scenes", only: false } },
  { name: "Time", panel: "time", open: { id: "panel:time", typed: "Time", title: "Time", anchor: null, panel: "time", only: false } },
  { name: "Sound's Now playing", panel: "sound", open: { id: "section:sound.now", typed: "Now playing", title: "Now playing", anchor: null, panel: "sound", only: false } },
  { name: "Sound's Library", panel: "sound", open: { id: "section:sound.library", typed: "Library", title: "Library", anchor: null, panel: "sound", only: false } },
  { name: "Initiative", panel: "tracker", open: { id: "panel:tracker", typed: "Initiative", title: "Initiative", anchor: null, panel: "tracker", only: false } },
  { name: "Characters", panel: "characters", open: { id: "panel:characters", typed: "Characters", title: "Characters", anchor: null, panel: "characters", only: false } },
  { name: "Bree's page", panel: "characters", open: { id: `character:${run.bree}`, typed: "Bree", title: "Bree", anchor: null, panel: "characters", only: false } },
  { name: "Dice", panel: "dice", open: { id: "panel:dice", typed: "Dice", title: "Dice", anchor: null, panel: "dice", only: false } },
  { name: "the token panel", panel: "token", open: { id: "panel:token", typed: "Token", title: "Token", anchor: null, panel: "token", only: false } },
  { name: "the Log", panel: "log", open: { id: "panel:log", typed: "Log", title: "Log", anchor: null, panel: "log", only: false } },
];

/** A player's Initiative draws no anchor: its one setting, Turn sound, is This device's row. */
const playerSurfaces = (): Surface[] =>
  dmSurfaces()
    .filter((s) => ["This device", "Members", "Initiative", "Bree's page", "Dice", "the token panel", "the Log"].includes(s.name))
    .map((s) => (s.name === "Initiative" ? { ...s, ready: '[role="switch"]' } : s));

/**
 * Every control on a surface with no anchor on it or its group: the
 * surface's folds opened first, as a DM's taps would, each pass opening
 * what the last showed.
 */
async function unanchored(page: Page, surface: Surface): Promise<string[]> {
  const pane = page.locator(`[data-pane-panel="${surface.panel}"]`);
  await pane.waitFor();
  for (let pass = 0; pass < 4; pass++) {
    const folds = pane.locator(':is(h2, h3, h4, [role="heading"]) button[aria-expanded="false"]');
    const n = await folds.count();
    if (n === 0) break;
    for (let i = n - 1; i >= 0; i--) await folds.nth(i).click({ timeout: 2_000 }).catch(() => {});
    await settle(page);
  }
  return pane.evaluate((node) => {
    const root = node as unknown as DomEl;
    const win = root.ownerDocument.defaultView;
    const shown = (el: DomEl) => {
      const r = el.getBoundingClientRect();
      const style = win.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden";
    };
    const nameOf = (el: DomEl): string => {
      const label = el.getAttribute("aria-label") ?? (el.id ? root.ownerDocument.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.closest("label")?.textContent ?? el.textContent ?? "";
      return label.trim().replace(/\s+/g, " ").slice(0, 50);
    };
    // Its group: a Group or Section of the kit whose own header carries the anchor (components/Panel.tsx), where the search lands for the rows in it.
    const BOX = "section, [data-panel-group]";
    const inAnchoredBox = (el: DomEl): boolean => {
      for (let box = el.closest(BOX); box && root.contains(box); box = box.parentElement?.closest(BOX) ?? null) {
        for (const head of box.querySelectorAll('[data-search]:is(h1, h2, h3, h4, h5, h6, [role="heading"])')) if (head.closest(BOX) === box) return true;
      }
      return false;
    };
    const groupOf = (el: DomEl): string => (el.closest("[data-panel-group]")?.querySelector("h3, h4")?.textContent ?? "").trim().slice(0, 30);
    const kinds: [string, string][] = [
      ["fold", ':is(h2, h3, h4, [role="heading"]) button[aria-expanded]'],
      ["switch", '[role="switch"]'],
      ["checkbox", 'input[type="checkbox"], [role="checkbox"]'],
      ["radio group", '[role="radiogroup"], fieldset:has(input[type="radio"])'],
      ["radio", 'input[type="radio"]'],
      ["select", "select"],
      ["slider", 'input[type="range"], [role="slider"]'],
      ["field", 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]):not([type="file"]):not([type="color"]), textarea'],
    ];
    const out: string[] = [];
    const seen = new Set<DomEl>();
    for (const [kind, selector] of kinds) {
      for (const el of root.querySelectorAll(selector)) {
        if (seen.has(el) || !shown(el)) continue;
        seen.add(el);
        const anchor = el.closest("[data-search]");
        if (anchor && root.contains(anchor)) continue;
        // A radio in a group is the group's: the group is checked as one, anchored as a whole or option by option.
        if (kind === "radio" && el.closest('[role="radiogroup"], fieldset')) continue;
        if (kind === "radio group" && el.querySelector("[data-search]")) continue;
        if (inAnchoredBox(el)) continue;
        const own = el.closest("[data-search-own]")?.getAttribute("data-search-own") ?? null;
        out.push(`${kind} "${nameOf(el)}" in ${groupOf(el) || "the panel"}${own ? ` (${own})` : ""}`);
      }
    }
    return out;
  });
}

/**
 * Controls on the catalogued surfaces that carry no anchor by design, each
 * with its reason: a part of the room's own things, or a row another
 * surface's entry stands for. The surface's name, then the line
 * `unanchored` writes.
 */
const NOT_ANCHORED: readonly { surface: string; line: RegExp; why: string }[] = [
  { surface: "Sound's Now playing", line: /^radio group "Sound"/, why: "Sound's view row, whose two views are the Now playing and Library entries" },
  { surface: "Sound's Library", line: /^radio group "Sound"/, why: "Sound's view row, whose two views are the Now playing and Library entries" },
  { surface: "Sound's Library", line: /^field "Search music"/, why: "Library's own search, over the room's tracks" },
  { surface: "Sound's Now playing", line: /^slider "Seek"/, why: "the playing track's place, the room's own" },
  { surface: "Sound's Now playing", line: /^(switch "Room sound|slider "(Music|Background|Effects)")/, why: "this device's room sound, whose rows are This device's Sounds (S2a)" },
  { surface: "Initiative", line: /^switch "Turn sound/, why: "This device's Turn sound is its one row (D-261106-330)" },
  { surface: "Dice", line: /^field "Bonus"/, why: "the shown creature's card, where one with no stat block types its bonus" },
];

/**
 * Controls still waiting for an entry, as lane S2b left them: the Start
 * the clock form's own controls, which Start the clock goes to as a whole.
 */
const NOT_PLACED_YET: readonly { surface: string; line: RegExp; why: string }[] = [
  { surface: "Time", line: /^(switch "Players see the date and time|radio group "Calendar|field "(Day|Time)")/, why: "StartClock's form, an open item of S2b's" },
];

function leftOut(surface: Surface, line: string): boolean {
  return [...NOT_ANCHORED, ...NOT_PLACED_YET].some((n) => n.surface === surface.name && n.line.test(line));
}

/**
 * Every anchor an entry, a field, a DM menu item's twin or a record's row
 * routes to. An anchor drawn on a surface that none of these knows is a
 * control whose entry was dropped: the search no longer finds it.
 */
function knownAnchors(): Set<string> {
  const known = new Set<string>(VIEW_ANCHORS);
  for (const c of [EVERYONE, DM_CATALOG]) {
    for (const e of c.entries) if (e.act.t === "open" && e.act.route?.anchor) known.add(e.act.route.anchor);
    for (const f of c.fields) for (const place of [f.token, f.page]) if (place) known.add(place.anchor);
  }
  const view = dmMenuViewOf({ view: null, sceneId: null });
  for (const twin of Object.values(TWINS)) {
    const anchor = twin(view).anchor;
    if (anchor) known.add(anchor);
  }
  // A player's X-card item goes to Menu's own (catalog/everyone.ts youItems).
  known.add("menu.xcard");
  return known;
}

/** The anchors drawn on a surface that no entry routes to. */
async function unknownAnchors(page: Page, surface: Surface): Promise<string[]> {
  const known = knownAnchors();
  const drawn = await page.locator(`[data-pane-panel="${surface.panel}"] [data-search]`).evaluateAll((els) => els.map((e) => (e as unknown as DomEl).getAttribute("data-search") ?? ""));
  return [...new Set(drawn)].filter((a) => !known.has(a)).map((a) => `anchor ${a} is drawn, but no entry goes to it`);
}

/** Opens a surface by its entry, as the search does, and waits for its panel. */
async function openSurface(page: Page, surface: Surface): Promise<void> {
  const out: Outcome = { landed: new Set(), offered: new Set(), problems: [] };
  await land(page, [surface.open], surface.name, out);
  assert.deepEqual(out.problems, [], `${surface.name} opens`);
  assert.ok(out.landed.has(surface.open.id), `${surface.name}'s entry is offered`);
  // The panel's code may still be loading as its tab takes focus: every surface here draws an anchor once it is in.
  await page.locator(`[data-pane-panel="${surface.panel}"] ${surface.ready ?? "[data-search]"}`).first().waitFor();
  await settle(page);
}

describe("the room search's sweep", { concurrency: false }, () => {
  before(async () => {
    process.env.ROOM_SOUND = "1";
    // This device's Animated maps row shows only where the server plays them.
    process.env.ANIMATED_MAPS = "1";
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    desk = await browser.newContext(DESK);
    await desk.addInitScript(WINDOWS);
    sessions.set(desk, "desk");
    patContext = await browser.newContext(DESK);
    await patContext.addInitScript(WINDOWS);
    sessions.set(patContext, "pat");
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

  test("se-s1. as the DM at a desk, each control on every surface the search catalogs carries an anchor, and each anchor drawn there has an entry", async () => {
    await openRoom(dm);
    const missing: string[] = [];
    for (const surface of dmSurfaces()) {
      if (surface.panel === "token" || surface.panel === "dice") {
        // The goblin selected, so the token panel and Dice show a creature.
        const out: Outcome = { landed: new Set(), offered: new Set(), problems: [] };
        await land(dm, [{ id: `token:${run.goblin}`, typed: "Goblin", title: "Goblin", anchor: null, panel: "token", only: true }], "select", out);
      }
      await openSurface(dm, surface);
      for (const line of await unanchored(dm, surface)) if (!leftOut(surface, line)) missing.push(`${surface.name}: ${line}`);
      for (const line of await unknownAnchors(dm, surface)) missing.push(`${surface.name}: ${line}`);
    }
    assert.deepEqual(missing, [], "controls with no anchor on them or their group");
  });

  test("se-s2. as a player at a desk, each control on every surface the search catalogs for a player carries an anchor, and each anchor drawn there has an entry", async () => {
    const page = await patContext.newPage();
    watchConsole(page, "pat");
    try {
      await openRoom(page);
      const missing: string[] = [];
      for (const surface of playerSurfaces()) {
        if (surface.panel === "token") {
          const out: Outcome = { landed: new Set(), offered: new Set(), problems: [] };
          await land(page, [{ id: `token:${run.tBree}`, typed: "Bree", title: "Bree", anchor: null, panel: "token", only: true }], "select", out);
        }
        await openSurface(page, surface);
        for (const line of await unanchored(page, surface)) if (!leftOut(surface, line)) missing.push(`${surface.name}: ${line}`);
        for (const line of await unknownAnchors(page, surface)) missing.push(`${surface.name}: ${line}`);
      }
      assert.deepEqual(missing, [], "controls with no anchor on them or their group");
    } finally {
      await page.close();
    }
  });

  const dmCases = (state: "rest" | "fight") => [
    ...catalogCases([EVERYONE, DM_CATALOG]),
    ...fieldCases([EVERYONE, DM_CATALOG], "dm", state === "rest" ? { id: run.goblin, name: "Goblin" } : null),
    ...itemCases(state),
  ];
  const outcomes = { dmDesk: newOutcome(), dmPhone: newOutcome(), patDesk: newOutcome(), patPhone: newOutcome() };

  /** The DM's page on `options`, the goblin selected for the room at rest. */
  async function dmPage(options: Parameters<Browser["newContext"]>[0], label: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await dmContext(options);
    const page = await context.newPage();
    watchConsole(page, label);
    await openRoom(page);
    return { context, page };
  }

  async function select(page: Page, id: string, name: string): Promise<void> {
    const out = newOutcome();
    await land(page, [{ id: `token:${id}`, typed: name, title: name, anchor: null, panel: "token", only: true }], "select", out);
    assert.ok(out.landed.has(`token:${id}`), `${name} selected`);
  }

  test("se-s3. as the DM in a room at rest, every entry offered lands on its control, at a desk and on a phone", async () => {
    const from = [outcomes.dmDesk.problems.length, outcomes.dmPhone.problems.length];
    for (const [options, out, label] of [
      [DESK, outcomes.dmDesk, "desk"],
      [PHONE, outcomes.dmPhone, "phone"],
    ] as const) {
      const { context, page } = await dmPage(options, `dm-${label}-rest`);
      try {
        await select(page, run.goblin, "Goblin");
        await land(page, dmCases("rest"), `the DM's ${label} at rest`, out);
      } finally {
        await context.close();
      }
    }
    assert.deepEqual([...outcomes.dmDesk.problems.slice(from[0]), ...outcomes.dmPhone.problems.slice(from[1])], []);
  });

  test("se-s4. as the DM in a fight, with a clock running, a blackout on and the camera on another scene, every entry offered lands on its control, at a desk and on a phone", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.goblin, value: 15 }, { id: randomUUID(), tokenId: run.tBree, value: 12 }] });
    await ops.send({ t: "clock.start", id: randomUUID(), at: 8 * 3_600, shown: true, calendar: { kind: "days" } });
    await ops.send({ t: "view.blackout", blackout: true });
    await ops.send({ t: "handout.close", handoutId: run.shown });
    const recent = JSON.stringify([{ kind: "image", assetId: run.letter, title: "Belak's letter", to: "all", at: Date.now() }]);
    const from = [outcomes.dmDesk.problems.length, outcomes.dmPhone.problems.length];
    try {
      for (const [options, out, label] of [
        [DESK, outcomes.dmDesk, "desk"],
        [PHONE, outcomes.dmPhone, "phone"],
      ] as const) {
        const context = await dmContext(options);
        await context.addInitScript(([key, value]) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(key!, value!), [`rvtt.handoutsRecent.${run.roomId}`, recent]);
        const page = await context.newPage();
        watchConsole(page, `dm-${label}-fight`);
        try {
          await openRoom(page);
          // The camera on the cave, where the players are not: Show players and Move players here.
          const sceneOut = newOutcome();
          await land(page, [{ id: `scene:${run.cave}`, typed: "Goblin cave", title: "Goblin cave", anchor: null, panel: "scenes", only: false }], "the cave's row", sceneOut);
          const rowButton = page.locator(`[data-search-page="scene:${run.cave}"] button`).first();
          await rowButton.waitFor();
          await spend(context);
          await rowButton.click();
          await waitFor("the camera on the cave", async () => ((await page.locator(`[data-search-page="scene:${run.cave}"] [aria-current]`).count()) > 0 ? true : null));
          await land(page, dmCases("fight"), `the DM's ${label} in a fight`, out);
        } finally {
          await context.close();
        }
      }
    } finally {
      await ops.send({ t: "encounter.end" });
      await ops.send({ t: "clock.stop" });
      await ops.send({ t: "view.blackout", blackout: false });
      await ops.send({ t: "handout.show", handout: { id: run.shown, assetId: run.letter, title: "Belak's letter", to: "all" } });
    }
    assert.deepEqual([...outcomes.dmDesk.problems.slice(from[0]), ...outcomes.dmPhone.problems.slice(from[1])], []);
  });

  test("se-s5. as a player, every entry offered lands on its control, at a desk and on a phone", async () => {
    for (const [options, out, label] of [
      [DESK, outcomes.patDesk, "desk"],
      [PHONE, outcomes.patPhone, "phone"],
    ] as const) {
      const context = await browser.newContext(options);
      await context.addInitScript(WINDOWS);
      // Room sound on, so This device's three volumes show for Pat too.
      await context.addInitScript(roomSoundScript("on"));
      await context.addCookies(await patContext.cookies(server.origin));
      sessions.set(context, "pat");
      const page = await context.newPage();
      watchConsole(page, `pat-${label}`);
      try {
        await openRoom(page);
        await land(page, [...catalogCases([EVERYONE]), ...fieldCases([EVERYONE], "player", null), { id: "item:xcard", typed: "X-card", title: "X-card", anchor: "menu.xcard", panel: "menu", only: true }], `Pat's ${label}`, out);
      } finally {
        await context.close();
      }
    }
    assert.deepEqual([...outcomes.patDesk.problems, ...outcomes.patPhone.problems], []);
  });

  test("se-s6. each entry lands in one of the room's states, at a desk and on a phone, for each role that has it", () => {
    const missed: string[] = [];
    const want = (cases: readonly Case[], out: Outcome, where: string, leave: (c: Case) => boolean) => {
      for (const c of cases) if (!out.landed.has(c.id) && !leave(c)) missed.push(`${where}: ${c.id} ("${c.typed}")${out.offered.has(c.id) ? " offered but did not land" : " never offered"}`);
    };
    const dmAll = [...dmCases("rest"), ...dmCases("fight")].filter((c, i, all) => all.findIndex((d) => d.id === c.id) === i);
    const patAll = [...catalogCases([EVERYONE]), ...fieldCases([EVERYONE], "player", null)];
    want(dmAll, outcomes.dmDesk, "the DM at a desk", (c) => NOT_OFFERED_HERE.desk.has(c.id));
    want(dmAll, outcomes.dmPhone, "the DM on a phone", (c) => NOT_OFFERED_HERE.phone.has(c.id));
    want(patAll, outcomes.patDesk, "Pat at a desk", (c) => NOT_OFFERED_HERE.desk.has(c.id));
    want(patAll, outcomes.patPhone, "Pat on a phone", (c) => NOT_OFFERED_HERE.phone.has(c.id));
    assert.deepEqual(missed, []);
  });

  test("se-s7. no page logged an error", () => {
    for (const w of watches) assert.deepEqual(w.errors, [], `${w.label} logged errors`);
  });
});
