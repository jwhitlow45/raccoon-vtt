import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Camera } from "../lib/camera.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromeCameraOf, liveCameraSlot, LiveCamera, showGestureCamera, useChromeCamera, type CameraFit, type ChromeCamera } from "./liveCamera.ts";
import { RoomScope, RoomScopeProvider } from "./scope.ts";

/*
 * The room's live camera (docs/design-v1-relief-pan.md 6.2): the one source
 * of truth for the camera on screen, the applier's answers, and the camera
 * the chrome stands by. The board's render paths are the e2e's (iso
 * HXPERF2): these are the decisions they take.
 */

const at = (x: number, y = 0, scale = 12): Camera => ({ x, y, scale });

function withApplier(answers: CameraFit[]): { live: LiveCamera; applied: Camera[] } {
  const live = new LiveCamera();
  const applied: Camera[] = [];
  live.applier = (c) => {
    applied.push(c);
    return answers.shift() ?? "inside";
  };
  return { live, applied };
}

describe("a gesture's camera on its frame", () => {
  test("in Isometric a pan inside the rendered cull step goes to the applier and sets no state; past it the board renders later, and a view that left the layout renders now", () => {
    const { live, applied } = withApplier(["inside", "step", "out"]);
    live.write(at(0));
    assert.equal(showGestureCamera(live, at(5), true, false), "none");
    assert.equal(showGestureCamera(live, at(10), true, false), "later");
    assert.equal(showGestureCamera(live, at(15), true, false), "now");
    assert.deepEqual(applied.map((c) => c.x), [5, 10, 15]);
    assert.equal(live.camera?.x, 15, "every move is written at once");
  });

  test("the move a gesture ends on sets state once, for the controllers and the saved views", () => {
    const { live } = withApplier(["inside"]);
    live.write(at(0));
    assert.equal(showGestureCamera(live, at(5), true, true), "later");
  });

  test("a zoom, and every move in Top-down, sets state, and never reaches the applier", () => {
    const { live, applied } = withApplier([]);
    live.write(at(0));
    assert.equal(showGestureCamera(live, at(3, 0, 14), true, false), "later", "a zoom");
    assert.equal(showGestureCamera(live, at(6, 0, 14), false, false), "later", "Top-down");
    assert.equal(applied.length, 0);
  });

  test("with no board shown there is no applier, and the move sets state", () => {
    const live = new LiveCamera();
    live.write(at(0));
    assert.equal(showGestureCamera(live, at(5), true, false), "later");
  });
});

describe("the slot's cameras", () => {
  test("a write and a drawn camera each notify once, and an equal camera notifies no one", () => {
    const live = new LiveCamera();
    let heard = 0;
    const stop = live.subscribe(() => heard++);
    live.write(at(1));
    live.write(at(1));
    live.setDrawn(at(1));
    live.setDrawn(at(1));
    assert.equal(heard, 2);
    stop();
    live.write(at(2));
    assert.equal(heard, 2);
  });

  test("a snapshot stays the same object until it changes, as useSyncExternalStore needs", () => {
    const live = new LiveCamera();
    live.setDrawn(at(1));
    const first = live.getDrawn();
    live.setDrawn(at(1));
    assert.equal(live.getDrawn(), first);
  });

  test("a press at the camera on screen reads the one the stages took on the device grid; any other camera reads as itself", () => {
    const live = new LiveCamera();
    const c = at(10.3);
    live.write(c);
    live.setApplied(c, at(10.5));
    assert.equal(live.appliedFor(c).x, 10.5);
    assert.equal(live.appliedFor(at(10.3)).x, 10.3, "a pending camera, not yet applied");
  });
});

describe("the camera the chrome hung on map points stands by", () => {
  test("in Isometric the camera the canvas last drew, whatever the render's own camera; in Top-down the rendered one", () => {
    const rendered = at(0);
    const drawn = at(40);
    assert.equal(chromeCameraOf({ iso: true, rendered }, drawn), drawn);
    assert.equal(chromeCameraOf({ iso: true, rendered }, null), rendered, "before the canvas drew anything");
    assert.equal(chromeCameraOf({ iso: false, rendered }, drawn), rendered);
  });
});

describe("the chrome's hook (useChromeCamera)", () => {
  /** Renders one piece of chrome in a room whose slot holds `camera` written and `drawn` drawn, and says where it stands. */
  function standsAt(chrome: Omit<ChromeCamera, "pickOf">, shown: boolean, camera: Camera, drawn: Camera | null): string {
    const scope = new RoomScope();
    const live = scope.get(liveCameraSlot);
    live.write(camera);
    if (drawn) live.setDrawn(drawn);
    function Chrome() {
      const at = useChromeCamera({ ...chrome, pickOf: () => ({}) as never }, shown);
      return createElement("i", null, at ? `${at.raw.x}` : "none");
    }
    return renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(Chrome) }));
  }

  test("in Isometric a shown piece stands by the camera drawn, not the one written ahead of it or the render's", () => {
    assert.equal(standsAt({ iso: true, rendered: at(0), zoom: 1 }, true, at(40), at(10)), "<i>10</i>");
    assert.equal(standsAt({ iso: true, rendered: at(0), zoom: 1 }, true, at(40), null), "<i>0</i>", "before the canvas drew anything");
    assert.equal(standsAt({ iso: false, rendered: at(0), zoom: 1 }, true, at(40), at(10)), "<i>0</i>", "Top-down");
    assert.equal(standsAt({ iso: true, rendered: at(0), zoom: 1 }, false, at(40), at(10)), "<i>none</i>", "shown nothing");
  });

  test("it reads the slot through useSyncExternalStore, never a copy in state an effect keeps, which misses a draw between the render and the effect", () => {
    const src = readFileSync(new URL("./liveCamera.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function useChromeCamera"));
    assert.match(body, /useSyncExternalStore\(/);
    assert.doesNotMatch(body, /\buse(State|Effect|LayoutEffect)\b/);
  });
});

describe("the camera's one source of truth, in the board's code (docs/design-v1-relief-pan.md 6.2)", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("the isometric stages take no camera props: only the applier positions them, so no render writes an older camera back", () => {
    const src = read("../canvas/relief/IsoBoard.tsx");
    const stages = [...src.matchAll(/<Stage\b[\s\S]*?>/g)].map((m) => m[0]);
    assert.equal(stages.length, 2);
    for (const s of stages) assert.doesNotMatch(s, /\b(x|y|scaleX|scaleY)=\{/, s.slice(0, 80));
  });

  test("camRef reads the slot and is never set from the render's state", () => {
    const src = read("../canvas/Stage.tsx");
    assert.doesNotMatch(src, /camRef\.current = cam;/);
    assert.match(src, /get current\(\): Camera \| null \{\s*return liveCam\.camera;/);
  });
});
