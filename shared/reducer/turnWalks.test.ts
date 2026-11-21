import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readEntity } from "../keys.ts";
import type { EncounterSnapshot, RoomState, TokenPath, Viewer } from "../model.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { guardHash } from "./tx.ts";
import { pathThisTurn } from "../rules/path.ts";
import { HISTORY_BYTES, serializedBytes } from "../limits.ts";
import { AT, DM, P1, effect, entry, room, token } from "../testutil.ts";

/*
 * A creature's walk ends with its turn from op version 65 (D-261120-100,
 * shared/migrate.ts walksEndWithTurn): every turn's end takes the walks
 * off, a Next keeps those of its turn in its step, Previous puts them back,
 * and a restore keeps a walk only on its own turn. Ops stored at 64 replay
 * as they ran.
 */

const NEXT: Op = { t: "encounter.next" };
const PREV: Op = { t: "encounter.prev" };
const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

/** An undo of a step as the server builds a player's: the step's values, guarded by the room as it is now (undo.ts poseRestore). */
const undoNow = (state: RoomState, entries: readonly RestoreEntry[]): Op => ({
  t: "sys.restore",
  entries: entries.map((e) => ({ key: e.key, value: e.value, expectHash: guardHash(e.key, readEntity(state, e.key)) })),
  from: "undo",
  deps: true,
});

/**
 * The wolf's turn, named 7, with P1's hero next: the wolf, the DM's, at
 * 9,9. With `goblin`, the DM's goblin acts between them. Each op gets the
 * next seq. With `opVersion`, every op runs as one stored at that version,
 * unless `run` names another.
 */
function fight(opVersion?: number, goblin = false) {
  const state = room({ tokens: { wolf: token("wolf", { x: 9, y: 9 }), gob: token("gob", { x: 15, y: 15 }), hero: token("hero", { kind: "pc", ownerIds: ["p1"], x: 2, y: 2 }) } });
  state.meta.settings = { ...state.meta.settings, playersMoveAny: "all" };
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "rwolf",
    entries: [entry("rwolf", { tokenId: "wolf", value: 20 }), ...(goblin ? [entry("rgob", { tokenId: "gob", value: 10 })] : []), entry("rhero", { tokenId: "hero", value: 5 })],
    turnStart: { entryId: "rwolf", tokenId: "wolf", sceneId: "s1", x: 9, y: 9, elevation: 0, seen: true, seq: 7 },
  };
  const f = {
    state,
    seq: 10,
    inverse: null as RestoreEntry[] | null,
    // `version` null runs the op live.
    run(op: Op, who: Viewer = DM, version: number | null | undefined = opVersion) {
      f.seq++;
      const result = applyOp(f.state, op, who, { seq: f.seq, at: AT, ...(version != null ? { opVersion: version } : {}) });
      assert.ok(result.ok, result.ok ? "" : `${op.t}: ${result.message}`);
      f.state = result.state;
      f.inverse = result.inverse;
      return f;
    },
    path(id: string): TokenPath | undefined {
      return f.state.tokens[id]!.path;
    },
  };
  return f;
}

describe("a walk ends with its turn (D-261120-100)", () => {
  test("Next takes every walk off and keeps the turn's in its step, and Previous puts them back", () => {
    const f = fight().run(move("wolf", 9, 11), P1).run(move("wolf", 10, 12), P1);
    const walked = f.path("wolf")!;
    assert.equal(walked.stops.length, 3, "the wolf walked two legs");
    f.run(NEXT);
    assert.equal(f.path("wolf"), undefined, "the turn's end takes the walk off");
    assert.deepEqual(f.state.encounterHistory.at(-1)!.walks, [{ tokenId: "wolf", sceneId: "s1", x: 10, y: 12, elevation: 0, path: walked }], "its step keeps it with where the wolf stood");
    f.run(move("hero", 3, 2), P1);
    assert.ok(f.path("hero"), "the hero walks on its own turn");
    f.run(PREV);
    assert.deepEqual(f.path("wolf"), walked, "Previous puts the wolf's walk back");
    assert.equal(pathThisTurn(f.state.encounter, f.state.tokens.wolf!), f.state.tokens.wolf!.path, "as the turn's");
    assert.equal(f.path("hero"), undefined, "and the hero's turn taken back ends its walk");
  });

  test("a creature moved since its turn ended starts it again with no walk", () => {
    const f = fight().run(move("wolf", 9, 11), P1).run(NEXT).run(move("wolf", 4, 4)).run(PREV);
    assert.equal(f.path("wolf"), undefined);
    const back = fight().run(move("wolf", 9, 11), P1).run(NEXT).run(move("wolf", 4, 4)).run(move("wolf", 9, 11)).run(PREV);
    assert.ok(back.path("wolf"), "one back where the turn left it gets it");
  });

  test("a removal that passes the turn, and a fight's end, take every walk off", () => {
    const removed = fight().run(move("wolf", 9, 11), P1).run({ t: "encounter.remove", entryIds: ["rwolf"] });
    assert.equal(removed.path("wolf"), undefined, "a removal of the acting row");
    assert.equal(removed.state.encounter?.activeEntryId, "rhero", "which passed the turn on");
    const ended = fight().run(move("wolf", 9, 11), P1).run({ t: "encounter.end" });
    assert.equal(ended.path("wolf"), undefined, "a fight's end");
    const deleted = fight();
    deleted.state.tokens.hero = { ...deleted.state.tokens.hero!, path: { turn: 3, stops: [{ x: 1, y: 2, elevation: 0, seen: true }, { x: 2, y: 2, elevation: 0, seen: true }] } };
    deleted.run({ t: "token.delete", tokenId: "wolf" });
    assert.equal(deleted.state.encounter?.activeEntryId, "rhero");
    assert.equal(deleted.path("hero"), undefined, "a delete of the acting creature, whose row leaves with it");
  });

  test("a removal that leaves the acting row keeps the turn's walks", () => {
    const f = fight().run(move("wolf", 9, 11), P1).run({ t: "encounter.remove", entryIds: ["rhero"] });
    assert.ok(f.path("wolf"));
  });

  test("an older walk a room kept from before op version 65 goes at the next turn's end, and a step of a turn it did not walk keeps none", () => {
    const f = fight();
    f.state.tokens.hero = { ...f.state.tokens.hero!, path: { turn: 3, stops: [{ x: 1, y: 2, elevation: 0, seen: true }, { x: 2, y: 2, elevation: 0, seen: true }] } };
    f.run(NEXT);
    assert.equal(f.path("hero"), undefined);
    assert.deepEqual(f.state.encounterHistory.at(-1)!.walks, [], "every step from 65 holds its walks, none here");
  });

  /** Feet walked on a walk, as movement used reads them. */
  const feet = (path: TokenPath | undefined) => (path?.stops ?? []).reduce((total, stop) => total + (stop.moved ?? 0), 0);

  test("Previous at 65 over a step saved at 64 keeps the resumed turn's walk where 64 left it (FLR4INT-ASTRA-07)", () => {
    const f = fight(64).run(move("wolf", 11, 9), P1).run(move("wolf", 9, 9), P1);
    const walked = f.path("wolf");
    assert.equal(feet(walked), 20, "10 ft out and 10 ft back");
    f.run(NEXT);
    assert.equal(f.state.encounterHistory.at(-1)!.walks, undefined, "a step saved at 64 holds no walks");
    f.run(PREV, DM, null);
    assert.deepEqual(f.path("wolf"), walked);
    assert.equal(feet(pathThisTurn(f.state.encounter, f.state.tokens.wolf!) ?? undefined), 20, "Moved 20 ft, used 20 ft");
  });

  test("a turn's end at 65 keeps a walk from before 65 in the step saved at 64 that ended its turn, so Previous still brings it back", () => {
    const f = fight(64, true).run(move("wolf", 11, 9), P1).run(move("wolf", 9, 9), P1);
    const walked = f.path("wolf")!;
    f.run(NEXT);
    assert.equal(f.state.encounter?.activeEntryId, "rgob");
    f.run(NEXT, DM, null);
    assert.equal(f.path("wolf"), undefined, "the goblin's turn's end at 65 takes the wolf's walk off");
    assert.deepEqual(f.state.encounterHistory.map((step) => step.walks?.map((w) => w.tokenId)), [["wolf"], []], "into the wolf's step, and the goblin's step holds none");
    f.run(PREV, DM, null).run(PREV, DM, null);
    assert.equal(f.state.encounter?.activeEntryId, "rwolf");
    assert.deepEqual(f.path("wolf"), walked, "the wolf's turn resumes with its walk");
    assert.equal(feet(f.path("wolf")), 20);
  });

  /**
   * The history behind an older step that brings it to `short` bytes under its bound, and an oldest small step before
   * that, which fits beside the newer ones alone.
   */
  const padded = (history: readonly EncounterSnapshot[], short: number): EncounterSnapshot[] => {
    const first = history[0]!;
    const older = (pad: number, seq: number): EncounterSnapshot => ({ ...first, encounter: { ...first.encounter, turnStart: { ...first.encounter.turnStart!, seq } }, effects: { pad: [effect("pad", { key: "custom", label: "p".repeat(pad) })] } });
    const oldest = older(0, 1);
    const used = history.reduce((total, step) => total + serializedBytes(step), serializedBytes(oldest));
    const out = [oldest, older(HISTORY_BYTES - short - used - serializedBytes(older(0, 2)), 2), ...history];
    assert.equal(out.reduce((total, step) => total + serializedBytes(step), 0), HISTORY_BYTES - short);
    return out;
  };
  /** Each step's walks by creature, undefined for a step saved before 65. */
  const walksOf = (state: RoomState) => state.encounterHistory.map((step) => step.walks?.map((w) => w.tokenId));

  test("a turn's end at 65 keeps a walk from before 65 in its step at the history's bound, dropping the older steps it has no room beside (FLR4INT-ASTRA-10)", () => {
    const f = fight(64, true);
    for (const [x, y] of [[11, 9], [11, 11], [9, 11], [9, 13], [11, 13], [9, 9]] as const) f.run(move("wolf", x, y), P1);
    const walked = f.path("wolf")!;
    f.run(NEXT);
    f.state = { ...f.state, encounterHistory: padded(f.state.encounterHistory, 225) };
    f.run(NEXT, DM, null);
    assert.equal(f.path("wolf"), undefined);
    assert.deepEqual(walksOf(f.state), [["wolf"], []], "the older steps go, the oldest that would fit too, and the wolf's keeps its walk");
    f.run(PREV, DM, null).run(PREV, DM, null);
    assert.equal(f.state.encounter?.activeEntryId, "rwolf");
    assert.deepEqual(f.path("wolf"), walked, "the wolf's turn resumes with its walk");
  });

  /** A walk of 50 stops on turn 7, the wolf's, as a room kept from before 65 may hold it. */
  const long: TokenPath = { turn: 7, stops: Array.from({ length: 50 }, (_, i) => ({ x: 9 + (i % 5), y: 9, elevation: 0, seen: true as const })) };

  test("a removal that passes the turn, and Previous, keep a walk from before 65 in its step at the history's bound the same way (FLR4INT-ASTRA-10)", () => {
    const removal = fight(64, true).run(NEXT);
    removal.state = { ...removal.state, tokens: { ...removal.state.tokens, wolf: { ...removal.state.tokens.wolf!, path: long } }, encounterHistory: padded(removal.state.encounterHistory, 225) };
    removal.run({ t: "encounter.remove", entryIds: ["rgob"] }, DM, null);
    assert.equal(removal.state.encounter?.activeEntryId, "rhero");
    assert.deepEqual(walksOf(removal.state), [["wolf"]], "the removal files the walk and drops the older step");

    const f = fight(64, true).run(NEXT).run(NEXT);
    assert.equal(f.state.encounter?.activeEntryId, "rhero");
    f.state = { ...f.state, tokens: { ...f.state.tokens, wolf: { ...f.state.tokens.wolf!, path: long } }, encounterHistory: padded(f.state.encounterHistory, 225) };
    f.run(PREV, DM, null);
    assert.equal(f.state.encounter?.activeEntryId, "rgob");
    assert.deepEqual(walksOf(f.state), [["wolf"]], "Previous files the walk and drops the older step");
    f.run(PREV, DM, null);
    assert.deepEqual(f.path("wolf"), long, "the wolf's turn resumes with its walk");
  });

  test("Previous at 65 over a step whose turn left no walks takes the taken-back turn's walk off (FLR4-OPUS-12)", () => {
    const f = fight().run(NEXT).run(move("hero", 3, 2), P1);
    assert.ok(f.path("hero"), "the hero walks on its turn");
    assert.deepEqual(f.state.encounterHistory.at(-1)!.walks, []);
    f.run(PREV);
    assert.equal(f.state.encounter?.activeEntryId, "rwolf");
    assert.deepEqual(Object.values(f.state.tokens).filter((t) => t.path !== undefined).map((t) => t.id), [], "no walk is left");
  });

  test("a step keeps no list of who saw a stop", () => {
    const f = fight();
    f.state.tokens.wolf = { ...f.state.tokens.wolf!, x: 10, y: 9, path: { turn: 7, stops: [{ x: 9, y: 9, elevation: 0, seenBy: ["p1"] }, { x: 10, y: 9, elevation: 0, seen: true }] } };
    f.run(NEXT);
    assert.deepEqual(f.state.encounterHistory.at(-1)!.walks?.[0]?.path.stops, [{ x: 9, y: 9, elevation: 0 }, { x: 10, y: 9, elevation: 0, seen: true }]);
  });

  test("a restore keeps a walk only on its own turn: a move's undo after the turn ended leaves it off, the turn's end's undo brings it back", () => {
    const f = fight().run(move("wolf", 9, 11), P1).run(move("wolf", 10, 12), P1);
    const undoMove = f.inverse!;
    const walked = f.path("wolf");
    f.run(NEXT);
    const undoNext = f.inverse!;
    const afterNext = f.state;
    f.run(undoNow(f.state, undoMove), P1);
    assert.deepEqual([f.state.tokens.wolf!.x, f.state.tokens.wolf!.y], [9, 11], "the wolf goes back a leg");
    assert.equal(f.path("wolf"), undefined, "with no walk of the turn gone by");
    f.state = afterNext;
    f.run({ t: "sys.restore", entries: undoNext, from: "undo", deps: true });
    assert.deepEqual(f.path("wolf"), walked, "an undo of the Next puts the turn back with its walk");
  });

  test("ops stored at 64 keep every walk on its creature, and Previous reads it as before", () => {
    const f = fight(64).run(move("wolf", 9, 11), P1);
    const walked = f.path("wolf");
    f.run(NEXT);
    assert.deepEqual(f.path("wolf"), walked, "Next writes no token");
    assert.equal(f.state.encounterHistory.at(-1)!.walks, undefined);
    f.run(move("wolf", 4, 4), P1).run(move("wolf", 9, 11), P1);
    assert.equal(f.path("wolf"), undefined, "a move off its turn took it, as before");
    const kept = fight(64).run(move("wolf", 9, 11), P1).run(NEXT).run(PREV);
    assert.deepEqual(kept.path("wolf"), walked, "the walk never left");
    const ended = fight(64).run(move("wolf", 9, 11), P1).run({ t: "encounter.end" });
    assert.deepEqual(ended.path("wolf"), walked, "a fight's end left it too");
    const restored = fight(64).run(move("wolf", 9, 11), P1).run(move("wolf", 10, 12), P1);
    const undo = restored.inverse!;
    restored.run(NEXT).run(undoNow(restored.state, undo), P1);
    assert.deepEqual(restored.path("wolf"), walked, "and a restore put back the walk before the move");
  });
});
