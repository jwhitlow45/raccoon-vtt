import { useCallback, type RefCallback } from "react";
import { createStore } from "zustand/vanilla";
import { ambianceFoldsSlot, type AmbianceSection } from "../../lib/folds.ts";
import { scopeSlot, useScoped, type RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { PanelHow } from "../../state/types.ts";

/** The Ambiance panel's id in the registry (features/panels.ts). */
export const AMBIANCE_PANEL = "ambiance";

/**
 * A request to show one of Ambiance's sections
 * (docs/design/design-v1-panel-groups.md 4.3): the section's group, once
 * drawn, scrolls its header to the top of the panel's body and clears the
 * request. Focus goes where the panel's opening sends it. `seq` tells one
 * press from the next, so a second press acts again. A Sound subpage that
 * shows goes back to the first page first, as Back does. Per Room page, so a
 * press in "view as a player" never reaches the DM's own panel.
 */
export type AmbianceRequest = { section: AmbianceSection | null; seq: number };

export const ambianceRequestSlot = scopeSlot(() => createStore<AmbianceRequest>(() => ({ section: null, seq: 0 })));

/** The elements the Ambiance panel draws in, one per tree it is mounted in (useAmbianceRoot). */
export const ambianceRootsSlot = scopeSlot(() => new Set<Pick<HTMLElement, "contains">>());

/** A ref for the Ambiance panel's own root, so a request can find a field being typed in there and blur it first. */
export function useAmbianceRoot(): RefCallback<HTMLElement> {
  const roots = useScoped(ambianceRootsSlot);
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      roots.add(el);
      return () => {
        roots.delete(el);
      };
    },
    [roots],
  );
}

/** Where the panel opens: by the panel the press was in (`from`, so with two panels it opens in the other pane), or in a pane by name, as the top bar's chip asks for the top. */
export type AmbianceHow = { from?: string | null; pane?: undefined } | { pane: "top" | "below"; from?: undefined };

/**
 * The one way into Ambiance from elsewhere (4.3): the top bar's chip asks
 * for Time. It opens the panel and reveals the section, open for now and
 * never written (lib/folds.ts), so a DM who folded it on purpose finds it
 * folded again once Ambiance closes. The way back, from Ambiance's rows into
 * Scenes, is features/scenes/request.ts.
 *
 * First it blurs a field focused inside the panel, such as a playlist's
 * or a sound's name on a subpage, which saves on blur: the request then
 * leaves that subpage, and the field would unmount unsaved. The press
 * itself cannot be trusted to blur it: the chip moves no focus on its
 * press, and Safari focuses no button on a click (features/panels.ts).
 */
export function openAmbiance(scope: RoomScope, ui: Pick<RoomUi, "openPanel">, section: AmbianceSection, options: AmbianceHow = {}): void {
  blurInside(scope.get(ambianceRootsSlot));
  scope.get(ambianceFoldsSlot).reveal(section);
  const request = scope.get(ambianceRequestSlot);
  request.setState({ section, seq: request.getState().seq + 1 });
  const how: PanelHow | undefined = options.pane ? { pane: options.pane } : options.from ? { from: options.from } : undefined;
  ui.openPanel(AMBIANCE_PANEL, how);
}

function blurInside(roots: ReadonlySet<Pick<HTMLElement, "contains">>): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement as (Node & { blur?(): void }) | null;
  if (!active) return;
  for (const root of roots) {
    if (root.contains(active)) {
      active.blur?.();
      return;
    }
  }
}
