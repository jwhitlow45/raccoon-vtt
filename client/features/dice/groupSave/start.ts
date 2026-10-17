import { useMemo } from "react";
import { uuidv7 } from "#shared/ids.ts";
import type { AdvantageSource } from "#shared/dice/formula.ts";
import { useRoomUi, useRoomView } from "../../../state/view.ts";
import { askSwitches } from "../../rolls/logic.ts";
import { newPage, type Fill, type OutcomeForm, type Page, type Source } from "./chain.ts";
import type { GroupTest } from "./rows.ts";
import { useGroupSaveStore } from "./store.ts";

/** Whether a page holds anything a start would throw away: rolls or requests sent and not yet applied. */
export function holdsRolls(page: Page | null): boolean {
  return page !== null && page.phase !== "applied" && (page.rolls.length > 0 || page.requests.length > 0 || page.damage !== null);
}

export type StartInput = {
  source: Source;
  test: GroupTest;
  dc: number | null;
  fill?: Fill | null;
  outcome?: Partial<OutcomeForm>;
  spell?: boolean;
  panel: "dice" | "areas";
  /** A quick tap (4.4): roll at once with the choices the tap took. */
  rollNow?: { sources: AdvantageSource[]; secret: boolean };
};

/**
 * Starts a group save (5.1): one at a time in a browser tab, so a start
 * while one holds rolls returns false, and the caller asks "Discard the
 * Dexterity save for 6?" first, then starts again with `replace`.
 */
export function useStartGroupSave(): (input: StartInput, opts?: { replace?: boolean }) => boolean {
  const store = useGroupSaveStore();
  const roomId = useRoomView((s) => s.roomId);
  const sceneId = useRoomView((s) => s.sceneId);
  const ui = useRoomUi();
  return useMemo(
    () => (input: StartInput, opts: { replace?: boolean } = {}) => {
      if (!opts.replace && holdsRolls(store.getState().page)) return false;
      const page = newPage({
        id: uuidv7(),
        sceneId: sceneId ?? "",
        source: input.source,
        test: input.test,
        dc: input.dc,
        // The page rolls the monsters, a player's creature being asked, and a DM's roll for a monster starts hidden from players (doc 1 17).
        secret: input.rollNow?.secret ?? true,
        spell: input.spell ?? false,
        switches: askSwitches(roomId),
        fill: input.fill ?? null,
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.rollNow ? { rollNow: { sources: input.rollNow.sources } } : {}),
      });
      store.setState({ page, shownIn: input.panel, restored: false });
      ui.openPanel(input.panel);
      return true;
    },
    [store, roomId, sceneId, ui],
  );
}
