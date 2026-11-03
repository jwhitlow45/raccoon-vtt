import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Playing } from "#shared/sound.ts";
import { createSoundUnlock, LISTEN_ELEMENT, mixerSupported, POOL_SIZE, SILENCE_URL, watchAudio, type PoolElement } from "./context.ts";
import { planVoices, Voices } from "./voices.ts";

/*
 * The room sound's unlock on lane audiounlock's helper (lib/activation.ts,
 * docs/design/design-v1-music.md 5.5 and 12): the pool's attempt answers
 * false and plays nothing with Room sound off, answers true only once every
 * play resolved, a blessing in flight is the one a second call gets, the
 * pool listens again when the context or the audio session leaves
 * `running` or `active`, and Play here's own call in its click blesses.
 */

/** A pooled element, with what Voices and Listen here set on it as well. */
type Fake = PoolElement & { plays: number; paused: boolean; currentTime: number; settle(ok: boolean): void };

function element(): Fake {
  let pending: { resolve(): void; reject(e: unknown): void } | null = null;
  const el: Fake & Record<string, unknown> = {
    src: "",
    muted: true,
    plays: 0,
    paused: true,
    currentTime: 0,
    playbackRate: 1,
    readyState: 4,
    volume: 1,
    play() {
      el.plays++;
      el.paused = false;
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    pause() {
      el.paused = true;
    },
    settle(ok) {
      if (ok) pending?.resolve();
      else pending?.reject(new DOMException("not allowed", "NotAllowedError"));
      pending = null;
    },
  };
  return el;
}

function context() {
  const target = new EventTarget();
  const ctx = {
    state: "suspended",
    resumes: 0,
    resume() {
      ctx.resumes++;
      return Promise.resolve();
    },
    addEventListener: (type: "statechange", fn: () => void) => target.addEventListener(type, fn),
    removeEventListener: (type: "statechange", fn: () => void) => target.removeEventListener(type, fn),
    change(state: string) {
      ctx.state = state;
      target.dispatchEvent(new Event("statechange"));
    },
  };
  return ctx;
}

function harness() {
  const target = new EventTarget();
  const els: Fake[] = [];
  const ctx = context();
  let made = 0;
  const unlock = createSoundUnlock({
    makeContext: () => {
      made++;
      return ctx;
    },
    makeElement: () => {
      const el = element();
      els.push(el);
      return el;
    },
    target,
  });
  const tap = () => target.dispatchEvent(Object.assign(new Event("pointerup"), { pointerType: "touch" }));
  return { target, els, ctx, unlock, tap, made: () => made };
}

const flush = () => new Promise((r) => setImmediate(r));

/** Enough of a gain node and an audio context for Voices, which only connects and schedules. */
function node(): AudioNode {
  const gain = { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
  return { gain, connect: (to: unknown) => to, disconnect() {} } as unknown as AudioNode;
}

function graph(): AudioContext {
  return { currentTime: 0, createGain: node, createMediaElementSource: node } as unknown as AudioContext;
}

describe("the room sound's unlock", () => {
  test("with Room sound off a tap touches nothing: no element plays and no context is made", () => {
    const h = harness();
    h.unlock.arm(() => false);
    h.tap();
    assert.equal(h.els.length, 0, "the pool is not even made");
    assert.equal(h.made(), 0);
  });

  test("with Room sound on a tap plays silence on every element inside the gesture, and answers true only once every play resolved", async () => {
    const h = harness();
    h.unlock.arm(() => true);
    h.tap();
    assert.equal(h.els.length, POOL_SIZE);
    for (const el of h.els) {
      assert.equal(el.plays, 1, "played synchronously in the tap");
      assert.equal(el.src, SILENCE_URL);
    }
    assert.equal(h.ctx.resumes, 1, "the context resumed in the same tap");
    // All but one resolve: still listening.
    for (const el of h.els.slice(1)) el.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), false);
    h.els[0]!.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), true);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 1), "once blessed it stops listening");
  });

  test("a refused play keeps it listening, and the next tap blesses again", async () => {
    const h = harness();
    h.unlock.arm(() => true);
    h.tap();
    h.els[3]!.settle(false);
    for (const el of h.els) el.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), false);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 2));
  });

  test("a call while a blessing is in flight returns it and plays nothing again", async () => {
    const h = harness();
    const first = h.unlock.blessPool();
    const second = h.unlock.blessPool();
    assert.equal(first, second);
    assert.ok(h.els.every((el) => el.plays === 1));
    for (const el of h.els) el.settle(true);
    assert.equal(await first, true);
  });

  test("Play here's own call in its click blesses the pool there, whatever the listeners did before", async () => {
    const h = harness();
    let on = false;
    h.unlock.arm(() => on);
    // The window's capture listeners run first, with the setting still off.
    h.tap();
    assert.equal(h.els.length, 0);
    // Then the click's own handler turns it on and blesses.
    on = true;
    const done = h.unlock.blessPool();
    assert.ok(h.els.every((el) => el.plays === 1));
    for (const el of h.els) el.settle(true);
    assert.equal(await done, true);
  });

  test("the pool listens again when the context leaves running or the audio session is interrupted", async () => {
    const h = harness();
    h.unlock.arm(() => true);
    h.tap();
    for (const el of h.els) el.settle(true);
    await flush();
    const session = Object.assign(new EventTarget(), { type: "auto", state: "active" as string });
    let left = 0;
    let changed = 0;
    const stop = watchAudio(
      h.ctx,
      session as unknown as Parameters<typeof watchAudio>[1],
      () => {
        left++;
        h.unlock.rearm();
      },
      () => changed++,
    );
    h.ctx.change("running");
    assert.equal(left, 0);
    h.ctx.change("interrupted");
    assert.equal(left, 1);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 2), "listening again after the context left running");
    for (const el of h.els) el.settle(true);
    await flush();
    session.state = "inactive";
    session.dispatchEvent(new Event("statechange"));
    assert.equal(left, 1, "a session at rest is not an interruption");
    session.state = "interrupted";
    session.dispatchEvent(new Event("statechange"));
    assert.equal(left, 2);
    h.tap();
    assert.ok(h.els.every((el) => el.plays === 3), "listening again after the session was interrupted");
    assert.ok(changed >= 4);
    stop();
  });

  test("a remounted SoundHost's gesture leaves an unlocked pool alone, and a bless after a real loss leaves the elements voices hold", async () => {
    const h = harness();
    const unarm = h.unlock.arm(() => true);
    h.tap();
    for (const el of h.els) el.settle(true);
    await flush();
    const now = 1_000_000;
    const voices = new Voices({ ctx: graph(), unlock: h.unlock, output: { music: node(), loop: node() }, serverNow: () => now, latencyMs: () => 0, url: (assetId) => `/api/assets/${assetId}` });
    const sounds = { tavern: { ms: 60_000, use: "music" as const, assetId: "a-tavern" }, rain: { ms: 10_000, use: "loop" as const, assetId: "a-rain" } };
    const playing: Playing = {
      rev: 1,
      music: { run: "r", repeat: "all", fade: 5, now: { soundId: "tavern", at: now - 10_000 } },
      loops: { a: { soundId: "rain", at: now - 1_000, volume: 70 } },
      effects: [],
      volume: { music: 100, effects: 100 },
    };
    voices.update(planVoices(playing, sounds, now), () => 300);
    const sources = () => h.els.map((el) => el.src);
    const plays = () => h.els.map((el) => el.plays);
    const playingSources = sources();
    assert.deepEqual([playingSources[0], playingSources[2]], ["/api/assets/a-tavern", "/api/assets/a-rain"]);
    const playsBefore = plays();

    // SoundHost remounts: its listener goes, a new one comes, and the next tap counts as a gesture.
    unarm();
    h.unlock.arm(() => true);
    h.tap();
    assert.deepEqual(sources(), playingSources, "the music and the loop keep their sources");
    assert.deepEqual(plays(), playsBefore, "and nothing plays silence");

    // The context was really lost: the next tap blesses, but not the two elements the voices hold.
    h.unlock.rearm();
    h.tap();
    assert.deepEqual([h.els[0]!.src, h.els[2]!.src], ["/api/assets/a-tavern", "/api/assets/a-rain"]);
    assert.deepEqual([h.els[0]!.plays, h.els[2]!.plays], [playsBefore[0], playsBefore[2]]);
    assert.ok(h.els.every((el, i) => i === 0 || i === 2 || (el.src === SILENCE_URL && el.plays === playsBefore[i]! + 1)), "every free element is blessed");
    for (const el of h.els) el.settle(true);
    await flush();
    assert.equal(h.unlock.blessed(), true);
    voices.update(planVoices(playing, sounds, now), () => 300);
    assert.deepEqual([h.els[0]!.src, h.els[2]!.src], ["/api/assets/a-tavern", "/api/assets/a-rain"]);

    // Once the voices go their elements are free for the next bless.
    voices.dispose();
    h.unlock.rearm();
    h.tap();
    assert.ok(h.els.every((el) => el.src === SILENCE_URL));
  });

  test("Listen here's element keeps its sound through a bless, and is blessed again once it stops", async () => {
    const g = globalThis as Record<string, unknown>;
    const before = g.Audio;
    g.Audio = function Audio() {
      return element();
    };
    try {
      const { soundUnlock } = await import("./context.ts");
      const { listenHere, stopListening } = await import("./store.ts");
      listenHere({ soundId: "rain", url: "/api/assets/a-rain" });
      const pool = soundUnlock().pool() as Fake[];
      const listening = pool[LISTEN_ELEMENT]!;
      const done = soundUnlock().blessPool();
      assert.equal(listening.src, "/api/assets/a-rain");
      assert.equal(listening.plays, 1, "only Listen here's own play");
      assert.ok(pool.every((el) => el === listening || el.src === SILENCE_URL));
      for (const el of pool) el.settle(true);
      assert.equal(await done, true);
      stopListening();
      soundUnlock().rearm();
      void soundUnlock().blessPool();
      assert.equal(listening.src, SILENCE_URL);
    } finally {
      g.Audio = before;
    }
  });

  test("a TV browser without Web Audio or createMediaElementSource cannot mix, so the display shows its can't-play line", () => {
    const g = globalThis as Record<string, unknown>;
    const before = { window: g.window, Audio: g.Audio };
    try {
      g.Audio = function Audio() {};
      g.window = {};
      assert.equal(mixerSupported(), false, "no AudioContext");
      g.window = { AudioContext: class {} };
      assert.equal(mixerSupported(), false, "no createMediaElementSource");
      g.window = { webkitAudioContext: class { createMediaElementSource() {} } };
      assert.equal(mixerSupported(), true, "Safari's prefixed context counts");
      g.window = { AudioContext: class { createMediaElementSource() {} } };
      assert.equal(mixerSupported(), true);
    } finally {
      g.window = before.window;
      g.Audio = before.Audio;
    }
  });
});
