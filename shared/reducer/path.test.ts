import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "../keys.ts";
import type { PathStop, RoomState, Token, TokenPath, Viewer } from "../model.ts";
import { dependents, projectState } from "../project.ts";
import { MAX_PATH_STOPS, type Op } from "../protocol.ts";
import { pathThisTurn, stopsForNonOwners, stopsForOwners, withStop } from "../rules/path.ts";
import { DM, P1, P2, apply, entry, refused, reveal, room, token, withoutWalked } from "../testutil.ts";
import { applyOp } from "../reducer.ts";

const START: Op = { t: "encounter.start", entries: [{ id: "n1", tokenId: "wolf", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] };
const NEXT: Op = { t: "encounter.next" };
const move = (tokenId: string, x: number, y: number): Op => ({ t: "token.move", tokenId, x, y });

/** A stop as the reducer records it, seen unless said otherwise. */
const at = (x: number, y: number, elevation = 0, seen = true): PathStop => ({ x, y, elevation, ...(seen ? { seen: true as const } : {}) });

/**
 * A fight on the player scene: P1's wolf at 1,1 acts first, then a goblin
 * at 10,1. Each op gets the next seq, as on the server, so the wolf's first
 * turn is named 2.
 */
function fight(setup?: (state: RoomState) => void) {
  const state = room({ tokens: { wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], x: 1, y: 1 }), gob: token("gob", { x: 10, y: 1 }) } });
  setup?.(state);
  const f = {
    state,
    seq: 0,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      f.state = apply(f.state, op, who, f.seq);
      return f;
    },
    // The marks these tests read, without what each leg took (route tests check that).
    path(id: string): TokenPath | undefined {
      return withoutWalked(f.state.tokens[id]!.path);
    },
  };
  return f.run(START).run(NEXT);
}

describe("the active creature's path this turn", () => {
  test("each drop of the active creature on its turn adds a leg, whoever moves it, with climbing as a leg", () => {
    const f = fight();
    f.run(move("wolf", 4, 1));
    assert.deepEqual(f.path("wolf"), { turn: 2, stops: [at(1, 1), at(4, 1)] }, "the first leg starts where the turn began");
    f.run(move("wolf", 4, 3), P1);
    f.run({ t: "token.update", tokenId: "wolf", patch: { elevation: 10 } }, P1);
    f.run({ t: "token.update", tokenId: "wolf", patch: { rotation: 90 } }, P1);
    f.run({ t: "token.moveMany", moves: [{ tokenId: "wolf", x: 5, y: 3 }, { tokenId: "gob", x: 11, y: 1 }] });
    f.run({ t: "token.update", tokenId: "wolf", patch: { x: 6 } });
    assert.deepEqual(f.path("wolf"), { turn: 2, stops: [at(1, 1), at(4, 1), at(4, 3), at(4, 3, 10), at(5, 3, 10), at(6, 3, 10)] }, "turning in place is no leg");
    assert.equal(f.path("gob"), undefined, "a creature moved out of its turn gets none");
    assert.equal(pathThisTurn(f.state.encounter, f.state.tokens.wolf!), f.state.tokens.wolf!.path);
  });

  test("moves outside a fight, a drop where it stood, and a turn from before paths add nothing", () => {
    const calm = apply(room({ tokens: { wolf: token("wolf") } }), move("wolf", 5, 5));
    assert.equal(calm.tokens.wolf!.path, undefined);
    const f = fight();
    f.run(move("wolf", 1, 1));
    assert.equal(f.path("wolf"), undefined, "dropped back where it stood");
    const { seq: _seq, ...older } = f.state.encounter!.turnStart!;
    f.state = { ...f.state, encounter: { ...f.state.encounter!, turnStart: older } };
    f.run(move("wolf", 3, 1));
    assert.equal(f.path("wolf"), undefined, "a turn begun before paths were recorded reads as before");
  });

  test("a copy without the turn's start, as a player who could not see it begin holds, leaves the active creature's path as it is", () => {
    const f = fight();
    f.run(move("wolf", 4, 1));
    const path = f.state.tokens.wolf!.path;
    const { turnStart: _start, ...unknown } = f.state.encounter!;
    f.state = { ...f.state, encounter: unknown };
    f.run(move("wolf", 6, 1));
    assert.equal(f.state.tokens.wolf!.path, path, "the server's answer brings the leg");
    f.run(move("gob", 12, 1));
    assert.equal(f.path("gob"), undefined);
  });

  test("the turn passing writes no token, a path from an earlier turn counts as empty, and the next turn starts its own", () => {
    const f = fight();
    f.run(move("wolf", 4, 1));
    const wolf = f.state.tokens.wolf!;
    f.run(NEXT);
    assert.equal(f.state.tokens.wolf, wolf, "the token is untouched");
    assert.equal(pathThisTurn(f.state.encounter, wolf), null);
    f.run(move("gob", 12, 1));
    assert.equal(f.path("gob")!.turn, f.state.encounter!.turnStart!.seq);
    f.run(NEXT);
    assert.equal(f.state.encounter!.round, 2);
    f.run(move("wolf", 4, 5));
    assert.deepEqual(f.path("wolf"), { turn: f.state.encounter!.turnStart!.seq!, stops: [at(4, 1), at(4, 5)] });
    f.run(move("gob", 13, 1));
    assert.equal(f.path("gob"), undefined, "moved out of its turn, the last turn's path goes");
  });

  test("Previous brings the earlier turn's path back with the turn, and Next after it starts afresh", () => {
    const f = fight();
    f.run(move("wolf", 4, 1));
    const path = f.state.tokens.wolf!.path;
    f.run(NEXT).run({ t: "encounter.prev" });
    assert.equal(pathThisTurn(f.state.encounter, f.state.tokens.wolf!), path);
    f.run(NEXT).run({ t: "encounter.prev" });
    f.run(move("wolf", 5, 1));
    assert.deepEqual(f.path("wolf")!.stops, [at(1, 1), at(4, 1), at(5, 1)]);
    f.run({ t: "encounter.remove", entryIds: ["n2"] }).run(NEXT);
    assert.equal(pathThisTurn(f.state.encounter, f.state.tokens.wolf!), null, "its next turn is another turn, though it is the same row");
  });

  test("a move to another scene drops the path, and moves there start from where the creature stands", () => {
    const f = fight();
    f.run(move("wolf", 4, 1));
    f.run({ t: "token.update", tokenId: "wolf", patch: { sceneId: "s2" } });
    assert.equal(f.path("wolf"), undefined);
    f.run(move("wolf", 6, 1));
    assert.deepEqual(f.path("wolf")!.stops, [at(4, 1), at(6, 1)], "seen by the turn start's rule, whichever scene the players are on");
  });

  test("each stop records whether players who do not own the creature could see it there", () => {
    const f = fight((state) => {
      state.tokens.wolf = { ...state.tokens.wolf!, ownerIds: [] };
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
      reveal(state, "s1", { x: 0, y: 0, w: 6, h: 6 });
    });
    f.run(move("wolf", 20, 20)).run(move("wolf", 2, 2));
    f.run({ t: "token.update", tokenId: "wolf", patch: { visibility: "dm" } });
    f.run(move("wolf", 3, 3));
    assert.deepEqual(f.path("wolf")!.stops, [at(1, 1), at(20, 20, 0, false), at(2, 2), at(3, 3, 0, false)]);
  });

  test("nothing done behind a blackout is marked seen, so players never get it once the blackout lifts", () => {
    const f = fight((state) => {
      state.tokens.wolf = { ...state.tokens.wolf!, ownerIds: [] };
    });
    const blackout = (on: boolean): Op => ({ t: "view.blackout", blackout: on });
    f.run(blackout(true)).run(move("wolf", 17, 19)).run(move("wolf", 3, 1)).run(blackout(false));
    f.run(move("wolf", 4, 1));
    assert.deepEqual(f.path("wolf")!.stops, [at(1, 1), at(17, 19, 0, false), at(3, 1, 0, false), at(4, 1)]);
    const theirs = projectState(f.state, P2, { sceneId: "s1" });
    assert.deepEqual(theirs.tokens.wolf!.path!.stops.map((s) => [s.x, s.y]), [[1, 1], [4, 1]]);
    // A turn that starts behind a blackout: its spot and its line stay the DM's after it lifts.
    f.run(blackout(true)).run(NEXT).run(NEXT).run({ t: "actor.hp", target: { tokenId: "wolf" }, change: { kind: "damage", amount: 1 } }).run(blackout(false));
    assert.equal(f.state.encounter!.turnStart!.seen, undefined);
    const after = projectState(f.state, P2, { sceneId: "s1" });
    assert.equal(after.encounter!.turnStart, undefined);
    const lines = f.state.log.filter((e) => e.data?.type === "turn" || e.data?.type === "hp").slice(-3);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((e) => !("seen" in e.data!)), "the turn lines and the damage line behind the blackout");
    assert.ok(!after.log.some((e) => lines.some((l) => l.id === e.id)));
  });

  test("a creature standing away from where its turn began gets a straight leg for it", () => {
    const f = fight();
    f.state = { ...f.state, tokens: { ...f.state.tokens, wolf: { ...f.state.tokens.wolf!, x: 3 } } };
    f.run(move("wolf", 5, 1));
    assert.deepEqual(f.path("wolf")!.stops, [at(1, 1), at(3, 1), at(5, 1)]);
  });

  test("a full path merges its oldest corners and keeps the start and the latest moves", () => {
    const f = fight();
    for (let i = 0; i < MAX_PATH_STOPS + 5; i++) f.run(move("wolf", 2 + (i % 2), 1 + i));
    const stops = f.path("wolf")!.stops;
    assert.equal(stops.length, MAX_PATH_STOPS);
    assert.deepEqual(stops[0], at(1, 1));
    const last = MAX_PATH_STOPS + 4;
    assert.deepEqual(stops.slice(-2), [at(2 + ((last - 1) % 2), last), at(2 + (last % 2), 1 + last)]);
  });
});

describe("a full path joining its oldest corner", () => {
  /** A full path whose first corner and the leg after it are as given, then one more move. */
  function joined(corner: Partial<PathStop>, next: Partial<PathStop>): PathStop[] {
    const rest = Array.from({ length: MAX_PATH_STOPS - 3 }, (_, i) => at(10 + i, 1));
    const full: TokenPath = { turn: 2, stops: [at(1, 1), { ...at(2, 1), ...corner }, { ...at(3, 1), ...next }, ...rest] };
    assert.equal(full.stops.length, MAX_PATH_STOPS);
    return withStop(full, at(99, 1)).stops;
  }

  test("counts the joined leg unless neither leg counted", () => {
    assert.equal(joined({}, { uncounted: true })[1]!.uncounted, undefined, "a walk then a shove: the walk still counts");
    assert.equal(joined({ uncounted: true }, {})[1]!.uncounted, undefined);
    assert.equal(joined({ uncounted: true }, { uncounted: true })[1]!.uncounted, true);
  });

  test("keeps a mark players could not have read from them once the corner they did not see goes", () => {
    // Before, their line ran from the start to the stop after the unseen corner, with no mark on it.
    const unseen = joined({ seen: undefined, uncounted: true }, { uncounted: true });
    assert.deepEqual(stopsForNonOwners(unseen).slice(0, 2).map((s) => s.uncounted), [undefined, undefined]);
    assert.equal(stopsForOwners(unseen)[1]!.uncounted, true, "the owner still reads it as not counting");
    const seen = joined({ uncounted: true }, { uncounted: true });
    assert.equal(stopsForNonOwners(seen)[1]!.uncounted, true, "they saw both legs not count");
    // Joined again later, the leg still passes through what they did not see.
    const stops = [at(1, 1), { ...unseen[1]! }, { ...at(4, 1), uncounted: true as const }, ...unseen.slice(3, MAX_PATH_STOPS)];
    const again = withStop({ turn: 2, stops }, at(98, 1)).stops;
    assert.equal(again[1]!.joinedUnseen, true);
    assert.equal(stopsForNonOwners(again)[1]!.uncounted, undefined);
  });
});

describe("a move that doesn't count", () => {
  const mark = (counts: boolean): Op => ({ t: "token.countLeg", tokenId: "wolf", counts });

  test("marks the last leg, leaves the token where it is, and counts it again", () => {
    const f = fight();
    f.run(move("wolf", 4, 1)).run(move("wolf", 9, 1));
    const wolf = f.state.tokens.wolf!;
    f.run(mark(false), P1);
    assert.deepEqual(f.path("wolf")!.stops, [at(1, 1), at(4, 1), { ...at(9, 1), uncounted: true }]);
    assert.deepEqual([f.state.tokens.wolf!.x, f.state.tokens.wolf!.y], [wolf.x, wolf.y]);
    f.run(move("wolf", 9, 2));
    assert.equal(f.path("wolf")!.stops[2]!.uncounted, true, "the next move keeps the mark on the leg before it");
    f.run({ t: "token.countLeg", tokenId: "wolf", counts: false });
    f.run({ t: "token.countLeg", tokenId: "wolf", counts: true });
    assert.equal(f.path("wolf")!.stops[3]!.uncounted, undefined);
  });

  test("asking for what already holds changes nothing, so it leaves no step to undo", () => {
    const f = fight();
    f.run(move("wolf", 4, 1));
    const result = applyOp(f.state, mark(true), DM, { seq: 99, at: "2026-10-12T20:00:00.000Z" });
    assert.ok(result.ok);
    assert.equal(result.state.tokens.wolf, f.state.tokens.wolf);
    assert.equal(result.inverse, null);
  });

  test("is refused before the creature has moved this turn, and for a path of an earlier turn", () => {
    const f = fight();
    assert.equal(refused(f.state, mark(false)).message, "it has not moved this turn");
    f.run(move("wolf", 4, 1)).run(NEXT);
    assert.equal(refused(f.state, mark(false)).message, "it has not moved this turn");
    assert.equal(refused(f.state, { t: "token.countLeg", tokenId: "nope", counts: false }).code, "gone");
  });
});

describe("what players get of a path", () => {
  /** The goblin's turn, named 7, with a path the DM watched end to end and players only in parts. */
  function watched(overrides: Partial<Token> = {}): RoomState {
    const state = room();
    const stops: PathStop[] = [at(1, 1), at(2, 1, 0, false), { ...at(3, 1), uncounted: true }, { ...at(4, 1), uncounted: true }, at(5, 4)];
    state.tokens.gob = token("gob", { x: 5, y: 4, path: { turn: 7, stops }, ...overrides });
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "n1",
      entries: [entry("n1", { tokenId: "gob", value: 15 }), entry("n2", { value: 5 })],
      turnStart: { entryId: "n1", tokenId: "gob", sceneId: "s1", x: 1, y: 1, elevation: 0, seen: true, seq: 7 },
    };
    return state;
  }
  const pathFor = (state: RoomState, viewer: Viewer) => projectState(state, viewer, { sceneId: "s1" }).tokens.gob?.path;
  const plain = (x: number, y: number, uncounted = false): PathStop => ({ x, y, elevation: 0, ...(uncounted ? { uncounted: true as const } : {}) });

  test("the DM gets it whole, owners every stop, and other players the stops they saw, never the marks", () => {
    const state = watched();
    assert.equal(pathFor(state, DM), state.tokens.gob!.path);
    assert.deepEqual(pathFor(state, P2), { turn: 7, stops: [plain(1, 1), plain(3, 1), plain(4, 1, true), plain(5, 4)] }, "a leg is uncounted to them only when they saw both its ends");
    assert.deepEqual(stopsForNonOwners(state.tokens.gob!.path!.stops), pathFor(state, P2)!.stops);
    const owned = watched({ ownerIds: ["p1"] });
    assert.deepEqual(pathFor(owned, P1), { turn: 7, stops: [plain(1, 1), plain(2, 1), plain(3, 1, true), plain(4, 1, true), plain(5, 4)] });
    assert.equal(projectState(owned, P1, { sceneId: "s1" }).tokens.gob!.path?.stops.some((s) => "seen" in s), false);
  });

  test("players get only the path of the turn under way, of a row they see, and owners that of its own turn", () => {
    const stale = watched();
    stale.encounter = { ...stale.encounter!, turnStart: { ...stale.encounter!.turnStart!, seq: 8 } };
    assert.equal(pathFor(stale, P2), undefined, "a path of an earlier turn");
    assert.ok(pathFor(stale, DM), "the DM's copy keeps it, and the canvas reads it as empty");
    const hidden = watched({ ownerIds: ["p1"] });
    hidden.encounter = { ...hidden.encounter!, entries: hidden.encounter!.entries.map((e) => (e.id === "n1" ? { ...e, hidden: true } : e)) };
    assert.equal(pathFor(hidden, P2), undefined, "a row players cannot see, whose path would say whose turn it is");
    // They walk it, and its drag's label counts on from the turn's earlier legs as the move stores them (review AT-HIDDENPATH).
    assert.deepEqual(pathFor(hidden, P1)?.stops, stopsForOwners(hidden.tokens.gob!.path!.stops), "its owner gets it on its own turn all the same");
    const other = watched();
    other.encounter = { ...other.encounter!, activeEntryId: "n2" };
    assert.equal(pathFor(other, P2), undefined, "another row's turn");
    const unseen = watched();
    unseen.tokens.gob = { ...unseen.tokens.gob!, path: { turn: 7, stops: [at(1, 1, 0, false)] } };
    assert.equal(pathFor(unseen, P2), undefined, "no stop they saw");
  });

  test("a change of the encounter re-projects every token with a path, so the turn passing takes it from players", () => {
    const state = watched();
    state.tokens.wolf = token("wolf");
    assert.ok(dependents(state, [keys.encounter]).includes(keys.token("gob")));
    assert.ok(!dependents(state, [keys.encounter]).includes(keys.token("wolf")));
    assert.ok(!dependents(state, [keys.token("wolf")]).includes(keys.token("gob")));
  });
});
