import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "../model.ts";
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
