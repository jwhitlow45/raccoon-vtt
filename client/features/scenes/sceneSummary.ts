import type { Scene } from "#shared/model.ts";
import { PLAYERS_SEE_WORDS, playersSeeOf } from "#shared/playersSee.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { sceneHexSpan } from "#shared/rules/hex.ts";
import { SHAPE_CHOICES, shapeChoice } from "../grid/words.ts";
import { VIEW_NAMES, suggestedKind } from "../view/choice.ts";
import { LIGHT_LEVELS, lightOf, SIGHT_CHOICES, sightOf } from "../vision/settings.ts";
import type { SceneGroup } from "./settingsFolds.ts";

/*
 * What a folded group of the scene settings page says it holds
 * (docs/design-v1-design-pass.md 4.1), so a phone that starts three of the
 * four folded still reads the scene at a glance. Plain functions, for node
 * --test.
 */

const join = (parts: readonly (string | null)[]): string => parts.filter((p) => p !== null).join(" · ");

export function sceneGroupSummary(scene: Scene, group: SceneGroup): string {
  switch (group) {
    case "players":
      return join([
        PLAYERS_SEE_WORDS[playersSeeOf(scene)],
        LIGHT_LEVELS.find((l) => l.value === lightOf(scene))?.label ?? null,
        sightOf(scene) === "player" ? (SIGHT_CHOICES.find((c) => c.value === "player")?.label ?? null) : null,
      ]);
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

/**
 * The scene's size in its cells. A hex scene's bounds are steps of the
 * room's distance, not hexes, so it says the whole hexes they hold, as
 * the size row's help does (grid/words.ts `sizeWords`).
 */
function sizeText(scene: Scene): string {
  const g = sceneGrid(scene);
  if (!isHex(g)) return `${scene.bounds.w} × ${scene.bounds.h} squares`;
  const span = sceneHexSpan(g, scene.bounds);
  return `${span.cols} × ${span.rows} hexes`;
}

/** Fog and party vision's fold, folded inside What players see. */
export function fogFoldSummary(scene: Pick<Scene, "fogEnabled" | "vision">): string {
  return `Fog ${scene.fogEnabled ? "on" : "off"} · Party vision ${scene.vision?.on === true ? "on" : "off"}`;
}

function formatPx(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
