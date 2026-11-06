/**
 * The DM guide's pictures of music and sound (docs/dm-guide.md, "Music and
 * sound", docs/design/design-v1-music-player.md 11.6): Ambiance's Sound
 * group while a playlist and two background sounds play, the Music window
 * on a computer with Library beside Now playing and Up next, the playlist
 * maker on a computer, and Up next on a phone with a track's More menu
 * open, taken from the real server on the production build so they always
 * show the app as it is.
 *
 * The room is a tavern with Thorn and Bree in it and a clock running. Its
 * library holds 22 tracks of silence in three playlists, two background
 * sounds and two effects. Tavern night plays from its third track, a
 * minute and a half in, with the rain and the crowd under it.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL, and turns the
 * server's sound switch on for itself. It makes a room, writes
 * docs/dm-guide/sound-panel.webp, music-window.webp and music-maker.webp
 * at 1280 x 800, as the guide's other pictures are, and music-up-next.webp
 * at a phone's 390 x 844, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3197 node scripts/guide-music.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { framesFor, silentFrames } from "../shared/audio/mp3Testutil.ts";
import { openSideTab, OpSocket, ROOT, sideTabName, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const PLAYLISTS: Record<string, string[]> = {
  "Tavern night": [
    "The Prancing Pony",
    "Fireside tales",
    "Last orders",
    "The bard's lament",
    "Candlelit cellar",
    "Rainy evening",
    "Dice and ale",
    "A quiet corner",
    "Songs of the north",
    "The innkeeper's daughter",
    "Lanterns in the window",
    "Closing time",
  ],
  Battle: ["Goblin ambush", "Steel and fire", "The dragon wakes", "Last stand", "Victory"],
  Travel: ["Road to Phandalin", "Morning on the road", "Mountain pass", "Harbor at dusk", "Forest of whispers"],
};
/** Lengths from two to four minutes, so the library's minutes read like a real one's. */
const LENGTHS = [128_000, 151_000, 174_000, 196_000, 214_000, 238_000];

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

function musicWindow(page: Page): Locator {
  return page.locator("dialog[open]").filter({ has: page.locator("[data-music-window]") });
}

process.env.ROOM_SOUND = "1";
const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-music-"));
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
  const send = ops.send.bind(ops);

  await send({ t: "scene.update", sceneId, patch: { name: "The Gilded Boar", bounds: { w: 16, h: 12 }, fogEnabled: false, defaultView: { x: 8, y: 6, zoom: 40 } } });
  await send({ t: "build.rect", sceneId, terrain: "wood", x: 1, y: 1, w: 14, h: 10 });
  for (const [name, x, y] of [["Thorn", 6, 5], ["Bree", 8, 6]] as const) {
    await send({ t: "token.create", token: { id: randomUUID(), sceneId, kind: "npc", name, size: "medium", x, y, visibility: "all", disposition: "ally", actor: { inline: actor() } } });
  }
  // A clock, so Time stands folded with the date above the Weather row and Sound, as a DM's Ambiance does in play.
  await send({ t: "clock.start", id: randomUUID(), at: 2 * 86_400 + 20 * 3_600, shown: true, calendar: { kind: "days" } });

  const upload = async (ms: number): Promise<string> => {
    const res = await dmContext.request.put(`${origin}/api/rooms/${roomId}/assets?kind=sound`, { headers: { Origin: origin, "content-type": "audio/mpeg" }, data: Buffer.from(silentFrames(framesFor(ms), { kbps: 64 })) });
    if (!res.ok()) throw new Error(`the upload answered ${res.status()}`);
    return ((await res.json()) as { id: string }).id;
  };
  const files: { id: string; ms: number }[] = [];
  for (const ms of LENGTHS) files.push({ id: await upload(ms), ms });
  const sound = async (name: string, use: "music" | "loop" | "effect", file: { id: string; ms: number }): Promise<string> => {
    const id = randomUUID();
    await send({ t: "sound.create", id, assetId: file.id, name, use, ms: file.ms });
    return id;
  };
  const playlists: Record<string, { id: string; sounds: string[] }> = {};
  let n = 0;
  for (const [name, tracks] of Object.entries(PLAYLISTS)) {
    const sounds: string[] = [];
    for (const track of tracks) sounds.push(await sound(track, "music", files[n++ % files.length]!));
    const id = randomUUID();
    await send({ t: "playlist.create", id, name, sounds, repeat: "all", fade: 5 });
    playlists[name] = { id, sounds };
  }
  const short = async (ms: number) => ({ id: await upload(ms), ms });
  const rain = await sound("Rain on the windows", "loop", await short(8_000));
  const crowd = await sound("Tavern crowd", "loop", await short(8_000));
  const effect = await short(1_000);
  await sound("Door slam", "effect", effect);
  await sound("Thunder", "effect", effect);

  // Tavern night from its third track, a minute and a half in, with the rain and the crowd under it.
  const tavern = playlists["Tavern night"]!;
  const run = randomUUID();
  await send({ t: "music.play", run, playlistId: tavern.id, order: tavern.sounds, index: 2, repeat: "all", fade: 5 });
  await send({ t: "music.jump", run: randomUUID(), from: run, soundId: tavern.sounds[2]!, ms: 90_000, on: tavern.sounds[2]! });
  for (const soundId of [rain, crowd]) await send({ t: "loop.start", id: randomUUID(), soundId, volume: 70 });

  await dm.reload();
  await dm.locator(".konvajs-content").first().waitFor();
  await openSideTab(dm, "Ambiance");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("Ambiance") });
  await panel.locator("[data-sound-next]").waitFor();
  await picture(dm, "sound-panel");

  // The Music window on a computer: Library beside Now playing and Up next.
  await panel.locator("[data-music-open]").click();
  const win = musicWindow(dm);
  await win.locator("[data-music-wide]").waitFor();
  await picture(dm, "music-window");

  // The maker on Tavern night: its settings, its tracks in order, and the room's other music to add.
  await win.getByRole("list", { name: "Playlists" }).getByRole("button", { name: /^Tavern night/ }).click();
  await win.getByRole("heading", { name: "Tavern night", exact: true }).waitFor();
  await picture(dm, "music-maker");
  await win.getByRole("button", { name: "Back to Music", exact: true }).click();
  await win.getByRole("button", { name: /^Close/ }).last().click();

  // Up next on a phone: the tall sheet's Now playing, scrolled to Up next, with its third track's More open, where Play next can act.
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, storageState: await dmContext.storageState() });
  const page = await phone.newPage();
  await page.goto(`${origin}/r/${roomId}`);
  await page.locator(".konvajs-content").first().waitFor();
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Ambiance/ }).click();
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Ambiance"]');
  await sheet.locator("[data-music-open]").click();
  const tall = musicWindow(page);
  const upNext = tall.getByRole("list", { name: "Up next" });
  await upNext.waitFor();
  await tall.locator("[data-music-upnext]").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await upNext.locator("[data-music-more]").nth(2).click();
  await page.getByRole("menu").last().waitFor();
  await picture(page, "music-up-next");
  await phone.close();
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
