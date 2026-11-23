import { isUuidv7 } from "#shared/ids.ts";
import { readEntity, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectEntity } from "#shared/project.ts";
import { nestedIdsIn, newIdsOf, type Op } from "#shared/protocol.ts";

/**
 * Step 5 of the id gate (createIds.ts): the version 7 ids an op brings in
 * its keys and nested fields (shared/protocol.ts NEW_ID_PATHS) for things
 * that are new, in the op's order.
 *
 * A DM's op is read against the room before it. A player's is read against
 * the player's own copy: the keys their socket holds, and each entity as
 * it is projected for them. So the answer, and the ids it names, are the
 * same whatever the room holds that the player does not, and name only ids
 * the op itself carries.
 */
export function newV7Ids(op: Op, before: RoomState, viewer: Viewer, held: ReadonlyMap<EntityKey, unknown> | null): string[] {
  const { keys, nested } = newIdsOf(op);
  if (keys.length === 0 && nested.length === 0) return [];
  const player = viewer.role !== "dm";
  const found: string[] = [];
  const named = new Set<string>();
  const add = (id: string) => {
    if (named.has(id)) return;
    named.add(id);
    found.push(id);
  };
  for (const at of keys) {
    if (!isUuidv7(at.id)) continue;
    const has = player ? (held?.has(at.key) ?? false) : readEntity(before, at.key) !== null;
    if (!has) add(at.id);
  }
  const values = new Map<string, ReadonlySet<string>>();
  for (const at of nested) {
    if (!isUuidv7(at.id)) continue;
    let ids = values.get(at.key);
    if (!ids) {
      const value = player ? projectEntity(at.key, before, viewer, { sceneId: before.meta.playerSceneId }) : readEntity(before, at.key);
      values.set(at.key, (ids = nestedIdsIn(at.key, value)));
    }
    if (!ids.has(at.id)) add(at.id);
  }
  return found;
}
