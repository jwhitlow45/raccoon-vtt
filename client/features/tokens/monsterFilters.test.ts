import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { StatBlock } from "#shared/model.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { emptyStatBlock, monsterView } from "#shared/statBlock.ts";
import {
  chipFocusAfter,
  CREATURE_TYPES,
  decodeFilters,
  encodeFilters,
  filterChips,
  filterCount,
  matchesText,
  monsterFacts,
  NO_FILTERS,
  readStoredFilters,
  storeFilters,
  toggled,
  type MonsterFilters,
} from "./monsterFilters.ts";
import { monsterMatcher } from "./monsterSearch.ts";

const MONSTERS = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const byId = (id: string) => MONSTERS.find((m) => m.srdId === id)!;
const filtered = (filters: Partial<MonsterFilters>, query = "") => MONSTERS.filter(monsterMatcher(query, { ...NO_FILTERS, ...filters })).map((m) => m.srdId);
/** A stat block line as printed, read straight from the Markdown, for checks independent of the code under test. */
const printed = (m: SrdMonster, label: string) => new RegExp(`^\\*\\*${label}\\*\\* (.*)$`, "m").exec(m.statBlock)?.[1] ?? "";
const NUMBER = (cr: string) => (cr.includes("/") ? Number(cr.split("/")[0]) / Number(cr.split("/")[1]) : Number(cr));

function custom(block: Partial<StatBlock>): StatBlockMonster {
  return monsterView({ ...emptyStatBlock(), name: "Homebrew", ...block });
}

describe("monster facts", () => {
  test("are read once per monster object", () => {
    const dragon = byId("adult-red-dragon");
    assert.equal(monsterFacts(dragon), monsterFacts(dragon));
  });

  test("an SRD stat block reads into every field the filters use", () => {
    const f = monsterFacts(byId("adult-red-dragon"));
    assert.equal(f.cr, 17);
    assert.equal(f.type, "dragon");
    assert.deepEqual(f.sizes, ["huge"]);
    assert.equal(f.alignment, "chaotic evil");
    assert.equal(f.legendary, true);
    assert.equal(f.lair, true);
    assert.deepEqual([...f.movement], ["fly", "climb"]);
    assert.deepEqual([...f.senses], ["blindsight", "darkvision"]);
    assert.deepEqual([...f.damageImmunities], ["fire"]);
    assert.deepEqual([...f.conditionImmunities], []);
  });

  test("the Immunities line splits into damage types and conditions", () => {
    const f = monsterFacts(byId("lich"));
    assert.deepEqual([...f.damageImmunities].sort(), ["necrotic", "poison"]);
    assert.ok(f.conditionImmunities.has("poisoned"));
    assert.ok(f.conditionImmunities.has("charmed"));
  });

  test("a qualified immunity counts by its first word", () => {
    assert.ok(monsterFacts(byId("vampire-familiar")).conditionImmunities.has("charmed"));
    assert.ok(monsterFacts(byId("rakshasa")).vulnerabilities.has("piercing"));
    // "Damage type chosen for the Draconic Origin trait below" names no damage type.
    assert.equal(monsterFacts(byId("half-dragon")).resistances.size, 0);
  });

  test("a Medium or Small block has both sizes, and the search words include both", () => {
    const f = monsterFacts(byId("bandit"));
    assert.deepEqual(f.sizes, ["medium", "small"]);
    assert.ok(filtered({}, "small bandit").includes("bandit"));
  });

  test("tags and swarms read as their creature type", () => {
    assert.equal(monsterFacts(byId("goblin-warrior")).type, "fey");
    assert.equal(monsterFacts(byId("swarm-of-bats")).type, "beast");
    assert.equal(monsterFacts(byId("swarm-of-crawling-claws")).type, "undead");
    for (const m of MONSTERS) assert.ok(monsterFacts(m).type !== null, `${m.srdId} has a creature type`);
    for (const m of MONSTERS) assert.ok(monsterFacts(m).alignment !== null, `${m.srdId} has an alignment`);
  });
});

describe("each filter", () => {
  test("no filters match everything", () => {
    assert.equal(filtered({}).length, MONSTERS.length);
  });

  test("a CR range includes both ends, and either end alone is open", () => {
    const mid = filtered({ crMin: "1/2", crMax: "3" });
    assert.equal(mid.length, MONSTERS.filter((m) => NUMBER(m.cr) >= 0.5 && NUMBER(m.cr) <= 3).length);
    assert.ok(mid.some((id) => byId(id).cr === "1/2") && mid.some((id) => byId(id).cr === "3"));
    assert.deepEqual(filtered({ crMin: "3", crMax: "1/2" }), mid);
    assert.ok(filtered({ crMin: "21" }).every((id) => NUMBER(byId(id).cr) >= 21));
    assert.ok(filtered({ crMin: "21" }).includes("tarrasque"));
    assert.deepEqual(new Set(filtered({ crMax: "0" }).map((id) => byId(id).cr)), new Set(["0"]));
  });

  test("creature types match any one picked", () => {
    const undead = filtered({ types: ["undead"] });
    assert.equal(undead.length, MONSTERS.filter((m) => /undead/i.test(m.type)).length);
    const either = filtered({ types: ["undead", "fiend"] });
    assert.equal(either.length, undead.length + filtered({ types: ["fiend"] }).length);
    // Every SRD monster has exactly one of the 14 types.
    assert.equal(CREATURE_TYPES.reduce((n, type) => n + filtered({ types: [type] }).length, 0), MONSTERS.length);
  });

  test("sizes match any size the block prints", () => {
    const small = filtered({ sizes: ["small"] });
    assert.ok(small.includes("bandit"), "a Medium or Small block is Small too");
    assert.ok(small.every((id) => byId(id).size === "small" || byId(id).statBlock.includes("or Small")));
    assert.ok(filtered({ sizes: ["gargantuan"] }).includes("tarrasque"));
  });

  test("alignments match any one picked", () => {
    const evil = filtered({ alignments: ["lawful evil", "neutral evil", "chaotic evil"] });
    assert.ok(evil.length > 0);
    assert.ok(evil.every((id) => byId(id).alignment.endsWith("Evil")));
    assert.equal(filtered({ alignments: ["unaligned"] }).length, MONSTERS.filter((m) => m.alignment === "Unaligned").length);
  });

  test("legendary means legendary actions, and lair means lair values", () => {
    assert.equal(filtered({ legendary: true }).length, MONSTERS.filter((m) => m.legendaryActions).length);
    const lair = filtered({ lair: true });
    assert.equal(lair.length, MONSTERS.filter((m) => m.xpInLair !== undefined || m.legendaryActions?.usesInLair !== undefined).length);
    assert.ok(!lair.includes("tarrasque"), "the Tarrasque is legendary without a lair");
    assert.ok(filtered({ legendary: true }).includes("tarrasque"));
  });

  test("condition immunities need every condition picked", () => {
    const charmed = filtered({ conditionImmunities: ["charmed"] });
    const both = filtered({ conditionImmunities: ["charmed", "frightened"] });
    assert.ok(both.length > 0 && both.length < charmed.length);
    for (const id of both) assert.match(printed(byId(id), "Immunities"), /Charmed.*Frightened/);
    assert.deepEqual(filtered({ conditionImmunities: ["invisible"] }), []);
  });

  test("damage immunities, resistances and vulnerabilities read their own lines", () => {
    const fire = filtered({ damageImmunities: ["fire"] });
    assert.ok(fire.includes("adult-red-dragon"));
    assert.ok(fire.every((id) => /^([^;]*\b)?Fire\b/.test(printed(byId(id), "Immunities"))));
    assert.ok(!fire.includes("ice-mephit"), "vulnerable to fire, not immune");
    assert.deepEqual(filtered({ vulnerabilities: ["fire"] }).sort(), ["awakened-shrub", "awakened-tree", "dust-mephit", "ice-mephit", "mummy", "mummy-lord", "treant"]);
    const physical = filtered({ resistances: ["bludgeoning", "piercing", "slashing"] });
    assert.ok(physical.length > 0);
    for (const id of physical) assert.match(printed(byId(id), "Resistances"), /Bludgeoning.*Piercing.*Slashing/);
    // Poison as a damage type and Poisoned as a condition never cross.
    assert.ok(filtered({ damageImmunities: ["poison"] }).every((id) => monsterFacts(byId(id)).damageImmunities.has("poison")));
  });

  test("movement and senses need every one picked", () => {
    assert.deepEqual(filtered({ movement: ["hover", "swim"] }), ["storm-giant"]);
    const fliers = filtered({ movement: ["fly"] });
    assert.equal(fliers.length, MONSTERS.filter((m) => (m.speeds.fly ?? 0) > 0).length);
    assert.deepEqual(filtered({ senses: ["tremorsense"] }).sort(), ["ankheg", "bulette", "earth-elemental", "purple-worm", "remorhaz", "xorn"]);
    assert.ok(filtered({ movement: ["burrow"], senses: ["tremorsense"] }).includes("purple-worm"));
  });
});

describe("combinations", () => {
  test("filters narrow each other", () => {
    assert.deepEqual(filtered({ types: ["undead"], legendary: true }).sort(), ["lich", "mummy-lord", "vampire"]);
    assert.deepEqual(filtered({ types: ["undead"], legendary: true, vulnerabilities: ["fire"] }), ["mummy-lord"]);
    assert.deepEqual(filtered({ types: ["fiend"], crMin: "4", crMax: "5", movement: ["fly"] }).sort(), ["incubus", "succubus"]);
  });

  test("the search box and the filters combine", () => {
    assert.deepEqual(filtered({ types: ["dragon"] }, "cr 17 red"), ["adult-red-dragon"]);
    assert.deepEqual(filtered({ types: ["fiend"] }, "cr 17 red"), []);
    const devils = filtered({ crMin: "1", crMax: "5" }, "devil");
    assert.ok(devils.length > 0);
    assert.ok(devils.every((id) => /devil/i.test(byId(id).type) || /devil/i.test(byId(id).name)));
    // A typed range and the filters' range both apply.
    assert.ok(filtered({ crMin: "3" }, "cr 1-5").every((id) => NUMBER(byId(id).cr) >= 3 && NUMBER(byId(id).cr) <= 5));
  });
});

describe("a room's own monsters", () => {
  const brute = custom({
    name: "Bog Brute",
    size: "large",
    type: "Monstrosity",
    alignment: "Neutral Evil",
    speed: "30 ft., Swim 40 ft.",
    senses: "Darkvision 60 ft.",
    cr: "4",
    xp: 1100,
    immunities: "Poison; Poisoned, Frightened",
    resistances: "Cold",
  });
  const tyrant = custom({
    name: "Marsh Tyrant",
    size: "medium",
    sizeAlt: "small",
    type: "Humanoid (Sorcerer)",
    alignment: "Typically Lawful Evil",
    cr: "12",
    xp: 8400,
    xpInLair: 10000,
    legendaryActions: [{ name: "Legendary Action Uses: 3 (4 in Lair)", text: "Immediately after another creature's turn, the tyrant can expend a use." }],
  });
  const plain = custom({ name: "Odd Thing", type: "", alignment: "", cr: "1" });
  const strange = custom({ name: "Gutter Horror", type: "Abomination", alignment: "Any alignment", cr: "2" });
  const list = [brute, tyrant, plain, strange];
  const names = (filters: Partial<MonsterFilters>, query = "") => list.filter(monsterMatcher(query, { ...NO_FILTERS, ...filters })).map((m) => m.name);

  test("filter by the same fields as the SRD's", () => {
    assert.deepEqual(names({ types: ["monstrosity"] }), ["Bog Brute"]);
    assert.deepEqual(names({ types: ["humanoid"] }), ["Marsh Tyrant"]);
    assert.deepEqual(names({ sizes: ["small"] }), ["Marsh Tyrant"]);
    assert.deepEqual(names({ alignments: ["lawful evil"] }), ["Marsh Tyrant"]);
    assert.deepEqual(names({ legendary: true }), ["Marsh Tyrant"]);
    assert.deepEqual(names({ lair: true }), ["Marsh Tyrant"]);
    assert.deepEqual(names({ conditionImmunities: ["frightened", "poisoned"] }), ["Bog Brute"]);
    assert.deepEqual(names({ damageImmunities: ["poison"] }), ["Bog Brute"]);
    assert.deepEqual(names({ resistances: ["cold"] }), ["Bog Brute"]);
    assert.deepEqual(names({ movement: ["swim"] }), ["Bog Brute"]);
    assert.deepEqual(names({ senses: ["darkvision"] }), ["Bog Brute"]);
    assert.deepEqual(names({ crMin: "10" }), ["Marsh Tyrant"]);
    assert.deepEqual(names({}, "cr 1-2"), ["Odd Thing", "Gutter Horror"]);
  });

  test("a field they lack matches no filter on it, and no filter leaves them in", () => {
    assert.deepEqual(names({}), ["Bog Brute", "Marsh Tyrant", "Odd Thing", "Gutter Horror"]);
    for (const type of CREATURE_TYPES) assert.ok(!names({ types: [type] }).includes("Odd Thing") && !names({ types: [type] }).includes("Gutter Horror"));
    assert.deepEqual(names({ alignments: ["neutral", "unaligned", "chaotic evil", "neutral evil"] }), ["Bog Brute"]);
    assert.deepEqual(names({ vulnerabilities: ["fire"] }), []);
  });

  test("Has a lair takes a block with lair actions alone, as a heading's text or a named entry, and not one that only mentions them (FU32-LAIR-SURFACES)", () => {
    const keeper = custom({ name: "Crypt Keeper", legendaryActions: [{ name: "", text: "Lair Actions" }, { name: "Grasping Dead", text: "Hands burst from the floor." }] });
    const warden = custom({ name: "Bog Warden", traits: [{ name: "Lair Actions", text: "On initiative count 20, the bog rises." }] });
    const lurker = custom({ name: "Cave Lurker", traits: [{ name: "Homebody", text: "It never leaves its lair, and it takes no lair actions." }] });
    const lairs = [tyrant, keeper, warden, lurker, brute].filter(monsterMatcher("", { ...NO_FILTERS, lair: true })).map((m) => m.name);
    assert.deepEqual(lairs, ["Marsh Tyrant", "Crypt Keeper", "Bog Warden"]);
  });
});

describe("chips, counts and storage", () => {
  const some: MonsterFilters = {
    ...NO_FILTERS,
    crMin: "5",
    crMax: "1",
    types: ["undead"],
    legendary: true,
    movement: ["fly"],
    conditionImmunities: ["charmed"],
    damageImmunities: ["fire"],
    resistances: ["cold"],
    vulnerabilities: ["radiant"],
  };

  test("each filter that is on is one chip in the sheet's order, which removes only itself", () => {
    const chips = filterChips(some);
    assert.deepEqual(
      chips.map((c) => c.label),
      ["CR 1–5", "Undead", "Legendary", "Immune: Charmed", "Immune: Fire", "Resists: Cold", "Vulnerable: Radiant", "Can fly"],
    );
    assert.equal(filterCount(some), chips.length);
    const undead = chips.find((c) => c.label === "Undead")!;
    assert.deepEqual(undead.without, { ...some, types: [] });
    assert.deepEqual(chips[0]!.without, { ...some, crMin: null, crMax: null });
    assert.equal(filterChips(NO_FILTERS).length, 0);
    assert.equal(filterCount(NO_FILTERS), 0);
  });

  test("after a chip is removed, focus goes to the next chip, else the one before, else the Filters button", () => {
    assert.equal(chipFocusAfter(0, 3), 0);
    assert.equal(chipFocusAfter(1, 3), 1);
    assert.equal(chipFocusAfter(3, 3), 2);
    assert.equal(chipFocusAfter(0, 0), null);
  });

  test("the sheet counts every match, and says when the list is still loading", () => {
    assert.equal(matchesText(null), "Loading…");
    assert.equal(matchesText(0), "No matches");
    assert.equal(matchesText(1), "1 match");
    assert.equal(matchesText(120), "120 matches");
  });

  test("an open CR end reads as higher or lower", () => {
    assert.equal(filterChips({ ...NO_FILTERS, crMin: "10" })[0]!.label, "CR 10 or higher");
    assert.equal(filterChips({ ...NO_FILTERS, crMax: "1/2" })[0]!.label, "CR 1/2 or lower");
    assert.equal(filterChips({ ...NO_FILTERS, crMin: "3", crMax: "3" })[0]!.label, "CR 3");
  });

  test("toggling keeps the options' order", () => {
    assert.deepEqual(toggled(CREATURE_TYPES, ["undead"], "beast"), ["beast", "undead"]);
    assert.deepEqual(toggled(CREATURE_TYPES, ["beast", "undead"], "beast"), ["undead"]);
  });

  /** localStorage's three calls over a Map, counting what was written. */
  function fakeStorage() {
    const items = new Map<string, string>();
    const storage = {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    return storage;
  }
  const blocked = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  const refusing = () => ({
    getItem: (): string | null => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  });

  test("each room keeps its own stored filters", () => {
    const storage = fakeStorage();
    assert.equal(storeFilters(() => storage, "room-a", some), true);
    assert.equal(storeFilters(() => storage, "room-b", { ...NO_FILTERS, legendary: true }), true);
    assert.deepEqual([...storage.items.keys()].sort(), ["rvtt.monsterFilters.room-a", "rvtt.monsterFilters.room-b"]);
    assert.deepEqual(readStoredFilters(() => storage, "room-a"), some);
    assert.deepEqual(readStoredFilters(() => storage, "room-b"), { ...NO_FILTERS, legendary: true });
    assert.deepEqual(readStoredFilters(() => storage, "room-c"), NO_FILTERS);
  });

  test("clearing every filter removes the room's entry", () => {
    const storage = fakeStorage();
    storeFilters(() => storage, "room-a", some);
    storeFilters(() => storage, "room-b", some);
    assert.equal(storeFilters(() => storage, "room-a", NO_FILTERS), true);
    assert.deepEqual([...storage.items.keys()], ["rvtt.monsterFilters.room-b"]);
    assert.deepEqual(readStoredFilters(() => storage, "room-a"), NO_FILTERS);
  });

  test("blocked storage reads as no filters and refuses quietly", () => {
    assert.deepEqual(readStoredFilters(blocked, "room-a"), NO_FILTERS);
    assert.equal(storeFilters(blocked, "room-a", some), false);
    assert.deepEqual(readStoredFilters(refusing, "room-a"), NO_FILTERS);
    assert.equal(storeFilters(refusing, "room-a", some), false);
    assert.equal(storeFilters(refusing, "room-a", NO_FILTERS), false);
  });

  test("stored filters round trip, and anything unknown or damaged is dropped", () => {
    assert.deepEqual(decodeFilters(encodeFilters(some)), some);
    assert.deepEqual(decodeFilters(null), NO_FILTERS);
    assert.deepEqual(decodeFilters("not json"), NO_FILTERS);
    assert.deepEqual(decodeFilters("[1, 2]"), { ...NO_FILTERS });
    assert.deepEqual(decodeFilters(JSON.stringify({ crMin: "31", types: ["undead", "kaiju"], legendary: "yes", senses: "darkvision" })), { ...NO_FILTERS, types: ["undead"] });
  });
});
