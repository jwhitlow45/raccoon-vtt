import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { searchWorks, type StarterPack, type StarterWork } from "./starter.ts";

function work(pack: string, slug: string, over: Partial<StarterWork> = {}): StarterWork {
  return {
    key: `${pack}/${slug}`,
    id: slug.toUpperCase(),
    name: slug.replace(/-/g, " "),
    category: "Maps",
    tags: [],
    uses: ["map"],
    file: `/starter/${pack}/${slug}.webp`,
    sha256: "0".repeat(64),
    width: 512,
    height: 512,
    bytes: 1000,
    original: { width: 1024, height: 1024 },
    credit: { title: slug, author: "Dyson Logos", source: "https://example.test/maps", license: "CC-BY-4.0", changes: "Resized." },
    ...over,
  };
}

const MAPS: StarterPack = {
  id: "maps",
  title: "Dyson's Maps",
  author: "Dyson Logos",
  page: "https://example.test",
  wayback: "https://web.archive.org/x",
  licenses: ["CC-BY-4.0"],
  changes: "Resized.",
  works: [work("maps", "tower", { name: "The Mage's Tower", tags: ["wizard"] }), work("maps", "red-dragon-lair", { tags: ["cave", "fire"] }), work("maps", "bowl", { name: "Bowl Hill" })],
};

const keys = (query: string) => searchWorks([MAPS], query).map((f) => f.work.key);

describe("searchWorks", () => {
  test("matches words typed with their marks, split at them as the catalog's own words are, wherever the search runs", () => {
    assert.deepEqual(keys("The Mage's Tower"), ["maps/tower"]);
    assert.deepEqual(keys("mage's tow"), ["maps/tower"]);
    assert.deepEqual(keys("Red-dragon,"), ["maps/red-dragon-lair"]);
    assert.deepEqual(keys("(lair)"), ["maps/red-dragon-lair"]);
    assert.deepEqual(keys("dyson's"), ["maps/tower", "maps/red-dragon-lair", "maps/bowl"], "the pack's title and author count");
  });

  test("matches whole-word prefixes, so owl finds no bowl", () => {
    assert.deepEqual(keys("owl"), []);
    assert.deepEqual(keys("bow"), ["maps/bowl"]);
    assert.deepEqual(keys("fire cave"), ["maps/red-dragon-lair"], "every word, in any order");
  });

  test("marks alone, or nothing typed, match every work in catalog order", () => {
    for (const query of ["", "   ", "--, '"]) assert.deepEqual(keys(query), ["maps/tower", "maps/red-dragon-lair", "maps/bowl"], JSON.stringify(query));
  });
});
