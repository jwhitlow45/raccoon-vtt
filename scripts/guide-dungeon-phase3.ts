/**
 * The DM guide's pictures of the dungeon generator's phase 3 (docs/dm-guide.md,
 * "Generating a dungeon" and "Adding a wing", docs/design/design-v1-dungeon-generator.md
 * phase 3), taken from the real server on the production build so they
 * always show the app as it is:
 *
 * - dungeon-room-panel.webp: Generate a dungeon on squares with a room's
 *   panel open in place of the choices, its height raised 5 ft.
 * - dungeon-hex.webp: the same dialog on Hex rows, the preview drawn in wall
 *   lines, with Theme's line for hexes and Size counting hexes and rows.
 * - dungeon-wing.webp: Add a wing on a scene with one hall, the side panel
 *   hidden, the wing pane docked beside the map and the ghost of the planned
 *   wing in its area.
 *
 * The dialog's seeds are fixed, so the same app version draws the same
 * dungeons each time the pictures are made again. The wing pane draws a new
 * seed each time it opens, so its picture shows whichever wing it plans.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the three pictures to docs/dm-guide/ at 1280 x 800, as the
 * guide's other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-dungeon-phase3.ts
 *
 * GUIDE_COPY_DIR, when set, also gets each picture as guide-<name>.png, which
 * it never overwrites, for looking at the pictures at full quality.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { versionChar } from "../client/features/dungeon/seed.ts";
import { OpSocket, openSideTab, pagePoint, pickOption, pickTool, ROOT, sideTabName, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;
/** The seed of the guide's other dungeon pictures, so the room panel opens on the dungeon they show. */
const SEED = `${versionChar()}K7Q-H2MX-A9F3-TWQ5`;
const HEX_SEED = `${versionChar()}SD0-BPEJ-DMYA-EJ6R`;
/** The Keep: one hall at the top, open ground below it for the wing, so the pane docked at a side leaves the hall in view. */
const KEEP = { w: 60, h: 40 };
const HALL = { x: 23, y: 5, w: 14, h: 8 };
const AREA = { from: { x: 12.5, y: 16.5 }, to: { x: 47.5, y: 38.5 } };
/** The middle of the hall's south wall, the automatic wall the wing joins. */
const JOIN = { x: HALL.x + HALL.w / 2 + 0.5, y: HALL.y + HALL.h };
const THEMES = ["Dungeon", "Crypt", "Mine", "Sewer"];

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(1000);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
  if (COPY_DIR !== undefined) {
    mkdirSync(COPY_DIR, { recursive: true });
    // "wx" fails on a file already there, so an earlier picture is never overwritten.
    writeFileSync(path.join(COPY_DIR, `guide-${name}.png`), png, { flag: "wx" });
  }
}

/** What `cleanEdges` reads of the page, typed here since this file is typed without the DOM. */
type Box = { top: number; bottom: number; height: number };
type El = {
  parentElement: El | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientTop: number;
  tagName: string;
  childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
  querySelectorAll(selector: string): ArrayLike<El>;
  getBoundingClientRect(): Box;
};

/**
 * Scrolls the list holding `targets` by the least that leaves no line of text
 * or control cut by its top or bottom edge, with every target in view, and
 * says whether it found such a place, so a picture never shows half a line.
 */
async function cleanEdges(targets: Locator[], range: [number, number]): Promise<boolean> {
  const handles = await Promise.all(targets.map((t) => t.elementHandle()));
  return targets[0]!.page().evaluate(
    ([els, lo, hi]) => {
      const style = (globalThis as unknown as { getComputedStyle(e: El): { overflowY: string } }).getComputedStyle;
      const list = els as unknown as El[];
      let scroller = list[0]!.parentElement;
      while (scroller && !(/(auto|scroll)/.test(style(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
      if (!scroller) return true;
      const start = scroller.scrollTop;
      const leaves = Array.from(scroller.querySelectorAll("*")).filter((e) => ["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(e.tagName) || Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== ""));
      const shifts: number[] = [];
      for (let d = 0; d <= Math.max(-lo, hi); d++) {
        if (d <= hi) shifts.push(d);
        if (d > 0 && -d >= lo) shifts.push(-d);
      }
      for (const d of shifts) {
        const want = start + d;
        if (want < 0 || want > scroller.scrollHeight - scroller.clientHeight) continue;
        scroller.scrollTop = want;
        const top = scroller.getBoundingClientRect().top + scroller.clientTop;
        const bottom = top + scroller.clientHeight;
        const inView = list.every((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= top && r.bottom <= bottom;
        });
        if (!inView) continue;
        const cut = leaves.some((e) => {
          const r = e.getBoundingClientRect();
          return r.height > 0 && ((r.top < top - 0.5 && r.bottom > top + 0.5) || (r.top < bottom - 0.5 && r.bottom > bottom + 0.5));
        });
        if (!cut) return true;
      }
      scroller.scrollTop = start;
      return false;
    },
    [handles, range[0], range[1]] as const,
  );
}

/** The status line at the dialog's foot once the preview for its seed stands, read when it holds still. */
async function settled(dialog: Locator): Promise<string> {
  const line = dialog.locator("footer [aria-live=polite]:not([aria-busy=true])");
  await line.waitFor({ timeout: 30_000 });
  let last = "";
  await waitFor("the status line to hold still", async () => {
    const now = ((await line.innerText().catch(() => "")) || "").trim();
    const still = now === last && now !== "";
    last = now;
    return still ? now : null;
  });
  return last;
}

/** New scene's Builder form on a grid, then Generate a dungeon on a seed, once its preview has drawn. */
async function openDialog(page: Page, grid: "Squares" | "Hex rows", name: string, seed: string): Promise<Locator> {
  await openSideTab(page, "Scenes");
  const panel = page.getByRole("tabpanel", { name: sideTabName("Scenes") });
  const form = panel.getByRole("heading", { name: "New scene", exact: true }).locator("xpath=ancestor::*[self::section or @data-panel-group][1]");
  await form.getByRole("radio", { name: "Builder", exact: true }).click();
  await form.getByRole("radiogroup", { name: "Grid", exact: true }).getByRole("radio", { name: grid, exact: true }).check();
  await form.getByRole("textbox", { name: "Scene name" }).fill(name);
  await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Generate a dungeon" });
  await dialog.getByRole("textbox", { name: "Seed", exact: true }).fill(seed);
  await dialog.getByRole("img", { name: /^Preview of the dungeon: / }).waitFor({ timeout: 30_000 });
  console.log(`${grid}: ${await settled(dialog)}`);
  return dialog;
}

async function closeDialog(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-dungeon3-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
let ops: OpSocket | null = null;
const dmContext = await browser.newContext({ viewport: WINDOW });
try {
  const origin = server.origin;
  const dm = await dmContext.newPage();
  const dmSocket = new SocketWatch("dm");
  await dmSocket.attach(dmContext, dm);

  await dm.goto(`${origin}/`);
  await dm.getByLabel("Room name").fill(roomName);
  await dm.getByLabel("Your name").fill("Dana the DM");
  await dm.getByRole("button", { name: "Create room" }).click();
  await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await dm.locator("code").first().textContent()) ?? "";
  roomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)![1]!.replace("-", "");
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();
  await waitFor("the DM's snapshot", () => dmSocket.state);
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  // A room's panel with its height raised, the first room from 2 on whose raise holds and whose panel ends on a whole line below its heading.
  const squares = await openDialog(dm, "Squares", "Sunken halls", SEED);
  await squares.getByRole("button", { name: "Edit rooms", exact: true }).click();
  await squares.getByRole("region", { name: "Room 1", exact: true }).waitFor();
  let raised = 0;
  for (let n = 2; n <= 12 && raised === 0; n++) {
    await squares.getByRole("button", { name: "Next room", exact: true }).click();
    const room = squares.getByRole("region", { name: `Room ${n}`, exact: true });
    await room.waitFor();
    await room.getByRole("radio", { name: "Raised 5 ft", exact: true }).check();
    await settled(squares);
    const heading = room.getByRole("heading", { name: `Room ${n}`, exact: true });
    const held = (await room.getByText("No room for its stairs, so it stays flat.").count()) === 0;
    if (held && (await cleanEdges([heading, room.getByRole("radio", { name: "Raised 5 ft", exact: true })], [-40, 40]))) raised = n;
    else {
      await room.getByRole("button", { name: "Reset room", exact: true }).click();
      await settled(squares);
    }
  }
  if (raised === 0) throw new Error("no room's panel ends on a whole line");
  console.log(`room panel: room ${raised}`);
  await picture(dm, "dungeon-room-panel");
  await closeDialog(squares);

  // A dungeon on Hex rows, the choices from Theme down.
  const hex = await openDialog(dm, "Hex rows", "Hive halls", HEX_SEED);
  const hexNote = hex.getByText("On hexes rooms are drawn with wall lines: no painted floors, and rubble and water are difficult ground.", { exact: true });
  await hexNote.waitFor();
  // Typing the seed scrolled the choices to its field, so bring Theme, the first choice, back to the top.
  const themeName = hex.getByText("Theme", { exact: true }).first();
  await themeName.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
  if (!(await cleanEdges([themeName, hexNote], [-80, 80]))) throw new Error("the hex choices cut a line");
  await picture(dm, "dungeon-hex");
  await closeDialog(hex);

  // The Keep, with fog as a scene in play has it: one hall, and open ground below it.
  const keep = randomUUID();
  await ops.send({ t: "scene.create", scene: { id: keep, name: "Keep", bounds: KEEP, fogEnabled: true } });
  await ops.send({ t: "build.rect", sceneId: keep, terrain: "stone", ...HALL });
  await waitFor("the Keep", () => (dmSocket.state?.scenes[keep] ? true : null));
  await openSideTab(dm, "Scenes");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  await panel.getByRole("button", { name: /^Keep(?![A-Za-z])/ }).first().click();
  await waitFor("the DM on the Keep", () => (dmSocket.you?.sceneId === keep ? true : null));
  await dm.locator(".konvajs-content").first().waitFor();
  // The side panel hides (S) and the map fits again (0), so the pane and the wing share the whole window.
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("s");
  await panel.waitFor({ state: "hidden" });
  await dm.keyboard.press("0");
  await pickTool(dm, "Map builder");
  await pickOption(dm, "Map builder", "Builder mode", "Add a wing");
  const bar = dm.getByRole("toolbar", { name: "Map builder options" });
  const line = dm.locator('[data-options-line="shown"]').first();

  const a = await pagePoint(dm, KEEP, AREA.from);
  const b = await pagePoint(dm, KEEP, AREA.to);
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1, { steps: 3 });
  await dm.mouse.move(b.x, b.y, { steps: 12 });
  await dm.mouse.up();
  await waitFor("the line asking for the wall", async () => ((await line.innerText()).includes("Tap the wall the wing joins.") ? true : null));
  const join = await pagePoint(dm, KEEP, JOIN);
  await dm.mouse.click(join.x, join.y);
  await waitFor("the area and join set", async () => (/joined at the ringed wall/.test(await line.innerText()) ? true : null));
  await bar.getByRole("button", { name: "Generate a wing", exact: true }).click();
  const pane = dm.locator("[data-wing-pane]");
  await pane.getByRole("heading", { name: "Add a wing" }).waitFor();
  const planned = async () => waitFor("the plan's counts", async () => (/rooms?\b.*doors?\b.*traps?\b/.test(await pane.getByRole("status").innerText()) ? true : null), 30_000);
  await planned();
  // Each theme's help is its own length, so the first whose rows end on a whole line with Reroll and the area line in view.
  const top = [pane.getByRole("button", { name: "Reroll", exact: true }), pane.getByText(/^Area \d+ by \d+ squares/)];
  let clean = await cleanEdges(top, [-20, 20]);
  for (const theme of THEMES.slice(1)) {
    if (clean) break;
    await pane.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: theme, exact: true }).check();
    await dm.waitForTimeout(500);
    await planned();
    clean = await cleanEdges(top, [-20, 20]);
  }
  if (!clean) throw new Error("the wing pane cuts a line on every theme");
  console.log(`wing: ${await pane.getByRole("status").innerText()}`);
  // Focus lands on Theme for a mouse, and its ring is not part of the picture.
  await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
  await picture(dm, "dungeon-wing");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
