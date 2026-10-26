import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FrameScheduler } from "./scheduler.ts";

class Layer {
  readonly log: string[];
  readonly name: string;
  constructor(name: string, log: string[]) {
    this.name = name;
    this.log = log;
  }
  draw(): void {
    this.log.push(this.name);
  }
  batchDraw(): void {
    this.log.push(`konva ${this.name}`);
  }
}

function frames() {
  const queue: (() => void)[] = [];
  return {
    queue,
    request: (run: () => void) => queue.push(run),
    cancel: (id: number) => {
      queue[id - 1] = () => {};
    },
    flush: () => {
      const runs = queue.splice(0);
      for (const r of runs) r();
    },
  };
}

describe("the isometric board's frame scheduler", () => {
  test("any number of requests in a frame make one draw of each layer, the ground before the relief", () => {
    const log: string[] = [];
    const ground = new Layer("ground", log);
    const relief = new Layer("relief", log);
    const f = frames();
    const s = new FrameScheduler(ground, relief, f);
    ground.batchDraw();
    relief.batchDraw();
    ground.batchDraw();
    relief.batchDraw();
    assert.equal(f.queue.length, 1);
    f.flush();
    assert.deepEqual(log, ["ground", "relief"]);
    assert.equal(s.frames, 1);
  });

  test("a ground draw always brings a relief draw after it, since the tops copy the ground", () => {
    const log: string[] = [];
    const f = frames();
    const ground = new Layer("ground", log);
    new FrameScheduler(ground, new Layer("relief", log), f);
    ground.batchDraw();
    f.flush();
    assert.deepEqual(log, ["ground", "relief"]);
  });

  test("a relief request alone draws only the relief", () => {
    const log: string[] = [];
    const f = frames();
    const relief = new Layer("relief", log);
    new FrameScheduler(new Layer("ground", log), relief, f);
    relief.batchDraw();
    f.flush();
    assert.deepEqual(log, ["relief"]);
  });

  test("detaching cancels a waiting frame and gives the layers Konva's batchDraw back", () => {
    const log: string[] = [];
    const f = frames();
    const ground = new Layer("ground", log);
    const relief = new Layer("relief", log);
    const s = new FrameScheduler(ground, relief, f);
    ground.batchDraw();
    s.detach();
    f.flush();
    ground.batchDraw();
    assert.deepEqual(log, ["konva ground"]);
  });
});
