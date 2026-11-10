import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { RoomState, Scene } from "#shared/model.ts";
import { RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { builderSlot } from "./store.ts";
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
