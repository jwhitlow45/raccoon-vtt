import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, readCamera, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * Layout and hierarchy (docs/design-v1-layout-hierarchy.md section 10):
 *
 * 1. On a short screen held sideways a tool whose options run past one row
 *    opens them in a rail on the left of the map, and the one-row tools
 *    keep their bar at the foot until their row wraps.
 * 2. Everywhere else the options stay at the foot.
 * 3. The alerts column, its summary row, "Viewing as Pat" and a player's
 *    roll card keep right of the rail.
 * 4. Fit keeps the scene clear of the rail.
 * 5. From 900 px up the side panel hides and comes back, by its buttons
 *    and by S, and this device remembers it.
 * 6. A short wide layout starts with it hidden, and shown, its tabs scroll
 *    in one row.
 * 7. A phone's sideways sheet hides and comes back with its state, and on
 *    a screen too short for it, it opens modal over the whole screen with
 *    the room's notices inside it.
 * 8. The handout viewer and the Library's View.
 * 9. The hierarchy moves.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus eleven: plus eight is the
 * reach sweep's. The other environment variables are the smoke run's
 * (smoke.e2e.ts). Chrome only: that a hidden sheet or side panel keeps its
 * scroll and a half-typed draft in iOS Safari is checked by hand on a phone.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 11;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-layout-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;

before(async () => {
  server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
  browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
});

after(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(work, { recursive: true, force: true });
});

// ------------------------------------------------------------ shared helpers

type Box = { x: number; y: number; width: number; height: number };
type Insets = { top?: number; side?: number; bottom?: number };

/** The window, its safe areas and the interface size, reloading only when the size changes. */
async function view(page: Page, cdp: CDPSession, size: { width: number; height: number }, insets: Insets = {}): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: insets.top ?? 0, bottom: insets.bottom ?? 0, left: insets.side ?? 0, right: insets.side ?? 0 } });
  await page.setViewportSize(size);
  await page.waitForTimeout(250);
}

async function reloadAt(page: Page, scale: number): Promise<void> {
  const now = await page.evaluate(() => localStorage.getItem("rvtt.uiScale"));
  if (now !== String(scale)) await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await page.waitForTimeout(300);
}

async function box(target: Locator): Promise<Box> {
  const b = await target.boundingBox();
  assert.ok(b, "the element has no box");
  return b;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

/**
 * The page's document as code run in the browser reads it. The e2e files
 * compile without the DOM's types, so each evaluate names what it uses.
 */
type DomRect = { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number };
type DomEl = {
  tagName: string;
  id: string;
  textContent: string | null;
  hidden: boolean;
  isConnected: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  dataset: Record<string, string | undefined>;
  labels?: ArrayLike<DomEl> | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): DomRect;
  closest(selector: string): DomEl | null;
  contains(el: DomEl | null): boolean;
  querySelector(selector: string): DomEl | null;
  querySelectorAll(selector: string): ArrayLike<DomEl>;
};
type Dom = {
  document: {
    activeElement: DomEl | null;
    body: DomEl;
    querySelector(selector: string): DomEl | null;
    querySelectorAll(selector: string): ArrayLike<DomEl>;
    elementFromPoint(x: number, y: number): DomEl | null;
  };
  requestAnimationFrame(callback: () => void): number;
  getComputedStyle(el: DomEl): { paddingRight: string; paddingLeft: string };
  innerWidth: number;
  innerHeight: number;
};

/** What has focus: its tag, role and name. */
function focused(page: Page): Promise<{ tag: string; role: string | null; name: string }> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as Dom).document.activeElement;
    if (!el) return { tag: "", role: null, name: "" };
    const name = el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? el.textContent ?? "";
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: name.trim() };
  });
}

/** What takes a tap at the middle of `target` and at each edge's middle, for a failure's message. */
function whatTakes(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const e = el as unknown as DomEl;
    const r = e.getBoundingClientRect();
    const w = globalThis as unknown as Dom;
    const at = (x: number, y: number) => {
      const top = w.document.elementFromPoint(x, y);
      return top ? `${top.tagName.toLowerCase()}[${top.getAttribute("aria-label") ?? top.textContent?.trim().slice(0, 20) ?? ""}]${e.contains(top) ? "" : "!"}` : "none";
    };
    return [at(r.left + r.width / 2, r.top + r.height / 2), at(r.left + r.width / 2, r.top + 3), at(r.left + r.width / 2, r.bottom - 3), at(r.left + 3, r.top + r.height / 2), at(r.right - 3, r.top + r.height / 2)].join(", ") + ` box ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  });
}

/**
 * Whether `target` takes a tap at its middle and just inside the middle of
 * each edge, read in the page from its own rectangle. Playwright's boxes of
 * an element in a zoomed dialog in the browser's top layer, the very short
 * sheet at 130%, came out off by the zoom.
 */
async function reachable(target: Locator): Promise<boolean> {
  if ((await target.count()) === 0) return false;
  return target.evaluate((el) => {
    const e = el as unknown as DomEl;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const w = globalThis as unknown as Dom;
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width / 2, r.top + 3],
      [r.left + r.width / 2, r.bottom - 3],
      [r.left + 3, r.top + r.height / 2],
      [r.right - 3, r.top + r.height / 2],
    ] as const;
    return points.every(([x, y]) => e.contains(w.document.elementFromPoint(x, y)));
  });
}

/** A target's rectangle as the page reads it, in the window's pixels. */
function rect(target: Locator): Promise<Box> {
  return target.evaluate((el) => {
    const r = (el as unknown as DomEl).getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

function topBar(page: Page): Locator {
  return page.locator("header:has(h1)").first();
}

function toolbar(page: Page): Locator {
  return page.getByRole("navigation", { name: "Tools" });
}

async function pickTool(page: Page, name: string): Promise<void> {
  await toolbar(page).getByRole("button", { name, exact: true }).click();
}

function options(page: Page, tool: string): Locator {
  return page.getByRole("toolbar", { name: `${tool} options` });
}

/** The DM's or a player's actor, for a creature made by op. */
function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function picture(rgb: [number, number, number], w = 500, h = 400): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

// ------------------------------------------------------------ layout and hierarchy (cases 1 to 7, 9)

describe("raccoon-vtt: layout and hierarchy", { timeout: 1_200_000 }, () => {
  /** The DM at a computer with a mouse. */
  let deskContext: BrowserContext;
  let desk: Page;
  let deskCdp: CDPSession;
  /** The same DM on a phone, signed in by the DM link. */
  let phoneContext: BrowserContext;
  let phone: Page;
  let phoneCdp: CDPSession;
  /** Pat, a player, on a phone. */
  let playerContext: BrowserContext;
  let player: Page;
  let playerCdp: CDPSession;
  let ops: OpSocket;
  const deskSocket = new SocketWatch("desk");
  const phoneSocket = new SocketWatch("phone");
  const playerSocket = new SocketWatch("player");
  const consoles = { desk: new ConsoleWatch("desk"), phone: new ConsoleWatch("phone"), player: new ConsoleWatch("player") };

  const run = {
    roomId: "",
    roomName: `E2E layout ${new Date().toISOString().slice(0, 19)}`,
    dmLink: "",
    password: "",
    sceneId: "",
    patId: "",
    thorn: { id: randomUUID(), characterId: randomUUID(), entryId: randomUUID() },
    goblin: { id: randomUUID(), entryId: randomUUID() },
    hag: { id: randomUUID(), entryId: randomUUID() },
    lore: randomUUID(),
    phases: [randomUUID(), randomUUID()],
  };

  async function join(context: BrowserContext, name: string, color: string): Promise<string> {
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    return ((await done.json()) as { member: { id: string } }).member.id;
  }

  async function upload(kind: "map" | "handout" | "token", data: Buffer): Promise<{ id: string; width: number; height: number }> {
    const res = await deskContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
    assert.ok(res.ok(), `the upload answered ${res.status()}`);
    const row = (await res.json()) as { id: string; width: number; height: number };
    return row;
  }

  async function startFight(first: "goblin" | "thorn" = "goblin"): Promise<void> {
    await ops.send({ t: "encounter.end" }).catch(() => undefined);
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.goblin.entryId, tokenId: run.goblin.id, value: first === "goblin" ? 18 : 10 },
        { id: run.thorn.entryId, tokenId: run.thorn.id, value: first === "thorn" ? 18 : 15 },
        { id: run.hag.entryId, tokenId: run.hag.id, value: 5 },
      ],
    });
    await ops.send({ t: "encounter.next" });
  }

  async function endFight(): Promise<void> {
    await ops.send({ t: "encounter.end" }).catch(() => undefined);
  }

  before(async () => {
    deskContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    desk = await deskContext.newPage();
    consoles.desk.attach(desk);
    await deskSocket.attach(deskContext, desk);
    deskCdp = await deskContext.newCDPSession(desk);
    phoneContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    phone = await phoneContext.newPage();
    consoles.phone.attach(phone);
    await phoneSocket.attach(phoneContext, phone);
    phoneCdp = await phoneContext.newCDPSession(phone);
    playerContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    player = await playerContext.newPage();
    consoles.player.attach(player);
    await playerSocket.attach(playerContext, player);
    playerCdp = await playerContext.newCDPSession(player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
    ops?.close();
    if (run.roomId && deskContext) {
      try {
        await deskContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await deskContext?.close();
    await phoneContext?.close();
    await playerContext?.close();
  });

  test("1. a DM's room on a computer and a phone, Pat's Thorn, a goblin, a concentrating Hag, a journal page and a scene with two phases", async () => {
    await desk.goto(`${server.origin}/`);
    await desk.getByLabel("Room name").fill(run.roomName);
    await desk.getByLabel("Your name").fill("Dana the DM");
    run.password = await desk.getByLabel("Player password").inputValue();
    await desk.getByRole("button", { name: "Create room" }).click();
    await desk.getByRole("heading", { name: "Save your DM link" }).waitFor();
    run.dmLink = (await desk.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(run.dmLink);
    assert.ok(match, `DM link looks wrong: ${run.dmLink}`);
    run.roomId = match[1]!.replace("-", "");
    await desk.getByLabel("I saved my DM link").check();
    await desk.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => deskSocket.state);
    run.sceneId = deskSocket.state!.meta.playerSceneId!;

    run.patId = await join(playerContext, "Pat", "#30a46c");

    const cookie = (await deskContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: 8, y: 6, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await ops.send(token(run.goblin.id, { kind: "monster", name: "Goblin 1", x: 12, y: 9, disposition: "hostile", actor: { inline: actor(7) } }));
    await ops.send(token(run.hag.id, { kind: "monster", name: "Hag", x: 3, y: 14, disposition: "hostile", actor: { inline: actor(900) } }));
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.hag.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    await ops.send({ t: "journal.create", page: { id: run.lore, title: "Lore", access: "all", blocks: [{ id: randomUUID().replace(/-/g, "").slice(0, 12), text: "The citadel fell." }] } });

    // Two map phases on the scene, for the DM's Phase menu (case 9).
    const day = await upload("map", await picture([150, 140, 120]));
    const night = await upload("map", await picture([40, 50, 90]));
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
    await waitFor("the scene's two phases", () => (deskSocket.state?.scenes[run.sceneId]?.phases?.length === 2 ? true : null));

    // The DM link signs the phone in as the same DM.
    consoles.phone.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/, /status of 409 .*\/api\/rooms\/[0-9A-Z]{8}\/dm\)$/];
    await phone.goto(run.dmLink);
    await phone.getByRole("button", { name: /Dana the DM/ }).click();
    await waitFor("the DM phone's snapshot", () => phoneSocket.state);
    await phone.getByRole("status", { name: "Connected" }).first().waitFor();
    consoles.phone.allow = [];

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Thorn on the player's map", () => playerSocket.state?.tokens[run.thorn.id]);
  });

  /** The side panel from 900 px up, by the tab list it holds. */
  function sidePanel(page: Page): Locator {
    return page.locator('aside:has([role="tablist"][aria-label="Panels"])');
  }

  /** A Lore page edit from the DM's other device, which marks it unread wherever it is not on screen. */
  async function editLore(text: string): Promise<void> {
    await ops.send({ t: "journal.update", pageId: run.lore, patch: { blocks: [{ id: randomUUID().replace(/-/g, "").slice(0, 12), text }] } });
  }

  // ------------------------------------------------ the rail (cases 1, 2 and 4)

  const RAIL_TOOLS = { dm: ["Ruler", "Area", "Draw", "Fog", "Map builder", "Line up grid"], player: ["Ruler", "Area", "Draw"] } as const;
  /** The map's height between the top bar and the toolbar with no options, in layout px (section 2.1), which the rail leaves whole. */
  const MAP_HEIGHT: Record<string, number> = { "844x390@1": 256, "844x390@1.3": 166, "667x375@1": 262, "667x375@1.3": 176 };
  const RAIL_SIZES = [
    { width: 844, height: 390, insets: { side: 47, bottom: 21 } },
    { width: 667, height: 375, insets: {} },
  ];

  /** Whether controls stand on more than one line, by their boxes as drawn. */
  function oneLine(target: Locator): Promise<boolean> {
    return target.evaluate((el) => {
      const boxes = Array.from((el as unknown as DomEl).querySelectorAll("button, input, select"), (c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
      return !boxes.some((a) => boxes.some((b) => a.top >= b.bottom - 0.5));
    });
  }

  /** The map's height left between the top bars and the toolbar, in screen px. */
  async function mapBetweenBars(page: Page): Promise<number> {
    return (await box(toolbar(page))).y - ((await box(topBar(page))).y + (await box(topBar(page))).height);
  }

  async function selectToken(page: Page, socket: SocketWatch, id: string, name: string): Promise<Locator> {
    const t = socket.state!.tokens[id]!;
    const p = await pagePoint(page, socket.state!.scenes[run.sceneId]!.bounds, { x: t.x + 0.5, y: t.y + 0.5 });
    await page.touchscreen.tap(p.x, p.y);
    const bar = page.getByRole("dialog", { name: `${name} actions` });
    await bar.waitFor();
    return bar;
  }

  /** A rail tool's options in the rail: left of the map's middle, from under the top bars to the toolbar, never sideways, each control in reach once scrolled to. */
  async function expectRail(page: Page, tool: string, label: string): Promise<void> {
    const rail = options(page, tool);
    await rail.waitFor();
    assert.equal(await rail.getAttribute("data-rvtt-options"), "rail", `${label}: ${tool} is in the rail`);
    const b = await box(rail);
    const viewport = page.viewportSize()!;
    const top = await box(topBar(page));
    const bar = await box(toolbar(page));
    assert.ok(Math.abs(b.x) <= 0.5, `${label}: ${tool}'s rail starts at the screen's left edge`);
    assert.ok(b.x + b.width <= viewport.width / 2 + 0.5, `${label}: ${tool}'s rail is ${b.width} px wide, past the map's middle`);
    assert.ok(Math.abs(b.y - (top.y + top.height)) <= 1.5, `${label}: ${tool}'s rail starts at ${b.y}, under the top bars at ${top.y + top.height}`);
    assert.ok(Math.abs(b.y + b.height - bar.y) <= 1.5, `${label}: ${tool}'s rail ends at ${b.y + b.height}, the toolbar starts at ${bar.y}`);
    const sideways = await rail.evaluate((el) => (el as unknown as DomEl).scrollWidth - (el as unknown as DomEl).clientWidth);
    assert.ok(sideways <= 0, `${label}: ${tool}'s rail scrolls sideways by ${sideways} px`);
    const controls = rail.locator("button:visible, input:visible, select:visible");
    for (let i = 0; i < (await controls.count()); i++) {
      const c = controls.nth(i);
      await c.scrollIntoViewIfNeeded();
      if (!(await wholeInReach(c))) assert.fail(`${label}: ${tool}'s control "${(await c.getAttribute("aria-label")) ?? (await c.textContent())?.trim()}" takes no tap once scrolled to: ${await whatTakes(c)}`);
    }
  }

  async function expectFoot(page: Page, tool: string, label: string): Promise<void> {
    const foot = options(page, tool);
    await foot.waitFor();
    assert.equal(await foot.getAttribute("data-rvtt-options"), "foot", `${label}: ${tool} is at the foot`);
  }

  for (const size of RAIL_SIZES) {
    for (const scale of [1, 1.3]) {
      const label = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
      test(`1. ${label}: the rail tools open their options in the rail, and the one-row tools keep the foot`, async () => {
        for (const [page, cdp, role] of [
          [phone, phoneCdp, "dm"],
          [player, playerCdp, "player"],
        ] as const) {
          await view(page, cdp, size, size.insets);
          await reloadAt(page, scale);
          const who = `${label}, ${role === "dm" ? "the DM" : "a player"}`;
          await pickTool(page, "Select");
          const bare = await mapBetweenBars(page);
          const doc = MAP_HEIGHT[`${size.width}x${size.height}@${scale}`]! * scale;
          assert.ok(Math.abs(bare - doc) <= 2, `${who}: the map between the bars is ${bare} px, section 2.1 measured ${doc}`);
          for (const tool of RAIL_TOOLS[role]) {
            await pickTool(page, tool);
            await expectRail(page, tool, who);
            assert.ok(Math.abs((await mapBetweenBars(page)) - bare) <= 1, `${who}: ${tool} in the rail takes none of the map's height`);
          }
          if (scale === 1.3 && size.width === 844) await shots.take(page, `layout-rail-${role}-844x390-130-${RAIL_TOOLS[role].at(-1)!.replace(/ /g, "-")}`);
          for (const tool of role === "dm" ? ["Ping", "Add token"] : ["Ping"]) {
            await pickTool(page, tool);
            await expectFoot(page, tool, who);
            assert.equal(await oneLine(options(page, tool)), true, `${who}: ${tool}'s controls stand on one line`);
          }
          if (role === "dm") {
            await pickTool(page, "Pin");
            if (scale === 1) {
              await expectFoot(page, "Pin", who);
              assert.equal(await oneLine(options(page, "Pin")), true, `${who}: Pin's controls stand on one line`);
            } else await expectRail(page, "Pin", `${who}, where Pin's row wraps`);
          }
          // Select several stays at the foot, one row, always.
          await pickTool(page, "Select");
          const bar = role === "dm" ? await selectToken(page, phoneSocket, run.goblin.id, "Goblin 1") : await selectToken(page, playerSocket, run.thorn.id, "Thorn");
          await bar.getByRole("button", { name: "Select several", exact: true }).tap();
          await expectFoot(page, "Select", who);
          assert.equal(await oneLine(options(page, "Select")), true, `${who}: Select several is one row`);
          // A short screen's compact token bar covers the Select several bar (docs/design-v1-bar-dock.md 1.4): Close it first.
          await bar.getByRole("button", { name: "Close", exact: true }).first().tap();
          await options(page, "Select").getByRole("button", { name: "Done", exact: true }).tap();
          await options(page, "Select").waitFor({ state: "detached" });
        }
      });
    }
  }

  test("1. 844 x 390 at 130%: Pin picked for the first time is never painted at the foot", async () => {
    await view(phone, phoneCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
    await reloadAt(phone, 1.3);
    await phone.evaluate(() => {
      const w = globalThis as unknown as Dom & { placesSeen: string[] };
      w.placesSeen = [];
      const look = () => {
        const bar = w.document.querySelector('[role="toolbar"][aria-label="Pin options"]');
        if (bar) w.placesSeen.push(bar.dataset.rvttOptions ?? "none");
        w.requestAnimationFrame(look);
      };
      w.requestAnimationFrame(look);
    });
    await pickTool(phone, "Pin");
    await options(phone, "Pin").waitFor();
    await phone.waitForTimeout(500);
    const seen = await phone.evaluate(() => (globalThis as unknown as { placesSeen: string[] }).placesSeen);
    assert.ok(seen.length > 0, "no frame was seen");
    assert.deepEqual([...new Set(seen)], ["rail"], "a frame showed Pin's options at the foot");
    await pickTool(phone, "Select");
  });

  test("2. the options stay at the foot at 480 x 320, upright and on a computer", async () => {
    const sizes = [
      { size: { width: 480, height: 320 }, insets: { side: 47, bottom: 21 }, scales: [1, 1.3] },
      { size: { width: 390, height: 844 }, insets: { top: 47, bottom: 34 }, scales: [1] },
    ];
    for (const { size, insets, scales } of sizes) {
      for (const scale of scales) {
        await view(phone, phoneCdp, size, insets);
        await reloadAt(phone, scale);
        for (const tool of ["Ruler", "Area"]) {
          await pickTool(phone, tool);
          await expectFoot(phone, tool, `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`);
        }
        await pickTool(phone, "Select");
      }
    }
    await pickTool(desk, "Ruler");
    await expectFoot(desk, "Ruler", "1280 x 800");
    await pickTool(desk, "Select");
  });

  test("2. turning the phone with a rail tool moves its options between the rail and the foot on the same element", async () => {
    await view(phone, phoneCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
    await reloadAt(phone, 1);
    await pickTool(phone, "Area");
    await expectRail(phone, "Area", "844 x 390");
    await options(phone, "Area").evaluate((el) => ((el as unknown as { marked: boolean }).marked = true));
    await view(phone, phoneCdp, { width: 390, height: 844 }, { top: 47, bottom: 34 });
    await expectFoot(phone, "Area", "turned upright");
    await view(phone, phoneCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
    await expectRail(phone, "Area", "turned back");
    assert.equal(await options(phone, "Area").evaluate((el) => (el as unknown as { marked?: boolean }).marked === true), true, "the options were never mounted again");
    await pickTool(phone, "Select");
  });

  /*
   * Case 3. Every rail tool takes the pointer, so the token bar never shows
   * beside the rail: the column shares the right with nothing but notices.
   */
  for (const size of [
    { width: 844, height: 390, insets: { side: 47, bottom: 21 } },
    { width: 667, height: 375, insets: {} },
  ]) {
    test(`3. ${size.width} x ${size.height} at 130%: the alerts column and its summary row keep right of the rail, every card's buttons in reach, and a spanning notice starts right of it`, async () => {
      await view(phone, phoneCdp, size, size.insets);
      await reloadAt(phone, 1.3);
      await startFight();
      await pickTool(phone, "Area");
      const rail = await box(options(phone, "Area"));
      await ops.send({ t: "actor.hp", target: { tokenId: run.hag.id }, change: { kind: "damage", amount: 1 } });
      await ops.send({ t: "actor.hp", target: { tokenId: run.hag.id }, change: { kind: "damage", amount: 1 } });
      const cards = phone.locator('[data-alert="concentration"]');
      await cards.first().waitFor({ state: "attached" });
      await phone.waitForTimeout(400);
      const row = phone.getByRole("button", { name: /^Concentration check/ });
      const label = `${size.width} x ${size.height} at 130%`;
      const checkColumn = async (when: string) => {
        for (let i = 0; i < (await cards.count()); i++) {
          const card = cards.nth(i);
          if (!(await card.isVisible())) continue;
          // The column scrolls as a whole: a card below its foot comes into view first.
          await card.scrollIntoViewIfNeeded();
          assert.ok(!intersects(await box(card), rail), `${label}, ${when}: a card meets the rail`);
          for (const name of ["Passed", "Failed"]) {
            const b = card.getByRole("button", { name, exact: true });
            if (!(await waitFor(`${name} in reach`, () => reachable(b), 2000).catch(() => false))) assert.fail(`${label}, ${when}: ${name} takes no tap: ${await whatTakes(b)}`);
          }
        }
        if ((await row.count()) > 0 && (await row.first().isVisible())) assert.ok(!intersects(await box(row.first()), rail), `${label}, ${when}: the summary row meets the rail`);
      };
      await checkColumn("the column");
      if ((await row.count()) > 0 && (await row.first().isVisible())) {
        await row.first().tap();
        await phone.waitForTimeout(300);
        await checkColumn("opened from its summary row");
      }
      await shots.take(phone, `layout-rail-column-${size.width}x${size.height}-130`);
      for (let i = 0; i < 2; i++) {
        const card = cards.first();
        if ((await card.count()) > 0 && (await card.isVisible())) await card.getByRole("button", { name: "Passed", exact: true }).tap();
        await phone.waitForTimeout(200);
      }
      await endFight();
      // A notice that lasts spans the free area, right of the rail.
      await pickTool(phone, "Select");
      await openPanel(phone, "Scenes");
      await sheet(phone, "Scenes").getByRole("button", { name: "Save current view" }).tap();
      const framing = phone.getByRole("group", { name: "Starting view" });
      await framing.waitFor();
      await pickTool(phone, "Area");
      await phone.waitForTimeout(300);
      const notice = await box(framing);
      const railNow = await box(options(phone, "Area"));
      assert.ok(notice.x >= railNow.x + railNow.width - 0.5, `${label}: the Starting view notice starts at ${notice.x}, over the rail that ends at ${railNow.x + railNow.width}`);
      await shots.take(phone, `layout-rail-notice-${size.width}x${size.height}-130`);
      await framing.getByRole("button", { name: "Cancel" }).tap();
      await pickTool(phone, "Select");
    });
  }

  test("3. 667 x 375 at 130%: a player's roll card at the foot starts right of the rail, and \"Viewing as Pat\" keeps off the preview's rail", async () => {
    await view(player, playerCdp, { width: 667, height: 375 });
    await reloadAt(player, 1.3);
    await pickTool(player, "Area");
    const rail = await box(options(player, "Area"));
    const id = randomUUID();
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    const card = player.getByRole("dialog", { name: "The DM asks for a roll" });
    await card.waitFor();
    const cardBox = await box(card);
    assert.ok(cardBox.x >= rail.x + rail.width - 0.5, `the roll card starts at ${cardBox.x}, over the rail that ends at ${rail.x + rail.width}`);
    await shots.take(player, "layout-rail-roll-card-667x375-130");
    await ops.send({ t: "roll.close", rollIds: [id] });
    await pickTool(player, "Select");

    await view(phone, phoneCdp, { width: 667, height: 375 });
    await reloadAt(phone, 1.3);
    await openPanel(phone, "DM");
    await sheet(phone, "DM").getByRole("button", { name: "View", exact: true }).tap();
    const preview = phone.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    await preview.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Area", exact: true }).click();
    const previewRail = preview.getByRole("toolbar", { name: "Area options" });
    await previewRail.waitFor();
    await phone.waitForTimeout(300);
    const banner = preview.getByText(/^Viewing as Pat/);
    assert.ok(!intersects(await box(banner), await box(previewRail)), "\"Viewing as Pat\" meets the rail");
    await shots.take(phone, "layout-rail-preview-notice-667x375-130");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await sheet(phone, "DM").getByRole("button", { name: "Close DM" }).tap();
  });

  test("4. Fit with a rail tool leaves no part of the scene under the rail", async () => {
    await view(phone, phoneCdp, { width: 667, height: 375 });
    await reloadAt(phone, 1.3);
    await pickTool(phone, "Area");
    const rail = await box(options(phone, "Area"));
    await phone.getByRole("button", { name: "Fit the map to the screen" }).tap();
    await phone.waitForTimeout(400);
    const cam = await readCamera(phone);
    assert.ok(cam);
    const canvas = await box(phone.locator(".konvajs-content").first());
    const bounds = phoneSocket.state!.scenes[run.sceneId]!.bounds;
    const sceneLeft = canvas.x + cam.x;
    const sceneRight = canvas.x + cam.x + bounds.w * cam.scale;
    assert.ok(sceneLeft >= rail.x + rail.width - 0.5, `the scene starts at ${sceneLeft}, under the rail that ends at ${rail.x + rail.width}`);
    assert.ok(sceneRight <= canvas.x + canvas.width + 0.5, "the scene fits the map's width right of the rail");
    await shots.take(phone, "layout-rail-fit-667x375-130");
    await pickTool(phone, "Select");
  });

  // ------------------------------------------------ a phone's sideways sheet (case 7)

  function sheet(page: Page, title: string): Locator {
    return page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  }

  function sheetOpen(page: Page, title: string): Promise<boolean> {
    return sheet(page, title).evaluate((el) => (el as unknown as { open: boolean }).open);
  }

  /** Opens a panel from the phone's list of panels. */
  async function openPanel(page: Page, title: string): Promise<void> {
    await toolbar(page).getByRole("button", { name: /^Panels/ }).tap();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).tap();
    await sheet(page, title).waitFor();
  }

  test("7. 844 x 390: a tap on the turn strip opens Initiative and leaves focus on the strip, and its Close goes back to the token bar", async () => {
    await view(phone, phoneCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
    await reloadAt(phone, 1);
    await startFight();
    const bar = await selectToken(phone, phoneSocket, run.goblin.id, "Goblin 1");
    const strip = topBar(phone).getByRole("button", { name: /^Initiative, round/ });
    await strip.focus();
    await strip.tap();
    await sheet(phone, "Initiative").waitFor();
    assert.equal(await sheet(phone, "Initiative").getAttribute("aria-modal"), null, "a sheet beside the map is no modal");
    assert.match((await focused(phone)).name, /^Initiative, round/, "focus stays on the strip");
    await sheet(phone, "Initiative").getByRole("button", { name: "Close Initiative" }).tap();
    await sheet(phone, "Initiative").waitFor({ state: "detached" });
    await waitFor("focus on the token bar's frame", async () => ((await focused(phone)).name === "Goblin 1 actions" ? true : null));
    await bar.getByRole("button", { name: "Close", exact: true }).first().tap();
  });

  test("7. 844 x 390: Hide by keyboard keeps Initiative mounted and scrolled, Panels brings it back, and Escape passes over it", async () => {
    await pickTool(phone, "Ruler");
    await openPanel(phone, "Initiative");
    const initiative = sheet(phone, "Initiative");
    assert.equal(await options(phone, "Ruler").count(), 0, "the sheet hides the rail");
    await initiative.locator(":scope > section").evaluate((el) => {
      const scroller = Array.from((el as unknown as DomEl).querySelectorAll("div")).find((d) => d.scrollHeight > d.clientHeight + 10) as unknown as { scrollTop: number } | undefined;
      if (scroller) scroller.scrollTop = 120;
    });
    const scrolled = await initiative.locator(":scope > section").evaluate((el) => Array.from((el as unknown as DomEl).querySelectorAll("div")).map((d) => d.scrollTop).find((t) => t > 0) ?? 0);
    assert.ok(scrolled > 0, "the Initiative body scrolled");
    await initiative.getByRole("button", { name: "Hide Initiative" }).focus();
    await phone.keyboard.press("Enter");
    await waitFor("the sheet hidden", async () => ((await sheetOpen(phone, "Initiative")) ? null : true));
    assert.equal(await initiative.count(), 1, "the panel stays mounted");
    assert.equal(await initiative.getAttribute("aria-modal"), null);
    assert.deepEqual(await focused(phone), { tag: "button", role: null, name: "Panels" });
    const panels = toolbar(phone).getByRole("button", { name: /^Panels/ });
    assert.equal(await panels.getAttribute("aria-pressed"), "false", "a hidden sheet leaves Panels unpressed");
    const described = await panels.getAttribute("aria-describedby");
    assert.ok(described);
    assert.equal(await phone.locator(`[id="${described}"]`).textContent(), "Shows Initiative again.");
    await options(phone, "Ruler").waitFor();
    assert.equal(await options(phone, "Ruler").getAttribute("data-rvtt-options"), "rail", "the rail comes back");
    // The docked token bar and the alerts column keep the same right edge, the map's, with no sheet there.
    await pickTool(phone, "Select");
    const bar = await selectToken(phone, phoneSocket, run.goblin.id, "Goblin 1");
    await ops.send({ t: "actor.hp", target: { tokenId: run.hag.id }, change: { kind: "damage", amount: 1 } });
    const check = phone.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    await phone.waitForTimeout(300);
    const barBox = await box(bar);
    const checkBox = await box(check);
    // Both read the free area's right edge with no sheet: the column's cards at it, the bar at it or beside the 312 px lane.
    const right = 844 - 47 - 8;
    const barRight = barBox.x + barBox.width;
    assert.ok(Math.abs(checkBox.x + checkBox.width - right) <= 1, `the column's right edge is ${checkBox.x + checkBox.width}`);
    assert.ok(Math.abs(barRight - right) <= 1 || Math.abs(barRight - (right - 312)) <= 1, `the token bar's right edge is ${barRight}`);
    await check.getByRole("button", { name: "Passed", exact: true }).tap();
    await shots.take(phone, "layout-sheet-hidden-844x390");
    // Escape lets go of the token bar, and leaves the hidden sheet as it is.
    await phone.keyboard.press("Escape");
    await bar.waitFor({ state: "detached" });
    assert.equal(await sheetOpen(phone, "Initiative"), false);
    assert.equal(await initiative.count(), 1);
    await panels.tap();
    await waitFor("the sheet shown", async () => ((await sheetOpen(phone, "Initiative")) ? true : null));
    assert.deepEqual(await focused(phone), { tag: "h2", role: null, name: "Initiative" }, "focus goes to its title");
    const back = await initiative.locator(":scope > section").evaluate((el) => Array.from((el as unknown as DomEl).querySelectorAll("div")).map((d) => d.scrollTop).find((t) => t > 0) ?? 0);
    assert.equal(back, scrolled, "it comes back scrolled where it was");
    await initiative.getByRole("button", { name: "Close Initiative" }).tap();
    await initiative.waitFor({ state: "detached" });
    await endFight();
  });

  test("7. 844 x 390: Escape ends Select several under a hidden Token sheet, Close then Panels opens the list, and upright a hidden sheet shows as a bottom sheet", async () => {
    await pickTool(phone, "Select");
    const bar = await selectToken(phone, phoneSocket, run.goblin.id, "Goblin 1");
    await bar.getByRole("button", { name: "Select several", exact: true }).tap();
    await options(phone, "Select").waitFor();
    await bar.getByRole("button", { name: "Details", exact: true }).tap();
    await sheet(phone, "Token").waitFor();
    await sheet(phone, "Token").getByRole("button", { name: "Hide Token" }).tap();
    await waitFor("the Token sheet hidden", async () => ((await sheetOpen(phone, "Token")) ? null : true));
    await phone.keyboard.press("Escape");
    await options(phone, "Select").waitFor({ state: "detached" });
    // Close for good, then Panels opens the list.
    await toolbar(phone).getByRole("button", { name: /^Panels/ }).tap();
    await sheet(phone, "Token").getByRole("button", { name: "Close Token" }).tap();
    await sheet(phone, "Token").waitFor({ state: "detached" });
    await toolbar(phone).getByRole("button", { name: /^Panels/ }).tap();
    await sheet(phone, "Panels").waitFor();
    await sheet(phone, "Panels").getByRole("button", { name: "Close Panels" }).tap();
    // Hidden, then turned upright: Panels shows it at the foot.
    await openPanel(phone, "Log");
    await sheet(phone, "Log").getByRole("button", { name: "Hide Log" }).tap();
    await view(phone, phoneCdp, { width: 390, height: 844 }, { top: 47, bottom: 34 });
    assert.equal(await sheetOpen(phone, "Log"), false, "turning upright keeps it hidden");
    await toolbar(phone).getByRole("button", { name: /^Panels/ }).tap();
    await waitFor("the Log shown", async () => ((await sheetOpen(phone, "Log")) ? true : null));
    const log = await box(sheet(phone, "Log"));
    assert.ok(log.x <= 1 && log.width >= 389, "a bottom sheet spans the phone");
    assert.equal(await sheet(phone, "Log").getByRole("button", { name: "Hide Log" }).count(), 0, "a bottom sheet has no Hide");
    await sheet(phone, "Log").getByRole("button", { name: "Close Log" }).tap();
    await view(phone, phoneCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
  });

  test("7. a player hides a sheet holding an open journal page, the DM edits the page, and Panels counts it", async () => {
    await view(player, playerCdp, { width: 844, height: 390 }, { side: 47, bottom: 21 });
    await reloadAt(player, 1);
    await openPanel(player, "Journal");
    await sheet(player, "Journal").getByRole("button", { name: /^Lore/ }).tap();
    await player.getByRole("heading", { name: "Lore" }).waitFor();
    await sheet(player, "Journal").getByRole("button", { name: "Hide Journal" }).tap();
    await waitFor("the Journal hidden", async () => ((await sheetOpen(player, "Journal")) ? null : true));
    await editLore("The citadel fell at dusk.");
    await toolbar(player).getByRole("button", { name: /^Panels/ }).getByText("1 unread").waitFor();
    await toolbar(player).getByRole("button", { name: /^Panels/ }).tap();
    await player.getByText("The citadel fell at dusk.").waitFor();
    await waitFor("the page read once it shows", async () => ((await toolbar(player).getByRole("button", { name: /^Panels/ }).getByText("unread").count()) === 0 ? true : null));
    await sheet(player, "Journal").getByRole("button", { name: "Close Journal" }).tap();
  });

  // ------------------------------------------------ the very short mode (case 7)

  const modal = (page: Page) => page.locator('dialog[data-rvtt-sheet][aria-modal="true"]');

  /** Whether `inner` lies inside `outer`. */
  function inside(inner: Box, outer: Box): boolean {
    return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
  }

  async function expectHeaderButtons(page: Page, title: string, label: string): Promise<void> {
    const dialog = modal(page);
    const whole = await rect(dialog);
    const heading = await rect(dialog.locator(":scope > section > header h2"));
    const buttons = [dialog.getByRole("button", { name: "All panels" }), dialog.getByRole("button", { name: `Hide ${title}` }), dialog.getByRole("button", { name: `Close ${title}` })];
    const boxes: Box[] = [];
    for (const b of buttons) {
      const r = await rect(b);
      // At 130% the 44 px buttons draw 57 px wide and tall.
      assert.ok(r.width >= 44 && r.height >= 44, `${label}: ${await b.getAttribute("aria-label")} is ${r.width} x ${r.height}`);
      assert.ok(inside(r, whole), `${label}: ${await b.getAttribute("aria-label")} is inside the sheet`);
      assert.ok(!intersects(r, heading), `${label}: ${await b.getAttribute("aria-label")} meets the title`);
      for (const other of boxes) assert.ok(!intersects(r, other), `${label}: two of the header's buttons meet`);
      if (!(await waitFor("the header's button in reach", () => reachable(b), 3000).catch(() => false))) assert.fail(`${label}: ${await b.getAttribute("aria-label")} takes no tap: ${await whatTakes(b)}`);
      boxes.push(r);
    }
  }

  test("7. 480 x 320 at 130%: Initiative opens modal over the whole screen, its header and body in reach, Tab kept inside", async () => {
    await view(phone, phoneCdp, { width: 480, height: 320 }, { side: 47, bottom: 21 });
    await reloadAt(phone, 1.3);
    await startFight();
    await openPanel(phone, "Initiative");
    const dialog = modal(phone);
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-label"), "Initiative");
    assert.equal(await phone.getByRole("dialog", { name: "Initiative" }).count(), 1, "a dialog named by its panel");
    const whole = await rect(dialog);
    assert.deepEqual([Math.round(whole.x), Math.round(whole.y), Math.round(whole.width), Math.round(whole.height)], [0, 0, 480, 320], "over the whole screen");
    // Above the bars: what lies at the toolbar's middle and the top bar's is the sheet.
    const atBars = await phone.evaluate(() => {
      const w = globalThis as unknown as Dom;
      const sheetEl = w.document.querySelector('dialog[aria-modal="true"]')!;
      return [w.document.elementFromPoint(240, 310), w.document.elementFromPoint(240, 20)].every((el) => sheetEl.contains(el));
    });
    assert.equal(atBars, true, "the sheet lies over the top bar and the toolbar");
    await expectHeaderButtons(phone, "Initiative", "480 x 320 at 130%");
    const next = dialog.getByRole("button", { name: "Next", exact: true });
    // Once the dialog has settled in the top layer.
    if (!(await waitFor("Next in reach", () => reachable(next), 3000).catch(() => false))) assert.fail(`Next is not in view or takes no tap: ${await whatTakes(next)}`);
    for (let i = 0; i < 12; i++) {
      await phone.keyboard.press("Tab");
      const kept = await phone.evaluate(() => {
        const w = globalThis as unknown as Dom;
        return w.document.querySelector('dialog[aria-modal="true"]')!.contains(w.document.activeElement);
      });
      assert.equal(kept, true, `Tab ${i + 1} left the sheet`);
    }
    await shots.take(phone, "layout-very-short-480x320-130-initiative");
  });

  test("7. 480 x 320 at 130%: with a token and a check waiting, the dock's buttons join a stacked header, and the folded alerts speak inside the sheet", async () => {
    const dialog = modal(phone);
    await dialog.getByRole("button", { name: "Close Initiative" }).tap();
    await dialog.waitFor({ state: "detached" });
    // Here the compact token bar covers the toolbar (docs/design-v1-bar-dock.md 1.4): the turn strip opens Initiative and leaves the bar as it is.
    const bar = await selectToken(phone, phoneSocket, run.goblin.id, "Goblin 1");
    await ops.send({ t: "actor.hp", target: { tokenId: run.hag.id }, change: { kind: "damage", amount: 1 } });
    await phone.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
    await topBar(phone).getByRole("button", { name: /^Initiative, round/ }).tap();
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-label"), "Initiative");
    assert.equal(await bar.isHidden(), true, "the token bar folds while the sheet is over the screen");
    const show = dialog.getByRole("button", { name: "Show Goblin 1 actions" });
    const summary = dialog.getByRole("button", { name: /^Concentration check/ });
    await show.waitFor();
    await summary.waitFor();
    const heading = await rect(dialog.locator(":scope > section > header h2"));
    const back = await rect(dialog.getByRole("button", { name: "All panels" }));
    assert.ok(heading.y >= back.y + back.height - 1, "the header stacks: the title under its buttons");
    for (const b of [show, summary]) if (!(await waitFor("the dock's button in reach", () => reachable(b), 3000).catch(() => false))) assert.fail(`${await b.getAttribute("aria-label")} takes no tap: ${await whatTakes(b)}`);
    await expectHeaderButtons(phone, "Initiative", "480 x 320 at 130%, stacked");
    await shots.take(phone, "layout-very-short-480x320-130-stacked-header");
    // A new check arrives while the sheet is open: its words in a status region inside the dialog.
    const status = dialog.locator("[data-rvtt-fold-status]");
    await status.waitFor({ state: "attached" });
    assert.equal(await status.textContent(), "", "the region starts empty in its new place");
    await ops.send({ t: "actor.hp", target: { tokenId: run.hag.id }, change: { kind: "damage", amount: 1 } });
    await waitFor("the new check spoken inside the sheet", async () => (/Concentration check for Hag/.test((await status.textContent()) ?? "") ? true : null));
    assert.equal(await phone.getByRole("status").filter({ hasText: "Concentration check for Hag" }).count(), 1, "in the accessibility tree");
    // Escape closes it, and opened again, twice with no tap between: closed in the room's state with no modal left behind.
    await phone.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await bar.waitFor();
    await topBar(phone).getByRole("button", { name: /^Initiative, round/ }).tap();
    await dialog.waitFor();
    await phone.keyboard.press("Escape");
    await phone.keyboard.press("Escape");
    await sheet(phone, "Initiative").waitFor({ state: "detached" });
    assert.equal(await phone.locator('[aria-modal="true"]').count(), 0, "no element keeps aria-modal");
    assert.equal(await phone.evaluate(() => (globalThis as unknown as Dom).document.querySelectorAll("dialog[data-rvtt-sheet][open]").length), 0);
    await endFight();
  });

  test("7. 480 x 320 at 130%: a map layer that did not load, the connection banner and a toast show inside the sheet", async () => {
    // The height marks' code fails before it loads: its notice is a quiet one with the reload.
    consoles.phone.allow = [/HeightLayer/, /dynamically imported module/, /ERR_INTERNET_DISCONNECTED|ERR_FAILED|net::/, /WebSocket connection/];
    await phone.route("**/assets/HeightLayer-*.js", (route) => route.abort("internetdisconnected"));
    // The room's socket through a route, so the test can drop it: the browser's offline switch alone leaves an open socket open.
    let dropped = false;
    let live: { close(): Promise<void> } | null = null;
    await phone.routeWebSocket(/\/ws\?room=/, (ws) => {
      if (dropped) {
        void ws.close();
        return;
      }
      ws.connectToServer();
      live = ws;
    });
    await reloadAt(phone, 1.3);
    await phone.getByText("The height marks can't load while offline.").waitFor();
    await openPanel(phone, "Initiative");
    const dialog = modal(phone);
    await dialog.waitFor();
    const quiet = dialog.getByText("The height marks can't load while offline.");
    await quiet.waitFor();
    assert.equal(await reachable(dialog.locator('[data-rvtt-modal-slot="quiet"]').getByRole("button", { name: "Reload" })), true, "its Reload takes a tap inside the sheet");
    await shots.take(phone, "layout-very-short-quiet-notice-in-sheet");
    await phone.unroute("**/assets/HeightLayer-*.js");

    // Taken offline, the connection banner shows inside the sheet.
    await phoneContext.setOffline(true);
    dropped = true;
    await (live as { close(): Promise<void> } | null)?.close();
    // The socket notices within its ping's 10 s, and the banner shows 3 s later.
    await dialog.locator('[data-rvtt-modal-slot="connection"]').getByText(/^You are offline/).waitFor({ timeout: 30_000 });
    await shots.take(phone, "layout-very-short-offline-in-sheet");
    dropped = false;
    await phoneContext.setOffline(false);
    await phone.evaluate(() => (globalThis as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event("online")));
    await dialog.locator('[data-rvtt-modal-slot="connection"]').getByText(/^You are offline/).waitFor({ state: "detached", timeout: 30_000 });

    /*
     * A toast that arrives while the sheet shows, inside it, reachable and
     * read out: a whisper from Pat while the Log is closed. A refusal for
     * something gone, such as a whisper to a member another DM device just
     * removed, is a race the store answers with no toast (state/store.ts
     * isRace), so the whisper's own notice stands for every toast here.
     */
    const playerCookie = (await playerContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const pat = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: playerCookie });
    try {
      await pat.send({ t: "log.whisper", to: [phoneSocket.you!.memberId], text: "Behind you!" });
    } finally {
      pat.close();
    }
    const toast = dialog.locator('[data-rvtt-modal-slot="toasts"] button[role="status"]');
    await toast.first().waitFor({ timeout: 10_000 });
    assert.equal(await reachable(toast.first()), true, "the toast takes a tap inside the sheet");
    await shots.take(phone, "layout-very-short-toast-in-sheet");
    const text = (await toast.first().textContent()) ?? "";
    await dialog.getByRole("button", { name: "Close Initiative" }).tap();
    await dialog.waitFor({ state: "detached" });
    await phone.waitForTimeout(300);
    assert.equal(await phone.getByRole("status").filter({ hasText: text }).count(), 0, "the toast went with the sheet, never shown again over the map");
    await phone.unrouteAll();
    // The height marks' failed import stays failed for this page, so the next steps start from a fresh one.
    await reloadAt(phone, 1.3);
    consoles.phone.allow = [];
  });

  test("7. 480 x 320 at 130%: Hide takes the modal away at once, so the map's keys work, and Panels shows it modal again with its draft", async () => {
    await pickTool(phone, "Select");
    const before = phoneSocket.state!.tokens[run.goblin.id]!;
    const bar = await selectToken(phone, phoneSocket, run.goblin.id, "Goblin 1");
    // The turn strip opens Initiative with the token still selected, and All panels leads to the Log.
    void bar;
    await startFight();
    await topBar(phone).getByRole("button", { name: /^Initiative, round/ }).tap();
    const dialog = modal(phone);
    await dialog.getByRole("button", { name: "All panels" }).tap();
    await phone.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).tap();
    await sheet(phone, "Log").waitFor();
    await dialog.getByLabel(/^(Message|Whisper)$/).fill("Half a plan");
    await dialog.getByRole("button", { name: "Hide Log" }).tap();
    await waitFor("the Log hidden", async () => ((await sheetOpen(phone, "Log")) ? null : true));
    assert.deepEqual(await focused(phone), { tag: "button", role: null, name: "Panels" });
    assert.equal(await phone.locator('[aria-modal="true"]').count(), 0);
    await phone.keyboard.press("ArrowRight");
    await waitFor("the goblin nudged a square", () => (phoneSocket.state!.tokens[run.goblin.id]!.x === before.x + 1 ? true : null));
    await phone.keyboard.press("r");
    assert.equal(await toolbar(phone).getByRole("button", { name: "Ruler", exact: true }).getAttribute("aria-pressed"), "true", "R picks the Ruler");
    await phone.keyboard.press("Escape");
    await pickTool(phone, "Select");
    await phone.waitForTimeout(300);
    assert.equal(await phone.getByRole("dialog", { name: "Goblin 1 actions" }).count(), 0, "Escape let go of the goblin");
    await toolbar(phone).getByRole("button", { name: /^Panels/ }).tap();
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-label"), "Log");
    assert.equal(await dialog.getByLabel(/^(Message|Whisper)$/).inputValue(), "Half a plan", "the draft is kept");
    await dialog.getByRole("button", { name: "Close Log" }).tap();
    await ops.send({ t: "token.move", tokenId: run.goblin.id, x: before.x, y: before.y });
    await endFight();
  });

  test("7. 480 x 320 at 130%: \"Your turn\" speaks inside a player's sheet", async () => {
    await view(player, playerCdp, { width: 480, height: 320 }, { side: 47, bottom: 21 });
    await reloadAt(player, 1.3);
    await endFight();
    await openPanel(player, "Log");
    const dialog = modal(player);
    await dialog.waitFor();
    await startFight("thorn");
    const turn = dialog.locator('[role="status"][aria-live="assertive"]', { hasText: "Your turn" });
    await turn.waitFor();
    await shots.take(player, "layout-very-short-your-turn-in-sheet");
    await dialog.getByRole("button", { name: "Close Log" }).tap();
    await endFight();
  });

  test("7. a DM's \"view as a player\" at 480 x 320 at 130%: \"Viewing as Pat\" stands above the very short sheet, and its Exit leaves", async () => {
    await openPanel(phone, "DM");
    await modal(phone).getByRole("button", { name: "View", exact: true }).tap();
    const preview = phone.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    await preview.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
    await preview.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).tap();
    const inner = preview.locator('dialog[data-rvtt-sheet][aria-modal="true"][aria-label="Log"]');
    await inner.waitFor();
    const exit = inner.getByRole("button", { name: "Exit", exact: true });
    await exit.waitFor();
    assert.equal(await reachable(exit), true, "Exit takes a tap above the sheet's content");
    assert.ok(inside(await rect(inner.getByText(/^Viewing as Pat/)), await rect(inner)));
    await shots.take(phone, "layout-very-short-preview-notice");
    await exit.tap();
    await preview.waitFor({ state: "detached" });
    await modal(phone).getByRole("button", { name: "Close DM" }).tap();
  });

  /*
   * At 844 x 390 and 667 x 375 at 130% the strip and a player's End turn
   * still fit the top bar, the room's name giving way first. At 480 x 320
   * at 100% they do not, and the band would leave a side sheet a body of
   * 83 px (section 8.1).
   */
  test("7. 480 x 320 at 100%: the turn band arriving with a player's own turn switches a side sheet to the very short mode on the same element, focus and draft kept, and back", async () => {
    run.roomName = "The Long Hall Beneath the Mountain of Kings";
    await ops.send({ t: "room.update", name: run.roomName });
    await view(player, playerCdp, { width: 480, height: 320 }, { side: 47, bottom: 21 });
    await reloadAt(player, 1);
    await openPanel(player, "Log");
    const log = sheet(player, "Log");
    assert.equal(await log.getAttribute("aria-modal"), null, "a side sheet with no band");
    await log.evaluate((el) => ((el as unknown as { marked: boolean }).marked = true));
    const field = log.getByLabel(/^(Message|Whisper)$/);
    await field.fill("On my way");
    await field.focus();
    await startFight("thorn");
    await waitFor("the very short mode", async () => ((await log.getAttribute("aria-modal")) === "true" ? true : null));
    assert.equal(await log.evaluate((el) => (el as unknown as { marked?: boolean }).marked === true), true, "the same element");
    assert.equal((await focused(player)).tag, "input", "the field keeps focus");
    assert.equal(await field.inputValue(), "On my way");
    await shots.take(player, "layout-band-switches-to-very-short");
    await endFight();
    await waitFor("the side mode again", async () => ((await log.getAttribute("aria-modal")) === null ? true : null));
    assert.equal(await log.evaluate((el) => (el as unknown as { marked?: boolean }).marked === true), true, "still the same element");
    assert.equal((await focused(player)).tag, "input");
    assert.equal(await field.inputValue(), "On my way");
    await log.getByRole("button", { name: "Close Log" }).tap();
  });

  test("7. a change of mode saves no draft: a partial initiative and a partial Armor Class stay unsaved and in their fields, side to very short and back", async () => {
    // 480 x 380 leaves a side sheet a body even with the turn band, and 480 x 260 does not, so a resize switches the mode with the band in place.
    const tall = { width: 480, height: 380 };
    const short = { width: 480, height: 260 };
    const insets = { side: 47, bottom: 21 };
    const modal = async (title: string, want: boolean) =>
      waitFor(`${title} ${want ? "in the very short mode" : "beside the map"}`, async () => (((await sheet(phone, title).getAttribute("aria-modal")) === "true") === want ? true : null));
    const initiativeOf = () => phoneSocket.state!.encounter!.entries.find((e) => e.id === run.goblin.entryId)!.value;
    const acOf = () => (phoneSocket.state!.tokens[run.goblin.id]!.actor as unknown as { inline: { ac: number } }).inline.ac;
    await view(phone, phoneCdp, tall, insets);
    await reloadAt(phone, 1);
    await startFight();

    await openPanel(phone, "Initiative");
    await modal("Initiative", false);
    await sheet(phone, "Initiative").getByRole("button", { name: /^Goblin 1 initiative 18, tap to type it$/ }).tap();
    const editor = sheet(phone, "Initiative").getByRole("textbox", { name: "Goblin 1 initiative", exact: true });
    await editor.fill("1");
    await view(phone, phoneCdp, short, insets);
    await modal("Initiative", true);
    assert.equal(await editor.count(), 1, "the editor stayed open");
    assert.deepEqual([(await focused(phone)).tag, await editor.inputValue()], ["input", "1"], "the editor keeps focus and its draft");
    assert.equal(initiativeOf(), 18, "the change of mode saved the draft");
    await phone.keyboard.type("2");
    await view(phone, phoneCdp, tall, insets);
    await modal("Initiative", false);
    assert.deepEqual([(await focused(phone)).tag, await editor.inputValue()], ["input", "12"], "back beside the map, the editor keeps focus and its draft");
    assert.equal(initiativeOf(), 18);
    await phone.keyboard.press("Enter");
    await waitFor("the initiative saved by Enter", async () => (initiativeOf() === 12 ? true : null));
    await sheet(phone, "Initiative").getByRole("button", { name: "Close Initiative" }).tap();

    const bar = await selectToken(phone, phoneSocket, run.goblin.id, "Goblin 1");
    await bar.getByRole("button", { name: "Details", exact: true }).tap();
    await modal("Token", false);
    const stats = sheet(phone, "Token").getByRole("button", { name: "Stats", exact: true });
    if ((await stats.getAttribute("aria-expanded")) === "false") await stats.tap();
    const ac = sheet(phone, "Token").getByRole("textbox", { name: "Armor Class", exact: true });
    await ac.fill("1");
    await view(phone, phoneCdp, short, insets);
    await modal("Token", true);
    assert.deepEqual([(await focused(phone)).name, await ac.inputValue()], ["Armor Class", "1"], "the field keeps focus and its draft");
    assert.equal(acOf(), 15, "the change of mode saved the draft");
    await phone.keyboard.type("7");
    await view(phone, phoneCdp, tall, insets);
    await modal("Token", false);
    assert.deepEqual([(await focused(phone)).name, await ac.inputValue()], ["Armor Class", "17"]);
    assert.equal(acOf(), 15);
    await phone.keyboard.press("Enter");
    await waitFor("the Armor Class saved by Enter", async () => (acOf() === 17 ? true : null));
    await ac.fill("15");
    await ac.press("Enter");
    await waitFor("the Armor Class put back", async () => (acOf() === 15 ? true : null));
    await sheet(phone, "Token").getByRole("button", { name: "Close Token" }).tap();
    await sheet(phone, "Token").waitFor({ state: "detached" });
    if (await bar.isVisible()) await phone.keyboard.press("Escape");
    await endFight();
  });

  // ------------------------------------------------ the hierarchy moves (case 9)

  test("9. the DM's toolbar has the play tools first with Fog fourth, a divider, then the setup tools, and a player's order is as before", async () => {
    const names = (page: Page) => toolbar(page).locator("button[aria-label]").evaluateAll((els) => els.map((el) => (el as unknown as DomEl).getAttribute("aria-label")));
    assert.deepEqual((await names(desk)).filter((n) => n !== "Panels"), ["Select", "Ruler", "Area", "Fog", "Draw", "Ping", "Add token", "Pin", "Map builder", "Line up grid"]);
    const divider = await toolbar(desk).locator("[data-rvtt-divider]").evaluate((el) => (el as unknown as { nextElementSibling: DomEl | null }).nextElementSibling?.getAttribute("aria-label"));
    assert.equal(divider, "Add token", "the divider stands before the first setup tool");
    assert.deepEqual((await names(player)).filter((n) => n !== "Panels"), ["Select", "Ruler", "Area", "Draw", "Ping"]);
    assert.equal(await toolbar(player).locator("[data-rvtt-divider]").count(), 0);
  });

  test("9. Undo and Redo sit in the DM's top bar with a mouse, and the DM panel has no Undo of its own", async () => {
    await view(desk, deskCdp, { width: 1280, height: 800 });
    for (const name of ["Undo", "Redo"]) assert.equal(await topBar(desk).getByRole("button", { name, exact: true }).isVisible(), true, `${name} in the top bar`);
    assert.equal(await topBar(desk).getByLabel("Map phase").isVisible(), true, "the Phase menu fits a 1280 px row");
    if (await sidePanel(desk).isHidden()) await toolbar(desk).getByRole("button", { name: "Panels" }).click();
    await desk.getByRole("tab", { name: "DM", exact: true }).click();
    const panel = desk.getByRole("tabpanel", { name: "DM" });
    await panel.getByRole("heading", { name: "Players' screens" }).waitFor();
    assert.equal(await panel.getByRole("heading", { name: "Undo", exact: true }).count(), 0);
    assert.equal(await panel.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  });

  test("9. at 900 x 800 with a two-phase scene in a fight, the DM's row gives way: the chip to its dot, then the Phase menu, and nothing overflows", async () => {
    await startFight();
    await view(desk, deskCdp, { width: 900, height: 800 });
    await desk.waitForTimeout(400);
    const row = topBar(desk).locator("> div").first();
    // As the row's own check counts it: the last button tucks into the bar's padding by a negative margin, which is room the row has.
    const fits = await row.evaluate((el) => {
      const e = el as unknown as DomEl & { lastElementChild: DomEl | null };
      const w = globalThis as unknown as { getComputedStyle(el: unknown): { marginRight: string } };
      const tuck = e.lastElementChild ? Math.max(0, -parseFloat(w.getComputedStyle(e.lastElementChild).marginRight) || 0) : 0;
      return e.scrollWidth - e.clientWidth - tuck;
    });
    assert.ok(fits <= 0, `the row overflows by ${fits} px`);
    assert.equal(await topBar(desk).getByRole("img", { name: "You are the DM" }).isVisible(), true, "the DM chip shows its dot");
    assert.equal(await topBar(desk).getByLabel("Map phase").count(), 0, "the Phase menu left the bar");
    // Fit tucks into the bar's padding, so both stay inside the top bar's own box, short of the side panel.
    const bar = await box(topBar(desk));
    for (const target of [topBar(desk).getByRole("button", { name: "Fit the map to the screen" }), topBar(desk).getByRole("button", { name: /^Initiative, round/ })]) {
      const b = await box(target);
      assert.ok(b.x >= bar.x - 1 && b.x + b.width <= bar.x + bar.width + 1, `${await target.getAttribute("aria-label")} is inside the top bar`);
    }
    await shots.take(desk, "layout-desk-900-top-bar");
    await endFight();
    await view(desk, deskCdp, { width: 1280, height: 800 });
  });

  test("9. the Panels list in play order for both roles, with the DM's groups labeled", async () => {
    await view(phone, phoneCdp, { width: 390, height: 844 }, { top: 47, bottom: 34 });
    await reloadAt(phone, 1);
    await view(player, playerCdp, { width: 390, height: 844 }, { top: 47, bottom: 34 });
    await reloadAt(player, 1);
    const list = async (page: Page) => {
      await toolbar(page).getByRole("button", { name: /^Panels/ }).tap();
      const region = page.getByRole("region", { name: "Panels" });
      await region.waitFor();
      const items = await region.getByRole("list", { name: "Panels" }).evaluate((ul) =>
        Array.from((ul as unknown as DomEl).querySelectorAll(":scope > li")).map((li) => {
          const heading = li.querySelector("h2, h3, h4");
          if (heading) return `# ${heading.textContent?.trim() ?? ""}`;
          if (li.hasAttribute("aria-hidden")) return "---";
          // A tile's unread badge reads "1" and, hidden, "1 unread" after its name.
          return (li.querySelector("button")?.textContent ?? "").replace(/\d+ unread$/, "").trim();
        }),
      );
      await region.getByRole("button", { name: "Close Panels" }).tap();
      return items;
    };
    assert.deepEqual(await list(phone), ["# In play", "Token", "Initiative", "Party", "Log", "Journal", "Areas", "DM", "Scenes", "# Prepare", "Monsters", "Encounters", "Characters", "Outliner", "Library", "---", "Menu"]);
    assert.deepEqual(await list(player), ["Token", "Initiative", "Log", "Journal", "Areas", "Characters", "Library", "Menu"]);
  });

  // ------------------------------------------------ the bar dock review's follow-ups in the notices and modal layers

  test("follow-up: a roll card that arrives at a phone's foot while the alerts are open over the screen is inert under them", async () => {
    await view(player, playerCdp, { width: 480, height: 320 }, { side: 47, bottom: 21 });
    await reloadAt(player, 1.3);
    await endFight();
    await pickTool(player, "Ruler");
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.thorn.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Bless" } });
    await ops.send({ t: "actor.hp", target: { tokenId: run.thorn.id }, change: { kind: "damage", amount: 1 } });
    const row = player.getByRole("button", { name: /^Concentration check/ });
    await row.waitFor();
    await row.tap();
    const alerts = player.getByRole("dialog", { name: "Alerts" });
    await alerts.waitFor();
    // Anything that arrives on the page while the alerts are over the screen is made inert as it arrives, as a portal's card would be.
    await player.evaluate(() => {
      const d = (globalThis as unknown as { document: { createElement(t: string): DomEl & { id: string }; body: { append(el: unknown): void } } }).document;
      const late = d.createElement("div");
      late.id = "rvtt-e2e-late";
      d.body.append(late);
    });
    await waitFor("the late arrival made inert", async () => ((await player.locator("#rvtt-e2e-late").evaluate((el) => (el as unknown as DomEl).closest("[inert]") !== null)) ? true : null), 3000);
    await player.locator("#rvtt-e2e-late").evaluate((el) => (el as unknown as { remove(): void }).remove());
    const id = randomUUID();
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    await waitFor("the roll on the player's side", () => playerSocket.state?.rolls[id]);
    await player.waitForTimeout(800);
    // Whatever the roll mounts beside the room while the alerts are over the screen, its foot card above all, takes no tap or focus.
    const live = await player.evaluate(() => {
      const w = globalThis as unknown as Dom;
      const alertsBox = w.document.querySelector('[role="dialog"][aria-labelledby]');
      return Array.from(w.document.querySelectorAll('[aria-label="The DM asks for a roll"]')).filter((el) => !el.closest("[inert]") && !(alertsBox?.contains(el) ?? false)).length;
    });
    await shots.take(player, "layout-follow-up-roll-card-inert-under-alerts");
    // The alerts may give way to the roll's own card as it arrives: then nothing is over it, and nothing may stay inert.
    if ((await alerts.count()) > 0) {
      assert.equal(live, 0, "a roll card arrived live above the alerts over the screen");
      await alerts.getByRole("button", { name: "Close", exact: true }).tap();
      await alerts.waitFor({ state: "detached" });
    }
    assert.equal(await player.locator("[inert]").count(), 0, "nothing stays inert once the alerts are gone");
    await ops.send({ t: "roll.close", rollIds: [id] });
    await ops.send({ t: "actor.hp", target: { tokenId: run.thorn.id }, change: { kind: "heal", amount: 1 } });
    await player.getByRole("dialog", { name: "The DM asks for a roll" }).waitFor({ state: "detached" });
    // The check still waits: a fresh page starts the next step without it.
    await reloadAt(player, 1.3);
    await pickTool(player, "Select");
  });

  test("follow-up: at 480 x 320 at 130% with no fight, the Roll asked row stands clear of the Ruler's options, its hint included", async () => {
    await view(player, playerCdp, { width: 480, height: 320 }, { side: 47, bottom: 21 });
    await reloadAt(player, 1.3);
    await endFight();
    await pickTool(player, "Ruler");
    const id = randomUUID();
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    const card = player.getByRole("dialog", { name: "The DM asks for a roll" });
    const row = player.getByRole("button", { name: /^Roll asked/ });
    await waitFor("the card or the row", async () => ((await card.isVisible()) || (await row.isVisible()) ? true : null));
    if (await card.isVisible()) await card.getByRole("button", { name: "Later" }).tap();
    await row.waitFor();
    await player.waitForTimeout(300);
    const ruler = options(player, "Ruler");
    const hint = ruler.locator('[aria-live="polite"]').first();
    const rowBox = await box(row);
    for (const part of [hint, ruler.getByRole("button").first()]) assert.ok(!intersects(rowBox, await box(part)), `the row ${JSON.stringify(rowBox)} meets the Ruler's options ${JSON.stringify(await box(part))}`);
    assert.equal(await reachable(row), true, "the row takes a tap");
    await shots.take(player, "layout-follow-up-roll-asked-row-480x320-130");
    await ops.send({ t: "roll.close", rollIds: [id] });
    await pickTool(player, "Select");
  });

  test("5. at a computer, Hide panels and Panels hide and show the side panel, and focus follows", async () => {
    const side = sidePanel(desk);
    const map = desk.locator(".konvajs-content").first();
    await desk.getByRole("tab", { name: /^Log/ }).click();
    await desk.getByLabel("Message", { exact: true }).fill("Half a thought");
    const before = (await box(map)).width;
    await desk.getByRole("button", { name: "Hide panels" }).click();
    await side.waitFor({ state: "hidden" });
    assert.deepEqual(await focused(desk), { tag: "button", role: null, name: "Panels" }, "focus goes to Panels, since Hide panels is gone");
    await waitFor("the map to widen", async () => ((await box(map)).width >= before + 359 ? true : null));
    const panels = toolbar(desk).getByRole("button", { name: "Panels" });
    assert.equal(await panels.getAttribute("aria-expanded"), "false");
    assert.equal(await panels.getAttribute("aria-controls"), await side.getAttribute("id"));
    assert.equal(await desk.evaluate(() => localStorage.getItem("rvtt.sidePanel")), "hidden");
    await shots.take(desk, "layout-desk-side-panel-hidden");

    // A chat message from Pat while the Log is hidden marks Panels.
    const playerCookie = (await playerContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const pat = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: playerCookie });
    try {
      await pat.send({ t: "log.chat", text: "Is anyone there?" });
    } finally {
      pat.close();
    }
    await panels.getByText("1 unread").waitFor();

    // Escape is not a way to hide or show it: it is no sheet.
    await desk.keyboard.press("Escape");
    assert.equal(await side.isHidden(), true);

    await panels.click();
    await side.waitFor();
    assert.deepEqual(await focused(desk), { tag: "button", role: "tab", name: "Log" }, "focus goes to the chosen tab, since Panels is gone");
    assert.equal(await desk.getByLabel("Message", { exact: true }).inputValue(), "Half a thought", "the half-typed message survived");
    assert.equal(await desk.evaluate(() => localStorage.getItem("rvtt.sidePanel")), "shown");
    assert.equal(await desk.getByRole("tab", { name: /^Log/ }).getByText("unread").count(), 0, "the Log on screen is read");
  });

  test("5. S hides from a focused tab and shows from Panels, and a reload keeps the choice", async () => {
    const side = sidePanel(desk);
    await desk.getByRole("tab", { name: /^Log/ }).focus();
    await desk.keyboard.press("s");
    await side.waitFor({ state: "hidden" });
    assert.deepEqual(await focused(desk), { tag: "button", role: null, name: "Panels" });
    await desk.keyboard.press("s");
    await side.waitFor();
    assert.deepEqual(await focused(desk), { tag: "button", role: "tab", name: "Log" });
    // From the map, S leaves focus where it is.
    await desk.getByRole("img", { name: "Map" }).focus();
    await desk.keyboard.press("s");
    await side.waitFor({ state: "hidden" });
    assert.deepEqual((await focused(desk)).name, "Map");
    await desk.reload();
    await desk.getByRole("status", { name: "Connected" }).first().waitFor();
    await desk.locator(".konvajs-content").first().waitFor();
    assert.equal(await side.isHidden(), true, "the choice is remembered on this device");
    await toolbar(desk).getByRole("button", { name: "Panels" }).waitFor();
  });

  test("5. Details on the token bar shows a hidden side panel on the Token tab, and the choice stays stored", async () => {
    const side = sidePanel(desk);
    const goblin = deskSocket.state!.tokens[run.goblin.id]!;
    const p = await pagePoint(desk, deskSocket.state!.scenes[run.sceneId]!.bounds, { x: goblin.x + 0.5, y: goblin.y + 0.5 });
    await desk.mouse.click(p.x, p.y);
    const bar = desk.getByRole("dialog", { name: "Goblin 1 actions" });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Details", exact: true }).click();
    await side.waitFor();
    assert.deepEqual(await focused(desk), { tag: "button", role: "tab", name: "Token" });
    assert.equal(await desk.getByRole("tab", { name: "Token", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await desk.evaluate(() => localStorage.getItem("rvtt.sidePanel")), "hidden", "a request to see a panel leaves the stored choice alone");
    await desk.keyboard.press("Escape");
    await desk.getByRole("button", { name: "Hide panels" }).click();
    await side.waitFor({ state: "hidden" });
  });

  test("6. a large phone held sideways starts with the side panel hidden, a rail tool takes the rail, and shown, the panel's tabs scroll in one row", async () => {
    await view(phone, phoneCdp, { width: 932, height: 430 }, { side: 59, bottom: 21 });
    await reloadAt(phone, 1);
    const side = sidePanel(phone);
    assert.equal(await side.isHidden(), true, "a short layout with no stored choice starts hidden");
    assert.equal(await phone.evaluate(() => localStorage.getItem("rvtt.sidePanel")), null, "the default is not stored");
    // M10: a touch screen from 900 px up names each tool under its icon.
    for (const name of ["Select", "Ruler", "Fog"]) assert.match((await toolbar(phone).getByRole("button", { name, exact: true }).textContent()) ?? "", new RegExp(name));
    assert.match((await toolbar(phone).getByRole("button", { name: "Panels" }).textContent()) ?? "", /Panels/);
    await pickTool(phone, "Ruler");
    assert.equal(await options(phone, "Ruler").getAttribute("data-rvtt-options"), "rail");
    await shots.take(phone, "layout-932x430-hidden-rail");

    await startFight();
    await toolbar(phone).getByRole("button", { name: "Panels" }).click();
    await side.waitFor();
    assert.equal(await options(phone, "Ruler").getAttribute("data-rvtt-options"), "foot", "beside the side panel the rail would take over half the map");
    // The map no longer reaches the right edge, so its chrome drops the 59 px inset there.
    const pads = await phone.evaluate(() => {
      const w = globalThis as unknown as Dom;
      const header = w.document.querySelector("header:has(h1)")!;
      const nav = w.document.querySelector('nav[aria-label="Tools"]')!;
      return { header: parseFloat(w.getComputedStyle(header).paddingRight), toolbar: parseFloat(w.getComputedStyle(nav).paddingRight), left: parseFloat(w.getComputedStyle(header).paddingLeft) };
    });
    assert.deepEqual(pads, { header: 12, toolbar: 4, left: 59 + 12 });
    // One row of tabs that scrolls, the chosen one in view.
    const tablist = phone.getByRole("tablist", { name: "Panels" });
    const row = await tablist.evaluate((el) => {
      const e = el as unknown as DomEl;
      const tabs = Array.from(e.querySelectorAll('[role="tab"]'), (t) => t.getBoundingClientRect().top);
      return { scrolls: e.scrollWidth > e.clientWidth, rows: new Set(tabs.map(Math.round)).size };
    });
    assert.deepEqual(row, { scrolls: true, rows: 1 });
    const listBox = await box(tablist);
    const chosen = phone.getByRole("tab", { selected: true });
    const chosenBox = await box(chosen);
    assert.ok(chosenBox.x >= listBox.x - 1 && chosenBox.x + chosenBox.width <= listBox.x + listBox.width + 1, "the chosen tab is in view");
    assert.equal(await phone.getByRole("button", { name: "Party", exact: false }).first().getAttribute("aria-expanded"), "false", "the party bar starts folded on a short layout");
    const body = phone.getByRole("tabpanel", { name: "Initiative" });
    assert.ok((await box(body)).height >= 200, `the Initiative body is ${(await box(body)).height} px tall`);
    assert.equal(await wholeInReach(body.getByRole("button", { name: "Next", exact: true })), true, "Next is in view");
    await shots.take(phone, "layout-932x430-side-panel-shown");

    // The tab keys move along the scrolled row, and the tab they reach scrolls into view.
    await chosen.focus();
    for (const key of ["ArrowRight", "End", "Home", "ArrowLeft"]) {
      await phone.keyboard.press(key);
      const f = await focused(phone);
      assert.equal(f.role, "tab", `${key} left the tabs`);
      const tab = phone.getByRole("tab", { selected: true });
      const b = await box(tab);
      const list = await box(tablist);
      assert.ok(b.x >= list.x - 1 && b.x + b.width <= list.x + list.width + 1, `${key}: the tab it chose is in view`);
    }
    await phone.getByRole("tab", { name: "Initiative" }).click();
    await endFight();
    await phone.getByRole("button", { name: "Hide panels" }).click();
    await side.waitFor({ state: "hidden" });
    await pickTool(phone, "Select");
  });

  test("5. a player's open journal page hidden with the side panel counts as unread until it shows again", async () => {
    await view(player, playerCdp, { width: 1280, height: 800 });
    await reloadAt(player, 1);
    const side = sidePanel(player);
    await player.getByRole("tab", { name: /^Journal/ }).click();
    await player.getByRole("tabpanel", { name: /^Journal/ }).getByRole("button", { name: /^Lore/ }).click();
    await player.getByRole("heading", { name: "Lore" }).waitFor();
    await player.getByRole("button", { name: "Hide panels" }).click();
    await side.waitFor({ state: "hidden" });
    await editLore("The citadel fell at dawn.");
    const panels = toolbar(player).getByRole("button", { name: "Panels" });
    await panels.getByText("1 unread").waitFor();
    await panels.click();
    await side.waitFor();
    await player.getByText("The citadel fell at dawn.").waitFor();
    await waitFor("the page read once it shows", async () => ((await player.getByRole("tab", { name: /^Journal/ }).getByText("unread").count()) === 0 ? true : null));
    await player.getByRole("button", { name: "Back to Journal" }).click();
  });

  test("no page of this run threw", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors.filter((e) => e.startsWith("uncaught")), [], `${c.label} threw`);
  });
});

// ------------------------------------------------------------ raccoon-vtt: the handout viewer and the Library (case 8)

describe("raccoon-vtt: the handout viewer and the Library (case 8)", () => {
  /**
   * The handout viewer and the DM's Library (docs/design-v1-layout-hierarchy.md
   * section 5, move M6, and section 10 e2e case 8). A player's popup on a
   * computer opens as a card and grows to the window on the first zoom step,
   * by the wheel, a button or a key, and Zoom out or Reset zoom takes it back.
   * Expand grows it without a zoom. A sideways phone shows it whole-screen
   * from the start. On a touch tablet a pinch keeps the card's size until the
   * fingers lift. The Library's View opens any image it lists in the same
   * viewer.
   */

  let dmContext: BrowserContext;
  let dm: Page;
  /** Pat at a computer with a mouse. */
  let deskContext: BrowserContext;
  let desk: Page;
  /** Pip on a phone: held sideways, then upright. */
  let phoneContext: BrowserContext;
  let phone: Page;
  let phoneCdp: CDPSession;
  /** Pia on a touch tablet held upright. */
  let tabletContext: BrowserContext;
  let tablet: Page;
  let tabletCdp: CDPSession;
  let ops: OpSocket;
  const dmSocket = new SocketWatch("dm");
  const consoles = [new ConsoleWatch("dm"), new ConsoleWatch("desk"), new ConsoleWatch("phone"), new ConsoleWatch("tablet")] as const;

  const run = {
    roomId: "",
    roomName: `E2E viewer ${new Date().toISOString().slice(0, 19)}`,
    password: "",
    handoutImage: "",
    handoutTitle: "The old map",
    mapImage: "",
    tokenImage: "",
  };

  type Box = { x: number; y: number; width: number; height: number };

  /** A picture in one color, twice as wide as tall, as a map handout is. */
  function widePicture(): Promise<Buffer> {
    return sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 60, g: 90, b: 160 } } }).png().toBuffer();
  }

  function square(rgb: [number, number, number]): Promise<Buffer> {
    return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
  }

  /** Screenshots named `viewer-<name>.png`, never over one already there. */
  async function shot(page: Page, name: string): Promise<void> {
    if (SHOT_DIR === "0") return;
    mkdirSync(SHOT_DIR, { recursive: true });
    let file = path.join(SHOT_DIR, `viewer-${name}.png`);
    for (let n = 2; existsSync(file); n++) file = path.join(SHOT_DIR, `viewer-${name}-${n}.png`);
    await page.screenshot({ path: file });
  }

  /** Joins as a player through the API, so the page opens straight into the room. */
  async function join(context: BrowserContext, page: Page, name: string): Promise<void> {
    const origin = server.origin;
    const headers = { Origin: origin, "content-type": "application/json" };
    const joined = await context.request.post(`${origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await context.request.post(`${origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    await page.goto(`${origin}/r/${run.roomId}`);
    await page.getByRole("status", { name: "Connected" }).first().waitFor();
  }

  async function upload(context: BrowserContext, kind: "handout" | "map" | "token", data: Buffer): Promise<string> {
    const res = await context.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
    assert.ok(res.ok(), `uploading a ${kind} answered ${res.status()}`);
    return ((await res.json()) as { id: string }).id;
  }

  /**
   * The viewer's parts on the screen: the card (the dialog's first section),
   * the stage (the image's viewport, its wrapper's parent) and the image as
   * drawn, transform included.
   */
  async function parts(dialog: Locator): Promise<{ card: Box; stage: Box; img: Box }> {
    return dialog.evaluate((el) => {
      type Node = { querySelector(s: string): Node | null; parentElement: Node | null; getBoundingClientRect(): { x: number; y: number; width: number; height: number } };
      const root = el as unknown as Node;
      const box = (n: Node) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const img = root.querySelector("img")!;
      return { card: box(root.querySelector("section")!), stage: box(img.parentElement!.parentElement!), img: box(img) };
    });
  }

  /** Waits until the image has loaded and shows. */
  async function loaded(dialog: Locator, name: string): Promise<void> {
    await dialog.getByRole("img", { name }).waitFor();
    await waitFor("the image drawn", () =>
      dialog.getByRole("img", { name }).evaluate((el) => {
        const img = el as unknown as { complete: boolean; naturalWidth: number };
        return img.complete && img.naturalWidth > 0;
      }),
    );
  }

  const near = (a: number, b: number, within = 1.5) => Math.abs(a - b) <= within;

  /** Waits until the card fills the window, or until it is a card again (narrower than the window by its margin). */
  async function cardIs(dialog: Locator, want: "window" | "card", what: string): Promise<{ card: Box; stage: Box; img: Box }> {
    const vp = dialog.page().viewportSize()!;
    let last: { card: Box; stage: Box; img: Box } | null = null;
    try {
      await waitFor(what, async () => {
        last = await parts(dialog);
        const full = near(last.card.x, 0) && near(last.card.y, 0) && near(last.card.width, vp.width) && near(last.card.height, vp.height);
        return want === "window" ? full : !full && last.card.width < vp.width - 16;
      });
    } catch (err) {
      throw new Error(`${(err as Error).message}: ${JSON.stringify(last)}`);
    }
    return last!;
  }

  /** The image fitted to the stage, whole and centered: one side fills the stage, the other is centered in it. */
  function assertFitted(p: { stage: Box; img: Box }, what: string): void {
    const { stage, img } = p;
    const across = near(img.width, stage.width) && near(img.y - stage.y, (stage.height - img.height) / 2);
    const down = near(img.height, stage.height) && near(img.x - stage.x, (stage.width - img.width) / 2);
    assert.ok(across || down, `${what}: the image is not fitted to the stage: ${JSON.stringify(p)}`);
    assert.ok(img.x >= stage.x - 1 && img.y >= stage.y - 1 && img.x + img.width <= stage.x + stage.width + 1 && img.y + img.height <= stage.y + stage.height + 1, `${what}: the image runs past the stage: ${JSON.stringify(p)}`);
  }

  async function focusedName(page: Page): Promise<string> {
    return page.evaluate(() => {
      const el = (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
      return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
    });
  }

  /** Tab, up to a bound, until the named button has focus. */
  async function tabTo(page: Page, name: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      if ((await focusedName(page)) === name) return;
      await page.keyboard.press("Tab");
    }
    throw new Error(`Tab never reached ${name}, focus is on "${await focusedName(page)}"`);
  }

  /** Two fingers on a line through `at`, spread from `from` px apart to `to`, in small steps. The fingers stay down until `lift` is called. */
  async function pinch(cdp: CDPSession, at: { x: number; y: number }, from: number, to: number): Promise<{ lift(): Promise<void> }> {
    const points = (d: number) => [
      { x: at.x - d / 2, y: at.y, id: 1 },
      { x: at.x + d / 2, y: at.y, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
    const stepsN = 10;
    for (let i = 1; i <= stepsN; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * i) / stepsN) });
    return { lift: () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }).then(() => {}) };
  }

  async function insets(cdp: CDPSession, page: Page, size: { width: number; height: number }, i: { top: number; bottom: number; side: number }): Promise<void> {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: i.top, bottom: i.bottom, left: i.side, right: i.side } });
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
  }

  function popup(page: Page): Locator {
    return page.getByRole("dialog", { name: run.handoutTitle });
  }

  describe("raccoon-vtt handout viewer run", { timeout: 300_000 }, () => {
    before(async () => {
      dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      dm = await dmContext.newPage();
      deskContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      desk = await deskContext.newPage();
      phoneContext = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      phone = await phoneContext.newPage();
      phoneCdp = await phoneContext.newCDPSession(phone);
      tabletContext = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      tablet = await tabletContext.newPage();
      tabletCdp = await tabletContext.newCDPSession(tablet);
      [dm, desk, phone, tablet].forEach((p, i) => consoles[i]!.attach(p));
      await dmSocket.attach(dmContext, dm);
    });

    after(async () => {
      if (process.env.E2E_DEBUG === "1") {
        for (const c of consoles) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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
      await dmContext?.close();
      await deskContext?.close();
      await phoneContext?.close();
      await tabletContext?.close();
    });

    test("1. a DM's room, three players and a wide handout shown to all", async () => {
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
      const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });

      await join(deskContext, desk, "Pat");
      await insets(phoneCdp, phone, { width: 844, height: 390 }, { top: 0, bottom: 21, side: 47 });
      await join(phoneContext, phone, "Pip");
      await join(tabletContext, tablet, "Pia");

      run.handoutImage = await upload(dmContext, "handout", await widePicture());
      run.mapImage = await upload(dmContext, "map", await square([90, 140, 80]));
      await ops.send({ t: "handout.show", handout: { id: randomUUID(), assetId: run.handoutImage, title: run.handoutTitle, to: "all" } });
      for (const page of [desk, phone, tablet]) await loaded(popup(page), run.handoutTitle);
    });

    test("2. on a computer the popup is a card, one wheel step takes the window, and Zoom out or Reset zoom brings the card back", async () => {
      const dialog = popup(desk);
      const start = await cardIs(dialog, "card", "the popup as a card");
      assert.ok(near(start.card.width, 720), `the card is ${start.card.width} wide`);
      assertFitted(start, "card fit");
      await dialog.getByRole("button", { name: "Expand", exact: true }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Zoom out", exact: true }).isDisabled(), true, "Zoom out at card fit");
      assert.equal(await dialog.getByRole("button", { name: "Reset zoom" }).count(), 0, "Reset zoom at card fit");
      await shot(desk, "desk-card-fit");

      for (const back of ["Zoom out", "Reset zoom"]) {
        await desk.mouse.move(start.img.x + start.img.width / 2, start.img.y + start.img.height / 2);
        await desk.mouse.wheel(0, -100);
        const grown = await cardIs(dialog, "window", "the card at the window after one wheel step");
        assertFitted(grown, "window fit");
        assert.ok(grown.img.width > start.img.width + 100, `the image did not grow: ${JSON.stringify([start.img, grown.img])}`);
        assert.equal(await dialog.getByRole("button", { name: "Zoom out", exact: true }).isEnabled(), true, "Zoom out at the window's fit");
        if (back === "Zoom out") await shot(desk, "desk-window-fit");
        await dialog.getByRole("button", { name: back, exact: true }).click();
        const again = await cardIs(dialog, "card", `the card again after ${back}`);
        assertFitted(again, `card fit after ${back}`);
      }

      // A double click is a first step too, and the next one zooms in on the spot.
      await desk.mouse.dblclick(start.img.x + start.img.width / 2, start.img.y + start.img.height / 2);
      const clicked = await cardIs(dialog, "window", "the card at the window after a double click");
      assertFitted(clicked, "window fit after a double click");
      await desk.mouse.dblclick(clicked.img.x + clicked.img.width / 2, clicked.img.y + clicked.img.height / 2);
      await waitFor("magnified by a double click", async () => (await parts(dialog)).img.width > clicked.img.width * 2);
      await dialog.getByRole("button", { name: "Reset zoom" }).click();
      await cardIs(dialog, "card", "the card again after Reset zoom");
    });

    test("3. the zoom buttons by keyboard, and + − 0 and the arrows", async () => {
      const dialog = popup(desk);
      const zoomOut = dialog.getByRole("button", { name: "Zoom out", exact: true });
      await tabTo(desk, "Zoom in");
      await desk.keyboard.press("Enter");
      const window = await cardIs(dialog, "window", "Zoom in by keyboard");
      await desk.keyboard.press("Enter");
      await waitFor("magnified by keyboard", async () => (await parts(dialog)).img.width > window.img.width * 1.4);
      await desk.keyboard.press("Shift+Tab");
      assert.equal(await focusedName(desk), "Zoom out");
      await desk.keyboard.press("Enter");
      await waitFor("back at the window's fit", async () => near((await parts(dialog)).img.width, window.img.width));
      await desk.keyboard.press("Enter");
      await cardIs(dialog, "card", "Zoom out by keyboard to the card");
      // Zoom out is now disabled, and focus moved on to Zoom in rather than falling to the page.
      assert.equal(await zoomOut.isDisabled(), true);
      assert.equal(await focusedName(desk), "Zoom in");
      await desk.keyboard.press("Enter");
      await cardIs(dialog, "window", "Zoom in again");
      await tabTo(desk, "Reset zoom");
      await desk.keyboard.press("Enter");
      await cardIs(dialog, "card", "Reset zoom by keyboard");
      assert.equal(await focusedName(desk), "Zoom in");

      // The keys, from the dialog itself as it has focus when it opens.
      await dialog.focus();
      await desk.keyboard.type("+");
      const keyed = await cardIs(dialog, "window", "+ to the window");
      await desk.keyboard.press("=");
      await waitFor("= magnifies", async () => (await parts(dialog)).img.width > keyed.img.width * 1.4);
      const magnified = await parts(dialog);
      await desk.keyboard.press("ArrowRight");
      await waitFor("ArrowRight pans a tenth of the stage", async () => near((await parts(dialog)).img.x, magnified.img.x - magnified.stage.width / 10));
      await desk.keyboard.press("ArrowDown");
      await waitFor("ArrowDown pans a tenth of the stage", async () => near((await parts(dialog)).img.y, magnified.img.y - magnified.stage.height / 10));
      await desk.keyboard.press("ArrowLeft");
      await desk.keyboard.press("ArrowUp");
      await waitFor("back where it was", async () => {
        const p = await parts(dialog);
        return near(p.img.x, magnified.img.x) && near(p.img.y, magnified.img.y);
      });
      await shot(desk, "desk-magnified");
      await desk.keyboard.press("-");
      await waitFor("− to the window's fit", async () => near((await parts(dialog)).img.width, keyed.img.width));
      await desk.keyboard.press("-");
      await cardIs(dialog, "card", "− to the card");
      await desk.keyboard.type("+");
      await desk.keyboard.type("+");
      await waitFor("magnified by keys", async () => (await parts(dialog)).img.width > keyed.img.width * 1.4);
      await desk.keyboard.press("0");
      await cardIs(dialog, "card", "0 to the card");
    });

    test("4. Expand takes the card to the window without a zoom, and Zoom out stops at the window while it is pressed", async () => {
      const dialog = popup(desk);
      const expand = dialog.getByRole("button", { name: "Expand", exact: true });
      const zoomOut = dialog.getByRole("button", { name: "Zoom out", exact: true });
      assert.equal(await expand.getAttribute("aria-pressed"), "false");
      await expand.click();
      assert.equal(await expand.getAttribute("aria-pressed"), "true");
      const expanded = await cardIs(dialog, "window", "Expand to the window");
      assertFitted(expanded, "Expand's window fit");
      assert.equal(await zoomOut.isDisabled(), true, "Zoom out at the window's fit with Expand pressed");
      assert.equal(await dialog.getByRole("button", { name: "Reset zoom" }).count(), 0, "Reset zoom at the window's fit with Expand pressed");
      await shot(desk, "desk-expanded");
      await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
      await waitFor("magnified with Expand pressed", async () => (await parts(dialog)).img.width > expanded.img.width * 1.4);
      await zoomOut.click();
      await waitFor("Zoom out stopped at the window's fit", async () => near((await parts(dialog)).img.width, expanded.img.width));
      assert.equal(await zoomOut.isDisabled(), true);
      await desk.keyboard.press("-");
      await desk.waitForTimeout(150);
      await cardIs(dialog, "window", "still the window after − with Expand pressed");
      await expand.click();
      assert.equal(await expand.getAttribute("aria-pressed"), "false");
      await cardIs(dialog, "card", "Expand again back to the card");
    });

    test("5. a sideways phone shows the popup whole-screen from the start, with no Expand, and Zoom in magnifies", async () => {
      const dialog = popup(phone);
      const start = await cardIs(dialog, "window", "the whole screen from the start");
      assertFitted(start, "the sideways phone's fit");
      assert.equal(await dialog.getByRole("button", { name: "Expand", exact: true }).count(), 0, "Expand on a sideways phone");
      assert.equal(await dialog.getByRole("button", { name: "Zoom out", exact: true }).isDisabled(), true, "Zoom out at the fit");
      assert.equal(await dialog.getByRole("button", { name: "Reset zoom" }).count(), 0);
      // The header's and the zoom buttons' boxes keep clear of the 47 px sides and the 21 px foot.
      for (const name of [`Close ${run.handoutTitle}`, "Zoom in", "Download"]) {
        const b = (await dialog.getByRole("button", { name, exact: true }).boundingBox())!;
        assert.ok(b.x >= 47 - 1 && b.x + b.width <= 844 - 47 + 1 && b.y + b.height <= 390 - 21 + 1, `${name} sits under a safe area: ${JSON.stringify(b)}`);
      }
      await shot(phone, "phone-844x390-fit");
      await dialog.getByRole("button", { name: "Zoom in", exact: true }).tap();
      await waitFor("magnified on the sideways phone", async () => (await parts(dialog)).img.height > start.img.height * 1.4);
      await cardIs(dialog, "window", "still the whole screen");
      await shot(phone, "phone-844x390-magnified");
      await dialog.getByRole("button", { name: "Reset zoom" }).tap();
      await waitFor("back at the fit", async () => near((await parts(dialog)).img.height, start.img.height));
    });

    test("6. on a touch tablet a pinch keeps the card until the fingers lift, then grows it keeping the image's box", async () => {
      const dialog = popup(tablet);
      const start = await cardIs(dialog, "card", "the tablet's card");
      const center = { x: start.stage.x + start.stage.width / 2, y: start.stage.y + start.stage.height / 2 };

      const fingers = await pinch(tabletCdp, center, 100, 250);
      await tablet.waitForTimeout(150);
      const during = await parts(dialog);
      assert.deepEqual(during.card, start.card, "the card changed size under the fingers");
      assert.ok(near(during.img.width, start.img.width * 2.5, 3), `the pinch did not zoom 2.5 times: ${JSON.stringify([start.img, during.img])}`);
      await fingers.lift();
      const grown = await cardIs(dialog, "window", "the card at the window once the fingers lift");
      for (const k of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(grown.img[k] - during.img[k]) < 2, `the image's ${k} moved: ${during.img[k]} to ${grown.img[k]}`);
      assert.equal(await dialog.getByRole("button", { name: "Zoom out", exact: true }).isEnabled(), true);
      await shot(tablet, "tablet-pinch-grown");
      await dialog.getByRole("button", { name: "Reset zoom" }).tap();
      await cardIs(dialog, "card", "Reset zoom back to the card");

      // A small pinch, short of the window's fit (820 / 720 times the card's here): the card grows and the image settles fitted to the window.
      const small = await pinch(tabletCdp, center, 200, 210);
      await tablet.waitForTimeout(150);
      assert.deepEqual((await parts(dialog)).card, start.card, "the card changed size under a small pinch");
      await small.lift();
      const settled = await cardIs(dialog, "window", "the card at the window after a small pinch");
      assertFitted(settled, "a small pinch's window fit");
      assert.equal(await dialog.getByRole("button", { name: "Zoom out", exact: true }).isEnabled(), true, "Zoom out after a small pinch");
      await dialog.getByRole("button", { name: "Reset zoom" }).waitFor();
      await shot(tablet, "tablet-small-pinch-settled");
    });

    test("7. an upright phone zooms a wide image into the stage's whole height", async () => {
      await insets(phoneCdp, phone, { width: 390, height: 844 }, { top: 47, bottom: 34, side: 0 });
      const dialog = popup(phone);
      const start = await cardIs(dialog, "window", "the upright phone's whole screen");
      assertFitted(start, "the upright phone's fit");
      assert.ok(start.img.height < start.stage.height * 0.4, `a wide image at the fit is already tall: ${JSON.stringify(start)}`);
      for (let i = 0; i < 3; i++) await dialog.getByRole("button", { name: "Zoom in", exact: true }).tap();
      let p = start;
      await waitFor("the image over most of the stage's height", async () => {
        p = await parts(dialog);
        const top = Math.max(p.img.y, p.stage.y);
        const bottom = Math.min(p.img.y + p.img.height, p.stage.y + p.stage.height);
        return bottom - top > p.stage.height * 0.8;
      });
      await shot(phone, "phone-390x844-zoomed");
    });

    test("8. the DM's Library: handouts first, clean-up at the foot, and View on every image", async () => {
      run.tokenImage = await upload(dmContext, "token", await square([200, 160, 60]));
      await dm.getByRole("tab", { name: "Library", exact: true }).click();
      const handouts = dm.getByRole("tabpanel", { name: "Library" }).getByRole("list", { name: "Handouts in this room" });
      await handouts.waitFor();
      // Handouts, Maps, Token images, then the clean-up under its label.
      const order = await dm.evaluate(() => {
        const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getAttribute(n: string): string | null; textContent: string | null; tagName: string }> } }).document;
        return Array.from(doc.querySelectorAll('ul[aria-label$="in this room"], h3, button')).flatMap((el) => {
          const label = el.tagName === "UL" ? el.getAttribute("aria-label") : (el.textContent ?? "").trim();
          return label && /in this room|^Clean up$|^Delete \d+ not in use/.test(label) ? [label] : [];
        });
      });
      assert.deepEqual(
        order.map((l) => l.replace(/ \(.*\)$/, "")),
        ["Handouts in this room", "Maps in this room", "Token images in this room", "Clean up", "Delete 2 not in use"],
        "the DM's library order",
      );
      await shot(dm, "library-dm-order");

      // A handout's View, first in the detail's row, opens the viewer under the title of the handout showing it.
      await handouts.getByRole("button", { name: "Handout", exact: true }).click();
      // Each section keeps its own detail card open, and the DM panel's "View as a player" has a View of its own.
      const library = dm.getByRole("tabpanel", { name: "Library" });
      const section = (list: string) => library.locator("section").filter({ has: dm.getByRole("list", { name: list }) });
      const view = section("Handouts in this room").getByRole("button", { name: "View", exact: true });
      await shot(dm, "library-dm-handout-detail");
      await view.click();
      const viewer = dm.getByRole("dialog", { name: run.handoutTitle });
      await loaded(viewer, run.handoutTitle);
      assert.equal(await viewer.getByRole("button", { name: "Download" }).count(), 0, "Download in the Library's viewer");
      await viewer.getByRole("button", { name: "Expand", exact: true }).waitFor();
      assertFitted(await cardIs(viewer, "card", "the Library viewer as a card"), "the Library viewer's fit");
      await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
      await cardIs(viewer, "window", "the Library viewer at the window");
      await shot(dm, "library-dm-handout-window");
      await viewer.getByRole("button", { name: `Close ${run.handoutTitle}` }).click();
      await viewer.waitFor({ state: "detached" });
      assert.equal(await focusedName(dm), "View", "focus back on View");

      // The thumbnail is a pointer shortcut to the same viewer, hidden from screen readers and no Tab stop.
      const thumb = library.locator('button[aria-hidden="true"][tabindex="-1"]').filter({ has: dm.locator("img") });
      assert.equal(await thumb.count(), 1);
      await thumb.click();
      await loaded(viewer, run.handoutTitle);
      await viewer.getByRole("button", { name: `Close ${run.handoutTitle}` }).click();
      await viewer.waitFor({ state: "detached" });
      assert.equal(await focusedName(dm), "View", "focus on View after the thumbnail's viewer");

      // A map's View is titled "Map". While its image is on the way, the viewer says so.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const image = `**/api/assets/${run.mapImage}/full`;
      await dm.route(image, async (route) => {
        await held;
        await route.continue();
      });
      await library.getByRole("list", { name: "Maps in this room" }).getByRole("button", { name: /^Map/ }).click();
      await section("Maps in this room").getByRole("button", { name: "View", exact: true }).click();
      const map = dm.getByRole("dialog", { name: "Map", exact: true });
      await map.getByRole("status").filter({ hasText: "Loading the image…" }).waitFor();
      assert.equal(await map.getByRole("button", { name: "Zoom in", exact: true }).count(), 0, "zoom buttons before the image arrived");
      await shot(dm, "library-dm-map-loading");
      release();
      await loaded(map, "Map");
      await map.getByRole("status").filter({ hasText: "Loading the image…" }).waitFor({ state: "detached" });
      await dm.unroute(image);
      assert.equal(await map.getByRole("button", { name: "Download" }).count(), 0);
      await shot(dm, "library-dm-map");
      await map.getByRole("button", { name: "Close Map" }).click();
      await map.waitFor({ state: "detached" });
    });

    test("9. a player's token image opens in the viewer too", async () => {
      await upload(deskContext, "token", await square([180, 60, 60]));
      await popup(desk).getByRole("button", { name: `Close ${run.handoutTitle}` }).click();
      await popup(desk).waitFor({ state: "detached" });
      await desk.getByRole("tab", { name: "Library", exact: true }).click();
      await desk.getByRole("list", { name: "Token images in this room" }).getByRole("button", { name: /^Token image/ }).first().click();
      await desk.getByRole("button", { name: "View", exact: true }).click();
      const viewer = desk.getByRole("dialog", { name: "Token image" });
      await loaded(viewer, "Token image");
      assert.equal(await viewer.getByRole("button", { name: "Download" }).count(), 0);
      await shot(desk, "library-player-token");
      await desk.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached" });
    });

    test("10. no page logged an error", () => {
      for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
    });
  });
});

// ------------------------------------------------------------ raccoon-vtt: the moves in the DM panel, Scenes, Members, Characters and the party bar (case 9)

describe("raccoon-vtt: the moves in the DM panel, Scenes, Members, Characters and the party bar (case 9)", () => {
  /**
   * The hierarchy pass's moves M4, M5, M7, M8 and M9
   * (docs/design-v1-layout-hierarchy.md 6.3, e2e case 9), for a DM at a
   * computer with the side panel, then on a phone:
   *
   * - M4: the DM panel leads with Handouts, then Players' screens, Check
   *   their view, the player link and the table display. Away from the
   *   players' scene, its notice leads Players' screens.
   * - M5: "Add a map image" sits in This scene, right after the name, and
   *   Map phases and Vision come above Grid.
   * - M7: each other member's Manage opens their Kick and Remove, and
   *   another DM's Remove DM too.
   * - M8: Long rest for the party sits below the list of characters.
   * - M9: the party bar shows AC as an image named "Armor Class 15" and
   *   passive Perception as the text "PP 13".
   *
   * A scratch file, to be folded into e2e/layout.e2e.ts. Panels and sections
   * are found by name, never by position, since the panels' order changes
   * with M3. It runs on E2E_PORT plus eleven, with the smoke run's other
   * environment variables (smoke.e2e.ts).
   */

  let dmContext: BrowserContext;
  let dm: Page;
  let playerContext: BrowserContext;
  let quinnContext: BrowserContext;
  let ops: OpSocket;
  const dmSocket = new SocketWatch("dm");
  const dmConsole = new ConsoleWatch("dm");
  const phoneConsole = new ConsoleWatch("phone");
  const shotsTaken: string[] = [];

  const run = {
    roomId: "",
    roomName: `E2E moves ${new Date().toISOString().slice(0, 19)}`,
    sceneId: "",
    patId: "",
    quinnId: "",
    cellarId: randomUUID(),
    thorn: { id: randomUUID(), characterId: randomUUID() },
    bree: { characterId: randomUUID() },
  };

  /** The few DOM parts the page functions read, typed by hand: the e2e files compile without the DOM library. */
  type El = {
    textContent: string | null;
    parentElement: El | null;
    children: ArrayLike<El>;
    closest(selector: string): El | null;
    querySelectorAll(selector: string): ArrayLike<El>;
  };

  function actor(ac: number, passivePerception: number) {
    return {
      hp: { cur: 24, max: 24, temp: 0 },
      life: "alive",
      ac,
      speeds: { walk: 30 },
      initBonus: 0,
      passivePerception,
      senses: "",
      effects: [],
      deathSaves: { ok: 0, fail: 0 },
      notes: "",
      dmNotes: "",
    };
  }

  /** A screenshot named `moves-<name>.png`, numbered on rather than written over one already there. */
  async function shot(target: Page | Locator, name: string): Promise<void> {
    if (SHOT_DIR === "0") return;
    mkdirSync(SHOT_DIR, { recursive: true });
    let file = path.join(SHOT_DIR, `moves-${name}.png`);
    for (let n = 2; existsSync(file); n++) file = path.join(SHOT_DIR, `moves-${name}-${n}.png`);
    await target.screenshot({ path: file });
    shotsTaken.push(file);
  }

  /** The side panel's tab panel after its tab is chosen, found by the tab's name. */
  async function sideTab(page: Page, name: string): Promise<Locator> {
    await page.getByRole("tablist", { name: "Panels" }).getByRole("tab", { name, exact: true }).click();
    const panel = page.getByRole("tabpanel", { name });
    await panel.waitFor();
    return panel;
  }

  /** On a phone: the panel's sheet, opened from the list of panels. */
  async function phoneSheet(page: Page, name: string): Promise<Locator> {
    await page.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true }).click();
    const sheet = page.locator(`section[aria-label="${name}"]`);
    await sheet.waitFor();
    return sheet;
  }

  /** Each section's label in a panel, in order: the first heading that belongs to the section itself. */
  function sectionLabels(panel: Locator): Promise<string[]> {
    return panel.evaluate((root) =>
      Array.from((root as unknown as El).querySelectorAll("section"))
        .map((section) => Array.from(section.querySelectorAll("h2, h3, h4")).find((h) => h.closest("section") === section)?.textContent?.trim() ?? "")
        .filter((label) => label !== ""),
    );
  }

  /** The section of a panel whose label is `label`. */
  function section(panel: Locator, label: string): Locator {
    return panel.locator("section").filter({ has: panel.page().getByRole("heading", { name: label, exact: true }) }).last();
  }

  /** Where `inner`, or the child of `parent` that holds it, stands among `parent`'s children. */
  async function childIndex(parent: Locator, inner: Locator): Promise<number> {
    const outer = await parent.elementHandle();
    return inner.evaluate((el, p) => {
      const root = p as unknown as El;
      let e = el as unknown as El;
      while (e.parentElement && e.parentElement !== root) e = e.parentElement;
      return e.parentElement === root ? Array.from(root.children).indexOf(e) : -1;
    }, outer);
  }

  async function box(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const b = await target.boundingBox();
    assert.ok(b, "not on the page");
    return b;
  }

  describe("raccoon-vtt: the hierarchy pass's moves in the DM panel, Scenes, Members, Characters and the party bar", { timeout: 300_000 }, () => {
    before(async () => {
      dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      dm = await dmContext.newPage();
      dmConsole.attach(dm);
      await dmSocket.attach(dmContext, dm);
      playerContext = await browser.newContext();
      quinnContext = await browser.newContext();
    });

    after(async () => {
      if (process.env.E2E_DEBUG === "1") {
        console.error(`[${dmConsole.label}] errors`, dmConsole.errors, "warnings", dmConsole.warnings);
        console.error(server?.output().split("\n").slice(-40).join("\n"));
      }
      if (shotsTaken.length > 0) console.error(`screenshots:\n${shotsTaken.join("\n")}`);
      ops?.close();
      if (run.roomId && dmContext) {
        try {
          const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
          if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
        } catch (err) {
          console.error(`Deleting room ${run.roomId} failed`, err);
        }
      }
      await dmContext?.close();
      await playerContext?.close();
      await quinnContext?.close();
    });

    test("1. a DM's room with Pat, who plays Thorn (AC 15, passive Perception 13), Bree with no player yet, and Quinn, a second DM", async () => {
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
      const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

      // Pat joins over the API alone: the roster and the party bar need a player, not a player's screen.
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      run.patId = ((await done.json()) as { member: { id: string } }).member.id;

      // Quinn becomes a DM through an invite, so the roster has a DM row to manage.
      const invite = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/dm/invite`, { headers, data: {} });
      assert.ok(invite.ok(), `minting an invite answered ${invite.status()}`);
      const { token } = (await invite.json()) as { token: string };
      const redeemed = await quinnContext.request.post(`${server.origin}/api/rooms/${run.roomId}/dm/redeem`, { headers, data: { token, name: "Quinn" } });
      assert.ok(redeemed.ok(), `redeeming the invite answered ${redeemed.status()}`);
      run.quinnId = ((await redeemed.json()) as { memberId: string }).memberId;

      const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
      await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(15, 13) } });
      await ops.send({ t: "character.create", character: { id: run.bree.characterId, name: "Bree", size: "medium", ownerIds: [], actor: actor(12, 11) } });
      await ops.send({
        t: "token.create",
        token: { id: run.thorn.id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: Math.floor(bounds.w / 2), y: Math.floor(bounds.h / 2), disposition: "ally", actor: { ref: run.thorn.characterId } },
      });
      await waitFor("Thorn's token in the DM's view", () => dmSocket.state?.tokens[run.thorn.id]);
    });

    test("2. M4: the DM panel leads with Handouts, then the players' screens, the checks, the player link and the table display", async () => {
      const panel = await sideTab(dm, "DM");
      await section(panel, "Handouts").waitFor();
      const labels = await sectionLabels(panel);
      assert.deepEqual(labels, ["Handouts", "Players' screens", "Check their view", "Player link", "Table display"]);

      const screens = section(panel, "Players' screens");
      await screens.getByRole("switch", { name: /^Follow me/ }).waitFor();
      await screens.getByRole("button", { name: "Bring everyone here" }).waitFor();
      await screens.getByRole("switch", { name: /^Black out players' screens/ }).waitFor();
      // Black out, rare and drastic, no longer sits under the panel's first control.
      assert.equal(await section(panel, "Handouts").getByRole("switch").count(), 0);

      const checks = section(panel, "Check their view");
      await checks.getByRole("combobox", { name: "View as a player" }).waitFor();
      assert.equal(await checks.getByRole("switch", { name: /^Follow me|^Black out/ }).count(), 0);
      await shot(panel, "dm-panel-order");
    });

    test("3. M4: away from the players' scene, the notice leads Players' screens, and Party sight sits in Check their view", async () => {
      const players = dmSocket.state!.scenes[run.sceneId]!.name;
      await ops.send({
        t: "scene.create",
        scene: { id: run.cellarId, name: "Cellar", bounds: { w: 12, h: 8 }, background: "#2b2b31", fogEnabled: false, autoWalls: "off", blockMovement: false, vision: { on: true, light: "dark" } },
      });
      const scenes = await sideTab(dm, "Scenes");
      await scenes.getByRole("button", { name: /^Cellar/ }).click();
      await waitFor("the DM on the cellar", () => dmSocket.you?.sceneId === run.cellarId || null, 30_000);

      const panel = await sideTab(dm, "DM");
      const screens = section(panel, "Players' screens");
      const notice = screens.getByRole("status").filter({ hasText: /^You are looking at a different scene than the players/ });
      await notice.waitFor();
      assert.equal(await childIndex(screens, notice), 1, "the notice comes first, under the label");
      assert.equal(await screens.getByRole("button", { name: "Bring everyone here" }).isDisabled(), true);
      const checks = section(panel, "Check their view");
      await checks.getByRole("switch", { name: /^Party sight/ }).waitFor();
      assert.equal(await screens.getByRole("switch", { name: /^Party sight/ }).count(), 0);
      await shot(panel, "dm-panel-away-from-players");

      await (await sideTab(dm, "Scenes")).getByRole("button", { name: new RegExp(`^${players}`) }).click();
      await waitFor("the DM back on the players' scene", () => dmSocket.you?.sceneId === run.sceneId || null, 30_000);
    });

    test("4. M5: the map image is a row of This scene right after the name, and Map phases and Vision come above Grid", async () => {
      let panel = await sideTab(dm, "Scenes");
      let thisScene = section(panel, "This scene");
      const add = thisScene.getByRole("button", { name: "Add a map image" });
      await add.waitFor();
      await thisScene.getByText("No map image yet.", { exact: true }).waitFor();
      const nameAt = await childIndex(thisScene, thisScene.getByRole("textbox", { name: "Scene name" }));
      const imageAt = await childIndex(thisScene, add);
      const fogAt = await childIndex(thisScene, thisScene.getByRole("switch", { name: /^Fog/ }));
      assert.equal(imageAt, nameAt + 1, "the map image comes right after the scene's name");
      assert.equal(fogAt, imageAt + 1, "Fog follows the map image");
      let labels = await sectionLabels(panel);
      assert.equal(labels.includes("Map image"), false, "a Map image section is left");
      // Map phases shows once the scene has a map image.
      assert.deepEqual(labels.slice(labels.indexOf("This scene")), ["This scene", "Vision", "Grid", "Movement", "Map builder", "Export as image", "Delete"]);
      await thisScene.scrollIntoViewIfNeeded();
      await shot(dm, "scenes-this-scene-no-map");

      // On the players' scene the picker comes after its warning, with the first map's fog choice, under the row as before.
      await add.click();
      const picker = thisScene.getByLabel("Choose the image");
      await picker.waitFor({ state: "attached" });
      await thisScene.getByText(/^The players are on this scene\./).waitFor();
      await thisScene.getByRole("checkbox", { name: /^Start it under fog/ }).waitFor();
      await shot(thisScene, "scenes-map-image-asks-first");
      const image = path.join(work, "cave.png");
      await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 90, g: 80, b: 70 } } }).png().toFile(image);
      await picker.setInputFiles(image);
      await waitFor("the map on the scene", () => dmSocket.state?.scenes[run.sceneId]?.map ?? null, 30_000);
      // A first image with no scale in its name brings up the grid tool, as before.
      await dm.getByRole("button", { name: "Select", exact: true }).click();

      panel = await sideTab(dm, "Scenes");
      thisScene = section(panel, "This scene");
      await thisScene.getByRole("button", { name: "Replace map image" }).waitFor();
      await thisScene.getByRole("button", { name: "Remove map image" }).waitFor();
      await thisScene.getByText("A 500 × 400 px image.", { exact: true }).waitFor();
      assert.equal(await childIndex(thisScene, thisScene.getByRole("button", { name: "Replace map image" })), imageAt);
      labels = await sectionLabels(panel);
      assert.deepEqual(labels.slice(labels.indexOf("This scene")), ["This scene", "Map phases", "Vision", "Grid", "Movement", "Map builder", "Export as image", "Delete"]);
      await thisScene.scrollIntoViewIfNeeded();
      await shot(dm, "scenes-this-scene-with-map");
    });

    test("5. M7: Manage on a member's row opens their Kick and Remove, and another DM's Remove DM, each with its confirm, and closes them again", async () => {
      await sideTab(dm, "Menu");
      await dm.getByRole("button", { name: /^Members/ }).click();
      const roster = dm.getByRole("list", { name: "Members" });
      await roster.waitFor();
      const manage = roster.getByRole("button", { name: "Manage Pat", exact: true });
      assert.equal(await manage.getAttribute("aria-expanded"), "false");
      assert.equal(await dm.getByRole("button", { name: "Kick", exact: true }).count(), 0, "Kick shows before Manage");
      assert.equal(await dm.getByRole("button", { name: "Remove", exact: true }).count(), 0, "Remove shows before Manage");
      // The DM's own row has nothing to manage.
      assert.equal(await roster.getByRole("button", { name: /^Manage Dana/ }).count(), 0);

      await manage.click();
      assert.equal(await manage.getAttribute("aria-expanded"), "true");
      const actions = dm.locator(`[id="${await manage.getAttribute("aria-controls")}"]`);
      assert.equal(await actions.getAttribute("aria-label"), "Manage Pat");
      await actions.getByRole("button", { name: "Kick", exact: true }).waitFor();
      await actions.getByRole("button", { name: "Remove", exact: true }).waitFor();
      assert.equal(await actions.getByRole("button", { name: "Remove DM" }).count(), 0, "a player has no Remove DM");
      await shot(dm, "members-manage-open");

      // Remove asks first, as before, and Cancel leaves Pat as they are.
      await actions.getByRole("button", { name: "Remove", exact: true }).click();
      const removing = actions.getByRole("group", { name: "Remove" });
      await removing.getByText(/^Sign Pat out on every device and take them off this list\?/).waitFor();
      await removing.getByRole("button", { name: "Cancel" }).click();
      await removing.waitFor({ state: "detached" });

      // Kick asks first, then signs Pat out and says so.
      await actions.getByRole("button", { name: "Kick", exact: true }).click();
      const kicking = actions.getByRole("group", { name: "Kick" });
      await kicking.getByText(/^Sign Pat out on every device\?/).waitFor();
      await kicking.getByRole("button", { name: "Kick", exact: true }).click();
      await dm.getByRole("status").filter({ hasText: "Pat was signed out." }).waitFor();
      assert.ok(dmSocket.state?.members[run.patId], "a kick keeps Pat in the roster");

      // Manage closes the actions, and what happened still shows under the row.
      await manage.click();
      assert.equal(await manage.getAttribute("aria-expanded"), "false");
      assert.equal(await manage.getAttribute("aria-controls"), null);
      assert.equal(await dm.getByRole("button", { name: "Kick", exact: true }).count(), 0, "Kick still shows after Manage closed");
      await dm.getByRole("status").filter({ hasText: "Pat was signed out." }).waitFor();

      // Another DM's row holds Remove DM as well, first, as before.
      const manageQuinn = roster.getByRole("button", { name: "Manage Quinn", exact: true });
      assert.equal(await dm.getByRole("button", { name: "Remove DM" }).count(), 0, "Remove DM shows before Manage");
      await manageQuinn.click();
      assert.equal(await manageQuinn.getAttribute("aria-expanded"), "true");
      const quinn = dm.locator(`[id="${await manageQuinn.getAttribute("aria-controls")}"]`);
      assert.deepEqual((await quinn.getByRole("button").allTextContents()).map((t) => t.trim()), ["Remove DM", "Kick", "Remove"]);
      await quinn.getByRole("button", { name: "Remove DM" }).click();
      await quinn.getByRole("group", { name: "Remove DM" }).getByText(/^Quinn loses DM on every device/).waitFor();
      await quinn.getByRole("group", { name: "Remove DM" }).getByRole("button", { name: "Cancel" }).click();
      await manageQuinn.click();
      assert.equal(await dm.getByRole("button", { name: "Remove DM" }).count(), 0, "Remove DM still shows after Manage closed");
      await dm.getByRole("button", { name: "Back to Menu" }).click();
    });

    test("6. M8: Long rest for the party sits below the DM's list of characters", async () => {
      const panel = await sideTab(dm, "Characters");
      const rest = panel.getByRole("button", { name: "Long rest for the party" });
      await rest.waitFor();
      const restTop = (await box(rest)).y;
      for (const name of ["Bree", "Thorn"]) {
        const row = panel.getByRole("button", { name: new RegExp(`^${name}\\b`) });
        const b = await box(row);
        assert.ok(b.y + b.height <= restTop, `${name}'s row ends at ${b.y + b.height}, under Long rest at ${restTop}`);
      }
      assert.ok((await box(panel.getByRole("button", { name: "New character" }))).y < restTop, "New character still leads");
      await shot(panel, "characters-long-rest-below");
    });

    test("7. M9: the party bar shows Thorn's AC as an image named Armor Class 15 and passive Perception as PP 13", async () => {
      const party = dm.getByRole("region", { name: "Party" });
      await party.waitFor();
      const badge = party.getByRole("img", { name: "Armor Class 15", exact: true });
      await badge.waitFor();
      assert.equal(await badge.getAttribute("title"), "Armor Class");
      const size = await box(badge);
      assert.deepEqual([size.width, size.height], [20, 18], "the sm badge for two digits");
      await party.getByText("PP 13", { exact: true }).waitFor();
      assert.equal(await party.getByText("Passive Perception 13", { exact: true }).count(), 1, "the words a screen reader reads");
      // The value is no longer named only in a tooltip.
      assert.equal(await party.locator('[title="AC"], [title="Passive Perception"]').count(), 0);
      await shot(party, "party-bar-ac-pp");
    });

    test("8. on a phone: Manage takes a 44 px tap, and the moved controls show in their sheets", async () => {
      // A page of its own: reloading the wide one just after it shrank to a phone's size sometimes landed on Home.
      const phone = await dmContext.newPage();
      phoneConsole.attach(phone);
      await phone.setViewportSize({ width: 390, height: 844 });
      await phone.goto(`${server.origin}/r/${run.roomId}`);
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();

      let sheet = await phoneSheet(phone, "Menu");
      await sheet.getByRole("button", { name: /^Members/ }).click();
      const manage = sheet.getByRole("button", { name: "Manage Pat", exact: true });
      await manage.click();
      const m = await box(manage);
      assert.ok(m.width >= 44 && m.height >= 44, `Manage is ${m.width} by ${m.height}`);
      for (const name of ["Kick", "Remove"]) {
        const b = await box(sheet.getByRole("button", { name, exact: true }));
        assert.ok(b.width >= 44 && b.height >= 44, `${name} is ${b.width} by ${b.height}`);
      }
      await shot(phone, "phone-members-manage-open");
      await sheet.getByRole("button", { name: /^Close (Menu|Members)$/ }).click();

      sheet = await phoneSheet(phone, "DM");
      await sheet.getByRole("heading", { name: "Handouts", exact: true }).waitFor();
      await shot(phone, "phone-dm-panel");
      await sheet.getByRole("button", { name: "Close DM" }).click();

      sheet = await phoneSheet(phone, "Scenes");
      const replace = section(sheet, "This scene").getByRole("button", { name: "Replace map image" });
      await replace.scrollIntoViewIfNeeded();
      const r = await box(replace);
      assert.ok(r.height >= 44, `Replace map image is ${r.height} tall`);
      await shot(phone, "phone-scenes-this-scene");
      await sheet.getByRole("button", { name: "Close Scenes" }).click();

      sheet = await phoneSheet(phone, "Party");
      await sheet.getByRole("img", { name: "Armor Class 15", exact: true }).waitFor();
      await sheet.getByText("PP 13", { exact: true }).waitFor();
      await shot(phone, "phone-party");
      await sheet.getByRole("button", { name: "Close Party" }).click();
      await phone.close();
    });

    test("9. no page errors along the way", () => {
      assert.deepEqual([...dmConsole.errors, ...phoneConsole.errors].filter((e) => e.startsWith("uncaught")), []);
    });
  });
});
