import type { OpOf } from "../protocol.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * `sys.shed` (op version 65): takes the DM lines it names out of the log
 * and the fight's `steps` oldest history steps out of its history, and
 * sets `RoomState.dmLogShed` to the newest line it took. It writes no log
 * line. Until the shed is built every one is refused, so none is stored.
 */
export function sysShed(_tx: Tx, _op: OpOf<"sys.shed">): void {
  throw invalid("the shed is not built yet");
}
