import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, sideTabName, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Join requests the DM approves (docs/design/design-v1-join-requests.md 10,
 * E2E): the real server, a DM on a 1440 x 900 computer and newcomers on
 * 390 x 844 phones, then a co-DM on a phone. A newcomer without the
 * password asks, waits and is let in as someone new, a player on a new
 * phone carries on as himself, one is turned away and held for 15
 * minutes, one cancels, one asks from a second tab, a player signed in to
 * another room asks there, Only by asking keeps a kicked player out of the
 * player link, the switch to With the password ends a waiting request,
 * two DM devices answer one request at once, and an unanswered request
 * expires on a second server started with a short request life. Then the
 * review's fixes (lane joinfix, labels jf-): a request found on load that
 * Back leaves, "Requests are off" once requests are on again, the carry-on
 * list after a password join, a let-in held up in the database, and a room
 * that is really full. lp30fix-2: a page left on "Requests are off" offers
 * Ask again once requests are on again, with no reload.
 *
 * Every ask comes from 127.0.0.1, so the file stays well under one
 * address's 30 asks an hour in a room and a room's 20 asks before it
 * quiets its toasts (design 4.3).
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty, and the expiry's
 * server on plus forty-one. The other environment variables are the smoke
 * run's (smoke.e2e.ts). The main server trusts CF-Connecting-IP, so the
 * full room's 45 players join from addresses of their own, and every other
 * call, which sends no such header, counts from 127.0.0.1 as before.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 40;
const SHORT_PORT = PORT + 1;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
/** The expiry server's request life (server/config.ts JOIN_REQUEST_LIFE_S, ignored in production). */
const SHORT_LIFE_S = 6;

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-joinrequests-"));
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** A new device's room page asks GET /me first and is answered 403: that is how it picks the join page, and Chrome logs it. */
const ME_403 = /status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/;
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");
/** Every page's console, read by the last step. */
const watches: ConsoleWatch[] = [dmConsole];
/** Rooms to delete at the end, by the context of a DM in them. */
const rooms: { origin: string; roomId: string; name: string; context: () => BrowserContext }[] = [];

type Device = { context: BrowserContext; page: Page; watch: ConsoleWatch; socket: SocketWatch };

const run = {
  roomId: "",
  roomName: "Sunless Citadel",
  dmLink: "",
  password: "",
  patId: "",
  quinnId: "",
  /** The second room, where a player signed in to the first asks. */
  otherId: "",
  otherName: "Thornwood Keep",
};
let pat: Device;
let quinn: Device;
/** Fern's phone, kept from jr-10's "Requests are off" for jr-11. */
let fern: Device;

function roomUrl(roomId = run.roomId, origin = server.origin): string {
  return `${origin}/r/${roomId.slice(0, 4)}-${roomId.slice(4)}`;
}

/** A call to the room's API from a context, with the Origin the CSRF rule asks for. */
async function call(context: BrowserContext, method: "GET" | "POST" | "DELETE", url: string, data?: unknown, origin = server.origin): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = data === undefined ? { Origin: origin } : { Origin: origin, "content-type": "application/json" };
  const res = await context.request.fetch(`${origin}${url}`, { method, headers, ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  return { status: res.status(), body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function device(label: string, options: Parameters<Browser["newContext"]>[0] = PHONE): Promise<Device> {
  const context = await browser.newContext(options);
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  const watch = new ConsoleWatch(label);
  watch.allow = [ME_403];
  watch.attach(page);
  watches.push(watch);
  const socket = new SocketWatch(label);
  await socket.attach(context, page);
  return { context, page, watch, socket };
}

/** The DM creates a room from the Home page in `page`, saves the DM link and goes in. */
async function createRoom(page: Page, origin: string, name: string): Promise<{ roomId: string; dmLink: string; password: string }> {
  await page.goto(`${origin}/`);
  await page.getByLabel("Room name").fill(name);
  await page.getByLabel("Your name").fill("Dana the DM");
  const password = await page.getByLabel("Player password").inputValue();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const dmLink = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(dmLink);
  assert.ok(match, `DM link looks wrong: ${dmLink}`);
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  return { roomId: match[1]!.replace("-", ""), dmLink, password };
}

/** The join page's ask, from the No password? card in With the password, or by asking, or the ask card itself in Only by asking. */
async function ask(page: Page, name: string, opts: { url?: string; viaNoPassword?: boolean } = {}): Promise<void> {
  if (opts.url !== undefined) await page.goto(opts.url);
  if (opts.viaNoPassword ?? true) {
    await page.getByRole("heading", { name: "No password?" }).waitFor();
    await page.getByRole("button", { name: "Ask to join" }).click();
  }
  await page.getByRole("heading", { name: "Ask to join" }).waitFor();
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Ask to join" }).click();
  await page.getByRole("heading", { name: "Waiting for the DM" }).waitFor();
  await page.getByText(`You asked to join as ${name}.`, { exact: true }).waitFor();
}

function requestRow(page: Page, name: string): Locator {
  return page.getByRole("group", { name: `Join request from ${name}` });
}

/** The DM panel's Join requests group (components/Panel.tsx Group), by its heading, never an outer box holding it. */
function requestsSection(page: Page): Locator {
  return page.getByRole("heading", { name: "Join requests", exact: true }).locator("xpath=ancestor::*[@data-panel-group][1]");
}

/** The DM panel's groups that fold, in order (docs/design/design-v1-panel-groups.md 6.2). */
const DM_GROUPS = ["Handouts", "Players' screens", "Preview", "Player link", "Table display"] as const;

function joiningSection(page: Page): Locator {
  return page.getByRole("heading", { name: "Joining", exact: true }).locator("xpath=ancestor::section[1]");
}

/** Toasts with a button can sit over the side panel's foot, so each answer starts with none on screen. */
async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const t = page.locator("button[data-toast], div[data-toast] > button").filter({ visible: true });
    if ((await t.count()) === 0) return;
    await t.first().click({ timeout: 1000 }).catch(() => {});
  }
}

/** What the DM tab's count says, on its tab where the side panel's row holds it, else in More's description. */
async function dmCount(page: Page): Promise<string> {
  const list = page.getByRole("tablist", { name: "Panels" });
  const tab = list.getByRole("tab", { name: /^DM( |$)/ });
  if ((await tab.count()) > 0 && (await tab.getAttribute("aria-haspopup")) === null) return (await tab.textContent()) ?? "";
  const described = await list.locator('[role="tab"][aria-haspopup="menu"]').getAttribute("aria-describedby");
  return described ? ((await page.locator(`[id="${described}"]`).textContent()) ?? "") : "";
}

/** Menu, Members, on the computer's side panel, with its Joining section loaded. */
async function openJoining(page: Page): Promise<Locator> {
  await openSideTab(page, "Menu");
  const menu = page.getByRole("tabpanel", { name: /^Menu/ });
  if (!(await menu.getByRole("heading", { name: "Joining", exact: true }).isVisible())) await menu.getByRole("button", { name: "Members" }).click();
  const section = joiningSection(page);
  await section.getByRole("group", { name: "How new players join" }).waitFor();
  return section;
}

/** Picks a Joining choice by its label, waits for "Saved.", and goes back to the DM panel, where requests show. */
async function pickMode(page: Page, label: "With the password" | "With the password, or by asking" | "Only by asking"): Promise<void> {
  const section = await openJoining(page);
  await section.getByText(label, { exact: true }).click();
  await section.getByText("Saved.", { exact: true }).waitFor();
  assert.equal(await section.getByRole("radio", { name: label, exact: true }).isChecked(), true, `${label} is the room's mode`);
  await openSideTab(page, "DM");
}

function membersNamed(name: string): number {
  return Object.values(dmSocket.state?.members ?? {}).filter((m) => m?.name === name).length;
}

describe("raccoon-vtt join requests", { timeout: 600_000 }, () => {
  before(async () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    try {
      server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    } finally {
      delete process.env.TRUST_CF_CONNECTING_IP;
    }
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext(DESKTOP);
    dmContext.setDefaultTimeout(10_000);
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of watches) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    for (const room of rooms) {
      try {
        const res = await room.context().request.delete(`${room.origin}/api/rooms/${room.roomId}`, { headers: { Origin: room.origin }, data: { name: room.name } });
        if (!res.ok()) console.error(`Deleting room ${room.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${room.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("jr-1. the DM creates a room, Pat joins with the password, and Joining switches to With the password, or by asking", async () => {
    const made = await createRoom(dm, server.origin, run.roomName);
    Object.assign(run, made);
    rooms.push({ origin: server.origin, roomId: run.roomId, name: run.roomName, context: () => dmContext });
    await waitFor("the DM's snapshot", () => dmSocket.state);

    pat = await device("pat");
    const joined = await call(pat.context, "POST", `/api/rooms/${run.roomId}/join`, { password: run.password });
    assert.equal(joined.status, 200);
    const done = await call(pat.context, "POST", `/api/rooms/${run.roomId}/join/complete`, { ticket: joined.body.ticket, name: "Pat", color: "#30a46c" });
    assert.equal(done.status, 200);
    run.patId = (done.body.member as { id: string }).id;
    await pat.page.goto(roomUrl());
    await pat.page.getByRole("status", { name: "Connected" }).first().waitFor();

    const section = await openJoining(dm);
    assert.equal(await section.getByRole("radio", { name: "With the password", exact: true }).isChecked(), true, "every room starts With the password");
    await pickMode(dm, "With the password, or by asking");
    assert.equal((await call(pat.context, "GET", `/api/rooms/${run.roomId}`)).body.joinMode, "ask");
  });

  test("jr-2. a newcomer asks, waits, and the DM's toast, badge and section let them in as someone new", async () => {
    quinn = await device("quinn");
    await quinn.page.goto(roomUrl());
    // The password card stays first, with the ask under it.
    await quinn.page.getByRole("heading", { name: "Join the game" }).waitFor();
    await quinn.page.getByRole("heading", { name: "No password?" }).waitFor();
    await quinn.page.getByRole("button", { name: "Ask to join" }).click();
    await quinn.page.getByLabel("Your name").fill("Quinn");
    await quinn.page.getByRole("radiogroup", { name: "Your color" }).getByRole("radio").nth(3).click();
    await shots.take(quinn.page, "guide-ask-card");
    await quinn.page.getByRole("button", { name: "Ask to join" }).click();
    await quinn.page.getByRole("heading", { name: "Waiting for the DM" }).waitFor();
    // pe1: the spinner's line says the sentence, once, where it used to repeat the title (docs/design/design-v1-polish-pass.md 3.9).
    await quinn.page.getByRole("status").filter({ hasText: /^You asked to join as Quinn\.$/ }).waitFor();
    assert.equal(await quinn.page.getByText("You asked to join as Quinn.", { exact: true }).count(), 1, "the sentence is said once");
    assert.equal(await quinn.page.getByText(/^Waiting for the DM…$/).count(), 0, "no line repeats the card's title");
    await quinn.page.getByText("Keep this page open. A request ends after 10 minutes.", { exact: true }).waitFor();
    await shots.take(quinn.page, "waiting-card");

    // Every DM device hears: a toast with Review, and the DM tab's count.
    const toast = dm.locator("[data-toast]").filter({ hasText: "Quinn asks to join." });
    await toast.waitFor();
    await waitFor("the DM tab's count", async () => /1 join request/.test(await dmCount(dm)));
    await toast.getByRole("button", { name: "Review" }).click();
    const row = requestRow(dm, "Quinn");
    await row.waitFor();
    await row.getByText("Asked just now", { exact: true }).waitFor();
    // Someone new is the default, beside each player a DM could carry the device on as.
    const as = row.getByRole("combobox", { name: "Let Quinn in as" });
    assert.equal(await as.inputValue(), "");
    assert.deepEqual(await as.locator("option").allTextContents(), ["Someone new", "Pat"]);
    await dismissToasts(dm);
    await dm.setViewportSize({ width: 1280, height: 800 });
    await requestsSection(dm).waitFor();
    await shots.take(dm, "guide-join-requests");
    await dm.setViewportSize(DESKTOP.viewport);

    // The DM's list holds only what the design lets a DM see of a request.
    const listed = await call(dmContext, "GET", `/api/rooms/${run.roomId}/join-requests`);
    const requests = listed.body.requests as { id: string; name: string; color: string; askedAt: string }[];
    assert.deepEqual(requests.map((r) => Object.keys(r).sort()), [["askedAt", "color", "id", "name"]]);
    const picked = requests[0]!.color;

    const before = Object.keys(dmSocket.state?.members ?? {}).length;
    await row.getByRole("button", { name: "Let Quinn in" }).click();
    await quinn.page.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Quinn's snapshot", () => quinn.socket.you);
    assert.equal(quinn.socket.you?.role, "player");
    run.quinnId = quinn.socket.you!.memberId;
    await waitFor("Quinn on the DM's roster", () => (membersNamed("Quinn") === 1 ? true : null));
    assert.equal(Object.keys(dmSocket.state?.members ?? {}).length, before + 1);
    assert.equal(dmSocket.state?.members[run.quinnId]?.color, picked, "the member has the color Quinn picked");
    // The section goes once nothing waits, and so does the count.
    await requestsSection(dm).waitFor({ state: "detached" });
    await waitFor("the DM tab's count to clear", async () => (/join request/.test(await dmCount(dm)) ? null : true));
    assert.ok(dmSocket.everSaw("Quinn"), "the DM's socket carried the join");
  });

  test("jr-3. a closed tab reopened after the let-in opens the room", async () => {
    await quinn.page.close();
    quinn.page = await quinn.context.newPage();
    quinn.watch.attach(quinn.page);
    quinn.socket = new SocketWatch("quinn again");
    await quinn.socket.attach(quinn.context, quinn.page);
    await quinn.page.goto(roomUrl());
    await quinn.page.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Quinn's snapshot", () => quinn.socket.you);
    assert.equal(quinn.socket.you?.memberId, run.quinnId);
  });

  test("jr-4. a player on a new phone asks, and the DM carries them on as Pat after reading what that hands over", async () => {
    const phone = await device("pat's new phone");
    await ask(phone.page, "pat", { url: roomUrl() });
    const row = requestRow(dm, "pat");
    await row.waitFor();
    const as = row.getByRole("combobox", { name: "Let pat in as" });
    assert.deepEqual(await as.locator("option").allTextContents(), ["Someone new", "Pat", "Quinn"]);
    // A matching name alone changes nothing: Someone new stays picked and no note shows.
    assert.equal(await as.inputValue(), "");
    assert.equal(await row.getByText(/Their device becomes/).count(), 0);
    await as.selectOption({ label: "Pat" });
    const note = "Their device becomes Pat, with Pat's characters, tokens and whispers. Pick Pat only if you know it is them. Pat is online now. The name they typed matches Pat.";
    await row.getByText(note, { exact: true }).waitFor();
    assert.equal(await as.getAttribute("aria-describedby"), await row.getByText(note, { exact: true }).getAttribute("id"));
    await shots.take(dm, "carry-on-note");

    const before = Object.keys(dmSocket.state?.members ?? {}).length;
    await dismissToasts(dm);
    await row.getByRole("button", { name: "Let pat in" }).click();
    await phone.page.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("the phone's snapshot", () => phone.socket.you);
    assert.equal(phone.socket.you?.memberId, run.patId, "the new phone is Pat");
    assert.equal(Object.keys(dmSocket.state?.members ?? {}).length, before, "no member was added");
    await row.waitFor({ state: "detached" });
    await phone.context.close();
  });

  test("jr-5. a request turned away says so, and the device is held from asking that room again for 15 minutes", async () => {
    const rook = await device("rook");
    await ask(rook.page, "Rook", { url: roomUrl() });
    const row = requestRow(dm, "Rook");
    await row.waitFor();
    await dismissToasts(dm);
    await row.getByRole("button", { name: "Turn Rook away" }).click();
    await rook.page.getByRole("heading", { name: "The DM said no" }).waitFor();
    await rook.page.getByText("You can ask again in 15 minutes.", { exact: true }).waitFor();
    await row.waitFor({ state: "detached" });
    await shots.take(rook.page, "turned-away");

    // jf-a (JBO1-11): a reload finds the kept ending, and Back spends it, so Ask to join opens a fresh ask card.
    await rook.page.reload();
    await rook.page.getByRole("heading", { name: "The DM said no" }).waitFor();
    await rook.page.getByRole("button", { name: "Back" }).click();
    await rook.page.getByRole("heading", { name: "Join the game" }).waitFor();
    await rook.page.getByRole("button", { name: "Ask to join" }).click();
    await rook.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    assert.equal(await rook.page.getByRole("heading", { name: "The DM said no" }).count(), 0, "a fresh ask card, not the spent request's");
    await rook.page.getByRole("button", { name: "Back" }).click();

    // Back leads to the password card, and asking again is refused with the hold's own time.
    await rook.page.getByRole("heading", { name: "Join the game" }).waitFor();
    // The refusal is a 429 on the ask, which Chrome logs.
    rook.watch.allow = [ME_403, /status of 429 .*\/api\/rooms\/[0-9A-Z]{8}\/join-requests\)$/];
    await rook.page.getByRole("button", { name: "Ask to join" }).click();
    await rook.page.getByLabel("Your name").fill("Rook");
    await rook.page.getByRole("button", { name: "Ask to join" }).click();
    await rook.page.getByText(/^The DM said no a few minutes ago\. Ask again in 1[45] minutes\.$/).waitFor();
    assert.equal(await rook.page.getByRole("heading", { name: "Waiting for the DM" }).count(), 0);
    const again = await call(rook.context, "POST", `/api/rooms/${run.roomId}/join-requests`, { name: "Rook", color: "#3e8ef7" });
    assert.equal(again.status, 429);
    assert.equal(again.body.error, "asked_recently");
    assert.equal(await requestRow(dm, "Rook").count(), 0, "nothing new reached the DM");
    await rook.context.close();
  });

  test("jr-6. Cancel ends a request, and its row leaves the DM's section", async () => {
    const wren = await device("wren");
    await ask(wren.page, "Wren", { url: roomUrl() });
    const row = requestRow(dm, "Wren");
    await row.waitFor();
    // Cancel cuts off its own held wait first, so no 404 for it reaches the console.
    await wren.page.getByRole("button", { name: "Cancel" }).click();
    await wren.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    await row.waitFor({ state: "detached" });
    assert.equal((await call(wren.context, "GET", `/api/rooms/${run.roomId}/join-requests/mine`)).status, 204, "a device with no request is answered with nothing");
    await wren.context.close();
  });

  test("ambc-1. a request over every DM panel group folded by hand: Join requests first and open, no line over it, its name at the folded names' edge, and the folds kept through a reload", async () => {
    const una = await device("una");
    await ask(una.page, "Una", { url: roomUrl() });
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    const row = requestRow(dm, "Una");
    await row.waitFor();
    await dismissToasts(dm);
    // A computer starts every group open, so the DM folds each, as a DM who wants a short panel would.
    for (const name of DM_GROUPS) {
      const fold = panel.getByRole("button", { name, exact: true });
      if ((await fold.getAttribute("aria-expanded")) === "true") await fold.click();
    }
    const check = async (at: string) => {
      const groups = await panel.locator("[data-panel-group]").evaluateAll((boxes) =>
        boxes.map((box) => {
          type El = { querySelector(s: string): El | null; getAttribute(n: string): string | null; textContent: string | null; getBoundingClientRect(): { left: number } };
          const el = box as unknown as El;
          const name = el.querySelector("[data-group-name]");
          const style = (globalThis as unknown as { getComputedStyle(e: unknown): { borderTopWidth: string } }).getComputedStyle(box);
          return { name: name?.textContent ?? "", left: name?.getBoundingClientRect().left ?? NaN, line: style.borderTopWidth !== "0px", expanded: el.querySelector("[data-group-fold]")?.getAttribute("aria-expanded") ?? null };
        }),
      );
      assert.deepEqual(
        groups.map((g) => [g.name, g.expanded, g.line]),
        [["Join requests", null, false], ...DM_GROUPS.map((name) => [name, "false", true])],
        `${at}: Join requests first, never folding and with no line over it, then the five folded`,
      );
      for (const g of groups.slice(1)) assert.ok(Math.abs(g.left - groups[0]!.left) <= 1, `${at}: ${g.name}'s name at ${g.left}, Join requests' at ${groups[0]!.left}`);
      await row.getByRole("button", { name: "Let Una in" }).waitFor();
      assert.deepEqual(alignmentLines(await measureAlignment(panel), `the DM panel ${at}`), []);
    };
    await check("folded by hand");
    assert.deepEqual(await dm.evaluate(() => JSON.parse(localStorage.getItem("rvtt.dmPanelFolds") ?? "null")), { handouts: false, screens: false, check: false, link: false, display: false });
    await shots.take(dm, "ambc-1-request-over-folded-groups");
    // This device keeps each fold.
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await openSideTab(dm, "DM");
    await row.waitFor();
    await dismissToasts(dm);
    await check("after a reload");
    // Open again for the steps after, which use the panel as a computer starts it.
    for (const name of DM_GROUPS) await panel.getByRole("button", { name, exact: true }).click();
    await row.getByRole("button", { name: "Turn Una away" }).click();
    await requestsSection(dm).waitFor({ state: "detached" });
    await una.context.close();
  });

  test("jr-7. a second tab takes over a request, and Wait here takes it back", async () => {
    const ivy = await device("ivy");
    await ask(ivy.page, "Ivy", { url: roomUrl() });
    await requestRow(dm, "Ivy").waitFor();
    const second = await ivy.context.newPage();
    ivy.watch.attach(second);
    await second.goto(roomUrl());
    // The second tab finds the request before any card and waits on it.
    await second.getByRole("heading", { name: "Waiting for the DM" }).waitFor();
    await ivy.page.getByRole("heading", { name: "Waiting in another tab" }).waitFor();
    await ivy.page.getByText("This request is waiting in another tab or window.", { exact: true }).waitFor();
    await ivy.page.getByRole("button", { name: "Wait here" }).click();
    await ivy.page.getByRole("heading", { name: "Waiting for the DM" }).waitFor();
    await second.getByRole("heading", { name: "Waiting in another tab" }).waitFor();
    await ivy.page.getByRole("button", { name: "Cancel" }).click();
    await requestRow(dm, "Ivy").waitFor({ state: "detached" });
    await ivy.context.close();
  });

  test("jr-8. a player signed in to another room asks there and is let in on the session they already hold", async () => {
    const other = await dmContext.newPage();
    const otherConsole = new ConsoleWatch("dm, second room");
    otherConsole.attach(other);
    watches.push(otherConsole);
    const made = await createRoom(other, server.origin, run.otherName);
    run.otherId = made.roomId;
    rooms.push({ origin: server.origin, roomId: run.otherId, name: run.otherName, context: () => dmContext });
    assert.equal((await call(dmContext, "POST", `/api/rooms/${run.otherId}/join-mode`, { mode: "ask" })).status, 200);

    const cookieBefore = (await pat.context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).sort();
    const patHere = new SocketWatch("pat, second room");
    const page = await pat.context.newPage();
    pat.watch.attach(page);
    await patHere.attach(pat.context, page);
    await ask(page, "Pat", { url: roomUrl(run.otherId) });
    await openSideTab(other, "DM");
    const row = requestRow(other, "Pat");
    await row.waitFor();
    await row.getByRole("button", { name: "Let Pat in" }).click();
    // The waiting page opens the room itself, with no reload.
    await page.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot in the second room", () => patHere.you);
    assert.equal(patHere.you?.role, "player");
    const cookieAfter = (await pat.context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).sort();
    assert.deepEqual(cookieAfter, cookieBefore, "no ask token replaced the session Pat already held");
    await page.close();
    await other.close();
  });

  test("jr-9. in Only by asking a kicked player's link opens the ask card, the password lets nobody in, and the DM may let them back in", async () => {
    await pickMode(dm, "Only by asking");
    await openSideTab(dm, "DM");
    await dm.getByText("Only by asking is on. This link opens the join page, where new players ask to join.", { exact: true }).waitFor();

    assert.equal((await call(dmContext, "DELETE", `/api/rooms/${run.roomId}/members/${run.quinnId}/grants`)).status, 204);
    const link = (await call(dmContext, "GET", `/api/rooms/${run.roomId}/player-link`)).body.playerLink as string;
    assert.match(link, /#pw=/);
    // The kicked tab closes, and the link opens in a new one, as a link from a message does.
    await quinn.page.close();
    quinn.page = await quinn.context.newPage();
    quinn.watch.attach(quinn.page);
    await quinn.page.goto(`${server.origin}${link}`);
    // The server keeps Quinn's let-in from jr-2 for 2 minutes, so the page may first find it, see no grant, and say it ended.
    const ended = quinn.page.getByRole("heading", { name: "Request ended" });
    await ended.or(quinn.page.getByRole("heading", { name: "Ask to join" })).waitFor();
    if (await ended.isVisible()) await quinn.page.getByRole("button", { name: "Ask again" }).click();
    await quinn.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    await quinn.page.getByText("This room lets new players in when a DM says yes, so ask here.", { exact: true }).waitFor();
    assert.equal(await quinn.page.getByRole("heading", { name: "Join the game" }).count(), 0, "no password card in Only by asking");
    assert.equal(new URL(quinn.page.url()).hash, "", "the link's password left the address bar");
    const refused = await call(quinn.context, "POST", `/api/rooms/${run.roomId}/join`, { password: run.password });
    assert.deepEqual([refused.status, refused.body.error], [403, "asks_only"]);

    await quinn.page.getByLabel("Your name").fill("Quinn");
    await quinn.page.getByRole("button", { name: "Ask to join" }).click();
    await quinn.page.getByRole("heading", { name: "Waiting for the DM" }).waitFor();
    const row = requestRow(dm, "Quinn");
    await row.waitFor();
    await row.getByRole("combobox", { name: "Let Quinn in as" }).selectOption({ label: "Quinn" });
    await dismissToasts(dm);
    await row.getByRole("button", { name: "Let Quinn in" }).click();
    quinn.socket = new SocketWatch("quinn, let back in");
    await quinn.socket.attach(quinn.context, quinn.page);
    await quinn.page.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Quinn's snapshot", () => quinn.socket.you);
    assert.equal(quinn.socket.you?.memberId, run.quinnId, "Quinn carries on as Quinn");
    quinn.watch.allow = [ME_403];
  });

  test("jr-10. the switch to With the password ends a waiting request, and the page shows the password card", async () => {
    fern = await device("fern");
    await fern.page.goto(roomUrl());
    // Only by asking shows the ask card alone.
    await ask(fern.page, "Fern", { viaNoPassword: false });
    await requestRow(dm, "Fern").waitFor();
    await pickMode(dm, "With the password");
    await fern.page.getByRole("heading", { name: "Requests are off" }).waitFor();
    await fern.page.getByText("The DM stopped taking requests.", { exact: true }).waitFor();
    await fern.page.getByRole("heading", { name: "Join the game" }).waitFor();
    assert.equal(await fern.page.getByRole("heading", { name: "No password?" }).count(), 0);
    await requestsSection(dm).waitFor({ state: "detached" });
    await openSideTab(dm, "DM");
    assert.equal(await dm.getByText(/^Only by asking is on\./).count(), 0, "the player link's note left with the mode");
    const off = await call(fern.context, "POST", `/api/rooms/${run.roomId}/join-requests`, { name: "Fern", color: "#3e8ef7" });
    assert.deepEqual([off.status, off.body.error], [403, "asks_off"]);
    // The password works again.
    assert.equal((await call(fern.context, "POST", `/api/rooms/${run.roomId}/join`, { password: run.password })).status, 200);
  });

  test("jr-11. a co-DM's phone that opens the room hears of the waiting request once, and when two DM devices let it in at once exactly one does", async () => {
    await pickMode(dm, "With the password, or by asking");

    // jf-b (JBO1-03): requests are on again, and Fern's page finds its kept "Requests are off", which now offers Ask again.
    await fern.page.reload();
    const closedCard = fern.page.getByRole("heading", { name: "Requests are off" }).locator("xpath=ancestor::section[1]");
    await closedCard.waitFor();
    await shots.take(fern.page, "jf-closed-ask-again");
    await closedCard.getByRole("button", { name: "Ask again" }).click();
    await fern.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    await fern.context.close();

    const sage = await device("sage");
    await ask(sage.page, "Sage", { url: roomUrl() });
    await requestRow(dm, "Sage").waitFor();

    // jf-c (JB-ASTRA-05): a password join while Sage waits reaches "Let Sage in as" with no join request signal.
    const juniper = await device("juniper");
    const joined = await call(juniper.context, "POST", `/api/rooms/${run.roomId}/join`, { password: run.password });
    assert.equal((await call(juniper.context, "POST", `/api/rooms/${run.roomId}/join/complete`, { ticket: joined.body.ticket, name: "Juniper", color: "#3e8ef7" })).status, 200);
    const sageAs = requestRow(dm, "Sage").getByRole("combobox", { name: "Let Sage in as" });
    await waitFor("Juniper in Let Sage in as", async () => ((await sageAs.locator("option").allTextContents()).includes("Juniper") ? true : null));
    await juniper.context.close();

    const coDm = await device("co-DM phone");
    // The DM link asks GET /me first, and a claim without a choice is answered 409 with the DM members to pick from.
    coDm.watch.allow = [ME_403, /status of 409 .*\/api\/rooms\/[0-9A-Z]{8}\/dm\)$/];
    await coDm.page.goto(run.dmLink);
    await coDm.page.getByRole("button", { name: /Dana the DM/ }).click();
    await coDm.page.getByRole("status", { name: "Connected" }).first().waitFor();
    const opening = coDm.page.locator("[data-toast]").filter({ hasText: "Sage is waiting to join." });
    await opening.waitFor();
    const panels = coDm.page.locator('nav[aria-label="Tools"] button[title="Panels"]');
    await waitFor("the Panels button's count", async () => ((await panels.getAttribute("aria-label")) ?? (await panels.textContent()) ?? "").includes("1 join request"));
    await opening.getByRole("button", { name: "Review" }).click();
    const phoneRow = requestRow(coDm.page, "Sage");
    await phoneRow.waitFor();
    await shots.take(coDm.page, "co-dm-section");
    assert.equal(await coDm.page.locator("[data-toast]").filter({ hasText: "Sage is waiting to join." }).count() <= 1, true, "one toast for one request");

    // The loser's answer is refused, a 409 or a 404 Chrome logs.
    const lost = /status of (409|404) .*\/join-requests\/[A-Za-z0-9_-]+\/let-in\)$/;
    dmConsole.allow = [lost];
    coDm.watch.allow = [ME_403, lost];
    await dismissToasts(dm);
    await dismissToasts(coDm.page);
    // Both taps in the same moment: a locator's click waits for the button to be still, and the first answer moves the other row.
    const buttons = [requestRow(dm, "Sage").getByRole("button", { name: "Let Sage in" }), phoneRow.getByRole("button", { name: "Let Sage in" })];
    for (const b of buttons) await b.waitFor();
    const answers: number[] = [];
    for (const p of [dm, coDm.page]) p.on("response", (res) => void (/\/let-in$/.test(new URL(res.url()).pathname) && answers.push(res.status())));
    await Promise.all(buttons.map((b) => b.evaluate((el) => (el as unknown as { click(): void }).click())));
    await sage.page.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Sage on the roster", () => (membersNamed("Sage") === 1 ? true : null));
    await requestRow(dm, "Sage").waitFor({ state: "detached" });
    await phoneRow.waitFor({ state: "detached" });
    await waitFor("both let-ins answered", () => (answers.length === 2 ? true : null));
    // One wins. The other is refused as already answered, or as gone once the winner's request ended.
    assert.equal(answers.filter((s) => s === 200).length, 1, `let-in answers ${answers.join(", ")}`);
    assert.ok(answers.some((s) => s === 409 || s === 404), `let-in answers ${answers.join(", ")}`);
    // Give a late duplicate the time to land, then count again.
    await dm.waitForTimeout(500);
    assert.equal(membersNamed("Sage"), 1, "exactly one let-in wrote a member");
    dmConsole.allow = [];
    await sage.context.close();
    await coDm.context.close();
  });

  test("jr-12. a request nobody answers expires, on a server with a short request life", async () => {
    process.env.JOIN_REQUEST_LIFE_S = String(SHORT_LIFE_S);
    let short: Server;
    try {
      short = await startServer({ port: SHORT_PORT, assetDir: path.join(work, "assets-short"), databaseUrl: DATABASE_URL });
    } finally {
      delete process.env.JOIN_REQUEST_LIFE_S;
    }
    const host = await device("short-life DM", DESKTOP);
    try {
      const made = await createRoom(host.page, short.origin, "Expiry room");
      rooms.push({ origin: short.origin, roomId: made.roomId, name: "Expiry room", context: () => host.context });
      assert.equal((await call(host.context, "POST", `/api/rooms/${made.roomId}/join-mode`, { mode: "ask" }, short.origin)).status, 200);
      const lark = await device("lark");
      await ask(lark.page, "Lark", { url: roomUrl(made.roomId, short.origin) });
      await openSideTab(host.page, "DM");
      await requestRow(host.page, "Lark").waitFor();
      // The life is 6 s. The sweep runs every 15 s and a held wait answers within 25 s.
      await lark.page.getByRole("heading", { name: "No answer yet" }).waitFor({ timeout: 45_000 });
      await lark.page.getByText("The DM may be away. Ask again later, or ask the DM for the player link.", { exact: true }).waitFor();
      await lark.page.getByRole("button", { name: "Ask again" }).waitFor();
      await requestRow(host.page, "Lark").waitFor({ state: "detached", timeout: 20_000 });
      await lark.context.close();
      // Deleted while its server runs.
      const room = rooms.pop()!;
      const res = await host.context.request.delete(`${room.origin}/api/rooms/${room.roomId}`, { headers: { Origin: room.origin }, data: { name: room.name } });
      assert.ok(res.ok(), `deleting the expiry room answered ${res.status()}`);
    } finally {
      await host.context.close();
      await short.stop();
    }
  });

  test("jf-1. a let-in held up in the database keeps its row on the DM's section, busy, then says Still letting them in (JBO1-01)", async () => {
    const hazel = await device("hazel");
    await ask(hazel.page, "Hazel", { url: roomUrl() });
    const row = requestRow(dm, "Hazel");
    await row.waitFor();
    await dismissToasts(dm);
    // The member's op cannot commit while this holds the room's row, as a stalled database would.
    const holder = new pg.Client({ connectionString: DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from rooms where id = $1 for update", [run.roomId]);
      await row.getByRole("button", { name: "Let Hazel in" }).click();
      // The take signals the DMs at once, and the row stays through that fetch. Each shot comes before its checks, so the run before this fix shows what was wrong.
      await dm.waitForTimeout(1_000);
      await shots.take(dm, "jf-letting-in");
      assert.equal(await row.count(), 1, "the row stays while the let-in runs");
      await row.getByText("Letting in…", { exact: true }).waitFor();
      // pe1: Hazel's Cancel while the let-in commits is answered "deciding", a 409 Chrome logs, and the spinner's line says the DM is letting her in, in place of her sentence (docs/design/design-v1-polish-pass.md 3.9).
      hazel.watch.allow = [ME_403, /status of 409 .*\/join-requests\/[A-Za-z0-9_-]+\)$/];
      await hazel.page.getByRole("button", { name: "Cancel" }).click();
      await hazel.page.getByRole("status").filter({ hasText: /^The DM is letting you in…$/ }).waitFor();
      assert.equal(await hazel.page.getByText("You asked to join as Hazel.", { exact: true }).count(), 0, "the sentence gives way while the DM decides");
      assert.equal(await hazel.page.getByRole("button", { name: "Cancel" }).isDisabled(), true, "Cancel is off while the DM decides");
      await shots.take(hazel.page, "jf-letting-you-in");
      // Past the 5 s answer bound the let-in answers 202, and the row says so.
      await dm.waitForTimeout(5_500);
      await shots.take(dm, "jf-still-letting");
      await row.getByText("Still letting Hazel in…", { exact: true }).waitFor();
      assert.equal(await row.getByRole("button", { name: "Turn Hazel away" }).isDisabled(), true, "the row refuses a second answer");
    } finally {
      await holder.query("rollback").catch(() => {});
      await holder.end();
    }
    await hazel.page.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 20_000 });
    await row.waitFor({ state: "detached" });
    await hazel.context.close();
  });

  test("jf-2. a let-in into a room that is really full keeps the row, says why, and never toasts the request again (JBO1-01)", async () => {
    // Fill the room to its 50 members with password joins, each from an address of its own.
    const members = () => Object.keys(dmSocket.state?.members ?? {}).length;
    for (let n = 1; members() < 50 && n <= 60; n++) {
      const ip = `198.51.100.${n}`;
      const headers = { Origin: server.origin, "content-type": "application/json", "cf-connecting-ip": ip };
      const first = await fetch(`${server.origin}/api/rooms/${run.roomId}/join`, { method: "POST", headers, body: JSON.stringify({ password: run.password }) });
      assert.equal(first.status, 200, `join ${n}: ${first.status}`);
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const { ticket } = (await first.json()) as { ticket: string };
      const done = await fetch(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ ticket, name: `Filler ${n}`, color: "#30a46c" }) });
      assert.equal(done.status, 200, `join/complete ${n}: ${done.status}`);
      await waitFor(`member ${n} on the DM's roster`, () => (membersNamed(`Filler ${n}`) === 1 ? true : null));
    }
    assert.equal(members(), 50);
    const iris = await device("iris");
    await ask(iris.page, "Iris", { url: roomUrl() });
    const row = requestRow(dm, "Iris");
    await row.waitFor();
    await dismissToasts(dm);
    // The refusal is a 409 on the let-in, which Chrome logs.
    dmConsole.allow = [/status of 409 .*\/join-requests\/[A-Za-z0-9_-]+\/let-in\)$/];
    await row.getByRole("button", { name: "Let Iris in" }).click();
    const words = row.getByText("The room is full: it holds 50 members. Remove a member first.", { exact: true });
    // The request is waiting again, and every fetch since has kept the row and its words.
    await dm.waitForTimeout(1_500);
    await shots.take(dm, "jf-room-full");
    assert.equal(await words.isVisible(), true, "the words outlive the list's fetches");
    assert.equal(await row.getByRole("button", { name: "Let Iris in" }).isDisabled(), false, "and the row can answer again");
    assert.equal(await dm.locator("[data-toast]").filter({ hasText: "Iris" }).count(), 0, "a request back from a failed let-in is not news");
    dmConsole.allow = [];
    await iris.page.getByRole("button", { name: "Cancel" }).click();
    await row.waitFor({ state: "detached" });
    await iris.context.close();
  });

  test("jf-3. a 202 that comes after the list that settled its let-in leaves the row answerable, and the list says why (JB-ASTRA-08, JBO2-02)", async () => {
    // The room is still full from jf-2, so the server refuses this let-in at once. The DM's page hears it only as a 202 held back
    // until the list that settled it has come, as when a let-in fails after its 202 and that list wins the race.
    const juno = await device("juno");
    await ask(juno.page, "Juno", { url: roomUrl() });
    const row = requestRow(dm, "Juno");
    await row.waitFor();
    await dismissToasts(dm);
    const LET_IN = "**/join-requests/*/let-in";
    const settledList = dm.waitForResponse(async (res) => {
      if (res.request().method() !== "GET" || !new URL(res.url()).pathname.endsWith("/join-requests")) return false;
      const list = (await res.json().catch(() => null)) as { requests?: Array<{ name: string; deciding?: true; refused?: string }> } | null;
      return list?.requests?.some((r) => r.name === "Juno" && !r.deciding && r.refused === "room_full") === true;
    });
    let refusedWith = 0;
    await dm.route(LET_IN, async (route) => {
      const answer = await route.fetch();
      refusedWith = answer.status();
      await settledList;
      // Time for the page to read that list and draw it, so the 202 lands after it.
      await dm.waitForTimeout(500);
      await route.fulfill({ status: 202, json: { memberId: "late", pending: true } });
    });
    try {
      await row.getByRole("button", { name: "Let Juno in" }).click();
      await settledList;
      await dm.waitForTimeout(1_500);
      await shots.take(dm, "jf-late-202");
      assert.equal(refusedWith, 409, "the server refused it, the room being full");
      assert.equal(await row.getByText("Still letting Juno in…", { exact: true }).count(), 0, "not stuck on Still letting");
      assert.equal(await row.getByRole("button", { name: "Let Juno in" }).isDisabled(), false, "and the row can answer again");
      await row.getByText("The room is full: it holds 50 members. Remove a member first.", { exact: true }).waitFor({ timeout: 2_000 });
    } finally {
      await dm.unroute(LET_IN);
    }
    await juno.page.getByRole("button", { name: "Cancel" }).click();
    await row.waitFor({ state: "detached" });
    await juno.context.close();
  });

  test("lp30fix-2. a newcomer left on Requests are off is offered Ask again once requests are on again, with no reload: at the page's next read of the room, and when it gets focus", async () => {
    const olive = await device("olive");
    // The page's own clock, so its 15 s read of the room comes when the test says.
    await olive.page.clock.install();
    await ask(olive.page, "Olive", { url: roomUrl() });
    await requestRow(dm, "Olive").waitFor();
    await dismissToasts(dm);
    const closedCard = olive.page.getByRole("heading", { name: "Requests are off" }).locator("xpath=ancestor::section[1]");
    const askAgain = closedCard.getByRole("button", { name: "Ask again" });
    await pickMode(dm, "With the password");
    await closedCard.waitFor();
    await olive.page.getByRole("heading", { name: "Join the game" }).waitFor();
    await olive.page.getByLabel("Player password").fill("not yet sent");
    await pickMode(dm, "With the password, or by asking");
    await olive.page.waitForTimeout(1_000);
    assert.equal(await askAgain.count(), 0, "no Ask again before the page reads the room again");
    await shots.take(olive.page, "lp30fix-2-before-the-read");
    await olive.page.clock.fastForward(16_000);
    await askAgain.waitFor({ timeout: 5_000 });
    await shots.take(olive.page, "lp30fix-2-ask-again");
    assert.equal(await olive.page.getByLabel("Player password").inputValue(), "not yet sent", "the password card stays under it, as it was");
    assert.equal(await olive.page.getByRole("heading", { name: "No password?" }).count(), 0, "Ask again is the one way to ask");

    // Again in Only by asking, brought by the page getting focus.
    await askAgain.click();
    await olive.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    await olive.page.getByRole("button", { name: "Ask to join" }).click();
    await olive.page.getByRole("heading", { name: "Waiting for the DM" }).waitFor();
    await requestRow(dm, "Olive").waitFor();
    await dismissToasts(dm);
    await pickMode(dm, "With the password");
    await closedCard.waitFor();
    await pickMode(dm, "Only by asking");
    await olive.page.waitForTimeout(500);
    assert.equal(await askAgain.count(), 0);
    await olive.page.evaluate(() => (globalThis as unknown as EventTarget).dispatchEvent(new Event("focus")));
    await askAgain.waitFor({ timeout: 5_000 });
    assert.equal(await olive.page.getByRole("heading", { name: "Join the game" }).count(), 0, "no password card in Only by asking");
    await askAgain.click();
    await olive.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    await pickMode(dm, "With the password, or by asking");
    await olive.context.close();
  });

  test("jr-13. no page logged an error", () => {
    for (const w of watches) assert.deepEqual(w.errors, [], `${w.label}'s page logged errors`);
  });
});
