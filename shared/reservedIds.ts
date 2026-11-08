import { namesPrototypeMember } from "./records.ts";

/**
 * Where a live client op carries the id of a new array entry (PROTO-IDS-ARRAY-IDS).
 * An entity's own id is refused by the reducer (Tx.put), but the id of an
 * effect, an initiative entry or a roll inside an entity is not an
 * entity's, so a crafted client could name one "__proto__" or "constructor"
 * and every map the clients key by such an id would read a member of
 * Object.prototype. The server refuses those ops live. Stored ops apply as
 * stored, so a room that already holds such an id still replays.
 *
 * Each path is read from the op, where `[]` stands for every element of an
 * array, and names the objects whose `id` is checked. The test beside this
 * file walks the op schema and fails when an object with an `id` that could
 * name a member appears in no table here.
 */
export const ENTRY_ID_PATHS: Readonly<Record<string, readonly string[]>> = {
  "actor.effect.add": ["effect"],
  "actor.effects": ["add[].effect"],
  "actor.outcome": ["targets[].effects[]"],
  "character.create": ["character.actor.effects[]", "character.stats.rolls[]"],
  "character.update": ["patch.resources[]", "patch.stats.rolls[]"],
  "encounter.add": ["entries[]"],
  "encounter.start": ["entries[]"],
  "fog.draft": ["add[]"],
  "fog.live": ["ops[]"],
  "roll.change": ["ask"],
  "scene.update": ["patch.phases[]"],
  "token.create": ["token.actor.inline.effects[]"],
};

/**
 * Objects with an `id` the op schema allows that are no array entry's:
 * the entity an op creates, which the reducer refuses by id (Tx.put), and
 * the id of one the room already holds.
 */
export const ENTITY_ID_PATHS: Readonly<Record<string, readonly string[]>> = {
  "build.lights": ["put[]"],
  "build.stamps": ["put[]"],
  "cast.ask": ["cast"],
  "character.create": ["character"],
  "companionBlock.create": ["block"],
  "drawing.create": ["drawing"],
  "handout.show": ["handout"],
  "handoutDoc.create": ["doc"],
  "journal.create": ["page"],
  "monster.create": ["monster"],
  "pin.put": ["pin"],
  "roll.ask": ["request"],
  "savedEncounter.create": ["encounter"],
  "scene.create": ["scene"],
  "template.create": ["template"],
  "token.create": ["token"],
  "trap.create": ["trap"],
};

export const EXISTING_ID_PATHS: Readonly<Record<string, readonly string[]>> = {
  "actor.use": ["use"],
  "roll.ask": ["replaces[]"],
};

/** Every object a path reaches in a value, `[]` standing for each element of an array. */
function reach(value: unknown, path: string): unknown[] {
  let at: unknown[] = [value];
  for (const segment of path.split(".")) {
    const each = segment.endsWith("[]");
    const key = each ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const v of at) {
      if (v === null || typeof v !== "object") continue;
      const found = Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined;
      if (each) {
        if (Array.isArray(found)) next.push(...found);
      } else if (found !== undefined) next.push(found);
    }
    at = next;
  }
  return at;
}

/** Whether a client op adds an array entry whose id names a member of Object.prototype. */
export function addsReservedEntryId(op: { readonly t: string; readonly [field: string]: unknown }): boolean {
  const paths = Object.hasOwn(ENTRY_ID_PATHS, op.t) ? ENTRY_ID_PATHS[op.t] : undefined;
  if (!paths) return false;
  for (const path of paths) {
    for (const entry of reach(op, path)) {
      if (entry === null || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && namesPrototypeMember(id)) return true;
    }
  }
  return false;
}
