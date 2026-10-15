/**
 * The player link (design section 10.2): `/r/<roomId>#pw=<password>`, a join
 * link that carries the player password, so a player taps or scans one link
 * instead of typing a password.
 *
 * The password travels in the fragment, like the key in a DM link, because a
 * fragment never reaches the server in a request line, a Referer or a log.
 * The client takes it out of the address bar before anything else runs.
 *
 * Shared because the client builds the link after creating a room or
 * changing the password, and the admin script prints it.
 */

/**
 * encodeURIComponent leaves `!'()*.~` as they are. Chat apps that turn text
 * into links often leave a trailing `.`, `!` or `)` out of the link, which
 * would cut the password short, so those are escaped too.
 */
function encodePassword(password: string): string {
  return encodeURIComponent(password).replace(/[!'()*.~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The link's path and fragment. Callers add the origin. */
export function playerLink(roomId: string, password: string): string {
  const id = roomId.replaceAll("-", "");
  return `/r/${id.slice(0, 4)}-${id.slice(4)}#pw=${encodePassword(password)}`;
}

export type PlayerFragment = {
  /** Null when the link's password is empty or cannot be decoded, as when a link is cut off in the middle of an escape. */
  password: string | null;
  /** The fragment with every `pw=` taken out, or `""` when nothing else was in it. */
  hash: string;
};

/** Reads `pw=` from a location hash. Null when the hash has none. */
export function readPlayerFragment(hash: string): PlayerFragment | null {
  const parts = hash.replace(/^#/, "").split("&");
  const raw = parts.find((part) => part.startsWith("pw="));
  if (raw === undefined) return null;
  const rest = parts.filter((part) => part !== "" && !part.startsWith("pw="));
  let password: string | null;
  try {
    password = decodeURIComponent(raw.slice("pw=".length));
  } catch {
    password = null;
  }
  return { password: password === "" ? null : password, hash: rest.length > 0 ? `#${rest.join("&")}` : "" };
}
