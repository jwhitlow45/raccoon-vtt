import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { modeAfterApply, parseHpInput, withCrit, type HpMode } from "./hpInput.ts";

function change(text: string, mode: HpMode = "damage") {
  const r = parseHpInput(text, mode);
  assert.ok(r.ok, `expected "${text}" to parse, got ${r.ok ? "" : r.error}`);
  return r.change;
}

function error(text: string, mode: HpMode = "damage"): string {
  const r = parseHpInput(text, mode);
  assert.ok(!r.ok, `expected "${text}" to be refused`);
  return r.error;
}

describe("HP math input", () => {
  test("the three operators from the feature list", () => {
    assert.deepEqual(change("-7"), { kind: "damage", amount: 7 });
    assert.deepEqual(change("+5"), { kind: "heal", amount: 5 });
    assert.deepEqual(change("=20"), { kind: "set", cur: 20 });
  });

  test("a bare number uses the picked mode, so a phone's number pad is enough", () => {
    assert.deepEqual(change("7", "damage"), { kind: "damage", amount: 7 });
    assert.deepEqual(change("7", "heal"), { kind: "heal", amount: 7 });
    assert.deepEqual(change("7", "set"), { kind: "set", cur: 7 });
    assert.deepEqual(change("7", "temp"), { kind: "temp", amount: 7 });
    assert.deepEqual(change("0", "set"), { kind: "set", cur: 0 });
  });

  test("an operator wins over the picked mode", () => {
    assert.deepEqual(change("+5", "damage"), { kind: "heal", amount: 5 });
    assert.deepEqual(change("-5", "heal"), { kind: "damage", amount: 5 });
    assert.deepEqual(change("=5", "temp"), { kind: "set", cur: 5 });
  });

  test("temporary HP", () => {
    assert.deepEqual(change("t5"), { kind: "temp", amount: 5 });
    assert.deepEqual(change("T 8"), { kind: "temp", amount: 8 });
    assert.deepEqual(change("temp 12"), { kind: "temp", amount: 12 });
    assert.deepEqual(change("t=4"), { kind: "temp", amount: 4 });
    assert.deepEqual(change("t0"), { kind: "temp", amount: 0 });
  });

  test("terms add up, and a signed expression is a change to current HP", () => {
    assert.deepEqual(change("-7-3"), { kind: "damage", amount: 10 });
    assert.deepEqual(change("- 7 - 3"), { kind: "damage", amount: 10 });
    assert.deepEqual(change("+5+3"), { kind: "heal", amount: 8 });
    assert.deepEqual(change("-3+10"), { kind: "heal", amount: 7 });
    assert.deepEqual(change("7+3", "damage"), { kind: "damage", amount: 10 });
    assert.deepEqual(change("=20+5"), { kind: "set", cur: 25 });
  });

  test("typographic minus signs count", () => {
    assert.deepEqual(change("\u22127"), { kind: "damage", amount: 7 });
    assert.deepEqual(change("\u20134"), { kind: "damage", amount: 4 });
  });

  test("refusals say what to type", () => {
    assert.match(error(""), /Type a number/);
    assert.match(error("abc"), /-7, \+5, =20 or t5/);
    assert.match(error("7.5"), /-7/);
    assert.match(error("-3+3"), /no change/);
    assert.match(error("0", "damage"), /no change/);
    assert.match(error("=-4"), /negative/);
    assert.match(error("3-10", "damage"), /positive/);
    assert.match(error("t-3"), /negative/);
    assert.match(error("t"), /-7/);
    assert.match(error("-100001"), /too large/);
    assert.match(error("=999999999999999999999"), /too large/);
  });

  test("every accepted change is a valid op", () => {
    for (const text of ["-7", "+5", "=20", "t5", "100000", "-100000"]) {
      const op = { t: "actor.hp", target: { tokenId: "t1" }, change: change(text, "set") };
      assert.ok(clientOpSchema.safeParse(op).success, text);
    }
  });

  test("a critical hit marks damage only", () => {
    assert.deepEqual(withCrit({ kind: "damage", amount: 3 }, true), { kind: "damage", amount: 3, crit: true });
    assert.deepEqual(withCrit({ kind: "damage", amount: 3 }, false), { kind: "damage", amount: 3 });
    assert.deepEqual(withCrit({ kind: "heal", amount: 3 }, true), { kind: "heal", amount: 3 });
  });
});

describe("the mode after an apply", () => {
  test("temporary HP and set go back to damage, damage and heal stay for the next hit", () => {
    assert.equal(modeAfterApply("temp"), "damage");
    assert.equal(modeAfterApply("set"), "damage");
    assert.equal(modeAfterApply("damage"), "damage");
    assert.equal(modeAfterApply("heal"), "heal");
  });
});

describe("FL-3 typed HP damage", () => {
  test("FU38-B: typed damage arithmetic asks for totals, never for dice", () => {
    for (const text of ["5 + 3 fire", "-5+3 fire", "10 fire + 5-3 cold", "1001+3 fire"]) {
      assert.equal(error(text), "Enter a total for each damage type, such as 8 Fire + 4 Cold.");
    }
    assert.match(error("10 lava"), /not a damage type/);
    assert.match(error("100001 fire"), /1 to 100,000/);
  });

  test("an unchanged rolled amount keeps its parts for both the preview and Apply", () => {
    const chip = { amount: 15, parts: [{ amount: 3 }, { amount: 2 }, { amount: 10, type: "fire" as const }] };
    const parsed = parseHpInput("15", "damage", chip);
    assert.deepEqual(parsed, { ok: true, change: { kind: "damage", amount: 15, parts: chip.parts }, summary: "3 + 2 + 10 Fire damage" });
    assert.deepEqual(parseHpInput(" 15 ", "damage", chip), parsed);
    assert.deepEqual(parseHpInput("16", "damage", chip), parseHpInput("16", "damage"));
    assert.deepEqual(parseHpInput("-15", "damage", chip), parseHpInput("-15", "damage"));
    assert.deepEqual(parseHpInput("15", "heal", chip), parseHpInput("15", "heal"));
    assert.deepEqual(parseHpInput("15", "damage", null), parseHpInput("15", "damage"));
  });

  test("a rolled chip beyond the typed part limit is refused before dispatch", () => {
    const chip = { amount: 101, parts: Array.from({ length: 101 }, () => ({ amount: 1, type: "fire" as const })) };
    const parsed = parseHpInput("101", "damage", chip);
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /100 damage parts/);
  });

  test("keeps typed amounts for the server and accepts the save flow's case-insensitive syntax", () => {
    const parts = [{ amount: 10, type: "fire" }, { amount: 4, type: "cold" }];
    for (const text of ["10 fire + 4 cold", "10 FIRE + 4 Cold", "-10 fire + 4 cold"]) {
      const parsed = change(text);
      assert.deepEqual(parsed, { kind: "damage", amount: 14, parts });
      assert.ok(clientOpSchema.safeParse({ t: "actor.hp", target: { tokenId: "t1" }, change: parsed }).success);
    }
    assert.deepEqual(change("-10 fire", "heal"), { kind: "damage", amount: 10, parts: [{ amount: 10, type: "fire" }] });
  });

  test("rejects dice, unknown types, typed healing and totals beyond the HP limit", () => {
    for (const text of ["2d6 fire", "10 lava", "10 fire 4 cold", "100000 fire + 1 cold", "+10 fire", "=10 fire", "t10 fire"]) {
      assert.equal(parseHpInput(text, "damage").ok, false, text);
    }
    for (const mode of ["heal", "set", "temp"] as const) assert.equal(parseHpInput("10 fire", mode).ok, false);
  });
});
