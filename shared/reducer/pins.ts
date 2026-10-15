import { keys } from "../keys.ts";
import type { Pin } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * Map pins (docs/design-v1-dm-tools.md 3.8), the DM's. A put creates a pin
 * or replaces the one of the same id on the same scene, as stamps are put.
 * A pin names only a page that exists: deleting a page unlinks its pins in
 * the same op (reducer/journal.ts), and a restore never brings back a pin
 * whose page is gone (reducer/misc.ts).
 */
export function pinPut(tx: Tx, op: OpOf<"pin.put">): void {
  const input = op.pin;
  const scene = tx.scene(input.sceneId);
  const existing = tx.state.pins[input.id];
  if (existing && existing.sceneId !== scene.id) throw invalid("pin belongs to another scene");
  if (input.pageId !== undefined && !tx.state.journal[input.pageId]) throw gone("page");
  const pin: Pin = { ...input, rev: existing?.rev ?? 0 };
  tx.write(keys.pin(pin.id), pin);
}

export function pinRemove(tx: Tx, op: OpOf<"pin.remove">): void {
  if (!tx.state.pins[op.pinId]) throw gone("pin");
  tx.remove(keys.pin(op.pinId));
}
