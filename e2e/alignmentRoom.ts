import { UndoWire, setupHistory } from "./helpers/undoScope.ts";
import { damageSummaryAlignment } from "./helpers/damageSummary.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { ddbSheetUrl } from "../shared/ddb/link.ts";
import { readDdbCharacter } from "../shared/ddb/read.ts";
import { SKILLS } from "../shared/rules/skills.ts";
import { loadMonsters, monsterActor, type SrdMonster } from "../shared/srd/monsters.ts";
import { trapPreset } from "../shared/srd/traps.ts";
import { barControl, ConsoleWatch, dragCells, expandBar, multiSelect, OpSocket, openSceneGroup, openSideTab, pagePoint, pickOption, pickTool, pressOption, reopenRoom, ROOT, sceneGroup, sceneGroupFold, Shots, sideTabName, SocketWatch, startServer, tapCell, touchSwipe, untilReady, waitFor, wholeInReach, type Server } from "./harness.ts";
import { DEFAULT_SNAPSHOT_BUDGET } from "../server/rooms/budgets.ts";
import { alignmentLines, headerLines, headerPlaces, leadLines, LIMIT_PX, measureAlignment, menuWordLines, pillLines, popoverScrollbarLines, proficiencyHeightLines, proficiencyLines, toastLaneLines, toastsUnderCards, type HeaderPlace, type PillPoint } from "./helpers/alignment.ts";
import { measureSpacing, spacingLines, type SpacingFinding } from "./helpers/spacing.ts";
import { moreMenuFixture } from "./helpers/menuFixture.ts";

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
 * the toolbar's Setup tools or Tools menu where it has one, the shortcut
 * sheet's Toolbar section, the Trap tool, the four traps' panes with every
 * group unfolded, the alerts as traps go off on Pat's walks (the toast
 * under a pane, the column, a toast under its first card, the summary row
 * and the alerts over the screen), the board's pills, the Attach list and
 * Ride, and the holder's, rider's and group windows: their headers, play
 * rows and group lines (the windows' older rows are not this sweep's), and
 * on an upright phone Thorn's whole bar in its larger size. Pat measures
 * the Ruler's options, readings and kept list, a drag's stop note, and the
 * toast of his own walk. Three older screens the trap flows open are
 * measured too, as live play 17 found them: Pat's ask card and Request a
 * roll from the needle trap's Ask to disarm at 390 and 320, and the group
 * save page a trap card's Save and damage opens there and at 1440.
 *
 * The combat controls' screens (docs/design-v1-combat-controls.md 9) are
 * measured at 390 x 844, 320 x 568 and 1440 x 900, at 100% and 130%, in a
 * fight of their own: Thorn dying with his class resources, an adult red
 * dragon with Fire Breath used, and a troll at 0 HP that took Fire, with
 * monsters dying at 0 HP off. Pat measures Thorn's Uses section with its
 * level-up question, a pool's amount field open and with its range error,
 * the Add sheet with no class, from Barbarian 14, Ranger 3 and Bard with
 * its modifier's error, and of his own with Spend an amount, the Update
 * and Edit sheets, his death save card, his turn card with a pool's amount
 * field, and Thorn's Uses in his row and his bar. The DM measures the
 * section in Thorn's token panel, the dragon's Uses in its row, its bar
 * and its token panel, In lair while it waits for the server, the dragon's
 * recharge card and its turn card folded and open, and the troll's
 * Regeneration card with its death save card waiting for it.
 *
 * The second icon pass (docs/design-v1-icons-2.md 15) is measured at its
 * own seven sizes: 320 x 568 and 390 x 844 at 130%, 390 x 844 at 115% and
 * 85%, and 1280 x 800 at 100%, 115% and 85%, in a fight of its own: Thorn
 * at level 7 with a stat block and a counted Hex, Wren a druid with known
 * forms, Exhaustion 2 and Poisoned, and the goblin hidden, locked and its
 * name hidden. The DM measures the side panel's tabs (one line, each
 * 44 px, no name cut) or a phone's Panels list, Thorn's and Wren's panels
 * with every group folded (each name on one line, a summary cut only at
 * its 4em floor or wider, and on a computer the Stat block's action on its
 * name's line), the goblin's header tags, the round header with its clock as tall
 * as without the timer, the tracker's and party bar's chips in their
 * 20 x 18 box, and the time-up and ended-effect lines as tall and on as
 * many lines with their lead as without it.
 *
 * Each size's step gathers every line the helper reports, shoots the
 * screens that have any, and fails once with all of them. A screen the
 * sweep must reach and did not, a root that matches nothing or only what
 * is hidden, a window with no header place, a board with no pill and a
 * holder's line missing a word are lines too. The screens that show only
 * at some sizes are counted over each file's sizes, and pl3-c fails when
 * one showed at fewer sizes than the polish pass found, so no check passes
 * by measuring nothing.
 *
 * The DM's page runs in a touch context for the phone and tablet sizes and
 * a mouse context for the desktop, one at a time, beside Pat's touch
 * context, so no more than two contexts are open.
 *
 * The isometric view's choice (docs/design-v1-isometric-view.md 8) is
 * measured at follow-up batch 30's sizes: the top bar with the View button,
 * the View menu in Top-down and in Isometric, and Scene settings'
 * Suggested view. So is the scene settings page with its groups folded and
 * open (docs/design-v1-map-discovery.md 9), beside every other page with
 * the shared radio cards: Room settings, This device and Show a handout.
 *
 * The sweep runs as five files, each with its own server, browsers and
 * room, so the CI shards run them side by side: alignment.e2e.ts has the
 * drawn cases, the upright phones and the scrolling strip,
 * alignment-wide.e2e.ts the sideways phone, the tablet, the desktop and
 * 480 x 320, and alignment-icons.e2e.ts the second icon pass.
 * alignment-followups.e2e.ts has follow-up batches 30 and 32, the app
 * icon's places and This device's Sheet handle. alignment-settings.e2e.ts
 * has the builder's note and forget question, the scene settings page
 * and the view choice.
 * This module holds every step, from alignmentFile on, and each file lists
 * the ones it runs, so a step keeps its id whichever file runs it.
 *
 * Each file runs with `pnpm test:e2e` on E2E_PORT plus twenty-seven, one
 * file after another as the others. The other environment variables are
 * the smoke run's (smoke.e2e.ts).
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
/** The sizes where the sweep also measures the older screens a trap's flows open (live play 17): Pat's ask card and Request a roll on phones, and the group save page there and on a computer. */
const PHONE_ROOTS = new Set(["390x844", "320x568"]);
const GROUP_SAVE_AT = new Set([...PHONE_ROOTS, "1440x900"]);
/** The sizes where the sweep measures the Dice panel's pass (docs/design-v1-dice-pass.md 11.3). */
const DICE_AT = new Set([...PHONE_ROOTS, "1440x900"]);
/**
 * The sizes where the sweep measures the combat controls, as their own e2e
 * files do, and a phone held sideways, where the token bar docks beside the
 * alerts column and the turn card gives way to it (docs/design-v1-combat-controls.md 9).
 */
const COMBAT_AT = new Set([...PHONE_ROOTS, "844x390", "1440x900"]);
/** The lane rule's smallest screen, measured for the combat controls alone (9): 480 x 320 at 130%. */
const COMBAT_SMALL: Size = { name: "480x320", width: 480, height: 320, touch: true };

let server: Server;
let srd: readonly SrdMonster[] = [];
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let dmTouch = true;
let ops: OpSocket;
let patOps: OpSocket;
let dmSocket = new SocketWatch("dm");
/** Every DM page's watch on the session newDmSession signed in last, its sign-in page's first (withinSnapshotBudget). */
let dmWatches: SocketWatch[] = [];
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
    dragon: randomUUID(),
    wolf: randomUUID(),
    redDragon: randomUUID(),
    troll: randomUUID(),
    wrenChar: randomUUID(),
    wren: randomUUID(),
  },
  /** The combat screens' fight: its rows, Thorn's first. The second icon pass's fight takes the goblin and Wren too. */
  fight: { thorn: randomUUID(), dragon: randomUUID(), troll: randomUUID(), goblin: randomUUID(), wren: randomUUID() },
  traps: { pit: randomUUID(), needle: randomUUID(), door: randomUUID(), wire: randomUUID() },
  /** The room's DM link, which newDmSession signs in by. */
  dmLink: "",
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

/** How many size steps measured each screen, over the file's run, for pl3-c. */
const seenAt = new Map<string, number>();

/** The files that sweep sizes, for pl3-c: the upright phones' (alignment.e2e.ts) and the wider windows' (alignment-wide.e2e.ts). */
export type SizesFile = "phones" | "wide";

/**
 * The screens that show only at some sizes, and at how many the sweep
 * meets them on the polish pass's build, in each file that sweeps sizes:
 * a chip or pop-up the row shows only where it has room, the column's
 * summary row on a short screen, and a trap name's pointer where the zoom
 * shows names. pl3-c fails when one shows at fewer, so a screen that
 * stops showing everywhere is caught.
 */
const SOME_SIZES: Record<string, Record<SizesFile, number>> = {
  "trap-start-from": { phones: 6, wide: 6 },
  "trap-more": { phones: 2, wide: 0 },
  "trap-pane-header-place": { phones: 0, wide: 6 },
  "pane-dock": { phones: 6, wide: 0 },
  "alerts-beside-pane": { phones: 0, wide: 5 },
  "alerts-column": { phones: 6, wide: 3 },
  "alerts-column-open": { phones: 6, wide: 3 },
  "alerts-summary": { phones: 1, wide: 4 },
  "alerts-overlay": { phones: 1, wide: 4 },
  "toast-under-card": { phones: 6, wide: 1 },
  "toast-hint": { phones: 6, wide: 6 },
  "ruler-measure-chip": { phones: 4, wide: 2 },
  "board points at Poisoned Needle": { phones: 4, wide: 5 },
  "board points at Hidden Pit": { phones: 4, wide: 5 },
  "pat-board points at Poisoned Needle": { phones: 4, wide: 5 },
  "pat-ask": { phones: 4, wide: 0 },
  "request-roll": { phones: 4, wide: 0 },
  "group-save": { phones: 4, wide: 2 },
  "group-save-row": { phones: 4, wide: 2 },
  "fl4-hp-bar": { phones: 6, wide: 6 },
  "fl4-defense-lines": { phones: 6, wide: 6 },
  "fl4-long-formula": { phones: 4, wide: 2 },
  "fl4-hp-heal": { phones: 6, wide: 6 },
  "fl4-hp-temp": { phones: 6, wide: 6 },
  "fl4-hp-panel": { phones: 4, wide: 2 },
  "fl4-hp-character": { phones: 4, wide: 2 },
  "fl4-hp-group": { phones: 6, wide: 6 },
  // Setup on the phone layout (the upright phones, the tablet and 844 x 390 at 100%), Tools in the pair (844 x 390 at 130%).
  "setup-menu": { phones: 6, wide: 3 },
  "tools-menu": { phones: 0, wide: 1 },
  // The token bar expanded from the strip, on the upright phones where Expand is drawn (docs/design-v1-bar-compact.md 5.1), and the group's.
  "window-expanded": { phones: 5, wide: 0 },
  "group-expanded": { phones: 5, wide: 0 },
  // The dice pass's roots (docs/design-v1-dice-pass.md 11.3), at the three dice sizes at 100% and 130%.
  "dp-modes": { phones: 4, wide: 2 },
  "dp-card-dragon": { phones: 4, wide: 2 },
  "dp-groups-dragon": { phones: 4, wide: 2 },
  "dp-recent": { phones: 4, wide: 2 },
  "dp-last": { phones: 4, wide: 2 },
  "dp-several": { phones: 4, wide: 2 },
  "dp-open-save": { phones: 4, wide: 2 },
  "dp-card-tabs": { phones: 4, wide: 2 },
  "dp-card-wolf": { phones: 4, wide: 2 },
  "dp-groups-wolf": { phones: 4, wide: 2 },
  "fl6-skills-wolf": { phones: 4, wide: 2 },
  "fl6-skills-thorn": { phones: 4, wide: 2 },
  "fl6-skills-dragon": { phones: 4, wide: 2 },
  "fl6-skills-several": { phones: 4, wide: 2 },
  // The DM's turn card folds under 600 px wide, so on the upright phones and at 480 x 320 at 130%.
  "cu-turn-folded": { phones: 4, wide: 1 },
  // With the dragon's bar across the column, the turn card folds to its row, or leaves the column where even its row would meet the bar (4.2).
  // At 844 x 390 the recharge card and the fade's room under it leave the bar too little room to stack, so it docks beside the column (barDock.ts COLUMN_FADE).
  "cu-turn-fold-bar": { phones: 4, wide: 2 },
  // Not on the upright phones, whose bar rests as the strip at the map's foot, clear of the card (docs/design-v1-bar-compact.md 3.1).
  "cu-turn-hidden-bar": { phones: 0, wide: 4 },
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

  /**
   * Measures what `root` matches and shows with the five checks, as
   * `screen`. A root that matches nothing, or only what is hidden, is a
   * screen missing, unless `optional`, when it is a screen that did not
   * show. Either way it is not counted as seen, since nothing was measured.
   */
  async measure(page: Page, screen: string, root: Locator, opts: { optional?: boolean } = {}): Promise<void> {
    const shown = root.filter({ visible: true });
    if ((await shown.count()) === 0) {
      if (!opts.optional) await this.missing(page, screen, (await root.count()) === 0 ? "nothing on the page matched it" : "what matched it is hidden");
      return;
    }
    await this.add(page, screen, [...alignmentLines(await measureAlignment(shown), `${this.at} ${screen}`), ...await damageSummaryAlignment(shown, `${this.at} ${screen}`)]);
    if (await shown.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]').count()) await this.add(page, screen, await menuWordLines(shown, `${this.at} ${screen}`));
    const popovers = shown.and(page.locator("[data-rvtt-popover]")).or(shown.locator("[data-rvtt-popover]"));
    if (await popovers.count()) await this.add(page, screen, await popoverScrollbarLines(popovers, `${this.at} ${screen}`));
    await this.add(page, screen, await proficiencyLines(shown, `${this.at} ${screen}`, false));
    await this.add(page, screen, await proficiencyHeightLines(shown, `${this.at} ${screen}`, false));
    await this.add(page, screen, spacingLines(await measureSpacing(shown), `${this.at} ${screen}`));
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

  /** Counts this size's screens into the file's tally. */
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
  if (dm && !dm.isClosed() && dmTouch === size.touch) return dm;
  const state = await dmContext.storageState();
  await dmContext.close();
  dmContext = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.touch, hasTouch: size.touch, storageState: state });
  dmTouch = size.touch;
  dm = await dmContext.newPage();
  await holdPreviews(dm);
  consoles.dm.attach(dm);
  dmSocket = new SocketWatch("dm");
  await dmSocket.attach(dmContext, dm);
  dmWatches.push(dmSocket);
  return dm;
}

/**
 * Signs the DM in again by the DM link, on a session of its own, moves the
 * op socket to it and closes the DM's page, which dmPageFor opens again on
 * the new session. Each session has its own snapshot budget (design 10.4,
 * twenty a minute), and a sweep that opens the DM's page at every size
 * spends most of one, so each such sweep starts on a whole budget rather
 * than wait out what the sweep before it spent.
 */
async function newDmSession(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const signIn = new SocketWatch("DM sign-in");
  await signIn.attach(context, page);
  dmWatches = [signIn];
  const watch = new ConsoleWatch("DM sign-in");
  // Signing in by the DM link first asks who this is, which the server answers with these two.
  watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/, /status of 409 .*\/api\/rooms\/[0-9A-Z]{8}\/dm\)$/];
  watch.attach(page);
  await page.goto(run.dmLink);
  await page.getByRole("button", { name: /Dana the DM/ }).click();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  assert.deepEqual(watch.errors, [], "the DM's sign-in logged errors");
  await page.close();
  ops.close();
  ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(context) });
  await dmContext.close();
  dmContext = context;
}

/**
 * A sweep that opens the DM's page at every size on one session spends
 * that session's snapshots: the sign-in page's, the op socket's one and
 * each DM page's since (newDmSession). One more than the budget's twenty a
 * minute waits out its window (design 10.4), so each such sweep checks it
 * stayed within one budget, and a step added to it fails here rather than
 * as a minute's delay (MDJ-F-1).
 */
function withinSnapshotBudget(sweep: string): void {
  const spent = 1 + dmWatches.reduce((n, w) => n + w.snapshotBytes.length, 0);
  const most = DEFAULT_SNAPSHOT_BUDGET.sessionCount;
  console.log(`${sweep}: ${spent} DM snapshots on its session`);
  assert.ok(spent <= most, `${sweep} spent ${spent} DM snapshots on one session, past the ${most} a minute it gets without waiting`);
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

/** The page's own toasts with these words, by their mark: the live region that speaks them is hidden and holds the same words. */
function toasts(page: Page, words: RegExp): Locator {
  return page.locator("[data-toast]").filter({ hasText: words }).filter({ visible: true });
}

async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const t = page.locator("button[data-toast], div[data-toast] > button").filter({ visible: true });
    if ((await t.count()) === 0) return;
    await t.first().click({ timeout: 1000 }).catch(() => {});
  }
}

/** Measures the toast `cause` brings, by its words, as `screen`, alone on the page, and dismisses it. */
async function toastScreen(sweep: Sweep, page: Page, screen: string, words: RegExp, cause: () => Promise<unknown>): Promise<void> {
  await dismissToasts(page);
  await cause();
  const toast = toasts(page, words);
  if (await showsWithin(toast.first(), 3_000)) await sweep.measure(page, screen, toast);
  else await sweep.missing(page, screen, `no toast read ${words}`);
  await dismissToasts(page);
}

/** An undo another's change overtook, and so refused, as `page` presses Ctrl+Z: `mine` moves Thorn, and `theirs` moves him after. */
async function refusedUndo(page: Page, mine: OpSocket, theirs: OpSocket): Promise<void> {
  // From his place on the ground, so neither move meets the pit or a ledge.
  await resetThorn();
  await mine.send({ t: "token.move", tokenId: run.ids.thorn, x: 5, y: 6 });
  await theirs.send({ t: "token.move", tokenId: run.ids.thorn, x: 5, y: 5 });
  await escapeAll(page);
  await page.keyboard.press("Control+z");
}

/** A roll of Perception with its d20, by `who`'s token, which every viewer sees. */
function rollFor(socket: OpSocket, who: string): Promise<unknown> {
  return socket.send({ t: "dice.roll", tag: randomUUID(), to: "all", rolls: [{ formula: "1d20+3", label: "Perception", creature: { tokenId: who } }] });
}

/** A pane's fields' notes as they show for a cleared name and dice that do not read, each left by Enter, and then those fields as they were. */
async function notesScreen(sweep: Sweep, page: Page, pane: Locator): Promise<void> {
  const name = pane.locator('input[aria-label="Name"]');
  const dice = pane.locator('input[aria-label="Damage dice"]').first();
  if (!(await visible(name)) || !(await visible(dice))) return sweep.missing(page, "trap-pane-notes", "the pit's pane has no Name or Damage dice field");
  const was = { name: await name.inputValue(), dice: await dice.inputValue() };
  await name.fill("");
  await name.press("Enter");
  await dice.fill("2d");
  await dice.press("Enter");
  const notes = (await showsWithin(pane.getByText("A trap needs a name."), 2_000)) && (await showsWithin(pane.getByText(/^Not a dice formula/), 2_000));
  if (notes) await sweep.measure(page, "trap-pane-notes", pane);
  else await sweep.missing(page, "trap-pane-notes", "Enter on a cleared name and on 2d gave no notes");
  await name.fill(was.name);
  await name.press("Enter");
  await dice.fill(was.dice);
  await dice.press("Enter");
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

/**
 * A bar's header: its sticky header, or on a strip that scrolls, whose
 * header scrolls with it (docs/design-v1-bar-compact.md 5.4), the row that
 * holds its Close (a group's Deselect all), marked for the measure.
 */
async function barHeader(bar: Locator): Promise<Locator> {
  const sticky = bar.locator("[data-sticky-header]");
  if ((await sticky.count()) > 0) return sticky;
  // A group's bar names its Close "Deselect all".
  const close = bar.getByRole("button", { name: /^(Close|Deselect all)$/ }).first();
  if ((await close.count()) === 0) return sticky;
  await close.evaluate((el) => {
    type El = { parentElement: El | null; getBoundingClientRect(): { width: number }; setAttribute(n: string, v: string): void; closest(s: string): El | null };
    const button = el as unknown as El;
    const width = button.closest("[data-bar-mode]")?.getBoundingClientRect().width ?? 0;
    let row = button.parentElement;
    while (row && row.getBoundingClientRect().width < width * 0.8) row = row.parentElement;
    row?.setAttribute("data-e2e-header", "");
  });
  return bar.locator("[data-e2e-header]");
}

/**
 * Measures a token window's header, play row and group line (where it has
 * one), and keeps where its header stands. An upright phone's bar is
 * measured resting as the strip for its header, and expanded for the
 * rest (docs/design-v1-bar-compact.md 11), which it stays.
 */
async function measureWindow(sweep: Sweep, page: Page, screen: string, bar: Locator, headers: HeaderPlace[], groupLine: boolean): Promise<void> {
  if ((await bar.getAttribute("data-bar-state")) === "expanded") {
    await bar.getByRole("button", { name: "Collapse", exact: true }).click();
    await waitFor("the strip", async () => ((await bar.getAttribute("data-bar-state")) === "rest" ? true : null), 3_000);
  }
  await sweep.measure(page, `${screen}-header`, await barHeader(bar));
  await expandBar(bar);
  await sweep.measure(page, `${screen}-play-row`, bar.locator('[data-bar-row="play"]'));
  await sweep.measure(page, `${screen}-group-line`, bar.getByRole("group", { name: "Attached tokens" }), { optional: !groupLine });
  const places = await headerPlaces(bar);
  if (places.length !== 1) await sweep.missing(page, `${screen}-header-place`, `read ${places.length} header places, not 1`);
  headers.push(...places);
}

/**
 * The toolbar's menu of tool tiles where it has one (docs/design-v1-tool-options.md
 * 5.1 and 5.2): Setup tools on the phone layout, Tools in the pair, whose
 * second button opens it once its own tool is active.
 */
async function toolMenuScreen(sweep: Sweep, page: Page): Promise<void> {
  const nav = page.locator('nav[aria-label="Tools"]').first();
  const setup = nav.getByRole("button", { name: /^Setup tools/ });
  const buttons = nav.locator("button[data-active]");
  // The toolbar draws its buttons once it has measured its room.
  await waitFor("the toolbar's buttons", async () => ((await visible(setup)) || (await buttons.count()) > 1 ? true : null), 3_000);
  let name = "Setup tools";
  if (await visible(setup)) await setup.first().click();
  else if ((await buttons.count()) <= 3) {
    name = "Tools";
    const second = buttons.nth(1);
    if ((await second.getAttribute("data-active")) !== "true") await second.click();
    await second.click();
  } else return;
  const menu = page.getByRole("menu", { name });
  if (!(await showsWithin(menu, 3_000))) {
    await sweep.missing(page, name === "Tools" ? "tools-menu" : "setup-menu", `${name} opened no menu`);
    await escapeAll(page);
    return;
  }
  await sweep.measure(page, name === "Tools" ? "tools-menu" : "setup-menu", page.locator("[data-rvtt-popover]").filter({ has: menu }));
  await escapeAll(page);
  await menu.waitFor({ state: "detached" });
}

/**
 * The shortcut sheet's Toolbar section, whose row for the tool's key grew
 * with the tool cycle (docs/design-v1-tool-cycle.md 7). No other file
 * measures the sheet.
 */
async function shortcutSheetScreen(sweep: Sweep, page: Page): Promise<void> {
  await escapeAll(page);
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Shortcuts" });
  if (!(await showsWithin(sheet, 3_000))) {
    await sweep.missing(page, "shortcut-sheet-toolbar", "? opened no sheet");
    return;
  }
  const section = sheet.getByRole("heading", { name: "Toolbar", exact: true }).locator("xpath=ancestor::section[1]");
  await section.scrollIntoViewIfNeeded();
  await sweep.measure(page, "shortcut-sheet-toolbar", section);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
}

/** The DM's screens at one size. */
async function dmScreens(sweep: Sweep, page: Page, size: Size): Promise<void> {
  const headers: HeaderPlace[] = [];
  // Pat's walk left a springing waiting, whose card could cover a trap.
  await settleTraps();
  await sweep.pills(page, "board", { points: await trapPoints(page, true), needPills: true });
  await toolMenuScreen(sweep, page);
  await shortcutSheetScreen(sweep, page);

  // FL5: the real room's More menu, alongside the component fixture at phone widths where Room uses a sheet instead.
  const morePanels = page.getByRole("tablist", { name: "Panels" }).locator('[aria-haspopup="menu"]');
  if (await visible(morePanels)) {
    await morePanels.click();
    const menu = page.getByRole("menu", { name: "More panels" });
    await menu.waitFor();
    await sweep.measure(page, "fl5-more-panels", page.locator("[data-rvtt-popover]").filter({ has: menu }));
    await page.keyboard.press("Escape");
  }

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
    // Its fields' notes too, which push the groups under them down (live play 18).
    if (which === "pit") await notesScreen(sweep, page, pane);
    if (which === "needle" && PHONE_ROOTS.has(size.name)) await requestScreen(sweep, page, pane);
    if (await visible(pane)) {
      await dismissToasts(page);
      await pane.getByRole("button", { name: "Done", exact: true }).click();
      await pane.waitFor({ state: "detached" });
    }
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

  // The DM's other toasts (live play 18): Pat's whisper, an undo Pat's move overtook, and Pat's roll with its die. They come before the group save pages, which leave a computer's Dice tab open, and a roll shows there with no toast.
  const dmId = dmSocket.you?.memberId;
  if (dmId) await toastScreen(sweep, page, "toast-whisper", /altar hums/, () => patOps.send({ t: "log.whisper", to: [dmId], text: "The altar hums." }));
  else await sweep.missing(page, "toast-whisper", "the DM's member id was not known");
  await toastScreen(sweep, page, "toast-refusal", /^Could not undo/, () => refusedUndo(page, ops, patOps));
  await toastScreen(sweep, page, "toast-roll", /Perception/, () => rollFor(patOps, run.ids.thorn));
  await resetThorn();

  // One trap card leaves room for a toast below every drawn card, even on
  // the shortest phone. A full stack is measured separately below.
  await settleTraps();
  await waitFor("the settled trap cards to leave", async () => (await page.getByRole("group", { name: /went off$/ }).count()) === 0 ? true : null);
  await patCrosses();
  const underCard = toasts(page, /went off/);
  if (await showsWithin(underCard.first(), 3_000)) {
    await sweep.add(page, "toast-lane", await toastLaneLines(page, `${sweep.at} toast-under-card`));
    if ((await toastsUnderCards(page)) > 0) sweep.seen.add("toast-under-card");
    else if (size.width < size.height && size.width <= 430) await sweep.missing(page, "toast-under-card", "the toast stood under no alert card");
  } else await sweep.missing(page, "toast-under-card", "no toast for the trip wire");
  await dismissToasts(page);

  // The full column must also leave every toast clear of its cards.
  await spring(run.traps.door);
  await spring(run.traps.pit);
  await spring(run.traps.pit);
  await spring(run.traps.needle);
  await patCrosses();
  const wentOff2 = toasts(page, /went off/);
  if (await showsWithin(wentOff2.first(), 3_000)) {
    await sweep.measure(page, "toast-column", wentOff2);
    await sweep.add(page, "toast-lane", await toastLaneLines(page, `${sweep.at} toast-lane`));
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

  // An opened first card must itself exceed the column. Extra cards no longer
  // force a summary, so give this card a long note for the summary and overlay cases.
  const wireNote = dmSocket.state?.traps?.[run.traps.wire]?.rig?.note ?? null;
  const tallNote = Array.from({ length: 60 }, (_, i) => `Reset step ${i + 1}`).join("\n");
  await ops.send({ t: "trap.update", trapId: run.traps.wire, patch: { rig: { note: tallNote } } });
  const summary = page.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ });
  try {
    if (await showsWithin(summary.first(), 2_500)) {
      await sweep.measure(page, "alerts-summary", summary.first());
      await summary.first().click();
      const overlay = page.getByRole("dialog", { name: "Alerts" });
      if (await showsWithin(overlay, 2_500)) await sweep.measure(page, "alerts-overlay", overlay);
      else await sweep.missing(page, "alerts-overlay", "a tap on the summary row showed no alerts");
    } else await sweep.missing(page, "alerts-summary", "the opened first card's long note did not force a summary");
    if (!column && !(await visible(summary))) await sweep.missing(page, "alerts-column", "neither the column nor its summary row showed");
  } finally {
    try {
      await escapeAll(page);
    } finally {
      await ops.send({ t: "trap.update", trapId: run.traps.wire, patch: { rig: { note: wireNote } } });
    }
  }
  // The needle trap's page holds its outcome's fields. Its cone caught no one, so the door trap, which hits the creature that set it off, is set off again for a page that holds Thorn's row, its card new at the column's top.
  if (GROUP_SAVE_AT.has(size.name)) {
    await groupSaveScreen(sweep, page, "group-save", "Poisoned Needle Gauntlet of the Sunless Citadel");
    await spring(run.traps.door);
    await groupSaveScreen(sweep, page, "group-save-row", "Scything Door");
    // The Hidden Pit has no save, so its page holds Apply in its sticky foot from the start (review LP17-HP-1). On a phone its card is folded among the others.
    if (size.name === "1440x900") await groupSaveScreen(sweep, page, "group-save-no-save", "Hidden Pit");
  }

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
    const before = dmSocket.state!.characters[run.ids.thornChar]!;
    try {
      // FL-4: differing result widths expose drifting originals, and the two defense lines expose their labels' baselines.
      await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { stats: { defenses: { fire: "resistant", slashing: "immune" } } } });
      await thorn.getByLabel("HP change", { exact: true }).fill("28 fire + 14 slashing + 10");
      await thorn.getByLabel("HP change", { exact: true }).blur();
      const slip = thorn.locator("[data-damage-summary]");
      await slip.getByText("Immune: Slashing", { exact: true }).waitFor();
      await slip.getByText("Resists: Fire", { exact: true }).waitFor();
      assert.deepEqual(await slip.locator("s").allTextContents(), ["28", "14"]);
      await sweep.measure(page, "fl4-hp-bar", slip);
      await sweep.measure(page, "fl4-defense-lines", slip);
    } finally {
      await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { stats: before.stats ?? null, ...(!before.stats ? { actor: { initBonus: before.actor.initBonus, passivePerception: before.actor.passivePerception } } : {}) } });
    }
    for (const [screen, value] of [["fl4-hp-heal", "+5"], ["fl4-hp-temp", "t5"]] as const) {
      await thorn.getByLabel("HP change", { exact: true }).fill(value);
      await thorn.getByLabel("HP change", { exact: true }).blur();
      await sweep.measure(page, screen, thorn.locator("[data-damage-summary]"));
    }
    await thorn.getByLabel("HP change", { exact: true }).fill("");
    // An upright phone's bar expanded from the strip, whole (docs/design-v1-bar-compact.md 5), as measureWindow leaves it.
    if ((await thorn.getAttribute("data-bar-state")) === "expanded") await sweep.measure(page, "window-expanded", thorn);
    const attach = await barControl(thorn, "Attach");
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
    const multi = await barControl(goblin, "Multi-select");
    await multi.click();
    await tapCell(page, BOUNDS, { x: 4, y: 4 });
    // The prisoner too where the window leaves its cell clear, as on a short screen it may not.
    if (await canvasAt(page, { x: 10, y: 3 })) await tapCell(page, BOUNDS, { x: 10, y: 3 });
    const group = page.locator('[role="dialog"][data-bar-mode]');
    if (await showsWithin(group.first(), 3_000)) {
      // FL-3: both group entry points show mixed typed damage at every measured size.
      await group.first().getByLabel("HP change", { exact: true }).fill("11 cold + 3 fire");
      await group.first().getByLabel("HP change", { exact: true }).blur();
      await measureWindow(sweep, page, "window-group", group.first(), headers, false);
      await sweep.measure(page, "fl4-hp-group", group.first().locator("[data-damage-summary]"));
      // The group's bar expanded from its strip on an upright phone.
      if ((await group.first().getAttribute("data-bar-state")) === "expanded") await sweep.measure(page, "group-expanded", group.first());
      await openTracker(page);
      const several = page.getByText("Several at once", { exact: true }).locator("xpath=ancestor::section[1]");
      await several.getByLabel("HP change", { exact: true }).fill("11 cold + 3 fire");
      await several.getByLabel("HP change", { exact: true }).blur();
      await sweep.measure(page, "tracker-group-hp", several);
      const trackerSheet = page.locator("dialog[data-rvtt-sheet]").filter({ has: page.locator("[data-round-header]") });
      if (await visible(trackerSheet)) await page.keyboard.press("Escape");
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

  // A dying Thorn's strip, Crit in its quick row where it fits (docs/design-v1-bar-compact.md 3.3), on the upright phones the design measured. The row is the strip's content, measured wherever the strip draws one.
  if (PHONE_ROOTS.has(size.name)) {
    await ops.send({ t: "actor.hp", target: { characterId: run.ids.thornChar }, change: { kind: "damage", amount: 30 } });
    await waitFor("Thorn at 0 HP", () => (dmSocket.state?.characters[run.ids.thornChar]?.actor.hp.cur === 0 ? true : null));
    const dying = await selectToken(page, "Thorn", { x: 5, y: 5 });
    if (dying) {
      const row = dying.locator("[data-rest-row]");
      await sweep.measure(page, "rest-crit", row, { optional: (await row.count()) === 0 });
    } else await sweep.missing(page, "rest-crit", "a tap on the dying Thorn opened no window");
    await escapeAll(page);
    await ops.send({ t: "actor.hp", target: { characterId: run.ids.thornChar }, change: { kind: "heal", amount: 30 } });
  }

  if (GROUP_SAVE_AT.has(size.name)) {
    // FL-4: panel and character pages share the entry, but have different available widths.
    const panel = await ic2TokenPanel(page, "Goblin", "Goblin", { x: 9, y: 3 });
    for (const [screen, host] of [["fl4-hp-panel", panel], ["fl4-hp-character", null]] as const) {
      const target = screen === "fl4-hp-character" ? await thornsPage(page) : host;
      if (!target) { await sweep.missing(page, screen, "the HP page did not open"); continue; }
      const combat = target.getByRole("button", { name: "Combat", exact: true });
      if (await visible(combat) && await combat.getAttribute("aria-expanded") === "false") await combat.click();
      const field = target.getByLabel("HP change", { exact: true });
      await field.fill("28 fire + 14 slashing + 10");
      await field.blur();
      await sweep.measure(page, screen, target.locator("[data-damage-summary]"));
      await field.fill("");
      await closeSheets(page);
      await escapeAll(page);
    }
  }

  if (headers.length === 0) await sweep.missing(page, "headers", "no header place was read");
  await sweep.add(page, "headers", headerLines(headers, `${sweep.at} headers`));
}

/** A panel by its title: the side panel's tab where the page has one, else the Panels sheet's. */
async function openPanelOf(page: Page, title: string): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if (await visible(tabs)) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel", { name: sideTabName(title) });
  }
  const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  if (await visible(sheet)) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await sheet.waitFor();
  return sheet;
}

/** pv-a: the sizes where the sweep measures the whole What players see section on a per-player scene, as docs/design-v1-per-player-vision.md 11 asks. */
const VISION_SECTION_AT = new Set([...PHONE_ROOTS, "1440x900"]);

/**
 * pv4: per-player vision's settings in What players see
 * (docs/design-v1-per-player-vision.md 7.1 and 11): the Sight row, and who
 * sees for themselves with Pat unticked, listed off, and asked about as the
 * DM unticks him. The scene is made per player with vision and fog off, so
 * nothing Pat sees changes, and whole party again after. At
 * VISION_SECTION_AT's sizes the whole section is measured first with
 * vision on (pv-a), so Custom with its fold open and the rows that lend
 * sight to Pat show too: Pat's page is closed by then, and the fold back
 * to whole party empties the list.
 */
async function visionScreens(sweep: Sweep, page: Page, size: Size): Promise<void> {
  const sceneId = run.sceneId;
  // Fog stays off, as the room has it: turning vision on would turn it on too, and fog would hide from Pat what the next size's screens show him.
  const sight = (perPlayer: boolean, on = false) => ops.send({ t: "scene.update", sceneId, patch: { fogEnabled: false, vision: { on, light: "bright", perPlayer } } });
  try {
    await escapeAll(page);
    if (VISION_SECTION_AT.has(size.name)) {
      await sight(true, true);
      const panel = await openPanelOf(page, "Scenes");
      const lends = panel.getByText("Lends its sight to Pat");
      if (await showsWithin(lends.first(), 5_000)) {
        const section = panel.locator("[data-vision-sight]").locator("xpath=ancestor::*[@data-panel-group][1]");
        await section.scrollIntoViewIfNeeded();
        await sweep.measure(page, "vision-section", section);
      } else await sweep.missing(page, "vision-section", "the What players see group on a per-player scene with vision on named no creature lending its sight to Pat");
      await escapeAll(page);
    }
    await sight(true);
    const panel = await openPanelOf(page, "Scenes");
    const row = panel.locator("[data-vision-sight]");
    if (!(await showsWithin(row, 5_000))) {
      await sweep.missing(page, "vision-sight", "the Scenes panel showed no Sight row");
      return;
    }
    await row.scrollIntoViewIfNeeded();
    await sweep.measure(page, "vision-sight", row);
    const list = panel.getByRole("group", { name: "Who sees for themselves" });
    await list.scrollIntoViewIfNeeded();
    await sweep.measure(page, "vision-holders", list);
    await ops.send({ t: "vision.holders", sceneId, on: [run.patId] });
    await ops.send({ t: "vision.holders", sceneId, on: [] });
    const off = list.getByText("Pat sees only what creatures that share sight see here.");
    if (await showsWithin(off, 5_000)) await sweep.measure(page, "vision-holders-off", list);
    else await sweep.missing(page, "vision-holders-off", "Pat's entry turned off showed no line");
    await ops.send({ t: "vision.holders", sceneId, on: [run.patId] });
    const box = list.getByRole("checkbox", { name: "Pat" });
    await waitFor("Pat ticked", async () => ((await box.isChecked()) ? true : null), 5_000);
    await box.click();
    const question = list.getByRole("group", { name: "Untick Pat?" });
    if (await showsWithin(question, 3_000)) {
      await question.scrollIntoViewIfNeeded();
      await sweep.measure(page, "vision-untick", list);
      await question.getByRole("button", { name: "Cancel", exact: true }).click();
    } else await sweep.missing(page, "vision-untick", "an untick asked nothing");
  } finally {
    await sight(false);
    await escapeAll(page);
  }
}

/** The preview socket the DM page asked for last, held unanswered (previewWaitScreens). */
let heldPreview: WebSocketRoute | null = null;

/**
 * Holds every preview socket (`as=`, not a display's) the page opens. Set
 * as the page is made, before it loads the room: Playwright routes only
 * the sockets of a document loaded after the route.
 */
async function holdPreviews(page: Page): Promise<void> {
  await page.routeWebSocket(/[?&]as=(?!display)/, (ws) => {
    heldPreview = ws;
  });
}

/**
 * What is wrong with a preview wait's words at the interface size `scale`:
 * they must draw at 14 px times it, since the preview's dialog zooms
 * nothing and the wait zooms its words itself (review PV4-ASTRA-2), and
 * keep inside their box and the window.
 */
async function previewWaitTextLines(words: Locator, scale: number, label: string): Promise<string[]> {
  const got = await words.evaluate((el) => {
    type El = {
      currentCSSZoom?: number;
      scrollWidth: number;
      clientWidth: number;
      getBoundingClientRect(): { left: number; right: number; top: number; bottom: number };
      ownerDocument: { defaultView: { innerWidth: number; innerHeight: number; getComputedStyle(e: unknown): { fontSize: string } } };
    };
    const box = el as unknown as El;
    const view = box.ownerDocument.defaultView;
    const r = box.getBoundingClientRect();
    return {
      px: parseFloat(view.getComputedStyle(box).fontSize) * (box.currentCSSZoom ?? 1),
      sideways: box.scrollWidth - box.clientWidth,
      inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= view.innerWidth + 0.5 && r.bottom <= view.innerHeight + 0.5,
    };
  });
  const lines: string[] = [];
  if (Math.abs(got.px - 14 * scale) > 0.5) lines.push(`${label}: its words draw at ${got.px.toFixed(1)} px, not ${(14 * scale).toFixed(1)}`);
  if (got.sideways > 0) lines.push(`${label}: its words run ${got.sideways} px past their box`);
  if (!got.inside) lines.push(`${label}: its words leave the window`);
  return lines;
}

/**
 * pv4: View as a player's wait (docs/design-v1-per-player-vision.md 7.4
 * and 11): its socket is held unanswered (holdPreviews), so "Loading
 * what Pat sees…" stands, then closed, so it says it could not load, in
 * an alert with Try again (docs/design-v1-design-pass.md 4.4). Each time
 * its words' drawn size and fit are checked at `scale`.
 */
async function previewWaitScreens(sweep: Sweep, page: Page, scale: number): Promise<void> {
  heldPreview = null;
  await escapeAll(page);
  const panel = await openPanelOf(page, "DM");
  const view = panel.getByRole("button", { name: "View", exact: true });
  await view.scrollIntoViewIfNeeded();
  await view.click();
  const preview = page.locator('dialog[aria-label="Viewing as Pat"]');
  await preview.waitFor();
  try {
    const loading = preview.locator('[data-preview-wait="loading"]');
    // The status stays mounted, empty until the shared delay, so the wait is for its words.
    const loadingWords = loading.getByRole("status").filter({ hasText: "Loading what Pat sees" });
    if (await showsWithin(loadingWords, 3_000)) {
      await sweep.measure(page, "preview-loading", loading);
      await sweep.add(page, "preview-loading-words", await previewWaitTextLines(loadingWords, scale, `${sweep.at} preview-loading-words`));
    } else await sweep.missing(page, "preview-loading", "the preview showed no loading line");
    // Read through a cast: the route's handler sets it after the reset above, which the compiler cannot see.
    const held = await waitFor("the preview's socket", () => heldPreview as WebSocketRoute | null, 5_000);
    await held.close();
    const failed = preview.locator('[data-preview-wait="failed"]');
    const failedWords = failed.getByRole("alert").filter({ hasText: "Could not load what Pat sees." });
    if (await showsWithin(failedWords, 3_000)) {
      await sweep.measure(page, "preview-failed", failed);
      await sweep.add(page, "preview-failed-words", await previewWaitTextLines(failedWords, scale, `${sweep.at} preview-failed-words`));
    } else await sweep.missing(page, "preview-failed", "a closed preview socket said nothing");
  } finally {
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await escapeAll(page);
  }
}

/** Where the Adult Black Dragon stands while the dice screens measure it: a huge token's corner, its cells free of the traps and walls. */
const DRAGON_AT = { x: 5, y: 10 };

/** The Dice panel: the side panel's tab where the page has one, else the Panels sheet's Dice. */
async function openDice(page: Page): Promise<Locator> {
  return openPanel(page, "Dice");
}

/** Every skill's name and bonus stay on one line, wholly inside their button, even if its tag needs another line. */
async function skillLabelScreen(sweep: Sweep, page: Page, host: Locator, creature: string): Promise<void> {
  const screen = `fl6-skills-${creature}`;
  const skills = host.locator("[data-panel-group]").filter({ has: page.getByRole("button", { name: "Skills", exact: true }) });
  await skills.evaluate(async (el) => { await (el as unknown as { ownerDocument: { fonts: { ready: Promise<unknown> } } }).ownerDocument.fonts.ready; });
  await sweep.measure(page, screen, skills);
  const lines = await skills.locator("button[aria-label]").evaluateAll((buttons, names) => {
    type Rect = { top: number; left: number; right: number; width: number };
    type El = { textContent: string | null; querySelector(selector: string): El | null; getBoundingClientRect(): Rect; ownerDocument: { createRange(): { selectNodeContents(el: El): void; getClientRects(): ArrayLike<Rect> }; defaultView: { getComputedStyle(el: El): { paddingLeft: string; paddingRight: string; borderLeftWidth: string; borderRightWidth: string } } }; currentCSSZoom?: number };
    const out: string[] = [];
    if (buttons.length !== names.length) out.push(`found ${buttons.length} skill labels, expected ${names.length}`);
    for (const name of names) {
      const button = buttons.find((el) => {
        const text = (el as unknown as El).textContent;
        return text === name || text?.startsWith(`${name} `);
      }) as unknown as El | undefined;
      if (!button) { out.push(`${name} is missing`); continue; }
      const label = button.querySelector("span:first-child") ?? button;
      const range = label.ownerDocument.createRange();
      range.selectNodeContents(label);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      if (rects.length === 0 || rects.some((r) => Math.abs(r.top - rects[0]!.top) > 1)) out.push(`${name} is hidden or wraps`);
      const box = button.getBoundingClientRect();
      const css = label.ownerDocument.defaultView.getComputedStyle(button);
      const zoom = button.currentCSSZoom ?? 1;
      const left = box.left + (parseFloat(css.paddingLeft) + parseFloat(css.borderLeftWidth)) * zoom;
      const right = box.right - (parseFloat(css.paddingRight) + parseFloat(css.borderRightWidth)) * zoom;
      if (rects.some((r) => r.left < left - 1 || r.right > right + 1)) out.push(`${name} runs past its button's content box`);
    }
    return out;
  }, Object.values(SKILLS).map((s) => s.name));
  await sweep.add(page, screen, lines.map((line) => `${sweep.at} ${screen}: ${line}`));
}

/** Closes the Dice sheet where it stands over the map, so the map takes taps again. */
async function closeDiceSheet(page: Page): Promise<void> {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
  if (!(await visible(sheet))) return;
  await sheet.getByRole("button", { name: "Close Dice", exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
}

/**
 * The dice pass's roots on Pat's page (docs/design-v1-dice-pass.md 11.3):
 * his creatures' tabs across the card, Thorn's wolf picked, its card, and
 * every group of its options unfolded. The wolf joins Pat's creatures for
 * these screens only, so no other screen meets it.
 */
async function patDiceScreens(sweep: Sweep, page: Page): Promise<void> {
  await ops.send({ t: "token.create", token: { id: run.ids.wolf, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Wolf", x: 2, y: 2, disposition: "ally", ownerIds: [run.patId], companion: { of: run.ids.thornChar, turn: "shared" }, actor: { inline: actor({ srdId: "wolf" }) } } });
  await waitFor("the wolf on Pat's page", () => (dmSocket.state?.tokens[run.ids.wolf] ? true : null));
  try {
    const host = await openDice(page);
    const tabs = host.getByRole("tablist", { name: "Roll for" });
    if (!(await showsWithin(tabs, 4_000))) return sweep.missing(page, "dp-card-tabs", "Pat's creatures showed no tabs");
    await tabs.getByRole("tab", { name: "Thorn", exact: true }).click();
    await host.getByRole("region", { name: "Rolls for Thorn" }).waitFor();
    await sweep.measure(page, "dp-card-tabs", host.locator("[data-dice-card]"));
    await unfoldAll(host.locator("[data-roll-options]"));
    const bonus = host.getByRole("textbox", { name: "Bonus", exact: true });
    const before = await bonus.inputValue();
    for (const value of ["", "-20", "+30"]) {
      await bonus.fill(value);
      await skillLabelScreen(sweep, page, host, "thorn");
    }
    await bonus.fill(before);
    await tabs.getByRole("tab", { name: "Wolf", exact: true }).click();
    await host.getByRole("region", { name: "Rolls for Wolf" }).waitFor();
    await host.getByRole("button", { name: /^Bite/ }).first().waitFor();
    await unfoldAll(host.locator("[data-roll-options]"));
    await sweep.measure(page, "dp-card-wolf", host.locator("[data-dice-card]"));
    await sweep.measure(page, "dp-groups-wolf", host.locator("[data-roll-options] [data-panel-group]"));
    await skillLabelScreen(sweep, page, host, "wolf");
    await tabs.getByRole("tab", { name: "Thorn", exact: true }).click();
    await closeDiceSheet(page);
  } finally {
    await ops.send({ t: "token.delete", tokenId: run.ids.wolf });
  }
}

/**
 * The dice pass's roots on the DM's page (docs/design-v1-dice-pass.md 11.3):
 * an Adult Black Dragon's roll modes, card and every group unfolded,
 * Recent rolls, the sticky line after a roll, three selected with their
 * card and groups, and the notice of a group save left open. The dragon
 * stands on the map for these screens only.
 */
async function dmDiceScreens(sweep: Sweep, page: Page): Promise<void> {
  await ops.send({ t: "token.create", token: { id: run.ids.dragon, sceneId: run.sceneId, size: "huge", visibility: "all", kind: "monster", name: "Adult Black Dragon", ...DRAGON_AT, disposition: "hostile", actor: { inline: actor({ srdId: "adult-black-dragon" }) } } });
  await waitFor("the dragon on the DM's page", () => (dmSocket.state?.tokens[run.ids.dragon] ? true : null));
  try {
    // The goblin's group window before this left Multi-select on, where a tap adds to the selection and Multi-select's own button turns it off.
    await escapeAll(page);
    const none = page.getByRole("button", { name: "Deselect all" }).first();
    if (await visible(none)) await none.click();
    const done = page.getByRole("button", { name: "Done", exact: true });
    if (await visible(done)) await done.click();
    const bar = await selectToken(page, "Adult Black Dragon", { x: DRAGON_AT.x + 1, y: DRAGON_AT.y + 1 });
    if (!bar) return sweep.missing(page, "dp-card-dragon", "a tap on the dragon opened no window");
    await (await barControl(bar, "Roll")).click();
    const host = await openDice(page);
    await host.getByRole("region", { name: "Rolls for Adult Black Dragon" }).waitFor();
    await host.getByRole("button", { name: /^Rend/ }).first().waitFor();
    await unfoldAll(host.locator("[data-roll-options]"));
    await unfoldAll(host.locator("[data-dice-recent]"));
    await sweep.measure(page, "dp-modes", host.locator("[data-dice-modes]"));
    await sweep.measure(page, "dp-card-dragon", host.locator("[data-dice-card]"));
    await sweep.measure(page, "dp-groups-dragon", host.locator("[data-roll-options] [data-panel-group]"));
    await skillLabelScreen(sweep, page, host, "dragon");
    await sweep.measure(page, "dp-recent", host.locator("[data-dice-recent]"));
    const field = host.getByLabel("Dice formula", { exact: true });
    await field.fill("1d20+5 Stealth");
    await field.press("Enter");
    await host.locator('[data-dice-last] [aria-label="Show this roll in Recent rolls"]').waitFor();
    await sweep.measure(page, "dp-last", host.locator("[data-dice-last]"));

    // Three selected: the dragon, still selected with its window open, the goblin and the kobold. A second tap on the dragon would let it go.
    await closeDiceSheet(page);
    const again = page.getByRole("dialog", { name: "Adult Black Dragon actions" });
    if (!(await showsWithin(again, 3_000))) return sweep.missing(page, "dp-several", "the dragon's window closed with the Dice sheet");
    await (await barControl(again, "Multi-select")).click();
    // Two more creatures where the map shows them: the dragon's window covers some cells at some sizes.
    let added = 0;
    for (const cell of [{ x: 4, y: 4 }, { x: 9, y: 3 }, { x: 8, y: 8 }, { x: 15, y: 11 }, { x: 3, y: 7 }]) {
      if (added === 2) break;
      if (!(await canvasAt(page, cell))) continue;
      await tapCell(page, BOUNDS, cell);
      added++;
    }
    const group = page.locator('[role="dialog"][data-bar-mode]').filter({ hasText: /\d+ selected/ }).first();
    if (!(await showsWithin(group, 3_000))) return sweep.missing(page, "dp-several", `Multi-select and ${added} taps opened no group window`);
    await (await barControl(group, "Roll")).click();
    const several = await openDice(page);
    const rolls = several.locator('section[aria-label="Group rolls"]');
    if (!(await showsWithin(rolls.getByRole("heading", { name: /^\d+ selected$/ }), 5_000))) return sweep.missing(page, "dp-several", "the group window's Roll showed no several-selected card");
    await unfoldAll(rolls);
    await sweep.measure(page, "dp-several", rolls);
    await skillLabelScreen(sweep, page, rolls, "several");

    // A group save set up and left open: the notice above the card.
    await rolls.getByRole("button", { name: "Set up a group save", exact: true }).click();
    // The page's back button, in the sheet's header on a phone and in the side panel's header on a computer.
    await page.getByRole("button", { name: "Back to Dice" }).filter({ visible: true }).first().click();
    await sweep.measure(page, "dp-open-save", several.locator("[data-open-group-save]"));
    await several.locator("[data-open-group-save]").getByRole("button", { name: "Open", exact: true }).click();
    await several.getByRole("button", { name: "Discard", exact: true }).first().click();
    await several.locator("[data-open-group-save]").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Deselect all" }).first().click();
    await closeDiceSheet(page);
    await escapeAll(page);
  } finally {
    await ops.send({ t: "token.delete", tokenId: run.ids.dragon });
  }
}

// ------------------------------------------------------------ the combat controls (docs/design-v1-combat-controls.md 9)

const RED_DRAGON = "Adult Red Dragon";
/** The troll's cells, in the board's corner, clear of the traps and the dragon. */
const TROLL_AT = { x: 1, y: 11 };
/** Thorn's class resources: Rage from a preset read at level 5, so his level of 7 asks to update it, and a pool. */
const THORN_RESOURCES = [
  { id: "rage", name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 },
  { id: "loh", name: "Lay on Hands", max: 25, reset: "long", pool: true },
];
const LEVEL_UP = "Your level went up. Update Barbarian resources?";

function srdActor(id: string, hp?: number) {
  const m = srd.find((x) => x.srdId === id);
  assert.ok(m, `no SRD monster ${id}`);
  const made = monsterActor(m);
  return hp === undefined ? made : { ...made, hp: { ...made.hp, cur: hp } };
}

/** Moves the turn on, as the DM, until `entryId` acts. */
async function turnTo(entryId: string): Promise<void> {
  for (let i = 0; i < 4 && dmSocket.state?.encounter?.activeEntryId !== entryId; i++) {
    const encounter = dmSocket.state!.encounter!;
    await ops.send({ t: "encounter.next", from: { entry: encounter.activeEntryId, round: encounter.round } });
    await waitFor("the turn moved", () => (dmSocket.state?.encounter?.activeEntryId !== encounter.activeEntryId || dmSocket.state?.encounter?.round !== encounter.round ? true : null));
  }
  assert.equal(dmSocket.state?.encounter?.activeEntryId, entryId);
}

/**
 * The combat screens' fight, in place of the sweep's own: Thorn at 0 HP
 * with no class resources yet, the red dragon with Fire Breath used, and
 * the troll at 0 HP after Fire, all three in a fight on Thorn's turn, with
 * monsters dying at 0 HP off so the troll is dying, not dead.
 */
async function combatStart(): Promise<void> {
  await settleTraps();
  if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
  await ops.send({ t: "room.update", settings: { monstersDieAtZero: false } });
  const monster = (id: string, extra: Record<string, unknown>) => ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, visibility: "all", kind: "monster", disposition: "hostile", ...extra } });
  await monster(run.ids.redDragon, { name: RED_DRAGON, size: "huge", ...DRAGON_AT, actor: { inline: srdActor("adult-red-dragon") } });
  await monster(run.ids.troll, { name: "Troll", size: "large", ...TROLL_AT, actor: { inline: srdActor("troll", 10) } });
  await ops.send({ t: "actor.hp", target: { tokenId: run.ids.troll }, change: { kind: "damage", amount: 10, types: ["fire"] } });
  await ops.send({ t: "actor.hp", target: { characterId: run.ids.thornChar }, change: { kind: "damage", amount: 30 } });
  await ops.send({ t: "actor.use", target: { tokenId: run.ids.redDragon }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5, ifReady: true } });
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: run.fight.thorn, tokenId: run.ids.thorn, value: 20 },
      { id: run.fight.dragon, tokenId: run.ids.redDragon, value: 15 },
      { id: run.fight.troll, tokenId: run.ids.troll, value: 10 },
    ],
  });
  await waitFor("the combat screens' fight", () => dmSocket.state?.encounter?.entries.some((e) => e.id === run.fight.troll) || null);
  await turnTo(run.fight.thorn);
  await waitFor("Thorn's turn record, dying", () => (dmSocket.state?.characters[run.ids.thornChar]?.actor.turnRecord?.life === "dying" ? true : null));
}

/** The sweep's room as it was: no fight of the combat screens, no dragon or troll, Thorn healed with no class resources or level. */
async function combatEnd(): Promise<void> {
  consoles.dm.expectSocketFailures = false;
  await dmContext.setOffline(false);
  if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
  for (const id of [run.ids.redDragon, run.ids.troll]) await ops.send({ t: "token.delete", tokenId: id }).catch(() => {});
  await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { resources: [], level: null } });
  await ops.send({ t: "actor.hp", target: { characterId: run.ids.thornChar }, change: { kind: "heal", amount: 30 } });
  await ops.send({ t: "room.update", settings: { monstersDieAtZero: true } });
}

/** Puts away a phone's open sheets, which would take a tap meant for the map. */
async function closeSheets(page: Page): Promise<void> {
  const open = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true });
  for (let i = 0; i < 3; i++) {
    const n = await open.count();
    if (n === 0) return;
    await open.first().getByRole("button", { name: /^Close / }).first().click();
    await waitFor("a sheet put away", async () => ((await open.count()) < n ? true : null), 5_000);
  }
}

/**
 * An alert card by its name: in the alerts column, or, where the column
 * stands as its summary row, in the alerts that row opens over the screen.
 */
async function alertCard(page: Page, name: string | RegExp): Promise<Locator | null> {
  const inColumn = page.getByRole("group", { name, exact: true }).filter({ visible: true }).first();
  if (await showsWithin(inColumn, 3_000)) return inColumn;
  const summary = page.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ });
  if (!(await visible(summary))) return null;
  await summary.first().click();
  // A summary can restore the column or open Alerts. The named group is reachable in either place.
  return (await showsWithin(inColumn, 4_500)) ? inColumn : null;
}

/** The tracker: the side panel's tab from 900 layout px up, else the sheet the turn strip's button opens. */
async function openTracker(page: Page): Promise<Locator> {
  const tab = page.getByRole("tab", { name: "Initiative" });
  if (await visible(tab)) await tab.first().click();
  else await page.getByRole("button", { name: /^Initiative, round/ }).first().click();
  await page.locator("[data-round-header]").first().waitFor();
  return page.locator("[data-round-section]").first();
}

/** A creature's Uses group in its tracker row's options, opened. */
async function rowUses(page: Page, name: string): Promise<{ tracker: Locator; group: Locator }> {
  const tracker = await openTracker(page);
  const toggle = tracker.getByRole("button", { name: `${name} options` });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const group = tracker.getByRole("group", { name: `${name}'s uses` });
  await group.waitFor();
  return { tracker, group };
}

/** A creature's token bar's Uses drawer, opened from a tap on its token, or null where the map has no room for the tap. */
async function barUses(page: Page, name: string, cell: { x: number; y: number }): Promise<{ bar: Locator; drawer: Locator } | null> {
  await closeSheets(page);
  await escapeAll(page);
  if (!(await canvasAt(page, cell))) return null;
  const bar = await selectToken(page, name, cell);
  if (!bar) return null;
  const uses = await barControl(bar, "Uses");
  await waitFor("the Uses button ready", async () => ((await uses.isEnabled()) ? true : null));
  if ((await uses.getAttribute("aria-pressed")) !== "true") await uses.click();
  const drawer = bar.locator("[data-uses-drawer]");
  await drawer.waitFor();
  return { bar, drawer };
}

async function closeBar(bar: Locator): Promise<void> {
  if ((await bar.count()) === 0) return;
  await bar.getByRole("button", { name: "Close", exact: true }).first().click();
  await bar.waitFor({ state: "detached" });
}

/** The Characters panel: the side panel's tab where there is a side panel, else a sheet from the tool bar's Panels list. */
async function openCharacters(page: Page): Promise<Locator> {
  return openPanel(page, "Characters");
}

/** A panel by its title: the side panel's tab where the page has one, else the Panels sheet's. */
async function openPanel(page: Page, title: string): Promise<Locator> {
  const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  if (await visible(sheet)) return sheet;
  await closeSheets(page);
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if (await visible(tabs)) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel", { name: sideTabName(title) });
  }
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  // A hidden desktop panel returns as tabs. A phone returns as the panel picker.
  if (await showsWithin(tabs, 300)) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel", { name: sideTabName(title) });
  }
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await sheet.waitFor();
  return sheet;
}

/** Thorn's page, where Pat plays him alone, so the panel lands there. */
async function thornsPage(page: Page): Promise<Locator> {
  const panel = await openCharacters(page);
  const heading = panel.locator("[data-creature-heading]").filter({ hasText: "Thorn" });
  const opener = panel.locator(`[data-opener="character:${run.ids.thornChar}"]`);
  await heading.or(opener).first().waitFor();
  if ((await heading.count()) === 0) await opener.click();
  await heading.waitFor();
  return panel;
}

/** Combat's Uses section in a panel, where a character's class resources are listed, edited and added: the section whose own heading it is. */
function resourcesSection(scope: Locator): Locator {
  return scope.locator('xpath=.//section[*[self::h3 or self::h4][normalize-space()="Uses"]]');
}

function resourceRow(scope: Locator, name: string): Locator {
  return resourcesSection(scope).getByRole("listitem").filter({ has: scope.page().getByText(name, { exact: true }) });
}

function resourceSheet(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title, exact: true });
}

/** Closes a class resource sheet by its Cancel. */
async function cancelSheet(sheet: Locator): Promise<void> {
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await sheet.waitFor({ state: "detached" });
}

/**
 * Pat's combat screens, on his page opened again at this size: the Add
 * sheet before Thorn has any class resource, then with Rage and Lay on
 * Hands at level 7, the section with its level-up question, the Update
 * sheet, a pool's amount field open and with its error, the Add sheet's
 * other forms, the Edit sheet, his death save and turn cards on his turn,
 * and Thorn's Uses in his row and his bar.
 */
async function patCombatScreens(sweep: Sweep, page: Page): Promise<void> {
  let scope = await thornsPage(page);
  await resourcesSection(scope).getByRole("button", { name: "Add a class resource" }).click();
  const add = resourceSheet(page, "Add a class resource");
  await add.getByText("Choose a class to see its resources at its level.", { exact: true }).waitFor();
  await sweep.measure(page, "cr-add-no-class", add);
  await cancelSheet(add);

  await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { level: 7, resources: THORN_RESOURCES } });
  scope = await thornsPage(page);
  const section = resourcesSection(scope);
  await section.getByText(LEVEL_UP, { exact: true }).waitFor();
  await section.scrollIntoViewIfNeeded();
  await sweep.measure(page, "cr-section-page", section);

  await section.locator("div").filter({ hasText: /^Your level went up\. Update Barbarian resources\?Update$/ }).getByRole("button", { name: "Update" }).click();
  const update = resourceSheet(page, "Update Barbarian resources");
  await update.getByRole("combobox", { name: "Barbarian level" }).waitFor();
  await sweep.measure(page, "cr-update", update);
  await cancelSheet(update);

  const hands = resourceRow(scope, "Lay on Hands");
  await hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" }).click();
  const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
  await field.waitFor();
  await sweep.measure(page, "cr-amount", hands);
  await field.fill("99");
  await hands.getByRole("button", { name: "Spend", exact: true }).click();
  await hands.getByText("Spend 1 to 25.", { exact: true }).waitFor();
  await sweep.measure(page, "cr-amount-error", hands);
  await hands.getByRole("button", { name: "Cancel", exact: true }).click();

  await section.getByRole("button", { name: "Add a class resource" }).click();
  await add.getByRole("combobox", { name: "Class" }).selectOption("barbarian");
  await add.getByRole("combobox", { name: "Barbarian level" }).selectOption("14");
  await add.getByText("Path of the Berserker. 1 use. Back on a Long Rest.", { exact: true }).waitFor();
  await sweep.measure(page, "cr-add-barbarian-14", add);
  await add.getByRole("combobox", { name: "Class" }).selectOption("ranger");
  await add.getByRole("combobox", { name: "Ranger level" }).selectOption("3");
  await add.getByText(/^No Ranger resources yet\./).waitFor();
  await sweep.measure(page, "cr-add-none-yet", add);
  await add.getByRole("combobox", { name: "Class" }).selectOption("bard");
  await add.getByRole("textbox", { name: "Charisma modifier" }).waitFor();
  await add.getByRole("button", { name: /^Add \d+ resources?$/ }).click();
  await add.getByText(/^Fill in the Charisma modifier/).waitFor();
  await sweep.measure(page, "cr-add-modifier-error", add);
  await add.getByRole("radio", { name: "Your own" }).check();
  await add.getByRole("checkbox", { name: "Spend an amount" }).check();
  await sweep.measure(page, "cr-add-own", add);
  await cancelSheet(add);

  await resourceRow(scope, "Rage").getByRole("button", { name: "Edit Rage" }).click();
  const edit = resourceSheet(page, "Edit Rage");
  await edit.getByRole("textbox", { name: "Name" }).waitFor();
  await sweep.measure(page, "cr-edit", edit);
  await cancelSheet(edit);
  await closeSheets(page);
  await escapeAll(page);

  // His turn's cards: the death save, and the turn's menu with a pool's amount field open. On a phone the turn card stands folded until Show.
  const save = await alertCard(page, "Death save for Thorn");
  if (save) await sweep.measure(page, "cu-death-save", save);
  else await sweep.missing(page, "cu-death-save", "Thorn's turn at 0 HP showed Pat no death save card");
  let turn = await alertCard(page, "Thorn's turn");
  if (turn && (await turn.getAttribute("data-turn-folded")) !== null) {
    await turn.getByRole("button", { name: "Show Thorn's turn" }).click();
    turn = await alertCard(page, "Thorn's turn");
  }
  if (turn) {
    await turn.getByRole("button", { name: /^Use Lay on Hands/ }).click();
    await turn.getByRole("textbox", { name: /^Lay on Hands to spend/ }).waitFor();
    await sweep.measure(page, "cu-turn-amount", turn);
    await turn.getByRole("button", { name: "Cancel", exact: true }).click();
    // Dismissed here alone, so Thorn's token is free for the bar's tap.
    await turn.getByRole("button", { name: "Dismiss Thorn's turn" }).click();
  } else await sweep.missing(page, "cu-turn-amount", "Thorn's turn showed Pat no turn card");
  const saveAgain = await alertCard(page, "Death save for Thorn");
  if (saveAgain) await saveAgain.getByRole("button", { name: "Dismiss", exact: true }).click();
  await escapeAll(page);

  const { group } = await rowUses(page, "Thorn");
  await sweep.measure(page, "cu-row-uses-thorn", group);
  await closeSheets(page);
  const thorn = await barUses(page, "Thorn", { x: 5, y: 5 });
  if (thorn) {
    await sweep.measure(page, "cu-bar-drawer-thorn", thorn.drawer);
    await closeBar(thorn.bar);
  } else await sweep.missing(page, "cu-bar-drawer-thorn", "a tap on Thorn opened no window");
}

/**
 * The DM's combat screens: the section in Thorn's token panel, the
 * dragon's Uses in its row, its bar and its token panel, In lair while it waits for the
 * server, then the dragon's turn with its recharge card and its turn card,
 * and the troll's with Regeneration and its death save card waiting.
 */
async function dmCombatScreens(sweep: Sweep, page: Page): Promise<void> {
  // Thorn's death save shows the DM too, and could cover a token.
  const save = await alertCard(page, "Death save for Thorn");
  if (save) await save.getByRole("button", { name: "Dismiss", exact: true }).click();
  await escapeAll(page);

  const thorn = await selectToken(page, "Thorn", { x: 5, y: 5 });
  if (thorn) {
    await (await barControl(thorn, "Details")).click();
    const panel = page.getByRole("tabpanel", { name: sideTabName("Token") }).or(page.getByRole("region", { name: "Token", exact: true }));
    await panel.getByRole("heading", { name: "Thorn" }).first().waitFor();
    // The creature's header: its name's first line at its picture's middle (CreatureHeader.tsx).
    await sweep.measure(page, "creature-header", panel.locator("[data-creature-header]").first());
    const combat = panel.getByRole("button", { name: "Combat", exact: true });
    if ((await combat.getAttribute("aria-expanded")) === "false") await combat.click();
    const section = resourcesSection(panel);
    await section.getByText(LEVEL_UP, { exact: true }).waitFor();
    await section.scrollIntoViewIfNeeded();
    await sweep.measure(page, "cr-section-panel", section);
    await closeSheets(page);
    await escapeAll(page);
  } else await sweep.missing(page, "cr-section-panel", "a tap on Thorn opened no window");

  const { tracker, group } = await rowUses(page, RED_DRAGON);
  await sweep.measure(page, "cu-row-uses", group);
  // In lair waits for the server while the page is offline, busy, and takes the lair's counts once it is back.
  const lair = tracker.getByRole("switch", { name: /^In lair/ });
  // It is busy too while the dragon's block loads, and drops a tap then: the busy state measured would be the load's, and nothing would reach the server.
  await untilReady(lair, "In lair");
  consoles.dm.expectSocketFailures = true;
  await dmContext.setOffline(true);
  await lair.click();
  await waitFor("In lair busy", async () => ((await lair.getAttribute("aria-busy")) === "true" ? true : null), 5_000);
  await sweep.measure(page, "cu-in-lair-busy", lair);
  await dmContext.setOffline(false);
  await waitFor("the dragon in its lair", () => (dmSocket.state?.encounter?.entries.find((e) => e.id === run.fight.dragon)?.inLair ? true : null), 20_000);
  await waitFor("In lair answered", async () => ((await lair.getAttribute("aria-busy")) === null ? true : null), 20_000);
  consoles.dm.expectSocketFailures = false;
  await closeSheets(page);

  const dragon = await barUses(page, RED_DRAGON, { x: DRAGON_AT.x + 1, y: DRAGON_AT.y + 1 });
  if (dragon) {
    await sweep.measure(page, "cu-bar-drawer", dragon.drawer);
    await closeBar(dragon.bar);
  } else await sweep.missing(page, "cu-bar-drawer", "a tap on the dragon opened no window");

  // The dragon's Uses in its Token panel, each count as pips at its title line's right end (docs/design-v1-monster-uses.md 3.1).
  const dragonBar = await selectToken(page, RED_DRAGON, { x: DRAGON_AT.x + 1, y: DRAGON_AT.y + 1 });
  if (dragonBar) {
    await (await barControl(dragonBar, "Details")).click();
    const panel = page.getByRole("tabpanel", { name: sideTabName("Token") }).or(page.getByRole("region", { name: "Token", exact: true }));
    await panel.getByRole("heading", { name: RED_DRAGON }).first().waitFor();
    const combat = panel.getByRole("button", { name: "Combat", exact: true });
    if ((await combat.getAttribute("aria-expanded")) === "false") await combat.click();
    const section = resourcesSection(panel);
    await section.locator("[data-use-pips]").first().waitFor();
    await section.scrollIntoViewIfNeeded();
    await sweep.measure(page, "cu-panel-uses", section);
    await closeSheets(page);
    await escapeAll(page);
  } else await sweep.missing(page, "cu-panel-uses", "a tap on the dragon opened no window");

  // The row's chips for what the dragon spent, on their own line under its LA and LR.
  const chips = (await openTracker(page)).locator("li[data-entry-row]").filter({ has: page.getByRole("button", { name: `${RED_DRAGON} options` }) }).locator("[data-spent-chips]");
  await chips.getByText("Fire Breath used", { exact: true }).waitFor();
  await chips.scrollIntoViewIfNeeded();
  await sweep.measure(page, "cu-row-chips", chips);
  await closeSheets(page);

  await turnTo(run.fight.dragon);
  const recharge = await alertCard(page, `Fire Breath can recharge (5–6). ${RED_DRAGON}`);
  if (recharge) {
    await sweep.measure(page, "cu-recharge", recharge);
    // Rolled, the card says how with Done (4.5).
    await recharge.getByRole("button", { name: "Roll", exact: true }).click();
    await recharge.getByRole("status").getByText(/^Rolled \d+: Fire Breath /).waitFor();
    await recharge.getByRole("button", { name: "Done", exact: true }).waitFor();
    await sweep.measure(page, "cu-recharge-rolled", recharge);
  } else await sweep.missing(page, "cu-recharge", "the dragon's turn showed no recharge card");
  await escapeAll(page);
  let turn = await alertCard(page, `${RED_DRAGON}'s turn`);
  if (turn && (await turn.getAttribute("data-turn-folded")) !== null) {
    await sweep.measure(page, "cu-turn-folded", turn);
    await turn.getByRole("button", { name: `Show ${RED_DRAGON}'s turn` }).click();
    turn = await alertCard(page, `${RED_DRAGON}'s turn`);
  }
  if (turn) {
    await sweep.measure(page, "cu-turn", turn);
    // Folded back where it was folded, so the bar below decides its form.
    const collapse = turn.getByRole("button", { name: `Collapse ${RED_DRAGON}'s turn` });
    if (await visible(collapse)) await collapse.click();
  } else await sweep.missing(page, "cu-turn", "the dragon's turn showed no turn card");
  await escapeAll(page);
  // Under the recharge card, then alone once Done puts that card away.
  await turnBesideBar(sweep, page);
  const done = await alertCard(page, `Fire Breath can recharge (5–6). ${RED_DRAGON}`);
  if (done) {
    await done.getByRole("button", { name: "Done", exact: true }).click();
    await done.waitFor({ state: "detached" });
  }
  await escapeAll(page);
  await turnBesideBar(sweep, page);

  await turnTo(run.fight.troll);
  const regeneration = await alertCard(page, "Regeneration for Troll");
  if (regeneration) {
    await regeneration.getByText("Troll is at 0 HP and regenerates 15 HP.", { exact: true }).waitFor();
    await sweep.measure(page, "cu-regeneration", regeneration);
  } else await sweep.missing(page, "cu-regeneration", "the troll's turn at 0 HP showed no Regeneration card");
  await escapeAll(page);
  const waits = await alertCard(page, "Death save for Troll");
  if (waits) {
    await waits.getByRole("status").getByText("Waiting for Regeneration", { exact: true }).waitFor();
    await sweep.measure(page, "cu-death-save-waits", waits);
  } else await sweep.missing(page, "cu-death-save-waits", "the troll's turn at 0 HP showed no death save card");
  await escapeAll(page);

  // Skipped, Regeneration leaves the troll's turn card a row with Reopen, and its death save rolls.
  const skip = await alertCard(page, "Regeneration for Troll");
  if (skip) await skip.getByRole("button", { name: "Skip", exact: true }).click();
  await waitFor("Regeneration skipped", () => (trollRecord()?.settled?.regeneration?.state === "skipped" ? true : null));
  await escapeAll(page);
  let trollTurn = await alertCard(page, "Troll's turn");
  if (trollTurn && (await trollTurn.getAttribute("data-turn-folded")) !== null) {
    await trollTurn.getByRole("button", { name: "Show Troll's turn" }).click();
    trollTurn = await alertCard(page, "Troll's turn");
  }
  if (trollTurn) {
    await trollTurn.getByRole("button", { name: "Reopen: Regeneration skipped" }).waitFor();
    await sweep.measure(page, "cu-turn-skipped", trollTurn);
  } else await sweep.missing(page, "cu-turn-skipped", "a skipped Regeneration left no turn card");
  await escapeAll(page);
  const rolled = await alertCard(page, "Death save for Troll");
  if (rolled) {
    await rolled.getByRole("button", { name: "Roll", exact: true }).click();
    await rolled.getByRole("status").getByText(/^Rolled \d+/).waitFor();
    await rolled.getByRole("button", { name: "Done", exact: true }).waitFor();
    await sweep.measure(page, "cu-death-save-rolled", rolled);
  } else await sweep.missing(page, "cu-death-save-rolled", "the troll's death save card went once Regeneration was skipped");
  await escapeAll(page);

  // Back on its feet below its maximum, after more Fire, its next turn's Regeneration says so, with the note and its help.
  await ops.send({ t: "actor.hp", target: { tokenId: run.ids.troll }, change: { kind: "heal", amount: 40 } });
  await ops.send({ t: "actor.hp", target: { tokenId: run.ids.troll }, change: { kind: "damage", amount: 5, types: ["fire"] } });
  await turnTo(run.fight.thorn);
  await turnTo(run.fight.troll);
  const alive = await alertCard(page, "Regeneration for Troll");
  if (alive) {
    await alive.getByText("Troll regenerates 15 HP.", { exact: true }).waitFor();
    await alive.getByText("Recorded Fire damage may stop Regeneration.", { exact: true }).waitFor();
    await sweep.measure(page, "cu-regeneration-alive", alive);
  } else await sweep.missing(page, "cu-regeneration-alive", "the troll's turn below its maximum showed no Regeneration card");
  await escapeAll(page);
}

/** The troll's turn record as the DM's copy holds it. */
function trollRecord() {
  const t = dmSocket.state?.tokens[run.ids.troll];
  return t && "inline" in t.actor ? t.actor.inline.turnRecord : undefined;
}

/** What shows of an element: its box cut by every ancestor that clips, as the column's scroll box cuts the cards past its room. */
async function shownBox(el: Locator): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return el.evaluate((node) => {
    type Box = { l: number; r: number; t: number; b: number };
    type El = { getBoundingClientRect(): { left: number; right: number; top: number; bottom: number }; parentElement: El | null };
    const style = (n: El) => (globalThis as unknown as { getComputedStyle(n: El): { overflowX: string; overflowY: string } }).getComputedStyle(n);
    const rect = (n: El): Box => {
      const r = n.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    };
    let b = rect(node as unknown as El);
    for (let n = (node as unknown as El).parentElement; n; n = n.parentElement) {
      const s = style(n);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = rect(n);
      b = { l: Math.max(b.l, c.l), r: Math.min(b.r, c.r), t: Math.max(b.t, c.t), b: Math.min(b.b, c.b) };
    }
    return b.r - b.l > 0.5 && b.b - b.t > 0.5 ? { x: b.l, y: b.t, width: b.r - b.l, height: b.b - b.t } : null;
  });
}

/**
 * The dragon's turn card with its token bar open (4.2): where the bar,
 * docked, compact or spanning, stands across the alerts column, the card
 * folds to its row where it would not stack above the bar, and leaves the
 * column where even its row would meet it. Either way nothing of it shows
 * under the bar. Under another card the bar stacks below that card, and
 * the column stops above the bar, cutting the turn card. Alone, the bar
 * keeps its place and the card gives way.
 */
async function turnBesideBar(sweep: Sweep, page: Page): Promise<void> {
  await closeSheets(page);
  const card = page.locator('[data-alert="turn"]').filter({ visible: true });
  // Where the column stands across, read before the bar opens, since the card may leave it.
  const lane = (await card.count()) > 0 ? await card.first().boundingBox() : null;
  if (!lane || !(await canvasAt(page, { x: DRAGON_AT.x + 1, y: DRAGON_AT.y + 1 }))) return;
  const bar = await selectToken(page, RED_DRAGON, { x: DRAGON_AT.x + 1, y: DRAGON_AT.y + 1 });
  if (!bar) return;
  // The card's form follows the bar's box once both are drawn.
  await page.waitForTimeout(400);
  const barBox = await bar.boundingBox();
  // Left out of the column, the card is not drawn at all. Cut by the column's room, it is drawn but may show nothing.
  const drawn = page.locator('[data-alert="turn"]');
  const kept = (await drawn.count()) > 0;
  const shows = kept ? await shownBox(drawn.first()) : null;
  const folded = kept && (await drawn.first().getAttribute("data-turn-folded")) !== null;
  const across = barBox !== null && barBox.x < lane.x + lane.width && barBox.x + barBox.width > lane.x;
  console.log(`${sweep.at}: the dragon's bar ${await bar.getAttribute("data-bar-mode")} at ${JSON.stringify(barBox)}, across ${across}, the turn card ${kept ? `${folded ? "folded" : "open"}, showing ${JSON.stringify(shows)}` : "left out"}`);
  if (across && barBox) {
    if (!kept) sweep.seen.add("cu-turn-hidden-bar");
    else {
      assert.ok(folded, `${sweep.at}: the turn card stands open across a docked bar`);
      if (shows) {
        const meets = shows.y < barBox.y + barBox.height && shows.y + shows.height > barBox.y;
        assert.ok(!meets, `${sweep.at}: what shows of the folded turn card, ${shows.y}-${shows.y + shows.height}, meets the bar at ${barBox.y}-${barBox.y + barBox.height}`);
        await sweep.measure(page, "cu-turn-fold-bar", drawn.first());
      } else sweep.seen.add("cu-turn-fold-bar");
    }
  }
  await closeBar(bar);
}

/** The combat screens at one size: Pat's on his page opened again, then the DM's, in their own fight, which ends with them. */
async function combatScreens(sweep: Sweep, page: Page, size: Size, scale: number): Promise<void> {
  try {
    await combatStart();
    pat.setDefaultTimeout(10_000);
    await openAt(pat, size, scale);
    await patCombatScreens(sweep, pat);
    await pat.goto("about:blank");
    await openAt(page, size, scale);
    await dmCombatScreens(sweep, page);
  } finally {
    await combatEnd();
  }
}

/** Request a roll as the needle trap's Ask to disarm opens it over its pane, closed again by Cancel. */
async function requestScreen(sweep: Sweep, page: Page, pane: Locator): Promise<void> {
  const ask = pane.getByRole("button", { name: "Ask to disarm", exact: true });
  if (!(await visible(ask))) return sweep.missing(page, "request-roll", "the needle trap's pane has no Ask to disarm");
  await ask.scrollIntoViewIfNeeded();
  await ask.click();
  const sheet = page.getByRole("dialog", { name: "Request a roll" });
  if (!(await showsWithin(sheet, 3_000))) return sweep.missing(page, "request-roll", "Ask to disarm opened no request");
  await sweep.measure(page, "request-roll", sheet);
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await sheet.waitFor({ state: "detached" });
}

/**
 * The group save page a trap card's Save and damage opens, from the
 * trap's card in the column or over the screen: the Dice sheet on a
 * phone, the Dice tab panel on a computer. Discard closes it again, and
 * the card's springing waits on for settleTraps. `trap` is the trap's
 * name, which starts the card's name and the page's first line.
 */
async function groupSaveScreen(sweep: Sweep, page: Page, screen: string, trap: string): Promise<void> {
  const name = new RegExp(`^${trap} went off`);
  // The card in the column, or over the screen where the column's summary row stands in for its cards.
  const findCard = async (): Promise<Locator | null> => {
    const inColumn = page.getByRole("group", { name }).filter({ visible: true }).first();
    if (await showsWithin(inColumn, 2_000)) return inColumn;
    const summary = page.getByRole("button", { name: /Tap to answer\.$|to see them\.$|to see it\.$/ });
    if (!(await visible(summary))) return null;
    await summary.first().click();
    const overlay = page.getByRole("dialog", { name: "Alerts" });
    if (!(await showsWithin(overlay, 2_500))) return null;
    const over = overlay.getByRole("group", { name }).first();
    return (await visible(over)) ? over : null;
  };
  let card = await findCard();
  const fold = card?.locator("button[aria-expanded=false]");
  if (card && fold && (await visible(fold))) {
    // Opened, a card on a short phone can leave the column too short for it, and the cards then move over the screen, so it is found again once it holds still or has gone. The element itself is watched: a locator would wait on for another card once it hides.
    const opened = await card.elementHandle();
    await fold.first().click();
    let last = "";
    let still = 0;
    await waitFor("the opened card to hold still or go", async () => {
      const box = JSON.stringify(await opened?.boundingBox().catch(() => null));
      still = box === last ? still + 1 : 0;
      last = box;
      return still >= 2 ? true : null;
    }, 3_000);
    await opened?.dispose();
    card = await findCard();
  }
  if (!card) return sweep.missing(page, screen, `no card showed for ${trap}'s springing`);
  await card.getByRole("button", { name: "Save and damage", exact: true }).click();
  const host = page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]').or(page.getByRole("tabpanel", { name: /Dice/ }));
  if (!(await showsWithin(host.getByText(new RegExp(`^From ${trap}`)).first(), 4_000))) return sweep.missing(page, screen, "Save and damage opened no group save page");
  if (screen === "group-save-row") {
    // FL-3: measure the expanded typed override, which the closed row never exposed to the sweep.
    await host.getByRole("radiogroup", { name: "What they roll" }).getByRole("radio", { name: "No save" }).check({ force: true });
    await host.getByLabel("Damage", { exact: true }).fill("11 cold + 3 fire");
    await host.getByRole("button", { name: /'s damage, .*Change it/ }).first().click();
    await host.getByLabel(/'s damage$/).first().fill("11 cold + 3 fire");
  }
  if (screen === "group-save-row") await host.locator("[data-damage-summary]").first().waitFor();
  await sweep.measure(page, screen, host);
  if (screen === "group-save-row") {
    // FL-4: a valid long formula must fit before rolling, including at 320 px and 130%.
    const formula = Array.from({ length: 20 }, () => "1d6").join("+");
    await host.getByLabel("Damage", { exact: true }).fill(`${formula} cold + 7 fire`);
    const slip = host.getByRole("group", { name: "Outcome", exact: true }).locator("[data-damage-summary]");
    await slip.filter({ hasText: formula }).waitFor();
    await sweep.measure(page, "fl4-long-formula", slip);
  }
  await host.getByRole("button", { name: "Discard", exact: true }).first().click();
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
  if (await visible(sheet)) {
    await sheet.getByRole("button", { name: "Close Dice", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
  }
}

/** Short screens fold a new request into Roll asked until the player opens it. */
async function playerRequestCard(page: Page): Promise<Locator | null> {
  const card = page.getByRole("dialog", { name: "The DM asks for a roll" }).filter({ visible: true }).first();
  const summary = page.getByRole("button", { name: /^Roll asked:/ }).filter({ visible: true }).first();
  if (!(await showsWithin(card.or(summary).first(), 4_000))) return null;
  if (!(await visible(card))) await summary.click();
  return (await showsWithin(card, 3_000)) ? card : null;
}

/** Pat's ask card, as the DM asks for Thorn's save: Thorn has no stat block, so the card's roll row holds the bonus field and the extra dice. */
async function askScreen(sweep: Sweep, page: Page): Promise<void> {
  const id = randomUUID();
  await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 14, dcShown: true, resultShown: true, targets: [{ characterId: run.ids.thornChar }] } });
  const card = await playerRequestCard(page);
  if (card) await sweep.measure(page, "pat-ask", card);
  else await sweep.missing(page, "pat-ask", "the DM's ask showed no card");
  await ops.send({ t: "roll.close", rollIds: [id] });
  await page.locator('[aria-label="The DM asks for a roll"]').first().waitFor({ state: "detached" });
}

/** Pat's screens at one size: his ask card on a phone, the Ruler, a drag's stop note, and the toast of his own walk. */
async function patScreens(sweep: Sweep, page: Page, size: Size): Promise<void> {
  if (PHONE_ROOTS.has(size.name)) await askScreen(sweep, page);
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

  // Pat's strip after his own move, Undo move in Roll's place where it fits (docs/design-v1-bar-compact.md 3.3), on the upright phones the design measured. The row is the strip's content, measured wherever the strip draws one.
  if (PHONE_ROOTS.has(size.name)) {
    // A cell south, which no other token takes: dropped on the warhorse's cell, Thorn's release could land on the warhorse wherever the map's hit areas are drawn late, as on a slow runner, so nothing was selected, and the tap after it opened the warhorse.
    const start = await pagePoint(page, BOUNDS, { x: 5.5, y: 5.5 });
    const end = await pagePoint(page, BOUNDS, { x: 5.5, y: 6.5 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(start.x + ((end.x - start.x) * i) / 8, start.y + ((end.y - start.y) * i) / 8);
    await page.mouse.up();
    await waitFor("Thorn a cell south", () => (dmSocket.state?.tokens[run.ids.thorn]?.y === 6 ? true : null), 5_000);
    const moved = page.getByRole("dialog", { name: "Thorn actions" });
    const strip = (await showsWithin(moved, 1_500)) ? moved : await selectToken(page, "Thorn", { x: 5, y: 6 });
    if (strip) {
      const row = strip.locator("[data-rest-row]");
      await sweep.measure(page, "rest-row-pat", row, { optional: (await row.count()) === 0 });
    } else await sweep.missing(page, "rest-row-pat", "a tap on the moved Thorn opened no window");
    await escapeAll(page);
    await resetThorn();
  }

  // Pat's other toasts (live play 18): the DM's whisper, an undo the DM's move overtook, and the DM's roll with its die.
  await toastScreen(sweep, page, "pat-toast-whisper", /hear chanting/, () => ops.send({ t: "log.whisper", to: [run.patId], text: "You hear chanting." }));
  await toastScreen(sweep, page, "pat-toast-refusal", /^Could not undo/, () => refusedUndo(page, patOps, ops));
  await toastScreen(sweep, page, "pat-toast-roll", /Perception/, () => rollFor(ops, run.ids.goblin));
  await resetThorn();

  // Pat's pause screen while the DM blacks out the players' view (live play 18).
  await ops.send({ t: "view.blackout", blackout: true });
  const paused = page.getByText("The DM has paused the game.");
  if (await showsWithin(paused, 3_000)) await sweep.measure(page, "pat-blackout", page.locator("body"));
  else await sweep.missing(page, "pat-blackout", "the blackout showed no pause screen");
  await ops.send({ t: "view.blackout", blackout: false });
  await paused.waitFor({ state: "detached" });
}

/**
 * Drawn cases for the helper itself: each shape the polish pass found
 * (docs/design-v1-polish.md 1), and the shape its fix gives (section 2),
 * so the helper is shown to catch the one and pass the other without the
 * app. Each case is a root of its own, named by `data-case`. The doctype
 * lays them out in standards mode, as the app is: in quirks mode a line
 * that holds only a lowered span does not grow, so its words never move.
 */
// ------------------------------------------------------------ the second icon pass (docs/design-v1-icons-2.md 15)

/**
 * The second icon pass's sizes (docs/design-v1-icons-2.md 1): the 130%
 * phones, an upright phone at 115% and 85%, and a computer at 100%, 115%
 * and 85%. Touch ones first, so the DM's touch context closes before the
 * mouse one opens.
 */
const IC2_PHONE: Size = { name: "390x844", width: 390, height: 844, touch: true };
const IC2_DESK: Size = { name: "1280x800", width: 1280, height: 800, touch: false };
const IC2_AT: { size: Size; scale: number }[] = [
  { size: { name: "320x568", width: 320, height: 568, touch: true }, scale: 1.3 },
  { size: IC2_PHONE, scale: 1.3 },
  { size: IC2_PHONE, scale: 1.15 },
  { size: IC2_PHONE, scale: 0.85 },
  { size: IC2_DESK, scale: 1 },
  { size: IC2_DESK, scale: 1.15 },
  { size: IC2_DESK, scale: 0.85 },
];
/** Wren's cell, clear of the other tokens, the traps and the walls. */
const WREN_AT = { x: 2, y: 2 };

/**
 * The pass's fight, on the sweep's room: Thorn at level 7 with a stat
 * block, so his folded Stat block reads "Level 7, PB +3" beside Take a
 * shape, and a counted Hex. Wren a druid with known forms, Exhaustion 2
 * and Poisoned, whose Stat block holds "4 shapes". The goblin hidden from players,
 * locked and its name hidden. Thorn, the goblin and Wren in a fight on
 * Thorn's turn with the turn timer on, so the round header draws its clock.
 */
async function ic2Start(): Promise<void> {
  await settleTraps();
  if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
  await resetThorn();
  const stats = (wis: number) => ({ abilities: { str: 16, dex: 12, con: 14, int: 10, wis, cha: 10 }, saves: ["str", "con"], skills: { athletics: "prof" }, spellAbility: "wis", rolls: [] });
  await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { level: 7, stats: stats(12) } });
  await ops.send({ t: "actor.effect.add", target: { characterId: run.ids.thornChar }, effect: { id: randomUUID(), key: "hexed", level: 3 } });
  await ops.send({ t: "character.create", character: { id: run.ids.wrenChar, name: "Wren", size: "medium", ownerIds: [run.patId], actor: actor({ hp: { cur: 22, max: 22, temp: 0 } }) } });
  await ops.send({ t: "character.update", characterId: run.ids.wrenChar, patch: { level: 4, knownForms: ["wolf", "brown-bear", "giant-spider", "riding-horse"], stats: stats(16) } });
  await ops.send({ t: "token.create", token: { id: run.ids.wren, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Wren", ...WREN_AT, disposition: "ally", actor: { ref: run.ids.wrenChar } } });
  await ops.send({ t: "actor.effect.add", target: { characterId: run.ids.wrenChar }, effect: { id: randomUUID(), key: "exhaustion", level: 2 } });
  // A chip with no number, which draws its art (docs/design-v1-icons-2.md 4).
  await ops.send({ t: "actor.effect.add", target: { characterId: run.ids.wrenChar }, effect: { id: randomUUID(), key: "poisoned" } });
  await ops.send({ t: "token.update", tokenId: run.ids.goblin, patch: { visibility: "dm", locked: true, nameHidden: true } });
  // The goblin's turn comes at every size for the alert lines, and must leave it hidden.
  await ops.send({ t: "room.update", settings: { turnTimerSec: 0, revealHiddenOnTurn: false } });
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: run.fight.thorn, tokenId: run.ids.thorn, value: 20 },
      { id: run.fight.goblin, tokenId: run.ids.goblin, value: 14 },
      { id: run.fight.wren, tokenId: run.ids.wren, value: 12 },
    ],
  });
  await waitFor("the icon pass's fight", () => dmSocket.state?.encounter?.entries.some((e) => e.id === run.fight.wren) || null);
  await turnTo(run.fight.thorn);
  await ops.send({ t: "room.update", settings: { turnTimerSec: 300 } });
}

/** A token's panel, from Details on its bar: the side panel's Token tab, or a phone's sheet. */
async function ic2TokenPanel(page: Page, name: string, heading: string, cell: { x: number; y: number }): Promise<Locator | null> {
  await closeSheets(page);
  await escapeAll(page);
  const bar = await selectToken(page, name, cell);
  if (!bar) return null;
  await (await barControl(bar, "Details")).click();
  const panel = page.getByRole("tabpanel", { name: sideTabName("Token") }).or(page.getByRole("region", { name: "Token", exact: true }));
  await panel.getByRole("heading", { name: heading }).first().waitFor();
  return panel.first();
}

/** Folds every open group of a panel, so each header shows its summary. */
async function foldGroups(panel: Locator): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const open = panel.locator("button[data-group-fold][aria-expanded=true]");
    if ((await open.count()) === 0) return;
    await open.first().click();
  }
}

/**
 * Every folded group's header inside its row (review IC2BUILD-ASTRA-01):
 * the chevron, the icon, the name and the summary end within the heading,
 * and the heading within the row, which never scrolls sideways. Lines
 * name each header that runs out, and `folded` counts those read.
 */
async function groupOverflowLines(root: Locator, at: string, screen: string): Promise<{ lines: string[]; folded: number }> {
  const found = await root.evaluate((el) => {
    type El = { textContent: string | null; scrollWidth: number; clientWidth: number; parentElement: El | null; children: ArrayLike<El>; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; getBoundingClientRect(): { right: number; width: number } };
    const out: string[] = [];
    let folded = 0;
    for (const group of Array.from((el as unknown as El).querySelectorAll("[data-panel-group]"))) {
      const fold = group.querySelector(':scope > div > h3 > [data-group-fold][aria-expanded="false"]');
      const heading = fold?.parentElement ?? null;
      const row = heading?.parentElement ?? null;
      if (!fold || !heading || !row || heading.getBoundingClientRect().width === 0) continue;
      folded++;
      const label = (fold.querySelector("span[id]")?.textContent ?? "").trim();
      const edge = heading.getBoundingClientRect().right;
      for (const part of Array.from(fold.children)) {
        const r = part.getBoundingClientRect();
        if (r.width > 0 && r.right > edge + 0.5) out.push(`${label}: a part of its header ends ${(r.right - edge).toFixed(1)} px past its heading`);
      }
      if (edge > row.getBoundingClientRect().right + 0.5) out.push(`${label}: its heading ends past its row`);
      if (row.scrollWidth > row.clientWidth + 1) out.push(`${label}: its row scrolls sideways, ${row.scrollWidth} in ${row.clientWidth}`);
    }
    return { out, folded };
  });
  return { lines: [...found.out.map((line) => `${at} ${screen}: ${line}`), ...await proficiencyLines(root, `${at} ${screen}`, false)], folded: found.folded };
}

/**
 * Each group header's name on one line, a folded summary on its name's
 * line and cut only at its 4em floor or wider, since words fewer than the
 * floor show whole in less, and, where `actionInline`, every header's
 * action on its name's line (docs/design-v1-icons-2.md 3.3 and 5,
 * docs/design-v1-design-pass.md 4.1): lines naming each header that breaks
 * a rule.
 */
async function groupHeaderLines(panel: Locator, at: string, screen: string, actionInline: boolean): Promise<string[]> {
  const found = await panel.evaluate((root) => {
    type El = {
      id: string;
      textContent: string | null;
      parentElement: El | null;
      nextElementSibling: El | null;
      getAttribute(n: string): string | null;
      querySelector(s: string): El | null;
      querySelectorAll(s: string): ArrayLike<El>;
      getBoundingClientRect(): { top: number; bottom: number; width: number };
      scrollWidth: number;
      clientWidth: number;
    };
    const g = globalThis as unknown as { document: { getElementById(id: string): El | null; createRange(): { selectNodeContents(n: El): void; getClientRects(): ArrayLike<{ top: number }> } }; getComputedStyle(e: El): { fontSize: string } };
    const lines = (el: El) => {
      const range = g.document.createRange();
      range.selectNodeContents(el);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
    };
    const zoom = (el: El) => (el as unknown as { currentCSSZoom?: number }).currentCSSZoom ?? 1;
    const out: string[] = [];
    for (const group of Array.from((root as unknown as El).querySelectorAll("[data-panel-group]"))) {
      const fold = group.querySelector("[data-group-fold]");
      const nameId = fold?.getAttribute("aria-labelledby");
      const name = nameId ? g.document.getElementById(nameId) : null;
      if (!name || name.getBoundingClientRect().width === 0) continue;
      const label = name.textContent ?? "";
      if (lines(name) !== 1) out.push(`${label}: its name takes ${lines(name)} lines`);
      const summaryId = fold?.getAttribute("aria-describedby");
      const summary = summaryId ? g.document.getElementById(summaryId) : null;
      // Every group keeps the floor, one without an icon too (D-261028-84). Words fewer than the floor ("Pat") show whole in less, so the floor is what a cut summary keeps.
      if (summary) {
        const floor = 4 * parseFloat(g.getComputedStyle(summary).fontSize) * zoom(summary);
        const width = summary.getBoundingClientRect().width;
        // A line of whole parts (components/WholeParts.tsx) is cut where it hides some, with nothing left over its edge.
        const cut = summary.scrollWidth > summary.clientWidth || summary.getAttribute("data-summary-cut") !== null;
        if (cut && width < floor - 0.5) out.push(`${label}: its summary is cut at ${width.toFixed(1)} px, under its ${floor.toFixed(1)} px floor`);
      }
      // A summary wraps under its name only where the name and its floor cannot share the row (docs/design-v1-design-pass.md 4.1): never a token panel's.
      if (summary && summary.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 0.5) out.push(`${label}: its summary wrapped under its name`);
      const heading = fold?.parentElement;
      const action = heading?.nextElementSibling ?? null;
      if (action && heading) {
        const nameBox = name.getBoundingClientRect();
        const actionBox = action.getBoundingClientRect();
        const inline = actionBox.top < nameBox.bottom && actionBox.bottom > nameBox.top;
        out.push(`${inline ? "inline" : "wrapped"}:${label}`);
      }
    }
    return out;
  });
  const lines: string[] = [];
  for (const f of found) {
    if (f.startsWith("inline:")) continue;
    if (f.startsWith("wrapped:")) {
      if (actionInline) lines.push(`${at} ${screen}: ${f.slice("wrapped:".length)}'s action wrapped under its name`);
      continue;
    }
    lines.push(`${at} ${screen}: ${f}`);
  }
  return lines;
}

/**
 * Measures a part drawn with and without its lead, the icon before its
 * words: its height and its words' lines must match, so the icon grew
 * nothing (docs/design-v1-icons-2.md 15). The lead goes and comes back in
 * one task, so the page never paints without it.
 */
async function sameWithoutLead(part: Locator, lead: string, words: string): Promise<{ with: { h: number; lines: number }; without: { h: number; lines: number } } | null> {
  return part.evaluate(
    (el, sel) => {
      type El = { remove(): void; getBoundingClientRect(): { height: number }; querySelector(s: string): El | null; parentElement: El | null; nextSibling: El | null; insertBefore(a: El, b: El | null): void };
      const root = el as unknown as El;
      const g = globalThis as unknown as { document: { createRange(): { selectNodeContents(n: El): void; getClientRects(): ArrayLike<{ top: number }> } } };
      const read = () => {
        const text = root.querySelector(sel.words);
        const range = g.document.createRange();
        if (text) range.selectNodeContents(text);
        return { h: Math.round(root.getBoundingClientRect().height * 10) / 10, lines: text ? new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size : 0 };
      };
      const icon = root.querySelector(sel.lead);
      if (!icon || !icon.parentElement) return null;
      const before = read();
      const parent = icon.parentElement;
      const next = icon.nextSibling;
      icon.remove();
      const after = read();
      parent.insertBefore(icon, next);
      return { with: before, without: after };
    },
    { lead, words },
  );
}

/** The sizes a chip's box keeps (docs/design-v1-icons-2.md 4): 20 x 18 at 100%, at most as wide where it holds letters. */
async function chipLines(chips: Locator, at: string, screen: string): Promise<string[]> {
  const boxes = await chips.evaluateAll((els) =>
    els.map((el) => {
      const e = el as unknown as { textContent: string | null; getBoundingClientRect(): { width: number; height: number }; currentCSSZoom?: number };
      const z = e.currentCSSZoom ?? 1;
      const r = e.getBoundingClientRect();
      return { words: (e.textContent ?? "").trim(), w: r.width / z, h: r.height / z };
    }),
  );
  const out: string[] = [];
  for (const b of boxes) {
    if (Math.abs(b.h - 18) > 0.5) out.push(`${at} ${screen}: the chip "${b.words || "art"}" is ${b.h.toFixed(1)} px tall, not 18`);
    // Art, and exhaustion's letters, keep the 20 px box. A counted effect's letters and number are as wide as they were.
    if (!/\d$/.test(b.words) || /^E\d$/.test(b.words)) {
      if (Math.abs(b.w - 20) > 0.5) out.push(`${at} ${screen}: the chip "${b.words || "art"}" is ${b.w.toFixed(1)} px wide, not 20`);
    }
  }
  return out;
}

/** The side panel's tab row at a computer's size: one line, each tab 44 px, no name cut (docs/design-v1-icons-2.md 15). */
async function tabRowLines(page: Page, at: string): Promise<string[]> {
  const row = await page.getByRole("tablist", { name: "Panels" }).evaluate((list) => {
    type El = { scrollWidth: number; clientWidth: number; getAttribute(n: string): string | null; querySelectorAll(s: string): ArrayLike<El>; getBoundingClientRect(): { top: number; height: number }; textContent: string | null; currentCSSZoom?: number };
    const tabs = Array.from((list as unknown as El).querySelectorAll('[role="tab"]'));
    const z = tabs[0]?.currentCSSZoom ?? 1;
    const cut = Array.from((list as unknown as El).querySelectorAll('[role="tab"] span')).filter((s) => s.getAttribute("aria-hidden") !== "true" && s.scrollWidth > s.clientWidth + 0.5 && s.clientWidth > 1);
    return {
      tops: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
      heights: tabs.map((t) => Math.round((t.getBoundingClientRect().height / z) * 10) / 10),
      icons: tabs.filter((t) => t.getAttribute("aria-haspopup") === null).length,
      cut: cut.map((s) => s.textContent ?? ""),
    };
  });
  const out: string[] = [];
  if (row.tops !== 1) out.push(`${at} tabs: the row takes ${row.tops} lines`);
  for (const h of row.heights) if (Math.abs(h - 44) > 0.5) out.push(`${at} tabs: a tab is ${h} px tall, not 44`);
  if (row.icons < 4) out.push(`${at} tabs: the row holds ${row.icons} tabs, not 4`);
  for (const words of row.cut) out.push(`${at} tabs: "${words}" is cut`);
  return out;
}

/** The pass's screens at one size, the DM's (docs/design-v1-icons-2.md 15). */
async function ic2Screens(sweep: Sweep, page: Page, size: Size, scale: number): Promise<void> {
  const wide = size.width / scale >= 900;
  const at = sweep.at;
  if (wide) {
    await openSideTab(page, "Initiative");
    await sweep.add(page, "ic2-tabs", await tabRowLines(page, at));
    await sweep.measure(page, "ic2-tabs", page.getByRole("tablist", { name: "Panels" }));
  } else {
    await closeSheets(page);
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    const list = page.getByRole("region", { name: "Panels" }).getByRole("list", { name: "Panels" });
    await list.waitFor();
    // Each row of places, its icon leading (3.1), apart from the list's own labels.
    await sweep.measure(page, "ic2-panel-list", list.locator("li:has(button)"));
    await escapeAll(page);
    await closeSheets(page);
  }

  // Thorn's and Wren's panels with every group folded: one line a name, a summary cut only at its floor or wider, and on a computer the Stat block's action on its name's line.
  for (const [name, cell] of [
    ["Thorn", { x: 5, y: 5 }],
    ["Wren", WREN_AT],
  ] as const) {
    const panel = await ic2TokenPanel(page, name, name, cell);
    if (!panel) {
      await sweep.missing(page, `ic2-groups-${name}`, `a tap on ${name} opened no window`);
      continue;
    }
    await foldGroups(panel);
    await sweep.add(page, `ic2-groups-${name}`, await groupHeaderLines(panel, at, `ic2-groups-${name}`, !size.touch));
    await sweep.add(page, `ic2-groups-${name}`, (await groupOverflowLines(panel, at, `ic2-groups-${name}`)).lines);
    await sweep.measure(page, `ic2-groups-${name}`, panel.locator("[data-panel-group] > div:first-child"));
    await closeSheets(page);
    await escapeAll(page);
  }

  // The goblin's header: Hidden and Locked with their icons, "Name hidden" in words, each tag whole.
  const goblin = await ic2TokenPanel(page, "Goblin", "Goblin", { x: 9, y: 3 });
  if (goblin) {
    // The tags' row stands under the kind line (features/tokens/CreatureHeader.tsx).
    const tags = goblin.locator("[data-kind-line] + div").first();
    for (const words of ["Hidden", "Locked", "Name hidden"]) {
      // Hidden's words go on, out of sight, for a screen reader (D-261024-46).
      const tag = tags.getByText(new RegExp(`^${words}( from players)?$`)).first();
      if (!(await visible(tag))) await sweep.missing(page, "ic2-goblin-tags", `no "${words}" tag`);
      else if (await tag.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (el as unknown as { clientWidth: number }).clientWidth + 0.5)) sweep.lines.push(`${at} ic2-goblin-tags: "${words}" is cut`);
    }
    await sweep.measure(page, "ic2-goblin-tags", tags);
    await closeSheets(page);
    await escapeAll(page);
  } else await sweep.missing(page, "ic2-goblin-tags", "a tap on the goblin opened no window");

  // The groups that draw no icon, folded as they start: the trap editor's and the Dice panel's (review IC2BUILD-ASTRA-01).
  await ic2PlainGroups(sweep, page);

  // The tracker: the round header's clock with its timer as tall as without, and the chips' boxes.
  // The header's own box stands its padding unevenly on purpose, its fill meeting the pane's top as it sticks, so its row and the clock are measured inside it.
  const tracker = await openTracker(page);
  const header = page.locator("[data-round-header]").first();
  const clock = header.getByRole("timer");
  if (await visible(clock)) {
    const both = await sameWithoutLead(header, '[role="timer"] svg', '[role="timer"]');
    if (!both) sweep.lines.push(`${at} ic2-round: the clock has no timer`);
    else if (Math.abs(both.with.h - both.without.h) > 0.5) sweep.lines.push(`${at} ic2-round: the round header is ${both.with.h} px with the timer, ${both.without.h} without`);
    await sweep.measure(page, "ic2-round", header.locator(":scope > div").first());
    await sweep.measure(page, "ic2-clock", clock);
  } else await sweep.missing(page, "ic2-round", "the round header shows no clock");
  const rows = tracker.locator("li[data-entry-row]");
  await rows.first().waitFor();
  // The chips, not the row's AC shield or health bar.
  const chips = rows.locator('span[role="img"][title]:not([title="Armor Class"])');
  await sweep.add(page, "ic2-tracker-chips", await chipLines(chips.filter({ visible: true }), at, "ic2-tracker-chips"));
  // Each row's chips, which the pass changed, in the box that holds them.
  for (const who of ["Thorn", "Wren"]) await sweep.measure(page, `ic2-chips-${who}`, rows.filter({ has: page.getByRole("button", { name: `${who} options` }) }).locator('span[role="img"][title]:not([title="Armor Class"])').first().locator(".."));
  await closeSheets(page);
  // The party bar, where it docks atop the side panel: Wren's E2 in the 20 px box.
  if (wide) {
    const party = page.getByRole("region", { name: "Party" }).or(page.locator('section[aria-label="Party"]')).first();
    if (await visible(party)) {
      await sweep.add(page, "ic2-party-chips", await chipLines(party.locator("span[title][aria-hidden]"), at, "ic2-party-chips"));
      await sweep.measure(page, "ic2-party", party);
    } else await sweep.missing(page, "ic2-party", "no party bar");
  }

  // The alert lines' leads: time up on the goblin's turn, and an effect that ended as it did.
  await ops.send({ t: "actor.effect.add", target: { tokenId: run.ids.goblin }, effect: { id: randomUUID(), key: "frightened", duration: { mode: "turnEnd", of: { entryId: run.fight.goblin } } } });
  await ops.send({ t: "room.update", settings: { turnTimerSec: 2 } });
  await turnTo(run.fight.goblin);
  await page.locator('[data-alert="timeUp"]').first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
  const timeUp = await alertCard(page, "Time is up for Goblin's turn.");
  if (timeUp) await ic2Line(sweep, page, timeUp, "ic2-time-up");
  else await sweep.missing(page, "ic2-time-up", "the goblin's turn ran out and showed no line");
  await escapeAll(page);
  await turnTo(run.fight.wren);
  const ended = await alertCard(page, "Frightened ended on Goblin.");
  if (ended) await ic2Line(sweep, page, ended, "ic2-ended");
  else await sweep.missing(page, "ic2-ended", "Frightened ending showed no line");
  await escapeAll(page);
  await ops.send({ t: "room.update", settings: { turnTimerSec: 300 } });
  await turnTo(run.fight.thorn);
}

/**
 * The panels whose groups draw no icon, every group folded: the trap
 * editor on the pit, and the Dice panel with Thorn selected. Each folded
 * header stays inside its row, as it did before the icon pass gave a
 * summary its floor (review IC2BUILD-ASTRA-01).
 */
async function ic2PlainGroups(sweep: Sweep, page: Page): Promise<void> {
  const at = sweep.at;
  await closeSheets(page);
  await escapeAll(page);
  const pane = page.getByRole("dialog", { name: "Edit trap" });
  // The Trap tool opens a trap's pane from a tap on it.
  await pickTool(page, "Trap");
  const p = await pagePoint(page, BOUNDS, { x: 10.5, y: 6.5 });
  await page.mouse.click(p.x, p.y);
  if (await showsWithin(pane, 3_000)) {
    await foldGroups(pane);
    const read = await groupOverflowLines(pane, at, "ic2-plain-trap");
    if (read.folded < 5) await sweep.missing(page, "ic2-plain-trap", `read ${read.folded} folded groups, not the pane's own`);
    await sweep.add(page, "ic2-plain-trap", read.lines);
    await pane.getByRole("button", { name: "Done", exact: true }).click();
    await pane.waitFor({ state: "detached" });
  } else await sweep.missing(page, "ic2-plain-trap", "a tap on the pit opened no pane");
  await escapeAll(page);
  await pickTool(page, "Select");
  const bar = await selectToken(page, "Thorn", { x: 5, y: 5 });
  if (!bar) {
    await sweep.missing(page, "ic2-plain-dice", "a tap on Thorn opened no window");
    return;
  }
  const dice = await openDice(page);
  await dice.locator("[data-panel-group]").first().waitFor();
  await foldGroups(dice);
  const read = await groupOverflowLines(dice, at, "ic2-plain-dice");
  if (read.folded < 2) await sweep.missing(page, "ic2-plain-dice", `read ${read.folded} folded groups`);
  await sweep.add(page, "ic2-plain-dice", read.lines);
  await closeDiceSheet(page);
  await closeSheets(page);
  await escapeAll(page);
}

/**
 * An alert line, measured, and no taller and on no more lines with its
 * lead and its close than as it was drawn before the pass: no lead, and
 * Dismiss in words, as wide as a small button with those words. The x
 * leaves the words more room than Dismiss did, and the lead takes some of
 * it back (docs/design-v1-icons-2.md 4).
 */
async function ic2Line(sweep: Sweep, page: Page, line: Locator, screen: string): Promise<void> {
  const both = await line.evaluate((el) => {
    type El = { remove(): void; getBoundingClientRect(): { height: number }; querySelector(s: string): El | null; parentElement: El | null; nextSibling: El | null; insertBefore(a: El, b: El | null): void; style: Record<string, string> };
    const root = el as unknown as El;
    const g = globalThis as unknown as { document: { createRange(): { selectNodeContents(n: El): void; getClientRects(): ArrayLike<{ top: number }> }; createElement(t: string): { getContext(k: string): { font: string; measureText(t: string): { width: number } } } }; getComputedStyle(e: El): { font: string; paddingLeft: string; borderLeftWidth: string } };
    const read = () => {
      const text = root.querySelector("p");
      const range = g.document.createRange();
      if (text) range.selectNodeContents(text);
      return { h: Math.round(root.getBoundingClientRect().height * 10) / 10, lines: text ? new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size : 0 };
    };
    const lead = root.querySelector(":scope > span:first-child");
    const close = root.querySelector(":scope > button");
    if (!lead || !close) return null;
    const now = read();
    // Today's Dismiss: its words in the button's own font, with its side padding and border either side, in the chrome's own px as its style is.
    const cs = g.getComputedStyle(close);
    const context = g.document.createElement("canvas").getContext("2d");
    context.font = cs.font;
    const dismiss = context.measureText("Dismiss").width + 2 * (parseFloat(cs.paddingLeft) || 12) + 2 * (parseFloat(cs.borderLeftWidth) || 0);
    const next = lead.nextSibling;
    const was = close.style.width ?? "";
    lead.remove();
    close.style.width = `${dismiss}px`;
    const before = read();
    close.style.width = was;
    root.insertBefore(lead, next);
    return { now, before };
  });
  if (!both) sweep.lines.push(`${sweep.at} ${screen}: the line has no lead or no close`);
  else if (both.now.h > both.before.h + 0.5 || both.now.lines > both.before.lines) {
    sweep.lines.push(`${sweep.at} ${screen}: ${both.now.h} px on ${both.now.lines} lines with its lead and its x, ${both.before.h} px on ${both.before.lines} as before the pass`);
  }
  await sweep.measure(page, screen, line);
}

const CASES = `
<!doctype html>
<style>
  body { margin: 0; font: 14px/1.4 sans-serif; color: #eee; background: #222; }
  * { box-sizing: border-box; }
  [data-case] { width: 330px; margin: 0 0 16px; }
  button { font: inherit; height: 44px; min-width: 44px; padding: 0 12px; border: 1px solid #888; background: #333; color: inherit; border-radius: 10px; }
  input, select { font: inherit; height: 44px; box-sizing: border-box; border: 1px solid #888; background: #111; color: inherit; }
  .chip { border-radius: 999px; }
  /* Fixed widths, so a wider fallback font cannot move a part to another line. */
  .card { background: #333; padding: 8px 10px; margin-bottom: 4px; }
  .nudge { background: #333; height: 44px; padding: 0 10px; display: flex; align-items: center; }
  .fixed { flex: none; width: 60px; overflow: hidden; white-space: nowrap; padding: 0; }
  .box { background: #333; }
</style>
<!-- First, so the board stays inside the window for the pill cases. -->
<div id="board" style="width: 300px; height: 160px; background: #111"></div>
<div data-case="min-width-wrap" style="display: flex; flex-wrap: wrap; gap: 8px; width: 90px">
  <button style="flex: none; width: 28px; min-width: 0; padding: 0">A</button>
  <button style="flex: none; width: 44px; min-width: 44px; padding: 0">B</button>
  <button style="flex: none; width: 60px; min-width: 60px; padding: 0">C</button>
</div>
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
<div data-case="foot-uneven" style="height: 220px; overflow-y: auto; padding: 4px 12px 16px; --pane-pad-bottom: 16px">
  <div style="display: grid; gap: 12px">
    <div class="card">First row</div>
    <div class="card">Second row</div>
    <div class="card">Third row</div>
    <div class="card">Fourth row</div>
    <div class="card">Fifth row</div>
    <button>Discard</button>
    <div style="position: sticky; bottom: calc(-1 * var(--pane-pad-bottom)); margin-bottom: calc(-1 * var(--pane-pad-bottom)); padding-top: 4px; padding-bottom: calc(8px + var(--pane-pad-bottom)); background: #444; display: grid"><button>Apply</button></div>
  </div>
</div>
<div data-case="foot-even" style="height: 220px; overflow-y: auto; padding: 4px 12px 16px; --pane-pad-bottom: 16px">
  <div style="display: grid; gap: 12px">
    <div class="card">First row</div>
    <div class="card">Second row</div>
    <div class="card">Third row</div>
    <div class="card">Fourth row</div>
    <div class="card">Fifth row</div>
    <button>Discard</button>
    <div style="position: sticky; bottom: calc(-1 * var(--pane-pad-bottom)); margin-bottom: calc(-1 * var(--pane-pad-bottom)); padding-top: 8px; padding-bottom: calc(8px + var(--pane-pad-bottom)); background: #444; display: grid"><button>Apply</button></div>
  </div>
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
<div data-case="labels-inner"><label style="display: flex; gap: 8px"><input type="checkbox" style="margin: 0">One</label><label style="display: flex; gap: 8px"><input type="checkbox" style="margin: 0">Two</label><label style="display: flex; gap: 8px"><input type="checkbox" style="margin: 0 0 0 6px">Three</label></div>
<div data-case="li-inner"><ul style="list-style: none; padding: 0; margin: 0"><li><span>One</span></li><li><span>Two</span></li><li><span style="margin-left: 6px">Three</span></li></ul></div>
<div data-case="mixed-rows"><div>Plain one</div><label style="display: flex"><span style="margin-left: 6px">Label two</span></label><div>Plain three</div></div>
<div data-case="chosen-option" role="radiogroup" aria-label="Hits" style="display: grid; gap: 2px"><label style="padding: 0 12px">The creature that set it off</label><label style="padding: 0 12px; background: #445">Everyone in an area</label><label style="padding: 0 12px">No one</label></div>
<div data-case="chosen-option-drift" role="radiogroup" aria-label="Hits" style="display: grid; gap: 2px"><label style="padding: 0 12px">The creature that set it off</label><label style="padding: 0 12px; margin-left: 3px; background: #445">Everyone in an area</label><label style="padding: 0 12px">No one</label></div>
<div data-case="chosen-in-12" role="radiogroup" aria-label="Hits" style="display: grid; gap: 2px"><label style="padding: 0 12px">The creature that set it off</label><label style="padding: 0 12px; margin-left: 12px; background: #445">Everyone in an area</label><label style="padding: 0 12px">No one</label></div>
<div data-case="chosen-in-13" role="radiogroup" aria-label="Hits" style="display: grid; gap: 2px"><label style="padding: 0 12px">The creature that set it off</label><label style="padding: 0 12px; margin-left: 13px; background: #445">Everyone in an area</label><label style="padding: 0 12px">No one</label></div>
<div data-case="chosen-checked" role="radiogroup" aria-label="Hits" style="display: grid; gap: 2px"><label style="position: relative; padding: 0 12px"><input type="radio" name="hits-c" style="position: absolute; inset: 0; opacity: 0; margin: 0">The creature that set it off</label><label style="position: relative; padding: 0 12px; background: #445"><input type="radio" name="hits-c" checked style="position: absolute; inset: 0; opacity: 0; margin: 0">Everyone in an area</label><label style="position: relative; padding: 0 12px"><input type="radio" name="hits-c" style="position: absolute; inset: 0; opacity: 0; margin: 0">No one</label></div>
<div data-case="cards-even"><div class="card">Card one</div><div class="card">Card two</div><div class="card">Card three</div></div>
<div data-case="cards-words-drift"><div class="card">Card one</div><div class="card">Card two</div><div class="card" style="padding: 8px 13px">Card three</div></div>
<div data-case="cards-box-drift"><div class="card">Card one</div><div class="card">Card two</div><div class="card" style="padding: 8px 7px; margin-left: 3px">Card three</div></div>
<div data-case="notice-lone"><div>Plain one</div><div>Plain two</div><div role="status" style="background: #333; padding: 4px 12px">A notice set in</div><div>Plain four</div></div>
<div data-case="notice-lone-drift"><div>Plain one</div><div>Plain two</div><div role="status" style="background: #333; padding: 4px 12px; margin-left: 3px">A notice set in</div><div>Plain four</div></div>
<div data-case="notice-inner-6"><div>Plain one</div><div>Plain two</div><div role="status" style="background: #333; padding: 4px 12px"><span style="margin-left: 6px">A notice set in</span></div><div>Plain four</div></div>
<div data-case="notice-pad-18"><div>Plain one</div><div>Plain two</div><div role="status" style="background: #333; padding: 4px 18px">A notice set in</div><div>Plain four</div></div>
<div data-case="ul-pad"><div style="padding-left: 12px">Row one</div><div style="padding-left: 12px">Row two</div><ul style="padding-left: 14px; margin: 0; list-style: none"><li>Item</li></ul></div>
<div data-case="group-pad"><div style="padding-left: 12px">Row one</div><div style="padding-left: 12px">Row two</div><div role="group" aria-label="Grouped" style="padding-left: 16px"><span>Grouped</span></div></div>
<div data-case="group-step"><div>Row one</div><div>Row two</div><div role="group" aria-label="Grouped" style="padding-left: 12px"><span>Grouped</span></div><div>Row four</div></div>
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
<div data-case="nudge-none"><div class="nudge"><div style="flex: 1"><span>Nudged words</span></div></div></div>
<div data-case="nudge-down"><div class="nudge"><div style="flex: 1"><span style="position: relative; top: 1.5px">Nudged words</span></div></div></div>
<div data-case="nudge-up"><div class="nudge"><div style="flex: 1"><span style="position: relative; top: -1.5px">Nudged words</span></div></div></div>
<div data-case="nudge-1-4"><div class="nudge"><div style="flex: 1"><span style="position: relative; top: 1.4px">Nudged words</span></div></div></div>
<div data-case="nudge-transform"><div class="nudge"><div style="flex: 1"><span style="transform: translateY(3px)">Nudged words</span></div></div></div>
<div data-case="valign-down-3"><div class="nudge"><div style="flex: 1"><span style="vertical-align: -3px">Nudged words</span></div></div></div>
<div data-case="valign-up-1-4"><div class="nudge"><div style="flex: 1"><span style="vertical-align: 1.4px">Nudged words</span></div></div></div>
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
<div data-case="tick-wrapped" style="width: 250px">
  <label style="display: flex; align-items: flex-start; gap: 12px; padding: 4px 0">
    <span style="display: flex; align-items: center; height: 19.6px; flex: none"><input type="checkbox" style="width: 22px; height: 22px; margin: 0"></span>
    <span style="display: grid; gap: 2px"><span style="line-height: 1.4">A Dexterity save at the end of each of its turns ends it</span><span style="font-size: 13px; line-height: 1.4">Rolled for each creature it holds.</span></span>
  </label>
</div>
<div data-case="tick-wrapped-middle" style="width: 250px">
  <label style="display: flex; align-items: flex-start; gap: 12px; padding: 4px 0">
    <span style="display: flex; align-items: center; height: 39.2px; flex: none"><input type="checkbox" style="width: 22px; height: 22px; margin: 0"></span>
    <span style="display: grid; gap: 2px"><span style="line-height: 1.4">A Dexterity save at the end of each of its turns ends it</span><span style="font-size: 13px; line-height: 1.4">Rolled for each creature it holds.</span></span>
  </label>
</div>
<div data-case="zoom-narrow" style="zoom: 1.3"><div role="button" style="display: flex; align-items: center; justify-content: center; width: 10.5px; height: 60px; border-top: 40px solid #888"><span style="width: 4px; height: 6px; background: #eee"></span></div></div>
<div data-case="zoom-narrow-off" style="zoom: 1.3"><div role="button" style="display: flex; align-items: flex-start; justify-content: center; width: 10.5px; height: 60px; border-top: 40px solid #888"><span style="width: 4px; height: 6px; margin-top: 5px; background: #eee"></span></div></div>
<div data-case="hidden-row"><div data-bar-row="play" style="display: none"><button>Attach</button></div></div>
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
<div data-case="label-stacked" style="width: 250px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 44px">
    <label style="flex: 1 1 min(110px, 40%); min-width: 0">It lasts</label>
    <div style="flex: 1 1 160px; min-width: 0; display: flex; justify-content: flex-end"><div style="min-width: 100%; max-width: 160px; display: flex; gap: 8px; align-items: center; justify-content: flex-end"><select style="flex: 1; min-width: 0; width: 100%"><option>Until the start of the next turn</option></select></div></div>
  </div>
</div>
<div data-case="label-room" style="width: 250px">
  <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 44px">
    <label style="flex: 1 1 120px; min-width: 0">Rounds</label>
    <input style="flex: none; width: 140px">
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
<div data-case="summary-under" style="width: 214px">
  <button style="display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; align-content: center; column-gap: 8px; width: 214px; height: auto; min-height: 48px; padding: 14.4px 0; border: none; border-radius: 0; background: none; text-align: left">
    <span style="display: flex; align-items: center; height: 19.2px"><svg width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="#aaa"/></svg></span>
    <span style="display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; min-width: 0"><span style="flex: none; width: 150px; overflow: hidden; white-space: nowrap; font-size: 16px; font-weight: 700; line-height: 1.2">Save</span><span style="flex: none; width: 40px; margin-left: auto; overflow: hidden; white-space: nowrap; text-align: right; font-size: 13px; line-height: 1.4">None</span></span>
  </button>
</div>
<div data-case="summary-under-high" style="width: 214px">
  <button style="display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; align-content: center; column-gap: 8px; width: 214px; height: auto; min-height: 48px; padding: 10px 0 18.8px; border: none; border-radius: 0; background: none; text-align: left">
    <span style="display: flex; align-items: center; height: 19.2px"><svg width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="#aaa"/></svg></span>
    <span style="display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; min-width: 0"><span style="flex: none; width: 150px; overflow: hidden; white-space: nowrap; font-size: 16px; font-weight: 700; line-height: 1.2">Save</span><span style="flex: none; width: 40px; margin-left: auto; overflow: hidden; white-space: nowrap; text-align: right; font-size: 13px; line-height: 1.4">None</span></span>
  </button>
</div>
<div data-case="icon-over-words">
  <button style="display: flex; align-items: flex-start; column-gap: 8px; height: 44px; padding: 0 12px; border: none; box-sizing: border-box"><svg width="16" height="16" viewBox="0 0 16 16" style="flex: none; margin-top: 4px"><rect width="16" height="16" fill="#aaa"/></svg><span style="margin-top: 22px; font-size: 13px; line-height: 18px; white-space: nowrap">Attach</span></button>
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
<div data-case="windows-two-line" style="width: 220px">
  <div role="dialog" aria-label="Lizard actions" aria-labelledby="w4" style="border: 1px solid #888; padding: 4px 12px">
    <div style="display: flex; align-items: center; min-height: 48px"><strong id="w4" style="flex: 1; line-height: 1.2">Gigantic Armored Riding Lizard</strong><button aria-label="Close">x</button></div>
  </div>
  <div role="dialog" aria-label="Lizard actions, title set high" aria-labelledby="w5" style="border: 1px solid #888; padding: 4px 12px; margin-top: 8px">
    <div style="display: flex; align-items: center; min-height: 48px"><strong id="w5" style="flex: 1; align-self: flex-start; line-height: 1.2">Gigantic Armored Riding Lizard</strong><button aria-label="Close">x</button></div>
  </div>
</div>
<div data-case="toasts" style="position: relative; width: 390px; height: 300px">
  <div style="position: absolute; left: 82px; right: 8px; top: 0; display: flex; flex-direction: column; gap: 8px"><div data-alert="rolls" style="display: contents"><section style="height: 60px; background: #333">Trip Wire went off</section></div></div>
  <div style="position: absolute; top: 72px; left: 12px; right: 12px"><div data-toast="" style="background: #444; height: 44px">Trip Wire went off: Thorn.</div></div>
</div>
`;

/**
 * One file of the sweep: the server, the DM's and Pat's contexts, and
 * the steps `steps` registers, in order, roomTest first or after
 * helperTest. The room goes when the file ends.
 */
export function alignmentFile(title: string, steps: () => void): void {
  describe(`raccoon-vtt alignment sweep: ${title}`, { timeout: 900_000 }, () => {
    before(async () => {
      srd = await loadMonsters();
      server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
      browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
      dmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      dm = await dmContext.newPage();
      await holdPreviews(dm);
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

    steps();
  });
}

/** pl3-0: the helper on drawn cases, which needs no room. */
export function helperTest(): void {
  test("fl5-d. radio card groups keep their outer edge, while moved groups, card boxes and contents still fail", async () => {
    const page = await dmContext.newPage();
    try {
      for (const scale of [1, 1.3]) {
        // RadioCards paints every card's border. ViewMenu paints only the chosen label, with the native radio hidden over it.
        for (const quiet of [false, true]) {
          await page.setContent(`<style>
            * { box-sizing: border-box }
            #cards { width: 260px; font: 14px/20px sans-serif; zoom: ${scale} }
            [role="radiogroup"] { display: grid; gap: 4px }
            label { position: relative; display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 4px 8px; border: 1px solid ${quiet ? "transparent" : "#777"} }
            label.chosen { background: #333; border-color: #777 }
            input { width: 20px; height: 20px; margin: 0; flex: none; ${quiet ? "position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0" : ""} }
          </style><div id="cards">
            <div>Players see</div><div>Choose a view</div>
            <div role="radiogroup" aria-label="Players see">
              <label class="chosen"><input type="radio" name="view" checked><span>Explore</span></label>
              <label><input type="radio" name="view"><span>Guide</span></label>
              <label><input type="radio" name="view"><span>Show all</span></label>
            </div>
          </div>`);
          const root = page.locator("#cards");
          const group = root.getByRole("radiogroup");
          const card = group.locator("label").first();
          const lines = async () => alignmentLines(await measureAlignment(root), `fl5-d ${scale} ${quiet ? "quiet" : "bordered"}`);
          assert.deepEqual(await lines(), [], "card padding must not move the group's outer edge");
          for (const target of [group, card]) {
            for (const shift of [-3, 3]) {
              await target.evaluate((el, x) => { (el as unknown as { style: { transform: string } }).style.transform = `translateX(${x}px)`; }, shift);
              assert.ok((await lines()).some((line) => line.includes(": edge ")), `a card or group moved ${shift}px must fail`);
            }
            await target.evaluate((el) => { (el as unknown as { style: { transform: string } }).style.transform = ""; });
          }
          for (const padding of [5, 11]) {
            await card.evaluate((el, px) => { (el as unknown as { style: { paddingLeft: string } }).style.paddingLeft = `${px}px`; }, padding);
            assert.ok((await lines()).some((line) => line.includes(": edge ")), `card content moved to ${padding}px padding must fail`);
          }
        }
      }
    } finally {
      await page.close();
    }
  });

  test("fl5-c. grouped and ungrouped menu rows share an edge, and shifted groups or rows still fail", async () => {
    const page = await dmContext.newPage();
    try {
      for (const scale of [1, 1.3]) {
        await page.setContent(`<style>
          * { box-sizing: border-box }
          [role="menu"], [role="group"] { display: grid; grid-template-columns: minmax(0, 1fr) }
          [role="menu"] { width: 200px; font: 14px/20px sans-serif; zoom: ${scale} }
          [role^="menuitem"] { display: flex; align-items: center; min-height: 44px; padding: 0 12px; border: 1px solid transparent }
          [aria-checked="true"] { background: #333; border-color: #777 }
          .heading { padding: 8px 13px 4px }
        </style><div role="menu">
          <div role="menuitemcheckbox"><span>Two panels</span></div>
          <div role="group" aria-label="Prepare">
            <div class="heading">Prepare</div>
            <div role="menuitemradio"><span>Monsters</span></div>
            <div role="menuitemradio" aria-checked="true"><span>Encounters</span></div>
          </div>
          <div role="menuitem"><span>Menu</span></div>
        </div>`);
        const menu = page.getByRole("menu");
        const group = menu.getByRole("group");
        const lines = async () => alignmentLines(await measureAlignment(menu), `fl5-c ${scale}`);
        assert.deepEqual(await lines(), [], "a transparent group must preserve its rows' content edges");
        for (const shift of [-3, 3]) {
          await group.evaluate((el, x) => { (el as unknown as { style: { transform: string } }).style.transform = `translateX(${x}px)`; }, shift);
          assert.ok((await lines()).some((line) => line.includes(": edge ")), `a group moved ${shift}px must fail`);
        }
        await group.evaluate((el) => { (el as unknown as { style: { transform: string } }).style.transform = ""; });
        for (const padding of [9, 15]) {
          await group.getByRole("menuitemradio").first().evaluate((el, px) => { (el as unknown as { style: { paddingLeft: string } }).style.paddingLeft = `${px}px`; }, padding);
          assert.ok((await lines()).some((line) => line.includes(": edge ")), `a grouped row with ${padding}px padding must fail`);
        }
      }
    } finally {
      await page.close();
    }
  });

  test("fl5-a. the menu word check catches a word squeezed below the menu's width, but accepts word boundaries and an oversized word", async () => {
    const page = await dmContext.newPage();
    try {
      await page.setContent('<div role="menu" style="width: 200px; font: 20px monospace"><div role="menuitem" style="width: 65px; overflow-wrap: anywhere">Monsters</div></div>');
      const menu = page.getByRole("menu");
      assert.ok((await menuWordLines(menu, "fl5-broken")).some((line) => line.includes('"Monsters"')));
      await page.getByRole("menuitem").evaluate((el) => {
        const item = el as unknown as { textContent: string; style: { overflowWrap: string; width: string } };
        item.textContent = "Two panels";
        item.style.overflowWrap = "break-word";
        item.style.width = "95px";
      });
      assert.deepEqual(await menuWordLines(menu, "fl5-whole"), []);
      await page.getByRole("menuitem").evaluate((el) => { (el as unknown as { textContent: string }).textContent = "Encounters"; });
      assert.ok((await menuWordLines(menu, "fl5-squeezed")).some((line) => line.includes('"Encounters"')));
      await page.getByRole("menuitem").evaluate((el) => { (el as unknown as { textContent: string }).textContent = "W".repeat(80); });
      assert.deepEqual(await menuWordLines(menu, "fl5-oversized"), []);
      assert.ok((await menuWordLines(page.locator(".missing"), "fl5-missing")).length > 0);
    } finally {
      await page.close();
    }
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
      // FU39-C, FU33-O6: B and C cannot share 90 px once their minimum widths count.
      for (const zoom of [1, 1.3]) {
        await page.locator('[data-case="min-width-wrap"]').evaluate((el, z) => {
          (el as unknown as { style: { zoom: string } }).style.zoom = String(z);
        }, zoom);
        assert.deepEqual((await lines("min-width-wrap")).filter((line) => line.startsWith("min-width-wrap: wrap-orphan ")), [], `minimum widths at ${zoom * 100}%`);
      }
      await caught("tick-dropped", "row");
      await passes("tick-on-first-line");
      // A label wrapped onto two lines over its help is met at its first line, so a box there passes and a box centered on both lines is caught.
      await passes("tick-wrapped");
      await caught("tick-wrapped-middle", "row");
      await caught("label-alone", "wrap-label");
      await passes("label-beside");
      // A FieldRow's label stacked over a field that fills the line is a heading over it. A label above a field that leaves its words room beside it is alone.
      await passes("label-stacked");
      await caught("label-room", "wrap-label");
      await caught("remove-alone", "wrap-orphan");
      await passes("remove-held");
      await caught("hint-high", "center");
      await passes("hint-centered");
      // A group header whose short summary wrapped under its name at the row's end, beside the name across but on a line of its own: one block of two lines, centered as one (DPFIX-MEASURE). Set high, it is caught.
      await passes("summary-under");
      await caught("summary-under-high", "center");
      // An icon beside its words but wholly above their line, the two centered only as one block: no wrap put them on lines of their own, so each is caught (DP34-OPUS-4).
      await caught("icon-over-words", "center");
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
      // A pane's sticky foot, stuck over the rows that scroll under it, is judged without the pane's inset it takes back, and stands in no row with those rows (review LP17-HP-1).
      await caught("foot-uneven", "pad");
      await passes("foot-even");
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
      // A label, list item or group that draws nothing starts where what it holds starts, so drift inside it is an edge.
      await caught("labels-inner", "edge");
      await caught("li-inner", "edge");
      await caught("mixed-rows", "edge");
      // An option meets its kin by its words, so a chosen option's fill places nothing: moved by 3, 12 or 13 px, its words have drifted, even where its fill lands on its kin's words.
      await passes("chosen-option");
      await passes("chosen-checked");
      await caught("chosen-option-drift", "edge");
      await caught("chosen-in-12", "edge");
      await caught("chosen-in-13", "edge");
      // Painted rows stacked together share their fills' edge and their words' edge.
      await passes("cards-even");
      await caught("cards-words-drift", "edge");
      await caught("cards-box-drift", "edge");
      // A lone notice may start at its fill, its words set in. Its fill moved, it has drifted. On the edge by its fill, its words start at its padding: set in 6 px further by a margin, they have drifted, where a wider padding is the notice's own.
      await passes("notice-lone");
      await caught("notice-lone-drift", "edge");
      await caught("notice-inner-6", "edge");
      await passes("notice-pad-18");
      // A nested list or group set in by less than an indent step has drifted. Set in by a step, it is a column of its own.
      await caught("ul-pad", "edge");
      await caught("group-pad", "edge");
      await passes("group-step");
      // Words moved on purpose, on an outer span or by a vertical alignment, are never snapped back to their line. A font's rounding is.
      await caught("shift-outer", "center");
      await caught("shift-two", "center");
      await caught("shift-valign", "center");
      await passes("font-rounding");
      // Moved by a known length, words keep the whole move and lose only the font's rounding: 1.5 px down or up reads 1.5. An inline box does not take a transform.
      await passes("nudge-none");
      await caught("nudge-down", "center");
      await caught("nudge-up", "center");
      await caught("nudge-1-4", "center");
      await passes("nudge-transform");
      // A vertical alignment by a length moves the words' box in its line and grows the line, which its block centers: lowered 3 px, the words move 1.5 px, and raised 1.4 px, 0.7 px. Only the font's rounding is put right.
      await caught("valign-down-3", "center");
      await passes("valign-up-1-4");
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
      // A long name's title on two lines is read by its lines together, so centered on Close it passes, and set at its row's top it is caught.
      const wrapped = headerLines(await headerPlaces(page.locator('[data-case="windows-two-line"] [role="dialog"]')), "windows-two-line");
      assert.equal(wrapped.length, 1, `only the two-line title set at its row's top stands apart: ${JSON.stringify(wrapped)}`);
      assert.match(wrapped[0]!, /"Lizard actions, title set high" has its Close 7 px and its title's middle/);
      // A target that is not there is a line, never a pass.
      const drawn = new Sweep("drawn", false);
      await drawn.measure(page, "renamed", page.locator('[data-bar-row="plays"]'));
      assert.match(drawn.lines.join("\n"), /^drawn renamed: never showed/, "a renamed attribute fails the sweep");
      await drawn.measure(page, "hidden", page.locator('[data-case="hidden-row"] [data-bar-row="play"]'));
      await drawn.measure(page, "hidden-optional", page.locator('[data-case="hidden-row"] [data-bar-row="play"]'), { optional: true });
      assert.ok(drawn.lines.includes("drawn hidden: never showed (what matched it is hidden)"), `a hidden play row fails the sweep: ${JSON.stringify(drawn.lines)}`);
      assert.ok(!drawn.lines.some((l) => l.startsWith("drawn hidden-optional")), "a hidden optional root is a screen that did not show");
      assert.ok(!drawn.seen.has("hidden") && !drawn.seen.has("hidden-optional"), "a hidden root is never counted as seen");
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
      await page.locator('[data-case="toasts"] [data-toast]').evaluate((el) => {
        (el.parentElement as unknown as { style: { left: string; right: string } }).style.left = "82px";
        (el.parentElement as unknown as { style: { left: string; right: string } }).style.right = "8px";
      });
      assert.deepEqual(await toastLaneLines(page, "toasts"), [], "a toast that takes the card's edges passes");
    } finally {
      await page.close();
    }
  });

  /*
   * sp-0: the spacing helper (e2e/helpers/spacing.ts) on drawn cases, each
   * a page of its own that scrolls, so a root inside it is held against
   * the whole page. Each rule's shape as the audit found it fails, the
   * shape its fix leaves passes, and each exemption passes
   * (docs/design-v1-spacing-pass.md 6).
   */
  test("sp-0. the spacing helper on drawn cases: names over cards, a field's label, section labels and their rows, settings sections and headings fail as the audit found them and pass as fixed, the exemptions pass, and a root with no scroller is measured alone, at 100% and 130%", async () => {
    const page = await dmContext.newPage();
    const switchRow = (name: string) =>
      `<div role="switch" aria-checked="false" class="row"><span class="words"><span class="name">${name}</span><span class="help">A line about ${name}.</span></span><span class="track"></span></div>`;
    const cards = (style = "") => `<div class="cards" data-card-group style="${style}"><label class="card"><input type="radio" name="c">Phone size</label><label class="card"><input type="radio" name="c">Full size</label></div>`;
    const label = (words: string, tag = "h3") => `<${tag} class="label" data-section-label>${words}</${tag}>`;
    const foldRow = (words: string, summary = "") =>
      `<div class="foldrow" data-section-label><h3><button aria-expanded="true">${words}</button></h3>${summary ? `<span class="summary">${summary}</span>` : ""}</div>`;
    try {
      for (const scale of [1, 1.3]) {
        await page.setContent(`<style>
          * { box-sizing: border-box }
          body { margin: 0; font: 14px/1.4 sans-serif; color: #eee; background: #111 }
          .page, .flat { width: 300px; zoom: ${scale}; margin-bottom: 24px }
          .page { max-height: 3000px; overflow-y: auto }
          section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 16px 0; border-top: 1px solid #444 }
          section.tight { gap: 4px }
          .label { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; line-height: 1.2 }
          .row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 0 }
          .words { flex: 1; min-width: 0; display: grid; gap: 2px }
          .name { font-size: 16px; font-weight: 600; line-height: 1.2 }
          .help { margin: 0; font-size: 13px; line-height: 1.4 }
          .track { width: 44px; height: 24px; border: 1px solid #888; border-radius: 12px }
          fieldset { margin: 0; padding: 0; border: none; min-width: 0 }
          fieldset.grid { display: grid; gap: 4px }
          legend { padding: 0; font-size: 16px; font-weight: 600; line-height: 1.2 }
          .column { display: grid; min-width: 0 }
          .cards { display: grid; gap: 4px; min-width: 0 }
          .card { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 4px 8px; border: 1px solid #777; border-radius: 6px }
          .foldrow { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px }
          .foldrow h3 { flex: 1 1 auto; min-width: 0; margin: 0; display: flex }
          .foldrow button { flex: 1; display: flex; align-items: center; min-height: 44px; padding: 0; background: none; border: none; color: inherit; font: 700 13px/1.2 sans-serif; letter-spacing: 0.06em; text-transform: uppercase; text-align: left }
          .summary { font-size: 13px; line-height: 1.4 }
          .notelabel { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px }
          .three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px }
          .three button { min-height: 44px }
          h4.plain { margin: 0; font-size: 14px; font-weight: 600 }
          h3.plain-h3 { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.2 }
          p { margin: 0 }
        </style>
        <div class="page" id="cards-bare"><fieldset class="grid"><legend>Map images</legend>${cards()}</fieldset></div>
        <div class="page" id="cards-bare-help"><fieldset class="grid"><legend>Turn timer</legend><div class="cards"><p class="help">How long a turn lasts.</p>${cards()}</div></fieldset></div>
        <div class="page" id="cards-fixed"><fieldset><legend>Map images</legend><div class="column">${cards("margin-top: 8px")}</div></fieldset></div>
        <div class="page" id="cards-fixed-help"><fieldset><legend>Turn timer</legend><div class="column"><p class="help" style="margin-top: 4px">How long a turn lasts.</p>${cards("margin-top: 8px")}</div></fieldset></div>
        <div class="page" id="cards-radiogroup"><div class="column"><span class="name" id="rg-near">Players see</span><div role="radiogroup" aria-labelledby="rg-near" class="cards" data-card-group style="margin-top: 4px"><label class="card"><input type="radio" name="r">Explore</label></div></div></div>
        <div class="page" id="cards-radiogroup-fixed"><div class="column"><span class="name" id="rg-far">Players see</span><div role="radiogroup" aria-labelledby="rg-far" class="cards" data-card-group style="margin-top: 8px"><label class="card"><input type="radio" name="r2">Explore</label></div></div></div>

        <div class="page" id="field-far"><form style="display: grid; gap: 12px"><label for="code-far">Code from the DM's screen</label><input id="code-far"><button type="button">Connect</button></form></div>
        <div class="page" id="field-near"><form style="display: grid; gap: 4px"><label for="code-near">Code from the DM's screen</label><input id="code-near"></form></div>

        <div class="page" id="label-help"><section>${label("Interface size")}<p class="help">The bars, panels and the names on tokens.</p></section></div>
        <div class="page" id="label-switch"><section>${label("Battery")}${switchRow("Low power")}</section></div>
        <div class="page" id="label-tight"><section class="tight">${label("Farther away")}<p class="help">Rows farther off.</p></section></div>
        <div class="page" id="grid-label-far"><div class="column" role="group"><h4 class="label" data-section-label style="padding-bottom: 8px">Saves for 3</h4><div class="three"><button>Str</button><button>Dex</button><button>Con</button></div></div></div>
        <div class="page" id="grid-label-near"><div class="column" role="group"><h4 class="label" data-section-label style="padding-bottom: 4px">Saves for 3</h4><div class="three"><button>Str</button><button>Dex</button><button>Con</button></div></div></div>
        <div class="page" id="note-label-far"><div class="column"><div class="notelabel" data-section-label style="padding-bottom: 8px"><h4 class="label">Saves</h4><span class="summary">Each creature rolls its own, with its own bonus and advantage</span></div><div class="three"><button>Str</button><button>Dex</button><button>Con</button></div></div></div>
        <div class="page" id="note-label-near"><div class="column"><div class="notelabel" data-section-label style="padding-bottom: 4px"><h4 class="label">Saves</h4><span class="summary">Each creature rolls its own, with its own bonus and advantage</span></div><div class="three"><button>Str</button><button>Dex</button><button>Con</button></div></div></div>
        <div class="page" id="fold-label-far"><section>${foldRow("Fog and party vision", "Fog on, party vision on, three light sources")}<div class="column">${switchRow("Fog")}</div></section></div>
        <div class="page" id="fold-label-near"><section class="tight">${foldRow("Fog and party vision", "Fog on, party vision on, three light sources")}<div class="column">${switchRow("Fog")}</div></section></div>

        <div class="page" id="settings-bare"><section>${label("Battery")}${switchRow("Low power")}</section><section id="bare">${label("Map detail")}<fieldset><legend>Map images</legend><div class="column">${cards("margin-top: 8px")}</div></fieldset></section><section>${label("Sounds")}${switchRow("Turn sound")}</section></div>
        <div class="page" id="settings-padded"><section>${label("Battery")}${switchRow("Low power")}</section><section id="padded">${label("Map detail")}<div style="padding: 8px 0"><fieldset><legend>Map images</legend><div class="column">${cards("margin-top: 8px")}</div></fieldset></div></section><section>${label("Sounds")}${switchRow("Turn sound")}</section></div>
        <div class="page" id="settings-mixed"><section>${foldRow("Fog and party vision")}<div class="column">${switchRow("Fog")}${switchRow("Party vision")}</div></section><section>${label("Players", "h4")}${switchRow("Players move")}</section><section>${label("Battery", "h4")}${switchRow("Low power")}</section></div>
        <div class="page" id="settings-padding"><section>${label("Battery", "h4")}${switchRow("Low power")}</section><div class="column" style="padding-top: 16px; border-top: 1px solid #444"><h4 class="label" data-section-label style="padding-bottom: 8px">Saves</h4>${switchRow("Roll for all")}</div><section>${label("Sounds", "h4")}${switchRow("Turn sound")}</section></div>
        <div class="page" id="settings-folds"><section>${foldRow("Fog")}<div class="column">${switchRow("Fog")}</div></section><section>${foldRow("Map detail")}<fieldset><legend>Map images</legend><div class="column">${cards("margin-top: 8px")}</div></fieldset></section><section>${foldRow("Sounds")}${switchRow("Turn sound")}</section></div>

        <div class="page" id="heads-off"><div class="column" style="gap: 4px"><h4 class="plain">Changes</h4><p>What changed in the rules.</p></div><div class="column" style="gap: 8px"><h4 class="plain">Credits</h4><p>Who made the art.</p></div></div>
        <div class="page" id="heads-ruled"><div class="column" style="gap: 4px"><h3 class="plain-h3">Adult Red Dragon</h3><p>Monster, CR 17.</p></div><div class="column" style="gap: 8px"><h3 class="plain-h3" style="padding-bottom: 2px; border-bottom: 1px solid #444">Adult Red Dragon</h3><p>Huge Dragon (Chromatic), Chaotic Evil</p></div></div>
        <div class="page" id="heads-plain-h3"><div class="column" style="gap: 4px"><h3 class="plain-h3">Adult Red Dragon</h3><p>Monster, CR 17.</p></div><div class="column" style="gap: 8px"><h3 class="plain-h3">Adult Red Dragon</h3><p>Huge Dragon (Chromatic), Chaotic Evil</p></div></div>
        <div class="page" id="heads-even"><div class="column" style="gap: 4px"><h4 class="plain">Changes</h4><p>What changed in the rules.</p></div><div class="column" style="gap: 4px"><h4 class="plain">Credits</h4><p>Who made the art.</p></div></div>

        <div class="page" id="exempt">
          <section>${label("Sight")}<div data-setting-row class="row" style="flex-wrap: wrap; gap: 8px 12px"><div class="words" style="flex: 1 1 100%"><span class="name">Sight</span><span class="help">Who sees what.</span></div><div role="radiogroup" aria-label="Sight" style="display: flex; gap: 4px"><label><input type="radio" name="s">Party</label><label><input type="radio" name="s">Each</label></div></div></section>
          <div role="menu" style="display: grid"><div role="group" aria-labelledby="menu-draw" style="display: grid"><div id="menu-draw" aria-hidden="true" class="label" style="padding: 8px 12px 4px">Draw</div><button role="menuitem" class="row">Pen</button><button role="menuitem" class="row">Line</button></div></div>
          <div role="group" aria-labelledby="measure-shape" style="display: grid; gap: 4px"><div id="measure-shape" class="label" style="padding-top: 4px">Shape</div><div style="display: flex; gap: 4px"><button>Circle</button><button>Cone</button></div></div>
          <div role="group" aria-label="Crypts" style="display: grid"><span class="label" style="padding: 4px 0">Crypts</span><label for="copy-crypt" class="row" style="padding: 4px 0"><input type="checkbox" id="copy-crypt">Crypt</label></div>
          <div style="display: grid; gap: 12px"><label for="objects" class="row"><input type="checkbox" id="objects">Objects block sight</label></div>
          <div class="column"><h4 class="label" style="padding-block: 8px; border-top: 1px solid #444">1st level</h4><div class="row">Magic missile</div></div>
          <div class="column" style="gap: 12px"><h4 class="label" style="padding-block: 8px">2nd level</h4><div class="row">Hold person</div></div>
          <fieldset><legend>Dice</legend><div class="column"><div class="three" data-card-group style="margin-top: 8px"><label style="position: relative; display: grid; justify-items: center; padding: 8px 4px; border: 1px solid #777"><input type="radio" name="d" style="position: absolute; inset: 0; opacity: 0">Ruby</label></div></div></fieldset>
          <div data-panel-group style="display: grid; border-top: 1px solid #444"><div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 48px"><h3 style="margin: 0; display: flex; flex: 1 1 auto"><button aria-expanded="true" style="flex: 1; min-height: 48px">Combat</button></h3></div><div class="column" style="padding-top: 4px">${switchRow("Hidden")}</div></div>
          <div data-panel-group style="display: grid; border-top: 1px solid #444"><div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 48px"><h3 style="margin: 0; display: flex; flex: 1 1 auto"><span style="display: grid; align-content: center; min-height: 48px">Stat block</span></h3><button style="min-height: 44px">Attach a stat block</button></div><div class="column" style="padding-top: 12px"><p>Its stat block.</p></div></div>
          <div class="column" style="gap: 4px"><h3 style="margin: 0; font-size: 16px"><button aria-expanded="true" style="padding: 0; border: none; background: none; color: inherit; font: inherit">Notes</button></h3><p>Its notes.</p></div>
          <div class="column" style="gap: 12px"><h3 style="margin: 0; font-size: 16px"><button aria-expanded="true" style="padding: 0; border: none; background: none; color: inherit; font: inherit">Position</button></h3><p>Where it stands.</p></div>
        </div>

        <div class="flat" id="alone"><section id="alone-root">${label("Show a handout")}<p class="help">Pick an image.</p></section><fieldset class="grid"><legend>Show to</legend>${cards()}</fieldset></div>
        <div class="page" id="inside"><section id="inside-root">${label("Show a handout")}<p class="help">Pick an image.</p></section><fieldset class="grid"><legend>Show to</legend>${cards()}</fieldset></div>`);

        const at = `sp-0 ${scale}`;
        const found = (selector: string) => measureSpacing(page.locator(selector));
        const lines = async (selector: string) => spacingLines(await found(selector), `${at} ${selector}`);
        /** A measured pair by its rule and words, so a case that passes is shown to have been measured. */
        const pair = (findings: SpacingFinding[], rule: SpacingFinding["rule"], name: string, over?: string) => {
          const hit = findings.find((f) => f.rule === rule && f.name.toLowerCase() === name.toLowerCase() && (over === undefined || f.over === over));
          assert.ok(hit, `${at}: no ${rule} pair for "${name}" in ${JSON.stringify(findings)}`);
          return hit;
        };
        const fails = async (selector: string, pattern: RegExp) => {
          const got = await lines(selector);
          assert.ok(got.some((l) => pattern.test(l)), `${at} ${selector} must fail with ${pattern}: ${JSON.stringify(got)}`);
          return got;
        };
        const passes = async (selector: string) => assert.deepEqual(await lines(selector), [], `${at} ${selector} must pass`);

        // Rule 1: a legend is not a grid item, so a fieldset's gap leaves its cards and help on it. Margins under it pass, with a help and without.
        assert.deepEqual(await lines("#cards-bare"), [`${at} #cards-bare: "Map images" sits 0 px over its first card, wants 8`]);
        await fails("#cards-bare-help", /"Turn timer" sits 0 px over its help, wants 4$/);
        await fails("#cards-bare-help", /"Turn timer"'s help sits 4 px over its first card, wants 8$/);
        await passes("#cards-fixed");
        assert.equal(pair(await found("#cards-fixed"), "card-name", "Map images").gap, 8);
        await passes("#cards-fixed-help");
        const helped = await found("#cards-fixed-help");
        assert.deepEqual([pair(helped, "card-name", "Turn timer", "its help").gap, helped.find((f) => f.help)?.gap], [4, 8]);
        // The radio group form, named by aria-labelledby, as Players see.
        await fails("#cards-radiogroup", /"Players see" sits 4 px over its first card, wants 8$/);
        await passes("#cards-radiogroup-fixed");
        pair(await found("#cards-radiogroup-fixed"), "card-name", "Players see");
        // Rule 1: a field's label first in its one-column grid, as the pairing page's code.
        await fails("#field-far", /label "Code from the DM's screen" sits 12 px over its field, wants 4$/);
        await passes("#field-near");
        pair(await found("#field-near"), "field-label", "Code from the DM's screen");

        // Rule 2 counts layout boxes: a label 8 over a help and over a switch's row passes, though the switch's words stand 16 under it.
        await passes("#label-help");
        await passes("#label-switch");
        assert.equal(pair(await found("#label-switch"), "section-label", "Battery").gap, 8);
        await fails("#label-tight", /section label "Farther away" sits 4 px over "Rows farther off\.", wants 8$/);
        // Three label rows, each passing at 8 and failing at 4: a grid label's own padding, a note wrapped under its h4, a fold's summary wrapped under its name.
        for (const [shape, words] of [["grid-label", "Saves for 3"], ["note-label", "Saves"], ["fold-label", "Fog and party vision"]] as const) {
          await passes(`#${shape}-far`);
          pair(await found(`#${shape}-far`), "section-label", words);
          await fails(`#${shape}-near`, new RegExp(`section label "${words}" sits 4 px over`));
        }
        const rows = await page.locator("#note-label-far .notelabel, #fold-label-far .foldrow").evaluateAll((els) =>
          els.map((el) => (el as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect().height),
        );
        assert.ok(rows[0]! > 30 * scale && rows[1]! > 50 * scale, `the note and the summary wrap to a line of their own: ${rows.join(", ")}`);

        // Rule 3: a bare choice among switch rows stands its label 8 nearer than the rest, through the scroller from the bare section alone.
        await fails("#bare", /section label "Map detail" stands [\d.]+ px over "Map images", where 2 other settings sections stand [\d.]+$/);
        const bare = pair(await found("#bare"), "settings", "Map detail");
        assert.ok(bare.want - bare.gap > 6, `the bare choice stands about a row's padding nearer: ${JSON.stringify(bare)}`);
        await passes("#padded");
        // A fold's row and a lone label over switch rows in one scroller pass, each held to labels of its own kind (VisionSettings.tsx's Fog and party vision).
        await passes("#settings-mixed");
        const mixed = await found("#settings-mixed");
        for (const words of ["Fog and party vision", "Players", "Battery"]) pair(mixed, "settings", words);
        // A label whose own padding carries the gap stands its words where the others do: rule 3 reads from the heading's words, not its box.
        await passes("#settings-padding");
        const padded = await found("#settings-padding");
        for (const words of ["Battery", "Saves", "Sounds"]) pair(padded, "settings", words);
        await fails("#settings-folds", /section label "Map detail" stands [\d.]+ px over "Map images", where 2 other settings sections stand/);
        // Measured once, however many roots in the scroller match.
        const once = await lines("#settings-bare section");
        assert.deepEqual(once.map((l) => l.replace(/^.*?: /, "")), (await lines("#bare")).map((l) => l.replace(/^.*?: /, "")), "a scroller is measured once per call");

        // Rule 4: two h4s of one look, 4 and 8 over their text.
        await fails("#heads-off", /h4 "Credits" sits 8 px over "Who made the art\.", where 1 other h4 of its look sits 4$/);
        // A ruled heading is a look of its own (D-261030-525): a stat block's ruled title 8 over its line beside a creature header's plain one 4 over its line passes, and two plain ones at 4 and 8 still fail.
        await passes("#heads-ruled");
        assert.equal((await found("#heads-ruled")).filter((f) => f.rule === "headings").length, 2, "both titles are measured");
        await fails("#heads-plain-h3", /h3 "Adult Red Dragon" sits 8 px over "Huge Dragon \(Chromatic\), Chaotic Evil", where 1 other h3 of its look sits 4$/);
        await passes("#heads-even");
        pair(await found("#heads-even"), "headings", "Credits");

        // The exemptions: a SettingRow's name, a menu's group headings, the measure tool's titles, Copy settings' folders, checkbox rows, the spell level h4s, a tile's own label, a group's header with its fold or its action, and headings that hold their disclosure.
        await passes("#exempt");
        const exempt = await found("#exempt");
        pair(exempt, "section-label", "Sight");
        pair(exempt, "card-name", "Dice");
        for (const words of ["Draw", "Shape", "Crypts", "Crypt", "Objects block sight", "1st level", "2nd level", "Ruby", "Combat", "Stat block", "Notes", "Position"]) {
          assert.ok(!exempt.some((f) => f.name === words), `${at}: "${words}" is exempt, and measured: ${JSON.stringify(exempt)}`);
        }

        // A root with no scroller is measured alone. Inside one, the whole scroller is.
        await passes("#alone-root");
        assert.ok(!(await found("#alone-root")).some((f) => f.name === "Show to"), "a root with no scroller reads only itself");
        await fails("#alone", /"Show to" sits 0 px over its first card, wants 8$/);
        await fails("#inside-root", /"Show to" sits 0 px over its first card, wants 8$/);
      }
    } finally {
      await page.close();
    }
  });
}

/** pl3-a: the room, which each file builds first. */
export function roomTest(): void {
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
    run.dmLink = link;
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
}

const FL7 = { monster: randomUUID(), token: randomUUID(), companion: randomUUID(), block: randomUUID(), dragon: randomUUID() };
const FL7_MONSTER_AT = { x: 1, y: 2 };
const FL7_COMPANION_AT = { x: 2, y: 2 };
const FL7_DRAGON_AT = { x: 1, y: 8 };
const FL7_STATS = {
  abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 14, cha: 10 },
  saves: ["dex", "con"],
  skills: { athletics: "prof", "animal-handling": "prof", "sleight-of-hand": "expert", perception: "expert" },
  jack: true,
  adjust: { allSaves: 1 },
  defenses: {},
  rolls: [],
};
const FL7_BLOCK = {
  size: "medium", type: "Humanoid", alignment: "Neutral", ac: 12, initiative: 0,
  hp: { average: 30, formula: "4d8 + 12" }, speed: "30 ft.",
  abilities: { str: { score: 10, save: 2 }, dex: { score: 10, save: 0 }, con: { score: 10, save: 2 }, int: { score: 10, save: 0 }, wis: { score: 10, save: 0 }, cha: { score: 10, save: 0 } },
  skills: "Animal Handling +2, Sleight of Hand +4, Perception +0",
  vulnerabilities: "", resistances: "", immunities: "", gear: "", senses: "", passivePerception: 10, languages: "Common", cr: "1", xp: 200,
  traits: [], actions: [], bonusActions: [], reactions: [], legendaryActions: [],
};
/** Panel.tsx GROUP_ROW and Roller.tsx LAST_LINE_PX, in CSS px before the interface size. */
const FL7_GROUP_ROW = 48;
const FL7_LAST_LINE = 44;

/**
 * A screen with marks: `aligned` (the root unless given) measured by the
 * sweep, each mark the underline it should be and adding no height, and at
 * least one mark in sight unless `optional`, as a folded line whose marked
 * parts are past its cut is.
 */
async function proficiencyScreen(sweep: Sweep, page: Page, screen: string, root: Locator, aligned: Locator = root, optional = false): Promise<void> {
  await root.locator('[data-proficiency-level="prof"], [data-proficiency-level="expert"]').first().waitFor({ state: "attached" });
  await root.first().evaluate(async (node) => {
    await (node as unknown as { ownerDocument: { fonts: { ready: Promise<unknown> } } }).ownerDocument.fonts.ready;
  });
  await sweep.measure(page, `fl7-${screen}`, aligned);
  await sweep.add(page, `fl7-${screen}`, await proficiencyLines(root, `${sweep.at} fl7-${screen}`, !optional));
  await sweep.add(page, `fl7-${screen}`, await proficiencyHeightLines(root, `${sweep.at} fl7-${screen}`, !optional));
}

/** The test name `words` names in `root` carries `level`: its tooltip and its picture's name say it, and neither has neither. */
async function proficiencyLevel(root: Locator, words: RegExp, level: "none" | "prof" | "expert"): Promise<void> {
  const label = root.locator("[data-proficiency-label]").filter({ hasText: words }).first();
  await label.waitFor();
  await waitFor(`fl7: ${words} resolves to ${level}`, async () => (await label.getAttribute("data-proficiency-level")) === level || null);
  const word = level === "prof" ? "Proficient" : level === "expert" ? "Expertise" : null;
  assert.equal(await label.getAttribute("title"), word, `fl7: ${words} has its tooltip`);
  assert.equal(await label.getByRole("img").count(), word ? 1 : 0, `fl7: ${words} names its level for a screen reader`);
  if (word) assert.equal(await label.getByRole("img").getAttribute("aria-label"), word);
}

/** The number of columns a grid lays out. */
async function gridColumns(grid: Locator): Promise<number> {
  return grid.evaluate((node) => (node as unknown as { ownerDocument: { defaultView: { getComputedStyle(n: unknown): { gridTemplateColumns: string } } } }).ownerDocument.defaultView.getComputedStyle(node).gridTemplateColumns.split(" ").length);
}

/** A box's height in CSS px before the interface size. */
async function heightOf(node: Locator): Promise<number> {
  return node.evaluate((el) => {
    const e = el as unknown as { currentCSSZoom?: number; getBoundingClientRect(): { height: number } };
    return e.getBoundingClientRect().height / (e.currentCSSZoom ?? 1);
  });
}

async function unfoldProficiencyOptions(host: Locator): Promise<Locator> {
  const options = host.locator("[data-roll-options]");
  // The options load after the panel. Folded lines can already hold some of the same names.
  for (const name of ["Saves and checks", "Skills"]) {
    const fold = options.getByRole("button", { name, exact: true });
    await fold.waitFor();
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  }
  return options;
}

/**
 * The Dice panel's options for one creature, open and folded: every save
 * and skill button carries its level, the saves stay three across, a
 * folded group keeps its one 48 px row, and for the PC the sticky line
 * keeps its 44 px with the result's label marked.
 */
async function proficiencyOptions(sweep: Sweep, page: Page, host: Locator, kind: "pc" | "monster" | "companion", shot: (page: Page, name: string) => Promise<void>): Promise<void> {
  const options = await unfoldProficiencyOptions(host);
  await proficiencyLevel(options, /^Animal Handling$/, "prof");
  await proficiencyLevel(options, /^Sleight of Hand$/, "expert");
  await proficiencyLevel(options, /^Perception$/, kind === "pc" ? "expert" : "none");
  await proficiencyLevel(options, /^STR$/, kind === "pc" ? "none" : "prof");
  await proficiencyLevel(options, /^DEX$/, kind === "pc" ? "prof" : "none");
  assert.equal(await options.locator("[data-proficiency-label]").count(), 24, "fl7: six saves and eighteen skills, no plain check");
  const saves = options.getByRole("group", { name: "Saves", exact: true }).locator(":scope > div").last();
  assert.equal(await gridColumns(saves), 3, `fl7: ${sweep.at} the saves stay three across`);
  const dexterity = options.getByRole("button", { name: /^Dexterity save/ }).first();
  assert.match((await dexterity.getAttribute("aria-label")) ?? "", kind === "pc" ? /^Dexterity save, proficient/ : /^Dexterity save(?!, proficient)/, "fl7: the button's name says its level");
  await proficiencyScreen(sweep, page, `${kind}-dice`, options);
  if (kind !== "companion") {
    await options.getByRole("button", { name: "Saves and checks", exact: true }).evaluate((node) => (node as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "start" }));
    await shot(page, `${kind}-options-open`);
  }
  for (const [name, screen] of [["Saves and checks", "saves"], ["Skills", "skills"]] as const) {
    const fold = options.getByRole("button", { name, exact: true });
    await fold.click();
    assert.equal(await fold.getAttribute("aria-expanded"), "false", `fl7: ${name} folds`);
    const summary = page.locator(`[id="${await fold.getAttribute("aria-describedby")}"]`);
    await summary.waitFor();
    // The line shares the name's row wherever the name and the line's 4em floor fit there, as before FL-7 (components/Panel.tsx Group), so the fold stays one 48 px row.
    const room = await page.locator(`[id="${await fold.getAttribute("aria-labelledby")}"]`).evaluate((node) => {
      const nameBox = node as unknown as { getBoundingClientRect(): { width: number }; parentElement: { getBoundingClientRect(): { width: number } } };
      return nameBox.parentElement.getBoundingClientRect().width - nameBox.getBoundingClientRect().width;
    });
    const zoomOf = await fold.evaluate((node) => (node as unknown as { currentCSSZoom?: number }).currentCSSZoom ?? 1);
    const row = await heightOf(fold);
    if (room >= (8 + 4 * 13) * zoomOf) assert.ok(Math.abs(row - FL7_GROUP_ROW) <= 1, `fl7: ${sweep.at} folded ${name} keeps its ${FL7_GROUP_ROW} px row: ${row.toFixed(1)}`);
    const parts = summary.locator("[data-summary-part]");
    const tops = await parts.evaluateAll((all) => all.filter((p) => (p as unknown as { getClientRects(): ArrayLike<unknown> }).getClientRects().length > 0 && (p as unknown as { style: { position: string } }).style.position !== "absolute").map((p) => Math.round((p as unknown as { getBoundingClientRect(): { top: number } }).getBoundingClientRect().top)));
    assert.ok(tops.length > 0 && new Set(tops).size === 1, `fl7: ${sweep.at} folded ${name} is one line: ${JSON.stringify(tops)}`);
    // A cut line hides whole parts and ends with "…". It never shows the start of a part it cut.
    const cut = await summary.getAttribute("data-summary-cut");
    // Or its first part alone is too long, and the summary's own ellipsis cuts it.
    if (cut !== null) assert.ok((await summary.locator("[data-summary-more]").isVisible()) || (await summary.evaluate((node) => (node as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (node as unknown as { clientWidth: number }).clientWidth)), `fl7: ${sweep.at} a cut ${name} line ends with "…"`);
    await proficiencyScreen(sweep, page, `${kind}-${screen}-folded`, summary, summary, true);
    if (kind !== "companion") {
      await fold.scrollIntoViewIfNeeded();
      await shot(page, `${kind}-${screen}-folded`);
    }
    await fold.click();
  }
  if (kind === "pc") {
    const skill = options.getByRole("button", { name: /^Sleight of Hand check, expertise/ }).first();
    await skill.click();
    const last = host.locator("[data-dice-last]");
    await proficiencyLevel(last, /^Sleight of Hand check$/, "expert");
    const line = last.locator(":scope > div").first();
    assert.ok(Math.abs((await heightOf(line)) - FL7_LAST_LINE) <= 1, `fl7: ${sweep.at} the sticky line keeps ${FL7_LAST_LINE} px`);
    await proficiencyScreen(sweep, page, "sticky-result", last);
    await shot(page, "pc-sticky-result");
  }
}

async function proficiencyToken(sweep: Sweep, page: Page, name: string, at: { x: number; y: number }, screen: string, shot: (page: Page, name: string) => Promise<void>): Promise<void> {
  await closeSheets(page);
  await escapeAll(page);
  // Expanding the previous bar pans the map. Closing it keeps that pan, which can leave the next token under the header.
  await page.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
  const bar = await selectToken(page, name, at);
  assert.ok(bar, `fl7: ${name}'s token bar opens`);
  await expandBar(bar);
  const more = bar.getByRole("button", { name: "More stats", exact: true });
  if (await visible(more)) await more.click();
  await proficiencyScreen(sweep, page, `${screen}-summary`, bar.locator("[data-saves]"));
  if (screen === "dragon") {
    await sweep.measure(page, "fl7-dragon-bar", bar);
    await proficiencyLevel(bar.locator("[data-saves]"), /^DEX$/, "prof");
    await proficiencyLevel(bar.locator("[data-saves]"), /^STR$/, "none");
    if (sweep.at.endsWith("390x844-1")) {
      const tops = await bar.locator("[data-saves] [data-saves-part] > span").evaluateAll((labels) => labels.map((el) => Math.round((el as unknown as { getBoundingClientRect(): { top: number } }).getBoundingClientRect().top)));
      assert.equal(tops.length, 7, "fl7: the dragon bar holds the heading and six saves");
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `fl7: the dragon's heading and saves stay on one line at 390x844: ${JSON.stringify(tops)}`);
    }
    await shot(page, "dragon-bar");
  }
  const panel = await openPanel(page, "Token");
  const fold = panel.getByRole("button", { name: "Stat block", exact: true });
  await fold.waitFor();
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  const grid = panel.locator("[data-ability-grid]").first();
  await grid.waitFor();
  assert.equal(await gridColumns(grid), 3, `fl7: ${sweep.at} the ability grid stays three across`);
  await proficiencyScreen(sweep, page, `${screen}-block`, panel);
  if (screen === "dragon") {
    await proficiencyLevel(panel, /^Perception$/, "expert");
    await panel.locator("p").filter({ hasText: /^Skills Perception/ }).first().scrollIntoViewIfNeeded();
    await shot(page, "dragon-block");
  }
}

/** Requests, answers and chips: a question for one creature marks its test, and an answer's line keeps its words. */
async function proficiencyRequests(sweep: Sweep, page: Page, shot: (page: Page, name: string) => Promise<void>): Promise<void> {
  await closeSheets(pat);
  await escapeAll(pat);
  await closeSheets(page);
  await escapeAll(page);
  const id = randomUUID();
  await ops.send({ t: "roll.ask", request: { id, test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, dc: 14, dcShown: true, resultShown: true, targets: [{ characterId: run.ids.thornChar }] } });
  try {
    const card = await playerRequestCard(pat);
    assert.ok(card, "fl7: the player's request is reachable from its card or summary");
    await card.getByText("The DM asks for a Wisdom (Perception) check, DC 14.", { exact: true }).waitFor();
    await proficiencyLevel(card, /^Wisdom \(Perception\)$/, "expert");
    await proficiencyScreen(sweep, pat, "player-request", card);
    await shot(pat, "player-request");
    const title = /^Roll request: WIS \(Perception\) check/;
    let dmCard = await alertCard(page, title);
    assert.ok(dmCard, "fl7: the DM request is reachable from its card or summary");
    const toggle = dmCard.locator("button[aria-expanded]").first();
    assert.match((await toggle.textContent()) ?? "", /^WIS \(Perception\) check, DC 14/, "fl7: the desk's title keeps its words");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      const opened = await dmCard.elementHandle();
      await toggle.click();
      let last = "";
      let still = 0;
      await waitFor("fl7: the expanded DM request holds still or moves into Alerts", async () => {
        const box = JSON.stringify(await opened?.boundingBox().catch(() => null));
        still = box === last ? still + 1 : 0;
        last = box;
        return still >= 2 ? true : null;
      }, 3_000);
      await opened?.dispose();
      dmCard = await alertCard(page, title);
      assert.ok(dmCard, "fl7: the expanded DM request stays reachable");
    }
    await proficiencyLevel(dmCard, /^WIS \(Perception\)$/, "expert");
    // The rows under the title keep a 2 px offset from before FL-7 (the name and its line beside Roll and the marks), so the sweep measures the title FL-7 marks.
    await proficiencyScreen(sweep, page, "dm-request", dmCard, toggle);
    await patOps.send({ t: "roll.dice", tag: randomUUID(), rollId: id, target: { characterId: run.ids.thornChar } });
    await waitFor("fl7: the player's rolled answer", () => dmSocket.state?.rolls[id]?.targets[0]?.dice);
    await dmCard.getByText(/^rolled \d+ \(/).waitFor();
    await sweep.measure(page, "fl7-dm-answer", toggle);
    await shot(page, "dm-request-answered");
    const fold = card.getByRole("button", { name: "Done, fold it into a chip", exact: true });
    if (await visible(fold)) await fold.click();
    const chip = pat.getByRole("button", { name: /^WIS \(Perception\), expertise check: rolled/ }).filter({ visible: true }).first();
    await chip.waitFor();
    await proficiencyLevel(chip, /^WIS \(Perception\)$/, "expert");
    await proficiencyScreen(sweep, pat, "player-chip", chip);
    await shot(pat, "player-chip");
  } finally {
    await ops.send({ t: "roll.close", rollIds: [id] });
  }
  const choiceId = randomUUID();
  await ops.send({ t: "roll.ask", request: { id: choiceId, test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }, { ability: "wis", skill: "animal-handling" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.ids.thornChar }] } });
  try {
    const card = await playerRequestCard(pat);
    assert.ok(card, "fl7: the player's choices are reachable from their card or summary");
    await proficiencyLevel(card, /^Wisdom \(Perception\)$/, "expert");
    await proficiencyLevel(card, /^Wisdom \(Animal Handling\)$/, "prof");
    await card.getByRole("radio", { name: /^Wisdom \(Perception\) [+−-]\d+, expertise$/ }).waitFor();
    await proficiencyScreen(sweep, pat, "player-choices", card);
    await shot(pat, "player-choices");
  } finally {
    await ops.send({ t: "roll.close", rollIds: [choiceId] });
  }
}

/** A toast, Recent rolls and the Log keep their words, a toast of several rolls its one line, and mark the label they name. */
async function proficiencyResults(sweep: Sweep, page: Page, shot: (page: Page, name: string) => Promise<void>): Promise<void> {
  await closeSheets(page);
  await escapeAll(page);
  await openPanel(page, "Token");
  const roll = { formula: "1d20+8", label: "Perception check", creature: { characterId: run.ids.thornChar } };
  await patOps.send({ t: "dice.roll", tag: randomUUID(), to: "all", rolls: [roll] });
  // A natural 20 or 1 adds its verdict after the words, for a screen reader.
  const toast = page.locator("[data-toast]").filter({ hasText: /for Thorn, Perception check\./ }).filter({ visible: true }).last();
  await proficiencyLevel(toast, /^Perception check$/, "expert");
  await proficiencyScreen(sweep, page, "toast", toast);
  await shot(page, "toast-one-roll");
  await patOps.send({ t: "dice.roll", tag: randomUUID(), to: "all", rolls: [roll, roll] });
  const several = page.locator("[data-toast]").filter({ hasText: /rolled 2 Perception checks\./ }).filter({ visible: true }).last();
  await proficiencyLevel(several, /^Perception check$/, "expert");
  assert.match((await several.textContent()) ?? "", /^[^\n]*rolled 2 Perception checks\.( Natural (20|1)\.)?$/, "fl7: the toast's words, no line per roll");
  const lines = await several.evaluate((node) => {
    const range = (node as unknown as { ownerDocument: { createRange(): { selectNodeContents(n: unknown): void; getClientRects(): ArrayLike<{ top: number; width: number }> } } }).ownerDocument.createRange();
    range.selectNodeContents(node);
    return new Set(Array.from(range.getClientRects()).filter((r) => r.width > 1).map((r) => Math.round(r.top))).size;
  });
  if (lines === 1) assert.ok(Math.abs((await heightOf(several)) - 44) <= 1, `fl7: ${sweep.at} a toast of several rolls stays one 44 px row`);
  await proficiencyScreen(sweep, page, "toast-several", several);
  await shot(page, "toast-several-rolls");
  const dice = await openDice(page);
  const recent = dice.locator("[data-dice-recent]");
  const recentFold = recent.getByRole("button", { name: "Recent rolls", exact: true });
  await recentFold.waitFor();
  if ((await recentFold.getAttribute("aria-expanded")) !== "true") await recentFold.click();
  await proficiencyLevel(recent, /^Perception check$/, "expert");
  await proficiencyScreen(sweep, page, "recent", recent);
  await recent.scrollIntoViewIfNeeded();
  await shot(page, "recent-rolls");
  await recentFold.click();
  const row = await heightOf(recentFold);
  assert.ok(Math.abs(row - FL7_GROUP_ROW) <= 1, `fl7: ${sweep.at} folded Recent rolls keeps its ${FL7_GROUP_ROW} px row: ${row.toFixed(1)}`);
  await proficiencyScreen(sweep, page, "recent-folded", recent);
  await shot(page, "recent-rolls-folded");
  const log = await openPanel(page, "Log");
  await proficiencyLevel(log, /^Perception check$/, "expert");
  // The Log's own controls keep a wrap from before FL-7 at 320 px ("Chat only" under Show older and Export), so the sweep measures the lines FL-7 marks.
  await proficiencyScreen(sweep, page, "log", log, log.locator("li").filter({ has: page.locator("[data-proficiency-label]") }));
  await shot(page, "log");
  // The toasts stand over the map, where the group save's taps go next. A tap on one closes it, a few tries at most so a toast that will not close fails here, not at the test's timeout (as savespell.e2e.ts dismissToasts).
  const toasts = page.locator("[data-toast]").filter({ visible: true });
  for (let i = 0; i < 8 && (await toasts.count()) > 0; i++) await toasts.first().click({ timeout: 1000 }).catch(() => {});
  assert.equal(await toasts.count(), 0, `fl7: ${sweep.at} toasts still over the map after 8 taps`);
}

async function proficiencyGroup(sweep: Sweep, page: Page, shot: (page: Page, name: string) => Promise<void>): Promise<void> {
  await closeSheets(page);
  await escapeAll(page);
  const bar = await selectToken(page, "FL7 Monster", FL7_MONSTER_AT);
  assert.ok(bar, "fl7: group selection starts at the monster");
  await multiSelect(bar);
  await tapCell(page, BOUNDS, FL7_COMPANION_AT);
  const group = page.locator('[role="dialog"][data-bar-mode]').filter({ hasText: /2 selected/ }).first();
  await group.waitFor();
  await (await barControl(group, "Roll")).click();
  const host = await openDice(page);
  await host.getByRole("button", { name: "Set up a group save", exact: true }).click();
  await host.getByRole("combobox", { name: "Ability", exact: true }).selectOption("str");
  // Each row's name carries its creature's Strength save: the page names the save once for all of them (D-261029-415).
  await proficiencyLevel(host, /^FL7 Monster$/, "prof");
  await proficiencyLevel(host, /^FL7 Companion$/, "prof");
  await proficiencyScreen(sweep, page, "group-setup", host);
  await host.locator("[data-proficiency-label]").filter({ hasText: /^FL7 Monster$/ }).first().scrollIntoViewIfNeeded();
  await shot(page, "group-save");
  const rolled = () => (dmSocket.state?.log ?? []).filter((entry) => entry.data?.type === "dice" && entry.data.rolls.some((roll) => roll.tokenId === FL7.token)).length;
  const before = rolled();
  const start = host.getByRole("button", { name: /^Roll \d+ saves?( and ask \d+ players?)?$|^Ask \d+ players?$/ }).first();
  await start.click();
  await waitFor("fl7: the group's server result lands", () => rolled() > before || null);
  await proficiencyScreen(sweep, page, "group-results", host);
  await shot(page, "group-save-rolled");
  await host.getByRole("button", { name: "Discard", exact: true }).first().click();
  const confirm = host.getByRole("button", { name: "Keep it", exact: true });
  if (await visible(confirm)) await host.getByRole("button", { name: "Discard", exact: true }).first().click();
  const requests = Object.keys(dmSocket.state?.rolls ?? {});
  if (requests.length) await ops.send({ t: "roll.close", rollIds: requests });
  await closeSheets(page);
  const none = page.getByRole("button", { name: "Deselect all" }).first();
  if (await visible(none)) await none.click();
  const done = page.getByRole("button", { name: "Done", exact: true }).first();
  if (await visible(done)) await done.click();
}

async function proficiencyEncounter(sweep: Sweep, page: Page, shot: (page: Page, name: string) => Promise<void>): Promise<void> {
  await closeSheets(page);
  await escapeAll(page);
  const concentration = randomUUID();
  await ops.send({ t: "actor.effect.add", target: { tokenId: FL7.token }, effect: { id: concentration, key: "concentrating", spell: "Hex" } });
  await ops.send({ t: "actor.hp", target: { tokenId: FL7.token }, change: { kind: "damage", amount: 1 } });
  const card = await alertCard(page, "Concentration save for FL7 Monster");
  assert.ok(card, "fl7: concentration card is reachable");
  await proficiencyLevel(card, /^Concentration save$/, "prof");
  await proficiencyScreen(sweep, page, "concentration", card);
  await shot(page, "concentration");
  await card.getByRole("button", { name: "Passed", exact: true }).click();
  await ops.send({ t: "actor.effect.remove", target: { tokenId: FL7.token }, effectId: concentration });
  await escapeAll(page);
  await ops.send({ t: "encounter.end" });
  await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: FL7.token, value: 20 }, { id: randomUUID(), tokenId: run.ids.thorn, value: 10 }] });
  await ops.send({ t: "encounter.next" });
  const effectId = randomUUID();
  await ops.send({ t: "actor.effect.add", target: { tokenId: FL7.token }, effect: { id: effectId, key: "frightened", save: { ability: "str", dc: 14 } } });
  await ops.send({ t: "encounter.next" });
  const waiting = page.locator('[data-alert-id^="saveEnds:"]').first();
  await waiting.waitFor({ state: "attached" });
  const title = await waiting.getAttribute("aria-label");
  assert.ok(title, "fl7: save-ends card names its save");
  const ends = await alertCard(page, title);
  assert.ok(ends, "fl7: save-ends card is reachable");
  // The save carries the mark, never its DC (FL7-R1-13).
  await proficiencyLevel(ends, /^Strength save$/, "prof");
  await proficiencyScreen(sweep, page, "save-ends", ends);
  await shot(page, "save-ends");
  await ops.send({ t: "actor.effect.remove", target: { tokenId: FL7.token }, effectId });
  await ops.send({ t: "actor.hp", target: { tokenId: FL7.token }, change: { kind: "heal", amount: 1 } });
  await restartFight();
}

/**
 * The FL-7 rework's sizes (D-261030-436 to 438): the alignment sizes, each
 * at 100% and 130%. The app has one theme, a dark one (globals.css), so
 * there is no second scheme to run. The phones are shot.
 */
const FL7_SIZES = ["1440x900", "390x844", "320x568"];

/** FL-7 has its own matrix so every surface it marks is measured, and shot on a phone. */
export function proficiencyTests(): void {
  test("fl7-helper. taking marks off finds one that adds height and puts it back", async () => {
    const page = await dmContext.newPage();
    try {
      for (const scale of SCALES) {
        await page.setContent(`<div id="root" style="width:180px;font:14px/20px sans-serif;zoom:${scale}">
          <span data-proficiency-label data-proficiency-level="prof" title="Proficient" style="text-decoration:underline dotted 2px;text-underline-offset:1px">Save<span data-proficiency-marker="prof" role="img" aria-label="Proficient"></span></span> +5
          <span data-proficiency-label data-proficiency-level="expert" title="Expertise" style="text-decoration:underline double 1px;text-underline-offset:1px">Skill<span data-proficiency-marker="expert" role="img" aria-label="Expertise"></span></span> +7
        </div><div id="empty"></div>`);
        const root = page.locator("#root");
        assert.deepEqual(await proficiencyHeightLines(root, "fl7-height"), [], "an underline adds no row");
        assert.deepEqual(await proficiencyLines(root, "fl7-lines"), [], "both marks are what D-261030-436 asks for");
        // A mark that takes room, as FL-7's slots did, adds a row. Taking it off must find that.
        await root.locator("[data-proficiency-label]").first().evaluate((node) => {
          (node as unknown as { style: { cssText: string } }).style.cssText += ";display:inline-block;padding-bottom:6px";
        });
        assert.match((await proficiencyHeightLines(root, "fl7-height")).join("\n"), /change its height/, "a mark that adds height fails");
        assert.match(await root.locator("[data-proficiency-label]").first().evaluate((node) => (node as unknown as { style: { cssText: string } }).style.cssText), /padding-bottom: 6px/, "the mark is put back after the check");
        assert.match((await proficiencyHeightLines(page.locator("#empty"), "fl7-height")).join("\n"), /no visible/, "empty coverage cannot pass");
      }
    } finally {
      await page.close();
    }
  });
  test("fl7-helper. the mark check rejects a solid or colored underline, a missing name and a clipped foot", async () => {
    const page = await dmContext.newPage();
    try {
      const label = (style: string, title = "Proficient") => `<span data-proficiency-label data-proficiency-level="prof" title="${title}" style="${style}">Perception<span data-proficiency-marker="prof" role="img" aria-label="Proficient"></span></span>`;
      const good = "text-decoration:underline dotted 2px;text-underline-offset:1px";
      await page.setContent(`<div style="font:14px/1.4 sans-serif">
        <p id="good">${label(good)}</p>
        <p id="solid">${label("text-decoration:underline solid 1px")}</p>
        <p id="colored">${label(`${good};text-decoration-color:red`)}</p>
        <p id="unnamed">${label(good, "")}</p>
        <div id="clipped" style="height:14px;overflow:hidden;line-height:14px">${label(good)}</div>
      </div>`);
      const lines = async (id: string) => (await proficiencyLines(page.locator(`#${id}`), "fl7-helper")).join("\n");
      assert.equal(await lines("good"), "");
      assert.match(await lines("solid"), /a solid underline/);
      assert.match(await lines("colored"), /not its words'/);
      assert.match(await lines("unnamed"), /not named Proficient/);
      assert.match(await lines("clipped"), /under the div that clips it/);
    } finally {
      await page.close();
    }
  });
  test("fl7-a. explicit PC flags, listed monster bonuses and a projected companion block", async () => {
    await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { level: 5, stats: FL7_STATS } });
    await ops.send({ t: "monster.create", monster: { ...FL7_BLOCK, id: FL7.monster, name: "FL7 Monster" } });
    await ops.send({ t: "companionBlock.create", block: { ...FL7_BLOCK, id: FL7.block, characterId: run.ids.thornChar, name: "FL7 Companion" } });
    await ops.send({ t: "token.create", token: { id: FL7.token, sceneId: run.sceneId, kind: "monster", name: "FL7 Monster", size: "medium", ...FL7_MONSTER_AT, disposition: "hostile", actor: { inline: actor({ monsterId: FL7.monster }) } } });
    await ops.send({ t: "token.create", token: { id: FL7.companion, sceneId: run.sceneId, kind: "npc", name: "FL7 Companion", size: "medium", ...FL7_COMPANION_AT, disposition: "ally", companion: { of: run.ids.thornChar, turn: "shared" }, actor: { inline: actor({ blockId: FL7.block }) } } });
    await ops.send({ t: "token.create", token: { id: FL7.dragon, sceneId: run.sceneId, kind: "monster", name: "Adult White Dragon", size: "huge", ...FL7_DRAGON_AT, disposition: "hostile", actor: { inline: srdActor("adult-white-dragon") } } });
  });
  for (const name of FL7_SIZES) {
    const size = SIZES.find((s) => s.name === name)!;
    for (const scale of SCALES) {
      test(`fl7-${size.name}-${scale}. marks are underlines on the words each surface already had, adding no rows`, async () => {
        const sweep = new Sweep(`fl7-${size.name}-${scale}`);
        const shot = async (on: Page, what: string) => {
          if (size.touch) await shots.take(on, `fl7-${size.name}-${Math.round(scale * 100)}-${on === pat ? "player" : "dm"}-${what}`);
        };
        const page = await dmPageFor(size);
        await openAt(page, size, scale);
        await openAt(pat, size, scale);
        await proficiencyToken(sweep, page, "Adult White Dragon", { x: FL7_DRAGON_AT.x + 1, y: FL7_DRAGON_AT.y + 1 }, "dragon", shot);
        await proficiencyToken(sweep, page, "FL7 Monster", FL7_MONSTER_AT, "monster", shot);
        await proficiencyOptions(sweep, page, await openDice(page), "monster", shot);
        await proficiencyToken(sweep, page, "FL7 Companion", FL7_COMPANION_AT, "companion", shot);
        await proficiencyOptions(sweep, page, await openDice(page), "companion", shot);

        const dice = await openDice(pat);
        const tabs = dice.getByRole("tablist", { name: "Roll for" });
        await tabs.getByRole("tab", { name: "Thorn", exact: true }).click();
        await proficiencyOptions(sweep, pat, dice, "pc", shot);
        await tabs.getByRole("tab", { name: "FL7 Companion", exact: true }).click();
        await proficiencyOptions(sweep, pat, dice, "companion", shot);
        await tabs.getByRole("tab", { name: "Warhorse", exact: true }).click();
        await unfoldProficiencyOptions(dice);
        assert.equal(await dice.locator('[data-roll-options] [data-proficiency-level="prof"], [data-roll-options] [data-proficiency-level="expert"]').count(), 0, "fl7: an owned creature without a stat block has no guessed marks");
        await tabs.getByRole("tab", { name: "Thorn", exact: true }).click();
        const sheet = await thornsPage(pat);
        const fold = sheet.getByRole("button", { name: "Stat block", exact: true });
        if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
        await sheet.locator("[data-pc-stats]").getByText(/Sleight of Hand \+\d+ \(expertise\)/).waitFor();
        await proficiencyLevel(sheet.locator("[data-pc-stats]"), /^Sleight of Hand$/, "expert");
        assert.equal(await gridColumns(sheet.locator("[data-pc-stats] [data-ability-grid]")), 3, `fl7: ${sweep.at} the PC's ability grid stays three across`);
        await proficiencyScreen(sweep, pat, "pc-sheet", sheet.locator("[data-pc-stats]"));
        await sheet.locator("[data-pc-stats]").scrollIntoViewIfNeeded();
        await shot(pat, "pc-sheet");
        await sheet.getByText("Jack of All Trades", { exact: true }).waitFor();

        await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { srdId: "wolf", wildShape: true } } });
        await sheet.locator("[data-shape-numbers]").waitFor();
        await proficiencyScreen(sweep, pat, "wild-shape", sheet);
        await proficiencyLevel(sheet.locator("[data-shape-numbers]"), /^DEX$/, "prof");
        await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { srdId: "wolf" } } });
        await waitFor("fl7: Polymorph uses the beast's saving proficiency", async () => (await sheet.locator("[data-shape-numbers] [data-proficiency-label]").filter({ hasText: /^DEX$/ }).getAttribute("data-proficiency-level")) === "none" || null);
        await sweep.measure(pat, "fl7-polymorph", sheet);
        await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { srdId: null } } });
        await sheet.locator("[data-pc-stats]").waitFor();

        await proficiencyRequests(sweep, page, shot);
        await proficiencyResults(sweep, page, shot);
        await proficiencyGroup(sweep, page, shot);
        await proficiencyEncounter(sweep, page, shot);
        assert.deepEqual(sweep.lines, [], `fl7: marks out of place:\n${sweep.lines.join("\n")}`);
        console.log(`${sweep.at}: measured ${[...sweep.seen].join(", ")}`);
      });
    }
  }
}

/** How many steps SIZES at SCALES make, pl3-b1 to pl3-b12. The two steps after them take the next numbers. */
const SIZE_STEPS = SIZES.length * SCALES.length;

/**
 * pl3-b1 to pl3-b12 for the sizes of SIZES named, each at 100% and
 * 130%. A step's number is its place in SIZES, so it keeps its id in
 * whichever file runs it.
 */
export function sizeTests(names: readonly string[]): void {
  for (const name of names) assert.ok(SIZES.some((s) => s.name === name), `${name} is not one of the sweep's sizes`);
  let index = 0;
  for (const size of SIZES) {
    for (const scale of SCALES) {
      const at = `${size.name}${scale === 1 ? "" : "-130"}`;
      index++;
      if (!names.includes(size.name)) continue;
      test(`pl3-b${index}. at ${size.width} x ${size.height} at ${scale * 100}%, on ${size.touch ? "touch" : "a mouse"}: every screen of the sweep within ${LIMIT_PX} px`, async () => {
        const sweep = new Sweep(at);
        try {
          await resetThorn();
          await restartFight();
          pat.setDefaultTimeout(10_000);
          await openAt(pat, size, scale);
          await patScreens(sweep, pat, size);
          if (DICE_AT.has(size.name)) await patDiceScreens(sweep, pat);
          await pat.goto("about:blank");
          const page = await dmPageFor(size);
          page.setDefaultTimeout(10_000);
          await openAt(page, size, scale);
          await waitFor("the DM's snapshot", () => dmSocket.state);
          await dmScreens(sweep, page, size);
          await visionScreens(sweep, page, size);
          await previewWaitScreens(sweep, page, scale);
          if (DICE_AT.has(size.name)) await dmDiceScreens(sweep, page);
          if (COMBAT_AT.has(size.name)) await combatScreens(sweep, page, size, scale);
          console.log(`${at}: measured ${[...sweep.seen].join(", ")}`);
        } finally {
          sweep.tally();
        }
        assert.equal(sweep.lines.length, 0, `${sweep.lines.length} lines out of line at ${at}:\n${sweep.lines.join("\n")}`);
      });
      moreMenuTest(size, scale, at);
    }
  }
  for (const size of SIZES.filter((s) => names.includes(s.name) && DICE_AT.has(s.name))) {
    for (const scale of SCALES) {
      test(`fl6-${size.name}-${scale}. stable shape picker width and confirmation before forgetting a saved room at ${scale * 100}%`, async () => {
        const sweep = new Sweep(`${size.name}-${scale * 100}`);
        const page = await dmPageFor(size);
        page.setDefaultTimeout(10_000);
        await openAt(page, size, scale);
        await shapeScrollbarScreen(sweep, page, size, scale);
        try {
          await forgetRoomScreen(sweep, page);
          assert.deepEqual(sweep.lines, [], "FL-6 screens out of line");
        } finally {
          // Later steps observe room ops through this page's socket, which Home closes.
          await openAt(page, size, scale);
        }
      });
    }
  }
}

/** Exercise the real filter with classic scrollbars, including on hosts that normally draw overlay scrollbars. */
async function shapeScrollbarScreen(sweep: Sweep, page: Page, size: Size, scale: number): Promise<void> {
  const panel = await thornsPage(page);
  const fold = panel.getByRole("button", { name: "Stat block", exact: true });
  if (await fold.getAttribute("aria-expanded") === "false") await fold.click();
  await panel.getByRole("button", { name: /shapes?, take a shape$|^Take a shape$/ }).first().click();
  const picker = page.getByRole("dialog", { name: "Take a shape", exact: true });
  await picker.getByRole("button", { name: "Choose known forms", exact: true }).waitFor();
  // Adopt the test sheet because the app's CSP rejects inline style elements.
  const classic = await page.evaluateHandle(() => {
    type Sheet = { replaceSync(css: string): void };
    const browser = globalThis as unknown as { CSSStyleSheet: new () => Sheet; document: { adoptedStyleSheets: Sheet[] } };
    const sheet = new browser.CSSStyleSheet();
    sheet.replaceSync('dialog[aria-label="Take a shape"] > section > div::-webkit-scrollbar { width: 16px; height: 16px; }');
    browser.document.adoptedStyleSheets = [...browser.document.adoptedStyleSheets, sheet];
    return sheet;
  });
  try {
    const search = picker.getByRole("searchbox", { name: "Search creatures" });
    const body = picker.locator(":scope > section > div").first();
    const metrics = () => body.evaluate((node) => {
      const el = node as unknown as { clientWidth: number; offsetWidth: number; clientHeight: number; scrollHeight: number; firstElementChild: { getBoundingClientRect(): { width: number; left: number } } };
      const content = el.firstElementChild.getBoundingClientRect();
      return { width: content.width, left: content.left, gutter: el.offsetWidth - el.clientWidth, scrolls: el.scrollHeight > el.clientHeight + 1 };
    });
    const shortList = async () => {
      await search.fill("riding horse");
      await picker.getByRole("button", { name: /^Riding Horse/ }).first().waitFor();
      await waitFor("one matching creature", async () => (await picker.getByRole("listitem").count()) === 1 || null);
    };
    await shortList();
    const short = await metrics();
    if (size.name === "1440x900" && scale === 1) assert.equal(short.scrolls, false, "the short list must not need a scrollbar on desktop");
    await sweep.measure(page, "fl6-shapes-short", picker);
    await picker.getByRole("checkbox", { name: "Beasts only" }).uncheck();
    await picker.getByRole("combobox").selectOption("");
    await search.fill("");
    await waitFor("the full creature list", async () => (await picker.getByRole("listitem").count()) > 10 || null);
    await waitFor("the long creature list scrolls", async () => (await metrics()).scrolls || null);
    const long = await metrics();
    assert.ok(long.gutter >= 15, "classic scrollbars must consume real layout space in this check");
    assert.ok(Math.abs(short.width - long.width) <= LIMIT_PX, `content width changed from ${short.width} to ${long.width}`);
    assert.ok(Math.abs(short.left - long.left) <= LIMIT_PX, "the content's left edge stays put");
    await sweep.measure(page, "fl6-shapes-long", picker);
    await shots.take(page, `alignment-${sweep.at}-fl6-shapes-long`);
    await shortList();
    assert.ok(Math.abs((await metrics()).width - short.width) <= LIMIT_PX, "clearing the long list keeps the same width too");
  } finally {
    await classic.evaluate((sheet) => {
      const doc = (globalThis as unknown as { document: { adoptedStyleSheets: unknown[] } }).document;
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((entry) => entry !== sheet);
    });
    await classic.dispose();
    await picker.getByRole("button", { name: "Close Take a shape", exact: true }).click();
    await picker.waitFor({ state: "detached" });
  }
}

/** Forget is local only, and each dismissal leaves the saved entry and sign-in intact. */
async function forgetRoomScreen(sweep: Sweep, page: Page): Promise<void> {
  await page.goto(`${server.origin}/`);
  const opener = page.getByRole("button", { name: `Forget ${run.roomName} on this device`, exact: true });
  await opener.waitFor();
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("rvtt.rooms") ?? "[]") as { roomId: string }[]);
  const before = await saved();
  const question = page.getByRole("dialog", { name: "Forget this room?", exact: true });
  for (const dismissal of ["Cancel", "Escape", "Close"] as const) {
    await opener.focus();
    await opener.press("Enter");
    await question.waitFor();
    assert.deepEqual(await saved(), before, "opening the question changes no saved room");
    assert.match(await question.innerText(), /only removes it from this device's list\. The room itself stays\./);
    await sweep.measure(page, "fl6-forget-room", question);
    if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await question.getByRole("button", { name: dismissal === "Close" ? "Close Forget this room?" : "Cancel", exact: true }).click();
    await question.waitFor({ state: "detached" });
    assert.deepEqual(await saved(), before, `${dismissal} keeps every saved room`);
    assert.equal(await opener.evaluate((el) => (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement === el), true, "dismissal returns focus to Forget");
  }
  await opener.click();
  await question.waitFor();
  await shots.take(page, `alignment-${sweep.at}-fl6-forget-room`);
  await question.getByRole("button", { name: "Forget room", exact: true }).click();
  await question.waitFor({ state: "detached" });
  await opener.waitFor({ state: "detached" });
  assert.deepEqual(await saved(), before.filter((r) => r.roomId !== run.roomId), "only the confirmed room leaves this device's list");
  await page.reload();
  await page.getByRole("heading", { name: "Join a room", exact: true }).waitFor();
  assert.equal(await opener.count(), 0, "the room stays forgotten after reload");
  const me = await page.context().request.get(`${server.origin}/api/rooms/${run.roomId}/me`);
  assert.equal(me.status(), 200, "forgetting neither deletes the server room nor signs this device out");
}

/** FL5: the production SideTabs, Popover and Menu mounted together, including phone widths where Room uses the Panels sheet. */
function moreMenuTest(size: Size, scale: number, at: string): void {
  test(`fl5-b. More at ${at}: whole labels, viewport gutter and scrolling without a scrollbar`, async () => {
    await dmPageFor(size);
    const page = await dmContext.newPage();
    const sweep = new Sweep(at);
    try {
      await page.setViewportSize({ width: size.width, height: size.height });
      await moreMenuFixture(page, server.origin, scale);
      const opener = page.getByRole("tablist", { name: "Panels" }).locator('[aria-haspopup="menu"]');
      await opener.click();
      const menu = page.getByRole("menu", { name: "More panels" });
      const box = page.locator("[data-rvtt-popover]");
      await menu.waitFor();
      const edges = await menu.evaluate((el) => {
        type Element = { getBoundingClientRect(): { left: number; right: number }; getAttribute(name: string): string | null; querySelectorAll(selector: string): ArrayLike<Element> };
        const root = el as unknown as Element;
        const rect = root.getBoundingClientRect();
        return Array.from(root.querySelectorAll('[role="group"], [role^="menuitem"]')).map((part) => {
          const box = part.getBoundingClientRect();
          return { role: part.getAttribute("role"), left: box.left - rect.left, right: box.right - rect.right };
        });
      });
      assert.ok(edges.some((edge) => edge.role === "group") && edges.some((edge) => edge.role?.startsWith("menuitem")), "the menu must contain both group and item boxes");
      assert.ok(edges.every((edge) => Math.abs(edge.left) <= LIMIT_PX && Math.abs(edge.right) <= LIMIT_PX), `${at}: group and item boxes must share the menu's edges: ${JSON.stringify(edges)}`);
      await sweep.measure(page, "fl5-more-fixture", box);
      if (sweep.lines.length) console.error(sweep.lines.join("\n"));
      const wrapped = await menu.locator('[role^="menuitem"]').evaluateAll((items) => {
        type Item = { children: ArrayLike<{ textContent: string | null; getAttribute(name: string): string | null; ownerDocument: { createRange(): { selectNodeContents(node: unknown): void; getClientRects(): ArrayLike<{ top: number }> } } }> };
        return (items as unknown as Item[]).flatMap((item) => {
          const label = Array.from(item.children).find((child) => child.getAttribute("aria-hidden") !== "true" && child.textContent?.trim());
          if (!label) return ["missing label"];
          const range = label.ownerDocument.createRange();
          range.selectNodeContents(label);
          const rects = Array.from(range.getClientRects());
          return rects.some((rect) => Math.abs(rect.top - rects[0]!.top) > 1) ? [label.textContent] : [];
        });
      });
      assert.deepEqual(wrapped, [], `${at}: a normal menu label wrapped despite room for its whole row`);
      const placed = await box.boundingBox();
      assert.ok(placed && placed.x >= 8 * scale - 1 && placed.x + placed.width <= size.width - 8 * scale + 1, `${at}: the menu exceeds its viewport gutter`);
      await shots.take(page, `fl5-more-${at}`);

      // A short containing panel guarantees the scrolling path even on a tall desktop.
      await page.locator("aside").evaluate((el) => {
        (el as unknown as { style: { height: string } }).style.height = "280px";
        const win = globalThis as unknown as { dispatchEvent(event: unknown): void; Event: new (type: string) => unknown };
        win.dispatchEvent(new win.Event("resize"));
      });
      await box.getByText("Scroll for more", { exact: true }).waitFor();
      assert.deepEqual(await popoverScrollbarLines(box, at), []);
      const scrollTop = () => box.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop);
      const resetScroll = () => box.evaluate((el) => { (el as unknown as { scrollTop: number }).scrollTop = 0; });
      await box.hover();
      await page.mouse.wheel(0, 100);
      await waitFor(`${at}: the hidden-scrollbar menu scrolls by wheel`, async () => (await scrollTop()) > 0 || null);
      await resetScroll();
      await opener.press("ArrowDown");
      await page.keyboard.press("End");
      await waitFor(`${at}: End scrolls to the last item`, async () => (await scrollTop()) > 0 || null);
      assert.equal(await menu.locator('[role^="menuitem"]').last().evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true);
      assert.deepEqual(await popoverScrollbarLines(box, `${at} at the bottom`), []);
      if (size.touch) {
        // Start touch in a fresh scroller, after it paints, so the wheel and focus scrolls above cannot still be settling on the compositor.
        await page.keyboard.press("Escape");
        await opener.click();
        await box.getByText("Scroll for more", { exact: true }).waitFor();
        await box.evaluate(async () => {
          const win = globalThis as unknown as { requestAnimationFrame(callback: () => void): void };
          await new Promise<void>((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
        });
        assert.equal(await scrollTop(), 0, "the fresh menu starts at the top before touch");
        await shots.take(page, `fl5-more-${at}-before-touch`);
        const swipe = await box.evaluate((el) => {
          type Box = { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; contains(node: unknown): boolean; ownerDocument: { elementFromPoint(x: number, y: number): unknown } };
          const box = el as unknown as Box;
          const rect = box.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const from = { x, y: rect.top + rect.height * 0.75 };
          const to = { x, y: rect.top + rect.height * 0.25 };
          return { from, to, inside: box.contains(box.ownerDocument.elementFromPoint(from.x, from.y)) };
        });
        assert.ok(swipe.inside, `${at}: the touch must start inside the scroller`);
        const cdp = await dmContext.newCDPSession(page);
        try {
          await touchSwipe(cdp, swipe.from, swipe.to, { steps: 12, everyMs: 30 });
          await waitFor(`${at}: the hidden-scrollbar menu scrolls by touch`, async () => (await scrollTop()) > 0 || null);
          assert.equal(await opener.getAttribute("aria-expanded"), "true", `${at}: touch scrolling must leave the menu open`);
          assert.equal(await menu.count(), 1, `${at}: touch scrolling must not activate an item`);
        } finally {
          await cdp.detach();
        }
      }

      // Ordinary words wrap onto their own lines. Only a word wider than the whole cap breaks inside itself.
      // A pointer open keeps focus on More through a swipe. Enter the menu before Home, which would otherwise choose the tab strip's first tab and close the menu.
      assert.equal(await opener.getAttribute("aria-expanded"), "true", `${at}: the menu must remain open before the label checks`);
      await opener.press("ArrowDown");
      assert.equal(await menu.evaluate((el) => {
        const menu = el as unknown as { contains(node: unknown): boolean; ownerDocument: { activeElement: unknown } };
        return menu.contains(menu.ownerDocument.activeElement);
      }), true, `${at}: Home must be sent inside the menu`);
      await page.keyboard.press("Home");
      await resetScroll();
      for (const [index, words] of ["Show every creature in the encounter before opening another panel", "W".repeat(80), "W".repeat(80)].entries()) {
        const caseName = index === 0 ? "long-phrase" : index === 1 ? "unbroken-word" : "grouped-unbroken-word";
        const item = index < 2 ? menu.getByRole("menuitemcheckbox") : menu.getByRole("group", { name: "Prepare" }).getByRole("menuitemradio").first();
        await item.evaluate((el, text) => {
          type Label = { textContent: string | null; getAttribute(name: string): string | null };
          const item = el as unknown as { children: ArrayLike<Label> };
          const label = Array.from(item.children).find((child) => child.getAttribute("aria-hidden") !== "true" && child.textContent?.trim());
          if (!label) throw new Error("FL5 checkbox label is missing");
          label.textContent = text;
        }, words);
        await page.locator("aside").evaluate((el, height) => {
          (el as unknown as { style: { height: string } }).style.height = `${height}px`;
          const win = globalThis as unknown as { dispatchEvent(event: unknown): void; Event: new (type: string) => unknown };
          win.dispatchEvent(new win.Event("resize"));
        }, 281 + index);
        const label = item.getByText(words, { exact: true });
        await label.waitFor();
        await item.scrollIntoViewIfNeeded();
        await shots.take(page, `fl5-more-${at}-${caseName}`);
        assert.deepEqual(await menuWordLines(box, `${at} ${caseName}`), []);
        const capped = await box.boundingBox();
        assert.ok(capped && capped.x >= 8 * scale - 1 && capped.x + capped.width <= size.width - 8 * scale + 1, `${at} ${caseName}: the long label exceeds the gutter`);
        const widths = await Promise.all([box, item, label].map((part) => part.evaluate((el) => {
          const part = el as unknown as { scrollWidth: number; clientWidth: number };
          return { scroll: part.scrollWidth, client: part.clientWidth };
        })));
        assert.ok(widths.every((width) => width.scroll <= width.client + 1), `${at} ${caseName}: the popover, item and label must not scroll sideways: ${JSON.stringify(widths)}`);
      }
      assert.equal(sweep.lines.length, 0, sweep.lines.join("\n"));
    } finally {
      await page.close();
    }
  });
}

/** pl3-b13: the combat controls' screens at the lane rule's smallest screen. */
export function combatSmallTest(): void {
  test(`pl3-b${SIZE_STEPS + 1}. at 480 x 320 at 130%, on touch: the combat controls' screens within ${LIMIT_PX} px`, async () => {
    const sweep = new Sweep("480x320-130");
    try {
      await resetThorn();
      await restartFight();
      const page = await dmPageFor(COMBAT_SMALL);
      page.setDefaultTimeout(10_000);
      // The DM's copy of the room first, so the combat fight replaces the sweep's own.
      await openAt(page, COMBAT_SMALL, 1.3);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await combatScreens(sweep, page, COMBAT_SMALL, 1.3);
      console.log(`480x320-130: measured ${[...sweep.seen].join(", ")}`);
    } finally {
      sweep.tally();
    }
    assert.equal(sweep.lines.length, 0, `${sweep.lines.length} lines out of line at 480x320-130:\n${sweep.lines.join("\n")}`);
  });
}

/** pl3-b14: the scrolling strip. */
export function restScrollsTest(): void {
  test(`pl3-b${SIZE_STEPS + 2}. the scrolling strip at its top and after Scroll for more, at 375 x 667 with a roll card and in 320 x 440 and 320 x 360 windows at 130%, within ${LIMIT_PX} px (docs/design-v1-bar-compact.md 5.4)`, async () => {
    const sweep = new Sweep("rest-scrolls");
    try {
      // No fight, whose turn band would leave these windows too short for the strip.
      if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
      await resetThorn();
      for (const [size, scale, card] of [
        [{ name: "375x667", width: 375, height: 667, touch: true }, 1, true],
        [{ name: "320x440", width: 320, height: 440, touch: true }, 1.3, false],
        [{ name: "320x360", width: 320, height: 360, touch: true }, 1.3, false],
      ] as const) {
        const at = `${size.name}${scale === 1 ? "" : "-130"}`;
        await openAt(pat, size, scale);
        const id = randomUUID();
        if (card) {
          await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.ids.thornChar }] } });
          await pat.getByRole("dialog", { name: "The DM asks for a roll" }).waitFor();
        }
        try {
          // The card stands over the map's middle on this phone, so Thorn stands a few rows up first, where the map takes his tap. The strip's clearing move then clears his label.
          let thornAt = { x: 5, y: 5 };
          if (card) {
            for (const y of [5, 4, 3, 2, 1, 0]) {
              const cell = { x: 5, y };
              if (!(await canvasAt(pat, cell))) continue;
              thornAt = cell;
              break;
            }
            await ops.send({ t: "token.update", tokenId: run.ids.thorn, patch: { x: thornAt.x, y: thornAt.y, elevation: 0 } });
            await waitFor("Thorn clear of the card", () => (dmSocket.state?.tokens[run.ids.thorn]?.y === thornAt.y ? true : null));
            await pat.waitForTimeout(300);
          }
          const strip = await selectToken(pat, "Thorn", thornAt);
          if (!strip) {
            await sweep.missing(pat, `rest-scrolls ${at}`, "a tap on Thorn opened no window");
            continue;
          }
          if ((await strip.getAttribute("data-bar-state")) !== "scrolls") {
            await sweep.missing(pat, `rest-scrolls ${at}`, `the bar is ${await strip.getAttribute("data-bar-mode")} and ${await strip.getAttribute("data-bar-state")}, not a strip that scrolls`);
            continue;
          }
          await sweep.measure(pat, "rest-scrolls", strip);
          await strip.getByRole("button", { name: "Scroll for more", exact: true }).click();
          await pat.waitForTimeout(400);
          await sweep.measure(pat, "rest-scrolls", strip);
          await shots.take(pat, `alignment-rest-scrolls-${at}`);
        } finally {
          await escapeAll(pat);
          if (card) {
            await ops.send({ t: "roll.close", rollIds: [id] });
            await resetThorn();
          }
        }
      }
    } finally {
      sweep.tally();
    }
    assert.equal(sweep.lines.length, 0, `${sweep.lines.length} lines out of line in the scrolling strip:\n${sweep.lines.join("\n")}`);
  });
}

/** The icon pass and follow-up round headers need the same fight in separate rooms. */
export function iconFightTest(): void {
  test("ic2-a. the second icon pass's fight: Thorn at level 7 with a stat block and a counted Hex, Wren a druid with known forms, Exhaustion 2 and Poisoned, the goblin hidden, locked and its name hidden, and the turn timer on", async () => {
    await ic2Start();
    await waitFor("Wren on the DM's copy", () => (dmSocket.state?.tokens[run.ids.wren] ? true : null));
  });
}

/** ic2-b1 to ic2-b7: the second icon pass, in its own fight. */
export function iconPassTests(): void {
  iconFightTest();

  for (const [i, { size, scale }] of IC2_AT.entries()) {
    const at = `ic2-${size.name}-${Math.round(scale * 100)}`;
    test(`ic2-b${i + 1}. at ${size.width} x ${size.height} at ${Math.round(scale * 100)}%: the pass's icons draw no new line, row or cut, within ${LIMIT_PX} px (docs/design-v1-icons-2.md 15)`, async () => {
      const sweep = new Sweep(at);
      const page = await dmPageFor(size);
      page.setDefaultTimeout(10_000);
      await openAt(page, size, scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await ic2Screens(sweep, page, size, scale);
      console.log(`${at}: measured ${[...sweep.seen].join(", ")}`);
      assert.equal(sweep.lines.length, 0, `${sweep.lines.length} lines out of line at ${at}:\n${sweep.lines.join("\n")}`);
    });
  }
}

/** pl3-c, after a file's size steps: the screens that show only at some sizes, at that file's count. */
export function someSizesTest(file: SizesFile): void {
  test("pl3-c. the screens that show only at some sizes showed at as many as the polish pass found, and each trap name's pointer was read", () => {
    const short = Object.entries(SOME_SIZES)
      .filter(([screen, sizes]) => (seenAt.get(screen) ?? 0) < sizes[file])
      .map(([screen, sizes]) => `${screen}: ${seenAt.get(screen) ?? 0} of ${sizes[file]} sizes`);
    assert.deepEqual(short, [], "screens that showed at fewer sizes than the polish pass found");
  });
}

/** pl3-d: no page logged an error, in all the file's steps so far. */
export function noErrorsTest(): void {
  test("pl3-d. no page logged an error", () => {
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    assert.deepEqual(consoles.pat.errors, [], "Pat's page logged errors");
  });
}

/*
 * Follow-up batch 30's roots, run after the second icon pass, whose fight
 * the round header needs: the round header's words clear of its buttons
 * (ICONS2B-OPUS-06), the token window's summary lines (LP21-BAR-3) and
 * the D&D Beyond review (DDBRES-ALIGN).
 */
const FU30_AT: { size: Size; scale: number }[] = [390, 320].flatMap((w) => [1, 1.3].map((scale) => ({ size: SIZES.find((s) => s.width === w)!, scale })));
FU30_AT.push(...[1, 1.3].map((scale) => ({ size: SIZES.find((s) => s.width === 1440)!, scale })));
/** The summary's sizes: FU30_AT's, and live play 21's others, where its lines left a unit alone, touch ones first. */
const SUMMARY_AT: { size: Size; scale: number }[] = [
  ...FU30_AT.filter((at) => at.size.touch),
  ...[1, 1.3].map((scale) => ({ size: { name: "430x932", width: 430, height: 932, touch: true }, scale })),
  ...[1, 1.3].map((scale) => ({ size: { name: "1180x820", width: 1180, height: 820, touch: true }, scale })),
  ...FU30_AT.filter((at) => !at.size.touch),
  { size: IC2_DESK, scale: 1 },
];
const atName = (at: { size: Size; scale: number }) => `${at.size.name}${at.scale === 1 ? "" : `-${Math.round(at.scale * 100)}`}`;

/** fu30-a to fu30-d, in the icon pass's fight, and the app icon's places, appicon-a. */
export function fu30Tests(): void {
  test(`fu30-a. the round header's words and number, and its clock, never sit under Previous or Next, nor are cut, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, and with an overtime turn's clock at 390 x 844 at 130%, within ${LIMIT_PX} px (ICONS2B-OPUS-06, FU30-OPUS-1)`, async () => {
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(atName(at));
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      await openAt(page, at.size, at.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await openTracker(page);
      const header = page.locator("[data-round-header]").first();
      await sweep.add(page, "fu30-round", await roundLines(header, sweep.at));
      await sweep.measure(page, "fu30-round", header.locator(":scope > div").first());
      await shots.take(page, `alignment-fu30-round-${sweep.at}`);
      await closeSheets(page);
      lines.push(...sweep.lines);
    }
    // An overtime turn's clock, wider than "Round N": "Time's up +0:01" is as wide as "Time's up +1:05", since its figures are all one width (FU30-OPUS-1).
    const over = FU30_AT.find((at) => at.size.width === 390 && at.scale === 1.3)!;
    const fight = dmSocket.state!.encounter!;
    const was = fight.activeEntryId!;
    await ops.send({ t: "room.update", settings: { turnTimerSec: 2 } });
    try {
      // A new turn, so its 2 s run out at once.
      await turnTo(fight.entries.find((e) => e.id !== was)!.id);
      const sweep = new Sweep(`${atName(over)}-overtime`);
      const page = await dmPageFor(over.size);
      page.setDefaultTimeout(10_000);
      await openAt(page, over.size, over.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await openTracker(page);
      const header = page.locator("[data-round-header]").first();
      if (!(await showsWithin(header.getByRole("timer", { name: /^Turn time is up, \+\d:\d\d over$/ }), 10_000))) await sweep.missing(page, "fu30-round-overtime", "the turn's clock never ran over");
      await sweep.add(page, "fu30-round-overtime", await roundLines(header, sweep.at));
      await sweep.measure(page, "fu30-round-overtime", header.locator(":scope > div").first());
      await shots.take(page, `alignment-fu30-round-${sweep.at}`);
      await closeSheets(page);
      lines.push(...sweep.lines);
    } finally {
      await ops.send({ t: "room.update", settings: { turnTimerSec: 300 } });
      await turnTo(was);
    }
    assert.deepEqual(lines, [], "the round header out of line");
  });

  test(`fu30-b. the token window's summary lines leave no unit alone: the saves three and three, and Speed, Passive Perception and the sheet link together, for an adult red dragon, a mage, a panther and Thorn as the DM and Pat see him, expanded on phones and in More stats where the bar is short, and beside a sideways phone's sheet with the elevation badge, within ${LIMIT_PX} px (LP21-BAR-3, D-261024-42, FU30-OPUS-3)`, async () => {
    if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
    const made = { dragon: randomUUID(), mage: randomUUID(), panther: randomUUID(), scout: randomUUID() };
    const creatures = [
      { id: made.dragon, name: "Summary Dragon", size: "huge", at: { x: 16, y: 8 }, tap: { x: 17, y: 9 }, actor: srdActor("adult-red-dragon"), saves: true },
      { id: made.mage, name: "Summary Mage", size: "medium", at: { x: 1, y: 9 }, tap: { x: 1, y: 9 }, actor: srdActor("mage"), saves: true },
      // Live play 21's panther: temporary HP and a long speed beside the HP, and no block to give saves.
      { id: made.panther, name: "Panther", size: "medium", at: { x: 11, y: 10 }, tap: { x: 11, y: 10 }, actor: actor({ ac: 13, hp: { cur: 40, max: 40, temp: 6 }, speeds: { walk: 50, climb: 40 }, passivePerception: 15 }), saves: false },
    ];
    // Numbers short enough to leave the sheet link room beside them, but not the elevation badge after it.
    const scout = { name: "Summary Scout", at: { x: 13, y: 10 } };
    const sheetUrl = ddbSheetUrl(DDB_THORN);
    const lines: string[] = [];
    try {
      for (const c of creatures) await ops.send({ t: "token.create", token: { id: c.id, sceneId: run.sceneId, kind: "monster", name: c.name, size: c.size, ...c.at, visibility: "all", disposition: "hostile", actor: { inline: c.actor } } });
      await ops.send({ t: "token.create", token: { id: made.scout, sceneId: run.sceneId, kind: "monster", name: scout.name, size: "medium", ...scout.at, elevation: 10, visibility: "all", disposition: "hostile", actor: { inline: actor({ ac: 9, hp: { cur: 7, max: 7, temp: 0 }, sheetUrl }) } } });
      await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { sheetUrl } } });
      await waitFor("the summary's creatures", () => ([...creatures.map((c) => c.id), made.scout].every((id) => dmSocket.state?.tokens[id]) ? true : null));
      for (const at of SUMMARY_AT) {
        const sweep = new Sweep(atName(at));
        const page = await dmPageFor(at.size);
        page.setDefaultTimeout(10_000);
        await openAt(page, at.size, at.scale);
        await waitFor("the DM's snapshot", () => dmSocket.state);
        // Thorn with his sheet link too, so a mouse window measures one (FU30-OPUS-8).
        for (const c of [...creatures, { name: "Thorn", tap: { x: 5, y: 5 }, saves: false }]) await summaryScreen(sweep, page, c, c.saves || at.size.touch);
        lines.push(...sweep.lines);
      }
      // Thorn's sheet link as his player sees it, after his Speed and Passive Perception.
      for (const at of SUMMARY_AT) {
        const sweep = new Sweep(atName(at));
        pat.setDefaultTimeout(10_000);
        await openAt(pat, at.size, at.scale);
        await summaryScreen(sweep, pat, { name: "Thorn", tap: { x: 5, y: 5 }, saves: false }, at.size.touch);
        lines.push(...sweep.lines);
      }
      // Docked beside a sideways phone's sheet, the window is too narrow for the elevation badge in its header, so the badge ends the vitals line (barDock.ts headerLayout).
      const narrow = { size: { name: "667x375", width: 667, height: 375, touch: true }, scale: 1.3 };
      const sweep = new Sweep(atName(narrow));
      const screen = "window-summary-beside-sheet";
      const page = await dmPageFor(narrow.size);
      await openAt(page, narrow.size, narrow.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await closeSheets(page);
      await escapeAll(page);
      const bar = (await canvasAt(page, scout.at)) ? await selectToken(page, scout.name, scout.at) : null;
      if (!bar) await sweep.missing(page, screen, `${scout.name}'s cell is covered, or a tap on it opened no window`);
      else {
        await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
        await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
        await page.locator('section[aria-label="Outliner"]').waitFor();
        if (!(await showsWithin(bar.locator("[data-vitals]").getByText("↑10 ft", { exact: true }), 5_000))) await sweep.missing(page, screen, "the elevation badge never left the window's header for the vitals line");
        await sweep.measure(page, screen, bar.locator("[data-vitals]"));
        await shots.take(page, `alignment-fu30-${sweep.at}-${screen}`);
        await closeSheets(page);
        await escapeAll(page);
      }
      lines.push(...sweep.lines);
    } finally {
      for (const id of Object.values(made)) await ops.send({ t: "token.delete", tokenId: id }).catch(() => {});
      await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { sheetUrl: null } } }).catch(() => {});
    }
    assert.deepEqual(lines, [], "the summary lines out of line");
  });

  test(`fu30-c. the D&D Beyond review with class resources, 14 read and 12 kept, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, its Class resources group folded and open, within ${LIMIT_PX} px (docs/design-v1-ddb-resources.md 6.3, DDBRES-ALIGN)`, async () => {
    // Thorn linked to D&D Beyond, whose answer Pat's page gets from here: no request leaves the machine.
    await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { sheetUrl: ddbSheetUrl(DDB_THORN) } } });
    await pat.route("**/api/rooms/*/ddb-import", (route) => route.fulfill({ status: 200, json: { fill: readDdbCharacter(ddbThorn()) } }));
    const lines: string[] = [];
    try {
      for (const at of FU30_AT) {
        const sweep = new Sweep(atName(at));
        pat.setDefaultTimeout(10_000);
        await openAt(pat, at.size, at.scale);
        const review = await openThornResync(pat);
        if (!review) {
          await sweep.missing(pat, "fu30-ddb-review", "Thorn's Stat block showed no Re-sync from D&D Beyond");
          lines.push(...sweep.lines);
          continue;
        }
        await review.getByText(/^Read from D&D Beyond: /).waitFor();
        await review.getByText("D&D Beyond has 14 class resources for Thorn, more than the 12 a character holds, so 2 were not read. Class resources here that they would change stay as they are.", { exact: true }).waitFor();
        await sweep.measure(pat, "fu30-ddb-review", review);
        const group = review.getByRole("button", { name: "Class resources", exact: true });
        if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
        await review.getByText("Adds Knack 12: 2 uses, back on a Long Rest", { exact: true }).waitFor();
        await sweep.measure(pat, "fu30-ddb-review-resources", review);
        await shots.take(pat, `alignment-fu30-${sweep.at}-ddb-review`);
        await review.getByRole("button", { name: "Cancel", exact: true }).click();
        await review.waitFor({ state: "detached" });
        await closeSheets(pat);
        await escapeAll(pat);
        lines.push(...sweep.lines);
      }
    } finally {
      await pat.unroute("**/api/rooms/*/ddb-import");
      await ops.send({ t: "character.update", characterId: run.ids.thornChar, patch: { actor: { sheetUrl: null } } });
    }
    assert.deepEqual(lines, [], "the D&D Beyond review out of line");
  });

  test("fu30-d. no page logged an error in follow-up batch 30's steps", () => {
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    assert.deepEqual(consoles.pat.errors, [], "Pat's page logged errors");
  });

  /*
   * The app icon's places (D-261025-16), measured since its look changed
   * from a disc to the iOS app icon shape: Home's header, the docs pages'
   * bar and About's header, at FU30_AT's sizes. Only a room, About with
   * it, takes the interface size, so Home and the docs pages are measured
   * once at each width (APPICON-OPUS-1).
   */
  test(`appicon-a. Home's header and the docs pages' bar at 1440 x 900, 390 x 844 and 320 x 568, and About's header there at 100% and 130%, each icon drawn in the square box its size gives it, within ${LIMIT_PX} px (D-261025-16)`, async () => {
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(atName(at));
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      if (at.scale === 1) {
        await page.setViewportSize({ width: at.size.width, height: at.size.height });
        for (const [screen, path] of [
          ["appicon-home", "/"],
          ["appicon-docs", "/docs"],
          ["appicon-guide", "/docs/dm-guide"],
        ] as const) {
          await page.goto(`${server.origin}${path}`);
          await iconPlace(sweep, page, screen, page.locator(':is(header, div):has(> img[src="/icon.svg"])'));
        }
      }
      await openAt(page, at.size, at.scale);
      const menu = await openMenu(page);
      const about = menu.locator('header:has(> img[src="/icon.svg"])');
      // The Menu may open on About already, as the last size left it.
      if (!(await visible(about))) await menu.getByRole("button", { name: /^About/ }).click();
      await iconPlace(sweep, page, "appicon-about", about);
      await closeSheets(page);
      await escapeAll(page);
      lines.push(...sweep.lines);
    }
    assert.deepEqual(lines, [], "the app icon's places out of line");
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
  });
}

/** The Menu panel: its side panel tab from 900 px up, else its sheet from Panels. */
async function openMenu(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if (await visible(tabs)) {
    await openSideTab(page, "Menu");
    return page.getByRole("tabpanel", { name: sideTabName("Menu") });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
  if (await visible(sheet)) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
  await sheet.waitFor();
  return sheet;
}

/**
 * One of the app icon's places (D-261025-16): its root measured, and its
 * icon drawn in the square box its width and height give it at its
 * layer's zoom, so a change to the icon's art never moves what is beside it.
 */
async function iconPlace(sweep: Sweep, page: Page, screen: string, root: Locator): Promise<void> {
  const icon = root.locator(':scope > img[src="/icon.svg"]').first();
  await icon.waitFor();
  const box = await icon.evaluate(async (el) => {
    const img = el as unknown as { decode(): Promise<void>; getAttribute(name: string): string | null; getBoundingClientRect(): { width: number; height: number }; currentCSSZoom?: number };
    // Rejects when the SVG does not draw.
    await img.decode();
    const rect = img.getBoundingClientRect();
    return { width: rect.width, height: rect.height, want: Number(img.getAttribute("width")) * (img.currentCSSZoom ?? 1) };
  });
  const off = Math.max(Math.abs(box.width - box.want), Math.abs(box.height - box.want));
  await sweep.add(page, screen, off > 0.1 ? [`${sweep.at} ${screen}: the icon's box is ${box.width} x ${box.height}, not ${box.want} square`] : []);
  await sweep.measure(page, screen, root);
  await shots.take(page, `alignment-${sweep.at}-${screen}`);
}

/**
 * The round header's "Round N" and its clock (ICONS2B-OPUS-06,
 * FU30-OPUS-1): each one's words under no button of the header, and
 * whole, so no box that clips them ends first.
 */
async function roundLines(header: Locator, at: string): Promise<string[]> {
  return header.evaluate(
    (h, at) => {
      type R = { left: number; right: number; top: number; bottom: number };
      type El = { textContent: string | null; parentElement: El | null; getAttribute(n: string): string | null; getBoundingClientRect(): R };
      const root = h as unknown as El & { ownerDocument: { createRange(): { selectNodeContents(n: El): void; getBoundingClientRect(): R }; defaultView: { getComputedStyle(e: El): { overflowX: string } } }; querySelectorAll(s: string): ArrayLike<El> };
      const doc = root.ownerDocument;
      const round = Array.from(root.querySelectorAll("span")).find((s) => /^Round \d+$/.test(s.textContent ?? ""));
      if (!round) return [`${at} fu30-round: no "Round N" in the round header`];
      const out: string[] = [];
      for (const part of [round, ...Array.from(root.querySelectorAll('[role="timer"]'))]) {
        const range = doc.createRange();
        range.selectNodeContents(part);
        const words = range.getBoundingClientRect();
        const name = `"${part.textContent}"`;
        for (const button of Array.from(root.querySelectorAll("button"))) {
          const b = button.getBoundingClientRect();
          const across = Math.min(words.right, b.right) - Math.max(words.left, b.left);
          const down = Math.min(words.bottom, b.bottom) - Math.max(words.top, b.top);
          if (across > 0.5 && down > 0.5) out.push(`${at} fu30-round: ${button.getAttribute("aria-label") ?? button.textContent} covers ${across.toFixed(1)} px of ${name}`);
        }
        for (let box: El | null = part.parentElement; box && box !== root; box = box.parentElement) {
          if (doc.defaultView.getComputedStyle(box).overflowX === "visible") continue;
          const r = box.getBoundingClientRect();
          if (words.right > r.right + 0.5 || words.left < r.left - 0.5) out.push(`${at} fu30-round: ${name} is cut, its words from ${words.left.toFixed(1)} to ${words.right.toFixed(1)} in a box from ${r.left.toFixed(1)} to ${r.right.toFixed(1)}`);
        }
      }
      return out;
    },
    at,
  );
}

/**
 * A token window's summary lines in fu30-b: its vitals and its saves,
 * expanded, and with More stats open where the bar is short.
 */
async function summaryScreen(sweep: Sweep, page: Page, c: { name: string; tap: { x: number; y: number }; saves: boolean }, shot: boolean): Promise<void> {
  const screen = `window-summary-${c.name.toLowerCase().replace(/ /g, "-")}`;
  await closeSheets(page);
  await escapeAll(page);
  if (!(await canvasAt(page, c.tap))) return sweep.missing(page, screen, `${c.name}'s cell is covered`);
  const bar = await selectToken(page, c.name, c.tap);
  if (!bar) return sweep.missing(page, screen, `a tap on ${c.name} opened no window`);
  await expandBar(bar);
  // A short bar keeps speed, Passive Perception and the saves in More stats (docs/design-v1-token-panel.md 3.3).
  const more = bar.getByRole("button", { name: "More stats", exact: true });
  if ((await visible(more)) && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
  if (c.saves && !(await showsWithin(bar.locator("[data-saves]").first(), 10_000))) await sweep.missing(page, screen, `${c.name}'s saves never showed`);
  await sweep.measure(page, screen, bar.locator("[data-vitals], [data-saves]"));
  await sweep.add(page, screen, await speedEndLines(bar, `${sweep.at} ${screen}`));
  if (shot) await shots.take(page, `alignment-fu30-${sweep.at}-${screen}`);
  await bar.getByRole("button", { name: "Close", exact: true }).first().click();
  await bar.waitFor({ state: "detached" });
}

/**
 * A speed of several modes in a summary line: its last mode never stands
 * alone on its line where it fits beside Passive Perception or beside the
 * mode before it (FU30-NOTED). The speed is one picture to measureAlignment,
 * so its modes are read here.
 */
async function speedEndLines(bar: Locator, at: string): Promise<string[]> {
  return bar.locator("[data-vitals]").evaluateAll(
    (lines, at) => {
      type R = { left: number; right: number; top: number; bottom: number; width: number };
      type El = { textContent: string | null; offsetWidth: number; getBoundingClientRect(): R; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };
      const out: string[] = [];
      for (const line of lines as unknown as El[]) {
        const modes = Array.from(line.querySelectorAll('[data-unit="speed"]'));
        if (modes.length < 2) continue;
        const pp = line.querySelector('[role="img"][aria-label^="Passive Perception"]');
        const last = modes[modes.length - 1]!.getBoundingClientRect();
        const before = modes[modes.length - 2]!.getBoundingClientRect();
        const mid = (r: R) => (r.top + r.bottom) / 2;
        const box = line.getBoundingClientRect();
        // The page's pixels per layout pixel, so the gaps compare with the boxes at 130% too: 4 px between modes, 12 between units.
        const zoom = box.width / line.offsetWidth;
        const beside = [before, ...(pp ? [pp.getBoundingClientRect()] : [])].some((r) => Math.abs(mid(r) - mid(last)) < 2);
        const fits = last.width + 4 * zoom + before.width <= box.width + 0.5 || (pp !== null && last.width + 12 * zoom + pp.getBoundingClientRect().width <= box.width + 0.5);
        if (!beside && fits) out.push(`${at}: "${(modes[modes.length - 1]!.textContent ?? "").trim()}" stands alone on its line in ${box.width.toFixed(1)} px, where it fits beside the mode before it or PP`);
        // Modes that share a line stand 4 px apart, the last too, though it stands in the tail beside PP (FU31-SUMMARY-GAP).
        for (let i = 1; i < modes.length; i++) {
          const a = modes[i - 1]!.getBoundingClientRect();
          const b = modes[i]!.getBoundingClientRect();
          if (Math.abs(mid(a) - mid(b)) >= 2) continue;
          const gap = b.left - a.right;
          if (Math.abs(gap - 4 * zoom) > 1) out.push(`${at}: "${(modes[i]!.textContent ?? "").trim()}" stands ${gap.toFixed(1)} px from the mode before it, not ${(4 * zoom).toFixed(1)}`);
        }
      }
      return out;
    },
    at,
  );
}

/** Thorn's D&D Beyond number in fu30-c. */
const DDB_THORN = "12345678";

/**
 * Thorn as D&D Beyond would send him, in its JSON shape with only the
 * paths the reader reads (shared/ddb/read.ts): a Barbarian 7 with the
 * sweep's scores and 14 limited uses, two past the 12 a character holds,
 * so the review shows its cut warning and folds its Class resources group.
 */
function ddbThorn(): Record<string, unknown> {
  const proficiency = (subType: string) => ({ type: "proficiency", subType, fixedValue: null, value: null });
  const knack = (i: number) => ({
    name: `Knack ${i + 1}`,
    componentTypeId: 1088085227,
    componentId: 9000 + i,
    limitedUse: { name: null, statModifierUsesId: null, resetType: 2, numberUsed: 0, minNumberConsumed: 1, maxNumberConsumed: 1, maxUses: 2, operator: 1, useProficiencyBonus: false, proficiencyBonusOperator: 1, resetDice: null },
  });
  return {
    success: true,
    data: {
      id: Number(DDB_THORN),
      name: "Thorn",
      stats: [16, 12, 14, 10, 12, 10].map((value, i) => ({ id: i + 1, value })),
      bonusStats: [],
      overrideStats: [],
      baseHitPoints: 60,
      race: { weightSpeeds: { normal: { walk: 30 } } },
      classes: [{ level: 7, definition: { name: "Barbarian", spellCastingAbilityId: null }, classFeatures: [] }],
      modifiers: { race: [], class: [proficiency("strength-saving-throws"), proficiency("constitution-saving-throws")], background: [proficiency("athletics")], feat: [], item: [], condition: [] },
      inventory: [],
      classSpells: [],
      spells: { race: [], class: [], item: [], feat: [] },
      actions: { race: [], class: [], feat: Array.from({ length: 14 }, (_, i) => knack(i)) },
    },
  };
}

/**
 * The review Re-sync from D&D Beyond opens on Thorn's Stat block, Pat's
 * to open: from 900 px the Token tab beside a tap on him, below it the
 * Token sheet his bar's Stat block opens. Null where the Stat block shows
 * no Re-sync.
 */
async function openThornResync(page: Page): Promise<Locator | null> {
  await closeSheets(page);
  await escapeAll(page);
  const wide = (page.viewportSize()?.width ?? 0) / Number(await page.evaluate(() => localStorage.getItem("rvtt.uiScale") ?? "1")) >= 900;
  const bar = await selectToken(page, "Thorn", { x: 5, y: 5 });
  if (!bar) return null;
  if (wide) await openSideTab(page, "Token");
  else await (await barControl(bar, "Stat block")).click();
  const panel = wide ? page.getByRole("tabpanel", { name: sideTabName("Token") }) : page.getByRole("region", { name: "Token", exact: true });
  const resync = panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true });
  if (!(await showsWithin(resync, 3_000))) {
    // The Stat block group as this device last left it, folded.
    await panel.getByRole("button", { name: /^Stat block/ }).first().click();
    if (!(await showsWithin(resync, 5_000))) return null;
  }
  await resync.scrollIntoViewIfNeeded();
  await resync.click();
  const review = page.getByRole("dialog", { name: "Check what changes" });
  await review.waitFor();
  return review;
}

/** Where fu32-a's companion of Thorn stands, and its Fireball's middle, clear of the room's other tokens. */
const HOUND_AT = { x: 18, y: 1 };
const FIREBALL_AT = { x: 18, y: 12 };

/**
 * A fixed FieldRow's screen (components/Field.tsx, `fixed`), by its
 * label's words: the part the row sits in, measured with the rows beside
 * it, and the row's control whole inside the row on one line, since a
 * fixed control neither shrinks nor wraps to fit.
 */
async function fixedRowScreen(sweep: Sweep, page: Page, screen: string, scope: Locator, label: string): Promise<void> {
  const row = scope.locator(`xpath=.//label[normalize-space()="${label}"]/..`).first();
  await row.scrollIntoViewIfNeeded();
  await sweep.measure(page, screen, row.locator("xpath=.."));
  const off = await row.evaluate((el) => {
    type R = { left: number; right: number; top: number; bottom: number };
    type E = { getBoundingClientRect(): R; querySelector(s: string): E | null; querySelectorAll(s: string): ArrayLike<E>; nextElementSibling: E | null };
    const box = (el as unknown as E).getBoundingClientRect();
    const cell = (el as unknown as E).querySelector(":scope > label")?.nextElementSibling;
    if (!cell) return ["it has no control after its label"];
    const c = cell.getBoundingClientRect();
    const out: string[] = [];
    if (c.left < box.left - 0.5 || c.right > box.right + 0.5) out.push(`its control (${c.left.toFixed(1)} to ${c.right.toFixed(1)} px) runs out of its row (${box.left.toFixed(1)} to ${box.right.toFixed(1)} px)`);
    // One line: every part starts above where every part ends.
    const parts = Array.from(cell.querySelectorAll("button, input:not([type=radio]), .rvtt-choice")).map((p) => p.getBoundingClientRect());
    if (parts.length === 0) out.push("its control has no parts");
    else if (Math.max(...parts.map((p) => p.top)) >= Math.min(...parts.map((p) => p.bottom))) out.push("its control wraps onto more than one line");
    return out;
  });
  await sweep.add(page, screen, off.map((l) => `${sweep.at} ${screen}: ${label}: ${l}`));
  await shots.take(page, `alignment-fu32-${sweep.at}-${screen.replace(/^fu32-/, "")}`);
}

/** A panel's group by the name on its fold, unfolded. */
async function openedGroup(panel: Locator, name: string): Promise<Locator> {
  const fold = panel.getByRole("button", { name, exact: true });
  await fold.first().waitFor();
  if ((await fold.first().getAttribute("aria-expanded")) === "false") await fold.first().click();
  await waitFor(`${name} open`, async () => ((await fold.first().getAttribute("aria-expanded")) === "true" ? true : null), 3_000);
  // A filter's inner locator is read inside each group, so it starts from the page, not the panel.
  return panel.locator("[data-panel-group]").filter({ has: panel.page().getByRole("button", { name, exact: true }) });
}

/** fu32-a's screens at one size: each short label beside its Stepper or choices, and the part around it. */
async function stepperRowScreens(sweep: Sweep, page: Page, fireball: string): Promise<void> {
  // The Monsters panel's place card: How many.
  await closeSheets(page);
  await escapeAll(page);
  const monsters = await openPanel(page, "Monsters");
  await monsters.getByRole("searchbox", { name: "Search monsters" }).fill("goblin");
  await monsters.getByRole("button", { name: /^Goblin/ }).first().click();
  await monsters.getByRole("button", { name: "How many plus 1", exact: true }).waitFor();
  await fixedRowScreen(sweep, page, "fu32-how-many", monsters, "How many");
  const back = monsters.getByRole("button", { name: "Back to Monsters", exact: true });
  if (await visible(back)) await back.click();

  // An area's group save, from a Fireball Thorn cast: Slot level, in the outcome's fields.
  await closeSheets(page);
  await escapeAll(page);
  const areas = await openPanel(page, "Areas");
  await areas.locator(`[data-opener="area-${fireball}"]`).click();
  if (!(await showsWithin(areas.getByRole("button", { name: "Slot level plus 1", exact: true }), 4_000))) await sweep.missing(page, "fu32-slot-level", "Save and damage opened no page with a Slot level");
  else await fixedRowScreen(sweep, page, "fu32-slot-level", areas, "Slot level");
  const discard = areas.getByRole("button", { name: "Discard", exact: true });
  if (await visible(discard)) await discard.first().click();

  // A character's Add a companion form: It is.
  await closeSheets(page);
  await escapeAll(page);
  const thorn = await thornsPage(page);
  await (await openedGroup(thorn, "Companions")).getByRole("button", { name: "Add a companion", exact: true }).click();
  await thorn.getByRole("radiogroup", { name: "What it is" }).waitFor();
  await fixedRowScreen(sweep, page, "fu32-it-is-form", thorn, "It is");
  await thorn.getByRole("button", { name: "Cancel", exact: true }).click();

  // A companion token's Companion group: It is.
  const panel = await ic2TokenPanel(page, "Hound", "Hound", HOUND_AT);
  if (!panel) await sweep.missing(page, "fu32-it-is-token", "a tap on the hound opened no window");
  else {
    const group = await openedGroup(panel, "Companion");
    await group.getByRole("radiogroup", { name: "What it is" }).waitFor();
    await fixedRowScreen(sweep, page, "fu32-it-is-token", group, "It is");
  }
  await closeSheets(page);
  await escapeAll(page);
}

/**
 * The builder's mode picker as the browser lays it out (D-261026-3): each
 * tile's box, whether its name runs out of it, how many lines it takes for
 * how many words (a slash counted as a break), and its icon's middle
 * against the tile's. A line for each tile whose name is cut or breaks
 * inside a word, that runs out of the picker, or whose icon stands more
 * than 1 px off its tile's middle, and for tiles that are not all one
 * width and one height.
 */
async function modeTileLines(tiles: Locator, at: string): Promise<string[]> {
  return tiles.evaluate((group, at) => {
    type R = { left: number; right: number; top: number; bottom: number; width: number; height: number };
    type E = {
      textContent: string | null;
      scrollWidth: number;
      clientWidth: number;
      parentElement: E | null;
      getBoundingClientRect(): R;
      querySelector(s: string): E | null;
      querySelectorAll(s: string): ArrayLike<E>;
      ownerDocument: { createRange(): { selectNodeContents(n: E): void; getClientRects(): ArrayLike<R> }; defaultView: { innerWidth: number; getComputedStyle(e: E): { overflowX: string } } };
    };
    const out: string[] = [];
    const root = group as unknown as E;
    const tiles = Array.from(root.querySelectorAll("label.rvtt-choice"));
    // The box that cuts the picker off at its sides: its first ancestor that clips, else the window.
    let clip: { left: number; right: number } = { left: 0, right: root.ownerDocument.defaultView.innerWidth };
    for (let up = root.parentElement; up; up = up.parentElement) {
      if (root.ownerDocument.defaultView.getComputedStyle(up).overflowX === "visible") continue;
      const r = up.getBoundingClientRect();
      clip = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right) };
      break;
    }
    const widths: number[] = [];
    const heights: number[] = [];
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      widths.push(box.width);
      heights.push(box.height);
      const words = tile.querySelector(":scope > span:last-child")!;
      const icon = tile.querySelector("svg");
      const name = (words.textContent ?? "").trim();
      if (words.scrollWidth > words.clientWidth + 1) out.push(`${at}: "${name}" runs out of its tile`);
      if (box.left < clip.left - 1 || box.right > clip.right + 1) out.push(`${at}: "${name}"'s tile runs ${Math.max(clip.left - box.left, box.right - clip.right).toFixed(1)} px out of the picker`);
      const range = tile.ownerDocument.createRange();
      range.selectNodeContents(words);
      const lines = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
      // A slash is a place to break, as between two words: an even grid lets "Heights/" stand over "stairs".
      if (lines > name.split(/\s+|(?<=\/)/).length) out.push(`${at}: "${name}" breaks inside a word, on ${lines} lines`);
      if (!icon) out.push(`${at}: "${name}" has no icon`);
      else {
        const i = icon.getBoundingClientRect();
        const off = Math.abs((i.left + i.right) / 2 - (box.left + box.right) / 2);
        if (off > 1) out.push(`${at}: "${name}"'s icon stands ${off.toFixed(1)} px off its tile's middle`);
      }
    }
    const spread = (ns: number[]): number => Math.max(...ns) - Math.min(...ns);
    if (spread(widths) > 1) out.push(`${at}: the tiles differ in width by ${spread(widths).toFixed(1)} px`);
    if (spread(heights) > 1) out.push(`${at}: the tiles differ in height by ${spread(heights).toFixed(1)} px`);
    return out;
  }, at);
}

/** The builder's Brush size stepper, in its row or in ⋯ where the row has no room for it. */
async function brushStepper(page: Page): Promise<Locator> {
  const bar = page.getByRole("toolbar", { name: "Map builder options" });
  const inRow = bar.getByRole("group", { name: "Brush size", exact: true });
  if (await showsWithin(inRow, 1_500)) return inRow;
  await bar.getByRole("button", { name: "More options" }).click();
  return page.getByRole("dialog", { name: "More Map builder options" }).getByRole("group", { name: "Brush size", exact: true });
}

/** fu32-b's screens at one size: the builder's row with its mode chip, the mode picker's tiles, and Brush size from 1 to 10 squares. */
async function builderScreens(sweep: Sweep, page: Page): Promise<void> {
  await closeSheets(page);
  await escapeAll(page);
  await pickTool(page, "Map builder");
  const bar = page.getByRole("toolbar", { name: "Map builder options" });
  await bar.waitFor();
  await page.locator('[data-options-line="shown"]').first().waitFor();
  await pickOption(page, "Map builder", "Builder mode", "Brush");
  const chip = bar.getByRole("button", { name: /^Builder mode: Brush/ });
  await chip.waitFor();
  // By the chips' glyph rule (docs/design-v1-tool-options.md 6.2) the icon is the first thing to give way in a short row, so only the wide window's row must show it.
  const iconed = (await chip.locator("svg").count()) >= 2;
  if (!iconed && sweep.at.startsWith("1440x900")) await sweep.missing(page, "fu32-builder-row", "the mode chip shows no icon beside its caret");
  await sweep.measure(page, "fu32-builder-row", bar);
  await chip.click();
  const picker = page.getByRole("dialog", { name: "Builder mode" });
  await picker.waitFor();
  const tiles = picker.getByRole("radiogroup", { name: "Builder mode" });
  await sweep.measure(page, "fu32-mode-picker", tiles);
  await sweep.add(page, "fu32-mode-picker", await modeTileLines(tiles, `${sweep.at} fu32-mode-picker`));
  await shots.take(page, `alignment-fu32-${sweep.at}-mode-picker`);
  await escapeAll(page);
  // Brush size: Smaller off at 1, Larger off at 10, and named with its size in squares.
  const stepper = await brushStepper(page);
  const smaller = () => stepper.getByRole("button", { name: "Smaller brush", exact: true });
  const larger = () => stepper.getByRole("button", { name: "Larger brush", exact: true });
  if (!(await smaller().isDisabled())) sweep.lines.push(`${sweep.at} fu32-brush: Smaller brush is not off at 1 square`);
  await stepper.getByText("1 square", { exact: true }).filter({ visible: true }).first().waitFor();
  for (let n = 2; n <= 10; n++) await larger().click();
  await stepper.getByText("10 squares", { exact: true }).filter({ visible: true }).first().waitFor();
  if (!(await larger().isDisabled())) sweep.lines.push(`${sweep.at} fu32-brush: Larger brush is not off at 10 squares`);
  // Spoken in the group's name as it changes: "Brush size, 10 squares".
  if ((await stepper.locator('[aria-live="polite"]', { hasText: "10 squares" }).count()) === 0) sweep.lines.push(`${sweep.at} fu32-brush: the size is not spoken as it changes`);
  await sweep.measure(page, "fu32-brush", stepper);
  await shots.take(page, `alignment-fu32-${sweep.at}-brush`);
  for (let n = 9; n >= 1; n--) await smaller().click();
  await stepper.getByText("1 square", { exact: true }).filter({ visible: true }).first().waitFor();
  await escapeAll(page);
  await pickTool(page, "Select");
}

/** Follow-up batch 32's roots, which the sizes' sweep never reaches. */
export function fu32Tests(): void {
  test(`fu32-a. a short label stands beside its Stepper or choices wherever both fit: the Monsters place card's How many, an area's group save's Slot level, and a companion's It is in Add a companion and its token's Companion group, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (FU31-STEPPER-ROWS)`, async () => {
    if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
    const hound = randomUUID();
    const fireball = randomUUID();
    const lines: string[] = [];
    try {
      await ops.send({ t: "token.create", token: { id: hound, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Hound", ...HOUND_AT, disposition: "ally", ownerIds: [run.patId], companion: { of: run.ids.thornChar, turn: "shared" }, actor: { inline: actor({ srdId: "mastiff" }) } } });
      const dmId = await waitFor("the DM's member id", () => dmSocket.you?.memberId ?? null);
      await ops.send({ t: "template.create", template: { id: fireball, sceneId: run.sceneId, shape: "sphere", size: 20, origin: { ...FIREBALL_AT, z: 0 }, yaw: 0, includeOrigin: false, color: "#e5484d", spell: "Fireball", casterId: run.ids.thorn, ownerId: dmId, visibility: "all" } });
      await waitFor("the hound and the Fireball", () => (dmSocket.state?.tokens[hound] && dmSocket.state.templates[fireball] ? true : null));
      for (const at of FU30_AT) {
        const sweep = new Sweep(atName(at));
        const page = await dmPageFor(at.size);
        page.setDefaultTimeout(10_000);
        await openAt(page, at.size, at.scale);
        await waitFor("the DM's snapshot", () => dmSocket.state);
        await stepperRowScreens(sweep, page, fireball);
        lines.push(...sweep.lines);
      }
    } finally {
      await ops.send({ t: "template.delete", templateId: fireball }).catch(() => {});
      await ops.send({ t: "token.delete", tokenId: hound }).catch(() => {});
    }
    assert.deepEqual(lines, [], "a short label's row out of line");
  });

  test(`fu32-b. the Map builder's row, its mode picker's tiles with an icon on each, even and none of their names cut, and Brush size from 1 to 10 squares, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (D-261026-3, D-261026-4)`, async () => {
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(atName(at));
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      await openAt(page, at.size, at.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await builderScreens(sweep, page);
      lines.push(...sweep.lines);
    }
    assert.deepEqual(lines, [], "the builder's row, picker or brush out of line");
  });
}

/*
 * This device's Sheet handle (docs/design-v1-sheet-swipe.md 4.8): the
 * Menu's This device row, whose detail names it among the page's settings,
 * and the section with its help, the select and the preview under it, at
 * FU30_AT's sizes. Neither was in a sweep before (GRAB-ALIGN).
 */
export function grabberTests(): void {
  test(`grab-e. the Menu's This device row, its detail whole with no word alone on its last line, and This device's Sheet handle section, its help, select and preview, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (docs/design-v1-sheet-swipe.md 4.8)`, async () => {
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(atName(at));
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      await openAt(page, at.size, at.scale);
      const menu = await openMenu(page);
      const choice = menu.getByRole("combobox", { name: "Sheet handle" });
      // The Menu may open on another of its pages, as the last step left it.
      const back = menu.getByRole("button", { name: /^Back to Menu/ });
      if (await visible(back)) await back.click();
      const row = menu.getByRole("button", { name: /^This device/ });
      await row.scrollIntoViewIfNeeded();
      await sweep.measure(page, "grab-menu-row", row);
      const detail = await detailLines(row, "handle.");
      if (!detail.found) sweep.lines.push(`${sweep.at} grab-menu-row: the detail does not end "sheet handle."`);
      if (detail.cut) sweep.lines.push(`${sweep.at} grab-menu-row: the detail is cut (${detail.cut})`);
      if (detail.alone) sweep.lines.push(`${sweep.at} grab-menu-row: "${detail.alone}" stands alone on the detail's last line of ${detail.lines}`);
      await shots.take(page, `alignment-grab-${sweep.at}-menu-row`);
      await row.click();
      await choice.scrollIntoViewIfNeeded();
      // The innermost section holding its heading: the panel around it is a section too.
      await sweep.measure(page, "grab-sheet-handle", menu.locator("section").filter({ has: page.getByRole("heading", { name: "Sheet handle", exact: true }) }).last());
      await shots.take(page, `alignment-grab-${sweep.at}-sheet-handle`);
      if (await visible(back)) await back.click();
      await closeSheets(page);
      await escapeAll(page);
      lines.push(...sweep.lines);
    }
    assert.deepEqual(lines, [], "the This device row or the Sheet handle section out of line");
  });
}

/** The scene settings page's groups in order (client/features/scenes/settingsFolds.ts). */
const SCENE_GROUP_NAMES = ["What players see", "Map image and grid", "Walls and movement", "Size and view"] as const;

/** The crypt of ms2-a: a map scene with a Day and a Night phase, made once for the run. */
let cryptId: string | null = null;

async function cryptScene(): Promise<string> {
  if (cryptId) return cryptId;
  const upload = async (rgb: [number, number, number]) => {
    const data = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
    const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
    assert.ok(res.ok(), `the upload answered ${res.status()}`);
    return (await res.json()) as { id: string; width: number; height: number };
  };
  const day = await upload([90, 80, 70]);
  const night = await upload([30, 34, 60]);
  const id = randomUUID();
  await ops.send({ t: "scene.create", scene: { id, name: "Crypt", bounds: { w: 10, h: 8 }, background: "#2b2b31", fogEnabled: true, autoWalls: "floor", blockMovement: true, vision: { on: false, light: "bright" } } });
  await ops.send({ t: "scene.setMap", sceneId: id, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: 50, originPx: { x: 0, y: 0 } } });
  await ops.send({
    t: "scene.update",
    sceneId: id,
    patch: {
      phases: [
        { id: randomUUID(), name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
        { id: randomUUID(), name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height, light: "dark" },
      ],
    },
  });
  cryptId = id;
  return id;
}

/** The crypt on hex rows (docs/design-v1-hex-grids.md section 8): its Grid shape, its Size row's hexes and its map's grid row on hexes. */
let hexCryptId: string | null = null;

async function hexCryptScene(crypt: string): Promise<string> {
  if (hexCryptId) return hexCryptId;
  const id = randomUUID();
  await ops.send({ t: "scene.duplicate", sceneId: crypt, newSceneId: id, name: "Hex crypt", include: { creatures: false, characters: false, fog: false, drawings: false } });
  await ops.send({ t: "scene.update", sceneId: id, patch: { gridShape: "hexRows" } });
  hexCryptId = id;
  return id;
}

/** Shows the DM a scene from its row in the Scenes panel, and waits for its settings. */
async function viewScene(panel: Locator, sceneId: string): Promise<void> {
  const name = dmSocket.state?.scenes[sceneId]?.name ?? "";
  await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
  await waitFor(`the DM on ${name}`, () => dmSocket.you?.sceneId === sceneId || null);
  const field = panel.getByRole("textbox", { name: "Scene name" }).last();
  await waitFor(`${name}'s settings`, async () => ((await field.inputValue()) === name ? true : null));
}

/*
 * ms2-a: the scene settings page (docs/design-v1-map-discovery.md 8.4 and
 * 9), and every other page that shows the shared radio cards
 * (components/RadioCards.tsx), at FU30_AT's sizes. The page on
 * the players' scene as it opens, which starts the groups as 8.4 says,
 * with every group folded and with every group open, its map image's
 * question asked, then a map scene with two phases, one in edit. Then Room
 * settings whole, This device's Map detail and the DM panel's Show a
 * handout. Each size starts from no stored folds, as a device that never
 * folded a group.
 */
export function sceneSettingsTests(): void {
  test(`ms2-a. the scene settings page as it opens, every group folded and every group open, the map image's question, a map scene's phases with one in edit, Room settings, This device's Map detail and Show a handout, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (docs/design-v1-map-discovery.md 8.4 and 9)`, async () => {
    await newDmSession();
    const crypt = await cryptScene();
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(`ms2-${atName(at)}`);
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      const forget = () => page.evaluate(() => localStorage.removeItem("rvtt.sceneSettingsFolds"));
      if (page.url().startsWith(server.origin)) await forget();
      await openAt(page, at.size, at.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      try {
        const panel = await openDmPanel(page, "Scenes");
        const name = panel.getByRole("textbox", { name: "Scene name" }).last();
        await name.waitFor();
        // What players see opens everywhere, the rest only from 900 px of layout, which 1440 at 130% still is.
        const wide = at.size.width / at.scale >= 900;
        for (const [i, group] of SCENE_GROUP_NAMES.entries()) {
          const open = (await sceneGroupFold(panel, group).getAttribute("aria-expanded")) === "true";
          if (open !== (i === 0 || wide)) sweep.lines.push(`${sweep.at} scene-settings: ${group} starts ${open ? "open" : "folded"}`);
        }
        await name.scrollIntoViewIfNeeded();
        await sweep.measure(page, "scene-settings", panel);
        await shots.take(page, `alignment-${sweep.at}-scene-settings`);
        for (const group of SCENE_GROUP_NAMES) {
          const fold = sceneGroupFold(panel, group);
          if ((await fold.getAttribute("aria-expanded")) === "true") await fold.click();
        }
        await sweep.measure(page, "scene-settings-folded", panel);
        // Each folded group's header with its summary, on the name's line or under it (docs/design-v1-design-pass.md 4.1).
        await sweep.measure(page, "scene-groups-folded", panel.locator("[data-panel-group] > div:first-child"));
        await shots.take(page, `alignment-${sweep.at}-scene-settings-folded`);
        for (const group of SCENE_GROUP_NAMES) await openSceneGroup(panel, group);
        await sweep.measure(page, "scene-settings-open", panel);
        // The players are on this scene, so its map image asks first, with the first map's fog choice.
        const map = sceneGroup(panel, "Map image and grid");
        await map.getByRole("button", { name: "Add a map image" }).click();
        await map.getByText(/^The players are on this scene\./).waitFor();
        await map.scrollIntoViewIfNeeded();
        await sweep.measure(page, "scene-map-image-ask", map);
        await shots.take(page, `alignment-${sweep.at}-map-image-ask`);
        await map.getByRole("button", { name: "Cancel", exact: true }).click();
        // A map scene: its image, phases, grid and counts, then a phase in edit.
        await viewScene(panel, crypt);
        await sweep.measure(page, "scene-settings-map", panel);
        await map.getByRole("button", { name: "Edit Night" }).click();
        await map.getByRole("textbox", { name: "Phase name" }).scrollIntoViewIfNeeded();
        await sweep.measure(page, "scene-map-phase-edit", map);
        await shots.take(page, `alignment-${sweep.at}-map-phase-edit`);
        await map.getByRole("button", { name: "Done", exact: true }).click();
        await viewScene(panel, run.sceneId);
        await closeSheets(page);

        // The shared radio cards: Room settings whole, then This device's Map detail.
        const menu = await openMenu(page);
        // The page's header holds Back to Menu, outside a side panel's tab panel.
        const back = page.getByRole("button", { name: /^Back to Menu/ });
        if (await visible(back)) await back.click();
        await menu.getByRole("button", { name: /^Room settings/ }).click();
        await menu.getByRole("group", { name: "Critical Hit damage" }).waitFor();
        await sweep.measure(page, "room-settings", menu);
        await back.click();
        await menu.getByRole("button", { name: /^This device/ }).click();
        const detail = menu.locator("section").filter({ has: page.getByRole("heading", { name: "Map detail", exact: true }) }).last();
        await detail.scrollIntoViewIfNeeded();
        await sweep.measure(page, "this-device-map-detail", detail);
        await back.click();
        await closeSheets(page);
        // The DM panel's handout form, whose Show to is the same cards.
        const dmPanel = await openDmPanel(page, "DM");
        const handout = dmPanel.getByRole("group", { name: "Show a handout" });
        if (!(await visible(handout))) await dmPanel.getByRole("button", { name: "Show a handout" }).click();
        await handout.getByRole("group", { name: "Show to" }).scrollIntoViewIfNeeded();
        await sweep.measure(page, "show-a-handout", handout);
        await shots.take(page, `alignment-${sweep.at}-show-a-handout`);
        await handout.getByRole("button", { name: "Cancel", exact: true }).click();
        await closeSheets(page);
        // The Universal VTT import, whose Players see is the same cards, from a file written as maps.e2e.ts writes one: its open window is a portal that lets light through, so both of the dialog's named choices show.
        const keep = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 150, g: 140, b: 120 } } }).png().toBuffer();
        const portal = (a: { x: number; y: number }, b: { x: number; y: number }, closed: boolean) => ({ position: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, bounds: [a, b], rotation: 0, closed, freestanding: false });
        const uvtt = {
          format: 0.3,
          resolution: { map_origin: { x: 0.5, y: 0.5 }, map_size: { x: 10, y: 8 }, pixels_per_grid: 50 },
          line_of_sight: [[{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 7 }, { x: 1, y: 7 }, { x: 1, y: 1 }]],
          objects_line_of_sight: [],
          portals: [portal({ x: 4, y: 1 }, { x: 5, y: 1 }, true), portal({ x: 6, y: 7 }, { x: 7, y: 7 }, false)],
          environment: { baked_lighting: true, ambient_light: "ffffffff" },
          lights: [{ position: { x: 5.5, y: 4.5 }, range: 4, intensity: 1, color: "ffeccd8b", shadows: true }],
          image: keep.toString("base64"),
        };
        const scenes = await openDmPanel(page, "Scenes");
        await scenes.getByLabel("From a Universal VTT file", { exact: true }).setInputFiles({ name: "Sunken_keep.dd2vtt", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(uvtt)) });
        const importer = page.getByRole("dialog", { name: "Import a Universal VTT map" });
        await importer.getByRole("radiogroup", { name: "Players see", exact: true }).waitFor({ timeout: 30_000 });
        await importer.getByText("Portals that don't block light import as", { exact: true }).waitFor();
        await sweep.measure(page, "uvtt-import", importer);
        await shots.take(page, `alignment-${sweep.at}-uvtt-import`);
        await page.keyboard.press("Escape");
        await importer.waitFor({ state: "detached" });
        await closeSheets(page);
        // The table display's pairing page, in a page of its own at this size. It takes no interface size, so 130% draws as 100%.
        const tv = await page.context().newPage();
        try {
          await tv.setViewportSize({ width: at.size.width, height: at.size.height });
          await tv.goto(`${server.origin}/display`);
          const pairing = tv.locator("section").filter({ has: tv.getByLabel("Code from the DM's screen", { exact: true }) });
          await pairing.waitFor();
          await sweep.measure(tv, "display-pair", pairing);
          await shots.take(tv, `alignment-${sweep.at}-display-pair`);
        } finally {
          await tv.close();
        }
      } finally {
        // The page's own scene goes with it: the next size opens the room anew on the players' scene.
        await forget();
        await escapeAll(page);
      }
      console.log(`${sweep.at}: measured ${[...sweep.seen].join(", ")}`);
      lines.push(...sweep.lines);
    }
    assert.deepEqual(lines, [], "the scene settings page or the radio cards out of line");
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    withinSnapshotBudget("ms2-a");
  });

  /*
   * hx4-a: a hex scene's settings (docs/design-v1-hex-grids.md section 8),
   * the crypt's map on hex rows, every group open: Grid shape, the Size row
   * in feet steps with the hexes it holds, and Find the grid and counting
   * off with their reasons. Then Room settings, which name squares or hexes
   * once the room holds a hex scene. A session of its own, since ms2-a's
   * scene switches fill one session's snapshot budget.
   */
  test(`hx4-a. a hex scene's settings, every group open, and Room settings in a room with hexes, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (docs/design-v1-hex-grids.md section 8)`, async () => {
    await newDmSession();
    const hexCrypt = await hexCryptScene(await cryptScene());
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(`hx4-${atName(at)}`);
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      await openAt(page, at.size, at.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      try {
        const panel = await openDmPanel(page, "Scenes");
        await viewScene(panel, hexCrypt);
        for (const group of SCENE_GROUP_NAMES) await openSceneGroup(panel, group);
        const map = sceneGroup(panel, "Map image and grid");
        await map.getByRole("radiogroup", { name: "Grid shape", exact: true }).scrollIntoViewIfNeeded();
        await sweep.measure(page, "scene-settings-hex", map);
        await sweep.measure(page, "scene-size-hex", sceneGroup(panel, "Size and view"));
        await shots.take(page, `alignment-${sweep.at}-scene-settings-hex`);
        await closeSheets(page);
        const menu = await openMenu(page);
        const back = page.getByRole("button", { name: /^Back to Menu/ });
        if (await visible(back)) await back.click();
        await menu.getByRole("button", { name: /^Room settings/ }).click();
        await menu.getByText("Feet per square or hex", { exact: true }).waitFor();
        await sweep.measure(page, "room-settings-hex", menu);
        await back.click();
        await closeSheets(page);
      } finally {
        await page.evaluate(() => localStorage.removeItem("rvtt.sceneSettingsFolds"));
        await escapeAll(page);
      }
      console.log(`${sweep.at}: measured ${[...sweep.seen].join(", ")}`);
      lines.push(...sweep.lines);
    }
    // Later sweeps start on the players' scene.
    const page = await dmPageFor(FU30_AT.at(-1)!.size);
    await viewScene(await openDmPanel(page, "Scenes"), run.sceneId);
    await escapeAll(page);
    assert.deepEqual(lines, [], "a hex scene's settings or Room settings out of line");
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    withinSnapshotBudget("hx4-a");
  });
}

/**
 * A row's detail line as drawn: how many lines it wraps onto, whether its
 * box cuts its words, and its last word when that stands alone on the last
 * line though the line above has others. A no-break space joins two words
 * into one that wraps whole, so it counts as words that share the line.
 */
async function detailLines(row: Locator, ending: string): Promise<{ found: boolean; lines: number; cut: string; alone: string }> {
  return row.evaluate((el, end) => {
    type Rect = { left: number; top: number; width: number };
    type TextNode = { textContent: string | null; parentElement: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; parentElement: unknown } | null };
    type R = { setStart(n: TextNode, o: number): void; setEnd(n: TextNode, o: number): void; getClientRects(): ArrayLike<Rect> };
    const doc = (globalThis as unknown as { document: { createRange(): R; createTreeWalker(root: unknown, what: number): { nextNode(): TextNode | null } } }).document;
    const walker = doc.createTreeWalker(el, 4);
    let node: TextNode | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? "").trim().endsWith(end)) node = n;
    if (!node) return { found: false, lines: 0, cut: "", alone: "" };
    const text = node.textContent ?? "";
    const whole = doc.createRange();
    whole.setStart(node, 0);
    whole.setEnd(node, text.length);
    const rects = Array.from(whole.getClientRects()).filter((r) => r.width > 1);
    const tops = [...new Set(rects.map((r) => Math.round(r.top)))];
    // The words' own span wraps inside the row's detail box, which cuts with an ellipsis what it cannot show.
    const box = node.parentElement?.parentElement as { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number } | null;
    const cut = box && (box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1) ? `${box.scrollWidth} x ${box.scrollHeight} in ${box.clientWidth} x ${box.clientHeight}` : "";
    const lastWord = text.trimEnd().slice(Math.max(text.trimEnd().lastIndexOf(" "), text.trimEnd().lastIndexOf("\u00a0")) + 1);
    const word = doc.createRange();
    word.setStart(node, text.trimEnd().length - lastWord.length);
    word.setEnd(node, text.trimEnd().length);
    const wordRect = Array.from(word.getClientRects()).filter((r) => r.width > 1)[0];
    const lastLine = rects.filter((r) => Math.round(r.top) === tops[tops.length - 1]);
    const lineLeft = Math.min(...lastLine.map((r) => r.left));
    const alone = tops.length > 1 && wordRect !== undefined && Math.abs(wordRect.left - lineLeft) < 1 ? lastWord : "";
    return { found: true, lines: tops.length, cut, alone };
  }, ending);
}

/*
 * The isometric view's choice (docs/design-v1-isometric-view.md 8): the
 * top bar with the View button, the View menu in both views, and Scene
 * settings' Suggested view, at FU30_AT's sizes.
 */

/** A DM panel: its side panel tab from 900 px up, else its sheet from Panels. */
async function openDmPanel(page: Page, title: string): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if (await visible(tabs)) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel", { name: sideTabName(title) });
  }
  const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  if (await visible(sheet)) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await sheet.waitFor();
  return sheet;
}

/**
 * A top bar's View button: whole on the screen with Fit beside it, its
 * icon in its middle, and its middle on Fit's line. The bar's own row is
 * not this step's: its connection dot and chip were never one height.
 */
async function isoTopBar(sweep: Sweep, page: Page, screen: string): Promise<void> {
  const view = page.getByRole("button", { name: /^View: / });
  const fit = page.getByRole("button", { name: "Fit the map to the screen" });
  // Where the bar folded the View button into the room's menu, its other buttons stay whole, Undo and Redo always (D-261026-12).
  const folded = (await view.count()) === 0;
  const dm = (await page.getByRole("button", { name: "Undo", exact: true }).count()) > 0;
  const whole: [string, Locator][] = [
    ["Fit", fit],
    ...(folded ? [] : [["View", view] as [string, Locator]]),
    ...(dm ? (["Undo", "Redo"] as const).map((name): [string, Locator] => [name, page.getByRole("button", { name, exact: true })]) : []),
  ];
  for (const [what, button] of whole) {
    if (!(await wholeInReach(button))) sweep.lines.push(`${sweep.at} ${screen}: ${what} is not whole on the screen, or another control covers part of it`);
  }
  const lead = folded ? fit : view;
  const beside = !folded ? fit : dm ? page.getByRole("button", { name: "Undo", exact: true }) : page.getByRole("button", { name: "Find my token" });
  await sweep.measure(page, screen, lead);
  const [a, b] = [await lead.boundingBox(), await beside.boundingBox()];
  if (a && b && Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) > LIMIT_PX) sweep.lines.push(`${sweep.at} ${screen}: the bar's buttons are off one line, ${a.y + a.height / 2} and ${b.y + b.height / 2}`);
}

/** A line for each view name in the help that breaks over lines: "Top-down" broke at its hyphen at 320 px and 130% (ISO5-OPUS-5). */
async function viewNameWhole(root: Locator, at: string): Promise<string[]> {
  const names = root.locator("[data-view-name]");
  await names.first().waitFor();
  const rects = await names.evaluateAll((els) => els.map((el) => [(el as unknown as { textContent: string }).textContent, (el as unknown as { getClientRects(): { length: number } }).getClientRects().length] as const));
  return rects.filter(([, n]) => n !== 1).map(([words, n]) => `${at} iso5-help: "${words}" drawn over ${n} lines`);
}

/** iso5-a, the last screen check in alignment-settings.e2e.ts, before its console check. */
export function isoChoiceTests(): void {
  test(`iso5-a. the top bar with the View button, for the DM and for Pat, or the room menu's View row where the bar folds it, the View menu in Top-down and in Isometric, and Scene settings' Suggested view, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (docs/design-v1-isometric-view.md 8)`, async () => {
    await newDmSession();
    if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
    const lines: string[] = [];
    for (const at of FU30_AT) {
      const sweep = new Sweep(`iso5-${atName(at)}`);
      pat.setDefaultTimeout(10_000);
      await openAt(pat, at.size, at.scale);
      await isoTopBar(sweep, pat, "iso5-pat-top-bar");
      await pat.goto("about:blank");
      const page = await dmPageFor(at.size);
      page.setDefaultTimeout(10_000);
      await openAt(page, at.size, at.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      const menu = page.getByRole("dialog", { name: "View" });
      // On the narrowest phones the View button folds into the room's menu as its View row (D-261026-12).
      const folded = (await page.getByRole("button", { name: /^View: / }).count()) === 0;
      const open = async (shown: string) => {
        if (folded) {
          const roomMenu = await openDmPanel(page, "Menu");
          const row = roomMenu.getByRole("button", { name: /^View/ });
          // The menu's panel loads as it opens.
          await row.waitFor();
          await row.scrollIntoViewIfNeeded();
          await sweep.measure(page, "iso5-menu-row", row);
          // Its detail names the views too, each kept on one line (ISO5-OPUS-10).
          await sweep.add(page, "iso5-menu-row", await viewNameWhole(row, sweep.at));
          await shots.take(page, `alignment-iso5-menu-row-${shown}-${atName(at)}`);
          await row.click();
        } else await page.getByRole("button", { name: /^View: / }).click();
        await menu.waitFor();
      };
      const close = async () => {
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        if (folded) await closeSheets(page);
      };
      await isoTopBar(sweep, page, "iso5-top-bar");
      await open("top-down");
      await sweep.measure(page, "iso5-menu-top-down", menu);
      await sweep.add(page, "iso5-menu-top-down", await viewNameWhole(menu, sweep.at));
      await shots.take(page, `alignment-iso5-menu-top-down-${atName(at)}`);
      await menu.getByRole("radio", { name: "Isometric" }).check();
      await menu.getByRole("button", { name: "Turn right", exact: true }).waitFor();
      await sweep.measure(page, "iso5-menu-isometric", menu);
      await shots.take(page, `alignment-iso5-menu-isometric-${atName(at)}`);
      await close();
      await isoTopBar(sweep, page, "iso5-top-bar-isometric");
      await shots.take(page, `alignment-iso5-top-bar-isometric-${atName(at)}`);
      await open("isometric");
      await menu.getByRole("radio", { name: "Follow the scene" }).check();
      await close();
      const scenes = await openDmPanel(page, "Scenes");
      // A phone starts the Size and view group folded (docs/design-v1-map-discovery.md 8.4).
      await openSceneGroup(scenes, "Size and view");
      const row = scenes.getByRole("radiogroup", { name: "Suggested view" }).locator("xpath=../..");
      await row.scrollIntoViewIfNeeded();
      await sweep.measure(page, "iso5-suggested-view", row);
      await shots.take(page, `alignment-iso5-suggested-view-${atName(at)}`);
      await closeSheets(page);
      await escapeAll(page);
      console.log(`${sweep.at}: measured ${[...sweep.seen].join(", ")}`);
      lines.push(...sweep.lines);
    }
    assert.deepEqual(lines, [], "the view choice out of line");
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged errors");
    assert.deepEqual(consoles.pat.errors, [], "Pat's page logged errors");
    withinSnapshotBudget("iso5-a");
  });
}

/*
 * Map discovery's builder note and forget question
 * (docs/design-v1-map-discovery.md 9): the Map builder's row with the note
 * it shows while the party sees the cells being built, on a lit scene with
 * fog and party vision on where Pat's scout stands, and the question a
 * change asks before it runs past what players' remembered map keeps, at
 * FU30_AT's sizes. The players and the DM go back to the room's scene
 * after.
 */
const BUILD_IN_SIGHT = "The party can see where you are building, so they see it as you build. Build before players come here, or tap Fog all when done.";

/** Moves the DM's page to a scene from its Scenes panel, and waits for its copy to say so. */
async function dmOnScene(page: Page, sceneId: string): Promise<void> {
  if (dmSocket.you?.sceneId === sceneId) return;
  const name = dmSocket.state?.scenes[sceneId]?.name ?? "";
  assert.ok(name, `no scene ${sceneId} in the DM's copy`);
  const panel = await openDmPanel(page, "Scenes");
  await panel.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await waitFor(`the DM on ${name}`, () => dmSocket.you?.sceneId === sceneId || null, 30_000);
  await closeSheets(page);
  await escapeAll(page);
}

export function md4Tests(): void {
  test(`md4-a. the Map builder's row with its note that the party sees where the DM builds, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px (docs/design-v1-map-discovery.md 9)`, async () => {
    await newDmSession();
    if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
    const cave = randomUUID();
    const scout = randomUUID();
    const lines: string[] = [];
    let page: Page | null = null;
    try {
      await ops.send({ t: "scene.create", scene: { id: cave, name: "Lit cave", bounds: { w: 12, h: 8 }, fogEnabled: true, blockMovement: true, vision: { on: true, light: "bright" } } });
      await ops.send({ t: "token.create", token: { id: scout, sceneId: cave, size: "medium", visibility: "all", kind: "pc", name: "Scout", x: 1, y: 4, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor() } } });
      await ops.send({ t: "room.setPlayerScene", sceneId: cave });
      for (const [i, at] of FU30_AT.entries()) {
        const sweep = new Sweep(`md4-${atName(at)}`);
        page = await dmPageFor(at.size);
        page.setDefaultTimeout(10_000);
        await openAt(page, at.size, at.scale);
        await waitFor("the DM's snapshot", () => dmSocket.state);
        await dmOnScene(page, cave);
        await page.locator(".konvajs-content").first().waitFor();
        await pickTool(page, "Map builder");
        await pickOption(page, "Map builder", "Builder mode", "Brush");
        // A stroke across open ground the scout sees, so the row says the party sees it. Each size paints a row of its own: a stroke over floor already painted builds nothing.
        await dragCells(page, { w: 12, h: 8 }, { x: 5, y: i + 1 }, { x: 7, y: i + 1 });
        const bar = page.getByRole("toolbar", { name: "Map builder options" });
        if (await showsWithin(bar.getByText(BUILD_IN_SIGHT).first(), 5_000)) {
          await sweep.measure(page, "md4-builder-note", bar);
          await shots.take(page, `alignment-md4-builder-note-${atName(at)}`);
          // Where the row cuts the note short, a tap opens it whole.
          const cut = page.locator('[data-options-line="shown"] button[aria-expanded="false"]');
          if ((await cut.count()) > 0) {
            await cut.first().click();
            const open = page.locator('[data-options-line="open"]');
            await open.waitFor();
            await sweep.measure(page, "md4-builder-note-open", open);
            // Opened, the whole note shows: its last words are not left below a scroll (MD4-LK-4).
            const clipped = await open.first().evaluate((el) => {
              // The words scroll inside the line's button, in its first span (measure/controls.tsx OptionsLine).
              const text = el.querySelector("button > span");
              return text ? text.scrollHeight - text.clientHeight : 0;
            });
            if (clipped > 1) lines.push(`${atName(at)} md4-builder-note-open: the note's end is cut off by ${clipped} px`);
            await shots.take(page, `alignment-md4-builder-note-open-${atName(at)}`);
            await open.getByRole("button").first().click();
          }
        } else await sweep.missing(page, "md4-builder-note", "a stroke in the party's sight showed no note");
        await pickTool(page, "Select");
        lines.push(...sweep.lines);
      }
    } finally {
      if (page) await dmOnScene(page, run.sceneId).catch(() => {});
      await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId }).catch(() => {});
      await ops.send({ t: "scene.delete", sceneId: cave }).catch(() => {});
    }
    assert.deepEqual(lines, [], "the builder's note out of line");
    withinSnapshotBudget("md4-a");
  });

  test(`md4-b. the forget question, asked before Clear build clears a cavern the party saw past what players' remembered map can keep, at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%, within ${LIMIT_PX} px, Escape answering no and the build left whole (docs/design-v1-map-discovery.md 9)`, async () => {
    await newDmSession();
    if (dmSocket.state?.encounter) await ops.send({ t: "encounter.end" });
    const cavern = randomUUID();
    const scout = randomUUID();
    const bounds = { w: 80, h: 64 };
    const lines: string[] = [];
    let page: Page | null = null;
    try {
      // Pat's scout sees the whole bright cavern, floored in stone, and the players leave it: clearing it asks the
      // party's memory to keep 5,120 squares of floor at 16 bytes apiece, past its 64 KiB, in one op.
      await ops.send({ t: "scene.create", scene: { id: cavern, name: "Great cavern", bounds, fogEnabled: true, blockMovement: true, vision: { on: true, light: "bright" } } });
      for (let y = 0; y < bounds.h; y += 16) await ops.send({ t: "build.rect", sceneId: cavern, terrain: "stone", x: 0, y, w: bounds.w, h: 16 });
      await ops.send({ t: "token.create", token: { id: scout, sceneId: cavern, size: "medium", visibility: "all", kind: "pc", name: "Scout", x: 40, y: 32, disposition: "ally", ownerIds: [run.patId], actor: { inline: actor() } } });
      page = await dmPageFor(FU30_AT[0]!.size);
      await openAt(page, FU30_AT[0]!.size, FU30_AT[0]!.scale);
      await waitFor("the DM's snapshot", () => dmSocket.state);
      await dmOnScene(page, cavern);
      await ops.send({ t: "room.setPlayerScene", sceneId: cavern });
      const explored = () => Object.keys(dmSocket.state?.exploredTiles ?? {}).filter((k) => k.startsWith(`${cavern}:`)).length;
      // 16-cell fog tiles, 5 across and 4 down.
      await waitFor("the cavern explored", () => (explored() === 20 ? true : null), 30_000);
      await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
      const built = () => dmSocket.state?.buildChunks[`${cavern}:0,0`]?.cells["0,0"];
      for (const at of FU30_AT) {
        const sweep = new Sweep(`md4-${atName(at)}`);
        page = await dmPageFor(at.size);
        page.setDefaultTimeout(10_000);
        await openAt(page, at.size, at.scale);
        await waitFor("the DM's snapshot", () => dmSocket.state);
        await dmOnScene(page, cavern);
        await page.locator(".konvajs-content").first().waitFor();
        await pickTool(page, "Map builder");
        await page.getByRole("toolbar", { name: "Map builder options" }).getByRole("button", { name: "More options" }).click();
        const more = page.getByRole("dialog", { name: "More Map builder options" });
        await more.getByRole("button", { name: "Clear build", exact: true }).click();
        await more.getByRole("button", { name: "Tap again to clear" }).click();
        if (await more.isVisible()) await page.keyboard.press("Escape");
        const ask = page.getByRole("dialog", { name: "Remembered map" });
        if (await showsWithin(ask, 10_000)) {
          await sweep.measure(page, "md4-forget-question", ask);
          await shots.take(page, `alignment-md4-forget-question-${atName(at)}`);
          await page.keyboard.press("Escape");
          if (!(await ask.waitFor({ state: "detached", timeout: 3_000 }).then(() => true, () => false))) lines.push(`${sweep.at} md4-forget-question: Escape left it open`);
          if (built() !== "stone") lines.push(`${sweep.at} md4-forget-question: Escape cleared the cavern`);
        } else await sweep.missing(page, "md4-forget-question", "Clear build asked nothing");
        await escapeAll(page);
        await pickTool(page, "Select");
        lines.push(...sweep.lines);
      }
    } finally {
      if (page) await dmOnScene(page, run.sceneId).catch(() => {});
      await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId }).catch(() => {});
      await ops.send({ t: "scene.delete", sceneId: cavern }).catch(() => {});
    }
    assert.deepEqual(lines, [], "the forget question out of line");
    withinSnapshotBudget("md4-b");
  });
}

// Undo batch A roots. Keep this block independent of the parallel alignment additions.
export function undoScopeAlignmentTests(names: readonly string[]): void {
  for (const name of names) {
    const size = [...SIZES, COMBAT_SMALL].find((candidate) => candidate.name === name);
    assert.ok(size, `unknown Undo alignment size ${name}`);
    for (const scale of name === "480x320" ? [1.3] : SCALES) {
      test(`undo-scope-alignment-${name}-${scale}: history, retained refusal, confirmation and loading within ${LIMIT_PX} px`, async () => {
        const sweep = new Sweep(`undo-scope-${name}-${scale}`);
        await newDmSession();
        const page = await dmPageFor(size);
        let hold = false;
        const held: (() => void)[] = [];
        await page.routeWebSocket(/\/ws\?room=/, (socket) => {
          const upstream = socket.connectToServer();
          upstream.onMessage((message) => {
            const parsed = JSON.parse(String(message)) as { t?: string };
            if (hold && parsed.t === "history") held.push(() => socket.send(message));
            else socket.send(message);
          });
        });
        await openAt(page, size, scale);
        const wire = await UndoWire.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });
        const characterId = randomUUID();
        try {
          await wire.apply({ t: "character.create", character: { id: characterId, name: "Bree, keeper of the western beacon and the lanterns along the harbor", size: "medium", ownerIds: [], actor: actor() } });
          await wire.apply({ t: "character.update", characterId, patch: { actor: { ac: 19 } } });
          await wire.apply({ t: "actor.hp", target: { characterId }, change: { kind: "damage", amount: 4 } });
          const { sheet, opener } = await setupHistory(page);
          await sweep.measure(page, "undo-scope-sheet", sheet);
          await shots.take(page, `undo-scope-${name}-${scale}-setup`);
          const undo = sheet.getByRole("button", { name: "Undo setup", exact: true });
          await untilReady(undo, "Setup Undo");
          await undo.click();
          const retained = sheet.locator("[data-history-review]");
          await retained.waitFor();
          await retained.getByRole("button", { name: "Review step", exact: true }).click();
          await sweep.measure(page, "undo-scope-retained", retained);
          for (const name of ["Retry", "Discard this step"]) {
            const control = retained.getByRole("button", { name, exact: true });
            await control.scrollIntoViewIfNeeded();
            assert.ok(await wholeInReach(control), `${name} is not obscured at ${sweep.at}`);
            assert.ok((await control.boundingBox())!.height >= 44, `${name} has a touch target`);
          }
          await retained.getByRole("button", { name: "Discard this step", exact: true }).click();
          const confirmation = page.getByRole("dialog", { name: "Discard this step", exact: true });
          await confirmation.getByText("Discard this undo step? The game stays as it is.", { exact: true }).waitFor();
          await sweep.measure(page, "undo-scope-discard", confirmation);
          await shots.take(page, `undo-scope-${name}-${scale}-discard`);
          const confirm = confirmation.getByRole("button", { name: "Discard this step", exact: true });
          await confirm.scrollIntoViewIfNeeded();
          assert.ok(await wholeInReach(confirm), "confirmation stays reachable on short screens");
          await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.keyboard.press("Escape");
          assert.ok(await opener.evaluate((button) => button === button.ownerDocument.activeElement));
          hold = true;
          await reopenRoom(page);
          const loading = (await setupHistory(page)).sheet;
          await loading.getByText("Loading undo history…", { exact: true }).waitFor();
          // A turning spinner's box grows by up to 3.7 px each side at 45 degrees, though its ring stays in place. Measure it still, as reduced motion draws it.
          await page.emulateMedia({ reducedMotion: "reduce" });
          await sweep.measure(page, "undo-scope-loading", loading);
          await page.emulateMedia({ reducedMotion: null });
          await shots.take(page, `undo-scope-${name}-${scale}-loading`);
          hold = false;
          for (const deliver of held.splice(0)) deliver();
          await loading.getByText("Loading undo history…", { exact: true }).waitFor({ state: "hidden" });
          await page.keyboard.press("Escape");
          assert.deepEqual(sweep.lines, [], `Undo history alignment at ${sweep.at}`);
        } finally {
          hold = false;
          for (const deliver of held.splice(0)) deliver();
          wire.close();
          sweep.tally();
        }
      });
    }
  }
}
