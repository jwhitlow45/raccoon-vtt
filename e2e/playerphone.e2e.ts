import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * A player on a phone after the visual design pass, from the live play
 * review of that pass (LPD-PLAYER), on the real server serving the
 * production build:
 *
 * - The Log fits a narrow phone at a large interface size: Send, Export,
 *   the recipient picker and the times stay on screen (LPD-PLAYER-3).
 * - On the player's own turn with the turn timer over, the phone's turn
 *   band keeps End Turn on screen and the name and "Your turn" clear of
 *   the timer, at 130% on 390 and 360 px phones (LPD-PLAYER-4).
 * - A total typed into a roll card, and the choice picked in it, survive
 *   turning the phone between portrait and landscape, which moves the card
 *   between the screen's foot and the alerts column (LPD-PLAYER-1). Focus
 *   stays in the Total field being typed in.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-playerphone-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const CARD = "The DM asks for a roll";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let playerContext: BrowserContext;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E player phone ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  thorn: { id: randomUUID(), characterId: randomUUID(), entryId: randomUUID() },
  goblin: { id: randomUUID(), entryId: randomUUID() },
};

/** A box as the page measured it, in CSS pixels. */
type Box = { left: number; right: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = { tagName: string; textContent: string | null; getAttribute(name: string): string | null; getBoundingClientRect(): Box };
type PageGlobals = {
  innerWidth: number;
  document: { querySelector(selector: string): (El & { querySelectorAll(selector: string): ArrayLike<El> }) | null };
};

function actor(hp = 20) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 12,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Sets the window and the interface size, then loads the room again. */
async function setUp(view: { width: number; height: number; scale: number }): Promise<void> {
  await player.setViewportSize({ width: view.width, height: view.height });
  await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await player.reload();
  await player.getByRole("status", { name: "Connected" }).first().waitFor();
  await player.locator(".konvajs-content").first().waitFor();
}

/** Every control in a panel's sheet that runs past the window's edges, by its name. */
function offScreen(page: Page, region: string): Promise<string[]> {
  return page.evaluate((name) => {
    const g = globalThis as unknown as PageGlobals;
    const sheet = g.document.querySelector(`section[aria-label="${name}"]`);
    if (!sheet) return [`no sheet named ${name}`];
    return Array.from(sheet.querySelectorAll("button, input, select, time"))
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent ?? el.tagName, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.right - r.left > 0 && (r.left < -0.5 || r.right > g.innerWidth + 0.5))
      .map(({ name, r }) => `${name} at ${Math.round(r.left)}-${Math.round(r.right)}`);
  }, region);
}

/**
 * The turn band's parts on the player's turn: the name and "Your turn",
 * the timer, End Turn, and the window's width. Each text's own box is
 * read, not its column's, since a column too narrow for its text lets the
 * text run over what stands beside it.
 */
function band(page: Page) {
  return page.evaluate(() => {
    const g = globalThis as unknown as PageGlobals;
    const header = g.document.querySelector("header");
    if (!header) throw new Error("no top bar");
    const box = (el: El | undefined) => (el ? { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right } : null);
    const all = Array.from(header.querySelectorAll("*"));
    return {
      width: g.innerWidth,
      name: box(all.find((el) => el.getAttribute("data-rvtt-strip-name") !== null)),
      yourTurn: box(all.find((el) => el.textContent === "Your turn" && el.tagName === "SPAN")),
      timer: box(all.find((el) => el.getAttribute("role") === "timer")),
      endTurn: box(all.find((el) => el.tagName === "BUTTON" && el.textContent === "End turn")),
      timerText: all.find((el) => el.getAttribute("role") === "timer")?.textContent ?? "",
    };
  });
}

function card(page: Page) {
  return page.getByRole("dialog", { name: CARD });
}

describe("raccoon-vtt player on a phone after the design pass", { timeout: 240_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    playerContext = await browser.newContext({ viewport: PORTRAIT, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    player = await playerContext.newPage();
    playerConsole.attach(player);
    await playerSocket.attach(playerContext, player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("1. a DM's room with Pat's Thorn and a goblin, Pat on a phone", async () => {
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
    run.sceneId = dmSocket.state!.meta.playerSceneId!;

    // Pat joins from the phone, whose cookies the request shares.
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    const patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: 8, y: 6, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(run.goblin.id, { kind: "monster", name: "Goblin 1", x: 12, y: 9, disposition: "hostile", actor: { inline: actor(7) } }));

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Thorn on the player's map", () => playerSocket.state?.tokens[run.thorn.id]);
  });

  for (const view of [
    { width: 360, height: 740, scale: 1.3 },
    { width: 320, height: 568, scale: 1.15 },
  ]) {
    const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
    test(`2. the Log keeps Send, Export, the recipient and the times on screen: ${label} (LPD-PLAYER-3)`, async () => {
      await setUp(view);
      await player.locator('nav[aria-label="Tools"] button[title="Panels"]').tap();
      await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Log/ }).tap();
      await player.getByRole("region", { name: "Log" }).waitFor();
      const log = player.getByRole("region", { name: "Log" });
      await log.getByRole("textbox", { name: "Message" }).fill(`Hello from ${label}`);
      assert.deepEqual(await offScreen(player, "Log"), [], "the Log ran past the window");
      await log.getByRole("button", { name: "Send", exact: true }).tap();
      await log.getByText(`Hello from ${label}`).waitFor();
      if (view.width === 360) await shots.take(player, "playerphone-log-360-130");
      await player.getByRole("button", { name: "Close Log" }).tap();
    });
  }

  test("3. time is up on the player's turn: the band's name gives way and End turn stays on screen at 130% (LPD-PLAYER-4)", async () => {
    await ops.send({ t: "room.update", settings: { turnTimerSec: 4 } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.goblin.entryId, tokenId: run.goblin.id, value: 18 },
        { id: run.thorn.entryId, tokenId: run.thorn.id, value: 15 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await ops.send({ t: "encounter.next" });
    for (const view of [
      { width: 390, height: 844, scale: 1.3 },
      { width: 360, height: 740, scale: 1.3 },
      { width: 390, height: 844, scale: 1 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(view);
      await player.getByRole("button", { name: "End turn" }).waitFor();
      // The time past the turn needs room of its own: "Time’s up +0:05" and the like.
      await waitFor(`time up in the band, ${label}`, async () => /Time’s up\s*\+/.test((await band(player)).timerText) || null, 15_000);
      const b = await band(player);
      assert.ok(b.name && b.yourTurn && b.timer && b.endTurn, `${label}: the band is missing a part: ${JSON.stringify(b)}`);
      assert.ok(b.endTurn.right <= b.width + 0.5 && b.endTurn.left >= -0.5, `${label}: End turn runs off the screen: ${JSON.stringify(b)}`);
      assert.ok(b.name.right <= b.timer.left + 0.5, `${label}: the name runs over the timer: ${JSON.stringify(b)}`);
      assert.ok(b.yourTurn.right <= b.timer.left + 0.5, `${label}: "Your turn" runs over the timer: ${JSON.stringify(b)}`);
      assert.ok(b.timer.right <= b.endTurn.left + 0.5, `${label}: the timer runs under End turn: ${JSON.stringify(b)}`);
      if (view.width === 360) await shots.take(player, "playerphone-band-time-up-360-130");
    }
    await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
    await ops.send({ t: "encounter.end" });
  });

  test("4. a total typed into the roll card, the choice picked and focus in the field survive turning the phone (LPD-PLAYER-1)", async () => {
    await setUp({ ...PORTRAIT, scale: 1 });
    const id = randomUUID();
    await ops.send({
      t: "roll.ask",
      request: { id, test: { kind: "save", choices: [{ ability: "dex" }, { ability: "str" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] },
    });
    await card(player).getByText("The DM asks for a Dexterity or Strength saving throw.").waitFor();
    await card(player).getByRole("radiogroup", { name: "Which one you rolled" }).locator("label").filter({ hasText: "Strength" }).tap();
    await card(player).getByLabel("Total Thorn rolled").fill("16");

    for (const [view, label] of [
      [LANDSCAPE, "turned to landscape"],
      [PORTRAIT, "turned back to portrait"],
    ] as const) {
      await player.setViewportSize(view);
      // Across the screen's foot in portrait, portaled to the body, and in the alerts column in landscape: a card mounted afresh.
      const portaled = view === PORTRAIT;
      await waitFor(`${label}: the card in its new place`, async () => {
        const top = await card(player).evaluate((el) => (el as unknown as { parentElement: unknown }).parentElement === (globalThis as unknown as { document: { body: unknown } }).document.body);
        return top === portaled;
      });
      assert.equal(await card(player).getByLabel("Total Thorn rolled").inputValue(), "16", `${label}: the typed total is gone`);
      assert.ok(await card(player).getByRole("radio", { name: "Strength" }).isChecked(), `${label}: the chosen roll is gone`);
      const focus = await player.evaluate(() => (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement?.getAttribute("aria-label") ?? null);
      assert.equal(focus, "Total Thorn rolled", `${label}: focus left the Total field`);
    }
    await shots.take(player, "playerphone-card-after-turning");
    await card(player).getByRole("button", { name: "Send", exact: true }).tap();
    await waitFor("Thorn's answer at the server", () => {
      const target = dmSocket.state?.rolls[id]?.targets[0];
      return target?.total === 16 ? target : null;
    });
    assert.equal(dmSocket.state?.rolls[id]?.targets[0]?.choice, 1, "Strength was sent");
    await ops.send({ t: "roll.close", rollIds: [id] });
  });

  test("5. nothing went wrong in the browsers", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
  });
});
