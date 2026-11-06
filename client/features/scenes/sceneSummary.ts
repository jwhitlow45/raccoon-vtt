import type { Scene } from "#shared/model.ts";
import { PLAYERS_SEE_WORDS, playersSeeOf } from "#shared/playersSee.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { sceneHexSpan } from "#shared/rules/hex.ts";
import { weatherParts } from "#shared/weather.ts";
import { SHAPE_CHOICES, shapeChoice } from "../grid/words.ts";
import { VIEW_NAMES, suggestedKind } from "../view/choice.ts";
import { LIGHT_LEVELS, lightOf, SIGHT_CHOICES, sightOf } from "../vision/settings.ts";
import type { SceneGroup } from "./settingsFolds.ts";

/*
 * What a folded group of the scene settings page says it holds
 * (docs/design/design-v1-scenes-reorg.md 3), so a phone that starts all but
 * Light and weather folded still reads the scene at a glance. Plain
 * functions, for node --test.
 */

const join = (parts: readonly (string | null)[]): string => parts.filter((p) => p !== null).join(" · ");

/**
 * Scene sound's group says what it holds through `sceneSoundSummary`, from
 * the names the room's library gives, so it is no case here.
 */
export function sceneGroupSummary(scene: Scene, group: Exclude<SceneGroup, "sound">): string {
  switch (group) {
    case "light": {
      // The light does nothing while party vision is off (D-261102-933), so the summary leaves it out rather than name a level that plays no part.
      const weather = weatherParts(scene.weather);
      return join([scene.vision?.on === true ? (LIGHT_LEVELS.find((l) => l.value === lightOf(scene))?.label ?? null) : null, ...(weather.length > 0 ? weather : ["Clear"])]);
    }
    case "players":
      return join([PLAYERS_SEE_WORDS[playersSeeOf(scene)], sightOf(scene) === "player" ? (SIGHT_CHOICES.find((c) => c.value === "player")?.label ?? null) : null]);
    case "map": {
      const shape = SHAPE_CHOICES.find((c) => c.value === shapeChoice(scene.gridShape))?.label ?? "Squares";
      // A battle mat's squares have no size to say: only an image's are measured in its pixels.
      const grid = scene.map ? `${shape}, ${formatPx(scene.map.cellPx)} px` : shape;
      return join([scene.map ? "Map image" : "No map image", grid]);
    }
    case "walls":
      return scene.blockMovement === true ? "Walls block moves" : "Walls do not block moves";
    case "scene":
      return join([sizeText(scene), suggestedKind(scene.suggestedView) === "isometric" ? VIEW_NAMES.isometric : null]);
  }
}

/** Scene sound's summary: the names of what it plays, "Silent" for a scene kept silent, or "None of its own". */
export function sceneSoundSummary(names: readonly string[] | null): string {
  if (names === null) return "None of its own";
  return names.length === 0 ? "Silent" : names.join(", ");
}

/**
 * The scene's size in its cells. A hex scene's bounds are steps of the
 * room's distance, not hexes, so it says the whole hexes they hold, as
 * the size row's help does (grid/words.ts `sizeWords`), and that it holds
 * none where it is too small for one.
 */
function sizeText(scene: Scene): string {
  const g = sceneGrid(scene);
  if (!isHex(g)) return `${scene.bounds.w} × ${scene.bounds.h} squares`;
  const span = sceneHexSpan(g, scene.bounds);
  return span.cols === 0 || span.rows === 0 ? "No whole hex" : `${span.cols} × ${span.rows} hexes`;
}

/** The Switches fold, folded inside Fog and vision: the two switches Players see sets. */
export function fogFoldSummary(scene: Pick<Scene, "fogEnabled" | "vision">): string {
  return `Fog ${scene.fogEnabled ? "on" : "off"} · Party vision ${scene.vision?.on === true ? "on" : "off"}`;
}

/**
 * A scene's line in the Scenes list (SceneList.tsx): its kind, its size as
 * Size and view's summary says it, and its fog. A hex scene's bounds are
 * steps, so a row that read them would count one scene two ways. Squares
 * go unnamed, as they always did: a hex room's screens name squares only
 * where they are a choice (hex.e2e.ts HX4-4), and the list shows its
 * square scenes there too.
 */
export function sceneRowDetail(scene: Scene): string {
  // The summary's words stand alone, so their first letter is a capital. In the row's list they follow a comma.
  const size = isHex(sceneGrid(scene)) ? sizeText(scene).replace(/^No /, "no ") : `${scene.bounds.w} × ${scene.bounds.h}`;
  return `${scene.map ? "Map" : "Grid"}, ${size}, fog ${scene.fogEnabled ? "on" : "off"}`;
}

function formatPx(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
