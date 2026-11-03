import { seedKey, type Seed } from "./seed.ts";
import { GENERATOR_VERSION } from "./settings.ts";

/*
 * The generator's random stream (docs/design/design-v1-dungeon-generator.md
 * 5.2): ChaCha20 (RFC 8439) keyed by the seed's 75 bits. A cipher stream,
 * not a small generator such as xorshift, so the rooms a player sees say
 * nothing of the seed or of the rooms they have not seen. Web Crypto has no
 * synchronous stream, so the block function is written out here. Integer
 * arithmetic only, so every device draws the same numbers.
 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;
const TWO_32 = 0x1_0000_0000;

const words = (bytes: Uint8Array, n: number): Uint32Array => {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[4 * i]! | (bytes[4 * i + 1]! << 8) | (bytes[4 * i + 2]! << 16) | (bytes[4 * i + 3]! << 24)) >>> 0;
  return out;
};

const rotl = (v: number, c: number) => (v << c) | (v >>> (32 - c));

/** RFC 8439 2.1's quarter round on four words of the working state. */
function quarter(x: Int32Array, a: number, b: number, c: number, d: number): void {
  x[a] = x[a]! + x[b]!;
  x[d] = rotl(x[d]! ^ x[a]!, 16);
  x[c] = x[c]! + x[d]!;
  x[b] = rotl(x[b]! ^ x[c]!, 12);
  x[a] = x[a]! + x[b]!;
  x[d] = rotl(x[d]! ^ x[a]!, 8);
  x[c] = x[c]! + x[d]!;
  x[b] = rotl(x[b]! ^ x[c]!, 7);
}

/**
 * One ChaCha20 block (RFC 8439 2.3): the 16 words for a 32-byte key, a
 * block counter and a 12-byte nonce, as words. `out` takes the block in
 * the RFC's word order, so its little-endian bytes are the key stream.
 */
export function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint32Array): void {
  const state = new Int32Array(16);
  state.set(SIGMA, 0);
  state.set(key, 4);
  state[12] = counter;
  state.set(nonce, 13);
  // Int32Array wraps every sum to 32 bits, as the RFC's additions modulo 2^32 do.
  const x = state.slice();
  for (let round = 0; round < 10; round++) {
    quarter(x, 0, 4, 8, 12);
    quarter(x, 1, 5, 9, 13);
    quarter(x, 2, 6, 10, 14);
    quarter(x, 3, 7, 11, 15);
    quarter(x, 0, 5, 10, 15);
    quarter(x, 1, 6, 11, 12);
    quarter(x, 2, 7, 8, 13);
    quarter(x, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) out[i] = x[i]! + state[i]!;
}

/** Draws from a ChaCha20 key stream, a 32-bit word at a time, block counter from 0. */
export class Stream {
  readonly #key: Uint32Array;
  readonly #nonce: Uint32Array;
  readonly #block = new Uint32Array(16);
  #counter: number;
  #at = 16;

  constructor(key: Uint8Array, nonce: Uint8Array, counter = 0) {
    if (key.length !== 32 || nonce.length !== 12) throw new Error("ChaCha20 takes a 32-byte key and a 12-byte nonce");
    this.#key = words(key, 8);
    this.#nonce = words(nonce, 3);
    this.#counter = counter;
  }

  /** The next word of the stream, 0 to 2^32 - 1. */
  next32(): number {
    if (this.#at === 16) {
      chachaBlock(this.#key, this.#counter++, this.#nonce, this.#block);
      this.#at = 0;
    }
    return this.#block[this.#at++]!;
  }

  /**
   * A whole number from 0 to n - 1, each equally likely: words past the
   * last whole multiple of n are drawn again, so no value is favored.
   */
  below(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new Error(`below(${n}) needs a whole number from 1 to 2^32`);
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const x = this.next32();
      if (x < limit) return x % n;
    }
  }

  /** A whole number from lo to hi, both included. */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new Error(`int(${lo}, ${hi}) has no values`);
    return lo + this.below(hi - lo + 1);
  }

  /** True `num` times in `den`. */
  chance(num: number, den: number): boolean {
    return this.below(den) < num;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from nothing");
    return items[this.below(items.length)]!;
  }

  /** Shuffles in place (Fisher and Yates) and returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      const t = items[i]!;
      items[i] = items[j]!;
      items[j] = t;
    }
    return items;
  }
}

/**
 * The stream a seed starts: its 75 bits as the key, and the generator's
 * version as the nonce's first word, so the same bits under another
 * version draw another stream.
 */
export function seedStream(seed: Seed, version: number = GENERATOR_VERSION): Stream {
  const nonce = new Uint8Array(12);
  nonce[0] = version & 0xff;
  nonce[1] = (version >>> 8) & 0xff;
  nonce[2] = (version >>> 16) & 0xff;
  nonce[3] = (version >>> 24) & 0xff;
  return new Stream(seedKey(seed), nonce);
}
