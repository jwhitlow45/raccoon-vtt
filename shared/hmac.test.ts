import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { hmacKey, hmacSha256, sha256 } from "./hmac.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const ascii = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

// RFC 4231 section 4, cases 1 to 4, 6 and 7 (case 5 truncates its output).
const RFC_4231: { key: Uint8Array; data: Uint8Array; mac: string }[] = [
  { key: bytes("0b".repeat(20)), data: ascii("Hi There"), mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7" },
  { key: ascii("Jefe"), data: ascii("what do ya want for nothing?"), mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" },
  { key: bytes("aa".repeat(20)), data: bytes("dd".repeat(50)), mac: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe" },
  { key: bytes("0102030405060708090a0b0c0d0e0f10111213141516171819"), data: bytes("cd".repeat(50)), mac: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b" },
  { key: bytes("aa".repeat(131)), data: ascii("Test Using Larger Than Block-Size Key - Hash Key First"), mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54" },
  {
    key: bytes("aa".repeat(131)),
    data: ascii("This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."),
    mac: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
  },
];

test("HMAC-SHA-256 gives RFC 4231's answers", () => {
  for (const c of RFC_4231) assert.equal(hex(hmacSha256(hmacKey(c.key), c.data)), c.mac);
});

test("SHA-256 and HMAC-SHA-256 equal node:crypto's at every length around a block's edges", () => {
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return seed & 255;
  };
  for (let length = 0; length <= 200; length++) {
    const message = Uint8Array.from({ length }, next);
    assert.equal(hex(sha256(message)), createHash("sha256").update(message).digest("hex"), `sha256 of ${length} bytes`);
    for (const keyLength of [0, 1, 32, 63, 64, 65, 100]) {
      const key = Uint8Array.from({ length: keyLength }, next);
      assert.equal(hex(hmacSha256(hmacKey(key), message)), createHmac("sha256", key).update(message).digest("hex"), `hmac of ${length} bytes, a ${keyLength}-byte key`);
    }
  }
});

test("a key's states serve many messages, each as a fresh HMAC would", () => {
  const raw = ascii("a key used again and again");
  const key = hmacKey(raw);
  for (const text of ["one", "two", "", "a longer message that runs past one block of sixty-four bytes, so it takes two"]) {
    assert.equal(hex(hmacSha256(key, ascii(text))), createHmac("sha256", raw).update(text).digest("hex"));
  }
});
