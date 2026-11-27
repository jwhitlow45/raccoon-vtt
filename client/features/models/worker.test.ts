import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_WORDS, type FromModelWorker, type ToModelWorker } from "./mesh.ts";

/**
 * The model worker where it cannot draw (docs/design/design-v1-token-models.md
 * 5, D-261127-184): Node has no OffscreenCanvas, as a browser without WebGL
 * in a worker has none to draw on, so every request ends in the sheet's
 * words for that, before the file is read.
 */

test("a browser that cannot draw in a worker is told so, in words, before the file is read", async () => {
  let receive: ((event: { data: ToModelWorker }) => void) | undefined;
  const answers: FromModelWorker[] = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      addEventListener(_type: string, listener: typeof receive) {
        receive = listener;
      },
      postMessage(message: FromModelWorker) {
        answers.push(message);
      },
    },
  });
  try {
    await import("./worker.ts");
    assert.equal(typeof OffscreenCanvas, "undefined");
    let read = false;
    const file = new File(["solid x"], "x.stl");
    Object.defineProperty(file, "slice", { value: () => ((read = true), new Blob()) });
    receive!({ data: { t: "draw", id: 7, file, device: "computer", options: { color: "stone", up: 0, front: 0, size: 100 } } });
    for (let i = 0; i < 20 && answers.length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers, [{ t: "refused", id: 7, message: MODEL_WORDS.noWebgl }]);
    assert.equal(MODEL_WORDS.noWebgl, "This browser can't draw 3D models. Recent Chrome, Edge, Firefox and Safari can.");
    assert.equal(read, false);
  } finally {
    if (prior) Object.defineProperty(globalThis, "self", prior);
    else delete (globalThis as { self?: unknown }).self;
  }
});
