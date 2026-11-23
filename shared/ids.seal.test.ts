import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { idKeyFromText, idKeyOf, idKeyText, idTime, isSealedShape, isUuidv7, sealedId, sealedTime, timeOf, uuidv7 } from "./ids.ts";

const key = (label: string) => idKeyOf(createHash("sha256").update(label).digest());
/** A fixed nonce for a label, as the twins name their things. */
const nonce = (label: string) => {
  const bytes = new Uint8Array(createHash("sha256").update(`nonce ${label}`).digest().subarray(0, 8));
  bytes[0]! &= 0x0f;
  return bytes;
};

test("a version 8 id reads back to its time under its key, to the millisecond", () => {
  const k = key("member a");
  for (const at of [0, 1, 1_700_000_000_123, Date.now(), 2 ** 48 - 1]) {
    const id = sealedId(k, at);
    assert.equal(isSealedShape(id), true, id);
    assert.equal(sealedTime(k, id), at);
    assert.equal(timeOf(id, k), at);
    assert.equal(idTime(id), null, "no time in the clear");
    assert.equal(isUuidv7(id), false);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test("a sealed id's time is a whole millisecond in 48 bits, and its nonce holds 60 bits", () => {
  const k = key("member a");
  for (const at of [-1, 0.5, 2 ** 48, Number.NaN]) assert.throws(() => sealedId(k, at), RangeError);
  assert.throws(() => sealedId(k, 0, new Uint8Array(8).fill(0x10)), RangeError);
  assert.throws(() => sealedId(k, 0, new Uint8Array(7)), RangeError);
});

test("another key reads no time, but for a chance tag match about once in 16,384", () => {
  const a = key("member a");
  const b = key("member b");
  const at = 1_700_000_000_000;
  let matched = 0;
  const runs = 200_000;
  for (let i = 0; i < runs; i++) {
    const t = sealedTime(b, sealedId(a, at, nonce(`run ${i}`)));
    if (t === null) continue;
    matched++;
    assert.notEqual(t, at);
  }
  // Seeded nonces, so the count is fixed: about 12.2 expected, and within 4 standard deviations of it.
  assert.ok(matched >= 1 && matched <= 26, `${matched} chance matches in ${runs}`);
});

test("version 7 ids keep their time in the clear, whatever the key", () => {
  const k = key("member a");
  const id = uuidv7(1_234_567);
  assert.equal(timeOf(id, k), 1_234_567);
  assert.equal(timeOf(id, null), 1_234_567);
  assert.equal(sealedTime(k, id), null);
  assert.equal(timeOf(sealedId(k, 5), null), null);
});

test("two sealed ids sort by their nonce, whatever their times", () => {
  const a = key("member a");
  const b = key("member b");
  const labels = Array.from({ length: 64 }, (_, i) => `thing ${i}`);
  const nonceHex = (label: string) => Buffer.from(nonce(label)).toString("hex");
  const byNonce = [...labels].sort((x, y) => (nonceHex(x) < nonceHex(y) ? -1 : nonceHex(x) > nonceHex(y) ? 1 : 0));
  for (const [first, second] of [[0, 2 ** 48 - 1], [2 ** 48 - 1, 0], [1_700_000_000_000, 1_700_000_000_001]] as const) {
    // Each thing made under one of two keys at one of two times: its place in the order is its nonce's alone.
    const ids = labels.map((label, i) => ({ label, id: sealedId(i % 2 === 0 ? a : b, i % 3 === 0 ? first : second, nonce(label)) }));
    const sorted = [...ids].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((x) => x.label);
    assert.deepEqual(sorted, byNonce);
  }
});

test("one nonce under one key and one time makes one id, and another time another", () => {
  const k = key("member a");
  assert.equal(sealedId(k, 10, nonce("x")), sealedId(k, 10, nonce("x")));
  assert.notEqual(sealedId(k, 10, nonce("x")), sealedId(k, 11, nonce("x")));
  assert.equal(sealedId(k, 10, nonce("x")).slice(0, 18), sealedId(k, 11, nonce("x")).slice(0, 18), "the nonce and version are the same");
});

test("a key's text is 43 characters of base64url and reads back to the same key", () => {
  for (let i = 0; i < 50; i++) {
    const raw = randomBytes(32);
    const text = idKeyText(raw);
    assert.equal(text, raw.toString("base64url"));
    assert.equal(text.length, 43);
    const back = idKeyFromText(text);
    assert.ok(back);
    const id = sealedId(idKeyOf(raw), 99);
    assert.equal(sealedTime(back, id), 99);
  }
  assert.equal(idKeyFromText(""), null);
  assert.equal(idKeyFromText("A".repeat(44)), null);
  assert.equal(idKeyFromText("A".repeat(42) + "B"), null, "its last two bits set");
  assert.equal(idKeyFromText("A".repeat(42) + "="), null);
});

test("an id of the sealed shape in capitals, or with another version, is not one", () => {
  const k = key("member a");
  const id = sealedId(k, 77);
  assert.equal(sealedTime(k, id.toUpperCase()), null);
  assert.equal(isSealedShape(id.toUpperCase()), false);
  assert.equal(sealedTime(k, `${id.slice(0, 14)}7${id.slice(15)}`), null);
  assert.equal(sealedTime(k, `${id.slice(0, 19)}${"c"}${id.slice(20)}`), null, "the variant's bits");
});
