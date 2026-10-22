import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState, Token } from "#shared/model.ts";
import { findRoute, WalkWorld, WorkBudget, worldUnits } from "#shared/rules/walk.ts";
import { token } from "#shared/testutil.ts";
import type { RulerStop } from "../measure/ruler.ts";
import { measureWalk, walkJob, type WalkInput } from "../measure/walkRuler.ts";
import { routeTarget } from "./drop.ts";
import { pressPlan, worldFor } from "./press.ts";
import { RouteDrag, type Settled } from "./routeDrag.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { world } from "./testing.ts";

/**
 * Every public entry point of route work, driven through one board's work
 * on adversarial scenes (docs/design-v1-movement.md 5.2, reviews ASTRA-08,
 * ASTRA-14, MV-O-22 and MV-O-23): a drag's aims and its drop, every
 * ruler's render and its turns, and an arrow key's press. Each frame has
 * a budget of LIMIT units, counted, not timed, and no frame may do more
 * than that, past it by at most one step that cannot stop partway: a
 * world's build with its search, or one straight leg checked whole.
 */

const LIMIT = 4000;

/** Frames by hand, on a clock that moves a frame's length each frame. */
class Board implements Frames {
  t = 0;
  queue: (() => void)[] = [];
  units: number[] = [];
  readonly work = new RouteWork(
    this,
    () => new WorkBudget({ limit: LIMIT }),
    (units) => this.units.push(units),
  );
  now(): number {
    return this.t;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  /** One frame: its events, then its turn. */
  frame(events: () => void = () => {}): void {
    this.t += 16;
    events();
    this.t += 0.5;
    for (const run of this.queue.splice(0)) run();
  }
  /** Every frame's units, the last one's too. */
  all(): number[] {
    this.t += 16;
    this.work.budget();
    return this.units;
  }
}

/** The most one step that cannot stop partway charges on a 200-square scene: a Large world's build with its search, or a straight leg across the scene. */
function oneStep(view: RoomState, mover: Token): number {
  const w = new WalkWorld(worldFor(view, mover, "dm").input);
  return Math.max(worldUnits(w) + Math.ceil((w.nx * w.ny) / 400), 2 * Math.ceil(Math.hypot(w.W, w.H) / w.L));
}

function big(edges: Record<string, EdgeFeature> = {}, tokens: Token[] = [], diagonal: "five" | "euclid" = "five"): RoomState {
  const view = world({ edges, tokens });
  view.scenes.s1 = { ...view.scenes.s1!, bounds: { w: 200, h: 200 } };
  view.meta = { ...view.meta, settings: { ...view.meta.settings, diagonal } };
  return view;
}

/** A closed room far off on the scene: a stop inside it has no way through, and its search floods all it can reach. */
function closedRoom(): Record<string, EdgeFeature> {
  const edges: Record<string, EdgeFeature> = {};
  const WALL: EdgeFeature = { kind: "wall" };
  for (let k = 190; k < 194; k++) Object.assign(edges, { [`${k},190,n`]: WALL, [`${k},194,n`]: WALL, [`190,${k},w`]: WALL, [`194,${k},w`]: WALL });
  return edges;
}

const free = (x: number, y: number): RulerStop => ({ x: x + 0.5, y: y + 0.5 });

/** Rulers on the board as useWalkMeasure renders them: each render reads what is known, the live one works on what is left of the frame too, and one still searching waits its turn. */
function rulers(board: Board, inputs: WalkInput[], live = false): { render(): void; done(): boolean; runs: number[] } {
  const queued = inputs.map(() => false);
  const finished = inputs.map(() => false);
  const runs = inputs.map(() => 0);
  return {
    runs,
    render() {
      for (const [k, input] of inputs.entries()) {
        const none = WorkBudget.none();
        const m = live ? board.work.within((budget) => measureWalk({ ...input, budget })) : measureWalk({ ...input, budget: none });
        // A render that only reads does no work at all, not even a world's build past the spent budget (review ASTRA-14).
        assert.equal(none.units, 0, `ruler ${k} worked as it rendered`);
        finished[k] = m?.searching !== true;
        if (!finished[k] && !queued[k]) {
          queued[k] = true;
          const job = walkJob(input, () => {});
          board.work.add({
            run: (budget) => {
              runs[k]!++;
              return job.run(budget);
            },
          });
        }
      }
    },
    done: () => finished.every(Boolean),
  };
}

describe("route work keeps to the frame's budget on every entry point", () => {
  test("a Large creature on an empty 200 x 200 map under true distance, aimed by turns at the next square and the far side, then dropped", () => {
    const ogre = token("ogre", { size: "large", x: 2, y: 2 });
    const view = big({}, [ogre], "euclid");
    const board = new Board();
    const drag = new RouteDrag(() => worldFor(view, ogre, "dm").input, board.work);
    for (let f = 0; f < 60; f++) {
      const to = f % 2 === 0 ? { x: 3 + f / 2, y: 2 } : { x: 198, y: 100 - (f % 7) };
      board.frame(() => drag.aim(routeTarget(view, ogre, to)));
    }
    let landed: Settled | null = null;
    board.frame(() => drag.drop(routeTarget(view, ogre, { x: 198, y: 100 }), (a) => (landed = a)));
    for (let f = 0; f < 100 && !landed; f++) board.frame();
    assert.deepEqual(landed, { kind: "open" }, "open ground all the way");
    const step = oneStep(view, ogre);
    for (const [f, units] of board.all().entries()) assert.ok(units <= LIMIT + step, `frame ${f}: ${units} units, over ${LIMIT} + ${step}`);
  });

  test("40 rulers from nearby starts into a closed room all finish, each in turn, and no frame runs over", () => {
    const view = big(closedRoom());
    const board = new Board();
    const inputs = Array.from({ length: 40 }, (_, k): WalkInput => ({ view, sceneId: "s1", stops: [free(10 + (k % 8) * 2, 10 + Math.floor(k / 8) * 2), free(191, 191)], viewer: { role: "player" }, everything: false }));
    const board40 = rulers(board, inputs);
    let f = 0;
    for (; f < 20_000 && !(f > 0 && board40.done()); f++) {
      board.frame(() => board40.render());
      // The rulers' turns go round: by the time each has had a frame, none has waited.
      if (f === 45) assert.ok(board40.runs.every((n) => n > 0), `runs by frame 45: ${board40.runs.join(", ")}`);
    }
    assert.ok(board40.done(), `still searching after ${f} frames`);
    for (const input of inputs) assert.equal(measureWalk(input)!.legs[0]!.none, true);
    const step = oneStep(view, token("probe", { x: 10, y: 10 }));
    for (const [n, units] of board.all().entries()) assert.ok(units <= LIMIT + step, `frame ${n}: ${units} units, over ${LIMIT} + ${step}`);
  });

  test("a drag round a wall and an arrow key's presses, with kept rulers searching, share the frames", () => {
    const edges = { ...closedRoom() };
    for (let y = 0; y < 60; y++) edges[`10,${y},w`] = { kind: "wall" };
    const ogre = token("ogre", { size: "large", x: 2, y: 2 });
    const view = big(edges, [ogre]);
    const board = new Board();
    const inputs = Array.from({ length: 10 }, (_, k): WalkInput => ({ view, sceneId: "s1", stops: [free(30 + k * 2, 30), free(191, 191)], viewer: { role: "player" }, everything: false }));
    const kept = rulers(board, inputs);
    // And a ruler being drawn, its end moving every frame.
    const drawn = (f: number): WalkInput => ({ view, sceneId: "s1", stops: [free(5, 100), free(5 + (f % 40), 120)], viewer: { role: "player" }, everything: false });
    const drag = new RouteDrag(() => worldFor(view, ogre, "dm").input, board.work);
    let landed: Settled | null = null;
    const pressed: unknown[] = [];
    let made = 0;
    for (let f = 0; f < 400 && !(landed && kept.done()); f++) {
      board.frame(() => {
        kept.render();
        if (f < 100) rulers(board, [drawn(f)], true).render();
        if (f < 30) drag.aim(routeTarget(view, ogre, { x: 20 + (f % 10), y: 20 + f }));
        else if (f === 30) drag.drop(routeTarget(view, ogre, { x: 40, y: 40 }), (a) => (landed = a));
        // A press now and then, as a key held down repeats.
        if (f % 25 === 0 && ++made) board.work.run({ first: true, run: (budget) => (pressed.push(pressPlan(view, ogre, { x: ogre.x + 1, y: ogre.y }, [ogre], "dm", budget)), true) });
      });
    }
    const expected = findRoute(worldFor(view, ogre, "dm").input, routeTarget(view, ogre, { x: 40, y: 40 }));
    assert.ok(landed !== null && expected !== null && expected !== "none");
    assert.deepEqual((landed as Settled & { kind: "route" }).route.pieces, expected.pieces);
    assert.ok(kept.done(), "the kept rulers finished too");
    for (let f = 0; f < 100 && board.work.waiting; f++) board.frame();
    assert.equal(pressed.length, made, "every press planned and sent");
    const step = oneStep(view, ogre);
    for (const [n, units] of board.all().entries()) assert.ok(units <= LIMIT + step, `frame ${n}: ${units} units, over ${LIMIT} + ${step}`);
  });
});
