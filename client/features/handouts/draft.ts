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
  audience: "all" | "some";
  chosen: string[];
};

export const EMPTY_DRAFT: HandoutDraft = { open: false, pick: null, title: "", audience: "all", chosen: [] };

export const handoutDraftSlot = scopeSlot(() => createStore<HandoutDraft>(() => EMPTY_DRAFT));
