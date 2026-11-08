import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { TRINKETS } from "./trinkets.ts";

/** SHA-256 of the 100 lines joined by newlines, as scripts/srd-import.ts extracts them from SRD 5.2.1. */
const LINES_SHA256 = "15939d4a5b23f0bf3812a2977667b8c47dd0302456e603fb26aa9ba24ca1bda8";

describe("Trinkets", () => {
  test("holds the SRD's 100 lines, unchanged since the import", () => {
    assert.equal(TRINKETS.length, 100);
    assert.equal(createHash("sha256").update(TRINKETS.join("\n")).digest("hex"), LINES_SHA256);
  });

  test("every line is distinct, trimmed and free of PDF leftovers", () => {
    assert.equal(new Set(TRINKETS).size, TRINKETS.length);
    for (const line of TRINKETS) {
      assert.match(line, /^[A-Z“].*\S$/, line);
      assert.doesNotMatch(line, /^\d|\s{2,}| -|=====|System Reference/, line);
    }
  });

  test("entry i is roll i + 1, with 00 last", () => {
    assert.equal(TRINKETS[0], "A mummified goblin hand");
    assert.equal(TRINKETS[33], "A rectangular metal device with two tiny metal cups on one end that throws sparks when wet");
    assert.equal(TRINKETS[34], "A white, sequined glove sized for a human");
    assert.equal(TRINKETS[71], "A silver teardrop earring containing a real teardrop");
    assert.equal(TRINKETS[72], "An eggshell painted with scenes of misery in disturbing detail");
    assert.equal(TRINKETS[98], "A wooden box with a ceramic bottom that holds a living worm with a head on each end of its body");
    assert.equal(TRINKETS[99], "A metal urn containing the ashes of a hero");
  });

  test("rejoins words the PDF broke at a line end and keeps real hyphens", () => {
    assert.ok(TRINKETS.includes("The deed for a parcel of land in a realm unknown to you"));
    assert.ok(TRINKETS.includes("A four-leaf clover pressed inside a book discussing manners and etiquette"));
    assert.ok(TRINKETS.includes("A bag containing forty-seven teeth, one of which is rotten"));
  });
});
