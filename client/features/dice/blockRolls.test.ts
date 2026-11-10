import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { AbilityKey, PcStats, RollRequest, RoomState } from "#shared/model.ts";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { actor, character, companionBlock, customMonster, effect, entry, room, token } from "#shared/testutil.ts";
import { abilityRows, blockRoller, boxDescription, checkTest, saveTest, skillTest, type AbilityRow, type BlockRoller } from "./blockRolls.ts";
import { creatureRolls, type DiceView } from "./creature.ts";

/*
 * Whose block rolls, and each ability's rows (docs/design/design-v1-stat-block-rolls.md
 * 2, 4 and 7), from the Dice panel's own rules.
 */

const DM = { memberId: "dm1", role: "dm" } as const;
const P1 = { memberId: "p1", role: "player" } as const;
const P2 = { memberId: "p2", role: "player" } as const;

/** A rogue 5 with Expertise in Stealth, Jack of All Trades and Alert, proficient in Dexterity and Intelligence saves. */
const THORN: PcStats = {
  abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 16, cha: 10 },
  saves: ["dex", "int"],
  skills: { stealth: "expert", perception: "prof" },
  jack: true,
  alert: true,
  adjust: {},
  defenses: {},
  rolls: [],
};

/** A druid 5, proficient in Intelligence and Wisdom saves. */
const BREE: PcStats = { abilities: { str: 10, dex: 12, con: 14, int: 12, wis: 16, cha: 10 }, saves: ["int", "wis"], skills: {}, adjust: {}, defenses: {}, rolls: [] };

let monsters: readonly SrdMonster[] = [];
let srdRolls: SrdRolls = {};
before(async () => {
  [monsters, srdRolls] = await Promise.all([loadMonsters(), loadSrdRolls()]);
});

function state(over: Partial<RoomState> = {}): RoomState {
  return room({
    characters: {
      // The reducer derives a character's initiative from its block: Dex +4 and Alert's +3.
      thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], level: 5, stats: THORN, actor: actor({ initBonus: 7 }) }),
      bree: character("bree", { name: "Bree", ownerIds: ["p2"], level: 5, stats: BREE }),
      loner: character("loner", { name: "Loner", ownerIds: ["p1"], level: 5, stats: THORN }),
    },
    companionBlocks: { moth: companionBlock("moth", "thorn") },
    tokens: {
      thornTok: token("thornTok", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "thorn" } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p2"], actor: { ref: "bree" } }),
      lent: token("lent", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      gob: token("gob", { kind: "monster", name: "Goblin", actor: { inline: actor({ srdId: "goblin-warrior", initBonus: 2, initScore: 12 }) } }),
      gobFar: token("gobFar", { kind: "monster", name: "Goblin", sceneId: "s2", actor: { inline: actor({ srdId: "goblin-warrior" }) } }),
      moth: token("moth", { kind: "npc", name: "Moth", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } }),
      mothFar: token("mothFar", { kind: "npc", name: "Moth", sceneId: "s2", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } }),
      wolf: token("wolf", { kind: "npc", name: "Wolf", ownerIds: ["p1"], actor: { inline: actor({ srdId: "wolf" }) } }),
      crate: token("crate", { kind: "object", name: "Crate", ownerIds: ["p1"], actor: { inline: actor() } }),
    },
    ...over,
  });
}

function dice(you: DiceView["you"], view = state()): DiceView {
  return { you, view, srd: { monsters, rolls: srdRolls } };
}

function rows(ability: AbilityKey, you: DiceView["you"], roller: BlockRoller, view = state(), ask = true): AbilityRow[] {
  const d = dice(you, view);
  const rolls = creatureRolls(d, roller.creature);
  assert.ok(rolls, "the creature's rolls load");
  return abilityRows(ability, { dice: d, rolls, roller, ask });
}

const strip = (r: BlockRoller | null) => r && { ...r };

describe("whose block rolls (section 2)", () => {
  test("a PC token's panel rolls for the character, for the DM on its scene and for its players anywhere", () => {
    const view = state();
    assert.deepEqual(strip(blockRoller(view, DM, "s1", { tokenId: "thornTok" }, new Map())), { creature: { characterId: "thorn" }, tokenId: "thornTok", name: "Thorn", played: true });
    assert.deepEqual(strip(blockRoller(view, P1, "s1", { tokenId: "thornTok" }, new Map())), { creature: { characterId: "thorn" }, tokenId: "thornTok", name: "Thorn", played: false });
    assert.equal(blockRoller(view, DM, "s2", { tokenId: "thornTok" }, new Map()), null, "the DM rolls only for a token on the scene in view");
    assert.ok(blockRoller(view, P1, "s2", { tokenId: "thornTok" }, new Map()), "a player rolls for their own character wherever its token is");
    assert.equal(blockRoller(view, P2, "s1", { tokenId: "thornTok" }, new Map()), null, "another player holds none of its numbers");
    assert.equal(blockRoller(view, P1, "s1", { tokenId: "lent" }, new Map()), null, "a lent token of a character whose numbers the player does not hold stays text");
  });

  test("a character's page rolls for its players with or without a token, and for the DM only with a token on the scene in view", () => {
    const view = state();
    assert.deepEqual(strip(blockRoller(view, P1, "s1", { characterId: "thorn" }, new Map())), { creature: { characterId: "thorn" }, tokenId: "thornTok", name: "Thorn", played: false });
    assert.deepEqual(strip(blockRoller(view, P1, "s1", { characterId: "loner" }, new Map())), { creature: { characterId: "loner" }, name: "Loner", played: false }, "no token at all");
    assert.deepEqual(strip(blockRoller(view, P1, "s2", { characterId: "thorn" }, new Map())), { creature: { characterId: "thorn" }, name: "Thorn", played: false }, "its token on another scene than the viewer's is not its token here");
    assert.deepEqual(strip(blockRoller(view, DM, "s1", { characterId: "thorn" }, new Map())), { creature: { characterId: "thorn" }, tokenId: "thornTok", name: "Thorn", played: true });
    assert.equal(blockRoller(view, DM, "s2", { characterId: "thorn" }, new Map()), null, "no token on the DM's scene");
    assert.equal(blockRoller(view, DM, "s1", { characterId: "loner" }, new Map()), null);
    assert.equal(blockRoller(view, P2, "s1", { characterId: "thorn" }, new Map()), null);
    assert.equal(blockRoller(view, P1, "s1", { characterId: "gone" }, new Map()), null);
  });

  test("a token's own creature rolls for the DM on its scene, and for a player where the Dice panel offers it", () => {
    const view = state();
    assert.deepEqual(strip(blockRoller(view, DM, "s1", { tokenId: "gob" }, new Map())), { creature: { tokenId: "gob" }, tokenId: "gob", name: "Goblin", played: false });
    assert.equal(blockRoller(view, DM, "s1", { tokenId: "gobFar" }, new Map()), null);
    assert.ok(blockRoller(view, DM, "s2", { tokenId: "gobFar" }, new Map()), "the DM's scene in view, which the players need not be on");
    assert.equal(blockRoller(view, P1, "s1", { tokenId: "gob" }, new Map()), null, "a monster nobody lent");
    assert.deepEqual(strip(blockRoller(view, P1, "s1", { tokenId: "moth" }, new Map())), { creature: { tokenId: "moth" }, tokenId: "moth", name: "Moth", played: false }, "a companion of their character");
    assert.deepEqual(strip(blockRoller(view, DM, "s1", { tokenId: "moth" }, new Map())), { creature: { tokenId: "moth" }, tokenId: "moth", name: "Moth", played: true }, "the DM's ask names its player");
    assert.equal(blockRoller(view, P1, "s1", { tokenId: "mothFar" }, new Map()), null, "off the players' scene");
    assert.ok(blockRoller(view, P1, "s1", { tokenId: "wolf" }, new Map()), "an SRD token the player owns, such as a 2014 Wild Shape");
    assert.equal(blockRoller(view, P1, "s1", { tokenId: "crate" }, new Map()), null, "objects never roll");
    assert.equal(blockRoller(view, DM, "s1", { tokenId: "crate" }, new Map()), null, "not even for the DM: an object is no creature");
    assert.equal(blockRoller(view, DM, "s1", { tokenId: "gone" }, new Map()), null);
  });

  test("a box says what its list holds", () => {
    assert.equal(boxDescription("con"), "Opens the check and the save");
    assert.equal(boxDescription("dex"), "Opens the check, the save, its skills and Initiative");
    for (const a of ["str", "int", "wis", "cha"] as const) assert.equal(boxDescription(a), "Opens the check, the save and its skills");
  });
});

const thorn: BlockRoller = { creature: { characterId: "thorn" }, tokenId: "thornTok", name: "Thorn", played: false };

describe("an ability's rows (section 4)", () => {
  test("each ability lists its check, its save and every skill in the table's order, Initiative last under Dexterity", () => {
    const words = (a: AbilityKey) => rows(a, P1, thorn).map((r) => r.words);
    assert.deepEqual(words("str"), ["Check", "Save", "Athletics"]);
    assert.deepEqual(words("dex"), ["Check", "Save", "Acrobatics", "Sleight of Hand", "Stealth", "Initiative"]);
    assert.deepEqual(words("con"), ["Check", "Save"]);
    assert.deepEqual(words("int"), ["Check", "Save", "Arcana", "History", "Investigation", "Nature", "Religion"]);
    assert.deepEqual(words("wis"), ["Check", "Save", "Animal Handling", "Insight", "Medicine", "Perception", "Survival"]);
    assert.deepEqual(words("cha"), ["Check", "Save", "Deception", "Intimidation", "Performance", "Persuasion"]);
  });

  test("bonuses are the ones rolled: Jack of All Trades on an unproficient skill and never on a plain check, Expertise doubled, Alert on Initiative", () => {
    const dex = rows("dex", P1, thorn);
    const by = (id: string) => dex.find((r) => r.id === id)!;
    // Dex +4, proficiency +3: a check +4, a save +7, Acrobatics with Jack +5, Stealth with Expertise +10, Initiative with Alert +7.
    assert.deepEqual(dex.map((r) => [r.id, r.bonusText]), [["check", "+4"], ["save", "+7"], ["acrobatics", "+5"], ["sleight-of-hand", "+5"], ["stealth", "+10"], ["initiative", "+7"]]);
    assert.deepEqual([by("save").level, by("stealth").level, by("acrobatics").level, by("check").level, by("initiative").level], ["prof", "expert", "none", undefined, undefined], "only saves and skills take a mark");
    assert.equal(by("save").title, "Dexterity save +7");
    assert.equal(by("check").title, "Dexterity check +4");
    assert.equal(by("stealth").title, "Stealth +10");
    assert.equal(by("save").name, "Dexterity save +7, proficient");
    assert.equal(by("stealth").name, "Stealth +10, expertise");
    assert.equal(by("check").label, "Dexterity check");
    assert.equal(by("stealth").label, "Stealth check");
    assert.equal(rows("con", P1, thorn)[1]?.bonusText, "+1", "an unproficient save");
  });

  test("the tests and row keys are the Dice panel's exact ones, so a roll waits in both places", () => {
    const dex = rows("dex", P1, thorn);
    assert.deepEqual(dex.map((r) => r.rowKey), [
      'c:thorn|{"kind":"check","ability":"dex"}',
      'c:thorn|{"kind":"save","ability":"dex"}',
      'c:thorn|{"kind":"check","ability":"dex","skill":"acrobatics"}',
      'c:thorn|{"kind":"check","ability":"dex","skill":"sleight-of-hand"}',
      'c:thorn|{"kind":"check","ability":"dex","skill":"stealth"}',
      "c:thorn|initiative",
    ]);
    assert.equal(JSON.stringify(saveTest("dex")), '{"kind":"save","ability":"dex"}');
    assert.equal(JSON.stringify(checkTest("str")), '{"kind":"check","ability":"str"}');
    assert.equal(JSON.stringify(skillTest("dex", "stealth")), '{"kind":"check","ability":"dex","skill":"stealth"}');
    const tok: BlockRoller = { creature: { tokenId: "gob" }, tokenId: "gob", name: "Goblin", played: false };
    assert.equal(rows("str", DM, tok)[1]?.rowKey, 't:gob|{"kind":"save","ability":"str"}');
  });

  test("tags: an answer, a condition, a blessing and a fail, each whole, and what a tap does to a fight's row", () => {
    const request: RollRequest = { id: "q1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, at: "2026-10-31T12:00:00.000Z", targets: [{ characterId: "thorn" }] };
    const view = state({ rolls: { q1: request }, encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-thorn", { characterId: "thorn", value: 17 })] } });
    view.characters.thorn!.actor.effects = [effect("b", { key: "blessed" }), effect("r", { key: "restrained" })];
    const dex = rows("dex", P1, thorn, view);
    const by = (id: string) => dex.find((r) => r.id === id)!;
    assert.equal(by("save").tag, "Asked Dis +1d4", "the answer, Restrained's Dis and Bless together, none lifted into a label");
    assert.equal(by("save").route, "answer");
    assert.equal(by("save").name, "Dexterity save +7, proficient, answers the DM's request, Dis: Restrained. +1d4: Blessed");
    assert.equal(by("check").tag, "", "Bless is for saves only, and Restrained for Dexterity saves");
    assert.match(by("initiative").tag, /^replaces 17/);
    assert.equal(by("initiative").entryId, "e-thorn");
    assert.equal(by("initiative").name, "Initiative +7, replaces 17");
    view.characters.thorn!.actor.effects = [effect("s", { key: "stunned" })];
    assert.match(rows("dex", P1, thorn, view).find((r) => r.id === "save")!.tag, /Fails/);
    const fresh = state({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-thorn", { characterId: "thorn", value: null })] } });
    assert.equal(rows("dex", P1, thorn, fresh).at(-1)?.tag, "sets row");
  });

  test("for the DM, a played creature's saves, checks and skills ask while its Ask switch is on, and Initiative never asks", () => {
    const played: BlockRoller = { ...thorn, played: true };
    const dex = rows("dex", DM, played);
    assert.deepEqual(dex.map((r) => [r.id, r.route, r.capability === null]), [["check", "ask", true], ["save", "ask", true], ["acrobatics", "ask", true], ["sleight-of-hand", "ask", true], ["stealth", "ask", true], ["initiative", "roll", false]]);
    assert.equal(dex[1]?.tag, "Asks");
    assert.equal(dex[1]?.name, "Dexterity save +7, proficient, asks Thorn");
    const off = rows("dex", DM, played, state(), false);
    assert.deepEqual(off.map((r) => r.route), ["roll", "roll", "roll", "roll", "roll", "roll"], "Ask off: the DM rolls");
    assert.deepEqual(off[1]?.capability, { d20: true, visibility: "selectable" }, "a played creature's roll keeps Secret");
  });

  test("a DM's free rolls for a monster are secret already, so their options drop Secret, and an answer keeps the request's visibility (D-261031-169)", () => {
    const tok: BlockRoller = { creature: { tokenId: "gob" }, tokenId: "gob", name: "Goblin", played: false };
    const str = rows("str", DM, tok);
    for (const r of str) assert.deepEqual(r.capability, { d20: true, visibility: "selectable", secretByDefault: true }, r.id);
    const request: RollRequest = { id: "q1", rev: 0, test: { kind: "save", choices: [{ ability: "str" }] }, dcShown: false, resultShown: true, at: "2026-10-31T12:00:00.000Z", targets: [{ tokenId: "gob" }] };
    const answer = rows("str", DM, tok, state({ rolls: { q1: request } })).find((r) => r.id === "save")!;
    assert.equal(answer.route, "answer");
    assert.deepEqual(answer.capability, { d20: true, visibility: "request" });
    for (const r of rows("str", P1, thorn)) assert.deepEqual(r.capability, { d20: true, visibility: "selectable" }, "a player's roll keeps Secret");
  });

  test("in a score room a monster in the fight lists Initiative score, then Roll initiative", () => {
    const view = state({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-gob", { tokenId: "gob", value: null })] } });
    view.meta.settings.monsterInitScore = true;
    const tok: BlockRoller = { creature: { tokenId: "gob" }, tokenId: "gob", name: "Goblin", played: false };
    const dex = rows("dex", DM, tok, view);
    const [score, roll] = dex.slice(-2);
    assert.deepEqual([score?.id, score?.words, score?.bonusText, score?.route, score?.capability, score?.name, score?.entryId], ["score", "Initiative score", "12", "score", null, "Initiative score 12, sets its row", "e-gob"]);
    assert.deepEqual([roll?.id, roll?.words, roll?.route, roll?.tag, roll?.title], ["initiative", "Roll initiative", "roll", "replaces the score", "Roll initiative +2"]);
    assert.equal(roll?.name, "Roll initiative +2, replaces the score");
    const outside = rows("dex", DM, tok);
    assert.deepEqual(outside.slice(-1).map((r) => r.words), ["Initiative"], "no fight row, no score");
    // A player's own summon in that room sets its score only where players may type totals, as the server takes a score.
    const summon = state({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-gob", { tokenId: "gob", value: null })] } });
    summon.meta.settings.monsterInitScore = true;
    summon.tokens.gob!.ownerIds = ["p1"];
    const mine: BlockRoller = { creature: { tokenId: "gob" }, tokenId: "gob", name: "Goblin", played: false };
    summon.meta.settings.playersTypeTotals = false;
    assert.equal(rows("dex", P1, mine, summon).some((r) => r.id === "score"), false, "typed totals off: the roll alone");
    summon.meta.settings.playersTypeTotals = true;
    assert.deepEqual(rows("dex", P1, mine, summon).slice(-2).map((r) => r.id), ["score", "initiative"]);
  });

  test("Wild Shape rolls the shaped numbers under the creature's printed block, and Polymorph the creature's own", () => {
    const shaped = state();
    shaped.characters.bree!.actor = { ...shaped.characters.bree!.actor, srdId: "wolf", wildShape: true };
    const bree: BlockRoller = { creature: { characterId: "bree" }, tokenId: "breeTok", name: "Bree", played: false };
    const wolf = srdRolls["wolf" as keyof SrdRolls]!;
    const save = rows("wis", P2, bree, shaped).find((r) => r.id === "save")!;
    assert.equal(save.bonus, 6, "the druid's proficient Wisdom save, higher than the wolf's");
    assert.notEqual(wolf.abilities.wis.save, 6);
    assert.equal(save.level, "prof");
    const strCheck = rows("str", P2, bree, shaped).find((r) => r.id === "check")!;
    assert.equal(strCheck.bonus, wolf.abilities.str.check ?? wolf.abilities.str.mod, "the beast's Strength");
    const poly = state();
    poly.characters.bree!.actor = { ...poly.characters.bree!.actor, srdId: "wolf" };
    assert.equal(rows("wis", P2, bree, poly).find((r) => r.id === "save")!.bonus, wolf.abilities.wis.save, "Polymorph: the creature's own");
  });

  test("an answer's tag is the request's own test's, so Magic Resistance meets a spell", () => {
    const view = state({
      monsters: { lurker: customMonster("lurker", { traits: [{ name: "Magic Resistance", text: "The lurker has Advantage on saving throws against spells and other magical effects." }] }) },
      rolls: { q1: { id: "q1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, spell: true, dcShown: false, resultShown: true, at: "2026-10-31T12:00:00.000Z", targets: [{ tokenId: "lurk" }] } },
    });
    view.tokens.lurk = token("lurk", { kind: "monster", name: "Lurker", actor: { inline: actor({ monsterId: "lurker" }) } });
    const lurk: BlockRoller = { creature: { tokenId: "lurk" }, tokenId: "lurk", name: "Lurker", played: false };
    const dex = rows("dex", DM, lurk, view);
    assert.equal(dex.find((r) => r.id === "save")?.tag, "Asked Adv");
    assert.equal(dex.find((r) => r.id === "check")?.tag, "", "a check answers no spell");
  });

  test("a row's source names its roll and route, so its options go back when either changes", () => {
    const before = rows("dex", P1, thorn).find((r) => r.id === "save")!.source;
    const request: RollRequest = { id: "q1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, at: "2026-10-31T12:00:00.000Z", targets: [{ characterId: "thorn" }] };
    assert.notEqual(rows("dex", P1, thorn, state({ rolls: { q1: request } })).find((r) => r.id === "save")!.source, before, "a request for it landed");
    const blessed = state();
    blessed.characters.thorn!.actor.effects = [effect("b", { key: "blessed" })];
    assert.notEqual(rows("dex", P1, thorn, blessed).find((r) => r.id === "save")!.source, before, "a preset changed");
    assert.equal(rows("dex", P1, thorn).find((r) => r.id === "save")!.source, before, "the same roll, the same source");
  });

  test("no numbers, no rows", () => {
    const d = dice(P1);
    const rolls = creatureRolls(d, thorn.creature)!;
    assert.deepEqual(abilityRows("dex", { dice: d, rolls: { ...rolls, numbers: null }, roller: thorn, ask: true }), []);
  });
});
