import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CHUNK_CELLS, type BuildChunk, type RoomState, type Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { RoomScope } from "../../../state/scope.ts";
import type { RoomUi } from "../../../state/store.ts";
import type { RoomActions, RoomView } from "../../../state/types.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../../tools.ts";
import { builderSlot } from "../store.ts";
import { withHeightMode } from "./pointer.ts";
import { heightSlot } from "./store.ts";

let sent: { op: ClientOp; group: string | undefined }[];
let chunks: Record<string, BuildChunk>;
let ctx: ToolContext;
let ids: number;
let below: string[];

const handlers: ToolPointerHandlers = {
  down: () => void below.push("down"),
  move: () => void below.push("move"),
  up: () => void below.push("up"),
  cancel: () => void below.push("cancel"),
};
const pointer = withHeightMode(handlers);

function at(x: number, y: number, pointerType = "mouse"): ToolPointer {
  return { world: { x, y }, screen: { x: x * 40, y: y * 40 }, pointerId: 1, pointerType, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, tokenId: null };
}

beforeEach(() => {
  sent = [];
  below = [];
  ids = 0;
  chunks = {};
  const actions = {
    dispatch(op: ClientOp, opts?: { group?: string }) {
      sent.push({ op, group: opts?.group });
      return sent.length;
    },
    newId: () => `id-${++ids}`,
  } as unknown as RoomActions;
  ctx = {
    actions,
    ui: {} as RoomUi,
    getState: () => ({ view: { buildChunks: chunks } as unknown as RoomState, local: { tool: "build" } }) as unknown as RoomView,
    scene: { id: "scene", bounds: { w: 20, h: 12 } } as Scene,
    role: "dm",
    camera: () => ({ x: 0, y: 0, scale: 40 }),
    scope: new RoomScope(),
  };
  ctx.scope.get(builderSlot).store.setState({ mode: "height" });
});

afterEach(() => {
  pointer.cancel?.(ctx);
});

describe("Height mode's gestures", () => {
  test("a brush stroke paints the cells it crosses as one undo step", () => {
    ctx.scope.get(heightSlot).store.setState({ paint: "height", shape: 1, height: 15 });
    pointer.down?.(at(1.5, 1.5), ctx);
    pointer.move?.(at(3.5, 1.5), ctx);
    pointer.up?.(at(3.5, 1.5), ctx);
    assert.deepEqual(
      sent.map((s) => s.op),
      [{ t: "build.height", sceneId: "scene", cells: ["1,1", "2,1", "3,1"], height: 15 }],
    );
    assert.equal(sent[0]!.group, "id-1");
    assert.deepEqual(ctx.scope.get(heightSlot).store.getState().unsent, []);
    assert.deepEqual(below, []);
  });

  test("an area paints the cells between its corners when the drag ends", () => {
    ctx.scope.get(heightSlot).store.setState({ paint: "height", shape: "area", height: -10 });
    pointer.down?.(at(1.2, 1.2), ctx);
    pointer.move?.(at(2.8, 2.2), ctx);
    assert.deepEqual(ctx.scope.get(heightSlot).store.getState().area, { a: { x: 1.2, y: 1.2 }, b: { x: 2.8, y: 2.2 } });
    assert.equal(sent.length, 0);
    pointer.up?.(at(2.8, 2.2), ctx);
    assert.deepEqual(
      sent.map((s) => s.op),
      [{ t: "build.height", sceneId: "scene", cells: ["1,1", "2,1", "1,2", "2,2"], height: -10 }],
    );
    assert.equal(ctx.scope.get(heightSlot).store.getState().area, null);
  });

  test("the stairs brush marks cells, and remove takes away only marks that are there", () => {
    const marks = ".".repeat(CHUNK_CELLS * CHUNK_CELLS).split("");
    marks[CHUNK_CELLS + 2] = "e";
    chunks["scene:0,0"] = { sceneId: "scene", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, up: marks.join("") };
    ctx.scope.get(heightSlot).store.setState({ paint: "stairs", shape: 1, stairs: "remove" });
    pointer.down?.(at(1.5, 1.5), ctx);
    pointer.move?.(at(2.5, 1.5), ctx);
    pointer.up?.(at(2.5, 1.5), ctx);
    assert.deepEqual(
      sent.map((s) => s.op),
      [{ t: "build.stairs", sceneId: "scene", cells: ["2,1"], up: null }],
    );
  });

  test("a finger's stroke cut short by a second finger sends nothing", () => {
    ctx.scope.get(heightSlot).store.setState({ paint: "height", shape: 2, height: 5 });
    pointer.down?.(at(4, 4, "touch"), ctx);
    pointer.move?.(at(6, 4, "touch"), ctx);
    pointer.cancel?.(ctx);
    assert.deepEqual(sent, []);
    assert.deepEqual(ctx.scope.get(heightSlot).store.getState().unsent, []);
    assert.deepEqual(below, ["cancel"]);
  });

  test("a gesture begun in Height mode ends there, whatever the mode is by then", () => {
    ctx.scope.get(heightSlot).store.setState({ paint: "height", shape: "area", height: 5 });
    pointer.down?.(at(1.5, 1.5), ctx);
    ctx.scope.get(builderSlot).store.setState({ mode: "paint" });
    pointer.move?.(at(2.5, 1.5), ctx);
    pointer.up?.(at(2.5, 1.5), ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(below, []);
  });

  test("in the builder's other modes the gestures go to the builder", () => {
    ctx.scope.get(builderSlot).store.setState({ mode: "paint" });
    pointer.down?.(at(1.5, 1.5), ctx);
    pointer.move?.(at(2.5, 1.5), ctx);
    pointer.up?.(at(2.5, 1.5), ctx);
    assert.deepEqual(below, ["down", "move", "up"]);
    assert.deepEqual(sent, []);
  });

  test("an area ends on the scene it began on: after a scene switch it sends nothing", () => {
    ctx.scope.get(heightSlot).store.setState({ paint: "height", shape: "area", height: 5 });
    pointer.down?.(at(1.5, 1.5), ctx);
    ctx = { ...ctx, scene: { id: "other", bounds: { w: 20, h: 12 } } as Scene };
    pointer.up?.(at(2.5, 1.5), ctx);
    assert.deepEqual(sent, []);
  });
});
