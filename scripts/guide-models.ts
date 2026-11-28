/**
 * The DM guide's picture of 3D models in the isometric view (docs/dm-guide.md,
 * "3D models", docs/design/design-v1-token-models.md), taken from the real
 * server on the production build, as guide-iso.ts takes the isometric
 * view's, in a "Guide examples" room.
 *
 * The model is a mini on a round base built here from primitives, never
 * art (client/features/models/fixtures.testutil.ts), read as an STL through
 * the 3D model sheet as a DM would: a Medium knight in Stone, another in
 * Bronze turned to face east, and a Large one in Iron, with a goblin that
 * keeps its icon. models-sheet.webp is the Bronze knight's 3D model sheet,
 * its file read and its color picked, before Save.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/models-isometric.webp and models-sheet.webp at 1280 x 800, as the
 * guide's other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3198 node scripts/guide-models.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { binaryStl, figure, zUp } from "../client/features/models/fixtures.testutil.ts";
import { namedId, OpSocket, pagePoint, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3198);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const BOUNDS = { w: 12, h: 9 };

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

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-models-"));
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

  await ops.send({ t: "scene.update", sceneId, patch: { name: "Knights' hall", bounds: BOUNDS, fogEnabled: false, defaultView: { x: 6, y: 4.5, zoom: 70 } } });
  const knights = [
    // Spread across the view, so none stands in front of another and draws its covered outline.
    { name: "Stone knight", x: 2, y: 6, size: "medium", color: "stone", rotation: 0 },
    { name: "Bronze knight", x: 4, y: 4, size: "medium", color: "bronze", rotation: 90 },
    { name: "Iron knight", x: 6, y: 1, size: "large", color: "iron", rotation: 0 },
  ] as const;
  for (const k of knights) {
    await ops.send({ t: "token.create", token: { id: namedId(k.name), sceneId, kind: "npc", name: k.name, size: k.size, x: k.x, y: k.y, rotation: k.rotation, visibility: "all", disposition: "ally", actor: { inline: actor() } } });
  }
  await ops.send({ t: "token.create", token: { id: namedId("Goblin"), sceneId, kind: "monster", name: "Goblin", size: "small", x: 9, y: 7, visibility: "all", disposition: "hostile", image: { icon: "delapouite/goblin-head", color: "#e93d82" }, actor: { inline: actor() } } });
  await waitFor("the four tokens", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 4 ? true : null));
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();

  // Each knight's model read through its 3D model sheet, as a DM adds one.
  const stl = Buffer.from(binaryStl(zUp(figure(48))));
  for (const k of knights) {
    await dm.keyboard.press("Escape");
    const span = k.size === "large" ? 2 : 1;
    const at = await pagePoint(dm, BOUNDS, { x: k.x + span / 2, y: k.y + span / 2 });
    await dm.mouse.click(at.x, at.y);
    const bar = dm.getByRole("dialog", { name: `${k.name} actions` });
    await bar.waitFor();
    await bar.getByRole("button", { name: "Details", exact: true }).click();
    const panel = dm.getByRole("tabpanel", { name: "Token", exact: true });
    await panel.getByRole("heading", { name: k.name, exact: true }).first().waitFor();
    const image = panel.getByRole("button", { name: "Image", exact: true });
    if ((await image.getAttribute("aria-expanded")) === "false") await image.click();
    await panel.getByRole("button", { name: "3D model", exact: true }).click();
    const sheet = dm.getByRole("dialog", { name: "3D model", exact: true });
    await sheet.locator('input[type="file"]').setInputFiles({ name: "knight.stl", mimeType: "application/octet-stream", buffer: stl });
    await sheet.locator("[data-model-options]").waitFor({ timeout: 30_000 });
    if (k.color !== "stone") {
      await sheet.getByRole("combobox", { name: "Color" }).selectOption(k.color);
      await waitFor("the drawing in its color", async () => ((await sheet.getByRole("button", { name: "Save", exact: true }).isEnabled()) ? true : null));
    }
    // The sheet itself, read and colored but not yet saved, for the guide's picture of its choices.
    if (k.name === "Bronze knight") {
      // The Stone knight's "Saved." toast left to go by itself, and the sheet scrolled to its foot so Size shows whole.
      await dm.locator("[data-toast]").first().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
      await sheet.evaluate((el) => {
        type Box = { scrollHeight: number; clientHeight: number; scrollTop: number };
        const g = globalThis as unknown as { getComputedStyle(b: Box): { overflowY: string }; scrollTo(x: number, y: number): void; document: { scrollingElement: Box | null } };
        const body = Array.from((el as unknown as { querySelectorAll(s: string): ArrayLike<Box> }).querySelectorAll("*")).find(
          (b) => b.scrollHeight > b.clientHeight + 4 && /(auto|scroll)/.test(g.getComputedStyle(b).overflowY),
        );
        if (body) body.scrollTop = body.scrollHeight;
        // Only the sheet's own body scrolls: the room under it stays framed as it was.
        g.scrollTo(0, 0);
        if (g.document.scrollingElement) g.document.scrollingElement.scrollTop = 0;
      });
      await dm.mouse.move(0, WINDOW.height / 2);
      await picture(dm, "models-sheet");
    }
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await waitFor(`${k.name}'s model`, () => dmSocket.state?.tokens[namedId(k.name)]?.image?.model);
  }
  await dm.keyboard.press("Escape");
  // The saves' toasts tapped away, so the picture shows the board alone.
  for (let i = 0; i < 8; i++) {
    const toast = dm.locator("button[data-toast], div[data-toast] > button").filter({ visible: true });
    if ((await toast.count()) === 0) break;
    await toast.first().click({ timeout: 1000 }).catch(() => {});
  }

  // Isometric picked from the View menu, as a DM would, with the side panel hidden so the hall has the window.
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
  await waitFor("the knights standing as their models", () =>
    dm.evaluate(() => {
      const konva = (globalThis as unknown as { Konva: { stages: { width(): number; find(s: string): unknown[] }[] } }).Konva;
      return konva.stages.some((s) => s.width() > 0 && s.find(".standeeModel").length >= 3) || null;
    }),
  );
  await picture(dm, "models-isometric");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
