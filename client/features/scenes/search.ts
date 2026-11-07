import type { Scene } from "#shared/model.ts";
import { action, inside, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";
import { serverSound } from "../sound/engine/store.ts";
import { LIGHT_LEVELS, lightOf } from "../vision/settings.ts";
import { SCENE_GROUP_LABELS } from "./settingsFolds.ts";

/*
 * Scenes in the room search (designs/qol/search.md 4 and 5.10): New scene,
 * and the settings of the scene in view, which the panel shows under the
 * list (panels/ScenesPanel.tsx). A DM's alone, so these load with the DM's
 * catalog only (catalog/dm.ts): nothing but that file imports this one.
 * Each anchor is the `search=` id on its control in SceneSettings.tsx and
 * the parts it draws. The scenes themselves are the index's rows, and Show
 * a phase is the DM menu's phase items' twin (catalog/dm.ts TWINS), with
 * no row of its own.
 */

const SCENES: Place = { panel: "scenes", where: "Scenes", icon: "scenes" };
const NEW = inside(SCENES, "New scene", "new");
const LIGHT = inside(SCENES, SCENE_GROUP_LABELS.light, "light");
const SOUND = inside(SCENES, SCENE_GROUP_LABELS.sound, "sound");
const PLAYERS = inside(SCENES, SCENE_GROUP_LABELS.players, "players");
const MAP = inside(SCENES, SCENE_GROUP_LABELS.map, "map");
const WALLS = inside(SCENES, SCENE_GROUP_LABELS.walls, "walls");
const SIZE = inside(SCENES, SCENE_GROUP_LABELS.scene, "scene");

/** A group's own place: the panel with the group's fold, read as the panel's. */
const at = (group: Place): Place => ({ ...group, where: SCENES.where });

/** The scene in view, whose settings the panel shows. Null with none, as in a room with no scene. */
function viewing(ctx: SearchContext): Scene | null {
  const id = ctx.state.sceneId;
  return (id ? ctx.state.view?.scenes[id] : undefined) ?? null;
}
const shown = (ctx: SearchContext) => viewing(ctx) !== null;

export const SCENES_ENTRIES: readonly CatalogEntry[] = [
  action(at(NEW), "scenes.new", "New scene", { names: ["add a scene", "add a map", "upload a map"], press: false }),
  setting(SCENES, "scenes.name", "Scene name", { names: ["rename the scene"], when: shown }),
  section(at(LIGHT), "scenes.light", SCENE_GROUP_LABELS.light, { when: shown }),
  setting(LIGHT, "scenes.light.level", "Light level", {
    names: ["bright", "dim", "darkness"],
    bets: ["dark"],
    when: shown,
    valueNow: (ctx) => {
      const scene = viewing(ctx);
      return scene ? LIGHT_LEVELS.find((l) => l.value === lightOf(scene))?.label : undefined;
    },
  }),
  setting(LIGHT, "scenes.light.weather", "Weather", { names: ["rain", "snow", "wind", "storm"], when: shown }),
  // Scene sound shows only while the server offers sound files (SceneSettings.tsx).
  section(at(SOUND), "scenes.sound", SCENE_GROUP_LABELS.sound, { names: ["scene music"], when: (ctx) => shown(ctx) && serverSound() === "on" }),
  section(at(PLAYERS), "scenes.players", SCENE_GROUP_LABELS.players, { names: ["fog of war", "line of sight"], when: shown }),
  setting(PLAYERS, "scenes.players.see", "Players see", { names: ["fog", "vision", "what players see"], when: shown }),
  section(at(MAP), "scenes.map", SCENE_GROUP_LABELS.map, { names: ["map image", "grid"], when: shown }),
  setting(MAP, "scenes.map.grid", "Grid lines", { names: ["show the grid"], when: shown }),
  section(at(WALLS), "scenes.walls", SCENE_GROUP_LABELS.walls, { when: shown }),
  setting(WALLS, "scenes.walls.block", "Walls and ledges block players' moves", { names: ["block movement"], when: shown }),
  setting(WALLS, "scenes.walls.auto", "Automatic walls", { when: shown }),
  action(WALLS, "scenes.walls.builder", "Open the builder", { names: ["build walls", "draw walls", "builder"], when: shown }),
  section(at(SIZE), "scenes.size", SCENE_GROUP_LABELS.scene, { names: ["scene size", "starting view"], when: shown }),
  action(SIZE, "scenes.size.save-view", "Save current view", { names: ["starting view"], when: shown }),
  action(SCENES, "scenes.export", "Export as image", { names: ["export the map", "download the map", "png"], when: shown }),
];
