import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import type { RoomState, Token, Trap } from "../shared/model.ts";
import { groundAt } from "../shared/rules/heights.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
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
  /** The trap in the board's top right corner, under the alerts column (lp2-1a). */
  cornerId: "",
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

/**
 * The pane's rows, read in the page (docs/design-v1-polish.md R1 to R3):
 * each remove's middle against the first line of the fields it removes,
 * each FieldRow's control against its label, each unit against its field,
 * each tick with help against its label's first line, and the foot's Set
 * it off, alone on its line after the two asks, against the line's width.
 */
type PaneRows = {
  removes: { name: string; offset: number }[];
  fieldRows: { label: string; offset: number; wrapped: boolean }[];
  units: { unit: string; offset: number; sameLine: boolean }[];
  ticks: { label: string; offset: number }[];
  setOff: { left: number; short: number; height: number } | null;
};

/** The page's elements, as far as paneRows reads them: the e2e files build without the DOM's types. */
type El = {
  getBoundingClientRect(): { top: number; bottom: number; left: number; width: number };
  parentElement: El | null;
  children: ArrayLike<El>;
  nextElementSibling: El | null;
  previousElementSibling: El | null;
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  ownerDocument: {
    defaultView: { getComputedStyle(el: El): { flexWrap: string } } | null;
    getElementById(id: string): El | null;
    createRange(): { selectNodeContents(node: unknown): void; getClientRects(): ArrayLike<{ top: number; bottom: number }> };
    createTreeWalker(root: El, show: number): { nextNode(): { textContent: string | null } | null };
  };
};

function paneRows(target: Locator): Promise<PaneRows> {
  return target.evaluate((node) => {
    const root = node as unknown as El;
    const doc = root.ownerDocument;
    const view = doc.defaultView!;
    const box = (el: El) => el.getBoundingClientRect();
    const mid = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2;
    const tenth = (n: number) => Math.round(n * 10) / 10;
    // The middle of an element's first line of text, from its first fragment's line box.
    const firstLine = (el: El): number | null => {
      const walker = doc.createTreeWalker(el, 4);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim()) continue;
        const range = doc.createRange();
        range.selectNodeContents(text);
        const r = range.getClientRects()[0];
        if (r) return mid(r);
      }
      return null;
    };
    const all = (selector: string) => Array.from(root.querySelectorAll(selector));
    const removes = all('button[aria-label^="Remove this"]').map((button) => {
      // The fields beside the remove: its siblings, or the parts inside a sibling that wraps them.
      const parts = Array.from(button.parentElement!.children)
        .filter((el) => el !== button)
        .flatMap((el) => (view.getComputedStyle(el).flexWrap === "wrap" ? Array.from(el.children) : [el]))
        .filter((el) => box(el).width > 0);
      const top = Math.min(...parts.map((el) => box(el).top));
      const line = parts.filter((el) => box(el).top < top + 2);
      const lineMid = (Math.min(...line.map((el) => box(el).top)) + Math.max(...line.map((el) => box(el).bottom))) / 2;
      return { name: button.getAttribute("aria-label") ?? "", offset: tenth(mid(box(button)) - lineMid) };
    });
    const fieldRows = all("label")
      .filter((label) => label.parentElement !== null && view.getComputedStyle(label.parentElement).flexWrap === "wrap" && label.nextElementSibling !== null && label.querySelector("input") === null)
      .map((label) => {
        const control = label.nextElementSibling!;
        return { label: label.textContent ?? "", offset: tenth(mid(box(control)) - mid(box(label))), wrapped: box(control).top >= box(label).bottom - 1 };
      });
    const units = all("span")
      .filter((span) => ["rounds", "ft deep"].includes(span.textContent?.trim() ?? "") && span.previousElementSibling?.tagName === "INPUT")
      .map((span) => {
        const field = span.previousElementSibling!;
        return { unit: span.textContent ?? "", offset: tenth(mid(box(span)) - mid(box(field))), sameLine: box(span).top < box(field).bottom && box(field).top < box(span).bottom };
      });
    const ticks = all('input[type="checkbox"][aria-describedby]').map((input) => {
      const label = doc.getElementById(input.getAttribute("aria-labelledby") ?? "")!;
      return { label: label.textContent ?? "", offset: tenth(mid(box(input)) - (firstLine(label) ?? Number.NaN)) };
    });
    const buttons = all("button");
    const set = buttons.find((b) => b.textContent?.trim() === "Set it off");
    const search = buttons.find((b) => b.textContent?.trim() === "Ask to search");
    const line = set?.parentElement ?? null;
    const setOff = set && search && line ? { left: tenth(box(set).left - box(search).left), short: tenth(box(line).width - box(set).width), height: tenth(box(search).bottom - box(search).top - (box(set).bottom - box(set).top)) } : null;
    return { removes, fieldRows, units, ticks, setOff };
  });
}

/** How far a frame's Close stands under the frame's own top. */
function closeUnderTop(frame: Locator): Promise<number> {
  return frame.evaluate((node) => {
    const el = node as unknown as El;
    const close = Array.from(el.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Close")!;
    return Math.round((close.getBoundingClientRect().top - el.getBoundingClientRect().top) * 10) / 10;
  });
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
    // X is the Trap tool's default key (D-261025-2), and its tooltip names it.
    const trapButton = dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: "Trap", exact: true });
    await trapButton.waitFor();
    await dm.keyboard.press("x");
    await waitFor("X to pick the Trap tool", async () => ((await trapButton.getAttribute("data-active")) === "true" ? true : null));
    const tip = await trapButton.evaluate((el) => {
      const doc = (globalThis as unknown as { document: { getElementById(id: string): { getAttribute(name: string): string | null; textContent: string | null } | null } }).document;
      for (const id of (el.getAttribute("aria-describedby") ?? "").split(" ")) {
        const t = doc.getElementById(id);
        if (t?.getAttribute("role") === "tooltip") return t.textContent;
      }
      return null;
    });
    assert.equal(tip, "Trap (X)", "the tooltip names the key");
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
    await pat.locator("[data-toast]").filter({ hasText: "Thorn: The floor gives way!" }).first().waitFor();
    // The DM's toast, with Save and damage, since the pit's springing waits with a save and damage.
    const dmToast = dm.locator("[data-toast]").filter({ hasText: "Hidden Pit went off: Thorn." }).first();
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
    run.cornerId = cornerId;
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

  test("lp2-1a-2. while the trap pane's code loads, and after it failed to, its frame keeps out of the alerts as the pane does: at 820 x 1180 at 130% the column's row stands for the cards, no card meets the frame, its retry is in reach, and the row's tap closes it (LP2L1-ASTRA-02)", async () => {
    const cornerId = run.cornerId;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    // The pane's chunk, held and then refused, from the room's own preload on.
    await dm.route("**/assets/TrapPane-*.js", async (route) => {
      await held;
      await route.abort();
    });
    try {
      await dm.setViewportSize({ width: 820, height: 1180 });
      await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await reopenRoom(dm);
      await waitFor("the DM's snapshot again", () => state(dmSocket)?.traps?.[cornerId] ?? null);
      await dm.locator(".konvajs-content").first().waitFor();
      await pickTool(dm, "Trap");
      await tapCell(dm, BOUNDS, { x: 13, y: 1 });
      const loading = dm.getByRole("status").filter({ hasText: "Loading the trap editor…" });
      await loading.waitFor();
      await ops.send({ t: "trap.spring", trapId: cornerId, tokenIds: [run.thorn] });
      const row = dm.getByRole("button", { name: /went off.*Close the pane to answer\.$/ });
      const card = dm.getByRole("group", { name: "Corner Darts went off" });
      await row.waitFor();
      await dm.waitForTimeout(300);
      assert.equal(await card.isVisible(), false, "the loading frame left the cards over it");
      await shots.take(dm, "traps-lp2-1a-2-loading-frame");

      release();
      // Whichever way the app reads the failure (didn't load, offline, updated), its notice has a button to recover.
      const failed = dm.getByRole("alert").filter({ has: dm.getByRole("button") }).filter({ hasText: /trap editor|RaccoonVTT was updated/ });
      await failed.waitFor();
      const frame = failed.locator("..");
      const retry = failed.getByRole("button").first();
      assert.ok(await wholeInReach(retry), "the frame's retry is out of reach");
      assert.equal(await row.count(), 1, "the failure frame let the cards back over it");
      const frameBox = await rectOf(frame);
      const cards = await dm.evaluate(() => {
        const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number } }> } };
        return Array.from(g.document.querySelectorAll('[data-alert]:not([data-alert="rolls"]), [data-alert="rolls"] > *'))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0)
          .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      });
      for (const c of cards) assert.ok(!intersects(c, frameBox), `a card covers the failure frame: ${JSON.stringify({ c, frameBox })}`);
      await shots.take(dm, "traps-lp2-1a-2-failed-frame");

      // The row's tap closes the frame, as the host's own close, and the card it stood for shows.
      await row.click();
      await failed.waitFor({ state: "detached" });
      await card.first().waitFor();
    } finally {
      release();
      await dm.unroute("**/assets/TrapPane-*.js");
    }
    await pickTool(dm, "Select");
    for (const due of state(dmSocket)?.traps?.[cornerId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: cornerId, due: due.id });
    await waitFor("the springing settled", () => (state(dmSocket)?.traps?.[cornerId]?.rig?.due === undefined ? true : null));
    await dm.setViewportSize(DESKTOP);
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(dm);
  });

  test("lp2-1b. the pane's choices fit its card: Afterwards and Hits unfold with no sideways scroll at 1280 x 800 and 844 x 390, Afterwards is one switch, Who's three words share a row, and arrow keys through Hits change what it hits and start no pick, while Add squares and Place the area still start theirs (docs/design-v1-look-pass-2.md 2.7)", async () => {
    // A 320 px phone at 130%, where the pane is a sheet about 214 px inside: each of Hits' names, chosen and so with its check, fits without a sideways scroll (LP2L1-ASTRA-01).
    await dm.setViewportSize({ width: 320, height: 568 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => trap(dmSocket));
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 5 });
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    await unfold(dm, "Hits");
    for (const name of ["The creature that set it off", "Everyone on the trap", "Everyone in these squares", "Everyone in an area"]) {
      await pane(dm).getByRole("radiogroup", { name: "Hits" }).getByRole("radio", { name }).click();
      await dm.waitForTimeout(150);
      const widths = await pane(dm).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      assert.ok(widths.scroll <= widths.client, `320 x 568 at 130%, ${name} chosen: the pane scrolls sideways: ${JSON.stringify(widths)}`);
      // Every row inside the pane's body, short of its side padding, which a scroll width alone does not show.
      const rows = await pane(dm).evaluate((el) => {
        const body = el.getBoundingClientRect().right - parseFloat(el.ownerDocument.defaultView!.getComputedStyle(el).paddingRight) - parseFloat(el.ownerDocument.defaultView!.getComputedStyle(el).borderRightWidth);
        return Array.from(el.querySelectorAll('[role="radiogroup"][aria-label="Hits"] label')).map((l) => ({ right: (l as { getBoundingClientRect(): { right: number } }).getBoundingClientRect().right, body }));
      });
      for (const r of rows) assert.ok(r.right <= r.body + 0.5, `320 x 568 at 130%, ${name} chosen: a row runs past the pane's body: ${JSON.stringify(r)}`);
    }
    await shots.take(dm, "traps-lp2-1b-320x568-130-hits");
    await pane(dm).getByRole("radiogroup", { name: "Hits" }).getByRole("radio", { name: "The creature that set it off" }).click();
    await waitFor("back to the creature that set it off", () => (trap(dmSocket)?.rig?.hits === "trigger" ? true : null));
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));

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
    // Named apart from the Add squares that grows the trap itself, which keeps its own name (F5).
    await unfold(dm, "Goes off when");
    assert.equal(await pane(dm).getByRole("button", { name: "Add squares", exact: true }).count(), 1);
    await pane(dm).getByRole("button", { name: "Add squares it hits", exact: true }).click();
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
    // The note comes once typing rests, never on the blur (LP17-TR-2), and stays through it.
    await pane(dm).getByText("A trap needs a name.").waitFor();
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
    const why = pane(dm).getByRole("alert").filter({ hasText: "Not a dice formula, such as 2d10 or 1d6+2." });
    await why.waitFor();
    await dice.press("Tab");
    await why.waitFor();
    assert.equal(await dice.getAttribute("aria-invalid"), "true");
    assert.deepEqual(trap(dmSocket)?.rig?.damage, [{ formula: "1d6", type: "bludgeoning" }], "dice that do not read were sent");
    await shots.take(dm, "traps-lp2-1b-save-and-damage");
    await dice.fill("1d6");
    await dice.press("Tab");
    await why.waitFor({ state: "detached" });

    // With two parts of the same dice, removing the first while it shows its error leaves the second without one (F4).
    await pane(dm).getByRole("button", { name: "Add damage", exact: true }).click();
    await waitFor("two damage parts", () => (trap(dmSocket)?.rig?.damage?.length === 2 ? true : null));
    const first = pane(dm).getByRole("textbox", { name: "Damage dice" }).first();
    await first.fill("2dx");
    await why.waitFor();
    await first.press("Tab");
    await pane(dm).getByRole("button", { name: "Remove this damage", exact: true }).first().click();
    await waitFor("one damage part", () => (trap(dmSocket)?.rig?.damage?.length === 1 ? true : null));
    await dm.waitForTimeout(200);
    assert.equal(await why.count(), 0, "the removed part's error moved to the next part");
    assert.equal(await pane(dm).getByRole("textbox", { name: "Damage dice" }).inputValue(), "1d6");
    assert.deepEqual(trap(dmSocket)?.rig?.damage, [{ formula: "1d6", type: "bludgeoning" }]);
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });

  test("fu22b-tr. dice that do not read, left by a press on Add damage below them, say nothing on the blur, so the press lands: before typing rests they go back to the last good dice in silence, and after, their error stays put (LP17-TR-2)", async () => {
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 4 });
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    await unfold(dm, "Save and damage");
    const dice = pane(dm).getByRole("textbox", { name: "Damage dice" });
    const why = pane(dm).getByRole("alert").filter({ hasText: "Not a dice formula, such as 2d10 or 1d6+2." });
    const add = pane(dm).getByRole("button", { name: "Add damage", exact: true });
    await add.scrollIntoViewIfNeeded();
    // A held press, as a finger's: the blur comes on the press down, and the click only if the button is still under it when it lifts.
    const press = async () => {
      const box = await add.boundingBox();
      assert.ok(box);
      await dm.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await dm.mouse.down();
      await dm.waitForTimeout(150);
      await dm.mouse.up();
    };

    // Left before typing rests on any machine: the page's rest is held long for this press.
    await dm.evaluate(() => ((globalThis as unknown as { rvttNoteRestMs?: number }).rvttNoteRestMs = 600_000));
    try {
      await dice.first().fill("2dx");
      // Past the app's own rest, so the press below cannot beat it by luck.
      await dm.waitForTimeout(800);
      assert.equal(await why.count(), 0, "the note came while the rest was held");
      await press();
    } finally {
      await dm.evaluate(() => delete (globalThis as unknown as { rvttNoteRestMs?: number }).rvttNoteRestMs);
    }
    await waitFor("the press on Add damage landed", () => (trap(dmSocket)?.rig?.damage?.length === 2 ? true : null));
    assert.equal(await dice.first().inputValue(), "1d6", "dice left before typing rested kept what was typed");
    assert.equal(await why.count(), 0, "the blur showed the dice's error");
    assert.equal(await dice.first().getAttribute("aria-invalid"), null);

    await dice.first().fill("2dx");
    await why.waitFor();
    await shots.take(dm, "traps-fu22b-tr-dice-rested");
    await press();
    await waitFor("the press on Add damage landed with the error showing", () => (trap(dmSocket)?.rig?.damage?.length === 3 ? true : null));
    await why.waitFor();
    assert.equal(await dice.first().inputValue(), "2dx");
    assert.deepEqual(trap(dmSocket)?.rig?.damage?.[0], { formula: "1d6", type: "bludgeoning" }, "dice that do not read were sent");

    const remove = pane(dm).getByRole("button", { name: "Remove this damage", exact: true });
    await remove.nth(2).click();
    await remove.nth(1).click();
    await waitFor("one damage part", () => (trap(dmSocket)?.rig?.damage?.length === 1 ? true : null));
    await dice.first().fill("1d6");
    await why.waitFor({ state: "detached" });
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });

  test("pl1-a. a trap with every part filled lays out its rows level, as a card at 1440 x 900 and as a sheet at 320 x 568 at 130%: each remove beside its fields' first line, DC, On a pass and Uses left beside their labels, rounds beside its field, Set it off filling its line with every button's words on one line, and the last tick on its label's first line (docs/design-v1-polish.md R1 to R3)", async () => {
    // A door for the trap to lock, as an effect with a choice.
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges: [{ key: "12,9,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    const needleId = randomUUID().replace(/-/g, "").slice(0, 16);
    await ops.send({
      t: "trap.create",
      trap: {
        id: needleId,
        sceneId: run.sceneId,
        name: "Poisoned Needle Gauntlet",
        zone: { cells: [{ x: 9, y: 8, w: 3, h: 1 }] },
        rig: {
          on: ["enter", "leave"],
          who: "party",
          floor: true,
          resets: "nextTurn",
          usesLeft: 3,
          stops: false,
          foundOnSpring: true,
          hits: "zone",
          save: { ability: "con", dc: 15, onPass: "none" },
          damage: [
            { formula: "2d10", type: "poison" },
            { formula: "1d6+2", type: "piercing" },
          ],
          conditions: ["poisoned", "blinded"],
          lasts: { mode: "rounds", rounds: 3 },
          sound: "hiss",
          actions: [{ door: { edge: "12,9,w" }, state: "locked" }, { show: { tokenId: run.thorn } }],
          find: [{ ability: "int", skill: "investigation", dc: 15, what: "the pressure plate" }],
          notice: false,
          disarm: { text: "Wedging an iron spike under the plate", check: { ability: "dex", skill: "sleight-of-hand", dc: 15 } },
        },
      },
    });
    await waitFor("the needle trap on the DM's copy", () => state(dmSocket)?.traps?.[needleId] ?? null);

    for (const at of [
      { size: { width: 1440, height: 900 }, scale: 1, kind: "card" },
      { size: { width: 320, height: 568 }, scale: 1.3, kind: "sheet" },
    ]) {
      const label = `${at.size.width} x ${at.size.height} at ${Math.round(at.scale * 100)}%, as a ${at.kind}`;
      await dm.setViewportSize(at.size);
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), at.scale);
      await reopenRoom(dm);
      await waitFor("the DM's snapshot again", () => state(dmSocket)?.traps?.[needleId] ?? null);
      await dm.locator(".konvajs-content").first().waitFor();
      await pickTool(dm, "Trap");
      await tapCell(dm, BOUNDS, { x: 10, y: 8 });
      await pane(dm).getByText("Poisoned Needle Gauntlet", { exact: true }).first().waitFor();
      for (const group of ["Afterwards", "Save and damage", "Players read", "It also", "Finding and disarming"]) await unfold(dm, group);
      await dm.waitForTimeout(200);
      const rows = await paneRows(pane(dm));
      await shots.take(dm, `traps-pl1-a-${at.size.width}x${at.size.height}-${Math.round(at.scale * 100)}`);
      assert.equal(rows.removes.length, 6, `${label}: not every remove was read: ${JSON.stringify(rows.removes)}`);
      for (const r of rows.removes) assert.ok(Math.abs(r.offset) <= 1, `${label}: ${r.name} stands ${r.offset} px off its fields' first line`);
      assert.deepEqual(rows.fieldRows.map((r) => r.label).sort(), ["DC", "On a pass", "Uses left"], `${label}: the field rows read: ${JSON.stringify(rows.fieldRows)}`);
      for (const r of rows.fieldRows) assert.ok(!r.wrapped && Math.abs(r.offset) <= 1, `${label}: ${r.label}'s field is ${r.wrapped ? "under" : `${r.offset} px off`} its label`);
      assert.equal(rows.units.length, 1, `${label}: rounds was not read`);
      for (const u of rows.units) assert.ok(u.sameLine && Math.abs(u.offset) <= 1, `${label}: ${u.unit} stands ${u.sameLine ? `${u.offset} px off` : "apart from"} its field`);
      assert.ok(rows.setOff, `${label}: the foot's buttons were not read`);
      assert.ok(Math.abs(rows.setOff.left) <= 1 && Math.abs(rows.setOff.short) <= 1, `${label}: Set it off, alone on its line, does not fill it: ${JSON.stringify(rows.setOff)}`);
      assert.ok(Math.abs(rows.setOff.height) <= 1, `${label}: Ask to search breaks its words where Set it off does not: ${JSON.stringify(rows.setOff)}`);
      await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
      await pane(dm).waitFor({ state: "detached" });

      // The pit's one way to go off keeps its tick, with the help that says why under it.
      await tapCell(dm, BOUNDS, { x: 6, y: 4 });
      await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
      await unfold(dm, "Goes off when");
      await pane(dm).getByText("A trap on squares goes off at least one way.").waitFor();
      const { ticks } = await paneRows(pane(dm));
      assert.equal(ticks.length, 1, `${label}: the held tick was not read`);
      for (const t of ticks) assert.ok(Math.abs(t.offset) <= 1, `${label}: the tick by "${t.label}" stands ${t.offset} px off its label's first line`);
      await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
      await pane(dm).waitFor({ state: "detached" });
      await pickTool(dm, "Select");
    }
    await ops.send({ t: "trap.delete", trapId: needleId });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges: [{ key: "12,9,w", feature: null }] });
    await dm.setViewportSize(DESKTOP);
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(dm);
  });

  test("dpfix-1. a new trap's pane on a 320 x 568 phone at 130%, every group folded: each header within 1 px, and a summary that fits beside its name keeps the name's line (HX7-4 on squares, docs/design-v1-design-pass.md 4.1)", async () => {
    const bareId = randomUUID().replace(/-/g, "").slice(0, 16);
    const rig = { on: ["enter" as const], who: "party" as const, floor: true, resets: "never" as const, stops: false, foundOnSpring: true, hits: "zone" as const, actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: bareId, sceneId: run.sceneId, name: "Bare Trap", zone: { cells: [{ x: 10, y: 8, w: 1, h: 1 }] }, rig } });
    await waitFor("the bare trap on the DM's copy", () => state(dmSocket)?.traps?.[bareId] ?? null);
    await dm.setViewportSize({ width: 320, height: 568 });
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await waitFor("the DM's snapshot again", () => state(dmSocket)?.traps?.[bareId] ?? null);
    await dm.locator(".konvajs-content").first().waitFor();
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 10, y: 8 });
    const editor = pane(dm);
    await editor.getByText("Bare Trap", { exact: true }).first().waitFor();
    for (let open = editor.locator('[data-group-fold][aria-expanded="true"]'); (await open.count()) > 0; ) await open.first().click();
    await dm.waitForTimeout(200);
    const off = alignmentLines(await measureAlignment(editor.locator("[data-panel-group] > div:first-child")), "the trap's pane at 320 x 568 at 130%");
    // A summary wraps under its name only where the name and the summary, up to its 4em floor, cannot share the row.
    const heads = await editor.evaluate((root) => {
      type E = { getAttribute(n: string): string | null; getBoundingClientRect(): { top: number; bottom: number; width: number }; querySelectorAll(s: string): ArrayLike<E>; textContent: string | null; parentElement: E | null };
      const doc = (globalThis as unknown as { document: { getElementById(id: string): E | null; createRange(): { selectNodeContents(n: E): void; getBoundingClientRect(): { width: number } } } }).document;
      const words = (el: E) => {
        const range = doc.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width;
      };
      return Array.from((root as unknown as E).querySelectorAll("[data-group-fold]")).map((fold) => {
        const name = doc.getElementById(fold.getAttribute("aria-labelledby") ?? "")!;
        const summary = doc.getElementById(fold.getAttribute("aria-describedby") ?? "");
        const floor = summary ? 4 * parseFloat((globalThis as unknown as { getComputedStyle(e: E): { fontSize: string } }).getComputedStyle(summary).fontSize) * (((summary as unknown as { currentCSSZoom?: number }).currentCSSZoom) ?? 1) : 0;
        return {
          name: name.textContent ?? "",
          summary: summary?.textContent ?? null,
          row: name.parentElement!.getBoundingClientRect().width,
          nameWidth: words(name),
          summaryWidth: summary ? words(summary) : 0,
          floor,
          wrapped: summary !== null && summary.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 0.5,
        };
      });
    });
    assert.ok(heads.some((h) => h.name === "Save and damage" && h.summary === "None"), `a new trap's Save and damage says None: ${JSON.stringify(heads)}`);
    for (const h of heads) {
      const needs = h.nameWidth + 8 * 1.3 + Math.min(h.summaryWidth, h.floor);
      if (h.wrapped && needs <= h.row - 1) off.push(`${h.name}: its summary "${h.summary}" wrapped though the name (${h.nameWidth.toFixed(1)} px), the gap and ${Math.min(h.summaryWidth, h.floor).toFixed(1)} px of it need ${needs.toFixed(1)} of the row's ${h.row.toFixed(1)}`);
    }
    await shots.take(dm, "traps-dpfix-1-320x568-130-folded");
    await editor.getByRole("button", { name: "Done", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await pickTool(dm, "Select");
    await ops.send({ t: "trap.delete", trapId: bareId });
    await dm.setViewportSize(DESKTOP);
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(dm);
    assert.deepEqual(off, [], "out of line by more than 1 px, or wrapped where it fits");
  });

  test("pl1-b. at 1440 x 900, at 100% and 130%, a docked token window's Close stands as far under its frame's top as a trap pane's, and the Trap tool's hint sits in the middle of its line (docs/design-v1-polish.md R7, R8)", async () => {
    await ops.send({ t: "token.update", tokenId: run.thorn, patch: { x: 2, y: 9, elevation: 0 } });
    for (const scale of [1, 1.3]) {
      const label = `1440 x 900 at ${Math.round(scale * 100)}%`;
      await dm.setViewportSize({ width: 1440, height: 900 });
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await reopenRoom(dm);
      await waitFor("the DM's snapshot again", () => trap(dmSocket));
      await dm.locator(".konvajs-content").first().waitFor();
      await pickTool(dm, "Select");
      await tapCell(dm, BOUNDS, { x: 2, y: 9 });
      const window = dm.getByRole("dialog", { name: "Thorn actions" });
      await window.waitFor();
      await dm.waitForTimeout(200);
      assert.ok((await window.getAttribute("data-bar-mode")) !== "compact", `${label}: the token window did not dock`);
      const windowClose = await closeUnderTop(window);
      await window.getByRole("button", { name: "Close", exact: true }).click();
      await window.waitFor({ state: "detached" });

      await pickTool(dm, "Trap");
      const hint = dm.locator('[data-options-line="shown"]').filter({ visible: true }).first();
      await hint.waitFor();
      const words = await hint.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el.querySelector("span")!.firstChild!);
        const line = range.getClientRects()[0]!;
        // The line's border is the same above and below, so the middle of its outer box is the middle of its inner one.
        return { text: el.textContent ?? "", offset: Math.round(((line.top + line.bottom) / 2 - (r.top + r.bottom) / 2) * 10) / 10 };
      });
      assert.ok(Math.abs(words.offset) <= 1, `${label}: the hint "${words.text}" stands ${words.offset} px off its line's middle`);

      await tapCell(dm, BOUNDS, { x: 6, y: 4 });
      await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
      const paneClose = await closeUnderTop(pane(dm));
      assert.ok(Math.abs(windowClose - paneClose) <= 1, `${label}: the window's Close stands ${windowClose} px under its top, the pane's ${paneClose}`);
      await shots.take(dm, `traps-pl1-b-1440x900-${Math.round(scale * 100)}`);
      await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
      await pane(dm).waitFor({ state: "detached" });
      await pickTool(dm, "Select");
    }
    await dm.setViewportSize(DESKTOP);
    await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await reopenRoom(dm);
  });

  test("pl1-c. a focused control keeps its element and its focus when its row changes around it: a tick that another device leaves the last way the pit goes off, which gains the help that says why and loses it again, and the Sound field as Play comes and goes beside it (PL1-ASTRA-01, PL1-ASTRA-02)", async () => {
    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { rig: { on: ["enter", "leave"] } } });
    await waitFor("two ways it goes off", () => (trap(dmSocket)?.rig?.on?.length === 2 ? true : null));
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 6, y: 4 });
    await pane(dm).getByText("Hidden Pit", { exact: true }).first().waitFor();
    await unfold(dm, "Goes off when");
    const onto = pane(dm).getByRole("checkbox", { name: "A creature steps onto it" });
    // A mark on the element itself, which a new element in its place would not carry.
    const mark = (l: Locator) => l.evaluate((el) => ((el as unknown as { pl1Mark: boolean }).pl1Mark = true));
    const keeps = (l: Locator) => l.evaluate((el) => (el as unknown as { pl1Mark?: boolean }).pl1Mark === true && el.ownerDocument.activeElement === el);
    await onto.focus();
    await mark(onto);
    const why = pane(dm).getByText("A trap on squares goes off at least one way.");
    // Another device takes the other way away: this tick becomes the last, with its help.
    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { rig: { on: ["enter"] } } });
    await why.waitFor();
    assert.equal(await keeps(onto), true, "the tick was replaced, or lost focus, as its help came");
    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { rig: { on: ["enter", "leave"] } } });
    await why.waitFor({ state: "detached" });
    assert.equal(await keeps(onto), true, "the tick was replaced, or lost focus, as its help went");
    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { rig: { on: ["enter"] } } });
    await why.waitFor();

    await ops.send({ t: "trap.update", trapId: run.trapId, patch: { rig: { sound: null } } });
    await waitFor("no sound", () => (trap(dmSocket)?.rig?.sound ? null : true));
    await unfold(dm, "Players read");
    const sound = pane(dm).getByRole("combobox", { name: "Sound", exact: true });
    const play = pane(dm).getByRole("button", { name: "Play", exact: true });
    await sound.focus();
    await mark(sound);
    await sound.selectOption("click");
    await play.waitFor();
    assert.equal(await keeps(sound), true, "the Sound field was replaced, or lost focus, as Play came");
    await sound.selectOption("");
    await play.waitFor({ state: "detached" });
    assert.equal(await keeps(sound), true, "the Sound field was replaced, or lost focus, as Play went");
    await waitFor("no sound again", () => (trap(dmSocket)?.rig?.sound ? null : true));
    await pane(dm).getByRole("button", { name: "Done", exact: true }).click();
    await pane(dm).waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });
});
