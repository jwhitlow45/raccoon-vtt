import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { openPlayerPassword, sealPlayerPassword } from "./playerSecret.ts";

describe("the stored player password", () => {
  const key = randomBytes(32);

  test("opens with the key, room and epoch it was sealed for", () => {
    for (const password of ["owlbear-druid-wand", "ünïcödé pässwörd 🐉", "x".repeat(256)]) {
      const sealed = sealPlayerPassword(key, "K7QH2MXA", 3, password);
      assert.equal(openPlayerPassword(key, "K7QH2MXA", 3, sealed), password);
    }
  });

  test("never holds the password in the clear, and differs every time", () => {
    const a = sealPlayerPassword(key, "K7QH2MXA", 1, "owlbear-druid-wand");
    const b = sealPlayerPassword(key, "K7QH2MXA", 1, "owlbear-druid-wand");
    assert.ok(!a.includes(Buffer.from("owlbear")));
    assert.notDeepEqual(a, b);
  });

  test("a rotated or wrong key opens nothing, without throwing", () => {
    const sealed = sealPlayerPassword(key, "K7QH2MXA", 1, "owlbear-druid-wand");
    assert.equal(openPlayerPassword(randomBytes(32), "K7QH2MXA", 1, sealed), null);
  });

  test("a value copied onto another room, or left from an earlier password, opens nothing", () => {
    const sealed = sealPlayerPassword(key, "K7QH2MXA", 1, "owlbear-druid-wand");
    assert.equal(openPlayerPassword(key, "ABCD2345", 1, sealed), null);
    assert.equal(openPlayerPassword(key, "K7QH2MXA", 2, sealed), null);
  });

  test("damaged or truncated bytes open nothing", () => {
    const sealed = sealPlayerPassword(key, "K7QH2MXA", 1, "owlbear-druid-wand");
    for (const at of [0, 1, 20, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = bad[at]! ^ 1;
      assert.equal(openPlayerPassword(key, "K7QH2MXA", 1, bad), null, `byte ${at}`);
    }
    assert.equal(openPlayerPassword(key, "K7QH2MXA", 1, sealed.subarray(0, 20)), null);
    assert.equal(openPlayerPassword(key, "K7QH2MXA", 1, Buffer.alloc(0)), null);
  });
});
