import assert from "node:assert/strict";
import { test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { builderScene } from "../scenes/create.ts";
import { SCENE_PLACEHOLDER } from "./ops.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import type { FromWorker, ToWorker } from "./worker.ts";

test("DG-B: the worker answers a preview with its id: the plan, the ops that parse, the room they make and the counts", async () => {
  let receive: ((event: { data: ToWorker }) => void) | undefined;
  const answers: FromWorker[] = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      addEventListener(_type: string, listener: typeof receive) {
        receive = listener;
      },
      postMessage(message: FromWorker) {
        answers.push(message);
      },
    },
  });
  try {
    await import("./worker.ts");
    assert.ok(receive);
    const scene = builderScene({ id: "chosen", name: "Crypt", w: 50, h: 50 });
    receive({ data: { t: "preview", id: 7, settings: DEFAULT_SETTINGS, seed: "1K7QH2MXA9F3TWQ5", scene } });
    assert.equal(answers.length, 1, "answered in the same task");
    const [answer] = answers;
    assert.equal(answer?.id, 7);
    const preview = answer!.preview;
    assert.ok(preview.ok);
    assert.equal(preview.summary.rooms, preview.plan.rooms.length);
    assert.ok(preview.summary.rooms >= 2);
    for (const op of preview.ops) assert.ok(clientOpSchema.safeParse(op).success, op.t);
    assert.deepEqual(Object.keys(preview.room.scenes), [SCENE_PLACEHOLDER]);
    assert.equal(preview.room.scenes[SCENE_PLACEHOLDER]!.name, "Crypt");
    // What the page gets is structured-clonable, as postMessage needs.
    assert.deepEqual(structuredClone(preview), preview);
  } finally {
    if (prior) Object.defineProperty(globalThis, "self", prior);
    else Reflect.deleteProperty(globalThis, "self");
  }
});
