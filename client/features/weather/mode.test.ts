import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_FRAME_COSTS, SLOW_DRAW_MS, SLOW_FRAME_MS, TICK_CLAMP_MS, WARMUP_MS, WINDOW_MS, WeatherMode, type ModeInput } from "./mode.ts";

const SHOWN: ModeInput = {
  setting: "moving",
  reducedMotion: false,
  lowPower: false,
  weather: true,
  particles: true,
  pageVisible: true,
  layer: true,
  covered: false,
  preview: false,
  loading: false,
  setupTool: false,
};

/** Runs frames every `every` ms until `until`, drawing each tick at `cost` ms. Returns the tick times. */
function run(mode: WeatherMode, from: number, until: number, every: number, cost: number): number[] {
  const ticks: number[] = [];
  for (let now = from; now < until; now += every) {
    if (mode.frame(now) !== null) {
      ticks.push(now);
      assert.equal(mode.drew(cost), "tick");
    }
  }
  return ticks;
}

test("moving and seen, the first frame ticks at once and moves nothing, then 30 a second", () => {
  const mode = new WeatherMode(SHOWN, 0);
  assert.equal(mode.looping, true);
  assert.equal(mode.frame(5), 0);
  assert.equal(mode.frame(5 + 16.7), null);
  assert.equal(mode.frame(5 + 33.4), 33.4);
  assert.equal(mode.frame(5 + 33.4 + 400), TICK_CLAMP_MS, "a long gap steps at most 50 ms");
});

test("a 60 Hz screen ticks every second frame and a 120 Hz one every fourth", () => {
  const sixty = run(new WeatherMode(SHOWN, 0), 0, 1000, 1000 / 60, 1);
  assert.ok(sixty.length >= 29 && sixty.length <= 31, `${sixty.length} at 60 Hz`);
  const onetwenty = run(new WeatherMode(SHOWN, 0), 0, 1000, 1000 / 120, 1);
  assert.ok(onetwenty.length >= 29 && onetwenty.length <= 31, `${onetwenty.length} at 120 Hz`);
  for (const ticks of [sixty, onetwenty]) for (let k = 1; k < ticks.length; k++) assert.ok(ticks[k]! - ticks[k - 1]! >= 30);
});

test("a draw no tick started is a camera draw, counted apart", () => {
  const mode = new WeatherMode(SHOWN, 0);
  assert.equal(mode.drew(1), "camera", "the mount's first draw");
  mode.frame(0);
  assert.equal(mode.drew(1), "tick");
  assert.equal(mode.drew(1), "camera", "a pan after the tick's draw");
  mode.frame(40);
  mode.frame(50);
  assert.equal(mode.drew(1), "camera", "a frame that did not tick clears the tick's claim");
  assert.deepEqual([mode.ticks, mode.cameraDraws], [2, 3]);
});

test("Off, Still, reduced motion and Low power", () => {
  const off = new WeatherMode({ ...SHOWN, setting: "off" }, 0);
  assert.deepEqual([off.mounted, off.effective, off.looping, off.stillReason], [false, "off", false, null]);
  const still = new WeatherMode({ ...SHOWN, setting: "still" }, 0);
  assert.deepEqual([still.mounted, still.effective, still.looping, still.stillReason], [true, "still", false, null]);
  assert.equal(still.frame(0), null);
  const reduced = new WeatherMode({ ...SHOWN, reducedMotion: true }, 0);
  assert.deepEqual([reduced.effective, reduced.stillReason], ["still", "reducedMotion"]);
  const low = new WeatherMode({ ...SHOWN, lowPower: true }, 0);
  assert.deepEqual([low.effective, low.stillReason], ["still", "lowPower"]);
  const clear = new WeatherMode({ ...SHOWN, weather: false }, 0);
  assert.deepEqual([clear.mounted, clear.effective], [false, "off"]);
});

test("a setup tool and a hidden page mount no layer, and every unseen reason stops the loop", () => {
  assert.equal(new WeatherMode({ ...SHOWN, setupTool: true }, 0).mounted, false);
  assert.equal(new WeatherMode({ ...SHOWN, pageVisible: false }, 0).mounted, false);
  for (const patch of [{ layer: false }, { covered: true }, { preview: true }, { loading: true }, { setupTool: true }, { pageVisible: false }] as Partial<ModeInput>[]) {
    const mode = new WeatherMode(SHOWN, 0);
    mode.frame(0);
    mode.update(patch, 10);
    assert.equal(mode.looping, false, JSON.stringify(patch));
    assert.equal(mode.frame(50), null, `${JSON.stringify(patch)} stops ticks at the next frame`);
    mode.update(SHOWN, 60);
    assert.equal(mode.frame(61), 0, "starts again within one frame, fresh");
  }
});

test("a slow draw steps down to half after the warm-up and a window, then to still, and never back", () => {
  const mode = new WeatherMode(SHOWN, 0);
  const v = mode.version;
  run(mode, 0, WARMUP_MS + WINDOW_MS - 50, 1000 / 60, SLOW_DRAW_MS + 2);
  assert.equal(mode.level, "full", "nothing before the warm-up and a whole window");
  run(mode, WARMUP_MS + WINDOW_MS - 50, WARMUP_MS + WINDOW_MS + 100, 1000 / 60, SLOW_DRAW_MS + 2);
  assert.equal(mode.level, "half");
  assert.equal(mode.half, true);
  assert.ok(mode.version > v);
  run(mode, WARMUP_MS + WINDOW_MS + 100, 2 * (WARMUP_MS + WINDOW_MS) + 200, 1000 / 60, SLOW_DRAW_MS + 2);
  assert.deepEqual([mode.level, mode.effective, mode.looping, mode.stillReason], ["still", "still", false, "slow"]);
  mode.update({ setting: "still" }, 20_000);
  mode.update({ setting: "moving" }, 20_100);
  assert.deepEqual([mode.level, mode.effective], ["still", "still"], "a step lasts until the page reloads");
});

test("fog steps straight to still, and a slow clock steps down as a slow draw does", () => {
  const fog = new WeatherMode({ ...SHOWN, particles: false }, 0);
  run(fog, 0, 6000, 1000 / 60, SLOW_DRAW_MS + 1);
  assert.equal(fog.level, "still");
  const choppy = new WeatherMode(SHOWN, 0);
  run(choppy, 0, 6000, 60, 1);
  assert.equal(choppy.level, "half", "ticks 60 ms apart are under 20 a second");
});

test("a fast device never steps down, and one stall never counts", () => {
  const mode = new WeatherMode(SHOWN, 0);
  run(mode, 0, 20_000, 1000 / 60, 1);
  run(mode, 21_500, 40_000, 1000 / 60, 1);
  assert.equal(mode.level, "full");
  // A scene's map decoding: one stall right after the load, and slow draws only inside the warm-up.
  mode.sceneLoaded(40_000);
  run(mode, 40_000, 41_900, 1000 / 60, 30);
  run(mode, 41_900, 50_000, 1000 / 60, 1);
  assert.equal(mode.level, "full");
});

test("a remount drops the window it fell in", () => {
  const mode = new WeatherMode(SHOWN, 0);
  run(mode, 0, 4800, 1000 / 60, 1);
  run(mode, 4800, 4990, 1000 / 60, 50);
  mode.remounted(4990);
  run(mode, 4990, 6900, 1000 / 60, 1);
  assert.equal(mode.level, "full", "the slow draws before the remount are dropped with their window");
  const kept = new WeatherMode(SHOWN, 0);
  run(kept, 0, 4800, 1000 / 60, 1);
  run(kept, 4800, 4990, 1000 / 60, 50);
  run(kept, 4990, 6900, 1000 / 60, 1);
  assert.equal(kept.level, "half", "the same draws with no remount do step down");
});

test("version moves only when what the controller reads changes", () => {
  const mode = new WeatherMode(SHOWN, 0);
  const v = mode.version;
  mode.update({ particles: true }, 1);
  mode.frame(2);
  assert.equal(mode.version, v);
  mode.update({ covered: true }, 3);
  assert.equal(mode.version, v + 1);
  mode.update({ setting: "still" }, 4);
  assert.equal(mode.version, v + 2);
});

test("a held frame does not tick and changes nothing, so the next frame ticks by the whole gap, clamped", () => {
  const mode = new WeatherMode(SHOWN, 0);
  assert.equal(mode.frame(0), 0);
  assert.equal(mode.frame(33.3, true), null, "held");
  assert.equal(mode.drew(1), "camera", "a held frame's draw is no tick's");
  assert.equal(mode.frame(66.7, true), null);
  assert.equal(mode.frame(100), TICK_CLAMP_MS);
  assert.equal(mode.ticks, 2);
  assert.equal(mode.frame(116.7, true), null, "a frame the gate holds anyway");
  assert.ok(Math.abs(mode.frame(133.4)! - 33.4) < 1e-9);
});

/** Runs frames every `every` ms until `until`, each tick drawing at 0.1 ms and adding `cost` ms to its frame. */
function runCosts(mode: WeatherMode, from: number, until: number, every: number, cost: (tickAt: number) => number): void {
  for (let now = from; now < until; now += every) {
    if (mode.frame(now) === null) continue;
    mode.drew(0.1);
    mode.added(cost(now), now);
  }
}

test("a window whose ticks add more than 2 ms to their frames by the median steps down, and one whose few slow ones do not", () => {
  const slow = new WeatherMode(SHOWN, 0);
  runCosts(slow, 0, WARMUP_MS + WINDOW_MS + 100, 1000 / 60, () => SLOW_FRAME_MS + 0.5);
  assert.equal(slow.level, "half");
  const spiky = new WeatherMode(SHOWN, 0);
  // Four ticks in ten add 9 ms, the rest 0.3: its median is the weather's.
  runCosts(spiky, 0, 4 * (WARMUP_MS + WINDOW_MS), 1000 / 60, (at) => (Math.round(at / (1000 / 60)) % 10 < 4 ? 9 : 0.3));
  assert.equal(spiky.level, "full");
});

test("a window with too few frame costs says nothing by them", () => {
  // One tick in 25 reports, all slow: about 3.6 a window, under the minimum.
  assert.ok((WINDOW_MS / 1000) * (30 / 25) < MIN_FRAME_COSTS);
  const sparse = new WeatherMode(SHOWN, 0);
  let n = 0;
  for (let now = 0; now < 3 * (WARMUP_MS + WINDOW_MS); now += 1000 / 60) {
    if (sparse.frame(now) === null) continue;
    sparse.drew(0.1);
    if (++n % 25 === 0) sparse.added(9, now);
  }
  assert.equal(sparse.level, "full");
});

test("a frame cost counts only in the window its tick was in", () => {
  const mode = new WeatherMode(SHOWN, 0);
  const late: number[] = [];
  let n = 0;
  for (let now = 0; now < WARMUP_MS + WINDOW_MS + 100; now += 1000 / 60) {
    if (mode.frame(now) === null) continue;
    mode.drew(0.1);
    // Ticks in the warm-up add 9 ms, and their measures come back only once the window is open, beside the window's own few.
    if (now < WARMUP_MS) late.push(now);
    else {
      for (const at of late.splice(0)) mode.added(9, at);
      if (++n % 9 === 0) mode.added(0.3, now);
    }
  }
  assert.equal(mode.level, "full", "the warm-up's ticks say nothing, whenever their measures land");
});
