import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { AreaTemplate, Token } from "../shared/model.ts";
import { footprintRect } from "../shared/rules/footprint.ts";
import { cubeCenter } from "../client/features/areas/placement.ts";
import { ConsoleWatch, dragCells, OpSocket, openSideTab, pagePoint, pickOption, pickTool, reopenRoom, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { SQUARES } from "../shared/rules/grid.ts";

/**
 * The area tool's From control end to end
 * (docs/design-v1-area-from-character.md section 6): a player's toggle on
 * by default, the saved choice across tools and a fresh selection, taps
 * that aim while their creature casts, Set caster and Copy from a goblin,
 * Entangle centered on a token, the range reading, an aura that follows,
 * a companion's chip, rebuilt drafts, a second scene, deleted and dead
 * creatures, the DM's toggle, the narrowest row, names and focus, and
 * nothing sent to another player.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus eighteen: plus seventeen
 * is the split panel's file.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 18;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-areas-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
/** Pat, who plays Thorn, on a phone. */
let patContext: BrowserContext;
let pat: Page;
let patCdp: CDPSession;
/** Kim, another player, on a second phone. */
let kimContext: BrowserContext;
let kim: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const kimSocket = new SocketWatch("kim");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), kim: new ConsoleWatch("kim") };

const run = {
  roomId: "",
  roomName: `E2E areas ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  secondId: randomUUID(),
  patId: "",
  kimId: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  pip: randomUUID(),
  goblins: [randomUUID(), randomUUID(), randomUUID()],
};

/** Thorn at 3,5, Goblin 1 east of him in a cone's reach, Goblin 2 south-east and Goblin 3 further east. */
const AT = { thorn: { x: 3, y: 5 }, goblins: [{ x: 6, y: 5 }, { x: 6, y: 9 }, { x: 10, y: 5 }] } as const;
const BOUNDS = { w: 16, h: 12 };

function actor(over: Record<string, unknown> = {}) {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
    life: "alive",
    ac: 12,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
    ...over,
  };
}

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

function tokenOp(id: string, sceneId: string, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId, size: "medium", visibility: "all", ...extra } };
}

async function addThorn(id: string, sceneId: string, at: { x: number; y: number } = AT.thorn): Promise<void> {
  await ops.send(tokenOp(id, sceneId, { kind: "pc", name: "Thorn", ...at, disposition: "ally", actor: { ref: run.thornChar } }));
  await waitFor("Thorn on Pat's map", () => (patSocket.state?.tokens[id] ? true : null)).catch(() => undefined);
}

function options(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Area options" });
}

/** The From control in the row. */
function from(page: Page): Locator {
  return options(page).locator('[data-options-row] > [data-rvtt-slot="from"] button').first();
}

async function line(page: Page): Promise<string> {
  return (await options(page).locator("[data-options-line]").first().textContent()) ?? "";
}

/** Waits for the From control to read a name and state: "on", "off", "chip", "disabled", or "none" for no control. */
async function fromIs(page: Page, name: string | null, state: "on" | "off" | "chip" | "disabled" | "none"): Promise<void> {
  let seen = "";
  await waitFor(`From "${name}" ${state}`, async () => {
    const button = from(page);
    if ((await button.count()) === 0) {
      seen = "no control";
      return state === "none";
    }
    const [label, pressed, popup, disabled] = await Promise.all([
      button.getAttribute("aria-label"),
      button.getAttribute("aria-pressed"),
      button.getAttribute("aria-haspopup"),
      button.getAttribute("aria-disabled"),
    ]);
    const now = disabled === "true" ? "disabled" : popup === "dialog" ? "chip" : pressed === "true" ? "on" : "off";
    seen = `${label} ${now}`;
    return label === name && now === state;
  }).catch((err: Error) => {
    throw new Error(`${err.message}: it read ${seen}`);
  });
}

/** Taps a world point's page position, as a finger on a phone and a click at the DM's computer. */
async function tapAt(page: Page, world: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, BOUNDS, world);
  if (page === dm) await page.mouse.click(p.x, p.y);
  else await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(200);
}

async function tapCellOf(page: Page, cell: { x: number; y: number }): Promise<void> {
  await tapAt(page, { x: cell.x + 0.5, y: cell.y + 0.5 });
}

/** Presses a slot's control wherever it stands: inline, or in ⋯. */
async function pressSlot(page: Page, id: string): Promise<void> {
  const inline = options(page).locator(`[data-options-row] > [data-rvtt-slot="${id}"] button`).first();
  if ((await inline.count()) > 0 && (await inline.isVisible())) {
    await inline.click();
    return;
  }
  await options(page).getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: "More Area options" });
  await more.locator(`[data-rvtt-slot="${id}"] button`).first().click();
  if (await more.isVisible()) await page.keyboard.press("Escape");
  await more.waitFor({ state: "detached" });
}

/** Places the area being aimed and returns it as the placing device holds it: the DM's holds only the scene it shows. */
async function place(page: Page): Promise<AreaTemplate> {
  const socket = page === dm ? dmSocket : patSocket;
  const before = new Set(Object.keys(socket.state?.templates ?? {}));
  await pressSlot(page, "place");
  const id = await waitFor("the placed area", () => Object.keys(socket.state?.templates ?? {}).find((k) => !before.has(k)) ?? null);
  return socket.state!.templates[id]!;
}

/** Places the area, reads it, and deletes it again, so a later tap on the map never picks it instead. */
async function placeOnce(page: Page): Promise<AreaTemplate> {
  const t = await place(page);
  await pressSlot(page, "delete");
  return t;
}

/** Back to idle with nothing picked: Done on a picked area, Cancel on a draft. */
async function idle(page: Page): Promise<void> {
  if ((await options(page).locator('[data-rvtt-slot="done"]').count()) > 0) await pressSlot(page, "done");
  if ((await options(page).locator('[data-rvtt-slot="cancel"]').count()) > 0) await pressSlot(page, "cancel");
  await options(page).locator('[data-rvtt-slot="spell"]').first().waitFor({ state: "attached" });
}

/** A spell from the search, wherever the field stands: in the row, or in the shape chip's popover. */
async function spell(page: Page, name: string): Promise<void> {
  // In the row the field is a combobox, for its "Spells" popover.
  const inRow = options(page).locator("[data-options-row]").getByRole("combobox", { name: "Spell" });
  if ((await inRow.count()) > 0 && (await inRow.isVisible())) {
    await inRow.fill(name);
    await inRow.press("Enter");
  } else {
    await options(page).getByRole("button", { name: /^Shape:/ }).click();
    const field = page.getByRole("dialog", { name: "Shape" }).getByRole("textbox", { name: "Spell" });
    await field.fill(name);
    await field.press("Enter");
  }
  await page.waitForTimeout(200);
}

/** Opens the chip's "Cast from" popover and picks a row. */
async function castFrom(page: Page, option: string): Promise<void> {
  await from(page).click();
  const dialog = page.getByRole("dialog", { name: "Cast from" });
  await dialog.getByRole("radiogroup", { name: "Cast from" }).getByRole("radio", { name: option, exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

function center(id: string): { x: number; y: number } {
  const r = footprintRect(SQUARES, (dmSocket.state!.tokens[id] ?? patSocket.state!.tokens[id]) as Token);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Whether a point lies on a token's footprint edge: where a cone cast from it starts. */
function onEdgeOf(id: string, p: { x: number; y: number }): boolean {
  const r = footprintRect(SQUARES, (dmSocket.state!.tokens[id] ?? patSocket.state!.tokens[id]) as Token);
  const inside = p.x >= r.x - 1e-6 && p.x <= r.x + r.w + 1e-6 && p.y >= r.y - 1e-6 && p.y <= r.y + r.h + 1e-6;
  return inside && [p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y].some((d) => Math.abs(d) < 1e-6);
}

async function setUp(page: Page, cdp: CDPSession, view: { width: number; height: number; scale: number }): Promise<void> {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

describe("raccoon-vtt an area from your character", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    pat = await patContext.newPage();
    patCdp = await patContext.newCDPSession(pat);
    kimContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    kim = await kimContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    consoles.kim.attach(kim);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    await kimSocket.attach(kimContext, kim);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("0. a DM's room, Pat playing Thorn on a phone, Kim on another, three goblins and a second scene", async () => {
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
    run.patId = await join(patContext, "Pat", "#30a46c");
    run.kimId = await join(kimContext, "Kim", "#3e63dd");
    await ops.send({ t: "room.update", settings: { playersDraw: "all" } });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.secondId, name: "The crypt", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send(tokenOp(run.thorn, run.sceneId, { kind: "pc", name: "Thorn", ...AT.thorn, disposition: "ally", actor: { ref: run.thornChar } }));
    for (const [i, id] of run.goblins.entries()) {
      await ops.send(tokenOp(id, run.sceneId, { kind: "monster", name: "Goblin", number: i + 1, ...AT.goblins[i]!, disposition: "hostile", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } }));
    }
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await kim.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state?.tokens[run.goblins[2]!]);
    await waitFor("Kim's snapshot", () => kimSocket.state);
    await pat.locator(".konvajs-content").first().waitFor();
  });

  test("1. Pat opens Area with nothing selected: From Thorn is pressed, and a drag from open map aims a cone from his edge", async () => {
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "on");
    assert.match(await line(pat), /^Casting from Thorn\. Tap the map or a creature to aim it\./);
    await shots.take(pat, "areas-from-thorn-idle");
    // From open map south of Thorn, dragged further south: the cone turns about Thorn and points down.
    await dragCells(pat, BOUNDS, { x: 3, y: 9 }, { x: 3, y: 11 });
    const t = await placeOnce(pat);
    assert.equal(t.casterId, run.thorn);
    assert.equal(t.yaw, 90);
    assert.ok(onEdgeOf(run.thorn, t.origin), `the cone starts on Thorn's edge: ${JSON.stringify(t.origin)}`);
    await idle(pat);
  });

  test("2. a choice holds across tools against an old selection, a fresh one counts, and off places a free cone", async () => {
    await pickTool(pat, "Select");
    await tapCellOf(pat, AT.thorn);
    await waitFor("Thorn selected", async () => (await pat.getByRole("dialog", { name: "Thorn actions" }).count()) > 0);
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "on");
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    assert.match(await line(pat), /^Tap a token to cast from it, or tap the map\./);
    await pickTool(pat, "Draw");
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "off");
    // Let go of Thorn, and select him again: a fresh selection.
    await pickTool(pat, "Select");
    await tapCellOf(pat, { x: 12, y: 1 });
    await waitFor("Thorn let go", async () => (await pat.getByRole("dialog", { name: "Thorn actions" }).count()) === 0);
    await tapCellOf(pat, AT.thorn);
    await waitFor("Thorn selected again", async () => (await pat.getByRole("dialog", { name: "Thorn actions" }).count()) > 0);
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "on");
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    await tapCellOf(pat, { x: 12, y: 9 });
    const t = await placeOnce(pat);
    assert.equal(t.casterId, undefined, "no caster");
    assert.deepEqual({ x: t.origin.x, y: t.origin.y }, { x: 12.5, y: 9.5 }, "a free cone where the tap was");
    await idle(pat);
    // Off, a tap on Thorn while placing casts from him, and the toggle turns on, for the next area too.
    await tapCellOf(pat, { x: 12, y: 9 });
    await fromIs(pat, "From Thorn", "off");
    await tapCellOf(pat, AT.thorn);
    await fromIs(pat, "From Thorn", "on");
    await pressSlot(pat, "cancel");
    await fromIs(pat, "From Thorn", "on");
  });

  test("3. a tap on a goblin aims while Thorn casts, Set caster casts from it, and Entangle centers on a goblin", async () => {
    // A cone aimed north from Thorn, then a tap on Goblin 1 east of him turns it there.
    await tapCellOf(pat, { x: 3, y: 1 });
    await tapCellOf(pat, AT.goblins[0]!);
    await fromIs(pat, "From Thorn", "on");
    await waitFor("Goblin 1 in the cone", async () => /In area \(1\): Goblin 1/.test(await line(pat)));
    await shots.take(pat, "areas-aimed-at-goblin");
    // Set caster on Goblin 1.
    await pressSlot(pat, "caster");
    await tapCellOf(pat, AT.goblins[0]!);
    await fromIs(pat, "From Goblin 1", "chip");
    const fromGoblin = await place(pat);
    await fromIs(pat, null, "none");
    assert.equal(fromGoblin.casterId, run.goblins[0]);
    assert.ok(onEdgeOf(run.goblins[0]!, fromGoblin.origin), "cast from the goblin's edge");
    await pressSlot(pat, "done");
    await fromIs(pat, "From Thorn", "on");

    // Entangle, a 20 ft square placed at a point, centers on the goblin tapped and records Thorn.
    await spell(pat, "entangle");
    assert.match(await line(pat), /Tap the middle of the square, or a creature to center it there\./);
    await tapCellOf(pat, AT.goblins[1]!);
    const entangle = await placeOnce(pat);
    assert.equal(entangle.casterId, run.thorn);
    const c = center(run.goblins[1]!);
    assert.deepEqual(cubeCenter(entangle, 5), { x: Math.round(c.x), y: Math.round(c.y) });
    await idle(pat);

    // Moved elsewhere, then a tap on Goblin 3 centers it there, and a drag from that tap moves it.
    await spell(pat, "entangle");
    await tapCellOf(pat, { x: 12, y: 9 });
    await tapCellOf(pat, AT.goblins[2]!);
    await dragCells(pat, BOUNDS, AT.goblins[2]!, { x: 12, y: 2 });
    const moved = await placeOnce(pat);
    assert.equal(moved.casterId, run.thorn);
    assert.deepEqual(cubeCenter(moved, 5), { x: 13, y: 3 }, "the square follows the drag from Goblin 3");
    await idle(pat);
  });

  test("4. Fireball reads its distance from Thorn against its range, and none with From off", async () => {
    await spell(pat, "fireball");
    await tapCellOf(pat, { x: 12, y: 9 });
    await waitFor("the range reading", async () => /ft from Thorn of 150 ft/.test(await line(pat)));
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    await waitFor("no range reading", async () => !/ft from Thorn/.test(await line(pat)));
    await from(pat).click();
    await fromIs(pat, "From Thorn", "on");
    await pressSlot(pat, "cancel");
    // The last shape is now Fireball's sphere: the idle line says a tap places it.
    await waitFor("the sphere's idle line", async () => /^Casting from Thorn\. Tap the map or a creature to place it\./.test(await line(pat)));
  });

  test("5. Spirit Guardians surrounds Thorn and moves with him once placed", async () => {
    await spell(pat, "spirit guardians");
    const aura = await place(pat);
    assert.equal(aura.attachedTo, run.thorn);
    assert.equal(aura.casterId, run.thorn);
    await pressSlot(pat, "delete");
    await idle(pat);
    // An emanation's tap only starts it around Thorn, and the idle line says so.
    await waitFor("the emanation's idle line", async () => /^Casting from Thorn\. Tap the map to start it around Thorn\./.test(await line(pat)));
  });

  test("7. off, a shape change, on: from Thorn again, and off, a spell, on: the same, Ice Knife's goblin included", async () => {
    // Spirit Guardians left the last shape an emanation, which a tap would not aim.
    await pickOption(pat, "Area", "Shape", "Cone");
    await tapCellOf(pat, { x: 3, y: 1 });
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    await pickOption(pat, "Area", "Shape", "Line");
    await from(pat).click();
    await fromIs(pat, "From Thorn", "on");
    const line1 = await placeOnce(pat);
    assert.equal(line1.shape, "line");
    assert.equal(line1.casterId, run.thorn);
    assert.equal(line1.yaw, 270, "aimed north, as the cone was");
    assert.ok(onEdgeOf(run.thorn, line1.origin));
    await idle(pat);
    await tapCellOf(pat, { x: 3, y: 1 });
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    await spell(pat, "burning hands");
    await fromIs(pat, "From Thorn", "off");
    await from(pat).click();
    await fromIs(pat, "From Thorn", "on");
    const hands = await placeOnce(pat);
    assert.equal(hands.spell, "Burning Hands");
    assert.equal(hands.casterId, run.thorn);
    assert.ok(onEdgeOf(run.thorn, hands.origin));
    await idle(pat);
    // Ice Knife on Goblin 1 with From off, then a cone: still off, never cast from the goblin it surrounded. On: from Thorn.
    await spell(pat, "ice knife");
    await tapCellOf(pat, AT.goblins[0]!);
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    await pickOption(pat, "Area", "Shape", "Cone");
    await fromIs(pat, "From Thorn", "off");
    assert.match(await line(pat), /Tap the caster, or a point on the map\./, "the cone waits for a tap");
    await from(pat).click();
    await fromIs(pat, "From Thorn", "on");
    const cone = await placeOnce(pat);
    assert.equal(cone.casterId, run.thorn);
    assert.ok(onEdgeOf(run.thorn, cone.origin));
    await idle(pat);
  });

  test("6 and 12. the DM adds Pip: the chip, with pictures, focus kept on it, Pip picked, and a reload", async () => {
    await from(pat).focus();
    assert.equal(await from(pat).getAttribute("aria-pressed"), "true");
    assert.equal(await from(pat).getAttribute("title"), "Cast areas from Thorn");
    await ops.send(tokenOp(run.pip, run.sceneId, { kind: "npc", name: "Pip", size: "tiny", x: 1, y: 5, disposition: "ally", companion: { of: run.thornChar, turn: "shared" }, actor: { inline: actor() } }));
    await fromIs(pat, "From Thorn", "chip");
    const focused = await from(pat).evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement);
    assert.ok(focused, "focus stays on the control as the toggle turns into the chip");
    assert.equal(await from(pat).getAttribute("aria-pressed"), null);
    await from(pat).click();
    const dialog = pat.getByRole("dialog", { name: "Cast from" });
    const group = dialog.getByRole("radiogroup", { name: "Cast from" });
    const names = await group.getByRole("radio").evaluateAll((els) => els.map((e) => (e as unknown as { checked: boolean }).checked));
    assert.deepEqual(names, [true, false, false], "Thorn chosen");
    for (const option of ["Thorn", "Pip companion", "No caster"]) {
      const row = dialog.locator("label").filter({ has: pat.getByRole("radio", { name: option, exact: true }) });
      assert.equal(await row.locator("span[aria-hidden] > *").count() > 0, true, `${option} has its picture`);
    }
    assert.equal(await from(pat).getAttribute("aria-expanded"), "true");
    await shots.take(pat, "areas-cast-from-popover");
    await group.getByRole("radio", { name: "Pip companion", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await fromIs(pat, "From Pip", "chip");
    await spell(pat, "burning hands");
    const hands = await place(pat);
    assert.equal(hands.casterId, run.pip);
    assert.ok(onEdgeOf(run.pip, hands.origin), "from Pip's edge");
    await pressSlot(pat, "delete");
    await pat.reload();
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "chip");
  });

  test("8. Copy of the goblin's area shows From Goblin 1 while placing, and the saved choice after", async () => {
    // The cone cast from Goblin 1 points east, over the cell past him.
    await tapAt(pat, { x: 8.6, y: 5.5 });
    await options(pat).locator('[data-rvtt-slot="copy"]').first().waitFor({ state: "attached" });
    await pressSlot(pat, "copy");
    await fromIs(pat, "From Goblin 1", "chip");
    await shots.take(pat, "areas-copy-from-goblin");
    await pressSlot(pat, "cancel");
    await fromIs(pat, "From Thorn", "chip");
  });

  test("13. while Pat changes the control with Shared off, Kim's socket gets no ephemeral event and no op", async () => {
    const before = kimSocket.received.length;
    await tapCellOf(pat, { x: 3, y: 1 });
    await castFrom(pat, "No caster");
    await castFrom(pat, "Pip companion");
    await castFrom(pat, "Thorn");
    await pressSlot(pat, "cancel");
    await pat.waitForTimeout(500);
    const frames = kimSocket.received.slice(before).map((f) => JSON.parse(f) as { t: string });
    assert.deepEqual(frames.filter((f) => f.t === "eph" || f.t === "ev"), [], "nothing about Pat's area reached Kim");
  });

  test("9. a second scene finds Thorn by his character, a deleted caster leaves no substitute, and a dead Thorn starts off", async () => {
    await ops.send({ t: "token.delete", tokenId: run.pip });
    const second = randomUUID();
    const goblin = randomUUID();
    await ops.send(tokenOp(second, run.secondId, { kind: "pc", name: "Thorn", ...AT.thorn, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tokenOp(goblin, run.secondId, { kind: "monster", name: "Ghoul", ...AT.goblins[0]!, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send({ t: "room.setPlayerScene", sceneId: run.secondId });
    await waitFor("Pat on the second scene", () => (patSocket.state?.tokens[second] ? true : null));
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "on");
    // A cone from Thorn there, then the DM deletes him: off, nothing in his place.
    await tapCellOf(pat, { x: 3, y: 1 });
    await ops.send({ t: "token.delete", tokenId: second });
    await fromIs(pat, "From Thorn", "disabled");
    assert.equal(await from(pat).getAttribute("aria-pressed"), "false");
    await waitFor("the cone waits for a tap", async () => /Tap the caster, or a point on the map\./.test(await line(pat)));
    await pressSlot(pat, "cancel");

    // Ice Knife on the ghoul with From off, then Thorn deleted: still around the ghoul.
    const third = randomUUID();
    await addThorn(third, run.secondId);
    await fromIs(pat, "From Thorn", "on");
    await spell(pat, "ice knife");
    await tapCellOf(pat, AT.goblins[0]!);
    await from(pat).click();
    await fromIs(pat, "From Thorn", "off");
    await ops.send({ t: "token.delete", tokenId: third });
    await fromIs(pat, "From Thorn", "disabled");
    const knife = await place(pat);
    assert.equal(knife.attachedTo, goblin, "still around the ghoul");
    assert.equal(knife.casterId, undefined);
    await pressSlot(pat, "delete");
    await idle(pat);

    // With Thorn gone: disabled, a Tab stop described by its reason, and the line says why.
    await fromIs(pat, "From Thorn", "disabled");
    const described = await from(pat).getAttribute("aria-describedby");
    assert.ok(described);
    assert.equal(await pat.locator(`[id="${described}"]`).textContent(), "None of your creatures is on this scene.");
    // aria-disabled, never disabled outright, which would drop it from the Tab order.
    assert.equal(await from(pat).getAttribute("disabled"), null);
    assert.equal(await from(pat).getAttribute("tabindex"), null);
    await from(pat).focus();
    assert.ok(await from(pat).evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), "a Tab stop that takes focus");
    await from(pat).press("Enter");
    await fromIs(pat, "From Thorn", "disabled");
    assert.match(await line(pat), /^None of your creatures is on this scene\. Tap a token to cast from it/);
    await shots.take(pat, "areas-from-disabled");

    // A dead Thorn, after a reload, is off by default.
    await ops.send({ t: "actor.life", target: { characterId: run.thornChar }, life: "dead" });
    await addThorn(randomUUID(), run.secondId);
    await pat.reload();
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await pickTool(pat, "Area");
    await fromIs(pat, "From Thorn", "off");
    await ops.send({ t: "actor.life", target: { characterId: run.thornChar }, life: "alive" });
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await waitFor("Pat back on the first scene", () => (patSocket.state?.tokens[run.thorn] ? true : null));
  });

  test("10. the DM: no control while idle, a goblin's toggle once a tap casts from it, and off and on", async () => {
    await pickTool(dm, "Area");
    await options(dm).locator('[data-rvtt-slot="shape"]').first().waitFor({ state: "attached" });
    await fromIs(dm, null, "none");
    await tapCellOf(dm, AT.goblins[0]!);
    await fromIs(dm, "From Goblin 1", "on");
    await tapCellOf(dm, AT.goblins[1]!);
    await fromIs(dm, "From Goblin 2", "on");
    await from(dm).click();
    await fromIs(dm, "From Goblin 2", "off");
    const reading = await line(dm);
    assert.match(reading, /In area/, "the cone stays where it stood");
    await from(dm).click();
    await fromIs(dm, "From Goblin 2", "on");
    await options(dm).getByRole("button", { name: "More options" }).click();
    const more = dm.getByRole("dialog", { name: "More Area options" });
    await more.getByRole("button", { name: "Caster: Goblin 2" }).waitFor();
    assert.equal(await more.getByRole("button", { name: /No caster|Clear the caster/ }).count(), 0, "No caster is gone from More area options");
    await dm.keyboard.press("Escape");
    const t = await place(dm);
    assert.equal(t.casterId, run.goblins[1]);
    assert.ok(onEdgeOf(run.goblins[1]!, t.origin), "back on the goblin's edge");
    await shots.take(dm, "areas-dm-goblin-toggle");
    await pressSlot(dm, "delete");
    await pickTool(dm, "Select");

    // "View as a player" is its own page, with Pat's control and its own choice.
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    await pickTool(dm, "Area", preview);
    const previewFrom = preview.getByRole("toolbar", { name: "Area options" }).locator('[data-options-row] > [data-rvtt-slot="from"] button').first();
    await previewFrom.waitFor();
    assert.equal(await previewFrom.getAttribute("aria-label"), "From Thorn");
    assert.equal(await previewFrom.getAttribute("aria-pressed"), "true");
    await previewFrom.click();
    assert.equal(await previewFrom.getAttribute("aria-pressed"), "false");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await pickTool(dm, "Area");
    await fromIs(dm, null, "none");
    await pickTool(dm, "Select");
  });

  test("11. at 320 x 568 at 130%, idle and placing, the square, the shape glyph and Place inline at Appendix A's widths, for a short and a ten-character name", async () => {
    for (const name of ["Thorn", "Kethryllia"]) {
      await ops.send({ t: "character.update", characterId: run.thornChar, patch: { name } });
      await ops.send({ t: "token.update", tokenId: run.thorn, patch: { name } });
      await setUp(pat, patCdp, { width: 320, height: 568, scale: 1.3 });
      await pickTool(pat, "Area");
      const widths = async () =>
        options(pat)
          .locator("[data-options-row] > [data-rvtt-slot]")
          .evaluateAll((els) => els.map((e) => [(e as unknown as { dataset: { rvttSlot: string } }).dataset.rvttSlot, (e as unknown as { getBoundingClientRect(): { width: number } }).getBoundingClientRect().width / 1.3] as const));
      await fromIs(pat, `From ${name}`, "on");
      const idleRow = await widths();
      assert.ok(idleRow[0]?.[0] === "from" && Math.abs(idleRow[0][1] - 44) <= 1 && idleRow[1]?.[0] === "shape" && Math.abs(idleRow[1][1] - 60) <= 1, `idle with ${name}: ${JSON.stringify(idleRow)}`);
      await shots.take(pat, `areas-320-130-idle-${name.toLowerCase()}`);
      await tapCellOf(pat, { x: 8, y: 3 });
      await options(pat).locator('[data-rvtt-slot="place"]').first().waitFor({ state: "attached" });
      const placingRow = await widths();
      const want = [["from", 44], ["shape", 60], ["place", 62.9]] as const;
      assert.ok(
        placingRow.length === want.length && want.every(([id, w], i) => placingRow[i]![0] === id && Math.abs(placingRow[i]![1] - w) <= 1),
        `placing with ${name}: ${JSON.stringify(placingRow)}`,
      );
      await shots.take(pat, `areas-320-130-placing-${name.toLowerCase()}`);
      await pressSlot(pat, "cancel");
      if (name !== "Thorn") continue;
      // The square says on, off and disabled by its picture too: off fades it under the slash, disabled greys it.
      const square = options(pat).locator('[data-options-row] > [data-rvtt-slot="from"] [data-rvtt-from]');
      assert.equal(await square.getAttribute("data-rvtt-from"), "on");
      assert.equal(await square.locator("svg").count(), 0, "no slash while on");
      await from(pat).click();
      await fromIs(pat, "From Thorn", "off");
      assert.equal(await square.getAttribute("data-rvtt-from"), "off");
      assert.equal(await square.locator("svg").count(), 1, "the slash over the portrait");
      assert.equal(await square.locator(":scope > span").first().evaluate((e) => (globalThis as unknown as { getComputedStyle(e: unknown): { opacity: string } }).getComputedStyle(e).opacity), "0.5");
      await shots.take(pat, "areas-320-130-square-off");
      await from(pat).click();
      await fromIs(pat, "From Thorn", "on");
      await ops.send({ t: "token.update", tokenId: run.thorn, patch: { sceneId: run.secondId } });
      await fromIs(pat, "From Thorn", "disabled");
      assert.equal(await square.getAttribute("data-rvtt-from"), "disabled");
      const look = await square.locator(":scope > span").first().evaluate((e) => (globalThis as unknown as { getComputedStyle(e: unknown): { filter: string } }).getComputedStyle(e).filter);
      assert.match(look, /grayscale/);
      await shots.take(pat, "areas-320-130-square-disabled");
      await ops.send({ t: "token.update", tokenId: run.thorn, patch: { sceneId: run.sceneId } });
      await fromIs(pat, "From Thorn", "on");
    }
    // A long name ends in an ellipsis at the cap, so it never sets the row's width, and the whole name stays its name.
    await ops.send({ t: "character.update", characterId: run.thornChar, patch: { name: "Kethryllia the Bold" } });
    await ops.send({ t: "token.update", tokenId: run.thorn, patch: { name: "Kethryllia the Bold" } });
    await setUp(pat, patCdp, { width: 390, height: 844, scale: 1 });
    await pickTool(pat, "Area");
    await fromIs(pat, "From Kethryllia the Bold", "on");
    assert.equal(await from(pat).getAttribute("title"), "Cast areas from Kethryllia the Bold");
    const capped = (await from(pat).boundingBox())!.width;
    assert.ok(Math.abs(capped - 132.2) <= 1, `the capped toggle is ${capped} px, Appendix A's 133`);
    await shots.take(pat, "areas-390-capped-name");
    await ops.send({ t: "character.update", characterId: run.thornChar, patch: { name: "Thorn" } });
    await ops.send({ t: "token.update", tokenId: run.thorn, patch: { name: "Thorn" } });
  });

  test("14. nothing went wrong in the browsers", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
