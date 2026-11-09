import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Playing } from "#shared/sound.ts";
import { createSoundUnlock, LISTEN_ELEMENT, mixerSupported, poolElement, POOL_SIZE, SILENCE_URL, watchAudio, type PoolElement } from "./context.ts";
import { planVoices, Voices } from "./voices.ts";

/*
 * The room sound's unlock on the shared activation helper (lib/activation.ts,
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

/**
 * An element as the HTML spec and Safari have it: it may play only once a
 * play() ran inside a gesture (`refuse` turns one down there too), a new
 * source or a pause rejects a pending play() with AbortError and pauses it,
 * and its end pauses it.
 */
type SpecElement = PoolElement & { paused: boolean; ended: boolean; allowed: boolean; refuse: boolean; plays: number; loaded(): void; end(): void };

let inGesture = false;

function specElement(): SpecElement {
  let pending: { resolve(): void; reject(e: unknown): void } | null = null;
  let src = "";
  const abort = () => {
    const p = pending;
    pending = null;
    p?.reject(new DOMException("The play() request was interrupted.", "AbortError"));
  };
  const el: SpecElement & Record<string, unknown> = {
    get src() {
      return src;
    },
    set src(next: string) {
      src = next;
      el.ended = false;
      el.paused = true;
      abort();
    },
    muted: true,
    paused: true,
    ended: false,
    allowed: false,
    refuse: false,
    plays: 0,
    currentTime: 0,
    playbackRate: 1,
    readyState: 4,
    volume: 1,
    play() {
      el.plays++;
      if (inGesture && !el.refuse) el.allowed = true;
      if (!el.allowed) return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
      el.paused = false;
      el.ended = false;
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    pause() {
      el.paused = true;
      abort();
    },
    loaded() {
      const p = pending;
      pending = null;
      p?.resolve();
    },
    end() {
      el.paused = true;
      el.ended = true;
    },
  };
  return el;
}

/** The pool on spec elements, Voices on it with music playing from `now`, and a tap that is a gesture while it runs. */
function specHarness() {
  const target = new EventTarget();
  const els: SpecElement[] = [];
  const ctx = context();
  const unlock = createSoundUnlock({ makeContext: () => ctx, makeElement: () => (els.push(specElement()), els.at(-1)!), target });
  const tap = () => {
    inGesture = true;
    try {
      target.dispatchEvent(Object.assign(new Event("pointerup"), { pointerType: "touch" }));
    } finally {
      inGesture = false;
    }
  };
  const clock = { now: 1_000_000 };
  // Where a file is read from now, which a loop's blob changes while its pass plays on.
  const where = { prefix: "/api/assets/" };
  const url = (assetId: string) => where.prefix + assetId;
  const voices = new Voices({ ctx: graph(), unlock, output: { music: node(), loop: node() }, serverNow: () => clock.now, latencyMs: () => 0, url, gestures: target });
  const sounds = { tavern: { ms: 60_000, use: "music" as const, assetId: "a-tavern" } };
  const playing: Playing = { rev: 1, music: { run: "r", repeat: "all", fade: 5, now: { soundId: "tavern", at: clock.now - 10_000 } }, loops: {}, effects: [], volume: { music: 100, effects: 100 } };
  const play = () => voices.update(planVoices(playing, sounds, clock.now), () => 300);
  return { target, els, unlock, tap, clock, where, voices, play, track: url("a-tavern") };
}

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

  test("Listen here plays on a muted device, the DM's own tap to hear a file (D-261108-383)", async () => {
    const g = globalThis as Record<string, unknown>;
    const before = g.Audio;
    g.Audio = function Audio() {
      return element();
    };
    try {
      const { soundUnlock } = await import("./context.ts");
      const { listenHere, stopListening } = await import("./store.ts");
      const { setRoomSoundChoice } = await import("../../device/settings.ts");
      setRoomSoundChoice("off");
      const listening = (soundUnlock().pool() as Fake[])[LISTEN_ELEMENT]!;
      const plays = listening.plays;
      listenHere({ soundId: "rain", url: "/api/assets/a-rain" });
      assert.equal(listening.plays, plays + 1, "it plays while muted");
      assert.equal(listening.src, "/api/assets/a-rain");
      stopListening();
      setRoomSoundChoice(null);
    } finally {
      g.Audio = before;
    }
  });

  test("the first tap's race: music that takes an element before its silence loads leaves the pool blessed, and the next tap touches nothing", async () => {
    const h = specHarness();
    h.unlock.arm(() => true);
    h.tap();
    // The context ran at once and the music took element 0, whose bless play() its new source superseded.
    h.play();
    assert.equal(h.els[0]!.src, h.track);
    for (const el of h.els) el.loaded();
    await flush();
    assert.equal(h.unlock.blessed(), true, "the play() inside the gesture unlocked element 0 all the same");
    const plays = h.els.map((el) => el.plays);
    h.tap();
    assert.deepEqual(h.els.map((el) => el.plays), plays, "the next tap plays nothing");
    assert.equal(h.els[0]!.src, h.track);
    assert.equal(h.els[0]!.paused, false);
  });

  test("pageshow listens again, but a blessed pool's next tap still touches nothing", async () => {
    const h = specHarness();
    h.unlock.arm(() => true);
    h.tap();
    for (const el of h.els) el.loaded();
    await flush();
    h.play();
    const plays = h.els.map((el) => el.plays);
    h.target.dispatchEvent(new Event("pageshow"));
    h.tap();
    assert.deepEqual(h.els.map((el) => el.plays), plays);
    assert.equal(h.els[0]!.src, h.track);
  });

  test("a voice whose element a bless refused plays once a later tap lets it, without its source ever going", async () => {
    const h = specHarness();
    h.els[0]!.refuse = true;
    h.unlock.arm(() => true);
    h.tap();
    for (const el of h.els) el.loaded();
    await flush();
    assert.equal(h.unlock.blessed(), false, "element 0 was refused");
    h.play();
    await flush();
    h.voices.check();
    assert.equal(h.els[0]!.paused, true, "its play is refused outside a gesture");
    const plays = h.els[0]!.plays;
    h.clock.now += 1_000;
    h.voices.check();
    assert.equal(h.els[0]!.plays, plays, "and not asked again until a gesture");
    h.els[0]!.refuse = false;
    h.tap();
    assert.equal(h.els[0]!.src, h.track, "the bless keeps a held element's source");
    assert.equal(h.els[0]!.paused, false, "the tap places it again, and now it may play");
    for (const el of h.els) el.loaded();
    await flush();
    assert.equal(h.unlock.blessed(), true);
    h.voices.check();
    assert.equal(h.els[0]!.paused, false);
    assert.equal(h.els[0]!.src, h.track);
  });

  test("the check puts back a voice whose source was swapped or whose element stopped short of its end", async () => {
    const h = specHarness();
    h.unlock.arm(() => true);
    h.tap();
    for (const el of h.els) el.loaded();
    await flush();
    h.play();
    const el = h.els[0]!;
    h.where.prefix = "blob:";
    // Checks come a second apart, each after the last task's promises are answered.
    await flush();
    h.voices.check();
    assert.equal(el.src, h.track, "a newer source for the same file waits for the next start");
    // Silence put in its place, as a bless did before it knew which elements voices hold: it plays its tenth of a second and ends.
    el.src = SILENCE_URL;
    el.end();
    h.clock.now += 1_000;
    await flush();
    h.voices.check();
    assert.equal(el.src, h.track);
    assert.equal(el.paused, false);
    el.end();
    h.clock.now += 1_000;
    await flush();
    h.voices.check();
    assert.equal(el.paused, false, "ended 12 s into a 60 s track, it plays again");
    // At its own end nothing is put back.
    h.clock.now += 47_800;
    el.end();
    await flush();
    h.voices.check();
    assert.equal(el.paused, true);
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

  test("U and the mute toggle unmute inside the press, blessing the pool there, and mute keeping the level (docs/design/design-v1-volume.md 5)", async () => {
    const { soundUnlock } = await import("./context.ts");
    const { toggleMute } = await import("./store.ts");
    const { roomSoundChoice, setRoomSoundChoice, setSoundMix, soundMix } = await import("../../device/settings.ts");
    const unlock = soundUnlock();
    const bless = unlock.blessPool;
    let blessed = 0;
    unlock.blessPool = () => (blessed++, Promise.resolve(true));
    try {
      setSoundMix({ ...soundMix(), volume: 70 });
      setRoomSoundChoice(null);
      toggleMute("player");
      assert.equal(roomSoundChoice(), "on", "a player's device not yet asked is muted, so U unmutes it");
      assert.equal(blessed, 1, "inside the press, since the capture listeners ran while it was muted");
      toggleMute("player");
      assert.equal(roomSoundChoice(), "off");
      assert.equal(soundMix().volume, 70, "muting keeps the level unmuting returns to");
      setRoomSoundChoice(null);
      toggleMute("dm");
      assert.equal(roomSoundChoice(), "off", "a DM device with no choice plays, so U mutes it");
      assert.equal(blessed, 1, "muting blesses nothing");
      toggleMute("dm");
      assert.equal(blessed, 2);
    } finally {
      unlock.blessPool = bless;
      setRoomSoundChoice(null);
    }
  });

  test("a pooled element reads ahead and lets the pitch go, so a change of rate never time-stretches", () => {
    const el = poolElement({ preload: "none", preservesPitch: true });
    assert.equal(el.preload, "auto");
    assert.equal(el.preservesPitch, false, "a time-stretch clicks at every change of rate (D-261102-870)");
  });

  test("an older browser's prefixed pitch switch is let go too, and none is made up where the browser has none", () => {
    const safari = poolElement({ preload: "none", preservesPitch: true, webkitPreservesPitch: true });
    assert.equal(safari.webkitPreservesPitch, false, "Safari before 15.4 reads only the webkit name");
    const firefox = poolElement({ preload: "none", preservesPitch: true, mozPreservesPitch: true });
    assert.equal(firefox.mozPreservesPitch, false, "Firefox before 101 reads only the moz name");
    const plain = poolElement({ preload: "none", preservesPitch: true });
    assert.ok(!("webkitPreservesPitch" in plain) && !("mozPreservesPitch" in plain));
  });
});
