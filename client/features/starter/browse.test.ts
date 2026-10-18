import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StarterPack, StarterUse, StarterWork } from "#shared/starter.ts";
import { byCategory, findShown, packLicenses, packLine, resultLine, searchGroups, tileSource, workCredit } from "./browse.ts";

function work(pack: string, slug: string, over: Partial<StarterWork> = {}): StarterWork {
  return {
    key: `${pack}/${slug}`,
    id: slug.toUpperCase(),
    name: slug.replace(/-/g, " "),
    category: "Monsters",
    tags: [],
    uses: ["token"] as StarterUse[],
    file: `/starter/${pack}/${slug}.webp`,
    thumb: `/starter/${pack}/thumbs/${slug}.webp`,
    sha256: "0".repeat(64),
    width: 512,
    height: 512,
    bytes: 1000,
    original: { width: 1024, height: 1024 },
    credit: { title: slug, author: "Oozejar", source: "https://example.test/bestiary", license: "CC-BY-SA-4.0", changes: "Resized." },
    ...over,
  };
}

function pack(id: string, works: StarterWork[], over: Partial<StarterPack> = {}): StarterPack {
  return { id, title: id, author: "Oozejar", page: "https://example.test", wayback: "https://web.archive.org/x", licenses: ["CC-BY-SA-4.0"], changes: "Resized.", works, ...over };
}

const bestiary = pack(
  "bestiary",
  [
    work("bestiary", "owlbear", { category: "Monstrosities", tags: ["forest"] }),
    work("bestiary", "red-dragon", { category: "Dragons", tags: ["fire"] }),
    work("bestiary", "mimic", { category: "Monstrosities", tags: ["chest"] }),
  ],
  { title: "Illustrated Bestiary" },
);
const flare = pack(
  "flare",
  [
    work("flare", "knight", { category: "Heroes", credit: { title: "Knight", author: "Justin Nichol", source: "https://example.test/flare", license: "CC-BY-SA-3.0", changes: "" } }),
    work("flare", "elf", { category: "Heroes", credit: { title: "Elf", author: "Justin Nichol", source: "https://example.test/flare", license: "CC-BY-3.0", changes: "" } }),
  ],
  { title: "Flare Hero Portraits", author: "Justin Nichol", licenses: ["CC-BY-SA-3.0", "CC-BY-3.0"] },
);
const packs = [bestiary, flare];

describe("a pack's line", () => {
  test("names its author, its licenses by their names and its count", () => {
    assert.equal(packLine(bestiary), "Oozejar, CC BY-SA 4.0, 3 works");
    assert.equal(packLine(flare), "Justin Nichol, CC BY-SA 3.0 and CC BY 3.0, 2 works");
    assert.equal(packLine(pack("one", [work("one", "x")])), "Oozejar, CC BY-SA 4.0, 1 work");
    assert.equal(packLicenses({ licenses: ["public-domain-dedication"] }), "Public domain dedication");
  });

  test("its works sit under their categories in the order the pack first names each", () => {
    assert.deepEqual(
      byCategory(bestiary).map((c) => [c.name, c.works.map((w) => w.key)]),
      [
        ["Monstrosities", ["bestiary/owlbear", "bestiary/mimic"]],
        ["Dragons", ["bestiary/red-dragon"]],
      ],
    );
  });
});

describe("a search", () => {
  test("groups its results by pack in catalog order", () => {
    const found = searchGroups(packs, "e");
    assert.deepEqual(
      found.groups.map((g) => [g.pack.id, g.works.map((w) => w.key)]),
      [["flare", ["flare/elf"]]],
    );
    // "f" starts the forest and fire tags in the bestiary and the Flare pack's own name.
    const both = searchGroups(packs, "f");
    assert.deepEqual(
      both.groups.map((g) => [g.pack.id, g.works.map((w) => w.key)]),
      [
        ["bestiary", ["bestiary/owlbear", "bestiary/red-dragon"]],
        ["flare", ["flare/knight", "flare/elf"]],
      ],
    );
  });

  test("matches words typed with their marks, as the catalog's own words are split at them", () => {
    assert.equal(searchGroups(packs, "Red-dragon,").total, 1);
    assert.equal(searchGroups(packs, "(mimic)").total, 1);
    const tower = pack("maps", [work("maps", "tower", { name: "The Mage's Tower" })]);
    assert.equal(searchGroups([tower], "mage's tow").total, 1);
  });

  test("is cut at the cap, saying how many matched and how many show", () => {
    const cut = searchGroups(packs, "oozejar", 2);
    assert.equal(cut.total, 3);
    assert.equal(cut.shown, 2);
    assert.deepEqual(
      cut.groups.flatMap((g) => g.works.map((w) => w.key)),
      ["bestiary/owlbear", "bestiary/red-dragon"],
    );
    assert.equal(resultLine({ packs, query: "oozejar", search: cut }), "3 works match. The first 2 are shown, so type more to narrow it.");
  });

  test("says what it found, or that nothing matched, and with no words the packs and works shown", () => {
    assert.equal(resultLine({ packs, query: "", search: null }), "2 packs, 5 works.");
    assert.equal(resultLine({ packs: [flare], query: "  ", search: null }), "1 pack, 2 works.");
    assert.equal(resultLine({ packs, query: "mimic", search: searchGroups(packs, "mimic") }), "1 work matches.");
    assert.equal(resultLine({ packs, query: "dragon fire", search: searchGroups(packs, "dragon fire") }), "1 work matches.");
    assert.equal(resultLine({ packs, query: "goblin", search: searchGroups(packs, "goblin") }), "Nothing matches. Try fewer or shorter words.");
  });
});

describe("the chosen work", () => {
  test("credits the work's own author and license, linked where the license has a page", () => {
    assert.deepEqual(workCredit({ pack: flare, work: flare.works[1]! }), {
      name: "elf",
      pack: "Flare Hero Portraits",
      author: "Justin Nichol",
      license: "CC BY 3.0",
      licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
    });
    const dedicated = work("scarlet", "keep", { credit: { title: "Keep", author: "Dyson Logos", source: "https://example.test/sh", license: "public-domain-dedication", changes: "" } });
    assert.equal(workCredit({ pack: pack("scarlet", [dedicated]), work: dedicated }).licenseUrl, null);
  });

  test("is found among the packs shown by its key, and a key no pack shows finds nothing", () => {
    assert.equal(findShown(packs, "flare/knight")?.pack.id, "flare");
    assert.equal(findShown(packs, "maps/crypt"), null);
    assert.equal(findShown(packs, null), null);
  });

  test("shows its thumbnail, or a stamp's own file when it has none", () => {
    assert.equal(tileSource({ thumb: "/starter/a/thumbs/b.webp", file: "/starter/a/b.webp" }), "/starter/a/thumbs/b.webp");
    assert.equal(tileSource({ file: "/stamps/polyhaven-bench.webp" }), "/stamps/polyhaven-bench.webp");
  });
});
