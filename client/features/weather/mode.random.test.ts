import assert from "node:assert/strict";
import { test } from "node:test";
import { int, rng } from "#shared/testutil.ts";
import { TOP_DOWN } from "../../lib/view.ts";
import { drawWeather } from "./draw.ts";
import { lookOf } from "./looks.ts";
import { SLOW_DRAW_MS, TICK_MS, WARMUP_MS, WINDOW_MS, WeatherMode, type ModeInput, type StepLevel } from "./mode.ts";
import { createField, stepField } from "./sim.ts";

/*
 * The mode as one state machine (the weather design note, 6.3 and 12):
 * random sequences of frames, draws, camera changes, setting and power
 * flips, hides, panels, the preview, tools, scene loads, remounts and
 * weather changes, driving a real field the way the controller does. The
 * invariants are checked after every event.
 */

const SHOWN: ModeInput = {
  setting: "moving",
  reducedMotion: false,
  lowPower: false,
  weather: true,
  particles: true,
  pageVisible: true,
  mapShown: true,
  layer: true,
  covered: false,
  preview: false,
  loading: false,
  roomOpen: true,
  setupTool: false,
};

const FLAGS = ["reducedMotion", "lowPower", "weather", "particles", "pageVisible", "mapShown", "layer", "covered", "preview", "loading", "roomOpen", "setupTool"] as const;
const LEVELS: readonly StepLevel[] = ["full", "half", "still"];

/** The rule the mode must follow, written out again from the design's words. */
function shouldLoop(i: ModeInput, level: StepLevel): boolean {
  const moving = i.weather && i.setting === "moving" && !i.reducedMotion && !i.lowPower && level !== "still";
  const seen = !i.setupTool && i.pageVisible && i.mapShown && i.layer && !i.covered && !i.preview && !i.loading && i.roomOpen;
  return moving && seen;
}

const noop = () => {};
/** A canvas that ignores everything: the draw here is only there to show it leaves the field alone. */
const recorder = { save: noop, restore: noop, setTransform: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, rect: noop, clip: noop, fill: noop, stroke: noop, fillRect: noop, drawImage: noop } as unknown as CanvasRenderingContext2D;

function fieldKey(f: ReturnType<typeof createField>): string {
  return `${f.t}:${f.x[0]}:${f.y[0]}:${f.x[f.active - 1]}:${f.y[f.active - 1]}`;
}

test("2,000 random sequences keep the mode's invariants", () => {
  const seen = new Set<number>();
  let stepDowns = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    // Half the runs are a fast device, so a step-down there is always wrong.
    const fast = seed % 2 === 0;
    let now = int(r, 0, 1000);
    let input: ModeInput = { ...SHOWN };
    const mode = new WeatherMode(input, now);
    const field = createField(lookOf({ kind: "rain", heavy: true, wind: "strong" })!, { width: 160, height: 120, view: TOP_DOWN, seed });
    let lastTick: number | null = null;
    let quietSince = now;
    let looping = mode.looping;
    let level = mode.level;
    const cadence = fast ? [1000 / 60, 1000 / 120] : [1000 / 60, 1000 / 120, 33.3, 45, 70];
    const restart = (at: number) => {
      quietSince = at;
    };
    /** Checks the invariants after any call into the mode, at the time it was made. */
    const observe = (step: number) => {
      if (mode.looping && !looping) {
        restart(now);
        lastTick = null;
      }
      if (!mode.looping) lastTick = null;
      looping = mode.looping;
      assert.equal(mode.looping, shouldLoop(mode.input, mode.level), `the loop runs exactly when moving and seen, seed ${seed} step ${step}`);
      assert.ok(LEVELS.indexOf(mode.level) >= LEVELS.indexOf(level), `a step-down only goes down, seed ${seed}`);
      if (mode.level !== level) {
        stepDowns++;
        assert.ok(!fast, `a fast device never steps down, seed ${seed}`);
        assert.ok(now - quietSince >= WARMUP_MS + WINDOW_MS - 1, `no step-down from a window holding a start, a resume, a load or a remount, seed ${seed}: ${now - quietSince} ms`);
        if (mode.level === "half") assert.equal(mode.input.particles, true, "only marks halve");
        level = mode.level;
        restart(now);
      }
    };
    for (let step = 0; step < 300; step++) {
      const event = int(r, 0, 9);
      seen.add(event);
      if (event <= 3 || event === 9) {
        // A run of frames, the most common thing a session does. A browser keeps calling frames while time passes, so time passes here only as frames or a stall.
        const frames = event === 9 ? int(r, 0, 6) : int(r, 1, 40);
        const every = cadence[int(r, 0, cadence.length - 1)]!;
        for (let k = 0; k < frames; k++) {
          now += every;
          const was = mode.looping;
          const before = fieldKey(field);
          const dt = mode.frame(now);
          observe(step);
          if (dt === null) {
            assert.equal(fieldKey(field), before);
            if (was && mode.looping) assert.ok(lastTick !== null && now - lastTick < TICK_MS, `liveness: a seen moving frame ticks unless the gate holds it, seed ${seed}`);
            continue;
          }
          assert.ok(was, `no tick without a loop, seed ${seed}`);
          if (lastTick !== null) assert.ok(now - lastTick >= TICK_MS, `no two ticks within 30 ms, seed ${seed}`);
          assert.ok(dt >= 0 && dt <= 50);
          lastTick = now;
          stepField(field, dt);
          const cost = fast ? r() * 3 : r() < 0.5 ? r() * 3 : SLOW_DRAW_MS + r() * 6;
          drawWeather(recorder, field, { camera: { x: 0, y: 0, scale: 50 }, clip: null }, null);
          assert.equal(mode.drew(cost), "tick");
        }
      } else if (event === 4) {
        // A pan or zoom: the stage's own batchDraw runs the sceneFunc with no tick behind it.
        const before = fieldKey(field);
        const cameras = mode.cameraDraws;
        drawWeather(recorder, field, { camera: { x: r() * 500, y: r() * 500, scale: 10 + r() * 90 }, clip: null }, null);
        assert.equal(mode.drew(r() * 3), "camera");
        assert.equal(mode.cameraDraws, cameras + 1);
        assert.equal(fieldKey(field), before, "a camera draw never steps the field");
      } else if (event === 5 || event === 6) {
        const flag = FLAGS[int(r, 0, FLAGS.length - 1)]!;
        const patch: Partial<ModeInput> = event === 5 ? { [flag]: !input[flag] } : { setting: (["moving", "still", "off"] as const)[int(r, 0, 2)]! };
        // Mostly put things back, so long shown stretches happen too.
        input = r() < 0.4 ? { ...SHOWN, setting: input.setting } : { ...input, ...patch };
        now += int(r, 0, 20);
        mode.update(input, now);
        if (!mode.looping) assert.equal(mode.frame(now + 1), null, `a hide stops ticks within one frame, seed ${seed}`);
      } else if (event === 7) {
        now += int(r, 0, 20);
        const which = int(r, 0, 2);
        if (which === 0) mode.sceneLoaded(now);
        else if (which === 1) mode.remounted(now);
        else mode.lookChanged(now);
        restart(now);
      } else if (event === 8) {
        // A stall: a tab coming back, a map decoding.
        now += int(r, 100, 4000);
      }
      observe(step);
      assert.equal(mode.half, mode.level === "half");
      if (mode.input.setting === "off" || !mode.input.weather) assert.equal(mode.effective, "off");
    }
  }
  assert.equal(seen.size, 10);
  assert.ok(stepDowns > 50, `slow devices do step down (${stepDowns})`);
});
