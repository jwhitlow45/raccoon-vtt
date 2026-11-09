import { LIMITS } from "../limits.ts";
import type { CellRect, FloorLink, FloorLinkId, RoomState, SceneId, Token, Viewer } from "../model.ts";
import { FLOOR_HEIGHT } from "../protocol.ts";
import { ownEntry } from "../records.ts";

/*
 * Stairs and ladders between floors (docs/design/design-v1-floors.md phase
 * 2): the questions the reducer, permissions, the floor checks, the
 * projection and the builder's draft each ask of an end, and the words
 * every refusal of them reads.
 *
 * Every question works on the server's state and on a device's projected
 * copy. A DM's copy holds every end as stored. A player's copy holds only
 * the ends on floors they hold, cut to ProjectedFloorLink: no pair, ground
 * or seq, `to` only while they hold that floor, and `dir` in its place.
 */

/** An end as any copy holds it: the stored record, or a player's cut with `dir`. */
export type LinkEnd = Pick<FloorLink, "id" | "rev" | "sceneId" | "rect" | "kind" | "locked" | "grid"> & { to?: SceneId; dir?: "up" | "down" };

/** What `floorLink.put` names: the two ends' ids, the two floors, the squares and the kind. */
export type LinkDraft = { id: FloorLinkId; pairId: FloorLinkId; sceneId: SceneId; to: SceneId; rect: CellRect; kind: FloorLink["kind"] };

/** Whether a creature on an end may take it (6.1): it fits, it fits only squeezed, or it is too big. */
export type Stand = "on" | "squeeze" | "tooBig";

/** "stairs" or "ladder", as the words name it. */
type Kind = FloorLink["kind"];

const them = (kind: Kind) => (kind === "stairs" ? "them" : "it");

/** The words of every refusal of stairs and ladders (docs/design/design-v1-floors.md 6.3, 7.3, 8). */
export const LINK_WORDS = {
  /** An end gone, fogged, on a floor not held or not under the creature: one code, one text (4). */
  noStairs: "There are no stairs here.",
  carried: (name: string, kind: Kind) => `${name} is carried. Its holder takes the ${kind === "stairs" ? "stairs" : "ladder"}.`,
  locked: "It's locked.",
  tooBigSqueeze: (kind: Kind) => `Too big for ${kind === "stairs" ? "these stairs" : "this ladder"}. Squeeze to fit.`,
  tooBig: (kind: Kind) => `Too big for ${kind === "stairs" ? "these stairs" : "this ladder"}.`,
  /** The reason a climb's undo or redo is refused, after the label the actor puts before it. */
  changed: (kind: Kind) => (kind === "stairs" ? "the stairs changed" : "the ladder changed"),
  // The builder's refusals of a draft (7.3).
  wall: (floor: string) => `A wall crosses those squares on ${floor}.`,
  twoHeights: (floor: string) => `Those squares aren't one height on ${floor}.`,
  pit: (floor: string) => `A pit trap lies under those squares on ${floor}.`,
  pastEdge: (floor: string) => `${floor} ends before those squares.`,
  overEnd: (kind: Kind, floor: string) => `Those squares already have ${kind === "stairs" ? "stairs" : "a ladder"} to ${floor}.`,
  tooMany: (scene: string) => `${scene} has ${LIMITS.floorLinksPerScene} stairs and ladders, the most a scene can hold.`,
  notNext: "Stairs join a floor and the floor just above or below it.",
  // A later edit floorProblem refuses (3), each ending in REMOVE_FIRST or REMOVE_BETWEEN, which isStairsRefusal reads.
  changeGround: (kind: Kind, floor: string) => `That would change the ground under the ${kind === "stairs" ? "stairs" : "ladder"} to ${floor}. ${removeFirst(kind)}`,
  block: (kind: Kind, floor: string) => `That would block the ${kind === "stairs" ? "stairs" : "ladder"} to ${floor}. ${removeFirst(kind)}`,
  between: (kind: Kind, lower: string, upper: string) =>
    `${kind === "stairs" ? "Stairs join" : "A ladder joins"} ${lower} and ${upper}. ${kind === "stairs" ? "Remove them" : "Remove it"} before putting a floor between.`,
  /** A pit trap's create or update over an end, in the trap pane's words (3). */
  pitUnder: (kind: Kind) => `A pit can't open under ${kind === "stairs" ? "stairs" : "a ladder"}. ${removeFirst(kind)}`,
} as const;

function removeFirst(kind: Kind): string {
  return `Remove ${them(kind)} first.`;
}

/** The sentence a restore's stairs refusal reads in place of "Remove them first." (8): true whoever placed them. */
function placerCan(kind: Kind): string {
  return kind === "stairs" ? "The DM who placed them can remove them." : "The DM who placed it can remove it.";
}

const STAIRS_ENDINGS = [/ Remove them first\.$/, / Remove it first\.$/, / Remove them before putting a floor between\.$/, / Remove it before putting a floor between\.$/];

/** Whether a refusal is one of floorProblem's stairs rules (8, D-261109-108), so a DM's refused undo or redo keeps its step. */
export function isStairsRefusal(message: string): boolean {
  return STAIRS_ENDINGS.some((ending) => ending.test(message));
}

/**
 * A stairs refusal in a restore's words (8): "Remove them first." becomes
 * "The DM who placed them can remove them.", and "Stairs join Ground floor
 * and Upper floor. Remove them before…" keeps its first sentence before
 * it. Any other message comes back as it is.
 */
export function restoreStairsWords(message: string): string {
  for (const ending of STAIRS_ENDINGS) {
    if (!ending.test(message)) continue;
    const kind: Kind = /Remove them/.test(message) ? "stairs" : "ladder";
    return `${message.replace(ending, "")} ${placerCan(kind)}`;
  }
  return message;
}

/**
 * The label of a climb's undo step (6.3), without "Undo": "moving Thorn up
 * the stairs". The undo labels read it for the step and its refusals.
 */
export function climbLabel(name: string, dir: "up" | "down", kind: Kind): string {
  return `moving ${name} ${dir} the ${kind === "stairs" ? "stairs" : "ladder"}`;
}

/** The labels of the builder's undo steps (7.2), without "Undo": "placing stairs to Upper floor". */
export const LINK_LABELS = {
  placed: (kind: Kind, floor: string) => `placing ${kind === "stairs" ? "stairs" : "a ladder"} to ${floor}`,
  removed: (kind: Kind, floor: string) => `removing ${kind === "stairs" ? "stairs" : "a ladder"} to ${floor}`,
  lock: (kind: Kind, locked: boolean) => `${locked ? "locking" : "unlocking"} the ${kind === "stairs" ? "stairs" : "ladder"}`,
  kind: (from: Kind) => (from === "stairs" ? "changing stairs to a ladder" : "changing a ladder to stairs"),
} as const;

/** The ends on a floor, by id order, so every reader walks them alike. */
export function linksOn(state: Pick<RoomState, "floorLinks">, sceneId: SceneId): FloorLink[] {
  return Object.values(state.floorLinks ?? {})
    .filter((link) => link.sceneId === sceneId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The way an end leads (2): up where `to` lies above its floor. A player's
 * copy carries `dir`, worked out on the server from levels it never sends.
 * Null where neither floor reads a level.
 */
export function linkDir(state: Pick<RoomState, "scenes">, link: LinkEnd): "up" | "down" | null {
  if (link.dir !== undefined) return link.dir;
  if (link.to === undefined) return null;
  const here = ownEntry(state.scenes, link.sceneId)?.floor?.level;
  const there = ownEntry(state.scenes, link.to)?.floor?.level;
  if (here === undefined || there === undefined || here === there) return null;
  return there > here ? "up" : "down";
}

/**
 * The height an end climbs (5.1, D-261109-100): the upper floor's
 * `floor.height`, FLOOR_HEIGHT.initial where it stores none, as the floor's
 * page reads it. Only the server's state and a DM's copy hold heights.
 */
export function linkHeight(state: Pick<RoomState, "scenes">, link: Pick<FloorLink, "sceneId" | "to">): number {
  const here = ownEntry(state.scenes, link.sceneId)?.floor;
  const there = ownEntry(state.scenes, link.to)?.floor;
  const upper = (there?.level ?? 0) > (here?.level ?? 0) ? there : here;
  return upper?.height ?? FLOOR_HEIGHT.initial;
}

/** The one ground height of the squares on a floor, or null where they are not one height. FL2-A's rules commit builds it. */
export function rectGround(_chunks: RoomState["buildChunks"], _sceneId: SceneId, _rect: CellRect): number | null {
  throw new Error("rectGround: not built yet");
}

/** Whether a wall, door or window crosses inside the squares on a floor. FL2-A's rules commit builds it. */
export function wallInside(_state: RoomState, _sceneId: SceneId, _rect: CellRect): boolean {
  throw new Error("wallInside: not built yet");
}

/** A trap whose rig opens a pit and whose zone overlaps the squares on a floor, or null. FL2-A's rules commit builds it. */
export function pitUnder(_state: RoomState, _sceneId: SceneId, _rect: CellRect): string | null {
  throw new Error("pitUnder: not built yet");
}

/**
 * Whether a creature stands on an end (6.1), on its snapped footprint, as
 * the viewer's copy reads it: "on" where its space lies inside the
 * squares at their ground, "squeeze" or "tooBig" where its space overlaps
 * them and is too big, and null where it is not on them. FL2-A's rules
 * commit builds it.
 */
export function standsOn(_view: RoomState, _viewer: Viewer, _token: Token, _link: LinkEnd): Stand | null {
  throw new Error("standsOn: not built yet");
}

/** A climb's leg (5.1): feet moved and feet taken off the creature's speed. FL2-A's rules commit builds it. */
export function climbCost(_state: RoomState, _token: Token, _link: FloorLink): { moved: number; cost: number } {
  throw new Error("climbCost: not built yet");
}

/** The first rule of section 3 a draft breaks, in the builder's words (7.3), or null. FL2-A's rules commit builds it. */
export function linkProblem(_state: RoomState, _draft: LinkDraft): string | null {
  throw new Error("linkProblem: not built yet");
}

/**
 * The stairs' half of floorProblem (rules/floors.ts, 3): the first rule an
 * end on the floor's scene breaks, in the DM's words, or null. A one-state
 * check, so it holds after every op, undo, redo, restore and import.
 * FL2-A's rules commit builds it.
 */
export function linksProblem(_state: RoomState, _sceneId: SceneId): string | null {
  return null;
}
