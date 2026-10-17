import { keys } from "../keys.ts";
import type { LogEvent, RollAnswer, RollRequest, RollTarget } from "../model.ts";
import { anyPlayer, playersToken } from "../project.ts";
import type { ActorTarget, OpOf } from "../protocol.ts";
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

/** Clears a target's answer, kept as `previous`, so its player may answer once more. A target with no answer is left as it is. */
export function rollReopen(tx: Tx, op: OpOf<"roll.reopen">): void {
  const request = tx.state.rolls[op.rollId];
  if (!request) throw gone("roll request");
  const index = request.targets.findIndex((t) => sameCreature(t, op.target));
  const current = request.targets[index];
  if (!current) throw gone("roll target");
  if (current.total === undefined && current.result === undefined) return;
  writeTarget(tx, request, index, { ...creatureOf(current), previous: answerOf(current) });
}

/** Closes requests, "Close all answered" several at once. One already closed, by another DM device, is passed over. */
export function rollClose(tx: Tx, op: OpOf<"roll.close">): void {
  for (const id of new Set(op.rollIds)) if (tx.state.rolls[id]) tx.remove(keys.roll(id));
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
