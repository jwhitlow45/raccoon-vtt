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
});
