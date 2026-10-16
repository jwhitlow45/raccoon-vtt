import type { Handout, HandoutPage, Member } from "#shared/model.ts";
import { MAX_NAME, type ClientOp } from "#shared/protocol.ts";

/**
 * Handouts (features section 16): the DM shows an image to everyone or to
 * chosen players, and it pops up for them. The projection already sends a
 * player only the handouts addressed to them (design 7.3), so the client
 * decides only which one to pop up and when.
 */

/**
 * A handout shown again replaces the old one in place with a new `shownAt`
 * (shared/reducer/misc.ts), so the key includes it: dismissing one showing
 * does not hide the next.
 */
export function showingKey(h: Pick<Handout, "id" | "shownAt">): string {
  return `${h.id}@${h.shownAt}`;
}

/**
 * The handout to pop up now: the most recently shown one this device has
 * not closed. `preferId` is one the player asked to see again from the
 * Library, which goes first while it stays open.
 */
export function nextPopup(handouts: Record<string, Handout | undefined>, dismissed: ReadonlySet<string>, preferId: string | null = null): Handout | null {
  const preferred = preferId ? handouts[preferId] : undefined;
  if (preferred && !dismissed.has(showingKey(preferred))) return preferred;
  let best: Handout | null = null;
  for (const h of Object.values(handouts)) {
    if (!h || dismissed.has(showingKey(h))) continue;
    if (!best || h.shownAt > best.shownAt || (h.shownAt === best.shownAt && h.id > best.id)) best = h;
  }
  return best;
}

/**
 * Whether the handout popup shows now. The X-card is never covered
 * (docs/design-v1-dm-tools.md 3.11): both are modal dialogs, and the one
 * opened last draws on top, so a handout that would open or reopen while a
 * card shows (the DM shows one, or a pause ends) waits until the card is
 * dismissed. A popup already open stays open, under the card that opened
 * over it, and goes on to the next handout as usual.
 */
export function popupShows(input: { handout: boolean; open: boolean; xcard: boolean }): boolean {
  return input.handout && (input.open || !input.xcard);
}

/**
 * The handouts this device closed, kept on the device so a reload does not
 * pop every one up again. Only keys of handouts still showing are worth
 * keeping: one the DM closed, or showed anew under a new key, drops out.
 */
export function keepShowing(dismissed: ReadonlySet<string>, handouts: Record<string, Handout | undefined>): Set<string> {
  const showing = new Set(Object.values(handouts).flatMap((h) => (h ? [showingKey(h)] : [])));
  return new Set([...dismissed].filter((k) => showing.has(k)));
}

/** The closed set as stored, and back. Anything unreadable counts as nothing closed. */
export function encodeDismissed(dismissed: ReadonlySet<string>): string {
  return JSON.stringify([...dismissed]);
}

export function decodeDismissed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((k): k is string => typeof k === "string" && k.length <= 200).slice(0, 100) : []);
  } catch {
    return new Set();
  }
}

/** Who a handout is shown to, for the DM's list. */
export function audienceText(to: Handout["to"], members: Record<string, Member | undefined>): string {
  if (to === "all") return "Everyone";
  const names = to.map((id) => members[id]?.name ?? "a former player");
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One image by its id, as every handout from before PDFs, or a document's pages in order (docs/design-v1-pdf-handouts.md 8.2). */
export type ShowInput = { id: string; title: string; audience: "all" | string[] } & ({ assetId: string } | { pages: readonly HandoutPage[] });

/** The op that shows a handout, or why it cannot be sent yet. */
export function showHandoutOp(input: ShowInput): { ok: true; op: Extract<ClientOp, { t: "handout.show" }> } | { ok: false; error: string } {
  const title = input.title.trim();
  if (title === "") return { ok: false, error: "Give the handout a title." };
  if (title.length > MAX_NAME) return { ok: false, error: `At most ${MAX_NAME} characters.` };
  if (input.audience !== "all" && input.audience.length === 0) return { ok: false, error: "Pick at least one player, or everyone." };
  const to = input.audience === "all" ? "all" : [...new Set(input.audience)];
  // A copy of the document's pages, so the showing never changes with the document (section 3.2).
  const shown = "pages" in input ? { pages: input.pages.map((p) => ({ assetId: p.assetId, width: p.width, height: p.height })) } : { assetId: input.assetId };
  return { ok: true, op: { t: "handout.show", handout: { id: input.id, ...shown, title, to } } };
}

/**
 * A page's one name, wherever it is read: its image's `alt`, or its
 * placeholder's label before it loads, "Strange letter, page 2 of 5"
 * (docs/design-v1-pdf-handouts.md 5.7). One image is named by the title alone.
 */
export function pageName(title: string, index: number, count: number): string {
  return count > 1 ? `${title}, page ${index + 1} of ${count}` : title;
}

/** "12 pages", for a handout's or a document's row. */
export function pageCountText(count: number): string {
  return count === 1 ? "1 page" : `${count} pages`;
}

/** A starting title from an uploaded file's name: "old-map_v2.jpg" becomes "old map v2". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return base.slice(0, MAX_NAME);
}
