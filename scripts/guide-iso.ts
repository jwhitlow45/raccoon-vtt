/**
 * The DM guide's pictures of the isometric view (docs/dm-guide.md, "The
 * isometric view", docs/design-v1-isometric-view.md): the DM's board in
 * Isometric, turned once, and the View menu open over it, taken from the
 * real server on the production build so they always show the app as it is.
 *
 * The scene is a stone hall with a raised dais up a stair at its west end,
 * a pit in its floor and a door in its south wall. Thorn and Bree stand on
 * the dais, a goblin waits by the pit, and an imp flies 20 ft over the
 * floor, its shadow on the ground under it.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/isometric.webp and isometric-menu.webp at
 * 1280 x 800, as the guide's other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3196 node scripts/guide-iso.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import type { EdgeFeature } from "../shared/model.ts";
import { OpSocket, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3196);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };

/** 20 by 14 squares: the hall inside a wall, the dais over columns 2 to 6, the pit at 12 to 13 by 8 to 9, and the door at (10, 12). */
const BOUNDS = { w: 20, h: 14 };

function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30, fly: 40 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function cells(x0: number, y0: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(`${x},${y}`);
  return out;
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-iso-"));
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

  await ops.send({ t: "scene.update", sceneId, patch: { name: "The sunken hall", bounds: BOUNDS, fogEnabled: false, autoWalls: "all", defaultView: { x: 10, y: 7, zoom: 34 } } });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 1, y: 1, w: BOUNDS.w - 2, h: BOUNDS.h - 2 });
  await ops.send({ t: "build.height", sceneId, cells: cells(2, 3, 5, 6), height: 10 });
  await ops.send({ t: "build.stairs", sceneId, cells: cells(7, 5, 1, 2), up: "w" });
  await ops.send({ t: "build.height", sceneId, cells: cells(12, 8, 2, 2), height: -10 });
  const wall: EdgeFeature = { kind: "wall" };
  const edges: { key: string; feature: EdgeFeature }[] = [];
  for (let x = 1; x < BOUNDS.w - 1; x++) {
    edges.push({ key: `${x},1,n`, feature: wall });
    edges.push({ key: `${x},${BOUNDS.h - 1},n`, feature: x === 10 ? { kind: "door", state: "closed", secret: false, discovered: false } : wall });
  }
  for (let y = 1; y < BOUNDS.h - 1; y++) {
    edges.push({ key: `1,${y},w`, feature: wall });
    edges.push({ key: `${BOUNDS.w - 1},${y},w`, feature: wall });
  }
  await ops.send({ t: "build.edge", sceneId, edges });
  await ops.send({ t: "build.label", sceneId, labelId: randomUUID(), label: { x: 3, y: 4, text: "Dais", size: 0.7 } });

  const token = (name: string, x: number, y: number, extra: Record<string, unknown>) => ({
    t: "token.create",
    token: { id: randomUUID(), sceneId, kind: "monster", name, size: "medium", x, y, visibility: "all", actor: { inline: actor() }, ...extra },
  });
  await ops.send(token("Thorn", 4, 5, { kind: "npc", disposition: "ally", elevation: 10 }));
  await ops.send(token("Bree", 5, 6, { kind: "npc", disposition: "ally", elevation: 10 }));
  await ops.send(token("Goblin", 14, 7, { disposition: "hostile" }));
  await ops.send(token("Imp", 10, 4, { disposition: "hostile", size: "tiny", elevation: 20 }));
  await waitFor("the four tokens", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 4 ? true : null));

  // The scene's starting view, then Isometric picked and turned once from the View menu, as a DM would.
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  const view = dm.getByRole("button", { name: /^View: / });
  await view.click();
  const menu = dm.getByRole("dialog", { name: "View" });
  await menu.waitFor();
  await menu.getByRole("radio", { name: "Isometric", exact: true }).check();
  await menu.getByRole("button", { name: "Turn right", exact: true }).click();
  await waitFor("Isometric, turned once", async () => ((await view.getAttribute("aria-label")) === "View: Isometric" ? true : null));
  await picture(dm, "isometric-menu");
  await dm.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  // Escape hands focus back to the View button, whose tooltip would show in the picture.
  await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await dm.mouse.move(0, WINDOW.height / 2);
  assert.equal(await view.getAttribute("aria-label"), "View: Isometric");
  await picture(dm, "isometric");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
