import type { Handout, HandoutDoc, Member } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { AssetRow } from "../../lib/api.ts";
import { audienceText } from "./handouts.ts";
import type { RecentHandout, RecentPick, RecentRoom, RecentShow } from "./recent.ts";

/*
 * Handouts' Recent list (docs/design/design-v1-qol.md 3, Q11) over Q0's recent.ts:
 * what it reads of the room, and each row's words. Plain functions, for
 * node --test.
 */

/**
 * The room as the list reads it: its members, its documents and what shows
 * now, and the handout images the library lists, or null before this device
 * has listed them, when an image is offered and the server's own check on
 * the show decides (D-261106-208).
 */
export function recentRoomOf(
  view: { members: Record<string, Member | undefined>; handoutDocs: Record<string, HandoutDoc | undefined>; handouts: Record<string, Handout | undefined> },
  library: readonly Pick<AssetRow, "id" | "kind">[] | null,
): RecentRoom {
  return {
    members: view.members,
    handoutDocs: view.handoutDocs,
    handouts: view.handouts,
    images: library ? new Set(library.filter((a) => a.kind === "handout").map((a) => a.id)) : null,
  };
}

/** One entry's key in the list, by what it shows: an image or a document is listed once. */
export function entryKey(entry: RecentPick): string {
  return entry.kind === "image" ? `image:${entry.assetId}` : `doc:${entry.docId}`;
}

/** The audience as a button names it: "everyone", "Pat", "Pat and Ana", "Pat, Ana and Lee". */
function audienceWords(to: RecentHandout["to"], members: Record<string, Member | undefined>): string {
  return to === "all" ? "everyone" : audienceText(to, members);
}

/**
 * A row's words: "Document" under a whole document's title (a document has
 * no page of its own, plan 9), the button that names whom it goes to
 * ("Show to Pat"), and the button's whole name for a screen reader
 * ("Show Cragmaw map to Pat"). The audience is the one a re-show sends,
 * as recent.ts `offerable` gives it, so the button never names a player
 * who has left.
 */
export function recentRowWords(entry: RecentHandout, members: Record<string, Member | undefined>): { detail: string | null; button: string; label: string } {
  const to = audienceWords(entry.to, members);
  return { detail: entry.kind === "doc" ? "Document" : null, button: `Show to ${to}`, label: `Show ${entry.title} to ${to}` };
}

/** The showing a show op makes, for recent.ts `rememberShow` once the server takes it: what it shows, its title as sent and its audience. */
export function shownOf(op: Extract<ClientOp, { t: "handout.show" }>, pick: RecentPick): RecentShow {
  const what: RecentPick = pick.kind === "image" ? { kind: "image", assetId: pick.assetId } : { kind: "doc", docId: pick.docId };
  return { ...what, title: op.handout.title, to: op.handout.to };
}

/** A refused or unsure re-show's words in its row. */
export function reshowProblem(answer: "refused" | "unknown", refusal?: { text?: string; message?: string }): string {
  // One that did show leaves the list, since it shows now, so these words stay only where it did not.
  if (answer === "unknown") return "It may not have shown. Try again.";
  return refusal?.text || refusal?.message || "That handout could not be shown.";
}
