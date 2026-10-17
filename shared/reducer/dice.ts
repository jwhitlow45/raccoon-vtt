import type { DiceRoll, LogEvent } from "../model.ts";
import { seenByNonOwners } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * Dice rolled on the server (docs/design-v1-dice.md 4.1 and 5.1). The room
 * actor resolves a dice op into `sys.dice`, holding every die it drew, and
 * this branch only copies those results into the state, so the reducer
 * reads no bonus, parses no formula and draws nothing, and replay rebuilds
 * the same lines from the stored op.
 */
export function sysDice(tx: Tx, op: OpOf<"sys.dice">): void {
  const asked = op.asked;
  switch (asked.t) {
    case "dice.roll":
      return diceLine(tx, op, asked);
  }
}

/** A free roll: one `dice` line with each roll's result, its label, its creature and its critical range. */
function diceLine(tx: Tx, op: OpOf<"sys.dice">, asked: Extract<OpOf<"sys.dice">["asked"], { t: "dice.roll" }>): void {
  if (op.results.length !== asked.rolls.length) throw invalid("each roll has one result");
  const rolls = asked.rolls.map((roll, i): DiceRoll => {
    const out: DiceRoll = { ...op.results[i]! };
    if (roll.label !== undefined) out.label = roll.label;
    const creature = roll.creature;
    if (creature && "tokenId" in creature) {
      const token = tx.token(creature.tokenId);
      out.tokenId = token.id;
      if (seenByNonOwners(tx.state, token, tx.env)) out.seen = true;
    } else if (creature) {
      out.characterId = tx.character(creature.characterId).id;
    }
    if (roll.critOn !== undefined) out.critOn = roll.critOn;
    return out;
  });
  const line: LogEvent = { type: "dice", tag: asked.tag, batch: op.batch, by: tx.actor.memberId, to: asked.to, rolls };
  if (asked.dc !== undefined) line.dc = asked.dc;
  if (asked.ac !== undefined) line.ac = asked.ac;
  tx.addEvent(line);
}
