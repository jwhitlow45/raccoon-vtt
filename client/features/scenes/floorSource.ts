import { LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import type { OpOf } from "#shared/protocol.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { ownEntry } from "#shared/records.ts";
import { DEFAULT_GRID, MAT_BACKGROUND, type SceneInput } from "./create.ts";
import { addBetweenRefusal, addRefusal } from "./floorWords.ts";

/*
 * A floor from a Universal VTT file or a generated dungeon
 * (docs/design/design-v1-floors.md phase 3, 3.1 and 3.6): the one
 * `scene.create` that makes it, built from the scene its source would
 * have made, so the import and the generator each build their scene as
 * they always do and only the first op changes.
 */

/** Where a new floor goes: just above or below the floor `beside`. */
export type FloorTarget = { beside: string; side: "above" | "below" };

/**
 * How the new floor's fog and vision start. "like" sends none, so the
 * floor copies the floor beside as the add applies it, Time of day and Per
 * player included: Like the floor beside with its light untouched. "own"
 * sends the scene's whole, so a co-DM's edit of the floor beside before
 * the add applies never changes it: every other pick, even one equal to
 * the floor beside (D-261110-110).
 */
export type FloorSight = "like" | "own";

/**
 * A floor's name from a file's or a theme's: cut to the floor name limit
 * by code point, so no character splits, and trimmed. Empty means the add
 * sends no name and the reducer names it "New floor".
 */
export function floorNameOf(text: string): string {
  return Array.from(text.trim()).slice(0, LIMITS.floorNameChars).join("").trim();
}

/**
 * The add of a floor from `scene`, the scene its source would have made.
 * `own` takes the scene's size, background, grid look, automatic walls,
 * map and file mark. Under "own" it takes fog as a new scene would start
 * it, and the vision with `byClock: false`, so a floor beside on Time of
 * day never relights it, and a pick that names no vision sends the vision
 * of a new scene that has none (E6). The reducer numbers a taken name.
 */
export function floorCreateOf(scene: SceneInput, target: FloorTarget, name: string, sight: FloorSight): OpOf<"scene.create"> {
  const own: NonNullable<NonNullable<OpOf<"scene.create">["floor"]>["own"]> = {
    bounds: scene.bounds,
    background: scene.background ?? MAT_BACKGROUND,
    grid: scene.grid ?? DEFAULT_GRID,
    // Absent reads as "all" on a new scene, so a floor beside with Automatic walls off never takes a dungeon's walls away.
    autoWalls: scene.autoWalls ?? "all",
  };
  if (scene.map !== undefined) own.map = scene.map;
  if (scene.gridFromFile) own.gridFromFile = true;
  if (sight === "own") {
    const vision = scene.vision ?? { on: false, light: "bright" as const };
    own.fogEnabled = scene.fogEnabled ?? (scene.map !== undefined || vision.on);
    own.vision = { on: vision.on, light: vision.light, ...(vision.perPlayer ? { perPlayer: true } : {}), byClock: false };
  }
  const floorName = floorNameOf(name);
  return {
    t: "scene.create",
    scene: { id: scene.id, name: scene.name, bounds: scene.bounds },
    floor: { beside: target.beside, side: target.side, ...(floorName === "" ? {} : { name: floorName }), own },
  };
}

/** Why no floor can be added while the room holds the most scenes it may (3.5). */
export const SCENES_FULL = `A room holds at most ${LIMITS.scenesPerRoom} scenes. Delete one to add another.`;

/**
 * Why a floor cannot go at `target` now, or null: the scene's floor count,
 * stairs it would come between, and the room's scene count, each in the
 * Floors group's words (3.5). The import and the generator ask on the
 * latest view before an upload and again after it, so an add a change made
 * meanwhile refuses sends nothing (3.6). A floor beside that is gone gives
 * null, and the server's refusal says so.
 */
export function floorAddRefusal(view: Pick<RoomState, "scenes" | "floorLinks">, target: FloorTarget): string | null {
  const beside = ownEntry(view.scenes, target.beside);
  if (!beside) return null;
  const floors = floorsOf(view, beside.id);
  // Every floor carries the scene's name, as the Floors group reads it.
  return (
    addRefusal(floors.length, beside.name) ??
    addBetweenRefusal(view, floors, beside.id, target.side) ??
    (Object.keys(view.scenes).length >= LIMITS.scenesPerRoom ? SCENES_FULL : null)
  );
}
