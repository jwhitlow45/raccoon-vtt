import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { LogEntry } from "#shared/model.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { playControl, undoSetup } from "./helpers/undoScope.ts";

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
 * - ck-2b: Pat's toast for a step while his Log and Time panel are closed,
 *   and none for the DM's own device.
 * - ck-3: the party's Long Rest moves the clock 8 hours first, each stamp
 *   marks its end and never reaches Pat, the card's note gives the next
 *   start, and one Undo takes the rest back.
 * - ck-5: Pat's Time panel, open when sharing stops, says so until closed.
 * - ck-6: the top bar chip on a computer opens the Time panel and never
 *   overflows Pat's row.
 * - cf-1 to cf-6, the calendar review's fixes: a clock's seconds kept by
 *   Set and a rename, Today and Set following the calendar, the discard
 *   question said aloud, the running controls going with their clock, the
 *   DM's 1024 px row with a blackout and a long name, and Pat's chip coming
 *   back once its date is short.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty-two, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 42;
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

const run = { roomId: "", roomName: `E2E clock ${new Date().toISOString().slice(0, 19)}`, patId: "", thorn: randomUUID(), bree: randomUUID() };

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

/** Waits for the Month select's error to read `text`, linked to it by aria-describedby. */
async function monthError(root: Locator, text: string): Promise<void> {
  const select = root.getByLabel("Month", { exact: true });
  await waitFor(`the month's error "${text}"`, () => select.evaluate((el, want) => (el.ownerDocument.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent === want && el.getAttribute("aria-invalid") === "true" ? true : null), text));
  await root.getByRole("alert").filter({ hasText: new RegExp(`^${text.replace(".", "\\.")}$`) }).first().waitFor();
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
    await panel.getByText("Track the in-game date and time. You move the clock on as time passes. Party Long Rests and fights move it too.", { exact: true }).waitFor();
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

  test("ck-2b. Pat gets a toast for a step while his Log and Time panel are closed, and the DM's own device gets none", async () => {
    const panel = await timePanel();
    const before = clockLines(patSocket).length;
    await panel.getByRole("group", { name: "Move the clock on" }).getByRole("button", { name: "Move the clock on 1 hour", exact: true }).click();
    await waitFor("the new line in Pat's copy", () => (clockLines(patSocket).length === before + 1 ? true : null));
    await pat.getByText(/^1 hour passes\. It is now /).first().waitFor();
    assert.equal(await dm.getByText(/^1 hour passes\. It is now /).count(), 0, "the DM's own device shows no toast for its own step");
  });

  test("ck-3. the party's Long Rest moves the clock 8 hours first, stamps each character's end for the DM alone, and one Undo takes it all back", async () => {
    const actor = { hp: { cur: 20, max: 45, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor, level: 5 } });
    await ops.send({ t: "character.create", character: { id: run.bree, name: "Bree", size: "medium", ownerIds: [run.patId], actor, level: 5 } });
    await waitFor("both characters", () => (dmSocket.state?.characters[run.bree] ? true : null));
    await openSideTab(dm, "Characters");
    const panel = dm.getByRole("tabpanel", { name: "Characters" });
    const clockId = dmSocket.state!.clock!.id;
    const t0 = dmSocket.state!.clock!.t;

    await panel.getByRole("button", { name: "Long Rest for the party", exact: true }).click();
    const box = panel.getByRole("checkbox", { name: "Move the clock on 8 hours", exact: true });
    assert.equal(await box.isChecked(), true, "ticked by default");
    assert.equal(await panel.getByText(/finished a Long Rest at /).count(), 0, "no stamp yet, no note");
    await panel.getByRole("button", { name: "Finish the Long Rest", exact: true }).click();
    await clockT(dmSocket, t0 + 8 * HOUR);
    await waitFor("both stamps", () => (dmSocket.state?.characters[run.thorn]?.longRest && dmSocket.state.characters[run.bree]?.longRest ? true : null));
    for (const id of [run.thorn, run.bree]) assert.deepEqual(dmSocket.state!.characters[id]!.longRest, { at: t0 + 8 * HOUR, clock: clockId }, "the stamp marks the rest's end");
    assert.equal(patSocket.state?.characters[run.thorn]?.longRest, undefined, "a stamp never reaches the owner");
    assert.equal(patSocket.everSaw(`"longRest":{`), false, "no frame Pat got holds a stamp (the line's own why: longRest is a different key)");

    // Six hours later the card names the last finish and the earliest next start, and the rest still goes through.
    await ops.send({ t: "clock.advance", by: 6 * HOUR });
    await panel.getByRole("button", { name: "Long Rest for the party", exact: true }).click();
    const notes = panel.getByText(/finished a Long Rest at .* The rules let the next start from /);
    await notes.first().waitFor();
    assert.equal(await notes.count(), 2, "one line a character");
    await shots.take(dm, "ck-3-rest-card");
    await box.uncheck();
    await panel.getByRole("button", { name: "Finish the Long Rest", exact: true }).click();
    await waitFor("both rests recorded without a clock step", () => (dmSocket.state?.characters[run.thorn]?.longRest?.at === t0 + 14 * HOUR ? true : null));
    assert.equal(dmSocket.state!.clock!.t, t0 + 14 * HOUR, "unticked, the clock stays where it was");

    // The ticked rest again, then Undo takes the clock and both stamps back in one step.
    await panel.getByRole("button", { name: "Long Rest for the party", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Move the clock on 8 hours", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Finish the Long Rest", exact: true }).click();
    await clockT(dmSocket, t0 + 22 * HOUR);
    await waitFor("the new stamps", () => (dmSocket.state?.characters[run.thorn]?.longRest?.at === t0 + 22 * HOUR ? true : null));
    await playControl(dm, "undo").click();
    await clockT(dmSocket, t0 + 14 * HOUR);
    await waitFor("the stamps back", () => (dmSocket.state?.characters[run.thorn]?.longRest?.at === t0 + 14 * HOUR && dmSocket.state.characters[run.bree]?.longRest?.at === t0 + 14 * HOUR ? true : null));
  });

  test("ck-5. Pat's Time panel, open when the DM stops sharing, says so until he closes it, and leaves his list", async () => {
    const panels = pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ });
    const list = pat.getByRole("region", { name: "Panels" });
    const sheet = pat.locator('dialog[data-rvtt-sheet][aria-label="Time"]');
    await panels.click();
    await list.getByRole("button", { name: /^Time/ }).click();
    await sheet.locator("[data-clock-date]").waitFor();
    assert.equal(await sheet.getByRole("button").filter({ hasText: /minutes|hour|dawn|Set the date|Calendar|Stop/ }).count(), 0, "a player has none of the DM's controls");
    await shots.take(pat, "ck-5-pat-time");
    const panel = await timePanel();
    await panel.getByRole("switch", { name: "Players see the date and time" }).click();
    await sheet.getByText("The DM isn't sharing the date and time now.", { exact: true }).waitFor();
    await sheet.getByRole("button", { name: /^Close / }).first().click();
    await sheet.waitFor({ state: "detached" });
    await panels.click();
    assert.equal(await list.getByRole("button", { name: /^Time/ }).count(), 0, "Time is not in his list while nothing is shared");
    await pat.keyboard.press("Escape");
    await panel.getByRole("switch", { name: "Players see the date and time" }).click();
    await panels.click();
    await list.getByRole("button", { name: /^Time/ }).waitFor();
    await pat.keyboard.press("Escape");
  });

  test("ck-6. on a computer the chip opens the Time panel, and a long date never overflows Pat's top bar", async () => {
    await pat.setViewportSize({ width: 1024, height: 768 });
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    const chip = pat.getByRole("button", { name: /^Time: / });
    await chip.waitFor();
    assert.match((await chip.innerText()).trim(), /, \d+:\d\d [AP]M$/);
    await chip.click();
    await pat.getByRole("tabpanel", { name: "Time" }).locator("[data-clock-date]").waitFor();
    const overflows = () => pat.locator("header").first().evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok((await overflows()) <= 1, "the row does not overflow with the chip");
    // A long month name and era: the row still checks, and the chip leaves when it would overflow.
    const long = "Longest-month-name-here1";
    await ops.send({ t: "clock.update", calendar: { kind: "months", months: [{ name: long, days: 30 }, { name: "Second", days: 30 }], week: ["Moonday"], era: "Era words 12" }, at: 8 * HOUR });
    await waitFor("the long calendar in Pat's copy", () => (patSocket.state?.clock?.calendar.kind === "months" ? true : null));
    for (const width of [1024, 960, 900]) {
      await pat.setViewportSize({ width, height: 768 });
      await pat.waitForTimeout(300);
      assert.ok((await overflows()) <= 1, `Pat's row overflows by ${await overflows()} px at ${width}`);
    }
    await shots.take(pat, "ck-6-long-date");
    await pat.setViewportSize(PHONE);
  });

  test("cf-1. Set left as it opened and a calendar rename keep a clock's seconds and write no line (CALB-O-02, ASTRA-01)", async () => {
    // A 3-round fight's 18 seconds past 8:00 AM, which the fields show as 08:00.
    const at = 8 * HOUR + 18;
    await ops.send({ t: "clock.set", at });
    await clockT(dmSocket, at);
    const before = clockLines(dmSocket).length;
    const panel = await timePanel();
    await panel.getByRole("button", { name: "Set the date and time…", exact: true }).click();
    const set = dm.getByRole("dialog", { name: "Set the date and time", exact: true });
    assert.equal(await set.getByLabel("Time", { exact: true }).inputValue(), "08:00");
    await set.getByRole("button", { name: "Set", exact: true }).click();
    await set.waitFor({ state: "detached" });
    await panel.getByRole("button", { name: "Calendar…", exact: true }).click();
    const calendar = dm.getByRole("dialog", { name: "Calendar", exact: true });
    await calendar.getByRole("textbox", { name: "Month 2 name", exact: true }).fill("Thaw");
    await calendar.getByRole("button", { name: "Save", exact: true }).click();
    await calendar.waitFor({ state: "detached" });
    await waitFor("the rename in the DM's copy", () => (dmSocket.state?.clock?.calendar.kind === "months" && dmSocket.state.clock.calendar.months[1]?.name === "Thaw" ? true : null));
    // A step after them, so whatever they sent has arrived before the count.
    await panel.getByRole("group", { name: "Move the clock on" }).getByRole("button", { name: "Move the clock on 10 minutes", exact: true }).click();
    await clockT(dmSocket, at + 600);
    assert.deepEqual(clockLines(dmSocket).slice(before).map((l) => l.by), [600], "the step's line alone: Set and the rename wrote none");
  });

  test("cf-2. Calendar's Today follows a new kind and a removed month, names the month it lacks, and says its discard question aloud (ASTRA-04, ASTRA-08)", async () => {
    const panel = await timePanel();
    const t = dmSocket.state!.clock!.t;
    await panel.getByRole("button", { name: "Calendar…", exact: true }).click();
    const calendar = dm.getByRole("dialog", { name: "Calendar", exact: true });
    // Today's fields are the dialog's only Day, Month and Time: the month rows' fields are named for their months.
    const today = calendar;
    // A new kind starts Today again from the first day, whatever was typed in it.
    await today.getByLabel("Day", { exact: true }).fill("9");
    await calendar.getByRole("radio", { name: "Day count" }).click();
    await waitFor("Today on Day 1", async () => ((await today.getByLabel("Day", { exact: true }).inputValue()) === "1" ? true : null));
    await calendar.getByRole("radio", { name: "Months" }).click();
    // Today in Thaw with its time edited, then Thaw removed: the month reads as none, and Save names it.
    await today.getByLabel("Month", { exact: true }).selectOption("1");
    await today.getByLabel("Time", { exact: true }).fill("09:00");
    await calendar.getByRole("button", { name: "Remove Thaw", exact: true }).click();
    assert.equal(await today.getByLabel("Month", { exact: true }).inputValue(), "");
    await today.getByRole("option", { name: "Pick a month" }).waitFor({ state: "attached" });
    await calendar.getByRole("button", { name: "Save", exact: true }).click();
    await monthError(today, "Pick a month.");
    await shots.take(dm, "cf-2-month-error");
    // Escape asks aloud before it discards, and a second Escape leaves.
    await dm.keyboard.press("Escape");
    await calendar.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
    await shots.take(dm, "cf-2-discard-question");
    await dm.keyboard.press("Escape");
    await calendar.waitFor({ state: "detached" });
    assert.equal(dmSocket.state!.clock!.t, t, "nothing was sent");
    assert.equal(dmSocket.state!.clock!.calendar.kind === "months" && dmSocket.state!.clock!.calendar.months.length, 2);
  });

  test("cf-3. a month another DM removes while Set is open reads as none, and Set names it (ASTRA-04)", async () => {
    const panel = await timePanel();
    await panel.getByRole("button", { name: "Set the date and time…", exact: true }).click();
    const set = dm.getByRole("dialog", { name: "Set the date and time", exact: true });
    await set.getByLabel("Month", { exact: true }).selectOption("1");
    const clock = dmSocket.state!.clock!;
    assert.equal(clock.calendar.kind, "months");
    if (clock.calendar.kind !== "months") return;
    await ops.send({ t: "clock.update", calendar: { ...clock.calendar, months: clock.calendar.months.slice(0, 1) } });
    await waitFor("the month gone from Set", async () => ((await set.getByLabel("Month", { exact: true }).inputValue()) === "" ? true : null));
    await set.getByRole("button", { name: "Set", exact: true }).click();
    await monthError(set, "Pick a month.");
    await shots.take(dm, "cf-3-set-month-gone");
    await set.getByLabel("Month", { exact: true }).selectOption("0");
    await set.getByLabel("Day", { exact: true }).fill("2");
    await dm.keyboard.press("Escape");
    await set.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
    await shots.take(dm, "cf-3-set-discard-question");
    await dm.keyboard.press("Escape");
    await set.waitFor({ state: "detached" });
    await ops.send({ t: "clock.update", calendar: clock.calendar });
  });

  test("cf-3b. Set follows a month another DM moves, and never lands on the month after one another DM removes (ASTRA-04, round 2)", async () => {
    const before = dmSocket.state!.clock!.calendar;
    const months = (...names: string[]) => ({ kind: "months" as const, months: names.map((name) => ({ name, days: 30 })) });
    await ops.send({ t: "clock.update", calendar: months("April", "May", "June") });
    const panel = await timePanel();
    await panel.locator("[data-clock-calendar]").filter({ hasText: /^3 months$/ }).waitFor();
    await panel.getByRole("button", { name: "Set the date and time…", exact: true }).click();
    const set = dm.getByRole("dialog", { name: "Set the date and time", exact: true });
    const month = set.getByLabel("Month", { exact: true });
    await month.selectOption("1");
    await set.getByLabel("Day", { exact: true }).fill("6");
    await ops.send({ t: "clock.update", calendar: months("June", "April", "May") });
    await waitFor("May followed to its new place", async () => ((await month.inputValue()) === "2" ? true : null));
    await ops.send({ t: "clock.update", calendar: months("June", "April") });
    await waitFor("May gone from Set", async () => ((await month.inputValue()) === "" ? true : null));
    const t = dmSocket.state!.clock!.t;
    await set.getByRole("button", { name: "Set", exact: true }).click();
    await monthError(set, "Pick a month.");
    assert.equal(dmSocket.state!.clock!.t, t, "nothing was sent");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
    await set.waitFor({ state: "detached" });
    await ops.send({ t: "clock.update", calendar: before });
  });

  test("cf-4. an armed Stop and an open dialog go with their clock when another device stops it and starts another, or stops it and Undo brings it back (ASTRA-07)", async () => {
    const panel = await timePanel();
    const stop = panel.getByRole("button", { name: "Stop the clock", exact: true });
    await stop.click();
    await panel.getByRole("button", { name: "Tap again to stop the clock", exact: true }).waitFor();
    await ops.send({ t: "clock.stop" });
    await panel.getByRole("button", { name: "Start the clock", exact: true }).waitFor();
    await ops.send({ t: "clock.start", id: randomUUID(), at: 8 * HOUR, shown: true, calendar: { kind: "days" } });
    await stop.waitFor();
    assert.equal(await panel.getByRole("button", { name: "Tap again to stop the clock", exact: true }).count(), 0, "a new clock's Stop is not armed");

    // Stop armed, then another device stops the clock and Undo setup brings the same clock back.
    const id = dmSocket.state!.clock!.id;
    await stop.click();
    await panel.getByRole("button", { name: "Tap again to stop the clock", exact: true }).waitFor();
    await ops.send({ t: "clock.stop" });
    await panel.getByRole("button", { name: "Start the clock", exact: true }).waitFor();
    await undoSetup(dm);
    await waitFor("the clock back", () => (dmSocket.state?.clock?.id === id ? true : null));
    const again = await timePanel();
    await again.getByRole("button", { name: "Stop the clock", exact: true }).waitFor();
    assert.equal(await again.getByRole("button", { name: "Tap again to stop the clock", exact: true }).count(), 0, "the clock Undo brought back finds Stop unarmed");

    // A dialog open when another device stops the clock goes with it, and never opens again on the clock that comes back.
    await again.getByRole("button", { name: "Set the date and time…", exact: true }).click();
    const set = dm.getByRole("dialog", { name: "Set the date and time", exact: true });
    await set.waitFor();
    await ops.send({ t: "clock.stop" });
    await set.waitFor({ state: "detached" });
    await undoSetup(dm);
    await waitFor("the clock back", () => (dmSocket.state?.clock?.id === id ? true : null));
    await (await timePanel()).getByRole("button", { name: "Stop the clock", exact: true }).waitFor();
    assert.equal(await set.count(), 0, "no dialog opens on the clock that came back");
  });

  test("cf-5. the DM's top bar at 1024 px with a blackout and a long room name: the chip leaves first and the rest of the row is as it is without a clock (CALB-O-10)", async () => {
    const long = `${run.roomName} and the long road to the Sunless Citadel beyond`.slice(0, 80);
    await ops.send({ t: "room.update", name: long });
    await ops.send({ t: "view.blackout", blackout: true });
    await dm.setViewportSize({ width: 1024, height: 768 });
    const row = async () => {
      await dm.reload();
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await dm.waitForTimeout(300);
      const header = dm.locator("header").first();
      const overflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
      const chip = await dm.getByRole("button", { name: /^Time: / }).count();
      const rest = await header.evaluate((el) => {
        const copy = el.cloneNode(true) as typeof el;
        for (const b of copy.querySelectorAll("button")) if ((b.getAttribute("aria-label") ?? "").startsWith("Time: ")) b.remove();
        return copy.innerText.replace(/\s+/g, " ").trim();
      });
      return { overflow, chip, rest };
    };
    try {
      const withClock = await row();
      await ops.send({ t: "clock.stop" });
      await waitFor("no clock", () => (dmSocket.state?.clock == null ? true : null));
      const without = await row();
      await shots.take(dm, "cf-5-dm-1024-blackout");
      assert.ok(withClock.overflow <= 1 && without.overflow <= 1, `the row overflows: ${withClock.overflow} px with the clock, ${without.overflow} px without`);
      assert.equal(withClock.rest, without.rest, "the rest of the row reads as it does without a clock");
      assert.equal(withClock.chip, 0, "the long name leaves no room, and the chip is what leaves");
      await undoSetup(dm);
      await waitFor("the clock back", () => (dmSocket.state?.clock ? true : null));
    } finally {
      await ops.send({ t: "view.blackout", blackout: false });
      await dm.setViewportSize(DESK);
    }
  });

  test("cf-6. Pat's chip, gone for a long date, comes back at the same width once the date is short (CALB-O-09)", async () => {
    await ops.send({ t: "clock.update", calendar: { kind: "months", months: [{ name: "Longest-month-name-here1", days: 30 }], week: ["Moonday"], era: "Era words 12" } });
    await pat.setViewportSize({ width: 900, height: 768 });
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("the long calendar in Pat's copy", () => (patSocket.state?.clock?.calendar.kind === "months" ? true : null));
    const chip = pat.getByRole("button", { name: /^Time: / });
    await pat.waitForTimeout(300);
    assert.equal(await chip.count(), 0, "the long date leaves no room at 900 px beside the long name");
    await ops.send({ t: "clock.update", calendar: { kind: "days" } });
    await chip.waitFor();
    const overflow = await pat.locator("header").first().evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `Pat's row overflows by ${overflow} px`);
    await shots.take(pat, "cf-6-chip-back");
    await pat.setViewportSize(PHONE);
    await ops.send({ t: "room.update", name: run.roomName });
  });

  test("ck-8. neither page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
