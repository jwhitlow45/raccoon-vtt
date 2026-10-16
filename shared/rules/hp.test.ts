import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type Actor } from "../model.ts";
import { actor, effect } from "../testutil.ts";
import {
  ZERO_HP_UNCONSCIOUS_ID,
  applyDamage,
  applyDeathSaves,
  applyHeal,
  applyHpSet,
  applyLife,
  applyTemp,
  concentrationDc,
  endConcentration,
  hpBar,
  hpLabel,
  hpLess,
} from "./hp.ts";

const settings = { ...DEFAULT_SETTINGS };
const noDeath = { ...DEFAULT_SETTINGS, monstersDieAtZero: false };

describe("damage", () => {
  test("takes temporary HP first, then current, never below 0", () => {
    const r = applyDamage(actor({ hp: { cur: 10, max: 20, temp: 4 } }), 6, "pc", settings);
    assert.deepEqual(r.actor.hp, { cur: 8, max: 20, temp: 0 });
    assert.equal(r.actor.life, "alive");
    assert.deepEqual(r.events[0], { type: "hp", change: "damage", amount: 6, label: "Bloodied" });
  });

  test("a PC at 0 becomes dying, gains Unconscious and resets death saves", () => {
    const r = applyDamage(actor({ deathSaves: { ok: 2, fail: 1 } }), 20, "pc", settings);
    assert.equal(r.actor.hp.cur, 0);
    assert.equal(r.actor.life, "dying");
    assert.deepEqual(r.actor.deathSaves, { ok: 0, fail: 0 });
    assert.ok(r.actor.effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID && e.key === "unconscious"));
    assert.ok(r.events.some((e) => e.type === "life" && e.life === "dying"));
  });

  test("a monster at 0 dies when the room says so, and follows the PC rules otherwise", () => {
    assert.equal(applyDamage(actor(), 20, "monster", settings).actor.life, "dead");
    assert.equal(applyDamage(actor(), 20, "npc", settings).actor.life, "dead");
    const dying = applyDamage(actor(), 20, "monster", noDeath).actor;
    assert.equal(dying.life, "dying");
    assert.ok(dying.effects.some((e) => e.key === "unconscious"));
  });

  test("a creature that dies is never Unconscious, but keeps an Unconscious the DM applied", () => {
    const killed = applyDamage(actor(), 20, "monster", settings).actor;
    assert.equal(killed.life, "dead");
    assert.equal(killed.effects.some((e) => e.key === "unconscious"), false);
    const dying = applyDamage(actor(), 20, "pc", settings).actor;
    assert.equal(applyDeathSaves(dying, 0, 3).actor.effects.some((e) => e.key === "unconscious"), false);
    assert.equal(applyDamage(dying, 20, "pc", settings).actor.effects.some((e) => e.key === "unconscious"), false);
    assert.equal(applyLife(dying, "dead").actor.effects.some((e) => e.key === "unconscious"), false);
    const slept = actor({ effects: [effect("sleep", { key: "unconscious" })] });
    assert.deepEqual(applyDamage(slept, 20, "monster", settings).actor.effects.map((e) => e.id), ["sleep"]);
  });

  test("an object stays at 0 with no state change", () => {
    const r = applyDamage(actor(), 50, "object", settings);
    assert.equal(r.actor.hp.cur, 0);
    assert.equal(r.actor.life, "alive");
    assert.equal(r.actor.effects.length, 0);
  });

  test("massive damage kills at once", () => {
    const r = applyDamage(actor({ hp: { cur: 5, max: 20, temp: 0 } }), 25, "pc", settings);
    assert.equal(r.actor.life, "dead");
    const exact = applyDamage(actor({ hp: { cur: 5, max: 20, temp: 0 } }), 24, "pc", settings);
    assert.equal(exact.actor.life, "dying");
  });

  test("damage at 0 adds a failed death save, two on a critical", () => {
    const dying = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying" });
    assert.deepEqual(applyDamage(dying, 3, "pc", settings).actor.deathSaves, { ok: 0, fail: 1 });
    assert.deepEqual(applyDamage(dying, 3, "pc", settings, true).actor.deathSaves, { ok: 0, fail: 2 });
    const third = applyDamage({ ...dying, deathSaves: { ok: 1, fail: 2 } }, 1, "pc", settings).actor;
    assert.equal(third.life, "dead");
  });

  test("damage at 0 of at least max HP kills, and temp HP that absorbs it still costs a death save", () => {
    const dying = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying" });
    assert.equal(applyDamage(dying, 20, "pc", settings).actor.life, "dead");
    const shielded = applyDamage({ ...dying, hp: { cur: 0, max: 20, temp: 5 } }, 4, "pc", settings).actor;
    assert.equal(shielded.life, "dying");
    assert.equal(shielded.hp.temp, 1);
    assert.deepEqual(shielded.deathSaves, { ok: 0, fail: 1 });
    const stable = applyDamage({ ...dying, life: "stable", hp: { cur: 0, max: 20, temp: 5 } }, 4, "pc", settings, true).actor;
    assert.equal(stable.life, "dying");
    assert.deepEqual(stable.deathSaves, { ok: 0, fail: 2 });
    const massive = applyDamage({ ...dying, hp: { cur: 0, max: 20, temp: 5 } }, 20, "pc", settings).actor;
    assert.equal(massive.life, "dead");
  });

  test("damage while stable makes the creature dying again with a failure", () => {
    const stable = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "stable" });
    const r = applyDamage(stable, 2, "pc", settings);
    assert.equal(r.actor.life, "dying");
    assert.deepEqual(r.actor.deathSaves, { ok: 0, fail: 1 });
    assert.deepEqual(applyDamage(stable, 2, "pc", settings, true).actor.deathSaves, { ok: 0, fail: 2 });
    assert.equal(applyDamage(stable, 20, "pc", settings).actor.life, "dead");
  });

  test("a dead creature ignores damage", () => {
    const dead = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dead" });
    const r = applyDamage(dead, 5, "pc", settings);
    assert.equal(r.actor, dead);
    assert.equal(r.events.length, 0);
  });

  test("damage while concentrating prompts with the DC, and dropping to 0 ends concentration", () => {
    const conc = actor({ hp: { cur: 50, max: 50, temp: 0 }, effects: [effect("c", { key: "concentrating", spell: "Bless" })] });
    const r = applyDamage(conc, 23, "pc", settings);
    assert.ok(r.events.some((e) => e.type === "concentration" && e.dc === 11));
    assert.ok(r.actor.effects.some((e) => e.key === "concentrating"));
    const down = applyDamage({ ...conc, hp: { cur: 5, max: 20, temp: 0 } }, 5, "pc", settings);
    assert.ok(!down.actor.effects.some((e) => e.key === "concentrating"));
    assert.ok(down.events.some((e) => e.type === "concentration" && e.ended === true && e.spell === "Bless"));
  });

  test("the DC is at least 10 and at most 30", () => {
    assert.equal(concentrationDc(1), 10);
    assert.equal(concentrationDc(21), 10);
    assert.equal(concentrationDc(22), 11);
    assert.equal(concentrationDc(200), 30);
  });
});

describe("healing", () => {
  test("from 0 revives, removes the automatic Unconscious and clears death saves", () => {
    const dying = applyDamage(actor(), 20, "pc", settings).actor;
    const r = applyHeal({ ...dying, deathSaves: { ok: 1, fail: 2 } }, 5);
    assert.equal(r.actor.hp.cur, 5);
    assert.equal(r.actor.life, "alive");
    assert.deepEqual(r.actor.deathSaves, { ok: 0, fail: 0 });
    assert.ok(!r.actor.effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID));
    assert.ok(r.events.some((e) => e.type === "life" && e.life === "alive"));
  });

  test("keeps a hand-applied Unconscious", () => {
    const down = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "stable", effects: [effect("manual", { key: "unconscious" })] });
    const r = applyHeal(down, 1);
    assert.ok(r.actor.effects.some((e) => e.id === "manual"));
  });

  test("caps at max and does nothing to the dead", () => {
    assert.equal(applyHeal(actor({ hp: { cur: 18, max: 20, temp: 0 } }), 10).actor.hp.cur, 20);
    const dead = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dead" });
    assert.equal(applyHeal(dead, 10).actor, dead);
  });

  test("temporary HP is set, not stacked", () => {
    assert.equal(applyTemp(actor({ hp: { cur: 10, max: 20, temp: 8 } }), 5).actor.hp.temp, 5);
  });
});

describe("set", () => {
  test("to 0 follows the reaching-0 rules, from 0 revives, and the dead stay dead", () => {
    const toZero = applyHpSet(actor(), { cur: 0 }, "pc", settings).actor;
    assert.equal(toZero.life, "dying");
    const up = applyHpSet(toZero, { cur: 3 }, "pc", settings).actor;
    assert.equal(up.life, "alive");
    assert.ok(!up.effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID));
    const dead = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dead" });
    assert.equal(applyHpSet(dead, { cur: 10 }, "pc", settings).actor.life, "dead");
  });

  test("clamps cur into [0, max] and lowering max lowers cur", () => {
    const r = applyHpSet(actor(), { max: 10 }, "pc", settings).actor;
    assert.deepEqual(r.hp, { cur: 10, max: 10, temp: 0 });
    assert.equal(applyHpSet(actor(), { cur: 99 }, "pc", settings).actor.hp.cur, 20);
  });
});

describe("death saves and life", () => {
  test("three successes stabilize and reset, three failures kill", () => {
    const dying = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying", effects: [effect(ZERO_HP_UNCONSCIOUS_ID, { key: "unconscious" })] });
    const stable = applyDeathSaves(dying, 3, 1).actor;
    assert.equal(stable.life, "stable");
    assert.deepEqual(stable.deathSaves, { ok: 0, fail: 0 });
    assert.ok(stable.effects.some((e) => e.key === "unconscious"));
    assert.equal(applyDeathSaves(dying, 1, 3).actor.life, "dead");
    assert.deepEqual(applyDeathSaves(dying, 2, 2).actor.deathSaves, { ok: 2, fail: 2 });
  });

  test("the DM revives at 1 HP, kills to 0 and can set dying or stable", () => {
    const dead = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dead", effects: [effect(ZERO_HP_UNCONSCIOUS_ID, { key: "unconscious" })] });
    const alive = applyLife(dead, "alive").actor;
    assert.equal(alive.life, "alive");
    assert.equal(alive.hp.cur, 1);
    assert.equal(alive.effects.length, 0);
    const killed = applyLife(actor({ effects: [effect("c", { key: "concentrating" })] }), "dead");
    assert.equal(killed.actor.hp.cur, 0);
    assert.equal(killed.actor.life, "dead");
    assert.ok(killed.events.some((e) => e.type === "concentration" && e.ended));
    const dying = applyLife(actor(), "dying").actor;
    assert.equal(dying.hp.cur, 0);
    assert.ok(dying.effects.some((e) => e.key === "unconscious"));
    const stable = applyLife(actor(), "stable").actor;
    assert.equal(stable.life, "stable");
    assert.ok(stable.effects.some((e) => e.key === "unconscious"));
  });
});

describe("labels", () => {
  test("hpLabel follows life then half HP", () => {
    assert.equal(hpLabel(actor({ hp: { cur: 20, max: 20, temp: 0 } })), "Healthy");
    assert.equal(hpLabel(actor({ hp: { cur: 10, max: 20, temp: 0 } })), "Bloodied");
    assert.equal(hpLabel(actor({ hp: { cur: 11, max: 21, temp: 0 } })), "Healthy");
    assert.equal(hpLabel(actor({ hp: { cur: 10, max: 21, temp: 0 } })), "Bloodied");
    assert.equal(hpLabel(actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying" })), "Dying");
    assert.equal(hpLabel(actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "stable" })), "Dying");
    assert.equal(hpLabel(actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dead" })), "Dead");
  });

  test("hpBar rounds to the nearest 1/20", () => {
    assert.equal(hpBar(actor({ hp: { cur: 7, max: 20, temp: 0 } })), 0.35);
    assert.equal(hpBar(actor({ hp: { cur: 1, max: 3, temp: 0 } })), 0.35);
    assert.equal(hpBar(actor({ hp: { cur: 0, max: 0, temp: 0 } })), 0);
  });

  test("endConcentration drops every concentrating effect with a log line each", () => {
    const a = actor({ effects: [effect("c1", { key: "concentrating", spell: "Bless" }), effect("x", { key: "blessed" })] });
    const r = endConcentration(a);
    assert.deepEqual(r.actor.effects.map((e) => e.id), ["x"]);
    assert.equal(r.events.length, 1);
  });
});

describe("healing brings back the dead (docs/design-v1-combat-flow.md 3.4)", () => {
  const dead = (overrides: Partial<Actor> = {}) =>
    actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dead", deathSaves: { ok: 1, fail: 3 }, effects: [effect("p", { key: "poisoned" })], ...overrides });

  test("a heal with the setting on brings it back at min(max, cur + amount), saves cleared, then the life line", () => {
    const r = applyHeal(dead(), 5, true);
    assert.equal(r.actor.life, "alive");
    assert.equal(r.actor.hp.cur, 5);
    assert.deepEqual(r.actor.deathSaves, { ok: 0, fail: 0 });
    assert.deepEqual(r.events, [
      { type: "hp", change: "heal", amount: 5, label: "Bloodied" },
      { type: "life", life: "alive" },
    ]);
    assert.equal(applyHeal(dead({ hp: { cur: 12, max: 20, temp: 0 } }), 50, true).actor.hp.cur, 20, "capped at the maximum");
  });

  test("conditions applied by hand survive, the 0 HP Unconscious goes, and concentration stays ended", () => {
    const r = applyHeal(dead({ effects: [effect("p", { key: "poisoned" }), effect(ZERO_HP_UNCONSCIOUS_ID, { key: "unconscious" })] }), 3, true);
    assert.deepEqual(r.actor.effects.map((e) => e.id), ["p"]);
    assert.equal(r.events.some((e) => e.type === "concentration"), false);
  });

  test("a maximum of 0 leaves it dead and writes nothing, and with the setting off a heal does nothing", () => {
    const zero = dead({ hp: { cur: 0, max: 0, temp: 0 } });
    assert.equal(applyHeal(zero, 5, true).actor, zero);
    assert.deepEqual(applyHeal(zero, 5, true).events, []);
    const corpse = dead();
    assert.equal(applyHeal(corpse, 5, false).actor, corpse);
    assert.deepEqual(applyHeal(corpse, 5).events, []);
  });

  test("with it on, a set of a current HP above 0 brings it back at that HP, the set line first, and an over-cap set at the maximum", () => {
    const r = applyHpSet(dead(), { cur: 7 }, "monster", settings, true);
    assert.equal(r.actor.life, "alive");
    assert.equal(r.actor.hp.cur, 7);
    assert.deepEqual(r.actor.deathSaves, { ok: 0, fail: 0 });
    assert.deepEqual(r.events, [
      { type: "hp", change: "set", amount: 7, label: "Bloodied" },
      { type: "life", life: "alive" },
    ]);
    const over = applyHpSet(dead(), { cur: 99 }, "monster", settings, true).actor;
    assert.deepEqual([over.life, over.hp.cur], ["alive", 20]);
  });

  test("with it on, a set that clamps to 0, of the maximum alone or of temporary HP alone leaves it dead", () => {
    assert.equal(applyHpSet(dead(), { cur: 0 }, "monster", settings, true).actor.life, "dead");
    assert.equal(applyHpSet(dead({ hp: { cur: 0, max: 0, temp: 0 } }), { cur: 5 }, "monster", settings, true).actor.life, "dead");
    assert.equal(applyHpSet(dead(), { max: 30 }, "monster", settings, true).actor.life, "dead");
    assert.equal(applyHpSet(dead(), { temp: 5 }, "monster", settings, true).actor.life, "dead");
    const holding = applyHpSet(dead({ hp: { cur: 12, max: 20, temp: 0 } }), { max: 30 }, "monster", settings, true);
    assert.deepEqual([holding.actor.life, holding.actor.hp.cur], ["dead", 12], "a dead creature holding HP stays dead under a set of the maximum");
  });

  test("with it off, a set on the dead changes the HP, keeps it dead and writes the set line, as before", () => {
    const r = applyHpSet(dead(), { cur: 9 }, "monster", settings, false);
    assert.equal(r.actor.life, "dead");
    assert.equal(r.actor.hp.cur, 9);
    assert.deepEqual(r.events, [{ type: "hp", change: "set", amount: 9, label: "Dead" }]);
  });

  test("a dying or stable creature heals as before either way", () => {
    const dying = applyDamage(actor(), 20, "pc", settings).actor;
    for (const revives of [true, false]) {
      const healed = applyHeal(dying, 4, revives);
      assert.deepEqual([healed.actor.life, healed.actor.hp.cur], ["alive", 4]);
      const stable = actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "stable", effects: [effect("manual", { key: "frightened" })] });
      const up = applyHeal(stable, 2, revives).actor;
      assert.deepEqual([up.life, up.effects.map((e) => e.id)], ["alive", ["manual"]]);
      assert.equal(applyHpSet(dying, { cur: 3 }, "pc", settings, revives).actor.life, "alive");
    }
  });
});

describe("Revive gives exactly 1 HP (docs/design-v1-combat-flow.md 3.5)", () => {
  test("a dead creature holding 12 HP comes back at 1 with reviveToOne, and keeps 12 without", () => {
    const dead = actor({ hp: { cur: 12, max: 20, temp: 0 }, life: "dead", deathSaves: { ok: 0, fail: 3 }, effects: [effect("p", { key: "poisoned" })] });
    const now = applyLife(dead, "alive", true);
    assert.deepEqual([now.actor.life, now.actor.hp.cur, now.actor.deathSaves], ["alive", 1, { ok: 0, fail: 0 }]);
    assert.deepEqual(now.actor.effects.map((e) => e.id), ["p"], "every condition applied by hand stays");
    assert.deepEqual(now.events, [{ type: "life", life: "alive" }]);
    assert.equal(applyLife(dead, "alive", false).actor.hp.cur, 12);
  });

  test("a dying creature at 0 gets 1 either way, and an alive creature keeps its HP either way", () => {
    const dying = applyDamage(actor(), 20, "pc", settings).actor;
    assert.equal(applyLife(dying, "alive", true).actor.hp.cur, 1);
    assert.equal(applyLife(dying, "alive", false).actor.hp.cur, 1);
    const hurt = actor({ hp: { cur: 7, max: 20, temp: 0 } });
    assert.equal(applyLife(hurt, "alive", true).actor.hp.cur, 7);
    assert.equal(applyLife(hurt, "alive", false).actor.hp.cur, 7);
  });
});

describe("hpLess (docs/design-v1-combat-flow.md 3.6.6)", () => {
  const companion = { of: "c1", turn: "none" as const };
  test("an effect companion and any actor at max HP 0", () => {
    assert.equal(hpLess(actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0 }), { kind: "object", companion }), true);
    assert.equal(hpLess(actor(), { kind: "object", companion }), true, "an effect whatever its actor stores");
    const empty = actor({ hp: { cur: 0, max: 0, temp: 0 } });
    assert.equal(hpLess(empty, { kind: "pc" }), true, "a character-linked token, through its character's actor");
    assert.equal(hpLess(empty), true, "a character card with no token");
    assert.equal(hpLess(empty, { kind: "npc", companion: { of: "c1", turn: "shared" } }), true, "a creature companion at 0");
  });

  test("not an ordinary object with HP, a partial actor without hp, hidden HP, or an effect whose companion the caller lacks", () => {
    assert.equal(hpLess(actor({ hp: { cur: 5, max: 10, temp: 0 } }), { kind: "object" }), false);
    assert.equal(hpLess({}, { kind: "monster" }), false, "a projected actor with no hp");
    assert.equal(hpLess({ hpLabel: "Healthy" } as { hp?: Actor["hp"] }, { kind: "monster" }), false, "hidden HP is not HP-less");
    assert.equal(hpLess(undefined, { kind: "monster" }), false);
    assert.equal(hpLess({}, { kind: "object" }), false, "an effect token without its companion field");
    assert.equal(hpLess(actor(), { kind: "npc", companion }), false, "a creature companion with HP");
  });
});
