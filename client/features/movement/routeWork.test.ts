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
    // The drag's event took 50 of the frame's budget before the callback, and the callback's turn went on with it: a took the other 50, and b waited.
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

  test("events at any offsets before one animation callback share one budget: only the callback renews it (review ASTRA-14)", () => {
    const clock = new Clock();
    const frames: number[] = [];
    const work = new RouteWork(clock, () => new WorkBudget({ limit: 100 }), (units) => frames.push(units));
    const log: string[] = [];
    clock.frame();
    // Three events 0, 6 and 13 ms into the frame, then 20 ms later, and no callback between them.
    const start = clock.t;
    for (const offset of [0, 6, 13, 33]) {
      clock.t = start + offset;
      work.run(chunked(60, 10, log, `event ${offset}`));
    }
    assert.equal(work.budget().units, 100, "all four share the frame's 100 units");
    for (let k = 0; k < 10 && work.waiting; k++) clock.frame();
    assert.ok(frames.every((u) => u <= 100), `frames ${frames.join(", ")}`);
  });

  test("a frame's events and its callback's turn share one budget, from the first frame on and after a turn that left some over (review ASTRA-14)", () => {
    const clock = new Clock();
    const work = new RouteWork(clock, () => new WorkBudget({ limit: 100 }));
    let units = 0;
    /** Work of `total` units, ten at a time, counted into the frame it runs in. */
    const job = (total: number, first = false): RouteJob => {
      let left = total;
      return {
        first,
        run: (budget) => {
          while (left > 0) {
            if (budget.spent) return false;
            budget.charge(10);
            units += 10;
            left -= 10;
          }
          return true;
        },
      };
    };
    const frames: number[] = [];
    const frame = (events?: () => void) => {
      units = 0;
      clock.frame(events);
      frames.push(units);
    };
    // The first frame: an event's work before any callback, then the turn's.
    frame(() => {
      work.run(job(60, true));
      work.add(job(250));
    });
    for (let k = 0; k < 20 && work.waiting; k++) frame();
    // The last turn finished all there was with budget over: a drag's event in the next frame starts that frame's own.
    frame(() => work.run(job(1000, true)));
    for (let k = 0; k < 20 && work.waiting; k++) frame();
    assert.equal(work.waiting, false, "all the work done");
    assert.ok(frames.every((u) => u <= 100), `frames ${frames.join(", ")}`);
    assert.equal(frames.reduce((a, b) => a + b, 0), 1310);
  });

  test("a job dropped during a turn, by another job's work, never runs in it", () => {
    const clock = new Clock();
    const work = new RouteWork(clock, () => new WorkBudget({ limit: 1000 }));
    const log: string[] = [];
    const late = chunked(10, 10, log, "late");
    const dropper: RouteJob = {
      run: () => {
        log.push("dropper");
        work.drop(late);
        return true;
      },
    };
    clock.frame(() => {
      work.add(dropper);
      work.add(late);
    });
    assert.deepEqual(log, ["dropper"]);
  });

  test("the rest take turns by who comes next, however many finish or are dropped during a turn (review MV-O-25)", () => {
    const clock = new Clock();
    const work = new RouteWork(clock, () => new WorkBudget({ limit: 10 }));
    let frame: string[] = [];
    const frames: string[][] = [];
    /** Work that runs once a frame, spending its budget, or finishes at once. */
    const job = (name: string, quick = false): RouteJob => ({
      run: (budget) => {
        frame.push(name);
        if (quick) return true;
        budget.charge(10);
        return false;
      },
    });
    const turn = () => {
      frame = [];
      clock.frame();
      frames.push(frame);
    };
    const [b, c, d, e] = ["b", "c", "d", "e"].map((name) => job(name));
    work.add(job("a", true));
    for (const each of [b, c, d, e]) work.add(each!);
    for (let f = 0; f < 6; f++) turn();
    // a finished in the first frame's turn, so c, which came after the last that ran, goes next.
    assert.deepEqual(frames, [["a", "b"], ["c"], ["d"], ["e"], ["b"], ["c"]]);
    // d comes next. Dropped between frames, e goes next instead.
    work.drop(d!);
    turn();
    assert.deepEqual(frames.at(-1), ["e"]);
    // e's work, now last in the order, drops b, which comes after it: c goes next instead.
    const dropper: RouteJob = {
      run: (budget) => {
        frame.push("e");
        work.drop(b!);
        budget.charge(10);
        return false;
      },
    };
    work.drop(e!);
    work.add(dropper);
    for (let f = 0; f < 4; f++) turn();
    assert.deepEqual(frames.slice(-4), [["b"], ["c"], ["e"], ["c"]]);
  });

  test("random work, finished, dropped between frames and by other work: none waiting sees another run twice before its own turn (review MV-O-25)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      let a = seed;
      const rand = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const clock = new Clock();
      const work = new RouteWork(clock, () => new WorkBudget({ limit: 10 }));
      const live = new Set<RouteJob>();
      /** For each job waiting, the jobs that ran since it last ran or came. */
      const since = new Map<RouteJob, Set<RouteJob>>();
      let made = 0;
      const ran = (job: RouteJob) => {
        for (const [waiting, seen] of since) {
          if (waiting === job) continue;
          assert.ok(!seen.has(job), `seed ${seed}: a job ran twice while another waited`);
          seen.add(job);
        }
        since.set(job, new Set());
      };
      const gone = (job: RouteJob) => {
        live.delete(job);
        since.delete(job);
      };
      const make = (): RouteJob => {
        made++;
        const job: RouteJob = {
          run: (budget) => {
            ran(job);
            if (rand() < 0.15) {
              const other = [...live][Math.floor(rand() * live.size)];
              if (other && other !== job) {
                work.drop(other);
                gone(other);
              }
            }
            budget.charge(1 + Math.floor(rand() * 10));
            const done = rand() < 0.2;
            if (done) gone(job);
            return done;
          },
        };
        return job;
      };
      for (let e = 0; e < 80; e++) {
        const r = rand();
        if (r < 0.35 || live.size === 0) {
          const job = make();
          live.add(job);
          since.set(job, new Set());
          work.add(job);
        } else if (r < 0.45) {
          const job = [...live][Math.floor(rand() * live.size)]!;
          work.drop(job);
          gone(job);
        } else clock.frame();
      }
      assert.ok(made > 10, `seed ${seed}: ${made} jobs`);
    }
  });

  test("a budget's time counts from the outermost run's begin to its end, however runs nest (review ASTRA-17)", () => {
    let t = 0;
    const budget = new WorkBudget({ ms: 4, clock: () => t });
    budget.begin();
    // An inner run, as a drag's answer that sets off a preview's check does.
    budget.begin();
    t += 1;
    budget.end();
    t += 21;
    budget.charge(16);
    assert.equal(budget.spent, true, "22 ms of work in the outer run");
    budget.end();
    const units = new WorkBudget({ limit: 100 });
    units.begin();
    units.begin();
    units.charge(60);
    units.end();
    units.charge(60);
    units.end();
    assert.equal(units.spent, true);
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
