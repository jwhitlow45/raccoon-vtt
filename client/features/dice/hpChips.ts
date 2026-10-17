import { useCallback, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { hpChips, type HpChip } from "./options.ts";

/*
 * The damage and healing lines this device already applied through an HP
 * entry's chip (docs/design-v1-roll-options.md 4.3), kept for the Room page
 * so the chip goes on every entry at once, the token bar's and the panel's
 * alike. Applying is this device's own act, so nothing is sent for it and
 * another viewer still sees the line as a chip.
 */
type AppliedChips = { applied: ReadonlySet<string> };

const appliedSlot = scopeSlot(() => createStore<AppliedChips>(() => ({ applied: new Set<string>() })));

/** The chips an HP entry offers in this mode, none for Set and Temp. */
export function useHpChips(kind: "damage" | "heal" | null): HpChip[] {
  const applied = useStore(useScoped(appliedSlot), (s) => s.applied);
  const log = useRoomView((s) => s.view?.log);
  const me = useRoomView((s) => s.you?.memberId);
  const members = useRoomView((s) => s.view?.members);
  return useMemo(
    () => (kind && log ? hpChips(log, me ?? "", kind, { applied, nameOf: (id) => members?.[id]?.name ?? "someone" }) : []),
    [kind, log, me, members, applied],
  );
}

/** Marks a chip's line applied once its amount went out, so its chip goes. */
export function useMarkChipApplied(): (lineId: string) => void {
  const store = useScoped(appliedSlot);
  return useCallback((lineId: string) => store.setState((s) => ({ applied: new Set([...s.applied, lineId]) })), [store]);
}
