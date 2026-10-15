import { WORDS } from "./words.ts";

/** Fills the array with cryptographically random values, like crypto.getRandomValues. */
export type RandomSource = (buffer: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer>;

const webCrypto: RandomSource = (buffer) => crypto.getRandomValues(buffer);

/**
 * A uniformly random integer in [0, n).
 *
 * `x % n` alone favors small results whenever n does not divide 2^32, so draws
 * from the uneven tail above the largest multiple of n are thrown away and
 * redrawn. With n around 1,600 that tail is under one draw in a million.
 */
export function randomIndex(n: number, random: RandomSource = webCrypto): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`randomIndex: bad range ${n}`);
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buffer = new Uint32Array(1);
  for (;;) {
    const x = random(buffer)[0]!;
    if (x < limit) return x % n;
  }
}

/**
 * The suggested player password: three words joined by hyphens, such as
 * `owlbear-druid-wand` (design section 10.1). The shortest word has three
 * letters, so the result always meets the 8-character minimum.
 */
export function generatePassphrase(
  options: { words?: readonly string[]; count?: number; random?: RandomSource } = {},
): string {
  const words = options.words ?? WORDS;
  const count = options.count ?? 3;
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(words[randomIndex(words.length, options.random)]!);
  }
  return picked.join("-");
}
