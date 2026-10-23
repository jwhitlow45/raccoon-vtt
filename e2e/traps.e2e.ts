import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { RoomState, Token, Trap } from "../shared/model.ts";
import { groundAt } from "../shared/rules/heights.ts";
import { ConsoleWatch, dragCells, OpSocket, pagePoint, pickOption, pickTool, reopenRoom, Shots, SocketWatch, startServer, tapCell, touchSwipe, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * Traps end to end (docs/design-v1-traps.md 11), on the real server
 * serving the production build: the DM on a desktop, Pat on a phone at
 * 390 x 844. The DM builds a Hidden Pit from its preset with the Trap
 * tool, gives it a Dexterity save and leaves it unfound when it goes off.
 * Pat drags Thorn across it: Thorn stops in it and falls as the pit opens,
 * with the DM's line in Pat's log and a toast, and Undo move is refused.
 * No frame Pat's page receives names the trap until the DM marks it found.
 * The DM's card opens the group save on Thorn, whose request reads "Trap",
 * and Apply settles the springing. Then the trap shows found on Pat's map,
 * and the pane is shot at 375 x 667 at 130%.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-five, one file
 * after another as the others. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 25;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-traps-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const SMALL = { width: 375, height: 667 };
const BOUNDS = { w: 16, h: 12 };
const HP = 30;
/** Pat's total for Thorn's save, under the pit's DC 13. */
const THORN_TOTAL = 5;

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E traps ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  trapId: "",
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: HP, max: HP, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
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

function state(socket: SocketWatch): RoomState | null {
  return socket.state as RoomState | null;
}

function token(socket: SocketWatch, id: string): Token | undefined {
  return state(socket)?.tokens[id];
}

function trap(socket: SocketWatch): Trap | undefined {
  return state(socket)?.traps?.[run.trapId];
}

function thornHp(): number | null {
  return state(dmSocket)?.characters[run.thornChar]?.actor.hp.cur ?? null;
}

/** The trap's pane, a dialog. */
function pane(page: Page): Locator {
  return page.getByRole("dialog", { name: "Edit trap" });
}

/** A group of the pane, unfolded. */
async function unfold(page: Page, label: string): Promise<void> {
  const fold = pane(page).getByRole("button", { name: label, exact: true });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
}

/** The texts on the map's canvas. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages[0]!.find("Text").filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/** Where focus is: the element's role and name, and whether it is inside the side panel or which sheet holds it. */
function focusAt(page: Page): Promise<{ role: string | null; name: string; side: boolean; sheet: string | null }> {
  return page.evaluate(() => {
    type Node = { getAttribute(n: string): string | null; textContent: string | null; closest(s: string): Node | null };
    const a = (globalThis as unknown as { document: { activeElement: Node | null } }).document.activeElement;
    return {
      role: a?.getAttribute("role") ?? null,
      name: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim(),
      side: a?.closest("aside") != null,
      sheet: a?.closest("dialog[data-rvtt-sheet]")?.getAttribute("aria-label") ?? null,
    };
  });
}

type Rect = { left: number; top: number; right: number; bottom: number };

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

/** Whether no alert card stands over the element, at its middle and its edges. */
async function clearOfAlerts(target: Locator): Promise<boolean> {
  const b = await target.boundingBox();
  if (!b) return false;
  const points = [
    [b.x + b.width / 2, b.y + b.height / 2],
    [b.x + 3, b.y + b.height / 2],
    [b.x + b.width - 3, b.y + b.height / 2],
  ] as const;
  return target.evaluate(
    (el, at) =>
      at.every(([x, y]) => {
        const top = el.ownerDocument.elementFromPoint(x, y);
        return top !== null && (el.contains(top) || top.closest("[data-alert]") === null);
      }),
    points,
  );
}

/** Whether any frame Pat's page received names the trap. */
function patHeardOfTrap(): boolean {
  return patSocket.received.some((frame) => frame.includes(run.trapId));
}

describe("raccoon-vtt traps", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    patCdp = await patContext.newCDPSession(pat);
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
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

  test("tr-0. the DM's room on a desktop, and Pat with Thorn on a phone, west of the squares the pit will take", async () => {
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
    run.sceneId = state(dmSocket)!.meta.playerSceneId!;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.patId = await join(patContext, "Pat", "#30a46c");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send({ t: "token.create", token: { id: run.thorn, sceneId: run.sceneId, kind: "pc", name: "Thorn", size: "medium", visibility: "all", x: 2, y: 4, disposition: "ally", actor: { ref: run.thornChar } } });
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => token(patSocket, run.thorn));
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("tr-1. the DM picks the Trap tool, starts from Hidden Pit, drags its 2 x 2 squares, and in its pane gives it a Dexterity save and leaves it unfound when it goes off", async () => {
    await pickTool(dm, "Trap");
    await pickOption(dm, "Trap", "Start from", "Hidden Pit");
    await dm.getByRole("toolbar", { name: "Trap options" }).getByRole("button", { name: "Party level: Levels 1–4" }).waitFor();
    await dragCells(dm, BOUNDS, { x: 6, y: 4 }, { x: 7, y: 5 });
    const made = await waitFor("the Hidden Pit on the DM's copy", () => Object.values(state(dmSocket)?.traps ?? {}).find((t) => t.name === "Hidden Pit") ?? null);
    run.trapId = made.id;
    assert.deepEqual(made.zone, { cells: [{ x: 6, y: 4, w: 2, h: 2 }] });
    assert.equal(made.state, "armed");
    assert.equal(made.found, false);
    assert.deepEqual(made.rig?.damage, [{ formula: "1d6", type: "bludgeoning" }]);
    assert.deepEqual(made.rig?.pit, { floor: -10 }, "a 10-foot pit under ground at 0");
    assert.equal(made.rig?.stops, true);
    await pane(dm).waitFor();
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    await pane(dm).getByText("From Hidden Pit, levels 1–4").waitFor();

    await unfold(dm, "Afterwards");
    await pane(dm).getByRole("switch", { name: "Marks itself found when players see it go off" }).click();
    await waitFor("found when it goes off turned off", () => trap(dmSocket)?.rig?.foundOnSpring === false || null);
    await unfold(dm, "Save and damage");
    await pane(dm).getByLabel("Save", { exact: true }).selectOption("dex");
    const saved = await waitFor("the Dexterity save", () => (trap(dmSocket)?.rig?.save ? trap(dmSocket) : null));
    assert.deepEqual(saved.rig?.save, { ability: "dex", dc: 13, onPass: "half" });
    await shots.take(dm, "traps-pane-desktop");
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
    assert.equal(patHeardOfTrap(), false, "a frame to Pat named the unfound trap");
  });

  test("tr-2. Pat drags Thorn across the pit: Thorn stops on its first square and falls as it opens, Pat reads the DM's line in the log and as a toast, the DM gets a toast, and Pat still never hears of the trap", async () => {
    const from = await pagePoint(pat, BOUNDS, { x: 2.5, y: 4.5 });
    const to = await pagePoint(pat, BOUNDS, { x: 10.5, y: 4.5 });
    await touchSwipe(patCdp, from, to, { steps: 16, everyMs: 20 });
    const stopped = await waitFor("Thorn stopped in the pit", () => {
      const t = token(patSocket, run.thorn);
      return t && t.x === 6 && t.y === 4 && t.elevation === -10 ? t : null;
    });
    assert.equal(stopped.x, 6, "on the square where it stepped on");
    const ground = state(patSocket)!.buildChunks;
    for (const [x, y] of [
      [6, 4],
      [7, 4],
      [6, 5],
      [7, 5],
    ] as const)
      assert.equal(groundAt(ground, run.sceneId, x, y), -10, `the pit open at ${x},${y} on Pat's copy`);
    const line = await waitFor("the players' line", () => state(patSocket)?.trapSeen?.find((e) => e.data?.type === "trapSeen") ?? null);
    assert.deepEqual(line.data, { type: "trapSeen", by: [run.thorn], message: "The floor gives way!", sound: "crash" });
    await pat.locator('[role="status"]').filter({ hasText: "Thorn: The floor gives way!" }).first().waitFor();
    // The DM's toast, with Save and damage, since the pit's springing waits with a save and damage.
    const dmToast = dm.locator('[role="status"]').filter({ hasText: "Hidden Pit went off: Thorn." }).first();
    await dmToast.getByRole("button", { name: "Save and damage", exact: true }).waitFor();
    await shots.take(pat, "traps-pat-stopped");
    assert.equal(trap(patSocket), undefined, "Pat holds no unfound trap");
    assert.equal(patHeardOfTrap(), false, "a frame to Pat named the unfound trap");
  });

  test("tr-3. Undo move is refused: Thorn's bar no longer offers it, and the server refuses Pat's undo of the stopped move", async () => {
    await tapCell(pat, BOUNDS, { x: 6, y: 4 });
    const bar = pat.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    assert.equal(await bar.getByRole("button", { name: "Undo move", exact: true }).count(), 0, "the bar still offers Undo move");
    await shots.take(pat, "traps-pat-bar");
    const cookie = (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    const patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    try {
      await assert.rejects(patOps.send({ t: "undo" }), /could not undo moving Thorn: something happened on the way\. Ask the DM/);
    } finally {
      patOps.close();
    }
    assert.equal(token(dmSocket, run.thorn)?.x, 6, "Thorn stays in the pit");
    await pat.keyboard.press("Escape");
  });

  test("tr-4. the DM's card says Hidden Pit went off, and its Save and damage asks Pat for Thorn's save as \"Trap\", then Apply hurts Thorn and settles it", async () => {
    const card = dm.getByRole("group", { name: "Hidden Pit went off" });
    await card.waitFor();
    await card.getByText("Thorn set it off.").waitFor();
    await shots.take(dm, "traps-dm-card");
    await card.getByRole("button", { name: "Save and damage", exact: true }).click();
    await dm.getByText("From Hidden Pit: Dexterity save, DC 13, 1d6 Bludgeoning, half on a pass.").waitFor();
    const creatures = dm.getByRole("group", { name: "Creatures" });
    await creatures.getByText("Thorn", { exact: true }).first().waitFor();
    await dm.getByRole("button", { name: "Ask 1 player", exact: true }).click();
    const request = await waitFor("Pat's request", () => Object.values(state(patSocket)?.rolls ?? {}).find((r) => r.targets.some((t) => t.characterId === run.thornChar || t.tokenId === run.thorn)) ?? null);
    assert.equal(request.note, "Trap", "the request names the unfound trap as Trap");
    const ask = pat.getByRole("dialog", { name: "The DM asks for a roll" }).or(pat.locator('[aria-label="The DM asks for a roll"]')).first();
    await ask.getByText(/^The DM asks for a Dexterity saving throw.*: Trap\.$/).waitFor();
    await shots.take(pat, "traps-pat-request");
    const total = ask.getByLabel("Total Thorn rolled");
    await total.fill(String(THORN_TOTAL));
    await total.press("Enter");
    await waitFor("Pat's answer on the DM's copy", () => state(dmSocket)?.rolls[request.id]?.targets.some((t) => t.total === THORN_TOTAL) || null);

    const outcome = dm.getByRole("group", { name: "Outcome" });
    if ((await outcome.count()) === 0) await dm.getByRole("button", { name: "Edit", exact: true }).click();
    const damage = dm.getByLabel("Damage", { exact: true });
    assert.equal(await damage.inputValue(), "1d6 Bludgeoning", "the trap's damage fills the page");
    const lines = state(dmSocket)?.log.length ?? 0;
    await damage.press("Enter");
    const rolled = await waitFor("the damage roll", () => state(dmSocket)?.log.slice(lines).find((e) => e.data?.type === "dice" && e.data.rolls.some((r) => r.formula === "1d6")) ?? null);
    const amount = rolled.data?.type === "dice" ? rolled.data.rolls.find((r) => r.formula === "1d6")!.total : 0;
    const apply = dm.getByRole("button", { name: /^Apply: / });
    await apply.waitFor();
    await apply.click();
    await waitFor(`Thorn at ${HP - amount}`, () => (thornHp() === HP - amount ? true : null));
    await waitFor("the springing settled", () => (trap(dmSocket)?.rig?.due === undefined ? true : null));
    await card.waitFor({ state: "detached" });
    assert.equal(trap(dmSocket)?.found, false, "still unfound");
    assert.equal(patHeardOfTrap(), false, "a frame to Pat named the unfound trap");
  });

  test("tr-5. the DM marks the pit found in its pane, and Pat's map shows it by name, never its rig", async () => {
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 7, y: 5 });
    await pane(dm).waitFor();
    await pane(dm).getByRole("switch", { name: "Found" }).click();
    await waitFor("found on the DM's copy", () => trap(dmSocket)?.found === true || null);
    const seen = await waitFor("the found pit on Pat's copy", () => trap(patSocket) ?? null);
    assert.equal(seen.name, "Hidden Pit");
    assert.deepEqual(seen.zone, { cells: [{ x: 6, y: 4, w: 2, h: 2 }] });
    assert.equal(seen.rig, undefined, "no rig reaches a player");
    await waitFor("the pit's name on Pat's map", async () => ((await boardTexts(pat)).includes("Hidden Pit") ? true : null));
    await shots.take(pat, "traps-pat-found");
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
  });

  test("tr-6. the pane on a phone at 375 x 667 at 130%: its header and Done in reach", async () => {
    await dm.setViewportSize(SMALL);
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 4 });
    await pane(dm).waitFor();
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    assert.ok(await wholeInReach(pane(dm).getByRole("button", { name: "Close", exact: true })), "the pane's Close is out of reach");
    await shots.take(dm, "traps-pane-375x667-130");
    const done = pane(dm).getByRole("button", { name: "Done", exact: true });
    await done.scrollIntoViewIfNeeded();
    assert.ok(await wholeInReach(done), "the pane's Done is out of reach");
    await shots.take(dm, "traps-pane-375x667-130-foot");
    await done.click();
    await pane(dm).waitFor({ state: "detached" });
  });

  test("fu20b-3. on a short laptop screen the trap cards show over the screen, and a card's Save and damage closes them, so the group save it opens in the side panel takes a click (LP13-TR-3)", async () => {
    await dm.setViewportSize({ width: 1280, height: 320 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Select");
    for (let i = 0; i < 2; i++) await ops.send({ t: "trap.spring", trapId: run.trapId, tokenIds: [run.thorn] });
    await waitFor("two springings waiting", () => ((trap(dmSocket)?.rig?.due?.length ?? 0) >= 2 ? true : null));
    // The first card does not fit between the top bar and the toolbar, so the column's row stands for the cards, and its tap shows them over the screen.
    const row = dm.getByRole("button", { name: /went off.*Tap to answer\.$/ });
    await row.click();
    const alerts = dm.getByRole("dialog", { name: "Alerts" });
    await alerts.waitFor();
    await shots.take(dm, "traps-fu20b-alerts-over-the-screen");
    await alerts.getByRole("group", { name: "Hidden Pit went off" }).first().getByRole("button", { name: "Save and damage", exact: true }).click();
    await alerts.waitFor({ state: "detached" });
    const page = dm.getByText("From Hidden Pit: Dexterity save, DC 13, 1d6 Bludgeoning, half on a pass.");
    await page.waitFor();
    // The panel the card opened takes focus, at its chosen tab, as Details hands focus to the Token tab.
    const at = await waitFor("focus in the side panel", async () => {
      const f = await focusAt(dm);
      return f.side ? f : null;
    }).catch(async () => assert.fail(`focus is not in the side panel: ${JSON.stringify(await focusAt(dm))}`));
    assert.equal(at.role, "tab", `focus went to ${JSON.stringify(at)}`);
    // Nothing is left inert behind the alerts, and the page's Ask takes a click once scrolled to on this short screen.
    assert.equal(await dm.locator("[inert]").count(), 0, "the page behind the alerts is still inert");
    const ask = dm.getByRole("button", { name: "Ask 1 player", exact: true });
    await ask.scrollIntoViewIfNeeded();
    assert.ok(await wholeInReach(ask), "the group save in the side panel takes no click");
    await shots.take(dm, "traps-fu20b-save-in-reach");
  });

  test("fu20b-r1-2. on a 320 x 568 phone at 130%, where an opened card leaves the column too short for it, the trap cards show over the screen, and Save and damage opens the Dice sheet with focus on its heading, and closing it with a trap still waiting brings no Alerts back (FU20B-ASTRA-1)", async () => {
    await dm.setViewportSize({ width: 320, height: 568 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Ruler");
    await waitFor("springings waiting", () => ((trap(dmSocket)?.rig?.due?.length ?? 0) >= 1 ? true : null));
    // A phone's card starts folded to its first line. Open, it leaves the column above the Ruler's options too short for it, so the column's row stands for the cards, and its tap shows them over the screen.
    const card = dm.getByRole("group", { name: "Hidden Pit went off" }).first();
    const toggle = card.getByRole("button", { name: "Hidden Pit went off", exact: true });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await dm.getByRole("button", { name: /went off.*Tap to answer\.$/ }).click();
    const alerts = dm.getByRole("dialog", { name: "Alerts" });
    await alerts.waitFor();
    const inAlerts = alerts.getByRole("group", { name: "Hidden Pit went off" }).first();
    const toggleThere = inAlerts.getByRole("button", { name: "Hidden Pit went off", exact: true });
    if ((await toggleThere.getAttribute("aria-expanded")) !== "true") await toggleThere.click();
    await shots.take(dm, "traps-fu20b-r1-phone-alerts");
    await inAlerts.getByRole("button", { name: "Save and damage", exact: true }).click();
    await alerts.waitFor({ state: "detached" });
    const dice = dm.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
    await dice.getByText("From Hidden Pit: Dexterity save, DC 13, 1d6 Bludgeoning, half on a pass.").waitFor();
    const at = await waitFor("focus in the Dice sheet", async () => {
      const f = await focusAt(dm);
      return f.sheet === "Dice" ? f : null;
    }).catch(async () => assert.fail(`focus is not in the Dice sheet: ${JSON.stringify(await focusAt(dm))}`));
    // The sheet's heading, which names the group save the card opened.
    assert.equal(at.name, "Hidden Pit's save", `focus went to ${JSON.stringify(at)}`);
    await shots.take(dm, "traps-fu20b-r1-phone-dice");
    await dice.getByRole("button", { name: "Close Dice", exact: true }).click();
    await dice.waitFor({ state: "detached" });
    await dm.waitForTimeout(500);
    assert.ok((trap(dmSocket)?.rig?.due?.length ?? 0) >= 1, "no springing waits any more");
    assert.equal(await alerts.count(), 0, "the alerts came back over the screen when the Dice sheet closed");
    await shots.take(dm, "traps-fu20b-r1-phone-after-dice");
    await pickTool(dm, "Select");
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
  });

  test("fu20b-r2-2. on a 320 x 568 phone at 130%, with a trap card opened past the column's room, the summary row on the trap pane's edge closes the pane and shows the cards over the screen (FU20B-ASTRA-3)", async () => {
    await dm.setViewportSize({ width: 320, height: 568 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Trap");
    await waitFor("springings waiting", () => ((trap(dmSocket)?.rig?.due?.length ?? 0) >= 1 ? true : null));
    // Opened, the card leaves the column too short for it, so the column's own row stands for the cards.
    const card = dm.getByRole("group", { name: "Hidden Pit went off" }).first();
    const toggle = card.getByRole("button", { name: "Hidden Pit went off", exact: true });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await dm.getByRole("button", { name: /went off.*Tap to answer\.$/ }).waitFor();
    await tapCell(dm, BOUNDS, { x: 6, y: 5 });
    await pane(dm).waitFor();
    const row = dm.locator("[data-rvtt-pane-dock]").getByRole("button", { name: /went off.*Close the pane to answer\.$/ });
    await row.waitFor();
    await shots.take(dm, "traps-fu20b-r2-pane-row-cramped");
    await row.click();
    await pane(dm).waitFor({ state: "detached" });
    // The cards it stood for show, over the screen where the column has no room for the opened card, not just the column's row again.
    const alerts = dm.getByRole("dialog", { name: "Alerts" });
    await alerts.waitFor();
    await alerts.getByRole("group", { name: "Hidden Pit went off" }).first().waitFor();
    await shots.take(dm, "traps-fu20b-r2-pane-row-cards-shown");
    await alerts.getByRole("button", { name: "Close", exact: true }).click();
    await alerts.waitFor({ state: "detached" });
    await pickTool(dm, "Select");
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
  });

  test("fu20b-r2-7. on a 320 x 568 phone at 130%, with a trap card opened past the column's room, the alerts summary on the Panels sheet closes it and shows the cards over the screen (FU20B-OP-11)", async () => {
    await dm.setViewportSize({ width: 320, height: 568 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Ruler");
    await waitFor("springings waiting", () => ((trap(dmSocket)?.rig?.due?.length ?? 0) >= 1 ? true : null));
    const card = dm.getByRole("group", { name: "Hidden Pit went off" }).first();
    const toggle = card.getByRole("button", { name: "Hidden Pit went off", exact: true });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await dm.getByRole("button", { name: /went off.*Tap to answer\.$/ }).waitFor();
    await dm.getByRole("button", { name: "Panels", exact: true }).click();
    const panels = dm.getByRole("region", { name: "Panels" });
    await panels.waitFor();
    const summary = dm.getByRole("button", { name: /went off.*Close the sheet to answer\.$/ });
    await summary.waitFor();
    await shots.take(dm, "traps-fu20b-r2-sheet-summary-cramped");
    await summary.click();
    await panels.waitFor({ state: "detached" });
    const alerts = dm.getByRole("dialog", { name: "Alerts" });
    await alerts.waitFor();
    await alerts.getByRole("group", { name: "Hidden Pit went off" }).first().waitFor();
    await shots.take(dm, "traps-fu20b-r2-sheet-summary-cards-shown");
    await alerts.getByRole("button", { name: "Close", exact: true }).click();
    await alerts.waitFor({ state: "detached" });
    await pickTool(dm, "Select");
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
  });

  test("fu20b-2. on a DM phone held upright the waiting trap cards fold under the trap's pane, whose header and Close are whole in reach, and come back as it closes (LP13-TR-6)", async () => {
    await dm.setViewportSize(PHONE);
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    const cards = dm.getByRole("group", { name: "Hidden Pit went off" });
    await cards.first().waitFor();
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 5 });
    await pane(dm).waitFor();
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    assert.equal(await cards.first().isVisible(), false, "a card draws over the pane");
    assert.ok(await wholeInReach(pane(dm).getByRole("button", { name: "Close", exact: true })), "the pane's Close is out of reach");
    await shots.take(dm, "traps-fu20b-pane-over-folded-cards");
    await pane(dm).getByRole("button", { name: "Close", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await cards.first().waitFor();
    await pickTool(dm, "Select");
    for (const due of trap(dmSocket)?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: run.trapId, due: due.id });
    await waitFor("the springings settled", () => (trap(dmSocket)?.rig?.due === undefined ? true : null));
  });

  test("lp15-tr-1. the DM drags a goblin across a pit from the row it stops on: the goblin's picture is drawn where the pit stops it, in the pit with its badges (review LP15-FU-4)", async () => {
    await dm.setViewportSize(DESKTOP);
    await reopenRoom(dm);
    await dm.locator(".konvajs-content").first().waitFor();
    const goblin = randomUUID();
    const pitId = randomUUID().replace(/-/g, "").slice(0, 16);
    await ops.send({ t: "token.create", token: { id: goblin, sceneId: run.sceneId, kind: "monster", name: "Goblin", size: "medium", visibility: "all", x: 1, y: 9, disposition: "hostile", actor: { inline: actor() } } });
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger", actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: pitId, sceneId: run.sceneId, name: "Low Pit", zone: { cells: [{ x: 4, y: 9, w: 2, h: 2 }] }, rig } });
    await waitFor("the goblin on the DM's map", () => token(dmSocket, goblin));
    // The DM's own copy holds the trap, so the move the drop predicts already stops in the pit, on the row the goblin started on.
    await dragCells(dm, BOUNDS, { x: 1, y: 9 }, { x: 8, y: 10 });
    const stopped = await waitFor("the goblin stopped in the pit", () => (token(dmSocket, goblin)?.elevation === -10 ? token(dmSocket, goblin) : null));
    // On the row it started from, so only one of its coordinates changed, the case the picture missed (review LP15-OP-4).
    assert.equal(stopped.y, 9, "the pit stops the goblin on the row it started from");
    await dm.waitForTimeout(500);
    const drawn = await dm.evaluate((id) => {
      type Node = { x(): number; y(): number };
      const konva = (globalThis as unknown as { Konva: { stages: { findOne(selector: string): Node | undefined }[] } }).Konva;
      const node = konva.stages[0]!.findOne(`#${id}`);
      return node ? { x: node.x(), y: node.y() } : null;
    }, goblin);
    await shots.take(dm, "traps-lp15-dm-pit-picture");
    assert.deepEqual(drawn, { x: stopped.x, y: stopped.y }, `the goblin stands at ${stopped.x}, ${stopped.y}, its picture is drawn elsewhere`);
    for (const due of state(dmSocket)?.traps?.[pitId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: pitId, due: due.id });
  });

  test("lp2-1a. a trap goes off while its pane is open as a card: at 1280 x 800, 844 x 390 and 820 x 1180, at 85% and 130%, the pane's header, Close and folds stay in reach and no card covers it, beside the lane or under the column's summary row, whose tap closes the pane and puts focus on the card (docs/design-v1-look-pass-2.md 2.8)", async () => {
    // In the board's top right corner, where the alerts column hangs, so its pane would meet the cards.
    const cornerId = randomUUID().replace(/-/g, "").slice(0, 16);
    const rig = { on: ["enter"], who: "any", floor: false, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: cornerId, sceneId: run.sceneId, name: "Corner Darts", zone: { cells: [{ x: 13, y: 1, w: 2, h: 1 }] }, rig } });
    await waitFor("the corner trap on the DM's copy", () => state(dmSocket)?.traps?.[cornerId] ?? null);
    const seen = new Set<string>();
    for (const size of [
      { width: 1280, height: 800 },
      { width: 844, height: 390 },
      { width: 820, height: 1180 },
    ]) {
      for (const scale of [0.85, 1.3]) {
        const label = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
        await dm.setViewportSize(size);
        await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await reopenRoom(dm);
        await waitFor("the DM's snapshot again", () => state(dmSocket)?.traps?.[cornerId] ?? null);
        await dm.locator(".konvajs-content").first().waitFor();
        await pickTool(dm, "Trap");
        await tapCell(dm, BOUNDS, { x: 13, y: 1 });
        await pane(dm).getByText("Corner Darts", { exact: true }).first().waitFor();
        // A roll request open on the DM's desk as well, which the summary's words leave out and its +1 counts (LP16-PT-3).
        const requestId = randomUUID();
        await ops.send({ t: "roll.ask", request: { id: requestId, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thornChar }] } });
        await ops.send({ t: "trap.spring", trapId: cornerId, tokenIds: [run.thorn] });
        await waitFor(`the springing waits, ${label}`, () => ((state(dmSocket)?.traps?.[cornerId]?.rig?.due?.length ?? 0) > 0 ? true : null));
        const row = dm.getByRole("button", { name: /went off.*Close the pane to answer\.$/ });
        const card = dm.getByRole("group", { name: "Corner Darts went off" });
        // Or the column's own row, where the screen is too short for its first card whatever the pane does.
        const roomRow = dm.getByRole("button", { name: /went off.*Tap to answer\.$/ });
        await waitFor(`the card or a row, ${label}`, async () => ((await row.count()) > 0 || (await roomRow.count()) > 0 || (await card.isVisible()) ? true : null));
        await dm.waitForTimeout(400);
        const mode = (await row.count()) > 0 ? "summary" : "beside";
        seen.add(mode);
        await shots.take(dm, `traps-lp2-1a-${size.width}x${size.height}-${Math.round(scale * 100)}-${mode}`);
        const paneBox = await rectOf(pane(dm));
        for (const [name, target] of [
          ["the title", pane(dm).getByText("Corner Darts", { exact: true }).first()],
          ["Close", pane(dm).getByRole("button", { name: "Close", exact: true })],
        ] as const) {
          assert.ok(await wholeInReach(target), `${label}: the pane's ${name} is out of reach`);
        }
        // The folds, the pane scrolling inside to its lower ones. At 844 x 390 at 130% the tool's hint line may cover the foot of a pane at its least height, as before, so this asks only that no alert does.
        for (const fold of ["Name", "Hits"]) {
          const target = pane(dm).getByRole("button", { name: fold, exact: true });
          await target.scrollIntoViewIfNeeded();
          assert.ok(await clearOfAlerts(target), `${label}: an alert covers the pane's ${fold} fold`);
        }
        await pane(dm).evaluate((el) => el.scrollTo(0, 0));
        const cards = await dm.evaluate(() => {
          const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number } }> } };
          return Array.from(g.document.querySelectorAll('[data-alert]:not([data-alert="rolls"]), [data-alert="rolls"] > *'))
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0)
            .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
        });
        for (const c of cards) assert.ok(!intersects(c, paneBox), `${label}: a card covers the pane: ${JSON.stringify({ c, paneBox })}`);
        if (mode === "summary") {
          const r = await rectOf(row);
          assert.ok(r.right <= paneBox.left || paneBox.top >= r.bottom, `${label}: the pane runs under the summary row: ${JSON.stringify({ r, paneBox })}`);
          assert.equal(await card.isVisible(), false, `${label}: the row stands for the cards, which still show`);
          assert.match((await row.textContent()) ?? "", /^Corner Darts went off\s*\+1/, `${label}: the row does not count the roll request its words leave out`);
          await row.click();
          await pane(dm).waitFor({ state: "detached" });
          await card.first().waitFor();
          const at = await waitFor(`focus on the card, ${label}`, async () => {
            const f = await focusAt(dm);
            return f.name.includes("Corner Darts went off") ? f : null;
          }).catch(async () => assert.fail(`${label}: focus is not on the card: ${JSON.stringify(await focusAt(dm))}`));
          assert.ok(at, label);
        } else {
          await pane(dm).getByRole("button", { name: "Close", exact: true }).click();
          await pane(dm).waitFor({ state: "detached" });
        }
        await pickTool(dm, "Select");
        await ops.send({ t: "roll.close", rollIds: [requestId] });
        for (const due of state(dmSocket)?.traps?.[cornerId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: cornerId, due: due.id });
        await waitFor(`the springing settled, ${label}`, () => (state(dmSocket)?.traps?.[cornerId]?.rig?.due === undefined ? true : null));
      }
    }
    assert.deepEqual([...seen].sort(), ["beside", "summary"], "the sizes never put the pane beside the lane and under its row both");
    await dm.setViewportSize(DESKTOP);
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
  });

  test("lp2-1b. the pane's choices fit its card: Afterwards and Hits unfold with no sideways scroll at 1280 x 800 and 844 x 390, Afterwards is one switch, Who's three words share a row, and arrow keys through Hits change what it hits and start no pick, while Add squares and Place the area still start theirs (docs/design-v1-look-pass-2.md 2.7)", async () => {
    for (const size of [{ width: 844, height: 390 }, DESKTOP]) {
      const label = `${size.width} x ${size.height}`;
      await dm.setViewportSize(size);
      await reopenRoom(dm);
      await waitFor("the DM's snapshot again", () => trap(dmSocket));
      await dm.locator(".konvajs-content").first().waitFor();
      await pickTool(dm, "Trap");
      await tapCell(dm, BOUNDS, { x: 6, y: 4 });
      await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
      await unfold(dm, "Goes off when");
      await unfold(dm, "Afterwards");
      await unfold(dm, "Hits");
      await dm.waitForTimeout(200);
      const widths = await pane(dm).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      assert.ok(widths.scroll <= widths.client, `${label}: the pane scrolls sideways: ${JSON.stringify(widths)}`);
      const who = await Promise.all(["Party", "Others", "Any"].map(async (name) => (await rectOf(pane(dm).getByRole("radio", { name, exact: true }).locator(".."))).top));
      assert.ok(Math.max(...who) - Math.min(...who) < 1, `${label}: Who's options do not share a row: ${JSON.stringify(who)}`);
      await shots.take(dm, `traps-lp2-1b-${size.width}x${size.height}-choices`);
      await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
      await pane(dm).waitFor({ state: "detached" });
    }

    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 4 });
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    await unfold(dm, "Afterwards");
    const again = pane(dm).getByRole("switch", { name: "Arms again at the start of the next turn" });
    assert.equal(await again.getAttribute("aria-checked"), trap(dmSocket)?.rig?.resets === "nextTurn" ? "true" : "false");
    await again.click();
    await waitFor("it arms again", () => (trap(dmSocket)?.rig?.resets === "nextTurn" ? true : null));
    await again.click();
    await waitFor("it goes off once", () => (trap(dmSocket)?.rig?.resets === "never" ? true : null));

    // From the creature that set it off, the arrow keys walk the choices: each writes what needs no map, and the pane never steps aside for a pick.
    await unfold(dm, "Hits");
    const hits = pane(dm).getByRole("radiogroup", { name: "Hits" });
    await hits.getByRole("radio", { name: "The creature that set it off" }).click();
    await waitFor("it hits the creature that set it off", () => (trap(dmSocket)?.rig?.hits === "trigger" ? true : null));
    await hits.getByRole("radio", { name: "The creature that set it off" }).focus();
    await dm.keyboard.press("ArrowDown");
    await waitFor("it hits everyone on the trap", () => (trap(dmSocket)?.rig?.hits === "zone" ? true : null));
    await dm.keyboard.press("ArrowDown");
    const cells = await waitFor("it hits its own squares", () => {
      const h = trap(dmSocket)?.rig?.hits;
      return typeof h === "object" && "cells" in h ? h.cells : null;
    });
    assert.deepEqual(cells, [{ x: 6, y: 4, w: 2, h: 2 }]);
    assert.equal(await pane(dm).isVisible(), true, "choosing drawn squares started the map's pick");
    await dm.keyboard.press("ArrowDown");
    await pane(dm).getByRole("button", { name: "Place the area", exact: true }).waitFor();
    assert.equal(await hits.getByRole("radio", { name: "Everyone in an area" }).isChecked(), true, "the area's choice did not hold");
    assert.ok(typeof trap(dmSocket)?.rig?.hits === "object", "choosing an area wrote something before one was placed");
    assert.equal(await pane(dm).isVisible(), true, "choosing an area started the area tool");
    assert.equal(await dm.getByRole("toolbar", { name: "Trap options" }).count(), 1, "choosing an area left the Trap tool");
    await shots.take(dm, "traps-lp2-1b-hits-area-held");
    await dm.keyboard.press("ArrowDown");
    await waitFor("back to the creature that set it off", () => (trap(dmSocket)?.rig?.hits === "trigger" ? true : null));

    // The buttons that follow the choice still start the map's pick and the area tool.
    await hits.getByRole("radio", { name: "Everyone in these squares" }).click();
    // The last one is Hits': the trap's own squares have an Add squares of their own above.
    await pane(dm).getByRole("button", { name: "Add squares", exact: true }).last().click();
    await waitFor("the pane steps aside for the pick", async () => ((await pane(dm).isVisible()) ? null : true));
    const options = dm.getByRole("toolbar", { name: "Trap options" });
    await options.getByText("Drag across the squares Hidden Pit hits, or tap one square.").waitFor();
    await options.getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor();
    await hits.getByRole("radio", { name: "Everyone in an area" }).click();
    await pane(dm).getByRole("button", { name: "Place the area", exact: true }).click();
    await dm.getByRole("toolbar", { name: "Area options" }).waitFor();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { rig: { hits: "trigger" } } });
  });

  test("lp2-1b-2. the last way a trap goes off keeps its tick and focus on a click, Space and Enter, says why, and lets go once another is ticked, and a cleared name goes back to the saved one and says why (docs/design-v1-look-pass-2.md 2.7, D13)", async () => {
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 4 });
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    assert.deepEqual(trap(dmSocket)?.rig?.on, ["enter"]);
    await unfold(dm, "Goes off when");
    const onto = pane(dm).getByRole("checkbox", { name: "A creature steps onto it" });
    assert.equal(await onto.getAttribute("aria-disabled"), "true");
    assert.equal(await onto.evaluate((el) => (el as unknown as { disabled: boolean }).disabled), false, "the last tick is natively disabled, out of the focus order");
    await pane(dm).getByText("A trap on squares goes off at least one way.").waitFor();
    const focusedIsOnto = () => onto.evaluate((el) => el.ownerDocument.activeElement === el);
    // Playwright waits for an aria-disabled control to be enabled before it clicks, so the click is the mouse's own.
    const box = await onto.boundingBox();
    assert.ok(box);
    await dm.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await onto.isChecked(), true, "a click took the last tick away");
    assert.equal(await focusedIsOnto(), true, "a click moved focus off the last tick");
    for (const key of ["Space", "Enter"]) {
      await dm.keyboard.press(key);
      assert.equal(await onto.isChecked(), true, `${key} took the last tick away`);
      assert.equal(await focusedIsOnto(), true, `${key} moved focus off the last tick`);
    }
    await dm.waitForTimeout(200);
    assert.deepEqual(trap(dmSocket)?.rig?.on, ["enter"], "the last way it goes off was sent away");
    await shots.take(dm, "traps-lp2-1b-last-trigger");
    // With a second way ticked, the first lets go.
    await pane(dm).getByRole("checkbox", { name: "A creature steps off it" }).click();
    await waitFor("two ways", () => (trap(dmSocket)?.rig?.on?.length === 2 ? true : null));
    assert.equal(await onto.getAttribute("aria-disabled"), null);
    await onto.click();
    await waitFor("only off it", () => (JSON.stringify(trap(dmSocket)?.rig?.on) === JSON.stringify(["leave"]) ? true : null));
    await onto.click();
    await pane(dm).getByRole("checkbox", { name: "A creature steps off it" }).click();
    await waitFor("back to onto it", () => (JSON.stringify(trap(dmSocket)?.rig?.on) === JSON.stringify(["enter"]) ? true : null));

    await unfold(dm, "Name");
    const name = pane(dm).getByRole("textbox", { name: "Name", exact: true });
    await name.fill("");
    await name.press("Tab");
    await pane(dm).getByText("A trap needs a name.").waitFor();
    assert.equal(await name.inputValue(), "Hidden Pit", "the cleared name stayed empty");
    assert.equal(trap(dmSocket)?.name, "Hidden Pit");
    await shots.take(dm, "traps-lp2-1b-name-needed");

    // A remove has the danger look, as every remove in the app does.
    await unfold(dm, "Save and damage");
    const remove = pane(dm).getByRole("button", { name: "Remove this damage", exact: true });
    assert.equal(await remove.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).color), "rgb(248, 113, 113)", "the remove is not in the danger look");

    // Arming with no uses left asks for them with secondary buttons: Done stays the pane's one primary.
    // Its one use spent by going off, as ops cannot set none.
    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { state: "armed", rig: { usesLeft: 1 } } });
    await ops.send({ t: "trap.spring", trapId: run.trapId, tokenIds: [run.thorn] });
    await waitFor("no uses left", () => (trap(dmSocket)?.rig?.usesLeft === 0 && trap(dmSocket)?.state !== "armed" ? true : null));
    for (const due of trap(dmSocket)?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: run.trapId, due: due.id });
    await pane(dm).getByRole("switch", { name: "Armed" }).click();
    const prompt = pane(dm).getByRole("group", { name: "Give it uses" });
    await prompt.waitFor();
    const background = (l: Locator) => l.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).backgroundColor);
    const primary = await background(pane(dm).getByRole("button", { name: "Done", exact: true }));
    assert.notEqual(await background(prompt.getByRole("button", { name: "Arm", exact: true })), primary, "Arm is a second primary beside Done");
    await shots.take(dm, "traps-lp2-1b-uses-prompt");
    await prompt.getByRole("button", { name: "No limit", exact: true }).click();
    await waitFor("armed with no limit", () => (trap(dmSocket)?.state === "armed" && trap(dmSocket)?.rig?.usesLeft === undefined ? true : null));
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });

  test("lp2-1b-3. Save and damage reads as the group save it fills: a DC row, On a pass with Half and None, and dice that do not read say why under their row (docs/design-v1-look-pass-2.md D12)", async () => {
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 4 });
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    await unfold(dm, "Save and damage");
    await pane(dm).getByText("DC", { exact: true }).waitFor();
    const onPass = pane(dm).getByRole("radiogroup", { name: "On a pass" });
    await onPass.getByRole("radio", { name: "None", exact: true }).click();
    await waitFor("none on a pass", () => (trap(dmSocket)?.rig?.save?.onPass === "none" ? true : null));
    await onPass.getByRole("radio", { name: "Half", exact: true }).click();
    await waitFor("half on a pass", () => (trap(dmSocket)?.rig?.save?.onPass === "half" ? true : null));
    const dice = pane(dm).getByRole("textbox", { name: "Damage dice" });
    await dice.fill("2dx");
    await dice.press("Tab");
    const why = pane(dm).getByRole("alert").filter({ hasText: "Not a dice formula, such as 2d10 or 1d6+2." });
    await why.waitFor();
    assert.equal(await dice.getAttribute("aria-invalid"), "true");
    assert.deepEqual(trap(dmSocket)?.rig?.damage, [{ formula: "1d6", type: "bludgeoning" }], "dice that do not read were sent");
    await shots.take(dm, "traps-lp2-1b-save-and-damage");
    await dice.fill("1d6");
    await dice.press("Tab");
    await why.waitFor({ state: "detached" });
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });
});
