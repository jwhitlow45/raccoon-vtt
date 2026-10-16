import { createStore } from "zustand/vanilla";
import type { HandoutDoc } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { AssetRow } from "../../lib/api.ts";
import { scopeSlot } from "../../state/scope.ts";
import { showHandoutOp, type ShowInput } from "./handouts.ts";

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

/**
 * The op that shows a document whole (8.2): its pages under a new handout
 * id, with the title and audience checked as for one image.
 */
export function showDocOp(input: Omit<ShowInput, "assetId">, doc: Pick<HandoutDoc, "pages">): { ok: true; op: Extract<ClientOp, { t: "handout.show" }> } | { ok: false; error: string } {
  const first = doc.pages[0];
  if (!first) return { ok: false, error: "That handout has no pages." };
  const checked = showHandoutOp({ ...input, assetId: first.assetId });
  if (!checked.ok) return checked;
  const { assetId: _first, ...rest } = checked.op.handout as { assetId: string; id: string; title: string; to: "all" | string[] };
  return { ok: true, op: { t: "handout.show", handout: { ...rest, pages: doc.pages.map(({ assetId, width, height }) => ({ assetId, width, height })) } } };
}
