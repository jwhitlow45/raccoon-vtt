/**
 * The DM guide's pictures of sight per player (docs/dm-guide.md, "Sight
 * for each player", docs/design-v1-per-player-vision.md): the Vision
 * settings of a per-player scene, and View as a player for each of the
 * two players on it, taken from the real server on the production build
 * so they always show the app as it is.
 *
 * The scene is a stone hall over two rooms, dark. Ana plays Thorn, by the
 * door of the hall, with a torch that shows her a goblin and an altar.
 * Ben plays Bree, in the east room, with a torch of his own. Pip, a
 * hireling the DM marked to share sight, holds a candle in the west room,
 * behind the closed door: every player sees what the candle lights, and
 * Pip, who sees by any light, sees none of what Thorn's torch lights.
 * Cy has joined and plays no one here. The goblin's turn is under way.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/vision-per-player.webp, view-as-ana.webp and
 * view-as-ben.webp at 1280 x 800, as the guide's other pictures are, and
 * deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3195 node scripts/guide-pervision.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import type { EdgeFeature } from "../shared/model.ts";
import { openSideTab, OpSocket, ROOT, sideTabName, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3195);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };

/**
 * 22 by 14 squares: the hall above row 7, a wall along it with a door at
 * (4, 7), and below it the west room behind the door and the east room,
 * walled apart along column 11.
 */
const BOUNDS = { w: 22, h: 14 };
const DOOR = "4,7,n";

function actor(senses = "") {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses, effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

async function join(context: BrowserContext, origin: string, roomId: string, password: string, name: string, color: string): Promise<string> {
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await context.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-pervision-"));
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
  // The room never shows the rolls' animation in a picture.
  await dmContext.addInitScript(() => {
    try {
      localStorage.setItem("rvtt.rollAnimation", "off");
    } catch {
      // Storage is off: the animation shows, which no picture here catches.
    }
  });

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
  const sceneId = dmSocket.state!.meta.playerSceneId!;
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  const players = await browser.newContext();
  const ana = await join(players, origin, roomId, password, "Ana", "#e5484d");
  await players.clearCookies();
  const ben = await join(players, origin, roomId, password, "Ben", "#0090ff");
  await players.clearCookies();
  await join(players, origin, roomId, password, "Cy", "#46a758");
  await players.close();

  // The scene is per player before anyone stands on it, so no ground is explored for the whole party first.
  await ops.send({ t: "scene.update", sceneId, patch: { name: "Chapel ruins", bounds: BOUNDS, fogEnabled: true, autoWalls: "all", vision: { on: true, light: "dark", perPlayer: true } } });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 0, y: 0, w: BOUNDS.w, h: BOUNDS.h });
  const wall: EdgeFeature = { kind: "wall" };
  const edges: { key: string; feature: EdgeFeature }[] = [];
  for (let x = 0; x < BOUNDS.w; x++) edges.push({ key: `${x},7,n`, feature: `${x},7,n` === DOOR ? { kind: "door", state: "closed", secret: false, discovered: false } : wall });
  for (let y = 7; y < BOUNDS.h; y++) edges.push({ key: `11,${y},w`, feature: wall });
  await ops.send({ t: "build.edge", sceneId, edges });
  await ops.send({ t: "build.label", sceneId, labelId: randomUUID(), label: { x: 7.5, y: 1.5, text: "Old altar", size: 1 } });

  // Sources list player characters by token id, so Thorn takes the smaller one and leads the list in every run's picture.
  const [first, second] = [randomUUID(), randomUUID()].sort();
  const ids = { thorn: first!, bree: second!, pip: randomUUID(), goblin: randomUUID() };
  const token = (id: string, name: string, x: number, y: number, extra: Record<string, unknown>) => ({
    t: "token.create",
    token: { id, sceneId, kind: "monster", name, size: "medium", x, y, visibility: "all", actor: { inline: actor() }, ...extra },
  });
  const torch = { bright: 20, dim: 20 };
  await ops.send(token(ids.thorn, "Thorn", 4, 6, { kind: "pc", disposition: "ally", ownerIds: [ana], light: torch }));
  await ops.send(token(ids.bree, "Bree", 16, 10, { kind: "pc", disposition: "ally", ownerIds: [ben], light: torch }));
  await ops.send(token(ids.pip, "Pip", 2, 10, { kind: "npc", disposition: "ally", partyVision: true, light: { bright: 5, dim: 5 } }));
  await ops.send(token(ids.goblin, "Goblin", 9, 3, { disposition: "hostile" }));
  await waitFor("Ana and Ben on the list", () => (dmSocket.state?.holders?.[sceneId]?.entries.filter((e) => e.on).length === 2 ? true : null));
  await ops.send({
    t: "encounter.start",
    entries: [
      { id: randomUUID(), tokenId: ids.goblin, value: 18 },
      { id: randomUUID(), tokenId: ids.thorn, value: 14 },
      { id: randomUUID(), tokenId: ids.bree, value: 12 },
      { id: randomUUID(), tokenId: ids.pip, value: 8 },
    ],
  });
  await ops.send({ t: "encounter.next" });

  await openSideTab(dm, "Scenes");
  const scenes = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  const sight = scenes.locator("[data-vision-sight]");
  await sight.waitFor();
  // From the Sight row down, so the list of who sees for themselves and the rows that lend sight show together.
  await sight.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
  await picture(dm, "vision-per-player");

  for (const [name, file] of [["Ana", "view-as-ana"], ["Ben", "view-as-ben"]] as const) {
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: name });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator(`dialog[aria-label="Viewing as ${name}"]`);
    await preview.locator(".konvajs-content").first().waitFor();
    await preview.getByRole("button", { name: /^Initiative, round 1\./ }).waitFor();
    await picture(dm, file);
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
  }
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
