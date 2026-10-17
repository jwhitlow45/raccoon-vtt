import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDiceOp } from "../dice/resolve.ts";
import { CANNOT_REROLL, LUCKY_CHANGES_NOTHING, rerollFace } from "../dice/roll.ts";
import type { Actor, Effect, LogEntry, RollChange, RollRequest, RollTarget, RollTest, RoomState, Viewer } from "../model.ts";
import { ANSWERED_MEANWHILE, ONLY_PLAYERS_ASK, SETTLED_MEANWHILE, TYPE_THE_TOTAL, canApply } from "../permissions.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { resultOf } from "../rules/rolls.ts";
import { DM, P1, P2, actor, chance, character, companionBlock, env, int, pick, rng, room, token } from "../testutil.ts";
import { ALREADY_ASKED, DIE_NEEDED, FINAL, ROLLED_ONLY, SEND_INSTEAD, TYPED_ONLY, isFinal } from "./rolls.ts";

/**
 * Randomized: a request's answers on the reducer (docs/design-v1-roll-request.md
 * 11.1, the reducer's bullet). A turn end's new occurrence is written into
 * the state directly, since doc 3's turn end comes later. Each sequence
 * mixes typed totals, fails without rolling, the DM's totals and marks,
 * rolls on the server (a player's, the DM's with and without `unanswered`,
 * with a typed bonus, with `fails`, with `change` naming the pending ask or
 * a stale one), players' asks of every reason on the answer they name or a
 * stale one, replaced, withdrawn and kept, the DM's Allow of "Fix my total"
 * and players' rolls and answers where it allowed one, reopens, closes of
 * any requests with and without `settle` and `ifSettled`, effect removals
 * by op and by expiry and new occurrences, on requests with no DC, a shown
 * DC, a hidden DC, and `ends`. Every op runs as the actor runs it,
 * permissions first, and refused ones are skipped.
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
 *  8. `change` never survives a new answer, a reopen or a close, and only
 *     a player's ask makes one.
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
 * 16. An Allow, Keep or Withdraw acts only on the pending ask it names, and
 *     only while it is pending on the answer it was made on: every pending
 *     ask names its target's current answer, a Keep or Withdraw ends that
 *     ask and changes nothing else, and an Allow of "Fix my total" needs
 *     its pending fix.
 * 17. A target with `retype` takes no player roll. Only an allowed fix sets
 *     it, on a target left waiting, and every new answer clears it.
 * 18. An ask lands only on the answer it names, as sent, and only when the
 *     Allow could apply it: a reroll, Lucky or a die on a rolled answer by
 *     the resolve's rules, "Fix my total" on a typed answer final for its
 *     player.
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

/** A target's answer alone, as `previous` must hold it: everything but whose it is, who gave it, the one before, an ask and `retype`. */
function answerPart(t: RollTarget): Record<string, unknown> {
  const { tokenId: _t, characterId: _c, by: _b, previous: _p, change: _a, retype: _r, ...rest } = t;
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
  const kinds = ["ask", "ask", "answer", "answer", "mark", "mark", "roll", "roll", "dmRoll", "dmRoll", "reopen", "close", "close", "remove", "stunned", "next", "occurrence", "readd", "playerAsk", "playerAsk", "playerAsk", "clear", "clear", "allowFix"] as const;
  // Targets where the DM allowed "Fix my total", which a player's roll and answer aim at often enough to reach.
  const retyped = open.flatMap((q) => q.targets.filter((t) => t.retype).map((t) => ({ q, t })));
  const aimed = retyped.length > 0 && chance(r, 0.5) ? pick(r, retyped) : undefined;
  const fixAsked = open.some((q) => q.targets.some((t) => t.change?.reason === "fix-total"));
  // Requests close often, so a table with none asks again more often than not. A pending fix and a reopened one each pass
  // within a few steps, so they draw the ops that act on them more often.
  const kind = open.length === 0 && chance(r, 0.7) ? "ask" : fixAsked && chance(r, 0.3) ? "allowFix" : aimed && chance(r, 0.4) ? pick(r, ["roll", "answer"] as const) : pick(r, kinds);
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
      const to = aimed ? refOf(aimed.t) : ref;
      return { op: { t: "roll.answer", rollId: aimed?.q.id ?? rollId, target: to, ...answer, tag: `a${n}` }, who: OWNER[nameOf(to)]! };
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
      if (!dm && aimed) return { op: { t: "roll.dice", tag: `d${n}`, rollId: aimed.q.id, target: refOf(aimed.t), bonus: 2 }, who };
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
      // A player's ask to change their answer. It names the answer's tag, and now and then a stale one, and comes now and
      // then from the DM or from a player who does not own the creature.
      const answeredNow = open.flatMap((q) => q.targets.filter((t) => t.tag !== undefined).map((t) => ({ q, t })));
      const asked = answeredNow.length > 0 ? pick(r, answeredNow) : undefined;
      const t = asked?.t;
      const reasons = t?.dice ? (["heroic-inspiration", "heroic-inspiration", "halfling-luck", "lucky", "bardic-inspiration", "fix-total"] as const) : (["fix-total", "fix-total", "fix-total", "lucky"] as const);
      const reason: RollChange["reason"] = pick(r, reasons);
      const reroll = reason === "heroic-inspiration" || reason === "halfling-luck";
      const face = reroll && chance(r, 0.4) ? { face: int(r, 0, t?.dice?.faces.length ?? 1) } : {};
      const die = reason === "bardic-inspiration" && chance(r, 0.9) ? { die: pick(r, [6, 8, 10, 12] as const) } : {};
      const on = t?.tag !== undefined && chance(r, 0.9) ? t.tag : `stale${n}`;
      const target = t ? refOf(t) : ref;
      const who = chance(r, 0.05) ? DM : chance(r, 0.05) ? (OWNER[nameOf(target)] === P1 ? P2 : P1) : OWNER[nameOf(target)]!;
      return { op: { t: "roll.change", rollId: asked?.q.id ?? rollId, target, ask: { id: `ask${n}`, on, reason, ...face, ...die } }, who };
    }
    case "clear": {
      // The player's Withdraw or the DM's Keep, mostly of the pending ask, sometimes of an older or unknown one.
      const pending = open.flatMap((q) => q.targets.filter((t) => t.change).map((t) => ({ q, t })));
      const named = pending.length > 0 && chance(r, 0.8) ? pick(r, pending) : undefined;
      const clear = named && chance(r, 0.85) ? named.t.change!.id : `ask${int(r, 0, n)}`;
      const target = named ? refOf(named.t) : ref;
      return { op: { t: "roll.change", rollId: named?.q.id ?? rollId, target, clear }, who: chance(r, 0.5) ? DM : OWNER[nameOf(target)]! };
    }
    case "allowFix": {
      // The DM's Allow of "Fix my total", mostly of a pending fix, sometimes of another ask or a stale id.
      const pending = open.flatMap((q) => q.targets.filter((t) => t.change).map((t) => ({ q, t })));
      const fixes = pending.filter((x) => x.t.change!.reason === "fix-total");
      const named = fixes.length > 0 && chance(r, 0.85) ? pick(r, fixes) : pending.length > 0 && chance(r, 0.5) ? pick(r, pending) : undefined;
      const change = named && chance(r, 0.85) ? named.t.change!.id : `stale${n}`;
      return { op: { t: "roll.reopen", rollId: named?.q.id ?? rollId, target: named ? refOf(named.t) : ref, change }, who: DM };
    }
  }
}

type Ran = { ok: true; state: RoomState; stored: Op; log: LogEntry[] } | { ok: false; code: string; message: string };

/** The words an ask is refused in when the Allow could not apply it (18). */
const UNFIT = new Set([ROLLED_ONLY, CANNOT_REROLL, LUCKY_CHANGES_NOTHING, DIE_NEEDED, TYPED_ONLY, SEND_INSTEAD]);

/** Which path a refusal reached, by its words and, for "settled meanwhile", by the op that met them. */
function refusalPath(op: Op, message: string): string {
  if (message === SETTLED_MEANWHILE) {
    if (op.t === "roll.change") return op.ask ? "askStale" : "clearStale";
    return op.t === "roll.reopen" ? "fixStale" : "staleChangeRefused";
  }
  if (UNFIT.has(message)) return "askUnfit";
  const named: Record<string, string> = { [ALREADY_ASKED]: "alreadyAsked", [FINAL]: "finalRefused", [ANSWERED_MEANWHILE]: "answeredRefused", [TYPE_THE_TOTAL]: "retypeRefused", [ONLY_PLAYERS_ASK]: "dmAskForbidden" };
  return named[message] ?? "otherRefused";
}

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
function check(before: RoomState, after: RoomState, step: Step, stored: Op, log: LogEntry[], asksUsed: Set<string>, reached: Reached, at: string): void {
  const op = step.op;
  const player = step.who.role === "player";
  const count = (path: string) => (reached[path] = (reached[path] ?? 0) + 1);

  // The op's own target: 1, 2, 3, 5, 6, 7 and 8.
  if (op.t === "roll.answer" || op.t === "roll.dice" || op.t === "roll.reopen") {
    const was = targetIn(before.rolls[op.rollId], op.target);
    assert.ok(was, `${at}: an op on a target that is not there applied`);
    const request = before.rolls[op.rollId]!;
    if (op.t === "roll.answer" && player) assert.ok(!isFinal(request, was), `${at}: 1, a player changed a final answer`);
    if (op.t === "roll.dice" && player) assert.ok(!answered(was), `${at}: 2, a player's roll replaced an answer`);
    if (op.t === "roll.dice" && player) assert.ok(!was.retype, `${at}: 17, a player rolled where the DM allowed a typed fix`);
    if (op.t === "roll.reopen" && op.change !== undefined) {
      const ask = was.change;
      assert.ok(ask?.id === op.change && ask.reason === "fix-total" && ask.on === was.tag, `${at}: 16, an Allow of a fixed total acted on an ask not pending`);
      count("fixAllowed");
    }
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
      if (op.t !== "roll.reopen") assert.equal(now.retype, undefined, `${at}: 17, a new answer kept retype`);
      if (op.t === "roll.reopen" && op.change !== undefined) assert.equal(now.retype, true, `${at}: 17, an allowed fix left no retype`);
      if (op.t !== "roll.reopen" && was.retype) count("retypeCleared");
    }
  }

  // An ask, a Withdraw or a Keep: 16 and 18.
  if (op.t === "roll.change") {
    const request = before.rolls[op.rollId]!;
    const was = targetIn(request, op.target)!;
    const now = targetIn(after.rolls[op.rollId], op.target)!;
    assert.ok(was && now, `${at}: a change on a target that is not there applied`);
    const { change: _was, ...wasRest } = was;
    const { change: _now, ...nowRest } = now;
    assert.deepEqual(nowRest, wasRest, `${at}: 16, an ask or its end changed more than the ask`);
    if (op.ask) {
      const ask = op.ask;
      assert.ok(player, `${at}: 18, the DM made an ask`);
      assert.equal(ask.on, was.tag, `${at}: 18, an ask landed on an answer it does not name`);
      assert.deepEqual(now.change, ask, `${at}: 18, an ask is not stored as sent`);
      const dice = was.dice;
      if (ask.reason === "fix-total") assert.ok(!dice && isFinal(request, was), `${at}: 18, Fix my total on a rolled answer or one the player may change`);
      else assert.ok(dice, `${at}: 18, a change of dice asked of a typed answer`);
      if (dice && ask.reason === "halfling-luck") assert.equal(dice.faces[ask.face ?? rerollFace(dice, ask.reason)!], 1, `${at}: 18, Halfling Luck on a die not showing 1`);
      if (dice && ask.reason === "lucky") assert.ok(dice.mode !== "adv" && !dice.cancelled, `${at}: 18, Lucky asked where it changes nothing`);
      if (ask.reason === "bardic-inspiration") assert.notEqual(ask.die, undefined, `${at}: 18, Bardic Inspiration with no die`);
      count(ask.reason === "fix-total" ? "fixAsked" : "askSent");
      if (was.change) count("askReplaced");
    } else {
      assert.equal(was.change?.id, op.clear, `${at}: 16, a Withdraw or Keep ended an ask it does not name`);
      assert.equal(now.change, undefined, `${at}: 16, a Withdraw or Keep left the ask`);
      count(player ? "withdraw" : "keep");
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
      const asked = op.t === "roll.change" && op.ask !== undefined && op.rollId === request.id && nameOf(op.target) === nameOf(t);
      if (t.change && !asked) assert.deepEqual(t.change, targetIn(before.rolls[request.id], t)?.change, `${at2}: 8, an op other than an ask made one`);
      if (t.change) assert.equal(t.change.on, t.tag, `${at2}: 16, an ask is pending on an answer it was not made on`);
      if (t.retype) {
        const fixedHere = op.t === "roll.reopen" && op.change !== undefined && op.rollId === request.id && nameOf(op.target) === nameOf(t);
        assert.ok(fixedHere || targetIn(before.rolls[request.id], t)?.retype, `${at2}: 17, retype set by something other than an allowed fix`);
        assert.ok(!answered(t), `${at2}: 17, retype on an answered target`);
      }
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
        const key = refusalPath(step.op, result.message);
        reached[key] = (reached[key] ?? 0) + 1;
        state = before;
        continue;
      }
      applied++;
      check(before, result.state, step, result.stored, result.log, asksUsed, reached, at);
      state = result.state;
    }
  }
  const paths = ["passClose", "removalClose", "nextClose", "closedByDm", "ifSettledSkip", "settleGiven", "settleDerived", "changeRoll", "staleChangeRefused", "askClosed", "markKept", "fails", "typedBonus", "alreadyAsked", "finalRefused", "answeredRefused"];
  const askPaths = ["askSent", "askReplaced", "fixAsked", "askStale", "askUnfit", "dmAskForbidden", "withdraw", "keep", "clearStale", "fixAllowed", "fixStale", "retypeRefused", "retypeCleared"];
  for (const path of [...paths, ...askPaths]) {
    assert.ok((reached[path] ?? 0) > 0, `the run never reached ${path}: ${JSON.stringify(reached)}`);
  }
  assert.ok(applied > SEQUENCES * STEPS * 0.5, `most steps apply (${applied})`);
});
