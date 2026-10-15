import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, dragCells, OpSocket, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Older features on a wave 4 build that the live play review after wave 4
 * found broken (LP4-REGRESS): a DM on a desktop and a player on a phone.
 * The same two also carry the member color picker's round trip
 * (docs/design-v1-visual.md 5.3), and where focus starts on the join's
 * second step (LPD-DESK-9).
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus three. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 3;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-regress-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const SCENE_NAME = "Unlit hall";

const run = {
  roomId: "",
  roomName: `E2E regress ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: randomUUID(),
  thornId: randomUUID(),
  litId: randomUUID(),
  darkId: randomUUID(),
};

/** Whether any Konva circle on the page is filled with this color, such as a ping's center dot. */
function circleFilled(page: Page, color: string): Promise<boolean> {
  return page.evaluate((c) => {
    type Node = { fill(): unknown };
    const konva = (globalThis as unknown as { Konva?: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva?.stages.some((stage) => stage.find("Circle").some((n) => n.fill() === c)) ?? false;
  }, color);
}

/** What has focus: its tag, and its name by its label, its aria-label or its text. */
function focused(page: Page): Promise<{ tag: string; name: string }> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { activeElement: unknown } }).document;
    const el = doc.activeElement as {
      tagName: string;
      textContent: string | null;
      labels?: ArrayLike<{ textContent: string | null }> | null;
      getAttribute(name: string): string | null;
    } | null;
    if (!el) return { tag: "", name: "" };
    const name = el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? el.textContent ?? "";
    return { tag: el.tagName.toLowerCase(), name: name.trim() };
  });
}

/** An element's computed background color. */
function backgroundOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => (globalThis as unknown as { getComputedStyle(el: unknown): { backgroundColor: string } }).getComputedStyle(el).backgroundColor);
}

function actor() {
  return {
    hp: { cur: 7, max: 7, temp: 0 },
    life: "alive",
    ac: 13,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

describe("raccoon-vtt older features on a wave 4 build", { timeout: 180_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
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

  test("1. the DM creates a room and a player joins from a phone, each join step starting with focus on it (LPD-DESK-9)", async () => {
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

    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).click();
    // No player to continue as yet, so the second step starts at the name.
    await waitFor("the name field focused", async () => {
      const f = await focused(player);
      return f.tag === "input" && f.name === "Your name";
    });
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).click();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    run.patId = playerSocket.you!.memberId;

    // A second device lists Pat to continue as, so its second step starts at that list's heading.
    const other = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      const page = await other.newPage();
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByLabel("Player password").fill(run.password);
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Continue as Pat" }).waitFor();
      await waitFor("the heading of the players to continue as focused", async () => {
        const f = await focused(page);
        return f.tag === "h2" && f.name === "Who are you?";
      });
      await shots.take(page, "regress-join-step-two-focus");
    } finally {
      await other.close();
    }
  });

  test("2. on a dark vision scene, Visible to players counts the goblin in the party's torchlight (LP4-REGRESS-1)", async () => {
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({
      t: "scene.create",
      scene: { id: run.sceneId, name: SCENE_NAME, bounds: { w: 18, h: 10 }, background: "#2b2b31", fogEnabled: true, autoWalls: "off", blockMovement: true, vision: { on: true, light: "dark" } },
    });
    // Thorn's torch lights 8 squares: the goblin 3 squares off stands in it, the one 12 squares off in the dark.
    const creature = (id: string, name: string, x: number, extra: Record<string, unknown>) => ({
      t: "token.create",
      token: { id, sceneId: run.sceneId, kind: "monster", name, size: "medium", x, y: 4, visibility: "all", actor: { inline: actor() }, ...extra },
    });
    await ops.send(creature(run.thornId, "Thorn", 2, { kind: "pc", disposition: "ally", ownerIds: [run.patId], light: { bright: 20, dim: 20 } }));
    await ops.send(creature(run.litId, "Lit goblin", 5, { disposition: "hostile" }));
    await ops.send(creature(run.darkId, "Dark goblin", 14, { disposition: "hostile" }));

    await dm.getByRole("tab", { name: "Scenes" }).click();
    await dm.getByRole("button", { name: new RegExp(`^${SCENE_NAME}`) }).click();
    await waitFor("the DM on the vision scene", () => dmSocket.you?.sceneId === run.sceneId || null, 30_000);
    await dm.getByRole("button", { name: `Move players to ${SCENE_NAME}` }).click();
    await waitFor("the lit goblin in the player's state", () => playerSocket.state?.tokens[run.litId]);
    assert.equal(playerSocket.state?.tokens[run.darkId], undefined, "the goblin in the dark reached the player");

    // The DM's own fog reveals nothing here: the party's sight alone shows the lit goblin to players.
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await dm.getByRole("button", { name: "Everyone here (3)" }).waitFor();
    await dm.getByRole("button", { name: "Visible to players (2)" }).click();
    await waitFor("the fight with the visible creatures", () => (dmSocket.state?.encounter?.entries.length ?? 0) === 2 || null);
    const rows = new Set(dmSocket.state!.encounter!.entries.map((e) => e.tokenId));
    assert.deepEqual(rows, new Set([run.thornId, run.litId]));
    await shots.take(dm, "regress-visible-to-players");
  });

  test("3. the phone's Panels button keeps its name while it counts unread messages (LP4-REGRESS-4)", async () => {
    await dm.getByRole("tab", { name: "Log" }).click();
    await dm.getByLabel("Message").fill("Roll initiative");
    await dm.getByRole("button", { name: "Send" }).click();
    await player.getByRole("button", { name: "Panels 1 unread", exact: true }).waitFor();
    await shots.take(player, "regress-panels-unread");
  });

  test("4. a creature the player drags out of the party's sight gets a note, though the ground stays explored (LP4-REGRESS-2)", async () => {
    await ops.send({ t: "room.update", settings: { playersMoveAny: "all" } });
    // Thorn walks east with the torch: the squares around the start stay explored, now beyond its light.
    await ops.send({ t: "token.move", tokenId: run.thornId, x: 10, y: 4 });
    await waitFor("Thorn at (10, 4) for the player", () => playerSocket.state?.tokens[run.thornId]?.x === 10 || null);
    await dragCells(player, { w: 18, h: 10 }, { x: 5, y: 4 }, { x: 0, y: 4 });
    await waitFor("the goblin to leave the player's state", () => (playerSocket.state?.tokens[run.litId] ? null : true));
    await player.getByRole("status").filter({ hasText: "Lit goblin is out of the party's sight now." }).waitFor();
    await shots.take(player, "regress-out-of-sight-note");
  });

  test("5. a creature carrying its own light into the dark gets no note, since the party still sees it, and its bar's Undo move is named by its words", async () => {
    const lanternId = randomUUID();
    await ops.send({
      t: "token.create",
      token: { id: lanternId, sceneId: run.sceneId, kind: "monster", name: "Lantern goblin", size: "medium", x: 11, y: 4, visibility: "all", disposition: "hostile", actor: { inline: actor() }, light: { bright: 5, dim: 5 } },
    });
    await waitFor("the lantern goblin in the player's state", () => playerSocket.state?.tokens[lanternId]);
    // The far corner is past Thorn's torch, but the lantern goes with the goblin and lights it there.
    await dragCells(player, { w: 18, h: 10 }, { x: 11, y: 4 }, { x: 17, y: 9 });
    await waitFor("the lantern goblin at (17, 9) for the player", () => (playerSocket.state?.tokens[lanternId]?.x === 17 ? true : null));
    await player.waitForTimeout(800);
    assert.ok(playerSocket.state?.tokens[lanternId], "the server stopped sending the lantern goblin");
    assert.equal(await player.getByRole("status").filter({ hasText: "Lantern goblin is out of the party's sight now." }).count(), 0, "a note for a creature still in sight");

    // The bar offers the move back, by the words it shows (LPD-REGRESS-4).
    await tapCell(player, { w: 18, h: 10 }, { x: 17, y: 9 });
    const bar = player.getByRole("dialog", { name: "Lantern goblin actions" });
    await bar.getByRole("button", { name: "Undo move", exact: true }).waitFor();
    await bar.getByRole("button", { name: /^Close/ }).first().tap();
    await bar.waitFor({ state: "detached" });
  });

  test("6. on a phone, a long room name gives way to the player's chip, down to a few letters (LP4-REGRESS-5)", async () => {
    // The run's room name is longer than the bar, which cut "Pat" to "P." beside it.
    const chipName = (who: string) => player.getByTitle(`You are ${who}`).locator(":scope > span").last();
    const cut = (who: string) => chipName(who).evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.equal(await cut("Pat"), false, "the player's name is cut short");
    assert.match((await chipName("Pat").textContent()) ?? "", /Pat$/);

    // A longer name the bar still fits whole once the room name gave way, not cut by a hair.
    const cookie = (await playerContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const own = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    try {
      await own.send({ t: "member.update", memberId: run.patId, name: "Bartholomew Thistlewood" });
      await chipName("Bartholomew Thistlewood").waitFor();
      assert.equal(await cut("Bartholomew Thistlewood"), false, "a name that fits was cut short");
      // One too long for the bar: the room name keeps its first few letters, and the chip gives way after it.
      const long = "Bartholomew Thistlewood of the Long Valley";
      await own.send({ t: "member.update", memberId: run.patId, name: long });
      await chipName(long).waitFor();
      const roomName = await player.getByRole("heading", { level: 1 }).boundingBox();
      assert.ok(roomName && roomName.width >= 39.5, `the room name is ${roomName?.width ?? 0} px wide`);
      await shots.take(player, "regress-room-name-floor");
      await own.send({ t: "member.update", memberId: run.patId, name: "Pat" });
    } finally {
      own.close();
    }
  });

  test("7. a player picks a new color in Members: the DM's list shows it, and the player's next ping draws in it", async () => {
    const purple = "#8e4ec6";
    assert.notEqual(playerSocket.state?.members[run.patId]?.color, purple);

    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await player.getByRole("button", { name: /^Members/ }).click();
    const colorButton = player.getByRole("button", { name: "Change your color" });
    await colorButton.click();
    assert.equal(await colorButton.getAttribute("aria-expanded"), "true");
    const swatches = player.getByRole("radiogroup", { name: "Your color" });
    // The DM's yellow is marked by name, and stays pickable.
    await swatches.getByRole("radio", { name: "Yellow, used by Dana the DM" }).waitFor();
    await swatches.getByRole("radio", { name: "Purple", exact: true }).tap();
    assert.equal(await swatches.getByRole("radio", { name: "Purple", exact: true }).isChecked(), true);
    await waitFor("Pat's purple at the DM", () => dmSocket.state?.members[run.patId]?.color === purple || null);
    await shots.take(player, "regress-member-color-picked");

    // The DM's Members list: Pat's dot, and Purple named as Pat's in the DM's own picker.
    await dm.getByRole("tab", { name: "Menu", exact: true }).click();
    await dm.getByRole("button", { name: /^Members/ }).click();
    const patDot = dm.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: "Pat" }).locator("span[aria-hidden]").first();
    await waitFor("Pat's purple dot in the DM's list", async () => ((await backgroundOf(patDot)) === "rgb(142, 78, 198)" ? true : null));
    await dm.getByRole("button", { name: "Change your color" }).click();
    await dm.getByRole("radiogroup", { name: "Your color" }).getByRole("radio", { name: "Purple, used by Pat" }).waitFor();
    await shots.take(dm, "regress-member-color-dm-list");
    await dm.getByRole("button", { name: "Done", exact: true }).click();

    // The player's next ping, on the player's map and on the DM's.
    await player.getByRole("button", { name: /^Close (Menu|Members)$/ }).click();
    await player.getByRole("button", { name: "Ping", exact: true }).click();
    assert.equal(await circleFilled(player, purple), false, "something purple was on the map before the ping");
    await tapCell(player, { w: 18, h: 10 }, { x: 10, y: 7 });
    await waitFor("the player's ping in purple", async () => (await circleFilled(player, purple)) || null, 2_500);
    await waitFor("the player's ping in purple on the DM's map", async () => (await circleFilled(dm, purple)) || null, 2_500);
    await player.getByRole("button", { name: "Select", exact: true }).click();
  });

  test("8. no page logged an error or a warning", () => {
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
