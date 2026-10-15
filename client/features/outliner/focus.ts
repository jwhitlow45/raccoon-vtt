import { fitSlot } from "../../canvas/fitSlot.ts";
import { NO_INSETS } from "../../lib/camera.ts";
import type { RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions } from "../../state/types.ts";
import { pickTemplate } from "../areas/AreaTool.tsx";
import { lightSlot } from "../builder/lightTap.ts";
import { builderSlot, labelPaneSlot } from "../builder/store.ts";
import { stampSlot } from "../builder/stamps/store.ts";
import { findCamera } from "../find/findToken.ts";
import { lightModeSlot } from "../lights/store.ts";
import { pinSlot } from "../pins/store.ts";
import { flash } from "./flash.ts";
import { frameRect, type OutlineRow } from "./rows.ts";

/**
 * A tap on an outliner row (docs/design-v1-dm-tools.md 3.2): the map frames
 * the item with the Find my token framing, and the item is picked where it
 * can be. A token opens its action bar, a label or a pin its pane, an area
 * becomes the area tool's pick, and a stamp or a light opens the builder in
 * its mode with it selected. The rest have no selection, so their outline
 * flashes.
 *
 * The caller closes a phone's sheet first, so the item is not under it.
 */
export function focusOutlineRow(row: OutlineRow, env: { scope: RoomScope; ui: RoomUi; actions: RoomActions; sceneId: string }): void {
  const { scope, ui } = env;
  const target = frameRect(row.rect);
  scope.get(fitSlot).show?.((viewport, bars) => findCamera(viewport, target, bars, NO_INSETS));
  switch (row.kind) {
    case "token":
      ui.setTool("select");
      ui.select(row.id);
      ui.showActions(true);
      return;
    case "label":
      // The pane opens with the Select tool, and one thing floats over the map at a time (builder/labelTap.ts).
      ui.setTool("select");
      ui.select(null);
      scope.get(labelPaneSlot).setState({ labelId: row.id });
      return;
    case "area":
      ui.select(null);
      pickTemplate(scope, row.id, env.actions);
      ui.setTool("area");
      return;
    case "stamp":
      ui.select(null);
      scope.get(builderSlot).store.setState({ mode: "stamp" });
      scope.get(stampSlot).store.setState({ selectedId: row.id, preview: null });
      ui.setTool("build");
      return;
    case "light":
      ui.select(null);
      scope.get(builderSlot).store.setState({ mode: "light" });
      scope.get(lightSlot).setState({ lightId: row.id, dragTo: null });
      scope.get(lightModeSlot).store.setState({ paneOpen: true });
      ui.setTool("build");
      return;
    case "pin":
      // The pane opens with the Pin tool, as a tap with it does (pins/PinTool.tsx).
      ui.select(null);
      ui.setTool("pin");
      scope.get(pinSlot).store.setState({ paneId: row.id, placing: null });
      return;
    case "drawing":
    case "door":
    case "window":
      flash(scope, { sceneId: env.sceneId, rect: row.rect, ...(row.segment ? { segment: row.segment } : {}) });
      return;
  }
}
