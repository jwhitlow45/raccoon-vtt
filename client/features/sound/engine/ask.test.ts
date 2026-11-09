import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEAD_MS, type Playing } from "#shared/sound.ts";
import type { AskState } from "./useSoundAsk.ts";

/*
 * When a player's device asks to play sound (docs/design/design-v1-music.md
 * 4.4): at load when something already plays, when music or a loop starts,
 * or when an effect is fired after the page loaded, never for an effect
 * fired before it. And what counts as something to hear at all.
 */

const { ASK_START, askShows, askStep, askWorthy } = await import("./useSoundAsk.ts");
const { soundEnabled } = await import("./SoundHost.tsx");
const { firedAfter, resetServerRoomSoundForTests, serverRoomSound, serverSound, somethingToHear } = await import("./store.ts");
const { api } = await import("../../../lib/api.ts");

const quiet: Playing = { rev: 1, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 } };
const T = 1_000_000;

describe("the ask", () => {
  test("music or a loop asks, at load or later", () => {
    const music: Playing = { ...quiet, music: { run: "r", repeat: "all", fade: 5, now: { soundId: "s", at: T - 60_000 } } };
    const loop: Playing = { ...quiet, loops: { a: { soundId: "rain", at: T, volume: 70 } } };
    assert.equal(askWorthy(music, null, T), true, "a late joiner, in the first look");
    assert.equal(askWorthy(loop, new Set(), T), true);
    assert.equal(askWorthy(quiet, new Set(), T), false);
    assert.equal(askWorthy(null, new Set(), T), false);
    assert.equal(askWorthy(undefined, new Set(), T), false);
  });

  test("an effect asks only when fired after the load, never one in the first look or fired before it", () => {
    const old = { id: "old", builtin: "crash" as const, at: T - 5_000 };
    const fresh = { id: "new", builtin: "crash" as const, at: T + 2_000 + LEAD_MS };
    const hidden = { id: "hidden", soundId: "x", at: T - 30_000 };
    assert.equal(askWorthy({ ...quiet, effects: [old] }, null, T), false, "the first look holds only effects from before the load");
    assert.equal(askWorthy({ ...quiet, effects: [old] }, new Set(["old"]), T), false);
    assert.equal(askWorthy({ ...quiet, effects: [old, hidden] }, new Set(["old"]), T), false, "seen only later but fired before the load");
    assert.equal(askWorthy({ ...quiet, effects: [old, fresh] }, new Set(["old"]), T), true);
    assert.equal(firedAfter({ id: "e", at: T - 1_000 + LEAD_MS }, T), true, "a second of slack for a clock a little ahead");
    assert.equal(firedAfter({ id: "e", at: T - 1_001 + LEAD_MS }, T), false);
  });

  test("something to hear: music not paused, a loop, or an effect not over, whose sound is still an Effect", () => {
    const sounds = { thunder: { ms: 25_000, use: "effect" as const }, rain: { ms: 25_000, use: "loop" as const } };
    assert.equal(somethingToHear({ ...quiet, effects: [{ id: "a", soundId: "thunder", at: T - 10_000 }] }, sounds, T), true);
    assert.equal(somethingToHear({ ...quiet, effects: [{ id: "a", soundId: "thunder", at: T - 26_000 }] }, sounds, T), false, "over");
    assert.equal(somethingToHear({ ...quiet, effects: [{ id: "a", soundId: "rain", at: T - 1_000 }] }, sounds, T), false, "no longer an Effect");
    assert.equal(somethingToHear({ ...quiet, effects: [{ id: "a", builtin: "rumble", at: T - 1_000 }] }, sounds, T), true);
    assert.equal(somethingToHear({ ...quiet, dmEffects: [{ id: "a", builtin: "rumble", at: T - 1_000 }] }, sounds, T), true, "a DM's effect behind a blackout");
    assert.equal(somethingToHear(quiet, sounds, T), false);
    const run = { run: "r", repeat: "one" as const, fade: 5 as const, now: { soundId: "s", at: T - 60_000 } };
    assert.equal(somethingToHear({ ...quiet, music: run }, sounds, T), true);
    assert.equal(somethingToHear({ ...quiet, music: { ...run, paused: 4_000 } }, sounds, T), false, "a DM's paused run, which a player's projection drops");
  });
});

/*
 * An open ask and a state with nothing about sound in it
 * (docs/design/design-v1-sound-dm-only.md 5): while Only DM devices play,
 * and behind a blackout, a player's projection has no `playing`, so the ask
 * closes at once without passing, and the device is asked again at the
 * first state after with something to hear, as a late joiner is.
 */
describe("the ask and a state with nothing about sound", () => {
  const music: Playing = { ...quiet, music: { run: "r", repeat: "all", fade: 5, now: { soundId: "s", at: T - 60_000 } } };
  /** The ask through a run of confirmed states at the given server times, from closed, as the hook steps it: shown or not after each, and whether the timer passed it. The page loads at `loadAt`. */
  const timed = (states: [Playing | null | undefined, number][], passed = false, loadAt = T) => {
    let ask: AskState = ASK_START;
    const first = { ids: new Set<string>(), at: loadAt };
    return states.map(([playing, at]) => (ask = askStep(ask, { eligible: true, passed, playing, first, at })).asking);
  };
  /** The same with the page loaded at T and the states 10 s apart. */
  const through = (states: (Playing | null | undefined)[], passed = false) => timed(states.map((playing, i) => [playing, T + i * 10_000]), passed);

  test("an open ask closes when Only DM devices play turns on, unpassed, and asks again once it is off", () => {
    // The switch on: the player's projection loses `playing`.
    assert.deepEqual(through([music, null, null, music]), [true, false, false, true]);
  });

  test("the same behind a blackout, which also leaves a player no playing", () => {
    assert.deepEqual(through([music, music, null, music]), [true, true, false, true]);
  });

  // An effect-only ask: the effect was fired after the load, and the state is back after the close with the effect still listed.
  const fx = { id: "fx", builtin: "crash" as const, at: T + LEAD_MS };
  const effect: Playing = { ...quiet, effects: [fx] };

  test("an effect-only ask does not come back when the switch turns off, since its effect was fired before the close", () => {
    assert.deepEqual(through([effect, null, effect]), [true, false, false]);
  });

  test("nor when a blackout ends", () => {
    assert.deepEqual(through([effect, effect, null, effect, effect]), [true, true, false, false, false]);
  });

  test("an effect fired after the switch turns off asks again", () => {
    const fresh = { id: "fresh", builtin: "rumble" as const, at: T + 30_000 + LEAD_MS };
    assert.deepEqual(through([effect, null, effect, { ...effect, effects: [fx, fresh] }]), [true, false, false, true]);
  });

  test("an effect fired under a second before the close, inside firedAfter's slack, does not bring it back either", () => {
    // Fired at T, so scheduled at T + LEAD_MS, asked about at T + 500 and closed at T + 600 by the switch or a blackout.
    const soon = { id: "soon", builtin: "crash" as const, at: T + LEAD_MS };
    const listed: Playing = { ...quiet, effects: [soon] };
    const fresh = { id: "fresh", builtin: "rumble" as const, at: T + 60_100 + LEAD_MS };
    assert.deepEqual(
      timed([[listed, T + 500], [null, T + 600], [listed, T + 60_000], [{ ...listed, effects: [soon, fresh] }, T + 60_200]], false, T - 10_000),
      [true, false, false, true],
      "only the effect fired after the close asks",
    );
  });

  test("a reconnect's cleared store keeps it open, a passed ask never comes back, and a choice answers it", () => {
    assert.deepEqual(through([music, undefined, music]), [true, true, true]);
    assert.deepEqual(through([music, null, music], true), [false, false, false]);
    assert.equal(askShows(true, { eligible: false, passed: false, playing: music, worthy: true }), false);
    assert.equal(askShows(true, { eligible: true, passed: true, playing: music, worthy: true }), true, "the timer closes it, not a state");
  });
});

describe("a page's sound and the table display (docs/design/design-v1-sound-dm-only.md 5)", () => {

  test("a display is enabled only with its Sound on, no blackout and Only DM devices play off, so it never wins the handoff then", () => {
    assert.equal(soundEnabled(true, true, false, false), true);
    assert.equal(soundEnabled(true, true, false, true), false, "Only DM devices play");
    assert.equal(soundEnabled(true, true, true, false), false, "a blackout");
    assert.equal(soundEnabled(false, true, false, false), false);
  });

  test("a member's page follows its own mute alone, so a DM's plays on through both", () => {
    for (const blackout of [false, true]) for (const dmOnly of [false, true]) {
      assert.equal(soundEnabled(true, false, blackout, dmOnly), true);
      assert.equal(soundEnabled(false, false, blackout, dmOnly), false);
    }
  });
});

describe("the ask's answers (docs/design/design-v1-volume.md 5)", () => {
  test("Stay muted stores the mute, a choice made, so the ask never shows again, and keeps the level for an unmute", async () => {
    const { stayMuted } = await import("./useSoundAsk.ts");
    const { roomSoundChoice, setRoomSoundChoice, setSoundMix, soundMix } = await import("../../device/settings.ts");
    try {
      setSoundMix({ ...soundMix(), volume: 60 });
      setRoomSoundChoice(null);
      stayMuted();
      assert.equal(roomSoundChoice(), "off");
      assert.equal(soundMix().volume, 60);
      assert.equal(askShows(true, { eligible: false, passed: false, playing: quiet, worthy: true }), false, "a choice made is no longer eligible, which closes the ask");
    } finally {
      setRoomSoundChoice(null);
    }
  });
});

describe("the server's switch", () => {
  test("unknown until the server answers, never off, then on or off, and a failed read says so until the next ask", async () => {
    const real = api.getConfig;
    let answer: { resolve(config: unknown): void; reject(err: unknown): void } | null = null;
    api.getConfig = (() => new Promise((resolve, reject) => (answer = { resolve: resolve as (config: unknown) => void, reject }))) as typeof api.getConfig;
    const settled = () => new Promise((r) => setImmediate(r));
    try {
      resetServerRoomSoundForTests();
      assert.equal(serverSound(), "unknown");
      const first = serverRoomSound();
      assert.equal(serverSound(), "unknown", "asking");
      answer!.reject(new Error("offline"));
      assert.equal(await first, false);
      assert.equal(serverSound(), "failed");
      const again = serverRoomSound();
      assert.equal(serverSound(), "unknown", "asked again");
      answer!.resolve({ roomSound: true });
      assert.equal(await again, true);
      assert.equal(serverSound(), "on");
      resetServerRoomSoundForTests();
      void serverRoomSound();
      answer!.resolve({});
      await settled();
      assert.equal(serverSound(), "off");
    } finally {
      api.getConfig = real;
      resetServerRoomSoundForTests();
    }
  });
});
