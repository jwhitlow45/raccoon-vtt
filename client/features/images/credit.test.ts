import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssetCredit } from "#shared/protocol.ts";
import { askedLine, changesText, creditParts, cropsImage, licenseName, licenseUrl, workName } from "./credit.ts";

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

describe("a starter pick's credit (docs/design-v1-starter-art.md 9)", () => {
  const picked: AssetCredit = {
    title: "Ruined keep",
    creator: "A. Cartographer",
    license: "public-domain",
    landingUrl: "https://example.com/ruined-keep",
    attribution: "Ruined keep by A. Cartographer",
    changes: "Scaled to 4096 px on the long side and saved as 4-level gray PNG.",
    originalWidth: 4096,
    originalHeight: 3072,
  };

  test("a public domain dedication is named plainly, with no license link", () => {
    assert.equal(licenseName("public-domain"), "Public domain dedication");
    assert.equal(licenseUrl("public-domain"), null);
    assert.equal(licenseUrl("public-domain", "1.0"), null);
    const parts = creditParts(picked, { width: 4096, height: 3072 });
    assert.equal(parts.licenseUrl, null);
    assert.equal(parts.text, "Ruined keep by A. Cartographer, Public domain dedication. Scaled to 4096 px on the long side and saved as 4-level gray PNG.");
  });

  test("its own changes replace the guess, with the room's size only when its copy differs from the shipped file", () => {
    assert.equal(changesText(picked, { width: 4096, height: 3072 }), picked.changes);
    assert.equal(changesText(picked, { width: 2048, height: 1536 }), `${picked.changes} Resized to 2048 x 1536 for this room.`);
  });

  test("Cropped follows, as for any image", () => {
    const square = { ...picked, originalWidth: 400, originalHeight: 400 };
    const crop = { crop: { cx: 0.5, cy: 0.5, zoom: 2 }, aspect: 1 };
    assert.equal(changesText(square, { width: 400, height: 400 }, crop), `${picked.changes} Cropped.`);
    assert.equal(changesText(square, { width: 200, height: 200 }, crop), `${picked.changes} Resized to 200 x 200 for this room. Cropped.`);
  });

  test("shows the credit line the author asks for, and none where it only restates the work", () => {
    const asked = { ...picked, attribution: "Cartography by A. Cartographer" };
    assert.equal(askedLine(asked), "Cartography by A. Cartographer");
    const parts = creditParts(asked, { width: 4096, height: 3072 });
    assert.equal(parts.asked, "Cartography by A. Cartographer.");
    assert.equal(parts.text, `Ruined keep by A. Cartographer, Public domain dedication. Cartography by A. Cartographer. ${picked.changes}`);
    assert.equal(askedLine(picked), null, "the title and author are shown already");
    assert.equal(creditParts(picked, { width: 4096, height: 3072 }).asked, null);
  });

  test("an Openverse import's attribution is never shown again as an asked line", () => {
    const openverse = { ...picked, changes: undefined, attribution: '"Ruined keep" by A. Cartographer is licensed under CC BY 2.0.' };
    assert.equal(askedLine(openverse), null);
  });

  test("changes without a full stop still read as a sentence, and blank changes fall back to the guess", () => {
    assert.equal(changesText({ ...picked, changes: "Upscaled 8 times" }, { width: 4096, height: 3072 }), "Upscaled 8 times.");
    assert.equal(changesText({ ...picked, changes: "  " }, { width: 4096, height: 3072 }), "Converted to WebP.");
  });
});
