import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { monsterMatcher, parseQuery } from "./monsterSearch.ts";

const MONSTERS = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const find = (q: string) => MONSTERS.filter(monsterMatcher(q)).map((m) => m.srdId);
const crOf = (id: string) => {
  const cr = MONSTERS.find((m) => m.srdId === id)!.cr;
  const [n, d] = cr.split("/");
  return d === undefined ? Number(n) : Number(n) / Number(d);
};
const countIn = (min: number, max: number) => MONSTERS.filter((m) => crOf(m.srdId) >= min && crOf(m.srdId) <= max).length;

describe("monster search", () => {
  test("words match name, type and size in any order", () => {
    assert.ok(find("red dragon").includes("adult-red-dragon"));
    assert.ok(find("DRAGON red").includes("adult-red-dragon"));
    assert.ok(find("goblin").includes("goblin-warrior"));
    assert.ok(find("fey goblinoid").includes("goblin-warrior"));
    assert.ok(find("gargantuan").every((id) => MONSTERS.find((m) => m.srdId === id)!.size === "gargantuan"));
  });

  test("a CR term is exact", () => {
    const quarter = find("cr 1/4");
    assert.ok(quarter.includes("goblin-warrior"));
    assert.ok(quarter.every((id) => MONSTERS.find((m) => m.srdId === id)!.cr === "1/4"));
    const five = find("cr5");
    assert.ok(five.length > 0);
    assert.ok(five.every((id) => MONSTERS.find((m) => m.srdId === id)!.cr === "5"));
    assert.deepEqual(find("cr 17 red"), ["adult-red-dragon"]);
  });

  test("a CR range parses with either end a whole number or a fraction", () => {
    assert.deepEqual(parseQuery("cr 1-5"), { cr: { min: 1, max: 5 }, words: [] });
    assert.deepEqual(parseQuery("cr 1/4-1"), { cr: { min: 0.25, max: 1 }, words: [] });
    assert.deepEqual(parseQuery("cr 1/2-3 undead"), { cr: { min: 0.5, max: 3 }, words: ["undead"] });
    assert.deepEqual(parseQuery("CR1 – 5"), { cr: { min: 1, max: 5 }, words: [] });
    assert.deepEqual(parseQuery("cr 5"), { cr: { min: 5, max: 5 }, words: [] });
    // Backwards reads the right way round.
    assert.deepEqual(parseQuery("cr 5-1"), { cr: { min: 1, max: 5 }, words: [] });
  });

  test("a range open at one end runs to the top or the bottom", () => {
    assert.deepEqual(parseQuery("cr 10-"), { cr: { min: 10, max: Infinity }, words: [] });
    assert.deepEqual(parseQuery("cr -1/2"), { cr: { min: 0, max: 0.5 }, words: [] });
    assert.deepEqual(parseQuery("cr-5"), { cr: { min: 0, max: 5 }, words: [] });
  });

  test("a fraction still being typed keeps its whole number until the denominator arrives", () => {
    assert.deepEqual(parseQuery("cr 1/"), { cr: { min: 1, max: 1 }, words: [] });
    assert.deepEqual(find("cr 1/"), find("cr 1"));
    assert.ok(find("cr 1/").length > 0);
    assert.deepEqual(parseQuery("cr 1/2"), { cr: { min: 0.5, max: 0.5 }, words: [] });
    assert.deepEqual(parseQuery("cr 1/4-1/"), { cr: { min: 0.25, max: 1 }, words: [] });
    assert.deepEqual(parseQuery("cr 1/ goblin"), { cr: { min: 1, max: 1 }, words: ["goblin"] });
    // Two slashes are no fraction at all.
    assert.deepEqual(parseQuery("cr 1//"), { cr: null, words: ["cr", "1//"] });
  });

  test("bad CR input matches nothing or stays a plain word", () => {
    assert.equal(parseQuery("cr 1/0").cr, "bad");
    assert.equal(parseQuery("cr 1/0-5").cr, "bad");
    assert.deepEqual(find("cr 1/0"), []);
    assert.deepEqual(find("cr 2-1/0"), []);
    // No number: not a CR term, so "cr" is a word of the name like any other.
    assert.deepEqual(parseQuery("crab"), { cr: null, words: ["crab"] });
    assert.deepEqual(parseQuery("cr"), { cr: null, words: ["cr"] });
    assert.deepEqual(parseQuery("cr -"), { cr: null, words: ["cr", "-"] });
    assert.deepEqual(parseQuery("cr 5x"), { cr: null, words: ["cr", "5x"] });
    assert.ok(find("crab").includes("crab"));
    // A CR no monster has finds nothing, as before.
    assert.deepEqual(find("cr 31"), []);
  });

  test("a CR range finds every monster within it, both ends included", () => {
    const low = find("cr 1-5");
    assert.equal(low.length, countIn(1, 5));
    assert.ok(low.some((id) => crOf(id) === 1) && low.some((id) => crOf(id) === 5));
    assert.equal(find("cr 1/4-1").length, countIn(0.25, 1));
    assert.equal(find("cr 1/2-3").length, countIn(0.5, 3));
    assert.equal(find("cr 20-").length, countIn(20, 30));
    assert.deepEqual(find("cr 1-5 goblin"), find("goblin").filter((id) => crOf(id) >= 1 && crOf(id) <= 5));
    assert.ok(find("cr 15-20 red").includes("adult-red-dragon"));
  });

  test("an empty query matches everything", () => {
    assert.equal(find("").length, MONSTERS.length);
    assert.equal(find("   ").length, MONSTERS.length);
  });
});
