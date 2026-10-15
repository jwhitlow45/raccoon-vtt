import { tapMapLabel } from "../features/builder/labelTap.ts";
import { tapGround } from "../features/builder/heights/tap.ts";
import { closeReadout, readoutSlot } from "../features/builder/heights/store.ts";
import { tapDoor } from "../features/doors/tap.ts";
import type { ToolContext } from "../features/tools.ts";
import type { Point } from "../lib/camera.ts";

/**
 * A tap on empty map with the Select tool, the one tool without pointer
 * handlers (docs/design-v1-heights-readout.md section 2). Labels, doors and
 * the ground are drawn into the map, not shapes that catch a tap, so a tap
 * on one arrives here, and the first step that takes it ends it:
 *
 * 1. Deselect. The tap that closes a token's bar may still show a reading
 *    below, since the bar is gone and one thing still floats at a time.
 * 2. A map label's pane (DM only), which takes a tap that opens or closes it.
 * 3. A door's pill, which takes a tap that opens or closes it.
 * 4. The height readout, which yields to a pin under the tap.
 *
 * A press held until the hold-to-ping fired (`held`, lib/gestures.ts) only
 * deselects: a hold that pings should open nothing, a door's pill included.
 * A tap a label or a door takes still puts a readout away, as every tap on
 * the map does.
 */
export function emptyTap(ctx: ToolContext, tool: string, world: Point, held: boolean, deselect: () => void): void {
  deselect();
  if (held) return;
  if (tapMapLabel(ctx, tool, world) || tapDoor(ctx, tool, world)) {
    closeReadout(ctx.scope.get(readoutSlot));
    return;
  }
  tapGround(ctx, tool, world);
}
