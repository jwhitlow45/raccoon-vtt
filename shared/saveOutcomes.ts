import type { RoomState } from "./model.ts";
import { SAVE_OUTCOME_OP_VERSION, SAVE_OUTCOME_RETENTION_MS, type SaveOutcomeRecord } from "./saveOutcomeContract.ts";

/** Replay uses the stored version even after the payload's identity migration. */
export function tracksSaveOutcomes(opVersion?: number): boolean {
  return opVersion === undefined || opVersion >= SAVE_OUTCOME_OP_VERSION;
}

/** An expired record cannot reopen a page even before the next Apply prunes it. */
export function retainedSaveOutcome(state: RoomState, id: string, at: string): SaveOutcomeRecord | undefined {
  const record = state.saveOutcomes?.[id];
  if (!record) return undefined;
  const first = Date.parse(record.firstAppliedAt);
  const now = Date.parse(at);
  return Number.isFinite(first) && Number.isFinite(now) && now - first < SAVE_OUTCOME_RETENTION_MS ? record : undefined;
}
