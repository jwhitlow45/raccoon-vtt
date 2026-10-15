import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

/** Wizards' required attribution, verbatim from the SRD 5.2.1 legal page. */
const ATTRIBUTION =
  "This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.";

const here = new URL("./", import.meta.url);
const files = [
  ...readdirSync(here).map((name) => ({ name, url: new URL(name, here) })),
  { name: "scripts/srd-import.ts", url: new URL("../../scripts/srd-import.ts", import.meta.url) },
];

describe("SRD licensing", () => {
  test("NOTICE.md carries the attribution and says the material was changed", () => {
    const notice = readFileSync(new URL("NOTICE.md", here), "utf8");
    assert.ok(notice.includes(ATTRIBUTION));
    assert.match(notice, /converted to JSON and Markdown and edited/);
  });

  test("no file names the game's trademarks", () => {
    for (const f of files) {
      assert.doesNotMatch(readFileSync(f.url, "utf8"), /D\s*&\s*D|Dungeons\s*(?:&|and)\s*Dragons/i, f.name);
    }
  });

  test("no file has an em dash", () => {
    for (const f of files) {
      assert.ok(!readFileSync(f.url, "utf8").includes("\u2014"), f.name);
    }
  });
});
