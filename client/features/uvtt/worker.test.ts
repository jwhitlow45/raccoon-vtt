import assert from "node:assert/strict";
import { test } from "node:test";
import type { FromWorker, ToWorker } from "./messages.ts";
import { uvttFile } from "./synthetic.ts";
import { summaryLight } from "./summary.ts";

test("FU38-B: the worker sends the file's environment so every conversion can propose its light", async () => {
  let receive: ((event: { data: ToWorker }) => void) | undefined;
  let answer: ((message: FromWorker) => void) | undefined;
  const prior = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", { configurable: true, value: {
    addEventListener(_type: string, listener: typeof receive) { receive = listener; },
    postMessage(message: FromWorker) { if (message.t !== "progress") answer?.(message); },
  } });
  try {
    await import("./worker.ts");
    const ask = (message: ToWorker): Promise<FromWorker> => new Promise((resolve) => {
      answer = resolve;
      assert.ok(receive);
      receive({ data: message });
    });
    for (const ambient of ["ffffffff", "ff202020"]) {
      const raw = { ...uvttFile({ lights: [{ at: { x: 5, y: 5 }, range: 4 }] }), environment: { baked_lighting: false, ambient_light: ambient } };
      const read = await ask({ t: "read", file: new File([JSON.stringify(raw)], "lamplit.dd2vtt"), device: "computer", target: "scene", options: { objects: true, portals: "window", feetPerCell: 5 } });
      assert.equal(read.t, "read");
      if (read.t !== "read") return;
      assert.deepEqual(read.info.environment, { baked: false, ambient });
      assert.equal(summaryLight(read)?.lights ?? 0, ambient === "ffffffff" ? 0 : 1);
      const phase = await ask({ t: "read", file: new File([JSON.stringify(raw)], "phase.dd2vtt"), device: "computer", target: "phase", options: { objects: true, portals: "window", feetPerCell: 5 } });
      assert.equal(phase.t, "read");
      if (phase.t === "read") assert.equal(summaryLight(phase)?.lights, undefined, "a phase imports no lights");
    }
  } finally {
    if (prior) Object.defineProperty(globalThis, "self", prior);
    else Reflect.deleteProperty(globalThis, "self");
  }
});
