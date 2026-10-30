/**
 * The DM guide's picture of raised hexes in the isometric view
 * (docs/dm-guide.md, "Hex scenes", docs/design-v1-iso-hex-relief.md),
 * taken from the real server on the production build, as guide-iso.ts
 * takes the isometric view's, in a "Guide examples" room.
 *
 * The scene, "Hex terrace", is hex rows over a map of colored stripes drawn
 * here in code: a terrace of 10 ft hexes round a 20 ft one with a wall on
 * its east side, a stair up to the terrace, a hollow of hexes 10 ft down
 * with one at 5 ft down, a scout and a goblin on the terrace, an ogre
 * across its ledge and a 10 ft sphere at the ledge.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/hex-relief.webp at 1280 x 800, as the guide's
 * other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-hex-relief.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { placedOnHex } from "../shared/rules/footprint.ts";
import { cornerAt, hexCenter, hexCorners, hexNeighbors, type Hex, type HexGrid } from "../shared/rules/hex.ts";
import { OpSocket, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const BOUNDS = { w: 16, h: 16 };
const G: HexGrid = { shape: "hex", orient: "rows" };

/** The map's stripes, one color a cell wide each, so a sunken floor's own pixels read at a glance. */
const STRIPES: readonly [number, number, number][] = [
  [200, 60, 60],
  [60, 170, 70],
  [60, 90, 200],
  [210, 190, 60],
  [160, 70, 180],
  [60, 180, 190],
];

function actor() {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the board settle after a change.
  await page.waitForTimeout(1200);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-hex-"));
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
  const dmId = dmSocket.you!.memberId;
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  // The stripes, 25 px a cell.
  const cellPx = 25;
  const width = BOUNDS.w * cellPx;
  const height = BOUNDS.h * cellPx;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(STRIPES[Math.floor(x / cellPx) % 6]!, (y * width + x) * 3);
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const res = await dmContext.request.put(`${origin}/api/rooms/${roomId}/assets?kind=map`, { headers: { Origin: origin, "content-type": "image/png" }, data: png });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  const asset = (await res.json()) as { id: string; width: number; height: number };

  await ops.send({ t: "scene.update", sceneId, patch: { name: "Hex terrace", bounds: BOUNDS, fogEnabled: false, gridShape: "hexRows", defaultView: { x: 8, y: 8, zoom: 46 } } });
  await ops.send({ t: "scene.setMap", sceneId, map: { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, cellPx, originPx: { x: 0, y: 0 } } });
  const key = (h: Hex) => `${h.col},${h.row}`;
  const hex = (col: number, row: number): Hex => ({ col, row });
  await ops.send({ t: "build.height", sceneId, cells: hexNeighbors(G, hex(4, 4)).map(key), height: 10 });
  await ops.send({ t: "build.height", sceneId, cells: [key(hex(4, 4))], height: 20 });
  await ops.send({ t: "build.height", sceneId, cells: [2, 4, 6].map((c) => key(hex(c, 1))), height: 5 });
  await ops.send({ t: "build.height", sceneId, cells: [key(hex(4, 7))], height: 5 });
  await ops.send({ t: "build.stairs", sceneId, cells: [key(hex(4, 7))], up: "a" });
  const hollow: string[] = [];
  for (let row = 6; row <= 10; row++) for (let col = 9; col <= 14; col++) hollow.push(key(hex(col, row)));
  await ops.send({ t: "build.height", sceneId, cells: hollow, height: -10 });
  await ops.send({ t: "build.height", sceneId, cells: [key(hex(13, 7))], height: -5 });
  const corners = hexCorners(G, hex(4, 4)).map((c) => cornerAt(G, c));
  await ops.send({ t: "build.walls", sceneId, put: [{ id: "guidehexwal1", a: [corners[1]!.x, corners[1]!.y], b: [corners[2]!.x, corners[2]!.y], f: { kind: "wall" } }] });

  const token = (name: string, at: Hex, extra: Record<string, unknown>) => {
    const size = (extra.size as "medium" | "large" | undefined) ?? "medium";
    return { t: "token.create", token: { id: randomUUID(), sceneId, kind: "monster", name, size, ...placedOnHex(G, { size, x: 0, y: 0 }, at), visibility: "all", actor: { inline: actor() }, ...extra } };
  };
  await ops.send(token("Goblin", hex(5, 4), { disposition: "hostile", elevation: 10 }));
  // The scout's perch is the goblin's terrace neighbor nearest the viewer, as the e2e case climbs it (e2e/iso.e2e.ts).
  const terrace = new Set(hexNeighbors(G, hex(4, 4)).map(key));
  const perch = hexNeighbors(G, hex(5, 4))
    .filter((h) => terrace.has(key(h)))
    .sort((a, b) => hexCenter(G, b).x + hexCenter(G, b).y - (hexCenter(G, a).x + hexCenter(G, a).y))[0]!;
  await ops.send(token("Scout", perch, { kind: "npc", disposition: "ally", elevation: 10 }));
  await ops.send(token("Ogre", hex(3, 6), { disposition: "hostile", size: "large", elevation: 0 }));
  await ops.send({ t: "template.create", template: { id: randomUUID(), sceneId, shape: "sphere", size: 10, origin: { ...hexCenter(G, hex(6, 5)), z: 5 }, yaw: 0, includeOrigin: true, color: "#3fa7ff", ownerId: dmId, visibility: "all" } });
  await waitFor("the three tokens", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 3 ? true : null));

  // The scene's starting view, then Isometric picked from the View menu, as a DM would.
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  // The side panel hidden, so the terrain has the window.
  await dm.getByRole("button", { name: "Hide panels" }).click();
  const view = dm.getByRole("button", { name: /^View: / });
  await view.click();
  const menu = dm.getByRole("dialog", { name: "View" });
  await menu.waitFor();
  await menu.getByRole("radio", { name: "Isometric", exact: true }).check();
  await waitFor("Isometric", async () => ((await view.getAttribute("aria-label")) === "View: Isometric" ? true : null));
  await dm.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  // Escape hands focus back to the View button, whose tooltip would show in the picture.
  await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await dm.mouse.move(0, WINDOW.height / 2);
  await picture(dm, "hex-relief");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
