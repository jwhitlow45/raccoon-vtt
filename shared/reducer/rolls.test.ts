import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp } from "../dice/resolve.ts";
import { CANNOT_REROLL, LUCKY_CHANGES_NOTHING, type Draw } from "../dice/roll.ts";
import type { Actor, Effect, LogEntry, LogEvent, RollChange, RollTarget, RoomState, Viewer } from "../model.ts";
import { ANSWER_NEEDS_TAG, NO_TYPED_TOTALS, ONLY_PLAYERS_ASK, SETTLED_MEANWHILE, TYPE_THE_TOTAL, canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import { clientOpSchema, type Op, type OpOf, type RestoreEntry, type RollRequestInput } from "../protocol.ts";
import { reads, satisfies } from "../reads.ts";
import { applyOp } from "../reducer.ts";
import { resultOf } from "../rules/rolls.ts";
import { DM, P1, P2, actor, character, effect, env, room, token } from "../testutil.ts";
import { ALREADY_ASKED, DIE_NEEDED, ENDS_NEEDS_ONE, FINAL, ROLLED_ONLY, SAVE_SETTLED, SEND_INSTEAD, TYPED_ONLY } from "./rolls.ts";

/**
 * Roll requests with wave 7's additions (docs/design-v1-roll-request.md 1.1
 * and 7.5): answers that keep their tag and the DM's mark, `resultOf`
 * through the reducer, the "save ends" request's fields and refusals, the
 * close rule on every close path, and the rule that closes a save-ends
 * request on whatever op settles it. Each op runs as the actor runs it:
 * permissions, the resolve for a roll with a scripted draw, then the reducer.
 * `due` is written into the state directly, since doc 3's turn end comes
 * later. A player's ask to change an answer is a real `roll.change`.
 */
const DEPS = { canUseAsset: () => true };
const DEX = { kind: "save" as const, choices: [{ ability: "dex" as const }] };
const THORN = { characterId: "thorn" };
const PIP = { tokenId: "pip" };

type Ran = { ok: true; state: RoomState; log: LogEntry[]; inverse: RestoreEntry[] | null };
type Refused = { ok: false; code: string; message: string };

let seq = 100;
function send(state: RoomState, op: Op, who: Viewer = DM, faces: number[] = []): Ran | Refused {
  const decision = canApply(op, who, state, DEPS);
  if (!decision.ok) return decision;
  let stored: Op = op;
  if (op.t === "roll.dice") {
    const draw: Draw = () => {
      const face = faces.shift();
      assert.ok(face !== undefined, "a face for every die");
      return face;
    };
    const resolved = resolveDiceOp(op, state, { draw, batch: "AbCdEfGhIjKlMnOp" });
    if (!resolved.ok) return resolved;
    stored = resolved.op;
  }
  const r = applyOp(state, stored, who, env(++seq));
  return r.ok ? { ok: true, state: r.state, log: r.log, inverse: r.inverse } : r;
}

function ok(r: Ran | Refused): Ran {
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.message}`);
  return r;
}

function frightened(id: string, occurrence: string, overrides: Partial<Effect> = {}): Effect {
  return effect(id, { key: "frightened", due: { id: occurrence, state: "pending" }, ...overrides });
}

/** Thorn (p1), Frightened with a pending save, Vex (p2), and Pip, p1's token, Frightened too. */
function table(): RoomState {
  return room({
    characters: {
      thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ effects: [frightened("fx", "occ1")] }) }),
      vex: character("vex", { name: "Vex", ownerIds: ["p2"] }),
    },
    tokens: { pip: token("pip", { kind: "npc", name: "Pip", ownerIds: ["p1"], actor: { inline: actor({ effects: [frightened("pfx", "pocc1")] }) } }) },
  });
}

function ask(id: string, extra: Partial<RollRequestInput> = {}): Op {
  return { t: "roll.ask", request: { id, test: DEX, dc: 13, dcShown: false, resultShown: true, targets: [THORN], ...extra } };
}
const endsAsk = (id: string, extra: Partial<RollRequestInput> = {}): Op => ask(id, { cause: "saveEnds", ends: { effect: "fx", occurrence: "occ1" }, ...extra });

let tags = 0;
function answer(rest: { total?: number; result?: "pass" | "fail"; choice?: 0 | 1 }, target: { characterId: string } | { tokenId: string } = THORN, rollId = "r1"): OpOf<"roll.answer"> {
  return { t: "roll.answer", rollId, target, ...rest, tag: `t${++tags}` };
}
function roll(rest: Partial<OpOf<"roll.dice">> = {}, target: { characterId: string } | { tokenId: string } = THORN, rollId = "r1"): OpOf<"roll.dice"> {
  return { t: "roll.dice", tag: `t${++tags}`, rollId, target, ...(rest.change === undefined ? { bonus: 0 } : {}), ...rest };
}

const targetOf = (state: RoomState, rollId = "r1", i = 0): RollTarget => state.rolls[rollId]!.targets[i]!;
const lineOf = (r: Ran) => r.log.find((e) => e.data?.type === "roll")!.data as Extract<LogEvent, { type: "roll" }>;
const effectsOf = (state: RoomState, who: "thorn" | "pip" = "thorn"): Effect[] => (who === "thorn" ? state.characters.thorn!.actor.effects : (state.tokens.pip!.actor as { inline: Actor }).inline.effects);

const OWNERS: Record<string, Viewer> = { thorn: P1, pip: P1, vex: P2 };
const ownerOf = (t: RollTarget): Viewer => OWNERS[t.tokenId ?? t.characterId!]!;
const refOf = (t: RollTarget) => (t.tokenId !== undefined ? { tokenId: t.tokenId } : { characterId: t.characterId! });

/** The first target's player asks to change its answer, naming the answer's tag as the card does. */
function withAsk(state: RoomState, change: Omit<RollChange, "on">, rollId = "r1"): RoomState {
  const first = state.rolls[rollId]!.targets[0]!;
  return ok(send(state, { t: "roll.change", rollId, target: refOf(first), ask: { ...change, on: first.tag! } }, ownerOf(first))).state;
}
function withThornEffects(state: RoomState, effects: Effect[]): RoomState {
  const thorn = state.characters.thorn!;
  return { ...state, characters: { ...state.characters, thorn: { ...thorn, actor: { ...thorn.actor, effects } } } };
}
const chat: Op = { t: "log.chat", text: "Onward." };

describe("an answer keeps its tag, and the DM's mark is its own (7.5)", () => {
  test("a player's total keeps the op's tag, is judged by the DC, and its line carries the tag and no mark", () => {
    const r = ok(send(ok(send(table(), ask("r1"))).state, answer({ total: 15 }), P1));
    const target = targetOf(r.state);
    assert.deepEqual({ total: target.total, result: target.result, tag: target.tag, mark: target.mark, by: target.by }, { total: 15, result: "pass", tag: `t${tags}`, mark: undefined, by: "p1" });
    assert.equal(lineOf(r).tag, target.tag);
    assert.equal(lineOf(r).mark, undefined);
  });

  test("a DM's bare mark on a rolled answer keeps its total and dice, takes the op's tag, ends a pending ask, and its line says a mark wrote it", () => {
    let state = ok(send(table(), ask("r1", { targets: [{ characterId: "vex" }] }))).state;
    state = ok(send(state, roll({}, { characterId: "vex" }), P2, [3])).state;
    const rolled = targetOf(state);
    state = withAsk(state, { id: "ask1", reason: "heroic-inspiration" });
    const marked = ok(send(state, answer({ result: "pass" }, { characterId: "vex" })));
    const target = targetOf(marked.state);
    assert.equal(target.total, 3);
    assert.deepEqual(target.dice, rolled.dice);
    assert.equal(target.mark, "pass");
    assert.equal(target.result, "pass");
    assert.equal(target.tag, `t${tags}`);
    assert.notEqual(target.tag, rolled.tag);
    assert.equal(target.change, undefined, "the ask named the old tag, so it goes");
    assert.equal(target.previous, undefined, "a mark replaces no answer");
    assert.deepEqual(lineOf(marked), { type: "roll", test: DEX, characterId: "vex", total: 3, result: "pass", dc: 13, resultShown: true, tag: target.tag, mark: true });
    const allow = send(marked.state, roll({ change: "ask1" }, { characterId: "vex" }), DM, [19]);
    assert.deepEqual(allow, { ok: false, code: "invalid", message: SETTLED_MEANWHILE });
  });

  test("a DM's mark on a creature still waiting sets the mark and the result alone", () => {
    const r = ok(send(ok(send(table(), ask("r1"))).state, answer({ result: "fail" })));
    const { tokenId: _t, characterId, ...rest } = targetOf(r.state);
    assert.equal(characterId, "thorn");
    assert.deepEqual(rest, { mark: "fail", result: "fail", tag: `t${tags}`, by: "dm1" });
    assert.equal(lineOf(r).mark, true);
    assert.equal(lineOf(r).total, undefined);
  });

  test("a DM's total with a result sets both, and the mark is the result whatever the DC says", () => {
    const r = ok(send(ok(send(table(), ask("r1"))).state, answer({ total: 18, result: "fail" })));
    const target = targetOf(r.state);
    assert.deepEqual({ total: target.total, mark: target.mark, result: target.result }, { total: 18, mark: "fail", result: "fail" });
    assert.equal(lineOf(r).mark, true);
  });

  test("a player's new total, a new roll and a reopen each make a fresh answer, with no mark and no ask, and the old one in previous", () => {
    let state = ok(send(table(), ask("r1", { dcShown: true }))).state;
    state = ok(send(state, answer({ total: 10 }), P1)).state;
    state = ok(send(state, answer({ result: "pass" }))).state;
    const marked = targetOf(state);
    state = ok(send(state, answer({ total: 12 }), P1)).state;
    let target = targetOf(state);
    assert.deepEqual({ total: target.total, mark: target.mark, result: target.result }, { total: 12, mark: undefined, result: "fail" });
    assert.equal(target.previous?.mark, "pass");
    assert.equal(target.previous?.tag, marked.tag);
    state = ok(send(state, roll(), DM, [17])).state;
    target = targetOf(state);
    assert.deepEqual({ total: target.total, result: target.result, previous: target.previous?.total }, { total: 17, result: "pass", previous: 12 });
    state = withAsk(state, { id: "ask1", reason: "heroic-inspiration" });
    state = ok(send(state, { t: "roll.reopen", rollId: "r1", target: THORN })).state;
    target = targetOf(state);
    assert.deepEqual(Object.keys(target).sort(), ["characterId", "previous"]);
    assert.equal(target.previous?.total, 17);
    assert.equal(target.change, undefined);
  });

  test("a live answer without its tag is refused, for the DM and players alike", () => {
    const state = ok(send(table(), ask("r1"))).state;
    const bare: Op = { t: "roll.answer", rollId: "r1", target: THORN, total: 12 };
    for (const who of [DM, P1]) assert.deepEqual(canApply(bare, who, state, DEPS), { ok: false, code: "invalid", message: ANSWER_NEEDS_TAG });
    assert.ok(canApply({ ...bare, tag: "t" } as Op, P1, state, DEPS).ok);
  });
});

describe("resultOf through the reducer", () => {
  test("the DM's mark comes first: Pass on 3 against DC 13, and read at any other DC", () => {
    let state = ok(send(table(), ask("r1"))).state;
    state = ok(send(state, answer({ total: 3 }), P1)).state;
    assert.equal(targetOf(state).result, "fail");
    state = ok(send(state, answer({ result: "pass" }))).state;
    assert.equal(targetOf(state).result, "pass");
    assert.equal(resultOf(targetOf(state), 25), "pass");
  });

  test("a mark that agreed with its total when made still wins at another DC", () => {
    let state = ok(send(table(), ask("r1"))).state;
    state = ok(send(state, answer({ total: 15 }), P1)).state;
    const unmarked = targetOf(state);
    state = ok(send(state, answer({ result: "pass" }))).state;
    assert.equal(resultOf(unmarked, 20), "fail");
    assert.equal(resultOf(targetOf(state), 20), "pass");
  });

  test("a mark on a rolled save a condition failed beats `fails`, and the total and the dice stay", () => {
    const stunned = withThornEffects(table(), [frightened("fx", "occ1"), effect("st", { key: "stunned" })]);
    let state = ok(send(stunned, ask("r1"))).state;
    state = ok(send(state, roll(), P1, [19])).state;
    assert.equal(targetOf(state).dice?.fails, "stunned");
    assert.equal(targetOf(state).result, "fail");
    state = ok(send(state, answer({ result: "pass" }))).state;
    const target = targetOf(state);
    assert.deepEqual({ total: target.total, fails: target.dice?.fails, result: target.result }, { total: 19, fails: "stunned", result: "pass" });
  });
});

describe("the request's additions (1.1, 7.5)", () => {
  test("spell, cause and ends are stored, and a player's request carries spell and cause but never ends", () => {
    const state = ok(send(table(), endsAsk("r1", { spell: true }))).state;
    const request = state.rolls.r1!;
    assert.deepEqual({ spell: request.spell, cause: request.cause, ends: request.ends }, { spell: true, cause: "saveEnds", ends: { effect: "fx", occurrence: "occ1" } });
    const mine = projectState(state, P1, { sceneId: "s1" }).rolls.r1!;
    assert.deepEqual({ spell: mine.spell, cause: mine.cause, ends: mine.ends }, { spell: true, cause: "saveEnds", ends: undefined });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).rolls.r1, request);
    assert.equal(ok(send(table(), ask("r2", { cause: "saveEnds" }))).state.rolls.r2!.cause, "saveEnds", "cause alone is allowed");
  });

  test("ends needs one save of one creature that has the effect now", () => {
    const refusal = { ok: false, code: "invalid", message: ENDS_NEEDS_ONE };
    const ends = { effect: "fx", occurrence: "occ1" };
    for (const [why, op] of [
      ["no cause", ask("r1", { ends })],
      ["a check", endsAsk("r1", { test: { kind: "check", choices: [{ ability: "wis" }] } })],
      ["two choices", endsAsk("r1", { test: { kind: "save", choices: [{ ability: "dex" }, { ability: "wis" }] } })],
      ["two creatures", endsAsk("r1", { targets: [THORN, { characterId: "vex" }] })],
      ["an effect the creature lacks", endsAsk("r1", { targets: [{ characterId: "vex" }] })],
      ["an effect on another creature", endsAsk("r1", { targets: [PIP] })],
    ] as const) {
      assert.deepEqual(send(table(), op), refusal, why);
    }
    assert.ok(send(table(), endsAsk("r1", { targets: [PIP], ends: { effect: "pfx", occurrence: "pocc1" } })).ok, "a token's own effect");
  });

  test("a second open request for one occurrence is refused, and so is one for an occurrence the close settled (docs/design-v1-roll-options.md 6.1)", () => {
    let state = ok(send(table(), endsAsk("r1"))).state;
    assert.deepEqual(send(state, endsAsk("r2")), { ok: false, code: "invalid", message: ALREADY_ASKED });
    assert.ok(send(withThornEffects(state, [frightened("fx", "occ2")]), endsAsk("r2", { ends: { effect: "fx", occurrence: "occ2" } })).ok, "another occurrence is another save");
    state = ok(send(state, { t: "roll.close", rollIds: ["r1"] })).state;
    assert.deepEqual(send(state, endsAsk("r2")), { ok: false, code: "invalid", message: SAVE_SETTLED });
    assert.ok(send(withThornEffects(state, [frightened("fx", "occ2")]), endsAsk("r2", { ends: { effect: "fx", occurrence: "occ2" } })).ok, "the next turn end's occurrence can be asked");
  });
});

describe("roll.close settles each request it closes, in the same op (1.1)", () => {
  const dueOf = (state: RoomState) => effectsOf(state).find((e) => e.id === "fx")?.due;

  test("the live card's Close: an answered request's occurrence resolved, a waiting one's dismissed, and a pending ask goes with it", () => {
    let state = ok(send(table(), endsAsk("r1"))).state;
    state = ok(send(state, roll(), P1, [4])).state;
    state = withAsk(state, { id: "ask1", reason: "lucky" });
    const closed = ok(send(state, { t: "roll.close", rollIds: ["r1"] }));
    assert.equal(closed.state.rolls.r1, undefined);
    assert.deepEqual(dueOf(closed.state), { id: "occ1", state: "resolved" });
    const waiting = ok(send(ok(send(table(), endsAsk("r1"))).state, { t: "roll.close", rollIds: ["r1"] }));
    assert.deepEqual(dueOf(waiting.state), { id: "occ1", state: "dismissed" });
    const undone = ok(send(waiting.state, { t: "sys.restore", entries: waiting.inverse!, from: "undo", deps: true }));
    assert.deepEqual(dueOf(undone.state), { id: "occ1", state: "pending" }, "an undo puts the occurrence back with the request");
    assert.ok(undone.state.rolls.r1);
  });

  test("Accept failure and Dismiss settle as they name, answered or not", () => {
    const asked = ok(send(table(), endsAsk("r1"))).state;
    const answered = ok(send(asked, answer({ total: 5 }), P1)).state;
    assert.deepEqual(dueOf(ok(send(answered, { t: "roll.close", rollIds: ["r1"], settle: "resolved" })).state), { id: "occ1", state: "resolved" });
    assert.deepEqual(dueOf(ok(send(answered, { t: "roll.close", rollIds: ["r1"], settle: "dismissed" })).state), { id: "occ1", state: "dismissed" });
    assert.deepEqual(dueOf(ok(send(asked, { t: "roll.close", rollIds: ["r1"], settle: "resolved" })).state), { id: "occ1", state: "resolved" });
  });

  test("a newer occurrence, a settled one and a removed effect are left as they are", () => {
    const asked = ok(send(table(), endsAsk("r1"))).state;
    const newer = withThornEffects(asked, [frightened("fx", "occ2")]);
    const closedNewer = ok(send(newer, { t: "roll.close", rollIds: ["r1"], settle: "resolved" })).state;
    assert.deepEqual(dueOf(closedNewer), { id: "occ2", state: "pending" });
    assert.equal(closedNewer.rolls.r1, undefined);
    const settled = withThornEffects(asked, [frightened("fx", "occ1", { due: { id: "occ1", state: "resolved" } })]);
    assert.deepEqual(dueOf(ok(send(settled, { t: "roll.close", rollIds: ["r1"], settle: "dismissed" })).state), { id: "occ1", state: "resolved" });
    const removed = withThornEffects(asked, []);
    const closedRemoved = ok(send(removed, { t: "roll.close", rollIds: ["r1"] }));
    assert.equal(closedRemoved.state.characters.thorn, removed.characters.thorn, "nothing written to the creature");
    assert.equal(closedRemoved.state.rolls.r1, undefined);
  });

  test("Close all answered (ifSettled) skips a request still waiting or holding an ask when it runs, and closes and settles the rest", () => {
    let state = ok(send(table(), endsAsk("r1"))).state;
    state = ok(send(state, ask("r2", { targets: [THORN, { characterId: "vex" }] }))).state;
    state = ok(send(state, ask("r3", { targets: [{ characterId: "vex" }] }))).state;
    state = ok(send(state, roll({}, THORN, "r1"), P1, [6])).state;
    state = ok(send(state, answer({ total: 15 }, THORN, "r2"), P1)).state;
    state = ok(send(state, answer({ total: 15 }, { characterId: "vex" }, "r3"), P2)).state;
    const all = { t: "roll.close" as const, rollIds: ["r1", "r2", "r3"], ifSettled: true as const };
    const first = ok(send(state, all));
    assert.deepEqual(Object.keys(first.state.rolls), ["r2"], "r2 waits on Vex");
    assert.deepEqual(dueOf(first.state), { id: "occ1", state: "resolved" });
    const asking = withAsk(state, { id: "ask1", reason: "heroic-inspiration" });
    const second = ok(send(asking, all));
    assert.deepEqual(Object.keys(second.state.rolls).sort(), ["r1", "r2"], "r1 holds an ask that arrived after the tap");
    assert.deepEqual(dueOf(second.state), { id: "occ1", state: "pending" }, "and its occurrence waits with it");
  });

  test("a close without the new fields closes plain requests as before", () => {
    let state = ok(send(table(), ask("r1"))).state;
    state = ok(send(state, ask("r2", { targets: [{ characterId: "vex" }] }))).state;
    const closed = ok(send(state, { t: "roll.close", rollIds: ["r1", "r2", "gone"] }));
    assert.deepEqual(closed.state.rolls, {});
    assert.equal(closed.state.characters.thorn, state.characters.thorn);
  });
});

describe("a save-ends request closes on whatever settles it (7.5)", () => {
  const removals = (log: LogEntry[]) => log.filter((e) => e.data?.type === "effect" && e.data.action === "remove");

  test("a typed pass removes the effect once, after the answer's line, and closes the request, and an undo takes both back", () => {
    const asked = ok(send(table(), endsAsk("r1"))).state;
    const passed = ok(send(asked, answer({ total: 14 }), P1));
    assert.equal(passed.state.rolls.r1, undefined);
    assert.deepEqual(effectsOf(passed.state), []);
    assert.deepEqual(passed.log.map((e) => (e.data?.type === "effect" ? `effect ${e.data.action} ${e.data.key}` : e.data?.type)), ["roll", "effect remove frightened"]);
    assert.deepEqual(passed.log[1]!.data, { type: "effect", key: "frightened", action: "remove", characterId: "thorn" });
    const undone = ok(send(passed.state, { t: "sys.restore", entries: passed.inverse!, from: "undo", deps: true }));
    const { rev: _was, ...before } = asked.rolls.r1!;
    const { rev: _now, ...after } = undone.state.rolls.r1!;
    assert.deepEqual(after, before);
    assert.deepEqual(effectsOf(undone.state).map((e) => e.id), ["fx"]);
  });

  test("a rolled pass, the DM's Pass mark and an allowed change that passes each remove the effect and close it", () => {
    const asked = ok(send(table(), endsAsk("r1"))).state;
    const rolled = ok(send(asked, roll(), P1, [15]));
    assert.equal(rolled.state.rolls.r1, undefined);
    assert.equal(removals(rolled.log).length, 1);
    const failed = ok(send(asked, roll(), P1, [4])).state;
    const mark = ok(send(failed, answer({ result: "pass" })));
    assert.equal(mark.state.rolls.r1, undefined);
    assert.equal(removals(mark.log).length, 1);
    const allowed = ok(send(withAsk(failed, { id: "ask1", reason: "heroic-inspiration" }), roll({ change: "ask1" }), DM, [16]));
    assert.equal(allowed.state.rolls.r1, undefined);
    assert.deepEqual(effectsOf(allowed.state), []);
    assert.equal(removals(allowed.log).length, 1);
  });

  test("the effect's removal by actor.effect.remove, by actor.effects or by its duration's end closes the request", () => {
    const asked = ok(send(table(), endsAsk("r1"))).state;
    const one = ok(send(asked, { t: "actor.effect.remove", target: THORN, effectId: "fx" }));
    assert.equal(one.state.rolls.r1, undefined);
    assert.equal(removals(one.log).length, 1, "only the op's own line");
    const many = ok(send(asked, { t: "actor.effects", remove: [{ target: THORN, effectId: "fx" }] }));
    assert.equal(many.state.rolls.r1, undefined);
    let fight = ok(send(asked, { t: "encounter.start", entries: [{ id: "n1", characterId: "thorn", value: 20 }, { id: "n2", characterId: "vex", value: 10 }] })).state;
    fight = ok(send(fight, { t: "encounter.next" })).state;
    assert.equal(fight.encounter!.activeEntryId, "n1");
    assert.ok(fight.rolls.r1);
    fight = withThornEffects(fight, [frightened("fx", "occ1", { duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "n1" } } })]);
    const ended = ok(send(fight, { t: "encounter.next" }));
    assert.ok(ended.log.some((e) => e.data?.type === "effect" && e.data.action === "expire"));
    assert.equal(ended.state.rolls.r1, undefined);
  });

  test("the next occurrence of the effect closes the request of the one before", () => {
    const asked = ok(send(table(), endsAsk("r1"))).state;
    const next = ok(send(withThornEffects(asked, [frightened("fx", "occ2")]), chat));
    assert.equal(next.state.rolls.r1, undefined);
    assert.deepEqual(effectsOf(next.state).map((e) => e.due), [{ id: "occ2", state: "pending" }], "the new occurrence is left pending");
  });

  test("a fail leaves it open with its effect, typed, rolled or the DM's Fail mark", () => {
    let state = ok(send(table(), endsAsk("r1", { dcShown: true }))).state;
    state = ok(send(state, answer({ total: 5 }), P1)).state;
    state = ok(send(state, roll(), DM, [2])).state;
    state = ok(send(state, answer({ result: "fail" }))).state;
    assert.ok(state.rolls.r1);
    assert.deepEqual(effectsOf(state).map((e) => e.id), ["fx"]);
  });

  test("a token the view lacks closes nothing: a DM's view of another scene marks the pass and leaves the rest to the server", () => {
    const asked = ok(send(table(), endsAsk("r1", { targets: [PIP], ends: { effect: "pfx", occurrence: "pocc1" } }))).state;
    const { pip: _pip, ...tokens } = asked.tokens;
    const view: RoomState = { ...asked, tokens };
    const there = ok(send(view, answer({ result: "pass" }, PIP)));
    assert.equal(targetOf(there.state).result, "pass");
    assert.ok(there.state.rolls.r1, "still open in that view");
    assert.deepEqual(removals(there.log), []);
    assert.ok(ok(send(there.state, chat)).state.rolls.r1, "nor does a later op there");
    const server = ok(send(asked, answer({ result: "pass" }, PIP)));
    assert.equal(server.state.rolls.r1, undefined);
    assert.deepEqual(effectsOf(server.state, "pip"), []);
  });
});

describe("asking to change an answer, and the DM's answer (5.5, 6, 7.5)", () => {
  const change = (rest: Omit<OpOf<"roll.change">, "t" | "rollId" | "target">, target: { characterId: string } | { tokenId: string } = THORN, rollId = "r1"): OpOf<"roll.change"> => ({ t: "roll.change", rollId, target, ...rest });
  const asking = (id: string, reason: RollChange["reason"], state: RoomState, extra: Partial<RollChange> = {}) => change({ ask: { id, on: targetOf(state).tag!, reason, ...extra } });
  const refusal = (code: string, message: string) => ({ ok: false, code, message });
  /** Thorn's save asked with the DC hidden, and rolled by his player: the faces are the d20s and any extra die. */
  const rolled = (faces: number[], rest: Partial<OpOf<"roll.dice">> = {}, extra: Partial<RollRequestInput> = {}) => ok(send(ok(send(table(), ask("r1", extra))).state, roll(rest), P1, faces)).state;
  const typed = (total: number, extra: Partial<RollRequestInput> = {}) => ok(send(ok(send(table(), ask("r1", extra))).state, answer({ total }), P1)).state;

  test("the op asks or clears, one of the two, a face only with a reroll and a die only with Bardic Inspiration", () => {
    const base = { t: "roll.change", rollId: "r1", target: THORN };
    const ask_ = { id: "a1", on: "t1" };
    assert.ok(clientOpSchema.safeParse({ ...base, ask: { ...ask_, reason: "heroic-inspiration", face: 1 } }).success);
    assert.ok(clientOpSchema.safeParse({ ...base, ask: { ...ask_, reason: "bardic-inspiration", die: 8 } }).success);
    assert.ok(clientOpSchema.safeParse({ ...base, clear: "a1" }).success);
    for (const bad of [{}, { ask: { ...ask_, reason: "lucky" }, clear: "a1" }, { ask: { ...ask_, reason: "lucky", face: 0 } }, { ask: { ...ask_, reason: "heroic-inspiration", die: 6 } }, { ask: { ...ask_, reason: "fix-total", die: 6 } }]) {
      assert.equal(clientOpSchema.safeParse({ ...base, ...bad }).success, false, JSON.stringify(bad));
    }
    assert.ok(clientOpSchema.safeParse({ t: "roll.reopen", rollId: "r1", target: THORN, change: "a1" }).success);
  });

  test("who may ask, withdraw, keep and allow: the creature's player asks and withdraws, the DM keeps and allows", () => {
    const state = rolled([4]);
    const heroic = asking("a1", "heroic-inspiration", state);
    assert.deepEqual(send(state, heroic, DM), refusal("forbidden", ONLY_PLAYERS_ASK));
    assert.deepEqual(send(state, heroic, P2), refusal("gone", "that is not here"), "Vex's player cannot see Thorn's target");
    assert.equal(send(state, { ...heroic, rollId: "nope" }, P1).ok, false);
    const pending = ok(send(state, heroic, P1)).state;
    assert.deepEqual(send(pending, change({ clear: "a1" }), P2), refusal("gone", "that is not here"));
    assert.ok(send(pending, change({ clear: "a1" }), P1).ok, "Withdraw");
    assert.ok(send(pending, change({ clear: "a1" }), DM).ok, "Keep");
    assert.deepEqual(send(pending, roll({ change: "a1" }), P1, [9]), refusal("forbidden", "Only the DM allows a change to a roll."));
    assert.deepEqual(send(typed(3), { t: "roll.reopen", rollId: "r1", target: THORN, change: "a1" }, P1), refusal("forbidden", "only the DM can do that"));
  });

  test("an ask names the answer it would change, so one on an older answer, or on none, is settled meanwhile", () => {
    const state = rolled([4]);
    const stale = change({ ask: { id: "a1", on: "t-old", reason: "heroic-inspiration" } });
    assert.deepEqual(send(state, stale, P1), refusal("invalid", SETTLED_MEANWHILE));
    const waiting = ok(send(table(), ask("r1"))).state;
    assert.deepEqual(send(waiting, stale, P1), refusal("invalid", SETTLED_MEANWHILE));
    const marked = ok(send(state, answer({ result: "pass" }))).state;
    assert.deepEqual(send(marked, asking("a1", "heroic-inspiration", state), P1), refusal("invalid", SETTLED_MEANWHILE), "the mark took a new tag");
  });

  test("each ask must be one the Allow could apply, in the Allow's own words", () => {
    const typedFail = typed(3);
    for (const reason of ["heroic-inspiration", "halfling-luck", "lucky"] as const) {
      assert.deepEqual(send(typedFail, asking("a1", reason, typedFail), P1), refusal("invalid", ROLLED_ONLY), reason);
    }
    assert.deepEqual(send(typedFail, asking("a1", "bardic-inspiration", typedFail, { die: 6 }), P1), refusal("invalid", ROLLED_ONLY));
    const four = rolled([4]);
    assert.deepEqual(send(four, asking("a1", "halfling-luck", four), P1), refusal("invalid", CANNOT_REROLL), "no d20 shows 1");
    assert.deepEqual(send(four, asking("a1", "heroic-inspiration", four, { face: 1 }), P1), refusal("invalid", CANNOT_REROLL), "no second die");
    assert.deepEqual(send(four, asking("a1", "bardic-inspiration", four), P1), refusal("invalid", DIE_NEEDED));
    assert.deepEqual(send(four, asking("a1", "fix-total", four), P1), refusal("invalid", TYPED_ONLY));
    const one = rolled([1, 9], { mode: "adv" });
    assert.ok(send(one, asking("a1", "halfling-luck", one), P1).ok, "the dropped 1");
    assert.deepEqual(send(one, asking("a1", "halfling-luck", one, { face: 1 }), P1), refusal("invalid", CANNOT_REROLL), "a face showing 9");
    assert.deepEqual(send(one, asking("a1", "lucky", one), P1), refusal("invalid", LUCKY_CHANGES_NOTHING), "advantage already");
    const cancelled = rolled([7], { cancelled: true });
    assert.deepEqual(send(cancelled, asking("a1", "lucky", cancelled), P1), refusal("invalid", LUCKY_CHANGES_NOTHING), "sources that cancelled");
    const shown = typed(3, { dcShown: true });
    assert.deepEqual(send(shown, asking("a1", "fix-total", shown), P1), refusal("invalid", SEND_INSTEAD), "with the DC shown the player sends again");
    assert.ok(send(typedFail, asking("a1", "fix-total", typedFail), P1).ok, "a final typed answer");
  });

  test("an ask is stored as sent, writes no line, and another replaces it, so the first one's Allow is settled meanwhile", () => {
    const state = rolled([4]);
    const first = ok(send(state, asking("a1", "heroic-inspiration", state), P1));
    assert.deepEqual(targetOf(first.state).change, { id: "a1", on: targetOf(state).tag, reason: "heroic-inspiration" });
    assert.deepEqual(first.log, []);
    const second = ok(send(first.state, asking("a2", "bardic-inspiration", state, { die: 6 }), P1)).state;
    assert.equal(targetOf(second).change?.id, "a2");
    assert.deepEqual(send(second, roll({ change: "a1" }), DM, [19]), refusal("invalid", SETTLED_MEANWHILE));
    const allowed = ok(send(second, roll({ change: "a2" }), DM, [5])).state;
    assert.deepEqual({ total: targetOf(allowed).total, changed: targetOf(allowed).changed?.id, change: targetOf(allowed).change }, { total: 9, changed: "a2", change: undefined });
  });

  test("withdrawn, then a stale Allow is refused, and asked again, the first ask's Allow is still refused", () => {
    const state = rolled([4]);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state), P1)).state;
    const withdrawn = ok(send(pending, change({ clear: "a1" }), P1));
    assert.equal(targetOf(withdrawn.state).change, undefined);
    assert.deepEqual(withdrawn.log, []);
    assert.deepEqual(send(withdrawn.state, roll({ change: "a1" }), DM, [19]), refusal("invalid", SETTLED_MEANWHILE));
    assert.deepEqual(send(withdrawn.state, change({ clear: "a1" }), P1), refusal("invalid", SETTLED_MEANWHILE), "nothing left to withdraw");
    const again = ok(send(withdrawn.state, asking("a2", "heroic-inspiration", state), P1)).state;
    assert.deepEqual(send(again, roll({ change: "a1" }), DM, [19]), refusal("invalid", SETTLED_MEANWHILE));
    assert.deepEqual(send(again, change({ clear: "a1" }), DM), refusal("invalid", SETTLED_MEANWHILE), "a Keep of the first ends nothing");
    assert.equal(targetOf(again).change?.id, "a2");
  });

  test("two DM devices tap Allow: one change, and the second is refused before any draw", () => {
    const state = rolled([4]);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state), P1)).state;
    const once = ok(send(pending, roll({ change: "a1" }), DM, [18])).state;
    assert.equal(targetOf(once).total, 18);
    assert.deepEqual(send(once, roll({ change: "a1" }), DM), refusal("invalid", SETTLED_MEANWHILE), "no face asked for");
  });

  test("Keep clears the ask and nothing else, with no line, and its Allow is then refused", () => {
    const state = rolled([4]);
    const pending = ok(send(state, asking("a1", "lucky", state), P1)).state;
    const kept = ok(send(pending, change({ clear: "a1" }), DM));
    assert.deepEqual(targetOf(kept.state), targetOf(state));
    assert.deepEqual(kept.log, []);
    assert.deepEqual(send(kept.state, roll({ change: "a1" }), DM, [20]), refusal("invalid", SETTLED_MEANWHILE));
  });

  test("Fix my total: the Allow reopens for typing alone, the player's roll is refused, the DM's is not, and a typed total clears retype", () => {
    const fail = typed(3);
    assert.deepEqual(send(fail, answer({ total: 13 }), P1), refusal("forbidden", FINAL));
    const pending = ok(send(fail, asking("a1", "fix-total", fail), P1)).state;
    const allow = { t: "roll.reopen" as const, rollId: "r1", target: THORN, change: "a1" };
    assert.deepEqual(send(pending, { ...allow, change: "a9" }), refusal("invalid", SETTLED_MEANWHILE));
    const reopened = ok(send(pending, allow));
    const target = targetOf(reopened.state);
    assert.deepEqual({ retype: target.retype, change: target.change, total: target.total, result: target.result }, { retype: true, change: undefined, total: undefined, result: undefined });
    assert.deepEqual(target.previous, { total: 3, result: "fail", tag: targetOf(fail).tag });
    assert.deepEqual(reopened.log, []);
    assert.equal(projectState(reopened.state, P1, { sceneId: "s1" }).rolls.r1!.targets[0]!.retype, true, "the player's card knows");
    assert.deepEqual(send(reopened.state, allow), refusal("invalid", SETTLED_MEANWHILE), "a second device's Allow");
    assert.deepEqual(send(reopened.state, roll(), P1, [15]), refusal("invalid", TYPE_THE_TOTAL));
    assert.ok(send(reopened.state, roll(), DM, [15]).ok, "the DM may still roll it");
    const fixed = ok(send(reopened.state, answer({ total: 13 }), P1)).state;
    assert.deepEqual({ total: targetOf(fixed).total, result: targetOf(fixed).result, retype: targetOf(fixed).retype }, { total: 13, result: "pass", retype: undefined });
    assert.equal(targetOf(fixed).previous?.total, 3, "the fixed answer still reads as a change");
    const failedInstead = ok(send(reopened.state, answer({ result: "fail" }), P1)).state;
    assert.equal(targetOf(failedInstead).retype, undefined);
    const marked = ok(send(reopened.state, answer({ result: "pass" }))).state;
    assert.equal(targetOf(marked).retype, undefined);
  });

  test("with typed totals off a Fix my total never strands the player: the Allow reopens for a roll, and a retype set before the switch takes the player's roll (B7B-P-3)", () => {
    const fail = typed(3);
    const pending = ok(send(fail, asking("a1", "fix-total", fail), P1)).state;
    const allow = { t: "roll.reopen" as const, rollId: "r1", target: THORN, change: "a1" };
    // Asked while on, allowed after the DM turned typed totals off.
    const off = structuredClone(pending);
    off.meta.settings.playersTypeTotals = false;
    const reopened = ok(send(off, allow)).state;
    assert.deepEqual({ retype: targetOf(reopened).retype, total: targetOf(reopened).total }, { retype: undefined, total: undefined }, "reopened for a roll");
    assert.equal(targetOf(reopened).previous?.total, 3);
    assert.ok(send(reopened, roll(), P1, [15]).ok, "the player rolls it");
    assert.deepEqual(send(reopened, answer({ total: 13 }), P1), refusal("forbidden", NO_TYPED_TOTALS), "and types nothing");
    // Allowed while on, then the switch went off: the retype stays, and the player rolls it all the same.
    const retyped = ok(send(pending, allow)).state;
    assert.equal(targetOf(retyped).retype, true);
    const later = structuredClone(retyped);
    later.meta.settings.playersTypeTotals = false;
    const rolledLater = ok(send(later, roll(), P1, [15])).state;
    assert.deepEqual({ total: targetOf(rolledLater).total !== undefined, retype: targetOf(rolledLater).retype }, { total: true, retype: undefined });
    assert.deepEqual(send(retyped, roll(), P1, [15]), refusal("invalid", TYPE_THE_TOTAL), "on, a retype is still typed alone");
  });

  test("the DM's undo of a fixed-total Allow brings back the answer and the ask it allowed", () => {
    const fail = typed(3);
    const pending = ok(send(fail, asking("a1", "fix-total", fail), P1)).state;
    const reopened = ok(send(pending, { t: "roll.reopen", rollId: "r1", target: THORN, change: "a1" }));
    const undone = ok(send(reopened.state, { t: "sys.restore", entries: reopened.inverse!, from: "undo", deps: true }));
    const { rev: _was, ...before } = pending.rolls.r1!;
    const { rev: _now, ...after } = undone.state.rolls.r1!;
    assert.deepEqual(after, before);
  });

  test("a reopen or a new answer clears a pending ask", () => {
    const state = rolled([4]);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state), P1)).state;
    const reopened = ok(send(pending, { t: "roll.reopen", rollId: "r1", target: THORN })).state;
    assert.deepEqual(Object.keys(targetOf(reopened)).sort(), ["characterId", "previous"]);
    assert.deepEqual(send(reopened, roll({ change: "a1" }), DM, [19]), refusal("invalid", SETTLED_MEANWHILE));
    const replaced = ok(send(pending, answer({ total: 20 }))).state;
    assert.equal(targetOf(replaced).change, undefined);
  });

  test("Heroic Inspiration on a disadvantage roll of 14 and 6 rerolls the 6 and keeps the 14", () => {
    const state = rolled([14, 6], { mode: "dis" });
    assert.equal(targetOf(state).total, 6);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state), P1)).state;
    const allowed = ok(send(pending, roll({ change: "a1" }), DM, [17]));
    const target = targetOf(allowed.state);
    assert.deepEqual({ faces: target.dice?.faces, total: target.total, result: target.result }, { faces: [14, 17], total: 14, result: "pass" });
    assert.equal(target.previous?.total, 6);
    assert.equal(lineOf(allowed).changed?.reason, "heroic-inspiration");
  });

  test("Heroic Inspiration naming Bless's d4 redraws the d4 alone", () => {
    const state = rolled([12, 1], { extra: "1d4" });
    assert.equal(targetOf(state).total, 13);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state, { face: 1 }), P1)).state;
    const target = targetOf(ok(send(pending, roll({ change: "a1" }), DM, [4])).state);
    assert.deepEqual({ faces: target.dice?.faces, total: target.total }, { faces: [12, 4], total: 16 });
  });

  test("Lucky on a disadvantage roll draws nothing: the sources cancel, a normal roll on the first d20", () => {
    const state = rolled([14, 6], { mode: "dis" });
    const pending = ok(send(state, asking("a1", "lucky", state), P1)).state;
    const target = targetOf(ok(send(pending, roll({ change: "a1" }), DM, [])).state);
    assert.deepEqual({ faces: target.dice?.faces, total: target.total, cancelled: target.dice?.cancelled, result: target.result }, { faces: [14], total: 14, cancelled: true, result: "pass" });
  });

  test("Bardic Inspiration's d8 on 12 against DC 15 is judged against the DC again", () => {
    const state = rolled([12], {}, { dc: 15 });
    assert.equal(targetOf(state).result, "fail");
    const pending = ok(send(state, asking("a1", "bardic-inspiration", state, { die: 8 }), P1)).state;
    const target = targetOf(ok(send(pending, roll({ change: "a1" }), DM, [5])).state);
    assert.deepEqual({ total: target.total, result: target.result, changed: target.changed?.die }, { total: 17, result: "pass", changed: 8 });
  });

  test("a close settles a pending ask with its request", () => {
    const state = rolled([4]);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state), P1)).state;
    const closed = ok(send(pending, { t: "roll.close", rollIds: ["r1"] })).state;
    assert.equal(closed.rolls.r1, undefined);
    assert.equal(send(closed, roll({ change: "a1" }), DM, [19]).ok, false);
  });

  test("an ask waits for the server on a player's device, whose view may lack the DC, and a DM's Keep and Allow replay", () => {
    const state = rolled([4]);
    const pending = ok(send(state, asking("a1", "heroic-inspiration", state), P1)).state;
    const opts = { sceneId: "s1" };
    assert.ok(!satisfies(reads(asking("a2", "lucky", state), pending), projectState(pending, P1, opts), P1, opts));
    assert.ok(satisfies(reads(change({ clear: "a1" }), pending), projectState(pending, DM, opts), DM, opts));
    const fix = typed(3);
    const fixPending = ok(send(fix, asking("a1", "fix-total", fix), P1)).state;
    assert.ok(satisfies(reads({ t: "roll.reopen", rollId: "r1", target: THORN, change: "a1" }, fixPending), projectState(fixPending, DM, opts), DM, opts));
  });
});
