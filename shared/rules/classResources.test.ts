import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "../limits.ts";
import type { ClassResource } from "../model.ts";
import { clientOpSchema } from "../protocol.ts";
import {
  asInputs,
  CLASS_IDS,
  classPresets,
  fromPreset,
  levelUps,
  presetById,
  presetCount,
  presetReset,
  presetsAt,
  PRESETS,
  updateClass,
  type ClassId,
  type ClassPreset,
} from "./classResources.ts";

/**
 * Appendix A of docs/design-v1-combat-controls.md, written out again by
 * hand from the SRD 5.2.1 class tables, so the data and this test are two
 * readings that must agree: each preset's class level, every level its
 * count changes at with the count from there, and its rest.
 */
const APPENDIX: { id: string; unlock: number; counts: [number, number][] | "level" | "five times" | "modifier"; reset: ClassResource["reset"] }[] = [
  { id: "barbarian-rage", unlock: 1, counts: [[1, 2], [3, 3], [6, 4], [12, 5], [17, 6]], reset: "shortOne" },
  { id: "barbarian-intimidating-presence", unlock: 14, counts: [[14, 1]], reset: "long" },
  { id: "barbarian-persistent-rage", unlock: 15, counts: [[15, 1]], reset: "long" },
  { id: "bard-bardic-inspiration", unlock: 1, counts: "modifier", reset: "long" },
  { id: "cleric-channel-divinity", unlock: 2, counts: [[2, 2], [6, 3], [18, 4]], reset: "shortOne" },
  { id: "cleric-divine-intervention", unlock: 10, counts: [[10, 1]], reset: "long" },
  { id: "druid-wild-shape", unlock: 2, counts: [[2, 2], [6, 3], [17, 4]], reset: "shortOne" },
  { id: "druid-natural-recovery", unlock: 6, counts: [[6, 1]], reset: "long" },
  { id: "druid-natural-recovery-slots", unlock: 6, counts: [[6, 1]], reset: "long" },
  { id: "fighter-second-wind", unlock: 1, counts: [[1, 2], [4, 3], [10, 4]], reset: "shortOne" },
  { id: "fighter-action-surge", unlock: 2, counts: [[2, 1], [17, 2]], reset: "short" },
  { id: "fighter-indomitable", unlock: 9, counts: [[9, 1], [13, 2], [17, 3]], reset: "long" },
  { id: "monk-focus-points", unlock: 2, counts: "level", reset: "short" },
  { id: "monk-uncanny-metabolism", unlock: 2, counts: [[2, 1]], reset: "long" },
  { id: "monk-wholeness-of-body", unlock: 6, counts: "modifier", reset: "long" },
  { id: "paladin-lay-on-hands", unlock: 1, counts: "five times", reset: "long" },
  { id: "paladin-channel-divinity", unlock: 3, counts: [[3, 2], [11, 3]], reset: "shortOne" },
  { id: "paladin-holy-nimbus", unlock: 20, counts: [[20, 1]], reset: "long" },
  { id: "ranger-tireless", unlock: 10, counts: "modifier", reset: "long" },
  { id: "ranger-natures-veil", unlock: 14, counts: "modifier", reset: "long" },
  { id: "rogue-stroke-of-luck", unlock: 20, counts: [[20, 1]], reset: "short" },
  { id: "sorcerer-innate-sorcery", unlock: 1, counts: [[1, 2]], reset: "long" },
  { id: "sorcerer-sorcery-points", unlock: 2, counts: "level", reset: "long" },
  { id: "sorcerer-sorcerous-restoration", unlock: 5, counts: [[5, 1]], reset: "long" },
  { id: "sorcerer-dragon-wings", unlock: 14, counts: [[14, 1]], reset: "long" },
  { id: "warlock-magical-cunning", unlock: 2, counts: [[2, 1]], reset: "long" },
  { id: "warlock-dark-ones-own-luck", unlock: 6, counts: "modifier", reset: "long" },
  { id: "warlock-hurl-through-hell", unlock: 14, counts: [[14, 1]], reset: "long" },
  { id: "wizard-arcane-recovery", unlock: 1, counts: [[1, 1]], reset: "long" },
];

const preset = (id: string): ClassPreset => {
  const p = presetById(id);
  assert.ok(p, id);
  return p;
};

const update = (resources: Omit<ClassResource, "used">[], characterId = "pat") => ({ t: "character.update", characterId, patch: { resources } });

describe("class resources: Appendix A (docs/design-v1-combat-controls.md 7.1)", () => {
  test("the data holds Appendix A's rows, in its order", () => {
    assert.deepEqual(
      PRESETS.map((p) => p.id),
      APPENDIX.map((row) => row.id),
    );
  });

  for (const row of APPENDIX) {
    test(`${row.id}: starts at class level ${row.unlock}, and not one below`, () => {
      const p = preset(row.id);
      assert.equal(p.unlock, row.unlock);
      assert.ok(presetsAt(p.classId, row.unlock).includes(p), "listed at its level");
      if (row.unlock > 1) {
        assert.ok(!presetsAt(p.classId, row.unlock - 1).includes(p), "not listed one level below");
        assert.equal(presetCount(p, row.unlock - 1, 3), null, "no count one level below");
        assert.equal(fromPreset(p, { id: "x", classLevel: row.unlock - 1, modifier: 3 }), null, "nothing to add one level below");
      }
      assert.equal(presetReset(p, row.unlock), row.reset);
    });

    const steps = row.counts;
    if (Array.isArray(steps)) {
      test(`${row.id}: each count change and the level before it`, () => {
        const p = preset(row.id);
        for (const [i, [level, count]] of steps.entries()) {
          assert.equal(presetCount(p, level), count, `at ${level}`);
          const before: [number, number] | undefined = steps[i - 1];
          if (before) assert.equal(presetCount(p, level - 1), before[1], `at ${level - 1}, before it changes`);
        }
        const last = steps[steps.length - 1]!;
        assert.equal(presetCount(p, 20), last[1], "the last count holds to 20");
      });
    }
  }

  test("pools count by the class level: Focus Points and Sorcery Points one a level, Lay on Hands five", () => {
    for (const [id, times] of [["monk-focus-points", 1], ["sorcerer-sorcery-points", 1], ["paladin-lay-on-hands", 5]] as const) {
      const p = preset(id);
      assert.equal(p.pool, true, id);
      for (let level = p.unlock; level <= 20; level++) assert.equal(presetCount(p, level), times * level, `${id} at ${level}`);
    }
    assert.equal(presetCount(preset("paladin-lay-on-hands"), 20), 100);
    assert.equal(PRESETS.filter((p) => p.pool).length, 3, "no other preset is a pool");
  });

  test("a count from a modifier is at least 1, and unknown without the modifier", () => {
    for (const row of APPENDIX.filter((r) => r.counts === "modifier")) {
      const p = preset(row.id);
      assert.equal(presetCount(p, row.unlock, 4), 4, row.id);
      assert.equal(presetCount(p, row.unlock, 1), 1);
      assert.equal(presetCount(p, row.unlock, 0), 1, "at least once");
      assert.equal(presetCount(p, row.unlock, -2), 1, "at least once");
      assert.equal(presetCount(p, row.unlock), null);
      assert.equal(presetCount(p, row.unlock, null), null);
    }
    assert.deepEqual(
      PRESETS.filter((p) => p.count.by === "modifier").map((p) => (p.count.by === "modifier" ? p.count.ability : "")),
      ["cha", "wis", "wis", "wis", "cha"],
      "Bardic Inspiration and Dark One’s Own Luck read Charisma, the rest Wisdom",
    );
  });

  test("Bardic Inspiration comes back on a Short Rest from Bard 5 (Font of Inspiration)", () => {
    const p = preset("bard-bardic-inspiration");
    assert.equal(presetReset(p, 4), "long");
    assert.equal(presetReset(p, 5), "short");
    assert.equal(presetReset(p, 20), "short");
    assert.equal(PRESETS.filter((x) => x.shortFrom !== undefined).length, 1, "no other preset changes its rest");
  });

  test("every class has its presets, and the subclass ones name their subclass", () => {
    const counts = Object.fromEntries(CLASS_IDS.map((c) => [c, classPresets(c).length])) as Record<ClassId, number>;
    assert.deepEqual(counts, { barbarian: 3, bard: 1, cleric: 2, druid: 3, fighter: 3, monk: 3, paladin: 3, ranger: 2, rogue: 1, sorcerer: 4, warlock: 3, wizard: 1 });
    assert.deepEqual(
      PRESETS.filter((p) => p.subclass).map((p) => `${p.name}: ${p.subclass}`),
      [
        "Intimidating Presence: Path of the Berserker",
        "Natural Recovery (free spell): Circle of the Land",
        "Natural Recovery (spell slots): Circle of the Land",
        "Wholeness of Body: Warrior of the Open Hand",
        "Holy Nimbus: Oath of Devotion",
        "Dragon Wings: Draconic Sorcery",
        "Dark One’s Own Luck: Fiend Patron",
        "Hurl Through Hell: Fiend Patron",
      ],
    );
  });

  test("Natural Recovery's free spell and its spell slots are two presets, each back on a Long Rest of its own", () => {
    const uses = PRESETS.filter((p) => p.name.startsWith("Natural Recovery"));
    assert.deepEqual(
      uses.map((p) => [p.name, p.classId, p.subclass, p.unlock, presetCount(p, 6), presetCount(p, 20), presetReset(p, 20)]),
      [
        ["Natural Recovery (free spell)", "druid", "Circle of the Land", 6, 1, 1, "long"],
        ["Natural Recovery (spell slots)", "druid", "Circle of the Land", 6, 1, 1, "long"],
      ],
    );
    const added = uses.map((p, i) => fromPreset(p, { id: `nr${i}`, classLevel: 6 }));
    assert.deepEqual(
      added.map((r) => r && [r.name, r.max, r.preset]),
      [
        ["Natural Recovery (free spell)", 1, "druid-natural-recovery"],
        ["Natural Recovery (spell slots)", 1, "druid-natural-recovery-slots"],
      ],
      "two resources, so spending one leaves the other",
    );
  });

  test("a preset at any level, with any modifier, fits character.update's schema", () => {
    const ids = new Set<string>();
    for (const p of PRESETS) {
      assert.ok(!ids.has(p.id), `${p.id} once`);
      ids.add(p.id);
      assert.ok(p.name.length <= LIMITS.resourceNameChars, p.name);
      for (let level = p.unlock; level <= 20; level++) {
        for (const modifier of [-5, 0, 10]) {
          const r = fromPreset(p, { id: `r-${level}`, classLevel: level, characterLevel: level, modifier });
          assert.ok(r, `${p.id} at ${level}`);
          const parsed = clientOpSchema.safeParse(update([r]));
          assert.ok(parsed.success, `${p.id} at ${level}: ${JSON.stringify(r)}`);
        }
      }
    }
  });
});

describe("class resources: adding and updating (7.1)", () => {
  test("a preset becomes a resource with its count, rest, class level and character level", () => {
    assert.deepEqual(fromPreset(preset("barbarian-rage"), { id: "r1", classLevel: 5, characterLevel: 5 }), {
      id: "r1",
      name: "Rage",
      max: 3,
      reset: "shortOne",
      preset: "barbarian-rage",
      level: 5,
      atLevel: 5,
    });
    assert.deepEqual(fromPreset(preset("paladin-lay-on-hands"), { id: "r2", classLevel: 4 }), {
      id: "r2",
      name: "Lay on Hands",
      max: 20,
      reset: "long",
      pool: true,
      preset: "paladin-lay-on-hands",
      level: 4,
    });
    assert.equal(fromPreset(preset("bard-bardic-inspiration"), { id: "r3", classLevel: 3 }), null, "a modifier count with no modifier");
    assert.equal(fromPreset(preset("bard-bardic-inspiration"), { id: "r3", classLevel: 5, modifier: 3 })?.reset, "short");
  });

  test("the stored list goes back without `used`, which the reducer keeps", () => {
    const stored: ClassResource[] = [{ id: "a", name: "Rage", max: 3, used: 2, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 }];
    assert.deepEqual(asInputs(stored), [{ id: "a", name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 }]);
    assert.deepEqual(asInputs(undefined), []);
  });

  const rage: ClassResource = { id: "a", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 };
  const wind: ClassResource = { id: "b", name: "Second Wind", max: 2, used: 0, reset: "shortOne", preset: "fighter-second-wind", level: 2, atLevel: 7 };
  const own: ClassResource = { id: "c", name: "Superiority Dice", max: 4, used: 0, reset: "short" };

  test("a rise past a preset's character level asks about its class, with the rise added to its class level", () => {
    assert.deepEqual(levelUps([rage, own], 5), [], "no rise");
    assert.deepEqual(levelUps([rage, own], 4), [], "a level that went down asks nothing");
    assert.deepEqual(levelUps([rage, own], 6), [{ classId: "barbarian", classLevel: 5, guess: 6 }]);
    assert.deepEqual(levelUps([rage, wind, own], 9), [
      { classId: "barbarian", classLevel: 5, guess: 9 },
      { classId: "fighter", classLevel: 2, guess: 4 },
    ]);
    assert.deepEqual(levelUps([{ ...rage, level: 18, atLevel: 18 }], 20), [{ classId: "barbarian", classLevel: 18, guess: 20 }]);
    assert.deepEqual(levelUps([{ ...rage, level: 19, atLevel: 10 }], 20), [{ classId: "barbarian", classLevel: 19, guess: 20 }], "never past 20");
    assert.deepEqual(levelUps([rage], undefined), [], "no character level");
    const { atLevel: _a, ...noLevel } = rage;
    assert.deepEqual(levelUps([noLevel], 9), [], "added with no character level");
    assert.deepEqual(levelUps([own], 20), [], "a typed resource never asks");
  });

  test("two presets of one class ask once, from the higher class level", () => {
    const persistent: ClassResource = { id: "p", name: "Persistent Rage", max: 1, used: 0, reset: "long", preset: "barbarian-persistent-rage", level: 15, atLevel: 15 };
    assert.deepEqual(levelUps([{ ...rage, level: 12, atLevel: 12 }, persistent], 16), [{ classId: "barbarian", classLevel: 15, guess: 16 }]);
  });

  test("an update reads the class's counts at the new level, and keeps counts typed by hand and other classes", () => {
    const edited: ClassResource = { ...wind, id: "e", name: "Second Wind", max: 5, edited: true, preset: "fighter-second-wind" };
    const out = updateClass([rage, wind, own, edited], { classId: "fighter", classLevel: 4, characterLevel: 9, modifiers: {} });
    assert.deepEqual(out, [
      { id: "a", name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 },
      { id: "b", name: "Second Wind", max: 3, reset: "shortOne", preset: "fighter-second-wind", level: 4, atLevel: 9 },
      { id: "c", name: "Superiority Dice", max: 4, reset: "short" },
      { id: "e", name: "Second Wind", max: 5, reset: "shortOne", edited: true, preset: "fighter-second-wind", level: 4, atLevel: 9 },
    ]);
    assert.deepEqual(levelUps(out.map((r) => ({ ...r, used: 0 })), 9), [{ classId: "barbarian", classLevel: 5, guess: 9 }], "the fighter's ask is answered");
  });

  test("an update at the same class level only stamps the character's level, for a rise in another class", () => {
    const out = updateClass([rage], { classId: "barbarian", classLevel: 5, characterLevel: 6, modifiers: {} });
    assert.deepEqual(out, [{ id: "a", name: "Rage", max: 3, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 6 }]);
  });

  test("a modifier count follows a known modifier and keeps its count without one", () => {
    const bardic: ClassResource = { id: "d", name: "Bardic Inspiration", max: 3, used: 0, reset: "long", preset: "bard-bardic-inspiration", level: 4, atLevel: 4 };
    assert.equal(updateClass([bardic], { classId: "bard", classLevel: 5, characterLevel: 5, modifiers: { cha: 4 } })[0]?.max, 4);
    assert.equal(updateClass([bardic], { classId: "bard", classLevel: 5, characterLevel: 5, modifiers: {} })[0]?.max, 3);
  });

  test("the rest follows the level where it was the preset's own, and one chosen by hand stays", () => {
    const bardic: ClassResource = { id: "d", name: "Bardic Inspiration", max: 3, used: 0, reset: "long", preset: "bard-bardic-inspiration", level: 4, atLevel: 4 };
    assert.equal(updateClass([bardic], { classId: "bard", classLevel: 5, characterLevel: 5, modifiers: {} })[0]?.reset, "short");
    assert.equal(updateClass([{ ...bardic, reset: "shortOne" }], { classId: "bard", classLevel: 5, characterLevel: 5, modifiers: {} })[0]?.reset, "shortOne");
  });

  test("an update adds the presets it is given at the end", () => {
    const persistent = fromPreset(preset("barbarian-persistent-rage"), { id: "p", classLevel: 15, characterLevel: 15 })!;
    const out = updateClass([rage, own], { classId: "barbarian", classLevel: 15, characterLevel: 15, modifiers: {}, add: [persistent] });
    assert.deepEqual(
      out.map((r) => [r.id, r.max]),
      [
        ["a", 5],
        ["c", 4],
        ["p", 1],
      ],
    );
    assert.ok(clientOpSchema.safeParse(update(out)).success);
  });
});
