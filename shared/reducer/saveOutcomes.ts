import { keys } from "../keys.ts";
import { serializedBytes } from "../limits.ts";
import { MAX_OP_AGE_MS } from "../pendingOps.ts";
import type { OpOf } from "../protocol.ts";
import {
  SAVE_CLOCK_AHEAD,
  SAVE_OUTCOME_CLOCK_LEAD_MS,
  SAVE_OUTCOME_LEDGER_BYTES,
  SAVE_OUTCOME_RECORDS,
  saveOutcomeLedgerSchema,
  saveOutcomePageSchema,
  saveOutcomeRecordSchema,
  saveOutcomeTransitionSchema,
  type SaveOutcomeRecord,
} from "../saveOutcomeContract.ts";
import { retainedSaveOutcome, tracksSaveOutcomes } from "../saveOutcomes.ts";
import { invalid, Refuse, type Tx } from "./tx.ts";

const UNAVAILABLE = "This save's outcome cannot be checked. Start a new group save to continue.";
const CHANGED = "This save's outcome changed. Check the save before trying again.";

function checkedRecord(record: SaveOutcomeRecord): SaveOutcomeRecord {
  if (!saveOutcomeRecordSchema.safeParse(record).success) throw invalid("the save outcome record is invalid or too large");
  return record;
}

/** Admission runs before cast, trap, recharge or target writes. */
export function prepareSaveOutcome(tx: Tx, op: OpOf<"actor.outcome">): SaveOutcomeRecord | undefined {
  if (!tracksSaveOutcomes(tx.env.opVersion) || op.page === undefined) return undefined;
  if (tx.actor.role !== "dm") throw new Refuse("forbidden", "only the DM can track a save outcome");
  if (!saveOutcomePageSchema.safeParse(op.page).success) throw invalid("the save outcome identity is invalid");
  const { id, expectRevision } = op.page;
  const current = tx.state.saveOutcomes?.[id];
  if (current) {
    if (!retainedSaveOutcome(tx.state, id, tx.env.at)) throw invalid(UNAVAILABLE);
    if (current.memberId !== tx.actor.memberId || current.revision !== expectRevision || current.state !== "undone" || current.plan === op.plan) throw invalid(CHANGED);
  } else {
    if (expectRevision !== 0 || op.plan !== id) throw invalid(UNAVAILABLE);
    const created = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    const age = Date.parse(tx.env.at) - created;
    if (!Number.isFinite(age) || age > MAX_OP_AGE_MS) throw invalid(UNAVAILABLE);
    // The id is minted from the sender's reckoning of the server's time, so only a clock far ahead lands here.
    if (age < -SAVE_OUTCOME_CLOCK_LEAD_MS) throw invalid(SAVE_CLOCK_AHEAD);
  }
  return checkedRecord({
    memberId: tx.actor.memberId,
    plan: op.plan,
    revision: (current?.revision ?? 0) + 1,
    state: "applied",
    firstAppliedAt: current?.firstAppliedAt ?? tx.env.at,
    seq: tx.env.seq,
  });
}

/** A lifecycle transition is guarded separately from all entity inverses. */
export function prepareSaveOutcomeRestore(tx: Tx, op: OpOf<"sys.restore">): SaveOutcomeRecord | undefined {
  if (!tracksSaveOutcomes(tx.env.opVersion)) return undefined;
  const transition = op.saveOutcome;
  if (transition === undefined) {
    if (op.entries.length === 0) throw invalid("an empty restore needs a valid save outcome transition");
    return undefined;
  }
  if (tx.actor.role !== "dm") throw new Refuse("forbidden", "only the DM can restore a save outcome");
  if (!saveOutcomeTransitionSchema.safeParse(transition).success) throw invalid("the save outcome transition is invalid");
  const current = retainedSaveOutcome(tx.state, transition.id, tx.env.at);
  if (!current) throw invalid(UNAVAILABLE);
  const destination = op.from === "undo" ? "undone" : "applied";
  if (transition.state !== destination || current.state === destination || current.memberId !== tx.actor.memberId || current.plan !== transition.plan || current.revision !== transition.expectRevision || op.undid !== undefined || (op.scope !== undefined && op.scope !== "play")) throw invalid(CHANGED);
  return checkedRecord({ ...current, revision: current.revision + 1, state: destination, seq: tx.env.seq });
}

/**
 * A DM's Undo or Redo that restores no lifecycle prunes the records retention
 * has ended, as bookkeeping, so a record past its day never keeps a status
 * that the restore just made untrue.
 */
export function pruneSaveOutcomes(tx: Tx): void {
  if (!tracksSaveOutcomes(tx.env.opVersion) || tx.actor.role !== "dm") return;
  for (const key of Object.keys(tx.state.saveOutcomes ?? {})) if (!retainedSaveOutcome(tx.state, key, tx.env.at)) tx.writeBookkeeping(keys.saveOutcome(key), null);
}

/** Capacity changes share the outcome's transaction, so a later refusal evicts nothing. */
export function writeSaveOutcome(tx: Tx, id: string, record: SaveOutcomeRecord): void {
  const ledger = { ...tx.state.saveOutcomes };
  for (const key of Object.keys(ledger)) if (!retainedSaveOutcome(tx.state, key, tx.env.at)) delete ledger[key];
  ledger[id] = record;
  const oldest = Object.keys(ledger).filter((key) => key !== id).sort((a, b) => {
    const age = Date.parse(ledger[a]!.firstAppliedAt) - Date.parse(ledger[b]!.firstAppliedAt);
    return age || (a < b ? -1 : a > b ? 1 : 0);
  });
  let count = Object.keys(ledger).length;
  let next = 0;
  while (count > SAVE_OUTCOME_RECORDS || serializedBytes(ledger) > SAVE_OUTCOME_LEDGER_BYTES) {
    const evicted = oldest[next++];
    if (evicted === undefined) throw invalid("the save outcome ledger is too large");
    delete ledger[evicted];
    count--;
  }
  if (!saveOutcomeLedgerSchema.safeParse(ledger).success) throw invalid("the save outcome ledger is invalid");
  for (const key of Object.keys(tx.state.saveOutcomes ?? {})) if (ledger[key] === undefined) tx.writeBookkeeping(keys.saveOutcome(key), null);
  tx.writeBookkeeping(keys.saveOutcome(id), record);
}
