/**
 * Room IDs are 8 characters of Crockford base32, shown as `XXXX-XXXX`
 * (design section 10.1). The alphabet leaves out I, L, O and U, so the
 * letters people mistype for digits can be read back as the digit they meant.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The canonical 8-character ID, or null when the input cannot be one.
 * Accepts any case, `XXXX-XXXX`, spaces, and Crockford's look-alikes
 * (I and L for 1, O for 0).
 */
export function parseRoomId(input: string): string | null {
  const id = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (id.length !== 8) return null;
  for (const ch of id) if (!ALPHABET.includes(ch)) return null;
  return id;
}

/**
 * What a person types in the "join a room" field: a room ID, or a join link
 * someone sent them, such as `https://vtt.example.com/r/K7QH-2MXA`.
 */
export function parseRoomInput(input: string): string | null {
  const match = /\/r\/([^/?#\s]+)/.exec(input);
  return parseRoomId(match ? decodeURIComponent(match[1]!) : input);
}

export function formatRoomId(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4)}`;
}

/** The app path for a room. Links people share use the readable form. */
export function roomPath(id: string): string {
  return `/r/${formatRoomId(id)}`;
}
