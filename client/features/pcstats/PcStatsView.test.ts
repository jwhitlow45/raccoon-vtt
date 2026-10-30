import "../../components/testing/register.ts";
import { withoutFrames } from "../../components/testing/proficiencyMarkup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcStats } from "#shared/model.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PcStatsView } = await import("./PcStatsView.tsx");

const THORN: PcStats = {
  abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 10 },
  saves: ["dex", "int"],
  skills: {},
  adjust: {},
  defenses: {},
  rolls: [],
};

describe("a PC block's abilities three across (docs/design-v1-dice-ui.md 6.1)", () => {
  const markup = withoutFrames(renderToStaticMarkup(createElement(PcStatsView, { character: { stats: THORN, level: 5 } })));
  const boxes = [...markup.matchAll(/<div[^>]*><dt[^>]*>(.*?)<\/div>/g)].map((m) => m[1]!);

  test("six boxes in one three-column grid, and no table", () => {
    assert.match(markup, /<dl data-ability-grid=""[^>]*grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/);
    assert.equal(boxes.length, 6);
    assert.doesNotMatch(markup, /<table/);
    assert.match(boxes[1]!, /title="Dexterity"[^>]*>DEX<\/abbr>/);
    assert.match(boxes[1]!, /<strong[^>]*>18<\/strong> <span[^>]*>\+4<\/span>/, "the score and its modifier");
  });

  test("a proficient save is bold and the grid marks nothing (D-261030-539)", () => {
    assert.doesNotMatch(markup, /data-proficiency/);
    const save = (box: string) => /<dd[^>]*font-weight:(\d+)[^>]*><span[^>]*>Save <\/span>([^<]+)<\/dd>/.exec(box);
    const dex = save(boxes[1]!);
    const str = save(boxes[0]!);
    assert.ok(dex && str);
    assert.equal(dex[2], "+7", "Dex +4 and proficiency +3");
    assert.ok(Number(dex[1]) > Number(str[1]), "bold beside the plain Str save");
    assert.equal(str[2], "+0");
  });
});
