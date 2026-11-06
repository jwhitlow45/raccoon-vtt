import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { DiceRoll, LogEntry, RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { actor, character, diceLine, P1, room, token } from "#shared/testutil.ts";
import { hpChips } from "./options.ts";
import { appliedWords, applyTargets, chipName, chipWords, holderOf, MAX_APPLY_CHIPS, offersChips, rollChip, rollOrigin, type ApplyYou } from "./targets.ts";

/*
 * Who a damage roll's "Apply to" chips name (QOL audit Q2, D-261106-102
 * and 116): the roller's enemies nearest first, then everyone else, four
 * at most, one chip a creature, never the roller, and the selection for a
 * roll for no creature here.
 */

const dm: ApplyYou = { role: "dm", memberId: "dm1" };
const pat: ApplyYou = { role: "player", memberId: "p1" };

/** A table on s1: a goblin at 5,5 with a second one beside it, the party to its east, a hidden bugbear north of Thorn, and a dead one. */
function table(overrides: Partial<RoomState> = {}): RoomState {
  const pc = (id: string, name: string, x: number): Token => token(id, { kind: "pc", name, x, y: 5, disposition: "ally", ownerIds: [], actor: { ref: `c-${id}` } });
  return room({
    characters: {
      "c-thorn": character("c-thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor() }),
      "c-bree": character("c-bree", { name: "Bree", ownerIds: ["p2"], actor: actor() }),
      "c-wren": character("c-wren", { name: "Wren", ownerIds: [], actor: actor() }),
      "c-ash": character("c-ash", { name: "Ash", ownerIds: [], actor: actor() }),
      "c-lee": character("c-lee", { name: "Lee", ownerIds: [], actor: actor() }),
    },
    tokens: {
      g1: token("g1", { name: "Goblin Warrior", number: 1, x: 5, y: 5 }),
      g2: token("g2", { name: "Goblin Warrior", number: 2, x: 5, y: 6 }),
      thorn: pc("thorn", "Thorn", 6),
      bree: pc("bree", "Bree", 8),
      wren: pc("wren", "Wren", 10),
      ash: pc("ash", "Ash", 12),
      lee: pc("lee", "Lee", 14),
      bugbear: token("bugbear", { name: "Bugbear Warrior", x: 6, y: 4, visibility: "dm" }),
      dead: token("dead", { name: "Skeleton", x: 5, y: 4, actor: { inline: actor({ life: "dead", hp: { cur: 0, max: 13, temp: 0 } }) } }),
      crate: token("crate", { kind: "object", name: "Crate", x: 6, y: 6 }),
      far: token("far", { name: "Goblin Boss", sceneId: "s2", x: 6, y: 5 }),
    },
    ...overrides,
  });
}

const names = (list: readonly { name: string }[]) => list.map((t) => t.name);

describe("applyTargets", () => {
  test("a goblin's damage names its enemies nearest first, four at most, never the goblin itself", () => {
    const got = applyTargets({ view: table(), you: dm, sceneId: "s1", origin: { tokenId: "g1" }, selected: [] });
    assert.deepEqual(names(got), ["Thorn", "Bree", "Wren", "Ash"], "the fifth ally nearest, Lee, gets no chip: no range is read");
    assert.equal(got.length, MAX_APPLY_CHIPS);
  });

  test("enemies come first however near the rest stand, then the others by distance, the dead and objects never", () => {
    const view = table();
    // Thorn's hit: the hostiles first, the hidden bugbear included on the DM's map, then the party.
    const got = applyTargets({ view, you: dm, sceneId: "s1", origin: { characterId: "c-thorn" }, selected: [] });
    assert.deepEqual(names(got), ["Bugbear Warrior", "Goblin Warrior 1", "Goblin Warrior 2", "Bree"]);
    // A neutral roller has no enemies: everyone by distance.
    const neutral = table({ tokens: { ...view.tokens, g1: { ...view.tokens.g1!, disposition: "neutral" } } });
    // The three beside it stand 5 ft off, so their names order them.
    assert.deepEqual(names(applyTargets({ view: neutral, you: dm, sceneId: "s1", origin: { tokenId: "g1" }, selected: [] })), ["Bugbear Warrior", "Goblin Warrior 2", "Thorn", "Bree"]);
  });

  test("a typed roll for no creature offers the selected tokens in selection order, and nothing with none selected", () => {
    const view = table();
    assert.deepEqual(names(applyTargets({ view, you: dm, sceneId: "s1", origin: {}, selected: ["thorn"] })), ["Thorn"]);
    assert.deepEqual(applyTargets({ view, you: dm, sceneId: "s1", origin: {}, selected: [] }), []);
    // Unranked: the order picked, the dead and those on another scene left out.
    assert.deepEqual(names(applyTargets({ view, you: dm, sceneId: "s1", origin: {}, selected: ["lee", "dead", "far", "g2", "thorn"] })), ["Lee", "Goblin Warrior 2", "Thorn"]);
  });

  test("a roller on another scene offers the selection, else nothing", () => {
    const view = table();
    assert.deepEqual(names(applyTargets({ view, you: dm, sceneId: "s1", origin: { tokenId: "far" }, selected: ["g2"] })), ["Goblin Warrior 2"]);
    assert.deepEqual(applyTargets({ view, you: dm, sceneId: "s1", origin: { tokenId: "far" }, selected: [] }), []);
    // This device shows no scene: no chips.
    assert.deepEqual(applyTargets({ view, you: dm, sceneId: null, origin: { tokenId: "g1" }, selected: ["g2"] }), []);
  });

  test("Thorn with two tokens: as the roller, the nearer one counts and neither is offered. As a target, one chip at the nearer", () => {
    const view = table();
    const two = table({ tokens: { ...view.tokens, thorn2: { ...view.tokens.thorn!, id: "thorn2", x: 2, y: 5 } } });
    const asRoller = applyTargets({ view: two, you: dm, sceneId: "s1", origin: { characterId: "c-thorn" }, selected: [] });
    assert.ok(!asRoller.some((t) => t.holder === "character:c-thorn"));
    assert.deepEqual(names(asRoller).slice(0, 1), ["Bugbear Warrior"]);
    // Thorn's far token stands by nobody: the goblins are nearest the near one, whatever the far one sees.
    const asTarget = applyTargets({ view: two, you: dm, sceneId: "s1", origin: { tokenId: "g1" }, selected: [] });
    assert.deepEqual(asTarget.filter((t) => t.holder === "character:c-thorn").map((t) => t.tokenId), ["thorn"]);
    // From the roll's token alone, when it is here: a roll for thorn2 measures from thorn2.
    const fromFar = applyTargets({ view: two, you: dm, sceneId: "s1", origin: { tokenId: "thorn2" }, selected: [] });
    assert.ok(!fromFar.some((t) => t.holder === "character:c-thorn"), "the roller's other token is the roller too");
  });

  test("leave takes out creatures the roll already landed on", () => {
    const got = applyTargets({ view: table(), you: dm, sceneId: "s1", origin: { tokenId: "g1" }, selected: [], leave: new Set(["character:c-thorn"]) });
    assert.deepEqual(names(got), ["Bree", "Wren", "Ash", "Lee"]);
  });

  test("a hidden creature beside the roller is on the DM's chips, never on a player's, whose map is their projection", () => {
    const state = table({ meta: { ...table().meta, settings: { ...table().meta.settings, playersApplyDamage: true } } });
    const dmChips = applyTargets({ view: state, you: dm, sceneId: "s1", origin: { characterId: "c-thorn" }, selected: [] });
    assert.ok(dmChips.some((t) => t.tokenId === "bugbear"));
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.equal(view.tokens.bugbear, undefined, "the projection holds no hidden token");
    const patChips = applyTargets({ view, you: pat, sceneId: "s1", origin: { characterId: "c-thorn" }, selected: ["bugbear"] });
    assert.deepEqual(names(patChips), ["Goblin Warrior 1", "Goblin Warrior 2", "Bree", "Wren"]);
    // Without the setting a player may hurt only their own, and Thorn is the roller.
    const off = projectState(table(), P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.deepEqual(applyTargets({ view: off, you: pat, sceneId: "s1", origin: { characterId: "c-thorn" }, selected: [] }), []);
  });

  test("any room: never the roller, the dead, one without HP access or off the map, one chip a creature, enemies first, and the same order however the room was built (property)", () => {
    const dispositions = ["ally", "neutral", "hostile"] as const;
    const tokenArb = fc.record({
      x: fc.integer({ min: 0, max: 20 }),
      y: fc.integer({ min: 0, max: 20 }),
      disposition: fc.constantFrom(...dispositions),
      scene: fc.constantFrom("s1", "s1", "s1", "s2"),
      of: fc.constantFrom(null, null, "c-a", "c-b", "c-c"),
      dead: fc.boolean(),
      object: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
      hidden: fc.boolean(),
      owned: fc.boolean(),
      name: fc.constantFrom("Goblin", "Orc", "Ash", "Bree"),
    });
    fc.assert(
      fc.property(fc.array(tokenArb, { minLength: 1, maxLength: 12 }), fc.nat(), fc.boolean(), fc.boolean(), fc.array(fc.nat(), { maxLength: 6 }), fc.integer({ min: 0, max: 1 }), (specs, pick, asPlayer, applyOn, picked, seed) => {
        const tokens: Record<string, Token> = {};
        specs.forEach((s, i) => {
          const id = `t${i}`;
          tokens[id] = token(id, {
            name: s.name,
            number: i,
            x: s.x,
            y: s.y,
            sceneId: s.scene,
            disposition: s.disposition,
            kind: s.object ? "object" : s.of ? "pc" : "monster",
            visibility: s.hidden ? "dm" : "all",
            ownerIds: s.owned ? ["p1"] : [],
            actor: s.of ? { ref: s.of } : { inline: actor(s.dead ? { life: "dead", hp: { cur: 0, max: 7, temp: 0 } } : {}) },
          });
        });
        const characters = Object.fromEntries(["c-a", "c-b", "c-c"].map((id, i) => [id, character(id, { name: `Hero ${i}`, ownerIds: i === 0 ? ["p1"] : [], actor: actor() })]));
        const base = room({ tokens, characters });
        const state = { ...base, meta: { ...base.meta, settings: { ...base.meta.settings, playersApplyDamage: applyOn } } };
        const ids = Object.keys(tokens);
        const rollerId = ids[pick % ids.length]!;
        const origin = { tokenId: rollerId };
        const selected = picked.map((n) => ids[n % ids.length]!);
        const view = asPlayer ? (projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState) : state;
        const you = asPlayer ? pat : dm;
        const got = applyTargets({ view, you, sceneId: "s1", origin, selected });
        assert.ok(got.length <= MAX_APPLY_CHIPS);
        assert.equal(new Set(got.map((t) => t.holder)).size, got.length, "one chip a creature");
        const roller = state.tokens[rollerId]!;
        // A view that holds the roll's token knows whose it is. A player's roll is always for a creature on their own map.
        const knows = view.tokens[rollerId] !== undefined;
        for (const t of got) {
          const seen = view.tokens[t.tokenId];
          assert.ok(seen, "on this viewer's map");
          assert.equal(seen.sceneId, "s1");
          if (knows) assert.notEqual(t.holder, holderOf(roller), "never the roller");
          assert.notEqual(seen.kind, "object");
          const a = "inline" in seen.actor ? seen.actor.inline : view.characters[seen.actor.ref]?.actor;
          assert.notEqual(a?.life, "dead");
          if (asPlayer && !applyOn) assert.ok(seen.ownerIds.includes("p1") || ("ref" in seen.actor && view.characters[seen.actor.ref]?.ownerIds.includes("p1")), "only their own without the setting");
        }
        // Ranked from a roller on the map: every enemy shown comes before every other.
        if (roller.sceneId === "s1" && view.tokens[rollerId]) {
          const enemy = roller.disposition === "hostile" ? "ally" : roller.disposition === "ally" ? "hostile" : null;
          const flags = got.map((t) => view.tokens[t.tokenId]!.disposition === enemy);
          assert.ok(flags.every((f, i) => i === 0 || f <= flags[i - 1]!), "enemies first");
        }
        // The same room built in another order gives the same chips.
        const shuffled = Object.fromEntries(Object.entries(view.tokens).sort((a, b) => (seed === 0 ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0]))));
        assert.deepEqual(applyTargets({ view: { ...view, tokens: shuffled }, you, sceneId: "s1", origin, selected }), got);
      }),
      { numRuns: 300 },
    );
  });
});

describe("rollOrigin", () => {
  test("the first roll's creature, and none for a typed formula", () => {
    assert.deepEqual(rollOrigin([diceLine("9:0", "a", [{ formula: "2d6", faces: [3, 4], total: 7 }])]), {});
    assert.deepEqual(rollOrigin([diceLine("9:0", "a", [{ formula: "1d6+2", faces: [4], total: 6, label: "Scimitar damage, Slashing", tokenId: "g1" }])]), { tokenId: "g1" });
    assert.deepEqual(rollOrigin([diceLine("9:0", "a", [{ formula: "1d8+3", faces: [6], total: 9, label: "Longsword damage, Slashing", characterId: "c-bree" }])]), { characterId: "c-bree" });
  });
});

describe("rollChip: what a chip carries, the HP entry's Use's own", () => {
  const slash: DiceRoll = { formula: "1d6+2", faces: [4], total: 6, label: "Scimitar damage, Slashing", tokenId: "g1", type: "slashing" };
  const line = (id: string, rolls: DiceRoll[], extra = {}): LogEntry => diceLine(id, "tag", rolls, { by: "dm1", ...extra });

  test("a damage roll's chip is the one Use offers for it, its parts and words included", () => {
    const lines = [line("9:0", [slash, { formula: "1d6", faces: [3], total: 3, label: "Scimitar damage, Fire", type: "fire", tokenId: "g1" }])];
    const chip = rollChip(lines)!;
    assert.deepEqual(chip, hpChips(lines, "dm1", "damage", { applied: new Set(), nameOf: () => "" })[0]);
    assert.equal(chip.amount, 9);
    assert.equal(chipWords(chip), "6 Slashing damage + 3 Fire damage");
    assert.equal(chipName(chip, "Thorn", true), "Apply 6 Slashing damage + 3 Fire damage to Thorn");
    assert.equal(chipName(rollChip([line("9:1", [slash])])!, "Goblin 2", false), "Fill 6 Slashing damage for Goblin 2");
  });

  test("a batch's lines are one chip, and a critical roll says so", () => {
    const lines = [line("9:0", [slash], { batch: "b" }), line("9:1", [{ ...slash, total: 5, crit: "doubleDice" }], { batch: "b" })];
    const chip = rollChip(lines)!;
    assert.deepEqual([chip.amount, chip.lineIds, chip.critical], [11, ["9:0", "9:1"], true]);
  });

  test("a bare typed formula is damage by hand. A d20, healing, any other label or nothing at all is not", () => {
    const typed = rollChip([line("9:0", [{ formula: "2d6+3", faces: [2, 4], total: 9 }])])!;
    assert.deepEqual([typed.amount, chipWords(typed), typed.parts], [9, "9 damage", undefined]);
    assert.equal(rollChip([line("9:0", [{ formula: "1d20+5", faces: [12], total: 17 }])]), null);
    assert.equal(rollChip([line("9:0", [{ formula: "2d4+2", faces: [3, 3], total: 8, label: "Potion healing" }])]), null);
    assert.equal(rollChip([line("9:0", [{ formula: "1d6", faces: [5], total: 5, label: "Fire Breath recharge" }])]), null);
    assert.equal(rollChip([line("9:0", [{ formula: "2d6-12", faces: [1, 1], total: 0 }])]), null);
    assert.equal(rollChip([]), null);
  });
});

describe("the words and who gets chips", () => {
  test("the applied line and the gate: the DM always, a player only under their own rolls with the setting on", () => {
    assert.equal(appliedWords(["Thorn"]), "Applied to Thorn.");
    assert.equal(appliedWords(["Thorn", "Bree", "Wren"]), "Applied to Thorn, Bree and Wren.");
    assert.deepEqual([offersChips(dm, false, false), offersChips(pat, true, true), offersChips(pat, true, false), offersChips(pat, false, true)], [true, true, false, false]);
  });
});
