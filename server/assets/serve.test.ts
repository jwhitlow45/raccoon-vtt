import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaEtag, requestedRange } from "./serve.ts";

/** A video's and a sound's Range answers (docs/design/design-v1-animated-maps.md 10, Serving, D-261102-457). */

test("one range, an open one and a suffix are read, clipped to the file", () => {
  assert.deepEqual(requestedRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(requestedRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(requestedRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.deepEqual(requestedRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(requestedRange("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(requestedRange("bytes=999-999", 1000), { start: 999, end: 999 });
});

test("a range that starts past the end, or an empty suffix, cannot be satisfied", () => {
  assert.equal(requestedRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(requestedRange("bytes=1000-1200", 1000), "unsatisfiable");
  assert.equal(requestedRange("bytes=-0", 1000), "unsatisfiable");
});

test("no header, several ranges, another unit or a malformed one is the whole file", () => {
  for (const header of [undefined, "bytes=0-9,20-29", "items=0-9", "bytes=9-0", "bytes=-", "bytes=a-b", "bytes 0-9", "bytes=0x10-20"]) {
    assert.equal(requestedRange(header, 1000), null, String(header));
  }
});

test("a video's or a sound's ETag is strong, from its upload's hash and its pipeline", () => {
  assert.equal(mediaEtag("ab".repeat(32), 1), `"${"ab".repeat(32)}-v1"`);
  assert.notEqual(mediaEtag("ab".repeat(32), 1), mediaEtag("ab".repeat(32), 2));
});
