import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * PDF handouts end to end (docs/design-v1-pdf-handouts.md 11.3): a handout
 * of pages read like a PDF in the players' popup, paged with buttons, keys,
 * the wheel and a fling, loaded near the screen, remembered per showing,
 * downloaded as a PDF, and kept in the DM's Library as one item.
 *
 * The upload's steps come first in the full run. This part starts from a
 * handout of pages made through the ops (`documentOf`): its pages are
 * ordinary handout images, each white paper with a band of its own color in
 * its top-left corner, as the PDF fixture draws them. A run whose upload
 * steps saved a document sets `run.letter` before step 7, and every step
 * from there reads it.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus twelve. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 12;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-pdf-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

type Page_ = { assetId: string; width: number; height: number };
type Doc = { id: string; title: string; pages: Page_[] };

/** The few DOM parts the page functions read, typed by hand: the e2e files compile without the DOM library. */
type Dom = {
  document: {
    activeElement: { getAttribute(name: string): string | null; textContent: string | null } | null;
    querySelector(s: string): (Element_ & { scrollTop: number }) | null;
    querySelectorAll(s: string): ArrayLike<Element_>;
  };
};
type Element_ = { getAttribute(name: string): string | null; dispatchEvent(e: unknown): boolean };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
/** Pip, a player on a phone held upright. */
let phoneContext: BrowserContext;
let phone: Page;
let phoneCdp: CDPSession;
/** Pat, a player at a computer with a mouse. */
let deskContext: BrowserContext;
let desk: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const phoneSocket = new SocketWatch("phone");
const deskSocket = new SocketWatch("desk");
const consoles = { dm: new ConsoleWatch("dm"), phone: new ConsoleWatch("phone"), desk: new ConsoleWatch("desk") };

const run = {
  roomId: "",
  roomName: `E2E pdf ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  pipId: "",
  patId: "",
  /** The three-page document: Letter portrait, Letter landscape and A5, titled "Strange letter". */
  letter: null as Doc | null,
  /** The showing of the letter on screen now. */
  showingId: "",
  mixed: null as Doc | null,
  thirty: null as Doc | null,
};

/** Each page's band, in order, so a page out of place or blank is seen. */
const BANDS: [number, number, number][] = [
  [200, 40, 40],
  [40, 160, 60],
  [40, 70, 200],
  [200, 150, 30],
  [140, 50, 170],
];

/** A page as a PDF page draws it: white paper with a band of its own color in its top-left corner and "Page N" printed. */
async function paper(width: number, height: number, n: number): Promise<Buffer> {
  const [r, g, b] = BANDS[(n - 1) % BANDS.length]!;
  const text = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" font-size="${Math.round(width / 10)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#222">Page ${n}</text></svg>`,
  );
  const band = { input: { create: { width: Math.round(width / 4), height: Math.round(height / 12), channels: 3 as const, background: { r, g, b } } }, left: Math.round(width / 20), top: Math.round(height / 20) };
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([band, { input: text, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function uploadHandout(data: Buffer): Promise<Page_ & { created?: boolean }> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=handout`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  const row = (await res.json()) as { id: string; width: number; height: number; created?: boolean };
  return { assetId: row.id, width: row.width, height: row.height, created: row.created };
}

/** A document of these pages in the DM's library, made through the ops as the upload job's save makes it. */
async function documentOf(title: string, pages: Buffer[]): Promise<Doc> {
  const rows: Page_[] = [];
  for (const p of pages) {
    const { assetId, width, height } = await uploadHandout(p);
    rows.push({ assetId, width, height });
  }
  const doc = { id: randomUUID(), title, pages: rows };
  await ops.send({ t: "handoutDoc.create", doc });
  return doc;
}

/** Shows a document's pages to everyone under a new handout id, as Show a handout does. */
async function show(doc: Doc, to: "all" | string[] = "all"): Promise<string> {
  const id = randomUUID();
  await ops.send({ t: "handout.show", handout: { id, pages: doc.pages, title: doc.title, to } });
  return id;
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

function viewer(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title });
}

/** The page indicator, "2 of 3" or "All 2 pages". It is hidden from screen readers, so it is found by its words. */
function indicator(dialog: Locator): Locator {
  return dialog.locator("span[aria-hidden]").filter({ hasText: /^(\d+ of \d+|All \d+ pages)$/ });
}

async function indicatorIs(dialog: Locator, text: string, what: string): Promise<void> {
  let seen = "";
  await waitFor(`${what}: the indicator reading "${text}"`, async () => {
    seen = (await indicator(dialog).textContent()) ?? "";
    return seen === text;
  }).catch((err: Error) => {
    throw new Error(`${err.message}, it read "${seen}"`);
  });
}

async function statusIs(dialog: Locator, text: string): Promise<void> {
  // A page still loading has a status of its own, so the status line is found by its words.
  await waitFor(`the status line saying "${text}"`, async () => (await dialog.getByRole("status").allTextContents()).some((t) => t.trim() === text));
}

/** The stage: the viewer's body under its header, which takes the gestures. */
function stage(dialog: Locator): Locator {
  return dialog.locator('div[style*="touch-action: none"]');
}

/** A page's image once mounted, by its one name. */
function pageImage(dialog: Locator, title: string, n: number, of: number): Locator {
  return dialog.locator(`img[alt="${title}, page ${n} of ${of}"]`);
}

/** Whether an image has arrived and decoded. */
function loaded(img: Locator): Promise<boolean> {
  return img.evaluate((el) => {
    const i = el as unknown as { complete: boolean; naturalWidth: number };
    return i.complete && i.naturalWidth > 0;
  });
}

/** A quick one-finger swipe through the browser's touch input, which a phone ends in a fling. */
async function swipe(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Where focus is in the page: the focused element's accessible name, as far as an aria-label or its text gives it. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as Dom).document.activeElement;
    return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
  });
}

type Box = { x: number; y: number; width: number; height: number };
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("raccoon-vtt pdf handouts run", { timeout: 420_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    phone = await phoneContext.newPage();
    phoneCdp = await phoneContext.newCDPSession(phone);
    deskContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    desk = await deskContext.newPage();
    consoles.dm.attach(dm);
    consoles.phone.attach(phone);
    consoles.desk.attach(desk);
    await dmSocket.attach(dmContext, dm);
    await phoneSocket.attach(phoneContext, phone);
    await deskSocket.attach(deskContext, desk);
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

  test("0. a DM's room at a computer, Pip on a phone and Pat at a computer", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.pipId = await join(phoneContext, "Pip", "#30a46c");
    run.patId = await join(deskContext, "Pat", "#3e63dd");
    await phone.goto(`${server.origin}/r/${run.roomId}`);
    await desk.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pip's snapshot", () => phoneSocket.state);
    await waitFor("Pat's snapshot", () => deskSocket.state);
  });

  test("7. Pip's popup: the page row, a page laid out before it loads with its thumb first, Next page, a fling, the page names, 320 px, and a page that fails", async () => {
    // Letter portrait, Letter landscape and A5, each with its long side at 2048 px as a PDF page draws.
    run.letter ??= await documentOf("Strange letter", [await paper(1584, 2048, 1), await paper(2048, 1584, 2), await paper(1448, 2048, 3)]);
    const letter = run.letter;
    const [p1, p2, p3] = letter.pages as [Page_, Page_, Page_];
    // Page 2's full image is held back, so its box and its thumb show first. Page 3's fails.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await phone.route(`**/api/assets/${p2.assetId}/full`, async (route) => {
      await held;
      await route.continue();
    });
    await phone.route(`**/api/assets/${p3.assetId}/full`, (route) => route.abort("internetdisconnected"));
    consoles.phone.allow = [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/];
    run.showingId = await show(letter);

    const popup = viewer(phone, "Strange letter");
    await popup.waitFor();
    await indicatorIs(popup, "1 of 3", "the popup opening");
    // Page 2 is laid out at its own shape before its image arrives, and its thumb stands in after a short wait.
    const second = pageImage(popup, "Strange letter", 2, 3);
    const box = await second.boundingBox();
    assert.ok(box, "page 2 has no box");
    assert.ok(Math.abs(box.width / box.height - p2.width / p2.height) < 0.02, `page 2's box is not its shape: ${JSON.stringify(box)}`);
    assert.equal(await loaded(second), false, "page 2 arrived while held back");
    const thumb = popup.locator(`img[src$="/${p2.assetId}/thumb"]`);
    await thumb.waitFor();
    await shots.take(phone, "pdf-popup-thumb-first");
    release();
    await waitFor("page 2's full image", () => loaded(second));
    await thumb.waitFor({ state: "detached" });
    assert.ok(await loaded(pageImage(popup, "Strange letter", 1, 3)), "page 1 did not load");
    // Every page has one name, whether loaded or not.
    for (const n of [1, 2, 3]) {
      const named = popup.getByRole("img", { name: `Strange letter, page ${n} of 3`, exact: true });
      assert.equal(await named.count(), 1, `page ${n} has no single name`);
    }
    await popup.getByRole("button", { name: "Next page" }).tap();
    await indicatorIs(popup, "2 of 3", "Next page");
    await statusIs(popup, "Page 2 of 3");
    await shots.take(phone, "pdf-popup-page-2");

    // Page 3 failed in its own box, with its own Try again in screen pixels. Next page, disabled at the end, hands focus to Previous page.
    await popup.getByRole("button", { name: "Next page" }).tap();
    await indicatorIs(popup, "3 of 3", "Next page to the end");
    await popup.getByRole("button", { name: "Next page", disabled: true }).waitFor();
    assert.equal(await focusedName(phone), "Previous page", "focus left with the disabled Next page");
    const retry = popup.getByRole("button", { name: "Try page 3 again" });
    await retry.waitFor();
    await popup.getByText("Page 3 could not be loaded.").waitFor();
    const retryBox = (await retry.boundingBox())!;
    assert.ok(retryBox.height >= 44 && retryBox.width >= 44, `Try page 3 again is too small: ${JSON.stringify(retryBox)}`);
    await shots.take(phone, "pdf-popup-page-failed");
    await phone.unroute(`**/api/assets/${p3.assetId}/full`);
    consoles.phone.allow = [];
    await retry.tap();
    await waitFor("page 3 after Try again", () => loaded(pageImage(popup, "Strange letter", 3, 3)));
    await retry.waitFor({ state: "detached" });

    // A swipe down flings back toward the start, and the indicator follows.
    const s = (await stage(popup).boundingBox())!;
    await swipe(phoneCdp, { x: s.x + s.width / 2, y: s.y + 120 }, { x: s.x + s.width / 2, y: s.y + s.height - 80 });
    await indicatorIs(popup, "1 of 3", "a fling back to the start");
    await swipe(phoneCdp, { x: s.x + s.width / 2, y: s.y + s.height - 120 }, { x: s.x + s.width / 2, y: s.y + 120 });
    await indicatorIs(popup, "3 of 3", "a fling to the end");
    await shots.take(phone, "pdf-popup-flung");
    assert.ok(p1);
  });

  test("7b. at 320 x 480, magnified, the page row takes its own line and never meets the zoom buttons", async () => {
    await phone.setViewportSize({ width: 320, height: 480 });
    const popup = viewer(phone, "Strange letter");
    await popup.getByRole("button", { name: "Zoom in" }).tap();
    await popup.getByRole("button", { name: "Reset zoom" }).waitFor();
    const row = popup.getByRole("button", { name: "Previous page" }).locator("..");
    const zoom = popup.getByRole("button", { name: "Zoom in" }).locator("..");
    const a = (await row.boundingBox())!;
    const b = (await zoom.boundingBox())!;
    assert.equal(intersects(a, b), false, `the page row ${JSON.stringify(a)} meets the zoom buttons ${JSON.stringify(b)}`);
    assert.ok(a.y + a.height <= b.y + 1, "the page row is not above the zoom buttons");
    await shots.take(phone, "pdf-popup-320-magnified");
    await popup.getByRole("button", { name: "Reset zoom" }).tap();
    await phone.setViewportSize({ width: 390, height: 844 });
  });

  test("7c. turning the phone on page 2 keeps page 2 (step 8)", async () => {
    const popup = viewer(phone, "Strange letter");
    await popup.press("Home");
    await indicatorIs(popup, "1 of 3", "Home");
    await popup.getByRole("button", { name: "Next page" }).tap();
    await indicatorIs(popup, "2 of 3", "Next page");
    await phone.setViewportSize({ width: 844, height: 390 });
    await indicatorIs(popup, "2 of 3", "the phone turned");
    await shots.take(phone, "pdf-popup-turned");
    await phone.setViewportSize({ width: 390, height: 844 });
    await indicatorIs(popup, "2 of 3", "the phone turned back");
  });

  test("8. Pat at a computer: the page keys and their words, the page buttons across mixed heights, zoom out to a whole page, and a line-mode wheel", async () => {
    run.mixed = await documentOf("Mixed pages", [await paper(1000, 1000, 1), await paper(1000, 772, 2), await paper(1000, 1000, 3), await paper(1000, 1000, 4)]);
    await show(run.mixed, [run.patId]);
    const popup = viewer(desk, "Mixed pages");
    await popup.waitFor({ timeout: 5000 }).catch(async (err: Error) => {
      await shots.take(desk, "pdf-desk-no-popup");
      throw new Error(`${err.message}: Pat holds ${JSON.stringify(Object.values(deskSocket.state?.handouts ?? {}).map((h) => h.title))}, dialogs ${JSON.stringify(await desk.getByRole("dialog").allTextContents())}`);
    });
    await indicatorIs(popup, "1 of 4", "the popup opening");
    // At rest Reset zoom is hidden, though Zoom out still goes to the page fit.
    assert.equal(await popup.getByRole("button", { name: "Reset zoom" }).count(), 0, "Reset zoom at rest");
    assert.equal(await popup.getByRole("button", { name: "Zoom out" }).isEnabled(), true);
    // The keys, with focus on the dialog as it opens.
    await popup.focus();
    await desk.keyboard.press("PageDown");
    await statusIs(popup, `Page ${(await indicator(popup).textContent())?.split(" ")[0]} of 4`);
    await desk.keyboard.press("End");
    await indicatorIs(popup, "4 of 4", "End");
    await statusIs(popup, "Page 4 of 4");
    await desk.keyboard.press("Home");
    await indicatorIs(popup, "1 of 4", "Home");
    await statusIs(popup, "Page 1 of 4");
    await desk.keyboard.press(" ");
    assert.notEqual(await indicator(popup).textContent(), null);
    await desk.keyboard.press("Shift+ ");
    await indicatorIs(popup, "1 of 4", "Shift+Space back");
    // Next page until it is disabled crosses every page, then Previous page back.
    // Every press moves the view. A last page taller than the room brings its top up first, then the end, so the indicator may say 4 twice.
    const press = async (button: Locator): Promise<string[]> => {
      const seen: string[] = [];
      for (let i = 0; (await button.isEnabled()) && i < 10; i++) {
        const before = (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())?.y ?? (await popup.getByRole("img", { name: "Mixed pages, page 1 of 4", exact: true }).boundingBox())!.y;
        await button.click();
        const after = (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())?.y ?? (await popup.getByRole("img", { name: "Mixed pages, page 1 of 4", exact: true }).boundingBox())!.y;
        assert.ok(Math.abs(after - before) > 1, `a press of ${await button.getAttribute("aria-label")} did not move the view`);
        const text = (await indicator(popup).textContent()) ?? "";
        if (seen.at(-1) !== text) seen.push(text);
      }
      return seen;
    };
    const forward = await press(popup.getByRole("button", { name: "Next page" }));
    assert.deepEqual(forward, ["2 of 4", "3 of 4", "4 of 4"], `Next page did not cross every page: ${forward.join(", ")}`);
    const back = await press(popup.getByRole("button", { name: "Previous page" }));
    assert.deepEqual(back.filter((t) => t !== "4 of 4"), ["3 of 4", "2 of 4", "1 of 4"], `Previous page did not cross every page: ${back.join(", ")}`);
    await shots.take(desk, "pdf-desk-card");

    // Zoom out from the card's width fit reaches the page fit, where a whole page shows, and stops there.
    const out = popup.getByRole("button", { name: "Zoom out" });
    for (let i = 0; (await out.isEnabled()) && i < 10; i++) await out.click();
    assert.equal(await out.isEnabled(), false);
    const stageBox = (await stage(popup).boundingBox())!;
    const first = (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())!;
    assert.ok(first.height <= stageBox.height + 1, `no whole page at the page fit: ${JSON.stringify(first)} in ${JSON.stringify(stageBox)}`);
    await shots.take(desk, "pdf-desk-page-fit");
    await popup.getByRole("button", { name: "Reset zoom" }).click();
    await indicatorIs(popup, "1 of 4", "Reset zoom on the same page");
    assert.equal(await popup.getByRole("button", { name: "Reset zoom" }).count(), 0);

    // A wheel that reports lines scrolls at a reading pace.
    const before = (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())!;
    await stage(popup).evaluate((el) => {
      const w = globalThis as unknown as { WheelEvent: new (t: string, i: object) => unknown };
      (el as unknown as Element_).dispatchEvent(new w.WheelEvent("wheel", { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    });
    await waitFor("the wheel to scroll", async () => before.y - (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())!.y >= 100);
    await popup.getByRole("button", { name: /^Close/ }).click();
    await popup.waitFor({ state: "detached" });

    // Two short pages that fit the stage together: "All 2 pages", both page buttons disabled, and the page keys do nothing.
    const short = await documentOf("Two notes", [await paper(1000, 300, 1), await paper(1000, 300, 2)]);
    await show(short, [run.patId]);
    const notes = viewer(desk, "Two notes");
    await notes.waitFor();
    await indicatorIs(notes, "All 2 pages", "two short pages");
    assert.equal(await notes.getByRole("button", { name: "Previous page" }).isEnabled(), false);
    assert.equal(await notes.getByRole("button", { name: "Next page" }).isEnabled(), false);
    const at = (await pageImage(notes, "Two notes", 1, 2).boundingBox())!.y;
    await notes.focus();
    await desk.keyboard.press("PageDown");
    await desk.keyboard.press("End");
    assert.equal((await pageImage(notes, "Two notes", 1, 2).boundingBox())!.y, at, "a page key moved a column that shows whole");
    await shots.take(desk, "pdf-desk-all-pages");
    await notes.getByRole("button", { name: /^Close/ }).click();
    await notes.waitFor({ state: "detached" });
  });

  test("9. the kept page: closed on page 2 and opened again from the Library, a new showing at page 1, a reconnect keeps the page", async () => {
    const popup = viewer(phone, "Strange letter");
    await popup.getByRole("button", { name: /^Close/ }).tap();
    await popup.waitFor({ state: "detached" });
    await phone.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await phone.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Library/ }).tap();
    const row = phone.getByRole("region", { name: "Library" }).getByRole("listitem").filter({ hasText: "Strange letter" });
    await row.getByText("3 pages").waitFor();
    await shots.take(phone, "pdf-library-row-pages");
    await row.getByRole("button", { name: "Open" }).tap();
    await popup.waitFor();
    await indicatorIs(popup, "2 of 3", "opened again from the Library");

    // A forced reconnect: the resync sends the same showing, so the page stays.
    const frames = phoneSocket.received.length;
    const closes = phoneSocket.closes;
    consoles.phone.expectSocketFailures = true;
    await phoneContext.setOffline(true);
    // The socket notices within its ping's 10 s.
    await waitFor("Pip's socket to drop", () => phoneSocket.closes > closes, 30_000);
    await phoneContext.setOffline(false);
    await phone.evaluate(() => (globalThis as unknown as { dispatchEvent(e: unknown): void; Event: new (t: string) => unknown }).dispatchEvent(new (globalThis as unknown as { Event: new (t: string) => unknown }).Event("online")));
    await waitFor("Pip's snapshot after the reconnect", () => phoneSocket.received.slice(frames).some((f) => f.startsWith('{"t":"snapshot"')) || null, 30_000);
    consoles.phone.expectSocketFailures = false;
    await indicatorIs(popup, "2 of 3", "after a reconnect");

    // The DM closes it and shows the same document again: a new showing starts at page 1.
    await ops.send({ t: "handout.close", handoutId: run.showingId });
    await popup.waitFor({ state: "detached" });
    run.showingId = await show(run.letter!);
    await popup.waitFor();
    await indicatorIs(popup, "1 of 3", "the same document shown anew");
  });

  test("10. thirty pages: only the pages near the screen load, End loads page 30 and lets page 1 go, and a page's Try again hands focus on as it leaves", async () => {
    const pages: Buffer[] = [];
    for (let n = 1; n <= 30; n++) pages.push(await paper(612, 792, n));
    run.thirty = await documentOf("Thirty pages", pages);
    const ids = run.thirty.pages.map((p) => p.assetId);
    const asked = new Set<string>();
    const onRequest = (req: { url(): string }) => {
      const m = /\/api\/assets\/([^/]+)\/full/.exec(req.url());
      if (m) asked.add(m[1]!);
    };
    desk.on("request", onRequest);
    // Page 1 fails, so its Try again is on screen as the popup opens.
    const firstFull = `**/api/assets/${ids[0]}/full`;
    await desk.route(firstFull, (route) => route.abort("internetdisconnected"));
    consoles.desk.allow = [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/];
    await show(run.thirty, [run.patId]);
    const popup = viewer(desk, "Thirty pages");
    await popup.waitFor();
    const retry = popup.getByRole("button", { name: "Try page 1 again" });
    await retry.waitFor();
    await waitFor("page 2", () => loaded(pageImage(popup, "Thirty pages", 2, 30)));
    await desk.waitForTimeout(500);
    const early = ids.filter((id) => asked.has(id)).map((id) => ids.indexOf(id) + 1);
    assert.ok(early.length <= 6, `asked for pages ${early.join(", ")} on opening`);
    assert.ok(!asked.has(ids[29]!), "page 30 was asked for on opening");

    // With focus on Try again, End takes its page out of the overlay, and focus goes on to a page button. The stage never scrolls under the view.
    await retry.focus();
    await desk.keyboard.press("End");
    await indicatorIs(popup, "30 of 30", "End");
    await retry.waitFor({ state: "detached" });
    assert.equal(await focusedName(desk), "Previous page", "focus did not go on to a page button");
    assert.equal(await stage(popup).evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop), 0, "the stage scrolled under the view");
    await waitFor("page 30", async () => (await pageImage(popup, "Thirty pages", 30, 30).count()) === 1 && loaded(pageImage(popup, "Thirty pages", 30, 30)));
    await shots.take(desk, "pdf-desk-thirty-end");

    await desk.unroute(firstFull);
    consoles.desk.allow = [];
    await desk.keyboard.press("Home");
    await indicatorIs(popup, "1 of 30", "Home");
    await retry.click();
    await waitFor("page 1 after Try again", async () => (await pageImage(popup, "Thirty pages", 1, 30).count()) === 1 && loaded(pageImage(popup, "Thirty pages", 1, 30)));
    await desk.keyboard.press("End");
    await indicatorIs(popup, "30 of 30", "End again");
    await waitFor("page 1's image to unmount at the end", async () => (await pageImage(popup, "Thirty pages", 1, 30).count()) === 0);
    // Page 1 keeps its name on its placeholder.
    assert.equal(await popup.getByRole("img", { name: "Thirty pages, page 1 of 30", exact: true }).count(), 1);
    desk.off("request", onRequest);
    await popup.getByRole("button", { name: /^Close/ }).click();
    await popup.waitFor({ state: "detached" });
  });

  test("11. Download: a PDF of every page in order, upright and in color, Cancel in the lead line, and closing the popup mid-build leaves no Share", async () => {
    const letter = run.letter!;
    const popup = viewer(desk, "Strange letter");
    await popup.waitFor();
    const [saved] = await Promise.all([desk.waitForEvent("download"), popup.getByRole("button", { name: "Download", exact: true }).click()]);
    assert.equal(saved.suggestedFilename(), "Strange letter.pdf");
    const bytes = readFileSync(await saved.path());
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    const text = bytes.toString("latin1");
    assert.match(text, /\/Count 3 /);
    const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    assert.deepEqual(
      boxes.map(([w, h]) => (w > h ? "wide" : "tall")),
      letter.pages.map((p) => (p.width > p.height ? "wide" : "tall")),
      "a page turned on its side",
    );
    // Each page's image is its stored page as a JPEG: its band of color is in its top-left corner, in the page's order.
    const images = [...text.matchAll(/\/Width (\d+) \/Height (\d+) [^>]*\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g)];
    assert.equal(images.length, 3);
    for (const [i, m] of images.entries()) {
      const [width, height, length] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const jpeg = bytes.subarray(m.index + m[0].length, m.index + m[0].length + length);
      const at = { x: Math.round(width / 20 + width / 8), y: Math.round(height / 20 + height / 24) };
      const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
      const k = (at.y * info.width + at.x) * info.channels;
      const want = BANDS[i]!;
      const got = [data[k]!, data[k + 1]!, data[k + 2]!];
      assert.ok(got.every((v, c) => Math.abs(v - want[c]!) < 40), `page ${i + 1}'s band is ${got.join(",")}, not ${want.join(",")}`);
    }
    await shots.take(desk, "pdf-desk-downloaded");

    // Offline mid-build: today's words and Try again.
    const third = `**/api/assets/${letter.pages[2]!.assetId}/full`;
    await desk.route(third, (route) => (route.request().resourceType() === "fetch" ? route.abort("internetdisconnected") : route.continue()));
    consoles.desk.allow = [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/];
    await popup.getByRole("button", { name: "Download", exact: true }).click();
    await popup.getByRole("alert").filter({ hasText: "The handout could not be downloaded. Check your connection." }).waitFor();
    await shots.take(desk, "pdf-desk-download-failed");
    await desk.unroute(third);
    consoles.desk.allow = [];
    const [again] = await Promise.all([desk.waitForEvent("download"), popup.getByRole("button", { name: "Try again" }).click()]);
    assert.equal(again.suggestedFilename(), "Strange letter.pdf");
    await popup.getByRole("alert").waitFor({ state: "detached" });

    // On a phone that shares files: Cancel stops a build, and closing the popup mid-build leaves no Share.
    const popupPhone = viewer(phone, "Strange letter");
    await popupPhone.waitFor();
    await phone.evaluate(() => {
      const w = globalThis as unknown as { navigator: object };
      Object.defineProperty(w.navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(w.navigator, "share", { configurable: true, value: async () => {} });
    });
    const second = `**/api/assets/${letter.pages[1]!.assetId}/full`;
    let release = () => {};
    const hold = async () => {
      const held = new Promise<void>((resolve) => (release = resolve));
      await phone.route(second, async (route) => {
        if (route.request().resourceType() === "fetch") await held;
        await route.continue().catch(() => {});
      });
    };
    await hold();
    const download = popupPhone.getByRole("button", { name: "Download", exact: true });
    await download.tap();
    await popupPhone.getByRole("button", { name: "Preparing…" }).waitFor();
    await popupPhone.getByText("Preparing the PDF: page 2 of 3").waitFor();
    await shots.take(phone, "pdf-phone-preparing");
    await popupPhone.getByRole("button", { name: "Cancel", exact: true }).tap();
    await download.waitFor();
    assert.equal(await popupPhone.getByText(/^Preparing the PDF/).count(), 0, "the progress after Cancel");
    release();
    await phone.unroute(second);

    await hold();
    await download.tap();
    await popupPhone.getByText("Preparing the PDF: page 2 of 3").waitFor();
    await popupPhone.getByRole("button", { name: /^Close/ }).tap();
    await popupPhone.waitFor({ state: "detached" });
    release();
    await phone.unroute(second);
    await phone.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await phone.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Library/ }).tap();
    await phone.getByRole("region", { name: "Library" }).getByRole("listitem").filter({ hasText: "Strange letter" }).getByRole("button", { name: "Open" }).tap();
    await popupPhone.waitFor();
    await phone.waitForTimeout(500);
    assert.equal(await popupPhone.getByRole("button", { name: "Share", exact: true }).count(), 0, "a Share left from the closed popup's build");
    await download.waitFor();
    // Built to the end, the phone waits for a tap on Share, which opens the sheet.
    await download.tap();
    await popupPhone.getByRole("button", { name: "Share", exact: true }).waitFor({ timeout: 20_000 });
    await shots.take(phone, "pdf-phone-share");
  });

  test("12. the DM's Library: the document as one tile with its pages, its details in the viewer, no Delete while it shows, then Delete with its pages", async () => {
    const letter = run.letter!;
    await dm.getByRole("tab", { name: "Library", exact: true }).click();
    const library = dm.getByRole("tabpanel", { name: "Library" });
    const handouts = library.getByRole("list", { name: "Handouts in this room" });
    const tile = handouts.getByRole("button", { name: "Strange letter, handout, 3 pages, showing now", exact: true });
    await tile.waitFor();
    const marks = tile.locator("xpath=..").locator("span[aria-hidden]");
    assert.match((await marks.textContent()) ?? "", /3 pages.*Showing now/, "the tile's marks");
    // The document's pages are not listed loose.
    for (const page of letter.pages) assert.equal(await handouts.locator(`img[src*="${page.assetId}"]`).count(), page === letter.pages[0] ? 1 : 0, "a page of the document listed loose");
    await shots.take(dm, "pdf-library-document-tile");
    await tile.click();
    const view = viewer(dm, "Strange letter");
    await view.waitFor();
    await view.getByText(/^3 pages, .+\. Showing now\. Close it in the DM panel to delete it\.$/).waitFor();
    assert.equal(await view.getByRole("button", { name: /^Delete/ }).count(), 0, "Delete while it shows");
    await indicatorIs(view, "1 of 3", "the Library's View");
    await shots.take(dm, "pdf-library-document-view");
    await view.getByRole("button", { name: "Close Strange letter" }).click();
    await view.waitFor({ state: "detached" });
    assert.equal(await focusedName(dm), "Strange letter, handout, 3 pages, showing now", "focus back on the tile");

    // Closed, it has its Delete, which asks once more and takes its pages with it.
    await ops.send({ t: "handout.close", handoutId: run.showingId });
    const closed = handouts.getByRole("button", { name: "Strange letter, handout, 3 pages", exact: true });
    await closed.click();
    await view.waitFor();
    const remove = view.getByRole("button", { name: "Delete", exact: true });
    await remove.click();
    await view.getByRole("button", { name: "Delete all 3 pages?" }).click();
    await view.waitFor({ state: "detached" });
    await library.getByText("Deleted Strange letter and its 3 pages.").waitFor();
    await closed.waitFor({ state: "detached" });
    const listed = (await (await dmContext.request.get(`${server.origin}/api/rooms/${run.roomId}/assets`)).json()) as { assets: { id: string }[] };
    for (const page of letter.pages) assert.ok(!listed.assets.some((a) => a.id === page.assetId), `page ${page.assetId} is still in the library`);
    assert.equal(dmSocket.state?.handoutDocs[letter.id], undefined, "the document is still in the state");
    await shots.take(dm, "pdf-library-document-deleted");

    // Two documents sharing only a blank page: the one not showing keeps its Delete.
    const blank = await paper(1584, 2048, 5);
    const first = await documentOf("Notes A", [blank, await paper(1584, 2048, 1)]);
    const second = await documentOf("Notes B", [blank, await paper(1584, 2048, 2)]);
    assert.equal(first.pages[0]!.assetId, second.pages[0]!.assetId, "the blank page is one image");
    const shownA = await show(first);
    await handouts.getByRole("button", { name: "Notes B, handout, 2 pages", exact: true }).click();
    const notesB = viewer(dm, "Notes B");
    await notesB.getByRole("button", { name: "Delete", exact: true }).waitFor();
    await notesB.getByRole("button", { name: "Close Notes B" }).click();
    await handouts.getByRole("button", { name: "Notes A, handout, 2 pages, showing now", exact: true }).click();
    const notesA = viewer(dm, "Notes A");
    await notesA.waitFor();
    assert.equal(await notesA.getByRole("button", { name: /^Delete/ }).count(), 0, "Delete on the showing document");
    await notesA.getByRole("button", { name: "Close Notes A" }).click();
    await ops.send({ t: "handout.close", handoutId: shownA });
  });

  test("13. view as a player: the popup with every page", async () => {
    const doc = await documentOf("Second letter", [await paper(1584, 2048, 1), await paper(1584, 2048, 2), await paper(1584, 2048, 3)]);
    const shown = await show(doc);
    await dm.getByRole("tab", { name: "DM", exact: true }).click();
    await dm.getByLabel("View as a player").selectOption({ label: "Pip" });
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pip" });
    await preview.waitFor();
    const popup = viewer(dm, "Second letter");
    await popup.waitFor();
    await indicatorIs(popup, "1 of 3", "the preview's popup");
    for (const n of [1, 2, 3]) assert.equal(await popup.getByRole("img", { name: `Second letter, page ${n} of 3`, exact: true }).count(), 1, `page ${n} in the preview`);
    await shots.take(dm, "pdf-view-as-player");
    await popup.getByRole("button", { name: /^Close/ }).click();
    await preview.getByRole("button", { name: "Exit" }).click();
    await preview.waitFor({ state: "detached" });
    await ops.send({ t: "handout.close", handoutId: shown });
  });

  test("14. every Library tile opens the viewer: the DM's image with its details and Delete in the header, focus on the next tile after, and a player's with neither (8.4)", async () => {
    const loose = [await uploadHandout(await paper(800, 600, 3)), await uploadHandout(await paper(800, 600, 4))];
    await dm.getByRole("tab", { name: "Library", exact: true }).click();
    const library = dm.getByRole("tabpanel", { name: "Library" });
    const handouts = library.getByRole("list", { name: "Handouts in this room" });
    const tileOf = (id: string) => handouts.locator(`li:has(img[src*="${id}"]) > button`);
    await tileOf(loose[0]!.assetId).waitFor();
    assert.equal(await tileOf(loose[0]!.assetId).getAttribute("aria-label"), "Handout, not in use");
    assert.match((await tileOf(loose[0]!.assetId).locator("xpath=..").locator("span[aria-hidden]").textContent()) ?? "", /Not in use/);
    // No card under the grid: the tile opens the viewer at once.
    await tileOf(loose[0]!.assetId).click();
    const view = viewer(dm, "Handout");
    await view.waitFor();
    await view.getByText(/^800 × 600 px, .+\. Not in use\.$/).waitFor();
    await shots.take(dm, "pdf-library-image-view");
    await view.getByRole("button", { name: "Delete", exact: true }).click();
    await view.getByRole("button", { name: "Delete it?" }).click();
    await view.waitFor({ state: "detached" });
    await library.getByText("Deleted 1 image.").waitFor();
    await waitFor("focus on the next tile", async () => (await focusedName(dm)) === "Handout, not in use" && (await tileOf(loose[1]!.assetId).evaluate((el) => el === (globalThis as unknown as Dom).document.activeElement)));

    // A player's token image opens too, with no status and no Delete.
    const token = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=token`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await paper(256, 256, 2) });
    assert.ok(token.ok());
    const tokenId = ((await token.json()) as { id: string }).id;
    // On a token every player sees, so it is in Pip's library.
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({
      t: "token.create",
      token: { id: randomUUID(), sceneId: dmSocket.state!.meta.playerSceneId, size: "medium", visibility: "all", kind: "monster", name: "Statue", x: 2, y: 2, image: { assetId: tokenId, crop: { cx: 0, cy: 0, zoom: 1 } }, actor: { inline: actor } },
    });
    await phone.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await phone.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Library/ }).tap();
    const tokens = phone.getByRole("list", { name: "Token images in this room" });
    const playerTile = tokens.locator(`li:has(img[src*="${tokenId}"]) > button`);
    await playerTile.waitFor();
    assert.equal(await playerTile.locator("xpath=..").locator("span[aria-hidden]").count(), 0, "a player's tile with a status");
    await playerTile.tap();
    const tokenView = viewer(phone, "Token image");
    await tokenView.waitFor();
    assert.equal(await tokenView.getByRole("button", { name: /^Delete/ }).count(), 0, "Delete for a player");
    assert.equal(await tokenView.getByText(/In use|Not in use/).count(), 0, "a status for a player");
    await shots.take(phone, "pdf-library-player-token");
    await tokenView.getByRole("button", { name: /^Close/ }).tap();
  });

});
