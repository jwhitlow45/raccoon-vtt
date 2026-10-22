import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { RoomScope } from "../../state/scope.ts";
import type { DropPlan } from "./drop.ts";
import { RouteWork, type Frames, type RouteJob } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";
import { line, thorn, world } from "./testing.ts";

/**
 * The drag's stops as the board drives them (stageHooks.ts), under Node:
 * a press or a drop still waiting for its frame's budget when the board
 * ends never sends or lands (review ASTRA-16).
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frames by hand. */
class Hand implements Frames {
  queue: (() => void)[] = [];
  now(): number {
    return 0;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  frame(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

function board(view: RoomState) {
  const frames = new Hand();
  const work = new RouteWork(frames, () => new WorkBudget({ limit: 1000 }));
  const sent: ClientOp[] = [];
  let n = 0;
  const deps: DragDeps = {
    store: { getState: () => ({ view }) } as unknown as DragDeps["store"],
    actions: { dispatch: (op: ClientOp) => (sent.push(op), ++n), newId: () => `id${++n}` } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope: new RoomScope(),
    role: "player",
    work,
  };
  const stops = dragStops(deps);
  /** Spends what is left of the frame's budget, as other work earlier in the frame would. */
  const spend = () => {
    const filler: RouteJob = {
      run: (budget) => {
        budget.charge(1000);
        return true;
      },
    };
    work.run(filler);
  };
  return { frames, work, sent, stops, spend };
}

const node = (t: Token, dx = 0, dy = 0) => ({ x: () => t.x + dx, y: () => t.y + dy, position: () => {} });

describe("the drag's stops", () => {
  test("a press waiting for its frame never sends once the board ends", () => {
    const hero = thorn({ x: 2, y: 2 });
    const view = world({ tokens: [hero] });
    const b = board(view);
    b.frames.frame();
    b.spend();
    b.stops.press(node(hero, 1), hero, [hero]);
    assert.equal(b.sent.length, 0, "it waits for the next frame");
    b.stops.end();
    b.frames.frame();
    b.frames.frame();
    assert.deepEqual(b.sent, [], "nothing sent after the end");
    assert.equal(b.work.waiting, false, "no work left behind");
  });

  test("a drop already answered and waiting for its frame never lands once the board ends", () => {
    const hero = thorn({ x: 2, y: 2 });
    const view = world({ tokens: [hero], edges: line("w", 6, 0, 10) });
    const b = board(view);
    b.frames.frame();
    b.stops.start(hero.id);
    // Open ground: the answer comes at once.
    b.stops.frame(node(hero, 1), hero);
    b.spend();
    const landed: DropPlan[] = [];
    b.stops.drop(node(hero, 1), hero, [hero], (plan) => landed.push(plan));
    assert.equal(landed.length, 0, "its landing waits for the next frame");
    b.stops.end();
    b.frames.frame();
    b.frames.frame();
    assert.deepEqual(landed, [], "nothing lands after the end");
    assert.equal(b.work.waiting, false, "no work left behind");
  });

  test("random drags, drops, presses, spent frames and ends: each drop lands once, each press sends at most once, and nothing goes after the end", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rand = mulberry32(seed);
      const hero = thorn({ x: 5, y: 5 });
      const view = world({ tokens: [hero], edges: { ...line("w", 8, 0, 6 + Math.floor(rand() * 20)), ...line("n", 9, 0, 4) } });
      const b = board(view);
      const lands: number[] = [];
      let presses = 0;
      let dragging = false;
      let ended = false;
      const spot = () => node(hero, Math.floor(rand() * 12) - 4, Math.floor(rand() * 12) - 4);
      for (let e = 0; e < 60 && !ended; e++) {
        const r = rand();
        if (r < 0.15) b.spend();
        else if (r < 0.35) b.frames.frame();
        else if (r < 0.6) {
          if (!dragging) b.stops.start(hero.id);
          dragging = true;
          b.stops.frame(spot(), hero);
        } else if (r < 0.72 && dragging) {
          const k = lands.push(0) - 1;
          b.stops.drop(spot(), hero, [hero], () => lands[k]!++);
          dragging = false;
        } else if (r < 0.9) {
          presses++;
          b.stops.press(spot(), hero, [hero]);
        } else if (r < 0.95) {
          ended = true;
          b.stops.end();
        }
      }
      const sentAtEnd = b.sent.length;
      const landsAtEnd = [...lands];
      for (let k = 0; k < 2_000 && b.work.waiting; k++) b.frames.frame();
      assert.equal(b.work.waiting, false, `seed ${seed}: work left behind`);
      assert.ok(lands.every((n) => n <= 1), `seed ${seed}: a drop landed twice`);
      if (ended) {
        assert.equal(b.sent.length, sentAtEnd, `seed ${seed}: sent after the end`);
        assert.deepEqual(lands, landsAtEnd, `seed ${seed}: landed after the end`);
      } else {
        assert.ok(lands.every((n) => n === 1), `seed ${seed}: a drop never landed`);
        assert.ok(b.sent.length <= presses + lands.length, `seed ${seed}: ${b.sent.length} ops for ${presses} presses and ${lands.length} drops`);
      }
    }
  });

  test("a press waiting for its frame sends once, in the next frame, and a new drag first sends it", () => {
    const hero = thorn({ x: 2, y: 2 });
    const view = world({ tokens: [hero] });
    const b = board(view);
    b.frames.frame();
    b.spend();
    b.stops.press(node(hero, 1), hero, [hero]);
    b.frames.frame();
    assert.equal(b.sent.length, 1);
    b.spend();
    b.stops.press(node(hero, 1), hero, [hero]);
    b.stops.start(hero.id);
    assert.equal(b.sent.length, 2, "a new drag lands what waits first");
    b.frames.frame();
    assert.equal(b.sent.length, 2, "and only once");
  });
});
