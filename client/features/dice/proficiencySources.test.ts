import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { D20Test } from "#shared/dice/bonus.ts";
import type { PcStats, RoomState } from "#shared/model.ts";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { actor, character, companionBlock, customMonster, DM, P1, P2, room, token } from "#shared/testutil.ts";
import { creatureProficiency, type DiceView } from "./creature.ts";

const STATS: PcStats = {
  abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 16, cha: 10 },
  saves: ["dex", "wis"],
  skills: { perception: "expert", athletics: "prof" },
  adjust: { skills: { stealth: 10 }, saves: { con: 10 } },
  jack: true,
  defenses: {},
  rolls: [],
};
const PERCEPTION: D20Test = { kind: "check", ability: "wis", skill: "perception" };
const STEALTH: D20Test = { kind: "check", ability: "dex", skill: "stealth" };
const DEX_SAVE: D20Test = { kind: "save", ability: "dex" };
const WIS_SAVE: D20Test = { kind: "save", ability: "wis" };

let monsters: readonly SrdMonster[] = [];
before(async () => { monsters = await loadMonsters(); });

function fixture(): RoomState {
  return room({
    characters: { hero: character("hero", { name: "Hero", ownerIds: ["p1"], stats: STATS, level: 5 }) },
    monsters: { lurker: customMonster("lurker") },
    companionBlocks: { moth: companionBlock("moth", "hero") },
    tokens: {
      hero: token("hero", { kind: "pc", actor: { ref: "hero" } }),
      lent: token("lent", { kind: "pc", ownerIds: ["p2"], actor: { ref: "hero" } }),
      lurker: token("lurker", { kind: "monster", ownerIds: ["p1"], actor: { inline: actor({ monsterId: "lurker" }) } }),
      moth: token("moth", { kind: "npc", ownerIds: ["p1"], companion: { of: "hero", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } }),
      bear: token("bear", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ srdId: "brown-bear" }) } }),
      plain: token("plain", { kind: "monster", actor: { inline: actor() } }),
    },
  });
}

function dice(view: RoomState, you: DiceView["you"] = DM, loaded = true): DiceView {
  return { view, you, srd: { monsters: loaded ? monsters : null, rolls: null } };
}

test("fl7: the DM and a character's owner read explicit flags through either creature reference", () => {
  const state = fixture();
  for (const you of [DM, P1]) {
    for (const creature of [{ characterId: "hero" }, { tokenId: "hero" }]) {
      const view = dice(state, you);
      assert.equal(creatureProficiency(view, creature, PERCEPTION), "expert");
      assert.equal(creatureProficiency(view, creature, DEX_SAVE), "prof");
      assert.equal(creatureProficiency(view, creature, { kind: "check", ability: "str", skill: "athletics" }), "prof");
      assert.equal(creatureProficiency(view, creature, STEALTH), "none", "a large adjustment does not grant proficiency");
      assert.equal(creatureProficiency(view, creature, { kind: "save", ability: "con" }), "none");
      assert.equal(creatureProficiency(view, creature, { kind: "check", ability: "cha", skill: "persuasion" }), "none", "Jack of All Trades keeps an empty slot");
      assert.equal(creatureProficiency(view, creature, { ...PERCEPTION, ability: "int" }), "expert", "an alternate ability keeps the skill's expertise");
    }
  }
});

test("fl7: another player and a token-only borrower cannot read a character's proficiency", () => {
  const state = fixture();
  for (const creature of [{ characterId: "hero" }, { tokenId: "hero" }, { tokenId: "lent" }]) {
    assert.equal(creatureProficiency(dice(state, P2), creature, PERCEPTION), "none", "even an unprojected input must honor the viewer");
    assert.equal(creatureProficiency(dice(state, P1), creature, PERCEPTION), "expert");
    assert.equal(creatureProficiency(dice(state, DM), creature, DEX_SAVE), "prof");
  }
});

test("fl7: room monster inference stays with the DM and a token without a block stays unknown", () => {
  const state = fixture();
  const monster = { tokenId: "lurker" };
  assert.equal(creatureProficiency(dice(state), monster, STEALTH), "expert");
  assert.equal(creatureProficiency(dice(state), monster, WIS_SAVE), "prof");
  assert.equal(creatureProficiency(dice(state), monster, DEX_SAVE), "none");
  assert.equal(creatureProficiency(dice(state, P1), monster, STEALTH), "none", "owning a room monster's token does not reveal its block");
  assert.equal(creatureProficiency(dice(state), { tokenId: "plain" }, STEALTH), "none");
  delete state.monsters.lurker;
  assert.equal(creatureProficiency(dice(state), monster, STEALTH), "none", "a deleted linked block gives no inference");
});

test("fl7: companion blocks are read only by their permitted viewers while the companion is a creature", () => {
  const state = fixture();
  const companion = { tokenId: "moth" };
  for (const you of [DM, P1]) assert.equal(creatureProficiency(dice(state, you), companion, STEALTH), "expert");
  assert.equal(creatureProficiency(dice(state, P2), companion, STEALTH), "none");
  state.tokens.moth!.kind = "object";
  for (const you of [DM, P1]) assert.equal(creatureProficiency(dice(state, you), companion, STEALTH), "none", "an effect does not have a creature stat block");
  state.tokens.moth!.kind = "npc";
  delete state.companionBlocks.moth;
  assert.equal(creatureProficiency(dice(state, P1), companion, STEALTH), "none");
});

test("fl7: Wild Shape retains PC expertise and saves while Polymorph uses the beast's flags", () => {
  const state = fixture();
  const pc = state.characters.hero!;
  pc.actor.srdId = "brown-bear";
  pc.actor.wildShape = true;
  for (const you of [DM, P1]) {
    assert.equal(creatureProficiency(dice(state, you), { characterId: "hero" }, PERCEPTION), "expert");
    assert.equal(creatureProficiency(dice(state, you), { tokenId: "hero" }, DEX_SAVE), "prof");
  }
  assert.equal(creatureProficiency(dice(state, P2), { tokenId: "lent" }, PERCEPTION), "none");
  delete pc.actor.wildShape;
  assert.equal(creatureProficiency(dice(state, P1), { characterId: "hero" }, PERCEPTION), "prof");
  assert.equal(creatureProficiency(dice(state, P1), { characterId: "hero" }, DEX_SAVE), "none");
  pc.actor.wildShape = true;
  delete pc.stats;
  assert.equal(creatureProficiency(dice(state, P1), { characterId: "hero" }, PERCEPTION), "prof", "a druid without a PC block uses its beast's flags");
});

test("fl7: SRD proficiency waits for its block, including Wild Shape, and missing creatures stay unknown", () => {
  const state = fixture();
  const bear = { tokenId: "bear" };
  assert.equal(creatureProficiency(dice(state, P1), bear, PERCEPTION), "prof");
  assert.equal(creatureProficiency(dice(state, P2), bear, PERCEPTION), "none");
  assert.equal(creatureProficiency(dice(state, P1, false), bear, PERCEPTION), "none");
  const pc = state.characters.hero!;
  pc.actor.srdId = "brown-bear";
  assert.equal(creatureProficiency(dice(state, P1, false), { characterId: "hero" }, PERCEPTION), "none", "Polymorph loading");
  pc.actor.wildShape = true;
  assert.equal(creatureProficiency(dice(state, P1, false), { characterId: "hero" }, PERCEPTION), "none", "Wild Shape loading cannot settle beast proficiency yet");
  pc.actor.srdId = "missing-beast";
  assert.equal(creatureProficiency(dice(state, P1), { characterId: "hero" }, PERCEPTION), "none", "a missing beast is not the base PC");
  assert.equal(creatureProficiency(dice(state), { tokenId: "gone" }, PERCEPTION), "none");
  assert.equal(creatureProficiency(dice(state), { characterId: "gone" }, PERCEPTION), "none");
  delete state.characters.hero;
  assert.equal(creatureProficiency(dice(state), { tokenId: "hero" }, PERCEPTION), "none", "a dangling character reference stays unknown");
});

test("fl7: repeated markers read a stable block once, including an unreadable block, and a replacement reads afresh", () => {
  const state = fixture();
  const bear = monsters.find((m) => m.srdId === "brown-bear")!;
  let reads = 0;
  const counted = (statBlock: string): SrdMonster => ({ ...bear, get statBlock() { reads++; return statBlock; } });
  const view = dice(state);
  view.srd.monsters = [counted(bear.statBlock)];
  for (let i = 0; i < 3; i++) assert.equal(creatureProficiency(view, { tokenId: "bear" }, PERCEPTION), "prof");
  assert.equal(reads, 1);
  view.srd.monsters = [counted("No ability table")];
  for (let i = 0; i < 3; i++) assert.equal(creatureProficiency(view, { tokenId: "bear" }, PERCEPTION), "none");
  assert.equal(reads, 2, "a cached null is still a cached result");
  view.srd.monsters = [counted(bear.statBlock)];
  assert.equal(creatureProficiency(view, { tokenId: "bear" }, PERCEPTION), "prof");
  assert.equal(reads, 3, "new block identity replaces the cached source");
});
