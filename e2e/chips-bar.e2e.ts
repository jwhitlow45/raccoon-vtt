import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import { ConsoleWatch, OpSocket, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { addSound } from "./soundRoom.ts";

/**
 * The top bar's give-way and Next (designs/qol/chips.md 5 and 10, qc-11
 * and qc-14 to qc-16, plan.md 4 and 9), on the real server serving the
 * production build with ROOM_SOUND on. The room has the worst case's long
 * name, "The Sunless Citadel and the Gulthias Tree". Dana the DM is at a
 * desk. Pat plays Thorn on a touch screen whose size each step sets. The
 * fight is Belak the Outcast, Twig Blight Druid, Thorn and five goblins.
 * - qcb-0: the room, Pat, the fight's tokens, a music track and two map
 *   pictures.
 * - qc-11: at 1440 the turn chip shows five next faces and Next, which
 *   sends one encounter.next a press and stays busy until the answer, and
 *   the same on the band at 390 x 844.
 * - qc-14: a fight in a blackout on a scene with phases at 1440 takes the
 *   faces to three and the clock off the bar, and both ending gives every
 *   part back.
 * - qc-15: 1440 to 900 and back gives every part back.
 * - qc-16: the worst case at 900 x 900 and at 1170 x 900 at 130%, for the
 *   DM (the name gone with its tooltip, the short overrun timer, Search's
 *   icon, Now playing in the DM menu) and for Pat on his turn ("Your turn"
 *   dropped while End turn shows, the notice still announced).
 * - qc-16b: Pat's short landscape phone at 740 x 360 at 130% gives the
 *   band back to the bar as his turn ends.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-eight, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 58;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-chips-bar-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The worst case's two sizes (chips.md 5): each gives a 540 layout px bar beside the side panel. */
const WORST = [
  { size: { width: 900, height: 900 }, scale: 1, at: "900x900" },
  { size: { width: 1170, height: 900 }, scale: 1.3, at: "1170x900-130" },
] as const;
const BELAK = "Belak the Outcast, Twig Blight Druid";

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

const run = {
  roomId: "",
  roomName: "The Sunless Citadel and the Gulthias Tree",
  password: "",
  sceneId: "",
  patId: "",
  thornChar: randomUUID(),
  playlist: randomUUID(),
  track: randomUUID(),
  phases: [randomUUID(), randomUUID()] as const,
  maps: [] as { id: string; width: number; height: number }[],
  /** The fight in its order: Belak, Thorn, then five goblins. */
  fight: [] as { token: string; entry: string; name: string; value: number }[],
};

/** The DM page's room socket, routed so a step can hold back what the page sends. `out` keeps every frame the page tried to send. */
const wire: { out: string[]; hold: ((frame: string) => boolean) | null; held: (() => void)[] } = { out: [], hold: null, held: [] };

async function routeDmSocket(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\?room=/, (socket: WebSocketRoute) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = String(message);
      wire.out.push(frame);
      if (wire.hold?.(frame)) wire.held.push(() => upstream.send(frame));
      else upstream.send(frame);
    });
  });
}

function release(): void {
  wire.hold = null;
  for (const send of wire.held.splice(0)) send();
}

function sentCount(from: number, t: string): number {
  return wire.out.slice(from).filter((frame) => frame.includes(`"op":{"t":"${t}"`)).length;
}

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function picture(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 500, height: 400, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

function cookieOf(context: BrowserContext): Promise<string> {
  return context.cookies(server.origin).then((list) => list.map((c) => `${c.name}=${c.value}`).join("; "));
}

function topBar(page: Page): Locator {
  return page.locator("header[data-rvtt-topbar]").first();
}

/** What the bar's row holds that its give-way moves, each as a word: a chip and its form, Search's form, the Phase menu, Full screen, View, the turn chip's faces, its name and its timer. */
type BarParts = { parts: string[]; overflow: number };

/** What the page functions below read of the DOM: the e2e files compile without the DOM's types. */
type DomNode = {
  children: ArrayLike<DomNode>;
  textContent: string | null;
  lastElementChild: DomNode | null;
  scrollWidth: number;
  clientWidth: number;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  getBoundingClientRect(): { width: number; height: number };
};

/** The bar's row as its own check counts it: the last button tucks into the bar's padding by a negative margin, which is room the row has. */
function barParts(page: Page): Promise<BarParts> {
  return topBar(page).evaluate((found) => {
    const header = found as unknown as DomNode;
    const row = header.querySelector(":scope > div");
    if (!row) return { parts: ["no row"], overflow: 0 };
    const parts: string[] = [];
    for (const chip of Array.from(row.querySelectorAll("[data-chip]"))) {
      const form = chip.getAttribute("data-chip-form");
      parts.push(`chip:${chip.getAttribute("data-chip")}${form ? `:${form}` : ""}`);
    }
    const search = row.querySelector('[data-search-open="bar"]');
    if (search) parts.push(`search:${search.getAttribute("data-search-form")}`);
    if (row.querySelector('[aria-label="Map phase"]')) parts.push("phase");
    if (row.querySelector('[aria-label="Full screen"]')) parts.push("fullscreen");
    if (row.querySelector('[aria-label^="View: "]')) parts.push("view");
    const faces = row.querySelector("[data-turn-faces]");
    if (row.querySelector('[aria-label^="Initiative, round"]')) parts.push(`faces:${faces ? faces.children.length : 0}`);
    if (row.querySelector("[data-rvtt-strip-name]")) parts.push("turn-name");
    const timer = row.querySelector('[role="timer"]');
    if (timer) parts.push(`timer:${/^\+\d+:\d\d$/.test((timer.textContent ?? "").trim()) ? "short" : "long"}`);
    const view = globalThis as unknown as { getComputedStyle(el: unknown): { marginRight: string } };
    const last = row.lastElementChild;
    const tuck = last ? Math.max(0, -parseFloat(view.getComputedStyle(last).marginRight) || 0) : 0;
    return { parts, overflow: row.scrollWidth - row.clientWidth - tuck };
  });
}

/** Waits for the row to settle: the same parts on two reads 300 ms apart. */
async function settledParts(page: Page): Promise<BarParts> {
  let last = await barParts(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const now = await barParts(page);
    if (now.parts.join(" ") === last.parts.join(" ")) return now;
    last = now;
  }
  return last;
}

async function openAt(page: Page, size: { width: number; height: number }, scale: number): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate((n) => localStorage.setItem("rvtt.uiScale", String(n)), scale);
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

async function startFight(): Promise<void> {
  await ops.send({ t: "encounter.end" }).catch(() => undefined);
  await ops.send({ t: "encounter.start", entries: run.fight.map((f) => ({ id: f.entry, tokenId: f.token, value: f.value })) });
  await ops.send({ t: "encounter.next" });
  await waitFor("Belak's turn", () => (dmSocket.state?.encounter?.activeEntryId === run.fight[0]!.entry ? true : null));
}

async function endFight(): Promise<void> {
  await ops.send({ t: "encounter.end" }).catch(() => undefined);
  await waitFor("no fight", () => (dmSocket.state?.encounter ? null : true));
}

async function blackout(on: boolean): Promise<void> {
  if (dmSocket.state?.meta.view.blackout !== on) await ops.send({ t: "view.blackout", blackout: on });
  await waitFor(`the blackout ${on ? "on" : "off"}`, () => (dmSocket.state?.meta.view.blackout === on ? true : null));
}

async function phases(on: boolean): Promise<void> {
  if (on) {
    const [day, night] = run.maps as [(typeof run.maps)[0], (typeof run.maps)[0]];
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: 25, originPx: { x: 0, y: 0 } } });
    await ops.send({
      t: "scene.update",
      sceneId: run.sceneId,
      patch: {
        phases: [
          { id: run.phases[0], name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
          { id: run.phases[1], name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height },
        ],
      },
    });
    await waitFor("two phases", () => (dmSocket.state?.scenes[run.sceneId]?.phases?.length === 2 ? true : null));
  } else {
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: null });
    await waitFor("no phases", () => (dmSocket.state?.scenes[run.sceneId]?.phases ? null : true));
  }
}

/** Waits until the parts hold every word of `want`, and none of `not`. */
async function partsHold(page: Page, want: readonly string[], not: readonly string[], what: string): Promise<BarParts> {
  let last: BarParts = { parts: [], overflow: 0 };
  try {
    return await waitFor(
      what,
      async () => {
        last = await barParts(page);
        return want.every((w) => last.parts.includes(w)) && !not.some((n) => last.parts.includes(n)) ? last : null;
      },
      10_000,
    );
  } catch {
    throw new Error(`${what}: the bar holds ${last.parts.join(", ")}`);
  }
}

describe("The top bar's give-way and Next", { concurrency: false }, () => {
  before(async () => {
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await routeDmSocket(dm);
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

  test("qcb-0. the worst case's room, Pat's Thorn, Belak and five goblins on the map, a music track and two map pictures", async () => {
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
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const names = [BELAK, "Thorn", "Goblin 1", "Goblin 2", "Goblin 3", "Goblin 4", "Goblin 5"];
    for (const [i, name] of names.entries()) {
      const token = randomUUID();
      const pc = name === "Thorn";
      await ops.send({ t: "token.create", token: { id: token, sceneId: run.sceneId, size: "medium", visibility: "all", kind: pc ? "pc" : "monster", name, x: 3 + i, y: 4, disposition: pc ? "ally" : "hostile", actor: pc ? { ref: run.thornChar } : { inline: actor(20) } } });
      run.fight.push({ token, entry: randomUUID(), name, value: 20 - i });
    }
    await addSound({ context: dmContext, origin: server.origin, roomId: run.roomId, ops, id: run.track, name: "Tavern at night", use: "music", ms: 120_000 });
    await ops.send({ t: "playlist.create", id: run.playlist, name: "Tavern night", sounds: [run.track], repeat: "all", fade: 5 });
    for (const rgb of [[150, 140, 120], [40, 50, 90]] as [number, number, number][]) {
      const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await picture(rgb) });
      assert.ok(res.ok(), `the upload answered ${res.status()}`);
      run.maps.push((await res.json()) as { id: string; width: number; height: number });
    }
    await waitFor("the tokens in the DM's copy", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 7 ? true : null));

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("qc-11. Next on the DM's turn chip at 1440, beside five next faces, and on the band at 390: one encounter.next a press, busy until the server answers", async (t) => {
    t.after(async () => {
      release();
      await dm.setViewportSize(DESK);
    });
    await startFight();
    const fit = await partsHold(dm, ["faces:5", "turn-name"], [], "five faces at 1440");
    assert.ok(fit.overflow <= 1, `the row overflows by ${fit.overflow} px`);
    await shots.take(dm, "qc-11-turn-chip-1440");
    for (const at of ["1440", "390"] as const) {
      if (at === "390") {
        await dm.setViewportSize(PHONE);
        // Below 900 px the turn strip is the band under the bar.
        await waitFor("the band", async () => ((await topBar(dm).locator(":scope > div").first().getByRole("button", { name: /^Initiative, round/ }).count()) === 0 ? true : null));
      }
      const next = topBar(dm).getByRole("button", { name: "Next turn", exact: true });
      await next.waitFor();
      assert.equal(await next.getAttribute("title"), "Next turn (N)");
      const before = dmSocket.state!.encounter!.activeEntryId;
      const order = run.fight.map((f) => f.entry);
      const from = wire.out.length;
      wire.hold = (frame) => frame.includes('"encounter.next"');
      await next.click();
      await waitFor("Next busy", async () => ((await next.getAttribute("aria-busy")) === "true" ? true : null), 5_000);
      await next.click({ force: true });
      await dm.waitForTimeout(300);
      assert.equal(sentCount(from, "encounter.next"), 1, `${at}: a second press sent nothing`);
      release();
      const want = order[(order.indexOf(before ?? "") + 1) % order.length];
      await waitFor(`${at}: the turn moved once`, () => (dmSocket.state?.encounter?.activeEntryId === want ? true : null));
      await waitFor(`${at}: Next no longer busy`, async () => ((await next.getAttribute("aria-busy")) === null ? true : null), 5_000);
      await dm.waitForTimeout(300);
      assert.equal(dmSocket.state?.encounter?.activeEntryId, want, `${at}: one turn, not two`);
    }
    await shots.take(dm, "qc-11-band-390");
    await endFight();
  });

  test("qc-14. a fight in a blackout on a scene with phases at 1440 takes three faces and the clock off the bar, and as both end every part comes back", async (t) => {
    t.after(async () => {
      await endFight();
      await blackout(false);
    });
    await phases(true);
    await ops.send({ t: "clock.start", id: randomUUID(), at: 4 * 86_400 + 20 * 3_600, shown: true, calendar: { kind: "days" } });
    const rest = await partsHold(dm, ["chip:dm", "chip:clock", "search:field", "phase", "fullscreen"], [], "the bar at rest at 1440");
    assert.ok(rest.overflow <= 1, `the row overflows at rest by ${rest.overflow} px`);
    await startFight();
    await blackout(true);
    // Past step 2 too with this room's long name: the blackout folds into the DM chip's place as the crossed eye.
    const busy = await partsHold(dm, ["faces:3", "search:icon", "chip:dm:eye"], ["chip:clock", "faces:5", "chip:blackout"], "the steps in a fight in a blackout");
    assert.ok(busy.overflow <= 1, `the row overflows in the fight by ${busy.overflow} px`);
    await shots.take(dm, "qc-14-fight-blackout-1440");
    // The clock that left the bar is in the DM menu.
    await topBar(dm).locator('[data-chip="dm"]').click();
    await dm.locator('[data-chip-menu="dm"] [data-chip-item="time"]').waitFor();
    await dm.keyboard.press("Escape");
    await endFight();
    await blackout(false);
    const back = await partsHold(dm, rest.parts, ["chip:blackout"], "every part back after the fight and the blackout");
    assert.deepEqual(back.parts, rest.parts);
  });

  test("qc-15. from 1440 to 900 x 900 the bar gives way, and back at 1440 every part comes back", async () => {
    const rest = await settledParts(dm);
    assert.ok(rest.parts.includes("chip:clock") && rest.parts.includes("search:field"), `at rest: ${rest.parts.join(", ")}`);
    await dm.setViewportSize({ width: 900, height: 900 });
    const narrow = await partsHold(dm, ["search:icon"], ["chip:clock"], "the bar at 900");
    assert.ok(narrow.overflow <= 1, `the row overflows at 900 by ${narrow.overflow} px`);
    await dm.setViewportSize(DESK);
    const back = await partsHold(dm, rest.parts, [], "every part back at 1440");
    assert.deepEqual(back.parts, rest.parts);
  });

  test("qc-16. the DM's worst case at 900 x 900 and 1170 x 900 at 130%: Belak's name leaves with its tooltip kept, the overrun timer is short, Search is its icon and Now playing is in the DM menu, and nothing overflows", async (t) => {
    t.after(async () => {
      await openAt(dm, DESK, 1);
      await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
    });
    await ops.send({ t: "music.play", run: randomUUID(), playlistId: run.playlist, order: [run.track], index: 0, repeat: "all", fade: 5 });
    await topBar(dm).locator('[data-chip="nowPlaying"]').first().waitFor();
    await ops.send({ t: "room.update", settings: { turnTimerSec: 2 } });
    await startFight();
    await blackout(true);
    for (const w of WORST) {
      await openAt(dm, w.size, w.scale);
      await dm.waitForTimeout(2_500);
      const fit = await partsHold(dm, ["chip:dm:eye", "search:icon", "timer:short"], ["turn-name", "chip:nowPlaying:full", "chip:nowPlaying:compact", "chip:clock", "phase", "fullscreen"], `${w.at}: the worst case's steps`);
      assert.ok(fit.overflow <= 1, `${w.at}: the row overflows by ${fit.overflow} px (${fit.parts.join(", ")})`);
      await shots.take(dm, `qc-16-dm-${w.at}`);
      // The name that left shows whole on hover, and the tracker's button keeps it for a reader.
      const target = topBar(dm).getByRole("button", { name: /^Initiative, round/ });
      assert.match((await target.getAttribute("aria-label")) ?? "", new RegExp(BELAK));
      await target.hover();
      await waitFor(`${w.at}: the name's tooltip`, async () => ((await dm.getByRole("tooltip").filter({ hasText: BELAK }).count()) > 0 ? true : null), 5_000);
      await dm.mouse.move(5, 500);
      // What gave way is in the DM menu, Now playing with it.
      await topBar(dm).locator('[data-chip="dm"]').click();
      const menu = dm.locator('[data-chip-menu="dm"]');
      await menu.locator('[data-chip-item="nowPlaying"]').waitFor();
      await menu.locator('[data-chip-item="time"]').waitFor();
      await menu.locator('[data-chip-item="endBlackout"]').waitFor();
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    }
    await blackout(false);
    await ops.send({ t: "music.stop" }).catch(() => undefined);
  });

  test("qc-16. Pat's worst case on his own turn at 900 x 900 and 1170 x 900 at 130%: the name leaves, the overrun timer is short, Your turn drops while End turn shows, and the turn is still announced", async (t) => {
    t.after(async () => {
      await openAt(pat, PHONE, 1);
      await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
    });
    await ops.send({ t: "room.update", settings: { turnTimerSec: 2 } });
    for (const w of WORST) {
      await startFight();
      await openAt(pat, w.size, w.scale);
      await pat.waitForTimeout(500);
      // Thorn's turn arrives on the cramped bar: the flare's live region is there, unseen.
      await ops.send({ t: "encounter.next" });
      const bar = topBar(pat);
      const notice = bar.getByRole("status").filter({ hasText: "Your turn" });
      await notice.waitFor({ state: "attached", timeout: 3_000 });
      assert.equal(await notice.getAttribute("aria-live"), "assertive");
      await pat.waitForTimeout(2_500);
      const fit = await partsHold(pat, ["search:icon", "timer:short"], ["turn-name"], `${w.at}: Pat's worst case`);
      assert.ok(fit.parts.some((part) => part.startsWith("chip:you")), `${w.at}: Pat's chip stays (${fit.parts.join(", ")})`);
      assert.ok(fit.overflow <= 1, `${w.at}: Pat's row overflows by ${fit.overflow} px (${fit.parts.join(", ")})`);
      const end = bar.getByRole("button", { name: "End turn", exact: true });
      assert.equal(await end.isVisible(), true, `${w.at}: End turn shows`);
      const shown = await bar.getByText("Your turn", { exact: true }).evaluateAll((els) => els.map((el) => (el as unknown as DomNode).getBoundingClientRect().width));
      // Visually hidden is one layout px, so 1.3 screen px at 130%.
      assert.ok(shown.length > 0 && shown.every((wide) => wide <= w.scale + 0.01), `${w.at}: Your turn shows ${shown.join(", ")} px wide`);
      await shots.take(pat, `qc-16-pat-${w.at}`);
    }
    await endFight();
  });

  test("qc-16b. on Pat's short landscape phone at 740 x 360 at 130% his turn takes the turn strip to the band, and it comes back to the bar on Goblin 1's turn after his", async (t) => {
    t.after(async () => {
      await endFight();
      await openAt(pat, PHONE, 1);
    });
    const inRow = async () => (await topBar(pat).locator(":scope > div").first().getByRole("button", { name: /^Initiative, round/ }).count()) === 1;
    await startFight();
    await openAt(pat, { width: 740, height: 360 }, 1.3);
    // Your turn and End turn leave the bar short of room on Pat's own turn, so the strip takes the band.
    await ops.send({ t: "encounter.next" });
    await topBar(pat).getByRole("button", { name: "End turn", exact: true }).first().waitFor();
    await waitFor("the strip in the band on Pat's turn", async () => ((await inRow()) ? null : true), 5_000);
    await shots.take(pat, "qc-16b-band-on-his-turn-740x360-130");
    await ops.send({ t: "encounter.next" });
    await waitFor("Goblin 1's turn", () => (dmSocket.state?.encounter?.activeEntryId === run.fight[2]!.entry ? true : null));
    await waitFor("the strip back in the bar", async () => ((await inRow()) ? true : null), 5_000);
    const fit = await settledParts(pat);
    assert.ok(fit.overflow <= 1, `the row overflows by ${fit.overflow} px`);
    await shots.take(pat, "qc-16b-bar-after-his-turn-740x360-130");
  });

  test("qcb-end. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(patConsole.errors, []);
  });
});
