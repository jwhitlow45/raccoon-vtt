import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { Effect } from "#shared/model.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Time spans on effects (docs/design/design-v1-calendar-c2c3.md 3), on the
 * real server serving the production build. Dana the DM is at a desk, Pat
 * on a phone and a table display on a TV:
 * - tm-1: the Duration select lists the time spans after today's choices,
 *   Other length of time refuses what is no span under its field, and an
 *   effect row reads its end. Pat adds a span of his own, and his copy
 *   carries its end while the clock is shared.
 * - tm-2: a step of the clock ends Pat's effect, the notice shows on his
 *   phone and the DM's step ends Bree's two.
 * - tm-3: in a fight, a 1 minute span reads as the round it ends at the
 *   start of, ends as round 11 starts and comes back with Previous.
 * - tm-4: with the clock hidden, Pat's copy holds only the length, his
 *   picker lists no time span, and sharing the clock gives him its end.
 * - tm-5: the table display's Show the date and time, kept by the display,
 *   going with a hidden clock.
 *
 * It needs the timed model (the reducer that ends a span and the
 * projection that hides its end), so steps tm-2 to tm-4 read as failures
 * until that lane's commits are under it.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-nine, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 59;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-timed-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let pat: Page;
let tv: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const tvSocket = new SocketWatch("display");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");
const tvConsole = new ConsoleWatch("display");

const run = { roomId: "", roomName: `E2E timed ${new Date().toISOString().slice(0, 19)}`, patId: "", thorn: randomUUID(), bree: randomUUID(), clockId: randomUUID() };

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TV = { width: 1280, height: 720 };
const HOUR = 3_600;
/** Day 1, 10:00 PM, so an 8 hour span ends at 6:00 AM on Day 2. */
const START = 22 * HOUR;

/** The Characters panel: the side panel's tab where there is one, else a sheet from the tool bar's Panels list. */
async function openCharacters(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.first().isVisible())) {
    await openSideTab(page, "Characters");
    return page.getByRole("tabpanel", { name: "Characters" });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** A character's page open in the Characters panel, with its Combat group unfolded. */
async function openCard(page: Page, characterId: string): Promise<Locator> {
  const panel = await openCharacters(page);
  const name = dmSocket.state!.characters[characterId]!.name;
  const heading = panel.locator("[data-creature-heading]").filter({ hasText: name });
  // A player with one character lands on its page, so the list's row may never show.
  const opener = panel.locator(`[data-opener="character:${characterId}"]`);
  const back = page.getByRole("button", { name: "Back to Characters" });
  await heading.or(opener).or(back).first().waitFor();
  if ((await heading.count()) === 0) {
    // Another character's page is open: back to the list first.
    if (!(await opener.isVisible())) await back.click();
    await opener.click();
    await heading.waitFor();
  }
  const fold = panel.getByRole("button", { name: "Combat", exact: true });
  if ((await fold.count()) > 0 && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  return panel;
}

/** The Conditions section of an open character page. */
const conditions = (panel: Locator): Locator => panel.locator('xpath=.//section[*[self::h3 or self::h4][normalize-space()="Conditions"] or *[not(self::section)]/*[self::h3 or self::h4][normalize-space()="Conditions"]]');

/** Opens the add form for a status from the picker, and returns the Duration select. */
async function startAdd(section: Locator, label: RegExp): Promise<Locator> {
  await section.getByRole("button", { name: "Add", exact: true }).click();
  await section.getByRole("button", { name: label }).first().click();
  return section.getByRole("combobox", { name: "Duration", exact: true });
}

/** The chosen length is added and the form closes back to the list. */
async function finishAdd(section: Locator): Promise<void> {
  await section.getByRole("button", { name: "Add", exact: true }).click();
  await section.getByRole("button", { name: "Back", exact: true }).waitFor({ state: "detached" });
}

const effectsOf = (socket: SocketWatch, characterId: string): Effect[] => socket.state?.characters[characterId]?.actor.effects ?? [];

/** The DM's Time panel, to step the clock from. */
async function timePanel(): Promise<Locator> {
  await openSideTab(dm, "Time");
  return dm.getByRole("tabpanel", { name: sideTabName("Time") });
}

async function step(label: string): Promise<void> {
  const panel = await timePanel();
  await panel.getByRole("group", { name: "Move the clock on" }).getByRole("button", { name: `Move the clock on ${label}`, exact: true }).click();
}

describe("time spans on effects", () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    tvContext = await browser.newContext({ viewport: TV });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    tv = await tvContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    tvConsole.attach(tv);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    await tvSocket.attach(tvContext, tv);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole, tvConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("tm-0. a DM's room with Pat on a phone, a running clock at 10:00 PM and two characters", async () => {
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

    const actor = { hp: { cur: 20, max: 45, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor, level: 5 } });
    await ops.send({ t: "character.create", character: { id: run.bree, name: "Bree", size: "medium", ownerIds: [], actor, level: 5 } });
    await ops.send({ t: "clock.start", id: run.clockId, at: START, shown: true, calendar: { kind: "days" } });
    await waitFor("both characters and the clock in Pat's copy", () => (patSocket.state?.characters[run.thorn] && patSocket.state.clock?.t === START ? true : null));
  });

  test("tm-1. the Duration select lists the time spans, Other refuses what is no span, rows read their end, and Pat's copy carries his", async () => {
    const panel = await openCard(dm, run.bree);
    const section = conditions(panel);
    const duration = await startAdd(section, /Blessed/);
    assert.deepEqual(await duration.locator("option").allInnerTexts(), [
      "No duration",
      "Start of X's next turn",
      "End of X's next turn",
      "N rounds",
      "1 minute",
      "10 minutes",
      "1 hour",
      "8 hours",
      "24 hours",
      "Other length of time",
    ]);
    await duration.selectOption({ label: "8 hours" });
    assert.equal(await section.getByLabel("Whose turn", { exact: true }).count(), 0, "a time span counts the clock, so it names no creature");
    await duration.scrollIntoViewIfNeeded();
    await shots.take(dm, "tm-1-span-picker");
    await finishAdd(section);
    await section.getByText("Lasts 8 hours, to Day 2, 6:00 AM (8 hours left)", { exact: true }).waitFor();
    const blessed = await waitFor("Bree's Blessed in the DM's copy", () => effectsOf(dmSocket, run.bree).find((e) => e.key === "blessed" && e.ends));
    assert.deepEqual(blessed?.ends, { span: 8 * HOUR, at: START + 8 * HOUR, clock: run.clockId });
    assert.equal(blessed?.duration, undefined, "never both");

    // Other length of time: a row opens, refuses what is no span under its field, and keeps the form.
    const other = await startAdd(section, /Hasted/);
    await other.selectOption({ label: "Other length of time" });
    const length = section.getByRole("textbox", { name: "Length", exact: true });
    await length.fill("0");
    await section.getByRole("button", { name: "Add", exact: true }).click();
    const refusal = "Pick a length from 1 minute to 365 days.";
    await section.getByText(refusal, { exact: true }).waitFor();
    const described = await length.evaluate((el) => el.ownerDocument.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
    assert.equal(described, refusal, "the refusal is linked to the field");
    assert.equal(effectsOf(dmSocket, run.bree).length, 1, "nothing was sent");
    await shots.take(dm, "tm-1-other-refused");
    await length.fill("90");
    await section.getByRole("combobox", { name: "Unit", exact: true }).selectOption({ label: "Minutes" });
    await length.scrollIntoViewIfNeeded();
    await shots.take(dm, "tm-1-other-row");
    await finishAdd(section);
    await section.getByText(/^Lasts 90 minutes, to 11:30 PM/).waitFor();
    await waitFor("Bree's Hasted", () => (effectsOf(dmSocket, run.bree).find((e) => e.key === "hasted")?.ends?.span === 90 * 60 ? true : null));

    // Pat adds one of his own: the clock is shared, so his picker lists the spans and his copy carries the end.
    const patPanel = await openCard(pat, run.thorn);
    const patSection = conditions(patPanel);
    const patDuration = await startAdd(patSection, /Blessed/);
    assert.ok((await patDuration.locator("option").allInnerTexts()).includes("1 hour"), "Pat's picker lists the spans while the clock is shared");
    await patDuration.selectOption({ label: "1 hour" });
    await finishAdd(patSection);
    await patSection.getByText("Lasts 1 hour, to 11:00 PM (1 hour left)", { exact: true }).waitFor();
    const mine = await waitFor("Thorn's Blessed in Pat's copy", () => effectsOf(patSocket, run.thorn).find((e) => e.key === "blessed" && e.ends));
    assert.deepEqual(mine?.ends, { span: HOUR, at: START + HOUR, clock: run.clockId }, "Pat's copy carries the end while his view holds the clock");
    await shots.take(pat, "tm-1-pat-row");
  });

  test("tm-2. a step of the clock ends Pat's effect with the notice on his phone, and a longer step ends Bree's two", async () => {
    await step("1 hour");
    await waitFor("Thorn's Blessed run out", () => (effectsOf(dmSocket, run.thorn).length === 0 ? true : null));
    await pat.getByText("Blessed ended on Thorn.", { exact: true }).first().waitFor();
    assert.equal(effectsOf(dmSocket, run.bree).length, 2, "Bree's are not due yet");
    await shots.take(pat, "tm-2-pat-notice");

    await step("8 hours");
    await waitFor("Bree's two run out", () => (effectsOf(dmSocket, run.bree).length === 0 ? true : null));
    await dm.getByText("Hasted ended on Bree.", { exact: true }).first().waitFor();
    assert.equal(dmSocket.state?.clock?.t, START + 9 * HOUR);
  });

  test("tm-3. in a fight a 1 minute span ends as round 11 starts, and Previous brings it back", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: "e-bree", characterId: run.bree, value: 20 }, { id: "e-thorn", characterId: run.thorn, value: 10 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("Bree acting in round 1", () => (dmSocket.state?.encounter?.activeEntryId === "e-bree" ? true : null));

    const panel = await openCard(dm, run.bree);
    const section = conditions(panel);
    const duration = await startAdd(section, /Blessed/);
    await duration.selectOption({ label: "1 minute" });
    await section.getByText("A length of time ends at the start of the round it reaches. N rounds ends on a creature's turn.", { exact: true }).waitFor();
    await finishAdd(section);
    await section.getByText("Lasts 1 minute, to the start of round 11", { exact: true }).waitFor();

    // Two rows, so each round takes two turns: 18 more reach Bree in round 10, and two more start round 11.
    for (let i = 0; i < 18; i++) await ops.send({ t: "encounter.next" });
    await waitFor("round 10 with Bree acting", () => (dmSocket.state?.encounter?.round === 10 && dmSocket.state.encounter.activeEntryId === "e-bree" ? true : null));
    assert.equal(effectsOf(dmSocket, run.bree).length, 1, "still running in round 10");
    await ops.send({ t: "encounter.next" });
    await ops.send({ t: "encounter.next" });
    await waitFor("round 11 and the span run out", () => (dmSocket.state?.encounter?.round === 11 && effectsOf(dmSocket, run.bree).length === 0 ? true : null));
    await shots.take(dm, "tm-3-round-11");

    await ops.send({ t: "encounter.prev" });
    await ops.send({ t: "encounter.prev" });
    await waitFor("Previous back in round 10 with Blessed", () => (dmSocket.state?.encounter?.round === 10 && effectsOf(dmSocket, run.bree).some((e) => e.key === "blessed") ? true : null));

    // End the fight: its rounds add their seconds to the clock, which reaches the span's end in the same op.
    await ops.send({ t: "encounter.end" });
    await waitFor("the fight over and Blessed gone", () => (dmSocket.state?.encounter == null && effectsOf(dmSocket, run.bree).length === 0 ? true : null));
  });

  test("tm-4. with the clock hidden, Pat's copy holds only the length, his picker lists no span, and sharing gives him the end", async () => {
    await ops.send({ t: "clock.update", shown: false });
    await waitFor("no clock in Pat's copy", () => (patSocket.state?.clock == null ? true : null));

    const panel = await openCard(dm, run.thorn);
    const section = conditions(panel);
    const duration = await startAdd(section, /Blessed/);
    await duration.selectOption({ label: "1 hour" });
    await section.getByText("Players don't see the date and time, but they see how long this lasts and when it ends.", { exact: true }).waitFor();
    const frames = patSocket.received.length;
    await finishAdd(section);
    await waitFor("Pat's copy of the new span", () => (effectsOf(patSocket, run.thorn).some((e) => e.key === "blessed") ? true : null));
    const copy = effectsOf(patSocket, run.thorn).find((e) => e.key === "blessed");
    assert.deepEqual(copy?.ends, { span: HOUR }, "only the length");
    assert.equal(patSocket.received.slice(frames).join("").includes(run.clockId), false, "no frame Pat got names the hidden clock");
    const patPanel = await openCard(pat, run.thorn);
    await conditions(patPanel).getByText("Lasts 1 hour", { exact: true }).waitFor();

    const patSection = conditions(patPanel);
    await patSection.getByRole("button", { name: "Add", exact: true }).click();
    await patSection.getByRole("button", { name: /Hasted/ }).first().click();
    const options = await patSection.getByRole("combobox", { name: "Duration", exact: true }).locator("option").allInnerTexts();
    assert.deepEqual(options, ["No duration", "Start of X's next turn", "End of X's next turn", "N rounds"], "no time span while the clock is hidden");
    await patSection.getByRole("button", { name: "Back", exact: true }).click();

    await ops.send({ t: "clock.update", shown: true });
    await waitFor("the end in Pat's copy", () => (effectsOf(patSocket, run.thorn).find((e) => e.key === "blessed")?.ends?.clock === run.clockId ? true : null));
    await ops.send({ t: "actor.effect.remove", target: { characterId: run.thorn }, effectId: effectsOf(dmSocket, run.thorn)[0]!.id });
  });

  test("tm-5. the table display's Show the date and time is off at first, kept, and goes with a hidden clock", async () => {
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "Add a TV" }).click();
    const code = (await dm.locator('[aria-label^="Display code "]').textContent()) ?? "";
    await dm.getByRole("button", { name: "Done" }).click();
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await waitFor("the display's snapshot", () => tvSocket.state);
    const chip = tv.getByRole("status", { name: /^Time: Day \d+, \d+:\d\d [AP]M, \w+$/ });
    assert.equal(await chip.count(), 0, "off at first");

    const menu = tv.getByRole("menu", { name: "Table display" });
    await tv.mouse.click(TV.width / 2, TV.height / 2);
    await menu.getByRole("menuitemcheckbox", { name: "Show the date and time: off" }).click();
    await menu.getByRole("menuitemcheckbox", { name: "Show the date and time: on" }).waitFor();
    // The menu covers the screen's middle on a 720 px high display, so the tap that closes it lands at a corner.
    await tv.mouse.click(40, 40);
    await menu.waitFor({ state: "detached" });
    await chip.waitFor({ timeout: 5_000 }).catch(async (err) => {
      await shots.take(tv, "tm-5-no-chip");
      const kept = await tv.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("rvtt.display.date"));
      console.error("display clock", JSON.stringify(tvSocket.state?.clock), "kept", kept, "statuses", await tv.getByRole("status").allInnerTexts());
      throw err;
    });
    const text = (await chip.textContent()) ?? "";
    assert.match(text, /^Day 2, \d+:\d\d [AP]M, \w+$/);
    await shots.take(tv, "tm-5-display-chip");

    await tv.reload();
    await chip.waitFor();

    await ops.send({ t: "clock.update", shown: false });
    await chip.waitFor({ state: "detached" });
    await ops.send({ t: "clock.update", shown: true });
    await chip.waitFor();
  });
});
