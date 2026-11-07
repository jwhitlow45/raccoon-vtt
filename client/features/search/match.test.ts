import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { SearchEntry, SearchKind } from "./entry.ts";
import { distance, fold, indexed, matchEntry, MAX_ROWS, parseQuery, rank, searchable, TIER, type Indexed } from "./match.ts";
import { SYNONYMS } from "./words.ts";

function entry(title: string, more: Partial<SearchEntry> = {}): SearchEntry {
  return { id: more.id ?? `e:${title}`, kind: "action", title, where: "", icon: "more", act: { t: "key", shortcut: "x" }, ...more };
}

const items = (entries: SearchEntry[]) => entries.map(indexed);
const titles = (list: readonly Indexed[], text: string) => rank(list, parseQuery(text)).map((e) => e.title);
const tierOf = (e: SearchEntry, text: string) => matchEntry(parseQuery(text), searchable(e))?.tier ?? null;

describe("folding (design-v1-qol.md 5, Matching)", () => {
  test("drops case, accents and apostrophes, and turns punctuation to spaces", () => {
    assert.equal(fold("Players see the Party’s HP"), "players see the partys hp");
    assert.equal(fold("Café  Noël"), "cafe noel");
    assert.equal(fold("X-card…"), "x card");
    assert.equal(fold("2d6+3"), "2d6+3");
  });
});

describe("matching a query", () => {
  const all = items([
    entry("Long Rest for the party", { names: ["party rest"] }),
    entry("Long Rest", { kind: "field", where: "Bree" }),
    entry("Short Rest", { kind: "field", where: "Bree" }),
    entry("Initiative", { kind: "panel" }),
    entry("Armor Class", { kind: "field", where: "Bree" }),
    entry("Accent color", { kind: "setting", where: "Menu · This device" }),
    entry("Constrictor Snake", { kind: "monster", where: "CR 1/4 · Beast" }),
    entry("Clay Golem", { kind: "monster", where: "CR 9 · Construct" }),
    entry("Players see the party's HP", { kind: "setting", where: "Menu · Room settings · Players" }),
    entry("Hit Points", { kind: "field", where: "Bree" }),
  ]);

  const found = (text: string) => titles(all, text).sort();

  test("every word must match, in any order, and small words may match nothing", () => {
    assert.deepEqual(found("rest long"), ["Long Rest", "Long Rest for the party"]);
    assert.deepEqual(found("the long rest"), ["Long Rest", "Long Rest for the party"]);
    assert.deepEqual(found("long rest moon"), []);
  });

  test("a typo from five letters, one in five to seven and two from eight, also in a word still being typed", () => {
    assert.deepEqual(titles(all, "shrot rest"), ["Short Rest"]);
    assert.deepEqual(titles(all, "initative"), ["Initiative"]);
    assert.deepEqual(titles(all, "initai"), ["Initiative"]);
    assert.deepEqual(titles(all, "intiaitve"), ["Initiative"], "two swaps in nine letters");
    assert.deepEqual(titles(all, "shrta rest"), [], "two typos in five letters are too many");
    assert.deepEqual(titles(items([entry("Darkness")]), "drakens"), [], "and in seven");
    assert.deepEqual(titles(items([entry("Darkness")]), "drakenss"), ["Darkness"], "two from eight");
  });

  test("four letters never take a typo: lnog rest and conc find nothing, no snake, no golem", () => {
    assert.deepEqual(titles(all, "lnog rest"), []);
    assert.deepEqual(titles(all, "conc"), []);
  });

  test("a typo's guesses show only when nothing matched without one", () => {
    const list = items([entry("Short Rest"), entry("Long Rest")]);
    assert.deepEqual(titles(list, "shrot"), ["Short Rest"]);
    const mixed = items([entry("Short Rest"), entry("Shrots")]);
    assert.deepEqual(titles(mixed, "shrot"), ["Shrots"], "a sure match puts the typo's away");
  });

  test("where it lives counts from three letters, so ac finds Armor Class and not every Action", () => {
    const list = items([entry("Armor Class", { kind: "field" }), entry("Turn sound", { where: "Actions" })]);
    assert.deepEqual(titles(list, "ac"), ["Armor Class"]);
    assert.deepEqual(titles(list, "act"), ["Turn sound"]);
  });

  test("a synonym stands for the app's words, a step below the title typed itself", () => {
    assert.equal(tierOf(entry("Armor Class"), "ac"), TIER.start);
    assert.equal(tierOf(entry("Armor Class"), "armor class"), TIER.whole);
    assert.deepEqual(titles(all, "hp"), ["Hit Points", "Players see the party's HP"]);
    assert.deepEqual(titles(items([entry("Accent color", { kind: "setting" }), entry("Armor Class", { kind: "field" })]), "ac"), ["Armor Class", "Accent color"]);
  });

  test("a synonym never matches by a typo nor where an entry lives", () => {
    const list = items([entry("Start a fight", { where: "Initiative · sight" }), entry("Senses", { kind: "field", value: "Darkvision 60 ft." })]);
    assert.deepEqual(titles(list, "los"), [], "los stands for sight, which is only where Start a fight lives");
    assert.deepEqual(titles(items([entry("Armour Clas")]), "ac"), [], "the synonym's words take no typo");
  });

  test("joined words: longrest finds Long Rest", () => {
    assert.deepEqual(found("longrest"), ["Long Rest", "Long Rest for the party"]);
    assert.equal(tierOf(entry("Long Rest"), "longrest"), TIER.start);
  });

  test("a plural finds its singular", () => {
    assert.deepEqual(titles(items([entry("Goblin 1", { kind: "token" })]), "goblins"), ["Goblin 1"]);
    assert.equal(tierOf(entry("Goblin 1"), "goblins"), TIER.title, "as the word itself, not as a typo");
  });

  test("another name typed whole ranks as a title's start, its start as a word elsewhere", () => {
    assert.equal(tierOf(entry("Long Rest for the party", { names: ["party rest"] }), "party rest"), TIER.start);
    assert.equal(tierOf(entry("Combat", { names: ["initiative rules"] }), "initiative ru"), TIER.elsewhere);
  });

  test("a best bet comes first whatever else matches, and only typed whole", () => {
    const list = items([entry("Music volume", { kind: "setting" }), entry("Now playing", { kind: "section", bets: ["music"] })]);
    assert.deepEqual(titles(list, "music"), ["Now playing", "Music volume"]);
    assert.deepEqual(titles(list, "musi"), ["Music volume"]);
  });

  test("a value counts beside the title: darkvision finds who has it", () => {
    const list = items([
      entry("Senses", { id: "kel", kind: "field", where: "Kel", value: "" }),
      entry("Senses", { id: "bree", kind: "field", where: "Bree", value: "Darkvision 60 ft." }),
      entry("Senses", { id: "orin", kind: "field", where: "Orin", value: "Blindsight 10 ft., Darkvision 120 ft." }),
    ]);
    assert.deepEqual(
      rank(list, parseQuery("darkvision")).map((e) => e.id),
      ["bree", "orin"],
    );
    assert.deepEqual(
      rank(list, parseQuery("dv")).map((e) => e.id),
      ["bree", "orin"],
    );
    // The row shows its value beside its title, so it outranks a word in another name, even an action's.
    const mixed = items([entry("Party sight", { id: "sight", names: ["darkvision goggles"] }), entry("Senses", { id: "bree", kind: "field", where: "Bree", value: "Darkvision 60 ft." })]);
    assert.deepEqual(
      rank(mixed, parseQuery("darkvision")).map((e) => e.id),
      ["bree", "sight"],
    );
  });
});

describe("ranking (design-v1-qol.md 5, Matching)", () => {
  test("tier, then nearness, then the kind's group, then cost, then the shorter title, then A to Z with numbers in order", () => {
    const list = items([
      entry("Goblin 10", { kind: "token" }),
      entry("Goblin war drums", { kind: "playlist" }),
      entry("Goblin Boss", { kind: "monster", id: "srd" }),
      entry("Goblin 2", { kind: "token" }),
      entry("Goblin cave", { kind: "scene" }),
      entry("Goblin Boss", { kind: "token", mark: "Hidden" }),
      entry("Hobgoblin Captain", { kind: "monster" }),
      entry("Goblin", { kind: "token", near: true, id: "own" }),
    ]);
    assert.deepEqual(titles(list, "goblin"), ["Goblin", "Goblin 2", "Goblin 10", "Goblin Boss", "Goblin cave", "Goblin war drums", "Goblin Boss", "Hobgoblin Captain"]);
  });

  test("the shorter title first, then A to Z with numbers in order", () => {
    assert.deepEqual(titles(items([entry("Poisoned", { kind: "condition" }), entry("Prone", { kind: "condition" })]), "p"), ["Prone", "Poisoned"]);
    assert.deepEqual(titles(items([entry("Orc 10 B"), entry("Orc 9 Bo")]), "orc"), ["Orc 9 Bo", "Orc 10 B"]);
  });

  test("rows equal in all else keep the id's order, whatever order the index holds them in", () => {
    const a = indexed(entry("Senses", { id: "field:a", kind: "field", where: "Bree" }));
    const b = indexed(entry("Senses", { id: "field:b", kind: "field", where: "Bree" }));
    assert.deepEqual(rank([b, a], parseQuery("senses")).map((e) => e.id), ["field:a", "field:b"]);
    assert.deepEqual(rank([a, b], parseQuery("senses")).map((e) => e.id), ["field:a", "field:b"]);
  });

  test("nearness outranks the kind but not the tier", () => {
    const list = items([entry("Prone", { kind: "condition", near: true }), entry("Prone tokens", { kind: "action" }), entry("Prone", { kind: "action", id: "far" })]);
    assert.deepEqual(rank(list, parseQuery("prone")).map((e) => `${e.kind}:${e.title}`), ["condition:Prone", "action:Prone", "action:Prone tokens"]);
  });

  test("at most forty rows", () => {
    const list = items(Array.from({ length: 60 }, (_, i) => entry(`Goblin ${i + 1}`, { kind: "token" })));
    const rows = titles(list, "goblin");
    assert.equal(rows.length, MAX_ROWS);
    assert.deepEqual(rows.slice(0, 3), ["Goblin 1", "Goblin 2", "Goblin 3"]);
  });

  test("equal rows always keep one order, whatever order the index holds them in", () => {
    const words = ["goblin", "rest", "long", "boss", "short", "fight", "init", "sense", "darkvision", "cave"];
    const kinds: SearchKind[] = ["action", "token", "field", "setting", "monster", "scene"];
    const anEntry = fc.record({
      title: fc.array(fc.constantFrom(...words, "of", "2", "10"), { minLength: 1, maxLength: 4 }).map((w) => w.join(" ")),
      kind: fc.constantFrom(...kinds),
      where: fc.constantFrom("", "Bree", "Menu · Room settings"),
      near: fc.boolean(),
    });
    const lists = fc.array(anEntry, { minLength: 1, maxLength: 30 }).chain((raw) => fc.tuple(fc.constant(raw), fc.shuffledSubarray([...raw.keys()], { minLength: raw.length, maxLength: raw.length })));
    fc.assert(
      fc.property(lists, fc.constantFrom(...words, "lnog", "shrot rest", "go b"), ([raw, order], text) => {
        const list = raw.map((r, i) => indexed(entry(r.title, { id: `e${i}`, kind: r.kind, where: r.where, near: r.near })));
        const shuffled = order.map((i) => list[i]!);
        assert.deepEqual(rank(shuffled, parseQuery(text)), rank(list, parseQuery(text)));
      }),
    );
  });
});

describe("the memo of word grades", () => {
  test("a memo carried over many entries grades as a fresh one does", () => {
    const words = fc.stringMatching(/^[a-z]{1,10}$/);
    fc.assert(
      fc.property(fc.array(fc.array(words, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 20 }), fc.array(words, { minLength: 1, maxLength: 3 }), (titleWords, typed) => {
        const shared = parseQuery(typed.join(" "));
        for (const t of titleWords) {
          const s = searchable({ title: t.join(" "), where: "" });
          assert.deepEqual(matchEntry(shared, s), matchEntry(parseQuery(typed.join(" ")), s));
        }
      }),
    );
  });
});

describe("the typo distance", () => {
  test("is Damerau's: an adjacent swap counts one", () => {
    assert.equal(distance("shrot", "short", 2), 1);
    assert.equal(distance("initative", "initiative", 2), 1);
    assert.equal(distance("abc", "abc", 1), 0);
    assert.equal(distance("kitten", "sitting", 5), 3);
  });

  test("gives up past the most it is asked for", () => {
    assert.equal(distance("aaaaa", "bbbbb", 1), 2);
  });
});

describe("the words file", () => {
  test("every synonym's key is one folded word and its phrases are folded", () => {
    for (const [key, phrases] of Object.entries(SYNONYMS)) {
      assert.equal(fold(key), key, key);
      assert.ok(!key.includes(" "), key);
      for (const p of phrases) assert.equal(fold(p), p, `${key}: ${p}`);
    }
  });
});
