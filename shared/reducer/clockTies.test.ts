import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clockNow } from "../calendar.ts";
import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op, OpOf } from "../protocol.ts";
import { DM, P1 } from "../testutil.ts";
import { DAYS, H, base, fight, restore, run, texts, withClock } from "./clockTesting.ts";

/** What existing ops do with the room's clock (docs/design/design-v1-calendar.md 4.5, 4.6, 6.3), from op version 42. */

describe("a fight's end and its undo (4.6, 6.3)", () => {
  test("a Set in round 11 counts only the rounds after it at the end, round 11 whole", () => {
    const set = run(withClock(0, {}, { encounter: fight(11) }), { t: "clock.set", at: 9 * H });
    assert.equal(run(set.state, { t: "encounter.end" }, 3).state.clock!.t, 9 * H + 6);
  });

  test("an undo of the fight's end puts back the fight and the clock with no clock line, though its seconds cross a minute", () => {
    const state = withClock(22 * H + 50, {}, { encounter: fight(3) });
    const end = run(state, { t: "encounter.end" });
    assert.equal(end.state.clock!.t, 22 * H + 68);
    assert.deepEqual(texts(end.log), [], "a fight's seconds write no line");
    const undo = restore(end.state, end.inverse!, "undo", 3);
    assert.deepEqual(undo.state.encounter?.round, 3);
    assert.equal(undo.state.clock!.t, 22 * H + 50);
    assert.deepEqual(texts(undo.log), []);
    assert.deepEqual(texts(restore(undo.state, undo.inverse!, "redo", 4).log), []);
  });
});

describe("fights move the clock (4.6)", () => {
  test("a fight ended in round 3 after Start adds 18 seconds and no line", () => {
    const r = run(withClock(100, {}, { encounter: fight(3) }), { t: "encounter.end" });
    assert.equal(r.state.clock!.t, 118);
    assert.deepEqual(texts(r.log), []);
    assert.ok(r.touched.includes(keys.clock));
  });

  test("a fight ended before Start leaves the clock unwritten", () => {
    const r = run(withClock(100, {}, { encounter: fight(1, null) }), { t: "encounter.end" });
    assert.equal(r.state.clock!.rev, 1);
    assert.ok(!r.touched.includes(keys.clock), "so it guards no undo");
  });

  test("started, every row removed in round 1, then ended: counted as never started", () => {
    const started = run(withClock(100, {}, { encounter: fight(1) }), { t: "encounter.remove", entryIds: ["e1", "e2"] });
    assert.equal(started.state.encounter!.activeEntryId, null);
    assert.equal(run(started.state, { t: "encounter.end" }, 3).state.clock!.t, 100);
  });

  test("an end that would pass the bound stops the clock at it and still ends the fight", () => {
    const r = run(withClock(LIMITS.clockSecondsMax - 5, {}, { encounter: fight(3) }), { t: "encounter.end" });
    assert.equal(r.state.clock!.t, LIMITS.clockSecondsMax);
    assert.equal(r.state.encounter, null);
  });

  test("a room with no clock ends a fight as before", () => {
    const r = run(base({ encounter: fight(3) }), { t: "encounter.end" });
    assert.ok(!("clock" in r.state));
  });
});

describe("Long Rests stamp their characters (4.5)", () => {
  const rest = (target: OpOf<"actor.rest">["target"]): Op => ({ t: "actor.rest", target, kind: "long" });

  test("the party's rest: the advance first, then each rest stamped with the current time after it, outside a fight and in round 11", () => {
    for (const encounter of [null, fight(11)]) {
      const state = withClock(22 * H, {}, { encounter });
      const advanced = run(state, { t: "clock.advance", by: 8 * H, why: "longRest" });
      const rested = run(advanced.state, rest({ characterId: "bree" }), 3);
      const now = clockNow(advanced.state.clock!, advanced.state.encounter);
      assert.equal(now, 30 * H + (encounter ? 60 : 0));
      assert.deepEqual(rested.state.characters.bree!.longRest, { at: now, clock: "c1" });
      assert.equal(rested.state.clock, advanced.state.clock, "a rest never moves the clock");
    }
  });

  test("one creature's rest by its token, outside a fight and in round 11, stamps the current time when it applies", () => {
    for (const encounter of [null, fight(11)]) {
      const state = withClock(5 * H, {}, { encounter });
      const r = run(state, rest({ tokenId: "bree-t" }));
      assert.deepEqual(r.state.characters.bree!.longRest, { at: clockNow(state.clock!, encounter), clock: "c1" });
    }
  });

  test("a player's rest of their own character writes the stamp, which no player receives", () => {
    const r = run(withClock(5 * H), rest({ characterId: "bree" }), 2, P1);
    assert.deepEqual(r.state.characters.bree!.longRest, { at: 5 * H, clock: "c1" });
    assert.equal(r.state.clock!.rev, 1);
    for (const who of [P1, { memberId: "p2", role: "player" } as Viewer]) assert.ok(!JSON.stringify(projectState(r.state, who, { sceneId: "s1" })).includes("longRest"));
    assert.ok(JSON.stringify(projectState(r.state, DM, { sceneId: "s1" })).includes("longRest"));
  });

  test("a Short Rest, an inline creature's rest and a room with no clock write no stamp", () => {
    assert.equal(run(withClock(0), { t: "actor.rest", target: { characterId: "bree" }, kind: "short" }).state.characters.bree!.longRest, undefined);
    const monster = run(withClock(0), rest({ tokenId: "gob" }));
    assert.ok(!JSON.stringify(monster.state.tokens.gob).includes("longRest"));
    assert.equal(run(base(), rest({ characterId: "bree" })).state.characters.bree!.longRest, undefined);
  });

  test("a stamp from a stopped clock keeps that clock's id, so a new clock reads it as none", () => {
    const rested = run(withClock(0), rest({ characterId: "bree" }));
    const stopped = run(rested.state, { t: "clock.stop" }, 3);
    const fresh = run(stopped.state, { t: "clock.start", id: "c2", at: 0, shown: true, calendar: DAYS }, 4);
    assert.notEqual(fresh.state.characters.bree!.longRest!.clock, fresh.state.clock!.id);
  });
});

describe("replay before the clock (6.6)", () => {
  test("a v41 fight's end and Long Rest write no clock and no stamp, even in a room that has one", () => {
    const end = run(withClock(100, {}, { encounter: fight(3) }), { t: "encounter.end" }, 2, DM, 41);
    assert.equal(end.state.clock!.t, 100);
    const rest = run(withClock(100), { t: "actor.rest", target: { characterId: "bree" }, kind: "long" }, 2, DM, 41);
    assert.equal(rest.state.characters.bree!.longRest, undefined);
  });
});
