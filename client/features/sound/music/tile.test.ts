import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contrast } from "../../../lib/accent.ts";
import { PALETTES, SCHEMES } from "../../../lib/theme.ts";

const { mixOklab, tileBackground, tintOf, TINT_SHARE, TINTS } = await import("./tile.ts");

/* The tiles (docs/design/design-v1-music-player.md 7, D-261102-967): a tint by the name, no art, and an icon that reads on every tint in both themes. */

describe("a tile's tint", () => {
  test("a name always gets the same tint, whatever its case, and names spread over the eight", () => {
    assert.equal(tintOf("Tavern night"), tintOf("Tavern night"));
    assert.equal(tintOf("TAVERN NIGHT"), tintOf("tavern night"), "two copies of one track look alike");
    const seen = new Set(["Battle", "Boss themes", "Tavern night", "Travel", "Harbor at dusk", "Castle chase", "Forest lament", "Crypt watch", "Market festival", "Swamp storm", "Road", "March"].map(tintOf));
    assert.ok(seen.size >= 5, `twelve names took only ${seen.size} tints`);
    for (const t of seen) assert.ok((TINTS as readonly string[]).includes(t));
  });

  test("the background is the tint mixed into the raised surface in OKLab, as the browser draws it", () => {
    assert.match(tileBackground("Road"), new RegExp(`^color-mix\\(in oklab, ${tintOf("Road")} 38%, var\\(--`));
    assert.equal(mixOklab("#ff0000", "#0000ff", 1), "#ff0000");
    assert.equal(mixOklab("#ff0000", "#0000ff", 0), "#0000ff");
    assert.equal(mixOklab("#808080", "#808080", 0.38), "#808080");
  });

  test("the icon, in the text color, reads at 3:1 at least on every tint in both themes", () => {
    for (const scheme of SCHEMES) {
      const palette = PALETTES[scheme];
      for (const tint of TINTS) {
        const ground = mixOklab(tint, palette.surfaceRaised, TINT_SHARE);
        const ratio = contrast(palette.text, ground);
        assert.ok(ratio >= 3, `${tint} in ${scheme}: ${ratio.toFixed(2)}:1 on ${ground}`);
      }
    }
  });
});
