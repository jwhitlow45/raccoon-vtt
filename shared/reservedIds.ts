import type { RoomState } from "./model.ts";
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

type ClientOp = { readonly t: string; readonly [field: string]: unknown };

/** A record's own entry, never a member read through its prototype. */
function own<T>(record: Readonly<Record<string, T>>, id: unknown): T | undefined {
  return typeof id === "string" && Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * The paths of ENTRY_ID_PATHS whose array replaces a stored one whole, each
 * with the stored array it replaces. An entry the room already holds comes
 * back in every such list, since an editor sends the whole of it (as
 * ResourceSheet does), so only an id the stored array lacks is new there,
 * and a legacy entry stays editable and removable (RULES-PRIV-03).
 */
export const REPLACED_ARRAYS: Readonly<Record<string, Readonly<Record<string, (op: ClientOp, state: RoomState) => readonly unknown[] | undefined>>>> = {
  "character.update": {
    "patch.resources[]": (op, state) => own(state.characters, op.characterId)?.resources,
    "patch.stats.rolls[]": (op, state) => own(state.characters, op.characterId)?.stats?.rolls,
  },
  "scene.update": {
    "patch.phases[]": (op, state) => own(state.scenes, op.sceneId)?.phases,
  },
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

function idOf(entry: unknown): unknown {
  return entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
}

/**
 * Whether a client op adds an array entry whose id names a member of
 * Object.prototype, read against `state`, the room the op applies to: in
 * an array that replaces a stored one, an id the stored one holds is no
 * addition (REPLACED_ARRAYS).
 */
export function addsReservedEntryId(op: ClientOp, state: RoomState): boolean {
  const paths = own(ENTRY_ID_PATHS, op.t);
  if (!paths) return false;
  for (const path of paths) {
    const replaces = own(REPLACED_ARRAYS, op.t)?.[path];
    const stored = new Set((replaces?.(op, state) ?? []).map(idOf));
    for (const entry of reach(op, path)) {
      const id = idOf(entry);
      if (typeof id === "string" && namesPrototypeMember(id) && !stored.has(id)) return true;
    }
  }
  return false;
}
