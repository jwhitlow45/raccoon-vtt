/**
 * The DM guide's picture of the light theme (docs/dm-guide.md, "This device"),
 * taken from the real server on the production build so it always shows the
 * app as it is:
 *
 * - theme.webp: This device on a computer with Light chosen, beside the map,
 *   which stays dark in the light theme.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a room,
 * writes the picture to docs/dm-guide/ at 1280 x 800, as the guide's other
 * pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-theme.ts
 */
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { openSideTab, OpSocket, ROOT, sideTabName, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  await page.locator("[data-toast]").first().waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-theme-"));
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
  const sceneId = dmSocket.state!.meta.playerSceneId!;
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  await ops.send({ t: "scene.update", sceneId, patch: { name: "The Gilded Boar", bounds: { w: 16, h: 12 }, fogEnabled: false, defaultView: { x: 8, y: 6, zoom: 40 } } });
  await ops.send({ t: "build.rect", sceneId, terrain: "grass", x: 1, y: 1, w: 14, h: 10 });
  await ops.send({ t: "build.rect", sceneId, terrain: "dirt", x: 1, y: 5, w: 14, h: 2 });
  const token = (name: string, x: number, y: number, hp: number) => ({
    t: "token.create",
    token: { id: randomUUID(), sceneId, kind: "monster", name, size: "medium", x, y, visibility: "all", disposition: "hostile", actor: { inline: actor(hp) } },
  });
  await ops.send(token("Goblin", 6, 5, 7));
  await ops.send(token("Wolf", 9, 6, 11));
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();

  await openSideTab(dm, "Menu");
  const menu = dm.getByRole("tabpanel", { name: sideTabName("Menu") });
  await menu.getByRole("button", { name: /^This device/ }).first().click();
  const device = dm.getByRole("tabpanel", { name: sideTabName("Menu") });
  await device.getByRole("radio", { name: "Light", exact: true }).or(device.getByRole("button", { name: "Light", exact: true })).first().click();
  await device.getByText("Theme", { exact: true }).first().scrollIntoViewIfNeeded();
  await dm.mouse.move(5, 790);
  await picture(dm, "theme");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
