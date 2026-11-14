import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { RoomState, Scene } from "#shared/model.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { builderSlot, NO_WING, type WingPicks } from "./store.ts";
import type { WingGhost } from "./wingGhost.ts";
import { withWingMode } from "./wingPick.ts";

/*
 * A tap on the wing's ghost with the pane's Edit rooms on opens that room's
 * panel (dungeon phase 3, 3.3): the store names the room by its number, and
 * the tap picks no join. With Edit rooms off the tap picks a join as before.
 */

const SCALE = 40;
let ctx: ToolContext;
const ghost = { sceneId: "scene", area: { x: 10, y: 10, w: 20, h: 20 }, offset: { x: 10, y: 10 }, chunks: [], walls: { bounds: { w: 40, h: 40 } }, traps: [], lights: [], rooms: [{ n: 2, x: 4, y: 4, rect: { x: 2, y: 2, w: 4, h: 4 } }] } as unknown as WingGhost;

beforeEach(() => {
  ctx = {
    actions: {} as RoomActions,
    ui: {} as RoomUi,
    getState: () => ({ floorView: { scenes: {}, buildChunks: {} } as unknown as RoomState }) as unknown as RoomView,
    scene: { id: "scene", bounds: { w: 40, h: 40 } } as Scene,
    role: "dm",
    camera: () => ({ x: 0, y: 0, scale: SCALE }),
    scope: new RoomScope(),
  };
  ctx.scope.get(builderSlot).store.setState({ mode: "wing", wingOpen: true, wingEdit: true, wingGhost: ghost, wingRoom: null });
});

const at = (x: number, y: number): ToolPointer => ({ screen: { x: x * SCALE, y: y * SCALE }, world: { x, y } }) as ToolPointer;
function tap(x: number, y: number): void {
  const pointer = withWingMode({});
  pointer.down?.(at(x, y), ctx);
  pointer.up?.(at(x, y), ctx);
}

test("a tap inside a ghost room, where it stands on the scene, opens its panel by number", () => {
  tap(14, 14);
  assert.equal(ctx.scope.get(builderSlot).store.getState().wingRoom, 2);
});

test("with Edit rooms off, or away from every room, the tap opens no panel", () => {
  tap(30, 30);
  assert.equal(ctx.scope.get(builderSlot).store.getState().wingRoom, null);
  ctx.scope.get(builderSlot).store.setState({ wingEdit: false });
  tap(14, 14);
  assert.equal(ctx.scope.get(builderSlot).store.getState().wingRoom, null);
});

/*
 * A tap near no wall (LP37-A-WING-4): with the pane closed it clears the
 * join, so the row asks for a wall and Generate a wing waits for one, as
 * the line says. With the pane open the pane's join stays, and so do its
 * choices and edits, and nothing claims otherwise. Add a wing's picks
 * cleared also clear the note, so no line outlives an added wing.
 */
const AREA = { x: 10, y: 10, w: 20, h: 20 };
const PICKS = { sceneId: "scene", area: AREA, tap: { grid: "squares", key: "9,12,w" }, join: { tap: { grid: "squares", key: "9,12,w" }, leaves: [], expect: { grid: "squares", edges: [] } } } as unknown as WingPicks;
/** A tap far from every grid line: at 100 px a cell, 22 px reaches a fifth of a cell, and a cell's middle is half a cell from each edge. */
function tapNearNothing(): void {
  ctx = { ...ctx, camera: () => ({ x: 0, y: 0, scale: 100 }) };
  const pointer = withWingMode({});
  const p = { screen: { x: 550, y: 550 }, world: { x: 5.5, y: 5.5 } } as ToolPointer;
  pointer.down?.(p, ctx);
  pointer.up?.(p, ctx);
}

test("with the pane closed, a tap near no wall clears the join and keeps the area, and the row's own line asks for a wall", () => {
  const store = ctx.scope.get(builderSlot).store;
  store.setState({ wingOpen: false, wingEdit: false, wingGhost: null, wing: PICKS, note: "Tap a wall or door between floor and empty ground." });
  tapNearNothing();
  const s = store.getState();
  assert.deepEqual(s.wing, { ...PICKS, tap: null, join: null });
  assert.equal(s.note, null);
});

test("with the pane open, a tap near no wall keeps the pane's join and says nothing", () => {
  const store = ctx.scope.get(builderSlot).store;
  store.setState({ wingOpen: true, wingEdit: false, wing: PICKS, note: null });
  tapNearNothing();
  const s = store.getState();
  assert.equal(s.wing, PICKS);
  assert.equal(s.note, null);
});

/*
 * The same at a fit view (LP39B-WING-1): live play 39's Keep, 60 by 40 with
 * a 9 by 9 room, at 10 px a square. A tap reached 22 px from any grid line,
 * so every tap there was on a bare edge that is no join: it kept the join
 * and asked for a wall beside Generate a wing. The reach is from a wall.
 */
const KEEP = apply(room({ scenes: { s1: scene("s1", { bounds: { w: 60, h: 40 } }) } }), { t: "build.rect", sceneId: "s1", terrain: "stone", x: 4, y: 4, w: 9, h: 9 });
const FIT = 10;
/** A tap at a world point on the Keep at 10 px a square, its area dragged first. */
function tapKeep(x: number, y: number): void {
  ctx = { ...ctx, scene: KEEP.scenes.s1!, getState: () => ({ floorView: KEEP }) as unknown as RoomView, camera: () => ({ x: 0, y: 0, scale: FIT }) };
  const pointer = withWingMode({});
  const p = { screen: { x: x * FIT, y: y * FIT }, world: { x, y } } as ToolPointer;
  pointer.down?.(p, ctx);
  pointer.up?.(p, ctx);
}
const KEEP_AREA = { x: 22, y: 4, w: 26, h: 26 };

test("at a fit view, a tap 2 px off the room's east wall joins it, and with the pane closed a tap in open ground clears the join and the note", () => {
  const store = ctx.scope.get(builderSlot).store;
  store.setState({ wingOpen: false, wingEdit: false, wingGhost: null, wing: { sceneId: "s1", area: KEEP_AREA, tap: null, join: null }, note: null });
  tapKeep(13.2, 8.5);
  assert.deepEqual(store.getState().wing?.tap, { grid: "squares", key: "13,8,w" }, "the room's east wall");
  assert.notEqual(store.getState().wing?.join, null);
  // A square's middle in open ground, as live play 39 tapped it, and one a quarter square off a grid line.
  for (const [x, y] of [[30.5, 36.5], [30.25, 36.5]] as const) {
    tapKeep(13.2, 8.5);
    tapKeep(x, y);
    const s = store.getState();
    assert.deepEqual([s.wing?.area, s.wing?.tap, s.wing?.join, s.note], [KEEP_AREA, null, null, null], `${x}, ${y}: the join cleared, the row's own line asking for a wall`);
  }
});

test("at a fit view, with the pane open a tap in open ground keeps the pane's join and clears the note, and a grid line between two floor squares is no wall either", () => {
  const store = ctx.scope.get(builderSlot).store;
  store.setState({ wingOpen: false, wingEdit: false, wingGhost: null, wing: { sceneId: "s1", area: KEEP_AREA, tap: null, join: null }, note: null });
  tapKeep(13.2, 8.5);
  const joined = store.getState().wing;
  store.setState({ wingOpen: true, note: "Tap a wall or door between floor and empty ground." });
  for (const [x, y] of [[30.5, 36.5], [8, 8.5]] as const) {
    tapKeep(x, y);
    assert.deepEqual(store.getState().wing, joined, `${x}, ${y}: the pane's join stays`);
    assert.equal(store.getState().note, null, `${x}, ${y}: and nothing claims otherwise`);
  }
});

test("Add a wing's picks cleared, as an added wing clears them, clear the note too", () => {
  const store = ctx.scope.get(builderSlot).store;
  store.setState({ wing: PICKS, note: "Tap a wall or door between floor and empty ground." });
  store.setState({ ...NO_WING });
  assert.equal(store.getState().note, null);
  assert.equal(store.getState().wing, null);
});
