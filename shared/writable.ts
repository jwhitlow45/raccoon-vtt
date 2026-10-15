/**
 * States, and collections inside them, that a transaction may still write
 * into (shared/reducer/tx.ts). The reducer asks the rules about its own
 * state in the middle of an op (the "seen" marks on log lines and path
 * stops), and the transaction then goes on writing into that same object and
 * into the collections it copied. A cache keyed on the identity of either
 * would keep an answer for contents that change under it.
 *
 * So caches keyed on a state or a collection keep answers only for objects
 * outside this set. Everything else is never written again: a finished op's
 * state and collections are left as they are, and a transaction copies a
 * collection before its first write into it, so it never writes into one it
 * did not copy.
 *
 * Sight imports this, so it imports nothing (segments.test.ts checks the
 * arithmetic of everything sight imports).
 */
const writable = new WeakSet<object>();

/** A transaction's state or a collection it copied: it may change until the op finishes. */
export function markWritable(value: object): void {
  writable.add(value);
}

/** The op is done with it: it takes no more writes. */
export function markFinished(value: object): void {
  writable.delete(value);
}

/** Whether a transaction may still write into this object, so no cache may keep an answer about it. */
export function isWritable(value: unknown): boolean {
  return typeof value === "object" && value !== null && writable.has(value);
}
