import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { StatBlock } from "#shared/model.ts";
import { monsterInputSchema } from "#shared/protocol.ts";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { abilityMod, statBlockFromSrd } from "#shared/statBlock.ts";
import { parseStatBlockText } from "./parse.ts";
import { pdfText, text2014, webText } from "./testing.ts";

/**
 * The paste parser against every SRD 5.2.1 monster, written out as text the
 * ways a copy and paste gives it (testing.ts), then read back and compared
 * with the fields it came from.
 */
let blocks: { name: string; block: StatBlock }[] = [];

before(async () => {
  const monsters: readonly SrdMonster[] = await loadMonsters();
  blocks = monsters.map((m) => ({ name: m.name, block: statBlockFromSrd(m) }));
});

/** A PDF's line breaks cannot tell a wrapped line from a new paragraph, so the comparison joins paragraphs inside an entry. */
function joinParagraphs(block: StatBlock): StatBlock {
  const join = (text: string) =>
    text
      .split("\n")
      .reduce<string[]>((out, line) => {
        const item = /^(At Will|\d+\/Day(?: Each)?): |^• /.test(line);
        const last = out.length - 1;
        if (!item && last >= 0 && !/^(At Will|\d+\/Day(?: Each)?): |^• /.test(out[last]!)) out[last] = `${out[last]} ${line}`;
        else out.push(line);
        return out;
      }, [])
      .join("\n");
  const sections = { traits: block.traits, actions: block.actions, bonusActions: block.bonusActions, reactions: block.reactions, legendaryActions: block.legendaryActions };
  const out = { ...block };
  for (const [key, entries] of Object.entries(sections)) out[key as keyof typeof sections] = entries.map((e) => ({ ...e, text: join(e.text) }));
  return out;
}

/** The Shrieker Fungus has no actions, and the parser says so, since nearly every monster has some. */
function expectedWarnings(block: StatBlock): string[] {
  return block.actions.length === 0 ? ["No actions were found."] : [];
}

describe("pasted stat blocks", () => {
  test("every SRD monster copied from a web page reads back exactly", () => {
    for (const { name, block } of blocks) {
      const parsed = parseStatBlockText(webText(block));
      assert.deepEqual(parsed.block, block, name);
      assert.deepEqual(parsed.warnings, expectedWarnings(block), name);
    }
  });

  test("every SRD monster copied from a PDF reads back, its wrapped lines joined", () => {
    for (const { name, block } of blocks) {
      const parsed = parseStatBlockText(pdfText(block));
      assert.deepEqual(joinParagraphs(parsed.block), joinParagraphs(block), name);
      assert.deepEqual(parsed.warnings, expectedWarnings(block), name);
    }
  });

  test("a PDF of any column width reads back the same", () => {
    for (const width of [32, 60, 90]) {
      for (const { name, block } of blocks) {
        assert.deepEqual(joinParagraphs(parseStatBlockText(pdfText(block, width)).block), joinParagraphs(block), `${name} at ${width}`);
      }
    }
  });

  test("a phone's copy with one table cell per line, Windows line ends and invisible characters reads the same", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const ltrMark = String.fromCharCode(0x200e);
    const nbsp = String.fromCharCode(0xa0);
    for (const { name, block } of blocks.slice(0, 40)) {
      const text = webText(block)
        .split("\n")
        .flatMap((line) => (line.includes("\t") ? line.split("\t") : [line]))
        .map((line, i) => (i % 3 === 0 ? `${ltrMark}${line}${zeroWidth}` : line.replace(/ /g, nbsp)))
        .join("\r\n");
      assert.deepEqual(parseStatBlockText(text).block, block, name);
    }
  });

  test("a name printed in capitals comes back in title case", () => {
    const { block } = blocks.find((b) => b.name === "Goblin Warrior")!;
    assert.equal(parseStatBlockText(webText({ ...block, name: "GOBLIN WARRIOR" })).block.name, "Goblin Warrior");
    const { block: dragon } = blocks.find((b) => b.name === "Adult Red Dragon")!;
    assert.equal(parseStatBlockText(pdfText({ ...dragon, name: "ADULT RED DRAGON" })).block.name, "Adult Red Dragon");
  });

  test("lines around the block are skipped: a page title above it, habitat and treasure below", () => {
    const { block } = blocks.find((b) => b.name === "Goblin Warrior")!;
    const text = `Monsters (G)\nPage 142\n${webText(block)}\nHabitat: Forest, Underdark; Treasure: Arms`;
    const parsed = parseStatBlockText(text);
    assert.deepEqual(parsed.block, block);
    assert.deepEqual(parsed.warnings, []);
  });

  test("whatever is pasted, it never throws and always gives a block the editor can save once named", () => {
    const inputs = [
      "",
      "   \n\n  ",
      "Just a note about goblins.",
      "Grumbler\nMedium Fey, Chaotic Neutral\nAC 999 Initiative +99 (109)\nHP 999999 (999d999 + 99999)\nSTR 99 +44 +44\nCR 1/3 (XP 5)",
      `Long One\nHuge Dragon, Lawful Evil\nSkills ${"Stealth +1, ".repeat(80)}\nActions\nBreath. ${"Fire. ".repeat(1_000)}`,
      `Many\nTiny Beast, Unaligned\nActions\n${Array.from({ length: 60 }, (_, i) => `Peck ${String.fromCharCode(65 + (i % 26))}${i}. It pecks.`).join("\n")}`,
    ];
    for (const input of inputs) {
      const parsed = parseStatBlockText(input);
      assert.ok(parsed.warnings.length > 0, input.slice(0, 40));
      const named = { id: "m1", ...parsed.block, name: parsed.block.name.slice(0, 80) || "Unnamed" };
      const check = monsterInputSchema.safeParse(named);
      assert.ok(check.success, `${input.slice(0, 40)}: ${check.success ? "" : check.error.message}`);
    }
    const grumbler = parseStatBlockText(inputs[3]!);
    assert.equal(grumbler.block.ac, 100);
    assert.equal(grumbler.block.initiative, 40);
    assert.equal(grumbler.block.hp.average, 100_000);
    assert.equal(grumbler.block.abilities.str.score, 99);
    assert.ok(grumbler.warnings.includes("No challenge rating was found."));
    assert.ok(grumbler.warnings.includes("Only 1 of the six ability scores were found."));
    const many = parseStatBlockText(inputs[5]!);
    assert.equal(many.block.actions.length, 40);
    assert.ok(many.warnings.includes("Only the first 40 entries of a section were kept."));
  });

  test("a block with only a name says what is missing, and keeps the blank block's values", () => {
    const parsed = parseStatBlockText("Mystery Beast");
    assert.equal(parsed.block.name, "Mystery Beast");
    assert.equal(parsed.block.ac, 10);
    assert.deepEqual(parsed.warnings, [
      "No size, type and alignment line was found.",
      "No AC was found.",
      "No ability scores were found.",
      "No initiative was given, so it is the Dexterity modifier.",
      "No Hit Points were found.",
      "No speed was found.",
      "No Passive Perception was given, so it is 10 plus the Wisdom modifier.",
      "No challenge rating was found.",
      "No actions were found.",
    ]);
  });

  test("every SRD monster in the 2014 layout reads back what that layout prints", () => {
    for (const { name, block } of blocks) {
      const parsed = parseStatBlockText(text2014(block));
      // The 2014 layout has no initiative, gear or lair XP, and prints the type and damage types in lower case.
      const lowered = ["type", "vulnerabilities", "resistances", "immunities"] as const;
      const expected: StatBlock = { ...block, initiative: abilityMod(block.abilities.dex.score), gear: "" };
      for (const key of lowered) {
        assert.equal(parsed.block[key].toLowerCase(), block[key].toLowerCase(), `${name} ${key}`);
        expected[key] = parsed.block[key];
      }
      delete expected.xpInLair;
      assert.deepEqual(parsed.block, expected, name);
      assert.deepEqual(parsed.warnings, ["No initiative was given, so it is the Dexterity modifier.", ...expectedWarnings(block)], name);
    }
  });
});
