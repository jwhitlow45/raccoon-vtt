import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { hasLair, lairCounts, limitedUses, type LimitedUse, type RegenerationUse } from "#shared/dice/uses.ts";
import type { Token } from "#shared/model.ts";
import type { ActorTarget, EntryInput } from "#shared/protocol.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { creatureBlock, srdNeeds, type DiceView } from "../dice/creature.ts";
import type { ReceiptTracker } from "../dice/useReceipt.ts";
import { ownResultText } from "../dice/useRollToasts.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { joinEntry } from "../encounters/drop.ts";
import { blockHasLair } from "../tokens/factory.ts";
import { actorOf, actsNow, currentRecord, deathSaveWaits, holderKey, promptsOf, type ListRoll } from "./logic.ts";

/*
 * What this device keeps of a fight's combat uses, per Room page
 * (state/scope.ts): the cards it dismissed for this turn, which only Skip
 * settles for everyone (docs/design-v1-combat-controls.md 4.1), the turn
 * cards it unfolded, and the last Roll recharge its uses lists sent per
 * recharge (`rechargeRow`), with the turn they showed, whose result and
 * trouble those lists show. Of those rolls' failures it keeps the ones a
 * list's later tap silenced and the ones a list showed, so a list opened
 * again never brings them back (logic.ts listRollTrouble). Keys name the
 * turn or the prompt, so a new turn's card or prompt never meets an old
 * dismissal.
 */
type Local = {
  dismissed: ReadonlySet<string>;
  shown: ReadonlySet<string>;
  rolls: Readonly<Record<string, ListRoll>>;
  silenced: ReadonlySet<string>;
  seen: ReadonlySet<string>;
};

export const combatLocalSlot = scopeSlot(() =>
  createStore<Local>(() => ({ dismissed: new Set<string>(), shown: new Set<string>(), rolls: {}, silenced: new Set<string>(), seen: new Set<string>() })),
);

/** A recharge's row in the options' store, which the Dice panel's Recharge 1d6 and the uses lists' Roll recharge share. */
export function rechargeRow(holder: string, key: string): string {
  return `${holder}|${key}|recharge`;
}

/** The rolls this device's uses lists last sent per recharge row, and the way to remember one. */
export function useListRolls(): { rolls: Readonly<Record<string, ListRoll>>; remember(row: string, roll: ListRoll): void } {
  const store = useScoped(combatLocalSlot);
  const rolls = useStore(store, (s) => s.rolls);
  return useMemo(() => ({ rolls, remember: (row: string, roll: ListRoll) => store.setState((s) => ({ rolls: { ...s.rolls, [row]: roll } })) }), [store, rolls]);
}

/**
 * Toasts the uses lists' roll failures that came once their turn had
 * passed (logic.ts listRollTrouble `passed`), in the words the receipts'
 * own toast gives a roll nobody saw land (dice/useRollToasts.ts). Each is
 * marked seen before its toast, so it is told once for every list open on
 * its creature, and no list shows it after.
 */
export function tellPassed(tags: readonly string[], local: StoreApi<Local>, tracker: Pick<ReceiptTracker, "state">, notify: (text: string, tone: "error" | "info") => void): void {
  for (const tag of tags) {
    const state = tracker.state(tag);
    if (local.getState().seen.has(tag) || !state || (state.state !== "refused" && state.state !== "unknown")) continue;
    local.setState((s) => ({ seen: new Set([...s.seen, tag]) }));
    notify(ownResultText(state), state.state === "refused" ? "error" : "info");
  }
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
 * a lair, which the switch then sets alone. `state` is "loading" while its
 * block loads, when the switch waits busy, and "failed" when the block did
 * not load, when the switch stays off beside the failure's reload: an
 * unread block never lets In lair go without the counts it would carry.
 * `has` is whether the block it read has a lair (factory.ts blockHasLair).
 */
export function useLairCounts(target: ActorTarget | null): { state: JoinState; has: boolean; counts(inLair: boolean): { actionsMax: number; resistMax: number; xp: number } | undefined } {
  const creatures = useMemo(() => (target ? [target] : []), [target]);
  const { dice, failed } = useDiceView(creatures);
  const block = dice && target ? creatureBlock(dice, target) : null;
  return {
    state: lairState(dice, failed, target),
    has: block !== null && blockHasLair(block),
    counts: (inLair) => (block && hasLair(block) ? lairCounts(block, inLair) : undefined),
  };
}

/**
 * Whether a tracker row offers In lair: only for a creature whose block has
 * a lair, so a troll's row never holds a switch that changes nothing. While
 * its block is unread the switch shows busy or beside its reload, since
 * only the block can say, and a row already in its lair keeps the switch
 * that takes it out.
 */
export function offersLair(lair: { state: JoinState; has: boolean }, inLair: boolean): boolean {
  return inLair || lair.state !== "ready" || lair.has;
}

/** Whether a creature's block is read for In lair (useLairCounts): only an SRD block not loaded yet waits, or fails with its load. */
export function lairState(dice: DiceView | null, failed: boolean, target: ActorTarget | null): JoinState {
  if (target === null) return "ready";
  if (dice === null) return "loading";
  if (!srdNeeds(dice, target).monsters || dice.srd.monsters !== null) return "ready";
  return failed ? "failed" : "loading";
}

/** Whether a join can read its creatures' lairs now (useFightJoin): read, its blocks loading, or a block that did not load. */
export type JoinState = "ready" | "loading" | "failed";

/** A creature that may stand placed in its lair: one with legendary counts, which its block's lair counts are told apart by. */
function lairCandidate(token: Token): boolean {
  return "inline" in token.actor && token.actor.inline.legendary !== undefined;
}

/**
 * Whether these tokens can join a fight now (13.4): a creature with
 * legendary counts needs its block read to say whether it stands placed in
 * its lair, so the join waits while that block loads, and stops with the
 * failure's reload where it did not load. A row is never marked off for a
 * block not read.
 */
export function joinState(dice: DiceView | null, failed: boolean, tokens: readonly Token[]): JoinState {
  const unread = tokens.some((t) => lairCandidate(t) && (dice === null || (srdNeeds(dice, { tokenId: t.id }).monsters && dice.srd.monsters === null)));
  if (!unread) return "ready";
  return failed ? "failed" : "loading";
}

/**
 * The rows tokens join a fight with, by the rule every path into a fight
 * shares (encounters/drop.ts joinEntry): the tracker's Start a fight and
 * Add, and the group bar's Start a fight and Add to the fight. `candidates`
 * are the tokens a surface offers, whose blocks start loading as it shows
 * them, so a tap normally finds them read. The surface holds its button
 * busy while `stateOf` its tokens says loading, and off with the
 * failure's reload when it says failed.
 */
export function useFightJoin(candidates: readonly Token[]): { stateOf(tokens: readonly Token[]): JoinState; mark(entry: EntryInput): EntryInput } {
  const targets = useMemo(() => candidates.filter(lairCandidate).map((t) => ({ tokenId: t.id })), [candidates]);
  const { dice, failed } = useDiceView(targets);
  return {
    stateOf: (tokens) => joinState(dice, failed, tokens),
    mark: (entry) => {
      const token = entry.tokenId !== undefined ? candidates.find((t) => t.id === entry.tokenId) : undefined;
      if (!dice || !token || !("inline" in token.actor)) return entry;
      return joinEntry(entry, token.actor.inline, creatureBlock(dice, { tokenId: token.id }));
    },
  };
}
