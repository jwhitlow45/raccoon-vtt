/**
 * Preloaded into the server of scripts/guide-scenes.ts (node --import), so a
 * second run rolls the same dice as the first, and the pictures that show a
 * roll come out the same. The dice and the passphrase generator draw 32-bit
 * numbers (a Uint32Array), and those calls read one fixed stream. Ids, which
 * are drawn as bytes, keep the real source, so nothing that must be unguessable
 * is affected beyond this replay's own server, and this file is loaded by
 * nothing else.
 */
let state = 0x2545f491;

/** Mulberry32: a small generator whose whole state is one number. */
function next(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
globalThis.crypto.getRandomValues = ((array: ArrayBufferView) => {
  if (!(array instanceof Uint32Array)) return real(array as Uint8Array);
  for (let i = 0; i < array.length; i++) array[i] = next();
  return array;
}) as typeof globalThis.crypto.getRandomValues;
