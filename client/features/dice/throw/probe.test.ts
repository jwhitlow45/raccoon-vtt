import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { makeProbe, stageLoader, type ProbeCanvas } from "./probe.ts";

/** The WebGL probe and the dice chunk's background load (docs/design-v1-roll-animation.md 6 and 7). */

function fakeCanvas(has: boolean, log: string[]): () => ProbeCanvas {
  return () => ({
    getContext(kind, attributes) {
      log.push(`${kind} ${attributes.failIfMajorPerformanceCaveat ? "no-caveat" : "any"}`);
      return has ? { getExtension: () => ({ loseContext: () => log.push("released") }) } : null;
    },
  });
}

/** The switch, Low power and the preview as a loader reads them, with their listeners. */
function settings(start: { on: boolean; low: boolean; preview: boolean }) {
  const now = { ...start };
  const listeners = new Set<() => void>();
  return {
    now,
    allowed: () => now.on && !now.low && !now.preview,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch: Partial<typeof now>) {
      Object.assign(now, patch);
      for (const l of [...listeners]) l();
    },
  };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

describe("the WebGL probe", () => {
  test("asks for WebGL2 refusing a performance caveat, releases the context, and answers once", () => {
    const log: string[] = [];
    const probe = makeProbe(fakeCanvas(true, log));
    assert.equal(probe(), true);
    assert.equal(probe(), true);
    assert.deepEqual(log, ["webgl2 no-caveat", "released"]);
  });

  test("no context, or a canvas that throws, is no WebGL", () => {
    const log: string[] = [];
    const none = makeProbe(fakeCanvas(false, log));
    assert.equal(none(), false);
    assert.equal(none(), false);
    assert.equal(log.length, 1);
    const throws = makeProbe(() => ({
      getContext: () => {
        throw new Error("blocked");
      },
    }));
    assert.equal(throws(), false);
  });
});

describe("the dice chunk's loader", () => {
  for (const [why, start] of [
    ["the switch off", { on: false, low: false, preview: false }],
    ["Low power", { on: true, low: true, preview: false }],
    ["a preview", { on: true, low: false, preview: true }],
  ] as const) {
    test(`with ${why}, neither the probe nor the import runs, until the settings allow`, async () => {
      const s = settings(start);
      let probes = 0;
      let loads = 0;
      const loader = stageLoader({ allowed: s.allowed, subscribe: s.subscribe, probe: () => (probes++, true), load: async () => (loads++, "stage") });
      await loader.start();
      await flush();
      assert.equal(probes, 0);
      assert.equal(loads, 0);
      assert.equal(loader.state(), "waiting");
      s.set({ on: true, low: false, preview: false });
      await flush();
      assert.equal(probes, 1);
      assert.equal(loads, 1);
      assert.equal(loader.loaded(), "stage");
      assert.equal(loader.state(), "ready");
      s.set({ on: false });
      s.set({ on: true });
      await flush();
      assert.equal(loads, 1, "only once");
    });
  }

  test("the settings allowing at once load it at once, and only once however often they change", async () => {
    const s = settings({ on: true, low: false, preview: false });
    let loads = 0;
    let told = 0;
    const loader = stageLoader({ allowed: s.allowed, subscribe: s.subscribe, probe: () => true, load: async () => (loads++, 1) });
    loader.subscribe(() => told++);
    await loader.start();
    s.set({ low: true });
    s.set({ low: false });
    await loader.start();
    await flush();
    assert.equal(loads, 1);
    assert.equal(loader.state(), "ready");
    assert.equal(told, 2, "loading, then ready");
  });

  test("no WebGL never imports, and a failed import stays failed", async () => {
    const s = settings({ on: true, low: false, preview: false });
    let loads = 0;
    const blind = stageLoader({ allowed: s.allowed, subscribe: s.subscribe, probe: () => false, load: async () => (loads++, 1) });
    await blind.start();
    assert.equal(blind.state(), "no-webgl");
    assert.equal(loads, 0);
    const broken = stageLoader({ allowed: s.allowed, subscribe: s.subscribe, probe: () => true, load: () => Promise.reject(new Error("offline")) });
    await broken.start();
    assert.equal(broken.state(), "failed");
    assert.equal(broken.loaded(), null);
  });
});
