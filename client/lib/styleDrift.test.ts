import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ALLOWLIST, clientFiles, declarationSpans, findings } from "../../scripts/style-drift.ts";

/**
 * The drift test (docs/design-v1-visual.md 5.5): the whole client, read
 * as scripts/style-drift.ts reads it, holds no color literal outside the
 * allowlist, no raw font size or radius number, no shadow that is not a
 * `theme.shadow` value, no z-index above 2 outside `theme.z`, and no
 * opacity that fades a disabled or busy control. A new literal goes into
 * theme.ts as a token, or, if it is stored data or board art, into the
 * allowlist by name. The scan's own rules are tested on small files in
 * styleDriftScan.test.ts.
 */

const files = clientFiles();

describe("the client's styles", () => {
  test("come from the tokens, apart from the allowlist", () => {
    const found = findings(files).map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`);
    assert.deepEqual(found, [], `run node scripts/style-drift.ts --findings for the same list:\n${found.join("\n")}`);
  });

  test("the scan reads the whole client", () => {
    assert.ok(files.length > 400, `only ${files.length} files were read`);
    assert.ok(
      files.every((f) => !f.path.startsWith("client/dev/") && !/\.(test|itest|e2e)\.tsx?$/.test(f.path)),
      "tests and the dev pages are left out",
    );
  });

  // An entry whose file or constant is gone would let a new literal of that name through unseen.
  test("every allowlist entry names a file and constants that still exist", () => {
    for (const entry of ALLOWLIST) {
      const matched = files.filter((f) => entry.match(f.path));
      assert.ok(matched.length > 0, `no file matches the allowlist entry for ${entry.why}`);
      for (const name of entry.declarations ?? []) {
        assert.ok(
          matched.some((f) => declarationSpans(f.text, [name]).length > 0),
          `${name} (${entry.why}) is declared in no file the entry matches`,
        );
      }
    }
  });
});
