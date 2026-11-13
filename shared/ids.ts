/**
 * UUIDv7 for entities a client creates. The time prefix keeps ids roughly
 * ordered, which makes logs and op rows easier to read, and the 74 random bits
 * keep them unguessable. Uses Web Crypto, which Node 24 and every browser the
 * app supports both provide, so the same function runs on either side.
 *
 * Assets are created by the server with crypto.randomUUID() (v4) instead,
 * because a v7 id would reveal when an image was first uploaded (design
 * section 11.1).
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

/** Whether `id` is a version 7 id, the shape every new thing a device makes takes. */
export function isUuidv7(id: string): boolean {
  return UUIDV7.test(id);
}

/** The millisecond time a version 7 id was made at, its first 48 bits, or null for any other id. */
export function idTime(id: string): number | null {
  return isUuidv7(id) ? Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : null;
}

/**
 * The words the room refuses a new thing's id with, code `invalid`, when
 * the id is not version 7 or its own time is too far from the server's
 * clock (shared/limits.ts ID_TIME). The device then reads the server's
 * time, makes the id again and sends once more (client/state/store.ts), so
 * these words reach no one. Only a second refusal is shown, in
 * ID_RETRY_FAILED's words.
 */
export const ID_TIME_REFUSED = "That id was not made just now. Make a new one.";
