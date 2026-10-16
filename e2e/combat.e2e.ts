import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

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
  await page.goto(`${server.origin}/r/${run.roomId}`);
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
      const rest = await measure(dm);
      const scroller = rest.scroller.height;
      // The form follows the scroller's measured height (client/features/encounter/logic.ts roundHeaderForm).
      if (rest.sticky && rest.compactRow > 0 && rest.header.height >= rest.compactRow + 8) {
        assert.ok(scroller >= 3 * rest.header.height - 1, `${label}: a full header sticks in a scroller of ${scroller}, under three of it (${rest.header.height})`);
      }
      // The page measures in its own layout pixels, which the interface size scales on screen.
      if (!rest.sticky) assert.ok(scroller / view.scale < 132 + 1, `${label}: a scroller of ${scroller / view.scale} layout px should hold a sticky header`);
      if (rest.sticky && scroller / view.scale < 132 - 1) assert.fail(`${label}: a header sticks in a scroller of ${scroller / view.scale} layout px`);
      // Scrolled into the list, the header keeps the scroller's top, and a whole row shows under it.
      await scrollPane(dm, 220);
      const mid = await measure(dm);
      if (mid.sticky) {
        assert.ok(Math.abs(mid.header.top - mid.scroller.top) <= 1, `${label}: the header left the scroller's top: ${JSON.stringify({ header: mid.header, scroller: mid.scroller })}`);
        assert.ok(mid.row, `${label}: no whole row under the stuck header: ${JSON.stringify({ header: mid.header, scroller: mid.scroller })}`);
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
      const box = dm.locator("[data-round-section] ol > li").nth(row).getByRole("button", { name: /initiative \d+/ });
      await box.focus();
      await dm.waitForTimeout(100);
      return wholeInReach(box);
    };
    await setUp(dm, dmCdp, view);
    await openTracker(dm);
    await sheet.waitFor();
    /*
     * The sheet's body is about 169 layout px (docs/design-v1-layout-hierarchy.md
     * 4.2, which leaves out the dialog's two 1 px borders), right at three
     * full headers, so the header sticks in full or as one compact row,
     * whichever the measured body allows (logic.ts roundHeaderForm).
     */
    const rest = await measure(dm);
    assert.ok(Math.abs(rest.scroller.height / view.scale - 168) <= 1.5, `the very short sheet's body is ${rest.scroller.height / view.scale} px, not about 169`);
    assert.ok(rest.sticky, "the header does not stick in the very short sheet");
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
    assert.ok(await valueBoxInReach(7), "a value box is out of reach under the header");
    assert.ok(await wholeInReach(dm.locator("[data-round-header]").getByRole("button", { name: "Next" })), "Next is out of reach");
    await shots.take(dm, "combat-header-480-130-very-short-bar-folded");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
  });

  test("3. on a sheet between three compact rows and three full headers tall, the header is one 44 px row, still sticky", async () => {
    await setUp(dm, dmCdp, { width: 844, height: 390, scale: 1 });
    await openTracker(dm);
    const at390 = (await measure(dm)).scroller.height;
    // The same phone shorter by what brings its sheet's scroller to 150 px, as the turn band does at 844 x 390.
    await setUp(dm, dmCdp, { width: 844, height: 390 - Math.round(at390 - 150), scale: 1 });
    await openTracker(dm);
    await scrollPane(dm, 200);
    const m = await measure(dm);
    assert.ok(m.scroller.height >= 132 && m.scroller.height < 168, `the scroller is ${m.scroller.height}, not between 132 and 168`);
    assert.ok(m.sticky, "the compact header sticks");
    assert.ok(Math.abs(m.compactRow - 44) <= 1, `the compact header's row is ${m.compactRow} px, not 44`);
    assert.ok(m.row, "a whole row shows under the compact header");
    // The whole whose-turn line stays in the header for a screen reader, ending in an ellipsis on screen.
    assert.match((await dm.locator("[data-round-header]").textContent()) ?? "", /Round 1.*Bree's turn|Round 1.*Press Start/);
    await shots.take(dm, "combat-header-compact");
  });

  test("4. scrolling to Auto initiative takes the header away, and focus moving through the rows never lands under it", async () => {
    await setUp(dm, dmCdp, { width: 390, height: 844, scale: 1 });
    const section = await openTracker(dm);
    // Auto initiative's heading at the scroller's top: the round section has scrolled past, so its header went with it.
    await dm.getByRole("heading", { name: "Auto initiative" }).evaluate((h) => (h as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "start" }));
    const gone = await measure(dm);
    const auto = await dm.getByRole("heading", { name: "Auto initiative" }).boundingBox();
    assert.ok(auto && gone.header.bottom <= auto.y + 1, `the header still covers Auto initiative: ${JSON.stringify({ header: gone.header, auto })}`);
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
    assert.deepEqual(await headings(dm), ["Auto initiative", "Initiative", "Add to the fight", "Several at once", "HP changes", "Turn timer", "End", "This device"]);
    // Twelve goblins with values: re-roll them, and the card of what it rolled sits under the button.
    await dm.getByRole("checkbox", { name: "Re-roll monsters that have a value" }).check();
    await dm.getByRole("button", { name: /^Auto initiative \(\d+\)/ }).click();
    const card = dm.getByRole("region", { name: "Auto initiative results" });
    await card.waitFor();
    const button = await dm.getByRole("button", { name: /^Auto initiative \(\d+\)/ }).boundingBox();
    const cardBox = await card.boundingBox();
    assert.ok(button && cardBox && cardBox.y > button.y, "the roll card sits under Auto initiative's button");
    await shots.take(dm, "combat-order-dm");
    await openTracker(ana);
    assert.deepEqual(await headings(ana), ["Several at once", "HP changes", "This device"], "Bree is in the fight already, so Join the fight is gone");
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
    await dm.getByRole("tab", { name: "Outliner" }).click();
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

  test("9. Ana adds Spiritual Weapon and Wildfire Spirit beside Bree without Players can create their own characters, and the DM's log names each", async () => {
    await setUp(ana, await anaContext.newCDPSession(ana), { ...DESK, scale: 1 });
    await ana.getByRole("tab", { name: "Characters" }).click();
    const add = async (name: string, what: "A creature" | "An effect", turn: string, hp?: string) => {
      await ana.getByRole("button", { name: "Add a companion" }).click();
      await ana.getByRole("textbox", { name: "Name" }).fill(name);
      await ana.getByRole("radio", { name: what }).check();
      await ana.getByRole("combobox", { name: "Turn" }).selectOption({ label: turn });
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
    const weapon = await add("Spiritual Weapon", "An effect", "On Bree's turn, not listed");
    await bar(ana, "Spiritual Weapon").waitFor();
    await ana.getByRole("tab", { name: "Characters" }).click();
    const spirit = await add("Wildfire Spirit", "A creature", "On Bree's turn, listed under Bree", "15");
    for (const t of [weapon, spirit]) {
      assert.ok(Math.abs(t.x - 5) <= 1.01 && Math.abs(t.y - 5) <= 1.01, `${t.name} landed within 5 ft of Bree: ${t.x},${t.y}`);
      assert.deepEqual(t.ownerIds, [run.anaId]);
    }
    const lines = dmSocket.state!.log.filter((e) => e.data?.type === "companion").map((e) => (e.data?.type === "companion" ? e.data.name : ""));
    assert.deepEqual(lines, ["Spiritual Weapon", "Wildfire Spirit"]);
    assert.equal(anaSocket.state!.log.some((e) => e.data?.type === "companion"), false, "the line is the DM's alone");
    await dm.getByRole("tab", { name: "Log" }).click();
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
    await ana.getByRole("tab", { name: "Characters" }).click();
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
    await ana.getByRole("tab", { name: "Characters" }).click();
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
    await ana.getByRole("button", { name: /^Wildfire Spirit initiative not set/ }).click();
    await ana.getByRole("textbox", { name: "Wildfire Spirit initiative" }).fill("13");
    await ana.keyboard.press("Enter");
    await waitFor("its value", () => (dmSocket.state?.encounter?.entries.find((e) => e.tokenId === spirit.id)?.value === 13 ? true : null));
    assert.match((await row.textContent()) ?? "", /Companion of Bree/);
    const weapon = Object.values(dmSocket.state!.tokens).find((t) => t.name === "Spiritual Weapon")!;
    await ana.getByRole("tab", { name: "Characters" }).click();
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
    await dm.getByRole("tab", { name: "DM" }).click();
    await dm.getByRole("button", { name: "View", exact: true }).first().click();
    const preview = dm.getByRole("dialog", { name: /^Viewing as / });
    await preview.waitFor();
    await preview.getByRole("tab", { name: "Initiative" }).click();
    await preview.getByRole("button", { name: "Wildfire Spirit, acts on Bree's turn. Show it on the map with its actions." }).waitFor();
    await shots.take(dm, "combat-viewing-as");
    await preview.getByRole("tab", { name: "Characters" }).click();
    await preview.getByRole("button", { name: "Add a companion" }).click();
    await preview.getByRole("textbox", { name: "Name" }).fill("Owl");
    await preview.getByRole("textbox", { name: "HP" }).fill("1");
    await preview.getByRole("textbox", { name: "Name" }).click();
    await preview.getByRole("button", { name: "Add and place" }).click();
    await preview.getByText("Read-only: nothing you do here is saved.").waitFor();
    await preview.getByRole("button", { name: "Cancel" }).first().click();
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
    await ana.getByRole("tab", { name: "Characters" }).click();
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

  test("14. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(anaConsole.errors, [], "Ana's page logged errors");
    assert.deepEqual(cyConsole.errors, [], "Cy's page logged errors");
  });
});
