import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TOP_DOWN } from "../../lib/view.ts";
import { lookOf } from "./looks.ts";
import { rng } from "#shared/testutil.ts";
import { TICK_MS } from "./mode.ts";
import { createField, motionOf } from "./sim.ts";
import { WeatherRoom, weatherStillReason, type BoardWork, type Frames, type WeatherTarget } from "./store.ts";

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

  test("a scene edit that leaves the weather as it was keeps its look and particles and says nothing", () => {
    const { room } = setup();
    room.setLook(RAIN);
    const field = createField(RAIN!, { width: 390, height: 844, view: TOP_DOWN });
    room.field = field;
    let published = 0;
    room.state.subscribe(() => published++);
    // Every scene edit elsewhere comes as a new weather object, so as a new look of the same weather.
    room.setLook(lookOf({ kind: "rain", heavy: true, wind: "strong" }));
    room.setLook(lookOf({ kind: "rain", heavy: true, wind: "strong", toward: 135 }));
    assert.equal(room.look, RAIN, "the look it had");
    assert.equal(room.field, field, "and the particles it had");
    assert.equal(published, 0);
  });

  test("the same weather blowing another way keeps its particles, turns them, and tells the layer to draw, moving or still", () => {
    for (const setting of ["moving", "still"] as const) {
      const { room, target } = setup();
      room.input({ setting });
      room.setLook(RAIN);
      room.register(target("top"));
      const field = createField(RAIN!, { width: 390, height: 844, view: TOP_DOWN });
      room.field = field;
      const x = [...field.x];
      const shown: (number | null)[] = [];
      room.state.subscribe((s) => shown.push(s.toward));
      const west = lookOf({ kind: "rain", heavy: true, wind: "strong", toward: 270 })!;
      room.setLook(west);
      assert.equal(room.field, field, setting);
      assert.deepEqual([...field.x], x);
      assert.deepEqual({ x: field.vx, y: field.vy }, motionOf(west, TOP_DOWN));
      assert.deepEqual(shown, [270], `${setting}: one change, the new direction`);
      assert.equal(room.state.getState().key, "rain heavy strong");
    }
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
    assert.equal(weatherStillReason({ reducedMotion: true, lowPower: true, level: "still" }), "Reduced motion keeps weather still.");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: true, level: "still" }), "Low power keeps weather still.");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: false, level: "still" }), "Weather was slowing the map, so it stays still until you reload.");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: false, level: "half" }), null, "half the particles still move");
    assert.equal(weatherStillReason({ reducedMotion: false, lowPower: false, level: "full" }), null);
  });
});

describe("what a tick adds to its frame, which the sceneFunc's own timing cannot see", () => {
  type Board = (frame: number, at: number) => number;
  /**
   * A screen at `hz` whose board spends `board` ms of each frame, and whose
   * weather tick adds `tick` ms: the draw and, on a canvas without a GPU,
   * its paint. Frames come on the screen's beat, a late one at the next
   * beat. A frame's measure for which `late` is true comes back only after
   * the next frame has started.
   */
  function run(input: {
    hz: number;
    seconds: number;
    tick: number;
    board: Board;
    strayEvery?: number;
    late?: (frame: number) => boolean;
    between?: (frame: number, ticked: boolean) => number;
    /** The stage's camera x as each frame starts. */
    camera?: (frame: number) => number;
    /** A pointer, touch or wheel move comes before the frame, over the board or, with `elsewhere`, over a panel beside it. */
    gesture?: (frame: number) => boolean;
    elsewhere?: boolean;
    /** The animated map draws in the frame's rendering. */
    map?: (frame: number) => boolean;
  }) {
    const period = 1000 / input.hz;
    const frames = new HandFrames();
    let now = 0;
    let frame = 0;
    let n = 0;
    let ticked = false;
    let mapDraws = 0;
    let gestured = null as ((target: EventTarget | null) => void) | null;
    const board: BoardWork = {
      listen(on) {
        gestured = on;
        return () => (gestured = null);
      },
      mapDraws: () => mapDraws,
    };
    const out: (() => void)[] = [];
    const room = new WeatherRoom(
      frames,
      () => now,
      (after) => {
        // The board's own work runs after the loop's callback and before the paint, and now and then something else's long task runs before the measure's message.
        now += input.board(frame, now) + (input.strayEvery && ++n % input.strayEvery === 0 ? 60 : 0);
        if (input.map?.(frame)) mapDraws++;
        if (input.late?.(frame)) out.push(after);
        else after();
        // A long task of something else's after the measure, which drops the frames it runs into.
        now += input.between?.(frame, ticked) ?? 0;
      },
      board,
    );
    room.setLook(RAIN);
    const samples: number[] = [];
    const added = room.mode.added.bind(room.mode);
    room.mode.added = (ms, at) => {
      samples.push(ms);
      added(ms, at);
    };
    let ticks = 0;
    let most = 0;
    let moved = 0;
    room.register({
      tick(ms) {
        ticks++;
        moved += ms;
        ticked = true;
        now += input.tick;
        most = Math.max(most, room.frameCost);
        room.mode.drew(0.1);
      },
      camera: () => ({ x: input.camera?.(frame) ?? 0, y: 0, scale: 40 }),
      onBoard: (target) => target === ON_BOARD,
    });
    const end = input.seconds * 1000;
    let at = 0;
    /** Frames in the run's second half with no tick: at 33 frames a second or fewer, the held ones. */
    let quiet = 0;
    /** Frames that held a tick, from mode.ts's count. */
    const held: number[] = [];
    while (at < end) {
      at += period;
      if (now > at) at = Math.ceil(now / period) * period;
      now = at;
      frame++;
      ticked = false;
      const due = out.splice(0);
      if (input.gesture?.(frame)) gestured?.(input.elsewhere ? PANEL : ON_BOARD);
      frames.run(at);
      for (const after of due) after();
      if (at > end / 2 && !ticked) quiet++;
      if (room.mode.holds > held.length) held.push(frame);
    }
    return { level: room.state.getState().level, frameCost: room.frameCost, most, ticks, samples, moved, quietPerSecond: quiet / (input.seconds / 2), holdsPerSecond: room.mode.holds / input.seconds, held };
  }
  /** What a move's event targets: the stage's canvas, or a panel beside the board. */
  const ON_BOARD = { on: "board" } as unknown as EventTarget;
  const PANEL = { on: "panel" } as unknown as EventTarget;

  const steady: Board = () => 1;
  /** A 1.5 s pan every 8 s, the board spending 6 ms more in each of its frames. */
  const pans: Board = (_frame, at) => 1 + (at % 8000 < 1500 ? 6 : 0);
  const RATES = [30, 60, 120] as const;

  test("a healthy GPU canvas never steps down for pans at 30, 60 or 120 Hz, which every frame beside a tick pays too", () => {
    for (const hz of RATES) {
      const r = run({ hz, seconds: 60, tick: 0.3, board: pans });
      assert.equal(r.level, "full", `${hz} Hz`);
      assert.ok(r.most < 1, `${hz} Hz: frame cost up to ${r.most}`);
    }
  });

  test("a load step at 60 Hz, on a tick's frame or the frame after it, is never the weather's, and moves only the tick at the step", () => {
    for (const phase of [0, 1]) {
      // From 1 ms a frame to 7 at frame 300 + phase, and back at 600 + phase: a pan that starts and ends.
      const step: Board = (frame) => (frame >= 300 + phase && frame < 600 + phase ? 7 : 1);
      const r = run({ hz: 60, seconds: 20, tick: 0.3, board: step });
      assert.equal(r.level, "full", `phase ${phase}`);
      assert.ok(r.most < 1, `phase ${phase}: frame cost up to ${r.most}`);
      // Each tick is judged by the frames beside it, so only a tick that has the step between its neighbours reads more than its own cost.
      const off = r.samples.filter((ms) => Math.abs(ms - 0.3) > 0.01);
      assert.ok(off.length <= 2, `phase ${phase}: ${off.length} ticks read off: ${off.join(", ")}`);
    }
  });

  test("a pinch whose moves come every other frame, in step with the ticks or not, is the board's work: a healthy canvas stays full, and one with no GPU still holds still after it (D-261106-306)", () => {
    for (const phase of [0, 1]) {
      // The camera moves on every other frame for the first 20 s, and the board redraws for 4 ms more in each frame it moved in.
      const camera = (frame: number) => (frame * 16.7 < 20_000 ? Math.floor((frame + phase) / 2) : 0);
      const pinch: Board = (frame) => 1 + (camera(frame) !== camera(frame - 1) ? 4 : 0);
      const r = run({ hz: 60, seconds: 20, tick: 0.3, board: pinch, camera });
      assert.equal(r.level, "full", `phase ${phase}`);
      assert.ok(r.most < 1, `phase ${phase}: frame cost up to ${r.most}`);
      assert.equal(run({ hz: 60, seconds: 40, tick: 3, board: pinch, camera }).level, "still", `phase ${phase}, no GPU`);
    }
  });

  test("a drag or a hover whose moves come every other frame or every fourth, with no camera change, is the board's work too, its redraw in the move's frame or the next (WZR2-1)", () => {
    // A pointer moves before every other frame, or every fourth on a busier phone, for the first 20 s, and the drag layer redraws for 4 ms more in that frame, or in the next where the move came after it started.
    for (const every of [2, 4]) {
      for (let phase = 0; phase < every; phase++) {
        for (const late of [0, 1]) {
          const at = `every ${every} frames, phase ${phase}, ${late} late`;
          const gesture = (frame: number) => frame * 16.7 < 20_000 && (frame + phase) % every === 0;
          const drag: Board = (frame) => 1 + (gesture(frame - late) ? 4 : 0);
          const r = run({ hz: 60, seconds: 20, tick: 0.3, board: drag, gesture });
          assert.equal(r.level, "full", at);
          assert.ok(r.most < 1, `${at}: frame cost up to ${r.most}`);
          assert.equal(run({ hz: 60, seconds: 40, tick: 3, board: drag, gesture }).level, "still", `${at}, no GPU`);
        }
      }
    }
  });

  /** Thirty seconds of input from the first frame to the last, on a healthy canvas and on one adding 3 ms a tick. */
  const underInput = (input: Omit<Parameters<typeof run>[0], "seconds" | "tick">) => ({
    healthy: run({ ...input, seconds: 30, tick: 0.3 }),
    slow: run({ ...input, seconds: 30, tick: 3 }),
  });

  /**
   * A healthy canvas stays full by the costs it measured, not for want of
   * them, and a slow one steps down to still before the input ends. On a
   * board whose frames cost the same for the same work, every cost is the
   * tick's own: a like frame of other work would read its redraw as the
   * weather's, now and then, which a median hides.
   */
  const judgedUnderInput = (at: string, { healthy, slow }: ReturnType<typeof underInput>, exact = true) => {
    assert.equal(healthy.level, "full", at);
    const off = healthy.samples.filter((ms) => Math.abs(ms - 0.3) > 0.01);
    if (exact) assert.deepEqual(off, [], `${at}: costs not the tick's own`);
    assert.ok(healthy.samples.length >= 4 * 30, `${at}: ${healthy.samples.length} costs in 30 s`);
    assert.equal(slow.level, "still", `${at}, no GPU`);
  };

  test("input that never pauses, on every frame or two frames in three, is judged once it has gone on 2 s, its redraw in the move's frame or the next, at 30, 60 and 120 Hz (WXZOOM-SOL-01)", () => {
    const patterns = [
      { name: "every frame", phases: 1, moves: (_frame: number, _phase: number) => true },
      { name: "two frames in three", phases: 3, moves: (frame: number, phase: number) => (frame + phase) % 3 !== 0 },
    ];
    for (const hz of RATES) {
      for (const { name, phases, moves } of patterns) {
        for (let phase = 0; phase < phases; phase++) {
          for (const late of [0, 1]) {
            // A pointer, a finger or a wheel moves over the board for the whole run, and the board redraws for 4 ms more in the move's frame, or in the next where a React render after the paint redraws it.
            const gesture = (frame: number) => moves(frame, phase);
            const redraw: Board = (frame) => 1 + (gesture(frame - late) ? 4 : 0);
            judgedUnderInput(`${name}, phase ${phase}, ${late} late, ${hz} Hz`, underInput({ hz, board: redraw, gesture }));
          }
        }
      }
    }
  });

  test("a wheel turned on every other frame for good, each turn's camera change and redraw in the frame after it, so every frame moves: judged by its kind of frame, not by whether it moved (WXZOOM-SOL-01)", () => {
    for (const hz of RATES) {
      for (const phase of [0, 1]) {
        const gesture = (frame: number) => (frame + phase) % 2 === 0;
        const camera = (frame: number) => Math.floor((frame + phase - 1) / 2);
        const redraw: Board = (frame) => 1 + (camera(frame) !== camera(frame - 1) ? 4 : 0);
        judgedUnderInput(`phase ${phase}, ${hz} Hz`, underInput({ hz, board: redraw, gesture, camera }));
      }
    }
  });

  test("a held arrow key's pan, the camera moving on every frame or every other with no pointer at all, is input too, judged once it has gone on 2 s (WXZOOM-SOL-01)", () => {
    for (const hz of RATES) {
      for (const every of [1, 2]) {
        for (let phase = 0; phase < every; phase++) {
          const camera = (frame: number) => Math.floor((frame + phase) / every);
          const redraw: Board = (frame) => 1 + (camera(frame) !== camera(frame - 1) ? 4 : 0);
          judgedUnderInput(`every ${every}, phase ${phase}, ${hz} Hz`, underInput({ hz, board: redraw, camera }));
        }
      }
    }
  });

  test("a camera change and a hover are different work: the camera easing on every third frame and the mouse moving in the frame after it, never pausing (WXZOOM-SOL-01)", () => {
    for (const hz of RATES) {
      for (let phase = 0; phase < 3; phase++) {
        // The camera's change redraws the whole board, 4 ms more, and the hover only its highlight, half a millisecond.
        const camera = (frame: number) => Math.floor((frame + phase) / 3);
        const turned = (frame: number) => camera(frame) !== camera(frame - 1);
        const gesture = (frame: number) => turned(frame - 1);
        const board: Board = (frame) => 1 + (turned(frame) ? 4 : 0) + (gesture(frame) ? 0.5 : 0);
        judgedUnderInput(`phase ${phase}, ${hz} Hz`, underInput({ hz, board, gesture, camera }));
      }
    }
  });

  test("input on every fourth frame, in step with a 30 fps map at 60 Hz, never pausing: judged against like frames up to four frames off (WXZOOM-SOL-01)", () => {
    for (let phase = 0; phase < 4; phase++) {
      for (const late of [0, 1]) {
        const map = (frame: number) => (frame + phase) % 2 === 0;
        const gesture = (frame: number) => (frame + phase) % 4 === 0;
        const board: Board = (frame) => 1 + (map(frame) ? 4 : 0) + (gesture(frame - late) ? 4 : 0);
        judgedUnderInput(`phase ${phase}, ${late} late`, underInput({ hz: 60, board, gesture, map }));
      }
    }
  });

  test("input whose beat would lock to the holds: every fourth frame at 30 Hz, where a hold comes every fourth frame too, judged as the holds move off its beat (WXZOOM-SOL-01)", () => {
    for (let phase = 0; phase < 4; phase++) {
      for (const late of [0, 1]) {
        const at = `phase ${phase}, ${late} late`;
        const gesture = (frame: number) => (frame + phase) % 4 === 0;
        const redraw: Board = (frame) => 1 + (gesture(frame - late) ? 4 : 0);
        const runs = underInput({ hz: 30, board: redraw, gesture });
        console.log("A", at, runs.healthy.samples.length, runs.healthy.holdsPerSecond.toFixed(2), runs.slow.level, runs.slow.samples.length);
        judgedUnderInput(at, runs);
        assert.ok(runs.healthy.holdsPerSecond < 6, `${at}: ${runs.healthy.holdsPerSecond.toFixed(2)} held frames a second`);
        // A wheel's turn every fourth frame, its camera change and redraw in the frame after.
        const camera = (frame: number) => Math.floor((frame + phase - 1) / 4);
        const wheel: Board = (frame) => 1 + (camera(frame) !== camera(frame - 1) ? 4 : 0);
        const turns = underInput({ hz: 30, board: wheel, gesture, camera });
        console.log("W", at, turns.healthy.samples.length, turns.healthy.holdsPerSecond.toFixed(2), turns.slow.level, turns.slow.samples.length);
        judgedUnderInput(`a wheel, ${at}`, turns);
      }
    }
  });

  test("where its holds make like frames, input that never pauses keeps the holds' beat: one tick in four at 30 Hz, as with no input", () => {
    // Within a window that wants costs the holds come every fourth frame. Between windows that have theirs, none come for a second or two.
    const gaps = (held: readonly number[]) => held.slice(1).map((frame, i) => frame - held[i]!);
    for (const input of [{}, { gesture: () => true }]) {
      const r = run({ hz: 30, seconds: 30, tick: 0.3, board: () => 1, ...input });
      const off = gaps(r.held).filter((gap) => gap !== 4 && gap < 30);
      assert.ok(r.held.length > 20 && off.length === 0, `${"gesture" in input ? "input" : "none"}: ${r.held.length} holds, gaps ${off.join(", ")}`);
    }
  });

  test("input on every third frame beside a 30 fps map at 60 Hz, where each kind of frame comes back only six frames off, in every phase (WXZOOM-SOL-01)", () => {
    for (let mapPhase = 0; mapPhase < 2; mapPhase++) {
      for (let phase = 0; phase < 3; phase++) {
        for (const late of [0, 1]) {
          const at = `map phase ${mapPhase}, input phase ${phase}, ${late} late`;
          const map = (frame: number) => (frame + mapPhase) % 2 === 0;
          const gesture = (frame: number) => (frame + phase) % 3 === 0;
          const board: Board = (frame) => 1 + (map(frame) ? 4 : 0) + (gesture(frame - late) ? 4 : 0);
          const runs = underInput({ hz: 60, board, gesture, map });
          console.log("B", at, runs.healthy.samples.length, runs.healthy.holdsPerSecond.toFixed(2), runs.slow.level, runs.slow.samples.length);
          judgedUnderInput(at, runs);
          assert.ok(runs.healthy.holdsPerSecond < 6, `${at}: ${runs.healthy.holdsPerSecond.toFixed(2)} held frames a second`);
        }
      }
    }
  });

  test("input at random, in a fifth of the frames to four in five, never pausing, on a board that varies by 3 ms: judged, at 30, 60 and 120 Hz (WXZOOM-SOL-01)", () => {
    for (const hz of RATES) {
      for (const share of [0.2, 0.5, 0.8]) {
        for (const seed of [1, 2]) {
          for (const late of [0, 1]) {
            // Each run plays the same moves and the same board: the healthy run, then the slow one.
            const random = () => {
              const r0 = rng(seed);
              const moves: boolean[] = [];
              const noise: number[] = [];
              const gesture = (frame: number) => (moves[frame] ??= r0() < share);
              const board: Board = (frame) => 1 + (noise[frame] ??= r0() * 3) + (gesture(frame - late) ? 4 : 0);
              return { gesture, board };
            };
            const at = `${share} of frames, seed ${seed}, ${late} late, ${hz} Hz`;
            // At 30 Hz the noise alone takes the median of 15 costs (`frameCost`) near 2 ms now and then, as with no input at all, so the level is what counts.
            judgedUnderInput(at, { healthy: run({ hz, seconds: 30, tick: 0.3, ...random() }), slow: run({ hz, seconds: 30, tick: 3, ...random() }) }, false);
          }
        }
      }
    }
  });

  test("a move over a panel beside the board is none of the board's work, and a camera change is, wherever it came from (WZB-7)", () => {
    // Moves on every frame for a second, then a second's pause, so each burst stays a short gesture.
    const bursts = (frame: number) => Math.floor(frame / 60) % 2 === 0;
    const none = run({ hz: 60, seconds: 12, tick: 0.3, board: steady });
    const elsewhere = run({ hz: 60, seconds: 12, tick: 0.3, board: steady, gesture: bursts, elsewhere: true });
    assert.deepEqual(elsewhere.samples, none.samples, "a mouse over the side panel drops no tick");
    const onBoard = run({ hz: 60, seconds: 12, tick: 0.3, board: steady, gesture: bursts });
    assert.ok(onBoard.samples.length < 0.7 * none.samples.length, `on the board: ${onBoard.samples.length} costs, ${none.samples.length} with none`);
    const panned = run({ hz: 60, seconds: 12, tick: 0.3, board: steady, gesture: bursts, elsewhere: true, camera: (frame) => (bursts(frame) ? frame : 0) });
    assert.ok(panned.samples.length < 0.7 * none.samples.length, `a pan driven from a panel: ${panned.samples.length} costs`);
  });

  test("a 30 fps map whose measures come back late now and then, every third frame to every eleventh: a healthy canvas holds under 6 frames a second, and a slow one still steps down (WZB-5)", () => {
    // A late frame that saw the map draw cannot say whose draw it was (#measured), so fewer ticks are judged, a window seldom has its costs, and it keeps holding: 2.6 a second with none late.
    for (const phase of [0, 1]) {
      for (const lateEvery of [3, 5, 7, 11]) {
        const at = `phase ${phase}, a measure late every ${lateEvery} frames`;
        const map = (frame: number) => (frame + phase) % 2 === 0;
        const board: Board = (frame) => 1 + (map(frame) ? 4 : 0);
        const late = (frame: number) => frame % lateEvery === 0;
        const r = run({ hz: 60, seconds: 60, tick: 0.3, board, map, late });
        assert.equal(r.level, "full", at);
        assert.ok(r.holdsPerSecond < 6, `${at}: ${r.holdsPerSecond.toFixed(2)} held frames a second`);
        assert.equal(run({ hz: 60, seconds: 30, tick: 3, board, map, late }).level, "still", `${at}, no GPU`);
      }
    }
  });

  test("a 30 fps animated map playing all along, in step with the ticks or not, at 30, 60 and 120 Hz: healthy weather stays full, and weather adding 3 ms a tick holds still while the map plays (WXZOOM-ASTRA-05)", () => {
    for (const hz of RATES) {
      const every = hz / 30;
      for (let phase = 0; phase < every; phase++) {
        // The map draws every `every` frames for the whole run, and its draw and paint cost 4 ms more in the frames it draws in.
        const map = (frame: number) => (frame + phase) % every === 0;
        const playing: Board = (frame) => 1 + (map(frame) ? 4 : 0);
        const r = run({ hz, seconds: 30, tick: 0.3, board: playing, map });
        assert.equal(r.level, "full", `${hz} Hz phase ${phase}`);
        assert.ok(r.most < 1, `${hz} Hz phase ${phase}: frame cost up to ${r.most}`);
        // The holds that make like frames never stop the weather: it moves as far as the time that passed.
        assert.ok(r.moved > 0.97 * 30_000, `${hz} Hz phase ${phase}: moved ${r.moved.toFixed(0)} ms in 30 s`);
        const slow = run({ hz, seconds: 30, tick: 3, board: playing, map });
        assert.equal(slow.level, "still", `${hz} Hz phase ${phase}, no GPU`);
        assert.ok(slow.frameCost > 2.5 && slow.frameCost < 3.5, `${hz} Hz phase ${phase}: measured ${slow.frameCost}`);
      }
    }
  });

  test("a board whose every frame costs something different keeps a healthy canvas moving, and still finds a slow one", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r0 = rng(seed);
      // From 1 to 4 ms a frame, at random, at every rate, and from 0.5 to 7.5 where ticks have a neighbour on each side.
      const jitter: Board = () => 1 + r0() * 3;
      const wide: Board = () => 0.5 + r0() * 7;
      for (const hz of RATES) {
        assert.equal(run({ hz, seconds: 120, tick: 0.3, board: jitter }).level, "full", `seed ${seed} at ${hz} Hz`);
        assert.equal(run({ hz, seconds: 14, tick: 3, board: jitter }).level, "still", `seed ${seed} at ${hz} Hz, no GPU`);
      }
      for (const hz of [60, 120]) assert.equal(run({ hz, seconds: 120, tick: 0.3, board: wide }).level, "full", `seed ${seed} at ${hz} Hz, wide`);
    }
  });

  test("a 30 Hz screen, where every frame would tick, holds one tick in four while a window wants frame costs, and the weather keeps its speed", () => {
    const r = run({ hz: 30, seconds: 10, tick: 0.3, board: steady });
    assert.ok(r.ticks >= 270 && r.ticks <= 285, `${r.ticks} ticks in 10 s`);
    // As far a second at 30 Hz as at 60 Hz, where no tick is held: the tick after a hold steps the whole gap (WXB-R3-1).
    for (const board of [steady, (() => { const r0 = rng(7); return () => 0.5 + r0() * 8; })()]) {
      const slow = run({ hz: 30, seconds: 60, tick: 0.3, board });
      const fast = run({ hz: 60, seconds: 60, tick: 0.3, board: steady });
      assert.ok(Math.abs(slow.moved / fast.moved - 1) < 0.02, `30 Hz moved ${slow.moved.toFixed(0)} ms, 60 Hz ${fast.moved.toFixed(0)}`);
    }
    assert.ok(r.frameCost > 0.2 && r.frameCost < 0.4, `measured ${r.frameCost}`);
    const busy = run({ hz: 30, seconds: 10, tick: 3, board: () => 9 });
    assert.ok(busy.frameCost > 2.5 && busy.frameCost < 3.5, `a busy board's ticks measured ${busy.frameCost}, not its 9 ms`);
  });

  test("once its windows have their costs, a healthy 30 Hz screen repeats a frame about three times a second, not seven and a half", () => {
    const settled = run({ hz: 30, seconds: 60, tick: 0.3, board: steady });
    assert.ok(settled.quietPerSecond >= 2 && settled.quietPerSecond <= 3, `${settled.quietPerSecond.toFixed(2)} held frames a second`);
    const r0 = rng(11);
    const noisy = run({ hz: 30, seconds: 60, tick: 0.3, board: () => 1 + r0() * 3 });
    assert.ok(noisy.quietPerSecond <= 4, `a board varying by 3 ms: ${noisy.quietPerSecond.toFixed(2)} a second`);
    // A canvas near the limit keeps sampling every window, one tick in four.
    const near = run({ hz: 30, seconds: 30, tick: 1.5, board: steady });
    assert.ok(near.quietPerSecond > 7, `near the limit: ${near.quietPerSecond.toFixed(2)} a second`);
  });

  test("a 30 Hz screen whose board is noisy keeps a healthy canvas moving for five minutes: up to 8 ms more in any frame, or a 12 ms task in three frames of ten", () => {
    // Each held frame is the measure of the two ticks beside it, so one held at its lowest makes both read high (WXB-R2-1: holding one in eight, half of 60 such phones held still).
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r0 = rng(seed);
      assert.equal(run({ hz: 30, seconds: 300, tick: 0.3, board: () => 0.5 + r0() * 8 }).level, "full", `seed ${seed}, jitter`);
      assert.equal(run({ hz: 30, seconds: 300, tick: 0.5, board: () => 0.5 + (r0() < 0.3 ? 12 : 0) }).level, "full", `seed ${seed}, tasks`);
      assert.equal(run({ hz: 30, seconds: 20, tick: 3, board: () => 0.5 + r0() * 8 }).level, "still", `seed ${seed}, jitter, no GPU`);
    }
  });

  test("a canvas with no GPU, whose ticks add 3 ms of paint (90 ms a second, over 6.1's 60), steps down to half and then holds still, at 30, 60 and 120 Hz, panned or not", () => {
    for (const hz of RATES) {
      for (const board of [steady, pans]) {
        const r = run({ hz, seconds: 14, tick: 3, board });
        assert.equal(r.level, "still", `${hz} Hz ${board === pans ? "panned" : "at rest"}`);
      }
    }
    const r = run({ hz: 60, seconds: 14, tick: 3, board: steady });
    assert.ok(r.frameCost > 2.5 && r.frameCost < 3.5, `${r.frameCost}`);
  });

  test("a GPU canvas whose ticks add half a millisecond keeps moving, however busy the board is in every frame and however often something else's long task runs", () => {
    for (const board of [0.5, 9]) {
      const { level, most } = run({ hz: 60, tick: 0.5, seconds: 12, board: () => board });
      assert.ok(most < 0.6, `board ${board}: ${most}`);
      assert.equal(level, "full", `board ${board}`);
    }
    // A long task every fifth frame slows the frames themselves, which the mode judges by their gaps. The cost a tick adds stays its own.
    const { most } = run({ hz: 60, tick: 0.5, seconds: 12, board: () => 0.5, strayEvery: 5 });
    assert.ok(most < 0.6, `a stray task every fifth frame: ${most}`);
  });

  test("a frame across a dropped one is no tick's neighbour", () => {
    // At 120 Hz a pan's first move comes with a long task that drops the frames it runs into, after a frame with no tick, and the board then costs 7 ms a frame where it cost 1.
    let dropped = -1;
    const r = run({
      hz: 120,
      seconds: 3,
      tick: 0.3,
      board: (frame) => (dropped >= 0 && frame > dropped ? 7 : 1),
      between: (frame, ticked) => {
        if (dropped >= 0 || frame < 200 || ticked) return 0;
        dropped = frame;
        return 30;
      },
    });
    assert.ok(dropped > 0 && r.samples.length > 50);
    assert.ok(Math.max(...r.samples) < 0.31, `the tick after the drop is measured against the frame after it alone: ${Math.max(...r.samples)}`);
  });

  test("a measure that comes back only after the next frame started says nothing", () => {
    const r = run({ hz: 60, seconds: 12, tick: 3, board: steady, late: () => true });
    assert.deepEqual(r.samples, []);
    assert.equal(r.frameCost, 0);
    assert.equal(r.level, "full");
  });
});
