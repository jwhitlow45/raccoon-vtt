import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Playing, Sound } from "#shared/sound.ts";

/*
 * The Sound panel's parts in each state (docs/design/design-v1-music.md 4.1,
 * 4.3 and 12): Repeat naming its state, Skip past a crossing's incoming
 * track, the fifth loop, Edit turning the board into a list, the scene
 * line's states, the switch-off board, and the player's panel with and
 * without names.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MusicNow, SceneSoundLine } = await import("./NowPlaying.tsx");
const { LoopToggles } = await import("./LoopsSection.tsx");
const { Board } = await import("./EffectsBoard.tsx");
const { PlayerNow } = await import("./PlayerSound.tsx");
const { useReasons } = await import("./SoundPage.tsx");
const { ServerLine } = await import("./SoundPanel.tsx");
const words = await import("./words.ts");

const noop = () => {};
const sound = (id: string, use: Sound["use"], ms: number, name?: string): Sound => ({ id, rev: 1, ...(name ? { name } : null), assetId: `a-${id}`, ms, use });

function music(over: Partial<Parameters<typeof MusicNow>[0]["music"]> = {}) {
  return { soundId: "pony", name: "The Prancing Pony", lengthMs: 190_000, positionMs: 84_000, paused: false, playlistName: "Tavern night", place: 3, count: 12, single: false, crossingInto: null, ...over };
}

function now(props: Partial<Parameters<typeof MusicNow>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MusicNow, { music: music(), repeat: "all", onPause: noop, onResume: noop, onSkip: noop, onStop: noop, onRepeat: noop, ...props }));
}

describe("the DM's Now playing", () => {
  test("names the track, its place and its time, read aloud as one of the other", () => {
    const html = now();
    assert.match(html, /The Prancing Pony/);
    assert.match(html, /Tavern night · 3 of 12/);
    assert.match(html, /aria-label="1:24 of 3:10"[^>]*>1:24 \/ 3:10</);
  });

  test("Repeat names its state and is pressed unless off, with Repeat one's own icon", () => {
    for (const repeat of ["all", "one", "off"] as const) {
      const html = now({ repeat });
      const button = /<button[^>]*aria-label="Repeat [a-z]+"[^>]*>/.exec(html)?.[0] ?? "";
      assert.match(button, new RegExp(`aria-label="${words.REPEAT_NAMES[repeat]}"`));
      assert.match(button, new RegExp(`aria-pressed="${repeat !== "off"}"`));
    }
    assert.notEqual(now({ repeat: "one" }).length, 0);
    assert.notEqual(now({ repeat: "one" }), now({ repeat: "all" }).replace("Repeat all", "Repeat one"), "Repeat one draws its own icon");
  });

  test("Pause becomes Play while paused, and Skip goes past the incoming track during a crossfade", () => {
    assert.match(now(), /aria-label="Pause"/);
    assert.match(now({ music: music({ paused: true }) }), /aria-label="Play"/);
    assert.match(now(), /aria-label="Skip to the next track"/);
    assert.match(now({ music: music({ crossingInto: "Road" }) }), /aria-label="Skip past Road"/);
    assert.match(now({ music: music({ single: true }) }), /One track/);
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
    assert.match(html, /Moving the players here plays it\./);
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
    assert.match(html, /Four background sounds play at once at most\. Stop one first\./);
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

  test("with names shared: the music and the background by name, never an effect", () => {
    const html = player({ pony: sound("pony", "music", 190_000, "The Prancing Pony"), rain: sound("rain", "loop", 40_000, "Rain"), crowd: sound("crowd", "loop", 30_000, "Crowd"), thunder: sound("thunder", "effect", 25_000) });
    assert.match(html, /Music: The Prancing Pony/);
    assert.match(html, /Background: Rain, Crowd/);
    assert.doesNotMatch(html, /thunder|effect/i);
  });

  test("without names: what plays, counted", () => {
    const html = player({ pony: sound("pony", "music", 190_000), rain: sound("rain", "loop", 40_000), crowd: sound("crowd", "loop", 30_000) });
    assert.match(html, /Music is playing\./);
    assert.match(html, /2 background sounds are playing\./);
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
