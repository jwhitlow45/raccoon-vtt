import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import type { BuildChunk, FogOp, FogShape, TerrainId } from "#shared/model.ts";
import { clientMessageSchema, MAX_FOG_DRAFT_OPS } from "#shared/protocol.ts";
import { sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { deriveWalls, indexBuild } from "#shared/rules/walls.ts";
import { room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { ToolContext } from "../tools.ts";
import { fogMessages, fogOps, hexRoomShapes, MAX_FOG_MESSAGE_BYTES, roomShapes, strokeShapes, type FogMessage } from "./shapes.ts";
import { fogSlot } from "./store.ts";

const { submitFog } = await import("./tool.tsx");

/**
 * A fog gesture never sends a message bigger than a socket frame (review
 * H3-OPUS-01): the server closes a socket on one, and the outbox would send
 * it again on every reconnect. A Builder room on a large hex scene, a large
 * square room and a long brush stroke each go as several messages under one
 * undo step.
 */

/** server/rooms/ws.ts MAX_FRAME_BYTES, which client code cannot import. */
const MAX_FRAME_BYTES = 64 * 1024;
const SCENE_ID = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
const GROUP = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c";

let n = 0;
const newId = () => `0192a3b4-c5d6-7e8f-9a0b-${String(n++).padStart(12, "0")}`;

/** Every message fits a frame with the outbox's own wrapper and a group, the schema takes it, and the messages carry every op once, in order. */
function assertFits(messages: FogMessage[], ops: FogOp[]): void {
  for (const op of messages) {
    const frame = { t: "op", n: 2 ** 31, op, g: GROUP };
    assert.ok(serializedBytes(op) <= MAX_FOG_MESSAGE_BYTES, `${op.t} of ${serializedBytes(op)} bytes`);
    assert.ok(serializedBytes(frame) <= MAX_FRAME_BYTES, `a frame of ${serializedBytes(frame)} bytes`);
    assert.ok(clientMessageSchema.safeParse(frame).success, "the schema takes the frame");
    const carried = op.t === "fog.live" ? op.ops : (op.add ?? []);
    assert.ok(carried.length > 0 && carried.length <= MAX_FOG_DRAFT_OPS);
  }
  const sent = messages.flatMap((m) => (m.t === "fog.live" ? m.ops : (m.add ?? [])));
  assert.deepEqual(
    sent.map((o) => o.id),
    ops.map((o) => o.id),
  );
}

function largestHexRoom(g: HexGrid): FogShape[] {
  const bounds = { w: 200, h: 200 };
  return hexRoomShapes(deriveWalls(indexBuild([]), "v", { bounds }), g, { x: 100, y: 100 }, bounds);
}

function largestSquareRoom(): FogShape[] {
  const cells: Record<string, TerrainId> = {};
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) cells[`${x},${y}`] = "stone";
  const chunk: BuildChunk = { sceneId: SCENE_ID, cx: 0, cy: 0, rev: 0, cells, edges: {} };
  return roomShapes(indexBuild([chunk]), { x: 100.5, y: 100.5 }, { w: 200, h: 200 }).shapes;
}

/** A brush dragged back and forth across a 200 cell scene, its points never on a straight line. */
function longStroke(): FogShape[] {
  const points = Array.from({ length: 6000 }, (_, i) => ({ x: 100 + 90 * Math.sin(i / 7.3) + i / 997, y: 100 + 90 * Math.cos(i / 11.1) - i / 1009 }));
  return strokeShapes(points, 2);
}

describe("a fog gesture's messages", () => {
  test("leave room in a frame for the outbox's wrapper round the op: its kind, number and undo group", () => {
    const wrapper = serializedBytes({ t: "op", n: 2 ** 53, op: {}, g: GROUP });
    assert.ok(MAX_FOG_MESSAGE_BYTES + wrapper <= MAX_FRAME_BYTES, `${MAX_FOG_MESSAGE_BYTES} + ${wrapper}`);
  });

  for (const [name, shapes] of [
    ["the Builder room of an open 200 by 200 hex rows scene", () => largestHexRoom({ shape: "hex", orient: "rows" })],
    ["the Builder room of an open 200 by 200 hex columns scene", () => largestHexRoom({ shape: "hex", orient: "columns" })],
    ["a square room filling a 200 by 200 scene", largestSquareRoom],
    ["a long brush stroke", longStroke],
  ] as const) {
    test(`${name} goes as messages that each fit a socket frame, drafted and live`, () => {
      const ops = fogOps(shapes(), "reveal", newId);
      assert.ok(serializedBytes(ops) > MAX_FRAME_BYTES, `the gesture is ${serializedBytes(ops)} bytes, more than one frame holds`);
      for (const live of [false, true]) {
        const messages = fogMessages(SCENE_ID, ops, live);
        assert.ok(messages.length > 1);
        assert.ok(messages.every((m) => m.t === (live ? "fog.live" : "fog.draft")));
        assertFits(messages, ops);
      }
    });
  }

  test("a small gesture is one message, and a live one of many small ops splits at the op cap", () => {
    const rects: FogShape[] = Array.from({ length: 1200 }, (_, i) => ({ kind: "rect", x: i % 100, y: Math.floor(i / 100), w: 1, h: 1 }));
    const one = fogOps(rects.slice(0, 3), "hide", newId);
    assert.deepEqual(fogMessages(SCENE_ID, one, false), [{ t: "fog.draft", sceneId: SCENE_ID, add: one }]);
    // Short ids keep 500 of them under the byte limit, so the op cap is what splits them.
    let k = 0;
    const many = fogOps(rects, "reveal", () => `r${k++}`);
    const messages = fogMessages(SCENE_ID, many, true);
    assert.deepEqual(
      messages.map((m) => (m.t === "fog.live" ? m.ops.length : 0)),
      [500, 500, 200],
    );
    assertFits(messages, many);
  });

  test("the hex scene's whole room reaches the draft in messages of one undo group, and a full draft sends nothing", () => {
    const state = room();
    state.scenes[SCENE_ID] = scene(SCENE_ID, { bounds: { w: 200, h: 200 }, gridShape: "hexRows" });
    const scope = new RoomScope();
    const sent: { op: FogMessage; group: string | undefined }[] = [];
    const ctx = {
      actions: { dispatch: (op: FogMessage, opts?: { group?: string }) => (sent.push({ op, group: opts?.group }), sent.length), newId },
      getState: () => ({ view: state }),
      scene: state.scenes[SCENE_ID]!,
      scope,
    } as unknown as Pick<ToolContext, "scene" | "actions" | "getState" | "scope">;
    const shapes = largestHexRoom({ shape: "hex", orient: "rows" });
    submitFog(ctx, shapes);
    assert.ok(sent.length > 1);
    assert.equal(new Set(sent.map((s) => s.group)).size, 1, "one group");
    assert.ok(sent[0]!.group !== undefined, "a group, so one undo takes the room back");
    const cells = sent.flatMap((s) => (s.op.t === "fog.draft" ? (s.op.add ?? []) : [])).flatMap((o) => (o.shape.kind === "cells" ? o.shape.cells : []));
    assert.equal(cells.length, sceneHexes({ shape: "hex", orient: "rows" }, { w: 200, h: 200 }).length);
    for (const { op } of sent) assert.ok(serializedBytes({ t: "op", n: 1, op, g: GROUP }) <= MAX_FRAME_BYTES);

    sent.length = 0;
    state.fogDrafts[SCENE_ID] = { sceneId: SCENE_ID, rev: 0, ops: fogOps(Array.from({ length: MAX_FOG_DRAFT_OPS - 2 }, () => ({ kind: "all" }) as FogShape), "hide", newId) };
    submitFog(ctx, shapes);
    assert.equal(sent.length, 0, "a draft without room for the gesture sends none of it");
    assert.equal(scope.get(fogSlot).store.getState().note, "The draft is full. Reveal it to the players or discard it first.");

    sent.length = 0;
    scope.get(fogSlot).store.setState({ live: true, note: null });
    submitFog(ctx, shapes);
    assert.ok(sent.length > 1 && sent.every((s) => s.op.t === "fog.live" && s.group === sent[0]!.group), "live, the draft's room never matters");
  });
});
