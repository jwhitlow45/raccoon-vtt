/**
 * The DM guide's pictures of time in the scene (docs/dm-guide.md, "Time and
 * the calendar", "Timed effects" and Light), taken from the real server on
 * the production build so they always show the app as it is:
 *
 * - effect-time-span.webp: Bree's Blessed and Hasted with the times they end,
 * - light-time-of-day.webp: the scene's Light on Time of day, and
 * - time-dawn-dusk.webp: the Time panel's Dawn and dusk open to change.
 *
 * The clock reads Day 2, 6:20 PM on days with no calendar, with dawn at 5:30 AM and dusk at 6:00 PM. Bree is Blessed
 * for 8 hours and Hasted for 90 minutes, and dusk is at 6:00 PM, so the light
 * reads Dim.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a room,
 * writes the pictures to docs/dm-guide/ at 1280 x 800, as the guide's other
 * pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-timed.ts
 */
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { openSideTab, OpSocket, ROOT, sideTabName, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const HOUR = 3_600;
/** Day 2, 6:20 PM, on a clock of days. */
const START = 86_400 + 18 * HOUR + 20 * 60;

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  // A notice such as "Saved. Undo in Setup history." is gone before the picture, which shows the page.
  await page.locator("[data-toast]").first().waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

/** Puts `target` at the top of the side panel's scroll, and the page itself back at the top. */
async function scrollToTop(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    const box = (el as unknown as { closest(s: string): { scrollTop: number; getBoundingClientRect(): { top: number } } | null }).closest('[role="tabpanel"]');
    let scroller = box as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number; parentElement: unknown; getBoundingClientRect(): { top: number } } | null;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 5)) scroller = scroller.parentElement as typeof scroller;
    if (scroller) scroller.scrollTop += (el as unknown as { getBoundingClientRect(): { top: number } }).getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
  });
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-timed-"));
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

  const thorn = randomUUID();
  const bree = randomUUID();
  await ops.send({ t: "character.create", character: { id: thorn, name: "Thorn", size: "medium", ownerIds: [], actor: actor(52) } });
  await ops.send({ t: "character.create", character: { id: bree, name: "Bree", size: "medium", ownerIds: [], actor: actor(38) } });
  const token = (id: string, characterId: string, name: string, x: number, y: number) => ({
    t: "token.create",
    token: { id, sceneId, kind: "pc", name, size: "medium", x, y, visibility: "all", disposition: "ally", ownerIds: [], actor: { ref: characterId } },
  });
  await ops.send(token(randomUUID(), thorn, "Thorn", 10, 8));
  await ops.send(token(randomUUID(), bree, "Bree", 11, 9));
  await ops.send({ t: "clock.start", id: randomUUID(), at: START, shown: true, calendar: { kind: "days" } });
  // Dawn at 5:30 AM and dusk at 6:00 PM.
  await ops.send({ t: "clock.update", daylight: { dawn: 5.5 * HOUR, dusk: 18 * HOUR } });
  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();

  // Bree's Blessed for 8 hours and Hasted for 90 minutes, added as a DM adds them.
  await openSideTab(dm, "Characters");
  const characters = dm.getByRole("tabpanel", { name: sideTabName("Characters") });
  await characters.locator(`[data-opener="character:${bree}"]`).click();
  const combat = characters.getByRole("button", { name: "Combat", exact: true });
  if ((await combat.getAttribute("aria-expanded")) === "false") await combat.click();
  const conditions = characters.locator('xpath=.//section[*[self::h3 or self::h4][normalize-space()="Conditions"] or *[not(self::section)]/*[self::h3 or self::h4][normalize-space()="Conditions"]]');
  const add = async (label: RegExp, length: (section: Locator) => Promise<void>) => {
    await conditions.getByRole("button", { name: "Add", exact: true }).click();
    await conditions.getByRole("button", { name: label }).first().click();
    await length(conditions);
    await conditions.getByRole("button", { name: "Add", exact: true }).click();
    await conditions.getByRole("button", { name: "Back", exact: true }).waitFor({ state: "detached" });
  };
  await add(/Blessed/, async (s) => void (await s.getByRole("combobox", { name: "Duration", exact: true }).selectOption({ label: "8 hours" })));
  await add(/Hasted/, async (s) => {
    await s.getByRole("combobox", { name: "Duration", exact: true }).selectOption({ label: "Other length of time" });
    await s.getByRole("textbox", { name: "Length", exact: true }).fill("90");
    await s.getByRole("combobox", { name: "Unit", exact: false }).or(s.getByRole("combobox").last()).last().selectOption({ label: "Minutes" });
  });
  await conditions.getByText(/^Lasts 90 minutes, to 7:50 PM/).waitFor();
  await dm.mouse.move(5, 790);
  await picture(dm, "effect-time-span");

  // The scene's Light on Time of day.
  const scenes = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
  await openSideTab(dm, "Scenes");
  // Light works with party vision, which Explore turns on.
  await scenes.getByRole("radio", { name: /^Explore/ }).first().click();
  const fold = scenes.locator("button[aria-expanded]").filter({ hasText: /^Light and weather/ }).first();
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await scenes.getByRole("radio", { name: "Time of day", exact: true }).or(scenes.getByRole("button", { name: "Time of day", exact: true })).first().click();
  await scenes.getByText(/It is Dim now/).waitFor();
  await scrollToTop(fold);
  await dm.mouse.move(5, 790);
  await picture(dm, "light-time-of-day");

  // The Time panel's Dawn and dusk, open to change with Dawn in focus.
  await openSideTab(dm, "Time");
  const time = dm.getByRole("tabpanel", { name: sideTabName("Time") });
  await time.locator("[data-clock-date]").waitFor();
  await time.getByRole("button", { name: "Change", exact: true }).click();
  await time.getByLabel("Dawn", { exact: true }).waitFor();
  await scrollToTop(time.getByText("Sharing", { exact: true }).first());
  await dm.mouse.move(5, 790);
  await picture(dm, "time-dawn-dusk");
  await time.getByRole("button", { name: "Cancel", exact: true }).click();
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
