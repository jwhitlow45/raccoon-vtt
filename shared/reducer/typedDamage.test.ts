import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OP_VERSION, migrateOp, opMigrations, runMigrations } from "../migrate.ts";
import type { Actor, RoomState } from "../model.ts";
import { lineReach, projectArchivedLog, projectState } from "../project.ts";
import { lineAudience } from "../logRings.ts";
import { clientOpSchema, type OpOf } from "../protocol.ts";
import { reads } from "../reads.ts";
import { applyOp } from "../reducer.ts";
import { actor, character, companionBlock, customMonster, DM, env, P1, P2, room, token } from "../testutil.ts";
import { EMPTY_PC_STATS } from "../rules/pcStats.ts";
import { blockDefenses } from "../dice/defenses.ts";
import { loadMonsters } from "../srd/monsters.ts";
import srdDefenses from "../srd/damage-defenses.json" with { type: "json" };
import { describeEvent } from "../logText.ts";

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
  test("FL3-OPUS-1: damage with no surviving type never stores an empty hurt set", () => {
    for (const parts of [[{ amount: 5 }], [{ amount: 10, type: "poison" }, { amount: 5 }]]) {
      const result = applied(fixture(), hit(parts.reduce((sum, part) => sum + part.amount, 0), parts));
      assert.equal(result.actor.hp.cur, 48);
      assert.equal(result.actor.hurt, undefined);
      const previous = applied(fixture({ hurt: ["cold"] }), hit(parts.reduce((sum, part) => sum + part.amount, 0), parts));
      assert.deepEqual(previous.actor.hurt, ["cold"], "untyped damage keeps earlier recorded types");
    }
  });

  test("FL3-ASTRA-01: whole player projections cannot distinguish small hidden defense probes", () => {
    for (const hpVisibility of ["hidden", "label", "bar"] as const) {
      const views = ["none", "resist", "immune"].map((defense) => {
        let state = fixture({ hp: { cur: 750, max: 1000, temp: 0 } });
        state.tokens.target!.hpVisibility = hpVisibility;
        state.monsters.monster = customMonster("monster", { resistances: defense === "resist" ? "Fire" : "", immunities: defense === "immune" ? "Fire" : "", vulnerabilities: "" });
        const projected = [];
        for (const amount of [1, 2]) {
          const result = applyOp(state, hit(amount, [{ amount, type: "fire" }]), P1, env(amount));
          assert.ok(result.ok);
          state = result.state;
          projected.push([P1, P2].map((viewer) => projectState(state, viewer, { sceneId: "s1" })));
        }
        return projected;
      });
      assert.deepEqual(views[1], views[0], `${hpVisibility}: resistance must not change log presence`);
      assert.deepEqual(views[2], views[0], `${hpVisibility}: immunity must not change log presence`);
      for (const view of views[0]![1]!) assert.equal(view.log.filter((line) => line.data?.type === "hp").length, 2);
    }
  });

  test("FL3-ASTRA-04: visible concentration reveals no hidden defense through whole player projections", () => {
    for (const hpVisibility of ["hidden", "label", "bar"] as const) for (const amount of [1, 10]) for (const owned of [false, true]) {
      const states = ["none", "resist", "immune"].map((defense) => {
        const before = fixture({ hp: { cur: 750, max: 1000, temp: 0 }, effects: [{ id: "spell", key: "concentrating" }] });
        before.tokens.target!.hpVisibility = hpVisibility;
        if (owned) before.tokens.target!.ownerIds = [P2.memberId];
        before.monsters.monster = customMonster("monster", { resistances: defense === "resist" ? "Fire" : "", immunities: defense === "immune" ? "Fire" : "", vulnerabilities: "" });
        return applied(before, hit(amount, [{ amount, type: "fire" }])).state;
      });
      for (const viewer of owned ? [P1] : [P1, P2]) {
        const views = states.map((state) => projectState(state, viewer, { sceneId: "s1" }));
        assert.deepEqual(views[1], views[0], `${viewer.memberId}, ${hpVisibility}, ${amount}: resistance`);
        assert.deepEqual(views[2], views[0], `${viewer.memberId}, ${hpVisibility}, ${amount}: immunity`);
        assert.ok(views[0]!.tokens.target!.actor && "inline" in views[0]!.tokens.target!.actor);
        assert.deepEqual(views[0]!.tokens.target!.actor.inline.effects, [{ id: "spell", key: "concentrating" }]);
        assert.equal(views[0]!.log.filter((line) => line.data?.type === "concentration").length, 0);
      }
      for (const viewer of owned ? [DM, P2] : [DM]) {
        const checks = states.map((state) => projectState(state, viewer, { sceneId: "s1" }).log.filter((line) => line.data?.type === "concentration"));
        assert.deepEqual(checks.map((lines) => lines.length), [1, amount === 1 ? 0 : 1, 0], `${viewer.memberId} keeps the real checks`);
        assert.equal(checks[0]![0]!.data?.type === "concentration" ? checks[0]![0]!.data.dc : null, 10);
      }
    }
  });

  test("FL3-ASTRA-04: a typed check keeps its write-time audience and narrows when HP access is lost", () => {
    for (const hpVisibility of ["hidden", "exact"] as const) {
      const before = fixture({ effects: [{ id: "spell", key: "concentrating" }] });
      before.tokens.target!.ownerIds = [P2.memberId];
      before.tokens.target!.hpVisibility = hpVisibility;
      const { state } = applied(before, hit(10, [{ amount: 10, type: "fire" }]));
      const dm = projectState(state, DM, { sceneId: "s1" }).log.find((line) => line.data?.type === "concentration")!;
      assert.ok(dm.data?.type === "concentration");
      assert.equal(dm.data.exact, true);
      assert.equal(lineReach(state, dm).audience, hpVisibility === "hidden" ? "party" : "shared");
      assert.equal(lineAudience(dm), hpVisibility === "hidden" ? "dm" : "shared");
      if (hpVisibility === "hidden") {
        assert.deepEqual(state.log.filter((line) => line.data?.type === "concentration" && lineAudience(line) === "party").map((line) => line.to), [[P2.memberId]]);
      }
      const narrowed = structuredClone(state);
      narrowed.tokens.target!.ownerIds = [];
      narrowed.tokens.target!.hpVisibility = "label";
      for (const viewer of [P1, P2]) {
        assert.equal(projectState(narrowed, viewer, { sceneId: "s1" }).log.filter((line) => line.data?.type === "concentration").length, 0);
        assert.equal(projectArchivedLog(narrowed, state.log, viewer, { sceneId: "s1" }).filter((line) => line.data?.type === "concentration").length, 0);
      }
      if (hpVisibility === "hidden") {
        const revealed = structuredClone(state);
        revealed.tokens.target!.hpVisibility = "exact";
        assert.equal(projectState(revealed, P1, { sceneId: "s1" }).log.filter((line) => line.data?.type === "concentration").length, 0, "later HP access does not reveal an old check");
      }
    }

    const concentrating = fixture({ effects: [{ id: "spell", key: "concentrating" }] });
    const plain: OpOf<"actor.hp"> = { t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount: 10 } };
    const old = applied(concentrating, plain, 30);
    const current = applied(concentrating, plain);
    assert.deepEqual(current, old, "stored untyped ops keep their behavior");
    assert.equal(projectState(current.state, P1, { sceneId: "s1" }).log.filter((line) => line.data?.type === "concentration").length, 1);
    const ended = applied(concentrating, hit(100, [{ amount: 100, type: "cold" }]));
    const ending = projectState(ended.state, P1, { sceneId: "s1" }).log.find((line) => line.data?.type === "concentration");
    assert.ok(ending?.data?.type === "concentration" && ending.data.ended);
    assert.equal(ending.data.exact, undefined, "losing visible concentration stays public");
    const hidden = fixture({ effects: [{ id: "spell", key: "concentrating", hiddenFromPlayers: true }] });
    hidden.tokens.target!.ownerIds = [P2.memberId];
    const secret = applied(hidden, hit(10, [{ amount: 10, type: "fire" }])).state;
    assert.equal(projectState(secret, P2, { sceneId: "s1" }).log.filter((line) => line.data?.type === "concentration").length, 0, "the owner's exact HP access never reveals a hidden effect");
    assert.equal(projectState(secret, DM, { sceneId: "s1" }).log.filter((line) => line.data?.type === "concentration").length, 1);
  });

  test("FL3-ASTRA-01: a zero hit has a DM line without any actor write, concentration prompt or death save", () => {
    for (const life of ["alive", "dying", "stable"] as const) {
      const before = fixture({ life, hp: { cur: life === "alive" ? 50 : 0, max: 50, temp: 3 }, effects: [{ id: "spell", key: "concentrating" }], deathSaves: { ok: 1, fail: 1 } });
      const { state, actor: after } = applied(before, { ...hit(10, [{ amount: 10, type: "poison" }]), change: { kind: "damage", amount: 10, parts: [{ amount: 10, type: "poison" }], crit: true } });
      assert.deepEqual(state.tokens, before.tokens, "no actor revision or other actor field changes");
      assert.deepEqual(after, "inline" in before.tokens.target!.actor ? before.tokens.target!.actor.inline : null);
      const dm = projectState(state, DM, { sceneId: "s1" });
      assert.equal(dm.log.length, 1);
      const data = dm.log[0]!.data;
      assert.ok(data?.type === "hp");
      assert.deepEqual({ amount: data.amount, label: data.label, left: data.left, crit: data.crit, revert: data.revert }, { amount: 0, label: life === "alive" ? "Healthy" : "Dying", left: after.hp, crit: true, revert: undefined });
      assert.match(describeEvent(data, state, true), /takes 0 damage from a Critical Hit/);
      const player = projectState(state, P1, { sceneId: "s1" });
      const shown = player.log[0]!.data!;
      assert.match(describeEvent(shown, state), /takes damage from a Critical Hit/);
      assert.doesNotMatch(describeEvent(shown, state), /takes 0|Immune|Resists/);
    }
  });

  test("FL3-ASTRA-01: only defenses zeroing a live hit add a line", () => {
    const before = fixture();
    const stopped = applyOp(before, { t: "actor.outcome", plan: "p", targets: [{ target: { tokenId: "target" }, damage: { parts: [{ amount: 2, type: "fire" }], save: { result: "pass", onPass: "half", dex: false, evasion: false } } }] }, DM, env(1));
    assert.ok(stopped.ok);
    assert.equal(stopped.state.log.length, 1, "the save leaves 1, which resistance rounds to 0");
    assert.deepEqual(stopped.state.tokens, before.tokens);
    assert.equal(applied(fixture({ life: "dead" }), hit(10, [{ amount: 10, type: "poison" }])).state.log.length, 0);
    assert.equal(applied(fixture(), hit(0, [{ amount: 0, type: "fire" }])).state.log.length, 0);
    for (const save of [{ result: "pass" as const, onPass: "none" as const, dex: false, evasion: false }, { result: "pass" as const, onPass: "half" as const, dex: true, evasion: true }, { result: "pass" as const, onPass: "half" as const, dex: false, evasion: false }]) {
      const state = fixture();
      const result = applyOp(state, { t: "actor.outcome", plan: "p", targets: [{ target: { tokenId: "target" }, damage: { parts: [{ amount: 1, type: "fire" }], save } }] }, DM, env(1));
      assert.ok(result.ok);
      assert.deepEqual(result.state.log, []);
      assert.deepEqual(result.state.tokens, state.tokens);
    }
  });

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

  test("FL3-OPUS-8: immunity and rounding at 0 HP log the same hit without changing HP or death saves", () => {
    for (const hpVisibility of ["hidden", "label", "bar"] as const) for (const crit of [false, true]) {
      const before = fixture({ hp: { cur: 0, max: 50, temp: 0 }, life: "dying" });
      before.tokens.target!.hpVisibility = hpVisibility;
      const { state, actor: result } = applied(before, { ...hit(), change: { kind: "damage", amount: 10, parts: [{ amount: 10, type: "poison" }], crit } });
      assert.deepEqual(state.tokens, before.tokens);
      assert.deepEqual(result.deathSaves, { ok: 0, fail: 0 });
      assert.equal(result.hurt, undefined);
      assert.equal(state.log.length, 1);
      const data = state.log[0]!.data;
      assert.ok(data?.type === "hp");
      assert.equal(data.amount, 0);
      assert.equal(data.label, "Dying");
      assert.equal(data.revert, undefined);
      const rounded = applied(before, { ...hit(), change: { kind: "damage", amount: 1, parts: [{ amount: 1, type: "fire" }], crit } });
      for (const viewer of [P1, P2]) {
        assert.deepEqual(projectState(state, viewer, { sceneId: "s1" }), projectState(rounded.state, viewer, { sceneId: "s1" }), `${hpVisibility}: no difference between immunity and resistance rounding to 0`);
      }
    }
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
