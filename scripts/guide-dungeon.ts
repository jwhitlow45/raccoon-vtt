/**
 * The DM guide's pictures of the dungeon generator (docs/dm-guide.md,
 * "Generating a dungeon", docs/design/design-v1-dungeon-generator.md): the
 * Generate a dungeon dialog on its default choices with a preview, and the
 * scene Make the scene opens, framed on the entrance, taken from the real
 * server on the production build so they always show the app as it is.
 *
 * The seed is fixed, so the same app version draws the same dungeon each
 * time the pictures are made again.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/dungeon-generator.webp and
 * dungeon-generator-made.webp at 1280 x 800, as the guide's other pictures
 * are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-dungeon.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { versionChar } from "../client/features/dungeon/seed.ts";
import { openSideTab, ROOT, sideTabName, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
/** A seed of the generator's version, so the dungeon is the same on every run. */
const SEED = `${versionChar()}K7Q-H2MX-A9F3-TWQ5`;

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // The map's camera and the panels settle after a change.
  await page.waitForTimeout(1000);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-dungeon-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
const dmContext = await browser.newContext({ viewport: WINDOW });
try {
  const origin = server.origin;
  const dm = await dmContext.newPage();
  await dmContext.addInitScript(() => {
    try {
      localStorage.setItem("rvtt.rollAnimation", "off");
    } catch {
      // Storage is off: the animation shows, which no picture here catches.
    }
  });

  await dm.goto(`${origin}/`);
  await dm.getByLabel("Room name").fill(roomName);
  await dm.getByLabel("Your name").fill("Dana the DM");
  await dm.getByRole("button", { name: "Create room" }).click();
  await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await dm.locator("code").first().textContent()) ?? "";
  roomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)![1]!.replace("-", "");
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();

  await openSideTab(dm, "Scenes");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  const form = panel.getByRole("heading", { name: "New scene", exact: true }).locator("xpath=ancestor::*[self::section or @data-panel-group][1]");
  await form.getByRole("radio", { name: "Builder", exact: true }).click();
  await form.getByRole("textbox", { name: "Scene name" }).fill("Sunken crypt");
  await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();

  const dialog = dm.getByRole("dialog", { name: "Generate a dungeon" });
  const seed = dialog.getByRole("textbox", { name: "Seed", exact: true });
  await seed.fill(SEED);
  await dialog.getByRole("img", { name: /^Preview of the dungeon: \d+ rooms?, entrance on the (west|north|east|south) side\.$/ }).waitFor({ timeout: 30_000 });
  // The status line holds still once the preview for this seed stands.
  const status = dialog.locator("footer [aria-live=polite]");
  let last = "";
  await waitFor("the status line to hold still", async () => {
    const now = ((await status.innerText().catch(() => "")) || "").trim();
    const still = now === last && now !== "";
    last = now;
    return still ? now : null;
  });
  console.log(`status: ${last}`);
  // Typing the seed scrolled the choices to its field, so bring Theme, the first choice, back to the top.
  await dialog.getByText("Theme", { exact: true }).evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
  await picture(dm, "dungeon-generator");

  await dialog.getByRole("button", { name: "Make the scene", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 60_000 });
  await picture(dm, "dungeon-generator-made");
} finally {
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
