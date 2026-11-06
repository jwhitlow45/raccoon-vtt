/**
 * The DM guide's pictures of a wider side panel and of a sheet's step
 * arrows with a mouse (docs/dm-guide.md, "Where things are",
 * docs/design/design-v1-panel-size.md), taken from the real server on the
 * production build so they always show the app as it is.
 *
 * The room is a stone hall with Bree and three goblins in a fight. On a
 * 1280 x 800 window the DM drags the side panel's edge toward the map,
 * held mid-drag so its accent line shows, with Initiative open and Reset
 * width beside Hide panels. On a narrow 390 x 844 window with a mouse,
 * Initiative opens as a sheet with Up and Down beside its handle.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/side-panel-width.webp and
 * docs/dm-guide/sheet-arrows.webp, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-panel-size.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, openSideTab, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const BOUNDS = { w: 14, h: 10 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 1, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-panel-size-"));
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

  await ops.send({ t: "scene.update", sceneId, patch: { name: "Goblin Warren", bounds: BOUNDS, fogEnabled: false, defaultView: { x: 7, y: 5, zoom: 56 } } });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 1, y: 1, w: BOUNDS.w - 2, h: BOUNDS.h - 2 });
  await ops.send({ t: "build.rect", sceneId, terrain: "rubble", x: 2, y: 6, w: 3, h: 2 });
  await ops.send({ t: "build.label", sceneId, labelId: randomUUID(), label: { x: 7, y: 2, text: "Guard room", size: 0.45 } });
  const bree = randomUUID();
  const goblins = [randomUUID(), randomUUID(), randomUUID()];
  await ops.send({ t: "token.create", token: { id: bree, sceneId, kind: "pc", name: "Bree", size: "medium", x: 4, y: 4, visibility: "all", disposition: "ally", actor: { inline: actor(27) } } });
  for (const [i, id] of goblins.entries()) {
    await ops.send({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", number: i + 1, size: "medium", x: 8 + i, y: 4 + (i % 2), visibility: "all", disposition: "hostile", actor: { inline: actor(7) } } });
  }
  await ops.send({ t: "encounter.start", entries: [{ id: "e-bree", tokenId: bree, value: 17 }, ...goblins.map((tokenId, i) => ({ id: `e-g${i}`, tokenId, value: 14 - i * 3 }))] });
  await ops.send({ t: "encounter.next" });
  await waitFor("the fight", () => (dmSocket.state?.encounter?.entries.length === 4 ? true : null));

  // The side panel dragged wider, held so the edge's accent line shows.
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await openSideTab(dm, "Initiative");
  const edge = dm.getByRole("separator", { name: "Side panel width" });
  const box = (await edge.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
  await dm.mouse.move(from.x, from.y);
  await dm.mouse.down();
  await dm.mouse.move(from.x - 200, from.y, { steps: 12 });
  await dm.getByRole("button", { name: "Reset width", exact: true }).waitFor();
  await picture(dm, "side-panel-width");
  await dm.mouse.up();
  await dm.getByRole("button", { name: "Reset width", exact: true }).click();

  // A narrow window with a mouse: Initiative as a sheet, Up and Down beside its handle.
  await dm.setViewportSize(NARROW);
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Initiative/ }).click();
  const sheet = dm.locator('dialog[data-rvtt-sheet][aria-label="Initiative"]');
  await sheet.locator('[data-sheet-step="up"]').waitFor();
  await picture(dm, "sheet-arrows");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
