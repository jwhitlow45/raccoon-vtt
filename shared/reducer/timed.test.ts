import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CLOCK_TOO_FAR, clockNow } from "../calendar.ts";
import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { Effect, LogEntry, RoomState, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { SPAN_CLOCK_UNSHARED, SPAN_NEEDS_CLOCK } from "../rules/durations.ts";
import { DM, P1, character, env } from "../testutil.ts";
import { DAYS, H, base, restore, withClock } from "./clockTesting.ts";

/**
 * Time spans that run out with the clock (docs/design/design-v1-calendar-c2c3.md
 * 3.3, 4.3, 4.5 and the reducer rows of section 10). Bree is a character
 * Pat (p1) plays, with the token bree-t, and gob a goblin with its own
 * actor. A fight's rows are e1 (gob, 15) and e2 (bree-t, 5).
 */

const BREE = { characterId: "bree" };
const GOB = { tokenId: "gob" };
const CO_DM: Viewer = { memberId: "dm2", role: "dm" };

let seq = 10;
function run(state: RoomState, op: Op, who: Viewer = DM): Applied {
  const r = applyOp(state, op, who, env(++seq));
  assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
  return r;
}

function refusedWith(state: RoomState, op: Op, who: Viewer = DM): { code: string; message: string } {
  const allowed = canApply(op, who, state, { canUseAsset: () => true });
  if (!allowed.ok) return { code: allowed.code, message: allowed.message };
  const r = applyOp(state, op, who, env(++seq));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return { code: r.code, message: r.message };
}

function addSpan(state: RoomState, target: typeof BREE | typeof GOB, id: string, seconds: number, who: Viewer = DM, key: Effect["key"] = "blessed"): Applied {
  return run(state, { t: "actor.effect.add", target, effect: { id, key, duration: { mode: "span", seconds } } }, who);
}

function effectsOf(state: RoomState, who: "bree" | "gob"): Effect[] {
  if (who === "bree") return state.characters.bree!.actor.effects;
  const gob = state.tokens.gob!.actor;
  return "inline" in gob ? gob.inline.effects : [];
}

function has(state: RoomState, who: "bree" | "gob", id: string): boolean {
  return effectsOf(state, who).some((e) => e.id === id);
}

function expiries(log: readonly LogEntry[]): string[] {
  return log.flatMap((line) => (line.data?.type === "effect" && line.data.action === "expire" ? [`${line.data.key}:${"characterId" in line.data ? line.data.characterId : line.data.tokenId}`] : []));
}

function now(state: RoomState): number {
  return clockNow(state.clock!, state.encounter);
}

/** A fight of gob (e1) and Bree (e2) started and turned until `round` with e1 acting, or e2 with `second`. */
function fightTo(state: RoomState, round: number, second = false): RoomState {
  let s = run(state, { t: "encounter.start", entries: [{ id: "e1", tokenId: "gob", value: 15 }, { id: "e2", tokenId: "bree-t", value: 5 }] }).state;
  const nexts = 1 + 2 * (round - 1) + (second ? 1 : 0);
  for (let i = 0; i < nexts; i++) s = run(s, { t: "encounter.next" }).state;
  assert.equal(s.encounter!.round, round);
  assert.equal(s.encounter!.activeEntryId, second ? "e2" : "e1");
  return s;
}

function undoOf(state: RoomState, applied: Applied, from: "undo" | "redo" = "undo", who: Viewer = DM): Applied {
  return restore(state, applied.inverse!, from, ++seq, { who });
}

describe("setting a time span (4.3)", () => {
  test("a span writes its end from the current time and the clock, and drops a count of turns", () => {
    const r = addSpan(withClock(22 * H), BREE, "ma", 8 * H, DM, "custom");
    assert.deepEqual(effectsOf(r.state, "bree")[0], { id: "ma", key: "custom", ends: { span: 8 * H, at: 30 * H, clock: "c1" } });
  });

  test("in a fight the end counts from the current time, the fight's seconds included", () => {
    const state = fightTo(withClock(H), 3);
    const r = addSpan(state, BREE, "b", 60);
    assert.equal(effectsOf(r.state, "bree")[0]!.ends!.at, H + 12 + 60);
  });

  test("span on update replaces rounds, rounds on update replaces span, and null removes both", () => {
    let state = run(withClock(H), { t: "actor.effect.add", target: BREE, effect: { id: "x", key: "blessed", duration: { mode: "rounds", rounds: 3, of: BREE } } }).state;
    assert.ok(effectsOf(state, "bree")[0]!.duration);
    state = run(state, { t: "actor.effect.update", target: BREE, effectId: "x", patch: { duration: { mode: "span", seconds: 600 } } }).state;
    assert.deepEqual(effectsOf(state, "bree")[0], { id: "x", key: "blessed", ends: { span: 600, at: H + 600, clock: "c1" } });
    state = run(state, { t: "actor.effect.update", target: BREE, effectId: "x", patch: { duration: { mode: "rounds", rounds: 2, of: BREE } } }).state;
    assert.equal(effectsOf(state, "bree")[0]!.ends, undefined);
    assert.equal(effectsOf(state, "bree")[0]!.duration!.remaining, 2);
    state = run(state, { t: "actor.effect.update", target: BREE, effectId: "x", patch: { duration: { mode: "span", seconds: 60 } } }).state;
    state = run(state, { t: "actor.effect.update", target: BREE, effectId: "x", patch: { duration: null } }).state;
    assert.deepEqual(effectsOf(state, "bree")[0], { id: "x", key: "blessed" });
  });

  test("an update that leaves Duration alone keeps the end", () => {
    const state = addSpan(withClock(H), BREE, "x", 600).state;
    const r = run(run(state, { t: "clock.advance", by: 300 }).state, { t: "actor.effect.update", target: BREE, effectId: "x", patch: { label: "Shield of Faith" } });
    assert.deepEqual(effectsOf(r.state, "bree")[0]!.ends, { span: 600, at: H + 600, clock: "c1" });
  });

  test("the DM's span with no clock is refused, and one past the clock's bound", () => {
    assert.deepEqual(refusedWith(base(), { t: "actor.effect.add", target: BREE, effect: { id: "x", key: "blessed", duration: { mode: "span", seconds: 60 } } }), { code: "invalid", message: SPAN_NEEDS_CLOCK });
    const far = withClock(LIMITS.clockSecondsMax - 30);
    assert.deepEqual(refusedWith(far, { t: "actor.effect.add", target: BREE, effect: { id: "x", key: "blessed", duration: { mode: "span", seconds: 60 } } }), { code: "invalid", message: CLOCK_TOO_FAR });
  });

  test("the DM may set a span while the clock is hidden", () => {
    const r = addSpan(withClock(H, { shown: false }), BREE, "x", H);
    assert.deepEqual(effectsOf(r.state, "bree")[0]!.ends, { span: H, at: 2 * H, clock: "c1" });
  });
});

describe("a player's time span (3.4, 4.2)", () => {
  const add = (id: string): Op => ({ t: "actor.effect.add", target: BREE, effect: { id, key: "blessed", duration: { mode: "span", seconds: 600 } } });
  const bulk = (id: string): Op => ({ t: "actor.effects", add: [{ target: BREE, effect: { id, key: "blessed", duration: { mode: "span", seconds: 600 } } }] });
  const update: Op = { t: "actor.effect.update", target: BREE, effectId: "old", patch: { duration: { mode: "span", seconds: 600 } } };
  const withOld = (state: RoomState): RoomState => run(state, { t: "actor.effect.add", target: BREE, effect: { id: "old", key: "blessed" } }).state;

  test("Pat adds a span with the clock shown, by the form and by the bulk op, and his copy carries the end", () => {
    for (const op of [add("x"), bulk("x")]) {
      const allowed = canApply(op, P1, withClock(H), { canUseAsset: () => true });
      assert.ok(allowed.ok, op.t);
      const r = run(withClock(H), op, P1);
      assert.deepEqual(effectsOf(r.state, "bree")[0]!.ends, { span: 600, at: H + 600, clock: "c1" }, op.t);
      assert.deepEqual(projectState(r.state, P1, { sceneId: "s1" }).characters.bree!.actor.effects[0]!.ends, { span: 600, at: H + 600, clock: "c1" }, op.t);
    }
    assert.ok(run(withOld(withClock(H)), update, P1).state.characters.bree!.actor.effects[0]!.ends);
  });

  test("Pat's device replays his own span on its copy of the room, which holds the shared clock without its switch", () => {
    const copy = projectState(withClock(H), P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.equal(copy.clock?.shown, undefined);
    const r = applyOp(copy, add("x"), P1, env(++seq));
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.deepEqual(r.state.characters.bree!.actor.effects.at(-1)!.ends, { span: 600, at: H + 600, clock: "c1" });
  });

  test("with no clock, a hidden clock or a blackout, single, update and bulk alike get one code and one message", () => {
    const blackout = (state: RoomState): RoomState => ({ ...state, meta: { ...state.meta, view: { follow: false, blackout: true } } });
    const rooms = [base(), withClock(H, { shown: false }), blackout(withClock(H))];
    const answers = new Set<string>();
    for (const state of rooms) {
      for (const op of [add("x"), bulk("x"), update]) answers.add(JSON.stringify(refusedWith(withOld(state), op, P1)));
    }
    assert.deepEqual([...answers], [JSON.stringify({ code: "invalid", message: SPAN_CLOCK_UNSHARED })]);
  });
});

describe("a step, Set and a Long Rest end what they reach (3.3)", () => {
  test("Mage Armor for 8 hours at 10:00 PM ends with the 8 hours step, in one expire line", () => {
    const state = addSpan(withClock(22 * H), BREE, "ma", 8 * H, DM, "custom").state;
    const r = run(state, { t: "clock.advance", by: 8 * H });
    assert.equal(has(r.state, "bree", "ma"), false);
    assert.deepEqual(expiries(r.log), ["custom:bree"]);
    assert.ok(r.touched.includes(keys.character("bree")));
  });

  test("a step short of the end ends nothing, and the end itself is reached at once", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    const short = run(state, { t: "clock.advance", by: H - 60 });
    assert.ok(has(short.state, "bree", "x"));
    assert.deepEqual(expiries(short.log), []);
    assert.equal(short.touched.includes(keys.character("bree")), false);
    const reached = run(short.state, { t: "clock.advance", by: 60 });
    assert.deepEqual(expiries(reached.log), ["blessed:bree"]);
  });

  test("Set and a Calendar save that move the time end what they reach, a token's own actor too", () => {
    const state = addSpan(addSpan(withClock(0), BREE, "x", H).state, GOB, "g", 2 * H).state;
    const set = run(state, { t: "clock.set", at: 3 * H });
    assert.deepEqual(expiries(set.log), ["blessed:bree", "blessed:gob"]);
    const saved = run(state, { t: "clock.update", at: H, calendar: DAYS });
    assert.deepEqual(expiries(saved.log), ["blessed:bree"]);
    assert.ok(has(saved.state, "gob", "g"));
  });

  test("a Long Rest that ends six effects writes six lines", () => {
    let state = withClock(22 * H);
    for (let i = 0; i < 6; i++) state = addSpan(state, BREE, `e${i}`, H * (i + 1)).state;
    const r = run(state, { t: "clock.advance", by: 8 * H, why: "longRest" });
    assert.equal(expiries(r.log).length, 6);
    assert.deepEqual(effectsOf(r.state, "bree"), []);
  });

  test("setting the clock back 2 hours gives a 1 hour effect 3 hours left", () => {
    const state = addSpan(withClock(10 * H), BREE, "x", H).state;
    const back = run(state, { t: "clock.set", at: 8 * H });
    assert.ok(has(back.state, "bree", "x"));
    assert.equal(effectsOf(back.state, "bree")[0]!.ends!.at! - now(back.state), 3 * H);
    assert.deepEqual(expiries(back.log), []);
  });

  test("Undo of a Set back moves the clock forward and ends at once, with its line, what the time it puts back reaches", () => {
    const back = run(withClock(10 * H), { t: "clock.set", at: 8 * H });
    const added = addSpan(back.state, BREE, "x", H).state;
    const undone = undoOf(added, back);
    assert.equal(undone.state.clock!.t, 10 * H);
    assert.equal(has(undone.state, "bree", "x"), false);
    assert.deepEqual(expiries(undone.log), ["blessed:bree"]);
  });

  test("Undo of the step that ended it brings back the effect and the clock, with no expire line", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    const step = run(state, { t: "clock.advance", by: 2 * H });
    const undone = undoOf(step.state, step);
    assert.ok(has(undone.state, "bree", "x"));
    assert.equal(undone.state.clock!.t, 0);
    assert.deepEqual(expiries(undone.log), []);
  });

  test("Undo of a remove after the effect's end passed brings it back and ends it in the same restore", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    const removed = run(state, { t: "actor.effect.remove", target: BREE, effectId: "x" });
    const later = run(removed.state, { t: "clock.advance", by: 2 * H }).state;
    const undone = undoOf(later, removed);
    assert.equal(has(undone.state, "bree", "x"), false);
    assert.deepEqual(expiries(undone.log), ["blessed:bree"]);
  });

  test("a save-ends effect that time ends closes its waiting request in the same op", () => {
    let state = withClock(0);
    const bree = state.characters.bree!;
    const fx: Effect = { id: "fx", key: "frightened", ends: { span: H, at: H, clock: "c1" }, due: { id: "occ1", state: "pending" } };
    state = { ...state, characters: { bree: { ...bree, actor: { ...bree.actor, effects: [fx] } } } };
    state = run(state, { t: "roll.ask", request: { id: "r1", test: { kind: "save", choices: [{ ability: "wis" }] }, dc: 13, dcShown: false, resultShown: true, targets: [BREE], cause: "saveEnds", ends: { effect: "fx", occurrence: "occ1" } } }).state;
    assert.ok(state.rolls.r1);
    const r = run(state, { t: "clock.advance", by: H });
    assert.equal(r.state.rolls.r1, undefined);
    assert.deepEqual(expiries(r.log), ["frightened:bree"]);
  });
});

describe("in a fight (3.3, 4.3)", () => {
  test("Bless for 1 minute cast in round 1 ends at the Next that starts round 11, and Previous brings it back", () => {
    const state = addSpan(fightTo(withClock(H), 1), BREE, "b", 60).state;
    let s = state;
    for (let i = 0; i < 19; i++) s = run(s, { t: "encounter.next" }).state;
    assert.equal(s.encounter!.round, 10);
    assert.ok(has(s, "bree", "b"));
    const next = run(s, { t: "encounter.next" });
    assert.equal(next.state.encounter!.round, 11);
    assert.equal(has(next.state, "bree", "b"), false);
    assert.deepEqual(expiries(next.log), ["blessed:bree"]);
    const prev = run(next.state, { t: "encounter.prev" });
    assert.equal(prev.state.encounter!.round, 10);
    assert.deepEqual(effectsOf(prev.state, "bree"), effectsOf(s, "bree"));
    assert.deepEqual(expiries(prev.log), []);
  });

  test("after that Next, a step or a Set on and then Previous: Bless stays ended, no second line, round 10 back", () => {
    let s = addSpan(fightTo(withClock(H), 1), BREE, "b", 60).state;
    for (let i = 0; i < 20; i++) s = run(s, { t: "encounter.next" }).state;
    for (const move of [{ t: "clock.advance", by: 600 }, { t: "clock.set", at: now(s) + 600 }] as Op[]) {
      const moved = run(s, move);
      assert.deepEqual(expiries(moved.log), [], move.t);
      const prev = run(moved.state, { t: "encounter.prev" });
      assert.equal(prev.state.encounter!.round, 10, move.t);
      assert.equal(has(prev.state, "bree", "b"), false, move.t);
      assert.deepEqual(expiries(prev.log), [], move.t);
    }
  });

  test("the same with the clock Set back before Previous: Bless comes back with its time left", () => {
    let s = addSpan(fightTo(withClock(H), 1), BREE, "b", 60).state;
    for (let i = 0; i < 20; i++) s = run(s, { t: "encounter.next" }).state;
    const back = run(s, { t: "clock.set", at: now(s) - 600 }).state;
    const prev = run(back, { t: "encounter.prev" });
    assert.ok(has(prev.state, "bree", "b"));
    assert.ok(effectsOf(prev.state, "bree")[0]!.ends!.at! > now(prev.state));
  });

  test("Undo of a Next: the current time falls and nothing ends or is told twice", () => {
    let s = addSpan(fightTo(withClock(H), 1), BREE, "b", 60).state;
    for (let i = 0; i < 19; i++) s = run(s, { t: "encounter.next" }).state;
    const before = run(s, { t: "encounter.next" });
    const undone = undoOf(before.state, before);
    assert.ok(now(undone.state) < now(before.state));
    assert.deepEqual(expiries(undone.log), []);
  });

  test("1 minute cast in round 1, End the fight in round 10: the end adds 60 s and ends it, and Undo brings back both", () => {
    let s = addSpan(fightTo(withClock(H), 1), BREE, "b", 60).state;
    for (let i = 0; i < 18; i++) s = run(s, { t: "encounter.next" }).state;
    assert.equal(s.encounter!.round, 10);
    const end = run(s, { t: "encounter.end" });
    assert.equal(end.state.clock!.t, H + 60);
    assert.equal(has(end.state, "bree", "b"), false);
    assert.deepEqual(expiries(end.log), ["blessed:bree"]);
    const undone = undoOf(end.state, end);
    assert.ok(undone.state.encounter);
    assert.ok(has(undone.state, "bree", "b"));
    assert.deepEqual(expiries(undone.log), []);
  });

  test("rows replaced, Previous back to round 1, a co-DM's 1 minute effect on Thorn, then Undo of the Previous ends it in that restore", () => {
    const withThorn = withClock(H, {}, { characters: { ...base().characters, thorn: character("thorn", { name: "Thorn", ownerIds: [] }) } });
    let s = fightTo(withThorn, 11);
    s = run(s, { t: "encounter.remove", entryIds: ["e1", "e2"] }).state;
    s = run(s, { t: "encounter.add", entries: [{ id: "f1", tokenId: "gob", value: 12 }] }).state;
    const prev = run(s, { t: "encounter.prev" });
    assert.equal(prev.state.encounter!.round, 1);
    assert.equal(now(prev.state), H);
    const added = run(prev.state, { t: "actor.effect.add", target: { characterId: "thorn" }, effect: { id: "b", key: "blessed", duration: { mode: "span", seconds: 60 } } }, CO_DM);
    assert.equal(prev.touched.includes(keys.character("thorn")), false);
    const undone = undoOf(added.state, prev);
    assert.equal(undone.state.encounter!.round, 11);
    assert.equal(now(undone.state), H + 60);
    assert.deepEqual(undone.state.characters.thorn!.actor.effects, []);
    assert.deepEqual(expiries(undone.log), ["blessed:thorn"]);
  });

  test("10 minutes cast in round 1, Next to round 11, Undo, a Calendar save 9 minutes on, then Redo of the Next ends it", () => {
    let s = addSpan(fightTo(withClock(H), 1), BREE, "b", 600).state;
    for (let i = 0; i < 19; i++) s = run(s, { t: "encounter.next" }).state;
    const next = run(s, { t: "encounter.next" });
    assert.equal(next.touched.includes(keys.character("bree")), false);
    const undo = undoOf(next.state, next);
    const saved = run(undo.state, { t: "clock.update", at: now(undo.state) + 540 });
    assert.ok(has(saved.state, "bree", "b"));
    const redo = restore(saved.state, undo.inverse!, "redo", ++seq);
    assert.equal(redo.state.encounter!.round, 11);
    assert.equal(has(redo.state, "bree", "b"), false);
    assert.deepEqual(expiries(redo.log), ["blessed:bree"]);
  });
});

describe("Stop, a new clock and a reused id (3.3)", () => {
  test("Stop ends nothing, and Undo setup of it brings the clock back with its id, and the effects run again", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    const stop = run(state, { t: "clock.stop" });
    assert.ok(has(stop.state, "bree", "x"));
    const back = undoOf(stop.state, stop);
    assert.equal(back.state.clock!.id, "c1");
    assert.ok(has(back.state, "bree", "x"));
    assert.deepEqual(expiries(run(back.state, { t: "clock.advance", by: H }).log), ["blessed:bree"]);
  });

  test("after Stop, a new clock never ends the old effect by itself", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    let s = run(run(state, { t: "clock.stop" }).state, { t: "clock.start", id: "c2", at: 0, shown: true, calendar: DAYS }).state;
    s = run(s, { t: "clock.advance", by: 30 * 86_400 }).state;
    assert.ok(has(s, "bree", "x"));
  });

  test("a clock.start that reuses an old clock's id ends its due effects in that op", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    const stopped = run(state, { t: "clock.stop" }).state;
    const r = run(stopped, { t: "clock.start", id: "c1", at: 2 * H, shown: true, calendar: DAYS });
    assert.equal(has(r.state, "bree", "x"), false);
    assert.deepEqual(expiries(r.log), ["blessed:bree"]);
  });
});

describe("the gate (4.5)", () => {
  test("an op stored before time spans neither scans, ticks nor filters", () => {
    const state = addSpan(withClock(0), BREE, "x", H).state;
    const r = applyOp(state, { t: "clock.advance", by: 2 * H }, DM, { ...env(++seq), opVersion: 53 });
    assert.ok(r.ok);
    assert.ok(has(r.state, "bree", "x"));
  });
});
