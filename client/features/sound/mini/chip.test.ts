import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { ReactElement } from "react";
import { createStore } from "zustand/vanilla";
import type { MusicRun, Playing, Sound } from "#shared/sound.ts";
import { room } from "#shared/testutil.ts";
import { RoomScope } from "../../../state/scope.ts";

/*
 * The Now playing chip and its player (docs/design/design-v1-sound-layout.md
 * 5 and 10.2): what it shows in each state of 5.2, kept while its player is
 * open with its stopped state, hidden for a player, with the server's
 * switch not on and with nothing playing, the crossfade's moment, where
 * focus goes as its card closes, both forms' markup and names, Pause and
 * Play, what opens the player at each width, Open Sound, and the player's
 * body: the inline Crossfade only in the popover, the Next line, the
 * volume, each background sound with its Stop, Stop all sound and Open
 * Sound.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { drawn } = await import("../../../components/testing/drawn.ts");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScopeProvider } = await import("../../../state/scope.ts");
const engine = await import("../engine/store.ts");
const { api } = await import("../../../lib/api.ts");
const { soundAskSlot, soundViewSlot } = await import("../music/open.ts");
const { panelFocusSlot } = await import("../../../pages/mapFocus.ts");
const chip = await import("./NowChip.tsx");
const { default: NowPlayer, backgroundRows } = await import("./NowPlayer.tsx");

const noop = () => {};
const sound = (id: string, use: Sound["use"], ms: number, name: string): Sound => ({ id, rev: 1, name, assetId: `a-${id}`, ms, use });
const SOUNDS = {
  a: sound("a", "music", 60_000, "Tavern at night"),
  b: sound("b", "music", 60_000, "Tavern in the rain"),
  c: sound("c", "music", 60_000, "Road to Phandalin"),
  rain: sound("rain", "loop", 40_000, "Rain on the cobblestones"),
  crowd: sound("crowd", "loop", 30_000, "Crowd"),
};
const PLAYLISTS = { p: { id: "p", rev: 0, name: "Tavern night", sounds: ["a", "b", "c"], repeat: "all" as const, fade: 5 as const } };

/** Tavern night 20 s into its first track, started on the device's clock, with `over` on the run. */
function music(over: Partial<MusicRun> = {}): MusicRun {
  return { run: "r1", playlistId: "p", order: ["a", "b", "c"], index: 0, repeat: "all", fade: 5, now: { soundId: "a", at: Date.now() - 20_000 }, ...over };
}

function playing(over: Partial<Playing> = {}): Playing {
  return { rev: 1, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 }, ...over };
}

const LOOPS: Playing["loops"] = { l2: { soundId: "crowd", at: 2_000, volume: 60 }, l1: { soundId: "rain", at: 1_000, volume: 70 } };

/** Sets the server's sound switch, as GET /api/config would answer. */
async function serverSays(on: boolean): Promise<void> {
  engine.resetServerRoomSoundForTests();
  const real = api.getConfig;
  api.getConfig = (async () => ({ roomSound: on })) as unknown as typeof api.getConfig;
  await engine.serverRoomSound();
  api.getConfig = real;
}

/** A room around `child` with `play` playing, the viewer `role`, and what it sends, opens and focuses. */
function inRoom(play: Playing | null, role: "dm" | "player" = "dm") {
  const view = room({ sounds: SOUNDS, playlists: PLAYLISTS, ...(play ? { playing: play } : null) });
  const store = createStore(() => ({ view, you: { memberId: role === "dm" ? "dm1" : "p1", role }, roomId: "r1", sceneId: "s1", serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false } }));
  const scope = new RoomScope();
  const sent: { t: string; [k: string]: unknown }[] = [];
  const opened: string[] = [];
  const focused: (string | null)[] = [];
  scope.get(panelFocusSlot).focus = (id) => focused.push(id);
  const actions = {
    dispatch(op: { t: string }) {
      sent.push(op);
      return sent.length;
    },
    newId: () => `id${sent.length}`,
    sendEph: noop,
  };
  const ui = { notify: noop, openPanel: (id: string) => opened.push(id) };
  const around = (child: ReactElement) =>
    createElement(RoomScopeProvider, { scope, children: createElement(RoomProvider, { store: store as never, actions: actions as never, ui: ui as never, assets: { url: () => "" } as never, children: child }) });
  return { around, scope, store, sent, opened, focused };
}

type ChipProps = Parameters<typeof chip.NowChip>[0];
const chipProps = (over: Partial<ChipProps> = {}): ChipProps => ({ form: "full", popover: true, dialogOpen: false, onShows: noop, openDialog: noop, ...over });
const drawChip = (r: ReturnType<typeof inRoom>, over: Partial<ChipProps> = {}) => renderToStaticMarkup(r.around(createElement(chip.NowChip, chipProps(over))));

/** Every element in a tree drawn() returned, depth first, so a test can find one by its props and press it. */
function elements(node: unknown, out: { type: unknown; props: Record<string, unknown> }[] = []): { type: unknown; props: Record<string, unknown> }[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props) {
    out.push({ type: el.type, props: el.props });
    elements(el.props.children, out);
  }
  return out;
}

const press = (tree: unknown, mark: string) => {
  const el = elements(tree).find((e) => e.props[mark] !== undefined);
  assert.ok(el, `an element marked ${mark}`);
  (el.props.onClick as () => void)();
};

afterEach(() => engine.resetServerRoomSoundForTests());

describe("what the chip shows (5.2)", () => {
  test("music playing, paused, background sounds alone, nothing", () => {
    assert.deepEqual(chip.chipShows(playing({ music: music() }), SOUNDS, PLAYLISTS, Date.now()), { t: "music", name: "Tavern at night", run: "Tavern night · 1 of 3", paused: false });
    assert.deepEqual(chip.chipShows(playing({ music: music({ paused: 20_000 }) }), SOUNDS, PLAYLISTS, Date.now()), { t: "music", name: "Tavern at night", run: "Tavern night · 1 of 3", paused: true });
    assert.deepEqual(chip.chipShows(playing({ loops: LOOPS }), SOUNDS, PLAYLISTS, Date.now()), { t: "background", count: 2 });
    assert.deepEqual(chip.chipShows(playing({ music: music(), loops: LOOPS }), SOUNDS, PLAYLISTS, Date.now())?.t, "music", "music is what it names while both play");
    assert.equal(chip.chipShows(playing(), SOUNDS, PLAYLISTS, Date.now()), null);
    assert.equal(chip.chipShows(null, SOUNDS, PLAYLISTS, Date.now()), null);
  });

  test("a crossfade names the incoming track from its start, as Now playing does", () => {
    const t = Date.now();
    const run = music({ next: { soundId: "b", at: t + 1_000 } });
    const before = chip.chipShows(playing({ music: run }), SOUNDS, PLAYLISTS, t);
    const after = chip.chipShows(playing({ music: run }), SOUNDS, PLAYLISTS, t + 1_000);
    assert.equal(before?.t === "music" ? before.name : null, "Tavern at night");
    assert.equal(after?.t === "music" ? after.name : null, "Tavern in the rain");
  });

  test("it redraws as a crossfade starts, the one moment its words change with no frame from the server, and never on a tick", () => {
    const t = Date.now();
    assert.equal(chip.crossfadeAt(music({ next: { soundId: "b", at: t + 1_000 } }), t), t + 1_000);
    assert.equal(chip.crossfadeAt(music({ next: { soundId: "b", at: t - 1 } }), t), null, "already started");
    assert.equal(chip.crossfadeAt(music(), t), null, "no next revealed");
    assert.equal(chip.crossfadeAt(music({ paused: 1_000, next: { soundId: "b", at: t + 1_000 } }), t), null, "paused, nothing changes by time");
    assert.equal(chip.crossfadeAt(null, t), null);
  });

  test("kept while its player is open, in its stopped state once playback ended", () => {
    const shows = { t: "background", count: 1 } as const;
    assert.equal(chip.keptShows(shows, false), shows);
    assert.equal(chip.keptShows(shows, true), shows, "what plays wins while open");
    assert.deepEqual(chip.keptShows(null, true), { t: "stopped" });
    assert.equal(chip.keptShows(null, false), null, "it goes as its player closes");
  });

  test("a DM's alone, and only with the server's sound switch on", () => {
    const view = room({ sounds: SOUNDS, playlists: PLAYLISTS, playing: playing({ music: music() }) });
    const dm = { you: { memberId: "dm1", role: "dm" as const }, view: view as never, serverOffset: 0 };
    assert.equal(chip.liveShows(dm, "on")?.t, "music");
    assert.equal(chip.liveShows({ ...dm, you: { memberId: "p1", role: "player" } }, "on"), null, "a player");
    for (const server of ["off", "unknown", "failed"] as const) assert.equal(chip.liveShows(dm, server), null, `the switch ${server}`);
    assert.equal(chip.liveShows({ ...dm, view: null }, "on"), null, "before the snapshot");
  });

  test("its key for the bar's fit moves with its kind and its words, and is null while it shows nothing", () => {
    assert.equal(chip.showsKey(null), null);
    assert.equal(chip.showsKey({ t: "music", name: "Tavern at night", run: "Tavern night · 1 of 3", paused: false }), "music:Tavern at night");
    assert.equal(chip.showsKey({ t: "music", name: "Tavern at night", run: "Tavern night · 2 of 3", paused: true }), "music:Paused · Tavern at night", "a pause widens it, a new place in the run does not");
    assert.equal(chip.showsKey({ t: "background", count: 2 }), "background:2 background sounds");
    assert.equal(chip.showsKey({ t: "stopped" }), "stopped:Now playing");
  });
});

describe("where focus goes as the chip's card or sheet closes (5.1)", () => {
  const at = { from: "dm chip", fromChip: false, chip: "now chip", chipDrawn: true, map: "map", goes: false };
  test("opened from the DM menu, back to the DM chip, whatever plays", () => {
    assert.equal(chip.returnTo(at), "dm chip");
    assert.equal(chip.returnTo({ ...at, goes: true }), "dm chip");
  });
  test("opened from the chip, back to the chip while something plays, else to the map's focus target", () => {
    const fromChip = { ...at, from: "now chip", fromChip: true };
    assert.equal(chip.returnTo(fromChip), "now chip");
    assert.equal(chip.returnTo({ ...fromChip, goes: true }), "map", "the chip goes as the player closes");
    assert.equal(chip.returnTo({ ...fromChip, chipDrawn: false }), "map", "the chip left the bar meanwhile");
  });
});

describe("the chip's forms and names (5.2)", () => {
  test("in full: Pause, a line, then the name with a caret in one pill, its opener named for what plays", async () => {
    await serverSays(true);
    const html = drawChip(inRoom(playing({ music: music() })));
    assert.match(html, /data-chip="nowPlaying" data-chip-form="full" data-chip-state="playing"/);
    assert.match(html, /<button[^>]*data-now-pause=""[^>]*aria-label="Pause"/);
    assert.match(html, /<button[^>]*data-now-open=""[^>]*aria-label="Now playing: Tavern at night, Tavern night · 1 of 3"/);
    assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
    assert.ok(html.indexOf("data-now-pause") < html.indexOf("data-now-open"), "Tab reaches Pause, then the name");
    assert.match(html, />Tavern at night<\/span>/);
    assert.doesNotMatch(html, /aria-live/, "not a live region");
  });

  test("paused: Play, and the name after Paused · in the muted color", async () => {
    await serverSays(true);
    const html = drawChip(inRoom(playing({ music: music({ paused: 20_000 }) })));
    assert.match(html, /data-chip-state="paused"/);
    assert.match(html, /aria-label="Play"/);
    assert.match(html, /aria-label="Now playing, paused: Tavern at night, Tavern night · 1 of 3"/);
    assert.match(html, />Paused · Tavern at night<\/span>/);
  });

  test("background sounds alone: the music icon and the count, and no Pause, which pauses music", async () => {
    await serverSays(true);
    const html = drawChip(inRoom(playing({ loops: LOOPS })));
    assert.match(html, /data-chip-state="background"/);
    assert.doesNotMatch(html, /data-now-pause/);
    assert.match(html, /aria-label="Now playing: 2 background sounds"/);
    assert.match(html, />2 background sounds<\/span>/);
  });

  test("compact: one target, the music icon in a round pill, named as in full", async () => {
    await serverSays(true);
    const html = drawChip(inRoom(playing({ music: music() })), { form: "compact" });
    assert.match(html, /<button[^>]*data-chip="nowPlaying" data-chip-form="compact"/);
    assert.equal([...html.matchAll(/<button/g)].length, 1);
    assert.match(html, /aria-label="Now playing: Tavern at night, Tavern night · 1 of 3"/);
  });

  test("hidden: for a player, with the switch off or not yet known, with nothing playing, off the bar, and before the bar gives it a form", async () => {
    const plays = playing({ music: music() });
    assert.equal(drawChip(inRoom(plays)), "", "the switch not yet known");
    await serverSays(false);
    assert.equal(drawChip(inRoom(plays)), "", "the switch off");
    await serverSays(true);
    assert.equal(drawChip(inRoom(plays, "player")), "", "a player");
    assert.equal(drawChip(inRoom(playing())), "", "nothing plays");
    assert.equal(drawChip(inRoom(null)), "", "no sound at all");
    assert.equal(drawChip(inRoom(plays), { form: "off" }), "", "off the bar: the DM menu holds it");
    assert.equal(drawChip(inRoom(plays), { form: null }), "");
    assert.notEqual(drawChip(inRoom(plays)), "");
  });

  test("kept while its card or sheet is open, in its stopped state: Now playing and the icon, no transport and no track", async () => {
    await serverSays(true);
    const html = drawChip(inRoom(playing()), { dialogOpen: true, popover: false, form: "compact" });
    assert.match(html, /data-chip-state="stopped"/);
    assert.match(html, /aria-label="Now playing, stopped"/);
    const full = drawChip(inRoom(playing()), { dialogOpen: true });
    assert.match(full, /aria-label="Now playing, stopped"/);
    assert.match(full, />Now playing<\/span>/);
    assert.doesNotMatch(full, /data-now-pause|Tavern/);
  });
});

describe("what the chip's buttons do (5.2, 5.3)", () => {
  test("Pause sends music.pause, Play music.resume with a new run", async () => {
    await serverSays(true);
    const r = inRoom(playing({ music: music() }));
    press(drawn(chip.NowChip, chipProps(), r.around), "data-now-pause");
    const paused = inRoom(playing({ music: music({ paused: 20_000 }) }));
    press(drawn(chip.NowChip, chipProps(), paused.around), "data-now-pause");
    assert.deepEqual(r.sent, [{ t: "music.pause" }]);
    assert.deepEqual(paused.sent, [{ t: "music.resume", run: "id0" }]);
  });

  test("under 900 px the name opens the card or the sheet, with the chip to hand focus back to", async () => {
    await serverSays(true);
    const r = inRoom(playing({ music: music() }));
    const asked: unknown[] = [];
    const tree = drawn(chip.NowChip, chipProps({ popover: false, form: "compact", openDialog: (from) => asked.push(from) }), r.around);
    press(tree, "data-now-open");
    assert.equal(asked.length, 1);
    assert.equal(elements(tree).some((e) => e.props.handle !== undefined), false, "no popover under 900 px");
  });

  test("from 900 px up the popover holds the player with Crossfade in place, titled Now playing, 340 px wide", async () => {
    await serverSays(true);
    const tree = drawn(chip.NowChip, chipProps(), inRoom(playing({ music: music() })).around);
    const pop = elements(tree).find((e) => e.props.handle !== undefined);
    assert.ok(pop, "the popover");
    assert.equal(pop.props.title, "Now playing");
    const body = elements(pop.props.children).find((e) => e.props.fadeControl !== undefined);
    assert.equal(body?.props.fadeControl, "inline", "the menu, a popover of its own, would close the player");
    assert.equal((elements(pop.props.children)[0]?.props.style as { width: number }).width, chip.POPOVER_BODY_PX);
  });

  test("the card and the sheet keep the Crossfade menu", () => {
    const r = inRoom(playing({ music: music() }));
    const tree = drawn(chip.NowPlayerDialog, { opener: { current: null }, onClose: noop }, r.around);
    assert.equal(elements(tree).find((e) => e.props.fadeControl !== undefined)?.props.fadeControl, "menu");
    assert.equal((tree as { props: { title: string; width: number } }).props.title, "Now playing");
    assert.equal((tree as { props: { width: number } }).props.width, 440);
  });

  test("Open Sound in the popover opens the Sound panel on Now playing at its top, focus to the panel", async () => {
    await serverSays(true);
    const r = inRoom(playing({ music: music() }));
    r.scope.get(soundViewSlot).setState({ view: "library", query: "harbor" });
    const tree = drawn(chip.NowChip, chipProps(), r.around);
    const body = elements(tree).find((e) => e.props.onOpenSound !== undefined);
    (body!.props.onOpenSound as () => void)();
    assert.deepEqual(r.opened, ["sound"]);
    assert.equal(r.scope.get(soundViewSlot).getState().view, "now");
    assert.equal(r.scope.get(soundAskSlot).getState().seq, 1, "the panel shows its top");
    assert.deepEqual(r.focused, ["sound"]);
  });
});

describe("the chip's player (5.3)", () => {
  const draw = (play: Playing | null, fadeControl: "inline" | "menu" = "inline") => renderToStaticMarkup(inRoom(play).around(createElement(NowPlayer, { fadeControl, onOpenSound: noop })));
  const order = (html: string, marks: string[]) => {
    const at = marks.map((m) => html.indexOf(m));
    for (const [i, a] of at.entries()) assert.ok(a >= 0, `${marks[i]} drawn`);
    assert.deepEqual([...at].sort((x, y) => x - y), at, `in the order ${marks.join(", ")}`);
  };

  test("with music and background sounds: the player, the Next line, the volume, Background, then Stop all sound and Open Sound", () => {
    const html = draw(playing({ music: music(), loops: LOOPS }));
    order(html, ["data-music-now", "data-now-next", "Music volume for everyone", "data-now-background", "data-now-foot"]);
    assert.match(html, /data-now-next=""[^>]*>Next: Tavern in the rain</);
    assert.match(html, /<label[^>]*>Music volume for everyone<\/label>/, "here the label keeps whose volume it is");
    assert.match(html, /<h3[^>]*>Background<\/h3>/);
    order(html, ["Rain on the cobblestones", "Crowd"]);
    assert.match(html, /aria-label="Stop Rain on the cobblestones"/);
    assert.match(html, /aria-label="Stop Crowd"/);
    const foot = html.slice(html.indexOf("data-now-foot"));
    order(foot, ["Stop all sound", "Open Sound"]);
    assert.doesNotMatch(html, /data-music-stop-all/, "Stop all sound only at the foot, not under the player too");
  });

  test("Crossfade in place in the popover, its menu in the card and the sheet", () => {
    assert.match(draw(playing({ music: music() }), "inline"), /data-music-crossfade-inline/);
    assert.doesNotMatch(draw(playing({ music: music() }), "menu"), /data-music-crossfade-inline/);
  });

  test("background sounds alone: no music is playing, with no Library to point at, then Background, Stop all sound and Open Sound", () => {
    const html = draw(playing({ loops: LOOPS }));
    assert.match(html, />No music is playing\.</);
    assert.doesNotMatch(html, /data-music-library-link|Pick a playlist/);
    assert.doesNotMatch(html, /data-now-next|Music volume for everyone/);
    order(html, ["data-music-idle", "data-now-background", "Stop all sound", "Open Sound"]);
  });

  test("nothing playing, as after a Stop while it is open: the idle line and Open Sound alone", () => {
    const html = draw(playing());
    assert.match(html, />No music is playing\.</);
    assert.doesNotMatch(html, /Stop all sound|data-now-background/);
    assert.match(html, /data-now-open-sound=""[^>]*>.*Open Sound/);
  });

  test("a background sound's Stop sends loop.stop for its loop", () => {
    const r = inRoom(playing({ loops: LOOPS }));
    const tree = drawn(NowPlayer, { fadeControl: "inline", onOpenSound: noop }, r.around);
    const background = elements(tree).find((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Background");
    assert.ok(background, "the Background part");
    const rows = drawn(background.type as (p: object) => ReactElement, {}, r.around);
    const stops = elements(rows).filter((e) => typeof e.props.label === "string" && (e.props.label as string).startsWith("Stop "));
    assert.deepEqual(stops.map((s) => s.props.label), ["Stop Rain on the cobblestones", "Stop Crowd"]);
    (stops[1]!.props.onClick as () => void)();
    assert.deepEqual(r.sent, [{ t: "loop.stop", id: "l2" }]);
  });

  test("background sounds in the order they started, whatever order the room lists them", () => {
    assert.deepEqual(backgroundRows(playing({ loops: LOOPS }), SOUNDS), [
      { id: "l1", name: "Rain on the cobblestones" },
      { id: "l2", name: "Crowd" },
    ]);
    assert.deepEqual(backgroundRows(null, SOUNDS), []);
  });
});
