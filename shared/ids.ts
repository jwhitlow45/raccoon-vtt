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
