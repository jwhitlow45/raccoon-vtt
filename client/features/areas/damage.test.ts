import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, env, room, token } from "#shared/testutil.ts";
import { damageOp, damageTargets, dealt, defaultResult, parseDamage } from "./damage.ts";

function setup() {
  const state = room();
  state.characters.c1 = character("c1", { name: "Ayla", actor: actor({ hp: { cur: 20, max: 20, temp: 5 } }) });
  state.tokens.pc1 = token("pc1", { kind: "pc", name: "Ayla", actor: { ref: "c1" } });
  // A second token of the same character, such as one left on the map by mistake: one creature.
  state.tokens.pc1b = token("pc1b", { kind: "pc", name: "Ayla", actor: { ref: "c1" } });
  state.tokens.g1 = token("g1", { name: "Goblin", number: 1, actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } });
  state.tokens.g2 = token("g2", { name: "Goblin", number: 2, visibility: "dm", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } });
  state.tokens.g3 = token("g3", { name: "Goblin", number: 3, actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, life: "dead" }) } });
  return state;
}

describe("damage in an area", () => {
  test("a save halves the damage, rounded down, and none leaves a creature out", () => {
    assert.equal(dealt(27, "fail"), 27);
    assert.equal(dealt(27, "pass"), 13);
    assert.equal(dealt(1, "pass"), 0);
    assert.equal(dealt(27, "none"), 0);
  });

  test("each creature once, the living first, hidden ones marked for the DM", () => {
    const s = setup();
    const targets = damageTargets(["g3", "pc1", "g2", "pc1b", "g1", "gone"], s.tokens, s.characters);
    assert.deepEqual(
      targets.map((t) => [t.name, t.hidden, t.dead]),
      [
        ["Ayla", false, false],
        ["Goblin 1", false, false],
        ["Goblin 2", true, false],
        ["Goblin 3", false, true],
      ],
    );
    assert.deepEqual(targets[0]!.hp, { cur: 20, max: 20, temp: 5 });
    assert.equal(defaultResult(targets[3]!), "none");
    assert.equal(defaultResult(targets[0]!), "fail");
  });

  test("an object is listed after the creatures and skipped until the DM marks it", () => {
    const s = setup();
    s.tokens.cart = token("cart", { kind: "object", name: "Cart", actor: { inline: actor({ hp: { cur: 10, max: 10, temp: 0 } }) } });
    const targets = damageTargets(["cart", "g1"], s.tokens, s.characters);
    assert.deepEqual(
      targets.map((t) => [t.name, t.object]),
      [
        ["Goblin 1", false],
        ["Cart", true],
      ],
    );
    assert.equal(defaultResult(targets[1]!), "none");
    assert.deepEqual(damageOp(targets, {}, 14)?.hits, [{ target: { tokenId: "g1" }, amount: 14 }]);
    assert.deepEqual(damageOp(targets, { cart: "fail" }, 14)?.hits.length, 2);
  });

  test("one op for everyone hit, which the reducer applies in one step with temporary HP first", () => {
    const s = setup();
    const targets = damageTargets(["pc1", "g1", "g2", "g3"], s.tokens, s.characters);
    const op = damageOp(targets, { pc1: "pass", g2: "none" }, 14);
    assert.deepEqual(op, {
      t: "actor.damageMany",
      hits: [
        { target: { tokenId: "pc1" }, amount: 7 },
        { target: { tokenId: "g1" }, amount: 14 },
      ],
    });
    assert.ok(clientOpSchema.safeParse(op).success);
    const r = applyOp(s, op!, DM, env(1));
    assert.ok(r.ok);
    assert.deepEqual(r.state.characters.c1!.actor.hp, { cur: 18, max: 20, temp: 0 });
    assert.equal(damageOp(targets, { pc1: "none", g1: "none", g2: "none" }, 14), null);
  });

  test("the damage is a number or a sum", () => {
    assert.deepEqual(parseDamage("28"), { ok: true, amount: 28 });
    assert.deepEqual(parseDamage("8+6+14"), { ok: true, amount: 28 });
    assert.deepEqual(parseDamage("-28"), { ok: true, amount: 28 });
    assert.equal(parseDamage("").ok, false);
    assert.equal(parseDamage("+5").ok, false);
    assert.equal(parseDamage("=20").ok, false);
    assert.equal(parseDamage("fire").ok, false);
  });
});
