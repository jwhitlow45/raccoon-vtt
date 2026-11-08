import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import type { BuildChunk, FogOp, FogShape, TerrainId } from "#shared/model.ts";
import { clientMessageSchema, MAX_FOG_DRAFT_OPS } from "#shared/protocol.ts";
import { sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { deriveWalls, indexBuild } from "#shared/rules/walls.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, env, rng, room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { ToolContext } from "../tools.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { cellsOutline, draftEdits, draftOutlines, fogEditOf, fogMessages, fogOps, hexCellsOutline, hexRoomShapes, lastEditIds, MAX_FOG_MESSAGE_BYTES, opKey, publishLabel, publishShort, rectShape, roomShapes, strokeShapes, type FogMessage } from "./shapes.ts";
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
      getState: () => ({ view: state, floorView: state }),
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

describe("a fog gesture in the draft is one edit", () => {
  const ROWS: HexGrid = { shape: "hex", orient: "rows" };
  const rect = (x: number) => rectShape({ x, y: 1 }, { x: x + 2, y: 3 })!;

  test("a gesture of several shapes names its ops after it, and one of a single shape keeps a plain id", () => {
    const room = fogOps(largestHexRoom(ROWS), "reveal", newId);
    assert.ok(room.length > 1);
    assert.equal(new Set(room.map((o) => o.id)).size, room.length, "each op its own id");
    assert.equal(new Set(room.map((o) => fogEditOf(o.id))).size, 1, "all of one edit");
    assert.ok(room.every((o) => o.id.length <= 64));
    assert.ok(clientMessageSchema.safeParse({ t: "op", n: 1, op: fogMessages(SCENE_ID, room, false)[0] }).success);
    const [one] = fogOps([rect(1)], "reveal", newId);
    assert.equal(fogEditOf(one!.id), one!.id);
  });

  test("an id is read as a gesture's only in the form fogOps makes, so an older draft's dotted ids stay edits of their own", () => {
    const rect = (id: string, mode: "reveal" | "hide", x: number): FogOp => ({ id, mode, shape: { kind: "rect", x, y: 1, w: 2, h: 2 } });
    const legacy = [rect("draft.1", "reveal", 1), rect("draft.2", "hide", 4)];
    assert.equal(publishLabel(legacy), "Show players the changes (2)");
    assert.equal(publishShort(legacy), "Show (2)");
    assert.deepEqual(lastEditIds(legacy), ["draft.2"]);
    const v7 = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
    for (const id of ["draft.1", `${v7}.01`, `${v7}.500`, `${v7.toUpperCase()}.1`, "0192a3b4-c5d6-4e8f-9a0b-1c2d3e4f5a6b.1", "0192a3b4-c5d6-7e8f-7a0b-1c2d3e4f5a6b.1", `x${v7}.1`, `${v7}.1.2`]) {
      assert.equal(fogEditOf(id), id, id);
    }
    assert.equal(fogEditOf(`${v7}.0`), v7);
    assert.equal(fogEditOf(`${v7}.499`), v7);
    const cells = (id: string, keys: string[]): FogOp => ({ id, mode: "reveal", shape: { kind: "cells", cells: keys } });
    const rooms = draftOutlines([cells("room.1", ["1,1"]), cells("room.2", ["1,2"])], SQUARES);
    assert.deepEqual(rooms.get("room.1"), cellsOutline(["1,1"]), "two older rooms keep their own outlines");
    assert.deepEqual(rooms.get("room.2"), cellsOutline(["1,2"]));
  });

  test("a gesture's ops are one edit only as fogOps numbers them, from .0 up in draft order, so crafted ids stay edits of their own (H3-DATA-5)", () => {
    const v7 = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
    const other = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c";
    const op = (id: string, x = 1): FogOp => ({ id, mode: "reveal", shape: { kind: "cells", cells: [`${x},1`] } });
    const crafted = [op(`${v7}.1`, 1), op(`${v7}.2`, 3)];
    assert.equal(publishShort(crafted), "Reveal (2)", "a gesture never starts past .0");
    assert.deepEqual(lastEditIds(crafted), [`${v7}.2`]);
    assert.deepEqual(draftOutlines(crafted, SQUARES).get(`${v7}.2`), cellsOutline(["3,1"]), "each keeps its own outline");
    const plain = [op(v7, 1), op(`${v7}.0`, 3)];
    assert.equal(publishShort(plain), "Reveal (2)", "a plain id is not its own .0's gesture");
    assert.deepEqual(lastEditIds(plain), [`${v7}.0`]);
    assert.deepEqual(lastEditIds([op(v7, 1), op(`${v7}.0`, 3), op(`${v7}.1`, 5)]), [`${v7}.0`, `${v7}.1`]);
    const backwards = [op(`${v7}.0`, 1), op(`${v7}.2`, 3), op(`${v7}.1`, 5)];
    assert.equal(publishShort(backwards), "Reveal (2)", "a number that does not climb is an edit of its own");
    assert.deepEqual(lastEditIds(backwards), [`${v7}.1`]);
    // Another DM's edit landing between a gesture's messages leaves it one edit, as the app sends it.
    const between = [op(`${v7}.0`, 1), op(other, 3), op(`${v7}.1`, 5), op(`${v7}.2`, 7)];
    assert.equal(publishShort(between), "Reveal (2)");
    assert.deepEqual(lastEditIds(between), [`${v7}.0`, `${v7}.1`, `${v7}.2`]);
  });

  test("an imported draft's repeated op ids still give every drawn outline a key of its own (FOG-DUP-KEYS)", () => {
    const op = (id: string, x: number): FogOp => ({ id, mode: "reveal", shape: { kind: "cells", cells: [`${x},1`] } });
    const draft = [op("p", 9), op("g.0", 1), op("g.1", 3), op("g.0", 5), op("g.1", 7)];
    const keys = draft.map(opKey);
    assert.equal(new Set(keys).size, draft.length, "no two outlines share a key");
    assert.deepEqual(draft.slice(0, 3).map(opKey), keys.slice(0, 3), "a later op leaves earlier keys as they were");
  });

  test("edits that share an op id are one edit, as Undo removes them, in the count and the outlines too", () => {
    const v7 = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
    const op = (id: string, x: number): FogOp => ({ id, mode: "reveal", shape: { kind: "cells", cells: [`${x},1`] } });
    const plain = op("p", 9);
    // An imported draft repeats a gesture's ids: Undo's ids take all four of its ops out together.
    const again = [plain, op(`${v7}.0`, 1), op(`${v7}.1`, 3), op(`${v7}.0`, 5), op(`${v7}.1`, 7)];
    assert.equal(publishShort(again), "Reveal (2)");
    const remove = lastEditIds(again);
    assert.deepEqual(remove, [`${v7}.0`, `${v7}.1`]);
    const imported = room({ scenes: { [SCENE_ID]: scene(SCENE_ID, { fogEnabled: true }) }, fogDrafts: { [SCENE_ID]: { sceneId: SCENE_ID, rev: 0, ops: again } } });
    const result = applyOp(imported, { t: "fog.draft", sceneId: SCENE_ID, remove }, DM, env(1));
    assert.ok(result.ok);
    const undone = result.state.fogDrafts[SCENE_ID]?.ops ?? [];
    assert.deepEqual(undone.map((o) => o.id), ["p"], "one Undo leaves only the edit before");
    assert.equal(publishShort(undone), "Reveal (1)");
    const lines = draftOutlines(again, SQUARES);
    assert.deepEqual(lines.get(`${v7}.0`), cellsOutline(["1,1", "3,1", "5,1", "7,1"]), "one outline round the whole edit");
    assert.deepEqual(lines.get(`${v7}.1`), []);
    // A gesture's id that comes again out of order, after another edit, is still that gesture's.
    const late = [op(`${v7}.0`, 1), op(`${v7}.1`, 3), plain, op(`${v7}.1`, 5)];
    assert.equal(publishShort(late), "Reveal (2)");
    assert.deepEqual(lastEditIds(late), [`${v7}.0`, `${v7}.1`]);
  });

  test("in any draft, no op id spans two edits, so Undo's ids take out exactly the last op's edit", () => {
    const v7 = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
    const ids = [`${v7}.0`, `${v7}.1`, `${v7}.2`, "p", "q", `${v7}`];
    const random = rng(7);
    const next = (n: number) => Math.floor(random() * n);
    const seen = new Set<string>();
    let several = 0;
    let repeated = 0;
    for (let run = 0; run < 2000; run++) {
      const draft = Array.from({ length: 1 + next(8) }, (_, x): FogOp => ({ id: ids[next(ids.length)]!, mode: "reveal", shape: { kind: "cells", cells: [`${x},1`] } }));
      seen.add(draft.map((o) => o.id).join(" "));
      if (draft.length > 1) several++;
      if (new Set(draft.map((o) => o.id)).size < draft.length) repeated++;
      const edits = draftEdits(draft);
      const owner = new Map<string, number>();
      edits.forEach((edit, e) => {
        for (const o of edit) {
          assert.equal(owner.get(o.id) ?? e, e, `${o.id} in two edits of ${draft.map((d) => d.id).join(" ")}`);
          owner.set(o.id, e);
        }
      });
      const remove = new Set(lastEditIds(draft));
      const last = edits.find((edit) => edit.includes(draft.at(-1)!))!;
      assert.deepEqual(draft.filter((o) => !remove.has(o.id)), draft.filter((o) => !last.includes(o)), "the last op's edit, whole, and nothing else");
    }
    // A generator that lost precision once gave 13 distinct drafts, nearly all of one op, and the loop checked little.
    assert.ok(seen.size > 1000, `${seen.size} distinct drafts`);
    assert.ok(several > 1500, `${several} drafts of several ops`);
    assert.ok(repeated > 1000, `${repeated} drafts with a repeated id`);
  });

  test("the publish button counts the DM's edits: one Builder room tap is one, on hexes and on squares", () => {
    const hexRoom = fogOps(largestHexRoom(ROWS), "reveal", newId);
    assert.equal(publishLabel(hexRoom), "Reveal to players (1)");
    assert.equal(publishShort(hexRoom), "Reveal (1)");
    const squareRoom = fogOps(largestSquareRoom(), "reveal", newId);
    assert.ok(squareRoom.length > 1);
    const draft = [...squareRoom, ...fogOps([rect(1)], "hide", newId), ...fogOps(longStroke(), "reveal", newId)];
    assert.equal(publishLabel(draft), "Show players the changes (3)");
    assert.equal(publishShort(draft), "Show (3)");
    const rects = [1, 4, 7].flatMap((x) => fogOps([rect(x)], "hide", newId));
    assert.equal(publishLabel(rects), "Fog for players (3)", "an edit of one shape counts as before");
  });

  test("the fog bar's Undo takes the last edit back whole, and then the one before it", () => {
    const first = fogOps([rect(1)], "reveal", newId);
    const room = fogOps(largestSquareRoom(), "reveal", newId);
    const ops = [...first, ...room];
    assert.deepEqual(lastEditIds(ops), room.map((o) => o.id));
    assert.deepEqual(lastEditIds(first), [first[0]!.id]);
    assert.deepEqual(lastEditIds([]), []);
    const take = { t: "fog.draft", sceneId: SCENE_ID, remove: lastEditIds(fogOps(largestHexRoom(ROWS), "reveal", newId)) };
    assert.ok(clientMessageSchema.safeParse({ t: "op", n: 1, op: take, g: GROUP }).success, "the whole hex room's ids go in one message");
    assert.ok(serializedBytes({ t: "op", n: 1, op: take, g: GROUP }) <= MAX_FRAME_BYTES);
  });

  test("a room sent in several ops is outlined as one room, not in bands, on hexes and on squares", () => {
    const hexShapes = largestHexRoom(ROWS);
    const hexRoom = fogOps(hexShapes, "reveal", newId);
    const hexLines = draftOutlines(hexRoom, ROWS);
    const all = hexShapes.flatMap((sh) => (sh.kind === "cells" ? sh.cells : []));
    assert.deepEqual(hexLines.get(hexRoom[0]!.id), hexCellsOutline(ROWS, all));
    assert.ok(hexRoom.slice(1).every((o) => hexLines.get(o.id)?.length === 0), "the rest draw nothing");
    const squareRoom = fogOps(largestSquareRoom(), "reveal", newId);
    const squareLines = draftOutlines(squareRoom, SQUARES);
    assert.equal(squareLines.get(squareRoom[0]!.id)!.length, 4 * 200 * 4, "the 800 unit sides round a 200 by 200 room");
    // Two rooms tapped one after the other are two edits, each with its own outline.
    const a = fogOps(roomShapes(indexBuild([{ sceneId: SCENE_ID, cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" }, edges: {} }]), { x: 1.5, y: 1.5 }, { w: 10, h: 10 }).shapes, "reveal", newId);
    const b = fogOps(roomShapes(indexBuild([{ sceneId: SCENE_ID, cx: 0, cy: 0, rev: 0, cells: { "1,2": "stone" }, edges: {} }]), { x: 1.5, y: 2.5 }, { w: 10, h: 10 }).shapes, "reveal", newId);
    const two = draftOutlines([...a, ...b], SQUARES);
    assert.deepEqual(two.get(a[0]!.id), cellsOutline(["1,1"]));
    assert.deepEqual(two.get(b[0]!.id), cellsOutline(["1,2"]));
  });
});
