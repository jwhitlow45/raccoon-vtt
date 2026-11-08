import type { Scene } from "#shared/model.ts";
import { cameraForView, holdStill, type Camera, type Insets, type Size } from "../lib/camera.ts";
import { toView, type View } from "../lib/view.ts";
import { heldPoint, type BoardPick } from "./boardPick.ts";

type Ref<T> = { current: T };
type Selected = Parameters<typeof heldPoint>[2];

/**
 * The floors' scene a scene record belongs to (docs/design/design-v1-floors.md
 * 7.3): its main floor on a DM's copy, and on a player's, which carries no
 * main floor, the delivered floors of the scene by its name, since every
 * floor's record carries the scene's. Null on a scene of one floor.
 */
function floorGroup(scene: Pick<Scene, "name" | "floor">): string | null {
  if (!scene.floor) return null;
  return scene.floor.of ?? `\u0000${scene.name}`;
}

/** The floors' scene of the scene each canvas's camera stands on, by the canvas's camera-scene ref. */
const cameraGroups = new WeakMap<object, string | null>();

/**
 * The camera a newly shown scene opens on: its saved view, else a fit. It is
 * already in the view being shown, so `viewSeen` moves up with it and a turn
 * in the same commit must not convert it again from the previous scene's view.
 * Written as a plain function so the commit order can be driven without React.
 *
 * A switch to another floor of the same scene keeps the camera: floors line
 * up square for square, so the view stays on the same squares
 * (docs/design/design-v1-floors.md 7.3).
 */
export function openSceneCamera<Fit extends { cam: Camera }>(a: {
  size: Size | null;
  scene: Pick<Scene, "id" | "defaultView"> & Partial<Pick<Scene, "name" | "floor">>;
  shown: Ref<View>;
  viewSeen: Ref<View>;
  cameraScene: Ref<string | null>;
  pendingCam: Ref<Camera | null>;
  fitted: Ref<Fit | null>;
  cam: Ref<Camera | null>;
  groundUnder(at: { x: number; y: number }, zoom: number): number;
  fit(): Fit;
  setCam(c: Camera): void;
}): void {
  const { size, scene } = a;
  if (!size || a.cameraScene.current === scene.id) return;
  const group = floorGroup({ name: scene.name ?? "", floor: scene.floor });
  const was = cameraGroups.get(a.cameraScene);
  cameraGroups.set(a.cameraScene, group);
  const floorSwitch = a.cameraScene.current !== null && group !== null && was === group && a.cam.current !== null;
  a.cameraScene.current = scene.id;
  if (floorSwitch) return;
  a.viewSeen.current = a.shown.current;
  a.pendingCam.current = null;
  let next: Camera;
  if (scene.defaultView) {
    a.fitted.current = null;
    next = cameraForView(size, toView(a.shown.current, scene.defaultView, a.groundUnder(scene.defaultView, scene.defaultView.zoom)), scene.defaultView.zoom);
  } else {
    a.fitted.current = a.fit();
    next = a.fitted.current.cam;
  }
  a.cam.current = next;
  a.setCam(next);
}

/**
 * A turn or a view switch keeps one world point still on screen, and the zoom:
 * the selected token's ring while it shows in the clear part of the canvas,
 * else the ground a press at that part's middle meets. Each stands at its
 * drawn height in each view.
 */
export function holdViewStill<T extends NonNullable<Selected>>(a: {
  shown: View;
  viewSeen: Ref<View>;
  pendingCam: Ref<Camera | null>;
  cam: Ref<Camera | null>;
  size: Ref<Size | null>;
  fitted: Ref<unknown>;
  insets: Insets;
  pick(view: View, camera: Camera, size: Size): BoardPick;
  selected(): T | undefined;
  stands(pick: BoardPick, selected: T): boolean;
  setCam(c: Camera): void;
}): void {
  const before = a.viewSeen.current;
  a.viewSeen.current = a.shown;
  if (before === a.shown) return;
  const c = a.pendingCam.current ?? a.cam.current;
  const s = a.size.current;
  if (!c || !s) return;
  const was = a.pick(before, c, s);
  const now = a.pick(a.shown, c, s);
  const selected = a.selected();
  const held = heldPoint(was, now, selected, s, a.insets, (pick) => !selected || a.stands(pick, selected));
  const next = holdStill(c, toView(before, held.at, held.before), toView(a.shown, held.at, held.after));
  a.pendingCam.current = null;
  a.fitted.current = null;
  a.cam.current = next;
  a.setCam(next);
}
