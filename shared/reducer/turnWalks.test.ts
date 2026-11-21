import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity } from "../keys.ts";
import type { EncounterSnapshot, RoomState, Token, TokenPath, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { guardHash } from "./tx.ts";
import { pathThisTurn, turnUnderWay } from "../rules/path.ts";
import { HISTORY_BYTES, LIMITS, serializedBytes } from "../limits.ts";
import { AT, DM, FULL_TILE_BITS, P1, actor, effect, entry, room, token } from "../testutil.ts";

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

/*
 * The walk invariant (D-261121-127, 128): from op version 65 every op ends
 * with walks of the turn under way only on the turn's creature and the
 * mounts on its list. A mount that leaves the turn takes its walk with it,
 * a restore keeps a walk of the turn only on a creature that shares it,
 * and a room stored before 65 sheds its strays at its first op. The removal
 * is reported apart (Applied.walksDropped), so a player's undo step can
 * leave it out. A device's copy that cannot judge the turn or a mount's
 * chain leaves the walk as the room does.
 */

/** Pip's turn, named 7: Pip (P1's) on a controlled ride on Mastiff, Mastiff on a controlled ride on the warhorse, both on the turn's list. */
function riders(setup?: (s: RoomState) => void) {
  const state = room({
    tokens: {
      pip: token("pip", { name: "Pip", kind: "pc", size: "small", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "dog", kind: "ride", steer: true } }),
      dog: token("dog", { name: "Mastiff", kind: "npc", x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      gob: token("gob", { x: 20, y: 20 }),
    },
  });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "rpip",
    entries: [entry("rpip", { tokenId: "pip", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })],
    turnStart: { entryId: "rpip", tokenId: "pip", sceneId: "s1", x: 4, y: 4, elevation: 0, seen: true, seq: 7, mounts: ["dog", "horse"] },
  };
  setup?.(state);
  const f = {
    state,
    seq: 10,
    last: null as Applied | null,
    run(op: Op, who: Viewer = DM, opVersion?: number) {
      f.seq++;
      const r = applyOp(f.state, op, who, { seq: f.seq, at: AT, ...(opVersion === undefined ? {} : { opVersion }) });
      assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
      f.state = r.state;
      f.last = r;
      return f;
    },
    path(id: string): TokenPath | undefined {
      return f.state.tokens[id]!.path;
    },
    dropped(): string[] {
      return [...(f.last?.walksDropped ?? [])].sort();
    },
  };
  return f;
}

/** The turn's walks, by creature. */
const walkers = (state: RoomState) => {
  const turn = turnUnderWay(state.encounter);
  return Object.values(state.tokens).filter((t) => turn && t.path?.turn === turn.seq).map((t) => t.id).sort();
};

/** Only Pip on the warhorse, the warhorse alone on the list. */
const onHorse = (s: RoomState) => {
  delete s.tokens.dog;
  s.tokens.pip = { ...s.tokens.pip!, attached: { to: "horse", kind: "ride", steer: true } };
  s.encounter = { ...s.encounter!, turnStart: { ...s.encounter!.turnStart!, mounts: ["horse"] } };
};

describe("a mount that leaves the turn takes its walk with it (D-261121-127)", () => {
  test("getting off takes the mount's walk off, a move between records nothing, and a remount the same turn starts a fresh walk", () => {
    const f = riders(onHorse).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1);
    assert.deepEqual(walkers(f.state), ["horse", "pip"]);
    f.run({ t: "token.detach", tokenId: "pip", x: 10, y: 4 }, P1);
    assert.equal(f.state.encounter!.turnStart!.mounts, undefined, "the warhorse leaves the turn");
    assert.equal(f.path("horse"), undefined, "and its walk with it");
    assert.deepEqual(f.dropped(), [keys.token("horse")], "reported apart");
    assert.ok(f.path("pip"), "Pip keeps her own");
    f.run({ t: "token.move", tokenId: "horse", x: 8, y: 6 });
    assert.equal(f.path("horse"), undefined, "the DM's move off the turn records nothing");
    assert.deepEqual(f.dropped(), []);
    f.run({ t: "token.attach", tokenId: "pip", to: "horse", kind: "ride", steer: true, x: 9, y: 6, elevation: 0 }, P1);
    assert.deepEqual(f.state.encounter!.turnStart!.mounts, ["horse"]);
    f.run({ t: "token.move", tokenId: "horse", x: 8, y: 10 }, P1);
    assert.deepEqual(f.path("horse")!.stops.map((s) => [s.x, s.y, s.moved]), [[8, 6, undefined], [8, 10, 20]], "from where it was remounted");
  });

  test("Let go, a deletion of the rider and the DM's hide of a link take it off the same way, and at most 1 + turnMounts hold walks of the turn", () => {
    for (const op of [{ t: "token.update", tokenId: "pip", patch: { attached: null } }, { t: "token.delete", tokenId: "dog" }] as Op[]) {
      const f = riders().run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1);
      assert.deepEqual(walkers(f.state), ["dog", "horse", "pip"]);
      const r = applyOp(f.state, op, DM, { seq: 30, at: AT });
      if (!r.ok) continue;
      assert.ok(walkers(r.state).length <= 1 + LIMITS.turnMounts);
      for (const id of walkers(r.state)) assert.ok(id === "pip" || r.state.encounter!.turnStart!.mounts?.includes(id), `${op.t}: ${id} walks outside the turn`);
    }
  });

  test("ops stored at 64 keep a departed mount's walk, which a remount goes on with", () => {
    const f = riders(onHorse).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1, 64).run({ t: "token.detach", tokenId: "pip", x: 10, y: 4 }, P1, 64);
    assert.equal(f.state.encounter!.turnStart!.mounts, undefined);
    assert.equal(f.path("horse")!.stops.length, 2, "the walk stays");
    assert.equal(f.last!.walksDropped, undefined);
  });

  test("the undo of a former mount's move after it got off is taken and puts no walk back", () => {
    const f = riders(onHorse).run({ t: "token.move", tokenId: "horse", x: 6, y: 4 }, P1).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1);
    const undoMove = f.last!.inverse!;
    f.run({ t: "token.detach", tokenId: "pip", x: 10, y: 4 }, P1);
    assert.equal(f.path("horse"), undefined);
    f.run(undoNow(f.state, undoMove.filter((e) => e.key === keys.token("horse"))), P1);
    assert.deepEqual([f.state.tokens.horse!.x, f.state.tokens.horse!.y], [6, 4], "the warhorse goes back a leg");
    assert.equal(f.path("horse"), undefined, "with no walk, as it shares no turn");
    assert.deepEqual(f.dropped(), [keys.token("horse")], "the walk the restore held is reported apart");
    // The turn's creature keeps a restored walk of the turn.
    const g = riders(onHorse).run({ t: "token.detach", tokenId: "pip", x: 6, y: 4 }, P1).run({ t: "token.move", tokenId: "pip", x: 8, y: 4 }, P1);
    const undoPip = g.last!.inverse!;
    g.run(undoNow(g.state, undoPip), P1);
    assert.deepEqual([g.path("pip")!.stops.at(-1)!.x, g.path("pip")!.stops.at(-1)!.y], [6, 4], "its walk back to where it got off");
    assert.deepEqual(g.dropped(), []);
  });

  test("the undo of a getting off puts the mount back on the list and keeps the walk it restores", () => {
    const f = riders(onHorse).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1);
    const walked = f.path("horse");
    f.run({ t: "token.detach", tokenId: "pip", x: 10, y: 4 }, P1);
    const getOff = f.last!.inverse!;
    const rides = [{ seq: 7, mount: "horse", rider: "pip" }];
    f.run({ ...undoNow(f.state, getOff), rides } as Op, P1);
    assert.deepEqual(f.state.encounter!.turnStart!.mounts, ["horse"]);
    assert.deepEqual(f.path("horse"), walked, "back on the turn, its walk is the turn's again");
  });
});

describe("a room stored before 65 sheds its strays at its first op from 65 (D-261121-127)", () => {
  /** Pip on the warhorse, and nine more creatures holding walks of turn 7, as a room at 64 may after mounts left the turn. */
  const legacy = () =>
    riders((s) => {
      onHorse(s);
      const walk = (x: number): TokenPath => ({ turn: 7, stops: [{ x, y: 12, elevation: 0, seen: true }, { x, y: 13, elevation: 0, seen: true, moved: 5, cost: 5 }] });
      for (let i = 0; i < 9; i++) s.tokens[`m${i}`] = token(`m${i}`, { x: 2 * i, y: 13, path: walk(2 * i) });
      s.tokens.pip = { ...s.tokens.pip!, path: walk(4) };
      s.tokens.horse = { ...s.tokens.horse!, path: walk(4) };
    });

  test("a player's move, or apart the server's explore, as the first op at 65 leaves walks of the turn only on the turn's creature and its mounts", () => {
    assert.equal(walkers(legacy().state).length, 11);
    for (const [op, who] of [
      [{ t: "token.move", tokenId: "gob", x: 21, y: 20 }, DM],
      [{ t: "log.chat", text: "hi" }, P1],
      [{ t: "sys.explore", sceneId: "s1", tiles: [{ tx: 0, ty: 0, bits: FULL_TILE_BITS }] }, DM],
    ] as [Op, Viewer][]) {
      const f = legacy().run(op, who);
      assert.deepEqual(walkers(f.state), ["horse", "pip"], op.t);
      assert.ok(walkers(f.state).length <= 1 + LIMITS.turnMounts);
      assert.deepEqual(f.dropped(), Array.from({ length: 9 }, (_, i) => keys.token(`m${i}`)).sort(), `${op.t}: reported apart`);
    }
    const old = legacy().run({ t: "log.chat", text: "hi" }, P1, 64);
    assert.equal(walkers(old.state).length, 11, "an op stored at 64 leaves them");
  });
});

describe("a device's copy judges the walk as the room does (D-261121-141)", () => {
  /** P1's prediction of `op` on their copy against the room's answer as P1 receives it: each creature's walk and the turn's list. */
  const both = (state: RoomState, op: Op) => {
    const copy = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const predicted = applyOp(copy, op, P1, { seq: 40, at: AT });
    const answered = applyOp(state, op, P1, { seq: 40, at: AT });
    assert.ok(predicted.ok && answered.ok);
    const shown = projectState(answered.state, P1, { sceneId: "s1" });
    // Each creature's walk by the turn it names: what the walk pass decides, apart from how each stop was marked seen.
    const walks = (s: { tokens: Record<string, unknown> }) => Object.fromEntries(Object.entries(s.tokens).map(([id, t]) => [id, (t as Token).path?.turn ?? null]));
    return { predicted: walks(predicted.state), answered: walks(shown), mounts: [predicted.state.encounter?.turnStart?.mounts, shown.encounter?.turnStart?.mounts], room: answered.state };
  };

  test("a getting off the copy sees takes the mount's walk off in both", () => {
    const f = riders(onHorse).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1);
    const r = both(f.state, { t: "token.detach", tokenId: "pip", x: 10, y: 4 });
    assert.equal(r.room.tokens.horse!.path, undefined);
    assert.equal(r.answered.pip, 7, "Pip's walk is P1's to see");
    assert.deepEqual(r.predicted, r.answered);
    assert.deepEqual(r.mounts[0], r.mounts[1]);
  });

  test("a held mount whose chain runs through a mount the copy does not hold keeps its walk in both", () => {
    const f = riders((s) => (s.tokens.dog = { ...s.tokens.dog!, visibility: "dm" })).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, DM);
    const copy = projectState(f.state, P1, { sceneId: "s1" });
    assert.equal(copy.tokens.dog, undefined, "P1's copy holds no Mastiff");
    assert.equal((copy.tokens.pip as Token).attached, undefined, "nor Pip's ride on it");
    assert.deepEqual(copy.encounter?.turnStart?.mounts, ["horse"]);
    for (const op of [{ t: "log.chat", text: "hi" }, { t: "token.move", tokenId: "gob", x: 21, y: 20 }] as Op[]) {
      const r = both(f.state, op);
      assert.ok(r.room.tokens.horse!.path, `${op.t}: the room keeps the warhorse's walk`);
      assert.equal(r.answered.horse, 7, `${op.t}: and P1 receives it`);
      assert.deepEqual(r.predicted, r.answered, op.t);
      assert.deepEqual(r.mounts[0], r.mounts[1], op.t);
    }
  });

  test("a copy with no turn under way leaves every walk", () => {
    const f = riders(onHorse).run({ t: "token.move", tokenId: "horse", x: 8, y: 4 }, P1);
    const copy = projectState(f.state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const blind = { ...copy, encounter: { ...copy.encounter!, turnStart: undefined } } as RoomState;
    const r = applyOp(blind, { t: "log.chat", text: "hi" }, P1, { seq: 40, at: AT });
    assert.ok(r.ok);
    assert.deepEqual(r.state.tokens.horse!.path, copy.tokens.horse!.path);
    assert.equal(r.walksDropped, undefined);
  });
});
