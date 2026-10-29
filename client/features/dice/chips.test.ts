import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceRoll, LogEntry } from "#shared/model.ts";
import { hpChips } from "./options.ts";

/** The rolled amounts an HP entry offers (docs/design-v1-roll-options.md 4.3). */

let seq = 0;
function line(by: string, rolls: DiceRoll[]): LogEntry {
  return { id: `${++seq}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "dice", by, to: "all", rolls } };
}

const roll = (label: string | undefined, total: number): DiceRoll => ({ formula: "2d6", faces: [1, 1], total, ...(label !== undefined ? { label } : {}) });

const NAMES: Record<string, string> = { p1: "Bree", p2: "Grim" };
const opts = (applied: string[] = []) => ({ applied: new Set(applied), nameOf: (id: string) => NAMES[id] ?? "someone" });

describe("HP chips", () => {
  test("the newest line of this viewer and the newest of anyone else, the viewer's own first", () => {
    const log = [
      line("me", [roll("Longsword damage, slashing", 5)]),
      line("p1", [roll("Longsword damage, slashing", 9)]),
      line("me", [roll("Rapier damage and Sneak Attack, piercing", 19)]),
      line("p2", [roll("Scimitar damage, slashing", 4)]),
    ];
    const chips = hpChips(log, "me", "damage", opts());
    assert.deepEqual(
      chips.map((c) => c.text),
      ["Use 19 (Rapier damage and Sneak Attack)", "Use 4 (Grim's Scimitar damage)"],
    );
    assert.deepEqual(
      chips.map((c) => c.lineId),
      [log[2]!.id, log[3]!.id],
    );
    assert.equal(chips[1]!.amount, 4);
    // A label sent since the SRD's capitals names its type "Slashing", and its chip reads the same.
    assert.deepEqual(hpChips([line("p1", [roll("Longsword damage, Slashing", 9)])], "me", "damage", opts()).map((c) => c.text), ["Use 9 (Bree's Longsword damage)"]);
  });

  test("a plain roll is never a chip, nor a line without rolls or a chat line", () => {
    const damage = line("me", [roll("Longsword damage, slashing", 7)]);
    const log = [
      damage,
      line("me", [roll("Longsword", 17)]),
      line("me", [roll(undefined, 11)]),
      line("me", []),
      { id: `${++seq}:0`, at: "", kind: "chat", from: "me", text: "9 damage" } as LogEntry,
    ];
    const chips = hpChips(log, "me", "damage", opts());
    assert.deepEqual(
      chips.map((c) => c.lineId),
      [damage.id],
    );
    assert.deepEqual(hpChips([line("p1", [roll("Perception check", 14)])], "me", "damage", opts()), []);
  });

  test("healing lines under Heal only, and damage lines under Damage only", () => {
    const heal = line("p1", [roll("Cure Wounds healing", 8)]);
    const hit = line("p1", [roll("Longsword damage, slashing", 9)]);
    const log = [heal, hit];
    assert.deepEqual(
      hpChips(log, "me", "heal", opts()).map((c) => c.text),
      ["Use 8 (Bree's Cure Wounds healing)"],
    );
    assert.deepEqual(
      hpChips(log, "me", "damage", opts()).map((c) => c.lineId),
      [hit.id],
    );
  });

  test("a line this device applied is left out", () => {
    const mine = line("me", [roll("Longsword damage, slashing", 9)]);
    const theirs = line("p1", [roll("Scimitar damage, slashing", 4)]);
    const chips = hpChips([mine, theirs], "me", "damage", opts([mine.id]));
    assert.deepEqual(
      chips.map((c) => c.lineId),
      [theirs.id],
    );
  });

  test("a chip sums every roll of its line, one per damage type, named without the type", () => {
    const log = [line("me", [roll("Flame Tongue damage, slashing", 6), roll("Flame Tongue damage, fire", 8)])];
    const [chip] = hpChips(log, "me", "damage", opts());
    assert.equal(chip?.amount, 14);
    assert.equal(chip?.text, "Use 14 (Flame Tongue damage)");
  });

  test("a critical damage line is marked critical, and another is not", () => {
    const log = [line("me", [roll("Rend critical damage, fire", 22)]), line("p1", [roll("Rend damage, fire", 11)])];
    const chips = hpChips(log, "me", "damage", opts());
    assert.deepEqual(
      chips.map((c) => [c.text, c.critical]),
      [
        ["Use 22 (Rend critical damage)", true],
        ["Use 11 (Bree's Rend damage)", false],
      ],
    );
  });

  test("a damage the server rolled as a critical hit is critical by its rule, whatever its label says", () => {
    const crit: DiceRoll = { ...roll("Shared damage for 2 hits, fire", 30), crit: "maxPlusRoll" };
    const chips = hpChips([line("me", [roll("Shared damage for 2 hits, fire", 7), crit])], "me", "damage", opts());
    assert.deepEqual(chips.map((c) => [c.amount, c.critical]), [[37, true]]);
  });

  test("a roll sent as several lines, such as 21 hits' damage, is one chip of its whole total, and applying it takes every line (ASTRA-12)", () => {
    const batched = (id: string, rolls: DiceRoll[]): LogEntry => ({ id, at: "", kind: "event", data: { type: "dice", by: "me", to: "all", batch: "b1", rolls } });
    const hit = roll("Scimitar damage for 21 hits, slashing", 4);
    const log = [line("me", [roll("Longsword damage, slashing", 6)]), batched("9:0", Array.from({ length: 20 }, () => hit)), batched("10:0", [hit])];
    const [chip] = hpChips(log, "me", "damage", opts());
    assert.equal(chip!.amount, 84);
    assert.equal(chip!.text, "Use 84 (Scimitar damage for 21 hits)");
    assert.deepEqual([...chip!.lineIds].sort(), ["10:0", "9:0"]);
    assert.deepEqual(hpChips(log, "me", "damage", opts(["9:0"])), [], "an applied batch goes whole, and no older roll takes its place");
  });
});

describe("FL-3 rolled damage parts", () => {
  const typed = (total: number, type?: DiceRoll["type"]): DiceRoll => ({ ...roll("Shared damage", total), ...(type ? { type } : {}) });

  test("a batched chip retains each rolled amount and its actual type, including untyped parts", () => {
    const batched = (id: string, rolls: DiceRoll[]): LogEntry => ({ id, at: "", kind: "event", data: { type: "dice", by: "me", to: "all", batch: "b2", rolls } });
    const log = [batched("20:0", [typed(3, "fire"), typed(3, "fire")]), batched("21:0", [typed(5), typed(4, "cold")])];
    const chip = hpChips(log, "me", "damage", opts())[0]!;
    assert.equal(chip.amount, 15);
    assert.deepEqual(chip.parts, [{ amount: 3, type: "fire" }, { amount: 3, type: "fire" }, { amount: 5 }, { amount: 4, type: "cold" }]);
    assert.deepEqual(chip.lineIds, ["20:0", "21:0"]);
    assert.equal("types" in chip, false, "the server determines the types actually dealt");
  });

  test("nonpositive damage contributes zero without inferring types or changing healing", () => {
    const chip = hpChips([line("me", [typed(0, "fire"), typed(-2, "cold"), typed(8, "radiant")])], "me", "damage", opts())[0]!;
    assert.equal(chip.amount, 8);
    assert.deepEqual(chip.parts, [{ amount: 0, type: "fire" }, { amount: 0, type: "cold" }, { amount: 8, type: "radiant" }]);
    assert.equal(hpChips([line("me", [roll("Longsword damage, slashing", 9)])], "me", "damage", opts())[0]!.parts, undefined, "a label never supplies a missing type");
    assert.equal(hpChips([line("me", [roll("Damage", 9), roll("Damage", -2)])], "me", "damage", opts())[0]!.amount, 9, "untyped negative parts also count as zero");
    const heal = hpChips([line("me", [{ ...typed(8, "radiant"), label: "Cure Wounds healing" }])], "me", "heal", opts())[0]!;
    assert.equal(heal.parts, undefined);
    assert.equal(heal.amount, 8);
  });
});

test("FL-4: chip breakdowns keep typed and untyped rolled parts, and healing has none", () => {
  const chip = hpChips([line("me", [{ ...roll("Spell damage", 11), type: "cold" }, roll("Spell damage", 3)])], "me", "damage", opts())[0]!;
  assert.deepEqual(chip.breakdown?.parts, [
    { icon: "cold", gutter: "", amount: 11, label: "Cold damage" },
    { icon: "untyped", gutter: "+", amount: 3, label: "damage" },
  ]);
  assert.equal(chip.breakdown?.total, 14);
  assert.equal(hpChips([line("me", [roll("Cure Wounds healing", 9)])], "me", "heal", opts())[0]?.breakdown, undefined);
});

test("FL-4 review: only a typed or multipart chip gets a slip", () => {
  const one = roll("Longsword damage", 7);
  assert.equal(hpChips([line("me", [one])], "me", "damage", opts())[0]?.breakdown, undefined);
  assert.ok(hpChips([line("me", [{ ...one, type: "slashing" }])], "me", "damage", opts())[0]?.breakdown);
  assert.equal(hpChips([line("me", [one, one])], "me", "damage", opts())[0]?.breakdown?.total, 14);
});

test("FL-4 review: negative chip parts cannot subtract from damage, typed or untyped", () => {
  for (const type of [undefined, "cold"] as const) {
    const chip = hpChips([line("me", [{ ...roll("Spell damage", -5), ...(type ? { type } : {}) }, roll("Spell damage", 6)])], "me", "damage", opts())[0]!;
    assert.equal(chip.amount, 6);
    assert.deepEqual(chip.breakdown?.parts.map(p => p.amount), [0, 6]);
  }
});
