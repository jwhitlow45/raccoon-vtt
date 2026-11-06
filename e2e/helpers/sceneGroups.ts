/**
 * The scene settings page's groups in order (docs/design/design-v1-scenes-reorg.md 3,
 * client/features/scenes/settingsFolds.ts), for every file that opens or
 * measures them. Scene sound draws only while the server offers sound files.
 */
export const SCENE_GROUP_NAMES = ["Light and weather", "Scene sound", "Fog and vision", "Map and grid", "Walls and movement", "Size and view"] as const;

/** The groups that start folded on a phone, so a phone step that reaches into one opens it first. */
export const SCENE_SETUP_GROUPS = SCENE_GROUP_NAMES.filter((name) => name !== "Light and weather");
