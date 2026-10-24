import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { limitedUses } from "#shared/dice/uses.ts";
import type { Actor, LogEvent, RoomState } from "#shared/model.ts";
import { loadMonsters, monsterActor, type SrdMonster } from "#shared/srd/monsters.ts";
import { alignmentLines, measureAlignment, toastsUnderCards } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openPage, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Combat uses (docs/design-v1-combat-controls.md 4 to 6 and 11), on the
 * real server serving the production build. The DM runs the fight from a
 * desk and a phone at once, and Pat plays Thorn on a phone:
 * - On Thorn's turn the DM's phone takes Fiery Rays from the dragon's
 *   tracker row and Pounce from its token bar's Uses drawer, Fiery Rays
 *   greyed until the dragon's next turn, and spends a Legendary
 *   Resistance. Pat's copy holds none of the counts, and his log names the
 *   uses without them.
 * - The desk marks Fire Breath used from its bar, and the phone's row and
 *   chips show it.
 * - The dragon's turn brings the recharge card to both DM devices and the
 *   turn card, open on the desk and folded on the phone. One roll counts,
 *   and a reload shows the same result.
 * - In lair gives the dragon its lair counts and XP.
 * - The troll's turn brings Regeneration with its Fire noted: Apply heals
 *   it, and the next round Skip leaves "Regeneration skipped" with Reopen
 *   on its turn card.
 * - Thorn at 0 HP gets his death save card on Pat's phone and the DM's,
 *   settled once by Pat's roll.
 * - A toast on the DM's phone starts under a lone turn card, folded and
 *   open.
 * - Dragons placed in their lair join with In lair on through the group
 *   bar's Start a fight and Add to the fight and the tracker's own.
 * - The Dice panel's X/Day Use with none left says so on a tap.
 * - Where the SRD's stat blocks did not load, In lair and every join
 *   stay off beside the failure's reload.
 * Every new screen is measured with the alignment check at 1440 x 900,
 * 390 x 844 and 320 x 568, at 100% and 130%.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-eight, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 28;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-combatuses-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let deskContext: BrowserContext;
let phoneContext: BrowserContext;
let patContext: BrowserContext;
let desk: Page;
let phone: Page;
let pat: Page;
let deskCdp: CDPSession;
let phoneCdp: CDPSession;
let patCdp: CDPSession;
let ops: OpSocket;
let srd: readonly SrdMonster[] = [];
const deskSocket = new SocketWatch("desk");
const phoneSocket = new SocketWatch("phone");
const patSocket = new SocketWatch("pat");
const deskConsole = new ConsoleWatch("desk");
const phoneConsole = new ConsoleWatch("phone");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E combat uses ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  patId: "",
  thorn: randomUUID(),
  thornToken: randomUUID(),
  dragon: randomUUID(),
  troll: randomUUID(),
  goblin: randomUUID(),
  lair: [randomUUID(), randomUUID(), randomUUID()],
  dretch: randomUUID(),
};

const DRAGON = "Adult Red Dragon";
const DRAGON_AT = { x: 13, y: 5 };
const THORN_AT = { x: 5, y: 5 };
const BREATH = "actions:fire-breath";

type View = { width: number; height: number; scale: number };
const DESK: View = { width: 1440, height: 900, scale: 1 };
const PHONE: View = { width: 390, height: 844, scale: 1 };
const SMALL: View = { width: 320, height: 568, scale: 1 };
const SIDEWAYS: View = { width: 844, height: 390, scale: 1 };

function plainActor(hp: number, max = hp): Actor {
  return { hp: { cur: hp, max, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function srdActor(id: string, hp?: number): Actor {
  const m = srd.find((x) => x.srdId === id);
  assert.ok(m, `no SRD monster ${id}`);
  const made = monsterActor(m);
  return hp === undefined ? made : { ...made, hp: { ...made.hp, cur: hp } };
}

/** Sets the window and the interface size, then opens the room again. */
async function setUp(page: Page, cdp: CDPSession, view: View): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await openPage(page, `${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** The DM's copy of a token's actor, as the desk's socket holds it. */
function actorOf(state: RoomState | null, tokenId: string): Actor | undefined {
  const token = state?.tokens[tokenId];
  if (!token) return undefined;
  return "inline" in token.actor ? token.actor.inline : state?.characters[token.actor.ref]?.actor;
}
const dragon = () => actorOf(deskSocket.state, run.dragon);
const troll = () => actorOf(deskSocket.state, run.troll);
const thorn = () => deskSocket.state?.characters[run.thorn]?.actor;

/** Moves the turn on until `entryId` acts, as the DM, and waits for both DM devices to see it. */
async function turnTo(entryId: string): Promise<void> {
  for (let i = 0; i < 6 && deskSocket.state?.encounter?.activeEntryId !== entryId; i++) {
    const encounter = deskSocket.state!.encounter!;
    await ops.send({ t: "encounter.next", from: { entry: encounter.activeEntryId, round: encounter.round } });
    await waitFor("the turn moved", () => (deskSocket.state?.encounter?.activeEntryId !== encounter.activeEntryId || deskSocket.state?.encounter?.round !== encounter.round ? true : null));
  }
  assert.equal(deskSocket.state?.encounter?.activeEntryId, entryId);
  await waitFor("the phone sees the turn", () => (phoneSocket.state?.encounter?.activeEntryId === entryId ? true : null));
}

/** Opens the tracker: the side panel's tab from 900 layout px up, else the turn strip's button that opens its sheet. */
async function openTracker(page: Page): Promise<Locator> {
  const tab = page.getByRole("tab", { name: "Initiative" });
  if ((await tab.count()) > 0 && (await tab.first().isVisible())) await tab.first().click();
  else await page.getByRole("button", { name: /^Initiative, round/ }).first().click();
  await page.locator("[data-round-header]").first().waitFor();
  return page.locator("[data-round-section]").first();
}

/** Puts away a phone's open sheets, which would take a tap meant for the map. */
async function closeSheets(page: Page): Promise<void> {
  const open = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true });
  for (let i = 0; i < 3; i++) {
    const n = await open.count();
    if (n === 0) return;
    await open.first().getByRole("button", { name: /^Close / }).first().click();
    await waitFor("a sheet put away", async () => ((await open.count()) < n ? true : null), 5_000);
  }
}

/** A row's options in the tracker, opened, and the Uses group in them. */
async function rowUses(page: Page, name: string): Promise<Locator> {
  const tracker = await openTracker(page);
  const toggle = tracker.getByRole("button", { name: `${name} options` });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const group = tracker.locator("[data-uses-group]").filter({ has: page.getByText("Uses", { exact: true }) }).first();
  await group.waitFor();
  return group;
}

/** The dragon's bar's Uses drawer, opened from a tap on its token. */
async function barUses(page: Page): Promise<Locator> {
  await closeSheets(page);
  await tapCell(page, run.bounds, DRAGON_AT);
  const bar = page.getByRole("dialog", { name: `${DRAGON} actions` });
  await bar.waitFor();
  const uses = bar.getByRole("button", { name: "Uses", exact: true });
  await waitFor("the Uses button ready", async () => ((await uses.isEnabled()) ? true : null));
  if ((await uses.getAttribute("aria-pressed")) !== "true") await uses.click();
  const drawer = bar.locator("[data-uses-drawer]");
  await drawer.waitFor();
  return drawer;
}

/** Closes the token bar, by its own Close, so it leaves the alerts column's lane. */
async function closeBar(page: Page): Promise<void> {
  const bar = page.getByRole("dialog", { name: `${DRAGON} actions` });
  if ((await bar.count()) === 0) return;
  await bar.getByRole("button", { name: "Close", exact: true }).first().click();
  await bar.waitFor({ state: "detached" });
}

/** Taps away the toasts left standing, by their own buttons. */
async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const toast = page.locator("button[data-toast], div[data-toast] > button").filter({ visible: true });
    if ((await toast.count()) === 0) return;
    await toast.first().click({ timeout: 1000 }).catch(() => {});
  }
}

/** The three dragons placed in their lair, each where a tap on its middle cell finds it. */
const LAIR_AT = [
  { x: 1, y: 14 },
  { x: 6, y: 14 },
  { x: 11, y: 14 },
];
const lairName = (i: number) => `Lair Dragon ${i + 1}`;
const lairCell = (i: number) => ({ x: LAIR_AT[i]!.x + 1, y: LAIR_AT[i]!.y + 1 });

/** The DM's rows for the lair dragons: whether each is in the fight, and with In lair on. */
function lairRows(): (boolean | null)[] {
  return run.lair.map((id) => {
    const entry = deskSocket.state?.encounter?.entries.find((e) => e.tokenId === id);
    return entry ? entry.inLair : null;
  });
}

/** Lets go of the desk's selection and its group, so the next tap selects afresh. */
async function deselect(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const none = page.getByRole("button", { name: "Deselect all" }).first();
  if (await none.isVisible()) await none.click();
  const done = page.getByRole("button", { name: "Done", exact: true });
  if (await done.isVisible()) await done.click();
  await page.keyboard.press("Escape");
}

/** The desk's group bar for these lair dragons, selected by Multi-select from none. */
async function groupOf(page: Page, which: readonly number[]): Promise<Locator> {
  await deselect(page);
  await dismissToasts(page);
  await tapCell(page, run.bounds, lairCell(which[0]!));
  const bar = page.getByRole("dialog", { name: `${lairName(which[0]!)} actions` });
  await bar.waitFor();
  await bar.getByRole("button", { name: "Multi-select", exact: true }).click();
  for (const i of which.slice(1)) await tapCell(page, run.bounds, lairCell(i));
  const group = page.getByRole("dialog", { name: `${which.length} selected tokens` });
  await group.waitFor();
  return group;
}

/** A tracker section on a desk by its heading, such as "Add to the fight", with a fight or before one. */
async function trackerSection(page: Page, heading: string): Promise<Locator> {
  const tab = page.getByRole("tab", { name: "Initiative" }).first();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) }).last();
  await section.waitFor();
  return section;
}

/** The alerts column's cards of one kind. */
function alerts(page: Page, kind: string): Locator {
  return page.locator(`[data-alert="${kind}"]`);
}

/** The DM's use lines as one device's log holds them. */
function useLines(state: RoomState | null): Extract<LogEvent, { type: "use" }>[] {
  return (state?.log ?? []).flatMap((e) => (e.data?.type === "use" ? [e.data] : []));
}

/** Each part of the alignment sweep: what it measured, and what was off. */
const sweep: string[] = [];
const measured = new Set<string>();

async function measure(page: Page, root: Locator, screen: string): Promise<void> {
  await root.first().waitFor();
  measured.add(screen.replace(/ at .*$/, ""));
  const lines = alignmentLines(await measureAlignment(root.first()), screen);
  if (lines.length > 0) {
    sweep.push(...lines);
    await shots.take(page, `cu-b-align-${screen.replace(/[^a-z0-9]+/gi, "-")}`);
  }
}

describe("raccoon-vtt: combat uses", { timeout: 900_000 }, () => {
  before(async () => {
    srd = await loadMonsters();
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    deskContext = await browser.newContext({ viewport: DESK });
    phoneContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    desk = await deskContext.newPage();
    phone = await phoneContext.newPage();
    pat = await patContext.newPage();
    deskConsole.attach(desk);
    phoneConsole.attach(phone);
    patConsole.attach(pat);
    await deskSocket.attach(deskContext, desk);
    await phoneSocket.attach(phoneContext, phone);
    await patSocket.attach(patContext, pat);
    deskCdp = await deskContext.newCDPSession(desk);
    phoneCdp = await phoneContext.newCDPSession(phone);
    patCdp = await patContext.newCDPSession(pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [deskConsole, phoneConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    if (run.roomId && deskContext) {
      try {
        const res = await deskContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("cu-b-1. a DM on a desk and a phone, Pat's Thorn, an adult red dragon, a troll that took Fire and a goblin, in a fight", async () => {
    await desk.goto(`${server.origin}/`);
    await desk.getByLabel("Room name").fill(run.roomName);
    await desk.getByLabel("Your name").fill("Dana the DM");
    const password = await desk.getByLabel("Player password").inputValue();
    await desk.getByRole("button", { name: "Create room" }).click();
    await desk.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await desk.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await desk.getByLabel("I saved my DM link").check();
    await desk.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the desk's snapshot", () => deskSocket.state);
    run.sceneId = deskSocket.state!.meta.playerSceneId!;
    run.bounds = deskSocket.state!.scenes[run.sceneId]!.bounds;

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    // The DM's phone is a second device of the same DM.
    await phoneContext.addCookies(await deskContext.cookies(server.origin));
    const cookie = (await deskContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: plainActor(30), level: 5 } });
    await ops.send({
      t: "character.update",
      characterId: run.thorn,
      patch: {
        resources: [
          { id: "rage", name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 },
          { id: "loh", name: "Lay on Hands", max: 25, reset: "long", pool: true },
        ],
      },
    });
    const token = (id: string, extra: Record<string, unknown>) => ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, visibility: "all", ...extra } });
    await token(run.thornToken, { kind: "pc", name: "Thorn", size: "medium", x: THORN_AT.x, y: THORN_AT.y, disposition: "ally", actor: { ref: run.thorn } });
    await token(run.dragon, { kind: "monster", name: DRAGON, size: "huge", x: DRAGON_AT.x - 1, y: DRAGON_AT.y - 1, disposition: "hostile", actor: { inline: srdActor("adult-red-dragon") } });
    await token(run.troll, { kind: "monster", name: "Troll", size: "large", x: 18, y: 9, disposition: "hostile", actor: { inline: srdActor("troll", 60) } });
    await token(run.goblin, { kind: "monster", name: "Goblin", size: "small", x: 22, y: 5, disposition: "hostile", actor: { inline: plainActor(7) } });
    await ops.send({ t: "actor.hp", target: { tokenId: run.troll }, change: { kind: "damage", amount: 10, types: ["fire"] } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: "e-thorn", tokenId: run.thornToken, value: 20 },
        { id: "e-dragon", tokenId: run.dragon, value: 15 },
        { id: "e-troll", tokenId: run.troll, value: 10 },
        { id: "e-goblin", tokenId: run.goblin, value: 5 },
      ],
    });
    await waitFor("the fight", () => deskSocket.state?.encounter);

    for (const [page, watch, socket] of [
      [phone, phoneConsole, phoneSocket],
      [pat, patConsole, patSocket],
    ] as const) {
      watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
      await openPage(page, `${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor(`${watch.label}'s snapshot`, () => socket.state);
      watch.allow = [];
    }
    await turnTo("e-thorn");
    assert.deepEqual(troll()?.hurt, ["fire"], "the troll's Fire is recorded");
  });

  test("cu-b-2. on Thorn's turn the DM's phone takes Fiery Rays from the dragon's row, greyed after, and a Legendary Resistance", async () => {
    const group = await rowUses(phone, DRAGON);
    await group.getByText("Legendary actions 3 of 3", { exact: true }).waitFor();
    await shots.take(phone, "cu-b-row-uses");
    await group.getByRole("button", { name: "Use Fiery Rays, legendary action, 3 left" }).click();
    await group.getByText("Legendary actions 2 of 3", { exact: true }).waitFor();
    await waitFor("Fiery Rays marked until the dragon's turn", () => (dragon()?.uses?.["legendaryActions:fiery-rays"]?.kind === "turn" ? true : null));
    const rays = group.getByRole("button", { name: "Use Fiery Rays, legendary action, 2 left" });
    assert.equal(await rays.getAttribute("aria-disabled"), "true", "greyed until the start of its next turn");
    // Off, it keeps its tap, which says why: Playwright takes aria-disabled for disabled, so the tap is forced.
    await rays.click({ force: true });
    await group.getByRole("status").getByText("Fiery Rays: until the start of its next turn.", { exact: true }).waitFor();
    await group.getByRole("button", { name: "Use Legendary Resistance, 3 left" }).click();
    await group.getByText("Legendary Resistance 2 of 3", { exact: true }).waitFor();
    await waitFor("one Resistance spent", () => (dragon()?.legendary?.resistUsed === 1 ? true : null));
    await shots.take(phone, "cu-b-row-uses-spent");
  });

  test("cu-b-3. the phone's bar takes Pounce from its Uses drawer, and Pat's copy holds no count", async () => {
    const drawer = await barUses(phone);
    await drawer.getByText("Legendary actions 2 of 3", { exact: true }).waitFor();
    await shots.take(phone, "cu-b-bar-drawer");
    await drawer.getByRole("button", { name: "Use Pounce, legendary action, 2 left" }).click();
    await waitFor("Pounce spent", () => (dragon()?.legendary?.actionsUsed === 2 ? true : null));
    await drawer.getByText("Legendary actions 1 of 3", { exact: true }).waitFor();
    // What Pat's copy holds of the dragon: no counts, no marks, no record, and use lines by name alone (8).
    await waitFor("Pat reads the uses", () => (useLines(patSocket.state).length >= 3 ? true : null));
    const seen = actorOf(patSocket.state, run.dragon) as Partial<Actor> | undefined;
    assert.ok(seen);
    for (const field of ["uses", "turnRecord", "hurt", "legendary"] as const) assert.equal(field in seen, false, field);
    for (const line of useLines(patSocket.state)) {
      assert.equal("left" in line || "max" in line || "cost" in line, false, JSON.stringify(line));
    }
    assert.deepEqual(
      useLines(patSocket.state).map((l) => [l.what, l.name ?? null]),
      [
        ["legendary", "Fiery Rays"],
        ["resist", null],
        ["legendary", "Pounce"],
      ],
    );
  });

  test("cu-b-4. the desk marks Fire Breath used from its bar, and the phone's row and chips show it", async () => {
    const drawer = await barUses(desk);
    const breath = drawer.locator("[data-use-row=ability]").filter({ hasText: "Fire Breath, Recharge 5–6" });
    await breath.getByText(", Ready", { exact: true }).waitFor();
    await breath.getByRole("button", { name: "Use Fire Breath" }).click();
    await waitFor("Fire Breath used", () => (dragon()?.uses?.[BREATH]?.kind === "recharge" ? true : null));
    await breath.getByRole("button", { name: "Mark Fire Breath ready" }).waitFor();
    await shots.take(desk, "cu-b-desk-drawer-used");
    await closeBar(desk);
    const group = await rowUses(phone, DRAGON);
    await group.locator("[data-use-row=ability]").filter({ hasText: "Fire Breath, Recharge 5–6" }).getByText(", Used", { exact: true }).waitFor();
    const tracker = phone.locator("[data-round-section]").first();
    await tracker.getByText("Fire Breath used", { exact: true }).first().waitFor();
    await closeSheets(phone);
  });

  test("cu-b-5. the dragon's turn: the recharge card on both DM devices, the turn card open on the desk and folded on the phone, one roll and its result after a reload", async () => {
    await turnTo("e-dragon");
    const deskCard = desk.getByRole("group", { name: `Fire Breath can recharge (5–6). ${DRAGON}` });
    const phoneCard = phone.getByRole("group", { name: `Fire Breath can recharge (5–6). ${DRAGON}` });
    await deskCard.waitFor();
    await phoneCard.waitFor();
    const turn = alerts(desk, "turn");
    await turn.getByText(`${DRAGON}'s turn`, { exact: true }).waitFor();
    await turn.getByText("Legendary actions 3 of 3, after other creatures' turns", { exact: true }).waitFor();
    await turn.getByText("Legendary Resistance 2 of 3", { exact: true }).waitFor();
    await alerts(phone, "turn").getByText(`${DRAGON}'s turn: 3 uses`, { exact: true }).waitFor();
    await shots.take(desk, "cu-b-dragon-turn-desk");
    await shots.take(phone, "cu-b-dragon-turn-phone");
    // On its own turn the dragon takes no legendary action, wherever the DM looks.
    const group = await rowUses(phone, DRAGON);
    const rays = group.getByRole("button", { name: "Use Fiery Rays, legendary action, 3 left" });
    assert.equal(await rays.getAttribute("aria-disabled"), "true");
    await group.getByText("Legendary actions 3 of 3", { exact: true }).waitFor();
    await closeSheets(phone);

    await deskCard.getByRole("button", { name: "Roll", exact: true }).click();
    const settled = await waitFor("the roll settles the prompt", () => dragon()?.turnRecord?.settled?.[`recharge:${BREATH}`]);
    assert.equal(settled.state, "done");
    const result = settled.outcome === "ready" ? `Rolled ${settled.total}: Fire Breath is ready.` : `Rolled ${settled.total}: Fire Breath stays used.`;
    await deskCard.getByRole("status").getByText(result, { exact: true }).waitFor();
    await phoneCard.getByRole("status").getByText(result, { exact: true }).waitFor();
    assert.equal(dragon()?.uses?.[BREATH] === undefined, settled.outcome === "ready", "a roll of 5 or 6 takes the mark");
    // A second roll from the other device is refused: its card shows Done, not Roll.
    assert.equal(await phoneCard.getByRole("button", { name: "Roll", exact: true }).count(), 0);
    await openPage(phone, phone.url());
    await phone.getByRole("status", { name: "Connected" }).first().waitFor();
    await phoneCard.getByRole("status").getByText(result, { exact: true }).waitFor();
    await shots.take(phone, "cu-b-recharge-after-reload");
    await phoneCard.getByRole("button", { name: "Done", exact: true }).click();
    await phoneCard.waitFor({ state: "detached" });
    assert.equal(await deskCard.count(), 1, "Done hides it on this device alone");
  });

  test("cu-b-6. In lair gives the dragon its lair's legendary counts and XP", async () => {
    const tracker = await openTracker(desk);
    const toggle = tracker.getByRole("button", { name: `${DRAGON} options` });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await tracker.getByRole("switch", { name: /^In lair/ }).click();
    await waitFor("the lair's counts", () => (dragon()?.legendary?.actionsMax === 4 && dragon()?.legendary?.resistMax === 4 ? true : null));
    const m = srd.find((x) => x.srdId === "adult-red-dragon")!;
    assert.equal(dragon()?.xp, m.xpInLair);
    assert.equal(dragon()?.legendary?.resistUsed, 1, "what was used stays used");
    await tracker.getByText("Legendary Resistance 3 of 4", { exact: true }).first().waitFor();
    await tracker.getByRole("switch", { name: /^In lair/ }).click();
    await waitFor("back to its counts", () => (dragon()?.legendary?.actionsMax === 3 ? true : null));
    assert.equal(dragon()?.xp, m.xp);
  });

  test("cu-b-7. the troll's turn: Regeneration with its Fire noted, Apply heals it, and the next round Skip leaves Reopen on its turn card", async () => {
    await turnTo("e-troll");
    const card = desk.getByRole("group", { name: "Regeneration for Troll" });
    await card.getByText("Troll regenerates 15 HP.", { exact: true }).waitFor();
    await card.getByText("Recorded Fire damage may stop Regeneration.", { exact: true }).waitFor();
    await card.getByText("Damage typed by hand is not counted.", { exact: true }).waitFor();
    await shots.take(desk, "cu-b-regeneration");
    const before = troll()!.hp.cur;
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await waitFor("the troll healed", () => (troll()!.hp.cur === Math.min(troll()!.hp.max, before + 15) ? true : null));
    await card.getByRole("status").getByText("Regenerated 15 HP.", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Done", exact: true }).click();

    await ops.send({ t: "actor.hp", target: { tokenId: run.troll }, change: { kind: "damage", amount: 20, types: ["acid"] } });
    await turnTo("e-goblin");
    await turnTo("e-troll");
    const again = desk.getByRole("group", { name: "Regeneration for Troll" });
    await again.getByText("Recorded Acid damage may stop Regeneration.", { exact: true }).waitFor();
    await again.getByRole("button", { name: "Skip", exact: true }).click();
    await again.waitFor({ state: "detached" });
    const turn = alerts(desk, "turn");
    await turn.getByText("Regeneration skipped", { exact: true }).waitFor();
    await shots.take(desk, "cu-b-regeneration-skipped");
    await turn.getByRole("button", { name: "Reopen: Regeneration skipped" }).click();
    await desk.getByRole("group", { name: "Regeneration for Troll" }).waitFor();
    await waitFor("Reopen opens it again for every device", () => (troll()!.turnRecord?.settled?.regeneration === undefined ? true : null));
  });

  test("cu-b-8. Thorn at 0 HP: his death save card on Pat's phone and the DM's, settled once by Pat's roll", async () => {
    await ops.send({ t: "actor.hp", target: { characterId: run.thorn }, change: { kind: "damage", amount: 30 } });
    await waitFor("Thorn dying", () => (thorn()?.life === "dying" ? true : null));
    await turnTo("e-thorn");
    const card = pat.getByRole("group", { name: "Death save for Thorn" });
    await card.getByText("Thorn is dying. Death save: 0 successes, 0 failures.", { exact: true }).waitFor();
    await desk.getByRole("group", { name: "Death save for Thorn" }).waitFor();
    await shots.take(pat, "cu-b-death-save");
    await card.getByRole("button", { name: "Roll", exact: true }).click();
    const settled = await waitFor("Pat's roll settles it", () => thorn()?.turnRecord?.settled?.deathSave);
    assert.equal(settled.state, "done");
    await card.getByRole("status").getByText(new RegExp(`^Rolled ${settled.total}: `)).waitFor();
    await desk.getByRole("group", { name: "Death save for Thorn" }).getByRole("status").getByText(new RegExp(`^Rolled ${settled.total}: `)).waitFor();
    await shots.take(pat, "cu-b-death-save-rolled");
    // His turn card holds his class resources: folded on a phone, Show opens it, and Rage is used from it.
    const turn = alerts(pat, "turn");
    await turn.getByText("Thorn's turn: 2 uses", { exact: true }).waitFor();
    await turn.getByRole("button", { name: "Show Thorn's turn" }).click();
    await alerts(pat, "turn").getByRole("button", { name: /^Use Rage, 3 of 3 left/ }).click();
    await waitFor("Rage used", () => (deskSocket.state?.characters[run.thorn]?.resources?.find((r) => r.id === "rage")?.used === 1 ? true : null));
    // Rage's words take a second line where Lay on Hands' fit beside a button, so its rows keep one height only with their buttons on a line of their own (lp20-cc-1).
    await measure(pat, alerts(pat, "turn"), "Thorn's turn card with his class resources at 390 x 844 at 100%");
    await alerts(pat, "turn").getByRole("button", { name: /^Use Lay on Hands/ }).click();
    await alerts(pat, "turn").getByRole("textbox", { name: /^Lay on Hands to spend/ }).waitFor();
    await measure(pat, alerts(pat, "turn"), "Thorn's turn card with a pool's amount field at 390 x 844 at 100%");
    await shots.take(pat, "cu-b-thorn-turn-amount");
    await alerts(pat, "turn").getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("cu-b-9. every new screen in line at each size", async () => {
    // The dragon's turn again, with its breath used, for its cards.
    await ops.send({ t: "actor.use", target: { tokenId: run.dragon }, use: { kind: "ability", key: BREATH, name: "Fire Breath", limit: "recharge", max: 1, min: 5, ifReady: true } });
    await turnTo("e-dragon");
    for (const [page, cdp, view] of [
      [desk, deskCdp, DESK],
      [desk, deskCdp, { ...DESK, scale: 1.3 }],
      [phone, phoneCdp, PHONE],
      [phone, phoneCdp, { ...PHONE, scale: 1.3 }],
      [phone, phoneCdp, SMALL],
      [phone, phoneCdp, { ...SMALL, scale: 1.3 }],
    ] as const) {
      const at = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(page, cdp, view);
      const recharge = page.getByRole("group", { name: `Fire Breath can recharge (5–6). ${DRAGON}` });
      await recharge.waitFor();
      await measure(page, recharge, `the recharge card at ${at}`);
      const turn = alerts(page, "turn");
      await turn.waitFor();
      if ((await turn.getAttribute("data-turn-folded")) !== null) {
        await measure(page, turn, `the folded turn card at ${at}`);
        await turn.getByRole("button", { name: `Show ${DRAGON}'s turn` }).click();
      }
      await measure(page, alerts(page, "turn"), `the turn card at ${at}`);
      await shots.take(page, `cu-b-turn-${view.width}-${Math.round(view.scale * 100)}`);
      // Dismissed on this page alone, so the dragon's token is free for the bar's tap. The next size opens the room again.
      await recharge.getByRole("button", { name: "Dismiss", exact: true }).click();
      await alerts(page, "turn").getByRole("button", { name: `Dismiss ${DRAGON}'s turn` }).click();
      const group = await rowUses(page, DRAGON);
      await measure(page, group, `the row's Uses group at ${at}`);
      await closeSheets(page);
      const drawer = await barUses(page);
      await measure(page, drawer, `the bar's Uses drawer at ${at}`);
      await shots.take(page, `cu-b-drawer-${view.width}-${Math.round(view.scale * 100)}`);
      await closeBar(page);
    }
    assert.deepEqual([...measured].sort(), [
      "Thorn's turn card with a pool's amount field",
      "Thorn's turn card with his class resources",
      "the bar's Uses drawer",
      "the folded turn card",
      "the recharge card",
      "the row's Uses group",
      "the turn card",
    ]);
    assert.deepEqual(sweep, [], "out of line by more than 1 px");
  });

  test("cu-b-10. a toast on the DM's phone at 390 x 844 starts under a lone turn card, folded and open", async () => {
    await setUp(phone, phoneCdp, PHONE);
    // The dragon's turn from cu-b-9: its recharge card put away on this page, the turn card stands alone.
    const recharge = phone.getByRole("group", { name: `Fire Breath can recharge (5–6). ${DRAGON}` });
    await recharge.waitFor();
    await recharge.getByRole("button", { name: "Dismiss", exact: true }).click();
    await recharge.waitFor({ state: "detached" });
    await alerts(phone, "turn").waitFor();
    assert.equal(await phone.locator("[data-alert]").filter({ visible: true }).count(), 1, "the turn card stands alone");
    const patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ") });
    try {
      for (const form of ["folded", "open"] as const) {
        if (form === "open") await alerts(phone, "turn").getByRole("button", { name: `Show ${DRAGON}'s turn` }).click();
        await waitFor(`the turn card ${form}`, async () => (((await alerts(phone, "turn").getAttribute("data-turn-folded")) !== null) === (form === "folded") ? true : null));
        const words = `A whisper over the ${form} turn card.`;
        await patOps.send({ t: "log.whisper", to: [deskSocket.you!.memberId], text: words });
        const toast = phone.locator("[data-toast]").filter({ hasText: words }).filter({ visible: true }).first();
        await toast.waitFor();
        const card = await alerts(phone, "turn").boundingBox();
        const box = await toast.boundingBox();
        assert.ok(card && box && box.y >= card.y + card.height, `the toast starts at ${box?.y}, over the ${form} turn card, whose foot is at ${card ? card.y + card.height : "?"}`);
        assert.ok((await toastsUnderCards(phone)) > 0, `no toast stood under the ${form} turn card`);
        await shots.take(phone, `cu-b-toast-under-turn-${form}`);
        await dismissToasts(phone);
      }
    } finally {
      patOps.close();
    }
  });

  test("cu-b-11. on the DM's phone held sideways, a notice or the time-up line stays whole above the dragon's docked bar and the column's fade, with a turn card or a second notice under it", async () => {
    await setUp(phone, phoneCdp, SIDEWAYS);
    const bar = phone.getByRole("dialog", { name: `${DRAGON} actions` });
    // The dragon's turn brings its turn card. The goblin's brings none, so there two notices stack alone.
    const cases = [
      { lead: "notice", turnOf: "e-dragon", before: "e-thorn" },
      { lead: "timeUp", turnOf: "e-dragon", before: "e-thorn" },
      { lead: "notice", turnOf: "e-goblin", before: "e-troll" },
    ] as const;
    try {
      for (const { lead, turnOf, before } of cases) {
        const what = `${lead} on ${turnOf}`;
        await turnTo(before);
        // Fire Breath ready, so no recharge card comes: the line is the column's first card, and the turn card the only other.
        if (dragon()?.uses?.[BREATH]) {
          await ops.send({ t: "actor.use", target: { tokenId: run.dragon }, use: { kind: "ability", key: BREATH, name: "Fire Breath", limit: "recharge", max: 1, min: 5 }, back: true });
          await waitFor("Fire Breath ready", () => (dragon()?.uses?.[BREATH] === undefined ? true : null));
        }
        // Effects that end as the turn starts give the DM a notice each. A 4 s turn timer gives the time-up line 4 s into the turn.
        const ending = turnOf === "e-goblin" ? (["blessed", "hasted"] as const) : (["blessed"] as const);
        if (lead === "notice") for (const key of ending) await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblin }, effect: { id: randomUUID(), key, duration: { mode: "turnStart", of: { entryId: turnOf } } } });
        else await ops.send({ t: "room.update", settings: { turnTimerSec: 4 } });
        // The bar opens before the turn, since a notice lasts only 6 s.
        await closeSheets(phone);
        await tapCell(phone, run.bounds, DRAGON_AT);
        await bar.waitFor();
        await turnTo(turnOf);
        const line = alerts(phone, lead).first();
        await line.waitFor({ timeout: 15_000 });
        const next = turnOf === "e-goblin" ? alerts(phone, "notice").nth(1) : alerts(phone, "turn");
        await next.waitFor({ state: "attached" });
        if (turnOf === "e-goblin") assert.equal(await alerts(phone, "turn").count(), 0, "the goblin's turn brought a turn card");
        // The column takes the bar's place once both are drawn.
        await phone.waitForTimeout(400);
        const box = await line.boundingBox();
        const after = await next.boundingBox();
        const barBox = await bar.boundingBox();
        // How much of the line its column's scroll box cuts off, and where the column's "Scroll for more" fade stands, if it shows.
        const { cut, fade } = await line.evaluate((node) => {
          type Rect = { top: number; bottom: number };
          type El = { getBoundingClientRect(): Rect; parentElement: El | null; querySelectorAll(s: string): ArrayLike<El & { textContent: string | null; childElementCount: number }> };
          const style = (n: El) => (globalThis as unknown as { getComputedStyle(n: El): { overflowY: string } }).getComputedStyle(n);
          const el = node as unknown as El;
          const full = el.getBoundingClientRect().bottom;
          let bottom = full;
          let scroller: El | null = null;
          for (let n = el.parentElement; n; n = n.parentElement) {
            if (style(n).overflowY === "visible") continue;
            scroller ??= n;
            bottom = Math.min(bottom, n.getBoundingClientRect().bottom);
          }
          const label = scroller ? Array.from(scroller.querySelectorAll("div")).find((d) => d.childElementCount === 0 && d.textContent?.trim() === "Scroll for more") : undefined;
          const rect = label?.getBoundingClientRect();
          return { cut: full - bottom, fade: rect ? { top: rect.top, bottom: rect.bottom } : null };
        });
        assert.ok(box && after && barBox, `${what}: no box for the line, the card after it or the bar`);
        const foot = box.y + box.height;
        console.log(`${what}: the line ${box.y}-${foot}, the card after it from ${after.y}, the bar from ${barBox.y}, the fade ${fade ? `${fade.top}-${fade.bottom}` : "not shown"}`);
        assert.ok(barBox.x < box.x + box.width && barBox.x + barBox.width > box.x, `${what}: the bar at ${JSON.stringify(barBox)} is not docked across the column`);
        assert.ok(cut <= 1, `${what}: the column cuts ${cut} px off the line`);
        assert.ok(foot <= barBox.y, `${what}: the line's foot at ${foot} is under the bar's top at ${barBox.y}`);
        // The fade's whole box at or below the line's foot, so it covers none of its words or its Dismiss (review CCB-ASTRA-08).
        assert.ok(fade === null || fade.top >= foot - 0.5, `${what}: the column's fade at ${fade?.top}-${fade?.bottom} lies over the line, whose foot is at ${foot}`);
        assert.ok(box.y < after.y, `${what}: the line at ${box.y} is not drawn above the card after it at ${after.y}`);
        await measure(phone, line, `${lead} above ${turnOf === "e-goblin" ? "a second notice" : "the turn card"} at 844x390`);
        await shots.take(phone, `cu-b-${lead}-${turnOf}-sideways`);
        await closeBar(phone);
        if (lead === "timeUp") await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
      }
    } finally {
      await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
    }
    assert.deepEqual(sweep, [], "out of line by more than 1 px");
  });

  test("cu-b-12. dragons placed in their lair join with In lair on through the group bar's Start a fight and Add to the fight, and the tracker's", async () => {
    const m = srd.find((x) => x.srdId === "adult-red-dragon")!;
    const placed: Actor = { ...srdActor("adult-red-dragon"), legendary: { actionsMax: 4, actionsUsed: 0, resistMax: 4, resistUsed: 0 }, xp: m.xpInLair! };
    for (const [i, id] of run.lair.entries()) {
      await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, visibility: "all", kind: "monster", name: lairName(i), size: "huge", ...LAIR_AT[i]!, disposition: "hostile", actor: { inline: placed } } });
    }
    await ops.send({ t: "encounter.end" });
    await waitFor("no fight", () => (deskSocket.state?.encounter ? null : true));
    await setUp(desk, deskCdp, DESK);

    // The group bar starts a fight with two of them.
    let group = await groupOf(desk, [0, 1]);
    await group.getByRole("button", { name: "Start a fight", exact: true }).click();
    await waitFor("the group bar's start", () => (lairRows().join() === "true,true," ? true : null));
    // The tracker adds the third, selected.
    await deselect(desk);
    await tapCell(desk, run.bounds, lairCell(2));
    await desk.getByRole("dialog", { name: `${lairName(2)} actions` }).waitFor();
    await (await trackerSection(desk, "Add to the fight")).getByRole("button", { name: lairName(2), exact: true }).click();
    await waitFor("the tracker's add", () => (lairRows().join() === "true,true,true" ? true : null));
    await shots.take(desk, "cu-b-lair-joins");

    // Again the other way round: the tracker starts it, and the group bar adds.
    await ops.send({ t: "encounter.end" });
    await waitFor("no fight", () => (deskSocket.state?.encounter ? null : true));
    await deselect(desk);
    await tapCell(desk, run.bounds, lairCell(2));
    await desk.getByRole("dialog", { name: `${lairName(2)} actions` }).waitFor();
    await (await trackerSection(desk, "Start a fight with")).getByRole("button", { name: lairName(2), exact: true }).click();
    await waitFor("the tracker's start", () => (lairRows().join() === ",,true" ? true : null));
    group = await groupOf(desk, [0, 1]);
    await group.getByRole("button", { name: "Add to the fight", exact: true }).click();
    await waitFor("the group bar's add", () => (lairRows().join() === "true,true,true" ? true : null));
    await deselect(desk);
  });

  test("cu-b-13. the Dice panel's X/Day Use with none left says so on a tap, and sends nothing", async () => {
    const m = srd.find((x) => x.srdId === "dretch")!;
    const cloud = limitedUses(m).find((u) => u.kind === "day")!;
    assert.ok(cloud.kind === "day");
    await ops.send({ t: "token.create", token: { id: run.dretch, sceneId: run.sceneId, visibility: "all", kind: "monster", name: "Dretch", size: "small", x: 24, y: 14, disposition: "hostile", actor: { inline: srdActor("dretch") } } });
    for (let i = 0; i < cloud.max; i++) await ops.send({ t: "actor.use", target: { tokenId: run.dretch }, use: { kind: "ability", key: cloud.key, name: cloud.name, limit: "day", max: cloud.max } });
    await waitFor("its uses spent", () => (actorOf(deskSocket.state, run.dretch)?.uses?.[cloud.key]?.used === cloud.max ? true : null));
    await deselect(desk);
    await tapCell(desk, run.bounds, { x: 24, y: 14 });
    const bar = desk.getByRole("dialog", { name: "Dretch actions" });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Roll", exact: true }).click();
    const use = desk.getByRole("button", { name: `Use ${cloud.name}, 0 of ${cloud.max} left` });
    await use.waitFor();
    assert.equal(await use.getAttribute("aria-disabled"), "true");
    const seq = deskSocket.state?.log.length;
    // A real tap, which a chip that is only aria-disabled still takes.
    await use.click({ force: true });
    await desk.getByRole("status").filter({ hasText: "No uses left" }).filter({ visible: true }).first().waitFor();
    await shots.take(desk, "cu-b-day-none-left");
    assert.equal(deskSocket.state?.log.length, seq, "nothing was sent");
    assert.equal(actorOf(deskSocket.state, run.dretch)?.uses?.[cloud.key]?.used, cloud.max);
    await deselect(desk);
  });

  test("cu-b-14. where the SRD's stat blocks did not load, In lair and every join stay off beside the failure's reload", async () => {
    // A third lair dragon out of the fight, for the joins.
    await ops.send({ t: "encounter.remove", entryIds: deskSocket.state!.encounter!.entries.filter((e) => e.tokenId === run.lair[2]).map((e) => e.id) });
    await waitFor("the third out of the fight", () => (lairRows()[2] === null ? true : null));
    const context = await browser.newContext({ viewport: DESK });
    try {
      await context.addCookies(await deskContext.cookies(server.origin));
      const page = await context.newPage();
      await page.route(/\/assets\/monsters-[^/]*\.js$/, (route) => route.abort());
      await openPage(page, `${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await page.locator(".konvajs-content").first().waitFor();
      const before = JSON.stringify(deskSocket.state?.encounter?.entries);

      const tracker = await openTracker(page);
      const toggle = tracker.getByRole("button", { name: `${lairName(0)} options` });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const lair = tracker.getByRole("switch", { name: /^In lair/ });
      await page.getByText("Its stat block did not load. Reload to try again.", { exact: true }).first().waitFor();
      assert.ok(await lair.isDisabled(), "In lair is off while the block is unread");
      const add = await trackerSection(page, "Add to the fight");
      await add.getByText("The stat blocks did not load. Reload to try again.", { exact: true }).waitFor();
      assert.ok(await add.getByRole("button", { name: /^Everyone here/ }).isDisabled(), "the tracker's join is off");
      // What this changed in the row's options and the tracker's adds: the switch off, and the failure's line with its reload.
      await measure(page, lair, "In lair off with its block not loaded at 1440 x 900 at 100%");
      await measure(page, tracker.getByRole("alert").filter({ hasText: "Its stat block did not load" }), "In lair's failure line at 1440 x 900 at 100%");
      await measure(page, add.getByRole("alert"), "the tracker's join failure line at 1440 x 900 at 100%");
      await shots.take(page, "cu-b-srd-failed-tracker");

      // The third dragon and Thorn, both out of the fight, on the map's left, clear of a bar docked at its right.
      await tapCell(page, run.bounds, lairCell(2));
      const bar = page.getByRole("dialog", { name: `${lairName(2)} actions` });
      await bar.waitFor();
      await bar.getByRole("button", { name: "Multi-select", exact: true }).click();
      await tapCell(page, run.bounds, THORN_AT);
      const group = page.getByRole("dialog", { name: "2 selected tokens" });
      await group.waitFor();
      await group.getByText("The stat blocks did not load. Reload to try again.", { exact: true }).waitFor();
      assert.ok(await group.getByRole("button", { name: "Add to the fight", exact: true }).isDisabled(), "the group bar's join is off");
      await measure(page, group, "the group bar with its blocks not loaded at 1440 x 900 at 100%");
      assert.deepEqual(sweep, [], "out of line by more than 1 px");
      await shots.take(page, "cu-b-srd-failed-group");
      assert.equal(JSON.stringify(deskSocket.state?.encounter?.entries), before, "nothing joined and no In lair changed");
    } finally {
      await context.close();
    }
  });

  test("cu-b-15. no console errors on any page", () => {
    assert.deepEqual(deskConsole.errors, [], "the desk");
    assert.deepEqual(phoneConsole.errors, [], "the DM's phone");
    assert.deepEqual(patConsole.errors, [], "Pat's page");
  });
});
