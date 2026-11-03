import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lookOf } from "./looks.ts";
import { SLOW_DRAW_MS, TICK_MS } from "./mode.ts";
import { TICK_BUDGET_MS, tickCostForMode, WeatherRoom, weatherStillReason, type Frames, type WeatherTarget } from "./store.ts";

/**
 * The room's weather clock (docs/design/design-v1-weather.md 5.2): one loop
 * a Room page, running only while the mode says so, ticking only the layer
 * that shows, and stopping within a frame of a hide. The frames and the
 * clock are the test's, so every frame is one the test sends.
 */

class HandFrames implements Frames {
  #next = 1;
  readonly pending = new Map<number, (time: number) => void>();
  request(run: (time: number) => void): number {
    const id = this.#next++;
    this.pending.set(id, run);
    return id;
  }
  cancel(id: number): void {
    this.pending.delete(id);
  }
  /** Runs the frames asked for, at `time`. */
  run(time: number): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const run of due) run(time);
  }
}

function setup() {
  const frames = new HandFrames();
  let now = 0;
  const room = new WeatherRoom(frames, () => now);
  const ticks: { who: string; ms: number }[] = [];
  const target = (who: string): WeatherTarget => ({ tick: (ms) => ticks.push({ who, ms }) });
  /** Frames every 16.7 ms, as a 60 Hz screen draws them, until `until`. */
  const runTo = (until: number) => {
    while (now + 16.7 <= until) {
      now += 16.7;
      frames.run(now);
    }
  };
  return { frames, room, ticks, target, runTo, at: (t: number) => (now = t), now: () => now };
}

const RAIN = lookOf({ kind: "rain", heavy: true, wind: "strong" });

describe("the weather clock", () => {
  test("no loop until the scene has weather, this device moves it and a layer shows", () => {
    const { frames, room, target } = setup();
    assert.equal(frames.pending.size, 0);
    room.setLook(RAIN);
    assert.equal(room.state.getState().mounted, true, "a layer mounts for the weather");
    assert.equal(frames.pending.size, 0, "no loop until a layer registers");
    const off = room.register(target("top"));
    assert.equal(frames.pending.size, 1, "the loop runs");
    off();
    assert.equal(frames.pending.size, 0, "and stops with the layer");
  });

  test("ticks come about 30 a second on a 60 Hz screen, never two within 30 ms, and only the newest layer ticks", () => {
    const { room, ticks, target, runTo, now } = setup();
    room.setLook(RAIN);
    room.register(target("hidden"));
    room.register(target("shown"));
    const from = now();
    // Past the warm-up, which holds no ticks back, only the step-down's judging.
    runTo(from + 3000);
    assert.ok(ticks.length >= 85 && ticks.length <= 101, `${ticks.length} ticks in 3 s`);
    assert.ok(ticks.every((t) => t.who === "shown"), "only the layer that shows ticks");
    // The first tick after a start moves nothing: the field shows where it stood.
    assert.equal(ticks[0]!.ms, 0);
    assert.ok(ticks.slice(1).every((t) => t.ms >= TICK_MS && t.ms <= 50), "each step is its gap, clamped");
  });

  test("a hidden page or Still stops the loop at once, and showing again starts it", () => {
    const { frames, room, target, runTo, now, ticks } = setup();
    room.setLook(RAIN);
    room.register(target("top"));
    runTo(now() + 500);
    room.input({ pageVisible: false });
    assert.equal(frames.pending.size, 0, "a hide stops it within the frame");
    assert.equal(room.state.getState().mounted, false, "a hidden page mounts no layer");
    room.input({ pageVisible: true });
    room.input({ setting: "still" });
    assert.equal(frames.pending.size, 0, "Still has no loop");
    assert.equal(room.state.getState().effective, "still");
    const count = ticks.length;
    runTo(now() + 500);
    assert.equal(ticks.length, count, "no ticks while still");
    room.input({ setting: "moving" });
    assert.equal(frames.pending.size, 1);
    runTo(now() + 100);
    assert.ok(ticks.length > count, "a tick within 100 ms of moving again");
  });

  test("reduced motion and Low power hold it still, and a setup tool, a preview over the room or a full sheet stop it", () => {
    const { frames, room, target } = setup();
    room.setLook(RAIN);
    room.register(target("top"));
    for (const patch of [{ reducedMotion: true }, { lowPower: true }] as const) {
      room.input(patch);
      assert.equal(room.state.getState().effective, "still", JSON.stringify(patch));
      assert.equal(frames.pending.size, 0);
      room.input({ reducedMotion: false, lowPower: false });
    }
    room.input({ setupTool: true });
    assert.equal(room.state.getState().mounted, false, "a setup tool hides it");
    room.input({ setupTool: false });
    for (const patch of [{ preview: true }, { covered: true }, { loading: true }] as const) {
      room.input(patch);
      assert.equal(frames.pending.size, 0, `no ticks with ${JSON.stringify(patch)}`);
      room.input({ preview: false, covered: false, loading: false });
      assert.equal(frames.pending.size, 1);
    }
  });

  test("a new look drops the field, the same look keeps it, and a clear scene lets the textures go", () => {
    const { room } = setup();
    let released = 0;
    room.setLook(RAIN);
    room.field = { look: RAIN } as never;
    room.textures = { noise: () => null, leaves: () => null, release: () => released++ };
    room.setLook(lookOf({ kind: "rain", heavy: true, wind: "strong" }));
    assert.ok(room.field, "the same weather keeps its particles");
    room.setLook(lookOf({ kind: "snow" }));
    assert.equal(room.field, null, "a new weather makes its own");
    room.setLook(null);
    assert.equal(released, 1, "a clear scene releases the textures");
    assert.equal(room.state.getState().mounted, false);
    assert.equal(room.state.getState().key, null);
  });

  test("Off releases the textures and mounts nothing", () => {
    const { room, target } = setup();
    let released = 0;
    room.setLook(RAIN);
    room.register(target("top"));
    room.textures = { noise: () => null, leaves: () => null, release: () => released++ };
    room.input({ setting: "off" });
    assert.equal(released, 1);
    assert.equal(room.state.getState().mounted, false);
  });
});

describe("This device's line on what keeps the weather still", () => {
  test("reduced motion first, then Low power, then a device that could not keep up", () => {
    assert.equal(weatherStillReason({ reducedMotion: true, lowPower: true, level: "still" }), "Reduced motion is on for this device, so weather stays still.");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: true, level: "still" }), "Low power keeps weather still.");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: false, level: "still" }), "Weather was slowing the map, so it stays still until you reload.");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: false, level: "half" }), null, "half the particles still move");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: false, level: "full" }), null);
  });
});

describe("what a tick adds to its frame, which the sceneFunc's own timing cannot see", () => {
  /**
   * A 60 Hz screen whose board spends `board` ms of every frame, and whose
   * weather tick adds `tick` ms: the draw and, on a canvas without a GPU,
   * its paint. The layer's tick reports as WeatherLayer.tsx does.
   */
  function run(input: { board: number; tick: number; seconds: number; strayEvery?: number }) {
    let n = 0;
    const frames = new HandFrames();
    let now = 0;
    const room = new WeatherRoom(
      frames,
      () => now,
      (after) => {
        // Now and then a long task of something else's, a chunk's parse, runs before the measure's message.
        now += input.board + (input.strayEvery && ++n % input.strayEvery === 0 ? 60 : 0);
        after();
      },
    );
    room.setLook(RAIN);
    let most = 0;
    room.register({
      tick() {
        now += input.tick;
        most = Math.max(most, room.frameCost);
        room.mode.drew(tickCostForMode(0.1, room.frameCost));
      },
    });
    const end = input.seconds * 1000;
    let at = 0;
    while (at < end) {
      at += 16.7;
      now = Math.max(now, at);
      frames.run(now);
    }
    return { room, most };
  }

  test("a canvas with no GPU, whose ticks add 3 ms of paint (90 ms a second, over 6.1's 60), steps down to half and then holds still", () => {
    const { room } = run({ board: 1, tick: 3, seconds: 12 });
    assert.ok(room.frameCost > 2.5 && room.frameCost < 3.5, `${room.frameCost}`);
    assert.equal(room.state.getState().level, "still");
    assert.equal(room.state.getState().effective, "still");
  });

  test("a GPU canvas whose ticks add half a millisecond keeps moving, however busy the board is in every frame and however often something else's long task runs", () => {
    for (const board of [0.5, 9]) {
      const { room, most } = run({ board, tick: 0.5, seconds: 12 });
      assert.ok(most < 0.6, `board ${board}: ${most}`);
      assert.equal(room.state.getState().level, "full", `board ${board}`);
    }
    // A long task every fifth frame slows the frames themselves, which the mode judges by their gaps. The cost a tick adds stays its own.
    const { most } = run({ board: 0.5, tick: 0.5, seconds: 12, strayEvery: 5 });
    assert.ok(most < 0.6, `a stray task every fifth frame: ${most}`);
  });

  test("the budget's 2 ms a tick meets the mode's line, and the sceneFunc's own time counts when it is the larger", () => {
    assert.equal(tickCostForMode(0.1, TICK_BUDGET_MS), SLOW_DRAW_MS);
    assert.equal(tickCostForMode(5, 0), 5);
    assert.ok(tickCostForMode(0.1, 1) < SLOW_DRAW_MS);
  });
});
