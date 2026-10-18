import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { SceneMap } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { AxisFit, GridDetection } from "./detect.ts";
import type { SearchAnswer, SearchRequest, SearchWorker } from "./findGrid.ts";
import { boxAround, findOnScene, gridOps, middleOf, showOutcome } from "./outcome.ts";
import { calibrationFromBox, nudgeBox } from "./calibrate.ts";
import { boxCalibration, type GridToolState } from "./store.ts";

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
    assert.deepEqual(found, { sceneId: "s1", outcome: "applied", cellPx: 70, box, cal: FOUND, fallback: { cellPx: 47, originPx: { x: 0, y: 0 } } });
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
    const uvtt = { ...SCENE, autoWalls: "off" as const, map: { ...MAP, cellPx: 70.5, originPx: { x: -50, y: -35 } } };
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
