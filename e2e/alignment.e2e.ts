import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Locator, type Page } from "playwright-core";
import { trapPreset } from "../shared/srd/traps.ts";
import { ConsoleWatch, OpSocket, pagePoint, pickOption, pickTool, pressOption, reopenRoom, ROOT, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { alignmentLines, headerLines, headerPlaces, leadLines, LIMIT_PX, measureAlignment, pillLines, toastLaneLines, toastsUnderCards, type HeaderPlace, type PillPoint } from "./helpers/alignment.ts";

/**
 * The alignment sweep (docs/design-v1-polish.md 4): the screens the
 * polish pass measured, at the sizes it measured them, each run through
 * the alignment helper (e2e/helpers/alignment.ts), so a part that drifts
 * off its middle, a label that wraps alone above its field, a pill that
 * runs off the board or a header that stands apart fails here.
 *
 * One room built by ops: the DM, Pat playing Thorn, a fight on Thorn's
 * turn, a Hidden Pit, a long-named needle trap with every section of its
 * pane filled, a door trap and a found trip wire, the attach set (a
 * warhorse, a goblin carrying a lantern and dragging a prisoner), and
 * walls with a door. For each of 6 sizes at 100% and 130% the DM measures
 * the Trap tool, the four traps' panes with every group unfolded, the
 * alerts as traps go off on Pat's walks (the toast under a pane, the
 * column, a toast under its first card, the summary row and the alerts
 * over the screen), the board's pills, the Attach list and Ride, and the
 * holder's, rider's and group windows: their headers, play rows and group
 * lines (the windows' older rows are not this sweep's). Pat measures the
 * Ruler's options, readings and kept list, a drag's stop note, and the
 * toast of his own walk.
 *
 * Each size's step gathers every line the helper reports, shoots the
 * screens that have any, and fails once with all of them. A screen the
 * sweep must reach and did not, a root that matches nothing, a window
 * with no header place, a board with no pill and a holder's line missing
 * a word are lines too. The screens that show only at some sizes are
 * counted over the run, and pl3-d fails when one showed at fewer sizes
 * than the polish pass found (pl3-c), so no check passes by measuring
 * nothing.
 *
 * The DM's page runs in a touch context for the phone and tablet sizes and
 * a mouse context for the desktop, one at a time, beside Pat's touch
 * context, so no more than two contexts are open.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-seven, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 27;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-alignment-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const BOUNDS = { w: 20, h: 14 };
/** The needle trap's uses, given back at each size, since each size sets it off twice. */
const NEEDLE_USES = 3;

type Size = { name: string; width: number; height: number; touch: boolean };
/** The polish pass's sizes, touch ones first, so the DM's touch context closes before the mouse one opens. */
const SIZES: Size[] = [
  { name: "390x844", width: 390, height: 844, touch: true },
  { name: "360x740", width: 360, height: 740, touch: true },
  { name: "320x568", width: 320, height: 568, touch: true },
  { name: "844x390", width: 844, height: 390, touch: true },
  { name: "820x1180", width: 820, height: 1180, touch: true },
  { name: "1440x900", width: 1440, height: 900, touch: false },
];
const SCALES = [1, 1.3];

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let dmTouch = true;
let ops: OpSocket;
let patOps: OpSocket;
let dmSocket = new SocketWatch("dm");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E alignment ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  ids: {
    thornChar: randomUUID(),
    thorn: randomUUID(),
    horse: randomUUID(),
    torch: randomUUID(),
    kobold: randomUUID(),
    cart: randomUUID(),
    goblin: randomUUID(),
    lantern: randomUUID(),
    prisoner: randomUUID(),
    boss: randomUUID(),
    mule: randomUUID(),
  },
  traps: { pit: randomUUID(), needle: randomUUID(), door: randomUUID(), wire: randomUUID() },
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
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
  return context.cookies(server.origin).then((cs) => cs.map((c) => `${c.name}=${c.value}`).join("; "));
}

/** How many size steps measured each screen, over the whole run, for pl3-c. */
const seenAt = new Map<string, number>();

/**
 * The screens that show only at some sizes, and at how many the sweep
 * meets them on the polish pass's build: a chip or pop-up the row shows
 * only where it has room, the column's summary row on a short screen,
 * and a trap name's pointer where the zoom shows names. pl3-c fails when
 * one shows at fewer, so a screen that stops showing everywhere is caught.
 */
const SOME_SIZES: Record<string, number> = {
  "trap-start-from": 12,
  "trap-more": 2,
  "trap-pane-header-place": 6,
  "pane-dock": 6,
  "alerts-beside-pane": 5,
  "alerts-column": 9,
  "alerts-column-open": 9,
  "alerts-summary": 5,
  "alerts-overlay": 5,
  "toast-under-card": 7,
  "toast-hint": 12,
  "ruler-measure-chip": 6,
  "board points at Poisoned Needle": 9,
  "board points at Hidden Pit": 9,
  "pat-board points at Poisoned Needle": 9,
};

/**
 * One size's sweep: every line the checks report, a list of the screens
 * measured, and a shot of each screen that reported something.
 */
class Sweep {
  readonly lines: string[] = [];
  readonly seen = new Set<string>();
  readonly at: string;
  /** Whether a screen with lines is shot. The drawn cases' sweeps are not. */
  readonly shoot: boolean;

  constructor(at: string, shoot = true) {
    this.at = at;
    this.shoot = shoot;
  }

  /** Adds a check's lines for `screen`, shooting `page` when there are any. */
  async add(page: Page, screen: string, lines: readonly string[]): Promise<void> {
    this.seen.add(screen);
    if (lines.length === 0) return;
    this.lines.push(...lines);
    if (this.shoot) await shots.take(page, `alignment-${this.at}-${screen}`);
  }

  /** Measures what `root` matches with the five checks, as `screen`. A root that matches nothing is a screen missing, unless `optional`. */
  async measure(page: Page, screen: string, root: Locator, opts: { optional?: boolean } = {}): Promise<void> {
    if ((await root.count()) === 0) {
      if (!opts.optional) await this.missing(page, screen, "nothing on the page matched it");
      return;
    }
    await this.add(page, screen, alignmentLines(await measureAlignment(root), `${this.at} ${screen}`));
  }

  /** The board's pills, as `screen`, with each trap name's pointer it read counted as a screen of its own. */
  async pills(page: Page, screen: string, opts: { points?: readonly PillPoint[]; needPills?: boolean } = {}): Promise<void> {
    const check = await pillLines(page, `${this.at} ${screen}`, opts);
    for (const words of check.matched) this.seen.add(`${screen} points at ${words}`);
    await this.add(page, screen, check.lines);
  }

  /** A screen the sweep must reach at this size and did not, shot as it stands. */
  async missing(page: Page, screen: string, why: string): Promise<void> {
    this.lines.push(`${this.at} ${screen}: never showed (${why})`);
    if (this.shoot) await shots.take(page, `alignment-${this.at}-${screen}-missing`);
  }

  /** Counts this size's screens into the run's tally. */
  tally(): void {
    for (const screen of this.seen) seenAt.set(screen, (seenAt.get(screen) ?? 0) + 1);
  }
}

/** Whether a locator shows within `ms`, without failing. */
function showsWithin(l: Locator, ms: number): Promise<boolean> {
  return l.waitFor({ timeout: ms }).then(
    () => true,
    () => false,
  );
}

async function visible(l: Locator): Promise<boolean> {
  return (await l.count()) > 0 && (await l.first().isVisible());
}

async function escapeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
}

/** Opens the room at a size and interface scale, from a new navigation. */
async function openAt(page: Page, size: Size, scale: number): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  if (!page.url().startsWith(server.origin)) await page.goto(`${server.origin}/`);
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  if (page.url().includes(`/r/${run.roomId}`)) await reopenRoom(page);
  else await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** The DM's page in a context of the size's kind, replacing the other kind's, so only two contexts are ever open. */
async function dmPageFor(size: Size): Promise<Page> {
  if (dm && dmTouch === size.touch) return dm;
  const state = await dmContext.storageState();
  await dmContext.close();
  dmContext = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.touch, hasTouch: size.touch, storageState: state });
  dmTouch = size.touch;
  dm = await dmContext.newPage();
  consoles.dm.attach(dm);
  dmSocket = new SocketWatch("dm");
  await dmSocket.attach(dmContext, dm);
  return dm;
}

/** Every waiting springing settled and every trap armed again with its uses back, so each size starts from the same alerts. */
async function settleTraps(): Promise<void> {
  for (const [id, trap] of Object.entries(dmSocket.state?.traps ?? {})) {
    for (const due of trap.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: id, due: due.id });
    if (trap.rig?.usesLeft !== undefined) await ops.send({ t: "trap.update", trapId: id, patch: { rig: { usesLeft: NEEDLE_USES } } });
    if (trap.state !== "armed") await ops.send({ t: "trap.update", trapId: id, patch: { state: "armed" } });
  }
}

/** Sets a trap off on Thorn by hand, and arms it again. */
async function spring(trapId: string): Promise<void> {
  await ops.send({ t: "trap.spring", trapId, tokenIds: [run.ids.thorn] });
  await ops.send({ t: "trap.update", trapId, patch: { state: "armed" } });
}

/** Thorn back at 5,5 on the ground, off any mount. */
async function resetThorn(): Promise<void> {
  await ops.send({ t: "token.detach", tokenId: run.ids.thorn, x: 5, y: 5, elevation: 0 }).catch(() => {});
  await ops.send({ t: "token.update", tokenId: run.ids.thorn, patch: { x: 5, y: 5, elevation: 0 } });
}

/** Pat walks Thorn across the trip wire, which the server sets off on the walk. */
async function patCrosses(): Promise<void> {
  await ops.send({ t: "trap.update", trapId: run.traps.wire, patch: { state: "armed" } });
  await ops.send({ t: "token.update", tokenId: run.ids.thorn, patch: { x: 15, y: 5, elevation: 0 } });
  await patOps.send({ t: "token.move", tokenId: run.ids.thorn, x: 15, y: 8 });
}

/** A fresh fight on Thorn's turn, so his walked path starts empty. */
async function restartFight(): Promise<void> {
  if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: randomUUID(), tokenId: run.ids.thorn, value: 18 },
      { id: randomUUID(), tokenId: run.ids.goblin, value: 14 },
      { id: randomUUID(), tokenId: run.ids.horse, value: 12 },
      { id: randomUUID(), tokenId: run.ids.boss, value: 9 },
    ],
  });
  await ops.send({ t: "encounter.next" });
}

/** The long wall at x 13 with its door locked, or back to the short wall with the door closed. */
async function setWall(long: boolean): Promise<void> {
  const edges: { key: string; feature: unknown }[] = [];
  for (let y = 0; y < BOUNDS.h; y++) {
    if (y === 10) edges.push({ key: "13,10,w", feature: { kind: "door", state: long ? "locked" : "closed", secret: false, discovered: false } });
    else if (y < 8 || y > 12) edges.push({ key: `13,${y},w`, feature: long ? { kind: "wall" } : null });
  }
  await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });
}

/** The page's own toasts with these words, not the hidden live regions. */
function toasts(page: Page, words: RegExp): Locator {
  return page.locator('[role="status"]').filter({ hasText: words }).filter({ visible: true });
}

async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const t = page.locator('button[role="status"], div[role="status"] > button').filter({ visible: true });
    if ((await t.count()) === 0) return;
    await t.first().click({ timeout: 1000 }).catch(() => {});
  }
}

/** Unfolds every group of a pane, each fold once. Menus and pop-ups are not folds. */
async function unfoldAll(root: Locator): Promise<void> {
  const done = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const folded = root.locator("button[aria-expanded=false]:not([aria-haspopup])");
    const n = await folded.count();
    let next: ElementHandle | null = null;
    for (let k = 0; k < n && !next; k++) {
      const b = folded.nth(k);
      const label = (await b.getAttribute("aria-label")) ?? (await b.innerText());
      if (done.has(label) || /^(More|Add|Start from|Party level)/.test(label)) continue;
      done.add(label);
      next = await b.elementHandle();
    }
    if (!next) return;
    await next.click();
    // The fold itself, not the nth folded one, which is another once it opens.
    const fold = next;
    await waitFor("the group to unfold", async () => ((await fold.getAttribute("aria-expanded")) !== "false" ? true : null), 3_000);
    await fold.dispose();
  }
}

/** Marks the alerts column, the box that holds the alert cards (each kind marked `data-alert`), for measuring it as one root. */
async function markColumn(page: Page): Promise<Locator | null> {
  const marked = await page.evaluate(() => {
    type El = { parentElement: El | null; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; getBoundingClientRect(): { height: number } };
    const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<El> }; getComputedStyle(e: El): { display: string } };
    for (const e of Array.from(g.document.querySelectorAll("[data-alignment-column]"))) e.removeAttribute("data-alignment-column");
    const first = g.document.querySelectorAll("[data-alert]")[0];
    let col = first?.parentElement ?? null;
    while (col && g.getComputedStyle(col).display === "contents") col = col.parentElement;
    if (!col || col.getBoundingClientRect().height < 2) return false;
    col.setAttribute("data-alignment-column", "");
    return true;
  });
  return marked ? page.locator("[data-alignment-column]") : null;
}

/**
 * Where the squares traps' names point, in page px: the middle of the top
 * edge of each zone's top rectangle (features/traps/TrapLayer.tsx
 * trapNamePill). A player sees the found needle trap's, the DM both.
 */
async function trapPoints(page: Page, dmView: boolean): Promise<PillPoint[]> {
  const needle = { words: "Poisoned Needle", at: await pagePoint(page, BOUNDS, { x: 15.5, y: 2 }) };
  return dmView ? [needle, { words: "Hidden Pit", at: await pagePoint(page, BOUNDS, { x: 11, y: 6 }) }] : [needle];
}

/** Whether a tap at a cell's middle would land on the map, not on a window or a sheet over it. */
async function canvasAt(page: Page, cell: { x: number; y: number }): Promise<boolean> {
  const p = await pagePoint(page, BOUNDS, { x: cell.x + 0.5, y: cell.y + 0.5 });
  return page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName === "CANVAS", [p.x, p.y] as const);
}

/** Selects a token by a tap on its cell, and returns its window. */
async function selectToken(page: Page, name: string, cell: { x: number; y: number }): Promise<Locator | null> {
  await tapCell(page, BOUNDS, cell);
  const bar = page.getByRole("dialog", { name: `${name} actions` });
  return (await showsWithin(bar, 3_000)) ? bar : null;
}

/** Measures a token window's header, play row and group line (where it has one), and keeps where its header stands. */
async function measureWindow(sweep: Sweep, page: Page, screen: string, bar: Locator, headers: HeaderPlace[], groupLine: boolean): Promise<void> {
  await sweep.measure(page, `${screen}-header`, bar.locator("[data-sticky-header]"));
  await sweep.measure(page, `${screen}-play-row`, bar.locator('[data-bar-row="play"]'));
  await sweep.measure(page, `${screen}-group-line`, bar.getByRole("group", { name: "Attached tokens" }), { optional: !groupLine });
  const places = await headerPlaces(bar);
  if (places.length !== 1) await sweep.missing(page, `${screen}-header-place`, `read ${places.length} header places, not 1`);
  headers.push(...places);
}

/** The DM's screens at one size. */
async function dmScreens(sweep: Sweep, page: Page, size: Size): Promise<void> {
  const headers: HeaderPlace[] = [];
  // Pat's walk left a springing waiting, whose card could cover a trap.
  await settleTraps();
  await sweep.pills(page, "board", { points: await trapPoints(page, true), needPills: true });

  // The Trap tool's options, its Start from, and its More where the row has one.
  await pickTool(page, "Trap");
  const bar = page.getByRole("toolbar", { name: "Trap options" });
  await bar.waitFor();
  await page.locator('[data-options-line="shown"]').first().waitFor();
  await sweep.measure(page, "trap-tool", bar);
  const startFrom = bar.getByRole("button", { name: /^Start from/ });
  if (await visible(startFrom)) {
    await startFrom.first().click();
    const pop = page.getByRole("dialog", { name: "Start from" });
    await pop.waitFor();
    await sweep.measure(page, "trap-start-from", pop);
    await escapeAll(page);
  }
  const more = bar.getByRole("button", { name: "More options" });
  if (await visible(more)) {
    await more.first().click();
    const pop = page.getByRole("dialog", { name: "More Trap options" });
    await pop.waitFor();
    await sweep.measure(page, "trap-more", pop);
    await escapeAll(page);
  }

  // Each trap's pane, every group unfolded.
  const pane = page.getByRole("dialog", { name: "Edit trap" });
  for (const [which, at] of [
    ["pit", { x: 10.5, y: 6.5 }],
    ["needle", { x: 14.5, y: 2.5 }],
    ["door", { x: 13, y: 10.5 }],
    ["wire", { x: 16, y: 7 }],
  ] as const) {
    const p = await pagePoint(page, BOUNDS, at);
    await page.mouse.click(p.x, p.y);
    if (!(await showsWithin(pane, 3_000))) {
      await sweep.missing(page, `trap-pane-${which}`, "a tap on the trap opened no pane");
      await escapeAll(page);
      continue;
    }
    // Its header's place as it opens, before an unfolded group scrolls the frame. A pane standing as a sheet has a grab area, and its grabber places its header.
    if (which === "pit") {
      const places = await headerPlaces(pane);
      if (places.length > 0) sweep.seen.add("trap-pane-header-place");
      else if ((await pane.locator("[data-sheet-grab]").count()) === 0) await sweep.missing(page, "trap-pane-header-place", "the pane is no sheet, and its header place was not read");
      headers.push(...places);
    }
    await unfoldAll(pane);
    await sweep.measure(page, `trap-pane-${which}`, pane);
    await dismissToasts(page);
    await pane.getByRole("button", { name: "Done", exact: true }).click();
    await pane.waitFor({ state: "detached" });
  }

  // A toast under the open pane, as a trap goes off on Pat's walk.
  await settleTraps();
  await resetThorn();
  const p = await pagePoint(page, BOUNDS, { x: 10.5, y: 6.5 });
  await page.mouse.click(p.x, p.y);
  await pane.waitFor();
  await spring(run.traps.needle);
  await patCrosses();
  const wentOff = toasts(page, /went off/);
  if (await showsWithin(wentOff.first(), 3_000)) await sweep.measure(page, "toast-under-pane", wentOff);
  else await sweep.missing(page, "toast-under-pane", "no toast for the trip wire");
  const dock = page.locator("[data-rvtt-pane-dock]");
  if (await visible(dock)) await sweep.measure(page, "pane-dock", dock);
  const beside = await markColumn(page);
  if (beside) await sweep.measure(page, "alerts-beside-pane", beside);
  await sweep.measure(page, "trap-pane-alerts", pane);
  // A toast over the pane's foot would take the tap.
  await dismissToasts(page);
  await pane.getByRole("button", { name: "Done", exact: true }).click();
  await pane.waitFor({ state: "detached" });
  await pickTool(page, "Select");
  await dismissToasts(page);

  // The column full, and a toast under its first card.
  await spring(run.traps.door);
  await spring(run.traps.pit);
  await spring(run.traps.pit);
  await spring(run.traps.needle);
  await patCrosses();
  const wentOff2 = toasts(page, /went off/);
  if (await showsWithin(wentOff2.first(), 3_000)) {
    await sweep.measure(page, "toast-column", wentOff2);
    await sweep.add(page, "toast-lane", await toastLaneLines(page, `${sweep.at} toast-lane`));
    // On an upright phone the toast stands under the column's first card, so the lane check must have met one there.
    if ((await toastsUnderCards(page)) > 0) sweep.seen.add("toast-under-card");
    else if (size.width < size.height && size.width <= 430) await sweep.missing(page, "toast-under-card", "the toast stood under no alert card");
  } else await sweep.missing(page, "toast-column", "no toast for the trip wire");
  const column = await markColumn(page);
  if (column) {
    await sweep.measure(page, "alerts-column", column);
    const fold = column.locator("[data-alert] button[aria-expanded=false]").first();
    if (await visible(fold)) {
      await fold.click();
      const open = await markColumn(page);
      if (open) await sweep.measure(page, "alerts-column-open", open);
    }
  }
  await dismissToasts(page);

  // The summary row at the lane's top, where the column stands as one row, and the alerts over the screen it opens.
  const summary = page.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ });
  if (await visible(summary)) {
    await sweep.measure(page, "alerts-summary", summary.first());
    await summary.first().click();
    const overlay = page.getByRole("dialog", { name: "Alerts" });
    if (await showsWithin(overlay, 2_500)) await sweep.measure(page, "alerts-overlay", overlay);
    else await sweep.missing(page, "alerts-overlay", "a tap on the summary row showed no alerts");
    await escapeAll(page);
  }
  if (!column && !(await visible(summary))) await sweep.missing(page, "alerts-column", "neither the column nor its summary row showed");

  // The Passive Perception hint as Thorn walks near the needle trap, unfound again.
  const needle = dmSocket.state?.traps?.[run.traps.needle];
  if (needle?.rig) await ops.send({ t: "trap.update", trapId: run.traps.needle, patch: { found: false, rig: { find: needle.rig.find } } });
  await ops.send({ t: "token.update", tokenId: run.ids.thorn, patch: { x: 10, y: 4, elevation: 0 } });
  await patOps.send({ t: "token.move", tokenId: run.ids.thorn, x: 12, y: 4 });
  const hint = toasts(page, /Passive Perception|notice/i);
  if (await showsWithin(hint.first(), 2_000)) await sweep.measure(page, "toast-hint", hint);
  await ops.send({ t: "trap.update", trapId: run.traps.needle, patch: { found: true } });
  await dismissToasts(page);
  await settleTraps();
  await resetThorn();

  // Thorn's window, the Attach list and Ride's question.
  await pickTool(page, "Select");
  await escapeAll(page);
  const thorn = await selectToken(page, "Thorn", { x: 5, y: 5 });
  if (thorn) {
    await measureWindow(sweep, page, "window-thorn", thorn, headers, false);
    const attach = thorn.getByRole("button", { name: "Attach", exact: true });
    await attach.click();
    const sheet = page.getByRole("dialog", { name: "Attach Thorn" });
    await sheet.waitFor();
    await sweep.measure(page, "attach-list", sheet);
    await sheet.getByRole("button", { name: "Ride Warhorse" }).click();
    await sheet.getByRole("radiogroup").first().waitFor();
    await sweep.measure(page, "attach-ride", sheet);
    await escapeAll(page);
  } else await sweep.missing(page, "window-thorn", "a tap on Thorn opened no window");

  // The goblin's window, a holder's line, then the group window.
  const goblin = await selectToken(page, "Goblin", { x: 9, y: 3 });
  if (goblin) {
    await measureWindow(sweep, page, "window-goblin", goblin, headers, true);
    await sweep.add(page, "holder-line", await leadLines(goblin.getByRole("group", { name: "Attached tokens" }), ["Carrying", "Dragging"], `${sweep.at} holder-line`));
    const multi = goblin.getByRole("button", { name: "Multi-select", exact: true });
    await multi.click();
    await tapCell(page, BOUNDS, { x: 4, y: 4 });
    // The prisoner too where the window leaves its cell clear, as on a short screen it may not.
    if (await canvasAt(page, { x: 10, y: 3 })) await tapCell(page, BOUNDS, { x: 10, y: 3 });
    const group = page.locator('[role="dialog"][data-bar-mode]');
    if (await showsWithin(group.first(), 3_000)) {
      await measureWindow(sweep, page, "window-group", group.first(), headers, false);
      await page.getByRole("button", { name: "Deselect all" }).first().click();
    } else await sweep.missing(page, "window-group", "Multi-select and two taps opened no group window");
    await escapeAll(page);
  } else await sweep.missing(page, "window-goblin", "a tap on the goblin opened no window");

  // A rider's window: Thorn on the warhorse, steering it.
  await ops.send({ t: "token.attach", tokenId: run.ids.thorn, to: run.ids.horse, kind: "ride", steer: true, x: 6, y: 5, elevation: 0 });
  const rider = await selectToken(page, "Thorn", { x: 6, y: 5 });
  if (rider) await measureWindow(sweep, page, "window-rider", rider, headers, true);
  else await sweep.missing(page, "window-rider", "a tap on the mounted Thorn opened no window");
  await escapeAll(page);
  await resetThorn();

  if (headers.length === 0) await sweep.missing(page, "headers", "no header place was read");
  await sweep.add(page, "headers", headerLines(headers, `${sweep.at} headers`));
}

/** Pat's screens at one size: the Ruler, a drag's stop note, and the toast of his own walk. */
async function patScreens(sweep: Sweep, page: Page): Promise<void> {
  // A player's board at a small zoom may show no name, so only its stage is required.
  await sweep.pills(page, "pat-board", { points: await trapPoints(page, false) });
  await resetThorn();
  await patCrosses();
  const own = toasts(page, /^Thorn: /);
  if (await showsWithin(own.first(), 3_000)) await sweep.measure(page, "toast-player", own);
  else await sweep.missing(page, "toast-player", "no toast for Thorn's walk over the trip wire");
  await dismissToasts(page);
  await resetThorn();

  // The Ruler: its options, a walking ruler round the wall held mid-drag, let go and kept twice, its kept list and its Measure chip.
  await pickTool(page, "Ruler");
  const bar = page.getByRole("toolbar", { name: "Ruler options" });
  await bar.waitFor();
  await pickOption(page, "Ruler", "Measure", "Walking");
  await sweep.measure(page, "ruler-options", bar);
  const a = await pagePoint(page, BOUNDS, { x: 5.5, y: 5.5 });
  const b = await pagePoint(page, BOUNDS, { x: 15.5, y: 9.5 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await page.locator("[data-options-reading]").first().waitFor().catch(() => {});
  await sweep.measure(page, "ruler-live", bar);
  await sweep.pills(page, "ruler-live-pills", { needPills: true });
  await page.mouse.up();
  await sweep.measure(page, "ruler-done", bar);
  await pressOption(page, "Ruler", "Keep this ruler on the map");
  const c = await pagePoint(page, BOUNDS, { x: 2.5, y: 2.5 });
  const d = await pagePoint(page, BOUNDS, { x: 8.5, y: 11.5 });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + ((d.x - c.x) * i) / 8, c.y + ((d.y - c.y) * i) / 8);
  await page.mouse.up();
  await pressOption(page, "Ruler", "Keep this ruler on the map");
  await sweep.measure(page, "ruler-kept-row", bar);
  await sweep.pills(page, "ruler-kept-pills", { needPills: true });
  const kept = bar.getByRole("button", { name: /^Kept/ });
  const moreButton = bar.getByRole("button", { name: "More options" });
  const opener = (await visible(kept)) ? kept.first() : (await visible(moreButton)) ? moreButton.first() : null;
  if (opener) {
    await opener.click();
    const pop = page.getByRole("dialog").filter({ visible: true }).last();
    await pop.waitFor();
    await sweep.measure(page, "ruler-kept-list", pop);
    await escapeAll(page);
  } else await sweep.missing(page, "ruler-kept-list", "neither Kept nor More options showed");
  const chip = bar.getByRole("button", { name: /^Measure:/ });
  if (await visible(chip)) {
    await chip.first().click();
    const pop = page.getByRole("dialog", { name: "Measure" });
    await pop.waitFor();
    await sweep.measure(page, "ruler-measure-chip", pop);
    await escapeAll(page);
  }
  for (const [id, drawing] of Object.entries(dmSocket.state?.drawings ?? {})) if ((drawing as { kind?: string }).kind === "ruler") await ops.send({ t: "drawing.delete", drawingId: id });

  // A drag stopped by a wall, held for its pills, then its stop note.
  await pickTool(page, "Select");
  await ops.send({ t: "token.update", tokenId: run.ids.thorn, patch: { x: 11, y: 9, elevation: 0 } });
  await setWall(true);
  const from = await pagePoint(page, BOUNDS, { x: 11.5, y: 9.5 });
  const to = await pagePoint(page, BOUNDS, { x: 15.5, y: 9.5 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  await sweep.pills(page, "drag-pills", { needPills: true });
  await page.mouse.up();
  const note = page.locator("[data-stop-note]");
  if (await showsWithin(note.first(), 3_000)) await sweep.measure(page, "stop-note", note.first());
  else await sweep.missing(page, "stop-note", "the walk into the wall showed no stop note");
  await escapeAll(page);
  await setWall(false);
  await resetThorn();
}

/**
 * Drawn cases for the helper itself: each shape the polish pass found
 * (docs/design-v1-polish.md 1), and the shape its fix gives (section 2),
 * so the helper is shown to catch the one and pass the other without the
 * app. Each case is a root of its own, named by `data-case`.
 */
const CASES = `
<style>
  body { margin: 0; font: 14px/1.4 sans-serif; color: #eee; background: #222; }
  * { box-sizing: border-box; }
  [data-case] { width: 330px; margin: 0 0 16px; }
  button { font: inherit; height: 44px; min-width: 44px; padding: 0 12px; border: 1px solid #888; background: #333; color: inherit; border-radius: 10px; }
  input, select { font: inherit; height: 44px; box-sizing: border-box; border: 1px solid #888; background: #111; color: inherit; }
  .chip { border-radius: 999px; }
  /* Fixed widths, so a wider fallback font cannot move a part to another line. */
  .fixed { flex: none; width: 60px; overflow: hidden; white-space: nowrap; padding: 0; }
  .box { background: #333; }
</style>
<!-- First, so the board stays inside the window for the pill cases. -->
<div id="board" style="width: 300px; height: 160px; background: #111"></div>
<div data-case="kin-tall">
  <div style="display: grid; gap: 4px"><button>One</button><button>Two</button><button style="height: 52px">Three</button></div>
</div>
<div data-case="kin-even">
  <div style="display: grid; gap: 4px"><button>One</button><button>Two</button><button>Three</button></div>
</div>
<div data-case="kin-icon">
  <div style="display: grid; gap: 4px"><button><svg width="16" height="16"></svg> One</button><button><svg width="16" height="16"></svg> Two</button><button style="height: 52px">Three</button></div>
</div>
<div data-case="kin-subgroup">
  <div style="display: grid; gap: 4px"><button>One</button><button>Two</button><button>Three</button><button style="height: 70px">Four<br>more</button><button style="height: 60px">Five<br>more</button></div>
</div>
<div data-case="kin-lines">
  <div style="display: grid; gap: 4px"><button>One</button><button>Two</button><button style="height: 64px">Three<br>more</button></div>
</div>
<div data-case="kin-padding">
  <div style="display: grid; gap: 4px"><button>One</button><button>Two</button><button style="padding-left: 20px">Three</button></div>
</div>
<div data-case="kin-gap">
  <div style="display: grid; gap: 4px"><button>One</button><button>Two</button><button>Three</button><button style="margin-top: 6px">Four</button></div>
</div>
<div data-case="pad-uneven">
  <div class="box" style="padding: 8px 10px 3px">Uneven room</div>
</div>
<div data-case="pad-even">
  <div class="box" style="padding: 6px 10px">Even room</div>
</div>
<div data-case="row-heights">
  <div style="display: flex; align-items: center; gap: 4px"><button>Tall</button><button style="height: 40px">Short</button></div>
</div>
<div data-case="row-even-heights">
  <div style="display: flex; align-items: center; gap: 4px"><button>One</button><button>Two</button></div>
</div>
<div data-case="mixed-start">
  <div style="display: flex; align-items: flex-start; gap: 8px"><span style="width: 90px">Two lines of words</span><div class="box" style="width: 40px; height: 39.2px"></div><span style="align-self: center">Mid</span></div>
</div>
<div data-case="mixed-center">
  <div style="display: flex; align-items: center; gap: 8px"><span style="width: 90px">Two lines of words</span><span>Mid</span><div class="box" style="align-self: flex-start; width: 40px; height: 39.2px"></div></div>
</div>
<div data-case="lone-short" style="width: 280px">
  <div style="display: flex; flex-wrap: wrap; gap: 4px"><button style="flex: 1 1 auto">Ask to search</button><button style="flex: 1 1 auto">Ask to disarm</button><button style="width: calc(100% - 2px)">Set it off</button></div>
</div>
<div data-case="squares-25">
  <div style="display: flex; flex-wrap: wrap; gap: 4px; width: 100px"><button style="width: 44px; border-radius: 25%">A</button><button style="width: 44px; border-radius: 25%">B</button><button style="width: 44px; border-radius: 25%">C</button></div>
</div>
<div data-case="circles-50">
  <div style="display: flex; flex-wrap: wrap; gap: 4px; width: 100px"><button style="width: 44px; border-radius: 50%">A</button><button style="width: 44px; border-radius: 50%">B</button><button style="width: 44px; border-radius: 50%">C</button></div>
</div>
<div data-case="edge-far"><div>First row</div><div>Second row</div><div style="padding-left: 25px">Third row</div></div>
<div data-case="edge-near"><div>First row</div><div>Second row</div><div style="padding-left: 4px">Third row</div></div>
<div data-case="edge-apart"><div>First row</div><div style="padding-left: 10px">Second row</div><div style="padding-left: 30px">Third row</div></div>
<div data-case="edge-notice"><div>First row</div><div>Second row</div><div class="box" style="padding: 8px 12px">A notice in its own box</div></div>
<div data-case="edge-centered"><div>First row</div><div>Second row</div><div style="text-align: center">Centered words</div><button style="width: 100%">Full width</button><div>Last row</div></div>
<div data-case="edge-centered-drift"><div>First row</div><div>Second row</div><button style="width: 100%">Full width</button><div style="padding-left: 2px">Last row</div></div>
<div data-case="edge-end"><div>First row</div><div>Second row</div><div style="display: flex; justify-content: flex-end"><input style="width: 96px"></div><div>Last row</div></div>
<div data-case="edge-group"><div>First row</div><div>Second row</div><ul style="margin: 0; padding-left: 24px"><li>A nested item</li></ul><div>Last row</div></div>
<div data-case="edge-indent"><div>First row</div><div>Second row</div><div style="padding-left: 24px">An indented row</div><div>Last row</div></div>
<div data-case="edge-disclosure"><div>First row</div><div>Second row</div><div><button aria-expanded="true" style="border: none; background: none; padding: 0 0 0 20px">Folded group</button></div><div>Last row</div></div>
<div data-case="shift-outer">
  <div class="box" style="height: 44px; padding: 12px 10px; line-height: 20px"><span style="position: relative; top: 3px"><span>Shifted words</span></span></div>
</div>
<div data-case="shift-two">
  <div class="box" style="height: 44px; padding: 12px 10px; line-height: 20px"><span style="position: relative; top: 2px"><b>Shifted two</b></span></div>
</div>
<div data-case="shift-valign">
  <div class="box" style="height: 44px; padding: 12px 10px; line-height: 20px">Plain words <span style="vertical-align: 4px">raised</span></div>
</div>
<div data-case="font-rounding">
  <div class="box" style="height: 54.96px; padding: 15px 10px; font-size: 20.8px; line-height: 24.96px"><span><span>A zoomed title</span></span></div>
</div>
<div data-case="placed-sole">
  <button style="position: relative; width: 120px"><span style="position: absolute; left: 10px; top: 2px; height: 20px">Placed</span></button>
</div>
<div data-case="placed-badge">
  <button style="position: relative; width: 120px">Words<span style="position: absolute; right: 0; top: 0; width: 10px; height: 10px; background: red"></span></button>
</div>
<div data-case="baseline-row">
  <div style="display: flex; align-items: baseline; gap: 8px"><span style="font-size: 24px">30</span><span>of 38 HP</span></div>
</div>
<div data-case="picture">
  <button style="display: flex; align-items: center; justify-content: center"><span role="img" aria-label="Armor Class 12" style="display: block; height: 30px; padding-top: 2px; line-height: 12px">12</span></button>
</div>
<div data-case="open-disclosure">
  <ul style="margin: 0; padding: 0; list-style: none"><li class="box" style="padding: 4px 8px 20px"><button aria-expanded="true" style="border: none">Ability scores</button><p style="margin: 0">Wisdom 18</p></li></ul>
</div>
<div data-case="own-line" style="width: 250px">
  <div style="display: flex; flex-wrap: wrap; gap: 8px"><input style="width: 100px"><input style="width: 100px"><div style="flex-basis: 100%">A hint under the row</div></div>
</div>
<div data-case="radio-wrap" style="width: 200px">
  <div role="radiogroup" aria-label="Zone" style="display: flex; flex-wrap: wrap; gap: 4px"><label class="box" style="padding: 12px">Squares</label><label class="box" style="padding: 12px">Trip wire</label><label class="box" style="padding: 12px">Door</label></div>
</div>
<div data-case="heading-above" style="width: 200px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px"><h3 style="flex: 1 1 auto; margin: 0; font-size: 13px">DIFFERENT FROM D&amp;D BEYOND (1)</h3><button>Overwrite all</button></div>
</div>
<div data-case="sentence-above" style="width: 200px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px"><p style="margin: 0">D&amp;D Beyond says 16.</p><button>Overwrite with Wisdom 16</button></div>
</div>
<div data-case="scrolled-hidden">
  <div class="box" style="height: 44px; padding: 12px 10px; line-height: 20px"><div style="height: 20px; overflow: hidden">The first line shows<br>a second line is cut<br>and a third</div></div>
</div>
<div data-case="tick-dropped">
  <label style="display: flex; align-items: flex-start; gap: 12px; padding: 4px 0">
    <input type="checkbox" style="width: 22px; height: 22px; margin: 2px 0 0; flex: none">
    <span style="display: grid; gap: 2px"><span style="line-height: 1.4">AC 12, now 15</span><span style="font-size: 13px; line-height: 1.4">Worked out from the armor. Check it against the sheet before you apply it.</span></span>
  </label>
</div>
<div data-case="tick-on-first-line">
  <label style="display: flex; align-items: flex-start; gap: 12px; padding: 4px 0">
    <span style="display: flex; align-items: center; height: 19.6px; flex: none"><input type="checkbox" style="width: 22px; height: 22px; margin: 0"></span>
    <span style="display: grid; gap: 2px"><span style="line-height: 1.4">AC 12, now 15</span><span style="font-size: 13px; line-height: 1.4">Worked out from the armor. Check it against the sheet before you apply it.</span></span>
  </label>
</div>
<div data-case="tick-zoomed" style="zoom: 1.3; width: 250px">
  <label style="display: flex; align-items: flex-start; gap: 12px; padding: 4px 0">
    <span style="display: flex; align-items: center; height: 19.6px; flex: none"><input type="checkbox" style="width: 22px; height: 22px; margin: 0"></span>
    <span style="display: grid; gap: 2px"><span style="line-height: 1.4">A creature steps onto it</span><span style="font-size: 13px; line-height: 1.4">A trap on squares goes off at least one way.</span></span>
  </label>
</div>
<div data-case="zoom-narrow" style="zoom: 1.3"><div role="button" style="display: flex; align-items: center; justify-content: center; width: 10.5px; height: 60px; border-top: 40px solid #888"><span style="width: 4px; height: 6px; background: #eee"></span></div></div>
<div data-case="zoom-narrow-off" style="zoom: 1.3"><div role="button" style="display: flex; align-items: flex-start; justify-content: center; width: 10.5px; height: 60px; border-top: 40px solid #888"><span style="width: 4px; height: 6px; margin-top: 5px; background: #eee"></span></div></div>
<div data-case="label-alone" style="width: 250px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 44px">
    <label style="flex: 1 1 110px; min-width: 0">DC</label>
    <div style="flex: 1 1 160px; min-width: 0; display: flex; justify-content: flex-end"><input style="width: 96px"></div>
  </div>
</div>
<div data-case="label-beside" style="width: 250px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 44px">
    <label style="flex: 1 1 110px; min-width: 0">DC</label>
    <div style="flex: 1 1 auto; min-width: 0; display: flex; justify-content: flex-end"><input style="width: 96px"></div>
  </div>
</div>
<div data-case="remove-alone" style="width: 300px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">
    <input style="width: 120px" value="2d10"><select style="width: 150px"><option>Poison</option></select><button aria-label="Remove this damage">x</button>
  </div>
</div>
<div data-case="remove-held" style="width: 300px">
  <div style="display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px">
    <div style="display: flex; flex-wrap: wrap; gap: 8px"><input style="width: 120px" value="2d10"><select style="width: 150px"><option>Poison</option></select></div>
    <button aria-label="Remove this damage">x</button>
  </div>
</div>
<div data-case="hint-high">
  <div style="height: 44px; padding: 6px 10px; background: #333; overflow: hidden"><div style="font-size: 13px; line-height: 1.4; white-space: nowrap">Drag to measure. Tap to add a waypoint.</div></div>
</div>
<div data-case="hint-centered">
  <div style="height: 44px; padding: 6px 10px; background: #333; overflow: hidden; display: grid; align-content: center"><div style="font-size: 13px; line-height: 1.4; white-space: nowrap">Drag to measure. Tap to add a waypoint.</div></div>
</div>
<div data-case="chips-wrap" style="width: 200px">
  <div role="group" aria-label="On a fail" style="display: flex; flex-wrap: wrap; gap: 4px"><button class="chip">Poisoned</button><button class="chip">Blinded</button><button class="chip">Restrained</button></div>
</div>
<div data-case="buttons-wrap" style="width: 280px">
  <div style="display: flex; flex-wrap: wrap; gap: 4px"><button>Ask to search</button><button>Ask to disarm</button><button>Set it off</button></div>
</div>
<div data-case="buttons-share" style="width: 280px">
  <div style="display: flex; flex-wrap: wrap; gap: 4px"><button style="flex: 1 1 auto">Ask to search</button><button style="flex: 1 1 auto">Ask to disarm</button><button style="flex: 1 1 auto">Set it off</button></div>
</div>
<div data-case="kind-dragging" style="width: 280px">
  <div role="group" aria-label="Attached tokens" style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px">
    <span class="fixed">Carrying</span><button class="fixed">Lantern</button><button class="fixed">Put down</button><span class="fixed">Dragging</span><button class="fixed">Prisoner</button><button class="fixed">Let go</button>
  </div>
</div>
<div data-case="kind-rows" style="width: 280px">
  <div role="group" aria-label="Attached tokens" style="display: grid; gap: 4px">
    <div style="display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center"><span>Carrying</span><div style="display: flex; flex-wrap: wrap; gap: 4px"><button>Lantern</button><button>Put down</button></div></div>
    <div style="display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center"><span>Dragging</span><div style="display: flex; flex-wrap: wrap; gap: 4px"><button>Prisoner</button><button>Let go</button></div></div>
  </div>
</div>
<div data-case="kind-carrying-only" style="width: 280px">
  <div role="group" aria-label="Attached tokens" style="display: flex; align-items: center; gap: 4px"><span>Carrying</span><button>Lantern</button></div>
</div>
<div data-case="windows">
  <div role="dialog" aria-label="Thorn actions" aria-labelledby="w1" style="border: 1px solid #888; height: 120px; overflow: hidden"><div style="padding: 4px 12px; height: 100%; overflow: auto">
    <div data-sticky-header style="display: flex; align-items: center; margin: -4px -12px 0; padding: 4px 12px 0; min-height: 48px"><strong id="w1" style="flex: 1; line-height: 1.2">Thorn</strong><button aria-label="Close">x</button></div>
  </div></div>
  <div role="dialog" aria-label="Goblin actions" aria-labelledby="w2" style="border: 1px solid #888; height: 120px; overflow: hidden; margin-top: 8px"><div style="padding: 4px 12px; height: 100%; overflow: auto">
    <div data-sticky-header style="display: flex; align-items: center; margin: -4px -12px 0; padding: 6px 12px 2px; min-height: 52px; box-sizing: border-box"><strong id="w2" style="flex: 1; line-height: 1.2">Goblin</strong><button aria-label="Close">x</button></div>
  </div></div>
  <div role="dialog" aria-label="Edit trap" aria-labelledby="w3" style="border: 1px solid #888; padding: 4px 12px; margin-top: 8px">
    <div style="display: flex; align-items: center; min-height: 48px"><strong id="w3" style="flex: 1; line-height: 1.2">Hidden Pit</strong><button aria-label="Close">x</button></div>
  </div>
</div>
<div data-case="toasts" style="position: relative; width: 390px; height: 300px">
  <div style="position: absolute; left: 82px; right: 8px; top: 0; display: flex; flex-direction: column; gap: 8px"><div data-alert="rolls" style="display: contents"><section style="height: 60px; background: #333">Trip Wire went off</section></div></div>
  <div style="position: absolute; top: 72px; left: 12px; right: 12px"><div role="status" style="background: #444; height: 44px">Trip Wire went off: Thorn.</div></div>
</div>
`;

describe("raccoon-vtt alignment sweep", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    patOps?.close();
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

  test("pl3-0. the helper on drawn cases: each shape the polish pass found is caught, and the shape its fix gives passes", async () => {
    const page = await dmContext.newPage();
    try {
      await page.setViewportSize({ width: 390, height: 1600 });
      await page.setContent(CASES);
      const lines = async (name: string) => alignmentLines(await measureAlignment(page.locator(`[data-case="${name}"]`)), name);
      const caught = async (name: string, check: string) => {
        const found = await lines(name);
        assert.ok(found.some((l) => l.startsWith(`${name}: ${check} `)), `${name}: no ${check} line in ${JSON.stringify(found)}`);
      };
      const passes = async (name: string) => assert.deepEqual(await lines(name), [], `${name} should pass`);
      await caught("tick-dropped", "row");
      await passes("tick-on-first-line");
      await caught("label-alone", "wrap-label");
      await passes("label-beside");
      await caught("remove-alone", "wrap-orphan");
      await passes("remove-held");
      await caught("hint-high", "center");
      await passes("hint-centered");
      await passes("chips-wrap");
      await caught("buttons-wrap", "wrap-orphan");
      await passes("buttons-share");
      // A lone part counts as filling its line only when it does, within the limit.
      await caught("lone-short", "wrap-orphan");
      // Kin: a taller one is caught, among plain ones, beside ones with an icon, and within a smaller group of two-line kin. Kin of other lines are not compared.
      await caught("kin-tall", "kind-height");
      await passes("kin-even");
      await caught("kin-icon", "kind-height");
      await caught("kin-subgroup", "kind-height");
      await passes("kin-lines");
      await caught("kin-padding", "kind-padding");
      await caught("kin-gap", "kind-gap");
      await caught("pad-uneven", "pad");
      await passes("pad-even");
      await caught("row-heights", "row-height");
      await passes("row-even-heights");
      // A mixed row is judged by the alignment most of its parts take.
      await caught("mixed-start", "row");
      await passes("mixed-center");
      // A part rounded only a quarter is no chip, so a row of them is no set of choices. Circles are.
      await caught("squares-25", "wrap-orphan");
      await passes("circles-50");
      // Edges: drift caught at any size, three rows apart pass, a painted notice lines up by its box, centered words and a full-width button are no edge but a start-set row beside them still is, and a nested list's inset passes where a plain row's does not.
      await caught("edge-far", "edge");
      await caught("edge-near", "edge");
      await passes("edge-apart");
      await passes("edge-notice");
      await passes("edge-centered");
      await caught("edge-centered-drift", "edge");
      await passes("edge-end");
      // At 130% a box's zoom is read as the browser reports it. Its drawn size over its whole-pixel offset size reads a 10.5 px box as 10 or 11, which moves a 40 px border's inside by 2.4 px and a 20 px line's box by half a pixel.
      await passes("tick-zoomed");
      await passes("zoom-narrow");
      await caught("zoom-narrow-off", "center");
      await passes("edge-group");
      await caught("edge-indent", "edge");
      await passes("edge-disclosure");
      // Words moved on purpose, on an outer span or by a vertical alignment, are never snapped back to their line. A font's rounding is.
      await caught("shift-outer", "center");
      await caught("shift-two", "center");
      await caught("shift-valign", "center");
      await passes("font-rounding");
      // A control's only content placed absolutely is measured. A badge beside content in the flow is not.
      await caught("placed-sole", "center");
      await passes("placed-badge");
      // The other exceptions, each passing.
      await passes("baseline-row");
      await passes("picture");
      await passes("open-disclosure");
      await passes("own-line");
      await passes("radio-wrap");
      await passes("heading-above");
      await passes("sentence-above");
      await passes("scrolled-hidden");
      await passes("windows");
      const holder = (name: string) => page.locator(`[data-case="${name}"]`).getByRole("group", { name: "Attached tokens" });
      assert.equal((await leadLines(holder("kind-dragging"), ["Carrying", "Dragging"], "kind-dragging")).length, 1, "Dragging ending a line is caught");
      assert.deepEqual(await leadLines(holder("kind-rows"), ["Carrying", "Dragging"], "kind-rows"), [], "each kind on a row of its own passes");
      const headers = headerLines(await headerPlaces(page.locator('[data-case="windows"] [role="dialog"]')), "windows");
      assert.equal(headers.length, 1, `only the window whose header pads 4 above and 0 below stands apart: ${JSON.stringify(headers)}`);
      assert.match(headers[0]!, /"Thorn actions" has its Close 5 px/);
      // A target that is not there is a line, never a pass.
      const drawn = new Sweep("drawn", false);
      await drawn.measure(page, "renamed", page.locator('[data-bar-row="plays"]'));
      assert.match(drawn.lines.join("\n"), /^drawn renamed: never showed/, "a renamed attribute fails the sweep");
      assert.deepEqual((await pillLines(page, "no-konva", { needPills: true })).lines, ["no-konva: no Konva stage on the page"]);
      assert.deepEqual(await leadLines(holder("kind-carrying-only"), ["Carrying", "Dragging"], "kind-carrying-only"), ['kind-carrying-only: "Dragging" is not in the group']);
      assert.deepEqual(await leadLines(page.locator('[data-case="none"]').getByRole("group"), ["Carrying"], "no-group"), ["no-group: no group of linked tokens to read"]);

      // Pills on a real Konva stage: a pill in view pointing at its point passes, one past the board's edge, one whose pointer is off its point and one that is not drawn are each caught.
      await page.addScriptTag({ path: path.join(ROOT, "node_modules/konva/konva.min.js") });
      const board = await page.locator("#board").boundingBox();
      assert.ok(board, "the drawn board");
      const at = (x: number, y: number) => ({ x: board.x + x, y: board.y + y });
      const draw = (pills: { x: number; y: number; text: string }[]) =>
        page.evaluate((list) => {
          type K = { stages: { destroy(): void }[]; Stage: new (o: object) => { add(l: unknown): void }; Layer: new () => { add(n: unknown): void; draw(): void }; Label: new (o: object) => { add(n: unknown): void }; Tag: new (o: object) => unknown; Text: new (o: object) => unknown };
          const konva = (globalThis as unknown as { Konva: K }).Konva;
          for (const old of [...konva.stages]) old.destroy();
          const stage = new konva.Stage({ container: "board", width: 300, height: 160 });
          const layer = new konva.Layer();
          stage.add(layer);
          for (const p of list) {
            const label = new konva.Label({ x: p.x, y: p.y });
            label.add(new konva.Tag({ fill: "#333", pointerDirection: "down", pointerWidth: 10, pointerHeight: 6, cornerRadius: 6 }));
            label.add(new konva.Text({ text: p.text, fontSize: 12, padding: 4, fill: "#fff" }));
            layer.add(label);
          }
          layer.draw();
        }, pills);
      await draw([{ x: 150, y: 80, text: "Centered" }]);
      const centered = await pillLines(page, "konva", { points: [{ words: "Centered", at: at(150, 80), required: true }], needPills: true });
      assert.deepEqual(centered, { lines: [], matched: ["Centered"] }, "a pill in view on its point passes");
      await draw([{ x: 280, y: 80, text: "A long name near the edge" }]);
      assert.match((await pillLines(page, "konva", { needPills: true })).lines.join("\n"), /^konva: pill "A long name near the edge" runs [\d.]+ px past the board's visible part$/);
      await draw([{ x: 150, y: 80, text: "Centered" }]);
      assert.deepEqual((await pillLines(page, "konva", { points: [{ words: "Centered", at: at(155, 80) }] })).lines, ['konva: pill "Centered" points 5 px off its point']);
      assert.deepEqual((await pillLines(page, "konva", { points: [{ words: "Absent", at: at(150, 80), required: true }] })).lines, ['konva: no pointed pill reads "Absent"']);
      await draw([]);
      assert.deepEqual((await pillLines(page, "konva", { needPills: true })).lines, ["konva: no board pill drawn"]);

      const lanes = await toastLaneLines(page, "toasts");
      assert.equal(lanes.length, 1, `the toast spanning the map under the card is caught: ${JSON.stringify(lanes)}`);
      await page.locator('[data-case="toasts"] [role="status"]').evaluate((el) => {
        (el.parentElement as unknown as { style: { left: string; right: string } }).style.left = "82px";
        (el.parentElement as unknown as { style: { left: string; right: string } }).style.right = "8px";
      });
      assert.deepEqual(await toastLaneLines(page, "toasts"), [], "a toast that takes the card's edges passes");
    } finally {
      await page.close();
    }
  });

  test("pl3-a. a room built by ops: Pat playing Thorn in a fight on his turn, four traps that fill every pane section, the attach set, and walls with a door", async () => {
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
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });
    run.patId = await join(patContext, "Pat", "#30a46c");
    patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(patContext) });

    const { ids } = run;
    const tok = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: ids.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor({ passivePerception: 16 }) } });
    await ops.send(tok(ids.thorn, { kind: "pc", name: "Thorn", x: 5, y: 5, disposition: "ally", actor: { ref: ids.thornChar } }));
    await ops.send(tok(ids.horse, { kind: "npc", name: "Warhorse", size: "large", x: 6, y: 5, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor({ speeds: { walk: 60 } }) } }));
    await ops.send(tok(ids.torch, { kind: "object", name: "Torch", size: "tiny", x: 4.5, y: 6, disposition: "neutral", actor: { inline: actor({ hp: { cur: 1, max: 1, temp: 0 } }) } }));
    await ops.send(tok(ids.kobold, { kind: "monster", name: "Kobold", size: "small", x: 4, y: 4, disposition: "hostile", actor: { inline: actor({ hp: { cur: 5, max: 5, temp: 0 } }) } }));
    await ops.send({ t: "actor.effect.add", target: { tokenId: ids.kobold }, effect: { id: randomUUID(), key: "grappled" } });
    await ops.send(tok(ids.cart, { kind: "object", name: "Cart", size: "large", x: 3, y: 7, disposition: "neutral", actor: { inline: actor({ hp: { cur: 20, max: 20, temp: 0 } }) } }));
    await ops.send(tok(ids.goblin, { kind: "monster", name: "Goblin", x: 9, y: 3, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tok(ids.lantern, { kind: "object", name: "Lantern", size: "tiny", x: 9.5, y: 3.5, disposition: "neutral", actor: { inline: actor({ hp: { cur: 1, max: 1, temp: 0 } }) } }));
    await ops.send(tok(ids.prisoner, { kind: "npc", name: "Prisoner", x: 10, y: 3, disposition: "neutral", actor: { inline: actor({ hp: { cur: 4, max: 4, temp: 0 } }) } }));
    await ops.send({ t: "actor.effect.add", target: { tokenId: ids.prisoner }, effect: { id: randomUUID(), key: "grappled" } });
    await ops.send({ t: "token.attach", tokenId: ids.lantern, to: ids.goblin, kind: "carry", x: 9.5, y: 3.5, elevation: 0 });
    await ops.send({ t: "token.attach", tokenId: ids.prisoner, to: ids.goblin, kind: "drag", x: 10, y: 3, elevation: 0 });
    await ops.send(tok(ids.boss, { kind: "monster", name: "Goblin Boss of the Sunless Citadel", x: 15, y: 11, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tok(ids.mule, { kind: "npc", name: "Pack mule", x: 8, y: 8, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor() } }));

    // Walls and a door at x 13, for the door trap and the walk the wall stops.
    const edges: { key: string; feature: unknown }[] = [];
    for (let y = 8; y <= 12; y++) if (y !== 10) edges.push({ key: `13,${y},w`, feature: { kind: "wall" } });
    edges.push({ key: "13,10,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });

    // The Hidden Pit as the Trap tool starts it from its preset: a 10-foot pit under ground at 0.
    const pit = trapPreset("hidden-pit", "1-4");
    assert.ok(pit, "the Hidden Pit preset");
    await ops.send({ t: "trap.create", trap: { id: run.traps.pit, sceneId: run.sceneId, name: pit.name, zone: { cells: [{ x: 10, y: 6, w: 2, h: 2 }] }, rig: { ...pit.rig, hits: "trigger", pit: { floor: -(pit.pitDepth ?? 10) } } } });
    await ops.send({
      t: "trap.create",
      trap: {
        id: run.traps.needle,
        sceneId: run.sceneId,
        name: "Poisoned Needle Gauntlet of the Sunless Citadel",
        found: true,
        zone: {
          cells: [
            { x: 14, y: 2, w: 3, h: 1 },
            { x: 16, y: 3, w: 1, h: 2 },
          ],
        },
        rig: {
          on: ["enter", "leave", "turnStart", "turnEnd"],
          who: "party",
          minSize: "small",
          floor: true,
          resets: "nextTurn",
          usesLeft: NEEDLE_USES,
          stops: false,
          foundOnSpring: true,
          hits: { area: { shape: "cone", size: 15, origin: { x: 14, y: 2, z: 0 }, yaw: 90, includeOrigin: false } },
          save: { ability: "con", dc: 15, onPass: "none" },
          damage: [
            { formula: "2d10", type: "poison" },
            { formula: "1d6+2", type: "piercing" },
            { formula: "1d4", type: "necrotic" },
          ],
          conditions: ["poisoned", "blinded", "restrained"],
          lasts: { mode: "rounds", rounds: 3 },
          message: "A spray of needles hisses out of the wall and a sickly green mist rolls over the floor!",
          sound: "hiss",
          actions: [{ door: { edge: "13,10,w" }, state: "locked" }, { show: { tokenId: ids.boss } }],
          find: [
            { ability: "wis", skill: "perception", dc: 10, what: "the tiny holes along the wall's mortar" },
            { ability: "int", skill: "investigation", dc: 15, what: "the pressure plate" },
          ],
          notice: true,
          disarm: { text: "Wedging an iron spike under the plate, or plugging every hole with wax", check: { ability: "dex", skill: "sleight-of-hand", dc: 15 } },
          note: "The needles are coated with purple worm poison diluted by age. A creature that fails by 5 or more also drops whatever it holds.",
        },
      },
    });
    await ops.send({
      t: "trap.create",
      trap: {
        id: run.traps.door,
        sceneId: run.sceneId,
        name: "Scything Door",
        zone: { door: { edge: "13,10,w" } },
        rig: { on: [], who: "any", floor: false, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", save: { ability: "dex", dc: 13, onPass: "half" }, damage: [{ formula: "2d8", type: "slashing" }], actions: [], find: [{ ability: "int", skill: "investigation", dc: 13 }], notice: false },
      },
    });
    await ops.send({
      t: "trap.create",
      trap: {
        id: run.traps.wire,
        sceneId: run.sceneId,
        name: "Trip Wire",
        found: true,
        zone: { wire: { a: [14, 7], b: [18, 7] } },
        rig: { on: [], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", conditions: ["prone"], message: "You trip over a wire.", sound: "click", actions: [], find: [{ ability: "wis", skill: "perception", dc: 12 }], notice: false },
      },
    });
    await restartFight();
    await waitFor("the four traps on the DM's copy", () => Object.keys(dmSocket.state?.traps ?? {}).length === 4 || null);
  });

  let index = 0;
  for (const size of SIZES) {
    for (const scale of SCALES) {
      const at = `${size.name}${scale === 1 ? "" : "-130"}`;
      index++;
      test(`pl3-b${index}. at ${size.width} x ${size.height} at ${scale * 100}%, on ${size.touch ? "touch" : "a mouse"}: every screen of the sweep within ${LIMIT_PX} px`, async () => {
        const sweep = new Sweep(at);
        try {
          await resetThorn();
          await restartFight();
          pat.setDefaultTimeout(10_000);
          await openAt(pat, size, scale);
          await patScreens(sweep, pat);
          await pat.goto("about:blank");
          const page = await dmPageFor(size);
          page.setDefaultTimeout(10_000);
          await openAt(page, size, scale);
          await waitFor("the DM's snapshot", () => dmSocket.state);
          await dmScreens(sweep, page, size);
          console.log(`${at}: measured ${[...sweep.seen].join(", ")}`);
        } finally {
          sweep.tally();
        }
        assert.equal(sweep.lines.length, 0, `${sweep.lines.length} lines out of line at ${at}:\n${sweep.lines.join("\n")}`);
      });
    }
  }

  test("pl3-c. the screens that show only at some sizes showed at as many as the polish pass found, and each trap name's pointer was read", () => {
    const short = Object.entries(SOME_SIZES)
      .filter(([screen, sizes]) => (seenAt.get(screen) ?? 0) < sizes)
      .map(([screen, sizes]) => `${screen}: ${seenAt.get(screen) ?? 0} of ${sizes} sizes`);
    assert.deepEqual(short, [], "screens that showed at fewer sizes than the polish pass found");
  });

  test("pl3-d. no page logged an error", () => {
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    assert.deepEqual(consoles.pat.errors, [], "Pat's page logged errors");
  });
});
