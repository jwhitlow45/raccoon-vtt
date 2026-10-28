import { after, before, describe, test } from "node:test";
import { openSceneGroup, pagePoint, wholeInReach } from "./harness.ts";
import {
  assertNothingOutOfReach,
  canvasAt,
  clearTool,
  closeAll,
  createRoom,
  dm,
  dmCdp,
  dmSocket,
  dmStep,
  expectReach,
  miss,
  misses,
  ONLY,
  ONLY_SCALES,
  openBrowsers,
  ops,
  player,
  reloadAt,
  run,
  SCALES,
  selectHag,
  setFight,
  setShotPage,
  setTool,
  shots,
  type Size,
  sizeLabel,
  sizes,
  TOOLS,
  view,
} from "./reachRoom.ts";

/**
 * Short-screen reach: one sweep over the phone sizes, at 100% and 130%,
 * with and without a fight, a lasting notice, a tool's options and a
 * waiting alert, checking that what a phone must reach takes a tap as it
 * stands, nothing scrolled first:
 *
 * - the way back to an alert: the roll's chip, the alerts column's row, or
 *   the card itself where it shows;
 * - once tapped, the card's own controls (what to roll, Later, the total
 *   and Send; a check's Passed and Failed);
 * - End turn when it shows;
 * - the tool's controls in its one row and ⋯ (the Ruler's, with its kept
 *   rulers behind their chip, or Multi-select's Actions and Done);
 * - the token bar's Close when the bar shows, and Move window beside it
 *   wherever the bar docks as the token window;
 * - beside a phone's sideways sheet, the token window's header at each
 *   width it narrows to, or its Show in the sheet's header where it folds
 *   (docs/design-v1-token-window.md 7.1).
 *
 * One page per side, resized and changed between steps rather than set up
 * again, so the whole matrix runs in minutes. Every miss is collected, so
 * one run names all of them. The player answers a roll and the DM a
 * concentration check: a player has no checks of their own here, and only
 * the DM frames a starting view. What cannot happen is skipped and listed
 * below.
 *
 * Skipped:
 * - the DM's own turn: the DM's band has no End turn;
 * - the Starting view notice for the player, who cannot frame one, and the
 *   reconnecting notice for the DM, whose sweep keeps the server up so the
 *   checks keep coming (the player's sweep covers that notice);
 * - a roll for the DM and a check for the player, as above;
 * - Multi-select, and the bar's Close, where the bars and a notice leave
 *   no map to select the token on, which a viewer could not do either.
 *
 * A target under a lasting notice is a miss like any other: on a short
 * screen the notices that last keep to one line (components/Notice.tsx
 * `compact`), so none stands over the tool's buttons or the toolbar.
 */

describe("raccoon-vtt short-screen reach", { timeout: 1_800_000 }, () => {
  before(openBrowsers);
  after(closeAll);

  test("1. a DM's room with Pat's Thorn, a goblin, a concentrating Hag and ten of Pat's kept rulers", createRoom);

  // The DM: a concentration check for the Hag, with no notice and then under the Starting view notice.
  for (const scale of SCALES.filter((sc) => !ONLY_SCALES || ONLY_SCALES.includes(sc))) {
    test(`3. the DM's check, at ${Math.round(scale * 100)}%: every size, fight, notice and tool`, { skip: ONLY === "player" }, async () => {
      await reloadAt(dm, scale);
      setShotPage(dm);
      const before = misses.length;
      let steps = 0;
      for (const notice of ["none", "Starting view"] as const) {
        for (const size of sizes()) {
          await view(dm, dmCdp, size);
          if (notice === "Starting view" && (await dm.getByRole("group", { name: "Starting view" }).count()) === 0) {
            await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
            await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Scenes", exact: true }).click();
            // A phone starts the Size and view group folded (docs/design-v1-map-discovery.md 8.4).
            await (await openSceneGroup(dm.locator('section[aria-label="Scenes"]'), "Size and view")).getByRole("button", { name: "Save current view" }).tap();
            await dm.getByRole("group", { name: "Starting view" }).waitFor();
          }
          for (const fight of ["none", "fight"] as const) {
            await setFight(fight);
            for (const tool of TOOLS) {
              const label = `DM, ${sizeLabel(size, scale)}, ${fight === "none" ? "no fight" : "fight"}, ${notice === "none" ? "no notice" : "Starting view"}, tool ${tool}`;
              if (await setTool(dm, tool, label, selectHag)) await dmStep(label, tool);
              await clearTool(dm);
              steps += 1;
            }
          }
          if (scale === 1.3 && size.width === 480) await shots.take(dm, `reach-dm-480x320-130-${notice.replace(" ", "-")}`);
        }
        if (notice === "Starting view") await dm.getByRole("group", { name: "Starting view" }).getByRole("button", { name: "Cancel" }).tap();
      }
      await setFight("none");
      console.error(`DM at ${scale}: ${steps} steps, ${misses.length - before} misses`);
    });
  }

  // The DM beside a sideways sheet: the token window narrows with the room the sheet leaves, and folds into the sheet's header where that is too little.
  test("4. beside a sideways sheet, the token window moved off its spot, with and without an elevation badge: a header in one row and Apply clear of the fade, or folded into the sheet's header", { skip: ONLY === "player" }, async () => {
    setShotPage(dm);
    await setFight("none");
    // Phones sideways at 100% and 130% (W5B-P-3). The badge leaves a header too narrow for it for the vitals line, then the grip gives way to its dots, since the DM's phone has no arrow keys.
    const cases = [
      { size: { width: 667, height: 375, insets: {} }, scale: 1, badge: "header", grip: "button", fold: false },
      { size: { width: 844, height: 390, insets: { side: 47, bottom: 21 } }, scale: 1.3, badge: "vitals", grip: "button", fold: false },
      { size: { width: 844, height: 390, insets: { side: 47, bottom: 21 } }, scale: 1.3, badge: null, grip: "button", fold: false },
      { size: { width: 667, height: 375, insets: {} }, scale: 1.3, badge: "vitals", grip: "dots", fold: false },
      { size: { width: 667, height: 375, insets: {} }, scale: 1.3, badge: null, grip: "dots", fold: false },
      { size: { width: 480, height: 320, insets: { side: 47, bottom: 21 } }, scale: 1, badge: "vitals", grip: "button", fold: true },
    ] as const;
    for (const c of cases) {
      const label = `DM beside a sheet, ${sizeLabel(c.size, c.scale)}, ${c.badge ? "with" : "without"} a badge`;
      await ops.send({ t: "token.update", tokenId: run.goblin.id, patch: { elevation: c.badge ? 10 : 0 } });
      await view(dm, dmCdp, c.size);
      // Moved 16 px up from its default, so Reset shows.
      await dm.evaluate(() => localStorage.setItem("rvtt.tokenBarSpot", '{"corner":"br","x":0,"y":16}'));
      await reloadAt(dm, c.scale);
      const fit = dm.getByRole("button", { name: "Fit the map to the screen" });
      if (await wholeInReach(fit)) await fit.tap();
      await dm.waitForTimeout(300);
      const p = await pagePoint(dm, dmSocket.state!.scenes[run.sceneId]!.bounds, { x: 12.5, y: 9.5 });
      if (!(await canvasAt(dm, p))) {
        await miss(`${label}: the goblin is out of reach to select`);
        continue;
      }
      await dm.touchscreen.tap(p.x, p.y);
      const frame = dm.getByRole("dialog", { name: "Goblin 1 actions" });
      await frame.waitFor();
      await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
      await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).tap();
      await dm.locator('section[aria-label="Outliner"]').waitFor();
      await dm.waitForTimeout(400);
      if (c.fold) {
        if (await frame.isVisible()) await miss(`${label}: the window does not fold beside the sheet`);
        const show = dm.getByRole("button", { name: "Show Goblin 1 actions", exact: true });
        await expectReach(label, "Show Goblin 1 actions in the sheet's header", show);
        await shots.take(dm, "reach-token-window-folded-beside-sheet-480x320");
        if (await wholeInReach(show)) {
          await show.tap();
          await frame.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
          if (!(await frame.isVisible())) await miss(`${label}: Show did not bring the window back`);
          const focused = await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute("aria-label") ?? null);
          if (focused !== "Goblin 1 actions") await miss(`${label}: Show left focus on ${focused}, not the window's frame`);
        }
      } else {
        if (!(await frame.isVisible())) {
          await miss(`${label}: the window folded beside the sheet`);
          continue;
        }
        const scroller = frame.locator("[data-bar-scroll]");
        // Apply in view as the window opens, under the header, with nothing scrolled.
        const shown = await scroller.boundingBox();
        const apply = await frame.getByRole("button", { name: "Apply", exact: true }).boundingBox();
        const field = await frame.getByRole("textbox", { name: "HP change" }).boundingBox();
        const top = await scroller.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop);
        if (!shown || !apply || !field || top !== 0 || apply.y + apply.height > shown.y + shown.height + 0.5 || field.y < shown.y) await miss(`${label}: Apply or the HP field is out of view: ${JSON.stringify({ shown, apply, field, top })}`);
        // And its label clear of the words "Scroll for more": each read from its own line of text, so neither the fade's padding nor the button's own counts.
        const covered = await frame.evaluate((el) => {
          type Rect = { top: number; bottom: number };
          type Node = { tagName: string; textContent: string | null; ownerDocument: { createRange(): { selectNodeContents(n: unknown): void; getBoundingClientRect(): Rect } } };
          const nodes = Array.from((el as unknown as { querySelectorAll(s: string): ArrayLike<Node> }).querySelectorAll("button, div"));
          const button = nodes.find((n) => n.tagName === "BUTTON" && n.textContent?.trim() === "Apply");
          // The innermost box that holds the words: the fade's sticky holder holds them too.
          const words = nodes.filter((n) => n.tagName === "DIV" && n.textContent === "Scroll for more").pop();
          if (!button || !words) return null;
          const text = (n: Node) => {
            const range = n.ownerDocument.createRange();
            range.selectNodeContents(n);
            return range.getBoundingClientRect();
          };
          const label = text(button).bottom;
          const wordsTop = text(words).top;
          return label > wordsTop + 0.5 ? { label, wordsTop } : null;
        });
        if (covered) await miss(`${label}: Apply's label runs under "Scroll for more": ${JSON.stringify(covered)}`);
        const grip = frame.getByRole("button", { name: "Move window", exact: true });
        if (c.grip === "button") await expectReach(label, "Move window", grip);
        else if ((await grip.count()) > 0 || (await frame.locator("[data-pane-grip]").count()) === 0) await miss(`${label}: the grip is not its dots`);
        await expectReach(label, "Reset", frame.getByRole("button", { name: "Reset window position and size", exact: true }));
        const close = frame.getByRole("button", { name: "Close", exact: true });
        await expectReach(label, "Close", close);
        const name = await frame.locator("strong").first().boundingBox();
        const closeBox = await close.boundingBox();
        if (name && closeBox && name.y >= closeBox.y + closeBox.height - 1) await miss(`${label}: the name sits under Close, not in the header's one row`);
        // Its lines break only between words, read from the line each letter sits on, and its text keeps the whole name (W5B-P-9).
        const lines = await frame.locator("strong").first().evaluate((el) => {
          type Range = { setStart(n: unknown, i: number): void; setEnd(n: unknown, i: number): void; getBoundingClientRect(): { top: number } };
          const strong = el as unknown as { textContent: string | null; firstChild: { textContent: string | null } | null; ownerDocument: { createRange(): Range } };
          const node = strong.firstChild;
          const text = node?.textContent ?? "";
          const top = (i: number) => {
            const range = strong.ownerDocument.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            return Math.round(range.getBoundingClientRect().top);
          };
          const inWord: number[] = [];
          for (let i = 0; i + 1 < text.length; i++) if (text[i] !== " " && text[i + 1] !== " " && top(i) !== top(i + 1)) inWord.push(i + 1);
          return { name: strong.textContent, inWord };
        });
        if (lines.name !== "Goblin 1" || lines.inWord.length > 0) await miss(`${label}: the name breaks inside a word or lost its text: ${JSON.stringify(lines)}`);
        if (c.badge) {
          const where = (await frame.locator("[data-sticky-header]").getByText("↑10 ft", { exact: true }).count()) > 0 ? "header" : (await frame.locator("[data-vitals]").getByText("↑10 ft", { exact: true }).count()) > 0 ? "vitals" : "nowhere";
          if (where !== c.badge) await miss(`${label}: the elevation badge is in the ${where}, not the ${c.badge}`);
        }
        await shots.take(dm, `reach-token-window-beside-sheet-${c.size.width}x${c.size.height}-${Math.round(c.scale * 100)}-${c.badge ? "badge" : "plain"}`);
        // Size under the steady line here too (the project owner's answer to W5B-P-2).
        const steadyBox = await frame.locator('[data-bar-row="play"]').boundingBox();
        const sizeBox = await frame.getByRole("group", { name: "Size", exact: true }).boundingBox();
        if (!steadyBox || !sizeBox || steadyBox.y + steadyBox.height > sizeBox.y + 1) await miss(`${label}: Size stands above Conditions and Multi-select`);
        for (const name of ["One size smaller", "One size larger"]) {
          const b = frame.getByRole("group", { name: "Size", exact: true }).getByRole("button", { name });
          if ((await b.count()) === 0 || (await b.isDisabled())) continue;
          await b.evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "nearest" }));
          await dm.waitForTimeout(80);
          await expectReach(label, name, b);
        }
        const wide = await scroller.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (el as unknown as { clientWidth: number }).clientWidth + 1);
        if (wide) await miss(`${label}: the window scrolls sideways`);
      }
      const closeSheet = dm.getByRole("button", { name: /^Close Outliner/ }).first();
      if (await closeSheet.isVisible()) await closeSheet.tap();
      const closeWindow = frame.getByRole("button", { name: "Close", exact: true });
      if (await closeWindow.isVisible()) await closeWindow.tap();
    }
    await dm.evaluate(() => localStorage.removeItem("rvtt.tokenBarSpot"));
    await ops.send({ t: "token.update", tokenId: run.goblin.id, patch: { elevation: 0 } });
  });

  test("5. nothing is out of reach", assertNothingOutOfReach);
});
