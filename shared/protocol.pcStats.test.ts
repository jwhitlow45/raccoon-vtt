import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcDice, PcRoll, PcStats } from "./model.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import { clientOpSchema, MAX_PC_DICE_PARTS, MAX_PC_ROLLS } from "./protocol.ts";
import { EMPTY_PC_STATS } from "./rules/pcStats.ts";
import { actor } from "./testutil.ts";

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
