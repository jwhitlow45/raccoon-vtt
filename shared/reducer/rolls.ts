import { CANNOT_REROLL, LUCKY_CHANGES_NOTHING, rerollable, rerollFace, withDie, withLucky } from "../dice/roll.ts";
import { keys } from "../keys.ts";
import { answerProvenance } from "../migrate.ts";
import type { LogEvent, RollAnswer, RollChange, RollRequest, RollTarget } from "../model.ts";
import { SETTLED_MEANWHILE, fixPending } from "../permissions.ts";
import { anyPlayer, playersToken } from "../project.ts";
import type { ActorTarget, OpOf } from "../protocol.ts";
import { effectEvent } from "../rules/hp.ts";
import { resultOf } from "../rules/rolls.ts";
import { Refuse, gone, invalid, type Tx } from "./tx.ts";

/**
 * Roll requests (docs/design-v1-dm-tools.md 3.3). The DM asks for a saving
 * throw or an ability check, each target's player types the total they
 * rolled, and the reducer works out pass or fail from a DC. The app rolls
 * nothing. Closing a request removes it, and the log keeps the answers.
 */

/** The refusal of a target no player plays: the request goes to players, so only their creatures can be asked. */
export const NOT_PLAYED = "only creatures a player plays can be asked to roll";
/** The refusal of a player's change to an answer that is final (`isFinal`). */
export const FINAL = "Ask the DM to change it.";
/** The refusal of a "save ends" request that is not one save of one creature with its effect (docs/design-v1-roll-request.md 7.5). */
export const ENDS_NEEDS_ONE = "Ends needs one creature with that effect.";
/** The refusal of a second open request for one save occurrence, as from a second DM device. */
export const ALREADY_ASKED = "That save was already asked.";
/** The refusal of a reroll, Lucky or an added die asked on a typed answer, in the Allow's own words (dice/resolve.ts). */
export const ROLLED_ONLY = "Only a rolled answer can be changed this way.";
/** The refusal of a Bardic Inspiration ask with no die, in the Allow's own words (dice/resolve.ts). */
export const DIE_NEEDED = "Bardic Inspiration names its die.";
/** The refusal of "Fix my total" on a rolled answer, which a reroll or a die changes instead. */
export const TYPED_ONLY = "Only a typed answer can be fixed this way.";
/** The refusal of "Fix my total" on an answer the player may still change: they send the new total themselves. */
export const SEND_INSTEAD = "Send the corrected total.";
/** The refusal of a request for a save occurrence that is no longer pending: settled, or replaced by a newer turn end (docs/design-v1-roll-options.md 6.1). */
export const SAVE_SETTLED = "That save is no longer waiting.";

export function rollAsk(tx: Tx, op: OpOf<"roll.ask">): void {
  const input = op.request;
  if (tx.state.rolls[input.id]) throw invalid("roll request already exists");
  const playerScene = tx.state.meta.playerSceneId;
  for (const target of input.targets) {
    if ("tokenId" in target) {
      const token = tx.token(target.tokenId);
      if (token.sceneId !== playerScene) throw invalid("a token asked to roll must be on the players' scene");
      if (!playersToken(tx.state, token)) throw invalid(NOT_PLAYED);
    } else if (!anyPlayer(tx.state, tx.character(target.characterId).ownerIds)) {
      throw invalid(NOT_PLAYED);
    }
  }
  const request: RollRequest = {
    id: input.id,
    rev: 0,
    test: input.test,
    dcShown: input.dcShown,
    resultShown: input.resultShown,
    at: tx.env.at,
    targets: input.targets.map((t) => ("tokenId" in t ? { tokenId: t.tokenId } : { characterId: t.characterId })),
  };
  if (input.dc !== undefined) request.dc = input.dc;
  if (input.note !== undefined) request.note = input.note;
  if (input.spell) request.spell = true;
  if (input.cause !== undefined) request.cause = input.cause;
  if (input.ends !== undefined) {
    const ends = input.ends;
    const target = input.targets.length === 1 ? input.targets[0] : undefined;
    const oneSave = input.cause === "saveEnds" && input.test.kind === "save" && input.test.choices.length === 1;
    const holder = oneSave && target ? tx.tryResolveActor(target) : undefined;
    const effect = holder?.actor.effects.find((e) => e.id === ends.effect);
    if (!effect) throw invalid(ENDS_NEEDS_ONE);
    // Every request in the state is open, since a close removes it.
    if (Object.values(tx.state.rolls).some((r) => r.ends?.occurrence === ends.occurrence)) throw invalid(ALREADY_ASKED);
    if (effect.due?.id !== ends.occurrence || effect.due.state !== "pending") throw invalid(SAVE_SETTLED);
    request.ends = { effect: ends.effect, occurrence: ends.occurrence };
  }
  tx.write(keys.roll(request.id), request);
}

/**
 * Whether a target's answer is final for its player: on a request whose DC
 * players do not see while they see pass or fail, once the answer has a
 * result. Otherwise a player could change a total from 12 to 15 to 14 and
 * read the DC from the passes and fails. With the DC shown there is nothing
 * to find, and with pass or fail hidden there is nothing to read, so they
 * may change freely. Only the DM changes a final answer, or reopens it.
 *
 * A rolled answer is final whatever the switches (docs/design-v1-dice.md
 * 5.4): the server rolled it, so a typed total or a fail without rolling
 * after it would be a second answer. The DM allows a change in one tap.
 */
export function isFinal(request: Pick<RollRequest, "dc" | "dcShown" | "resultShown">, target: Pick<RollTarget, "result" | "dice">): boolean {
  if (target.dice !== undefined) return true;
  return request.dc !== undefined && !request.dcShown && request.resultShown && target.result !== undefined;
}

/**
 * A target's answer, or a DM's mark of one. A total comes with the choice
 * rolled (the first when the test has one), and with a DC the reducer sets
 * the result itself: the D20 Test succeeds when the total equals or exceeds
 * the DC (SRD 5.2.1 page 6). A save may be failed without rolling: a result
 * and no total, marked `noRoll` when the creature's player chose it, so
 * their devices know it is answered even when the result is hidden from
 * them.
 *
 * An answer that replaces another keeps the replaced one as `previous`, so
 * the DM's card can say "17, changed from 12". Its result is the new
 * answer's own, so on a request with no DC a replaced mark goes with the
 * total it belonged to, and a result the new answer supplies (a save failed
 * without rolling, or the DM's mark with a total) is kept. A DM's bare mark
 * on an answer only sets its result, to mark a roll with no DC or to
 * overrule one.
 */
export function rollAnswer(tx: Tx, op: OpOf<"roll.answer">): void {
  const request = tx.state.rolls[op.rollId];
  if (!request) throw gone("roll request");
  const index = request.targets.findIndex((t) => sameCreature(t, op.target));
  const current = request.targets[index];
  if (!current) throw gone("roll target");
  const twoChoices = request.test.choices.length > 1;
  if (op.choice !== undefined && (op.total === undefined || op.choice >= request.test.choices.length)) throw invalid("a choice comes with a total, and names one the test offers");
  const player = tx.actor.role === "player";
  if (player && isFinal(request, current)) throw new Refuse("forbidden", FINAL);
  // The server refuses a live answer without its tag (permissions.ts ANSWER_NEEDS_TAG), so an untagged one is an op
  // stored before op version 7, or a test's. Both keep the rule below, which they were written under, so stored ops
  // replay to the same state and the older reducer tests still test what they did.
  if (answerProvenance(tx.env.opVersion) && op.tag !== undefined) return taggedAnswer(tx, request, index, current, op, op.tag);
  const answered = current.total !== undefined || current.result !== undefined;
  let next: RollTarget;
  if (!player && op.total === undefined && answered) {
    next = { ...current, result: op.result!, by: tx.actor.memberId };
  } else {
    next = creatureOf(current);
    if (op.total !== undefined) {
      if (twoChoices) next.choice = op.choice ?? 0;
      next.total = op.total;
    }
    const result = op.result ?? (request.dc !== undefined && op.total !== undefined ? (op.total >= request.dc ? "pass" : "fail") : undefined);
    if (result !== undefined) next.result = result;
    // Only a player's own choice: a DM's bare fail is a mark, which stays the DM's when results are hidden.
    if (player && op.total === undefined && op.result === "fail") next.noRoll = true;
    next.by = tx.actor.memberId;
    // A reopened target keeps the answer the reopen cleared, so its next answer still reads as a change.
    const previous = answered ? answerOf(current) : current.previous;
    if (previous) next.previous = previous;
  }
  writeTarget(tx, request, index, next);
  const line: Extract<LogEvent, { type: "roll" }> = { type: "roll", test: request.test, ...creatureRef(next) };
  if (next.choice !== undefined) line.choice = next.choice;
  if (next.total !== undefined) line.total = next.total;
  if (next.result !== undefined) line.result = next.result;
  if (next.noRoll) line.noRoll = true;
  if (request.dc !== undefined) {
    line.dc = request.dc;
    if (request.dcShown) line.dcShown = true;
  }
  if (request.resultShown) line.resultShown = true;
  tx.addEvent(line);
}

/**
 * An answer with its provenance (docs/design-v1-roll-request.md 7.5): it
 * keeps the op's tag, and the DM's own mark is kept apart from what the DC
 * gives, so `resultOf` decides the result for every reader alike. A DM's
 * bare mark on an answer keeps the answer, its total and dice, and only
 * marks it. It takes the op's tag, so an ask made on the old tag is over and
 * goes. Anything else is a new answer, with no mark, no ask and no
 * `retype`. The line says whether a mark wrote it, so the projection never
 * guesses.
 */
function taggedAnswer(tx: Tx, request: RollRequest, index: number, current: RollTarget, op: OpOf<"roll.answer">, tag: string): void {
  const player = tx.actor.role === "player";
  const mark = player ? undefined : op.result;
  const answered = current.total !== undefined || current.result !== undefined;
  let next: RollTarget;
  if (mark !== undefined && op.total === undefined && answered) {
    const { change: _ask, retype: _retype, ...kept } = current;
    next = { ...kept, mark, tag, by: tx.actor.memberId };
  } else {
    next = creatureOf(current);
    if (op.total !== undefined) {
      if (request.test.choices.length > 1) next.choice = op.choice ?? 0;
      next.total = op.total;
    }
    if (mark !== undefined) next.mark = mark;
    if (player && op.total === undefined && op.result === "fail") next.noRoll = true;
    next.tag = tag;
    next.by = tx.actor.memberId;
    const previous = answered ? answerOf(current) : current.previous;
    if (previous) next.previous = previous;
  }
  const result = resultOf(next, request.dc);
  if (result === undefined) delete next.result;
  else next.result = result;
  writeTarget(tx, request, index, next);
  const line: Extract<LogEvent, { type: "roll" }> = { type: "roll", test: request.test, ...creatureRef(next) };
  if (next.choice !== undefined) line.choice = next.choice;
  if (next.total !== undefined) line.total = next.total;
  if (next.result !== undefined) line.result = next.result;
  if (next.noRoll) line.noRoll = true;
  if (request.dc !== undefined) {
    line.dc = request.dc;
    if (request.dcShown) line.dcShown = true;
  }
  if (request.resultShown) line.resultShown = true;
  line.tag = tag;
  if (mark !== undefined) line.mark = true;
  tx.addEvent(line);
}

/**
 * Clears a target's answer, kept as `previous`, so its player may answer
 * once more, and with it any ask and `retype`. A target with no answer is
 * left as it is. With `change`, the DM's Allow of a "Fix my total" ask
 * (docs/design-v1-roll-request.md 5.5), the ask must still be pending on
 * this answer, and the target then waits with `retype`, for a total typed
 * again and never a roll. No line: the corrected answer writes its own.
 */
export function rollReopen(tx: Tx, op: OpOf<"roll.reopen">): void {
  const request = tx.state.rolls[op.rollId];
  if (!request) throw gone("roll request");
  const index = request.targets.findIndex((t) => sameCreature(t, op.target));
  const current = request.targets[index];
  if (!current) throw gone("roll target");
  if (op.change !== undefined) {
    if (!fixPending(current, op.change)) throw invalid(SETTLED_MEANWHILE);
    writeTarget(tx, request, index, { ...creatureOf(current), previous: answerOf(current), retype: true });
    return;
  }
  if (current.total === undefined && current.result === undefined) return;
  writeTarget(tx, request, index, { ...creatureOf(current), previous: answerOf(current) });
}

/**
 * A player's ask to change their answer, or its end
 * (docs/design-v1-roll-request.md 5.5 and 7.5). An ask names the answer it
 * would change by its tag, so one made on an answer since replaced, marked
 * or reopened is over before it lands. It replaces any pending ask. `clear`,
 * the player's Withdraw or the DM's Keep, ends only the pending ask it
 * names, so a stale one ends nothing. Neither writes a line: an ask is
 * between the player and the DM, and an allowed change writes its own.
 */
export function rollChange(tx: Tx, op: OpOf<"roll.change">): void {
  const request = tx.state.rolls[op.rollId];
  if (!request) throw gone("roll request");
  const index = request.targets.findIndex((t) => sameCreature(t, op.target));
  const current = request.targets[index];
  if (!current) throw gone("roll target");
  const ask = op.ask;
  if (ask === undefined) {
    if (op.clear === undefined || current.change?.id !== op.clear) throw invalid(SETTLED_MEANWHILE);
    const { change: _cleared, ...rest } = current;
    writeTarget(tx, request, index, rest);
    return;
  }
  if (current.tag === undefined || ask.on !== current.tag) throw invalid(SETTLED_MEANWHILE);
  const refusal = changeRefusal(request, current, ask);
  if (refusal !== undefined) throw invalid(refusal);
  const change: RollChange = { id: ask.id, on: ask.on, reason: ask.reason };
  if (ask.face !== undefined) change.face = ask.face;
  if (ask.die !== undefined) change.die = ask.die;
  writeTarget(tx, request, index, { ...current, change });
}

/**
 * Why the DM's Allow could not apply this ask to the target's answer, or
 * undefined when it could, so no ask waits on the DM only to be refused at
 * the Allow. A reroll, Lucky or an added die needs a rolled answer and is
 * judged by the rules the Allow's resolve runs (dice/resolve.ts), never a
 * copy of them. "Fix my total" needs a typed answer that is final for its
 * player, since one that is not they correct by sending it again.
 */
export function changeRefusal(request: Pick<RollRequest, "dc" | "dcShown" | "resultShown">, target: Pick<RollTarget, "result" | "dice">, ask: Pick<RollChange, "reason" | "face" | "die">): string | undefined {
  const dice = target.dice;
  if (ask.reason === "fix-total") {
    if (dice) return TYPED_ONLY;
    return isFinal(request, target) ? undefined : SEND_INSTEAD;
  }
  if (!dice) return ROLLED_ONLY;
  switch (ask.reason) {
    case "heroic-inspiration":
    case "halfling-luck": {
      const face = ask.face ?? rerollFace(dice, ask.reason);
      return face !== null && rerollable(dice, ask.reason, face) ? undefined : CANNOT_REROLL;
    }
    // Lucky and an added die refuse by the stored faces' shape alone, never by what is drawn, so a dry run answers as the Allow will.
    case "lucky":
      return withLucky(dice, () => 1).ok ? undefined : LUCKY_CHANGES_NOTHING;
    case "bardic-inspiration": {
      if (ask.die === undefined) return DIE_NEEDED;
      const added = withDie(dice, ask.die, () => 1);
      return added.ok ? undefined : added.error;
    }
  }
}

/**
 * Closes requests, "Close all answered" several at once. One already
 * closed, by another DM device, is passed over. Each close settles its
 * request in the same op (docs/design-v1-roll-request.md 1.1), so no
 * gesture is left half done. A pending ask goes with the request, kept as
 * it stands, since nothing acts on it again. A "save ends" request settles
 * its own occurrence (`settleOccurrence`).
 *
 * With `ifSettled` the op is "Close all answered", and the server checks
 * each request as the op runs, not as the DM tapped: one still waiting on a
 * target, or holding an ask, stays open, so an ask or a reopen that lands
 * after the tap is never settled unseen. Stored closes carry neither field
 * and no stored request has `ends`, so they replay as they applied.
 */
export function rollClose(tx: Tx, op: OpOf<"roll.close">): void {
  for (const id of new Set(op.rollIds)) {
    const request = tx.state.rolls[id];
    if (!request) continue;
    if (op.ifSettled && !request.targets.every((t) => isAnswered(t) && t.change === undefined)) continue;
    if (request.ends) settleOccurrence(tx, request, op.settle);
    tx.remove(keys.roll(id));
  }
}

/**
 * A closing "save ends" request's occurrence (docs/design-v1-roll-options.md
 * 6.1), settled as the op names, doc 3's Accept failure or Dismiss, else
 * resolved when its creature answered and dismissed when it did not. Only
 * its own occurrence and only while pending: a newer occurrence, one
 * settled already or an effect that is gone is left as it is.
 */
function settleOccurrence(tx: Tx, request: RollRequest, settle: "resolved" | "dismissed" | undefined): void {
  const ends = request.ends;
  const target = request.targets[0];
  if (!ends || !target) return;
  const holder = tx.tryResolveActor(creatureRef(target));
  if (!holder) return;
  const effects = holder.actor.effects;
  const index = effects.findIndex((e) => e.id === ends.effect);
  const effect = effects[index];
  if (!effect?.due || effect.due.id !== ends.occurrence || effect.due.state !== "pending") return;
  const next = [...effects];
  next[index] = { ...effect, due: { id: effect.due.id, state: settle ?? (isAnswered(target) ? "resolved" : "dismissed") } };
  tx.putActor(holder, { ...holder.actor, effects: next });
}

/** The refusal of Accept failure or Dismiss on a save a request was sent for: closing the request settles it. */
export const SAVE_ASKED = "That save was asked. Close its request instead.";

/**
 * The DM's Accept failure or Dismiss on a save-ends card with no request
 * (docs/design-v1-roll-options.md 6.1). Only the effect's pending
 * occurrence that the card named, so a tap on a card a newer turn end
 * replaced, or one another DM device settled first, changes nothing. A
 * linked request's occurrence is settled only by closing that request.
 */
export function actorSaveDue(tx: Tx, op: OpOf<"actor.saveDue">): void {
  const resolved = tx.resolveActor(op.target);
  const index = resolved.actor.effects.findIndex((e) => e.id === op.effectId);
  const effect = resolved.actor.effects[index];
  if (!effect) throw gone("effect");
  if (effect.due?.id !== op.due || effect.due.state !== "pending") throw invalid(SAVE_SETTLED);
  if (Object.values(tx.state.rolls).some((r) => r.ends?.occurrence === op.due)) throw invalid(SAVE_ASKED);
  const effects = [...resolved.actor.effects];
  effects[index] = { ...effect, due: { id: op.due, state: op.state } };
  tx.putActor(resolved, { ...resolved.actor, effects });
}

/**
 * The life of a "save ends" request (docs/design-v1-roll-request.md 7.5,
 * "When an ends request closes"), as one rule after every op rather than a
 * call in every path that answers a target or removes an effect: an answer
 * typed, rolled, marked or allowed after an ask, a removal by
 * `actor.effect.remove`, `actor.effects` or an expiry, and a turn end that
 * writes the next occurrence. A pass removes the effect if it is still
 * there, with the line `actor.effect.remove` writes, after the answer's own
 * line, and closes the request. A request whose effect is gone, or whose
 * effect's occurrence is another one or none, closes. A fail leaves it open, so the
 * answer can still be asked about or fixed. Requests go in id order, so the
 * lines come out the same on replay, and no stored request has `ends`, so
 * replay is unchanged.
 *
 * A creature that does not resolve is skipped. A DM's view holds the
 * tokens of one scene only, and the client's store replays pending ops
 * through this reducer, so a token missing from that view must not close
 * anything there.
 */
export function endSaves(tx: Tx): void {
  const open: RollRequest[] = [];
  // Loading migrates every state to one with requests, but a replay test may hand the reducer a state from before them.
  for (const request of Object.values(tx.state.rolls ?? {})) if (request.ends) open.push(request);
  if (open.length === 0) return;
  open.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const request of open) {
    const ends = request.ends!;
    const target = request.targets[0];
    const holder = target ? tx.tryResolveActor(creatureRef(target)) : undefined;
    if (!target || !holder) continue;
    const effect = holder.actor.effects.find((e) => e.id === ends.effect);
    if (resultOf(target, request.dc) === "pass") {
      if (effect) {
        tx.putActor(holder, { ...holder.actor, effects: holder.actor.effects.filter((e) => e.id !== ends.effect) });
        tx.addActorEvents(holder, [effectEvent(effect, "remove")]);
      }
      tx.remove(keys.roll(request.id));
    } else if (!effect || effect.due?.id !== ends.occurrence) {
      // The effect is gone, or its occurrence is: a newer turn end, a save the DM took off, or a Previous that took the turn end back.
      tx.remove(keys.roll(request.id));
    }
  }
}

function isAnswered(target: RollTarget): boolean {
  return target.total !== undefined || target.result !== undefined;
}

export function writeTarget(tx: Tx, request: RollRequest, index: number, target: RollTarget): void {
  const targets = request.targets.map((t, i) => (i === index ? target : t));
  tx.write(keys.roll(request.id), { ...request, targets });
}

export function sameCreature(target: RollTarget, ref: ActorTarget): boolean {
  return "tokenId" in ref ? target.tokenId === ref.tokenId : target.characterId === ref.characterId;
}

/** The creature a target names, as a line names it. */
export function creatureRef(target: RollTarget): { tokenId: string } | { characterId: string } {
  return target.tokenId !== undefined ? { tokenId: target.tokenId } : { characterId: target.characterId! };
}

export function creatureOf(target: RollTarget): RollTarget {
  return target.tokenId !== undefined ? { tokenId: target.tokenId } : { characterId: target.characterId! };
}

/** A target's answer alone, kept as `previous` when a later one replaces it, its dice and provenance with it. */
export function answerOf(target: RollTarget): RollAnswer {
  const out: RollAnswer = {};
  if (target.choice !== undefined) out.choice = target.choice;
  if (target.total !== undefined) out.total = target.total;
  if (target.result !== undefined) out.result = target.result;
  if (target.noRoll) out.noRoll = true;
  if (target.tag !== undefined) out.tag = target.tag;
  if (target.dice !== undefined) out.dice = target.dice;
  if (target.typedBonus) out.typedBonus = true;
  if (target.mark !== undefined) out.mark = target.mark;
  if (target.changed !== undefined) out.changed = target.changed;
  return out;
}
