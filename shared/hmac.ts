/**
 * SHA-256 and HMAC-SHA-256 (RFC 6234, RFC 2104), synchronous, in plain
 * code that runs the same on a page and on the server. Web Crypto's HMAC
 * answers only through a promise, and a device makes an id inside a
 * synchronous dispatch (shared/ids.ts sealedId), so it cannot wait on one.
 *
 * A key's inner and outer states are worked out once (`hmacKey`), so a
 * short message costs two compressions: one for the message's block and
 * one for the outer hash.
 */

const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const START = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

const BLOCK = 64;

/** The message schedule, shared: every hash here runs to its end before another starts. */
const SCHEDULE = new Uint32Array(64);

/** One compression of the 64-byte block at `at` into `state`, in place. */
function compress(state: Uint32Array, block: Uint8Array, at: number): void {
  const w = SCHEDULE;
  for (let i = 0; i < 16; i++) {
    const j = at + i * 4;
    w[i] = ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15]!;
    const b = w[i - 2]!;
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + ROUND[i]! + w[i]!) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0]! + a) >>> 0;
  state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0;
  state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0;
  state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0;
  state[7] = (state[7]! + h) >>> 0;
}

/**
 * Hashes `message` on from `from`, a state that has already taken `before`
 * bytes of whole blocks, and returns the 32-byte digest.
 */
function finish(from: Uint32Array, before: number, message: Uint8Array): Uint8Array {
  const state = Uint32Array.from(from);
  const whole = message.length - (message.length % BLOCK);
  for (let at = 0; at < whole; at += BLOCK) compress(state, message, at);
  const rest = message.length - whole;
  const tail = new Uint8Array(rest + 9 <= BLOCK ? BLOCK : BLOCK * 2);
  tail.set(message.subarray(whole));
  tail[rest] = 0x80;
  // The length in bits, big-endian, in the last 8 bytes. Messages here are far under 2^53 bits.
  const bits = (before + message.length) * 8;
  const high = Math.floor(bits / 2 ** 32);
  const end = tail.length;
  tail[end - 8] = high >>> 24;
  tail[end - 7] = high >>> 16;
  tail[end - 6] = high >>> 8;
  tail[end - 5] = high;
  tail[end - 4] = bits >>> 24;
  tail[end - 3] = bits >>> 16;
  tail[end - 2] = bits >>> 8;
  tail[end - 1] = bits;
  for (let at = 0; at < tail.length; at += BLOCK) compress(state, tail, at);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const v = state[i]!;
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = v >>> 16;
    out[i * 4 + 2] = v >>> 8;
    out[i * 4 + 3] = v;
  }
  return out;
}

export function sha256(message: Uint8Array): Uint8Array {
  return finish(START, 0, message);
}

/** A key's inner and outer states after its padded block, worked out once. */
export type HmacKey = { readonly inner: Uint32Array; readonly outer: Uint32Array };

export function hmacKey(key: Uint8Array): HmacKey {
  const padded = new Uint8Array(BLOCK);
  padded.set(key.length > BLOCK ? sha256(key) : key);
  const inner = Uint32Array.from(START);
  const outer = Uint32Array.from(START);
  const block = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) block[i] = padded[i]! ^ 0x36;
  compress(inner, block, 0);
  for (let i = 0; i < BLOCK; i++) block[i] = padded[i]! ^ 0x5c;
  compress(outer, block, 0);
  return { inner, outer };
}

export function hmacSha256(key: HmacKey, message: Uint8Array): Uint8Array {
  return finish(key.outer, BLOCK, finish(key.inner, BLOCK, message));
}
