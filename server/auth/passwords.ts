import { readFileSync } from "node:fs";
import { hash, verify, type Algorithm, type Options } from "@node-rs/argon2";

/**
 * Player passwords: the policy, and argon2id hashing behind a small queue.
 *
 * Argon2 is slow on purpose, 19 MiB and two passes per hash, and runs on the
 * libuv thread pool that sharp also uses for image work. An unbounded flood
 * of join attempts would queue there and stall uploads for everyone, so at
 * most 2 hashes run at once, at most 8 wait, and the rest are refused with
 * 429 before any work is done (design section 10.3).
 */

// OWASP's argon2id minimum: m=19456 KiB, t=2, p=1. The algorithm is spelled
// as its numeric value because the package declares it as a const enum,
// which type stripping cannot inline.
const ARGON2ID = 2 as Algorithm;
export const ARGON2_OPTIONS: Options = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN = 8;
/** Long enough for any passphrase, short enough that hashing stays cheap. */
export const PASSWORD_MAX = 128;

let common: Set<string> | undefined;

/**
 * The 10,000 most common passwords from SecLists, lowercased, so `Password1`
 * is refused along with `password1`. Loaded on first use, once.
 */
function commonPasswords(): Set<string> {
  if (!common) {
    const text = readFileSync(new URL("./common-passwords.txt", import.meta.url), "utf8");
    common = new Set(
      text
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => line.toLowerCase()),
    );
  }
  return common;
}

export type PasswordProblem = "too_short" | "too_long" | "too_common";

/** Why a new player password is refused, or null when it is acceptable. */
export function passwordProblem(password: string): PasswordProblem | null {
  // Code points, not UTF-16 units, so an emoji counts as one character.
  const length = [...password].length;
  if (length < PASSWORD_MIN) return "too_short";
  if (length > PASSWORD_MAX) return "too_long";
  if (commonPasswords().has(password.toLowerCase())) return "too_common";
  return null;
}

/** Thrown when the hashing queue is full. Routes answer it with 429. */
export class BusyError extends Error {
  constructor() {
    super("password hashing is busy");
    this.name = "BusyError";
  }
}

/**
 * A counting semaphore with a bounded wait queue. A task that finds every
 * slot taken and the queue full is refused at once with BusyError instead of
 * waiting, so pressure turns into fast 429s rather than growing latency.
 */
export class Semaphore {
  readonly concurrency: number;
  readonly maxQueue: number;
  #active = 0;
  #queue: Array<() => void> = [];

  constructor(concurrency: number, maxQueue: number) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.concurrency) {
      if (this.#queue.length >= this.maxQueue) throw new BusyError();
      // The releasing task hands its slot straight to this one, so #active
      // never drops and a newcomer cannot jump the queue.
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    } else {
      this.#active++;
    }
    try {
      return await task();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

export class PasswordHasher {
  readonly semaphore: Semaphore;

  constructor(semaphore: Semaphore = new Semaphore(2, 8)) {
    this.semaphore = semaphore;
  }

  hash(password: string): Promise<string> {
    return this.semaphore.run(() => hash(password, ARGON2_OPTIONS));
  }

  verify(phc: string, password: string): Promise<boolean> {
    // A malformed stored hash is a server bug, but it must read as a failed
    // check rather than a 500 that tells the caller something is different.
    return this.semaphore.run(() => verify(phc, password).catch(() => false));
  }
}
