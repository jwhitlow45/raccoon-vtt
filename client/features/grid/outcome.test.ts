import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { Scene, SceneMap } from "#shared/model.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { apply, room as roomState } from "#shared/testutil.ts";
import { mapScene } from "../scenes/create.ts";
import { importScene, placeMap } from "../uvtt/batch.ts";
import type { AxisFit, GridDetection } from "./detect.ts";
import { calibrationFromBox, nudgeBox, sameCalibration } from "./calibrate.ts";
import { cameWithGrid, replacementFound, type SearchAnswer, type SearchDone, type SearchRequest, type SearchWorker, type Timers } from "./findGrid.ts";
import { applyGrid, boxAround, fallbackOps, findOnScene, gridOps, middleOf, showOutcome } from "./outcome.ts";
import { boxCalibration, endFinding, type GridToolState } from "./store.ts";
import { rng } from "./synthetic.ts";

type GridScene = Pick<Scene, "id" | "bounds" | "gridFromFile"> & { map: SceneMap };

// A 1400 x 1000 map made with today's first guess: 47 px squares from the corner.
const MAP: SceneMap = { assetId: "a1", widthPx: 1400, heightPx: 1000, cellPx: 47, originPx: { x: 0, y: 0 } };
const SCENE = { id: "s1", bounds: { w: 29, h: 21 }, map: MAP };
const FOUND = { cellPx: 70, originPx: { x: 20, y: 35 } };

function room() {
  const sent: { op: ClientOp; group: string | undefined }[] = [];
  let ids = 0;
  const actions = { dispatch: (op: ClientOp, opts?: { group?: string }) => (sent.push({ op, group: opts?.group }), sent.length), newId: () => `g${++ids}` };
  const store = createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null }));
  return { sent, actions, store };
}

describe("what a search does to the scene", () => {
  test("the ops a found grid sends: its squares, and the scene sized to them", () => {
    assert.deepEqual(gridOps(SCENE, FOUND, true), [
      { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 20, y: 35 } },
      { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 19, h: 13 } } },
    ]);
    assert.equal(gridOps(SCENE, FOUND, false).length, 1, "without fitting, the size stays");
    assert.deepEqual(gridOps({ ...SCENE, map: { ...MAP, ...FOUND }, bounds: { w: 19, h: 13 } }, FOUND, true), [], "nothing to send when it is already so");
  });

  test("high confidence applies the grid as one undo step, keeps the guess for Use default, and puts the box on the found squares", () => {
    const { sent, actions, store } = room();
    showOutcome({ actions, store, scene: SCENE, found: { tier: "high", cal: FOUND }, fit: true, at: { x: 700, y: 500 }, fallback: { cellPx: 47, originPx: { x: 0, y: 0 } } });
    assert.deepEqual(
      sent.map((s) => s.op.t),
      ["scene.setGrid", "scene.update"],
    );
    assert.ok(sent[0]!.group && sent.every((s) => s.group === sent[0]!.group), "both ops in one undo group");
    const { found, box } = store.getState();
    assert.deepEqual(box, boxAround(FOUND, { x: 700, y: 500 }));
    assert.deepEqual(box, { x: 580, y: 385, size: 210 });
    assert.deepEqual(found, { sceneId: "s1", outcome: "applied", cellPx: 70, box, cal: FOUND, fallback: { cellPx: 47, originPx: { x: 0, y: 0 }, bounds: { w: 29, h: 21 } } });
  });

  test("Use default puts back the grid and the size the scene had before the find, as one undo step", () => {
    // A 60 by 40 battle mat takes its first image, and a grid is found on it.
    const live = liveRoom();
    const mat = { ...SCENE, bounds: { w: 60, h: 40 } };
    live.elsewhere(mat);
    showOutcome({ actions: live.actions, store: live.store, scene: mat, found: { tier: "high", cal: FOUND }, fit: true, at: { x: 700, y: 500 }, fallback: { cellPx: 47, originPx: { x: 0, y: 0 } } });
    assert.deepEqual(live.scene().bounds, { w: 19, h: 13 }, "the find fits the scene to its squares");
    const fallback = live.store.getState().found?.fallback;
    assert.deepEqual(fallback, { cellPx: 47, originPx: { x: 0, y: 0 }, bounds: { w: 60, h: 40 } });
    const ops = fallbackOps(live.scene(), fallback!);
    assert.deepEqual(ops, [
      { t: "scene.setGrid", sceneId: "s1", cellPx: 47, originPx: { x: 0, y: 0 } },
      { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 60, h: 40 } } },
    ]);
    assert.deepEqual(fallbackOps(mat, fallback!), [], "nothing to send when the scene is so already");
  });

  test("a doubtful grid only places the box, for the DM to check and Apply", () => {
    const { sent, actions, store } = room();
    showOutcome({ actions, store, scene: SCENE, found: { tier: "medium", cal: FOUND }, fit: true, at: { x: 700, y: 500 } });
    assert.deepEqual(sent, []);
    assert.equal(store.getState().found?.outcome, "offered");
    assert.deepEqual(store.getState().box, { x: 580, y: 385, size: 210 });
  });

  test("the box a search left stands for the grid it measured, until it moves", () => {
    const { actions, store } = room();
    // 6 px in: a box the DM drew there would snap to the edge.
    const measured = { cellPx: 140, originPx: { x: 6, y: 6 } };
    showOutcome({ actions, store, scene: SCENE, found: { tier: "medium", cal: measured }, fit: true, at: { x: 700, y: 500 } });
    const { found, box } = store.getState();
    assert.ok(box);
    assert.deepEqual(boxCalibration(box, found, "s1"), measured, "Apply and the drawn lines take the find as measured");
    assert.deepEqual(calibrationFromBox(box).originPx, { x: 0, y: 0 }, "the hand-drawn box's snap would have moved it");
    assert.deepEqual(boxCalibration(box, found, "s2"), calibrationFromBox(box), "another scene's note says nothing");
    const moved = nudgeBox(box, 1, 0);
    assert.deepEqual(boxCalibration(moved, found, "s1"), calibrationFromBox(moved), "a box the DM moved is theirs");
  });

  test("a found box goes to the middle of the box there is, or of the map when that is off the image", () => {
    assert.deepEqual(middleOf({ x: 100, y: 200, size: 141 }, MAP), { x: 170.5, y: 270.5 });
    assert.deepEqual(middleOf(null, MAP), { x: 700, y: 500 });
    assert.deepEqual(middleOf({ x: 1500, y: 200, size: 141 }, MAP), { x: 700, y: 500 }, "a box left from another scene's view");
  });

  test("no grid found says so and leaves the box where it was", () => {
    const { sent, actions, store } = room();
    const before = { x: 10, y: 10, size: 141 };
    store.setState({ box: before });
    showOutcome({ actions, store, scene: SCENE, found: null, fit: true, at: { x: 700, y: 500 } });
    assert.deepEqual(sent, []);
    assert.deepEqual(store.getState().found, { sceneId: "s1", outcome: "none", cellPx: 0, box: before });
    assert.equal(store.getState().box, before);
  });
});

class AnsweringWorker implements SearchWorker {
  onmessage: ((e: { data: SearchAnswer }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: SearchRequest[] = [];
  postMessage(message: SearchRequest): void {
    this.posted.push(message);
  }
  terminate(): void {}
  answer(a: SearchAnswer): void {
    this.onmessage?.({ data: a });
  }
}

const AXIS = { found: 20, expected: 20, from: 0, to: 0, snr: 50, between: 0, parity: 1, rms: 0.1 };
const DETECTED: GridDetection = {
  found: true,
  cellPx: 35,
  originPx: { x: 10, y: 17.5 },
  confidence: 0.95,
  polarity: "dark",
  across: { ...AXIS, period: 35, phase: 10, continuity: 1, restart: 0, coverage: 1, drift: 0 } as AxisFit & { continuity: number; restart: number; coverage: number; drift: number },
  down: { ...AXIS, period: 35, phase: 17.5, continuity: 1, restart: 0, coverage: 1, drift: 0 } as AxisFit & { continuity: number; restart: number; coverage: number; drift: number },
};

describe("Find the grid", () => {
  test("searches the scene's map, phone copy first, and applies what it finds as one undo step", async () => {
    const { sent, actions, store } = room();
    const worker = new AnsweringWorker();
    const running = findOnScene({ actions, store, sceneId: "s1", scene: () => SCENE, urls: ["/m/mobile", "/m/full"], makeWorker: () => worker });
    assert.deepEqual(worker.posted, [{ urls: ["/m/mobile", "/m/full"] }]);
    assert.equal(store.getState().finding?.sceneId, "s1", "the options line says it is looking");
    // Decoded at half size: 35 px there is 70 px on the map.
    worker.answer({ t: "done", result: DETECTED, width: 700, height: 500 });
    await running;
    assert.equal(store.getState().finding, null);
    assert.deepEqual(sent[0]?.op, { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 20, y: 35 } });
    assert.ok(sent.every((s) => s.group === sent[0]!.group));
    assert.equal(store.getState().found?.outcome, "applied");
    assert.equal(store.getState().found?.fallback, undefined, "after Find the grid, Undo puts the grid back");
  });

  test("on a Universal VTT scene, a sure find only places the box, and the note says the scene came with its own grid", async () => {
    const { sent, actions, store } = room();
    const worker = new AnsweringWorker();
    // The file's grid: 70.5 px squares, the first whole one starting before the image.
    const uvtt = { ...SCENE, gridFromFile: true as const, map: { ...MAP, cellPx: 70.5, originPx: { x: -50, y: -35 } } };
    const running = findOnScene({ actions, store, sceneId: "s1", scene: () => uvtt, urls: ["/m"], makeWorker: () => worker });
    worker.answer({ t: "done", result: DETECTED, width: 700, height: 500 });
    await running;
    assert.deepEqual(sent, [], "nothing applied");
    const { found, box } = store.getState();
    assert.deepEqual(box, { x: 580, y: 385, size: 210 }, "the box on the found squares in the middle");
    assert.deepEqual(found, { sceneId: "s1", outcome: "offered", cellPx: 70, box, cal: { cellPx: 70, originPx: { x: 20, y: 35 } }, ownGrid: true });
  });

  test("the found origin stays where its lines are, at or inside the image's corner", async () => {
    const { sent, actions, store } = room();
    const worker = new AnsweringWorker();
    const running = findOnScene({ actions, store, sceneId: "s1", scene: () => SCENE, urls: ["/m"], makeWorker: () => worker });
    // Lines 65 px in, nearer the corner's square than the next one.
    worker.answer({ t: "done", result: { ...DETECTED, originPx: { x: 32.5, y: 30 } }, width: 700, height: 500 });
    await running;
    assert.deepEqual(sent[0]?.op, { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 65, y: 60 } });
  });

  test("a second press while one search runs starts nothing", async () => {
    const { actions, store } = room();
    let made = 0;
    const worker = new AnsweringWorker();
    const make = () => (made++, worker);
    const first = findOnScene({ actions, store, sceneId: "s1", scene: () => SCENE, urls: ["/m"], makeWorker: make });
    await findOnScene({ actions, store, sceneId: "s1", scene: () => SCENE, urls: ["/m"], makeWorker: make });
    assert.equal(made, 1);
    worker.answer({ t: "error" });
    await first;
    assert.equal(store.getState().found?.outcome, "none");
  });

  test("an answer for a map the scene no longer shows is dropped", async () => {
    const { sent, actions, store } = room();
    const worker = new AnsweringWorker();
    let scene = SCENE;
    const running = findOnScene({ actions, store, sceneId: "s1", scene: () => scene, urls: ["/m"], makeWorker: () => worker });
    scene = { ...SCENE, map: { ...MAP, assetId: "a2" } };
    worker.answer({ t: "done", result: DETECTED, width: 700, height: 500 });
    await running;
    assert.deepEqual(sent, []);
    assert.equal(store.getState().found, null);
  });

  test("a search the tool cancelled applies nothing when it answers", async () => {
    const { sent, actions, store } = room();
    const worker = new AnsweringWorker();
    const running = findOnScene({ actions, store, sceneId: "s1", scene: () => SCENE, urls: ["/m"], makeWorker: () => worker });
    // What the tool's deactivate does.
    store.getState().finding?.cancel();
    store.setState({ finding: null });
    worker.answer({ t: "done", result: DETECTED, width: 700, height: 500 });
    await running;
    assert.deepEqual(sent, []);
    assert.equal(store.getState().found, null);
  });
});

/** A Worker that answers when told to, and counts how often it is ended. */
class CountingWorker extends AnsweringWorker {
  terminated = 0;
  override terminate(): void {
    this.terminated++;
  }
  fail(): void {
    this.onerror?.(new Error("crashed"));
  }
}

type LiveScene = typeof SCENE;

/** A scene the ops sent change, as the room would, and the tool's store. */
function liveRoom() {
  let scene: LiveScene = SCENE;
  const sent: { op: ClientOp; group: string | undefined }[] = [];
  let ids = 0;
  const actions = {
    dispatch(op: ClientOp, opts?: { group?: string }) {
      sent.push({ op, group: opts?.group });
      if (op.t === "scene.setGrid") scene = { ...scene, map: { ...scene.map, cellPx: op.cellPx, originPx: op.originPx } };
      else if (op.t === "scene.update" && op.patch.bounds) scene = { ...scene, bounds: op.patch.bounds };
      return sent.length;
    },
    newId: () => `g${++ids}`,
  };
  const store = createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null }));
  return {
    sent,
    actions,
    store,
    scene: () => scene,
    /** A change made on another DM device, which reaches this one without any op of its own. */
    elsewhere: (next: LiveScene) => (scene = next),
  };
}

function fakeTimers(): Timers & { fire(): void; pending(): number } {
  let next = 1;
  const due = new Map<number, () => void>();
  return {
    set(fn) {
      const handle = next++;
      due.set(handle, fn);
      return handle;
    },
    clear(handle) {
      due.delete(handle as number);
    },
    fire() {
      for (const [handle, fn] of [...due]) {
        due.delete(handle);
        fn();
      }
    },
    pending: () => due.size,
  };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));
const SURE: SearchAnswer = { t: "done", result: DETECTED, width: 700, height: 500 };
const DOUBTFUL: SearchAnswer = { t: "done", result: { ...DETECTED, confidence: 0.45 }, width: 700, height: 500 };
const NOTHING: SearchAnswer = { t: "done", result: { found: false, reason: "none" }, width: 700, height: 500 };

describe("a search the DM works around", () => {
  test("a 70 px answer that comes after an 80 px Apply changes nothing", async () => {
    const live = liveRoom();
    const worker = new CountingWorker();
    const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker });
    const box = { x: 0, y: 0, size: 240 };
    live.store.setState({ box });
    applyGrid({ actions: live.actions, store: live.store, sceneId: "s1", cal: { cellPx: 80, originPx: { x: 0, y: 0 } }, bounds: null });
    assert.equal(live.store.getState().finding, null, "Apply ended the search");
    assert.equal(worker.terminated, 1);
    worker.answer(SURE);
    await running;
    assert.deepEqual(
      live.sent.map((s) => s.op),
      [{ t: "scene.setGrid", sceneId: "s1", cellPx: 80, originPx: { x: 0, y: 0 } }],
    );
    assert.equal(live.scene().map.cellPx, 80);
    assert.equal(live.store.getState().found, null);
    assert.equal(live.store.getState().box, box, "the box stays where the DM put it");
  });

  test("a drag of the box ends the search, and its answer leaves the box where the DM put it", async () => {
    const live = liveRoom();
    const worker = new CountingWorker();
    const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker });
    // What the tool's drag does.
    endFinding(live.store, "s1");
    const dragged = { x: 300, y: 300, size: 150 };
    live.store.setState({ box: dragged });
    worker.answer(SURE);
    await running;
    assert.deepEqual(live.sent, []);
    assert.equal(live.store.getState().box, dragged);
    assert.equal(worker.terminated, 1);
  });

  test("an answer that comes after the grid or the size changed on another device is dropped", async () => {
    const changes: ((s: LiveScene) => LiveScene)[] = [
      (s) => ({ ...s, map: { ...s.map, cellPx: 80 } }),
      (s) => ({ ...s, map: { ...s.map, originPx: { x: 12, y: 0 } } }),
      (s) => ({ ...s, bounds: { w: 40, h: 30 } }),
    ];
    for (const change of changes) {
      const live = liveRoom();
      const worker = new CountingWorker();
      const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker });
      live.elsewhere(change(live.scene()));
      const before = live.scene();
      worker.answer(SURE);
      await running;
      assert.deepEqual(live.sent, []);
      assert.equal(live.scene(), before);
      assert.equal(live.store.getState().found, null);
      assert.equal(live.store.getState().finding, null, "the search is over, so Find the grid can run again");
    }
  });

  /**
   * Random runs of what can happen around Find the grid: presses of Find,
   * the Worker's answers (sure, doubtful, no grid) and failures, answers
   * from searches already ended, Apply, drags of the box, the tool
   * closing, the deadline, and the grid or the size changed on another
   * device. Invariants, after every event of every run:
   * - At most one search runs, and `finding` is set exactly while one does.
   * - A search's answer changes the scene, the note or the box only when it
   *   comes while that search still runs and the scene shows the image,
   *   grid and size it began with. So never after Apply, a drag, a close,
   *   the deadline or a change made elsewhere: what the DM did by hand is
   *   replaced only by a search begun after it.
   * - An answer that applies sends one undo group at most, and nothing but
   *   Apply and such an answer sends an op.
   * - A search's Worker is ended exactly once, when the search ends, and no
   *   deadline timer outlives its search.
   */
  test("random searches, Applies, drags, closes, deadlines and late answers keep every invariant", async () => {
    const next = rng(20261019);
    const kinds = ["find", "sure", "doubtful", "nothing", "fail", "late", "apply", "drag", "close", "deadline", "elsewhere"] as const;
    const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(next() * list.length)];
    for (let run = 0; run < 400; run++) {
      const live = liveRoom();
      const timers = fakeTimers();
      const workers: CountingWorker[] = [];
      const ended: CountingWorker[] = [];
      // The search the model expects to run, and whether the scene has changed elsewhere since it began.
      let running: { worker: CountingWorker; stale: boolean } | null = null;
      const end = () => {
        if (running) ended.push(running.worker);
        running = null;
      };
      const events: string[] = [];
      const steps = 1 + Math.floor(next() * 12);
      for (let step = 0; step < steps; step++) {
        const kind = pick(kinds)!;
        events.push(kind);
        const label = `run ${run}: ${events.join(", ")}`;
        const sentBefore = live.sent.length;
        const before = live.store.getState();
        /** What this event's answer may leave: a note of this outcome, or nothing. */
        let lands: "applied" | "offered" | "none" | null = null;
        let applied = false;
        if (kind === "find") {
          const made = workers.length;
          void findOnScene({
            actions: live.actions,
            store: live.store,
            sceneId: "s1",
            scene: live.scene,
            urls: ["/m"],
            makeWorker: () => {
              const w = new CountingWorker();
              workers.push(w);
              return w;
            },
            timers,
          });
          if (running) assert.equal(workers.length, made, `${label}: a second press started nothing`);
          else {
            assert.equal(workers.length, made + 1, label);
            running = { worker: workers[made]!, stale: false };
          }
        } else if (kind === "sure" || kind === "doubtful" || kind === "nothing" || kind === "fail" || kind === "deadline") {
          if (running) {
            if (kind === "fail") running.worker.fail();
            else if (kind === "deadline") timers.fire();
            else running.worker.answer(kind === "sure" ? SURE : kind === "doubtful" ? DOUBTFUL : NOTHING);
            if (!running.stale) lands = kind === "sure" ? "applied" : kind === "doubtful" ? "offered" : "none";
            end();
          }
        } else if (kind === "late") {
          pick(ended)?.answer(SURE);
        } else if (kind === "apply") {
          const cal = { cellPx: 80 + Math.floor(next() * 4), originPx: { x: 0, y: 0 } };
          const change = !sameCalibration(cal, live.scene().map);
          applyGrid({ actions: live.actions, store: live.store, sceneId: "s1", cal: change ? cal : null, bounds: null });
          applied = change;
          end();
        } else if (kind === "drag") {
          endFinding(live.store, "s1");
          live.store.setState({ box: { x: Math.floor(next() * 500), y: 10, size: 240 } });
          end();
        } else if (kind === "close") {
          // What the tool's deactivate does.
          const { finding } = live.store.getState();
          finding?.cancel();
          live.store.setState({ finding: null });
          end();
        } else {
          // Each change moves on from the last, so the scene never comes back to how a search found it.
          const s = live.scene();
          const which = Math.floor(next() * 3);
          live.elsewhere(
            which === 0
              ? { ...s, map: { ...s.map, cellPx: s.map.cellPx + 3 } }
              : which === 1
                ? { ...s, bounds: { w: s.bounds.w + 1, h: s.bounds.h } }
                : { ...s, map: { ...s.map, assetId: `${s.map.assetId}+` } },
          );
          if (running) running.stale = true;
        }
        await settled();

        const after = live.store.getState();
        assert.equal(after.finding !== null, running !== null, `${label}: finding is set exactly while a search runs`);
        assert.equal(workers.filter((w) => w.terminated === 0).length, running ? 1 : 0, `${label}: only the running search's Worker is alive`);
        assert.ok(
          workers.every((w) => w.terminated <= 1),
          `${label}: no Worker is ended twice`,
        );
        assert.equal(timers.pending(), running ? 1 : 0, `${label}: only the running search has a deadline`);
        const sent = live.sent.slice(sentBefore);
        if (lands) {
          assert.equal(after.found?.outcome, lands, label);
          assert.ok(sent.length <= 2 && sent.every((s) => s.group !== undefined && s.group === sent[0]!.group), `${label}: one undo group`);
          if (lands === "applied") assert.ok(sameCalibration(live.scene().map, { cellPx: 70, originPx: { x: 20, y: 35 } }), `${label}: the found grid is on`);
          else assert.equal(sent.length, 0, label);
        } else {
          assert.equal(sent.length, applied ? 1 : 0, `${label}: only Apply sent anything`);
          if (kind === "find") assert.equal(after.found, running ? null : before.found, label);
          else assert.equal(after.found, before.found, `${label}: the note is the one before`);
          if (kind !== "drag") assert.equal(after.box, before.box, `${label}: the box is the one before`);
        }
      }
      if (running) {
        endFinding(live.store, "s1");
        end();
        await settled();
      }
      assert.equal(timers.pending(), 0, `run ${run}: no timer left`);
      assert.ok(
        workers.every((w) => w.terminated === 1),
        `run ${run}: every Worker ended once`,
      );
    }
  });
});

describe("where a scene came from", () => {
  /** A scene made and changed by the room's own reducer, as the room would hold it. */
  function held(ops: Op[]): GridScene {
    let state = roomState();
    for (const op of ops) state = apply(state, op);
    const made = Object.values(state.scenes).find((s) => s.id === "made");
    assert.ok(made?.map);
    return { ...made, map: made.map };
  }

  async function find(scene: GridScene) {
    const live = { sent: [] as ClientOp[], store: createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null })) };
    const actions = { dispatch: (op: ClientOp) => live.sent.push(op), newId: () => "g1" };
    const worker = new AnsweringWorker();
    const running = findOnScene({ actions, store: live.store, sceneId: "made", scene: () => scene, urls: ["/m"], makeWorker: () => worker });
    // Decoded at half the map's size, as a phone copy is.
    worker.answer({ t: "done", result: DETECTED, width: scene.map.widthPx / 2, height: scene.map.heightPx / 2 });
    await running;
    return { sent: live.sent, found: live.store.getState().found };
  }

  test("a Universal VTT scene keeps its protection after Automatic walls goes from Off to Floor", async () => {
    // A file's 20 by 14 squares of 70 px from the image's corner, as the import places them.
    const plan = { frame: { shift: { x: 0, y: 0 }, image: { x: 0, y: 0 }, w: 20, h: 14 }, pixelsPerGrid: 70 };
    const map = placeMap(plan, { assetId: "a1", width: 1400, height: 1000, fileImageWidth: 1400 });
    assert.ok(map);
    const scene = held([
      { t: "scene.create", scene: importScene(plan, map, { id: "made", name: "Crypt", fog: true }) },
      { t: "scene.update", sceneId: "made", patch: { autoWalls: "floor" } },
    ]);
    assert.equal(scene.gridFromFile, true);
    assert.equal(cameWithGrid(scene), true);
    const { sent, found } = await find(scene);
    assert.deepEqual(sent, [], "a sure find is only offered");
    assert.equal(found?.outcome, "offered");
    assert.equal(found?.ownGrid, true);
  });

  test("new art on a Universal VTT scene keeps its mark, and a sure find on it is only offered, as Find the grid's", () => {
    const plan = { frame: { shift: { x: 0, y: 0 }, image: { x: 0, y: 0 }, w: 20, h: 14 }, pixelsPerGrid: 70 };
    const map = placeMap(plan, { assetId: "a1", width: 1400, height: 1000, fileImageWidth: 1400 });
    assert.ok(map);
    const before = held([{ t: "scene.create", scene: importScene(plan, map, { id: "made", name: "Crypt", fog: true }) }]);
    // Other art, of another shape, with today's first guess, as Scene settings sends it.
    const next = { assetId: "a2", widthPx: 1400, heightPx: 1400, cellPx: 47, originPx: { x: 0, y: 0 } };
    const after = held([
      { t: "scene.create", scene: importScene(plan, map, { id: "made", name: "Crypt", fog: true }) },
      { t: "scene.setMap", sceneId: "made", map: next },
    ]);
    assert.equal(after.gridFromFile, true, "the imported walls stay, and so does the mark");
    const sure: SearchDone = { t: "done", result: DETECTED, width: 700, height: 700 };
    const { found, ownGrid } = replacementFound(sure, false, next, before);
    assert.equal(ownGrid, true);
    assert.equal(found?.tier, "medium");
    const { sent, actions, store } = room();
    showOutcome({ actions, store, scene: after, found, fit: true, at: { x: 700, y: 700 }, fallback: next, ownGrid });
    assert.deepEqual(sent, [], "nothing applied");
    assert.equal(store.getState().found?.outcome, "offered");
    assert.equal(store.getState().found?.ownGrid, true);
  });

  test("new art elsewhere is applied when sure, and an import from before the mark is known by its first line", () => {
    const sure: SearchDone = { t: "done", result: DETECTED, width: 700, height: 500 };
    const next = { widthPx: 1400, heightPx: 1000 };
    assert.deepEqual(replacementFound(sure, false, next, { map: { originPx: { x: 0, y: 0 } } }).found?.tier, "high");
    assert.deepEqual(replacementFound(sure, false, next, {}).ownGrid, false, "a first image on a mat");
    assert.deepEqual(replacementFound(sure, false, next, { map: { originPx: { x: -35, y: 0 } } }), { found: { tier: "medium", cal: { cellPx: 70, originPx: { x: 20, y: 35 } } }, ownGrid: true });
    assert.equal(replacementFound(sure, true, next, { gridFromFile: true }).found, null, "a size in the name still wins");
  });

  test("an ordinary map with automatic walls off is searched and applied as usual", async () => {
    const { scene: input } = mapScene({ id: "made", name: "Tavern", asset: { id: "a1", width: 1400, height: 1000 } });
    const scene = held([
      { t: "scene.create", scene: input },
      { t: "scene.update", sceneId: "made", patch: { autoWalls: "off" } },
    ]);
    assert.equal(scene.gridFromFile, undefined);
    assert.equal(cameWithGrid(scene), false);
    const { sent, found } = await find(scene);
    assert.deepEqual(sent[0], { t: "scene.setGrid", sceneId: "made", cellPx: 70, originPx: { x: 20, y: 35 } });
    assert.equal(found?.outcome, "applied");
  });
});
