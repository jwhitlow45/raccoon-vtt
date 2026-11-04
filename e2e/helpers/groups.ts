import type { Locator, Page } from "playwright-core";
import { waitFor } from "../harness.ts";

/**
 * Opens a panel's group (components/Panel.tsx Group) by its fold's name, as
 * the viewer's own tap would, where it starts folded: the Token panel's
 * Image, Notes and Position, or a group on a surface whose setup folds on a
 * phone. Only for a tap the test stands in for. A group a request, a paste,
 * a waiting upload or a start that reads the room should open is asserted
 * open by itself, never opened here (docs/design/design-v1-panel-groups.md 11).
 */
export async function openGroup(panel: Locator | Page, name: string): Promise<void> {
  const fold = panel.getByRole("button", { name, exact: true });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await waitFor(`${name} open`, async () => ((await fold.getAttribute("aria-expanded")) === "true" ? true : null), 3000);
}
