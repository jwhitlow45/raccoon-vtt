import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { framesFor, silentFrames } from "#shared/audio/mp3Testutil.ts";
import type { SoundUse } from "#shared/sound.ts";
import { ConsoleWatch, openSideTab, OpSocket, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The Sound panel (docs/design/design-v1-music.md 4.1, 4.3 and 4.6, lane
 * SN-D), on the real server serving the production build with ROOM_SOUND
 * on. Dana the DM is at a desk and Pat on a phone. Sounds are made of
 * frames of silence (shared/audio/mp3Testutil.ts), so no step needs an
 * encoder, and the browsers start with autoplay allowed, since what plays
 * is the engine's and sound.e2e.ts's:
 * - sp-0: the room, Pat, two scenes, and three music tracks, five
 *   background sounds and an effect uploaded and created.
 * - sp-1: the DM's panel with nothing playing, its sections in order and
 *   the storage line.
 * - sp-2: a playlist made on its page, played, paused, resumed, stepped
 *   through Repeat, skipped and stopped, each one op.
 * - sp-3: Background's toggles, the fifth refused in words, a loop's
 *   volume for everyone, and its Stop.
 * - sp-4: the board's built-ins and the room's effect fired, Edit opening
 *   an effect's page with the uses its length rules out.
 * - sp-5: a sound's page refusing the delete of a playing loop and of a
 *   track of the run, and a rename on Enter.
 * - sp-6: a scene's sound saved from what plays, started by Move players,
 *   silence saved and Clear.
 * - sp-7: Players see what is playing: Pat's panel by name and by count.
 * - sp-8: the X-card's Stop the sound.
 * - sp-9: a second server with the switch off: the one line, Built in and
 *   no Add buttons, and a sound upload refused.
 * - sp-10: an effect deleted from its page on a second tap, its file with
 *   it.
 * - mfa-1: an effect fired behind a blackout, with nothing else playing:
 *   Stop all sound and the X-card's Stop the sound while it sounds, and
 *   neither once it is over.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty-eight, and the
 * switch-off server on plus forty-nine, one file after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 48;
const OFF_PORT = Number(process.env.E2E_PORT ?? 3100) + 49;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-soundpanel-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E sound panel ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneA: "",
  sceneB: randomUUID(),
  sounds: {} as Record<string, string>,
  /** When the last X-card was sent: taps within 10 s of a room's card merge into it and show none. */
  xcardAt: 0,
};

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The sounds sp-0 adds, by name, with their use and length. Music is 30 s at least, so the tracks are 31 s. */
const LIBRARY: { name: string; use: SoundUse; ms: number }[] = [
  { name: "The Prancing Pony", use: "music", ms: 31_000 },
  { name: "Road", use: "music", ms: 32_000 },
  { name: "March", use: "music", ms: 33_000 },
  { name: "Rain", use: "loop", ms: 3_000 },
  { name: "Crowd", use: "loop", ms: 3_000 },
  { name: "Wind", use: "loop", ms: 3_000 },
  { name: "Fire", use: "loop", ms: 3_000 },
  { name: "Drip", use: "loop", ms: 3_000 },
  { name: "Thunder", use: "effect", ms: 1_000 },
];

async function join(context: BrowserContext, name: string, color: string, origin = server.origin): Promise<string> {
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await context.request.post(`${origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

async function createRoom(page: Page, context: BrowserContext, origin: string, name: string): Promise<{ roomId: string; password: string; ops: OpSocket }> {
  await page.goto(`${origin}/`);
  await page.getByLabel("Room name").fill(name);
  await page.getByLabel("Your name").fill("Dana the DM");
  const password = await page.getByLabel("Player password").inputValue();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  assert.ok(match, `DM link looks wrong: ${link}`);
  const roomId = match[1]!.replace("-", "");
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  const cookie = (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  return { roomId, password, ops: await OpSocket.open({ origin, roomId, cookie }) };
}

/** Uploads a sound file of frames of silence and creates its sound, as the DM's Add buttons do (4.2 step 6). */
async function addSound(entry: (typeof LIBRARY)[number]): Promise<string> {
  const bytes = silentFrames(framesFor(entry.ms));
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=sound`, { headers: { Origin: server.origin, "content-type": "audio/mpeg" }, data: Buffer.from(bytes) });
  assert.ok(res.ok(), `the ${entry.name} upload answered ${res.status()}: ${await res.text()}`);
  const row = (await res.json()) as { id: string };
  const id = randomUUID();
  await ops.send({ t: "sound.create", id, assetId: row.id, name: entry.name, use: entry.use, ms: entry.ms });
  return id;
}

/** The Sound panel, the side panel's tab on the desk. */
async function soundPanel(page: Page = dm): Promise<Locator> {
  await openSideTab(page, "Sound");
  return page.getByRole("tabpanel", { name: sideTabName("Sound") });
}

/** A player's Sound panel on a phone: the Panels list's row, then its sheet. */
async function patPanel(): Promise<Locator> {
  const sheet = pat.locator('dialog[data-rvtt-sheet][aria-label="Sound"]');
  if (await sheet.isVisible()) return sheet;
  await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await pat.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Sound/ }).click();
  await sheet.waitFor();
  return sheet;
}

function playing() {
  return dmSocket.state?.playing ?? null;
}

async function until<T>(what: string, read: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  return (await waitFor(what, () => read() || null, ms)) as T;
}

async function back(panel: Locator): Promise<void> {
  await dm.getByRole("button", { name: /^Back to Sound/ }).first().click();
  await panel.getByRole("heading", { name: "Music", exact: true }).waitFor();
}

describe("the Sound panel", { concurrency: false }, () => {
  before(async () => {
    // startServer passes this process's environment on: every step but sp-9 runs with the switch on.
    process.env.ROOM_SOUND = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: ["--autoplay-policy=no-user-gesture-required"] });
    dmContext = await browser.newContext({ viewport: DESK });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("sp-0. a DM's room with Pat on a phone, two scenes, and nine sounds", async () => {
    const made = await createRoom(dm, dmContext, server.origin, run.roomName);
    run.roomId = made.roomId;
    run.password = made.password;
    ops = made.ops;
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneA = dmSocket.state!.meta.playerSceneId!;
    await ops.send({ t: "scene.update", sceneId: run.sceneA, patch: { name: "Tavern" } });
    await ops.send({ t: "scene.create", scene: { id: run.sceneB, name: "Forest road", bounds: { w: 20, h: 14 }, fogEnabled: false } });
    for (const entry of LIBRARY) run.sounds[entry.name] = await addSound(entry);
    await until("the library in the DM's copy", () => Object.keys(dmSocket.state?.sounds ?? {}).length === LIBRARY.length);
    await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    assert.deepEqual(patSocket.state?.sounds ?? {}, {}, "a player holds no library");
  });

  test("sp-1. the DM's panel with nothing playing: Now playing, Music, Background, Effects, On this device and the storage line", async () => {
    const panel = await soundPanel();
    await panel.getByText("Nothing is playing.", { exact: true }).waitFor();
    const headings = await panel.getByRole("heading", { level: 3 }).allTextContents();
    assert.deepEqual(headings, ["Now playing", "Music", "Background", "Effects", "On this device"]);
    await panel.getByText(/^Sounds use .+\. Images and sounds share the room's .+, and .+ is free\.$/).waitFor({ timeout: 15_000 });
    await shots.take(dm, "sp-1-dm-panel-silent");
  });

  test("sp-2. a playlist made on its page, then played, paused, resumed, Repeat stepped, skipped and stopped", async () => {
    const panel = await soundPanel();
    await panel.getByRole("button", { name: "New playlist", exact: true }).click();
    const name = panel.getByRole("textbox", { name: "Name" });
    await name.fill("Tavern night");
    await name.press("Enter");
    await until("the playlist's name", () => Object.values(dmSocket.state?.playlists ?? {}).some((p) => p.name === "Tavern night"));
    await panel.getByRole("button", { name: "Add tracks", exact: true }).click();
    await panel.getByRole("checkbox", { name: /^The Prancing Pony/ }).check();
    await panel.getByRole("checkbox", { name: /^Road/ }).check();
    await panel.getByRole("button", { name: "Add 2 tracks", exact: true }).click();
    const playlist = await until("two tracks in Tavern night", () => Object.values(dmSocket.state?.playlists ?? {}).find((p) => p.name === "Tavern night" && p.sounds.length === 2));
    assert.deepEqual(playlist.sounds, [run.sounds.Road, run.sounds["The Prancing Pony"]], "added in the checklist's order, by name");
    await panel.getByRole("button", { name: "Move The Prancing Pony up", exact: true }).click();
    await until("The Prancing Pony first", () => Object.values(dmSocket.state?.playlists ?? {}).find((p) => p.name === "Tavern night")?.sounds[0] === run.sounds["The Prancing Pony"]);
    await panel.getByRole("button", { name: "Play", exact: true }).click();
    await until("the playlist playing", () => playing()?.music?.playlistId === playlist.id);
    await back(panel);
    await panel.locator("[data-sound-track]").filter({ hasText: /^The Prancing Pony$/ }).waitFor();
    await panel.locator("[data-sound-run]").filter({ hasText: /^Tavern night · 1 of 2$/ }).waitFor();
    await panel.locator("[data-sound-time]").filter({ hasText: /^\d:\d\d \/ 0:31$/ }).waitFor();
    await shots.take(dm, "sp-2-dm-now-playing");

    await panel.getByRole("button", { name: "Pause", exact: true }).click();
    await until("paused", () => playing()?.music?.paused !== undefined);
    await panel.getByRole("button", { name: "Play", exact: true }).click();
    await until("resumed", () => playing()?.music && playing()?.music?.paused === undefined);
    for (const [from, to] of [["Repeat all", "one"], ["Repeat one", "off"], ["Repeat off", "all"]] as const) {
      await panel.getByRole("button", { name: from, exact: true }).click();
      await until(`Repeat ${to}`, () => playing()?.music?.repeat === to);
    }
    await panel.getByRole("button", { name: "Skip to the next track", exact: true }).click();
    await until("the second track", () => playing()?.music?.now.soundId === run.sounds.Road);
    await panel.locator("[data-sound-run]").filter({ hasText: /^Tavern night · 2 of 2$/ }).waitFor();
    await panel.getByRole("button", { name: "Stop the music", exact: true }).click();
    await until("the music stopped", () => playing() === null || playing()?.music === null);
    await panel.getByText("Nothing is playing.", { exact: true }).waitFor();
  });

  test("sp-3. Background: four loops at 70%, the fifth refused in words, a volume for everyone and Stop", async () => {
    const panel = await soundPanel();
    const list = panel.getByRole("list", { name: "Background sounds" });
    for (const loop of ["Rain", "Crowd", "Wind", "Fire"]) {
      await list.getByRole("button", { name: loop, exact: true }).click();
      await until(`${loop} playing`, () => Object.values(playing()?.loops ?? {}).some((l) => l.soundId === run.sounds[loop] && l.volume === 70));
      assert.equal(await list.getByRole("button", { name: loop, exact: true }).getAttribute("aria-pressed"), "true");
    }
    await list.getByRole("button", { name: "Drip", exact: true }).click();
    await panel.getByText("Four background sounds play at once at most. Stop one first.", { exact: true }).waitFor();
    assert.equal(Object.keys(playing()?.loops ?? {}).length, 4, "nothing sent for the fifth");
    const rain = panel.getByLabel("Rain volume for everyone", { exact: true });
    await rain.focus();
    for (let i = 0; i < 10; i++) await dm.keyboard.press("ArrowLeft");
    await until("Rain at 60%", () => Object.values(playing()?.loops ?? {}).some((l) => l.soundId === run.sounds.Rain && l.volume === 60));
    await shots.take(dm, "sp-3-dm-loops");
    await panel.getByRole("button", { name: "Stop Rain", exact: true }).click();
    await until("Rain stopped", () => !Object.values(playing()?.loops ?? {}).some((l) => l.soundId === run.sounds.Rain));
  });

  test("sp-4. the board: a built-in and the room's effect fired for everyone, and Edit opening the effect's page", async () => {
    const panel = await soundPanel();
    await panel.getByRole("button", { name: "Play Crash for everyone", exact: true }).click();
    await until("Crash fired", () => playing()?.effects.some((e) => e.builtin === "crash"));
    await panel.getByRole("button", { name: "Play Thunder for everyone", exact: true }).click();
    await until("Thunder fired", () => playing()?.effects.some((e) => e.soundId === run.sounds.Thunder));
    const effects = panel.getByRole("heading", { name: "Effects", exact: true }).locator("xpath=ancestor::section[1]");
    await effects.getByRole("button", { name: "Edit", exact: true }).click();
    await effects.getByRole("button", { name: /^Thunder/ }).click();
    await dm.getByRole("button", { name: /^Back to Sound/ }).first().waitFor();
    const music = panel.getByRole("radio", { name: "Music", exact: true });
    assert.equal(await music.isDisabled(), true, "a 1-second sound cannot be music");
    await panel.getByText("Music is 30 seconds at least. Background sounds are 2 seconds at least.", { exact: true }).waitFor();
    await shots.take(dm, "sp-4-dm-sound-page");
    await back(panel);
    await effects.getByRole("button", { name: "Done", exact: true }).click();
    await effects.getByRole("button", { name: "Play Thunder for everyone", exact: true }).waitFor();
  });

  test("sp-5. a sound's page refuses the delete of a playing loop and of a track of the run, in words, and renames on Enter", async () => {
    const panel = await soundPanel();
    // Crowd plays since sp-3. Its page opens from Background's Edit.
    const background = panel.getByRole("heading", { name: "Background", exact: true }).locator("xpath=ancestor::section[1]");
    await background.getByRole("button", { name: "Edit", exact: true }).click();
    await background.getByRole("button", { name: "Edit Crowd", exact: true }).click();
    await panel.getByRole("button", { name: "Delete", exact: true }).click();
    await panel.getByText("Stop it first. It is playing now.", { exact: true }).waitFor();
    assert.ok(dmSocket.state?.sounds?.[run.sounds.Crowd!], "nothing deleted");
    const name = panel.getByRole("textbox", { name: "Name" });
    await name.fill("Tavern crowd");
    await name.press("Enter");
    await until("the rename", () => dmSocket.state?.sounds?.[run.sounds.Crowd!]?.name === "Tavern crowd");
    await back(panel);
    await background.getByRole("button", { name: "Done", exact: true }).click();

    await panel.getByRole("button", { name: "Play March", exact: true }).click();
    await until("March playing", () => playing()?.music?.now.soundId === run.sounds.March);
    await panel.getByRole("list", { name: "Tracks" }).getByRole("button", { name: /^March/ }).click();
    await panel.getByRole("button", { name: "Delete", exact: true }).click();
    await panel.getByText("Stop the music first: this track is in the playlist that's playing.", { exact: true }).waitFor();
    await back(panel);
  });

  test("sp-6. a scene's sound: saved from what plays, started by Move players, silence saved, and Clear", async () => {
    const panel = await soundPanel();
    // The DM shows Forest road on their own screen; the players stay in the Tavern.
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
    await scenes.getByRole("button", { name: /^Forest road/ }).first().click();
    await waitFor("the DM on Forest road", () => dmSocket.you?.sceneId === run.sceneB || null);
    await soundPanel();
    await panel.getByText("Forest road has no sound of its own.", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Use what's playing", exact: true }).click();
    const saved = await until("Forest road's sound", () => dmSocket.state?.scenes[run.sceneB]?.sound);
    assert.equal(saved.music?.soundId, run.sounds.March);
    assert.deepEqual(saved.loops.map((l) => l.soundId).sort(), [run.sounds.Crowd, run.sounds.Fire, run.sounds.Wind].sort());
    await panel.getByText(/^Forest road's sound: March, (Tavern crowd|Wind|Fire), (Tavern crowd|Wind|Fire), (Tavern crowd|Wind|Fire)\.$/).waitFor();
    await panel.getByRole("button", { name: "Stop all sound", exact: true }).click();
    await until("silence", () => playing() === null || (playing()?.music === null && Object.keys(playing()?.loops ?? {}).length === 0));

    // Move players there: the scene's sound starts behind the move.
    await openSideTab(dm, "Scenes");
    await scenes.getByRole("button", { name: "Move players to Forest road", exact: true }).click();
    // Forest road's fog is off, so the move asks first (features/scenes/SceneList.tsx).
    const anyway = scenes.getByRole("button", { name: "Move anyway", exact: true });
    if (await anyway.waitFor({ timeout: 2_000 }).then(() => true, () => false)) await anyway.click();
    await until("the players on Forest road", () => dmSocket.state?.meta.playerSceneId === run.sceneB);
    await until("its music by the move", () => playing()?.music?.now.soundId === run.sounds.March);
    assert.equal(Object.keys(playing()?.loops ?? {}).length, 3);

    await soundPanel();
    await panel.getByRole("button", { name: "Use silence", exact: true }).click();
    await until("silence saved", () => dmSocket.state?.scenes[run.sceneB]?.sound?.music === null && dmSocket.state?.scenes[run.sceneB]?.sound?.loops.length === 0);
    await panel.getByText("Forest road is silent.", { exact: true }).waitFor();
    await shots.take(dm, "sp-6-dm-scene-silent");
    await panel.getByRole("button", { name: "Clear", exact: true }).click();
    await until("no sound of its own", () => dmSocket.state?.scenes[run.sceneB] && dmSocket.state.scenes[run.sceneB]!.sound === undefined);
  });

  test("sp-7. Players see what is playing: Pat's panel by name with it on, by count with it off", async () => {
    const panel = await soundPanel();
    await until("something plays for Pat", () => patSocket.state?.playing?.music);
    const sheet = await patPanel();
    await sheet.getByText("Music is playing.", { exact: true }).waitFor();
    await sheet.getByText("3 background sounds are playing.", { exact: true }).waitFor();
    await shots.take(pat, "sp-7-pat-panel-unnamed");
    await panel.getByRole("switch", { name: "Players see what is playing" }).click();
    await sheet.getByText("Music: March", { exact: true }).waitFor();
    await sheet.getByText(/^Background: /).waitFor();
    await shots.take(pat, "sp-7-pat-panel-named");
    await panel.getByRole("switch", { name: "Players see what is playing" }).click();
    await sheet.getByText("Music is playing.", { exact: true }).waitFor();
  });

  test("sp-8. the X-card's Stop the sound stops it all", async () => {
    const sent = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
    assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
    run.xcardAt = Date.now();
    const card = dm.getByRole("dialog", { name: "X-card" });
    await card.waitFor();
    await shots.take(dm, "sp-8-dm-xcard");
    await card.getByRole("button", { name: "Stop the sound", exact: true }).click();
    await until("silence", () => playing() === null || (playing()?.music === null && Object.keys(playing()?.loops ?? {}).length === 0));
    await card.getByRole("button", { name: "Stop the sound", exact: true }).waitFor({ state: "detached" });
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  });

  test("sp-10. deleting an effect from its page takes two taps, removes the sound, and its file goes with it", async () => {
    const panel = await soundPanel();
    const effects = panel.getByRole("heading", { name: "Effects", exact: true }).locator("xpath=ancestor::section[1]");
    const assetId = dmSocket.state!.sounds![run.sounds.Thunder!]!.assetId;
    await effects.getByRole("button", { name: "Edit", exact: true }).click();
    await effects.getByRole("button", { name: /^Thunder/ }).click();
    await panel.getByRole("button", { name: "Delete", exact: true }).click();
    await panel.getByText("Delete Thunder? Its file goes too, and it leaves every playlist and scene.", { exact: true }).waitFor();
    assert.ok(dmSocket.state?.sounds?.[run.sounds.Thunder!], "one tap deletes nothing");
    await panel.getByRole("button", { name: "Delete Thunder", exact: true }).click();
    await until("Thunder gone", () => !dmSocket.state?.sounds?.[run.sounds.Thunder!]);
    await panel.getByRole("heading", { name: "Music", exact: true }).waitFor();
    await waitFor("its file deleted", async () => ((await dmContext.request.get(`${server.origin}/api/assets/${assetId}/full`)).status() === 404 ? true : null), 15_000);
    // The room has no effect of its own left, so Effects offers no Edit, and the board shows the built-ins alone.
    await effects.getByText("No effects of the room's own yet.", { exact: true }).waitFor();
    assert.equal(await effects.getByRole("button", { name: /^(Edit|Done)$/ }).count(), 0);
  });

  test("mfa-1. an effect fired behind a blackout keeps Stop all sound and the X-card's Stop the sound while it sounds, and neither once it is over", async () => {
    // sp-8 stopped everything and sp-10 deleted Thunder, so an 8-second Gong is the room's one effect, and nothing else plays.
    run.sounds.Gong = await addSound({ name: "Gong", use: "effect", ms: 8_000 });
    await until("Gong in the DM's copy", () => dmSocket.state?.sounds?.[run.sounds.Gong!]);
    await ops.send({ t: "view.blackout", blackout: true });
    await until("the blackout", () => dmSocket.state?.meta.view.blackout === true);
    try {
      const panel = await soundPanel();
      const stopAll = panel.getByRole("button", { name: "Stop all sound", exact: true });
      assert.equal(await stopAll.count(), 0, "nothing sounds yet");
      await panel.getByRole("button", { name: "Play Gong for everyone", exact: true }).click();
      await until("Gong in the DM's own list", () => playing()?.dmEffects?.some((e) => e.soundId === run.sounds.Gong));
      assert.ok(playing()?.music === null && Object.keys(playing()?.loops ?? {}).length === 0 && playing()?.effects.length === 0, "nothing else");
      await stopAll.waitFor();
      assert.deepEqual(alignmentLines(await measureAlignment(panel), "Now playing with an effect behind a blackout, 1440x900"), []);
      await panel.getByRole("heading", { name: "Now playing", exact: true }).scrollIntoViewIfNeeded();
      await shots.take(dm, "mfa-1-dm-blackout-effect");
      // Over, it is history: the panel renders again at its end and the button goes.
      await stopAll.waitFor({ state: "detached", timeout: 15_000 });

      // A tap within 10 s of the last card merges into it, so this one waits for its own.
      const wait = run.xcardAt + 10_500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const sent = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
      assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
      run.xcardAt = Date.now();
      const card = dm.getByRole("dialog", { name: "X-card" });
      await card.waitFor();
      const stopSound = card.getByRole("button", { name: "Stop the sound", exact: true });
      assert.equal(await stopSound.count(), 0, "nothing sounds");
      await ops.send({ t: "effect.fire", id: "mfa-gong", soundId: run.sounds.Gong! });
      await stopSound.waitFor();
      await shots.take(dm, "mfa-1-dm-xcard-effect");
      await stopSound.click();
      await until("the DM's effect stopped", () => (playing()?.dmEffects ?? []).length === 0);
      await stopSound.waitFor({ state: "detached" });
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
    } finally {
      await ops.send({ t: "view.blackout", blackout: false });
    }
  });

  test("sp-9. with the server's switch off: the one line, Built in and On this device, and a sound upload refused", async () => {
    process.env.ROOM_SOUND = "0";
    const offAssets = path.join(work, "off-assets");
    const off = await startServer({ port: OFF_PORT, assetDir: offAssets, databaseUrl: DATABASE_URL });
    const context = await browser.newContext({ viewport: DESK });
    const page = await context.newPage();
    let roomId = "";
    let socket: OpSocket | null = null;
    try {
      const made = await createRoom(page, context, off.origin, `${run.roomName} off`);
      roomId = made.roomId;
      socket = made.ops;
      const panel = (await openSideTab(page, "Sound"), page.getByRole("tabpanel", { name: sideTabName("Sound") }));
      await panel.getByText("This server doesn't offer sound files. Its owner can turn them on. The built-in effects still work.", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Play Click for everyone", exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: /^Add / }).count(), 0, "no Add buttons");
      assert.equal(await panel.getByRole("heading", { name: "Music", exact: true }).count(), 0);
      await shots.take(page, "sp-9-dm-switch-off");
      const res = await context.request.put(`${off.origin}/api/rooms/${roomId}/assets?kind=sound`, { headers: { Origin: off.origin, "content-type": "audio/mpeg" }, data: Buffer.from(silentFrames(framesFor(1_000))) });
      assert.equal(res.ok(), false);
      assert.deepEqual(await res.json(), { error: "sound_off" });
    } finally {
      socket?.close();
      if (roomId) await context.request.delete(`${off.origin}/api/rooms/${roomId}`, { headers: { Origin: off.origin }, data: { name: `${run.roomName} off` } }).catch(() => {});
      await context.close();
      await off.stop();
      process.env.ROOM_SOUND = "1";
    }
  });
});
