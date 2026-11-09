import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import type { MusicRun, Playing, Sound } from "#shared/sound.ts";
import { room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../../state/scope.ts";

/*
 * The Sound panel and its parts in each state
 * (docs/design/design-v1-sound-layout.md 4 and 7, design-v1-music.md 4.1,
 * 4.3 and 12): the DM's two views and their order, Up next's fold, the
 * idle line, the switch-off page, Table sound and Use what's playing, the
 * fifth loop, Edit turning the board into a list, the scene line's states,
 * the rules of the view's end and of Open Sound, the player's card
 * with and without names, and Only DM devices play's switch, reminder and
 * player's line (docs/design/design-v1-sound-dm-only.md 4 and 5).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DeviceLineView, nextWords, SceneSoundLine, TableSound, UseWhatsPlaying } = await import("./NowPlaying.tsx");
const { LoopToggles } = await import("./LoopsSection.tsx");
const { Board } = await import("./EffectsBoard.tsx");
const { PlayerNow, PlayerSound } = await import("./PlayerSound.tsx");
const { useReasons } = await import("./SoundPage.tsx");
const { askStep, endViewIfClosed, ServerLine, soundOpen, upNextSummary, default: SoundPanel } = await import("./SoundPanel.tsx");
const { soundViewSlot, soundAskSlot, openSoundNow } = await import("../music/open.ts");
const { panelScrollSlot } = await import("../../panels.ts");
const { queueLists, comingNext } = await import("../music/dragOrder.ts");
const engine = await import("../engine/store.ts");
const { api } = await import("../../../lib/api.ts");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScopeProvider } = await import("../../../state/scope.ts");
const { tileBackground } = await import("../music/tile.ts");
const words = await import("./words.ts");

const noop = () => {};
const sound = (id: string, use: Sound["use"], ms: number, name?: string): Sound => ({ id, rev: 1, ...(name ? { name } : null), assetId: `a-${id}`, ms, use });

describe("the Next line's words, Up next's folded summary", () => {
  test("the track that follows, this track again, or the last", () => {
    const sounds = { road: sound("road", "music", 32_000, "Road") };
    assert.equal(nextWords({ t: "track", soundId: "road" }, sounds), "Next: Road");
    assert.equal(nextWords({ t: "again" }, sounds), "Next: this track again");
    assert.equal(nextWords({ t: "last" }, sounds), "Last track");
  });
});

describe("Use what's playing in Table sound (docs/design/design-v1-sound-layout.md 6.2)", () => {
  const use = (props: Partial<Parameters<typeof UseWhatsPlaying>[0]>) =>
    renderToStaticMarkup(createElement(UseWhatsPlaying, { sceneName: "Forest road", sound: null, canUsePlaying: true, lineId: "line", onUsePlaying: noop, ...props }));

  test("the scene's line is plain help over Use what's playing, which it describes, and no row opens Scenes", () => {
    const html = use({ sound: { names: ["Tavern night"] } });
    assert.match(html, /<p id="line"[^>]*>Forest road&#x27;s sound: Tavern night\.<\/p>/);
    assert.match(html, /<button[^>]*aria-describedby="line"[^>]*>Use what&#x27;s playing</);
    assert.equal([...html.matchAll(/<button/g)].length, 1, "one button, the action");
    for (const gone of ["Scene sound", "in Scenes", "Play it", "Use silence", "Clear", "It plays when you move"]) assert.doesNotMatch(html, new RegExp(gone), `${gone} lives in Scenes`);
  });

  test("nothing playing: Use what's playing is off, described by the line and why", () => {
    const html = use({ canUsePlaying: false });
    assert.match(html, /<button[^>]*disabled=""[^>]*aria-describedby="line line-first"|<button[^>]*aria-describedby="line line-first"[^>]*disabled=""/);
    assert.match(html, /id="line-first"[^>]*>Play something first\./);
    assert.match(html, /Forest road has no sound of its own\./);
    assert.match(use({ sound: { names: [] } }), /Forest road is silent\./);
  });
});

/** A DM's room around `child`: the view, the scene on screen, and what it sends. */
function inRoom(child: ReturnType<typeof createElement>, view: RoomState, sceneId: string | null = "s1", role: "dm" | "player" = "dm") {
  const store = createStore(() => ({ view, you: { memberId: role === "dm" ? "dm1" : "p1", role }, roomId: "r1", sceneId, serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: new RoomScope(),
      children: createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1, newId: () => "x", sendEph: noop } as never, ui: { notify: noop, openPanel: noop } as never, assets: { url: () => "" } as never, children: child }),
    }),
  );
}

describe("Table sound (docs/design/design-v1-sound-layout.md 4.2 and 7)", () => {
  const playing: Playing = {
    rev: 1,
    music: { run: "r", order: ["pony"], index: 0, repeat: "all", fade: 5, now: { soundId: "pony", at: Date.now() } },
    loops: { a: { soundId: "rain", at: 0, volume: 70 } },
    effects: [],
    volume: { music: 80, effects: 100 },
  };
  const sounds = { pony: sound("pony", "music", 190_000, "The Prancing Pony"), rain: sound("rain", "loop", 40_000, "Rain on the cobblestones") };
  const draw = (over: Partial<RoomState> = {}, sceneId: string | null = "s1") => inRoom(createElement(TableSound), room({ sounds, playing, scenes: { s1: scene("s1", { name: "Goblin cave" }) }, ...over }), sceneId);
  const labels = (html: string) => [...html.matchAll(/<label for="([^"]+)"[^>]*>([^<]+)<\/label>/g)].map((m) => ({ text: m[2], name: new RegExp(`id="${m[1]}" aria-label="([^"]+)"`).exec(html)?.[1] ?? null }));

  test("its help says once that it is for every device, then the music, each background sound and the effects by plain names", () => {
    const html = draw();
    const help = html.indexOf("What everyone at the table hears, set here for every device. Each device sets its own volume from the speaker on its top bar.");
    assert.ok(help >= 0 && help < html.indexOf("<label"), "the help first");
    assert.deepEqual(labels(html), [
      { text: "Music", name: "Music volume for everyone" },
      { text: "Rain on the cobblestones", name: "Rain on the cobblestones volume for everyone" },
      { text: "Effects", name: "Effects volume for everyone" },
    ]);
    assert.match(html, /aria-label="Stop Rain on the cobblestones"/, "a background sound keeps its Stop");
    assert.doesNotMatch(html.replace(/aria-label="[^"]*"/g, ""), /for everyone/, "no visible label says for everyone");
  });

  test("while Only DM devices play or a blackout holds the sound back, no accessible name says for everyone", () => {
    const base = room().meta;
    const dmOnly = draw({ meta: { ...base, settings: { ...base.settings, soundDmOnly: true } } });
    const dark = draw({ meta: { ...base, view: { ...base.view, blackout: true } } });
    for (const html of [dmOnly, dark]) {
      assert.deepEqual(labels(html), [
        { text: "Music", name: "Music volume" },
        { text: "Rain on the cobblestones", name: "Rain on the cobblestones volume" },
        { text: "Effects", name: "Effects volume" },
      ]);
      assert.doesNotMatch(html.replace(/What everyone at the table hears[^<]*/, ""), /for everyone/);
    }
  });

  test("then the scene's line with Use what's playing, and the names switch last", () => {
    const html = draw();
    const line = html.indexOf("Goblin cave has no sound of its own.");
    assert.ok(line > html.indexOf(">Effects<"), "after the volumes");
    assert.ok(html.indexOf("Use what&#x27;s playing") > line);
    assert.ok(html.indexOf("Players see what is playing") > html.indexOf("Use what&#x27;s playing"));
  });

  test("Only DM devices play last, after the names switch, with its help as its description, off in a room that never set it", () => {
    const html = draw();
    const at = html.indexOf(">Only DM devices play<");
    assert.ok(at > html.indexOf("Players see what is playing"), "after the names switch");
    const row = /<button type="button" role="switch" aria-checked="(true|false)" aria-labelledby="[^"]+" aria-describedby="([^"]+)" data-search="sound\.table\.dmonly"/.exec(html);
    assert.ok(row, "a switch with the search's anchor");
    assert.equal(row[1], "false");
    assert.match(html, new RegExp(`id="${row[2]}"[^>]*>For a table that hears the sound from one speaker\. Players&#x27; devices and the table display play nothing and don&#x27;t ask\. Each DM device still plays unless it is muted\.<`));
  });

  test("Only DM devices play on: the switch says so, and Players see what is playing keeps its own value", () => {
    const html = draw({ meta: { ...room().meta, settings: { ...room().meta.settings, soundDmOnly: true, soundNames: true } } });
    const checked = (name: string) => new RegExp(`role="switch" aria-checked="(true|false)"[^>]*>(?:(?!</button>).)*>${name}<`).exec(html)?.[1];
    assert.equal(checked("Only DM devices play"), "true");
    assert.equal(checked("Players see what is playing"), "true", "kept for a game played apart (D-261107-245)");
    assert.doesNotMatch(/<button[^>]*role="switch"[^>]*>(?:(?!<\/button>).)*Players see what is playing/.exec(html)?.[0] ?? "", /disabled/, "and stays enabled");
  });

  test("with no scene in view there is no scene line and no Use what's playing", () => {
    const html = draw({}, null);
    assert.doesNotMatch(html, /Use what&#x27;s playing|has no sound of its own/);
  });

  test("with no music there is no music volume", () => {
    const html = draw({ playing: { ...playing, music: null } });
    assert.deepEqual(labels(html).map((l) => l.text), ["Rain on the cobblestones", "Effects"]);
  });
});

describe("the scene's sound line", () => {
  const line = (props: Partial<Parameters<typeof SceneSoundLine>[0]>) =>
    renderToStaticMarkup(createElement(SceneSoundLine, { sceneName: "Forest road", sound: null, canUsePlaying: true, helpId: "h", onPlay: noop, onUsePlaying: noop, onUseSilence: noop, onClear: noop, ...props }));
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);

  test("no sound of its own: Use what's playing and Use silence", () => {
    const html = line({});
    assert.match(html, /Forest road has no sound of its own\./);
    assert.deepEqual(buttons(html), ["Use what&#x27;s playing", "Use silence"]);
    assert.match(html, /It plays when you move the players to this scene\./);
  });

  test("nothing playing: Use what's playing is off, and says why", () => {
    const html = line({ canUsePlaying: false });
    assert.match(html, /<button[^>]*disabled=""[^>]*aria-describedby="h-first"|<button[^>]*aria-describedby="h-first"[^>]*disabled=""/);
    assert.match(html, /id="h-first"[^>]*>Play something first\./);
  });

  test("a sound of its own, silence included: Play it, Use what's playing, Use silence and Clear", () => {
    const kept = line({ sound: { names: ["Tavern night", "Rain", "Crowd"] } });
    assert.match(kept, /Forest road&#x27;s sound: Tavern night, Rain, Crowd\./);
    assert.deepEqual(buttons(kept), ["Play it", "Use what&#x27;s playing", "Use silence", "Clear"]);
    assert.match(line({ sound: { names: [] } }), /Forest road is silent\./);
  });
});

describe("Background", () => {
  const loops = [sound("rain", "loop", 42_000, "Rain"), sound("crowd", "loop", 30_000, "Crowd")];
  const p: Playing = { rev: 1, music: null, loops: { l1: { soundId: "rain", at: 0, volume: 70 } }, effects: [], volume: { music: 100, effects: 100 } };

  test("a toggle per loop, pressed while it plays, with its length", () => {
    const html = renderToStaticMarkup(createElement(LoopToggles, { loops, playing: p, refused: false, editing: false, onToggle: noop, onEdit: noop }));
    assert.match(html, /aria-pressed="true"[^>]*aria-label="Rain"|aria-label="Rain"[^>]*aria-pressed="true"/);
    assert.match(html, /aria-pressed="false"[^>]*aria-label="Crowd"|aria-label="Crowd"[^>]*aria-pressed="false"/);
    assert.match(html, />0:42</);
    assert.doesNotMatch(html, /Four background sounds/);
  });

  test("a fifth says why nothing started", () => {
    const html = renderToStaticMarkup(createElement(LoopToggles, { loops, playing: p, refused: true, editing: false, onToggle: noop, onEdit: noop }));
    assert.match(html, /Up to four background sounds can play at once\. Stop one first\./);
  });
});

describe("the effects board", () => {
  const effects = [sound("thunder", "effect", 25_000, "Thunder")];
  const board = (props: Partial<Parameters<typeof Board>[0]>) =>
    renderToStaticMarkup(createElement(Board, { effects, sounding: new Set<string>(), editing: false, builtInOnly: false, onFireBuiltin: noop, onFire: noop, onEdit: noop, ...props }));

  test("Built in first, then the room's effects, each a tap for everyone, pressed while it sounds", () => {
    const html = board({ sounding: new Set(["sound:thunder"]) });
    for (const name of ["Click", "Rumble", "Crash", "Whoosh", "Hiss"]) assert.match(html, new RegExp(`aria-label="Play ${name} for everyone"`));
    assert.ok(html.indexOf("Play Hiss for everyone") < html.indexOf("Play Thunder for everyone"));
    assert.match(html, /aria-pressed="true"[^>]*aria-label="Play Thunder for everyone"/);
  });

  test("while only the DM's devices sound, a tap no longer says for everyone", () => {
    const html = board({ hearers: "dm" });
    assert.match(html, /aria-label="Play Click"/);
    assert.match(html, /aria-label="Play Thunder"/);
    assert.doesNotMatch(html, /for everyone/);
  });

  test("Edit turns the room's effects into rows that open their pages, the built-ins staying a board", () => {
    const html = board({ editing: true });
    assert.doesNotMatch(html, /Play Thunder for everyone/);
    assert.match(html, /data-opener="sound-thunder"[^>]*>.*Thunder/);
    assert.match(html, /Play Click for everyone/);
  });

  test("with the server's switch off only Built in shows", () => {
    const html = board({ builtInOnly: true });
    assert.match(html, /Play Click for everyone/);
    assert.doesNotMatch(html, /Thunder/);
  });
});

describe("the server's switch line", () => {
  const line = (server: "unknown" | "on" | "off" | "failed") => renderToStaticMarkup(createElement(ServerLine, { server, onRetry: noop }));

  test("off only once the server said so: nothing while it asks, past the shared delay its loading line, and a failed read with Try again", () => {
    assert.equal(line("on"), "");
    assert.match(line("off"), /This server doesn&#x27;t offer sound files./);
    assert.doesNotMatch(line("unknown"), /doesn/, "never the off line while it asks");
    const failed = line("failed");
    assert.match(failed, /Couldn&#x27;t check whether this server offers sound files./);
    assert.match(failed, />Try again</);
    assert.doesNotMatch(failed, /doesn/);
  });
});

describe("a sound's page", () => {
  test("each use its length rules out says why", () => {
    assert.deepEqual(useReasons(25_000), { music: "Music is 30 seconds at least.", loop: null, effect: null });
    assert.deepEqual(useReasons(1_000), { music: "Music is 30 seconds at least.", loop: "Background sounds are 2 seconds at least.", effect: null });
    assert.deepEqual(useReasons(60_000), { music: null, loop: null, effect: "Effects are 30 seconds at most." });
    assert.equal(useReasons(30_100).effect, null, "the encoder's 100 ms allowance");
  });
});

describe("a player's panel", () => {
  const p: Playing = {
    rev: 1,
    music: { run: "r", repeat: "all", fade: 5, now: { soundId: "pony", at: 0 } },
    loops: { a: { soundId: "rain", at: 0, volume: 70 }, b: { soundId: "crowd", at: 0, volume: 50 } },
    effects: [{ id: "e1", soundId: "thunder", at: 0 }],
    volume: { music: 100, effects: 100 },
  };
  const player = (sounds: Record<string, Sound>, here: "plays" | "tap" | "other" | "off" | "cannot" = "plays", musicHere: "playing" | "failed" = "playing") =>
    renderToStaticMarkup(createElement(PlayerNow, { playing: p, sounds, here, music: musicHere, dmOnly: false, onRetry: noop }));

  test("with names shared: a card with the tile and the track's name, the background by name under it, never an effect", () => {
    const html = player({ pony: sound("pony", "music", 190_000, "The Prancing Pony"), rain: sound("rain", "loop", 40_000, "Rain"), crowd: sound("crowd", "loop", 30_000, "Crowd"), thunder: sound("thunder", "effect", 25_000) });
    const card = /<div data-sound-player-card=""[^>]*>(.*)<\/div><\/div>/.exec(html)?.[1] ?? "";
    assert.match(card, /<span aria-hidden="true" data-music-tile="" style="[^"]*width:44px;height:44px/, "the 44 px tile, hidden from a reader");
    assert.match(card, /data-sound-player-music=""[^>]*font-size:16px;font-weight:700[^>]*>The Prancing Pony</);
    assert.match(card, /data-sound-player-loops=""[^>]*color:var\(--rvtt-text-muted[^>]*>Background: Rain, Crowd</, "muted, under the name");
    assert.doesNotMatch(html, /thunder|effect/i);
  });

  test("without names: Music is playing, the background counted, and the tile one fixed tint that names nothing", () => {
    const html = player({ pony: sound("pony", "music", 190_000), rain: sound("rain", "loop", 40_000), crowd: sound("crowd", "loop", 30_000) });
    assert.match(html, /data-sound-player-music=""[^>]*>Music is playing</);
    assert.match(html, /2 background sounds are playing\./);
    const tint = (h: string) => /data-music-tile="" style="[^"]*background:([^;"]+)/.exec(h)?.[1];
    const other: Playing = { ...p, music: { ...p.music!, now: { soundId: "harbor", at: 0 } } };
    const again = renderToStaticMarkup(createElement(PlayerNow, { playing: other, sounds: { harbor: sound("harbor", "music", 60_000) }, here: "plays", music: "playing", dmOnly: false, onRetry: noop }));
    assert.equal(tint(html), tint(again), "every hidden track gets the one tint");
    assert.equal(tint(html), tileBackground(""));
    assert.notEqual(tint(html), tileBackground("The Prancing Pony"), "never the tint of a name the player lacks");
  });

  test("background sounds alone: their line, with no card", () => {
    const loopsOnly: Playing = { ...p, music: null };
    const html = renderToStaticMarkup(createElement(PlayerNow, { playing: loopsOnly, sounds: { rain: sound("rain", "loop", 40_000, "Rain"), crowd: sound("crowd", "loop", 30_000, "Crowd") }, here: "plays", music: "playing", dmOnly: false, onRetry: noop }));
    assert.doesNotMatch(html, /data-sound-player-card|data-music-tile/);
    assert.match(html, /data-sound-player-loops=""[^>]*>Background: Rain, Crowd</);
  });

  test("nothing playing, a Sound kept open after it stopped: Nothing is playing", () => {
    const html = renderToStaticMarkup(createElement(PlayerNow, { playing: null, sounds: {}, here: "plays", music: "playing", dmOnly: false, onRetry: noop }));
    assert.match(html, />Nothing is playing\.</);
  });

  test("while Only DM devices play: the DM plays it, in place of nothing is playing, with no tap or other-window line", () => {
    for (const here of ["plays", "tap", "other", "off"] as const) {
      const html = renderToStaticMarkup(createElement(PlayerNow, { playing: null, sounds: {}, here, music: "none", dmOnly: true, onRetry: noop }));
      assert.match(html, /^<p style="[^"]*color:var\(--rvtt-text-muted[^"]*">The DM plays the sound on their own device\.<\/p>$/, `the one muted line, ${here}`);
    }
  });

  test("this device's state: a tap to start, another window, a browser that can't play, a track that failed", () => {
    const sounds = { pony: sound("pony", "music", 190_000) };
    assert.match(player(sounds, "tap"), /Tap anywhere to start the sound\./);
    assert.match(player(sounds, "other"), /Another window on this device plays the sound\./);
    assert.match(player(sounds, "cannot"), /This browser can&#x27;t play the room&#x27;s sound\./);
    const failed = player(sounds, "plays", "failed");
    assert.match(failed, /The music didn&#x27;t load on this device\./);
    assert.match(failed, />Try again</);
  });
});

/** The status lines a Sound panel may show for this device (docs/design/design-v1-volume.md 4, VOL-ASTRA-01), as a render escapes them. */
const STATUS_LINES = [words.DM_PLAYS_IT, words.TAP_TO_START, words.ANOTHER_WINDOW, words.CANNOT_PLAY, words.DEVICE_MUTED].map((l) => l.replaceAll("'", "&#x27;"));
const statusLines = (html: string) => STATUS_LINES.reduce((n, l) => n + (html.split(l).length - 1), 0);

describe("one status line for this device in a player's Sound panel (docs/design/design-v1-volume.md 4, VOL-ASTRA-01)", () => {
  const draw = (dmOnly: boolean) => {
    const view = room();
    if (dmOnly) view.meta.settings = { ...view.meta.settings, soundDmOnly: true };
    const store = createStore(() => ({ view, you: { memberId: "p1", role: "player" }, roomId: "r1", sceneId: "s1", serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false } }));
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1, newId: () => "x", sendEph: noop } as never, ui: { notify: noop, openPanel: noop } as never, children: createElement(PlayerSound) }));
  };

  test("a tap, another window, a browser that can't, and Only DM devices play over each: exactly one line, Now playing's, and none from On this device", () => {
    try {
      for (const here of ["tap", "other", "cannot"] as const) {
        engine.setSoundHere({ here, music: "none" });
        const html = draw(false);
        assert.equal(statusLines(html), 1, here);
        const device = html.slice(html.indexOf("data-device-sound"));
        assert.equal(statusLines(device), 0, `${here}: On this device draws no line of its own`);
        const dmOnly = draw(true);
        assert.equal(statusLines(dmOnly), 1, `${here} under Only DM devices play`);
        assert.ok(dmOnly.includes(words.DM_PLAYS_IT), "the DM's line wins");
      }
      for (const here of ["plays", "off"] as const) {
        engine.setSoundHere({ here, music: "none" });
        assert.equal(statusLines(draw(false)), 0, `${here}: the toggle and the master show it`);
      }
    } finally {
      engine.setSoundHere({ here: "off", music: "none" });
    }
  });
});

describe("the DM's device line (docs/design/design-v1-volume.md 6)", () => {
  const line = (here: "off" | "tap" | "plays" | "other" | "cannot", onUnmute = noop) => renderToStaticMarkup(createElement(DeviceLineView, { here, onUnmute }));

  test("muted with Unmute, a tap to start, a browser that can't play, another window, and nothing while it plays", () => {
    assert.match(line("off"), /This device is muted\.(<!-- -->)? <button type="button" data-sound-unmute=""[^>]*>Unmute<\/button>/);
    assert.match(line("tap"), />Tap anywhere to start the sound\.</);
    assert.match(line("cannot"), />This browser can&#x27;t play the room&#x27;s sound\.</, "never the muted line");
    assert.doesNotMatch(line("cannot"), /Unmute/);
    assert.match(line("other"), />Another window on this device plays the sound\.</);
    assert.equal(line("plays"), "");
  });
});

/** This page's storage, which the folds read and write, a Map for the test to fill. */
const items = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
};

/** Sets the server's sound switch for one test, as GET /api/config would answer. */
async function serverSays(on: boolean): Promise<void> {
  engine.resetServerRoomSoundForTests();
  const real = api.getConfig;
  api.getConfig = (async () => ({ roomSound: on })) as unknown as typeof api.getConfig;
  await engine.serverRoomSound();
  api.getConfig = real;
}

describe("the DM's Sound panel (docs/design/design-v1-sound-layout.md 4.1 to 4.4)", () => {
  afterEach(() => {
    engine.resetServerRoomSoundForTests();
    items.clear();
  });
  const tracks = Object.fromEntries(["a", "b", "c"].map((id) => [id, sound(id, "music", 60_000, `Track ${id}`)]));
  const run = (over: Partial<MusicRun> = {}): Playing => ({
    rev: 1,
    music: { run: "r1", playlistId: "p", order: ["a", "b", "c"], index: 0, repeat: "all", fade: 0, now: { soundId: "a", at: Date.now() - 5_000 }, ...over },
    loops: {},
    effects: [],
    volume: { music: 100, effects: 100 },
  });
  const view = (playing: Playing | null, dmOnly = false) => {
    const state = room({ sounds: { ...tracks, rain: sound("rain", "loop", 40_000, "Rain") }, playlists: { p: { id: "p", rev: 0, name: "Tavern night", sounds: ["a", "b", "c"], repeat: "all", fade: 0 } }, ...(playing ? { playing } : null) });
    if (dmOnly) state.meta.settings = { ...state.meta.settings, soundDmOnly: true };
    return state;
  };
  const draw = (playing: Playing | null, scope = new RoomScope(), dmOnly = false) => {
    const store = createStore(() => ({ view: view(playing, dmOnly), you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false, panel: null, tab: "sound", below: null } }));
    return renderToStaticMarkup(
      createElement(RoomScopeProvider, {
        scope,
        children: createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1, newId: () => "x", sendEph: noop } as never, ui: { notify: noop, openPanel: noop } as never, assets: { url: () => "" } as never, children: createElement(SoundPanel, {} as never) }),
      }),
    );
  };
  /** The view and the search for a render: a server render reads a store's first state, so this makes the state given its first. */
  const viewIn = (scope: RoomScope, state: { view: "now" | "library"; query: string }) => {
    const store = scope.get(soundViewSlot);
    store.setState(state);
    store.getInitialState = store.getState;
  };

  test("the view row, named Sound, starts on Now playing", async () => {
    await serverSays(true);
    const html = draw(run());
    assert.match(html, /role="radiogroup" aria-label="Sound"/);
    const checked = /<input type="radio"[^>]*checked=""[^>]*value="(\w+)"|<input type="radio"[^>]*value="(\w+)"[^>]*checked=""/.exec(html);
    assert.equal(checked?.[1] ?? checked?.[2], "now");
    assert.match(html, /data-sound-view="now"/);
  });

  test("Now playing in 4.2's order: the player, Stop all sound and the device line, Up next, Effects, Table sound, Background, On this device", async () => {
    await serverSays(true);
    const html = draw(run());
    const player = html.indexOf("data-music-now");
    assert.ok(player > html.indexOf('aria-label="Sound"'), "the player under the view row");
    assert.ok(html.indexOf("data-music-stop-all") > player, "Stop all sound under it");
    const order = ["Up next", "Effects", "Table sound", "Background", "On this device"].map((l) => html.indexOf(`>${l}<`));
    assert.ok(order.every((at) => at > html.indexOf("data-music-stop-all")), "all under the player");
    assert.deepEqual([...order].sort((x, y) => x - y), order);
    assert.doesNotMatch(html, /Open music|What players hear|Scene sound, in Scenes|data-music-library=""/);
  });

  test("Up next is folded with nothing stored, its summary the Next line that describes its fold, its list kept mounted", async () => {
    await serverSays(true);
    const html = draw(run());
    const fold = /<button type="button" aria-expanded="(true|false)" aria-describedby="([^"]+)"[^>]*>.*?Up next<\/button>/.exec(html);
    assert.ok(fold, "a fold named Up next");
    assert.equal(fold[1], "false");
    assert.match(html, new RegExp(`<span id="${fold[2]}" data-music-upnext-summary=""[^>]*>Next: Track b</span>`));
    assert.match(html, /<div hidden=""[^>]*>.*<ol aria-label="Up next"/s, "kept mounted, hidden");
  });

  test("Up next opened on this device: open, its summary the count", async () => {
    await serverSays(true);
    items.set("rvtt.soundFolds", JSON.stringify({ upnext: true }));
    const html = draw(run());
    assert.match(html, /aria-expanded="true"[^>]*>.*?Up next<\/button>/);
    assert.match(html, /data-music-upnext-summary=""[^>]*>2 tracks · 2 min</);
  });

  test("with no music: the idle line names Library as a link, and there is no Up next", async () => {
    await serverSays(true);
    const html = draw(null);
    assert.match(html, /No music is playing\. Pick a playlist or a track in <button type="button" data-music-library-link=""[^>]*>Library<\/button>\./);
    assert.doesNotMatch(html, />Up next</);
    assert.doesNotMatch(html, /data-music-stop-all/, "nothing sounds");
    assert.ok(html.indexOf(">Effects<") > html.indexOf("data-music-library-link"));
  });

  test("Library: the search sticks to the scroller's top and holds the view slot's query, with Playlists and Tracks under it and nothing of Now playing", async () => {
    await serverSays(true);
    const scope = new RoomScope();
    viewIn(scope, { view: "library", query: "Track b" });
    const html = draw(run(), scope);
    assert.match(html, /data-sound-view="library"/);
    assert.match(html, /data-music-search="" style="position:sticky;top:calc\(-1 \* var\(--pane-pad-top, 0px\)\)/);
    assert.match(html, /<input type="search" aria-label="Search music"[^>]*value="Track b"/);
    assert.match(html, />Tracks<span[^>]*>1 of 3</);
    assert.ok(html.indexOf("data-music-search") < html.indexOf(">Playlists<"));
    for (const gone of ["data-music-now", ">Effects<", ">Table sound<", ">Up next<", "Guide"]) assert.doesNotMatch(html, new RegExp(gone), `${gone} is not in Library`);
  });

  test("the maker's openers carry their marks, so focus goes back to the one pressed", async () => {
    await serverSays(true);
    const scope = new RoomScope();
    viewIn(scope, { view: "library", query: "" });
    const html = draw(run(), scope);
    assert.match(html, /<button[^>]*data-maker-opener="new"[^>]*>.*?New playlist/);
    assert.match(html, /<button[^>]*data-maker-opener="playlist-p"/);
  });

  test("with the server's switch off: no view row, its line, Effects and On this device", async () => {
    await serverSays(false);
    const html = draw(run());
    assert.doesNotMatch(html, /role="radiogroup" aria-label="Sound"/);
    assert.match(html, /This server doesn&#x27;t offer sound files\./);
    assert.ok(html.indexOf(">On this device<") > html.indexOf(">Effects<"));
    assert.doesNotMatch(html, /data-music-now|>Up next</);
    assert.ok(html.indexOf(">Table sound<") > html.indexOf(">Effects<"), "Table sound, with Only DM devices play alone, after Effects");
  });

  test("Only DM devices play on: its reminder under the player, over the device line, with nothing playing too, and none while it is off", async () => {
    await serverSays(true);
    const REMINDER = ">Only DM devices play the sound.<";
    const SILENT = ">This device is muted.";
    for (const playing of [run(), null]) {
      const html = draw(playing, new RoomScope(), true);
      const player = html.slice(html.indexOf("data-sound-player"), html.indexOf(">Effects<"));
      // A page with no engine reads this device as muted, so the device line shows under the reminder.
      assert.ok(player.includes(REMINDER) && player.includes(SILENT), `both in the player's area, ${playing ? "playing" : "silent"}`);
      assert.ok(player.indexOf(REMINDER) < player.indexOf(SILENT), "the reminder first");
    }
    assert.doesNotMatch(draw(run()), /Only DM devices play the sound\./);
  });

  test("with the server's switch off: Table sound after Effects holds Only DM devices play alone, so a room that kept it can still turn it off", async () => {
    await serverSays(false);
    const html = draw(run(), new RoomScope(), true);
    const table = html.indexOf(">Table sound<");
    assert.ok(table > html.indexOf(">Effects<") && table < html.indexOf(">On this device<"), "between Effects and On this device");
    const section = html.slice(table, html.indexOf(">On this device<"));
    assert.deepEqual([...section.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => [/aria-checked="(\w+)"/.exec(m[0])?.[1], /data-search="([^"]+)"/.exec(m[0])?.[1]]), [["true", "sound.table.dmonly"]], "the one switch, on");
    assert.doesNotMatch(section, /Players see what is playing|volume for everyone|What everyone at the table hears|Only DM devices play the sound\./);
  });

  test("each page's status line for this device, once: Now playing's on the full page, the controls' own on the off page, whose line covers a switch not answered or failed too", async () => {
    try {
      for (const on of [true, false]) {
        await serverSays(on);
        for (const here of ["tap", "other", "cannot", ...(on ? (["off"] as const) : [])] as const) {
          engine.setSoundHere({ here, music: "none" });
          const html = draw(run());
          assert.equal(statusLines(html), 1, `${on ? "on" : "off"}, ${here}`);
          const device = html.slice(html.indexOf("data-device-sound"));
          assert.equal(statusLines(device), on ? 0 : 1, `${on ? "on" : "off"}, ${here}: the controls' line ${on ? "off" : "on"}`);
        }
      }
      engine.resetServerRoomSoundForTests();
      engine.setSoundHere({ here: "other", music: "none" });
      assert.equal(statusLines(draw(run())), 1, "the switch not answered yet: the off page, with the controls' line");
    } finally {
      engine.setSoundHere({ here: "off", music: "none" });
    }
  });

  test("with the switch off a Library view left in the slot still draws the off page", async () => {
    await serverSays(false);
    const scope = new RoomScope();
    viewIn(scope, { view: "library", query: "x" });
    const html = draw(run(), scope);
    assert.match(html, /data-sound-view="now"/);
    assert.doesNotMatch(html, /data-music-library=""/);
  });
});

describe("the view's end and Open Sound (docs/design/design-v1-sound-layout.md 4.1)", () => {
  test("Sound is open by the side panel's tab or pane below from 900 px up, and by the phone's sheet below it", () => {
    const local = (over: Partial<{ panel: string | null; tab: string; below: string | null }>) => ({ panel: null, tab: "token", below: null, ...over });
    assert.equal(soundOpen(local({ tab: "sound" }), 1440), true);
    assert.equal(soundOpen(local({ below: "sound" }), 1440), true);
    assert.equal(soundOpen(local({ panel: "sound" }), 1440), false, "the sheet's panel means nothing beside a side panel");
    assert.equal(soundOpen(local({ panel: "sound" }), 390), true);
    assert.equal(soundOpen(local({ tab: "sound" }), 390), false);
  });

  test("the panel leaving closed ends the view, the search and its saved scroll, and leaving still open keeps them", () => {
    const scope = new RoomScope();
    const kept = { top: 5_400, left: 0, end: true, page: "library", subject: null };
    const leave = (local: { panel: string | null; tab: string; below: string | null }, px: number) => {
      scope.get(soundViewSlot).setState({ view: "library", query: "harbor" });
      scope.get(panelScrollSlot).set("sound", kept);
      endViewIfClosed(scope, local, px);
    };
    leave({ panel: null, tab: "sound", below: null }, 1440);
    assert.deepEqual(scope.get(soundViewSlot).getState(), { view: "library", query: "harbor" }, "a remount on the same side, still open");
    assert.equal(scope.get(panelScrollSlot).get("sound"), kept);
    leave({ panel: null, tab: "log", below: null }, 1440);
    assert.deepEqual(scope.get(soundViewSlot).getState(), { view: "now", query: "" }, "closed: the next opening starts on Now playing");
    assert.equal(scope.get(panelScrollSlot).has("sound"), false, "and at its top, never Library's foot");
    leave({ panel: "sound", tab: "log", below: null }, 390);
    assert.equal(scope.get(soundViewSlot).getState().view, "library", "turned below 900 px onto the open sheet");
    leave({ panel: null, tab: "sound", below: null }, 390);
    assert.equal(scope.get(soundViewSlot).getState().view, "now", "turned below 900 px with no sheet for it");
  });

  test("an Open Sound press is acted on once: Back first on a subpage, then the top", () => {
    assert.equal(askStep(0, 0, false), "none", "no press yet");
    assert.equal(askStep(1, 0, true), "back");
    assert.equal(askStep(1, 0, false), "top");
    assert.equal(askStep(1, 1, false), "none", "acted on");
    assert.equal(askStep(1, 1, true), "none", "a subpage opened after the press stays");
    const scope = new RoomScope();
    scope.get(soundViewSlot).setState({ view: "library", query: "harbor" });
    openSoundNow(scope, { openPanel: noop });
    assert.equal(scope.get(soundAskSlot).getState().seq, 1);
    assert.deepEqual(scope.get(soundViewSlot).getState(), { view: "now", query: "harbor" });
  });

  test("Up next's summary: the Next line folded, the count open, nothing to say with nothing ahead", () => {
    const sounds = Object.fromEntries(["a", "b", "c"].map((id) => [id, sound(id, "music", 120_000, `Track ${id}`)]));
    const t = 1_000_000;
    const music: MusicRun = { run: "r", order: ["a", "b", "c"], index: 0, repeat: "off", fade: 0, now: { soundId: "a", at: t - 1_000 } };
    const lists = queueLists(music, sounds, t);
    assert.equal(upNextSummary(false, lists, comingNext(music, sounds, t), sounds), "Next: Track b");
    assert.equal(upNextSummary(true, lists, comingNext(music, sounds, t), sounds), "2 tracks · 4 min");
    const last: MusicRun = { ...music, index: 2, now: { soundId: "c", at: t - 1_000 } };
    assert.equal(upNextSummary(false, queueLists(last, sounds, t), comingNext(last, sounds, t), sounds), "Last track");
    assert.equal(upNextSummary(true, queueLists(last, sounds, t), comingNext(last, sounds, t), sounds), null);
  });
});
