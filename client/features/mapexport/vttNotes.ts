import { MAX_PHONE_FILE_BYTES } from "../uvtt/limits.ts";
import { EVERY_FLOOR_PIXELS } from "./everyFloor.ts";
import { exportSize, MAX_EXPORT_PIXELS, VTT_LIMITS } from "./size.ts";
import type { ExportCheck } from "../uvtt/steps.ts";
import type { UvttCounts } from "../uvtt/write.ts";
import type { ExportContent, ExportView } from "./content.ts";

/**
 * Export as VTT file's words (docs/design/design-v1-uvtt-export.md section 3),
 * apart from React so the tests read them. A note shows only when it
 * applies. Counts are summed over every floor in the file, and a note
 * about one floor's own file names it.
 */

export const VTT_HELP = "A Universal VTT file of the map with its walls, doors and lights, for another VTT or another room here.";
export const VTT_FAILED = "The file could not be made. Try a smaller scale.";

export function versionHelp(view: ExportView): string {
  return view === "player"
    ? "What players can see: walls they have seen, secret doors not yet found as walls, and no lights, since only you have those."
    : "Every wall, door and light that is on. Secret doors become plain doors, and the map is drawn as players see it. Keep it to yourself.";
}

/** What the file keeps and what stays in the room, always shown. */
export function lossLine(input: { otherFloors: boolean; short: boolean }): string {
  let text = "The file keeps the map, walls, doors, windows and lights. Heights, traps, tokens, fog, locks, open doors and secret doors stay here.";
  if (input.otherFloors) text += " Other floors stay here too.";
  if (input.short) text += " A wall or door shorter than a fifth of a square may not come back.";
  return text;
}

export const HEX_LINE = "Other VTTs read the file's grid as squares, so hexes leave as squares and their walls as lines off the grid.";

/** Floors' help on Every floor: "One .zip file with a Universal VTT file of each of Tower's 3 floors." */
export function everyFloorVttHelp(sceneName: string, floors: number): string {
  return `One .zip file with a Universal VTT file of each of ${sceneName}'s ${floors} floors.`;
}

/** One floor's file, as its notes read it. `name` is the floor's, on Every floor. */
export type FloorFile = {
  name?: string;
  content: Pick<ExportContent, "secretDoors" | "hiddenLabels" | "hiddenStamps">;
  counts: UvttCounts;
  bytes: number;
  check: ExportCheck | null;
  mapMissing: boolean;
};

export function vttNotes(files: readonly FloorFile[], view: ExportView): string[] {
  const sum = (of: (f: FloorFile) => number) => files.reduce((n, f) => n + of(f), 0);
  const notes: string[] = [];
  if (view === "player") {
    const secret = sum((f) => f.content.secretDoors);
    if (secret > 0) notes.push(`${plural(secret, "secret door")} written as ${secret === 1 ? "a wall" : "walls"}, as players see them.`);
  } else {
    const secret = sum((f) => f.counts.secretAsDoors);
    if (secret > 0) notes.push(`${plural(secret, "secret door")} written as ${secret === 1 ? "a plain door" : "plain doors"}.`);
    const off = sum((f) => f.counts.lightsOff);
    if (off > 0) notes.push(`${plural(off, "light")} switched off left out.`);
  }
  const stamps = sum((f) => f.content.hiddenStamps);
  if (stamps > 0) notes.push(`${plural(stamps, "stamp")} players cannot see left out of the map.`);
  const labels = sum((f) => f.content.hiddenLabels);
  if (labels > 0) notes.push(`${plural(labels, "label")} under the fog left out.`);
  const clipped = sum((f) => f.counts.clipped);
  if (clipped > 0) notes.push(`${clipped} ${clipped === 1 ? "wall, door or light" : "walls, doors or lights"} past the scene's edge cut or left out.`);
  for (const f of files) {
    if (f.bytes <= MAX_PHONE_FILE_BYTES) continue;
    notes.push(f.name === undefined ? "Phones import files up to 40 MB, so this one imports on a computer." : `${f.name}'s file is over 40 MB, so it imports on a computer.`);
  }
  for (const f of files) {
    if (f.check && "changes" in f.check && f.check.changes) {
      // The cause is named only where the check saw a door or window cut a wall. Pins to the grid, welds and short pieces closing up change walls too (D-261127-353).
      const why = f.check.portalCut ? " (a door sits very close to a wall)" : "";
      notes.push(f.name === undefined ? `Some walls change when this file is imported here${why}.` : `Some walls change when ${f.name}'s file is imported here${why}.`);
    }
  }
  for (const f of files) {
    if (f.check && "refused" in f.check) notes.push(f.name === undefined ? `This app's import would refuse this file: ${f.check.refused}` : `This app's import would refuse ${f.name}'s file: ${f.check.refused}`);
  }
  for (const f of files) {
    if (!f.mapMissing) continue;
    notes.push(f.name === undefined ? "The map image could not be loaded, so the image has only the build." : `${f.name}'s map image could not be loaded, so its picture has only the build.`);
  }
  return notes;
}

/** "1 floor", "3 floors". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Why the scale went down, by the limit that bound it: the side this app's
 * import takes, the pixels an iPhone draws, or on Every floor the pixels
 * one file of every floor holds. `floors` is the one floor, or every floor
 * the file holds.
 */
export function loweredText(floors: readonly { w: number; h: number }[], px: number, cell: string, every: boolean): string {
  const bySide = Math.min(...floors.map((b) => Math.floor(VTT_LIMITS.maxSide / Math.max(b.w, b.h))));
  const byPixels = Math.min(...floors.map((b) => Math.floor(Math.sqrt(MAX_EXPORT_PIXELS / (b.w * b.h)))));
  const why =
    px >= bySide ? "8,192 px a side, the most this app's import takes" : px >= byPixels || !every ? "16.7 million pixels, the most an iPhone can draw" : `${Math.round(EVERY_FLOOR_PIXELS / 1e6)} million pixels for every floor together`;
  const first = floors[0]!;
  const same = floors.every((b) => b.w === first.w && b.h === first.h);
  const size = exportSize(first, px, VTT_LIMITS);
  if (!every) return `Lowered to ${px} px per ${cell}, so the image stays within ${why}. It will be ${size.width} × ${size.height} px.`;
  return `Lowered to ${px} px per ${cell} on every floor, so each image stays within ${why}.${same ? ` Each will be ${size.width} × ${size.height} px.` : ""}`;
}
