import { createStore, type StoreApi } from "zustand/vanilla";
import type { Character, CompanionBlock, CustomMonster, StatBlock } from "#shared/model.ts";
import { scopeSlot } from "../../state/scope.ts";

/**
 * The stat block editors open on this page, held apart from whatever opened
 * them (docs/design-v1-companion-stat-blocks.md 6.2). An editor opened from
 * a token's panel, a picker or a character's stat blocks page used to live
 * inside it, so a change that took its opener away took the draft with it:
 * the block deleted or replaced on the token, the companion or its
 * character deleted, or the character no longer the viewer's. Here each
 * editor keeps what it opened with until it is saved or discarded, and
 * EditorHost draws it whatever the room does meanwhile.
 */

export type EditorRequest = {
  /** The room monster being edited, or null for a new one or a character's block. */
  monster: CustomMonster | null;
  initial: StatBlock;
  /** A character's stat block for its companions: the one being edited or null for a new one, and the SRD monster a copy came from. */
  block?: { character: Pick<Character, "id" | "name">; existing: CompanionBlock | null; fromSrd?: string };
  /** Opens with the paste box ready, for "Paste a stat block". */
  paste?: boolean;
  /**
   * Told once the draft is saved, with the block as the view holds it at
   * that moment, for an opener that goes on to use it: a picker chooses it.
   * An opener that has gone since does nothing with it.
   */
  onSaved?(id: string, block: CompanionBlock | undefined): void;
};

export type OpenEditor = EditorRequest & { key: number };

type OpenEditors = { list: readonly OpenEditor[]; next: number };

/** Per page (state/scope.ts): a "view as a player" preview has its own room, and its own editors. */
export const openEditorsSlot = scopeSlot(() => createStore<OpenEditors>(() => ({ list: [], next: 1 })));

/** Opens an editor over the room. Returns its key. */
export function openEditor(store: StoreApi<OpenEditors>, request: EditorRequest): number {
  const key = store.getState().next;
  store.setState((s) => ({ list: [...s.list, { ...request, key }], next: s.next + 1 }));
  return key;
}

export function closeEditor(store: StoreApi<OpenEditors>, key: number): void {
  store.setState((s) => ({ list: s.list.filter((e) => e.key !== key) }));
}
