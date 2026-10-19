import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { SrdMonster } from "#shared/srd/monsters.ts";

/*
 * Back from a monster's page returns focus to the row that opened it, found
 * by the row's `data-opener` id (features/panels.ts useSubpageFocus). Found
 * by its text instead, a row renamed by an edit was lost, and of a room's
 * copy and the SRD monster it came from, both one name, Back could land on
 * the other.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MonsterList } = await import("./MonsterList.tsx");

const MONSTERS = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const goblin = MONSTERS.find((m) => m.srdId === "goblin-warrior")!;
/** The SRD's Goblin Warrior and the room's copy of it, under one name. */
const ITEMS = [
  { key: "room:copy01", source: "room" as const, view: goblin },
  { key: `srd:${goblin.srdId}`, source: "srd" as const, view: goblin },
];

function openers(markup: string): string[] {
  return [...markup.matchAll(/data-opener="([^"]*)"/g)].map((m) => m[1]!);
}

describe("monster list rows as subpage openers", () => {
  test("rows that open a subpage carry their source and id, so a room copy and its SRD monster differ", () => {
    const markup = renderToStaticMarkup(createElement(MonsterList, { items: ITEMS, onPick: () => {}, subpages: true }));
    assert.deepEqual(openers(markup), ["monster-room:copy01", "monster-srd:goblin-warrior"]);
  });

  test("rows that open no subpage, as in the stat block picker, carry none", () => {
    const markup = renderToStaticMarkup(createElement(MonsterList, { items: ITEMS, onPick: () => {} }));
    assert.deepEqual(openers(markup), []);
  });
});

/*
 * A known form's mark in Take a shape (docs/design-v1-known-forms.md 5.1)
 * reads whole. Cut at a character name's 88 px, "Over CR 1/4" showed as
 * "Over CR …" on a phone (LP9-PLAY-1). A companion block's character name
 * still cuts.
 */
describe("tags in monster rows", () => {
  test("a known form's mark is never cut, and a character's name on a companion block is", () => {
    const mark = renderToStaticMarkup(createElement(MonsterList, { items: [{ key: "goblin-warrior", source: "srd", view: goblin, tag: "Over CR 1/4", label: "Wild Shape as Goblin Warrior, over CR 1/4" }], onPick: () => {} }));
    assert.match(mark, /Over CR 1\/4/);
    assert.doesNotMatch(mark, /max-width:88px/, "the mark is cut at a name's width");
    const block = renderToStaticMarkup(createElement(MonsterList, { items: [{ key: "block:b1", source: "block", view: goblin, tag: "Bartholomew the Unready's" }], onPick: () => {} }));
    assert.match(block, /max-width:88px/, "a character's name is no longer cut");
  });
});
