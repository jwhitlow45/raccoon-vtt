import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Effect } from "#shared/model.ts";

/*
 * A small chip's face (docs/design-v1-icons-2.md 4). The art and a number
 * side by side came to 27 px, past the 20 px box a chip of letters keeps,
 * so a chip with a number keeps its letters (ICONS2-ASTRA-02).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ChipFace } = await import("./EffectIcon.tsx");

const face = (effect: Pick<Effect, "key" | "label" | "glyph" | "level">, counts = true) => renderToStaticMarkup(createElement(ChipFace, { effect, size: 14, counts }));

describe("a chip's face", () => {
  test("draws the art alone for an effect with no number", () => {
    assert.match(face({ key: "frightened" }), /^<span[^>]*mask-image:url\(\/icons\/conditions\/frightened\.svg\)[^>]*><\/span>$/);
  });

  test("keeps exhaustion's letters, which hold its level, and never says the level twice", () => {
    assert.equal(face({ key: "exhaustion", level: 4 }), "E4");
  });

  test("keeps a counted effect's letters beside its number in the tracker", () => {
    assert.match(face({ key: "hexed", level: 3 }), /^Hx<span[^>]*>3<\/span>$/);
  });

  test("draws the art for a counted effect where the chip shows no number, as the party bar's", () => {
    assert.match(face({ key: "hexed", level: 3 }, false), /^<span[^>]*mask-image:url\(\/icons\/statuses\/hexed\.svg\)/);
  });

  test("falls back to the letters for a key with no art", () => {
    assert.equal(face({ key: "custom", label: "Marked", glyph: "Mk" }), "Mk");
    assert.equal(face({ key: "no-such-effect" as Effect["key"] }), "?");
  });
});
