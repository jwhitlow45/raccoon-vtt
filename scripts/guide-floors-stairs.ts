/**
 * The DM guide's picture of the Map builder on stairs
 * (docs/dm-guide.md, "Stairs and ladders"), taken from the real server on
 * the production build so it always shows the app as it is:
 *
 * - floors-stairs-builder.webp: Between floors on Tower's Ground floor, a box
 *   of stairs up to Upper floor, not reached yet, its pane open with Kind on
 *   Stairs beside Ladder and Opening, and Locked off.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the picture to docs/dm-guide/ at 1280 x 800, as the guide's
 * other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-floors-stairs.ts
 *
 * GUIDE_COPY_DIR, when set, also gets the picture as guide-<name>.png, which
 * it never overwrites, for looking at it at full quality.
 */
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, pickOption, pickTool, ROOT, SocketWatch, startServer, tapCell, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const DESK = { width: 1280, height: 800 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;
const BOUNDS = { w: 14, h: 10 };
const TOOL = "Map builder";
const STAIRS = { x: 7, y: 4 };

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

/** Waits until no toast covers the map, so a picture shows the page and not its notices. */
async function quiet(page: Page): Promise<void> {
  await waitFor("no toast", async () => ((await page.locator("[data-toast]").count()) === 0 ? true : null), 20_000);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-stairs-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
let ops: OpSocket | null = null;
const dmContext = await browser.newContext({ viewport: DESK });
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
  const ground = dmSocket.state!.meta.playerSceneId!;
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  // Tower: a stone hall on Ground floor under an Upper floor no player has reached.
  const upper = randomUUID();
  const shown = { visibility: "all", size: "medium" } as const;
  await ops.send({ t: "scene.update", sceneId: ground, patch: { name: "Tower", bounds: BOUNDS, fogEnabled: false } });
  await ops.send({ t: "scene.create", scene: { id: upper, name: "Tower", bounds: BOUNDS }, floor: { beside: ground, side: "above", besideName: "Ground floor" } });
  await ops.send({ t: "scene.update", sceneId: upper, patch: { floor: { name: "Upper floor", height: 10 }, fogEnabled: false } });
  await ops.send({ t: "build.rect", sceneId: ground, terrain: "stone", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "build.rect", sceneId: upper, terrain: "wood", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "token.create", token: { id: randomUUID(), sceneId: ground, kind: "monster", name: "Goblin", disposition: "hostile", actor: { inline: actor(7) }, x: 3, y: 5, ...shown } });
  await ops.send({ t: "token.create", token: { id: randomUUID(), sceneId: ground, kind: "monster", name: "Thorn", disposition: "ally", actor: { inline: actor(52) }, x: 5, y: 4, ...shown } });
  await waitFor("the room's tokens", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 2 ? true : null));
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();

  await pickTool(dm, TOOL);
  await pickOption(dm, TOOL, "Builder mode", "Between floors");
  await pickOption(dm, TOOL, "Kind", "Stairs");
  await pickOption(dm, TOOL, "To", "Up to Upper floor");
  await tapCell(dm, BOUNDS, STAIRS);
  await dm.getByRole("heading", { name: "Stairs up to Upper floor" }).waitFor();
  await quiet(dm);
  await picture(dm, "floors-stairs-builder");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
