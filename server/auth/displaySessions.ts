import { randomBytes } from "node:crypto";
import { DISPLAY_SESSION_DAYS } from "./sessions.ts";
import type { Queryable } from "./tx.ts";

/**
 * Table displays (docs/design-v1-dm-tools.md 3.1): the one-time codes that
 * pair a TV with a room, the display's member id, and the two renewals that
 * keep a connected display signed in.
 */

/** Table displays a room may hold at once. */
export const MAX_DISPLAYS = 4;
/** Codes a room may have waiting at once. */
export const MAX_LIVE_CODES = 3;
export const CODE_MINUTES = 10;
export const CODE_LENGTH = 10;

/** Crockford's alphabet, as room IDs use it: no I, L, O or U, so a code read off a TV survives a remote's typing. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** 10 characters of 5 bits each: 50 random bits, which 10 minutes and 20 tries per address cannot guess. */
export function newDisplayCode(): string {
  let bits = 0n;
  for (const byte of randomBytes(7)) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

/**
 * The canonical code, or null when the input cannot be one. The DM's screen
 * groups it for typing ("K7QH 2MXA 4F"), so spaces and hyphens are ignored,
 * and the standard decoding applies: any case, I and L read as 1, O as 0.
 */
export function parseDisplayCode(input: string): string | null {
  if (input.length > 40) return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase().replace(/[IL]/g, "1").replaceAll("O", "0");
  return CANONICAL.test(code) ? code : null;
}

/** "K7QH 2MXA 4F": groups of four, as the DM's screen shows it. */
export function formatDisplayCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1 ");
}

/** A member id no member can have: members get UUIDv7s, and "continue as" lists only the roster. */
export function newDisplayMemberId(): string {
  return `display:${randomBytes(9).toString("base64url")}`;
}

export function isDisplayMemberId(memberId: string): boolean {
  return memberId.startsWith("display:");
}

/**
 * While a display socket is open, the 60 s grant recheck pushes its
 * session's expiry back to 30 days ahead whenever it is under 29 days away,
 * about one write a day, so a connected display never expires. Only a
 * session still live is renewed, in the statement's own condition, so a
 * recheck racing the expiry never revives one. Both renewals stamp
 * `last_seen_at` too: a TV makes no request in its whole life, and the DM
 * devices list shows when it was last seen.
 */
export async function renewOpenDisplay(q: Queryable, sessionId: string): Promise<void> {
  await q.query(
    `update sessions set expires_at = now() + make_interval(days => $2), last_seen_at = now()
     where id = $1 and purpose = 'display' and expires_at > now()
       and expires_at < now() + make_interval(days => $2) - interval '1 day'`,
    [sessionId, DISPLAY_SESSION_DAYS],
  );
}

/**
 * When a display's last socket closes, its session ends 30 days from that
 * moment. A socket the server closed with 4001 (session gone or expired, a
 * sign out, a password change) renews nothing, and neither does any close
 * after the session expired, so a closing socket never revives a session.
 */
export async function renewClosedDisplay(q: Queryable, sessionId: string): Promise<void> {
  await q.query(
    `update sessions set expires_at = now() + make_interval(days => $2), last_seen_at = now()
     where id = $1 and purpose = 'display' and expires_at > now()`,
    [sessionId, DISPLAY_SESSION_DAYS],
  );
}
