import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OP_VERSION, migrateOp, opMigrations, runMigrations } from "../migrate.ts";
import type { Actor, RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import { clientOpSchema, type OpOf } from "../protocol.ts";
import { reads } from "../reads.ts";
import { applyOp } from "../reducer.ts";
import { actor, character, companionBlock, customMonster, DM, env, P1, room, token } from "../testutil.ts";
import { EMPTY_PC_STATS } from "../rules/pcStats.ts";
import { blockDefenses } from "../dice/defenses.ts";
import { loadMonsters } from "../srd/monsters.ts";
import srdDefenses from "../srd/damage-defenses.json" with { type: "json" };

const hit = (amount = 14, parts: unknown = [{ amount: 10, type: "fire" }, { amount: 4, type: "cold" }]) => ({
  t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount, parts },
}) as OpOf<"actor.hp">;

function fixture(overrides: Partial<Actor> = {}): RoomState {
  const state = room({
    monsters: { monster: customMonster("monster", { resistances: "Fire", vulnerabilities: "Cold", immunities: "Poison" }) },
    tokens: { target: token("target", { actor: { inline: actor({ monsterId: "monster", hp: { cur: 50, max: 50, temp: 3 }, ...overrides }) } }) },
  });
  state.meta.settings.playersApplyDamage = true;
  return state;
}

function applied(state = fixture(), op = hit(), opVersion?: number) {
  const result = applyOp(state, op, P1, { ...env(1), ...(opVersion === undefined ? {} : { opVersion }) });
  assert.ok(result.ok, result.ok ? "" : result.message);
  const target = result.state.tokens.target!;
  assert.ok("inline" in target.actor);
  return { state: result.state, actor: target.actor.inline };
}

describe("FL-3 typed damage on the server", () => {
  test("each type meets its own defense before temporary HP, even when the player holds no defenses", () => {
    const { actor: result, state } = applied();
    assert.deepEqual(result.hp, { cur: 40, max: 50, temp: 0 }, "5 Fire + 8 Cold, then 3 temporary HP");
    assert.deepEqual(result.hurt, ["cold", "fire"]);
    const view = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(view.monsters, {});
    const data = view.log.filter((line) => line.data?.type === "hp").map((line) => line.data);
    assert.equal(data.length, 1);
    assert.equal(data[0]?.type === "hp" ? data[0].amount : null, undefined);
    assert.doesNotMatch(JSON.stringify(view), /Resists|Vulnerable|Immune|monsterId/);
  });

  test("immunity and rounding remove types, and an immune hit changes neither HP nor death saves", () => {
    const state = fixture({ hp: { cur: 0, max: 50, temp: 0 }, life: "dying" });
    const { actor: result } = applied(state, hit(10, [{ amount: 10, type: "poison" }]));
    assert.deepEqual(result.deathSaves, { ok: 0, fail: 0 });
    assert.equal(result.hurt, undefined);
    const tiny = applied(fixture(), hit(11, [{ amount: 1, type: "fire" }, { amount: 10, type: "poison" }]));
    assert.deepEqual(tiny.actor.hp, { cur: 50, max: 50, temp: 3 });
    assert.equal(tiny.actor.hurt, undefined);
  });

  test("an SRD block, a companion block, and conditions supply the same defenses as saves", () => {
    const dragon = applied(fixture({ monsterId: undefined, srdId: "adult-red-dragon" }), hit(10, [{ amount: 10, type: "fire" }]));
    assert.equal(dragon.actor.hp.cur, 50);
    const state = fixture({ monsterId: undefined, blockId: "block", effects: [{ id: "stone", key: "petrified" }] });
    state.characters.pc = character("pc");
    state.companionBlocks.block = companionBlock("block", "pc", { vulnerabilities: "Cold" });
    const result = applied(state, hit(9, [{ amount: 9, type: "cold" }]));
    assert.equal(result.actor.hp.cur, 45, "floor(9 / 2) * 2 = 8, then temporary HP");
  });

  test("the compact SRD defenses match every source block", async () => {
    const monsters = await loadMonsters();
    assert.deepEqual(srdDefenses, Object.fromEntries(monsters.map((monster) => [monster.srdId, blockDefenses(monster)])));
  });

  test("a character and its token share PC defenses, replaced by its creature's in a shape", () => {
    for (const shape of [undefined, "adult-red-dragon"]) {
      for (const target of [{ characterId: "pc" }, { tokenId: "target" }]) {
        const state = fixture();
        state.characters.pc = character("pc", { stats: { ...EMPTY_PC_STATS, defenses: { fire: "resistant" } }, actor: actor({ srdId: shape }) });
        state.tokens.target!.actor = { ref: "pc" };
        const result = applyOp(state, { ...hit(10, [{ amount: 10, type: "fire" }]), target }, P1, env(1));
        assert.ok(result.ok);
        assert.equal(result.state.characters.pc!.actor.hp.cur, shape ? 20 : 15);
      }
    }
  });

  test("concentration uses the one adjusted hit, and only viewers with exact HP receive its amount", () => {
    const { state, actor: result } = applied(fixture({ effects: [{ id: "spell", key: "concentrating" }] }), hit(50, [{ amount: 40, type: "fire" }, { amount: 10, type: "cold" }]));
    assert.equal(result.hp.cur, 13);
    const concentration = state.log.filter((line) => line.data?.type === "concentration");
    assert.equal(concentration.length, 1);
    assert.equal(concentration[0]?.data?.type === "concentration" ? concentration[0].data.dc : null, 20);
    const visible = projectState(state, DM, { sceneId: "s1" });
    const hp = visible.log.find((line) => line.data?.type === "hp");
    assert.equal(hp?.data?.type === "hp" ? hp.data.amount : null, 40);
    for (const hpVisibility of ["hidden", "label", "bar", "exact"] as const) {
      const before = fixture();
      before.tokens.target!.hpVisibility = hpVisibility;
      const after = applied(before, hit(50, [{ amount: 40, type: "fire" }, { amount: 10, type: "cold" }]));
      const player = projectState(after.state, P1, { sceneId: "s1" });
      const line = player.log.find((line) => line.data?.type === "hp");
      assert.equal(line?.data?.type === "hp" ? line.data.amount : undefined, hpVisibility === "exact" ? 40 : undefined);
      assert.doesNotMatch(JSON.stringify(player), /Resists|Vulnerable|Immune|monsterId/);
    }
  });

  test("qualified defenses stay off without the save flow's explicit switch", () => {
    const state = fixture();
    state.monsters.monster!.resistances = "Fire from Nonmagical Attacks";
    const result = applied(state, hit(10, [{ amount: 10, type: "fire" }]));
    assert.equal(result.actor.hp.cur, 43);
  });

  test("plain amounts and recorded type tags stay final amounts in both old and live ops", () => {
    const old: OpOf<"actor.hp"> = { t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount: 10, types: ["fire"] } };
    assert.equal(migrateOp(old, 30), old);
    assert.deepEqual(applied(fixture(), old, 30), applied(fixture(), old));
    assert.equal(applied(fixture(), old).actor.hp.cur, 43);
  });

  test("typed hits wait for authoritative results even when exact HP is visible", () => {
    assert.deepEqual(reads(hit(), fixture()), { never: true });
  });

  test("typed damage has an identity op migration and never migrates down", () => {
    assert.equal(OP_VERSION, 31);
    const op = hit();
    assert.equal(runMigrations(op, 30, 31, opMigrations), op);
    assert.throws(() => runMigrations(op, 31, 30, opMigrations), /down/);
  });
});

describe("FL-3 typed damage protocol", () => {
  test("accepts bounded parts whose sum equals the incoming amount", () => {
    assert.ok(clientOpSchema.safeParse(hit()).success);
    assert.ok(clientOpSchema.safeParse(hit(10, [{ amount: 6, type: "fire" }, { amount: 4 }])).success);
    assert.ok(clientOpSchema.safeParse(hit(0, [{ amount: 0, type: "fire" }])).success);
  });

  test("rejects ambiguous, invalid and unbounded parts", () => {
    for (const op of [
      hit(13), hit(0, []), hit(1, [{ amount: -1, type: "fire" }]), hit(1, [{ amount: 1.5, type: "fire" }]),
      hit(1, [{ amount: 1, type: "lava" }]), hit(100_001, [{ amount: 100_001, type: "fire" }]),
      hit(101, Array.from({ length: 101 }, () => ({ amount: 1, type: "fire" }))),
      { ...hit(), change: { ...hit().change, types: ["fire"] } },
    ]) assert.equal(clientOpSchema.safeParse(op).success, false, JSON.stringify(op));
  });
});
