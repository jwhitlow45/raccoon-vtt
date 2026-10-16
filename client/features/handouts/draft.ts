import { createStore } from "zustand/vanilla";
import type { AssetRow } from "../../lib/api.ts";
import { scopeSlot } from "../../state/scope.ts";

/**
 * Show a handout's draft (docs/design-v1-pdf-handouts.md 4.1.1): what is
 * picked, the title, the audience and the chosen players, in the room's
 * scope, so closing the DM panel or switching panels keeps it, and the PDF
 * upload's block can pick the document it saved.
 */

/** What the form shows: one image from the library or an upload, or a document of pages. */
export type Picked = { kind: "image"; asset: AssetRow } | { kind: "doc"; docId: string };

export type HandoutDraft = {
  open: boolean;
  pick: Picked | null;
  title: string;
  /** Whether the DM typed the title, rather than the form filling it in from a pick. */
  titleTyped: boolean;
  audience: "all" | "some";
  chosen: string[];
};

export const EMPTY_DRAFT: HandoutDraft = { open: false, pick: null, title: "", titleTyped: false, audience: "all", chosen: [] };

/**
 * The draft with `pick` picked. A title the DM typed stays. One the form
 * filled in itself, from an earlier pick, gives way to this pick's own
 * title, or to none (the project owner, 2026-10-16: "keeping any title you
 * typed").
 */
export function withPick(draft: HandoutDraft, pick: Picked, pickTitle: string): HandoutDraft {
  return { ...draft, pick, title: draft.titleTyped && draft.title.trim() !== "" ? draft.title : pickTitle, titleTyped: draft.titleTyped && draft.title.trim() !== "" };
}

/** The DM typed in the Title field. Emptied, it counts as not typed, so the next pick fills it. */
export function withTypedTitle(draft: HandoutDraft, title: string): HandoutDraft {
  return { ...draft, title, titleTyped: title.trim() !== "" };
}

export const handoutDraftSlot = scopeSlot(() => createStore<HandoutDraft>(() => EMPTY_DRAFT));
