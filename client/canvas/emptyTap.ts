import { tapMapLabel } from "../features/builder/labelTap.ts";
import { tapGround } from "../features/builder/heights/tap.ts";
import { closeReadout, readoutSlot } from "../features/builder/heights/store.ts";
import { tapDoor } from "../features/doors/tap.ts";
import { pinUnder } from "../features/pins/rules.ts";
import { closePinPopover } from "../features/pins/store.ts";
import type { ToolContext } from "../features/tools.ts";
import { viewToScreen, type Point } from "../lib/camera.ts";
import { TOP_DOWN, toView } from "../lib/view.ts";

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
 * A press held until the hold-to-ping fired (`held`, lib/gestures.ts) does
 * nothing at all: a hold that pings should neither let go of a token, hide
 * its bar nor open anything, a door's pill included
 * (docs/design-v1-bar-dock.md section 3). A tap a label or a door takes
 * still puts a readout away, as every tap on the map does. Any tap but one
 * on a pin puts a pin's popover away too (putAway).
 */
export function emptyTap(ctx: ToolContext, tool: string, world: Point, held: boolean, deselect: () => void): void {
  if (held) return;
  // Who a door's pill opens it with, read before the tap lets the token go.
  const selected = ctx.getState().local.selectedId;
  deselect();
  putAway(ctx, world, { readout: false });
  if (tapMapLabel(ctx, tool, world) || tapDoor(ctx, tool, world, selected)) {
    closeReadout(ctx.scope.get(readoutSlot));
    return;
  }
  tapGround(ctx, tool, world);
}

/**
 * Puts away what floats over the map after a tap that opens nothing, such
 * as Multi-select's tap off (Stage.tsx), so one thing floats at a time.
 * A pin's popover stays when a pin is under the tap: the pin layer answers
 * that tap itself (features/pins/PinLayer.tsx), and closing here would
 * close the popover the same tap opened. `readout` puts the height readout
 * away too, which emptyTap leaves to the steps that follow.
 */
export function putAway(ctx: ToolContext, world: Point, options: { readout: boolean } = { readout: true }): void {
  const camera = ctx.camera();
  if (!pinUnder(ctx.getState().view, ctx.scene.id, camera, viewToScreen(camera, toView(TOP_DOWN, world)))) closePinPopover(ctx.scope);
  if (options.readout) closeReadout(ctx.scope.get(readoutSlot));
}
