import { GENERATOR_VERSION } from "./settings.ts";

/*
 * Dungeon seeds (docs/design/design-v1-dungeon-generator.md 5.2): 16
 * Crockford base32 characters, the first the generator's version and the
 * other 15 carrying 75 random bits. A player never holds one, and 2^75 is
 * past guessing, so only the full form is accepted: a short code would be
 * guessable against the public generator.
 */

/** 16 characters, normalized: upper case, no dashes, the first the version. */
export type Seed = string;

/** Crockford's base32 digits: no I, L, O or U, so a seed read aloud or retyped keeps its meaning. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SEED_CHARS = 16;
/** Random bits a seed carries after its version character. */
export const SEED_BITS = 75;

/** The version character this generator writes. */
export function versionChar(version: number = GENERATOR_VERSION): string {
  return CROCKFORD[version % CROCKFORD.length]!;
}

/** A fresh seed of this version, its 75 bits from the device's cryptographic source. */
export function newSeed(random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b)): Seed {
  const bytes = new Uint8Array(SEED_CHARS - 1);
  random(bytes);
  // 256 is a multiple of 32, so the low 5 bits of a uniform byte are uniform.
  let out = versionChar();
  for (const b of bytes) out += CROCKFORD[b & 31]!;
  return out;
}

/**
 * Reads a seed as typed or pasted: case-blind, spaces and dashes ignored,
 * O read as 0, and I and L as 1, as Crockford reads them. Anything else, or
 * any length but 16, is not a seed. `otherVersion` says the seed came from
 * another version of the generator, so it makes a different dungeon now.
 */
export function parseSeed(text: string): { ok: true; seed: Seed; otherVersion: boolean } | { ok: false } {
  const seed = text
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (seed.length !== SEED_CHARS) return { ok: false };
  for (const c of seed) if (!CROCKFORD.includes(c)) return { ok: false };
  return { ok: true, seed, otherVersion: seed[0] !== versionChar() };
}

/** A seed as the dialog shows it: four groups of four, such as 1K7Q-H2MX-A9F3-TWQ5. */
export function formatSeed(seed: Seed): string {
  return seed.match(/.{1,4}/g)?.join("-") ?? seed;
}

/**
 * The 75 bits after the version character, packed high bit first into a
 * 32-byte ChaCha20 key and zero-padded. The version goes in the nonce
 * (random.ts), not here.
 */
export function seedKey(seed: Seed): Uint8Array {
  const key = new Uint8Array(32);
  let bit = 0;
  for (let i = 1; i < SEED_CHARS; i++) {
    const v = CROCKFORD.indexOf(seed[i] ?? "0");
    if (v < 0) throw new Error("not a normalized seed");
    for (let b = 4; b >= 0; b--, bit++) if ((v >> b) & 1) key[bit >> 3]! |= 0x80 >> (bit & 7);
  }
  return key;
}
