import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generatePassphrase, randomIndex, type RandomSource } from "./passphrase.ts";
import { WORDS } from "./words.ts";

/** A random source that returns the given values in order. */
function scripted(values: number[]): RandomSource {
  let i = 0;
  return (buffer) => {
    buffer[0] = values[i++] ?? 0;
    return buffer;
  };
}

describe("word list", () => {
  test("has about 1,500 unique short lowercase words", () => {
    assert.ok(WORDS.length >= 1400 && WORDS.length <= 1700, `got ${WORDS.length}`);
    assert.equal(new Set(WORDS).size, WORDS.length, "duplicates in the list");
    for (const w of WORDS) assert.match(w, /^[a-z]{3,8}$/);
  });

  test("includes the SRD names the design uses as its example", () => {
    for (const w of ["owlbear", "druid", "wand"]) assert.ok(WORDS.includes(w), w);
  });
});

describe("randomIndex", () => {
  test("maps a draw into the range", () => {
    assert.equal(randomIndex(10, scripted([23])), 3);
  });

  test("redraws values from the uneven tail so every index is equally likely", () => {
    // 2^32 % 10 = 6, so the last 6 values of the 32-bit range are rejected.
    const tail = 2 ** 32 - 1;
    assert.equal(randomIndex(10, scripted([tail, tail - 5, 7])), 7);
  });

  test("rejects an empty range", () => {
    assert.throws(() => randomIndex(0));
  });
});

describe("generatePassphrase", () => {
  test("joins three listed words with hyphens and meets the 8 character minimum", () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassphrase();
      const parts = p.split("-");
      assert.equal(parts.length, 3);
      for (const part of parts) assert.ok(WORDS.includes(part), part);
      assert.ok(p.length >= 8);
    }
  });

  test("uses the random source for each word", () => {
    const p = generatePassphrase({ words: ["owlbear", "druid", "wand"], random: scripted([0, 1, 2]) });
    assert.equal(p, "owlbear-druid-wand");
  });

  test("varies between calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassphrase()));
    assert.ok(seen.size > 45);
  });
});
