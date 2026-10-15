import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import type { RoomState, Scene, Token } from "#shared/model.ts";
import { generatePassphrase } from "#shared/passphrase.ts";
import { ConsoleWatch, dragCells, dragWorld, measureSnapshot, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * The Stage 3 smoke run (design section 18): the real server serving the
 * production build, Postgres, and two real browsers, a DM on a desktop and
 * a player on a phone-sized screen, through a whole session.
 *
 * `pnpm test:e2e` builds first, then starts and stops the server itself.
 * It needs the dev Postgres (DATABASE_URL, default the docker compose one)
 * and an installed Google Chrome, which Playwright drives as is, so no
 * browser is downloaded. It is not part of `pnpm test`, because it takes a
 * port, a database and a browser.
 *
 * - E2E_PORT: the server's port, 3100 by default.
 * - E2E_SCREENSHOT_DIR: where screenshots go, numbered after whatever is
 *   there already so nothing is overwritten. `0` takes none.
 * - E2E_HEADED=1 shows the browsers. E2E_DEBUG=1 prints socket and console
 *   counts and the server's last lines at the end.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

/** The generated map: 10 by 16 squares of 64 px, named so the server reads the scale from it. */
const MAP = { file: "e2e-crypt_10x16.png", cols: 10, rows: 16, cellPx: 64 };

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

/** What the run learns as it goes, shared by the steps. */
const run = {
  roomId: "",
  roomName: `E2E smoke ${new Date().toISOString().slice(0, 19)}`,
  dmLink: "",
  password: "",
  mapSceneId: "",
  bounds: { w: MAP.cols, h: MAP.rows },
  thornId: "",
  warriorId: "",
  bossId: "",
};

async function makeMap(file: string): Promise<void> {
  const width = MAP.cols * MAP.cellPx;
  const height = MAP.rows * MAP.cellPx;
  // Flagstones in two shades with dark grout, drawn here, so no art is downloaded.
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grout = x % MAP.cellPx < 2 || y % MAP.cellPx < 2;
      const shade = (Math.floor(x / MAP.cellPx) + Math.floor(y / MAP.cellPx)) % 2 === 0 ? 120 : 100;
      const v = grout ? 40 : shade;
      pixels[i] = v;
      pixels[i + 1] = v - 8;
      pixels[i + 2] = v - 20;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

function scene(state: RoomState | null, id: string): Scene | undefined {
  return state?.scenes[id];
}

function tokensNamed(state: RoomState | null, name: string): Token[] {
  return Object.values(state?.tokens ?? {}).filter((t): t is Token => !!t && t.name === name);
}

describe("raccoon-vtt smoke run", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const w of [dmSocket, playerSocket]) console.error(`[${w.label}] sockets ${w.sockets}, closes ${w.closes}, frames ${w.received.length}`);
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    // The room goes the way a DM deletes it, so a run leaves nothing behind,
    // even one that failed while the server was down.
    if (run.roomId && dmContext) {
      try {
        if (!server.alive()) server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, {
          headers: { Origin: server.origin },
          data: { name: run.roomName },
        });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("1. the DM creates a room and gets the DM link", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    assert.match(run.password, /^\S{8,}$/);
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    run.dmLink = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=([A-Za-z0-9_-]{43})$/.exec(run.dmLink);
    assert.ok(match, `DM link looks wrong: ${run.dmLink}`);
    run.roomId = match[1]!.replace("-", "");
    await shots.take(dm, "dm-link");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(dmSocket.you?.role, "dm");
  });

  test("1b. the DM link signs a second device in as a DM and leaves the address bar", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const watch = new SocketWatch("dm phone");
      const logs = new ConsoleWatch("dm phone");
      logs.attach(page);
      await watch.attach(context, page);
      // The claim page asks GET /me first, and a new device is answered 403.
      // Its claim without a choice is then answered 409 with the DM members
      // to pick from.
      logs.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/, /status of 409 .*\/api\/rooms\/[0-9A-Z]{8}\/dm\)$/];
      await page.goto(run.dmLink);
      // The same DM on a second device carries on as the same member.
      await page.getByRole("button", { name: /Dana the DM/ }).click();
      await waitFor("the DM phone's snapshot", () => watch.state);
      assert.equal(watch.you?.role, "dm");
      assert.equal(watch.you?.memberId, dmSocket.you?.memberId);
      assert.equal(new URL(page.url()).hash, "", "the DM key stayed in the address bar");
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      assert.deepEqual(logs.errors, []);
      assert.deepEqual(logs.warnings, []);
    } finally {
      await context.close();
    }
  });

  test("2. a player joins from a phone with the password", async () => {
    // A new device asks GET /me first and is answered 403 before it joins.
    // That is how the page picks the join form, and Chrome logs it.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).click();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).click();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(playerSocket.you?.role, "player");
    await waitFor("the DM to see the new player", () =>
      Object.values(dmSocket.state?.members ?? {}).some((m) => m?.name === "Pat" && m.kind === "player"),
    );
    await shots.take(player, "player-joined");
  });

  test("3. the DM uploads a map, makes a scene of it and moves the players there", async () => {
    const file = path.join(work, MAP.file);
    await makeMap(file);
    await dm.getByRole("tab", { name: "Scenes" }).click();
    await dm.getByRole("radio", { name: "Map image" }).click();
    await dm.getByRole("button", { name: "Choose a map image" }).setInputFiles(file);
    await dm.getByRole("button", { name: "Upload and create" }).click();
    const created = await waitFor(
      "the map scene",
      () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.map !== undefined),
      30_000,
    );
    run.mapSceneId = created.id;
    assert.deepEqual(created.bounds, { w: MAP.cols, h: MAP.rows });
    assert.equal(created.map?.cellPx, MAP.cellPx);
    assert.equal(created.fogEnabled, true, "a map scene starts fogged");
    await waitFor("the DM to be on the map scene", () => dmSocket.you?.sceneId === run.mapSceneId || null);
    await dm.getByRole("button", { name: `Move players to ${created.name}` }).click();
    await waitFor("the player on the map scene", () => playerSocket.state?.meta.playerSceneId === run.mapSceneId || null);
    await waitFor("the scene in the player's state", () => scene(playerSocket.state, run.mapSceneId));
    await shots.take(dm, "dm-map-scene");
    await shots.take(player, "player-map-scene-fogged");
  });

  test("4. the DM places a monster and the player's character, and the player moves it", async () => {
    // The player's character, owned by Pat, placed at cell (2, 3).
    await dm.getByRole("tab", { name: "Characters" }).click();
    await dm.getByRole("button", { name: "New character" }).click();
    await dm.getByLabel("Name", { exact: true }).fill("Thorn");
    await dm.getByLabel("Pat").check();
    await dm.getByRole("button", { name: "Create and place" }).click();
    await tapCell(dm, run.bounds, { x: 2, y: 3 });
    const thorn = await waitFor("Thorn's token", () => tokensNamed(dmSocket.state, "Thorn")[0]);
    run.thornId = thorn.id;
    assert.deepEqual({ x: thorn.x, y: thorn.y }, { x: 2, y: 3 });

    // Two monsters from the SRD browser: one where the party will see it,
    // one deep in the fog.
    await placeMonster("Goblin Warrior", { x: 5, y: 5 });
    await placeMonster("Goblin Boss", { x: 7, y: 12 });
    const warrior = await waitFor("the Goblin Warrior", () => tokensNamed(dmSocket.state, "Goblin Warrior")[0]);
    const boss = await waitFor("the Goblin Boss", () => tokensNamed(dmSocket.state, "Goblin Boss")[0]);
    run.warriorId = warrior.id;
    run.bossId = boss.id;
    assert.deepEqual({ x: warrior.x, y: warrior.y }, { x: 5, y: 5 });
    assert.deepEqual({ x: boss.x, y: boss.y }, { x: 7, y: 12 });

    // The player sees their own token through the fog, and no monster yet.
    await waitFor("Thorn in the player's state", () => playerSocket.state?.tokens[run.thornId]);
    assert.equal(playerSocket.state?.tokens[run.warriorId], undefined);
    assert.equal(playerSocket.everSaw(run.warriorId), false, "a monster under fog reached the player");

    await dragCells(player, run.bounds, { x: 2, y: 3 }, { x: 3, y: 5 });
    await waitFor("the move in the player's state", () => {
      const t = playerSocket.state?.tokens[run.thornId];
      return t && t.x === 3 && t.y === 5;
    });
    await waitFor("the move in the DM's state", () => {
      const t = dmSocket.state?.tokens[run.thornId];
      return t && t.x === 3 && t.y === 5;
    });
    // The DM watched the drag as it happened, not only its result.
    const preview = (f: string) => f.includes('"t":"eph"') && f.includes('"dragMove"') && f.includes(run.thornId);
    assert.ok(dmSocket.received.some(preview), "the DM got no drag preview");
    await shots.take(dm, "dm-tokens-placed");
    await shots.take(player, "player-moved-own-token");
  });

  test("5. fog: the player sees only what the DM reveals", async () => {
    assert.equal(scene(dmSocket.state, run.mapSceneId)?.fogEnabled, true);
    await dm.getByRole("button", { name: "Fog", exact: true }).click();
    // A rectangle over cells (1, 2) to (8, 9): Thorn and the Goblin Warrior, not the Boss.
    await dragWorld(dm, run.bounds, { x: 1, y: 2 }, { x: 9, y: 10 });
    await dm.getByRole("button", { name: /^Reveal to players \(1\)$/ }).click();
    await waitFor("the Goblin Warrior in the player's state", () => playerSocket.state?.tokens[run.warriorId]);
    const tiles = Object.keys(playerSocket.state?.fogTiles ?? {});
    assert.ok(tiles.length > 0, "the player has the revealed fog tiles");
    assert.equal(playerSocket.state?.fogDrafts[run.mapSceneId], undefined, "the fog draft is the DM's only");
    assert.equal(playerSocket.state?.tokens[run.bossId], undefined);
    assert.equal(playerSocket.everSaw(run.bossId), false, "the monster under fog reached the player");
    assert.equal(await player.getByText("Goblin Boss").count(), 0);
    await dm.getByRole("button", { name: "Select", exact: true }).click();
    await shots.take(dm, "dm-fog-revealed");
    await shots.take(player, "player-fog-revealed");
  });

  test("6. the player aims a cone from their token and sees what it catches", async () => {
    await player.getByRole("button", { name: "Area", exact: true }).click();
    const bar = player.getByRole("toolbar", { name: "Area options" });
    await bar.getByLabel("Shape").selectOption("cone");
    await dragCells(player, run.bounds, { x: 3, y: 5 }, { x: 6, y: 5 });
    await bar.getByText(/In area \(1\): Goblin Warrior( \d+)?$/).waitFor();
    await shots.take(player, "player-cone");
    await player.getByRole("button", { name: "Select", exact: true }).click();
  });

  test("7. initiative: the DM starts a fight, values go in, and both see whose turn it is", async () => {
    await dm.getByRole("tab", { name: "Initiative" }).click();
    await dm.getByRole("button", { name: "Everyone here (3)" }).click();
    await waitFor("the encounter", () => (dmSocket.state?.encounter?.entries.length ?? 0) === 3 || null);
    await setInitiative(dm, /^Goblin Warrior( \d+)?/, "15");
    await setInitiative(dm, /^Goblin Boss( \d+)?/, "12");

    // The player types their own roll on the phone.
    const playerStrip = player.getByRole("button", { name: /^Initiative, round 1\./ });
    await playerStrip.click();
    await setInitiative(player, /^Thorn/, "18");
    await player.getByRole("button", { name: "Close Initiative" }).click();
    await waitFor("every value in", () => dmSocket.state?.encounter?.entries.every((e) => e.value !== null) || null);
    const playerEntries = playerSocket.state?.encounter?.entries ?? [];
    assert.equal(playerEntries.length, 2, "the entry of the monster under fog is not the player's to see");
    assert.ok(!playerEntries.some((e) => e.tokenId === run.bossId));

    const dmStrip = dm.getByRole("button", { name: /^Initiative, round 1\./ });
    await dm.getByRole("button", { name: "Start", exact: true }).click();
    await dmStrip.and(dm.getByRole("button", { name: /Thorn's turn/ })).waitFor();
    await playerStrip.and(player.getByRole("button", { name: /Your turn/ })).waitFor();
    await shots.take(player, "player-your-turn");

    await dm.getByRole("button", { name: "Next", exact: true }).click();
    await dmStrip.and(dm.getByRole("button", { name: /Goblin Warrior( \d+)?'s turn/ })).waitFor();
    await playerStrip.and(player.getByRole("button", { name: /Goblin Warrior( \d+)?'s turn/ })).waitFor();

    // The Boss is under the fog, so the player only learns that someone else acts.
    await dm.getByRole("button", { name: "Next", exact: true }).click();
    await dmStrip.and(dm.getByRole("button", { name: /Goblin Boss( \d+)?'s turn/ })).waitFor();
    await playerStrip.and(player.getByRole("button", { name: /Another creature's turn/ })).waitFor();
    assert.equal(playerSocket.everSaw(run.bossId), false);
    await playerStrip.click();
    await player.getByText("Another creature's turn").first().waitFor();
    assert.equal(await player.getByText("Goblin Boss").count(), 0, "the tracker names the monster under fog");
    await shots.take(player, "player-tracker-hidden-turn");
    await player.getByRole("button", { name: "Close Initiative" }).click();
    await shots.take(dm, "dm-initiative");
  });

  test("8a. the player drops offline, edits, and catches up on reconnect without a reload", async () => {
    await player.evaluate(() => {
      (globalThis as unknown as { e2eMarker: number }).e2eMarker = 42;
    });
    const socketsBefore = playerSocket.sockets;
    const closesBefore = playerSocket.closes;
    playerConsole.expectSocketFailures = true;
    // Chrome's offline mode stalls an open socket instead of closing it, as
    // a phone losing signal does. The client finds out from its heartbeat:
    // the `offline` event sends a ping, and with no pong in 10 s it gives
    // the socket up and reconnects with backoff (design 7.5).
    await playerContext.setOffline(true);
    await waitFor("the player's socket to drop", () => playerSocket.closes > closesBefore || null, 45_000);
    await player.getByRole("status", { name: /^(Offline|Reconnecting)$/ }).first().waitFor();

    // A DM change the player misses, and a move the player makes offline.
    await dragCells(dm, run.bounds, { x: 5, y: 5 }, { x: 6, y: 7 });
    await waitFor("the DM's move", () => {
      const t = dmSocket.state?.tokens[run.warriorId];
      return t && t.x === 6 && t.y === 7;
    });
    await dragCells(player, run.bounds, { x: 3, y: 5 }, { x: 2, y: 6 });
    await shots.take(player, "player-offline");

    await playerContext.setOffline(false);
    await waitFor("a new player socket", () => playerSocket.sockets > socketsBefore || null, 30_000);
    await player.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 30_000 });
    playerConsole.expectSocketFailures = false;
    await waitFor("the player to see the DM's move", () => {
      const t = playerSocket.state?.tokens[run.warriorId];
      return t && t.x === 6 && t.y === 7;
    });
    await waitFor("the DM to see the offline move", () => {
      const t = dmSocket.state?.tokens[run.thornId];
      return t && t.x === 2 && t.y === 6;
    });
    await waitFor("the player's own state to settle", () => {
      const t = playerSocket.state?.tokens[run.thornId];
      return t && t.x === 2 && t.y === 6;
    });
    const marker = await player.evaluate(() => (globalThis as unknown as { e2eMarker?: number }).e2eMarker);
    assert.equal(marker, 42, "the page reloaded");
    assert.equal(playerSocket.everSaw(run.bossId), false);
    await shots.take(player, "player-back-online");
  });

  test("8b. the server restarts and both clients come back on their own", async () => {
    const dmSnapshots = dmSocket.snapshotBytes.length;
    const playerSnapshots = playerSocket.snapshotBytes.length;
    // What each page built from its snapshot and every event since. A fresh
    // snapshot after the restart must match it exactly (design 7.3).
    const dmBefore = structuredClone(dmSocket.state);
    const playerBefore = structuredClone(playerSocket.state);
    dmConsole.expectSocketFailures = true;
    playerConsole.expectSocketFailures = true;
    assert.equal(await server.stop(), 0, "the server did not shut down cleanly");
    await dm.getByRole("status", { name: /^(Reconnecting|Connecting|Offline)$/ }).first().waitFor();
    await player.getByRole("status", { name: /^(Reconnecting|Connecting|Offline)$/ }).first().waitFor();
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    await waitFor("the DM's new snapshot", () => dmSocket.snapshotBytes.length > dmSnapshots || null, 30_000);
    await waitFor("the player's new snapshot", () => playerSocket.snapshotBytes.length > playerSnapshots || null, 30_000);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    dmConsole.expectSocketFailures = false;
    playerConsole.expectSocketFailures = false;

    // The room came back from Postgres with everything in it, and what the
    // pages had pieced together from events was exactly the projection.
    assert.deepEqual(dmSocket.state, dmBefore);
    assert.deepEqual(playerSocket.state, playerBefore);
    await dm.getByRole("button", { name: "Next", exact: true }).click();
    const playerStrip = player.getByRole("button", { name: /^Initiative, round 2\./ });
    await playerStrip.and(player.getByRole("button", { name: /Your turn/ })).waitFor();
    await shots.take(dm, "dm-after-restart");
    await shots.take(player, "player-after-restart");
  });

  test("9. a reload puts the player back in the room with nothing hidden", async () => {
    const snapshots = playerSocket.snapshotBytes.length;
    await player.reload();
    await waitFor("the snapshot after the reload", () => playerSocket.snapshotBytes.length > snapshots || null);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(await player.getByRole("heading", { name: "Join the game" }).count(), 0);
    assert.equal(new URL(player.url()).pathname, `/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
    const state = playerSocket.state;
    assert.ok(state?.tokens[run.thornId] && state.tokens[run.warriorId]);
    assert.equal(state?.tokens[run.bossId], undefined);
    assert.equal(playerSocket.everSaw(run.bossId), false, "the monster under fog reached the player");
    assert.equal(state?.fogDrafts[run.mapSceneId], undefined);
    await shots.take(player, "player-reloaded");

    // The turn moves on while the reloaded phone has not been tapped yet.
    // The Boss under the fog acts after the Warrior, and the phone never
    // claims the player is up next. Their own turn is announced.
    await dm.getByRole("button", { name: "Next", exact: true }).click();
    await player.getByRole("button", { name: /^Initiative, round 2\. Goblin Warrior( \d+)?'s turn/ }).waitFor();
    await dm.getByRole("button", { name: "Next", exact: true }).click();
    await player.getByRole("button", { name: /^Initiative, round 2\. Another creature's turn/ }).waitFor();
    assert.equal(await player.getByText("Up next", { exact: true }).count(), 0);
    await dm.getByRole("button", { name: "Next", exact: true }).click();
    await player.getByRole("button", { name: /^Initiative, round 3\. Your turn/ }).waitFor();
    // The notice itself: "Your turn" under the creature's name in the phone's turn band flares as a live status.
    await player.getByRole("status").filter({ hasText: /^Your turn$/ }).waitFor();
  });

  test("10. the socket negotiates permessage-deflate, and no page logged an error or a warning", () => {
    for (const w of [dmSocket, playerSocket]) {
      assert.ok(w.handshakes.length > 0, `${w.label}: no handshake seen`);
      for (const h of w.handshakes) assert.match(h["sec-websocket-extensions"] ?? "", /permessage-deflate/, `${w.label}: no permessage-deflate`);
    }
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });

  test("11. snapshot sizes on the wire, with and without permessage-deflate", async () => {
    const lines: string[] = [];
    for (const [label, context] of [
      ["player", playerContext],
      ["DM", dmContext],
    ] as const) {
      const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      const deflated = await measureSnapshot({ origin: server.origin, roomId: run.roomId, cookie, deflate: true });
      const plain = await measureSnapshot({ origin: server.origin, roomId: run.roomId, cookie, deflate: false });
      assert.match(deflated.extensions, /permessage-deflate/);
      assert.equal(plain.extensions, "");
      assert.ok(deflated.wire < plain.wire, `${label}: deflate did not shrink the snapshot`);
      lines.push(`${label} snapshot: ${plain.json} bytes of JSON, ${deflated.wire} bytes on the wire with permessage-deflate, ${plain.wire} without`);
    }
    lines.push(`player snapshots during the run (JSON bytes): ${playerSocket.snapshotBytes.join(", ")}`);
    lines.push(`DM snapshots during the run (JSON bytes): ${dmSocket.snapshotBytes.join(", ")}`);
    for (const line of lines) console.log(line);
  });

  test("12. a blackout sends the player none of the table, a reload included, and lifting it brings the table back", async () => {
    const paused = player.getByText("The DM has paused the game.");
    await dm.getByRole("tab", { name: "DM", exact: true }).click();
    const blackout = dm.getByRole("switch", { name: /^Black out players' screens/ });
    await blackout.click();
    await paused.waitFor();
    await waitFor("the player's table to go", () => (Object.keys(playerSocket.state?.tokens ?? {}).length === 0 && Object.keys(playerSocket.state?.scenes ?? {}).length === 0) || null);
    const snapshots = playerSocket.snapshotBytes.length;
    await player.reload();
    await waitFor("the snapshot after the reload", () => playerSocket.snapshotBytes.length > snapshots || null);
    await paused.waitFor();
    const state = playerSocket.state;
    assert.equal(state?.meta.view.blackout, true);
    assert.deepEqual([state?.scenes, state?.tokens, state?.buildChunks, state?.fogTiles], [{}, {}, {}, {}]);
    assert.equal(state?.encounter, null);
    await shots.take(player, "player-blackout");
    await blackout.click();
    await waitFor("the player's table to come back", () => (playerSocket.state?.scenes[run.mapSceneId] && playerSocket.state.tokens[run.thornId] ? true : null));
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(await paused.count(), 0);
  });

  test("13. a password change reaches the DM's room menu, which then copies the new link", async () => {
    await dmContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    const clipboard = () => dm.evaluate<string>("navigator.clipboard.readText()");
    const passwordIn = (link: string) => new URL(link).hash.slice("#pw=".length);
    await dm.getByRole("tab", { name: "Menu", exact: true }).click();
    const copy = dm.getByRole("button", { name: "Copy player link" });
    await copy.click();
    assert.equal(decodeURIComponent(passwordIn(await clipboard())), run.password);

    await dm.getByRole("button", { name: /^Members/ }).click();
    const fresh = await dm.getByLabel("New player password").inputValue();
    await dm.getByRole("button", { name: "Change the password" }).click();
    await dm.getByRole("group", { name: "Change the password" }).getByRole("button", { name: "Change the password" }).click();
    await dm.getByText("The player password changed.", { exact: false }).waitFor();
    // The menu stayed open the whole time. Back on its page, it copies the new password, not the old.
    await dm.getByRole("button", { name: "Back to Menu" }).click();
    await copy.click();
    await waitFor("the new link on the clipboard", async () => (decodeURIComponent(passwordIn(await clipboard())) === fresh ? true : null));
    run.password = fresh;
  });

  test("13b. a password changed while the DM's device is offline reaches its open menu once it reconnects", async () => {
    const clipboard = () => dm.evaluate<string>("navigator.clipboard.readText()");
    const passwordIn = (link: string) => decodeURIComponent(new URL(link).hash.slice("#pw=".length));
    // The menu is still open on its own page from the step before, which copied the current link.
    assert.equal(passwordIn(await clipboard()), run.password);

    const closesBefore = dmSocket.closes;
    const socketsBefore = dmSocket.sockets;
    dmConsole.expectSocketFailures = true;
    await dmContext.setOffline(true);
    await waitFor("the DM's socket to drop", () => dmSocket.closes > closesBefore || null, 45_000);
    // Another DM device changes the password meanwhile. The server signals
    // only sockets holding a snapshot, so this device never hears of it.
    const fresh = generatePassphrase();
    const changed = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/password`, {
      headers: { Origin: server.origin },
      data: { password: fresh },
    });
    assert.ok(changed.ok(), `changing the password answered ${changed.status()}`);

    const refetched = dm.waitForResponse((r) => r.url().endsWith(`/api/rooms/${run.roomId}/player-link`) && r.ok(), { timeout: 45_000 });
    await dmContext.setOffline(false);
    await waitFor("a new DM socket", () => dmSocket.sockets > socketsBefore || null, 30_000);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 30_000 });
    dmConsole.expectSocketFailures = false;
    // The snapshot after the reconnect stands in for the missed signal, so the menu asks for the link again.
    await refetched;
    await dm.getByRole("button", { name: "Copy player link" }).click();
    await waitFor("the new link on the clipboard", async () => (passwordIn(await clipboard()) === fresh ? true : null));
    run.password = fresh;
  });
});

/** Types a value into a tracker row, the way a person taps the box and types. */
async function setInitiative(page: Page, name: RegExp, value: string): Promise<void> {
  const box = page.getByRole("button", { name: new RegExp(`${name.source} initiative not set, tap to type it$`) });
  await box.click();
  const input = page.getByRole("textbox", { name: new RegExp(`${name.source} initiative$`) });
  await input.fill(value);
  await input.press("Enter");
  await page.getByRole("button", { name: new RegExp(`${name.source} initiative ${value}`) }).waitFor();
}

async function placeMonster(name: string, cell: { x: number; y: number }): Promise<void> {
  await dm.getByRole("tab", { name: "Monsters" }).click();
  const back = dm.getByRole("button", { name: "Back to Monsters" });
  if (await back.isVisible()) await back.click();
  await dm.getByLabel("Search monsters").fill(name);
  await dm.getByRole("button", { name: new RegExp(`^${name} `) }).click();
  await dm.getByRole("button", { name: "Place on the map" }).click();
  await tapCell(dm, run.bounds, cell);
}
