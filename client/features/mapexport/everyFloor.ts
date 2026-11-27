import { useMemo } from "react";
import type { RoomState, Scene } from "#shared/model.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { useRoomView } from "../../state/view.ts";
import { playersAt } from "../scenes/floorWords.ts";
import type { ExportView } from "./content.ts";
import { hasBuildOn } from "./content.ts";
import { floorEntryName } from "./fileName.ts";
import { EVERY_FLOOR_PIXELS, exportSize, type ExportLimits } from "./size.ts";
import { storedZip } from "./zipStore.ts";

/*
 * Export every floor (docs/design/design-v1-floors.md phase 4, 9.3,
 * D-261119-055): on a scene with floors, Export as image makes one picture
 * of each floor and saves them as one zip. The DM view holds every floor.
 * The player view holds only the floors players have reached, as the
 * Floors group marks them (scenes/floorWords.ts playersAt), numbered among
 * themselves, so a player's file shows no gap where a floor they have not
 * reached sits. Each floor's picture is made as Export as image makes one.
 *
 * It reads every floor of the scene from the whole view, where the board
 * reads the floor cut (canvas/floorViewReads.test.ts lists it as skipped).
 */

export type FloorsChoice = "this" | "every";

type View = Pick<RoomState, "scenes" | "tokens" | "meta" | "characters" | "openFloors">;


/** The floors Every floor puts in the file, bottom first, and how many the scene has. */
export function exportedFloors(view: View, sceneId: string, version: ExportView): { floors: Scene[]; total: number } {
  const all = floorsOf(view, sceneId);
  return { floors: version === "dm" ? all : all.filter((floor) => playersAt(view, floor) !== "not"), total: all.length };
}

export type FloorEntry = { floor: Scene; name: string };

/** Each floor's picture's name in the zip, numbered among the floors it holds, lowest first. */
export function floorEntries(floors: readonly Scene[]): FloorEntry[] {
  return floors.map((floor, i) => ({ floor, name: floorEntryName(i + 1, floorName(floor)) }));
}

export function floorName(floor: Pick<Scene, "name" | "floor">): string {
  return floor.floor?.name ?? floor.name;
}

/**
 * Whether every floor fits at the scale the DM chose: each picture within
 * what one export may draw, at that scale exactly, and all of them within
 * EVERY_FLOOR_PIXELS. One export lowers its scale to fit, but the floors
 * of a file stay at one scale, so they still line up when stacked.
 */
export function everyFloorFits(floors: readonly Pick<Scene, "bounds">[], pxPerCell: number, limits?: ExportLimits): boolean {
  let total = 0;
  for (const floor of floors) {
    const size = exportSize(floor.bounds, pxPerCell, limits);
    if (size.pxPerCell < size.requested) return false;
    total += size.width * size.height;
  }
  return total <= EVERY_FLOOR_PIXELS;
}

/**
 * One scale for every floor of Export as VTT file's Every floor
 * (D-261127-352): the largest whole pixels a square, at most `requested`,
 * at which every floor fits unlowered and all of them fit together, or 0
 * when even 1 px does not. The floors keep one scale, so they still line
 * up when stacked, and a long scene that no offered scale fits still
 * exports.
 */
export function everyFloorScale(floors: readonly Pick<Scene, "bounds">[], requested: number, limits?: ExportLimits): number {
  for (let px = Math.floor(requested); px >= 1; px--) if (everyFloorFits(floors, px, limits)) return px;
  return 0;
}

/** The size the floors share, or null where floors made from files differ. */
export function sharedBounds(floors: readonly Pick<Scene, "bounds">[]): { w: number; h: number } | null {
  const first = floors[0]?.bounds;
  if (!first) return null;
  return floors.every((f) => f.bounds.w === first.w && f.bounds.h === first.h) ? { w: first.w, h: first.h } : null;
}

export function tooMuchText(cell: string): string {
  return `Every floor at this size is too much for one file. Pick fewer pixels a ${cell}.`;
}

/** Floors' help: "One .zip file with a picture of each of Tower's 3 floors." */
export function everyFloorHelp(sceneName: string, floors: number): string {
  return `One .zip file with a picture of each of ${sceneName}'s ${floors} floors.`;
}

/** Why the player view's file holds fewer floors than the scene, or null when it holds them all. */
export function reachedText(sceneName: string, reached: number, total: number): string | null {
  if (reached >= total) return null;
  if (reached === 0) return `Players have not reached any of ${sceneName}'s ${total} floors yet, so their view has nothing to export.`;
  return `Players have reached ${reached} of ${sceneName}'s ${total} floors, so the file holds ${reached === 1 ? "it" : "those"}.`;
}

/** The busy button's words while one floor's picture is made: "Making Upper floor (2 of 3)…". */
export function makingText(name: string, at: number, of: number): string {
  return `Making ${name} (${at} of ${of})…`;
}

/**
 * The zip of each floor's picture, made one floor at a time so only one
 * canvas is ever held. `onFloor` says which floor is being made, and once
 * `stale` is true the run stops and answers null, as an export the DM
 * overtook drops its result. `picture` throws for a floor that cannot be
 * made, which ends the run with that error.
 */
export async function everyFloorZip<T extends { blob: Blob }>(input: {
  entries: readonly FloorEntry[];
  picture(floor: Scene): Promise<T>;
  onFloor(at: number, entry: FloorEntry): void;
  stale(): boolean;
}): Promise<{ zip: Blob; pictures: T[] } | null> {
  const pictures: T[] = [];
  for (const [i, entry] of input.entries.entries()) {
    input.onFloor(i + 1, entry);
    const made = await input.picture(entry.floor);
    if (input.stale()) return null;
    pictures.push(made);
  }
  const zip = await storedZip(input.entries.map((entry, i) => ({ name: entry.name, data: pictures[i]!.blob })));
  return input.stale() ? null : { zip, pictures };
}

/**
 * What a made file depends on beside the options: which floors it holds,
 * their names, sizes and grids. The floor list is rebuilt on every change
 * to the view, so this stands in for it wherever work should follow the
 * floors and not each op.
 */
export function floorsKey(floors: readonly Pick<Scene, "id" | "name" | "floor" | "bounds" | "gridShape">[]): string {
  return floors.map((f) => `${f.id}\u0000${floorName(f)}\u0000${f.bounds.w}x${f.bounds.h}\u0000${f.gridShape ?? ""}`).join("\u0001");
}

/**
 * The floors the export would hold, from the whole view, with whether any
 * of them has a map or a build to draw, for the Floors row and the button.
 * Null on a scene of one floor, which has no Floors row, and while the
 * export is closed, so a closed export reads nothing on each op.
 */
export function useExportFloors(scene: Scene, version: ExportView, open: boolean): { floors: Scene[]; total: number; anything: boolean; key: string } | null {
  const view = useRoomView((s) => (open ? s.view : null));
  return useMemo(() => {
    if (!view || scene.floor === undefined) return null;
    const { floors, total } = exportedFloors(view, scene.id, version);
    if (total < 2) return null;
    const anything = floors.some((f) => f.map !== undefined || hasBuildOn(f.id, view.buildChunks, view.labels, view.stamps));
    return { floors, total, anything, key: floorsKey(floors) };
  }, [view, scene.id, scene.floor, version]);
}
