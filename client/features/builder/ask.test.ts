import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { clientOpSchema, MAX_ASK_BYTES, MAX_ASK_OPS, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import { askOps, dispatchBuild } from "./ask.ts";
import { rectOps } from "./cells.ts";

/*
 * A builder gesture of several ops asks before any applies
 * (docs/design-v1-map-discovery.md 5.3): its asks go first under its undo
 * group, so the server's forget question comes before the first band.
 */

const explore = { id: "s1", fogEnabled: true, vision: { on: true, light: "dark" as const } };

function recorder() {
  const sent: { op: ClientOp; group?: string }[] = [];
  return {
    sent,
    actions: {
      dispatch: (op: ClientOp, opts?: { group?: string }) => (sent.push({ op, ...(opts?.group !== undefined ? { group: opts.group } : {}) }), sent.length),
      newId: () => "g1",
    },
  };
}

describe("a builder gesture asks before it applies", () => {
  test("a big rectangle on a scene that keeps memory sends its ask first, then its bands, all under one group", () => {
    const bands = rectOps("s1", { x: 0, y: 0, w: 80, h: 64 }, "stone", { w: 80, h: 64 });
    assert.ok(bands.length > 1, "the rectangle goes as bands");
    const r = recorder();
    const sent = dispatchBuild(r.actions, explore, bands);
    assert.deepEqual(r.sent[0], { op: { t: "build.ask", sceneId: "s1", ops: bands }, group: "g1" });
    assert.deepEqual(r.sent.slice(1), bands.map((op) => ({ op, group: "g1" })));
    assert.deepEqual(sent, bands.map((_, i) => i + 2), "the bands' numbers, not the ask's");
  });

  test("a gesture of one op, and any gesture on a scene that keeps no memory, sends no ask", () => {
    const one = rectOps("s1", { x: 0, y: 0, w: 4, h: 4 }, "stone", { w: 80, h: 64 });
    const r = recorder();
    dispatchBuild(r.actions, explore, one);
    assert.deepEqual(r.sent.map((s) => s.op.t), ["build.rect"]);
    const bands = rectOps("s1", { x: 0, y: 0, w: 80, h: 64 }, "stone", { w: 80, h: 64 });
    for (const scene of [{ ...explore, fogEnabled: false }, { ...explore, vision: { on: false, light: "dark" as const } }]) {
      const k = recorder();
      dispatchBuild(k.actions, scene, bands);
      assert.ok(k.sent.every((s) => s.op.t === "build.rect"), JSON.stringify(scene));
    }
  });

  test("asks carry the gesture's own builder ops on the scene, without a yes, and split past an ask's ops or bytes, all but the last saying more", () => {
    const paint = (k: number): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: Array.from({ length: MAX_BUILD_CELLS }, (_, i) => `${i % 100},${k * 20 + Math.floor(i / 100)}`), forget: true });
    const ops = [paint(0), paint(1), paint(2), paint(3), { t: "build.label", sceneId: "s1", labelId: "l1", label: null } as ClientOp];
    const asks = askOps("s1", ops);
    assert.ok(asks.length > 1, "four full paints pass one ask's bytes");
    assert.deepEqual(asks.flatMap((a) => a.ops).map((o) => ("cells" in o ? o.cells[0] : null)), [0, 1, 2, 3].map((k) => `0,${k * 20}`), "every paint, in order, and no label");
    assert.ok(asks.flatMap((a) => a.ops).every((o) => !("forget" in o)));
    assert.deepEqual(asks.map((a) => a.more === true), [...asks.slice(1).map(() => true), false]);
    assert.ok(asks.every((a) => serializedBytes(a) <= MAX_ASK_BYTES && a.ops.length <= MAX_ASK_OPS));
    assert.ok(asks.every((a) => clientOpSchema.safeParse(a).success), "each ask is an op the server takes");
    assert.equal(clientOpSchema.safeParse({ t: "build.ask", sceneId: "s1", ops: [ops[4]] }).success, false, "an ask carries builder ops only");
    const many = Array.from({ length: MAX_ASK_OPS + 1 }, (_, k): ClientOp => ({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: [`${k},0`] }));
    assert.deepEqual(askOps("s1", many).map((a) => a.ops.length), [MAX_ASK_OPS, 1]);
    assert.deepEqual(askOps("s2", many), [], "ops on another scene are not this ask's");
  });
});
