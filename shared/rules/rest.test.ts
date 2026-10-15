import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, LogEvent } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import { applyOp } from "../reducer.ts";
import { actor, apply, character, DM, env, P1, P2, room, token } from "../testutil.ts";
import { applyRest, REST_NEEDS_HP } from "./rest.ts";

const hurt = (overrides: Partial<Actor> = {}): Actor => actor({ hp: { cur: 5, max: 20, temp: 3 }, ...overrides });

function done(r: ReturnType<typeof applyRest>): { actor: Actor; events: LogEvent[] } {
  assert.ok(!("refused" in r), "refused");
  return r as { actor: Actor; events: LogEvent[] };
}

describe("rests (SRD 5.2.1)", () => {
  test("a short rest gives back the HP the Hit Point Dice rolled, up to the maximum, and nothing else", () => {
    const r = done(applyRest(hurt({ effects: [{ id: "x", key: "exhaustion", level: 2 }] }), "short", 9));
    assert.deepEqual(r.actor.hp, { cur: 14, max: 20, temp: 3 });
    assert.equal(r.actor.effects[0]!.level, 2, "a short rest leaves Exhaustion alone");
    assert.deepEqual(r.events, [{ type: "rest", kind: "short", amount: 9, left: { cur: 14, max: 20, temp: 3 }, label: "Healthy" }]);
    assert.equal(done(applyRest(hurt(), "short", 99)).actor.hp.cur, 20);
    assert.equal(done(applyRest(hurt(), "short")).actor.hp.cur, 5, "spending no dice is still a rest");
  });

  test("a long rest gives back all HP, ends temporary HP, lowers Exhaustion one level and resets X/Day uses", () => {
    const legendary = { actionsMax: 3, actionsUsed: 2, resistMax: 3, resistUsed: 3 };
    const r = done(applyRest(hurt({ legendary, effects: [{ id: "x", key: "exhaustion", level: 3 }, { id: "p", key: "poisoned" }] }), "long"));
    assert.deepEqual(r.actor.hp, { cur: 20, max: 20, temp: 0 });
    assert.deepEqual(r.actor.effects, [{ id: "x", key: "exhaustion", level: 2 }, { id: "p", key: "poisoned" }]);
    assert.deepEqual(r.actor.legendary, { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 });
    assert.deepEqual(r.events, [{ type: "rest", kind: "long", left: { cur: 20, max: 20, temp: 0 }, label: "Healthy" }]);
  });

  test("Exhaustion 1 ends with a long rest, logged as hidden when the condition was", () => {
    const r = done(applyRest(hurt({ effects: [{ id: "x", key: "exhaustion", level: 1, hiddenFromPlayers: true }] }), "long"));
    assert.deepEqual(r.actor.effects, []);
    assert.deepEqual(r.events[1], { type: "effect", key: "exhaustion", action: "remove", hidden: true });
  });

  test("either rest needs at least 1 Hit Point", () => {
    for (const life of ["dying", "stable", "dead"] as const) {
      assert.deepEqual(applyRest(actor({ hp: { cur: 0, max: 20, temp: 0 }, life }), "long"), { refused: REST_NEEDS_HP });
      assert.deepEqual(applyRest(actor({ hp: { cur: 0, max: 20, temp: 0 }, life }), "short", 5), { refused: REST_NEEDS_HP });
    }
  });
});

describe("the rest op", () => {
  function party() {
    const state = room();
    state.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Thorn" });
    state.characters.c1.actor.hp = { cur: 4, max: 20, temp: 2 };
    state.tokens.pc = token("pc", { kind: "pc", name: "Thorn", actor: { ref: "c1" } });
    state.tokens.gob = token("gob", { name: "Goblin", hpVisibility: "label", actor: { inline: hurt() } });
    return state;
  }
  const deps = { canUseAsset: () => true };

  test("the DM rests anyone, and a player only their own creature", () => {
    const state = party();
    const own = { t: "actor.rest" as const, target: { tokenId: "pc" }, kind: "long" as const };
    assert.ok(canApply(own, DM, state, deps).ok);
    assert.ok(canApply(own, P1, state, deps).ok);
    assert.equal(canApply(own, P2, state, deps).ok, false);
    assert.equal(canApply({ t: "actor.rest", target: { tokenId: "gob" }, kind: "short", heal: 3 }, P1, state, deps).ok, false);
    const after = apply(state, own, P1);
    assert.deepEqual(after.characters.c1!.actor.hp, { cur: 20, max: 20, temp: 0 });
    const refused = applyOp(state, { t: "actor.rest", target: { tokenId: "pc" }, kind: "long", heal: 3 }, DM, env(1));
    assert.ok(!refused.ok && refused.code === "invalid");
  });

  test("the DM's undo of a rest puts the creature back as it was", () => {
    const state = party();
    state.characters.c1!.actor.effects = [{ id: "x", key: "exhaustion", level: 1 }];
    const rested = applyOp(state, { t: "actor.rest", target: { characterId: "c1" }, kind: "long" }, DM, env(1));
    assert.ok(rested.ok && rested.inverse);
    const undone = apply(rested.state, { t: "sys.restore", entries: rested.inverse, from: "undo", deps: true }, DM, 2);
    assert.deepEqual({ ...undone.characters.c1!, rev: 0 }, { ...state.characters.c1!, rev: 0 });
  });

  test("everyone who sees the creature reads that it rested, with numbers only where its HP shows them", () => {
    const state = apply(party(), { t: "actor.rest", target: { tokenId: "gob" }, kind: "short", heal: 4 });
    const [owner, other] = [P1, P2].map((v) => projectState(state, v, { sceneId: "s1" }).log.at(-1)!.data);
    assert.deepEqual(owner, { type: "rest", kind: "short", tokenId: "gob", seen: true, label: "Bloodied" });
    assert.deepEqual(other, owner);
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).log.at(-1)!.data, { type: "rest", kind: "short", amount: 4, left: { cur: 9, max: 20, temp: 3 }, label: "Bloodied", tokenId: "gob", seen: true });
    const pc = apply(party(), { t: "actor.rest", target: { characterId: "c1" }, kind: "short", heal: 6 });
    assert.deepEqual(projectState(pc, P2, { sceneId: "s1" }).log.at(-1)!.data, { type: "rest", kind: "short", characterId: "c1", amount: 6, left: { cur: 10, max: 20, temp: 2 }, label: "Bloodied" });
  });
});
