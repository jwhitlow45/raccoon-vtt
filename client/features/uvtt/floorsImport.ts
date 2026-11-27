import { LIMITS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { freeName } from "#shared/reducer/floors.ts";
import { floorNameOf } from "../scenes/floorSource.ts";
import { fileSceneName, outcomeText, type ImportOutcome } from "./rules.ts";

/*
 * A new scene from several Universal VTT files (docs/design/design-v1-floors.md
 * phase 4, 9.5, D-261119-057): its rules and words apart from React
 * (FloorsImportDialog.tsx), so they run under node's test runner. Each file
 * becomes a floor, the first the lowest, and the files stack in the order
 * their names sort, numbers compared as numbers, which the DM can change.
 */

/** A file's row in the dialog: the file, and the floor name the DM gives it. `key` stays with the file through every move. */
export type FloorRow = { key: string; file: File; floor: string };

/** "Level 2" before "Level 10", and "level 3" between them: numbers as numbers, letters by their base. Ties keep their order. */
const BY_NAME = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The rows for picked files, lowest first, each named for its file, cut to a floor name's 40 characters.
 * Names that collide after the cut are numbered as the reducer numbers them when the floors are made
 * (freeName), so the dialog shows the names the floors get and each move button has its own name.
 * Files this app's Every floor export wrote name each floor after its number, as written (exportedParts).
 */
export function rowsOf(files: readonly File[]): FloorRow[] {
  const taken = new Set<string>();
  const exported = exportedParts(files);
  return files
    .map((file, i) => ({ file, i }))
    .sort((a, b) => BY_NAME.compare(a.file.name, b.file.name) || a.i - b.i)
    .map(({ file, i }) => {
      const floor = freeName(floorNameOf(exported?.floors.get(file) ?? fileSceneName(file.name)), taken);
      taken.add(floor);
      return { key: `${i}`, file, floor };
    });
}

/** The extensions a Universal VTT file goes by, which an exported file's name ends in. */
const EXTENSION = /\.(?:dd2vtt|uvtt|df2vtt)$/i;
/**
 * Each ` - 01 - ` in a name: where a scene part may end and its floor's
 * number stand. A lookahead, so the match takes only the space before it
 * and `Keep - 03 - 01 - Hall` yields both its markers, which share a ` - `.
 */
const ORDINAL = / (?=- (\d{2}) - )/g;

/** Each way a file's name splits as `<scene> - NN - <floor>`, by every ` - NN - ` it holds. */
function splits(name: string): { scene: string; ordinal: string; floor: string }[] {
  const base = name.replace(EXTENSION, "");
  if (base === name) return [];
  const out: { scene: string; ordinal: string; floor: string }[] = [];
  for (const m of base.matchAll(ORDINAL)) {
    const scene = base.slice(0, m.index).trim();
    const floor = base.slice(m.index + " - 00 - ".length).trim();
    if (scene !== "" && floor !== "") out.push({ scene, ordinal: m[1]!, floor });
  }
  return out;
}

/**
 * The scene's name and each floor's, as written, when every picked file is
 * named the way Every floor's zip names its files (mapexport/fileName.ts
 * vttZipNames): `Tower - 01 - Ground floor.dd2vtt` and on, one scene part
 * for all of them and a number of its own for each (docs/design/design-v1-uvtt-export.md
 * section 7, D-261127-254). A scene or floor name may hold ` - 02 - ` itself,
 * so the scene part is the one prefix that every file's name splits at with
 * every number different, not the first or the last such split of one
 * name. Null for any other pick, which keeps the rule of names read from files.
 */
export function exportedParts(files: readonly File[]): { scene: string; floors: Map<File, string> } | null {
  const each = files.map((file) => ({ file, splits: splits(file.name) }));
  if (each.length === 0 || each.some((e) => e.splits.length === 0)) return null;
  // Shortest first, so a single file takes the scene part its name starts with. Two or more files leave at most one: a longer shared prefix holds one number every file shares.
  const candidates = [...new Set(each[0]!.splits.map((s) => s.scene))].sort((a, b) => a.length - b.length);
  for (const scene of candidates) {
    const floors = new Map<File, string>();
    const ordinals = new Set<string>();
    for (const e of each) {
      const at = e.splits.find((s) => s.scene === scene);
      if (!at || ordinals.has(at.ordinal)) break;
      ordinals.add(at.ordinal);
      floors.set(e.file, at.floor);
    }
    if (floors.size === each.length) return { scene, floors };
  }
  return null;
}

/** What the scene name field takes, the protocol's name limit, as New scene and Scene settings do with 80: more than the start value, which is cut like a floor's name. */
export const SCENE_NAME_CHARS = MAX_NAME;

/**
 * The scene's name to start from: the first file's, cut like a floor's name so the two read alike, or the
 * scene part of files Every floor's export named, as written, up to a scene name's length.
 */
export function sceneNameOf(rows: readonly FloorRow[]): string {
  const first = rows[0];
  if (!first) return "";
  const exported = exportedParts(rows.map((r) => r.file));
  if (exported) return Array.from(exported.scene).slice(0, SCENE_NAME_CHARS).join("").trim();
  return floorNameOf(fileSceneName(first.file.name));
}

/** The rows after Move up (toward the first, lowest floor) or Move down, or null at the end of the list. */
export function moveRow(rows: readonly FloorRow[], key: string, up: boolean): FloorRow[] | null {
  const at = rows.findIndex((r) => r.key === key);
  const to = up ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= rows.length) return null;
  const next = rows.slice();
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/** A row's name in the steps and the move buttons: its floor name, else its file's. */
export function rowName(row: FloorRow): string {
  return row.floor.trim() || fileSceneName(row.file.name);
}

/**
 * The name each row's floor will get, in row order: the typed (or file) name cut to a floor's
 * length, numbered as the reducer numbers floors of one name when they are made (freeName).
 * Worked out over the current rows each time, since typed names can collide.
 */
export function floorNamesOf(rows: readonly FloorRow[]): string[] {
  const taken = new Set<string>();
  return rows.map((row) => {
    const name = freeName(floorNameOf(rowName(row)), taken);
    taken.add(name);
    return name;
  });
}

/**
 * The line under a row's Floor name field where the floor will not get the name as it stands in the field:
 * an emptied name takes the file's, and a name another floor has takes a number.
 */
export function willBeText(row: FloorRow, name: string): string | null {
  return floorNameOf(row.floor) === name ? null : `Will be ${name}.`;
}

export function tooManyFiles(files: number): string | null {
  const most = LIMITS.floorsPerScene;
  return files > most ? `A scene holds at most ${most} floors. Pick ${most} files or fewer.` : null;
}

export function scenesFull(scenes: number, files: number): string | null {
  const most = LIMITS.scenesPerRoom;
  return scenes + files > most ? `A room holds at most ${most} scenes, and these ${files} floors would make ${scenes + files}. Delete a scene first.` : null;
}

/** Why the files cannot make a scene, asked before any upload and again once every file is up: each floor is a scene of the room. */
export function filesRefusal(view: Pick<RoomState, "scenes"> | null | undefined, files: number): string | null {
  return tooManyFiles(files) ?? scenesFull(view ? Object.keys(view.scenes).length : 0, files);
}

/** A file's own error, which the dialog names it by. */
export function fileError(fileName: string, message: string): string {
  return `${fileName}: ${message}`;
}

/** A failed upload, after which nothing is sent. */
export function uploadFailed(floor: string): string {
  return `${floor} could not be uploaded, so no scene was made.`;
}

export function readingText(floor: string, at: number, of: number): string {
  return `Reading ${floor} (${at} of ${of})…`;
}

export function uploadingText(floor: string, at: number, of: number): string {
  return `Uploading ${floor} (${at} of ${of})…`;
}

export function addingText(answered: number, total: number, floor: string): string {
  return `Adding walls ${answered} of ${total} on ${floor}`;
}

export function dialogTitle(files: number): string {
  return `New scene from ${files} files`;
}

/** The setup toast's words, which this scene's own toast replaces so the DM sees one notice (SETUP_SAVED in state/store.ts). */
const UNDO_HINT = "Undo in Setup history.";

/**
 * How the import ended, in one sentence: a complete one names the floors
 * made, and every other ending reads as one file's import does, since one
 * Undo setup takes every floor back the same way.
 */
export function severalOutcomeText(outcome: ImportOutcome, scene: string, floors: number, opened: boolean): { text: string; tone: "info" | "error" } {
  if (outcome.k === "complete" && !outcome.checked) return { text: `${scene} is made with ${floors} floors, with every wall, door and light.${opened ? "" : " Open it from the Scenes panel."} ${UNDO_HINT}`, tone: "info" };
  return outcomeText(outcome, scene, opened);
}
