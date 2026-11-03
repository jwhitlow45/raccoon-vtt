import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { LogEntry } from "#shared/model.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { undoSetup } from "./helpers/undoScope.ts";

/**
 * The in-game clock's Time panel (docs/design/design-v1-calendar.md 4), on the
 * real server serving the production build. Dana the DM is at a desk and Pat
 * on a phone:
 * - ck-1: the DM starts a Day count clock at Day 1, 8:00 AM, and the panel,
 *   Pat's copy and one shared line read it.
 * - ck-2: the four steps, Other amount and its refusals, and Set the date
 *   and time, each one op and one line.
 * - ck-4: a hidden Months clock set up in the Calendar dialog reaches Pat
 *   in no copy and no line, Set reads its weekday, and sharing it later
 *   gives Pat the clock as it is and none of the lines written while it
 *   was hidden.
 * - ck-7: Stop the clock takes a second tap, and Undo setup brings it back.
 * Pat's own Time panel, the toast, the party rest card and the top bar chip
 * are the second part of this file, after the top bar's lane.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 40;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-clock-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = { roomId: "", roomName: `E2E clock ${new Date().toISOString().slice(0, 19)}`, patId: "" };

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const HOUR = 3_600;
const DAY = 86_400;

/** The DM's Time panel: the side panel's tab on the desk. */
async function timePanel(): Promise<Locator> {
  await openSideTab(dm, "Time");
  return dm.getByRole("tabpanel", { name: "Time" });
}

/** The clock lines a copy of the log holds, in order, as the date each stored. */
function clockLines(socket: SocketWatch): { date: string; by?: number; why?: string }[] {
  const lines: LogEntry[] = socket.state?.log ?? [];
  return lines.flatMap((l) => (l.data?.type === "clock" ? [{ date: l.data.date, ...(l.data.by !== undefined ? { by: l.data.by } : {}), ...(l.data.why ? { why: l.data.why } : {}) }] : []));
}

/** Waits for the panel's date block to read `date` and `time`. */
async function reads(panel: Locator, date: string, time: string): Promise<void> {
  await panel.locator("[data-clock-date]").filter({ hasText: new RegExp(`^${date}$`) }).waitFor();
  await panel.locator("[data-clock-time]").filter({ hasText: new RegExp(`^${time}$`) }).waitFor();
}

async function clockT(socket: SocketWatch, want: number): Promise<void> {
  await waitFor(`the clock at ${want} in ${socket.label}'s copy`, () => (socket.state?.clock?.t === want ? true : null), 10_000).catch(() => assert.equal(socket.state?.clock?.t, want, `${socket.label}'s clock`));
}

describe("the room clock's Time panel", () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("ck-0. a DM's room with Pat on a phone", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    const password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
    assert.equal(dmSocket.state?.clock ?? null, null, "a new room has no clock");
  });

  test("ck-1. the DM starts a Day count clock at Day 1, 8:00 AM, and Pat's copy and one shared line read it", async () => {
    const panel = await timePanel();
    await panel.getByText("Keep the in-game date and time. You move it on as time passes. A Long Rest for the party and each fight move it too.", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("radio", { name: "Day count" }).isChecked(), true);
    assert.equal(await panel.getByLabel("Day", { exact: true }).inputValue(), "1");
    assert.equal(await panel.getByLabel("Time", { exact: true }).inputValue(), "08:00");
    const share = panel.getByRole("switch", { name: "Players see the date and time" });
    assert.equal(await share.getAttribute("aria-checked"), "true");
    await shots.take(dm, "ck-1-start-form");
    // A day that is no number is refused under its field, and nothing is sent.
    await panel.getByLabel("Day", { exact: true }).fill("x");
    await panel.getByRole("button", { name: "Start the clock", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Pick a whole day." }).waitFor();
    assert.equal(dmSocket.state?.clock ?? null, null);
    await panel.getByLabel("Day", { exact: true }).fill("1");
    await panel.getByRole("button", { name: "Start the clock", exact: true }).click();
    await reads(panel, "Day 1", "8:00 AM, Morning");
    await clockT(dmSocket, 8 * HOUR);
    await clockT(patSocket, 8 * HOUR);
    const pats = patSocket.state!.clock as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(pats).sort(), ["calendar", "id", "rev", "t"], "a player gets the clock's id, rev, time and calendar, nothing more");
    assert.deepEqual(clockLines(dmSocket), [{ date: "Day 1, 8:00 AM", why: "start" }]);
    assert.deepEqual(clockLines(patSocket), [{ date: "Day 1, 8:00 AM", why: "start" }]);
    await shots.take(dm, "ck-1-running");
  });

  test("ck-2. the steps, Other amount and Set the date and time each send one op and write one line", async () => {
    const panel = await timePanel();
    const group = panel.getByRole("group", { name: "Move the clock on" });
    assert.deepEqual(
      (await group.getByRole("button").allInnerTexts()).map((t) => t.trim()),
      ["10 minutes", "1 hour", "8 hours", "To dawn"],
    );
    await group.getByRole("button", { name: "Move the clock on 10 minutes", exact: true }).click();
    await reads(panel, "Day 1", "8:10 AM, Morning");
    await group.getByRole("button", { name: "Move the clock on 1 hour", exact: true }).click();
    await reads(panel, "Day 1", "9:10 AM, Morning");
    await group.getByRole("button", { name: "Move the clock on 8 hours", exact: true }).click();
    await reads(panel, "Day 1", "5:10 PM, Afternoon");
    await group.getByRole("button", { name: "Move the clock on to dawn, 6:00 AM", exact: true }).click();
    await reads(panel, "Day 2", "6:00 AM, Dawn");
    await clockT(patSocket, DAY + 6 * HOUR);
    // At exactly 6:00 AM, To dawn is the next day's.
    await group.getByRole("button", { name: "Move the clock on to dawn, 6:00 AM", exact: true }).click();
    await reads(panel, "Day 3", "6:00 AM, Dawn");

    // Other amount: a row opens in place, refuses what is no step, and Enter moves on.
    await panel.getByRole("button", { name: "Other amount…", exact: true }).click();
    const amount = panel.getByRole("textbox", { name: "Amount", exact: true });
    await amount.fill("0");
    await amount.press("Enter");
    await panel.getByRole("alert").filter({ hasText: "Pick a whole number of 1 or more." }).waitFor();
    await amount.fill("2");
    await panel.getByRole("combobox", { name: "Unit", exact: true }).selectOption("days");
    await amount.press("Enter");
    await reads(panel, "Day 5", "6:00 AM, Dawn");
    await amount.fill("9999999");
    await panel.getByRole("button", { name: "Move on", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "The clock can't go that far." }).waitFor();
    await clockT(dmSocket, 4 * DAY + 6 * HOUR);

    // Set the date and time: a day with no number keeps the dialog open with the reason, a change sets it.
    const open = panel.getByRole("button", { name: "Set the date and time…", exact: true });
    await open.click();
    const dialog = dm.getByRole("dialog", { name: "Set the date and time", exact: true });
    await dialog.getByLabel("Day", { exact: true }).fill("0.5");
    await dialog.getByRole("button", { name: "Set", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Pick a whole day." }).waitFor();
    await dialog.getByLabel("Day", { exact: true }).fill("1");
    await dialog.getByLabel("Time", { exact: true }).fill("22:00");
    // Cancel with changes asks first.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard changes?", exact: true }).waitFor();
    await dialog.getByLabel("Time", { exact: true }).fill("22:00");
    await dialog.getByRole("button", { name: "Set", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await reads(panel, "Day 1", "10:00 PM, Night");
    await clockT(patSocket, 22 * HOUR);
    assert.equal(await open.evaluate((el) => el.matches(":focus")), true, "focus goes back to the button that opened the dialog");

    assert.deepEqual(
      clockLines(patSocket).slice(1),
      [
        { date: "Day 1, 8:10 AM", by: 600 },
        { date: "Day 1, 9:10 AM", by: HOUR },
        { date: "Day 1, 5:10 PM", by: 8 * HOUR },
        { date: "Day 2, 6:00 AM", by: 12 * HOUR + 50 * 60 },
        { date: "Day 3, 6:00 AM", by: DAY },
        { date: "Day 5, 6:00 AM", by: 2 * DAY },
        { date: "Day 1, 10:00 PM", why: "set" },
      ],
      "one line a change, the refused ones none",
    );
    await shots.take(dm, "ck-2-after-set");
  });

  test("ck-4. a hidden Months clock set up in the Calendar dialog reaches Pat in no copy and no line, and sharing it later gives Pat the clock and none of those lines", async () => {
    const panel = await timePanel();
    // Stopping needs a second tap.
    const stop = panel.getByRole("button", { name: "Stop the clock", exact: true });
    await stop.click();
    assert.notEqual(dmSocket.state?.clock ?? null, null, "one tap only arms it");
    await panel.getByRole("button", { name: "Tap again to stop the clock", exact: true }).click();
    await waitFor("no clock in the DM's copy", () => (dmSocket.state?.clock == null ? true : null));
    await waitFor("no clock in Pat's copy", () => (patSocket.state?.clock == null ? true : null));

    await panel.getByRole("radio", { name: "Months" }).click();
    const calendar = dm.getByRole("dialog", { name: "Calendar", exact: true });
    await calendar.waitFor();
    assert.equal(await calendar.getByRole("textbox", { name: /^Month \d+ name$/ }).count(), 12);
    await calendar.getByRole("textbox", { name: "Month 1 name", exact: true }).fill("Deepwinter");
    await calendar.getByRole("textbox", { name: "Days in Deepwinter", exact: true }).fill("28");
    await calendar.getByRole("textbox", { name: "Month 2 name", exact: true }).fill("Midwinter");
    await calendar.getByRole("textbox", { name: "Days in Midwinter", exact: true }).fill("1");
    await calendar.getByRole("button", { name: "Move down Midwinter", exact: true }).click();
    assert.equal(await calendar.getByRole("textbox", { name: "Month 3 name", exact: true }).inputValue(), "Midwinter");
    await calendar.getByRole("button", { name: "Move up Midwinter", exact: true }).click();
    await calendar.getByRole("textbox", { name: "Month 12 name", exact: true }).fill("");
    await calendar.getByRole("button", { name: "Save", exact: true }).click();
    await calendar.getByText("Name month 12 with 1 to 24 characters.", { exact: true }).waitFor();
    await calendar.getByRole("textbox", { name: "Month 12 name", exact: true }).fill("Month 12");
    await calendar.getByLabel("Day names", { exact: true }).fill("Moonday, Tuesday, Octday");
    await calendar.getByLabel("After the year", { exact: true }).fill("AF");
    await calendar.getByText("A year is 329 days.", { exact: true }).waitFor();
    await shots.take(dm, "ck-4-calendar");
    await calendar.getByRole("button", { name: "Save", exact: true }).click();
    await calendar.waitFor({ state: "detached" });
    await panel.getByText("12 months, 3-day week", { exact: true }).waitFor();

    // The form holds the Months fields. Hide the clock from players and start it on Midwinter, a festival day.
    await panel.getByLabel("Month", { exact: true }).selectOption("2");
    await panel.getByLabel("Day", { exact: true }).fill("7");
    await panel.getByLabel("Year", { exact: true }).fill("1204");
    await panel.getByRole("switch", { name: "Players see the date and time" }).click();
    await panel.getByRole("button", { name: "Start the clock", exact: true }).click();
    await waitFor("the hidden clock in the DM's copy", () => (dmSocket.state?.clock?.shown === false ? true : null));
    const date = await panel.locator("[data-clock-date]").innerText();
    assert.match(date, /^(Moonday|Tuesday|Octday), Month 3 7, 1204 AF$/);
    await panel.getByText("Players don't see the date and time.", { exact: true }).waitFor();
    assert.equal(patSocket.state?.clock ?? null, null, "Pat has no clock");
    assert.equal(patSocket.everSaw("1204"), false, "no frame Pat got names the year");
    assert.equal(patSocket.everSaw("Month 3"), false, "no frame Pat got names a month");

    // Set reads the weekday under its fields and writes a DM-only line.
    const open = panel.getByRole("button", { name: "Set the date and time…", exact: true });
    await open.click();
    const dialog = dm.getByRole("dialog", { name: "Set the date and time", exact: true });
    await dialog.getByLabel("Month", { exact: true }).selectOption("1");
    await dialog.getByLabel("Day", { exact: true }).fill("1");
    await dialog.getByText(/^An? (Moonday|Tuesday|Octday)\.$/).waitFor();
    await dialog.getByLabel("Day", { exact: true }).fill("2");
    await dialog.getByRole("button", { name: "Set", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Pick a day from 1 to 1." }).waitFor();
    await dialog.getByLabel("Day", { exact: true }).fill("1");
    await dialog.getByRole("button", { name: "Set", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await panel.locator("[data-clock-date]").filter({ hasText: /^(Moonday|Tuesday|Octday), Midwinter, 1204 AF$/ }).waitFor();
    assert.equal(patSocket.everSaw("Midwinter"), false, "Set while hidden reaches Pat in no frame");
    assert.equal(clockLines(patSocket).length, 8, "Pat's lines are the ones he read before: none added while hidden");
    await waitFor("the DM's two new lines", () => (clockLines(dmSocket).length === 10 ? true : null));
    const weekday = "(Moonday|Tuesday|Octday)";
    const [started, set] = clockLines(dmSocket).slice(8);
    assert.match(started!.date, new RegExp(`^${weekday}, Month 3 7, 1204 AF, 8:00 AM$`));
    assert.match(set!.date, new RegExp(`^${weekday}, Midwinter, 1204 AF, 8:00 AM$`));
    assert.deepEqual([started!.why, set!.why], ["start", "set"], "the DM's own lines after the eight Pat read: the new start and Set");

    // Sharing it gives Pat the clock as it is now, and none of the hidden lines.
    await panel.getByRole("switch", { name: "Players see the date and time" }).click();
    await waitFor("the clock in Pat's copy", () => (patSocket.state?.clock?.calendar.kind === "months" ? true : null));
    assert.equal(patSocket.state!.clock!.t, dmSocket.state!.clock!.t);
    assert.equal(clockLines(patSocket).length, 8, "sharing does not hand over the lines written while hidden");
    assert.equal(patSocket.everSaw("1204 AF, "), false);
  });

  test("ck-7. Stop the clock and Undo setup in Setup history bring the clock back", async () => {
    const panel = await timePanel();
    const t = dmSocket.state!.clock!.t;
    const id = dmSocket.state!.clock!.id;
    await panel.getByRole("button", { name: "Stop the clock", exact: true }).click();
    await panel.getByRole("button", { name: "Tap again to stop the clock", exact: true }).click();
    await waitFor("no clock", () => (dmSocket.state?.clock == null ? true : null));
    await panel.getByRole("button", { name: "Start the clock", exact: true }).waitFor();
    await waitFor("no clock in Pat's copy", () => (patSocket.state?.clock == null ? true : null));
    // Pat keeps every line he read.
    assert.equal(clockLines(patSocket).length, 8);
    await undoSetup(dm);
    await waitFor("the clock back", () => (dmSocket.state?.clock?.id === id && dmSocket.state.clock.t === t ? true : null));
    await waitFor("the clock back in Pat's copy", () => (patSocket.state?.clock?.t === t ? true : null));
    assert.equal(patSocket.state!.clock!.id, id);
  });

  test("ck-8. neither page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
