import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The table display (docs/design-v1-dm-tools.md 3.1) where the live play
 * review after wave 5 found it broken (LP5-DISPLAY): a DM on a desktop, a
 * TV at 1920 x 1080 paired with a code, and a player on a phone for the
 * X-card.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus four, as
 * tools.e2e.ts does, since the runs never overlap. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 4;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-display-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
const TV = { width: 1920, height: 1080 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let tvContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let tv: Page;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const tvSocket = new SocketWatch("display");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const tvConsole = new ConsoleWatch("display");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E display ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  password: "",
  handoutImage: "",
  otherRoomId: "",
  otherRoomName: `E2E display other ${new Date().toISOString().slice(0, 19)}`,
};

/** The display's camera, from Konva's own stage. */
async function tvCamera(): Promise<{ x: number; y: number; scale: number; width: number; height: number } | null> {
  return tv.evaluate(() => {
    const konva = (globalThis as unknown as { Konva?: { stages: { x(): number; y(): number; scaleX(): number; width(): number; height(): number }[] } }).Konva;
    const stage = konva?.stages[0];
    return stage ? { x: stage.x(), y: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() } : null;
  });
}

type View = { x: number; y: number; w: number; h: number };

/** The last DM camera the display received. */
function lastView(): View | null {
  for (let i = tvSocket.received.length - 1; i >= 0; i--) {
    const f = JSON.parse(tvSocket.received[i]!) as { t?: string; e?: { k?: string } & View };
    if (f.t === "eph" && f.e?.k === "view") return f.e;
  }
  return null;
}

/** Waits until the display fits the area a DM device sent: the same center, and the whole area in sight. */
async function waitForTvOn(view: () => View | null, what: string): Promise<void> {
  let seen = "";
  try {
    await waitFor(what, async () => {
      const v = view();
      const cam = await tvCamera();
      if (!v || !cam) return (seen = `view ${JSON.stringify(v)}, camera ${JSON.stringify(cam)}`) && null;
      const cx = (cam.width / 2 - cam.x) / cam.scale;
      const cy = (cam.height / 2 - cam.y) / cam.scale;
      const across = cam.width / cam.scale;
      const down = cam.height / cam.scale;
      seen = `view ${JSON.stringify(v)}, display center ${cx.toFixed(2)},${cy.toFixed(2)} showing ${across.toFixed(2)} by ${down.toFixed(2)}`;
      return Math.abs(cx - v.x) < 0.25 && Math.abs(cy - v.y) < 0.25 && across >= v.w * 0.98 && down >= v.h * 0.98 && (across <= v.w * 1.02 || down <= v.h * 1.02);
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}: ${seen}`);
  }
}

/** A picture in one color, wider than tall as most handouts are. */
function picture(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 60, g: 60, b: 200 } } }).png().toBuffer();
}

describe("raccoon-vtt table display run", { timeout: 180_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    tvContext = await browser.newContext({ viewport: TV });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    tv = await tvContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    tvConsole.attach(tv);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await tvSocket.attach(tvContext, tv);
    await playerSocket.attach(playerContext, player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, tvConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    for (const [roomId, name] of [[run.roomId, run.roomName], [run.otherRoomId, run.otherRoomName]] as const) {
      if (!roomId || !dmContext) continue;
      try {
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name } });
        if (!res.ok()) console.error(`Deleting room ${roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("1. the DM creates a room, and a TV with no room cookie pairs with a code", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

    await dm.getByRole("tab", { name: "DM", exact: true }).click();
    await dm.getByRole("button", { name: "Add a TV" }).click();
    const code = (await dm.locator('[aria-label^="Display code "]').textContent()) ?? "";
    await dm.getByRole("button", { name: "Done" }).click();
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await waitFor("the display's snapshot", () => tvSocket.state);
    await dm.getByRole("status").filter({ hasText: "1 table display connected." }).waitFor();
  });

  test("2. a handout shown to everyone fits the TV whole, its shape kept", async () => {
    const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=handout`, {
      headers: { Origin: server.origin, "content-type": "image/png" },
      data: await picture(800, 600),
    });
    assert.ok(res.ok(), `uploading the handout answered ${res.status()}`);
    run.handoutImage = ((await res.json()) as { id: string }).id;
    const handoutId = randomUUID();
    await ops.send({ t: "handout.show", handout: { id: handoutId, assetId: run.handoutImage, title: "Map of the crypt", to: "all" } });

    const img = tv.getByRole("dialog", { name: "Map of the crypt" }).getByRole("img", { name: "Map of the crypt" });
    await waitFor("the handout's picture", () =>
      img.evaluate((el) => {
        const picture = el as unknown as { complete: boolean; naturalWidth: number };
        const style = (globalThis as unknown as { getComputedStyle(el: unknown): { opacity: string } }).getComputedStyle(el);
        return picture.complete && picture.naturalWidth > 0 && style.opacity === "1";
      }),
    );
    // The picture is drawn inside its box, contained, so the box must lie on the screen.
    const box = await img.boundingBox();
    assert.ok(box, "the handout's picture has no box");
    assert.ok(box.y >= 0 && box.y + box.height <= TV.height && box.x >= 0 && box.x + box.width <= TV.width, `the handout runs off the screen: ${JSON.stringify(box)}`);
    // Contained, a 4:3 picture on a 16:9 screen is as tall as its box and narrower.
    const drawnWidth = (box.height * 800) / 600;
    assert.ok(drawnWidth <= box.width + 1, `the picture is cut: ${JSON.stringify(box)}`);
    await shots.take(tv, "display-handout-fits");

    await ops.send({ t: "handout.close", handoutId });
    await tv.getByRole("dialog", { name: "Map of the crypt" }).waitFor({ state: "detached" });
  });

  test("3. a display following the DM shows the DM's view again after it reloads, with the DM's camera at rest", async () => {
    await dm.getByRole("tab", { name: "DM", exact: true }).click();
    await dm.getByRole("switch", { name: /^Show my view on the table display/ }).click();
    await dm.getByRole("switch", { name: /^Show my view on the table display/, checked: true }).waitFor();
    await tv.mouse.click(TV.width / 2, TV.height / 2);
    const menu = tv.getByRole("menu", { name: "Table display" });
    await menu.getByRole("menuitemradio", { name: "Follow the DM" }).click();
    await tv.mouse.click(TV.width / 2, TV.height / 2);
    await menu.waitFor({ state: "detached" });

    // Zoomed in on a corner, so the view is far from what Fit the map shows.
    const box = await dm.locator(".konvajs-content").first().boundingBox();
    assert.ok(box);
    await dm.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
    for (let i = 0; i < 3; i++) {
      await dm.mouse.wheel(0, -240);
      await dm.waitForTimeout(150);
    }
    await waitForTvOn(lastView, "the display on the DM's view");
    const before = lastView()!;

    const frames = tvSocket.received.length;
    await tv.reload();
    await waitFor("the display's new snapshot", () => tvSocket.received.slice(frames).some((f) => f.startsWith('{"t":"snapshot"')) || null);
    // The DM's camera has not moved: the view comes from the DM device seeing the display count rise.
    await waitForTvOn(() => {
      const after = tvSocket.received.slice(frames).some((f) => f.includes('"k":"view"'));
      return after ? lastView() : null;
    }, "the display on the DM's view after its reload");
    const again = lastView()!;
    assert.ok(Math.abs(again.x - before.x) < 0.01 && Math.abs(again.w - before.w) < 0.01, `the DM's view moved: ${JSON.stringify([before, again])}`);
    await shots.take(tv, "display-follows-after-reload");
  });

  test("4. a display following the DM shows the DM's view again after a pause, with the DM's camera at rest", async () => {
    await ops.send({ t: "view.blackout", blackout: true });
    await tv.getByText("The DM has paused the game.").waitFor();
    const frames = tvSocket.received.length;
    await ops.send({ t: "view.blackout", blackout: false });
    await tv.getByText("The DM has paused the game.").waitFor({ state: "detached" });
    await waitForTvOn(() => {
      const after = tvSocket.received.slice(frames).some((f) => f.includes('"k":"view"'));
      return after ? lastView() : null;
    }, "the display on the DM's view after the pause");
    await shots.take(tv, "display-follows-after-pause");
  });

  test("5. on a player's phone, a handout shown while the X-card is up waits until the card is dismissed", async () => {
    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).tap();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).tap();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];

    const sent = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
    assert.equal(sent.status(), 204);
    const card = player.getByRole("dialog", { name: "X-card" });
    await card.waitFor();
    const handoutId = randomUUID();
    await ops.send({ t: "handout.show", handout: { id: handoutId, assetId: run.handoutImage, title: "Strange letter", to: "all" } });
    await waitFor("the handout in the player's view", () => playerSocket.state?.handouts[handoutId]);
    await player.waitForTimeout(500);
    assert.equal(await player.getByRole("dialog", { name: "Strange letter" }).count(), 0, "the handout opened over the X-card");
    await shots.take(player, "display-xcard-before-handout");

    await card.getByRole("button", { name: "Dismiss" }).tap();
    await player.getByRole("dialog", { name: "Strange letter" }).waitFor();
    await shots.take(player, "display-handout-after-xcard");
    await player.getByRole("dialog", { name: "Strange letter" }).getByRole("button", { name: "Close" }).tap();
    await dm.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "Dismiss" }).click();
    await ops.send({ t: "handout.close", handoutId });
    await tv.mouse.click(TV.width / 2, TV.height / 2);
    await tv.getByRole("dialog", { name: "X-card" }).waitFor({ state: "detached" });
    await tv.getByRole("dialog", { name: "Strange letter" }).waitFor({ state: "detached" });
  });

  test("6. the connection banner shows over a handout while the server is away", async () => {
    const handoutId = randomUUID();
    await ops.send({ t: "handout.show", handout: { id: handoutId, assetId: run.handoutImage, title: "Old letter", to: "all" } });
    await tv.getByRole("dialog", { name: "Old letter" }).waitFor();
    ops.close();
    tvConsole.expectSocketFailures = true;
    dmConsole.expectSocketFailures = true;
    await server.stop();
    try {
      const banner = tv.getByRole("status").filter({ hasText: /Reconnecting to the room|This display is offline/ });
      await banner.waitFor({ timeout: 15_000 });
      const box = await banner.boundingBox();
      assert.ok(box);
      // The banner takes no taps, which hit testing skips, so it takes them for this one look at what is on top.
      const onTop = await banner.evaluate((el, [x, y]) => {
        const doc = el.ownerDocument;
        const style = (el as unknown as { style: { pointerEvents: string } }).style;
        style.pointerEvents = "auto";
        const top = doc.elementFromPoint(x, y);
        style.pointerEvents = "none";
        return top !== null && el.contains(top);
      }, [box.x + box.width / 2, box.y + box.height / 2] as const);
      assert.ok(onTop, "the handout covers the connection banner");
      await shots.take(tv, "display-banner-over-handout");
    } finally {
      server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    }
    await tv.getByRole("status").filter({ hasText: /Reconnecting to the room|This display is offline/ }).waitFor({ state: "detached", timeout: 20_000 });
    tvConsole.expectSocketFailures = false;
    dmConsole.expectSocketFailures = false;
  });

  test("7. changing the player password warns that it signs the display out, and does", async () => {
    await dm.getByRole("tab", { name: "Menu", exact: true }).click();
    await dm.getByRole("button", { name: /^Members/ }).click();
    await dm.getByText(/signs every player and table display out/).waitFor();
    await dm.getByRole("button", { name: "Change the password" }).click();
    await dm.getByText(/Table displays are signed out too and need a new code/).waitFor();
    await dm.getByRole("button", { name: "Change the password" }).last().click();
    await tv.getByRole("heading", { name: "This display was signed out" }).waitFor();
    await dm.getByRole("tab", { name: "DM", exact: true }).click();
    await dm.getByRole("status").filter({ hasText: "No table display is connected." }).waitFor();
  });

  test("8. a display paired with another room from another tab says it moved, and Home keeps the new room", async () => {
    const mint = async (roomId: string) => {
      const res = await dmContext.request.post(`${server.origin}/api/rooms/${roomId}/display/code`, { headers: { Origin: server.origin } });
      assert.equal(res.status(), 201, await res.text());
      return ((await res.json()) as { code: string }).code;
    };
    const pair = async (page: Page, roomId: string) => {
      await page.goto(`${server.origin}/display`);
      await page.getByLabel("Code from the DM's screen").fill(await mint(roomId));
      await page.getByRole("button", { name: "Connect" }).click();
      await page.waitForURL(new RegExp(`/display/${roomId.slice(0, 4)}-${roomId.slice(4)}$`));
    };
    // The password change signed the TV out, so it pairs with this room again first.
    await pair(tv, run.roomId);
    await tv.locator(".konvajs-content").waitFor();

    const dmTab = await dmContext.newPage();
    await dmTab.goto(`${server.origin}/`);
    await dmTab.getByLabel("Room name").fill(run.otherRoomName);
    await dmTab.getByLabel("Your name").fill("Dana the DM");
    await dmTab.getByRole("button", { name: "Create room" }).click();
    await dmTab.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dmTab.locator("code").first().textContent()) ?? "";
    run.otherRoomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)![1]!.replace("-", "");
    await dmTab.close();

    const tvTab = await tvContext.newPage();
    await pair(tvTab, run.otherRoomId);
    await tv.getByRole("heading", { name: "This display now shows another room" }).waitFor();
    await shots.take(tv, "display-moved-to-another-room");
    const remembered = await tv.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("rvtt.display.room"));
    assert.equal(remembered, run.otherRoomId, "the first tab forgot the room the second one paired with");
    await tvTab.close();
  });
});
