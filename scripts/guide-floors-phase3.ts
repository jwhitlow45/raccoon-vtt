/**
 * The DM guide's pictures of floors from a file or a dungeon and of the
 * walking ruler over stairs (docs/dm-guide.md, "A floor from a file or a
 * dungeon" and "Measuring up the stairs", docs/design/design-v1-floors.md
 * phase 3), taken from the real server on the production build so they
 * always show the app as it is:
 *
 * - floors-map-choice.webp: the Floors group of Tower on a computer, Map on
 *   VTT file with its help line above the two adds.
 * - floors-dungeon-floor.webp: Generate a dungeon aimed at a floor above
 *   Ground floor, on Custom at the floor's size.
 * - floors-ruler-button.webp: Ana's phone, her Walking ruler from Thorn to
 *   the stairs, with Up the stairs in its row.
 * - floors-ruler-carried.webp: the same ruler after the press, on Upper
 *   floor, with a stop added past the landing and "before this floor" under
 *   the total.
 *
 * The dungeon's seed is fixed, so the same app version draws the same
 * dungeon each time the pictures are made again.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the four pictures to docs/dm-guide/ at 1280 x 800 for the
 * computer and 390 x 844 for the phone, as the guide's other pictures are,
 * and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-floors-phase3.ts
 *
 * GUIDE_COPY_DIR, when set, also gets each picture as guide-<name>.png, which
 * it never overwrites, for looking at the pictures at full quality.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { versionChar } from "../client/features/dungeon/seed.ts";
import { OpSocket, openSceneGroup, openSideTab, pagePoint, pickOption, pickTool, ROOT, sideTabName, SocketWatch, sleep, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const COPY_DIR = process.env.GUIDE_COPY_DIR;
const SEED = `${versionChar()}K7Q-H2MX-A9F3-TWQ5`;
const BOUNDS = { w: 14, h: 10 };
/** Thorn's square, 20 ft west of the stairs. */
const START = { x: 2, y: 4 };
const STAIRS = { x: 6, y: 4 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(1000);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
  if (COPY_DIR !== undefined) {
    mkdirSync(COPY_DIR, { recursive: true });
    // "wx" fails on a file already there, so an earlier picture is never overwritten.
    writeFileSync(path.join(COPY_DIR, `guide-${name}.png`), png, { flag: "wx" });
  }
}

/** A ruler drag between two cells' centers, in small steps, as a finger draws it. */
async function measureDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, BOUNDS, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(page, BOUNDS, { x: to.x + 0.5, y: to.y + 0.5 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await page.mouse.up();
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-floors3-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
let ops: OpSocket | null = null;
const dmContext = await browser.newContext({ viewport: DESK });
let anaContext: BrowserContext | null = null;
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

  // Ana plays Thorn on a phone.
  anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await anaContext.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await anaContext.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name: "Ana", color: "#30a46c" } });
  const anaId = ((await done.json()) as { member: { id: string } }).member.id;

  // Tower: a stone ground floor and a wooden upper floor, which stairs join below.
  const upper = randomUUID();
  const thorn = randomUUID();
  await ops.send({ t: "scene.update", sceneId: ground, patch: { name: "Tower", bounds: BOUNDS, fogEnabled: false } });
  await ops.send({ t: "scene.create", scene: { id: upper, name: "Tower", bounds: BOUNDS }, floor: { beside: ground, side: "above", besideName: "Ground floor" } });
  await ops.send({ t: "scene.update", sceneId: upper, patch: { floor: { name: "Upper floor", height: 10 } } });
  await ops.send({ t: "build.rect", sceneId: ground, terrain: "stone", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "build.rect", sceneId: upper, terrain: "wood", x: 1, y: 1, w: 12, h: 8 });
  await ops.send({ t: "character.create", character: { id: thorn, name: "Thorn", size: "medium", ownerIds: [anaId], actor: actor(24) } });
  await ops.send({ t: "token.create", token: { id: randomUUID(), sceneId: ground, kind: "pc", name: "Thorn", ownerIds: [anaId], actor: { ref: thorn }, ...START, size: "medium", visibility: "all", disposition: "ally" } });
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();

  // The Floors group with Map on VTT file.
  await openSideTab(dm, "Scenes");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  const group = await openSceneGroup(panel, "Floors");
  await group.getByRole("radio", { name: "VTT file", exact: true }).check();
  await group.getByText("A map from Dungeondraft, Dungeon Alchemist, Arkenforge or DungeonFog, with its walls, doors and lights, at the file's size.", { exact: true }).waitFor();
  // The group's own heading at the top, so the picture shows which group it is.
  await group.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
  await picture(dm, "floors-map-choice");

  // Generate a dungeon aimed at a floor above Ground floor.
  await group.getByRole("radio", { name: "Dungeon", exact: true }).check();
  await group.getByRole("button", { name: "Add a floor above", exact: true }).click();
  const dialog = dm.getByRole("dialog", { name: "Generate a dungeon above Ground floor", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "Seed", exact: true }).fill(SEED);
  await dialog.getByRole("img", { name: /^Preview of the dungeon: \d+ rooms?(, \d+ secret doors?)?(, \d+ lit rooms?)?, entrance on the (west|north|east|south) side\.$/ }).waitFor({ timeout: 30_000 });
  const status = dialog.locator("footer [aria-live=polite]");
  let last = "";
  await waitFor("the status line to hold still", async () => {
    const now = ((await status.innerText().catch(() => "")) || "").trim();
    const still = now === last && now !== "";
    last = now;
    return still ? now : null;
  });
  await dialog.getByText("Theme", { exact: true }).evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
  await picture(dm, "floors-dungeon-floor");
  await dialog.getByRole("button", { name: /^(Close|Cancel)$/ }).first().click();
  await dialog.waitFor({ state: "detached" });

  // Stairs go in after the DM's pictures, since they turn off Add a floor above Ground floor.
  // Players hold only floors they have reached, and the ruler offers stairs to a floor the device holds.
  await ops.send({ t: "floor.open", sceneId: upper, open: true });
  await ops.send({ t: "floorLink.put", link: { id: `s${randomUUID().slice(0, 8)}`, pairId: `s${randomUUID().slice(0, 8)}`, sceneId: ground, to: upper, rect: { ...STAIRS, w: 1, h: 1 }, kind: "stairs" } });
  await waitFor("both ends in the DM's copy", () => (Object.keys(dmSocket.state?.floorLinks ?? {}).length === 2 ? true : null));

  // Ana's phone: the Walking ruler to the stairs, then carried up.
  const ana = await anaContext.newPage();
  await ana.goto(`${origin}/r/${roomId}`);
  await ana.getByRole("status", { name: "Connected" }).first().waitFor();
  await ana.locator(".konvajs-content").first().waitFor();
  await pickTool(ana, "Ruler");
  await pickOption(ana, "Ruler", "Measure", "Walking");
  await measureDrag(ana, START, STAIRS);
  const up = ana.getByRole("toolbar", { name: "Ruler options" }).getByRole("button", { name: "Measure on up the stairs to Upper floor", exact: true });
  await up.waitFor();
  await picture(ana, "floors-ruler-button");

  await up.click();
  await ana.getByText("Viewing Upper floor.").first().waitFor();
  const world = await pagePoint(ana, BOUNDS, { x: STAIRS.x + 3.5, y: STAIRS.y + 0.5 });
  await ana.mouse.click(world.x, world.y);
  await waitFor("the carried reading", async () => (/Walking 45 ft · 30 ft before this floor/.test((await ana.getByRole("toolbar", { name: "Ruler options" }).locator("[data-options-line]").innerText().catch(() => "")).replace(/\s+/g, " ")) ? true : null), 15_000);
  await sleep(300);
  await picture(ana, "floors-ruler-carried");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
