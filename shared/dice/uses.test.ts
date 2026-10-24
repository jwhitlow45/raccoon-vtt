import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Actor, StatBlockEntry } from "../model.ts";
import { clientOpSchema, combatUseSchemas } from "../protocol.ts";
import { loadMonsters, type SrdMonster } from "../srd/monsters.ts";
import { emptyStatBlock, monsterView } from "../statBlock.ts";
import { apply, actor, room, token } from "../testutil.ts";
import { blockActions, blockEntries, entryKeys } from "./named.ts";
import { hasLair, lairCounts, limitedUses, regenerationOf, type LimitedUse } from "./uses.ts";

/**
 * A stat block's limited uses (docs/design-v1-combat-controls.md 2.1 and
 * 11) over every SRD 5.2.1 block, each count checked against the blocks'
 * own words with patterns of the test's own, and over custom blocks with
 * the wording older and pasted blocks keep.
 */

let monsters: readonly SrdMonster[] = [];
before(async () => {
  monsters = await loadMonsters();
});

const byName = (name: string): SrdMonster => {
  const m = monsters.find((x) => x.name === name);
  assert.ok(m, `no monster named ${name}`);
  return m;
};

function all(kind: LimitedUse["kind"]): { m: SrdMonster; use: LimitedUse }[] {
  return monsters.flatMap((m) => limitedUses(m).filter((u) => u.kind === kind).map((use) => ({ m, use })));
}

const monstersOf = (list: { m: SrdMonster }[]) => new Set(list.map((x) => x.m.name)).size;

function custom(entries: { traits?: StatBlockEntry[]; actions?: StatBlockEntry[]; bonusActions?: StatBlockEntry[]; legendaryActions?: StatBlockEntry[] }) {
  return monsterView({ ...emptyStatBlock(), name: "Cinder Drake", ...entries });
}

/** The key rule before entry keys, kept here to prove no SRD roll's key moved: the printed name less its recharge and uses, slugged, numbered among the rolls. */
function oldSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "roll"
  );
}

describe("limited uses from every SRD block", () => {
  test("legendary actions: every entry of 30 blocks but their uses line, each costing 1", () => {
    const listed = all("legendary");
    let printed = 0;
    for (const m of monsters) for (const e of blockEntries(m)) if (e.section === "legendaryActions" && !/^Legendary Action Uses/.test(e.name)) printed++;
    assert.equal(listed.length, printed);
    assert.equal(listed.length, 82);
    assert.equal(monstersOf(listed), 30);
    assert.ok(listed.every(({ use }) => use.kind === "legendary" && use.cost === 1));
  });

  test("once a turn: the 41 entries on 27 blocks that can't be taken again until the creature's next turn", () => {
    const once = all("legendary").filter(({ use }) => use.kind === "legendary" && use.once);
    assert.equal(once.length, 41);
    assert.equal(monstersOf(once), 27);
    for (const { m, use } of all("legendary")) {
      const entry = blockEntries(m).find((e) => e.section === "legendaryActions" && e.name.startsWith(use.name));
      assert.ok(entry, `${m.name}: ${use.name}`);
      assert.equal(use.kind === "legendary" && use.once, /can.t take this action again until the start of its next turn/.test(entry.text), `${m.name}: ${use.name}`);
    }
  });

  test("recharge: 86 entries, 13 of them Bonus Actions, each with its range's low end", () => {
    const listed = all("recharge");
    assert.equal(listed.length, 86);
    assert.equal(listed.filter(({ use }) => use.section === "bonusActions").length, 13);
    for (const { m, use } of listed) {
      const entry = blockEntries(m).find((e) => e.section === use.section && e.name.startsWith(`${use.name} (Recharge`));
      assert.ok(entry, `${m.name}: ${use.name}`);
      const range = /\(Recharge (\d)(?:–6)?\)/.exec(entry.name);
      assert.equal(use.kind === "recharge" ? use.min : 0, Number(range?.[1]), `${m.name}: ${entry.name}`);
    }
  });

  test("rest: the cloaker's Phantasms alone recharges after a Short or Long Rest", () => {
    assert.deepEqual(
      all("rest").map(({ m, use }) => `${m.name}: ${use.name}`),
      ["Cloaker: Phantasms"],
    );
  });

  test("X/Day: 28 entries on 26 blocks, Legendary Resistance and spells left out, each with its X", () => {
    const listed = all("day");
    assert.equal(listed.length, 28);
    assert.equal(monstersOf(listed), 26);
    for (const { m, use } of listed) {
      const entry = blockEntries(m).find((e) => e.section === use.section && e.name.startsWith(`${use.name} (`));
      assert.ok(entry, `${m.name}: ${use.name}`);
      assert.equal(use.kind === "day" ? use.max : 0, Number(/\((\d)\/Day/.exec(entry.name)?.[1]), `${m.name}: ${entry.name}`);
    }
    assert.ok(!listed.some(({ use }) => /^Legendary Resistance/.test(use.name)));
    const aboleth = limitedUses(byName("Aboleth")).find((u) => u.name === "Dominate Mind");
    assert.deepEqual(aboleth, { key: "actions:dominate-mind", name: "Dominate Mind", section: "actions", kind: "day", max: 2, short: false });
    // A block's own named X/Day entry counts, even one that casts a spell (2.1).
    assert.ok(limitedUses(byName("Archmage")).some((u) => u.kind === "day" && u.name === "Misty Step" && u.max === 3));
    // "(1/Day; Requires Soul Bag)" is one use a day.
    assert.ok(limitedUses(byName("Night Hag")).some((u) => u.kind === "day" && u.name === "Nightmare Haunting" && u.max === 1));
  });

  test("Regeneration: 4 blocks, the troll's and its limb's stopped by Acid or Fire, the oni's and the shield guardian's needing 1 HP", () => {
    const listed = all("regeneration").map(({ m, use }) => [m.name, use]);
    assert.deepEqual(listed, [
      ["Oni", { key: "traits:regeneration", name: "Regeneration", section: "traits", kind: "regeneration", amount: 10, stops: [], minHp: 1 }],
      ["Shield Guardian", { key: "traits:regeneration", name: "Regeneration", section: "traits", kind: "regeneration", amount: 10, stops: [], minHp: 1 }],
      ["Troll", { key: "traits:regeneration", name: "Regeneration", section: "traits", kind: "regeneration", amount: 15, stops: ["acid", "fire"] }],
      ["Troll Limb", { key: "traits:regeneration", name: "Regeneration", section: "traits", kind: "regeneration", amount: 5, stops: ["acid", "fire"] }],
    ]);
    assert.equal(regenerationOf(byName("Goblin Warrior")), null);
  });

  test("lair counts: 30 blocks with legendary actions, 32 with Legendary Resistance, 27 with a lair's XP", () => {
    assert.equal(monsters.filter((m) => m.legendaryActions).length, 30);
    assert.equal(monsters.filter((m) => m.legendaryResistance).length, 32);
    assert.equal(monsters.filter((m) => m.xpInLair !== undefined).length, 27);
    const dragon = byName("Adult Red Dragon");
    assert.deepEqual(lairCounts(dragon, false), { actionsMax: 3, resistMax: 3, xp: dragon.xp });
    assert.deepEqual(lairCounts(dragon, true), { actionsMax: 4, resistMax: 4, xp: dragon.xpInLair });
    assert.ok(hasLair(dragon));
    assert.ok(!hasLair(byName("Goblin Warrior")));
    assert.deepEqual(lairCounts(byName("Goblin Warrior"), true), { actionsMax: 0, resistMax: 0, xp: byName("Goblin Warrior").xp });
  });
});

describe("entry keys", () => {
  test("no SRD roll's key moved: each is still its printed name's slug, numbered among the rolls", () => {
    let n = 0;
    for (const m of monsters) {
      const seen = new Set<string>();
      for (const roll of blockActions(m)) {
        const suffix = roll.name.endsWith(", on a hit") ? ":hit" : roll.name.endsWith(", later turns") ? ":later" : "";
        const base = roll.name.replace(/, (?:on a hit|later turns)$/, "");
        let key = `${roll.section}:${oldSlug(base)}${suffix}`;
        for (let i = 2; seen.has(key); i++) key = `${roll.section}:${oldSlug(base)}-${i}${suffix}`;
        seen.add(key);
        assert.equal(roll.key, key, `${m.name}: ${roll.name}`);
        n++;
      }
    }
    assert.equal(n, 646);
  });

  test("no SRD name repeats in its section or slugs past 44 characters, and every key is a use key the protocol takes", () => {
    for (const m of monsters) {
      const keys = entryKeys(m);
      assert.equal(keys.length, blockEntries(m).length);
      assert.equal(new Set(keys).size, keys.length, m.name);
      for (const key of keys) {
        assert.ok(key.split(":")[1]!.length <= 44, `${m.name}: ${key}`);
        assert.ok(combatUseSchemas.useKey.safeParse(key).success, `${m.name}: ${key}`);
      }
    }
  });

  test("a repeated name whose first copy has no dice keeps its own key, and its roll takes it", () => {
    const view = custom({
      actions: [
        { name: "Shriek", text: "The drake shrieks." },
        { name: "Shriek", text: "Constitution Saving Throw: DC 12, each creature in a 10-foot Emanation. Failure: 7 (2d6) Thunder damage." },
      ],
    });
    assert.deepEqual(entryKeys(view), ["actions:shriek", "actions:shriek-2"]);
    assert.deepEqual(
      blockActions(view).map((r) => r.key),
      ["actions:shriek-2"],
    );
  });

  test("a name past 44 characters keeps 37 of them and a hash of the whole name, 64 at most with its section", () => {
    const long = `${"A".repeat(10)} ${"Very Long Breath Weapon Name That Goes On ".repeat(3).trim()}`;
    const other = `${long} Too`;
    const view = custom({ legendaryActions: [{ name: long, text: "It acts." }, { name: other, text: "It acts again." }] });
    const [a, b] = entryKeys(view);
    assert.ok(a && b);
    assert.notEqual(a, b);
    for (const key of [a, b]) {
      const [, slugPart] = key.split(":");
      assert.equal(slugPart!.length, 44, key);
      assert.match(slugPart!, /^[a-z0-9-]{37}-[0-9a-f]{6}$/);
      assert.ok(key.length <= 64);
      assert.ok(combatUseSchemas.useKey.safeParse(key).success, key);
    }
    // The same name on another device, or read again, gives the same key.
    assert.equal(entryKeys(custom({ legendaryActions: [{ name: long, text: "It acts." }] }))[0], a);
  });
});

describe("custom blocks", () => {
  test('"(Costs 2 Actions)" is cut from the name and costs 2, and a hyphen range reads as an en dash', () => {
    const view = custom({
      actions: [{ name: "Fire Breath (Recharge 5-6)", text: "The drake exhales fire." }],
      legendaryActions: [
        { name: "Detect", text: "The drake makes a Wisdom (Perception) check." },
        { name: "Wing Attack (Costs 2 Actions)", text: "The drake beats its wings. Each creature within 10 feet of it must succeed on a DC 15 Dexterity saving throw or take 6 (1d6 + 3) bludgeoning damage. The drake can't take this action again until the start of its next turn." },
      ],
    });
    // The Dice panel's row keeps the cost in its name, as it always has, under the key the use has.
    const wing = blockActions(view).find((r) => r.section === "legendaryActions");
    assert.deepEqual([wing?.key, wing?.name], ["legendaryActions:wing-attack", "Wing Attack (Costs 2 Actions)"]);
    assert.deepEqual(limitedUses(view), [
      { key: "actions:fire-breath", name: "Fire Breath", section: "actions", kind: "recharge", min: 5 },
      { key: "legendaryActions:detect", name: "Detect", section: "legendaryActions", kind: "legendary", cost: 1, once: false },
      { key: "legendaryActions:wing-attack", name: "Wing Attack", section: "legendaryActions", kind: "legendary", cost: 2, once: true },
    ]);
  });

  test('"1/Day each" is one use a day, a Spellcasting entry\'s X/Day spells are spells, and a Short Rest that gives uses back marks it', () => {
    const view = custom({
      traits: [
        { name: "Spellcasting", text: "The drake casts one of the following spells. 1/Day each: Fireball, Fly." },
        { name: "Innate Spellcasting (1/Day each)", text: "The drake casts Fireball or Fly." },
      ],
      actions: [
        { name: "Blink and Burn (1/Day each)", text: "The drake teleports, then exhales." },
        { name: "Cinder Cloud (3/Day)", text: "Smoke fills a 10-foot Cube. The drake regains all expended uses when it finishes a Short or Long Rest." },
        { name: "Too Often (10/Day)", text: "Ten times is more than a mark counts." },
      ],
    });
    assert.deepEqual(limitedUses(view), [
      { key: "actions:blink-and-burn", name: "Blink and Burn", section: "actions", kind: "day", max: 1, short: false },
      { key: "actions:cinder-cloud", name: "Cinder Cloud", section: "actions", kind: "day", max: 3, short: true },
    ]);
  });

  test("2014 Regeneration, lower case and with one stop type, and none where the trait names no amount", () => {
    const view = custom({ traits: [{ name: "Regeneration", text: "The vine regains 10 hit points at the start of its turn. If it takes fire damage, this trait doesn't function at the start of its next turn." }] });
    assert.deepEqual(regenerationOf(view), { key: "traits:regeneration", name: "Regeneration", section: "traits", kind: "regeneration", amount: 10, stops: ["fire"] });
    assert.equal(regenerationOf(custom({ traits: [{ name: "Regeneration", text: "The vine knits itself back together." }] })), null);
  });

  test("a lair that changes only the legendary actions is still a lair", () => {
    const view = custom({ legendaryActions: [{ name: "Legendary Action Uses: 3 (4 in Lair)", text: "Immediately after another creature's turn, the drake can expend a use." }, { name: "Detect", text: "It looks." }] });
    assert.deepEqual(lairCounts(view, true), { actionsMax: 4, resistMax: 0, xp: view.xp });
    assert.ok(hasLair(view));
  });

  test("a 120-character name goes whole through actor.use and actor.rechargeRoll, and the mark keeps it", () => {
    const printed = `${"Searing Radiant Exhalation of the Ancient Sun ".repeat(3).slice(0, 120).trimEnd().padEnd(120, "x")}`;
    assert.equal(printed.length, 120);
    const view = custom({ actions: [{ name: `${printed} (Recharge 6)`, text: "It burns." }] });
    const [breath] = limitedUses(view);
    assert.ok(breath?.kind === "recharge");
    assert.equal(breath.name, printed);
    const spend = { t: "actor.use", target: { tokenId: "drake" }, use: { kind: "ability", key: breath.key, name: breath.name, limit: "recharge", max: 1, min: breath.min } } as const;
    assert.ok(clientOpSchema.safeParse(spend).success);
    const roll = { t: "actor.rechargeRoll", tag: "t1", target: { tokenId: "drake" }, key: breath.key, name: breath.name, min: breath.min };
    assert.ok(clientOpSchema.safeParse(roll).success);
    const state = apply(room({ tokens: { drake: token("drake", { actor: { inline: actor() } }) } }), spend);
    const drake = state.tokens.drake!.actor as { inline: Actor };
    assert.equal(drake.inline.uses?.[breath.key]?.name, printed);
  });
});
