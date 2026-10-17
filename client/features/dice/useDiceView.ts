import { useEffect, useMemo, useState } from "react";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { useRoomView } from "../../state/view.ts";
import { srdNeeds, type DiceView } from "./creature.ts";

/*
 * The view creatureRolls and presetFor read (creature.ts, presets.ts), with
 * the SRD chunks the given creatures need loaded on first need and kept for
 * the page, so a later card for the same creature reads at once.
 */

type Chunk<T> = { value: T | null; failed: boolean; loading?: Promise<void> };
const monsterChunk: Chunk<readonly SrdMonster[]> = { value: null, failed: false };
const rollsChunk: Chunk<SrdRolls> = { value: null, failed: false };

function useChunk<T>(chunk: Chunk<T>, load: () => Promise<T>, wanted: boolean): { value: T | null; failed: boolean } {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!wanted || chunk.value !== null || chunk.failed) return;
    let live = true;
    chunk.loading ??= load().then(
      (value) => {
        chunk.value = value;
      },
      () => {
        // A module that failed to load stays failed for the page, so only a reload tries again (monsters/SrdLoadFailed.tsx).
        chunk.failed = true;
      },
    );
    void chunk.loading.then(() => live && redraw((n) => n + 1));
    return () => {
      live = false;
    };
  }, [chunk, load, wanted]);
  return { value: chunk.value, failed: chunk.failed };
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
  const monsters = useChunk(monsterChunk, loadMonsters, needs.monsters);
  const rolls = useChunk(rollsChunk, loadSrdRolls, needs.rolls);
  const dice = useMemo(() => (you && view ? { you, view, srd: { monsters: monsters.value, rolls: rolls.value } } : null), [you, view, monsters.value, rolls.value]);
  const waits = (need: boolean, chunk: { value: unknown; failed: boolean }) => need && chunk.value === null && !chunk.failed;
  return { dice, loading: waits(needs.monsters, monsters) || waits(needs.rolls, rolls), failed: (needs.monsters && monsters.failed) || (needs.rolls && rolls.failed) };
}
