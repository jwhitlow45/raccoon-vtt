import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ClientOp } from "#shared/protocol.ts";
import type { PendingOp, RoomView } from "../../state/types.ts";
import { token } from "#shared/testutil.ts";
import { afterAnswers, afterQueued, barTokenIds, followOps, lastMoveSlot, MAX_OFFERS, offered, offersMarkUndo, offersUndo, undoOf, type Offers } from "./undoMove.ts";

const queued = (n: number, op: ClientOp, group?: string): PendingOp => (group === undefined ? { n, op, at: 0 } : { n, op, at: 0, group });
const move = (tokenId: string): ClientOp => ({ t: "token.move", tokenId, x: 1, y: 1 });
const raise = (tokenId: string): ClientOp => ({ t: "token.update", tokenId, patch: { elevation: 5 } });
const NONE: Offers = { offers: [], undoing: null };

/** The ops a player's device queues, one after another, from no offer. */
function after(ops: (ClientOp | PendingOp)[], role: "dm" | "player" = "player", from: Offers = NONE): Offers {
  let s = from;
  ops.forEach((op, i) => {
    s = afterQueued(s, role, "op" in op && "n" in op ? op : queued(i + 1, op));
  });
  return s;
}

describe("Undo move in the token bar", () => {
  test("a player's move offers to take it back on the tokens it moved, and only there", () => {
    const top = offered(after([{ t: "token.moveMany", moves: [{ tokenId: "a", x: 1, y: 1 }, { tokenId: "b", x: 2, y: 1 }] }]));
    assert.equal(offersUndo(top, ["a"]), true);
    assert.equal(offersUndo(top, ["c", "b"]), true);
    assert.equal(offersUndo(top, ["c"]), false);
    assert.deepEqual(undoOf(top!), { t: "undo", of: 1 });
  });

  test("an attach or a detach offers it on the holder's bar too, and a rider's bar offers its mount's move (docs/design-v1-attach.md 8.3)", () => {
    const carry: ClientOp = { t: "token.attach", tokenId: "kobold", to: "thorn", kind: "carry", x: 5, y: 5, elevation: 0 };
    assert.equal(offersUndo(offered(after([carry])), ["thorn"]), true);
    const letGo = afterQueued(NONE, "player", queued(1, { t: "token.detach", tokenId: "kobold" }), (id) => (id === "kobold" ? "thorn" : undefined));
    assert.equal(offersUndo(offered(letGo), ["thorn"]), true);
    const tokens = {
      horse: token("horse", { size: "large", x: 4, y: 4 }),
      thorn: token("thorn", { x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } }),
      torch: token("torch", { kind: "object", size: "tiny", x: 4, y: 4, attached: { to: "thorn", kind: "carry" } }),
    };
    assert.deepEqual(barTokenIds(tokens, tokens.thorn), ["thorn", "horse", "torch"]);
    // Thorn's drag moved the horse he directs: his own bar offers to take it back.
    assert.equal(offersUndo(offered(after([move("horse")])), barTokenIds(tokens, tokens.thorn)), true);
    assert.equal(offersUndo(offered(after([move("horse")])), barTokenIds(tokens, tokens.torch)), true, "up the chain");
  });

  test("the newest move is the one offered, and a press names it", () => {
    const top = offered(after([move("a"), move("b")]));
    assert.equal(offersUndo(top, ["a"]), false);
    assert.equal(offersUndo(top, ["b"]), true);
    assert.deepEqual(undoOf(top!), { t: "undo", of: 2 });
  });

  test("once the server takes the top move back for the bar, the one below is offered, down to the drag", () => {
    // A drag, then three taps of +5 on the same token: four steps on the server.
    let s = after([move("a"), raise("a"), raise("a"), raise("a")]);
    for (const n of [4, 3, 2, 1]) {
      const top = offered(s)!;
      assert.deepEqual(undoOf(top), { t: "undo", of: n });
      const press = queued(10 + n, undoOf(top));
      s = afterQueued(s, "player", press);
      assert.equal(offered(s), null, "nothing to press while the undo is on its way");
      assert.equal(afterAnswers(s, [press], []), s, "still waiting");
      s = afterAnswers(s, [], []);
    }
    assert.deepEqual(s, NONE);
  });

  test("Doesn't count goes on top as a mark, which hides Undo move until the bar takes the mark back", () => {
    const mark: ClientOp = { t: "token.countLeg", tokenId: "a", counts: false };
    let s = after([move("a"), mark]);
    const top = offered(s)!;
    assert.equal(top.mark, true);
    assert.equal(offersUndo(top, ["a"]), false, "no Undo move while the mark is the newest step");
    assert.equal(offersMarkUndo(top, "a"), true);
    assert.equal(offersMarkUndo(top, "b"), false);
    assert.equal(offersMarkUndo(offered(after([move("a")])), "a"), false, "a move is no mark");
    assert.deepEqual(undoOf(top), { t: "undo", of: 2 });
    const press = queued(3, undoOf(top));
    s = afterAnswers(afterQueued(s, "player", press), [], []);
    assert.equal(offersUndo(offered(s), ["a"]), true, "the move's own undo is back");
    assert.deepEqual(undoOf(offered(s)!), { t: "undo", of: 1 });
    assert.deepEqual(afterAnswers(after([move("a"), mark]), [], [2]), NONE, "a refused mark leaves this device unsure of the stack");
  });

  test("a move made while the bar's undo is on its way stays on top once it is answered", () => {
    let s = after([move("a"), move("b")]);
    s = afterQueued(s, "player", queued(3, undoOf(offered(s)!)));
    s = afterQueued(s, "player", queued(4, move("c")));
    s = afterAnswers(s, [queued(4, move("c"))], []);
    assert.deepEqual(s.offers.map((o) => o.ns), [[1], [4]]);
    assert.deepEqual(undoOf(offered(s)!), { t: "undo", of: 4 });
  });

  test("any other undo or redo, from a keyboard or a toolbar, and a drawing op end every offer", () => {
    assert.deepEqual(after([move("a"), move("b"), { t: "undo" }]), NONE, "Ctrl+Z took B back, so A is not to be offered on B");
    assert.deepEqual(after([move("a"), { t: "redo" }]), NONE);
    assert.deepEqual(after([move("a"), raise("a"), { t: "drawing.delete", drawingId: "d" }]), NONE);
    assert.deepEqual(after([move("a"), move("b"), { t: "undo", of: 1 }]), NONE, "an undo naming a step below the top is not the bar's");
  });

  test("a change of elevation or facing alone goes on top, other changes leave the offers", () => {
    const raised = after([move("a"), raise("a")]);
    assert.deepEqual(raised.offers, [{ tokenIds: ["a"], ns: [1] }, { tokenIds: ["a"], ns: [2] }]);
    const noted = after([move("a"), { t: "token.update", tokenId: "a", patch: { notes: "x" } }, { t: "log.chat", text: "hi" }]);
    assert.deepEqual(noted.offers, [{ tokenIds: ["a"], ns: [1] }]);
  });

  test("a resize goes on the player's stack but is no move, so the bar offers no Undo move after it (docs/design-v1-token-window.md 8.7)", () => {
    const resized = after([move("a"), { t: "token.update", tokenId: "a", patch: { size: "large", x: 0, y: 0 } }]);
    assert.deepEqual(resized.offers, []);
  });

  test("the bands of one gesture are one offer, named by the last band", () => {
    const s = after([move("x"), queued(2, move("a"), "g"), queued(3, move("b"), "g")]);
    assert.deepEqual(s.offers, [{ tokenIds: ["x"], ns: [1] }, { tokenIds: ["a", "b"], ns: [2, 3], group: "g" }]);
    assert.deepEqual(undoOf(offered(s)!), { t: "undo", of: 3 });
  });

  test("a refused move, or a refused undo from the bar, ends every offer, a refusal of something else does not", () => {
    const s = after([move("a"), move("b")]);
    assert.deepEqual(afterAnswers(s, [], [1]), NONE);
    assert.equal(afterAnswers(s, [], [7]), s);
    const banded = after([queued(2, move("a"), "g"), queued(3, move("b"), "g")]);
    assert.deepEqual(afterAnswers(banded, [], [2]), NONE);
    const pressed = afterQueued(s, "player", queued(3, undoOf(offered(s)!)));
    assert.deepEqual(afterAnswers(pressed, [], [3]), NONE);
  });

  test("the bar walks back at most MAX_OFFERS moves", () => {
    const s = after(Array.from({ length: MAX_OFFERS + 5 }, () => move("a")));
    assert.equal(s.offers.length, MAX_OFFERS);
    assert.deepEqual(s.offers[0]!.ns, [6]);
  });

  test("a DM gets no offer", () => {
    assert.deepEqual(after([move("a")], "dm"), NONE);
  });

  test("a Let go queued behind the Carry it undoes still offers Undo move on the holder's bar, before and after the answers", () => {
    const view = { you: { memberId: "p1", role: "player" }, pending: [], refused: [], confirmed: { tokens: {} } } as unknown as RoomView;
    const room = createStore<RoomView>()(() => view);
    const slot = lastMoveSlot.create();
    const stop = followOps(room, slot);
    const carry = queued(1, { t: "token.attach", tokenId: "kobold", to: "thorn", kind: "carry", x: 5, y: 5, elevation: 0 });
    room.setState({ pending: [carry] });
    room.setState({ pending: [carry, queued(2, { t: "token.detach", tokenId: "kobold" })] });
    assert.equal(offersUndo(offered(slot.getState()), ["thorn"]), true);
    room.setState({ pending: [] });
    assert.equal(offersUndo(offered(slot.getState()), ["thorn"]), true, "answered, the Let go is still the newest step");
    stop();
  });

  test("follows the store: each op queued once, the bar's undo answered, and refusals as they come", () => {
    const view = { you: { memberId: "p1", role: "player" }, pending: [], refused: [] } as unknown as RoomView;
    const room = createStore<RoomView>()(() => view);
    const slot = lastMoveSlot.create();
    const stop = followOps(room, slot);
    room.setState({ pending: [queued(1, move("a"))] });
    room.setState({ pending: [] });
    room.setState({ pending: [queued(2, raise("a"))] });
    room.setState({ pending: [] });
    assert.deepEqual(offered(slot.getState())?.ns, [2], "answered and gone from the queue, the change is still the newest step");
    room.setState({ pending: [queued(3, { t: "undo", of: 2 })] });
    assert.equal(offered(slot.getState()), null);
    room.setState({ pending: [] });
    assert.deepEqual(offered(slot.getState())?.ns, [1], "the drag is next");
    room.setState({ pending: [queued(4, { t: "undo" })] });
    assert.equal(offered(slot.getState()), null);
    room.setState({ pending: [queued(5, move("b"))] });
    room.setState({ pending: [], refused: [5] });
    assert.equal(offered(slot.getState()), null, "the server refused the move");
    stop();
  });
});
