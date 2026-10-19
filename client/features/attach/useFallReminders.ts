import { useEffect } from "react";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomStore, useRoomUi } from "../../state/view.ts";
import { openAsk } from "../rolls/open.ts";
import { fallReminders } from "./falling.ts";

/**
 * The falling off reminder on the DM's device (docs/design-v1-attach.md
 * 4.5): a toast when Prone or Unconscious lands on a rider or its mount,
 * with "Ask for the save", which opens Request a roll filled in, when a
 * player plays the rider. Which changes remind is falling.ts fallReminders.
 */
export function useFallReminders(): void {
  const store = useRoomStore();
  const ui = useRoomUi();
  const scope = useRoomScope();
  useEffect(
    () =>
      store.subscribe((now, prev) => {
        for (const { text, ask } of fallReminders(now, prev)) {
          ui.notify(text, "info", undefined, ask ? { label: "Ask for the save", run: () => openAsk(scope, ask) } : undefined);
        }
      }),
    [store, ui, scope],
  );
}
