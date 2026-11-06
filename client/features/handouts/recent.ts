import { createStore, type StoreApi } from "zustand/vanilla";
import { handoutPages } from "#shared/handouts.ts";
import type { Handout, HandoutDoc, HandoutPage, Member } from "#shared/model.ts";
import { textSchemas } from "#shared/protocol.ts";
import { ownEntry } from "#shared/records.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { ShowInput } from "./handouts.ts";

/**
 * The handouts this device showed in a room, newest first, five kept
 * (designs/qol plan 3 and 9, D-261106-173). The DM menu's Show <title>,
 * Handouts' Recent list and the form's remembered title read the one list.
 * It lives in this device's storage only and never reaches the room. A
 * re-show goes to the audience the showing had, less the players who have
 * left, and never to more.
 */

export const RECENT_HANDOUTS = 5;

/**
 * What was shown: one image by its asset id, or a whole document by its
 * id, never one of its pages. A document shows every page it holds, so a
 * re-show sends its pages as they are then.
 */
export type RecentPick = { kind: "image"; assetId: string } | { kind: "doc"; docId: string };

/** One showing: what, its title, its audience as the show op's `handoutTo` ("all" or member ids), and when, in ms since the epoch. */
export type RecentHandout = RecentPick & { title: string; to: "all" | string[]; at: number };

/** A showing as it goes out, before it has a time. */
export type RecentShow = RecentPick & { title: string; to: "all" | readonly string[] };

/** What the room holds now, which decides what is still offered. */
export type RecentRoom = {
  members: Readonly<Record<string, Pick<Member, "kind"> | undefined>>;
  handoutDocs: Readonly<Record<string, Pick<HandoutDoc, "pages"> | undefined>>;
  /** The handouts showing now. */
  handouts: Readonly<Record<string, Pick<Handout, "assetId" | "pages"> | undefined>>;
  /**
   * The handout images the library lists, or null before this device has
   * listed them. An image is then offered, and the server's own check on
   * the show decides.
   */
  images: ReadonlySet<string> | null;
};

export function samePick(a: RecentPick, b: RecentPick): boolean {
  return a.kind === "image" ? b.kind === "image" && a.assetId === b.assetId : b.kind === "doc" && a.docId === b.docId;
}

function pickOf(entry: RecentPick): RecentPick {
  return entry.kind === "image" ? { kind: "image", assetId: entry.assetId } : { kind: "doc", docId: entry.docId };
}

/** The list with this showing first. An earlier showing of the same image or document gives way to it, title and audience too. */
export function recordShow(entries: readonly RecentHandout[], show: RecentShow, at: number): RecentHandout[] {
  const entry: RecentHandout = { ...pickOf(show), title: show.title.trim(), to: show.to === "all" ? "all" : [...new Set(show.to)], at };
  return [entry, ...entries.filter((e) => !samePick(e, show))].slice(0, RECENT_HANDOUTS);
}

/** The title this device last showed the image or document with, for the form to start from (chips.md C4), or null. */
export function rememberedTitle(entries: readonly RecentHandout[], pick: RecentPick): string | null {
  return entries.find((e) => samePick(e, pick))?.title ?? null;
}

/**
 * The audience a re-show goes to: everyone, or the chosen players still in
 * the room as players. Null when none is left, since widening it to
 * everyone would show the handout to someone it was never meant for.
 */
function audienceNow(to: RecentHandout["to"], members: RecentRoom["members"]): "all" | string[] | null {
  if (to === "all") return "all";
  const kept = to.filter((id) => ownEntry(members, id)?.kind === "player");
  return kept.length > 0 ? kept : null;
}

/** What a re-show sends: the image, or the document's pages in their order now. Null once it was deleted. */
function shownNow(entry: RecentPick, room: RecentRoom): { assetId: string } | { pages: HandoutPage[] } | null {
  if (entry.kind === "doc") {
    const doc = ownEntry(room.handoutDocs, entry.docId);
    return doc && doc.pages.length > 0 ? { pages: doc.pages } : null;
  }
  return room.images === null || room.images.has(entry.assetId) ? { assetId: entry.assetId } : null;
}

/** Whether a handout showing now holds exactly these pages, one image counting as its one page (library.ts docShowing). */
function showingNow(pages: readonly { assetId: string }[], handouts: RecentRoom["handouts"]): boolean {
  for (const h of Object.values(handouts)) {
    if (!h) continue;
    const shown = handoutPages(h);
    if (shown.length === pages.length && shown.every((p, i) => p.assetId === pages[i]?.assetId)) return true;
  }
  return false;
}

/**
 * The showings still offered, newest first, each with its audience as a
 * re-show would send it. Left out: one whose image or document is gone,
 * one with no chosen player left, and one showing now, which the Showing
 * list already holds with Hide.
 */
export function offerable(entries: readonly RecentHandout[], room: RecentRoom): RecentHandout[] {
  const out: RecentHandout[] = [];
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const to = audienceNow(entry.to, room.members);
    const shown = shownNow(entry, room);
    if (to === null || shown === null) continue;
    if (showingNow("pages" in shown ? shown.pages : [shown], room.handouts)) continue;
    out.push({ ...entry, to });
  }
  return out;
}

/**
 * The show a re-show sends, for handouts.ts showHandoutOp: a new handout
 * id, the same title, the audience still in the room, and the image or the
 * document's pages as they are now. Null where the entry is not offered for
 * being gone or having no one left. Whether it shows now is the list's
 * question (offerable), not this one's.
 */
export function reshowInput(entry: RecentHandout, room: RecentRoom, id: string): ShowInput | null {
  const audience = audienceNow(entry.to, room.members);
  const shown = shownNow(entry, room);
  if (audience === null || shown === null) return null;
  return { id, title: entry.title, audience, ...shown };
}

// ---------------------------------------------------------------- device storage

export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

export function recentKey(roomId: string): string {
  return `rvtt.handoutsRecent.${roomId}`;
}

/** An id as the protocol bounds one (shared/protocol.ts `id`). */
const isId = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 64;

/** One stored entry, each field checked, since anything could have written there. */
function parseEntry(v: unknown): RecentHandout | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const pick: RecentPick | null = r.kind === "image" && isId(r.assetId) ? { kind: "image", assetId: r.assetId } : r.kind === "doc" && isId(r.docId) ? { kind: "doc", docId: r.docId } : null;
  if (!pick || typeof r.title !== "string" || !textSchemas.name.safeParse(r.title).success) return null;
  const to = r.to === "all" ? "all" : Array.isArray(r.to) && r.to.length >= 1 && r.to.length <= 50 && r.to.every(isId) ? [...new Set(r.to as string[])] : null;
  if (to === null || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  return { ...pick, title: r.title, to, at: r.at };
}

/** What storage held, newest first, one entry for each image or document, five at most. Anything unreadable counts as nothing. */
export function parseRecent(raw: string | null): RecentHandout[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentHandout[] = [];
  for (const entry of data.slice(0, 50).map(parseEntry).sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))) {
    if (entry && !out.some((e) => samePick(e, entry))) out.push(entry);
  }
  return out.slice(0, RECENT_HANDOUTS);
}

export function encodeRecent(entries: readonly RecentHandout[]): string {
  return JSON.stringify(entries.slice(0, RECENT_HANDOUTS));
}

function deviceStorage(): RecentStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The room's list on this page, so the DM menu and Handouts show the same one at once. */
export type RecentHandouts = { roomId: string | null; entries: readonly RecentHandout[] };

export const recentHandoutsSlot = scopeSlot(() => createStore<RecentHandouts>(() => ({ roomId: null, entries: [] })));

/** Reads the room's list from storage, once for each room. Storage that is blocked reads as an empty list. */
export function loadRecent(store: StoreApi<RecentHandouts>, roomId: string, storage: RecentStorage | null = deviceStorage()): void {
  if (store.getState().roomId === roomId) return;
  let raw: string | null = null;
  try {
    raw = storage?.getItem(recentKey(roomId)) ?? null;
  } catch {
    // Blocked: the list starts empty and lasts for this page load.
  }
  store.setState({ roomId, entries: parseRecent(raw) });
}

/**
 * Remembers a showing, once the server took it, so a refused show is
 * never offered again. Storage that is blocked or full keeps it for this
 * page load only.
 */
export function rememberShow(store: StoreApi<RecentHandouts>, show: RecentShow, at: number, storage: RecentStorage | null = deviceStorage()): void {
  const { roomId, entries } = store.getState();
  const next = recordShow(entries, show, at);
  store.setState({ entries: next });
  if (roomId === null) return;
  try {
    storage?.setItem(recentKey(roomId), encodeRecent(next));
  } catch {
    // As above.
  }
}
