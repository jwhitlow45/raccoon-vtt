import { checkLimits } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";

/**
 * Whether DM key is held off because the journal is full (phase 2, 4.1 row
 * 9, D-261107-270). True only when the live room passes the shared limits
 * without the key page and fails them with it, so another cap the room is
 * already over never blames the journal. A page the reducer refuses counts
 * as not fitting. `ops` are the key's ops, of which only the page matters.
 */
export function journalFull(room: RoomState, ops: readonly ClientOp[], memberId: string): boolean {
  if (!checkLimits(room).ok) return false;
  const page = ops.find((op) => op.t === "journal.create");
  if (!page) return false;
  const added = applyOp(room, page as Op, { memberId, role: "dm" }, { seq: 0, at: new Date(0).toISOString() });
  return !added.ok || !checkLimits(added.state).ok;
}
