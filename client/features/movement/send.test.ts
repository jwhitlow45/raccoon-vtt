import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import type { DropPlan } from "./drop.ts";
import { sendPlan, type SendDeps } from "./send.ts";
import type { StopNote } from "./teleport.ts";

function deps() {
  const sent: ClientOp[] = [];
  const notes: StopNote[] = [];
  const toasts: string[] = [];
  const bar: boolean[] = [];
  const d: SendDeps = {
    dispatch(op) {
      sent.push(op);
      return 40 + sent.length;
    },
    newId: () => "group",
    note: (note) => notes.push(note),
    notify: (text) => toasts.push(text),
    showActions: (open) => bar.push(open),
  };
  return { d, sent, notes, toasts, bar };
}

const stop = { tokenId: "thorn", sceneId: "s1", blocker: "wall" as const, door: null, ghost: { x: 9, y: 5 }, aim: { x: 9.2, y: 4.9 }, at: { x: 5, y: 5 } };

describe("sending a drop", () => {
  test("a stopped walk shows its note over the token's action bar, which closes with the selection kept", () => {
    const h = deps();
    const plan: DropPlan = { moves: [{ tokenId: "thorn", x: 5, y: 5 }], stop, held: [] };
    sendPlan(plan, h.d);
    assert.deepEqual(h.sent, [{ t: "token.move", tokenId: "thorn", x: 5, y: 5 }]);
    assert.deepEqual(h.notes, [{ ...stop, n: 41 }]);
    assert.deepEqual(h.bar, [false]);
  });

  test("a walk stopped at its first step sent nothing, so its note has no walk to take back", () => {
    const h = deps();
    sendPlan({ moves: [], stop, held: [] }, h.d);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.notes, [{ ...stop, n: null }]);
    assert.deepEqual(h.bar, [false]);
  });

  test("a walk that was not stopped leaves the bar as it was", () => {
    const h = deps();
    sendPlan({ moves: [{ tokenId: "thorn", x: 4, y: 2 }], stop: null, held: [] }, h.d);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.notes, []);
    assert.deepEqual(h.bar, []);
  });

  test("a group's held tokens are named in a toast", () => {
    const h = deps();
    sendPlan({ moves: [], stop: null, held: [{ token: { id: "g", sceneId: "s1", size: "medium", x: 1, y: 1, elevation: 0, name: "Goblin", number: 2 }, blocker: "wall" }] }, h.d);
    assert.deepEqual(h.toasts, ["Goblin 2 stayed where it was: a wall is in the way."]);
    assert.deepEqual(h.bar, []);
  });
});
