import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import sharp from "sharp";
import type { BuildChunk, EdgeFeature, RoomState } from "#shared/model.ts";
import { applyChanges, type ProjectedState } from "#shared/project.ts";
import { privateFieldsIn } from "#shared/privateFields.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { assertNoticeCover, watchNoticeCover } from "./fu38b.steps.ts";
import { assertCanvasAt, ConsoleWatch, dragCells, expandBar, openSideTab, OpSocket, pagePoint, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Per-player vision (docs/design-v1-per-player-vision.md section 10, steps
 * pv-1 to pv-8): the real server serving the production build, a DM on a
 * computer, Ana and Ben on phones and a table display, on one dark scene
 * whose Sight the DM sets to Per player.
 *
 * Ana plays Thorn, in the north hall, and Ben plays Bree, in a walled room
 * of the south half. Each carries a torch. A goblin stands in Thorn's light
 * and a label lies on ground only Thorn sees. Through the run, Ana gets
 * the goblin, its row and the label while Ben and the display get none of
 * them, Thorn opens a door Ben's map draws only once Bree has seen it, the
 * DM's View as a player shows each player their own view and no whisper
 * between them, a Night phase keeps the scene per player, the DM's list of
 * who sees for themselves moves Ana's place to a third player, and Whole
 * party pools the maps, which stay pooled once the scene is per player
 * again. In Isometric the DM's standee on ground the party explored stands
 * bright, and Ben's page stands nothing he does not see. At the end every
 * frame Ben's page and the display received is
 * replayed: neither held the goblin while the scene was per player, nor
 * the label before the maps were pooled.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus thirty,
 * which no other file uses. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 30;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-pervision-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/**
 * The scene, 16 by 20 squares, dark, with fog and vision on, from a map
 * of 25 px squares with a Day and a Night phase:
 *
 * - The north hall, rows 0 to 9: Thorn at (3, 9) by the door, his torch
 *   (bright 20 ft, dim 20 ft more, so 8 squares) lighting the goblin at
 *   (7, 5) and the label "Old altar" at (6.5, 3.5).
 * - A wall along row 10 with a closed door above (3, 10).
 * - The south half, split by a wall along column 8: the west room behind
 *   the door, and the east room where Bree starts at (12, 15). The east
 *   room's corner at (14, 18) is ground only Bree ever sees.
 *
 * Bree moved to (6, 13) later sees the door's south side and, through the
 * open door, only a thin wedge of the north hall's west edge, far from the
 * goblin and the label.
 */
const BOUNDS = { w: 16, h: 20 };
const CELL_PX = 25;
const DOOR = "3,10,n";
const THORN_AT = { x: 3, y: 9 };
const BREE_AT = { x: 12, y: 15 };
const BREE_LATER = { x: 6, y: 13 };
const GOBLIN_AT = { x: 7, y: 5 };
/** Where the DM drags the goblin in pv-2b: still in Thorn's light, far from any wedge Bree later sees through the door. */
const GOBLIN_LATER = { x: 7, y: 4 };
const LABEL_AT = { x: 6.5, y: 3.5 };
const LABEL_CELL = { x: 6, y: 3 };
const DOOR_NORTH = { x: 3, y: 9 };
const DOOR_SOUTH = { x: 3, y: 10 };
/** A DM's line every page gets, sent after the door opens so a copy that holds it is past the opening. */
const DOOR_MARK = "The door creaks";
/** Ground only Bree ever sees, until Whole party pools the maps. */
const BREE_CORNER = { x: 14, y: 18 };
const LABEL_TEXT = "Old altar";
const WHISPER = "Meet me by the old well";
/** Ground nobody ever explores: past Thorn's torch in the north hall, behind the wall from Bree. */
const NOBODY_AT = { x: 15, y: 0 };
/** A member's name at the 80 characters a name may take (shared/protocol.ts MAX_NAME), with no space to wrap at. */
const LONG_NAME = "W".repeat(80);
const VIEW_AS_A_PLAYER = "View as a player";
/**
 * va-3's creatures near the map's top, both hidden by the DM, so they lend
 * no sight and reach no player: the pack mule Ben and the long-named
 * player own, and the wagon only the long-named player owns.
 */
const MULE_AT = { x: 14, y: 1 };
const WAGON_AT = { x: 12, y: 1 };
/** dp-4a's companion, hidden by the DM as the mule is, whose character Ana and Ben play. */
const HAWK_AT = { x: 13, y: 0 };
/** Installs the hook that picks a view without the View menu (client/canvas/relief/isoTest.ts), set before a page loads. */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

const run = {
  roomId: "",
  roomName: `E2E pervision ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  anaId: "",
  benId: "",
  cyId: "",
  longId: "",
  thornId: randomUUID(),
  muleId: randomUUID(),
  wagonId: randomUUID(),
  ivyId: randomUUID(),
  hawkId: randomUUID(),
  breeId: randomUUID(),
  goblinId: randomUUID(),
  labelId: randomUUID(),
  phases: { day: randomUUID(), night: randomUUID() },
  /** The Night phase's map, which a player's copy of the scene shows once the DM switches to it (players hold no phase list). */
  nightMap: "",
  /** How many frames Ben's page and the display had received when Whole party pooled the maps (pv-7). */
  pooledAt: { ben: -1, tv: -1 },
};

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let benContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let ana: Page;
let ben: Page;
let tv: Page;
let ops: OpSocket;
const sockets = { dm: new SocketWatch("dm"), ana: new SocketWatch("ana"), ben: new SocketWatch("ben"), tv: new SocketWatch("display") };
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), ben: new ConsoleWatch("ben"), tv: new ConsoleWatch("display") };

/**
 * The DM page's View as a player sockets (`as=`, not a display's), routed
 * through the run so it can hold the server's frames, and see the loading
 * line, and keep every frame the preview got.
 */
const previews = {
  /** While true, the server's frames to the preview wait in `queue`. */
  hold: false,
  queue: [] as (string | Buffer)[],
  /** Every frame the server sent the preview socket opened last, as text. */
  frames: [] as string[],
  socket: null as WebSocketRoute | null,
  /** How many of the next preview sockets close before they reach the server, as a refused one does (dp-3a). */
  refuse: 0,
};

async function routePreviews(page: Page): Promise<void> {
  await page.routeWebSocket(/[?&]as=(?!display)/, (ws) => {
    if (previews.refuse > 0) {
      previews.refuse--;
      void ws.close();
      return;
    }
    previews.frames = [];
    previews.queue = [];
    previews.socket = ws;
    const upstream = ws.connectToServer();
    ws.onMessage((m) => upstream.send(m));
    upstream.onMessage((m) => {
      previews.frames.push(typeof m === "string" ? m : m.toString("utf8"));
      if (previews.hold) previews.queue.push(m);
      else ws.send(m);
    });
    ws.onClose((code, reason) => upstream.close({ code, reason }));
    upstream.onClose((code, reason) => ws.close({ code, reason }));
  });
}

function releasePreview(): void {
  previews.hold = false;
  for (const m of previews.queue.splice(0)) previews.socket?.send(m);
}

function picture(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: BOUNDS.w * CELL_PX, height: BOUNDS.h * CELL_PX, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

async function upload(data: Buffer): Promise<{ id: string; width: number; height: number }> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  return (await res.json()) as { id: string; width: number; height: number };
}

/** Joins the room as a player from a context, as the join page does, and returns the new member's id. */
async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

async function cookieOf(context: BrowserContext): Promise<string> {
  return (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
}

function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function creature(id: string, name: string, at: { x: number; y: number }, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, kind: "monster", name, size: "medium", x: at.x, y: at.y, visibility: "all", actor: { inline: actor() }, ...extra } };
}

/** Whether a page's copy holds the goblin, the label, or ground at a cell out of its fog. */
const has = {
  goblin: (s: RoomState | null) => s?.tokens[run.goblinId] !== undefined,
  label: (s: RoomState | null) => s?.labels[run.labelId] !== undefined,
  ground: (s: RoomState | null, cell: { x: number; y: number }) => !!s && !isCellFullyFogged(s.fogTiles, run.sceneId, cell),
  perPlayer: (s: RoomState | null) => s?.scenes[run.sceneId]?.vision?.perPlayer === true,
};

function doorIn(state: RoomState | null): EdgeFeature | undefined {
  return (state?.buildChunks[`${run.sceneId}:0,0`] as BuildChunk | undefined)?.edges[DOOR];
}

/** The scene's holder entries in the DM's copy, as "name on" or "name off", in list order. */
function holderList(): string[] {
  const state = sockets.dm.state;
  return (state?.holders?.[run.sceneId]?.entries ?? []).map((e) => `${state?.members[e.memberId]?.name ?? e.memberId} ${e.on ? "on" : "off"}`);
}

/** Waits for the holder list to hold exactly these entries, in any order: joins follow the sources' order, which the run does not pin. */
async function listIs(want: string[]): Promise<void> {
  const sorted = (list: string[]) => [...list].sort().join(", ");
  try {
    await waitFor(`the holder list ${want.join(", ")}`, () => (sorted(holderList()) === sorted(want) ? true : null));
  } catch (err) {
    throw new Error(`${(err as Error).message}: it is ${holderList().join(", ")}`);
  }
}

/** Picks a view on a page through the test hook, as the View menu would. */
async function pickView(page: Page, pick: "isometric" | "follow"): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate((p) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(p), pick);
}

/**
 * A token's node on the isometric board, wherever it draws: "standee" with
 * its opacity on the relief stage, "flat" on the ground stage only, where
 * the stand rule lays a creature under the viewer's fog, or null where the
 * page draws none. The relief stage also holds a flat creature's press
 * area, so a node there counts as a standee only where the ground stage
 * has none of it. Null too while no isometric board shows.
 */
async function isoNode(page: Page, tokenId: string): Promise<{ as: "standee"; opacity: number } | { as: "flat" } | null> {
  return page.evaluate((id) => {
    type Node = { opacity(): number };
    type Stage = { width(): number; listening(): boolean; getLayers(): unknown[]; findOne(s: string): Node | undefined };
    const stages = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.filter((s) => s.width() > 0);
    // The relief stage takes presses and holds three layers (relief/IsoBoard.tsx), the ground stage under it takes none.
    const relief = stages.find((s) => s.listening() && s.getLayers().length === 3);
    if (!relief) return null;
    const ground = stages.find((s) => s !== relief && !s.listening() && s.findOne(`#${id}`) !== undefined);
    if (ground) return { as: "flat" as const };
    const node = relief.findOne(`#${id}`);
    return node ? { as: "standee" as const, opacity: node.opacity() } : null;
  }, tokenId);
}

function turnStrip(page: Page | Locator): Locator {
  return page.getByRole("button", { name: /^Initiative, round 1\./ });
}

function scenesPanel(): Locator {
  return dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
}

/**
 * Picks an option of the DM's Sight row, and waits for the DM's copy to say
 * it. Whole party asks first while players hold maps of their own
 * (docs/design-v1-map-discovery.md 8.1), and Change answers it.
 */
async function pickSight(choice: "Whole party" | "Per player"): Promise<void> {
  await openSideTab(dm, "Scenes");
  await scenesPanel().getByRole("radiogroup", { name: "Sight" }).getByRole("radio", { name: choice }).click();
  const asked = scenesPanel().getByRole("group", { name: "Change Sight?" });
  const done = () => has.perPlayer(sockets.dm.state) === (choice === "Per player");
  await waitFor(`the question or the scene ${choice}`, async () => (done() || (await asked.count()) > 0 ? true : null));
  if (!done()) {
    assert.equal((await asked.getByRole("status").innerText()).trim(), "Each player's own map joins the party's. Undo does not split them again.");
    await asked.getByRole("button", { name: "Change", exact: true }).click();
  }
  await waitFor(`the scene ${choice} in the DM's copy`, () => (done() ? true : null));
}

/** Taps a door's south edge, just past the cell above it, as a finger reaching for the door would. */
async function tapDoor(page: Page): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: 3.5, y: 10.25 });
  await assertCanvasAt(page, p);
  await page.mouse.click(p.x, p.y);
}

/** A tap on empty ground, which puts a door's pill away. */
async function tapAway(page: Page, cell: { x: number; y: number }): Promise<void> {
  await tapCell(page, BOUNDS, cell);
  await page.getByRole("group", { name: /door$/ }).waitFor({ state: "detached" });
}

type Frame = { t?: string; state?: ProjectedState; changes?: Parameters<typeof applyChanges>[1]; you?: { memberId: string; role: string } };

/**
 * Opens View as a player for `name` from the DM panel, holding the
 * server's frames until the loading line shows, then letting them through,
 * and returns the preview's dialog once its map is drawn, with the
 * snapshot it got.
 */
async function viewAs(name: string): Promise<{ preview: Locator; snapshot: Frame }> {
  previews.hold = true;
  await openSideTab(dm, "DM");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
  await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: name });
  await panel.getByRole("button", { name: "View", exact: true }).click();
  const preview = dm.locator(`dialog[aria-label="Viewing as ${name}"]`);
  await preview.waitFor();
  await preview.getByRole("status").filter({ hasText: `Loading what ${name} sees` }).waitFor();
  await waitFor(`the snapshot for the preview of ${name}, held`, () => (previews.queue.length > 0 ? true : null));
  await shots.take(dm, `pervision-preview-${name.toLowerCase()}-loading`);
  releasePreview();
  await preview.locator(".konvajs-content").first().waitFor();
  const snapshot = previews.frames.map((text) => JSON.parse(text) as Frame).find((f) => f.t === "snapshot");
  assert.ok(snapshot?.state, `the preview of ${name} got no snapshot`);
  return { preview, snapshot };
}

async function exitPreview(preview: Locator): Promise<void> {
  await preview.getByRole("button", { name: "Exit", exact: true }).click();
  await preview.waitFor({ state: "detached" });
}

/**
 * Opens View as a player from one of a token's entries (D-261027-09),
 * checks that it is the one preview, of that player, and leaves it,
 * waiting for focus to return to the entry.
 */
async function viewFrom(button: Locator, name: string, memberId: string, from: string): Promise<void> {
  await button.click();
  await previewShows(name, memberId, from, button);
}

/** The preview that a View as opened is the one preview, of that player. Exit leaves it, and focus goes back to `returnTo`. */
async function previewShows(name: string, memberId: string, from: string, returnTo: Locator): Promise<void> {
  const preview = dm.locator(`dialog[aria-label="Viewing as ${name}"]`);
  await preview.waitFor();
  await preview.locator(".konvajs-content").first().waitFor();
  const snapshot = previews.frames.map((text) => JSON.parse(text) as Frame).find((f) => f.t === "snapshot");
  assert.equal(snapshot?.you?.memberId, memberId, `View as ${name} from the ${from} showed someone else's view`);
  assert.equal(snapshot?.you?.role, "player");
  assert.equal(await dm.locator('dialog[aria-label^="Viewing as"]').count(), 1, "one preview at a time");
  await shots.take(dm, `viewas-${from}`);
  await exitPreview(preview);
  await waitFor(`focus back on the ${from}'s View as`, () => returnTo.evaluate((el) => el === el.ownerDocument.activeElement || null));
}

/** What va-3 reads of the page, which its own types name: the e2e code is compiled without the DOM's. */
type Box = { left: number; top: number; right: number; bottom: number };
type El = {
  getBoundingClientRect(): Box;
  scrollWidth: number;
  clientWidth: number;
  textContent: string | null;
  contains(n: El): boolean;
  querySelectorAll(s: string): Iterable<El>;
};

/** The buttons and items in `root` whose words run past their own box or out of `root`'s sides (HXVA-ASTRA-02). */
async function spills(root: Locator, at: string): Promise<string[]> {
  return root.evaluate(
    (el, at) => {
      const box = (el as unknown as El).getBoundingClientRect();
      const out: string[] = [];
      for (const c of (el as unknown as El).querySelectorAll("button, [role='menuitem']")) {
        const r = c.getBoundingClientRect();
        if (c.scrollWidth > c.clientWidth + 1 || r.left < box.left - 1 || r.right > box.right + 1) out.push(`${at}: "${(c.textContent ?? "").slice(0, 20)}" runs past its box`);
      }
      return out;
    },
    at,
  );
}

/**
 * A creature header as the page lays it out (CreatureHeader.tsx): how many
 * rows its grid holds, the words of its actions row's buttons and lines,
 * and the boxes of the header, its name, its quick numbers, its actions
 * row and the part after it.
 */
type HeaderLayout = { rows: number; actions: string[]; header: Box; name: Box; numbers: Box | null; row: Box | null; next: Box | null };

async function headerLayout(header: Locator): Promise<HeaderLayout> {
  return header.evaluate((el) => {
    type Node = El & { nextElementSibling: Node | null; querySelector(s: string): Node | null; children: Iterable<Node> };
    const { getComputedStyle } = globalThis as unknown as { getComputedStyle(e: unknown): { gridTemplateRows: string } };
    const h = el as unknown as Node;
    const box = (n: Node | null): Box | null => {
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const row = h.querySelector("[data-header-actions]");
    return {
      rows: getComputedStyle(h).gridTemplateRows.trim().split(/\s+/).length,
      actions: row ? [...row.children].map((c) => (c.textContent ?? "").trim()) : [],
      header: box(h)!,
      name: box(h.querySelector("h3"))!,
      numbers: box(h.querySelector("[data-quick-numbers]")),
      row: box(row),
      next: box(h.nextElementSibling),
    };
  });
}

/** Ivy's page in the Characters panel of a page that has just loaded: the side panel's tab from 900 px, else a sheet from Panels. Returns her header. */
async function ivysPage(page: Page, side: boolean): Promise<Locator> {
  let panel: Locator;
  if (side) {
    await openSideTab(page, "Characters");
    panel = page.getByRole("tabpanel", { name: sideTabName("Characters") });
  } else {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
    panel = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  }
  await panel.locator(`[data-opener="character:${run.ivyId}"]`).click();
  const header = panel.locator("[data-creature-header]").filter({ has: page.getByRole("heading", { name: "Ivy", exact: true }) });
  await header.waitFor();
  await header.scrollIntoViewIfNeeded();
  return header;
}

/** Back to the Characters list, and on a phone its sheet put away, so the map takes taps again. */
async function leavePage(page: Page, side: boolean): Promise<void> {
  await page.getByRole("button", { name: "Back to Characters" }).click();
  if (side) return;
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  await sheet.getByRole("button", { name: /^Close / }).first().click();
  await sheet.waitFor({ state: "hidden" });
}

/**
 * What is wrong with a header's actions row (docs/design-v1-design-pass.md
 * 4.3): it holds `want`, under the quick numbers, from the header's own
 * left edge rather than the name's, and above the part after the header.
 */
function actionsRowWrong(at: string, layout: HeaderLayout, want: string[]): string[] {
  const { row, numbers, header, name, next } = layout;
  if (!row || !numbers) return [`${at}: no actions row${numbers ? "" : " and no quick numbers"}`];
  const out: string[] = [];
  if (JSON.stringify(layout.actions) !== JSON.stringify(want)) out.push(`${at}: the row holds ${JSON.stringify(layout.actions)}`);
  if (layout.rows !== 2) out.push(`${at}: the header lays out ${layout.rows} rows`);
  if (row.top < numbers.bottom) out.push(`${at}: the row starts ${(numbers.bottom - row.top).toFixed(1)} px above the quick numbers' foot`);
  if (Math.abs(row.left - header.left) > 1) out.push(`${at}: the row starts ${(row.left - header.left).toFixed(1)} px from the header's edge`);
  if (row.left > name.left - 1) out.push(`${at}: the row starts in the name's column`);
  if (next && next.top < row.bottom - 1) out.push(`${at}: the part after the header starts above the row's foot`);
  return out;
}

/**
 * Opens a token's list of its players from `anchor` on a computer and
 * reads it: it opens on the side of its button with the more room
 * (HXVA-OPUS-1), every player in it shows whole, uncovered and unscrolled,
 * with `notice` even under a notice laid across it in the notices' layer
 * (HXVA-ASTRA-03), it is no wider than a side panel and no name runs out
 * of it (HXVA-ASTRA-02), and it sits within 1 px. The list stays open.
 *
 * The cover is read twice: in the task the list first appears in, and once
 * it is measured. Its holder once stood over the notices a task after the
 * list showed, so a read that slipped in between, as one did under load,
 * found the list under the notice (VA3-NOTICE-FLAKE). Read as it opens,
 * a holder raised late fails every time.
 */
async function openPlayers(page: Page, anchor: Locator, at: string, notice: boolean): Promise<string[]> {
  await page.evaluate(
    ({ at, notice, name }) => {
      type Doc = { body: unknown; elementFromPoint(x: number, y: number): El | null; querySelector(s: string): (El & { appendChild(n: unknown): void }) | null; createElement(t: string): { style: Record<string, string>; remove(): void } };
      type Observer = { observe(target: unknown, options: { childList: boolean; subtree: boolean }): void; disconnect(): void };
      type Win = { document: Doc; MutationObserver: new (callback: () => void) => Observer; rvttCover?: (list: El) => string[]; rvttFirstCover?: string[] | null };
      const win = globalThis as unknown as Win;
      const { document } = win;
      win.rvttCover = (list) => {
        const r = list.getBoundingClientRect();
        // A notice's box over the whole list, in the notices' own layer, so only the stacking order decides which shows.
        const layer = document.querySelector("[data-rvtt-toast-layer]");
        const cover = notice && layer ? document.createElement("div") : null;
        if (cover && layer) {
          const l = layer.getBoundingClientRect();
          Object.assign(cover.style, { position: "absolute", left: `${r.left - l.left}px`, top: `${r.top - l.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`, pointerEvents: "auto", background: "rgb(255 0 0 / 0.3)" });
          layer.appendChild(cover);
        }
        const out: string[] = [];
        if (notice && !cover) out.push(`${at}: no notices' layer on the page`);
        for (const item of list.querySelectorAll("[role='menuitem']")) {
          const b = item.getBoundingClientRect();
          const top = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
          if (!top || !item.contains(top)) out.push(`${at}: "${(item.textContent ?? "").slice(0, 20)}" is hidden${cover ? " under the notice" : ""}`);
        }
        cover?.remove();
        return out;
      };
      win.rvttFirstCover = null;
      const opening = new win.MutationObserver(() => {
        const list = document.querySelector(`[role="menu"][aria-label="${name}"]`);
        if (!list) return;
        opening.disconnect();
        win.rvttFirstCover = win.rvttCover!(list).map((line) => `${line} as the list opens`);
      });
      opening.observe(document.body, { childList: true, subtree: true });
    },
    { at, notice, name: VIEW_AS_A_PLAYER },
  );
  await anchor.click();
  const menu = page.getByRole("menu", { name: VIEW_AS_A_PLAYER, exact: true });
  await menu.waitFor();
  const wrong = alignmentLines(await measureAlignment(menu), `the players' list from ${at}`);
  const a = (await anchor.boundingBox())!;
  const m = (await menu.boundingBox())!;
  const below = a.y + a.height / 2 < page.viewportSize()!.height / 2;
  if (below ? m.y < a.y + a.height - 1 : m.y + m.height > a.y + 1) wrong.push(`${at}: the list opens ${below ? "above" : "below"} its button, the side with less room`);
  // As wide as a side panel at most (theme.layout.sidePanelWidth), so a long name wraps there.
  if (m.width > 361) wrong.push(`${at}: the list is ${Math.round(m.width)} px wide`);
  wrong.push(...(await spills(menu, `the players' list from ${at}`)));
  wrong.push(...(await page.evaluate((at) => (globalThis as unknown as { rvttFirstCover?: string[] | null }).rvttFirstCover ?? [`${at}: the list was never seen opening`], at)));
  wrong.push(...(await menu.evaluate((el) => (globalThis as unknown as { rvttCover(list: El): string[] }).rvttCover(el as unknown as El))));
  return wrong;
}

/** Where a token stands in the DM's copy now. */
function cellOf(id: string): { x: number; y: number } {
  const t = sockets.dm.state?.tokens[id];
  assert.ok(t, `no token ${id} in the DM's copy`);
  return { x: t.x, y: t.y };
}

/**
 * Replays every frame a page received from its first, and returns the
 * frames after which its copy broke `rule`, by index, with what it held.
 */
function replay(watch: SocketWatch, rule: (state: RoomState, index: number) => string | null): string[] {
  let state: ProjectedState | null = null;
  const broken: string[] = [];
  watch.received.forEach((text, index) => {
    const frame = JSON.parse(text) as Frame;
    if (frame.t === "snapshot" && frame.state) state = frame.state;
    else if (frame.t === "ev" && frame.changes && state) state = applyChanges(state, frame.changes);
    else return;
    const wrong = rule(state as unknown as RoomState, index);
    if (wrong) broken.push(`frame ${index}: ${wrong}`);
  });
  return broken;
}

describe("raccoon-vtt per-player vision run", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    anaContext = await browser.newContext(phone);
    benContext = await browser.newContext(phone);
    tvContext = await browser.newContext({ viewport: { width: 960, height: 540 } });
    for (const c of [dmContext, benContext]) await c.addInitScript(HOOK_FLAG);
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    ben = await benContext.newPage();
    tv = await tvContext.newPage();
    for (const [page, key] of [[dm, "dm"], [ana, "ana"], [ben, "ben"], [tv, "tv"]] as const) consoles[key].attach(page);
    await sockets.dm.attach(dmContext, dm);
    await sockets.ana.attach(anaContext, ana);
    await sockets.ben.attach(benContext, ben);
    await sockets.tv.attach(tvContext, tv);
    // Before the room loads: Playwright routes only the sockets of a document loaded after the route.
    await routePreviews(dm);
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

  test("pv-0. the DM lays out a dark scene with Day and Night, Ana and Ben join on phones, and a table display pairs", async () => {
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
    await waitFor("the DM's snapshot", () => sockets.dm.state);
    run.sceneId = sockets.dm.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    const day = await upload(await picture([120, 110, 95]));
    const night = await upload(await picture([30, 34, 60]));
    run.nightMap = night.id;
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { name: "Twin halls", bounds: BOUNDS, fogEnabled: true, autoWalls: "off", vision: { on: true, light: "dark" } } });
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: CELL_PX, originPx: { x: 0, y: 0 } } });
    await ops.send({
      t: "scene.update",
      sceneId: run.sceneId,
      patch: {
        phases: [
          { id: run.phases.day, name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
          { id: run.phases.night, name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height, light: "dark" },
        ],
      },
    });
    const wall: EdgeFeature = { kind: "wall" };
    const edges: { key: string; feature: EdgeFeature }[] = [];
    for (let x = 0; x < BOUNDS.w; x++) edges.push({ key: `${x},10,n`, feature: `${x},10,n` === DOOR ? { kind: "door", state: "closed", secret: false, discovered: false } : wall });
    for (let y = 10; y < BOUNDS.h; y++) edges.push({ key: `8,${y},w`, feature: wall });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });

    run.anaId = await join(anaContext, "Ana", "#e5484d");
    run.benId = await join(benContext, "Ben", "#0090ff");
    for (const [page, watch] of [[ana, sockets.ana], [ben, sockets.ben]] as const) {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor(`${watch.label}'s snapshot`, () => watch.state);
    }

    const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
    assert.equal(res.status(), 201, await res.text());
    const { code } = (await res.json()) as { code: string };
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await waitFor("the display's snapshot", () => sockets.tv.state);
    await tv.locator(".konvajs-content").first().waitFor();
  });

  test("pv-1. per player, Ana sees the goblin in Thorn's torchlight and its row, and Ben and the display see neither, Ben's turn line reading Another creature's turn", async () => {
    // The scene goes per player before any creature stands on it, so no ground is explored for the whole party first.
    await pickSight("Per player");
    await waitFor("the scene per player on both phones and the display", () => (has.perPlayer(sockets.ana.state) && has.perPlayer(sockets.ben.state) && has.perPlayer(sockets.tv.state) ? true : null));
    const torch = { bright: 20, dim: 20 };
    await ops.send(creature(run.thornId, "Thorn", THORN_AT, { kind: "pc", disposition: "ally", ownerIds: [run.anaId], light: torch }));
    await ops.send(creature(run.breeId, "Bree", BREE_AT, { kind: "pc", disposition: "ally", ownerIds: [run.benId], light: torch }));
    // Each joins the list the first time they own a creature that sees here.
    await listIs(["Ana on", "Ben on"]);
    await ops.send(creature(run.goblinId, "Goblin", GOBLIN_AT, { disposition: "hostile" }));
    await ops.send({ t: "build.label", sceneId: run.sceneId, labelId: run.labelId, label: { ...LABEL_AT, text: LABEL_TEXT, size: 1 } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: randomUUID(), tokenId: run.goblinId, value: 20 },
        { id: randomUUID(), tokenId: run.thornId, value: 15 },
        { id: randomUUID(), tokenId: run.breeId, value: 10 },
      ],
    });
    await ops.send({ t: "encounter.next" });

    await waitFor("the goblin in Ana's copy", () => has.goblin(sockets.ana.state) || null);
    await turnStrip(ana).and(ana.getByRole("button", { name: /Goblin's turn/ })).waitFor();
    await turnStrip(ben).and(ben.getByRole("button", { name: /Another creature's turn/ })).waitFor();
    // Bree's own torchlight reached Ben's copy, so his view has settled past the goblin's arrival.
    await waitFor("Bree's room on Ben's map", () => has.ground(sockets.ben.state, BREE_CORNER) || null);
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.equal(has.goblin(state), false, `the goblin reached ${who}`);
      assert.equal(state?.encounter?.entries.some((e) => e.tokenId === run.goblinId), false, `the goblin's row reached ${who}`);
    }
    assert.ok(sockets.ana.state?.encounter?.entries.some((e) => e.tokenId === run.goblinId), "Ana has no row for the goblin");
    // Each still sees the other's character, a party member.
    assert.ok(sockets.ben.state?.tokens[run.thornId] && sockets.ana.state?.tokens[run.breeId], "a party member was withheld");
    await shots.take(ana, "pervision-ana-goblin-in-torchlight");
    await shots.take(ben, "pervision-ben-another-creature");
    await shots.take(tv, "pervision-display-shared-sight");
    await shots.take(dm, "pervision-dm-per-player");
  });

  test("pv-2. ground Thorn explores stays under Ben's fog, with the label in it", async () => {
    await waitFor("the label in Ana's copy", () => has.label(sockets.ana.state) || null);
    assert.equal(has.ground(sockets.ana.state, LABEL_CELL), true, "the label's ground is fogged on Ana's map");
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.equal(has.ground(state, LABEL_CELL), false, `the label's ground is open on ${who}'s map`);
      assert.equal(has.ground(state, GOBLIN_AT), false, `the goblin's ground is open on ${who}'s map`);
      assert.equal(has.label(state), false, `the label reached ${who}`);
    }
    // And the other way: Bree's room is Ben's alone.
    assert.equal(has.ground(sockets.ana.state, BREE_CORNER), false, "Bree's room is open on Ana's map");
  });

  test("pv-2b. the DM drags the goblin within Thorn's light: Ana's page gets the drag, and pv-8 finds none of it on Ben's or the display's", async () => {
    const from = sockets.ana.received.length;
    await dragCells(dm, BOUNDS, GOBLIN_AT, GOBLIN_LATER);
    await waitFor("the goblin moved in Ana's copy", () => {
      const g = sockets.ana.state?.tokens[run.goblinId];
      return g?.x === GOBLIN_LATER.x && g.y === GOBLIN_LATER.y ? true : null;
    });
    const dragFrames = sockets.ana.received.slice(from).filter((text) => text.includes('"t":"eph"') && text.includes(run.goblinId));
    assert.ok(dragFrames.length > 0, "Ana's page got no frame of the goblin's drag, so the run never tested the drag's filter");
    // The goblin stays in Thorn's light, so pv-3 to pv-7 meet it as before.
    assert.equal(has.goblin(sockets.ben.state), false, "the goblin reached Ben by the drag");
  });

  test("pv-3. Thorn opens a door on ground Ben never explored: open on Ana's map, not in Ben's copy at all, and open for Ben once Bree sees it", async () => {
    await tapDoor(ana);
    const closed = ana.getByRole("group", { name: "Closed door" });
    await closed.getByRole("button", { name: "Open" }).click();
    await waitFor("the open door in Ana's copy", () => (doorIn(sockets.ana.state)?.kind === "door" && (doorIn(sockets.ana.state) as { state: string }).state === "open" ? true : null));
    await ana.getByRole("group", { name: "Open door" }).waitFor();
    await shots.take(ana, "pervision-ana-door-open");
    await tapAway(ana, { x: 13, y: 3 });

    // Players hold the build only where they have seen it (D-261026-25, docs/design-v1-map-discovery.md rule 1): Ben never
    // explored the door's ground, so his copy holds no door there at all, open or shut. A line every page gets after the
    // opening marks his copy as past it.
    await ops.send({ t: "log.chat", text: DOOR_MARK });
    await waitFor("the line after the opening in Ben's log", () => sockets.ben.state?.log.some((e) => e.text === DOOR_MARK) || null);
    assert.equal(doorIn(sockets.ben.state), undefined, "Ben's copy holds the door on ground he never explored");
    assert.equal(has.ground(sockets.ben.state, DOOR_NORTH) || has.ground(sockets.ben.state, DOOR_SOUTH), false, "the door's ground is open on Ben's map");
    await tapDoor(ben);
    await ben.waitForTimeout(800);
    assert.equal(await ben.getByRole("group", { name: /door$/ }).count(), 0, "Ben's map offered a door it does not draw");
    await shots.take(ben, "pervision-ben-door-unseen");

    await ops.send({ t: "token.move", tokenId: run.breeId, ...BREE_LATER });
    await waitFor("the door's south side on Ben's map", () => has.ground(sockets.ben.state, DOOR_SOUTH) || null);
    await tapDoor(ben);
    await ben.getByRole("group", { name: "Open door" }).waitFor();
    await shots.take(ben, "pervision-ben-door-seen");
    await tapAway(ben, { x: 13, y: 3 });
    // Through the open door Bree sees only the north hall's west edge.
    assert.equal(has.goblin(sockets.ben.state), false, "the goblin reached Ben through the door");
    assert.equal(has.label(sockets.ben.state), false, "the label reached Ben through the door");
  });

  test("pv-4. View as Ben and as Ana each show only that player's view, after the loading line, and no whisper between them", async () => {
    const anaOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(anaContext) });
    try {
      await anaOps.send({ t: "log.whisper", to: [run.benId], text: WHISPER });
    } finally {
      anaOps.close();
    }
    await ops.send({ t: "log.chat", text: "Roll for initiative" });
    await waitFor("the whisper in Ben's log", () => sockets.ben.state?.log.some((e) => e.text === WHISPER) || null);

    for (const [name, memberId, sees] of [["Ben", run.benId, false], ["Ana", run.anaId, true]] as const) {
      const { preview, snapshot } = await viewAs(name);
      try {
        const state = snapshot.state as unknown as RoomState;
        assert.equal(snapshot.you?.memberId, memberId, `the preview of ${name} is someone else's view`);
        assert.equal(snapshot.you?.role, "player");
        assert.equal(has.goblin(state), sees, `the preview of ${name} ${sees ? "lacks" : "holds"} the goblin`);
        assert.equal(has.label(state), sees, `the preview of ${name} ${sees ? "lacks" : "holds"} the label`);
        assert.equal(has.ground(state, BREE_CORNER), !sees, `the preview of ${name} has the wrong map of Bree's room`);
        await turnStrip(preview)
          .and(preview.getByRole("button", { name: sees ? /Goblin's turn/ : /Another creature's turn/ }))
          .waitFor();
        await preview.getByRole("tab", { name: sideTabName("Log") }).waitFor();
        await openSideTab(preview, "Log");
        const log = preview.getByRole("tabpanel", { name: sideTabName("Log") });
        await log.getByText("Roll for initiative").waitFor();
        assert.equal(await log.getByText(WHISPER).count(), 0, `the preview of ${name} shows the whisper`);
        assert.equal(previews.frames.some((f) => f.includes(WHISPER)), false, `a frame of the preview of ${name} carried the whisper`);
        await shots.take(dm, `pervision-preview-${name.toLowerCase()}`);
      } finally {
        await exitPreview(preview);
      }
    }
  });

  test("dp-3a. View as a player whose socket is refused once says it could not load, with Try again, which keeps focus on the wait's status through its loading line and then shows Ana's view", async () => {
    previews.refuse = 1;
    previews.hold = true;
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Ana" });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Ana"]');
    await preview.waitFor();
    try {
      const wait = preview.locator("[data-preview-wait]");
      const status = wait.getByRole("status");
      // The failure is an alert beside the wait's status, never inside it (docs/design-v1-design-pass.md 4.4).
      const failed = wait.getByRole("alert").filter({ hasText: "Could not load what Ana sees." });
      await failed.waitFor();
      assert.equal(await failed.getByText("Close and try again").count(), 0, "the failure still says to close");
      assert.equal(await status.count(), 1, "the wait's status left with the failure");
      assert.equal((await status.innerText()).trim(), "", "the failure speaks through the status");
      assert.deepEqual(alignmentLines(await measureAlignment(wait), "dp-3a failed"), []);
      await shots.take(dm, "dp-3a-preview-failed");

      const retry = failed.getByRole("button", { name: "Try again", exact: true });
      await retry.focus();
      await dm.keyboard.press("Enter");
      const focused = () => status.evaluate((el) => el === el.ownerDocument.activeElement);
      await failed.waitFor({ state: "detached" });
      assert.ok(await focused(), "Try again left focus anywhere but the wait's status");
      await status.filter({ hasText: "Loading what Ana sees…" }).waitFor();
      assert.ok(await focused(), "the loading line took focus from the wait's status");
      await waitFor("the snapshot for Ana's preview, held", () => (previews.queue.length > 0 ? true : null));
      await shots.take(dm, "dp-3a-preview-retry-loading");
      releasePreview();
      await preview.locator(".konvajs-content").first().waitFor();
      const snapshot = previews.frames.map((text) => JSON.parse(text) as Frame).find((f) => f.t === "snapshot");
      assert.equal(snapshot?.you?.memberId, run.anaId, "Try again showed someone else's view");
      // The wait gone, focus stays in the preview rather than fall to the page.
      assert.ok(await preview.evaluate((el) => el.contains(el.ownerDocument.activeElement)), "focus fell out of the preview as its view came");
    } finally {
      previews.refuse = 0;
      previews.hold = false;
      await exitPreview(preview);
    }
  });

  test("va-1. View as from a token: Thorn's bar and his panel's header open Ana's view, his Owners group's eye Ben's, the goblin's bar offers none, and each Exit gives focus back", async () => {
    await dm.keyboard.press("Escape");
    await tapCell(dm, BOUNDS, cellOf(run.goblinId));
    const goblin = dm.getByRole("dialog", { name: "Goblin actions" });
    await goblin.waitFor();
    assert.equal(await goblin.getByRole("button", { name: /^View as/ }).count(), 0, "the goblin, which no player owns, offers View as");
    await dm.keyboard.press("Escape");
    await goblin.waitFor({ state: "detached" });

    await tapCell(dm, BOUNDS, cellOf(run.thornId));
    const bar = dm.getByRole("dialog", { name: "Thorn actions" });
    await bar.waitFor();
    await viewFrom(bar.getByRole("button", { name: "View as Ana", exact: true }), "Ana", run.anaId, "bar");

    await openSideTab(dm, "Token");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("Token") });
    await viewFrom(panel.locator("[data-creature-header]").getByRole("button", { name: "View as Ana", exact: true }), "Ana", run.anaId, "panel-header");
    const owners = panel.getByRole("button", { name: "Owners", exact: true });
    if ((await owners.getAttribute("aria-expanded")) === "false") await owners.click();
    // Every player has an eye there, owner or not, and the DM none.
    assert.equal(await panel.getByRole("button", { name: /^View as Dana/ }).count(), 0, "the DM's own row has an eye");
    await viewFrom(panel.getByRole("button", { name: "View as Ben", exact: true }), "Ben", run.benId, "owners-eye");
    await owners.click();
  });

  test("dp-4a. a creature header's actions row at a desk: View as Ana under Thorn's quick numbers, View as a player under a companion's whose character Ana and Ben play, no row and no gap for the goblin, and Place a token in the same place on the character's page (va-2 measures the page at every size, then removes Ivy and her hawk)", async () => {
    await ops.send({ t: "character.create", character: { id: run.ivyId, name: "Ivy", size: "medium", ownerIds: [run.anaId, run.benId], actor: actor() } });
    await ops.send(creature(run.hawkId, "Hawk", HAWK_AT, { kind: "npc", disposition: "ally", visibility: "dm", companion: { of: run.ivyId, turn: "none" } }));
    await waitFor("Ivy and her hawk in the DM's copy", () => (sockets.dm.state?.characters[run.ivyId] && sockets.dm.state.tokens[run.hawkId] ? true : null));
    const wrong: string[] = [];
    const panelHeader = async (cell: { x: number; y: number }, name: string): Promise<HeaderLayout> => {
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, cell);
      await dm.getByRole("dialog", { name: `${name} actions` }).waitFor();
      await openSideTab(dm, "Token");
      const header = dm.getByRole("tabpanel", { name: sideTabName("Token") }).locator("[data-creature-header]").filter({ has: dm.getByRole("heading", { name, exact: true }) });
      await header.waitFor();
      // The panel keeps where it was scrolled for the token before, so the header is brought into view for the picture.
      await header.scrollIntoViewIfNeeded();
      await shots.take(dm, `dp-4a-panel-${name.toLowerCase()}`);
      return headerLayout(header);
    };
    const goblin = await panelHeader(cellOf(run.goblinId), "Goblin");
    if (goblin.row || goblin.actions.length > 0) wrong.push(`the goblin's header has an actions row: ${JSON.stringify(goblin.actions)}`);
    // One row in the header's grid, so no row gap stands under the numbers either.
    if (goblin.rows !== 1) wrong.push(`the goblin's header lays out ${goblin.rows} rows`);
    const thorn = await panelHeader(cellOf(run.thornId), "Thorn");
    wrong.push(...actionsRowWrong("Thorn's panel", thorn, ["View as Ana"]));
    const hawk = await panelHeader(HAWK_AT, "Hawk");
    wrong.push(...actionsRowWrong("the hawk's panel", hawk, [VIEW_AS_A_PLAYER]));
    const kind = await dm.getByRole("tabpanel", { name: sideTabName("Token") }).locator("[data-kind-line]").innerText();
    assert.match(kind, /^Companion of Ivy · /, "the hawk's kind line");
    await dm.keyboard.press("Escape");

    // The page draws its row where the panel does: as far under the numbers, from the same edge.
    await openSideTab(dm, "Characters");
    const characters = dm.getByRole("tabpanel", { name: sideTabName("Characters") });
    await characters.locator(`[data-opener="character:${run.ivyId}"]`).click();
    const header = characters.locator("[data-creature-header]").filter({ has: dm.getByRole("heading", { name: "Ivy", exact: true }) });
    await header.waitFor();
    const page = await headerLayout(header);
    wrong.push(...actionsRowWrong("Ivy's page", page, ["Place a token"]));
    if (page.row && page.numbers && thorn.row && thorn.numbers) {
      const under = (l: HeaderLayout) => l.row!.top - l.numbers!.bottom;
      if (Math.abs(under(page) - under(thorn)) > 1) wrong.push(`Ivy's page sets its row ${under(page).toFixed(1)} px under the numbers, the panel ${under(thorn).toFixed(1)}`);
    }
    await shots.take(dm, "dp-4a-page-ivy");
    // In the panel's own header, outside its tab panel.
    await dm.getByRole("button", { name: "Back to Characters" }).click();
    assert.deepEqual(wrong, []);
  });

  test("va-2. Thorn's bar, its Read more row with View as Ana, his panel's header and Ivy's page's header with Place a token (dp-4a's) measure true at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const sizes = [
      { name: "1440x900", width: 1440, height: 900, touch: false },
      { name: "390x844", width: 390, height: 844, touch: true },
      { name: "320x568", width: 320, height: 568, touch: true },
    ];
    const off: string[] = [];
    const storageState = await dmContext.storageState();
    try {
      for (const size of sizes) {
        for (const scale of [1, 1.3]) {
          const at = `${size.name} at ${Math.round(scale * 100)}%`;
          // A context of the size's kind, so a phone lays out with touch as Ana's and Ben's do. One at a time, closed after.
          const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.touch, hasTouch: size.touch, storageState });
          try {
            await context.addInitScript((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
            const page = await context.newPage();
            await page.goto(`${server.origin}/r/${run.roomId}`);
            await page.getByRole("status", { name: "Connected" }).first().waitFor();
            await page.locator(".konvajs-content").first().waitFor();
            // Ivy's page first, in the same load, since every load takes a snapshot from the DM's budget, which va-3's previews need after it.
            const ivy = await ivysPage(page, size.width >= 900);
            off.push(...actionsRowWrong(`Ivy's page at ${at}`, await headerLayout(ivy), ["Place a token"]));
            off.push(...alignmentLines(await measureAlignment(ivy), `Ivy's page header at ${at}`), ...(await spills(ivy, `Ivy's page header at ${at}`)));
            await shots.take(page, `dp-4a-page-${size.name}-${Math.round(scale * 100)}`);
            await leavePage(page, size.width >= 900);
            await tapCell(page, BOUNDS, cellOf(run.thornId));
            const bar = page.getByRole("dialog", { name: "Thorn actions" });
            await bar.waitFor();
            await expandBar(bar);
            const readMore = bar.getByRole("group", { name: "Read more" });
            await readMore.getByRole("button", { name: "View as Ana", exact: true }).scrollIntoViewIfNeeded();
            off.push(...alignmentLines(await measureAlignment(bar), `Thorn's bar at ${at}`));
            off.push(...alignmentLines(await measureAlignment(readMore), `Thorn's Read more at ${at}`));
            await shots.take(page, `viewas-bar-${size.name}-${Math.round(scale * 100)}`);
            await bar.getByRole("button", { name: "Details", exact: true }).first().click();
            const header = page.locator("[data-token-panel] [data-creature-header]").filter({ has: page.getByRole("button", { name: "View as Ana", exact: true }) });
            await header.waitFor();
            off.push(...actionsRowWrong(`Thorn's panel at ${at}`, await headerLayout(header), ["View as Ana"]));
            off.push(...alignmentLines(await measureAlignment(header), `Thorn's panel header at ${at}`));
            await shots.take(page, `viewas-panel-${size.name}-${Math.round(scale * 100)}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await ops.send({ t: "token.delete", tokenId: run.hawkId });
      await ops.send({ t: "character.delete", characterId: run.ivyId });
    }
    assert.deepEqual(off, []);
  });

  test("pv-5. a Night phase switch keeps the scene per player", async () => {
    await dm.getByLabel("Map phase").selectOption({ label: "Night" });
    await waitFor("Night in the DM's copy", () => (sockets.dm.state?.scenes[run.sceneId]?.phaseId === run.phases.night ? true : null));
    await waitFor("Night's map on Ben's phone", () => (sockets.ben.state?.scenes[run.sceneId]?.map?.assetId === run.nightMap ? true : null));
    for (const [who, watch] of Object.entries(sockets)) assert.equal(has.perPlayer(watch.state), true, `${who}'s copy lost Per player`);
    await openSideTab(dm, "Scenes");
    assert.equal(await scenesPanel().getByRole("radiogroup", { name: "Sight" }).getByRole("radio", { name: "Per player" }).isChecked(), true, "the Sight row left Per player");
    assert.equal(has.goblin(sockets.ben.state), false, "the goblin reached Ben at Night");
    assert.equal(has.goblin(sockets.ana.state), true, "Ana lost the goblin at Night");
  });

  test("pv-6. the DM unticks Ana and ticks Cy, a third player: the list and the maps follow", async () => {
    const cyContext = await browser.newContext();
    try {
      run.cyId = await join(cyContext, "Cy", "#46a758");
    } finally {
      await cyContext.close();
    }
    await openSideTab(dm, "Scenes");
    const list = scenesPanel().getByRole("group", { name: "Who sees for themselves" });
    const box = (name: string) => list.getByRole("checkbox", { name });
    await waitFor("Cy in the list, unticked", async () => ((await box("Cy").count()) === 1 && !(await box("Cy").isChecked()) ? true : null));
    await box("Ana").click();
    const question = list.getByRole("group", { name: "Untick Ana?" });
    await question.getByRole("button", { name: "Untick", exact: true }).click();
    await question.waitFor({ state: "detached" });
    await listIs(["Ana off", "Ben on"]);
    await box("Cy").click();
    await listIs(["Ana off", "Ben on", "Cy on"]);
    await list.getByText("Ana sees only what creatures that share sight see here.").waitFor();
    await list.scrollIntoViewIfNeeded();
    await shots.take(dm, "pervision-dm-list-ana-off-cy-on");

    // Ana forgets her map of the scene and sees only what shares sight, which here is nothing.
    await waitFor("the goblin gone from Ana's copy", () => (has.goblin(sockets.ana.state) ? null : true));
    await waitFor("the label gone from Ana's copy", () => (has.label(sockets.ana.state) ? null : true));
    assert.equal(has.ground(sockets.ana.state, LABEL_CELL), false, "Ana's map kept the north hall");
    await turnStrip(ana).and(ana.getByRole("button", { name: /Another creature's turn/ })).waitFor();
    await shots.take(ana, "pervision-ana-unticked");
    // Ben's place and map stay as they were.
    assert.equal(has.ground(sockets.ben.state, BREE_CORNER), true, "Ben lost his map");
    assert.equal(has.goblin(sockets.ben.state), false);
  });

  test("pv-7. Whole party pools the maps, and back to Per player they stay pooled", async () => {
    run.pooledAt = { ben: sockets.ben.received.length, tv: sockets.tv.received.length };
    await pickSight("Whole party");
    await waitFor("the list emptied", () => (holderList().length === 0 ? true : null));
    // Bree's corner, which only Ben's own map held, is on Ana's map now, and the north hall Thorn sees on Ben's.
    await waitFor("Bree's corner on Ana's map", () => has.ground(sockets.ana.state, BREE_CORNER) || null);
    await waitFor("the label on Ben's map", () => has.label(sockets.ben.state) || null);
    assert.equal(has.goblin(sockets.ben.state), true, "the whole party's sight left the goblin out of Ben's copy");
    await shots.take(ben, "pervision-ben-whole-party");

    await pickSight("Per player");
    await listIs(["Ana on", "Ben on"]);
    await waitFor("the goblin gone from Ben's copy", () => (has.goblin(sockets.ben.state) ? null : true));
    await waitFor("the goblin back in Ana's copy", () => has.goblin(sockets.ana.state) || null);
    assert.equal(has.ground(sockets.ana.state, BREE_CORNER), true, "Ana's map lost Bree's corner");
    assert.equal(has.ground(sockets.ben.state, LABEL_CELL), true, "Ben's map lost the north hall");
    assert.equal(has.label(sockets.ben.state), true, "the label left Ben's pooled map");
    await shots.take(ben, "pervision-ben-pooled");
    await shots.take(ana, "pervision-ana-pooled");
  });

  test("va-3. a token with two player owners lists them from its bar and its panel's header, at 1440 x 900 on the side with room and over a notice, and in a phone's sheet, measured, an unbroken 80-letter name inside every control, and Ben picked shows Ben's view", async () => {
    const longContext = await browser.newContext();
    try {
      run.longId = await join(longContext, LONG_NAME, "#ffb224");
    } finally {
      await longContext.close();
    }
    await ops.send(creature(run.muleId, "Pack mule", MULE_AT, { kind: "npc", disposition: "ally", visibility: "dm", ownerIds: [run.benId, run.longId] }));
    await ops.send(creature(run.wagonId, "Wagon", WAGON_AT, { kind: "npc", disposition: "ally", visibility: "dm", ownerIds: [run.longId] }));
    await waitFor("the mule, the wagon and their player in the DM's copy", () => (sockets.dm.state?.tokens[run.muleId] && sockets.dm.state.tokens[run.wagonId] && sockets.dm.state.members[run.longId] ? true : null));
    const wrong: string[] = [];

    await dm.setViewportSize({ width: 1440, height: 900 });
    try {
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, MULE_AT);
      const bar = dm.getByRole("dialog", { name: "Pack mule actions" });
      await bar.waitFor();
      await expandBar(bar);
      const fromBar = bar.getByRole("group", { name: "Read more" }).getByRole("button", { name: VIEW_AS_A_PLAYER, exact: true });
      wrong.push(...(await openPlayers(dm, fromBar, "the bar at 1440 x 900", true)));
      await shots.take(dm, "viewas-list-bar-1440x900");
      const savedView = await dm.evaluate((id) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(`rvtt.view.${id}`), run.roomId);
      await dm.getByRole("menuitem", { name: "Ben", exact: true }).click();
      // FU39-B: the hook changes the preview's memory, leaving the DM's pick and turns saved as they were.
      const preview = dm.locator('dialog[aria-label="Viewing as Ben"]');
      await preview.locator(".konvajs-content").first().waitFor();
      await dm.evaluate(() => {
        const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
        hook.pick("isometric");
        hook.turn(2);
      });
      const previewView = preview.getByRole("button", { name: "View: Isometric", exact: true });
      await previewView.waitFor();
      await waitFor("FU39-B: the preview turned halfway", async () => ((await previewView.locator("svg").evaluate((el) => (el as unknown as { style: { transform: string } }).style.transform)) === "scale(-1, -1)" ? true : null));
      assert.equal(await dm.evaluate((id) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(`rvtt.view.${id}`), run.roomId), savedView, "FU39-B: preview hook overwrote the DM's view");
      // The shared preview check measures the Top-down stage, kept at zero size in Isometric.
      await dm.evaluate(() => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick("topDown"));
      await preview.getByRole("button", { name: "View: Top-down", exact: true }).waitFor();
      await previewShows("Ben", run.benId, "bar's list", fromBar);

      await openSideTab(dm, "Token");
      const panel = dm.getByRole("tabpanel", { name: sideTabName("Token") });
      const fromHeader = panel.locator("[data-creature-header]").getByRole("button", { name: VIEW_AS_A_PLAYER, exact: true });
      wrong.push(...(await openPlayers(dm, fromHeader, "the panel header at 1440 x 900", false)));
      await shots.take(dm, "viewas-list-panel-1440x900");
      await dm.getByRole("menuitem", { name: "Ben", exact: true }).click();
      await previewShows("Ben", run.benId, "panel header's list", fromHeader);
      await dm.keyboard.press("Escape");
    } finally {
      await dm.setViewportSize({ width: 1280, height: 800 });
    }

    const storageState = await dmContext.storageState();
    for (const size of [
      { name: "390x844", width: 390, height: 844 },
      { name: "320x568", width: 320, height: 568 },
    ]) {
      for (const scale of [1, 1.3]) {
        const at = `${size.name} at ${Math.round(scale * 100)}%`;
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState });
        try {
          await context.addInitScript((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
          const page = await context.newPage();
          await page.goto(`${server.origin}/r/${run.roomId}`);
          await page.getByRole("status", { name: "Connected" }).first().waitFor();
          await page.locator(".konvajs-content").first().waitFor();

          await tapCell(page, BOUNDS, MULE_AT);
          const bar = page.getByRole("dialog", { name: "Pack mule actions" });
          await bar.waitFor();
          await expandBar(bar);
          const opener = bar.getByRole("group", { name: "Read more" }).getByRole("button", { name: VIEW_AS_A_PLAYER, exact: true });
          await opener.scrollIntoViewIfNeeded();
          await opener.click();
          const sheet = page.getByRole("dialog", { name: VIEW_AS_A_PLAYER, exact: true });
          await sheet.waitFor();
          wrong.push(...alignmentLines(await measureAlignment(sheet), `the players' sheet at ${at}`), ...(await spills(sheet, `the players' sheet at ${at}`)));
          await shots.take(page, `viewas-sheet-${size.name}-${Math.round(scale * 100)}`);
          if (size.width === 390 && scale === 1) {
            await sheet.getByRole("menuitem", { name: "Ben", exact: true }).click();
            const preview = page.locator('dialog[aria-label="Viewing as Ben"]');
            await preview.waitFor();
            await exitPreview(preview);
            await waitFor(`focus back on View as a player at ${at}`, () => opener.evaluate((el) => el === el.ownerDocument.activeElement || null));
          } else {
            await page.keyboard.press("Escape");
            await sheet.waitFor({ state: "detached" });
          }
          await page.keyboard.press("Escape");
          await bar.waitFor({ state: "detached" });

          await tapCell(page, BOUNDS, WAGON_AT);
          const wagon = page.getByRole("dialog", { name: "Wagon actions" });
          await wagon.waitFor();
          await expandBar(wagon);
          const readMore = wagon.getByRole("group", { name: "Read more" });
          await readMore.getByRole("button", { name: `View as ${LONG_NAME}`, exact: true }).scrollIntoViewIfNeeded();
          wrong.push(...alignmentLines(await measureAlignment(readMore), `the wagon's Read more at ${at}`), ...(await spills(readMore, `the wagon's Read more at ${at}`)));
          await shots.take(page, `viewas-long-bar-${size.name}-${Math.round(scale * 100)}`);
          await wagon.getByRole("button", { name: "Details", exact: true }).first().click();
          const header = page.locator("[data-token-panel] [data-creature-header]").filter({ has: page.getByRole("button", { name: `View as ${LONG_NAME}`, exact: true }) });
          await header.waitFor();
          wrong.push(...alignmentLines(await measureAlignment(header), `the wagon's panel header at ${at}`), ...(await spills(header, `the wagon's panel header at ${at}`)));
          await shots.take(page, `viewas-long-panel-${size.name}-${Math.round(scale * 100)}`);
        } finally {
          await context.close();
        }
      }
    }
    await ops.send({ t: "token.delete", tokenId: run.muleId });
    await ops.send({ t: "token.delete", tokenId: run.wagonId });
    assert.deepEqual(wrong, []);
  });

  test("FU38-B: Attach stays above notices when a closed View as list mounts and unmounts", async () => {
    const id = randomUUID();
    const lantern = randomUUID();
    await ops.send(creature(lantern, "FU38 lantern", { x: 13, y: 1 }, { kind: "object", size: "tiny", visibility: "dm" }));
    // Attach lists what the selected token can carry, so select the porter beside the lantern.
    await ops.send(creature(id, "FU38 porter", MULE_AT, { kind: "npc", disposition: "ally", visibility: "dm", ownerIds: [run.benId, run.anaId] }));
    try {
      await waitFor("FU38-B Attach fixtures in the DM's copy", () => sockets.dm.state?.tokens[id] && sockets.dm.state.tokens[lantern] ? true : null);
      await dm.setViewportSize({ width: 1440, height: 900 });
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, MULE_AT);
      const bar = dm.getByRole("dialog", { name: "FU38 porter actions", exact: true });
      await bar.waitFor();
      await expandBar(bar);
      const readMore = bar.getByRole("group", { name: "Read more", exact: true });
      await readMore.getByRole("button", { name: VIEW_AS_A_PLAYER, exact: true }).waitFor();
      await watchNoticeCover(dm, "Attach FU38 porter");
      await bar.getByRole("button", { name: "Attach", exact: true }).click();
      const list = dm.getByRole("dialog", { name: "Attach FU38 porter", exact: true });
      await list.getByRole("button", { name: "Carry FU38 lantern", exact: true }).waitFor();
      await assertNoticeCover(dm);
      for (const ownerIds of [[run.benId], [run.benId, run.anaId]]) {
        await ops.send({ t: "token.update", tokenId: id, patch: { ownerIds } });
        await readMore.getByRole("button", { name: ownerIds.length === 1 ? "View as Ben" : VIEW_AS_A_PLAYER, exact: true }).waitFor();
        await assertNoticeCover(dm);
      }
      assert.deepEqual(alignmentLines(await measureAlignment(list), "FU38-B Attach"), []);
    } finally {
      await dm.keyboard.press("Escape");
      await ops.send({ t: "token.delete", tokenId: id });
      await ops.send({ t: "token.delete", tokenId: lantern });
      await dm.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("FU38-B: View as stays above notices when a closed Attach list unmounts and mounts", async () => {
    const id = randomUUID();
    const holder = randomUUID();
    await ops.send(creature(holder, "FU38 porter", { x: 13, y: 1 }, { kind: "npc", visibility: "dm" }));
    await ops.send(creature(id, "FU38 lantern", MULE_AT, { kind: "object", size: "tiny", visibility: "dm", ownerIds: [run.benId, run.anaId] }));
    try {
      await waitFor("FU38-B View as fixtures in the DM's copy", () => sockets.dm.state?.tokens[id] && sockets.dm.state.tokens[holder] ? true : null);
      await dm.setViewportSize({ width: 1440, height: 900 });
      await dm.keyboard.press("Escape");
      await tapCell(dm, BOUNDS, { x: MULE_AT.x - 0.25, y: MULE_AT.y - 0.25 });
      const bar = dm.getByRole("dialog", { name: "FU38 lantern actions", exact: true });
      await bar.waitFor();
      await expandBar(bar);
      await bar.getByRole("button", { name: "Attach", exact: true }).waitFor();
      const fromBar = bar.getByRole("group", { name: "Read more", exact: true }).getByRole("button", { name: VIEW_AS_A_PLAYER, exact: true });
      await watchNoticeCover(dm, VIEW_AS_A_PLAYER);
      assert.deepEqual(await openPlayers(dm, fromBar, "FU38-B View as", true), []);
      const list = dm.getByRole("menu", { name: VIEW_AS_A_PLAYER, exact: true });
      await list.waitFor();
      await assertNoticeCover(dm);
      await ops.send({ t: "token.attach", tokenId: id, to: holder, kind: "carry", x: 13, y: 1, elevation: 0 });
      await bar.getByRole("button", { name: "Put down", exact: true }).waitFor();
      await bar.getByRole("button", { name: "Attach", exact: true }).waitFor({ state: "detached" });
      await assertNoticeCover(dm);
      // Put down preserves the carried object's position. Only Get off accepts a destination.
      await ops.send({ t: "token.detach", tokenId: id });
      await bar.getByRole("button", { name: "Attach", exact: true }).waitFor();
      await assertNoticeCover(dm);
      assert.deepEqual(alignmentLines(await measureAlignment(list), "FU38-B View as"), []);
    } finally {
      await dm.keyboard.press("Escape");
      await ops.send({ t: "token.delete", tokenId: id });
      await ops.send({ t: "token.delete", tokenId: holder });
      await dm.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("FU38-B: the top bar's View popover stands over notices as it opens", async () => {
    await dm.setViewportSize({ width: 1440, height: 900 });
    try {
      await dm.keyboard.press("Escape");
      await watchNoticeCover(dm, "View");
      await dm.getByRole("button", { name: /^View: / }).click();
      const list = dm.getByRole("dialog", { name: "View", exact: true });
      await list.waitFor();
      await assertNoticeCover(dm);
      assert.deepEqual(alignmentLines(await measureAlignment(list), "FU38-B View"), []);
    } finally {
      await dm.keyboard.press("Escape");
      await dm.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("pv-7b. in Isometric, per player: the DM's goblin on ground the party explored stands bright and a creature on ground nobody explored dims, and Ben's page stands neither (ISO5P2-FV-4)", async () => {
    // The pool left the goblin's ground in the party's explored layer, which the DM's map draws beside the DM's own (D-261026-18).
    const imp = randomUUID();
    await ops.send(creature(imp, "Imp", NOBODY_AT, { disposition: "hostile" }));
    try {
      await waitFor("the imp in the DM's copy", () => (sockets.dm.state?.tokens[imp] ? true : null));
      const dmState = sockets.dm.state!;
      assert.equal(isCellFullyFogged(dmState.exploredTiles, run.sceneId, GOBLIN_LATER), false, "the goblin's ground is not in the party's explored layer");
      assert.equal(isCellFullyFogged(dmState.exploredTiles, run.sceneId, NOBODY_AT) && isCellFullyFogged(dmState.fogTiles, run.sceneId, NOBODY_AT), true, "someone revealed the imp's ground");

      await pickView(dm, "isometric");
      await pickView(ben, "isometric");
      await waitFor("the DM's imp dimmed", async () => {
        const n = await isoNode(dm, imp);
        return n?.as === "standee" && n.opacity === 0.5 ? true : null;
      });
      assert.deepEqual(await isoNode(dm, run.goblinId), { as: "standee", opacity: 1 }, "the DM's goblin on explored ground");
      await shots.take(dm, "pervision-dm-isometric-goblin-bright-imp-dim");

      // Ben's own Bree stands in her light, so his board is up and drawn, and neither creature reached his page to stand or lie flat.
      await waitFor("Bree standing on Ben's board", async () => ((await isoNode(ben, run.breeId))?.as === "standee" ? true : null));
      assert.equal(has.goblin(sockets.ben.state) || sockets.ben.state?.tokens[imp] !== undefined, false, "a creature Ben does not see reached his copy");
      for (const [name, id] of [["goblin", run.goblinId], ["imp", imp]] as const) assert.equal(await isoNode(ben, id), null, `Ben's board draws the ${name}`);
      await shots.take(ben, "pervision-ben-isometric");
    } finally {
      for (const page of [dm, ben]) await pickView(page, "follow");
      await ops.send({ t: "token.delete", tokenId: imp });
    }
  });

  test("LP25-B-VIEWAS-2. a wait the server names for the preview's snapshot, as past the snapshot budget, keeps View as a player loading past design 7.4's 10 s, with no failure and no Try again, and the snapshot as the wait runs out shows Ana's view (D-261029-150)", async () => {
    previews.hold = true;
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Ana" });
    const opened = Date.now();
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Ana"]');
    await preview.waitFor();
    try {
      const wait = preview.locator("[data-preview-wait]");
      await wait.getByRole("status").filter({ hasText: "Loading what Ana sees…" }).waitFor();
      // The server's word as server/rooms/actor.ts #delaySnapshot sends it, while the held snapshot stands for the one it delays.
      await waitFor("the preview's socket", () => previews.socket);
      previews.socket!.send(JSON.stringify({ t: "wait", ms: 15_000 }));
      await dm.waitForTimeout(Math.max(0, opened + 11_500 - Date.now()));
      assert.equal(await wait.getByRole("alert").count(), 0, "the preview failed while the server counted down its wait");
      assert.equal(await preview.getByRole("button", { name: "Try again" }).count(), 0, "Try again was offered while the server counted down its wait");
      assert.equal((await wait.getByRole("status").innerText()).trim(), "Loading what Ana sees…");
      await shots.take(dm, "lp25-b-viewas-2-server-wait");
      releasePreview();
      await preview.locator(".konvajs-content").first().waitFor();
      const snapshot = previews.frames.map((text) => JSON.parse(text) as Frame).find((f) => f.t === "snapshot");
      assert.equal(snapshot?.you?.memberId, run.anaId, "the wait ended in someone else's view");
    } finally {
      previews.hold = false;
      await exitPreview(preview);
    }
  });

  test("pv-8. no frame Ben's page or the display received held or named the goblin, its row or a list or layer while per player, or the label before the pool, and no page logged an error", () => {
    for (const [who, watch, pooledAt] of [["Ben", sockets.ben, run.pooledAt.ben], ["the display", sockets.tv, run.pooledAt.tv]] as const) {
      assert.ok(pooledAt > 0, "pv-7 never ran");
      let perPlayer = 0;
      const broken = replay(watch, (state, index) => {
        if (has.perPlayer(state)) perPlayer++;
        if (has.perPlayer(state) && has.goblin(state)) return "the goblin, per player";
        if (has.perPlayer(state) && state.encounter?.entries.some((e) => e.tokenId === run.goblinId)) return "the goblin's row, per player";
        if (index < pooledAt && has.label(state)) return "the label, before the pool";
        return null;
      });
      assert.deepEqual(broken, [], `${who}'s page`);
      // So the rule above judged copies of a per-player scene, not only whole-party ones.
      assert.ok(perPlayer > 5, `${who}'s page held a per-player scene after only ${perPlayer} frames`);
      // Every frame as sent, of every kind, drag frames, rows and log lines included. Before the pool the goblin never
      // reached this page, so not even a deletion may name it, and the label's words never did. And no frame ever holds
      // what reaches DMs only (design section 9, rule 3), read from the parsed frame so a snapshot's properties, an event's
      // keys and an ephemeral payload all count (review PV5-ASTRA-5).
      const named = watch.received.flatMap((text, index) => {
        const found: string[] = [];
        if (index < pooledAt && text.includes(run.goblinId)) found.push("the goblin's id");
        if (index < pooledAt && text.includes(LABEL_TEXT)) found.push("the label's words");
        const frame = JSON.parse(text) as Frame;
        found.push(...privateFieldsIn(frame));
        return found.length > 0 ? [`frame ${index} (${frame.t}): ${found.join(", ")}`] : [];
      });
      assert.deepEqual(named, [], `${who}'s page`);
    }
    for (const c of Object.values(consoles)) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
