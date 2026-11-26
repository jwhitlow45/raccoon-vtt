/**
 * The DM guide's pictures of four things at the table (docs/dm-guide.md),
 * taken from the real server on the production build so they always show
 * the app as it is:
 *
 * - armed-confirm.webp: Fog's More options pop-up on a narrow window used
 *   with a mouse, after the first press of Fog all, so its whole question
 *   reads "Click again: fog all".
 * - map-edge.webp: a player's phone after Thorn, a Large creature, was
 *   dropped past the map's right edge and stands against it.
 * - x-card.webp: the card a player's phone shows when anyone sends the X-card.
 * - x-card-dm.webp: the same card on the DM's computer, with the DM's two
 *   extra buttons.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the pictures to docs/dm-guide/ at 1280 x 800 for the computer
 * and 390 x 844 for the phone and the narrow window, as the guide's other
 * pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3195 node scripts/guide-table.ts
 *
 * GUIDE_COPY_DIR, when set, also gets each picture as guide-<name>.png, which
 * it never overwrites, for looking at the pictures at full quality.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { OpSocket, pagePoint, pickTool, ROOT, SocketWatch, sleep, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3195);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;
const roomName = "Guide examples";
const YARD = { w: 10, h: 8 };

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

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-table-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let roomId = "";
let ops: OpSocket | null = null;
const dmContext: BrowserContext = await browser.newContext({ viewport: DESK });
const benContext: BrowserContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
let mouseContext: BrowserContext | null = null;
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
  const yard = dmSocket.state!.meta.playerSceneId!;
  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });

  // A small yard with a margin of dark around it for a drop past the edge. Fog comes on for the second picture, since Fog all is offered only where the scene has fog.
  await ops.send({ t: "scene.update", sceneId: yard, patch: { name: "Orchard", bounds: YARD, fogEnabled: false, defaultView: { x: YARD.w / 2, y: YARD.h / 2, zoom: 30 } } });
  await ops.send({ t: "build.rect", sceneId: yard, terrain: "grass", x: 0, y: 0, w: YARD.w, h: YARD.h });

  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await benContext.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await benContext.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name: "Ben", color: "#0090ff" } });
  const benId = ((await done.json()) as { member: { id: string } }).member.id;
  const thorn = randomUUID();
  await ops.send({
    t: "token.create",
    token: { id: thorn, sceneId: yard, kind: "pc", disposition: "ally", name: "Thorn", size: "large", x: 6, y: 3, visibility: "all", ownerIds: [benId], actor: { inline: actor() } },
  });
  await ben.goto(`${origin}/r/${roomId}`);
  await ben.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor("Ben's snapshot", () => benSocket.state);
  await ben.locator(".konvajs-content").first().waitFor();

  // Picture 1: Thorn dropped past the right edge, which the app brings back so all of Thorn is on the map.
  await waitFor("Thorn on Ben's map", () => (benSocket.state?.tokens[thorn] ? true : null));
  const from = await pagePoint(ben, YARD, { x: 7, y: 4 });
  const past = await pagePoint(ben, YARD, { x: YARD.w + 0.9, y: 4 });
  await ben.mouse.move(from.x, from.y);
  await ben.mouse.down();
  await ben.mouse.move(from.x + (past.x - from.x) * 0.2, from.y, { steps: 4 });
  await ben.mouse.move(past.x, past.y, { steps: 14 });
  await ben.mouse.up();
  const landed = await waitFor("Thorn against the edge", () => {
    const t = benSocket.state?.tokens[thorn];
    return t && t.x > 6 ? t : null;
  });
  console.log(`Thorn landed at ${landed.x}, ${landed.y} on a ${YARD.w} by ${YARD.h} map`);
  if (landed.x + 2 !== YARD.w) throw new Error(`Thorn should stand against the right edge (x ${YARD.w - 2}), found x ${landed.x}`);
  await picture(ben, "map-edge");

  // Picture 2: the DM's Fog options on a narrow window with a mouse.
  await ops.send({ t: "scene.update", sceneId: yard, patch: { fogEnabled: true } });
  mouseContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, storageState: await dmContext.storageState() });
  const narrow = await mouseContext.newPage();
  await narrow.goto(`${origin}/r/${roomId}`);
  await narrow.locator(".konvajs-content").first().waitFor();
  await pickTool(narrow, "Fog");
  const bar = narrow.getByRole("toolbar", { name: "Fog options" });
  await bar.waitFor();
  await bar.getByRole("button", { name: "More options" }).click();
  const more = narrow.getByRole("dialog", { name: "More Fog options" });
  await more.getByRole("button", { name: "Fog all", exact: true }).click();
  await more.getByRole("button", { name: "Click again: fog all" }).waitFor();
  await picture(narrow, "armed-confirm");
  await narrow.keyboard.press("Escape");
  await mouseContext.close();
  mouseContext = null;

  // Pictures 3 and 4: Ben sends the X-card, and every device shows the same card.
  await ops.send({ t: "scene.update", sceneId: yard, patch: { fogEnabled: false } });
  const picker = ben.getByRole("list", { name: "Panels" });
  if (!(await picker.isVisible())) await ben.locator('button[title="Panels"]').tap();
  await picker.getByRole("button", { name: /^Menu$/ }).tap();
  await ben.getByRole("button", { name: /^X-card/ }).tap();
  await ben.getByRole("button", { name: "Send the X-card" }).tap();
  const words = "Someone used the X-card. Edit out what just happened, with no questions asked.";
  await ben.getByRole("dialog", { name: "X-card" }).getByText(words).waitFor();
  await dm.getByRole("dialog", { name: "X-card" }).getByText(words).waitFor();
  await sleep(500);
  await picture(ben, "x-card");
  await picture(dm, "x-card-dm");
} finally {
  ops?.close();
  await mouseContext?.close().catch(() => undefined);
  if (roomId) {
    const res = await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => null);
    if (res && !res.ok()) console.error(`Deleting room ${roomId} answered ${res.status()}`);
  }
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
