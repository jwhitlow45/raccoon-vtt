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

describe("companions acting on their character's turn (docs/design-v1-combat-flow.md 3.6.8)", () => {
  /** Bree (c1) with her spirit, which acts on her turn, and a goblin, each with a row but the spirit. */
  function spirit(turn: "own" | "shared" | "none" = "shared") {
    const state = fixture();
    state.tokens.ws = token("ws", { kind: "npc", name: "Wildfire Spirit", ownerIds: ["p1"], companion: { of: "c1", turn } });
    return state;
  }

  test("until the end of the companion's next turn is stored against its character's row", () => {
    for (const turn of ["shared", "none"] as const) {
      const state = spirit(turn);
      assert.equal(findEntryFor(state, { tokenId: "ws" })?.id, "n1");
      assert.deepEqual(resolveDuration(state, { mode: "turnEnd", of: { tokenId: "ws" } }).anchor, { entryId: "n1" });
    }
    const own = spirit("own");
    assert.equal(findEntryFor(own, { tokenId: "ws" }), undefined, "with its own turn and no row it waits");
  });

  test("its character's row joining binds a duration paused on it, and leaving pauses it on the character as Bree's own", () => {
    const state = spirit();
    const anchors = anchorsForEntry(state, state.encounter!.entries[0]!);
    assert.ok(anchors.some((a) => "tokenId" in a && a.tokenId === "ws"));
    const paused = [effect("e", { duration: { remaining: 1, boundary: "turnEnd", anchor: { tokenId: "ws" } } })];
    const bound = bindToEntry(paused, "n1", anchors);
    assert.deepEqual(bound.effects[0]!.duration!.anchor, { entryId: "n1" });
    const left = unbindFromEntry(bound.effects, "n1", { tokenId: "t1" });
    assert.deepEqual(left.effects[0]!.duration!.anchor, { tokenId: "t1" }, "paused on Bree's token, and bound again when she returns");
    assert.ok(!anchorsForEntry(spirit("own"), spirit("own").encounter!.entries[0]!).some((a) => "tokenId" in a && a.tokenId === "ws"));
  });

  test("a row naming the character alone stands for its companions too, and a mixed row for its token's character only", () => {
    const state = spirit();
    state.encounter!.entries = [entry("c", { characterId: "c1" })];
    assert.equal(findEntryFor(state, { tokenId: "ws" })?.id, "c");
    state.characters.c2 = character("c2");
    state.encounter!.entries = [entry("mixed", { tokenId: "t1", characterId: "c2" })];
    assert.ok(anchorsForEntry(state, state.encounter!.entries[0]!).some((a) => "tokenId" in a && a.tokenId === "ws"), "the row's token is Bree's");
  });
});
