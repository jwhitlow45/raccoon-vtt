import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WorkBudget } from "#shared/rules/walk.ts";
import { RouteWork, type Frames, type RouteJob } from "./routeWork.ts";

/** Frames by hand on a clock that moves a frame's length each turn. */
class Clock implements Frames {
  t = 0;
  queue: (() => void)[] = [];
  now(): number {
    return this.t;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  /** The next frame: its events at its start, then its turn. */
  frame(events: () => void = () => {}): void {
    this.t += 16;
    events();
    this.t += 0.5;
    for (const run of this.queue.splice(0)) run();
  }
}

/** Work that charges `per` units a call until it has done `total`. */
function chunked(total: number, per: number, log: string[], name: string, first = false): RouteJob & { left: number } {
  const job = {
    first,
    left: total,
    run(budget: WorkBudget): boolean {
      log.push(name);
      while (job.left > 0) {
        if (budget.spent) return false;
        budget.charge(per);
        job.left -= per;
      }
      return true;
    },
  };
  return job;
}

describe("the board's route work (routeWork.ts)", () => {
  test("one budget a frame for every consumer, nothing run once it is spent, and the drag and presses first", () => {
    const clock = new Clock();
    const frames: number[] = [];
    const work = new RouteWork(clock, () => new WorkBudget({ limit: 100 }), (units) => frames.push(units));
    const log: string[] = [];
    const a = chunked(300, 10, log, "a");
    const b = chunked(300, 10, log, "b");
    const drag = chunked(50, 10, log, "drag", true);
    clock.frame(() => {
      work.add(a);
      work.add(b);
      assert.equal(work.run(drag), true, "the drag's work runs at once while the frame has budget");
    });
    // The drag took 50 of the frame's 100, a took the rest, and b waited.
    assert.deepEqual(log, ["drag", "a"]);
    assert.equal(a.left, 250);
    assert.equal(b.left, 300);
    log.length = 0;
    clock.frame();
    assert.deepEqual(log, ["b"], "the next frame starts past the last that ran");
    log.length = 0;
    clock.frame();
    assert.deepEqual(log, ["a"]);
    for (let k = 0; k < 10 && work.waiting; k++) clock.frame();
    assert.equal(work.waiting, false);
    assert.ok(frames.every((u) => u <= 100), `frames ${frames.join(", ")}`);
  });

  test("an event before the frame's turn opens the frame's budget, and the turn takes it over", () => {
    const clock = new Clock();
    const frames: number[] = [];
    const work = new RouteWork(clock, () => new WorkBudget({ limit: 100 }), (units) => frames.push(units));
    const log: string[] = [];
    const slow = chunked(1000, 10, log, "slow");
    clock.frame(() => work.add(slow));
    clock.frame();
    // An event of the third frame spends 60 of its budget, and its turn has 40 left, not a fresh 100.
    clock.frame(() => {
      assert.equal(work.run(chunked(60, 10, log, "event")), true);
    });
    work.drop(slow);
    clock.frame();
    assert.deepEqual(frames.slice(0, 3), [100, 100, 100]);
  });

  test("a budget timed by its work: what ran before the turn counts against the frame", () => {
    let t = 0;
    const budget = new WorkBudget({ ms: 4, clock: () => t });
    budget.begin();
    t += 3;
    budget.end();
    t += 10;
    budget.begin();
    budget.charge(16);
    assert.equal(budget.spent, false, "3 ms of work, 10 ms idle between");
    t += 1;
    budget.charge(16);
    assert.equal(budget.spent, true, "4 ms of work");
  });
});
