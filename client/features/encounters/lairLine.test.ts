import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SavedEncounterMonster } from "#shared/model.ts";
import { monsterView } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";

/*
 * A saved encounter's line offers In its lair for every block with a lair
 * (tokens/factory.ts blockHasLair), lair actions alone included, since the
 * line's own choice joins its rows to a fight in their lair whatever the
 * counts say (drop.ts joinEntry). Its help says what the tick does.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MonsterLine } = await import("./EncountersPanel.tsx");

const keeper = monsterView(customMonster("keeper", { name: "Crypt Keeper", legendaryActions: [{ name: "", text: "Lair Actions" }, { name: "Grasping Dead", text: "Hands burst from the floor." }] }));
const warden = monsterView(customMonster("warden", { name: "Bog Warden", traits: [{ name: "Lair Actions", text: "On initiative count 20, the bog rises." }] }));
const tyrant = monsterView(customMonster("tyrant", { name: "Marsh Tyrant", xpInLair: 10_000, legendaryActions: [{ name: "Legendary Action Uses: 3 (4 in Lair)", text: "It acts between turns." }] }));
const lurker = monsterView(customMonster("lurker", { name: "Cave Lurker", traits: [{ name: "Homebody", text: "It never leaves its lair, and it takes no lair actions." }] }));

function line(view: ReturnType<typeof monsterView>, inLair = false): string {
  const saved: SavedEncounterMonster = { monsterId: "m1", count: 1, ...(inLair ? { inLair } : {}) };
  return renderToStaticMarkup(createElement(MonsterLine, { line: saved, view, loading: false, room: true, maxCount: 20, onCount: () => {}, onLair: () => {}, onRemove: () => {} }));
}

describe("an encounter's line offers In its lair where its block has a lair (FU32-LAIR-SURFACES)", () => {
  test("lair actions alone, as a heading's text or a named entry, offer it, and say it joins a fight in its lair", () => {
    for (const view of [keeper, warden]) {
      const html = line(view);
      assert.ok(html.includes("In its lair"), `${view.name}: no In its lair`);
      assert.ok(html.includes("Joins a fight with In lair on, a reminder that its lair acts too."), `${view.name}: the help`);
    }
  });

  test("lair counts or XP offer it with the lair's numbers in its help", () => {
    const html = line(tyrant);
    assert.ok(html.includes("In its lair"));
    assert.ok(html.includes("Uses the lair&#x27;s legendary uses and XP."));
  });

  test("a block with no lair offers none, unless the line is already in its lair, which keeps the box that takes it out", () => {
    assert.ok(!line(lurker).includes("In its lair"));
    assert.ok(line(lurker, true).includes("In its lair"));
  });
});
