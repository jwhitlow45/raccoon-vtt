import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { room, scene } from "#shared/testutil.ts";
import { cameraForView, holdStill, NO_INSETS, viewToScreen, type Camera } from "../lib/camera.ts";
import { isometric, TOP_DOWN, toView, type View } from "../lib/view.ts";
import { boardPickFor, DrawnHeightsMemo, heldPoint, standsFor } from "./boardPick.ts";

// Run the scene and view effects in their real commit order. Camera math and
// ground picking stay real, so a double conversion moves the measured target.
const source = readFileSync(new URL("./Stage.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const insetsRef = useRef(insets);");
const end = source.indexOf("  }, [shown]);", start) + "  }, [shown]);".length;
assert.ok(start >= 0 && end > start);
const effectSource = stripTypeScriptTypes(source.slice(start, end));

function commit(before: View, shown: View, changedScene: boolean, saved = true) {
  const size = { width: 920, height: 800 };
  const target = { x: 12, y: 9, zoom: 40 };
  const current = scene("cavern", { bounds: { w: 24, h: 20 }, ...(saved ? { defaultView: target } : {}) });
  const state = room({ scenes: { cavern: current } });
  const camRef = { current: cameraForView(size, toView(before, target), target.zoom) };
  const previousView = { current: before };
  const effects: (() => void)[] = [];
  const cameras: Camera[] = [];
  const fitted = { cam: cameraForView(size, toView(shown, target), target.zoom) };
  const bindings = {
    useRef: (value: unknown) => value === shown ? previousView : { current: value },
    useLayoutEffect: (effect: () => void) => effects.push(effect),
    size, scene: current, shown, insets: NO_INSETS,
    cameraSceneRef: { current: changedScene ? "previous" : current.id },
    pendingCamRef: { current: null }, fittedRef: { current: null },
    shownRef: { current: shown }, groundUnderRef: { current: () => 0 },
    camRef, setCam: (c: Camera) => cameras.push(c),
    cameraForView, toView, NO_INSETS,
    fitScene: () => { assert.equal(saved, false); return fitted; }, liftRef: { current: () => 0 },
    sizeRef: { current: size },
    boardPickFor, role: "dm", sceneRef: { current }, fogRef: { current: { on: false } },
    lowPowerRef: { current: false }, heightsMemoRef: { current: new DrawnHeightsMemo() },
    store: { getState: () => ({ view: state, local: { selectedId: null } }) },
    tokensByIdRef: { current: new Map() }, aboveFogRef: { current: () => false },
    heldPoint, standsFor, holdStill,
  };
  new Function(...Object.keys(bindings), effectSource)(...Object.values(bindings));
  for (const effect of effects) effect();
  return { cam: camRef.current, cameras, size, target };
}

test("FU40-B ISOA-5: a new scene's saved camera is not converted again from the previous scene's turn", () => {
  for (const before of [isometric(3), TOP_DOWN, isometric(0), isometric(1), isometric(2)]) {
    const shown = isometric(0);
    const { cam, cameras, size, target } = commit(before, shown, true);
    const center = viewToScreen(cam, toView(shown, target));
    assert.deepEqual(center, { x: size.width / 2, y: size.height / 2 }, `from ${JSON.stringify(before)}: saved center moved to ${JSON.stringify(center)}`);
    assert.equal(cameras.length, 1, "only the scene's saved camera is applied");
  }
});

test("FU40-B ISOA-5: a new scene's fit also stays in that scene's view", () => {
  const shown = isometric(0);
  const { cam, cameras, size, target } = commit(isometric(3), shown, true, false);
  assert.deepEqual(cam, cameraForView(size, toView(shown, target), target.zoom));
  assert.equal(cameras.length, 1, "the fitted camera is not converted a second time");
});

test("FU40-B ISOA-5: turning inside the same scene still holds its center and zoom", () => {
  const shown = isometric(0);
  const { cam, cameras, size, target } = commit(isometric(3), shown, false);
  const center = viewToScreen(cam, toView(shown, target));
  assert.ok(Math.abs(center.x - size.width / 2) < 1e-9 && Math.abs(center.y - size.height / 2) < 1e-9);
  assert.equal(cam.scale, 40);
  assert.equal(cameras.length, 1, "the same-scene turn applies its camera");
});
