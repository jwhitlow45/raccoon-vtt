import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/api.ts";
import { DDB_WORDS, importErrorText, PASTE_LIMIT, quotaWords, readPastedJson } from "./ddb.ts";

/** The D&D Beyond step's words and pasted JSON (docs/design-v1-pc-stats.md 6.3 and Appendix D). */
describe("the import's words", () => {
  test("each code's words, each ending with the way out", () => {
    const err = (code: ConstructorParameters<typeof ApiError>[2], retryAfterMs: number | null = null) => new ApiError(400, "x", code, retryAfterMs);
    assert.equal(importErrorText(err("private")), DDB_WORDS.private);
    assert.equal(importErrorText(err("not_found")), "D&D Beyond has no character with that number.");
    assert.equal(importErrorText(err("fetch_failed")), DDB_WORDS.failed);
    assert.equal(importErrorText(err("network")), DDB_WORDS.failed, "no answer reads as D&D Beyond not answering");
    assert.equal(importErrorText(new Error("x")), DDB_WORDS.failed);
    assert.equal(importErrorText(err("unreadable")), DDB_WORDS.unreadable);
    assert.equal(importErrorText(err("busy")), DDB_WORDS.busy);
    assert.equal(importErrorText(err("quota_member", 12 * 60_000 - 500)), "Too many imports this hour. Try again in 12 minutes, or paste the character's JSON.");
    assert.equal(quotaWords(30_000), "Too many imports this hour. Try again in 1 minute, or paste the character's JSON.");
  });
});

describe("pasted JSON", () => {
  test("over 5 MiB is refused before reading, and what does not read says so", async () => {
    assert.deepEqual(await readPastedJson("x".repeat(PASTE_LIMIT + 1)), { error: DDB_WORDS.tooBig });
    assert.deepEqual(await readPastedJson("<html>"), { error: DDB_WORDS.unreadable });
    assert.deepEqual(await readPastedJson(JSON.stringify({ success: true, data: { name: "x" } })), { error: DDB_WORDS.unreadable });
  });

  test("the envelope or the bare data reads into a fill", async () => {
    const data = { id: 7, name: "Ione Marrow", stats: [8, 14, 14, 18, 12, 10].map((value, i) => ({ id: i + 1, value })), classes: [{ level: 3, definition: { name: "Wizard", spellCastingAbilityId: 4 } }], modifiers: {} };
    for (const json of [{ success: true, data }, data]) {
      const read = await readPastedJson(JSON.stringify(json));
      assert.ok("fill" in read);
      assert.equal(read.fill.name, "Ione Marrow");
      assert.equal(read.fill.stats.spellAbility, "int");
    }
  });
});
