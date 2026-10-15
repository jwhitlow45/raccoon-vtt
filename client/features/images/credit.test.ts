import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssetCredit } from "#shared/protocol.ts";
import { changesText, creditParts, cropsImage, licenseName, licenseUrl, workName } from "./credit.ts";

const credit: AssetCredit = {
  title: "Goblins and a Troll",
  creator: "Dunechaser",
  license: "by-nc-sa",
  licenseVersion: "2.0",
  landingUrl: "https://www.flickr.com/photos/dunechaser/123",
  attribution: '"Goblins and a Troll" by Dunechaser is licensed under CC BY-NC-SA 2.0.',
  originalWidth: 1024,
  originalHeight: 768,
};

describe("an Openverse image's credit", () => {
  test("reads as the design's example, with the changes after it", () => {
    const parts = creditParts(credit, { width: 512, height: 384 });
    assert.equal(parts.text, "Goblins and a Troll by Dunechaser, CC BY-NC-SA 2.0. Resized and converted to WebP.");
    assert.equal(parts.workUrl, credit.landingUrl);
    assert.equal(parts.licenseUrl, "https://creativecommons.org/licenses/by-nc-sa/2.0/");
  });

  test("says resized only when the stored size differs from the original's", () => {
    assert.equal(changesText(credit, { width: 1024, height: 768 }), "Converted to WebP.");
    assert.equal(changesText(credit, { width: 512, height: 384 }), "Resized and converted to WebP.");
    assert.equal(changesText({ originalWidth: 300, originalHeight: 300 }, { width: 300, height: 300 }), "Converted to WebP.");
  });

  test("says cropped only where the token's crop shows less than the whole image", () => {
    const square = { width: 400, height: 400 };
    const wide = { width: 800, height: 400 };
    const whole = { cx: 0.5, cy: 0.5, zoom: 1 };
    assert.equal(cropsImage(square, whole, 1), false);
    assert.equal(cropsImage(square, { ...whole, zoom: 2 }, 1), true);
    // A wide picture on a round token shows its middle square only.
    assert.equal(cropsImage(wide, whole, 1), true);
    // On a token two cells wide and one tall, the whole wide picture shows.
    assert.equal(cropsImage(wide, whole, 2), false);
    assert.equal(
      changesText({ originalWidth: 400, originalHeight: 400 }, square, { crop: { ...whole, zoom: 1.5 }, aspect: 1 }),
      "Converted to WebP. Cropped.",
    );
    assert.equal(changesText({ originalWidth: 400, originalHeight: 400 }, square, { crop: whole, aspect: 1 }), "Converted to WebP.");
  });

  test("names the work with whatever of title and author it has", () => {
    assert.equal(workName({ title: "Goblin", creator: "Ann" }), "Goblin by Ann");
    assert.equal(workName({ title: "Goblin" }), "Goblin");
    assert.equal(workName({ creator: "Ann" }), "An image by Ann");
    assert.equal(workName({ title: "  ", creator: "" }), "An untitled image");
  });

  test("license names and links for every license Openverse results keep", () => {
    assert.equal(licenseName("by", "4.0"), "CC BY 4.0");
    assert.equal(licenseName("by-sa", "2.0"), "CC BY-SA 2.0");
    assert.equal(licenseName("cc0", "1.0"), "CC0 1.0");
    assert.equal(licenseName("pdm"), "Public Domain Mark");
    assert.equal(licenseName("sampling+", "1.0"), "CC Sampling+ 1.0");
    assert.equal(licenseName("odd"), "ODD");
    assert.equal(licenseUrl("by", "4.0"), "https://creativecommons.org/licenses/by/4.0/");
    assert.equal(licenseUrl("cc0"), "https://creativecommons.org/publicdomain/zero/1.0/");
    assert.equal(licenseUrl("pdm", "1.0"), "https://creativecommons.org/publicdomain/mark/1.0/");
    assert.equal(licenseUrl("nc-sampling+", "1.0"), "https://creativecommons.org/licenses/nc-sampling+/1.0/");
    assert.equal(licenseUrl("by"), null);
    assert.equal(licenseUrl("by", "../x"), null);
    assert.equal(licenseUrl("odd", "1.0"), null);
  });
});
