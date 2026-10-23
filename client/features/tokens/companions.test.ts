import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { readFileSync } from "node:fs";
import { applyOp } from "#shared/reducer.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { monsterView } from "#shared/statBlock.ts";
import { character, companionBlock, entry, env, imageRef, room, token } from "#shared/testutil.ts";
import {
  NEW_COMPANION,
  blockHpHelp,
  withBlock,
  type ChosenBlock,
  companionInput,
  companionSpot,
  draftError,
  draftWith,
  joinFightOp,
  lateCompanionText,
  linkPatch,
  makeCompanionPatch,
  playerPlacement,
  turnChoices,
  type CompanionDraft,
} from "./companions.ts";

/** Bree, whom Ana (p1) and Cy (p2) play, standing 10 ft up at 5,5 on the players' scene. */
function bree(): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1", "p2"] }) } });
  state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, x: 5, y: 5, elevation: 10 });
  return state;
}

const spirit: CompanionDraft = { ...NEW_COMPANION, name: " Wildfire Spirit ", hp: 15, ac: 13 };
const weapon: CompanionDraft = { ...NEW_COMPANION, name: "Spiritual Weapon", what: "effect", turn: "none" };
const at = { id: "ws", sceneId: "s1", x: 6, y: 5, elevation: 10 };

describe("the companion form (docs/design-v1-combat-flow.md 3.6.3)", () => {
  test("a creature is an NPC with full HP, an effect an object with 0 of 0 HP and AC 0, both allies on the creatures layer, owned as the character, at its elevation", () => {
    const creature = companionInput(spirit, at, bree().characters.bree!);
    assert.equal(creature.kind, "npc");
    assert.equal(creature.name, "Wildfire Spirit");
    assert.ok("inline" in creature.actor);
    assert.deepEqual(creature.actor.inline.hp, { cur: 15, max: 15, temp: 0 });
    assert.equal(creature.actor.inline.ac, 13);
    assert.equal(creature.actor.inline.dmNotes, "");
    assert.deepEqual([creature.disposition, creature.layer, creature.ownerIds, creature.elevation], ["ally", "token", ["p1", "p2"], 10]);
    assert.deepEqual(creature.companion, { of: "bree", turn: "shared" });
    const effect = companionInput(weapon, { ...at, id: "sw" }, bree().characters.bree!);
    assert.equal(effect.kind, "object");
    assert.ok("inline" in effect.actor);
    assert.deepEqual([effect.actor.inline.hp, effect.actor.inline.ac], [{ cur: 0, max: 0, temp: 0 }, 0]);
    assert.deepEqual(effect.companion, { of: "bree", turn: "none" });
    for (const input of [creature, effect]) assert.ok(clientOpSchema.safeParse({ t: "token.create", token: input }).success);
    const bare = companionInput({ ...spirit, ac: null }, at, bree().characters.bree!).actor;
    assert.ok("inline" in bare);
    assert.equal(bare.inline.ac, 0, "an empty AC is stored as 0");
  });

  test("its errors: no name, a creature under 1 HP, an effect with its own turn", () => {
    assert.equal(draftError({ ...spirit, name: "  " }), "Give it a name.");
    assert.equal(draftError({ ...spirit, hp: null }), "A creature needs at least 1 HP.");
    assert.equal(draftError({ ...spirit, hp: 0 }), "A creature needs at least 1 HP.");
    assert.equal(draftError({ ...weapon, turn: "own" }), "An effect takes no turn of its own.");
    assert.equal(draftError(spirit), null);
    assert.equal(draftError(weapon), null, "an effect needs no HP");
  });

  test("the turn's choices name the character, and an effect is offered only Bree's turns", () => {
    assert.deepEqual(turnChoices("Bree", "creature").map((c) => c.label), ["On Bree's turn, listed under Bree", "On Bree's turn, not listed", "Its own turn"]);
    assert.deepEqual(turnChoices("Bree", "effect").map((c) => c.value), ["shared", "none"]);
  });

  test("the turn follows what it is until the user picks one: a creature listed under Bree, an effect not listed (SOL-04)", () => {
    const effect = draftWith(NEW_COMPANION, { what: "effect" });
    assert.equal(effect.turn, "none", "Spiritual Weapon made without touching Turn stays out of the order");
    assert.equal(companionInput({ ...effect, name: "Spiritual Weapon" }, at, bree().characters.bree!).companion?.turn, "none");
    assert.equal(draftWith(effect, { what: "creature" }).turn, "shared", "back to a creature, still unpicked");
    assert.equal(draftWith(effect, { name: "Spiritual Weapon", size: "medium" }).turn, "none", "other fields leave the turn");
    const picked = draftWith(draftWith(NEW_COMPANION, { turn: "shared" }), { what: "effect" });
    assert.equal(picked.turn, "shared", "a turn the user picked stays");
    assert.equal(draftWith(picked, { what: "creature" }).turn, "shared");
    assert.equal(draftWith(draftWith(NEW_COMPANION, { turn: "own" }), { what: "effect" }).turn, "none", "an effect takes no turn of its own");
    assert.equal(draftWith(draftWith(NEW_COMPANION, { what: "effect" }), { turn: "own" }).turn, "none");
  });
});

describe("a creation answer that comes after its form is gone (ASTRA-07)", () => {
  test("says nothing once added, since the token shows on the map, and says why it was not otherwise", () => {
    assert.equal(lateCompanionText("Flaming Sphere", "taken"), null);
    assert.equal(lateCompanionText("Flaming Sphere", "refused", { message: "no room next to Bree" }), "Flaming Sphere was not added. No room next to Bree.");
    assert.equal(lateCompanionText("Flaming Sphere", "refused"), "Flaming Sphere was not added.");
    assert.match(lateCompanionText("Flaming Sphere", "unknown") ?? "", /may not have been added/);
  });
});

describe("where a player's companion goes", () => {
  test("the first free spot within 5 ft of the character, which the server takes", () => {
    const state = bree();
    const spot = companionSpot(state, state.tokens.bt!, { size: "small" });
    assert.deepEqual(spot, { x: 6, y: 5 });
    const placed = playerPlacement(state, state.characters.bree!, { size: "small" });
    assert.ok(placed.ok);
    const op = { t: "token.create" as const, token: companionInput(spirit, { id: "ws", sceneId: placed.sceneId, x: placed.x, y: placed.y, elevation: placed.elevation }, state.characters.bree!) };
    assert.ok(canApply(op, { memberId: "p1", role: "player" }, state, { canUseAsset: () => true }).ok);
  });

  test("taken spots are passed over, and none when every spot is taken or walled off", () => {
    const state = bree();
    state.tokens.east = token("east", { x: 6, y: 5 });
    assert.deepEqual(companionSpot(state, state.tokens.bt!, { size: "small" }), { x: 6, y: 6 });
    for (const [x, y] of [[4, 4], [5, 4], [6, 4], [4, 5], [6, 6], [4, 6], [5, 6]]) state.tokens[`t${x}${y}`] = token(`t${x}${y}`, { x: x!, y: y! });
    assert.equal(companionSpot(state, state.tokens.bt!, { size: "small" }), null);
    assert.deepEqual(playerPlacement(state, state.characters.bree!, { size: "small" }), { ok: false, reason: "No room next to Bree." });
    const walled = bree();
    walled.scenes.s1 = { ...walled.scenes.s1!, blockMovement: true };
    // A box of walls around Bree's cell.
    walled.buildChunks[chunkKey("s1", 0, 0)] = {
      sceneId: "s1",
      cx: 0,
      cy: 0,
      rev: 0,
      cells: {},
      edges: {},
      walls: [
        { id: "wallnorthaaa", a: [5, 5], b: [6, 5], f: { kind: "wall" } },
        { id: "walleastaaaa", a: [6, 5], b: [6, 6], f: { kind: "wall" } },
        { id: "wallsouthaaa", a: [5, 6], b: [6, 6], f: { kind: "wall" } },
        { id: "wallwestaaaa", a: [5, 5], b: [5, 6], f: { kind: "wall" } },
      ],
    };
    assert.equal(companionSpot(walled, walled.tokens.bt!, { size: "small" }), null);
    walled.scenes.s1 = { ...walled.scenes.s1!, blockMovement: false };
    assert.notEqual(companionSpot(walled, walled.tokens.bt!, { size: "small" }), null, "walls stop nothing on a scene that does not block moves");
  });

  test("with no token of the character on the players' scene, or no map, the button says why", () => {
    const away = bree();
    away.tokens.bt = { ...away.tokens.bt!, sceneId: "s2" };
    assert.deepEqual(playerPlacement(away, away.characters.bree!, { size: "small" }), { ok: false, reason: "Bree has no token on the map." });
    const dark = bree();
    dark.meta.view = { ...dark.meta.view, blackout: true };
    assert.deepEqual(playerPlacement(dark, dark.characters.bree!, { size: "small" }), { ok: false, reason: "No map to place it on yet." });
    dark.meta = { ...dark.meta, playerSceneId: null, view: { ...dark.meta.view, blackout: false } };
    assert.deepEqual(playerPlacement(dark, dark.characters.bree!, { size: "small" }), { ok: false, reason: "No map to place it on yet." });
  });
});

describe("the links the panel sends", () => {
  test("a turn edit of a spent companion and Make a companion send { of, turn } alone, which the schema takes", () => {
    const patch = linkPatch({ of: "bree", turn: "shared" }, { turn: "none" });
    assert.deepEqual(patch, { companion: { of: "bree", turn: "none" } });
    assert.ok(clientOpSchema.safeParse({ t: "token.update", tokenId: "ws", patch }).success);
    assert.deepEqual(makeCompanionPatch({ disposition: "hostile" }, "bree", "shared"), { companion: { of: "bree", turn: "shared" }, disposition: "ally" });
    assert.deepEqual(makeCompanionPatch({ disposition: "neutral" }, "bree", "own"), { companion: { of: "bree", turn: "own" } });
  });
});

describe("adding a companion from a stat block (docs/design-v1-companion-stat-blocks.md 5.6, 6.3)", () => {
  const SRD = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
  const owlView = SRD.find((m) => m.srdId === "owl")!;
  const owl: ChosenBlock = { link: { srdId: "owl" }, view: owlView, source: "srd" };
  const moth = companionBlock("moth", "bree", { defaultImage: imageRef("moth-art") });
  const mothChosen: ChosenBlock = { link: { blockId: "moth" }, view: monsterView(moth), source: "block", picture: imageRef("moth-art") };

  test("a block fills each field still as it started: the name when empty, the size, HP with its average, AC and a stored block's picture", () => {
    const filled = withBlock(NEW_COMPANION, owl);
    assert.deepEqual([filled.name, filled.size, filled.hp, filled.ac, filled.image], ["Owl", "tiny", 1, 11, null]);
    const pictured = withBlock(NEW_COMPANION, mothChosen);
    assert.deepEqual(pictured.image, imageRef("moth-art"));
    // Fields the user changed stay as they are, and a name typed first is kept.
    const typed = draftWith(draftWith(draftWith(NEW_COMPANION, { name: "Hoot" }), { hp: 4 }), { image: imageRef("mine") });
    const kept = withBlock(typed, mothChosen);
    assert.deepEqual([kept.name, kept.hp, kept.image, kept.size, kept.ac], ["Hoot", 4, imageRef("mine"), "small", 12]);
    // A second pick refills what the first filled, the name included, and Remove keeps it all.
    const changed = withBlock(filled, mothChosen);
    assert.deepEqual([changed.name, changed.size, changed.hp, changed.ac], ["Moth Spirit", "small", 9, 12], "the first block's name stayed");
    const removed = withBlock(changed, null);
    assert.equal(removed.block, null);
    assert.deepEqual([removed.size, removed.hp, removed.ac], ["small", 9, 12]);
  });

  test("the new companion carries the link and the block's speeds, Passive Perception, senses and initiative bonus, which the server takes", () => {
    const state = bree();
    state.companionBlocks.moth = moth;
    for (const chosen of [owl, mothChosen]) {
      const draft = withBlock(NEW_COMPANION, chosen);
      const input = companionInput(draft, { ...at, x: 6, y: 5 }, state.characters.bree!);
      assert.ok("inline" in input.actor);
      const a = input.actor.inline;
      assert.deepEqual([a.speeds, a.passivePerception, a.senses, a.initBonus], [chosen.view.speeds, chosen.view.passivePerception, chosen.view.senses, chosen.view.initiative.bonus]);
      assert.deepEqual("srdId" in chosen.link ? a.srdId : a.blockId, "srdId" in chosen.link ? "owl" : "moth");
      for (const field of ["initScore", "creatureType", "cr", "xp", "legendary", "monsterId"]) assert.equal(field in a, false, field);
      const op = { t: "token.create" as const, token: input };
      assert.ok(clientOpSchema.safeParse(op).success);
      const p1 = { memberId: "p1", role: "player" as const };
      const allowed = canApply(op, p1, state, { canUseAsset: () => true });
      assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
      assert.ok(applyOp(state, op, p1, env(1)).ok);
    }
  });

  test("an effect keeps the choice in its draft and sends no link or block numbers", () => {
    const draft = draftWith(withBlock(NEW_COMPANION, owl), { what: "effect", turn: "none" });
    assert.ok(draft.block, "kept in the draft");
    const input = companionInput(draft, at, bree().characters.bree!);
    assert.ok("inline" in input.actor);
    assert.deepEqual([input.actor.inline.srdId, input.actor.inline.blockId, input.actor.inline.passivePerception], [undefined, undefined, 10]);
    // Back to a creature, it sends the block again.
    const back = companionInput(draftWith(draft, { what: "creature" }), at, bree().characters.bree!);
    assert.ok("inline" in back.actor && back.actor.inline.srdId === "owl");
  });

  test("HP's help names the average and its dice", () => {
    assert.equal(blockHpHelp(owlView), "The block's average, 1 (1d4 − 1). Type another for a higher-level casting.");
    assert.equal(blockHpHelp(monsterView(companionBlock("x", "bree", { hp: { average: 7, formula: "" } }))), "The block's average, 7. Type another for a higher-level casting.");
  });
});

describe("an own-turn companion made mid-fight joins it (docs/design-v1-combat-flow.md 3.6.2)", () => {
  const owl: CompanionDraft = { ...NEW_COMPANION, name: "Hoot", hp: 1, ac: 11, turn: "own", turnPicked: true };
  const p1 = { memberId: "p1", role: "player" as const };

  /** Bree in a fight beside a goblin, Bree's row naming her token or, with `byCharacter`, only her character. */
  function fight(byCharacter = false): RoomState {
    const state = bree();
    state.tokens.gob = token("gob", { x: 9, y: 9 });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-gob", entries: [entry("e-gob", { tokenId: "gob", value: 15 }), byCharacter ? entry("e-bree", { characterId: "bree", value: 12 }) : entry("e-bree", { tokenId: "bt", value: 12 })] };
    return state;
  }

  test("its row comes with it, with no value for its player to roll, and the server takes both from Bree's player", () => {
    for (const byCharacter of [false, true]) {
      let state = fight(byCharacter);
      const input = companionInput(owl, at, state.characters.bree!);
      const join = joinFightOp(state, input, "e-hoot");
      assert.deepEqual(join, { t: "encounter.add", entries: [{ id: "e-hoot", tokenId: "ws" }] });
      for (const op of [{ t: "token.create" as const, token: input }, join!]) {
        assert.ok(clientOpSchema.safeParse(op).success, op.t);
        const allowed = canApply(op, p1, state, { canUseAsset: () => true });
        assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
        const applied = applyOp(state, op, p1, env(1));
        assert.ok(applied.ok, applied.ok ? "" : applied.message);
        state = applied.state;
      }
      const row = state.encounter!.entries.find((e) => e.id === "e-hoot");
      assert.ok(row, "Hoot has a row");
      assert.equal(row.value, null);
      assert.equal(row.hidden, false);
    }
  });

  test("nothing joins for a companion on Bree's turn, an effect, no fight, or a fight Bree is not in", () => {
    const state = fight();
    const character = state.characters.bree!;
    for (const turn of ["shared", "none"] as const) assert.equal(joinFightOp(state, companionInput({ ...owl, turn }, at, character), "e1"), null, turn);
    assert.equal(joinFightOp(state, companionInput({ ...owl, what: "effect", hp: null }, at, character), "e1"), null, "an effect");
    assert.equal(joinFightOp(bree(), companionInput(owl, at, character), "e1"), null, "no fight");
    const without = fight();
    without.encounter!.entries = without.encounter!.entries.filter((e) => e.id !== "e-bree");
    assert.equal(joinFightOp(without, companionInput(owl, at, character), "e1"), null, "Bree is not in it");
  });
});
