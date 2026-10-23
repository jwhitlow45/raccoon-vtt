import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { batchRolls } from "./dice/batch.ts";
import { FORMULA_ERRORS } from "./dice/formula.ts";
import { resolveDiceOp } from "./dice/resolve.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import { cutDmLine } from "./logRings.ts";
import { clientOpSchema, opSchema, serverOnlyOpSchema, type OpOf } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, actor, chance, effect, int, pick, rng, room, scene, token } from "./testutil.ts";

/** The dice ops' bounds (docs/design-v1-dice.md 4.1 and 4.4) and the size of the line the largest one writes (Appendix B). */
const TAG = "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d";

function op(overrides: Record<string, unknown> = {}): unknown {
  return { t: "dice.roll", tag: TAG, to: "all", rolls: [{ formula: "2d6+3", label: "Longsword" }], ...overrides };
}

function firstIssue(value: unknown): string | null {
  const parsed = clientOpSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid");
}

describe("dice.roll's bounds", () => {
  test("a plain roll, an attack with an AC, a part and a secret roll pass", () => {
    assert.equal(firstIssue(op()), null);
    assert.equal(firstIssue(op({ to: "dm", ac: 15, part: 19, rolls: [{ formula: "1d20+4", mode: "adv", critOn: 19, creature: { tokenId: "g1" } }] })), null);
    assert.equal(firstIssue(op({ dc: 15, rolls: [{ formula: "1d20+4", cancelled: true }] })), null);
  });

  test("each bound refuses, a formula's in its own words", () => {
    assert.equal(firstIssue(op({ rolls: [] })) !== null, true);
    assert.equal(firstIssue(op({ rolls: Array.from({ length: 21 }, () => ({ formula: "1d20" })) })) !== null, true);
    assert.equal(firstIssue(op({ rolls: [{ formula: "2d6+3 fire" }] })), FORMULA_ERRORS.other);
    assert.equal(firstIssue(op({ rolls: [{ formula: "2d6", mode: "adv" }] })), FORMULA_ERRORS.mode);
    assert.equal(firstIssue(op({ rolls: [{ formula: "1d1001" }] })), FORMULA_ERRORS.sides);
    assert.equal(firstIssue(op({ rolls: [{ formula: "50d6" }, { formula: "51d6" }] })), FORMULA_ERRORS.dice, "100 dice in the whole op");
    assert.equal(firstIssue(op({ rolls: [{ formula: "1d20+49d6", mode: "adv" }, { formula: "50d6" }] })), FORMULA_ERRORS.dice, "advantage's second d20 counts");
    assert.equal(firstIssue(op({ dc: 15, ac: 15 })) !== null, true);
    assert.equal(firstIssue(op({ part: 20 })) !== null, true);
    assert.equal(firstIssue(op({ to: "p1" })) !== null, true);
    assert.equal(firstIssue(op({ rolls: [{ formula: "1d20", label: "x".repeat(61) }] })) !== null, true);
    const big = Array.from({ length: 20 }, () => ({ formula: "1d20+5", label: "x".repeat(60), creature: { tokenId: randomUUID() } }));
    assert.ok(serializedBytes(op({ rolls: big })) > LIMITS.diceOpBytes);
    assert.equal(firstIssue(op({ rolls: big })), FORMULA_ERRORS.tooMuch);
  });

  test("a roll marks itself as initiative with true alone, and a stored one parses as replay parses it (docs/design-v1-combat-flow.md 11.4)", () => {
    const marked = op({ rolls: [{ formula: "1d20+2", label: "Initiative", creature: { tokenId: "g1" }, initiative: true }] });
    assert.equal(firstIssue(marked), null);
    assert.notEqual(firstIssue(op({ rolls: [{ formula: "1d20+2", initiative: false }] })), null);
    const sys = { t: "sys.dice", asked: marked, batch: "AbCdEfGhIjKlMnOp", results: [{ formula: "1d20+2", faces: [12], total: 14 }] };
    assert.ok(opSchema.safeParse(sys).success);
  });

  test("a critical hit's damage counts its dice twice under any rule, and is no d20 roll (the critical hit rules addendum)", () => {
    assert.equal(firstIssue(op({ rolls: [{ formula: "2d6+3", label: "Scimitar critical damage, slashing", critical: true }] })), null);
    assert.equal(firstIssue(op({ rolls: [{ formula: "50d6", critical: true }] })), null);
    assert.equal(firstIssue(op({ rolls: [{ formula: "51d6", critical: true }] })), FORMULA_ERRORS.dice);
    assert.equal(firstIssue(op({ rolls: [{ formula: "25d6", critical: true }, { formula: "50d6" }] })), null);
    assert.equal(firstIssue(op({ rolls: [{ formula: "25d6", critical: true }, { formula: "51d6" }] })), FORMULA_ERRORS.dice, "a crit's 25 dice count 50 in the op");
    const tooLong = `${Array.from({ length: 10 }, () => "5d1000").join("+")}${"+1000".repeat(5)}`;
    assert.equal(firstIssue(op({ rolls: [{ formula: tooLong }] })), null);
    assert.equal(firstIssue(op({ rolls: [{ formula: tooLong, critical: true }] })), FORMULA_ERRORS.long, "its counts doubled pass 100 characters");
    for (const extra of [{ mode: "adv" }, { cancelled: true }, { save: "dex" }, { critOn: 19 }]) {
      assert.equal(firstIssue(op({ rolls: [{ formula: "1d20+2d6", critical: true, ...extra }] })), "a critical hit's damage is no d20 roll", JSON.stringify(extra));
    }
    assert.notEqual(firstIssue(op({ rolls: [{ formula: "2d6", critical: false }] })), null);
    const result = { formula: "2d6+3", faces: [4, 6], total: 25, crit: "maxPlusRoll" };
    const sys = { t: "sys.dice", asked: op({ rolls: [{ formula: "2d6+3", critical: true }] }), batch: "AbCdEfGhIjKlMnOp", results: [result] };
    assert.equal(serverOnlyOpSchema.safeParse(sys).success, true);
    assert.equal(serverOnlyOpSchema.safeParse({ ...sys, results: [{ ...result, crit: "tripleDice" }] }).success, false);
  });

  test("no client may send sys.dice", () => {
    const sys = { t: "sys.dice", asked: op(), batch: "AbCdEfGhIjKlMnOp", results: [{ formula: "2d6+3", faces: [1, 1], total: 5 }] };
    assert.equal(clientOpSchema.safeParse(sys).success, false);
    assert.equal(serverOnlyOpSchema.safeParse(sys).success, true);
  });

  test("a stored sys.dice is bounded by shape alone, so a formula a later grammar refuses still replays", () => {
    const stored = { t: "sys.dice", asked: op({ rolls: [{ formula: "2d6 fire" }] }), batch: "AbCdEfGhIjKlMnOp", results: [{ formula: "2d6 fire", faces: [1, 2], total: 3 }] };
    assert.equal(opSchema.safeParse(stored).success, true);
    assert.equal(opSchema.safeParse({ ...stored, batch: "short" }).success, false);
    assert.equal(opSchema.safeParse({ ...stored, results: [] }).success, false);
    assert.equal(opSchema.safeParse({ ...stored, results: [{ formula: "1d6", faces: [0], total: 0 }] }).success, false);
  });

  test("every op the splitter makes is one the protocol takes", () => {
    const r = rng(7);
    for (let run = 0; run < 200; run++) {
      const rolls = Array.from({ length: int(r, 1, 80) }, () => {
        const dice = int(r, 1, 30);
        const roll: { formula: string; mode?: "adv" | "dis"; label?: string; creature?: { tokenId: string }; critOn?: 19; critical?: true } = { formula: chance(r, 0.5) ? `1d20+${dice}d6+${int(r, 0, 9)}` : `${dice}d${pick(r, [4, 6, 8, 10, 12])}` };
        if (roll.formula.startsWith("1d20") && chance(r, 0.4)) roll.mode = pick(r, ["adv", "dis"] as const);
        if (chance(r, 0.6)) roll.label = "x".repeat(int(r, 1, 60));
        if (chance(r, 0.5)) roll.creature = { tokenId: randomUUID() };
        // A critical hit's damage, whose dice count twice, is no attack roll.
        if (!roll.formula.startsWith("1d20") && chance(r, 0.3)) roll.critical = true;
        else if (chance(r, 0.2)) roll.critOn = 19;
        return roll;
      });
      const batched = batchRolls(rolls, { tag: TAG, to: "all" as const, ...(chance(r, 0.3) ? { ac: 15 } : {}) });
      if (!batched.ok) {
        assert.ok(rolls.length > 20 || batched.error !== FORMULA_ERRORS.other, "only a bound refuses a group of valid rolls");
        continue;
      }
      for (const made of batched.ops) assert.equal(firstIssue(made), null, JSON.stringify(made).slice(0, 200));
      assert.equal(
        batched.ops.flatMap((o) => o.rolls).length,
        rolls.length,
      );
    }
  });
});

describe("the largest dice line (Appendix B)", () => {
  test("a dice.roll at 3 KiB writes a line under 4.5 KB, near the longest whisper the log holds", () => {
    const tokens = Array.from({ length: 20 }, () => randomUUID());
    // Each one Unconscious, the longest condition that fails a save, so every result carries `fails` too.
    const state = room({ scenes: { s1: scene("s1") }, tokens: Object.fromEntries(tokens.map((id) => [id, token(id, { actor: { inline: actor({ effects: [effect("e1", { key: "unconscious" })] }) } })])) });
    // Every roll at once at the dice bound and the label bound, then labels shortened until the op fits 3 KiB.
    let label = 60;
    let asked: OpOf<"dice.roll">;
    for (;;) {
      asked = { t: "dice.roll", tag: randomUUID(), to: "dm", dc: 50, rolls: tokens.map((id, i) => ({ formula: i === 0 ? "1d20+4d1000-1000" : "5d1000-1000", label: "x".repeat(label), creature: { tokenId: id }, critOn: 19, save: "dex" })) };
      if (serializedBytes(asked) <= LIMITS.diceOpBytes) break;
      label--;
    }
    assert.equal(clientOpSchema.safeParse(asked).success, true);
    const resolved = resolveDiceOp(asked, state, { draw: (sides) => sides, batch: "AbCdEfGhIjKlMnOp" });
    assert.ok(resolved.ok);
    const applied = applyOp(state, resolved.op, { memberId: randomUUID(), role: DM.role }, { seq: 123_456_789, at: new Date().toISOString() });
    assert.ok(applied.ok);
    const line = applied.log[0]!;
    assert.ok(line.data?.type === "dice" && line.data.rolls.every((r) => r.fails === "unconscious"), "a free save for an Unconscious creature fails");
    const bytes = serializedBytes(line);
    assert.ok(bytes <= 4_608, `${bytes} bytes`);
    // So a DM line, which is cut to its bound when written (shared/logRings.ts), never loses a roll.
    assert.ok(4_608 <= LIMITS.dmLogLineBytes);
    assert.equal(cutDmLine(line), line);
    assert.ok(serializedBytes(resolved.op) <= 5_120, `the stored op is ${serializedBytes(resolved.op)} bytes`);
  });
});
