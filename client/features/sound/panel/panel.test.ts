import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import type { Playing, Sound } from "#shared/sound.ts";
import { room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../../state/scope.ts";

/*
 * The parts of Ambiance's Sound in each state
 * (docs/design/design-v1-music.md 4.1, 4.3 and 12, design-v1-music-player.md
 * 3.1): the compact music block with its Next line and Open music, Skip
 * past a crossing's incoming track, the fifth loop, Edit turning
 * the board into a list, the scene line's states, the switch-off board, and
 * the player's panel with and without names.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MusicNow, nextWords, NowLine, SceneSoundLine, TableSound, UseWhatsPlaying } = await import("./NowPlaying.tsx");
const { LoopToggles } = await import("./LoopsSection.tsx");
const { Board } = await import("./EffectsBoard.tsx");
const { PlayerNow } = await import("./PlayerSound.tsx");
const { useReasons } = await import("./SoundPage.tsx");
const { ServerLine } = await import("./SoundPanel.tsx");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScopeProvider } = await import("../../../state/scope.ts");
const { tileBackground } = await import("../music/tile.ts");
const words = await import("./words.ts");

const noop = () => {};
const sound = (id: string, use: Sound["use"], ms: number, name?: string): Sound => ({ id, rev: 1, ...(name ? { name } : null), assetId: `a-${id}`, ms, use });

function music(over: Partial<Parameters<typeof MusicNow>[0]["music"]> = {}) {
  return { soundId: "pony", name: "The Prancing Pony", lengthMs: 190_000, positionMs: 84_000, paused: false, playlistName: "Tavern night", place: 3, count: 12, single: false, crossingInto: null, ...over };
}

function now(props: Partial<Parameters<typeof MusicNow>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MusicNow, { music: music(), next: "Next: Road", lengthMs: 190_000, onPause: noop, onResume: noop, onSkip: noop, onOpen: noop, ...props }));
}

describe("the DM's Now playing (docs/design/design-v1-music-player.md 3.1)", () => {
  test("names the track, its place, what comes next and its time, read aloud as one of the other", () => {
    const html = now();
    assert.match(html, /The Prancing Pony/);
    assert.match(html, /Tavern night · 3 of 12/);
    assert.match(html, /data-sound-next=""[^>]*>Next: Road</);
    assert.match(html, /aria-label="1:24 of 3:10"[^>]*>1:24 \/ 3:10</);
    assert.match(html, /aria-hidden="true" data-music-tile=""/, "a tile, hidden from a reader");
  });

  test("Pause and Skip stay, Open music joins them, and Stop the music and Repeat leave for the window", () => {
    const html = now();
    assert.match(html, /aria-label="Pause"/);
    assert.match(html, /aria-label="Skip to the next track"/);
    assert.match(html, /<button[^>]*data-music-open=""[^>]*>.*Open music</s);
    assert.doesNotMatch(html, /Stop the music/);
    assert.doesNotMatch(html, /Repeat (all|one|off)/);
  });

  test("Pause becomes Play while paused, and Skip goes past the incoming track during a crossfade", () => {
    assert.match(now({ music: music({ paused: true }) }), /aria-label="Play"/);
    assert.match(now({ music: music({ crossingInto: "Road" }) }), /aria-label="Skip past Road"/);
    assert.match(now({ music: music({ single: true }) }), /One track/);
  });

  test("the time reads one pass under Repeat one with a crossfade, its end the pass", () => {
    // A 1:00 track with a 10 s crossfade, 0:49 into its pass (design 10).
    assert.match(now({ music: music({ lengthMs: 60_000, positionMs: 49_000 }), lengthMs: 50_000 }), />0:49 \/ 0:50</);
  });

  test("the Next line: the track that follows, this track again, or the last", () => {
    const sounds = { road: sound("road", "music", 32_000, "Road") };
    assert.equal(nextWords({ t: "track", soundId: "road" }, sounds), "Next: Road");
    assert.equal(nextWords({ t: "again" }, sounds), "Next: this track again");
    assert.equal(nextWords({ t: "last" }, sounds), "Last track");
  });
});

describe("Now playing in Ambiance (docs/design/design-v1-panel-groups.md 4.1, D-261102-766 and 767)", () => {
  test("the music's buttons and Open music come before its bar and time, so Pause rises into a phone's half sheet", () => {
    const html = now();
    const buttons = html.indexOf('aria-label="Pause"');
    assert.ok(buttons > html.indexOf("Next: Road"), "after the name, the run line and the Next line");
    assert.ok(buttons < html.indexOf("data-sound-time"), "before the time");
    assert.ok(html.indexOf("data-music-open") < html.indexOf("data-sound-time"), "Open music too");
  });

  test("with no music, the background sounds are counted, else nothing is playing", () => {
    assert.match(renderToStaticMarkup(createElement(NowLine, { loops: 2 })), />2 background sounds</);
    assert.match(renderToStaticMarkup(createElement(NowLine, { loops: 1 })), />1 background sound</);
    assert.match(renderToStaticMarkup(createElement(NowLine, { loops: 0 })), />Nothing is playing\.</);
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
    const help = html.indexOf("What everyone at the table hears, set here for every device. Each device can turn itself down under On this device.");
    assert.ok(help >= 0 && help < html.indexOf("<label"), "the help first");
    assert.deepEqual(labels(html), [
      { text: "Music", name: "Music volume for everyone" },
      { text: "Rain on the cobblestones", name: "Rain on the cobblestones volume for everyone" },
      { text: "Effects", name: "Effects volume for everyone" },
    ]);
    assert.match(html, /aria-label="Stop Rain on the cobblestones"/, "a background sound keeps its Stop");
    assert.doesNotMatch(html.replace(/aria-label="[^"]*"/g, ""), /for everyone/, "no visible label says for everyone");
  });

  test("then the scene's line with Use what's playing, and the names switch last", () => {
    const html = draw();
    const line = html.indexOf("Goblin cave has no sound of its own.");
    assert.ok(line > html.indexOf(">Effects<"), "after the volumes");
    assert.ok(html.indexOf("Use what&#x27;s playing") > line);
    assert.ok(html.indexOf("Players see what is playing") > html.indexOf("Use what&#x27;s playing"));
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
  const player = (sounds: Record<string, Sound>, here: "plays" | "tap" | "other" | "off" = "plays", musicHere: "playing" | "failed" = "playing") =>
    renderToStaticMarkup(createElement(PlayerNow, { playing: p, sounds, here, music: musicHere, onRetry: noop }));

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
    const again = renderToStaticMarkup(createElement(PlayerNow, { playing: other, sounds: { harbor: sound("harbor", "music", 60_000) }, here: "plays", music: "playing", onRetry: noop }));
    assert.equal(tint(html), tint(again), "every hidden track gets the one tint");
    assert.equal(tint(html), tileBackground(""));
    assert.notEqual(tint(html), tileBackground("The Prancing Pony"), "never the tint of a name the player lacks");
  });

  test("background sounds alone: their line, with no card", () => {
    const loopsOnly: Playing = { ...p, music: null };
    const html = renderToStaticMarkup(createElement(PlayerNow, { playing: loopsOnly, sounds: { rain: sound("rain", "loop", 40_000, "Rain"), crowd: sound("crowd", "loop", 30_000, "Crowd") }, here: "plays", music: "playing", onRetry: noop }));
    assert.doesNotMatch(html, /data-sound-player-card|data-music-tile/);
    assert.match(html, /data-sound-player-loops=""[^>]*>Background: Rain, Crowd</);
  });

  test("nothing playing, a Sound kept open after it stopped: Nothing is playing", () => {
    const html = renderToStaticMarkup(createElement(PlayerNow, { playing: null, sounds: {}, here: "plays", music: "playing", onRetry: noop }));
    assert.match(html, />Nothing is playing\.</);
  });

  test("this device's state: a tap to start, another window, a track that failed", () => {
    const sounds = { pony: sound("pony", "music", 190_000) };
    assert.match(player(sounds, "tap"), /Tap anywhere to start the sound\./);
    assert.match(player(sounds, "other"), /Another window on this device plays the sound\./);
    const failed = player(sounds, "plays", "failed");
    assert.match(failed, /The music didn&#x27;t load on this device\./);
    assert.match(failed, />Try again</);
  });
});
