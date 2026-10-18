import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openSideTab, pagePoint, pickTool, Touches, waitFor, wholeInReach } from "./harness.ts";
import {
  assertNoConsoleErrors,
  closeAll,
  closePopover,
  closeShownSheet,
  createRoom,
  DESK,
  dm,
  dmCdp,
  dmSocket,
  dragCellsTouch,
  key,
  openBrowsers,
  ops,
  options,
  type PageDoc,
  pick,
  player,
  playerCdp,
  playerSocket,
  pressSlot,
  reloadAt,
  run,
  selectTool,
  shots,
  SIZES,
  tapCellAt,
  tools,
  view,
} from "./optionsRoom.ts";

/**
 * Tool options in one row (docs/design-v1-tool-options.md section 14): the
 * rules that keep things still under the finger, the popovers, the
 * toolbar's Setup, pair and tuck, the measured box and the names. Case 2,
 * the reach sweep over every tool state at every size, runs in the files
 * options-*.e2e.ts, one sweep each, on this file's room and browsers
 * (optionsRoom.ts).
 *
 * It and the sweep files run on E2E_PORT plus fifteen, one file after
 * another as the others.
 *
 * Not always here, and why:
 * - The side panel's More comes with docs/design-v1-panel-tabs.md. Case 4
 *   presses it only where that build has made it. Until then the base's
 *   one-open-popover rule across consumers is tested in
 *   client/components/popover.test.ts.
 * - Safari's own focus on a tapped button, and the on-screen keyboard over
 *   a popover's field, are checked by hand on an iPhone (14).
 */

describe("raccoon-vtt tool options in one row", { timeout: 3_600_000 }, () => {
  before(openBrowsers);
  after(closeAll);

  test("1. a DM's room with Pat's Thorn, goblins, ten of Pat's kept rulers, a map image, a stamp and a journal page", createRoom);

  test("3. nothing moves under the finger", async () => {
    await reloadAt(dm, 1);
    await view(dm, dmCdp, SIZES[1]!);
    // A tool's first frame already stands in its arrangement: read before any paint after the key.
    const firstFrame = await dm.evaluate(async () => {
      const g = globalThis as unknown as { document: PageDoc; requestAnimationFrame(cb: () => void): number; KeyboardEvent: new (type: string, init: object) => unknown };
      const seen: (string | null)[] = [];
      const read = () => seen.push(g.document.querySelector('[role="toolbar"][data-rvtt-arrangement]')?.getAttribute("data-rvtt-arrangement") ?? null);
      g.document.dispatchEvent(new g.KeyboardEvent("keydown", { key: "d", code: "KeyD", bubbles: true }));
      await new Promise<void>((resolve) => g.requestAnimationFrame(() => (read(), resolve())));
      return seen;
    });
    assert.deepEqual(firstFrame, ["stacked"], "Draw's first frame is already stacked");

    // Picking Eraser in the drawing tool popover leaves Undo where it was.
    const undo = options(dm).locator('[data-options-row] [data-rvtt-slot="undo"]');
    const before = await undo.boundingBox();
    await pick(dm, "Draw", "Drawing tool", "Eraser");
    assert.deepEqual(await undo.boundingBox(), before, "Undo stays put");
    await pick(dm, "Draw", "Drawing tool", "Pen");

    // Keeping a ruler leaves Keep and Clear where they were.
    await selectTool(dm, "r");
    const keep = options(dm).locator('[data-rvtt-slot="keep"]');
    const clear = options(dm).locator('[data-rvtt-slot="clear"]');
    await dragCellsTouch(dm, { x: 18, y: 2 }, { x: 22, y: 2 });
    const keepAt = await keep.boundingBox();
    const clearAt = await clear.boundingBox();
    await keep.locator("button").tap();
    await dm.waitForTimeout(300);
    assert.deepEqual([await keep.boundingBox(), await clear.boundingBox()], [keepAt, clearAt], "Keep and Clear stay put");

    // The first tap on a stamp's Delete leaves its box.
    await view(dm, dmCdp, DESK);
    await selectTool(dm, "b");
    await pick(dm, "Map builder", "Builder mode", "Stamp");
    await tapCellAt(dm, { x: 14, y: 3 });
    const del = options(dm).locator('[data-options-row] [data-rvtt-slot="delete"] button');
    await del.waitFor();
    const delAt = await del.boundingBox();
    await del.tap();
    assert.deepEqual(await del.boundingBox(), delAt, "the armed Delete keeps its box");
    await pressSlot(dm, "stampDone");

    // The first tap on Clear build in ⋯ leaves its box.
    await options(dm).locator("[data-rvtt-more] button").first().tap();
    const clearBuild = dm.getByRole("dialog", { name: "More Map builder options" }).getByRole("button", { name: "Clear build" });
    const clearBuildAt = await clearBuild.boundingBox();
    await clearBuild.tap();
    const armed = dm.getByRole("dialog", { name: "More Map builder options" }).getByRole("button", { name: /Tap again to clear/ });
    assert.deepEqual(await armed.boundingBox(), clearBuildAt, "the armed Clear build keeps its box");
    await closePopover(dm);
    await pick(dm, "Map builder", "Builder mode", "Brush");

    // A popover's controls stay put while Area's reminders grow it.
    await selectTool(dm, "a");
    await tapCellAt(dm, { x: 20, y: 12 });
    await options(dm).locator("[data-rvtt-more] button").first().tap();
    const more = dm.getByRole("dialog", { name: "More Area options" });
    const enters = more.getByRole("button", { name: /Remind when a creature enters/ });
    const boxBefore = await more.boundingBox();
    const entersAt = await enters.boundingBox();
    await enters.tap();
    await dm.waitForTimeout(200);
    assert.deepEqual(await more.boundingBox(), boxBefore, "the popover's box stays as it was");
    assert.deepEqual(await enters.boundingBox(), entersAt, "the reminder stays under the finger");
    await closePopover(dm);
    await key(dm, "v");
  });

  test("4. popovers open and close as the base says", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await selectTool(dm, "d");
    const stroke = options(dm).getByRole("button", { name: /^Stroke:/ });
    // A tap opens, a second closes.
    await stroke.tap();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor();
    await stroke.tap();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    // A tap puts focus on the chip, and Enter puts it inside, on the chosen option.
    await stroke.tap();
    assert.equal(await stroke.evaluate((b) => b === b.ownerDocument.activeElement), true, "a tap focuses the chip");
    await dm.keyboard.press("Escape");
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    assert.equal(await stroke.evaluate((b) => b === b.ownerDocument.activeElement), true, "Escape returns focus to the chip");
    await dm.keyboard.press("Enter");
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor();
    assert.equal(await dm.evaluate(() => (globalThis as unknown as { document: PageDoc }).document.activeElement?.getAttribute("value")), "4", "Enter moves focus to the chosen width, Mid");
    await dm.keyboard.press("Escape");

    // Two fingers pan with the popover open, arriving 50 ms apart, and it stays open, also when one lifts first.
    await stroke.tap();
    const map = await dm.locator(".konvajs-content").boundingBox();
    assert.ok(map);
    const cx = map.x + map.width / 2;
    const cy = map.y + map.height / 3;
    const touches = new Touches(dmCdp);
    await touches.start([{ x: cx, y: cy, id: 1 }]);
    await touches.start([{ x: cx, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }], 50);
    await touches.move([{ x: cx + 20, y: cy + 10, id: 1 }, { x: cx + 80, y: cy + 10, id: 2 }]);
    await touches.end([{ x: cx + 80, y: cy + 10, id: 2 }]);
    await touches.end();
    await dm.waitForTimeout(200);
    assert.ok(await dm.getByRole("dialog", { name: "Stroke" }).isVisible(), "a pinch leaves the popover open");

    // One finger on the map closes it as the finger lifts, and draws nothing.
    const drawings = Object.keys(dmSocket.state?.drawings ?? {}).length;
    await touches.start([{ x: cx, y: cy, id: 3 }]);
    for (let i = 1; i <= 4; i++) await touches.move([{ x: cx + i * 10, y: cy + i * 10, id: 3 }]);
    assert.ok(await dm.getByRole("dialog", { name: "Stroke" }).isVisible(), "still open while the finger is down");
    await touches.end();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    await dm.waitForTimeout(300);
    assert.equal(Object.keys(dmSocket.state?.drawings ?? {}).length, drawings, "the press drew nothing");

    // The wheel leaves it open, and a tool key closes it.
    await stroke.tap();
    await dm.mouse.move(cx, cy);
    await dm.mouse.wheel(0, 120);
    await dm.waitForTimeout(150);
    assert.ok(await dm.getByRole("dialog", { name: "Stroke" }).isVisible(), "the wheel leaves it open");
    await dm.keyboard.press("r");
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });

    // The arrows in the drawing tool popover change the tool without closing it.
    await selectTool(dm, "d");
    const chip = options(dm).getByRole("button", { name: /^Drawing tool:/ });
    await chip.focus();
    await dm.keyboard.press("Enter");
    const tiles = dm.getByRole("dialog", { name: "Drawing tool" });
    await tiles.waitFor();
    await dm.keyboard.press("ArrowRight");
    await dm.waitForTimeout(100);
    assert.ok(await tiles.isVisible(), "an arrow keeps it open");
    assert.equal(await chip.getAttribute("aria-label"), "Drawing tool: Line", "and changes the tool");
    await dm.keyboard.press("Enter");
    await tiles.waitFor({ state: "detached" });
    await pick(dm, "Draw", "Drawing tool", "Pen");

    // With Ping and the Tools menu, a tap on the map sends no ping: here Setup at 390, which stands where Tools does.
    await selectTool(dm, "p");
    const pings = playerSocket.received.length;
    await tools(dm).getByRole("button", { name: "Setup tools" }).tap();
    await dm.getByRole("menu", { name: "Setup tools" }).waitFor();
    await dm.touchscreen.tap(cx, cy);
    await dm.getByRole("menu", { name: "Setup tools" }).waitFor({ state: "detached" });
    await dm.waitForTimeout(400);
    assert.ok(!playerSocket.received.slice(pings).some((m) => JSON.stringify(m).includes('"k":"ping"')), "the press that closed the menu sent no ping");

    // Back closes it before the room.
    await selectTool(dm, "d");
    await stroke.tap();
    await dm.goBack();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    assert.ok(dm.url().includes(`/r/`), "Back stayed in the room");

    // A phone sheet opening closes it.
    await stroke.tap();
    await tools(dm).getByRole("button", { name: "Panels" }).tap();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    await closeShownSheet(dm);

    // Turning the phone places it again, or closes it where its anchor is gone (Setup in the pair).
    await tools(dm).getByRole("button", { name: "Setup tools" }).tap();
    await view(dm, dmCdp, SIZES[2]!);
    await dm.getByRole("menu", { name: "Setup tools" }).waitFor({ state: "detached" });
    await view(dm, dmCdp, SIZES[1]!);

    // Across consumers, one popover in the room (7.1): the side panel's More, where the panel tabs build has made it, closes a tool popover and the other way round, and a tap on the map with More open sends no ping.
    await view(dm, dmCdp, DESK);
    // More is the tab with a menu, named "More panels" or by the panel it holds that is open.
    const moreTab = dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]');
    if ((await moreTab.count()) > 0) {
      await selectTool(dm, "d");
      await options(dm).getByRole("button", { name: /^Stroke:/ }).click();
      await dm.getByRole("dialog", { name: "Stroke" }).waitFor();
      await moreTab.click();
      const menu = dm.getByRole("menu", { name: "More panels" });
      await menu.waitFor();
      await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
      await options(dm).getByRole("button", { name: /^Stroke:/ }).click();
      await menu.waitFor({ state: "detached" });
      await closePopover(dm);
      await selectTool(dm, "p");
      await moreTab.click();
      await menu.waitFor();
      const before = playerSocket.received.length;
      const desk = await dm.locator(".konvajs-content").boundingBox();
      assert.ok(desk);
      await dm.mouse.click(desk.x + desk.width / 2, desk.y + desk.height / 3);
      await menu.waitFor({ state: "detached" });
      await dm.waitForTimeout(400);
      assert.ok(!playerSocket.received.slice(before).some((m) => JSON.stringify(m).includes('"k":"ping"')), "the click that closed More sent no ping");
      await key(dm, "v");
    } else console.error("the side panel has no More in this build: its popover cases wait for the panel tabs build");

    // At 480 x 320 at 130% in a fight, the shape popover still shows its title and a row.
    await reloadAt(dm, 1.3);
    await view(dm, dmCdp, SIZES[4]!);
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.goblins[0]!, value: 12 }] });
    await selectTool(dm, "a");
    await options(dm).getByRole("button", { name: /^Shape:/ }).tap();
    const shape = dm.getByRole("dialog", { name: "Shape" });
    await shape.waitFor();
    const title = await shape.getByText("Shape", { exact: true }).first().boundingBox();
    const tile = await shape.getByRole("radio").first().boundingBox();
    const box = await shape.boundingBox();
    assert.ok(title && tile && box && title.y >= box.y && tile.y + tile.height <= box.y + box.height + 1, "the title and a row show");
    await shots.take(dm, "options-480x320-130-fight-shape");
    await closePopover(dm);
    await ops.send({ t: "encounter.end" });
    await reloadAt(dm, 1);
  });

  test("4b. dismissed spell results stay closed until the words change, the field is pressed or Down asks", async () => {
    await reloadAt(dm, 1);
    await view(dm, dmCdp, SIZES[1]!);
    await selectTool(dm, "a");
    const field = options(dm).locator('[data-options-row] input[aria-label="Spell"]');
    const results = dm.getByRole("dialog", { name: "Spells" });
    const stayClosed = async (how: string) => {
      await results.waitFor({ state: "detached" });
      await dm.waitForTimeout(400);
      assert.equal(await results.count(), 0, `${how}: the results opened again by themselves`);
    };
    await field.tap();
    await field.fill("fire");
    await results.waitFor();
    // Escape in the field.
    await dm.keyboard.press("Escape");
    await stayClosed("Escape in the field");
    assert.equal(await field.evaluate((e) => e === e.ownerDocument.activeElement), true, "the field keeps focus");
    // New words ask for them again.
    await dm.keyboard.type("b");
    await results.waitFor();
    // Escape from a result puts focus back on the field and leaves them closed.
    await results.getByRole("button").first().focus();
    await dm.keyboard.press("Escape");
    await stayClosed("Escape from a result");
    assert.equal(await field.evaluate((e) => e === e.ownerDocument.activeElement), true, "focus is back on the field");
    // Down asks for them, and Back dismisses them too.
    await dm.keyboard.press("ArrowDown");
    await results.waitFor();
    await dm.goBack();
    await stayClosed("Back");
    // Shift+Tab from the first result puts focus back on the field and leaves them closed.
    await dm.keyboard.press("ArrowDown");
    await results.waitFor();
    await results.getByRole("button").first().focus();
    await dm.keyboard.press("Shift+Tab");
    await stayClosed("Shift+Tab from a result");
    assert.equal(await field.evaluate((e) => e === e.ownerDocument.activeElement), true, "Shift+Tab put focus on the field");
    // Tab out past the last result, then back to the field: still closed.
    await dm.keyboard.press("ArrowDown");
    await results.waitFor();
    await results.getByRole("button").last().focus();
    await dm.keyboard.press("Tab");
    await stayClosed("Tab out");
    await field.focus();
    await stayClosed("focus back after Tab out");
    // A press outside, on the top bar's room name, then focus back by key: still closed.
    await dm.keyboard.press("ArrowDown");
    await results.waitFor();
    await dm.locator("header h1").first().tap();
    await stayClosed("a press outside");
    await field.focus();
    await stayClosed("focus back after a press outside");
    // A press on the field asks for them.
    await field.tap();
    await results.waitFor();
    await field.fill("");
    await results.waitFor({ state: "detached" });
    await key(dm, "v");
  });

  test("4c. a scene change closes an open popover: a chip's and ⋯", async () => {
    const other = randomUUID();
    await ops.send({ t: "scene.create", scene: { id: other, name: "Elsewhere", bounds: { w: 10, h: 10 }, background: "#2b2b31", fogEnabled: false, autoWalls: "off" } });
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[1]!);
    await selectTool(player, "d");
    const moveTo = async (sceneId: string) => {
      await ops.send({ t: "room.setPlayerScene", sceneId });
      await waitFor("the player on the scene", () => (playerSocket.state?.meta.playerSceneId === sceneId ? true : null));
    };
    await options(player).getByRole("button", { name: /^Color:/ }).tap();
    const color = player.getByRole("dialog", { name: "Color" });
    await color.waitFor();
    await moveTo(other);
    await color.waitFor({ state: "detached" });
    await selectTool(player, "d");
    await options(player).locator("[data-rvtt-more] button").first().tap();
    const more = player.getByRole("dialog", { name: "More Draw options" });
    await more.waitFor();
    await moveTo(run.sceneId);
    await more.waitFor({ state: "detached" });
    await key(player, "v");
    await ops.send({ t: "scene.delete", sceneId: other });
  });

  test("5. the toolbar: Setup, the pair and keys", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await key(dm, "v");
    // Seven buttons and Panels, and no sideways scroll.
    const strip = tools(dm).locator("button");
    assert.equal(await strip.count(), 8);
    assert.ok(
      await dm.evaluate(() => {
        const s = (globalThis as unknown as { document: PageDoc }).document.querySelector('nav[aria-label="Tools"] div[style*="overflow"]')!;
        return s.scrollWidth <= s.clientWidth;
      }),
      "the tools do not scroll",
    );
    const setup = tools(dm).getByRole("button", { name: "Setup tools" });
    // A tap opens the menu with focus on Setup.
    await setup.tap();
    const menu = dm.getByRole("menu", { name: "Setup tools" });
    await menu.waitFor();
    assert.equal(await setup.evaluate((b) => b === b.ownerDocument.activeElement), true);
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    // Enter opens it with focus on the checked tile, else the first.
    await setup.focus();
    await dm.keyboard.press("Enter");
    await menu.waitFor();
    const focused = () => dm.evaluate(() => (globalThis as unknown as { document: PageDoc }).document.activeElement?.textContent ?? "");
    assert.equal(await focused(), "Add token");
    await dm.keyboard.press("ArrowDown");
    assert.equal(await focused(), "Pin");
    await dm.keyboard.press("ArrowRight");
    assert.equal(await focused(), "Map builder");
    await dm.keyboard.press("ArrowUp");
    assert.equal(await focused(), "Pin");
    await dm.keyboard.press("ArrowLeft");
    assert.equal(await focused(), "Add token");
    await dm.keyboard.press("End");
    assert.equal(await focused(), "Line up grid");
    await dm.keyboard.press("Home");
    assert.equal(await focused(), "Add token");
    await dm.keyboard.press("m");
    assert.equal(await focused(), "Map builder");
    // Shift+Tab closes it with focus on Setup, and Tab with focus on Panels.
    await dm.keyboard.press("Shift+Tab");
    await menu.waitFor({ state: "detached" });
    assert.equal(await setup.evaluate((b) => b === b.ownerDocument.activeElement), true);
    await dm.keyboard.press("Enter");
    await menu.waitFor();
    await dm.keyboard.press("Tab");
    await menu.waitFor({ state: "detached" });
    assert.equal(await tools(dm).getByRole("button", { name: "Panels" }).evaluate((b) => b === b.ownerDocument.activeElement), true);
    // Picking Map builder shows Builder on Setup.
    await setup.tap();
    await menu.getByRole("menuitemradio", { name: "Map builder" }).tap();
    await menu.waitFor({ state: "detached" });
    const named = tools(dm).getByRole("button", { name: "Setup tools: Map builder" });
    await named.waitFor();
    assert.match((await named.textContent()) ?? "", /Builder/);
    // T, M, B and G pick directly, outside the menu.
    for (const [letter, id] of [["t", "add-token"], ["m", "pin"], ["g", "grid"], ["b", "build"]] as const) {
      await key(dm, letter);
      await waitFor(`the ${letter} key`, async () => ((await dm.evaluate(() => (globalThis as unknown as { document: PageDoc }).document.querySelector('[role="toolbar"][data-rvtt-arrangement]')?.getAttribute("aria-label"))) ? true : null));
      assert.ok(id);
    }
    await key(dm, "v");

    // Setup over the token's bar (7.5): spanning at 390 x 844, docked at 820 x 1180. Escape closes Setup first and leaves the bar, and a press on the docked window's Conditions closes Setup and opens Conditions. The spanning bar's Conditions stands under the menu, and the window's may too where it docks at the foot, so the window first moves up by its grip and its Reset puts it back after.
    for (const size of [SIZES[1]!, { width: 820, height: 1180, insets: {} }]) {
      await view(dm, dmCdp, size);
      await selectTool(dm, "v");
      const goblin = dmSocket.state!.tokens[run.goblins[1]!]!;
      await tapCellAt(dm, { x: goblin.x, y: goblin.y });
      const bar = dm.getByRole("dialog", { name: "Goblin 2 actions" });
      await bar.waitFor();
      await setup.tap();
      await menu.waitFor();
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      assert.ok(await bar.isVisible(), `${size.width} x ${size.height}: Escape closed the bar with Setup`);
      if (size.width === 820) {
        await bar.getByRole("button", { name: "Move window", exact: true }).focus();
        await dm.keyboard.press("Shift+ArrowUp");
        await dm.keyboard.press("Shift+ArrowUp");
        await setup.tap();
        await menu.waitFor();
        await bar.getByRole("button", { name: "Conditions", exact: true }).click();
        await menu.waitFor({ state: "detached" });
        await bar.getByRole("button", { name: "Conditions", exact: true, pressed: true }).waitFor();
        await bar.getByRole("button", { name: "Reset window position and size", exact: true }).click();
      }
      await dm.keyboard.press("Escape");
      await bar.waitFor({ state: "detached" });
      await key(dm, "v");
    }

    // 844 x 390: the pair. Ruler, the last tool used, is the second button. A tap on it while active opens Tools, Fog takes its place, and R puts Ruler back.
    await key(dm, "r");
    await key(dm, "v");
    await view(dm, dmCdp, SIZES[2]!);
    assert.deepEqual(await tools(dm).locator("button[data-active]").evaluateAll((bs) => bs.map((b) => b.getAttribute("title"))), ["Select", "Ruler", "Panels"]);
    const ruler = tools(dm).getByRole("button", { name: "Ruler" });
    // Its caret shows before its tool is active, and once active its description says it is in use, in place of a pressed state.
    const described = (b: Locator) => b.evaluate((el) => {
      const doc = (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document;
      return (el.getAttribute("aria-describedby") ?? "").split(" ").map((id: string) => doc.getElementById(id)?.textContent ?? "").join(" ");
    });
    // The mark stands in the button's corner, the button's own last child.
    assert.equal(await ruler.locator(":scope > span[aria-hidden] > svg").count(), 1, "the caret shows while Select is active");
    assert.equal(await described(ruler), "Tap it, then again for all tools.");
    await ruler.tap();
    assert.match(await described(ruler), /^In use\. Tap again for all tools\./);
    await ruler.tap();
    const all = dm.getByRole("menu", { name: "Tools" });
    await all.waitFor();
    await all.getByRole("menuitemradio", { name: "Fog" }).tap();
    await tools(dm).getByRole("button", { name: "Fog" }).waitFor();
    await key(dm, "r");
    await tools(dm).getByRole("button", { name: "Ruler" }).waitFor();
    await key(dm, "v");

    // The player at 844 x 390: five tools and the options in one row, and at 130% the pair.
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[2]!);
    await key(player, "r");
    assert.equal(await options(player).getAttribute("data-rvtt-arrangement"), "merged");
    assert.equal(await tools(player).locator("button[data-active]").count(), 6, "five tools and Panels");
    await reloadAt(player, 1.3);
    await view(player, playerCdp, SIZES[2]!);
    await key(player, "r");
    assert.equal(await options(player).getAttribute("data-rvtt-arrangement"), "pair");
    await reloadAt(player, 1);
  });

  test("6. tuck", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    // A DM with Map builder active picks its tile again: the options hide, the tool stays and still paints, and the tile shows them again.
    await selectTool(dm, "b");
    await pick(dm, "Map builder", "Builder mode", "Brush");
    const setup = () => tools(dm).getByRole("button", { name: /^Setup tools/ });
    await setup().tap();
    await dm.getByRole("menuitemradio", { name: "Map builder" }).tap();
    await options(dm).locator("[data-rvtt-tucked]").first().waitFor({ state: "attached" }).catch(() => undefined);
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "tucked");
    assert.match((await setup().getAttribute("aria-label")) ?? "", /Map builder/, "the tool stays");
    assert.ok(await setup().getAttribute("aria-describedby"), "Setup carries the tucked line");
    const built = () => JSON.stringify(dmSocket.state?.buildChunks ?? {});
    const unpainted = built();
    await dragCellsTouch(dm, { x: 12, y: 8 }, { x: 14, y: 8 });
    await waitFor("a stroke painted while tucked", () => (built() !== unpainted ? true : null));
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "still tucked after painting");
    await setup().tap();
    await dm.getByRole("menuitemradio", { name: "Map builder" }).tap();
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null, "shown again");
    // Enter on that tile does the same.
    await setup().focus();
    await dm.keyboard.press("Enter");
    await dm.keyboard.press("Enter");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "tucked by Enter");
    await setup().focus();
    await dm.keyboard.press("Enter");
    await dm.keyboard.press("Enter");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null);
    await key(dm, "v");

    // In the pair the same holds through Tools for the Ruler, and the tuck holds after turning the phone upright.
    await view(dm, dmCdp, SIZES[2]!);
    await key(dm, "r");
    await tools(dm).getByRole("button", { name: "Ruler" }).tap();
    await dm.getByRole("menu", { name: "Tools" }).getByRole("menuitemradio", { name: "Ruler" }).tap();
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "");
    await view(dm, dmCdp, SIZES[1]!);
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "the tuck holds upright");
    await tools(dm).getByRole("button", { name: "Ruler" }).tap();
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null, "the Ruler's own button shows them again");

    // A second tap on Draw tucks: still pressed, described, marked, the map gains 53 px stacked, and the pen still draws.
    await key(dm, "d");
    await pick(dm, "Draw", "Drawing tool", "Pen");
    const draw = tools(dm).getByRole("button", { name: "Draw" });
    const headerBottom = async () => (await dm.locator("header").boundingBox())!;
    const mapFoot = async () => (await options(dm).boundingBox())!.y;
    const footBefore = await mapFoot();
    await draw.tap();
    assert.equal(await draw.getAttribute("aria-pressed"), "true");
    const described = await draw.getAttribute("aria-describedby");
    assert.ok(described);
    assert.equal(await dm.locator(`[id="${described}"]`).textContent(), "Its options are hidden. Press again to show them.");
    const footAfter = await mapFoot();
    assert.ok(Math.abs(footAfter - footBefore - 53) <= 2, `the map gains 53 px (${footAfter - footBefore})`);
    void headerBottom;
    const drawings = () => Object.keys(dmSocket.state?.drawings ?? {}).length;
    const drawn = drawings();
    await dragCellsTouch(dm, { x: 18, y: 6 }, { x: 22, y: 8 });
    await waitFor("a stroke drawn while tucked", () => (drawings() > drawn ? true : null));
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "still tucked after drawing");
    // D brings them back, and picking Ruler shows the Ruler's options.
    await key(dm, "d");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null);
    await draw.tap();
    await key(dm, "r");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null, "a new tool shows its options");

    // Merged, the map's height does not change.
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[2]!);
    await key(player, "d");
    const toolbarTop = async () => (await tools(player).boundingBox())!.y;
    const before = await toolbarTop();
    await tools(player).getByRole("button", { name: "Draw" }).tap();
    assert.equal(await toolbarTop(), before);
    await tools(player).getByRole("button", { name: "Draw" }).tap();

    // With an area waiting for Place, a tuck leaves "Area options hidden. Tap to show.", whose tap brings Place back.
    await key(dm, "a");
    await tapCellAt(dm, { x: 20, y: 12 });
    await tools(dm).getByRole("button", { name: "Area" }).tap();
    const pill = dm.getByRole("button", { name: "Area options hidden. Tap to show." });
    assert.ok(await wholeInReach(pill), "the pill is in reach");
    // The whole pill takes the tap, so a thumb just under its words still lands (LP7-CHROME-3).
    const pillBox = (await dm.locator('[data-options-line="shown"]').boundingBox())!;
    await dm.touchscreen.tap(pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height - 3);
    await options(dm).getByRole("button", { name: "Place", exact: true }).waitFor();
    await key(dm, "v");
  });

  test("7. the box: Fit, the summary row, the roll card and a lasting notice", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await key(dm, "d");
    await dm.getByRole("button", { name: "Fit the map to the screen" }).tap();
    await dm.waitForTimeout(400);
    // The fitted scene stands clear of the row and the line.
    const line = await options(dm).locator("[data-options-line]").boundingBox();
    assert.ok(line);
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const foot = await pagePoint(dm, bounds, { x: 0, y: bounds.h });
    assert.ok(foot.y <= line.y + 1, `the scene's foot (${Math.round(foot.y)}) stands above the line (${Math.round(line.y)})`);

    // A very short sheet opening closes an open popover.
    await view(dm, dmCdp, SIZES[4]!);
    await reloadAt(dm, 1.3);
    await key(dm, "d");
    await options(dm).getByRole("button", { name: /^Drawing tool:/ }).tap();
    await dm.getByRole("dialog", { name: "Drawing tool" }).waitFor();
    await tools(dm).getByRole("button", { name: "Panels" }).tap();
    await dm.getByRole("dialog", { name: "Drawing tool" }).waitFor({ state: "detached" });
    await closeShownSheet(dm);
    await reloadAt(dm, 1);
    await key(dm, "v");
  });

  test("8. names and roles", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await key(dm, "d");
    await options(dm).getByRole("button", { name: "Drawing tool: Pen" }).waitFor();
    await options(dm).getByRole("button", { name: "Drawing tool: Pen" }).tap();
    const dialog = dm.getByRole("dialog", { name: "Drawing tool" });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-modal"), null, "a popover is not modal");
    await dialog.getByRole("radiogroup", { name: "Drawing tool" }).waitFor();
    // The line stays one polite live region while a popover covers it.
    const line = options(dm).locator("[data-options-line]");
    assert.equal(await line.getAttribute("aria-live"), "polite");
    assert.equal(await line.getAttribute("data-options-line"), "hidden");
    await closePopover(dm);

    // A focused control is not moved into ⋯ by a resize.
    await view(dm, dmCdp, DESK);
    const redo = options(dm).locator('[data-options-row] [data-rvtt-slot="redo"] button');
    await redo.focus();
    await view(dm, dmCdp, SIZES[0]!);
    assert.equal(await options(dm).locator('[data-options-row] [data-rvtt-slot="redo"]').count(), 1, "Redo held focus, so it stays in the row");

    // After Discard by keyboard, focus is on the next control in the row where Discard stands there (6.4). At 622 px it waits in ⋯ (13.2), and as a button that ends the task it closes ⋯, so focus goes back to ⋯ (7.2). It never falls to the page.
    await view(dm, dmCdp, DESK);
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true } });
    await selectTool(dm, "f");
    await options(dm).getByRole("button", { name: "Turn fog on" }).waitFor({ state: "detached" });
    await dragCellsTouch(dm, { x: 1, y: 1 }, { x: 3, y: 3 });
    await waitFor("the fog draft", () => (dmSocket.state?.fogDrafts[run.sceneId]?.ops.length ?? 0) > 0 || null);
    await options(dm).locator('[data-rvtt-slot="discard"], [data-rvtt-more]').first().waitFor();
    const inline = options(dm).locator('[data-options-row] [data-rvtt-slot="discard"] button');
    const inMore = (await inline.count()) === 0;
    if (inMore) {
      await options(dm).locator("[data-rvtt-more] button").first().focus();
      await dm.keyboard.press("Enter");
      await dm.getByRole("dialog", { name: "More Fog options" }).waitFor();
      await dm.locator('[role="dialog"] [data-rvtt-slot="discard"] button').first().focus();
    } else await inline.focus();
    await dm.keyboard.press("Enter");
    await dm.locator('[data-rvtt-slot="discard"]').first().waitFor({ state: "detached" });
    const focused = await dm.evaluate(() => {
      const active = (globalThis as unknown as { document: PageDoc }).document.activeElement;
      return {
        slot: active?.closest("[data-rvtt-slot]")?.getAttribute("data-rvtt-slot") ?? null,
        more: active?.closest("[data-rvtt-more]") !== null && active?.closest("[data-rvtt-more]") !== undefined,
        body: active?.tagName === "BODY",
        what: `${active?.tagName} ${active?.getAttribute("aria-label") ?? ""} ${active?.textContent?.slice(0, 40) ?? ""}`,
      };
    });
    assert.ok(!focused.body && (focused.more || (focused.slot !== null && focused.slot !== "discard")), `focus went to the next control${inMore ? " in ⋯" : " in the row"} (${focused.what})`);
    await closePopover(dm);
    await key(dm, "v");
  });

  test("8b. focus in a popover stays there when its control goes, and the row keeps focus in its own room", async () => {
    /** The focused element: its name, and whether it stands inside `within`. */
    const focusIn = (page: Page, within: string) =>
      page.evaluate((sel) => {
        const active = (globalThis as unknown as { document: PageDoc }).document.activeElement;
        return { name: active?.getAttribute("aria-label") ?? active?.textContent ?? "", inside: active?.closest(sel) !== null && active?.closest(sel) !== undefined, body: active?.tagName === "BODY" };
      }, within);

    // A key open puts focus on the first kept ruler's Remove: removing it hands focus to the next one, inside, and so does one reached by Tab.
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[1]!);
    await selectTool(player, "r");
    const chip = options(player).getByRole("button", { name: /^Kept rulers/ });
    await chip.focus();
    await player.keyboard.press("Enter");
    const kept = player.getByRole("dialog", { name: "Kept rulers" });
    await kept.waitFor();
    const removes = kept.getByRole("button", { name: /^Remove the kept ruler/ });
    const count = await removes.count();
    assert.ok(count >= 3, `${count} kept rulers to remove`);
    assert.match((await focusIn(player, "[data-rvtt-popover]")).name, /^Remove the kept ruler/, "the key open put focus on the first ruler");
    await player.keyboard.press("Enter");
    await waitFor("one ruler fewer", async () => ((await removes.count()) === count - 1 ? true : null));
    let at = await focusIn(player, "[data-rvtt-popover]");
    assert.ok(at.inside && /^Remove the kept ruler/.test(at.name), `focus went to the next ruler in the popover, not behind it (${at.name})`);
    await player.keyboard.press("Tab");
    await player.keyboard.press("Enter");
    await waitFor("two rulers fewer", async () => ((await removes.count()) === count - 2 ? true : null));
    at = await focusIn(player, "[data-rvtt-popover]");
    assert.ok(at.inside && !at.body, `focus stayed in the popover after a ruler reached by Tab went (${at.name})`);
    await closePopover(player);
    await key(player, "v");

    // In "Viewing as Pat", over the DM's room with Draw active, ending a text drawing moves focus to the preview's own next control.
    await view(dm, dmCdp, DESK);
    await selectTool(dm, "d");
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    await pickTool(dm, "Draw", preview);
    const previewOptions = preview.getByRole("toolbar", { name: "Draw options" });
    await previewOptions.getByRole("button", { name: /^Drawing tool:/ }).click();
    await dm.getByRole("dialog", { name: "Drawing tool" }).getByRole("radio", { name: "Text", exact: true }).click();
    const map = await preview.locator(".konvajs-content").first().boundingBox();
    assert.ok(map);
    await dm.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
    const text = previewOptions.getByRole("textbox", { name: "Text" });
    await text.waitFor();
    await previewOptions.getByRole("button", { name: "Cancel", exact: true }).focus();
    await dm.keyboard.press("Enter");
    await text.waitFor({ state: "detached" });
    at = await focusIn(dm, 'dialog[aria-label="Viewing as Pat"]');
    assert.ok(at.inside && !at.body, `focus went to the preview's next control, not the room behind it (${at.name})`);
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await key(dm, "v");
  });

  test("8c. focus that leaves a chip through its popover leaves no pin, so a narrower row fits as if it never held focus", async () => {
    await reloadAt(dm, 1.3);
    const inlineIds = () => options(dm).locator("[data-options-row] > [data-rvtt-slot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-rvtt-slot")));
    // The DM's Ruler at 320 x 568 at 130% (230 px) with no focus in the row: Shared and Keep inline, the rest behind ⋯.
    await view(dm, dmCdp, SIZES[0]!);
    await selectTool(dm, "r");
    await dm.waitForTimeout(300);
    const unpinned = await inlineIds();
    // Wider, the kept rulers' chip stands inline: open it by key, then leave straight to a control outside the options.
    await view(dm, dmCdp, DESK);
    const chip = options(dm).getByRole("button", { name: /^Kept rulers/ });
    await chip.focus();
    await dm.keyboard.press("Enter");
    const kept = dm.getByRole("dialog", { name: "Kept rulers" });
    await kept.waitFor();
    await dm.getByRole("button", { name: "Fit the map to the screen" }).focus();
    await kept.waitFor({ state: "detached" });
    await view(dm, dmCdp, SIZES[0]!);
    await dm.waitForTimeout(300);
    assert.deepEqual(await inlineIds(), unpinned, "the chip it left is not pinned, so nothing of higher priority waits for it");
    await key(dm, "v");
    await reloadAt(dm, 1);
  });

  test("9. nothing went wrong in the browsers", assertNoConsoleErrors);
});
