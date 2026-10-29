import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { Scene, SceneMap } from "#shared/model.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { apply, room as roomState } from "#shared/testutil.ts";
import { mapScene } from "../scenes/create.ts";
import { importScene, placeMap } from "../uvtt/batch.ts";
import type { AxisFit, GridDetection } from "./detect.ts";
import { gridOfShape, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { boxAt, boxSides, calibrationFromBox, calibrationFromHexFind, canonicalToWorld, fitBounds, nudgeBox, sameCalibration, type CalBox } from "./calibrate.ts";
import { cameWithGrid, IMPORT_WAIT_MS, importSearch, importSearchFrom, replacementFound, type ImportWait, type SearchAnswer, type SearchDone, type SearchRequest, type SearchWorker, type Timers } from "./findGrid.ts";
import { applyGrid, boxAround, fallbackOps, FIND_TIMEOUT_MS, findOnScene, foundLine, gridOps, landSearch, middleOf, putBack, showOutcome } from "./outcome.ts";
import type { HexDetection } from "./detectHex.ts";
import { boxCalibration, endFinding, noteFor, shapeChanged, type GridToolState } from "./store.ts";
import { rng } from "./synthetic.ts";

type GridScene = Pick<Scene, "id" | "bounds" | "gridFromFile" | "gridShape"> & { map: SceneMap };

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
    assert.deepEqual(boxCalibration(box, found, "s1", SQUARES), measured, "Apply and the drawn lines take the find as measured");
    assert.deepEqual(calibrationFromBox(box).originPx, { x: 0, y: 0 }, "the hand-drawn box's snap would have moved it");
    assert.deepEqual(boxCalibration(box, found, "s2", SQUARES), calibrationFromBox(box), "another scene's note says nothing");
    const moved = nudgeBox(box, 1, 0);
    assert.deepEqual(boxCalibration(moved, found, "s1", SQUARES), calibrationFromBox(moved), "a box the DM moved is theirs");
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

  test("an answer for a map the scene no longer shows is dropped, and the line says the scene changed", async () => {
    const { sent, actions, store } = room();
    const worker = new AnsweringWorker();
    let scene = SCENE;
    const box = { x: 0, y: 0, size: 141 };
    store.setState({ box });
    const running = findOnScene({ actions, store, sceneId: "s1", scene: () => scene, urls: ["/m"], makeWorker: () => worker });
    scene = { ...SCENE, map: { ...MAP, assetId: "a2" } };
    worker.answer({ t: "done", result: DETECTED, width: 700, height: 500 });
    await running;
    assert.deepEqual(sent, []);
    assert.deepEqual(store.getState().found, { sceneId: "s1", outcome: "changed", cellPx: 0, box });
    assert.equal(store.getState().box, box, "the box stays where it was");
  });

  test("a search that found no grid on the image before says nothing of the new one", async () => {
    for (const answer of [{ t: "done", result: { found: false, reason: "none" }, width: 700, height: 500 }, { t: "error" }] as const) {
      const { sent, actions, store } = room();
      const worker = new AnsweringWorker();
      let scene = SCENE;
      const running = findOnScene({ actions, store, sceneId: "s1", scene: () => scene, urls: ["/m"], makeWorker: () => worker });
      scene = { ...SCENE, map: { ...MAP, assetId: "a2" } };
      worker.answer(answer);
      await running;
      assert.deepEqual(sent, []);
      assert.equal(store.getState().found, null, answer.t);
    }
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

type LiveScene = GridScene;

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
      else if (op.t === "scene.update" && op.patch.gridShape) {
        const { gridShape: _, ...rest } = scene;
        scene = op.patch.gridShape === "squares" ? rest : { ...rest, gridShape: op.patch.gridShape };
      }
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

  test("an answer that comes after the grid or the size changed on another device is dropped, which the line says", async () => {
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
      assert.equal(live.store.getState().found?.outcome, "changed");
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
   *   replaced only by a search begun after it. The one exception is the
   *   note: a grid found while the search still runs, on a scene changed
   *   elsewhere, leaves the note that says so, and changes nothing else.
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
        let lands: "applied" | "offered" | "none" | "changed" | null = null;
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
            else if (kind === "sure" || kind === "doubtful") lands = "changed";
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
          if (lands === "changed") assert.equal(after.box, before.box, `${label}: the box is the one before`);
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

/*
 * A search measured the scene's cells as they were when it began, so one
 * begun on squares never lands on the scene once it is on hexes, whether
 * Grid shape changed on this device or another, and a square grid found
 * before the switch stands for nothing after it.
 */
describe("a switch to hexes", () => {
  const HEX_ROWS = gridOfShape("hexRows");

  test("a square search still running when Grid shape here switches to hex rows ends at once and applies nothing", async () => {
    const live = liveRoom();
    const worker = new CountingWorker();
    const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker });
    live.store.setState({ sceneId: "s1", box: { x: 0, y: 0, size: 210 } });
    // What scene settings' Grid shape does, then the room's copy of the scene it sent.
    shapeChanged(live.store, "s1");
    live.elsewhere({ ...live.scene(), gridShape: "hexRows" });
    assert.equal(live.store.getState().finding, null, "the search ended with the switch");
    assert.equal(worker.terminated, 1);
    worker.answer(SURE);
    await running;
    assert.deepEqual(live.sent, []);
    assert.equal(live.store.getState().found, null);
    assert.equal(live.store.getState().box, null, "the square box went, so the tool opens on a box over hexes");
  });

  test("a square search still running when another device switches the scene to hex rows applies nothing", async () => {
    for (const answer of [SURE, DOUBTFUL]) {
      const live = liveRoom();
      const worker = new CountingWorker();
      const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker });
      const box = { x: 0, y: 0, size: 210 };
      live.store.setState({ box });
      live.elsewhere({ ...live.scene(), gridShape: "hexRows" });
      const before = live.scene();
      worker.answer(answer);
      await running;
      assert.deepEqual(live.sent, []);
      assert.equal(live.scene(), before);
      assert.equal(live.store.getState().box, box, "the box stays where it was");
      assert.equal(live.store.getState().found?.outcome, "changed", "the line says the scene changed, and keeps no square grid");
      assert.equal(noteFor(live.store.getState().found, "s1", HEX_ROWS)?.outcome, "changed", "which the hexes' options line still says");
      assert.equal(live.store.getState().finding, null);
    }
  });

  test("a square grid found before the switch is not reused after it, from this device or another", () => {
    const measured = { cellPx: 140, originPx: { x: 6, y: 6 } };
    const offered = () => {
      const r = room();
      showOutcome({ actions: r.actions, store: r.store, scene: SCENE, found: { tier: "medium", cal: measured }, fit: true, at: { x: 700, y: 500 } });
      r.store.setState({ sceneId: "s1" });
      return r;
    };
    // Another device's switch: the note stays in this one's store, but stands for nothing on hexes.
    const remote = offered();
    const { found, box } = remote.store.getState();
    assert.ok(box);
    assert.deepEqual(boxCalibration(box, found, "s1", SQUARES), measured);
    assert.deepEqual(boxCalibration(box, found, "s1", HEX_ROWS), calibrationFromBox(box, HEX_ROWS));
    // This device's: the note and its box go.
    const local = offered();
    shapeChanged(local.store, "s1");
    assert.equal(local.store.getState().found, null);
    assert.equal(local.store.getState().box, null);
    // Another scene's note and box are not this switch's.
    const other = offered();
    shapeChanged(other.store, "s2");
    assert.deepEqual(other.store.getState().found?.cal, measured);
    assert.ok(other.store.getState().box);
  });

  test("an upload's search of the copy that lands after a switch to hex rows, here or elsewhere, applies nothing", async () => {
    for (const where of ["here", "elsewhere"] as const) {
      const live = liveRoom();
      const timers = fakeTimers();
      const worker = new CountingWorker();
      const search = importSearch(new Blob(["x"]), "phone", { makeWorker: () => worker, timers, size: async () => null });
      const waiting = search.afterUpload(["/m/mobile"], IMPORT_WAIT_MS);
      await settled();
      timers.fire();
      const { later } = await waiting;
      assert.ok(later);
      const guess = { cellPx: 47, originPx: { x: 0, y: 0 } };
      const landing = landSearch({ actions: live.actions, store: live.store, sceneId: "s1", start: live.scene(), scene: live.scene, search: later, ms: FIND_TIMEOUT_MS, timers, fit: true, fallback: guess });
      if (where === "here") shapeChanged(live.store, "s1");
      live.elsewhere({ ...live.scene(), gridShape: "hexRows" });
      worker.answer(SURE);
      await landing;
      assert.deepEqual(live.sent, [], where);
      assert.equal(live.store.getState().found?.cal, undefined, where);
      if (where === "elsewhere") assert.equal(live.store.getState().found?.outcome, "changed");
      assert.equal(live.store.getState().finding, null, where);
    }
  });

  test("Line up grid already open keeps a box through a switch, over the new cells at the same spot, each way", () => {
    const HEX_COLUMNS = gridOfShape("hexColumns");
    for (const [from, to] of [[SQUARES, HEX_ROWS], [HEX_ROWS, SQUARES], [HEX_ROWS, HEX_COLUMNS]] as const) {
      const store = createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: "s1", found: null, finding: null }));
      const before = boxAt(MAP, from, { x: 12.2, y: 8.7 });
      store.setState({ box: before });
      shapeChanged(store, "s1", { map: MAP, from, to });
      const after = store.getState().box;
      assert.ok(after, "Apply, Nudge and Find stay, since the open tool is not opened again");
      const mid = (b: CalBox, g: Grid) => ({ x: b.x + boxSides(b, g).w / 2, y: b.y + boxSides(b, g).h / 2 });
      assert.deepEqual(boxAt(MAP, to, canonicalToWorld(MAP, mid(after, to))), after, "a box of the new cells, as a tap there would make");
      assert.ok(Math.hypot(mid(after, to).x - mid(before, from).x, mid(after, to).y - mid(before, from).y) <= MAP.cellPx, "where the old one was, within a cell");
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
      { t: "scene.create", scene: importScene(plan, map, { id: "made", name: "Crypt" }) },
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
    const before = held([{ t: "scene.create", scene: importScene(plan, map, { id: "made", name: "Crypt" }) }]);
    // Other art, of another shape, with today's first guess, as Scene settings sends it.
    const next = { assetId: "a2", widthPx: 1400, heightPx: 1400, cellPx: 47, originPx: { x: 0, y: 0 } };
    const after = held([
      { t: "scene.create", scene: importScene(plan, map, { id: "made", name: "Crypt" }) },
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

/** A header read the test lets finish when it chooses. */
function heldSize() {
  let answer!: (size: { width: number; height: number } | null) => void;
  const read = new Promise<{ width: number; height: number } | null>((resolve) => (answer = resolve));
  return { size: () => read, answer };
}

describe("an import's search, and the phone copy's that lands after the scene opens", () => {
  test("a search of the copy that outlives the wait lands on the scene the import made, with Use default", async () => {
    const live = liveRoom();
    const timers = fakeTimers();
    const worker = new CountingWorker();
    const search = importSearch(new Blob(["x"]), "phone", { makeWorker: () => worker, timers, size: async () => null });
    const waiting = search.afterUpload(["/m/mobile"], IMPORT_WAIT_MS);
    await settled();
    timers.fire();
    const { answer, later } = await waiting;
    assert.equal(answer, null);
    assert.ok(later);
    const guess = { cellPx: 47, originPx: { x: 0, y: 0 } };
    const landing = landSearch({ actions: live.actions, store: live.store, sceneId: "s1", start: live.scene(), scene: live.scene, search: later, ms: FIND_TIMEOUT_MS, timers, fit: true, fallback: guess });
    assert.equal(live.store.getState().finding?.sceneId, "s1", "Line up grid says it is looking");
    worker.answer(SURE);
    await landing;
    assert.deepEqual(
      live.sent.map((s) => s.op.t),
      ["scene.setGrid", "scene.update"],
    );
    assert.ok(live.sent.every((s) => s.group !== undefined && s.group === live.sent[0]!.group), "one undo step");
    const found = live.store.getState().found;
    assert.equal(found?.outcome, "applied");
    assert.deepEqual(found?.fallback, { ...guess, bounds: { w: 29, h: 21 } });
  });

  /**
   * Random runs of an import's search on every device and file size, and
   * of the landing of a phone copy's search that outlives the wait: the
   * header read finishing, the upload answering, the Worker answering
   * (sure, doubtful, no grid) or failing, a cancel (the page's before the
   * wait ends, the tool closing after), the deadlines (the import's 2 s, the
   * landing's 30 s), Apply, a drag, and the scene changed on another device,
   * in any order. Invariants, after every event of every run:
   * - A phone or an iPad never gives the Worker a file over the decode's
   *   size or of no known size, and an import makes one Worker at most,
   *   none after a cancel.
   * - The wait ends with exactly the model's answer, once. It hands on a
   *   running search only on the copy's path, at the deadline, with
   *   nothing else having ended it.
   * - `finding` is set exactly while a handed-on search runs. Such a search
   *   lands only when it answers while it still runs and the scene is as
   *   it was when it opened: a sure find as one undo step with the note
   *   and Use default, a doubtful one offered, none said. After a close,
   *   Apply, a drag or its deadline it changes nothing. After a change
   *   elsewhere, a grid it still finds leaves only the note that says the
   *   scene changed.
   * - Nothing but Apply and such a landing sends an op.
   * - Exactly the running search's Worker is alive, each Worker is ended
   *   once by the run's end, and only a running wait or landing has a
   *   timer.
   */
  test("random header reads, uploads, answers, cancels, deadlines, Applies, drags and changes elsewhere keep every invariant", async () => {
    const next = rng(20261021);
    const devices = ["computer", "phone", "iPad"] as const;
    const sizes = [{ width: 3000, height: 2000 }, { width: 8000, height: 3000 }, null];
    // Weighted so that most runs on the copy's path reach a landing, and then go on to what can befall it.
    const kinds = [
      ["header", 2],
      ["upload", 2],
      ["sure", 1],
      ["doubtful", 0.5],
      ["nothing", 0.5],
      ["fail", 0.5],
      ["cancel", 0.6],
      ["deadline", 2.5],
      ["apply", 0.8],
      ["drag", 0.8],
      ["elsewhere", 0.8],
    ] as const;
    // Once a landing runs, its 30 s deadline comes rarely, so its answers get their turn.
    const pickKind = (landing: boolean) => {
      const weight = (kind: string, w: number) => (landing && kind === "deadline" ? 0.4 : w);
      let r = next() * kinds.reduce((sum, [kind, w]) => sum + weight(kind, w), 0);
      for (const [kind, w] of kinds) if ((r -= weight(kind, w)) < 0) return kind;
      return kinds[0][0];
    };
    const guess = { cellPx: 47, originPx: { x: 0, y: 0 } };
    for (let run = 0; run < 800; run++) {
      // Half the runs take the copy's path, the rest any device and size.
      const copyRun = next() < 0.5;
      const device = copyRun ? (next() < 0.5 ? "phone" : "iPad") : devices[Math.floor(next() * devices.length)]!;
      const size = copyRun ? (next() < 0.5 ? sizes[1]! : null) : sizes[Math.floor(next() * sizes.length)]!;
      const fromFile = importSearchFrom({ device, size }) === "file";
      const live = liveRoom();
      const workers: CountingWorker[] = [];
      const timers = fakeTimers();
      const header = heldSize();
      const search = importSearch(new Blob(["x"]), device, { makeWorker: () => (workers.push(new CountingWorker()), workers.at(-1)!), timers, size: header.size });
      const waits: ImportWait[] = [];
      // The model.
      const m = {
        read: device === "computer",
        uploaded: false,
        ended: false,
        worker: device === "computer",
        settled: undefined as SearchDone | null | undefined,
        wait: undefined as { answer: SearchDone | null; handed: boolean } | undefined,
        landing: null as { stale: boolean; over: boolean } | null,
      };
      const decide = () => {
        if (!m.uploaded || m.wait) return;
        if (m.ended) m.wait = { answer: null, handed: false };
        else if (m.read && m.settled !== undefined) m.wait = { answer: m.settled, handed: false };
      };
      const events: string[] = [];
      for (let step = 0, steps = 1 + Math.floor(next() * 14); step < steps; step++) {
        const kind = pickKind(m.landing !== null && !m.landing.over);
        events.push(kind);
        const label = `run ${run} (${device}, ${size ? `${size.width} x ${size.height}` : "no size"}): ${events.join(", ")}`;
        const sentBefore = live.sent.length;
        const before = live.store.getState();
        let lands: "applied" | "offered" | "none" | "changed" | null = null;
        let applied = false;
        const landingRuns = m.landing !== null && !m.landing.over;
        if (kind === "header") {
          header.answer(size);
          if (!m.read && !m.ended) m.worker ||= fromFile || m.uploaded;
          m.read = true;
        } else if (kind === "upload") {
          if (!m.uploaded) {
            void search.afterUpload(["/m/mobile"], IMPORT_WAIT_MS).then((w) => {
              waits.push(w);
              // What the page does with a search handed on: Line up grid takes it (useFindGrid.ts `useLandLater`).
              if (w.later) void landSearch({ actions: live.actions, store: live.store, sceneId: "s1", start: live.scene(), scene: live.scene, search: w.later, ms: FIND_TIMEOUT_MS, timers, fit: true, fallback: guess });
            });
            if (m.read && !m.ended && !fromFile) m.worker = true;
          }
          m.uploaded = true;
        } else if (kind === "sure" || kind === "doubtful" || kind === "nothing" || kind === "fail") {
          const w = workers.at(-1);
          if (kind === "fail") w?.fail();
          else w?.answer(kind === "sure" ? SURE : kind === "doubtful" ? DOUBTFUL : NOTHING);
          const value = kind === "sure" ? SURE : kind === "doubtful" ? DOUBTFUL : kind === "nothing" ? NOTHING : null;
          if (m.worker && m.settled === undefined && !m.ended && !(m.landing?.over ?? false)) {
            m.settled = value as SearchDone | null;
            if (landingRuns) {
              if (!m.landing!.stale) lands = kind === "sure" ? "applied" : kind === "doubtful" ? "offered" : "none";
              else if (kind === "sure" || kind === "doubtful") lands = "changed";
              m.landing!.over = true;
            }
          }
        } else if (kind === "cancel") {
          if (landingRuns) {
            // The tool closes.
            const { finding } = live.store.getState();
            finding?.cancel();
            live.store.setState({ finding: null });
            m.landing!.over = true;
          } else if (!m.wait) {
            // The page cancels the upload.
            search.cancel();
            m.ended = true;
          }
        } else if (kind === "deadline") {
          if (timers.pending() > 0) {
            timers.fire();
            if (landingRuns) {
              if (!m.landing!.stale) lands = "none";
              m.landing!.over = true;
            } else if (m.uploaded && !m.wait) {
              if (m.worker && !fromFile && m.settled === undefined && !m.ended) {
                m.wait = { answer: null, handed: true };
                m.landing = { stale: false, over: false };
              } else m.ended = true;
            }
          }
        } else if (kind === "apply") {
          const cal = { cellPx: 80 + Math.floor(next() * 4), originPx: { x: 0, y: 0 } };
          const change = !sameCalibration(cal, live.scene().map);
          applyGrid({ actions: live.actions, store: live.store, sceneId: "s1", cal: change ? cal : null, bounds: null });
          applied = change;
          if (landingRuns) m.landing!.over = true;
        } else if (kind === "drag") {
          endFinding(live.store, "s1");
          live.store.setState({ box: { x: Math.floor(next() * 500), y: 10, size: 240 } });
          if (landingRuns) m.landing!.over = true;
        } else {
          // Each change moves on from the last, so the scene never comes back to how a landing found it.
          const s = live.scene();
          const which = Math.floor(next() * 3);
          live.elsewhere(
            which === 0
              ? { ...s, map: { ...s.map, cellPx: s.map.cellPx + 3 } }
              : which === 1
                ? { ...s, bounds: { w: s.bounds.w + 1, h: s.bounds.h } }
                : { ...s, map: { ...s.map, assetId: `${s.map.assetId}+` } },
          );
          if (landingRuns) m.landing!.stale = true;
        }
        decide();
        await settled();

        const after = live.store.getState();
        const runs = m.landing !== null && !m.landing.over;
        assert.equal(workers.length, m.worker ? 1 : 0, `${label}: the Workers made`);
        for (const w of workers) for (const posted of w.posted) assert.equal("file" in posted, fromFile, `${label}: what the Worker was given`);
        assert.deepEqual(
          waits.map((w) => ({ answer: w.answer, handed: w.later !== null })),
          m.wait ? [m.wait] : [],
          `${label}: how the wait ended`,
        );
        assert.equal(after.finding !== null, runs, `${label}: finding is set exactly while a handed-on search runs`);
        const alive = m.worker && m.settled === undefined && !m.ended && !(m.landing?.over ?? false);
        assert.equal(workers.filter((w) => w.terminated === 0).length, alive ? 1 : 0, `${label}: only a running search's Worker is alive`);
        assert.ok(
          workers.every((w) => w.terminated <= 1),
          `${label}: no Worker is ended twice`,
        );
        assert.equal(timers.pending(), (m.uploaded && !m.wait) || runs ? 1 : 0, `${label}: only a running wait or landing has a timer`);
        const sent = live.sent.slice(sentBefore);
        if (lands) {
          assert.equal(after.found?.outcome, lands, label);
          if (lands === "applied") {
            assert.ok(sent.length <= 2 && sent.every((s) => s.group !== undefined && s.group === sent[0]!.group), `${label}: one undo step`);
            assert.ok(sameCalibration(live.scene().map, { cellPx: 70, originPx: { x: 20, y: 35 } }), `${label}: the found grid is on`);
            assert.deepEqual(after.found?.fallback && { cellPx: after.found.fallback.cellPx, originPx: after.found.fallback.originPx }, guess, `${label}: Use default`);
          } else assert.equal(sent.length, 0, label);
          if (lands === "changed") assert.equal(after.box, before.box, `${label}: the box is the one before`);
        } else {
          assert.equal(sent.length, applied ? 1 : 0, `${label}: only Apply sent anything`);
          // A landing that begins clears the last note. Nothing else touches it.
          if (!(m.wait?.handed && waits.length === 1 && before.finding === null && after.finding !== null)) assert.equal(after.found, before.found, `${label}: the note is the one before`);
          if (kind !== "drag") assert.equal(after.box, before.box, `${label}: the box is the one before`);
        }
      }
      // The page and the tool end whatever is left, as an unmount or a close does.
      if (!m.wait) search.cancel();
      endFinding(live.store, "s1");
      header.answer(size);
      await settled();
      const label = `run ${run}: ${events.join(", ")}`;
      assert.equal(timers.pending(), 0, `${label}: no timer left`);
      for (const w of workers) assert.equal(w.terminated, 1, `${label}: the Worker ended once`);
    }
  });
});

const FAMILY = { period: 30, phase: 0, found: 20, expected: 20, snr: 50, between: 0, rms: 0.1 };
/** Hex rows of 30.1 px decoded at half the map's size: 60.2 px hexes on the map, a center at (500.4, 399.2). */
const HEX_ROWS_FOUND: HexDetection = { found: true, orient: "rows", cellPx: 30.1, center: { x: 250.2, y: 199.6 }, box: { x: 0, y: 0, size: 90.3 }, confidence: 0.9, polarity: "dark", broken: 0.9, coverage: 1, checked: true, families: [FAMILY, FAMILY, FAMILY] };
const HEX_CAL = calibrationFromHexFind({ cellPx: 60.2, center: { x: 500.4, y: 399.2 }, orient: "rows" });
const NO_HEX: HexDetection = { found: false, reason: "none" };
type GridShapeOrSquares = "squares" | "hexRows" | "hexColumns";
const NO_SQUARES = { found: false, reason: "none" } as const;
const answerOf = (squares: GridDetection, rows: HexDetection): SearchAnswer => ({ t: "done", result: squares, hex: { rows, columns: NO_HEX }, width: 700, height: 500 });
const HEXES_SURE = answerOf(NO_SQUARES, HEX_ROWS_FOUND);
const HEXES_DOUBTFUL = answerOf(NO_SQUARES, { ...HEX_ROWS_FOUND, confidence: 0.5 });
const BOTH = answerOf(DETECTED, { ...HEX_ROWS_FOUND, confidence: 0.97, cellPx: 26 });

/** Find the grid on the live scene, answered with `answer`. */
async function findWith(live: ReturnType<typeof liveRoom>, answer: SearchAnswer, refusal?: (scene: GridScene, to: Grid) => string | null) {
  const worker = new AnsweringWorker();
  const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker, ...(refusal ? { refusal } : {}) });
  worker.answer(answer);
  await running;
  return live.store.getState().found;
}

/** The options line for the scene as it is now, as Options.tsx reads it. */
function lineOf(live: ReturnType<typeof liveRoom>): string | undefined {
  const g = gridOfShape(live.scene().gridShape);
  const note = noteFor(live.store.getState().found, "s1", g);
  return note && note.box === live.store.getState().box ? foundLine(note, g).content : undefined;
}

describe("squares and hexes both looked for (docs/design-v1-grid-detect.md 10.7)", () => {
  const HEX_ROWS = gridOfShape("hexRows");

  test("hexes found on a new map in a square room start the scene on hexes with the grid, one undo step, and Use default puts back both", () => {
    const live = liveRoom();
    const guess = { cellPx: 47, originPx: { x: 0, y: 0 } };
    const found = { tier: "high" as const, cal: HEX_CAL, shape: "hexRows" as const };
    showOutcome({ actions: live.actions, store: live.store, scene: live.scene(), found, fit: true, at: { x: 700, y: 500 }, fallback: guess });
    assert.deepEqual(
      live.sent.map((s) => s.op),
      [
        { t: "scene.update", sceneId: "s1", patch: { gridShape: "hexRows" } },
        { t: "scene.setGrid", sceneId: "s1", cellPx: HEX_CAL.cellPx, originPx: HEX_CAL.originPx },
        { t: "scene.update", sceneId: "s1", patch: { bounds: fitBounds({ ...MAP, ...HEX_CAL }) } },
      ],
    );
    assert.ok(live.sent.every((s) => s.group === live.sent[0]!.group), "one undo step");
    assert.equal(live.scene().gridShape, "hexRows");
    const note = live.store.getState().found;
    assert.equal(note?.switched, true);
    assert.deepEqual(live.store.getState().box, boxAround(HEX_CAL, { x: 700, y: 500 }, HEX_ROWS), "the box on the hexes found");
    assert.equal(lineOf(live), "Found hex rows of 60.2 px. The grid is hex rows now.");
    assert.deepEqual(boxCalibration(live.store.getState().box!, note!, "s1", HEX_ROWS), HEX_CAL, "Apply takes the find as measured");
    // Use default.
    assert.deepEqual(note?.fallback, { ...guess, bounds: SCENE.bounds, shape: "squares" });
    const back = fallbackOps(live.scene(), note!.fallback!);
    assert.deepEqual(back, [
      { t: "scene.update", sceneId: "s1", patch: { gridShape: "squares" } },
      { t: "scene.setGrid", sceneId: "s1", ...guess },
      { t: "scene.update", sceneId: "s1", patch: { bounds: SCENE.bounds } },
    ]);
    for (const op of back) live.actions.dispatch(op);
    assert.equal(live.scene().gridShape, undefined, "shape back");
    assert.ok(sameCalibration(live.scene().map, guess), "grid back");
  });

  test("Use default after a switch the scene can no longer take back sends nothing and says why, and puts back all once it can (H3-OPUS-03)", () => {
    const live = liveRoom();
    const guess = { cellPx: 47, originPx: { x: 0, y: 0 } };
    showOutcome({ actions: live.actions, store: live.store, scene: live.scene(), found: { tier: "high", cal: HEX_CAL, shape: "hexRows" }, fit: true, at: { x: 700, y: 500 }, fallback: guess });
    live.store.setState({ sceneId: "s1" });
    const switched = live.scene();
    const box = live.store.getState().box;
    // Heights painted on the hexes since: the reducer would refuse squares, so nothing that assumes them may go.
    const why = "This scene has heights on its hexes, which can't stand on squares. Remove them to change the grid.";
    const asked: Grid[] = [];
    const before = live.sent.length;
    const fallback = live.store.getState().found!.fallback!;
    assert.equal(putBack({ actions: live.actions, store: live.store, scene: live.scene(), fallback, refusal: (to) => (asked.push(to), why) }), false);
    assert.deepEqual(asked, [SQUARES], "the shape it would put back is asked");
    assert.equal(live.sent.length, before, "nothing sent: no shape, no square grid, no size");
    assert.equal(live.scene(), switched);
    assert.equal(live.store.getState().box, box, "the box stays on the hexes");
    assert.equal(live.store.getState().found?.fallback, fallback, "Use default stays, for once the heights go");
    assert.equal(lineOf(live), "Can't go back to squares: this scene has heights on its hexes, which can't stand on squares. Remove them to change the grid.");
    // The heights gone, Use default puts back the shape, the guess and the size as one step.
    assert.equal(putBack({ actions: live.actions, store: live.store, scene: live.scene(), fallback, refusal: () => null }), true);
    const back = live.sent.slice(before);
    assert.deepEqual(back[0]?.op, { t: "scene.update", sceneId: "s1", patch: { gridShape: "squares" } });
    assert.ok(back.every((x) => x.group === back[0]!.group));
    assert.equal(live.scene().gridShape, undefined);
    assert.ok(sameCalibration(live.scene().map, guess));
    assert.equal(live.store.getState().found, null);
    assert.deepEqual(live.store.getState().box, boxAround(guess, middleOf(box, MAP, gridOfShape("hexRows")), SQUARES), "a box of squares under the guess");
    // A find that kept the scene's shape puts back its grid whatever else the scene holds: there is no switch to refuse.
    const kept = liveRoom();
    showOutcome({ actions: kept.actions, store: kept.store, scene: kept.scene(), found: { tier: "high", cal: FOUND }, fit: true, at: { x: 700, y: 500 }, fallback: guess });
    const sent = kept.sent.length;
    assert.equal(putBack({ actions: kept.actions, store: kept.store, scene: kept.scene(), fallback: kept.store.getState().found!.fallback!, refusal: () => why }), true);
    assert.ok(kept.sent.length > sent);
    assert.ok(sameCalibration(kept.scene().map, guess));
  });

  test("Find the grid on a hex scene applies a sure find of its own hexes, and a square scene's sure squares switch a hex scene back", async () => {
    const live = liveRoom();
    live.elsewhere({ ...SCENE, gridShape: "hexRows" });
    await findWith(live, HEXES_SURE);
    assert.deepEqual(live.sent[0]?.op, { t: "scene.setGrid", sceneId: "s1", cellPx: HEX_CAL.cellPx, originPx: HEX_CAL.originPx });
    assert.ok(live.sent.every((s) => s.op.t !== "scene.update" || !s.op.patch.gridShape), "no switch");
    assert.equal(lineOf(live), "Found a grid of 60.2 px hexes.");
    assert.equal(live.store.getState().found?.fallback, undefined, "Undo puts it back");
    const squares = liveRoom();
    squares.elsewhere({ ...SCENE, gridShape: "hexColumns" });
    await findWith(squares, SURE);
    assert.deepEqual(squares.sent[0]?.op, { t: "scene.update", sceneId: "s1", patch: { gridShape: "squares" } });
    assert.equal(squares.scene().gridShape, undefined);
    assert.equal(lineOf(squares), "Found squares of 70 px. The grid is squares now.");
  });

  test("a contested find only places the box on the scene's own shape, nothing applied and the shape unchanged, and the line names both", async () => {
    const live = liveRoom();
    await findWith(live, BOTH);
    assert.deepEqual(live.sent, []);
    assert.equal(live.scene().gridShape, undefined);
    assert.equal(live.store.getState().found?.outcome, "offered");
    assert.deepEqual(live.store.getState().box, { x: 580, y: 385, size: 210 }, "the box on the squares found");
    assert.equal(lineOf(live), "The map shows squares of 70 px and hexes of 52 px. Check the box, then Apply.");
    // On a scene of neither shape, the surer is offered as another shape.
    const columns = liveRoom();
    columns.elsewhere({ ...SCENE, gridShape: "hexColumns" });
    await findWith(columns, BOTH);
    assert.deepEqual(columns.sent, []);
    assert.equal(lineOf(columns), "The map shows hex rows of 52 px and squares of 70 px. Change Grid shape to use them.");
  });

  test("a contested find of another shape sends nothing at any confidence", () => {
    const live = liveRoom();
    const found = { tier: "high" as const, cal: HEX_CAL, shape: "hexRows" as const, contested: { shape: "squares" as const, cellPx: 70 } };
    showOutcome({ actions: live.actions, store: live.store, scene: live.scene(), found, fit: true, at: { x: 700, y: 500 } });
    assert.deepEqual(live.sent, []);
    assert.equal(live.store.getState().found?.outcome, "offered");
  });

  test("hexes found on a square scene with painted ground: the shape stays, and the line says why", async () => {
    const live = liveRoom();
    const why = "This scene has painted ground on its squares, which can't stand on hexes. Remove them to change the grid.";
    const asked: Grid[] = [];
    await findWith(live, HEXES_SURE, (_scene, to) => (asked.push(to), why));
    assert.deepEqual(asked, [HEX_ROWS], "the switch is asked for the shape found");
    assert.deepEqual(live.sent, []);
    assert.equal(live.scene().gridShape, undefined);
    assert.equal(lineOf(live), "Found hex rows of 60.2 px, but this scene has painted ground on its squares, which can't stand on hexes. Remove them to change the grid.");
    // A Universal VTT scene keeps its file's squares, whatever the room says.
    const uvtt = liveRoom();
    uvtt.elsewhere({ ...SCENE, gridFromFile: true });
    await findWith(uvtt, HEXES_SURE, () => null);
    assert.deepEqual(uvtt.sent, []);
    assert.equal(lineOf(uvtt), "Found hex rows of 60.2 px, but this scene came with its own square grid from its file.");
  });

  test("a doubtful find of another shape changes nothing and says so, and Grid shape changed to it brings its box and grid", async () => {
    const live = liveRoom();
    live.store.setState({ sceneId: "s1" });
    await findWith(live, HEXES_DOUBTFUL);
    assert.deepEqual(live.sent, []);
    assert.equal(lineOf(live), "These lines may be hex rows of 60.2 px. Change Grid shape to use them.");
    shapeChanged(live.store, "s1", { map: MAP, from: SQUARES, to: HEX_ROWS });
    live.elsewhere({ ...live.scene(), gridShape: "hexRows" });
    const { box, found } = live.store.getState();
    assert.ok(box);
    assert.deepEqual(boxCalibration(box, found, "s1", HEX_ROWS), HEX_CAL, "Apply takes the find");
    assert.deepEqual(box, boxAround(HEX_CAL, { x: 700, y: 500 }, HEX_ROWS));
    assert.equal(lineOf(live), "These lines may be the map's hexes: 60.2 px. Check the box, then Apply.");
  });

  test("an import's doubtful find of another shape places the box on the new scene, never the last scene's box", () => {
    const live = liveRoom();
    const elsewhere = { x: 5000, y: 5000, size: 300 };
    live.store.setState({ sceneId: "s0", box: elsewhere });
    showOutcome({ actions: live.actions, store: live.store, scene: live.scene(), found: { tier: "medium", cal: HEX_CAL, shape: "hexRows" }, fit: true, at: { x: 700, y: 500 }, fallback: { cellPx: 47, originPx: { x: 0, y: 0 } } });
    assert.deepEqual(live.sent, []);
    assert.deepEqual(live.store.getState().box, boxAround(MAP, { x: 700, y: 500 }), "a box of the new scene's squares at the map's middle");
    assert.equal(live.store.getState().found?.box, live.store.getState().box, "which the line stands by");
  });

  test("a hex find whose lean could not be measured, held to medium, is only offered on its own shape too", async () => {
    const live = liveRoom();
    live.elsewhere({ ...SCENE, gridShape: "hexRows" });
    await findWith(live, answerOf(NO_SQUARES, { ...HEX_ROWS_FOUND, confidence: 0.5, checked: false }));
    assert.deepEqual(live.sent, []);
    assert.equal(lineOf(live), "These lines may be the map's hexes: 60.2 px. Check the box, then Apply.");
  });

  test("a late hex answer on a scene whose shape changed is dropped, and the line says the scene changed", async () => {
    const live = liveRoom();
    live.elsewhere({ ...SCENE, gridShape: "hexRows" });
    const worker = new AnsweringWorker();
    const running = findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker });
    live.elsewhere({ ...live.scene(), gridShape: "hexColumns" });
    worker.answer(HEXES_SURE);
    await running;
    assert.deepEqual(live.sent, []);
    assert.equal(live.store.getState().found?.outcome, "changed");
    assert.equal(lineOf(live), "The scene changed, so the grid found was not applied.");
  });

  /**
   * Random runs of Find the grid on scenes of every shape: answers of
   * squares, hex rows, both, doubtful hexes and none, answers from ended
   * searches, Grid shape changed here or on another device, and the
   * scene's content refusing a switch or not. Invariants, after every event:
   * - `finding` is set exactly while a search runs.
   * - Only an answer that lands while its search runs, on a scene unchanged
   *   since it began, sends anything, and then one undo group.
   * - The shape changes only by a sure find of another shape found alone
   *   on a scene that may switch, its first op, with the grid in its group.
   *   A contested, doubtful or refused find sends nothing.
   * - A note the options line reads stands for cells of the scene's shape now.
   */
  test("random finds, shape changes here and elsewhere, refusals and late answers keep every invariant", async () => {
    const next = rng(20261028);
    const kinds = ["find", "squares", "hexes", "both", "doubtful", "nothing", "late", "shapeHere", "shapeElsewhere", "refuse"] as const;
    const shapes = [undefined, "hexRows", "hexColumns"] as const;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
    const answers = { squares: SURE, hexes: HEXES_SURE, both: BOTH, doubtful: HEXES_DOUBTFUL, nothing: NOTHING };
    for (let run = 0; run < 400; run++) {
      const live = liveRoom();
      live.elsewhere({ ...SCENE, ...(pick(shapes) ? { gridShape: pick(["hexRows", "hexColumns"] as const) } : {}) });
      live.store.setState({ sceneId: "s1" });
      const timers = fakeTimers();
      let refused = false;
      const ended: AnsweringWorker[] = [];
      let running: { worker: AnsweringWorker; stale: boolean } | null = null;
      const end = () => {
        if (running) ended.push(running.worker);
        running = null;
      };
      const events: string[] = [];
      const steps = 1 + Math.floor(next() * 10);
      for (let step = 0; step < steps; step++) {
        const kind = pick(kinds);
        events.push(kind);
        const label = `run ${run}: ${events.join(", ")}`;
        const sentBefore = live.sent.length;
        const shapeBefore = live.scene().gridShape;
        let expect: { sends: false } | { sends: true; to: GridShapeOrSquares | null } = { sends: false };
        if (kind === "find") {
          const worker = new AnsweringWorker();
          void findOnScene({ actions: live.actions, store: live.store, sceneId: "s1", scene: live.scene, urls: ["/m"], makeWorker: () => worker, timers, refusal: () => (refused ? "Remove them to change the grid." : null) });
          if (!running) running = { worker, stale: false };
        } else if (kind in answers) {
          if (running) {
            const own = shapeBefore ?? "squares";
            running.worker.answer(answers[kind as keyof typeof answers]);
            if (!running.stale && (kind === "squares" || kind === "hexes")) {
              const found = kind === "squares" ? "squares" : "hexRows";
              if (found === own) expect = { sends: true, to: null };
              else if (!refused) expect = { sends: true, to: found };
            }
            end();
          }
        } else if (kind === "late") {
          if (ended.length) pick(ended).answer(pick([SURE, HEXES_SURE, BOTH]));
        } else if (kind === "shapeHere" || kind === "shapeElsewhere") {
          const s = live.scene();
          const to = pick(shapes.filter((x) => x !== s.gridShape));
          if (kind === "shapeHere") {
            shapeChanged(live.store, "s1", { map: s.map, from: gridOfShape(s.gridShape), to: gridOfShape(to) });
            end();
          } else if (running) running.stale = true;
          const { gridShape: _, ...rest } = s;
          live.elsewhere(to ? { ...rest, gridShape: to } : rest);
        } else refused = !refused;
        await settled();

        const after = live.store.getState();
        assert.equal(after.finding !== null, running !== null, `${label}: finding is set exactly while a search runs`);
        const sent = live.sent.slice(sentBefore);
        if (!expect.sends) {
          assert.equal(sent.length, 0, `${label}: nothing sent`);
          if (kind !== "shapeHere" && kind !== "shapeElsewhere") assert.equal(live.scene().gridShape, shapeBefore, `${label}: the shape stays`);
        } else {
          // Nothing at all when the scene holds that grid already.
          assert.ok(sent.every((x) => x.group === sent[0]!.group), `${label}: one undo group`);
          const switches = sent.filter((x) => x.op.t === "scene.update" && x.op.patch.gridShape !== undefined);
          if (expect.to === null) assert.equal(switches.length, 0, `${label}: no switch`);
          else {
            assert.equal(switches.length, 1, `${label}: one switch`);
            assert.equal(sent[0], switches[0], `${label}: the switch goes first`);
            assert.equal(live.scene().gridShape ?? "squares", expect.to, `${label}: the shape found`);
          }
        }
        const g = gridOfShape(live.scene().gridShape);
        const note = noteFor(after.found, "s1", g);
        if (note && note.outcome !== "changed") assert.equal(note.shape, live.scene().gridShape, `${label}: the note is of the scene's cells`);
      }
    }
  });

  test("no grid on a hex scene says to line up the hexes", async () => {
    const live = liveRoom();
    live.elsewhere({ ...SCENE, gridShape: "hexRows" });
    live.store.setState({ box: { x: 0, y: 0, size: 210 } });
    await findWith(live, answerOf(NO_SQUARES, NO_HEX));
    assert.equal(lineOf(live), "No grid found. Drag a box over 3 hexes across instead.");
  });
});
