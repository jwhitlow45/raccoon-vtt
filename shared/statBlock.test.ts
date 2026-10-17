import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { monsterInputSchema } from "./protocol.ts";
import { fitLine, loadMonsters, monsterActor, tokenUses, type SrdMonster } from "./srd/monsters.ts";
import {
  emptyStatBlock,
  hpAverage,
  legendaryUses,
  monsterView,
  proficiencyBonus,
  speedsOf,
  statBlockFromSrd,
  statBlockMarkdown,
  XP_BY_CR,
} from "./statBlock.ts";

let monsters: readonly SrdMonster[] = [];

before(async () => {
  monsters = await loadMonsters();
});

/** Four SRD blocks print "(700 XP; ..." where the rest print "(XP 700; ...". The app writes the usual form. */
function usualCr(markdown: string): string {
  return markdown.replace(/\*\*CR\*\* (\S+) \(([\d,]+) XP;/, "**CR** $1 (XP $2;");
}

describe("custom monsters in the SRD shape", () => {
  test("a block with no creature type or alignment reads without a gap or comma for them", () => {
    const line = (over: Partial<ReturnType<typeof emptyStatBlock>>) => statBlockMarkdown({ ...emptyStatBlock(), name: "Wisp", ...over }).split("\n\n")[1];
    assert.equal(line({}), "*Medium*");
    assert.equal(line({ type: "Fey" }), "*Medium Fey*");
    assert.equal(line({ alignment: "Unaligned" }), "*Medium, Unaligned*");
    assert.equal(line({ type: "Fey", alignment: "Unaligned", sizeAlt: "small" }), "*Medium or Small Fey, Unaligned*");
  });

  test("every SRD monster reads into fields and writes back to the same Markdown", () => {
    let unusual = 0;
    for (const m of monsters) {
      const block = statBlockFromSrd(m);
      const markdown = statBlockMarkdown(block);
      if (usualCr(m.statBlock) !== m.statBlock) unusual++;
      assert.equal(markdown, usualCr(m.statBlock), m.name);
    }
    assert.equal(unusual, 4);
  });

  test("every SRD monster's light fields come back from its fields", () => {
    for (const m of monsters) {
      const { srdId: _srdId, statBlock: _statBlock, ...light } = m;
      const { statBlock: _md, ...view } = monsterView(statBlockFromSrd(m));
      assert.deepEqual(view, light, m.name);
    }
  });

  test("tokens from a custom copy match tokens from the SRD monster, except the SRD id", () => {
    for (const m of monsters) {
      const { srdId: _srdId, ...fromSrd } = monsterActor(m, { inLair: true });
      assert.deepEqual(monsterActor(monsterView(statBlockFromSrd(m)), { inLair: true }), fromSrd, m.name);
    }
  });

  test("a line too long for a token is cut with an ellipsis, never through a character", () => {
    assert.equal(fitLine("Darkvision 60 ft."), "Darkvision 60 ft.");
    assert.equal(fitLine("a".repeat(80)), "a".repeat(80));
    assert.equal(fitLine("a".repeat(81)), `${"a".repeat(79)}…`);
    // The 79th code unit opens a pair, so the cut comes before the whole character.
    const eye = "\u{1F441}";
    assert.equal(fitLine(`${"a".repeat(78)}${eye}${eye}`), `${"a".repeat(78)}…`);
    assert.equal(fitLine(`${"a".repeat(77)}${eye}${eye}`), `${"a".repeat(77)}${eye}…`);
    assert.equal(fitLine(`${"a".repeat(70)}          ${"b".repeat(10)}`), `${"a".repeat(70)}…`);
  });

  test("tokens hold at most 10 legendary uses, however many a block prints", () => {
    assert.equal(tokenUses(3), 3);
    assert.equal(tokenUses(10), 10);
    assert.equal(tokenUses(12), 10);
  });

  test("every SRD monster fits the protocol's bounds for a custom monster", () => {
    for (const m of monsters) {
      const parsed = monsterInputSchema.safeParse({ id: "m1", ...statBlockFromSrd(m) });
      assert.ok(parsed.success, `${m.name}: ${parsed.success ? "" : parsed.error.message}`);
    }
  });

  test("text that looks like Markdown stays text", () => {
    const block = { ...emptyStatBlock(), name: "Mr. *Stabby*", traits: [{ name: "Under_score", text: "Deals `1` damage\\n.\n• A *bullet*" }] };
    const markdown = statBlockMarkdown(block);
    assert.match(markdown, /^## Mr\. \\\*Stabby\\\*\n/);
    assert.match(markdown, /\*\*Under\\_score\.\*\* Deals \\`1\\` damage\\\\n\.\n\n- A \\\*bullet\\\*/);
  });

  test("spell lists and bullets group into lists, and blank lines are dropped", () => {
    const block = {
      ...emptyStatBlock(),
      actions: [
        { name: "Spellcasting", text: "It casts one of these:\nAt Will: Light\n1/Day Each: Fly, Haste\n\nAfterwards it rests.\n• One\n• Two" },
        { name: "", text: "A paragraph with no name." },
      ],
    };
    const body = statBlockMarkdown(block).split("### Actions\n\n")[1];
    assert.equal(
      body,
      "**Spellcasting.** It casts one of these:\n\n- **At Will:** Light\n- **1/Day Each:** Fly, Haste\n\nAfterwards it rests.\n\n- One\n- Two\n\nA paragraph with no name.",
    );
  });
});

describe("stat block arithmetic", () => {
  test("speeds read like the SRD import's, leniently", () => {
    assert.deepEqual(speedsOf("30 ft., Fly 60 ft. (hover), Swim 30 ft."), { walk: 30, fly: 60, hover: true, swim: 30 });
    assert.deepEqual(speedsOf("30 ft., 40 ft. (bear form only), Climb 30 ft. (bear form only)"), { walk: 30 });
    assert.deepEqual(speedsOf("20 ft., Climb or Fly 20 ft. (GM’s choice)"), { walk: 20, climb: 20, fly: 20 });
    assert.deepEqual(speedsOf("40 ft., burrow 20 ft., climb 40 ft."), { walk: 40, burrow: 20, climb: 40 });
    assert.deepEqual(speedsOf("0 ft., Fly 50 ft. (hover)"), { walk: 0, fly: 50, hover: true });
    assert.deepEqual(speedsOf("whatever the DM likes"), { walk: 0 });
    assert.deepEqual(speedsOf("99999 ft."), { walk: 1_000 });
  });

  test("hit dice averages, proficiency by CR, and XP by CR", () => {
    assert.equal(hpAverage("20d10 + 40"), 150);
    assert.equal(hpAverage("1d4 - 1"), 1);
    assert.equal(hpAverage("1d4 − 1"), 1);
    assert.equal(hpAverage("18d8"), 81);
    assert.equal(hpAverage("1d4 - 9"), 0);
    assert.equal(hpAverage("lots"), null);
    assert.deepEqual(["0", "1/2", "4", "5", "8", "9", "16", "17", "21", "29", "30"].map(proficiencyBonus), [2, 2, 2, 3, 3, 4, 5, 6, 7, 9, 9]);
    assert.equal(XP_BY_CR["10"], 5900);
  });

  test("legendary uses come from the entries that print them, in either edition's words", () => {
    const block = emptyStatBlock();
    assert.deepEqual(legendaryUses(block), {});
    block.traits = [{ name: "Legendary Resistance (3/Day, or 4/Day in Lair)", text: "..." }];
    block.legendaryActions = [{ name: "Legendary Action Uses: 3 (4 in Lair)", text: "..." }];
    assert.deepEqual(legendaryUses(block), { legendaryActions: { uses: 3, usesInLair: 4 }, legendaryResistance: { uses: 3, usesInLair: 4 } });
    block.traits = [{ name: "Legendary Resistance (2/Day)", text: "..." }];
    block.legendaryActions = [{ name: "", text: "The lich can take 3 legendary actions, choosing from the options below." }];
    assert.deepEqual(legendaryUses(block), { legendaryActions: { uses: 3 }, legendaryResistance: { uses: 2 } });
  });

  test("a blank stat block is a valid monster once it has a name", () => {
    assert.equal(monsterInputSchema.safeParse({ id: "m1", ...emptyStatBlock() }).success, false);
    assert.ok(monsterInputSchema.safeParse({ id: "m1", ...emptyStatBlock(), name: "Thing" }).success);
  });
});
