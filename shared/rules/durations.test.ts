import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { character, effect, entry, room, token } from "../testutil.ts";
import {
  anchorsForEntry,
  bindToEntry,
  crossingsForNext,
  findEntryFor,
  isPaused,
  resolveDuration,
  tickEffects,
  unbindFromEntry,
} from "./durations.ts";

function fixture() {
  const state = room();
  state.characters.c1 = character("c1");
  state.tokens.t1 = token("t1", { kind: "pc", actor: { ref: "c1" } });
  state.tokens.t2 = token("t2");
  state.encounter = { rev: 0, round: 1, activeEntryId: "n1", entries: [entry("n1", { tokenId: "t1" }), entry("n2", { tokenId: "t2", tieOrder: 1 })] };
  return state;
}

describe("resolveDuration", () => {
  test("start of next turn is one crossing, N rounds is N turn starts", () => {
    const state = fixture();
    assert.deepEqual(resolveDuration(state, { mode: "turnStart", of: { tokenId: "t2" } }), {
      remaining: 1,
      boundary: "turnStart",
      anchor: { entryId: "n2" },
    });
    assert.deepEqual(resolveDuration(state, { mode: "rounds", rounds: 3, of: { tokenId: "t2" } }), {
      remaining: 3,
      boundary: "turnStart",
      anchor: { entryId: "n2" },
    });
  });

  test("end of next turn is two crossings during the anchor's own turn, one otherwise", () => {
    const state = fixture();
    assert.equal(resolveDuration(state, { mode: "turnEnd", of: { tokenId: "t1" } }).remaining, 2);
    assert.equal(resolveDuration(state, { mode: "turnEnd", of: { tokenId: "t2" } }).remaining, 1);
    assert.equal(resolveDuration(state, { mode: "turnEnd", of: { entryId: "n1" } }).remaining, 2);
  });

  test("a creature's entry is found through its character and through its token", () => {
    const state = fixture();
    assert.equal(findEntryFor(state, { characterId: "c1" })?.id, "n1");
    assert.equal(findEntryFor(state, { tokenId: "t1" })?.id, "n1");
  });

  test("outside an encounter the duration is anchored to the creature and paused", () => {
    const state = fixture();
    state.encounter = null;
    const d = resolveDuration(state, { mode: "turnEnd", of: { tokenId: "t2" } });
    assert.deepEqual(d, { remaining: 1, boundary: "turnEnd", anchor: { tokenId: "t2" } });
    assert.ok(isPaused(d));
    assert.deepEqual(resolveDuration(state, { mode: "rounds", rounds: 2, of: { characterId: "c1" } }).anchor, { characterId: "c1" });
  });
});

describe("ticking", () => {
  test("counts matching crossings and expires at 0, leaving paused ones alone", () => {
    const effects = [
      effect("a", { duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "n1" } } }),
      effect("b", { duration: { remaining: 2, boundary: "turnStart", anchor: { entryId: "n2" } } }),
      effect("c", { duration: { remaining: 1, boundary: "turnStart", anchor: { tokenId: "t2" } } }),
      effect("d"),
    ];
    const r = tickEffects(effects, crossingsForNext({ rev: 0, round: 1, activeEntryId: "n1", entries: [] }, [], "n2"));
    assert.deepEqual(r.expired.map((e) => e.id), ["a"]);
    assert.deepEqual(r.effects.map((e) => [e.id, e.duration?.remaining]), [["b", 1], ["c", 1], ["d", undefined]]);
    assert.ok(r.changed);
  });

  test("a skipped row crosses both of its boundaries, and the first next has no turn end", () => {
    const crossings = crossingsForNext({ rev: 0, round: 1, activeEntryId: null, entries: [] }, ["n1"], "n2");
    assert.deepEqual(crossings, [
      { entryId: "n1", boundary: "turnStart" },
      { entryId: "n1", boundary: "turnEnd" },
      { entryId: "n2", boundary: "turnStart" },
    ]);
  });

  test("nothing changes when no crossing matches", () => {
    const effects = [effect("a", { duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "n9" } } })];
    const r = tickEffects(effects, [{ entryId: "n1", boundary: "turnEnd" }]);
    assert.equal(r.effects, effects);
    assert.ok(!r.changed);
  });
});

describe("re-anchoring", () => {
  test("joining binds paused durations named after the token, its character and its other tokens", () => {
    const state = fixture();
    state.tokens.t3 = token("t3", { kind: "pc", sceneId: "s2", actor: { ref: "c1" } });
    const anchors = anchorsForEntry(state, entry("n1", { tokenId: "t1" }));
    assert.deepEqual(anchors, [{ tokenId: "t1" }, { characterId: "c1" }, { tokenId: "t3" }]);
    const effects = [
      effect("a", { duration: { remaining: 2, boundary: "turnStart", anchor: { characterId: "c1" } } }),
      effect("b", { duration: { remaining: 2, boundary: "turnStart", anchor: { tokenId: "t3" } } }),
      effect("c", { duration: { remaining: 2, boundary: "turnStart", anchor: { tokenId: "t2" } } }),
    ];
    const r = bindToEntry(effects, "n1", anchors);
    assert.deepEqual(r.effects.map((e) => e.duration?.anchor), [{ entryId: "n1" }, { entryId: "n1" }, { tokenId: "t2" }]);
  });

  test("leaving pauses durations on the entry, keeping remaining", () => {
    const effects = [effect("a", { duration: { remaining: 2, boundary: "turnEnd", anchor: { entryId: "n1" } } })];
    const r = unbindFromEntry(effects, "n1", { tokenId: "t1" });
    assert.deepEqual(r.effects[0]!.duration, { remaining: 2, boundary: "turnEnd", anchor: { tokenId: "t1" } });
    assert.equal(r.paused.length, 1);
  });
});
