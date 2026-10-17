import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { useRoomView } from "../../state/view.ts";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";
import { srdNeeds, type DiceView } from "./creature.ts";

/*
 * The view creatureRolls and presetFor read (creature.ts, presets.ts), with
 * the SRD chunks the given creatures need loaded on first need and kept for
 * the page, so a later card for the same creature reads at once. The stat
 * blocks are the one store every SRD view reads (monsters/srdBlocks.ts).
 * The rolls table is a store of the same kind, read through
 * useSyncExternalStore, so a load that lands between a view's render and
 * its effect still draws it again.
 */

type Chunk<T> = { value: T | null; failed: boolean; loading?: Promise<void>; listeners: Set<() => void> };
const rollsChunk: Chunk<SrdRolls> = { value: null, failed: false, listeners: new Set() };

function subscribeRolls(listener: () => void): () => void {
  rollsChunk.listeners.add(listener);
  return () => rollsChunk.listeners.delete(listener);
}
const rollsValue = () => rollsChunk.value;
const rollsFailed = () => rollsChunk.failed;

function useRollsChunk(wanted: boolean): { value: SrdRolls | null; failed: boolean } {
  const value = useSyncExternalStore(subscribeRolls, rollsValue, rollsValue);
  const failed = useSyncExternalStore(subscribeRolls, rollsFailed, rollsFailed);
  useEffect(() => {
    if (!wanted || rollsChunk.value !== null || rollsChunk.failed) return;
    rollsChunk.loading ??= loadSrdRolls()
      .then(
        (loaded) => {
          rollsChunk.value = loaded;
        },
        () => {
          // A module that failed to load stays failed for the page, so only a reload tries again (monsters/SrdLoadFailed.tsx).
          rollsChunk.failed = true;
        },
      )
      .then(() => {
        for (const listener of rollsChunk.listeners) listener();
      });
  }, [wanted]);
  return { value, failed };
}

function targetKey(creature: ActorTarget): string {
  return "tokenId" in creature ? `t:${creature.tokenId}` : `c:${creature.characterId}`;
}

/**
 * A DiceView for these creatures, null until the room's first snapshot.
 * creatureRolls is null for one of them while a chunk it needs loads, which
 * `loading` says, and `failed` says a chunk did not load, for
 * SrdLoadFailed's reload.
 */
export function useDiceView(creatures: readonly ActorTarget[]): { dice: DiceView | null; loading: boolean; failed: boolean } {
  const you = useRoomView((s) => s.you);
  const view = useRoomView((s) => s.view);
  const key = creatures.map(targetKey).join(",");
  const needs = useMemo(() => {
    const out = { monsters: false, rolls: false };
    if (!you || !view) return out;
    for (const creature of creatures) {
      const need = srdNeeds({ you, view }, creature);
      out.monsters ||= need.monsters;
      out.rolls ||= need.rolls;
    }
    return out;
    // The key stands for the creatures, so a new array of the same creatures reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [you, view, key]);
  const blocks = useSrdBlocks(needs.monsters);
  const monsters = { value: blocks.list, failed: blocks.failed };
  const rolls = useRollsChunk(needs.rolls);
  const dice = useMemo(() => (you && view ? { you, view, srd: { monsters: monsters.value, rolls: rolls.value } } : null), [you, view, monsters.value, rolls.value]);
  const waits = (need: boolean, chunk: { value: unknown; failed: boolean }) => need && chunk.value === null && !chunk.failed;
  return { dice, loading: waits(needs.monsters, monsters) || waits(needs.rolls, rolls), failed: (needs.monsters && monsters.failed) || (needs.rolls && rolls.failed) };
}
