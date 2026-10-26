import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SavedEncounterMonster } from "#shared/model.ts";
import { monsterView } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";

/*
 * A saved encounter's line offers In its lair where its block has lair
 * counts or XP (tokens/factory.ts hasLairValues), as the Monsters place card
 * does, since outside a drop into a running fight the tick reaches a token's
 * counts and XP and nothing else. A line already in its lair keeps the box,
 * so it can be taken out (D-261026-19).
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

describe("an encounter's line offers In its lair where its block has lair numbers, as the place card does (FU33-O1)", () => {
  test("lair actions alone, as a heading's text or a named entry, offer none", () => {
    for (const view of [keeper, warden]) assert.ok(!line(view).includes("In its lair"), `${view.name}: In its lair`);
  });

  test("lair counts or XP offer it with the lair's numbers in its help", () => {
    const html = line(tyrant);
    assert.ok(html.includes("In its lair"));
    assert.ok(html.includes("Uses the lair&#x27;s legendary uses and XP."));
  });

  test("a block with no lair offers none either", () => {
    assert.ok(!line(lurker).includes("In its lair"));
  });

  test("a line already in its lair keeps the box that takes it out, and says its block changes nothing there", () => {
    for (const view of [keeper, warden, lurker]) {
      const html = line(view, true);
      assert.ok(html.includes("In its lair"), `${view.name}: no In its lair`);
      assert.ok(html.includes("Its stat block changes nothing in its lair."), `${view.name}: the help`);
    }
  });
});
