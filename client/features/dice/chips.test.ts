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

/** The types a damage chip carries to the HP entry (docs/design-v1-combat-controls.md 3.4). */
describe("HP chips' damage types", () => {
  const typed = (label: string, total: number, type: DiceRoll["type"]): DiceRoll => ({ ...roll(label, total), ...(type ? { type } : {}) });

  test("each type the chip's rolls dealt above 0, once, in the rules' order, from the line's own types and never its labels", () => {
    const log = [
      line("me", [typed("Flame Strike damage, radiant", 9, "radiant"), typed("Flame Strike damage, fire", 0, "fire"), typed("Flame Strike damage, cold", 4, "cold"), typed("Flame Strike damage, radiant", 3, "radiant")]),
    ];
    assert.deepEqual(hpChips(log, "me", "damage", opts())[0]!.types, ["cold", "radiant"], "fire came to 0, so it adds nothing");
    const cut = line("me", [typed("Vorpal Longsword of the Seventh Sundered Kingdom damage and…", 7, "slashing")]);
    assert.deepEqual(hpChips([cut], "me", "damage", opts())[0]!.types, ["slashing"]);
  });

  test("an untyped line, a line rolled before types, and a healing chip carry none", () => {
    const old = line("me", [roll("Longsword damage, slashing", 9)]);
    assert.equal("types" in hpChips([old], "me", "damage", opts())[0]!, false, "no type on the line: the label is no contract");
    const zero = line("me", [typed("Longsword damage, slashing", 0, "slashing")]);
    assert.equal(hpChips([zero], "me", "damage", opts())[0]!.types, undefined);
    const heal = line("p1", [typed("Cure Wounds healing", 8, "radiant")]);
    assert.equal(hpChips([heal], "me", "heal", opts())[0]!.types, undefined);
  });

  test("a roll sent as several lines takes the types of every line", () => {
    const batched = (id: string, rolls: DiceRoll[]): LogEntry => ({ id, at: "", kind: "event", data: { type: "dice", by: "me", to: "all", batch: "b2", rolls } });
    const log = [batched("20:0", [typed("Shared damage for 2 hits, slashing", 6, "slashing")]), batched("21:0", [typed("Shared damage for 2 hits, poison", 5, "poison")])];
    assert.deepEqual(hpChips(log, "me", "damage", opts())[0]!.types, ["poison", "slashing"]);
  });
});
