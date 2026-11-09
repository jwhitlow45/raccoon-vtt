import type { RoomState, Scene } from "#shared/model.ts";
import { FLOOR_HEIGHT } from "#shared/protocol.ts";
import { LIMITS } from "#shared/limits.ts";
import { FLOOR_WORDS, floorsOf, onPlayersScene, startFloor, unhiddenPartyMember } from "#shared/rules/floors.ts";
import { ownEntry } from "#shared/records.ts";

/*
 * The words and rules of the Floors group and a floor's page
 * (docs/design/design-v1-floors.md 7.1), as plain functions for node --test.
 * What is on or off here only mirrors the server, which refuses for real
 * (shared/permissions.ts): it keeps the buttons honest and gives the reason.
 */

type View = Pick<RoomState, "scenes" | "tokens" | "meta" | "characters" | "openFloors">;

/** Where the players stand with a floor, for its row and its page. */
export type PlayersAt = "here" | "reached" | "not";

/**
 * Whether the players are on the floor: it is the start floor, or a floor
 * of the players' scene where a party member the DM has not hidden stands
 * (the two things D-261102-482 lets open a floor by themselves). A party
 * member on a floor of a scene the DM prepares in private opens nothing,
 * so the players are not there.
 */
export function playersHere(view: View, floor: Pick<Scene, "id">): boolean {
  if (startFloor(view) === floor.id) return true;
  return onPlayersScene(view, floor.id) && partyOn(view, floor);
}

/** Whether a party member the DM has not hidden stands on the floor, on any scene, as the server's Remove refusal reads it (shared/permissions.ts partyOn). */
function partyOn(view: View, floor: Pick<Scene, "id">): boolean {
  return Object.values(view.tokens).some((t) => t !== undefined && t.sceneId === floor.id && unhiddenPartyMember(view as RoomState, t));
}

export function playersAt(view: View, floor: Pick<Scene, "id">): PlayersAt {
  if (playersHere(view, floor)) return "here";
  // By its opened mark, which stays while the players are on another scene, so the floor is open again when they come back and Hide from players still closes it.
  return ownEntry(view.openFloors, floor.id) !== undefined ? "reached" : "not";
}

/** A floor row's mark. "Reached" stands for a floor the players were on or the DM showed: one opened mark says both. */
export const FLOOR_MARKS = { here: "Players here", reached: "Reached", not: "Not reached yet" } as const satisfies Readonly<Record<PlayersAt, string>>;

/** The floors of a scene, top first, as the group lists them. */
export function floorsTopFirst(view: Pick<View, "scenes">, sceneId: string): Scene[] {
  return floorsOf(view, sceneId).slice().reverse();
}

/**
 * The tag on the floor on the DM's screen. "Shown" read as shown to players beside Show to players and Hide from
 * players (D-261108-379), so the words say where the floor is: on this screen.
 */
export const ON_SCREEN = "On screen";

/** The floor page's button that puts the floor on the DM's own screen, named apart from Show to players (D-261108-380). */
export const GO_TO_FLOOR = "Go to this floor";

/** A floor row's accessible name: "Upper floor, Not reached yet, on screen. Open its page". */
export function floorRowLabel(name: string, mark: string, onScreen: boolean): string {
  return `${name}, ${mark}${onScreen ? `, ${ON_SCREEN.toLowerCase()}` : ""}. Open its page`;
}

/** The group's folded summary: "One floor" or "3 floors · Upper floor on screen". */
export function floorsSummary(floors: readonly Scene[], shownId: string | null): string {
  if (floors.length < 2) return "One floor";
  const shown = floors.find((f) => f.id === shownId);
  return shown?.floor ? `${floors.length} floors · ${shown.floor.name} ${ON_SCREEN.toLowerCase()}` : `${floors.length} floors`;
}

/** Under This scene, once the scene has floors: every other group sets the floor on screen. */
export function floorSettingsLine(floorName: string): string {
  return `The groups below set ${floorName}. Each floor keeps its own.`;
}

export const SHOW_HELP = "Players get a floor once a party member stands on it, or once you show it.";

/** A floor's page: where the players stand, in a sentence. */
export const PLAYERS_LINES: Readonly<Record<PlayersAt, string>> = {
  here: "Players are here.",
  reached: "Players have reached this floor.",
  not: "Players have not reached this floor.",
};

/**
 * Why Hide from players is off, or null. Hide closes a floor opened by mistake, and never one the players stand on,
 * read as the floor's mark reads it: on a scene the DM prepares in private a party member opens nothing, so Hide goes.
 */
export function hideRefusal(view: View, floor: Scene): string | null {
  if (startFloor(view) === floor.id) return "The players start here.";
  if (playersHere(view, floor)) return `Players are on ${floor.floor?.name ?? floor.name}.`;
  return null;
}

/** Why Remove floor is off, or null, in the words of 7.1. */
export function removeRefusal(view: View, floor: Scene): string | null {
  const name = floor.floor?.name ?? floor.name;
  if (floor.floor?.of === floor.id) return `${floor.name} was made with this floor. Delete ${floor.name} from its menu to remove every floor.`;
  if (startFloor(view) === floor.id) return "The players start here. Move the players to another floor first.";
  if (partyOn(view, floor)) return `Move the party off ${name} first.`;
  return null;
}

/** The order after Move up (`-1`) or Move down (`1`) for `id`, bottom first, or null at the end of the stack. */
export function orderAfterMove(floors: readonly Pick<Scene, "id">[], id: string, up: boolean): string[] | null {
  const ids = floors.map((f) => f.id);
  const at = ids.indexOf(id);
  const to = up ? at + 1 : at - 1;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  const next = ids.slice();
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/** Height above the floor below: the stepper's next value, or null at its end. */
export function stepHeight(height: number, direction: 1 | -1): number | null {
  const next = height + direction * FLOOR_HEIGHT.step;
  return next < FLOOR_HEIGHT.min || next > FLOOR_HEIGHT.max ? null : next;
}

/** A floor's height as the group reads it, 10 ft when none is stored. */
export function heightOf(floor: Pick<Scene, "floor">): number {
  return floor.floor?.height ?? FLOOR_HEIGHT.initial;
}

/** Why the scene cannot take another floor, or null. */
export function addRefusal(count: number, sceneName: string): string | null {
  return count >= LIMITS.floorsPerScene ? FLOOR_WORDS.tooMany(sceneName) : null;
}
