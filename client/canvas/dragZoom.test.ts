import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { wheelZoomFactor, zoomAt, type Camera } from "../lib/camera.ts";

// Run Stage's handlers with camera scheduling replaced. This catches a missing
// drag guard at the input boundary without mounting Konva or opening a socket.
const stage = readFileSync(new URL("./Stage.tsx", import.meta.url), "utf8");
function handler(name: string, next: string, bindings: Record<string, unknown>) {
  const source = stage.slice(stage.indexOf(`const ${name} =`), stage.indexOf(`const ${next} =`));
  return new Function(...Object.keys(bindings), `${stripTypeScriptTypes(source)}\nreturn ${name};`)(...Object.values(bindings)) as (...args: unknown[]) => void;
}

for (const mode of ["wheel", "keys"] as const) test(`FU39-B: ${mode} keeps a token drag's grip zoom, then zooms once the drag ends`, () => {
  const camera: Camera = { x: 100, y: 100, scale: 40 };
  const scheduled: Camera[] = [];
  const dragRef: { current: object | null } = { current: {} };
  const gesture = { minScale: 1 };
  let prevented = 0;
  const bindings = {
    currentCam: () => camera, scheduleCam: (c: Camera) => scheduled.push(c), local: () => ({ x: 200, y: 200 }),
    zoomAt, wheelZoomFactor, gesture, dragRef, sizeRef: { current: { width: 400, height: 400 } },
    pendingCamRef: { current: null }, camRef: { current: camera }, gestureRef: { current: gesture },
  };
  const run = mode === "wheel" ? handler("onWheel", "onContextMenu", bindings) : handler("zoomBy", "nudge", bindings);
  const input = mode === "wheel" ? { deltaY: -100, deltaMode: 0, ctrlKey: false, preventDefault: () => prevented++ } : 1.2;
  run(input);
  assert.equal(scheduled.length, 0, "nothing moves the grip's camera during a token drag");
  if (mode === "wheel") assert.equal(prevented, 1, "the wheel does not scroll the page behind the drag");
  dragRef.current = null;
  run(input);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0]!.scale > camera.scale);
});
