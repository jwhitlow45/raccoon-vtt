import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page, type Request, type Route } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, touchSwipe, untilTapsClick, waitFor, type Server } from "./harness.ts";
import { A5, BANDS, LETTER, LETTER_WIDE, bandProblem, fontBoxDistance, pdfOf, shapeProblem, type PdfPage } from "./pdfFixture.ts";

/**
 * PDF handouts end to end (docs/design-v1-pdf-handouts.md 11.3): a handout
 * of pages read like a PDF in the players' popup, paged with buttons, keys,
 * the wheel and a fling, loaded near the screen, remembered per showing,
 * downloaded as a PDF, and kept in the DM's Library as one item.
 *
 * Steps 1 to 6 upload PDFs as a DM does, with Upload a file in Show a
 * handout: small vector PDFs from pdfFixture.ts, and the files in
 * e2e/fixtures/ for a password, the scanners' codecs and an embedded font.
 * Each stored page is read back from the server and checked by its pixels.
 * Step 1's document, "Strange letter", is the one the later steps read
 * through `run.letter`. Their other handouts are made through the ops
 * (`documentOf`): ordinary handout images, each white paper with a band of
 * its own color in its top-left corner, as a PDF's page draws it, so the
 * same checks hold. A run from step 7 alone makes the letter that way too.
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
  /** The PDF step 11 downloaded, uploaded again in 11b. */
  downloaded: null as Buffer | null,
};

/** A handout upload's request: the PDF job's pages and the form's images go there. */
const HANDOUT_PUT = /\/api\/rooms\/[^/]+\/assets\?kind=handout$/;

type Answer = { id: string; width: number; height: number; created?: boolean };

/**
 * Every handout upload the DM's page sent, in the order sent, with its type
 * and its answer: null for one that failed, and never settling for one the
 * test's route holds.
 */
const sent: { type: string; answer: Promise<Answer | null> }[] = [];

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

type FilePick = { name: string; mimeType: string; buffer: Buffer };

function pdfFile(name: string, buffer: Buffer): FilePick {
  return { name, mimeType: "application/pdf", buffer };
}

function fixturePath(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url);
}

function fixture(name: string): FilePick {
  return pdfFile(name, readFileSync(fixturePath(name)));
}

/** A run of pages of one size, so each PDF's pages are its own bytes and none is taken for another PDF's page. */
function pagesOf(count: number, size: PdfPage): PdfPage[] {
  return Array.from({ length: count }, () => size);
}

/**
 * What the DM panel's count says, "1 upload waiting" while a PDF upload
 * waits on the DM: on its tab where the side panel's row holds it, else in
 * the description of More, which counts the panels it holds.
 */
async function dmCount(): Promise<string> {
  const list = dm.getByRole("tablist", { name: "Panels" });
  const tab = list.getByRole("tab", { name: sideTabName("DM") });
  if ((await tab.count()) > 0 && (await tab.getAttribute("aria-haspopup")) === null) return (await tab.textContent()) ?? "";
  const described = await list.locator('[role="tab"][aria-haspopup="menu"]').getAttribute("aria-describedby");
  return described ? ((await dm.locator(`[id="${described}"]`).textContent()) ?? "") : "";
}

function handoutForm(): Locator {
  return dm.getByRole("group", { name: "Show a handout" });
}

/** Opens Show a handout in the DM panel, ready for Upload a file, letting go of an image the form holds. */
async function openForm(): Promise<void> {
  await openSideTab(dm, "DM");
  const open = dm.getByRole("button", { name: "Show a handout" });
  // The panel draws a moment after its tab is pressed: the button when the form is closed, else the form.
  await open.or(handoutForm()).first().waitFor();
  if (await open.isVisible()) await open.click();
  const change = handoutForm().getByRole("button", { name: "Change" });
  if (await change.isVisible()) await change.click();
}

/** Picks a file with Show a handout's Upload a file. */
async function pickFile(file: FilePick): Promise<void> {
  await openForm();
  await handoutForm().getByLabel("Upload a file").setInputFiles(file);
}

/** The upload's block in the DM panel, a group named by its file. */
function jobBlock(fileName: string): Locator {
  return dm.getByRole("group", { name: `PDF upload, ${fileName}` });
}

/**
 * Words the block shows. Its spoken status line, hidden and first in the
 * block, repeats the start, each stop and the end, so the shown line is the
 * last match.
 */
function shown(block: Locator, text: string | RegExp): Locator {
  return block.getByText(text, { exact: typeof text === "string" }).last();
}

/** Presses the block's Upload, waits for its saved line, presses Done, and gives the new document from the DM's state. */
async function finishUpload(block: Locator, press: string, title: string, count: number): Promise<Doc> {
  const before = new Set(Object.keys(dmSocket.state?.handoutDocs ?? {}));
  await block.getByRole("button", { name: press, exact: true }).click();
  await shown(block, `Saved as ${title}, ${count === 1 ? "1 page" : `${count} pages`}.`).waitFor({ timeout: 90_000 });
  const doc = await waitFor("the new document in the DM's state", () => Object.values(dmSocket.state?.handoutDocs ?? {}).find((d) => d !== undefined && !before.has(d.id)));
  await block.getByRole("button", { name: "Done" }).click();
  await block.waitFor({ state: "detached" });
  return { id: doc.id, title: doc.title, pages: doc.pages.map((p) => ({ assetId: p.assetId, width: p.width, height: p.height })) };
}

/** A page's `full` image as the server stored it. */
async function stored(assetId: string): Promise<Buffer> {
  const res = await dmContext.request.get(`${server.origin}/api/assets/${assetId}/full`);
  assert.ok(res.ok(), `reading ${assetId} answered ${res.status()}`);
  return res.body();
}

async function assertBand(page: Page_, n: number, what: string): Promise<void> {
  const problem = await bandProblem(await stored(page.assetId), n);
  assert.equal(problem, null, `${what}: ${problem}`);
}

/** The ids in the room's library, as the DM lists them. */
async function libraryIds(): Promise<Set<string>> {
  const res = await dmContext.request.get(`${server.origin}/api/rooms/${run.roomId}/assets`);
  assert.ok(res.ok(), `listing the library answered ${res.status()}`);
  return new Set(((await res.json()) as { assets: { id: string }[] }).assets.map((a) => a.id));
}

/**
 * Deletes handout images the upload steps leave loose, so the Library's
 * steps find only the images they made themselves.
 */
async function deleteImages(ids: readonly string[]): Promise<void> {
  const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/assets/delete`, { headers: { Origin: server.origin, "content-type": "application/json" }, data: { ids } });
  assert.ok(res.ok(), `deleting ${ids.join(", ")} answered ${res.status()}`);
}

/** Waits until the page has asked for nothing for `ms`. */
async function quiet(page: Page, ms: number): Promise<void> {
  let last = Date.now();
  const onRequest = () => (last = Date.now());
  page.on("request", onRequest);
  try {
    await waitFor(`${ms} ms with no request`, () => Date.now() - last >= ms);
  } finally {
    page.off("request", onRequest);
  }
}

/** A promise and the call that settles it, to hold a request until the test lets it go. */
function gate(): { held: Promise<void>; release(): void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
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

/** A quick one-finger swipe through the browser's touch input, which a phone ends in a fling: moves 16 ms apart, several px a ms. */
async function swipe(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, steps = 6): Promise<void> {
  await touchSwipe(cdp, from, to, { steps, everyMs: 16 });
}

/** Where focus is in the page: the focused element's accessible name, as far as an aria-label or its text gives it. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as Dom).document.activeElement;
    return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
  });
}

/**
 * The Library on a phone, opened from the Panels list unless it is open
 * already: it stays open under a handout or an image opened from it, and
 * the Panels button would close it.
 */
async function phoneLibrary(page: Page): Promise<Locator> {
  const library = page.getByRole("region", { name: "Library" });
  if (!(await library.isVisible())) {
    await page.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
    await page.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Library/ }).tap();
  }
  await library.waitFor();
  return library;
}

type Box = { x: number; y: number; width: number; height: number };

/** The boxes of `parts`, read until two reads agree: a resize or a row that wraps lays the controls out again a moment later (PB-P-14). */
async function settledBoxes(parts: readonly Locator[], what: string): Promise<Box[]> {
  let last = "";
  return waitFor(what, async () => {
    const read = await Promise.all(parts.map((p) => p.boundingBox()));
    const same = JSON.stringify(read) === last;
    last = JSON.stringify(read);
    return same && read.every((r) => r !== null) ? (read as Box[]) : null;
  });
}
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("raccoon-vtt pdf handouts run", { timeout: 900_000 }, () => {
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
    // A policy violation fires on the document. The upload's step 1 reads the list.
    await dmContext.addInitScript(() => {
      const w = globalThis as unknown as { rvttCsp: string[]; document: { addEventListener(type: string, listener: (e: { violatedDirective: string; blockedURI: string }) => void): void } };
      w.rvttCsp = [];
      w.document.addEventListener("securitypolicyviolation", (e) => w.rvttCsp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    dm.on("request", (req) => {
      if (req.method() !== "PUT" || !HANDOUT_PUT.test(req.url())) return;
      const answer = req.response().then(
        async (res) => (res?.ok() ? ((await res.json()) as Answer) : null),
        () => null,
      );
      sent.push({ type: req.headers()["content-type"] ?? "", answer });
    });
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

  test("1. Upload: the DM's three-page PDF becomes one document, every request to the app's own origin, each stored page's band in place", async () => {
    const name = "Strange letter.pdf";
    const file = pdfFile(name, pdfOf([LETTER, LETTER_WIDE, A5], "Strange letter"));
    // pdf.js loads only when a PDF is picked. Held a moment, its loading line can be read.
    const reader = gate();
    const chunk = /\/assets\/pdfjs-[\w-]+\.js$/;
    await dm.route(chunk, async (route) => {
      await reader.held;
      await route.continue();
    });
    // Page 2's upload is held, so the progress line can be read while it waits.
    const second = gate();
    let puts = 0;
    await dm.route(HANDOUT_PUT, async (route) => {
      if (route.request().method() === "PUT" && ++puts === 2) await second.held;
      await route.continue();
    });
    const requests: { method: string; url: string }[] = [];
    const onRequest = (req: Request) => requests.push({ method: req.method(), url: req.url() });
    // The room's code for its other panels loads in the background once the DM panel opens. The upload starts after it, so every request from then on is the upload's.
    await openForm();
    await quiet(dm, 1_000);
    // As the app loads, zod tries eval once to see whether it may compile its parsers, and the policy's refusal fires the event. That is the app's, so the count starts with the upload.
    await dm.evaluate(() => void ((globalThis as unknown as { rvttCsp: string[] }).rvttCsp.length = 0));
    dm.on("request", onRequest);
    const from = sent.length;
    await handoutForm().getByLabel("Upload a file").setInputFiles(file);
    const block = jobBlock(name);
    await shown(block, "Loading the PDF reader…").waitFor();
    await shots.take(dm, "pdf-upload-loading");
    reader.release();
    await block.getByRole("heading", { name: "Strange letter.pdf, 3 pages." }).waitFor();
    assert.equal(await block.getByLabel("From page").inputValue(), "1");
    assert.equal(await block.getByLabel("To page").inputValue(), "3");
    assert.equal(await block.getByLabel("Title").inputValue(), "Strange letter", "the title from the PDF's Info");
    await shots.take(dm, "pdf-upload-range");
    await block.getByRole("button", { name: "Upload 3 pages", exact: true }).click();
    await shown(block, "Preparing page 2 of 3…").waitFor();
    // The progress line is not live, so a screen reader is not told every page (4.1.4).
    assert.equal(await shown(block, "Preparing page 2 of 3…").evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest('[role="status"], [aria-live]') === null), true, "the progress line is a live region");
    await shots.take(dm, "pdf-upload-preparing");
    second.release();
    await shown(block, "Saved as Strange letter, 3 pages.").waitFor({ timeout: 60_000 });
    // The form was open with nothing picked, so the saved document is picked at once (4.1.5).
    await handoutForm().getByRole("button", { name: "View", exact: true }).waitFor();
    assert.equal(await handoutForm().getByLabel("Title").inputValue(), "Strange letter");
    await shots.take(dm, "pdf-upload-saved");
    dm.off("request", onRequest);
    await dm.unroute(chunk);
    await dm.unroute(HANDOUT_PUT);

    // Every request went to the app: the reader's chunk, the job's worker and pdf.js's own code in it, the two decoders, and the pages.
    const saved = Object.values(dmSocket.state?.handoutDocs ?? {}).find((d) => d?.title === "Strange letter");
    const allowed = [
      // Once saved, the open form lists the new document by its first page's thumb.
      new RegExp(`^GET /api/assets/${saved?.pages[0]?.assetId}/thumb$`),
      /^GET \/assets\/pdfjs-[\w-]+\.js$/,
      /^GET \/assets\/(pdf\.)?worker-[\w-]+\.js$/,
      /^GET \/pdfjs\/6\.3\.289\/(jbig2|openjpeg)_nowasm_fallback\.js$/,
      /^PUT \/api\/rooms\/\w+\/assets\?kind=handout$/,
    ];
    const strays = requests.filter((r) => !r.url.startsWith(`${server.origin}/`) || !allowed.some((a) => a.test(`${r.method} ${r.url.slice(server.origin.length)}`)));
    assert.deepEqual(strays, [], "a request during the upload that is none of the reader's, the decoders' or the pages'");
    for (const name of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"]) assert.ok(requests.some((r) => r.url.endsWith(`/pdfjs/6.3.289/${name}`)), `${name} was never loaded`);
    const violations = await dm.evaluate(() => (globalThis as unknown as { rvttCsp: string[] }).rvttCsp);
    assert.deepEqual(violations, [], "a content security policy violation");

    // One document, its pages the sizes the uploads answered, each with its band upright and in order.
    const answers = await Promise.all(sent.slice(from).map((s) => s.answer));
    assert.equal(answers.length, 3);
    const docs = Object.values(dmSocket.state?.handoutDocs ?? {}).filter((d) => d !== undefined);
    assert.equal(docs.length, 1, "the state's documents");
    const doc = docs[0]!;
    assert.equal(doc.title, "Strange letter");
    assert.deepEqual(
      doc.pages.map((p) => [p.assetId, p.width, p.height]),
      answers.map((a) => [a!.id, a!.width, a!.height]),
      "the document's pages are not the uploads' answers",
    );
    for (const [i, [w, h]] of [[LETTER.width, LETTER.height], [LETTER_WIDE.width, LETTER_WIDE.height], [A5.width, A5.height]].entries()) {
      const p = doc.pages[i]!;
      assert.equal(Math.max(p.width, p.height), 2048, `page ${i + 1}'s long side`);
      assert.ok(Math.abs(p.width / p.height - w! / h!) < 0.01, `page ${i + 1} is ${p.width} x ${p.height}, not the shape of ${w} x ${h} pt`);
      await assertBand(p, i + 1, `Strange letter page ${i + 1}`);
    }
    run.letter = { id: doc.id, title: doc.title, pages: doc.pages.map((p) => ({ assetId: p.assetId, width: p.width, height: p.height })) };
    await block.getByRole("button", { name: "Done" }).click();
    await block.waitFor({ state: "detached" });
  });

  test("2. the range: a 140-page PDF starts at pages 1 to 100 with its sentence, and pages 87 to 89 upload as three pages", async () => {
    const name = "Long book.pdf";
    await pickFile(pdfFile(name, pdfOf(pagesOf(140, { width: 400, height: 600 }), "Long book")));
    const block = jobBlock(name);
    await shown(block, "This PDF has 140 pages. A handout holds up to 100, so choose which.").waitFor();
    assert.equal(await block.getByLabel("From page").inputValue(), "1");
    assert.equal(await block.getByLabel("To page").inputValue(), "100");
    await block.getByRole("button", { name: "Upload 100 pages", exact: true }).waitFor();
    await shots.take(dm, "pdf-upload-long-range");
    await block.getByLabel("From page").fill("87");
    await block.getByLabel("To page").fill("89");
    const doc = await finishUpload(block, "Upload 3 pages", "Long book", 3);
    for (const [i, p] of doc.pages.entries()) await assertBand(p, 87 + i, `Long book page ${87 + i}`);
  });

  test("3. refusals: a password, bytes that are no PDF, a blocked reader and a blocked decoder, none uploading a thing", async () => {
    const from = sent.length;
    const refusedAs = async (fileName: string, words: string, shot: string) => {
      const block = jobBlock(fileName);
      await shown(block, words).waitFor({ timeout: 30_000 });
      await shots.take(dm, shot);
      await block.getByRole("button", { name: "Dismiss" }).click();
      await block.waitFor({ state: "detached" });
    };
    await pickFile(fixture("password.pdf"));
    await refusedAs("password.pdf", "This PDF has a password. Save a copy without one, then upload that.", "pdf-refused-password");
    await pickFile(pdfFile("Notes.pdf", randomBytes(4096)));
    await refusedAs("Notes.pdf", "This PDF could not be read. It may be damaged.", "pdf-refused-invalid");

    // The job's worker blocked: the reader's refusal, and no PDF parsed on the page's own thread instead.
    const readerWords = "The PDF reader could not start here. Check your connection, then try again. If it keeps failing, update the browser or use a computer.";
    const letter = pdfFile("Strange letter.pdf", pdfOf([LETTER, LETTER_WIDE, A5], "Strange letter"));
    const workerScript = /\/assets\/worker-[\w-]+\.js$/;
    const asked: string[] = [];
    const onRequest = (req: Request) => asked.push(req.url());
    dm.on("request", onRequest);
    consoles.dm.allow = [/Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/, /ERR_BLOCKED_BY_CLIENT/];
    await dm.route(workerScript, (route) => route.abort("blockedbyclient"));
    await pickFile(letter);
    await refusedAs("Strange letter.pdf", readerWords, "pdf-refused-reader");
    await dm.unroute(workerScript);
    assert.ok(asked.some((u) => workerScript.test(u)), "the job's worker was never asked for");
    assert.deepEqual(asked.filter((u) => /\/pdf\.worker-/.test(u)), [], "pdf.js's worker code loaded on the page's thread");
    assert.equal(await dm.evaluate(() => "pdfjsWorker" in globalThis), false, "pdf.js set up its fallback worker on the page's thread");

    // A decoder blocked: the job stops when the file opens, not partway.
    const decoder = /\/pdfjs\/6\.3\.289\/openjpeg_nowasm_fallback\.js$/;
    asked.length = 0;
    await dm.route(decoder, (route) => route.abort("blockedbyclient"));
    await pickFile(letter);
    await refusedAs("Strange letter.pdf", readerWords, "pdf-refused-decoder");
    await dm.unroute(decoder);
    assert.ok(asked.some((u) => decoder.test(u)), "the decoder was never asked for");
    dm.off("request", onRequest);
    consoles.dm.allow = [];
    assert.equal(sent.length, from, "a refused PDF uploaded a page");
  });

  test("4. decoders and fonts: JBIG2, CCITT and JPEG 2000 pages store their black shape in place, and an embedded font draws as its reference", async () => {
    for (const name of ["jbig2.pdf", "ccitt.pdf", "jpx.pdf"]) {
      await pickFile(fixture(name));
      const doc = await finishUpload(jobBlock(name), "Upload 1 page", name.replace(/\.pdf$/, ""), 1);
      const problem = await shapeProblem(await stored(doc.pages[0]!.assetId));
      assert.equal(problem, null, `${name}: ${problem}`);
    }
    await pickFile(fixture("embedded-font.pdf"));
    const doc = await finishUpload(jobBlock("embedded-font.pdf"), "Upload 1 page", "Embedded font", 1);
    const distance = await fontBoxDistance(await stored(doc.pages[0]!.assetId), readFileSync(fixturePath("embedded-font.png")));
    if (process.env.E2E_DEBUG === "1") console.error(`the embedded font's text box is ${distance.toFixed(1)} gray levels from its reference`);
    assert.ok(distance < 12, `the embedded font's text box is ${distance.toFixed(1)} gray levels from its reference`);
  });

  test("5. ownership and Cancel: a page the library holds is reused and kept, Cancel removes only the job's own pages, and a page that never answers is named after the grace", async () => {
    const name = "Field notes.pdf";
    const file = pdfFile(name, pdfOf(pagesOf(6, { width: 500, height: 650 }), "Field notes"));
    // Page 2 alone, saved and then its document deleted: a loose handout image the DM kept.
    await pickFile(file);
    let block = jobBlock(name);
    await block.getByLabel("From page").fill("2");
    await block.getByLabel("To page").fill("2");
    const single = await finishUpload(block, "Upload 1 page", "Field notes", 1);
    await ops.send({ t: "handoutDoc.delete", docId: single.id });
    const kept = single.pages[0]!.assetId;

    // Every page, with page 4's upload held until Cancel is pressed after page 3.
    const fourth = gate();
    let puts = 0;
    let heldFourth = false;
    await dm.route(HANDOUT_PUT, async (route) => {
      if (route.request().method() === "PUT" && ++puts === 4) {
        heldFourth = true;
        await fourth.held;
      }
      await route.continue();
    });
    let from = sent.length;
    await pickFile(file);
    block = jobBlock(name);
    await block.getByRole("button", { name: "Upload 6 pages", exact: true }).click();
    await waitFor("page 4's upload", () => heldFourth);
    const answers = await Promise.all(sent.slice(from, from + 3).map((s) => s.answer));
    assert.deepEqual(
      answers.map((a) => a?.created),
      [true, false, true],
      "page 2's bytes were already in the library, so its upload made nothing",
    );
    assert.equal(answers[1]!.id, kept, "page 2 is not the kept image");
    await block.getByRole("button", { name: "Cancel upload" }).click();
    await block.getByRole("button", { name: "Cancelling…" }).waitFor();
    fourth.release();
    await shown(block, "Removed 3 pages.").waitFor({ timeout: 20_000 });
    await shots.take(dm, "pdf-cancelled");
    const own = [answers[0]!.id, answers[2]!.id, (await sent[from + 3]!.answer)!.id];
    const listed = await libraryIds();
    assert.ok(listed.has(kept), "Cancel removed the kept image");
    for (const id of own) assert.ok(!listed.has(id), `the job's own page ${id} is still in the library`);
    await block.getByRole("button", { name: "Done" }).click();
    await dm.unroute(HANDOUT_PUT);

    // Again, with page 4's upload never answered: Cancel waits out its grace, then names page 4.
    let hung: Route | null = null;
    puts = 0;
    await dm.route(HANDOUT_PUT, async (route) => {
      if (route.request().method() === "PUT" && ++puts === 4) {
        hung = route;
        return;
      }
      await route.continue();
    });
    from = sent.length;
    await pickFile(file);
    block = jobBlock(name);
    await block.getByRole("button", { name: "Upload 6 pages", exact: true }).click();
    await waitFor("page 4's upload", () => hung);
    consoles.dm.allow = [/net::ERR_/];
    const pressed = Date.now();
    await block.getByRole("button", { name: "Cancel upload" }).click();
    await shown(block, /^Page 4 was uploading and may remain in the library as a loose handout image, \d+ × \d+ px\.$/).waitFor({ timeout: 30_000 });
    const took = Date.now() - pressed;
    assert.ok(took >= 9_000 && took < 15_000, `Cancel ended ${took} ms after it was pressed, not about its 10 s grace`);
    await shown(block, "Removed 2 pages.").waitFor();
    await shots.take(dm, "pdf-cancelled-uncertain");
    await block.getByRole("button", { name: "Done" }).click();
    await block.waitFor({ state: "detached" });
    await (hung as Route | null)?.abort().catch(() => {});
    await dm.unroute(HANDOUT_PUT);
    consoles.dm.allow = [];
    assert.ok((await libraryIds()).has(kept), "the kept image after the second Cancel");
    await deleteImages([kept]);
  });

  test("6. the job outside the form: the DM panel closed and opened, Show still working, an image sent first, a failed upload's pause, the Panels count, and a reload's recovery", async () => {
    const name = "Thirty.pdf";
    const file = pdfFile(name, pdfOf(pagesOf(30, { width: 600, height: 800 }), "Thirty"));
    // Page 2's upload is held while the DM works elsewhere, and page 4's fails once the block is out of sight.
    const second = gate();
    const fourth = gate();
    let pages = 0;
    let atFourth = false;
    await dm.route(HANDOUT_PUT, async (route) => {
      const req = route.request();
      if (req.method() !== "PUT" || (req.headers()["content-type"] ?? "").startsWith("image/png")) return route.continue();
      const n = ++pages;
      if (n === 2) await second.held;
      if (n === 4) {
        atFourth = true;
        await fourth.held;
        return route.abort("internetdisconnected");
      }
      await route.continue();
    });
    const from = sent.length;
    await pickFile(file);
    const block = jobBlock(name);
    await block.getByRole("button", { name: "Upload 30 pages", exact: true }).click();
    await shown(block, "Preparing page 2 of 30…").waitFor();

    // The DM panel closed and opened again: the job went on meanwhile, and its block shows the same progress.
    await openSideTab(dm, "Library");
    await block.waitFor({ state: "hidden" });
    await openSideTab(dm, "DM");
    await shown(block, "Preparing page 2 of 30…").waitFor();
    assert.equal(await block.getByRole("progressbar", { name: "Pages uploaded" }).getAttribute("aria-valuenow"), "1");
    await shots.take(dm, "pdf-job-panel-reopened");

    // From the library and Show still show another handout: step 2's document.
    const form = handoutForm();
    await form.getByRole("button", { name: "From the library" }).click();
    await form.getByRole("button", { name: "Use Long book, 3 pages" }).click();

    await form.getByRole("button", { name: "Show", exact: true }).click();
    const showing = dm.getByRole("list", { name: "Handouts showing" }).getByRole("listitem").filter({ hasText: "Long book" });
    await showing.waitFor();
    await shots.take(dm, "pdf-job-beside-a-showing");
    // Hide stops showing it to players (docs/design-v1-icons.md 2.3).
    await showing.getByRole("button", { name: "Hide", exact: true }).click();
    await showing.waitFor({ state: "detached" });

    // An image uploaded in the form meanwhile goes before the job's next page.
    await dm.getByRole("button", { name: "Show a handout" }).click();
    await form.getByLabel("Upload a file").setInputFiles({ name: "Map scrap.png", mimeType: "image/png", buffer: await paper(300, 200, 5) });
    await form.getByText(/^(Uploading…|Waiting for the server…)$/).waitFor();
    second.release();
    await form.getByRole("button", { name: "Change" }).waitFor();
    await waitFor("page 3's upload", () => sent.length - from >= 4);
    assert.deepEqual(
      sent.slice(from, from + 4).map((s) => (s.type.startsWith("image/png") ? "image" : "page")),
      ["page", "page", "image", "page"],
      "the form's image did not go before the job's next page",
    );
    const scrap = (await sent[from + 2]!.answer)!.id;
    // A picked image has View, as a picked document has (the project owner, 2026-10-16).
    await form.getByRole("button", { name: "View", exact: true }).click();
    const scrapView = viewer(dm, "Map scrap");
    await scrapView.waitFor();
    await scrapView.getByText("300 × 200 px.").waitFor();
    await scrapView.getByRole("button", { name: "Close Map scrap" }).click();
    await scrapView.waitFor({ state: "detached" });
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    // Page 4's upload fails while the block is out of sight: a toast, and the DM panel's badge.
    await waitFor("page 4's upload", () => atFourth);
    await openSideTab(dm, "Library");
    await block.waitFor({ state: "hidden" });
    // The block's sight is read by an observer, which reports on the next frame.
    await dm.waitForTimeout(300);
    consoles.dm.allow = [/net::ERR_INTERNET_DISCONNECTED/];
    fourth.release();
    await dm.locator("[data-toast]").getByText("The PDF upload paused at page 4. Open Handouts in the DM panel to go on.").waitFor();
    await waitFor("the DM panel's badge", async () => /1 upload waiting/.test(await dmCount()));
    await shots.take(dm, "pdf-job-paused-toast");

    // On a phone's width the Panels button counts the waiting upload.
    await dm.setViewportSize({ width: 390, height: 844 });
    const panels = dm.locator('nav[aria-label="Tools"] button[title="Panels"]');
    await waitFor("the Panels button's count", async () => ((await panels.textContent()) ?? "").includes("1 upload waiting"));
    await shots.take(dm, "pdf-job-panels-count");
    await dm.setViewportSize({ width: 1280, height: 800 });

    // Try again finishes all 30, in order.
    await openSideTab(dm, "DM");
    await shown(block, "The upload stopped at page 4. Check your connection.").waitFor();
    await shots.take(dm, "pdf-job-paused");
    await block.getByRole("button", { name: "Try again", exact: true }).click();
    await shown(block, "Saved as Thirty, 30 pages.").waitFor({ timeout: 90_000 });
    // Show it puts the document in the form in place of the image picked there. The title the form filled in from the image's name gives way to the document's, as only a typed one stays (the project owner, 2026-10-16).
    await block.getByRole("button", { name: "Show it" }).click();
    await handoutForm().getByText("30 pages", { exact: true }).waitFor();
    assert.equal(await handoutForm().getByLabel("Title").inputValue(), "Thirty");
    await shots.take(dm, "pdf-job-show-it");
    const thirty = { pages: Object.values(dmSocket.state?.handoutDocs ?? {}).find((d) => d?.title === "Thirty")!.pages };
    await handoutForm().getByRole("button", { name: "Change" }).click();
    await handoutForm().getByRole("button", { name: "Cancel", exact: true }).click();
    await block.getByRole("button", { name: "Done" }).click();
    await block.waitFor({ state: "detached" });
    consoles.dm.allow = [];
    await dm.unroute(HANDOUT_PUT);
    assert.equal(thirty.pages.length, 30);
    for (const [i, p] of thirty.pages.entries()) await assertBand(p, i + 1, `Thirty page ${i + 1}`);

    // A reload mid-upload: the recovery line, and Remove them deletes exactly the ledger's pages.
    const torn = "Torn map.pdf";
    let hung: Route | null = null;
    let puts = 0;
    await dm.route(HANDOUT_PUT, async (route) => {
      if (route.request().method() === "PUT" && ++puts === 4) {
        hung = route;
        return;
      }
      await route.continue();
    });
    await pickFile(pdfFile(torn, pdfOf(pagesOf(6, { width: 520, height: 520 }), "Torn map")));
    await jobBlock(torn).getByRole("button", { name: "Upload 6 pages", exact: true }).click();
    await waitFor("page 4's upload", () => hung);
    const key = `rvtt.pdfUpload.${run.roomId}.${dmSocket.you!.memberId}`;
    const ledger = JSON.parse((await dm.evaluate((k) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(k), key)) ?? "null") as { ids: string[] } | null;
    assert.equal(ledger?.ids.length, 3, "the ledger's pages before the reload");
    const before = await libraryIds();
    dm.once("dialog", (d) => void d.accept());
    consoles.dm.allow = [/net::ERR_/];
    await dm.reload();
    await (hung as Route | null)?.abort().catch(() => {});
    await dm.unroute(HANDOUT_PUT);
    await openSideTab(dm, "DM");
    const recovery = jobBlock("Torn map");
    await shown(recovery, "A PDF upload did not finish: Torn map, 3 pages are in the library.").waitFor({ timeout: 30_000 });
    await shots.take(dm, "pdf-recovery");
    await recovery.getByRole("button", { name: "Remove them" }).click();
    await shown(recovery, "Removed 3 pages.").waitFor();
    const after = await libraryIds();
    assert.deepEqual([...before].filter((id) => !after.has(id)).sort(), [...ledger!.ids].sort(), "Remove them deleted other than the ledger's pages");
    assert.equal(await dm.evaluate((k) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(k), key), null, "the ledger after Remove them");
    await recovery.getByRole("button", { name: "Done" }).click();
    await recovery.waitFor({ state: "detached" });
    consoles.dm.allow = [];
    await deleteImages([scrap]);
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
    // The steps after take taps, which Chrome's own fling from these swipes would swallow.
    await untilTapsClick(phone, popup.getByRole("heading", { name: "Strange letter", exact: true }));
    assert.ok(p1);
  });

  test("7b. Reset zoom comes and goes to the left of the zoom buttons, which never move, at 320 x 480, 390 x 844 and a very short 844 x 390, and at 320 px the page row has its own line", async () => {
    const popup = viewer(phone, "Strange letter");
    const reset = popup.getByRole("button", { name: "Reset zoom" });
    const zoomButtons = [popup.getByRole("button", { name: "Zoom out" }), popup.getByRole("button", { name: "Zoom in" })];
    try {
      for (const size of [
        { width: 320, height: 480 },
        { width: 390, height: 844 },
        { width: 844, height: 390 },
      ]) {
        await phone.setViewportSize(size);
        const what = `${size.width} x ${size.height}`;
        const atRest = await settledBoxes(zoomButtons, `the zoom buttons at rest at ${what}`);
        assert.equal(await reset.count(), 0, `Reset zoom at rest at ${what}`);
        await zoomButtons[1]!.tap();
        await reset.waitFor();
        const magnified = await settledBoxes(zoomButtons, `the zoom buttons magnified at ${what}`);
        assert.deepEqual(magnified, atRest, `Reset zoom moved the zoom buttons at ${what}`);
        const icon = (await reset.boundingBox())!;
        assert.ok(icon.x + icon.width <= magnified[0]!.x + 1 && Math.abs(icon.y - magnified[0]!.y) < 1, `Reset zoom is not to the left of the zoom buttons at ${what}: ${JSON.stringify(icon)}`);
        assert.ok(icon.width >= 44 && icon.height >= 44, `Reset zoom is too small at ${what}`);
        // Its name shows in a tooltip on hover, focus or a long press, never as a native title (docs/design-v1-icons.md 3.2).
        assert.equal(await reset.getAttribute("aria-label"), "Reset zoom");
        assert.equal(await reset.getAttribute("title"), null);
        if (size.width === 320) {
          const row = popup.getByRole("button", { name: "Previous page" }).locator("..");
          const zoom = popup.getByRole("button", { name: "Zoom in" }).locator("..");
          const [a, b] = (await settledBoxes([row, zoom], "the page row and the zoom buttons at 320 px")) as [Box, Box];
          assert.equal(intersects(a, b), false, `the page row ${JSON.stringify(a)} meets the zoom buttons ${JSON.stringify(b)}`);
          assert.ok(a.y + a.height <= b.y + 1, "the page row is not above the zoom buttons");
          await shots.take(phone, "pdf-popup-320-magnified");
        } else await shots.take(phone, `pdf-popup-${size.width}-reset-zoom`);
        await reset.tap();
        await reset.waitFor({ state: "hidden" });
        assert.deepEqual(await settledBoxes(zoomButtons, `the zoom buttons after Reset zoom at ${what}`), atRest, `the zoom buttons moved as Reset zoom left at ${what}`);
      }
    } finally {
      await phone.setViewportSize({ width: 390, height: 844 });
    }
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

  test("7d. the DM's Showing now: the thumbnail opens the viewer at the players' showing with its details, focus comes back to it, and the document's View has a key of its own (8.4)", async () => {
    await openSideTab(dm, "DM");
    const thumb = dm.getByRole("list", { name: "Handouts showing" }).getByRole("button", { name: "View Strange letter" });
    await thumb.click();
    const view = viewer(dm, "Strange letter");
    await view.waitFor();
    await view.getByText("To Everyone, 3 pages. Showing now.").waitFor();
    await indicatorIs(view, "1 of 3", "the DM's view of the showing");
    await view.getByRole("button", { name: "Next page" }).click();
    await indicatorIs(view, "2 of 3", "Next page in the DM's view");
    await shots.take(dm, "pdf-dm-showing-view");
    await view.getByRole("button", { name: "Close Strange letter" }).click();
    await view.waitFor({ state: "detached" });
    assert.equal(await thumb.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "focus did not come back to the thumbnail");
    // The same showing opens where the DM left it, as the players' popup does.
    await thumb.click();
    await indicatorIs(view, "2 of 3", "the same showing again");
    await view.getByRole("button", { name: "Close Strange letter" }).click();
    await view.waitFor({ state: "detached" });

    // The document picked in the form opens under its own key, at page 1, with its page count and that it shows.
    await openForm();
    await handoutForm().getByRole("button", { name: "Use Strange letter, 3 pages" }).click();
    const open = handoutForm().getByRole("button", { name: "View", exact: true });
    await open.click();
    await view.waitFor();
    await view.getByText("3 pages. Showing now.").waitFor();
    await indicatorIs(view, "1 of 3", "the document's own View");
    await view.getByRole("button", { name: "Close Strange letter" }).click();
    await view.waitFor({ state: "detached" });
    assert.equal(await open.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "focus did not come back to View");
    await handoutForm().getByRole("button", { name: "Change" }).click();
    await handoutForm().getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("7e. the DM panel's viewer is the Library's: thumbs stand in on a slow link, and a document deleted on another device closes it from either View (8.4, 5.9)", async () => {
    const letter = run.letter!;
    const isFocused = (l: Locator) => l.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement);
    // Showing now's view on a slow link: page 1's thumb stands in until its full image arrives.
    const first = `**/api/assets/${letter.pages[0]!.assetId}/full`;
    const slow = gate();
    await dm.route(first, async (route) => {
      await slow.held;
      await route.continue();
    });
    await openSideTab(dm, "DM");
    await dm.getByRole("list", { name: "Handouts showing" }).getByRole("button", { name: "View Strange letter" }).click();
    const view = viewer(dm, "Strange letter");
    await view.waitFor();
    await view.locator(`img[src$="/${letter.pages[0]!.assetId}/thumb"]`).waitFor();
    assert.equal(await view.getByRole("status").filter({ hasText: /^Loading page/ }).count(), 0, "a page's loading line is a live region");
    await shots.take(dm, "pdf-dm-view-thumb-first");
    slow.release();
    await waitFor("page 1's full image", () => loaded(pageImage(view, "Strange letter", 1, 3)));
    await dm.unroute(first);
    await view.getByRole("button", { name: "Close Strange letter" }).click();
    await view.waitFor({ state: "detached" });

    // The form's View of a document another DM device deletes: the viewer closes, and focus lands on the form, whose pick went with it.
    const spare = await documentOf("Spare notes", [await paper(1000, 1300, 4), await paper(1000, 1300, 5)]);
    await openForm();
    await handoutForm().getByRole("button", { name: "Use Spare notes, 2 pages" }).click();
    await handoutForm().getByRole("button", { name: "View", exact: true }).click();
    const spareView = viewer(dm, "Spare notes");
    await spareView.waitFor();
    await ops.send({ t: "handoutDoc.delete", docId: spare.id });
    await spareView.waitFor({ state: "detached" });
    await handoutForm().getByText("That handout was deleted.").waitFor();
    await waitFor("focus on the form", () => handoutForm().evaluate((el) => (el as unknown as { contains(n: unknown): boolean }).contains((globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement)));
    await handoutForm().getByRole("button", { name: "Cancel", exact: true }).click();

    // The saved upload's View, the same: the viewer closes and focus goes back to View, still there.
    await pickFile(pdfFile("Spare.pdf", pdfOf([{ width: 300, height: 420 }], "Spare")));
    const block = jobBlock("Spare.pdf");
    await block.getByRole("button", { name: "Upload 1 page", exact: true }).click();
    await shown(block, "Saved as Spare, 1 page.").waitFor({ timeout: 60_000 });
    const viewButton = block.getByRole("button", { name: "View", exact: true });
    await viewButton.click();
    const saved = viewer(dm, "Spare");
    await saved.waitFor();
    const doc = Object.values(dmSocket.state?.handoutDocs ?? {}).find((d) => d?.title === "Spare")!;
    await ops.send({ t: "handoutDoc.delete", docId: doc.id });
    await saved.waitFor({ state: "detached" });
    await waitFor("focus back on View", () => isFocused(viewButton));
    await block.getByRole("button", { name: "Done" }).click();
    await block.waitFor({ state: "detached" });
    await handoutForm().getByRole("button", { name: "Cancel", exact: true }).click();
    await deleteImages(doc.pages.map((p) => p.assetId).concat(spare.pages.map((p) => p.assetId)));
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

    // Zoom out from the card's width fit reaches the page fit, where a whole page shows, and stops there. Reset zoom comes at the zoom buttons' left, and they stay where they were.
    const deskZoom = [popup.getByRole("button", { name: "Zoom out" }), popup.getByRole("button", { name: "Zoom in" })];
    const cardRest = await settledBoxes(deskZoom, "the card's zoom buttons at rest");
    const out = popup.getByRole("button", { name: "Zoom out" });
    for (let i = 0; (await out.isEnabled()) && i < 10; i++) await out.click();
    assert.equal(await out.isEnabled(), false);
    const stageBox = (await stage(popup).boundingBox())!;
    const first = (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())!;
    assert.ok(first.height <= stageBox.height + 1, `no whole page at the page fit: ${JSON.stringify(first)} in ${JSON.stringify(stageBox)}`);
    assert.deepEqual(await settledBoxes(deskZoom, "the card's zoom buttons at the page fit"), cardRest, "Reset zoom moved the card's zoom buttons");
    await shots.take(desk, "pdf-desk-page-fit");
    await popup.getByRole("button", { name: "Reset zoom" }).click();
    await indicatorIs(popup, "1 of 4", "Reset zoom on the same page");
    assert.equal(await popup.getByRole("button", { name: "Reset zoom" }).count(), 0);

    // A wheel that reports lines scrolls at a reading pace. The viewer claims it, so nothing under the dialog scrolls with it.
    const wheel = (init: object) =>
      stage(popup).evaluate((el, init) => {
        const w = globalThis as unknown as { WheelEvent: new (t: string, i: object) => unknown };
        // dispatchEvent answers false when a listener called preventDefault.
        return !(el as unknown as Element_).dispatchEvent(new w.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 600, clientY: 400, ...init }));
      }, init);
    const before = (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())!;
    assert.equal(await wheel({ deltaY: 3, deltaMode: 1 }), true, "the viewer left a plain wheel to the browser");
    await waitFor("the wheel to scroll", async () => before.y - (await pageImage(popup, "Mixed pages", 1, 4).boundingBox())!.y >= 100);
    // Ctrl with the wheel, as a trackpad's pinch sends it, zooms the picture and is claimed, so the browser does not zoom the page as well.
    assert.equal(await wheel({ deltaY: -100, ctrlKey: true }), true, "the viewer left Ctrl with the wheel to the browser, which zooms the page");
    await popup.getByRole("button", { name: "Reset zoom" }).waitFor();
    await popup.getByRole("button", { name: "Reset zoom" }).click();
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
    await phoneLibrary(phone);
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

    // On page 14, another handout of other pages and sizes comes and goes: the first comes back at page 14, never at a page the other's layout worked out (PDF-BUILD-ASTRA-06).
    await desk.keyboard.press("Home");
    await indicatorIs(popup, "1 of 30", "Home before paging to 14");
    for (let i = 0; i < 13; i++) await popup.getByRole("button", { name: "Next page" }).click();
    await indicatorIs(popup, "14 of 30", "Next page to page 14");
    const other = await documentOf("Short notes", [await paper(1000, 300, 3), await paper(1000, 300, 4)]);
    const otherId = await show(other, [run.patId]);
    const notes = viewer(desk, "Short notes");
    await notes.waitFor();
    await indicatorIs(notes, "All 2 pages", "the other handout");
    await notes.getByRole("button", { name: /^Close/ }).click();
    await popup.waitFor();
    await indicatorIs(popup, "14 of 30", "the first handout again");
    await ops.send({ t: "handout.close", handoutId: otherId });
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
    run.downloaded = bytes;
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
    // Try again left with focus on it: focus is on Download, so the page keys still reach the viewer (PB-P-8).
    await waitFor("focus on Download after Try again", async () => (await focusedName(desk)) === "Download");
    await desk.keyboard.press("End");
    await indicatorIs(popup, "3 of 3", "End after Try again");
    await desk.keyboard.press("Home");

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
    await waitFor("focus on Download after Cancel", async () => (await focusedName(phone)) === "Download");
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
    await phoneLibrary(phone);
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

  test("11b. the download uploaded again: its pages come back in order, upright and in color", async () => {
    const letter = run.letter!;
    await pickFile(pdfFile("Strange letter.pdf", run.downloaded!));
    const block = jobBlock("Strange letter.pdf");
    await block.getByRole("button", { name: "Upload 3 pages", exact: true }).waitFor();
    // A title of its own, so the Library's tiles for the letter stay one of a kind.
    await block.getByLabel("Title").fill("Strange letter again");
    const again = await finishUpload(block, "Upload 3 pages", "Strange letter again", 3);
    for (const [i, p] of again.pages.entries()) {
      const was = letter.pages[i]!;
      assert.equal(p.width > p.height, was.width > was.height, `page ${i + 1} turned on its side`);
      await assertBand(p, i + 1, `the downloaded letter's page ${i + 1}`);
    }
    await ops.send({ t: "handoutDoc.delete", docId: again.id });
    await deleteImages(again.pages.map((p) => p.assetId));
  });

  test("11c. a PDF download is heard once as it starts and once as it is ready, never page by page", async () => {
    const letter = run.letter!;
    const popup = viewer(desk, "Strange letter");
    await popup.waitFor();
    const second = `**/api/assets/${letter.pages[1]!.assetId}/full`;
    const hold = gate();
    await desk.route(second, async (route) => {
      if (route.request().resourceType() === "fetch") await hold.held;
      await route.continue().catch(() => {});
    });
    const [saved] = await Promise.all([desk.waitForEvent("download"), (async () => {
      await popup.getByRole("button", { name: "Download", exact: true }).click();
      const line = popup.getByText("Preparing the PDF: page 2 of 3");
      await line.waitFor();
      assert.equal(await line.evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest('[role="status"], [aria-live]') === null), true, "the progress line is a live region");
      await popup.getByRole("status").filter({ hasText: "Preparing the PDF." }).waitFor();
      hold.release();
    })()]);
    assert.equal(saved.suggestedFilename(), "Strange letter.pdf");
    await popup.getByRole("status").filter({ hasText: "The PDF is ready." }).waitFor();
    await desk.unroute(second);
  });

  test("12. the DM's Library: the document as one tile with its pages, its details in the viewer, no Delete while it shows, then Delete with its pages", async () => {
    const letter = run.letter!;
    await openSideTab(dm, "Library");
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
    // The details describe the viewer, so a screen reader hears them as it opens.
    const described = await view.getAttribute("aria-describedby");
    assert.ok(described, "the viewer has no description");
    assert.match((await dm.locator(`[id="${described}"]`).textContent()) ?? "", /^3 pages, .+ Showing now\./);
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
    // Its images' delete fails first, offline: the note keeps them with Try again, which hands focus to the note as it leaves.
    const deleteRoute = `**/api/rooms/${run.roomId}/assets/delete`;
    await dm.route(deleteRoute, (route) => route.abort("internetdisconnected"));
    consoles.dm.allow = [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/];
    await remove.click();
    await view.getByRole("button", { name: "Delete all 3 pages?" }).click();
    await view.waitFor({ state: "detached" });
    const retryDelete = library.getByRole("button", { name: "Try again" });
    await retryDelete.waitFor();
    await dm.unroute(deleteRoute);
    consoles.dm.allow = [];
    await retryDelete.click();
    await library.getByText("Deleted Strange letter and its 3 pages.").waitFor();
    await waitFor("focus on the delete's note", () =>
      dm.evaluate(() => ((globalThis as unknown as { document: { activeElement: { textContent: string | null } | null } }).document.activeElement?.textContent ?? "").includes("Deleted Strange letter")),
    );
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

  test("13. view as a player: the popup with every page, once the DM shows it with the player in the room", async () => {
    const doc = await documentOf("Second letter", [await paper(1584, 2048, 1), await paper(1584, 2048, 2), await paper(1584, 2048, 3)]);
    const shown = await show(doc);
    await openSideTab(dm, "DM");
    await dm.getByLabel("View as a player").selectOption({ label: "Pip" });
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pip" });
    await preview.waitFor();
    const popup = viewer(dm, "Second letter");
    // Showing before the preview opened, it waits in the Library, as for a player who joins. The preview's view is the DM's own, so two frames settle it.
    await dm.evaluate(() => {
      const w = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
      return new Promise<void>((done) => w.requestAnimationFrame(() => w.requestAnimationFrame(done)));
    });
    assert.equal(await popup.count(), 0, "a handout already showing popped up as the preview opened");
    await ops.send({ t: "handout.show", handout: { id: shown, pages: doc.pages, title: doc.title, to: "all" } });
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
    await openSideTab(dm, "Library");
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
    await phoneLibrary(phone);
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

    // Clean up's last delete takes its button away: focus goes to its section, which says what was deleted.
    const cleanUp = library.getByRole("button", { name: /^Delete \d+ not in use/ });
    await cleanUp.waitFor();
    await cleanUp.click();
    await library.getByRole("button", { name: /^Delete (it|all \d+)\?$/ }).click();
    await library.getByText(/^Deleted \d+ images?\.$/).waitFor();
    assert.equal(await cleanUp.count(), 0, "images left not in use");
    await waitFor("focus on the Clean up section", () =>
      dm.evaluate(() => ((globalThis as unknown as { document: { activeElement: { tagName: string; textContent: string | null } | null } }).document.activeElement?.tagName ?? "") === "SECTION"),
    );
  });

  test("15. a player's thumbnail under Handouts from the DM opens the handout's own popup, with Download, at the page it was left on, as Open does (the project owner, 2026-10-16)", async () => {
    const doc = await documentOf("Last letter", [await paper(1584, 2048, 1), await paper(1584, 2048, 2), await paper(1584, 2048, 3)]);
    const id = await show(doc, [run.patId]);
    const popup = viewer(desk, "Last letter");
    await popup.waitFor();
    await popup.getByRole("button", { name: "Next page" }).click();
    await indicatorIs(popup, "2 of 3", "Next page in the popup");
    await popup.getByRole("button", { name: /^Close/ }).click();
    await popup.waitFor({ state: "detached" });
    await openSideTab(desk, "Library");
    await desk.getByRole("list").getByRole("button", { name: "View Last letter" }).click();
    await popup.waitFor();
    await indicatorIs(popup, "2 of 3", "the showing's own page, as the popup left it");
    await popup.getByRole("button", { name: "Download", exact: true }).waitFor();
    await popup.getByText("The DM shows you").waitFor();
    await shots.take(desk, "pdf-player-thumbnail-popup");
    // The DM closes it while the player looks: the popup closes with it.
    await ops.send({ t: "handout.close", handoutId: id });
    await popup.waitFor({ state: "detached" });
  });

  test("16. opening a handout or an image from the Library or the DM panel and closing it comes back to the panel, with focus on what opened it, on a phone, a very short screen and a computer (the project owner, 2026-10-16)", async () => {
    const doc = await documentOf("Loop letter", [await paper(1584, 2048, 1), await paper(1584, 2048, 2)]);
    const id = await show(doc);
    const closePopup = async (page: Page) => {
      const popup = viewer(page, "Loop letter");
      await popup.waitFor();
      await popup.getByRole("button", { name: /^Close/ }).click();
      await popup.waitFor({ state: "detached" });
    };
    // The popup the showing opens on its own, closed first.
    await closePopup(phone);
    await closePopup(desk);
    const backTo = async (page: Page, region: string, focused: string, what: string) => {
      assert.equal(await page.getByRole("region", { name: region }).isVisible(), true, `${what}: the ${region} sheet closed`);
      await waitFor(`${what}: focus on ${focused}`, async () => (await focusedName(page)) === focused);
    };

    // A player's phone: Open, the thumbnail, and a token image's tile.
    let library = await phoneLibrary(phone);
    const row = library.getByRole("listitem").filter({ hasText: "Loop letter" });
    await row.getByRole("button", { name: "Open" }).tap();
    await closePopup(phone);
    await backTo(phone, "Library", "Open", "Open on a phone");
    await row.getByRole("button", { name: "View Loop letter" }).tap();
    await closePopup(phone);
    await backTo(phone, "Library", "View Loop letter", "the thumbnail on a phone");
    const tile = library.getByRole("list", { name: "Token images in this room" }).getByRole("button").first();
    const tileName = (await tile.getAttribute("aria-label")) ?? "";
    await tile.tap();
    const image = viewer(phone, tileName);
    await image.waitFor();
    await shots.take(phone, "pdf-phone-library-under-viewer");
    await image.getByRole("button", { name: /^Close/ }).tap();
    await image.waitFor({ state: "detached" });
    await backTo(phone, "Library", tileName, "a tile on a phone");
    await shots.take(phone, "pdf-phone-library-after-viewer");

    // A very short screen, the phone held sideways.
    await phone.setViewportSize({ width: 844, height: 390 });
    try {
      library = await phoneLibrary(phone);
      await row.getByRole("button", { name: "Open" }).tap();
      await closePopup(phone);
      await backTo(phone, "Library", "Open", "Open on a very short screen");
      await tile.tap();
      await image.waitFor();
      await image.getByRole("button", { name: /^Close/ }).tap();
      await image.waitFor({ state: "detached" });
      await backTo(phone, "Library", tileName, "a tile on a very short screen");
      await shots.take(phone, "pdf-short-library-after-viewer");
    } finally {
      await phone.setViewportSize({ width: 390, height: 844 });
    }

    // The DM on a phone: Showing now's thumbnail in the DM panel, and a Library tile.
    await dm.setViewportSize({ width: 390, height: 844 });
    try {
      const panels = dm.locator('nav[aria-label="Tools"] button[title="Panels"]');
      // The Panels button closes a sheet another panel has open, and opens the list from nothing.
      const panel = async (name: string) => {
        const region = dm.getByRole("region", { name });
        const list = dm.getByRole("list", { name: "Panels" });
        for (let i = 0; i < 3 && !(await region.isVisible()); i++) {
          if (await list.isVisible()) await list.getByRole("button", { name: new RegExp(`^${name}`) }).click();
          else await panels.click();
          await dm.waitForTimeout(200);
        }
        await region.waitFor();
        return region;
      };
      const dmPanel = await panel("DM");
      await dmPanel.getByRole("button", { name: "View Loop letter" }).click();
      await closePopup(dm);
      await backTo(dm, "DM", "View Loop letter", "Showing now on a phone");
      const dmLibrary = await panel("Library");
      const dmTile = dmLibrary.getByRole("list", { name: "Handouts in this room" }).getByRole("button", { name: "Loop letter, handout, 2 pages, showing now", exact: true });
      await dmTile.click();
      await closePopup(dm);
      await backTo(dm, "Library", "Loop letter, handout, 2 pages, showing now", "a Library tile on the DM's phone");
    } finally {
      await dm.setViewportSize({ width: 1280, height: 800 });
    }

    // A computer's side panel.
    await openSideTab(dm, "Library");
    const side = dm.getByRole("tabpanel", { name: "Library" });
    const sideTile = side.getByRole("list", { name: "Handouts in this room" }).getByRole("button", { name: "Loop letter, handout, 2 pages, showing now", exact: true });
    await sideTile.click();
    await closePopup(dm);
    assert.equal(await side.isVisible(), true, "the side panel's Library closed");
    await waitFor("focus on the tile at a computer", async () => (await focusedName(dm)) === "Loop letter, handout, 2 pages, showing now");
    await ops.send({ t: "handout.close", handoutId: id });
  });

  test("lp4-library-retry. the Library's list fails: its handouts and the images on the map still open, and Try again shows the loading line, keeps focus in the panel, then lists the room (docs/design-v1-look-pass.md 2.9)", async () => {
    // A document and a token's image of this step's own, so it needs no earlier step's.
    const doc = await documentOf("Retry letter", [await paper(1584, 2048, 2)]);
    const upload = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=token`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await paper(256, 256, 3) });
    assert.ok(upload.ok());
    const imageId = ((await upload.json()) as { id: string }).id;
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({
      t: "token.create",
      token: { id: randomUUID(), sceneId: dmSocket.state!.meta.playerSceneId, size: "medium", visibility: "all", kind: "monster", name: "Gargoyle", x: 3, y: 2, image: { assetId: imageId, crop: { cx: 0, cy: 0, zoom: 1 } }, actor: { inline: actor } },
    });

    // Only the list's GET fails: uploads go to the same path with PUT.
    const list = `**/api/rooms/${run.roomId}/assets`;
    await dm.route(list, (route) => (route.request().method() === "GET" ? route.abort("internetdisconnected") : route.continue()));
    consoles.dm.allow = [/Failed to load resource: net::ERR_INTERNET_DISCONNECTED/];
    try {
      // A fresh page: a list loaded by an earlier step would stay shown over a failed refresh, as it should.
      await dm.reload();
      await openSideTab(dm, "Library");
      const library = dm.getByRole("tabpanel", { name: "Library" });
      const failed = library.getByRole("alert").filter({ hasText: "The library did not load. Handouts and images already on the map are below." });
      await failed.waitFor();
      await shots.take(dm, "lp4-library-failed");

      // What the room's state names still shows and opens: the document, and the image on the map's token.
      await library.getByRole("list", { name: "Handouts in this room" }).getByRole("button", { name: `${doc.title}, handout, 1 page`, exact: true }).click();
      const letter = viewer(dm, doc.title);
      await letter.waitFor();
      await letter.getByRole("button", { name: `Close ${doc.title}` }).click();
      await letter.waitFor({ state: "detached" });
      const tile = library.getByRole("list", { name: "Token images in this room" }).locator(`li:has(img[src*="${imageId}"])`);
      await tile.getByRole("button").click();
      const image = viewer(dm, "Token image");
      await image.waitFor();
      await image.getByRole("button", { name: /^Close/ }).click();
      await image.waitFor({ state: "detached" });

      // Try again: held a while, so the loading line shows in the failure's place.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      await dm.unroute(list);
      await dm.route(list, async (route) => {
        if (route.request().method() === "GET") await held;
        await route.continue();
      });
      await failed.getByRole("button", { name: "Try again" }).focus();
      await dm.keyboard.press("Enter");
      await library.getByText("Loading the library…").waitFor();
      assert.equal(await failed.count(), 0, "the failure stays while it tries again");
      const focused = () =>
        dm.evaluate(() => {
          const el = (globalThis as unknown as { document: { activeElement: { tagName: string; closest(s: string): unknown } | null } }).document.activeElement;
          return { tag: el?.tagName ?? "", inPane: el?.closest("[data-pane]") != null };
        });
      assert.deepEqual(await focused(), { tag: "BUTTON", inPane: true }, "focus fell out of the panel as Try again left");
      await shots.take(dm, "lp4-library-retrying");
      release();
      await library.getByText("Loading the library…").waitFor({ state: "detached" });
      // The list's own rows now: the token image's tile says it is in use, which only the list knows.
      await waitFor("the listed tile's status", async () => /In use/.test((await tile.locator("span[aria-hidden]").textContent()) ?? ""));
      assert.equal(await library.getByRole("alert").filter({ hasText: "did not load" }).count(), 0, "the failure came back");
    } finally {
      await dm.unroute(list);
      consoles.dm.allow = [];
    }
  });

  test("lp4-library-empty-retry. with no images and no handouts, Try again by key leaves focus in the Library: in the picker's Library tab, and in the Library's sheet on a phone, never its header", async () => {
    // A room of its own: this run's room has images and handouts, which would take the focus first.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    let page = await context.newPage();
    try {
      await page.goto(`${server.origin}/`);
      await page.getByLabel("Room name").fill(`${run.roomName} empty`);
      await page.getByLabel("Your name").fill("Dana the DM");
      await page.getByRole("button", { name: "Create room" }).click();
      await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
      const link = (await page.locator("code").first().textContent()) ?? "";
      const roomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)?.[1]?.replace("-", "");
      assert.ok(roomId, `DM link looks wrong: ${link}`);

      // The list's GET fails, then is held while it tries again, so the loading line shows.
      let mode: "fail" | "hold" = "fail";
      let release: () => void = () => undefined;
      let held = new Promise<void>((resolve) => (release = resolve));
      await context.route(`**/api/rooms/${roomId}/assets`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        if (mode === "fail") return route.abort("internetdisconnected");
        await held;
        return route.continue();
      });
      const focused = () =>
        page.evaluate(() => {
          type El = { hasAttribute(n: string): boolean; closest(s: string): unknown };
          const el = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement;
          return {
            library: el?.hasAttribute("data-library") === true,
            inPicker: el?.closest('dialog [role="tabpanel"]') != null,
            inBody: el?.closest("[data-pane-body]") != null,
          };
        });
      const retry = async (where: Locator, what: string) => {
        const failed = where.getByRole("alert").filter({ hasText: "did not load" });
        await failed.waitFor();
        await failed.getByRole("button", { name: "Try again" }).focus();
        mode = "hold";
        await page.keyboard.press("Enter");
        await where.getByText("Loading the library…").waitFor();
        const at = await focused();
        await shots.take(page, `lp4-library-empty-retrying-${what}`);
        release();
        await where.getByText("Loading the library…").waitFor({ state: "detached" });
        return at;
      };

      await page.getByLabel("I saved my DM link").check();
      await page.getByRole("button", { name: "Continue to the room" }).click();
      await page.getByRole("status", { name: "Connected" }).first().waitFor();

      // The image picker's Library tab, where Try again is the only control.
      await openSideTab(page, "Characters");
      await page.getByRole("button", { name: "New character" }).click();
      await page.getByRole("button", { name: "Add image" }).first().click();
      const picker = page.getByRole("dialog", { name: "Choose an image" });
      await picker.getByRole("tab", { name: "Library" }).click();
      const inPicker = await retry(picker.getByRole("tabpanel"), "picker");
      assert.deepEqual(inPicker, { library: true, inPicker: true, inBody: false }, "focus left the picker's Library as Try again went");
      await picker.getByText("No token images yet.").waitFor();

      // The Library's sheet on a phone: focus stays in its body, not on the sheet's header.
      // A page of its own, since the open New character form would hold a reload with "Leave site?".
      mode = "fail";
      held = new Promise<void>((resolve) => (release = resolve));
      await page.close();
      page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${server.origin}/r/${roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
      await page.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Library/ }).click();
      const sheet = page.getByRole("region", { name: "Library" });
      const inSheet = await retry(sheet, "phone");
      assert.equal(inSheet.inBody, true, `focus went to the sheet's header as Try again went: ${JSON.stringify(inSheet)}`);
    } finally {
      await context.close();
    }
  });

});
