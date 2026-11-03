/**
 * The DM guide's pictures of the in-game clock (docs/dm-guide.md, "Time and
 * the calendar", docs/design/design-v1-calendar.md): the DM's Time panel with
 * a Months clock running, and the Calendar dialog open over it, taken from
 * the real server on the production build so they always show the app as it
 * is.
 *
 * The room is a tavern with Thorn and Bree in it. The clock uses a calendar
 * of twelve months of 30 days, a week of seven named days and the words "AF"
 * after the year, and reads Thursday, Deepwinter 4, 1204 AF, at 6:10 AM.
 * Players see it, and the party took a Long Rest to get there. The Calendar
 * dialog is scrolled down to the week, the words after the year and Today.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes docs/dm-guide/time-panel.webp and time-calendar.webp at
 * 1280 x 800, as the guide's other pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-time.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { composeDate } from "../shared/calendar.ts";
import type { Calendar } from "../shared/model.ts";
import { openSideTab, OpSocket, ROOT, sideTabName, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const HOUR = 3_600;

const MONTHS = ["Deepwinter", "Thaw", "Seedtime", "Greening", "Highsun", "Harvestmoon", "Leaffall", "Frostwatch", "Longnight", "Embers", "Snowcrest", "Yearend"];
const CALENDAR: Calendar = {
  kind: "months",
  months: MONTHS.map((name) => ({ name, days: 30 })),
  week: ["Moonday", "Tuesday", "Midweek", "Thursday", "Fireday", "Restday", "Starday"],
  era: "AF",
};

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

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-time-"));
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

  await ops.send({ t: "scene.update", sceneId, patch: { name: "The Gilded Boar", bounds: { w: 16, h: 12 }, fogEnabled: false, defaultView: { x: 8, y: 6, zoom: 40 } } });
  await ops.send({ t: "build.rect", sceneId, terrain: "wood", x: 1, y: 1, w: 14, h: 10 });
  const token = (name: string, x: number, y: number) => ({
    t: "token.create",
    token: { id: randomUUID(), sceneId, kind: "npc", name, size: "medium", x, y, visibility: "all", disposition: "ally", actor: { inline: actor() } },
  });
  await ops.send(token("Thorn", 6, 5));
  await ops.send(token("Bree", 8, 6));

  // Deepwinter 3, year 1204, at 10:00 PM, then the party's Long Rest: 8 hours on, to 6:00 AM. The panel then reads Thursday, Deepwinter 4, 1204 AF.
  const start = composeDate({ day: 3, month: 0, year: 1204, time: 22 * HOUR }, CALENDAR);
  if (!start.ok) throw new Error(start.reason);
  await ops.send({ t: "clock.start", id: randomUUID(), at: start.t, shown: true, calendar: CALENDAR });
  await ops.send({ t: "clock.advance", by: 8 * HOUR, why: "longRest" });
  await ops.send({ t: "clock.advance", by: 10 * 60 });

  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await openSideTab(dm, "Time");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Time") });
  await panel.locator("[data-clock-date]").waitFor();
  await picture(dm, "time-panel");

  await panel.getByRole("button", { name: "Calendar…" }).click();
  const dialog = dm.getByRole("dialog", { name: "Calendar" });
  await dialog.waitFor();
  // The last field of the form, so the week, the words after the year and Today all show under the months.
  await dialog.getByLabel("Time", { exact: true }).scrollIntoViewIfNeeded();
  await picture(dm, "time-calendar");
  await dialog.getByRole("button", { name: "Cancel" }).click();
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
