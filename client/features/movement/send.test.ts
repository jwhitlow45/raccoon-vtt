import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import type { OnAnswer } from "../../state/types.ts";
import { GROUP_BLOCKED_TEXT, type DropPlan } from "./drop.ts";
import { sendPlan, type SendDeps } from "./send.ts";
import type { StopNote } from "./teleport.ts";

function deps(where: Record<string, { sceneId: string; x: number; y: number }> = {}) {
  const sent: ClientOp[] = [];
  const notes: StopNote[] = [];
  const toasts: string[] = [];
  const bar: boolean[] = [];
  const answers: (OnAnswer | undefined)[] = [];
  const d: SendDeps = {
    dispatch(op, opts) {
      sent.push(op);
      answers.push(opts?.onAnswer);
      return 40 + sent.length;
    },
    newId: () => "group",
    note: (note) => notes.push(note),
    shownNote: () => notes.at(-1) ?? null,
    standing: (id) => where[id] ?? null,
    attempts: new Map(),
    notify: (text) => toasts.push(text),
    showActions: (open) => bar.push(open),
  };
  return { d, sent, notes, toasts, bar, answers };
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

  test("a walk the server landed short of where the device let it go gets the note there, naming no kind, its walk to take back", () => {
    const h = deps({ thorn: { sceneId: "s1", x: 6, y: 5 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] }, h.d);
    assert.deepEqual(h.notes, []);
    h.answers[0]!("taken", undefined, undefined, undefined, true);
    assert.deepEqual(h.notes, [{ tokenId: "thorn", sceneId: "s1", blocker: "unknown", door: null, ghost: { x: 9, y: 5 }, aim: { x: 9, y: 5 }, at: { x: 6, y: 5 }, n: 41 }]);
    assert.deepEqual(h.bar, [false]);
  });

  test("a walk taken whole, or blocked where the device's own note already stands, changes no note", () => {
    const h = deps({ thorn: { sceneId: "s1", x: 5, y: 5 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] }, h.d);
    h.answers[0]!("taken");
    assert.deepEqual(h.notes, []);
    const k = deps({ thorn: { sceneId: "s1", x: 5, y: 5 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 5, y: 5 }], stop, held: [] }, k.d);
    k.answers[0]!("taken", undefined, undefined, undefined, true);
    assert.deepEqual(k.notes, [{ ...stop, n: 41 }]);
  });

  test("blocked short of the device's own stop, the note moves to where the walk landed and names no kind", () => {
    const h = deps({ thorn: { sceneId: "s1", x: 4, y: 5 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 5, y: 5 }], stop, held: [] }, h.d);
    h.answers[0]!("taken", undefined, undefined, undefined, true);
    assert.deepEqual(h.notes.at(-1), { ...stop, blocker: "unknown", at: { x: 4, y: 5 }, n: 41 });
  });

  test("a walk the server refused leaves its note no walk to take back", () => {
    const h = deps({ thorn: { sceneId: "s1", x: 5, y: 5 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 5, y: 5 }], stop, held: [] }, h.d);
    assert.equal(h.notes.at(-1)!.n, 41);
    h.answers[0]!("refused");
    assert.equal(h.notes.at(-1)!.n, null);
  });

  test("an older walk's blocked answer that a later walk overtook makes no note, even where the later one stands (MD4-ASTRA-3)", () => {
    // Astra's case: walk 1 toward (9, 5), walk 2 toward (4, 6), one answer takes both and says only walk 1 was blocked.
    const h = deps({ thorn: { sceneId: "s1", x: 4, y: 6 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] }, h.d);
    sendPlan({ moves: [{ tokenId: "thorn", x: 4, y: 6 }], stop: null, held: [] }, h.d);
    h.answers[0]!("taken", undefined, undefined, undefined, true);
    h.answers[1]!("taken");
    assert.deepEqual(h.notes, []);
    // Had the later walk been the blocked one, its note has its own number and spot.
    const k = deps({ thorn: { sceneId: "s1", x: 4, y: 6 } });
    sendPlan({ moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] }, k.d);
    sendPlan({ moves: [{ tokenId: "thorn", x: 4, y: 7 }], stop: null, held: [] }, k.d);
    k.answers[0]!("taken");
    k.answers[1]!("taken", undefined, undefined, undefined, true);
    assert.deepEqual(k.notes, [{ tokenId: "thorn", sceneId: "s1", blocker: "unknown", door: null, ghost: { x: 4, y: 7 }, aim: { x: 4, y: 7 }, at: { x: 4, y: 6 }, n: 42 }]);
  });

  test("a group's blocked answer that later walks overtook for all its tokens says nothing", () => {
    const h = deps();
    sendPlan({ moves: [{ tokenId: "a", x: 1, y: 1 }, { tokenId: "b", x: 2, y: 1 }], stop: null, held: [] }, h.d);
    sendPlan({ moves: [{ tokenId: "a", x: 3, y: 1 }, { tokenId: "b", x: 4, y: 1 }], stop: null, held: [] }, h.d);
    h.answers[0]!("taken", undefined, undefined, undefined, true);
    assert.deepEqual(h.toasts, []);
  });

  test("an answer heard while the plan is still sending waits for the plan's own note", () => {
    const h = deps({ thorn: { sceneId: "s1", x: 6, y: 5 } });
    const d: SendDeps = { ...h.d, dispatch: (op, opts) => (h.sent.push(op), opts?.onAnswer?.("taken", undefined, undefined, undefined, true), 41) };
    sendPlan({ moves: [{ tokenId: "thorn", x: 9, y: 5 }], stop: null, held: [] }, d);
    assert.equal(h.notes.length, 1);
    assert.equal(h.notes[0]!.blocker, "unknown");
  });

  test("a group's blocked move says some stopped short, and names none", () => {
    const h = deps();
    sendPlan({ moves: [{ tokenId: "a", x: 1, y: 1 }, { tokenId: "b", x: 2, y: 1 }], stop: null, held: [] }, h.d);
    h.answers[0]!("taken", undefined, undefined, undefined, true);
    assert.deepEqual(h.toasts, [GROUP_BLOCKED_TEXT]);
    assert.deepEqual(h.notes, []);
  });

  test("a group's held tokens are named in a toast", () => {
    const h = deps();
    sendPlan({ moves: [], stop: null, held: [{ token: { id: "g", sceneId: "s1", size: "medium", x: 1, y: 1, elevation: 0, name: "Goblin", number: 2 }, blocker: "wall" }] }, h.d);
    assert.deepEqual(h.toasts, ["Goblin 2 stayed where it was: a wall is in the way."]);
    assert.deepEqual(h.bar, []);
  });
});
