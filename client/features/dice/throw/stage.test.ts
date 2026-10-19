import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WebGLRenderer } from "three";
import { createStage, type StageDeps } from "./stage.ts";

/*
 * The stage's lifecycle under Node (docs/design-v1-roll-animation.md 7):
 * canvases and the renderer are stand-ins that record what reaches them,
 * so a warm-up or previews still waiting for the font when the stage goes
 * are seen never to touch the renderer after it.
 */

/** A 2D context that draws nothing. */
const flat = new Proxy({} as Record<string, unknown>, {
  get: (_target, key) => (key === "measureText" ? () => ({ width: 10 }) : () => undefined),
  set: () => true,
});

function canvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {},
    dataset: {},
    setAttribute() {},
    addEventListener() {},
    remove() {},
    getContext: (type: string) => (type === "2d" ? flat : {}),
  } as unknown as HTMLCanvasElement;
}

function deps(fonts: () => Promise<void>) {
  const calls: string[] = [];
  const renderer = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => () => calls.push(String(key)),
  }) as unknown as WebGLRenderer;
  const made: StageDeps = { canvas, renderer: () => renderer, fonts };
  return { made, calls };
}

describe("the dice stage", () => {
  test("a warm-up draws its textures and compiles once the font is in", async () => {
    const { made, calls } = deps(async () => undefined);
    const stage = createStage({ lost() {}, restored() {} }, made)!;
    calls.length = 0;
    await stage.warm(["d20", "d6"], "ivory");
    assert.ok(calls.includes("compile"));
    assert.ok(calls.includes("initTexture"));
  });

  test("a stage that goes while its warm-up and previews wait for the font never reaches its renderer again", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const { made, calls } = deps(() => pending);
    const stage = createStage({ lost() {}, restored() {} }, made)!;
    const warming = stage.warm(["d20"], "ivory");
    const previewing = stage.previews!([], 48);
    stage.dispose();
    calls.length = 0;
    release();
    await warming;
    assert.equal(await previewing, false);
    assert.deepEqual(calls, [], "nothing after the disposal");
  });
});
