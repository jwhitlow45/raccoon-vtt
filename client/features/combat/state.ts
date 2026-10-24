import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { hasLair, lairCounts, limitedUses, type LimitedUse, type RegenerationUse } from "#shared/dice/uses.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { creatureBlock, srdNeeds } from "../dice/creature.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { actorOf, actsNow, currentRecord, deathSaveWaits, holderKey, promptsOf } from "./logic.ts";

/*
 * What this device keeps of a fight's combat uses, per Room page
 * (state/scope.ts): the cards it dismissed for this turn, which only Skip
 * settles for everyone (docs/design-v1-combat-controls.md 4.1), the turn
 * cards it unfolded, and the tag of the last Roll recharge its uses lists
 * sent per recharge (`rechargeRow`), whose result and trouble those lists
 * show. Keys name the turn or the prompt, so a new turn's card or prompt
 * never meets an old dismissal.
 */
type Local = { dismissed: ReadonlySet<string>; shown: ReadonlySet<string>; rolls: Readonly<Record<string, string>> };

export const combatLocalSlot = scopeSlot(() => createStore<Local>(() => ({ dismissed: new Set<string>(), shown: new Set<string>(), rolls: {} })));

/** A recharge's row in the options' store, which the Dice panel's Recharge 1d6 and the uses lists' Roll recharge share. */
export function rechargeRow(holder: string, key: string): string {
  return `${holder}|${key}|recharge`;
}

/** The tags this device's uses lists last rolled per recharge row, and the way to remember one. */
export function useListRolls(): { rolls: Readonly<Record<string, string>>; remember(row: string, tag: string): void } {
  const store = useScoped(combatLocalSlot);
  const rolls = useStore(store, (s) => s.rolls);
  return useMemo(() => ({ rolls, remember: (row: string, tag: string) => store.setState((s) => ({ rolls: { ...s.rolls, [row]: tag } })) }), [store, rolls]);
}

/** A prompt's key on this device: whose it is, its record and what it asks. A turn's creatures share one record id, the seq that started it. */
export function promptId(holder: string, record: number, what: string): string {
  return `${holder}|${record}|${what}`;
}

/** A turn card's key on this device: the turn's row and round, and whose block it is. */
export function turnId(entryId: string, round: number): string {
  return `turn|${entryId}|${round}`;
}

export function useDismissed(): { dismissed: ReadonlySet<string>; dismiss(id: string): void; shown: ReadonlySet<string>; show(id: string, on: boolean): void } {
  const store = useScoped(combatLocalSlot);
  const dismissed = useStore(store, (s) => s.dismissed);
  const shown = useStore(store, (s) => s.shown);
  return useMemo(
    () => ({
      dismissed,
      dismiss: (id: string) => store.setState((s) => ({ dismissed: new Set([...s.dismissed, id]) })),
      shown,
      show: (id: string, on: boolean) =>
        store.setState((s) => {
          const next = new Set(s.shown);
          if (on) next.add(id);
          else next.delete(id);
          return { shown: next };
        }),
    }),
    [store, dismissed, shown],
  );
}

/**
 * Creatures' limited uses from the blocks this viewer reads (shared/dice/uses.ts),
 * with the SRD's blocks loaded on first need: each null while they load or
 * after they failed, an empty list for a creature with no block.
 */
export function useCreaturesUses(targets: readonly ActorTarget[]): { uses: (readonly LimitedUse[] | null)[]; loading: boolean; failed: boolean } {
  const { dice, failed } = useDiceView(targets);
  if (!dice) return { uses: targets.map(() => null), loading: targets.length > 0 && !failed, failed };
  let loading = false;
  const uses = targets.map((target) => {
    const needs = srdNeeds(dice, target);
    if (needs.monsters && dice.srd.monsters === null) {
      loading ||= !failed;
      return null;
    }
    const block = creatureBlock(dice, target);
    return block ? limitedUses(block) : [];
  });
  return { uses, loading, failed: failed && uses.some((u) => u === null) };
}

/** useCreaturesUses for one creature, or none. */
export function useCreatureUses(target: ActorTarget | null): { uses: readonly LimitedUse[] | null; loading: boolean; failed: boolean } {
  const targets = useMemo(() => (target ? [target] : []), [target]);
  const read = useCreaturesUses(targets);
  return { uses: target ? (read.uses[0] ?? null) : [], loading: read.loading, failed: read.failed };
}

/** The Regeneration a creature's block prints, null with none or while its block loads. */
export function regenerationIn(uses: readonly LimitedUse[] | null): RegenerationUse | null {
  return uses?.find((u): u is RegenerationUse => u.kind === "regeneration") ?? null;
}

/**
 * Whether a creature's death save Roll waits on this device (logic.ts
 * deathSaveWaits): its current record holds its Regeneration open, which
 * this device has not dismissed. Every death save Roll reads it.
 */
export function useDeathSaveWaits(target: ActorTarget | null): boolean {
  const encounter = useRoomView((s) => s.view?.encounter);
  const actor = useRoomView((s) => (target && s.view ? actorOf(s.view, target) : undefined));
  const holder = useRoomView((s) => (target && s.view ? holderKey(s.view, target) : ""));
  const record = currentRecord(encounter, actor);
  const local = useDismissed();
  // Only a record can hold Regeneration open, so a creature with none reads no block for it.
  const { uses } = useCreatureUses(record && actor?.life === "dying" ? target : null);
  if (!record || !actor) return false;
  const prompts = promptsOf({ record, actor, regeneration: regenerationIn(uses) });
  return deathSaveWaits(prompts.regeneration, local.dismissed.has(promptId(holder, record.id, "regeneration")));
}

/** Whether a creature acts now (logic.ts actsNow), which every off-turn list of its uses asks. */
export function useActsNow(target: ActorTarget | null): boolean {
  return useRoomView((s) => (target && s.view ? actsNow(s.view, target) : false));
}

/** "Waiting for Regeneration", the reason every waiting death save Roll gives (4.4). */
export const WAITS_FOR_REGENERATION = "Waiting for Regeneration";

/**
 * In lair's counts for a creature (docs/design-v1-combat-controls.md 3.1):
 * from the block this viewer reads, its lair or base legendary counts and
 * XP, or none where it has no block or its block's counts never change in
 * a lair. `loading` while the block loads, when the switch waits busy.
 */
export function useLairCounts(target: ActorTarget | null): { loading: boolean; counts(inLair: boolean): { actionsMax: number; resistMax: number; xp: number } | undefined } {
  const creatures = useMemo(() => (target ? [target] : []), [target]);
  const { dice, loading } = useDiceView(creatures);
  const block = dice && target ? creatureBlock(dice, target) : null;
  return { loading: target !== null && (dice === null || loading), counts: (inLair) => (block && hasLair(block) ? lairCounts(block, inLair) : undefined) };
}
