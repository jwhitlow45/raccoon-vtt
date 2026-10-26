import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_CELLS, type Pin, type RoomState } from "#shared/model.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { room, scene } from "#shared/testutil.ts";
import { boardPickFor, boardPickSlot, DrawnHeightsMemo, pressAt, viewGround } from "../../canvas/boardPick.ts";
import { screenToView, viewToScreen, type Camera } from "../../lib/camera.ts";
import { isometric, toWorld } from "../../lib/view.ts";
import { RoomScope } from "../../state/scope.ts";
import type { ToolContext, ToolPointer } from "../tools.ts";
import { PIN_HEIGHT_PX, pinScreenBox, pinTip } from "./rules.ts";
import { pinSlot } from "./store.ts";

const { pinTool } = await import("./PinTool.tsx");

const CAM: Camera = { x: 400, y: 120, scale: 40 };

/** A 16 by 16 scene with a 10 ft platform over cells 3 to 8 each way, and a pin on it. */
function shrine(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { bounds: { w: 16, h: 16 } });
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) feet[y * CHUNK_CELLS + x] = 10;
  state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: encodeHeights(feet) };
  state.pins.pin = { id: "pin", rev: 0, sceneId: "s1", x: 5.5, y: 5.5, color: "#f7df00", visibility: "all", label: "Old shrine" } as Pin;
  return state;
}

function setUp() {
  const state = shrine();
  const scope = new RoomScope();
  const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(1), camera: CAM, lowPower: false }, new DrawnHeightsMemo());
  scope.get(boardPickSlot).read = () => pick;
  const sent: unknown[] = [];
  const ctx = {
    actions: { dispatch: (op: unknown) => (sent.push(op), 1), newId: () => "new" },
    ui: { select: () => {} },
    getState: () => ({ view: state, local: { tool: "pin", selectedId: null } }),
    scene: state.scenes.s1!,
    role: "dm",
    camera: () => CAM,
    scope,
  } as unknown as ToolContext;
  const at = (screen: { x: number; y: number }): ToolPointer => ({ world: pressAt(pick, screen), screen, pointerId: 1, pointerType: "mouse", button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, tokenId: null });
  const tip = viewToScreen(CAM, pinTip(state.pins.pin!, viewGround(pick)));
  return { state, pick, ctx, sent, at, tip, head: { x: tip.x, y: tip.y - PIN_HEIGHT_PX / 2 } };
}

test("the Pin tool in Isometric: a tap on a pin standing on a 10 ft platform opens it, and its pane stands by it (ISO34-ASTRA-1)", () => {
  const { ctx, sent, at, tip, head, state, pick } = setUp();
  pinTool.pointer!.down!(at(head), ctx);
  pinTool.pointer!.up!(at(head), ctx);
  assert.equal(ctx.scope.get(pinSlot).store.getState().paneId, "pin", "the pin's pane opens, and no new pin is placed");
  assert.deepEqual(sent, []);
  const box = pinScreenBox(state.pins.pin!, CAM, viewGround(pick));
  assert.ok(Math.abs((box.x0 + box.x1) / 2 - tip.x) < 1e-9 && Math.abs(box.y1 - tip.y) < 1e-9, "the pane's box is the marker as drawn");
});

test("the Pin tool in Isometric drags a pin by its tip across the platform's top, under the finger", () => {
  const { ctx, sent, at, tip, head, pick } = setUp();
  pinTool.pointer!.down!(at(head), ctx);
  const to = { x: head.x + 60, y: head.y + 10 };
  pinTool.pointer!.move!(at(to), ctx);
  const drag = ctx.scope.get(pinSlot).store.getState().drag;
  const want = toWorld(pick.view, screenToView(CAM, { x: tip.x + 60, y: tip.y + 10 }), 2);
  assert.ok(drag && drag.id === "pin" && Math.abs(drag.x - want.x) < 0.01 && Math.abs(drag.y - want.y) < 0.01, JSON.stringify([drag, want]));
  pinTool.pointer!.up!(at(to), ctx);
  assert.equal((sent[0] as { t: string; pin: Pin }).t, "pin.put");
  assert.deepEqual({ x: (sent[0] as { pin: Pin }).pin.x, y: (sent[0] as { pin: Pin }).pin.y }, { x: drag!.x, y: drag!.y });
});
