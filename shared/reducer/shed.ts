import { keys } from "../keys.ts";
import { lineAudience } from "../logRings.ts";
import type { OpOf } from "../protocol.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * `sys.shed` (op version 65): takes the DM lines it names out of the log
 * and the fight's `steps` oldest history steps out of its history, and
 * sets `RoomState.dmLogShed` to the newest line it took. It writes no log
 * line. A batch's close makes it (server/rooms/sizeGuard.ts shedOf), and
 * replay applies it as stored, so each line it names must still be a DM
 * line the log holds, and the newest step stays.
 */
export function sysShed(tx: Tx, op: OpOf<"sys.shed">): void {
  if (op.lines.length > 0) {
    const named = new Set(op.lines);
    let held = 0;
    for (const line of tx.state.log) {
      if (!named.has(line.id)) continue;
      if (lineAudience(line) !== "dm") throw invalid(`line ${line.id} is not a DM line`);
      held++;
    }
    if (held !== named.size) throw invalid("a line shed is not in the log");
    tx.shedLines(op.lines);
  }
  if (op.steps > 0) {
    const history = tx.state.encounterHistory;
    if (op.steps >= history.length) throw invalid("a shed keeps the newest history step");
    tx.write(keys.encounterHistory, history.slice(op.steps));
  }
}
