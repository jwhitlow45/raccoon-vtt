import type { RoomState, Scene, SceneId, Token } from "#shared/model.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { ownEntry } from "#shared/records.ts";
import type { FloorFollow } from "../../state/types.ts";
import { ownsEntry } from "../encounter/logic.ts";
import { characterOf, ownsToken } from "../tokens/access.ts";
import { displayFloor } from "./displayFloor.ts";

/*
 * Which floor a device shows (docs/design/design-v1-floors.md 7.3), as pure
 * functions the store runs on every change (state/store.ts), so the rules
 * run under node's test runner. A floor is a scene record, so "the floor
 * shown" is the store's `sceneId`, and "the scene projected" its
 * `projectedSceneId`, the anchor every rule here starts from.
 */

type View = Pick<RoomState, "scenes" | "tokens" | "characters" | "encounter"> & { meta: RoomState["meta"] & { partyFloors?: readonly string[] } };

/**
 * A player's pick in Floors, or a DM's Look here that took them elsewhere:
 * the floor picked, and the floor their followed creature stood on then,
 * so the pick lasts until that creature changes floor (7.3).
 */
export type FloorPick = { sceneId: SceneId; followed: SceneId | null };

export type { FloorFollow };

/**
 * The floors this device holds of the scene projected, bottom first. A DM
 * holds every floor of it. A player's and a display's copy hold exactly
 * their held floors, which floorsOf finds as the delivered floors, or the
 * one scene where they hold one.
 */
export function heldHere(view: Pick<RoomState, "scenes"> | null, anchor: SceneId | null): Scene[] {
  if (view === null || anchor === null) return [];
  return floorsOf(view, anchor);
}

/** A creature, as Floors and the follow count one: anything but an object such as a door or a chest. */
function creature(token: Token): boolean {
  return token.kind !== "object";
}

/** Floor shown first, then lowest first, then player characters before other creatures, then creation order. */
function byPlace(held: readonly Scene[], shown: SceneId | null): (a: Token, b: Token) => number {
  const level = new Map(held.map((s, i) => [s.id, s.id === shown ? -1 : i]));
  const kind = (t: Token) => (t.kind === "pc" ? 0 : 1);
  return (a, b) => (level.get(a.sceneId) ?? 99) - (level.get(b.sceneId) ?? 99) || kind(a) - kind(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The creature a player's device follows (7.3): the selected creature they
 * own, else their character's token on a held floor (the one on the floor
 * shown, else the lowest), else any creature they own there by the same
 * order. Null when they have none on a held floor.
 */
export function followedOf(input: { view: View; memberId: string; held: readonly Scene[]; shown: SceneId | null; selected: readonly string[] }): { tokenId: string; sceneId: SceneId } | null {
  const { view, memberId } = input;
  const floors = new Set(input.held.map((s) => s.id));
  const here = (t: Token | undefined): t is Token => t !== undefined && floors.has(t.sceneId) && creature(t) && ownsToken(view, memberId, t);
  for (const id of input.selected) {
    const token = ownEntry(view.tokens, id);
    if (here(token)) return { tokenId: token.id, sceneId: token.sceneId };
  }
  const own = Object.values(view.tokens).filter(here).sort(byPlace(input.held, input.shown));
  const character = own.find((t) => characterOf(view, t) !== undefined && (characterOf(view, t)?.ownerIds ?? []).includes(memberId));
  const pick = character ?? own[0];
  return pick ? { tokenId: pick.id, sceneId: pick.sceneId } : null;
}

/** Whether the turn that runs now is the player's own and started with this change. */
function turnStarted(before: View | null, view: View, memberId: string): boolean {
  const now = view.encounter?.activeEntryId ?? null;
  if (now === null || now === (before?.encounter?.activeEntryId ?? null)) return false;
  const entry = view.encounter?.entries.find((e) => e.id === now);
  return entry !== undefined && ownsEntry(view, memberId, entry);
}

/** The token whose turn runs now, by its row or its character's token on a held floor. */
function actingToken(view: View, held: ReadonlySet<SceneId>): Token | undefined {
  const entry = view.encounter?.entries.find((e) => e.id === view.encounter?.activeEntryId);
  if (!entry) return undefined;
  if (entry.tokenId !== undefined) return ownEntry(view.tokens, entry.tokenId);
  if (entry.characterId === undefined) return undefined;
  return Object.values(view.tokens).find((t) => held.has(t.sceneId) && "ref" in t.actor && t.actor.ref === entry.characterId);
}

export type FloorInput = {
  role: "dm" | "player";
  /** A table display, whose store holds the player role. */
  display: boolean;
  memberId: string;
  view: View | null;
  /** The view before this change, to tell a creature's move and a turn's start. Null on the first. */
  before: View | null;
  /** The scene projected (RoomView.projectedSceneId). */
  anchor: SceneId | null;
  /** The floor shown before this change, or the one a change asked for. */
  shown: SceneId | null;
  pick: FloorPick | null;
  selected: readonly string[];
  /** A display following the DM: the floor of the DM's latest view, else null. */
  dmFloor: SceneId | null;
  /** A DM device whose camera follows the turn (features/encounter/followTurn.ts). */
  followsTurn: boolean;
};

export type FloorOutput = {
  sceneId: SceneId | null;
  pick: FloorPick | null;
  /** A player's: what their device follows while nothing is picked. Null for a DM and a display. */
  follow: FloorFollow | null;
  /** The creature whose move took the device to the floor it shows now, for the screen reader's "Thorn is on Upper floor." */
  movedBy: string | null;
};

/** The floor a device shows after a change, by its role's rule (7.3). */
export function nextFloor(input: FloorInput): FloorOutput {
  const { view, anchor } = input;
  const held = heldHere(view, anchor);
  const ids = new Set(held.map((s) => s.id));
  const none: FloorOutput = { sceneId: anchor, pick: null, follow: null, movedBy: null };
  if (view === null || held.length === 0) return input.role === "player" && !input.display ? { ...none, follow: { sceneId: anchor, tokenId: null } } : none;
  if (input.display) {
    return { ...none, sceneId: displayFloor({ held, partyFloors: view.meta.partyFloors ?? [], last: input.shown, start: anchor, dm: input.dmFloor }) };
  }
  if (input.role === "dm") return dmFloor(input, view, held, ids);
  return playerFloor(input, view, held, ids);
}

function dmFloor(input: FloorInput, view: View, held: readonly Scene[], ids: ReadonlySet<SceneId>): FloorOutput {
  const anchor = input.anchor;
  let sceneId = input.shown !== null && ids.has(input.shown) ? input.shown : anchor !== null && ids.has(anchor) ? anchor : (held[0]?.id ?? anchor);
  let movedBy: string | null = null;
  // A Move to floor of the selected token follows it (7.3).
  for (const id of input.selected) {
    const was = ownEntry(input.before?.tokens, id)?.sceneId;
    const now = ownEntry(view.tokens, id)?.sceneId;
    if (was === sceneId && now !== undefined && now !== sceneId && ids.has(now)) {
      sceneId = now;
      movedBy = id;
      break;
    }
  }
  // "Camera follows the turn" switches floors with the turn, in the same change, so the board pans to whoever acts on their floor.
  if (input.followsTurn && input.before !== null && (view.encounter?.activeEntryId ?? null) !== (input.before.encounter?.activeEntryId ?? null)) {
    const acting = actingToken(view, ids);
    if (acting !== undefined && ids.has(acting.sceneId)) sceneId = acting.sceneId;
  }
  return { sceneId, pick: null, follow: null, movedBy };
}

function playerFloor(input: FloorInput, view: View, held: readonly Scene[], ids: ReadonlySet<SceneId>): FloorOutput {
  const anchor = input.anchor !== null && ids.has(input.anchor) ? input.anchor : (held[0]?.id ?? null);
  const followed = followedOf({ view, memberId: input.memberId, held, shown: input.shown, selected: input.selected });
  const follow: FloorFollow = { sceneId: followed?.sceneId ?? anchor, tokenId: followed?.tokenId ?? null };
  let pick = input.pick;
  // A pick holds until the followed creature changes floor, the player's turn starts, or the floor is no longer held (7.3).
  if (pick !== null && (!ids.has(pick.sceneId) || pick.followed !== follow.sceneId || turnStarted(input.before, view, input.memberId))) pick = null;
  if (pick !== null && pick.sceneId === follow.sceneId) pick = null;
  const sceneId = pick?.sceneId ?? follow.sceneId;
  let movedBy: string | null = null;
  if (pick === null && followed !== null && sceneId !== input.shown && input.shown !== null) {
    const was = ownEntry(input.before?.tokens, followed.tokenId)?.sceneId;
    if (was !== undefined && was !== followed.sceneId) movedBy = followed.tokenId;
  }
  return { sceneId, pick, follow, movedBy };
}

/**
 * A pick of `sceneId` on a player's device (Floors, `[` and `]`, a tracker
 * tag, a search row, a DM's Look here): null when it is the floor they
 * follow anyway, or not held, or Back.
 */
export function pickOf(sceneId: SceneId | null, follow: FloorFollow | null, held: readonly Scene[]): FloorPick | null {
  if (sceneId === null || !held.some((s) => s.id === sceneId) || sceneId === follow?.sceneId) return null;
  return { sceneId, followed: follow?.sceneId ?? null };
}

/**
 * The floor `by` steps above (1) or below (-1) the floor shown among the
 * held floors, for `]` and `[`, or null at the top or the bottom.
 */
export function floorBeside(held: readonly Scene[], shown: SceneId | null, by: 1 | -1): SceneId | null {
  const at = held.findIndex((s) => s.id === shown);
  if (at < 0) return null;
  return held[at + by]?.id ?? null;
}
