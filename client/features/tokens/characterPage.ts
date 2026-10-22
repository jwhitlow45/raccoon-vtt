import { useEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import { uuidv7 } from "#shared/ids.ts";
import type { Character } from "#shared/model.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";

/**
 * The character whose page the Characters panel shows
 * (docs/design-v1-look-pass.md 3.1), per Room page (state/scope.ts), as
 * `journalSlot` holds the open journal page: so the page survives the
 * remount a crossing of 900 px makes, a companion's "Companion of Thorn"
 * opens Thorn's page from the token panel, and "view as a player" keeps
 * its own. `undefined` until the viewer first picks a page or the list,
 * which is when a player with one character lands on its page. `null` is
 * the list.
 */
export const characterPageSlot = scopeSlot(() => createCharacterPageStore());

export function createCharacterPageStore(): StoreApi<CharacterPageState> {
  return createStore<CharacterPageState>(() => ({ characterId: undefined, opened: 0, form: null }));
}

export type CharacterPageState = {
  characterId: string | null | undefined;
  /** How many times a page was opened from outside the panel (openCharacterPage), which a form open in the panel leaves for. */
  opened: number;
  /** The form or list open in the panel's place, kept here for the same remount as the page. */
  form: PanelForm | null;
};

/**
 * New character, Add a companion and a character's stat blocks, each a
 * subpage in the panel's place. Each opening is an instance of its own
 * (`id`), which a remount keeps: a form keeps what it holds as it changes
 * (useKeptDraft), and Add a companion keeps that its Add is on its way
 * (`sending`), so a tablet turned across 900 px opens it again as it was,
 * still busy. An answer touches only the instance that sent it
 * (patchForm). `opened` is the slot's count of outside opens when it
 * opened, and for a form the last one it met since, so a form or list
 * that mounts after an outside open meets that open as a mounted one
 * would, and only once (useLeaveForm, staleList). The stat blocks page is
 * a list and holds nothing typed.
 */
export type PanelForm =
  | { kind: "new"; id: string; opened: number; kept?: KeptDraft }
  | { kind: "companion"; characterId: string; id: string; opened: number; kept?: KeptDraft; sending?: true }
  | { kind: "blocks"; characterId: string; id: string; opened: number };

/** A form's draft with its numbers still being typed folded in, and the draft it opened with, against which Back asks. */
type KeptDraft = { typed: unknown; start: string };

/** Opens a form or the stat blocks page in the panel's place, as a new instance. */
export function openForm(store: StoreApi<CharacterPageState>, form: { kind: "new" } | { kind: "companion" | "blocks"; characterId: string }): void {
  store.setState((s) => ({ form: { ...form, id: uuidv7(), opened: s.opened } }));
}

/** Changes the form instance `id` alone, to null to close it: an instance closed or replaced meanwhile is left as it is. */
export function patchForm(store: StoreApi<CharacterPageState>, id: string, patch: (form: PanelForm) => PanelForm | null): void {
  store.setState((s) => (s.form?.id === id ? { form: patch(s.form) } : {}));
}

/**
 * What the panel reads of the form in its place, each a field of its own
 * for useShallow, so an id holding any character comes back whole. A
 * character id may hold "|", which the schema allows.
 */
export function formFields(s: Pick<CharacterPageState, "form">): { kind: PanelForm["kind"]; characterId: string; id: string; opened: number } | null {
  const form = s.form;
  if (!form) return null;
  return { kind: form.kind, characterId: form.kind === "new" ? "" : form.characterId, id: form.id, opened: form.opened };
}

/** A stat blocks page an outside open has passed since it opened, which gives way to that page, as nothing typed holds it. */
export function staleList(s: Pick<CharacterPageState, "form" | "opened">): boolean {
  return s.form?.kind === "blocks" && s.form.opened !== s.opened;
}

/**
 * A form's starting draft: what the slot kept for this form instance, else
 * `fresh`, and the draft it first opened with, so a form opened again by a
 * remount still asks before it discards what was typed before it. Read
 * once, as the form mounts.
 */
export function useKeptDraft<D>(formId: string, fresh: () => D): { initial: D; start: string } {
  const store = useScoped(characterPageSlot);
  const [kept] = useState(() => {
    const form = store.getState().form;
    const draft = form && form.id === formId && form.kind !== "blocks" ? form.kept : undefined;
    if (draft) return { initial: draft.typed as D, start: draft.start };
    const initial = fresh();
    return { initial, start: JSON.stringify(initial) };
  });
  return kept;
}

/**
 * Writes a form's draft to the slot as it changes. `typed` holds the
 * numbers still being typed (usePendingNumbers): a remount takes away the
 * field that held them before it can commit, so they are kept as if
 * committed, and the form opens again showing them.
 */
export function useKeepDraft(formId: string, typed: unknown, start: string): void {
  const store = useScoped(characterPageSlot);
  const now = JSON.stringify(typed);
  useEffect(() => {
    patchForm(store, formId, (form) => (form.kind === "blocks" ? form : { ...form, kept: { typed: JSON.parse(now) as unknown, start } }));
  }, [store, formId, now, start]);
}

/**
 * Opens a character's page from outside the panel, as a companion's
 * "Companion of Thorn" does. A form open in the panel leaves for it, asking
 * first if it holds typed changes (useLeaveForm), so the press is never lost
 * behind a form, even one for that same character.
 */
export function openCharacterPage(store: StoreApi<CharacterPageState>, characterId: string): void {
  store.setState((s) => ({ characterId, opened: s.opened + 1 }));
}

/** The page that shows: the one picked, while it is one of the viewer's characters, else a player's only character until they pick. */
export function shownPage(picked: string | null | undefined, mine: readonly Pick<Character, "id">[], dm: boolean): string | null {
  if (picked === undefined) return !dm && mine.length === 1 ? (mine[0]?.id ?? null) : null;
  return picked !== null && mine.some((c) => c.id === picked) ? picked : null;
}

/**
 * Where Back's focus goes from a character's page when the row pressed to
 * open it is not there (features/panels.ts PanelHeader `backTo`): its own
 * row, then the rows after it and before it, nearest first, then New
 * character, else the empty list's line. So a page the panel opened onto
 * goes back to its row, and a page deleted from inside it hands focus to
 * its neighbor.
 */
export function pageBackTo(characterId: string, mine: readonly Pick<Character, "id">[]): string[] {
  const at = mine.findIndex((c) => c.id === characterId);
  const neighbors = at < 0 ? [] : [...mine.slice(at + 1), ...mine.slice(0, at).reverse()];
  return [characterId, ...neighbors.map((c) => c.id)].map((id) => `character:${id}`).concat("new-character", "characters-empty");
}

/** What Back and Cancel ask on a form with typed changes, as the encounter editor's Back does. */
export const DISCARD = "Discard changes?";

/**
 * Where a form of the panel goes as it leaves: `back` to where it was
 * opened, by its Back or Cancel, or to the `page` opened from outside it
 * (openCharacterPage).
 */
export type LeaveFor = "back" | "page";

/**
 * Leaving a form of the Characters panel (docs/design-v1-look-pass.md 3.1):
 * with typed changes the first press of Back or Cancel asks DISCARD and the
 * second leaves. A change in between takes the question back, since it was
 * asked of the draft as it stood. `draft` is what the form holds, compared
 * as JSON, with what its number fields would commit (usePendingNumbers).
 *
 * A page opened from outside (`opened`, the slot's count) asks the same
 * question, or leaves at once with nothing typed. A Back or Cancel that
 * answers it goes on to that page, as the press that asked would have. The
 * outside press itself never asks twice: with the question standing, it
 * leaves for its page. `since` is the count when the form opened
 * (PanelForm), so a form a remount opens again after an outside open, as
 * a panel switched away from and back is, meets that open on its mount.
 * Once met, the open is written to the form instance `formId`, so a later
 * remount, such as a turn across 900 px, never meets it again: a form kept
 * after its question asks only when Back or Cancel is pressed.
 */
export function useLeaveForm(formId: string, draft: unknown, changed: boolean, leave: (to: LeaveFor) => void, opened: number, since: number): { asking: boolean; press(): void } {
  const store = useScoped(characterPageSlot);
  const now = JSON.stringify(draft);
  const [asked, setAsked] = useState<{ at: string; to: LeaveFor } | null>(null);
  const asking = changed && asked?.at === now;
  const press = (to: LeaveFor, answers: boolean) => {
    if (changed && !asking) setAsked({ at: now, to });
    else leave(asking && answers && asked ? asked.to : to);
  };
  const seen = useRef(since);
  useEffect(() => {
    if (seen.current === opened) return;
    seen.current = opened;
    patchForm(store, formId, (form) => ({ ...form, opened }));
    press("page", false);
  });
  return { asking, press: () => press("back", true) };
}

/**
 * A form's draft with what its number fields would commit as they stand
 * (NumberField `onPending`). A number field keeps what is typed into it
 * until it loses focus, and a Back or Cancel pressed while it keeps focus,
 * as a press that takes no focus does, would otherwise see the draft
 * without that number: it would leave without asking, or keep asking after
 * the number changed. `pending(key)` is the `onPending` of the field that
 * commits the draft's `key`. `apply` puts numbers into the draft as the
 * form's own commit does, so a field that commits after the question was
 * asked leaves the draft, and the question, as they were.
 */
export function usePendingNumbers<D extends object>(
  draft: D,
  apply: (draft: D, numbers: PendingNumbers<D>) => D = (d, numbers) => ({ ...d, ...numbers }),
): { typed: D; pending(key: NumberKey<D>): (value: number | null | undefined) => void } {
  const [held, setHeld] = useState<PendingNumbers<D>>({});
  return {
    typed: Object.keys(held).length > 0 ? apply(draft, held) : draft,
    pending: (key) => (value) =>
      setHeld((h) => {
        if (value === undefined) {
          if (!(key in h)) return h;
          const rest = { ...h };
          delete rest[key];
          return rest;
        }
        return h[key] === value ? h : { ...h, [key]: value };
      }),
  };
}

/** The draft's fields that hold a number. */
type NumberKey<D> = { [K in keyof D]-?: D[K] extends number | null | undefined ? K : never }[keyof D];

type PendingNumbers<D> = Partial<Pick<D, NumberKey<D>>>;
