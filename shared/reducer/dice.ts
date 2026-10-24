import { naturalOf } from "../dice/roll.ts";
import { startsSecret } from "../dice/secret.ts";
import { healRevivesDead } from "../migrate.ts";
import type { DiceRoll, LogEvent } from "../model.ts";
import { ANSWERED_MEANWHILE, SETTLED_MEANWHILE } from "../permissions.ts";
import { initiativeHidden, seenByNonOwners } from "../project.ts";
import type { ActorTarget, OpOf } from "../protocol.ts";
import { applyDeathSaves, applyHeal } from "../rules/hp.ts";
import { resultOf } from "../rules/rolls.ts";
import { hpRevertOf } from "./hpUndo.ts";
import { answerOf, creatureOf, creatureRef, sameCreature, writeTarget } from "./rolls.ts";
import { gone, invalid, type Tx } from "./tx.ts";
import { checkPrompt, markOf, rechargeLabel, withSettled, withUses } from "./uses.ts";

/**
 * Dice rolled on the server (docs/design-v1-dice.md 4.1 and 5.1). The room
 * actor resolves a dice op into `sys.dice`, holding every die it drew, and
 * these branches only copy those results into the state, so the reducer
 * reads no bonus, parses no formula and draws nothing, and replay rebuilds
 * the same state from the stored op. A roll whose result an op applies, a
 * request's answer or a death save, is a branch here, never a second op.
 */
type Sys = OpOf<"sys.dice">;
type Asked<T extends Sys["asked"]["t"]> = Extract<Sys["asked"], { t: T }>;

export function sysDice(tx: Tx, op: Sys): void {
  const asked = op.asked;
  switch (asked.t) {
    case "dice.roll":
      return diceLine(tx, op, asked);
    case "roll.dice":
      return rolledAnswer(tx, op, asked);
    case "actor.deathRoll":
      return deathRoll(tx, op, asked);
    case "actor.rechargeRoll":
      return rechargeRoll(tx, op, asked);
  }
}

/** One roll's creature on its line: a token with its `seen` mark, as other token events carry it, or a character. */
function rollCreature(tx: Tx, creature: ActorTarget): Pick<DiceRoll, "tokenId" | "characterId" | "seen"> {
  if ("characterId" in creature) return { characterId: tx.character(creature.characterId).id };
  const token = tx.token(creature.tokenId);
  return seenByNonOwners(tx.state, token, tx.env) ? { tokenId: token.id, seen: true } : { tokenId: token.id };
}

/**
 * A free roll: one `dice` line with each roll's result, its label, its
 * creature, its critical range and a creature's save, and a creature's
 * initiative marked as the DM's while players may not know its place in
 * the order.
 */
function diceLine(tx: Tx, op: Sys, asked: Asked<"dice.roll">): void {
  if (op.results.length !== asked.rolls.length) throw invalid("each roll has one result");
  const rolls = asked.rolls.map((roll, i): DiceRoll => {
    const out: DiceRoll = { ...op.results[i]! };
    if (roll.label !== undefined) out.label = roll.label;
    if (roll.creature) Object.assign(out, rollCreature(tx, roll.creature));
    if (roll.critOn !== undefined) out.critOn = roll.critOn;
    if (roll.initiative && roll.creature) {
      out.initiative = true;
      if (initiativeHidden(tx.state, roll.creature)) out.hidden = true;
    }
    if (roll.save !== undefined && roll.creature) out.save = roll.save;
    // A damage roll's type as its roller asked it, which an HP entry filled from the roll sends on (docs/design-v1-combat-controls.md 3.4).
    if (roll.type !== undefined) out.type = roll.type;
    return out;
  });
  const line: Extract<LogEvent, { type: "dice" }> = { type: "dice", tag: asked.tag, batch: op.batch, by: tx.actor.memberId, to: asked.to, rolls };
  if (asked.part !== undefined) line.part = asked.part;
  if (asked.dc !== undefined) line.dc = asked.dc;
  if (asked.ac !== undefined) line.ac = asked.ac;
  tx.addEvent(line);
}

/**
 * A request's answer rolled on the server (5.1): the result's total and the
 * choice, the dice kept on the target and its line, and the result by
 * `resultOf`, so a condition that fails the save records Fail with the
 * total kept. With `change`, the DM's Allow, the new answer keeps the ask as
 * `changed`, the pending ask clears, and `previous` keeps the old answer.
 */
function rolledAnswer(tx: Tx, op: Sys, asked: Asked<"roll.dice">): void {
  const request = tx.state.rolls[asked.rollId];
  if (!request) throw gone("roll request");
  const index = request.targets.findIndex((t) => sameCreature(t, asked.target));
  const current = request.targets[index];
  if (!current) throw gone("roll target");
  const result = op.results[0];
  if (!result || op.results.length !== 1) throw invalid("an answer rolls once");
  const answered = current.total !== undefined || current.result !== undefined;
  const next = creatureOf(current);
  if (asked.change !== undefined) {
    const ask = current.change;
    if (!ask || ask.id !== asked.change || ask.on !== current.tag || !current.dice) throw invalid(SETTLED_MEANWHILE);
    if (current.choice !== undefined) next.choice = current.choice;
    next.changed = ask;
    next.previous = answerOf(current);
  } else {
    if ((tx.actor.role === "player" || asked.unanswered) && answered) throw invalid(ANSWERED_MEANWHILE);
    if (request.test.choices.length > 1) next.choice = asked.choice ?? 0;
    // A reopened target keeps the answer the reopen cleared, so its next answer still reads as a change.
    const previous = answered ? answerOf(current) : current.previous;
    if (previous) next.previous = previous;
  }
  next.total = result.total;
  next.dice = result;
  if (op.typedBonus) next.typedBonus = true;
  next.tag = asked.tag;
  next.by = tx.actor.memberId;
  const verdict = resultOf(next, request.dc);
  if (verdict !== undefined) next.result = verdict;
  writeTarget(tx, request, index, next);
  const line: Extract<LogEvent, { type: "roll" }> = { type: "roll", test: request.test, ...creatureRef(next) };
  if (next.choice !== undefined) line.choice = next.choice;
  line.total = result.total;
  if (next.result !== undefined) line.result = next.result;
  if (request.dc !== undefined) {
    line.dc = request.dc;
    if (request.dcShown) line.dcShown = true;
  }
  if (request.resultShown) line.resultShown = true;
  line.dice = result;
  if (next.typedBonus) line.typedBonus = true;
  line.tag = asked.tag;
  if (next.changed) line.changed = next.changed;
  tx.addEvent(line);
}

/**
 * A death save rolled on the server (docs/design-v1-roll-options.md 4.3):
 * its `dice` line, then the save counted from the creature as it stands
 * now, so no later write can overwrite newer counts. 10 or more is a
 * success and less a failure, a natural 1 two failures, and a natural 20
 * regains 1 HP (SRD 5.2.1). A creature no longer dying gets the line and no
 * change. A DM's roll for a monster is secret, and every other roll open,
 * as a roll's Secret starts (docs/design-v1-dice.md 17).
 */
function deathRoll(tx: Tx, op: Sys, asked: Asked<"actor.deathRoll">): void {
  const result = op.results[0];
  if (!result || op.results.length !== 1) throw invalid("a death save rolls once");
  const resolved = tx.resolveActor(asked.target);
  // A roll of an open death save settles it, from whichever surface (docs/design-v1-combat-controls.md 2.3).
  if (asked.record !== undefined) checkPrompt(tx, resolved, asked.record, "deathSave");
  const roll: DiceRoll = { ...result, label: "Death save", ...rollCreature(tx, asked.target) };
  const to = startsSecret(tx.state, tx.actor.role === "dm", [asked.target]) ? "dm" : "all";
  tx.addEvent({ type: "dice", tag: asked.tag, batch: op.batch, by: tx.actor.memberId, to, rolls: [roll] });
  const actor = resolved.actor;
  if (actor.life !== "dying") return;
  const natural = naturalOf(result);
  const success = natural !== 1 && result.total >= 10;
  const settled = (next: typeof actor) =>
    asked.record === undefined ? next : withSettled(next, "deathSave", { state: "done", total: result.total, outcome: natural === 20 ? "regain" : natural === 1 ? "twoFailures" : success ? "success" : "failure" });
  if (natural === 20) {
    const healed = applyHeal(actor, 1, healRevivesDead(tx.state.meta.settings, tx.env.opVersion));
    if (healed.actor === actor) return;
    tx.putActor(resolved, settled(healed.actor));
    const left = { ...healed.actor.hp };
    const revert = hpRevertOf(actor, healed.actor, tx.state.encounter?.entries ?? []);
    tx.addActorEvents(resolved, healed.events.map((e) => (e.type === "hp" ? { ...e, left, revert } : e)));
    return;
  }
  const counted = applyDeathSaves(actor, Math.min(3, actor.deathSaves.ok + (success ? 1 : 0)), Math.min(3, actor.deathSaves.fail + (success ? 0 : natural === 1 ? 2 : 1)));
  tx.putActor(resolved, settled(counted.actor));
  tx.addActorEvents(resolved, counted.events);
}

/**
 * A recharge roll on the server (docs/design-v1-combat-controls.md 3.1):
 * one `dice` line, "Fire Breath recharge", secret for the DM's monster as a
 * roll's Secret starts. `min` or more makes the ability ready, its mark
 * gone. With `record` it settles that turn's prompt for the key with its
 * total, so two devices rolling at once count one roll.
 */
function rechargeRoll(tx: Tx, op: Sys, asked: Asked<"actor.rechargeRoll">): void {
  const result = op.results[0];
  if (!result || op.results.length !== 1) throw invalid("a recharge rolls once");
  const resolved = tx.resolveActor(asked.target);
  const due = `recharge:${asked.key}` as const;
  if (asked.record !== undefined) checkPrompt(tx, resolved, asked.record, due);
  const roll: DiceRoll = { ...result, label: rechargeLabel(asked.name), ...rollCreature(tx, asked.target) };
  const to = startsSecret(tx.state, tx.actor.role === "dm", [asked.target]) ? "dm" : "all";
  tx.addEvent({ type: "dice", tag: asked.tag, batch: op.batch, by: tx.actor.memberId, to, rolls: [roll] });
  const actor = resolved.actor;
  const ready = result.total >= asked.min;
  let next = actor;
  if (ready && markOf(actor, asked.key)?.kind === "recharge") {
    const uses = { ...actor.uses };
    delete uses[asked.key];
    next = withUses(actor, uses);
  }
  if (asked.record !== undefined) next = withSettled(next, due, { state: "done", total: result.total, outcome: ready ? "ready" : "used" });
  if (next !== actor) tx.putActor(resolved, next);
}
