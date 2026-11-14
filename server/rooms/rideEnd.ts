import type { SeatView } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { ownsToken, seatView } from "#shared/project.ts";
import { RIDE_END_MOST, type OpOf } from "#shared/protocol.ts";
import { ownEntry } from "#shared/records.ts";
import { floorsOf } from "#shared/rules/floors.ts";

/**
 * The close step that ends what players put on creatures they no longer
 * see (shared/reducer/rideEnd.ts): an area a player put on a creature, or a
 * ruler a player kept on one, goes once its owner holds its floor and their
 * own view of the room does not hold the creature, or once the creature
 * left the floors of its scene its owner holds. A missing creature counts
 * as unseen. One on the owner's own creature never ends this way, and
 * behind a blackout nothing ends. Read from the state the batch leaves,
 * after its explore step, so the view is the one each owner's copy gets.
 */
export function rideEndOps(state: RoomState): OpOf<"sys.rideEnd">[] {
  if (state.meta.view?.blackout === true) return [];
  const views = new Map<string, SeatView>();
  const viewOf = (memberId: string): SeatView => {
    let view = views.get(memberId);
    if (!view) views.set(memberId, (view = seatView(state, memberId)));
    return view;
  };
  const player = (memberId: string) => ownEntry(state.members, memberId)?.kind === "player";
  const templates: string[] = [];
  const drawings: string[] = [];
  for (const area of Object.values(state.templates)) {
    if (area.attachedTo === undefined || !player(area.ownerId)) continue;
    if (ends(state, area.ownerId, viewOf(area.ownerId), area.sceneId, [area.attachedTo])) templates.push(area.id);
  }
  for (const drawing of Object.values(state.drawings)) {
    const anchors = (drawing.anchors ?? []).filter((id): id is string => id !== null);
    if (anchors.length === 0 || !player(drawing.ownerId)) continue;
    if (ends(state, drawing.ownerId, viewOf(drawing.ownerId), drawing.sceneId, anchors)) drawings.push(drawing.id);
  }
  templates.sort();
  drawings.sort();
  const ops: OpOf<"sys.rideEnd">[] = [];
  for (let i = 0; i < Math.max(templates.length, drawings.length); i += RIDE_END_MOST) {
    ops.push({ t: "sys.rideEnd", templates: templates.slice(i, i + RIDE_END_MOST), drawings: drawings.slice(i, i + RIDE_END_MOST) });
  }
  return ops;
}

function ends(state: RoomState, ownerId: string, view: SeatView, floor: string, creatures: readonly string[]): boolean {
  const owner = { memberId: ownerId, role: "player" as const };
  for (const id of creatures) {
    const creature = ownEntry(state.tokens, id);
    if (creature === undefined) {
      if (view.holds(floor)) return true;
      continue;
    }
    if (ownsToken(state, owner, creature) || view.sees(id)) continue;
    if (view.holds(floor)) return true;
    // The creature left the floors its owner holds: they hold a floor of its scene, not the one it stands on.
    if (!view.holds(creature.sceneId) && floorsOf(state, creature.sceneId).some((f) => view.holds(f.id))) return true;
  }
  return false;
}
