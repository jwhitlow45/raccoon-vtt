import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEAD_MS, type Playing } from "#shared/sound.ts";

/*
 * When a player's device asks to play sound (docs/design/design-v1-music.md
 * 4.4): at load when something already plays, when music or a loop starts,
 * or when an effect is fired after the page loaded, never for an effect
 * fired before it. And what counts as something to hear at all.
 */

const { askWorthy } = await import("./useSoundAsk.ts");
const { firedAfter, somethingToHear } = await import("./store.ts");

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
