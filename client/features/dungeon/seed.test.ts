import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CROCKFORD, formatSeed, newSeed, parseSeed, seedKey, versionChar } from "./seed.ts";
import { GENERATOR_VERSION } from "./settings.ts";

describe("dungeon seeds", () => {
  test("a new seed is 16 Crockford characters, the version first", () => {
    for (let i = 0; i < 200; i++) {
      const seed = newSeed();
      assert.equal(seed.length, 16);
      assert.equal(seed[0], versionChar(GENERATOR_VERSION));
      for (const c of seed) assert.ok(CROCKFORD.includes(c), c);
      assert.deepEqual(parseSeed(seed), { ok: true, seed, otherVersion: false });
    }
  });

  test("its 75 bits come from the source it is given, the low 5 bits of each byte", () => {
    const seed = newSeed((b) => b.set(Array.from({ length: b.length }, (_, i) => i + 32 * i)));
    assert.equal(seed, `${versionChar()}0123456789ABCDE`);
    assert.equal(newSeed((b) => b.fill(0xff)), `${versionChar()}${"Z".repeat(15)}`);
  });

  test("two new seeds differ", () => {
    assert.notEqual(newSeed(), newSeed());
  });

  test("a typed seed is read case-blind, spaces and dashes ignored, O as 0, I and L as 1", () => {
    const want = { ok: true, seed: "1K7QH2MXA9F3TWQ5", otherVersion: false };
    assert.deepEqual(parseSeed("1K7Q-H2MX-A9F3-TWQ5"), want);
    assert.deepEqual(parseSeed("  1k7q h2mx-a9f3  twq5 "), want);
    assert.deepEqual(parseSeed("1K7Q--H2MX\tA9F3\nTWQ5"), want);
    assert.deepEqual(parseSeed("lK7Q-H2MX-A9F3-TWQ5"), want);
    assert.deepEqual(parseSeed("IK7Q-H2MX-A9F3-TWQ5"), want);
    assert.deepEqual(parseSeed("1000-OOOO-oooo-0001"), { ok: true, seed: "1000000000000001", otherVersion: false });
  });

  test("anything but the full form is not a seed", () => {
    for (const bad of ["", "1K7Q-H2MX-A9F3-TWQ", "1K7Q-H2MX-A9F3-TWQ55", "1K7Q-H2MX-A9F3-TWU5", "1K7Q_H2MX_A9F3_TWQ5", "1K7Q-H2MX-A9F3-TW!5", "12345", "1K7Q.H2MX.A9F3.TWQ5"]) {
      assert.deepEqual(parseSeed(bad), { ok: false }, bad);
    }
  });

  test("a seed from another version reads, with the note", () => {
    assert.deepEqual(parseSeed("2K7Q-H2MX-A9F3-TWQ5"), { ok: true, seed: "2K7QH2MXA9F3TWQ5", otherVersion: true });
    assert.deepEqual(parseSeed("0K7Q-H2MX-A9F3-TWQ5"), { ok: true, seed: "0K7QH2MXA9F3TWQ5", otherVersion: true });
  });

  test("shows in four groups of four", () => {
    assert.equal(formatSeed("1K7QH2MXA9F3TWQ5"), "1K7Q-H2MX-A9F3-TWQ5");
  });

  test("the key holds the 75 bits after the version, high bit first, then zeros", () => {
    const zero = seedKey("1000000000000000");
    assert.deepEqual([...zero], new Array(32).fill(0));
    const top = seedKey("1Z00000000000000");
    assert.equal(top[0], 0b11111000);
    assert.equal(top[1], 0);
    const all = seedKey(`1${"Z".repeat(15)}`);
    assert.deepEqual([...all.slice(0, 9)], new Array(9).fill(0xff));
    // 75 bits fill nine bytes and the top three bits of the tenth.
    assert.equal(all[9], 0b11100000);
    assert.deepEqual([...all.slice(10)], new Array(22).fill(0));
    // The version character is not in the key.
    assert.deepEqual([...seedKey("2K7QH2MXA9F3TWQ5")], [...seedKey("1K7QH2MXA9F3TWQ5")]);
  });
});
