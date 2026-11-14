import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HIDDEN_EFFECTS_FULL } from "../limits.ts";
import type { Effect, RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import { applyOp } from "../reducer.ts";
import { AUTOMATIC_NEEDS_ID } from "../reducer/actors.ts";
import { actor, AT, character, DM, effect, P1, room, token } from "../testutil.ts";
import { CONVERTED_EFFECT_ID, EFFECTS_PER_CLASS, convertedEffectId, effectsFit, effectsFitAt, normalEffects } from "./effects.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "./hp.ts";
import type { Op } from "../protocol.ts";

const HOLDER = "character:c1";

function hero(effects: Effect[], hp = 20): RoomState {
  return room({
    characters: { c1: character("c1", { ownerIds: ["p1"], actor: actor({ effects, hp: { cur: hp, max: 20, temp: 0 } }) }) },
    tokens: { hero: token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"] }) },
  });
}

function shown(count: number, from = 0): Effect[] {
  return Array.from({ length: count }, (_, i) => effect(`s${from + i}`, { key: "blessed" }));
}

function hidden(count: number): Effect[] {
  return Array.from({ length: count }, (_, i) => effect(`h${i}`, { key: "custom", label: "Marked", hiddenFromPlayers: true }));
}

function run(state: RoomState, op: Op, who = DM, opVersion?: number) {
  return applyOp(state, op, who, { seq: 9, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
}

const add = (id: string, extra: Partial<Effect> = {}): Op => ({ t: "actor.effect.add", target: { characterId: "c1" }, effect: { id, key: "blessed", ...extra } as never });
const effectsOf = (state: RoomState) => state.characters.c1!.actor.effects;

describe("conditions by class", () => {
  test("a player's add reads the shown count alone: one hidden more or less answers the same", () => {
    for (const extra of [0, 1, EFFECTS_PER_CLASS]) {
      const state = hero([...shown(EFFECTS_PER_CLASS - 1), ...hidden(extra)]);
      const taken = run(state, add("new1"), P1);
      assert.ok(taken.ok, `with ${extra} hidden`);
      const full = run(taken.state, add("new2"), P1);
      assert.deepEqual(full.ok ? null : [full.code, full.message], ["quota", `at most ${EFFECTS_PER_CLASS} effects per creature`], `with ${extra} hidden`);
    }
  });

  test("the DM's 33rd hidden is refused in its own words, and both classes full with the automatic one store 65, damage taken", () => {
    const state = hero([...shown(EFFECTS_PER_CLASS), ...hidden(EFFECTS_PER_CLASS)]);
    const more = run(state, add("h99", { hiddenFromPlayers: true }));
    assert.deepEqual(more.ok ? null : [more.code, more.message], ["quota", HIDDEN_EFFECTS_FULL]);
    const down = run(state, { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 25 } });
    assert.ok(down.ok);
    assert.equal(effectsOf(down.state).length, 2 * EFFECTS_PER_CLASS + 1);
    assert.equal(effectsOf(down.state).at(-1)?.id, ZERO_HP_UNCONSCIOUS_ID);
  });

  test("an older op still counts every condition together, as it ran", () => {
    const state = hero([...shown(EFFECTS_PER_CLASS - 1), ...hidden(1)]);
    const old = run(state, add("new1"), DM, 60);
    assert.equal(old.ok, false);
  });
});

describe("the automatic Unconscious", () => {
  test("at 0 HP a hidden Unconscious does not stand in for it, a shown one does", () => {
    const withHidden = run(hero([effect("u1", { key: "unconscious", hiddenFromPlayers: true })]), { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 25 } });
    assert.ok(withHidden.ok);
    assert.deepEqual(effectsOf(withHidden.state).map((e) => e.id), ["u1", ZERO_HP_UNCONSCIOUS_ID]);
    const p1 = projectState(withHidden.state, P1, { sceneId: null });
    assert.deepEqual(p1.characters.c1?.actor.effects.map((e) => e.id), [ZERO_HP_UNCONSCIOUS_ID], "its owner sees the bare one, as without the hidden one");
    const withShown = run(hero([effect("u1", { key: "unconscious" })]), { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 25 } });
    assert.ok(withShown.ok);
    assert.deepEqual(effectsOf(withShown.state).map((e) => e.id), ["u1"]);
    const old = run(hero([effect("u1", { key: "unconscious", hiddenFromPlayers: true })]), { t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 25 } }, DM, 60);
    assert.ok(old.ok);
    assert.deepEqual(effectsOf(old.state).map((e) => e.id), ["u1"], "an older op replays as it ran");
  });

  test("hiding or editing it takes a fresh id, and it goes on as an ordinary condition", () => {
    const down = hero([effect(ZERO_HP_UNCONSCIOUS_ID, { key: "unconscious" })], 0);
    down.characters.c1!.actor.life = "dying";
    const hide = { t: "actor.effect.update", target: { characterId: "c1" }, effectId: ZERO_HP_UNCONSCIOUS_ID, patch: { hiddenFromPlayers: true } } as const;
    const bare = run(down, hide);
    assert.deepEqual(bare.ok ? null : [bare.code, bare.message], ["invalid", AUTOMATIC_NEEDS_ID]);
    const hidden1 = run(down, { ...hide, as: "fresh1" });
    assert.ok(hidden1.ok);
    assert.deepEqual(effectsOf(hidden1.state), [{ id: "fresh1", key: "unconscious", hiddenFromPlayers: true }]);
    const wrong = run(hero([effect("e1")]), { t: "actor.effect.update", target: { characterId: "c1" }, effectId: "e1", patch: { label: "x" }, as: "fresh2" });
    assert.equal(wrong.ok, false, "only the automatic one takes `as`");
    const owner = run(down, { t: "actor.effect.update", target: { characterId: "c1" }, effectId: ZERO_HP_UNCONSCIOUS_ID, patch: { label: "Knocked out" }, as: "fresh3" }, P1);
    assert.ok(owner.ok, "an owner's edit too");
    assert.deepEqual(effectsOf(owner.state), [{ id: "fresh3", key: "unconscious", label: "Knocked out" }]);
  });

  test("a writer that puts back a hidden or edited automatic one stores it under its converted id, and never a second", () => {
    const hiddenAuto: Effect = { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious", hiddenFromPlayers: true };
    const out = normalEffects(HOLDER, [effect("a"), hiddenAuto]);
    assert.equal(out[1]?.id, convertedEffectId(HOLDER, ZERO_HP_UNCONSCIOUS_ID));
    assert.deepEqual(normalEffects(HOLDER, [{ id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" }, { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" }]).length, 1);
    const fit = effectsFitAt(HOLDER, [effect("a")], 0, hiddenAuto);
    assert.ok(fit.ok && fit.effects[0]!.id === convertedEffectId(HOLDER, ZERO_HP_UNCONSCIOUS_ID));
    assert.ok(effectsFit(HOLDER, [], [{ id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" }]).ok);
  });

  test("a restore that brings back a hidden automatic Unconscious stores it under its converted id", () => {
    const state = hero([]);
    const back = { ...state.characters.c1!, actor: { ...state.characters.c1!.actor, effects: [{ id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" as const, hiddenFromPlayers: true }] } };
    const r = run(state, { t: "sys.restore", entries: [{ key: "character:c1", value: back }], from: "undo" });
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.deepEqual(effectsOf(r.state).map((e) => e.id), [convertedEffectId(HOLDER, ZERO_HP_UNCONSCIOUS_ID)]);
    const old = run(state, { t: "sys.restore", entries: [{ key: "character:c1", value: back }], from: "undo" }, DM, 60);
    assert.ok(old.ok && effectsOf(old.state)[0]!.id === ZERO_HP_UNCONSCIOUS_ID, "an older op replays as stored");
  });

  test("a converted id is 81 characters of a fixed form, the same each time, apart for each creature, and never version 7", () => {
    const id = convertedEffectId(HOLDER, ZERO_HP_UNCONSCIOUS_ID);
    assert.equal(id.length, 81);
    assert.match(id, CONVERTED_EFFECT_ID);
    assert.equal(convertedEffectId(HOLDER, ZERO_HP_UNCONSCIOUS_ID), id);
    assert.notEqual(convertedEffectId("character:c2", ZERO_HP_UNCONSCIOUS_ID), id);
    assert.notEqual(convertedEffectId("token:c1", ZERO_HP_UNCONSCIOUS_ID), id);
    assert.doesNotMatch(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });
});
