import { useEffect, useMemo } from "react";
import { uuidv7 } from "#shared/ids.ts";
import type { AdvantageSource } from "#shared/dice/formula.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../../state/view.ts";
import { askSwitches } from "../../rolls/logic.ts";
import { newPage, readDraft, replace, restoredPage, type Fill, type OutcomeForm, type Page, type PageCast, type Source } from "./chain.ts";
import type { GroupTest } from "./rows.ts";
import { useGroupSaveStore } from "./store.ts";

/**
 * Reads the tab's draft back once after a reload (5.10). The DM's alerts
 * column does it as the room opens, not only the Dice panel, so the ask a
 * kept page holds shows no card to open a second page from
 * (docs/design-v1-player-save-spell.md 3.3), and a start reads it first, so
 * a kept page with rolls is never replaced unasked.
 */
function restoreDraft(store: ReturnType<typeof useGroupSaveStore>, roomId: string): void {
  const now = store.getState();
  if (now.page || now.restored) return;
  const draft = readDraft(roomId);
  store.setState({ restored: true, ...(draft ? { page: restoredPage(draft) } : {}) });
}

/** A reload brings the tab's group save back from its draft, once, for the DM. */
export function useRestoreGroupSave(): void {
  const store = useGroupSaveStore();
  const roomId = useRoomView((s) => s.roomId);
  const dm = useRoomView((s) => s.you?.role === "dm");
  useEffect(() => {
    if (dm) restoreDraft(store, roomId);
  }, [dm, roomId, store]);
}

/**
 * Whether the page sent anything: rolls, requests or its damage line. The
 * caster's roll an ask brought is not the page's own until the DM rolls or
 * the page sends anything, so opening an ask never asks to discard nothing
 * (docs/design-v1-player-save-spell.md 3.3).
 */
export function sentAny(page: Pick<Page, "rolls" | "requests" | "damage">): boolean {
  return page.rolls.length > 0 || page.requests.length > 0 || (page.damage !== null && !page.damage.imported);
}

/** Whether a page holds anything a start would throw away: rolls or requests sent and not yet applied. */
export function holdsRolls(page: Page | null): boolean {
  return page !== null && page.phase !== "applied" && sentAny(page);
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
  /** A player's ask the page answers, and the caster's roll it brought (dice/cast/castStart.ts). */
  cast?: PageCast;
  damage?: Page["damage"];
};

/**
 * Starts a group save (5.1): one at a time in a browser tab, so a start
 * while one holds rolls returns false, and the caller asks "Discard the
 * Dexterity save for 6?" first (ReplaceConfirm), then starts again with
 * `replace`, which closes the old one's requests as its Discard would. A
 * page Applying is never replaced: that start returns false too.
 */
export function useStartGroupSave(): (input: StartInput, opts?: { replace?: boolean }) => boolean {
  const store = useGroupSaveStore();
  const roomId = useRoomView((s) => s.roomId);
  const sceneId = useRoomView((s) => s.sceneId);
  const ui = useRoomUi();
  const actions = useRoomActions();
  return useMemo(
    () => (input: StartInput, opts: { replace?: boolean } = {}) => {
      restoreDraft(store, roomId);
      const old = store.getState().page;
      if (!opts.replace && holdsRolls(old)) return false;
      const out = replace(old);
      if (!out.ok) return false;
      for (const c of out.send) if (c.kind === "op") actions.dispatch(c.op);
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
        ...(input.cast ? { cast: input.cast } : {}),
        ...(input.damage ? { damage: input.damage } : {}),
      });
      store.setState({ page, shownIn: input.panel, restored: false });
      ui.openPanel(input.panel);
      return true;
    },
    [store, roomId, sceneId, ui, actions],
  );
}
