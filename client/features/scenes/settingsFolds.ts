import { useSyncExternalStore } from "react";
import type { IconName } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { layoutWidth } from "../device/layout.ts";

/*
 * The scene settings page's groups and their folds
 * (docs/design-v1-map-discovery.md 8.4): which groups show open, as this
 * device last left them. Plain functions and a slot, for node --test, in
 * the token panel's pattern (features/tokens/panelFolds.ts): resolved once
 * per Room page, so a tablet turned across 900 px, which remounts the
 * panel in the other tree, never refolds anything.
 */

/** The groups in the page's order, after the scene's name. Export as image and Delete follow them, never folded. */
export const SCENE_GROUPS = ["players", "map", "walls", "scene"] as const;
export type SceneGroup = (typeof SCENE_GROUPS)[number];

export const SCENE_GROUP_LABELS: Readonly<Record<SceneGroup, string>> = {
  players: "What players see",
  map: "Map image and grid",
  walls: "Walls and movement",
  // Named for what it holds, so it never echoes the "This scene" label over the page (D-261028-07). Its key stays, so a device's folds carry over.
  scene: "Size and view",
};

/** Each group's icon, after its chevron (docs/design-v1-design-pass.md 4.1). */
export const SCENE_GROUP_ICONS: Readonly<Record<SceneGroup, IconName>> = {
  players: "shown",
  map: "image",
  walls: "walls",
  scene: "scenes",
};

export type SceneFolds = Readonly<Record<SceneGroup, boolean>>;

export const SCENE_FOLDS_KEY = "rvtt.sceneSettingsFolds";

const ALL_OPEN: SceneFolds = { players: true, map: true, walls: true, scene: true };

/**
 * Where each group starts with nothing stored. What players see is why
 * the DM opens the page in play, so it opens everywhere. On a phone the
 * setup groups fold, so it stands in reach under the scene's name. A wide
 * screen has the room for every group open.
 */
export function sceneFoldStarts(width: number): SceneFolds {
  const wide = width >= theme.layout.wideMinWidth;
  return { players: true, map: wide, walls: wide, scene: wide };
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

/** What storage holds: an object, nothing (no key yet), or null when it cannot be read (no storage, a throw, or a value that is no object). */
function stored(storage: ReadStorage | null): Record<string, unknown> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SCENE_FOLDS_KEY);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The folds: each stored boolean, and the start at this width for the
 * rest. Where storage cannot be read every group opens (8.4), so a device
 * that cannot keep a fold never hides a setting behind one.
 */
export function resolveSceneFolds(storage: ReadStorage | null, width: number): SceneFolds {
  const from = stored(storage);
  if (from === null) return ALL_OPEN;
  const out = { ...sceneFoldStarts(width) };
  for (const group of SCENE_GROUPS) {
    const value = from[group];
    if (typeof value === "boolean") out[group] = value;
  }
  return out;
}

/** Stores one group's fold beside what is already stored, so a group never tapped keeps following its start. */
export function writeSceneFold(storage: WriteStorage | null, group: SceneGroup, open: boolean): void {
  try {
    if (!storage) return;
    const next: Record<string, boolean> = {};
    const from = stored(storage) ?? {};
    for (const g of SCENE_GROUPS) if (typeof from[g] === "boolean") next[g] = from[g] as boolean;
    next[group] = open;
    storage.setItem(SCENE_FOLDS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage full: the fold lasts for this Room, which is all a blocked storage allows.
  }
}

export type SceneFoldsStore = {
  /** The folds, resolved the first time the page asks, from storage and the starts at that width, then kept. */
  get(width: number): SceneFolds;
  /** The DM's tap on a group's header. */
  tap(group: SceneGroup, open: boolean): void;
  subscribe(listener: () => void): () => void;
};

export function createSceneFolds(storage: WriteStorage | null): SceneFoldsStore {
  let folds: SceneFolds | null = null;
  const listeners = new Set<() => void>();
  return {
    get(width) {
      folds ??= resolveSceneFolds(storage, width);
      return folds;
    },
    tap(group, open) {
      folds = { ...(folds ?? resolveSceneFolds(storage, 0)), [group]: open };
      writeSceneFold(storage, group, open);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deviceStorage(): WriteStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Per Room page (state/scope.ts): the Scenes sheet and the side panel's tab draw in separate trees, and both read this. */
export const sceneFoldsSlot = scopeSlot(() => createSceneFolds(deviceStorage()));

/** A group's fold for its `Group`, kept up to date with every tap. */
export function useSceneFolds(): (group: SceneGroup) => { open: boolean; onToggle(): void } {
  const store = useScoped(sceneFoldsSlot);
  const read = () => store.get(layoutWidth());
  // The same reader serves a render to markup, so a render test can draw the page.
  const folds = useSyncExternalStore(store.subscribe, read, read);
  return (group) => ({ open: folds[group], onToggle: () => store.tap(group, !read()[group]) });
}
