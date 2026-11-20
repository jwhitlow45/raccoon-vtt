import type { RoomState, SceneId } from "#shared/model.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import type { Labels } from "../../lib/labels.ts";
import { displayName, footprint } from "../../lib/scene.ts";
import type { OutlineRow } from "./rows.ts";

/*
 * The outliner's Other floors group (docs/design/design-v1-floors.md phase 4,
 * 9.6): a row for each creature or object standing on another floor of the
 * scene shown. Its reader takes the whole copy, which holds every floor the
 * device holds, where the rest of the outliner reads the cut of the floor
 * shown (state/floorView.ts). The DM's copy holds every floor, so a floor
 * players have not reached is listed too.
 */

/** The ids of the floors of the scene this floor belongs to, bottom first: one on a scene without floors. */
export function sceneFloorIds(whole: Pick<RoomState, "scenes">, sceneId: SceneId): SceneId[] {
  return floorsOf(whole, sceneId).map((f) => f.id);
}

/** Whether the scene has more than one floor in this copy. */
export function hasOtherFloors(whole: Pick<RoomState, "scenes">, sceneId: SceneId): boolean {
  return floorsOf(whole, sceneId).length > 1;
}

/** The rows of every creature and object on the other floors of the scene, each with its floor's name for a detail. */
export function otherFloorRows(whole: RoomState, sceneId: SceneId, labels: Labels): OutlineRow[] {
  const floors = floorsOf(whole, sceneId);
  if (floors.length < 2) return [];
  const rank = new Map(floors.map((f, i) => [f.id, i]));
  const rows: OutlineRow[] = [];
  for (const t of Object.values(whole.tokens)) {
    if (!t || t.sceneId === sceneId) continue;
    const at = rank.get(t.sceneId);
    if (at === undefined) continue;
    const floor = floors[at]!;
    const fp = footprint(t);
    const name = displayName(t, labels);
    const detail = floor.floor?.name ?? floor.name;
    rows.push({
      key: `token:${t.id}`,
      group: "other",
      kind: "token",
      id: t.id,
      name,
      detail,
      // The DM's own hidden ones are the one mark the whole copy answers without projecting a floor the DM is not on.
      mark: t.visibility === "dm" ? "Hidden" : null,
      rect: { x: t.x, y: t.y, width: fp.w, height: fp.h },
      search: `${name} ${detail}`.toLowerCase(),
      floor: t.sceneId,
      floorRank: at,
    });
  }
  return rows;
}
