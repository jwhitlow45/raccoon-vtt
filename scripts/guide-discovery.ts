/**
 * The DM guide's pictures of what players' maps hold (docs/dm-guide.md,
 * "What players' maps hold", docs/design/design-v1-map-discovery.md),
 * taken from the real server on the production build so they always show
 * the app as it is:
 *
 * - discovery-player.webp: Ben's phone in the Sunken halls, with Bree's
 *   torch lighting the hall and the start of the corridor, which runs on into
 *   the dark with no wall across it, and a treasury his map does not hold.
 * - forget-question.webp: the DM's question before clearing the Great
 *   cavern's build, which the party has seen and left, would run past what
 *   their map can keep.
 *
 * The room is e2e/mapdiscovery.e2e.ts's, cut down to what the two pictures
 * need. It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the pictures to docs/dm-guide/ at 1280 x 800 for the computer
 * and 390 x 844 for the phone, as the guide's other pictures are, and
 * deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3196 node scripts/guide-discovery.ts
 *
 * GUIDE_COPY_DIR, when set, also gets each picture as guide-<name>.png, which
 * it never overwrites, for looking at the pictures at full quality.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { knownAt } from "../shared/discoveryTestutil.ts";
import { CHUNK_CELLS, type EdgeFeature, type PlayerChunk, type RoomState } from "../shared/model.ts";
import { isCellFullyFogged } from "../shared/rules/fog.ts";
import { uuidv7 } from "../shared/ids.ts";
import { OpSocket, openSideTab, pagePoint, pickTool, ROOT, SocketWatch, sleep, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3196);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;

const HALLS = {
  bounds: { w: 24, h: 12 },
  hall: { x: 0, y: 1, w: 7, h: 7 },
  corridor: { x: 7, y: 4, w: 17, h: 1 },
  treasury: { x: 14, y: 7, w: 7, h: 4 },
  breeAt: { x: 2, y: 4 },
  moleAt: { x: 9, y: 9 },
};
const CAVERN = { bounds: { w: 80, h: 64 }, breeAt: { x: 40, y: 32 } };
const TORCH = { bright: 20, dim: 20 };
const roomName = "The drowned king";

function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
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

function chunkOf(state: RoomState | null, sceneId: string, x: number, y: number): PlayerChunk | undefined {
  return state?.buildChunks[`${sceneId}:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`] as PlayerChunk | undefined;
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-discovery-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let roomId = "";
let ops: OpSocket | null = null;
const dmContext: BrowserContext = await browser.newContext({ viewport: DESK });
const benContext: BrowserContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
try {
  const origin = server.origin;
  const dm = await dmContext.newPage();
  const ben = await benContext.newPage();
  const dmSocket = new SocketWatch("dm");
  const benSocket = new SocketWatch("ben");
  await dmSocket.attach(dmContext, dm);
  await benSocket.attach(benContext, ben);
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
  const halls = dmSocket.state!.meta.playerSceneId!;
  const cavern = uuidv7();
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  // The Sunken halls: a hall, a corridor east into the dark, and a treasury south of it that no light of the party's reaches.
  await ops.send({ t: "scene.update", sceneId: halls, patch: { name: "Sunken halls", bounds: HALLS.bounds, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "dark" } } });
  await ops.send({ t: "build.rect", sceneId: halls, terrain: "stone", ...HALLS.hall });
  await ops.send({ t: "build.rect", sceneId: halls, terrain: "stone", ...HALLS.corridor });
  await ops.send({ t: "build.rect", sceneId: halls, terrain: "wood", ...HALLS.treasury });
  const door: EdgeFeature = { kind: "door", state: "closed", secret: false, discovered: false };
  await ops.send({ t: "build.edge", sceneId: halls, edges: ["2,1,n", "4,1,n"].map((key) => ({ key, feature: door })) });
  // The Great cavern: bright and floored in stone wall to wall, so clearing it out of the party's sight runs past what their map keeps.
  await ops.send({ t: "scene.create", scene: { id: cavern, name: "Great cavern", bounds: CAVERN.bounds, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "bright" } } });
  for (let y = 0; y < CAVERN.bounds.h; y += 16) await ops.send({ t: "build.rect", sceneId: cavern, terrain: "stone", x: 0, y, w: CAVERN.bounds.w, h: 16 });

  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await benContext.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await benContext.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name: "Ben", color: "#0090ff" } });
  const benId = ((await done.json()) as { member: { id: string } }).member.id;
  const pc = (id: string, sceneId: string, name: string, at: { x: number; y: number }, dark = false) => ({
    t: "token.create" as const,
    token: { id, sceneId, kind: "pc" as const, disposition: "ally" as const, name, size: "medium" as const, ...at, visibility: "all" as const, ownerIds: [benId], actor: { inline: actor() }, ...(dark ? {} : { light: TORCH }) },
  });
  const breeHalls = uuidv7();
  const breeCavern = uuidv7();
  await ops.send(pc(breeHalls, halls, "Bree", HALLS.breeAt));
  await ops.send(pc(uuidv7(), halls, "Mole", HALLS.moleAt, true));
  await ops.send(pc(breeCavern, cavern, "Bree", CAVERN.breeAt));
  await ben.goto(`${origin}/r/${roomId}`);
  await ben.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor("Ben's snapshot", () => benSocket.state);
  await ben.locator(".konvajs-content").first().waitFor();

  // Shot 1: Ben's phone in the halls, closer in than the whole scene, as the e2e file takes it.
  await waitFor("the hall and its corridor on Ben's map", () => (knownAt(chunkOf(benSocket.state, halls, 8, 4), 8, 4) && chunkOf(benSocket.state, halls, 2, 4)?.cells["2,4"] === "stone" ? true : null));
  const middle = await pagePoint(ben, HALLS.bounds, { x: 6, y: 5 });
  await ben.mouse.move(middle.x, middle.y);
  await ben.mouse.wheel(0, -400);
  await ben.waitForTimeout(600);
  await picture(ben, "discovery-player");
  await ben.mouse.wheel(0, 400);
  await ben.waitForTimeout(400);

  // Shot 2: the party sees the whole cavern and leaves it, and the DM's Clear build there asks first.
  const playersTo = async (sceneId: string) => {
    await ops!.send({ t: "room.setPlayerScene", sceneId });
    await waitFor("the players on the scene", () => (benSocket.state?.meta.playerSceneId === sceneId ? true : null));
  };
  await playersTo(cavern);
  await waitFor("the cavern explored on Ben's map", () => (benSocket.state && !isCellFullyFogged(benSocket.state.fogTiles, cavern, { x: CAVERN.bounds.w - 1, y: CAVERN.bounds.h - 1 }) ? true : null));
  await playersTo(halls);
  await openSideTab(dm, "Scenes");
  await dm.getByRole("button", { name: /^Great cavern/ }).click();
  await waitFor("the DM on the cavern", () => (dmSocket.you?.sceneId === cavern ? true : null), 30_000);
  await dm.locator(".konvajs-content").first().waitFor();
  await waitFor("the cavern's explored tiles in the DM's copy", () => (Object.keys(dmSocket.state?.exploredTiles ?? {}).some((k) => k.startsWith(`${cavern}:`)) ? true : null));
  await pickTool(dm, "Map builder");
  await dm.getByRole("toolbar", { name: "Map builder options" }).getByRole("button", { name: "More options" }).click();
  const more = dm.getByRole("dialog", { name: "More Map builder options" });
  await more.getByRole("button", { name: "Clear build", exact: true }).click();
  await more.getByRole("button", { name: "Tap again to clear" }).click();
  if (await more.isVisible()) await dm.keyboard.press("Escape");
  await dm.getByRole("dialog", { name: "Remembered map" }).waitFor();
  await sleep(500);
  await picture(dm, "forget-question");
  await dm.getByRole("dialog", { name: "Remembered map" }).getByRole("button", { name: "Cancel" }).click();
} finally {
  ops?.close();
  if (roomId) {
    const res = await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => null);
    if (res && !res.ok()) console.error(`Deleting room ${roomId} answered ${res.status()}`);
  }
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
