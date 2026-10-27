import type { LightLevel, Scene } from "#shared/model.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { playersSeeLabel, playersSeeOf } from "./playersSeeRules.ts";
import { lightOf } from "./settings.ts";

/**
 * "Use these settings on other scenes…" (docs/design-v1-map-discovery.md
 * 8.3), as plain functions for node --test: the patch it sends, what each
 * scene's line says the copy does there, and the result's words.
 */

/**
 * What the copy sends to each scene: Players see (fog and party vision),
 * the light and Sight, in one `scene.update`. `perPlayer` is always named,
 * so a per-player copy makes the scene per player and a whole-party one
 * folds it back. Movement and automatic walls stay as they are.
 */
export type CopyPatch = { fogEnabled: boolean; vision: { on: boolean; light: LightLevel; perPlayer: boolean } };

export function copyPatch(source: Pick<Scene, "fogEnabled" | "vision">): CopyPatch {
  return { fogEnabled: source.fogEnabled, vision: { on: source.vision?.on === true, light: lightOf(source), perPlayer: source.vision?.perPlayer === true } };
}

/** Whether a scene already has every setting the copy sets, so nothing need be sent there. */
export function copiesNothing(scene: Pick<Scene, "fogEnabled" | "vision">, patch: CopyPatch): boolean {
  const now = copyPatch(scene);
  return now.fogEnabled === patch.fogEnabled && now.vision.on === patch.vision.on && now.vision.light === patch.vision.light && now.vision.perPlayer === patch.vision.perPlayer;
}

export const COPY_HELP = "Copies Players see, Light and Sight. Movement and walls stay as they are.";
export const COPY_UNDO = "Undo puts the settings back, not players' maps.";
export const PLAYERS_HERE = "The players are here. They see the change at once.";
export const MAPS_RESET = "Players' remembered maps here reset.";
export const MAPS_JOIN = "Each player's own map here joins the party's.";

/**
 * What a scene's line says the copy would do there (8.3). Whether players
 * explored a scene the DM is not looking at is not in the DM's view, so a
 * scene that leaves Explore is always said to reset: saying so where
 * nothing was explored costs a line, and not saying it where something was
 * would surprise the DM.
 */
export function copyNotes(scene: Pick<Scene, "id" | "fogEnabled" | "vision">, patch: CopyPatch, playerSceneId: string | null): string[] {
  const notes: string[] = [];
  if (copiesNothing(scene, patch)) return notes;
  if (scene.id === playerSceneId) notes.push(PLAYERS_HERE);
  const after = playersSeeOf({ fogEnabled: patch.fogEnabled, vision: { on: patch.vision.on, light: patch.vision.light } });
  if (playersSeeOf(scene) === "explore" && after !== "explore") notes.push(MAPS_RESET);
  if (scene.vision?.perPlayer === true && !patch.vision.perPlayer) notes.push(MAPS_JOIN);
  return notes;
}

/** A scene's line under its name: what players see there now, then what the copy would do there. */
export function copyLine(scene: Pick<Scene, "id" | "fogEnabled" | "vision">, patch: CopyPatch, playerSceneId: string | null): string {
  return [`${playersSeeLabel(playersSeeOf(scene))}.`, ...copyNotes(scene, patch, playerSceneId)].join(" ");
}

export function copyTitle(sourceName: string): string {
  return `Use ${sourceName}'s settings on…`;
}

export function copyButtonText(count: number): string {
  return count === 1 ? "Copy to 1 scene" : `Copy to ${count} scenes`;
}

/** One scene's answer. A scene that already had the settings counts as taken with nothing sent. */
export type CopyAnswer = { name: string; answer: OpAnswer; refusal?: Pick<OpRefusal, "message" | "text"> };

/** The refusal's own words as a sentence, or the toast's when it gives none. */
function refusalWords(a: CopyAnswer): string {
  if (a.answer === "unknown") return "The connection dropped before the server answered.";
  const detail = a.refusal?.message.trim().replace(/\.$/, "") ?? "";
  if (!detail) return a.refusal?.text ?? "That could not be done.";
  return `${detail[0]!.toUpperCase()}${detail.slice(1)}.`;
}

/** "Copied to 3 scenes." or "Copied to 2 of 3 scenes. Hall: <the refusal's words>" (8.3). */
/** Every scene took the copy, so the sheet clears its ticks and Copy is not offered again for nothing. */
export function copiedAll(answers: readonly CopyAnswer[]): boolean {
  return answers.every((a) => a.answer === "taken");
}

export function copyResult(answers: readonly CopyAnswer[]): string {
  const taken = answers.filter((a) => a.answer === "taken").length;
  const total = answers.length;
  if (copiedAll(answers)) return total === 1 ? "Copied to 1 scene." : `Copied to ${total} scenes.`;
  const why = answers
    .filter((a) => a.answer !== "taken")
    .map((a) => `${a.name}: ${refusalWords(a)}`)
    .join(" ");
  return `Copied to ${taken} of ${total} ${total === 1 ? "scene" : "scenes"}. ${why}`;
}
