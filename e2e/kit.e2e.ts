import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { accentFor } from "../client/lib/accent.ts";
import { ConsoleWatch, ROOT, Shots, sleep } from "./harness.ts";

/**
 * The shared components on the dev-only kit page (client/dev/Kit.tsx,
 * docs/design-v1-visual.md 5.3, part 1), with real keys in a real browser:
 * a Segmented or Swatches row is one Tab stop whose arrow keys move and
 * choose, Space flips a Switch, the focus ring shows in the accent and in
 * ink on a highlight Notice, a body folded with `hidden` over an inline
 * display is neither seen nor reached by Tab, a panel's subpage titles
 * the sheet with its own back button and moves focus in and out of it,
 * the sheet keeps room for the dock, a dialog's focus trap treats a radio
 * group as one stop, and a moved row keeps its focus.
 *
 * The kit page exists only in development builds, so this run serves it
 * with Vite's dev server instead of the production build the other runs
 * use. It needs no server and no database.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus one, which it shares with
 * maps.e2e.ts, since the runs go one after another. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 1;
const ORIGIN = `http://localhost:${PORT}`;
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const INK = "rgb(26, 18, 6)";

let vite: ChildProcess;
let viteOutput = "";
let browser: Browser;
let page: Page;
const consoleWatch = new ConsoleWatch("kit");

/** An `#rrggbb` color as getComputedStyle writes it. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function startVite(): Promise<void> {
  vite = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stdout?.on("data", (b: Buffer) => (viteOutput += b.toString("utf8")));
  vite.stderr?.on("data", (b: Buffer) => (viteOutput += b.toString("utf8")));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (vite.exitCode !== null) throw new Error(`Vite exited during startup:\n${viteOutput}`);
    try {
      const res = await fetch(`${ORIGIN}/dev/kit`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Vite did not answer within 30 s:\n${viteOutput}`);
    await sleep(100);
  }
}

/** What has focus: its role, its name and, for a radio, its group and whether it is checked. */
function focused(): Promise<{ tag: string; role: string | null; name: string; group: string | null; checked: boolean | null; value: string | null }> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { activeElement: unknown; getElementById(id: string): { textContent: string | null } | null } }).document;
    const el = doc.activeElement as {
      tagName: string;
      type?: string;
      checked?: boolean;
      value?: string;
      textContent: string | null;
      labels?: ArrayLike<{ textContent: string | null }> | null;
      getAttribute(name: string): string | null;
      closest(selector: string): { getAttribute(name: string): string | null } | null;
    } | null;
    if (!el) return { tag: "", role: null, name: "", group: null, checked: null, value: null };
    const labelledBy = el.getAttribute("aria-labelledby");
    // A field named by a label of its own (`for`), as Field gives it, or by the label around it.
    const label = el.labels?.[0] ?? (el.closest("label") as { textContent: string | null } | null);
    const name = el.getAttribute("aria-label") ?? (labelledBy ? (doc.getElementById(labelledBy)?.textContent ?? "") : (label?.textContent ?? el.textContent ?? ""));
    const group = el.closest('[role="radiogroup"]');
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? (el.type === "radio" ? "radio" : null),
      name: name.trim(),
      group: group ? (group.getAttribute("aria-label") ?? group.getAttribute("aria-labelledby")) : null,
      checked: el.type === "radio" || el.type === "checkbox" ? el.checked === true : null,
      value: el.value ?? null,
    };
  });
}

/** Puts focus on a card itself, so the next Tab lands on the card's first control, as a keyboard user arriving there would. */
async function focusCard(title: string): Promise<void> {
  await page.locator(`section[aria-label="${title}"]`).evaluate((el) => {
    const card = el as unknown as { tabIndex: number; focus(): void };
    card.tabIndex = -1;
    card.focus();
  });
}

/** The outline an element draws, as computed. */
function outline(locator: Locator): Promise<{ style: string; width: string; color: string }> {
  return locator.evaluate((el) => {
    const s = (globalThis as unknown as { getComputedStyle(el: unknown): { outlineStyle: string; outlineWidth: string; outlineColor: string } }).getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
  });
}

describe("raccoon-vtt shared components on the kit page", { timeout: 180_000 }, () => {
  before(async () => {
    await startVite();
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    // Touch as well as a mouse and keys, so a swatch can be tapped (test 12).
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true })).newPage();
    consoleWatch.attach(page);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      console.error(`[${consoleWatch.label}] errors`, consoleWatch.errors, "warnings", consoleWatch.warnings);
      console.error(viteOutput.split("\n").slice(-40).join("\n"));
    }
    await browser?.close();
    if (vite && vite.exitCode === null) {
      const exited = new Promise((resolve) => vite.once("exit", resolve));
      vite.kill("SIGTERM");
      await exited;
    }
  });

  test("1. the kit page shows every component, in the crest yellow, with nothing in the console", async () => {
    await page.goto(`${ORIGIN}/dev/kit`);
    await page.getByRole("heading", { name: "Kit", exact: true }).waitFor();
    const accent = await page.evaluate(() => (globalThis as unknown as { getComputedStyle(el: unknown): { getPropertyValue(n: string): string }; document: { documentElement: unknown } }).getComputedStyle((globalThis as unknown as { document: { documentElement: unknown } }).document.documentElement).getPropertyValue("--rvtt-accent").trim());
    assert.equal(accent, "#f7df00");
    await shots.take(page, "kit-yellow");
    assert.deepEqual(consoleWatch.errors, []);
  });

  test("2. a Segmented row is one Tab stop, and its arrow keys move and choose", async () => {
    await focusCard("Choices");
    await page.keyboard.press("Tab");
    let f = await focused();
    assert.deepEqual([f.role, f.group, f.value, f.checked], ["radio", "Ability", "dex", true], "Tab lands on the chosen option");
    const ring = await outline(page.locator(".rvtt-choice", { has: page.locator('input[value="dex"]') }));
    assert.deepEqual([ring.style, ring.width, ring.color], ["solid", "2px", rgb("#f7df00")], "the ring goes on the option around the unseen radio");

    await page.keyboard.press("ArrowRight");
    f = await focused();
    assert.deepEqual([f.value, f.checked], ["con", true], "ArrowRight moves to the next option and chooses it");
    assert.equal(await page.getByRole("radio", { name: "DEX", exact: true }).isChecked(), false);
    await page.keyboard.press("ArrowLeft");
    f = await focused();
    assert.deepEqual([f.value, f.checked], ["dex", true]);

    await page.keyboard.press("Tab");
    f = await focused();
    assert.deepEqual([f.group, f.value], ["Scene kind", "map"], "the next Tab leaves the group for the next one");
    await page.keyboard.press("Shift+Tab");
    f = await focused();
    assert.deepEqual([f.group, f.value], ["Ability", "dex"], "Shift+Tab comes back to the chosen option, not the last one");
    // The disabled option is skipped by the arrows.
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    f = await focused();
    assert.equal(f.value, "map", "two steps right from Map pass the disabled Import and wrap to Map");
  });

  test("3. a Swatches row is one Tab stop named by color, and its arrow keys move and choose", async () => {
    await page.getByRole("radio", { name: "Map" }).focus();
    // The disabled "Who can read it" row takes no stop.
    await page.keyboard.press("Tab");
    let f = await focused();
    assert.deepEqual([f.group, f.name, f.checked], ["Your color", "Green", true]);
    await page.keyboard.press("ArrowRight");
    f = await focused();
    assert.deepEqual([f.name, f.checked], ["Blue, used by Pat", true]);
    await page.keyboard.press("Tab");
    f = await focused();
    assert.equal(f.name, "Secret block", "the disabled row of pin colors takes no stop, and the next Tab reaches the checkbox");
    assert.equal(await page.getByRole("radiogroup", { name: "Your color" }).getByRole("radio").count(), 11);
  });

  test("4. Space flips a Switch named by its setting alone, and its state is aria-checked", async () => {
    const grid = page.getByRole("switch", { name: "Grid lines", exact: true });
    await grid.focus();
    assert.equal(await grid.getAttribute("aria-checked"), "false");
    await page.keyboard.press("Space");
    assert.equal(await grid.getAttribute("aria-checked"), "true");
    await page.keyboard.press("Enter");
    assert.equal(await grid.getAttribute("aria-checked"), "false");
    const fog = page.getByRole("switch", { name: "Fog", exact: true });
    const describedBy = await fog.getAttribute("aria-describedby");
    assert.equal(await page.locator(`[id="${describedBy}"]`).textContent(), "Players see only what you reveal.");
    const busy = page.getByRole("switch", { name: "Turn sound", exact: true });
    await busy.click();
    assert.equal(await busy.getAttribute("aria-checked"), "true", "a busy switch ignores a tap");
  });

  test("5. the focus ring is the accent, and ink on a highlight notice", async () => {
    await focusCard("Buttons");
    await page.keyboard.press("Tab");
    const create = page.getByRole("button", { name: "Create room" });
    assert.equal((await focused()).name, "Create room");
    assert.deepEqual(await outline(create), { style: "solid", width: "2px", color: rgb("#f7df00") });

    await focusCard("Notices and empty states");
    await page.keyboard.press("Tab");
    const exit = page.getByRole("button", { name: "Exit preview" });
    assert.equal((await focused()).name, "Exit preview");
    assert.deepEqual(await outline(exit), { style: "solid", width: "2px", color: INK }, "the accent would read 1.1:1 on cream");
  });

  test("6. a body folded with hidden over its inline display is neither seen nor reached by Tab", async () => {
    const folded = page.locator('[data-kit="folded"]');
    const inside = page.getByRole("button", { name: "Inside the folded bar" });
    assert.equal(await folded.evaluate((el) => (globalThis as unknown as { getComputedStyle(el: unknown): { display: string } }).getComputedStyle(el).display), "none");
    assert.equal(await inside.isVisible(), false);
    await page.getByRole("button", { name: "Before the folded bar" }).focus();
    await page.keyboard.press("Tab");
    assert.equal((await focused()).name, "After the folded bar", "Tab skips the folded controls");

    await page.getByRole("switch", { name: "Fold the token bar" }).click();
    assert.equal(await inside.isVisible(), true);
    assert.equal(await page.getByLabel("Folded HP").inputValue(), "7", "the body stayed mounted while folded");
    await page.getByRole("button", { name: "Before the folded bar" }).focus();
    await page.keyboard.press("Tab");
    assert.equal((await focused()).name, "Inside the folded bar");
    await page.getByRole("switch", { name: "Fold the token bar" }).click();
  });

  test("7. a panel's subpage titles the sheet, with a back button named for the panel that can ask first", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    await sheet.getByRole("button", { name: "Members" }).click();
    await sheet.getByRole("heading", { name: "Members" }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: "Close Menu" }).count(), 1, "the sheet keeps its own name");
    await sheet.getByRole("button", { name: "Back to Menu" }).click();
    await sheet.getByRole("button", { name: "Encounter editor" }).click();
    await sheet.getByRole("heading", { name: "Goblin ambush" }).waitFor();
    await sheet.getByRole("button", { name: "Add a goblin" }).click();
    await sheet.getByRole("button", { name: "Back to Encounters" }).click();
    const ask = sheet.getByRole("button", { name: "Discard changes?" });
    await ask.waitFor();
    assert.equal(await sheet.getByRole("button", { name: "Back to Encounters" }).count(), 0, "while it asks, the question is the button's name");
    assert.equal(await sheet.getByRole("heading", { name: "Goblin ambush" }).count(), 0, "the question takes the title's place");
    await ask.click();
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
  });

  test("8. the sheet keeps room above it for the dock, and never drops under 120 px", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    await sheet.getByRole("button", { name: "Room settings" }).click();
    await sheet.getByRole("heading", { name: "Room settings" }).waitFor();
    // Its twelve settings are taller than the cap, so the sheet's height is the cap: the kit's box with no bars, less 24 px of map or the 56 px reserve. The sheet is the dialog around its region, border and all.
    const dialog = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
    const room = await dialog.evaluate((el) => (el as unknown as { parentElement: { clientHeight: number } }).parentElement.clientHeight);
    const height = async () => Math.round((await dialog.boundingBox())!.height);
    assert.equal(await height(), room - 24);
    await page.getByRole("switch", { name: "Reserve room for the dock" }).click();
    assert.equal(await height(), room - 56);
    await page.setViewportSize({ width: 1280, height: 180 });
    assert.equal(await height(), 120, "60% of a 180 px screen is under the floor, so the sheet keeps 120 px");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("switch", { name: "Reserve room for the dock" }).click();
    await sheet.getByRole("button", { name: "Back to Menu" }).click();
  });

  test("9. a dialog keeps the shell's structure and closes with Escape", async () => {
    const opener = page.getByRole("button", { name: "Editor dialog" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "New page" });
    await dialog.waitFor();
    const card = dialog.locator("section").first();
    const scrolling = await card.evaluate((el) =>
      [...(el as unknown as { children: Iterable<unknown> }).children].filter((c) => (globalThis as unknown as { getComputedStyle(el: unknown): { overflowY: string } }).getComputedStyle(c).overflowY === "auto").length,
    );
    assert.equal(scrolling, 1, "one direct child of the card scrolls");
    await dialog.getByRole("button", { name: "Close New page" }).waitFor();
    await dialog.locator("footer").getByRole("button", { name: "Save", exact: true }).waitFor();
    await shots.take(page, "kit-dialog");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal((await focused()).name, "Editor dialog", "focus goes back to what opened it");

    await page.getByRole("button", { name: "SheetDialog wrapper" }).click();
    const wrapped = page.getByRole("dialog", { name: "3 tokens" });
    await wrapped.getByRole("button", { name: "Done" }).click();
    await wrapped.waitFor({ state: "detached" });
  });

  test("10. entering a subpage focuses its title, and Back returns focus to the row that opened it", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    await sheet.getByRole("button", { name: "Members" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Members" }).waitFor();
    let f = await focused();
    assert.deepEqual([f.tag, f.name], ["h2", "Members"], "focus starts at the subpage's name");
    await page.keyboard.press("Shift+Tab");
    f = await focused();
    assert.equal(f.name, "Back to Menu");
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    f = await focused();
    assert.deepEqual([f.tag, f.name], ["button", "Members"], "focus goes back to the row, mounted anew with the menu");
  });

  test("11. the armed back button keeps focus from the Enter that arms it to the Enter that confirms", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    await sheet.getByRole("button", { name: "Encounter editor" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Goblin ambush" }).waitFor();
    assert.equal((await focused()).tag, "h2");
    await sheet.getByRole("button", { name: "Add a goblin" }).click();
    await sheet.getByRole("button", { name: "Back to Encounters" }).focus();
    await page.keyboard.press("Enter");
    let f = await focused();
    assert.deepEqual([f.tag, f.name], ["button", "Discard changes?"], "the same button, now asking");
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    f = await focused();
    assert.deepEqual([f.tag, f.name], ["button", "Encounter editor"]);
  });

  test("12. a swatch takes a click and a tap on its radio", async () => {
    const colors = page.getByRole("radiogroup", { name: "Your color" });
    await colors.getByRole("radio", { name: "Purple" }).click();
    assert.equal(await colors.getByRole("radio", { name: "Purple" }).isChecked(), true);
    await colors.getByRole("radio", { name: "Teal" }).tap();
    assert.equal(await colors.getByRole("radio", { name: "Teal" }).isChecked(), true);
    assert.equal(await colors.getByRole("radio", { name: "Purple" }).isChecked(), false);
  });

  test("13. a row that moves, or gets a new neighbor above it, keeps its focus and what was typed in it", async () => {
    const list = page.getByRole("list", { name: "Initiative order" });
    const note = page.getByLabel("Note for C");
    await note.fill("kept");
    // Pressed from script, so focus stays in the field and only the list's order changes.
    for (const button of ["Move the last row to the top", "Add a row at the top"]) {
      await page.getByRole("button", { name: button }).evaluate((el) => (el as unknown as { click(): void }).click());
      const f = await focused();
      assert.deepEqual([f.name, f.value], ["Note for C", "kept"], `after "${button}"`);
    }
    assert.match((await list.getByRole("listitem").nth(1).textContent()) ?? "", /Creature C/, "C moved to the top, then a new row came above it");
  });

  test("14. a dialog that ends in a choice wraps Tab through the chosen option, both ways", async () => {
    await page.getByRole("button", { name: "Tab order dialog" }).click();
    const dialog = page.getByRole("dialog", { name: "Pick an ability" });
    await dialog.waitFor();
    const at = async () => {
      const f = await focused();
      return f.role === "radio" ? `radio ${f.value}` : f.name;
    };
    const steps: [string, string][] = [
      ["Tab", "Close Pick an ability"],
      ["Tab", "radio dex"],
      ["Tab", "Close Pick an ability"],
      ["Shift+Tab", "radio dex"],
      // The first option chosen: Tab from it must still wrap, though two options follow it.
      ["ArrowLeft", "radio str"],
      ["Tab", "Close Pick an ability"],
      ["Shift+Tab", "radio str"],
      // The last option chosen.
      ["ArrowLeft", "radio con"],
      ["Tab", "Close Pick an ability"],
      ["Shift+Tab", "radio con"],
      ["Shift+Tab", "Close Pick an ability"],
    ];
    for (const [key, expected] of steps) {
      await page.keyboard.press(key);
      assert.equal(await at(), expected, `after ${key}`);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  });

  test("15. a mixed checkbox stays mixed after a click its owner does not take", async () => {
    const mixed = page.getByRole("checkbox", { name: "Hidden on some selected tokens" });
    await mixed.click();
    const state = await mixed.evaluate((el) => {
      const box = el as unknown as { indeterminate: boolean; checked: boolean };
      return { indeterminate: box.indeterminate, checked: box.checked };
    });
    assert.deepEqual(state, { indeterminate: true, checked: false });
  });

  test("16. a subpage that renames itself keeps focus in the field, and a different subpage still takes it to the title", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    await sheet.getByRole("button", { name: "Encounter editor" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Goblin ambush" }).waitFor();
    await sheet.getByLabel("Encounter name").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" at dawn");
    await sheet.getByRole("heading", { name: "Goblin ambush at dawn" }).waitFor();
    let f = await focused();
    assert.deepEqual([f.name, f.value], ["Encounter name", "Goblin ambush at dawn"], "every keystroke renamed the page, and focus stayed in the field");
    await sheet.getByRole("button", { name: "Next encounter" }).click();
    await sheet.getByRole("heading", { name: "Bandit camp" }).waitFor();
    f = await focused();
    assert.deepEqual([f.tag, f.name], ["h2", "Bandit camp"], "another encounter is another page");
    await sheet.getByRole("button", { name: "Back to Encounters" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    f = await focused();
    assert.deepEqual([f.tag, f.name], ["button", "Encounter editor"]);
  });

  test("17. a row pressed without taking focus, as Safari does, is the one Back returns to", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    await sheet.getByRole("button", { name: "Members" }).focus();
    // A click event alone moves no focus, as a click or a tap in Safari: focus stays on Members.
    await sheet.getByRole("button", { name: "Room settings" }).dispatchEvent("click");
    await sheet.getByRole("heading", { name: "Room settings" }).waitFor();
    await sheet.getByRole("button", { name: "Back to Menu" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    const f = await focused();
    assert.deepEqual([f.tag, f.name], ["button", "Room settings"]);
  });

  test("18. of two rows with one name, Back returns to the one that was opened", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    const notes = sheet.getByRole("button", { name: "Notes", exact: true });
    await notes.nth(1).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Notes 2" }).waitFor();
    await page.keyboard.press("Shift+Tab");
    assert.equal((await focused()).name, "Back to Menu");
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    assert.equal(await notes.nth(1).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "the second Notes has focus");
  });

  test("19. a marked row that moved is found by its id, and a removed one hands focus to the title", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    const back = sheet.getByRole("button", { name: "Back to Menu" });
    await sheet.getByRole("button", { name: "Letter" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Letter" }).waitFor();
    await sheet.getByRole("button", { name: "Move this to the top" }).click();
    await back.focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    let f = await focused();
    assert.deepEqual([f.tag, f.name], ["button", "Letter"]);
    assert.equal(await sheet.locator("[data-opener]").first().getAttribute("data-opener"), "handout-letter", "the Letter now leads the list");

    await sheet.getByRole("button", { name: "Map of the keep" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Map of the keep" }).waitFor();
    await sheet.getByRole("button", { name: "Remove this one" }).click();
    await back.focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    f = await focused();
    assert.deepEqual([f.tag, f.name], ["h2", "Menu"], "its row is gone, so focus goes to the title");
  });

  test("20. a subpage opened and closed from outside the sheet leaves no stale opener for a later Back", async () => {
    const sheet = page.locator('section[aria-label="Menu"]');
    const outsideOpen = page.getByRole("button", { name: "Open Room settings from outside the sheet" });
    const outsideClose = page.getByRole("button", { name: "Close the subpage from outside the sheet" });
    await sheet.getByRole("button", { name: "Members" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Members" }).waitFor();
    // From outside, focus stays where it is, both ways.
    await outsideClose.click();
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    assert.equal((await focused()).name, "Close the subpage from outside the sheet");
    await outsideOpen.click();
    await sheet.getByRole("heading", { name: "Room settings" }).waitFor();
    assert.equal((await focused()).name, "Open Room settings from outside the sheet");
    // Nothing in the sheet opened this page, so Back lands on the title, not on Members.
    await sheet.getByRole("button", { name: "Back to Menu" }).focus();
    await page.keyboard.press("Enter");
    await sheet.getByRole("heading", { name: "Menu" }).waitFor();
    const f = await focused();
    assert.deepEqual([f.tag, f.name], ["h2", "Menu"]);
  });

  test("21. the accent follows the switch, the focus ring with it", async () => {
    for (const [name, hex] of [["Blue", "#3e8ef7"], ["White", "#e5e5e5"]] as const) {
      await page.getByRole("radiogroup", { name: "Accent" }).getByRole("radio", { name }).check();
      await focusCard("Buttons");
      await page.keyboard.press("Tab");
      const { accent } = accentFor(hex);
      assert.equal((await outline(page.getByRole("button", { name: "Create room" }))).color, rgb(accent));
      await shots.take(page, `kit-${name.toLowerCase()}`);
    }
    assert.deepEqual(consoleWatch.errors, []);
    assert.deepEqual(consoleWatch.warnings, []);
  });
});
