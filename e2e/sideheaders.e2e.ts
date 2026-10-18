import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * The side panel's compact headers (docs/design-v1-side-headers.md 11.2),
 * on the real server serving the production build: every header row one
 * 45 px line of 44 px targets, the tab row and the bar between two panes
 * in one look, the folded party bar's one line whose chips scroll sideways
 * (the fade, the wheel, a swipe and Tab reach every chip, one off the
 * scene included), a long name cut on its chip and never pushing a row's
 * HP past the edge, and two panels on a phone held sideways.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-three, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 23;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-sideheaders-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");

const LONG = "Bartholomew Underhill of the Long Barrow";

/** Pat's eight characters, in the order the bar lists them (by name, one owner). Two have no token on the scene. */
const PARTY: { name: string; hp: number; placed: boolean }[] = [
  { name: "Ash", hp: 12, placed: false },
  { name: LONG, hp: 27, placed: true },
  { name: "Kael", hp: 40, placed: true },
  { name: "Ostrava", hp: 44, placed: true },
  { name: "Seraphina Nightbloom", hp: 38, placed: true },
  { name: "Thorn", hp: 24, placed: true },
  { name: "Vex", hp: 21, placed: true },
  { name: "Wren Thistledown", hp: 19, placed: false },
];

const run = {
  roomId: "",
  roomName: `E2E side headers ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  password: "",
};

type Insets = { side?: number; bottom?: number };

/** The page's document as code run in the browser reads it: the e2e files compile without the DOM's types. */
type DomEl = { ownerDocument: { activeElement: unknown } };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 1, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** Runs code in the page and hands back what it returns. */
function js<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(() => { ${body} })()`) as Promise<T>;
}

async function view(page: Page, cdp: CDPSession, size: { width: number; height: number }, insets: Insets = {}): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: insets.bottom ?? 0, left: insets.side ?? 0, right: insets.side ?? 0 } });
  await page.setViewportSize(size);
  await page.waitForTimeout(250);
}

/** Reloads at an interface size with the party bar folded or open, and the side panel shown with one panel. */
async function reloadAt(page: Page, scale: number, folded: boolean): Promise<void> {
  await page.evaluate(
    ({ s, f }) => {
      const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage;
      store.setItem("rvtt.uiScale", String(s));
      store.setItem("rvtt.partyFolded", f ? "1" : "0");
      store.setItem("rvtt.sidePanel", "shown");
      store.removeItem("rvtt.sidePanelSplit");
    },
    { s: scale, f: folded },
  );
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await tablist(page).getByRole("tab").first().waitFor();
  await party(page).waitFor();
  await page.waitForTimeout(300);
}

const tablist = (page: Page | Locator) => page.getByRole("tablist", { name: "Panels" });
const more = (page: Page | Locator) => tablist(page).locator('[role="tab"][aria-haspopup="menu"]');
const moreMenu = (page: Page | Locator) => page.getByRole("menu", { name: "More panels" });
const twoPanels = (page: Page | Locator) => moreMenu(page).getByRole("menuitemcheckbox", { name: "Two panels" });
const party = (page: Page | Locator) => page.getByRole("region", { name: "Party" });
const partyToggle = (page: Page | Locator) => party(page).getByRole("button", { name: "Party", exact: true });
const chips = (page: Page | Locator) => party(page).getByRole("list").getByRole("button");
const chip = (page: Page | Locator, name: string) => party(page).getByRole("list").getByRole("button", { name: new RegExp(`^${name}, HP`) });
const ask = (page: Page | Locator) => party(page).getByRole("button", { name: "Ask the party", exact: true });
const bar = (page: Page | Locator) => page.locator("[data-pane-bar]");

function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el === (el as unknown as DomEl).ownerDocument.activeElement);
}

/** The side panel's interface size, which its own px are drawn at. */
function zoomOf(page: Page): Promise<number> {
  return js<number>(page, `const a = document.querySelector('aside:has([role="tablist"][aria-label="Panels"])'); return parseFloat(getComputedStyle(a).zoom || "1") || 1;`);
}

/**
 * Every header row of the side panel as drawn, in its own px: the party
 * line, the tab row, the bar and each pane's subpage header, with each
 * control in them that takes a press, its size and whether a tap at its
 * center reaches it.
 */
type Rows = { party: number | null; tabs: number; bar: number | null; subpages: number[]; misses: string[] };

function headerRows(page: Page): Promise<Rows> {
  return js<Rows>(
    page,
    `
    const list = document.querySelector('[role="tablist"][aria-label="Panels"]');
    const aside = list.closest("aside");
    const zoom = parseFloat(getComputedStyle(aside).zoom || "1") || 1;
    const h = (el) => Math.round((el.getBoundingClientRect().height / zoom) * 10) / 10;
    const row = (el) => { while (el && el.parentElement !== aside) el = el.parentElement; return el; };
    const partyEl = aside.querySelector('section[aria-label="Party"]');
    const barEl = aside.querySelector("[data-pane-bar]");
    const subs = [...aside.querySelectorAll("[data-split-room] header")].filter((e) => e.offsetParent !== null);
    const rows = [partyEl ? row(partyEl) : null, row(list), barEl && !barEl.hidden ? barEl : null, ...subs.map((e) => e.parentElement)].filter(Boolean);
    const misses = [];
    for (const r of rows) {
      for (const c of r.querySelectorAll('button, [role="tab"], [role="separator"]')) {
        // The strip's chevron saves a swipe and is hidden from screen readers and Tab, as the toolbar's is: every chip takes its own tap.
        if (c.closest("[data-rvtt-popover]") || c.getAttribute("aria-hidden") === "true") continue;
        const b = c.getBoundingClientRect();
        if (b.width === 0) continue;
        const name = (c.getAttribute("aria-label") ?? c.textContent ?? "").trim().slice(0, 30);
        if (c.getAttribute("role") === "separator") continue;
        if (b.width / zoom < 43.5 || b.height / zoom < 43.5) misses.push(name + " is " + Math.round(b.width / zoom) + " by " + Math.round(b.height / zoom));
        const strip = c.closest('[role="list"]')?.parentElement;
        const s = strip ? strip.getBoundingClientRect() : null;
        // A chip the strip has scrolled out of sight takes no tap until it scrolls back.
        if (s && (b.left < s.left || b.right > s.right)) continue;
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!hit || !(hit === c || c.contains(hit))) misses.push(name + " does not take a tap at its center");
      }
    }
    return { party: partyEl ? h(row(partyEl)) : null, tabs: h(row(list)), bar: barEl && !barEl.hidden ? h(barEl) : null, subpages: subs.map((e) => h(e.parentElement)), misses };
  `,
  );
}

function near(actual: number | null, expected: number, what: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= 0.5, `${what}: ${actual}, not ${expected}`);
}

/** The folded strip's scroller and what its fade covers now. */
type Strip = { left: number; right: number; scrollLeft: number; fadeLeft: boolean; fadeRight: boolean; scrollbar: number };

function stripOf(page: Page): Promise<Strip> {
  return js<Strip>(
    page,
    `
    const el = document.querySelector('section[aria-label="Party"] [role="list"]').parentElement;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, scrollLeft: el.scrollLeft, fadeLeft: el.scrollLeft > 1, fadeRight: el.scrollLeft + el.clientWidth < el.scrollWidth - 1, scrollbar: el.offsetHeight - el.clientHeight };
  `,
  );
}

/** The ScrollStrip's fade, in the page's px at an interface size. */
const FADE = 32;

async function splitWith(page: Page, top: string, below: string): Promise<void> {
  await openSideTab(page, top);
  if ((await bar(page).count()) === 0) {
    await more(page).click();
    await twoPanels(page).click();
    await moreMenu(page).waitFor({ state: "detached" });
  }
  if ((await bar(page).getByRole("button", { name: `${below} below`, exact: true }).count()) === 0) {
    await bar(page).getByRole("button", { name: / below$/ }).click();
    await page.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: new RegExp(`^${below}`) }).click();
  }
  await page.getByRole("group", { name: `${below} below`, exact: true }).waitFor();
}

describe("raccoon-vtt: the side panel's compact headers", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    // After the socket's session: the safe area override holds only from the page's latest DevTools session.
    dmCdp = await dmContext.newCDPSession(dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      console.error("[dm] errors", dmConsole.errors, "warnings", dmConsole.warnings);
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

  test("0. a DM's room where Pat plays eight characters, two off the scene and one with a 40 letter name", async () => {
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

    const patContext = await browser.newContext();
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;
    await patContext.close();

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    for (const [i, p] of PARTY.entries()) {
      const id = randomUUID();
      await ops.send({ t: "character.create", character: { id, name: p.name, size: "medium", ownerIds: [run.patId], actor: actor(p.hp) } });
      if (p.placed) await ops.send({ t: "token.create", token: { id: randomUUID(), sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: p.name, x: 3 + i, y: 6, disposition: "ally", actor: { ref: id } } });
    }
    await waitFor("the party in the DM's view", () => (Object.keys(dmSocket.state?.characters ?? {}).length === PARTY.length ? true : null));
    await reloadAt(dm, 1, true);
    assert.deepEqual(
      (await chips(dm).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).map((n) => n.split(",")[0]),
      PARTY.map((p) => p.name),
      "every character in the line, in the bar's order",
    );
  });

  test("1. every header row is 45 own px of 44 px targets, at every wide size and with a subpage in each pane", async () => {
    const sizes: { name: string; size: { width: number; height: number }; scale: number; insets?: Insets }[] = [
      { name: "1280x800-100", size: { width: 1280, height: 800 }, scale: 1 },
      { name: "1280x800-130", size: { width: 1280, height: 800 }, scale: 1.3 },
      { name: "1180x820-100", size: { width: 1180, height: 820 }, scale: 1 },
      { name: "844x390-85", size: { width: 844, height: 390 }, scale: 0.85, insets: { side: 47, bottom: 21 } },
    ];
    const misses: string[] = [];
    for (const s of sizes) {
      await view(dm, dmCdp, s.size, s.insets);
      await reloadAt(dm, s.scale, true);
      const one = await headerRows(dm);
      // Within half a pixel: a 1 px rule at 130% is drawn on whole device pixels.
      near(one.party, 45, `${s.name}: the folded party line`);
      near(one.tabs, 45, `${s.name}: the tab row`);
      misses.push(...one.misses.map((m) => `${s.name}, one panel: ${m}`));

      await splitWith(dm, "Menu", "Encounters");
      await dm.getByRole("tabpanel", { name: "Menu" }).getByRole("button", { name: /^Members/ }).click();
      await dm.getByRole("group", { name: "Encounters below", exact: true }).getByRole("button", { name: /^New encounter/ }).click();
      await waitFor(`${s.name}: a subpage in each pane`, async () => ((await headerRows(dm)).subpages.length === 2 ? true : null));
      const two = await headerRows(dm);
      near(two.bar, 45, `${s.name}: the bar, a header row as the tab row is`);
      assert.equal(two.subpages.length, 2, `${s.name}: a subpage header in each pane`);
      for (const h of two.subpages) near(h, 45, `${s.name}: a pane's subpage header`);
      misses.push(...two.misses.map((m) => `${s.name}, two panels: ${m}`));
      await shots.take(dm, `sideheaders-rows-${s.name}`);
    }
    await view(dm, dmCdp, { width: 1280, height: 800 });
    assert.deepEqual(misses, [], "every control in the header rows is 44 by 44 and takes a tap");
  });

  test("2. the tab row and the bar are one look: the band, the chosen pill and the type", async () => {
    await reloadAt(dm, 1, true);
    await splitWith(dm, "Initiative", "Token");
    const look = await js<{ tabRow: string; bar: string; tab: string[]; name: string[] }>(
      dm,
      `
      const list = document.querySelector('[role="tablist"][aria-label="Panels"]');
      const chosen = list.querySelector('[role="tab"][aria-selected="true"]');
      const barEl = document.querySelector("[data-pane-bar]");
      const name = [...barEl.querySelectorAll("button")].find((b) => / below$/.test(b.textContent ?? ""));
      const pill = (el) => { const p = getComputedStyle(el.querySelector(":scope > [data-pill]")); return [p.backgroundColor, p.borderTopColor, p.height]; };
      const type = (el) => { const c = getComputedStyle(el); return [c.fontSize, c.fontWeight, c.color]; };
      return { tabRow: getComputedStyle(list.parentElement).backgroundColor, bar: getComputedStyle(barEl).backgroundColor, tab: [...pill(chosen), ...type(chosen)], name: [...pill(name), ...type(name)] };
    `,
    );
    assert.equal(look.bar, look.tabRow, "one band");
    assert.deepEqual(look.name, look.tab, "the bar's name wears the chosen tab's pill and type");
    await shots.take(dm, "sideheaders-one-look");
  });

  test("3. the folded line: one row of chips that the wheel, Tab and a swipe scroll, an off-scene chip in reach, then Ask", async () => {
    await reloadAt(dm, 1, true);
    const tops = await chips(dm).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, `every chip on the line's one row: ${tops}`);
    let strip = await stripOf(dm);
    assert.equal(strip.scrollbar, 0, "no scrollbar takes room");
    assert.ok(strip.fadeRight && !strip.fadeLeft, "a fade where the line hides more");

    // The wheel scrolls it sideways, over its chips and over the chevron that the scroll brings out at its start.
    const middle = (strip.left + strip.right) / 2;
    const lineY = ((await party(dm).boundingBox())?.y ?? 0) + 22;
    await dm.mouse.move(middle, lineY);
    await dm.mouse.wheel(0, 120);
    await waitFor("the wheel scrolls the strip", async () => ((await stripOf(dm)).scrollLeft > 0 ? true : null));
    await dm.mouse.move(strip.left + 10, lineY);
    await dm.mouse.wheel(0, -2000);
    await waitFor("back to its start, by the wheel over the chevron", async () => ((await stripOf(dm)).scrollLeft < 1 ? true : null));

    // Tab from Party reaches every chip, each clear of the fade as it takes focus, then Ask.
    await partyToggle(dm).focus();
    for (const p of PARTY) {
      await dm.keyboard.press("Tab");
      const target = chip(dm, p.name);
      assert.ok(await isFocused(target), `Tab reaches ${p.name}`);
      const b = await target.boundingBox();
      strip = await stripOf(dm);
      assert.ok(b);
      assert.ok(b.x >= strip.left - 0.5 && b.x + b.width <= strip.right + 0.5, `${p.name} lies inside the strip`);
      if (strip.fadeLeft) assert.ok(b.x >= strip.left + FADE - 1, `${p.name} clears the left fade`);
      if (strip.fadeRight) assert.ok(b.x + b.width <= strip.right - FADE + 1, `${p.name} clears the right fade`);
    }
    await dm.keyboard.press("Tab");
    assert.ok(await isFocused(ask(dm)), "Ask follows the last chip");
    assert.equal(await ask(dm).textContent(), "Ask", "Ask, its name whole");
    assert.equal(await ask(dm).getAttribute("title"), "Ask the party");

    // A character off the scene: focusable, says so, and a press does nothing.
    const off = chip(dm, "Wren Thistledown");
    assert.equal(await off.getAttribute("aria-disabled"), "true");
    assert.equal(await off.evaluate((el) => (el as unknown as { disabled: boolean }).disabled), false, "not disabled, which Tab would skip");
    assert.match((await off.getAttribute("aria-label")) ?? "", /not on this scene$/);
    await off.focus();
    await dm.keyboard.press("Enter");
    await dm.waitForTimeout(300);
    assert.equal(await dm.getByRole("dialog", { name: /actions$/ }).count(), 0, "no token's action bar opens");
    await shots.take(dm, "sideheaders-strip-end");

    // A swipe scrolls it on a touch screen, which shows no scrollbar either.
    const touch = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    await touch.addCookies(await dmContext.cookies(server.origin));
    await touch.addInitScript(() => {
      localStorage.setItem("rvtt.partyFolded", "1");
      localStorage.setItem("rvtt.sidePanel", "shown");
    });
    const tablet = await touch.newPage();
    await tablet.goto(`${server.origin}/r/${run.roomId}`);
    await party(tablet).getByRole("list").waitFor();
    await tablet.waitForTimeout(500);
    const t = await party(tablet).getByRole("list").boundingBox();
    assert.ok(t);
    const cdp = await touch.newCDPSession(tablet);
    const y = t.y + t.height / 2;
    await touchSwipe(cdp, { x: t.x + 160, y }, { x: t.x + 160 - 8 * 15, y }, { steps: 8 });
    await waitFor("a swipe scrolls the strip", async () => ((await stripOf(tablet)).scrollLeft > 30 ? true : null));
    assert.equal((await stripOf(tablet)).scrollbar, 0, "no scrollbar on a touch screen");
    await touch.close();
  });

  test("4. a long name is cut on its chip and never pushes a row's HP past the edge, folded, open or on a phone", async () => {
    await reloadAt(dm, 1, true);
    const long = chip(dm, LONG);
    const cut = await long.evaluate((el) => {
      const e = el as unknown as { querySelector(s: string): { scrollWidth: number; clientWidth: number } | null; getAttribute(n: string): string | null };
      const name = e.querySelector("strong");
      return { cut: !!name && name.scrollWidth > name.clientWidth, title: e.getAttribute("title") };
    });
    assert.ok(cut.cut, "the name ends in an ellipsis");
    assert.equal(cut.title, LONG, "its tooltip holds it whole");

    /** Every party row's HP inside `within`'s box, by the rows' "cur/max" text. */
    const hpInside = (page: Page, within: string) =>
      js<string[]>(
        page,
        `
        const box = document.querySelector(${JSON.stringify(within)}).getBoundingClientRect();
        const rows = [...document.querySelectorAll('section[aria-label="Party"] li > button')];
        const out = [];
        for (const row of rows) {
          const hp = [...row.querySelectorAll("span")].find((s) => /^\\d+\\/\\d+/.test(s.textContent ?? "") && s.children.length <= 1);
          const r = hp?.getBoundingClientRect();
          if (!r || r.width === 0 || r.right > box.right + 0.5 || r.right > row.getBoundingClientRect().right + 0.5) out.push((row.getAttribute("aria-label") ?? "").split(":")[0]);
        }
        return rows.length === 0 ? ["no rows"] : out;
      `,
      );

    await partyToggle(dm).click();
    await party(dm).getByRole("listitem").first().waitFor();
    assert.deepEqual(await hpInside(dm, 'aside:has([role="tablist"][aria-label="Panels"])'), [], "every row's HP in the side panel");
    await shots.take(dm, "sideheaders-open-long-name");

    const phone = await dmContext.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${server.origin}/r/${run.roomId}`);
    await phone.getByRole("status", { name: "Connected" }).first().waitFor();
    await phone.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await phone.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Party", exact: true }).click();
    await party(phone).getByRole("listitem").first().waitFor();
    assert.deepEqual(await hpInside(phone, "dialog[open]"), [], "every row's HP in the phone's Party sheet");
    await shots.take(phone, "sideheaders-phone-long-name");
    await phone.close();
  });

  test("5. a phone held sideways at 85% holds two panels for the DM", async () => {
    await view(dm, dmCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
    await reloadAt(dm, 0.85, true);
    assert.ok((await zoomOf(dm)) < 1, "the side panel at 85%");
    await more(dm).click();
    assert.equal(await twoPanels(dm).getAttribute("aria-disabled"), null, "Two panels is open to pick");
    await twoPanels(dm).click();
    await bar(dm).waitFor();
    assert.ok(await bar(dm).isVisible(), "the bar and the panel below show");
    await shots.take(dm, "sideheaders-844x390-two-panels");
    await view(dm, dmCdp, { width: 1280, height: 800 });
  });
});
