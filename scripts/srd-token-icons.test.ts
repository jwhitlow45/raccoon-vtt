import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ICON_COLORS, ICON_NEUTRALS } from "../client/features/images/iconColors.ts";
import { MEMBER_COLOR_NAMES } from "../client/lib/theme.ts";
import { TOKEN_ICONS } from "../shared/credits.ts";
import { ICON_KEY_RE } from "../shared/imageRef.ts";
import type { SrdMonster } from "../shared/srd/monsters.ts";
import { SRD_TOKEN_ICONS } from "../shared/srd/tokenIcons.ts";
import { MODULE, parseTable, readKnown, readTable, tableProblems, tokenIconsModule, type TokenIconRow } from "./srd-token-icons.ts";

const MONSTERS = JSON.parse(readFileSync(new URL("../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const rows = readTable();
const known = readKnown();
const rowOf = (srdId: string) => rows.find((r) => r.srdId === srdId) ?? assert.fail(`no row for ${srdId}`);

/** The swatches by the names the picker reads out, so the rule below reads as the design words it. */
const COLOR: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MEMBER_COLOR_NAMES).map(([hex, name]) => [name, hex])),
  Gray: ICON_NEUTRALS[0],
  Slate: ICON_NEUTRALS[1],
  Black: ICON_NEUTRALS[3],
};

/**
 * The design's rule (docs/design-v1-starter-art.md section 6), written out
 * again here rather than shared with the script, so the reviewed table is
 * checked against the rule and not against itself. A tag in brackets
 * does not change the color, a swarm takes its creatures' color, and a
 * chromatic or metallic dragon the color its name gives.
 */
const BY_TYPE: Record<string, string> = {
  Aberration: "Purple",
  Beast: "Brown",
  Celestial: "Yellow",
  Construct: "Gray",
  Dragon: "Coral",
  Elemental: "Orange",
  Fey: "Pink",
  Fiend: "Coral",
  Giant: "Slate",
  Humanoid: "Blue",
  Monstrosity: "Teal",
  Ooze: "White",
  Plant: "Green",
  Undead: "Black",
};
const BY_DRAGON: Record<string, string> = {
  Black: "Black",
  Blue: "Blue",
  Green: "Green",
  Red: "Coral",
  White: "White",
  Brass: "Orange",
  Bronze: "Brown",
  Copper: "Brown",
  Gold: "Yellow",
  Silver: "Gray",
};

function ruleColor(m: Pick<SrdMonster, "name" | "type">): string | undefined {
  if (/^Dragon \((Chromatic|Metallic)\)$/.test(m.type)) {
    const named = m.name.split(" ").filter((word) => word in BY_DRAGON);
    return named.length === 1 ? BY_DRAGON[named[0]!] : undefined;
  }
  const base = m.type.replace(/ \(.*\)$/, "");
  const swarm = /^Swarm of Tiny (Beasts|Undead)$/.exec(base)?.[1];
  return BY_TYPE[swarm === "Beasts" ? "Beast" : (swarm ?? base)];
}

describe("the SRD token table", () => {
  test("has one row for every SRD monster, once, in the SRD's order", () => {
    assert.equal(rows.length, 330);
    assert.deepEqual(
      rows.map((r) => r.srdId),
      MONSTERS.map((m) => m.srdId),
    );
    assert.equal(new Set(rows.map((r) => r.srdId)).size, rows.length);
    assert.equal(rowOf("dragon-turtle").icon, "lorc/turtle");
  });

  test("names only icons the app ships, as keys the app accepts", () => {
    for (const r of rows) {
      assert.match(r.icon, ICON_KEY_RE, r.srdId);
      assert.ok(known.icons.has(r.icon), `${r.srdId}: ${r.icon} is not shipped`);
    }
  });

  test("colors every disk with a swatch the icon picker offers", () => {
    for (const r of rows) assert.ok(ICON_COLORS.includes(r.color), `${r.srdId}: ${r.color}`);
  });

  test("credits every icon's author already, under CC BY 3.0", () => {
    for (const r of rows) {
      const author = TOKEN_ICONS.authors.find((a) => a.id === r.icon.split("/")[0]);
      assert.ok(author, `${r.srdId}: ${r.icon} has no credited author`);
      assert.equal(author.license, "CC-BY-3.0", r.icon);
    }
  });

  test("colors each disk by creature type, and a chromatic or metallic dragon by its name", () => {
    for (const m of MONSTERS) {
      const name = ruleColor(m);
      assert.ok(name, `${m.srdId}: the rule has no color for ${m.type}`);
      assert.equal(rowOf(m.srdId).color, COLOR[name], `${m.srdId} (${m.type}) should be ${name}`);
    }
    const spot: [string, string][] = [
      ["aboleth", "Purple"],
      ["wolf", "Brown"],
      ["tyrannosaurus-rex", "Brown"],
      ["swarm-of-rats", "Brown"],
      ["solar", "Yellow"],
      ["iron-golem", "Gray"],
      ["djinni", "Orange"],
      ["goblin-warrior", "Pink"],
      ["pit-fiend", "Coral"],
      ["hill-giant", "Slate"],
      ["mage", "Blue"],
      ["werewolf", "Teal"],
      ["black-pudding", "White"],
      ["shambling-mound", "Green"],
      ["lich", "Black"],
      ["swarm-of-crawling-claws", "Black"],
      ["ancient-black-dragon", "Black"],
      ["young-blue-dragon", "Blue"],
      ["green-dragon-wyrmling", "Green"],
      ["adult-red-dragon", "Coral"],
      ["white-dragon-wyrmling", "White"],
      ["ancient-brass-dragon", "Orange"],
      ["adult-bronze-dragon", "Brown"],
      ["copper-dragon-wyrmling", "Brown"],
      ["young-gold-dragon", "Yellow"],
      ["young-silver-dragon", "Gray"],
      ["dragon-turtle", "Coral"],
      ["pseudodragon", "Coral"],
      ["kobold-warrior", "Coral"],
      ["wyvern", "Coral"],
    ];
    for (const [srdId, name] of spot) assert.equal(rowOf(srdId).color, COLOR[name], `${srdId} is ${name}`);
    // Bronze and copper share brown, so their tokens of one age are one token.
    assert.deepEqual(SRD_TOKEN_ICONS["adult-bronze-dragon"], SRD_TOKEN_ICONS["adult-copper-dragon"]);
  });

  test("has the reviewed counts the design quotes", () => {
    const count = (match: string) => rows.filter((r) => r.match === match).length;
    assert.deepEqual([count("exact"), count("close"), count("generic")], [113, 214, 3]);
    assert.equal(new Set(rows.map((r) => r.icon)).size, 265);
    assert.deepEqual(
      rows.filter((r) => r.match === "generic").map((r) => r.srdId),
      ["ettin", "giant-weasel", "weasel"],
    );
    for (const r of rows) assert.ok(r.why.trim().length > 0, `${r.srdId} says why`);
  });
});

describe("the SRD token script", () => {
  test("wrote the committed module from the table", () => {
    assert.equal(readFileSync(MODULE, "utf8"), tokenIconsModule(rows));
  });

  test("the module maps every SRD id to its row's icon and color, and nothing else", () => {
    assert.deepEqual(Object.keys(SRD_TOKEN_ICONS), MONSTERS.map((m) => m.srdId));
    for (const r of rows) assert.deepEqual(SRD_TOKEN_ICONS[r.srdId], { icon: r.icon, color: r.color }, r.srdId);
  });

  test("finds nothing wrong with the committed table", () => {
    assert.deepEqual(tableProblems(rows, known), []);
  });

  test("names every way a table can disagree with the app", () => {
    const row = (srdId: string, icon: string, color: string): TokenIconRow => ({ srdId, icon, color, match: "exact", why: "test" });
    const small = { srdIds: ["wolf", "owl", "bat"], icons: new Set(["lorc/wolf-head", "lorc/owl"]), colors: ["#ad7f58"] };
    assert.deepEqual(
      tableProblems([row("wolf", "lorc/wolf-head", "#ad7f58"), row("wolf", "lorc/wolf-head", "#ad7f58"), row("unicorn", "lorc/owl", "#ad7f58"), row("owl", "lorc/../owl", "#123456"), row("bat", "lorc/bat", "#ad7f58")], small),
      [
        "wolf has two rows",
        "unicorn is not an SRD monster",
        "owl: lorc/../owl is not an icon key",
        "owl: #123456 is not a disk color the picker offers",
        "bat: lorc/bat is not in the shipped icon set",
      ],
    );
    assert.deepEqual(tableProblems([row("wolf", "lorc/wolf-head", "#ad7f58")], small), ["owl has no row", "bat has no row"]);
  });

  test("reads only rows of the table's shape", () => {
    const good = { srdId: "wolf", icon: "lorc/wolf-head", color: "#ad7f58", match: "close", why: "a wolf's head" };
    assert.deepEqual(parseTable([good]), [good]);
    assert.throws(() => parseTable({ rows: [good] }), /not an array/);
    assert.throws(() => parseTable([{ ...good, match: "near" }]), /row 1/);
    assert.throws(() => parseTable([good, { ...good, icon: 7 }]), /row 2/);
    assert.throws(() => parseTable([null]), /row 1/);
  });
});
