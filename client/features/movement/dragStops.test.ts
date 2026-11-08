import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientOp, Op } from "#shared/protocol.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { token } from "#shared/testutil.ts";
import { dragFootingCells } from "../../canvas/relief/stand.ts";
import { rulesOutline } from "../../lib/scene.ts";
import { drawnFootprintGround, type DrawnSource } from "../../lib/view.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { RoomScope } from "../../state/scope.ts";
import { dragSpots, withSpots } from "../areas/liveTokens.ts";
import type { DropPlan } from "./drop.ts";
import { RouteWork, type Frames, type RouteJob } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";
import { routeSlot } from "./store.ts";
import { line, onTurn, recordedCost, thorn, world } from "./testing.ts";

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
    store: { getState: () => ({ view, floorView: view }) } as unknown as DragDeps["store"],
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
  return { frames, work, sent, stops, spend, scope: deps.scope as RoomScope };
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

  /** A Large ogre on its turn whose straight drop at (10.9, 3.1) squeezes it in at (10.5, 3.5), between a ledge and a pit. */
  const squeezeWorld = (extra: Partial<Token> = {}) => {
    const base = world({ heights: { "10,3": 1, "12,4": 10 }, edges: { "10,9,n": { kind: "wall" } } });
    const chunk = base.buildChunks["s1:0,0"]!;
    base.buildChunks["s1:0,0"] = { ...chunk, cells: { ...chunk.cells, "11,5": "pit", "9,7": "pit", "13,7": "pit", "12,9": "pit" } };
    base.meta = { ...base.meta, settings: { ...base.meta.settings, diagonal: "five" } };
    base.tokens.ogre = token("ogre", { size: "large", x: 10, y: 6, elevation: 0, kind: "pc", ownerIds: ["p1"], disposition: "ally", ...extra });
    const view = onTurn(base, "ogre");
    return { view, mover: view.tokens.ogre! };
  };

  test("a straight drop that lands squeezed reads, while it is dragged, the cost its move records (review ASTRA-18)", () => {
    const { view, mover } = squeezeWorld();
    const b = board(view);
    b.frames.frame();
    b.stops.start(mover.id);
    const finger = { x: () => 10.9, y: () => 3.1, position: () => {} };
    for (let k = 0; k < 50; k++) {
      b.stops.frame(finger, mover);
      b.frames.frame();
    }
    const route = b.scope.get(routeSlot).getState().route;
    assert.ok(route && !route.searching, "the drag has its answer");
    const ft = b.stops.frameFields(mover.id).ft;
    let landed: DropPlan | null = null;
    b.stops.drop(finger, mover, [mover], (plan) => (landed = plan));
    for (let k = 0; k < 50 && !landed; k++) b.frames.frame();
    const plan = landed as DropPlan | null;
    assert.deepEqual([plan?.moves[0]?.x, plan?.moves[0]?.y, plan?.moves[0]?.squeeze], [10.5, 3.5, true], "it lands squeezed");
    b.stops.send(plan!);
    const cost = recordedCost(view, b.sent.at(-1) as Op, "ogre");
    assert.deepEqual([route.read.dragFt, ft], [cost, cost], "the label and the frame read what the move records");
  });

  /*
   * Placed 2/8 right of its spot, the ogre is drawn at its rules spot plus
   * 0.25. An ordinary drag with the node at 11.15 and a free one at 10.9
   * both aim at (10.9, 3.1), and both drops squeeze it in at (10.5, 3.5),
   * where it holds the square (11, 4) alone. While it is dragged, what
   * follows it reads that landing, never the box (11, 3) under the pointer
   * at its full size (SNAPBUILD-ASTRA-04).
   */
  for (const [mode, x, free] of [
    ["an ordinary", 11.15, false],
    ["a free", 10.9, true],
  ] as const) {
    test(`${mode} drag of a placed token into a squeeze shows its outline on the squares the drop lands it in (SNAPBUILD-ASTRA-04)`, () => {
      const { view, mover } = squeezeWorld({ nudge: { x: 2, y: 0 } });
      const b = board(view);
      b.frames.frame();
      b.stops.start(mover.id);
      const finger = { x: () => x, y: () => 3.1, position: () => {} };
      for (let k = 0; k < 50; k++) {
        b.stops.frame(finger, mover, free);
        b.frames.frame();
      }
      const spot = b.scope.get(localDragSlot).getState().spots.ogre;
      assert.deepEqual(spot, { x: 10.5, y: 3.5, squeeze: true }, "the spot is the landing, squeezed, half a cell off the grid");
      assert.deepEqual(rulesOutline(SQUARES, mover, spot), { x: 11, y: 4, w: 1, h: 1 }, "the outline holds the one square it squeezes into");
      const live = withSpots(view.tokens, dragSpots(view.tokens, [{ tokenId: "ogre", ...spot! }], () => SQUARES)).ogre!;
      assert.deepEqual(footprintRect(SQUARES, live), { x: 11, y: 4, w: 1, h: 1 }, "an aura and the In area lists read the same square");
      // In Isometric its base, its decor and its outline stand on that square's ground, 0 ft, not on the 10 ft at (12, 4) its full box there would cover (SNAPBUILD-ASTRA-05).
      const src: DrawnSource = { chunks: view.buildChunks, sceneId: "s1", bounds: { w: 30, h: 30 }, grid: SQUARES, fog: null, stand: true };
      assert.equal(drawnFootprintGround(src, [{ col: 12, row: 4 }]), 10, "the neighbor is higher");
      assert.equal(drawnFootprintGround(src, dragFootingCells(SQUARES, mover, spot!)), 0, "the ground under the square it squeezes into");
      let landed: DropPlan | null = null;
      b.stops.drop(finger, mover, [mover], (plan) => (landed = plan), { free, inPlace: true });
      for (let k = 0; k < 50 && !landed; k++) b.frames.frame();
      const plan = landed as DropPlan | null;
      assert.deepEqual([plan?.moves[0]?.x, plan?.moves[0]?.y, plan?.moves[0]?.squeeze], [10.5, 3.5, true], "the drop lands where the outline stood");
    });
  }

  test("a press waiting for its frame sends once, in the next frame, and a new drag first sends it", () => {
    const hero = thorn({ x: 2, y: 2 });
    const view = world({ tokens: [hero] });
    const b = board(view);
    b.frames.frame();
    b.spend();
    b.stops.press(node(hero, 1), hero, [hero]);
    b.frames.frame();
    assert.equal(b.sent.length, 0, "this frame's turn goes on with its spent budget");
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
