import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceResult } from "../model.ts";
import { FORMULA_ERRORS, parseFormula, type Formula } from "./formula.ts";
import { hitOf, keptD20, keptFaces, naturalOf, rerollable, rerollFace, rolledTerms, rollFormula, serverDraw, totalOf, type Draw } from "./roll.ts";

function formula(text: string): Formula {
  const parsed = parseFormula(text);
  assert.ok(parsed.ok, text);
  return parsed.formula;
}

/** A draw that hands out the given faces in order, and says which sides each draw asked for. */
function scripted(faces: number[]): Draw & { asked: number[] } {
  const asked: number[] = [];
  const draw = ((sides: number) => {
    asked.push(sides);
    const face = faces.shift();
    assert.ok(face !== undefined, "the script has a face for every die");
    return face;
  }) as Draw & { asked: number[] };
  draw.asked = asked;
  return draw;
}

function roll(text: string, faces: number[], mode?: "adv" | "dis"): DiceResult {
  const rolled = rollFormula(formula(text), scripted([...faces]), mode);
  assert.ok(rolled.ok, text);
  return rolled.result;
}

describe("rolling a formula (docs/design-v1-dice.md 4.2)", () => {
  test("draws term by term, die by die, and sums the kept faces with the numbers", () => {
    const draw = scripted([4, 6, 3]);
    const rolled = rollFormula(formula("2d6+3-1d4"), draw);
    assert.ok(rolled.ok);
    assert.deepEqual(rolled.result, { formula: "2d6+3-1d4", faces: [4, 6, 3], total: 10 });
    assert.deepEqual(draw.asked, [6, 6, 4]);
  });

  test("a mode applies to the one d20 first and is kept on the result", () => {
    assert.deepEqual(roll("1d20+5", [14, 7], "adv"), { formula: "2d20kh1+5", faces: [14, 7], total: 19, mode: "adv" });
    assert.deepEqual(roll("1d20+5", [14, 7], "dis"), { formula: "2d20kl1+5", faces: [14, 7], total: 12, mode: "dis" });
    assert.deepEqual(rollFormula(formula("2d6"), scripted([]), "adv"), { ok: false, error: FORMULA_ERRORS.mode });
  });

  test("a keep keeps the n highest or lowest, and of equal faces the earlier", () => {
    assert.deepEqual(keptFaces({ keep: { high: true, n: 3 } }, [3, 5, 1, 5]), [true, true, false, true]);
    assert.deepEqual(keptFaces({ keep: { high: true, n: 1 } }, [5, 5]), [true, false]);
    assert.deepEqual(keptFaces({ keep: { high: false, n: 1 } }, [2, 2]), [true, false]);
    assert.deepEqual(keptFaces({}, [1, 2]), [true, true]);
    assert.equal(totalOf(formula("4d6kh3"), [3, 5, 1, 5]), 13);
  });

  test("the server's draw stays within 1 to its sides", () => {
    for (const sides of [2, 3, 6, 20, 100, 1_000]) {
      const seen = new Set<number>();
      for (let i = 0; i < 2_000; i++) {
        const face = serverDraw(sides);
        assert.ok(Number.isInteger(face) && face >= 1 && face <= sides, `${face} on a d${sides}`);
        seen.add(face);
      }
      if (sides <= 20) assert.equal(seen.size, sides, `every face of a d${sides} comes up`);
    }
  });
});

describe("reading a result back (5.1)", () => {
  test("pairs each dice term with its faces and what it kept", () => {
    const terms = rolledTerms({ formula: "2d20kh1+5+1d4", faces: [14, 7, 3] });
    assert.ok(terms);
    assert.deepEqual(
      terms.map((t) => ("kept" in t ? { faces: t.faces, kept: t.kept, first: t.first } : t.term.value)),
      [{ faces: [14, 7], kept: [true, false], first: 0 }, 5, { faces: [3], kept: [true], first: 2 }],
    );
  });

  test("a formula a later grammar refuses, or faces that do not match, read as null", () => {
    assert.equal(rolledTerms({ formula: "2d6 fire", faces: [1, 2] }), null);
    assert.equal(rolledTerms({ formula: "2d6", faces: [1] }), null);
    assert.equal(rolledTerms({ formula: "2d6", faces: [1, 2, 3] }), null);
  });

  test("a natural 20 or 1 is the deciding d20's kept face, and only a roll with one such d20 has one", () => {
    assert.equal(naturalOf(roll("1d20+5", [20])), 20);
    assert.equal(naturalOf(roll("1d20+5", [1, 20], "dis")), 1);
    assert.equal(naturalOf(roll("1d20+5", [1, 20], "adv")), 20);
    assert.equal(naturalOf(roll("1d20+5", [12])), null);
    assert.equal(naturalOf(roll("2d20", [20, 20])), null, "two kept d20s decide nothing alone");
    assert.equal(naturalOf(roll("1d20+1d20", [20, 3])), null, "nor do two d20 terms");
    assert.equal(naturalOf(roll("2d6", [6, 6])), null);
    assert.deepEqual(keptD20(roll("1d20+3", [7, 15], "dis")), { index: 0, face: 7 });
  });

  test("an attack against an AC: a kept 1 misses, a kept face at the critical range crits, else the total decides", () => {
    assert.equal(hitOf({ ...roll("1d20+20", [1]) }, 15), "miss", "a 1 that meets the AC still misses");
    assert.equal(hitOf({ ...roll("1d20+0", [19]), critOn: 19 }, 30), "critical");
    assert.equal(hitOf({ ...roll("1d20+0", [19]) }, 30), "miss");
    assert.equal(hitOf({ ...roll("1d20+0", [20]) }, 30), "critical");
    assert.equal(hitOf({ ...roll("1d20+4", [11]) }, 15), "hit");
    assert.equal(hitOf({ ...roll("1d20+4", [10]) }, 15), "miss");
    assert.equal(hitOf({ ...roll("1d20+4", [19, 2], "dis") }, 5), "hit", "the dropped 19 is no critical");
  });
});

describe("rerolls (5.4)", () => {
  test("Heroic Inspiration's default: the kept d20, or the dropped one on an advantage roll", () => {
    assert.equal(rerollFace(roll("1d20+3", [9]), "heroic-inspiration"), 0);
    assert.equal(rerollFace(roll("1d20+3+1d4", [1, 18, 2], "dis"), "heroic-inspiration"), 0);
    assert.equal(rerollFace(roll("1d20+3+1d4", [18, 1, 2], "dis"), "heroic-inspiration"), 1);
    assert.equal(rerollFace(roll("1d20+3", [18, 1], "adv"), "heroic-inspiration"), 1);
    assert.equal(rerollFace(roll("1d20+3", [1, 18], "adv"), "heroic-inspiration"), 0);
    assert.equal(rerollFace(roll("2d6", [3, 4]), "heroic-inspiration"), null);
  });

  test("Halfling Luck's default is the d20 showing 1, the kept one first", () => {
    assert.equal(rerollFace(roll("1d20+3", [1]), "halfling-luck"), 0);
    assert.equal(rerollFace(roll("1d20+3", [12, 1], "dis"), "halfling-luck"), 1);
    assert.equal(rerollFace(roll("1d20+3", [12, 1], "adv"), "halfling-luck"), 1);
    assert.equal(rerollFace(roll("1d20+3", [12]), "halfling-luck"), null);
    assert.equal(rerollFace(roll("1d20+3", [12]), "lucky"), null);
    assert.equal(rerollFace(roll("1d20+3", [12]), "bardic-inspiration"), null);
  });

  test("Heroic Inspiration may name any die, a selected Bless d4 among them, and Halfling Luck only a d20 showing 1", () => {
    const blessed = roll("1d20+3+1d4", [1, 18, 2], "dis");
    for (const face of [0, 1, 2]) assert.equal(rerollable(blessed, "heroic-inspiration", face), true, `face ${face}`);
    assert.equal(rerollable(blessed, "heroic-inspiration", 3), false, "a face the roll does not hold");
    assert.equal(rerollable(blessed, "heroic-inspiration", -1), false);
    assert.equal(rerollable(blessed, "halfling-luck", 0), true);
    assert.equal(rerollable(blessed, "halfling-luck", 1), false, "an 18");
    assert.equal(rerollable(roll("1d20+1d4", [5, 1]), "halfling-luck", 1), false, "a d4 showing 1 is no d20");
    assert.equal(rerollable(blessed, "lucky", 0), false);
    assert.equal(rerollable(blessed, "bardic-inspiration", 0), false);
  });
});
