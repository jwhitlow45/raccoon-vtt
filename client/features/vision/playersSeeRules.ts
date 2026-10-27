import { viewMapsOf } from "#shared/keys.ts";
import type { LightLevel, RoomState, Scene, ScenePreset } from "#shared/model.ts";
import { LIGHT_LEVELS, lightOf, SIGHT_CHOICES, sightOf } from "./settings.ts";

/**
 * "Players see", one choice of what players get of a scene
 * (docs/design-v1-map-discovery.md 8.1), as plain functions for node
 * --test. Each preset is a pair of the scene's switches, so any scene reads
 * as one, or as Custom for the one pair no preset names: fog off with party
 * vision on.
 */

export type PlayersSee = ScenePreset | "custom";

export type PresetChoice = { value: ScenePreset; label: string; help: string };

export const PLAYERS_SEE: readonly PresetChoice[] = [
  {
    value: "explore",
    label: "Explore",
    help: "Players see what their characters see. Ground they have not seen stays dark, walls and all, and what they explored stays as they last saw it.",
  },
  { value: "reveal", label: "Reveal by hand", help: "Players see what you reveal with the fog tool." },
  { value: "all", label: "Everything", help: "Players see the whole scene." },
];

export const PLAYERS_SEE_NAME = "Players see";

export const CUSTOM_TEXT = "Custom: party vision is on and fog is off, so players see the whole map, dimmed outside what their characters see.";

/** Under Explore on a scene whose map image has no wall that blocks sight (8.1). */
export const WALLLESS_TEXT = "This map has no walls yet, so party vision shows players all of it at once. Add walls first, or choose Reveal by hand.";

/** Move players to another scene, whose build the DM's device does not hold (8.1, MD-O-28). */
export const WALLLESS_ELSEWHERE = "If its map has no walls yet, party vision shows players all of it at once.";

/** Leaving Explore where players explored, from the preset, the switches or the copy sheet (8.1, LK-9). */
export const LEAVE_EXPLORE_TEXT = "Players will see the build as it is now on everything they explored. Undo does not bring back what they remembered.";

/** Per player to Whole party, where players hold maps of their own (8.1). */
export const JOIN_MAPS_TEXT = "Each player's own map joins the party's. Undo does not split them again.";

/** The room default's help, and the new scene form's note when a map image steps down from it (8.2). */
export const IMAGE_STEPS_DOWN = "Under Explore a map image with no walls starts on Reveal by hand, since party vision would show players all of it.";

export function playersSeeOf(scene: Pick<Scene, "fogEnabled" | "vision">): PlayersSee {
  const vision = scene.vision?.on === true;
  if (scene.fogEnabled) return vision ? "explore" : "reveal";
  return vision ? "custom" : "all";
}

export function playersSeeLabel(choice: PlayersSee): string {
  return choice === "custom" ? "Custom" : PLAYERS_SEE.find((p) => p.value === choice)!.label;
}

export type PresetPatch = { fogEnabled: boolean; vision: { on: boolean; light: LightLevel } };

/**
 * The one `scene.update` patch a preset sends (8.1). It names no
 * `perPlayer`, so Sight keeps what it has, and it carries the scene's own
 * light, so Light does too.
 */
export function presetPatch(scene: Pick<Scene, "vision">, preset: ScenePreset): PresetPatch {
  const light = lightOf(scene);
  if (preset === "explore") return { fogEnabled: true, vision: { on: true, light } };
  if (preset === "reveal") return { fogEnabled: true, vision: { on: false, light } };
  return { fogEnabled: false, vision: { on: false, light } };
}

/**
 * Whether a change forgets what players remember of a scene: memory lives
 * only on Explore, and party vision or fog going off drops it (decision 10).
 * Custom has no memory, so leaving it forgets nothing.
 */
export function leavesExplore(from: PlayersSee, to: PlayersSee): boolean {
  return from === "explore" && to !== "explore";
}

type Tiles = Readonly<Record<string, { sceneId: string } | undefined>> | undefined;

function onScene(tiles: Tiles, sceneId: string): boolean {
  return Object.values(tiles ?? {}).some((t) => t?.sceneId === sceneId);
}

/**
 * Whether the DM's view says players explored a scene: the party's layer,
 * or on a per-player scene any holder's, which the DM gets joined
 * (`exploredAny`). The DM's projection holds them only for the scene on
 * the DM's screen, so this answers for that scene alone.
 */
export function exploredHere(view: RoomState, sceneId: string): boolean {
  return onScene(view.exploredTiles, sceneId) || holdersExploredHere(view, sceneId);
}

/** Whether some player holds a map of their own of a per-player scene, by the DM's view of the scene on screen. */
export function holdersExploredHere(view: RoomState, sceneId: string): boolean {
  return onScene(viewMapsOf(view).exploredAny, sceneId);
}

/** What a change of Players see or of its switches asks first, or null when it goes at once. */
export function leaveQuestion(from: PlayersSee, to: PlayersSee, explored: boolean): string | null {
  return explored && leavesExplore(from, to) ? LEAVE_EXPLORE_TEXT : null;
}

/** What the Sight row asks before Per player becomes Whole party, or null: only while some player holds a map of their own here. */
export function sightQuestion(scene: Pick<Scene, "vision">, toPerPlayer: boolean, holdersExplored: boolean): string | null {
  return scene.vision?.perPlayer === true && !toPerPlayer && holdersExplored ? JOIN_MAPS_TEXT : null;
}

/**
 * What "Like <scene>" copies, in a line (8.2): "Explore, Dark, Per player,
 * players' moves blocked". Each part is the word its own control shows.
 */
export function likeSummary(scene: Pick<Scene, "fogEnabled" | "vision" | "blockMovement">): string {
  const light = LIGHT_LEVELS.find((l) => l.value === lightOf(scene))!.label;
  const sight = SIGHT_CHOICES.find((c) => c.value === sightOf(scene))!.label;
  const moves = scene.blockMovement === true ? "players' moves blocked" : "players' moves not blocked";
  return `${playersSeeLabel(playersSeeOf(scene))}, ${light}, ${sight}, ${moves}`;
}

/**
 * Whether Explore on this scene would show players its whole map at once:
 * a map image with nothing on it that can block sight, every door closed
 * and every secret door hidden (rules/walls.ts `sightPotential`).
 */
export function walllessImage(scene: Pick<Scene, "map">, sightPotential: number): boolean {
  return scene.map !== undefined && sightPotential === 0;
}

/**
 * The same for a Universal VTT file before it is a scene: nothing it
 * brings blocks sight, doors counted closed, so only windows or no walls
 * at all. Objects off, or a file of open ground, can do it.
 */
export function walllessFile(features: Iterable<{ kind: string }>): boolean {
  for (const f of features) if (f.kind !== "window") return false;
  return true;
}
