import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { LogEvent } from "#shared/model.ts";
import { ConsoleWatch, openPage, openSideTab, OpSocket, Shots, SocketWatch, startServer, tapCell, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * The combat flow (docs/design-v1-combat-flow.md section 8) on the real
 * server serving the production build: the tracker's round header that
 * sticks to the order, the tracker's order, AC in the rows, Revive where a
 * tap lands, healing the dead, and companions a player adds beside their
 * character, nested in the order, with their own Reaction.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus nine, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts). The full-screen modal sheet of the layout design is not
 * in this build, so at 480 x 320 the round header's form is checked
 * against the scroller it measures, whatever sheet holds it.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 9;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-combat-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1280, height: 800 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let anaContext: BrowserContext;
let ana: Page;
let cyContext: BrowserContext;
let cy: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const cySocket = new SocketWatch("cy");
const dmConsole = new ConsoleWatch("dm");
const anaConsole = new ConsoleWatch("ana");
const cyConsole = new ConsoleWatch("cy");

const run = {
  roomId: "",
  roomName: `E2E combat ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  otherSceneId: randomUUID(),
  anaId: "",
  cyId: "",
  bree: { id: randomUUID(), characterId: randomUUID() },
  cyPc: { id: randomUUID(), characterId: randomUUID() },
  goblins: Array.from({ length: 12 }, () => randomUUID()),
  chest: randomUUID(),
};

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

function actor(hp: number, ac = 15) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac,
    speeds: { walk: 30 },
    initBonus: 1,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

const goblinName = (i: number) => `Goblin ${i + 1}`;

/** Sets the window, the safe areas and the interface size, then loads the room again. */
async function setUp(page: Page, cdp: CDPSession, view: { width: number; height: number; scale: number; side?: number; bottom?: number }): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: view.bottom ?? 0, left: view.side ?? 0, right: view.side ?? 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  /*
   * A fresh load of the room's address rather than a reload: a page
   * reloaded with a sheet open finds the sheet's history entry on top and
   * steps back off it (lib/backClose.ts), which can land mid-navigation on
   * the page before the room.
   */
  await openPage(page, `${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Opens the tracker: the side panel's tab from 900 layout px up, else the turn strip's button that opens its sheet. */
async function openTracker(page: Page): Promise<Locator> {
  const tab = page.getByRole("tab", { name: "Initiative" });
  if ((await tab.count()) > 0 && (await tab.first().isVisible())) await tab.first().click();
  else await page.getByRole("button", { name: /^Initiative, round/ }).first().click();
  const header = page.locator("[data-round-header]");
  await header.first().waitFor();
  return page.locator("[data-round-section]").first();
}

type Measured = { scroller: Rect; header: Rect; sticky: boolean; row: Rect | null; compactRow: number };

/** The tracker's scroller, its round header, whether the header sticks, and the first whole row under it inside the scroller. */
function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    type El = { getBoundingClientRect(): Rect; closest(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; firstElementChild: El | null };
    const g = globalThis as unknown as { document: { querySelector(s: string): El | null }; getComputedStyle(e: El): { position: string } };
    const box = (e: El): Rect => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const header = g.document.querySelector("[data-round-header]")!;
    const scroller = header.closest("[data-pane-body]")!;
    const s = box(scroller);
    const h = box(header);
    const rows = Array.from(header.closest("[data-round-section]")!.querySelectorAll("ol > li")).map(box);
    const row = rows.find((r) => r.top >= h.bottom - 0.5 && r.bottom <= s.bottom + 0.5) ?? null;
    const inner = header.firstElementChild ? box(header.firstElementChild) : h;
    return { scroller: s, header: h, sticky: g.getComputedStyle(header).position === "sticky", row, compactRow: inner.height };
  });
}

type HeaderRoom = { form: string; scroller: number; header: number; compactHeader: number; row: number };

/**
 * The round header's form and what it is picked from, in the page's layout
 * px (client/features/encounter/logic.ts roundHeaderForm): the scroller's
 * height, the header's as drawn, the compact header's (the pane's top
 * padding, the 44 px row and the border) and a standard row's with its gap.
 */
function headerRoom(page: Page): Promise<HeaderRoom> {
  return page.evaluate((compactRow) => {
    type El = { offsetHeight: number; clientHeight: number; dataset: Record<string, string | undefined>; parentElement: El | null; closest(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
    const g = globalThis as unknown as { document: { querySelector(s: string): El | null }; getComputedStyle(e: El): { paddingTop: string; rowGap: string; borderBottomWidth: string } };
    const header = g.document.querySelector("[data-round-header]")!;
    const scroller = header.closest("[data-pane-body]")!;
    const rows = Array.from(header.closest("[data-round-section]")!.querySelectorAll("[data-standard-row]"));
    const order = rows[0]?.parentElement;
    const gap = order ? parseFloat(g.getComputedStyle(order).rowGap) || 0 : 0;
    const style = g.getComputedStyle(header);
    return {
      form: header.dataset.form ?? "",
      scroller: scroller.clientHeight,
      header: header.offsetHeight,
      compactHeader: parseFloat(style.paddingTop) + compactRow + parseFloat(style.borderBottomWidth),
      row: Math.min(...rows.map((r) => r.offsetHeight)) + gap,
    };
  }, 44);
}

/**
 * Scrolls the order through one whole standard row interval from `from`,
 * 2 px at a time, and fails at an offset where the stuck header leaves the
 * scroller's top or no whole row shows under it (docs/design-v1-combat-flow.md 3.1).
 */
async function sweepRowInterval(page: Page, from: number, label: string): Promise<void> {
  const { row } = await headerRoom(page);
  for (let d = 0; d <= Math.ceil(row); d += 2) {
    await scrollPane(page, from + d);
    const m = await measure(page);
    const at = `${label}, scrolled to ${from + d}`;
    assert.ok(m.sticky, `${at}: the header does not stick`);
    assert.ok(Math.abs(m.header.top - m.scroller.top) <= 1, `${at}: the header left the scroller's top: ${JSON.stringify({ header: m.header, scroller: m.scroller })}`);
    assert.ok(m.row, `${at}: no whole row under the stuck header: ${JSON.stringify({ header: m.header, scroller: m.scroller })}`);
  }
}

/**
 * The pane holding `inner` scrolls only down, and every control and line
 * of text in it lies within the pane's width: nothing runs out of it
 * sideways (SFB-P-1).
 */
async function fitsSideways(inner: Locator, label: string): Promise<void> {
  const wide = await inner.evaluate((el) => {
    type Box = { scrollWidth: number; clientWidth: number; tagName: string; textContent: string | null; getBoundingClientRect(): Rect; closest(s: string): Box | null; querySelectorAll(s: string): ArrayLike<Box>; getAttribute(n: string): string | null };
    const scroller = (el as unknown as Box).closest("[data-pane-body]")!;
    const pane = scroller.getBoundingClientRect();
    const out: string[] = [];
    if (scroller.scrollWidth > scroller.clientWidth + 1) out.push(`the pane scrolls sideways: ${scroller.scrollWidth} > ${scroller.clientWidth}`);
    for (const c of Array.from(scroller.querySelectorAll("select, input, button, p, h3, label"))) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && (r.left < pane.left - 1 || r.right > pane.right + 1)) {
        out.push(`${c.tagName} ${c.getAttribute("aria-label") ?? (c.textContent ?? "").slice(0, 30)}: ${Math.round(r.left)} to ${Math.round(r.right)}, the pane ${Math.round(pane.left)} to ${Math.round(pane.right)}`);
      }
    }
    return out;
  });
  assert.deepEqual(wide, [], `${label}: content runs out of the pane sideways`);
}

/**
 * The width a Select needs to show each of its choices whole, measured in
 * its own font with its padding, borders and Chrome's arrow of about
 * 20 px, and the width it has.
 */
function selectRoom(select: Locator): Promise<{ needs: { text: string; need: number }[]; has: number }> {
  return select.evaluate((el) => {
    type Styles = { font: string; paddingLeft: string; paddingRight: string; borderLeftWidth: string; borderRightWidth: string };
    type Probe = { style: Record<string, string>; textContent: string | null; getBoundingClientRect(): Rect; remove(): void };
    type Doc = { createElement(t: string): Probe; body: { append(n: Probe): void }; defaultView: { getComputedStyle(e: unknown): Styles } };
    const sel = el as unknown as { options: ArrayLike<{ text: string }>; getBoundingClientRect(): Rect; ownerDocument: Doc };
    const doc = sel.ownerDocument;
    const style = doc.defaultView.getComputedStyle(sel);
    const edges = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, v) => sum + parseFloat(v), 0);
    const needs = Array.from(sel.options, ({ text }) => {
      const probe = doc.createElement("span");
      Object.assign(probe.style, { font: style.font, whiteSpace: "pre", position: "absolute", visibility: "hidden" });
      probe.textContent = text;
      doc.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return { text, need: width + edges + 20 };
    });
    return { needs, has: sel.getBoundingClientRect().width };
  });
}

/** Fails on a Turn Select that would cut off one of its choices, chosen or not. */
async function turnShowsWhole(select: Locator, label: string): Promise<void> {
  const room = await selectRoom(select);
  assert.ok(room.needs.length >= 2, `${label}: the Select has ${room.needs.length} choices`);
  for (const { text, need } of room.needs) assert.ok(need <= room.has + 0.5, `${label}: "${text}" needs ${Math.round(need)} px and has ${Math.round(room.has)}`);
}

/** Opens a panel: its side panel tab from 900 layout px up, else from the toolbar's list of panels. */
async function openPanelOn(page: Page, title: string): Promise<void> {
  if (await page.getByRole("tablist", { name: "Panels" }).isVisible()) {
    await openSideTab(page, title);
    return;
  }
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`).waitFor();
}

function scrollPane(page: Page, to: number): Promise<void> {
  return page.evaluate((top) => {
    const g = globalThis as unknown as { document: { querySelector(s: string): { closest(s: string): { scrollTop: number } } } };
    g.document.querySelector("[data-round-header]").closest("[data-pane-body]").scrollTop = top;
  }, to);
}

/** The accessible description Chrome gives a button, read from its accessibility tree, with the spaces it puts before commas taken out. */
async function descriptions(cdp: CDPSession, name: RegExp): Promise<string[]> {
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { role?: { value: string }; name?: { value: string }; description?: { value: string } }[] };
  return nodes
    .filter((n) => n.role?.value === "button" && name.test(n.name?.value ?? ""))
    .map((n) => (n.description?.value ?? "").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim());
}

/** The tracker's section headings in order, as a screen reader moves between them. */
function headings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { document: { querySelector(s: string): { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } | null } };
    const panel = g.document.querySelector("[data-round-section]")!;
    const root = (panel as unknown as { parentElement: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).parentElement;
    return Array.from(root.querySelectorAll("h3")).map((h) => (h.textContent ?? "").trim());
  });
}

/** Opens one of the token panel's folds (docs/design-v1-token-panel.md 3.5), unless this device already keeps it open. */
async function openFold(panel: Locator, name: string): Promise<void> {
  const fold = panel.getByRole("button", { name, exact: true });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
}

function bar(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `${name} actions` });
}

async function rowButton(page: Page, name: string): Promise<Locator> {
  const b = page.getByRole("button", { name: new RegExp(`^${name}[.,]`) }).first();
  await b.waitFor();
  return b;
}

function goblinState(i: number) {
  const t = dmSocket.state?.tokens[run.goblins[i]!];
  return t && "inline" in t.actor ? t.actor.inline : undefined;
}

describe("raccoon-vtt: the combat flow", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    anaContext = await browser.newContext({ viewport: DESK });
    ana = await anaContext.newPage();
    anaConsole.attach(ana);
    await anaSocket.attach(anaContext, ana);
    cyContext = await browser.newContext({ viewport: DESK });
    cy = await cyContext.newPage();
    cyConsole.attach(cy);
    await cySocket.attach(cyContext, cy);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, anaConsole, cyConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").filter((l) => !/"request completed"|"incoming request"/.test(l)).slice(-80).join("\n"));
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

  test("1. a DM's room with Ana's Bree, Cy's own character, twelve goblins and a chest, in a fight of fourteen", async () => {
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
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    const join = async (context: BrowserContext, name: string, color: string) => {
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      return ((await done.json()) as { member: { id: string } }).member.id;
    };
    run.anaId = await join(anaContext, "Ana", "#30a46c");
    run.cyId = await join(cyContext, "Cy", "#e5484d");

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.create", scene: { id: run.otherSceneId, name: "The road", bounds: { w: 30, h: 20 } } });
    // New rooms let players create characters. Test 9 checks companions work without that.
    await ops.send({ t: "room.update", settings: { playersCreateCharacters: false } });
    await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [run.anaId], actor: actor(31, 16) } });
    await ops.send({ t: "character.create", character: { id: run.cyPc.characterId, name: "Cyra", size: "medium", ownerIds: [run.cyId], actor: actor(20, 14) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.bree.id, { kind: "pc", name: "Bree", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree.characterId } }));
    await ops.send(token(run.cyPc.id, { kind: "pc", name: "Cyra", x: 9, y: 5, disposition: "ally", actor: { ref: run.cyPc.characterId } }));
    for (const [i, id] of run.goblins.entries()) {
      await ops.send(token(id, { kind: "monster", name: goblinName(i), number: undefined, x: 12 + (i % 6), y: 2 + Math.floor(i / 6) * 2, disposition: "hostile", actor: { inline: actor(7) } }));
    }
    await ops.send(token(run.chest, { kind: "object", name: "Chest", x: 3, y: 12, hpVisibility: "hidden", actor: { inline: actor(10, 12) } }));
    // Fourteen rows: Bree first, Cyra, then the goblins, with distinct values so the order is fixed.
    const entries = [
      { id: "e-bree", tokenId: run.bree.id, value: 25 },
      { id: "e-cy", tokenId: run.cyPc.id, value: 24 },
      ...run.goblins.map((tokenId, i) => ({ id: `e-g${i}`, tokenId, value: 20 - i })),
    ];
    await ops.send({ t: "encounter.start", entries });
    await ops.send({ t: "encounter.next" });
    await waitFor("every row in the DM's view, Bree acting", () => (dmSocket.state?.encounter?.entries.length === 14 && dmSocket.state.encounter.activeEntryId === "e-bree" ? true : null));

    await ana.goto(`${server.origin}/r/${run.roomId}`);
    await ana.getByRole("status", { name: "Connected" }).first().waitFor();
    await cy.goto(`${server.origin}/r/${run.roomId}`);
    await cy.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("1b. the new room keeps every goblin's place out of Ana's order and frames before its turn, and Everyone shows her the whole order (docs/design-v1-combat-flow.md 11)", async () => {
    await waitFor("Ana's order of the party alone", () => (anaSocket.state?.encounter?.entries.length === 2 ? true : null));
    assert.deepEqual(anaSocket.state!.encounter!.entries.map((e) => e.id), ["e-bree", "e-cy"]);
    assert.equal(anaSocket.state!.encounter!.activeEntryId, "e-bree");
    for (const i of run.goblins.keys()) assert.equal(anaSocket.everSaw(`"e-g${i}"`), false, `goblin ${i + 1}'s row reached Ana`);
    // The rest of this file reads the whole order, as a room from before the setting does.
    await ops.send({ t: "room.update", settings: { playersSeeOrder: "all" } });
    await waitFor("Ana's whole order", () => (anaSocket.state?.encounter?.entries.length === 14 ? true : null));
    await waitFor("Cy's whole order", () => (cySocket.state?.encounter?.entries.length === 14 ? true : null));
  });

  test("2. the round header sticks while the order scrolls under it, one whole row always shows under it, and it leaves with the order's end", async () => {
    const sizes = [
      { width: 390, height: 844, scale: 1 },
      { width: 390, height: 844, scale: 1.3 },
      { width: 844, height: 390, scale: 1 },
      { width: 844, height: 390, scale: 1.3 },
      { width: 1280, height: 800, scale: 1 },
      { width: 1280, height: 800, scale: 1.3 },
      { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 },
    ];
    for (const view of sizes) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(dm, dmCdp, view);
      await openTracker(dm);
      await scrollPane(dm, 0);
      // The form follows the measured room: the header and two standard rows (client/features/encounter/logic.ts roundHeaderForm).
      const room = await headerRoom(dm);
      const scroller = room.scroller;
      const need = { full: room.header + 2 * room.row, compact: room.compactHeader + 2 * room.row };
      if (room.form === "full") assert.ok(scroller >= need.full, `${label}: a full header sticks in ${scroller} px, under its ${need.full}`);
      if (room.form === "compact") assert.ok(scroller >= need.compact, `${label}: a compact header sticks in ${scroller} px, under its ${need.compact}`);
      // A header that scrolls is drawn in full, so its height is the full one.
      if (room.form === "static") assert.ok(scroller < need.compact, `${label}: ${scroller} px holds a compact header (${need.compact}) and should stick`);
      // Scrolled into the list, through a whole row interval, the header keeps the scroller's top and a whole row shows under it.
      await scrollPane(dm, 220);
      const mid = await measure(dm);
      if (mid.sticky) {
        await sweepRowInterval(dm, 220, label);
        assert.ok(await wholeInReach(dm.locator("[data-round-header]").getByRole("button", { name: "Next" })), `${label}: Next does not take a tap at this scroll`);
      }
      if (view.width === 390 && view.scale === 1) {
        assert.ok(mid.sticky && mid.header.height >= 50, `${label}: a tall phone's header should be full and sticky`);
        await shots.take(dm, "combat-header-390-scrolled");
      }
      if (view.width === 1280 && view.scale === 1) {
        assert.ok(mid.sticky, `${label}: the side panel's header should stick`);
        await shots.take(dm, "combat-header-1280-scrolled");
      }
      if (view.width === 844 && view.scale === 1.3) {
        assert.equal(mid.sticky, false, `${label}: a ${scroller} px sheet has no room for a sticky header`);
        await shots.take(dm, "combat-header-844-130-static");
      }
      if (view.width === 480) await shots.take(dm, "combat-header-480-130");
    }
  });

  test("2b. at 480 x 320 at 130% the tracker opens as the very short sheet, its header sticky with a row's value box in reach under it, with the bar folded into the sheet's header or not", async () => {
    const view = { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 };
    const sheet = dm.locator('dialog[data-rvtt-sheet][aria-modal="true"]');
    // A value box focused deep in the order scrolls into view under the stuck header (its scroll margin), where a tap reaches it.
    const valueBoxInReach = async (row: number) => {
      const box = dm.locator("[data-round-section] ol > li").nth(row).getByRole("button", { name: /Initiative \d+/ });
      await box.focus();
      await dm.waitForTimeout(100);
      return wholeInReach(box);
    };
    await setUp(dm, dmCdp, view);
    await openTracker(dm);
    await sheet.waitFor();
    /*
     * The sheet's body is about 169 layout px, the full-screen dialog
     * drawing no border (docs/design-v1-layout-hierarchy.md 4.2). That
     * holds the compact header (49) and two standard rows (116), not the
     * full header (56) and two, so the header sticks as one compact row
     * (logic.ts roundHeaderForm).
     */
    const rest = await measure(dm);
    const body = (await headerRoom(dm)).scroller;
    assert.ok(body >= 166 && body <= 171, `the very short sheet's body is ${body} layout px, not about 169`);
    assert.ok(rest.sticky, "the header does not stick in the very short sheet");
    assert.equal((await headerRoom(dm)).form, "compact", "the very short sheet's header is the compact row");
    await scrollPane(dm, 220);
    await sweepRowInterval(dm, 220, "the very short sheet");
    for (const row of [5, 9]) assert.ok(await valueBoxInReach(row), `row ${row}'s value box is out of reach under the header`);
    assert.ok(await wholeInReach(dm.locator("[data-round-header]").getByRole("button", { name: "Next" })), "Next is out of reach");
    await shots.take(dm, "combat-header-480-130-very-short");
    /*
     * A tap on a row selects its creature and closes the sheet. Opened again,
     * the sheet's header holds the folded bar's button, and the round header
     * still sticks with the order in reach under it. The sheet's header
     * stacks only with the alerts' button beside it too
     * (docs/design-v1-layout-hierarchy.md 4.2), which layout.e2e.ts checks.
     */
    await dm.getByRole("button", { name: /^Goblin 3[.,]/ }).first().click();
    await bar(dm, "Goblin 3").waitFor();
    await openTracker(dm);
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Show Goblin 3 actions" }).waitFor();
    assert.ok((await measure(dm)).sticky, "the header does not stick with the bar's button in the sheet's header");
    // The bar's button alone does not stack the sheet's header (docs/design-v1-layout-hierarchy.md 4.2), so the body keeps room for the compact header.
    assert.equal((await headerRoom(dm)).form, "compact", "the bar's button took the compact header's room");
    assert.ok(await valueBoxInReach(7), "a value box is out of reach under the header");
    assert.ok(await wholeInReach(dm.locator("[data-round-header]").getByRole("button", { name: "Next" })), "Next is out of reach");
    await shots.take(dm, "combat-header-480-130-very-short-bar-folded");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
  });

  test("2c. in the very short sheet the DM's untied rows give the drag handle's slot to their names, which show whole, and the side panel keeps the slot (SFB-P-13)", async () => {
    const rowsOf = () =>
      dm.evaluate(() => {
        type El = { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null; scrollWidth: number; clientWidth: number; textContent: string | null };
        const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<El> } };
        return Array.from(g.document.querySelectorAll("[data-round-section] [data-entry-row]")).map((li) => {
          const slot = li.querySelector(":scope > div > [data-drag-slot]");
          const name = li.querySelector("[data-row-name]");
          return { tied: slot?.getAttribute("role") === "button", slot: slot !== null, name: name?.textContent ?? "", room: name ? name.clientWidth - name.scrollWidth : -1 };
        });
      });
    await setUp(dm, dmCdp, { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 });
    await openTracker(dm);
    const narrow = await rowsOf();
    assert.ok(narrow.some((r) => !r.tied), "no untied row to look at");
    for (const r of narrow.filter((row) => !row.tied)) {
      assert.equal(r.slot, false, `${r.name} keeps the empty slot in the very short sheet`);
      assert.ok(r.room >= 0, `${r.name} is cut off by ${-r.room} px`);
    }
    await shots.take(dm, "combat-very-short-rows");
    await dm.keyboard.press("Escape");
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openTracker(dm);
    for (const r of await rowsOf()) assert.equal(r.slot, true, `${r.name} lost the slot in the side panel`);
  });

  test("2d. at 480 x 320 at 130% a notice that comes and goes keeps the round header stuck and in its form: Ana's End turn stays in reach as Your turn arrives, and the DM's Next as a toast does (SFB-P-15, SFB-P-18)", async () => {
    const view = { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 };
    const modal = (page: Page) => page.locator('dialog[data-rvtt-sheet][aria-modal="true"]');
    /*
     * The header's form and the body it is picked from: the scroller plus
     * the room the passing notices take, counted as pages/modalSlot.tsx
     * passingNoticesPx counts it. Counting a gap that is not drawn turned
     * the compact header full for the seconds a notice showed. `need` is
     * what the form as drawn needs of the body: the header and two
     * standard rows.
     */
    const room = (page: Page) =>
      page.evaluate(() => {
        type El = { offsetHeight: number; clientHeight: number; dataset: Record<string, string | undefined>; parentElement: El | null; closest(s: string): El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
        const g = globalThis as unknown as { document: { querySelector(s: string): El | null }; getComputedStyle(e: El): { rowGap: string } };
        const header = g.document.querySelector("[data-round-header]")!;
        const notices = header.closest("dialog")!.querySelector("[data-rvtt-modal-notices]")!;
        const gap = parseFloat(g.getComputedStyle(notices).rowGap) || 0;
        let passing = 0;
        for (const name of ["turn", "toasts"]) {
          const place = notices.querySelector(`[data-rvtt-modal-slot="${name}"]`);
          if (place && place.offsetHeight > 0) passing += place.offsetHeight + gap;
        }
        const rows = Array.from(header.closest("[data-round-section]")!.querySelectorAll("[data-standard-row]"));
        const order = rows[0]?.parentElement;
        const row = Math.min(...rows.map((r) => r.offsetHeight)) + (order ? parseFloat(g.getComputedStyle(order).rowGap) || 0 : 0);
        return { form: header.dataset.form ?? "", body: header.closest("[data-pane-body]")!.clientHeight + passing, passing, need: header.offsetHeight + 2 * row };
      });
    /*
     * The form once the header has settled in it: static, or stuck with
     * room for two standard rows under it, the rule the form is picked by
     * (logic.ts roundHeaderForm). Her turn brings End turn into the full
     * header in the same render as "Your turn", and the header picks its
     * form again only after its ResizeObserver runs and React renders the
     * result, a frame or more later and longer on a busy machine. Read in
     * between, it is still the form from before End turn came. With
     * `notice`, it has to settle while the notice still shows.
     */
    const settled = (page: Page, label: string, notice: boolean) => {
      let last: Awaited<ReturnType<typeof room>> | null = null;
      return waitFor(`${label}: the round header settling in its form`, async () => {
        const now = await room(page);
        assert.ok(!notice || now.passing > 0, `${label}: the notice went before the round header settled in a form with room for two rows under it: ${JSON.stringify(last)}`);
        last = now;
        return now.form === "static" || now.body + 1 >= now.need ? now : null;
      });
    };
    const stuck = async (page: Page, button: string, label: string) => {
      const now = await settled(page, label, true);
      assert.notEqual(now.form, "static", `${label}: the round header stopped sticking`);
      assert.ok(await wholeInReach(page.locator("[data-round-header]").getByRole("button", { name: button })), `${label}: ${button} is out of reach`);
      return now;
    };
    const keeps = (during: { form: string; body: number }, rest: { form: string; body: number }, label: string) => {
      assert.equal(during.form, rest.form, `${label}: the round header changed form while the notice showed`);
      assert.ok(Math.abs(during.body - rest.body) <= 1, `${label}: the notice took ${rest.body - during.body} px more than was counted`);
    };
    const anaCdp = await anaContext.newCDPSession(ana);
    let cyraActs = false;
    try {
      // Cyra's turn, with Ana's order scrolled, then Bree's again: "Your turn" takes its place over the body for a few seconds.
      await ops.send({ t: "encounter.next" });
      cyraActs = true;
      await waitFor("Cyra's turn", () => (dmSocket.state?.encounter?.activeEntryId === "e-cy" ? true : null));
      await setUp(ana, anaCdp, view);
      await openTracker(ana);
      await modal(ana).waitFor();
      await scrollPane(ana, 220);
      await ops.send({ t: "encounter.prev" });
      cyraActs = false;
      await modal(ana).locator('[data-rvtt-modal-slot="turn"] [role="status"]', { hasText: "Your turn" }).waitFor();
      const anaDuring = await stuck(ana, "End turn", "Ana, as Your turn shows");
      await shots.take(ana, "combat-header-480-130-your-turn-scrolled");
      // Her turn brings End turn into the header, so its form is compared with the one it settles in once the notice goes.
      await modal(ana).locator('[data-rvtt-modal-slot="turn"]:empty').waitFor({ state: "attached", timeout: 15_000 });
      keeps(anaDuring, await settled(ana, "Ana, once Your turn has gone", false), "Ana, as Your turn shows");
      await ana.keyboard.press("Escape");
      await modal(ana).waitFor({ state: "detached" });

      // The DM's order scrolled, and a whisper from Ana comes as a toast.
      await setUp(dm, dmCdp, view);
      await openTracker(dm);
      await modal(dm).waitFor();
      await scrollPane(dm, 220);
      const dmRest = await settled(dm, "the DM, before the toast", false);
      const anaCookie = (await anaContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      const anaOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: anaCookie });
      try {
        const dmId = Object.values(dmSocket.state!.members).find((m) => m?.kind === "dm")!.id;
        await anaOps.send({ t: "log.whisper", to: [dmId], text: "Behind you!" });
      } finally {
        anaOps.close();
      }
      await modal(dm).locator('[data-rvtt-modal-slot="toasts"] [data-toast]').first().waitFor();
      keeps(await stuck(dm, "Next", "the DM, as a toast shows"), dmRest, "the DM, as a toast shows");
      await shots.take(dm, "combat-header-480-130-toast-scrolled");
      await dm.keyboard.press("Escape");
      await modal(dm).waitFor({ state: "detached" });
    } finally {
      /*
       * Whatever failed above, Bree acts again and Ana's page is back at
       * the desk with no sheet, as the steps after this one find it. They
       * use her page without loading it again, and a very short sheet left
       * open is modal, so it would take every tap they make. The next
       * step loads the DM's page again first.
       */
      if (cyraActs) await ops.send({ t: "encounter.prev" });
      await setUp(ana, anaCdp, { ...DESK, scale: 1 });
      await anaCdp.detach();
    }
  });

  test("3. a sheet just tall enough for the compact header and two rows sticks it as one 44 px row, a whole row showing at every offset, and 2 px less scrolls it with the order", async () => {
    /*
     * The same phone held sideways, resized with the sheet open until its
     * scroller is a given height, as the turn band does. A resize, not a
     * reload: the server delays a session's snapshots past 20 a minute.
     */
    await setUp(dm, dmCdp, { width: 844, height: 390, scale: 1 });
    await openTracker(dm);
    const sized = async (target: number): Promise<HeaderRoom> => {
      let height = dm.viewportSize()!.height;
      let room = await headerRoom(dm);
      for (let i = 0; i < 6 && room.scroller !== target; i++) {
        height -= room.scroller - target;
        await dm.setViewportSize({ width: 844, height });
        // Settled once two frames apart measure the same.
        let last = -1;
        room = await headerRoom(dm);
        while (room.scroller !== last) {
          last = room.scroller;
          await dm.waitForTimeout(50);
          room = await headerRoom(dm);
        }
      }
      assert.equal(room.scroller, target, `no height gives a ${target} px scroller: the last was ${room.scroller} px at ${height}`);
      return room;
    };
    const tall = await sized(300);
    assert.equal(tall.form, "full");
    const full = tall.header;
    const compactNeed = tall.compactHeader + 2 * tall.row;
    assert.ok(compactNeed < full + 2 * tall.row, "the compact header is shorter than the full one");
    // At exactly the compact header and two rows, the tightest a sticky header gets.
    const tight = await sized(compactNeed);
    assert.equal(tight.form, "compact");
    const m = await measure(dm);
    assert.ok(m.sticky, "the compact header sticks");
    assert.ok(Math.abs(m.compactRow - 44) <= 1, `the compact header's row is ${m.compactRow} px, not 44`);
    await sweepRowInterval(dm, 200, `a ${compactNeed} px sheet`);
    // The whole whose-turn line stays in the header for a screen reader, ending in an ellipsis on screen.
    assert.match((await dm.locator("[data-round-header]").textContent()) ?? "", /Round 1.*Bree's turn|Round 1.*Press Start/);
    await shots.take(dm, "combat-header-compact");
    // At exactly the full header and two rows, it sticks in full, with a whole row at every offset.
    const fullTight = await sized(full + 2 * tall.row);
    assert.equal(fullTight.form, "full");
    await sweepRowInterval(dm, 200, `a ${full + 2 * tall.row} px sheet`);
    // 2 px under the compact need, it scrolls with the order in full.
    const short = await sized(compactNeed - 2);
    assert.equal(short.form, "static");
    assert.equal((await measure(dm)).sticky, false);
  });

  test("3-dp3. a resize that changes the round header's form draws the new form in the frame it resized, never a frame of the old one (W7-FC-1)", async () => {
    await setUp(dm, dmCdp, { width: 844, height: 390, scale: 1 });
    await openTracker(dm);
    /*
     * A second observer of the scroller, made after the header's own, runs
     * after it in the same frame's resize step, just before that frame
     * paints, so the form it reads is the form that frame shows. A form
     * the header picked but React drew a task later reads as the old one.
     */
    await dm.evaluate(() => {
      type El = { dataset: Record<string, string | undefined>; closest(s: string): El | null };
      const g = globalThis as unknown as { document: { querySelector(s: string): El | null }; ResizeObserver: new (cb: () => void) => { observe(e: El): void }; rvttPainted: string[] };
      const header = g.document.querySelector("[data-round-header]")!;
      g.rvttPainted = [];
      new g.ResizeObserver(() => g.rvttPainted.push(header.dataset.form ?? "")).observe(header.closest("[data-pane-body]")!);
    });
    const painted = () => dm.evaluate(() => (globalThis as unknown as { rvttPainted: string[] }).rvttPainted.at(-1) ?? "");
    const resized = async (scroller: number, form: string) => {
      const before = await headerRoom(dm);
      await dm.setViewportSize({ width: 844, height: dm.viewportSize()!.height + scroller - before.scroller });
      const after = await waitFor(`a ${scroller} px scroller in its ${form} form`, async () => {
        const now = await headerRoom(dm);
        return now.form === form ? now : null;
      });
      assert.equal(await painted(), after.form, `at ${after.scroller} px the frame that resized it showed the old form`);
    };
    const rest = await headerRoom(dm);
    assert.equal(rest.form, "full", "the sideways phone's sheet starts with a full header");
    const compactNeed = rest.compactHeader + 2 * rest.row;
    await resized(compactNeed + 4, "compact");
    await resized(compactNeed - 4, "static");
    await resized(compactNeed + 4, "compact");
    await resized(rest.scroller, "full");
  });

  test("4. scrolling to Auto initiative takes the header away, and focus moving through the rows never lands under it", async () => {
    await setUp(dm, dmCdp, { width: 390, height: 844, scale: 1 });
    const section = await openTracker(dm);
    // Auto initiative's heading at the scroller's top: the round section has scrolled past, so its header went with it.
    await dm.getByRole("heading", { name: "Auto Initiative", exact: true }).evaluate((h) => (h as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "start" }));
    const gone = await measure(dm);
    const auto = await dm.getByRole("heading", { name: "Auto Initiative" }).boundingBox();
    assert.ok(auto && gone.header.bottom <= auto.y + 1, `the header still covers Auto Initiative: ${JSON.stringify({ header: gone.header, auto })}`);
    await shots.take(dm, "combat-header-gone");
    // Shift+Tab from Auto initiative's first control back into the last rows.
    await dm.getByRole("radio", { name: "By creature" }).focus();
    for (let i = 0; i < 6; i++) {
      await dm.keyboard.press("Shift+Tab");
      await dm.waitForTimeout(60);
      const where = await dm.evaluate(() => {
        const g = globalThis as unknown as { document: { activeElement: { getBoundingClientRect(): Rect; closest(s: string): unknown } | null; querySelector(s: string): { getBoundingClientRect(): Rect } } };
        const a = g.document.activeElement;
        if (!a || !a.closest("[data-round-section]") || a.closest("[data-round-header]")) return null;
        return { focus: a.getBoundingClientRect().top, header: g.document.querySelector("[data-round-header]").getBoundingClientRect().bottom };
      });
      if (where) assert.ok(where.focus >= where.header - 1, `Shift+Tab ${i + 1} left focus under the header: ${JSON.stringify(where)}`);
    }
    // Tab down the list from the header's Next.
    await section.getByRole("button", { name: "Next" }).focus();
    for (let i = 0; i < 12; i++) {
      await dm.keyboard.press("Tab");
      await dm.waitForTimeout(60);
      const where = await dm.evaluate(() => {
        const g = globalThis as unknown as { document: { activeElement: { getBoundingClientRect(): Rect; closest(s: string): unknown } | null; querySelector(s: string): { getBoundingClientRect(): Rect } } };
        const a = g.document.activeElement;
        if (!a || !a.closest("[data-round-section]") || a.closest("[data-round-header]")) return null;
        return { focus: a.getBoundingClientRect().top, header: g.document.querySelector("[data-round-header]").getBoundingClientRect().bottom };
      });
      if (where) assert.ok(where.focus >= where.header - 1, `Tab ${i + 1} left focus under the header: ${JSON.stringify(where)}`);
    }
  });

  test("5. the tracker's sections run by use, the roll card under Auto initiative, and a player's run Join the fight first", async () => {
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openTracker(dm);
    assert.deepEqual(await headings(dm), ["Auto Initiative", "Initiative", "Add to the fight", "Several at once", "HP changes", "Turn timer", "End", "This device"]);
    // Twelve goblins with values: re-roll them, and the card of what it rolled sits under the button.
    await dm.getByRole("checkbox", { name: "Re-roll monsters that have a value" }).check();
    await dm.getByRole("button", { name: /^Auto Initiative \(\d+\)/ }).click();
    const card = dm.getByRole("region", { name: "Auto Initiative results" });
    await card.waitFor();
    const button = await dm.getByRole("button", { name: /^Auto Initiative \(\d+\)/ }).boundingBox();
    const cardBox = await card.boundingBox();
    assert.ok(button && cardBox && cardBox.y > button.y, "the roll card sits under Auto Initiative's button");
    await shots.take(dm, "combat-order-dm");
    await openTracker(ana);
    assert.deepEqual(await headings(ana), ["Several at once", "HP changes", "This device"], "Bree is in the fight already, so Join the fight is gone");
  });

  test("5b. auto initiative's dice are the server's, secret to the DM, and a row's Roll sets the goblin's row and Ana's sets Bree's to the total that landed (docs/design-v1-roll-options.md 4.5, 7)", async () => {
    type DiceLine = Extract<LogEvent, { type: "dice" }>;
    const lines = (): DiceLine[] => (dmSocket.state?.log ?? []).flatMap((e) => (e.data?.type === "dice" ? [e.data] : []));
    const auto = lines().filter((l) => l.rolls.some((r) => r.label?.startsWith("Initiative")));
    assert.ok(auto.length > 0 && auto.every((l) => l.to === "dm"), "test 5's auto initiative left no secret dice line");
    const value = (entryId: string) => dmSocket.state?.encounter?.entries.find((e) => e.id === entryId)?.value;
    // Roll sits beside the value box where an unset row has room, else in the row's options, where a set row's replaces its value.
    const rollRow = async (page: Page, name: string, entryId: string) => {
      const roll = page.getByRole("button", { name: new RegExp(`^Roll [+−-]\\d+ Initiative for ${name}(, replacing -?\\d+)?$`) }).first();
      if (!(await roll.isVisible())) await page.getByRole("button", { name: `${name} options` }).click();
      const before = lines().length;
      await roll.click();
      const line = await waitFor(`${name}'s initiative line`, () => lines().slice(before).find((l) => l.rolls[0]?.label === "Initiative") ?? null);
      const total = line.rolls[0]!.total;
      await waitFor(`${name}'s row set to ${total}`, () => (value(entryId) === total ? true : null));
    };
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openTracker(dm);
    // A set row offers Roll only in its options, as "Roll again", so a stray tap never reorders the fight (W7B-P-6).
    const setRoll = dm.getByRole("button", { name: new RegExp(`^Roll [+−-]\\d+ Initiative for ${goblinName(0)}, replacing -?\\d+$`) });
    assert.equal(await setRoll.isVisible(), false, "a set row has no Roll beside its value");
    await rollRow(dm, goblinName(0), "e-g0");
    await dm.locator("[data-round-section]").getByText(/^Roll again, replaces -?\d+$/).first().waitFor();
    await openTracker(ana);
    await rollRow(ana, "Bree", "e-bree");
    // Bree leads the order again, as the steps after this one expect.
    await ops.send({ t: "encounter.setValues", values: [{ entryId: "e-bree", value: 25 }] });
  });

  test("6. AC shields: the DM's on every living row, a player's on their own creatures only, and each row's description reads its AC and HP", async () => {
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openTracker(dm);
    const dmShields = await dm.locator("[data-round-section] [role=img][aria-label^='Armor Class']").count();
    assert.equal(dmShields, 14, "the DM sees a shield on every living row");
    const g1 = await descriptions(dmCdp, /^Goblin 12\./);
    assert.ok(g1.some((d) => d.startsWith("Armor Class 15, HP 7/7")), `the goblin row's description: ${JSON.stringify(g1)}`);
    await openTracker(ana);
    const anaCdp = await anaContext.newCDPSession(ana);
    assert.equal(await ana.locator("[data-round-section] [role=img][aria-label='Armor Class 16']").count(), 1, "Ana sees Bree's shield");
    assert.equal(await ana.locator("[data-round-section] [role=img][aria-label='Armor Class 15']").count(), 0, "and no goblin's");
    const bree = await descriptions(anaCdp, /^Bree[.,]/);
    assert.ok(bree.some((d) => d.startsWith("Armor Class 16, HP 31/31")), `Bree's description: ${JSON.stringify(bree)}`);
    await shots.take(ana, "combat-ac-player");
  });

  test("7. a goblin killed shows Dead and Revive in its bar and row, Revive gives exactly 1 HP, and Ctrl+Z takes it back; a chest has no life buttons", async () => {
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openTracker(dm);
    await (await rowButton(dm, "Goblin 12")).click();
    const b = bar(dm, "Goblin 12");
    await b.waitFor();
    await b.getByRole("textbox", { name: "HP change" }).fill("7");
    await b.getByRole("button", { name: "Apply" }).click();
    await waitFor("the goblin dead", () => (goblinState(11)?.life === "dead" ? true : null));
    await b.getByText("Revive brings it back with 1 HP.").waitFor();
    await shots.take(dm, "combat-dead-bar");
    // No AC shield on a dead row.
    await openTracker(dm);
    assert.equal(await dm.locator("[data-round-section] [role=img][aria-label^='Armor Class']").count(), 13);
    await dm.getByRole("button", { name: "Goblin 12 options" }).click();
    await dm.locator("[data-round-section]").getByRole("button", { name: "Revive" }).waitFor();
    await dm.getByRole("button", { name: "Goblin 12 options" }).click();
    // The bar's Revive: exactly 1 HP, the Dead tag gone.
    await b.getByRole("button", { name: "Revive" }).click();
    await waitFor("the goblin back at 1", () => (goblinState(11)?.life === "alive" && goblinState(11)?.hp.cur === 1 ? true : null));
    await b.getByText("Revive brings it back with 1 HP.").waitFor({ state: "detached" });
    await dm.keyboard.press("Control+z");
    await waitFor("the goblin dead again after Ctrl+Z", () => (goblinState(11)?.life === "dead" ? true : null));
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[11]! }, life: "alive" });
    // A chest: its HP shows, and no Revive, Stabilize or Mark dead.
    await openSideTab(dm, "Outliner");
    await dm.getByRole("tabpanel", { name: "Outliner" }).getByRole("button", { name: /^Chest/ }).click();
    const chest = bar(dm, "Chest");
    await chest.waitFor();
    await chest.getByRole("button", { name: "Details" }).click();
    const panel = dm.getByRole("tabpanel", { name: "Token" });
    await panel.getByRole("heading", { name: "Chest" }).waitFor();
    assert.ok(await panel.getByRole("textbox", { name: "HP change" }).isVisible(), "a chest keeps its HP");
    for (const name of ["Revive", "Stabilize", "Mark dead"]) assert.equal(await panel.getByRole("button", { name }).count(), 0, `${name} on a chest`);
    await shots.take(dm, "combat-chest-panel");
  });

  test("8. healing brings back the dead at the healed HP, +5 under Damage counts as a heal, and with the setting off the entry says so before sending", async () => {
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openTracker(dm);
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[11]! }, life: "dead" });
    await waitFor("the goblin dead", () => (goblinState(11)?.life === "dead" ? true : null));
    await (await rowButton(dm, "Goblin 12")).click();
    const b = bar(dm, "Goblin 12");
    await b.waitFor();
    await b.getByRole("radio", { name: "Damage" }).check();
    await b.getByRole("textbox", { name: "HP change" }).fill("+5");
    await b.getByText("Brings back 1 dead creature.").waitFor();
    await shots.take(dm, "combat-heal-count");
    await b.getByRole("button", { name: "Apply" }).click();
    await waitFor("the goblin back at 5", () => (goblinState(11)?.life === "alive" && goblinState(11)?.hp.cur === 5 ? true : null));
    await waitFor("the log says it is back", () => dmSocket.state?.log.some((e) => e.data?.type === "life" && e.data.life === "alive" && e.data.tokenId === run.goblins[11]) || null);
    // Off: kill it again, and the lines say healing does nothing.
    await ops.send({ t: "room.update", settings: { healRevives: false } });
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[11]! }, life: "dead" });
    await waitFor("dead again", () => (goblinState(11)?.life === "dead" ? true : null));
    await b.getByRole("radio", { name: "Heal" }).check();
    await b.getByText("Healing does nothing while Goblin 12 is dead. Revive Goblin 12 first.").waitFor();
    await b.getByRole("textbox", { name: "HP change" }).fill("5");
    await b.getByRole("button", { name: "Apply" }).click();
    await dm.waitForTimeout(400);
    assert.equal(goblinState(11)?.life, "dead", "a heal leaves it dead");
    await b.getByRole("textbox", { name: "HP change" }).fill("=4");
    await b.getByText("Goblin 12 stays dead at the new HP. Only Revive brings Goblin 12 back.").waitFor();
    await shots.take(dm, "combat-heal-off");
    await b.getByRole("button", { name: "Apply" }).click();
    await waitFor("dead at 4", () => (goblinState(11)?.life === "dead" && goblinState(11)?.hp.cur === 4 ? true : null));
    await ops.send({ t: "room.update", settings: { healRevives: true } });
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[11]! }, life: "alive" });
  });

  test("8b. Ana, who may only deal damage and heal, sees =12 on a dead goblin refused at once, with no promise to bring it back, and +5 counted as the heal it is (SFB-P-10)", async () => {
    await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[11]! }, life: "dead" });
    await setUp(ana, await anaContext.newCDPSession(ana), { ...DESK, scale: 1 });
    await openTracker(ana);
    await (await rowButton(ana, "Goblin 12")).click();
    const b = bar(ana, "Goblin 12");
    const field = b.getByRole("textbox", { name: "HP change" });
    await field.fill("=12");
    await b.getByText("You can only deal damage to or heal this creature.").waitFor();
    assert.equal(await b.getByText("Set HP to 12").count(), 0, "the summary promises a set");
    assert.equal(await b.getByText("Brings back 1 dead creature.").count(), 0, "a line promises what a set would do");
    assert.ok(await b.getByRole("button", { name: "Apply" }).isDisabled(), "Apply waits for something Ana may send");
    await shots.take(ana, "combat-relative-set-refused");
    await field.fill("+5");
    await b.getByText("Brings back 1 dead creature.").waitFor();
    assert.equal(await b.getByText("You can only deal damage to or heal this creature.").count(), 0);
    await field.fill("");
    await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[11]! }, life: "alive" });
  });

  test("9. Ana adds Spiritual Weapon and Wildfire Spirit beside Bree without Players can create their own characters, and the DM's log names each", async () => {
    await setUp(ana, await anaContext.newCDPSession(ana), { ...DESK, scale: 1 });
    await openSideTab(ana, "Characters");
    // A turn of null leaves Turn untouched, so the form's own start for what it is gets sent.
    const add = async (name: string, what: "A creature" | "An effect", turn: string | null, hp?: string) => {
      await ana.getByRole("button", { name: "Add a companion" }).click();
      await ana.getByRole("textbox", { name: "Name" }).fill(name);
      await ana.getByRole("radio", { name: what }).check();
      if (turn) await ana.getByRole("combobox", { name: "Turn" }).selectOption({ label: turn });
      if (hp) {
        await ana.getByRole("textbox", { name: "HP" }).fill(hp);
        await ana.getByRole("textbox", { name: "AC" }).fill("13");
      }
      await ana.getByText("Goes next to Bree on the map.").waitFor();
      await shots.take(ana, `combat-companion-form-${what === "An effect" ? "effect" : "creature"}`);
      await ana.getByRole("button", { name: "Add and place" }).click();
      return waitFor(`${name} in the DM's view`, () => Object.values(dmSocket.state?.tokens ?? {}).find((t) => t.name === name));
    };
    // With Bree's token on another scene, the button says why it cannot place one.
    await ops.send({ t: "token.update", tokenId: run.bree.id, patch: { sceneId: run.otherSceneId } });
    await ana.getByRole("button", { name: "Add a companion" }).click();
    await ana.getByText("Bree has no token on the map.").waitFor();
    assert.ok(await ana.getByRole("button", { name: "Add and place" }).isDisabled());
    await shots.take(ana, "combat-companion-no-token");
    await ana.getByRole("button", { name: "Cancel" }).first().click();
    await ops.send({ t: "token.update", tokenId: run.bree.id, patch: { sceneId: run.sceneId, x: 5, y: 5 } });
    await waitFor("Bree back on the players' scene", () => (anaSocket.state?.tokens[run.bree.id] ? true : null));
    const weapon = await add("Spiritual Weapon", "An effect", null);
    assert.deepEqual(weapon.companion, { of: run.bree.characterId, turn: "none" }, "an effect made without touching Turn is not listed (SOL-04)");
    await bar(ana, "Spiritual Weapon").waitFor();
    await openSideTab(ana, "Characters");
    const spirit = await add("Wildfire Spirit", "A creature", "On Bree's turn, listed under Bree", "15");
    for (const t of [weapon, spirit]) {
      assert.ok(Math.abs(t.x - 5) <= 1.01 && Math.abs(t.y - 5) <= 1.01, `${t.name} landed within 5 ft of Bree: ${t.x},${t.y}`);
      assert.deepEqual(t.ownerIds, [run.anaId]);
    }
    const lines = dmSocket.state!.log.filter((e) => e.data?.type === "companion").map((e) => (e.data?.type === "companion" ? e.data.name : ""));
    assert.deepEqual(lines, ["Spiritual Weapon", "Wildfire Spirit"]);
    assert.equal(anaSocket.state!.log.some((e) => e.data?.type === "companion"), false, "the line is the DM's alone");
    // The Dice tab took the Log's place in the row, so the Log may stand behind More (docs/design-v1-dice.md 8.1).
    await openSideTab(dm, "Log");
    await dm.getByText("Ana added Wildfire Spirit beside Bree.").waitFor();
    await shots.take(dm, "combat-companion-log");
    // Neither is offered a row: not in Ana's Join the fight, nor in the DM's Everyone here.
    await openTracker(ana);
    assert.equal(await ana.getByRole("heading", { name: "Join the fight" }).count(), 0, "nothing of Ana's left to join");
    await openTracker(dm);
    // Every creature but the companions is in the fight already, and the chest is an object: nothing is left to add.
    const everyone = await dm.getByRole("button", { name: /^Everyone here \(\d+\)/ }).textContent();
    assert.match(everyone ?? "", /\(0\)/, "the companions are left out");
  });

  test("10. Wildfire Spirit shows under Bree for the DM, Ana and Cy, Spiritual Weapon nowhere in the tracker and with no HP in its panel", async () => {
    for (const page of [dm, ana, cy]) {
      await openTracker(page);
      const sub = page.getByRole("button", { name: "Wildfire Spirit, acts on Bree's turn. Show it on the map with its actions." });
      await sub.waitFor();
      assert.equal(await page.locator("[data-round-section]").getByText("Spiritual Weapon").count(), 0);
    }
    const anaCdp = await anaContext.newCDPSession(ana);
    const d = await descriptions(anaCdp, /^Wildfire Spirit, acts on/);
    assert.ok(d.some((x) => x.startsWith("Armor Class 13, HP 15/15")), `the sub-row's description: ${JSON.stringify(d)}`);
    await shots.take(cy, "combat-nested-other-player");
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Spiritual Weapon\. Show it on the map/ }).click();
    await bar(ana, "Spiritual Weapon").waitFor();
    assert.equal(await bar(ana, "Spiritual Weapon").getByRole("textbox", { name: "HP change" }).count(), 0, "no HP entry on an effect");
    await ana.getByRole("tab", { name: "Token" }).click();
    await ana.getByText("No HP: it is an effect.").waitFor();
  });

  test("11. Ana's spirit: renamed, its AC edited, its Reaction marked and readied, both cleared on Bree's next turn, then It fired spends its own Reaction", async () => {
    const spirit = () => Object.values(dmSocket.state!.tokens).find((t) => t.companion?.turn === "shared")!;
    const effects = () => {
      const a = spirit().actor;
      return "inline" in a ? a.inline.effects : [];
    };
    await openTracker(ana);
    await ana.getByRole("button", { name: "Wildfire Spirit options" }).click();
    await ana.getByRole("switch", { name: /Reaction used/ }).last().click();
    await waitFor("its Reaction spent", () => (spirit().companion?.reactionUsed ? true : null));
    await ana.getByRole("textbox", { name: "Trigger for the Ready action" }).last().fill("if a goblin comes near");
    await ana.getByRole("button", { name: "Ready" }).last().click();
    await waitFor("its Ready held", () => (effects().some((e) => e.key === "readied") ? true : null));
    await shots.take(ana, "combat-spirit-options");
    // Bree's next turn: a Next for each of the fourteen rows brings the turn round to her again.
    const round = dmSocket.state!.encounter!.round;
    assert.equal(dmSocket.state!.encounter!.activeEntryId, "e-bree");
    for (let i = 0; i < 14; i++) await ops.send({ t: "encounter.next" });
    await waitFor("Bree's turn again", () => (dmSocket.state?.encounter?.activeEntryId === "e-bree" && dmSocket.state.encounter.round === round + 1 ? true : null));
    await waitFor("both cleared", () => (!spirit().companion?.reactionUsed && !effects().some((e) => e.key === "readied") ? true : null));
    // Readied again, and It fired from the token panel.
    await ana.getByRole("textbox", { name: "Trigger for the Ready action" }).last().fill("again");
    await ana.getByRole("button", { name: "Ready" }).last().click();
    await waitFor("readied again", () => (effects().some((e) => e.key === "readied") ? true : null));
    await ana.getByRole("button", { name: /^Wildfire Spirit, acts on/ }).click();
    await ana.getByRole("tab", { name: "Token" }).click();
    const conditions = ana.getByRole("tabpanel", { name: "Token" });
    const held = conditions.getByRole("button", { name: /again/ });
    // The chip says whose turn its duration counts: Bree's, whose turn the spirit acts on.
    assert.match((await held.textContent()) ?? "", /Bree/);
    await held.click();
    await shots.take(ana, "combat-it-fired");
    await ana.getByRole("button", { name: "It fired: Reaction used" }).click();
    await waitFor("its own Reaction spent", () => (spirit().companion?.reactionUsed ? true : null));
    assert.equal(dmSocket.state!.encounter!.entries.find((e) => e.id === "e-bree")!.reactionUsed, false, "Bree's Reaction is untouched");
    // Its player renames it in Token settings and edits its AC in Stats, both folded at the panel's foot.
    const panel = ana.getByRole("tabpanel", { name: "Token" });
    await openFold(panel, "Token settings");
    await openFold(panel, "Stats");
    await panel.getByRole("textbox", { name: "Name" }).fill("Ember");
    await panel.getByRole("textbox", { name: "Armor Class" }).click();
    await waitFor("renamed", () => (spirit().name === "Ember" ? true : null));
    await panel.getByRole("textbox", { name: "Armor Class" }).fill("14");
    await panel.getByRole("textbox", { name: "Name" }).click();
    await waitFor("its AC edited", () => (((a) => "inline" in a && a.inline.ac === 14)(spirit().actor) ? true : null));
    await panel.getByRole("textbox", { name: "Name" }).fill("Wildfire Spirit");
    await panel.getByRole("textbox", { name: "Armor Class" }).click();
    await waitFor("named back", () => (spirit().name === "Wildfire Spirit" ? true : null));
    // On Bree's turn, End turn moves past Bree and the spirit both.
    await openTracker(ana);
    await ana.locator("[data-round-header]").getByRole("button", { name: "End turn" }).click();
    await waitFor("Cyra's turn", () => (dmSocket.state?.encounter?.activeEntryId === "e-cy" ? true : null));
    await ops.send({ t: "encounter.prev" });
  });

  test("12. switching the spirit to its own turn lets Ana join it, Dismiss takes the weapon away for everyone, and Previous brings back no row of it", async () => {
    const spirit = Object.values(dmSocket.state!.tokens).find((t) => t.companion?.turn === "shared")!;
    // Ana switches it in its panel's Companion section, which waits for the server.
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Wildfire Spirit\. Show it on the map/ }).click();
    await ana.getByRole("tab", { name: "Token" }).click();
    const panel = ana.getByRole("tabpanel", { name: "Token" });
    // Folded, the section names the character beside its label.
    assert.match((await panel.getByRole("heading", { name: "Companion", exact: true }).locator("..").textContent()) ?? "", /Bree/);
    await openFold(panel, "Companion");
    await panel.getByText("Belongs to Bree. Whoever plays Bree controls it.").waitFor();
    await shots.take(ana, "combat-companion-section");
    await panel.getByRole("combobox", { name: "Turn" }).selectOption({ label: "Its own turn" });
    await waitFor("its own turn", () => (dmSocket.state?.tokens[spirit.id]?.companion?.turn === "own" ? true : null));
    await openTracker(ana);
    // A player's tracker: Join the fight right after the order, while it has something to join.
    assert.deepEqual(await headings(ana), ["Join the fight", "Several at once", "HP changes", "This device"]);
    await ana.getByRole("button", { name: "Add Wildfire Spirit" }).click();
    await waitFor("its row", () => dmSocket.state?.encounter?.entries.some((e) => e.tokenId === spirit.id) || null);
    // Its player types its value, and the row reads whose companion it is.
    const row = await rowButton(ana, "Wildfire Spirit");
    await ana.getByRole("button", { name: /^Wildfire Spirit Initiative not set/ }).click();
    await ana.getByRole("textbox", { name: "Wildfire Spirit Initiative" }).fill("13");
    await ana.keyboard.press("Enter");
    await waitFor("its value", () => (dmSocket.state?.encounter?.entries.find((e) => e.tokenId === spirit.id)?.value === 13 ? true : null));
    assert.match((await row.textContent()) ?? "", /Companion of Bree/);
    const weapon = Object.values(dmSocket.state!.tokens).find((t) => t.name === "Spiritual Weapon")!;
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Spiritual Weapon\. Show it on the map/ }).click();
    const b = bar(ana, "Spiritual Weapon");
    await b.getByRole("button", { name: "Dismiss" }).click();
    await b.getByRole("button", { name: "Dismiss Spiritual Weapon?" }).click();
    await waitFor("the weapon gone for everyone", () => (!dmSocket.state?.tokens[weapon.id] && !cySocket.state?.tokens[weapon.id] ? true : null));
    await ops.send({ t: "encounter.prev" });
    await waitFor("Previous taken", () => true);
    assert.equal(dmSocket.state!.encounter!.entries.some((e) => e.tokenId === weapon.id), false);
  });

  test("13. the DM viewing as Ana sees the same nesting, and Add a companion and Dismiss flash refused", async () => {
    const spirit = Object.values(dmSocket.state!.tokens).find((t) => t.name === "Wildfire Spirit")!;
    await ops.send({ t: "token.update", tokenId: spirit.id, patch: { companion: { of: run.bree.characterId, turn: "shared" } } });
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).first().click();
    const preview = dm.getByRole("dialog", { name: /^Viewing as / });
    await preview.waitFor();
    await preview.getByRole("tab", { name: "Initiative" }).click();
    await preview.getByRole("button", { name: "Wildfire Spirit, acts on Bree's turn. Show it on the map with its actions." }).waitFor();
    await shots.take(dm, "combat-viewing-as");
    await openSideTab(preview, "Characters");
    await preview.getByRole("button", { name: "Add a companion" }).click();
    await preview.getByRole("textbox", { name: "Name" }).fill("Owl");
    await preview.getByRole("textbox", { name: "HP" }).fill("1");
    await preview.getByRole("textbox", { name: "Name" }).click();
    await preview.getByRole("button", { name: "Add and place" }).click();
    await preview.getByText("Read-only: nothing you do here is saved.").waitFor();
    // What was typed was never taken, so Cancel asks before it throws it away (docs/design-v1-look-pass.md 3.1).
    await preview.getByRole("button", { name: "Cancel" }).first().click();
    await preview.getByRole("button", { name: "Discard changes?" }).last().click();
    await preview.getByRole("button", { name: /^Wildfire Spirit\. Show it on the map/ }).click();
    const b = preview.getByRole("dialog", { name: "Wildfire Spirit actions" });
    await b.getByRole("button", { name: "Dismiss" }).click();
    await b.getByRole("button", { name: "Dismiss Wildfire Spirit?" }).click();
    await preview.getByText("Read-only: nothing you do here is saved.").waitFor();
    assert.ok(dmSocket.state!.tokens[spirit.id], "nothing was dismissed");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
  });

  test("13b. a companion in the very short sheet at 480 x 320 at 130%: its panel names Bree, and its Companion section folds with Bree beside it and opens within the sheet's width", async () => {
    await setUp(dm, dmCdp, { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 });
    await openTracker(dm);
    await dm.getByRole("button", { name: "Wildfire Spirit, acts on Bree's turn. Show it on the map with its actions." }).click();
    const b = bar(dm, "Wildfire Spirit");
    await b.waitFor();
    await b.getByRole("button", { name: "Details", exact: true }).click();
    const sheet = dm.locator('dialog[data-rvtt-sheet][aria-modal="true"]');
    await sheet.waitFor();
    const panel = sheet.getByRole("region", { name: "Token" });
    // The name block's tag, in the tracker's words (docs/design-v1-token-panel.md 3.6).
    await panel.getByText("Companion of Bree", { exact: true }).waitFor();
    const heading = panel.getByRole("heading", { name: "Companion", exact: true });
    assert.equal(await heading.getByRole("button").getAttribute("aria-expanded"), "false", "the Companion section starts folded");
    assert.match((await heading.locator("..").textContent()) ?? "", /Bree/, "folded, it names its character");
    await openFold(panel, "Companion");
    await panel.getByRole("combobox", { name: "Belongs to" }).waitFor();
    await panel.getByRole("button", { name: "Stop being a companion" }).scrollIntoViewIfNeeded();
    const body = sheet.locator("[data-pane-body]");
    assert.equal(await body.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth <= (el as unknown as { clientWidth: number }).clientWidth + 1), true, "the very short sheet scrolls sideways");
    await shots.take(dm, "combat-companion-very-short-sheet");
    // Folded again, as this device kept it.
    await heading.getByRole("button").click();
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("13c. a dying spirit made an effect offers no death save pips or AC to Ana or the DM, and does again as a creature (SOL-03)", async () => {
    const spirit = Object.values(dmSocket.state!.tokens).find((t) => t.name === "Wildfire Spirit")!;
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await ops.send({ t: "actor.life", target: { tokenId: spirit.id }, life: "dying" });
    await openSideTab(ana, "Characters");
    await ana.getByRole("button", { name: /^Wildfire Spirit\. Show it on the map/ }).click();
    const b = bar(ana, "Wildfire Spirit");
    const pips = b.getByRole("button", { name: /^Successes: set to/ });
    await pips.first().waitFor();
    const statsAc = async (page: Page) => {
      await page.getByRole("tab", { name: "Token" }).click();
      const panel = page.getByRole("tabpanel", { name: "Token" });
      await openFold(panel, "Stats");
      return panel.getByRole("textbox", { name: "Armor Class" }).count();
    };
    assert.equal(await statsAc(ana), 1, "a creature companion's AC is Ana's to edit");
    await ops.send({ t: "token.update", tokenId: spirit.id, patch: { kind: "object" } });
    await waitFor("an effect on Ana's page", () => (anaSocket.state?.tokens[spirit.id]?.kind === "object" ? true : null));
    await pips.first().waitFor({ state: "detached" });
    assert.equal(await statsAc(ana), 0, "an effect has no AC field");
    await shots.take(ana, "combat-effect-no-life");
    // The DM's bar on it neither.
    await openTracker(dm);
    await dm.getByRole("button", { name: /^Wildfire Spirit, acts on Bree's turn/ }).click();
    await bar(dm, "Wildfire Spirit").waitFor();
    assert.equal(await bar(dm, "Wildfire Spirit").getByRole("button", { name: /^Successes: set to/ }).count(), 0);
    // A creature again: the pips and the AC come back as they were.
    await ops.send({ t: "token.update", tokenId: spirit.id, patch: { kind: "npc" } });
    await pips.first().waitFor();
    assert.equal(await statsAc(ana), 1);
    await ops.send({ t: "actor.life", target: { tokenId: spirit.id }, life: "alive" });
  });

  test("13d. on Ana's phone, Add a companion's answer held back until after Cancel and opening Log neither selects the new token nor closes the Log (ASTRA-07)", async () => {
    // A second device of Ana's whose room socket goes through a route, so the server's frames can wait.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies(await anaContext.cookies(server.origin));
    const page = await context.newPage();
    const watch = new ConsoleWatch("ana-phone");
    watch.attach(page);
    let hold = false;
    const held: (string | Buffer)[] = [];
    let toPage: ((m: string | Buffer) => void) | null = null;
    await page.routeWebSocket(/\/ws\?room=/, (ws) => {
      const upstream = ws.connectToServer();
      upstream.onMessage((m) => (hold ? held.push(m) : ws.send(m)));
      toPage = (m) => ws.send(m);
    });
    try {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      // From the toolbar's Panels, or from an open sheet's All panels, since Panels closes an open sheet.
      const openPanel = async (title: string, from?: Locator) => {
        // A sheet on a subpage, such as the character's page a player with one character lands on, has Back where All panels was.
        if (from && !(await from.getByRole("button", { name: "All panels" }).isVisible())) await from.getByRole("button", { name: /^Back to / }).click();
        if (from) await from.getByRole("button", { name: "All panels" }).click();
        else await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
        await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
        const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
        await sheet.waitFor();
        return sheet;
      };
      const characters = await openPanel("Characters");
      await characters.getByRole("button", { name: "Add a companion" }).click();
      await characters.getByRole("textbox", { name: "Name" }).fill("Flaming Sphere");
      await characters.getByRole("radio", { name: "An effect" }).check();
      hold = true;
      await characters.getByRole("button", { name: "Add and place" }).click();
      await characters.getByRole("button", { name: "Adding…" }).waitFor();
      // The server takes it while its answer waits on the way back.
      const sphere = await waitFor("Flaming Sphere in the DM's view", () => Object.values(dmSocket.state?.tokens ?? {}).find((t) => t.name === "Flaming Sphere"));
      await characters.getByRole("button", { name: "Cancel" }).first().click();
      await characters.getByRole("button", { name: "Add a companion" }).waitFor();
      const log = await openPanel("Log", characters);
      hold = false;
      for (const m of held.splice(0)) toPage!(m);
      // The answer arrives with the frames held back, and the page has it within moments: the Log stays open, nothing selected.
      await page.waitForTimeout(500);
      assert.equal(await log.count(), 1, "the late answer closed the Log");
      assert.ok(await log.evaluate((el) => (el as unknown as { open: boolean }).open), "the late answer hid the Log");
      assert.equal(await bar(page, "Flaming Sphere").count(), 0, "the late answer selected the new token");
      assert.deepEqual(watch.errors, []);
      await shots.take(page, "combat-companion-late-answer-log-open");
      await ops.send({ t: "token.delete", tokenId: sphere.id });
    } finally {
      await context.close();
    }
  });

  test("13e. Add a companion and Make a companion fit their pane, with no sideways scroll, at 1280 x 800, at 844 x 390 and at 480 x 320 at 130% (SFB-P-1)", async () => {
    const anaCdp = await anaContext.newCDPSession(ana);
    const goblin = goblinName(4);
    for (const view of [
      { width: 1280, height: 800, scale: 1 },
      { width: 844, height: 390, scale: 1, side: 47, bottom: 21 },
      { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      // Ana's Add a companion, with its longest turn label chosen.
      await setUp(ana, anaCdp, view);
      await openPanelOn(ana, "Characters");
      await ana.getByRole("button", { name: "Add a companion" }).click();
      const turn = ana.getByRole("combobox", { name: "Turn" });
      await turn.selectOption({ label: "On Bree's turn, listed under Bree" });
      await fitsSideways(turn, `Add a companion at ${label}`);
      await shots.take(ana, `combat-companion-form-fits-${view.width}`);
      await ana.getByRole("button", { name: "Cancel" }).first().click();
      // The DM's Make a companion in a goblin's Token settings, with Bree chosen.
      await setUp(dm, dmCdp, view);
      await openTracker(dm);
      await (await rowButton(dm, goblin)).click();
      await bar(dm, goblin).getByRole("button", { name: "Details", exact: true }).click();
      await dm.getByRole("heading", { name: goblin }).first().waitFor();
      await openFold(dm.locator("body"), "Token settings");
      await dm.getByRole("button", { name: "Make a companion", exact: true }).click();
      await dm.getByRole("combobox", { name: "Belongs to", exact: true }).selectOption({ label: "Bree" });
      await fitsSideways(dm.getByRole("combobox", { name: "Turn", exact: true }), `Make a companion at ${label}`);
      await shots.take(dm, `combat-make-companion-fits-${view.width}`);
      await dm.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    assert.equal(dmSocket.state!.tokens[run.goblins[4]!]!.companion, undefined, "nothing was sent");
  });

  test("13f. on a 390 px phone the companion forms start empty with no example values, have one Cancel, and show every turn choice whole (SFB-P-11)", async () => {
    const phone = { width: 390, height: 844, scale: 1, bottom: 34 };
    await setUp(ana, await anaContext.newCDPSession(ana), phone);
    await openPanelOn(ana, "Characters");
    await ana.getByRole("button", { name: "Add a companion" }).click();
    const form = ana.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
    for (const name of ["Name", "HP", "AC"]) {
      assert.equal(await form.getByRole("textbox", { name, exact: true }).getAttribute("placeholder"), null, `${name} shows an example that reads as its value`);
    }
    assert.equal(await form.getByRole("button", { name: "Cancel" }).count(), 1, "the form has one Cancel");
    await turnShowsWhole(form.getByRole("combobox", { name: "Turn" }), "Add a companion at 390");
    await shots.take(ana, "combat-companion-form-390");
    await form.getByRole("button", { name: "Cancel" }).click();
    // The DM's Make a companion, and the Companion section of the spirit's panel.
    await setUp(dm, dmCdp, phone);
    await openTracker(dm);
    await (await rowButton(dm, goblinName(4))).click();
    await bar(dm, goblinName(4)).getByRole("button", { name: "Details", exact: true }).click();
    const panel = dm.locator('dialog[data-rvtt-sheet][aria-label="Token"]');
    await openFold(panel, "Token settings");
    await panel.getByRole("button", { name: "Make a companion", exact: true }).click();
    await panel.getByRole("combobox", { name: "Belongs to", exact: true }).selectOption({ label: "Bree" });
    await turnShowsWhole(panel.getByRole("combobox", { name: "Turn", exact: true }), "Make a companion at 390");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await dm.keyboard.press("Escape");
    await openTracker(dm);
    await dm.getByRole("button", { name: /^Wildfire Spirit, acts on Bree's turn/ }).click();
    await bar(dm, "Wildfire Spirit").getByRole("button", { name: "Details", exact: true }).click();
    await openFold(panel, "Companion");
    await turnShowsWhole(panel.getByRole("combobox", { name: "Turn", exact: true }), "the spirit's Companion section at 390");
    await dm.keyboard.press("Escape");
  });

  test("13g. by keyboard, focus moves on when a control takes itself away: the companion forms, New character, and Revive in the bar, a row, a sub-row and the panel (SFB-P-3)", async () => {
    const focused = (page: Page) =>
      page.evaluate(() => {
        const a = (globalThis as unknown as { document: { activeElement: { tagName: string; hasAttribute(n: string): boolean; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
        if (!a) return "none";
        return `${a.tagName.toLowerCase()} ${a.hasAttribute("data-hp-vitals") ? "HP line" : (a.getAttribute("aria-label") ?? (a.textContent ?? "").trim())}`;
      });
    const press = async (page: Page, control: Locator) => {
      await control.focus();
      await page.keyboard.press("Enter");
    };
    const lands = async (page: Page, where: RegExp, label: string) => {
      try {
        await waitFor(label, async () => where.test(await focused(page)), 3_000);
      } catch {
        assert.fail(`${label}: focus is on "${await focused(page)}", not ${where}`);
      }
    };

    // Ana's Add a companion: into the title of the subpage it opens, and back to the opener on Cancel.
    await setUp(ana, await anaContext.newCDPSession(ana), { ...DESK, scale: 1 });
    await openSideTab(ana, "Characters");
    await press(ana, ana.getByRole("button", { name: "Add a companion" }));
    await lands(ana, /^h2 Add a companion for Bree/, "Add a companion opened");
    await press(ana, ana.getByRole("button", { name: "Cancel" }));
    await lands(ana, /^button Add a companion$/, "Add a companion cancelled");

    // The DM's New character, the same way.
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    await openSideTab(dm, "Characters");
    await press(dm, dm.getByRole("button", { name: "New character" }));
    await lands(dm, /^h2 New character/, "New character opened");
    await press(dm, dm.getByRole("button", { name: "Cancel" }));
    await lands(dm, /^button New character$/, "New character cancelled");

    // Make a companion on the chest: the first field, the opener again on Cancel, and done its section's label.
    await openSideTab(dm, "Outliner");
    await dm.getByRole("tabpanel", { name: "Outliner" }).getByRole("button", { name: /^Chest/ }).click();
    await bar(dm, "Chest").getByRole("button", { name: "Details" }).click();
    const panel = dm.getByRole("tabpanel", { name: "Token" });
    await panel.getByRole("heading", { name: "Chest" }).waitFor();
    await openFold(panel, "Token settings");
    await press(dm, panel.getByRole("button", { name: "Make a companion", exact: true }));
    await lands(dm, /^select Belongs to/, "Make a companion opened");
    await press(dm, panel.getByRole("button", { name: "Cancel", exact: true }));
    await lands(dm, /^button Make a companion$/, "Make a companion cancelled");
    await press(dm, panel.getByRole("button", { name: "Make a companion", exact: true }));
    await panel.getByRole("combobox", { name: "Belongs to", exact: true }).selectOption({ label: "Bree" });
    await press(dm, panel.getByRole("button", { name: "Make a companion", exact: true }));
    await waitFor("the chest a companion", () => dmSocket.state?.tokens[run.chest]?.companion);
    await lands(dm, /^button Token settings/, "Make a companion done");
    await ops.send({ t: "token.update", tokenId: run.chest, patch: { companion: null } });

    // Revive in the bar: to its frame, where Ctrl+Z still reaches the room's undo.
    const goblin = goblinName(10);
    const dead = () => ops.send({ t: "actor.life", target: { tokenId: run.goblins[10]! }, life: "dead" });
    await dead();
    await openTracker(dm);
    await (await rowButton(dm, goblin)).click();
    const b = bar(dm, goblin);
    await press(dm, b.getByRole("button", { name: "Revive" }));
    await lands(dm, new RegExp(`^div ${goblin} actions`), "Revive in the bar");
    await waitFor("the goblin alive", () => (goblinState(10)?.life === "alive" ? true : null));
    await dm.keyboard.press("Control+z");
    await waitFor("Ctrl+Z took the Revive back", () => (goblinState(10)?.life === "dead" ? true : null));
    // Revive in the row's options: to the row's button, the options still open.
    await openTracker(dm);
    await press(dm, dm.getByRole("button", { name: `${goblin} options` }));
    await press(dm, dm.locator("[data-round-section]").getByRole("button", { name: "Revive" }));
    await lands(dm, new RegExp(`^button ${goblin}[.,]`), "Revive in the row's options");
    await dm.getByRole("button", { name: `${goblin} options` }).click();
    // Revive in the panel's life controls: to its HP line, and Mark dead the same.
    await dead();
    await (await rowButton(dm, goblin)).click();
    await b.getByRole("button", { name: "Details" }).click();
    await panel.getByRole("heading", { name: goblin }).waitFor();
    await press(dm, panel.getByRole("button", { name: "Revive" }));
    await lands(dm, /^div HP line$/, "Revive in the panel");
    await press(dm, panel.getByRole("button", { name: "Mark dead" }));
    await lands(dm, /^div HP line$/, "Mark dead in the panel");
    await ops.send({ t: "actor.life", target: { tokenId: run.goblins[10]! }, life: "alive" });

    // Revive in a listed companion's options: to its sub-row's button.
    const spirit = Object.values(dmSocket.state!.tokens).find((t) => t.name === "Wildfire Spirit")!;
    await ops.send({ t: "actor.life", target: { tokenId: spirit.id }, life: "dead" });
    await openTracker(dm);
    await press(dm, dm.getByRole("button", { name: "Wildfire Spirit options" }));
    await press(dm, dm.locator("[data-round-section]").getByRole("button", { name: "Revive" }));
    await lands(dm, /^button Wildfire Spirit, acts on Bree's turn/, "Revive in the sub-row's options");
  });

  test("13h. turning a token's Hidden off shows its row to players, by its bar, the H key, the token panel and a group's bar, and the tracker still hides a row on its own", async () => {
    await setUp(dm, dmCdp, { ...DESK, scale: 1 });
    const pair = [run.goblins[2]!, run.goblins[3]!];
    const rowOf = (tokenId: string) => dmSocket.state?.encounter?.entries.find((e) => e.tokenId === tokenId);
    const anaSees = (tokenId: string) => anaSocket.state?.encounter?.entries.some((e) => e.tokenId === tokenId) ?? false;
    const missing = pair.filter((id) => !rowOf(id));
    if (missing.length > 0) await ops.send({ t: "encounter.add", entries: missing.map((tokenId) => ({ id: randomUUID(), tokenId, value: 5 })) });
    const hide = async () => {
      await dm.keyboard.press("Escape");
      await ops.send({ t: "token.updateMany", tokenIds: pair, patch: { visibility: "dm" } });
      for (const id of pair) await ops.send({ t: "encounter.update", entryId: rowOf(id)!.id, patch: { hidden: true } });
      await waitFor("both hidden, rows too", () => (pair.every((id) => dmSocket.state?.tokens[id]?.visibility === "dm" && rowOf(id)?.hidden === true) ? true : null));
      await waitFor("Ana sees neither row", () => (pair.some(anaSees) ? null : true));
    };
    const shown = async (tokenIds: string[], how: string) => {
      await waitFor(`${how}: the tokens and their rows shown`, () => (tokenIds.every((id) => dmSocket.state?.tokens[id]?.visibility === "all" && rowOf(id)?.hidden === false) ? true : null));
      await waitFor(`${how}: Ana sees the rows`, () => (tokenIds.every(anaSees) ? true : null));
    };
    const pick = async () => {
      await openTracker(dm);
      await (await rowButton(dm, "Goblin 3")).click();
      await bar(dm, "Goblin 3").waitFor();
    };

    await hide();
    await pick();
    await bar(dm, "Goblin 3").getByRole("button", { name: "Hidden", exact: true }).click();
    await shown([pair[0]!], "the bar");

    await hide();
    await pick();
    await dm.keyboard.press("h");
    await shown([pair[0]!], "the H key");

    await hide();
    await pick();
    await openSideTab(dm, "Token");
    const panel = dm.getByRole("tabpanel", { name: /^Token/ });
    await openFold(panel, "Token settings");
    await panel.getByRole("switch", { name: /^Hidden from players/ }).click();
    await shown([pair[0]!], "the panel's switch");

    await hide();
    await pick();
    await bar(dm, "Goblin 3").getByRole("button", { name: "Multi-select", exact: true }).click();
    await tapCell(dm, run.bounds, { x: 15, y: 2 });
    const group = dm.getByRole("dialog", { name: "2 selected tokens" });
    await group.getByRole("button", { name: "Hidden", exact: true }).click();
    await shown(pair, "a group's bar");
    await shots.take(dm, "combat-hidden-off-rows-shown");
    await dm.keyboard.press("Escape");

    // A row the tracker hides stays hidden while its token shows.
    await ops.send({ t: "encounter.update", entryId: rowOf(pair[0]!)!.id, patch: { hidden: true } });
    await waitFor("Ana loses that row alone", () => (!anaSees(pair[0]!) && anaSees(pair[1]!) ? true : null));
    assert.equal(dmSocket.state?.tokens[pair[0]!]?.visibility, "all");
    await ops.send({ t: "encounter.update", entryId: rowOf(pair[0]!)!.id, patch: { hidden: false } });
  });

  test("13i. back on the party alone, an ogre added mid-fight stays out of Ana's order and frames until its turn comes, then joins her tracker in its place (docs/design-v1-combat-flow.md 11)", async () => {
    await ops.send({ t: "room.update", settings: { playersSeeOrder: "party" } });
    const ogre = randomUUID();
    await ops.send({ t: "token.create", token: { id: ogre, sceneId: run.sceneId, size: "large", visibility: "all", kind: "monster", name: "Ogre", x: 20, y: 12, disposition: "hostile", actor: { inline: actor(59, 11) } } });
    await ops.send({ t: "encounter.add", entries: [{ id: "e-ogre", tokenId: ogre, value: -5 }] });
    await waitFor("the ogre's row for the DM", () => (dmSocket.state?.encounter?.entries.some((e) => e.id === "e-ogre") ? true : null));
    assert.equal(anaSocket.everSaw('"e-ogre"'), false, "the ogre's row reached Ana before its turn");
    const tracker = await openTracker(ana);
    assert.equal(await tracker.getByRole("button", { name: /^Ogre[.,]/ }).count(), 0);
    // The DM's row says players do not see it yet, until its turn comes.
    await openTracker(dm);
    await rowButton(dm, "Ogre");
    const secret = async () => (await descriptions(dmCdp, /^Ogre[.,]/)).some((d) => d.includes("Secret until its turn"));
    await waitFor("the DM's tag on the ogre's row", async () => ((await secret()) ? true : null));
    for (let step = 0; step < 20 && dmSocket.state?.encounter?.activeEntryId !== "e-ogre"; step++) {
      const was = dmSocket.state!.encounter!;
      await ops.send({ t: "encounter.next" });
      await waitFor("the DM's next turn", () => (dmSocket.state?.encounter?.activeEntryId !== was.activeEntryId || dmSocket.state?.encounter?.round !== was.round ? true : null));
      if (dmSocket.state?.encounter?.activeEntryId !== "e-ogre") assert.equal(anaSocket.everSaw('"e-ogre"'), false, "the ogre's row reached Ana before its turn");
    }
    assert.equal(dmSocket.state?.encounter?.activeEntryId, "e-ogre");
    await waitFor("the ogre in Ana's order on its turn", () => (anaSocket.state?.encounter?.activeEntryId === "e-ogre" ? true : null));
    const entries = anaSocket.state!.encounter!.entries;
    assert.equal(entries.at(-1)?.id, "e-ogre", "last, in its place");
    await rowButton(ana, "Ogre");
    await waitFor("the DM's tag gone from the ogre's row", async () => ((await secret()) ? null : true));
    // Its next turn keeps it there.
    await ops.send({ t: "encounter.next" });
    await waitFor("the ogre's turn over", () => (anaSocket.state?.encounter?.activeEntryId !== "e-ogre" ? true : null));
    assert.ok(anaSocket.state!.encounter!.entries.some((e) => e.id === "e-ogre"));
    await ops.send({ t: "room.update", settings: { playersSeeOrder: "all" } });
  });

  test("14. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(anaConsole.errors, [], "Ana's page logged errors");
    assert.deepEqual(cyConsole.errors, [], "Cy's page logged errors");
  });
});
