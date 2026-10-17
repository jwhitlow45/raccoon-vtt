import type { RoomState } from "../model.ts";
import type { OpOf, RefusalCode } from "../protocol.ts";
import { parseFormula } from "./formula.ts";
import { rollFormula, type Draw } from "./roll.ts";

/**
 * The resolve (docs/design-v1-dice.md 4.2 step 4): a dice op the actor has
 * admitted and permitted, turned into the `sys.dice` it stores in its place,
 * holding every die drawn. It runs once, on the server, before the reducer,
 * as an undo is built into `sys.restore`, so replay never rolls. It is
 * pure apart from `draw`, so the dev fixture's local server resolves with it
 * too. The server's entry, with its secure draw and the batch id, is
 * server/rooms/dice.ts.
 */
export type DiceOp = OpOf<"dice.roll">;

export type Resolved = { ok: true; op: OpOf<"sys.dice"> } | { ok: false; code: RefusalCode; message: string };

export type ResolveDeps = {
  draw: Draw;
  /** The op's batch id, the same for every batch of its tag (5.1). */
  batch: string;
};

export function resolveDiceOp(op: DiceOp, _state: RoomState, deps: ResolveDeps): Resolved {
  const results: OpOf<"sys.dice">["results"] = [];
  for (const roll of op.rolls) {
    const parsed = parseFormula(roll.formula);
    if (!parsed.ok) return { ok: false, code: "invalid", message: parsed.error };
    const rolled = rollFormula(parsed.formula, deps.draw, roll.mode);
    if (!rolled.ok) return { ok: false, code: "invalid", message: rolled.error };
    results.push(roll.cancelled ? { ...rolled.result, cancelled: true } : rolled.result);
  }
  return { ok: true, op: { t: "sys.dice", asked: op, batch: deps.batch, results } };
}
