import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FrameScheduler } from "./scheduler.ts";

class Layer {
  readonly log: string[];
  readonly name: string;
  constructor(name: string, log: string[]) {
    this.name = name;
    this.log = log;
  }
  draw(): void {
    this.log.push(this.name);
  }
  batchDraw(): void {
    this.log.push(`konva ${this.name}`);
  }
}

function frames() {
  const queue: ((time: number) => void)[] = [];
  return {
    queue,
    request: (run: (time: number) => void) => queue.push(run),
    cancel: (id: number) => {
      queue[id - 1] = () => {};
    },
    flush: () => {
      const runs = queue.splice(0);
      for (const r of runs) r(0);
    },
  };
}

describe("the isometric board's frame scheduler", () => {
  test("any number of requests in a frame make one draw of each layer, the ground before the relief", () => {
    const log: string[] = [];
    const ground = new Layer("ground", log);
    const relief = new Layer("relief", log);
    const f = frames();
    const s = new FrameScheduler(ground, relief, f);
    ground.batchDraw();
    relief.batchDraw();
    ground.batchDraw();
    relief.batchDraw();
    assert.equal(f.queue.length, 1);
    f.flush();
    assert.deepEqual(log, ["ground", "relief"]);
    assert.equal(s.frames, 1);
  });

  test("a ground draw always brings a relief draw after it, since the tops copy the ground", () => {
    const log: string[] = [];
    const f = frames();
    const ground = new Layer("ground", log);
    new FrameScheduler(ground, new Layer("relief", log), f);
    ground.batchDraw();
    f.flush();
    assert.deepEqual(log, ["ground", "relief"]);
  });

  test("a relief request alone draws only the relief", () => {
    const log: string[] = [];
    const f = frames();
    const relief = new Layer("relief", log);
    new FrameScheduler(new Layer("ground", log), relief, f);
    relief.batchDraw();
    f.flush();
    assert.deepEqual(log, ["relief"]);
  });

  test("detaching cancels a waiting frame and gives the layers Konva's batchDraw back", () => {
    const log: string[] = [];
    const f = frames();
    const ground = new Layer("ground", log);
    const relief = new Layer("relief", log);
    const s = new FrameScheduler(ground, relief, f);
    ground.batchDraw();
    s.detach();
    f.flush();
    ground.batchDraw();
    assert.deepEqual(log, ["konva ground"]);
  });
});

/** A clock and a frame queue, each frame given its start time as requestAnimationFrame gives it. */
function clocked() {
  const clock = { t: 0 };
  const queue: ((time: number) => void)[] = [];
  return {
    clock,
    frames: { request: (run: (time: number) => void) => queue.push(run), cancel: () => {} },
    now: () => clock.t,
    /** Runs the frame waiting, at `start`. `before` and `after` run in the same frame around the scheduler's callback, as other frame callbacks do. */
    frame(start: number, before?: () => void, after?: () => void, late = 0) {
      // Other frame callbacks may run first: the scheduler's starts `late` ms after the frame's timestamp.
      clock.t = start + late;
      before?.();
      for (const r of queue.splice(0)) r(start);
      after?.();
    },
  };
}

/** A layer whose draw takes `cost` ms on the clock. */
function costly(clock: { t: number }, cost: number) {
  return { draw: () => void (clock.t += cost), batchDraw: () => {} };
}

describe("the scheduler's background budget (docs/design-v1-relief-pan.md 8, D-261030-547)", () => {
  test("a frame that began with a repaint waiting runs no job, whether its mark came before the scheduler's callback or in an earlier frame's commit", () => {
    const c = clocked();
    const s = new FrameScheduler(costly(c.clock, 1), costly(c.clock, 3), c.frames, c.now);
    const ran: number[] = [];
    s.background((until) => {
      ran.push(until);
      return true;
    });
    c.frame(0);
    assert.equal(ran.length, 1, "an idle frame slices");
    // A content mark from React's commit before this frame's callback.
    c.frame(16, () => s.mark("relief"));
    assert.equal(ran.length, 1, "the repaint's frame slices nothing");
    c.frame(32);
    assert.equal(ran.length, 2);
    assert.equal(s.slicesInWhole, 0);
  });

  test("a mark that lands after the scheduler's callback is drawn in the next frame, which then slices nothing", () => {
    const c = clocked();
    const s = new FrameScheduler(costly(c.clock, 1), costly(c.clock, 3), c.frames, c.now);
    let ran = 0;
    s.background(() => {
      ran++;
      return true;
    });
    c.frame(0, undefined, () => s.mark("relief"));
    assert.equal(ran, 1, "this frame drew nothing whole before its slice");
    c.frame(16);
    assert.equal(ran, 1, "the next frame repaints and slices nothing");
    c.frame(32);
    assert.equal(ran, 2);
  });

  test("an area's publish in a slice: its commit's repaint never shares a frame with a slice, wherever the commit lands", () => {
    for (const lands of ["before", "after"] as const) {
      const c = clocked();
      let frame = 0;
      const repaints: number[] = [];
      const relief = { draw: () => void repaints.push(frame), batchDraw: () => {} };
      const s = new FrameScheduler(costly(c.clock, 1), relief, c.frames, c.now);
      const slices: number[] = [];
      let commitDue = false;
      s.background(() => {
        slices.push(frame);
        // The first slice publishes: React commits later, and its commit marks the relief.
        if (slices.length === 1) commitDue = true;
        return slices.length < 5;
      });
      for (frame = 0; frame < 8; frame++) {
        const commit = () => {
          if (!commitDue) return;
          commitDue = false;
          s.mark("relief");
        };
        c.frame(frame * 16, lands === "before" ? commit : undefined, lands === "after" ? commit : undefined);
      }
      assert.equal(repaints.length, 1, `landing ${lands}: one repaint`);
      assert.ok(!slices.includes(repaints[0]!), `landing ${lands}: a slice in frame ${repaints[0]}, which repainted whole`);
      assert.equal(slices.length, 5, `landing ${lands}: the build still finishes`);
      assert.equal(s.slicesInWhole, 0);
    }
  });

  test("two jobs share one budget of at most 6 ms from the frame's own start, so a heavy draw leaves them less, and a frame drawn only for the camera slices", () => {
    const c = clocked();
    const s = new FrameScheduler(costly(c.clock, 1), costly(c.clock, 8), c.frames, c.now);
    const untils: number[] = [];
    const job = (until: number) => {
      untils.push(until);
      c.clock.t += 2;
      return true;
    };
    s.background(job);
    s.background((until) => job(until));
    c.frame(100);
    assert.deepEqual(untils, [106, 106], "an idle frame: 6 ms, shared by both");
    untils.length = 0;
    // A camera move: the relief draws for 8 ms from the frame's start at 200, which leaves 4 of the frame's 12.
    s.moveCamera(() => s.mark("relief"));
    c.frame(200);
    assert.deepEqual(untils, [212, 212]);
    untils.length = 0;
    // The ground's 1 ms and the relief's 8 from a callback 5 ms into the frame pass its 12 ms: nothing is left.
    s.moveCamera(() => {
      s.mark("ground");
      s.mark("relief");
    });
    c.frame(300, undefined, undefined, 5);
    assert.deepEqual(untils, []);
    c.frame(400);
    assert.equal(untils.length, 2, "and the jobs go on in the next frame");
  });
});
