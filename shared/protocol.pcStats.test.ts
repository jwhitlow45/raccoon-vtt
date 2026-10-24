import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ABILITY_KEYS, SKILL_KEYS, type PcDice, type PcRoll, type PcStats } from "./model.ts";
import { DAMAGE_TYPES } from "./rules/damage.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import { clientOpSchema, ddbSyncForImport, EXPECT_PARTS, syncStamp, syncStampFits, MAX_PC_DICE_PARTS, MAX_PC_ROLLS, pcFillSchema, type DdbSyncPatch } from "./protocol.ts";
import { EMPTY_PC_STATS } from "./rules/pcStats.ts";
import { actor, AT } from "./testutil.ts";

/** A character's stat block's bounds (docs/design-v1-pc-stats.md 3.2 and 3.5). */

const BLOCK: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), saves: ["dex"], skills: { stealth: "expert" } };

function roll(overrides: Partial<PcRoll> = {}): PcRoll {
  return { id: "r1", name: "Longsword", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", type: "slashing", mod: true }], ...overrides };
}

function update(stats: unknown): unknown {
  return { t: "character.update", characterId: "bree", patch: { stats } };
}

function create(stats: unknown): unknown {
  return { t: "character.create", character: { id: "c", name: "Cora", size: "medium", ownerIds: [], actor: actor(), stats } };
}

const ok = (value: unknown) => clientOpSchema.safeParse(value).success;

describe("a stat block's schema", () => {
  test("a whole block on create, a patch of parts, and null on update pass", () => {
    assert.ok(ok(create({ ...BLOCK, rolls: [roll()] })));
    assert.ok(ok(update({ saves: ["con"], jack: true, spellAbility: null, critOn: 19 })));
    assert.ok(ok(update(null)));
    assert.ok(ok(update({})));
  });

  test("scores 1 to 30, adjustments -20 to 20, a fixed DC 1 to 50, levels 0 to 9", () => {
    assert.equal(ok(update({ abilities: { ...BLOCK.abilities, str: 31 } })), false);
    assert.equal(ok(update({ abilities: { ...BLOCK.abilities, str: 0 } })), false);
    assert.ok(ok(update({ abilities: { ...BLOCK.abilities, str: 30, dex: 1 } })));
    assert.equal(ok(update({ adjust: { init: 21 } })), false);
    assert.equal(ok(update({ adjust: { saves: { dex: -21 } } })), false);
    assert.ok(ok(update({ adjust: { saves: { dex: -20 }, skills: { stealth: 20 }, allSaves: 1, allChecks: 1, init: 1, passive: 1, spellDc: 1, spellAttack: 1 } })));
    assert.equal(ok(update({ rolls: [roll({ save: { ability: "dex", dc: 51 } })] })), false);
    assert.equal(ok(update({ rolls: [roll({ save: { ability: "dex", dc: 0 } })] })), false);
    assert.equal(ok(update({ rolls: [roll({ kind: "spell", level: 10 })] })), false);
    assert.equal(ok(update({ rolls: [roll({ attack: { prof: true, bonus: 21 } })] })), false);
  });

  test("lists without repeats, 40 rolls with ids unique in the block, 4 parts a roll", () => {
    assert.equal(ok(update({ saves: ["dex", "dex"] })), false);
    assert.equal(ok(update({ rolls: [roll(), roll()] })), false, "two rolls with one id");
    const many = Array.from({ length: MAX_PC_ROLLS }, (_, i) => roll({ id: `r${i}`, name: `R${i}` }));
    assert.ok(ok(update({ rolls: many })));
    assert.equal(ok(update({ rolls: [...many, roll({ id: "extra" })] })), false);
    const parts: PcDice[] = Array.from({ length: MAX_PC_DICE_PARTS }, () => ({ formula: "1d6", type: "fire" }));
    assert.ok(ok(update({ rolls: [roll({ dice: parts })] })));
    assert.equal(ok(update({ rolls: [roll({ dice: [...parts, { formula: "1d6" }] })] })), false);
    assert.equal(ok(update({ skills: { juggling: "prof" } })), false, "an unknown skill");
    assert.equal(ok(update({ defenses: { fire: "resistant", psychic: "immune", charm: "immune" } })), false, "an unknown damage type");
  });

  test("a formula holds dice and numbers alone, at most 40 characters, and is never parsed", () => {
    assert.ok(ok(update({ rolls: [roll({ dice: [{ formula: "2d6 + 1", type: "fire" }, { formula: "4d6kh3" }, { formula: "1d%" }, { formula: "1d8 − 1" }] })] })));
    // A formula the grammar refuses still passes, so a later grammar never stops a stored op from replaying.
    assert.ok(ok(update({ rolls: [roll({ dice: [{ formula: "1d8+" }] })] })));
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "2d6 fire" }] })] })), false);
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "1d6\n" }] })] })), false);
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "1".repeat(41) }] })] })), false);
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "" }] })] })), false);
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "8d6", type: "fire", upcast: "1".repeat(21) }] })] })), false, "upcast 20 characters");
  });

  test("a roll needs an attack, a save or dice, never both a fixed DC and a bonus, and its name is one line of 1 to 60 characters", () => {
    assert.equal(ok(update({ rolls: [roll({ attack: undefined, dice: [] })] })), false);
    assert.ok(ok(update({ rolls: [roll({ attack: undefined, dice: [], save: { ability: "dex", bonus: 1 } })] })));
    assert.equal(ok(update({ rolls: [roll({ save: { ability: "dex", dc: 13, bonus: 1 } })] })), false);
    assert.equal(ok(update({ rolls: [roll({ name: "" })] })), false);
    assert.equal(ok(update({ rolls: [roll({ name: "x".repeat(61) })] })), false);
    assert.equal(ok(update({ rolls: [roll({ name: "Long\nsword" })] })), false);
    assert.equal(ok(update({ rolls: [roll({ name: "Long‮sword" })] })), false, "no text direction controls");
  });

  test("On a pass is half, none, or unset for not known", () => {
    for (const onPass of ["half", "none"] as const) assert.ok(ok(update({ rolls: [roll({ save: { ability: "dex", onPass } })] })));
    assert.ok(ok(update({ rolls: [roll({ save: { ability: "dex" } })] })));
    assert.equal(ok(update({ rolls: [roll({ save: { ability: "dex", onPass: "quarter" as "half" } })] })), false);
  });

  test("upcast only on damage or healing, a name only on a rider, and a rider is damage", () => {
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "1d8", upcast: "1d8" }] })] })), false);
    assert.ok(ok(update({ rolls: [roll({ dice: [{ formula: "1d8", type: "healing", upcast: "1d8" }] })] })));
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "3d6", type: "piercing", name: "Sneak Attack" }] })] })), false);
    assert.ok(ok(update({ rolls: [roll({ dice: [{ formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" }] })] })));
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "1d8", optional: true }] })] })), false);
    assert.equal(ok(update({ rolls: [roll({ dice: [{ formula: "1d8", type: "healing", optional: true }] })] })), false);
  });

  test("the block and a patch are at most 12 KiB serialized, and the largest op fits the socket's frame five times", () => {
    const filler = (n: number): PcRoll[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `${"r".repeat(60)}${String(i).padStart(4, "0")}`,
        name: "x".repeat(60),
        kind: "spell",
        ability: "spell",
        attack: { prof: true, bonus: 20 },
        save: { ability: "wis", bonus: -20, onPass: "half" },
        level: 9,
        dice: Array.from({ length: MAX_PC_DICE_PARTS }, () => ({ formula: "1".repeat(40), type: "necrotic", upcast: "1".repeat(20), optional: true, name: "y".repeat(30) }) satisfies PcDice),
      }));
    let n = 1;
    while (serializedBytes({ ...BLOCK, rolls: filler(n + 1) }) <= LIMITS.pcStatsBytes) n++;
    assert.ok(ok(create({ ...BLOCK, rolls: filler(n) })));
    assert.equal(ok(create({ ...BLOCK, rolls: filler(n + 1) })), false);
    assert.equal(ok(update({ rolls: filler(n + 1) })), false);
    const largest = update({ rolls: filler(n) });
    assert.ok(ok(largest));
    assert.ok(serializedBytes({ t: "op", n: 1, op: largest }) * 5 <= 64 * 1024);
  });
});

/** A sync record's bounds and a re-sync's `expect` (docs/design-v1-resync.md 4). */
describe("a re-sync's schema", () => {
  const hex12 = (n: number) => n.toString(16).padStart(12, "0");
  const RECORD: DdbSyncPatch = {
    from: "123456789",
    base: { abilities: BLOCK.abilities, saves: ["dex"], spellAbility: null, critOn: null, jack: false, level: 5, ac: 15, hpMax: 38, speeds: { walk: 30 }, senses: "Darkvision 60 ft." },
    rolls: { [hex12(1)]: { k: "w:0123456789ab", h: "abcdef012345" } },
    gone: ["s:0123456789ab"],
  };
  const sync = (ddbSync: unknown, expect?: unknown) => ({ t: "character.update", characterId: "bree", patch: { ddbSync }, ...(expect === undefined ? {} : { expect }) });
  const entries = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [hex12(i), { k: `o:${hex12(i)}`, h: hex12(i) }]));

  test("a record without at, one with an ISO at, and null pass on update, and create takes none", () => {
    assert.ok(ok(sync(RECORD)));
    assert.ok(ok(sync({ base: {}, rolls: {} })));
    assert.ok(ok(sync({ ...RECORD, at: AT })));
    assert.ok(ok(sync(null)));
    assert.equal(ok(sync({ ...RECORD, at: "yesterday" })), false);
    assert.equal(ok(sync({ ...RECORD, at: "2026-10-12" })), false, "a date alone");
    assert.equal(ok({ t: "character.create", character: { id: "c", name: "Cora", size: "medium", ownerIds: [], actor: actor(), ddbSync: { ...RECORD, at: AT } } }), false);
    assert.equal(ok({ t: "character.create", character: { id: "c", name: "Cora", size: "medium", ownerIds: [], actor: actor() }, expect: { level: hex12(1) } }), false);
  });

  test("the stored record needs its at, and holds every other bound the patch does", () => {
    assert.ok(ddbSyncForImport.safeParse({ ...RECORD, at: AT }).success);
    assert.equal(ddbSyncForImport.safeParse(RECORD).success, false);
    assert.equal(ddbSyncForImport.safeParse({ ...RECORD, at: AT, rolls: entries(MAX_PC_ROLLS + 1) }).success, false);
  });

  test("a stamp past a record parses up to the schema's last millisecond, and none fits past it (RS-SOL-2)", () => {
    assert.equal(syncStampFits(undefined), true);
    assert.equal(syncStampFits(AT), true);
    assert.equal(syncStampFits("9999-12-31T23:59:59.998Z"), true);
    assert.equal(syncStamp(AT, "9999-12-31T23:59:59.998Z"), "9999-12-31T23:59:59.999Z");
    assert.equal(syncStampFits("9999-12-31T23:59:59.999Z"), false);
    assert.equal(syncStamp(AT, "9999-12-31T23:59:59.999Z"), "+010000-01-01T00:00:00.000Z", "which the schema refuses");
    assert.equal(ok(sync({ ...RECORD, at: "+010000-01-01T00:00:00.000Z" })), false);
  });

  test("entry keys and h are 12 lower-case hex digits, and k and each gone marker a kind's letter, a colon and one", () => {
    assert.equal(ok(sync({ ...RECORD, rolls: { "0123456789AB": { k: "w:0123456789ab", h: "abcdef012345" } } })), false);
    assert.equal(ok(sync({ ...RECORD, rolls: { "0123456789a": { k: "w:0123456789ab", h: "abcdef012345" } } })), false);
    assert.equal(ok(sync({ ...RECORD, rolls: { r1: { k: "w:0123456789ab", h: "abcdef012345" } } })), false, "a roll's id in clear");
    assert.equal(ok(sync({ ...RECORD, rolls: { [hex12(1)]: { k: "w:0123456789ab", h: "abcdef01234g" } } })), false);
    for (const k of ["x:0123456789ab", "w:longsword", "w0123456789ab", "W:0123456789ab", "w:0123456789abc", "s:fireball:3"]) {
      assert.equal(ok(sync({ ...RECORD, rolls: { [hex12(1)]: { k, h: "abcdef012345" } } })), false, `k ${k}`);
      assert.equal(ok(sync({ ...RECORD, gone: [k] })), false, `gone ${k}`);
    }
    for (const k of ["w:0123456789ab", "s:0123456789ab", "o:0123456789ab"]) assert.ok(ok(sync({ ...RECORD, gone: [k] })));
    assert.equal(ok(sync({ ...RECORD, rolls: { [hex12(1)]: { k: "w:0123456789ab", h: "abcdef012345", name: "Longsword" } } })), false, "an entry holds k and h alone");
  });

  test("at most 40 entries and 40 gone markers", () => {
    assert.ok(ok(sync({ ...RECORD, rolls: entries(MAX_PC_ROLLS), gone: Array.from({ length: MAX_PC_ROLLS }, (_, i) => `w:${hex12(i)}`) })));
    assert.equal(ok(sync({ ...RECORD, rolls: entries(MAX_PC_ROLLS + 1) })), false);
    assert.equal(ok(sync({ ...RECORD, gone: Array.from({ length: MAX_PC_ROLLS + 1 }, (_, i) => `w:${hex12(i)}`) })), false);
  });

  test("from is 1 to 12 digits, and the base takes the fill's bounds and no name", () => {
    for (const from of ["1", "123456789012"]) assert.ok(ok(sync({ ...RECORD, from })));
    for (const from of ["", "1234567890123", "12a", " 12", "-1"]) assert.equal(ok(sync({ ...RECORD, from })), false, `from ${JSON.stringify(from)}`);
    assert.equal(ok(sync({ ...RECORD, base: { ...RECORD.base, name: "Bree" } })), false);
    assert.equal(ok(sync({ ...RECORD, base: { ...RECORD.base, level: 21 } })), false);
    assert.equal(ok(sync({ ...RECORD, base: { ...RECORD.base, abilities: { ...BLOCK.abilities, str: 31 } } })), false);
    assert.equal(ok(sync({ ...RECORD, base: { ...RECORD.base, rolls: [] } })), false, "rolls are in the entries, never the base");
    assert.equal(ok(sync({ ...RECORD, extra: 1 })), false);
  });

  test("a time is the server's own, to the millisecond, so a record at every bound stays under 6 KiB", () => {
    assert.equal(ok(sync({ ...RECORD, at: "2026-10-12T20:00:00.1234Z" })), false, "more digits than the server writes");
    assert.equal(ok(sync({ ...RECORD, at: "2026-10-12T20:00:00Z" })), false, "fewer");
    const every: DdbSyncPatch = {
      at: AT,
      from: "123456789012",
      base: {
        ...RECORD.base,
        saves: ["str", "dex", "con", "int", "wis", "cha"],
        skills: Object.fromEntries(SKILL_KEYS.map((s) => [s, "expert"])),
        adjust: { saves: Object.fromEntries(ABILITY_KEYS.map((a) => [a, -20])), skills: Object.fromEntries(SKILL_KEYS.map((s) => [s, -20])), allSaves: -20, allChecks: -20, init: -20, passive: -20, spellDc: -20, spellAttack: -20 },
        defenses: Object.fromEntries(DAMAGE_TYPES.map((t) => [t, "vulnerable"])),
        jack: false,
        alert: false,
        evasion: false,
        critOn: 18,
        level: 20,
        ac: 100,
        hpMax: 100_000,
        speeds: { walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: false },
        senses: "暗".repeat(80),
      },
      rolls: entries(MAX_PC_ROLLS),
      gone: Array.from({ length: MAX_PC_ROLLS }, (_, i) => `w:${hex12(i)}`),
    };
    assert.ok(ok(sync(every)));
    assert.ok(serializedBytes(every) < LIMITS.ddbSyncBytes, `${serializedBytes(every)} bytes`);
  });

  test("expect takes a 12-hex hash for each part it names, and no other part", () => {
    assert.ok(ok(sync(RECORD, {})));
    assert.ok(ok(sync(RECORD, Object.fromEntries(EXPECT_PARTS.map((part, i) => [part, hex12(i)])))));
    assert.equal(ok(sync(RECORD, { "actor.notes": hex12(1) })), false, "a part no expect names");
    assert.equal(ok(sync(RECORD, { "actor.dmNotes": hex12(1) })), false, "a part players lack");
    assert.equal(ok(sync(RECORD, { stats: hex12(1) })), false, "the whole block");
    for (const hash of ["0123456789AB", "0123456789a", "0123456789abc", "", null]) assert.equal(ok(sync(RECORD, { level: hash })), false, `hash ${JSON.stringify(hash)}`);
    assert.ok(ok({ t: "character.update", characterId: "bree", patch: { level: 5 }, expect: { level: hex12(1) } }), "on any character update");
  });

  test("a fill carries which kinds it read whole, or leaves it out", () => {
    const fill = { source: "ddb", stats: { rolls: [] }, actor: {}, warnings: [] };
    assert.ok(pcFillSchema.safeParse(fill).success);
    assert.ok(pcFillSchema.safeParse({ ...fill, read: { weapon: true, spell: false, other: true } }).success);
    assert.equal(pcFillSchema.safeParse({ ...fill, read: { weapon: true, spell: false } }).success, false);
    assert.equal(pcFillSchema.safeParse({ ...fill, read: { weapon: true, spell: false, other: true, feat: true } }).success, false);
    assert.equal(pcFillSchema.safeParse({ ...fill, read: { weapon: "yes", spell: false, other: true } }).success, false);
  });
});

/** The record's class resources and a character update's counts spent (docs/design-v1-ddb-resources.md 4.1 and 5). */
describe("class resources in a sync's schema", () => {
  const hex12 = (n: number) => n.toString(16).padStart(12, "0");
  const RECORD: DdbSyncPatch = { base: {}, rolls: {}, res: { [hex12(1)]: { k: "r:0123456789ab", h: "abcdef012345" } }, gone: ["r:00000000000a", "w:00000000000b"] };
  const sync = (ddbSync: unknown) => ({ t: "character.update", characterId: "bree", patch: { ddbSync } });
  const resources = (list: unknown[]) => ({ t: "character.update", characterId: "bree", patch: { resources: list } });
  const rage = { id: "rage", name: "Rage", max: 3, reset: "shortOne" };

  test("a resource entry's k is r: and 12 hex, never a roll's letter, and a roll's k is never r:", () => {
    assert.ok(ok(sync(RECORD)));
    for (const k of ["w:0123456789ab", "r:0123456789AB", "r:0123456789a", "r:rage", "x:0123456789ab"]) assert.equal(ok(sync({ ...RECORD, res: { [hex12(1)]: { k, h: "abcdef012345" } } })), false, `res k ${k}`);
    assert.equal(ok(sync({ ...RECORD, rolls: { [hex12(1)]: { k: "r:0123456789ab", h: "abcdef012345" } } })), false, "a roll keyed as a resource");
    assert.equal(ok(sync({ ...RECORD, res: { RAGE: { k: "r:0123456789ab", h: "abcdef012345" } } })), false, "an id in clear");
    assert.equal(ok(sync({ ...RECORD, res: { [hex12(1)]: { k: "r:0123456789ab", h: "abcdef012345", used: 1 } } })), false, "an entry holds k and h alone");
  });

  test("gone takes an r: marker beside the rolls' letters, 40 of both together at most", () => {
    assert.ok(ok(sync({ ...RECORD, gone: Array.from({ length: MAX_PC_ROLLS }, (_, i) => `${i % 2 ? "r" : "o"}:${hex12(i)}`) })));
    assert.equal(ok(sync({ ...RECORD, gone: Array.from({ length: MAX_PC_ROLLS + 1 }, (_, i) => `r:${hex12(i)}`) })), false);
    assert.equal(ok(sync({ ...RECORD, gone: ["q:0123456789ab"] })), false);
  });

  test("at most 12 resource entries, and the stored record takes them", () => {
    const res = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [hex12(i), { k: `r:${hex12(i)}`, h: hex12(i) }]));
    assert.ok(ok(sync({ ...RECORD, res: res(LIMITS.resourcesPerCharacter) })));
    assert.equal(ok(sync({ ...RECORD, res: res(LIMITS.resourcesPerCharacter + 1) })), false);
    assert.ok(ddbSyncForImport.safeParse({ ...RECORD, at: AT }).success);
    assert.equal(ddbSyncForImport.safeParse({ ...RECORD, at: AT, res: res(13) }).success, false);
  });

  test("a record at every bound with its 12 resources stays under 6 KiB (4.1)", () => {
    const every: DdbSyncPatch = {
      at: AT,
      from: "123456789012",
      base: {
        abilities: BLOCK.abilities,
        saves: ["str", "dex", "con", "int", "wis", "cha"],
        skills: Object.fromEntries(SKILL_KEYS.map((s) => [s, "expert"])),
        adjust: { saves: Object.fromEntries(ABILITY_KEYS.map((a) => [a, -20])), skills: Object.fromEntries(SKILL_KEYS.map((s) => [s, -20])), allSaves: -20, allChecks: -20, init: -20, passive: -20, spellDc: -20, spellAttack: -20 },
        defenses: Object.fromEntries(DAMAGE_TYPES.map((t) => [t, "vulnerable"])),
        spellAbility: null,
        jack: false,
        alert: false,
        evasion: false,
        critOn: 18,
        level: 20,
        ac: 100,
        hpMax: 100_000,
        speeds: { walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: false },
        senses: "暗".repeat(80),
      },
      rolls: Object.fromEntries(Array.from({ length: MAX_PC_ROLLS }, (_, i) => [hex12(i), { k: `o:${hex12(i)}`, h: hex12(i) }])),
      res: Object.fromEntries(Array.from({ length: LIMITS.resourcesPerCharacter }, (_, i) => [hex12(100 + i), { k: `r:${hex12(i)}`, h: hex12(i) }])),
      gone: Array.from({ length: MAX_PC_ROLLS }, (_, i) => `r:${hex12(i)}`),
    };
    assert.ok(ok(sync(every)));
    assert.ok(serializedBytes(every) < LIMITS.ddbSyncBytes, `${serializedBytes(every)} bytes`);
  });

  test("an update's resource may carry used, 0 to its count, whole", () => {
    assert.ok(ok(resources([rage])));
    assert.ok(ok(resources([{ ...rage, used: 0 }])));
    assert.ok(ok(resources([{ ...rage, used: 3 }])));
    for (const used of [4, -1, 1.5, "1", null]) assert.equal(ok(resources([{ ...rage, used }])), false, `used ${JSON.stringify(used)}`);
    assert.ok(ok(resources([{ id: "loh", name: "Lay on Hands", max: 200, reset: "long", pool: true, used: 200 }])));
  });

  test("expect names the class resources", () => {
    assert.ok(EXPECT_PARTS.includes("resources"));
    assert.ok(ok({ t: "character.update", characterId: "bree", patch: { resources: [rage] }, expect: { resources: hex12(1) } }));
  });
});

/** A fill's class resources (docs/design-v1-ddb-resources.md 3.1). */
describe("class resources in a fill's schema", () => {
  test("a fill's class resources: each field bounded, a class of the twelve, at most 12, and read.resource", () => {
    const fill = { source: "ddb", stats: { rolls: [] }, actor: {}, warnings: [], read: { weapon: true, spell: true, other: true, resource: true } };
    const wild = { name: "Wild Shape", max: 3, reset: "shortOne", preset: "druid-wild-shape", level: 6, classId: "druid", used: 1 };
    const parse = (resources: unknown[], over: Record<string, unknown> = {}) => pcFillSchema.safeParse({ ...fill, resources, ...over }).success;
    assert.ok(parse([wild]));
    assert.ok(parse([{ name: "Breath Weapon", max: 3, reset: "long" }]));
    assert.ok(parse([wild], { read: { weapon: true, spell: true, other: true } }), "read.resource may be absent");
    assert.equal(parse([{ ...wild, classId: "artificer" }]), false, "an unknown class (OP-4)");
    assert.equal(parse([{ ...wild, used: 4 }]), false, "used past the count");
    assert.equal(parse([{ ...wild, id: "w1" }]), false, "no id, which the merge gives");
    assert.equal(parse([{ ...wild, max: 100 }]), false, "a count past 99");
    assert.ok(parse([{ ...wild, max: 100, pool: true }]), "a pool to 200");
    assert.equal(parse([{ ...wild, name: "\uD83D" }]), false, "half a character");
    assert.equal(parse([{ ...wild, edited: true }]), false, "a strict object");
    assert.equal(parse(Array.from({ length: 13 }, () => wild)), false);
    assert.equal(parse([wild], { read: { weapon: true, spell: true, other: true, resource: "yes" } }), false);
  });
});
