import { hmacKey, hmacSha256, type HmacKey } from "./hmac.ts";

/**
 * Ids of the things a device makes.
 *
 * A device of this build makes version 8 ids (`sealedId`) under its
 * member's key, which the room sends with each snapshot
 * (server/rooms/idKeys.ts). The first 60 bits are a random nonce, so ids
 * sort by their nonce. The last 48 bits are the making time sealed under
 * the key: only that key, held by the member and the server, reads it back
 * (`sealedTime`). The 14 bits between are a tag that tells whether the key
 * reads the id at all.
 *
 * Version 7 ids (`uuidv7`) carry their time in the clear. Roll tags, a
 * group save's plan and page ids, member ids and a new room's first scene
 * keep them, as do pages of an older build until the room's cutover
 * (server/rooms/createIds.ts).
 *
 * Assets are created by the server with crypto.randomUUID() (v4) instead.
 * Uses Web Crypto for randomness, which Node 24 and every browser the app
 * supports both provide, so the same functions run on either side.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 48-bit big-endian millisecond timestamp.
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether `id` is a version 7 id, whose time anyone can read. */
export function isUuidv7(id: string): boolean {
  return UUIDV7.test(id);
}

/** The millisecond time a version 7 id was made at, its first 48 bits, or null for any other id. */
export function idTime(id: string): number | null {
  return isUuidv7(id) ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : null;
}

/** A key ids are sealed and read under, its HMAC states worked out once. */
export type IdKey = HmacKey;

/** The bytes of a key as the room derives them, ready to seal and read with. */
export function idKeyOf(bytes: Uint8Array): IdKey {
  return hmacKey(bytes);
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A 32-byte key as the snapshot's `you.idKey` carries it: unpadded base64url, 43 characters. */
export function idKeyText(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64URL[a >> 2]! + BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += BASE64URL[c & 63]!;
  }
  return out;
}

/** The key `idKeyText` wrote, or null for any other text. */
export function idKeyFromText(text: string): IdKey | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const bytes = new Uint8Array(32);
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const ch of text) {
    held = ((held << 6) | BASE64URL.indexOf(ch)) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (held >> bits) & 255;
    }
  }
  // 43 characters hold 258 bits: the last two must be zero, or the text names no 32-byte key.
  if ((held & ((1 << bits) - 1)) !== 0) return null;
  return idKeyOf(bytes);
}

const SEALED = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `id` has the shape of a sealed version 8 id, whatever key it was made under. */
export function isSealedShape(id: string): boolean {
  return SEALED.test(id);
}

/** "raccoon id seal", the HMAC's message before the nonce. */
const SEAL_LABEL = new TextEncoder().encode("raccoon id seal");
const MESSAGE = new Uint8Array(SEAL_LABEL.length + 8);
MESSAGE.set(SEAL_LABEL);

/** The pad and tag of one nonce under `key`: the HMAC's first 48 bits, then its next 14. */
function padOf(key: IdKey, nonce: Uint8Array): { pad: Uint8Array; tag: number } {
  MESSAGE.set(nonce, SEAL_LABEL.length);
  const mac = hmacSha256(key, MESSAGE);
  return { pad: mac.subarray(0, 6), tag: (mac[6]! << 6) | (mac[7]! >> 2) };
}

function hex(n: number, digits: number): string {
  return n.toString(16).padStart(digits, "0");
}

/** A fresh nonce: 8 bytes whose first 4 bits are zero, so it holds 60. */
export function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(8);
  crypto.getRandomValues(nonce);
  nonce[0]! &= 0x0f;
  return nonce;
}

/** Times a sealed id can hold: whole milliseconds in 48 bits. */
const MAX_TIME = 2 ** 48 - 1;

/**
 * A version 8 id made at `time` under `key`:
 * `NNNNNNNN-NNNN-8NNN-vTTT-SSSSSSSSSSSS`, the nonce in the N digits, the
 * variant and tag in v and T, and in S the time XOR the HMAC's pad.
 */
export function sealedId(key: IdKey, time: number, nonce: Uint8Array = randomNonce()): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) throw new RangeError(`a sealed id's time must be a whole millisecond in 48 bits, not ${time}`);
  if (nonce.length !== 8 || nonce[0]! > 0x0f) throw new RangeError("a sealed id's nonce is 8 bytes whose first 4 bits are zero");
  const { pad, tag } = padOf(key, nonce);
  const high = Math.floor(time / 2 ** 32);
  const low = time % 2 ** 32;
  const timeBytes = [high >>> 8, high & 255, low >>> 24, (low >>> 16) & 255, (low >>> 8) & 255, low & 255];
  let sealed = "";
  for (let i = 0; i < 6; i++) sealed += hex(timeBytes[i]! ^ pad[i]!, 2);
  let n = "";
  for (const b of nonce) n += hex(b, 2);
  // The nonce's 16 hex digits, the first always 0.
  return `${n.slice(1, 9)}-${n.slice(9, 13)}-8${n.slice(13, 16)}-${hex(8 | (tag >> 12), 1)}${hex(tag & 0xfff, 3)}-${sealed}`;
}

/** The nonce of an id of the sealed shape. */
function nonceOf(id: string): Uint8Array {
  const digits = `0${id.slice(0, 8)}${id.slice(9, 13)}${id.slice(15, 18)}`;
  const nonce = new Uint8Array(8);
  for (let i = 0; i < 8; i++) nonce[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return nonce;
}

/**
 * The time `id` was made at, read under `key`, or null when it is no
 * version 8 id or its tag does not match under this key. A wrong key
 * matches about once in 16,384 and then reads a time uniform over 48 bits,
 * so every reader decides as server/rooms/createIds.ts says.
 */
export function sealedTime(key: IdKey, id: string): number | null {
  if (!SEALED.test(id)) return null;
  const { pad, tag } = padOf(key, nonceOf(id));
  const stated = ((Number.parseInt(id[19]!, 16) & 3) << 12) | Number.parseInt(id.slice(20, 23), 16);
  if (stated !== tag) return null;
  let time = 0;
  for (let i = 0; i < 6; i++) time = time * 256 + (Number.parseInt(id.slice(24 + i * 2, 26 + i * 2), 16) ^ pad[i]!);
  return time;
}

/** An id's time: a version 7 id's own, or a version 8 id's read under `key`. Null for any other. */
export function timeOf(id: string, key: IdKey | null): number | null {
  return idTime(id) ?? (key === null ? null : sealedTime(key, id));
}

/**
 * The words the room refuses a new thing's id with, code `invalid`, when
 * the room cannot read the id's time under the sender's key, or that time
 * is too far from the server's clock (shared/limits.ts ID_TIME). A page of
 * this build then reads the server's time, makes the id again and sends
 * once more (client/state/store.ts), and shows only a second refusal, in
 * ID_RETRY_FAILED's words. A page opened before the device kept a key has
 * no such retry, and from the room's cutover is sent ID_PAGE_OLD
 * (shared/limits.ts) instead.
 */
export const ID_TIME_REFUSED = "This page is out of date. Reload it and try again.";
