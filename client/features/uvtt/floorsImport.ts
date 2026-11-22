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
 */
export function rowsOf(files: readonly File[]): FloorRow[] {
  const taken = new Set<string>();
  return files
    .map((file, i) => ({ file, i }))
    .sort((a, b) => BY_NAME.compare(a.file.name, b.file.name) || a.i - b.i)
    .map(({ file, i }) => {
      const floor = freeName(floorNameOf(fileSceneName(file.name)), taken);
      taken.add(floor);
      return { key: `${i}`, file, floor };
    });
}

/** What the scene name field takes, the protocol's name limit, as New scene and Scene settings do with 80: more than the start value, which is cut like a floor's name. */
export const SCENE_NAME_CHARS = MAX_NAME;

/** The scene's name to start from: the first file's, cut like a floor's name so the two read alike. */
export function sceneNameOf(rows: readonly FloorRow[]): string {
  const first = rows[0];
  return first ? floorNameOf(fileSceneName(first.file.name)) : "";
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
