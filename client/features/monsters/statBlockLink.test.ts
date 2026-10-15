import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { monsterView } from "#shared/statBlock.ts";
import { actor, customMonster, DM, env, P1, room, token } from "#shared/testutil.ts";
import { attachPatch, DETACH_PATCH, nameSuggestions, statBlockFoldable, statBlockShown, tokenStatBlock } from "./statBlockLink.ts";

describe("which stat block a token links to", () => {
  test("a room monster's link wins, an SRD id is read next, and a deleted monster says so", () => {
    const monsters = { m1: customMonster("m1") };
    assert.deepEqual(tokenStatBlock({ monsterId: "m1" }, monsters), { kind: "room", monster: monsters.m1 });
    assert.deepEqual(tokenStatBlock({ monsterId: "m1", srdId: "goblin-warrior" }, monsters).kind, "room");
    assert.deepEqual(tokenStatBlock({ srdId: "goblin-warrior" }, monsters), { kind: "srd", srdId: "goblin-warrior" });
    assert.deepEqual(tokenStatBlock({ monsterId: "gone" }, monsters), { kind: "deleted", monsterId: "gone" });
    assert.deepEqual(tokenStatBlock({}, monsters), { kind: "none" });
    assert.deepEqual(tokenStatBlock(undefined, undefined), { kind: "none" });
  });

  test("only a block that shows folds, so a deleted monster's note has no Hide that does nothing (LP5-ROLLS-9)", () => {
    const monsters = { m1: customMonster("m1") };
    assert.equal(statBlockFoldable(tokenStatBlock({ monsterId: "m1" }, monsters)), true);
    assert.equal(statBlockFoldable(tokenStatBlock({ srdId: "wolf" }, monsters)), true);
    assert.equal(statBlockFoldable(tokenStatBlock({ monsterId: "gone" }, monsters)), false);
    assert.equal(statBlockFoldable(tokenStatBlock({}, monsters)), false);
  });

  test("the DM reads it on monsters and NPCs, an owner only an SRD monster they play", () => {
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "monster", actor: {} }), true);
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "npc", actor: {} }), true);
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "pc", actor: { srdId: "wolf" } }), false);
    assert.equal(statBlockShown({ dm: true, owner: false, kind: "object", actor: {} }), false);
    assert.equal(statBlockShown({ dm: false, owner: true, kind: "monster", actor: { srdId: "brown-bear" } }), true, "a druid's Wild Shape");
    assert.equal(statBlockShown({ dm: false, owner: true, kind: "monster", actor: {} }), false);
    assert.equal(statBlockShown({ dm: false, owner: false, kind: "monster", actor: { srdId: "goblin-warrior" } }), false);
  });

  test("the attach picker suggests the room's own and the SRD's of exactly the token's name, the room's first", () => {
    const lurker = customMonster("m1", { name: "Cave Lurker" });
    const other = customMonster("m2", { name: "Cave Lurker King" });
    const room = [lurker, other].map((monster) => ({ monster, view: monsterView(monster) }));
    const srd = [{ ...monsterView(customMonster("x", { name: "Cave lurker" })), srdId: "cave-lurker" }, { ...monsterView(customMonster("y", { name: "Goblin" })), srdId: "goblin" }];
    assert.deepEqual(
      nameSuggestions(" cave LURKER ", room, srd).map((s) => s.link),
      [{ monsterId: "m1" }, { srdId: "cave-lurker" }],
    );
    assert.deepEqual(nameSuggestions("", room, srd), []);
    assert.deepEqual(nameSuggestions("Lurker", room, srd), []);
  });
});

describe("attaching and detaching", () => {
  function setup() {
    const state = room({ tokens: { g1: token("g1", { name: "Snik", actor: { inline: actor({ srdId: "goblin-warrior", hp: { cur: 3, max: 10, temp: 0 } }) }, ownerIds: ["p1"] }) } });
    state.monsters.m1 = customMonster("m1");
    return state;
  }
  const inline = (t: Token | undefined) => (t && "inline" in t.actor ? t.actor.inline : assert.fail("an inline actor"));

  test("each is one DM patch that sets only the link, never the token's numbers", () => {
    let state = setup();
    for (const patch of [attachPatch({ monsterId: "m1" }), attachPatch({ srdId: "goblin-boss" }), DETACH_PATCH]) {
      assert.ok(clientOpSchema.safeParse({ t: "token.update", tokenId: "g1", patch: { actor: patch } }).success);
    }
    let r = applyOp(state, { t: "token.update", tokenId: "g1", patch: { actor: attachPatch({ monsterId: "m1" }) } }, DM, env(1));
    assert.ok(r.ok);
    state = r.state;
    assert.equal(inline(state.tokens.g1).monsterId, "m1");
    assert.equal("srdId" in inline(state.tokens.g1), false, "one block at a time");
    assert.deepEqual(inline(state.tokens.g1).hp, { cur: 3, max: 10, temp: 0 }, "the token keeps its own HP");
    r = applyOp(state, { t: "token.update", tokenId: "g1", patch: { actor: DETACH_PATCH } }, DM, env(2));
    assert.ok(r.ok);
    assert.equal("monsterId" in inline(r.state.tokens.g1), false);
    assert.equal(tokenStatBlock(inline(r.state.tokens.g1), r.state.monsters).kind, "none");
  });

  test("an owner can neither attach nor detach, and never receives the room monster's link", () => {
    let state = setup();
    const deps = { canUseAsset: () => true };
    for (const patch of [attachPatch({ monsterId: "m1" }), attachPatch({ srdId: "goblin-boss" }), DETACH_PATCH]) {
      assert.equal(canApply({ t: "token.update", tokenId: "g1", patch: { actor: patch } }, P1, state, deps).ok, false);
      assert.equal(canApply({ t: "token.update", tokenId: "g1", patch: { actor: patch } }, DM, state, deps).ok, true);
    }
    const linked = applyOp(state, { t: "token.update", tokenId: "g1", patch: { actor: attachPatch({ monsterId: "m1" }) } }, DM, env(1));
    assert.ok(linked.ok);
    state = linked.state;
    const seen = projectState(state, P1, { sceneId: null }).tokens.g1;
    assert.ok(seen && "inline" in seen.actor);
    assert.equal("monsterId" in seen.actor.inline, false);
    assert.equal(statBlockShown({ dm: false, owner: true, kind: "monster", actor: seen.actor.inline }), false, "so no room monster's block shows for the owner");
  });
});
