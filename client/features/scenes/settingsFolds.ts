import type { IconName } from "../../components/Icon.tsx";
import { scenesFoldsSlot, useFolds, type ScenesSection } from "../../lib/folds.ts";

/*
 * The scene settings page's groups (docs/design/design-v1-scenes-reorg.md 3):
 * their order, names and icons. Their folds are Scenes' surface in the
 * fold store (lib/folds.ts SCENES_FOLDS), which keeps the key and the
 * stored values these groups always had, so a device's folds carry over.
 */

/** The groups in the page's order, after the scene's name. Export follows them and never folds. */
export const SCENE_GROUPS = ["light", "sound", "players", "map", "walls", "scene"] as const satisfies readonly ScenesSection[];
export type SceneGroup = (typeof SCENE_GROUPS)[number];

/**
 * Short names in the table's terms, each saying what the group sets
 * (D-261102-861). Fog and vision keeps What players see's key, so a device
 * that folded it finds it folded. Size and view is named for what it holds,
 * so it never echoes the "This scene" label over the page (D-261028-07).
 */
export const SCENE_GROUP_LABELS: Readonly<Record<SceneGroup, string>> = {
  light: "Light and weather",
  sound: "Scene sound",
  players: "Fog and vision",
  map: "Map and grid",
  walls: "Walls and movement",
  scene: "Size and view",
};

/** Each group's icon, after its chevron (docs/design/design-v1-design-pass.md 4.1). */
export const SCENE_GROUP_ICONS: Readonly<Record<SceneGroup, IconName>> = {
  light: "weather",
  sound: "music",
  players: "shown",
  map: "image",
  walls: "walls",
  scene: "scenes",
};

/** A group's fold for its `Group`, New scene's included, kept up to date with every tap and reveal. */
export function useSceneFolds(): (section: ScenesSection) => { open: boolean; onToggle(): void } {
  return useFolds(scenesFoldsSlot);
}
