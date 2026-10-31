import "../../components/testing/register.ts";
import { withoutFrames } from "../../components/testing/proficiencyMarkup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import { customMonster } from "#shared/testutil.ts";
import { splitAbilityTable } from "./abilityTable.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { StatBlockView } = await import("./StatBlockView.tsx");

const TABLE = ["| | Score | Mod | Save |", "| --- | --- | --- | --- |", "| Str | 21 | +5 | +5 |", "| Dex | 9 | −1 | +3 |", "| Con | 15 | +2 | +6 |", "| Int | 18 | +4 | +8 |", "| Wis | 15 | +2 | +6 |", "| Cha | 18 | +4 | +4 |"];

describe("a monster block's ability table, three across (docs/design-v1-dice-ui.md 6.3)", () => {
  test("the table is read out of the text, which is otherwise left as written", () => {
    const text = ["## Aboleth", "", "**Speed** 10 ft.", "", ...TABLE, "", "**Skills** History +12"].join("\n");
    const split = splitAbilityTable(text);
    assert.ok(split);
    assert.equal(split.before, "## Aboleth\n\n**Speed** 10 ft.\n");
    assert.equal(split.after, "\n**Skills** History +12");
    assert.deepEqual(split.abilities[1], { key: "dex", score: "9", mod: "−1", save: "+3", proficient: true });
    assert.deepEqual(split.abilities[0], { key: "str", score: "21", mod: "+5", save: "+5", proficient: false }, "a save equal to its modifier is not proficient");
    assert.deepEqual(
      split.abilities.map((a) => a.key),
      ["str", "dex", "con", "int", "wis", "cha"],
    );
  });

  test("a table of another shape stays Markdown", () => {
    assert.equal(splitAbilityTable("**AC** 12"), null, "no table");
    assert.equal(splitAbilityTable(TABLE.slice(0, 7).join("\n")), null, "five rows");
    assert.equal(splitAbilityTable([...TABLE.slice(0, 2), TABLE[3], TABLE[2], ...TABLE.slice(4)].join("\n")), null, "out of order");
    assert.equal(splitAbilityTable([...TABLE, "| Luck | 10 | +0 | +0 |"].join("\n")), null, "a seventh row");
    assert.equal(splitAbilityTable(TABLE.join("\n").replace("| Str | 21 |", "| Str | lots |")), null, "a score that is not a number");
  });

  test("every SRD block and a room monster's block split, and draw six boxes and no table", async () => {
    const monsters = await loadMonsters();
    assert.equal(monsters.length, 330);
    for (const m of monsters) assert.ok(splitAbilityTable(m.statBlock), m.srdId);
    const room = monsterView(statBlockOf(customMonster("ogre-ish")));
    assert.ok(splitAbilityTable(room.statBlock), "the app writes its own blocks with the same table");
    const markup = withoutFrames(renderToStaticMarkup(createElement(StatBlockView, { view: monsters[0]!, source: "srd" })));
    assert.doesNotMatch(markup, /<table/);
    assert.equal(markup.match(/<dt/g)?.length, 6);
    // FL-15 (D-261030-588): no roll mark in the grid. The box of a proficient save is outlined whole, and no line lists it.
    assert.doesNotMatch(markup, /data-proficiency/, "no mark in the grid");
    assert.match(markup, /<div data-save-proficient=""[^>]*box-shadow:inset 0 0 0 1px currentColor[^>]*><dt[^>]*><abbr title="Dexterity"/, "the aboleth's Dex box is outlined");
    assert.match(markup, /<dd style="[^"]*"><span[^>]*>Save <\/span>\+3<span[^>]*>, proficient<\/span><\/dd>/);
    assert.doesNotMatch(markup, /<strong>(Proficiencies|Expertise)<\/strong>/);
  });
});
