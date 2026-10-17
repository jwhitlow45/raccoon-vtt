import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * What floats over a phone's map under a sheet (docs/design-v1-visual.md
 * 3.2.1), and the turn strip in a landscape phone's top bar (3.2):
 *
 * - The token bar and the fight alerts fold under a portrait sheet into a
 *   dock on its edge, and focus goes where 3.2.1 says after each fold,
 *   Show, Close, Escape and Back. Folded controls cannot be seen or
 *   reached by Tab, and a half-typed HP entry survives.
 * - The dock clears the top bars and the sheet keeps its 120 px, at every
 *   interface size, on real phone sizes with and without safe areas, and
 *   in a forced case where the dock's buttons move into the sheet's header.
 * - A time-up under a sheet is read out by Room's status region.
 * - Every top bar button stays on screen in a landscape fight, for the DM
 *   and for a player on their turn, at 100% and 130%.
 *
 * The cases that mix a selected token with a roll request wait on the
 * rolls' side of the dock (part 5 of the design pass): set
 * FOLD_WITHOUT_ROLLS=1 to skip them where that part is not merged yet.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus two, which it shares with
 * table.e2e.ts and vision.e2e.ts, since the runs go one after another. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 2;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const WITHOUT_ROLLS = process.env.FOLD_WITHOUT_ROLLS === "1";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-fold-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E fold ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 0, h: 0 },
  thorn: { id: randomUUID(), characterId: randomUUID(), x: 0, y: 0 },
  goblins: [randomUUID(), randomUUID(), randomUUID()],
  entries: { thorn: randomUUID(), goblins: [randomUUID(), randomUUID(), randomUUID()] },
};

const SCALES = [0.85, 1, 1.15, 1.3] as const;

/** The few DOM parts the page functions read, typed by hand: the e2e files compile without the DOM library. */
type El = {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  closest(selector: string): El | null;
  querySelector(selector: string): El | null;
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; height: number };
};
type Doc = { activeElement: El | null; querySelector(selector: string): El | null; querySelectorAll(selector: string): ArrayLike<El> };

function actor(hp = 20) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 14,
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

/** Sets the window, the interface size and the safe areas, then loads the room again. */
async function setUp(page: Page, cdp: CDPSession, view: { width: number; height: number; scale: number; top?: number; bottom?: number }): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: view.top ?? 0, bottom: view.bottom ?? 0, left: 0, right: 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

function topBar(page: Page) {
  return page.locator("header").filter({ has: page.locator("h1") });
}

function panelsButton(page: Page) {
  return page.locator('nav[aria-label="Tools"] button[title="Panels"]');
}

/** The token bar as the page holds it, folded or not. */
function barFrame(page: Page, name = "Thorn actions") {
  return page.locator(`[role="dialog"][aria-label="${name}"]`);
}

/** What has focus: its name, role and tag, and whether it sits in the token bar or the alerts column. */
function focused(page: Page) {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: Doc }).document.activeElement;
    return {
      name: a?.getAttribute("aria-label") ?? a?.textContent?.trim() ?? "",
      role: a?.getAttribute("role") ?? "",
      tag: a?.tagName ?? "",
      inBar: a?.closest('[role="dialog"][aria-label$="actions"]') != null,
      inColumn: a?.closest("[data-alert]") != null,
      inCard: a?.closest('[aria-label="The DM asks for a roll"]') != null,
    };
  });
}

/** Opens the list of panels with a click that leaves focus where it is, as a tap on a phone that does not focus buttons would. */
async function openPanelsKeepingFocus(page: Page): Promise<void> {
  await panelsButton(page).dispatchEvent("click");
  await page.getByRole("region", { name: "Panels" }).waitFor();
}

async function tapThorn(page: Page): Promise<void> {
  const p = await pagePoint(page, run.bounds, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 });
  await page.mouse.click(p.x, p.y);
  await page.getByRole("dialog", { name: "Thorn actions" }).waitFor();
}

/** The DM selects Thorn through the Party panel, which closes its sheet and opens Thorn's bar. */
async function selectThornAsDm(): Promise<void> {
  await panelsButton(dm).click();
  await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Party/ }).click();
  await dm.getByRole("button", { name: /^Thorn: HP/ }).click();
  await dm.getByRole("dialog", { name: "Thorn actions" }).waitFor();
}

/**
 * Every button in the top bar and its turn band lies inside the window. It
 * waits for the bar to settle, since a bar that overflows hands the strip
 * to the band. The fight alerts column hangs from the bar's element too,
 * and scrolls on its own, so its cards are left out.
 */
async function assertBarInWindow(page: Page, label: string): Promise<void> {
  const size = page.viewportSize()!;
  const outside = async () =>
    topBar(page)
      .locator("button")
      .evaluateAll(
        (buttons, s) =>
          buttons
            .filter((b) => b.closest("[data-alert]") === null)
            .map((b) => ({ name: b.getAttribute("aria-label") ?? b.textContent ?? "", r: b.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.left < -0.5 || r.right > s.width + 0.5 || r.top < -0.5 || r.bottom > s.height + 0.5))
            .map(({ name, r }) => `${name} at ${Math.round(r.left)}-${Math.round(r.right)}`),
        size,
      );
  let last: string[] = [];
  for (let i = 0; i < 20; i++) {
    last = await outside();
    if (last.length === 0) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${label}: top bar buttons outside the window: ${last.join(", ")}`);
}

type Box = { top: number; bottom: number; left: number; right: number; height: number };

async function boxes(page: Page) {
  return page.evaluate(() => {
    const document = (globalThis as unknown as { document: Doc }).document;
    const box = (el: El | null | undefined): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const bar = Array.from(document.querySelectorAll("header")).find((h) => h.querySelector("h1"));
    return {
      bars: box(bar),
      dock: box(document.querySelector("[data-rvtt-dock]")),
      // The sheet's outer box, its border included: its region is a section inside the dialog.
      sheet: box(document.querySelector('dialog[data-rvtt-sheet][aria-label="Panels"]')),
      toolbar: box(document.querySelector('nav[aria-label="Tools"]')),
    };
  });
}

/** Every button in a sheet's header lies inside the sheet, side by side, each a 44 px target at `scale`. */
async function assertHeaderFits(sheet: Locator, scale: number, label: string): Promise<void> {
  const box = await sheet.boundingBox();
  assert.ok(box, `${label}: no sheet`);
  const header = sheet.locator("header").first();
  const buttons = await header.locator("button").evaluateAll((els) =>
    els
      .map((e) => ({ name: e.getAttribute("aria-label") ?? e.textContent ?? "", r: e.getBoundingClientRect() }))
      // An upright sheet's Full screen is visually hidden until it has keyboard focus (docs/design-v1-sheet-swipe.md 4.7), so it is no target on screen. Every other header button is held to the rule.
      .filter(({ name, r }) => r.width > 0 && name !== "Full screen")
      .map(({ name, r }) => ({ name, left: r.left, right: r.right, h: r.height })),
  );
  assert.ok(buttons.length > 0, `${label}: the header has no buttons`);
  for (const [i, b] of buttons.entries()) {
    assert.ok(b.left >= box.x - 0.5 && b.right <= box.x + box.width + 0.5, `${label}: "${b.name}" leaves the sheet (${Math.round(b.left)}-${Math.round(b.right)} in ${Math.round(box.x)}-${Math.round(box.x + box.width)})`);
    assert.ok(b.h >= 44 * scale - 1, `${label}: "${b.name}" is under 44 px`);
    const next = buttons[i + 1];
    if (next) assert.ok(b.right <= next.left + 0.5, `${label}: "${b.name}" and "${next.name}" overlap`);
  }
}

/**
 * The fight alerts column's last button, scrolled into its view, lies above
 * the toolbar and takes a tap: the column scrolls as a whole rather than
 * running under the toolbar, where its last button showed through and took
 * no tap.
 */
async function assertColumnReachable(page: Page, label: string): Promise<void> {
  const result = await page.locator("[data-alert]").first().evaluate((alert) => {
    type Node = El & {
      parentElement: Node | null;
      scrollHeight: number;
      clientHeight: number;
      querySelectorAll(selector: string): ArrayLike<Node>;
      getClientRects(): ArrayLike<unknown>;
      scrollIntoView(options: { block: string }): void;
      contains(other: unknown): boolean;
    };
    const g = globalThis as unknown as { document: Doc & { elementFromPoint(x: number, y: number): unknown }; getComputedStyle(el: unknown): { overflowY: string } };
    let column = (alert as unknown as Node).parentElement;
    while (column && g.getComputedStyle(column).overflowY !== "auto") column = column.parentElement;
    if (!column) return { error: "no scrolling column" };
    const buttons = Array.from(column.querySelectorAll("button")).filter((b) => b.getClientRects().length > 0);
    const last = buttons.at(-1);
    if (!last) return { error: "no button in the column" };
    last.scrollIntoView({ block: "nearest" });
    const r = last.getBoundingClientRect();
    const toolbar = g.document.querySelector('nav[aria-label="Tools"]')?.getBoundingClientRect();
    const hit = g.document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return {
      name: last.getAttribute("aria-label") ?? last.textContent ?? "",
      bottom: r.bottom,
      toolbarTop: toolbar?.top ?? Number.POSITIVE_INFINITY,
      tappable: hit === last || last.contains(hit),
      scrolls: column.scrollHeight > column.clientHeight,
    };
  });
  assert.ok(!("error" in result), `${label}: ${"error" in result ? result.error : ""}`);
  if ("error" in result) return;
  assert.ok(result.bottom <= result.toolbarTop + 0.5, `${label}: "${result.name}" ends at ${result.bottom}, under the toolbar at ${result.toolbarTop}`);
  assert.ok(result.tappable, `${label}: "${result.name}" is covered`);
}

/** The dock on the sheet's edge: clear of the bars, on the sheet, and the sheet at least 120 layout px, clear of the toolbar. */
async function assertDocked(page: Page, scale: number, label: string): Promise<void> {
  await page.locator("[data-rvtt-dock]").waitFor();
  // The dock follows the sheet's height once it is measured.
  await page.waitForTimeout(150);
  const b = await boxes(page);
  const size = page.viewportSize()!;
  assert.ok(b.bars && b.dock && b.sheet && b.toolbar, `${label}: missing ${JSON.stringify(b)}`);
  assert.ok(b.dock.top >= b.bars.bottom - 0.5, `${label}: the dock (top ${b.dock.top}) runs under the top bars (bottom ${b.bars.bottom})`);
  assert.ok(Math.abs(b.dock.bottom - b.sheet.top) <= 1.5, `${label}: the dock (bottom ${b.dock.bottom}) is not on the sheet's edge (${b.sheet.top})`);
  assert.ok(b.sheet.height >= 120 * scale - 1, `${label}: the sheet is ${b.sheet.height} px, under 120 layout px`);
  assert.ok(b.sheet.bottom <= b.toolbar.top + 1, `${label}: the sheet runs under the toolbar`);
  assert.ok(b.dock.left >= 0 && b.dock.right <= size.width, `${label}: the dock leaves the window`);
}

describe("raccoon-vtt: what floats over a phone's map folds under a sheet", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    playerContext = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    player = await playerContext.newPage();
    playerConsole.attach(player);
    playerCdp = await playerContext.newCDPSession(player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      console.error(`[${dmConsole.label}] errors`, dmConsole.errors, "warnings", dmConsole.warnings);
      console.error(`[${playerConsole.label}] errors`, playerConsole.errors, "warnings", playerConsole.warnings);
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

  test("1. a DM's room with Pat's Thorn and three goblins", async () => {
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

    // Pat joins from the phone, whose cookies the request shares.
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    const patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const cx = Math.floor(run.bounds.w / 2);
    const cy = Math.floor(run.bounds.h / 3);
    run.thorn = { ...run.thorn, x: cx, y: cy };
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    for (const [i, id] of run.goblins.entries()) {
      await ops.send(token(id, { kind: "monster", name: `Goblin ${i + 1}`, x: cx + 2 + i, y: cy + 3, disposition: "hostile", actor: { inline: actor() } }));
    }
    await waitFor("the goblins in the DM's view", () => run.goblins.every((id) => dmSocket.state?.tokens[id]) || null);

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("2. the top bar keeps every button on screen as a fight starts and the turn comes to the player, at a fixed size (3.2)", async () => {
    await setUp(dm, dmCdp, { width: 667, height: 375, scale: 1 });
    await setUp(player, playerCdp, { width: 667, height: 375, scale: 1 });
    await assertBarInWindow(dm, "DM before the fight");
    await assertBarInWindow(player, "player before the fight");

    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.entries.goblins[0], tokenId: run.goblins[0], value: 18 },
        { id: run.entries.thorn, tokenId: run.thorn.id, value: 15 },
        { id: run.entries.goblins[1], tokenId: run.goblins[1], value: 10 },
        { id: run.entries.goblins[2], tokenId: run.goblins[2], value: 5 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await player.getByRole("button", { name: /^Initiative, round 1\. Another creature's turn|^Initiative, round 1\. Goblin 1/ }).waitFor();
    await assertBarInWindow(dm, "DM, the goblin's turn");
    await assertBarInWindow(player, "player, the goblin's turn");

    await ops.send({ t: "encounter.next" });
    await player.getByRole("button", { name: "End turn" }).waitFor();
    await assertBarInWindow(player, "player on their turn");
    await assertBarInWindow(dm, "DM, the player's turn");
    await shots.take(player, "fold-landscape-player-turn");
  });

  for (const size of [
    { width: 844, height: 390 },
    { width: 667, height: 375 },
  ]) {
    for (const scale of [1, 1.3]) {
      const label = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
      test(`3. every top bar button stays on screen in a landscape fight: ${label}`, async () => {
        await setUp(dm, dmCdp, { ...size, scale });
        await dm.getByRole("button", { name: /^Initiative, round/ }).waitFor();
        await assertBarInWindow(dm, `DM, ${label}`);
        await setUp(player, playerCdp, { ...size, scale });
        await player.getByRole("button", { name: "End turn" }).waitFor();
        await assertBarInWindow(player, `player on their turn, ${label}`);
        if (size.width === 844 && scale === 1) {
          // The bar has room here, so the strip sits in its row rather than in a band of its own (F22).
          const strip = await player.getByRole("button", { name: /^Initiative, round/ }).boundingBox();
          const bar = await player.locator("header h1").boundingBox();
          assert.ok(strip && bar && Math.abs(strip.y + strip.height / 2 - (bar.y + bar.height / 2)) < 8, "the turn strip is not in the top bar's row");
          await shots.take(player, "fold-landscape-strip-in-bar");
        }
      });
    }
  }

  test("3. at 844 x 390 a goblin's turn shows its whole name, in the bar or in the band", async () => {
    await setUp(dm, dmCdp, { width: 844, height: 390, scale: 1 });
    await setUp(player, playerCdp, { width: 844, height: 390, scale: 1 });
    // Back to the goblin before Thorn, whom the player may not see: "Another creature", which a phone's bar cut to "Another cre…".
    await ops.send({ t: "encounter.prev" });
    await player.getByRole("button", { name: /^Initiative, round 1\. (Another creature|Goblin 1)'s turn/ }).waitFor();
    for (const [page, who] of [
      [dm, "DM"],
      [player, "player"],
    ] as const) {
      await assertBarInWindow(page, `${who}, a goblin's turn`);
      const names = await page.locator("[data-rvtt-strip-name]").evaluateAll((els) =>
        els.map((e) => {
          const el = e as unknown as { textContent: string | null; scrollWidth: number; clientWidth: number };
          return { text: el.textContent ?? "", scroll: el.scrollWidth, client: el.clientWidth };
        }),
      );
      assert.equal(names.length, 1, `${who}: one turn strip`);
      for (const n of names) assert.ok(n.scroll <= n.client, `${who}: the strip's name "${n.text}" is cut, ${n.scroll} px in ${n.client}`);
    }
    await shots.take(player, "fold-landscape-goblin-turn");
    await ops.send({ t: "encounter.next" });
    await player.getByRole("button", { name: "End turn" }).waitFor();
  });

  test("4. the token bar folds under a portrait sheet, keeps its state, and focus follows (3.2.1)", async () => {
    await setUp(player, playerCdp, { width: 375, height: 667, scale: 1 });
    await tapThorn(player);
    const hp = barFrame(player).getByLabel("HP change");
    await hp.fill("7");
    await hp.focus();

    // Folding with focus in the bar's body: focus moves to the dock's Show button.
    await openPanelsKeepingFocus(player);
    await player.getByRole("group", { name: "Thorn actions" }).waitFor();
    assert.equal(await barFrame(player).getAttribute("hidden"), "", "the bar did not fold");
    assert.equal(await player.getByRole("dialog", { name: "Thorn actions" }).count(), 0, "the folded bar is still in the accessibility tree");
    assert.equal((await focused(player)).name, "Show Thorn actions");
    // The first "Close" on the page is still the sheet's, which the other runs' helpers rely on (5.4).
    assert.equal(await player.getByRole("button", { name: /^Close/ }).first().getAttribute("aria-label"), "Close Panels");
    await shots.take(player, "fold-dock-token");

    // Tab never reaches a folded control.
    for (let i = 0; i < 30; i++) {
      await player.keyboard.press("Tab");
      const f = await focused(player);
      assert.equal(f.inBar, false, `Tab reached the folded bar: ${f.name}`);
    }

    // Show: the sheet closes and focus goes to the bar's frame, which unfolds as it was.
    await player.getByRole("button", { name: "Show Thorn actions" }).click();
    await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
    assert.deepEqual(await focused(player).then((f) => [f.name, f.role]), ["Thorn actions", "dialog"]);
    assert.equal(await hp.inputValue(), "7", "the typed HP did not survive the fold");

    // Escape closes the sheet, and focus, which was in the sheet, goes to the bar's frame.
    await panelsButton(player).click();
    await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).focus();
    await player.keyboard.press("Escape");
    await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
    assert.equal((await focused(player)).name, "Thorn actions", "focus after Escape");
    assert.equal(await hp.inputValue(), "7");

    // Back does the same.
    await panelsButton(player).click();
    await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).focus();
    await player.goBack();
    await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
    assert.equal((await focused(player)).name, "Thorn actions", "focus after Back");
    assert.equal(await hp.inputValue(), "7");

    // Close in the dock lets go of the token. The sheet stays, and focus goes to its back button.
    await panelsButton(player).click();
    await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).click();
    await player.getByRole("region", { name: "Log" }).waitFor();
    await player.getByRole("group", { name: "Thorn actions" }).getByRole("button", { name: "Close" }).click();
    await barFrame(player).waitFor({ state: "detached" });
    assert.equal((await focused(player)).name, "All panels", "focus after the dock's Close");
    assert.equal(await player.locator("[data-rvtt-dock]").count(), 0, "the dock stayed with nothing in it");
    await player.getByRole("button", { name: "Close Log" }).click();
  });

  test("5. a time-up under a sheet is read out, and the alerts summary shows it (3.2.1)", async () => {
    await ops.send({ t: "room.update", settings: { turnTimerSec: 4 } });
    // Round on to Thorn's next turn, a new one, so its clock starts with the timer on.
    for (let i = 0; i < 4; i++) await ops.send({ t: "encounter.next" });
    await player.getByRole("button", { name: /^Initiative, round 2\. Your turn/ }).waitFor();
    await panelsButton(player).click();
    await player.getByRole("region", { name: "Panels" }).waitFor();

    const status = player.locator("[data-rvtt-fold-status]");
    await waitFor("the status region to read the time-up", async () => /Time is up for your turn/.test((await status.textContent()) ?? ""), 15_000);
    const summary = player.getByRole("button", { name: /^Time is up/ });
    await summary.waitFor();
    assert.equal(await player.locator('[data-alert="timeUp"]').isVisible(), false, "the column did not fold");
    await shots.take(player, "fold-dock-time-up");

    // The summary closes the sheet and shows the alert it names.
    await summary.click();
    await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
    const f = await focused(player);
    assert.ok(f.inColumn && /Time is up for your turn/.test(f.name), `focus after the summary: ${JSON.stringify(f)}`);

    // Folding with focus in the column moves it to the summary.
    await openPanelsKeepingFocus(player);
    assert.match((await focused(player)).name, /^Time is up/);
    await player.getByRole("button", { name: "Close Panels" }).click();
    await player.locator('[data-alert="timeUp"]').click();
    await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
  });

  for (const size of [
    { width: 320, height: 480 },
    { width: 375, height: 667 },
  ]) {
    for (const scale of SCALES) {
      const label = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
      test(`6. in a fight the dock clears the top bars and the sheet keeps 120 px: ${label}`, async () => {
        await setUp(dm, dmCdp, { ...size, scale });
        // A DM's portrait bar holds the name, the chip, Undo, Redo and Fit: the chip gives way to its dot before Fit leaves the screen.
        await assertBarInWindow(dm, `DM, ${label}`);
        await selectThornAsDm();
        await panelsButton(dm).click();
        await assertDocked(dm, scale, label);
        await dm.getByRole("button", { name: "Close Panels" }).click();
        await dm.keyboard.press("Escape");
      });
    }
  }

  for (const profile of [
    { width: 375, height: 667, top: 0, bottom: 0 },
    { width: 375, height: 812, top: 47, bottom: 34 },
  ]) {
    for (const scale of [1, 1.3]) {
      const label = `${profile.width} x ${profile.height} with ${profile.top} and ${profile.bottom} px insets at ${Math.round(scale * 100)}%`;
      test(`7. a real phone docks above the sheet: ${label}`, async () => {
        await setUp(player, playerCdp, { ...profile, scale });
        await assertBarInWindow(player, `player, ${label}`);
        await tapThorn(player);
        await panelsButton(player).click();
        await assertDocked(player, scale, label);
        if (profile.top > 0 && scale === 1.3) await shots.take(player, "fold-dock-iphone-130");
        await player.getByRole("button", { name: "Close Panels" }).click();
        await player.keyboard.press("Escape");
      });
    }
  }

  test("8. 320 x 480 at 130%: three concentration checks, a roll request and a selected token still dock above a 120 px sheet", async () => {
    await setUp(dm, dmCdp, { width: 320, height: 480, scale: 1.3 });
    for (const id of run.goblins) {
      await ops.send({ t: "actor.effect.add", target: { tokenId: id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
      await ops.send({ t: "actor.hp", target: { tokenId: id }, change: { kind: "damage", amount: 2 } });
    }
    await ops.send({
      t: "roll.ask",
      request: { id: randomUUID(), test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: false, resultShown: false, targets: [{ tokenId: run.thorn.id }] },
    });
    await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
    await assertBarInWindow(dm, "DM, 320 x 480 at 130%");
    assert.equal(await topBar(dm).getByRole("img", { name: "You are the DM" }).count(), 1, "the DM's chip did not give way to its dot");
    await selectThornAsDm();
    await panelsButton(dm).click();
    await assertDocked(dm, 1.3, "320 x 480 at 130%, alerts and a token");
    const summary = dm.getByRole("button", { name: /^Concentration check \+\d/ });
    await summary.waitFor();
    const name = (await summary.getAttribute("aria-label")) ?? "";
    assert.match(name, /Goblin 1 checks concentration, Goblin 2 checks concentration, Goblin 3 checks concentration/);
    if (!WITHOUT_ROLLS) assert.match(name, /rolls? /i, "the summary leaves out the open roll request");
    await shots.take(dm, "fold-dock-alerts-320-130");
  });

  test("9. 320 x 480 at 130% with 44 and 34 px insets: the dock's buttons move into the sheet's header", async () => {
    await setUp(dm, dmCdp, { width: 320, height: 480, scale: 1.3, top: 44, bottom: 34 });
    for (const id of run.goblins) await ops.send({ t: "actor.hp", target: { tokenId: id }, change: { kind: "damage", amount: 1 } });
    await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
    await selectThornAsDm();
    // This screen is too short to dock the bar, so it opens compact over the toolbar (docs/design-v1-bar-dock.md 1.4), and a pointer reaches Panels only once it closes. The keyboard still does.
    await panelsButton(dm).press("Enter");
    const sheet = dm.getByRole("region", { name: "Panels" });
    await sheet.waitFor();
    await dm.waitForTimeout(150);
    assert.equal(await dm.locator("[data-rvtt-dock]").count(), 0, "the dock was drawn where it does not fit");
    const header = sheet.locator("header").first();
    const show = header.getByRole("button", { name: "Show Thorn actions" });
    const summary = header.getByRole("button", { name: /^Concentration check/ });
    await show.waitFor();
    await summary.waitFor();
    const b = await boxes(dm);
    assert.ok(b.bars && b.sheet && b.toolbar);
    assert.ok(b.sheet.height >= 120 * 1.3 - 1, `the sheet is ${b.sheet.height} px`);
    assert.ok(b.sheet.top >= b.bars.bottom - 0.5, "the sheet runs under the top bars");
    assert.ok(b.sheet.bottom <= b.toolbar.top + 1, "the sheet runs under the toolbar");
    await assertHeaderFits(sheet, 1.3, "the Panels list");
    assert.equal(await header.getByRole("button", { name: /^Close/ }).count(), 1, "two closes in the header");
    await shots.take(dm, "fold-header-forced");

    // The header's chip shows the bar, as Show does.
    await show.click();
    await sheet.waitFor({ state: "detached" });
    assert.equal((await focused(dm)).name, "Thorn actions");

    // A real panel's subpage adds Back to the same header: Menu, then Members.
    await panelsButton(dm).press("Enter");
    await sheet.getByRole("button", { name: /^Menu/ }).click();
    const menu = dm.getByRole("region", { name: "Menu" });
    await menu.getByRole("button", { name: /^Members/ }).click();
    await menu.getByRole("button", { name: "Back to Menu" }).waitFor();
    await menu.locator("header").first().getByRole("button", { name: /^Concentration check/ }).waitFor();
    await assertHeaderFits(menu, 1.3, "Members, with Back and the dock's buttons");
    await shots.take(dm, "fold-header-forced-subpage");

    // The encounter editor asking before it discards a change: the question takes the title's place, and the dock's buttons step aside.
    await menu.getByRole("button", { name: "Close Menu" }).click();
    await panelsButton(dm).press("Enter");
    await sheet.getByRole("button", { name: /^Encounters/ }).click();
    const encounters = dm.getByRole("region", { name: "Encounters" });
    await encounters.getByRole("button", { name: "New encounter" }).click();
    await encounters.getByLabel("Encounter name").fill("Ambush at the ford");
    await encounters.getByRole("button", { name: "Back to Encounters" }).click();
    const ask = encounters.getByRole("button", { name: "Discard changes?" });
    await ask.waitFor();
    await assertHeaderFits(encounters, 1.3, "the encounter editor asking");
    assert.equal(await encounters.locator("header").first().getByRole("button", { name: /^Concentration check/ }).count(), 0, "the dock's buttons stayed beside the question");
    await shots.take(dm, "fold-header-forced-asking");
    await ask.click();
    await encounters.getByRole("button", { name: "New encounter" }).waitFor();
    await encounters.locator("header").first().getByRole("button", { name: /^Concentration check/ }).waitFor();
    await encounters.getByRole("button", { name: "Close Encounters" }).click();
    await dm.keyboard.press("Escape");
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  describe("with a roll waiting for the player (needs the rolls' side of the dock)", { skip: WITHOUT_ROLLS ? "FOLD_WITHOUT_ROLLS=1" : false }, () => {
    test("10. Escape, Back and each Show button with a token selected and a roll asked", async () => {
      await setUp(player, playerCdp, { width: 375, height: 667, scale: 1 });
      // The card at the screen's foot stands taller with its roll row (docs/design-v1-roll-request.md 5.7) and covers Thorn's
      // cell, so Later puts it aside while Thorn is tapped, and the summary brings it back.
      await player.getByRole("dialog", { name: "The DM asks for a roll" }).getByRole("button", { name: "Later" }).click();
      await tapThorn(player);
      await panelsButton(player).click();
      await player.getByRole("button", { name: /^Roll asked/ }).click();
      await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
      const card = player.getByRole("dialog", { name: "The DM asks for a roll" });
      await card.waitFor();

      const reopen = async () => {
        await panelsButton(player).click();
        await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).focus();
        await player.getByRole("button", { name: /^Roll asked/ }).waitFor();
      };
      // A closing sheet gives focus to the card it was hiding, before the token bar.
      await reopen();
      await player.keyboard.press("Escape");
      assert.equal((await focused(player)).inCard, true, "focus after Escape");
      await reopen();
      await player.goBack();
      await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
      assert.equal((await focused(player)).inCard, true, "focus after Back");
      // Show shows what it names.
      await reopen();
      await player.getByRole("button", { name: "Show Thorn actions" }).click();
      assert.equal((await focused(player)).name, "Thorn actions", "focus after Show");
      await reopen();
      await player.getByRole("button", { name: /^Roll asked/ }).click();
      await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
      assert.equal((await focused(player)).inCard, true, "focus after the summary");
    });

    test("11. a roll put off with Later stays put off when the sheet closes, and the summary opens it", async () => {
      await player.getByRole("dialog", { name: "The DM asks for a roll" }).getByRole("button", { name: "Later" }).click();
      await panelsButton(player).click();
      await player.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).focus();
      await player.keyboard.press("Escape");
      await player.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
      assert.equal(await player.getByRole("dialog", { name: "The DM asks for a roll" }).count(), 0, "Later did not hold");
      assert.equal((await focused(player)).name, "Thorn actions", "focus after Escape with the roll put off");
      await panelsButton(player).click();
      await player.getByRole("button", { name: /^Roll asked/ }).click();
      await player.getByRole("dialog", { name: "The DM asks for a roll" }).waitFor();
      assert.equal((await focused(player)).inCard, true, "focus after the summary opened the put-off roll");
    });
  });

  describe("a landscape phone's alerts column (needs the rolls' cards)", { skip: WITHOUT_ROLLS ? "FOLD_WITHOUT_ROLLS=1" : false }, () => {
    test("12. at 844 x 390 concentration checks over the DM's desk, and a roll card over two chips, scroll as one column above the toolbar", async () => {
      await setUp(dm, dmCdp, { width: 844, height: 390, scale: 1 });
      // A check comes up as the damage arrives, so the page loaded above has none until the goblins take more.
      for (const id of run.goblins) await ops.send({ t: "actor.hp", target: { tokenId: id }, change: { kind: "damage", amount: 1 } });
      await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
      await dm.getByRole("group", { name: /^Roll request: / }).first().waitFor();
      await assertColumnReachable(dm, "DM at 844 x 390");
      await shots.take(dm, "fold-landscape-dm-column");

      // Checks for a Thorn with a stat block: a save's card, or one with a bonus field, no longer fits the column on its side
      // with its roll row and folds behind the Roll asked row (docs/design-v1-roll-request.md 5.7). This step is about a card
      // over chips in one scrolling column.
      await ops.send({
        t: "character.update",
        characterId: run.thorn.characterId,
        patch: { level: 1, stats: { abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 12, cha: 10 }, saves: [], skills: {}, adjust: {}, defenses: {}, rolls: [] } },
      });
      for (const ability of ["str", "dex", "con"] as const) {
        await ops.send({
          t: "roll.ask",
          request: { id: randomUUID(), test: { kind: "check", choices: [{ ability }] }, dcShown: true, resultShown: true, targets: [{ tokenId: run.thorn.id }] },
        });
      }
      await setUp(player, playerCdp, { width: 844, height: 390, scale: 1 });
      await player.getByRole("dialog", { name: "The DM asks for a roll" }).waitFor();
      await player.getByRole("button", { name: /^Rolls \d+\/\d+/ }).waitFor();
      await assertColumnReachable(player, "player at 844 x 390");
      await shots.take(player, "fold-landscape-player-column");
    });
  });

  describe("a scrolled alerts column under a sheet (needs the rolls' cards)", { skip: WITHOUT_ROLLS ? "FOLD_WITHOUT_ROLLS=1" : false }, () => {
    test("13. a column scrolled down and folded under a sheet: the summary brings the check it names back into view, and it takes a tap", async () => {
      await setUp(dm, dmCdp, { width: 320, height: 480, scale: 1.3 });
      for (const id of run.goblins) await ops.send({ t: "actor.hp", target: { tokenId: id }, change: { kind: "damage", amount: 1 } });
      await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
      // Down to the column's foot, so the first check, which the summary will name, is out of sight above. The column keeps its place while folded.
      const scrolled = await dm.locator('[data-alert="concentration"]').first().evaluate((alert) => {
        type Box = { parentElement: Box | null; scrollTop: number; scrollHeight: number; clientHeight: number };
        const styleOf = (globalThis as unknown as { getComputedStyle(el: unknown): { overflowY: string } }).getComputedStyle;
        let box = (alert as unknown as Box).parentElement;
        while (box && styleOf(box).overflowY !== "auto") box = box.parentElement;
        if (!box) return null;
        box.scrollTop = box.scrollHeight;
        return { scrolls: box.scrollHeight > box.clientHeight, top: box.scrollTop };
      });
      assert.ok(scrolled?.scrolls, "the column has nothing to scroll at this size, so this step shows nothing");
      await panelsButton(dm).click();
      const sheet = dm.getByRole("region", { name: "Panels" });
      await sheet.waitFor();
      await dm.getByRole("button", { name: /^Concentration check/ }).click();
      await sheet.waitFor({ state: "detached" });

      const shown = await dm.evaluate(() => {
        type Node = El & { parentElement: Node | null; contains(other: unknown): boolean };
        const g = globalThis as unknown as { document: Doc & { elementFromPoint(x: number, y: number): unknown }; getComputedStyle(el: unknown): { overflowY: string } };
        const active = g.document.activeElement as Node | null;
        const check = active?.closest('[data-alert="concentration"]') as Node | null;
        let box = check?.parentElement ?? null;
        while (box && g.getComputedStyle(box).overflowY !== "auto") box = box.parentElement;
        if (!active || !check || !box) return null;
        const r = active.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        const hit = g.document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return {
          name: active.getAttribute("aria-label") ?? active.textContent ?? "",
          first: check === g.document.querySelector('[data-alert="concentration"]'),
          inside: r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
          tappable: hit === active || active.contains(hit),
        };
      });
      assert.ok(shown, "focus is not in a concentration check");
      assert.ok(shown.first, "focus went to another check than the one the summary names");
      assert.ok(shown.inside, `"${shown.name}" has focus out of the column's view`);
      assert.ok(shown.tappable, `"${shown.name}" is covered`);
      await shots.take(dm, "fold-column-revealed");
    });
  });

  test("14. with a token selected, ArrowRight on the bar's HP modes chooses Heal and leaves the token where it stands", async () => {
    await setUp(dm, dmCdp, { width: 1280, height: 800, scale: 1 });
    const p = await pagePoint(dm, run.bounds, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 });
    await dm.mouse.click(p.x, p.y);
    const bar = dm.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    const modes = bar.getByRole("radiogroup", { name: "What the number does" });
    const where = () => {
      const t = dmSocket.state?.tokens[run.thorn.id];
      return t ? { x: t.x, y: t.y } : null;
    };
    const before = where();
    assert.ok(before, "Thorn is not in the DM's view");
    await modes.getByRole("radio", { name: "Damage" }).focus();
    await dm.keyboard.press("ArrowRight");
    assert.equal(await modes.getByRole("radio", { name: "Heal" }).isChecked(), true, "the arrow did not choose the next mode");
    // A nudge would reach the server's state at once: give it the time it would take.
    await dm.waitForTimeout(400);
    assert.deepEqual(where(), before, "the arrow moved the token");
    await dm.keyboard.press("Escape");
  });

  test("15. an upright tablet at 820 x 1180: the docked bar folds under a sheet, and Show brings it back to its stored spot with focus on its frame", async () => {
    // A resize, not a reload: this run has loaded the page many times, and the server's snapshot budget would make the next load wait.
    await dm.setViewportSize({ width: 820, height: 1180 });
    const p = await pagePoint(dm, run.bounds, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 });
    await dm.mouse.click(p.x, p.y);
    const bar = barFrame(dm);
    await bar.waitFor();
    assert.equal(await bar.getAttribute("data-bar-mode"), "dock", "the tablet's bar does not dock");
    // Moved off its default spot by the grip's keys, so Show's return to it means something.
    await bar.getByRole("button", { name: "Move window", exact: true }).focus();
    await dm.keyboard.press("Shift+ArrowUp");
    const spot = '{"corner":"br","x":0,"y":64}';
    const docked = await bar.boundingBox();
    assert.ok(docked, "the bar has no box");
    await panelsButton(dm).click();
    await assertDocked(dm, 1, "820 x 1180, a docked bar");
    assert.equal(await bar.isVisible(), false, "the docked bar did not fold under the sheet");
    await dm.getByRole("button", { name: "Show Thorn actions" }).click();
    await dm.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
    const back = await bar.boundingBox();
    assert.ok(back && Math.abs(back.x - docked.x) < 1 && Math.abs(back.y - docked.y) < 1, `Show did not bring the bar back to its spot: ${JSON.stringify({ docked, back })}`);
    assert.equal((await focused(dm)).name, "Thorn actions");
    assert.equal(await dm.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("rvtt.tokenBarSpot")), spot, "the stored spot changed");
    await shots.take(dm, "fold-tablet-docked-back");
    await bar.getByRole("button", { name: "Reset window position and size", exact: true }).click();
    await dm.keyboard.press("Escape");
  });

  test("16. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
    assert.deepEqual(playerConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
