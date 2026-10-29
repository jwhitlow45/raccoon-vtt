import assert from "node:assert/strict";
import { test } from "node:test";
import type { Defense } from "#shared/dice/defenses.ts";
import { defenseKey, rowDamage, type PartAmount } from "#shared/rules/typedDamage.ts";
import { damageSummary, defenseSummaryText, type DefenseSummaryLine } from "./damageSummaryLines.ts";

const words = (lines: DefenseSummaryLine[]) => lines.map(defenseSummaryText);

const parts: PartAmount[] = [{ amount: 28, type: "fire" }, { amount: 14, type: "slashing" }, { amount: 10, type: "piercing" }];
const defenses: Defense[] = [{ kind: "resist", of: "fire", source: "Stat block" }, { kind: "immune", of: "slashing", source: "Stat block" }];
const result = rowDamage(parts, "fail", { onPass: "none", dexSave: false, row: { defenses, qualifiedOn: new Set(), evasion: false, effects: [] } });

test("FL-4: struck parts, aligned gutter, total and only this hit's defenses", () => {
  const summary = damageSummary(parts, { result, defenses });
  assert.deepEqual(summary.parts, [
    { icon: "fire", gutter: "", amount: 14, original: 28, label: "Fire damage" },
    { icon: "slashing", gutter: "+", amount: 0, original: 14, label: "Slashing damage" },
    { icon: "piercing", gutter: "+", amount: 10, label: "Piercing damage" },
  ]);
  assert.equal(summary.total, 24);
  assert.deepEqual(words(summary.defenses), ["Immune: Slashing", "Resists: Fire"]);
});

test("FL-4: qualifiers, vulnerability, inactive defenses and duplicate sources", () => {
  const qualified: Defense = { kind: "vulnerable", of: "piercing", qualifier: "from Spells", source: "Stat block" };
  const cold: Defense = { kind: "resist", of: "cold", source: "Stat block" };
  const all = [...defenses, qualified, cold, qualified];
  const qualifiedOn = new Set([defenseKey(qualified)]);
  const dealt = rowDamage(parts, "fail", { onPass: "half", dexSave: false, row: { defenses: all, qualifiedOn, evasion: false, effects: [] } });
  assert.deepEqual(damageSummary(parts, { result: dealt, defenses: all, qualifiedOn }).defenses.map(defenseSummaryText), ["Immune: Slashing", "Resists: Fire", "Vulnerable: Piercing from Spells"]);
  assert.deepEqual(damageSummary(parts, { result, defenses: all }).defenses.map(defenseSummaryText), ["Immune: Slashing", "Resists: Fire"]);
});

test("FL-4: no result keeps incoming amounts and omits every defense explanation", () => {
  assert.deepEqual(damageSummary(parts, { defenses, saved: "half" }), damageSummary(parts));
});

test("FL-4: several targets keep incoming parts and only changed visible target lines", () => {
  const summary = damageSummary(parts, { result, targets: [
    { name: "Guard", result, defenses }, { name: "Hidden", defenses }, { name: "Unchanged" },
    { name: "Same", result: { amount: 52, byPart: [28, 14, 10], notes: [] } },
  ] });
  assert.deepEqual(summary.parts, damageSummary(parts).parts);
  assert.equal(summary.total, 52);
  assert.deepEqual(summary.targets.map((target) => ({ ...target, defenses: words(target.defenses) })), [{ name: "Guard", amount: 24, defenses: ["Immune: Slashing", "Resists: Fire"] }]);
});

test("FL-4: untyped placeholder and lone parts omit a total, formulas wait for a roll", () => {
  assert.deepEqual(damageSummary([{ amount: 7 }]), { parts: [{ icon: "untyped", gutter: "", amount: 7, label: "damage" }], defenses: [], targets: [] });
  assert.equal(damageSummary([{ formula: "2d6", type: "cold" }, { amount: 4 }]).total, undefined);
  assert.equal(damageSummary([{ formula: "2d6", type: "cold" }]).parts[0]?.amount, "2d6");
  assert.deepEqual(damageSummary([]), { parts: [], defenses: [], targets: [] });
});

test("FL-4: saves and Evasion use rule amounts and suppress bypassed defenses", () => {
  for (const evasion of [false, true]) for (const pass of ["pass", "fail"] as const) {
    const dealt = rowDamage(parts, pass, { onPass: "half", dexSave: true, row: { defenses, qualifiedOn: new Set(), evasion, effects: [] } });
    const summary = damageSummary(parts, { result: dealt, defenses, ...(pass === "pass" ? { saved: "half" as const } : {}) });
    assert.equal(summary.total, dealt.amount);
    assert.deepEqual(summary.parts.map(p => p.amount), dealt.byPart);
    assert.equal(words(summary.defenses).includes("Evasion"), evasion);
    assert.equal(words(summary.defenses).includes("Saved: half"), !evasion && pass === "pass");
    if (evasion && pass === "pass") assert.deepEqual(words(summary.defenses), ["Evasion"]);
  }
  const dealt = rowDamage(parts, "pass", { onPass: "none", dexSave: false, row: { defenses, qualifiedOn: new Set(), evasion: false, effects: [] } });
  assert.deepEqual(damageSummary(parts, { result: dealt, defenses, saved: "none" }).defenses.map(defenseSummaryText), ["Saved: no damage"]);
});

test("FL-4: all-damage defenses keep that scope for untyped and typed parts", () => {
  for (const kind of ["immune", "resist", "vulnerable"] as const) for (const type of [undefined, "fire"] as const) {
    const defenses: Defense[] = [{ kind, of: "all", source: "Stat block" }];
    const parts = [{ amount: 8, ...(type ? { type } : {}) }];
    const result = rowDamage(parts, "fail", { onPass: "none", dexSave: false, row: { defenses, qualifiedOn: new Set(), evasion: false, effects: [] } });
    assert.deepEqual(damageSummary(parts, { result, defenses }).defenses.map(defenseSummaryText), [`${{ immune: "Immune", resist: "Resists", vulnerable: "Vulnerable" }[kind]}: all damage`]);
  }
});

test("FL-4: a save and vulnerability remain explained when they cancel numerically", () => {
  const parts: PartAmount[] = [{ amount: 10, type: "fire" }];
  const defenses: Defense[] = [{ kind: "vulnerable", of: "fire", source: "Stat block" }];
  const result = rowDamage(parts, "pass", { onPass: "half", dexSave: false, row: { defenses, qualifiedOn: new Set(), evasion: false, effects: [] } });
  const summary = damageSummary(parts, { result, defenses, saved: "half" });
  assert.equal(summary.parts[0]?.original, undefined);
  assert.deepEqual(words(summary.defenses), ["Vulnerable: Fire", "Saved: half"]);
});

test("FL-4: bypassed resistance is absent and several immunities form one comma-separated line", () => {
  const defenses: Defense[] = [
    { kind: "immune", of: "fire", source: "Stat block" },
    { kind: "immune", of: "slashing", source: "Stat block" },
    { kind: "resist", of: "fire", source: "Stat block" },
  ];
  const result = rowDamage(parts, "fail", { onPass: "none", dexSave: false, row: { defenses, qualifiedOn: new Set(), evasion: false, effects: [] } });
  assert.deepEqual(damageSummary(parts, { result, defenses }).defenses.map(defenseSummaryText), ["Immune: Fire, Slashing"]);
});

test("FL-4: an inactive qualifier stays hidden beside an active defense of the same type", () => {
  const qualified: Defense = { kind: "resist", of: "fire", qualifier: "from Spells", source: "Stat block" };
  const summary = damageSummary(parts, { result, defenses: [...defenses, qualified] });
  assert.deepEqual(words(summary.defenses), ["Immune: Slashing", "Resists: Fire"]);
});

test("FL-4 design: defense lines retain type identity and qualifiers for their icons", () => {
  const qualified: Defense = { kind: "resist", of: "fire", qualifier: "from Spells", source: "Stat block" };
  const summary = damageSummary(parts, { result, defenses: [qualified], qualifiedOn: new Set([defenseKey(qualified)]) });
  assert.deepEqual(summary.defenses, [{ label: "Resists", entries: [{ icon: "fire", text: "Fire", qualifier: "from Spells" }] }]);
});

test("FL-4 review: each incoming numeric part counts at least zero, including mixed formulas", () => {
  const source = [{ amount: -5, type: "cold" as const }, { amount: 6, type: "fire" as const }];
  assert.deepEqual(damageSummary(source).parts.map(p => [p.amount, p.original]), [[0, undefined], [6, undefined]]);
  assert.equal(damageSummary(source).total, 6);
  assert.deepEqual(damageSummary([...source, { formula: "1d6" }]).parts.map(p => p.amount), [0, 6, "1d6"]);
  assert.deepEqual(source.map(p => p.amount), [-5, 6], "normalizing a preview does not edit the recorded roll");
});
