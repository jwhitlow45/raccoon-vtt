import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "#shared/keys.ts";
import { eventLines } from "#shared/logRings.ts";
import type { Token, Viewer } from "#shared/model.ts";
import { MAX_RESTORE_ENTRIES, type ClientOp, type Op, type RestoreEntry } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { CHANGED_SINCE } from "#shared/reducer/misc.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { canApply, NO_ROOM_TO_GROW_BACK } from "#shared/permissions.ts";
import { projectEntity } from "#shared/project.ts";
import { actor, apply, castAsk, castTable, DM, env, member, P1, room, scene, token } from "#shared/testutil.ts";
import { MOVED_SINCE, mergeInverses, poseRestore, posesAfter, UNDO_DEPTH, UndoStacks } from "./undo.ts";
import { UndoTable } from "./undoTesting.ts";
import { tallyOf } from "./undoLabels.ts";

const inverse = (n: number): RestoreEntry[] => [{ key: `token:${n}`, value: null, expectRev: n }];
const step = (n: number) => ({ entries: inverse(n), label: `edit ${n}` });

describe("UndoStacks", () => {
  test("the DM records every op, a player only drawing ops and token moves, a change of elevation or facing alone included", () => {
    assert.equal(UndoStacks.records("dm", { t: "log.chat", text: "x" }), true);
    assert.equal(UndoStacks.records("player", { t: "log.chat", text: "x" }), false);
    assert.equal(UndoStacks.records("player", { t: "drawing.delete", drawingId: "d" }), true);
    assert.equal(UndoStacks.records("player", { t: "token.move", tokenId: "t", x: 1, y: 1 }), true);
    assert.equal(UndoStacks.records("player", { t: "token.moveMany", moves: [{ tokenId: "t", x: 1, y: 1 }] }), true);
    assert.equal(UndoStacks.records("player", { t: "token.update", tokenId: "t", patch: { elevation: 5 } }), true);
    assert.equal(UndoStacks.records("player", { t: "token.update", tokenId: "t", patch: { elevation: 5, rotation: 90 } }), true);
    assert.equal(UndoStacks.records("player", { t: "token.update", tokenId: "t", patch: { elevation: 5, name: "Owl" } }), false);
    assert.equal(UndoStacks.records("player", { t: "token.update", tokenId: "t", patch: { notes: "x" } }), false);
    assert.equal(UndoStacks.records("player", { t: "token.update", tokenId: "t", patch: {} }), false);
    assert.equal(UndoStacks.records("dm", { t: "sys.restore", entries: inverse(1), from: "undo" }), false);
    assert.equal(UndoStacks.records("dm", { t: "sys.memberSetKind", memberId: "m", kind: "dm" }), false);
    // A background thumbnail is nobody's step, so it neither takes an undo slot nor clears redo.
    assert.equal(UndoStacks.records("dm", { t: "scene.update", sceneId: "s", patch: { thumb: "t" } }), false);
    assert.equal(UndoStacks.records("dm", { t: "scene.update", sceneId: "s", patch: { thumb: "t", name: "Crypt" } }), true);
    // An ask to change a roll is the player's, so neither it nor the DM's Keep is a step. The DM's Allow of a fixed total is a reopen, which is.
    const target = { characterId: "c" };
    assert.equal(UndoStacks.records("player", { t: "roll.change", rollId: "r", target, ask: { id: "a", on: "t", reason: "lucky" } }), false);
    assert.equal(UndoStacks.records("player", { t: "roll.change", rollId: "r", target, clear: "a" }), false);
    assert.equal(UndoStacks.records("dm", { t: "roll.change", rollId: "r", target, clear: "a" }), false);
    assert.equal(UndoStacks.records("dm", { t: "roll.reopen", rollId: "r", target, change: "a" }), true);
  });

  test("undo pops the newest, redo mirrors it, and a new op clears redo", () => {
    const s = new UndoStacks();
    s.push("dm", inverse(1), "edit 1");
    s.push("dm", inverse(2), "edit 2");
    assert.deepEqual(s.popUndo("dm"), step(2));
    s.pushRestored("dm", "undo", inverse(20), "edit 20");
    assert.deepEqual(s.depth("dm"), { undo: 1, redo: 1 });
    assert.deepEqual(s.popRedo("dm"), step(20));
    s.pushRestored("dm", "redo", inverse(2), "edit 2");
    assert.deepEqual(s.depth("dm"), { undo: 2, redo: 0 });
    s.push("dm", inverse(3), "edit 3");
    assert.deepEqual(s.depth("dm"), { undo: 3, redo: 0 });
    assert.equal(s.popRedo("dm"), null);
    assert.equal(s.popUndo("other"), null);
  });

  test("an op too large to undo empties the stack instead of letting undo skip back past it", () => {
    const s = new UndoStacks();
    s.push("dm", inverse(1), "edit 1");
    const huge = Array.from({ length: MAX_RESTORE_ENTRIES + 1 }, (_, i) => ({ key: `token:${i}`, value: null }));
    s.push("dm", huge, "huge");
    assert.deepEqual(s.depth("dm"), { undo: 0, redo: 0 });
    assert.equal(s.popUndo("dm"), null);
    s.push("dm", inverse(2), "edit 2");
    s.pushRestored("dm", "undo", huge, "huge");
    assert.deepEqual(s.depth("dm"), { undo: 0, redo: 0 });
  });

  test("stacks are bounded at 50 and per member", () => {
    const s = new UndoStacks();
    for (let i = 0; i < 70; i++) s.push("p1", inverse(i), `edit ${i}`);
    assert.equal(s.depth("p1").undo, UNDO_DEPTH);
    assert.deepEqual(s.popUndo("p1"), step(69));
    assert.equal(s.depth("p2").undo, 0);
  });

  test("one gesture's ops are one step, and only while nothing else comes between", () => {
    const s = new UndoStacks();
    s.push("dm", inverse(1), "edit 1");
    s.push("dm", inverse(2), "edit 2", "stroke");
    s.push("dm", inverse(3), "edit 3", "stroke");
    s.push("dm", inverse(4), "edit 4", "stroke");
    assert.deepEqual(s.depth("dm"), { undo: 2, redo: 0 });
    assert.deepEqual(s.popUndo("dm"), { entries: [...inverse(2), ...inverse(3), ...inverse(4)], label: "edit 2", group: "stroke" });
    // A group that another op interrupted carries on as a new step.
    s.push("dm", inverse(5), "edit 5", "rect");
    s.push("dm", inverse(6), "edit 6");
    s.push("dm", inverse(7), "edit 7", "rect");
    assert.deepEqual(s.depth("dm"), { undo: 4, redo: 0 });
    // A step undone and redone is closed: a late op of its gesture starts a new one.
    const top = s.popUndo("dm")!;
    s.pushRestored("dm", "undo", top.entries, top.label);
    const back = s.popRedo("dm")!;
    s.pushRestored("dm", "redo", back.entries, back.label);
    s.push("dm", inverse(8), "edit 8", "rect");
    assert.deepEqual(s.depth("dm"), { undo: 5, redo: 0 });
  });

  test("a merged step that added, moved or changed several tokens is named for how many, not for its first op's token", () => {
    const s = new UndoStacks();
    const added = (id: string) => tallyOf({ t: "token.create", token: { id, sceneId: "s1", kind: "monster", name: "Wolf", size: "medium", x: 1, y: 1, actor: { inline: actor() } } });
    s.push("dm", inverse(1), "adding Wolf 1", "drop", undefined, undefined, added("w1"));
    assert.equal(s.popUndo("dm")?.label, "adding Wolf 1", "a gesture of one op keeps its own phrase");
    s.push("dm", inverse(1), "adding Wolf 1", "drop", undefined, undefined, added("w1"));
    s.push("dm", inverse(2), "adding Wolf 2", "drop", undefined, undefined, added("w2"));
    s.push("dm", inverse(3), "adding to initiative", "drop", undefined, undefined, tallyOf({ t: "encounter.add", entries: [] }));
    assert.equal(s.popUndo("dm")?.label, "adding 2 tokens");
    // A big move sent in bands counts each token once, and a band of other ops stops the count rather than mixing it in.
    const moved = (...ids: string[]) => tallyOf({ t: "token.moveMany", moves: ids.map((tokenId) => ({ tokenId, x: 1, y: 1 })) });
    s.push("dm", inverse(4), "moving 2 tokens", "move", undefined, undefined, moved("a", "b"));
    s.push("dm", inverse(5), "moving 2 tokens", "move", undefined, undefined, moved("b", "c"));
    assert.equal(s.popUndo("dm")?.label, "moving 3 tokens");
    s.push("dm", inverse(6), "moving 2 tokens", "mixed", undefined, undefined, moved("a", "b"));
    s.push("dm", inverse(7), "adding Wolf 3", "mixed", undefined, undefined, added("w3"));
    s.push("dm", inverse(8), "adding Wolf 4", "mixed", undefined, undefined, added("w4"));
    assert.equal(s.popUndo("dm")?.label, "moving 2 tokens");
    // A monster's image applied to its tokens, one update each.
    for (const [i, id] of ["w1", "w2", "w3"].entries()) s.push("dm", inverse(9 + i), "changing Wolf", "image", undefined, undefined, tallyOf({ t: "token.update", tokenId: id, patch: { image: null } }));
    assert.equal(s.popUndo("dm")?.label, "changing 3 tokens");
  });

  test("renaming a folder, sent as one move per scene, is named for the folder, not its first scene", () => {
    const s = new UndoStacks();
    const before = room({
      scenes: {
        s1: scene("s1", { name: "Crypt", folder: "Act one" }),
        s2: scene("s2", { name: "Tomb", folder: "Act one" }),
        s3: scene("s3", { name: "Town", folder: "Act two" }),
      },
    });
    const to = (sceneId: string, folder: string | null): ClientOp => ({ t: "scene.update", sceneId, patch: { folder } });
    s.push("dm", inverse(1), "moving the scene Crypt to the folder Act two", "rename", undefined, undefined, tallyOf(to("s1", "Act two"), before));
    s.push("dm", inverse(2), "moving the scene Tomb to the folder Act two", "rename", undefined, undefined, tallyOf(to("s2", "Act two"), before));
    assert.equal(s.popUndo("dm")?.label, "renaming the folder Act one to Act two");
    // One scene moved on its own keeps its own phrase, and so does a group that moves scenes between different folders.
    s.push("dm", inverse(3), "moving the scene Crypt to the folder Act two", undefined, undefined, undefined, tallyOf(to("s1", "Act two"), before));
    assert.equal(s.popUndo("dm")?.label, "moving the scene Crypt to the folder Act two");
    s.push("dm", inverse(4), "moving the scene Crypt to the folder Act three", "mixed", undefined, undefined, tallyOf(to("s1", "Act three"), before));
    s.push("dm", inverse(5), "moving the scene Town to the folder Act three", "mixed", undefined, undefined, tallyOf(to("s3", "Act three"), before));
    assert.equal(s.popUndo("dm")?.label, "moving the scene Crypt to the folder Act three");
    // A folder of one scene renames through one op, which the panel still sends as a gesture.
    s.push("dm", inverse(6), "moving the scene Town to the folder Act four", "lone", undefined, undefined, tallyOf(to("s3", "Act four"), before));
    assert.equal(s.popUndo("dm")?.label, "renaming the folder Act two to Act four");
    // Taking scenes out of their folder renames nothing.
    assert.equal(tallyOf(to("s1", null), before), undefined);
    assert.equal(tallyOf({ t: "scene.update", sceneId: "s1", patch: { folder: "Act two", name: "Crypt" } }, before), undefined);
  });

  test("a merged step that would grow past one restore starts a new step", () => {
    const s = new UndoStacks();
    const many = (from: number, n: number): RestoreEntry[] => Array.from({ length: n }, (_, i) => ({ key: `token:${from + i}`, value: null, expectRev: 0 }));
    s.push("dm", many(0, MAX_RESTORE_ENTRIES - 1), "painting floor", "g");
    s.push("dm", many(MAX_RESTORE_ENTRIES, 2), "painting floor", "g");
    assert.deepEqual(s.depth("dm"), { undo: 2, redo: 0 });
  });

  test("merging keeps each entity's earliest value under its latest guard", () => {
    const painted = { cells: { "1,1": "stone" } };
    const older: RestoreEntry[] = [
      { key: "chunk:s:0,0", value: { cells: {} }, expectHash: guardHash("chunk:s:0,0", painted) },
      { key: "label:l", value: null, expectHash: "b".repeat(32) },
    ];
    const newer: RestoreEntry[] = [
      { key: "chunk:s:0,0", value: painted, expectHash: "c".repeat(32) },
      { key: "chunk:s:1,0", value: null, expectHash: "d".repeat(32) },
    ];
    assert.deepEqual(mergeInverses(older, newer), [
      { key: "chunk:s:0,0", value: { cells: {} }, expectHash: "c".repeat(32) },
      { key: "label:l", value: null, expectHash: "b".repeat(32) },
      { key: "chunk:s:1,0", value: null, expectHash: "d".repeat(32) },
    ]);
    // An entity the older op removed must still be absent when the newer op finds it.
    const removed: RestoreEntry[] = [{ key: "label:l", value: { text: "Hall" }, expectRev: null }];
    assert.deepEqual(mergeInverses(removed, [{ key: "label:l", value: null, expectHash: "e".repeat(32) }]), [
      { key: "label:l", value: { text: "Hall" }, expectHash: "e".repeat(32) },
    ]);
    assert.equal(mergeInverses(removed, [{ key: "label:l", value: { text: "Hall 2" }, expectHash: "e".repeat(32) }]), null);
  });

  test("another member's edit between two ops of a gesture splits it, so undo never wipes that edit", () => {
    const A: Viewer = { memberId: "dmA", role: "dm" };
    const B: Viewer = { memberId: "dmB", role: "dm" };
    let state = room({ members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm") } });
    const stacks = new UndoStacks();
    const act = (op: Op, who: Viewer, seq: number) => {
      const result = applyOp(state, op, who, env(seq));
      assert.ok(result.ok);
      state = result.state;
      if (who === A) stacks.push("dmA", result.inverse!, "painting floor", "stroke");
    };
    const undo = (seq: number) => {
      const step = stacks.popUndo("dmA")!;
      return applyOp(state, { t: "sys.restore", entries: step.entries, from: "undo" }, A, env(seq));
    };
    const cells = () => state.buildChunks["s1:0,0"]?.cells ?? {};

    // A's stroke paints 0,0, B paints 1,0 in the same chunk, A's stroke goes on to 2,0.
    act({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["0,0"] }, A, 1);
    act({ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["1,0"] }, B, 2);
    act({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["2,0"] }, A, 3);
    assert.equal(stacks.depth("dmA").undo, 2);

    // The stroke's later part undoes back to what B left. Its first part would take B's cell, so it refuses.
    const later = undo(4);
    assert.ok(later.ok);
    state = later.state;
    assert.deepEqual(cells(), { "0,0": "stone", "1,0": "wood" });
    const first = undo(5);
    assert.ok(!first.ok);
    assert.equal(first.message, CHANGED_SINCE);
    assert.equal(cells()["1,0"], "wood");

    // Without B in between, the same stroke is one step and undoes whole.
    state = room({ members: { dmA: member("dmA", "dm") } });
    act({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["0,0"] }, A, 1);
    act({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["2,0"] }, A, 2);
    assert.equal(stacks.depth("dmA").undo, 1);
    const whole = undo(3);
    assert.ok(whole.ok);
    state = whole.state;
    assert.deepEqual(cells(), {});
  });
});

describe("a player's move undo", () => {
  /** A room where P1 owns a wolf and has just moved it from 1,1 to 5,5, with the step their stack keeps. */
  function moved() {
    let state = room({ tokens: { wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], x: 1, y: 1 }) } });
    const result = applyOp(state, { t: "token.move", tokenId: "wolf", x: 5, y: 5 }, P1, env(1));
    assert.ok(result.ok);
    state = result.state;
    const stacks = new UndoStacks();
    stacks.push("p1", result.inverse!, "moving Wolf", undefined, posesAfter(state, result.inverse!));
    return { state, step: stacks.popUndo("p1")! };
  }
  const visible = () => true;

  test("puts the token back and keeps what others changed since", () => {
    const { state, step } = moved();
    assert.deepEqual(step.poses, { wolf: { sceneId: "s1", x: 5, y: 5, elevation: 0, rotation: 0, size: "medium", path: "null", attached: "" } });
    const hurt = applyOp(state, { t: "actor.hp", target: { tokenId: "wolf" }, change: { kind: "damage", amount: 5 } }, { memberId: "dm1", role: "dm" }, env(2));
    assert.ok(hurt.ok);
    const built = poseRestore(hurt.state, { ...step, poses: step.poses! }, visible);
    assert.ok(built.ok);
    const undone = applyOp(hurt.state, { t: "sys.restore", entries: built.entries, from: "undo", deps: true }, P1, env(3));
    assert.ok(undone.ok);
    const wolf = undone.state.tokens.wolf!;
    assert.deepEqual([wolf.x, wolf.y], [1, 1]);
    assert.equal("inline" in wolf.actor && wolf.actor.inline.hp.cur, 15);
  });

  test("is refused once someone moved the token since", () => {
    const { state, step } = moved();
    const pushed = applyOp(state, { t: "token.move", tokenId: "wolf", x: 6, y: 5 }, { memberId: "dm1", role: "dm" }, env(2));
    assert.ok(pushed.ok);
    assert.deepEqual(poseRestore(pushed.state, { ...step, poses: step.poses! }, visible), { ok: false, code: "invalid", message: MOVED_SINCE });
    const raised = applyOp(state, { t: "token.update", tokenId: "wolf", patch: { elevation: 10 } }, { memberId: "dm1", role: "dm" }, env(2));
    assert.ok(raised.ok);
    assert.equal(poseRestore(raised.state, { ...step, poses: step.poses! }, visible).ok, false);
  });

  test("is refused once the token went to another scene, though it stands on the same spot there", () => {
    const { state, step } = moved();
    const sent = applyOp(state, { t: "token.update", tokenId: "wolf", patch: { sceneId: "s2" } }, { memberId: "dm1", role: "dm" }, env(2));
    assert.ok(sent.ok);
    assert.deepEqual([sent.state.tokens.wolf!.x, sent.state.tokens.wolf!.y], [5, 5]);
    assert.deepEqual(poseRestore(sent.state, { ...step, poses: step.poses! }, visible), { ok: false, code: "invalid", message: MOVED_SINCE });
  });

  test("puts a token back in its place on the scene it stands on, never on the scene the step found it on", () => {
    const { state, step } = moved();
    const before = step.entries[0]!.value as Token;
    const foundElsewhere = { ...step, entries: [{ ...step.entries[0]!, value: { ...before, sceneId: "s2" } }], poses: step.poses! };
    const built = poseRestore(state, foundElsewhere, visible);
    assert.ok(built.ok);
    const value = built.entries[0]!.value as Token;
    assert.deepEqual([value.sceneId, value.x, value.y], ["s1", 1, 1]);
  });

  test("answers a token out of sight as gone, before looking at where it stands", () => {
    const { state, step } = moved();
    const pushed = applyOp(state, { t: "token.move", tokenId: "wolf", x: 6, y: 5 }, { memberId: "dm1", role: "dm" }, env(2));
    assert.ok(pushed.ok);
    assert.deepEqual(poseRestore(pushed.state, { ...step, poses: step.poses! }, () => false), { ok: false, code: "gone", message: "that is not here" });
    const { tokens: _gone, ...rest } = state;
    assert.equal(poseRestore({ ...rest, tokens: {} }, { ...step, poses: step.poses! }, visible).ok, false);
  });

  test("a step names the op that made it, the newest of a merged gesture, through an undo and a redo", () => {
    const stacks = new UndoStacks();
    const from = (n: number) => ({ client: "s|c1", n });
    stacks.push("p1", [{ key: "token:a", value: null, expectHash: "a".repeat(32) }], "moving a", "g", undefined, from(1));
    stacks.push("p1", [{ key: "token:b", value: null, expectHash: "b".repeat(32) }], "moving a", "g", undefined, from(2));
    assert.equal(stacks.depth("p1").undo, 1);
    assert.equal(stacks.newestIs("p1", from(1)), false);
    assert.equal(stacks.newestIs("p1", { client: "s|c2", n: 2 }), false, "another device's op of the same number");
    assert.equal(stacks.newestIs("p1", from(2)), true);
    const step = stacks.popUndo("p1")!;
    assert.equal(stacks.newestIs("p1", from(2)), false);
    stacks.pushRestored("p1", "undo", step.entries, step.label, undefined, step.origin);
    const redone = stacks.popRedo("p1")!;
    stacks.pushRestored("p1", "redo", redone.entries, redone.label, undefined, redone.origin);
    assert.equal(stacks.newestIs("p1", from(2)), true);
  });

  test("a group's moves merge into one step that keeps where the last op left each token", () => {
    const stacks = new UndoStacks();
    const at = (x: number) => ({ sceneId: "s1", x, y: 0, elevation: 0, rotation: 0, size: "medium" as const, path: "null", attached: "" });
    stacks.push("p1", [{ key: "token:a", value: null, expectHash: "a".repeat(32) }], "moving 3 tokens", "g", { a: at(1) });
    stacks.push("p1", [{ key: "token:b", value: null, expectHash: "b".repeat(32) }], "moving 3 tokens", "g", { b: at(2) });
    stacks.push("p1", [{ key: "drawing:d", value: null, expectHash: "c".repeat(32) }], "drawing", "g");
    assert.deepEqual(stacks.depth("p1"), { undo: 2, redo: 0 });
    stacks.popUndo("p1");
    assert.deepEqual(stacks.popUndo("p1")?.poses, { a: at(1), b: at(2) });
  });
});

describe("a player's move undo and the path of the turn", () => {
  const visible = () => true;
  const deps = { canUseAsset: () => true };

  test("takes the move's leg back with it, keeps the legs before it, and the turn passing between changes nothing", () => {
    let state = room({ tokens: { wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], x: 1, y: 1 }) } });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "wolf", value: 20 }, { id: "n2", value: 5 }] }, DM, 1);
    state = apply(state, { t: "encounter.next" }, DM, 2);
    const stacks = new UndoStacks();
    for (const [seq, x] of [[3, 3], [4, 5]] as const) {
      const result = applyOp(state, { t: "token.move", tokenId: "wolf", x, y: 1 }, P1, env(seq));
      assert.ok(result.ok);
      state = result.state;
      stacks.push("p1", result.inverse!, "moving Wolf", undefined, posesAfter(state, result.inverse!));
    }
    assert.equal(state.tokens.wolf!.path!.stops.length, 3);
    state = apply(state, { t: "actor.hp", target: { tokenId: "wolf" }, change: { kind: "damage", amount: 5 } }, DM, 5);
    state = apply(state, { t: "encounter.next" }, DM, 6);
    const undo = () => {
      const step = stacks.popUndo("p1")!;
      const built = poseRestore(state, { ...step, poses: step.poses! }, visible);
      assert.ok(built.ok);
      const op: Op = { t: "sys.restore", entries: built.entries, from: "undo", deps: true };
      assert.ok(canApply(op, P1, state, deps).ok, "the player's restore check lets the path go back with the token");
      const result = applyOp(state, op, P1, env(7));
      assert.ok(result.ok);
      state = result.state;
    };
    undo();
    const wolf = state.tokens.wolf!;
    assert.deepEqual([wolf.x, wolf.y], [3, 1]);
    assert.deepEqual(wolf.path!.stops.map((s) => s.x), [1, 3]);
    assert.equal("inline" in wolf.actor && wolf.actor.inline.hp.cur, 15, "damage dealt since stays");
    undo();
    assert.equal(state.tokens.wolf!.path, undefined, "before its first move it had none");
  });

  test("is refused once the token was moved away and back since, which would take the later legs with it", () => {
    let state = room({ tokens: { wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], x: 1, y: 1 }) } });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "wolf", value: 20 }, { id: "n2", value: 5 }] }, DM, 1);
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "token.move", tokenId: "wolf", x: 4, y: 1 }, P1, 3);
    const marked = applyOp(state, { t: "token.countLeg", tokenId: "wolf", counts: false }, P1, env(4));
    assert.ok(marked.ok);
    state = marked.state;
    const stacks = new UndoStacks();
    stacks.push("p1", marked.inverse!, "marking Wolf's move", undefined, posesAfter(state, marked.inverse!));
    const step = stacks.popUndo("p1")!;
    state = apply(state, { t: "token.move", tokenId: "wolf", x: 8, y: 1 }, DM, 5);
    state = apply(state, { t: "token.move", tokenId: "wolf", x: 4, y: 1 }, DM, 6);
    assert.equal(state.tokens.wolf!.path!.stops.length, 4);
    assert.deepEqual(poseRestore(state, { ...step, poses: step.poses! }, visible), { ok: false, code: "invalid", message: MOVED_SINCE });
    // HP is still none of its business.
    const fresh = apply(marked.state, { t: "actor.hp", target: { tokenId: "wolf" }, change: { kind: "damage", amount: 5 } }, DM, 5);
    assert.ok(poseRestore(fresh, { ...step, poses: step.poses! }, visible).ok);
  });

  test("reads no path the player's copy does not show: the DM's mark on a leg of a row hidden from them refuses nothing (docs/design-v1-attach.md 8.0)", () => {
    // P1 moves a creature they do not own, as the room lets every player move any token, so a row hidden from them hides its path.
    // Its owners get the path of its own turn on a hidden row too (review AT-HIDDENPATH), so for them a mark refuses as on a shown one.
    for (const [owners, hidden] of [[[], false], [[], true], [["p1"], true]] as const) {
      let state = room({ tokens: { dog: token("dog", { name: "Mastiff", kind: "npc", ownerIds: [...owners], x: 5, y: 5, visibility: owners.length > 0 ? "dm" : "all", actor: { inline: actor({ speeds: { walk: 30 } }) } }) } });
      state.meta.settings = { ...state.meta.settings, revealHiddenOnTurn: false, playersMoveAny: "all" };
      state = apply(state, { t: "encounter.start", entries: [{ id: "ed", tokenId: "dog", value: 20, hidden }, { id: "n2", value: 5 }] }, DM, 1);
      state = apply(state, { t: "encounter.next" }, DM, 2);
      const table = new UndoTable(state);
      table.seq = 10;
      assert.equal(table.play(P1, { t: "token.move", tokenId: "dog", x: 7, y: 5 }), "ok");
      const path = (projectEntity(keys.token("dog"), table.state, P1, { sceneId: "s1" }) as Token).path;
      const shown = !hidden || owners.length > 0;
      assert.equal(path !== undefined, shown, "the path reaches P1 only while the row is shown, or on its own turn for its owners");
      assert.equal(table.play(DM, { t: "token.countLeg", tokenId: "dog", counts: false }), "ok");
      // A mark P1 sees refuses the undo, as a move would. One P1 never receives refuses nothing, so the answer tells nothing.
      assert.equal(table.undo(P1), shown ? MOVED_SINCE : "ok");
    }
  });
});

describe("squeezes and teleports on a player's move undo (docs/design-v1-maps-vision.md 4.1)", () => {
  const visible = () => true;
  const deps = { canUseAsset: () => true };
  const DM_VIEWER: Viewer = { memberId: "dm1", role: "dm" };

  /** Applies a player's op and records its step as the actor does. */
  function play(state: ReturnType<typeof room>, op: Op, stacks: UndoStacks, seq: number) {
    const result = applyOp(state, op, P1, env(seq));
    assert.ok(result.ok, `${op.t}: ${result.ok ? "" : result.message}`);
    const teleport = op.t === "token.move" && op.teleport !== undefined;
    stacks.push("p1", result.inverse!, "moving Ogre", undefined, posesAfter(result.state, result.inverse!), undefined, undefined, teleport);
    return result.state;
  }

  /** Takes the newest step back, or forward, as the actor builds it. */
  function restore(state: ReturnType<typeof room>, stacks: UndoStacks, from: "undo" | "redo", seq: number) {
    const step = from === "undo" ? stacks.popUndo("p1")! : stacks.popRedo("p1")!;
    const built = poseRestore(state, { ...step, poses: step.poses! }, visible);
    assert.ok(built.ok);
    const op: Op = { t: "sys.restore", entries: built.entries, from, deps: true, ...(step.teleport ? { teleport: true as const } : {}) };
    assert.ok(canApply(op, P1, state, deps).ok, `the player's ${from} is allowed`);
    const result = applyOp(state, op, P1, env(seq));
    assert.ok(result.ok);
    stacks.pushRestored("p1", from, result.inverse!, step.label, posesAfter(result.state, result.inverse!), step.origin, step.teleport === true);
    return result.state;
  }

  test("undoing a move into a corridor takes the squeeze off, undoing one out puts it back, damage kept, and redo does the reverse", () => {
    let state = room({ tokens: { ogre: token("ogre", { name: "Ogre", size: "large", ownerIds: ["p1"], x: 2, y: 2 }) } });
    const stacks = new UndoStacks();
    state = play(state, { t: "token.move", tokenId: "ogre", x: 2.5, y: 5, squeeze: true }, stacks, 1);
    state = play(state, { t: "token.move", tokenId: "ogre", x: 2, y: 9 }, stacks, 2);
    assert.ok(!("squeeze" in state.tokens.ogre!));
    state = apply(state, { t: "actor.hp", target: { tokenId: "ogre" }, change: { kind: "damage", amount: 4 } }, DM_VIEWER, 3);
    state = restore(state, stacks, "undo", 4);
    assert.equal(state.tokens.ogre!.squeeze, true, "undoing the move out puts the squeeze back");
    assert.deepEqual([state.tokens.ogre!.x, state.tokens.ogre!.y], [2.5, 5]);
    state = restore(state, stacks, "undo", 5);
    assert.ok(!("squeeze" in state.tokens.ogre!), "undoing the move in takes it off");
    assert.equal("inline" in state.tokens.ogre!.actor && state.tokens.ogre!.actor.inline.hp.cur, 16);
    state = restore(state, stacks, "redo", 6);
    assert.equal(state.tokens.ogre!.squeeze, true, "redo squeezes it again");
  });

  test("a step's pose holds the squeeze, so an undo refuses once someone squeezed or unsqueezed it since", () => {
    let state = room({ tokens: { ogre: token("ogre", { name: "Ogre", size: "large", ownerIds: ["p1"], x: 2, y: 2 }) } });
    const stacks = new UndoStacks();
    state = play(state, { t: "token.move", tokenId: "ogre", x: 2.5, y: 5 }, stacks, 1);
    const step = stacks.popUndo("p1")!;
    assert.ok(!("squeeze" in step.poses!.ogre!));
    const squeezed = apply(state, { t: "token.move", tokenId: "ogre", x: 2.5, y: 5, squeeze: true }, DM_VIEWER, 2);
    assert.deepEqual(poseRestore(squeezed, { ...step, poses: step.poses! }, visible), { ok: false, code: "invalid", message: MOVED_SINCE });
  });

  test("a teleport's step says so through undo and redo, and a walk merged into it is tested again", () => {
    const stacks = new UndoStacks();
    stacks.push("p1", [{ key: "token:a", value: null, expectHash: "a".repeat(32) }], "moving a", undefined, undefined, undefined, undefined, true);
    const step = stacks.popUndo("p1")!;
    assert.equal(step.teleport, true);
    stacks.pushRestored("p1", "undo", step.entries, step.label, undefined, undefined, step.teleport === true);
    const redo = stacks.popRedo("p1")!;
    assert.equal(redo.teleport, true);
    stacks.pushRestored("p1", "redo", redo.entries, redo.label, undefined, undefined, redo.teleport === true);
    assert.equal(stacks.popUndo("p1")!.teleport, true);
    stacks.push("p1", [{ key: "token:a", value: null, expectHash: "a".repeat(32) }], "moving a", "g", {}, undefined, undefined, true);
    stacks.push("p1", [{ key: "token:b", value: null, expectHash: "b".repeat(32) }], "moving a", "g", {}, undefined, undefined, false);
    assert.equal(stacks.popUndo("p1")!.teleport, undefined);
    stacks.push("p1", [{ key: "token:a", value: null, expectHash: "a".repeat(32) }], "moving a");
    assert.equal(stacks.popUndo("p1")!.teleport, undefined);
  });

  test("a teleport past a wall undoes, and its redo passes the wall again, in a fight and outside one", () => {
    for (const fight of [false, true]) {
      let state = room({ tokens: { thorn: token("thorn", { name: "Thorn", ownerIds: ["p1"], x: 1, y: 1 }) } });
      state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "3,1,w": { kind: "wall" } } };
      state.scenes.s1!.blockMovement = true;
      if (fight) {
        state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }, { id: "n2", value: 5 }] }, DM_VIEWER, 1);
        state = apply(state, { t: "encounter.next" }, DM_VIEWER, 2);
      }
      const stacks = new UndoStacks();
      state = play(state, { t: "token.move", tokenId: "thorn", x: 6, y: 1, teleport: "wall" }, stacks, 3);
      const lines = state.log.filter((e) => e.data?.type === "teleport").length;
      assert.equal(lines, 1);
      state = restore(state, stacks, "undo", 4);
      assert.equal(state.tokens.thorn!.x, 1);
      state = restore(state, stacks, "redo", 5);
      assert.equal(state.tokens.thorn!.x, 6);
      assert.equal(state.log.filter((e) => e.data?.type === "teleport").length, lines, "undo and redo write no new line");
      if (fight) assert.deepEqual(state.tokens.thorn!.path!.stops.map((s) => s.uncounted === true), [false, true]);
    }
  });
});

describe("a player's resize undo (docs/design-v1-token-window.md 8.7)", () => {
  const visible = () => true;
  const deps = { canUseAsset: () => true };
  const DM_VIEWER: Viewer = { memberId: "dm1", role: "dm" };

  /** P1's bear, Medium at 4,4, on a scene that blocks moves, and a wolf of theirs. */
  function bear() {
    const state = room({ tokens: { bear: token("bear", { name: "Bear", ownerIds: ["p1"], x: 4, y: 4 }), wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], x: 10, y: 4 }) } });
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off" };
    return state;
  }

  /** A player's op, checked and applied as the actor does, its step recorded with poses for a move or a resize. */
  function play(state: ReturnType<typeof room>, op: Op, stacks: UndoStacks, seq: number) {
    assert.ok(canApply(op, P1, state, deps).ok, `${op.t} is allowed`);
    const result = applyOp(state, op, P1, env(seq));
    assert.ok(result.ok, `${op.t}: ${result.ok ? "" : result.message}`);
    assert.ok(UndoStacks.records("player", op));
    stacks.push("p1", result.inverse!, "resizing Bear to Large", undefined, posesAfter(result.state, result.inverse!));
    return result.state;
  }

  /** An undo or redo as the actor builds and checks it: the answer's words, or the state after it. */
  function restore(state: ReturnType<typeof room>, stacks: UndoStacks, from: "undo" | "redo", seq: number): { state: ReturnType<typeof room> } | { refused: string } {
    const step = from === "undo" ? stacks.popUndo("p1")! : stacks.popRedo("p1")!;
    const built = poseRestore(state, { ...step, poses: step.poses! }, visible);
    if (!built.ok) return { refused: built.message };
    const op: Op = { t: "sys.restore", entries: built.entries, from, deps: true };
    const decision = canApply(op, P1, state, deps);
    if (!decision.ok) return { refused: decision.message };
    const result = applyOp(state, op, P1, env(seq));
    assert.ok(result.ok);
    stacks.pushRestored("p1", from, result.inverse!, step.label, posesAfter(result.state, result.inverse!), step.origin);
    return { state: result.state };
  }
  const settled = (r: ReturnType<typeof restore>) => {
    assert.ok("state" in r, "refused" in r ? r.refused : "");
    return r.state;
  };
  const grow: Op = { t: "token.update", tokenId: "bear", patch: { size: "large" } };

  test("takes back the size and the place alone, damage dealt since kept, and redo grows it again", () => {
    const stacks = new UndoStacks();
    let state = play(bear(), { t: "token.update", tokenId: "bear", patch: { size: "huge", x: 3, y: 3 } }, stacks, 1);
    assert.deepEqual(stacks.peek("p1", "undo")!.poses!.bear, { sceneId: "s1", x: 3, y: 3, elevation: 0, rotation: 0, size: "huge", path: "null", attached: "" });
    state = apply(state, { t: "actor.hp", target: { tokenId: "bear" }, change: { kind: "damage", amount: 6 } }, DM_VIEWER, 2);
    state = settled(restore(state, stacks, "undo", 3));
    const bearNow = state.tokens.bear!;
    assert.deepEqual([bearNow.size, bearNow.x, bearNow.y], ["medium", 4, 4]);
    assert.equal("inline" in bearNow.actor && bearNow.actor.inline.hp.cur, 14, "the damage stays");
    state = settled(restore(state, stacks, "redo", 4));
    assert.deepEqual([state.tokens.bear!.size, state.tokens.bear!.x, state.tokens.bear!.y], ["huge", 3, 3]);
    assert.equal("inline" in state.tokens.bear!.actor && state.tokens.bear!.actor.inline.hp.cur, 14);
  });

  test("is refused once someone moved or resized the token since", () => {
    for (const since of [
      { t: "token.move", tokenId: "bear", x: 6, y: 4 },
      { t: "token.update", tokenId: "bear", patch: { size: "huge", x: 3, y: 3 } },
      { t: "token.update", tokenId: "bear", patch: { size: "custom", w: 2, h: 2 } },
    ] as Op[]) {
      const stacks = new UndoStacks();
      let state = play(bear(), grow, stacks, 1);
      state = apply(state, since, DM_VIEWER, 2);
      assert.deepEqual(restore(state, stacks, "undo", 3), { refused: MOVED_SINCE }, JSON.stringify(since));
    }
    // A move's undo is refused the same way once the DM resized the token, as the size is part of where it stands.
    const stacks = new UndoStacks();
    let state = play(bear(), { t: "token.move", tokenId: "bear", x: 6, y: 4 }, stacks, 1);
    state = apply(state, { t: "token.update", tokenId: "bear", patch: { size: "large" } }, DM_VIEWER, 2);
    assert.deepEqual(restore(state, stacks, "undo", 3), { refused: MOVED_SINCE });
  });

  test("a wall drawn between a growth's undo and its redo refuses the redo", () => {
    const stacks = new UndoStacks();
    let state = play(bear(), grow, stacks, 1);
    state = settled(restore(state, stacks, "undo", 2));
    state = apply(state, { t: "build.walls", sceneId: "s1", put: [{ id: "wall00000001", a: [5, 4], b: [5, 6], f: { kind: "wall" } }] }, DM_VIEWER, 3);
    assert.deepEqual(restore(state, stacks, "redo", 4), { refused: NO_ROOM_TO_GROW_BACK }, "in a restore's words");
  });

  test("a token given to another player since refuses the undo and the redo, while a move's undo in the same room passes", () => {
    const give = (state: ReturnType<typeof room>, seq: number) => {
      let next = apply(state, { t: "room.update", settings: { playersMoveAny: "all" } }, DM_VIEWER, seq);
      next = apply(next, { t: "token.update", tokenId: "bear", patch: { ownerIds: ["p2"] } }, DM_VIEWER, seq + 1);
      return apply(next, { t: "token.update", tokenId: "wolf", patch: { ownerIds: ["p2"] } }, DM_VIEWER, seq + 2);
    };
    const undoStacks = new UndoStacks();
    let state = play(bear(), grow, undoStacks, 1);
    state = give(state, 2);
    assert.deepEqual(restore(state, undoStacks, "undo", 5), { refused: "that is not yours" });

    const redoStacks = new UndoStacks();
    let again = play(bear(), grow, redoStacks, 1);
    again = settled(restore(again, redoStacks, "undo", 2));
    again = give(again, 3);
    assert.deepEqual(restore(again, redoStacks, "redo", 6), { refused: "that is not yours" });

    const moveStacks = new UndoStacks();
    let moved = play(bear(), { t: "token.move", tokenId: "wolf", x: 12, y: 4 }, moveStacks, 1);
    moved = give(moved, 2);
    settled(restore(moved, moveStacks, "undo", 5));
  });
});

describe("asks for saves and undo (docs/design-v1-player-save-spell.md 5.6)", () => {
  test("no close of an ask goes on a stack, the DM's Dismiss and Close the ask included, nor a player's ask", () => {
    for (const end of ["done", "dismissed", "withdrawn"] as const) {
      assert.equal(UndoStacks.records("dm", { t: "cast.close", castId: "k1", end }), false, end);
      assert.equal(UndoStacks.records("player", { t: "cast.close", castId: "k1", end }), false, end);
    }
    assert.equal(UndoStacks.records("player", { t: "cast.ask", cast: { id: "k1", caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" } }), false);
  });

  test("the Apply goes on the DM's stack, and its undo brings the ask back with the caster's roll", () => {
    const before = castTable({ casts: { k1: castAsk("k1", { damage: { tag: "dmg", parts: 1 }, rolled: [{ formula: "8d6", total: 28, type: "fire" }] }) } });
    const outcome: Op = { t: "actor.outcome", plan: "pl1", label: "Fireball", cast: "k1", targets: [{ target: { tokenId: "g1" }, amount: 14 }] };
    assert.equal(UndoStacks.records("dm", outcome), true);
    const r = applyOp(before, outcome, DM, env(60));
    assert.ok(r.ok && r.inverse);
    const stacks = new UndoStacks();
    stacks.push("dm1", r.inverse, "applying Fireball to Goblin 1");
    const step = stacks.popUndo("dm1")!;
    const undone = apply(r.state, { t: "sys.restore", entries: step.entries, from: "undo", deps: true }, DM, 61);
    const { rev: _rev, ...back } = undone.casts.k1!;
    const { rev: _was, ...was } = before.casts.k1!;
    assert.deepEqual(back, was);
    assert.equal(eventLines(undone.log).filter((e) => e.data?.type === "cast").length, 1, "the undo writes no line of its own, so no toast");
  });
});

describe("a player's walks around walls on undo and redo (docs/design-v1-movement.md 7.4)", () => {
  const visible = () => true;
  const deps = { canUseAsset: () => true };
  const route: [number, number, number, 0 | 1][] = [
    [1, 4, 0, 0],
    [6, 4, 0, 0],
    [6, 1, 0, 0],
  ];

  /** A wall along x = 3 from y = 0 to 3, which Thorn walks around. */
  function walled() {
    const state = room({ tokens: { thorn: token("thorn", { name: "Thorn", ownerIds: ["p1"], x: 1, y: 1 }) } });
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "3,0,w": { kind: "wall" }, "3,1,w": { kind: "wall" }, "3,2,w": { kind: "wall" } } };
    state.scenes.s1!.blockMovement = true;
    return state;
  }

  test("the step keeps the route, its redo carries it and passes the wall the straight leg would meet, undone and redone again", () => {
    let state = walled();
    const stacks = new UndoStacks();
    const op: Op = { t: "token.move", tokenId: "thorn", x: 6, y: 1, route };
    const moved = applyOp(state, op, P1, env(1));
    assert.ok(moved.ok);
    state = moved.state;
    stacks.push("p1", moved.inverse!, "moving Thorn", undefined, posesAfter(state, moved.inverse!), undefined, undefined, false, { tokenId: "thorn", route, routed: true });
    for (const [from, seq] of [["undo", 2], ["redo", 3], ["undo", 4], ["redo", 5]] as const) {
      const step = from === "undo" ? stacks.popUndo("p1")! : stacks.popRedo("p1")!;
      assert.deepEqual(step.routes, { thorn: [route] });
      assert.equal(step.routed, true);
      const built = poseRestore(state, { ...step, poses: step.poses! }, visible);
      assert.ok(built.ok);
      const restore: Op = { t: "sys.restore", entries: built.entries, from, deps: true, ...(from === "redo" && step.routed ? { routes: step.routes! } : {}) };
      assert.ok(canApply(restore, P1, state, deps).ok, `the ${from} passes`);
      if (from === "redo") {
        const { routes: _routes, ...straight } = restore as Extract<Op, { t: "sys.restore" }>;
        assert.equal(canApply(straight, P1, state, deps).ok, false, "the straight leg meets the wall");
      }
      const result = applyOp(state, restore, P1, env(seq));
      assert.ok(result.ok);
      state = result.state;
      stacks.pushRestored("p1", from, result.inverse!, step.label, posesAfter(state, result.inverse!), step.origin, false, step);
    }
  });

  test("a merged step keeps its walks in order, a plain move among them as one piece, and drops them when a move left none", () => {
    const stacks = new UndoStacks();
    const entry = (k: string): RestoreEntry[] => [{ key: `token:${k}`, value: null, expectHash: k.repeat(32) }];
    // Entries of their own keys, so the two merge whatever their guards say: only the walks are under test.
    stacks.push("p1", entry("a"), "moving a", "g", {}, undefined, undefined, false, { tokenId: "a", route: [[2, 2, 0, 0]], routed: false });
    stacks.push("p1", entry("c"), "moving a", "g", {}, undefined, undefined, false, { tokenId: "a", route, routed: true });
    const merged = stacks.popUndo("p1")!;
    assert.deepEqual(merged.routes, { a: [[[2, 2, 0, 0]], route] });
    assert.equal(merged.routed, true);
    stacks.push("p1", entry("a"), "moving a", "h", {}, undefined, undefined, false, { tokenId: "a", route: [[2, 2, 0, 0]], routed: false });
    assert.equal(stacks.popUndo("p1")!.routed, undefined, "plain moves alone redo by the straight leg");
    stacks.push("p1", entry("a"), "moving a", "i", {}, undefined, undefined, false, { tokenId: "a", route, routed: true });
    stacks.push("p1", entry("b"), "moving b", "i", {});
    const dropped = stacks.popUndo("p1")!;
    assert.deepEqual([dropped.routes, dropped.routed], [undefined, undefined]);
  });
});
