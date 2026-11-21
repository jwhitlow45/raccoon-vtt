import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { DM, P1, P2, actor, entry, room, token } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/*
 * A walk the op took off only because its creature left the turn under way
 * is bookkeeping (D-261121-128, shared/reducer/tx.ts dropWalk): a player's
 * undo neither checks that creature nor puts the walk back, and answers
 * alike with that walk or without it. Through the room actor's own
 * steps (undoTesting.ts), whose inverse here still holds the removal, so
 * the step's pose checks are what leave it out (undo.ts poseRestore).
 *
 * Pip's turn, named 7: Pip (P1's) on a controlled ride on the warhorse, on
 * the turn's list.
 */

function table(horse: { hidden: boolean; walked: boolean }): UndoTable {
  const state: RoomState = room({
    tokens: {
      pip: token("pip", { name: "Pip", kind: "pc", size: "small", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, ...(horse.hidden ? { visibility: "dm" as const } : {}), actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      gob: token("gob", { x: 20, y: 20 }),
    },
  });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "rpip",
    entries: [entry("rpip", { tokenId: "pip", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })],
    turnStart: { entryId: "rpip", tokenId: "pip", sceneId: "s1", x: 4, y: 4, elevation: 0, seen: true, seq: 7, mounts: ["horse"] },
  };
  if (horse.walked) state.tokens.horse = { ...state.tokens.horse!, path: { turn: 7, stops: [{ x: 4, y: 4, elevation: 0 }, { x: 4, y: 6, elevation: 0, moved: 10 }] } };
  return new UndoTable(state);
}

const copies = (t: UndoTable, players: readonly Viewer[] = [P1, P2]) => players.map((who) => projectState(t.state, who, { sceneId: "s1" }));

describe("a mount's walk dropped by the turn rule is outside a player's undo (D-261121-128)", () => {
  test("a hidden controlled mount with a walk and without one: Pip gets off, then P1's Undo and Redo answer alike", () => {
    const [a, b] = [table({ hidden: true, walked: true }), table({ hidden: true, walked: false })];
    assert.deepEqual(copies(a), copies(b), "the twins' copies before");
    // P1's copy shows no link to a horse it does not hold, so Pip walks off it.
    const off: Op = { t: "token.move", tokenId: "pip", x: 7, y: 4 };
    assert.deepEqual([a.play(P1, off), b.play(P1, off)], ["ok", "ok"]);
    assert.equal(a.state.tokens.horse!.path, undefined, "the warhorse's walk went with it off the turn");
    assert.ok(a.stacks.peek("p1", "undo")!.entries.some((e) => e.key === "token:horse"), "this step still holds the removal");
    assert.deepEqual(copies(a), copies(b), "after getting off");
    assert.deepEqual([a.undo(P1), b.undo(P1)], ["ok", "ok"], "the undo");
    assert.equal(a.state.tokens.horse!.path, undefined, "no walk put back");
    assert.deepEqual(copies(a), copies(b), "after the undo");
    assert.deepEqual([a.redo(P1), b.redo(P1)], ["ok", "ok"], "the redo");
    assert.deepEqual(copies(a), copies(b), "after the redo");
  });

  test("the undo of a former mount's move after the DM took its rider off is taken, with no walk put back", () => {
    // A hidden goblin's turn on the warhorse, which P1 moves under Players move any: the goblin rides along unseen.
    const t = table({ hidden: false, walked: false });
    t.state = {
      ...t.state,
      meta: { ...t.state.meta, settings: { ...t.state.meta.settings, playersMoveAny: "all" } },
      tokens: { ...t.state.tokens, pip: { ...t.state.tokens.pip!, x: 15, y: 15, attached: undefined }, gob: { ...t.state.tokens.gob!, visibility: "dm", x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } } },
      encounter: { ...t.state.encounter!, activeEntryId: "rgob", turnStart: { entryId: "rgob", tokenId: "gob", sceneId: "s1", x: 4, y: 4, elevation: 0, seq: 7, mounts: ["horse"] } },
    };
    assert.equal(t.play(P1, { t: "token.move", tokenId: "horse", x: 4, y: 8 }), "ok");
    assert.ok(t.state.tokens.horse!.path, "the warhorse walks on the goblin's turn");
    assert.equal(t.play(DM, { t: "token.detach", tokenId: "gob", x: 6, y: 8 }), "ok");
    assert.equal(t.state.tokens.horse!.path, undefined, "it left the turn, and its walk with it");
    assert.equal(t.undo(P1), "ok");
    assert.deepEqual([t.state.tokens.horse!.x, t.state.tokens.horse!.y], [4, 4], "back where it stood");
    assert.equal(t.state.tokens.horse!.path, undefined, "with no walk, as it shares no turn");
  });

  test("a walk that comes back where it started is no dropped walk: its undo takes the walk back too", () => {
    const t = table({ hidden: false, walked: false });
    t.state = { ...t.state, tokens: { ...t.state.tokens, pip: { ...t.state.tokens.pip!, attached: undefined } }, encounter: { ...t.state.encounter!, turnStart: { ...t.state.encounter!.turnStart!, mounts: undefined } } };
    assert.equal(t.play(P1, { t: "token.move", tokenId: "pip", x: 6, y: 4 }, "g"), "ok");
    assert.equal(t.play(P1, { t: "token.move", tokenId: "pip", x: 4, y: 4 }, "g"), "ok");
    assert.ok(t.state.tokens.pip!.path, "Pip walked out and back");
    assert.equal(t.undo(P1), "ok");
    assert.equal(t.state.tokens.pip!.path, undefined, "the walk goes with the undo");
  });

  test("a token the step moved keeps its pose check: a mount moved since answers moved since", () => {
    const t = table({ hidden: false, walked: false });
    assert.equal(t.play(P1, { t: "token.move", tokenId: "horse", x: 4, y: 8 }), "ok");
    assert.equal(t.play(DM, { t: "token.move", tokenId: "horse", x: 9, y: 9 }), "ok");
    assert.notEqual(t.undo(P1), "ok");
  });
});
