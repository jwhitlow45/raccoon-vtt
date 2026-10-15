import { randomBytes } from "node:crypto";

/**
 * Room IDs: 8 characters of Crockford base32, 40 random bits, stored without
 * the hyphen and shown as `XXXX-XXXX` (design section 10.1). They are not
 * secrets, the password is the gate, so 40 bits only has to make collisions
 * rare, and a collision is retried at insert.
 *
 * Crockford's alphabet drops I, L, O and U, so an ID read aloud at the table
 * or typed on a phone survives the usual confusions. Parsing applies the
 * standard decoding: any case, I and L read as 1, O as 0, hyphens ignored.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function newRoomId(): string {
  // 5 bytes are exactly 40 bits, 8 groups of 5.
  let bits = 0n;
  for (const byte of randomBytes(5)) bits = (bits << 8n) | BigInt(byte);
  let id = "";
  for (let i = 7; i >= 0; i--) id += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return id;
}

/** The canonical 8-character ID, or null when the input cannot be one. */
export function parseRoomId(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 16) return null;
  const id = input.replaceAll("-", "").toUpperCase().replace(/[IL]/g, "1").replaceAll("O", "0");
  return CANONICAL.test(id) ? id : null;
}

export function formatRoomId(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4)}`;
}

export function dmLink(roomId: string, key: string): string {
  return `/r/${formatRoomId(roomId)}#dm=${key}`;
}

export function inviteLink(roomId: string, token: string): string {
  return `/r/${formatRoomId(roomId)}#invite=${token}`;
}
