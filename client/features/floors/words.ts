import type { RoomState, Scene, Token } from "#shared/model.ts";
import type { ProjectedToken } from "#shared/project.ts";
import { displayName } from "../../lib/scene.ts";
import { initials } from "../../lib/tokenView.ts";
import { FLOOR_MARKS, playersAt } from "../scenes/floorWords.ts";
import { ownsToken } from "../tokens/access.ts";
import { sameScene, unhiddenPartyMember } from "#shared/rules/floors.ts";
import { ownEntry } from "#shared/records.ts";

/*
 * The one helper every site that names the players' place uses
 * (docs/design/design-v1-floors.md 18.6, FLR32-OPUS-06): a lost move,
 * Follow me's note, Move players here and Show players, the guarded
 * reveal's refusal, the DM panel's Players' screens, a pin's help.
 */

type Scenes = Pick<RoomState, "scenes">;

/** A floor's place: "Tower · Upper floor" on a scene with floors, the scene's name on one without, "" when it is gone. */
export function placeName(state: Scenes, sceneId: string): string {
  const scene = ownEntry(state.scenes, sceneId);
  if (scene === undefined) return "";
  return scene.floor ? `${scene.name} · ${scene.floor.name}` : scene.name;
}

/**
 * The players' place seen from the floor in view: "another floor" when the
 * two are floors of one scene, else `placeName` of the players' floor.
 */
export function playersPlace(state: Scenes, playersId: string, viewingId: string | null): string {
  if (viewingId !== null && viewingId !== playersId && sameScene(state, playersId, viewingId)) return "another floor";
  return placeName(state, playersId);
}

/**
 * The name of the floor a creature stands on when that is another floor of
 * the scene shown, else null: the tracker row's tag (7.6). A device holds
 * only its own floors, so a creature on a floor it does not hold is not in
 * its copy to name.
 */
export function otherFloorName(state: Scenes, sceneId: string, shownId: string | null): string | null {
  if (shownId === null || sceneId === shownId || !sameScene(state, sceneId, shownId)) return null;
  return ownEntry(state.scenes, sceneId)?.floor?.name ?? null;
}

/** "floor" when the two ids name floors of one scene, else "scene", for words such as "the players are on another scene now". */
export function placeKind(state: Scenes, a: string, b: string): "floor" | "scene" {
  return a !== b && sameScene(state, a, b) ? "floor" : "scene";
}

/** "Showing Upper floor.", the polite status's line for a switch of floors (7.3). */
export function showingLine(floor: string): string {
  return `Showing ${floor}.`;
}

/** "Thorn is on Upper floor. Showing Upper floor.", for a switch that follows a creature's move (7.3). */
export function followedLine(creature: string, floor: string): string {
  return `${creature} is on ${floor}. ${showingLine(floor)}`;
}

/** "Viewing Upper floor.", the Viewing notice's words while a player shows a floor they picked (7.3). */
export function viewingLine(floor: string): string {
  return `Viewing ${floor}.`;
}

/** "Floor: Upper floor. Show another floor", the top bar's Floor button's name (7.2). */
export function floorButtonLabel(floor: string): string {
  return `Floor: ${floor}. Show another floor`;
}

/** What `]` says on the top floor, where it shows nothing new. */
export function noFloorAbove(floor: string): string {
  return floor ? `No floor above ${floor}.` : "No floor above this one.";
}

/** What `[` says on the lowest floor. */
export function noFloorBelow(floor: string): string {
  return floor ? `No floor below ${floor}.` : "No floor below this one.";
}

/** The Floors menu's name, the Floor button's pop-up and sheet (7.2). */
export const FLOORS_GROUP = "Floors";

/** The DM's way from the Floors menu to the Floors settings group. */
export const FLOORS_SETTINGS = "Floors…";

/** A player's mark on their own creature's floor in the Floors menu. */
export const YOU_ARE_HERE = "You are here";

/** The Floor row's title in the Menu panel, where the bar folded the button with View. */
export const FLOOR_ROW = "Floor";

/** " ([ and ])", this device's two keys after a control's words, or nothing where it has no keyboard. */
export function floorKeys(keys: { below: string; above: string } | null): string {
  return keys ? ` (${keys.below} and ${keys.above})` : "";
}

/** The Floor button's tooltip, with this device's two keys where it has a keyboard: "Show another floor ([ and ])". */
export function floorTip(keys: { below: string; above: string } | null): string {
  return `Show another floor${floorKeys(keys)}`;
}

/**
 * The DM's mark of a floor in the Floors menu (7.2), the Floors group's own
 * (scenes/floorWords.ts playersAt), so the menu and the settings never
 * disagree: "Players here" on the start floor and where an unhidden party
 * member stands on the players' scene, "Reached" on another open floor,
 * "Not reached yet" on the rest. A mark records only that a floor is open,
 * whether players reached it or the DM showed it, so both read "Reached".
 */
export function floorStatus(state: Pick<RoomState, "meta" | "tokens" | "scenes" | "openFloors" | "characters">, floorId: string): (typeof FLOOR_MARKS)[keyof typeof FLOOR_MARKS] {
  return FLOOR_MARKS[playersAt(state, { id: floorId })];
}

/** The Viewing notice's button: "Back to Thorn", or the start floor's name where the player has no creature there. */
export function backLabel(to: string): string {
  return `Back to ${to}`;
}

/** The Menu panel's Floor row's detail: "Showing Upper floor. Show another floor of Tower." */
export function floorRowDetail(floor: string, scene: string): string {
  return `Showing ${floor}. Show another floor of ${scene}.`;
}

/** The words under a floor's name, each a mark the row's name carries too. */
export function floorMarks(view: RoomState, floor: Scene, you: { memberId: string; role: "dm" | "player" }, followed: string | null): string[] {
  // By name, so a row reads the same however the tokens were made.
  const here = Object.values(view.tokens)
    .filter((t): t is Token => t !== undefined && t.sceneId === floor.id && t.kind !== "object")
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  if (you.role === "dm") {
    const party = here.filter((t) => unhiddenPartyMember(view, t)).map((t) => initials(displayName(t)));
    return [floorStatus(view, floor.id), ...(party.length > 0 ? [party.join(" ")] : [])];
  }
  // A player's copy holds only what they see, and the party's creatures are the player characters and what players own. Another player's token has no owners there, so the projected party mark stands in for them.
  const party = here.filter((t) => t.kind === "pc" || (t as ProjectedToken).party === true || ownsToken(view, you.memberId, t)).map((t) => displayName(t));
  return [...(followed === floor.id ? [YOU_ARE_HERE] : []), ...(party.length > 0 ? [party.join(", ")] : [])];
}
