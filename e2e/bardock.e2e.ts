import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type CDPSession, type Locator, type Page } from "playwright-core";
import { dragCells, openSideTab, pagePoint, touchSwipe, waitFor } from "./harness.ts";
import {
  actor,
  assertNoConsoleErrors,
  barFrame,
  barRect,
  browser,
  chrome,
  closeAll,
  createRoom,
  damageGoblins,
  DESK,
  dm,
  dmCdp,
  dmContext,
  dmSocket,
  type Doc,
  type El,
  openBrowsers,
  ops,
  player,
  playerCdp,
  playerSocket,
  type Rect,
  rectOf,
  run,
  server,
  setUp,
  shots,
  sidePanelChoice,
  SIZE_KEY,
  SPOT_KEY,
  work,
} from "./bardockRoom.ts";

/**
 * The docked token action bar (docs/design-v1-bar-dock.md section 7) on the
 * real server serving the production build: where it docks at computer and
 * tablet sizes, moving it by its header, its grip and the grip's keys, what this device
 * remembers, Fit, Find and the outliner keeping tokens out from under it,
 * the right lane it shares with the fight alerts column, taps off the bar
 * with and without Multi-select, and "Viewing as Pat" beside the column.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven, which it shares
 * with the phone runs, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */


function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}


/**
 * Every card in the fight alerts columns on the page, as drawn: the part of
 * each that its column, which scrolls, leaves in view. The rolls' cards
 * sit in a wrapper with no box of its own, so its children count instead.
 */
function cards(page: Page): Promise<Rect[]> {
  return page.evaluate(() => {
    type Node = El & { tagName: string; parentElement: Node | null };
    const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Node> } };
    const out: Rect[] = [];
    for (const el of Array.from(g.document.querySelectorAll('[data-alert]:not([data-alert="rolls"]), [data-alert="rolls"] > *'))) {
      let column: Node = el;
      while (column.parentElement && column.parentElement.tagName !== "HEADER") column = column.parentElement;
      const r = el.getBoundingClientRect();
      const c = column.getBoundingClientRect();
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, c.bottom);
      if (r.width > 0 && bottom - top > 0.5) out.push({ left: r.left, top, right: r.right, bottom });
    }
    return out;
  });
}

/** The page point at a cell's center, after checking the map takes a tap there. */
async function cellPoint(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const p = await pagePoint(page, run.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
  const tag = await page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
  assert.equal(tag, "CANVAS", `the map does not take a tap at cell ${cell.x},${cell.y}`);
  return p;
}

async function clickCell(page: Page, cell: { x: number; y: number }, modifiers: ("Shift")[] = []): Promise<void> {
  const p = await cellPoint(page, cell);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** Empty map near the top left of the scene, clear of every token and of the docked bar. */
const EMPTY = { x: 1, y: 1 };

async function selectThorn(page: Page = dm): Promise<void> {
  await clickCell(page, run.thorn);
  await page.getByRole("dialog", { name: "Thorn actions" }).waitFor();
}

/** Drags the bar by its header with the mouse, in small steps. */
async function dragHeader(page: Page, to: { x: number; y: number }, opts: { escape?: boolean } = {}): Promise<void> {
  const r = await barRect(page);
  const from = { x: r.left + 40, y: r.top + 26 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (opts.escape) await page.keyboard.press("Escape");
  await page.mouse.up();
}

/** A one-finger drag through the browser's touch input, as a phone or a tablet sends it. */
async function touchDrag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await touchSwipe(cdp, from, to, { steps: 10 });
}

function storedSpot(page: Page): Promise<string | null> {
  return page.evaluate((key) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(key), SPOT_KEY);
}

function storedSize(page: Page): Promise<string | null> {
  return page.evaluate((key) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(key), SIZE_KEY);
}

/** The window's resize handle. */
function resizeHandle(page: Page): Locator {
  return barFrame(page).getByRole("button", { name: "Resize window", exact: true });
}

/** The window's scroller, which scrolls inside its frame. */
function scroller(page: Page): Locator {
  return barFrame(page).locator("[data-bar-scroll]");
}

/** A mouse drag from a point by a distance, past the slop first, in small steps. Escape before the release puts the window back. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number, opts: { escape?: boolean } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(dx || 1) * 12, from.y + Math.sign(dy || 1) * 12, { steps: 2 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  if (opts.escape) await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(150);
}

function middle(r: Rect): { x: number; y: number } {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

/** The resize bands, top or bottom first, then left or right, as the frame draws them. */
function bands(page: Page): Locator {
  return barFrame(page).locator("[data-resize-band]");
}

/** Whether the handle or a band is what a pointer at each point would reach. */
function handleOnTop(page: Page, points: readonly { x: number; y: number }[]): Promise<boolean[]> {
  return page.evaluate(
    (pts) =>
      pts.map((p) => {
        const top = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): El | null } }).document.elementFromPoint(p.x, p.y);
        return top !== null && top.closest("[data-resize-handle], [data-resize-band]") !== null;
      }),
    points,
  );
}

function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: Doc }).document.activeElement;
    return (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim();
  });
}

/** Each token's box on screen, from the camera Konva holds and the DM's view of the tokens. */
async function tokenRects(page: Page, ids: readonly string[]): Promise<Rect[]> {
  const rects: Rect[] = [];
  for (const id of ids) {
    const t = dmSocket.state?.tokens[id];
    if (!t || t.sceneId !== run.sceneId) continue;
    const a = await pagePoint(page, run.bounds, { x: t.x, y: t.y });
    const b = await pagePoint(page, run.bounds, { x: t.x + 1, y: t.y + 1 });
    rects.push({ left: a.x, top: a.y, right: b.x, bottom: b.y });
  }
  return rects;
}


function selectOptions(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Select options" });
}

/**
 * The default width this page draws the window at, in layout px, worked
 * out from the hidden buttons Room measures (client/canvas/BarWidthProbe.tsx)
 * by the design's rule (docs/design-v1-token-window.md 3.3).
 */
async function probeWidth(page: Page, scale: number): Promise<number> {
  const widths = await page.evaluate(() =>
    Array.from((globalThis as unknown as { document: Doc }).document.querySelectorAll("[data-bar-width-probe] > button")).map((b) => b.getBoundingClientRect().width),
  );
  assert.equal(widths.length, 3, "the page draws no hidden buttons to measure");
  return Math.max(304, Math.ceil(26 + widths.reduce((sum, w) => sum + w / scale, 0) + 2 * 4) + 1);
}

/** The tops of a window's buttons, by their words, so a test can tell which share a line. */
async function buttonTops(bar: Locator, names: readonly (string | RegExp)[]): Promise<number[]> {
  const tops: number[] = [];
  for (const name of names) tops.push((await rectOf(bar.getByRole("button", typeof name === "string" ? { name, exact: true } : { name }))).top);
  return tops;
}

function oneTop(tops: readonly number[]): boolean {
  return tops.every((t) => Math.abs(t - tops[0]!) < 1);
}

describe("raccoon-vtt: the docked token action bar", { timeout: 900_000 }, () => {
  before(openBrowsers);
  after(closeAll);

  test("1. a DM's room with Pat's Thorn, three goblins and one far in the corner", createRoom);


  for (const view of [
    { ...DESK, scale: 1 },
    { ...DESK, scale: 1.3 },
    { width: 1024, height: 768, scale: 1 },
    { width: 1024, height: 768, scale: 1.3 },
    { width: 820, height: 1180, scale: 1 },
    { width: 820, height: 1180, scale: 1.3 },
  ]) {
    const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
    test(`2. the single and group bars dock in one spot clear of the bars and the side panel, and another token's tap does not move it: ${label}`, async () => {
      await setUp(dm, view);
      await selectThorn();
      assert.equal(await barFrame(dm).getAttribute("data-bar-mode"), "dock", `${label}: the bar does not dock`);
      const one = await barRect(dm);
      const c = await chrome(dm);
      assert.ok(one.top >= c.top - 0.5, `${label}: the bar (top ${one.top}) runs under the top bar (${c.top})`);
      assert.ok(one.bottom <= c.toolbar + 0.5, `${label}: the bar (bottom ${one.bottom}) runs under the toolbar (${c.toolbar})`);
      assert.ok(one.right <= (c.panel ?? c.width) + 0.5, `${label}: the bar (right ${one.right}) runs under the side panel or off the window`);
      assert.ok(one.left >= -0.5, `${label}: the bar leaves the window`);
      // Its default spot is the free area's bottom right, 8 layout px from the bars and the side panel.
      assert.ok(Math.abs((c.panel ?? c.width) - one.right - 8 * view.scale) <= 1.5, `${label}: the bar is not at the right: ${JSON.stringify({ one, c })}`);
      assert.ok(c.toolbar - one.bottom <= 8 * view.scale + 1.5, `${label}: the bar is not at the bottom: ${JSON.stringify({ one, c })}`);

      await clickCell(dm, run.goblins[0]!);
      await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
      const other = await barRect(dm);
      assert.ok(Math.abs(other.right - one.right) <= 1 && Math.abs(other.bottom - one.bottom) <= 1, `${label}: another token's bar moved: ${JSON.stringify({ one, other })}`);
      await clickCell(dm, run.thorn, ["Shift"]);
      await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
      const group = await barRect(dm);
      assert.ok(Math.abs(group.right - one.right) <= 1 && Math.abs(group.bottom - one.bottom) <= 1, `${label}: the group's bar sits elsewhere: ${JSON.stringify({ one, group })}`);
      if (view.width === DESK.width && view.scale === 1) await shots.take(dm, "bardock-docked-group-1280");
      if (view.width === 820 && view.scale === 1) await shots.take(dm, "bardock-docked-group-820");
      await clickCell(dm, EMPTY);
      await barFrame(dm).waitFor({ state: "detached" });
    });
  }

  test("3. a mouse and a touch drag by the header move the bar, a short tap on it does nothing, the free area holds it, and a drop on the column lands under the first card", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const start = await barRect(dm);

    // A press on the header that moves under 8 px neither moves the bar nor closes it.
    await dm.mouse.move(start.left + 40, start.top + 26);
    await dm.mouse.down();
    await dm.mouse.move(start.left + 45, start.top + 28, { steps: 2 });
    await dm.mouse.up();
    const still = await barRect(dm);
    assert.ok(Math.abs(still.left - start.left) < 0.5 && Math.abs(still.top - start.top) < 0.5, "a tap on the header moved the bar");
    assert.equal(await storedSpot(dm), null, "a tap on the header stored a spot");
    // Nor does a press on the grip, Move window, that moves under 8 px: a tap on it does nothing.
    const grip = await rectOf(barFrame(dm).getByRole("button", { name: "Move window", exact: true }));
    await dm.mouse.move(grip.left + 22, grip.top + 22);
    await dm.mouse.down();
    await dm.mouse.move(grip.left + 27, grip.top + 24, { steps: 2 });
    await dm.mouse.up();
    const pressed = await barRect(dm);
    assert.ok(Math.abs(pressed.left - start.left) < 0.5 && Math.abs(pressed.top - start.top) < 0.5, "a short press on the grip moved the window");
    assert.equal(await storedSpot(dm), null, "a short press on the grip stored a spot");
    assert.ok(await dm.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "a press on the grip closed the window");
    // A drag that starts on the grip moves the window, as one on the header does.
    await dm.mouse.move(grip.left + 22, grip.top + 22);
    await dm.mouse.down();
    await dm.mouse.move(grip.left + 34, grip.top + 26, { steps: 2 });
    await dm.mouse.move(grip.left - 300, grip.top - 200, { steps: 10 });
    await dm.mouse.up();
    const byGrip = await barRect(dm);
    assert.ok(byGrip.left < start.left - 200 && byGrip.top < start.top - 100, `a drag by the grip did not move the window: ${JSON.stringify({ start, byGrip })}`);
    assert.match((await storedSpot(dm)) ?? "", /^\{"corner":"[tb][lr]","x":\d+,"y":\d+\}$/);
    await dragHeader(dm, { x: 2000, y: 2000 });
    assert.equal(await storedSpot(dm), null, "a drop near the bottom right is the default spot");

    await dragHeader(dm, { x: 300, y: 300 });
    const moved = await barRect(dm);
    assert.ok(moved.left < start.left - 100, `the mouse drag did not move the bar: ${JSON.stringify({ start, moved })}`);
    assert.match((await storedSpot(dm)) ?? "", /^\{"corner":"[tb][lr]","x":\d+,"y":\d+\}$/);
    await shots.take(dm, "bardock-dragged-mouse");

    // Past every edge, the bar stays in the free area: under the top bar, above the toolbar, left of the side panel.
    const c = await chrome(dm);
    await dragHeader(dm, { x: 2, y: 2 });
    const topLeft = await barRect(dm);
    assert.ok(topLeft.left >= 7.5 && topLeft.top >= c.top + 7.5, `dragged past the top left: ${JSON.stringify({ topLeft, c })}`);
    assert.equal(await storedSpot(dm), '{"corner":"tl","x":0,"y":0}');
    await dragHeader(dm, { x: c.width - 2, y: c.height - 2 });
    const bottomRight = await barRect(dm);
    assert.ok(bottomRight.right <= (c.panel ?? c.width) - 7.5 && bottomRight.bottom <= c.toolbar - 7.5, `dragged past the bottom right: ${JSON.stringify({ bottomRight, c })}`);
    assert.equal(await storedSpot(dm), null, "a drop near the bottom right is the default spot, stored as no key");

    // A touch drag, on Pat's tablet.
    await setUp(player, { width: 820, height: 1180, scale: 1 });
    await selectThorn(player);
    const touchStart = await barRect(player);
    await touchDrag(playerCdp, { x: touchStart.left + 40, y: touchStart.top + 26 }, { x: 200, y: 300 });
    const touched = await barRect(player);
    assert.ok(touched.left < touchStart.left - 100 && touched.top < touchStart.top, `the touch drag did not move the bar: ${JSON.stringify({ touchStart, touched })}`);
    assert.ok(await player.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "the touch drag closed the bar");
    await shots.take(player, "bardock-dragged-touch");
    await player.evaluate((key) => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem(key), SPOT_KEY);

    // A concentration check for a goblin the DM answers for puts a card in the column, and a drop on it lands under it.
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblins[0]!.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    await ops.send({ t: "actor.hp", target: { tokenId: run.goblins[0]!.id }, change: { kind: "damage", amount: 1 } });
    const prompt = dm.locator('[data-alert="concentration"]').first();
    await prompt.waitFor();
    const first = await rectOf(prompt);
    await dragHeader(dm, { x: first.left + 40, y: first.top + 10 });
    const dropped = await barRect(dm);
    assert.ok(dropped.top >= first.bottom + 8 - 1, `the bar dropped on the column did not move under its first card: ${JSON.stringify({ first, dropped })}`);
    assert.ok(!intersects(dropped, first), "the bar covers the first card");
    await shots.take(dm, "bardock-dropped-on-column");
    await dm.getByRole("button", { name: "Passed" }).first().click();
    await prompt.waitFor({ state: "detached" });
    await dm.getByRole("button", { name: "Reset window position and size", exact: true }).click();
  });

  test("4. the grip's arrow keys move the window and no token, the status says where once the keys rest, Reset in the header brings it home with focus on Close, this device remembers the spot through a reload, a resize and a new interface size, and Escape puts a dragged bar back", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const home = await barRect(dm);
    const frame = barFrame(dm);
    const resetButton = frame.getByRole("button", { name: "Reset window position and size", exact: true });
    assert.equal(await resetButton.count(), 0, "Reset shows at the default spot");

    // From the frame, Tab reaches Move window first.
    await frame.focus();
    await dm.keyboard.press("Tab");
    assert.equal(await focusedName(dm), "Move window");
    const grip = frame.getByRole("button", { name: "Move window", exact: true });
    // Its name shows beside it on keyboard focus, in place of a native title (docs/design-v1-icons.md 3.2).
    await dm.getByRole("tooltip").filter({ hasText: "Move window" }).waitFor();
    const described = await grip.getAttribute("aria-describedby");
    assert.ok(described, "the grip names no description of its keys");
    assert.match((await dm.locator(`[id="${described}"]`).textContent()) ?? "", /^Drag to move the window\. With this focused, the arrow keys move it/);

    // What the status says, each time it says something.
    await dm.evaluate(() => {
      type Node = { textContent: string | null };
      const g = globalThis as unknown as { document: { querySelector(s: string): Node | null }; MutationObserver: new (cb: () => void) => { observe(n: Node, o: object): void }; said: string[] };
      const status = g.document.querySelector('[role="dialog"][data-bar-mode] [role="status"]')!;
      g.said = [];
      new g.MutationObserver(() => {
        const text = status.textContent?.trim() ?? "";
        if (text) g.said.push(text);
      }).observe(status, { childList: true, characterData: true, subtree: true });
    });
    const said = () => dm.evaluate(() => (globalThis as unknown as { said: string[] }).said.splice(0));
    const thornAt = () => ({ x: dmSocket.state?.tokens[run.thorn.id]?.x, y: dmSocket.state?.tokens[run.thorn.id]?.y });
    const thornBefore = thornAt();

    // Three steps left: 24 px, stored as a gap from the bottom right, and said once the keys rest.
    for (let i = 0; i < 3; i++) await dm.keyboard.press("ArrowLeft");
    await dm.waitForTimeout(900);
    const left = await barRect(dm);
    assert.ok(Math.abs(home.left - left.left - 24) < 1 && Math.abs(home.top - left.top) < 1, `three steps left: ${JSON.stringify({ home, left })}`);
    assert.equal(await storedSpot(dm), '{"corner":"br","x":24,"y":0}');
    assert.deepEqual(await said(), ["Window at the bottom edge, 24 pixels from the right"]);
    assert.deepEqual(thornAt(), thornBefore, "the arrow keys moved the selected token");
    assert.equal(await focusedName(dm), "Move window", "the keys took focus off the grip");

    // Shift and ArrowUp: 64 px.
    await dm.keyboard.press("Shift+ArrowUp");
    const up = await barRect(dm);
    assert.ok(Math.abs(left.top - up.top - 64) < 1, `Shift+ArrowUp: ${JSON.stringify({ left, up })}`);
    assert.equal(await storedSpot(dm), '{"corner":"br","x":24,"y":64}');

    // Reset is left of Close on one top, named by its tooltip.
    await resetButton.waitFor();
    const resetBox = await rectOf(resetButton);
    const closeBox = await rectOf(frame.getByRole("button", { name: "Close", exact: true }));
    assert.ok(resetBox.right <= closeBox.left + 0.5 && Math.abs(resetBox.top - closeBox.top) < 1, `Reset is not left of Close: ${JSON.stringify({ resetBox, closeBox })}`);
    await resetButton.hover();
    await dm.getByRole("tooltip").filter({ hasText: "Reset window position and size" }).waitFor();
    await dm.mouse.move(0, 0);
    // The tooltip's wait lets the keys rest, so the status says the Shift+ArrowUp spot before the held key below.
    await dm.waitForTimeout(900);
    assert.deepEqual(await said(), ["Window 24 pixels from the right and 64 pixels from the bottom"]);

    // A held key moves the window to its room's edge and no further.
    await grip.focus();
    for (let i = 0; i < 100; i++) await dm.keyboard.down("ArrowLeft");
    await dm.keyboard.up("ArrowLeft");
    const edge = await barRect(dm);
    const c = await chrome(dm);
    assert.ok(Math.abs(edge.left - 8) < 1, `a held key did not stop at the free area's left edge: ${JSON.stringify(edge)}`);
    await dm.keyboard.press("ArrowLeft");
    assert.ok(Math.abs((await barRect(dm)).left - edge.left) < 0.5, "a step past the edge moved the window");
    assert.match((await storedSpot(dm)) ?? "", /^\{"corner":"bl","x":0,"y":64\}$/);
    assert.ok(edge.bottom <= c.toolbar, "the window left the free area");
    await dm.waitForTimeout(900);
    assert.deepEqual(await said(), ["Window at the left edge, 64 pixels from the bottom"], "a held key was heard more than once");
    assert.deepEqual(thornAt(), thornBefore, "the held key moved the selected token");

    // Enter and Space on the grip change nothing.
    const stored = await storedSpot(dm);
    await dm.keyboard.press("Enter");
    await dm.keyboard.press("Space");
    const after = await barRect(dm);
    assert.ok(Math.abs(after.left - edge.left) < 0.5 && Math.abs(after.top - edge.top) < 0.5, "Enter or Space moved the window");
    assert.equal(await storedSpot(dm), stored);
    assert.ok(await frame.isVisible(), "Enter or Space closed the window");

    // Reset removes the key, brings the window home, focuses Close and says so.
    await resetButton.click();
    await resetButton.waitFor({ state: "detached" });
    assert.equal(await storedSpot(dm), null);
    assert.equal(await focusedName(dm), "Close");
    const back = await barRect(dm);
    assert.ok(Math.abs(back.right - home.right) < 1 && Math.abs(back.bottom - home.bottom) < 1, "Reset did not bring the window home");
    await dm.waitForTimeout(300);
    assert.deepEqual(await said(), ["Window back at bottom right"]);
    await shots.take(dm, "token-window-grip-keys-reset");

    // A reload keeps the spot, and a resize and a new interface size keep the bar in its corner.
    for (const view of [
      { ...DESK, scale: 1 },
      { width: 1024, height: 768, scale: 1 },
      { width: 1024, height: 768, scale: 1.3 },
    ]) {
      await setUp(dm, view, '{"corner":"tl","x":0,"y":0}');
      await selectThorn();
      const r = await barRect(dm);
      const ch = await chrome(dm);
      assert.ok(Math.abs(r.left - 8 * view.scale) <= 1.5 && Math.abs(r.top - ch.top - 8 * view.scale) <= 1.5, `${view.width} x ${view.height} at ${view.scale}: the bar left its corner: ${JSON.stringify({ r, ch })}`);
      assert.equal(await storedSpot(dm), '{"corner":"tl","x":0,"y":0}', "the stored spot changed");
    }
    await shots.take(dm, "bardock-top-left-1024-130");

    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const atHome = await barRect(dm);

    // Escape during a drag puts the bar back where it was and keeps it open.
    await dragHeader(dm, { x: 300, y: 300 }, { escape: true });
    const putBack = await barRect(dm);
    assert.ok(Math.abs(putBack.left - atHome.left) < 1 && Math.abs(putBack.top - atHome.top) < 1, `Escape did not put the bar back: ${JSON.stringify({ atHome, putBack })}`);
    assert.ok(await dm.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "Escape during a drag closed the bar");
    assert.equal(await storedSpot(dm), null, "a drag Escape put back stored a spot");
  });

  test("5. Fit leaves no token under the bar, and Find my token and the outliner land the token clear of it", async () => {
    // A 900 px window, whose map is 540 px wide: without the cover, the middle of the map lies under the bar.
    await setUp(dm, { width: 900, height: 800, scale: 1 });
    await selectThorn();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.waitForTimeout(300);
    const bar = await barRect(dm);
    const all = [run.thorn.id, ...run.goblins.map((g) => g.id), run.far.id];
    const under = (await tokenRects(dm, all)).filter((r) => intersects(r, bar));
    assert.deepEqual(under, [], "Fit left a token under the bar");
    await shots.take(dm, "bardock-fit-900");

    // The outliner's row for the far goblin selects it, opens its bar and frames it clear of where the bar docks.
    await openSideTab(dm, "Outliner");
    await dm.getByRole("tabpanel").getByRole("button", { name: /^Far goblin/ }).first().click();
    await dm.getByRole("dialog", { name: "Far goblin actions" }).waitFor();
    await dm.waitForTimeout(300);
    const outlined = await barRect(dm);
    const [farRect] = await tokenRects(dm, [run.far.id]);
    assert.ok(farRect && !intersects(farRect, outlined), `the outliner framed the token under the bar: ${JSON.stringify({ farRect, outlined })}`);
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();

    // Pat's Find my token, with Thorn's bar open, lands Thorn clear of it.
    await setUp(player, { width: 900, height: 800, scale: 1 });
    await selectThorn(player);
    await player.mouse.move(200, 400);
    await player.mouse.wheel(0, 600);
    await player.getByRole("button", { name: "Find my token" }).click();
    await player.waitForTimeout(300);
    const patBar = await barRect(player);
    const p = await pagePoint(player, run.bounds, { x: run.thorn.x, y: run.thorn.y });
    const q = await pagePoint(player, run.bounds, { x: run.thorn.x + 1, y: run.thorn.y + 1 });
    assert.ok(!intersects({ left: p.x, top: p.y, right: q.x, bottom: q.y }, patBar), `Find my token landed Thorn under the bar: ${JSON.stringify({ p, q, patBar })}`);
    await shots.take(player, "bardock-find-900");
  });

  test("6. in a fight with three concentration checks and a roll card, the bar and the column never meet, and a column the bar cuts short says Scroll for more", async () => {
    await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
    for (const g of run.goblins) await ops.send({ t: "actor.effect.add", target: { tokenId: g.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    await ops.send({ t: "roll.ask", request: { id: run.deskRoll, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    for (const view of [
      { ...DESK, scale: 1 },
      { width: 1024, height: 768, scale: 1.3 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(dm, view);
      // A check comes up as the damage arrives, so a page loaded again has none until the goblins take more.
      await damageGoblins();
      await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
      await selectThorn();
      const bar = await barRect(dm);
      for (const card of await cards(dm)) assert.ok(!intersects(card, bar), `${label}: a card meets the bar: ${JSON.stringify({ card, bar })}`);
      await barFrame(dm).getByRole("button", { name: "Conditions", exact: true }).click();
      await dm.waitForTimeout(200);
      const tall = await barRect(dm);
      for (const card of await cards(dm)) assert.ok(!intersects(card, tall), `${label}: with Conditions open, a card meets the bar: ${JSON.stringify({ card, tall })}`);
      const hint = dm.locator("header").getByText("Scroll for more");
      assert.equal(await hint.count(), 1, `${label}: the column the bar cuts short does not say Scroll for more`);
      const firstCard = await rectOf(dm.locator('[data-alert="concentration"]').first());
      assert.ok(!intersects(firstCard, tall), `${label}: the first card meets the bar`);
      await shots.take(dm, `bardock-lane-${view.width}-${Math.round(view.scale * 100)}`);
    }
  });

  test("7. one token: a click on empty map closes the bar, another token switches it, and a tab, the tool, Fit, an alert card, a right-button pan, the wheel and a held press leave it open", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').first().waitFor();
    await selectThorn();
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await selectThorn();
    await clickCell(dm, run.goblins[1]!);
    await dm.getByRole("dialog", { name: "Goblin 2 actions" }).waitFor();
    const open = dm.getByRole("dialog", { name: "Goblin 2 actions" });

    await dm.getByRole("tab", { name: "Initiative" }).click();
    await dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Select" }).click();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.locator('[data-alert="concentration"]').first().getByText("Concentration save", { exact: true }).click();
    assert.ok(await open.isVisible(), "a tab, the tool, Fit or an alert card closed the bar");

    const at = await cellPoint(dm, EMPTY);
    await dm.mouse.move(at.x, at.y);
    await dm.mouse.down({ button: "right" });
    await dm.mouse.move(at.x + 120, at.y + 60, { steps: 6 });
    await dm.mouse.up({ button: "right" });
    await dm.mouse.wheel(0, -200);
    await dm.waitForTimeout(200);
    assert.ok(await open.isVisible(), "a right-button pan or the wheel closed the bar");

    // A press held until it pings: the ping goes out, and the token stays selected with its bar.
    // Pat's page hears the ping: the server sends a member's own ping to the others.
    const pings = playerSocket.received.length;
    const still = await cellPoint(dm, EMPTY);
    await dm.mouse.move(still.x, still.y);
    await dm.mouse.down();
    await dm.waitForTimeout(900);
    await dm.mouse.up();
    await waitFor("the ping at Pat's page", () => playerSocket.received.slice(pings).some((f) => f.includes('"k":"ping"')) || null, 3_000);
    assert.ok(await open.isVisible(), "a held press that pinged closed the bar");
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
  });

  test("8. Multi-select: a tap off hides the bar and keeps the group, Actions and Done, Escape and a token tapped out, and Details then Escape", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    // A side panel tab other than Token: with the Token tab showing the selection, Escape leaves the group alone.
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await selectThorn();
    await barFrame(dm).getByRole("button", { name: "Multi-select", exact: true }).click();
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();

    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await selectOptions(dm).getByText("2 selected.", { exact: true }).filter({ visible: true }).waitFor();
    const actions = selectOptions(dm).getByRole("button", { name: "Actions", exact: true });
    await actions.waitFor();
    // At 1280 x 800 with Actions shown, the whole sentence shows, uncut, and the row stays one row (docs/design-v1-tool-options.md 9.1).
    // The row's own words, not the hidden description that repeats them or the copy the row measures.
    const words = selectOptions(dm).getByText("Tap tokens to add or remove them, or drag a box on the map.").filter({ visible: true }).first();
    await words.waitFor();
    assert.equal(await words.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth <= (el as unknown as { clientWidth: number }).clientWidth + 1), true, "the sentence is cut");
    const row = await rectOf(selectOptions(dm));
    assert.ok(row.bottom - row.top <= 60, `the Multi-select row wrapped: ${row.bottom - row.top} px`);
    await shots.take(dm, "bardock-several-tapped-off");

    await dm.keyboard.press("Escape");
    await selectOptions(dm).waitFor({ state: "detached" });
    assert.equal(await barFrame(dm).count(), 0, "Escape left a bar");

    // Again, then Actions brings the bar back with focus on its frame.
    await selectThorn();
    await barFrame(dm).getByRole("button", { name: "Multi-select", exact: true }).click();
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await actions.click();
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    assert.equal(await focusedName(dm), "2 selected tokens", "Actions did not focus the bar's frame");

    // A token in the group taken out leaves the hidden bar hidden, and another added shows it.
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await clickCell(dm, run.goblins[0]!);
    await selectOptions(dm).getByText("1 selected.", { exact: true }).filter({ visible: true }).waitFor();
    await dm.waitForTimeout(150);
    assert.equal(await barFrame(dm).count(), 0, "taking a token out showed the bar");
    await clickCell(dm, run.goblins[1]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();

    // Done ends the mode and lets go: no bar, no group.
    await selectOptions(dm).getByRole("button", { name: "Done", exact: true }).click();
    await selectOptions(dm).waitFor({ state: "detached" });
    assert.equal(await barFrame(dm).count(), 0, "Done left a bar");

    // With the mode off, Shift and a click on empty map changes nothing.
    await selectThorn();
    await clickCell(dm, EMPTY, ["Shift"]);
    await dm.waitForTimeout(150);
    assert.ok(await dm.getByRole("dialog", { name: "Thorn actions" }).isVisible(), "Shift and a click on empty map closed the bar");

    // One token in the group: Details, then Escape leaves the token panel showing it and the mode on.
    await barFrame(dm).getByRole("button", { name: "Multi-select", exact: true }).click();
    await barFrame(dm).getByRole("button", { name: "Details", exact: true }).click();
    await barFrame(dm).waitFor({ state: "detached" });
    await dm.getByRole("tab", { name: "Token", selected: true }).waitFor();
    await dm.keyboard.press("Escape");
    await dm.waitForTimeout(150);
    await selectOptions(dm).getByText("1 selected.", { exact: true }).filter({ visible: true }).waitFor();
    assert.ok(await dm.getByRole("tab", { name: "Token", selected: true }).isVisible(), "Escape left the token panel");
    await selectOptions(dm).getByRole("button", { name: "Done", exact: true }).click();
    await selectOptions(dm).waitFor({ state: "detached" });
    await dm.getByRole("tab", { name: "Initiative" }).click();
  });

  test("9. Viewing as Pat stays clear of the column, so Later on the previewed roll card takes the click, and Exit still works in a blackout (LPD-DESK-6)", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    const card = preview.getByRole("dialog", { name: "The DM asks for a roll" });
    await card.waitFor();
    await dm.waitForTimeout(300);
    const notice = await rectOf(preview.getByRole("status").filter({ hasText: "Viewing as Pat." }));
    const previewCard = await rectOf(card);
    assert.ok(!intersects(previewCard, notice), `"Viewing as Pat" covers the roll card: ${JSON.stringify({ previewCard, notice })}`);
    await shots.take(dm, "bardock-viewing-as-pat");
    await card.getByRole("button", { name: "Later" }).click();
    await card.waitFor({ state: "detached" });

    await ops.send({ t: "view.blackout", blackout: true });
    await preview.getByText("The DM has paused the game.").waitFor();
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await ops.send({ t: "view.blackout", blackout: false });
  });

  test("10. a press on the header while checks arrive leaves no card on the bar, nor does a drag Escape put back, and a bar raised in its corner moves down under a tall first card", async () => {
    // Each drag starts with an empty column, so the first card arrives during the press: that is what changes the box the bar publishes. Step 6's roll would already hold the lane.
    await ops.send({ t: "roll.close", rollIds: [run.deskRoll] });
    const empty = async (label: string) => {
      await dm.waitForTimeout(300);
      assert.deepEqual(await cards(dm), [], `${label}: the column is not empty before the press`);
    };
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const prompts = dm.locator('[data-alert="concentration"]');
    const meets = async () => {
      await dm.waitForTimeout(300);
      const bar = await barRect(dm);
      return (await cards(dm)).filter((c) => intersects(c, bar));
    };
    // A plain press: down on the header, the checks arrive, then up.
    await empty("a press");
    let r = await barRect(dm);
    await dm.mouse.move(r.left + 40, r.top + 26);
    await dm.mouse.down();
    await damageGoblins();
    await prompts.nth(2).waitFor();
    await dm.mouse.up();
    assert.deepEqual(await meets(), [], "after a press on the header, a card covers the bar");
    // A drag put back with Escape.
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    await empty("a drag");
    r = await barRect(dm);
    await dm.mouse.move(r.left + 40, r.top + 26);
    await dm.mouse.down();
    await dm.mouse.move(r.left - 60, r.top + 60, { steps: 6 });
    await damageGoblins();
    await prompts.nth(2).waitFor();
    await dm.keyboard.press("Escape");
    await dm.mouse.up();
    assert.deepEqual(await meets(), [], "after a drag Escape put back, a card covers the bar");
    await shots.take(dm, "bardock-press-then-checks");

    // A spot 300 px up the bottom right corner: under the first card the bar moves down to the lane's foot rather than shrinking.
    await setUp(dm, { ...DESK, scale: 1 }, '{"corner":"br","x":0,"y":300}');
    await selectThorn();
    await damageGoblins();
    await prompts.first().waitFor();
    await dm.waitForTimeout(300);
    const bar = await barRect(dm);
    const first = await rectOf(prompts.first());
    const c = await chrome(dm);
    assert.ok(bar.top >= first.bottom + 8 - 1, `the bar meets the first card: ${JSON.stringify({ bar, first })}`);
    const clipped = (await barFrame(dm).getByText("Scroll for more").count()) > 0;
    assert.ok(!clipped || bar.bottom >= c.toolbar - 8 - 1, `the bar shrank with room left below it: ${JSON.stringify({ bar, c })}`);
    await shots.take(dm, "bardock-raised-bar-under-first-card");
  });

  test("11. at 1180 x 390, a token opened from the outliner lands clear of a bar that sits beside the alerts", async () => {
    // A roll card at the column's head, taller than the room the bar would keep under it.
    const ask = randomUUID();
    await ops.send({ t: "roll.ask", request: { id: ask, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    // A layout this short starts with the side panel hidden (docs/design-v1-layout-hierarchy.md 4.1), and this case keeps it shown beside the alerts.
    await sidePanelChoice(dm, "shown");
    await setUp(dm, { width: 1180, height: 390, scale: 1 });
    await dm.locator('[data-alert="rolls"] > *').first().waitFor();
    await openSideTab(dm, "Outliner");
    await dm.getByRole("tabpanel").getByLabel("Search the scene").fill("Goblin 2");
    await dm.getByRole("tabpanel").getByRole("button", { name: /^Goblin 2/ }).first().click();
    await dm.getByRole("dialog", { name: "Goblin 2 actions" }).waitFor();
    await dm.waitForTimeout(300);
    const bar = await barRect(dm);
    const [goblin] = await tokenRects(dm, [run.goblins[1]!.id]);
    assert.ok(goblin && !intersects(goblin, bar), `the outliner landed the goblin under the bar: ${JSON.stringify({ goblin, bar })}`);
    for (const card of await cards(dm)) assert.ok(!intersects(card, bar), "the bar meets a card");
    await shots.take(dm, "bardock-outliner-beside-1180x390");
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await ops.send({ t: "roll.close", rollIds: [ask] });
    await sidePanelChoice(dm, null);
  });

  test("12. after Fit, turning the screen fits the map again against where the bar ends up, the turn band moving included (BD-ASTRA-03, BD-ASTRA-07)", async () => {
    const sceneRect = async (): Promise<Rect> => {
      const a = await pagePoint(dm, run.bounds, { x: 0, y: 0 });
      const b = await pagePoint(dm, run.bounds, { x: run.bounds.w, y: run.bounds.h });
      return { left: a.x, top: a.y, right: b.x, bottom: b.y };
    };
    // A tablet turned upright: the bar spans now and covers nothing for the map, so the map takes the whole width again.
    await setUp(dm, { width: 1024, height: 768, scale: 1.3 });
    await selectThorn();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.waitForTimeout(300);
    await dm.setViewportSize({ width: 768, height: 1024 });
    await barFrame(dm).waitFor();
    await dm.waitForTimeout(1200);
    assert.equal(await barFrame(dm).getAttribute("data-bar-mode"), "span");
    const upright = await sceneRect();
    assert.ok(upright.left >= -1 && upright.right <= 768 + 1, `the refit left the map off screen: ${JSON.stringify(upright)}`);
    assert.ok(Math.abs((upright.left + upright.right) / 2 - 384) <= 2, `the map keeps a cover for a bar that spans now: ${JSON.stringify(upright)}`);
    await shots.take(dm, "bardock-fit-then-upright");
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();

    /*
     * A phone in a fight turned on its side, a concentration check at the
     * column's head. Measured with the turn band still in its own row, the
     * bar would sit beside the check. Once the band moves into the top bar,
     * the free area is 48 px taller and the bar stacks under the check at
     * the right. The map keeps clear of where the bar ends up.
     */
    await setUp(dm, { width: 430, height: 932, scale: 1 });
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').first().waitFor();
    const thorn = await pagePoint(dm, run.bounds, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 });
    const free = await dm.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [thorn.x, thorn.y] as const);
    if (free === "CANVAS") {
      await dm.mouse.click(thorn.x, thorn.y);
    } else {
      await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
      await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
      const outliner = dm.locator('section[aria-label="Outliner"]');
      await outliner.getByLabel("Search the scene").fill("Thorn");
      await outliner.getByRole("button", { name: /^Thorn/ }).first().click();
    }
    await dm.getByRole("dialog", { name: "Thorn actions" }).waitFor();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await dm.waitForTimeout(300);
    const bandBefore = (await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }))).bottom;
    await dm.setViewportSize({ width: 932, height: 420 });
    await dm.waitForTimeout(1200);
    const bandAfter = (await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }))).bottom;
    assert.ok(bandAfter < bandBefore - 20, `the turn band did not move into the top bar: ${bandBefore} then ${bandAfter}`);
    assert.equal(await barFrame(dm).getAttribute("data-bar-mode"), "dock");
    const bar = await barRect(dm);
    const map = await sceneRect();
    assert.ok(!intersects(map, bar), `the refit left the map under the bar: ${JSON.stringify({ map, bar })}`);
    for (const card of await cards(dm)) assert.ok(!intersects(card, bar), "the bar meets a card");
    await shots.take(dm, "bardock-fit-then-sideways-932x420");
    await barFrame(dm).getByRole("button", { name: "Close", exact: true }).click();
  });

  test("13. on a wide screen, Back with Multi-select's bar hidden ends the mode and stays in the room", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    await barFrame(dm).getByRole("button", { name: "Multi-select", exact: true }).click();
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    const url = dm.url();
    await dm.goBack();
    await selectOptions(dm).waitFor({ state: "detached" });
    assert.equal(dm.url(), url, "Back left the room");
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("14. a summary row the turn band moves down keeps the bar below it", async () => {
    await ops.send({ t: "encounter.end" });
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
    await setUp(dm, { width: 320, height: 480, scale: 1.3 });
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
    // The check's card covers most of this small map, so the outliner picks Thorn, as a DM would here.
    await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
    await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
    const outliner = dm.locator('section[aria-label="Outliner"]');
    await outliner.getByLabel("Search the scene").fill("Thorn");
    await outliner.getByRole("button", { name: /^Thorn/ }).first().click();
    await dm.getByRole("dialog", { name: "Thorn actions" }).waitFor();
    const row = dm.getByRole("button", { name: /^Concentration save/ });
    await row.waitFor();
    const below = async (label: string) => {
      await dm.waitForTimeout(300);
      const r = await rectOf(row);
      const bar = await barRect(dm);
      assert.ok(bar.top >= r.bottom + 8 * 1.3 - 1, `${label}: the bar meets the summary row: ${JSON.stringify({ r, bar })}`);
    };
    await below("before the band");
    const header = async () => (await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }))).bottom;
    const without = await header();
    await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
    await waitFor("the turn band", async () => ((await header()) > without + 20 ? true : null));
    await below("with the band");
    await shots.take(dm, "bardock-summary-row-band-320x480");
    await ops.send({ t: "encounter.end" });
    await below("after the band");
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  test("15. the rows: the window is the measured default width, Conditions, Hidden and Multi-select share one line, the passing line leads above it, and Roll and Light follow", async () => {
    const STEADY = ["Conditions", "Hidden", "Multi-select"];
    for (const view of [
      { ...DESK, scale: 1 },
      { ...DESK, scale: 1.3 },
      { width: 1024, height: 768, scale: 1 },
      { width: 1024, height: 768, scale: 1.3 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(dm, view);
      await clickCell(dm, run.goblins[1]!);
      const goblin = dm.getByRole("dialog", { name: "Goblin 2 actions" });
      await goblin.waitFor();
      const r = await barRect(dm);
      const expected = await probeWidth(dm, view.scale);
      assert.ok(expected >= 304, `${label}: ${expected}`);
      assert.ok(Math.abs((r.right - r.left) / view.scale - expected) <= 1, `${label}: the window is ${(r.right - r.left) / view.scale} wide, not the measured ${expected}`);
      assert.ok(oneTop(await buttonTops(goblin, STEADY)), `${label}: Conditions, Hidden and Multi-select wrap`);
      if (view.width === DESK.width && view.scale === 1) await shots.take(dm, "token-window-rows-goblin-1280");
      await clickCell(dm, EMPTY);
      await barFrame(dm).waitFor({ state: "detached" });
    }

    // On a creature a player plays, Roll takes Request a roll's place after Multi-select (docs/design-v1-roll-options.md 4.5), and the single bar has no Request a roll.
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const thornForDm = dm.getByRole("dialog", { name: "Thorn actions" });
    assert.ok(oneTop(await buttonTops(thornForDm, STEADY)), "Thorn's steady line wraps for the DM");
    const multi = await rectOf(thornForDm.getByRole("button", { name: "Multi-select", exact: true }));
    const rollButton = await rectOf(thornForDm.getByRole("button", { name: "Roll", exact: true }));
    assert.ok(rollButton.top >= multi.top - 0.5 && (rollButton.top >= multi.bottom - 0.5 || rollButton.left >= multi.right - 0.5), `Roll follows Multi-select: ${JSON.stringify({ multi, rollButton })}`);
    assert.equal(await thornForDm.getByRole("button", { name: "Request a roll", exact: true }).count(), 0, "Roll replaces Request a roll on the DM's single bar");
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });

    // Pat's Thorn, lit: Conditions and Multi-select on one line, Roll and Light after them. In a fight on his turn, a move puts Undo move and Doesn't count on a line above them.
    await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { light: { bright: 20, dim: 20 } } });
    await waitFor("Thorn's light for Pat", () => (playerSocket.state?.tokens[run.thorn.id]?.light?.bright === 20 ? true : null));
    await setUp(player, { width: 900, height: 800, scale: 1 });
    await selectThorn(player);
    const patThorn = player.getByRole("dialog", { name: "Thorn actions" });
    // Lit, Light is named by its light ("Light: 20 ft bright, 20 ft dim").
    const patLine = ["Conditions", "Multi-select"];
    assert.ok(oneTop(await buttonTops(patThorn, patLine)), "Pat's Conditions and Multi-select wrap");
    const patMulti = await rectOf(patThorn.getByRole("button", { name: "Multi-select", exact: true }));
    for (const after of [patThorn.getByRole("button", { name: "Roll", exact: true }), patThorn.getByRole("button", { name: /^Light/ })]) {
      const r = await rectOf(after);
      assert.ok(r.top >= patMulti.top - 0.5, `Roll and Light follow Multi-select: ${JSON.stringify({ patMulti, r })}`);
    }
    const before = (await buttonTops(patThorn, patLine))[0]! - (await barRect(player)).top;
    await clickCell(player, EMPTY);
    await barFrame(player).waitFor({ state: "detached" });
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.thorn.id, value: 20 }, ...run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i }))] });
    await ops.send({ t: "encounter.next" });
    await waitFor("Thorn's turn for Pat", () => (playerSocket.state?.encounter?.activeEntryId ? true : null));
    const to = { x: run.thorn.x + 1, y: run.thorn.y };
    await dragCells(player, run.bounds, run.thorn, to);
    await waitFor("Thorn moved", () => (playerSocket.state?.tokens[run.thorn.id]?.x === to.x ? true : null));
    await clickCell(player, to);
    await patThorn.waitFor();
    await patThorn.getByRole("button", { name: "Undo move", exact: true }).waitFor();
    // Doesn't count is named by what it does.
    const countsNot = /^The last move doesn't count/;
    const passing = await buttonTops(patThorn, ["Undo move", countsNot]);
    assert.ok(oneTop(passing), "Undo move and Doesn't count are not on one line");
    const steady = await buttonTops(patThorn, patLine);
    assert.ok(oneTop(steady), "the passing line moved Conditions or Multi-select off their line");
    const doesntCount = await rectOf(patThorn.getByRole("button", { name: countsNot }));
    assert.ok(steady[0]! >= doesntCount.bottom - 0.5, "the passing line is not above the steady line");
    assert.ok(steady[0]! - (await barRect(player)).top > before, "the steady line did not move down a line under the passing line");
    await shots.take(player, "token-window-rows-passing-line");
    await clickCell(player, EMPTY);
    await barFrame(player).waitFor({ state: "detached" });
    await ops.send({ t: "encounter.end" });
    await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { x: run.thorn.x, y: run.thorn.y, light: { bright: 0, dim: 0 } } });
    await waitFor("Thorn back", () => (dmSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x ? true : null));

    // A browser minimum font size of 16 px makes the buttons wider: the window takes the wider default, and the three still share one line.
    const profile = path.join(work, "min-font");
    mkdirSync(path.join(profile, "Default"), { recursive: true });
    writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ webkit: { webprefs: { minimum_font_size: 16 } } }));
    const big = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: process.env.E2E_HEADED !== "1", viewport: DESK });
    try {
      await big.addCookies(await dmContext.cookies(server.origin));
      const page = big.pages()[0] ?? (await big.newPage());
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      await clickCell(page, run.goblins[1]!);
      const bigGoblin = page.getByRole("dialog", { name: "Goblin 2 actions" });
      await bigGoblin.waitFor();
      const wide = await barRect(page);
      const measured = await probeWidth(page, 1);
      await setUp(dm, { ...DESK, scale: 1 });
      const normal = await probeWidth(dm, 1);
      assert.ok(measured > normal, `a 16 px minimum font size measures ${measured}, not wider than ${normal}`);
      assert.ok(Math.abs(wide.right - wide.left - measured) <= 1, `the window is ${wide.right - wide.left} wide, not the measured ${measured}`);
      assert.ok(oneTop(await buttonTops(bigGoblin, STEADY)), "with a 16 px minimum font size, Conditions, Hidden and Multi-select wrap");
      await shots.take(page, "token-window-rows-min-font-16");
    } finally {
      await big.close();
    }
  });

  test("16. resizing with a mouse and with the handle's keys, on a computer, and none on a touch tablet", async () => {
    await setUp(dm, { ...DESK, scale: 1 });
    // The handle stands at the corner opposite the spot's, at each of the four corners.
    for (const [corner, at] of [
      ["br", "tl"],
      ["bl", "tr"],
      ["tl", "br"],
      ["tr", "bl"],
    ] as const) {
      await setUp(dm, { ...DESK, scale: 1 }, corner === "br" ? null : `{"corner":"${corner}","x":0,"y":0}`);
      await selectThorn();
      const r = await barRect(dm);
      const h = middle(await rectOf(resizeHandle(dm)));
      const x = at[1] === "l" ? r.left : r.right;
      const y = at[0] === "t" ? r.top : r.bottom;
      assert.ok(Math.abs(h.x - x) <= 1.5 && Math.abs(h.y - y) <= 1.5, `spot ${corner}: the handle is not at the ${at} corner: ${JSON.stringify({ h, r })}`);
      assert.equal(await bands(dm).count(), 2);
    }

    // The top-left handle dragged to 400 x 300.
    await setUp(dm, { ...DESK, scale: 1 });
    await selectThorn();
    const home = await barRect(dm);
    const thornBefore = { x: dmSocket.state?.tokens[run.thorn.id]?.x, y: dmSocket.state?.tokens[run.thorn.id]?.y };
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), -(400 - (home.right - home.left)), home.bottom - home.top - 300);
    let r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - 400) <= 1 && Math.abs(r.bottom - r.top - 300) <= 1, `the drag did not draw 400 x 300: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.right - home.right) < 1 && Math.abs(r.bottom - home.bottom) < 1, "the anchored edges moved");
    assert.equal(await storedSize(dm), '{"w":400,"h":300}');
    assert.equal(await storedSpot(dm), null, "the spot stayed the default");
    // It scrolls inside, its header stays at its top, and "Scroll for more" shows.
    const grip = barFrame(dm).getByRole("button", { name: "Move window", exact: true });
    const gripTop = (await rectOf(grip)).top;
    assert.ok(await barFrame(dm).getByText("Scroll for more").isVisible(), "no Scroll for more");
    assert.ok(await scroller(dm).evaluate((el) => (el as unknown as { scrollHeight: number; clientHeight: number }).scrollHeight > (el as unknown as { clientHeight: number }).clientHeight), "the scroller does not scroll");
    await scroller(dm).evaluate((el) => ((el as unknown as { scrollTop: number; scrollHeight: number }).scrollTop = (el as unknown as { scrollHeight: number }).scrollHeight));
    await dm.waitForTimeout(150);
    assert.ok(Math.abs((await rectOf(grip)).top - gripTop) < 1, "the header scrolled away");
    await shots.take(dm, "token-window-resized-400x300-scrolled");
    await scroller(dm).evaluate((el) => ((el as unknown as { scrollTop: number }).scrollTop = 0));

    // 400 x 250: the short layout, the HP field and Apply in the scroller's view at its top.
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), 0, 50);
    r = await barRect(dm);
    assert.ok(Math.abs(r.bottom - r.top - 250) <= 1, `not 250 tall: ${JSON.stringify(r)}`);
    assert.equal(await storedSize(dm), '{"w":400,"h":250}');
    const view = await rectOf(scroller(dm));
    const field = await rectOf(barFrame(dm).getByRole("textbox", { name: "HP change" }));
    const apply = await rectOf(barFrame(dm).getByRole("button", { name: "Apply", exact: true }));
    assert.equal(await scroller(dm).evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop), 0);
    assert.ok(apply.bottom <= view.bottom && field.top >= view.top, `Apply or the field is out of view: ${JSON.stringify({ view, field, apply })}`);
    const damage = await rectOf(barFrame(dm).getByText("Damage", { exact: true }));
    assert.ok(field.top < damage.top, "the short layout does not put the field first");
    await shots.take(dm, "token-window-resized-400x250-short");
    // The Conditions drawer opens above the rows, and scrolls itself into the shrunk window's view (docs/design-v1-token-window.md 5.7).
    await barFrame(dm).getByRole("button", { name: "Conditions", exact: true }).click();
    const drawer = barFrame(dm).getByRole("group", { name: "Conditions", exact: true });
    await drawer.waitFor();
    await dm.waitForTimeout(200);
    const drawn = await rectOf(drawer);
    const shown = await rectOf(scroller(dm));
    assert.ok(drawn.top < shown.bottom - 20 && drawn.bottom > shown.top + 20, `the drawer opened out of the window's view: ${JSON.stringify({ drawn, shown })}`);
    await barFrame(dm).getByRole("button", { name: "Conditions", exact: true }).click();
    await drawer.waitFor({ state: "detached" });

    // A reload, another token's window and the group window open at 400 wide.
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    await selectThorn();
    assert.ok(Math.abs((await barRect(dm)).right - (await barRect(dm)).left - 400) <= 1, "a reload lost the width");
    await clickCell(dm, run.goblins[0]!);
    await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
    r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - 400) <= 1, "another token's window is not 400 wide");
    await clickCell(dm, run.thorn, ["Shift"]);
    await dm.getByRole("dialog", { name: "2 selected tokens" }).waitFor();
    r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - 400) <= 1, "the group window is not 400 wide");
    await clickCell(dm, EMPTY);
    await barFrame(dm).waitFor({ state: "detached" });
    await selectThorn();

    // The top band changes only the height, the left band only the width.
    const before = await barRect(dm);
    await dragBy(dm, middle(await rectOf(bands(dm).nth(0))), 30, -40);
    let after = await barRect(dm);
    assert.ok(Math.abs(after.bottom - after.top - (before.bottom - before.top) - 40) <= 1 && Math.abs(after.right - after.left - (before.right - before.left)) < 1, `the top band: ${JSON.stringify({ before, after })}`);
    await dragBy(dm, middle(await rectOf(bands(dm).nth(1))), -40, 30);
    const widened = await barRect(dm);
    assert.ok(Math.abs(widened.right - widened.left - (after.right - after.left) - 40) <= 1 && Math.abs(widened.bottom - widened.top - (after.bottom - after.top)) < 1, `the left band: ${JSON.stringify({ after, widened })}`);
    assert.equal(await storedSize(dm), '{"w":440,"h":290}');

    // A short press of the handle changes nothing, and Escape mid-drag puts the size back and stores nothing.
    const stored = await storedSize(dm);
    const h = middle(await rectOf(resizeHandle(dm)));
    await dm.mouse.move(h.x, h.y);
    await dm.mouse.down();
    await dm.mouse.move(h.x - 5, h.y - 3, { steps: 2 });
    await dm.mouse.up();
    after = await barRect(dm);
    assert.ok(Math.abs(after.left - widened.left) < 0.5 && Math.abs(after.top - widened.top) < 0.5, "a short press of the handle resized the window");
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), -120, -60, { escape: true });
    after = await barRect(dm);
    assert.ok(Math.abs(after.left - widened.left) < 0.5 && Math.abs(after.top - widened.top) < 0.5, `Escape did not put the size back: ${JSON.stringify({ widened, after })}`);
    assert.equal(await storedSize(dm), stored);
    assert.ok(await barFrame(dm).isVisible(), "Escape mid-resize closed the window");

    // To the room's top: no height stored. Back within 24 px of the default width: no key. Narrower than the default: it stops there.
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), 0, -2000);
    assert.equal(await storedSize(dm), '{"w":440}');
    const defaultWidth = await probeWidth(dm, 1);
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), 440 - defaultWidth - 10, 0);
    assert.equal(await storedSize(dm), null);
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), 300, 0);
    r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - defaultWidth) <= 1, `a drag narrower than the default did not stop at it: ${r.right - r.left}`);
    assert.equal(await storedSize(dm), null);

    // The focused handle's keys: Left widens by 8, Shift and Up heightens by 64, each stored, and no token moves.
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), 0, (await barRect(dm)).bottom - (await barRect(dm)).top - 300);
    const keyStart = await barRect(dm);
    await resizeHandle(dm).focus();
    await dm.keyboard.press("ArrowLeft");
    let keyed = await barRect(dm);
    assert.ok(Math.abs(keyed.right - keyed.left - (keyStart.right - keyStart.left) - 8) <= 1, "ArrowLeft did not widen by 8");
    assert.equal(await storedSize(dm), `{"w":${defaultWidth + 8},"h":300}`);
    await dm.keyboard.press("Shift+ArrowUp");
    keyed = await barRect(dm);
    assert.ok(Math.abs(keyed.bottom - keyed.top - 364) <= 1, "Shift+ArrowUp did not heighten by 64");
    assert.equal(await storedSize(dm), `{"w":${defaultWidth + 8},"h":364}`);
    await dm.waitForTimeout(800);
    assert.equal((await barFrame(dm).getByRole("status").textContent())?.trim(), `Window ${defaultWidth + 8} by 364 pixels`);
    await dm.waitForTimeout(300);
    assert.deepEqual({ x: dmSocket.state?.tokens[run.thorn.id]?.x, y: dmSocket.state?.tokens[run.thorn.id]?.y }, thornBefore, "the handle's keys moved the selected token");
    await shots.take(dm, "token-window-handle-keys");

    // Reset removes both keys and brings the window home at its default size.
    await barFrame(dm).getByRole("button", { name: "Reset window position and size", exact: true }).click();
    assert.equal(await storedSize(dm), null);
    assert.equal(await storedSpot(dm), null);
    r = await barRect(dm);
    assert.ok(Math.abs(r.right - home.right) < 1 && Math.abs(r.bottom - home.bottom) < 1 && Math.abs(r.top - home.top) < 1 && Math.abs(r.left - home.left) < 1, "Reset did not bring the window home at its size");

    // A touch tablet: no handle, no band, and a stored size neither applied nor shown as Reset.
    await setUp(player, { width: 820, height: 1180, scale: 1 }, null, '{"w":600,"h":200}');
    await selectThorn(player);
    assert.equal(await resizeHandle(player).count(), 0, "a touch tablet has a resize handle");
    assert.equal(await bands(player).count(), 0);
    const touchBar = await barRect(player);
    assert.ok(Math.abs(touchBar.right - touchBar.left - (await probeWidth(player, 1))) <= 1, "a touch tablet took the stored width");
    assert.ok(touchBar.bottom - touchBar.top > 200, "a touch tablet took the stored height");
    assert.equal(await barFrame(player).getByRole("button", { name: "Reset window position and size" }).count(), 0, "a size a touch device ignores shows Reset");
    await clickCell(player, EMPTY);
    await player.evaluate((key) => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem(key), SIZE_KEY);
  });

  test("17. the handle's reach: at the largest size, at each corner, with the side panel shown and hidden, and stacked under a check, the whole disc and both bands are on top", async () => {
    const huge = '{"w":4096,"h":4096}';
    for (const panel of ["shown", "hidden"] as const) {
      await sidePanelChoice(dm, panel);
      for (const corner of ["br", "bl", "tl", "tr"] as const) {
        await setUp(dm, { ...DESK, scale: 1 }, corner === "br" ? null : `{"corner":"${corner}","x":0,"y":0}`, huge);
        await selectThorn();
        await expectHandleOnTop(`side panel ${panel}, ${corner}`);
      }
    }
    await sidePanelChoice(dm, null);
    // Stacked under a concentration check's card.
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblins[0]!.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } }).catch(() => undefined);
    await setUp(dm, { ...DESK, scale: 1 }, null, huge);
    await ops.send({ t: "actor.hp", target: { tokenId: run.goblins[0]!.id }, change: { kind: "damage", amount: 1 } });
    const card = dm.locator('[data-alert="concentration"]').first();
    await card.waitFor();
    await selectThorn();
    const bar = await barRect(dm);
    const first = await rectOf(card);
    assert.ok(bar.top >= first.bottom + 12 - 1, `the stacked window keeps less than 12 px under the card: ${JSON.stringify({ first, bar })}`);
    await expectHandleOnTop("stacked under a check");
    await shots.take(dm, "token-window-largest-stacked");
    await dm.getByRole("button", { name: "Passed" }).first().click();
    await card.waitFor({ state: "detached" });
    await setUp(dm, { ...DESK, scale: 1 });

    async function expectHandleOnTop(label: string): Promise<void> {
      const disc = await rectOf(resizeHandle(dm));
      const c = middle(disc);
      const r = (disc.right - disc.left) / 2 - 0.75;
      const points = [c, { x: c.x - r, y: c.y }, { x: c.x + r, y: c.y }, { x: c.x, y: c.y - r }, { x: c.x, y: c.y + r }];
      for (let i = 0; i < 2; i++) points.push(middle(await rectOf(bands(dm).nth(i))));
      const onTop = await handleOnTop(dm, points);
      assert.deepEqual(onTop, points.map(() => true), `${label}: part of the handle or a band is covered or off the map: ${JSON.stringify({ points, onTop })}`);
    }
  });

  test("18. a smaller room clamps the stored size for the opening and keeps it stored, and the window and the alert cards never meet", async () => {
    const stored = '{"w":1100,"h":700}';
    await sidePanelChoice(dm, "hidden");
    await setUp(dm, { ...DESK, scale: 1 }, null, stored);
    await selectThorn();
    let r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - 1100) <= 1, `with the side panel hidden it is not 1100 wide: ${r.right - r.left}`);
    // S shows the side panel: the window takes its room, 920 less the margins and the handle's reach, and the key stays.
    await dm.keyboard.press("s");
    await dm.waitForTimeout(300);
    r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - 900) <= 1, `beside the side panel it is not its room's 900 wide: ${r.right - r.left}`);
    assert.equal(await storedSize(dm), stored);
    await dm.keyboard.press("s");
    await dm.waitForTimeout(300);
    r = await barRect(dm);
    assert.ok(Math.abs(r.right - r.left - 1100) <= 1, `S again did not bring back 1100: ${r.right - r.left}`);
    // At 130%, 605 x 482, with Reset shown.
    await sidePanelChoice(dm, null);
    await setUp(dm, { ...DESK, scale: 1.3 }, null, stored);
    await selectThorn();
    r = await barRect(dm);
    // 605 x 482 is its room: as wide as that, and as tall as its content up to that.
    assert.ok(Math.abs((r.right - r.left) / 1.3 - 605) <= 1.5 && (r.bottom - r.top) / 1.3 <= 482 + 1.5, `at 130% it is ${(r.right - r.left) / 1.3} x ${(r.bottom - r.top) / 1.3}`);
    const shortOfRoom = (r.bottom - r.top) / 1.3 < 480;
    if (shortOfRoom) assert.ok(await scroller(dm).evaluate((el) => (el as unknown as { scrollHeight: number; clientHeight: number }).scrollHeight <= (el as unknown as { clientHeight: number }).clientHeight + 1), "shorter than its room yet cut off");
    assert.equal(await barFrame(dm).getByRole("button", { name: "Reset window position and size" }).count(), 1);
    await shots.take(dm, "token-window-stored-1100x700-at-130");

    // In a fight with three checks: the default spot with the stored size, after a resize dropped on the column, and at the smallest.
    await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
    for (const g of run.goblins) await ops.send({ t: "actor.effect.add", target: { tokenId: g.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } }).catch(() => undefined);
    await setUp(dm, { ...DESK, scale: 1 }, null, '{"w":600,"h":500}');
    await damageGoblins();
    await dm.locator('[data-alert="concentration"]').nth(2).waitFor();
    await selectThorn();
    const apart = async (label: string) => {
      await dm.waitForTimeout(300);
      const bar = await barRect(dm);
      for (const card of await cards(dm)) assert.ok(!intersects(card, bar), `${label}: a card meets the window: ${JSON.stringify({ card, bar })}`);
    };
    await apart("the stored size");
    const firstCard = await rectOf(dm.locator('[data-alert="concentration"]').first());
    const handle = middle(await rectOf(resizeHandle(dm)));
    await dragBy(dm, handle, 0, firstCard.top + 10 - handle.y);
    await apart("a resize dropped on the column");
    await dragBy(dm, middle(await rectOf(resizeHandle(dm))), 2000, 2000);
    r = await barRect(dm);
    assert.ok(Math.abs(r.bottom - r.top - 152) <= 1, `the smallest is not 152 tall: ${r.bottom - r.top}`);
    await apart("the smallest");
    await shots.take(dm, "token-window-smallest-in-a-fight");
    await ops.send({ t: "encounter.end" });
    await setUp(dm, { ...DESK, scale: 1 });
  });

  test("18b. widening by the side band at each corner keeps the anchored edges while the pointer is down, as wrapped chips take fewer lines", async () => {
    // Goblin 3 with ten statuses: their chips wrap to fewer lines in a wider window, so its content grows shorter mid-drag.
    const goblin = run.goblins[2]!;
    const keys = ["prone", "poisoned", "blinded", "charmed", "deafened", "frightened", "grappled", "restrained", "stunned", "invisible"];
    const ids = keys.map(() => randomUUID());
    for (const [i, key] of keys.entries()) await ops.send({ t: "actor.effect.add", target: { tokenId: goblin.id }, effect: { id: ids[i]!, key } });
    const view = { width: 1920, height: 1080, scale: 1 };
    /*
     * One load, and the header dragged to each corner in turn: a load per
     * corner, after the loads the tests before this one make, would take
     * the DM's session past the server's snapshot budget, and the abuse rule
     * would then close every socket of that session, this file's op socket
     * with them.
     */
    await setUp(dm, view);
    await clickCell(dm, goblin);
    await dm.getByRole("dialog", { name: "Goblin 3 actions" }).waitFor();
    for (const corner of ["br", "tl", "tr", "bl"] as const) {
      if (corner !== "br") {
        // Dragged past the free area's corner, the window stops in it and stores that corner.
        await dragHeader(dm, { x: corner[1] === "l" ? 40 : view.width - 1, y: corner[0] === "t" ? 26 : view.height - 1 });
        await waitFor(`the window stored ${corner}`, async () => ((JSON.parse((await storedSpot(dm)) ?? "{}") as { corner?: string }).corner === corner ? true : null));
      }
      const start = await barRect(dm);
      const band = middle(await rectOf(bands(dm).nth(1)));
      const out = corner[1] === "r" ? -1 : 1;
      await dm.mouse.move(band.x, band.y);
      await dm.mouse.down();
      await dm.mouse.move(band.x + out * 12, band.y, { steps: 2 });
      await dm.mouse.move(band.x + out * 220, band.y, { steps: 10 });
      await dm.waitForTimeout(200);
      const held = await rectOf(barFrame(dm));
      assert.ok(held.right - held.left > start.right - start.left + 150, `${corner}: the band did not widen the window`);
      assert.ok(held.bottom - held.top < start.bottom - start.top - 5, `${corner}: the wider window's content did not grow shorter, so this step tests nothing`);
      if (corner[0] === "b") assert.ok(Math.abs(held.bottom - start.bottom) < 1, `${corner}: the bottom edge moved mid-drag: ${JSON.stringify({ start, held })}`);
      else assert.ok(Math.abs(held.top - start.top) < 1, `${corner}: the top edge moved mid-drag: ${JSON.stringify({ start, held })}`);
      if (corner[1] === "r") assert.ok(Math.abs(held.right - start.right) < 1, `${corner}: the right edge moved mid-drag`);
      else assert.ok(Math.abs(held.left - start.left) < 1, `${corner}: the left edge moved mid-drag`);
      if (corner === "br") await shots.take(dm, "token-window-widening-held-bottom-edge");
      await dm.keyboard.press("Escape");
      await dm.mouse.up();
      assert.equal(await storedSize(dm), null, "Escape stored a size");
    }
    for (const id of ids) await ops.send({ t: "actor.effect.remove", target: { tokenId: goblin.id }, effectId: id });
    await setUp(dm, { ...DESK, scale: 1 });
  });
  test("pl2-b. on a phone at 390, 360 and 320 px, and 390 at 130%, a toast that shows under the alerts column's first card takes the card's left and right edges, not the map's, and keeps to the cards as the screen turns while it shows (docs/design-v1-polish.md R9, PL2-ASTRA-02)", async () => {
    await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
    for (const g of run.goblins) await ops.send({ t: "actor.effect.add", target: { tokenId: g.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    try {
      // Two loads in all, the widths by resizing alone, so the DM's session keeps under the server's snapshot budget (step 18b).
      for (const view of [
        { width: 390, height: 844, scale: 1 },
        { width: 360, height: 740, scale: 1 },
        { width: 320, height: 568, scale: 1 },
        { width: 390, height: 844, scale: 1.3 },
      ]) {
        const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        if (view.width === 390) {
          await setUp(dm, view);
          // A check comes up as the damage arrives, so a page loaded again has none until the goblins take more.
          await damageGoblins();
        } else await dm.setViewportSize({ width: view.width, height: view.height });
        const check = dm.locator('[data-alert="concentration"]').first();
        await check.waitFor();
        await dm.waitForTimeout(300);
        const card = await rectOf(check);
        // Undo says what it took back in a toast: a step of the far goblin's, which leaves the checks be.
        const far = dmSocket.state?.tokens[run.far.id];
        await ops.send({ t: "token.update", tokenId: run.far.id, patch: { x: (far?.x ?? run.far.x) === run.far.x ? run.far.x - 1 : run.far.x } });
        await dm.getByRole("button", { name: "Undo", exact: true }).click();
        const toast = dm.locator('[role="status"]').filter({ hasText: /^(Undid|Nothing to undo|Could not undo)/ }).first();
        await toast.waitFor();
        const t = await rectOf(toast);
        await shots.take(dm, `bardock-pl2-b-toast-under-card-${view.width}-${Math.round(view.scale * 100)}`);
        assert.ok(Math.abs(t.top - (card.bottom + 8 * view.scale)) < 1.5, `${label}: the toast starts at ${t.top}, not 8 px under the card's foot at ${card.bottom}`);
        assert.ok(Math.abs(t.left - card.left) <= 1, `${label}: the toast's left edge is ${(t.left - card.left).toFixed(1)} px off the card's`);
        assert.ok(Math.abs(t.right - card.right) <= 1, `${label}: the toast's right edge is ${(t.right - card.right).toFixed(1)} px off the card's`);
        // Gone before the next width, so the next toast takes a place of its own rather than joining this one's.
        await toast.click();
        await toast.waitFor({ state: "detached" });
      }

      // A toast still showing as the phone turns sideways keeps its top and stands under the cards as they now stand, not at the edges it showed with.
      await setUp(dm, { width: 390, height: 844, scale: 1 });
      await damageGoblins();
      await dm.locator('[data-alert="concentration"]').first().waitFor();
      await dm.waitForTimeout(300);
      await ops.send({ t: "token.update", tokenId: run.far.id, patch: { x: (dmSocket.state?.tokens[run.far.id]?.x ?? run.far.x) === run.far.x ? run.far.x - 1 : run.far.x } });
      await dm.getByRole("button", { name: "Undo", exact: true }).click();
      const live = dm.locator('[role="status"]').filter({ hasText: /^(Undid|Nothing to undo|Could not undo)/ }).first();
      await live.waitFor();
      const upright = await rectOf(live);
      await dm.setViewportSize({ width: 844, height: 390 });
      await dm.waitForTimeout(400);
      assert.ok(await live.isVisible(), "the toast went before the turn could be read");
      const turned = await rectOf(live);
      await shots.take(dm, "bardock-pl2-b-toast-turned-844");
      const card = await rectOf(dm.locator('[data-alert="concentration"]').first());
      assert.ok(Math.abs(turned.top - upright.top) < 1, `the toast moved from ${upright.top} to ${turned.top} as the screen turned`);
      assert.ok(Math.abs(turned.left - card.left) <= 1, `turned, the toast's left edge is ${(turned.left - card.left).toFixed(1)} px off the card's`);
      assert.ok(Math.abs(turned.right - card.right) <= 1, `turned, the toast's right edge is ${(turned.right - card.right).toFixed(1)} px off the card's`);
      await live.click();
    } finally {
      await ops.send({ t: "encounter.end" });
      await setUp(dm, { ...DESK, scale: 1 });
    }
  });

  test("20. nothing went wrong in the browsers", assertNoConsoleErrors);
});
