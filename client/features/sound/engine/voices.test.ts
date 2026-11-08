import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import type { Op } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { LOOP_FADE_IN_MS, reanchor, SHORT_FADE_MS, STOP_FADE_MS, type MusicRun, type Playing, type Sound } from "#shared/sound.ts";
import { AT, DM, P1, room } from "#shared/testutil.ts";
import { SEEK_FADE_MS } from "./settle.ts";
import { BLACKOUT_FADE_MS, gainAt, JOIN_FADE_MS, leaveMs, LOOKAHEAD_MS, mixGain, MUSIC_FADE_MS, planVoices, Voices, type MusicState } from "./voices.ts";

/*
 * The voices a page plays at a server time (docs/design/design-v1-music.md
 * 5.2 and 5.3): music once or under Repeat one, the next track loaded
 * ahead and crossed in, loops crossing their loop points with the first
 * pass fading in, nothing before a sound's `at`, and the envelopes and
 * gains the elements follow.
 */

const T = 1_000_000;
const SOUNDS = {
  tavern: { ms: 60_000, use: "music" as const, assetId: "a-tavern" },
  road: { ms: 40_000, use: "music" as const, assetId: "a-road", level: -40 },
  rain: { ms: 10_000, use: "loop" as const, assetId: "a-rain" },
  drip: { ms: 4_000, use: "loop" as const, assetId: "a-drip" },
  bell: { ms: 2_000, use: "effect" as const, assetId: "a-bell" },
};
const quiet: Playing = { rev: 1, music: null, loops: {}, effects: [], volume: { music: 100, effects: 100 } };

describe("the voices at a time", () => {
  test("nothing for nothing playing", () => {
    assert.deepEqual(planVoices(null, SOUNDS, T), []);
    assert.deepEqual(planVoices(quiet, SOUNDS, T), []);
  });

  test("a track plays once at full volume, loaded ahead within the lookahead and gone after its end", () => {
    const playing: Playing = { ...quiet, music: { run: "r", repeat: "off", fade: 0, now: { soundId: "tavern", at: T } } };
    assert.deepEqual(planVoices(playing, SOUNDS, T - LOOKAHEAD_MS - 1), [], "nothing so long before");
    const ahead = planVoices(playing, SOUNDS, T - 400);
    assert.equal(ahead.length, 1, "loaded 0.4 s ahead");
    assert.equal(ahead[0]!.startAt, T);
    const v = planVoices(playing, SOUNDS, T + 1_000);
    assert.deepEqual(v.map((x) => x.key), [`m:tavern:${T}:0`]);
    assert.equal(gainAt(v[0]!.envelope, T), 1, "a track starts at full volume");
    assert.deepEqual(planVoices(playing, SOUNDS, T + 60_000), []);
  });

  test("the next track loads at its reveal and crosses in over the fade, the outgoing fading out over the same span", () => {
    const nextAt = T + 55_000;
    const playing: Playing = { ...quiet, music: { run: "r", repeat: "all", fade: 5, now: { soundId: "tavern", at: T }, next: { soundId: "road", at: nextAt } } };
    const early = planVoices(playing, SOUNDS, T + 40_000);
    assert.deepEqual(early.map((x) => x.soundId).sort(), ["road", "tavern"], "the next track's element loads at its reveal");
    const crossing = planVoices(playing, SOUNDS, nextAt + 2_500);
    const out = crossing.find((x) => x.soundId === "tavern")!;
    const into = crossing.find((x) => x.soundId === "road")!;
    assert.equal(gainAt(out.envelope, nextAt - 1), 1);
    assert.equal(gainAt(out.envelope, nextAt + 2_500), 0.5);
    assert.equal(gainAt(out.envelope, nextAt + 5_000), 0);
    assert.equal(gainAt(into.envelope, nextAt), 0);
    assert.equal(gainAt(into.envelope, nextAt + 2_500), 0.5);
    assert.equal(gainAt(into.envelope, nextAt + 5_000), 1);
    assert.equal(into.level, -40);
    // Promoted at the crossing's end: `next` is `now` with the same start, so the same voice plays on.
    const promoted: Playing = { ...quiet, music: { run: "r", repeat: "all", fade: 5, now: { soundId: "road", at: nextAt } } };
    assert.deepEqual(planVoices(promoted, SOUNDS, nextAt + 6_000).map((x) => x.key), [into.key]);
  });

  test("a crossfade placed late shortens to what remains of the outgoing track", () => {
    const nextAt = T + 58_000;
    const playing: Playing = { ...quiet, music: { run: "r", repeat: "all", fade: 10, now: { soundId: "tavern", at: T }, next: { soundId: "road", at: nextAt } } };
    const out = planVoices(playing, SOUNDS, nextAt + 1_000).find((x) => x.soundId === "tavern")!;
    assert.equal(gainAt(out.envelope, T + 60_000), 0, "silent at its own end, 2 s in, not 10");
  });

  test("Repeat one passes cross over the run's fade, the later fading in, and the next pass loads ahead", () => {
    const playing: Playing = { ...quiet, music: { run: "r", repeat: "one", fade: 5, now: { soundId: "tavern", at: T } } };
    // The period is 55 s: pass 1 starts at 55 s.
    const before = planVoices(playing, SOUNDS, T + 53_000);
    assert.deepEqual(before.map((x) => x.key), [`m:tavern:${T}:0`, `m:tavern:${T}:1`], "the next pass is loaded ahead");
    const during = planVoices(playing, SOUNDS, T + 57_000);
    const first = during.find((x) => x.key.endsWith(":0"))!;
    const second = during.find((x) => x.key.endsWith(":1"))!;
    assert.equal(second.startAt, T + 55_000);
    assert.equal(gainAt(first.envelope, T + 57_500), 0.5);
    assert.equal(gainAt(second.envelope, T + 57_500), 0.5);
    assert.equal(gainAt(first.envelope, T), 1, "the first pass starts at full volume");
  });

  test("the last track with nothing after it fades out over its last 2 s, Repeat off's last track and a next that is no longer music alike", () => {
    const end = T + 60_000;
    const last: Playing = { ...quiet, music: { run: "r", repeat: "off", fade: 5, now: { soundId: "tavern", at: T } } };
    const v = planVoices(last, SOUNDS, T + 50_000)[0]!;
    assert.equal(gainAt(v.envelope, T), 1, "the envelope starts at full: the fade-in is the element's");
    assert.equal(gainAt(v.envelope, end - MUSIC_FADE_MS), 1);
    assert.equal(gainAt(v.envelope, end - MUSIC_FADE_MS / 2), 0.5);
    assert.equal(gainAt(v.envelope, end), 0);
    const gone: Playing = { ...quiet, music: { ...last.music!, repeat: "all", next: { soundId: "bell", at: end - 5_000 } } };
    assert.equal(gainAt(planVoices(gone, SOUNDS, T + 50_000)[0]!.envelope, end - MUSIC_FADE_MS / 2), 0.5, "a next track that is an effect now ends the run");
  });

  test("a track another follows keeps its ending: a crossfade crosses, Off plays to its end at full, and Repeat one only crosses itself", () => {
    const end = T + 60_000;
    const off: Playing = { ...quiet, music: { run: "r", repeat: "all", fade: 0, now: { soundId: "tavern", at: T }, next: { soundId: "road", at: end } } };
    const [out, into] = ["tavern", "road"].map((id) => planVoices(off, SOUNDS, end - 1_000).find((x) => x.soundId === id)!);
    assert.equal(gainAt(out!.envelope, end - 1), 1, "Off: the outgoing track at full to its end");
    assert.equal(gainAt(into!.envelope, end), 1, "Off: the next at full from its start");
    const cross: Playing = { ...quiet, music: { ...off.music!, fade: 5, next: { soundId: "road", at: end - 5_000 } } };
    const crossing = planVoices(cross, SOUNDS, end - 6_000).find((x) => x.soundId === "tavern")!;
    assert.deepEqual(crossing.envelope, [
      [T, 1],
      [end - 5_000, 1],
      [end, 0],
    ]);
    assert.equal(gainAt(crossing.envelope, end - 5_000), 1, "full until the crossfade");
    assert.equal(gainAt(crossing.envelope, end - 2_500), 0.5, "the crossfade's line, not a 2 s fade's");
    const one: Playing = { ...quiet, music: { run: "r", repeat: "one", fade: 0, now: { soundId: "tavern", at: T } } };
    const pass = planVoices(one, SOUNDS, end - 1_000).find((x) => x.key.endsWith(":0"))!;
    assert.equal(gainAt(pass.envelope, end - 1), 1, "Repeat one with no crossfade: each pass at full to its end");
  });

  test("only music's own track fades in: `now`'s first pass, never `next`, a Repeat one later pass or a loop", () => {
    const run = { run: "r", repeat: "one" as const, fade: 5 as const, now: { soundId: "tavern", at: T } };
    const passes = planVoices({ ...quiet, music: run }, SOUNDS, T + 54_000);
    assert.deepEqual(
      passes.map((x) => [x.key.split(":").at(-1), x.fadeIn ?? false]),
      [
        ["0", true],
        ["1", false],
      ],
    );
    const crossing: Playing = { ...quiet, music: { ...run, repeat: "all", next: { soundId: "road", at: T + 55_000 } }, loops: { a: { soundId: "rain", at: T, volume: 70 } } };
    const plan = planVoices(crossing, SOUNDS, T + 54_000);
    assert.deepEqual(
      plan.filter((x) => x.channel === "music").map((x) => [x.soundId, x.fadeIn ?? false]),
      [
        ["tavern", true],
        ["road", false],
      ],
    );
    assert.ok(plan.some((x) => x.channel === "loop") && plan.every((x) => x.channel === "music" || x.fadeIn === undefined), "no loop fades in so");
  });

  test("a 10 s loop: loaded 0.4 s before its start, the first pass fading in over 2 s, and at 9 s the first and second passes at 9 and 1 s", () => {
    const playing: Playing = { ...quiet, loops: { a: { soundId: "rain", at: T, volume: 70 } } };
    const ahead = planVoices(playing, SOUNDS, T - 400);
    assert.equal(ahead.length, 1);
    assert.equal(ahead[0]!.startAt, T);
    const first = planVoices(playing, SOUNDS, T + 1_000);
    assert.equal(first.length, 1);
    assert.equal(gainAt(first[0]!.envelope, T), 0);
    assert.equal(gainAt(first[0]!.envelope, T + LOOP_FADE_IN_MS / 2), 0.5);
    assert.equal(gainAt(first[0]!.envelope, T + LOOP_FADE_IN_MS), 1);
    const late = planVoices(playing, SOUNDS, T + 9_000);
    assert.deepEqual(
      late.map((x) => [x.key.split(":").at(-1), T + 9_000 - x.startAt]),
      [
        ["0", 9_000],
        ["1", 1_000],
      ],
    );
    const second = late.find((x) => x.key.endsWith(":1"))!;
    assert.equal(gainAt(second.envelope, T + 9_000), 0.5, "the second pass fades in over the 2 s crossing");
    assert.ok(Math.abs(mixGain(second) - 0.49) < 1e-9, "70% squared");
  });

  test("a short loop crosses over a quarter of its length on two elements at most, and a loop whose sound is no longer a loop is skipped", () => {
    const playing: Playing = { ...quiet, loops: { a: { soundId: "drip", at: T, volume: 100 }, b: { soundId: "bell", at: T, volume: 100 } } };
    const voices = planVoices(playing, SOUNDS, T + 3_500);
    assert.ok(voices.every((v) => v.soundId === "drip"));
    // 4 s with a 1 s crossing: the period is 3 s, so at 3.5 s the second pass is 0.5 s in, and the third waits for the first to end.
    assert.deepEqual(voices.map((v) => T + 3_500 - v.startAt).sort((a, b) => a - b), [500, 3_500]);
    for (let t = T; t < T + 30_000; t += 100) assert.ok(planVoices(playing, SOUNDS, t).length <= 2, `two at most at ${t - T}`);
  });

  test("a paused run sounds on no device: the DM's confirmed state keeps it whole, Repeat one included, and its loops play on", () => {
    const base = Date.parse(AT);
    const library: Record<string, Sound> = {
      tavern: { id: "tavern", rev: 0, name: "Tavern", assetId: "a-tavern", ms: 60_000, use: "music" },
      rain: { id: "rain", rev: 0, name: "Rain", assetId: "a-rain", ms: 10_000, use: "loop" },
    };
    let state = room({ sounds: library, playing: null });
    const ops: [Op, number][] = [
      [{ t: "music.play", run: "r1", soundId: "tavern", order: ["tavern"], repeat: "one", fade: 5 }, 0],
      [{ t: "loop.start", id: "l1", soundId: "rain", volume: 70 }, 0],
      [{ t: "music.pause" }, 5_000],
    ];
    ops.forEach(([op, ms], i) => {
      const r = applyOp(state, op, DM, { seq: i + 1, at: new Date(base + ms).toISOString() });
      assert.ok(r.ok, op.t);
      state = r.state;
    });
    const dm = projectState(state, DM, { sceneId: null });
    assert.notEqual(dm.playing?.music?.paused, undefined, "the DM's state holds the paused run");
    const pat = projectState(state, P1, { sceneId: null });
    assert.equal(pat.playing?.music, null, "a player's has no music while paused");
    // Past the pause, and Repeat one's passes, which once went on for good.
    for (const later of [5_001, 10_000, 56_000, 600_000]) {
      for (const [who, view] of [["the DM", dm], ["Pat", pat]] as const) {
        const voices = planVoices(view.playing, view.sounds ?? {}, base + later);
        assert.deepEqual(voices.filter((v) => v.channel === "music").map((v) => v.key), [], `${who}: no music ${later} ms in`);
        assert.ok(voices.some((v) => v.channel === "loop"), `${who}: the loop plays on ${later} ms in`);
      }
    }
  });

  test("a voice leaving fades as players' devices fade it: a pause is a stop, a replaced track goes in 0.3 s, a blackout in a second", () => {
    const run = { run: "r", repeat: "all" as const, fade: 5 as const, now: { soundId: "tavern", at: T } };
    assert.equal(leaveMs({ ...quiet, music: run }, "music"), SHORT_FADE_MS, "another track took its place");
    assert.equal(leaveMs({ ...quiet, music: { ...run, paused: 4_000 } }, "music"), STOP_FADE_MS, "paused, as a player's music stops");
    assert.equal(leaveMs(quiet, "music"), STOP_FADE_MS);
    assert.equal(leaveMs({ ...quiet, music: run }, "loop"), STOP_FADE_MS);
    assert.equal(leaveMs(null, "music"), BLACKOUT_FADE_MS);
  });

  test("gainAt runs in lines between its points and holds past either end", () => {
    const env = [
      [10, 0],
      [20, 1],
      [30, 1],
      [40, 0],
    ] as const;
    assert.equal(gainAt(env, 0), 0);
    assert.equal(gainAt(env, 15), 0.5);
    assert.equal(gainAt(env, 25), 1);
    assert.equal(gainAt(env, 35), 0.5);
    assert.equal(gainAt(env, 50), 0);
    assert.equal(gainAt([], 5), 1);
    assert.equal(mixGain({ level: -60, volume: 100, channel: "music" }), 10 ** (-60 / 200));
  });
});

/** An audio param that keeps what was scheduled on it, and a context and pool enough for Voices. */
type Event = { kind: "cancel" | "set" | "ramp"; value: number; at: number };
function param() {
  const events: Event[] = [];
  return {
    value: 1,
    events,
    cancelScheduledValues(at: number) {
      events.push({ kind: "cancel", value: NaN, at });
    },
    setValueAtTime(value: number, at: number) {
      events.push({ kind: "set", value, at });
      this.value = value;
    },
    linearRampToValueAtTime(value: number, at: number) {
      events.push({ kind: "ramp", value, at });
    },
  };
}

/**
 * A pooled element that counts its plays, seeks and loads, and refuses a play with the error `refuse` names for its source, if
 * any. Setting its source starts a load and clears its error, as a browser's does even for the same source.
 */
function element(refuse: (src: string) => string | null) {
  let at = 0;
  let src = "";
  return {
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      this.loads++;
      this.error = null;
    },
    loads: 0,
    error: null as { code: number } | null,
    muted: false,
    paused: true,
    playbackRate: 1,
    readyState: 4,
    plays: 0,
    seeks: 0,
    onplaying: null as (() => void) | null,
    onerror: null as (() => void) | null,
    get currentTime() {
      return at;
    },
    set currentTime(value: number) {
      at = value;
      this.seeks++;
    },
    play() {
      this.plays++;
      const refusal = refuse(this.src);
      if (refusal !== null) return Promise.reject(new DOMException("refused", refusal));
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
}

function rig(t: { now: number }, opts: { refuse?: (src: string) => string | null; gestures?: EventTarget; onMusic?: (state: MusicState) => void } = {}) {
  const gains: { gain: ReturnType<typeof param> }[] = [];
  const node = () => {
    const n = { gain: param(), connect: (to: unknown) => to, disconnect() {} };
    gains.push(n);
    return n;
  };
  const ctx = { currentTime: 0, createGain: node, createMediaElementSource: () => ({ connect: (to: unknown) => to, disconnect() {} }) } as unknown as AudioContext;
  const pool = Array.from({ length: 11 }, () => element(opts.refuse ?? (() => null)));
  const unlock = { pool: () => pool, holdWith: () => () => {} };
  const output = { music: node(), loop: node() } as unknown as Record<"music" | "loop", AudioNode>;
  gains.length = 0;
  const voices = new Voices({ ctx, unlock, output, serverNow: () => t.now, latencyMs: () => 0, url: (assetId) => `/api/assets/${assetId}`, gestures: opts.gestures, onMusic: opts.onMusic });
  return { voices, pool, gains, ctx: ctx as unknown as { currentTime: number } };
}

describe("the voices on the pool", () => {
  test("a track that finds both music elements fading out, as after a Skip in a crossfade, starts once the first is free, not at the next check", async () => {
    const t = { now: T };
    const { voices, pool } = rig(t);
    const crossing: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T - 57_000 }, next: { soundId: "road", at: T - 2_000 } } };
    voices.update(planVoices(crossing, SOUNDS, t.now), () => SHORT_FADE_MS);
    assert.equal(voices.snapshot().length, 2, "both tracks sound");
    const skipped: Playing = { ...quiet, music: { run: "r2", repeat: "all", fade: 5, now: { soundId: "road", at: T } } };
    voices.update(planVoices(skipped, SOUNDS, t.now), () => SHORT_FADE_MS);
    assert.deepEqual(voices.snapshot(), [], "both elements fade out first");
    await new Promise((r) => setTimeout(r, SHORT_FADE_MS + 150));
    assert.deepEqual(voices.snapshot().map((v) => v.key), [`m:road:${T}:0`]);
    assert.ok(pool.slice(0, 2).some((el) => el.src === "/api/assets/a-road" && !el.paused));
    voices.dispose();
  });

  // The engine stops this way when Room sound goes off and when another page takes the sound, and a display's blackout too.
  for (const [how, stop] of [
    ["a stop", (voices: Voices) => voices.stopAll(SHORT_FADE_MS)],
    ["a blackout's empty plan", (voices: Voices) => voices.update([], () => BLACKOUT_FADE_MS)],
  ] as const) {
    test(`${how} while a track waits for an element, as Room sound off or another page taking the sound during a Skip in a crossfade, starts nothing later`, async () => {
      const t = { now: T };
      const { voices, pool } = rig(t);
      const crossing: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T - 57_000 }, next: { soundId: "road", at: T - 2_000 } } };
      voices.update(planVoices(crossing, SOUNDS, t.now), () => SHORT_FADE_MS);
      const skipped: Playing = { ...quiet, music: { run: "r2", repeat: "all", fade: 5, now: { soundId: "road", at: T } } };
      voices.update(planVoices(skipped, SOUNDS, t.now), () => SHORT_FADE_MS);
      const plays = pool.reduce((n, el) => n + el.plays, 0);
      stop(voices);
      await new Promise((r) => setTimeout(r, SHORT_FADE_MS + 150));
      assert.deepEqual(voices.snapshot(), [], "nothing sounds");
      assert.equal(pool.reduce((n, el) => n + el.plays, 0), plays, "no element was played after the stop");
      assert.ok(pool.every((el) => el.paused));
      voices.update(planVoices(skipped, SOUNDS, t.now), () => SHORT_FADE_MS);
      assert.deepEqual(voices.snapshot().map((v) => v.key), [`m:road:${T}:0`], "the page playing again starts the track at once");
      voices.dispose();
    });
  }

  test("a pass that ends while it waits for an element never starts", async () => {
    const t = { now: T };
    const { voices } = rig(t);
    const crossing: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T - 57_000 }, next: { soundId: "road", at: T - 2_000 } } };
    voices.update(planVoices(crossing, SOUNDS, t.now), () => SHORT_FADE_MS);
    // A run whose 40 s track has 0.1 s left, which is over by the time an element is free.
    const ending: Playing = { ...quiet, music: { run: "r2", repeat: "off", fade: 0, now: { soundId: "road", at: T - 39_900 } } };
    voices.update(planVoices(ending, SOUNDS, t.now), () => SHORT_FADE_MS);
    t.now += 200;
    await new Promise((r) => setTimeout(r, SHORT_FADE_MS + 150));
    assert.deepEqual(voices.snapshot(), []);
    voices.dispose();
  });

  test("a kept voice whose gain changes, as the incoming track promoted halfway through a crossfade, ramps to it over 0.3 s, at once and at the next check", () => {
    const t = { now: T };
    const { voices, gains, ctx } = rig(t);
    const crossing: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T - 57_000 }, next: { soundId: "road", at: T - 2_000 } } };
    voices.update(planVoices(crossing, SOUNDS, t.now), () => SHORT_FADE_MS);
    // Each voice makes its fade, envelope and mix gains in turn: Road's envelope is the fifth.
    const road = gains[4]!.gain;
    assert.equal(road.value, 0.4, "two fifths into its crossfade");
    const promoted: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "road", at: T - 2_000 } } };
    const after = () => road.events.slice(road.events.findLastIndex((e) => e.kind === "cancel") + 1);
    voices.update(planVoices(promoted, SOUNDS, t.now), () => SHORT_FADE_MS);
    assert.deepEqual(after().slice(0, 2), [
      { kind: "set", value: 0.4, at: 0 },
      { kind: "ramp", value: 1, at: SHORT_FADE_MS / 1000 },
    ]);
    t.now += 100;
    ctx.currentTime = 0.1;
    voices.check();
    const ramp = after()[1]!;
    assert.ok(ramp.kind === "ramp" && ramp.value === 1 && Math.abs(ramp.at - SHORT_FADE_MS / 1000) < 1e-9, "the check keeps the ramp, never a step to 1");
    assert.ok(after().every((e) => e.kind !== "set" || e.value === 0.4));
    voices.dispose();
  });

  test("a track an op starts fades in over 2 s from its start on the audio clock, and the next track under Off starts at full", () => {
    const t = { now: T - 400 };
    const { voices, gains } = rig(t);
    voices.update(planVoices({ ...quiet, music: { run: "r1", repeat: "all", fade: 0, now: { soundId: "tavern", at: T } } }, SOUNDS, t.now), () => SHORT_FADE_MS);
    // Each voice makes its fade, envelope and mix gains in turn: the fade is the first.
    const fade = gains[0]!.gain;
    assert.deepEqual(fade.events.slice(fade.events.findLastIndex((e) => e.kind === "cancel") + 1), [
      { kind: "set", value: 0, at: 0 },
      { kind: "set", value: 0, at: 0.4 },
      { kind: "ramp", value: 1, at: 0.4 + MUSIC_FADE_MS / 1000 },
    ]);
    voices.dispose();

    const later = { now: T + 59_600 };
    const next = rig(later);
    const off: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 0, now: { soundId: "tavern", at: T }, next: { soundId: "road", at: T + 60_000 } } };
    next.voices.update(planVoices(off, SOUNDS, later.now), () => SHORT_FADE_MS);
    // Tavern's three gains, then Road's.
    const road = next.gains[3]!.gain;
    assert.deepEqual(road.events.slice(road.events.findLastIndex((e) => e.kind === "cancel") + 1), [{ kind: "set", value: 1, at: 0 }], "back to back at full");
    next.voices.dispose();
  });

  test("a resume or a join fades music's own track in over 2 s from when it is placed, and a background sound over 0.3 s", () => {
    const t = { now: T + 10_000 };
    const { voices, gains } = rig(t);
    voices.update(planVoices({ ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T } }, loops: { a: { soundId: "rain", at: T, volume: 70 } } }, SOUNDS, t.now), () => SHORT_FADE_MS);
    const tail = (p: ReturnType<typeof param>) => p.events.slice(p.events.findLastIndex((e) => e.kind === "cancel") + 1);
    assert.deepEqual(tail(gains[0]!.gain), [
      { kind: "set", value: 0, at: 0 },
      { kind: "ramp", value: 1, at: MUSIC_FADE_MS / 1000 },
    ]);
    assert.deepEqual(tail(gains[3]!.gain), [
      { kind: "set", value: 0, at: 0 },
      { kind: "ramp", value: 1, at: JOIN_FADE_MS / 1000 },
    ]);
    voices.dispose();
  });

  const fadeEvents = (p: { events: { kind: string; value: number; at: number }[] }) => p.events.slice(p.events.findLastIndex((e) => e.kind === "cancel") + 1);

  test("music placed mid-track that first sounds late, as a slow first load leaves it, fades in afresh then, and a later stall leaves the fade alone", () => {
    const t = { now: T + 10_000 };
    const { voices, gains, pool, ctx } = rig(t);
    voices.update(planVoices({ ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T } } }, SOUNDS, t.now), () => SHORT_FADE_MS);
    const fade = gains[0]!.gain;
    const el = pool[0]! as unknown as { onplaying: (() => void) | null };
    ctx.currentTime = 3;
    el.onplaying!();
    assert.deepEqual(fadeEvents(fade), [
      { kind: "set", value: 0, at: 3 },
      { kind: "ramp", value: 1, at: 3 + MUSIC_FADE_MS / 1000 },
    ]);
    const after = fade.events.length;
    ctx.currentTime = 9;
    el.onplaying!();
    assert.equal(fade.events.length, after, "a stall's playing again starts no fade");
    voices.dispose();

    const soon = rig({ now: T + 10_000 });
    soon.voices.update(planVoices({ ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T } } }, SOUNDS, T + 10_000), () => SHORT_FADE_MS);
    soon.ctx.currentTime = 0.1;
    (soon.pool[0]! as unknown as { onplaying: () => void }).onplaying();
    assert.deepEqual(fadeEvents(soon.gains[0]!.gain), [
      { kind: "set", value: 0, at: 0 },
      { kind: "ramp", value: 1, at: MUSIC_FADE_MS / 1000 },
    ], "a timely first sound keeps the fade it was given");
    soon.voices.dispose();
  });

  test("a start loaded ahead keeps its shared ramp when it sounds on time, ignores a bless's play before its start, and fades in afresh when it sounds late", async () => {
    for (const lateBy of [0, 3]) {
      const t = { now: T - 100 };
      const { voices, gains, pool, ctx } = rig(t);
      voices.update(planVoices({ ...quiet, music: { run: "r1", repeat: "all", fade: 0, now: { soundId: "tavern", at: T } } }, SOUNDS, t.now), () => SHORT_FADE_MS);
      const fade = gains[0]!.gain;
      const el = pool[0]! as unknown as { onplaying: () => void };
      const shared = fadeEvents(fade);
      el.onplaying();
      assert.deepEqual(fadeEvents(fade), shared, "a bless's play of the element loaded ahead is no start");
      await new Promise((r) => setTimeout(r, 150));
      t.now = T + 50;
      ctx.currentTime = 0.15 + lateBy;
      el.onplaying();
      if (lateBy === 0) assert.deepEqual(fadeEvents(fade), shared, "on time: the ramp from the start's server time stands");
      else
        assert.deepEqual(fadeEvents(fade), [
          { kind: "set", value: 0, at: ctx.currentTime },
          { kind: "ramp", value: 1, at: ctx.currentTime + MUSIC_FADE_MS / 1000 },
        ]);
      voices.dispose();
    }
  });

  test("a change of Repeat during Repeat one's third pass renames the voice, which plays on on its element with no new fade", () => {
    const t = { now: T };
    const { voices, gains, pool } = rig(t);
    const one: MusicRun = { run: "r1", repeat: "one", fade: 5, now: { soundId: "tavern", at: T - 120_000 } };
    voices.update(planVoices({ ...quiet, music: one }, SOUNDS, t.now), () => SHORT_FADE_MS);
    assert.deepEqual(voices.snapshot().map((v) => v.key), [`m:tavern:${T - 120_000}:2`]);
    const fade = gains[0]!.gain;
    const before = fade.events.length;
    const made = gains.length;
    const off = reanchor({ ...one, repeat: "off" }, one, SOUNDS, t.now);
    assert.equal(off.now.at, T - 10_000, "the reanchor moves now.at to the pass sounding");
    voices.update(planVoices({ ...quiet, music: off }, SOUNDS, t.now), () => SHORT_FADE_MS);
    assert.deepEqual(voices.snapshot().map((v) => v.key), [`m:tavern:${T - 10_000}:0`]);
    assert.equal(gains.length, made, "no second element's gains");
    assert.equal(fade.events.length, before, "no new fade, in or out");
    assert.equal(pool.filter((e) => e.plays > 0).length, 1, "one element plays");
    voices.dispose();
  });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const playingTavern: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T - 10_000 } } };

  test("a track whose play the browser refuses until a gesture stays loading across checks, is not sought or played again, and plays inside the next gesture", async () => {
    const t = { now: T };
    const states: MusicState[] = [];
    const gestures = new EventTarget();
    let allowed = false;
    const { voices, pool } = rig(t, { refuse: () => (allowed ? null : "NotAllowedError"), gestures, onMusic: (s) => states.push(s) });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    await wait(250);
    assert.deepEqual(states, ["playing", "loading"], "past the indicator's 200 ms it loads");
    const tried = { plays: el.plays, seeks: el.seeks };
    for (let i = 0; i < 2; i++) {
      t.now += 1_000;
      voices.check();
      await wait(250);
    }
    assert.deepEqual(states, ["playing", "loading"], "two checks later it still loads, never back to playing for a moment");
    assert.deepEqual({ plays: el.plays, seeks: el.seeks }, tried, "no play and no seek, so no range is fetched again");
    // A gesture the browser still refuses the play in, as a key it does not count would be, leaves it waiting for the next.
    gestures.dispatchEvent(new Event("click"));
    assert.equal(el.plays, tried.plays + 1, "placed again inside the gesture");
    await wait(10);
    voices.check();
    assert.equal(el.plays, tried.plays + 1);
    assert.deepEqual(states, ["playing", "loading"]);
    allowed = true;
    gestures.dispatchEvent(new Event("click"));
    assert.equal(el.plays, tried.plays + 2, "and again inside the next");
    assert.ok(!el.paused);
    assert.equal(states.at(-1), "playing");
    await wait(10);
    el.paused = true;
    t.now += 1_000;
    voices.check();
    assert.equal(el.plays, tried.plays + 3, "once it played, a stop short of its end is put back at the check");
    voices.dispose();
  });

  test("a gesture places only the refused voice again, never one already sounding", async () => {
    const t = { now: T };
    const gestures = new EventTarget();
    const withRain: Playing = { ...playingTavern, loops: { l1: { soundId: "rain", at: T - 2_000, volume: 100 } } };
    const { voices, pool } = rig(t, { refuse: (src) => (src.endsWith("a-tavern") ? "NotAllowedError" : null), gestures });
    voices.update(planVoices(withRain, SOUNDS, t.now), () => SHORT_FADE_MS);
    await wait(10);
    const rain = pool.find((e) => e.src === "/api/assets/a-rain")!;
    const tavern = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    const before = { rain: rain.seeks, tavern: tavern.plays };
    gestures.dispatchEvent(new Event("click"));
    assert.equal(tavern.plays, before.tavern + 1);
    assert.equal(rain.seeks, before.rain, "the background sound plays on untouched");
    voices.dispose();
  });

  test("a refused track that stops before the next gesture is not played by it", async () => {
    const t = { now: T };
    const gestures = new EventTarget();
    let allowed = false;
    const { voices, pool } = rig(t, { refuse: () => (allowed ? null : "NotAllowedError"), gestures });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    await wait(10);
    const plays = pool.reduce((n, e) => n + e.plays, 0);
    voices.stopAll(SHORT_FADE_MS);
    allowed = true;
    gestures.dispatchEvent(new Event("click"));
    assert.equal(pool.reduce((n, e) => n + e.plays, 0), plays);
    assert.ok(pool.every((e) => e.paused));
    voices.dispose();
  });

  test("a refusal that answers an older play, after Try again started a newer one, leaves the voice to be put back", async () => {
    const t = { now: T };
    const { voices, pool } = rig(t, { gestures: new EventTarget() });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    await wait(10);
    const play = el.play;
    let refuseOlder = (_err: unknown) => {};
    // The next play hangs, as one waiting for data does, and is refused only after a later one plays.
    el.play = function () {
      this.plays++;
      this.paused = false;
      el.play = play;
      return new Promise<void>((_ok, no) => {
        refuseOlder = no;
      });
    };
    el.paused = true;
    t.now += 1_000;
    voices.check();
    el.onerror?.();
    voices.retry();
    assert.ok(!el.paused, "the newer play sounds");
    refuseOlder(new DOMException("refused", "NotAllowedError"));
    await wait(10);
    el.paused = true;
    const plays = el.plays;
    t.now += 1_000;
    voices.check();
    assert.equal(el.plays, plays + 1, "stopped again, it is put back at the check");
    voices.dispose();
  });

  test("a track the tick's plan read starts is not put back by the same tick's check before its play is answered", () => {
    const t = { now: T };
    const { voices, pool } = rig(t, { refuse: () => "NotAllowedError", gestures: new EventTarget() });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    voices.check();
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    assert.deepEqual({ plays: el.plays, seeks: el.seeks }, { plays: 1, seeks: 1 });
    voices.dispose();
  });

  test("a track that falls behind, as through a stall on a slow connection, is never sought or slowed: it plays on from where it is", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const t = { now: T };
      const { voices, pool } = rig(t, { gestures: new EventTarget() });
      voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      for (let i = 0; i < 3; i++) await Promise.resolve();
      const placed = { seeks: el.seeks, plays: el.plays };
      // The element stands still while the timeline moves on 10 s: 10 s behind by the end. Each check's seek would land after its fade.
      for (let i = 0; i < 10; i++) {
        t.now += 1_000;
        voices.check();
        mock.timers.tick(SEEK_FADE_MS);
      }
      assert.deepEqual({ seeks: el.seeks, plays: el.plays, rate: el.playbackRate }, { ...placed, rate: 1 });
      voices.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test("a next pass whose start timer a throttled phone ran 5 s late is sought once to its place, and one on time is left alone", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const t = { now: T };
      const ahead: Playing = { ...quiet, music: { run: "r1", repeat: "off", fade: 0, now: { soundId: "tavern", at: T + 1_000 } } };
      const { voices, pool } = rig(t, { gestures: new EventTarget() });
      voices.update(planVoices(ahead, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      const loaded = el.seeks;
      // The timer runs 5 s after its time.
      t.now = T + 6_000;
      mock.timers.tick(1_000);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      voices.check();
      mock.timers.tick(SEEK_FADE_MS);
      assert.equal(el.seeks, loaded + 1, "sought once");
      assert.equal(el.currentTime, 5, "to its place");
      t.now += 1_000;
      voices.check();
      mock.timers.tick(SEEK_FADE_MS);
      assert.equal(el.seeks, loaded + 1, "and never again");
      voices.dispose();

      // On time, the same pass plays from 0 untouched.
      const t2 = { now: T };
      const second = rig(t2, { gestures: new EventTarget() });
      second.voices.update(planVoices(ahead, SOUNDS, t2.now), () => SHORT_FADE_MS);
      const el2 = second.pool.find((e) => e.src === "/api/assets/a-tavern")!;
      const loaded2 = el2.seeks;
      t2.now = T + 1_000;
      mock.timers.tick(1_000);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      t2.now += 1_000;
      second.voices.check();
      mock.timers.tick(SEEK_FADE_MS);
      assert.equal(el2.seeks, loaded2, "an on time start is never sought");
      second.voices.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test("a pass that played to its end is released at once, so the next voice takes its element in the same update", () => {
    const t = { now: T };
    const once: Playing = { ...quiet, music: { run: "r1", repeat: "off", fade: 0, now: { soundId: "tavern", at: T - 10_000 } } };
    const { voices, pool } = rig(t, { gestures: new EventTarget() });
    voices.update(planVoices(once, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    const index = pool.indexOf(el);
    // It reached the file's end, so it has stopped by itself.
    el.paused = true;
    t.now = T + 50_000;
    const next: Playing = { ...quiet, music: { run: "r2", repeat: "off", fade: 0, now: { soundId: "road", at: T + 50_000 } } };
    voices.update([...planVoices(once, SOUNDS, t.now), ...planVoices(next, SOUNDS, t.now)], () => SHORT_FADE_MS);
    assert.equal(pool[index]!.src, "/api/assets/a-road", "the next track took the element at once");
    voices.dispose();
  });

  test("a seek the browser dropped before the file loaded is put right once, at the first check that finds the track playing", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const t = { now: T };
      const { voices, pool } = rig(t, { gestures: new EventTarget() });
      voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      for (let i = 0; i < 3; i++) await Promise.resolve();
      // The browser dropped the seek to 10 s in: the element plays from the file's start.
      el.currentTime = 0;
      el.seeks--;
      const seeks = el.seeks;
      t.now += 1_000;
      voices.check();
      mock.timers.tick(SEEK_FADE_MS);
      assert.equal(el.seeks, seeks + 1, "sought once, after its fade out");
      assert.equal(el.currentTime, 11, "to the timeline's place");
      t.now += 1_000;
      voices.check();
      mock.timers.tick(SEEK_FADE_MS);
      assert.equal(el.seeks, seeks + 1, "and never again");
      voices.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test("a check's seek that a placement overtook does nothing, so the element is not sought twice or dipped", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const t = { now: T };
      const { voices, pool } = rig(t, { gestures: new EventTarget() });
      voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      for (let i = 0; i < 3; i++) await Promise.resolve();
      // The browser dropped the seek, so the check seeks, fading out first.
      el.currentTime = 0;
      el.seeks--;
      t.now += 1_000;
      voices.check();
      const seeks = el.seeks;
      // Before the seek's fade is out the element stops, and the next check puts it back in place.
      el.paused = true;
      voices.check();
      assert.equal(el.seeks, seeks + 1);
      mock.timers.tick(200);
      assert.equal(el.seeks, seeks + 1, "the overtaken seek moved nothing");
      voices.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test("a pass the timeline ended while its element still plays, having fallen behind, fades out instead of stopping with a click", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const t = { now: T };
      const once: Playing = { ...quiet, music: { run: "r1", repeat: "off", fade: 0, now: { soundId: "tavern", at: T - 10_000 } } };
      const { voices, pool } = rig(t, { gestures: new EventTarget() });
      voices.update(planVoices(once, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      for (let i = 0; i < 3; i++) await Promise.resolve();
      t.now = T + 50_000;
      voices.update(planVoices(once, SOUNDS, t.now), () => SHORT_FADE_MS);
      assert.equal(el.paused, false, "it plays on through the fade");
      mock.timers.tick(SHORT_FADE_MS + 60);
      assert.equal(el.paused, true, "then stops");
      voices.dispose();
    } finally {
      mock.timers.reset();
    }
  });

  test("a track whose play keeps failing otherwise is placed again at each check but stays loading, its due time kept", async () => {
    const t = { now: T };
    const states: MusicState[] = [];
    const { voices, pool } = rig(t, { refuse: () => "AbortError", gestures: new EventTarget(), onMusic: (s) => states.push(s) });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    await wait(250);
    const plays = el.plays;
    for (let i = 0; i < 2; i++) {
      t.now += 1_000;
      voices.check();
      await wait(250);
    }
    assert.equal(el.plays, plays + 2, "each check tries it again");
    assert.deepEqual(states, ["playing", "loading"]);
    voices.dispose();
  });

  test("a track that sounded and then stopped short, which the line already calls loading, stays loading when it is placed again", async () => {
    const t = { now: T };
    const states: MusicState[] = [];
    const { voices, pool } = rig(t, { gestures: new EventTarget(), onMusic: (s) => states.push(s) });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    await wait(250);
    assert.deepEqual(states, ["playing"]);
    // The element stops and has to load again. The engine's tick reads the plan, which reports, before its check.
    el.paused = true;
    el.readyState = 1;
    t.now += 1_000;
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    voices.check();
    await wait(250);
    assert.deepEqual(states, ["playing", "loading"], "loading once, never back to playing for a moment");
    el.readyState = 4;
    el.onplaying?.();
    assert.deepEqual(states, ["playing", "loading", "playing"]);
    voices.dispose();
  });

  test("an element's error fails its voice only while it holds the voice's own file: a swapped-in silence's is put back at the check", () => {
    const t = { now: T };
    const states: MusicState[] = [];
    const { voices, pool } = rig(t, { gestures: new EventTarget(), onMusic: (s) => states.push(s) });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    // Silence that cannot load while the server is away, on the element the voice holds.
    el.src = "/sounds/silence.mp3";
    el.error = { code: 4 };
    el.onerror?.();
    assert.ok(!states.includes("failed"), "not the voice's own file");
    t.now += 1_000;
    voices.check();
    assert.equal(el.src, "/api/assets/a-tavern", "the check put its file back");
    el.error = { code: 4 };
    el.onerror?.();
    assert.equal(states.at(-1), "failed", "its own file's error fails it");
    voices.dispose();
  });

  test("a voice on an element whose last load of the same file failed, as one a restart cut off, loads it again", async () => {
    const t = { now: T };
    const states: MusicState[] = [];
    const { voices, pool } = rig(t, { gestures: new EventTarget(), onMusic: (s) => states.push(s) });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    el.error = { code: 2 };
    el.onerror?.();
    assert.equal(states.at(-1), "failed");
    // The voice goes, its element still holding the file that failed, and the same file plays again on it.
    voices.update([], () => 0);
    await wait(100);
    const loads = el.loads;
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    assert.equal(pool.find((e) => e.src === "/api/assets/a-tavern" && !e.paused), el, "the same element");
    assert.equal(el.loads, loads + 1, "it loads the file again, so its play can succeed");
    assert.equal(el.error, null);
    assert.equal(states.at(-1), "playing");
    voices.dispose();
  });

  test("Try again, or a reconnect, loads a failed file again, and one that cannot load fails again", () => {
    const t = { now: T };
    const states: MusicState[] = [];
    const { voices, pool } = rig(t, { gestures: new EventTarget(), onMusic: (s) => states.push(s) });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    el.error = { code: 4 };
    el.onerror?.();
    const loads = el.loads;
    voices.retry();
    assert.equal(el.loads, loads + 1);
    assert.equal(states.at(-1), "playing");
    // A missing file answers 404 again.
    el.error = { code: 4 };
    el.onerror?.();
    assert.equal(states.at(-1), "failed");
    t.now += 1_000;
    voices.check();
    assert.equal(el.loads, loads + 1, "the check leaves a failed voice alone");
    assert.equal(states.at(-1), "failed");
    voices.dispose();
  });

  test("a decode error in a file that played, as Chrome's after a seek into a steady tone, loads it again and plays on from its place, three times a minute before it fails", () => {
    const clock = { ms: 0 };
    const now = mock.method(performance, "now", () => clock.ms);
    try {
      const t = { now: T };
      const states: MusicState[] = [];
      const { voices, pool } = rig(t, { gestures: new EventTarget(), onMusic: (s) => states.push(s) });
      voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      const decodeError = () => {
        el.error = { code: 3 };
        el.paused = true;
        el.onerror?.();
      };
      for (let i = 1; i <= 3; i++) {
        t.now += 5_000;
        clock.ms += 5_000;
        const { loads, plays } = el;
        decodeError();
        assert.equal(el.loads, loads + 1, `error ${i}: the file loads again`);
        assert.equal(el.error, null);
        assert.equal(el.currentTime, (t.now - (T - 10_000)) / 1000, `error ${i}: placed where the track is due, not where it broke`);
        assert.equal(el.plays, plays + 1);
        assert.ok(!el.paused);
        assert.ok(!states.includes("failed"), `error ${i}: the line never says it failed`);
      }
      // A fourth within the minute: a file that truly will not decode fails as before, for Try again.
      clock.ms += 1_000;
      const loads = el.loads;
      decodeError();
      assert.equal(el.loads, loads, "no fourth load in a minute");
      assert.equal(states.at(-1), "failed");
      voices.retry();
      assert.equal(states.at(-1), "playing", "Try again still loads it");
      // A minute after the first, one more error is tried again on its own.
      clock.ms = 65_000;
      decodeError();
      assert.equal(el.loads, loads + 2);
      assert.equal(states.at(-1), "playing");
      voices.dispose();
    } finally {
      now.mock.restore();
    }
  });

  test("a decode error in a track loaded ahead loads it again paused at 0 for its start, and one in a voice waiting for a gesture is neither played nor sought", async () => {
    const t = { now: T };
    let allowed = true;
    const gestures = new EventTarget();
    const { voices, pool } = rig(t, { refuse: () => (allowed ? null : "NotAllowedError"), gestures });
    const ahead: Playing = { ...quiet, music: { run: "r1", repeat: "all", fade: 5, now: { soundId: "tavern", at: T + 2_000 } } };
    voices.update(planVoices(ahead, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    el.error = { code: 3 };
    const loads = el.loads;
    el.onerror?.();
    assert.equal(el.loads, loads + 1);
    assert.deepEqual([el.paused, el.currentTime, el.plays], [true, 0, 0], "paused at 0 until its start");
    await wait(2_050);
    assert.ok(!el.paused, "its start timer still plays it");
    voices.dispose();

    const refused = rig(t, { refuse: () => (allowed ? null : "NotAllowedError"), gestures });
    allowed = false;
    refused.voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    await wait(10);
    const waiting = refused.pool.find((e) => e.src === "/api/assets/a-tavern")!;
    const tried = { plays: waiting.plays, seeks: waiting.seeks, loads: waiting.loads };
    waiting.error = { code: 3 };
    waiting.onerror?.();
    assert.deepEqual({ plays: waiting.plays, seeks: waiting.seeks, loads: waiting.loads }, { ...tried, loads: tried.loads + 1 }, "loaded again, and still waiting for the gesture");
    allowed = true;
    gestures.dispatchEvent(new Event("click"));
    assert.equal(waiting.plays, tried.plays + 1, "the gesture plays it");
    refused.voices.dispose();
  });

  test("a decode error in a voice fading out loads nothing", () => {
    const t = { now: T };
    const { voices, pool } = rig(t, { gestures: new EventTarget() });
    voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
    const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
    voices.stopAll(STOP_FADE_MS);
    const loads = el.loads;
    el.error = { code: 3 };
    el.onerror?.();
    assert.equal(el.loads, loads);
    voices.dispose();
  });

  test("a voice released late, as a throttled tab's timer runs it, leaves the handlers of a newer voice that took its element", async () => {
    const clock = { ms: 0 };
    const now = mock.method(performance, "now", () => clock.ms);
    try {
      const t = { now: T };
      const states: MusicState[] = [];
      const { voices, pool } = rig(t, { gestures: new EventTarget(), onMusic: (s) => states.push(s) });
      voices.update(planVoices(playingTavern, SOUNDS, t.now), () => SHORT_FADE_MS);
      const el = pool.find((e) => e.src === "/api/assets/a-tavern")!;
      voices.update([], () => SHORT_FADE_MS);
      // Its release is due in 350 ms, but a socket's message comes first, after the clock passed that.
      clock.ms += 1_000;
      const road: Playing = { ...quiet, music: { run: "r2", repeat: "all", fade: 5, now: { soundId: "road", at: T - 1_000 } } };
      voices.update(planVoices(road, SOUNDS, t.now), () => SHORT_FADE_MS);
      assert.equal(el.src, "/api/assets/a-road", "the newer voice took the element");
      await wait(SHORT_FADE_MS + 100);
      assert.ok(el.onerror && el.onplaying, "its handlers are still there");
      assert.ok(!el.paused);
      el.error = { code: 4 };
      el.onerror();
      assert.equal(states.at(-1), "failed", "so its file's error still reaches the line");
      voices.dispose();
    } finally {
      now.mock.restore();
    }
  });
});
