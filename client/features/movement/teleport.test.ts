import type { HistoryActivation } from "../../state/history.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OpAnswer } from "../../state/types.ts";
import { ANSWER_LOST, runTeleport, teleportMove, teleportRefusedText, WALK_STILL_COUNTS, type StopNote } from "./teleport.ts";
import { line, raised, seenRoom, thorn, world } from "./testing.ts";

/**
 * A stand-in for the room store: it queues what the flow sends, lets the
 * test answer each op as the server would, and moves the token as the
 * answers say, so each step reads the room as the server left it.
 */
function harness(state: RoomState) {
  const sent: { op: ClientOp; answer(a: OpAnswer): void; quiet: boolean }[] = [];
  const notes: [string, string][] = [];
  let finished = 0;
  let view = state;
  return {
    sent,
    notes,
    get finished() {
      return finished;
    },
    put(token: Token) {
      view = { ...view, tokens: { ...view.tokens, [token.id]: token } };
    },
    deps: {
      view: () => seenRoom(view),
      dispatch(op: ClientOp, opts: { onAnswer(a: OpAnswer): void; quiet?: boolean }) {
        sent.push({ op, answer: opts.onAnswer, quiet: opts.quiet === true });
        return sent.length;
      },
      undo(options: HistoryActivation) {
        sent.push({ op: { t: "undo", of: options.of, head: "00000000-0000-4000-8000-000000000001" } as ClientOp, answer: options.onAnswer!, quiet: options.quiet === true });
      },
      notify(text: string, tone: string) {
        notes.push([text, tone]);
      },
      done() {
        finished++;
      },
    },
  };
}

/** Thorn walked from (2, 5) to the wall along x = 6 and was dropped at (9, 5), past it. */
function walked(): { state: RoomState; note: StopNote } {
  const state = world({ edges: line("w", 6, 0, 30), tokens: [thorn({ x: 5, y: 5 })] });
  return { state, note: { tokenId: "thorn", sceneId: "s1", blocker: "wall", door: null, ghost: { x: 9, y: 5 }, aim: { x: 9.2, y: 4.9 }, at: { x: 5, y: 5 }, n: 7 } };
}

describe("Teleport here", () => {
  test("the walk is taken back first, then the teleport goes from where it began, past the wall", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport(note, h.deps);
    assert.deepEqual(h.sent.map((s) => s.op), [{ t: "undo", of: 7, head: "00000000-0000-4000-8000-000000000001" }]);
    // The flow says what became of the walk, so the undo's own "Undid moving Thorn." stays away.
    assert.equal(h.sent[0]!.quiet, true);
    // The server takes the walk back: the token stands where the walk began.
    h.put(thorn({ x: 2, y: 5 }));
    h.sent[0]!.answer("taken");
    assert.deepEqual(h.sent[1]!.op, { t: "token.move", tokenId: "thorn", x: 9, y: 5, teleport: "wall" });
    assert.equal(h.finished, 0);
    // The teleport's own answers keep their toasts.
    assert.equal(h.sent[1]!.quiet, false);
    h.sent[1]!.answer("taken");
    assert.equal(h.finished, 1);
    assert.deepEqual(h.notes, []);
  });

  test("a walk stopped at its first step sent nothing, so the teleport goes at once", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport({ ...note, n: null }, h.deps);
    assert.deepEqual(h.sent.map((s) => s.op), [{ t: "token.move", tokenId: "thorn", x: 9, y: 5, teleport: "wall" }]);
    h.sent[0]!.answer("taken");
    assert.equal(h.finished, 1);
    assert.deepEqual(h.notes, []);
  });

  test("when the walk cannot be taken back, the teleport still goes from where the token stands, and says so", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport(note, h.deps);
    h.sent[0]!.answer("refused");
    assert.deepEqual(h.notes, [[WALK_STILL_COUNTS, "info"]]);
    assert.deepEqual(h.sent[1]!.op, { t: "token.move", tokenId: "thorn", x: 9, y: 5, teleport: "wall" });
    // Refused now, nothing more to say: the store shows the server's reason.
    h.sent[1]!.answer("refused");
    assert.equal(h.notes.length, 1);
    assert.equal(h.finished, 1);
  });

  test("a teleport refused after its walk was taken back says the walk was taken back", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport(note, h.deps);
    h.put(thorn({ x: 2, y: 5, locked: true }));
    h.sent[0]!.answer("taken");
    h.sent[1]!.answer("refused");
    assert.deepEqual(h.notes, [[teleportRefusedText(true), "error"]]);
    assert.equal(teleportRefusedText(true), "Teleport refused: the token is locked. The walk was taken back.");
    assert.equal(teleportRefusedText(false), "Teleport refused. The walk was taken back.");
    assert.equal(h.finished, 1);
  });

  test("a lost answer stops, sends no teleport, and says to check", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport(note, h.deps);
    h.sent[0]!.answer("unknown");
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.notes, [[ANSWER_LOST, "error"]]);
    assert.equal(h.finished, 1);
  });

  test("a token that left the scene meanwhile ends the flow without a move", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport(note, h.deps);
    h.put(thorn({ sceneId: "s2" }));
    h.sent[0]!.answer("taken");
    assert.equal(h.sent.length, 1);
    assert.equal(h.finished, 1);
  });

  test("an op the store will not queue ends the flow", () => {
    const { state, note } = walked();
    const h = harness(state);
    runTeleport(note, { ...h.deps, undo: (options) => options.onAnswer?.("unknown"), dispatch: () => null });
    assert.equal(h.finished, 1);
  });

  test("past a ledge onto raised ground, the teleport lands on it", () => {
    const state = world({ heights: raised(6, 0, 30, 30, 10), tokens: [thorn({ x: 2, y: 5 })] });
    assert.deepEqual(teleportMove(seenRoom(state), thorn({ x: 2, y: 5 }), { ghost: { x: 9, y: 5 }, aim: { x: 9.1, y: 5.2 }, blocker: "ledge" }), {
      tokenId: "thorn",
      x: 9,
      y: 5,
      elevation: 10,
      teleport: "ledge",
    });
  });

  test("a Large creature teleported into a 5 ft corridor lands squeezed", () => {
    // A 5 ft corridor from (10, 10) to (11, 20), closed at both ends, behind the room's wall.
    const state = world({ edges: { ...line("n", 10, 0, 30), ...line("n", 20, 10, 11), ...line("w", 10, 10, 20), ...line("w", 11, 10, 20) } });
    const ogre = thorn({ size: "large", x: 9, y: 4 });
    assert.deepEqual(teleportMove(seenRoom(state), ogre, { ghost: { x: 9, y: 13 }, aim: { x: 9.2, y: 13.4 }, blocker: "wall" }), { tokenId: "thorn", x: 9.5, y: 13.5, squeeze: true, teleport: "wall" });
  });
});
