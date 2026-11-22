/**
 * The DM guide's pictures of openings, falls and the rest of floors phase 4
 * (docs/dm-guide.md, "Openings", "Falls", "Flying through", "Trapdoors",
 * "Stairs and ladders", Export, New scene and the Outliner,
 * docs/design/design-v1-floors.md phase 4), taken from the real server on
 * the production build so they always show the app as it is:
 *
 * - floors-opening-builder.webp, floors-opening-window.webp,
 *   floors-fly-strip.webp, floors-fly-up.webp, floors-fall-card.webp,
 *   floors-trapdoor-pane.webp, floors-line-up.webp, floors-outliner-other.webp,
 *   floors-opening-isometric.webp, floors-fight-every-floor.webp,
 *   floors-export-every.webp and floors-several-files.webp.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the pictures to docs/dm-guide/ at 1280 x 800 for the
 * computer and 390 x 844 for the phone, as the guide's other pictures are,
 * and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-floors-phase4.ts
 *
 * GUIDE_COPY_DIR, when set, also gets each picture as guide-<name>.png, which
 * it never overwrites, for looking at the pictures at full quality.
 */
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { uvttFile } from "../client/features/uvtt/synthetic.ts";
import { dragCells, expandBar, OpSocket, openSceneGroup, openSideTab, pagePoint, pickOption, pickTool, ROOT, sideTabName, SocketWatch, sleep, startServer, tapCell, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;
const BOUNDS = { w: 14, h: 10 };
const TOOL = "Map builder";
/** The hole on Upper floor, over the goblin's hall. */
const HOLE = { x: 6, y: 3, w: 4, h: 4 };
const THORN_AT = { x: 2, y: 4 };
const OVER = { x: 7, y: 4 };
const TRAPDOOR = { x: 11, y: 6, w: 2, h: 2 };
const STAIRS = { x: 2, y: 7 };

function actor(hp: number, fly = 0) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30, ...(fly > 0 ? { fly } : {}) }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(1000);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
  if (COPY_DIR !== undefined) {
    mkdirSync(COPY_DIR, { recursive: true });
    writeFileSync(path.join(COPY_DIR, `guide-${name}.png`), png, { flag: "wx" });
  }
}

async function panel(page: Page, title: string): Promise<Locator> {
  await openSideTab(page, title);
  return page.getByRole("tabpanel", { name: sideTabName(title) });
}

async function key(page: Page, k: string): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press(k);
}

/** Waits until no toast covers the map, so a picture shows the page and not its notices. */
async function quiet(page: Page): Promise<void> {
  await waitFor("no toast", async () => ((await page.locator("[data-toast]").count()) === 0 ? true : null), 20_000);
}

/** Scrolls the side panel back to its top, so no line of it hides under the tab row. */
async function panelToTop(page: Page, tabpanel: Locator): Promise<void> {
  await tabpanel.evaluate((el) => {
    type Box = { scrollTop: number; scrollHeight: number; clientHeight: number; parentElement: Box | null; querySelectorAll(s: string): Box[] };
    const top = (box: Box) => {
      if (box.scrollHeight > box.clientHeight + 5) box.scrollTop = 0;
    };
    // The panel's scroller is the panel itself, a box above it or one inside it.
    let up: Box | null = el as unknown as Box;
    while (up) {
      top(up);
      up = up.parentElement;
    }
    (el as unknown as Box).querySelectorAll("*").forEach(top);
    (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

/** Scrolls only the side panel so `target` stands at its top, and puts the page itself back at the top. */
async function scrollPanelTo(page: Page, target: Locator): Promise<void> {
  await target.evaluate((el) => {
    type Box = { scrollTop: number; scrollHeight: number; clientHeight: number; parentElement: Box | null; getBoundingClientRect(): { top: number } };
    let box = (el as unknown as { closest(s: string): Box | null }).closest('[role="tabpanel"]');
    while (box && !(box.scrollHeight > box.clientHeight + 5)) box = box.parentElement;
    if (box) box.scrollTop += (el as unknown as Box).getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    (globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-floors4-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
let ops: OpSocket | null = null;
const dmContext = await browser.newContext({ viewport: DESK });
const anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
try {
  const origin = server.origin;
  const dm = await dmContext.newPage();
  const dmSocket = new SocketWatch("dm");
  await dmSocket.attach(dmContext, dm);
  await dm.goto(`${origin}/`);
  await dm.getByLabel("Room name").fill(roomName);
  await dm.getByLabel("Your name").fill("Dana the DM");
  const password = await dm.getByLabel("Player password").inputValue();
  await dm.getByRole("button", { name: "Create room" }).click();
  await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await dm.locator("code").first().textContent()) ?? "";
  roomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)![1]!.replace("-", "");
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();
  await waitFor("the DM's snapshot", () => dmSocket.state);
  const ground = dmSocket.state!.meta.playerSceneId!;
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await anaContext.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await anaContext.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name: "Ana", color: "#30a46c" } });
  const anaId = ((await done.json()) as { member: { id: string } }).member.id;

  // Tower: a stone hall on Ground floor under a wooden Upper floor, and an Attic nobody has reached.
  const upper = randomUUID();
  const attic = randomUUID();
  const thorn = randomUUID();
  const tThorn = randomUUID();
  const shown = { visibility: "all", size: "medium" } as const;
  await ops.send({ t: "scene.update", sceneId: ground, patch: { name: "Tower", bounds: BOUNDS, fogEnabled: false } });
  await ops.send({ t: "scene.create", scene: { id: upper, name: "Tower", bounds: BOUNDS }, floor: { beside: ground, side: "above", besideName: "Ground floor" } });
  await ops.send({ t: "scene.update", sceneId: upper, patch: { floor: { name: "Upper floor", height: 10 }, fogEnabled: false } });
  await ops.send({ t: "scene.create", scene: { id: attic, name: "Tower", bounds: BOUNDS }, floor: { beside: upper, side: "above" } });
  await ops.send({ t: "scene.update", sceneId: attic, patch: { floor: { name: "Attic" }, fogEnabled: false } });
  await ops.send({ t: "build.rect", sceneId: ground, terrain: "stone", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "build.rect", sceneId: upper, terrain: "wood", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "build.rect", sceneId: attic, terrain: "wood", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "character.create", character: { id: thorn, name: "Thorn", size: "medium", ownerIds: [anaId], actor: actor(24) } });
  await ops.send({ t: "token.create", token: { id: tThorn, sceneId: upper, kind: "pc", name: "Thorn", ownerIds: [anaId], actor: { ref: thorn }, disposition: "ally", ...THORN_AT, ...shown } });
  const monster = (name: string, sceneId: string, x: number, y: number, visibility: "all" | "dm" = "all") => ({ id: randomUUID(), sceneId, kind: "monster" as const, name, disposition: "hostile" as const, actor: { inline: actor(12) }, x, y, size: "medium" as const, visibility });
  await ops.send({ t: "token.create", token: monster("Goblin", ground, 7, 5) });
  await ops.send({ t: "token.create", token: monster("Kobold", ground, 8, 3) });
  await ops.send({ t: "token.create", token: monster("Lurker", ground, 11, 2, "dm") });
  await ops.send({ t: "token.create", token: monster("Rat", attic, 4, 4) });
  await ops.send({ t: "floor.open", sceneId: upper, open: true });
  await waitFor("the room's tokens", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 5 ? true : null));
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  const onFloor = async (page: Page, name: string) => {
    await waitFor(`${name} shown`, async () => {
      if (((await page.locator('[data-floors="button"]').first().getAttribute("aria-label").catch(() => null)) ?? "").startsWith(`Floor: ${name}.`)) return true;
      await key(page, name === "Upper floor" ? "]" : "[");
      await sleep(400);
      return null;
    });
  };
  await onFloor(dm, "Upper floor");

  // Shot 1: Between floors on Opening, a hole dragged and its pane open.
  await pickTool(dm, TOOL);
  await pickOption(dm, TOOL, "Builder mode", "Between floors");
  await pickOption(dm, TOOL, "Kind", "Opening");
  await pickOption(dm, TOOL, "To", "Down to Ground floor");
  await dragCells(dm, BOUNDS, { x: HOLE.x, y: HOLE.y }, { x: HOLE.x + HOLE.w - 1, y: HOLE.y + HOLE.h - 1 });
  await dm.getByRole("heading", { name: "Opening down to Ground floor" }).waitFor();
  await sleep(9000);
  await picture(dm, "floors-opening-builder");
  await key(dm, "Escape");
  await pickTool(dm, "Select");

  // Shot 2: Ana's phone, the hole as a window onto the hall.
  const ana = await anaContext.newPage();
  await ana.goto(`${origin}/r/${roomId}`);
  await ana.getByRole("status", { name: "Connected" }).first().waitFor();
  await ana.locator(".konvajs-content").first().waitFor();
  await sleep(1500);
  await picture(ana, "floors-opening-window");

  // Shot 3: Thorn in the air over the hole, selected, with Fly down.
  await ops.send({ t: "token.move", tokenId: tThorn, x: OVER.x, y: OVER.y, elevation: 5 });
  await waitFor("Thorn in the air", () => (dmSocket.state?.tokens[tThorn]?.elevation === 5 ? true : null));
  await sleep(500);
  await tapCell(ana, BOUNDS, OVER);
  const bar = ana.getByRole("dialog", { name: "Thorn actions", exact: true });
  await bar.waitFor();
  if ((await ana.locator('[data-climb="down"]:visible').count()) === 0) await expandBar(bar);
  await ana.locator('[data-climb="down"]:visible').first().waitFor();
  await picture(ana, "floors-fly-strip");
  await key(ana, "Escape");

  // Shot 4: the fall card.
  await ops.send({ t: "token.move", tokenId: tThorn, x: THORN_AT.x, y: THORN_AT.y, elevation: 0 });
  await sleep(500);
  await ops.send({ t: "token.move", tokenId: tThorn, x: OVER.x, y: OVER.y });
  await waitFor("Thorn below", () => (dmSocket.state?.tokens[tThorn]?.sceneId === ground ? true : null));
  await onFloor(dm, "Ground floor");
  await dm.getByRole("region", { name: "Fall: Thorn" }).waitFor();
  await picture(dm, "floors-fall-card");
  for (const id of Object.keys(dmSocket.state?.falls ?? {})) await ops.send({ t: "fall.settle", fallId: id });

  // Shot 4b: Thorn in the air over the hole's lower end on Ground floor, with Fly up. Ana's screen follows him down.
  // Thorn's name plate hangs under him over the hole, so the goblin steps aside, or the plate hides its health word. The goblin goes back after the picture.
  const goblin = Object.values(dmSocket.state?.tokens ?? {}).find((t) => t?.name === "Goblin")!;
  await ops.send({ t: "token.move", tokenId: goblin.id, x: 9, y: 5 });
  await ops.send({ t: "token.move", tokenId: tThorn, x: OVER.x, y: OVER.y, elevation: 5 });
  await waitFor("Thorn in the air below", () => (dmSocket.state?.tokens[tThorn]?.elevation === 5 ? true : null));
  await onFloor(ana, "Ground floor");
  await sleep(500);
  await tapCell(ana, BOUNDS, OVER);
  const lowBar = ana.getByRole("dialog", { name: "Thorn actions", exact: true });
  await lowBar.waitFor();
  if ((await ana.locator('[data-climb="up"]:visible').count()) === 0) await expandBar(lowBar);
  await ana.locator('[data-climb="up"]:visible').first().waitFor();
  await picture(ana, "floors-fly-up");
  await key(ana, "Escape");
  await ops.send({ t: "token.move", tokenId: goblin.id, x: goblin.x, y: goblin.y });
  await ops.send({ t: "token.move", tokenId: tThorn, x: OVER.x, y: OVER.y, elevation: 0 });
  await ops.send({ t: "token.move", tokenId: tThorn, x: 3, y: 2 });
  // The fall's toast waits for a tap, so a reload clears it from the pictures that follow.
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await quiet(dm);

  // Shot 5: a trap with Into on Ground floor.
  await onFloor(dm, "Upper floor");
  const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger", actions: [], find: [], notice: false };
  const trap = randomUUID();
  await ops.send({ t: "trap.create", trap: { id: trap, sceneId: upper, name: "Hidden Pit", zone: { cells: [TRAPDOOR] }, rig } });
  await waitFor("the trap", () => (dmSocket.state?.traps[trap] ? true : null));
  await pickTool(dm, "Trap");
  await tapCell(dm, BOUNDS, { x: TRAPDOOR.x, y: TRAPDOOR.y });
  const trapPane = dm.getByRole("dialog", { name: "Edit trap" });
  await trapPane.waitFor();
  const fold = trapPane.getByRole("button", { name: "Aftermath", exact: true });
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await trapPane.getByRole("radio", { name: "Ground floor", exact: true }).click();
  await trapPane.getByText("Creatures standing on it fall to Ground floor, onto the same squares.", { exact: true }).waitFor();
  await sleep(9000);
  await picture(dm, "floors-trapdoor-pane");
  await key(dm, "Escape");
  await pickTool(dm, "Select");

  // Shot 5b: New fight with Every floor chosen, the buttons counting the creatures of all three floors. It comes before the
  // stairs, so the opening is the only pair on the map and its chip stands clear.
  const tracker = await panel(dm, "Initiative");
  const newFight = tracker.locator("section").filter({ has: dm.locator('[data-search="tracker.new-fight"]') }).last();
  const fightFloors = newFight.getByRole("radiogroup", { name: "Floors", exact: true });
  await fightFloors.waitFor();
  await fightFloors.getByRole("radio", { name: "Every floor", exact: true }).check();
  await newFight.getByRole("button", { name: /^Everyone on every floor \(\d+\)$/ }).waitFor();
  await scrollPanelTo(dm, newFight);
  await quiet(dm);
  await picture(dm, "floors-fight-every-floor");
  await fightFloors.getByRole("radio", { name: "This floor", exact: true }).check();

  // Shot 6: stairs whose ends lie on other squares, with Line up.
  await onFloor(dm, "Ground floor");
  const down = randomUUID();
  const up = randomUUID();
  await ops.send({ t: "floorLink.put", link: { id: down, pairId: up, sceneId: ground, to: upper, rect: { ...STAIRS, w: 2, h: 1 }, kind: "stairs" } });
  await ops.send({ t: "floorLink.update", linkId: up, patch: { rect: { x: 5, y: 8, w: 2, h: 1 } } });
  await waitFor("the stairs apart", () => (dmSocket.state?.floorLinks?.[up]?.rect.x === 5 ? true : null));
  await pickTool(dm, TOOL);
  await pickOption(dm, TOOL, "Builder mode", "Between floors");
  await pickOption(dm, TOOL, "Kind", "Stairs");
  await tapCell(dm, BOUNDS, STAIRS);
  await dm.getByRole("button", { name: "Line up with Upper floor" }).waitFor();
  await quiet(dm);
  await picture(dm, "floors-line-up");
  await key(dm, "Escape");
  await pickTool(dm, "Select");
  await onFloor(dm, "Upper floor");

  // Shot 6b: the opening in Isometric, a drop in the boards with the hall below it, beside the Initiative panel. The view is set back after.
  const initiative = await panel(dm, "Initiative");
  await key(dm, "i");
  await dm.getByRole("button", { name: /^View: Isometric/ }).waitFor();
  await quiet(dm);
  await sleep(1500);
  await panelToTop(dm, initiative);
  // The pit moves to the far corner for this picture, so its name does not meet the hole's name pill. It goes back after.
  await ops.send({ t: "trap.update", trapId: trap, patch: { zone: { cells: [{ ...TRAPDOOR, x: 11, y: 2 }] } } });
  await sleep(1500);
  await picture(dm, "floors-opening-isometric");
  await ops.send({ t: "trap.update", trapId: trap, patch: { zone: { cells: [TRAPDOOR] } } });
  await key(dm, "i");
  await dm.getByRole("button", { name: /^View: Top-down/ }).waitFor();

  // Shot 7: the outliner's Other floors.
  const outliner = await panel(dm, "Outliner");
  await outliner.getByRole("group", { name: "Show one group" }).getByRole("button", { name: /^Other floors/ }).click();
  await outliner.locator("[data-other-floor]").first().waitFor();
  await quiet(dm);
  await picture(dm, "floors-outliner-other");

  // Shot 8: Export as image on Every floor, the player view.
  const scenes = await panel(dm, "Scenes");
  const section = scenes.locator("section").filter({ has: dm.getByRole("heading", { name: "Export", exact: true }) }).last();
  const open = section.getByRole("button", { name: "Export as image", exact: true });
  const floors = section.getByRole("radiogroup", { name: "Floors", exact: true });
  await open.or(floors).first().waitFor();
  if ((await open.count()) > 0) await open.click();
  await floors.getByRole("radio", { name: "Every floor", exact: true }).check();
  await section.getByRole("radiogroup", { name: "Version", exact: true }).getByRole("radio", { name: "Player view", exact: true }).check();
  await section.getByText("Players have reached 2 of Tower's 3 floors, so the file holds those.", { exact: true }).waitFor();
  await section.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "center" }));
  await quiet(dm);
  await picture(dm, "floors-export-every");

  // Shot 9: New scene from 3 files.
  const p = (x: number, y: number) => ({ x, y });
  const files: string[] = [];
  for (const [i, tint] of ["#4a5a48", "#5a4a48", "#484a5a"].entries()) {
    const image = await sharp({ create: { width: 12 * 50, height: 9 * 50, channels: 3, background: tint } }).png().toBuffer();
    const raw = uvttFile({ size: p(12, 9), ppg: 50, image: image.toString("base64"), walls: [[p(1, 1), p(11, 1), p(11, 8), p(1, 8), p(1, 1)]], portals: [{ a: p(5, 1), b: p(6, 1) }] });
    const file = path.join(work, `Level_${i + 1}.dd2vtt`);
    writeFileSync(file, JSON.stringify(raw));
    files.push(file);
  }
  const group = await openSceneGroup(scenes, "New scene");
  await group.getByLabel("From a Universal VTT file", { exact: true }).setInputFiles(files);
  const dialog = dm.getByRole("dialog", { name: "New scene from 3 files", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "Scene name", exact: true }).fill("Crypt");
  await quiet(dm);
  await picture(dm, "floors-several-files");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
