import { checkLimits } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { keyOps, type KeyInput, type KeyStock } from "./keyPage.ts";
import { SCENE_PLACEHOLDER } from "./ops.ts";
import type { DungeonPlan } from "./plan.ts";
import type { DungeonSettings } from "./settings.ts";

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

/**
 * Whether the key's page would overfill the live room's journal, built as
 * Make sends it: with the fights and Made with of the stock the preview was
 * drawn with, which make the page longer (D-261127-336).
 */
export function keyOverfills(room: RoomState, plan: DungeonPlan, settings: DungeonSettings, input: KeyInput, stock: KeyStock | null, memberId: string): boolean {
  return journalFull(room, keyOps(plan, settings, input, SCENE_PLACEHOLDER, stock), memberId);
}
