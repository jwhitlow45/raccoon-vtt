import { useCallback } from "react";
import type { Token } from "#shared/model.ts";
import type { NextSize } from "#shared/rules/resize.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi } from "../../state/view.ts";
import { resizePatch } from "./resize.ts";
import { growthsSlot } from "./resizeMemory.ts";

/**
 * Sends a resize the one way every control does (resize.ts resizePatch):
 * on this viewer's copy, with this page's growths, so a shrink returns to
 * the square it grew from. A refusal found before sending is sent as
 * nothing, toasted where `toast` asks, and handed back for a field that
 * shows it under itself. Null once it is sent: the server may still refuse
 * it where its view differs, and the room's toast says so.
 */
export function useResize(): (token: Token, next: NextSize, opts?: { toast?: boolean }) => string | null {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const growths = useScoped(growthsSlot);
  return useCallback(
    (token, next, opts) => {
      const state = store.getState();
      if (!state.view) return null;
      const answer = resizePatch(state.view, token, next, state.you?.role ?? "player", growths.getState()[token.id] ?? []);
      if ("refused" in answer) {
        if (opts?.toast !== false) ui.notify(answer.refused, "error");
        return answer.refused;
      }
      if (actions.dispatch({ t: "token.update", tokenId: token.id, patch: answer.patch }) !== null) growths.setState({ [token.id]: answer.growths });
      return null;
    },
    [store, actions, ui, growths],
  );
}
