/**
 * The DM guide's picture of tokens placed between squares (docs/dm-guide.md,
 * "Between squares", docs/design/design-v1-snap-off.md), taken from the real
 * server on the production build so it always shows the app as it is.
 *
 * The room is a stone hall with a goblin and Bree one square apart, each
 * placed 3/8 of a square toward the other, so they look adjacent. The
 * goblin is selected: the dashed outline marks the square the rules count
 * it in, and its window shows Place freely and Snap to grid in its play row.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/between-squares.webp at 1280 x 800, as the
 * guide's other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-snapoff.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, ROOT, SocketWatch, startServer, tapCell, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const BOUNDS = { w: 14, h: 10 };

function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-snapoff-"));
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

  await ops.send({ t: "scene.update", sceneId, patch: { name: "Goblin Warren", bounds: BOUNDS, fogEnabled: false, defaultView: { x: 6, y: 4.5, zoom: 84 } } });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 1, y: 1, w: BOUNDS.w - 2, h: BOUNDS.h - 2 });
  await ops.send({ t: "build.rect", sceneId, terrain: "rubble", x: 2, y: 6, w: 3, h: 2 });
  await ops.send({ t: "build.label", sceneId, labelId: randomUUID(), label: { x: 4.5, y: 2, text: "Guard room", size: 0.45 } });
  const goblin = randomUUID();
  const bree = randomUUID();
  const token = (id: string, name: string, kind: "pc" | "monster", disposition: "ally" | "hostile", x: number, y: number) => ({
    t: "token.create",
    token: { id, sceneId, kind, name, size: "medium", x, y, visibility: "all", disposition, actor: { inline: actor() } },
  });
  await ops.send(token(goblin, "Goblin", "monster", "hostile", 3, 4));
  await ops.send(token(bree, "Bree", "pc", "ally", 5, 4));
  // Each 3/8 of a square toward the other: one square apart by the rules, and they look adjacent.
  await ops.send({ t: "token.update", tokenId: goblin, patch: { drawnAt: { x: 3.375, y: 4 } } });
  await ops.send({ t: "token.update", tokenId: bree, patch: { drawnAt: { x: 4.625, y: 4 } } });
  await waitFor("both placed", () => (dmSocket.state?.tokens[goblin]?.nudge && dmSocket.state?.tokens[bree]?.nudge ? true : null));

  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await tapCell(dm, BOUNDS, { x: 3, y: 4 });
  await dm.getByRole("dialog", { name: "Goblin actions, placed between squares", exact: true }).waitFor();
  await waitFor("the goblin's outline", () =>
    dm.evaluate((id) => {
      const konva = (globalThis as unknown as { Konva: { stages: { width(): number; findOne(s: string): { isVisible(): boolean } | undefined }[] } }).Konva;
      return konva.stages.some((s) => s.width() > 0 && s.findOne(`#${id}-rules`)?.isVisible()) || null;
    }, goblin),
  );
  await picture(dm, "between-squares");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
