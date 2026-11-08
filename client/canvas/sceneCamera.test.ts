import assert from "node:assert/strict";
import { test } from "node:test";
import { room, scene } from "#shared/testutil.ts";
import { cameraForView, NO_INSETS, viewToScreen, type Camera, type Rect, type Size } from "../lib/camera.ts";
import { RoomScope } from "../state/scope.ts";
import { isometric, TOP_DOWN, toView, type View } from "../lib/view.ts";
import { boardPickFor, DrawnHeightsMemo } from "./boardPick.ts";
import { fitSlot, openFramed } from "./fitSlot.ts";
import { holdViewStill, openSceneCamera } from "./sceneCamera.ts";

// Run the scene and view effects in their real commit order (the scene's
// first, as Stage declares them). Camera math and ground picking stay real,
// so a double conversion moves the measured target.
function commit(before: View, shown: View, changedScene: boolean, saved = true) {
  const size = { width: 920, height: 800 };
  const target = { x: 12, y: 9, zoom: 40 };
  const current = scene("cavern", { bounds: { w: 24, h: 20 }, ...(saved ? { defaultView: target } : {}) });
  const state = room({ scenes: { cavern: current } });
  const camRef = { current: cameraForView(size, toView(before, target), target.zoom) as Camera | null };
  const viewSeen = { current: before };
  const cameras: Camera[] = [];
  const fitted = { cam: cameraForView(size, toView(shown, target), target.zoom) };
  // A fit still standing from before a same-scene turn: the turn moves the camera off it.
  const fittedRef = { current: (changedScene ? null : fitted) as typeof fitted | null };
  const pendingCam = { current: null as Camera | null };
  const setCam = (c: Camera) => cameras.push(c);
  const shownRef = { current: shown };
  openSceneCamera({
    size, scene: current, shown: shownRef, viewSeen, cameraScene: { current: changedScene ? "previous" : current.id }, pendingCam, fitted: fittedRef, cam: camRef,
    groundUnder: () => 0,
    fit: () => { assert.equal(saved, false); return fitted; },
    setCam,
  });
  const heights = new DrawnHeightsMemo();
  holdViewStill({
    shown, viewSeen, pendingCam, cam: camRef, size: { current: size }, fitted: fittedRef, insets: NO_INSETS,
    pick: (view, camera, s) => boardPickFor({ room: state, scene: current, role: "dm", fog: false, view, camera, lowPower: false, canvasHeight: s.height }, heights),
    selected: () => undefined,
    stands: () => true,
    setCam,
  });
  return { cam: camRef.current!, cameras, size, target, fittedRef };
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
  const { cam, cameras, size, target, fittedRef } = commit(isometric(3), shown, false);
  const center = viewToScreen(cam, toView(shown, target));
  assert.ok(Math.abs(center.x - size.width / 2) < 1e-9 && Math.abs(center.y - size.height / 2) < 1e-9);
  assert.equal(cam.scale, 40);
  assert.equal(cameras.length, 1, "the same-scene turn applies its camera");
  assert.equal(fittedRef.current, null, "the turned camera is no longer the fit");
});

/**
 * Stage's opening effect as it runs on each commit of a size or a scene
 * (fitSlot.ts `openFramed`), with a fit that records what it was asked to
 * frame.
 */
function canvas(scope: RoomScope) {
  const cameraScene = { current: null as string | null };
  const framed: (Rect | null)[] = [];
  const cameras: Camera[] = [];
  const open = (size: Size | null, s: ReturnType<typeof scene>) => {
    openFramed(scope.get(fitSlot), {
      size, scene: s, shown: { current: TOP_DOWN }, viewSeen: { current: TOP_DOWN }, cameraScene, pendingCam: { current: null }, fitted: { current: null }, cam: { current: null },
      groundUnder: () => 0,
      fit: (frame) => {
        framed.push(frame);
        return { cam: { x: 0, y: 0, scale: 10 } };
      },
      setCam: (c) => cameras.push(c),
    });
  };
  return { open, framed, cameras };
}

const ENTRANCE = { x: 2, y: 20, width: 14, height: 13 };
const SIZE = { width: 920, height: 800 };

test("DG-C DG-OPUS-27: a canvas sized late frames the entrance once its size comes, and only once", () => {
  const scope = new RoomScope();
  const crypt = scene("crypt", { bounds: { w: 50, h: 50 } });
  const c = canvas(scope);
  scope.get(fitSlot).frameOnOpen = { sceneId: crypt.id, rect: ENTRANCE };
  c.open(null, crypt);
  assert.deepEqual(c.framed, [], "no size, no opening");
  c.open(SIZE, crypt);
  assert.deepEqual(c.framed, [ENTRANCE]);
  c.open({ width: 600, height: 800 }, crypt);
  assert.deepEqual(c.framed, [ENTRANCE], "a new size on the open scene is not a new opening");
  assert.equal(scope.get(fitSlot).frameOnOpen, null);
});

test("DG-C DG-OPUS-27: a scene with a saved view opening first drops the request, so the new scene opens on a plain fit", () => {
  const scope = new RoomScope();
  const crypt = scene("crypt", { bounds: { w: 50, h: 50 } });
  const arena = scene("arena", { bounds: { w: 20, h: 20 }, defaultView: { x: 10, y: 10, zoom: 40 } });
  const c = canvas(scope);
  c.open(SIZE, scene("start", { bounds: { w: 30, h: 20 } }));
  scope.get(fitSlot).frameOnOpen = { sceneId: crypt.id, rect: ENTRANCE };
  c.open(SIZE, arena);
  assert.equal(scope.get(fitSlot).frameOnOpen, null, "taken by the saved view's opening, which never fits");
  c.open(SIZE, crypt);
  assert.deepEqual(c.framed, [null, null], "the start scene and the generated one both fit whole");
});

test("DG-C DG-OPUS-27: View as a player, its own scope, opens the same scene on a plain fit and leaves the DM's request", () => {
  const dm = new RoomScope();
  const preview = new RoomScope();
  const crypt = scene("crypt", { bounds: { w: 50, h: 50 } });
  dm.get(fitSlot).frameOnOpen = { sceneId: crypt.id, rect: ENTRANCE };
  const player = canvas(preview);
  player.open(SIZE, crypt);
  assert.deepEqual(player.framed, [null]);
  const own = canvas(dm);
  own.open(SIZE, crypt);
  assert.deepEqual(own.framed, [ENTRANCE]);
});

test("a switch to another floor of the same scene keeps the camera, and another scene or a scene of one floor opens anew (docs/design/design-v1-floors.md 7.3)", () => {
  const size = { width: 920, height: 800 };
  const panned: Camera = { x: -300, y: -120, scale: 55 };
  const floor = (id: string, level: number, of?: string) => scene(id, { name: "Tower", bounds: { w: 24, h: 20 }, defaultView: { x: 4, y: 4, zoom: 30 }, floor: { ...(of ? { of } : {}), level, name: id } });
  const run = (shown: ReturnType<typeof scene>[]) => {
    const cameraScene = { current: null as string | null };
    const cam = { current: null as Camera | null };
    const opened: Camera[] = [];
    for (const s of shown) {
      openSceneCamera({
        size, scene: s, shown: { current: TOP_DOWN }, viewSeen: { current: TOP_DOWN }, cameraScene, pendingCam: { current: null }, fitted: { current: null }, cam,
        groundUnder: () => 0,
        fit: () => ({ cam: { x: 0, y: 0, scale: 10 } }),
        setCam: (c) => opened.push(c),
      });
      // The viewer pans after each opening.
      cam.current = panned;
    }
    return { opened: opened.length, cam: cam.current, at: cameraScene.current };
  };
  // A DM's floors name their main floor, a player's carry none and share the scene's name.
  assert.deepEqual(run([floor("ground", 0, "ground"), floor("upper", 1, "ground"), floor("ground", 0, "ground")]), { opened: 1, cam: panned, at: "ground" });
  assert.deepEqual(run([floor("ground", 0), floor("upper", 1)]), { opened: 1, cam: panned, at: "upper" });
  assert.equal(run([floor("ground", 0, "ground"), floor("keep", 1, "keep")]).opened, 2, "floors of another scene open on their own view");
  assert.equal(run([scene("cave"), scene("crypt")]).opened, 2, "scenes of one floor each open on their own view");
  assert.equal(run([floor("ground", 0, "ground"), scene("cave")]).opened, 2);
});
