import { COUNT_OP_VERSION } from "#shared/migrate.ts";
import type { OpType, ServerOnlyOp } from "#shared/protocol.ts";

/**
 * The room count's classes (shared/migrate.ts COUNT_OP_VERSION). The room
 * keeps two numbers: `seq`, which every stored row takes in turn and which
 * storage alone reads, and the count, which every number a device gets is
 * made from. The count moves once for each member's op the room answers and
 * each member change applied over HTTP. The server's own ops that only keep
 * the room's books, the explore, the map step's and the cleanup's remember,
 * and the music's tick, reduce at the count as it stands and never move it.
 *
 * Every server-only type is classed here by name, so a new one fails the
 * typecheck until it is. A member's op, and the restore or dice op that
 * stands for one, counts. The class of a type is frozen for each op version:
 * moving one later steps OP_VERSION, and replay reads a row's class from the
 * version it was stored at, so a stored row reduces as it did live.
 */
const SERVER_ONLY: Record<ServerOnlyOp["t"], boolean> = {
  "sys.memberJoin": true,
  "sys.memberSetKind": true,
  "sys.memberRemove": true,
  "sys.restore": true,
  "sys.dice": true,
  "sys.explore": false,
  "sys.remember": false,
  "sys.sound": false,
};

/**
 * Whether an op of `type`, at `opVersion`, takes the next number and moves
 * the count. Before COUNT_OP_VERSION there was no count, and every row took
 * the next seq as its number, so every type counts there.
 */
export function counted(type: OpType, opVersion: number): boolean {
  if (opVersion < COUNT_OP_VERSION) return true;
  return Object.hasOwn(SERVER_ONLY, type) ? SERVER_ONLY[type as ServerOnlyOp["t"]] : true;
}
