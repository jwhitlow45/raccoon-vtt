import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, dragWorld, OpSocket, pagePoint, Shots, sleep, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Every dialog stays on the screen at the larger interface sizes
 * (docs/design-v1-dm-tools.md 3.16, review finding W5UI-1). The interface
 * size zooms the chrome with CSS `zoom`, which multiplies viewport units as
 * it does pixels, so a card sized `100dvh` ran off a phone at 130% with its
 * Save button out of reach. Each dialog the room offers is opened at 115%
 * and 130%, on a phone and a computer, and its card, its Close and its
 * main button must lie inside the window. Its body scrolls up and down
 * only: a row wider than the card (the icon picker's swatches, W5UI-10)
 * scrolled it sideways and cut off its right edge.
 *
 * Every dialog is the one shell of docs/design-v1-visual.md 2.3, and the
 * run checks its structure in each (checkShell): the request a roll and
 * image dialogs, the editors, the scene sheet, the monster filters, the
 * stamp picker and stamp sheet, the keyboard shortcuts, a player's handout
 * and the X-card, whose card has no title row. Every button and tab in
 * each is at least a 44 px target in the dialog's own pixels.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus five. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 5;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-size-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "computer", width: 1280, height: 800 },
] as const;
const SCALES = [1.15, 1.3] as const;

let server: Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let ops: OpSocket;
/** Pat's device, which opens the room as a player for the handout and taps the X-card. */
let playerContext: BrowserContext;
let player: Page;
const socket = new SocketWatch("dm");
const consoleWatch = new ConsoleWatch("dm");

const run = {
  roomId: "",
  roomName: `E2E size ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  bounds: { w: 0, h: 0 },
  sceneName: "",
  goblin: { id: randomUUID(), x: 0, y: 0 },
  orc: { id: randomUUID(), x: 0, y: 0 },
  /** A stamp's cell, clear of the tokens, so a tap there selects the stamp. */
  stamp: { id: randomUUID(), x: 0, y: 0 },
  handoutImage: "",
  uvttFile: path.join(work, "Small_hall.dd2vtt"),
  /** When the X-card was last tapped. Taps within 10 s of a card merge into it (server/http/xcard.ts). */
  xcardAt: 0,
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

/** A small Universal VTT file: an image and its grid, nothing more. */
async function writeUvtt(file: string): Promise<void> {
  const image = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 120, g: 110, b: 90 } } }).png().toBuffer();
  const content = {
    format: 0.3,
    resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 6, y: 4 }, pixels_per_grid: 50 },
    line_of_sight: [],
    objects_line_of_sight: [],
    portals: [],
    environment: { baked_lighting: true, ambient_light: "ffffffff" },
    lights: [],
    image: image.toString("base64"),
  };
  writeFileSync(file, JSON.stringify(content));
}

/** Whether the room lays out as a phone, with sheets, at this size: under 900 of its own pixels across. */
function narrow(size: (typeof SIZES)[number], scale: number): boolean {
  return size.width / scale < 900;
}

/** Opens a panel: the side panel's tab on a computer, or the Panels sheet's button on a phone. */
async function openPanel(name: string, phone: boolean): Promise<void> {
  if (!phone) {
    await page.getByRole("tab", { name: new RegExp(`^${name}( ?\\d+ unread)?$`) }).click();
    return;
  }
  const picker = page.getByRole("list", { name: "Panels" });
  const all = page.getByRole("button", { name: "All panels" });
  if (await picker.isVisible()) {
    // The list is already open.
  } else if (await all.isVisible()) await all.click();
  else await page.locator('button[title="Panels"]').click();
  await picker.getByRole("button", { name: new RegExp(`^${name}( ?\\d+ unread)?$`) }).click();
}

/** Closes a phone's panel sheet, so the map takes the next click. */
async function closeSheet(phone: boolean): Promise<void> {
  if (!phone) return;
  const sheet = page.locator("section[aria-label]").filter({ has: page.getByRole("button", { name: /^Close / }) });
  const close = page.getByRole("button", { name: /^Close (?!the map)/ }).first();
  if ((await sheet.count()) > 0 && (await close.isVisible())) await close.click();
}

type Box = { x: number; y: number; width: number; height: number };

function assertInside(box: Box | null, what: string, on: Page = page): void {
  const vp = on.viewportSize()!;
  assert.ok(box, `${what} has no box`);
  const inside = box.x >= -1 && box.y >= -1 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1;
  assert.ok(inside, `${what} lies outside the ${vp.width} x ${vp.height} window: ${JSON.stringify(box)}`);
}

/** No part of the dialog's body is wider than the body itself, so nothing hides past its right edge. */
async function assertNoSideScroll(dialog: Locator, label: string): Promise<void> {
  const widths = await dialog.locator("section").first().evaluate((card) => {
    // The server's type settings carry no DOM, as in harness.ts.
    const styleOf = (globalThis as unknown as { getComputedStyle(el: unknown): { overflowY: string } }).getComputedStyle;
    return [...card.children].flatMap((child) => {
      const el = child as unknown as { scrollWidth: number; clientWidth: number };
      const overflow = styleOf(child).overflowY;
      return overflow === "auto" || overflow === "scroll" ? [{ scroll: el.scrollWidth, client: el.clientWidth }] : [];
    });
  });
  assert.ok(widths.length > 0, `${label}: the dialog has no scrolling body`);
  for (const w of widths) assert.ok(w.scroll <= w.client, `${label}: the body scrolls sideways, ${w.scroll} px of content in ${w.client}`);
}

/**
 * The shell of docs/design-v1-visual.md 2.3, which components/Dialog.tsx
 * draws for every dialog: the card is the dialog's first `section`, right
 * inside it; the card holds the header, one body that scrolls, and the
 * footer when there is one, in that order; the header holds the title and
 * a close button whose name starts with "Close". The X-card is the one
 * dialog with no title row (`titleless`), since its card is its own
 * message: it has a body alone.
 */
async function checkShell(dialog: Locator, label: string, titleless: boolean): Promise<void> {
  const shell = await dialog.evaluate((el) => {
    type El = { tagName: string; parentElement: El | null; children: ArrayLike<El>; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; getAttribute(n: string): string | null };
    const styleOf = (globalThis as unknown as { getComputedStyle(el: unknown): { overflowY: string } }).getComputedStyle;
    const root = el as unknown as El;
    const card = root.querySelector("section");
    const children = card ? [...Array.from(card.children)] : [];
    const header = children.find((c) => c.tagName === "HEADER") ?? null;
    return {
      cardInDialog: card?.parentElement === root,
      tags: children.map((c) => c.tagName.toLowerCase()),
      scrolls: children.map((c) => ["auto", "scroll"].includes(styleOf(c).overflowY)),
      title: header?.querySelector("h2, h3") ? true : false,
      closes: header ? Array.from(header.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? "") : [],
    };
  });
  assert.ok(shell.cardInDialog, `${label}: the card is not the dialog's own first section`);
  const expected = titleless ? ["div"] : shell.tags.at(-1) === "footer" ? ["header", "div", "footer"] : ["header", "div"];
  assert.deepEqual(shell.tags, expected, `${label}: the card's parts`);
  assert.deepEqual(
    shell.scrolls.map((s, i) => (s ? shell.tags[i] : null)).filter(Boolean),
    ["div"],
    `${label}: the body, and nothing else in the card, scrolls`,
  );
  if (titleless) return;
  assert.ok(shell.title, `${label}: the header has no title`);
  assert.match(shell.closes.at(-1) ?? "", /^Close/, `${label}: the header ends in a close button named "Close …"`);
}

/**
 * Every button and tab in the dialog is a 44 px target in the dialog's own
 * pixels: the interface size's CSS zoom (`currentCSSZoom`) scales the box,
 * so a 40 px button would pass at 130% if measured on the screen.
 */
async function checkTargets(dialog: Locator, label: string): Promise<void> {
  const small = await dialog.evaluate((el) => {
    type Target = {
      getBoundingClientRect(): { width: number; height: number };
      getClientRects(): ArrayLike<unknown>;
      getAttribute(n: string): string | null;
      textContent: string | null;
      currentCSSZoom?: number;
    };
    const root = el as unknown as { querySelectorAll(s: string): ArrayLike<Target> };
    return Array.from(root.querySelectorAll('button, [role="button"], [role="tab"]')).flatMap((t) => {
      // Folded or hidden: not a target until it shows.
      if (t.getClientRects().length === 0) return [];
      const r = t.getBoundingClientRect();
      const zoom = t.currentCSSZoom ?? 1;
      const w = r.width / zoom;
      const h = r.height / zoom;
      const name = t.getAttribute("aria-label") ?? (t.textContent ?? "").trim();
      return w < 43.5 || h < 43.5 ? [`"${name}" ${w.toFixed(1)} x ${h.toFixed(1)}`] : [];
    });
  });
  assert.deepEqual(small, [], `${label}: targets under 44 px`);
}

/**
 * The dialog's card, its Close and its main button lie inside the window,
 * its shell is the shared one, and its targets are 44 px. A main button in
 * a footer must be there as the dialog opens. One in the dialog's body,
 * which scrolls, must be reachable by scrolling it.
 */
async function checkDialog(dialog: Locator, label: string, main: { name: string; in: "footer" | "body" } | null, opts: { titleless?: boolean } = {}): Promise<void> {
  const titleless = opts.titleless === true;
  const owner = dialog.page();
  await dialog.waitFor();
  // The card settles once the dialog's zoom and its content are laid out.
  await owner.waitForTimeout(250);
  assertInside(await dialog.locator("section").first().boundingBox(), `${label}: the card`, owner);
  if (!titleless) assertInside(await dialog.getByRole("button", { name: /^Close/ }).first().boundingBox(), `${label}: Close`, owner);
  await checkShell(dialog, label, titleless);
  await assertNoSideScroll(dialog, label);
  await checkTargets(dialog, label);
  if (!main) return;
  const button = (main.in === "footer" ? dialog.locator("footer") : dialog).getByRole("button", { name: main.name, exact: true }).first();
  if (main.in === "body") await button.scrollIntoViewIfNeeded();
  assertInside(await button.boundingBox(), `${label}: ${main.name}`, owner);
}

async function closeDialog(dialog: Locator): Promise<void> {
  await dialog.page().keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
}

/** Clicks a token on the map. */
async function clickToken(token: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, run.bounds, { x: token.x + 0.5, y: token.y + 0.5 });
  await page.mouse.click(p.x, p.y);
}

/** A drag with Shift held over empty map selects the tokens in its box. */
async function boxSelect(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.keyboard.down("Shift");
  await dragWorld(page, run.bounds, from, to);
  await page.keyboard.up("Shift");
}

describe("raccoon-vtt dialogs at the larger interface sizes", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    consoleWatch.attach(page);
    await socket.attach(context, page);
    await writeUvtt(run.uvttFile);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      console.error(`[${consoleWatch.label}] errors`, consoleWatch.errors, "warnings", consoleWatch.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    await playerContext?.close();
    if (run.roomId && context) {
      try {
        const res = await context.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("1. a DM's room with a player's character, two monsters, a stamp, a library image and a handout", async () => {
    await page.goto(`${server.origin}/`);
    await page.getByLabel("Room name").fill(run.roomName);
    await page.getByLabel("Your name").fill("Dana the DM");
    run.password = await page.getByLabel("Player password").inputValue();
    await page.getByRole("button", { name: "Create room" }).click();
    await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await page.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await page.getByLabel("I saved my DM link").check();
    await page.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => socket.state);
    run.sceneId = socket.state!.meta.playerSceneId!;
    run.bounds = socket.state!.scenes[run.sceneId]!.bounds;
    run.sceneName = socket.state!.scenes[run.sceneId]!.name;

    // A player joins from a device of their own, so the party has a character to ask, and someone sees a handout.
    playerContext = await browser.newContext();
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    const patId = ((await done.json()) as { member: { id: string } }).member.id;
    player = await playerContext.newPage();

    const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 60, g: 160, b: 70 } } }).png().toBuffer();
    const upload = await context.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=token`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: image });
    assert.ok(upload.ok(), `uploading a token image answered ${upload.status()}`);
    // Wider than tall, as most handouts are.
    const letter = await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 200, g: 180, b: 140 } } }).png().toBuffer();
    const handout = await context.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=handout`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: letter });
    assert.ok(handout.ok(), `uploading a handout answered ${handout.status()}`);
    run.handoutImage = ((await handout.json()) as { id: string }).id;

    const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const characterId = randomUUID();
    const cx = Math.floor(run.bounds.w / 2);
    const cy = Math.floor(run.bounds.h / 2);
    // The orc stands left of the goblin, clear of the bar a selected goblin opens beside itself.
    run.goblin = { ...run.goblin, x: cx + 2, y: cy };
    run.orc = { ...run.orc, x: cx - 3, y: cy };
    await ops.send({ t: "character.create", character: { id: characterId, name: "Thorn", size: "medium", ownerIds: [patId], actor: actor() } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(randomUUID(), { kind: "pc", name: "Thorn", x: cx - 1, y: cy - 3, disposition: "ally", actor: { ref: characterId } }));
    await ops.send(token(run.goblin.id, { kind: "monster", name: "Goblin", x: run.goblin.x, y: run.goblin.y, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(token(run.orc.id, { kind: "monster", name: "Orc", x: run.orc.x, y: run.orc.y, disposition: "hostile", actor: { inline: actor() } }));
    run.stamp = { ...run.stamp, x: cx, y: cy + 3 };
    const stamp = { id: run.stamp.id, art: { key: "barrel" }, x: run.stamp.x + 0.5, y: run.stamp.y + 0.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
    await ops.send({ t: "build.stamps", sceneId: run.sceneId, put: [stamp] });
    await waitFor("the monsters and the stamp in the DM's view", () => (socket.state?.tokens[run.goblin.id] && socket.state?.tokens[run.orc.id] && socket.state?.stamps[run.stamp.id]) || null);
  });

  for (const size of SIZES.filter((s) => process.env.SIZE_ONLY === undefined || s.name === process.env.SIZE_ONLY)) {
    for (const scale of SCALES) {
      const label = `${size.name} ${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;

      test(`2. every dialog stays on the screen: ${label}`, async () => {
        const phone = narrow(size, scale);
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await page.reload();
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        const shoot = async (name: string) => {
          if (scale === 1.3) await shots.take(page, `size-${size.name}-130-${name}`);
        };

        // Modal: a journal page.
        await openPanel("Journal", phone);
        await page.getByRole("button", { name: "New page" }).click();
        const pageEditor = page.getByRole("dialog", { name: "New page" });
        await checkDialog(pageEditor, `${label}, New page`, { name: "Save", in: "footer" });
        await shoot("journal-page");
        await closeDialog(pageEditor);

        // Modal: the log's export.
        await openPanel("Log", phone);
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const exportLog = page.getByRole("dialog", { name: "Export the log" });
        await checkDialog(exportLog, `${label}, Export the log`, { name: "Export", in: "body" });
        await closeDialog(exportLog);

        // Modal: a new room monster.
        await openPanel("Monsters", phone);
        await page.getByRole("button", { name: "New monster" }).click();
        const monster = page.getByRole("dialog", { name: "New monster" });
        await checkDialog(monster, `${label}, New monster`, { name: "Save", in: "footer" });
        await shoot("new-monster");
        await closeDialog(monster);

        // The monster filters, from the same panel.
        await page.getByRole("button", { name: /^Filters(, \d+ on)?$/ }).click();
        const filters = page.getByRole("dialog", { name: "Monster filters" });
        await checkDialog(filters, `${label}, Monster filters`, { name: "Done", in: "footer" });
        await shoot("monster-filters");
        await closeDialog(filters);

        // Modal: the image picker, then the crop editor it leads to.
        await openPanel("Characters", phone);
        await page.getByRole("button", { name: "New character" }).click();
        await page.getByRole("button", { name: "Add image" }).first().click();
        const picker = page.getByRole("dialog", { name: "Choose an image" });
        await checkDialog(picker, `${label}, Choose an image`, null);
        // The Icons tab, first: an icon picked, its colors and its Use in reach.
        await picker.getByRole("list", { name: "Icons" }).getByRole("button").first().click();
        await checkDialog(picker, `${label}, an icon picked`, { name: "Use", in: "body" });
        await shoot("icon-picked");
        // Link and Search the web: a field and its button share the row.
        await picker.getByRole("tab", { name: "Link" }).click();
        await picker.getByLabel("Image link").waitFor();
        await checkDialog(picker, `${label}, Link`, { name: "Import", in: "body" });
        await picker.getByRole("tab", { name: "Search the web" }).click();
        await picker.getByLabel("Search for").waitFor();
        await checkDialog(picker, `${label}, Search the web`, { name: "Search", in: "body" });
        await picker.getByRole("tab", { name: "Library" }).click();
        await picker.getByRole("button", { name: "Use this image" }).first().click();
        const crop = page.getByRole("dialog", { name: "Crop the image" });
        await checkDialog(crop, `${label}, Crop the image`, { name: "Save", in: "footer" });
        await shoot("crop");
        await closeDialog(crop);

        // Modal: a Universal VTT import.
        await openPanel("Scenes", phone);
        await page.getByLabel("From a Universal VTT file").setInputFiles(run.uvttFile);
        const uvtt = page.getByRole("dialog", { name: "Import a Universal VTT map" });
        await checkDialog(uvtt, `${label}, Import a Universal VTT map`, { name: "Create scene", in: "footer" });
        await closeDialog(uvtt);

        // The scene sheet, from the scene's more button, through two of its steps.
        await page.getByRole("button", { name: `More for ${run.sceneName}` }).click();
        const sceneMenu = page.getByRole("dialog", { name: run.sceneName, exact: true });
        await checkDialog(sceneMenu, `${label}, the scene's menu`, null);
        await sceneMenu.getByRole("button", { name: /^Duplicate/ }).click();
        const duplicate = page.getByRole("dialog", { name: `Duplicate ${run.sceneName}` });
        await checkDialog(duplicate, `${label}, Duplicate a scene`, { name: "Duplicate", in: "footer" });
        await shoot("scene-duplicate");
        await duplicate.getByRole("button", { name: "Back to the menu" }).click();
        await sceneMenu.getByRole("button", { name: /^Move to folder/ }).click();
        const folder = page.getByRole("dialog", { name: `Move ${run.sceneName} to a folder` });
        await checkDialog(folder, `${label}, Move a scene to a folder`, null);
        await closeDialog(folder);

        // SheetDialog: Request a roll, from the party.
        if (phone) await openPanel("Party", phone);
        await page.getByRole("button", { name: "Ask the party" }).first().click();
        const request = page.getByRole("dialog", { name: "Request a roll" });
        await checkDialog(request, `${label}, Request a roll`, { name: "Send", in: "footer" });
        await shoot("request-roll");
        await closeDialog(request);

        // Modal: Attach a stat block, from the goblin's panel.
        await closeSheet(phone);
        await clickToken(run.goblin);
        if (phone) await page.getByRole("button", { name: "Details" }).click();
        else await page.getByRole("tab", { name: "Token" }).click();
        await page.getByRole("button", { name: "Attach a stat block" }).click();
        const attach = page.getByRole("dialog", { name: "Attach a stat block" });
        await checkDialog(attach, `${label}, Attach a stat block`, null);
        await closeDialog(attach);

        // SheetDialog: More, for the goblin and the orc together, picked with a Shift box over both.
        await closeSheet(phone);
        await page.keyboard.press("Escape");
        await boxSelect({ x: run.orc.x - 1, y: run.orc.y - 1 }, { x: run.goblin.x + 2, y: run.goblin.y + 2 });
        await page.getByRole("button", { name: "More", exact: true }).click();
        const more = page.getByRole("dialog", { name: "2 tokens" });
        await checkDialog(more, `${label}, 2 tokens`, null);
        await shoot("group-more");
        await closeDialog(more);
        await page.keyboard.press("Escape");

        // The keyboard shortcuts, from the ? key.
        await page.keyboard.press("?");
        const keys = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await checkDialog(keys, `${label}, Keyboard shortcuts`, null);
        await shoot("shortcuts");
        await closeDialog(keys);

        // The stamp picker, then on a phone the sheets of the selected stamp's bar, which only a narrow bar has.
        await page.getByRole("button", { name: "Map builder" }).click();
        await page.getByLabel("Builder mode").selectOption("stamp");
        await page.getByRole("button", { name: /Choose a stamp/ }).click();
        const stamps = page.getByRole("dialog", { name: "Stamps" });
        await checkDialog(stamps, `${label}, Stamps`, null);
        await shoot("stamps");
        await closeDialog(stamps);
        await tapCell(page, run.bounds, run.stamp);
        const bar = page.getByRole("toolbar", { name: "Map builder options" });
        if (phone) {
          for (const [button, title] of [[/^Tint:/, "Tint"], ["More", "More"]] as const) {
            await bar.getByRole("button", { name: button, exact: true }).click();
            const sheet = page.getByRole("dialog", { name: title, exact: true });
            await checkDialog(sheet, `${label}, the stamp's ${title}`, null);
            if (title === "Tint") await shoot("stamp-tint");
            await closeDialog(sheet);
          }
        }
        await bar.getByRole("button", { name: "Done", exact: true }).click();
        await page.getByRole("button", { name: "Select", exact: true }).click();

        // A handout, on Pat's device at the same size and interface size.
        await player.setViewportSize({ width: size.width, height: size.height });
        if (!player.url().startsWith(server.origin)) await player.goto(`${server.origin}/r/${run.roomId}`);
        await player.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
        await player.reload();
        await player.getByRole("status", { name: "Connected" }).first().waitFor();
        const handoutId = randomUUID();
        const title = `A letter, ${label}`;
        await ops.send({ t: "handout.show", handout: { id: handoutId, assetId: run.handoutImage, title, to: "all" } });
        const letter = player.getByRole("dialog", { name: title });
        await letter.getByRole("img", { name: title }).waitFor();
        await checkDialog(letter, `${label}, a handout`, null);
        if (scale === 1.3) await shots.take(player, `size-${size.name}-130-handout`);
        await letter.getByRole("button", { name: `Close ${title}` }).click();
        await letter.waitFor({ state: "detached" });
        await ops.send({ t: "handout.close", handoutId });

        // The X-card, which Pat taps and every device shows: the one dialog with no title row.
        const merging = run.xcardAt + 11_000 - Date.now();
        if (merging > 0) await sleep(merging);
        const tapped = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
        assert.equal(tapped.status(), 204, "the X-card tap was refused");
        run.xcardAt = Date.now();
        const card = page.getByRole("dialog", { name: "X-card" });
        await checkDialog(card, `${label}, X-card`, { name: "Dismiss", in: "body" }, { titleless: true });
        await shoot("xcard");
        await card.getByRole("button", { name: "Dismiss" }).click();
        await card.waitFor({ state: "detached" });
      });
    }
  }

  test("3. no page errors along the way", () => {
    assert.deepEqual(consoleWatch.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
