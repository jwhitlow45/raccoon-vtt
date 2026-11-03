import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

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
 * expires on a second server started with a short request life.
 *
 * Every ask comes from 127.0.0.1, so the file stays well under one
 * address's 30 asks an hour in a room and a room's 20 asks before it
 * quiets its toasts (design 4.3).
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty, and the expiry's
 * server on plus forty-one. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
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
/** A held wait on a request its own page cancelled is answered 404 request_gone, and Chrome logs it. */
const CANCELLED_WAIT = /status of 404 .*\/api\/rooms\/[0-9A-Z]{8}\/join-requests\/[A-Za-z0-9_-]{43}\/wait\)$/;
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

/** The DM panel's Join requests section, by its heading, never an outer section holding it. */
function requestsSection(page: Page): Locator {
  return page.getByRole("heading", { name: "Join requests", exact: true }).locator("xpath=ancestor::section[1]");
}

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
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
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
    await quinn.page.getByText("You asked to join as Quinn.", { exact: true }).waitFor();
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
    assert.equal(await row.getByText(/This device will be/).count(), 0);
    await as.selectOption({ label: "Pat" });
    const note = "This device will be Pat: Pat's characters, tokens and whispers. Only pick Pat if you know it is them. Pat is online now. The name they typed matches Pat.";
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

    // Back leads to the password card, and asking again is refused with the hold's own time.
    await rook.page.getByRole("button", { name: "Back" }).click();
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
    // The held wait is answered 404 request_gone as the cancel lands (design 5.1), which Chrome logs. A follow-up may answer it without an error.
    wren.watch.allow = [ME_403, CANCELLED_WAIT];
    await wren.page.getByRole("button", { name: "Cancel" }).click();
    await wren.page.getByRole("heading", { name: "Ask to join" }).waitFor();
    await row.waitFor({ state: "detached" });
    assert.equal((await call(wren.context, "GET", `/api/rooms/${run.roomId}/join-requests/mine`)).status, 204, "a device with no request is answered with nothing");
    await wren.context.close();
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
    ivy.watch.allow = [ME_403, CANCELLED_WAIT];
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
    const fern = await device("fern");
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
    await fern.context.close();
  });

  test("jr-11. a co-DM's phone that opens the room hears of the waiting request once, and when two DM devices let it in at once exactly one does", async () => {
    await pickMode(dm, "With the password, or by asking");
    const sage = await device("sage");
    await ask(sage.page, "Sage", { url: roomUrl() });
    await requestRow(dm, "Sage").waitFor();

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

  test("jr-13. no page logged an error", () => {
    for (const w of watches) assert.deepEqual(w.errors, [], `${w.label}'s page logged errors`);
  });
});
