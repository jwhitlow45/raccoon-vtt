import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientFiles, stripComments, type SourceFile } from "../../scripts/style-drift.ts";

/**
 * Two rules of the dice UI and icon passes, read from the source as the
 * drift test reads it (styleDrift.test.ts): the Dice panel, the stat blocks
 * and the Token panel keep to the space scale (docs/design-v1-dice-ui.md
 * 3.1 rule 1), and no button anywhere is labelled by a bare arrow, cross,
 * minus or plus glyph, which drew at a different size and weight in every
 * font (docs/design-v1-icons.md 8). Each rule is also tried on a small made-up
 * file, so a scan that finds nothing is known to look.
 */

const SPACED = [/^client\/features\/dice\//, /^client\/features\/pcstats\//, /^client\/panels\/TokenPanel\.tsx$/, /^client\/features\/tokens\/QuickNumbers\.tsx$/];
const ON_SCALE = /^theme\.space\([1-4]\)$|^0$/;

function gapsOffScale(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (!SPACED.some((re) => re.test(file.path))) continue;
    for (const m of file.text.matchAll(/(?<![\w$.-])(gap|rowGap|columnGap)\s*:\s*([^,}\n]+)/g)) {
      const value = m[2]!.trim();
      if (!ON_SCALE.test(value)) out.push(`${file.path}:${file.text.slice(0, m.index).split("\n").length} ${m[1]}: ${value}`);
    }
  }
  return out;
}

const GLYPHS = "←→↑↓↗×−+";

function glyphButtons(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(Button|SmallButton|OptButton|BarButton|MenuButton|button)\\b[^>]*>\\s*[${GLYPHS}]\\s*</\\1>`, "g");
  for (const file of files) {
    for (const m of file.text.matchAll(re)) out.push(`${file.path}:${file.text.slice(0, m.index).split("\n").length} ${m[0].replace(/\s+/g, " ").slice(-40)}`);
  }
  return out;
}

const files = clientFiles();

describe("the dice UI and icon passes' source rules", () => {
  test("the Dice panel, the stat blocks and the Token panel space only by the scale: 4, 8, 12 and 16 px", () => {
    assert.deepEqual(gapsOffScale(files), []);
  });

  test("no button is labelled by an arrow, a cross, a minus or a plus glyph: each draws its icon and keeps its words as its name", () => {
    assert.deepEqual(glyphButtons(files), []);
  });

  test("the scans find what they look for", () => {
    const made = (path: string, text: string) => ({ path, text: stripComments(text) });
    assert.deepEqual(gapsOffScale([made("client/features/dice/X.tsx", '<div style={{ display: "grid", gap: 2, rowGap: theme.space(2) }} />\n<p style={{ gap: theme.space(5) }} />\n')]), ["client/features/dice/X.tsx:1 gap: 2", "client/features/dice/X.tsx:2 gap: theme.space(5)"]);
    assert.deepEqual(gapsOffScale([made("client/features/journal/X.tsx", '<div style={{ gap: 2 }} />\n')]), [], "only the pass's surfaces");
    assert.equal(glyphButtons([made("client/x.tsx", '<Button size="sm" onClick={up}>\n  ↑\n</Button>\n<Button>Move ↑ up</Button>\n')]).length, 1, "a glyph inside words is text");
    assert.equal(glyphButtons([made("client/x.tsx", '<SmallButton label="Lower" onClick={down}>\n  −\n</SmallButton>\n<SmallButton label="Up">+{step}</SmallButton>\n')]).length, 1, "a step's size beside its sign is words");
  });
});
