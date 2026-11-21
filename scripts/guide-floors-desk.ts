/**
 * The DM guide's pictures of several floors at the desk (docs/dm-guide.md,
 * "Floors", "Building floors", "Showing the players a floor", "Moving between
 * floors" and "Stairs and ladders", docs/design/design-v1-floors.md), taken
 * from the real server on the production build so they always show the app as
 * it is:
 *
 * - floors-menu.webp, floors-settings.webp, floors-viewing.webp,
 *   floors-tracker.webp, floors-move.webp, floors-climb-strip.webp and
 *   floors-climb-landed.webp.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a room,
 * writes the pictures to docs/dm-guide/ at 1280 x 800 for the computer and
 * 390 x 844 for the phone, as the guide's other pictures are, and deletes the
 * room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-floors-desk.ts
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
import { dragCells, OpSocket, openSceneGroup, openSideTab, pickTool, ROOT, sideTabName, SocketWatch, sleep, startServer, tapCell, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;
const BOUNDS = { w: 14, h: 10 };
/** Thorn's squares before the stairs, and the stairs three squares (15 ft) east of them. */
const THORN_AT = { x: 2, y: 7 };
const STAIRS = { x: 5, y: 7 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
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

/** Shows `name` on the page, by the floor keys. */
async function onFloor(page: Page, name: string): Promise<void> {
  await waitFor(`${name} shown`, async () => {
    if (((await page.locator('[data-floors="button"]').first().getAttribute("aria-label").catch(() => null)) ?? "").startsWith(`Floor: ${name}.`)) return true;
    await key(page, name === "Upper floor" ? "]" : "[");
    await sleep(400);
    return null;
  });
}

/** Scrolls only the side panel so `target` stands at its top, and puts the page itself back at the top. */
async function scrollPanelTo(page: Page, target: Locator): Promise<void> {
  await target.evaluate((el) => {
    type Box = { scrollTop: number; scrollHeight: number; clientHeight: number; parentElement: Box | null; getBoundingClientRect(): { top: number } };
    let box = (el as unknown as { closest(s: string): Box | null }).closest('[role="tabpanel"]');
    while (box && !(box.scrollHeight > box.clientHeight + 5)) box = box.parentElement;
    if (box) box.scrollTop += (el as unknown as Box).getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    const g = globalThis as unknown as { scrollTo(x: number, y: number): void };
    g.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-floors-desk-"));
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
  const benContext = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const benJoin = await benContext.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  const { ticket: benTicket } = (await benJoin.json()) as { ticket: string };
  const benDone = await benContext.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket: benTicket, name: "Ben", color: "#e5484d" } });
  const benId = ((await benDone.json()) as { member: { id: string } }).member.id;
  await benContext.close();

  // Tower: a stone hall on Ground floor under an Upper floor and an Attic no player has reached. Thorn is Ana's and
  // Bree stands beside him, both on Ground floor.
  const upper = randomUUID();
  const attic = randomUUID();
  const thorn = randomUUID();
  const bree = randomUUID();
  const tThorn = randomUUID();
  const tBree = randomUUID();
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
  await ops.send({ t: "character.create", character: { id: bree, name: "Bree", size: "medium", ownerIds: [benId], actor: actor(22) } });
  await ops.send({ t: "token.create", token: { id: tThorn, sceneId: ground, kind: "pc", name: "Thorn", ownerIds: [anaId], actor: { ref: thorn }, disposition: "ally", ...THORN_AT, ...shown } });
  await ops.send({ t: "token.create", token: { id: tBree, sceneId: ground, kind: "pc", name: "Bree", ownerIds: [benId], actor: { ref: bree }, disposition: "ally", x: 3, y: 4, ...shown } });
  const goblin = randomUUID();
  await ops.send({ t: "token.create", token: { id: goblin, sceneId: ground, kind: "monster", name: "Goblin", disposition: "hostile", actor: { inline: actor(7) }, x: 9, y: 4, ...shown } });
  await waitFor("the room's tokens", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 3 ? true : null));
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await onFloor(dm, "Upper floor");
  await quiet(dm);

  // Shot 1: the Floors menu on Upper floor, with Thorn and Bree downstairs.
  await dm.locator('[data-floors="button"]').first().click();
  await dm.getByRole("menu").or(dm.getByRole("dialog")).first().waitFor();
  await picture(dm, "floors-menu");
  await key(dm, "Escape");

  // Shot 2: the Floors group in the scene's settings.
  const scenes = await panel(dm, "Scenes");
  const group = await openSceneGroup(scenes, "Floors");
  await scrollPanelTo(dm, group);
  await quiet(dm);
  await picture(dm, "floors-settings");

  // Shot 3: Ana's phone looking at Ground floor while Thorn is upstairs.
  await ops.send({ t: "floor.open", sceneId: upper, open: true });
  await ops.send({ t: "token.update", tokenId: tThorn, patch: { sceneId: upper } });
  await waitFor("Thorn upstairs", () => (dmSocket.state?.tokens[tThorn]?.sceneId === upper ? true : null));
  const ana = await anaContext.newPage();
  await ana.goto(`${origin}/r/${roomId}`);
  await ana.getByRole("status", { name: "Connected" }).first().waitFor();
  await ana.locator(".konvajs-content").first().waitFor();
  await onFloor(ana, "Ground floor");
  await ana.getByRole("button", { name: /^Back to Thorn/ }).waitFor();
  await quiet(ana);
  await picture(ana, "floors-viewing");
  await ana.getByRole("button", { name: /^Back to Thorn/ }).click();

  // Shot 4: a fight across the floors, the DM on Ground floor, Thorn first.
  await ops.send({ t: "token.update", tokenId: tThorn, patch: { sceneId: ground } });
  await ops.send({ t: "token.move", tokenId: tThorn, x: THORN_AT.x, y: THORN_AT.y });
  await waitFor("Thorn back downstairs", () => (dmSocket.state?.tokens[tThorn]?.sceneId === ground ? true : null));
  await onFloor(dm, "Ground floor");
  await ops.send({ t: "token.update", tokenId: tThorn, patch: { sceneId: upper } });
  await waitFor("Thorn upstairs again", () => (dmSocket.state?.tokens[tThorn]?.sceneId === upper ? true : null));
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: randomUUID(), tokenId: tThorn, value: 18, hidden: false },
      { id: randomUUID(), tokenId: goblin, value: 14, hidden: false },
      { id: randomUUID(), tokenId: tBree, value: 10, hidden: false },
    ],
  });
  await ops.send({ t: "encounter.next" });
  await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.length === 3 ? true : null));
  const tracker = await panel(dm, "Initiative");
  await tracker.getByText("Upper floor", { exact: true }).first().waitFor();
  await quiet(dm);
  await picture(dm, "floors-tracker");

  // Shot 5: Move to floor on Thorn, with the Attic row warning that the players have not reached it.
  await onFloor(dm, "Upper floor");
  await tapCell(dm, BOUNDS, THORN_AT);
  const bar = dm.getByRole("dialog", { name: "Thorn actions", exact: true });
  await bar.waitFor();
  await bar.getByRole("button", { name: /^(Move to floor|Floor)/ }).first().click();
  await dm.getByText(/^Players haven't reached Attic/).first().waitFor();
  // The bar scrolls, so the floor rows are put in view whole, the Attic's warning and Ground floor under it.
  await bar.getByText("Ground floor", { exact: true }).first().scrollIntoViewIfNeeded();
  await panel(dm, "Scenes");
  await quiet(dm);
  await picture(dm, "floors-move");
  await key(dm, "Escape");
  await key(dm, "Escape");

  // Shot 6 and 7: Thorn walks 15 ft to the stairs on his turn, and Ana's phone takes them up. The stairs go in after the
  // pictures that would show them as a build.
  await ops.send({ t: "token.update", tokenId: tThorn, patch: { sceneId: ground } });
  await waitFor("Thorn downstairs for the climb", () => (dmSocket.state?.tokens[tThorn]?.sceneId === ground ? true : null));
  await ops.send({ t: "token.move", tokenId: tThorn, x: THORN_AT.x, y: THORN_AT.y });
  await ops.send({ t: "floorLink.put", link: { id: randomUUID(), pairId: randomUUID(), sceneId: ground, to: upper, rect: { ...STAIRS, w: 1, h: 1 }, kind: "stairs" } });
  await waitFor("both ends of the stairs", () => (Object.keys(dmSocket.state?.floorLinks ?? {}).length === 2 ? true : null));
  await onFloor(dm, "Ground floor");
  await dragCells(dm, BOUNDS, THORN_AT, STAIRS);
  await waitFor("Thorn on the stairs", () => (dmSocket.state?.tokens[tThorn]?.x === STAIRS.x ? true : null));
  await ana.reload();
  await ana.locator(".konvajs-content").first().waitFor();
  await tapCell(ana, BOUNDS, STAIRS);
  await ana.locator('[data-climb="up"]:visible').first().waitFor();
  await quiet(ana);
  await picture(ana, "floors-climb-strip");
  await ana.locator('[data-climb="up"]:visible').first().click();
  await ana.locator('[data-climb="down"]:visible').first().waitFor();
  await quiet(ana);
  await picture(ana, "floors-climb-landed");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
