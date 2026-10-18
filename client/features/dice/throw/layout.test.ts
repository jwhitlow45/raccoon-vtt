import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseFormula, type AdvantageMode } from "#shared/dice/formula.ts";
import { rollFormula } from "#shared/dice/roll.ts";
import type { DiceRoll } from "#shared/model.ts";
import { int, pick, rng } from "#shared/testutil.ts";
import { MIN_DIE_PX, planTray, seededRandom, tapDice, throwDice, trayLayout, TRAY_PX, type ThrowDie } from "./layout.ts";

/** The tray's layout and the dice of a result (docs/design-v1-roll-animation.md 3.1 and 3.3). */

const WIDTHS = [278, 288, 293, 328, 348, 356, 363];

function roll(formula: string, faces: number[], extra: Partial<DiceRoll> = {}): DiceRoll {
  return { formula, faces, total: 0, ...extra };
}

function d6s(n: number): ThrowDie[] {
  return throwDice(roll(`${n}d6`, Array.from({ length: n }, (_, i) => (i % 6) + 1)))!;
}

describe("the tray's layout", () => {
  test("the design's table: one row, two rows and the cap at each width", () => {
    const expect: Record<number, [number, number, number]> = { 278: [5, 10, 9], 288: [5, 10, 9], 293: [5, 10, 9], 328: [6, 12, 11], 348: [6, 12, 11], 356: [6, 14, 13], 363: [6, 14, 13] };
    for (const width of WIDTHS) {
      const [one, two, capped] = expect[width]!;
      assert.equal(trayLayout(one, width).rows, 1, `${width}: ${one} in one row`);
      assert.equal(trayLayout(one + 1, width).rows, 2, `${width}: ${one + 1} in two rows`);
      assert.equal(trayLayout(two, width).shown, two, `${width}: ${two} all shown`);
      assert.equal(trayLayout(two + 1, width).shown, capped, `${width}: ${capped} shown and a disc`);
    }
  });

  test("for 1 to 20 dice at every width: rows fit, two rows fit the tray, no die under 44 px, and +N counts the rest", () => {
    for (const width of WIDTHS) {
      for (let n = 1; n <= 20; n++) {
        const plan = planTray({ dice: d6s(n), decider: null, mark: null }, width, seededRandom("t"));
        assert.ok(plan.size >= MIN_DIE_PX, `${width}, ${n}: ${plan.size} px dice`);
        const count = plan.slots.length + (plan.disc ? 1 : 0);
        // Rows by their middles, which sit a die's size apart.
        const rows = new Map<number, number[]>();
        for (const s of [...plan.slots, ...(plan.disc ? [plan.disc] : [])]) {
          const row = [...rows.keys()].find((y) => Math.abs(y - s.y) < plan.size / 2) ?? s.y;
          rows.set(row, [...(rows.get(row) ?? []), s.x]);
        }
        assert.ok(rows.size <= 2, `${width}, ${n}: ${rows.size} rows`);
        for (const xs of rows.values()) {
          const left = Math.min(...xs) - plan.size / 2;
          const right = Math.max(...xs) + plan.size / 2;
          assert.ok(left >= -0.01 && right <= width + 0.01, `${width}, ${n}: a row from ${left} to ${right}`);
        }
        const tops = plan.slots.map((s) => s.y - s.size / 2);
        const bottoms = plan.slots.map((s) => s.y + s.size / 2);
        assert.ok(Math.min(...tops) >= 0 && Math.max(...bottoms) <= TRAY_PX, `${width}, ${n}: the rows fit ${TRAY_PX} px`);
        assert.equal(plan.slots.length + plan.more, n, `${width}, ${n}: shown and +N add up`);
        assert.ok(count <= 2 * trayLayout(n, width).cols, "never more places than two rows hold");
      }
    }
  });

  test("the deciding d20 goes first, so the cap never hides it, and keeps its mark", () => {
    const rolled = roll("20d6+1d20+5", [...Array.from({ length: 20 }, () => 3), 20]);
    const tap = tapDice([rolled])!;
    assert.equal(tap.decider, 20);
    assert.equal(tap.mark, "critical");
    const plan = planTray(tap, 288, seededRandom("t"));
    assert.equal(plan.slots[0]?.die.kind, "d20");
    assert.equal(plan.slots[0]?.mark, "critical");
    assert.ok(plan.slots.slice(1).every((s) => s.mark === null));
    assert.equal(plan.more, 21 - plan.slots.length);
  });

  test("a weapon's wider range rings its d20 as the Critical chip would, and a 1 is marked a fumble", () => {
    assert.equal(tapDice([roll("1d20+6", [19], { critOn: 19, label: "Longsword" })])?.mark, "critical");
    assert.equal(tapDice([roll("1d20+6", [19])])?.mark, null, "19 without a wider range is no critical");
    assert.equal(tapDice([roll("1d20+6", [1])])?.mark, "fumble");
    const adv = tapDice([roll("2d20kh1+3", [4, 20])])!;
    assert.equal(adv.decider, 1, "with advantage, the kept die decides");
    assert.deepEqual(
      adv.dice.map((d) => d.kept),
      [false, true],
    );
  });

  test("a percentile pair is never split at the cap, and +N counts it as two dice", () => {
    for (const width of WIDTHS) {
      for (let before = 0; before <= 16; before++) {
        const rolled = roll(`${before > 0 ? `${before}d6+` : ""}1d100+3d4`, [...Array.from({ length: before }, () => 2), 84, 1, 2, 3]);
        const plan = planTray(tapDice([rolled])!, width, seededRandom("p"));
        const kinds = plan.slots.map((s) => s.die.kind);
        const tens = kinds.indexOf("tens");
        if (tens >= 0) assert.equal(kinds[tens + 1], "units", `${width}, ${before}: the pair stays together`);
        else assert.ok(!kinds.includes("units"));
        assert.equal(plan.slots.length + plan.more, before + 2 + 3);
      }
    }
  });

  test("for 500 random formulas, throwDice gives the result's faces in order", () => {
    const r = rng(7);
    const sides = [2, 3, 4, 6, 8, 10, 12, 20, 100, 1000];
    for (let i = 0; i < 500; i++) {
      const parts = Array.from({ length: int(r, 1, 4) }, () => `${int(r, 1, 6)}d${pick(r, sides)}`);
      if (r() < 0.3) parts.push(String(int(r, 1, 9)));
      const parsed = parseFormula(parts.join("+"));
      assert.ok(parsed.ok);
      const mode: AdvantageMode | undefined = r() < 0.2 ? "adv" : undefined;
      const rolled = rollFormula(parsed.formula, (s) => int(r, 1, s), mode);
      if (!rolled.ok) continue;
      const result: DiceRoll = rolled.result;
      const dice = throwDice(result);
      assert.ok(dice, result.formula);
      // A percentile's two dice stand for one face.
      const faces = dice.filter((d) => d.kind !== "units").map((d) => d.face);
      assert.deepEqual(faces, result.faces, result.formula);
      for (const d of dice) {
        if (d.kind === "tens") assert.equal(d.text, String(Math.floor((d.face % 100) / 10) * 10).padStart(2, "0"));
        else if (d.kind === "units") assert.equal(d.text, String(d.face % 10));
        else assert.equal(d.text, d.face.toLocaleString("en-US"));
      }
      const plan = planTray(tapDice([result])!, pick(r, WIDTHS), seededRandom(String(i)));
      assert.deepEqual(
        plan.slots.map((s) => s.die),
        (() => {
          const all = tapDice([result])!;
          const order = [...all.dice];
          if (all.decider !== null && all.decider > 0) order.unshift(...order.splice(all.decider, 1));
          return order.slice(0, plan.slots.length);
        })(),
        "up to the cap, in order",
      );
    }
  });

  test("the same tag always draws the same random", () => {
    const a = seededRandom("0192-tag");
    const b = seededRandom("0192-tag");
    const c = seededRandom("0192-other");
    const first = [a(), a(), a()];
    assert.deepEqual([b(), b(), b()], first);
    assert.notDeepEqual([c(), c(), c()], first);
    assert.ok(first.every((x) => x >= 0 && x < 1));
  });
});
