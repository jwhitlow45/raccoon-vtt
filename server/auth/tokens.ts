import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets the server hands out: session tokens, DM keys, device invites and
 * join tickets. Each is 32 random bytes, written as 43 base64url characters
 * so it survives a URL fragment, a cookie and a QR code unchanged.
 *
 * Only `sha256(token)` is ever stored. A token has 256 bits of entropy, so a
 * fast hash is enough: there is nothing to brute-force, unlike a password.
 */
export const TOKEN_BYTES = 32;

/** Exactly the shape `randomToken()` produces, checked before any lookup. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Compares a presented token with a stored hash in constant time. */
export function tokenMatches(token: string, storedHash: Buffer): boolean {
  const presented = sha256(token);
  return presented.length === storedHash.length && timingSafeEqual(presented, storedHash);
}
