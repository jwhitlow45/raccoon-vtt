import "../../components/testing/register.ts";
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
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats: THORN, level: 5 } }));
  const boxes = [...markup.matchAll(/<div[^>]*><dt[^>]*>(.*?)<\/div>/g)].map((m) => m[1]!);

  test("six boxes in a grid of at most three columns with room for each save, and no table", () => {
    assert.match(markup, /<dl data-ability-grid=""[^>]*grid-template-columns:repeat\(auto-fit, minmax\(max\(84px, calc\(\(100% - 8px\) \/ 3\)\), 1fr\)\)/);
    assert.equal(boxes.length, 6);
    assert.doesNotMatch(markup, /<table/);
    assert.match(boxes[1]!, /title="Dexterity"[^>]*>DEX<\/abbr>/);
    assert.match(boxes[1]!, /<strong[^>]*>18<\/strong> <span[^>]*>\+4<\/span>/, "the score and its modifier");
  });

  test("a proficient save is bold and named proficient, the others neither", () => {
    const save = (box: string) => /<dd[^>]*font-weight:(\d+)[^>]*>(.*?)<\/dd>/.exec(box);
    const dex = save(boxes[1]!);
    const str = save(boxes[0]!);
    assert.ok(dex && str);
    assert.match(dex[2]!, /Save <\/span>\+7/, "Dex +4 and proficiency +3");
    assert.match(dex[2]!, /data-proficiency-marker="prof"[^>]*aria-label="Proficient"/, "a screen reader hears it is proficient");
    assert.ok(Number(dex[1]) > Number(str[1]), "bold beside the plain Str save");
    assert.match(str[2]!, /Save <\/span>\+0/);
    assert.match(str[2]!, /data-proficiency-marker="none" aria-hidden="true"/);
    assert.doesNotMatch(str[2]!, /aria-label="Proficient"/);
  });
});

test("skill prose omits untrained marker slots while ability columns keep theirs", () => {
  const stats: PcStats = { ...THORN, skills: { perception: "expert", stealth: "prof" }, adjust: { skills: { investigation: 9 } } };
  const markup = renderToStaticMarkup(createElement(PcStatsView, { character: { stats, level: 5 } }));
  const skills = /<p[^>]*><strong>Skills<\/strong>(.*?)<\/p>/.exec(markup)?.[1];
  assert.ok(skills);
  assert.doesNotMatch(skills, /data-proficiency-marker="none"/, "untrained skill prose has no empty slot");
  assert.match(skills, /data-proficiency-marker="expert"[^>]*aria-label="Expertise"/);
  assert.match(skills, /data-proficiency-marker="prof"[^>]*aria-label="Proficient"/);
  assert.equal(skills.replace(/<[^>]*>/g, "").trim(), "Investigation +9, Perception +7, Stealth +7");
  assert.equal(markup.match(/data-proficiency-marker="none"/g)?.length, 4, "four untrained ability columns keep aligned slots");
});
