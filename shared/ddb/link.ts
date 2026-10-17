/**
 * A D&D Beyond character's number from what a player pastes
 * (docs/design-v1-pc-stats.md 6.3), on the client and the server alike: a
 * number of 1 to 12 digits, or the digits after `/characters/` in a link
 * on dndbeyond.com or its short host. Only the digits leave this function,
 * and the server builds its own address from them, so no member's URL is
 * ever fetched.
 */

const HOSTS = new Set(["www.dndbeyond.com", "dndbeyond.com", "ddb.ac"]);

export const DDB_LINK_ERROR = "That is not a D&D Beyond character link. Paste one like dndbeyond.com/characters/12345678, or the character's number.";

export function ddbCharacterId(text: string): string | null {
  const trimmed = text.trim();
  if (/^\d{1,12}$/.test(trimmed)) return trimmed;
  // A link copied without its scheme, as the share box can show it, reads as https. Any other scheme is refused.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const m = /^\/characters\/(\d{1,12})(?:\/|$)/.exec(url.pathname);
  return m ? m[1]! : null;
}

/** The one address the server fetches, built from the digits alone. */
export function ddbCharacterUrl(id: string): string {
  return `https://character-service.dndbeyond.com/character/v5/character/${id}`;
}

/** The character's own page, for its sheet link. */
export function ddbSheetUrl(id: string): string {
  return `https://www.dndbeyond.com/characters/${id}`;
}
