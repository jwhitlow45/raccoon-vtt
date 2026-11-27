import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { DIFFICULTIES } from "#shared/srd/xp-budget.ts";
import { partyBudgets } from "../encounters/budget.ts";
import { THEMES } from "./settings.ts";
import { baseType, familyOf, SEWER_BEASTS, stockPool, THEME_FAMILIES } from "./stockPools.ts";

/*
 * The themes' pools (docs/design/design-v1-dungeon-stock.md 4, D-261127-065,
 * 216 amended and 223). Set DSTOCK_POOLS=1 to print each pool's names for
 * review.
 */

const list = await loadMonsters();
const pools = Object.fromEntries(THEMES.map((t) => [t, stockPool(list, t, { srdImages: {} })]));
const names = (t: (typeof THEMES)[number]) => new Set(pools[t]!.map((m) => m.name));

if (process.env.DSTOCK_POOLS === "1") for (const t of THEMES) console.log(`${t} (${pools[t]!.length}): ${pools[t]!.map((m) => m.name).join(", ")}`);

test("DSTOCK-P: the pools hold the counts the design reviewed", () => {
  assert.deepEqual(
    Object.fromEntries(THEMES.map((t) => [t, pools[t]!.length])),
    { dungeon: 89, crypt: 28, cave: 131, mine: 88, sewer: 64 },
  );
});

test("DSTOCK-P: swarms count as the type they swarm as, and a tag family takes only its tag", () => {
  assert.equal(baseType("Swarm of Tiny Beasts"), "Beast");
  assert.equal(baseType("Swarm of Tiny Undead"), "Undead");
  assert.equal(baseType("Dragon (Chromatic)"), "Dragon");
  assert.equal(familyOf("dungeon", { type: "Fey (Goblinoid)" }), 1);
  assert.equal(familyOf("dungeon", { type: "Fey" }), -1);
  assert.ok(names("crypt").has("Swarm of Crawling Claws"));
  for (const t of THEMES) for (const m of pools[t]!) assert.ok(familyOf(t, m) >= 0, `${t}: ${m.name}`);
});

test("DSTOCK-P: every pool leaves out the huge, the aquatic, the harmless, the farm and the open sky", () => {
  for (const t of THEMES) {
    for (const m of pools[t]!) {
      assert.notEqual(m.size, "gargantuan", m.name);
      assert.ok(m.xp > 0, m.name);
      assert.notEqual(m.type, "Beast (Dinosaur)", m.name);
      assert.ok(!((m.speeds.swim ?? 0) > 0 && (m.speeds.walk ?? 0) <= 10), `${m.name} is aquatic`);
      assert.ok(!("statBlock" in m), "the worker gets no stat block text");
    }
    for (const n of ["Draft Horse", "Mastiff", "Owl", "Commoner", "Noble", "Troll Limb", "Homunculus", "Warhorse"]) assert.ok(!names(t).has(n), `${t} has ${n}`);
  }
});

test("DSTOCK-P: Cave keeps its bears and wolves, the others leave the wilds out, and Mine has no grown dragons", () => {
  assert.ok(names("cave").has("Polar Bear") && names("cave").has("Brown Bear") && names("cave").has("Dire Wolf"));
  assert.ok(!names("cave").has("Lion") && !names("cave").has("Pteranodon"));
  for (const t of ["dungeon", "crypt", "mine", "sewer"] as const) assert.ok(!names(t).has("Polar Bear") && !names(t).has("Griffon"), t);
  assert.ok(pools.mine!.every((m) => !/^(Adult|Ancient) /.test(m.name)));
  assert.ok(names("mine").has("Kobold Warrior") || pools.mine!.some((m) => m.name.startsWith("Young ")));
});

test("DSTOCK-P: a Sewer's beasts are its 23 vermin and no other", () => {
  const beasts = pools.sewer!.filter((m) => baseType(m.type) === "Beast").map((m) => m.srdId);
  assert.deepEqual(new Set(beasts), SEWER_BEASTS);
  assert.equal(SEWER_BEASTS.size, 23);
});

test("DSTOCK-P: every theme has a block within every budget from level 1 to 20 at each difficulty", () => {
  for (const t of THEMES) {
    const cheapest = Math.min(...pools[t]!.map((m) => m.xp));
    for (let level = 1; level <= 20; level++) {
      const b = partyBudgets([{ count: 1, level }]);
      for (const d of DIFFICULTIES) assert.ok(cheapest <= b[d], `${t} at level ${level} ${d}`);
    }
    assert.equal(THEME_FAMILIES[t].length > 0, true);
  }
});

test("DSTOCK-P: a pool block wears the room's image for it, else the shipped icon", () => {
  const goblin = list.find((m) => m.srdId === "goblin-warrior")!;
  const image = { icon: "lorc/test", color: "#112233" };
  const own = stockPool([goblin], "dungeon", { srdImages: { "goblin-warrior": { image } } as never });
  assert.deepEqual(own[0]?.image, image);
});
