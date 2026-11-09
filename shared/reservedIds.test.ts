import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClassResource, MapPhase, PcRoll, PcStats, RoomState } from "./model.ts";
import { clientOpSchema } from "./protocol.ts";
import { addsReservedEntryId, ENTITY_ID_PATHS, ENTRY_ID_PATHS, EXISTING_ID_PATHS, REPLACED_ARRAYS } from "./reservedIds.ts";
import { character, room, scene } from "./testutil.ts";

/**
 * PROTO-IDS-ARRAY-IDS. The list of ops and paths that carry a new array
 * entry's id comes from a walk of the client op schema, so a new op with
 * such an entry fails here until its path is listed (or named as an
 * entity's or an existing id's, with the reason in reservedIds.ts).
 */

const MEMBERS = Object.getOwnPropertyNames(Object.prototype);

/** A room holding none of the arrays a replacement reads, so every id an op brings is new. */
const EMPTY = room();

// Zod's own definitions are the only way to read a schema's shape, and they are not typed for it.
type Def = { type: string; shape?: Record<string, Zod>; element?: Zod; options?: Zod[]; innerType?: Zod; in?: Zod; valueType?: Zod; items?: Zod[]; left?: Zod; right?: Zod; values?: unknown[] };
type Zod = { _zod: { def: Def }; safeParse(value: unknown): { success: boolean } };

function children(def: Def): Array<[string, Zod]> {
  switch (def.type) {
    case "object":
      return Object.entries(def.shape ?? {});
    case "array":
      return [["[]", def.element!]];
    case "union":
      return (def.options ?? []).map((o): [string, Zod] => ["", o]);
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
      return [["", def.innerType!]];
    case "pipe":
      return [["", def.in!]];
    case "record":
      return [["{}", def.valueType!]];
    case "tuple":
      return (def.items ?? []).map((o): [string, Zod] => ["", o]);
    case "intersection":
      return [["", def.left!], ["", def.right!]];
    default:
      return [];
  }
}

/** Every `op path` whose object has an `id` that accepts the name of an Object.prototype member, below the op's own fields. */
function openIdPaths(): Set<string> {
  const found = new Set<string>();
  const walk = (schema: Zod, path: string, depth: number, t: string): void => {
    const def = schema._zod.def;
    const id = def.type === "object" ? def.shape?.id : undefined;
    if (id && depth > 0 && MEMBERS.some((name) => id.safeParse(name).success)) found.add(`${t} ${path}`);
    for (const [key, child] of children(def)) walk(child, key === "" ? path : key.startsWith("[") || key.startsWith("{") ? path + key : path === "" ? key : `${path}.${key}`, depth + 1, t);
  };
  for (const option of (clientOpSchema as unknown as { _zod: { def: { options: Zod[] } } })._zod.def.options) {
    const t = option._zod.def.shape?.t?._zod.def.values?.[0];
    if (typeof t === "string") walk(option, "", 0, t);
  }
  return found;
}

function listed(...tables: Array<Readonly<Record<string, readonly string[]>>>): Set<string> {
  return new Set(tables.flatMap((table) => Object.entries(table).flatMap(([t, paths]) => paths.map((path) => `${t} ${path}`))));
}

/** An op value with `entry` at `path`, built from the path alone. */
function opWith(t: string, path: string, entry: unknown): { t: string; [field: string]: unknown } {
  const segments = path.split(".");
  const nest = (i: number): unknown => {
    if (i === segments.length) return entry;
    const segment = segments[i]!;
    const each = segment.endsWith("[]");
    const key = each ? segment.slice(0, -2) : segment;
    const inner = nest(i + 1);
    return { [key]: each ? [inner] : inner };
  };
  return { ...(nest(0) as Record<string, unknown>), t };
}

describe("ids of new array entries (PROTO-IDS-ARRAY-IDS)", () => {
  test("every object with an id that could name a prototype member is in one table, and no table lists a path that is gone", () => {
    const walked = openIdPaths();
    const all = listed(ENTRY_ID_PATHS, ENTITY_ID_PATHS, EXISTING_ID_PATHS);
    assert.deepEqual([...walked].filter((p) => !all.has(p)).sort(), [], "an op carries an id the tables do not list");
    assert.deepEqual([...all].filter((p) => !walked.has(p)).sort(), [], "a table lists a path the op schema no longer has");
    for (const entry of listed(ENTRY_ID_PATHS)) assert.ok(!listed(ENTITY_ID_PATHS, EXISTING_ID_PATHS).has(entry), `${entry} is in two tables`);
  });

  test("at every listed path, an entry named for any member of Object.prototype is found and an ordinary id is not", () => {
    for (const [t, paths] of Object.entries(ENTRY_ID_PATHS)) {
      for (const path of paths) {
        for (const name of MEMBERS) assert.equal(addsReservedEntryId(opWith(t, path, { id: name }), EMPTY), true, `${t} ${path} ${name}`);
        assert.equal(addsReservedEntryId(opWith(t, path, { id: "prototype" }), EMPTY), false, `${t} ${path}: prototype is no member`);
        assert.equal(addsReservedEntryId(opWith(t, path, { id: "e1" }), EMPTY), false, `${t} ${path}: e1`);
      }
    }
  });

  test("an op of another kind, or with no entries, names none", () => {
    assert.equal(addsReservedEntryId({ t: "log.chat" }, EMPTY), false);
    assert.equal(addsReservedEntryId({ t: "encounter.add", entries: [] }, EMPTY), false);
    assert.equal(addsReservedEntryId({ t: "encounter.add", entries: [{ id: "a" }, { id: "b" }, { id: "constructor" }] }, EMPTY), true);
    // Only the entries' own ids count, not another field's value.
    assert.equal(addsReservedEntryId({ t: "encounter.add", entries: [{ id: "a", label: "constructor", tokenId: "__proto__" }] }, EMPTY), false);
    assert.equal(addsReservedEntryId({ t: "toString" }, EMPTY), false);
  });

  test("a whole array that replaces a stored one refuses only reserved ids the stored one lacks, so a legacy entry kept beside an edit passes (RULES-PRIV-03)", () => {
    // Stored before ids were checked: a resource, a stat block roll and a map phase each named for a member.
    const legacy = (id: string, extra: object) => ({ id, ...extra });
    const resources = [legacy("constructor", { name: "Old", max: 2, used: 0, reset: "long" }), legacy("r1", { name: "Rage", max: 3, used: 0, reset: "long" })] as ClassResource[];
    const rolls = [legacy("toString", { name: "Old", kind: "other" }), legacy("w1", { name: "Axe", kind: "weapon" })] as PcRoll[];
    const phases = [legacy("valueOf", { name: "Old" }), legacy("ph1", { name: "Day" })] as MapPhase[];
    const state: RoomState = room({ characters: { c1: character("c1", { resources, stats: { rolls } as PcStats }) }, scenes: { s1: scene("s1", { phases }) } });
    const cases = [
      { what: "a class resource", stored: resources, op: (list: object[]) => ({ t: "character.update", characterId: "c1", patch: { resources: list } }) },
      { what: "a stat block roll", stored: rolls, op: (list: object[]) => ({ t: "character.update", characterId: "c1", patch: { stats: { rolls: list } } }) },
      { what: "a map phase", stored: phases, op: (list: object[]) => ({ t: "scene.update", sceneId: "s1", patch: { phases: list } }) },
    ];
    for (const { what, stored, op } of cases) {
      const [kept, ordinary] = stored as readonly { id: string }[] as [{ id: string }, { id: string }];
      assert.equal(addsReservedEntryId(op([kept, { ...ordinary, name: "Edited" }]), state), false, `${what}: kept beside an edit of another`);
      assert.equal(addsReservedEntryId(op([kept, ordinary, { ...ordinary, id: "fresh" }]), state), false, `${what}: kept beside an ordinary addition`);
      assert.equal(addsReservedEntryId(op([ordinary]), state), false, `${what}: removed`);
      assert.equal(addsReservedEntryId(op([kept, ordinary, { ...ordinary, id: "hasOwnProperty" }]), state), true, `${what}: a new reserved id is still refused`);
      assert.equal(addsReservedEntryId(op([kept]), EMPTY), true, `${what}: a reserved id is new where nothing is stored`);
    }
    // Another character's, or another scene's, is no stored array of this one.
    assert.equal(addsReservedEntryId({ t: "character.update", characterId: "c2", patch: { resources: [resources[0]] } }, state), true);
    assert.equal(addsReservedEntryId({ t: "scene.update", sceneId: "s2", patch: { phases: [phases[0]] } }, state), true);
    // An id naming a member reads no stored array through the prototype.
    assert.equal(addsReservedEntryId({ t: "character.update", characterId: "constructor", patch: { resources: [resources[0]] } }, state), true);
  });

  test("every replacement path is one of the entry paths", () => {
    for (const [t, paths] of Object.entries(REPLACED_ARRAYS)) for (const path of Object.keys(paths)) assert.ok(ENTRY_ID_PATHS[t]?.includes(path), `${t} ${path}`);
  });
});
