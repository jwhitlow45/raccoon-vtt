import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Download, type Page } from "playwright-core";
import sharp from "sharp";
import type { RoomState } from "#shared/model.ts";
import { ConsoleWatch, dragCells, openSideTab, OpSocket, pagePoint, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * The v1 wave 5 run (docs/design-v1-dm-tools.md section 4, 5I): the real
 * server serving the production build and three browsers, a DM on a
 * desktop, a player on a phone and a table display on a TV-sized screen
 * paired with a code.
 *
 * The scene is laid out over a second socket of the DM's session (the
 * player's character and its token, a goblin, a hidden monster, a journal
 * page with a secret block), since none of that is what this run tests.
 * Then the browsers ask and answer a roll with two choices, reveal the
 * secret, pin the page to the map and open it from the pin, delete the
 * page, follow the DM's view on the display while the DM drags the hidden
 * monster, send the X-card from the Menu and from the pause screen, give
 * the goblin a game-icons.net icon, and export the log.
 *
 * Every frame the player and the display receive is kept, and at the end
 * none of them may hold the hidden monster, and the display none of the
 * roll request. The display's images must all come through its own route.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus four. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 4;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-tools-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let player: Page;
let tv: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const tvSocket = new SocketWatch("display");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");
const tvConsole = new ConsoleWatch("display");
/** Every response the display's page got, to check where its images come from. */
const tvResponses: { url: string; status: number }[] = [];

const SECRET = "The vault code is 7-3-1.";
const SHADOW = "Shadow Lurker";

const run = {
  roomId: "",
  roomName: `E2E tools ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: "",
  thornCharId: randomUUID(),
  thornId: randomUUID(),
  goblinId: randomUUID(),
  shadowId: randomUUID(),
  pageId: randomUUID(),
  goblinImage: "",
  shadowImage: "",
  rollId: "",
  pinId: "",
  /** The player's frame count when the secret was revealed, before which no frame may hold it. */
  revealedAt: -1,
  /** When the first X-card went out: taps within 10 s merge into one card. */
  firstXcardAt: 0,
};

function actor() {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
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

/** A plain picture in one color, for a token image. */
function portrait(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

/** Opens a panel as a phone does: the Panels button, then the panel's name. */
async function openPhonePanel(page: Page, name: string): Promise<void> {
  const picker = page.getByRole("list", { name: "Panels" });
  const all = page.getByRole("button", { name: "All panels" });
  if (await picker.isVisible()) {
    // The list is already open.
  } else if (await all.isVisible()) await all.tap();
  // By its title: with a count on it, the button's name is the count.
  else await page.locator('button[title="Panels"]').tap();
  // A panel with unread pages or lines carries its count after its name.
  await picker.getByRole("button", { name: new RegExp(`^${name}( ?\\d+ unread)?$`) }).tap();
}

/** Closes whatever sheet is open on the phone, so the map takes the next tap. */
async function closePhoneSheet(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: /^Close/ }).first();
  if (await close.isVisible()) await close.tap();
}

type Frame = {
  t?: string;
  e?: { k?: string; tokenId?: string; x?: number; y?: number; w?: number; h?: number };
  changes?: { key: string; value?: unknown; deleted?: true }[];
};

function framesOf(watch: SocketWatch, from = 0): Frame[] {
  return watch.received.slice(from).map((text) => JSON.parse(text) as Frame);
}

/** The display's camera, from Konva's own stage, and the size of its canvas. */
async function tvCamera(): Promise<{ x: number; y: number; scale: number; width: number; height: number } | null> {
  return tv.evaluate(() => {
    const konva = (globalThis as unknown as { Konva?: { stages: { x(): number; y(): number; scaleX(): number; width(): number; height(): number }[] } }).Konva;
    const stage = konva?.stages[0];
    return stage ? { x: stage.x(), y: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() } : null;
  });
}

/** Saves a download and reads it as text. */
async function readDownload(download: Download): Promise<string> {
  const file = path.join(work, `${randomUUID()}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  return readFileSync(file, "utf8");
}

/**
 * Exports the whole log from an open Export sheet. A computer downloads it
 * at once. A phone that prefers the share sheet shows a Download link
 * instead, which this taps.
 */
async function exportEverything(page: Page): Promise<string> {
  const sheet = page.getByRole("dialog", { name: "Export the log" });
  const everything = sheet.getByRole("listitem").filter({ hasText: /^Everything, / });
  await everything.waitFor();
  const auto = page.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
  // Each row's button is named by its row, so a list of them reads apart (LPD-DESK-10).
  await everything.getByRole("button", { name: /^Export Everything, \d+ lines?$/ }).click();
  const link = everything.getByRole("link", { name: "Download" });
  await link.waitFor();
  const downloaded = await auto;
  if (downloaded) return readDownload(downloaded);
  const again = page.waitForEvent("download");
  await link.click();
  return readDownload(await again);
}

describe("raccoon-vtt DM tools run", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    tvContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    tv = await tvContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    tvConsole.attach(tv);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
    await tvSocket.attach(tvContext, tv);
    tv.on("response", (res) => tvResponses.push({ url: res.url(), status: res.status() }));
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole, tvConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("1. the DM creates a room, a player joins from a phone, and the scene is laid out", async () => {
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

    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).tap();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).tap();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    run.patId = playerSocket.you!.memberId;

    const upload = async (rgb: [number, number, number]) => {
      const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=token`, {
        headers: { Origin: server.origin, "content-type": "image/png" },
        data: await portrait(rgb),
      });
      assert.ok(res.ok(), `uploading a token image answered ${res.status()}`);
      return ((await res.json()) as { id: string }).id;
    };
    run.goblinImage = await upload([60, 160, 70]);
    run.shadowImage = await upload([90, 40, 120]);

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const crop = { cx: 0.5, cy: 0.5, zoom: 1 };
    await ops.send({ t: "character.create", character: { id: run.thornCharId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thornId, { kind: "pc", name: "Thorn", x: 5, y: 5, disposition: "ally", actor: { ref: run.thornCharId } }));
    await ops.send(token(run.goblinId, { kind: "monster", name: "Goblin", x: 12, y: 6, disposition: "hostile", image: { assetId: run.goblinImage, crop }, actor: { inline: actor() } }));
    await ops.send(token(run.shadowId, { kind: "monster", name: SHADOW, x: 20, y: 10, disposition: "hostile", visibility: "dm", image: { assetId: run.shadowImage, crop }, actor: { inline: actor() } }));
    await ops.send({
      t: "journal.create",
      page: {
        id: run.pageId,
        title: "Old map",
        access: "all",
        blocks: [
          { id: "faded-map-01", text: "A faded map of the crypt." },
          { id: "vault-code-1", text: SECRET, secret: true },
        ],
      },
    });
    // A line only the DM may read: the hidden monster takes damage.
    await ops.send({ t: "actor.hp", target: { tokenId: run.shadowId }, change: { kind: "damage", amount: 3 } });
    await waitFor("Thorn and the goblin in the player's state", () => (playerSocket.state?.tokens[run.thornId] && playerSocket.state?.tokens[run.goblinId]) || null);
    assert.equal(playerSocket.state?.tokens[run.shadowId], undefined, "the hidden monster reached the player");
  });

  test("2. a TV pairs with a code and shows the player scene, its images through its own route", async () => {
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "Add a TV" }).click();
    const shown = dm.locator('[aria-label^="Display code "]');
    await shown.waitFor();
    const code = (await shown.textContent()) ?? "";
    assert.match(code, /^[0-9A-Z]{4} [0-9A-Z]{4} [0-9A-Z]{2}$/);
    await shots.take(dm, "tools-dm-display-code");

    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await tv.waitForURL(new RegExp(`/display/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}$`));
    await waitFor("the display's snapshot", () => tvSocket.state);
    assert.equal((tvSocket.you as { role: string } | null)?.role, "display");
    await dm.getByRole("status").filter({ hasText: "1 table display connected." }).waitFor();
    await dm.getByRole("button", { name: "Done" }).click();

    await waitFor("the goblin in the display's state", () => tvSocket.state?.tokens[run.goblinId]);
    assert.equal(tvSocket.state?.tokens[run.shadowId], undefined, "the hidden monster reached the display");
    assert.deepEqual(Object.keys(tvSocket.state?.rolls ?? {}), []);
    const imageRoute = `/api/rooms/${run.roomId}/display/assets/${run.goblinImage}/`;
    await waitFor("the goblin's image through the display route", () => tvResponses.find((r) => r.url.includes(imageRoute) && r.status === 200));
    assert.deepEqual(tvResponses.filter((r) => r.url.includes("/api/assets/")), [], "the display used the room's own image route");
    await shots.take(tv, "tools-display-paired");
  });

  test("3. the display follows the DM's view, and the DM's drag of a hidden monster never reaches it", async () => {
    await dm.getByRole("switch", { name: /^Show my view on the table display/ }).click();
    await dm.getByRole("switch", { name: /^Show my view on the table display/, checked: true }).waitFor();

    // A tap shows the display's menu, and Follow the DM takes the DM's view from then on.
    await tv.mouse.click(640, 360);
    const menu = tv.getByRole("menu", { name: "Table display" });
    await menu.waitFor();
    await menu.getByRole("menuitemradio", { name: "Follow the DM" }).click();
    await menu.waitFor({ state: "detached", timeout: 10_000 });

    const box = await dm.locator(".konvajs-content").first().boundingBox();
    assert.ok(box);
    await dm.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    for (let i = 0; i < 3; i++) {
      await dm.mouse.wheel(0, -240);
      await dm.waitForTimeout(150);
    }
    const views = () => framesOf(tvSocket).filter((f) => f.t === "eph" && f.e?.k === "view");
    await waitFor("the DM's view on the display", () => views().length > 0 || null);
    // The display fits the last view it got: the same center, and the whole area in sight.
    let problem = "";
    try {
      await waitFor("the display's camera on the DM's view", async () => {
        const v = views().at(-1)!.e!;
        const cam = await tvCamera();
        if (!cam) return (problem = "no stage") && null;
        const cx = (cam.width / 2 - cam.x) / cam.scale;
        const cy = (cam.height / 2 - cam.y) / cam.scale;
        const across = cam.width / cam.scale;
        const down = cam.height / cam.scale;
        problem = `view ${JSON.stringify(v)}, display center ${cx.toFixed(2)},${cy.toFixed(2)} showing ${across.toFixed(2)} by ${down.toFixed(2)}`;
        return Math.abs(cx - v.x!) < 0.25 && Math.abs(cy - v.y!) < 0.25 && across >= v.w! * 0.98 && down >= v.h! * 0.98 && (across <= v.w! * 1.02 || down <= v.h! * 1.02);
      });
    } catch (err) {
      throw new Error(`${(err as Error).message}: ${problem}`);
    }
    assert.ok(framesOf(playerSocket).every((f) => !(f.t === "eph" && f.e?.k === "view")), "a player got the DM's view");
    await shots.take(tv, "tools-display-follows");

    // Back to the whole map with the keyboard's Fit map, then one drag of each monster.
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("0");
    const scene = dmSocket.state!.scenes[run.sceneId]!;
    const before = tvSocket.received.length;
    await dragCells(dm, scene.bounds, { x: 12, y: 6 }, { x: 14, y: 6 });
    await dragCells(dm, scene.bounds, { x: 20, y: 10 }, { x: 22, y: 10 });
    await waitFor("both monsters moved", () => (dmSocket.state?.tokens[run.goblinId]?.x === 14 && dmSocket.state?.tokens[run.shadowId]?.x === 22) || null);
    await waitFor("the goblin's move on the display", () => tvSocket.state?.tokens[run.goblinId]?.x === 14 || null);
    const drags = framesOf(tvSocket, before).filter((f) => f.t === "eph" && f.e?.tokenId !== undefined);
    assert.ok(drags.some((f) => f.e?.tokenId === run.goblinId && f.e.k === "dragMove"), "the goblin's drag never reached the display");
    assert.ok(drags.every((f) => f.e?.tokenId !== run.shadowId), "the hidden monster's drag reached the display");
  });

  test("4. a roll asked with two choices is answered, folds to a chip, and closes", async () => {
    await dm.getByRole("button", { name: "Ask the party" }).click();
    const sheet = dm.getByRole("dialog", { name: "Request a roll" });
    await sheet.waitFor();
    // Each choice is one whole roll, picked in one of its rows (docs/design-v1-roll-request.md 3).
    await sheet.getByRole("radiogroup", { name: "Saving throw" }).getByRole("radio", { name: "Strength" }).click();
    await sheet.getByRole("button", { name: "Or a second choice" }).click();
    // With a second choice, each picker is a group named by its place in the pair (LPD-DMPHONE-6).
    await sheet.getByRole("group", { name: "First choice" }).getByRole("radiogroup", { name: "Saving throw" }).getByRole("radio", { name: "Strength", checked: true }).waitFor();
    await sheet.getByRole("group", { name: "Or the second" }).getByRole("radiogroup", { name: "Saving throw" }).getByRole("radio", { name: "Dexterity" }).click();
    await sheet.getByLabel("DC", { exact: true }).fill("12");
    await sheet.getByRole("group", { name: "Who rolls" }).getByRole("button", { name: /^Thorn/, pressed: true }).waitFor();
    await shots.take(dm, "tools-roll-request");
    await sheet.getByRole("button", { name: "Send", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    const request = await waitFor("the request in the DM's state", () => Object.values(dmSocket.state?.rolls ?? {})[0]);
    run.rollId = request.id;

    const card = player.getByRole("dialog", { name: "The DM asks for a roll" });
    await card.waitFor();
    await card.getByText("The DM asks for a Strength or Dexterity saving throw.").waitFor();
    await card.getByRole("radiogroup", { name: "Which one you rolled" }).getByRole("radio", { name: "Dexterity" }).tap();
    await card.getByLabel("Total Thorn rolled").fill("15");
    await shots.take(player, "tools-roll-card");
    await card.getByRole("button", { name: "Send", exact: true }).tap();
    await card.waitFor({ state: "detached" });
    const chip = player.getByRole("button", { name: /^Str or Dex save: sent Dex 15\. Pass\./ });
    await chip.waitFor();
    await shots.take(player, "tools-roll-chip");

    const live = dm.getByRole("group", { name: "Roll request: Str or Dex save, DC 12" });
    await live.getByText("1 of 1 answered").waitFor();
    const answer = dmSocket.state!.rolls[run.rollId]!.targets[0]!;
    assert.deepEqual({ choice: answer.choice, total: answer.total, result: answer.result }, { choice: 1, total: 15, result: "pass" });
    await live.getByRole("button", { name: "Close the Str or Dex save request" }).click();
    await chip.waitFor({ state: "detached" });
    await waitFor("the request gone for the player", () => Object.keys(playerSocket.state?.rolls ?? {}).length === 0 || null);
    assert.ok(tvSocket.received.every((f) => !f.includes(run.rollId)), "the display received the roll request");
  });

  test("5. a secret block reaches the player only once the DM reveals it", async () => {
    await openPhonePanel(player, "Journal");
    await player.getByRole("button", { name: /^Old map/ }).tap();
    await player.getByText("A faded map of the crypt.").waitFor();
    assert.equal(await player.getByText(SECRET).count(), 0);
    assert.ok(!playerSocket.everSaw(SECRET), "the secret reached the player before the reveal");
    assert.ok(!tvSocket.everSaw(SECRET), "the secret reached the display before the reveal");

    await openSideTab(dm, "Journal");
    await dm.getByRole("button", { name: /^Old map/ }).click();
    run.revealedAt = playerSocket.received.length;
    await dm.getByRole("region", { name: "Secret" }).getByRole("button", { name: "Reveal" }).click();
    await dm.getByRole("region", { name: "Revealed secret" }).waitFor();
    await player.getByText(SECRET).waitFor();
    await shots.take(player, "tools-secret-revealed");
    await closePhoneSheet(player);
  });

  test("6. a pin opens its page for the player, and deleting the page keeps the pin from players", async () => {
    await dm.getByRole("button", { name: "Pin to the map" }).click();
    await dm.getByText("Tap the map to place the pin for Old map.").waitFor();
    const scene = dmSocket.state!.scenes[run.sceneId]!;
    await tapCell(dm, scene.bounds, { x: 8, y: 3 });
    const pin = await waitFor("the pin in the DM's state", () => Object.values(dmSocket.state?.pins ?? {})[0]);
    run.pinId = pin.id;
    assert.equal(pin.pageId, run.pageId);
    assert.equal(pin.visibility, "all", "a pin from a page starts visible, and its page decides who sees it");
    await dm.getByRole("button", { name: "Close without saving" }).click();

    // The keyboard reaches the Pin tool (M) and back to Select (V).
    await dm.keyboard.press("m");
    await dm.getByRole("button", { name: "Pin", exact: true, pressed: true }).waitFor();
    await dm.keyboard.press("v");
    await dm.getByRole("button", { name: "Select", exact: true, pressed: true }).waitFor();

    await waitFor("the pin for the player and the display", () => (playerSocket.state?.pins[run.pinId] && tvSocket.state?.pins[run.pinId]) || null);
    const tip = await pagePoint(player, scene.bounds, { x: pin.x, y: pin.y });
    // The marker stands 28 px tall above its tip, and a tap finds its middle.
    await player.mouse.click(tip.x, tip.y - 14);
    await player.getByRole("heading", { name: "Old map" }).waitFor();
    await shots.take(player, "tools-pin-opened-page");
    await closePhoneSheet(player);

    const deletedAt = { player: playerSocket.received.length, tv: tvSocket.received.length };
    await dm.getByRole("button", { name: "Delete page" }).click();
    await dm.getByRole("button", { name: "Delete the page?" }).click();
    await waitFor("the pin DM only", () => {
      const p = dmSocket.state?.pins[run.pinId];
      return p && p.visibility === "dm" && p.pageId === undefined ? p : null;
    });
    await waitFor("the pin gone for the player and the display", () => (!playerSocket.state?.pins[run.pinId] && !tvSocket.state?.pins[run.pinId]) || null);
    assert.equal(playerSocket.state?.journal[run.pageId], undefined);
    for (const [label, watch, from] of [["player", playerSocket, deletedAt.player], ["display", tvSocket, deletedAt.tv]] as const) {
      for (const f of framesOf(watch, from)) {
        for (const c of f.changes ?? []) assert.ok(!(c.key.includes(run.pinId) && !c.deleted), `the ${label} got the pin back after the page's deletion`);
      }
    }
  });

  test("7. the X-card from the Menu shows on all three, and a tap closes it on the display", async () => {
    await openPhonePanel(player, "Menu");
    await player.getByRole("button", { name: /^X-card/ }).tap();
    run.firstXcardAt = Date.now();
    await player.getByRole("button", { name: "Send the X-card" }).tap();
    const text = "Someone tapped the X-card. Edit out what just happened, with no questions asked.";
    for (const page of [dm, player, tv]) await page.getByRole("dialog", { name: "X-card" }).getByText(text).waitFor();
    await shots.take(tv, "tools-xcard-display");
    await shots.take(player, "tools-xcard-player");
    await dm.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "Pause the game" }).waitFor();
    await dm.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "Dismiss" }).click();
    await player.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "Dismiss" }).tap();
    await tv.mouse.click(640, 360);
    await tv.getByRole("dialog", { name: "X-card" }).waitFor({ state: "detached" });
    assert.equal(await tv.getByRole("menu").count(), 0, "the tap that closed the X-card also opened the menu");
    for (const watch of [dmSocket, playerSocket, tvSocket]) {
      const card = framesOf(watch).find((f) => f.t === "xcard");
      assert.ok(card, `${watch.label} got no X-card`);
      assert.deepEqual(Object.keys(card).sort(), ["at", "t"], "the X-card names someone");
    }
    await closePhoneSheet(player);
  });

  test("8. a player behind the pause screen can send the X-card, and the display shows it there too", async () => {
    await ops.send({ t: "view.blackout", blackout: true });
    await player.getByText("The DM has paused the game.").waitFor();
    await tv.getByText("The DM has paused the game.").waitFor();
    await player.getByRole("button", { name: /^X-card/ }).tap();
    // Taps within 10 s of the last card merge into it.
    const wait = run.firstXcardAt + 10_500 - Date.now();
    if (wait > 0) await player.waitForTimeout(wait);
    await player.getByRole("button", { name: "Send the X-card" }).tap();
    for (const page of [dm, player, tv]) await page.getByRole("dialog", { name: "X-card" }).waitFor();
    await shots.take(player, "tools-xcard-paused-player");
    await dm.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "The game is paused" }).waitFor();
    await dm.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "Dismiss" }).click();
    await player.getByRole("dialog", { name: "X-card" }).getByRole("button", { name: "Dismiss" }).tap();
    await tv.keyboard.press("Enter");
    await tv.getByRole("dialog", { name: "X-card" }).waitFor({ state: "detached" });
    await ops.send({ t: "view.blackout", blackout: false });
    await player.getByText("The DM has paused the game.").waitFor({ state: "detached" });
  });

  test("9. the goblin gets a game-icons.net icon, which the player and the display draw", async () => {
    const scene = dmSocket.state!.scenes[run.sceneId]!;
    const goblin = dmSocket.state!.tokens[run.goblinId]!;
    await tapCell(dm, scene.bounds, { x: goblin.x, y: goblin.y });
    await dm.getByRole("tab", { name: "Token" }).click();
    await dm.getByRole("button", { name: "Change image" }).first().click();
    const picker = dm.getByRole("dialog").filter({ has: dm.getByRole("tab", { name: "Icons" }) });
    await picker.getByRole("tab", { name: "Icons", selected: true }).waitFor();
    await picker.getByLabel("Search icons").fill("goblin");
    await picker.getByRole("list", { name: "Icons" }).getByRole("button").first().click();
    await shots.take(dm, "tools-icon-picker");
    await picker.getByRole("button", { name: "Use", exact: true }).click();
    const image = await waitFor("the icon on the goblin", () => {
      const img = dmSocket.state?.tokens[run.goblinId]?.image;
      return img && "icon" in img ? img : null;
    });
    assert.match(image.icon, /goblin/);
    for (const watch of [playerSocket, tvSocket]) {
      await waitFor(`the icon for the ${watch.label}`, () => {
        const img = watch.state?.tokens[run.goblinId]?.image;
        return img && "icon" in img && img.icon === image.icon ? img : null;
      });
    }
    await waitFor("the icon's file on the display", () => tvResponses.find((r) => r.url.includes(`/game-icons/`) && r.url.endsWith(`/${image.icon}.svg`) && r.status === 200));
    await shots.take(tv, "tools-icon-display");
  });

  test("10. the log exports as Markdown, the player's without the hidden monster", async () => {
    // The Dice tab took the Log's place in the row, so the Log may stand behind More (docs/design-v1-dice.md 8.1).
    await openSideTab(dm, "Log");
    await dm.getByRole("button", { name: "Export", exact: true }).click();
    const dmFile = await exportEverything(dm);
    assert.match(dmFile, new RegExp(`^# ${run.roomName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: log`));
    assert.ok(dmFile.includes("Thorn rolled 15 on a Dexterity saving throw against DC 12: pass."), dmFile);
    assert.ok(dmFile.includes(SHADOW), "the DM's file names the hidden monster");
    await shots.take(dm, "tools-log-export");
    await dm.keyboard.press("Escape");

    await openPhonePanel(player, "Log");
    await player.getByRole("button", { name: "Export", exact: true }).tap();
    const playerFile = await exportEverything(player);
    assert.ok(playerFile.includes("Thorn rolled 15 on a Dexterity saving throw against DC 12: pass."), playerFile);
    assert.ok(!playerFile.includes(SHADOW), "the player's file names the hidden monster");
  });

  test("11. nothing hidden reached the player or the display, and no page logged an error", async () => {
    for (const watch of [playerSocket, tvSocket]) {
      assert.ok(!watch.everSaw(run.shadowId), `the hidden monster's id reached the ${watch.label}`);
      assert.ok(!watch.everSaw(SHADOW), `the hidden monster's name reached the ${watch.label}`);
      assert.ok(!watch.everSaw(run.shadowImage), `the hidden monster's image reached the ${watch.label}`);
    }
    assert.ok(playerSocket.received.slice(0, run.revealedAt).every((f) => !f.includes(SECRET)));
    assert.ok(tvResponses.every((r) => !r.url.includes(run.shadowImage)), "the display asked for the hidden monster's image");
    assert.deepEqual(tvResponses.filter((r) => r.url.includes("/api/assets/")), [], "the display used the room's own image route");
    const state = tvSocket.state as RoomState;
    assert.deepEqual(Object.keys(state.rolls ?? {}), [], "the display holds a roll request");
    assert.deepEqual([dmConsole.errors, playerConsole.errors, tvConsole.errors], [[], [], []]);
  });
});
