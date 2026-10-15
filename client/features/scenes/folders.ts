import type { Scene } from "#shared/model.ts";
import { mapSchemas, type ClientOp } from "#shared/protocol.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomActions } from "../../state/types.ts";

/**
 * Scene folders in the Scenes panel (docs/design-v1-maps-vision.md section
 * 3.3). A folder is only a name on its scenes, so there is no folder to
 * create or delete: the first scene moved into a name makes the folder, and
 * the last one moved out ends it. Pure, so the order rules are tested.
 */

/** Scenes in no folder (`folder` null), or one folder's scenes, in scene order. */
export type SceneGroup = { folder: string | null; scenes: Scene[] };

/**
 * The panel's groups for scenes already sorted by order: those in no folder
 * at the top, then each folder where its first scene is in the order.
 */
export function groupScenes(sorted: readonly Scene[]): SceneGroup[] {
  const loose: Scene[] = [];
  const folders = new Map<string, Scene[]>();
  for (const scene of sorted) {
    if (scene.folder === undefined) {
      loose.push(scene);
      continue;
    }
    const list = folders.get(scene.folder);
    if (list) list.push(scene);
    else folders.set(scene.folder, [scene]);
  }
  const groups: SceneGroup[] = loose.length > 0 ? [{ folder: null, scenes: loose }] : [];
  for (const [folder, scenes] of folders) groups.push({ folder, scenes });
  return groups;
}

/** Folder names in the order the panel shows them. */
export function folderNames(sorted: readonly Scene[]): string[] {
  return groupScenes(sorted).flatMap((g) => (g.folder === null ? [] : [g.folder]));
}

/**
 * Every reorder sends the order the panel shows, with the move applied. A
 * stored order that differs from the panel's (scenes with no folder sit at
 * the top whatever their order) would make a move inside one folder shift
 * where another folder sits, since a folder sits at its first scene.
 */
function flatten(groups: readonly SceneGroup[]): string[] {
  return groups.flatMap((g) => g.scenes.map((s) => s.id));
}

/** The scene order after moving a scene up (-1) or down (+1) within its own group, or null at the group's end. */
export function moveScene(groups: readonly SceneGroup[], sceneId: string, delta: -1 | 1): string[] | null {
  const next = groups.map((g) => ({ ...g, scenes: [...g.scenes] }));
  for (const group of next) {
    const i = group.scenes.findIndex((s) => s.id === sceneId);
    if (i < 0) continue;
    const j = i + delta;
    const other = group.scenes[j];
    if (!other) return null;
    group.scenes[j] = group.scenes[i]!;
    group.scenes[i] = other;
    return flatten(next);
  }
  return null;
}

/**
 * The scene order after moving a whole folder above (-1) or below (+1) the
 * folder next to it, or null at the end. Scenes in no folder stay on top.
 */
export function moveFolder(groups: readonly SceneGroup[], folder: string, delta: -1 | 1): string[] | null {
  const i = groups.findIndex((g) => g.folder === folder);
  const j = i + delta;
  const other = groups[j];
  if (i < 0 || !other || other.folder === null) return null;
  const next = [...groups];
  next[j] = groups[i]!;
  next[i] = other;
  return flatten(next);
}

/** A name typed for a folder, or null when the protocol would refuse it (empty, too long, or with control characters). */
export function cleanFolderName(text: string): string | null {
  const name = text.trim().replace(/\s+/g, " ");
  return mapSchemas.folderName.safeParse(name).success ? name : null;
}

/**
 * The other folder a rename would merge this one into, or null. A folder is
 * only a name on its scenes, so a rename to another folder's name puts the
 * scenes of both under one header. That is allowed, and the header says so
 * before the DM saves.
 */
export function renameMergesInto(folders: readonly string[], from: string, typed: string): string | null {
  const to = cleanFolderName(typed);
  return to !== null && to !== from && folders.includes(to) ? to : null;
}

/** Renaming a folder renames it on every scene in it. Sent as one gesture, so one undo takes the whole rename back. */
export function renameFolderOps(scenes: readonly Scene[], from: string, to: string): ClientOp[] {
  if (from === to) return [];
  return scenes.filter((s) => s.folder === from).map((s) => ({ t: "scene.update", sceneId: s.id, patch: { folder: to } }));
}

/**
 * Sends a rename under one undo group, a folder of one scene too. The
 * server names a grouped step by what its ops do together (undoLabels.ts
 * `tallyOf`), so the undo reads "renaming the folder Act one to Act two",
 * where a lone op would read as moving its one scene, as "Move to folder"
 * does.
 */
export function sendFolderRename(actions: Pick<RoomActions, "dispatch" | "newId">, scenes: readonly Scene[], from: string, to: string): number[] {
  return dispatchGesture(actions, renameFolderOps(scenes, from, to), { alwaysGroup: true });
}

/**
 * Collapsed folders, remembered per room on this device only. Storage can
 * be blocked or full, and a folder that forgets it was collapsed is a small
 * loss, so every read and write is allowed to fail.
 */
export type CollapsedStorage = Pick<Storage, "getItem" | "setItem">;

export function collapsedKey(roomId: string): string {
  return `rvtt.sceneFoldersCollapsed.${roomId}`;
}

export function readCollapsed(storage: CollapsedStorage | null, roomId: string): Set<string> {
  try {
    const raw = storage?.getItem(collapsedKey(roomId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsed(storage: CollapsedStorage | null, roomId: string, collapsed: ReadonlySet<string>): void {
  try {
    storage?.setItem(collapsedKey(roomId), JSON.stringify([...collapsed]));
  } catch {
    // Remembered for this page load only.
  }
}

/** The browser's local storage, or null where reading it throws (some private modes). */
export function browserStorage(): CollapsedStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
