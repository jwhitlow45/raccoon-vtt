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
