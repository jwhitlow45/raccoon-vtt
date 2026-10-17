import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDiceOp } from "../dice/resolve.ts";
import type { Actor, Effect, LogEntry, RollRequest, RollTarget, RollTest, RoomState, Viewer } from "../model.ts";
import { SETTLED_MEANWHILE, ANSWERED_MEANWHILE, canApply } from "../permissions.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { resultOf } from "../rules/rolls.ts";
import { DM, P1, P2, actor, chance, character, companionBlock, env, int, pick, rng, room, token } from "../testutil.ts";
import { ALREADY_ASKED, FINAL, isFinal } from "./rolls.ts";

/**
 * Randomized: a request's answers on the reducer (docs/design-v1-roll-request.md
 * 11.1, the reducer's bullet, reduced to what exists now: `roll.change` and
 * "Fix my total" come later, so a player's pending ask and a turn end's new
 * occurrence are written into the state directly). Each sequence mixes
 * typed totals, fails without rolling, the DM's totals and marks, rolls on
 * the server (a player's, the DM's with and without `unanswered`, with a
 * typed bonus, with `fails`, with `change` naming the pending ask or a stale
 * one), reopens, closes of any requests with and without `settle` and
 * `ifSettled`, effect removals by op and by expiry, new occurrences and
 * asks, on requests with no DC, a shown DC, a hidden DC, and `ends`. Every
 * op runs as the actor runs it, permissions first, and refused ones are
 * skipped.
 *
 * Invariants, after every step:
 *  1. A player never changes a final answer.
 *  2. A player's roll never replaces any answer.
 *  3. A replaced answer is always in `previous`. A DM's bare mark replaces
 *     none: it keeps the answer and its `previous`.
 *  4. With a DC, a total's result is `total >= dc` unless a DM mark or `fails`.
 *  5. `dice` is on a target exactly when its latest total was rolled.
 *  6. An `unanswered` roll never replaces an answer.
 *  7. A `change` roll happens at most once per ask, and only while that ask
 *     is pending on the answer it was made on.
 *  8. `change` never survives a new answer, a reopen or a close, and no op
 *     makes one.
 *  9. `result` always equals `resultOf(answer, dc)`.
 * 10. An `ends` request closes on its first pass, its effect's removal, the
 *     DM's close or its next occurrence, and never on a fail.
 * 11. A pass removes its effect at most once: an effect that goes leaves
 *     exactly one line.
 * 12. No two open requests share an occurrence.
 * 13. A close settles only its own occurrence and only while it is pending,
 *     as `settle` names or by whether it was answered, and nothing else
 *     changes an occurrence.
 * 14. No pending ask survives a close.
 * 15. `ifSettled` never closes a request holding a pending ask or a waiting
 *     target when the op runs.
 */
type Creature = { characterId: string } | { tokenId: string };
type Step = { pre?: (state: RoomState) => RoomState; op: Op; who: Viewer };
type Reached = Record<string, number>;

const SEQUENCES = 2000;
const STEPS = 30;
const DEPS = { canUseAsset: () => true };
const CREATURES: readonly Creature[] = [{ characterId: "thorn" }, { characterId: "vex" }, { tokenId: "owl" }];
const OWNER: Record<string, Viewer> = { thorn: P1, vex: P2, owl: P1 };
const TESTS: readonly RollTest[] = [
  { kind: "save", choices: [{ ability: "dex" }] },
  { kind: "check", choices: [{ ability: "wis", skill: "perception" }] },
  { kind: "save", choices: [{ ability: "dex" }, { ability: "wis" }] },
];
const DEX = TESTS[0]!;
const chat: Op = { t: "log.chat", text: "Onward." };

const nameOf = (c: Creature | RollTarget): string => ("tokenId" in c && c.tokenId !== undefined ? c.tokenId : (c as { characterId: string }).characterId);
const refOf = (t: RollTarget): Creature => (t.tokenId !== undefined ? { tokenId: t.tokenId } : { characterId: t.characterId! });
const answered = (t: RollTarget) => t.total !== undefined || t.result !== undefined;
const settledNow = (request: RollRequest) => request.targets.every((t) => answered(t) && t.change === undefined);
const targetIn = (request: RollRequest | undefined, c: Creature | RollTarget) => request?.targets.find((t) => nameOf(t) === nameOf(c));

/** A target's answer alone, as `previous` must hold it: everything but whose it is, who gave it, the one before and an ask. */
function answerPart(t: RollTarget): Record<string, unknown> {
  const { tokenId: _t, characterId: _c, by: _b, previous: _p, change: _a, ...rest } = t;
  return rest;
}

function actorOf(state: RoomState, c: Creature): Actor {
  if ("characterId" in c) return state.characters[c.characterId]!.actor;
  return (state.tokens[c.tokenId]!.actor as { inline: Actor }).inline;
}
function withEffects(state: RoomState, c: Creature, effects: Effect[]): RoomState {
  if ("characterId" in c) {
    const holder = state.characters[c.characterId]!;
    return { ...state, characters: { ...state.characters, [holder.id]: { ...holder, actor: { ...holder.actor, effects } } } };
  }
  const holder = state.tokens[c.tokenId]!;
  return { ...state, tokens: { ...state.tokens, [holder.id]: { ...holder, actor: { inline: { ...actorOf(state, c), effects } } } } };
}
function withTarget(state: RoomState, rollId: string, c: Creature, change: (t: RollTarget) => RollTarget): RoomState {
  const request = state.rolls[rollId]!;
  return { ...state, rolls: { ...state.rolls, [rollId]: { ...request, targets: request.targets.map((t) => (nameOf(t) === nameOf(c) ? change(t) : t)) } } };
}
const fxOf = (state: RoomState, c: Creature) => actorOf(state, c).effects.find((e) => e.key === "frightened");
const effectById = (state: RoomState, c: Creature, id: string) => actorOf(state, c).effects.find((e) => e.id === id);

/** Thorn (p1) and Owl (p1's, with a companion block, so the server knows its bonus) Frightened with a pending save, Vex (p2), in a fight. */
function world(): RoomState {
  let state = room({
    characters: {
      thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ effects: [{ id: "fx-thorn", key: "frightened", due: { id: "occ-thorn", state: "pending" } }] }) }),
      vex: character("vex", { name: "Vex", ownerIds: ["p2"] }),
      bree: character("bree", { name: "Bree", ownerIds: ["p1"] }),
    },
    companionBlocks: { b1: companionBlock("b1", "bree") },
    tokens: { owl: token("owl", { kind: "npc", name: "Owl", ownerIds: ["p1"], actor: { inline: actor({ blockId: "b1", effects: [{ id: "fx-owl", key: "frightened", due: { id: "occ-owl", state: "pending" } }] }) } }) },
  });
  const ops: Op[] = [{ t: "encounter.start", entries: CREATURES.map((c, i) => ({ id: `n-${nameOf(c)}`, ...c, value: 20 - i })) }, { t: "encounter.next" }];
  for (const [i, op] of ops.entries()) {
    const r = applyOp(state, op, DM, env(i + 1));
    assert.ok(r.ok, op.t);
    state = r.state;
  }
  return state;
}

/** One random step: an op and who sends it, and for some a direct write before it, of what a later build's op would write. */
function nextStep(r: () => number, state: RoomState, n: number): Step {
  const open = Object.values(state.rolls).sort((a, b) => (a.id < b.id ? -1 : 1));
  const request = open.length > 0 && chance(r, 0.95) ? pick(r, open) : undefined;
  const target = request ? pick(r, request.targets) : undefined;
  const ref = target ? refOf(target) : pick(r, CREATURES);
  const rollId = request?.id ?? "gone";
  const choice = request && request.test.choices.length > 1 && chance(r, 0.5) ? { choice: pick(r, [0, 1] as const) } : {};
  const creature = pick(r, CREATURES);
  const kinds = ["ask", "ask", "answer", "answer", "mark", "mark", "roll", "roll", "dmRoll", "dmRoll", "reopen", "close", "close", "remove", "stunned", "next", "occurrence", "readd", "playerAsk", "playerAsk"] as const;
  // Requests close often, so a table with none asks again more often than not.
  const kind = open.length === 0 && chance(r, 0.7) ? "ask" : pick(r, kinds);
  switch (kind) {
    case "ask": {
      const fx = fxOf(state, creature);
      if (fx && chance(r, 0.6)) {
        const taken = open.flatMap((q) => (q.ends ? [q.ends.occurrence] : []));
        const occurrence = taken.length > 0 && chance(r, 0.2) ? pick(r, taken) : chance(r, 0.9) ? (fx.due?.id ?? "none") : `stale${n}`;
        const input = { id: `r${n}`, test: DEX, dc: int(r, 5, 20), dcShown: chance(r, 0.4), resultShown: chance(r, 0.7), cause: "saveEnds" as const, ends: { effect: fx.id, occurrence }, targets: [creature] };
        return { op: { t: "roll.ask", request: input }, who: DM };
      }
      const dc = pick(r, ["none", "shown", "hidden"] as const);
      const targets = CREATURES.filter((c) => c === creature || chance(r, 0.3));
      const input = { id: `r${n}`, test: pick(r, TESTS), ...(dc === "none" ? {} : { dc: int(r, 5, 20) }), dcShown: dc === "shown", resultShown: chance(r, 0.6), targets };
      return { op: { t: "roll.ask", request: input }, who: DM };
    }
    case "answer": {
      const answer = chance(r, 0.25) ? { result: "fail" as const } : { total: int(r, -2, 25), ...choice };
      return { op: { t: "roll.answer", rollId, target: ref, ...answer, tag: `a${n}` }, who: OWNER[nameOf(ref)]! };
    }
    case "mark": {
      const kind = pick(r, ["total", "both", "mark", "mark"] as const);
      const result = pick(r, ["pass", "fail"] as const);
      const answer = kind === "total" ? { total: int(r, -2, 25), ...choice } : kind === "both" ? { total: int(r, -2, 25), result, ...choice } : { result };
      return { op: { t: "roll.answer", rollId, target: ref, ...answer, tag: `a${n}` }, who: DM };
    }
    case "roll":
    case "dmRoll": {
      const dm = kind === "dmRoll";
      const who = dm ? DM : OWNER[nameOf(ref)]!;
      if (dm && chance(r, 0.35)) {
        // The DM's Allow: mostly of a pending ask, sometimes naming one that is stale or never was.
        const asked = open.flatMap((q) => q.targets.filter((t) => t.change).map((t) => ({ q, t })));
        const allow = asked.length > 0 && chance(r, 0.75) ? pick(r, asked) : undefined;
        const change = allow && chance(r, 0.85) ? allow.t.change!.id : `stale${n}`;
        return { op: { t: "roll.dice", tag: `d${n}`, rollId: allow?.q.id ?? rollId, target: allow ? refOf(allow.t) : ref, change }, who };
      }
      const mode = chance(r, 0.3) ? { mode: pick(r, ["adv", "dis"] as const) } : {};
      const extra = chance(r, 0.15) ? { extra: "1d4" } : {};
      const bonus = chance(r, 0.9) ? { bonus: int(r, -2, 8) } : {};
      const unanswered = dm && chance(r, 0.5) ? { unanswered: true as const } : {};
      return { op: { t: "roll.dice", tag: `d${n}`, rollId, target: ref, ...choice, ...mode, ...extra, ...bonus, ...unanswered }, who };
    }
    case "reopen":
      return { op: { t: "roll.reopen", rollId, target: ref }, who: DM };
    case "close": {
      const ids = open.filter(() => chance(r, 0.5)).map((q) => q.id);
      if (ids.length === 0 || chance(r, 0.1)) ids.push(request?.id ?? "gone");
      const settle = pick(r, [undefined, undefined, "resolved", "dismissed"] as const);
      return { op: { t: "roll.close", rollIds: ids, ...(settle ? { settle } : {}), ...(chance(r, 0.4) ? { ifSettled: true as const } : {}) }, who: DM };
    }
    case "remove": {
      const effects = actorOf(state, creature).effects;
      if (effects.length === 0) return { op: chat, who: DM };
      const effectId = pick(r, effects).id;
      return { op: chance(r, 0.5) ? { t: "actor.effect.remove", target: creature, effectId } : { t: "actor.effects", remove: [{ target: creature, effectId }] }, who: DM };
    }
    case "stunned": {
      const stunned = actorOf(state, creature).effects.find((e) => e.key === "stunned");
      if (stunned) return { op: { t: "actor.effect.remove", target: creature, effectId: stunned.id }, who: DM };
      return { op: { t: "actor.effect.add", target: creature, effect: { id: `st${n}`, key: "stunned", ...(chance(r, 0.2) ? { hiddenFromPlayers: true } : {}) } }, who: DM };
    }
    case "next":
      return { op: { t: "encounter.next" }, who: DM };
    case "occurrence": {
      // The creature's turn end asks the save again (docs/design-v1-roll-options.md 6.1): a new occurrence, pending.
      const fx = fxOf(state, creature);
      if (!fx) return { op: chat, who: DM };
      const pre = (s: RoomState) => withEffects(s, creature, actorOf(s, creature).effects.map((e) => (e.id === fx.id ? { ...e, due: { id: `occ-${nameOf(creature)}-${n}`, state: "pending" as const } } : e)));
      return { pre, op: chat, who: DM };
    }
    case "readd": {
      if (fxOf(state, creature)) return { op: chat, who: DM };
      const duration = chance(r, 0.4) ? { duration: { remaining: int(r, 1, 2), boundary: "turnEnd" as const, anchor: { entryId: `n-${nameOf(creature)}` } } } : {};
      // Effect ids are unique per creature only, so another creature may hold the same one.
      const fx: Effect = { id: `fx${n}`, key: "frightened", due: { id: `occ-${nameOf(creature)}-${n}`, state: "pending" }, ...duration };
      return { pre: (s) => withEffects(s, creature, [...actorOf(s, creature).effects, fx]), op: chat, who: DM };
    }
    case "playerAsk": {
      // A player's ask to change a rolled answer (roll.change, later): it names the answer's tag.
      const rolled = open.flatMap((q) => q.targets.filter((t) => t.dice !== undefined && t.tag !== undefined).map((t) => ({ q, t })));
      if (rolled.length === 0) return { op: chat, who: DM };
      const { q, t } = pick(r, rolled);
      const reason = pick(r, ["heroic-inspiration", "bardic-inspiration", "lucky"] as const);
      const change = { id: `ask${n}`, on: t.tag!, reason, ...(reason === "bardic-inspiration" ? { die: 6 as const } : {}) };
      return { pre: (s) => withTarget(s, q.id, refOf(t), (x) => ({ ...x, change })), op: chat, who: DM };
    }
  }
}

type Ran = { ok: true; state: RoomState; stored: Op; log: LogEntry[] } | { ok: false; code: string; message: string };

/** Permissions, the resolve with the sequence's draw, then the reducer, as the actor runs them. */
function send(state: RoomState, op: Op, who: Viewer, seq: number, r: () => number): Ran {
  const decision = canApply(op, who, state, DEPS);
  if (!decision.ok) return decision;
  let stored = op;
  if (op.t === "roll.dice") {
    const resolved = resolveDiceOp(op, state, { draw: (sides) => int(r, 1, sides), batch: "AbCdEfGhIjKlMnOp" });
    if (!resolved.ok) return resolved;
    stored = resolved.op;
  }
  const applied = applyOp(state, stored, who, env(seq));
  return applied.ok ? { ok: true, state: applied.state, stored, log: applied.log } : applied;
}

function creatureLines(log: LogEntry[], c: Creature): number {
  return log.filter((e) => e.data?.type === "effect" && e.data.key === "frightened" && (e.data.action === "remove" || e.data.action === "expire") && nameOf(e.data as Creature) === nameOf(c)).length;
}

/** Every invariant above, for one applied step. */
function check(before: RoomState, after: RoomState, step: Step, stored: Op, log: LogEntry[], asksUsed: Set<string>, reached: Reached, pre: boolean, at: string): void {
  const op = step.op;
  const player = step.who.role === "player";

  // The op's own target: 1, 2, 3, 5, 6, 7 and 8.
  if (op.t === "roll.answer" || op.t === "roll.dice" || op.t === "roll.reopen") {
    const was = targetIn(before.rolls[op.rollId], op.target);
    assert.ok(was, `${at}: an op on a target that is not there applied`);
    const request = before.rolls[op.rollId]!;
    if (op.t === "roll.answer" && player) assert.ok(!isFinal(request, was), `${at}: 1, a player changed a final answer`);
    if (op.t === "roll.dice" && player) assert.ok(!answered(was), `${at}: 2, a player's roll replaced an answer`);
    if (op.t === "roll.dice" && op.unanswered) assert.ok(!answered(was), `${at}: 6, an unanswered roll replaced an answer`);
    if (op.t === "roll.dice" && op.change !== undefined) {
      assert.ok(was.change?.id === op.change && was.change.on === was.tag && was.dice, `${at}: 7, a change rolled while its ask was not pending`);
      assert.ok(!asksUsed.has(op.change), `${at}: 7, an ask changed a roll twice`);
      asksUsed.add(op.change);
      reached.changeRoll = (reached.changeRoll ?? 0) + 1;
    }
    const now = targetIn(after.rolls[op.rollId], op.target);
    if (now) {
      const bareMark = op.t === "roll.answer" && !player && op.total === undefined && answered(was);
      if (op.t === "roll.reopen" && !answered(was)) assert.deepEqual(now, was, `${at}: a reopen of a waiting target changed it`);
      else if (op.t === "roll.reopen") {
        assert.deepEqual(answerPart(now), {}, `${at}: a reopen left an answer`);
        assert.deepEqual(now.previous, answerPart(was), `${at}: 3, the reopened answer is not in previous`);
      } else if (bareMark) {
        assert.deepEqual(now.previous, was.previous, `${at}: 3, a mark moved previous`);
        assert.equal(now.total, was.total, `${at}: a mark changed the total`);
        assert.deepEqual(now.dice, was.dice, `${at}: 5, a mark changed the dice`);
        reached.markKept = (reached.markKept ?? 0) + 1;
      } else assert.deepEqual(now.previous, answered(was) ? answerPart(was) : was.previous, `${at}: 3, the replaced answer is not in previous`);
      if (op.t === "roll.answer" && op.total !== undefined) assert.equal(now.dice, undefined, `${at}: 5, a typed total kept dice`);
      if (op.t === "roll.dice") assert.ok(now.dice && now.dice.total === now.total, `${at}: 5, a roll left no dice`);
      assert.equal(now.change, undefined, `${at}: 8, an ask survived a new answer or a reopen`);
    }
  }
  if (stored.t === "sys.dice" && stored.results[0]?.fails) reached.fails = (reached.fails ?? 0) + 1;
  if (stored.t === "sys.dice" && stored.typedBonus) reached.typedBonus = (reached.typedBonus ?? 0) + 1;

  // Every open target: 4, 5, 8 and 9.
  for (const request of Object.values(after.rolls)) {
    for (const t of request.targets) {
      const at2 = `${at} ${request.id}/${nameOf(t)}`;
      assert.equal(t.result, resultOf(t, request.dc), `${at2}: 9, result is not resultOf`);
      if (request.dc !== undefined && t.total !== undefined && t.mark === undefined && !t.dice?.fails && t.tag !== undefined) {
        assert.equal(t.result, t.total >= request.dc ? "pass" : "fail", `${at2}: 4, a total judged against the DC wrongly`);
      }
      if (t.dice) assert.equal(t.dice.total, t.total, `${at2}: 5, dice that are not the total`);
      if (t.total === undefined) assert.equal(t.dice, undefined, `${at2}: 5, dice with no total`);
      if (t.change && !pre) assert.deepEqual(t.change, targetIn(before.rolls[request.id], t)?.change, `${at2}: 8, an op made an ask`);
    }
  }

  // 12.
  const occurrences = Object.values(after.rolls).flatMap((q) => (q.ends ? [q.ends.occurrence] : []));
  assert.equal(new Set(occurrences).size, occurrences.length, `${at}: 12, two open requests share an occurrence`);

  // A close: 14 and 15.
  const closes = new Set<string>();
  if (op.t === "roll.close") {
    for (const id of new Set(op.rollIds)) {
      const request = before.rolls[id];
      if (!request) continue;
      if (!op.ifSettled || settledNow(request)) {
        closes.add(id);
        assert.equal(after.rolls[id], undefined, `${at}: 14, a closed request is still open`);
        if (request.targets.some((t) => t.change)) reached.askClosed = (reached.askClosed ?? 0) + 1;
      } else {
        assert.ok(after.rolls[id], `${at}: 15, Close all answered closed a request that waits or holds an ask`);
        reached.ifSettledSkip = (reached.ifSettledSkip ?? 0) + 1;
      }
    }
  }

  // 10: each save-ends request open before, closed only for a reason.
  for (const request of Object.values(before.rolls)) {
    if (!request.ends) continue;
    const c = refOf(request.targets[0]!);
    const effectBefore = effectById(before, c, request.ends.effect);
    const effectAfter = effectById(after, c, request.ends.effect);
    const still = after.rolls[request.id];
    if (still) {
      assert.ok(effectAfter, `${at}: 10, ${request.id} outlived its effect`);
      assert.ok(!effectAfter.due || effectAfter.due.id === request.ends.occurrence, `${at}: 10, ${request.id} outlived its occurrence`);
      assert.notEqual(resultOf(still.targets[0]!, still.dc), "pass", `${at}: 10, ${request.id} stayed open on a pass`);
      continue;
    }
    if (closes.has(request.id)) {
      reached.closedByDm = (reached.closedByDm ?? 0) + 1;
    } else if (!effectAfter) {
      assert.ok(effectBefore, `${at}: 10, ${request.id} was open without its effect`);
      const removal = op.t === "encounter.next" || (op.t === "actor.effect.remove" && op.effectId === effectBefore.id) || (op.t === "actor.effects" && (op.remove ?? []).some((x) => x.effectId === effectBefore.id));
      if (removal) reached.removalClose = (reached.removalClose ?? 0) + 1;
      else {
        const passed = log.findIndex((e) => e.data?.type === "roll" && nameOf(e.data as Creature) === nameOf(c) && e.data.result === "pass");
        const removed = log.findIndex((e) => e.data?.type === "effect" && e.data.action === "remove" && e.data.key === "frightened" && nameOf(e.data as Creature) === nameOf(c));
        assert.ok(passed >= 0 && removed > passed, `${at}: 10, ${request.id} closed and took its effect without a pass`);
        reached.passClose = (reached.passClose ?? 0) + 1;
      }
    } else {
      assert.ok(effectAfter.due && effectAfter.due.id !== request.ends.occurrence, `${at}: 10, ${request.id} closed for no reason`);
      reached.nextClose = (reached.nextClose ?? 0) + 1;
    }
  }

  // 11 and 13, creature by creature.
  for (const c of CREATURES) {
    const gone = actorOf(before, c).effects.filter((e) => e.key === "frightened" && !effectById(after, c, e.id));
    assert.equal(creatureLines(log, c), gone.length, `${at}: 11, ${nameOf(c)}'s effect went with ${creatureLines(log, c)} lines for ${gone.length}`);
    for (const effect of actorOf(before, c).effects) {
      const now = effectById(after, c, effect.id);
      const closing = Object.values(before.rolls).find((q) => closes.has(q.id) && nameOf(q.targets[0]!) === nameOf(c) && q.ends?.effect === effect.id && q.ends.occurrence === effect.due?.id);
      const owed = closing !== undefined && effect.due?.state === "pending";
      if (!now) continue;
      if (!owed) {
        assert.deepEqual(now.due, effect.due, `${at}: 13, ${effect.id}'s occurrence changed without its own close`);
        continue;
      }
      const settle = op.t === "roll.close" ? op.settle : undefined;
      const expected = settle ?? (answered(closing.targets[0]!) ? "resolved" : "dismissed");
      assert.deepEqual(now.due, { id: effect.due!.id, state: expected }, `${at}: 13, ${effect.id} settled wrongly`);
      if (settle) reached.settleGiven = (reached.settleGiven ?? 0) + 1;
      else reached.settleDerived = (reached.settleDerived ?? 0) + 1;
    }
  }
}

test(`${SEQUENCES} random sequences of answers, rolls, marks, asks, closes and effects keep every invariant`, () => {
  const reached: Reached = {};
  let applied = 0;
  for (let seed = 1; seed <= SEQUENCES; seed++) {
    const r = rng(seed);
    let state = world();
    const asksUsed = new Set<string>();
    for (let i = 0; i < STEPS; i++) {
      const at = `seed ${seed} step ${i}`;
      const step = nextStep(r, state, i);
      const before = step.pre ? step.pre(state) : state;
      const result = send(before, step.op, step.who, 10 + i, r);
      if (!result.ok) {
        const key = result.message === ALREADY_ASKED ? "alreadyAsked" : result.message === FINAL ? "finalRefused" : result.message === ANSWERED_MEANWHILE ? "answeredRefused" : result.message === SETTLED_MEANWHILE ? "staleChangeRefused" : "otherRefused";
        reached[key] = (reached[key] ?? 0) + 1;
        state = before;
        continue;
      }
      applied++;
      check(before, result.state, step, result.stored, result.log, asksUsed, reached, step.pre !== undefined, at);
      state = result.state;
    }
  }
  for (const path of ["passClose", "removalClose", "nextClose", "closedByDm", "ifSettledSkip", "settleGiven", "settleDerived", "changeRoll", "staleChangeRefused", "askClosed", "markKept", "fails", "typedBonus", "alreadyAsked", "finalRefused", "answeredRefused"]) {
    assert.ok((reached[path] ?? 0) > 0, `the run never reached ${path}: ${JSON.stringify(reached)}`);
  }
  assert.ok(applied > SEQUENCES * STEPS * 0.5, `most steps apply (${applied})`);
});
