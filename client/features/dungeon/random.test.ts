import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { describe, test } from "node:test";
import { chachaBlock, seedStream, Stream } from "./random.ts";
import { parseSeed } from "./seed.ts";
import { GENERATOR_VERSION } from "./settings.ts";

const hex = (s: string) => Uint8Array.from(s.replace(/[\s:]/g, "").match(/../g)!.map((b) => parseInt(b, 16)));
const toWords = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(4 * i, true));
};

/** The key stream OpenSSL's ChaCha20 gives, whose IV is the block counter little-endian and then the nonce. */
function opensslStream(key: Uint8Array, nonce: Uint8Array, counter: number, bytes: number): Uint32Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(0, counter, true);
  iv.set(nonce, 4);
  const cipher = createCipheriv("chacha20", key, iv);
  return toWords(new Uint8Array(cipher.update(new Uint8Array(bytes))));
}

describe("ChaCha20", () => {
  test("RFC 8439 2.3.2's block", () => {
    const key = toWords(Uint8Array.from({ length: 32 }, (_, i) => i));
    const nonce = toWords(hex("00:00:00:09:00:00:00:4a:00:00:00:00"));
    const out = new Uint32Array(16);
    chachaBlock(key, 1, nonce, out);
    const expected = [
      0xe4e7f110, 0x15593bd1, 0x1fdd0f50, 0xc47120a3, 0xc7f4d1c7, 0x0368c033, 0x9aaa2204, 0x4e6cd4c3,
      0x466482d2, 0x09aa9f07, 0x05d7c214, 0xa2028bd9, 0xd19c12b5, 0xb94e16de, 0xe883d0cb, 0x4e3c50a2,
    ];
    assert.deepEqual([...out], expected);
    // The RFC's serialized block, byte for byte.
    const bytes = new Uint8Array(out.buffer);
    assert.deepEqual(
      [...bytes],
      [
        ...hex(`10 f1 e7 e4 d1 3b 59 15 50 0f dd 1f a3 20 71 c4 c7 d1 f4 c7 33 c0 68 03 04 22 aa 9a c3 d4 6c 4e
                d2 82 64 46 07 9f aa 09 14 c2 d7 05 d9 8b 02 a2 b5 12 9c d1 de 16 4e b9 cb d0 83 e8 a2 50 3c 4e`),
      ],
    );
  });

  test("the stream runs on across block edges as OpenSSL's does", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
    const nonce = Uint8Array.from({ length: 12 }, (_, i) => (i * 101 + 3) & 0xff);
    const stream = new Stream(key, nonce);
    // Four blocks and a word: the 16th, 17th, 32nd and 33rd draws cross block edges.
    const drawn = Array.from({ length: 65 }, () => stream.next32());
    assert.deepEqual(drawn, [...opensslStream(key, nonce, 0, 65 * 4)]);
  });

  test("a stream can start past block 0", () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(12).fill(9);
    const stream = new Stream(key, nonce, 5);
    assert.deepEqual(
      Array.from({ length: 20 }, () => stream.next32()),
      [...opensslStream(key, nonce, 5, 80)],
    );
  });

  test("refuses a key or nonce of the wrong length", () => {
    assert.throws(() => new Stream(new Uint8Array(31), new Uint8Array(12)));
    assert.throws(() => new Stream(new Uint8Array(32), new Uint8Array(16)));
  });
});

/** A stream whose words are scripted, to drive the rejection sampling by hand. */
class Scripted extends Stream {
  readonly #words: number[];
  constructor(words: number[]) {
    super(new Uint8Array(32), new Uint8Array(12));
    this.#words = words;
  }
  override next32(): number {
    const w = this.#words.shift();
    if (w === undefined) throw new Error("script ran out");
    return w;
  }
}

describe("ranged draws", () => {
  test("below draws again past the last whole multiple, so no value is favored", () => {
    // 2^32 % 3 is 1, so only 2^32 - 1 is past the last multiple of 3.
    assert.equal(new Scripted([0xffffffff, 5]).below(3), 2);
    assert.equal(new Scripted([0xfffffffe]).below(3), 0xfffffffe % 3);
    // 2^32 % 10 is 6: the top six words are drawn again.
    const top = 0x1_0000_0000 - 6;
    assert.equal(new Scripted([top, top + 5, 13]).below(10), 3);
    assert.equal(new Scripted([top - 1]).below(10), (top - 1) % 10);
    // A power of two never draws again.
    assert.equal(new Scripted([0xffffffff]).below(16), 15);
    assert.equal(new Scripted([0xffffffff]).below(0x1_0000_0000), 0xffffffff);
  });

  test("below, int, chance and pick stay in range", () => {
    const s = seedStream(parseSeedOk("1K7Q-H2MX-A9F3-TWQ5"));
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const v = s.below(7);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 7);
      seen.add(v);
      const r = s.int(-10, -5);
      assert.ok(r >= -10 && r <= -5);
      assert.equal(s.int(4, 4), 4);
      assert.ok(["a", "b"].includes(s.pick(["a", "b"])));
    }
    assert.equal(seen.size, 7);
    assert.equal(new Scripted([0]).chance(1, 4), true);
    assert.equal(new Scripted([1]).chance(1, 4), false);
    assert.throws(() => s.below(0));
    assert.throws(() => s.below(1.5));
    assert.throws(() => s.int(3, 2));
    assert.throws(() => s.pick([]));
  });

  test("shuffle keeps every item", () => {
    const s = seedStream(parseSeedOk("1000-0000-0000-0001"));
    const items = Array.from({ length: 30 }, (_, i) => i);
    const shuffled = s.shuffle([...items]);
    assert.notDeepEqual(shuffled, items);
    assert.deepEqual([...shuffled].sort((a, b) => a - b), items);
  });
});

function parseSeedOk(text: string) {
  const read = parseSeed(text);
  assert.ok(read.ok);
  return read.seed;
}

describe("seed streams", () => {
  test("the same seed draws the same words, and one bit or the version changes them", () => {
    const a = seedStream(parseSeedOk("1K7Q-H2MX-A9F3-TWQ5"));
    const b = seedStream(parseSeedOk("1k7q h2mx a9f3 twq5"));
    const words = (s: Stream) => Array.from({ length: 40 }, () => s.next32());
    const first = words(a);
    assert.deepEqual(words(b), first);
    assert.notDeepEqual(words(seedStream(parseSeedOk("1K7Q-H2MX-A9F3-TWQ4"))), first);
    assert.notDeepEqual(words(seedStream(parseSeedOk("1K7Q-H2MX-A9F3-TWQ5"), GENERATOR_VERSION + 1)), first);
    // The corridors' lane draws its own words from the same seed.
    assert.notDeepEqual(words(seedStream(parseSeedOk("1K7Q-H2MX-A9F3-TWQ5"), GENERATOR_VERSION, 1)), first);
    assert.deepEqual(words(seedStream(parseSeedOk("1K7Q-H2MX-A9F3-TWQ5"), GENERATOR_VERSION, 0)), first);
  });
});
