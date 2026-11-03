import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { testOf, type D20Test } from "#shared/dice/bonus.ts";
import { resolveAdvantage } from "#shared/dice/formula.ts";
import type { RollRequest, RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { actor, character, companionBlock, customMonster, effect, entry, room, scene, token } from "#shared/testutil.ts";
import type { SceneWeather } from "#shared/weather.ts";
import { creatureRolls, srdNeeds, type DiceView } from "./creature.ts";
import { presetLine } from "./options.ts";
import { presetFor } from "./presets.ts";
import { sourceName as cardSourceName } from "../rolls/card.ts";

/**
 * Every d20 path in the app and the test it rolls (docs/design/design-v1-roll-options.md
 * 3.2), each through presetFor. The paths are built by later steps of the
 * build plan, and each adds its own check here that it calls presetFor with
 * the test this table gives it.
 */

const REQUEST: Pick<RollRequest, "test"> & { spell?: true; cause?: "saveEnds" } = { test: { kind: "save", choices: [{ ability: "wis" }, { ability: "dex" }] }, spell: true };

const PATHS: readonly { path: string; test: D20Test }[] = [
  { path: "Dice panel: a save (4.2)", test: { kind: "save", ability: "dex" } },
  { path: "Dice panel: a check or skill (4.2)", test: { kind: "check", ability: "dex", skill: "stealth" } },
  { path: "Dice panel: initiative (4.2)", test: { kind: "initiative" } },
  { path: "Dice panel: a death save (4.2)", test: { kind: "deathSave" } },
  { path: "Dice panel: an attack (4.2)", test: { kind: "attack" } },
  { path: "Request card's Roll, the second choice (doc 4 5.3)", test: testOf(REQUEST, 1) },
  { path: "Live card's waiting Roll (doc 4 6)", test: testOf(REQUEST, 0) },
  { path: "Group save row, Server or the DM's Roll, against a spell (5.2, 5.7)", test: { kind: "save", ability: "dex", spell: true } },
  { path: "Save-ends card (6.1)", test: { kind: "save", ability: "wis", cause: "saveEnds", spell: true } },
  { path: "Concentration card (6.2)", test: { kind: "save", ability: "con", cause: "concentration" } },
  { path: "Death save row (4.5)", test: { kind: "deathSave" } },
  { path: "Tracker value box (4.5)", test: { kind: "initiative" } },
  { path: "Auto initiative (7)", test: { kind: "initiative" } },
];

/**
 * A Restrained, Blessed, Poisoned and Invisible lurker with Exhaustion 1 and
 * Magic Resistance, which the DM marked Disadvantage in the tracker.
 */
function state(): RoomState {
  return room({
    monsters: { lurker: customMonster("lurker", { traits: [{ name: "Magic Resistance", text: "The lurker has Advantage on saving throws against spells and other magical effects." }] }) },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ effects: [effect("b1", { key: "dodging" })] }) }) },
    tokens: {
      lurk: token("lurk", {
        kind: "monster",
        name: "Lurker",
        actor: {
          inline: actor({
            monsterId: "lurker",
            effects: [effect("e1", { key: "restrained" }), effect("e2", { key: "blessed" }), effect("e3", { key: "poisoned" }), effect("e4", { key: "invisible" }), effect("e5", { key: "exhaustion", level: 1 })],
          }),
        },
      }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", actor: { ref: "bree" } }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("en1", { tokenId: "lurk", value: 12, advantage: "dis" })] },
  });
}

const DM_VIEW = (s = state()): DiceView => ({ you: { memberId: "dm1", role: "dm" }, view: s, srd: { monsters: null, rolls: null } });
const LURK: ActorTarget = { tokenId: "lurk" };

/** What the lurker's effects and traits give each test, by Appendix C. */
function expected(test: D20Test): { sources: string[]; extra: string[] } {
  switch (test.kind) {
    case "save": {
      const sources = [...(test.ability === "dex" ? ["dis:restrained"] : []), ...(test.spell ? ["adv:magic-resistance"] : [])];
      return { sources, extra: ["-2", "+1d4"] };
    }
    case "deathSave":
      return { sources: [], extra: ["-2", "+1d4"] };
    case "check":
      return { sources: ["dis:poisoned"], extra: ["-2"] };
    case "initiative":
      return { sources: ["dis:tracker", "dis:poisoned"], extra: ["-2"] };
    case "attack":
      return { sources: ["dis:restrained", "dis:poisoned", "adv:invisible"], extra: ["-2", "+1d4"] };
  }
}

describe("presetFor on every d20 path", () => {
  test("each path's test gets the creature's effects, its Magic Resistance and its tracker mark", () => {
    const dice = DM_VIEW();
    assert.equal(creatureRolls(dice, LURK)?.magicResistance, true);
    for (const { path, test: asked } of PATHS) {
      const preset = presetFor(dice, LURK, asked);
      assert.deepEqual(
        { sources: preset.sources.map((s) => `${s.kind}:${s.from}`), extra: preset.extra },
        expected(asked),
        path,
      );
    }
  });

  test("a save against a spell without the block known has no Magic Resistance, and a caller's rolls stand in for reading it again", () => {
    const save: D20Test = { kind: "save", ability: "wis", spell: true };
    assert.deepEqual(
      presetFor(DM_VIEW(), LURK, save, { rolls: null }).sources.map((s) => s.from),
      [],
    );
    const rolls = creatureRolls(DM_VIEW(), LURK);
    assert.deepEqual(
      presetFor(DM_VIEW(), LURK, save, { rolls }).sources.map((s) => s.from),
      ["magic-resistance"],
    );
  });

  test("a Magic Resistance companion rolls a save against a spell with advantage for its player and the DM alike", () => {
    const s = state();
    s.companionBlocks.moth = companionBlock("moth", "bree", { traits: [{ name: "Magic Resistance", text: "The moth has Advantage on saving throws against spells and other magical effects." }] });
    s.tokens.moth = token("moth", { kind: "npc", name: "Moth", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } });
    const asked = testOf(REQUEST, 0);
    for (const you of [{ memberId: "p1", role: "player" }, { memberId: "dm1", role: "dm" }] as const) {
      const dice: DiceView = { you, view: s, srd: { monsters: null, rolls: null } };
      assert.equal(resolveAdvantage(presetFor(dice, { tokenId: "moth" }, asked).sources), "adv", you.role);
    }
  });

  test("a character's effects, by its token or by its id, and a gone creature's none", () => {
    for (const creature of [{ tokenId: "breeTok" }, { characterId: "bree" }]) {
      assert.equal(resolveAdvantage(presetFor(DM_VIEW(), creature, { kind: "save", ability: "dex" }).sources), "adv");
    }
    assert.deepEqual(presetFor(DM_VIEW(), { tokenId: "gone" }, { kind: "attack" }), { sources: [], extra: [], notes: [] });
  });

  test("without a tracker mark, initiative takes the hint: Invisible and Poisoned cancel", () => {
    const s = state();
    s.encounter!.entries[0]!.advantage = undefined;
    const preset = presetFor(DM_VIEW(s), LURK, { kind: "initiative" });
    assert.deepEqual(
      preset.sources.map((x) => `${x.kind}:${x.from}`),
      ["dis:poisoned", "adv:invisible"],
    );
    assert.equal(resolveAdvantage(preset.sources), undefined);
  });
});

describe("which SRD chunks a creature waits on", () => {
  test("a room monster none, an SRD monster both for the DM, and a character in an SRD shape both for its readers", () => {
    const s = state();
    s.tokens.gob = token("gob", { kind: "monster", name: "Goblin", actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    s.characters.bree!.actor.srdId = "brown-bear";
    const dm = { you: { memberId: "dm1", role: "dm" } as const, view: s };
    assert.deepEqual(srdNeeds(dm, LURK), { monsters: false, rolls: false });
    assert.deepEqual(srdNeeds(dm, { tokenId: "gob" }), { monsters: true, rolls: true });
    assert.deepEqual(srdNeeds(dm, { characterId: "bree" }), { monsters: true, rolls: true });
    assert.deepEqual(srdNeeds({ you: { memberId: "p2", role: "player" }, view: s }, { characterId: "bree" }), { monsters: false, rolls: true }, "another player reads no block of Bree's");
    // A player reads no block on a monster they do not play, so only its numbers wait.
    assert.deepEqual(srdNeeds({ you: { memberId: "p1", role: "player" }, view: s }, { tokenId: "gob" }), { monsters: false, rolls: true });
    assert.deepEqual(srdNeeds(dm, { tokenId: "gone" }), { monsters: false, rolls: false });
  });
});

describe("the weather of the scene a creature stands on (docs/design/design-v1-weather.md 2)", () => {
  const inWeather = (weather: SceneWeather, viewerScene: string | null = "s1"): DiceView => {
    const s = state();
    s.scenes.s1 = scene("s1", { weather });
    s.meta.playerSceneId = "s1";
    return { ...DM_VIEW(s), sceneId: viewerScene };
  };
  const perception: D20Test = { kind: "check", ability: "wis", skill: "perception" };
  const keys = (sources: { kind: string; from: string }[]) => sources.map((x) => `${x.kind}:${x.from}`);

  test("heavy rain presets Disadvantage on the lurker's Perception check, beside its conditions' sources, and names it", () => {
    const preset = presetFor(inWeather({ kind: "rain", heavy: true }), LURK, perception);
    assert.deepEqual(keys(preset.sources), ["dis:poisoned", "dis:heavy-rain"]);
  });

  test("a weather source is named as a condition's is, on the option's second line and in a reading", () => {
    const preset = presetFor(inWeather({ kind: "rain", heavy: true }), { characterId: "bree" }, perception);
    assert.equal(presetLine(preset), "Dis: Heavy rain");
    assert.equal(cardSourceName({ kind: "dis", from: "heavy-rain" }), "Heavy rain");
    assert.equal(cardSourceName({ kind: "dis", from: "strong-wind" }), "Strong wind");
  });

  test("strong wind presets a ranged weapon attack and only reminds on one not known to be", () => {
    const wind = inWeather({ kind: "clear", wind: "strong" });
    assert.deepEqual(keys(presetFor(wind, LURK, { kind: "attack", range: "ranged", weapon: true }).sources).filter((k) => k.endsWith("strong-wind")), ["dis:strong-wind"]);
    const maybe = presetFor(wind, LURK, { kind: "attack", range: "ranged" });
    assert.ok(!keys(maybe.sources).includes("dis:strong-wind"));
    assert.deepEqual(maybe.notes.map((n) => n.key).filter((k) => k === "strong-wind"), ["strong-wind"]);
    assert.ok(!keys(presetFor(wind, LURK, { kind: "attack" }).sources).includes("dis:strong-wind"), "the bare d20 says nothing");
  });

  test("a creature on another scene, a scene without weather and weather with its rules off add nothing", () => {
    const s = state();
    s.scenes.s1 = scene("s1");
    s.scenes.s2 = scene("s2", { weather: { kind: "rain", heavy: true } });
    s.tokens.lurk!.sceneId = "s1";
    assert.ok(!keys(presetFor({ ...DM_VIEW(s), sceneId: "s2" }, LURK, perception).sources).includes("dis:heavy-rain"));
    assert.ok(!keys(presetFor(inWeather({ kind: "rain", heavy: true, rules: false }), LURK, perception).sources).includes("dis:heavy-rain"));
  });

  test("a character takes the weather of its token on the players' scene", () => {
    const s = state();
    s.scenes.s1 = scene("s1", { weather: { kind: "snow", heavy: true } });
    s.meta.playerSceneId = "s1";
    const preset = presetFor({ ...DM_VIEW(s), sceneId: "s1" }, { characterId: "bree" }, perception);
    assert.deepEqual(keys(preset.sources), ["dis:heavy-snow"]);
  });
});
