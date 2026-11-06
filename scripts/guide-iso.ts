/**
 * The DM guide's pictures of the isometric view (docs/dm-guide.md, "The
 * isometric view" and "Areas in Isometric", docs/design/design-v1-isometric-view.md,
 * design-v1-iso-area-shapes.md and design-v1-iso-depth.md): the DM's board in
 * Isometric, turned once, with the View menu open over it, then closed, then
 * with three areas standing, and last a close view of the stairs and an
 * open door. They are taken from the real server on the production build so
 * they always show the app as it is.
 *
 * The scene is a stone hall with a raised dais up a stair at its west end,
 * a pit in its floor and a door in its south wall. Thorn and Bree stand on
 * the dais, a goblin waits by the pit, and an imp flies 20 ft over the
 * floor, its shadow on the ground under it.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/isometric.webp, isometric-menu.webp,
 * isometric-areas.webp and isometric-detail.webp at 1280 x 800, as the
 * guide's other pictures are, and deletes the room:
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

/** 20 by 14 squares: the hall inside a wall, the dais over columns 2 to 6 with a stair three squares wide up to it, the pit at 12 to 13 by 8 to 9, and the door at (10, 12). */
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
  await ops.send({ t: "build.stairs", sceneId, cells: cells(7, 4, 1, 3), up: "w" });
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

  const ids = { thorn: randomUUID(), bree: randomUUID(), goblin: randomUUID(), imp: randomUUID() };
  const token = (id: string, name: string, x: number, y: number, extra: Record<string, unknown>) => ({
    t: "token.create",
    token: { id, sceneId, kind: "monster", name, size: "medium", x, y, visibility: "all", actor: { inline: actor() }, ...extra },
  });
  await ops.send(token(ids.thorn, "Thorn", 4, 5, { kind: "npc", disposition: "ally", elevation: 10 }));
  await ops.send(token(ids.bree, "Bree", 5, 6, { kind: "npc", disposition: "ally", elevation: 10 }));
  await ops.send(token(ids.goblin, "Goblin", 14, 7, { disposition: "hostile" }));
  await ops.send(token(ids.imp, "Imp", 10, 4, { disposition: "hostile", size: "tiny", elevation: 20 }));
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

  // Areas in Isometric: the imp moves near the north wall, which cuts off the Fireball round it.
  const dmId = dmSocket.you!.memberId;
  await ops.send({ t: "token.update", tokenId: ids.imp, patch: { x: 14, y: 4 } });
  const areas = { fireball: randomUUID(), guardians: randomUUID(), moonbeam: randomUUID() };
  const area = (id: string, color: string, spell: string, t: Record<string, unknown>) =>
    ops!.send({ t: "template.create", template: { id, sceneId, yaw: 0, includeOrigin: true, color, spell, ownerId: dmId, visibility: "all", ...t } });
  await area(areas.fireball, "#e5484d", "Fireball", { shape: "sphere", size: 20, origin: { x: 14.5, y: 4.5, z: 20 }, casterId: ids.thorn });
  await area(areas.guardians, "#f5d90a", "Spirit Guardians", { shape: "emanation", size: 15, origin: { x: 5.5, y: 6.5, z: 10 }, attachedTo: ids.bree, casterId: ids.bree, includeOrigin: false });
  await area(areas.moonbeam, "#3fa7ff", "Moonbeam", { shape: "cylinder", size: 5, height: 40, origin: { x: 13, y: 9, z: -10 }, casterId: ids.bree });
  await waitFor("the three areas", () => (Object.keys(dmSocket.state?.templates ?? {}).length === 3 ? true : null));
  await dm.waitForTimeout(500);
  await waitFor("every area standing", async () => ((await dm.getByText("Building area shapes…").count()) === 0 ? true : null));
  await picture(dm, "isometric-areas");

  // Close in on the stairs and the door, with the door open, the goblin climbing the back stair and the imp flown off out of the way.
  for (const id of Object.values(areas)) await ops.send({ t: "template.delete", templateId: id });
  await ops.send({ t: "token.update", tokenId: ids.imp, patch: { x: 19, y: 12 } });
  await ops.send({ t: "token.update", tokenId: ids.goblin, patch: { x: 7, y: 6, elevation: 0 } });
  await ops.send({ t: "door.set", sceneId, door: { edge: "10,13,n" }, state: "open" });
  await ops.send({ t: "scene.update", sceneId, patch: { defaultView: { x: 8, y: 10, zoom: 96 } } });
  await dm.reload();
  // Isometric's board is the visible stage now, Top-down's hidden under it.
  await dm.locator(".konvajs-content:visible").first().waitFor();
  await waitFor("Isometric after the reload", async () => ((await view.getAttribute("aria-label")) === "View: Isometric" ? true : null));
  // The side panel hidden, so the close view has the window.
  await dm.getByRole("button", { name: "Hide panels" }).click();
  await dm.mouse.move(0, WINDOW.height / 2);
  await picture(dm, "isometric-detail");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
