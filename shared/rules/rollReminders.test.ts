import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { D20Test } from "../dice/bonus.ts";
import { resolveAdvantage } from "../dice/formula.ts";
import type { AbilityKey, Effect, RollTest, SkillKey } from "../model.ts";
import { RULES_TEXT } from "../srd/rules-text.ts";
import { effect } from "../testutil.ts";
import { advantageHint } from "./initiative.ts";
import { ROLL_REMINDER_RULES, failingCondition, incapacitated, reminderPreset, rollReminders } from "./rollReminders.ts";

const DEX_SAVE: RollTest = { kind: "save", choices: [{ ability: "dex" }] };
const STR_OR_DEX_SAVE: RollTest = { kind: "save", choices: [{ ability: "str" }, { ability: "dex" }] };
const PERCEPTION: RollTest = { kind: "check", choices: [{ ability: "wis", skill: "perception" }] };
const ATHLETICS_OR_ACROBATICS: RollTest = { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] };

/** The SRD's apostrophes are curly, the reminders' quotes straight. */
function plain(text: string): string {
  return text.replaceAll("’", "'");
}

describe("roll reminders (docs/design-v1-dm-tools.md 3.3)", () => {
  test("every reminder rests on words its SRD 5.2.1 rule says", () => {
    for (const rule of ROLL_REMINDER_RULES) {
      const entry = rule.source === "conditions" ? RULES_TEXT.conditions[rule.key as keyof typeof RULES_TEXT.conditions] : RULES_TEXT.statuses[rule.key as keyof typeof RULES_TEXT.statuses];
      assert.ok(entry, `${rule.key} has SRD text`);
      for (const quote of rule.quotes) assert.ok(plain(entry.text).includes(quote), `${rule.key}: "${quote}"`);
    }
  });

  test("each shows only when it bears on what was asked", () => {
    const keysFor = (keys: string[], test: RollTest, choice?: number) => rollReminders(keys.map((key) => ({ key: key as never })), test, choice).map((r) => r.key);
    assert.deepEqual(keysFor(["paralyzed", "petrified", "stunned", "unconscious"], DEX_SAVE), ["paralyzed", "petrified", "stunned", "unconscious"]);
    assert.deepEqual(keysFor(["paralyzed"], PERCEPTION), []);
    assert.deepEqual(keysFor(["dodging", "hasted"], DEX_SAVE), ["dodging", "hasted"]);
    // Restrained sets Speed 0, and Dodge's own words end it there.
    assert.deepEqual(keysFor(["restrained", "dodging", "hasted"], DEX_SAVE), ["restrained", "hasted"]);
    assert.deepEqual(keysFor(["restrained", "dodging", "hasted"], { kind: "save", choices: [{ ability: "con" }] }), []);
    assert.deepEqual(keysFor(["blinded", "deafened", "poisoned", "frightened", "hexed"], PERCEPTION), ["blinded", "deafened", "poisoned", "frightened", "hexed"]);
    assert.deepEqual(keysFor(["blinded", "deafened", "poisoned", "frightened", "hexed"], DEX_SAVE), []);
    assert.deepEqual(keysFor(["blessed", "baned"], DEX_SAVE), ["baned", "blessed"]);
    assert.deepEqual(keysFor(["blessed", "baned"], PERCEPTION), []);
    assert.deepEqual(keysFor(["raging"], ATHLETICS_OR_ACROBATICS), ["raging"]);
    assert.deepEqual(keysFor(["raging"], ATHLETICS_OR_ACROBATICS, 1), []);
    assert.deepEqual(keysFor(["raging"], STR_OR_DEX_SAVE, 0), ["raging"]);
    assert.deepEqual(keysFor(["exhaustion", "heroic-inspiration"], PERCEPTION), ["exhaustion", "heroic-inspiration"]);
  });

  test("Exhaustion reads as its number, from the effect's level", () => {
    const [reminder] = rollReminders([{ key: "exhaustion", level: 2 }], DEX_SAVE);
    assert.equal(reminder?.text, "Exhaustion 2: the roll is reduced by 4.");
    assert.equal(rollReminders([{ key: "exhaustion" }], DEX_SAVE)[0]?.text, "Exhaustion 1: the roll is reduced by 2.");
  });

  test("Dodge and Rage say what ends them, and Hex stays general since the effect stores no ability", () => {
    const text = (key: string, test: RollTest) => rollReminders([{ key: key as never }], test)[0]?.text ?? "";
    assert.match(text("dodging", DEX_SAVE), /lost if you have the Incapacitated condition or if your Speed is 0/);
    assert.match(text("raging", STR_OR_DEX_SAVE), /ended early by Heavy armor or the Incapacitated condition/);
    assert.equal(text("hexed", PERCEPTION), "Hexed: Disadvantage on ability checks made with the ability the hex chose.");
  });

  test("an effect held twice reminds once", () => {
    assert.equal(rollReminders([{ key: "poisoned" }, { key: "poisoned" }], PERCEPTION).length, 1);
  });
});

const SAVE = (ability: AbilityKey, extra: Partial<Extract<D20Test, { kind: "save" }>> = {}): D20Test => ({ kind: "save", ability, ...extra });
const CHECK = (ability: AbilityKey, skill?: SkillKey): D20Test => (skill ? { kind: "check", ability, skill } : { kind: "check", ability });
const ATTACK: D20Test = { kind: "attack" };
const INITIATIVE: D20Test = { kind: "initiative" };
const DEATH: D20Test = { kind: "deathSave" };
const CONCENTRATION = SAVE("con", { cause: "concentration" });
const SAVE_ENDS = SAVE("wis", { cause: "saveEnds", spell: true });
const KINDS: readonly D20Test[] = [SAVE("str"), SAVE("dex"), SAVE("con"), CONCENTRATION, SAVE_ENDS, DEATH, CHECK("str", "athletics"), CHECK("dex", "stealth"), CHECK("wis"), INITIATIVE, ATTACK];

/** A preset in short: each source as "adv:key", the extra, the fail and the notes' keys. */
function short(keys: string[], test: D20Test, ctx?: Parameters<typeof reminderPreset>[2], level?: number) {
  const p = reminderPreset(
    keys.map((key) => ({ key: key as Effect["key"], ...(level !== undefined ? { level } : {}) })),
    test,
    ctx,
  );
  return { sources: p.sources.map((s) => `${s.kind}:${s.from}`), extra: p.extra, fails: p.fails as string | undefined, notes: p.notes.map((n) => n.key as string) };
}

type Short = ReturnType<typeof short>;
const NONE: Short = { sources: [], extra: [], fails: undefined, notes: [] };

/** What an effect gives each test kind it bears on, and every other kind left alone. */
function onlyOn(keys: string[], expected: Map<D20Test, Partial<Short>>, level?: number) {
  for (const test of KINDS) {
    const want = expected.get(test);
    assert.deepEqual(short(keys, test, {}, level), { ...NONE, ...want }, `${keys.join("+")} on ${JSON.stringify(test)}`);
  }
}

describe("presets for every d20 roll (docs/design-v1-roll-options.md 3.2, Appendix C)", () => {
  test("Paralyzed, Petrified, Stunned and Unconscious fail Strength and Dexterity saves, and give initiative the tracker's hint", () => {
    for (const key of ["paralyzed", "petrified", "stunned", "unconscious"]) {
      onlyOn(
        [key],
        new Map<D20Test, Partial<Short>>([
          [KINDS[0]!, { fails: key }],
          [KINDS[1]!, { fails: key }],
          [INITIATIVE, { sources: [`dis:${key}`] }],
        ]),
      );
    }
    onlyOn(["incapacitated"], new Map<D20Test, Partial<Short>>([[INITIATIVE, { sources: ["dis:incapacitated"] }]]));
  });

  test("Restrained, Poisoned, Prone, Blinded and Invisible", () => {
    onlyOn(
      ["restrained"],
      new Map<D20Test, Partial<Short>>([
        [KINDS[1]!, { sources: ["dis:restrained"] }],
        [ATTACK, { sources: ["dis:restrained"] }],
      ]),
    );
    onlyOn(
      ["poisoned"],
      new Map<D20Test, Partial<Short>>([
        [KINDS[6]!, { sources: ["dis:poisoned"] }],
        [KINDS[7]!, { sources: ["dis:poisoned"] }],
        [KINDS[8]!, { sources: ["dis:poisoned"] }],
        [INITIATIVE, { sources: ["dis:poisoned"] }],
        [ATTACK, { sources: ["dis:poisoned"] }],
      ]),
    );
    onlyOn(["prone"], new Map<D20Test, Partial<Short>>([[ATTACK, { sources: ["dis:prone"] }]]));
    onlyOn(
      ["blinded"],
      new Map<D20Test, Partial<Short>>([
        [KINDS[6]!, { notes: ["blinded"] }],
        [KINDS[7]!, { notes: ["blinded"] }],
        [KINDS[8]!, { notes: ["blinded"] }],
        // Initiative is a Dexterity check in 2024, so a check's note reaches it (W7B-P-22).
        [INITIATIVE, { notes: ["blinded"] }],
        [ATTACK, { sources: ["dis:blinded"] }],
      ]),
    );
    onlyOn(
      ["invisible"],
      new Map<D20Test, Partial<Short>>([
        [ATTACK, { sources: ["adv:invisible"], notes: ["invisible"] }],
        [INITIATIVE, { sources: ["adv:invisible"] }],
      ]),
    );
  });

  test("Frightened, Grappled, Deafened and Hexed remind only, where their words reach, Initiative among the checks", () => {
    const checks = (key: string): [D20Test, Partial<Short>][] => [KINDS[6]!, KINDS[7]!, KINDS[8]!, INITIATIVE].map((t) => [t, { notes: [key] }]);
    onlyOn(["frightened"], new Map<D20Test, Partial<Short>>([...checks("frightened"), [ATTACK, { notes: ["frightened"] }]]));
    onlyOn(["grappled"], new Map<D20Test, Partial<Short>>([[ATTACK, { notes: ["grappled"] }]]));
    onlyOn(["deafened"], new Map<D20Test, Partial<Short>>(checks("deafened")));
    onlyOn(["hexed"], new Map<D20Test, Partial<Short>>(checks("hexed")));
    assert.equal(reminderPreset([{ key: "frightened" }], INITIATIVE).notes[0]?.text, "Frightened: Disadvantage on Initiative, a Dexterity check, while the source of fear is within line of sight.");
    assert.equal(reminderPreset([{ key: "hexed" }], INITIATIVE).notes[0]?.text, "Hexed: Disadvantage on Initiative if the hex chose Dexterity.");
  });

  test("Exhaustion takes 2 a level off every d20 roll, and Heroic Inspiration reminds on every one", () => {
    onlyOn(["exhaustion"], new Map<D20Test, Partial<Short>>(KINDS.map((t) => [t, { extra: ["-4"] }])), 2);
    onlyOn(["heroic-inspiration"], new Map<D20Test, Partial<Short>>(KINDS.map((t) => [t, { notes: ["heroic-inspiration"] }])));
  });

  test("Bless and Bane on saves, death saves, concentration and attacks, never on checks or initiative", () => {
    const rolls = KINDS.filter((t) => t.kind === "save" || t.kind === "deathSave" || t.kind === "attack");
    onlyOn(["blessed"], new Map<D20Test, Partial<Short>>(rolls.map((t) => [t, { extra: ["+1d4"] }])));
    onlyOn(["baned"], new Map<D20Test, Partial<Short>>(rolls.map((t) => [t, { extra: ["-1d4"] }])));
    assert.equal(reminderPreset([{ key: "blessed" }], ATTACK).notes.length, 0);
    assert.equal(rollReminders([{ key: "blessed" }], DEX_SAVE)[0]?.text, "Blessed: add 1d4 to the save.");
  });

  test("Dodging and Hasted on Dexterity saves, Raging on Strength checks and saves, Surprised on initiative", () => {
    onlyOn(["dodging"], new Map<D20Test, Partial<Short>>([[KINDS[1]!, { sources: ["adv:dodging"] }]]));
    onlyOn(["hasted"], new Map<D20Test, Partial<Short>>([[KINDS[1]!, { sources: ["adv:hasted"] }]]));
    onlyOn(
      ["raging"],
      new Map<D20Test, Partial<Short>>([
        [KINDS[0]!, { sources: ["adv:raging"] }],
        [KINDS[6]!, { sources: ["adv:raging"] }],
      ]),
    );
    onlyOn(["surprised"], new Map<D20Test, Partial<Short>>([[INITIATIVE, { sources: ["dis:surprised"] }]]));
  });

  test("Magic Resistance gives advantage on a save against a spell only, a save-ends save among them", () => {
    for (const test of KINDS) {
      const want = test.kind === "save" && test.spell ? ["adv:magic-resistance"] : [];
      assert.deepEqual(short([], test, { magicResistance: true }).sources, want, JSON.stringify(test));
    }
    assert.deepEqual(short([], SAVE("dex", { spell: true })).sources, [], "no Magic Resistance, no advantage");
    assert.deepEqual(short([], SAVE("dex", { spell: true }), { magicResistance: true }).sources, ["adv:magic-resistance"]);
  });

  test("the exceptions the rules quote: Dodging and Restrained is disadvantage, Raging and Stunned fails, through one incapacitation rule", () => {
    assert.deepEqual(short(["dodging", "restrained"], SAVE("dex")), { ...NONE, sources: ["dis:restrained"] });
    assert.deepEqual(short(["dodging", "grappled"], SAVE("dex")), NONE);
    assert.deepEqual(short(["raging", "stunned"], SAVE("str")), { ...NONE, fails: "stunned" });
    for (const key of ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"]) {
      assert.deepEqual(short(["dodging", key], SAVE("dex")).sources, [], `Dodging and ${key}`);
      assert.deepEqual(short(["raging", key], CHECK("str")).sources, [], `Raging and ${key}`);
    }
  });

  test("three and more sources in every order are the same sources, and cancel as one roll", () => {
    const cases: { keys: string[]; test: D20Test; ctx?: { magicResistance?: boolean }; mode: "adv" | "dis" | undefined }[] = [
      { keys: ["invisible", "poisoned", "prone"], test: ATTACK, mode: undefined },
      { keys: ["hasted", "restrained", "dodging"], test: SAVE("dex", { spell: true }), ctx: { magicResistance: true }, mode: undefined },
      { keys: ["poisoned", "prone", "blinded", "restrained"], test: ATTACK, mode: "dis" },
      { keys: ["hasted", "dodging", "raging"], test: SAVE("dex"), mode: "adv" },
    ];
    for (const c of cases) {
      const first = short(c.keys, c.test, c.ctx);
      for (const order of permutations(c.keys)) {
        const p = reminderPreset(
          order.map((key) => ({ key: key as Effect["key"] })),
          c.test,
          c.ctx,
        );
        assert.deepEqual(short(order, c.test, c.ctx), first, order.join(","));
        assert.equal(resolveAdvantage(p.sources), c.mode, order.join(","));
      }
    }
  });

  test("initiative: the row's DM mark replaces the tracker's hint and keeps Poisoned and Exhaustion", () => {
    assert.deepEqual(short(["surprised", "poisoned"], INITIATIVE), { ...NONE, sources: ["dis:poisoned", "dis:surprised"] });
    assert.deepEqual(short(["surprised", "poisoned", "invisible"], INITIATIVE, { mark: "adv" }), { ...NONE, sources: ["adv:tracker", "dis:poisoned"] });
    assert.deepEqual(short(["exhaustion"], INITIATIVE, { mark: "dis" }, 1), { ...NONE, sources: ["dis:tracker"], extra: ["-2"] });
    assert.deepEqual(short([], CHECK("dex"), { mark: "adv" }).sources, [], "a mark is the tracker's, for initiative only");
  });

  test("the tracker's hint and the preset agree on every mix of its effects", () => {
    const hintKeys = ["invisible", "surprised", "incapacitated", "stunned", "paralyzed"];
    for (let mask = 0; mask < 1 << hintKeys.length; mask++) {
      const keys = hintKeys.filter((_, i) => mask & (1 << i));
      const effects = keys.map((key, i) => effect(`e${i}`, { key: key as Effect["key"] }));
      assert.equal(resolveAdvantage(reminderPreset(effects, INITIATIVE).sources), advantageHint(effects), keys.join(","));
    }
  });

  test("the server's automatic fail reads the same table, and never a condition the DM hid", () => {
    assert.equal(failingCondition([{ key: "stunned" }], SAVE("dex")), "stunned");
    assert.equal(failingCondition([{ key: "stunned", hiddenFromPlayers: true }], SAVE("dex")), undefined);
    assert.equal(failingCondition([{ key: "stunned", hiddenFromPlayers: true }, { key: "paralyzed" }], SAVE("str")), "paralyzed");
    for (const test of [SAVE("con"), DEATH, CHECK("dex"), ATTACK, INITIATIVE]) assert.equal(failingCondition([{ key: "stunned" }], test), undefined);
    assert.equal(incapacitated([{ key: "stunned" }]), true);
  });
});

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}
