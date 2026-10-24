import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { Actor, LogEvent, RoomState } from "#shared/model.ts";
import { loadMonsters, monsterActor, type SrdMonster } from "#shared/srd/monsters.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
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
};

const DRAGON = "Adult Red Dragon";
const DRAGON_AT = { x: 13, y: 5 };
const THORN_AT = { x: 5, y: 5 };
const BREATH = "actions:fire-breath";

type View = { width: number; height: number; scale: number };
const DESK: View = { width: 1440, height: 900, scale: 1 };
const PHONE: View = { width: 390, height: 844, scale: 1 };
const SMALL: View = { width: 320, height: 568, scale: 1 };

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
      "the bar's Uses drawer",
      "the folded turn card",
      "the recharge card",
      "the row's Uses group",
      "the turn card",
    ]);
    assert.deepEqual(sweep, [], "out of line by more than 1 px");
  });

  test("cu-b-10. no console errors on any page", () => {
    assert.deepEqual(deskConsole.errors, [], "the desk");
    assert.deepEqual(phoneConsole.errors, [], "the DM's phone");
    assert.deepEqual(patConsole.errors, [], "Pat's page");
  });
});
