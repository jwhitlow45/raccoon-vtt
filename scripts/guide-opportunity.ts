/**
 * The DM guide's picture of Opportunity Attack notices (docs/dm-guide.md,
 * "Opportunity Attacks", docs/design/design-v1-opportunity-attacks.md), on a
 * DM's computer, taken from the real server on the production build so it
 * always shows the app as it is:
 * - opportunity-attacks.webp: a Goblin Warrior's turn in a guard room. Its
 *   first step left Thorn's reach, so its turn card lists Thorn with Reaction
 *   used, and the DM drags it on past Bree, its label reading "Leaves Bree's
 *   reach" with a dashed ring round her.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes the picture at 1280 x 800, as the guide's other computer
 * pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3198 node scripts/guide-opportunity.ts
 */
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { loadMonsters, monsterActor } from "../shared/srd/monsters.ts";
import { assertCanvasAt, OpSocket, openSideTab, pagePoint, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3198);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const BOUNDS = { w: 18, h: 10 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 16, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

/** The words on the board's canvas, as Konva holds them. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages.flatMap((s) => s.find("Text")).filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/** Presses on a cell's center and moves to another's in small steps, as a mouse would, still held down there. */
async function holdDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, BOUNDS, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(page, BOUNDS, { x: to.x + 0.5, y: to.y + 0.5 });
  await assertCanvasAt(page, a);
  await assertCanvasAt(page, b);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 16, a.y + ((b.y - a.y) * i) / 16);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-opportunity-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
let ops: OpSocket | null = null;
const dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
  const sceneId = dmSocket.state!.meta.playerSceneId!;

  // Ana plays Thorn and Ben plays Bree, so the tracker shows them as the party's from the start.
  const headers = { Origin: origin, "content-type": "application/json" };
  // Each joins from a context of its own, so the DM's cookie stays the DM's.
  const join = async (name: string, color: string): Promise<string> => {
    const player = await browser.newContext();
    try {
      const joined = await player.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await player.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name, color } });
      return ((await done.json()) as { member: { id: string } }).member.id;
    } finally {
      await player.close();
    }
  };

  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });
  const ana = await join("Ana", "#30a46c");
  const ben = await join("Ben", "#3e63dd");
  await ops.send({ t: "scene.update", sceneId, patch: { name: "Guard room", bounds: BOUNDS, fogEnabled: false } });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 1, y: 1, w: BOUNDS.w - 2, h: BOUNDS.h - 2 });
  const thorn = randomUUID();
  const bree = randomUUID();
  const thornToken = randomUUID();
  const breeToken = randomUUID();
  const goblin = randomUUID();
  await ops.send({ t: "character.create", character: { id: thorn, name: "Thorn", size: "medium", ownerIds: [ana], actor: actor(52) } });
  await ops.send({ t: "character.create", character: { id: bree, name: "Bree", size: "medium", ownerIds: [ben], actor: actor(38) } });
  // The goblin starts beside Thorn, and its first step, one square on the diagonal, ends beside Bree.
  await ops.send({ t: "token.create", token: { id: thornToken, sceneId, kind: "pc", name: "Thorn", size: "medium", x: 2, y: 4, visibility: "all", disposition: "ally", actor: { ref: thorn } } });
  await ops.send({ t: "token.create", token: { id: breeToken, sceneId, kind: "pc", name: "Bree", size: "medium", x: 4, y: 6, visibility: "all", disposition: "ally", actor: { ref: bree } } });
  const srd = await loadMonsters();
  const block = monsterActor(srd.find((m) => m.srdId === "goblin-warrior")!);
  await ops.send({ t: "token.create", token: { id: goblin, sceneId, kind: "monster", name: "Goblin Warrior", size: "small", x: 3, y: 4, visibility: "all", disposition: "hostile", actor: { inline: block } } });

  const goblinEntry = randomUUID();
  await ops.send({ t: "encounter.start", entries: [{ id: goblinEntry, tokenId: goblin, value: 18 }, { id: randomUUID(), tokenId: thornToken, value: 15 }, { id: randomUUID(), tokenId: breeToken, value: 12 }] });
  await ops.send({ t: "encounter.next" });
  await waitFor("the goblin's turn", () => (dmSocket.state?.encounter?.activeEntryId === goblinEntry ? true : null));

  await openSideTab(dm, "Initiative");
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("0");
  await dm.waitForTimeout(1000);

  // Its first leg: away from Thorn, a step that ends beside Bree.
  await holdDrag(dm, { x: 3, y: 4 }, { x: 4, y: 5 });
  await dm.waitForTimeout(500);
  await dm.mouse.up();
  await waitFor("the goblin's first step", () => (dmSocket.state?.tokens[goblin]?.y === 5 ? true : null));
  const block2 = dm.getByRole("group", { name: "Opportunity Attacks" });
  await block2.getByRole("button", { name: "Reaction used: Thorn", exact: true }).waitFor();

  // Its second, held: on along the room, out of Bree's reach.
  await holdDrag(dm, { x: 4, y: 5 }, { x: 7, y: 5 });
  try {
    await waitFor("the drag's leaves line", async () => ((await boardTexts(dm)).some((t) => t.includes("\nLeaves Bree's reach")) ? true : null), 10_000);
    await dm.waitForTimeout(900);
    await picture(dm, "opportunity-attacks");
  } finally {
    await dm.keyboard.press("Escape");
    await dm.mouse.up();
  }
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
