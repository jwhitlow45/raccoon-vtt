import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { RoomState, Token } from "../shared/model.ts";
import { barControl, ConsoleWatch, dragCells, expandBar, OpSocket, pagePoint, pickTool, Shots, SocketWatch, startServer, tapCell, Touches, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * Snap off for a drag end to end (docs/design/design-v1-snap-off.md 4 and 10),
 * on the real server serving the production build. The DM is on a computer,
 * Pat on a phone at 390 x 844 and Sam on a computer.
 *
 * - The DM Alt-drags the goblin: it lands on the box under the release, is
 *   drawn where it was let go, says so to a screen reader, and shows the
 *   dashed outline of the box the rules count it in while it is selected,
 *   dragged or measured, and not otherwise.
 * - Pat places Bree freely from the bar on the phone, one drag only, and the
 *   bar's Snap to grid and Undo move put her back.
 * - Jitter keeps a placement, a real move off it clears it.
 * - Who: Sam gets no Place freely on Bree, a locked pony offers none to Pat,
 *   and the server refuses the same update from Pat's socket.
 * - Privacy: a hidden imp placed freely never reaches Pat's or Sam's frames,
 *   and Sam receives the nudge on a token he sees.
 * - A reload draws the placement from the snapshot.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty-six, one file after
 * another. The other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 46;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-snapoff-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const BOUNDS = { w: 16, h: 12 };

/** A quarter square right and a quarter up of the box a drop lands in: the middle of the 1/8 step that rounds to (2, -2) eighths. */
const OFF = { x: 0.25, y: -0.25 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let samContext: BrowserContext;
let dm: Page;
let pat: Page;
let sam: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const samSocket = new SocketWatch("sam");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), sam: new ConsoleWatch("sam") };

const run = {
  roomId: "",
  roomName: `E2E snapoff ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  samId: "",
  goblin: randomUUID(),
  bree: randomUUID(),
  pony: randomUUID(),
  sam: randomUUID(),
  imp: randomUUID(),
};

function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
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

function tokenOp(id: string, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", actor: { inline: actor() }, ...extra } };
}

function token(socket: SocketWatch, id: string): Token | undefined {
  return (socket.state as RoomState | null)?.tokens[id];
}

/** The token's bar, a dialog named for it, with what a screen reader adds when it is placed between squares. */
function bar(page: Page, name: string, placed = false): Locator {
  return page.getByRole("dialog", { name: `${name} actions${placed ? ", placed between squares" : ""}`, exact: true });
}

/** Selects a token by a tap on its box's middle and waits for its bar. */
async function select(page: Page, name: string, cell: { x: number; y: number }, placed = false): Promise<Locator> {
  await tapCell(page, BOUNDS, cell);
  const b = bar(page, name, placed);
  await b.waitFor();
  return b;
}

/** Lets go of the selection, so the board shows no bar and no outline. A bar's window can stand over the token, so it is closed by its own button. */
async function deselect(page: Page): Promise<void> {
  const close = page.getByRole("dialog", { name: /actions/ }).getByRole("button", { name: "Close", exact: true });
  if ((await close.count()) > 0) await close.first().click();
  else await page.keyboard.press("Escape");
  await waitFor("no bar open", async () => ((await page.getByRole("dialog", { name: /actions/ }).count()) === 0 ? true : null), 5_000);
}

/** Closes a bar that stands open, since a computer's bar is a window that can stand over the token the next drag grabs. */
async function closeBars(page: Page): Promise<void> {
  if ((await page.getByRole("dialog", { name: /actions/ }).count()) > 0) await deselect(page);
}

type Rect = { x: number; y: number; width: number; height: number };

/** Where a token's node sits in the world (its drawn top-left, in cells) and the page rectangle of its dashed outline, null when none is drawn. */
async function nodeOf(page: Page, id: string): Promise<{ at: { x: number; y: number }; outline: Rect | null } | null> {
  return page.evaluate(
    ([tokenId]) => {
      type N = { position(): { x: number; y: number }; findOne(s: string): N | undefined; getClientRect(o?: { skipStroke?: boolean }): { x: number; y: number; width: number; height: number }; isVisible(): boolean };
      const konva = (globalThis as unknown as { Konva: { stages: (N & { width(): number; visible(): boolean; listening(): boolean; container(): { getBoundingClientRect(): { left: number; top: number } } })[] } }).Konva;
      const main = konva.stages.find((s) => s.width() > 0 && s.visible() && s.listening());
      const node = main?.findOne(`#${tokenId}`);
      if (!main || !node) return null;
      const box = main.container().getBoundingClientRect();
      const rule = node.findOne(".rulesOutline");
      const r = rule && rule.isVisible() ? rule.getClientRect({ skipStroke: true }) : null;
      return { at: node.position(), outline: r ? { x: box.left + r.x, y: box.top + r.y, width: r.width, height: r.height } : null };
    },
    [id],
  );
}

/** The outline of a token's rules box, once the board has drawn it (or null once it has drawn none). */
async function outlineOf(page: Page, id: string): Promise<Rect | null> {
  return (await nodeOf(page, id))?.outline ?? null;
}

/** Whether an outline is the box of the cell `cell` (side `side` cells) to within 2 px. */
async function assertOutlineOn(page: Page, rect: Rect | null, cell: { x: number; y: number }, side: number, what: string): Promise<void> {
  assert.ok(rect, `${what}: no outline`);
  const a = await pagePoint(page, BOUNDS, cell);
  const b = await pagePoint(page, BOUNDS, { x: cell.x + side, y: cell.y + side });
  for (const [got, want, label] of [
    [rect.x, a.x, "left"],
    [rect.y, a.y, "top"],
    [rect.x + rect.width, b.x, "right"],
    [rect.y + rect.height, b.y, "bottom"],
  ] as const) {
    assert.ok(Math.abs(got - want) <= 2, `${what}: the outline's ${label} edge is ${got.toFixed(1)}, the box's is ${want.toFixed(1)}`);
  }
}

/** A drag with Alt held from a box's middle, to another box's middle moved by `by`, with the pointer parked there until `hold` returns. */
async function altDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, by = OFF, hold?: () => Promise<void>): Promise<void> {
  await closeBars(page);
  const a = await pagePoint(page, BOUNDS, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(page, BOUNDS, { x: to.x + 0.5 + by.x, y: to.y + 0.5 + by.y });
  await page.keyboard.down("Alt");
  try {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1, { steps: 3 });
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await hold?.();
    await page.mouse.up();
  } finally {
    await page.keyboard.up("Alt");
  }
}

/** The screen reader's polite line, where toasts are announced. */
function announced(page: Page): Locator {
  return page.locator("[data-rvtt-toast-status]");
}

async function reads(page: Page, text: string): Promise<void> {
  await waitFor(`"${text}" announced`, async () => (((await announced(page).innerText()) ?? "").includes(text) ? true : null), 8_000);
}

describe("raccoon-vtt snap off", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    samContext = await browser.newContext({ viewport: DESKTOP });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    sam = await samContext.newPage();
    patCdp = await patContext.newCDPSession(pat);
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    consoles.sam.attach(sam);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    await samSocket.attach(samContext, sam);
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

  test("so-0. the DM's room, Pat with Bree and a pony on a phone, Sam with his own token, a goblin and a hidden imp", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.patId = await join(patContext, "Pat", "#30a46c");
    run.samId = await join(samContext, "Sam", "#e5484d");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send(tokenOp(run.goblin, { kind: "monster", name: "Goblin", x: 8, y: 5, disposition: "hostile" }));
    await ops.send(tokenOp(run.bree, { kind: "pc", name: "Bree", x: 3, y: 5, disposition: "ally", ownerIds: [run.patId] }));
    await ops.send(tokenOp(run.pony, { kind: "npc", name: "Pony", x: 3, y: 8, disposition: "ally", ownerIds: [run.patId] }));
    await ops.send(tokenOp(run.sam, { kind: "pc", name: "Sam", x: 6, y: 9, disposition: "ally", ownerIds: [run.samId] }));
    await ops.send(tokenOp(run.imp, { kind: "monster", name: "Imp", x: 12, y: 8, visibility: "dm", disposition: "hostile" }));
    for (const [page, socket] of [
      [pat, patSocket],
      [sam, samSocket],
    ] as const) {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await waitFor("the player's snapshot", () => token(socket, run.goblin));
      await page.locator(".konvajs-content").first().waitFor();
    }
    await dm.locator(".konvajs-content").first().waitFor();
    assert.equal(token(patSocket, run.imp), undefined, "the hidden imp reached Pat");
  });

  test("so-1. the DM holds Alt and drags the goblin: it lands on the box under the release, drawn where it was let go, and everyone's page draws it there", async () => {
    await altDrag(dm, { x: 8, y: 5 }, { x: 11, y: 5 });
    const goblin = await waitFor("the goblin on the box under the release", () => {
      const t = token(dmSocket, run.goblin);
      return t && t.x === 11 ? t : null;
    });
    assert.equal(goblin.y, 5, "the stored spot is a square, as an ordinary drop's");
    assert.deepEqual(goblin.nudge, { x: 2, y: -2 }, "drawn a quarter square right and up");
    await reads(dm, "Placed between squares.");
    for (const [page, who] of [
      [dm, "the DM"],
      [sam, "Sam"],
      [pat, "Pat"],
    ] as const) {
      const drawn = await waitFor(`${who}'s board drawing the goblin`, async () => {
        const n = await nodeOf(page, run.goblin);
        return n && n.at.x === 11.25 ? n : null;
      });
      assert.equal(drawn.at.y, 4.75, `${who}: drawn a quarter up`);
    }
    assert.deepEqual(token(samSocket, run.goblin)?.nudge, { x: 2, y: -2 }, "a player gets the placement of a creature they see");
    await shots.take(dm, "so-dm-goblin-placed");
  });

  test("so-2. a screen reader hears it: the placed goblin's bar says so at the end of its name", async () => {
    await select(dm, "Goblin", { x: 11, y: 5 }, true);
    const b = bar(dm, "Goblin", true);
    assert.equal(await b.count(), 1);
    assert.equal(await bar(dm, "Goblin").count(), 0, "the plain name is not also there");
  });

  test("so-3. the dashed outline shows the box the rules count the goblin in, while it is selected and while it is dragged, and not while it is not", async () => {
    const selected = await waitFor("the outline while selected", () => outlineOf(dm, run.goblin));
    await assertOutlineOn(dm, selected, { x: 11, y: 5 }, 1, "selected");
    await shots.take(dm, "so-dm-goblin-outline");
    await deselect(dm);
    await waitFor("no outline once nothing is selected", async () => ((await outlineOf(dm, run.goblin)) === null ? true : null), 5_000);
    // An ordinary drag, parked mid-way: the outline stays on the box it counts in until the drop.
    const a = await pagePoint(dm, BOUNDS, { x: 11.5, y: 5.5 });
    const b = await pagePoint(dm, BOUNDS, { x: 13.5, y: 5.5 });
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    await dm.mouse.move(b.x, b.y, { steps: 12 });
    try {
      const during = await waitFor("the outline while dragged", () => outlineOf(dm, run.goblin));
      assert.ok(during.width > 0);
    } finally {
      await dm.mouse.move(a.x, a.y, { steps: 12 });
      await dm.mouse.up();
    }
    // Dropped back on its own box without leaving it by an eighth: the placement is kept.
    await waitFor("the goblin still placed", () => (token(dmSocket, run.goblin)?.nudge ? true : null));
  });

  test("so-4. a ruler that starts on the goblin outlines its box on the DM's page", async () => {
    await pickTool(dm, "Ruler");
    const a = await pagePoint(dm, BOUNDS, { x: 11.75, y: 5.25 });
    const b = await pagePoint(dm, BOUNDS, { x: 14.5, y: 5.5 });
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    await dm.mouse.move(b.x, b.y, { steps: 10 });
    try {
      const rect = await waitFor("the outline under the ruler", () => outlineOf(dm, run.goblin));
      await assertOutlineOn(dm, rect, { x: 11, y: 5 }, 1, "ruler");
    } finally {
      await dm.mouse.up();
    }
    await pickTool(dm, "Select");
    await deselect(dm);
  });

  test("so-5. a drag of the placed goblin let go within 1/8 of where it is drawn keeps its placement and sends nothing, and one let go a quarter square off, on its own box, puts it back on the grid", async () => {
    await closeBars(dm);
    const before = token(dmSocket, run.goblin)!;
    const rev = (dmSocket.state as RoomState).meta.rev;
    // Drawn middle is (11.75, 5.25). Out a square and back to 0.05 off it: a drag that began, let go under 1/8 from where the token is drawn.
    const a = await pagePoint(dm, BOUNDS, { x: 11.75, y: 5.25 });
    const out = await pagePoint(dm, BOUNDS, { x: 12.75, y: 5.25 });
    const slip = await pagePoint(dm, BOUNDS, { x: 11.8, y: 5.2 });
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    await dm.mouse.move(out.x, out.y, { steps: 6 });
    await dm.mouse.move(slip.x, slip.y, { steps: 6 });
    await dm.mouse.up();
    await dm.waitForTimeout(600);
    assert.deepEqual(token(dmSocket, run.goblin)?.nudge, before.nudge, "jitter keeps the placement");
    assert.equal((dmSocket.state as RoomState).meta.rev, rev, "and sends nothing");
    await closeBars(dm);
    // A quarter square back toward its box's middle is past 1/8.
    const back = await pagePoint(dm, BOUNDS, { x: 11.5, y: 5.5 });
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    await dm.mouse.move(out.x, out.y, { steps: 6 });
    await dm.mouse.move(back.x, back.y, { steps: 6 });
    await dm.mouse.up();
    await waitFor("the goblin back on the grid", () => (token(dmSocket, run.goblin)?.nudge === undefined ? true : null));
    assert.deepEqual([token(dmSocket, run.goblin)?.x, token(dmSocket, run.goblin)?.y], [11, 5], "on the same box");
  });

  test("so-6. a placed token dragged to another box by an ordinary drag is on the grid there, and Snap to grid puts a placed one back without moving it", async () => {
    await altDrag(dm, { x: 11, y: 5 }, { x: 9, y: 6 });
    await waitFor("placed at 9,6", () => (token(dmSocket, run.goblin)?.x === 9 && token(dmSocket, run.goblin)?.nudge ? true : null));
    await closeBars(dm);
    await dragCells(dm, BOUNDS, { x: 9, y: 6 }, { x: 10, y: 3 });
    const moved = await waitFor("the ordinary drag landed", () => (token(dmSocket, run.goblin)?.x === 10 ? token(dmSocket, run.goblin) : null));
    assert.equal(moved.nudge, undefined, "an ordinary drag to another box clears the placement");
    await altDrag(dm, { x: 10, y: 3 }, { x: 10, y: 3 });
    const placed = await waitFor("placed in place", () => (token(dmSocket, run.goblin)?.nudge ? token(dmSocket, run.goblin) : null));
    assert.deepEqual([placed.x, placed.y], [10, 3], "an in-place free drop moves nothing");
    const goblinBar = await select(dm, "Goblin", { x: 10, y: 3 }, true);
    await (await barControl(goblinBar, "Snap to grid")).click();
    await waitFor("on the grid again", () => (token(dmSocket, run.goblin)?.nudge === undefined ? true : null));
    assert.deepEqual([token(dmSocket, run.goblin)?.x, token(dmSocket, run.goblin)?.y], [10, 3], "Snap to grid is no move");
    await bar(dm, "Goblin").waitFor();
    // The DM's Undo in the top bar takes the snap back: the token is placed again, as one step of the stack.
    await dm.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("placed again by Undo", () => (token(dmSocket, run.goblin)?.nudge ? true : null));
    await deselect(dm);
  });

  test("so-7. Pat on a phone taps Place freely in Bree's bar: it reads pressed, the next drag places her, and the button is off after it", async () => {
    const breeBar = await select(pat, "Bree", { x: 3, y: 5 });
    const toggle = await barControl(breeBar, "Place freely");
    await toggle.tap();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    const from = await pagePoint(pat, BOUNDS, { x: 3.5, y: 5.5 });
    const to = await pagePoint(pat, BOUNDS, { x: 6.5 + OFF.x, y: 5.5 + OFF.y });
    await touchSwipe(patCdp, from, to, { steps: 14, everyMs: 20 });
    const placed = await waitFor("Bree placed", () => (token(patSocket, run.bree)?.x === 6 ? token(patSocket, run.bree) : null));
    assert.deepEqual([placed.y, placed.nudge], [5, { x: 2, y: -2 }], "on the box under her release, drawn a quarter square off");
    await reads(pat, "Placed between squares.");
    await shots.take(pat, "so-pat-bree-placed");
    const again = bar(pat, "Bree", true);
    await again.waitFor();
    const after = await barControl(again, "Place freely");
    assert.equal(await after.getAttribute("aria-pressed"), "false", "the toggle turned itself off");
    // The next drag is ordinary: she lands on the grid.
    const next = await pagePoint(pat, BOUNDS, { x: 6.75, y: 5.25 });
    const far = await pagePoint(pat, BOUNDS, { x: 8.5, y: 6.5 });
    await touchSwipe(patCdp, next, far, { steps: 14, everyMs: 20 });
    const grid = await waitFor("Bree on the grid", () => (token(patSocket, run.bree)?.x === 8 ? token(patSocket, run.bree) : null));
    assert.equal(grid.nudge, undefined, "the second drag snapped");
  });

  test("so-8. Place freely cancels by a second tap and turns off when another token is dragged", async () => {
    const breeBar = await select(pat, "Bree", { x: 8, y: 6 });
    const toggle = await barControl(breeBar, "Place freely");
    await toggle.tap();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await toggle.tap();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false", "a second tap cancels");
    await toggle.tap();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    // Dragging the pony turns Bree's one-shot off, and the pony is not placed.
    const from = await pagePoint(pat, BOUNDS, { x: 3.5, y: 8.5 });
    const to = await pagePoint(pat, BOUNDS, { x: 4.5, y: 8.5 });
    await touchSwipe(patCdp, from, to, { steps: 10, everyMs: 20 });
    const pony = await waitFor("the pony moved", () => (token(patSocket, run.pony)?.x === 4 ? token(patSocket, run.pony) : null));
    assert.equal(pony.nudge, undefined, "another token's drag is ordinary");
    const breeAgain = await select(pat, "Bree", { x: 8, y: 6 });
    assert.equal(await (await barControl(breeAgain, "Place freely")).getAttribute("aria-pressed"), "false", "Bree's toggle is off");
    await deselect(pat);
  });

  test("so-9. Pat's Undo move takes back a free drop of hers, and the bar's Snap to grid puts a placed Bree back on the grid", async () => {
    // A phone has no Alt, so the toggle places her.
    let breeBar = await select(pat, "Bree", { x: 8, y: 6 });
    await (await barControl(breeBar, "Place freely")).tap();
    const from = await pagePoint(pat, BOUNDS, { x: 8.5, y: 6.5 });
    const to = await pagePoint(pat, BOUNDS, { x: 10.5 + OFF.x, y: 7.5 + OFF.y });
    await touchSwipe(patCdp, from, to, { steps: 14, everyMs: 20 });
    await waitFor("Bree placed at 10,7", () => (token(patSocket, run.bree)?.x === 10 && token(patSocket, run.bree)?.nudge ? true : null));
    breeBar = bar(pat, "Bree", true);
    await breeBar.waitFor();
    await (await barControl(breeBar, "Undo move")).tap();
    const undone = await waitFor("Bree back where she was", () => (token(patSocket, run.bree)?.x === 8 ? token(patSocket, run.bree) : null));
    assert.deepEqual([undone.y, undone.nudge], [6, undefined], "the free drop is a move, and undone as one");
    // Place her again in place, then Snap to grid.
    breeBar = await select(pat, "Bree", { x: 8, y: 6 });
    await (await barControl(breeBar, "Place freely")).tap();
    // A finger's drag starts past a few pixels, and a phone's square is small: out a square and back to a quarter off the middle.
    const stay = await pagePoint(pat, BOUNDS, { x: 8.5, y: 6.5 });
    const out = await pagePoint(pat, BOUNDS, { x: 9.5, y: 6.5 });
    const nudge = await pagePoint(pat, BOUNDS, { x: 8.5 + OFF.x, y: 6.5 + OFF.y });
    const finger = new Touches(patCdp);
    await finger.start([stay]);
    for (let i = 1; i <= 8; i++) await finger.move([{ x: stay.x + ((out.x - stay.x) * i) / 8, y: stay.y }], 20);
    for (let i = 1; i <= 8; i++) await finger.move([{ x: out.x + ((nudge.x - out.x) * i) / 8, y: stay.y + ((nudge.y - stay.y) * i) / 8 }], 20);
    await finger.end([], 20);
    const inPlace = await waitFor("Bree placed in place", () => (token(patSocket, run.bree)?.nudge ? token(patSocket, run.bree) : null));
    assert.deepEqual([inPlace.x, inPlace.y], [8, 6], "an in-place free drop moves nothing");
    breeBar = bar(pat, "Bree", true);
    await breeBar.waitFor();
    await (await barControl(breeBar, "Snap to grid")).tap();
    await waitFor("Bree snapped", () => (token(patSocket, run.bree)?.nudge === undefined ? true : null));
    await deselect(pat);
  });

  test("so-10. who may place: Sam gets no Place freely on Bree, a locked pony offers Pat none, and the server refuses the same update from Pat's socket", async () => {
    const samSees = await select(sam, "Bree", { x: 8, y: 6 });
    await expandBar(samSees);
    assert.equal(await samSees.getByRole("button", { name: "Place freely", exact: true }).count(), 0, "not his token");
    await deselect(sam);

    await ops.send({ t: "token.update", tokenId: run.pony, patch: { locked: true } });
    await waitFor("the pony locked on Pat's page", () => (token(patSocket, run.pony)?.locked ? true : null));
    const ponyBar = await select(pat, "Pony", { x: 4, y: 8 });
    await expandBar(ponyBar);
    assert.equal(await ponyBar.getByRole("button", { name: "Place freely", exact: true }).count(), 0, "a locked token cannot be dragged");
    await deselect(pat);

    const cookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    try {
      await assert.rejects(patOps.send({ t: "token.update", tokenId: run.pony, patch: { drawnAt: { x: 4.25, y: 8.25 } } }), /refused/, "a locked token cannot be placed by its owner");
      await ops.send({ t: "token.update", tokenId: run.pony, patch: { locked: false } });
      await waitFor("the pony unlocked", () => (token(patSocket, run.pony)?.locked ? null : true));
      await assert.rejects(patOps.send({ t: "token.update", tokenId: run.goblin, patch: { drawnAt: { x: 10.25, y: 3.25 } } }), /refused/, "a token that is not Pat's");
      await assert.rejects(patOps.send({ t: "token.update", tokenId: run.pony, patch: { drawnAt: { x: 4.25, y: 8.25 }, name: "Horse" } }), /refused|invalid/, "a placement beside another field");
      await patOps.send({ t: "token.update", tokenId: run.pony, patch: { drawnAt: { x: 4.25, y: 8.25 } } });
      assert.deepEqual((await waitFor("the pony placed by its owner", () => (token(patSocket, run.pony)?.nudge ? token(patSocket, run.pony) : null))).nudge, { x: 2, y: 2 });
    } finally {
      patOps.close();
    }
  });

  test("so-11. a hidden imp placed freely never reaches Pat's or Sam's frames", async () => {
    await altDrag(dm, { x: 12, y: 8 }, { x: 13, y: 8 });
    await waitFor("the imp placed", () => (token(dmSocket, run.imp)?.nudge ? true : null));
    await dm.waitForTimeout(500);
    assert.equal(patSocket.everSaw(run.imp), false, "Pat's frames never named the imp");
    assert.equal(samSocket.everSaw(run.imp), false, "Sam's frames never named the imp");
  });

  test("so-12. a reload draws the placement from the snapshot", async () => {
    await ops.send({ t: "token.update", tokenId: run.goblin, patch: { drawnAt: { x: 10.375, y: 2.875 } } });
    await waitFor("the goblin nudged to (3, -1)", () => (token(dmSocket, run.goblin)?.nudge?.x === 3 ? true : null));
    await dm.reload();
    await dm.locator(".konvajs-content").first().waitFor();
    const drawn = await waitFor("the reloaded board drawing the goblin", async () => {
      const n = await nodeOf(dm, run.goblin);
      return n && n.at.x === 10.375 ? n : null;
    });
    assert.equal(drawn.at.y, 2.875);
    await shots.take(dm, "so-dm-reloaded");
  });

  test("so-13. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s page`);
  });
});
