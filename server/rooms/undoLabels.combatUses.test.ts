import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { character, room, token } from "#shared/testutil.ts";
import { describeOp } from "./undoLabels.ts";

function state() {
  return room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon" }),
      lich: token("lich", { name: "Lich" }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }),
    },
    characters: { thorn: character("thorn", { name: "Thorn", resources: [{ id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" }] }) },
  });
}

describe("combat uses' undo step labels (docs/design-v1-combat-controls.md 3.5)", () => {
  test("a use names what it spent or gave back, and for whom", () => {
    const s = state();
    assert.equal(describeOp({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } }, s), "using Fiery Rays for Adult Red Dragon");
    assert.equal(describeOp({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1 } }, s), "using a legendary action for Adult Red Dragon");
    assert.equal(describeOp({ t: "actor.use", target: { tokenId: "lich" }, use: { kind: "resist" } }, s), "using Legendary Resistance for Lich");
    assert.equal(
      describeOp({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 }, back: true }, s),
      "giving back Fire Breath for Adult Red Dragon",
    );
    assert.equal(describeOp({ t: "actor.use", target: { tokenId: "thorn" }, use: { kind: "resource", id: "rage" } }, s), "using Rage for Thorn");
    assert.equal(describeOp({ t: "actor.use", target: { characterId: "thorn" }, use: { kind: "resource", id: "gone" } }, s), "using a class resource for Thorn");
    assert.equal(describeOp({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "regenerate", key: "traits:regeneration", amount: 15, record: 3 } }, s), "Regeneration for Adult Red Dragon");
  });

  test("a prompt's Skip and Reopen name the creature's prompt, and a recharge roll its ability", () => {
    const s = state();
    s.tokens.troll = token("troll", { name: "Troll" });
    assert.equal(describeOp({ t: "actor.prompt", target: { tokenId: "troll" }, record: 3, what: "regeneration", state: "skipped" }, s), "skipping Troll's Regeneration");
    assert.equal(describeOp({ t: "actor.prompt", target: { tokenId: "thorn" }, record: 3, what: "deathSave", state: "open" }, s), "reopening Thorn's death save");
    assert.equal(describeOp({ t: "actor.rechargeRoll", tag: "r1", target: { tokenId: "dragon" }, key: "actions:fire-breath", name: "Fire Breath", min: 5 }, s), "rolling the recharge of Fire Breath for Adult Red Dragon");
  });
});
